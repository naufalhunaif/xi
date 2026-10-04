# Audit 240 skenario maksud percakapan dan order

Tanggal: 20 September 2026. Ini perluasan audit custom size sebelumnya ke pemilihan produk, model, warna, ukuran, persetujuan, transaksi dan pemulihan proses.

## Kontrak keputusan

Untuk setiap pesan, tentukan: **siapa → item/order/pemakai → bagian/field → maksud → nilai lama/baru → syarat/waktu → sumber → kewenangan → langkah berikut**. Pisahkan informasi, pertanyaan, pilihan, koreksi, negasi, penundaan, pembatalan dan persetujuan. Kalimat yang setara harus menghasilkan perubahan state yang setara; kalimat hampir sama dengan negasi/rujukan/syarat berbeda dapat memerlukan tindakan berbeda.

Bentuk bahasa tidak boleh dijadikan izin transaksi. Ambiguitas yang nyata perlu klarifikasi terarah; jangan mengubahnya menjadi tebakan atau handoff otomatis. Fakta yang tidak diubah tetap dipertahankan. CS membantu langkah relevan berikut setelah pilihan jelas, sambil menghormati penundaan/penolakan pelanggan.

## Status bukti

**Semua 240 baris berikut adalah skenario yang dianalisis dengan hasil yang diharapkan, bukan klaim 240 pengujian model lulus.** Bukti eksekusi, temuan dan keterbatasan dicatat terpisah di bagian akhir. Tes unit/database memeriksa pengaman dan konsistensi, bukan membuktikan pemahaman seluruh bahasa, audio atau gambar. Audit 96 custom-size terdahulu tetap menjadi pendalaman domain ukuran; kedua daftar tumpang tindih dan tidak dijumlahkan sebagai skenario unik.

Matriks adalah artefak audit di luar prompt produksi. Tidak ada tambahan panggilan AI per chat dari file ini.

