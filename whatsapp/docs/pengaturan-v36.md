# Pengaturan v3.6 — 5 halaman, "Lanjutan" dilipat

Catatan perubahan + titik yang bersinggungan, supaya error bisa ditangani lebih awal.

## Struktur baru

| Halaman (`#hash`) | Isi utama | Lanjutan |
|---|---|---|
| Koneksi `#connect` | WhatsApp (nomor), Instagram, akun AI (+ saklar Balas otomatis), Jev (kunci + aktif) | model & kecepatan akun utama (sudah ada di kartu AI); keputusan Jev (di kartu Jev) |
| Toko `#store` | Pembayaran, Berat & ongkir, Produksi & Pre-order | Sumber data toko (MCP) + kebijakan tukar size |
| Cara AI membalas `#reply` | Jadwal AI, saklar sapuan, kontak yang tidak dibalas, Skill CS | Aturan toko & kasus uji, Editor skill; angka waktu tunggu/riwayat/sapuan (di kartu Perilaku) |
| Pemakaian `#usage` | Token, kuota, proses terbaru, **Akurasi Jev** (dipindah dari Jev) | — |
| Aplikasi & data `#app` | Tampilan, bahasa, domain, Backup | Hapus chat & media, Reset data |

Tautan lama (`#ai`, `#instagram`, `#numbers`, `#backup`, `#jev`, `#business`, …) tetap jalan: `settings.js`
mengalihkan ke halamannya, membuka "Lanjutan" bila bagiannya ada di situ, lalu menggulir ke bagian itu.
Semua `id` elemen dan `id="settings-*"` bagian **tidak berubah** — skrip per bagian tetap menemukan elemennya.

## Simpan otomatis

- Formulir utama sudah otomatis (app.js `queueSetting`).
- Baru otomatis saat berubah: Instagram App ID/Secret/centang komentar, kunci Jev, berat per jenis barang.
  Tombol Simpan-nya disembunyikan (`hidden`), tetap ada di DOM dan di-klik lewat skrip.
- Masih tombol: kebijakan tukar size (`policySave`), metode pembayaran (`paymentSave`), aturan toko, backup.

## Bersinggungan — perhatikan bila ada error

| Bagian | Apa yang berubah | Risiko / gejala | Pemeriksaan |
|---|---|---|---|
| `settings.js selectPanel` | Pilih halaman (`[data-settings-view]`), set `hidden` tiap bagian mengikuti halamannya | Bagian tidak muncul / muncul di halaman salah | buka tiap hash, lihat tidak ada bagian kosong |
| Skrip yang memuat data saat bagian tampil (`jev.js`, `quality.js`, `weights.js`, `payments.js`, `backup.js`, `quotas.js`, `instagram.js`) | Mengamati atribut `hidden` di `#settings-*` — tetap dipicu karena `hidden` bagian ikut halamannya | Data tidak termuat bila bagian ada di dalam `<details>` tertutup → tidak terjadi (hidden = false walau details tertutup) | buka Lanjutan, data sudah terisi |
| `production.js` | Dulu cek `location.hash === '#production'`; kini cek `#settings-production` tampil (+ MutationObserver) | Produksi tidak termuat di `#store` | buka Toko → kartu produksi terisi |
| `app.js updateMcpOAuth` | Dipicu di `#business` **dan** `#store` | Status MCP tidak diperbarui | buka Toko → Lanjutan → indikator MCP |
| `jev.js` | Kartu Akurasi (`#jevRecent`, `#jevFilter`) pindah ke `#settings-usage`; `loadRecent` dipanggil saat Pemakaian tampil | Daftar akurasi kosong di Pemakaian | buka Pemakaian → Akurasi |
| `instagram.js` | `igSetup` (details) terbuka otomatis bila App ID/Secret belum ada; Hubungkan saat belum siap → membuka panduan & fokus App ID | Panduan terus terbuka setelah diisi → tidak, ditandai `touched` | isi App ID → simpan → reload |
| Form `invalid` (settings.js) | Bagian di dalam `<details>` tertutup: handler membuka halaman, tapi `details` tetap tertutup | Field tidak valid tidak terlihat | jarang; angka di Lanjutan punya min/max |
| Tautan server (`instagram_controller` → `settings?instagram=…#instagram`, `backup_controller` → `#backup`, `connectHint` → `#numbers`, `partials/instagram.edge` → `#instagram`) | Tidak diubah; alias menangani | — | klik tautan, halaman yang benar terbuka |
| i18n | Kunci baru ditambahkan ke `public/lang/id.js` & `en.js`; `language_catalog.spec` memaksa keduanya sama | Teks Inggris tidak muncul = kunci kurang | tes `language_catalog` |
| CSS (`calm.css` v3) | `.wa-settings-view*`, `details.wa-advanced*`, `.wa-steps`, judul bagian di Koneksi disembunyikan (visually hidden, aria tetap), editor pembayaran di bawah daftar (`order: 2`) | Tata letak lama (`[data-settings-panel]` padding/garis) masih dipakai | screenshot light/dark/mobile |
| Versi aset | calm.css 3, app.js 89, settings.js 37, production.js 4, jev.js 2, weights.js 2, instagram.js 3 | Browser memakai aset lama → tombol Simpan terlihat / halaman tidak berpindah | hard refresh |

## Belum diubah (sengaja)

- Dialog "Tambah akun AI" dan panel ChatGPT/Claude login tetap seperti sebelumnya (di Lanjutan kartu AI).
- Halaman Nomor WhatsApp (QR) memakai dialog lama `lineAdd`.
- Editor skill hanya tampil bila `bundle`.

## Formulir mengambang (`settings_dialogs.js`)

Satu tombol per bagian, formulir tampil sebagai `<dialog class="wa-settings-dialog">` di tengah layar:

| Bagian | Tombol | Dialog | Cara menutup otomatis |
|---|---|---|---|
| Pembayaran | `#paymentAddOpen` "Tambah metode"; tombol Edit di baris | `#paymentDialog` (isi: `#paymentEditor` lama, id tidak berubah) | status "Tersimpan" saat menambah; tombol Selesai kembali tersembunyi saat selesai edit; ×, Esc, klik latar |
| Sumber data MCP (Lanjutan Toko) | `#mcpAddOpen` "Tambah sumber" | `#mcpDialog` (isi: `#mcpName`, `#mcpUrl`, `#mcpAddButton`) | kedua kolom dikosongkan app.js setelah berhasil; ×, Esc, klik latar |

Bersinggungan: `payments.js` tetap memakai id lama dan `panel.querySelectorAll('button, input')` (dialog ada di dalam
`#settings-payments`, jadi ikut dinonaktifkan saat menyimpan — benar). Error simpan tetap tampil di dalam dialog
(dialog tidak ditutup). Belum dialog (sengaja, formulirnya satu baris): kontak yang tidak dibalas, domain akses, aturan toko.

## v3.6.1 — teks dan tanda disederhanakan

- Deskripsi halaman dan keterangan teknis dihapus/dipendekkan (mis. "seret ⠿ untuk mengubah urutan", jadwal backup 03.00, "SSL Let's Encrypt" tetap karena perlu).
- Tanpa tanda panah pada "Lanjutan"/`<details>`: summary tampil sebagai teks redup yang bisa diklik (`calm.css`).
- Tabel akun AI: kolom "Pemakaian 5 jam" dan "Status" dihapus (pemakaian ada di Pemakaian). Status = titik warna di depan nama (`.wa-dot`: hijau siap, kuning jeda, merah perlu login — bisa diklik untuk login, abu nonaktif); ikon peringatan tetap di samping nama. `colSpan` baris kosong 8 → 6.
- Metode pembayaran: teks "Aktif/Nonaktif" diganti titik warna (server-side di `payments.edge` dan `payments.js`).
- Bersinggungan: `ai_orchestra.js` dan `quotas.js` masih memakai `tokens5h` dari API (tidak diubah); `ui.css .wa-ai-pill-action/.wa-ai-state` tidak lagi dipakai di tabel.

## v3.6.2 — ikon

- Sprite ikon di `partials/settings/icons.edge` (`<symbol id="i-…">`), dipakai `<svg class="wa-i"><use href="#i-…"/></svg>` di edge dan JS (payments.js, ai_accounts.js). Sprite hanya ada di halaman Pengaturan; skrip yang merender ikon di halaman lain harus membawa SVG sendiri.
- Menu 5 halaman berikon; judul bagian & kartu berikon (warna redup); tombol utama berikon (+, tautan, putuskan, refresh, play, upload, pulihkan).
- Pembayaran: Edit/Hapus jadi tombol ikon (`.wa-ai-icon`), label tetap di `aria-label`/`title`.
- Akun AI: nama penyedia diberi kotak warna (`.wa-provider.chatgpt/claude/gemini`, warna = legenda orkestra).
- Berat barang: satuan "gram" pindah ke judul kartu, 3 kolom (2 di layar sempit).
- Lebih padat: padding kartu 12/14, jarak bagian 8, sel tabel AI 7/8.
- Bersinggungan: `instagram.js` mengganti teks tombol lewat `<span>` di dalam tombol (bukan `textContent` tombol) supaya ikon tidak hilang.

## v3.6.3 — bahasa

- Ganti bahasa tampilan kini memuat ulang halaman (`i18n.js`): bagian yang dirender skrip (daftar nomor, pilihan model/tugas akun AI, tabel) ikut berganti; sebelumnya tetap di bahasa lama sampai reload manual.
- Terjemahan id yang masih Inggris dibetulkan: "Update skill" → "Perbarui skill", "Ready stock" → "Stok siap", "Rollback" → "Kembalikan".
- Istilah teknis sengaja tetap sama di kedua bahasa: App ID/Secret, Webhook, Verify token, Redirect URI, Client ID, Model, Status, Edit, Instagram, Backup.

## v3.6.4 — orkestra, kuota di tabel akun, grafik token

- **Jev di orkestra**: `askJev` mencatat event `whatsapp_ai_events` dengan `account_id = 0` (`JEV_ACCOUNT_ID`, fase `jev-<nama>`, token). Endpoint `/api/ai/orchestra` menambahkan akun semu Jev bila kunci terpasang; event Jev disaring bila tidak. `lastAccountByJid` mengabaikan akun 0 (Jev bukan yang membalas). Di kanvas Jev berwarna ungu (`--orc-jev`), hanya berdenyut (tidak mengisi log, kecuali gagal).
- **Log aktivitas orkestra bisa diklik** (baris dengan jid) → membuka chat, sama seperti simpul pelanggan.
- **Model tidak tersedia di akun** (mis. akun gratis tanpa `gpt-5.6-sol`): turun satu tingkat dulu (berat → standar → ringan) sebelum model bawaan akun; model yang ditolak tetap dicatat (`model_blocked`). Pesan di tabel akun: "Model X tidak ada di paket akun ini; otomatis memakai model yang tersedia".
- **Sisa kuota akun** pindah ke tabel Akun AI sebagai chip persen berwarna (hijau > 30%, kuning ≤ 30%, merah ≤ 10%, abu belum terbaca) di bawah nama akun; kartu "Sisa kuota akun" di Pemakaian dan `quotas.js` tidak dimuat lagi (`ai_accounts.js` memanggil `/api/ai/quotas`).
- **Grafik tren token** per penyedia (ChatGPT, Claude, Gemini, Jev) untuk rentang terpilih: `usageCalendar` kini menyertakan `by[provider]` per hari; SVG sederhana di `settings.js renderTrend`. Tabel "Per model" diringkas: Model (titik warna penyedia), Proses, Token, Porsi.
- Bersinggungan: `ai_orchestra.js` ukuran simpul memakai `tokens5h` (Jev ikut); `usageCalendar` cache 10 menit (bentuk data bertambah `by`, pembaca lama tetap jalan).

