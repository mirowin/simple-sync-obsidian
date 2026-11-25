#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICE_NAME="simple-sync-obsidian"
readonly DEFAULT_INSTALL_DIR="/opt/simple-sync-obsidian"
readonly CONFIG_DIR="/etc/simple-sync-obsidian"
readonly CONFIG_FILE="$CONFIG_DIR/config.env"
readonly DEFAULT_PORT=18787

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
REQUESTED_PORT=""
REQUESTED_BIND=""
CONFIG_ONLY=false
OPEN_FIREWALL=true

log() { printf '\n[%s] %s\n' "$SERVICE_NAME" "$*"; }
die() { printf '\n[%s] Ошибка: %s\n' "$SERVICE_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Настройка Simple Encrypted Sync на Debian/Ubuntu VPS.

Использование:
  sudo ./scripts/install-vps.sh [параметры]

Параметры:
  --port PORT           Внешний порт или auto (по умолчанию: первый свободный от 18787)
  --bind ADDRESS        127.0.0.1 (по умолчанию) или 0.0.0.0 для прямого доступа
  --install-dir PATH    Каталог установки (по умолчанию /opt/simple-sync-obsidian)
  --config-only         Не устанавливать Docker, использовать уже установленный
  --no-firewall         Не добавлять правило UFW при bind=0.0.0.0
  -h, --help            Показать справку

При повторном запуске без --port/--bind сохраняются текущие значения.
Конфигурация: /etc/simple-sync-obsidian/config.env
EOF
}

