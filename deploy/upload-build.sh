#!/usr/bin/env bash
# Unggah paket build ke GitHub Release yang sudah ada:
#   bash deploy/upload-build.sh 3.6.21 /path/wa-build-v3.6.21.tar.gz
# Dipanggil release.sh saat rilis; bisa dijalankan ulang bila unggahan pertama gagal.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
v="${1:-}"; asset="${2:-}"
[[ "$v" =~ ^3\.[0-9]+\.[0-9]+$ && -f "$asset" ]] || { echo 'Format: bash deploy/upload-build.sh 3.x.y FILE.tar.gz' >&2; exit 1; }
remote="$(git -C "$ROOT" remote get-url origin)"
repo="$(sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#' <<<"$remote")"
token="${GITHUB_TOKEN:-$(sed -nE 's#https://(x-access-token:)?([^@]+)@github\.com/.*#\2#p' <<<"$remote")}"
[[ -n "$token" ]] || { echo 'Tidak ada token GitHub.' >&2; exit 1; }
api() { curl -sS -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' "$@"; }
name="wa-build-v$v.tar.gz"
release="$(api "https://api.github.com/repos/$repo/releases/tags/v$v")"
rid="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("id",""))' "$release")"
[[ -n "$rid" ]] || { echo "Release v$v belum ada." >&2; exit 1; }
# Aset lama dengan nama sama dihapus dulu (unggah ulang).
for aid in $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print(" ".join(str(a["id"]) for a in r.get("assets",[]) if a["name"]==sys.argv[2]))' "$release" "$name"); do
  api -X DELETE "https://api.github.com/repos/$repo/releases/assets/$aid" >/dev/null || true
done
code="$(api -o /tmp/wa-asset.json -w '%{http_code}' -X POST -H 'Content-Type: application/gzip' \
  --data-binary @"$asset" "https://uploads.github.com/repos/$repo/releases/$rid/assets?name=$name")"
if [[ "$code" == 201 ]]; then echo "Paket build v$v diunggah ($(du -h "$asset" | cut -f1))."; else echo "Unggah paket build gagal ($code): $(head -c 200 /tmp/wa-asset.json)" >&2; exit 1; fi
