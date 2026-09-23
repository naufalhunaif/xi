# Audit maksud percakapan dan cakupan persetujuan

## Kasus yang direproduksi

Pelanggan meminta Peak Suit berbadan navy dengan kerah tetap hitam; CS menjawab “iya bisa bos”. Pelanggan kemudian memilih celana 30 dan menyetujui rekomendasi jas S. Validator lama menolak sebagian penulisan ulang catatan produksi yang setara dengan error `Detail desain katalog tidak cocok dengan permintaan yang disetujui CS.`. Pemeriksaan daftar kata juga bisa menerima catatan dengan warna badan/lapel terbalik, sebab kedua nama warna ada pada pesan pelanggan.

Perbaikan membandingkan penempatan fakta, memverifikasi pesan sumber dan pemberi persetujuan, serta mempertahankan persetujuan tersimpan ketika hanya label/catatan yang ditulis ulang. Pemeriksaan baru berjalan lokal tanpa memanggil model tambahan atau membuang riwayat percakapan.

## Matriks pemeriksaan

| Maksud | Perilaku yang diuji |
| --- | --- |
| Desain yang sama, susunan kalimat berbeda | Warna badan dan lapel tetap dipetakan ke bagian yang benar; istilah kerah/lapel, hitam/black, dan navy/biru navy dinormalisasi. |
| Warna terbalik, alternatif, negasi, detail baru | Tidak menjadi persetujuan untuk desain yang diajukan. Shade/material tambahan tidak hilang saat membandingkan warna. |
| Catatan menyebut persetujuan CS | Catatan tersebut tidak menggantikan bukti pesan CS asli. |
| Permintaan menyebut detail tetapi cart melupakannya | Warna badan/lapel, bahan, atau kancing yang disebut harus tetap tersimpan pada field masing-masing. |
| Bahan/kancing | Tidak dapat disetujui hanya karena nilainya muncul pada field warna atau konteks lain. |
| Persetujuan CS setelah pertanyaan lain | Jawaban singkat membutuhkan kutipan yang benar; konfirmasi yang menyebut ulang desain secara eksplisit dapat diverifikasi. |
| Sumber/urutan/produk berbeda | AI, pelanggan, room lain, pesan gagal, produk lain, balasan ke topik lain, dan bukti sebelum pembatalan tidak memberi otorisasi. |
| Konfirmasi ukuran | Tidak memberikan persetujuan ukuran custom, harga khusus, pembayaran, atau checkout. |
| “Halo/Gimana” sesudah keputusan sah | Regresi checkout menjaga persetujuan sebelumnya selama isi pesanan tetap sama; sapuan waiting tidak menganalisis ulang pesan yang sudah selesai. |
| Harga paket | Nilai komponen harus berasal dari kutipan manusia dan katalog; tidak membagi harga dengan perkiraan. |
| Checkout/saldo | Harus cocok dengan rekap, bukti persetujuan, dan cart yang sama; perubahan barang/alamat dan persetujuan lain tidak mengizinkan pengeluaran saldo. |
| Pre-order | Tetap per item, berdasarkan kebijakan lokal dan keputusan CS; stok kosong tidak otomatis menjadi pre-order. |
| Retry/handoff lama | Pemeriksaan ulang satu kali untuk error validator lama hanya pada room AI, belum mengirim balasan, dan masih dalam anggaran retry. Room CS tidak diambil alih. |

## Validasi

165 tes pada suite terpilih:

- 63 unit: desain, protokol bukti manusia, bahasa checkout, dan detail pengerjaan.
- 40 integrasi cart/harga/persetujuan/checkout.
- 7 integrasi pre-order.
- 4 integrasi penyimpanan detail pengerjaan.
- 13 integrasi pemulihan analisis.
- 38 regresi aktivasi, goal, evaluasi, dan waiting.

Database integrasi dibuat sementara dan dihapus setelah selesai. Provider dan pengiriman memakai tiruan; tidak ada WhatsApp sungguhan yang dikirim atau model berbayar yang dipanggil. Build TypeScript dan lint file layanan yang diubah juga diperiksa.

## Batas hasil

