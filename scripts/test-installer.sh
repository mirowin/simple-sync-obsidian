#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

bash -n "$ROOT_DIR/scripts/install-vps.sh"
bash -n "$ROOT_DIR/scripts/configure-vps.sh"
bash -n "$ROOT_DIR/scripts/bootstrap-vps.sh"
grep -q 'WantedBy=multi-user.target' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'After=docker.service network-online.target' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'EnvironmentFile=/etc/simple-sync-obsidian/config.env' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'ExecStart=/usr/bin/docker compose up -d --build --remove-orphans' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'restart: unless-stopped' "$ROOT_DIR/docker-compose.yml"
grep -q '\${SIMPLE_SYNC_PORT:-18787}:8787' "$ROOT_DIR/docker-compose.yml"
! grep -Eq '"(80|443):(80|443)"' "$ROOT_DIR/docker-compose.yml"
grep -q 'DEFAULT_PORT=18787' "$ROOT_DIR/scripts/install-vps.sh"
grep -q 'simple-sync-config --port' "$ROOT_DIR/scripts/install-vps.sh"

echo "VPS installer checks passed"

