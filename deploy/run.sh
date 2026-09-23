#!/usr/bin/env bash
set -euo pipefail
umask 077
RUN_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUN_CURRENT="$RUN_SCRIPT_DIR/../whatsapp/current"
case "${1:-web}" in
  web|worker) ;;
  *) echo 'Pilihan: web | worker' >&2; exit 1 ;;
esac
if [[ ! -L "$RUN_CURRENT" ]]; then
  echo 'Build belum tersedia. Jalankan bash deploy/build.sh.' >&2
  exit 1
fi
cd -P -- "$RUN_CURRENT"
export NODE_ENV=production
export PATH="$PWD/node_modules/.bin:$PATH"
# The last restarted process can remove releases previously protected by the
# old WEB/WORKER cwd. This never stops another process or touches shared data.
node "$RUN_SCRIPT_DIR/whatsapp-release-cleanup.mjs" --quiet || true
case "${1:-web}" in
  web) exec node bin/server.js ;;
  worker) exec node ace.js whatsapp:listen ;;
esac