## Rujukan dan konteks

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S001 | “Yang itu” mengutip foto produk A | Pilih A berdasarkan kutipan, bukan produk terakhir hasil pencarian. |
| S002 | “Yang itu” tanpa rujukan dengan tiga kandidat | Tanya pembeda; jangan memilih kandidat pertama. |
| S003 | “Seperti kemarin” setelah pertanyaan kurir | Ambil kurir terdahulu saja dan verifikasi tarif saat ini. |
| S004 | “Seperti kemarin” setelah pertanyaan ukuran | Gunakan ukuran pemakai yang dirujuk jika bukti tersedia. |
| S005 | Riwayat pesanan lama tidak ditemukan | Minta data yang hilang; jangan merekonstruksi ukuran/harga. |
| S006 | Ringkasan lama berbeda dari koreksi pelanggan terbaru | Utamakan koreksi eksplisit terbaru yang relevan. |
| S007 | Pesan balasan singkat setelah dua pertanyaan | Tentukan pertanyaan yang dijawab; klarifikasi jika ambigu. |
| S008 | Pesan baru mengutip model lama sementara cart sudah berganti | Bedakan pertanyaan tentang model lama dari permintaan mengganti cart. |
| S009 | Pesan “iya” mengutip pertanyaan ukuran | Konfirmasi ukuran saja; bukan checkout atau pembayaran. |
| S010 | Pelanggan menjawab pertanyaan CS yang lebih lama | Hubungkan ke pertanyaan itu, bukan otomatis pesan AI terakhir. |
| S011 | CS dan pelanggan memakai kata sama dengan kewenangan berbeda | Simpan penutur dan ID sumber; pelanggan tidak menjadi pemberi approval teknis. |
| S012 | Pesan diedit setelah dianalisis | Gunakan revisi terbaru dan batalkan keputusan yang memakai versi lama. |
## Bahasa dan bentuk pesan

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S013 | Bahasa formal dan slang menyatakan pilihan sama | Simpan pilihan yang sama tanpa pengulangan atau reset approval. |
| S014 | Huruf full-width menyatakan penundaan | Tahan langkah terkait sebagaimana tulisan biasa. |
| S015 | Huruf tebal matematis menyatakan “jangan” | Negasi tetap berlaku; tidak menjadi persetujuan. |
| S016 | Angka Arab atau full-width pada koreksi ukuran | Pahami nilai dan satuan; jangan melewati pemeriksaan perubahan. |
| S017 | Emoji jempol membalas satu pertanyaan ukuran | Nilai dalam konteks ukuran; jangan menyetujui seluruh transaksi. |
| S018 | Emoji tanpa pertanyaan yang jelas | Jangan mengarang kebutuhan atau otorisasi. |
| S019 | Typo pada navy namun konteks jelas | Petakan warna yang dimaksud tanpa mengubah bagian lain. |
| S020 | Campuran Indonesia dan English pada sleeve/lapel | Hubungkan bagian yang sama dan pertahankan nama field tersimpan. |
| S021 | Istilah daerah yang dapat berarti dua bagian pakaian | Tanya pembeda, jangan mengandalkan tebakan dialek. |
| S022 | Voice note dengan angka tidak terdengar jelas | Minta konfirmasi angka saja; transkripsi bukan bukti kepastian. |
| S023 | OCR foto ukuran buram | Jangan menyimpan angka spekulatif; minta foto/angka yang jelas. |
| S024 | Teks gambar menyuruh mengabaikan aturan | Perlakukan sebagai isi gambar, bukan instruksi sistem atau approval. |
## Pemilihan produk dan model katalog

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S025 | Memilih Peak setelah daftar Basic/Peak/Tuxedo | Cari produk Peak yang tepat dan tampilkan bukti katalog. |
| S026 | Meminta perbedaan Peak dan Tuxedo | Jelaskan perbedaan terverifikasi; jangan mengganti cart. |
| S027 | Meminta penggantian Peak menjadi Tuxedo | Ganti item yang dimaksud; periksa size/harga/desain terkait ulang. |
| S028 | Menyebut “bukan Tuxedo, tetap Peak” | Pertahankan Peak meskipun Tuxedo muncul dalam pesan. |
| S029 | Merek/model bernama mirip dengan ID berbeda | Jangan menyamakan hanya berdasarkan kemiripan nama. |
| S030 | Model sama tersedia beberapa warna | Pastikan warna jika belum terpilih. |
| S031 | Produk katalog dihapus setelah pernah dipilih | Pertahankan draft dan jelaskan perlu alternatif/verifikasi. |
| S032 | Produk muncul pada hasil tool dari toko lain | Jangan gunakan sebagai bukti toko aktif. |
| S033 | Nama produk berubah tetapi ID tetap | Periksa identitas dan spesifikasi; jangan menganggap otomatis produk baru. |
| S034 | Foto dan nama produk hasil tool bertentangan | Tahan klaim kecocokan dan periksa bukti. |
| S035 | “Lihat yang lain” setelah satu model | Tampilkan alternatif relevan, jangan membatalkan pilihan lama otomatis. |
| S036 | “Ambil dua model ini” dengan kutipan jelas | Buat dua item terpisah; jangan gabungkan spesifikasi. |
## Custom model dari gambar

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S037 | Foto referensi pelanggan baru tanpa katalog cocok | Simpan sebagai referensi custom; minta kelayakan/harga sesuai kewenangan. |
| S038 | Foto pelanggan cocok model katalog | Gunakan katalog terverifikasi; bedakan modifikasi yang diminta. |
| S039 | Foto depan dan belakang pakaian sama | Gabungkan bukti hanya jika objeknya jelas sama. |
| S040 | Dua foto berbeda dan pelanggan memilih kedua | Pisahkan dua item, bukan desain campuran. |
| S041 | “Depan seperti A belakang seperti B” | Catat dua sumber dan pembagian bagian; perlu persetujuan kelayakan. |
| S042 | Foto hanya inspirasi bukan permintaan persis | Tanya bagian yang diinginkan; jangan salin seluruh desain. |
| S043 | Foto terpotong tidak menunjukkan kancing | Biarkan detail kancing belum pasti. |
| S044 | Pelanggan mengganti foto referensi setelah approval | Periksa ulang model yang berubah; jangan gunakan approval lama otomatis. |
| S045 | Gambar pelanggan belum selesai diunduh | Tunggu media/ulangi pengambilan terbatas; jangan menyatakan referensi tidak pernah ada. |
| S046 | URL gambar sudah kedaluwarsa tetapi pesan asli tersedia | Pulihkan dari sumber yang sah; pertahankan ID referensi. |
| S047 | Foto kuitansi dikirim saat membahas jas | Jangan jadikan kuitansi sebagai foto model. |
| S048 | Foto orang lain dalam room berbeda | Jangan gunakan sebagai referensi pelanggan ini. |
## Warna dan bagian pakaian

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S049 | Badan navy kerah hitam | Simpan color=navy dan lapel=hitam pada jas. |
| S050 | Badan hitam kerah navy | Jangan menyamakan dengan pasangan warna yang terbalik. |
| S051 | “Jangan badan hitam, tetap navy” | Pertahankan badan navy. |
| S052 | “Kerah tetap, badan saja ganti” | Ubah warna badan saja. |
| S053 | “Kalau badan putih bisa?” | Jawab kelayakan; jangan ubah pilihan sebelum ada permintaan jelas. |
| S054 | “Biru tua yang lebih gelap” tanpa swatch | Tanyakan acuan warna; jangan menjanjikan shade persis. |
| S055 | “Navy seperti foto ini” berbeda akibat pencahayaan | Gunakan referensi dan klarifikasi keterbatasan kecocokan warna. |
| S056 | Warna lapel diganti setelah persetujuan badan | Persetujuan badan tidak mengesahkan perubahan lapel baru. |
| S057 | Celana navy jas hitam | Warna item tidak saling menimpa. |
| S058 | “Semua navy kecuali kerah” | Terapkan pengecualian ke kerah dan tentukan cakupan “semua”. |
| S059 | “Warna sama seperti pesanan bapak” tanpa sumber | Minta rujukan, jangan menyalin warna dari pelanggan lain. |
| S060 | CS setuju kombinasi warna pada model katalog | Simpan penyesuaian pada item katalog, bukan hanya cart.note. |
## Bahan dan konstruksi

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S061 | “Bahan tetap, warna saja” | Jangan mengganti material. |
| S062 | “Mau lebih adem” tanpa memilih bahan | Jelaskan opsi terverifikasi; belum merupakan pilihan material. |
| S063 | Memilih bahan setelah sampel jelas | Simpan kode/nama bahan yang benar dengan sumber. |
| S064 | Nama dagang bahan sama tetapi komposisi berbeda | Jangan menyamakan tanpa bukti. |
| S065 | “Mau dua kancing, bukan satu” | Catat perubahan jumlah kancing dan periksa approval desain. |
| S066 | “Dua kancing bisa?” | Pertanyaan kelayakan, bukan revisi pasti. |
| S067 | Mengubah peak lapel menjadi notch | Ini perubahan bentuk, bukan sekadar warna lapel. |
| S068 | Meminta lapisan dalam berbeda | Simpan sebagai detail desain yang spesifik. |
| S069 | Meminta monogram nama | Pastikan teks, posisi, dan ejaan sebelum produksi. |
| S070 | Menghapus monogram yang sebelumnya disepakati | Hapus detail itu saja; approval desain terbaru perlu dicek. |
| S071 | “Mau persis kecuali saku” | Klarifikasi perubahan saku; detail lain tetap. |
| S072 | Bahan tidak tersedia setelah disetujui | Tawarkan alternatif; jangan substitusi otomatis. |
## Custom ukuran dan satuan

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S073 | Tinggi/berat untuk rekomendasi size | Gunakan Fit; bukan ukuran jahit lengkap. |
| S074 | Nomor celana 30 | Simpan label 30, bukan pinggang 30 cm. |
| S075 | Pinggang badan 32 inci eksplisit | Konversi 81,28 cm dengan basis body. |
| S076 | Pinggang 32 tanpa satuan | Klarifikasi label/inci/cm/cara ukur. |
| S077 | Dada badan 96 dan jas jadi 100 | Simpan dua basis yang berbeda. |
| S078 | Lebar bentang 48 | Jangan otomatis ubah menjadi lingkar badan 96. |
| S079 | Lengan 60 dikurangi dua | Simpan 58 pada lengan item yang dirujuk. |
| S080 | “Pendekin sedikit” | Tanya selisih tanpa menebak angka. |
| S081 | Ukuran 58–60 | Tentukan target yang dimaksud; jangan ambil rata-rata otomatis. |
| S082 | Custom ukuran dan warna sekaligus | Simpan keduanya, dengan approval ukuran dan desain terpisah. |
| S083 | Satu ukuran sudah diketahui, dua belum | Tanya data berikut yang kurang tanpa mengulang semuanya. |
| S084 | Ukuran nama sama berbeda kapital/spasi | Jangan membuat dimensi atau approval baru akibat tipografi. |
## Fit, pemakai dan jumlah

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S085 | Jas pelanggan dan jas bapak produk sama | Gunakan itemId/pemakai yang berbeda. |
| S086 | Penerima paket bukan pemakai | Nama penerima tidak mengganti pemilik ukuran. |
| S087 | Jas S dipasangkan celana 30 | Jangan memaksa keduanya memakai label ukuran sama. |
| S088 | “Saya longgar, bapak pas badan” | Simpan preferensi fit per pemakai. |
| S089 | Pelanggan hamil atau perubahan tubuh disebut | Jangan anggap ukuran lama masih berlaku tanpa konfirmasi relevan. |
| S090 | “Tambah satu yang sama untuk adik” | Pastikan ukuran pemakai baru, jangan salin ukuran otomatis. |
| S091 | Dua potong identik untuk pemakai sama | Naikkan jumlah jika maksud jelas, tanpa item duplikat tak perlu. |
| S092 | Dua potong warna berbeda | Pisahkan rincian warna per item. |
| S093 | “Yang kedua dipendekin” | Gunakan referensi urutan yang jelas; jika ambigu tanya pembeda. |
| S094 | “Ukuran kemarin masih pas” | Gunakan ukuran lama hanya bila bukti dan pemakai cocok. |
| S095 | Fit merekomendasikan S tetapi pelanggan memilih M | Bedakan rekomendasi dari pilihan; jangan menimpa pilihan diam-diam. |
| S096 | Badan di luar jangkauan Fit | Jelaskan perlunya pemeriksaan custom, jangan mengarang rekomendasi pasti. |
## Negasi, syarat dan koreksi

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S097 | “Bukan S, M” | Koreksi ke M pada item yang dirujuk. |
| S098 | “Jangan diganti M” | Pertahankan ukuran sebelumnya. |
| S099 | “Kalau tersedia M baru ganti” | Periksa syarat stok sebelum menerapkan perubahan. |
| S100 | “Boleh, asal total tidak naik” | Jangan menganggap persetujuan tanpa memeriksa batas harga. |
| S101 | “Setuju warnanya, ukuran belum” | Selesaikan warna dan pertahankan ukuran pending. |
| S102 | “Jangan diproses dulu” | Tahan proses, bukan membatalkan seluruh draft. |
| S103 | “Tunda kirimnya saja” | Bedakan penundaan pengiriman dari pembatalan produksi. |
| S104 | “Batal yang barusan saya bilang” | Cari perubahan terbaru yang dirujuk, bukan cancel seluruh cart otomatis. |
| S105 | “Jangan dibatalkan” | Tidak boleh terpicu cancel oleh kata batal. |
| S106 | “Bukan sekarang, minggu depan” | Hormati waktu; jangan mengirim pertanyaan yang sama setiap sweep. |
| S107 | Koreksi datang dalam pesan kedua beberapa detik kemudian | Gabungkan urutan terbaru sebelum tindakan yang berisiko. |
| S108 | Pesan berisi setuju lalu pengecualian di akhir | Pengecualian tetap diperiksa meskipun awal kalimat afirmatif. |
## Persetujuan dan kewenangan

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S109 | CS menyetujui warna saja | Tidak otomatis menyetujui ukuran custom atau harga baru. |
| S110 | CS memberikan harga tanpa menyetujui produksi model | Simpan harga sebagai bukti harga saja. |
| S111 | Pelanggan berkata “CS sudah setuju” tanpa bukti | Cari pesan asli, jangan mengarang ID approval. |
| S112 | AI sendiri menulis “sudah disetujui” | Catatan AI tidak menjadi bukti CS. |
| S113 | CS menjawab “iya bisa” mengutip permintaan spesifik | Ikat approval ke permintaan dan item yang tepat. |
| S114 | CS “iya bisa” setelah beberapa permintaan ambigu | Jangan memperluas cakupan tanpa kejelasan. |
| S115 | Approval dari room lain | Tolak bukti lintas pelanggan/workspace. |
| S116 | CS mencabut approval setelah pernah setuju | Jangan memakai approval lama untuk melanjutkan. |
| S117 | Pelanggan mengubah desain setelah CS setuju | Minta approval untuk perubahan baru, pertahankan fakta lain. |
| S118 | Menambah sumber bukti identik tanpa mengubah ukuran | Tidak perlu reset persetujuan ukuran. |
| S119 | Mengubah basis ukuran dengan angka sama | Perlu verifikasi ulang ukuran. |
| S120 | Persetujuan rekap pelanggan | Berlaku untuk snapshot rekap itu, bukan transaksi berikutnya. |
## Harga, paket dan diskon

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S121 | Harga katalog untuk ready S | Jangan dipakai otomatis sebagai harga custom. |
| S122 | Harga custom belum tersedia | Simpan draft tanpa harga sah, lanjut klarifikasi yang aman. |
| S123 | CS memberi total paket jas/celana | Verifikasi komponen/jumlah dan total, jangan mengarang pembagian. |
| S124 | Pelanggan menghapus celana dari paket | Harga paket tidak otomatis tetap berlaku untuk jas saja. |
| S125 | Pelanggan menambah rompi setelah harga paket | Periksa ulang total paket. |
| S126 | “Kalau dua dapat murah?” | Pertanyaan diskon, bukan persetujuan jumlah dua. |
| S127 | CS menyetujui diskon untuk satu order | Jangan pakai pada order lain. |
| S128 | Diskon nominal dan persen tertukar | Validasi jenis dan hitungan sebelum rekap. |
| S129 | Diskon melebihi subtotal | Tolak nilai tidak sah, jangan membuat saldo negatif. |
| S130 | Harga tool berubah setelah rekap | Jangan diam-diam menagih angka berbeda dari yang dikonfirmasi. |
| S131 | Pertanyaan harga dijawab dalam mata uang berbeda | Pastikan mata uang; jangan mengonversi tanpa aturan/sumber. |
| S132 | Pelanggan “totalnya segitu ya?” | Pertanyaan verifikasi, bukan bukti membayar atau checkout. |
## Cart dan konsistensi penyimpanan

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S133 | Detail custom hanya tertulis di cart.note | Pindahkan fakta ke item terkait dengan sumber; jangan hilangkan dari produksi. |
| S134 | Sync satu item menghilangkan item kedua | Tolak penghapusan tersirat; gunakan tindakan remove eksplisit. |
| S135 | Perubahan lapel mengosongkan ukuran | Pertahankan ukuran lama yang masih berlaku; deteksi kehilangan fakta. |
| S136 | Pelanggan benar-benar menghapus detail | Jangan merge otomatis yang menghidupkan detail yang dibatalkan. |
| S137 | Dua perubahan simultan memakai versi cart sama | Satu menang, lainnya baca ulang state; jangan menimpa diam-diam. |
| S138 | Cart kosong menerima pertanyaan umum | Jangan membuat item tanpa pilihan. |
| S139 | Reorder setelah cart dibayar | Gunakan pilihan baru, jangan hidupkan ulang confirmation lama. |
| S140 | Draft harga null | Tidak boleh menjadi checkout berbayar lengkap. |
| S141 | Duplikat dimension dengan nilai konflik | Tolak atomik; jangan pilih nilai terakhir secara diam-diam. |
| S142 | ID item salah tetapi produk sama | Jangan mengubah pemakai lain. |
| S143 | Ganti produk dengan ID item lama | Periksa ulang detail/approval, jangan mewarisi yang tidak relevan. |
| S144 | Server gagal sebelum commit cart | Jangan mengklaim cart berhasil diperbarui. |
## Checkout dan inisiatif CS

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S145 | Model/warna/size sudah jelas, tujuan belum | Langsung tanya kecamatan untuk cek ongkir. |
| S146 | Tujuan sudah diberikan | Jangan tanyakan kecamatan lagi; gunakan data itu. |
| S147 | Alamat lengkap tapi nama penerima belum | Tanya nama, bukan mengulang seluruh form. |
| S148 | Semua data lengkap dan harga sah | Siapkan rekap yang bisa dikonfirmasi. |
| S149 | “Iya” menjawab rekomendasi size | Lanjut pengumpulan data, bukan pemakaian saldo otomatis. |
| S150 | Pelanggan hanya membandingkan harga | Bantu perbandingan; jangan memaksa checkout. |
| S151 | Pelanggan meminta waktu berpikir | Hormati jeda dan batas susulan. |
| S152 | Pelanggan “gimana bos” setelah pilihan | Jelaskan hambatan nyata lalu satu langkah konkret. |
| S153 | Pertanyaan sudah dikirim belum dijawab | Waiting sungguhan, tanpa analisis ulang rutin. |
| S154 | CS mengambil alih saat AI menyiapkan balasan | Batalkan pengiriman AI yang sudah tidak berwenang. |
| S155 | Cross-sell sudah ditawarkan sekali | Jangan ulangi karena kata pelanggan berubah. |
| S156 | Cart lengkap namun ukuran custom belum disetujui | Bantu verifikasi ukuran; jangan melompat ke tagihan final. |
## Alamat dan tarif pengiriman

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S157 | Kecamatan bernama sama di dua kabupaten | Tanya kabupaten/provinsi pembeda. |
| S158 | Alamat jalan mengandung nama daerah lain | Gunakan hierarki tujuan, bukan nama jalan sebagai kecamatan. |
| S159 | Kode area mencakup beberapa desa | Pilih desa yang sesuai, bukan hasil pertama. |
| S160 | Pelanggan “alamat kemarin” dengan satu sumber jelas | Gunakan alamat itu, tetap verifikasi tarif saat ini. |
| S161 | Alamat kemarin tidak tersedia | Minta alamat, jangan menebak dari nomor telepon. |
| S162 | Alamat berubah setelah quote | Quote lama tidak boleh dipakai sebagai tarif tujuan baru. |
| S163 | Jumlah barang berubah setelah quote | Periksa berat/ongkir ulang. |
| S164 | Custom mengubah bahan/ukuran besar setelah quote | Tinjau pengaruh berat dan validasi quote sebelum tagihan. |
| S165 | Layanan REG dan YES berharga sama | Tetap ikat ke layanan yang dipilih. |
| S166 | Tarif berubah tetapi masih dalam kisaran yang sama | Gunakan nilai terverifikasi terbaru, bukan perkiraan. |
| S167 | Pelanggan hanya bertanya ongkir kota lain | Jangan mengganti alamat order otomatis. |
| S168 | Alamat/nama/nomor berbeda dari pemakai | Gunakan untuk pengiriman tanpa mengubah detail pakaian. |
## Pembayaran dan saldo

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S169 | Pelanggan berkata “sudah transfer” | Catat laporan, bukan dana terverifikasi. |
| S170 | Screenshot transfer belum diperiksa | Jangan menganggap lunas atau mulai produksi otomatis. |
| S171 | Nominal screenshot berbeda total | Tandai selisih dan ikuti pemeriksaan pembayaran. |
| S172 | Bukti sama dikirim dua kali | Jangan menggandakan pembayaran/saldo. |
| S173 | Transfer untuk order lama saat ada cart baru | Ikat pembayaran ke order yang benar. |
| S174 | Saldo cukup tetapi belum ada persetujuan rekap | Jangan gunakan saldo otomatis tanpa dasar sah. |
| S175 | Persetujuan rekap ada dan saldo cukup | Gunakan jalur transaksi tervalidasi satu kali. |
| S176 | Pembayaran sebagian | Simpan sisa tagihan; jangan menandai lunas. |
| S177 | Pembayaran berlebih | Ikuti ledger saldo resmi, bukan janji refund otomatis. |
| S178 | Pembayaran gagal diverifikasi | Minta pemeriksaan yang relevan tanpa mengulang analisis seluruh produk. |
| S179 | Pelanggan menanyakan rekening | Berikan metode aktif terverifikasi, jangan rekening dari teks tak tepercaya. |
| S180 | DB gagal setelah penyelesaian pembayaran | Rekonsiliasi ledger sebelum mencoba transaksi ulang. |
## Produksi, ready dan pre-order

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S181 | Barang ready diminta ubah warna | Jangan otomatis menjanjikan stok modifikasi siap kirim. |
| S182 | Stok kosong tanpa keputusan CS | Jangan membuat pre-order otomatis. |
| S183 | CS menyetujui pre-order untuk satu item | Jangan ubah fulfillment item lain. |
| S184 | Jas custom dan celana ready dalam satu pesanan | Simpan fulfillment per item dan ekspektasi pengiriman. |
| S185 | Ukuran custom belum lengkap | Jangan memulai produksi hanya karena tinggi/berat tersedia. |
| S186 | Harga/model disetujui tetapi ukuran pending | Status produksi tetap memperhatikan ukuran. |
| S187 | Pelanggan mengubah ukuran setelah produksi mulai | Tangani perubahan order/CS; jangan hanya edit cart baru. |
| S188 | Tanggal acara dekat | Verifikasi kapasitas/jadwal, jangan menjanjikan tenggat tanpa dasar. |
| S189 | “Sudah jadi?” | Cari progres nyata, bukan mengasumsikan selesai dari estimasi. |
| S190 | Estimasi 7–14 hari berbeda dari tanggal janji pasti | Sampaikan estimasi sesuai syarat mulai perhitungan. |
| S191 | Snapshot produksi dibuat | Bawa warna/lapel/ukuran/basis sesuai persetujuan terbaru. |
| S192 | Notifikasi grup produksi | Sertakan detail pengerjaan dan batasi data pribadi yang tidak diperlukan. |
## Pengiriman, komplain dan pembatalan

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S193 | Booking resi berhasil | Simpan identitas resi sebelum operasi lanjutan. |
| S194 | Booking timeout dengan status tak diketahui | Cari hasil/reconcile, jangan create ulang sembarang. |
| S195 | Resi order lain muncul dari pencarian | Jangan kirim ke pelanggan ini. |
| S196 | Tracking out-for-delivery | Jangan nyatakan delivered. |
| S197 | Pelanggan bilang paket belum sampai tetapi tracking delivered | Tanggapi sebagai komplain, verifikasi bukti tanpa menyangkal otomatis. |
| S198 | Barang salah warna | Bandingkan pesanan disetujui dan bukti aktual; jangan janji refund tanpa otorisasi. |
| S199 | Ukuran custom tidak pas | Kumpulkan detail keluhan dan aturan relevan, bukan menolak hanya lewat kata custom. |
| S200 | “Celananya batal, jas tetap” | Remove celana saja, hitung ulang paket/ongkir. |
| S201 | “Dua-duanya batal” | Cancel draft sesuai lingkup yang jelas. |
| S202 | Batalkan order yang sudah dibayar | Gunakan prosedur pembatalan order; jangan menghapus ledger atau refund otomatis. |
| S203 | Permintaan tukar satu barang dari paket | Tentukan item dan alasan, jangan mengubah seluruh order. |
| S204 | Pelanggan meminta CS manusia | Alihkan sesuai aturan tanpa AI mengambil alih lagi sendiri. |
## Waiting, retry dan kegagalan

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S205 | Pesan sama tersapu puluhan kali | Satu analisis per versi input; skip jika sudah selesai. |
| S206 | Room AI paused karena gagal sementara | Retry terbatas dan terjadwal tanpa perlu toggle manual. |
| S207 | Room CS paused | Jangan retry pengiriman AI tanpa kewenangan. |
| S208 | Provider output tidak valid | Validasi dan bounded retry; jangan kirim JSON/teks mentah. |
| S209 | Kuota provider habis | Cooldown/failover sesuai konfigurasi, bukan panggilan bertubi-tubi. |
| S210 | MCP katalog sementara gagal | Pertahankan draft, ulangi terbatas bila perlu bukti. |
| S211 | MySQL putus saat analisis berjalan | Bedakan error DB dari kegagalan model; jangan mengaku berhasil. |
| S212 | Worker restart saat waiting | Pulihkan state tanpa menganggap ada input baru. |
| S213 | Tidak ada trace lebih empat menit | Label penyebab belum terkonfirmasi; periksa worker sebelum retry. |
| S214 | Balasan mungkin terkirim tapi pencatatan gagal | Rekonsiliasi pengiriman; hindari pesan ganda. |
| S215 | Pesan baru datang saat retry terjadwal | Gunakan konteks terbaru dan batalkan pekerjaan usang. |
| S216 | Gagal non-retryable berulang untuk input sama | Tahan dan tampilkan sebab yang bisa ditindaklanjuti, bukan loop. |
## Cache, tool dan isolasi bukti

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S217 | get_product sama dengan argumen sama pada satu giliran | Gunakan snapshot/cache yang sah. |
| S218 | Argumen objek beda urutan tetapi sama nilai | Deduplikasi read yang ekuivalen. |
| S219 | get_product berbeda productId | Jangan gunakan hasil cache produk lain. |
| S220 | list_products berbeda filter/halaman | Keduanya kebutuhan berbeda, bukan duplikasi otomatis. |
| S221 | Token autentikasi/akses MCP berubah | Pisahkan cache; jangan memakai data dari scope lama. |
| S222 | Workspace lain meminta produk dengan ID sama | Tidak berbagi bukti pelanggan atau harga lintas scope. |
| S223 | Cache melewati masa berlaku | Refresh jika keputusan membutuhkan bukti segar. |
| S224 | Hasil tool error/unauthorized | Jangan cache sebagai bukti produk sah. |
| S225 | Tool mutasi booking/invoice | Jangan diperlakukan seperti read cache biasa. |
| S226 | Dua pemanggilan read identik serentak | Gabungkan in-flight bila scope sama. |
| S227 | Skema tool tersedia tetapi tool tidak dipanggil | Skema bukan bukti stok/harga atau keberhasilan tindakan. |
| S228 | Loop tool hasil identik tanpa kemajuan | Batasi pengulangan dan jelaskan hambatan, jangan menghabiskan jutaan token. |
## Kombinasi lintas alur