while (($#)); do
  case "$1" in
    --port) [[ $# -ge 2 ]] || die "После --port нужен номер или auto"; REQUESTED_PORT="$2"; shift 2 ;;
    --bind) [[ $# -ge 2 ]] || die "После --bind нужен адрес"; REQUESTED_BIND="$2"; shift 2 ;;
    --install-dir) [[ $# -ge 2 ]] || die "После --install-dir нужен путь"; INSTALL_DIR="$2"; shift 2 ;;
    --config-only) CONFIG_ONLY=true; shift ;;
    --no-firewall) OPEN_FIREWALL=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Запустите скрипт через sudo"
[[ "$INSTALL_DIR" == /* ]] || die "Каталог установки должен быть абсолютным"
[[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Каталог установки содержит недопустимые символы"
[[ "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "/opt" && "$INSTALL_DIR" != "/usr" && "$INSTALL_DIR" != "/etc" ]] || die "Слишком широкий каталог установки"
[[ -f "$SOURCE_DIR/docker-compose.yml" && -f "$SOURCE_DIR/server/server.mjs" && -f "$SOURCE_DIR/server/viewer.mjs" ]] || die "Запускайте скрипт из распакованного или клонированного репозитория"

read_config_value() {
  local key="$1"
  [[ -f "$CONFIG_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$CONFIG_FILE" | tail -n 1
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535))
}

validate_bind() {
  [[ "$1" == "127.0.0.1" || "$1" == "0.0.0.0" ]]
}

port_in_use() {
  local port="$1"
  command -v ss >/dev/null 2>&1 || return 1
  ss -H -ltn | awk -v suffix=":$port" '$4 ~ (suffix "$") { found=1 } END { exit !found }'
}

select_port() {
  local current_port candidate
  current_port="$(read_config_value SIMPLE_SYNC_PORT)"

  if [[ -z "$REQUESTED_PORT" && -n "$current_port" ]]; then
    validate_port "$current_port" || die "В $CONFIG_FILE указан некорректный порт"
    printf '%s' "$current_port"
    return
  fi

  if [[ -n "$REQUESTED_PORT" && "$REQUESTED_PORT" != "auto" ]]; then
    validate_port "$REQUESTED_PORT" || die "Порт должен быть числом от 1024 до 65535"
    if [[ "$REQUESTED_PORT" != "$current_port" ]] && port_in_use "$REQUESTED_PORT"; then
      die "Порт $REQUESTED_PORT уже занят"
    fi
    printf '%s' "$REQUESTED_PORT"
    return
  fi

  for ((candidate=DEFAULT_PORT; candidate<=DEFAULT_PORT+200; candidate++)); do
    if ! port_in_use "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
  die "Не найден свободный порт в диапазоне $DEFAULT_PORT-$((DEFAULT_PORT+200))"
}

select_bind() {
  local current_bind selected
  current_bind="$(read_config_value SIMPLE_SYNC_BIND)"
  if [[ -z "$REQUESTED_BIND" && -n "$current_bind" ]]; then
    validate_bind "$current_bind" || die "В $CONFIG_FILE указан некорректный bind-адрес"
    printf '%s' "$current_bind"
    return
  fi
  selected="${REQUESTED_BIND:-127.0.0.1}"
  validate_bind "$selected" || die "Поддерживаются только 127.0.0.1 и 0.0.0.0"
  printf '%s' "$selected"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker и Compose уже установлены"
    return
  fi
  $CONFIG_ONLY && die "Docker Compose не найден, а указан --config-only"

  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ;;
    *) die "Автоматическая установка Docker поддерживает Debian и Ubuntu" ;;
  esac
  [[ -n "${VERSION_CODENAME:-}" ]] || die "Не удалось определить кодовое имя дистрибутива"

  log "Устанавливаю Docker Engine из официального репозитория"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg iproute2
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  local architecture
  architecture="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$architecture" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_files() {
  log "Копирую сервер в $INSTALL_DIR"
  install -d -m 0755 "$INSTALL_DIR/server" "$INSTALL_DIR/examples" "$CONFIG_DIR"
  install -m 0644 "$SOURCE_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
  install -m 0644 "$SOURCE_DIR/server/Dockerfile" "$INSTALL_DIR/server/Dockerfile"
  install -m 0644 "$SOURCE_DIR/server/package.json" "$INSTALL_DIR/server/package.json"
  install -m 0644 "$SOURCE_DIR/server/package-lock.json" "$INSTALL_DIR/server/package-lock.json"
  install -m 0644 "$SOURCE_DIR/server/server.mjs" "$INSTALL_DIR/server/server.mjs"
  install -m 0644 "$SOURCE_DIR/server/viewer.mjs" "$INSTALL_DIR/server/viewer.mjs"
  install -m 0644 "$SOURCE_DIR/deploy/Caddyfile.example" "$INSTALL_DIR/examples/Caddyfile.example"
  install -m 0644 "$SOURCE_DIR/deploy/nginx.conf.example" "$INSTALL_DIR/examples/nginx.conf.example"
  install -m 0755 "$SOURCE_DIR/scripts/configure-vps.sh" /usr/local/sbin/simple-sync-config
}

write_config() {
  local port="$1" bind="$2" temporary
  temporary="$(mktemp)"
  printf 'SIMPLE_SYNC_PORT=%s\nSIMPLE_SYNC_BIND=%s\n' "$port" "$bind" > "$temporary"
  install -o root -g root -m 0644 "$temporary" "$CONFIG_FILE"
  rm -f "$temporary"
}

install_service() {
  log "Регистрирую systemd-службу $SERVICE_NAME"
  sed "s|@INSTALL_DIR@|$INSTALL_DIR|g" "$SOURCE_DIR/deploy/simple-sync-obsidian.service.in" \
    > "/etc/systemd/system/$SERVICE_NAME.service"
  chmod 0644 "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  systemctl enable docker.service
  systemctl enable "$SERVICE_NAME.service"
}

configure_firewall() {
  local bind="$1" port="$2"
  $OPEN_FIREWALL || return 0
  [[ "$bind" == "0.0.0.0" ]] || return 0
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    log "Открываю порт $port/tcp в UFW"
    ufw allow "$port/tcp" >/dev/null
  fi
  return 0
}

start_and_check() {
  local port="$1"
  log "Проверяю конфигурацию и запускаю сервер"
  cd "$INSTALL_DIR"
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
  docker compose config --quiet
  systemctl restart "$SERVICE_NAME.service"

  local health_url="http://127.0.0.1:$port/health"
  for attempt in {1..12}; do
    if curl --fail --silent --show-error --max-time 5 "$health_url" | grep -q '"status":"ok"'; then
      log "Сервер доступен локально: $health_url"
      return
    fi
    (( attempt < 12 )) && sleep 3
  done
  die "Служба запущена, но проверка /health не прошла. Выполните: journalctl -u $SERVICE_NAME -n 100"
}

install_docker
command -v ss >/dev/null 2>&1 || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y iproute2; }
systemctl enable --now docker.service

PORT="$(select_port)"
BIND="$(select_bind)"
install_files
write_config "$PORT" "$BIND"
install_service
configure_firewall "$BIND" "$PORT"
start_and_check "$PORT"

cat <<EOF

Готово.
  Адрес:       http://$BIND:$PORT
  Конфиг:      $CONFIG_FILE
  Служба:      $SERVICE_NAME.service
  Автозапуск:  включён

Смена порта:
  sudo simple-sync-config --port 19432

Управление:
  sudo systemctl status $SERVICE_NAME
  sudo systemctl restart $SERVICE_NAME
  sudo journalctl -u $SERVICE_NAME -f
EOF

if [[ "$BIND" == "127.0.0.1" ]]; then
  cat <<EOF

Сервер доступен только локально. Настройте существующий Nginx/Caddy как reverse proxy
на http://127.0.0.1:$PORT и используйте его HTTPS-адрес в плагине.
Примеры сохранены в $INSTALL_DIR/examples.
EOF
else
  cat <<EOF

Внимание: порт открыт наружу без TLS. Для постоянного использования рекомендуется
вернуть bind=127.0.0.1 и подключить HTTPS через reverse proxy.
EOF
fi

