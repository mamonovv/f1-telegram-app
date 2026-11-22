const API_URL = 'https://api.jolpi.ca/ergast/f1/current';
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const SCHEDULE_RETRY_MS = 30_000;
const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const RACE_BROADCAST_WINDOW_MS = 3 * HOUR_SECONDS * SECOND_MS;
const SESSION_BROADCAST_WINDOW_MS = 90 * MINUTE_SECONDS * SECOND_MS;
const STANDINGS_MODE = { DRIVERS: 'drivers', CONSTRUCTORS: 'constructors' };
const SESSION_NAMES = {
    FirstPractice: 'Практика 1',
    SecondPractice: 'Практика 2',
    ThirdPractice: 'Практика 3',
    SprintQualifying: 'Спринт-квалификация',
    Sprint: 'Спринт',
    Qualifying: 'Квалификация',
    Race: 'Гонка',
};
const RESULT_SECTIONS = [
    {
        endpoint: 'results',
        sessionKey: 'Race',
        title: 'Гонка',
        tableLabel: 'Результаты гонки',
        columnNames: ['#', 'Пилот', 'Время', 'Очки'],
        numericColumns: ['Очки'],
        emptyMessage: 'Результатов гонки пока нет.',
        errorMessage: 'Не удалось загрузить гонку.',
        getSession: race => race,
        renderRows: renderRaceResultRows,
    },
    {
        endpoint: 'qualifying',
        sessionKey: 'Qualifying',
        title: 'Квалификация',
        tableLabel: 'Результаты квалификации',
        columnNames: ['#', 'Пилот', 'Q1', 'Q2', 'Q3'],
        numericColumns: [],
        emptyMessage: 'Результатов квалификации пока нет.',
        errorMessage: 'Не удалось загрузить квалификацию.',
        getSession: race => race.Qualifying,
        renderRows: renderQualifyingRows,
    },
];
const RETRY_BUTTON = '<button class="retry-button" type="button" data-retry>Повторить</button>';

const telegram = window.Telegram?.WebApp;
const app = document.getElementById('app');
const view = document.getElementById('view');
const loader = document.getElementById('app-loader');
const standingsControls = document.getElementById('standings-controls');
const standingsButtons = [...standingsControls.querySelectorAll('[data-mode]')];
const tabs = [...document.querySelectorAll('[role=tab]')];
const cache = new Map();

let standingsMode = STANDINGS_MODE.DRIVERS;
let activeTab = 'schedule';
let renderId = 0;
let renderedHtml;

telegram?.ready();
telegram?.expand();

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function formatDateTime(date) {
    return date.toLocaleString('ru-RU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDay(slot) {
    const date = parseSessionTime(slot);
    return (date ?? new Date(slot.date)).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        timeZone: date ? undefined : 'UTC',
    });
}

function parseSessionTime(slot) {
    if (!slot?.time) {
        return null;
    }

    const hasOffset = /Z$|[+-]\d\d:\d\d$/.test(slot.time);
    const time = hasOffset ? slot.time : slot.time + 'Z';
    const date = new Date(`${slot.date}T${time}`);

    return Number.isFinite(date.getTime()) ? date : null;
}

function request(url) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.promise;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const entry = { expiresAt: Infinity };
    entry.promise = fetch(url, { signal: controller.signal })
        .then(response => {
            if (!response.ok) {
                throw new Error(response.status);
            }

            return response.json();
        })
        .then(data => {
            entry.expiresAt = Date.now() + CACHE_TTL_MS;
            return data;
        })
        .catch(error => {
            cache.delete(url);
            throw error;
        })
        .finally(() => clearTimeout(timeout));

    cache.set(url, entry);
    return entry.promise;
}

async function getF1Data(path) {
    return (await request(`${API_URL}/${path}.json?limit=100`)).MRData;
}

function getStreams() {
    return request('streams.json')
        .then(data => data ?? {})
        .catch(() => ({}));
}

function getSessions(race) {
    const sessions = [];
    for (const [key, name] of Object.entries(SESSION_NAMES)) {
        let slot = key === 'Race' ? race : race[key];
        if (key === 'SprintQualifying') {
            slot ??= race.SprintShootout;
        }
        if (slot?.date) {
            sessions.push({ key, name, at: parseSessionTime(slot), slot, race });
        }
    }

    return sessions.sort((first, second) => {
        const firstTime = first.at?.getTime() ?? Date.parse(first.slot.date);
        const secondTime = second.at?.getTime() ?? Date.parse(second.slot.date);
        return firstTime - secondTime;
    });
}

