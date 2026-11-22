# Формула 1 в Telegram

Mini App показывает календарь в часовом поясе устройства, зачёт пилотов и команд, последние результаты гонки и квалификации. Бот хранит подписки в SQLite и напоминает о сессиях примерно за 30 минут.

## Первый запуск

1. В Telegram отправьте `/newbot` боту [@BotFather](https://t.me/BotFather) и сохраните выданный токен.
2. Для Mini App включите **Settings → Pages → Source → GitHub Actions** и запустите workflow **Deploy Mini App**. В артефакт попадёт каталог `webapp/`. HTTPS-адрес страницы понадобится для параметра `WEBAPP_URL`. Его же можно задать через `/setmenubutton` в BotFather.
3. Для локальной проверки бота используйте Python 3.11 или новее.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade --only-binary=:all: 'pip>=26.2'
.venv/bin/python -m pip install -r requirements.txt
read -rs -p 'BOT_TOKEN: ' BOT_TOKEN
export BOT_TOKEN
export WEBAPP_URL=https://mamonovv.github.io/f1-telegram-app/
.venv/bin/python bot.py
```

Откройте чат с ботом и проверьте `/start`, `/subscribe` и `/unsubscribe`. До публикации Mini App пропустите строку с `WEBAPP_URL`. Для просмотра страницы вне Telegram запустите `python3 -m http.server 8000 --directory webapp` и откройте `http://localhost:8000`.

## Трансляции

В [`webapp/streams.json`](webapp/streams.json) перечислены источники. Чтобы добавить прямую ссылку, внесите её в `sessions` под ключом вида `2026:22:Race` (сезон, номер этапа Jolpica, сессия). Ключи сессий перечислены в `SESSION_NAMES`. Когда прямой ссылки для сессии ещё нет, приложение и бот показывают источники. Бот подхватывает обновления файла с GitHub Pages примерно раз в пять минут.

## Стиль фронтенда

- Используем `camelCase` для функций и переменных, `UPPER_SNAKE_CASE` для констант и префиксы `is`, `has` или `should` для логических значений.
- Даём имена таймаутам и значениям, которые должны меняться вместе. Используем фигурные скобки, ранние выходы и небольшие функции. Вычисления выносим из HTML-шаблонов в JavaScript.
- Используем четыре пробела для вложенности. Если у HTML-тега больше двух атрибутов, выравниваем их по первому атрибуту и закрываем открывающий тег на строке последнего.
- Для CSS используем БЭМ в формате `блок__элемент_модификатор`. Цвета темы храним в CSS-переменных.

## Бот на VPS

GitHub Pages публикует Mini App. Для круглосуточной работы бота используйте Linux с systemd. При первой установке клонируйте проект в `/opt/f1-telegram-app` и создайте там виртуальное окружение.

```bash
sudo git clone https://github.com/mamonovv/f1-telegram-app.git /opt/f1-telegram-app
cd /opt/f1-telegram-app
sudo python3 -m venv .venv
sudo .venv/bin/python -m pip install --upgrade --only-binary=:all: 'pip>=26.2'
sudo .venv/bin/python -m pip install -r requirements.txt
sudo sh -c 'umask 077; touch /etc/f1-telegram-bot.env'
sudo chmod 600 /etc/f1-telegram-bot.env
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

Подписки и отметки об отправке хранятся в `/var/lib/f1-telegram-bot/f1.sqlite3`. Бот раз в час удаляет отметки старше семи дней. Для старых отметок без времени отсчёт начинается с первого запуска после обновления. Перед запуском сервиса остановите локальный экземпляр бота.

### Обновление бота на VPS

После пуша в `main` подключитесь по SSH к VPS. В каталоге установленного бота скачайте код и установите зависимости:

```bash
cd /opt/f1-telegram-app \
  && sudo git pull --ff-only \
  && sudo .venv/bin/python -m pip install --only-binary=:all: 'pip>=26.2' \
  && sudo .venv/bin/python -m pip install -r requirements.txt
```

Если команда завершилась ошибкой, разберите её перед перезапуском. Если в обновлении менялся `deploy/f1-telegram-bot.service`, переустановите файл сервиса:

```bash
sudo install -m 644 deploy/f1-telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Перезапустите бота, проверьте статус `active (running)` и отправьте `/start` в Telegram.

```bash
sudo systemctl restart f1-telegram-bot
sudo systemctl status f1-telegram-bot --no-pager
```

Если бот не отвечает, посмотрите последние записи командой `sudo journalctl -u f1-telegram-bot -n 50 --no-pager`. Токен уже хранится в `/etc/f1-telegram-bot.env`, а существующую базу SQLite бот обновляет при запуске. Изменения Mini App из `webapp/` публикует GitHub Actions при пуше в `main`.
