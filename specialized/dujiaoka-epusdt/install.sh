#!/usr/bin/env bash
# Dujiaoka + EPUSDT: one-click deployment for Ubuntu/Debian VPS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SHOP_PORT="${SHOP_PORT:-18080}"
EPUSDT_PORT="${EPUSDT_PORT:-18081}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-dujiaoka-epusdt}"

usage() {
    cat <<'EOF'
Usage:
  ./install.sh <domain> <telegram_bot_token> <telegram_admin_id>

Example:
  ./install.sh example.com YOUR_BOT_TOKEN YOUR_TELEGRAM_USER_ID

Before running:
  1. Point example.com, www.example.com and usdt.example.com to this server (e.g. Cloudflare DNS).
  2. Run as a user with sudo access on Ubuntu/Debian.

Environment overrides (optional):
  SHOP_PORT=18080 EPUSDT_PORT=18081 ./install.sh ...
EOF
}

log() {
    printf '[dujiaoka-epusdt] %s\n' "$*"
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log "Missing required command: $1"
        exit 1
    fi
}

wait_for_container_health() {
    local service="$1"
    local attempts="${2:-60}"
    local i

    for ((i = 1; i <= attempts; i++)); do
        local status
        status="$(docker compose ps --format json "$service" 2>/dev/null | grep -o '"Health":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)"
        if [[ "$status" == "healthy" ]]; then
            return 0
        fi
        if docker compose ps --status running --services 2>/dev/null | grep -qx "$service"; then
            if [[ "$service" != "db" ]] && docker compose exec -T "$service" true 2>/dev/null; then
                return 0
            fi
        fi
        sleep 2
    done

    log "Timed out waiting for service: $service"
    docker compose ps
    exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

if [[ $# -ne 3 ]]; then
    usage
    exit 1
fi

if [[ -f "$SCRIPT_DIR/.installed" ]]; then
    log "Already installed. Remove $SCRIPT_DIR/.installed to reinstall (this will NOT delete data)."
    exit 1
fi

MAIN_DOMAIN="$1"
BOT_TOKEN="$2"
ADMIN_TG_ID="$3"
CALLBACK_ADDRESS="https://usdt.${MAIN_DOMAIN}/api/v1/order/create-transaction"

log "Installing dependencies..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq docker.io docker-compose-plugin php-cli nginx gettext-base openssl

if ! groups "$USER" | grep -q docker; then
    sudo usermod -aG docker "$USER" || true
    log "Added $USER to docker group. You may need to log out and back in if docker permission errors occur."
fi

require_command docker
require_command php
require_command openssl

if ! docker compose version >/dev/null 2>&1; then
    log "docker compose plugin is required."
    exit 1
fi

log "Generating secrets..."
AUTH_TOKEN="$(openssl rand -base64 32 | tr -d '\n')"
MYSQL_ROOT_PASSWORD="$(openssl rand -hex 16)"
MYSQL_PASSWORD="$(openssl rand -hex 16)"
ADMIN_ROUTE_PREFIX="/$(openssl rand -hex 8)"
APP_KEY="base64:$(openssl rand -base64 32 | tr -d '\n')"

eval "$(php "$SCRIPT_DIR/scripts/generate-admin-password.php")"

mkdir -p \
    "$SCRIPT_DIR/data/mysql" \
    "$SCRIPT_DIR/data/redis" \
    "$SCRIPT_DIR/uploads" \
    "$SCRIPT_DIR/storage" \
    "$SCRIPT_DIR/config" \
    "$SCRIPT_DIR/runtime/sql"

chmod 775 "$SCRIPT_DIR/uploads" "$SCRIPT_DIR/storage"

log "Preparing database init scripts..."
sed \
    -e "s|__ADMIN_PASSWORD_HASH__|${ADMIN_PASSWORD_HASH}|g" \
    -e "s|__EPUSDT_AUTH__|${AUTH_TOKEN}|g" \
    -e "s|__EPUSDT_ADDRESS__|${CALLBACK_ADDRESS}|g" \
    "$SCRIPT_DIR/sql/dujiaoka-init.sql" > "$SCRIPT_DIR/runtime/sql/dujiaoka-init.sql"

sed \
    -e "s|__MYSQL_PASSWORD__|${MYSQL_PASSWORD}|g" \
    "$SCRIPT_DIR/sql/epusdt-init.sql" > "$SCRIPT_DIR/runtime/sql/epusdt-init.sql"

cat > "$SCRIPT_DIR/config/dujiaoka.env" <<EOF
APP_NAME=Dujiaoka
APP_ENV=production
APP_KEY=${APP_KEY}
APP_DEBUG=false
APP_URL=https://${MAIN_DOMAIN}

LOG_CHANNEL=stack

DB_CONNECTION=mysql
DB_HOST=db
DB_PORT=3306
DB_DATABASE=dujiaoka
DB_USERNAME=dujiaoka
DB_PASSWORD=${MYSQL_PASSWORD}

REDIS_HOST=redis
REDIS_PASSWORD=
REDIS_PORT=6379

BROADCAST_DRIVER=log
SESSION_DRIVER=file
SESSION_LIFETIME=120

CACHE_DRIVER=redis
QUEUE_CONNECTION=redis

DUJIAO_ADMIN_LANGUAGE=zh_CN
ADMIN_ROUTE_PREFIX=${ADMIN_ROUTE_PREFIX}
ADMIN_HTTPS=true
EOF

cat > "$SCRIPT_DIR/config/epusdt.env" <<EOF
app_name=epusdt
app_uri=https://usdt.${MAIN_DOMAIN}
app_debug=false
http_listen=:8000
static_path=/static
runtime_root_path=/runtime
log_save_path=/logs
log_max_size=32
log_max_age=7
max_backups=3
mysql_host=db
mysql_port=3306
mysql_user=epusdt
mysql_passwd=${MYSQL_PASSWORD}
mysql_database=epusdt
mysql_table_prefix=
mysql_max_idle_conns=10
mysql_max_open_conns=100
mysql_max_life_time=6
redis_host=redis
redis_port=6379
redis_passwd=
redis_db=5
redis_pool_size=5
redis_max_retries=3
redis_idle_timeout=1000
queue_concurrency=10
queue_level_critical=6
queue_level_default=3
queue_level_low=1
tg_bot_token=${BOT_TOKEN}
tg_proxy=
tg_manage=${ADMIN_TG_ID}
api_auth_token=${AUTH_TOKEN}
order_expiration_time=10
forced_usdt_rate=
EOF

chmod 640 "$SCRIPT_DIR/config/dujiaoka.env" "$SCRIPT_DIR/config/epusdt.env"

cat > "$SCRIPT_DIR/.env" <<EOF
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
MYSQL_PASSWORD=${MYSQL_PASSWORD}
SHOP_PORT=${SHOP_PORT}
EPUSDT_PORT=${EPUSDT_PORT}
EOF
chmod 600 "$SCRIPT_DIR/.env"

log "Starting Docker services..."
docker compose pull
docker compose up -d --wait 2>/dev/null || {
    docker compose up -d
    wait_for_container_health db 90
}

log "Finalizing Dujiaoka installation..."
docker compose exec -T web touch install.lock

log "Configuring Nginx reverse proxy..."
export MAIN_DOMAIN SHOP_PORT EPUSDT_PORT
envsubst '${MAIN_DOMAIN} ${SHOP_PORT} ${EPUSDT_PORT}' \
    < "$SCRIPT_DIR/nginx/dujiaoka.conf.template" \
    | sudo tee "/etc/nginx/sites-available/${NGINX_SITE_NAME}" >/dev/null

sudo ln -sf "/etc/nginx/sites-available/${NGINX_SITE_NAME}" "/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

CREDENTIALS_FILE="$SCRIPT_DIR/credentials.txt"
cat > "$CREDENTIALS_FILE" <<EOF
Dujiao-auto deployment credentials
Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

Shop URL:        https://${MAIN_DOMAIN}
EPUSDT URL:      https://usdt.${MAIN_DOMAIN}
Admin dashboard: https://${MAIN_DOMAIN}${ADMIN_ROUTE_PREFIX}
Admin username:  admin
Admin password:  ${ADMIN_PASSWORD_PLAIN}

MySQL password:  ${MYSQL_PASSWORD}
API auth token:  ${AUTH_TOKEN}
EOF
chmod 600 "$CREDENTIALS_FILE"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$SCRIPT_DIR/.installed"

log "Deployment completed."
echo
cat "$CREDENTIALS_FILE"
echo
log "Credentials saved to: $CREDENTIALS_FILE"
docker compose ps