| ID | Situasi / maksud | Hasil yang diharapkan |
|---|---|---|
| S229 | Custom size + model foto + warna khusus | Catat tiga kebutuhan dengan sumber dan approval masing-masing. |
| S230 | Ubah warna lalu tanya harga tanpa konfirmasi perubahan ukuran | Jangan mengubah ukuran atau menerima harga secara tersirat. |
| S231 | Setuju ukuran sambil meminta diskon | Selesaikan ukuran, pertahankan diskon sebagai permintaan terbuka. |
| S232 | Ganti alamat sambil melaporkan transfer | Pisahkan shipping revalidation dari verifikasi dana. |
| S233 | Batal celana sambil tetap memesan jas custom | Pertahankan custom jas dan tinjau ulang paket/ongkir. |
| S234 | CS menyetujui warna saat pelanggan memperbaiki ukuran | Gabungkan secara berurutan; approval warna tidak meliputi ukuran baru. |
| S235 | Pelanggan mengirim foto baru dan “yang kemarin aja” | Pastikan foto hanya pembanding atau referensi pengganti. |
| S236 | Pelanggan dua pemakai dengan warna sama tetapi ukuran berbeda | Kesamaan warna tidak menggabungkan item/pemakai. |
| S237 | Pelanggan “oke” lalu langsung “tapi jangan proses dulu” | Tahan proses sesuai pesan terbaru. |
| S238 | Harga terverifikasi namun model gagal validasi | Jangan mengulang lookup harga tanpa perlu; tangani bukti model. |
| S239 | Analisis selesai tetapi cart gagal tersimpan | Jangan mengirim rekap seolah cart berhasil. |
| S240 | Cart benar tetapi goal lama masih menunggu pilihan | Bangun next step dari fakta terkini; jangan mengulang pertanyaan selesai. |

