#!/usr/bin/env bash
# =============================================================================
#  WhatsApp — installer satu perintah (standalone, tanpa bundle PHP)
#
#  Server kosong (Ubuntu 22.04/24.04, Debian 12) maupun aaPanel:
#    curl -fsSL https://raw.githubusercontent.com/naufalhunaif/xi/main/deploy/install.sh | sudo bash
#  Domain dan email ditanya saat berjalan (atau isi lewat variabel di bawah).
#
#  Server aaPanel: buat dulu website untuk domain di aaPanel (dengan SSL). Installer
#  mendeteksi aaPanel dan memakai Nginx/MySQL-nya; Supervisor dipasang bila belum ada.
#
#  Variabel (opsional; ditanya bila terminal interaktif):
#    WA_DOMAIN     domain aplikasi, mis. wa.contoh.com
#    WA_EMAIL      email untuk Let's Encrypt (bare)
#    WA_TOKEN      GitHub token (hanya bila repo privat)
#    WA_VERSION    tag rilis (v3.0.0) atau branch (main); default: rilis v3 terbaru
#    WA_MODE       auto | bare | aapanel
#    WA_DIR        folder pasang (bare: /opt/wa, aaPanel: /www/wwwroot/wa)
#    WA_PORT       port proses WEB (default 3333)
#    WA_DB_ROOT_PASSWORD  password root MySQL aaPanel (bila tidak terbaca otomatis)
# =============================================================================
set -euo pipefail
umask 022

REPO="${WA_REPO:-naufalhunaif/xi}"
CONF_DIR=/etc/wa
CONF="$CONF_DIR/wa.conf"
APP_USER=wa

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mGAGAL:\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "Pertanyaan" [default]
  local var="$1" q="$2" def="${3:-}" val
  if [[ -n "${!var:-}" ]]; then return; fi
  if [[ -t 0 || -r /dev/tty ]]; then
    read -r -p "$q${def:+ [$def]}: " val < /dev/tty || true
    printf -v "$var" '%s' "${val:-$def}"
  else
    printf -v "$var" '%s' "$def"
  fi
}

[[ "$EUID" == 0 ]] || die 'Jalankan sebagai root (sudo).'
[[ "$(uname -s)" == Linux ]] || die 'Installer ini untuk Linux.'
command -v apt-get >/dev/null 2>&1 || die 'Distro harus berbasis Debian/Ubuntu (apt-get).'
export DEBIAN_FRONTEND=noninteractive
export PATH="$PATH:/www/server/mysql/bin:/www/server/nginx/sbin:/usr/local/bin"

# ---------------------------------------------------------------- mode -------
MODE="${WA_MODE:-auto}"
if [[ "$MODE" == auto ]]; then
  if [[ -d /www/server/panel ]]; then MODE=aapanel; else MODE=bare; fi
fi
[[ "$MODE" == bare || "$MODE" == aapanel ]] || die 'WA_MODE harus auto, bare, atau aapanel.'
if [[ "$MODE" == aapanel ]]; then DIR="${WA_DIR:-/www/wwwroot/wa}"; else DIR="${WA_DIR:-/opt/wa}"; fi
APP="$DIR/app"
PORT="${WA_PORT:-3333}"

# Sudah terpasang lengkap? Arahkan ke `wa update`. Pemasangan yang gagal di tengah boleh diulang.
if [[ -f "$CONF" ]] && grep -q '^WA_INSTALLED=1' "$CONF" && [[ -x "$APP/deploy/wa.sh" ]]; then
  warn "WhatsApp sudah terpasang ($CONF). Gunakan: wa update, atau: wa domain DOMAIN"
  exit 0
fi

ask WA_DOMAIN 'Domain aplikasi (mis. wa.contoh.com)'
DOMAIN="${WA_DOMAIN:-}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die 'Domain tidak valid.'
if [[ "$MODE" == aapanel && ! -f "/www/server/panel/vhost/nginx/$DOMAIN.conf" ]]; then
  die "Website $DOMAIN belum ada di aaPanel. Buat dulu di menu Website (aktifkan SSL), lalu jalankan lagi."
fi
if [[ "$MODE" == bare ]]; then
  ask WA_EMAIL "Email untuk sertifikat SSL (Let's Encrypt)" "admin@$DOMAIN"
fi
EMAIL="${WA_EMAIL:-admin@$DOMAIN}"
TOKEN="${WA_TOKEN:-}"

say "Mode: $MODE · folder: $DIR · domain: $DOMAIN"

# ---------------------------------------------------------- paket OS ---------
say 'Memasang paket sistem'
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg git build-essential \
  python3 pkg-config libstdc++6 xz-utils openssl cron >/dev/null