function getSessionLinks(streams, race, key) {
    return streams.sessions?.[`${race.season}:${race.round}:${key}`] ?? [];
}

function updateCountdown(element) {
    const seconds = Math.max(0, Math.ceil((Number(element.dataset.at) - Date.now()) / SECOND_MS));
    const values = [
        Math.floor(seconds / DAY_SECONDS),
        Math.floor(seconds / HOUR_SECONDS) % (DAY_SECONDS / HOUR_SECONDS),
        Math.floor(seconds / MINUTE_SECONDS) % MINUTE_SECONDS,
        seconds % MINUTE_SECONDS,
    ];

    element.querySelectorAll('strong').forEach((number, index) => {
        const next = String(values[index]).padStart(2, '0');
        if (number.textContent !== next) {
            number.textContent = next;
        }
    });
}

function renderStreamLink(source, text = source.label, className = 'stream-options__link') {
    if (!/^https:\/\/[^/]/i.test(source.url)) {
        return '';
    }

    return `
        <a class="${className}"
           href="${escapeHtml(source.url)}"
           target="_blank"
           rel="noopener">
            ${escapeHtml(text)}
        </a>
    `;
}

function renderBroadcasts(streams, session) {
    const sources = streams.sources ?? [];
    const directLinks = session ? getSessionLinks(streams, session.race, session.key) : [];
    const hasDirectLink = directLinks.length > 0;
    const primaryLink = directLinks[0] ?? sources[0];
    if (!primaryLink) {
        return '';
    }

    const extraLinks = hasDirectLink
        ? [...directLinks.slice(1), ...sources.filter(source => !directLinks.some(link => link.label === source.label))]
        : sources.slice(1);
    const title = hasDirectLink ? 'Смотреть трансляцию' : primaryLink.label;
    const extraLinksHtml = extraLinks.map(link => renderStreamLink(link)).join('');

    return `
        <section class="card broadcasts">
            <h2 class="broadcasts__title">Трансляции</h2>
            <div class="broadcasts__links">
                ${renderStreamLink(primaryLink, title, 'broadcasts__main-link')}
                <div class="stream-options">${extraLinksHtml}</div>
            </div>
        </section>
    `;
}

function renderScheduleHero(nextRace, nextSession) {
    let label = 'Календарь Формулы 1';
    let sessionDetails = '';
    if (nextSession) {
        label = 'Следующая сессия';
        const dateTime = formatDateTime(nextSession.at);
        const name = escapeHtml(nextSession.name);
        const countdownBoxes = ['дни', 'часы', 'мин', 'сек'].map(unit => `
            <div class="countdown__cell">
                <strong class="countdown__number"></strong>
                <span class="countdown__unit">${unit}</span>
            </div>
        `).join('');
        sessionDetails = `
            <p class="hero__session">${name} · ${dateTime}</p>
            <div class="countdown" id="countdown" data-at="${nextSession.at.getTime()}">
                ${countdownBoxes}
            </div>
        `;
    } else if (nextRace) {
        label = 'Следующий этап';
        sessionDetails = `<p class="hero__session">${formatDay(nextRace)} · время уточняется</p>`;
    }

    const title = nextRace ? escapeHtml(nextRace.raceName) : 'Сезон завершён';
    return `
        <section class="card hero">
            <div class="hero__label">${label}</div>
            <h1 class="hero__title">${title}</h1>
            ${sessionDetails}
        </section>
    `;
}

function renderSession(session, streams) {
    const time = session.at ? formatDateTime(session.at) : `${formatDay(session.slot)} · время уточняется`;
    const links = getSessionLinks(streams, session.race, session.key);
    const linksHtml = links.length > 0
        ? `<div class="stream-options">${links.map(link => renderStreamLink(link)).join('')}</div>`
        : '';

    return `
        <li class="race__session">
            <div>
                ${escapeHtml(session.name)}
                ${linksHtml}
            </div>
            <span class="race__session-time">${time}</span>
        </li>
    `;
}

