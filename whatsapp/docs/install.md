# Pasang WhatsApp standalone (satu perintah)

Aplikasi WhatsApp berjalan sendiri: tanpa bundle PHP (Store/Material/Invoice/Fit/Account),
login memakai email + password milik aplikasi ini, dipasang di akar domain
(`https://wa.domainku.com`), dan dikendalikan lewat perintah `wa`.

## Kebutuhan

- VPS Linux **Ubuntu 22.04 / 24.04** atau **Debian 12**, akses root, RAM ≥ 2 GB.
- Domain/subdomain yang A record-nya sudah mengarah ke IP server (untuk SSL otomatis).
- Kode standalone ada di repo publik **github.com/naufalhunaif/xi** (tanpa token).

## Server kosong (tanpa aaPanel)

```bash
curl -fsSL https://raw.githubusercontent.com/naufalhunaif/xi/main/deploy/install.sh \
  | sudo WA_DOMAIN=wa.domainku.com WA_EMAIL=admin@domainku.com bash
```

Installer memasang Nginx, MariaDB, Supervisor, certbot, Node.js 24, membuat user sistem
`wa`, menaruh kode di `/opt/wa/app`, membuat database + `.env`, build, menyalakan proses
WEB dan WORKER, lalu meminta sertifikat Let's Encrypt. Bila DNS belum mengarah, sementara
dipakai sertifikat self-signed; jalankan `wa ssl` setelah DNS beres.

Setelah selesai buka **`https://wa.domainku.com/setup`** untuk membuat akun pemilik pertama.

## Server aaPanel

1. Di aaPanel → Website → tambah site untuk `wa.domainku.com`, aktifkan SSL (Let's Encrypt).
2. Pastikan plugin **Supervisor** terpasang di aaPanel dan Node.js 24 tersedia
   (App Store → Node.js version manager) — bila tidak ada, installer memasang Node sendiri.
3. Jalankan perintah yang sama seperti di atas. Installer mendeteksi aaPanel, menaruh kode di
   `/www/wwwroot/wa`, memakai MySQL aaPanel (password root dibaca dari panel; bila gagal
   tambahkan `WA_DB_ROOT_PASSWORD=...`), mendaftarkan proses ke Supervisor aaPanel, dan
   menyisipkan `include .../nginx-wa-locations.conf;` ke vhost site tersebut.

## Perintah `wa`

`wa` tanpa argumen menampilkan menu bernomor (seperti `bt` di aaPanel). Subperintah:

| Perintah | Fungsi |
| --- | --- |
| `wa status` | versi, mode, status WEB/WORKER |
| `wa restart` / `wa stop` / `wa start` | kendali proses lewat Supervisor |
| `wa logs [web\|worker]` | ikuti log |
| `wa update [v3.0.1\|main]` | ambil rilis v3 terbaru (atau versi/branch tertentu), build, restart |
| `wa rollback` | kembali ke versi sebelum `update` terakhir |
| `wa domain wa-baru.domainku.com` | ganti domain (`APP_URL`, vhost, SSL) |
| `wa ssl` | minta/perbarui sertifikat Let's Encrypt (mode bare) |
| `wa user [email]` | reset password akun; akun dibuat bila belum ada |
| `wa backup` / `wa restore FILE` | backup database + media (otomatis tiap hari 03:00, simpan 7 hari) |
| `wa db` | shell MySQL database aplikasi |
| `wa uninstall` | hentikan & lepas dari server (backup dibuat dulu) |

Konfigurasi installer tersimpan di `/etc/wa/wa.conf` (hanya root; berisi token dan password DB).
Konfigurasi aplikasi ada di `<folder>/app/whatsapp/.env`.

## Versi & rilis

Versi aplikasi ada di `whatsapp/VERSION` dan tampil di sidebar serta `/api/version`.
Membuat rilis baru dari komputer pengembang (setelah semua commit masuk):

```bash
bash deploy/release.sh 3.0.1
```

Skrip menulis `VERSION`, membuat tag `v3.0.1`, push ke repo `xi`, dan membuat GitHub Release lewat API
(token dari `GITHUB_TOKEN` atau URL remote). Server lalu cukup `wa update`.

Repo `xi` berisi salinan folder `whatsapp/` dan `deploy/` dari repo pengembangan `alogaritm--app`;
sinkronkan dengan `bash deploy/publish-xi.sh` sebelum membuat rilis.

## Cara kerja

- `deploy/install.sh` — pemasangan awal (bare/aaPanel).
- `deploy/wa.sh` — dipasang sebagai `/usr/local/bin/wa`.
- `deploy/build.sh` — build terpisah di `whatsapp/.deploy/release-*`, lalu symlink `whatsapp/current`
  diganti (nama lama `whatsapp-aapanel.sh` masih bisa dipakai).
- `deploy/run.sh web|worker` — launcher yang dipanggil Supervisor (nama lama `run-whatsapp.sh`).
- Data bersama di luar release: `whatsapp/storage`, `whatsapp/tmp`, `whatsapp/public/media`, `whatsapp/.env`.
- Mode login ditentukan `.env`: `ACCOUNT_URL` kosong / `AUTH_MODE=local` → login lokal (tabel
  `wa_users`); `ACCOUNT_URL` terisi → OAuth bundle seperti semula.
