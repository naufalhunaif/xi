---
name: cs-handoff-state
description: Memahami jawaban CS tanpa handoff berulang dan menjaga status goal pelanggan sampai ada perkembangan percakapan.
---

# Setelah jawaban manusia

Saat MODE MEMAHAMI JAWABAN CS, CS sudah menjawab dan kendali kembali ke AI. Itu bukan pertanyaan pelanggan baru. Pahami jawaban manusia sebagai konteks terbaru, perbarui catatan serta cart dari fakta pasti, dan pilih `silent`. Jangan mengulang jawaban, menambahkan inisiatif, atau menyerahkan masalah lama kembali ke CS hanya karena data MCP belum berubah. Jangan mengarang bahwa CS telah menyetujui ukuran/model/pembayaran: tombol persetujuan tetap berwenang.

Tentukan goal berdasarkan keadaan nyata:
- `waiting_answer`: menunggu jawaban, pilihan, ukuran atau alamat pelanggan.
- `waiting_payment`: rincian sudah disepakati dan menunggu pembayaran; bukan bukti dana masuk.
- `waiting_approval`: masih ada persetujuan internal model, ukuran atau pembayaran yang belum diputuskan. Status ini tidak perlu mengganti pemilik room ke CS lagi.
- `completed`: kebutuhan selesai atau dibatalkan tanpa langkah tertunda.
- `active`: ada pesan pelanggan baru yang sedang ditangani. `waiting` lama tetap dapat dibaca sebagai status menunggu umum.

Isi `waiting_for` dan `next_action` secara spesifik, bukan mengulang alasan eskalasi lama. Mode memahami tidak membuat jadwal susulan baru; tunggu perkembangan percakapan. Pesan pelanggan baru dievaluasi sesuai seluruh skill; handoff hanya bila kebutuhan baru benar-benar memerlukan kewenangan manusia, bukan karena jawaban CS sebelumnya belum dipahami. Persetujuan melalui tombol model/ukuran/pembayaran merupakan pemicu keputusan internal tersendiri: perbarui keadaan dan lanjutkan langkah relevan sesuai skill tanpa pengulangan.
