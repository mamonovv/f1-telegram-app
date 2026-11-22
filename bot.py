import asyncio
import json
import logging
import math
import os
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout
from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramAPIError, TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

CALENDAR_URL = "https://api.jolpi.ca/ergast/f1/current/races.json?limit=100"
STREAMS_FILE = Path(__file__).resolve().parent / "webapp" / "streams.json"
SESSION_NAMES = {
    "FirstPractice": "Практика 1",
    "SecondPractice": "Практика 2",
    "ThirdPractice": "Практика 3",
    "SprintQualifying": "Спринт-квалификация",
    "Sprint": "Спринт",
    "Qualifying": "Квалификация",
    "Race": "Гонка",
}
REMINDER_WINDOW = timedelta(minutes=30)

dp = Dispatcher()
dp.message.filter(F.chat.type == "private")
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Session:
    id: str
    race: str
    name: str
    starts_at: datetime


def calendar_sessions(races: list[dict]) -> list[Session]:
    sessions = []
    for race in races:
        for key, name in SESSION_NAMES.items():
            slot = race if key == "Race" else race.get(key)
            if key == "SprintQualifying" and not slot:
                slot = race.get("SprintShootout")
            if not slot or not slot.get("date") or not slot.get("time"):
                continue
            starts_at = datetime.fromisoformat(f"{slot['date']}T{slot['time']}")
            if starts_at.tzinfo is None:
                starts_at = starts_at.replace(tzinfo=UTC)
            sessions.append(Session(
                f"{race['season']}:{race['round']}:{key}", race["raceName"], name, starts_at
            ))
    return sorted(sessions, key=lambda session: session.starts_at)


