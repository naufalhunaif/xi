# Pasang WhatsApp standalone (satu perintah)

Aplikasi WhatsApp berjalan sendiri: tanpa bundle PHP (Store/Material/Invoice/Fit/Account),
login memakai email + password milik aplikasi ini, dan dikendalikan lewat perintah `wa`.
Alurnya seperti aaPanel: setelah install langsung bisa dibuka lewat `http://IP:PORT`,
domain (dengan SSL) dipasang belakangan dengan `wa domain nama-domain.com`.

## Kebutuhan

- VPS Linux **Ubuntu 22.04 / 24.04** atau **Debian 12**, akses root, RAM ≥ 2 GB.
- Domain tidak wajib. Bila nanti mau pasang domain: A record-nya mengarah ke IP server.
- Kode standalone ada di repo publik **github.com/naufalhunaif/xi** (tanpa token).

## Server kosong (tanpa aaPanel)

```bash
curl -fsSL https://raw.githubusercontent.com/naufalhunaif/xi/main/deploy/install.sh | sudo bash
```

Tidak ada yang ditanya. Installer memasang MariaDB, Supervisor, Node.js 24, membuat user sistem
`wa`, menaruh kode di `/opt/wa/app`, membuat database + `.env`, build, lalu menyalakan proses
WEB dan WORKER di port kosong pertama mulai 3333.

Setelah selesai buka **`http://IP-SERVER:PORT/setup`** (alamatnya dicetak di akhir) untuk
membuat akun pemilik pertama.

Pasang domain kapan saja (Nginx + certbot dipasang otomatis saat itu):

```bash
wa domain wa.domainku.com
```

## Server aaPanel

1. Jalankan perintah yang sama. Installer mendeteksi aaPanel, menaruh kode di `/www/wwwroot/wa`,
   memakai MySQL aaPanel (password root dibaca dari panel; bila gagal tambahkan
   `WA_DB_ROOT_PASSWORD=...`), dan mendaftarkan proses ke Supervisor (plugin aaPanel atau
   Supervisor sistem). Node.js 24 dari aaPanel dipakai bila ada.
2. Buka port yang dicetak installer di aaPanel → Security, lalu buka `http://IP:PORT/setup`.
3. Untuk domain: buat site di aaPanel → Website (aktifkan SSL), lalu `wa domain nama-domain.com`.
   Installer menyisipkan `include .../nginx-wa-locations.conf;` ke vhost site itu.

## Perintah `wa`

`wa` tanpa argumen menampilkan menu bernomor (seperti `bt` di aaPanel). Subperintah:

| Perintah | Fungsi |
| --- | --- |
| `wa status` | versi, mode, status WEB/WORKER |
| `wa restart` / `wa stop` / `wa start` | kendali proses lewat Supervisor |
| `wa logs [web\|worker]` | ikuti log |
| `wa update [v3.0.1\|main]` | ambil rilis v3 terbaru (atau versi/branch tertentu), build, restart |
| `wa rollback` | kembali ke versi sebelum `update` terakhir |
| `wa domain wa.domainku.com` | pasang/ganti domain (`APP_URL`, vhost Nginx, SSL) |
| `wa domain --lepas` | lepas domain, kembali ke `http://IP:PORT` |
| `wa port 3343` | ganti port lokal WEB (bila 3333 dipakai aplikasi lain; callback MCP = port+1) |
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
