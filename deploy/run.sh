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
  worker)
    # Proses nomor tambahan yang tertinggal dari worker lama (worker lama dimatikan paksa / timeout
    # Supervisor) masih memegang sesi nomornya → proses baru dan lama saling tendang (reconnect terus).
    # Matikan yang cwd-nya di bawah folder aplikasi ini saja.
    WA_ROOT="$(cd -P -- "$RUN_SCRIPT_DIR/../whatsapp" && pwd -P)"
    for pid in $(pgrep -f "ace.js whatsapp:listen --line=" 2>/dev/null || true); do
      [[ "$pid" == "$$" ]] && continue
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      [[ -n "$cwd" && "$cwd" == "$WA_ROOT/"* ]] && kill -TERM "$pid" 2>/dev/null || true
    done
    exec node ace.js whatsapp:listen ;;
esac
