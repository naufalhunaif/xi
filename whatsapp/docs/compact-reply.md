# Konteks progresif untuk balasan WhatsApp

Mode beta `compact-reply-v5` menargetkan konteks awal sekitar 5–9 ribu token untuk percakapan normal. Akurasi lebih penting daripada batas itu: riwayat panjang, kontrak transaksi, foto, sumber kebijakan baru, dan konflik bukti boleh membutuhkan lebih banyak. Tidak ada pemotongan fakta pelanggan agar angka terlihat kecil.

## Lapisan keputusan

| Lapisan | Isi dan tugas | Kapan dibaca model |
|---|---|---|
| State aplikasi | Room, pesan/quote, cart/order/ledger, approval, goal dan memori bersumber | Keadaan percakapan yang sudah disusun runtime tetap diberikan; aturan teknis dipisahkan |
| Kebijakan inti terkompilasi | Maksud, konteks, wewenang, gaya, inisiatif, lifecycle dan batas bisnis | Awal setiap analisis yang memenuhi profil |
| Modul kebutuhan | Transaksi, pengiriman, visual | Petunjuk konteks memilih paket awal; model dapat membaca modul lain dalam fase yang sama |
| Kontrak tindakan | Dokumentasi field cart, approval, checkout, pertanyaan ukuran, media | Wajib dibaca sebelum field tindakan diisi; struktur JSON tetap lengkap sejak awal |
| Data bisnis | Skema tool terpilih dan bukti MCP | Discovery sesuai kebutuhan, lalu baca beberapa data independen sekaligus |
| Sumber rinci | Skill asli, riwayat dan memori asli | Bila aturan, rujukan atau bukti kurang/bertentangan |
| Validasi aplikasi | Scope room, sumber persetujuan, fingerprint cart, harga, ukuran, ongkir, dana | Sebelum tindakan dan pengiriman; pemahaman model tidak menggantikan validator |

Pemetaan kata hanya memilih teks awal, bukan menentukan maksud atau memberikan izin transaksi. Model tetap membaca pesan asli, pertanyaan terakhir, kutipan dan koreksi. Persetujuan size, model, harga, rekap dan dana merupakan hal berbeda.

## Cara menghemat

1. Sembilan skill versi yang sudah ditinjau memiliki kompilasi operasional. Statistik arsip, contoh lama dan pengulangan tidak ikut seluruhnya di setiap request. Skill asli dapat dibaca per rentang baris; pencarian hanya indeks, bukan pengganti membaca aturan.
2. Manifest mengikat nama dan SHA-256 isi sumber, termasuk metadata bila ada. Isi tanpa frontmatter hanya diterima jika cocok dengan hash body versi yang ditinjau. Satu perubahan, tambahan, kekurangan atau duplikasi sumber membatalkan profil. Aturan baru tidak diam-diam diabaikan.
3. Skema keluaran tetap memiliki seluruh property, required, enum, tipe dan batas. Dokumentasi panjang dipindah ke `read_reply_contract`; dokumentasi dikirim sekali per field/fase. Tindakan yang kontraknya belum dibaca ditahan, lalu mendapat satu kesempatan dengan kontrak yang diperlukan.
4. Enam koneksi bisnis tidak lagi memasok seluruh skema ke prompt awal. Model melihat gateway baca dengan dua tool. `find_business_tools` mengembalikan skema aktual yang dipilih; indeks sumber/nama tool menghindari pencarian nama yang sudah diketahui, dan `requests` dapat mengambil skema beberapa sumber sekaligus; `read_business_data` menerima maksimal enam pembacaan independen. Tool tulis ditolak.
5. Gateway memakai bridge cache yang sudah ada, dengan scope workspace, sumber, kredensial, versi/skema dan argumen. Validator menerima receipt asli seperti `business_orion/check_shipping_rates`, bukan nama wrapper. Discovery dan pembacaan skill bukan bukti harga/stok/ongkir.
6. Pembacaan identik bersamaan digabung. Pemanggilan identik yang sudah ditampilkan dalam fase yang sama mengembalikan rujukan hasil; `repeat=true` dapat membaca ulang. Fase baru tetap menerima hasil lengkap karena tidak memiliki transcript fase sebelumnya.

Persetujuan/fakta/balasan pelanggan tidak di-cache lintas room. Penggantian nama atau nomor penerima saja dapat mempertahankan ongkir state yang sama; perubahan tujuan, paket atau tarif tetap membutuhkan bukti yang sesuai.

## Angka yang harus dibedakan

- **Prompt awal**: teks konteks, kebijakan dan skema keluaran sekali masuk. Estimasi lokal memakai karakter/3,7; bukan tokenizer/billing provider.
- **Skema dan hasil tool**: teks tambahan ketika discovery/baca diperlukan. Foto dan overhead provider juga berada di luar estimasi awal.
- **Total satu jawaban**: akumulasi input/output pada seluruh langkah model. Konteks 8k dengan beberapa putaran tool bisa menghasilkan total jauh di atas 9k.
- **Cached input provider**: masih termasuk input yang diproses/dilaporkan. Cache MCP menghemat pemanggilan sumber; tidak otomatis menghilangkan biaya model untuk membacanya.