function renderRaceCard(race, isNext, streams) {
    const className = isNext ? 'card race race_next' : 'card race';
    const round = escapeHtml(race.round);
    const location = race.Circuit.Location;
    const dateTime = parseSessionTime(race)?.toISOString() ?? race.date;
    const sessions = getSessions(race).map(session => renderSession(session, streams)).join('');

    return `
        <details class="${className}"
                 data-round="${round}"${isNext ? ' open' : ''}>
            <summary class="race__summary">
                <span class="race__round">${round}</span>
                <span>
                    <b class="race__name">${escapeHtml(race.raceName)}</b>
                    <span class="muted race__location">${escapeHtml(location.locality)}, ${escapeHtml(location.country)}</span>
                </span>
                <time class="muted race__date" datetime="${escapeHtml(dateTime)}">${formatDay(race)}</time>
            </summary>
            <ul class="race__sessions">${sessions}</ul>
        </details>
    `;
}

async function renderSchedule() {
    const [data, streams] = await Promise.all([getF1Data('races'), getStreams()]);
    const { Races: races, season } = data.RaceTable;
    if (!races.length) {
        return '<p class="card">Календарь сезона пока не опубликован.</p>';
    }

    const now = Date.now();
    const sessions = races.flatMap(getSessions);
    const upcomingSession = sessions.find(session => session.at > now);
    const unscheduledRace = races.find(race => {
        const dayEndsAt = Date.parse(race.date) + DAY_SECONDS * SECOND_MS;
        return !parseSessionTime(race) && dayEndsAt > now;
    });
    const isUnscheduledRaceNext = Boolean(unscheduledRace)
        && (!upcomingSession || unscheduledRace.date < upcomingSession.slot.date);
    const nextRace = isUnscheduledRaceNext ? unscheduledRace : upcomingSession?.race;
    const nextSession = upcomingSession?.race === nextRace ? upcomingSession : null;
    const ongoingSession = sessions.filter(session => session.at && session.at <= now).at(-1);
    const windowMs = ongoingSession?.key === 'Race' ? RACE_BROADCAST_WINDOW_MS : SESSION_BROADCAST_WINDOW_MS;
    const isBroadcastWindow = ongoingSession && now - ongoingSession.at < windowMs;
    const broadcastSession = isBroadcastWindow ? ongoingSession : nextSession;
    const raceCards = races.map(race => renderRaceCard(race, race === nextRace, streams)).join('');

    return `
        ${renderScheduleHero(nextRace, nextSession)}
        ${renderBroadcasts(streams, broadcastSession)}
        <div class="section-title">
            <h2>Календарь</h2>
            <span class="muted">${escapeHtml(season ?? races[0].season)}</span>
        </div>
        ${raceCards}
    `;
}

