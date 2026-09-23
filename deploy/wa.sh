#!/usr/bin/env bash
# =============================================================================
#  wa — perintah kendali WhatsApp standalone (mirip `bt` di aaPanel)
#    wa            menu interaktif
#    wa status | restart | stop | start | logs [web|worker]
#    wa update [VERSI] | rollback | version
#    wa domain DOMAIN | domain --lepas | port NOMOR | ssl | user [EMAIL] | backup | restore FILE | db
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
step() { printf '\033[1;32m[%3d%%]\033[0m %s\n' "$1" "$2"; }   # step 40 "Membangun aplikasi"
BUILD_LOG=/var/log/wa/build.log
run_logged() { # run_logged "label" cmd... — jalankan diam-diam, tampilkan log hanya bila gagal
  local label="$1"; shift
  mkdir -p "$(dirname "$BUILD_LOG")"
  { printf '\n===== %s · %s =====\n' "$(date '+%F %T')" "$label"; "$@"; } >>"$BUILD_LOG" 2>&1 &
  local pid=$! t=0
  while kill -0 "$pid" 2>/dev/null; do sleep 2; t=$((t + 2)); printf '\r       %s… %ds' "$label" "$t"; done
  printf '\r\033[K'
  if ! wait "$pid"; then
    printf '\033[1;31mGAGAL:\033[0m %s. 30 baris log terakhir (%s):\n' "$label" "$BUILD_LOG" >&2
    tail -n 30 "$BUILD_LOG" >&2
    exit 1
  fi
}
as_app() { # jalankan sebagai user aplikasi; proxy/CA dari lingkungan root ikut diteruskan bila ada
  # Cache npm milik user aplikasi (aaPanel mengarahkan cache global ke folder milik root).
  local pass=(PATH="$PATH" npm_config_cache="$DIR/.npm" HOME="$DIR")
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
# Cari konfigurasi Supervisor: plugin aaPanel, /etc/supervisord.conf, atau paket Debian.
SUP_CONF=''
for c in "${WHATSAPP_SUPERVISOR_CONFIG:-}" /www/server/panel/plugin/supervisor/supervisord.conf \
         /etc/supervisord.conf /etc/supervisor/supervisord.conf; do
  [[ -n "$c" && -f "$c" ]] && { SUP_CONF="$c"; break; }
done
SUPCTL=''
for c in "${WHATSAPP_SUPERVISORCTL:-}" "$(command -v supervisorctl 2>/dev/null || true)" \
         /www/server/panel/pyenv/bin/supervisorctl /usr/bin/supervisorctl /usr/local/bin/supervisorctl; do
  [[ -n "$c" && -x "$c" ]] && { SUPCTL="$c"; break; }
done
# Folder program: dari baris "files = .../*.ini" pada [include]; cadangan conf.d.
SUP_DIR=''; SUP_EXT=conf
if [[ -n "$SUP_CONF" ]]; then
  inc="$(sed -nE 's/^[[:space:]]*files[[:space:]]*=[[:space:]]*([^[:space:];#]+).*/\1/p' "$SUP_CONF" | head -n1)"
  if [[ -n "$inc" ]]; then
    SUP_DIR="$(dirname "$inc")"; [[ "$SUP_DIR" = /* ]] || SUP_DIR="$(dirname "$SUP_CONF")/$SUP_DIR"
    case "$inc" in *.ini) SUP_EXT=ini ;; *.conf) SUP_EXT=conf ;; esac
  fi
fi
[[ -n "$SUP_DIR" ]] || SUP_DIR=/etc/supervisor/conf.d
export WHATSAPP_SUPERVISORCTL="$SUPCTL" WHATSAPP_SUPERVISOR_CONFIG="$SUP_CONF"
supctl() { "$SUPCTL" -c "$SUP_CONF" "$@"; }

supervisor_install() {
  [[ -n "$SUP_CONF" && -n "$SUPCTL" ]] || die "Supervisor tidak ditemukan (conf: ${SUP_CONF:-tidak ada}, supervisorctl: ${SUPCTL:-tidak ada}). Pasang plugin Supervisor di aaPanel atau: apt-get install supervisor"
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
nginx_reload() { nginx -t >/dev/null 2>&1 && (systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1); }
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
  nginx -t >/dev/null 2>&1 || { nginx -t; die 'Konfigurasi Nginx tidak valid.'; }
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
  nginx -t >/dev/null 2>&1 || { nginx -t; cp "$vhost.bak-wa" "$vhost"; die 'Konfigurasi Nginx aaPanel tidak valid; dikembalikan.'; }
  nginx_reload
}
nginx_install() { [[ -n "$DOMAIN" ]] || die 'Belum ada domain.'; if [[ "$MODE" == aapanel ]]; then nginx_write_aapanel; else nginx_write_bare; fi; }

# ------------------------------------------------------------------ ssl ------
public_ip() { curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true; }
dns_ok() {
  local ip; ip="$(public_ip)"
  [[ -n "$ip" ]] || return 0
  getent ahostsv4 "$DOMAIN" | awk '{print $1}' | grep -qx "$ip"
}
ssl_issue() {
  [[ -n "$DOMAIN" ]] || die 'Belum ada domain. Pasang dulu: wa domain nama-domain.com'
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
  step 30 'Mengunduh dependensi & membangun aplikasi (beberapa menit)'
  # Build sebagai user aplikasi tanpa menyentuh proses; restart dilakukan root lewat Supervisor.
  run_logged 'Build' as_app bash deploy/build.sh --no-restart
  step 80 'Menyalakan ulang WEB & WORKER'
  supctl reread >/dev/null; supctl update >/dev/null || true
  supctl restart wa-web wa-worker >/dev/null 2>&1 || supctl start wa-web wa-worker >/dev/null
  sleep 3
  # Pembersihan release lama perlu membaca /proc semua user, jadi dijalankan root.
  node deploy/whatsapp-aapanel.mjs --cleanup >/dev/null 2>&1 || true
  local st; st="$(supctl status wa-web wa-worker 2>/dev/null || true)"
  if [[ "$(grep -c RUNNING <<<"$st")" == 2 ]]; then
    step 100 "Selesai · WhatsApp v$(current_version) berjalan"
  else
    warn 'Proses belum RUNNING semua:'; echo "$st"; echo "Log: wa logs web | wa logs worker"
  fi
}

# --------------------------------------------------------------- update ------
git_url() {
  if [[ -n "${WA_TOKEN:-}" ]]; then echo "https://x-access-token:${WA_TOKEN}@github.com/${WA_REPO}.git"
  else echo "https://github.com/${WA_REPO}.git"; fi
}
fetch_all() {
  as_app git -C "$APP" remote set-url origin "$(git_url)"
  as_app git -C "$APP" fetch -q --tags --prune origin 2>/dev/null
}
latest_tag() { git -C "$APP" tag -l 'v3.*' | sort -V | tail -n1; }
checkout_ref() {
  local ref="$1"
  if git -C "$APP" show-ref -q --verify "refs/tags/$ref"; then
    as_app git -C "$APP" checkout -q -f --detach "tags/$ref" 2>/dev/null
  elif git -C "$APP" show-ref -q --verify "refs/remotes/origin/$ref"; then
    as_app git -C "$APP" checkout -q -f -B "$ref" "origin/$ref" 2>/dev/null
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
  step 10 "Memperbarui $before → $target"
  checkout_ref "$target"
  # Skrip ini sendiri ikut diperbarui; lanjutkan dengan versi yang baru.
  exec bash "$APP/deploy/wa.sh" _post-update
}
post_update() {
  step 20 'Kode terbaru siap'
  # Aturan sudo untuk pengaturan domain dari halaman Pengaturan (pemasangan lama belum punya).
  if [[ ! -f /etc/sudoers.d/wa ]]; then
    printf '%s ALL=(root) NOPASSWD: /usr/local/bin/wa domain *\n' "$U" > /etc/sudoers.d/wa; chmod 440 /etc/sudoers.d/wa
  fi
  build
}
rollback() {
  local prev="${WA_PREVIOUS:-}"
  [[ -n "$prev" ]] || die 'Belum ada versi sebelumnya yang tercatat.'
  step 10 "Kembali ke $prev"
  fetch_all; save_conf WA_PREVIOUS "$(git_ref)"; checkout_ref "$prev"
  exec bash "$APP/deploy/wa.sh" _post-update
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
  echo "Alamat  : $(app_url)${DOMAIN:+ (domain $DOMAIN)} · port $PORT"
  echo "Node    : $(node -v 2>/dev/null || echo '-')"
  supctl status wa-web wa-worker 2>/dev/null || [[ -S /var/run/supervisor.sock ]] || warn 'Supervisor belum berjalan.'
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/login"; then echo 'WEB     : merespons'; else echo 'WEB     : tidak merespons'; fi
}
user_reset() {
  local email="${1:-}"
  if [[ -z "$email" ]]; then read -r -p 'Email akun: ' email < /dev/tty; fi
  [[ -n "$email" ]] || die 'Email wajib diisi.'
  [[ -d "$APP/whatsapp/current" ]] || die 'Build belum ada. Jalankan: wa update'
  (cd -P "$APP/whatsapp/current" && as_app env NODE_ENV=production node ace.js auth:reset "$email")
}
app_url() { sed -n 's/^APP_URL=//p' "$APP/whatsapp/.env" | head -n1; }
server_ip() { curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'; }
set_env() { # set_env KEY VALUE (di whatsapp/.env)
  if grep -q "^$1=" "$APP/whatsapp/.env"; then sed -i "s|^$1=.*|$1=$2|" "$APP/whatsapp/.env"; else echo "$1=$2" >> "$APP/whatsapp/.env"; fi
}
set_domain() {
  local new="$1"
  if [[ "$new" == --lepas || "$new" == off ]]; then unset_domain; return; fi
  [[ "$new" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die 'Domain tidak valid. Contoh: wa domain wa.contoh.com'
  if [[ "$MODE" == aapanel ]]; then
    [[ -f "/www/server/panel/vhost/nginx/$new.conf" ]] || die "Website $new belum ada di aaPanel. Buat dulu di menu Website (aktifkan SSL), lalu ulangi."
  else
    if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
      say 'Memasang Nginx dan certbot'
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nginx certbot python3-certbot-nginx >/dev/null
      systemctl enable --now nginx >/dev/null 2>&1 || true
    fi
    if [[ -z "${WA_EMAIL:-}" || "$WA_EMAIL" == *@localhost ]]; then
      local email=''
      [[ -r /dev/tty ]] && read -r -p "Email untuk sertifikat SSL [admin@$new]: " email < /dev/tty || true
      WA_EMAIL="${email:-admin@$new}"; save_conf WA_EMAIL "$WA_EMAIL"
    fi
  fi
  DOMAIN="$new"; save_conf WA_DOMAIN "$new"
  set_env APP_URL "https://$new"
  nginx_install
  supctl restart wa-web wa-worker >/dev/null || true
  say "Domain terpasang: https://$new"
  if [[ "$MODE" == bare ]]; then ssl_issue || true; else echo "aaPanel: pastikan SSL untuk $new aktif di menu Website."; fi
}
unset_domain() {
  local ip; ip="$(server_ip)"
  if [[ -n "$DOMAIN" ]]; then
    if [[ "$MODE" == bare ]]; then rm -f /etc/nginx/sites-enabled/wa.conf /etc/nginx/sites-available/wa.conf; nginx_reload || true
    else local v="/www/server/panel/vhost/nginx/$DOMAIN.conf"; [[ -f "$v" ]] && sed -i "\|nginx-wa-locations.conf|d" "$v"; nginx_reload || true; fi
  fi
  DOMAIN=''; save_conf WA_DOMAIN ''
  set_env APP_URL "http://$ip:$PORT"; set_env HOST 0.0.0.0
  supctl restart wa-web wa-worker >/dev/null || true
  say "Domain dilepas. Akses lewat http://$ip:$PORT"
}
set_port() {
  local p="$1"
  [[ "$p" =~ ^[0-9]{4,5}$ ]] || die 'Port harus angka, mis. wa port 3343'
  PORT="$p"; save_conf WA_PORT "$p"
  sed -i "s|^PORT=.*|PORT=$p|; s|^MCP_OAUTH_CALLBACK_PORT=.*|MCP_OAUTH_CALLBACK_PORT=$((p + 1))|" "$APP/whatsapp/.env"
  grep -q '^MCP_OAUTH_CALLBACK_PORT=' "$APP/whatsapp/.env" || echo "MCP_OAUTH_CALLBACK_PORT=$((p + 1))" >> "$APP/whatsapp/.env"
  if [[ -n "$DOMAIN" ]]; then nginx_install; else set_env APP_URL "http://$(server_ip):$p"; set_env HOST 0.0.0.0; fi
  supctl restart wa-web wa-worker >/dev/null || true
  sleep 3; supctl status wa-web wa-worker || true
  say "Port WEB sekarang $p (callback MCP $((p + 1)))."
}
uninstall() {
  read -r -p "Hapus WhatsApp dari server ini? Database dan media ikut dihapus. Ketik 'HAPUS' untuk lanjut: " ok < /dev/tty
  [[ "$ok" == HAPUS ]] || { echo 'Dibatalkan.'; return 0; }
  backup || true
  supctl stop wa-web wa-worker >/dev/null 2>&1 || true
  rm -f "$SUP_DIR/wa-web.$SUP_EXT" "$SUP_DIR/wa-worker.$SUP_EXT"; supctl reread >/dev/null 2>&1; supctl update >/dev/null 2>&1 || true
  [[ -n "$DOMAIN" ]] && unset_domain >/dev/null 2>&1 || true
  MYSQL_PWD="$WA_DB_PASS" mysql -u"$WA_DB_USER" -e "DROP DATABASE IF EXISTS \`$WA_DB_NAME\`" 2>/dev/null || true
  rm -f /etc/cron.d/wa-backup /usr/local/bin/wa /etc/sudoers.d/wa
  say "Kode dan data ada di $DIR (backup terakhir di $DIR/backups). Hapus manual bila sudah tidak perlu: rm -rf $DIR /etc/wa"
}
menu() {
  while true; do
    cat <<M

  WhatsApp v$(current_version) · $(app_url)
  ─────────────────────────────────────────
   1) Status               6) Pasang / ganti domain
   2) Update ke versi terbaru
   3) Restart              7) Lepas domain (pakai IP:port)
   4) Log WEB              8) Ganti port
   5) Log WORKER           9) Reset password user
                          10) Backup     11) Restore
                          12) Rollback   13) Shell database
                           0) Keluar
M
    read -r -p '  Pilih nomor: ' n < /dev/tty
    case "$n" in
      1) status ;; 2) update ;; 3) supctl restart wa-web wa-worker ;;
      4) tail -n 100 -f /var/log/wa/web.log ;; 5) tail -n 100 -f /var/log/wa/worker.log ;;
      6) read -r -p '  Domain (mis. wa.contoh.com): ' d < /dev/tty; set_domain "$d" ;;
      7) unset_domain ;; 8) read -r -p '  Port baru (mis. 3343): ' p < /dev/tty; set_port "$p" ;;
      9) user_reset ;; 10) backup ;; 11) read -r -p '  File backup: ' f < /dev/tty; restore "$f" ;;
      12) rollback ;; 13) MYSQL_PWD="$WA_DB_PASS" mysql -u"$WA_DB_USER" "$WA_DB_NAME" ;;
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
  port) [[ -n "${2:-}" ]] || die 'wa port NOMOR'; set_port "$2" ;;
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
  _post-update) post_update ;;
  help|-h|--help) sed -n 2,10p "$0" ;;
  *) die "Perintah '$1' tidak dikenal. Lihat: wa help" ;;
esac