Pada pengukuran versi awal, uji offline memakai ekspor skill lokal dan provider tiruan menghasilkan estimasi prompt awal 52.856 token pada jalur lama, 6.742 pada contoh ringan (turun 87,2%), dan 7.955 pada contoh dengan routing cart. Ini fixture dengan konteks kecil, bukan pengukuran produksi atau bukti akurasi model. Riwayat/cart nyata yang lebih besar menambah ukuran. Uji tidak menghabiskan kuota AI dan tidak mengirim WhatsApp.

## Aktivasi dan pemeriksaan

Mode ini **opt-in**, bawaan nonaktif. Setelah menarik branch beta dan membangun rilis, tambahkan pada `.env` bersama yang dibaca WEB/WORKER:

```dotenv
AI_COMPACT_REPLY_ENABLED=true
```

Restart WEB dan WORKER memakai proses deployment yang biasa. Jangan hanya mengubah `.env` pada direktori rilis yang akan dihapus saat deploy berikutnya. Tidak perlu mengganti model atau menurunkan kemampuan penalaran.

Di `Pemetaan kebutuhan dan skill`, periksa:

- `runtime.policyVersion = beta-adaptive-models-v1` (atau `beta-compact-optin-v3` jika routing model dimatikan)
- `compactPolicy.enabled = true`, `compactPolicy.eligible = true`
- `delivery = compiled-progressive`

Jika `opt_in_disabled`, worker belum membaca flag. Jika `source_version_not_reviewed`, lihat `unreviewed` dan `missing`: isi sumber belum cocok dengan manifest. Tinjau versi skill tersebut dan kompilasinya sebelum memperbarui manifest; jangan menambahkan hash hanya agar lolos. Jalur asli tetap menangani percakapan.

Di `Prompt size`, profil menampilkan `targetInputTokens: 9000`, `budgetMode: accuracy-first`, dan `overTarget`. Skema upstream yang baru dibaca aplikasi berstatus `modelVisible: false`; skema yang diminta model tercatat dalam hasil discovery. Token aktual tetap dibaca pada fase provider. Jika AI menyatakan aturan belum cukup, sumber asli dapat dimuat sebagai pengecualian; aktivitas memperlihatkan perluasannya.

Untuk kembali ke jalur lama, hapus flag atau set `false`, lalu restart worker. Mode ini mengubah analisis balasan, bukan profil evaluasi percakapan offline. Pengukuran kualitas dan biaya aktual setelah aktivasi masih diperlukan; tidak ada jaminan semua jawaban setara atau total selalu di bawah 9k.

## Pengujian

Uji unit mencakup perubahan hash, field JSON bernama description, kontrak wajib, pembacaan sumber asli, isolasi fase, penolakan tool tulis, batch tidak valid, penggabungan panggilan, dan receipt ongkir melalui gateway HTTP. Regresi mencakup jalur skill lama, konteks/room, kelanjutan cart dan validasi ongkir.

Uji pipeline memakai database lokal disposable dan CLI fixture, bukan provider berbayar:

```sh
COMPACT_SKILL_FIXTURE_DIR=/path/to/exported/skills node scripts/test_cart_discount_database.mjs --compact-reply
```

Folder ekspor diperlukan untuk menguji kecocokan manifest asli tanpa memasukkan arsip/skill privat ke fixture repository. Test BASIC/CART/CONTRACT memeriksa konteks sumber tetap utuh; CATALOG_PHOTO/PHOTO_DOCS memastikan foto katalog tidak memicu analisis kedua atau membaca aturan cart; LATE_CONTRACT memeriksa perluasan terbatas; EDITED dan DISABLED membuktikan fallback/opt-in. Pengujian deterministik ini tidak mengukur pemahaman bahasa model secara langsung.

## Perbaikan pengulangan pada v2

- Petunjuk level/index kembali ikut prompt compact: state → data domain → riwayat/memori → aturan tambahan terarah. Level adalah panduan kebutuhan, bukan batas keras token atau izin transaksi.
- Mengirim foto katalog melalui `images` tidak sama dengan menganalisis piksel. Pengiriman tetap melewati pemeriksaan sumber gambar yang ada; hanya analisis/perbandingan visual memerlukan modul Visual.
- Membaca kontrak field `images` tidak memuat aturan cart. Kontrak tindakan tetap wajib sebelum cart/approval diisi. Jika ada kekurangan, perluasan memuat field/modul yang kurang, bukan semua modul.
- Lampiran gambar menambah skema visual tanpa mengembalikan dokumentasi panjang semua field lain. Estimasi prompt menghitung skema yang benar-benar dipakai.
- Representasi JSON identik pada `content` dan `structuredContent` dikirim satu kali ke model; teks tambahan, gambar dan bukti asli validator dipertahankan.
- Percobaan tambahan memakai key `compact-expand:*`; pembacaan aplikasi memakai `*:upstream:*`. Keduanya tidak menimpa fase pertama atau menghitung isi gateway dua kali. Penggunaan provider yang sebenarnya tidak dikurangi/diedit.
- Diagnostik memisahkan alasan perluasan `visual_analysis_rules_missing` dan `action_contract_missing`, tanpa prompt atau data pelanggan.

Jumlah token satu jawaban masih dapat tinggi jika model membutuhkan banyak putaran tool. Target konteks awal bukan jaminan total satu jawaban, dan jumlah level yang terlihat bukan jumlah request provider. Bandingkan prompt, jumlah percobaan, panggilan tool, dan usage tiap fase setelah deploy.

## Inisiatif pada v3

