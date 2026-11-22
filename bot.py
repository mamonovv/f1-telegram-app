import asyncio
import logging
import os

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

BOT_TOKEN = os.environ["BOT_TOKEN"]
# Mini App появится на этапе 2; Telegram требует https-ссылку.
WEBAPP_URL = os.environ.get("WEBAPP_URL")

dp = Dispatcher()


@dp.message(CommandStart())
async def start(message: Message) -> None:
    text = "Привет! Я бот про Формулу 1 🏎️"
    if not WEBAPP_URL:
        await message.answer(text + "\nПриложение скоро появится.")
        return
    keyboard = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Открыть приложение", web_app=WebAppInfo(url=WEBAPP_URL)),
    ]])
    await message.answer(text, reply_markup=keyboard)


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    await dp.start_polling(Bot(BOT_TOKEN))


if __name__ == "__main__":
    asyncio.run(main())