## v3.6.5 — tampilan penuh Inggris, halaman login gaya Wireframe

- `i18n.js`: bahasa tampilan selalu `en`; pilihan "Bahasa tampilan" dihapus dari Pengaturan. Katalog id/en tetap dipakai (kunci Indonesia → teks Inggris) dan `language_catalog.spec` tetap menjaga kelengkapannya.
- Teks Indonesia yang masih tertulis langsung di template/skrip dibetulkan (badge belum dibalas/dibaca, panduan Client ID backup, label model "(otomatis)").
- **Pesan API**: middleware `english_messages_middleware` menerjemahkan field `error`/`message`/`status`/`reason`/`detail` (string) pada badan JSON lewat `services/english_messages.ts` (membaca `public/lang/en.js`). 112 pesan server ditambahkan ke katalog. Pesan baru di controller/service: tulis langsung Inggris, atau tambah ke katalog.
- Halaman login/setup (`pages/auth.edge`, `auth.css`, `auth_wire.js`): gaya Wireframe — latar off-white, kartu putih radius 8, rail label monospace + satu mark warna, ikon gelombang 3D kawat berputar (12 polyline, proyeksi manual, hover mengikuti pointer, hormat `prefers-reduced-motion`). Teks login Inggris; error login diterjemahkan di `account_controller`.
- Bersinggungan: skrip yang mendengarkan `ui-language:change` tidak terpicu lagi (tidak ada pilihan bahasa). `data-i18n` tetap wajib untuk teks UI baru (tes memaksa terjemahan Inggris ada).

## v3.6.6 — contoh gaya gabungan di halaman Pemakaian

Aturan gaya yang disepakati (dipakai bertahap ke semua halaman):

- **Dasar: Wireframe** — latar off-white, kartu putih radius 8 tanpa bayangan, garis tipis `--line`, label kecil monospace huruf besar, angka besar tipis (`font-weight 400`).
- **Bento** hanya untuk angka ringkas (kartu statistik, grafik): grid 4 kolom (2 di layar ≤ 760px), satu ubin lebar untuk grafik. Tanpa diagonal, tanpa tekstur.
- **Coak (notch)** hanya untuk kartu foto produk (Beta3/Instagram), bukan kartu teks.
- **Ikon kawat 3D** hanya di "momen" (login, kosong/selesai), bukan di setiap kartu.

Perubahan v3.6.6:

- `partials/settings/usage.edge`: pembungkus `.wa-bento` — ubin grafik (`.wa-bento-tile.wa-bento-wide`, 2×2) + kartu statistik (`#usageCards` jadi `display: contents` sehingga tiap `.wa-usage-stat` jadi ubin sendiri). Toolbar hanya tombol Refresh (rata kanan).
- `calm.css` v10: aturan `.wa-bento*`, tombol segmented monospace, `.wa-heat-box` dan tabel dibungkus kartu putih, judul tabel monospace.
- `settings.js`: `renderTrend` memakai ukuran SVG nyata untuk `viewBox` (ubin bento tingginya mengikuti grid) dan dirender ulang saat `resize`; `modelLabel` toleran terhadap label lama "Â· otomatis".
- Bersinggungan: `#usageCards` tidak lagi punya kotak sendiri — skrip yang mengisi `.wa-usage-stat` tetap jalan (struktur anak tidak berubah). Grafik butuh tinggi dari grid; bila `.wa-bento` dihapus, `#usageTrend` kembali ke `aspect-ratio`.

## v3.6.7 — gaya Wireframe untuk dasar semua halaman + beranda chat

- `public/assets/wire.css` (dimuat paling akhir, setelah `calm.css`): token terang Wireframe untuk semua halaman — latar `#edebe5`, sidebar `#e9e7e0`, garis `#e0ddd5`, teks `#151515`; kartu/panel radius 8; tombol `primary` hitam-teks; item menu sidebar aktif = kartu putih bergaris tipis; `nav-caption` monospace. Mode gelap tetap memakai token lama (hanya bentuk yang ikut).
- Beranda chat: judul "Chat" tipis; tombol saluran & tab filter monospace huruf besar (aktif = latar off-white, bukan hijau); avatar monokrom; baris aktif = garis kiri tipis gelap (`ai-running` tetap hijau); badge belum dibaca hitam; badge AI/CS/Penting monospace (CS = hitam). Pesan masuk kartu putih, pesan keluar AI off-white, pesan keluar CS putih bergaris gelap; meta/waktu/status monospace. Komposer: garis tipis, fokus = outline hitam 1px.
- Momen kosong "Pilih kontak": ikon gelombang kawat 3D + label monospace (`.wa-empty-moment`), dirender di SSR (`dashboard.edge`) dan di `app.js` saat daftar pesan kosong (`window.waWire.mount`).
- `public/assets/wire_icon.js` menggantikan `auth_wire.js`: dipasang ke setiap `svg.wire-icon` (login & chat), `data-wire-host` menentukan area hover. Ikon kawat hanya untuk momen (login, kosong), bukan di tiap kartu.
- Bersinggungan: warna hijau pada tab filter/badge/akun tidak dipakai lagi di mode terang — skrip yang mengandalkan kelas tetap jalan, hanya tampilannya berubah. `theme.css` aturan warna per filter (`[data-inbox-filter="cs"] span`) tetap berlaku untuk angka. Halaman lain ikut berubah latar & radius; pemeriksaan tampilan tiap halaman dilanjutkan di versi berikut (Koneksi → Toko → Cara AI membalas → Aplikasi & data → Beta3/Instagram).

