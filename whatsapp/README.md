# WhatsApp

**Beta 2 (jalur ramping)** aktif secara bawaan: satu skill `cs-inti`, katalog digest, contoh jawaban CS, tanpa MCP saat membalas, ±5rb token per balasan. Panduan dan format data: [docs/lean-beta2.md](docs/lean-beta2.md). Matikan toggle *Beta 2* di Pengaturan → Perilaku untuk kembali ke jalur lama yang dijelaskan di bawah.

AdonisJS 7, MySQL, Baileys, Account OAuth, dan ChatGPT OAuth melalui Codex CLI lokal. Balasan AI default nonaktif, tidak memakai API key, dan perilakunya berasal dari satu atau beberapa `SKILL.md` yang diimpor. Daftar skill tidak dibatasi jumlahnya, nama yang sama diperbarui saat diimpor ulang, dan setiap skill dapat dihapus dari Pengaturan. AI dapat menganalisis foto, stiker, GIF, dan frame video, serta diberi akses baca ke data bisnis Store, Material, Invoice, dan Fit Advisor melalui MCP OAuth dari halaman Pengaturan.

## Deploy aaPanel

Pemasangan standalone satu perintah: lihat `docs/install.md`. Untuk server bundle Linux/aaPanel setelah pull, jalankan `bash deploy/build.sh` dari root repository. Panduan build, dependency Codex/Claude, OAuth, dan proses web/worker: [Deploy aaPanel](../deploy/WHATSAPP-AAPANEL.md).

## Arsip per nomor WhatsApp

Tombol **Putuskan** atau logout dari perangkat WhatsApp mengarsipkan workspace nomor tersebut (tidak menghapus data). Saat nomor yang sama dipasangkan lagi, workspace lama dipakai kembali. Nomor berbeda mendapatkan workspace terpisah dengan AI **off** dan pengaturan awal.

Yang dipisahkan: chat, kontak, media/foto profil, cart/order, pembayaran/saldo, goal, antrean AI/sinkronisasi, usage/evaluasi, skill, MCP dan OAuth-nya, metode pembayaran, pengaturan AI dan produksi, serta routing grup order. Login Account untuk masuk aplikasi tetap sama. Preferensi bahasa/sidebar di browser menggunakan kunci per nomor.

Gangguan jaringan sementara atau restart worker **tidak** mengarsipkan nomor. Worker menunggu pekerjaan lama berhenti sebelum memasangkan nomor lain. Pengiriman memeriksa workspace aktif lagi; antrean hanya dapat diproses oleh nomor pemiliknya. Tab browser lama dimuat ulang saat workspace berubah, termasuk menutup room/cart yang sebelumnya terbuka.

Implementasi memakai `init_model`, tanpa migration. Registry global berada di `whatsapp_workspaces` dan `whatsapp_workspace_state`. Data instalasi lama tetap di tabel asal, nomor berikutnya memakai awalan `w<ID>_` dalam database yang sama. `w0_` adalah tampilan kosong saat terputus (tidak bisa menyimpan pengaturan). Jangan mengubah prefix atau menyalin tabel antar-nomor secara manual. Jika nomor pemilik data lama tidak dapat dikenali dari koneksi/creds Baileys, data lama tetap diarsipkan tanpa dikaitkan ke nomor baru.

