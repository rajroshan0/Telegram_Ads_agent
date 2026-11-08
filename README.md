# Telegram Ads Agent

A web app to run your Telegram Ads account: create many ads at once (form, CSV or Google Sheet), manage and monitor ads, plan test batches, check channel overlap, manage audiences / pixel / sub-accounts, auto-rules that pause bad ads, and alerts to your Telegram bot. Every Telegram Ads API method is reachable (API Explorer page).

Stack: Node.js 20+ and Express. No database (JSON files in `data/`). Plain JavaScript UI, no build step.

## Run it on your computer

```bash
cd "Telegram ads agent"
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open http://localhost:3000, go to **Settings**, paste your Ads API token, press **Test connection**. You can also put the token in `.env` (`TG_ADS_TOKEN=`). `npm test` runs the automatic tests against a fake Telegram API (no money, no network).

## Deploy on the web

1. Put the folder on a server with Node 20+, `npm install --omit=dev`, then `npm start` (use pm2 or systemd to keep it running).
2. In `.env` set `HOST=0.0.0.0`, `PORT`, and **`APP_PASSWORD`** to a long password. The app refuses to start on a public address without it, because anyone who reaches it could spend your ad money.
3. Serve it over **HTTPS** (Caddy, nginx or the host's built-in HTTPS) and set `COOKIE_SECURE=true`.
4. Keep only one running copy: the monitor and rules run inside the process.
5. Prefer putting tokens in `.env` on the server instead of saving them through Settings.

## Pages

| Page | What it does |
|---|---|
| Overview | Balance, spend, totals, best / worst ads |
| Ads | Filter, sort, select many → pause / resume / add budget / change CPM / daily limit / frequency / delete; open any ad for edit, stats, targeting; export CSV or to Google Sheets |
| Create ad | One ad with live check ("what will be sent") before creating |
| Bulk create | Many ads from pasted CSV, uploaded CSV or a Google Sheet; validate first, run with progress, retry only failed rows |
| Batch builder | Paste a channel list, split into batches × creatives (A/B/C) → send to Bulk create |
| Overlap checker | See which channels you already use in other ads, and overlap between your own ads |
| Stats | Multi-ad charts and monthly report |
| Audiences | Create / add / remove / replace phone-number audiences |
| Pixel & conversions | Pixel code, events |
| Targeting lookup | Topics, languages, countries, cities, channel / bot check |
| Auto rules | e.g. "spent ≥ 5 AND cpa > 1 → pause". Starts in test mode. Monitor sends Telegram alerts |
| Accounts & money | Account info, sub-accounts, move funds, transactions |
| Settings | Tokens, alerts, Google service account |
| API explorer | Call any Ads API method with JSON |

## Bulk CSV columns

Download the template inside the app (Bulk create → "CSV template"); it lists every column with an example. Main ones: `title, text, promote_url, cpm, placement, target_type, channels / bots / queries, topics, languages, countries, exclude_channels, initial_budget, daily_budget_limit, schedule_hours, schedule_days, timezone, photo_url / video_url, button, pixel_event_id, audiences, exclude_audiences`. Lists use commas, spaces or new lines inside one cell. Column names are forgiving (aliases like `channel`, `link`, `budget`).

## Google Sheets

- **Public sheet** ("Anyone with the link can view"): paste the link in Bulk create, no setup.
- **Private sheet / writing results back**: create a Google Cloud service account, enable the *Google Sheets API*, create a JSON key, paste it in Settings (or `GOOGLE_SERVICE_ACCOUNT_FILE` in `.env`), and share the sheet with the service account email as **Editor**.

## Alerts bot

Create a bot with @BotFather, send it a message, put its token and your chat id in Settings, press "Send test message", then enable the monitor. You get messages when an ad is declined (with reason), changes status, runs low on budget, when the account balance is low, and when a rule acts.

## Safety

- Anything that spends or deletes asks for confirmation. Rules start in test mode and only act when you switch test mode off.
- Bulk runs stop immediately on token / balance / account errors instead of hammering the API.
- Repeated create requests reuse idempotency keys, so a retry will not create a duplicate ad.
- Tokens are never sent to the browser in full and are stored with owner-only permissions.
- Not verified against the live API yet: the fake API used in tests follows the documentation, but real Telegram may differ in details. If the real API rejects arrays or objects, set `TG_PARAM_ENCODING=form` (or in Settings). Audience phone formatting and Google Sheets were not tested live. Start with a tiny budget (e.g. 1 TON) and one ad.
- Telegram and local laws restrict gambling advertising. Make sure the offer, countries and wording are allowed for the brand you promote.

## Folder map

`server.js` API + static files · `src/` backend logic (`tgads.js` API client, `bulk.js` CSV→ads, `rules.js`, `analysis.js`, `sheets.js`, `notify.js`) · `public/` UI (`js/pages1-3.js`, `core.js`, `boot.js`) · `test/` mock API and tests · `data/` your settings, rules, logs (private, not shared).