Core selalu memuat urutan langkah CS dan pengecualiannya. Versi sebelumnya merangkum penawaran celana menjadi batas sekali menawarkan, tanpa urutan tindakan yang cukup jelas, dan memakai larangan terlalu luas untuk pelanggan yang "hanya ingin informasi". V3 membedakan pertanyaan produk dari permintaan eksplisit untuk tidak ditawari. Permintaan set yang datang dari pelanggan tetap ditangani meskipun jatah penawaran tambahan sudah digunakan.

Skenario tinjauan kebijakan (bukan hasil evaluasi model langsung):

| Keadaan | Perilaku yang diharapkan |
|---|---|
| Foto/harga dijawab, size belum diketahui dan belum ditanyakan | Tanyakan size sebagai satu langkah berikutnya |
| Model/size jelas, jas saja atau set belum jelas, belum pernah ditawari | Tawarkan celana sekali tanpa mengklaim stok pasangan |
| Pertanyaan size sudah terkirim dan belum dijawab | Jangan mengulangi atau menambahkan pertanyaan yang bergantung padanya |
| Pelanggan meminta set setelah penawaran sebelumnya | Periksa komponennya; ini memenuhi permintaan, bukan penawaran kedua |
| Kedua komponen/harga/qty terverifikasi, paket khusus tidak ada | Hitung jumlah harga komponen tanpa diskon buatan |
| Pelanggan menetapkan warna pasangan yang belum ditemukan | Pertahankan warna; periksa aturan custom/data yang relevan, kelayakan/harga belum dianggap sah |
| Kelayakan/harga khusus membutuhkan manusia | Gunakan jalur handoff/approval yang berlaku; jangan menjanjikan hasil |
| Pelanggan meminta foto saja tanpa penawaran, menunda, atau menolak | Hormati batas; jangan memaksa pertanyaan penjualan |
| Data pesanan lengkap | Siapkan rekap untuk diperiksa; belum mengizinkan transaksi otomatis |

Perubahan ini memperjelas prompt, bukan menambahkan balasan paksa atau putaran analisis kedua. Pengujian integrasi memakai provider tiruan untuk memeriksa wiring; kepatuhan bahasa model tetap perlu diamati pada percakapan sesudah deploy.

Pemilihan model dan reasoning kini mengikuti [profil adaptif](adaptive-models.md). Jalur index yang sebelumnya dilewati saat compact aktif sudah dihubungkan ke kebijakan terkompilasi; konteks terlalu besar tetap naik ke jalur utama tanpa dipotong.

## V4: inisiatif berdasarkan konteks dan pengukuran fase

- `salesProgress` dipilih di panggilan balasan yang sama pada compact maupun non-compact: langkah berikut, penempatan pesan, teks siap kirim, dan alasan menunggu. Bila model sudah menulis langkah konkret di field ini tetapi lupa menyalinnya ke `initiative`, runtime memakai teks tersebut; tidak membuat template atau memanggil AI lagi. Tidak ada pengiriman otomatis dari catatan `goal.next_action`.
- Pujian yang menjawab pilihan bukan penutup sosial. Sesudah ditanya Cream/Choco, “yang coco bagus nih” berarti preferensi Choco. Size S yang kosong tetap menjadi hambatan; selesaikan pilihan pemenuhannya dahulu sesuai revisi v5, jangan mengulang size yang sudah diketahui atau menjanjikan restock.
- Jalur index sosial dilewati jika ada ucapan CS sebelumnya atau kebutuhan yang menunggu. Jawaban pilihan dapat memakai bahasa/aksen apa pun tanpa kata produk yang dikenali indeks; sumber konteks lengkap tetap dibaca jalur utama. Ini dapat menambah biaya untuk sapaan di room yang masih memiliki konteks, dengan prioritas menjaga kelanjutan percakapan.
- `Keputusan langkah berikut` memperlihatkan `step`, `delivery`, `waitReason` dan apakah ada inisiatif. Field tersebut ringkasan keputusan, bukan penalaran internal dan bukan izin transaksi.
- Setiap fase provider melaporkan `inputProfile.estimatedTextTokens`, `images`, `includesImageTokens: false`, dan jumlah sumber bisnis. Estimasi teks tidak boleh disamakan dengan total token gambar atau total semua putaran provider.

Untuk sumber kebijakan dengan hash yang sudah ditinjau, perbandingan gambar memakai fase pengamatan khusus tanpa MCP/history/kontrak cart. Fase penyusunan balasan tetap menerima konteks percakapan dan kebijakan balasan sesuai mode, beserta hasil pengamatan yang telah divalidasi; gambar tidak dikirim ulang ke fase teks. Cache pengamatan melewati fase piksel ini. Sumber owner yang belum ditinjau tetap memakai alur visual lengkap. Ini menambah satu fase kecil pada cache miss; penghematan total dan latensi harus diukur di produksi, terutama bila penelusuran katalog awal masih memiliki banyak putaran.

Regresi semantik opsional memakai provider nyata, data pelanggan fiktif dan database disposable. Tidak mengirim WhatsApp atau memakai MCP bisnis, tetapi memakai kuota AI. Saat diaktifkan, isi skill dari folder tersebut dan percakapan fiktif dikirim ke provider yang dikonfigurasi; gunakan hanya sumber yang diizinkan untuk pengujian eksternal:

