#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

bash -n "$ROOT_DIR/scripts/install-vps.sh"
grep -q 'WantedBy=multi-user.target' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'After=docker.service network-online.target' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'ExecStart=/usr/bin/docker compose up -d --build --remove-orphans' "$ROOT_DIR/deploy/simple-sync-obsidian.service.in"
grep -q 'restart: unless-stopped' "$ROOT_DIR/docker-compose.yml"

echo "VPS installer checks passed"

