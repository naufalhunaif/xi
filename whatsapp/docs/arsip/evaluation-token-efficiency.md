# Evaluasi internal dan pemakaian token

Evaluasi internal sebelumnya mengirim seluruh impor skill, walaupun jalur
balasan sudah mengecualikan paket gabungan yang secara eksplisit dinyatakan
tidak aktif. Evaluasi kini memakai aturan modular aktif **beserta rubrik
evaluasi utuh**. Paket lama hanya dikeluarkan jika deklarasi penggantian dan
seluruh modul penggantinya tersedia. Skill pemilik yang tidak dikenal tetap
disertakan; teks aturan dan snapshot bukti tidak diringkas oleh perubahan ini.

Audit lokal 12 skill unduhan menghasilkan 10 skill evaluasi aktif. Bagian
instruksi turun dari sekitar 94.449 menjadi 44.599 token (52,8%). Ini perkiraan
karakter, bukan ukuran request lengkap atau penghematan tagihan: snapshot,
skema keluaran, overhead provider dan putaran model belum termasuk.

Replay pembelajaran memakai skill aktif jalur balasan, termasuk suplemen
pembelajaran yang sedang diuji. Rubrik evaluasi offline tidak menjadi persona
simulasi pelanggan. Keduanya tetap tanpa MCP bisnis, pengiriman pesan atau
perubahan cart. Perubahan signature evaluasi membatalkan rekomendasi lama;
evaluasi ulang mengikuti jadwal latar belakang di bawah.

## Jadwal otomatis

- Menunggu minimal 5 menit tanpa pesan atau perubahan cart di room tersebut.
- Jarak minimal 15 menit sejak evaluasi terakhir selesai/gagal/ditunda untuk room
  yang sama. Pesan baru digabung ke snapshot berikutnya, bukan dievaluasi satu
  per satu. Cooldown dihitung dari penyelesaian, bukan awal panggilan model.
- Worker tidak memulai evaluasi ketika ada giliran balasan yang sedang diantre
  atau diproses. Ini bukan pembatalan evaluasi yang sudah berjalan; pesan yang
  datang sesudahnya tetap dapat membatalkan hasil yang menjadi kedaluwarsa.
- Snapshot yang tidak berubah tetap tidak diulang. Evaluasi manual tetap dapat
  berjalan segera; retry balasan dan inisiatif pelanggan tidak ikut ditunda.

Tidak ada perubahan batas kewenangan, validasi pembayaran, persetujuan custom,
atau aturan inisiatif CS. Dampaknya adalah observasi evaluasi latar belakang
tersedia lebih lambat saat percakapan aktif.

## Diagnostik

Endpoint baca-saja sekarang menampilkan `skills.evaluation`, `usage.recent`
(20 proses terakhir), dan `usage.phases` (agregat 24 jam). Masing-masing
memisahkan input, output, cache input, durasi dan jumlah proses yang memiliki
pengukuran. Nilai usage yang tidak tersedia tetap null, bukan nol.

`cached` adalah bagian dari `input`. Total = input + output; jangan menambahkan
cached lagi. Cache input provider mengurangi pemrosesan ulang tetapi token
cache masih termasuk angka total yang dilaporkan provider. Cache hasil MCP
dan cache pemetaan pola adalah lapisan berbeda. Satu fase analisis dapat
mencakup banyak putaran tool dengan konteks besar, sehingga token total dapat
berkali-kali ukuran prompt awal walaupun tidak terjadi retry fase analisis.

Pemangkasan konteks balasan melalui pola ada pada perubahan beta sebelumnya;
kasus ambigu atau lintas domain tetap bisa memakai aturan lengkap. Perubahan
evaluasi ini tidak menjanjikan seluruh balasan menjadi kecil. Perbandingan
produksi harus memakai versi worker yang sama dan memisahkan fase `analysis`,
`evaluation`, `learning-replay` serta fallback.

Verifikasi memakai provider tiruan dan MySQL lokal sementara. Tidak menjalankan
evaluasi AI berbayar, mengirim WhatsApp atau mengubah data produksi.