```sh
AI_SKILL_LIVE_TEST=1 COMPACT_SKILL_FIXTURE_DIR=/path/to/exported/skills node scripts/test_cart_discount_database.mjs --sales-progress
```

Pengukuran fixture v4: konteks awal BASIC sekitar 7.785 token teks dan CART 8.997 (konteks fiktif kecil). Angka ini bukan batas total jawaban atau pemotongan konteks produksi. Pengamatan visual terpisah sekitar 3.285 token teks ditambah dua gambar; tahap jawaban tetap menerima konteks asli. Angka token gambar dan putaran katalog awal harus dibaca terpisah dari penggunaan aktual provider.

## V5: selesaikan kendala terdekat

Inisiatif bukan daftar pertanyaan atau target mengisi setiap field. AI menyelesaikan kebutuhan yang sedang terhambat, memakai sumber yang tersedia, lalu menanyakan satu keputusan/data yang diperlukan:

| Keadaan | Langkah terdekat |
|---|---|
| Model/warna/size terpilih kosong, preorder diizinkan keputusan lokal | Tawarkan preorder pilihan itu beserta estimasi dan syarat mulainya; minta keputusan pelanggan |
| Dasar preorder belum jelas | Periksa sumber/otorisasi lokal yang diperlukan; jangan mengarang izin atau memakai MCP untuk kebijakan preorder |
| Preorder tidak tersedia atau ditolak | Bantu alternatif terdekat yang terverifikasi tanpa mengganti pilihan diam-diam |
| Preorder sudah diterima pelanggan | Lanjutkan data yang kurang; jangan menawarkan/mengonfirmasi ulang |
| Batas waktu menentukan kelayakan opsi | Gunakan tanggal yang sudah ada; tanyakan hanya jika belum diketahui dan perlu menilai opsi |
| Pertanyaan harga/set, custom, ongkir atau pembayaran | Selesaikan hambatan di topik itu sebelum membuka topik acara/waktu atau penawaran lain |

Prinsip berlaku di compact dan noncompact. Test provider tiruan membuktikan penyaluran langkah yang dipilih, bukan pemahaman bahasa. Suite live opsional mencakup preorder sah, preorder nonaktif dan pelanggan menunda; tidak dijalankan tanpa izin pengiriman sumber lokal ke provider.

## Gaya rekomendasi tanpa penyangkalan rutin

Gaya bersama pada system prompt berlaku untuk compact/noncompact dan kedua provider. "Rekomendasi", "saya sarankan" atau "estimasi" cukup memberi batas makna; tidak perlu selalu menambah "bukan jaminan pas" atau "tidak bisa menjamin". Contoh: "Untuk fit slim, saya sarankan size S, bos." Pertanyaan penerimaan ukuran mengikuti kebutuhan dan aturan inisiatif yang berlaku.

Ini panduan penyusunan jawaban, bukan penghapusan kata dari hasil AI. Syarat preorder/custom, estimasi dan pemicunya, kebutuhan persetujuan, serta kendala nyata yang memengaruhi pilihan tetap disampaikan. Data ukuran bertentangan atau foto tidak jelas dijelaskan secara spesifik; rekomendasi tidak diubah menjadi klaim pasti. Tidak ada panggilan AI tambahan untuk mengubah gaya.

## Permintaan bantuan yang ramah

Aturan gaya bersama mengarahkan compact/noncompact serta kedua provider untuk meminta bantuan sesuai maksud, bukan mengeluarkan perintah “kirim/isi/ukur”. Sapaan dan bahasa mengikuti percakapan. “Bisa dibantu” atau “bisa tolong” cukup sekali pada permintaan; tidak perlu pembuka “Siap”, permintaan maaf, atau ucapan terima kasih pada setiap kalimat. Tujuan dijelaskan singkat jika membantu pelanggan melakukan langkah tersebut.

Saat beberapa data penerima belum ada, bentuknya form yang bisa langsung diisi:

```text
Bisa dibantu isi form ordernya, bos? Biar saya cek ongkirnya.

Nama penerima:
Nomor HP penerima:
Alamat lengkap:
Kecamatan:
Kota/kabupaten:
```

Ini contoh saat kelima field belum tersedia, bukan form wajib setiap giliran. Hanya data yang kurang diminta, termasuk wilayah yang sudah jelas di alamat tidak ditanyakan lagi. Satu form penerima adalah satu langkah pengumpulan data, bukan alasan sekaligus menanyakan acara, tanggal, ukuran dan produk lain. Form mengumpulkan data; tidak menciptakan persetujuan transaksi atau syarat “kalau jadi pesan”.

Pemetaan kasus berikut menjadi pedoman review, tidak dimuat seluruhnya ke prompt:

