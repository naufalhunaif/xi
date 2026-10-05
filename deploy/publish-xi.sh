#!/usr/bin/env bash
# Salin whatsapp/ + deploy/ dari repo pengembangan ini ke repo publik `xi`, commit, push.
#   bash deploy/publish-xi.sh            # sinkron saja
#   bash deploy/publish-xi.sh 3.0.1      # sinkron lalu rilis v3.0.1 (tag + GitHub Release)
# Lokasi clone xi: $XI_DIR (default ../xi di sebelah repo ini); dibuat otomatis bila belum ada.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
XI_DIR="${XI_DIR:-$ROOT/../xi}"
XI_URL="${XI_URL:-https://github.com/naufalhunaif/xi.git}"
v="${1:-}"
command -v rsync >/dev/null || { echo 'rsync diperlukan.' >&2; exit 1; }
if [[ ! -d "$XI_DIR/.git" ]]; then git clone -q "$XI_URL" "$XI_DIR"; fi
git -C "$XI_DIR" pull -q --ff-only origin main 2>/dev/null || true
# .github (workflow build aset) hanya ikut bila token punya scope `workflow` (WA_SYNC_GITHUB=1);
# tanpa scope itu GitHub menolak push berkas workflow.
dirs=(whatsapp deploy); [[ "${WA_SYNC_GITHUB:-}" == 1 ]] && dirs+=(.github)
for d in "${dirs[@]}"; do
  rsync -a --delete --include '.env.example' \
    --exclude node_modules --exclude build --exclude current --exclude .deploy --exclude storage \
    --exclude 'tmp/*' --exclude logs --exclude 'public/media' --exclude '.env' --exclude '.env.*' \
    --exclude .claude --exclude .codex --exclude .agents --exclude .mcp.json \
    "$ROOT/$d/" "$XI_DIR/$d/"
done
cp -f "$ROOT/whatsapp/.env.example" "$XI_DIR/whatsapp/.env.example"
cd "$XI_DIR"
git add -A "${dirs[@]}"
if git diff --cached --quiet; then echo 'xi sudah sinkron.'; else
  git -c user.name="$(git -C "$ROOT" log -1 --format=%an)" -c user.email="$(git -C "$ROOT" log -1 --format=%ae)" \
    commit -q -m "Sinkron dari alogaritm--app $(git -C "$ROOT" rev-parse --short HEAD)"
  git push -q origin HEAD:main
  echo "xi diperbarui."
fi
if [[ -n "$v" ]]; then
  # Build di mesin ini (cepat) → diunggah sebagai aset rilis; server tinggal unduh (lihat whatsapp-aapanel.mjs fetchPrebuilt).
  # Paket bisa juga disiapkan di luar (WA_BUILD_ASSET=/path/wa-build-v<ver>.tar.gz), mis. dibangun di mesin lain
  # bila node_modules di sini bukan untuk platform ini.
  # Bawaan: paket dibangun GitHub Actions (.github/workflows/wa-build-asset.yml) saat tag dipush.
  # Build lokal hanya bila WA_LOCAL_BUILD=1 (node_modules harus untuk platform ini & jaringan boleh ke uploads.github.com).
  asset="${WA_BUILD_ASSET:-}"
  if [[ -z "$asset" && "${WA_LOCAL_BUILD:-}" == 1 ]]; then
    tmp="$(mktemp -d)"
    if (cd "$ROOT/whatsapp" && rm -rf build && npm run build >"$tmp/build.log" 2>&1); then
      printf '%s\n' "$v" > "$ROOT/whatsapp/build/VERSION"
      tar -C "$ROOT/whatsapp" \
        --exclude='build/public/media' --exclude='build/storage' --exclude='build/tmp' \
        --exclude='build/.env' --exclude='build/.env.*' --exclude='build/tests' --exclude='build/node_modules' \
        -czf "$tmp/wa-build-v$v.tar.gz" build
      asset="$tmp/wa-build-v$v.tar.gz"
      echo "Paket build siap ($(du -h "$asset" | cut -f1))."
    else
      echo "Build lokal gagal (lihat $tmp/build.log); rilis tanpa paket build, server akan build sendiri." >&2
    fi
  fi
  WA_BUILD_ASSET="$asset" bash deploy/release.sh "$v"
fi
exit 0