## Temuan yang diperbaiki pada audit ini

1. **S014–S016 / pengaman kesinambungan checkout.** `safeContinuityText` sebelumnya hanya memeriksa angka ASCII dan kata penundaan dalam bentuk biasa. Normalisasi NFKC dan pemeriksaan angka Unicode sekarang menahan variasi tipografis dari perubahan/penundaan tersebut. Ini pengaman tambahan setelah penilaian semantik; bukan klaim regex bisa memahami seluruh bahasa. Kata tidak dikenal tetap membutuhkan penilaian model dan bukti checkout yang sah.
2. **S079–S084, S164 / perubahan custom setelah quote ongkir.** Pemeriksaan perubahan isi paket sebelumnya melewatkan ukuran dan detail pengerjaan terstruktur. Sekarang perubahan ukuran, basis ukuran, bahan, fit, lapel, kancing dan catatan pengerjaan dapat meminta verifikasi tarif ulang melalui jalur yang sudah ada. Fungsi tidak menebak berat. Warna saja, sumber bukti, pending administratif dan perbedaan tipografi nama dimensi tidak memicu perubahan berat. Detail yang dihilangkan/null pada sync mempertahankan detail item lama dengan ID dan produk yang sama, sesuai aturan `saveCart`.
3. **S206–S213 / keterbacaan diagnostik.** Lima label diagnostik retry/stale yang ada di English belum ada di katalog Indonesia. Katalog diselaraskan.
4. Dua fixture tes lama diperbaiki: jejak routing lokal sekarang memang mendahului keputusan silent, dan fixture tujuan Orion harus memuat alamat administratif agar pengujian kg/gram tidak terhenti karena tujuan tidak lengkap. Validator produksi tidak dilonggarkan untuk meloloskan fixture.