| Maksud/kondisi | Permintaan yang sesuai |
|---|---|
| Pilihan sudah jelas, beberapa data penerima belum ada | Minta bantuan mengisi form berisi field yang kurang |
| Nama dan nomor sudah diketahui, alamat belum ada | Form alamat saja; jangan minta ulang nama/nomor |
| Alamat lengkap sudah mencakup kecamatan/kota | Gunakan wilayah tersebut; jangan meminta pelanggan memisahkannya lagi |
| Hanya kecamatan kurang | “Bisa dibantu nama kecamatan tujuannya, bos? Biar saya cek ongkirnya.” |
| Semua data sudah lengkap | Lakukan pemeriksaan berikut/siapkan rekap sesuai state; jangan mengirim form kosong |
| Penerima berbeda dari pemilik chat | Minta data penerima yang belum jelas, bukan otomatis memakai nomor WhatsApp pemilik |
| “Sama seperti kemarin” | Cari sumber, pastikan rujukan sesuai kebutuhan; tanyakan hanya bagian yang masih ambigu |
| Pelanggan mengoreksi satu field | Perbarui field itu, pertahankan rincian lain yang sah; jangan kirim ulang seluruh form |
| Satu ukuran tubuh memang diperlukan | “Biar saya cocokin ukurannya, bisa tolong dibantu ukur lingkar pinggangnya dalam cm, bos?” bila basis/satuan itu sesuai panduan |
| Pelanggan memilih size standar dan datanya cukup | Jangan meminta pengukuran custom hanya demi terlihat membantu |
| Angka ukuran tersedia tetapi basis belum jelas | “Angka ini dari lingkar badan atau ukuran jasnya, bos?”; jangan menyuruh ukur ulang dahulu |
| Satuan/rujukan pemakai belum jelas | Tanyakan pembeda tersebut dengan ramah; jangan mengubah angka atau mencampur dua pemakai |
| Pelanggan belum tahu cara mengukur | Berikan panduan bisnis yang sesuai; jangan menebak cara ukur atau meminta seluruh daftar ukuran |
| Foto kurang jelas pada satu bagian | “Bisa tolong dibantu foto bagian kerahnya lebih dekat, bos?” jika kerah memang pembeda yang dibutuhkan |
| Foto/data sudah dikirim | Periksa sumber dahulu; jika tidak dapat dibaca, jelaskan kendala spesifik dan minta bantuan pada bagian itu |
| Bukti transfer diperlukan | Minta bantuan bukti yang diperlukan sesuai alur; tetap pisahkan laporan transfer dari verifikasi dana |
| Pelanggan bingung dengan beberapa pilihan | Tampilkan pembeda yang relevan dan bantu satu keputusan; jangan mengganti pilihan sendiri |
| Size pilihan kosong | Periksa kelayakan preorder dan tawarkan opsi sah dahulu; belum waktunya meminta seluruh data order |
| Pelanggan mengeluh atau sudah berulang memberi data | Akui kebutuhan, baca data yang ada dan tangani kekurangannya; jangan menyalahkan pelanggan |
| Pelanggan menunda/menolak | Hormati keputusan dan aturan susulan; kesopanan bukan alasan mengirim form atau pertanyaan lagi |

Contoh bukan pencocokan kata wajib atau pengganti aturan bukti. Tujuan pengukuran adalah membantu mencocokkan ukuran, tanpa menambahkan penyangkalan rutin atau menjanjikan pasti pas. Perubahan ini berada pada instruksi penyusunan jawaban, tanpa pemanggilan model tambahan atau penggantian kata pada hasil mentah. Uji offline dapat memeriksa format, penyaluran dan validator; keluwesan bahasa model tetap perlu dinilai dari balasan nyata.

## V6: alamat singkat dan kelanjutan data penerima

“Alamat lengkap” berarti alamat yang diberikan pelanggan untuk tujuan pengiriman, bukan kewajiban memiliki nama jalan, dusun, RT/RW, nomor rumah atau patokan. Detail itu opsional; jangan mengarang pelengkap, menilai kekurangan dari panjang teks, atau membuat pertanyaan tambahan AI sebelumnya menjadi syarat checkout. Klarifikasi tetap diperlukan untuk wilayah ambigu atau kebutuhan nyata layanan kurir, dengan meminta pembeda yang spesifik.

Contoh alur: pelanggan memberi nama dan “Cinyawang, Patimuan, Cilacap”, kemudian memilih “pakai nomor ini”. Gunakan nomor WhatsApp dari metadata yang berhasil terpetakan; simpan pilihan tersebut ke cart. Periksa tujuan dan tarif sesuai isi paket, tawarkan layanan yang terverifikasi jika belum dipilih, atau siapkan rekap jika datanya sudah siap. Jangan berhenti pada “Siap, bos”, meminta persetujuan nomor lagi, atau menunggu RT/RW. Jika nomor belum terpetakan, minta nomor sebenarnya; ID room bukan nomor telepon. Jika pelanggan menunda atau menolak, tetap ikuti maksud tersebut.

Validasi teknis tetap memisahkan teks alamat pelanggan (`street`) dari wilayah kurir (`address`). Uji protokol menerima alamat singkat tanpa menambah jalan/RT/RW ketika wilayah cocok, sekaligus menolak tujuan yang masih ambigu sebelum mencari tarif. Ini tidak membuktikan setiap alamat singkat dapat diantar atau setiap jawaban model otomatis tepat; ketepatan balasan perlu diamati setelah deploy. Perubahan aturan tersedia pada instruksi penuh, Core compact v6 (termasuk sebelum cart terisi), dan konteks identitas bersama; tidak menambah panggilan model.

## Apresiasi pada pembayaran dan bantuan pelanggan

Pemberitahuan pembayaran terverifikasi diawali ucapan terima kasih yang menyatu dengan hasilnya. Untuk contoh total Rp713.000, pembayaran tercatat Rp235.000 dan sisa Rp478.000: “Terima kasih, bos. Pembayaran Rp235.000 sudah terkonfirmasi. Sisa pembayarannya Rp478.000 dari total Rp713.000.” Angka ini hanya ilustrasi; balasan memakai nominal dan status ledger yang sebenarnya, bukan menyalin contoh atau menyebut lunas ketika masih ada tagihan.

