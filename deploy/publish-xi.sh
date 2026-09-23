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
for d in whatsapp deploy; do
  rsync -a --delete --include '.env.example' \
    --exclude node_modules --exclude build --exclude current --exclude .deploy --exclude storage \
    --exclude 'tmp/*' --exclude logs --exclude 'public/media' --exclude '.env' --exclude '.env.*' \
    --exclude .claude --exclude .codex --exclude .agents --exclude .mcp.json \
    "$ROOT/$d/" "$XI_DIR/$d/"
done
cp -f "$ROOT/whatsapp/.env.example" "$XI_DIR/whatsapp/.env.example"
cd "$XI_DIR"
git add -A whatsapp deploy
if git diff --cached --quiet; then echo 'xi sudah sinkron.'; else
  git commit -q -m "Sinkron dari alogaritm--app $(git -C "$ROOT" rev-parse --short HEAD)"
  git push -q origin HEAD:main
  echo "xi diperbarui."
fi
[[ -n "$v" ]] && bash deploy/release.sh "$v"
exit 0