Ini audit jalur aplikasi dan kasus percakapan terpilih, bukan bukti bahwa model memahami seluruh bahasa bebas tanpa kesalahan. Ungkapan yang belum dapat diverifikasi, konflik fakta, dan bukti yang kurang tetap memerlukan pemeriksaan; validator tidak mengarang persetujuan. Pengujian tidak mengukur kualitas keluaran model langsung di produksi.

Diagnostik baca-saja produksi pada 20 September menunjukkan database terjangkau dan trace terbaru selesai, tetapi tidak membuka field desain cart. Aktivitas bertanggal 18 September yang disalin pengguna adalah pemilihan/foto produk, bukan detail kegagalan cart terbaru. Karena itu field tepat pada kejadian produksi belum dapat dipastikan; kesalahan validator direproduksi dengan konteks permintaan dan persetujuan yang sama pada fixture. Perilaku produksi perlu diverifikasi setelah deploy.

## Temuan lanjutan: cart hanya menyimpan celana

Diagnostik versi 2 pada 20 September 2026 pukul 14:12 WIB memastikan deploy aktif, koneksi database sehat, tetapi keputusan terakhir adalah handoff dengan kode `CATALOG_DESIGN_NOTES_MISMATCH`, tanpa balasan tercatat. Room AI mempunyai goal paused tanpa jadwal retry. Cart tersimpan berisi satu item katalog, tanpa field lapel dan tanpa referensi persetujuan desain. Tampilan cart yang diberikan pengguna mengonfirmasi item tersebut celana; jas dan perubahan warna hanya tertulis pada catatan umum.

Perbaikan lanjutan:

- Instruksi pengisian menempatkan desain pada item jas, bukan pada catatan umum atau celana; fakta terstruktur tidak perlu diulang sebagai paragraf catatan.
- Penolakan khusus catatan yang berpotensi ekuivalen dapat menjalani satu permintaan perbaikan kecil tanpa seluruh skill, MCP, gambar, atau failover provider. Hasil hanya boleh mengubah `productionDetails.notes`; seluruh field produk, ukuran, jumlah, harga, pengiriman dan referensi persetujuan tetap sama.
- Kontradiksi eksplisit pada warna/lapel, bahan/kancing baru, negasi dan syarat tidak dapat dihapus untuk melewati validasi. Catatan yang tidak jelas tetap ditolak. Setelah usulan penulisan ulang diterima, validator cart memeriksa ulang bukti CS, sumber data, katalog dan versi cart sebelum menyimpan.
- Pesan pelanggan baru membatalkan hasil lama. Kegagalan perbaikan tidak berulang rekursif dan tidak mengirim balasan tanpa verifikasi.
- Handoff catatan yang sudah paused dipulihkan sekali hanya pada room yang tetap AI, belum mencatat balasan, dan masih dalam anggaran retry. Penanda pemulihan bertahan setelah restart; room CS tidak diambil alih.

Validasi tambahan: 58 tes unit desain/perbaikan/diagnostik, 45 integrasi bukti cart, 14 pemulihan analisis, dan 29 regresi draft katalog (146 tes). Build dan lint layanan yang berubah lulus. Reproduksi worker memakai provider/socket tiruan: dari satu item celana menjadi dua item dengan jas S/navy/lapel hitam dan celana 30, lalu satu balasan menanyakan tujuan. Hasil model asli dan pemulihan room produksi tetap perlu diverifikasi setelah deploy; tes tidak membuktikan semua ungkapan bahasa bebas ekuivalen.

## Temuan lanjutan: pilihan lengkap tetapi keputusan silent

Diagnostik produksi 20 September pukul 14:30 WIB pada release-i71zbq menunjukkan dua proses terbaru selesai dengan outcome `silent`, tanpa balasan tercatat atau penolakan validasi cart. Cart kini mempunyai dua item; item jas menyimpan persetujuan desain serta field warna/lapel. Tampilan pengguna menunjukkan goal masih menunggu keputusan ingin memesan, meskipun pelanggan telah memilih kombinasi, menyetujui ukuran dan menanyakan kelanjutannya. Ini adalah keputusan percakapan yang perlu dikoreksi, bukan bukti gagalnya pengiriman inisiatif.

