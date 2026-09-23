#!/usr/bin/env bash
# Build & aktifkan WhatsApp (standalone maupun aaPanel).
#   bash deploy/build.sh [--verify-only] [--skip-init] [--no-restart] [--cleanup]
set -euo pipefail
DEPLOY_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js belum ada di PATH. Pasang Node.js 24+ terlebih dahulu (bash deploy/install.sh).' >&2
  exit 1
fi
exec node "$DEPLOY_SCRIPT_DIR/whatsapp-aapanel.mjs" "$@"
