#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY="mirowin/simple-sync-obsidian"
readonly REF="${SIMPLE_SYNC_REF:-main}"

command -v curl >/dev/null 2>&1 || { printf 'Требуется curl\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf 'Требуется tar\n' >&2; exit 1; }

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
archive="$temporary/source.tar.gz"

curl_args=(--fail --silent --show-error --location)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  curl_args+=(--header "Authorization: Bearer $GITHUB_TOKEN")
fi

printf '[simple-sync-obsidian] Загружаю %s (%s)\n' "$REPOSITORY" "$REF"
curl "${curl_args[@]}" "https://api.github.com/repos/$REPOSITORY/tarball/$REF" --output "$archive"
mkdir -p "$temporary/source"
tar -xzf "$archive" -C "$temporary/source" --strip-components=1
chmod +x "$temporary/source/scripts/install-vps.sh" "$temporary/source/scripts/configure-vps.sh"
"$temporary/source/scripts/install-vps.sh" "$@"

