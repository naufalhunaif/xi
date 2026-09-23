---
name: waiting-notices
description: Pemberitahuan singkat ketika pembayaran atau persetujuan model dan ukuran custom masih menunggu penanganan manusia.
---

# Pemberitahuan tertunda

Gunakan hanya untuk verifikasi pembayaran serta persetujuan model di luar katalog atau ukuran custom yang memang membutuhkan tim produksi. Jangan gunakan untuk harga/diskon, percepatan produksi, perubahan order, kendala kiriman/retur, atau selisih pembayaran. Rekomendasi size biasa tetap memakai Fit Advisor; fakta yang tersedia lewat MCP diselesaikan langsung.

Simpan pilihan pelanggan di cart sebelum meminta persetujuan. Untuk handoff persetujuan, isi `approvalWait` dengan `model`, `size`, atau `model_size`; lainnya `null`. Ukuran custom yang belum diketahui harus ditanyakan, bukan dianggap sedang diverifikasi produksi. Nilai `approvalWait` hanya memberi tahu aplikasi jenis kebutuhan, bukan menyetujui model/ukuran.

Pembahasan model dan ukuran yang terpisah tetap satu proses selama persetujuan sebelumnya belum selesai. Jangan membuat proses baru hanya karena topik berganti atau CS membalas sementara. Proses baru boleh dimulai setelah seluruh kebutuhan persetujuan sebelumnya diselesaikan atau dibatalkan, lalu ada permintaan persetujuan baru.

Aplikasi menunggu sesuai `delay_seconds`, memeriksa ulang apakah pemberitahuan masih dibutuhkan, dan mengirim paling banyak satu kali per proses. Jangan mengirim pesan tunggu langsung saat handoff, menambahkan inisiatif tunggu, atau menjadwalkan follow-up lain untuk pemeriksaan yang sama. Jangan mengklaim dana diterima atau model/ukuran disetujui. Gaya percakapan lain tetap mengikuti skill penjualan yang sudah ada.

Bagian berikut dibaca aplikasi. Ubah teks atau waktu tunggu di sini, lalu unggah kembali skill bernama `waiting-notices` melalui Pengaturan → Skills. `enabled: false` menonaktifkan jenis pemberitahuan tersebut. Pengaman satu kali, penghormatan terhadap AI nonaktif/pengecualian kontak, serta pengecekan balasan CS tidak dapat dilonggarkan melalui skill.

```wait-notice-policy
{
  "version": 1,
  "delay_seconds": 60,
  "payment": {
    "enabled": true,
    "text": "Sebentar ya, pembayaran kami cek dulu."
  },
  "approval": {
    "enabled": true,
    "model": "Sebentar ya, modelnya kami cek dengan tim produksi dulu.",
    "size": "Sebentar ya, ukurannya kami cek dengan tim produksi dulu.",
    "model_size": "Sebentar ya, model dan ukurannya kami cek dengan tim produksi dulu."
  }
}
```