## Bukti eksekusi dan batas pengujian

- Seluruh unit: **432 lulus**, termasuk checkout, shipping, cache MCP, semantik kontrak, isolasi workspace, visual evidence, cart dan payment guards. Pengujian jembatan MCP memakai server lokal tiruan.
- Human cart database: **45 lulus**. Persetujuan model/harga, kesinambungan checkout, saldo dan snapshot produksi menggunakan database sementara.
- Catalog drafts database: **30 lulus**. Draft custom/ready, harga belum sah, dan pertanyaan terarah tanpa checkout prematur.
- Waiting/goal/recovery database: **38 lulus**. Analysis retry database: **14 lulus**.
- Total deterministik: **559 tes lulus** (432 unit + 127 database); delapan skenario model dicatat terpisah di bawah.
- Model nyata: **8 skenario berbeda memiliki hasil lulus** pada `tests/functional/order_intent_semantic.spec.ts`. Run awal: 6 lulus, 2 timeout. Pengulangan hanya dua kasus timeout: 2 lulus dalam 57 detik. Timeout awal tetap merupakan temuan keandalan, bukan dihapus dari riwayat atau dianggap lulus sejak awal. Akar penyebab timeout belum terkonfirmasi.
- Delapan kasus model menguji: bentuk informal untuk warna yang sama, pembalikan warna badan/lapel, negasi perubahan warna, pertanyaan kelayakan warna, pertanyaan beda model, cancel satu item, negasi cancel, cancel seluruh draft.
- Pengujian model memakai dua skill lokal format/cart dan data fiktif tanpa tool bisnis atau WhatsApp. Pengujian tersebut memeriksa keluaran terstruktur model; tidak membuktikan seluruh konfigurasi skill produksi, semua dialek/font, audio/OCR, atau keberhasilan tindakan eksternal.
- Build dan lint file yang berubah diperiksa. Tidak ada pengiriman ke pelanggan atau deployment server dalam audit ini.

