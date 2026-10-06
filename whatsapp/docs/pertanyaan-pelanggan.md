# Peta pertanyaan pelanggan (analisis chat, 6 Okt 2026)

Tujuan: tahu pertanyaan apa saja (termasuk yang jarang/acak) yang pernah ditanyakan pelanggan,
seberapa sering, dan data apa yang perlu disiapkan supaya AI bisa menjawab. Belum diterapkan
ke AI — dipakai bersama `rencana-uji-acak.md` dan `uji-acak-bank.md`.

## Sumber
| Sumber | Isi | Pertanyaan* |
|---|---|---|
| Ekstrak WhatsApp nomor toko lama (2018 – 12 Sep 2026) | 356.106 pesan, 5.705 chat pribadi, 145.976 pesan teks pelanggan | 54.052 di 5.316 chat |
| Aplikasi (room nomor AI, 540 room aktif) | 29.734 pesan, 15.060 pesan teks pelanggan | 5.024 di 452 chat |

\* Pesan pelanggan yang berbentuk pertanyaan ("?", apa/berapa/bisa/gimana/kapan/ada/…), tanpa form order.
Satu pesan bisa masuk >1 kategori. Kategori dicocokkan dengan pola kata, jadi angkanya perkiraan.
Contoh asli + jawaban CS (PRIBADI, tidak di repo): `~/Downloads/analisis-pertanyaan-acak/contoh_pertanyaan_dan_jawaban_cs.md`.

## 1. Pertanyaan utama (sudah ditangani skill, tetap dipantau)
| Kategori | Toko lama (tanya / chat) | Aplikasi (tanya / chat) |
|---|---|---|
| Ukuran & fit (TB/BB, slim, kebesaran) | 7.247 / 2.842 | 597 / 194 |
| Harga | 6.870 / 2.737 | 615 / 217 |
| Warna, model, bahan, kualitas | 6.554 / 2.276 | 670 / 174 |
| Stok / ready | 4.794 / 2.286 | 369 / 170 |
| Ongkir & pengiriman | 4.613 / 1.834 | 487 / 142 |
| Custom / PO | 4.112 / 2.037 | 372 / 165 |
| Lama produksi / estimasi | 3.189 / 1.795 | 292 / 111 |
| Pembayaran | 2.309 / 1.208 | 237 / 66 |
| Foto / video / katalog | 2.048 / 1.166 | 159 / 79 |
| Status pesanan / resi | 1.812 / 1.082 | 181 / 70 |
| Lokasi & jam toko | 1.265 / 875 | 143 / 70 |
| Marketplace / website | 1.018 / 733 | 89 / 61 |
| Diskon / nego | 987 / 603 | 110 / 49 |
| Minta admin / telepon / "kok gak dibalas" | 854 / 569 | 136 / 66 |
| Tukar / retur / komplain | 514 / 364 | 54 / 24 |

## 2. Pertanyaan jarang / "acak" yang perlu disiapkan
Kolom "Siap?": ✓ data sudah ada di AI · ½ sebagian · ✗ belum ada data/aturan.