Ucapan terima kasih untuk bantuan melengkapi data, pengukuran atau foto dipakai secukupnya sambil melanjutkan kebutuhan berikut, bukan otomatis pada setiap giliran. Jika bukti transfer baru diterima, apresiasi ditujukan pada pengiriman bukti dan tidak menyatakan dana masuk sebelum verifikasi. Status silent/handoff, pemberitahuan tunggu yang dikelola runtime, larangan pengulangan pesan, serta persetujuan/proses produksi tetap berlaku. Kehangatan tidak menambah janji produksi atau memperlakukan “oke sip” sebagai pembayaran.

Aturan gaya bersama berlaku untuk kedua provider dan mode compact/noncompact. Tidak ada panggilan AI tambahan atau penambahan awalan secara paksa pada hasil mentah. Tes offline memeriksa integrasi dan batas input, bukan menjamin setiap keluaran model; bahasa nyata perlu ditinjau setelah deploy.

## Receipt, nomor pesanan dan kelanjutan setelah pembayaran

Konteks menyertakan ringkasan event `payment_confirmed` yang tersimpan, terhubung lewat nomor dan (jika tersedia) ID order dalam room yang sama. Sebelumnya event ini hanya terlihat sebagai nama event dan waktu, sementara AI menerima lima order terbaru tanpa hubungan pembayaran yang eksplisit. Ringkasan baru memuat pembayaran pada event, alokasi tanpa transfer, total pembayaran akumulatif, sisa aktual, serta status order dan operasi yang tersedia. Order terkait tetap dapat diringkas bila berada di luar lima order terbaru yang ditampilkan; pencarian memakai daftar lokal yang sudah dibaca (maksimal 100), tanpa tambahan panggilan AI atau MCP. Jika state order tidak tersedia/cocok, tandai tidak tersedia, bukan mengambil order lain.

Pemberitahuan pertama menggabungkan terima kasih, nomor pesanan asli, pembayaran/sisa atau lunas, serta tahap/kelanjutan yang didukung state. Misalnya, jika operasi benar-benar sudah `production`, boleh memberitahukan pesanan masuk pengerjaan beserta estimasi yang sah. Jika `queued`, jangan mengaku sedang dijahit; jika status belum tersedia, jangan menebak. Receipt bukan bukti barang sudah dikirim. Pelunasan berikutnya memakai nomor pesanan yang sama, dan alokasi kelebihan pembayaran bukan transfer baru. Balasan checkout otomatis dari kelebihan pembayaran juga memuat terima kasih dan nomor yang sudah tercatat.

Jika balasan sebelumnya hanya menyebut nominal, lengkapi nomor/status penting yang belum diberitahukan tanpa mengulang seluruh rekap. Event historis tidak otomatis meminta pesan baru: bandingkan dengan pesan yang sudah terkirim, ikuti batas review/silent, dan tangani pertanyaan pelanggan. Ringkasan tambahan hanya muncul bila ada event pembayaran valid di delapan event cart terbaru, bukan untuk setiap pertanyaan produk. Penerimaan foto atau hasil baca receipt tanpa konfirmasi dana tidak menghasilkan bagian konteks ini. Ini penyediaan bukti dan panduan balasan; pengiriman tetap melalui proses serta validasi yang ada.

## Kesetaraan alur main sebelum cart

Compact v7 mengembalikan batas dari sumber `cs-cart-order`: hanya ukuran terkonfirmasi yang boleh disimpan; jangan memaksakan item yang belum valid. Persetujuan untuk mengecek model custom tidak memilih ukuran, mengesahkan kelayakan/harga, atau memesan. Jika ukuran belum diketahui, `cartIntent` tetap null; pertanyaan/pemeriksaan mengikuti kebutuhan percakapan, tanpa urutan data wajib. Fakta dan referensi tetap berasal dari pesan asli. Validator penyimpanan dan checkout sama dengan main; ukuran kosong tidak diizinkan menjadi item, dan `custom` bukan pengganti ukuran yang belum dipilih.

### v8 — custom bertahap dan konteks sumber

Modul `Custom` memisahkan model, ukuran, warna per bagian, bahan, serta ready/pre-order. Label katalog dengan perubahan dimensi memakai `size=custom` dan `requestedSize` sebagai label dasar; informasi badan untuk rekomendasi biasa tetap bukan custom. Mengembalikan ukuran standar tidak mencabut desain yang masih disetujui. Urutan data mengikuti kebutuhan percakapan, tanpa memaksa cart atau pembayaran lebih dahulu.

Modul dimuat bila konteks menyebut kebutuhan custom, cart menyimpan custom/penyesuaian desain yang disetujui, atau kontrak tindakan cart/custom/approval dibaca. Model juga dapat mengambilnya melalui `read_business_skill(modules)`. Petunjuk teks hanya memilih bacaan awal, bukan menetapkan maksud, otorisasi atau tindakan. Modul tidak dikirim ulang saat sudah tersedia pada fase tersebut. Kebijakan harga, kelayakan, persetujuan dan transaksi tetap diverifikasi oleh jalur yang sama.