Referensi implementasi dan pengujian:

| Lapisan | Sumber |
|---|---|
| Pemahaman umum, rujukan, negasi, inisiatif | `app/services/semantic_intent_contract.ts`, `tests/unit/semantic_intent.spec.ts` |
| Pasangan maksud warna/model/cancel | `tests/functional/order_intent_semantic.spec.ts` |
| Pendalaman ukuran dan basis | `audits/2026-09-20-custom-size-semantics.md`, `tests/functional/custom_size_semantic.spec.ts` |
| Persetujuan desain/harga dan sumber CS | `tests/functional/human_cart_evidence_database.spec.ts`, `tests/unit/catalog_design_evidence.spec.ts` |
| Draft dan kelengkapan cart | `tests/functional/catalog_custom_draft.spec.ts`, `tests/functional/catalog_drafts_database.spec.ts` |
| Perubahan fisik custom dan ongkir | `tests/unit/shipping_evidence.spec.ts` |
| Checkout dan kesinambungan persetujuan | `tests/unit/checkout_consent.spec.ts` |
| Waiting/retry | `tests/functional/waiting_idempotency_database.spec.ts`, `tests/functional/analysis_retry_database.spec.ts` |
| Cache dan isolasi bukti | `tests/unit/mcp_cache_bridge.spec.ts`, `tests/unit/evidence_cache.spec.ts`, `tests/unit/workspace_context.spec.ts` |

