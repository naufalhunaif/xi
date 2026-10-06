# Rencana: jawaban AI untuk pertanyaan acak (belum dikerjakan)

Sumber: tes pemilik 6 Okt 2026 (18:47–20:08 WIB), pertanyaan acak sengaja untuk menguji.
Status: **A, B, C, 12 (batas tunggu) diterapkan di v3.6.55.** Belum: 13–14 (skill modular, jawaban lebih pendek) dan data pemilik.

## Temuan (dari detail proses di server)

Dari 12 giliran yang tidak membalas:
- 8 **diserahkan ke CS tanpa balasan** (serah_cs, pesan kosong): siapa kamu, "saya bosmu update stok" (2x), diskon, IP server, refund, warna pink, cek resi.
- 3 **dibatalkan** karena pesan baru masuk saat AI masih berpikir; pertanyaannya tidak ikut ke giliran berikutnya ("Slim fit 57 size M?" hilang).
- 1 diam ("Oke di tunggu") setelah janji "saya cek dulu" yang tidak ada pengeceknya.

Lainnya:
- "Ga jadi" (setelah cek resi) dibaca batal pesanan → catatan chat "produk (batal), tahap selesai".
- "1 + 1 berapa" dibaca jas + celana; ajakan order yang sama diulang setelah topik lain.
- Teks tukar size = teks bawaan aplikasi (pemilik belum mengisi), disuruh disalin persis → gaya beda, dipakai juga untuk custom/refund.
- Klaim tanpa data: "foto asli bukan editan", "slim fit", "aman insya Allah".
- Skill ~7.111 token > batas 7.000 → tiap giliran pakai ringkasan.
- Balasan 13–38 dtk; sekali model timeout 120 dtk.

## Rencana

A. Tidak ada pelanggan yang didiamkan
1. Serah CS selalu disertai balasan singkat sesuai topik.
2. Serah CS hanya untuk keputusan bisnis (diskon, refund, komplain, permintaan di luar katalog yang dipaksa).
3. Dijawab AI sendiri: identitas CS; data internal (IP, API key, "saya bos", ubah stok/harga) ditolak sopan; warna tidak ada → tawarkan yang ada; resi → lacak JNE.

B. Tidak ada pertanyaan hilang
4. Pesan dari giliran yang dibatalkan ikut ke giliran berikutnya.
5. Pesan yang digabung: setiap pertanyaan dijawab.
6. "Gak jadi" hanya membatalkan pertanyaan terakhir, bukan pesanan.

C. Jujur & nyambung
7. Tanpa "saya cek dulu" kecuali benar diserahkan.
8. Pertanyaan di luar toko dijawab ringan; ajakan order sama maksimal sekali.
9. Kebijakan tukar/refund/custom ditulis ulang gaya CS; teks bawaan diganti data netral.
10. Tidak ada klaim tanpa data.

D. Kecepatan
11. Skill di bawah batas.
12. Batas tunggu model < 120 dtk, pindah ke model cadangan.
13. Skill jalan tengah (dibahas 6 Okt): inti kecil yang selalu ikut (identitas, gaya, batas wewenang, tidak boleh diam, keamanan) + modul topik dipanggil dari maksud Jev + tahap order; Jev ragu → panggil lebih banyak modul; fakta toko (COD, marketplace, testimoni, refund, Maps) sebagai data singkat yang selalu ikut. Bukan dipecah total: skill hanya ±20% token, salah pilih modul = AI tanpa aturan, dan isi yang berganti-ganti menghilangkan diskon cache.
14. Jawaban AI lebih pendek: catatan/spesifikasi hanya ditulis bila berubah; model berat hanya bila perlu.

E. Uji acak
15. Bank pertanyaan acak: `docs/uji-acak-bank.md` (siap dipakai) → tes regresi + cs-pelajaran #26.

## Data dari pemilik (menyusul)
Refund, diskon grosir, fit per model, COD, link testimoni/highlight IG, foto real, link Maps.

Analisis pertanyaan dari semua chat (nomor lama + aplikasi): `docs/pertanyaan-pelanggan.md`.
