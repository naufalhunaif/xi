# Deploy WhatsApp di aaPanel

`git push`/`git pull` hanya memindahkan kode. AdonisJS harus di-compile di server; `node_modules` dari Mac tidak boleh diunggah ke Linux. Codex sekarang tercatat sebagai dependency produksi `@openai/codex` versi terkunci, bersama Claude Code, Baileys, Sharp, dan FFmpeg. `npm ci` menggunakan `package-lock.json` dan memasang optional binary sesuai OS/CPU server.

## Sekali saat menyiapkan server

1. Pilih **Node.js 24+** di aaPanel dan pastikan `node` serta `npm` versi tersebut tersedia di PATH untuk build **dan** proses web/worker. Gunakan Linux modern x64/arm64 (misalnya Ubuntu 22.04/24.04). Tidak perlu Rust untuk compile Codex; paket menyediakan binary.
2. Bila paket OS belum tersedia, dari root repository jalankan:

   ```bash
   sudo bash deploy/install-whatsapp-system-deps.sh
   ```

   `--dry-run` hanya mencetak perintah. Skrip OS tidak mengganti Node/PHP/MySQL/Nginx. Setelah itu jalankan build sebagai user aplikasi yang sama dengan web/worker, bukan root. User tersebut perlu home directory yang bisa ditulis untuk OAuth dan izin tulis folder proyek.
3. Siapkan `whatsapp/.env` dari `.env.example` secara manual; jangan commit `.env`. Isi `APP_KEY` tetap, database server, `APP_URL=https://domain-anda/whatsapp`, `ACCOUNT_URL=https://domain-anda/account`, `APP_BASE_PATH=/whatsapp`, `HOST=127.0.0.1`, `PORT=3333`. Jangan mengganti `APP_KEY` pada tiap deploy. Database harus sudah dibuat; skrip memakai **init model**, bukan migration.
4. Gunakan `CODEX_BIN=codex` dan `CLAUDE_BIN=claude`. Jika database diimpor dari laptop, kosongkan lokasi binary khusus di Pengaturan AI atau ubah menjadi `codex`/`claude`; path `/Users/...` atau `/Applications/...` tidak berlaku di Linux. Launcher menambahkan `node_modules/.bin` dari release aktif ke PATH.
5. Lindungi folder deploy dan data melalui Nginx. Gunakan `deploy/nginx-rewrite.conf` sebagai acuan; sesuaikan dengan konfigurasi situs aaPanel, periksa `nginx -t`, lalu reload. Jangan jadikan `.deploy`, `current`, atau root source sebagai static document root. Untuk server Node terpisah, static root hanya `current/public`.

Jika sebelumnya menjalankan build manual dan menyimpan upload di `whatsapp/build/public/media` atau `whatsapp/build/storage`, backup lalu gabungkan datanya ke `whatsapp/public/media` dan `whatsapp/storage` saat proses dihentikan. Skrip menolak deploy pertama bila mendeteksi data masih terpisah di build lama; tidak memindahkan/menimpa upload otomatis. `.env` server juga harus berada di `whatsapp/.env`, bukan hanya di build lama.

## Setiap selesai pull / perintah build aaPanel

Dari root repository (folder yang berisi `account`, `store`, `whatsapp`, dan `deploy`):

```bash
git pull --ff-only
bash deploy/build.sh
```

Pasang `bash deploy/build.sh` sebagai **perintah build/post-pull** pada alur deployment aaPanel Anda. Git pull sendiri tidak mengeksekusi skrip. Jika fitur aaPanel hanya menyediakan satu shell command:

```bash
git pull --ff-only && bash deploy/build.sh
```

Skrip akan:

- Mengunci deploy agar tidak tumpang tindih, lalu menyalin source ke staging terpisah.
- Sebelum install, mendeteksi tepat satu WEB dan WORKER yang RUNNING melalui Supervisor, PID, cwd dan command aplikasi. Tidak menebak nama proses atau memakai restart-all.
- Memasang dependency build dengan `npm ci --include=dev --include=optional`, lalu `npm run build` (tidak mengabaikan error TypeScript).
- Memasang dependency produksi ke hasil build dengan `npm ci --omit=dev --include=optional`.
- Memeriksa versi dan flags Codex, Claude, pemrosesan Sharp, binary FFmpeg, driver MySQL, Ace compiled, CSS, bahasa, dan view. Ini **tidak** memanggil AI atau mengirim chat.
- Menghubungkan `.env`, `storage`, `tmp`, dan `public/media` ke folder persisten checkout; file tidak ditimpa. Baileys menyimpan session auth di database yang sama.
- Menjalankan `node ace.js app:init`, lalu mengganti symlink `whatsapp/current` ke release yang lolos. Init dapat menambah skema/default database sesuai kode; backup database sebelum update penting. Kegagalan init tidak otomatis membatalkan perubahan skema yang sudah terjadi.
- Memeriksa ulang target, menghentikan WORKER lama sampai keluar, restart WEB, kemudian start WORKER. Memastikan kedua PID baru RUNNING pada cwd release terbaru sebelum cleanup. Ini memverifikasi proses/build, bukan menjamin database, AI, atau koneksi WhatsApp sehat.

Restart otomatis memerlukan Linux, Supervisor aktif, dan izin mengakses Supervisor serta `/proc` milik proses. Lokasi `supervisorctl` dicari di PATH dan lokasi umum aaPanel; konfigurasi dicari di `/www/server/panel/plugin/supervisor/supervisord.conf`, `/etc/supervisord.conf`, dan `/etc/supervisor/supervisord.conf`. Jika lokasi berbeda, tetapkan path absolut `WHATSAPP_SUPERVISORCTL` dan `WHATSAPP_SUPERVISOR_CONFIG` pada environment perintah deploy. Jika konfigurasi/target ambigu atau tidak ditemukan, deploy berhenti sebelum install tanpa menghentikan proses.

Untuk **instalasi pertama** sebelum WEB/WORKER dibuat, build lokal macOS, atau sengaja restart manual:

```bash
bash deploy/build.sh --no-restart
```

Build gagal tidak me-restart layanan. Jika restart gagal setelah promosi, `current` sudah menunjuk build baru; skrip keluar nonzero, tidak membersihkan release lama, dan meminta pemeriksaan Supervisor. Tidak ada rollback otomatis karena init database mungkin sudah berjalan. Jika restart WEB gagal setelah WORKER dihentikan, skrip tetap mencoba menyalakan kembali WORKER. Hindari deploy saat proses pembayaran/pengiriman penting berlangsung; restart memutus sesi proses AI/OAuth yang sedang berjalan.