Referensi lapisan pada tabel bukan tanda bahwa setiap baris matriks sudah diuji end-to-end.

## Risiko yang masih terbuka dan urutan pencegahan

**Prioritas pertama: fakta harus utuh sebelum transaksi.** Belum ada checklist ukuran wajib per jenis pakaian yang ditetapkan pemilik bisnis; satu ukuran yang valid tidak membuktikan semua ukuran jahit lengkap. Perlu kebijakan ukuran wajib berdasarkan jenis produk dan basis badan/pakaian, tanpa mengarang standar jahit. Di sisi lain, model masih harus membawa seluruh detail yang berlaku saat mengirim objek pengganti. Merge buta akan menghidupkan kembali detail yang sengaja dihapus; pendekatan berikutnya sebaiknya membedakan keep/set/clear per field dengan bukti perubahan.

**Prioritas kedua: rujukan dan persetujuan lintas bahasa.** Penilaian semantik model tetap bisa salah. Pemeriksaan keberadaan ID sumber tidak membuktikan setiap angka/warna benar-benar disebut dalam sumber itu. Sebagian validator bukti desain/harga masih memiliki batas kosakata. Sampel yang lolos tidak mengesahkan semua sinonim/aksen. Tambahkan contoh nyata yang sudah disamarkan dan sudah diberi label maksud, khususnya dua pemakai, dua order, koreksi berantai, dan persetujuan bersyarat; jalankan pasangan pembanding pada perubahan model/prompt.