def init_db(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS subscribers (chat_id INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS reminders (
            session_id TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            PRIMARY KEY (session_id, chat_id)
        );
    """)


@dp.message(CommandStart())
async def start(message: Message, webapp_url: str | None) -> None:
    text = (
        "Привет! Я бот про Формулу 1 🏎️\n\n"
        "/subscribe — напоминания за 30 минут до сессий\n"
        "/unsubscribe — отключить напоминания"
    )
    keyboard = None
    if webapp_url:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="Открыть приложение", web_app=WebAppInfo(url=webapp_url)),
        ]])
    await message.answer(text, reply_markup=keyboard)


@dp.message(Command("subscribe"))
async def subscribe(message: Message, db: sqlite3.Connection) -> None:
    with db:
        db.execute("INSERT OR IGNORE INTO subscribers VALUES (?)", (message.chat.id,))
    await message.answer("Напоминания включены. Отключить их можно командой /unsubscribe.")


@dp.message(Command("unsubscribe"))
async def unsubscribe(message: Message, db: sqlite3.Connection) -> None:
    with db:
        db.execute("DELETE FROM subscribers WHERE chat_id = ?", (message.chat.id,))
    await message.answer("Напоминания отключены.")


def stream_keyboard(streams: dict, session_id: str) -> InlineKeyboardMarkup | None:
    direct = streams["sessions"].get(session_id, [])
    sources = direct if isinstance(direct, list) else []
    rows = []
    labels = set()
    for source in [*sources, *streams["sources"]]:
        if not isinstance(source, dict):
            continue
        label, url = source.get("label"), source.get("url")
        if not isinstance(label, str) or not label or label in labels or not isinstance(url, str):
            continue
        try:
            parsed = urlsplit(url)
        except ValueError:
            continue
        if parsed.scheme == "https" and parsed.hostname:
            rows.append([InlineKeyboardButton(text=label, url=url)])
            labels.add(label)
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


async def send_reminders(
    bot: Bot, db: sqlite3.Connection, sessions: list[Session], streams: dict,
) -> int:
    now = datetime.now(UTC)
    for session in sessions:
        if not now < session.starts_at <= now + REMINDER_WINDOW:
            continue
        recipients = db.execute("""
            SELECT chat_id FROM subscribers
            WHERE NOT EXISTS (
                SELECT 1 FROM reminders WHERE session_id = ? AND chat_id = subscribers.chat_id
            )
        """, (session.id,)).fetchall()
        keyboard = stream_keyboard(streams, session.id)
        for (chat_id,) in recipients:
            seconds_left = (session.starts_at - datetime.now(UTC)).total_seconds()
            if seconds_left <= 0:
                break
            with db:
                claimed = db.execute("""
                    INSERT OR IGNORE INTO reminders
                    SELECT ?, chat_id FROM subscribers WHERE chat_id = ?
                """, (session.id, chat_id)).rowcount
            if not claimed:
                continue

            try:
                await bot.send_message(
                    chat_id,
                    f"🏎️ {session.race}\n{session.name} через {math.ceil(seconds_left / 60)} мин.",
                    reply_markup=keyboard,
                )
            except TelegramRetryAfter as error:
                with db:
                    db.execute("DELETE FROM reminders WHERE session_id = ? AND chat_id = ?", (session.id, chat_id))
                return error.retry_after
            except TelegramForbiddenError:
                with db:
                    db.execute("DELETE FROM subscribers WHERE chat_id = ?", (chat_id,))
            except TelegramAPIError:
                # shortcut: keep the claim when delivery is uncertain, until Telegram supports idempotent sends.
                log.exception("Ошибка отправки напоминания для сессии %s", session.id)
    return 0


async def notification_loop(bot: Bot, db: sqlite3.Connection, webapp_url: str | None) -> None:
    streams = json.loads(STREAMS_FILE.read_text(encoding="utf-8"))
    sessions = []
    refresh_calendar = refresh_streams = 0.0
    loop = asyncio.get_running_loop()
    async with ClientSession(timeout=ClientTimeout(total=10), raise_for_status=True) as http:
        while True:
            if loop.time() >= refresh_calendar:
                try:
                    async with http.get(CALENDAR_URL) as response:
                        data = await response.json()
                    sessions = calendar_sessions(data["MRData"]["RaceTable"]["Races"])
                except (ClientError, TimeoutError, ValueError, KeyError, TypeError):
                    log.exception("Не удалось обновить календарь Jolpica")
                    refresh_calendar = loop.time() + 60
                else:
                    refresh_calendar = loop.time() + 3600

            if webapp_url and loop.time() >= refresh_streams:
                try:
                    async with http.get(urljoin(webapp_url, "streams.json")) as response:
                        catalog = await response.json()
                    if isinstance(catalog["sources"], list) and isinstance(catalog["sessions"], dict):
                        streams = catalog
                except (ClientError, TimeoutError, ValueError, KeyError, TypeError):
                    log.warning("Не удалось обновить список трансляций с Mini App")
                refresh_streams = loop.time() + 300

            retry_after = await send_reminders(bot, db, sessions, streams)
            await asyncio.sleep(max(30, retry_after))


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    token = os.environ.get("BOT_TOKEN")
    if not token:
        raise SystemExit("Укажите BOT_TOKEN, полученный от @BotFather.")
    webapp_url = os.environ.get("WEBAPP_URL") or None
    if webapp_url:
        url = urlsplit(webapp_url)
        if url.scheme != "https" or not url.hostname:
            raise SystemExit("WEBAPP_URL должен быть публичным HTTPS-адресом Mini App.")
        if not url.path.endswith(("/", ".html")):
            webapp_url = url._replace(path=url.path + "/").geturl()

    with closing(sqlite3.connect(os.environ.get("DB_PATH", "f1.sqlite3"))) as db:
        init_db(db)
        async with Bot(token) as bot, asyncio.TaskGroup() as tasks:
            notifications = tasks.create_task(notification_loop(bot, db, webapp_url))
            try:
                await dp.start_polling(bot, db=db, webapp_url=webapp_url, close_bot_session=False)
            finally:
                notifications.cancel()


if __name__ == "__main__":
    asyncio.run(main())
