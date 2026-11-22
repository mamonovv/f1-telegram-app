# Формула 1 в Telegram

Mini App показывает календарь в часовом поясе устройства, зачёт пилотов и команд, последние результаты гонки и квалификации. Бот хранит подписки в SQLite и напоминает о сессиях примерно за 30 минут.

## Первый запуск

1. В Telegram отправьте `/newbot` боту [@BotFather](https://t.me/BotFather) и сохраните выданный токен.
2. Для Mini App включите **Settings → Pages → Source → GitHub Actions** и запустите workflow **Deploy Mini App**. В артефакт попадёт каталог `webapp/`. HTTPS-адрес страницы понадобится для параметра `WEBAPP_URL`. Его же можно задать через `/setmenubutton` в BotFather.
3. Для локальной проверки бота используйте Python 3.11 или новее.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
read -rs -p 'BOT_TOKEN: ' BOT_TOKEN
export BOT_TOKEN
export WEBAPP_URL=https://mamonovv.github.io/f1-telegram-app/
.venv/bin/python bot.py
```

Откройте чат с ботом и проверьте `/start`, `/subscribe` и `/unsubscribe`. До публикации Mini App пропустите строку с `WEBAPP_URL`. Для просмотра страницы вне Telegram запустите `python3 -m http.server 8000 --directory webapp` и откройте `http://localhost:8000`.

## Трансляции

В [`webapp/streams.json`](webapp/streams.json) перечислены источники. Чтобы добавить прямую ссылку, внесите её в `sessions` под ключом вида `2026:22:Race` (сезон, номер этапа Jolpica, сессия). Ключи сессий перечислены в `SESSION_NAMES`. Когда прямой ссылки для сессии ещё нет, приложение и бот показывают источники. Бот подхватывает обновления файла с GitHub Pages примерно раз в пять минут.

## Бот на VPS

GitHub Pages публикует Mini App. Для круглосуточной работы бота используйте Linux с systemd. Разместите проект в `/opt/f1-telegram-app` и создайте там виртуальное окружение.

```bash
cd /opt/f1-telegram-app
sudo python3 -m venv .venv
sudo .venv/bin/pip install -r requirements.txt
sudo install -m 600 /dev/null /etc/f1-telegram-bot.env
sudoedit /etc/f1-telegram-bot.env
```

В примере ниже подставьте токен BotFather и опубликованный адрес. Файл остаётся на VPS.

```dotenv
BOT_TOKEN=ваш_токен
WEBAPP_URL=https://mamonovv.github.io/f1-telegram-app/
```

```bash
sudo install -m 644 deploy/f1-telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now f1-telegram-bot
sudo journalctl -u f1-telegram-bot -n 50 --no-pager
```

Подписки и отметки об отправке хранятся в `/var/lib/f1-telegram-bot/f1.sqlite3`. Перед запуском сервиса остановите локальный экземпляр бота.
