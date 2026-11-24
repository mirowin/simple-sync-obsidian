#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICE_NAME="simple-sync-obsidian"
readonly DEFAULT_INSTALL_DIR="/opt/simple-sync-obsidian"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
DOMAIN=""
CONFIG_ONLY=false
OPEN_FIREWALL=true

log() { printf '\n[%s] %s\n' "$SERVICE_NAME" "$*"; }
die() { printf '\n[%s] Ошибка: %s\n' "$SERVICE_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Настройка Simple Encrypted Sync на Debian/Ubuntu VPS.

Использование:
  sudo ./scripts/install-vps.sh --domain sync.example.com [параметры]

Параметры:
  --domain DOMAIN       Домен с A/AAAA-записью на этот VPS (обязательно)
  --install-dir PATH    Каталог установки (по умолчанию /opt/simple-sync-obsidian)
  --config-only         Не устанавливать Docker, использовать уже установленный
  --no-firewall         Не добавлять правила UFW для 80/443
  -h, --help            Показать справку

Скрипт можно запускать повторно для обновления установки.
EOF
}

while (($#)); do
  case "$1" in
    --domain) [[ $# -ge 2 ]] || die "После --domain нужен адрес"; DOMAIN="$2"; shift 2 ;;
    --install-dir) [[ $# -ge 2 ]] || die "После --install-dir нужен путь"; INSTALL_DIR="$2"; shift 2 ;;
    --config-only) CONFIG_ONLY=true; shift ;;
    --no-firewall) OPEN_FIREWALL=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Запустите скрипт через sudo"
[[ -n "$DOMAIN" ]] || die "Укажите домен: --domain sync.example.com"
[[ "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || die "Некорректный домен: $DOMAIN"
[[ "$DOMAIN" == *.* ]] || die "Нужен полный домен, например sync.example.com"
[[ "$INSTALL_DIR" == /* ]] || die "Каталог установки должен быть абсолютным"
[[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Каталог установки содержит недопустимые символы"
[[ "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "/opt" && "$INSTALL_DIR" != "/usr" && "$INSTALL_DIR" != "/etc" ]] || die "Слишком широкий каталог установки"
[[ -f "$SOURCE_DIR/docker-compose.yml" && -f "$SOURCE_DIR/server/server.mjs" ]] || die "Запускайте скрипт из клонированного репозитория"

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
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
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
  install -d -m 0755 "$INSTALL_DIR/server"
  install -m 0644 "$SOURCE_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
  install -m 0644 "$SOURCE_DIR/Caddyfile" "$INSTALL_DIR/Caddyfile"
  install -m 0644 "$SOURCE_DIR/server/Dockerfile" "$INSTALL_DIR/server/Dockerfile"
  install -m 0644 "$SOURCE_DIR/server/package.json" "$INSTALL_DIR/server/package.json"
  install -m 0644 "$SOURCE_DIR/server/package-lock.json" "$INSTALL_DIR/server/package-lock.json"
  install -m 0644 "$SOURCE_DIR/server/server.mjs" "$INSTALL_DIR/server/server.mjs"
  printf 'SYNC_DOMAIN=%s\n' "$DOMAIN" > "$INSTALL_DIR/.env"
  chmod 0600 "$INSTALL_DIR/.env"
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
  $OPEN_FIREWALL || return
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    log "Открываю HTTP/HTTPS в UFW"
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
  fi
}

start_and_check() {
  log "Проверяю конфигурацию и запускаю сервер"
  cd "$INSTALL_DIR"
  docker compose config --quiet
  systemctl restart "$SERVICE_NAME.service"

  local health_url="https://$DOMAIN/health"
  for attempt in {1..12}; do
    if curl --fail --silent --show-error --max-time 10 "$health_url" | grep -q '"status":"ok"'; then
      log "Сервер доступен: $health_url"
      return
    fi
    (( attempt < 12 )) && sleep 5
  done

  printf '\nСлужба запущена, но HTTPS-проверка пока не прошла. Проверьте DNS и журналы:\n' >&2
  printf '  systemctl status %s\n' "$SERVICE_NAME" >&2
  printf '  journalctl -u %s -f\n' "$SERVICE_NAME" >&2
  printf '  docker compose -f %s/docker-compose.yml logs -f\n' "$INSTALL_DIR" >&2
}

install_docker
systemctl enable --now docker.service
install_files
install_service
configure_firewall
start_and_check

cat <<EOF

Готово.
  Сервер:       https://$DOMAIN
  Просмотрщик:  https://$DOMAIN/view/<vault-id>/
  Служба:       $SERVICE_NAME.service
  Автозапуск:   включён

Управление:
  sudo systemctl status $SERVICE_NAME
  sudo systemctl restart $SERVICE_NAME
  sudo journalctl -u $SERVICE_NAME -f
EOF

