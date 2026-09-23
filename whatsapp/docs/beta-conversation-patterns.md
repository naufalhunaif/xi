# Beta: cache pola penanganan dengan variabel percakapan

Runtime `beta-patterns-v1`, pustaka `patterns-v1`. Melanjutkan level index beta.
Tidak membutuhkan Redis, embedding API atau database baru.

## Yang digunakan ulang

Pola berisi tujuan, langkah bersyarat, variabel yang harus diisi, dan data/bukti
yang perlu diperiksa kembali bila rinciannya berubah. Tersedia 11 pola:

| ID | Kebutuhan |
| --- | --- |
| `catalog` | Produk, varian, harga dan stok |
| `fit` | Ukuran katalog dan rekomendasi fit |
| `custom-size` | Ukuran khusus dan persetujuannya |
| `catalog-design` | Warna/lapel/bahan/detail produk katalog |
| `reference-design` | Model dari gambar pelanggan |
| `cart-details` | Melengkapi pilihan, penerima dan rincian pesanan |
| `shipping` | Tujuan, berat, layanan dan ongkir |
| `payment` | Rekap, saldo, DP, laporan transfer dan pelunasan |
| `order-progress` | Progres produksi atau pengiriman order |
| `after-sales` | Keluhan, retur, penukaran dan refund |
| `change-order` | Perubahan, penundaan atau pembatalan |

Cache berisi hasil penyusunan pemetaan skill dan sumber aturan, dibatasi per
workspace, versi workspace, hash seluruh skill aktif, versi pustaka dan cakupan
domain. Maksimal 64 profil dalam satu proses, umur 30 menit, eviksi LRU. Restart
worker mengosongkan cache. Edit skill atau perubahan cakupan menghasilkan key baru.
Nilai warna, ukuran, produk, pesan, alamat, ID room, jawaban AI, status pembayaran
dan persetujuan pelanggan tidak menjadi isi cache pola.

Pola berasal dari prosedur aplikasi yang ditulis dan diuji, bukan hasil belajar
otomatis dari arsip pelanggan. Pustaka ini belum menambang pola baru sendiri.

## Pemahaman dan eksekusi

1. Pemetaan lokal memilih konteks awal berdasarkan domain dan pertanyaan aktif.
   Ini petunjuk, bukan bukti maksud atau kewenangan transaksi.
2. Pada fase analisis yang sama, AI membaca pesan serta state asli dan memilih
   satu atau beberapa pola secara semantik melalui
   `business_skill_library.read_business_skill({ patternIds: [...] })`.
3. Tool mengembalikan prosedur dan teks skill asli yang dibutuhkan, termasuk
   dependensi/aturan induk. Bagian yang sudah diberikan tidak dikirim ulang pada
   pembacaan pola di fase yang sama. `all` dan `sectionIds` tetap dapat mengambil
   teks sumber utuh bila diperlukan.
4. Variabel diisi dari konteks dan bukti saat ini. Seluruh alur MCP, cache data,
   validasi cart, persetujuan CS dan ledger dari main tetap dijalankan. Hasil
   baca pola tidak dihitung sebagai bukti harga, stok, ukuran atau pembayaran.
5. Pola ambigu/kebutuhan lain dapat membaca sumber tambahan. Pemeriksaan cakupan
   skill dan fallback lengkap tetap berlaku sebelum balasan/tindakan diteruskan.

Tidak ada model classifier tambahan. Pemilihan semantik terjadi di proses AI
yang sama, bukan pencocokan embedding jawaban pelanggan. Tool read-only ini
tidak menerima parameter tindakan, persetujuan atau akses room lain.

Setiap pemanggilan provider membuat catatan pembacaan skill sendiri. Cache hit
tidak berarti model baru sudah membaca aturan yang diambil model sebelumnya.
Metadata dan isi profil yang diberikan ke pemanggil disalin agar perubahan
satu pemanggil tidak merusak profil pelanggan/proses lain.

Contoh: dua pelanggan meminta badan navy dan maroon dengan lapel hitam. Mereka
dapat memakai pola `catalog-design` yang sama, tetapi warna dan bukti CS masing-
masing tetap berbeda. Mengubah warna memicu pemeriksaan cakupan persetujuan model;
ukuran yang tidak diubah dipertahankan. Pengaman akhir tetap validator bukti
utama, bukan kalimat prosedur di cache.

## Penghematan dan batas

Cache profil menghemat penyusunan pemetaan lokal; cache hit sendiri tidak
menghilangkan panggilan model dan bukan nol token. Pengurangan input model
berasal dari pemuatan aturan yang relevan serta menghindari pengiriman ulang
aturan melalui tool. Cache hasil MCP merupakan lapisan terpisah.

Audit lokal pada skill unduhan, menggunakan teks pertanyaan sintetis:

| Skenario | Skill/peta sebelumnya | Skill/peta pola | Pengiriman awal |
| --- | ---: | ---: | --- |
| Katalog | ≈41.292 token | ≈24.966 token | Bagian relevan, pengurangan ≈39,5% |
| Visual | ≈41.292 token | ≈41.762 token | Lengkap, termasuk direktori pola |
| Checkout | ≈41.292 token | ≈41.762 token | Lengkap, termasuk direktori pola |
| Ambigu | ≈41.292 token | ≈41.762 token | Lengkap, termasuk direktori pola |

Ini **hanya instruksi skill dan petanya**, belum konteks percakapan, skema output,
skema MCP dan putaran provider. Bukan penghematan tagihan produksi. Penghematan
di bawah 25% masih menggunakan aturan lengkap untuk membatasi risiko analisis
ulang. Kasus tersebut mendapat overhead direktori pola sekitar 470 token;
tidak ada klaim semua request menjadi lebih murah.

Pengujian menggunakan provider/socket tiruan dan database lokal sementara.
Tes membuktikan isolasi cache, sumber utuh, dependensi, invalidasi, detail baru
tetap masuk prompt dan pembacaan ulang yang hemat. Tes tersebut tidak membuktikan
akurasi model produksi untuk seluruh bahasa/aksen; ukur pemilihan pola yang salah,
fallback, total usage dan waktu pada trace produksi setelah deploy.

## Diagnostik

- `pattern-cache`: hit/miss pemetaan aturan, versi pustaka, hash kebijakan,
  jumlah pola, dan perkiraan penghematan kandidat. Tidak memuat fakta pelanggan.
- `skill-routing`: bagian terpilih/tertunda, konteks penuh atau routed, runtime
  `beta-patterns-v1`.
- Pemanggilan `read_business_skill`: `patternIds` memperlihatkan pola yang dipilih.
  Diagnostik jarak jauh hanya mengekspor ID dalam allowlist.
- `prompt-size`, usage fase AI dan `level-summary`: ukuran aktual perkiraan input,
  penggunaan provider, jumlah proses dan fallback. Jangan menyamakan cache profil
  dengan cache hasil MCP atau cache input provider.

Pemasangan mengikuti deploy beta biasa. Tidak ada pengiriman WhatsApp nyata,
perubahan data produksi atau evaluasi AI berbayar saat pengembangan ini.