Kredensial AI nomor baru berada di `storage/whatsapp-workspaces/<ID>/`; direktori ini privat, diabaikan Git, dan harus ikut backup bersama seluruh database dan media. Nomor baru login melalui Pengaturan. Kredensial global instalasi lama tetap dipakai **hanya** oleh nomor lama. Pengaturan direktori mengikuti [OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-advanced) dan [Claude Code authentication](https://code.claude.com/docs/en/authentication).

Setelah memperbarui fitur ini, restart **web dan worker**, bukan klik Putuskan. Pastikan hanya satu worker berjalan. Reverse proxy harus meneruskan `/media/*` ke aplikasi agar pemeriksaan akses per nomor tetap berlaku; jangan mengekspose folder `public/media`/`storage` dengan alias statis. Jalankan `app:init` seperti biasa; tabel nomor arsip diperbarui secara lazy saat nomor itu aktif kembali.

Tes integrasi `tests/functional/workspace_isolation.spec.ts` hanya boleh dijalankan dengan database kosong bernama `whatsapp_workspace_test_*`, tidak dengan database produksi. Tes tidak memasangkan nomor atau mengirim WhatsApp sungguhan.

## Menjalankan di XAMPP

Aktifkan Apache dan MySQL, lalu buat databasenya:

```bash
/Applications/XAMPP/xamppfiles/bin/mysql -u root -e "CREATE DATABASE IF NOT EXISTS whatsapp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
cd /Applications/XAMPP/xamppfiles/htdocs/alogaritm--app/whatsapp
npm install
codex login --device-auth
```

Terminal pertama:

```bash
npm run dev
```

Terminal kedua:

```bash
node ace whatsapp:listen
```

Buka `http://localhost/alogaritm--app/whatsapp/`.

Tabel dibuat otomatis oleh `app/services/init_model.ts` saat web atau listener pertama kali dijalankan, mengikuti pola `Init_model` CodeIgniter.

Worker mengirim heartbeat setiap 5 detik. Tanpa heartbeat dalam 20 detik, halaman cukup menampilkan “Belum terhubung”, menyembunyikan QR lama, dan menolak permintaan koneksi baru dengan HTTP 503. Banner teknis/diagnostik koneksi tidak ditampilkan ke pengguna; detail tetap tersimpan internal. Status database `connecting` saja bukan bukti worker sedang berjalan. Menjalankan XAMPP tidak otomatis menjalankan proses Node worker. Sesudah perubahan versi worker, proses worker perlu dijalankan ulang; pengaturan AI tidak diubah otomatis oleh halaman status.

Sinkronisasi menyimpan setiap pesan secara terpisah: satu kegagalan tidak membuang sisa batch. Pesan gagal masuk ke `whatsapp_sync_retries` untuk maksimal lima percobaan dengan jeda bertahap dan deduplikasi ID. Antrean tersimpan bertahan setelah restart; saat database tidak dapat diakses, cadangan sementara hanya ada di memori sampai database pulih. Kegagalan permanen tetap berstatus `failed` untuk diperiksa, bukan dihapus. Retry ini bukan pengiriman ulang balasan keluar yang statusnya belum pasti. Foto profil dan media riwayat tidak menahan penyimpanan chat berikutnya. Pesan yang belum pernah diterima Baileys tetap bergantung pada pengiriman/sinkronisasi WhatsApp; ini bukan jaminan mengambil seluruh arsip dari server.

Antar-bubble balasan, worker menunggu sinkronisasi singkat hingga 10 detik dan memeriksa ulang konteks/izin, bukan langsung membatalkan gambar karena echo pesan sendiri. Koneksi putus, konteks baru, AI off, atau takeover CS tetap membatalkan keluaran lama. Timeline membedakan teks terkirim dari gambar terkirim. Init model menghapus perilaku `created_at ON UPDATE` bila ditemukan pada tabel pesan lama; waktu yang sudah terlanjur bergeser tidak direkonstruksi tanpa sumber asli. Polling room memakai cursor maju untuk menutup celah ketika pesan baru melebihi satu halaman.

## Sisa kuota akun AI

Pengaturan → Usage menampilkan sisa kuota per provider/periode, waktu reset dan waktu observasi. Statistik token aplikasi tetap terpisah. Data null/tidak didukung ditampilkan sebagai belum tersedia, bukan 0% atau 100%. Data lebih dari 5 menit/refresh gagal ditandai sebagai laporan terakhir; setelah waktu reset lewat persentase disembunyikan sampai ada data baru.

- ChatGPT/Codex: pembacaan metadata `account/rateLimits/read` melalui app-server CLI OAuth workspace. Tidak memulai thread, turn, tool atau login. Poll browser 30 detik hanya saat Usage terlihat, cooldown bersama di DB 60 detik, timeout CLI 8 detik. Memakai periode yang dilaporkan provider, tidak mengasumsikan semua akun punya periode sama. Lihat [protokol resmi Codex](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- Claude: menyimpan `rate_limit_event` dari proses AI yang memang sedang berjalan, termasuk `unifiedWindows` bila CLI menyediakannya. Tidak menjalankan prompt tambahan atau membaca endpoint OAuth privat untuk mengecek kuota. Persentase hanya tersedia jika CLI melaporkan `utilization`; tombol refresh membaca observasi tersimpan, bukan memaksa panggilan AI. Lihat [RateLimitInfo resmi Claude](https://code.claude.com/docs/en/agent-sdk/python#ratelimitinfo).
- Init model membuat `whatsapp_ai_quota` per workspace untuk dibaca WEB/WORKER setelah restart. Login baru melalui pengaturan mengubah generation dan membersihkan kuota sebelumnya; hasil terlambat dari proses login lama diabaikan. Endpoint `/api/ai/quotas` tetap dilindungi Account dan workspace; tidak mengembalikan token, stderr, atau identitas akun.

Tes: `node ace test unit --files=tests/unit/ai_quota.spec.ts`, `node scripts/test_cart_discount_database.mjs --ai-quotas`, dan `node --test tests/ai_quota_ui.test.mjs`. Semuanya memakai data/proses tiruan dan tidak memanggil provider AI.

## Produksi & Pre-order

Pengaturan lokal tersedia di `/settings#production`, terpisah untuk preorder dan custom. Isi estimasi sampai siap dikirim, batas minimum–maksimum yang benar-benar dapat dipenuhi, jenis hari, dan pemicu awal hitungan sebelum mengaktifkan aturan. Nilai awal kosong/nonaktif; angka dari MCP tidak disalin otomatis. Autosave memakai versi agar edit pemilik tidak ditimpa hasil evaluasi lama. Tabel `whatsapp_production_policy`, `whatsapp_production_signals`, dan `whatsapp_production_changes` dibuat oleh init model, tanpa migration.

Auto-adjust memakai skill eval/evaluation yang sudah diimpor, ketika AI dan worker aktif. Evaluator menghasilkan observasi terstruktur, bukan menulis pengaturan langsung. Backend hanya menerima bukti ID pesan pelanggan dari snapshot evaluasi yang berhasil; satu room dihitung satu suara, dan bukti versi sebelumnya tidak dipakai ulang. Minimal 3 pelanggan, dukungan 80%, observasi maksimal 30 hari, perubahan 1 hari dalam batas pemilik, maksimal sekali per 7 hari. Mematikan auto-adjust tetap mengumpulkan observasi tanpa mengganti estimasi. Riwayat menyimpan sebelum/sesudah, alasan dan contoh percakapan pendukung. Ini eksperimen berbasis sinyal pelanggan, bukan bukti kenaikan konversi atau pengukuran kapasitas produksi otomatis.

AI menerima kebijakan lokal pada setiap giliran, termasuk saat pengaturan belum diisi. Penentuan dan estimasi pre-order berasal dari pengaturan WhatsApp serta keputusan pesanan lokal pemilik/CS, bukan label, aturan, durasi, atau hasil cache MCP. AI tidak perlu memanggil MCP untuk menentukan apakah pre-order diizinkan. Aturan estimasi aktif tidak otomatis menjadikan semua produk pre-order; stok kosong juga tidak otomatis berarti pre-order/custom. Pengaturan kosong/nonaktif tidak boleh diisi dari MCP sebagai fallback. Harga, stok aktual, ukuran, gambar, dan detail produk tetap dapat diverifikasi melalui MCP; persetujuan custom tetap mengikuti keputusan yang relevan. Perubahan hanya untuk estimasi baru, tidak mengubah order, janji pelanggan, tahap produksi aktual, atau lama kurir. Progres/tanggal selesai per order tetap membutuhkan data aktual; jangan disimpulkan dari estimasi umum.

## Pengaturan dan usage

Daftar room diurutkan berdasarkan waktu pesan terakhir (termasuk jawaban AI/CS), dengan ID sebagai pembeda saat waktunya sama. Badge menghitung pesan masuk yang belum dibuka di workspace. Read watermark lokal disimpan per room; saat room terlihat, tab aktif, dan posisi di pesan terbaru, browser menandai sampai pesan yang telah dimuat. Memuat riwayat di belakang atau tab tersembunyi tidak menandai baca. Ini tidak mengubah read receipt WhatsApp atau status kiriman. Pelacakan workspace baru mulai tersedia sejak fitur ini; riwayat yang belum punya watermark masih dapat dihitung.

Pengaturan dibagi menjadi menu AI, Skill, Data bisnis, Perilaku balasan, dan Usage. Setiap bagian memiliki partial sendiri di `resources/views/partials/settings/`. Perpindahan menu tidak menghapus isian yang belum disimpan.

Usage mencatat proses AI sejak fitur diaktifkan: token input/output, cache yang dibaca, durasi, dan kegagalan, dipisahkan menurut provider selama 30 hari kalender termasuk hari ini (WIB). Proses analisis lanjutan dihitung terpisah. Token yang tidak dilaporkan provider ditandai kosong, bukan nol. Ini bukan sisa kuota langganan OAuth. Tabel `whatsapp_ai_usage` dibuat lewat init model; prompt dan isi pesan tidak disimpan di tabel usage.

Tes backend: `node ace test unit functional`. Tes menu desktop/mobile: jalankan `npx playwright install chromium`, lalu `node ace test browser`. Tes browser memakai halaman hasil render server dan mencegat aksi API agar tidak mengubah pengaturan atau mengirim pesan.

## Pemeriksaan data bisnis

### Order dan produksi internal

Sidebar **Order** membuka daftar pesanan lokal beserta pembayaran, tahap produksi, tanggal aktual, estimasi tersimpan, dan riwayat perubahan. Order lama tetap belum terverifikasi sampai operator mengisi datanya. Pembayaran baru menempatkan order dalam antrean, bukan otomatis menyatakan produksi sudah dimulai. Estimasi disimpan saat pembayaran yang memenuhi ketentuan; perubahan pengaturan tidak mengubah janji order lama. Untuk hari kerja, tanggal selesai diisi operator karena kalender kerja belum tersedia.

Pilih grup tujuan per order, atau atur grup default untuk order baru. Pemicu dapat berupa pembayaran pertama/DP terverifikasi atau lunas terverifikasi. Hanya konfirmasi dana oleh operator yang membuat antrean; gambar bukti transfer saja tidak cukup. Order lama tidak dikirim massal setelah mengubah default. Memilih grup pada order lama yang sudah memenuhi pembayaran dapat mengantrekannya setelah konfirmasi.

Worker mengirim nomor order, nama pelanggan, produk, ukuran/pengukuran, jumlah, dan foto produk sebagai lampiran. Alamat, telepon, bukti transfer, dan catatan bebas tidak disertakan. Pengiriman dicatat per bagian untuk mencegah pengulangan bagian yang sudah sukses. Kegagalan persiapan dicoba maksimal tiga kali. Jika hasil kirim tidak pasti, periksa grup: tandai sudah terkirim atau konfirmasi belum terkirim sebelum mencoba ulang. Tidak ada jaminan exactly-once saat transport terputus; karena itu hasil ambigu tidak dicoba otomatis.

### Bahasa antarmuka

Kamus UI berada di `public/lang/en.js` dan `public/lang/id.js`; petunjuk ada di `public/lang/README.md`. Semua halaman memakai runtime `public/assets/i18n.js` dan kamus bersama. English adalah default, pilihan bahasa disimpan di browser. Isi percakapan, nama pelanggan/produk, data bisnis, dan skill tidak diterjemahkan otomatis.

Pertanyaan ukuran saat ini yang menyebut jenis pakaian, tinggi, dan berat memiliki validasi Fit tersendiri: hasil `business_fit.fit_advisor` harus berhasil dan cocok dengan input pelanggan. Handoff `human_authorization`, tool lain, atau flag lookup false tidak melewati validasi ini. Jika hasil Fit tersedia, keluaran harus menangani ukuran atau klarifikasi preferensi yang relevan; urusan produksi lama tetap dicatat terpisah pada note/goal, bukan menelan seluruh pertanyaan baru. Pemeriksaan diulang satu kali bila diperlukan, lalu keluaran ditahan jika masih tanpa bukti. Permintaan eksplisit pelanggan berbicara kepada manusia tetap dihormati. Pemeriksaan ulang room memakai pesan pelanggan terakhir yang belum dijawab; susulan terjadwal tidak menganggap ukuran di riwayat sebagai permintaan baru. Isi skill dan gaya jawaban tidak diubah.

Evaluasi berjalan di worker, satu percakapan setiap kali, setelah pesan/order berubah dan percakapan tenang minimal 15 detik. Memerlukan AI aktif dan skill bernama eval/evaluation/evaluasi (termasuk nama seperti `cs-chameleon-eval`). Menu Evaluasi menampilkan kebutuhan terlewat, bukti pesan, batas analisis, tindak lanjut, dan versi skill. Hasil menjadi konteks giliran AI berikutnya; tidak mengedit skill, mengirim pesan, atau mengubah order/pembayaran. Snapshot memakai 100 pesan terakhir dan tidak menganalisis piksel media ulang. Perubahan baru selama proses membatalkan hasil lama. Kegagalan dicoba lagi saat percakapan/skill berubah, bukan diulang terus.

Order rate di menu Evaluasi adalah pelanggan dengan order aktif yang memiliki pembayaran terkonfirmasi (termasuk DP), dibagi pelanggan dengan pesan masuk di database aplikasi. Ini bukan baseline historis skill atau bukti peningkatan konversi. Waktu pembaruan skill ditampilkan sebagai `5m ago`/`2h ago`/`3d ago`; arahkan ke waktunya untuk tanggal lengkap WIB. Usage evaluasi tercatat bersama pemakaian AI lainnya.

### Tujuan pembayaran

Menu Pengaturan → Pembayaran mengelola beberapa tujuan pembayaran: nama bank/metode, rekening/nomor/tautan HTTPS, atas nama, dan status aktif. Tambah, edit, nonaktifkan, atau hapus disimpan tersendiri tanpa mengubah status AI, koneksi MCP, atau skill. Tidak ada rekening contoh yang diisi otomatis. Tabel `whatsapp_payment_methods` dibuat lewat init model.

AI menerima tujuan aktif terbaru pada semua jalur analisis (termasuk gambar dan susulan). Data pengaturan ini menjadi sumber rekening, bukan contoh dalam skill atau riwayat lama. Perubahan tujuan saat AI memproses membatalkan pengiriman draf lama. Pengaturan bukan bukti pembayaran diterima; aturan DP, kapan meminta pembayaran, konfirmasi, kendala, dan handoff tetap berasal dari skill. Fitur ini tidak memproses pembayaran atau memverifikasi mutasi bank.

Seluruh isi semua skill terimpor disertakan langsung dalam input AI, termasuk aturan di akhir berkas panjang. Berkas skill asli tetap tersedia untuk provider; tidak diubah atau dihapus. Gaya balasan, penggunaan tool, inisiatif, dan keputusan mengikuti skill, tanpa persona, template jawaban, atau skill pencocokan gambar sintetis dari aplikasi.

Aplikasi menyediakan konteks percakapan/media, koneksi MCP baca yang aktif, discovery/skema tool aktual, dan format keluaran. Pesan pelanggan dipisahkan dari catatan internal dan ringkasan audit. Skill dapat memilih `reply`, `handoff`, atau `silent`. Hanya `reply` mengirim pesan; `handoff` mengalihkan room ke CS tanpa pesan/bubble pelanggan, sedangkan `silent` tidak membalas dan tidak mengalihkan room. Teks handoff dari provider selalu dibuang, alasan tetap tersimpan internal. Aturan ini berlaku untuk pesan baru maupun sapuan pesan tertunda. Skill tidak menambahkan kemampuan tool yang belum tersedia pada koneksi MCP.

Jika keputusan menyatakan kebutuhan data bisnis tetapi tidak ada panggilan data MCP aktual, aplikasi meminta evaluasi ulang berdasarkan skill satu kali. Handoff karena data tidak tersedia juga harus memiliki bukti pemeriksaan. Jika tetap tidak diperiksa, balasan ditahan dan proses ditandai gagal. Tidak ada penulisan ulang gaya melalui regex atau template jawaban bawaan. Diagnosis baca tanpa mengirim WhatsApp tersedia melalui `node ace ai:check-business --question="..."` dan menggunakan kuota AI aktif.

## Detail proses AI

### Draft katalog bukan handoff otomatis

Pilihan katalog yang identitas/fotonya sudah terbukti di MCP tetap disimpan sebagai draft jika ukuran belum ditemukan, harga tidak cocok, atau stok belum terbukti cukup. Field internal `catalogVerification: pending` menyimpan status itu di JSON item cart; harga final menjadi null dan checkout saldo/konfirmasi pembayaran tetap ditolak. Detail pilihan (termasuk ukuran, TB/BB, preferensi fit dan pesan sumber) tidak dibuang. Verifikasi produk/foto yang belum ada tidak menghasilkan item katalog rekaan; pilihan tetap dicatat dalam konteks internal tanpa handoff otomatis.

Worker menjalankan maksimal satu pemeriksaan ulang melalui AI/MCP per giliran untuk draft katalog, memakai skill dan konteks terbaru. Perbaikan hanya boleh memperbarui harga terverifikasi pada identitas/ukuran/jumlah/model yang sama; tidak boleh mengganti pilihan demi lolos validasi. Pesan pelanggan baru membatalkan output lama. Jika bukti belum cukup atau provider gagal, satu pertanyaan pilihan non-transaksional yang aman boleh diteruskan dengan goal waiting_answer, tanpa inisiatif tambahan, media, harga, janji stok atau pembayaran. Tanpa pertanyaan aman: silent/waiting, bukan meminta approval CS. Status/kode spesifik dan pemeriksaan ulang terlihat di detail proses.

Ini tidak menganggap stok kosong sebagai custom/pre-order atau persetujuan pemenuhan. Kebijakan pre-order tetap lokal; harga, ukuran, stok aktual tetap fakta MCP. Persetujuan model di luar katalog, ukuran custom, dan kutipan harga manusia tetap memakai pengaman sebelumnya. Uji simulasi tanpa layanan luar: `node scripts/test_cart_discount_database.mjs --catalog-drafts`.

### Pengukuran token per fase dan per bagian prompt

Satu pesan pelanggan dapat memicu beberapa panggilan penuh ke layanan AI (`analysis`, `business-recheck-run`, `comparison`, `visual-recheck`, `catalog-recheck`, `skill_edit`, `evaluation`). Sebelumnya semua tercatat sebagai satu angka gabungan, sehingga tidak terlihat fase mana yang mahal.

**Detail proses** sekarang menampilkan, untuk tiap baris aktivitas:

- Token aktual dari layanan AI pada fase yang benar-benar memanggil model, dengan tooltip rincian input/output/cache dibaca. Ditandai sebagai angka pasti.
- Perkiraan lokal (diawali `≈`, dicetak miring) untuk hal yang dihitung aplikasi sendiri: skema tool MCP yang dikirim dan ukuran hasil tiap tool. Angka ini berasal dari jumlah karakter, bukan dari layanan AI.
- Baris **Ukuran prompt giliran ini** yang memecah prompt per bagian — tiap skill terpisah, aturan goal, aturan cart/order, state cart, riwayat percakapan, memori, skema keluaran — beserta porsi persennya. Ini yang menunjukkan bagian mana yang sebenarnya membebani.
- Total token seluruh giliran pada ringkasan Aktivitas, beserta jumlah panggilan AI dan berapa token yang dibaca dari cache.

Skema tool MCP dan hasil tool dilaporkan karena keduanya dikirim ulang pada **setiap langkah tool** dalam satu panggilan; hasil tool yang besar adalah biaya yang berlipat, bukan sekali bayar.

**Riwayat usage** (`/settings#usage`) mendapat tabel **Token per fase proses**: jumlah proses, input, cache dibaca, output, dan porsi relatif tiap fase selama 30 hari, diurutkan dari yang paling mahal. Tabel Proses terbaru juga menambahkan kolom Fase, dengan rincian input/output/cache pada tooltip baris. Kolom `phase` ditambahkan ke tabel `whatsapp_ai_usage` oleh init model, tanpa migration; baris lama tetap ada dan dikelompokkan sebagai `lainnya`.

Pengukuran ini tidak mengubah isi prompt, urutan bagiannya, perilaku AI, maupun aturan bisnis apa pun — `buildTurnContext` hanya melaporkan ukuran bagian yang sudah disusunnya. Angka perkiraan memakai ±3,7 karakter per token dan sengaja ditampilkan berdampingan dengan angka pasti dari penyedia agar rasionya bisa diperiksa sendiri.

Uji: `node ace test unit --files=tests/unit/prompt_size.spec.ts`, `node --test tests/token_measurement_ui.test.mjs` (Chromium/WebKit, English/Indonesia), dan `node scripts/test_cart_discount_database.mjs` untuk `tests/functional/usage.spec.ts`.

### Digest katalog: daftar produk tidak lagi masuk konteks utuh

Satu giliran terukur 650.682 token. Rinciannya: hanya 6 token benar-benar baru, 431.197 dibaca dari cache, dan 217.383 **ditulis** ke cache. Karena penulisan cache ditagih ~1,25x dan pembacaan ~0,1x, penulisan itu memikul ~83% bobot giliran. Isinya hampir seluruhnya hasil tool: sekitar empat panggilan `list_records` yang masing-masing mengembalikan ~45.000 token, yakni katalog penuh ditarik ke konteks hanya untuk menemukan satu produk.

Bridge MCP kini membentuk ulang hasil listing sebelum masuk konteks, di [catalog_digest_service.ts](app/services/catalog_digest_service.ts):

- **Listing produk tanpa kata kunci** (`list_records` resource produk, atau `list_products`) diganti digest identitas: satu baris `id | nama | kategori` per produk. Untuk 300 produk ini ~6.000 token, turun dari ~45.000.
- **Listing dengan kata kunci** (`q`, `query`, atau `search`) tetap mengembalikan barisnya utuh; hanya field tautan foto yang dibuang (`image_urls`, `images`, `image_url`, `img`, `thumbnail`, `thumbnail_url`), karena itu bagian terbesar tiap baris.

Baris produk dikenali di bawah `rows`, `products`, atau `data`, dan hanya bila setiap baris memang berbentuk produk. Daftar yang bukan produk dilewatkan utuh meski memakai kunci yang sama.

Karena data tersebar di banyak MCP server dengan penamaan tool berbeda-beda, keputusan pembentukan tidak bisa bergantung pada nama tool. Yang dijadikan pagar adalah daftar tool yang hasilnya memang dibaca aplikasi, dan tool itu tidak pernah disentuh: `get_product`, `check_shipping_rates`, `fit_advisor`, `read_conversation_history`, serta seluruh tool panduan bisnis (`list_tutorials`, `search_tutorials`, `get_tutorial`, `list_size_charts`, `search_size_charts`, `get_size_chart`) — hasil panduan membawa `url` yang dibaca `extractBusinessGuides`, jadi harus utuh. Di luar daftar itu, pembuangan field foto berlaku untuk listing server mana pun; field selain foto tidak pernah disentuh, sehingga misalnya `label_url` pada data Orion tetap ada.

Ini aman karena hasil listing tidak pernah menjadi bukti. Tiga jalur yang memakai foto katalog semuanya bersumber dari `get_product`: perbandingan piksel (`prepareCatalogImages` mengunduh dari `product.img`, dan memakai daftar panggilan hanya untuk menemukan server asal, itu pun disaring `get_product`), foto pada item cart (`applyAiCartIntent` mengganti URL apa pun yang tidak ada pada `evidence.products`), dan pengiriman foto ke pelanggan (`outgoing_image_service` menyusun allowlist dari `cartEvidence.products`). URL yang hanya pernah muncul di baris listing tidak pernah masuk ke satu pun dari ketiganya. `extractCatalogProducts` hanya membaca hasil `get_product`, dan `prepareCatalogImages` disuapi dari daftar hasil saringan yang sama, sehingga harga, ukuran, stok, foto, dan pencocokan visual semuanya tetap bersumber dari jalur `get_product`/`get_record` yang tidak disentuh.

Digest sengaja tidak memuat harga maupun stok. Stok adalah field yang paling sering berubah, jadi tidak boleh datang dari snapshot; dan `internal_price` pada baris listing memang bukan harga jual (harga jual per ukuran ada di varian), sehingga menghapusnya sekaligus menutup peluang mengutip angka yang salah. Setiap jalur yang dapat melaporkan stok — `get_record`, `get_product`, `get_product_options`, `store_overview`, dan pencarian ber-`q` — tetap live tanpa cache.

Karena katalog jarang berubah, snapshot di balik digest disimpan 6 jam melalui cache bukti yang sudah ada. Catatan pada digest menyatakan secara eksplisit bahwa daftar itu snapshot dan melarang menyimpulkan produk tidak ada; pencarian ber-`q` selalu menembus ke data terkini, sehingga produk yang baru ditambahkan tetap dapat ditemukan sebelum snapshot berikutnya.

Bentuk yang tidak dikenali dilewatkan apa adanya: hasil error, teks non-JSON, daftar kosong, resource selain produk, dan tool lain tidak diubah sama sekali. Detail proses mencatat `shaped`, `rows`, `charsBefore` dan `savedTokens` agar penghematannya terukur per panggilan.

Uji: `node ace test unit --files=tests/unit/catalog_digest.spec.ts`.

### Cache prompt: baca dan tulis dicatat terpisah

`usageFromEvent` sekarang memisahkan `cache_read_input_tokens` dari `cache_creation_input_tokens`. Keduanya tampil di kartu pemakaian, tabel per fase, tooltip baris fase pada Detail proses, dan ringkasan giliran. Pemisahan ini perlu karena dua kondisi yang terlihat sama pada satu angka gabungan menuntut perbaikan yang berbeda: **tidak ada cache sama sekali** (baca 0, tulis 0) berarti prefix prompt memang tidak pernah cocok, sedangkan **menulis tanpa pernah membaca** (baca 0, tulis besar) justru lebih mahal daripada tanpa cache karena penulisan cache ditagih di atas harga normal.

Urutan render prompt adalah tool, lalu system, lalu messages. Karena definisi tool berada paling depan, urutan tool yang berubah antar pemanggilan membatalkan seluruh prefix. Bridge MCP kini mengurutkan hasil `tools/list` berdasarkan nama sebelum diteruskan, sehingga urutannya stabil meski server sumber mengembalikan urutan yang berbeda-beda. Daftar tool yang tersedia tidak berubah, hanya urutannya yang dijadikan pasti.

Kolom `cache_write_tokens` ditambahkan ke `whatsapp_ai_usage` oleh init model, tanpa migration. Baris lama bernilai null dan ditampilkan sebagai nol.

### Alih mesin AI otomatis saat kuota habis

Pengaturan → AI → **Alih otomatis saat kuota habis** (`aiFailover`, nilai awal nonaktif). Saat aktif dan mesin terpilih menolak giliran karena batas pemakaian, giliran yang sama dijalankan ulang pada mesin satunya, bukan gagal. Mesin cadangan harus sudah login dan memiliki akses MCP sendiri: otorisasi MCP dihitung ulang per mesin, jadi koneksi yang hanya disetujui untuk satu mesin tidak ikut terbawa.

Yang memicu peralihan hanya penolakan dari layanan: `USAGE_LIMIT`, `AI_AUTH_REQUIRED`, dan `ACCESS_DENIED`. Kegagalan format keluaran, bukti bisnis kurang, atau layanan sementara tidak terhubung tidak memicu peralihan dan tidak menghabiskan kuota mesin lain.

Mesin yang menolak ditandai di `whatsapp_ai_quota` (`limited_until`, `limited_code`) sehingga giliran berikutnya tidak mencoba mesin yang sama secara sia-sia: minimal 15 menit untuk batas pemakaian, 10 menit untuk autentikasi, 5 menit untuk sisanya, atau sampai waktu reset yang dilaporkan penyedia bila lebih lama. Jendela kuota yang penuh dan belum reset juga dihitung habis tanpa perlu ada panggilan yang gagal dulu. Giliran yang berhasil menghapus tanda itu, begitu pula login ulang. Jika kedua mesin sedang ditandai habis, giliran tetap memakai mesin pilihan pemilik dan tidak membakar kuota kedua.

Peralihan tercatat di Detail proses (`analysis:failover`) dan kartu kuota menampilkan penanda "Ditandai habis". Fitur ini tidak menaikkan batas, tidak membeli kuota, dan tidak mengubah model/reasoning yang dipilih untuk masing-masing mesin.

Uji simulasi tanpa proses provider: `node scripts/test_cart_discount_database.mjs --failover`.

### Daftar chat dan room chat di layar kecil

Pada lebar ≤900px halaman chat menampilkan satu panel saja. Tanpa `?jid=` yang terlihat adalah daftar chat sepenuh layar beserta tab antreannya; setelah sebuah chat dibuka, daftar dan tab tersembunyi dan room chat mengisi layar dengan tombol kembali di kepala room. Tombol kembali mempertahankan tab antrean yang sedang dipilih. Di layar lebar kedua panel tetap tampil berdampingan seperti sebelumnya dan tombol kembali tidak muncul.

Uji: `node --test tests/chat_mobile_layout_ui.test.mjs` (Chromium/WebKit, English/Indonesia, 390px dan 1440px, tanpa DB/AI/WhatsApp).

### Penanda asal data pada Detail proses

Setiap baris aktivitas diawali ikon asal datanya: awan untuk data langsung dari layanan, monitor untuk hasil cache yang masih berlaku, dan modul memori untuk hal yang dihitung aplikasi sendiri dari data lokal. Legenda ketiga ikon berada tepat di bawah judul Aktivitas, dan setiap ikon membawa label serta penjelasan singkat untuk pembaca layar dan tooltip.

Ikon hanya menandai; penjelasan dan rincian tetap ada. Baris tool MCP kini menampilkan sumber dan nama tool saja (`orion · check_shipping_rates`) karena status cache/langsung sudah dibawa ikon, sedangkan isi detail lengkapnya tetap dapat dibuka seperti sebelumnya.

Uji: `node --test tests/process_failure_ui.test.mjs`.

### Pemenuhan per item: ready dan pre-order

Setiap item cart menyimpan `fulfillment` sendiri (`ready` atau `preorder`) beserta catatan dan pemutusnya, sehingga cart campuran tidak memakai satu estimasi untuk semua barang. Nilai awal selalu `ready`.

Pre-order adalah keputusan lokal manusia, bukan kesimpulan dari stok. Item baru menjadi pre-order hanya bila aturan pre-order pada `/settings#production` aktif **dan** ada keputusan pemilik/CS: tombol **Tandai pre-order** pada item cart di dashboard, atau bukti chat `items[].preorderConsent {requestMessageId, approvalMessageId}` berisi permintaan pelanggan dan balasan CS di room yang sama yang menyebut pre-order secara jelas. Balasan yang mengandung pertanyaan, penolakan, syarat, atau urusan harga/DP/ongkir tidak diterima sebagai keputusan. Keputusan terikat pada barang, ukuran dan jumlah item tersebut: mengubah salah satunya mengembalikan item ke `ready` dan memerlukan keputusan baru.

Stok kosong atau kurang tidak pernah mengubah item ready menjadi pre-order. Kekurangan stok tetap menghasilkan `CATALOG_STOCK_UNVERIFIED` dan draft non-payable seperti sebelumnya. Bila AI mengklaim pre-order tanpa dasar lokal, klaim itu dibatalkan, item disimpan tetap `ready`, dan cart ditandai `PREORDER_NOT_AUTHORIZED` sehingga diteruskan ke CS tanpa membuang pilihan pelanggan.

Pre-order yang sah melewati pemeriksaan stok saja; identitas produk, foto, ukuran dan harga tetap wajib terverifikasi MCP. Bila harga belum tersedia, `unitPrice` tetap null, cart ditandai `PREORDER_PRICE_UNVERIFIED`, dan giliran diteruskan ke CS untuk penetapan harga — bukan pertanyaan aman ke pelanggan, bukan permintaan transfer/DP, dan bukan konfirmasi rekap. Checkout saldo dan konfirmasi pembayaran tetap ditolak karena total belum lengkap.

Saat checkout, `operations.kind` mengikuti jenis paling lambat (custom → preorder → standard) dan `operations.mixedFulfillment` menandai order yang berisi barang ready sekaligus pre-order; rincian per item tetap ada pada snapshot order. Operator tidak dapat mengubah penanda campuran itu dari form produksi.

Preferensi fit seperti slim fit pada ukuran katalog tetap ukuran katalog tersebut dengan catatan fit pada `productionDetails`, bukan size custom. Jawaban singkat seperti "Iya" setelah pertanyaan ukuran hanya menyimpan persetujuan ukuran; rekap checkout tetap memerlukan bukti rekap yang cocok. Perubahan ukuran atau model di luar katalog tetap memakai persetujuan custom/model yang sudah ada.

Uji simulasi tanpa layanan luar: `node scripts/test_cart_discount_database.mjs --preorder`.

### Reset data nomor aktif (Danger zone)

Pengaturan → Danger zone → **Hapus data & mulai dari nol** adalah tindakan permanen terpisah dari hapus chat/media. Dialog menampilkan nomor yang terdampak dan mewajibkan ketikan persis `RESET ALL`; tidak berjalan melalui autosave. Cadangkan data transaksi sebelum memakai fitur ini.

Reset menghapus chat, media percakapan/referensi pesanan, cart, order, pembayaran, ledger saldo, alamat tersimpan, bukti persetujuan, ringkasan/memori AI, cache analisis/MCP, evaluasi, goal, dan antrean pengiriman/grup/follow-up **hanya pada workspace nomor aktif**. Identitas kontak/foto profil dan pengecualian AI tetap ada; catatan/handoff kontak dibersihkan. Akun OAuth, skill (termasuk aturan pembelajaran umum), pengaturan, panduan video, routing grup, konfigurasi produksi/pembayaran, serta statistik penggunaan tetap ada. Referensi percakapan dalam riwayat pembelajaran dibersihkan. ID internal tidak diulang agar tidak bentrok dengan referensi eksternal.

Worker menutup transport sementara tanpa logout, menunggu pekerjaan aktif selesai, lalu memproses manifest file yang dapat dilanjutkan saat gagal/restart. Penghapusan tabel allowlist dan rotasi versi workspace dilakukan atomik; riwayat WhatsApp sebelum batas reset ditolak saat replay. WEB dan WORKER harus sama-sama versi baru (capability `reset_worker_id`). Tidak ada DROP/TRUNCATE, panggilan AI/MCP, atau pengiriman pesan untuk reset. Reset tidak menghapus data/percakapan pada perangkat WhatsApp, data eksternal Orion/MCP, maupun membatalkan AWB/pesanan yang sudah terkirim ke layanan lain; AI tetap bisa membaca data eksternal jika diizinkan tool/skill.

Pengujian: `node scripts/test_cart_discount_database.mjs --chat-cleanup` membuat database localhost sementara, bukan database aplikasi. `node --test tests/chat_cleanup_ui.test.mjs` memakai API tiruan dan mendukung `PLAYWRIGHT_BROWSER=chromium` (default WebKit).

### Jam kerja AI

Pengaturan → **Jam kerja AI** menyimpan jadwal per nomor WhatsApp melalui init model (tanpa migration). Default **24/7** menjaga perilaku sebelumnya; saklar **Balas otomatis** tetap harus aktif. Mode **Hari & jam tertentu** memakai hari mulai (Sen–Min), satu rentang jam, dan zona IANA (default Asia/Jakarta; juga WIB/WITA/WIT/UTC). Jam selesai eksklusif; 22:00–06:00 pada Senin berarti Senin malam sampai Selasa pagi. Tanpa hari terpilih, AI tidak bekerja. Autosave tanpa tombol simpan.

Di luar jadwal, inbox menampilkan penanganan manusia tanpa mengubah handoff CS/whitelist yang tersimpan. Worker menahan balasan baru, review, susulan, pemberitahuan pembayaran/model/pengiriman, dan pengiriman hasil AI yang melewati batas jam. Proses pengiriman berbasis AI juga menunggu jadwal aktif. Pesan tetap diterima; operator tetap dapat mengirim. Sinkronisasi WhatsApp, pengiriman ringkasan order ke grup, dan evaluasi internal bukan balasan pelanggan dan tidak dimatikan oleh jadwal ini.

Saat jadwal dibuka kembali (termasuk restart worker dalam jadwal), antrekan pemeriksaan chat dengan pesan terakhir masuk dan belum dijawab, dalam batas usia chat di pengaturan. Chat yang diambil alih CS atau dikecualikan dari AI tidak direbut. Jadwal bukan jaminan operator sedang online dan tidak mengirim pemberitahuan otomatis tambahan.

Tes: `node scripts/test_cart_discount_database.mjs --work-schedule` (DB sementara, mock transport/provider) dan `node --test tests/ai_work_schedule_ui.test.mjs` (Chromium/WebKit, API tiruan, English/Indonesia, dark/light, desktop/mobile).

### Tujuan percakapan dan inisiatif

`whatsapp_chat_goals` menyimpan tujuan per pelanggan, kebutuhan yang ditunggu, langkah berikutnya, jadwal, dan jumlah percobaan susulan; dibuat otomatis lewat init model, tanpa migration. Balasan utama (`message`) dan satu inisiatif yang relevan (`initiative`) dikirim sebagai pesan terpisah. Tidak ada pemisahan kalimat otomatis atau template inisiatif bisnis di worker.

Worker memeriksa goal jatuh tempo setiap menit bila AI dan sapuan aktif. Model menentukan kelayakan dan kebijakan susulan dari skill terimpor (nama skill, bukti, jeda, batas, jam kirim, zona waktu); tanpa kebijakan valid tidak ada jadwal. Batas teknis maksimal 10 percobaan, batas yang lebih kecil dari skill tetap dipakai. Skill bisnis saat ini menentukan maksimal dua susulan. Setiap pemicu memuat ulang skill/konteks dan memeriksa data bisnis sesuai skill, bukan memakai jawaban lama.

Pesan pelanggan/manusia baru membatalkan output serta jadwal lama. AI off atau mode CS mencegah pengiriman; tujuan selesai tidak dijadwalkan. Penghapusan/perubahan skill sumber membatalkan jadwalnya. Percobaan dicadangkan secara atomik sebelum proses terjadwal dimulai, sehingga proses gagal/terputus tidak diulang otomatis dan tidak berisiko mengirim susulan ganda. Counter tidak direset oleh model atau pergantian topik. Jika proses terputus atau waktu kirim terlewat saat menyiapkan jawaban, goal dijeda sampai dievaluasi pada pesan baru. Worker harus tetap berjalan untuk menjalankan jadwal; menyimpan goal saja tidak menjalankan Node saat XAMPP berhenti.

Goal baru mulai dicatat pada giliran berikutnya; riwayat lama tidak otomatis diberi jadwal. Pada detail proses tersedia bagian “Tujuan & tindak lanjut”.

Memahami pesan dan menjalankan AI/MCP hanya memperbarui aktivitas internal, tanpa presence WhatsApp `composing`. Untuk balasan AI yang benar-benar dikirim (termasuk pesan tertunda), urutannya: read receipt pesan terkait → online → typing selama persiapan pengiriman → kirim → hentikan typing. Online kembali idle setelah semua pengiriman paralel selesai. Status AI/room diperiksa lagi sebelum kirim; handoff/silent tidak memicu alur ini. Tampilan read receipt/online di perangkat pelanggan tetap mengikuti aturan privasi WhatsApp.

Room chat menampilkan aktivitas saat ini di atas form pesan. Klik baris tersebut untuk membuka panel audit, atau gunakan “Detail proses” pada balasan AI untuk melihat riwayatnya. Panel memuat input/konteks, skill yang disediakan, lifecycle tool MCP (parameter dan hasil ringkas yang disamarkan), durasi, dan ringkasan dasar keputusan dari AI. Ringkasan itu perlu diperiksa terhadap bukti tool; bukan penalaran internal mentah.

Audit baru tersimpan di `whatsapp_ai_traces` sejak worker versi ini dijalankan, memakai init model tanpa migration. Pesan lama tidak dibuatkan audit rekaan. Endpoint hanya tersedia setelah login Account dan dibatasi pada room yang diminta. Payload dibatasi ukurannya dan kredensial disamarkan; event reasoning/thinking tidak direkam. Proses yang terhenti tanpa pembaruan lebih dari 4 menit ditandai terputus. Tes tidak mengirim pesan ke pelanggan atau memanggil model berbayar.

### Optimasi token dan pengaman loop

Runtime menyaring skema MCP sesuai daftar tool bisnis yang sama untuk Codex dan Claude. Claude menggunakan prompt tugas ringkas dan hanya built-in `Read` bila ada gambar. Isi skill tetap utuh di prompt, tanpa salinan berkas skill runtime. Tool riwayat tetap tersedia pada analisis pelanggan dan verifikasi bisnis/visual; tugas snapshot seperti receipt/evaluasi tidak memuat arsip tambahan.

Seluruh identitas katalog, riwayat, memori, cart/order serta bukti bisnis tetap dipertahankan. Tidak ada batas tetap jumlah tool: pengaman hanya menghentikan empat hasil MCP berturut-turut dengan sumber, tool, argumen dan hasil identik (`AI_TOOL_LOOP`). Bukti baru memutus urutan tersebut. Ini pengaman pengulangan, bukan batas token. Lihat [audit dan hasil pengukuran](audits/2026-09-20-token-efficiency.md) untuk penghematan overhead skema dan batas verifikasi produksi.

### Waiting tidak mengulang analisis pesan yang sama

Keputusan AI yang selesai, termasuk `silent`/`waiting`/`waiting_answer`, menyimpan `analyzed_anchor_id` pada goal. Sapuan backlog, reconnect, pembukaan jam kerja dan aktivasi AI melewati pesan yang sudah dianalisis, sebelum menyusun konteks atau memanggil provider. Klaim giliran dikunci dalam transaksi agar dua worker tidak memproses pesan yang sama. Penanda tetap tersimpan ketika goal dibatalkan atau mode CS/AI berubah; seluruh konteks tetap tersedia untuk pesan berikutnya.

Pesan pelanggan/CS baru, keputusan manusia (`human_decision`), serta susulan yang benar-benar jatuh tempo dan lolos kebijakan skill tetap diproses. Susulan memakai jalur klaim jadwal tersendiri; status menunggu sendiri tidak memicu analisis. Evaluasi background tetap memakai pemeriksaan perubahan snapshot yang sudah ada.

Kolom dan pengisian penanda untuk goal waiting/completed lama ditangani `app:init`, tanpa panggilan AI. Terapkan build dan init model sebelum worker baru dijalankan. Uji terisolasi: `node scripts/test_cart_discount_database.mjs --waiting` (database sementara, mock AI/WhatsApp).

### Pemulihan analisis gagal

Validator persetujuan desain membandingkan fakta per bagian pakaian dan pesan sumbernya. Penulisan ulang catatan yang setara dapat mempertahankan bukti CS, sedangkan perubahan desain, topik persetujuan lain, atau detail yang belum didukung tidak ikut disetujui. Lihat [audit maksud dan cakupan persetujuan](audits/2026-09-20-consent-intent.md) untuk matriks kasus, hasil pengujian, dan batasnya.

Selama AI aktif, room AI dapat mencoba ulang kegagalan sementara sebelum tahap perubahan cart/pembayaran/pengiriman. Maksimal dua retry per pesan, dengan jeda 30 detik lalu 2 menit; batas kuota menunggu cooldown provider. Jadwal dan hitungan disimpan di `whatsapp_chat_goals.recovery_json`, dan UI menampilkan **Menunggu percobaan ulang** beserta jadwalnya. Event `analysis-retry` juga tersedia di diagnostik baca-saja. Chat yang telah selesai dianalisis tetap mengikuti pengaman waiting di atas.

Setelah restart, analisis yang memiliki catatan pemilik proses hanya dipulihkan jika proses worker sebelumnya terbukti tidak ada pada host yang sama. Status trace stale saja tidak cukup. Kegagalan lama yang paused dipulihkan hanya jika trace mendukung kegagalan provider yang dapat dicoba ulang; handoff teknis `Referensi persetujuan model tidak valid.` diperiksa ulang satu kali pada room yang sudah AI. Room CS, AI off, konfigurasi/autentikasi salah, serta pengiriman yang hasilnya belum pasti tidak dicoba ulang otomatis. Sesudah batas retry habis, room tetap paused untuk pemeriksaan. Tidak ada jaminan provider yang terus gagal akan menghasilkan jawaban.

Terapkan melalui skrip deploy yang sama dan restart WEB/WORKER; init model menambahkan kolom recovery. Uji terisolasi: `node scripts/test_cart_discount_database.mjs --analysis-retry` (database sementara, provider dan pengiriman tiruan).