Kutipan aktif mempertahankan struktur form dan hingga 6.000 karakter; kutipan sama diperluas sekali. Preview riwayat tetap 600 karakter dan menandai pemotongan secara eksplisit, dengan ID untuk mengambil sumber lengkap. Batas ini bukan jaminan semua sumber masuk konteks awal; jika detail relevan terpotong, sumber harus dibaca kembali. Dokumen/form asli di database tidak diubah.

Stok ready dihitung gabungan per SKU/size sambil mempertahankan tiap baris pemakai/detail. Hanya pre-order yang sah dikecualikan dari kebutuhan stok ready. Penambahan baris/jumlah memeriksa kembali kebutuhan gabungan; perubahan penerima tanpa perubahan barang tidak memaksa lookup baru.

Validasi offline: 203 tes terkait lulus (72 unit, 41 catalog/recovery, 14 order details, 46 human evidence, 10 fulfillment, 17 compact, 3 memory). Sebelum perbaikan, tiga regresi stok dan lima regresi konteks gagal pada beta. Fixture prompt awal BASIC sekitar 7.859 token dan CART 8.992; ini estimasi teks awal, tidak mencakup seluruh panggilan, keluaran tool, overhead provider atau gambar. Kasus custom kompleks boleh memuat bukti tambahan. Tidak ada inference AI eksternal, pesan pelanggan, atau deploy VPS pada pemeriksaan ini. Matriks audit bukan isi prompt runtime dan kelulusan validator bukan bukti semua variasi bahasa dipahami model.

Jika model tetap menghasilkan sync tanpa ukuran, preflight menahan seluruh sync sebelum mutasi. Worker memakai konteks percakapan asli untuk satu perbaikan keputusan tanpa cart/checkout/approval effects. Balasan bisa berupa pertanyaan relevan atau handoff yang benar-benar membutuhkan manusia menurut skill. Ini bukan pertanyaan ukuran yang disisipkan sebagai template. Keluaran perbaikan yang masih meminta mutasi ditolak; tidak ada rekursi. Cart/order lama tidak berubah, checkout saldo otomatis dilewati untuk giliran tersebut, serta perubahan pesan/state membatalkan balasan lama. Jalur normal tanpa cart tidak menambah panggilan AI. Uji offline memakai provider/socket tiruan, sehingga memeriksa batas alur, bukan menjamin bahasa model live.

Validasi ukuran di dalam transaksi tidak lagi dianggap database down hanya karena stack melewati Lucid/Knex. `CART_SELECTION_INCOMPLETE` membedakannya dari kegagalan koneksi database nyata. Pembacaan sumber melebihi 100 baris menghasilkan satu halaman terbatas dengan `nextLine` dan informasi batas halaman, bukan error rentang atau pemotongan tersembunyi; sumber tetap dapat dibaca utuh bertahap.

## v11 — padanan warna dan pola harga internal

Nama warna mempunyai dua lapisan: padanan bahasa yang eksplisit (BW/Broken White,
ivory/putih gading, navy/biru dongker, grey/gray/abu-abu) dan kandidat berdekatan
untuk pencarian. Putih gading dapat membuka pencarian BW/off-white, tetapi tidak
menjadi izin menyatukan varian berbeda. Normalisasi NFKC menangani variasi font;
penanda shade, negasi, bagian badan/lapel, ID katalog dan sumber persetujuan tetap
dipertahankan. Indeks pencarian katalog menambahkan padanan sekali per warna,
bukan mengulang daftar pada setiap produk. Foto tetap harus dibandingkan.

Bridge MCP menambahkan `appInternalPricePattern` terpisah dari hasil asli setelah
minimal dua produk dalam keluarga nama yang sama dibaca lewat `get_product`.
Pengelompokan mengabaikan nama warna, memisahkan sumber, material eksplisit,
mata uang dan size; ini **belum membuktikan desain/bahan/komponen setara**.
Ringkasan memuat harga dominan, rentang, pengecualian dan ID sampel. Produk yang
sama tidak dihitung ulang, size custom tidak dijadikan sampel standar, dan bukti
kedaluwarsa setelah 60 detik termasuk saat hasil dibaca kembali dari cache.
Tidak ada panggilan AI tambahan, pemindaian seluruh katalog atau aturan harga
permanen yang dipelajari dari sampel. Payload dibatasi empat size dan enam sumber
per size; jumlah yang tidak ditampilkan dicatat, bukti asli tidak dipangkas.

Pola harga hanya bahan internal untuk review CS, **tidak dikirim sebagai harga
custom kepada pelanggan**, dengan atau tanpa kata “perkiraan”. Nominal seperti
535.000 bukan harga tetap yang ditanam dalam kode. AI memeriksa model/konstruksi,
kelas/bahan, jas/set, jenis harga dan size pembanding, serta menyimpan dasar review
di catatan internal. Harga final custom tetap memerlukan bukti CS yang sah;
custom ukuran tetap membutuhkan review ukuran. Persetujuan model tidak sekaligus
menyetujui ukuran atau harga. Validator transaksi tidak memakai statistik ini.

Compact memuat modul Catalog sesuai konteks warna/model/harga/custom; modul tetap
bisa dibaca secara eksplisit. Sapaan dan pelengkapan nama penerima tidak otomatis
memuat aturan katalog. Aturan yang sama tersedia pada jalur noncompact dan
perbandingan visual. Uji fixture compact menghasilkan konteks awal 7.853 token
(BASIC), 8.986 (CART), dan 8.366 (CATALOG_PHOTO); ini estimasi teks awal, bukan total
tagihan atau token gambar/putaran model. Pengujian memakai fixture offline, bukan
jaminan akurasi semantik semua foto/pesan pada model produksi.

