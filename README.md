# tg-gallery

Telegram bot that downloads images from gallery web pages, packages them into a
ZIP archive, and delivers the archive two ways at once:

- straight to your Telegram chat (up to 2 GB), so you can save / forward it
  inside Telegram itself, and
- as an HTTPS download link served by nginx, so any browser can grab it.

You send the bot one (or several) gallery URLs; it scrapes the images using a
site-specific strategy, downloads them in parallel, zips them up, and replies
with both the file and a private download link.

```
┌─────────────┐  MTProto       ┌──────────────────┐
│ Telegram    │ ────────────▶  │ Node :3000       │   scrape + download
│ DC servers  │ ◀──────────── │   tg-gallery     │ ───────────▶  Internet
└─────────────┘  long-poll     │   (GramJS)       │              (optional
                                └──────┬───────────┘               SOCKS5 proxy)
                                       │
                                       ▼
                              /var/lib/tg-gallery/
                              ├─ downloads/  (ZIP archives, served by nginx :443)
                              └─ temp/       (per-job staging area)
```

The bot is a normal `@username_bot` from BotFather — it just uses GramJS to
talk MTProto directly to Telegram instead of the Bot-API HTTP. That's what
lets it upload archives up to **2 GB** (4 GB with Telegram Premium) straight
to your chat instead of being capped at the 50 MB Bot-API limit.

## Features

- Multi-gallery batching — paste several URLs, get a single ZIP back.
- ZIP delivered straight to your Telegram chat (up to 2 GB) **and** as a direct
  HTTPS download link.
- Strategy engine — per-domain CSS selectors stored in a JSON config; new sites
  are added without touching the bot code.
- Auto-detection — if the domain isn't explicitly known, the bot tries the
  first few strategies in turn until one returns enough images.
- Optional SOCKS5 proxy — strategies marked `useProxy: true` are routed through
  `PROXY_URL`, so you can scrape sites that block datacenter IPs.
- Parallel image downloads with retry + exponential backoff.
- File browser — `/files` lists every saved archive with size, date, source
  URLs, individual delete and bulk delete.
- Cancel mid-download — every job has a "Cancel" button that aborts cleanly.
- Random suffix on every archive name — generated download URLs are not
  guessable from the input.
- Atomic ZIP writes — temporary `.tmp` file, renamed on completion; nginx
  refuses to serve `.tmp` and `.json` so half-written files and metadata
  sidecars are never exposed.

## Requirements

- Linux server (tested on Ubuntu 22.04+).
- Node.js 20+ (the installer installs it if missing).
- nginx (the installer installs it if missing) — used for `/health` and
  `/downloads/`. The bot itself does **not** use a webhook.
