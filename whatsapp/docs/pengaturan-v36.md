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
