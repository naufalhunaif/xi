#!/usr/bin/env bash
# Rilis versi baru:  bash deploy/release.sh 3.0.1 [--notes "catatan"]
# Menulis whatsapp/VERSION, commit, tag v3.0.1, push branch + tag, lalu membuat
# GitHub Release lewat API (token dari GITHUB_TOKEN atau URL remote origin).
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
v="${1:-}"; notes="${3:-}"
[[ "$v" =~ ^3\.[0-9]+\.[0-9]+$ ]] || { echo 'Format: bash deploy/release.sh 3.x.y [--notes "..."]' >&2; exit 1; }
cd "$ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit dulu perubahan yang ada.' >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "Tag v$v sudah ada." >&2; exit 1; }
remote="$(git remote get-url origin)"
repo="$(sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#' <<<"$remote")"
token="${GITHUB_TOKEN:-$(sed -nE 's#https://[^:]+:([^@]+)@github\.com/.*#\1#p' <<<"$remote")}"
printf '%s\n' "$v" > whatsapp/VERSION
git add whatsapp/VERSION
git commit -q -m "Rilis v$v"
git tag -a "v$v" -m "WhatsApp v$v"
git push -q origin HEAD "v$v"
echo "Tag v$v dipush."
if [[ -n "$token" ]]; then
  body="$(python3 -c 'import json,sys; print(json.dumps({"tag_name":"v"+sys.argv[1],"name":"WhatsApp v"+sys.argv[1],"body":sys.argv[2],"generate_release_notes":sys.argv[2]==""}))' "$v" "$notes")"
  code="$(curl -sS -o /tmp/wa-release.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$repo/releases" -d "$body")"
  if [[ "$code" == 201 ]]; then echo "GitHub Release v$v dibuat."; else echo "Release API gagal ($code): $(head -c 300 /tmp/wa-release.json)" >&2; fi
else
  echo 'Tidak ada token GitHub; buat Release manual di GitHub bila perlu.'
fi
echo 'Server: wa update'