- A bot token from [@BotFather](https://t.me/BotFather).
- A Telegram client app credential pair (`api_id` + `api_hash`) from
  [my.telegram.org/apps](https://my.telegram.org/apps). These identify the
  client app talking MTProto; the bot token still authenticates the bot
  account itself.
- A public HTTPS domain pointed at the server, with a TLS certificate. Used
  only to serve the direct-download links — Telegram never connects to it.
- A **Cloudflare Origin Certificate** is the recommended setup (matches the
  sister repos): save the `.pem` and `.key` somewhere readable (e.g.
  `/root/certs/`). Let's Encrypt also works.
- (Optional) A SOCKS5 proxy listening on `127.0.0.1` if you want to route some
  scraping traffic through it. The installer asks for it interactively.

## Installation

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ali934h/tg-gallery/main/install.sh)
```

The installer:

1. Installs Node.js 20, PM2, nginx, and `pm2-logrotate` if missing.
2. Asks for the bot token, `TG_API_ID`, `TG_API_HASH`, public host, SSL
   certificate paths, internal port, allowed user IDs, and download/temp
   directories.
3. Asks (optionally) for a SOCKS5 proxy host/port and credentials.
4. Clones the repo to `/root/tg-gallery`, runs `npm install`, writes
   `/root/tg-gallery/.env` with `chmod 600`, drops an nginx vhost in
   `/etc/nginx/conf.d/tg-gallery.conf`, and starts the bot under PM2.
5. The bot connects to Telegram via MTProto on first start and persists its
   session in `telegram.session` (chmod 600).

After the script finishes, hit `https://<your-host>/health` to confirm the
HTTP side is up, and `pm2 logs tg-gallery` to confirm the MTProto side
connected (`Logged in as @your_bot`).

## Configuration

The installer writes a `.env` from these knobs (all are also documented in
[`.env.example`](.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `BOT_TOKEN` | *required* | Bot token from @BotFather. |
| `TG_API_ID` | *required* | Numeric client-app id from my.telegram.org/apps. |
| `TG_API_HASH` | *required* | Client-app hash from my.telegram.org/apps. |
| `TG_SESSION_FILE` | `<install>/telegram.session` | Where the persisted MTProto session lives. |
| `PORT` | `3000` | Internal HTTP port for `/health` (nginx proxies to it). |
| `HOST` | `127.0.0.1` | Bind address for the local HTTP server. |
| `NODE_ENV` | `production` | Switches log verbosity. |
| `DOWNLOADS_DIR` | `/var/lib/tg-gallery/downloads` | Where ZIP archives live. nginx serves this directly. |
| `DOWNLOAD_BASE_URL` | from public host | Public URL prefix for downloads. |
| `TEMP_DIR` | `/var/lib/tg-gallery/temp` | Per-job staging area. Cleaned up automatically. |
| `ALLOWED_USERS` | empty | Comma-separated Telegram user IDs. Empty = open. |
| `DOWNLOAD_CONCURRENCY` | `5` | Parallel image downloads per gallery. |
| `DOWNLOAD_TIMEOUT_MS` | `60000` | Per-image HTTP timeout. |
| `DOWNLOAD_RETRIES` | `3` | Per-image retry count. |
| `SCRAPE_TIMEOUT_MS` | `30000` | HTML fetch timeout. |
| `SCRAPE_RETRIES` | `3` | HTML fetch retries. |
| `FALLBACK_STRATEGY_LIMIT` | `5` | When a domain isn't known, try at most this many strategies. |
| `FALLBACK_MIN_IMAGES` | `5` | A fallback strategy is considered "working" if it extracts at least this many images. |
| `PROXY_URL` | empty | `socks5://[user:pass@]host:port`. Used only by strategies that opt in via `useProxy: true`. |
| `SESSION_IDLE_TTL_MS` | `86400000` | Idle session GC threshold. |
| `TELEGRAM_MAX_UPLOAD_BYTES` | `2147483648` | Per-archive cap on direct in-chat sends. Bigger archives still get the link. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug`. |

After editing `.env`, run `pm2 restart tg-gallery --update-env`.

## Bot commands

- `/start` — welcome message and quick reference.
- `/help` — full usage notes.
- `/files` — manage downloaded archives (view, delete, bulk delete).
- `/cancel` — reset the current flow (does not abort an in-progress download;
  use the on-screen "Cancel Download" button for that).

The default flow is:

1. Send one or more gallery URLs (one per line).
2. The bot replies with a summary and three buttons: **Start Download**,
   **Rename**, **Cancel**.
3. After the download finishes you receive a job summary, the direct download
   link, and the ZIP file itself attached in chat (when it fits the
   `TELEGRAM_MAX_UPLOAD_BYTES` cap).
4. Use `/files` later to find or delete past archives.

The archive name must start with a letter or digit and may only contain
letters, digits, `-`, `_`, and `.`. `..` and path separators are rejected, and
names that would create a hidden file (e.g. `.env`) are not accepted. A short
random suffix is appended to every accepted name to keep download URLs
unguessable.

## Adding a site strategy

Edit [`src/config/siteStrategies.json`](src/config/siteStrategies.json) and add
an entry keyed on the site's domain (without `www.`):

```json
{
  "example.com": {
    "name": "Example",
    "useProxy": false,
    "headers": { "Referer": "https://example.com/" },
    "images": {
      "selector": "a.image-link",
      "attr": "href",
      "filterPatterns": ["thumb", "preview"]
    }
  }
}
```

- `selector` — any CSS selector that matches the elements pointing to the
  full-resolution image.
- `attr` — the attribute on those elements that holds the image URL (often
  `href` for `<a>` or `data-src` for lazy-loaded `<img>`).
- `filterPatterns` — substrings used to drop thumbnail/preview URLs.
- `useProxy` — set to `true` to route requests through `PROXY_URL`.
- `headers` — extra HTTP headers to send (e.g. a `Referer`).

After editing the file, run `pm2 restart tg-gallery`.

If you'd rather not configure a strategy, the bot will still try the first
`FALLBACK_STRATEGY_LIMIT` strategies it has and pick the first one that
returns at least `FALLBACK_MIN_IMAGES` images.

## Operations

```bash
# logs
pm2 logs tg-gallery

# restart after editing .env
pm2 restart tg-gallery --update-env

# pull the latest version
bash /root/tg-gallery/update.sh

# remove everything
bash /root/tg-gallery/uninstall.sh

# check nginx config
nginx -t

# health check
curl https://<your-host>/health
```

PM2 is configured with `pm2-logrotate` (10 MB, 7 files retained).

## Security notes

- **No webhook**: the bot uses MTProto long-polling, so there is no inbound
  HTTPS endpoint Telegram pushes to and no webhook secret to leak.
- **Whitelist**: leave `ALLOWED_USERS` empty only on a temporary testing bot.
  In production it should be a comma-separated list of allowed Telegram user
  IDs. Send `/start` to [@userinfobot](https://t.me/userinfobot) to look up
  yours.
- **Public download URLs**: every archive name gets a random 6-character hex
  suffix, and nginx denies `.json` / `.tmp` / dotfile lookups, so links are
  not guessable. Anyone you share a link with can still download it — treat
  the link itself as a secret.
- **/root permissions**: the installer keeps `DOWNLOADS_DIR` outside `/root`
  by default so we never have to relax `/root` to `755`. If you override the
  default into `/root/...` the installer warns you and asks before
  proceeding.
- **`.env` mode 600**: only the bot user reads it; treat the bot token,
  `TG_API_HASH`, and the persisted `telegram.session` like passwords.

## Project layout

```
src/
├── config.js              env parsing + validation
├── logger.js              timestamped logger w/ LOG_LEVEL
├── fileManager.js         async fs helpers + temp cleanup
├── archiveName.js         archive-name validation + random suffix
├── files.js               list/read/save/delete .zip + sidecar metadata
├── htmlEscape.js          HTML escape for parse_mode=HTML
├── sessions.js            per-user state machine + idle GC
├── server.js              tiny Express app exposing /health
├── bot.js                 BotAdapter wiring + auth middleware
├── index.js               entry point (TelegramClient + MTProto login)
├── tg/
│   ├── markup.js          telegraf-shaped Markup helpers
│   ├── ctx.js             GramJS event → telegraf-style Ctx adapter
│   └── adapter.js         BotAdapter (commands, actions, middleware)
├── handlers/
│   ├── commands.js        /start, /help, /cancel, /files, text + rename
│   ├── files.js           inline-keyboard browser
│   └── job.js             gallery extract → download → zip → send pipeline
├── scrapers/
│   ├── jsdomScraper.js    HTTP + JSDOM extraction
│   └── strategyEngine.js  domain → strategy lookup + fallback search
├── downloaders/
│   ├── imageDownloader.js parallel streaming downloader (proxy-aware)
│   └── zipCreator.js      atomic ZIP writer (.tmp + rename)
├── utils/
│   └── telegramRetry.js   429 / FLOOD_WAIT retry helper
└── config/
    └── siteStrategies.json
```

## License

MIT