## v3.6.8 — Pengaturan gaya Wireframe (Koneksi, Toko, Cara AI membalas, Aplikasi & data)

- Panel luar `.wa-settings-panel` transparan (tanpa kartu besar); tiap `section[data-settings-panel]` jadi kartu putih radius 8 (di Pemakaian tetap polos karena isinya sudah ubin). Kartu di dalam bagian (`.wa-card`, `details.wa-card`, kartu koneksi) diratakan — tanpa garis & latar — dan dipisah garis tipis antar kartu/baris sakelar.
- Judul bagian (`.wa-settings-section-title`), label isian, ringkasan `details`, kepala tabel, pil status, tombol segmented: monospace huruf besar kecil. Judul halaman & judul tampilan tipis (weight 500, 21px). Sakelar aktif hitam-teks (mode terang).
- Isian: radius 6, garis tipis, fokus = outline 1px hitam; font isian dipaksa sans (`--wa-sans`) karena label monospace (selektor berspesifisitas sama dengan `forms.css`).
- Produksi: blok aturan tanpa warna latar; teks "belum ada" monospace.
- Bersinggungan: `calm.css` aturan "Koneksi tanpa judul bagian" tetap; skrip yang membaca kelas tidak terpengaruh. `details > summary` khusus (#skillCard, #backupSetup, wa-ig-setup, wa-ai-advanced, wa-production-history) ditimpa dengan selektor berspesifisitas lebih tinggi di `wire.css`. Halaman Order/Beta 3/Instagram/Kontak baru menerima token dasar (latar, radius); penataan khususnya menyusul.

## v3.6.9 — kartu foto bercoak (notch)

- Coak hanya pada foto produk/bukti: foto order (`.wa-order-photos`, `.wa-b3-pictures`), bukti bayar di keranjang Beta3 (`.wa-b3-photos`), galeri post Instagram (`.wa-igp-gallery`) dan ubin media composer IG (`.wa-igp-tile`). `clip-path` memotong sudut kanan-atas 14px; `figure::after` menggambar garis diagonal tipis supaya potongannya terbaca di atas latar putih; keterangan foto monospace huruf besar.
- Tidak dipakai di gelembung chat, avatar, atau kartu teks.
- Bersinggungan: `border-radius` dan `border` foto-foto itu dihapus (sudut jadi tajam, sesuai gaya angular); `media_viewer` (zoom) tidak terpengaruh karena hanya membaca `src`.

## v3.6.10 — waktu relatif ringkas

- `i18n.js` menyediakan `window.waTime`: `ago(nilai)` → `just now` / `1s ago` / `5m ago` / `3h ago` / `2d ago` / `1mo ago` / `1y ago`; `full(nilai)` tanggal lengkap (WIB) untuk `title`; `node(nilai)` membuat `<time data-relative-time>` yang disegarkan tiap 10 detik di semua halaman (sebelumnya hanya di Pengaturan, tiap 60 detik, tanpa detik).
- Dipakai di: orkestra ("last … 21h ago"), Instagram "Last message received", skill CS "Last updated / Checked", status katalog Beta 3 ("updated 2h ago"), backup terakhir, daftar keputusan Jev, waktu komentar Instagram, tabel Recent runs di Pemakaian. Tanggal lengkap tetap tersedia lewat tooltip.
- Tetap absolut (memang perlu tanggalnya): waktu pesan di chat, tanggal order, jadwal post Instagram, riwayat file backup, batas kuota (waktu mendatang).
- Bersinggungan: `settings.js refreshRelativeTimes` kini memanggil `waTime.refresh` (event `skills:updated` tetap). `textElement` di settings.js menerima Node. Kunci katalog baru: "diperbarui {0}".

## v3.6.11 — Instagram: tampilan grid, filter jenis, angka lebih segar

- Tampilan daftar tetap; tombol daftar/grid di toolbar (diingat per browser, `localStorage ig-view`). Grid ala Instagram: ubin 3:4 (3 kolom di layar sempit, menyesuaikan di layar lebar), ikon jenis (reels/carousel) di pojok, angka suka · komentar · bagikan · simpan di bawah ubin; jadwal/gagal diberi label; klik membuka detail yang sama.
- Filter jenis Semua · Postingan (feed+carousel) · Reels · Story, berlaku di daftar maupun grid, berdampingan dengan tab status yang sudah ada.
- Angka performa: TTL insight dipendekkan (2 mnt < 1 hari, 5 mnt < 3 hari, 15 mnt < 14 hari, 30 mnt sisanya) dan semua yang usang diambil ulang setiap permintaan (sebelumnya maks 8 per permintaan sehingga banyak yang tertinggal). Halaman menyegarkan sendiri tiap 60 detik selama terlihat dan dialog tertutup; suka & komentar selalu segar karena ikut daftar media. Halaman lama yang sudah digulir tetap dipertahankan saat penyegaran.
- Bersinggungan: `#igpList` (tabel) tetap; `#igpTableWrap` disembunyikan saat grid. `loadMore` tetap hanya untuk tab Semua/Terbit. Kunci katalog baru: "Tampilan", "Tampilan daftar", "Tampilan grid". Lebih banyak panggilan insight ke Meta per jam untuk postingan baru — bila kena batas, angka lama tetap dipakai (galat tidak menghapus data).

## v3.6.12 — perbaikan grid Instagram

- Grid kosong bila ada reels/carousel: ikon jenis (SVG) diberi `className` lewat `Object.assign` → `className` SVG hanya-baca → galat menghentikan render. Kini `setAttribute('class', …)`. Pelajaran: untuk elemen SVG selalu pakai `setAttribute('class')`/`classList`.

## v3.6.13 — suka/komentar tidak lagi tertimpa angka insight lama

- `buildRows` (instagram_content.js) dan `recentPosts` (instagram_ai.ts): `like_count`/`comments_count` dari daftar media (selalu segar) sekarang menimpa `likes`/`comments` dari insight tersimpan — sebelumnya terbalik, sehingga suka di app tertinggal (mis. 11 padahal di Instagram 27) sampai jeda insight lewat.

## v3.6.14 — angka postingan yang di-boost (iklan)

- Instagram API memberi angka **organik saja**; suka/komentar/tayangan/kunjungan profil dari iklan (boost) tidak ikut, sehingga bisa lebih kecil dari aplikasi Instagram. Metrik `total_likes`/`total_comments`/`total_views` (termasuk iklan) kini ikut diminta; Instagram hanya memberinya pada login lewat Facebook — bila ditolak dilewati otomatis (mekanisme `unsupported`), bila ada dipakai saat lebih besar.
- Detail postingan menampilkan catatan apakah angkanya sudah termasuk hasil iklan atau belum.
- Kunjungan profil dari iklan tidak tersedia lewat API postingan mana pun (hanya lewat laporan iklan).

## v3.6.16 — pilih chat → tandai dibaca / belum dibaca

- Tombol centang di judul kotak masuk mengaktifkan mode pilih: tiap baris chat diberi kotak centang (CSS `::before`, tanpa markup), klik baris memilih (bukan membuka). Bilah aksi: "{0} dipilih · Tandai dibaca · Tandai belum dibaca · ×". Pilihan bertahan saat daftar disegarkan.
- `POST /api/contacts/read-state {jids, state}` → `setRoomsReadState`: dibaca = `workspace_read_id` ke pesan terakhir; belum dibaca = ke sebelum pesan masuk terakhir (1 pesan terhitung belum dibaca, seperti WhatsApp). Room tanpa pesan masuk tidak bisa ditandai belum dibaca.
- Bersinggungan: membuka room tetap menandai dibaca otomatis (`acknowledgeVisibleRoom`), jadi "belum dibaca" untuk room yang sedang terbuka hanya bertahan sampai room itu dibuka lagi. Tes: `tests/unit/inbox_read_state.spec.ts`.

## v3.6.17 — posisi daftar chat dipertahankan

- Membuka room memuat ulang halaman, sehingga daftar chat selalu kembali ke atas. Kini posisi gulir `#contacts` disimpan di `sessionStorage` saat room diklik (dan saat tombol kembali di layar sempit), dipulihkan saat halaman dimuat (≤ 10 menit); room aktif yang di luar pandangan digulir ke `nearest`. Di layar sempit daftar tersembunyi saat room terbuka (tinggi 0) → tidak menimpa posisi tersimpan.
- Alternatif yang tidak diambil: membuka room tanpa muat ulang (SPA) — lebih luas dampaknya (judul room, keranjang, mode penanganan semuanya SSR).

## v3.6.18 — filter nomor di kotak masuk; nomor tambahan tidak lagi saling tendang

- **Baris nomor** di atas judul kotak masuk, hanya bila ada nomor tambahan: "Semua nomor · …1234 · …5678" (4 digit terakhir). Filter berdasarkan `whatsapp_contacts.line_id` (`data-line` di baris; 1 = nomor utama); room Instagram ikut semua nomor. Pilihan diingat (`?ln=`, `localStorage wa-inbox-line`). `/api/contacts` kini mengembalikan `lines` juga.
- **Reconnect berulang pada nomor tambahan** — penyebab yang ditemukan: dua proses memegang sesi nomor yang sama (anak dari worker lama yang tertinggal saat worker utama mati mendadak/crash; Supervisor hanya mematikan grup saat *ia* yang menghentikan) → WhatsApp menendang bergantian (kode 440 conflict) → "Menghubungkan" terus. Perbaikan:
  - **Sewa per nomor** (`whatsapp_lines.worker_id` + `heartbeat_at`, 20 detik): proses nomor mengklaim sewa saat mulai (`claimLine`); kalah sewa → berhenti tanpa menyentuh sesi. Tiap putaran memperpanjang sewa (`touchLine`); bila diambil proses lain → berhenti.
  - Supervisor internal (`superviseLines`) tidak menyalakan proses kedua selama sewa nomor masih segar oleh proses lain.
  - Proses nomor memantau worker utama (`WA_PARENT_WORKER_ID` vs `whatsapp_connection.worker_id`): bila worker utama berganti → berhenti rapi agar worker baru menyalakan proses segar (kode terbaru).
  - Worker utama saat berhenti menunggu proses anak keluar (maks 4 detik) sebelum keluar; `deploy/run.sh worker` mematikan proses `--line=` tertinggal di bawah folder aplikasi sebelum worker mulai.
- Diagnosis bila masih terjadi: `/var/log/wa/worker.err.log` baris "Koneksi #N tertutup (kode …)": 440 = sesi ganda, 408 = timeout jaringan, 515 = WhatsApp minta mulai ulang (normal sesekali), 401/403 = sesi dilepas dari HP.

## v3.6.19 — satu pelanggan satu room; filter nomor/Instagram lebih tegas

- **Dua room untuk orang yang sama** = room `…@lid` (ID internal WhatsApp) dan room `…@s.whatsapp.net` (nomor). Room kanonik kini nomor HP: saat pesan masuk dari LID yang pasangannya diketahui (`whatsapp_contacts.phone_jid`), pesan disimpan ke room nomor (`roomOf` di listener; akhiran perangkat `:n` juga dibuang), dan data room LID lama dipindah sekali (`mergeLidRoom`: pesan, order, bukti, referensi, resi, trace, dll.; tabel berkunci jid — goal, keranjang, catatan pelanggan — room nomor menang, baris LID dibuang; nama/foto/penanda baca disalin). Sapu data lama tiap jam (`mergeKnownLidRooms`, 200 room/putaran, worker utama).
- **Filter**: memilih satu nomor hanya menampilkan room WhatsApp nomor itu (room Instagram tidak ikut); saluran Instagram menyembunyikan baris nomor. Nomor room diambil dari kontak, bila kosong dari pesan terakhir (`message_line_id`).
- Bersinggungan: tautan lama `/?jid=<lid>` tidak lagi punya pesan (room kosong) setelah digabung. Tes: `tests/unit/lid_room_merge.spec.ts`.

## v3.6.20 — update lebih cepat (paket build dari rilis); tanda nomor jadi ikon SIM

- **`wa update` lama (±500 dtk)** karena server membangun aplikasi sendiri tiap update: salin sumber, pasang dependensi dev (bila lock berubah: `npm ci` bermenit-menit), `node ace build` (tsc, berat di VPS kecil), pasang dependensi produksi, cek runtime, init model, restart. Kini `deploy/publish-xi.sh` membangun di mesin pengembang dan mengunggah `wa-build-v<ver>.tar.gz` sebagai aset GitHub Release (`deploy/release.sh`); di server `whatsapp-aapanel.mjs fetchPrebuilt` mengunduh paket itu (public repo, tanpa token) dan melewati pasang dependensi dev + build. Sisanya tetap (dependensi produksi dari cache hardlink, init model, restart). Perkiraan: 500 dtk → < 60 dtk. Bila paket tidak ada/gagal → build sendiri seperti dulu (`--no-prebuilt` memaksa build). Log build (`/var/log/wa/build.log`) kini mencatat waktu tiap tahap.
- Catatan: aset berlaku mulai rilis ini; update KE v3.6.20 sendiri masih build di server (skrip baru baru aktif setelahnya).
- **Tanda nomor**: chip "…1234" diganti ikon SIM kecil berisi angka (1 = nomor utama, 2… = nomor tambahan urut), judul = nomor lengkap; baris filter nomor: "Semua · SIM 1 · SIM 2". Room Instagram tidak diberi tanda.
- v3.6.21: `deploy/upload-build.sh <ver> <tar>` mengunggah/mengganti aset build pada rilis yang sudah ada; `publish-xi.sh` menerima `WA_BUILD_ASSET` (paket dibangun di mesin lain bila `node_modules` lokal bukan untuk platform skrip). Paket harus berisi `build/VERSION` = versi rilis.
- v3.6.22: paket build dibangun **GitHub Actions** (`.github/workflows/wa-build-asset.yml`, dipicu tag `v3.*` atau manual lewat `workflow_dispatch`) karena mesin pengembang tidak bisa mengunggah ke `uploads.github.com`; `publish-xi.sh` ikut menyinkronkan `.github/`. Aset muncul ±1–2 menit setelah rilis; `wa update` sebelum itu akan build sendiri.
- v3.6.22: tombol **Pilih semua** di bilah pilihan: memilih semua chat yang sedang terlihat (mengikuti filter/pencarian); tekan lagi untuk melepas.
- Catatan: push berkas workflow butuh PAT ber-scope `workflow`; `publish-xi.sh` menyertakan `.github/` hanya bila `WA_SYNC_GITHUB=1`. Tanpa itu, tambahkan `wa-build-asset.yml` lewat web GitHub sekali.

## v3.6.23 — nama kontak mengikuti buku kontak HP

- Sebelumnya nama yang pertama tersimpan tidak pernah diganti (`COALESCE(VALUES(name), name)`), dan yang sering datang duluan adalah nama profil WhatsApp pelanggan (pushName dari pesan), sehingga nama di app ≠ nama di HP. Kini nama dari buku kontak (event `contacts.*`/riwayat dengan `name`, `fromBook`) selalu menimpa dan ditandai `whatsapp_contacts.name_from_book = 1`; pushName hanya mengisi bila belum ada nama.
- 20 detik setelah terhubung, proses meminta WhatsApp mengirim ulang buku kontak (`resyncAppState(['critical_unblock_low'])`, sekali per proses) supaya nama lama ikut diperbarui tanpa menunggu kontak berubah.
- Bersinggungan: nama yang diubah di HP akan menimpa nama di app saat sinkron berikutnya (yang diinginkan). Room Instagram tidak terpengaruh.

## v3.6.24 — satu pelanggan yang chat ke dua nomor = dua room

- Room di kotak masuk kini = pelanggan + nomor penerima (`COALESCE(line_id, 1)`), bukan pelanggan saja. Pelanggan yang menghubungi nomor 1 dan nomor 2 tampil sebagai dua room, masing-masing berisi pesan nomor itu saja, dengan ikon SIM berbeda. Tautan room: `/?jid=…&line=2` (nomor utama tanpa `line`); `/api/messages` menerima `line`, kirim pesan dari room mengirim lewat nomor room itu (`line` di form).
- Posisi baca per room: tabel baru `whatsapp_room_reads (jid, line_id, read_id)`. Buka room / Tandai dibaca / belum dibaca (`/api/contacts/read` & `/api/contacts/read-state` dengan `rooms: [{jid, line}]`, `jids` lama tetap diterima) hanya menyentuh room nomor itu. Sebelum penanda lama per kontak (`workspace_read_id`) dinaikkan, posisi baca room nomor lain dibekukan dulu (`freezeOtherLines`) supaya menandai room nomor 2 tidak ikut "membaca" room nomor 1. Tanda baca ke WhatsApp (`flushWorkspaceReads`) membaca posisi per room ini.
- Bersinggungan: filter nomor di header (`ln=`) tidak berubah dan berbeda dari parameter room (`line=`). AI tetap membalas lewat nomor yang terakhir menerima pesan pelanggan (`whatsapp_contacts.line_id`), dan riwayat untuk AI tetap seluruh pesan pelanggan (kedua nomor) — hanya tampilan kotak masuk yang dipisah. Tautan dari halaman lain tanpa `line` membuka room nomor utama, atau room mana pun milik pelanggan itu bila nomor utama tidak ada. Data lama tanpa `whatsapp_room_reads` tetap memakai `workspace_read_id`.

## v3.6.25 — kutipan balasan menunjukkan gambar yang dibalas, bisa diklik

- Sebelumnya kutipan di bubble hanya menulis "image" tanpa tahu gambar mana. Kini kutipan (`message.reply`) membawa `thumb` (gambar/stiker: file medianya; video/GIF: thumbnail) dan `label` (Foto, Stiker, Video, Pesan suara, Dokumen…), ditampilkan sebagai gambar kecil + teks di bubble. Kutipan adalah tombol: klik → melompat ke pesan aslinya (`jumpToMessage`, memuat halaman lama dulu bila belum tampil, maksimal 6 halaman) dan pesan itu berkedip sebentar (`.wa-jump`).
- Saat CS menekan ↩ pada pesan bergambar, kotak "membalas…" di composer ikut menampilkan gambar kecilnya (`#replyComposerThumb`).
- Bersinggungan: balasan ke status WhatsApp toko (v3.6.15) ikut menampilkan foto statusnya. Gaya kutipan dipindah ke `wire.css` (tombol, garis kiri warna teks); mode gelap tetap memakai warna lama dari `theme.css`.

## v3.6.26 — room besar tidak lagi macet; aset ikut versi; tampilan Inggris dari server

- Room tidak terbuka/macet: sejak v3.4.118 browser memuat **seluruh** riwayat room halaman demi halaman (`loadOlderMessages` memanggil dirinya terus) dan merender ulang semua bubble tiap halaman. Dengan nomor lama (riwayat bertahun-tahun, ribuan pesan per room) halaman jadi beku. Kini riwayat lama dimuat hanya saat digulir ke atas (`scrollTop < 300`), saat daftar belum bisa digulir, atau saat mencari di room (pencarian tetap memuat sampai ketemu/habis). Lompat ke kutipan (v3.6.25) tetap memuat maksimal 6 halaman.
- Aset (`app.js`, `wire.css`, `en.js`, …) dulu memakai `?v=angka` manual yang sering lupa dinaikkan (`auth.css?v=3` sejak v3.4.118 padahal gaya login berubah di v3.6.5 — browser menampilkan halaman login lama; `app.js?v=96` tidak naik di v3.6.24–25). Kini `?v={{ assetVersion }}` = versi rilis (`appVersion()` dibagikan `WorkspaceMiddleware` dan halaman login), jadi setiap update selalu mengambil aset baru.
- Bahasa: katalog Indonesia (`public/lang/id.js`) dihapus; tampilan hanya Inggris. HTML dari server sudah Inggris (`englishHtml` di `EnglishMessagesMiddleware`, hanya elemen `data-i18n*`), bukan baru setelah `i18n.js` jalan — sebelumnya halaman besar tampak berganti bahasa saat dimuat. Teks dinamis dari JS tetap lewat `t()`.
- Bersinggungan: tes `language_catalog.spec.ts` tidak lagi membandingkan en/id; fixture tes UI (`tests/*.test.mjs`) tidak memuat `id.js`. Ukuran HTML halaman chat tetap besar karena seluruh daftar kontak dirender server (belum diubah).

## v3.6.27 — mode gelap memakai tema Wireframe yang sama

- Sebelumnya `wire.css` hanya mengubah bentuk di mode terang (`html:not([data-theme='dark'])`), jadi di mode gelap (sistem Mac gelap → `theme.js` auto) halaman `/` dan lainnya masih tampil dengan tema gelap lama (hijau, bubble lama). Kini aturan bentuk berlaku dua tema (`html[data-theme]`, mengalahkan `theme.css` karena dimuat terakhir) dan mode gelap punya token grafit sendiri: halaman `#1a1a18`, kartu `#242422`, garis `#2e2e2b`, teks `#ecebe6`; tombol utama, kontak aktif, tab terpilih, menu pengaturan aktif memakai warna teks (bukan hijau). Hijau/merah/kuning tetap untuk status (terhubung, lunas, gagal).
- Bersinggungan: `theme.css` tidak diubah; token `--wa-page/--wa-surface/--wa-raised/--wa-hover` di `html[data-theme='dark']` ditimpa oleh `wire.css`. Pilihan tema (auto/terang/gelap) di Pengaturan tetap ada.

## v3.6.28 — halaman `/` tanpa login (beranda publik) ikut tema Wireframe, berbahasa Inggris

- Halaman `/` saat belum login bukan halaman login, melainkan beranda publik dari `legal_controller.ts` (`landingPage`, dipakai `account_auth_middleware`), beserta `/privacy` dan `/terms` — ini yang masih memakai gaya lama (hijau, Indonesia). Kini `public.css` memakai token Wireframe yang sama dengan login (off-white/grafit, kartu radius 8, label monospace, tombol warna teks), teks Inggris (Sign in, Home/Privacy/Terms, Privacy Policy, Terms of Service), `lang="en"`, dan `public.css?v=<versi>`.
- Bersinggungan: isi kebijakan privasi/syarat (dipakai untuk Google OAuth & Meta) diterjemahkan apa adanya; tautan `#hapus-data` tetap.

## v3.6.29 — ulasan chat #17: total harus lengkap, ongkir dihitung ulang, janji tunggu tidak diulang, kirim ulang bila gagal

- Lihat `docs/cs-pelajaran.md` #17. Kode: `partsMissingFromItems`/`orderPartsOf`/`reopenLeanOrderForChange` (`order_service.ts`), `HISTORY_LIMIT_ORDER = 60` dan pengambilan ulang tarif saat `shipping_options.grams` ≠ berat spesifikasi (`reply_service.ts`), `dropRepeatedWait` (`reply_guards.ts`), kolom `whatsapp_messages.send_attempts/send_error` + coba ulang 3× di `flushQueued` (listener), judul tanda "!" di chat menampilkan alasannya.
- Bersinggungan: order "menunggu pembayaran" bisa kembali "pending" otomatis bila item berubah sebelum dibayar (panel pesanan CS akan menampilkannya lagi dengan catatan "item berubah, total dihitung ulang"). Pesan yang sedang dicoba ulang tetap berstatus antrean (tanpa "!") maksimal ±5 detik.

## v3.6.30 — ulasan #18: total CS langsung tercatat; bukti transfer dinilai dari isi gambar (Jev)

- Lihat `docs/cs-pelajaran.md` #18. Kode: `parseCsTotalMessage`/`applyCsTotalMessage` (`order_service.ts`, dipanggil listener setelah pesan CS terkirim), `screenIncomingImage` (`refs_service.ts`, dipanggil listener saat media gambar masuk siap), keputusan Jev baru `bukti_transfer` (`jev.ts`, `jev_decisions.ts` → tampil di Pengaturan → Jev, bisa dimatikan), SQL penanda pembayaran di `contact_inbox_service.ts` dan `pendingSettlement` (`order_service.ts`), `recordImageKinds` tidak menimpa hasil pilah isi.
- Bersinggungan: tiap gambar pelanggan kini memicu satu panggilan AI vision di latar (biaya kecil, akurasi penanda pembayaran naik). Gambar yang gagal dilihat ('?') tetap dihitung calon bukti agar tidak ada pembayaran terlewat. Order "menunggu pembayaran" bisa berubah angkanya mengikuti pesan CS — panel pesanan menampilkan catatan "total dikirim CS di chat".

## v3.6.31 — pesanan diantar tim sendiri (tanpa resi); kontak vendor/supplier dikenali

- **Diantar sendiri / diambil pelanggan.** Pemindai pengiriman (`scanShipments`) kini juga mengenali pesan toko "sudah kami antar langsung", "diantar tim kami", "sudah diambil", "otw kurir toko" (pola kata `looksSelfDelivery` sebagai saringan, Jev `kirim_sendiri` memutuskan bila aktif) → tercatat di `whatsapp_beta3_shipments` dengan `awb = 'ANTAR'`, `method = 'antar'`. Order masuk tab Selesai tanpa resi; halaman Order menampilkan "Diantar tim"; AI menjawab "sudah dikirim?" dengan "diantar langsung tim kami" dan tidak menjanjikan/menanyakan resi (`renderActiveOrder`, catatan PENGIRIMAN di `trackParcel`). Tombol manual di halaman Order (order lunas): **Diantar tim (tanpa resi)** → `POST /api/beta3/orders/:id/delivered`.
- **Vendor / supplier bahan.** Jev `peran_kontak` menilai dari percakapan dua arah (toko yang bertanya harga/stok/memesan/membayar = vendor; tim/pribadi/spam = lainnya), dijalankan di latar tiap pesan masuk setelah ≥4 pesan dan diulang tiap 8 pesan sampai yakin (`contact_role.ts`, kolom `whatsapp_contacts.role`, `role_manual`). Vendor/lainnya otomatis tidak dibalas AI (`ai_excluded`), tidak masuk penanda Pembayaran, dan diberi chip **VENDOR / LAINNYA** di daftar chat. CS bisa menandai/membatalkan manual lewat tombol ikon toko di header room (`#roomRoleButton`, `POST /api/contacts/role`); peran manual tidak ditimpa Jev.
- Bersinggungan: foto nota/transfer dari vendor tidak lagi memicu "pembayaran perlu dikonfirmasi"; pesan CS ke vendor ("pesan kain 20 m") tidak dibaca sebagai order pelanggan karena AI tidak berjalan di chat vendor. Kedua keputusan Jev tampil di Pengaturan → Jev dan bisa dimatikan (tanpa Jev: antar-sendiri memakai pola kata saja; peran vendor hanya manual).

## v3.6.32 — total CS yang tertinggal disamakan; konfirmasi dana CS di chat langsung tercatat

- Lihat `docs/cs-pelajaran.md` #19. Kode: `adoptCsTotal`, `reconcileCsTotals`, `applyCsPaymentConfirm` (`order_service.ts`); `markLeanOrderPaid`/`setLeanPaidAmount` mengadopsi total CS bila nominal dana ≠ total; listener memanggil `applyCsPaymentConfirm` setelah pesan CS terkirim (bila bukan pesan total); `contact_inbox_service` menjalankan `reconcileCsTotals` sekali per proses; berat tarif dari `grams ?? weight_grams` (`reply_service.ts`).
- Bersinggungan: order lunas dari konfirmasi CS di chat ikut diantrekan ke grup produksi seperti tombol "Lunas". Nominal yang lebih besar dari total hanya diterima bila ada total CS yang cocok; selain itu tetap dibatasi total seperti sebelumnya.

## v3.6.33 — pelanggan tidak lagi tertandai vendor

- Lihat `docs/cs-pelajaran.md` #20. Kode: `hasCustomerHistory`, `repairAutoRoles` (`contact_role.ts`, dijalankan sekali per proses dari `contact_inbox_service`), penanda `role-excluded:<jid>` (pengecualian AI karena peran otomatis), ambang `peran_kontak` 0,95, `scanShipments` melewati vendor/lainnya.
- Bersinggungan: kontak yang dikembalikan ke pelanggan berada di mode CS (AI tidak langsung membalas sampai diaktifkan/ada balasan CS), sama seperti setelah mencabut "Jangan dibalas AI".