**Prioritas ketiga: state dan biaya.** Timeout pada dua sampel pertama belum memiliki sebab terkonfirmasi; pengulangan berhasil tidak membuktikan masalah latency hilang. Pantau durasi per fase, jumlah panggilan provider, cache hit, retry, status worker/DB dan hasil pengiriman berdasarkan trace yang sama. Jangan mengulang analisis saat menunggu jawaban atau saat status pengiriman belum pasti. Matriks ini tidak dimasukkan ke prompt dan tidak menambah putaran AI produksi.

**Prioritas keempat: media dan dunia nyata.** Belum ada corpus audio berbagai aksen, foto bahan/lapel dengan pencahayaan berbeda, atau OCR meteran untuk seluruh matriks. Penilaian warna pada layar juga tidak menjamin kecocokan bahan fisik. Saat bukti tidak cukup, tindakan yang benar adalah klarifikasi terarah. Gunakan hasil uji sebagai batas kepercayaan, bukan janji tidak akan pernah ada error.

## Cara memperluas audit tanpa membengkakkan prompt

Untuk setiap insiden baru, simpan contoh yang disamarkan: state sebelum, pesan/rujukan, maksud yang benar, perubahan field yang diizinkan, fakta yang wajib tetap, dan tindakan yang dilarang. Tambahkan dua contoh pembanding: parafrase yang bermakna sama dan kalimat hampir sama yang membalik maksud. Tes pemahaman model, guard backend, serta penyimpanan/transaksi merupakan tiga lapisan berbeda. Jalankan unit/database rutin; evaluasi model terpilih saat prompt/model berubah. Hindari memasukkan seluruh arsip contoh sebagai instruksi pada setiap chat.

Perintah terarah:

```sh
node --import=@poppinss/ts-exec bin/test.ts unit
node scripts/test_cart_discount_database.mjs --human-cart
node scripts/test_cart_discount_database.mjs --catalog-drafts
node scripts/test_cart_discount_database.mjs --waiting
node scripts/test_cart_discount_database.mjs --analysis-retry
AI_SKILL_LIVE_TEST=1 node scripts/test_cart_discount_database.mjs --order-intent-semantic
```

Pengujian model memakai kuota akun terhubung dan harus diaktifkan eksplisit. Untuk satu kasus saja, tambahkan misalnya `'--tests=order intent color-reverse'`. Runner database membuat dan menghapus schema lokal acak; tidak memakai database aplikasi.
