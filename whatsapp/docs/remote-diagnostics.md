# Diagnostik server jarak jauh

Endpoint untuk instalasi ini: `https://keepbelanja.com/whatsapp/api/ops/diagnostics`.
Endpoint GET ini membutuhkan bearer khusus; tidak memakai cookie login atau akses
MCP bisnis pelanggan. Default nonaktif sampai konfigurasi privat dibuat di server.
Satu token terikat ke satu workspace dan kedaluwarsa setelah 30 hari.

## Aktifkan di server

Jalankan dari checkout `/www/wwwroot/Project`:

```sh
git pull --ff-only
bash deploy/build.sh
cd whatsapp
node scripts/enable_diagnostics.mjs
```

Initializer membaca APP_URL dari `.env` dan ID workspace aktif dari database,
tanpa mengubah data bisnis. Ia menulis `storage/diagnostics/access.json` (hash
token) dan `storage/diagnostics/client.json` (kredensial koneksi), mode 0600.
Token tidak dicetak. Folder diagnostik diabaikan Git dan berada di shared storage
yang tetap ada setelah deploy. Pastikan WEB dan WORKER memakai shared storage yang
sama dan pengguna OS layanan memiliki akses ke folder ini.

Script aktivasi memakai dependensi dari symlink `whatsapp/current` pada server
aaPanel; folder source tidak perlu memiliki `node_modules`. Jika belum ada
`current`, script memakai dependensi checkout lokal. Lokasi `.env` dan storage
mengikuti folder aplikasi tempat script berada, bukan direktori shell.

Jika versi awal script gagal dengan `Cannot find package 'mysql2'`, cukup ambil
perbaikan script lalu ulangi aktivasi (endpoint yang sudah terdeploy tidak perlu
dibuild atau direstart lagi):

```sh
cd /www/wwwroot/Project
git pull --ff-only
node whatsapp/scripts/enable_diagnostics.mjs
```

Unduh **client.json** melalui file manager server yang sudah terautentikasi ke
komputer operator, misalnya `~/Downloads/whatsapp-diagnostics-client.json`.
Jangan tempel isinya ke chat, issue, Git, URL atau log. Batasi izin file lokal:

```sh
chmod 600 ~/Downloads/whatsapp-diagnostics-client.json
```

Jika konfigurasi sudah ada, initializer tidak menimpa token. Gunakan
`node scripts/enable_diagnostics.mjs --rotate` untuk mengganti akses/masa berlaku
atau mengikat workspace aktif yang baru, lalu unduh ulang file client. Cabut akses
dengan menghapus `storage/diagnostics/access.json` di server. Tidak perlu restart
untuk mengaktifkan, merotasi, atau mencabut token setelah kode endpoint terdeploy.

## Baca langsung atau melalui MCP

Di komputer operator, dari checkout lokal yang memiliki dependencies WhatsApp:

```sh
WHATSAPP_DIAGNOSTICS_CONFIG="$HOME/Downloads/whatsapp-diagnostics-client.json" \
  node whatsapp/scripts/diagnostics_mcp.mjs --once
```

Tanpa `--once`, script menjalankan server MCP stdio. Konfigurasi generik klien MCP:

```json
{
  "mcpServers": {
    "whatsapp-diagnostics": {
      "command": "node",
      "args": ["/absolute/path/to/Project/whatsapp/scripts/diagnostics_mcp.mjs"],
      "env": {
        "WHATSAPP_DIAGNOSTICS_CONFIG": "/private/path/whatsapp-diagnostics-client.json"
      }
    }
  }
}
```

Tool tunggal `get_whatsapp_diagnostics` menerima `traceId` opsional. Tool tidak
menerima URL, workspace, SQL, perintah shell, atau jalur file dari model. Koneksi
hanya HTTPS ke endpoint dalam file privat; redirect ditolak. Pemeriksaan tidak
memanggil AI berbayar, tool bisnis, atau mengirim WhatsApp.

## Data yang bisa diperiksa

- Identitas build/fingerprint dan PID WEB serta WORKER; mismatch ditandai.
- Heartbeat file worker setiap 5 detik, RSS, uptime, keterlambatan event loop,
  dan jumlah koneksi terpakai/bebas/menunggu dari pool aplikasi yang sudah terbentuk.
- PID proses provider yang diluncurkan aplikasi, waktu mulai/keluar, exit code dan
  signal; tidak ada command line, environment, prompt, atau stderr mentah.
- Pemeriksaan MySQL dengan koneksi terpisah, connect/query timeout 3 detik.
  Probe ini dapat berhasil saat pool aplikasi sedang menunggu; keduanya dilaporkan
  terpisah. Maksimal satu pengumpulan per proses web, snapshot HTTP disimpan 2 detik.
- Lima trace terbaru atau satu trace tertentu: fase, waktu, kode error, routing,
  pemilihan skill aktif/dipertahankan, ukuran prompt, usage dan cache hit/miss.
- Evaluasi pemilihan skill yang sedang tersimpan di server, tanpa mengirim isinya.

Tidak mengembalikan JID, nomor telepon, isi pesan, input/keputusan AI mentah,
argumen/hasil tool, credential, log mentah, atau penalaran internal.
Semua query diagnostik adalah SELECT dengan workspace tetap dari konfigurasi.
Tidak menjalankan init-model/migrasi dari endpoint diagnostik.

Snapshot worker disimpan terpisah dari database sehingga dapat dibaca ketika DB
mati. Sampel lama dibersihkan setelah 24 jam; API membaca maksimal 64 file terbaru,
delapan trace per proses, hingga 10 langkah aktif dan 25 langkah selesai terakhir
per snapshot worker. Trace DB
tetap menyimpan langkah lengkap sesuai batas audit aplikasi.

`TRACE_UPDATES_STALE`, heartbeat lama, dan signal SIGKILL tidak sendiri membuktikan
OOM, restart, atau penyebab provider gagal. Jika web/server/jaringan mati, API
juga tidak bisa dijangkau. Data RAM host tidak selalu sama dengan limit container.
Endpoint menyediakan bukti terukur dan menyatakan sebab yang belum diketahui;
diagnosis kernel/mesin tetap memerlukan akses infrastruktur terpisah.

Validasi lokal: bearer/expiry, proyeksi privasi, DB gagal, lifecycle provider,
snapshot tanpa DB, isolasi workspace lewat HTTP, dan protokol MCP menggunakan
fixture. Tidak ada klaim koneksi produksi berhasil sebelum file akses dipasang
dan pembacaan langsung pertama diverifikasi.