function renderTable(label, columnNames, numericColumns, rows) {
    const headings = columnNames.map(name => {
        const className = numericColumns.includes(name) ? ' class="num"' : '';
        return `<th scope="col"${className}>${escapeHtml(name)}</th>`;
    }).join('');

    return `
        <div class="table-card__scroll">
            <table aria-label="${escapeHtml(label)}">
                <thead><tr>${headings}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

async function renderStandings() {
    const isDriversMode = standingsMode === STANDINGS_MODE.DRIVERS;
    const data = await getF1Data(isDriversMode ? 'driverStandings' : 'constructorStandings');
    const standings = data.StandingsTable.StandingsLists[0];
    const rows = isDriversMode ? standings?.DriverStandings : standings?.ConstructorStandings;
    if (!rows?.length) {
        return '<p class="card">Зачёт пока не опубликован.</p>';
    }

    const rowHtml = rows.map(row => {
        const entry = isDriversMode
            ? `${escapeHtml(row.Driver.givenName)} <b>${escapeHtml(row.Driver.familyName)}</b>
               <div class="muted">${escapeHtml(row.Constructors?.at(-1)?.name ?? '')}</div>`
            : `<b>${escapeHtml(row.Constructor.name)}</b>`;
        return `
            <tr>
                <td>${escapeHtml(row.positionText)}</td>
                <td>${entry}</td>
                <td class="num">${escapeHtml(row.wins)}</td>
                <td class="num"><b>${escapeHtml(row.points)}</b></td>
            </tr>
        `;
    }).join('');
    const label = isDriversMode ? 'Личный зачёт' : 'Кубок конструкторов';
    const columnNames = ['#', isDriversMode ? 'Пилот' : 'Команда', 'Победы', 'Очки'];

    return `
        <section class="card table-card">
            <p class="table-card__heading muted">После ${escapeHtml(standings.round)}-го этапа</p>
            ${renderTable(label, columnNames, ['Победы', 'Очки'], rowHtml)}
        </section>
    `;
}

async function getLatestResult(section, calendar) {
    const latest = (await getF1Data(`last/${section.endpoint}`)).RaceTable.Races[0];
    const races = await calendar;

    // Jolpica's last route can lag behind a published session in a newer round.
    for (const race of [...races].reverse()) {
        if (Number(race.round) <= Number(latest?.round ?? 0)) {
            break;
        }

        const start = parseSessionTime(section.getSession(race));
        if (!start || start > Date.now()) {
            continue;
        }

        const data = await getF1Data(`${race.round}/${section.endpoint}`).catch(() => null);
        const result = data?.RaceTable.Races[0];
        if (result) {
            return result;
        }
    }

    return latest;
}

function renderRaceResultRows(race) {
    return race.Results.map(row => `
        <tr>
            <td>${escapeHtml(row.positionText)}</td>
            <td>
                <b>${escapeHtml(row.Driver.familyName)}</b>
                <div class="muted">${escapeHtml(row.Constructor.name)}</div>
            </td>
            <td class="table-card__time">${escapeHtml(row.Time?.time ?? row.status)}</td>
            <td class="num">${escapeHtml(row.points)}</td>
        </tr>
    `).join('');
}

function renderQualifyingRows(race) {
    return race.QualifyingResults.map(row => `
        <tr>
            <td>${escapeHtml(row.position)}</td>
            <td><b>${escapeHtml(row.Driver.familyName)}</b></td>
            <td class="table-card__time">${escapeHtml(row.Q1 || '—')}</td>
            <td class="table-card__time">${escapeHtml(row.Q2 || '—')}</td>
            <td class="table-card__time">${escapeHtml(row.Q3 || '—')}</td>
        </tr>
    `).join('');
}

function renderResultCard(section, outcome, streams) {
    const { title, tableLabel, columnNames, numericColumns, sessionKey, renderRows } = section;
    const race = outcome.value;
    if (!race) {
        const message = outcome.status === 'rejected' ? section.errorMessage : section.emptyMessage;
        return `
            <section class="card table-card table-card__heading">
                <h2>${title}</h2>
                <p class="muted">${message}</p>
            </section>
        `;
    }

    const dateLabel = sessionKey === 'Race' ? ` · ${formatDay(race)}` : '';
    const links = getSessionLinks(streams, race, sessionKey);
    const replayLinks = links.map(link => renderStreamLink(link, `Запись · ${link.label}`)).join('');
    const replays = replayLinks ? `<div class="stream-options">${replayLinks}</div>` : '';
    const table = renderTable(tableLabel, columnNames, numericColumns, renderRows(race));

    return `
        <section class="card table-card">
            <header class="table-card__heading">
                <h2>${title}</h2>
                <p class="muted">${escapeHtml(race.raceName)}${dateLabel}</p>
                ${replays}
            </header>
            ${table}
        </section>
    `;
}

async function renderResults() {
    const calendar = getF1Data('races').then(data => data.RaceTable.Races).catch(() => []);
    const [streams, outcomes] = await Promise.all([
        getStreams(),
        Promise.allSettled(RESULT_SECTIONS.map(section => getLatestResult(section, calendar))),
    ]);
    const cards = RESULT_SECTIONS.map((section, index) => renderResultCard(section, outcomes[index], streams)).join('');
    const hasLoadError = outcomes.some(outcome => outcome.status === 'rejected');

    return `
        <h1 class="page-title">Последние результаты</h1>
        ${cards}
        ${hasLoadError ? RETRY_BUTTON : ''}
    `;
}

const TAB_RENDERERS = { schedule: renderSchedule, standings: renderStandings, results: renderResults };

function replaceView(html, shouldAnimate) {
    if (html === renderedHtml) {
        return;
    }

    const focusedRace = document.activeElement?.closest('.race__summary')?.parentElement?.dataset.round;
    const overrides = new Map([...view.querySelectorAll('.race')]
        .filter(race => race.open !== race.classList.contains('race_next'))
        .map(race => [race.dataset.round, race.open]));

    view.innerHTML = shouldAnimate ? `<div class="view_enter">${html}</div>` : html;
    for (const race of view.querySelectorAll('.race')) {
        const round = race.dataset.round;
        if (overrides.has(round)) {
            race.open = overrides.get(round);
        }
        if (round === focusedRace) {
            race.querySelector('summary').focus({ preventScroll: true });
        }
    }

    renderedHtml = html;
}

function selectTab(tab) {
    if (tab !== activeTab) {
        window.scrollTo(0, 0);
    }
    activeTab = tab;

    for (const button of tabs) {
        const isSelected = button.dataset.tab === tab;
        button.setAttribute('aria-selected', isSelected);
        button.tabIndex = isSelected ? 0 : -1;
    }

    app.setAttribute('aria-labelledby', `tab-${tab}`);
    standingsControls.hidden = tab !== 'standings';
}

async function showTab(tab, { keepContent = false } = {}) {
    const id = ++renderId;
    selectTab(tab);
    view.setAttribute('aria-busy', 'true');
    if (!keepContent) {
        loader.hidden = false;
        view.replaceChildren();
        renderedHtml = undefined;
    }

    let html;
    try {
        html = await TAB_RENDERERS[tab]();
    } catch {
        html = keepContent && renderedHtml !== undefined
            ? renderedHtml
            : `<p class="card">Не удалось загрузить данные.</p>${RETRY_BUTTON}`;
    }
    if (id !== renderId) {
        return;
    }

    replaceView(html, !keepContent);
    const countdown = document.getElementById('countdown');
    if (countdown) {
        updateCountdown(countdown);
    }
    loader.hidden = true;
    view.setAttribute('aria-busy', 'false');
}

function tickCountdown() {
    const countdown = document.getElementById('countdown');
    if (!countdown) {
        return;
    }

    updateCountdown(countdown);
    const now = Date.now();
    const isExpired = Number(countdown.dataset.at) <= now;
    const isBusy = view.getAttribute('aria-busy') === 'true';
    const canRefresh = now >= Number(countdown.dataset.refreshAfter ?? 0);
    if (isExpired && !isBusy && canRefresh) {
        countdown.dataset.refreshAfter = now + SCHEDULE_RETRY_MS;
        showTab('schedule', { keepContent: true });
    }
}

tabs.forEach((button, index) => {
    button.addEventListener('click', () => {
        if (button.dataset.tab !== activeTab) {
            showTab(button.dataset.tab);
        }
    });
    button.addEventListener('keydown', event => {
        const targets = {
            ArrowLeft: (index + tabs.length - 1) % tabs.length,
            ArrowRight: (index + 1) % tabs.length,
            Home: 0,
            End: tabs.length - 1,
        };
        if (!Object.hasOwn(targets, event.key)) {
            return;
        }

        event.preventDefault();
        const nextTab = tabs[targets[event.key]];
        nextTab.focus();
        if (nextTab.dataset.tab !== activeTab) {
            showTab(nextTab.dataset.tab);
        }
    });
});

for (const button of standingsButtons) {
    button.addEventListener('click', () => {
        const { mode } = button.dataset;
        if (mode === standingsMode) {
            return;
        }

        standingsMode = mode;
        for (const option of standingsButtons) {
            option.setAttribute('aria-pressed', option.dataset.mode === mode);
        }
        showTab('standings');
    });
}

view.addEventListener('click', event => {
    if (event.target.closest('[data-retry]')) {
        showTab(activeTab);
    }

    const link = event.target.closest('a');
    if (link && telegram?.initData && telegram.openLink) {
        event.preventDefault();
        telegram.openLink(link.href);
    }
});

document.addEventListener('visibilitychange', () => {
    const isBusy = view.getAttribute('aria-busy') === 'true';
    if (!document.hidden && !isBusy) {
        showTab(activeTab, { keepContent: true });
    }
});

setInterval(tickCountdown, SECOND_MS);
showTab('schedule');
