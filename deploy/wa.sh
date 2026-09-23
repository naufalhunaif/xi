#!/usr/bin/env bash
# =============================================================================
#  wa — perintah kendali WhatsApp standalone (mirip `bt` di aaPanel)
#    wa            menu interaktif
#    wa status | restart | stop | start | logs [web|worker]
#    wa update [VERSI] | rollback | version
#    wa domain DOMAIN | ssl | user [EMAIL] | backup | restore FILE | db
#    wa mode | uninstall
# =============================================================================
set -euo pipefail
CONF=/etc/wa/wa.conf
[[ "$EUID" == 0 ]] || { echo 'Jalankan sebagai root (sudo wa ...).' >&2; exit 1; }
[[ -f "$CONF" ]] || { echo "Konfigurasi $CONF tidak ada. Jalankan installer dulu." >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
APP="$WA_APP"; DIR="$WA_DIR"; U="$WA_USER"; MODE="$WA_MODE"; DOMAIN="$WA_DOMAIN"; PORT="${WA_PORT:-3333}"
export PATH="$WA_NODE_BIN:$PATH:/www/server/mysql/bin:/www/server/nginx/sbin:/usr/local/bin"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mGAGAL:\033[0m %s\n' "$*" >&2; exit 1; }
as_app() { # jalankan sebagai user aplikasi; proxy/CA dari lingkungan root ikut diteruskan bila ada
  local pass=(PATH="$PATH")
  for k in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
    [[ -n "${!k:-}" ]] && pass+=("$k=${!k}")
  done
  sudo -u "$U" -H env "${pass[@]}" "$@"
}
save_conf() { # save_conf KEY VALUE
  if grep -q "^$1=" "$CONF"; then sed -i "s|^$1=.*|$1=$2|" "$CONF"; else echo "$1=$2" >> "$CONF"; fi
}
current_version() { cat "$APP/whatsapp/VERSION" 2>/dev/null || echo '?'; }
git_ref() { git -C "$APP" describe --tags --exact-match 2>/dev/null || git -C "$APP" rev-parse --abbrev-ref HEAD; }

# ------------------------------------------------------------ supervisor -----
if [[ "$MODE" == aapanel && -f /www/server/panel/plugin/supervisor/supervisord.conf ]]; then
  SUP_CONF=/www/server/panel/plugin/supervisor/supervisord.conf
  SUP_DIR=/www/server/panel/plugin/supervisor/profile
  SUP_EXT=ini
  SUPCTL="$(command -v supervisorctl || echo /www/server/panel/pyenv/bin/supervisorctl)"
  [[ -x "$SUPCTL" ]] || SUPCTL=/www/server/panel/pyenv/bin/supervisorctl
else
  SUP_CONF=/etc/supervisor/supervisord.conf
  SUP_DIR=/etc/supervisor/conf.d
  SUP_EXT=conf
  SUPCTL="$(command -v supervisorctl || echo /usr/bin/supervisorctl)"
fi
export WHATSAPP_SUPERVISORCTL="$SUPCTL" WHATSAPP_SUPERVISOR_CONFIG="$SUP_CONF"
supctl() { "$SUPCTL" -c "$SUP_CONF" "$@"; }

supervisor_install() {
  [[ -x "$SUPCTL" && -f "$SUP_CONF" ]] || die "Supervisor tidak ditemukan ($SUP_CONF). aaPanel: pasang plugin Supervisor dulu."
  mkdir -p "$SUP_DIR"
  for role in web worker; do
    cat > "$SUP_DIR/wa-$role.$SUP_EXT" <<INI
[program:wa-$role]
command=/usr/bin/env bash $APP/deploy/run.sh $role
directory=$APP
user=$U
environment=HOME="$DIR",PATH="$WA_NODE_BIN:/usr/local/bin:/usr/bin:/bin"
autostart=true
autorestart=true
startsecs=5
stopwaitsecs=30
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/wa/$role.log
stderr_logfile=/var/log/wa/$role.err.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=5
INI
  done
  supctl reread >/dev/null && supctl update >/dev/null || true
}

# ----------------------------------------------------------------- nginx -----
render() { # render TEMPLATE -> stdout
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" -e "s|__APP_DIR__|$APP|g" \
      -e "s|__SSL_CERT__|${SSL_CERT:-}|g" -e "s|__SSL_KEY__|${SSL_KEY:-}|g" "$1"
}
selfsigned() {
  mkdir -p /etc/wa/ssl
  if [[ ! -f /etc/wa/ssl/selfsigned.crt ]]; then
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -subj "/CN=$DOMAIN" \
      -keyout /etc/wa/ssl/selfsigned.key -out /etc/wa/ssl/selfsigned.crt >/dev/null 2>&1
  fi
}
nginx_reload() { nginx -t >/dev/null 2>&1 && (systemctl reload nginx 2>/dev/null || nginx -s reload); }
nginx_write_bare() {
  local le="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  if [[ -f "$le" ]]; then SSL_CERT="$le"; SSL_KEY="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  else selfsigned; SSL_CERT=/etc/wa/ssl/selfsigned.crt; SSL_KEY=/etc/wa/ssl/selfsigned.key; fi
  render "$APP/deploy/nginx-wa-locations.conf.tpl" > "$APP/deploy/nginx-wa-locations.conf"
  render "$APP/deploy/nginx-wa.conf.tpl" > /etc/nginx/sites-available/wa.conf
  # Server tanpa IPv6: buang baris listen [::].
  [[ -f /proc/net/if_inet6 ]] || sed -i '/listen \[::\]/d' /etc/nginx/sites-available/wa.conf
  ln -sf /etc/nginx/sites-available/wa.conf /etc/nginx/sites-enabled/wa.conf
  rm -f /etc/nginx/sites-enabled/default
  mkdir -p /var/www/html
  nginx -t || die 'Konfigurasi Nginx tidak valid.'
  nginx_reload
}
nginx_write_aapanel() {
  local vhost="/www/server/panel/vhost/nginx/$DOMAIN.conf"
  [[ -f "$vhost" ]] || die "Website $DOMAIN belum ada di aaPanel. Buat dulu di menu Website, lalu ulangi."
  render "$APP/deploy/nginx-wa-locations.conf.tpl" > "$APP/deploy/nginx-wa-locations.conf"
  local line="    include $APP/deploy/nginx-wa-locations.conf;"
  if ! grep -qF "$line" "$vhost"; then
    cp "$vhost" "$vhost.bak-wa"
    # Sisipkan sebelum location pertama supaya mendahului aturan PHP/statis aaPanel.
    awk -v ins="$line" 'BEGIN{d=0} /^[[:space:]]*location/ && !d {print ins; d=1} {print} END{if(!d) print ins}' \
      "$vhost.bak-wa" > "$vhost"
  fi
  nginx -t || { cp "$vhost.bak-wa" "$vhost"; die 'Konfigurasi Nginx aaPanel tidak valid; dikembalikan.'; }
  nginx_reload
}
nginx_install() { if [[ "$MODE" == aapanel ]]; then nginx_write_aapanel; else nginx_write_bare; fi; }

# ------------------------------------------------------------------ ssl ------
public_ip() { curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true; }
dns_ok() {
  local ip; ip="$(public_ip)"
  [[ -n "$ip" ]] || return 0
  getent ahostsv4 "$DOMAIN" | awk '{print $1}' | grep -qx "$ip"
}
ssl_issue() {
  [[ "$MODE" == bare ]] || { echo "aaPanel: aktifkan SSL untuk $DOMAIN di menu Website aaPanel."; return 0; }
  if ! dns_ok; then
    warn "DNS $DOMAIN belum mengarah ke IP server ini ($(public_ip)). Arahkan A record lalu jalankan: wa ssl"
    return 1
  fi
  say "Meminta sertifikat Let's Encrypt untuk $DOMAIN"
  certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$WA_EMAIL" --keep-until-expiring \
    || return 1
  nginx_write_bare
  say 'SSL aktif.'
}

# ---------------------------------------------------------------- build ------
build() { # build [--first]
  cd "$APP"
  # Build sebagai user aplikasi tanpa menyentuh proses; restart dilakukan root lewat Supervisor.
  as_app bash deploy/build.sh --no-restart
  supctl reread >/dev/null; supctl update >/dev/null || true
  supctl restart wa-web wa-worker >/dev/null 2>&1 || supctl start wa-web wa-worker >/dev/null
  sleep 3
  # Pembersihan release lama perlu membaca /proc semua user, jadi dijalankan root.
  node deploy/whatsapp-aapanel.mjs --cleanup >/dev/null 2>&1 || true
  supctl status wa-web wa-worker || true
}

# --------------------------------------------------------------- update ------
git_url() {
  if [[ -n "${WA_TOKEN:-}" ]]; then echo "https://x-access-token:${WA_TOKEN}@github.com/${WA_REPO}.git"
  else echo "https://github.com/${WA_REPO}.git"; fi
}
fetch_all() {
  as_app git -C "$APP" remote set-url origin "$(git_url)"
  as_app git -C "$APP" fetch -q --tags --prune origin
}
latest_tag() { git -C "$APP" tag -l 'v3.*' | sort -V | tail -n1; }
checkout_ref() {
  local ref="$1"
  if git -C "$APP" show-ref -q --verify "refs/tags/$ref"; then
    as_app git -C "$APP" checkout -q --detach "tags/$ref"
  elif git -C "$APP" show-ref -q --verify "refs/remotes/origin/$ref"; then
    as_app git -C "$APP" checkout -q -B "$ref" "origin/$ref"
  else
    die "Versi/branch '$ref' tidak ditemukan."
  fi
  chmod +x "$APP"/deploy/*.sh
}
update() {
  local before target
  before="$(git_ref)"
  fetch_all
  target="${1:-$(latest_tag)}"
  [[ -n "$target" ]] || die 'Belum ada rilis v3.x. Sebutkan branch: wa update main'
  if [[ -z "${1:-}" && "$target" == "$before" ]]; then
    say "Sudah versi terbaru ($target)."; return 0
  fi
  save_conf WA_PREVIOUS "$before"
  say "Memperbarui $before -> $target"
  checkout_ref "$target"
  build
  say "Versi aktif: $(current_version) ($(git_ref))"
}
rollback() {
  local prev="${WA_PREVIOUS:-}"
  [[ -n "$prev" ]] || die 'Belum ada versi sebelumnya yang tercatat.'
  say "Kembali ke $prev"
  fetch_all; save_conf WA_PREVIOUS "$(git_ref)"; checkout_ref "$prev"; build
}

# ---------------------------------------------------------------- backup -----
backup() {
  local quiet="${1:-}" stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"; out="$DIR/backups/wa-$stamp"
  mkdir -p "$out"
  MYSQL_PWD="$WA_DB_PASS" mysqldump -u"$WA_DB_USER" --single-transaction --routines "$WA_DB_NAME" | gzip > "$out/db.sql.gz"
  tar -C "$APP/whatsapp" -czf "$out/data.tar.gz" storage public/media .env 2>/dev/null || true
  tar -C "$DIR/backups" -czf "$out.tar.gz" "wa-$stamp" && rm -rf "$out"
  chown "$U:$U" "$out.tar.gz"; chmod 600 "$out.tar.gz"; chmod 700 "$DIR/backups"
  find "$DIR/backups" -name 'wa-*.tar.gz' -mtime +7 -delete
  [[ "$quiet" == --quiet ]] || say "Backup: $out.tar.gz"
}
restore() {
  local file="$1" tmp
  [[ -f "$file" ]] || die "File $file tidak ada."
  tmp="$(mktemp -d)"; tar -C "$tmp" -xzf "$file"
  local src; src="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -n1)"
  say 'Menghentikan proses'; supctl stop wa-web wa-worker >/dev/null || true
  say 'Memulihkan database'
  gunzip -c "$src/db.sql.gz" | MYSQL_PWD="$WA_DB_PASS" mysql -u"$WA_DB_USER" "$WA_DB_NAME"
  say 'Memulihkan storage/media'
  tar -C "$APP/whatsapp" -xzf "$src/data.tar.gz" --exclude=.env
  chown -R "$U:$U" "$APP/whatsapp/storage" "$APP/whatsapp/public/media"
  rm -rf "$tmp"
  supctl start wa-web wa-worker >/dev/null || true
  say 'Selesai.'
}

# ------------------------------------------------------------- lainnya -------
status() {
  echo "Versi   : $(current_version) ($(git_ref))"
  echo "Mode    : $MODE · folder $APP"
  echo "Domain  : https://$DOMAIN (port lokal $PORT)"
  echo "Node    : $(node -v 2>/dev/null || echo '-')"
  supctl status wa-web wa-worker 2>/dev/null || warn 'Supervisor belum berjalan.'
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/login"; then echo 'WEB     : merespons'; else echo 'WEB     : tidak merespons'; fi
}
user_reset() {
  local email="${1:-}"
  if [[ -z "$email" ]]; then read -r -p 'Email akun: ' email < /dev/tty; fi
  [[ -n "$email" ]] || die 'Email wajib diisi.'
  [[ -d "$APP/whatsapp/current" ]] || die 'Build belum ada. Jalankan: wa update'
  (cd -P "$APP/whatsapp/current" && as_app env NODE_ENV=production node ace.js auth:reset "$email")
}
set_domain() {
  local new="$1"
  [[ "$new" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die 'Domain tidak valid.'
  DOMAIN="$new"; save_conf WA_DOMAIN "$new"
  sed -i "s|^APP_URL=.*|APP_URL=https://$new|" "$APP/whatsapp/.env"
  nginx_install
  supctl restart wa-web wa-worker >/dev/null || true
  say "Domain diganti ke https://$new"
  [[ "$MODE" == bare ]] && ssl_issue || true
}
uninstall() {
  read -r -p "Hapus WhatsApp dari server ini? Database dan media ikut dihapus. Ketik 'HAPUS' untuk lanjut: " ok < /dev/tty
  [[ "$ok" == HAPUS ]] || { echo 'Dibatalkan.'; return 0; }
  backup || true
  supctl stop wa-web wa-worker >/dev/null 2>&1 || true
  rm -f "$SUP_DIR/wa-web.$SUP_EXT" "$SUP_DIR/wa-worker.$SUP_EXT"; supctl reread >/dev/null 2>&1; supctl update >/dev/null 2>&1 || true
  if [[ "$MODE" == bare ]]; then rm -f /etc/nginx/sites-enabled/wa.conf /etc/nginx/sites-available/wa.conf; nginx_reload || true
  else local v="/www/server/panel/vhost/nginx/$DOMAIN.conf"; [[ -f "$v" ]] && sed -i "\|nginx-wa-locations.conf|d" "$v"; nginx_reload || true; fi
  MYSQL_PWD="$WA_DB_PASS" mysql -u"$WA_DB_USER" -e "DROP DATABASE IF EXISTS \`$WA_DB_NAME\`" 2>/dev/null || true
  rm -f /etc/cron.d/wa-backup /usr/local/bin/wa
  say "Kode dan data ada di $DIR (backup terakhir di $DIR/backups). Hapus manual bila sudah tidak perlu: rm -rf $DIR /etc/wa"
}
menu() {
  while true; do
    cat <<M

  WhatsApp v$(current_version) · $DOMAIN · $MODE
  ─────────────────────────────────────────────
   1) Status              7) Ganti domain
   2) Restart             8) Perbarui SSL
   3) Update ke rilis terbaru
   4) Rollback versi      9) Backup sekarang
   5) Log WEB            10) Restore backup
   6) Log WORKER         11) Reset password user
                         12) Shell database
                          0) Keluar
M
    read -r -p '  Pilih nomor: ' n < /dev/tty
    case "$n" in
      1) status ;; 2) supctl restart wa-web wa-worker ;; 3) update ;; 4) rollback ;;
      5) tail -n 100 -f /var/log/wa/web.log ;; 6) tail -n 100 -f /var/log/wa/worker.log ;;
      7) read -r -p '  Domain baru: ' d < /dev/tty; set_domain "$d" ;; 8) ssl_issue ;;
      9) backup ;; 10) read -r -p '  File backup: ' f < /dev/tty; restore "$f" ;;
      11) user_reset ;; 12) MYSQL_PWD="$WA_DB_PASS" mysql -u"$WA_DB_USER" "$WA_DB_NAME" ;;
      0|q|'') return 0 ;; *) echo '  Pilihan tidak dikenal.' ;;
    esac
  done
}

case "${1:-menu}" in
  menu) menu ;;
  status) status ;;
  start) supctl start wa-web wa-worker ;;
  stop) supctl stop wa-web wa-worker ;;
  restart) supctl restart wa-web wa-worker ;;
  logs|log) tail -n 100 -f "/var/log/wa/${2:-worker}.log" ;;
  update) update "${2:-}" ;;
  rollback) rollback ;;
  version) echo "$(current_version) ($(git_ref))" ;;
  domain) [[ -n "${2:-}" ]] || die 'wa domain DOMAIN'; set_domain "$2" ;;
  ssl) ssl_issue ;;
  user) user_reset "${2:-}" ;;
  backup) backup "${2:-}" ;;
  restore) [[ -n "${2:-}" ]] || die 'wa restore FILE.tar.gz'; restore "$2" ;;
  db) MYSQL_PWD="$WA_DB_PASS" mysql -u"$WA_DB_USER" "$WA_DB_NAME" ;;
  mode) echo "$MODE (supervisor: $SUP_CONF)" ;;
  uninstall) uninstall ;;
  _supervisor-install) supervisor_install ;;
  _nginx-install) nginx_install ;;
  _build) build "${2:-}" ;;
  help|-h|--help) sed -n 2,10p "$0" ;;
  *) die "Perintah '$1' tidak dikenal. Lihat: wa help" ;;
esac
