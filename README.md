# tg-gallery — Telegram Gallery Downloader Bot

Telegram bot for downloading gallery images, integrated with **3x-ui** panel for proxy support.

## Features

🖼 **Gallery Downloader**
- Extract images from multiple gallery sites
- Automatic site detection with fallback strategies
- Download images in parallel
- Package into ZIP files with direct download links

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                            Server                                │
│                                                                  │
│  3x-ui panel  (your-vpn-domain.com)                              │
│    └── Xray                                                      │
│          ├── Inbound: VLESS/Trojan (any port)   ← for VPN users  │
│          └── Inbound: mixed 127.0.0.1:1080      ← for this bot   │
│                                                                  │
│  tg-gallery  (your-bot-domain.com)                               │
│    ├── nginx:443 (SSL) → Node.js:127.0.0.1:3000                 │
│    └── PROXY_URL=socks5://user:pass@127.0.0.1:1080               │
└──────────────────────────────────────────────────────────────────┘
```

> ⚠️ **The bot domain MUST be different from the 3x-ui domain.**

---

## Prerequisites

### Step 1 — Install 3x-ui

Install [3x-ui](https://github.com/MHSanaei/3x-ui) on your server with your preferred settings.

### Step 2 — Create a `mixed` inbound in 3x-ui panel

In the 3x-ui web panel, go to **Inbounds → Add Inbound**:

| Field      | Value           |
|------------|-----------------|
| Protocol   | `mixed`         |
| Listen IP  | `127.0.0.1`     |
| Port       | `1080`          |
| Password   | Enabled ✅      |
| Username   | (any value)     |
| Password   | (any value)     |

> This inbound is **local only** (127.0.0.1) — not exposed to the internet.

### Step 3 — Prepare bot domain & SSL

#### Option A — Let's Encrypt (Certbot) ✅ Recommended

```bash
certbot certonly --standalone -d your-bot-domain.com
```

Then use these paths in the installer:
```
SSL_CERT = /etc/letsencrypt/live/your-bot-domain.com/fullchain.pem
SSL_KEY  = /etc/letsencrypt/live/your-bot-domain.com/privkey.pem
```

#### Option B — Cloudflare Origin Certificate

If you use a Cloudflare Origin Certificate:
- Enable Cloudflare proxy 🟠 (orange cloud)
- Set SSL/TLS mode to **Full (strict)**

---

## Installation

```bash
bash <(curl -Ls https://raw.githubusercontent.com/ali934h/tg-gallery/main/install.sh)
```

The installer will:
- Install Node.js, PM2, nginx (if not present)
- Clone the repository to `/root/tg-gallery`
- Configure environment variables
- Write nginx config to `/etc/nginx/conf.d/tg-gallery.conf` (safe — does not touch other configs)
- Start the bot with PM2 as `tg-gallery`

You'll be asked for:
- Telegram Bot Token
- Bot domain
- SSL certificate paths
- Internal HTTP port (default: 3000)
- Proxy username & password
- Allowed user IDs (optional)
- Download concurrency
- Downloads directory

---

## Usage

### Gallery Downloader

1. Send one or more gallery URLs (one per line)
2. Choose a name for the ZIP archive
3. Tap "Start Download" and wait
4. Receive your download link

**Supported sites:** See `src/config/siteStrategies.json` for full list.

---

## How Proxy Works

Each site strategy in `src/config/siteStrategies.json` has a `useProxy` flag:

```json
{
  "example-site.com": {
    "useProxy": true
  },
  "another-site.com": {
    "useProxy": false
  }
}
```

When `useProxy: true`, traffic routes through `socks5://user:pass@127.0.0.1:1080`.

---

## Troubleshooting

### Check webhook status
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

| `last_error_message` | Cause | Fix |
|----------------------|-------|-----|
| `SSL error: certificate verify failed` | Origin Cert with proxy OFF | Enable Cloudflare proxy (orange cloud) |
| `Wrong response: 521` | Cloudflare can't reach server | Check bot is running: `pm2 status` |
| `Connection refused` | Bot not running or wrong port | `pm2 restart tg-gallery --update-env` |
| *(empty)* | ✅ Everything working | — |

### View live logs
```bash
pm2 logs tg-gallery
```

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and see features |
| `/help` | Show detailed usage instructions |
| `/files` | View and manage downloaded files |
| `/cancel` | Cancel current operation |

---

## File Management

Use `/files` command to view, download, or delete ZIP files.
Files are stored in the directory specified during installation (default: `/root/tg-gallery-downloads`).

---

## Useful Commands

```bash
pm2 logs tg-gallery            # live logs
pm2 restart tg-gallery         # restart
pm2 stop tg-gallery            # stop
pm2 restart tg-gallery --update-env  # restart with new env vars
nginx -t                       # test nginx config
nginx -s reload                # reload nginx
systemctl status x-ui          # check 3x-ui status
```

---

## Requirements

- Ubuntu 20.04+ or Debian 11+
- Node.js 20+ (auto-installed)
- nginx (auto-installed)
- 3x-ui panel with mixed inbound
- Valid SSL certificate
