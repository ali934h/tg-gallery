#!/usr/bin/env bash
# tg-gallery installer — sets up Node.js, PM2, the repo, an nginx vhost (for
# /health + /downloads), and starts the bot under PM2.
#
# The bot connects to Telegram via MTProto using its bot token, so there is
# no webhook — it just needs BOT_TOKEN + TG_API_ID + TG_API_HASH and an
# outbound connection.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/ali934h/tg-gallery/main/install.sh)
set -euo pipefail

# ── colours / helpers ────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; NC=$'\033[0m'
step() { echo "${BLUE}==>${NC} $*"; }
info() { echo "${GREEN}[+]${NC} $*"; }
warn() { echo "${YELLOW}[!]${NC} $*"; }
err()  { echo "${RED}[x]${NC} $*" >&2; exit 1; }

INSTALL_DIR="/root/tg-gallery"
REPO_URL="https://github.com/ali934h/tg-gallery.git"
NGINX_CONF_FILE="/etc/nginx/conf.d/tg-gallery.conf"

[[ $EUID -eq 0 ]] || err "Must run as root (sudo -i)."

clear
echo "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo "${GREEN}║      tg-gallery — installer                  ║${NC}"
echo "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo

# ── prompts ──────────────────────────────────────────────────
prompt() {
  local var="$1"; local label="$2"; local default="${3:-}"; local val=""
  while true; do
    if [[ -n "$default" ]]; then
      read -r -p "$label [$default]: " val
      val="${val:-$default}"
    else
      read -r -p "$label: " val
    fi
    [[ -n "$val" ]] && break
    warn "Cannot be empty."
  done
  printf -v "$var" "%s" "$val"
}

prompt_file() {
  local var="$1"; local label="$2"; local val=""
  while true; do
    read -r -p "$label: " val
    if [[ -z "$val" ]]; then warn "Cannot be empty."
    elif [[ ! -f "$val" ]]; then warn "File not found: $val"
    else break
    fi
  done
  printf -v "$var" "%s" "$val"
}

prompt_int() {
  local var="$1"; local label="$2"; local val=""
  while true; do
    read -r -p "$label: " val
    if [[ "$val" =~ ^[0-9]+$ && "$val" -gt 0 ]]; then break
    else warn "Must be a positive integer."
    fi
  done
  printf -v "$var" "%s" "$val"
}

prompt_optional() {
  local var="$1"; local label="$2"; local default="${3:-}"
  read -r -p "$label [${default}]: " val || true
  printf -v "$var" "%s" "${val:-$default}"
}

step "Collecting configuration"
prompt        BOT_TOKEN       "Telegram BOT_TOKEN (from @BotFather)"
prompt_int    TG_API_ID       "TG_API_ID (numeric, from https://my.telegram.org/apps)"
prompt        TG_API_HASH     "TG_API_HASH (from https://my.telegram.org/apps)"
prompt        PUBLIC_HOST     "Public HTTPS host (e.g. gallery.example.com — used for /downloads)"
PUBLIC_HOST="${PUBLIC_HOST#http://}"
PUBLIC_HOST="${PUBLIC_HOST#https://}"
PUBLIC_HOST="${PUBLIC_HOST%/}"
prompt_file   SSL_FULLCHAIN   "Path to fullchain.pem"
prompt_file   SSL_KEY         "Path to privkey.pem"

PORT=""
while true; do
  prompt_optional PORT "Internal HTTP port (1024-65535)" "3000"
  [[ "$PORT" =~ ^[0-9]+$ && $PORT -ge 1024 && $PORT -le 65535 ]] || { warn "Invalid port"; continue; }
  if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
    warn "Port ${PORT} is already in use."
    continue
  fi
  break
done

prompt_optional ALLOWED_USERS  "Allowed Telegram user IDs (comma-separated, empty = everyone)" ""
prompt_optional DOWNLOADS_DIR  "Downloads directory" "/var/lib/tg-gallery/downloads"
prompt_optional TEMP_DIR       "Temp working directory" "/var/lib/tg-gallery/temp"