if [[ "$MODE" == bare ]]; then
  apt-get install -y -qq --no-install-recommends nginx mariadb-server supervisor certbot \
    python3-certbot-nginx >/dev/null
  systemctl enable --now nginx mariadb supervisor >/dev/null 2>&1 || true
elif [[ ! -f /www/server/panel/plugin/supervisor/supervisord.conf && ! -f /etc/supervisord.conf && ! -f /etc/supervisor/supervisord.conf ]]; then
  # aaPanel tanpa plugin Supervisor: pakai Supervisor sistem.
  apt-get install -y -qq --no-install-recommends supervisor >/dev/null
  systemctl enable --now supervisor >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------- Node 24 -------
node_major() { command -v "$1" >/dev/null 2>&1 && "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0; }
NODE_BIN=''
if [[ "$MODE" == aapanel ]]; then
  for candidate in /www/server/nodejs/v24*/bin /www/server/nodejs/v2[5-9]*/bin; do
    [[ -x "$candidate/node" ]] && NODE_BIN="$candidate"
  done
fi
if [[ -z "$NODE_BIN" && "$(node_major node)" -ge 24 ]]; then NODE_BIN="$(dirname "$(command -v node)")"; fi
install_node_tarball() {
  # Cadangan bila NodeSource tidak bisa diakses: binari resmi nodejs.org.
  local arch file
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) return 1 ;; esac
  file="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v24[0-9.]*-linux-$arch.tar.xz" | head -n1)"
  [[ -n "$file" ]] || return 1
  mkdir -p /usr/local/lib/nodejs
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" | tar -xJ -C /usr/local/lib/nodejs
  rm -rf /usr/local/lib/nodejs/node-v24
  mv "/usr/local/lib/nodejs/${file%.tar.xz}" /usr/local/lib/nodejs/node-v24
  for bin in node npm npx; do ln -sf "/usr/local/lib/nodejs/node-v24/bin/$bin" "/usr/local/bin/$bin"; done
  NODE_BIN=/usr/local/lib/nodejs/node-v24/bin
}
if [[ -z "$NODE_BIN" ]]; then
  say 'Memasang Node.js 24'
  if curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1; then
    NODE_BIN="$(dirname "$(command -v node)")"
  else
    warn 'NodeSource tidak bisa diakses; memakai binari nodejs.org.'
    install_node_tarball || die 'Node.js 24 gagal dipasang. Pasang manual lalu ulangi.'
  fi
fi
[[ "$(node_major "$NODE_BIN/node")" -ge 24 ]] || die 'Node.js 24+ tidak tersedia.'
say "Node.js $("$NODE_BIN/node" -v) di $NODE_BIN"

# ------------------------------------------------------------ user & dir -----
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$DIR" "$DIR/backups" /var/log/wa "$CONF_DIR"
chown "$APP_USER:$APP_USER" "$DIR" "$DIR/backups" /var/log/wa
chmod 750 "$DIR"; chmod 700 "$CONF_DIR" "$DIR/backups"

# --------------------------------------------------------------- sumber ------
git_url() {
  if [[ -n "$TOKEN" ]]; then echo "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
  else echo "https://github.com/${REPO}.git"; fi
}
latest_tag() {
  git -C "$APP" tag -l 'v3.*' | sort -V | tail -n1
}
say 'Mengambil kode aplikasi'
git config --system --add safe.directory "$APP" 2>/dev/null || true
if [[ ! -d "$APP/.git" ]]; then
  sudo -u "$APP_USER" -H git clone -q --filter=blob:none --no-checkout "$(git_url)" "$APP" \
    || die 'Clone gagal. Repo privat memerlukan WA_TOKEN dengan akses baca.'
  sudo -u "$APP_USER" -H git -C "$APP" sparse-checkout set whatsapp deploy
fi
# chmod +x pada skrip deploy tidak boleh dianggap perubahan lokal.
sudo -u "$APP_USER" -H git -C "$APP" config core.fileMode false
sudo -u "$APP_USER" -H git -C "$APP" fetch -q --tags origin
VERSION="${WA_VERSION:-$(latest_tag)}"
if [[ -z "$VERSION" ]]; then
  VERSION=main
  warn "Belum ada rilis v3.x; memakai branch $VERSION."
fi
if git -C "$APP" show-ref -q --verify "refs/tags/$VERSION"; then
  sudo -u "$APP_USER" -H git -C "$APP" checkout -q -f --detach "tags/$VERSION"
else
  sudo -u "$APP_USER" -H git -C "$APP" checkout -q -f -B "$VERSION" "origin/$VERSION"
