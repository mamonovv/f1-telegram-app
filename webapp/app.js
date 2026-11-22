const API = 'https://api.jolpi.ca/ergast/f1/current';
const SESSION_NAMES = {
  FirstPractice: 'Практика 1',
  SecondPractice: 'Практика 2',
  ThirdPractice: 'Практика 3',
  SprintQualifying: 'Спринт-квалификация',
  Sprint: 'Спринт',
  Qualifying: 'Квалификация',
  Race: 'Гонка',
};

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const app = document.getElementById('app');
const tabs = [...document.querySelectorAll('[role=tab]')];
const cache = new Map();
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const when = d => d.toLocaleString('ru-RU', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const day = slot => slot ? (toDate(slot) || new Date(slot.date)).toLocaleDateString('ru-RU', {
  day: 'numeric', month: 'long', ...(slot.time ? {} : { timeZone: 'UTC' }),
}) : '';

function toDate(slot) {
  if (!slot?.time) return null;
  const time = /Z$|[+-]\d\d:\d\d$/.test(slot.time) ? slot.time : slot.time + 'Z';
  const date = new Date(`${slot.date}T${time}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function request(url) {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.promise;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const entry = { expires: Infinity };
  entry.promise = fetch(url, { signal: controller.signal }).then(response => {
    if (!response.ok) throw new Error(response.status);
    return response.json();
  }).then(data => {
    entry.expires = Date.now() + 300000;
    return data;
  }).catch(error => {
    cache.delete(url);
    throw error;
  }).finally(() => clearTimeout(timeout));
  cache.set(url, entry);
  return entry.promise;
}

const get = async path => (await request(`${API}/${path}.json?limit=100`)).MRData;
const getStreams = () => request('streams.json').then(data => data || {}).catch(() => ({}));
const sessionId = (race, key) => `${race.season}:${race.round}:${key}`;

function sessionsOf(race) {
  const sessions = [];
  for (const [key, name] of Object.entries(SESSION_NAMES)) {
    const slot = key === 'Race' ? race : race[key] || (key === 'SprintQualifying' && race.SprintShootout);
    if (slot?.date) sessions.push({ key, name, at: toDate(slot), slot, race });
  }
  return sessions.sort((a, b) =>
    (a.at?.getTime() ?? Date.parse(a.slot.date)) - (b.at?.getTime() ?? Date.parse(b.slot.date)));
}

function countdown(to) {
  const seconds = Math.max(0, Math.ceil((to - Date.now()) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return (days ? `${days} д ` : '') + `${hours} ч ${minutes % 60} мин`;
}

function streamLink(source, text = source.label, className = '') {
  if (!/^https:\/\/[^/]/i.test(source.url)) return '';
  return `<a class="${className}" href="${esc(source.url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

function streamCard(streams, session) {
  const sources = streams.sources || [];
  const direct = session && streams.sessions?.[sessionId(session.race, session.key)] || [];
  const primary = direct[0] || sources[0];
  if (!primary) return '';
  const others = direct.length
    ? [...direct.slice(1), ...sources.filter(source => !direct.some(link => link.label === source.label))]
    : sources.slice(1);
  const title = direct.length ? 'Смотреть трансляцию' : `Канал ${primary.label}`;
  return `<section class="card">
    ${streamLink(primary, title, 'stream')}
    <div class="stream-options">${others.map(source => streamLink(source)).join('')}</div>
  </section>`;
}

async function renderSchedule() {
  const [data, streams] = await Promise.all([get('races'), getStreams()]);
  const races = data.RaceTable.Races;
  if (!races.length) return '<p class="card">Календарь сезона пока не опубликован.</p>';

  const now = Date.now();
  const sessions = races.flatMap(sessionsOf);
  const upcoming = sessions.find(session => session.at > now);
  const tbc = races.find(race => !toDate(race) && Date.parse(race.date) + 86400000 > now);
  const next = tbc && (!upcoming || tbc.date < upcoming.slot.date) ? tbc : upcoming?.race;
  const nextSession = upcoming?.race === next ? upcoming : null;
  const current = sessions.filter(session => session.at && session.at <= now).at(-1);
  const streamSession = current && now - current.at < (current.key === 'Race' ? 10800000 : 5400000)
    ? current : nextSession;

  let html = nextSession ? `<section class="card next">
    <div class="muted">Следующая сессия · ${esc(next.raceName)}</div>
    <div class="countdown" id="countdown" data-at="${nextSession.at.getTime()}">${countdown(nextSession.at)}</div>
    <div>${esc(nextSession.name)} · ${when(nextSession.at)}</div>
  </section>` : `<p class="card">${next
    ? `Следующий этап · ${esc(next.raceName)} · ${day(next)}`
    : 'Сезон завершён 🏁'}</p>`;
  html += streamCard(streams, streamSession) + '<h2>Календарь</h2>';

  for (const race of races) {
    const raceStart = toDate(race);
    const past = raceStart && raceStart < now;
    html += `<details class="card ${race === next ? 'next' : ''} ${past ? 'past' : ''}" ${race === next ? 'open' : ''}>
      <summary>
        <b>${esc(race.round)}. ${esc(race.raceName)}</b>
        <div class="muted">${esc(race.Circuit.Location.locality)}, ${esc(race.Circuit.Location.country)} · ${day(race)}</div>
      </summary>
      <ul class="sessions">${sessionsOf(race).map(session => `<li>
        <span>${esc(session.name)}</span>
        <span>${session.at ? when(session.at) : `${day(session.slot)} · время уточняется`}</span>
      </li>`).join('')}</ul>
    </details>`;
  }
  return html;
}

let standingsMode = 'drivers';
async function renderStandings() {
  const drivers = standingsMode === 'drivers';
  const data = await get(drivers ? 'driverStandings' : 'constructorStandings');
  const list = data.StandingsTable.StandingsLists[0];
  const rows = list ? (drivers ? list.DriverStandings : list.ConstructorStandings) : [];
  const switcher = `<div class="seg">
    <button type="button" data-mode="drivers" aria-pressed="${drivers}">Пилоты</button>
    <button type="button" data-mode="constructors" aria-pressed="${!drivers}">Команды</button>
  </div>`;
  if (!rows.length) return switcher + '<p class="card">Зачёт пока не опубликован.</p>';

  return switcher + `<div class="muted">После ${esc(list.round)}-го этапа</div>
    <table><tr><th>#</th><th>${drivers ? 'Пилот' : 'Команда'}</th><th class="num">Победы</th><th class="num">Очки</th></tr>
    ${rows.map(row => `<tr>
      <td>${esc(row.positionText)}</td>
      <td>${drivers
        ? `${esc(row.Driver.givenName)} <b>${esc(row.Driver.familyName)}</b><div class="muted">${esc(row.Constructors?.at(-1)?.name ?? '')}</div>`
        : `<b>${esc(row.Constructor.name)}</b>`}</td>
      <td class="num">${esc(row.wins)}</td>
      <td class="num"><b>${esc(row.points)}</b></td>
    </tr>`).join('')}</table>`;
}

async function latestResult(endpoint, calendar, sessionOf) {
  const latest = (await get(`last/${endpoint}`)).RaceTable.Races[0];
  const races = await calendar;
  // Jolpica's last route can lag behind a published session in a newer round.
  for (const race of [...races].reverse()) {
    if (+race.round <= +(latest?.round ?? 0)) break;
    const start = toDate(sessionOf(race));
    if (!start || start > Date.now()) continue;
    const result = (await get(`${race.round}/${endpoint}`).catch(() => null))?.RaceTable.Races[0];
    if (result) return result;
  }
  return latest;
}

function replayLinks(streams, race, key) {
  const links = streams.sessions?.[sessionId(race, key)] || [];
  return links.length
    ? `<div class="stream-options">${links.map(source => streamLink(source, `Запись · ${source.label}`)).join('')}</div>`
    : '';
}

async function renderResults() {
  const calendar = get('races').then(data => data.RaceTable.Races).catch(() => []);
  const [race, quali, streams] = await Promise.allSettled([
    latestResult('results', calendar, race => race),
    latestResult('qualifying', calendar, race => race.Qualifying),
    getStreams(),
  ]);
  let html = '<h2>Гонка</h2>';
  if (race.value) {
    const result = race.value;
    html += `<b>${esc(result.raceName)}</b><div class="muted">${day(result)}</div>
      ${replayLinks(streams.value, result, 'Race')}
      <table><tr><th>#</th><th>Пилот</th><th>Время</th><th class="num">Очки</th></tr>
      ${result.Results.map(row => `<tr>
        <td>${esc(row.positionText)}</td>
        <td><b>${esc(row.Driver.familyName)}</b><div class="muted">${esc(row.Constructor.name)}</div></td>
        <td>${esc(row.Time?.time ?? row.status)}</td>
        <td class="num">${esc(row.points)}</td>
      </tr>`).join('')}</table>`;
  } else {
    html += `<p class="card">${race.status === 'rejected' ? 'Не удалось загрузить гонку.' : 'Результатов гонки пока нет.'}</p>`;
  }

  html += '<h2>Квалификация</h2>';
  if (quali.value) {
    const result = quali.value;
    html += `<b>${esc(result.raceName)}</b>
      ${replayLinks(streams.value, result, 'Qualifying')}
      <table><tr><th>#</th><th>Пилот</th><th>Q1</th><th>Q2</th><th>Q3</th></tr>
      ${result.QualifyingResults.map(row => `<tr>
        <td>${esc(row.position)}</td>
        <td><b>${esc(row.Driver.familyName)}</b></td>
        <td>${esc(row.Q1 || '—')}</td>
        <td>${esc(row.Q2 || '—')}</td>
        <td>${esc(row.Q3 || '—')}</td>
      </tr>`).join('')}</table>`;
  } else {
    html += `<p class="card">${quali.status === 'rejected' ? 'Не удалось загрузить квалификацию.' : 'Результатов квалификации пока нет.'}</p>`;
  }
  if (race.status === 'rejected' || quali.status === 'rejected') {
    html += '<button type="button" data-retry>Повторить</button>';
  }
  return html;
}

const RENDER = { schedule: renderSchedule, standings: renderStandings, results: renderResults };
let activeTab = 'schedule';
let renderId = 0;
async function show(tab, { keepContent = false, focusMode = false } = {}) {
  activeTab = tab;
  const id = ++renderId;
  for (const button of tabs) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', selected);
    button.tabIndex = selected ? 0 : -1;
  }
  app.setAttribute('aria-labelledby', `tab-${tab}`);
  app.setAttribute('aria-busy', 'true');
  if (!keepContent) app.innerHTML = '<p class="muted" role="status">Загрузка…</p>';
  let html;
  try {
    html = await RENDER[tab]();
  } catch {
    html = '<p class="card">Не удалось загрузить данные.</p><button type="button" data-retry>Повторить</button>';
  }
  if (id !== renderId) return;
  app.innerHTML = html;
  app.setAttribute('aria-busy', 'false');
  if (focusMode) app.querySelector(`[data-mode="${standingsMode}"]`)?.focus();
}

tabs.forEach((button, index) => {
  button.addEventListener('click', () => show(button.dataset.tab));
  button.addEventListener('keydown', event => {
    const targets = {
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    tabs[targets[event.key]].focus();
    show(tabs[targets[event.key]].dataset.tab);
  });
});
app.addEventListener('click', event => {
  const { mode } = event.target.dataset;
  if (mode && mode !== standingsMode) {
    standingsMode = mode;
    show('standings', { focusMode: true });
  }
  if (event.target.hasAttribute('data-retry')) show(activeTab);
  const link = event.target.closest('a');
  if (link && tg?.initData && tg.openLink) {
    event.preventDefault();
    tg.openLink(link.href);
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) show(activeTab, { keepContent: true });
});
setInterval(() => {
  const element = document.getElementById('countdown');
  if (!element) return;
  const at = Number(element.dataset.at);
  if (at <= Date.now()) {
    if (app.getAttribute('aria-busy') !== 'true') show('schedule', { keepContent: true });
  } else {
    element.textContent = countdown(at);
  }
}, 1000);
show('schedule');
