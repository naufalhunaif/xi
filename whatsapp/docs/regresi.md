# Perilaku yang sudah settle (jangan sampai rusak lagi)

Daftar ini dibaca **sebelum** mengubah fitur yang bersinggungan, dan dicek **sebelum** rilis.
Setiap baris punya tes; kalau tes gagal, berarti ada perilaku lama yang rusak.

## Aturan kerja

1. **Sebelum mengubah**: cari bagian terkait di daftar ini. Perubahan yang menyentuh bagian itu
   harus tetap memenuhi semua barisnya.
2. **Bug diperbaiki** → tambah tes yang menangkap bug itu + satu baris di daftar ini (commit yang sama).
3. **Perilaku sengaja diubah** (diminta pemilik) → ubah tes dan baris di daftar ini di commit yang sama.
   Jangan menghapus/melonggarkan tes hanya supaya lulus.
4. **Sebelum rilis** (wajib, di salinan Linux dengan MariaDB menyala):
   - `npx tsc --noEmit` bersih.
   - `node ace test unit` → **semua lulus** (tidak ada "gagal yang sudah biasa").
   - Ada perubahan tampilan: cek Playwright 1440 px & 390 px.
5. Tes yang butuh database ada di `tests/unit/beta3_flow.spec.ts`; tes lain murni (tanpa jaringan).

## Beta 3 — order & total

| Perilaku | Tes |
|---|---|
| Form order (berlabel atau alamat tempelan) dibaca jadi order; ongkir dicek dari kecamatan + kota | `beta3.spec` · form order |
| Total + rekening dikirim otomatis hanya bila rincian cocok KATALOG dan subtotal benar | `beta3.spec` · total otomatis |
| Lebih dari satu layanan ongkir → harus dipilih pelanggan, AI tidak memilihkan | `beta3.spec` · total otomatis |
| Hanya satu layanan (JTR tidak ditawarkan untuk < 8 kg) → langsung dipakai, tidak ditanya | `beta3.spec` · ongkir ditulis ringkas |
| Setelan tanpa nomor celana → total ditahan, tanya "celana menyesuaikan kah atau pakai No. berapa" | `beta3.spec` · pelajaran chat CS |
| Form yang terkirim saat CS membalas tetap diproses di giliran berikutnya (sekali saja) | `beta3_flow.spec` · form terlewat |
| Form terlewat + CS sudah kirim total manual → order tercatat "menunggu pembayaran" dengan total CS, bukti transfer tampil, tombol konfirmasi muncul; total tidak dikirim ulang | `beta3_flow.spec` · total CS |
| "Dana masuk" saat menunggu bayar = nominal yang dibaca dari bukti transfer; belum terbaca → kosong + "Cek nominal di bukti transfer", tidak pernah otomatis = total (DP 400 ribu tidak jadi lunas) | `beta3_flow.spec` · panel room (+ cek Playwright `beta3_pay.js`) |
| Bukti transfer tampil di panel walau order tercatat belakangan; gambar yang gagal dimuat tetap ditandai "Gambar belum terunduh" | `beta3_flow.spec` · panel room |
| Pesan toko berisi total/rekening dikenali; janji AI ("ini totalnya saya kirimkan") tidak dianggap total | `beta3.spec` · form terlewat |
| Tanpa form order, AI tidak menjanjikan total; minta data pengiriman / "saya cek dulu" | `beta3.spec` · janji total tanpa order |
| Pesan grup produksi: tanpa harga, alamat, telepon; ditutup nama + nomor order | `beta3.spec` · pesan grup produksi |

## Beta 3 — isi balasan

| Perilaku | Tes |
|---|---|
| Warna di spesifikasi & balasan = warna KATALOG yang difotokan di chat (foto Choco tidak ditulis "Brown"), kecuali pelanggan menyebut warnanya sendiri | `beta3_flow.spec` · warna katalog |
| Kebijakan tukar size dari Pengaturan masuk prompt dan dikirim apa adanya | `beta3.spec` · pelajaran chat CS |
| Pertanyaan yang baru ditanyakan tidak diulang | `beta3.spec` · form order |
| Prompt lengkap tetap di bawah 10 ribu token | `beta3.spec` · prompt dan keluaran |
| Model "Otomatis" memilih model per tugas | `beta3.spec` · model otomatis |

## Aplikasi umum

| Perilaku | Tes |
|---|---|
| Semua teks UI (`data-i18n` / `t()`) punya terjemahan Inggris; en.js dan id.js berisi kunci yang sama | `language_catalog.spec` |
| Login: API tamu → 401 JSON; halaman → ke /login; beranda "/" publik | `account_auth.spec` |
| Pertanyaan internal (backend, model AI, system prompt) tidak memanggil AI/tool | `customer_scope.spec` |

## Belum ada tes otomatis (cek manual saat menyentuh bagiannya)

- Setelah CS membalas sebagian, AI menjawab poin yang terlewat ±3 menit kemudian; chat yang
  diserahkan ke CS dan tidak dibalas 20 menit dijawab AI lagi (v3.4.177).
- Hasil cek ongkir yang kecamatan/kotanya tidak sesuai alamat ditolak (v3.4.176).
- Backup: file sementara yang hilang saat dibackup tidak membuat backup gagal; media dibackup bertahap (v3.4.172).
- Halaman Usage: heatmap 1 tahun, filter recent runs, "Otomatis" tersimpan (bukan "null") (v3.4.168–170).
