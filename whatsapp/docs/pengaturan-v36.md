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
