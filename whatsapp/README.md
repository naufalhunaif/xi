# WhatsApp AI CS

Aplikasi WhatsApp + Instagram yang dibalas AI sebagai CS toko (AdonisJS, MariaDB/MySQL, Baileys).
Sejak v3.5.0 hanya ada satu alur AI: **Beta 3** (`app/beta3`). Alur lama Beta 1 dan Beta 2 sudah dihapus;
catatannya disimpan di [`docs/arsip`](docs/arsip/README.md).

## Pasang dan perbarui

- Server standalone: lihat [`docs/install.md`](docs/install.md). Pembaruan cukup `wa update`.
- Lokal (XAMPP/macOS): buat database `whatsapp`, `npm install`, lalu jalankan `npm run dev` dan `node ace whatsapp:listen`.
  Tabel dibuat otomatis oleh `app/services/init_model.ts` dan `app/beta3/tables.ts` (tanpa migrasi).

## Cara kerja singkat

1. Pesan masuk dikumpulkan sebentar, lalu satu giliran AI berjalan (`commands/whatsapp_listen.ts` → `app/beta3/reply_service.ts`).
2. Kode menyiapkan fakta: katalog, ongkir, fit advisor, form order, status order. AI menulis balasan + catatan dalam JSON.
3. Kode memeriksa sebelum kirim: harga di luar katalog ditahan, total + rekening hanya dikirim bila rincian cocok.
4. Order, pembayaran (DP/lunas), dan kiriman ke grup produksi dikelola di halaman **Order**.

## Dokumen

| Dokumen | Isi |
| --- | --- |
| [`docs/beta3.md`](docs/beta3.md) | Alur Beta 3 secara rinci |
| [`docs/regresi.md`](docs/regresi.md) | Perilaku yang sudah settle + tesnya; dibaca sebelum mengubah fitur |
| [`docs/cs-pelajaran.md`](docs/cs-pelajaran.md) | Pelajaran dari chat CS asli |
| [`docs/adaptive-models.md`](docs/adaptive-models.md) | Pilihan model "Otomatis" |
| [`docs/install.md`](docs/install.md) | Pemasangan server |
| [`docs/roadmap.md`](docs/roadmap.md) | Rencana berikutnya |

## Pengujian

```bash
npx tsc --noEmit          # wajib bersih
node ace test unit        # wajib lulus semua (butuh MariaDB)
```

Tes fungsional (`tests/functional`) memakai database sekali pakai dan tidak menjadi syarat rilis.