## v10 — layanan custom, pre-order dan ready mengikuti kebutuhan

Arahan pemilik: custom adalah layanan utama; contoh dari postingan CS dapat belum
terdaftar di katalog. Ketidakcocokan kandidat bukan kegagalan layanan, bukti barang
tidak tersedia, atau alasan otomatis meminta maaf. Maksud pelanggan menentukan
langkah berikut bersama kondisi produk. Custom/PO diutamakan sebagai jalur
pemeriksaan layanan, tanpa pertanyaan memilih custom atau ready sebagai gerbang.
Ready ditawarkan bila model, warna, ukuran dan stoknya sesuai permintaan; stok
standar tidak membatalkan modifikasi yang diminta. Preferensi ready saja, syarat,
koreksi dan persetujuan pelanggan tetap berlaku.

Satu cart boleh mencampur ready, pre-order, model custom, dan ukuran custom.
Detail, harga, status stok/produksi dan bukti persetujuan tetap per item; pengiriman
terpisah tidak dibuat otomatis. Gerbang visual kini mengizinkan pelengkap katalog
dengan bukti MCP atau state cart terverifikasi bersama draft custom referensi
terbaru yang belum diberi harga. Referensi foto tidak boleh diganti SKU kandidat;
validasi ukuran, harga, stok, keputusan PO lokal dan approval custom tetap berjalan.

Aturan ini berlaku pada prompt visual lengkap, modul Visual compact, dan balasan
yang menggunakan observasi visual tersimpan. Bukti kecocokan, harga, stok,
persetujuan, dan validasi cart tetap terpisah. Pertanyaan penentu no_match/uncertain
ditulis pada pesan utama agar tidak bergantung pada inisiatif terpisah yang ditahan
oleh gerbang visual. Tidak ada panggilan AI tambahan untuk aturan ini.

Contoh perilaku untuk review (bukan hasil evaluasi model produksi):

| Konteks/maksud | Langkah yang diharapkan |
| --- | --- |
| Foto jelas + “ini berapa?” | Jawab harga sah bila ada; jika belum cocok katalog lanjut pemeriksaan desain/harga custom dan hanya minta detail penentu yang belum diketahui, tanpa pertanyaan memilih custom atau ready |
| Foto + “buatkan seperti ini” | Lanjut pemeriksaan desain/harga atau detail penentu yang belum ada; jangan tawarkan cek kemungkinan custom lagi |
| Foto + “ada ready S?” / “nggak mau nunggu jahit” | Periksa ready model/size yang sesuai; jangan mengubahnya menjadi pesanan custom |
| Model/warna/size persis sesuai dan stok tersedia | Tawarkan ready dari bukti stok per size; tidak perlu bertanya apakah mau custom |
| Model sesuai, size terpilih kosong | Periksa PO lokal; jika sah sampaikan estimasi/syarat lalu lanjut kebutuhan terdekat, tanpa melempar pilihan layanan umum |
| Stok standar tersedia tetapi pelanggan minta warna/lengan diubah | Pertahankan perubahan dan proses pemeriksaan custom; ketersediaan stok bukan alasan menghapus modifikasi |
| Stok belum diketahui atau MCP gagal | Periksa/pulihkan sumber; jangan menganggap stok kosong atau mengklaim PO sudah tersedia |
| “Kalau ready ada ambil, kalau tidak boleh custom” | Periksa kondisi ready dahulu; custom adalah pilihan bersyarat, bukan keduanya dipesan |
| “Harga ready dan custom berapa?” | Periksa/jawab kedua jalur sesuai bukti; jangan memaksa pelanggan memilih dahulu |
| Screenshot postingan CS | Gunakan referensi/caption yang ada; jangan menganggap unggahan membuktikan stok atau harga masih berlaku |
| Foto buram atau kandidat gagal dimuat | Klarifikasi bagian yang perlu atau lanjut pemeriksaan; jangan simpulkan pasti custom/nonkatalog |
| “Iya” sesudah pertanyaan dua pilihan lama | Baca konteks; klarifikasi hanya keputusan nyata yang tetap ambigu, jangan menganggap persetujuan produksi/order otomatis |
| Custom sudah dipilih, lalu bertanya harga dari foto yang sama | Pakai observasi tersimpan yang cukup dan periksa harga; jangan bertanya niat lagi |
| Ganti ke ready setelah membahas custom | Ikuti koreksi, pertahankan fakta yang masih berlaku; tidak memindahkan approval custom ke SKU lain |
| Jas custom foto + celana ready + rompi pre-order | Simpan tiga baris dalam satu cart, tanpa mengubah status item lain atau menebak harga custom; stok ready dan izin PO tetap diperiksa |

Validasi v10: 79 uji lokal lulus (36 unit, 12 fulfillment, 14 alur visual,
17 compact); satu uji model live tidak dijalankan. Typecheck dan build lulus.
Fixture BASIC tetap sekitar 7.859 token teks awal, CART 8.993; tidak termasuk
gambar, overhead provider dan akumulasi putaran. Uji memakai provider tiruan,
bukan penilaian respons model produksi. Database uji sementara dihapus kembali.
