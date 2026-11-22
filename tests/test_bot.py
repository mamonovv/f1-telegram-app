import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock

from aiogram.exceptions import TelegramRetryAfter
from aiogram.methods import SendMessage

from bot import Session, calendar_sessions, init_db, send_reminders


class RemindersTest(unittest.IsolatedAsyncioTestCase):
    def test_calendar_orders_sessions_and_skips_unknown_start(self):
        race = {
            "season": "2026", "round": "1", "raceName": "Grand Prix",
            "date": "2026-03-08", "time": "10:00:00Z",
            "FirstPractice": {"date": "2026-03-06"},
            "SprintShootout": {"date": "2026-03-07", "time": "10:00:00+02:00"},
        }
        sessions = calendar_sessions([race])
        self.assertEqual([s.id for s in sessions], ["2026:1:SprintQualifying", "2026:1:Race"])
        self.assertEqual(sessions[0].starts_at.astimezone(UTC).hour, 8)

    async def test_reminders_are_saved_per_subscriber_across_restart(self):
        fake_bot = AsyncMock()
        now = datetime.now(UTC)
        sessions = [
            Session("past", "Grand Prix", "Практика 1", now - timedelta(minutes=1)),
            Session("race", "Grand Prix", "Гонка", now + timedelta(minutes=29)),
            Session("future", "Grand Prix", "Квалификация", now + timedelta(minutes=40)),
        ]
        streams = {
            "sources": [{"label": "Первый", "url": "https://example.org/channel"}],
            "sessions": {"race": [{"label": "Первый", "url": "https://example.org/live"}]},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.sqlite3"
            with closing(sqlite3.connect(path)) as db:
                init_db(db)
                with db:
                    db.execute("INSERT INTO subscribers VALUES (1)")
                await send_reminders(fake_bot, db, sessions, streams)

            with closing(sqlite3.connect(path)) as db:
                init_db(db)
                with db:
                    db.execute("INSERT INTO subscribers VALUES (2)")
                    db.execute("INSERT INTO subscribers VALUES (3)")
                    db.execute("DELETE FROM subscribers WHERE chat_id = 3")
                await send_reminders(fake_bot, db, sessions, streams)

        calls = fake_bot.send_message.await_args_list
        self.assertEqual([call.args[0] for call in calls], [1, 2])
        self.assertEqual(calls[0].kwargs["reply_markup"].inline_keyboard[0][0].url, "https://example.org/live")

    async def test_telegram_rate_limit_can_be_retried(self):
        fake_bot = AsyncMock()
        fake_bot.send_message.side_effect = [
            TelegramRetryAfter(method=SendMessage(chat_id=1, text="test"), message="limit", retry_after=5),
            None,
        ]
        sessions = [Session("race", "Grand Prix", "Гонка", datetime.now(UTC) + timedelta(minutes=10))]
        streams = {"sources": [], "sessions": {}}
        with closing(sqlite3.connect(":memory:")) as db:
            init_db(db)
            with db:
                db.execute("INSERT INTO subscribers VALUES (1)")
            self.assertEqual(await send_reminders(fake_bot, db, sessions, streams), 5)
            self.assertEqual(await send_reminders(fake_bot, db, sessions, streams), 0)
            await send_reminders(fake_bot, db, sessions, streams)
        self.assertEqual(fake_bot.send_message.await_count, 2)
