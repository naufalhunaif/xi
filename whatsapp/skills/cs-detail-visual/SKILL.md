---
name: cs-detail-visual
description: Analisis detail visual pakaian pelanggan dan bandingkan dengan foto kandidat katalog/MCP, terutama lapel, kancing, konstruksi depan, saku, potongan, warna, dan motif. Berlaku pada foto serta frame video/GIF/stiker yang benar-benar dilampirkan untuk identifikasi produk atau perbandingan model, bukan percakapan tanpa kebutuhan visual.
---

# Analisis detail dan pencocokan pakaian

Pelengkap skill bisnis/media. Gunakan gambar yang benar-benar dilampirkan dan data MCP aktual. Jangan berhenti pada kemiripan warna atau kategori “jas”. Gaya balasan, harga, stok, pembayaran, dan batas wewenang tetap mengikuti skill bisnis.

## Amati ciri pembeda

Untuk setiap pakaian yang dirujuk pelanggan, periksa bagian yang tampak:

- **Lapel/kerah:** bentuk notch, peak, shawl atau bentuk lain jika terbaca; ujung/takik, proporsi lebar, posisi lekukan, garis gulung, lapisan atau kontras terhadap badan jas. Jangan mengubah kilap menjadi kepastian bahan satin, atau menaksir lebar sentimeter dari foto.
- **Kancing depan:** jumlah yang benar-benar terlihat, susunan satu/dua kolom, posisi, warna/kontras, dan bentuk. Bedakan kancing dari lubang kancing, aksesori lapel, kancing rompi/kemeja, atau pantulan. Bedakan jumlah kancing terlihat dari total kancing jas bila bagian tertutup/terpotong; jangan menebak sisanya.
- **Konstruksi depan:** single-breasted/double-breasted jika bukti cukup, tumpang tindih, garis bukaan, panjang dan bentuk ujung depan. Jas sedang terbuka bukan bukti tidak memiliki kancing.
- **Lengan:** kancing manset yang terlihat, jumlah/susunan, ujung lengan dan detail kontras. Jangan menganggap kancing manset fungsional hanya dari penampilannya.
- **Saku:** posisi dan jenis yang terlihat (flap, welt/jetted, patch), saku dada, saku tambahan dan arah bukaan. Bedakan pocket square dari bentuk saku.
- **Badan/belakang:** bentuk bahu, siluet dan panjang relatif, garis jahitan atau panel, belahan belakang jika sudut belakang tersedia. Foto depan saja tidak menentukan jumlah belahan belakang.
- **Warna/motif/tekstur:** warna tampak dan kemungkinan pengaruh cahaya, polos/garis/kotak atau motif lain, kontras lapel/kancing. Komposisi kain, merek, ukuran badan, dan kualitas tidak dipastikan dari piksel.
- **Komponen lain:** rompi atau celana yang terlihat, termasuk kancing, pleat/lipatan, saku dan ujung celana. Jangan menganggap seluruh komponen dijual satu paket tanpa data produk.

Bagian tidak tampak, tertutup tangan, kabur atau terlalu kecil dicatat sebagai **tidak terlihat / belum bisa dipastikan**, bukan diisi dengan ciri model jas pada umumnya. Pisahkan pengamatan pelanggan, pengamatan katalog, dan deskripsi tekstual dari MCP agar tidak saling dianggap bukti foto.

## Bandingkan kandidat, bukan hanya cari nama

1. Baca caption, pesan kutipan, dan konteks untuk memastikan objek yang dimaksud. Temukan kandidat lewat tool katalog yang benar-benar tersedia; gunakan detail produk dan foto/varian kandidat, bukan judul saja. Jangan menganggap URL gambar atau hasil pencarian teks sama dengan sudah melihat gambar.
2. Cocokkan atribut pelanggan dengan kandidat satu per satu: lapel, susunan/jumlah kancing depan, saku, konstruksi, potongan, kemudian warna/motif dan detail lain yang tampak. Ciri yang tertutup bukan kecocokan positif. Jangan memaksakan kandidat pertama.
3. Perbedaan tegas seperti bentuk lapel, satu/dua baris kancing atau jenis saku harus disebut sebagai perbedaan model. Warna yang sama tidak meniadakan perbedaan tersebut. Jangan menyatakan “sama persis” bila ciri penting bertentangan atau tidak terlihat.
4. Simpulkan kecocokan berbasis ciri, kandidat mirip tetapi berbeda, atau belum cukup bukti. Jika satu detail menentukan dan tidak terbaca di foto yang tersedia, minta foto dekat bagian itu saja. Jangan meminta pelanggan mencari nama/kode produk sebelum memeriksa kandidat yang tersedia.

Untuk video/GIF/stiker, bandingkan bagian pakaian pada frame yang dilampirkan. Frame dapat memperlihatkan sudut berbeda; jangan menghitung kancing yang sama beberapa kali. Tidak ada frame gambar berarti tidak ada bukti visual untuk dianalisis. Jika yang tersedia hanya thumbnail, jangan mengklaim sudah memeriksa seluruh video. Ketentuan lama “video tidak bisa dilihat” tidak berlaku pada frame gambar yang benar-benar disediakan runtime; audio dan bagian di luar frame tetap tidak diketahui.

## Simpan bukti; jangan membanjiri pelanggan

