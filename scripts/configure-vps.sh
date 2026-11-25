#!/usr/bin/env bash
set -Eeuo pipefail

readonly SERVICE_NAME="simple-sync-obsidian"
readonly CONFIG_FILE="/etc/simple-sync-obsidian/config.env"

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Использование:
  sudo simple-sync-config --port 19432
  sudo simple-sync-config --bind 127.0.0.1
  sudo simple-sync-config --port 19432 --bind 0.0.0.0
  simple-sync-config --show
EOF
}

PORT=""
BIND=""
SHOW=false
while (($#)); do
  case "$1" in
    --port) [[ $# -ge 2 ]] || die "После --port нужен номер"; PORT="$2"; shift 2 ;;
    --bind) [[ $# -ge 2 ]] || die "После --bind нужен адрес"; BIND="$2"; shift 2 ;;
    --show) SHOW=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done

[[ -f "$CONFIG_FILE" ]] || die "Конфигурация не найдена: $CONFIG_FILE"
current_port="$(sed -n 's/^SIMPLE_SYNC_PORT=//p' "$CONFIG_FILE" | tail -n 1)"
current_bind="$(sed -n 's/^SIMPLE_SYNC_BIND=//p' "$CONFIG_FILE" | tail -n 1)"

if $SHOW; then
  printf 'SIMPLE_SYNC_PORT=%s\nSIMPLE_SYNC_BIND=%s\n' "$current_port" "$current_bind"
  exit 0
fi

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Для изменения запустите через sudo"
[[ -n "$PORT" || -n "$BIND" ]] || { usage; exit 1; }

PORT="${PORT:-$current_port}"
BIND="${BIND:-$current_bind}"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((10#$PORT >= 1024 && 10#$PORT <= 65535)) || die "Порт должен быть числом от 1024 до 65535"
[[ "$BIND" == "127.0.0.1" || "$BIND" == "0.0.0.0" ]] || die "Поддерживаются только 127.0.0.1 и 0.0.0.0"

if [[ "$PORT" != "$current_port" ]] && command -v ss >/dev/null 2>&1 && \
   ss -H -ltn | awk -v suffix=":$PORT" '$4 ~ (suffix "$") { found=1 } END { exit !found }'; then
  die "Порт $PORT уже занят"
fi

temporary="$(mktemp)"
trap 'rm -f "$temporary"' EXIT
printf 'SIMPLE_SYNC_PORT=%s\nSIMPLE_SYNC_BIND=%s\n' "$PORT" "$BIND" > "$temporary"
install -o root -g root -m 0644 "$temporary" "$CONFIG_FILE"
if [[ "$BIND" == "0.0.0.0" ]] && command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow "$PORT/tcp" >/dev/null
fi
systemctl restart "$SERVICE_NAME.service"

for attempt in {1..10}; do
  if curl --fail --silent --max-time 3 "http://127.0.0.1:$PORT/health" | grep -q '"status":"ok"'; then
    printf 'Готово: %s:%s\n' "$BIND" "$PORT"
    exit 0
  fi
  (( attempt < 10 )) && sleep 2
done
die "Новый порт сохранён, но /health не отвечает. Проверьте journalctl -u $SERVICE_NAME"