fi
chmod +x "$APP"/deploy/*.sh
say "Versi: $VERSION"

# ---------------------------------------------------------------- database ---
DB_NAME=wa
DB_USER=wa
ENV_FILE="$APP/whatsapp/.env"
DB_PASS="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE" 2>/dev/null | head -n1)"
[[ -n "$DB_PASS" ]] || DB_PASS="$(openssl rand -hex 16)"
mysql_root() {
  if [[ "$MODE" == bare ]]; then mysql --protocol=socket -uroot "$@"; return; fi
  local pw="${WA_DB_ROOT_PASSWORD:-}"
  if [[ -z "$pw" && -f /www/server/panel/data/default.db ]]; then
    pw="$(python3 - <<'PY' 2>/dev/null || true
import sqlite3
print(sqlite3.connect('/www/server/panel/data/default.db').execute('select mysql_root from config').fetchone()[0])
PY
)"
  fi
  [[ -n "$pw" ]] || die 'Password root MySQL aaPanel tidak terbaca. Jalankan ulang dengan WA_DB_ROOT_PASSWORD=...'
  MYSQL_PWD="$pw" mysql -uroot "$@"
}
say 'Menyiapkan database'
mysql_root <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

# -------------------------------------------------------------------- .env ---
if [[ -f "$ENV_FILE" ]]; then
  sed -i "s|^APP_URL=.*|APP_URL=https://$DOMAIN|" "$ENV_FILE"
else
  say 'Menulis whatsapp/.env'
  cat > "$ENV_FILE" <<ENV
TZ=Asia/Jakarta
PORT=$PORT
HOST=127.0.0.1
NODE_ENV=production
LOG_LEVEL=info
APP_KEY=$(openssl rand -base64 32)
APP_URL=https://$DOMAIN
APP_BASE_PATH=
ACCOUNT_URL=
AUTH_MODE=local
MCP_OAUTH_CALLBACK_PORT=3334
SESSION_DRIVER=cookie
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_DATABASE=$DB_NAME
ENV
  chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
fi

# ------------------------------------------------------------------ config ---
cat > "$CONF" <<CFG
# Konfigurasi WhatsApp standalone (dibaca oleh perintah \`wa\`). Jangan dibagikan: berisi token.
WA_MODE=$MODE
WA_DIR=$DIR
WA_APP=$APP
WA_USER=$APP_USER
WA_DOMAIN=$DOMAIN
WA_EMAIL=$EMAIL
WA_PORT=$PORT
WA_REPO=$REPO
WA_TOKEN=$TOKEN
WA_NODE_BIN=$NODE_BIN
WA_DB_NAME=$DB_NAME
WA_DB_USER=$DB_USER
WA_DB_PASS=$DB_PASS
CFG
chmod 600 "$CONF"
ln -sf "$APP/deploy/wa.sh" /usr/local/bin/wa
chmod +x "$APP/deploy/wa.sh"

# ----------------------------------------------------------- supervisor ------
say 'Mendaftarkan proses WEB dan WORKER (Supervisor)'
bash "$APP/deploy/wa.sh" _supervisor-install

# -------------------------------------------------------------- nginx --------
say 'Mengatur Nginx'
bash "$APP/deploy/wa.sh" _nginx-install

# -------------------------------------------------------------- build --------
say 'Build aplikasi (beberapa menit pada pemasangan pertama)'
bash "$APP/deploy/wa.sh" _build --first

# -------------------------------------------------------------- ssl ----------
if [[ "$MODE" == bare ]]; then
  bash "$APP/deploy/wa.sh" ssl || warn "SSL Let's Encrypt belum berhasil; sementara memakai sertifikat self-signed. Ulangi: wa ssl"
fi

# -------------------------------------------------------------- cron ---------
cat > /etc/cron.d/wa-backup <<CRON
# Backup harian WhatsApp (database + media), simpan 7 hari.
0 3 * * * root /usr/local/bin/wa backup --quiet >/dev/null 2>&1
CRON

# -------------------------------------------------------------- firewall -----
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

echo 'WA_INSTALLED=1' >> "$CONF"
say 'Selesai.'
cat <<DONE

  Buka:      https://$DOMAIN/setup   (buat akun pemilik pertama)
  Perintah:  wa            (menu: status, update, domain/SSL, user, log, backup, ...)
  Versi:     $VERSION
$( [[ "$MODE" == aapanel ]] && printf '\n  aaPanel: pastikan SSL untuk %s sudah aktif di menu Website aaPanel.\n' "$DOMAIN" )
DONE
