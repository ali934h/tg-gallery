# tg-gallery

Telegram bot that downloads gallery images via proxy, packages them into ZIP files, and serves direct download links.

## Prerequisites

- Ubuntu 20.04+ or Debian 11+
- 3x-ui panel installed with a `mixed` inbound on `127.0.0.1:1080`
- A domain (separate from 3x-ui domain) with a valid SSL certificate
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)

## Installation

```bash
bash <(curl -Ls https://raw.githubusercontent.com/ali934h/tg-gallery/main/install.sh)
```

## Daily Commands

```bash
pm2 logs tg-gallery            # live logs
pm2 restart tg-gallery         # restart bot
pm2 stop tg-gallery            # stop bot
pm2 restart tg-gallery --update-env  # restart with new env vars
bash /root/tg-gallery/update.sh      # update to latest version
bash /root/tg-gallery/uninstall.sh   # remove completely
```

## Troubleshooting

**Bot not responding**
```bash
pm2 status
pm2 logs tg-gallery --lines 50
```

**Webhook error**
```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

| `last_error_message` | Fix |
|---|---|
| `SSL error: certificate verify failed` | Enable Cloudflare proxy (orange cloud) |
| `Wrong response: 521` | Check bot is running: `pm2 status` |
| `Connection refused` | `pm2 restart tg-gallery --update-env` |

**nginx error**
```bash
nginx -t
nginx -s reload
```

**Downloads not accessible**
```bash
ls -la /root/tg-gallery-downloads/
nginx -t
```