Instruksi balasan kini memisahkan pemilihan barang, pengumpulan data, dan otorisasi transaksi. Pilihan yang jelas dalam percakapan aktif cukup untuk menanyakan satu data berikutnya yang belum diminta, misalnya kecamatan untuk menghitung ongkir. Catatan AI lama “belum checkout” tidak menghalangi pertanyaan itu. Konfirmasi ukuran tidak menjadi persetujuan checkout, rekap, saldo, atau pembayaran. Pertanyaan yang sudah terkirim, penundaan/penolakan, dan pilihan ambigu tetap dihormati; tidak ada sapuan baru untuk menganalisis ulang seluruh room waiting.

Dua uji model langsung memakai konteks sintetis, skill lokal format/cart, tanpa MCP bisnis atau pengiriman WhatsApp: tujuan belum ditanyakan menghasilkan satu pertanyaan tujuan; tujuan sudah ditanyakan menghasilkan `silent`. Keduanya tidak menghasilkan checkout saldo atau laporan pembayaran. Jalankan dengan `AI_SKILL_LIVE_TEST=1 node scripts/test_cart_discount_database.mjs --initiative-progress`; runner membuat dan menghapus database sementara. Percobaan awal memakai database pengembangan gagal sebelum memanggil AI karena tabel lokal tidak dapat dibuka; hasil lulus diperoleh setelah isolasi database, tanpa memperbaiki atau menghapus database pengembangan.

Perbaikan berlaku pada proses berikutnya sesudah deploy. Keputusan silent lama tidak otomatis diulang saat worker restart; pesan pelanggan baru atau review yang sah diperlukan. Dua fixture model bukan jaminan semua ungkapan/skill produksi akan selalu menghasilkan jawaban yang sama.

Validasi akhir perubahan kelanjutan: 19 tes unit kontrak/goal, 38 integrasi waiting/aktivasi/evaluasi/goal, dan dua fixture model langsung lulus (59 tes). Build TypeScript, lint layanan/tes yang berubah, serta pemeriksaan whitespace lulus.

## Koreksi inisiatif bersyarat

Balasan berikutnya yang dilaporkan pengguna sudah meminta data, tetapi masih menyatakan “belum ada konfirmasi lanjut” dan “kalau jadi pesan”. Diagnostik pukul 14:44 WIB pada release-TYyWw5 menunjukkan outcome `reply`, balasan tercatat, tanpa kegagalan validasi cart. Perbaikan sebelumnya mencegah keputusan diam pada fixture terpilih, tetapi belum cukup menguji atau mengarahkan bahasa ajakan yang bersyarat.

Kontrak peran CS kini mencakup membantu pilihan, menyelesaikan keraguan, meminta data yang kurang, dan menyiapkan rekap sesuai tahap. Deskripsi schema initiative, objective dan waiting_for serta prompt balasan teks/perbandingan visual memakai arahan yang selaras. Sesudah pilihan disepakati, pertanyaan data disampaikan langsung; tidak ada syarat konfirmasi lanjut tambahan atau pengumuman status internal yang tidak ditanyakan. Informasi promo/stok tetap memerlukan bukti, penundaan/penolakan dihormati, dan persetujuan transaksi serta batas susulan tetap berlaku. Tidak ditambahkan pemanggilan model untuk mengoreksi setiap balasan atau loop analisis baru.

Fixture live diperluas: pertanyaan tujuan tanpa ajakan bersyarat; diam setelah tujuan sudah ditanyakan; meminta nama penerima ketika alamat/nomor/layanan sudah tersedia; menghormati pelanggan yang menunda. Pengujian tetap memakai skill lokal format/cart dan data sintetis, bukan seluruh skill/config produksi atau pesan pelanggan sungguhan.

Hasil koreksi: empat fixture model langsung dan 19 tes unit goal/semantik lulus; build TypeScript, lint layanan/tes terkait dan whitespace lulus. Verifikasi produksi sesudah deploy tetap diperlukan untuk melihat penerapan pada konteks dan skill asli.