Perintah kontrol mengacu pada [dokumentasi Supervisor](https://docs.supervisord.org/running.html). Tidak ada `reload` seluruh Supervisor, `restart all`, atau penghentian PID memakai pencarian nama umum.

Setelah promosi berhasil, skrip otomatis menghapus **semua** folder `.deploy/release-*` lama yang tidak dipakai proses, termasuk sisa build gagal. Tidak menyimpan cadangan rollback. Penghapusan permanen; untuk kembali ke kode lama perlu build ulang commit tersebut. `current`, source checkout, `.env`, database, OAuth, storage, dan media persisten tidak dihapus. Jika ada data lokal sungguhan di dalam release lama (bukan symlink ke data bersama), release itu ditahan untuk diperiksa.

Release yang masih dipakai WEB, WORKER, atau proses CLI tidak dihapus. Launcher `deploy/run.sh` mencoba cleanup lagi ketika proses restart, sehingga sesudah kedua proses pindah ke release terbaru, release lama dapat dibersihkan. Pemeriksaan ini memakai `/proc` Linux dan perlu izin membaca proses serta menghapus release. Jika pemeriksaan tidak lengkap, pembersihan ditunda, bukan menebak bahwa folder aman dihapus. Di macOS cleanup otomatis ditunda. Gunakan launcher dengan cwd release fisik; proses `node current/bin/server.js` dari cwd checkout dapat membuat identitas release tidak pasti.

Jika proses di aaPanel tidak memakai launcher tersebut, atau berjalan dengan user yang tidak boleh membersihkan release buatan root, setelah **restart WEB dan WORKER**, jalankan dari root repository dengan user deploy yang memiliki izin cukup:

```bash
bash deploy/build.sh --cleanup
```

Perintah ini hanya membersihkan riwayat build, tanpa install, build ulang, perubahan database, atau penghentian proses. Cleanup memakai lock yang sama dengan deploy. Build/install gagal tidak mengganti `current` dan tidak membersihkan riwayat; sisa build gagal dibersihkan sesudah deploy sukses berikutnya atau melalui `--cleanup`. Kegagalan cleanup sesudah promosi tidak membatalkan build yang sudah aktif. Pastikan ruang disk tetap cukup untuk dua instalasi dependency selama build berlangsung. Jika deploy mati paksa, periksa proses sebelum menghapus lock `whatsapp/.deploy/lock`.

Untuk verifikasi install/build tanpa mengubah release aktif atau database:

```bash
bash deploy/build.sh --verify-only
```

`--skip-init` melewati init eksplisit; startup aplikasi masih menjalankan init model. Jangan menjalankan `npm run build` di dalam `current`, karena itu bukan source checkout.

## Dua proses yang harus dijalankan

Nomor order baru memakai `INV-YYYYMMDD-xxxxxxx`: tanggal pembuatan order dalam WIB dan tujuh karakter heksadesimal acak. `Init_model` menambahkan kolom `order_number` dan unique index secara otomatis; tidak perlu migration. Nomor disimpan sekali saat order dibuat, bukan saat halaman dibuka. Nomor lama `WA-...` tetap berlaku (kolom NULL), termasuk pada pembayaran lanjutan, saldo, dan pengiriman grup. Backup database sebelum init seperti pembaruan skema lainnya.

Di process manager aaPanel atau Supervisor, buat **dua proses**, masing-masing satu instance, dengan user aplikasi dan PATH Node yang sama:

```bash
# Web
bash /www/wwwroot/NAMA-PROJECT/deploy/run.sh web

# Worker Baileys + AI
bash /www/wwwroot/NAMA-PROJECT/deploy/run.sh worker
```

Set autorestart pada process manager. Jangan gunakan cluster/multiple instances untuk worker; jangan menjalankan `worker.sh` lokal sekaligus. Gunakan launcher tersebut agar setiap start mengikuti `current` terbaru. Deploy normal kini restart otomatis melalui Supervisor; jika memakai `--no-restart`, restart kedua proses secara manual. Sediakan waktu shutdown yang cukup pada Supervisor (misalnya `stopwaitsecs=120`); hindari deploy saat pembayaran/pengiriman sedang diproses.

Nginx `/whatsapp/` tetap proxy ke `127.0.0.1:3333`. Bila process manager mengunci cwd ke release lama, gunakan launcher di atas agar setiap restart memilih `current` terbaru.

## Login OAuth sekali di server

### Jika API gagal dimuat / login berulang

API yang membutuhkan login mengembalikan JSON `401 AUTH_REQUIRED`, bukan redirect OAuth. Browser menghentikan polling dan membuka login sekali sebagai navigasi halaman. Gangguan sementara saat memeriksa sesi Account mengembalikan `503 AUTH_UNAVAILABLE`; akses data tetap ditolak, sesi tidak dihapus, dan polling menunggu 10 detik. POST tidak otomatis dikirim ulang.

Di produksi, startup memvalidasi `APP_URL`, `ACCOUNT_URL`, dan `APP_BASE_PATH`: keduanya harus HTTPS, domain sama (termasuk `www`), dan folder saudara `/whatsapp` serta `/account`. Contoh untuk situs ini: `https://keepbelanja.com/whatsapp`, `https://keepbelanja.com/account`, `/whatsapp`. Tetap teruskan `Host` dan `X-Forwarded-Proto` di proxy; pastikan PHP Account mengenali HTTPS. Jangan membuka CORS dengan wildcard atau mematikan CSP untuk mengatasi redirect login.

Setelah mengubah `.env`, restart web/worker yang dikelola aaPanel. Jangan mengganti `APP_KEY`. Jika endpoint Account `authorize` masih mengembalikan 400, periksa teks error pada halaman tersebut dan cocokkan `redirect_uri` dengan `https://keepbelanja.com/whatsapp/auth/callback`; jangan menyalin cookie, code, atau token ke log/tiket.

Hubungkan nomor WhatsApp, lalu lakukan login ChatGPT/Claude dari **Pengaturan → AI**, dengan web/worker berjalan sebagai user OS yang sama:

- ChatGPT: klik Hubungkan, salin **Device code**, buka Login, dan masukkan kode di halaman OpenAI. Tidak ada kode balasan yang ditempel ke WhatsApp.
- Claude: klik Hubungkan lalu Login; jika browser menampilkan authentication code, tempel **seluruh kode termasuk `#state`** pada kolom Authentication code di WhatsApp, lalu klik Verify atau tekan Enter.
- Tunggu status Connected. Pengiriman kode belum berarti autentikasi berhasil. Jika kode kedaluwarsa atau bukan dari login terbaru, gunakan Restart login dan ambil kode baru.

Form kode tidak ikut autosave, tidak disimpan ke database/localStorage, dan dikosongkan setelah dikirim. Endpoint verifikasi memakai proteksi login, CSRF, workspace aktif, serta ID sesi login. Jangan membagikan kode atau token melalui chat/log/tiket.

Jalankan **satu instance web**, bukan cluster: proses login yang menunggu kode disimpan di memori proses web per workspace. Restart web saat login berlangsung membatalkan alur tersebut; mulai login lagi setelah restart. Worker juga tetap satu instance.

### MCP Codex: callback domain publik

Jika `APP_URL` memakai HTTPS, login MCP melalui Codex mendaftarkan callback publik **sebelum** membuka persetujuan OAuth:

```text
https://keepbelanja.com/whatsapp/oauth/mcp/callback/<id-login>
```

Setelah disetujui, browser kembali ke WhatsApp → Data bisnis. Tidak perlu menyalin URL callback. Berlaku juga untuk MCP Fit, Store, Material, Invoice, dan sumber lain yang menerima DCR dengan callback HTTPS. Login lokal HTTP serta MCP Claude tetap memakai alur callback manual di bawah. Jangan mengganti host pada tautan OAuth yang sudah terbit; callback terikat pada registrasi klien dan pertukaran token. Mulai ulang login setelah deploy.

Persiapan aaPanel sebelum memakai login publik:

1. Pastikan `.env` memakai `APP_URL=https://keepbelanja.com/whatsapp` dan `ACCOUNT_URL=https://keepbelanja.com/account`.
2. Listener callback Codex memakai `MCP_OAUTH_CALLBACK_PORT=3334` (default). **Blokir akses masuk dari internet ke port 3334 pada firewall server/security group**, tetapi izinkan loopback. Jangan membuka port ini atau memasangnya sebagai situs publik: Codex bind `0.0.0.0` ketika callback memakai domain non-lokal. Browser hanya perlu akses HTTPS 443. Jangan gunakan port web 3333 sebagai port callback.
3. Pada konfigurasi situs Nginx, tambahkan blok `/whatsapp/oauth/mcp/callback/` dari `deploy/nginx-rewrite.conf`. Blok ini mematikan access log untuk URL berkode OAuth dan tetap meneruskan request ke **WEB 3333**, bukan langsung ke CLI 3334. Jika Nginx mencatat error request, jangan membagikan log mentah yang berisi query callback.
4. Setelah build dan restart otomatis selesai (atau restart manual bila memakai `--no-restart`), pilih **Restart login → Login**. Build tidak memperbarui Nginx/firewall.

WEB memeriksa login Account, workspace aktif, sesi pemulai, ID login, state dan callback path, baru meneruskan kode ke listener lokal. CLI tetap memverifikasi issuer dan PKCE. Hasil browser dibersihkan dengan redirect ke settings tanpa query kode. Sesi kedaluwarsa, berubah nomor, restart web, atau callback lama wajib memulai login baru. Satu login MCP publik diproses pada satu waktu agar listener tidak bentrok; ini tidak membatasi jumlah koneksi MCP yang sudah aktif.

Referensi callback: [OpenAI Docs — MCP OAuth callbacks](https://developers.openai.com/codex/mcp/).

### Callback manual: lokal HTTP / MCP Claude

Pada **Pengaturan → Data bisnis**, klik Hubungkan lalu Login pada sumber MCP. Jika setelah persetujuan browser gagal membuka `127.0.0.1:<port>/callback`, salin URL **lengkap** dari bilah alamat ke kolom **Callback URL** pada koneksi MCP yang sama, lalu Verify. Browser berada di komputer Anda, sedangkan listener CLI berada di server aaPanel. Kolom ini meneruskan callback ke listener CLI di server, tanpa membuka port publik atau SSH tunnel. Halaman gagal di tab OAuth boleh ditutup setelah status Connected muncul di WhatsApp.

Verifikasi hanya menerima tujuan loopback/port/path dan state dari CLI pada login aktif, terikat ke workspace, provider dan ID login; tidak mengikuti redirect. Kode tidak disimpan ke database/log/browser storage. Jangan membagikan URL tersebut ke chat. Jika login telah kedaluwarsa (10 menit), web di-restart, atau callback gagal, pilih Restart login dan gunakan URL baru. Status Connected hanya muncul setelah CLI selesai berhasil. Jika callback sudah dikirim tetapi hasil belum jelas, jangan kirim kode yang sama berulang kali.

Proses OAuth memerlukan persetujuan Anda dan akses jaringan. Kredensial mengikuti direktori OAuth workspace/nomor aktif; jangan menjalankan login CLI dengan home/config sembarang karena aplikasi bisa tidak membaca akun tersebut. Build tidak mengubah kredensial dan skrip deploy tidak mengaktifkan AI.

### Fetch Safari gagal berulang / status MCP belum diperbarui

Pesan browser `due to access control checks` saja belum membuktikan penyebabnya
CORS. Jangan membuka CORS wildcard atau mematikan CSP/login untuk menghilangkannya.
Klien `workspace-3` menghentikan polling biasa ketika koneksi gagal; hanya satu
heartbeat terautentikasi mencoba lagi dengan jeda. Setelah tiga kegagalan beruntun,
retry otomatis dijeda. Tombol **Retry** atau event jaringan kembali online dapat
memeriksa ulang. POST/pengiriman pesan/pembayaran tidak pernah diputar ulang otomatis.
Ini menangani pemulihan/polling, bukan jaminan memperbaiki penyebab jaringan server.

Jika masih gagal, klik **Copy diagnostics** pada notifikasi koneksi. Laporan berisi
versi klien, origin, jenis kegagalan, path tanpa query, HTTP status, dan request ID
jika tersedia. Tidak menyertakan cookie, token, kode OAuth, atau isi respons. Cocokkan
request ID/waktu dengan log Nginx/WEB, atau periksa Network Safari. `csp_blocked`
menunjukkan pelanggaran kebijakan; `network_error` belum membedakan TLS, jaringan,
pemblokir browser, atau koneksi server yang ditutup. HTTP 401 dengan
`X-WhatsApp-Auth: required` tetap mengarahkan ke halaman login melalui navigasi.

Status login MCP mengikuti provider yang dipilih: Claude dan ChatGPT memiliki
otorisasi terpisah. Tooltip menunjukkan providernya. Gagal mengambil status tidak
mencabut kredensial atau mematikan saklar sumber; UI menampilkan status belum dapat
diperiksa, lalu menyegarkannya saat koneksi pulih/menu Data bisnis dibuka.
Perubahan ini perlu pull, build, dan restart WEB setelah commit dipush; konfigurasi
aaPanel dan browser yang masih menjalankan `workspace.js?v=2` belum memakai klien baru.

Referensi: [AdonisJS deployment](https://docs.adonisjs.com/deployment), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Claude Code setup](https://code.claude.com/docs/en/setup).
