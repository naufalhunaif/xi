# Panduan kerja — whatsapp

Aplikasi CS Chameleon Cloth: kotak masuk WhatsApp + Instagram, AI yang membalas seperti CS (Beta 3), order, pembayaran, dan konten Instagram. Baca juga `../CLAUDE.md` (aturan bundle) dan `design.md` (aturan UI).

## Stack

- AdonisJS 6 + TypeScript (ESM), view Edge, MariaDB/MySQL. Tanpa framework front-end: JS biasa per halaman di `public/assets/*.js`.
- Dua proses: web (`node bin/server.js`) dan worker (`node ace whatsapp:listen`, Baileys). Timer worker juga menjalankan Instagram, posting terjadwal, dan sapuan chat.
- Server produksi: domain `naufalhunaif.com`, perintah `wa` (lihat `../deploy/wa.sh`): `wa update`, `wa password`, dll.

## Peta folder

| Lokasi | Isi |
|---|---|
| `app/beta3/` | **AI CS yang aktif** (Beta 3): `reply_service` (keputusan & balasan), `order_service`, `recap_service`, `catalog_*`, `style_service`, `tables` (state & catatan). Alias `#beta3/*`. |
| `app/services/` | Layanan umum. Instagram: `instagram_api` (Graph API), `instagram_store` (config/token/tabel), `instagram_inbox` (webhook), `instagram_worker` (DM, komentar, tick), `instagram_publish` (jadwal posting), `instagram_insights` (insights). |
| `app/controllers/` | HTTP. Satu controller per area (`instagram_controller` = koneksi & komentar, `instagram_content_controller` = posting & insights). |
| `commands/whatsapp_listen.ts` | Worker Baileys: terima/kirim pesan, sinkron riwayat, timer, sapuan. File besar — ubah seperlunya saja. |
| `skills-beta3/` | Skill/prompt AI Beta 3 (`beta3-cs-inti/SKILL.md` = aturan bicara CS). Ikut rilis. |
| `resources/views/pages/dashboard.edge` | Satu layout untuk semua halaman (`page` = chat, orders, comments, content, settings, …). |
| `resources/views/partials/` | Isi tiap halaman/kartu pengaturan. |
| `public/assets/` | CSS/JS halaman. Tambahan tema & komponen baru masuk `theme.css`. |
| `public/lang/en.js`, `id.js` | Kamus bahasa antarmuka (kunci = teks Indonesia). |
| `start/routes.ts` | Rute publik di atas (webhook, `/ig-media`), rute login di dalam grup `accountAuth`. |
| `docs/` | Catatan desain fitur. Tambahkan dokumen di sini untuk fitur besar baru. |
| Beta 1/2 (`lean_*`, `orders_lean`, dll.) | Tidak dikembangkan lagi. Jangan menambah fitur di sana. |

## Konsep penting

- **Workspace per nomor.** Tabel diberi awalan per workspace (`w0_`, `wN_`) lewat `#services/workspace_database` (Proxy).
  - Query builder & `db.rawQuery` otomatis ber-awalan. **`whereRaw` tidak** → bungkus dengan `workspaceSql()`.
  - Kode di worker/timer harus berjalan di `inWorkspace(scope, fn)`; ambil scope aktif dengan `activeWorkspace()`.
  - Media per workspace di `public/media/` dengan `workspaceFileName()`, dilayani rute `/media/*` (butuh login).
- **Room Instagram** memakai jid `<igsid>@ig`. Komentar disimpan sebagai pesan `igc-<commentId>` berbody `[Komentar di postingan Instagram: "caption"; foto postingan terlampir] isi` (UI menampilkannya sebagai foto + kotak caption).
- **Tabel baru**: buat idempoten di fungsi `ensure…Tables()` (`CREATE TABLE IF NOT EXISTS`, kolom baru `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). Tidak ada migrasi terpisah.
- **State kecil/config** per workspace: `readLeanState` / `writeLeanState` (Instagram: `readKey` / `writeKey`; rahasia dienkripsi otomatis).
- **Waktu** ditampilkan WIB (Asia/Jakarta), format jam AM/PM.

## Aturan AI (Beta 3)

- Hanya Beta 3 yang aktif. AI berbicara sebagai CS sendiri (tidak menyebut "CS akan konfirmasi").
- Aturan gaya & alur ada di `skills-beta3/beta3-cs-inti/SKILL.md`. Ubah aturan di sana, bukan di kode, kecuali butuh logika.
- Kalimat yang sudah ditetapkan pemilik dipakai **persis** (mis. "Oke bos, paling nanti kami sesuaikan dengan tinggi dan berat badan ya, biar pas").
- Perubahan perilaku AI: tunjukkan contoh sebelum/sesudah; kalau pemilik bilang salah, kembalikan seperti semula.

## Aturan UI

- Baca `design.md` dan jalankan checklist bagian 2 sebelum commit. Pakai komponen `ui.css`/`theme.css`; tanpa inline style dan warna baru di luar token.
- Semua teks UI lewat `data-i18n` (HTML) atau `t()` (JS), dengan entri di **`en.js` dan `id.js`**.
- Setiap aset yang diubah: naikkan `?v=` di `resources/views/components/layout.edge` (aset ber-versi di-cache browser 1 tahun).
- Cek di 1440 px dan 390 px, light & dark. HP: menu di bawah (disembunyikan saat room chat terbuka).
- Penanda memuat cukup `wa-loading` ("Memuat…") + bar tipis dari `loading.js`; jangan skeleton yang ramai.
- Daftar panjang: ringkas (satu baris per item, aksi muncul saat dibutuhkan), seperti halaman Komentar.

## Pengujian sebelum rilis

1. `npx tsc --noEmit` harus bersih; `node --check` untuk JS yang diubah.
2. Uji perilaku di salinan lokal (MariaDB + `node ace serve`) — termasuk Playwright untuk tampilan 1440 px & 390 px.
3. Panggilan ke API luar (Instagram/Meta) di-*mock* lewat `globalThis.fetch` di `node ace repl` (tulis satu baris, `inWorkspace(ctx.EMPTY_WORKSPACE, …)`).
4. Jangan memanggil API sungguhan dengan token pengguna dari lingkungan uji.

## Rilis

- Versi di-bump per rilis: `bash deploy/publish-xi.sh <versi>` (contoh `3.4.148`). Skrip menyalin `whatsapp/` + `deploy/` dari **working tree** ke repo publik `xi`, membuat tag & GitHub Release.
- Commit lokal dulu, lalu publish. Setelah rilis, minta pemilik menjalankan `wa update`.
- Lock git yang macet (`.git/*.lock`) dipindah ke `.git/_stale/`, jangan dihapus paksa.

## Jebakan yang pernah terjadi

- `whereLike()` menghasilkan `COLLATE utf8_bin` → error di MariaDB utf8mb4. Pakai `.where('kolom', 'like', '%x')`.
- `whereRaw` lupa `workspaceSql()` → data tercampur antar tab/workspace.
- `sharp` hanya memakai `resize()` terakhir — gabungkan potong + skala dalam satu `resize`.
- Gambar dibuat via `createElement` bisa selesai dimuat sebelum masuk DOM; pasang listener `load` di elemennya, bukan di `document`.
- Instagram: token dikirim sebagai `access_token` di query; DM/komentar hanya bisa dibalas dalam batas waktu (DM 24 jam, private reply komentar 7 hari, sekali).
- Riwayat besar (ratusan ribu chat): kontak dari riwayat default ke mode AI dan daftar chat memuat semua chat sekaligus — belum aman untuk nomor lama. Lihat catatan "nomor kedua" sebelum menyambungkan nomor besar.