if [[ "$DOWNLOADS_DIR" == /root/* ]]; then
  warn "DOWNLOADS_DIR is under /root which would require relaxing /root permissions."
  warn "Strongly recommended to use a directory outside /root (default suggestion above)."
  read -r -p "Continue anyway? [y/N]: " yn
  [[ "$yn" =~ ^[Yy]$ ]] || err "Aborted by user."
fi

prompt_optional DOWNLOAD_CONCURRENCY "Per-gallery image download concurrency (1-20)" "5"

# ── proxy config ─────────────────────────────────────────────
echo
step "Optional SOCKS5 proxy (used by strategies that set useProxy=true)"
read -r -p "Configure a SOCKS5 proxy now? [y/N]: " ENABLE_PROXY
PROXY_URL=""
if [[ "$ENABLE_PROXY" =~ ^[Yy]$ ]]; then
  prompt_optional PROXY_HOST "Proxy host" "127.0.0.1"
  prompt_optional PROXY_PORT "Proxy port" "1080"
  read -r -p "Does the proxy require username + password? [y/N]: " PROXY_AUTH
  if [[ "$PROXY_AUTH" =~ ^[Yy]$ ]]; then
    prompt PROXY_USER "Proxy username"
    prompt PROXY_PASS "Proxy password"
    PROXY_URL="socks5://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}"
  else
    PROXY_URL="socks5://${PROXY_HOST}:${PROXY_PORT}"
  fi
fi

DOWNLOAD_BASE_URL="https://${PUBLIC_HOST}/downloads"

echo
step "Configuration summary"
cat <<EOF
  Public host    : https://${PUBLIC_HOST}
  Internal port  : ${PORT}
  SSL fullchain  : ${SSL_FULLCHAIN}
  SSL key        : ${SSL_KEY}
  Downloads      : ${DOWNLOADS_DIR}
  Temp dir       : ${TEMP_DIR}
  Download URL   : ${DOWNLOAD_BASE_URL}
  Concurrency    : ${DOWNLOAD_CONCURRENCY}
  Allowed users  : ${ALLOWED_USERS:-<everyone>}
  Proxy          : ${PROXY_URL:-<disabled>}
  TG_API_ID      : ${TG_API_ID}
  nginx conf     : ${NGINX_CONF_FILE}
  Install dir    : ${INSTALL_DIR}
EOF
echo
read -r -p "Proceed with installation? [Y/n]: " CONFIRM
[[ ! "$CONFIRM" =~ ^[Nn]$ ]] || err "Aborted by user."

# ── system deps ──────────────────────────────────────────────
step "Installing system packages"
apt-get update -qq
apt-get install -y -qq curl git unzip openssl ca-certificates >/dev/null

if ! command -v nginx >/dev/null 2>&1; then
  info "Installing nginx"
  apt-get install -y -qq nginx >/dev/null
fi

if ! command -v node >/dev/null 2>&1; then
  info "Installing Node.js 20.x"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
info "Node $(node -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  info "Installing PM2"
  npm install -g pm2 --silent >/dev/null
fi
info "PM2 $(pm2 -v)"

pm2 install pm2-logrotate --silent 2>/dev/null || true
pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
pm2 set pm2-logrotate:retain 7    >/dev/null 2>&1 || true

# ── cleanup previous install ─────────────────────────────────
step "Cleaning previous installation (if any)"
pm2 delete tg-gallery >/dev/null 2>&1 || true
pm2 save --force >/dev/null 2>&1 || true
if [[ -f "$NGINX_CONF_FILE" ]]; then
  cp "$NGINX_CONF_FILE" "${NGINX_CONF_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  rm -f "$NGINX_CONF_FILE"
fi
# Old vhosts from earlier installs also matched this hostname; remove them
# so they don't shadow the new config.
for stale in /etc/nginx/conf.d/gallery-bot.conf /etc/nginx/conf.d/gallery-bot.conf.bak.*; do
  [[ -e "$stale" ]] && rm -f "$stale"
done
if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
fi

# ── clone repo + npm install ─────────────────────────────────
step "Cloning repo to $INSTALL_DIR"
git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

step "Installing npm packages"
npm install --silent --no-audit --no-fund >/dev/null

mkdir -p "$INSTALL_DIR/logs"
mkdir -p "$DOWNLOADS_DIR" "$TEMP_DIR"
chmod 755 "$DOWNLOADS_DIR" "$TEMP_DIR"

# ── write .env ───────────────────────────────────────────────
step "Writing .env"
cat > "$INSTALL_DIR/.env" <<EOF
NODE_ENV=production

BOT_TOKEN=${BOT_TOKEN}
TG_API_ID=${TG_API_ID}
TG_API_HASH=${TG_API_HASH}
TG_SESSION_FILE=${INSTALL_DIR}/telegram.session

PORT=${PORT}
HOST=127.0.0.1

DOWNLOADS_DIR=${DOWNLOADS_DIR}
DOWNLOAD_BASE_URL=${DOWNLOAD_BASE_URL}
TEMP_DIR=${TEMP_DIR}

ALLOWED_USERS=${ALLOWED_USERS}
DOWNLOAD_CONCURRENCY=${DOWNLOAD_CONCURRENCY}

PROXY_URL=${PROXY_URL}

TELEGRAM_MAX_UPLOAD_BYTES=2147483648

LOG_LEVEL=info
EOF
chmod 600 "$INSTALL_DIR/.env"
touch "$INSTALL_DIR/telegram.session"
chmod 600 "$INSTALL_DIR/telegram.session"

# ── nginx ────────────────────────────────────────────────────
step "Writing nginx config $NGINX_CONF_FILE"
sed \
  -e "s|__HOST__|${PUBLIC_HOST}|g" \
  -e "s|__SSL_FULLCHAIN__|${SSL_FULLCHAIN}|g" \
  -e "s|__SSL_KEY__|${SSL_KEY}|g" \
  -e "s|__PORT__|${PORT}|g" \
  -e "s|__DOWNLOADS_DIR__|${DOWNLOADS_DIR}|g" \
  "$INSTALL_DIR/nginx/tg-gallery.conf" > "$NGINX_CONF_FILE"

nginx -t >/dev/null
nginx -s reload
info "nginx reloaded"

# ── start with PM2 ───────────────────────────────────────────
step "Starting tg-gallery under PM2"
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | tail -1 | bash >/dev/null 2>&1 || true

echo
echo "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo "${GREEN}║   tg-gallery installed successfully!         ║${NC}"
echo "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo
echo "  Public host   : https://${PUBLIC_HOST}"
echo "  Install dir   : ${INSTALL_DIR}"
echo "  Downloads     : ${DOWNLOADS_DIR}"
echo "  Download URL  : ${DOWNLOAD_BASE_URL}"
echo "  nginx conf    : ${NGINX_CONF_FILE}"
echo
echo "  The bot connects to Telegram via MTProto (no webhook),"
echo "  so it can upload archives up to 2 GB straight to your chat."
echo
echo "  Useful:"
echo "    pm2 logs tg-gallery        # live logs"
echo "    pm2 restart tg-gallery     # restart"
echo "    bash $INSTALL_DIR/update.sh"
echo "    bash $INSTALL_DIR/uninstall.sh"
echo