| Kategori | Toko lama | Aplikasi | Contoh pertanyaan (disamarkan) | Siap? | Yang perlu disiapkan |
|---|---|---|---|---|---|
| Isi paket ("1 set sudah sama celana/rompi/kemeja/dasi?") | 799 / 659 | 53 / 41 | "itu udah sama celana?", "include rompi?", "jas aja?" | ½ | Aturan tegas: harga katalog = per item; setelan = jas + celana; rompi/kemeja/dasi terpisah |
| Detail konstruksi (kancing, saku, furing, busa, karet pinggang, list, doff/kilap, kerah, belahan) | 1.510 / 820 | 175 / 63 | "kancingnya berapa?", "full furing & ada busanya?", "pinggangnya ada karet?", "doff atau glossy?" | ✗ | Spesifikasi per model/seri (kancing, furing, saku, kilap) |
| Beda model / seri / merek lain | 657 / 482 | 69 / 36 | "bedanya peak suit dan basic suit?", "beda signature apa?", "kancing 1 vs 2?" | ½ | Ringkasan pembeda tiap seri (bahan, kilap, harga, potongan) |
| Nuansa warna (terang/gelap, beda dengan foto) | 610 / 392 | 83 / 27 | "navy-nya terang?", "agak gelap atau efek cahaya?", "grey itu abu muda?" | ✗ | Keterangan nuansa per warna + kalimat jujur soal perbedaan layar |
| Saran / styling | 788 / 605 | 58 / 39 | "dasi warna ini cocok?", "bagusnya fit atau agak besar?", "bawahan hitam oke?" | ½ | Panduan padu-padan singkat |
| Cara ukur / size chart | 575 / 476 | 27 / 22 | "cara ngukurnya?", "diukur pakai apa?", "dilebihkan berapa cm?" | ½ | Tutorial ukur (bagian yang diukur) + link/foto size chart |
| Cara order / form / akun web | 372 / 332 | 23 / 19 | "cara pesannya?", "note diisi apa?", "harus daftar akun?" | ½ | Langkah order WA & web, isi note, daftar/login (Google) |
| Produk lain (kemeja, dasi, dasi kupu, anak, wanita, celana/rompi saja) | 1.103 / 632 | 182 / 61 | "bisa buat anak 3 tahun?", "kancing di kanan untuk perempuan?", "jual kemeja?" | ½ | Daftar yang dijual/tidak + batas usia/ukuran (mis. 4XL) |
| Progres pesanan | 661 / 442 | 91 / 40 | "sudah jadi?", "bisa lihat progresnya?", "sudah disetrika?" | ✗ | Status produksi per order (dari tim) |
| Tenggat acara | 992 / 572 | 118 / 43 | "dipakai tgl 10 keburu?", "sebelum lebaran jadi?", "Jumat sampai Medan?" | ½ | Hitung tanggal: produksi + kirim ke kota tujuan; kalau mepet → ready stock |
| Detail kirim (dari mana, berat, ekspedisi lain, packing, antar) | 653 / 533 | 66 / 29 | "dikirim dari mana?", "Lion/TIKI bisa?", "beratnya berapa kilo?" | ½ | Asal kirim, ekspedisi yang dipakai, berat per item |
| Pembayaran lain (full/DP, paylater, kartu kredit, COD) | 39 / 36 | 2 / 2 | "DP atau full?", "bisa paylater?", "bayar di tempat?" | ✗ | Aturan DP/full, metode yang diterima |
| Promo / event | 351 / 245 | 22 / 14 | "big sale anniv ketentuannya?", "yang dipromosikan ini?" | ✗ | Promo aktif + syarat (diperbarui pemilik) |
| Link IG / website / katalog | 889 / 672 | 76 / 51 | link postingan IG, "share katalog", "pesan di web sama saja?" | ½ | AI membaca link produk web/IG; link katalog resmi |
| Partai besar / seragam / reseller / kerja sama | 290 / 218 | 38 / 18 | "60–80 jas sekali pesan bisa?", "seragam kantor", tawaran sponsor | ✗ | Aturan pesanan banyak (min, harga, waktu) → CS, tetap dibalas |
| Ubah / vermak / revisi sesudah jadi | 310 / 226 | 51 / 19 | "lengan kurangi 1 cm bisa?", "kebesaran bisa dipermak?", "masih bisa revisi?" | ½ | Aturan revisi/perbaikan sesudah terima |
| Kepercayaan (aman, penipu, benar ini toko, testimoni) | 111 / 99 | 8 / 7 | "bisa dipercaya?", "benar ini Chameleon Cloth?", "ada bukti pembelian?" | ✗ | Link highlight testimoni IG, alamat toko, website |
| Perawatan (cuci, laundry, setrika) | 74 / 46 | 6 / 2 | "boleh di-laundry?", "setrika pakai apa?" | ✗ | Panduan perawatan singkat |
| Sewa | 56 / 52 | 5 / 5 | "bisa sewa jas?" | ✗ | Jawaban ya/tidak |
| Lowongan kerja | 10 / 7 | – | "ada loker?" | ✗ | Jawaban standar |

Temuan khusus aplikasi (nomor AI): jasa jahit dengan bahan sendiri, toko di kota lain ("di Jabodetabek ada store?"),
harus fitting dulu?, sampel kain, bayar bertahap, kode/nomor kain, "bahannya wool asli?".

## 3. Jawaban yang pernah dipakai CS (calon data AI — WAJIB dikonfirmasi pemilik dulu, bisa sudah berubah)
- Marketplace: tidak di Shopee/Tokopedia; pesan lewat website atau WhatsApp.
- COD/bayar di tempat: tidak tersedia. Paylater: tidak bisa. DP vs full: jawaban CS pernah berbeda-beda ("full payment" vs "DP bisa, full juga bisa") → perlu satu aturan.
- Dikirim dari Cilacap.
- Testimoni: di highlight Instagram, dan pelanggan ditag di feed.
- Diskon: "sudah harga pas".
- Kancing 2 lebih formal, kancing 1 lebih santai.
- Bahan premium cenderung mengkilat; ada bahan tidak mengkilat (mis. wool blend) — bukan 100% wool.
- Note di web: boleh dikosongkan bila tidak ada keterangan khusus. Akun web: daftar/login (bisa via Google).
- Perawatan: boleh laundry; setrika uap.
- Ukuran 4XL: pernah dijawab belum bisa produksi.
- Jasa jahit bahan sendiri: pernah ada tarif khusus (jas dan celana terpisah).
- Lama produksi: dijawab bervariasi (±1 minggu sampai ±2 minggu) → perlu angka resmi.

## 4. Pola jawaban CS yang JANGAN ditiru AI
- Banyak pertanyaan dibalas sapaan otomatis ("Terima kasih telah menghubungi …") atau hanya "pagi/siang", tanpa menjawab.
- Jawaban tidak nyambung dengan pertanyaan (mis. ditanya isi paket, dijawab harga jas saja; ditanya cara pesan, dijawab rekap pesanan).
- Jawaban berbeda untuk pertanyaan yang sama (DP/full, lama produksi).

## Langkah berikutnya (belum dikerjakan)
1. Pemilik mengonfirmasi/melengkapi data di bagian 2 (✗/½) dan bagian 3.
2. Data dimasukkan sebagai "fakta toko" (selalu ikut, singkat) — lihat rencana skill jalan tengah di `rencana-uji-acak.md`.
3. Tambah 1–2 pertanyaan per kategori ke `uji-acak-bank.md` untuk uji regresi.