- Di `reason`, ringkas ciri penentu yang diamati, kandidat MCP yang dibandingkan, perbedaan penting, serta ketidakpastian. Ini ringkasan bukti yang dapat dikoreksi, bukan transkrip penalaran internal. Di `note`, simpan ciri relevan untuk giliran berikutnya dan bedakan yang belum terkonfirmasi.
- Jawab kebutuhan pelanggan pada `message`: identitas/harga terverifikasi atau perbedaan penting sesuai pertanyaan. Tidak perlu mengirim seluruh daftar pemeriksaan bila hanya ditanya harga. Jika pelanggan meminta perbandingan detail, gunakan baris terpisah yang mudah dibaca sesuai skill format.
- Pemeriksaan rinci tidak mengizinkan menebak detail yang hilang, harga, stok, ukuran yang cocok, maupun janji custom. Verifikasi data tersebut memakai sumber dan aturan bisnis yang berlaku.

## Mengirim gambar langsung

- Ketika perlu mengirim foto produk/referensi sesuai permintaan pelanggan atau skill bisnis, isi `images` dengan `url` sumber gambar persis dari produk MCP terverifikasi atau media/cart room ini, serta `caption` singkat bila diperlukan. Aplikasi mengunduhnya dan mengirim sebagai foto WhatsApp, bukan teks tautan. Gunakan `get_product` untuk memastikan sumber foto produk yang akan dikirim.
- Jangan menaruh URL gambar atau Markdown gambar pada `message`/`initiative`, meminta pelanggan membuka URL untuk melihat foto, atau mengklaim foto terkirim sebelum proses berhasil. Tautan halaman produk biasa tetap boleh jika pelanggan memang membutuhkan tautannya. Jangan menebak URL, memakai gambar dari room lain, atau menambah foto yang tidak relevan.
- Bila foto saja sudah menjawab kebutuhan, `message` boleh kosong dan keterangan masuk ke caption. Jangan menggandakan caption dengan balasan utama. Jika tidak perlu foto, isi `images: []`; handoff/silent tidak mengirim foto.

## Permintaan foto ready dan pilihan warna

- Permintaan seperti “mau lihat foto beskap yang ready” adalah permintaan foto, bukan pesanan atau permintaan tautan. Cari kategori/produk yang dimaksud melalui MCP, lalu baca detail produk (`get_product`) untuk memverifikasi warna, stok varian dan sumber foto. Gunakan kategori yang disebut serta konteks percakapan; jangan meminta nama/kode produk atau ukuran hanya untuk mulai memperlihatkan foto.
- Jika warna belum dipilih dan ada beberapa warna yang ready dengan foto produk terverifikasi, sebutkan pilihan warnanya dahulu, lalu tanyakan warna yang ingin dilihat. Buat pernyataan pilihan sebelum kalimat tanya, bukan daftar opsi yang hanya disisipkan dalam pertanyaan. Jangan hanya bertanya “mau warna apa?” tanpa memberi pilihan dan jangan langsung mengirim seluruh warna. Tulis secara alami sesuai skill bahasa; daftar warna pendek boleh satu kalimat, daftar panjang gunakan baris terpisah.
- Ketika pelanggan bertanya “ada warna apa saja?”, jawab dengan pilihan warna yang telah diperiksa tersebut sebelum menanyakan pilihannya. Foto tersedia adalah kriteria internal pemilihan, bukan penjelasan kepada pelanggan: jangan menyebut “yang ada gambarnya”, “yang fotonya tersedia”, “di data MCP”, atau keterbatasan internal serupa. Jangan mengarang warna, menganggap thumbnail satu warna mewakili warna lain, atau menyebut warna tanpa foto sebagai habis stok. Bila pencarian belum lengkap, lanjutkan pemeriksaan yang relevan sebelum mengaku daftar itu lengkap; stok pada satu ukuran tidak berarti semua ukuran ready.
- Jika hanya satu pilihan warna yang memenuhi permintaan, atau pelanggan sudah menyebut/memilih warna di pesan sekarang maupun riwayat, langsung isi `images` dengan foto produk/warna tersebut dan caption singkat bila perlu. Jangan meminta konfirmasi warna lagi, hanya menjawab “ada”, berjanji akan mengirim tanpa melampirkan, atau memberi URL sebagai pengganti foto. Jika pilihan ternyata tidak ready, ikuti panduan bisnis untuk menjelaskan kondisi terverifikasi dan alternatifnya tanpa mengarang stok.
- Saat menunggu pilihan warna, simpan konteks bahwa pelanggan meminta foto produk ready dan warna belum dipilih; gunakan status goal menunggu jawaban sesuai panduan. Balasan singkat berikutnya seperti “hitam” menyelesaikan pilihan itu: kirim foto hitam yang sesuai tanpa menanyakan apakah pelanggan ingin melihat fotonya. Pada giliran pengiriman, verifikasi produk/warna terpilih lewat `get_product` agar sumber foto dan stok terbaru masuk bukti MCP giliran itu, bukan hanya mengandalkan catatan lama. Memilih warna untuk melihat foto bukan konfirmasi membeli; jangan otomatis membuat cart, meminta qty/alamat, atau melompat ke pembayaran. Aturan inisiatif, jadwal susulan dan wewenang tetap mengikuti panduan yang sudah ada.
