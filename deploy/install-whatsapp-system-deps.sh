#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  --help) echo 'sudo bash deploy/install-whatsapp-system-deps.sh [--dry-run]'; exit 0 ;;
  ''|--dry-run) ;;
  *) echo 'Opsi tidak dikenal.' >&2; exit 1 ;;
esac
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Khusus Linux aaPanel. Tidak mengubah dependency Mac/XAMPP.' >&2
  exit 1
fi
install_step() {
  if [[ "${1:-}" == '' ]]; then return; fi
  if [[ "$SYSTEM_DEPS_DRY_RUN" == 1 ]]; then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}
SYSTEM_DEPS_DRY_RUN=0
[[ "${1:-}" == --dry-run ]] && SYSTEM_DEPS_DRY_RUN=1
if [[ "$EUID" != 0 && "$SYSTEM_DEPS_DRY_RUN" != 1 ]]; then
  echo 'Jalankan dengan sudo untuk paket OS. Build aplikasi dijalankan sebagai user aplikasi, bukan root.' >&2
  exit 1
fi
if command -v apt-get >/dev/null 2>&1; then
  install_step apt-get update
  install_step apt-get install -y --no-install-recommends ca-certificates git build-essential python3 pkg-config libstdc++6 xz-utils
elif command -v dnf >/dev/null 2>&1; then
  install_step dnf install -y ca-certificates git gcc gcc-c++ make python3 pkgconf-pkg-config libstdc++ xz
elif command -v yum >/dev/null 2>&1; then
  install_step yum install -y ca-certificates git gcc gcc-c++ make python3 pkgconfig libstdc++ xz
else
  echo 'Distro tidak didukung otomatis. Siapkan git, CA certificates, compiler C/C++, make, python3, pkg-config, libstdc++, dan xz.' >&2
  exit 1
fi
echo 'Pilih Node.js 24+ di aaPanel. Skrip ini tidak memasang/mengganti Node, PHP, MySQL, atau Nginx.'
