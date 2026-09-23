# WhatsApp Workspace — UI guidelines

## Prinsip

Antarmuka ringkas, tenang, dan berorientasi tindakan. Tampilkan data, label, status, dan tindakan yang diperlukan. Hindari paragraf pengantar, instruksi berulang, serta status yang muncul di beberapa tempat dalam panel yang sama. Jangan mengubah isi skill atau bahasa percakapan saat merapikan UI.

## Sumber desain

- `public/assets/forms.css`: token dan kontrol form bersama. Muat setelah stylesheet halaman agar ukuran konsisten.
- `public/assets/orders.css` dan `production.css`: layout halaman, bukan sistem kontrol baru.
- `public/assets/motion.css`: animasi dan reduced motion.
- `public/lang/en.js` dan `id.js`: seluruh label UI, English default.
- `public/assets/theme.js` dan `theme.css`: preferensi tema dan token warna WhatsApp; jangan mengubah stylesheet workspace PHP bersama untuk kebutuhan tema WhatsApp.

## Tema dan latar chat

- Pengaturan → Umum → Tema tampilan: Auto (default, mengikuti sistem), Light, Dark. Preferensi disimpan per browser dan workspace, langsung berlaku tanpa tombol simpan. Auto merespons perubahan tema sistem; pilihan eksplisit tetap dipertahankan. Tab workspace yang sama ikut tersinkronisasi.
- Muat `theme.js` di head sebelum stylesheet untuk menghindari kilatan tema terang. Muat `theme.css` terakhir agar kontrol, dialog, cart, order, dan badge memakai palet yang sama. Pertahankan perbedaan warna AI/CS dan status beserta labelnya.
- Motif `chat-pattern.svg` hanya menjadi latar area pesan: garis tipis, kontras rendah, tidak bergerak, tidak menerima klik. Bubble tetap polos. Jangan memberi filter warna pada foto, avatar, video, atau QR; QR tetap berlatar putih.
- Dark memakai dasar AMOLED `#000` pada halaman dan area pesan, dengan sidebar `#111113`, panel/header/composer `#171719`, permukaan bertingkat `#222225`, serta hover `#303034`. Pemisah abu halus memperjelas hirarki; jangan membuat semua div hitam. Warna hijau/biru/kuning tetap menjadi aksen status dan pembeda AI/CS, bukan tint seluruh halaman.
- Uji light/dark/auto pada Chromium dan WebKit, termasuk warna teks native dropdown, perubahan tema sistem, penyimpanan terblokir, desktop dan mobile. Motif tidak ditampilkan saat print atau forced colors.
- Panel penerima/pengiriman pada detail order memakai permukaan biru lembut sesuai tema, dengan kontras judul, label, dan isi minimal 4.5:1. Uji order terisi, bukan hanya dialog kosong. Input upload dan `::file-selector-button` mengikuti palet dark; jangan meninggalkan kontrol native putih di Safari.

## Kontrol dan ukuran

- Input teks, angka, tanggal, dropdown, serta tombol form: tinggi 36 px desktop, 40 px layar sentuh/mobile. Gunakan `box-sizing: border-box`.
- Font kontrol 12 px, line-height 18 px; mobile 16 px agar Safari tidak melakukan zoom saat fokus.
- Radius kontrol 6 px, padding horizontal 10 px, dropdown menyisakan ruang ikon panah. Jangan menyamakan tinggi elemen `option` native; samakan elemen `select` tertutup.
- Label selalu di atas, gap 6 px; bukan placeholder sebagai satu-satunya label. Label tidak memanjang menjadi paragraf. Kontrol dalam satu baris rata bawah.
- Textarea minimal 88 px, bisa diperbesar vertikal. Catatan panjang memakai lebar penuh.
- Grid form: 2 kolom, gap 12 px. Angka minimum/estimasi/maksimum: 3 kolom. Di layar sempit susun satu kolom tanpa overflow horizontal.
- Switch memakai komponen `.wa-switch` yang sudah ada; jangan menerapkan tinggi input padanya. Switch sejajar kanan judul, bukan berada dalam grid isian.

## Hirarki dan warna

- Judul halaman 22 px; judul bagian 14 px; label/status 12 px.
- Panel putih dengan border tipis; radius 10 px; padding 16 px (12 px mobile).
- Produksi memakai latar abu sangat muda; pengiriman grup memakai hijau sangat muda. Warna harus disertai label, bukan satu-satunya pembeda.
- Satu tombol utama per form. Tindakan sekunder netral. Ikon tanpa teks harus mempunyai accessible name; tombol copy tetap di samping nomor order.
- Badge cart menghitung total kuantitas draft (bukan jumlah order), disembunyikan saat kosong, dan ditampilkan maksimal `99+`; jumlah lengkap tersedia pada accessible name. Ikon uang kecil menandai transfer yang perlu diperiksa, bukan dana sudah diterima. Tombol konfirmasi memakai ikon cart + uang dan tetap berlabel.
- Ringkasan order di Cart & Order menampilkan satu baris status produksi terpisah dari badge pembayaran. Gunakan status operasional tersimpan, bukan perkiraan dari pembayaran atau keberadaan resi; order dibatalkan tidak menampilkan status produksi lama.
- Proses AWB memakai komponen bersama satu baris tahap, spinner kecil hanya saat lease dan heartbeat worker aktif, serta metadata pemeriksaan/retry. Order yang dibuka memperbarui panel produksi tiap 5 detik; jangan menutup disclosure, menghilangkan fokus tombol, atau menimpa isian yang belum disimpan.
- Pilihan aktif diberi border dan latar lembut. Pertahankan focus ring keyboard yang jelas, termasuk dropdown dan disclosure.

## Informasi dan interaksi

- Kontak & Alamat berada pada satu menu sidebar. Tabel menampilkan avatar/inisial, nama, nomor WhatsApp terverifikasi, dan alamat penerima (nomor penerima terpisah). Alamat dari cart, order, dan memori bersumber diberi label singkat; kosong tidak ditebak. Pencarian/pagination server-side, ekspor CSV mencakup seluruh hasil pencarian dengan satu baris per alamat, terproteksi login dan namespace nomor WhatsApp. Jangan mengekspor JID sebagai nomor telepon atau memasukkan foto/token ke CSV.
- Grup produksi default dibuka melalui ikon pengaturan di kanan judul Order, memakai dialog floating ringkas; tidak memakai kartu/disclosure permanen. Status simpan/error berada di dialog; pilihan yang belum disimpan tidak boleh ditimpa sinkronisasi grup.
- Halaman Order memakai tabel penuh: nomor order, pelanggan, total, pembayaran, status produksi; pencarian/filter dan pagination di luar tabel. Klik baris atau tombol nomor membuka dialog floating kanan (maksimal 640 px, layar penuh pada mobile), bukan kolom detail permanen. Tabel boleh scroll horizontal di layar kecil, tetapi halaman tidak. Dialog mempunyai header/tombol tutup tetap, konten scroll sendiri, fokus keyboard terkunci dan dikembalikan ke baris saat tutup; Escape/backdrop meminta konfirmasi jika isian berubah. Foto memakai viewer di atas dialog tanpa menutup detail order.
- Status simpan hanya satu di dekat tindakan; error tidak disembunyikan. Jangan menaruh teks bantuan panjang di tiap field.
- Info singkat memakai ikon ⓘ dan popover bersama (`info.js`, `.wa-info-button`, `.wa-info-popover`) seperti detail handoff. Klik/Enter membuka; Escape, klik luar, atau tombol tutup menutup. Popover dibatasi viewport, tidak mendorong layout, dan dapat di-scroll. Jangan memakai paragraf bantuan permanen atau hover-only tooltip.
- Pemetaan eksternal, pratinjau, dan riwayat tetap memakai `details/summary`, tertutup secara default.
- Jangan menghilangkan konfirmasi tindakan berisiko: kirim ke grup, kirim ulang dengan hasil tidak pasti, atau membuang perubahan.
- Hapus chat & media berada terpisah di Pengaturan → Umum: tombol merah lembut, konfirmasi cakupan permanen, satu status proses, dan tombol nonaktif selama penghapusan. Jangan gabungkan dengan Disconnect/Archive.
- Pengaturan sederhana tetap autosave dengan status pending/saved/error. Perubahan operasional order dan tujuan grup tetap memakai tombol eksplisit.
- Jangan menampilkan alamat/telepon dalam pratinjau produksi. Jangan menerjemahkan nama pelanggan, data produk, chat, atau isi skill.
- Detail pengerjaan per item selalu terlihat dalam panel bersama di cart dan order, bukan dropdown/disclosure yang menutup saat refresh. Label berada di atas nilai: spesifikasi putih, ukuran biru lembut, catatan hijau lembut, kebutuhan belum lengkap kuning lembut; warna selalu disertai label. Catatan dan kebutuhan belum lengkap memakai lebar penuh; pada mobile semua field satu kolom. Tinggi memakai cm, berat kg, ukuran badan terpisah dari pakaian jadi; kosong berarti belum diketahui, bukan nol. Referensi pesan tersimpan internal. Skill mengatur percakapan, bukan menggantikan validasi data atau persetujuan custom.
- Panel produksi order hanya menampilkan status, estimasi otomatis, resi bila tersedia, dan satu tindakan tahap berikutnya. Jangan tampilkan form koreksi status/tanggal/jenis/sumber estimasi/pemetaan eksternal. Aturan estimasi dikelola di Pengaturan → Produksi & Pre-order; estimasi tersimpan tidak ditulis ulang saat halaman dibuka. Waktu estimasi bukan bukti pengiriman.
- Animasi mengikuti token motion bersama; hormati `prefers-reduced-motion`. Hindari animasi yang memindahkan fokus atau mengubah posisi saat pengguna mengisi form.
- Interaksi terasa ringan: hover tombol naik 1 px hanya pada mouse, tekan mengecil 3%, avatar kontak membesar tipis, fokus form ber-ring lembut. Gunakan easing perlambatan `cubic-bezier(0.22, 1, 0.36, 1)` dan durasi 160–340 ms; respons tekan 90 ms. Navigasi/baris tidak bergeser dan isi chat tidak dianimasikan ulang saat polling. Panel/disclosure/dialog memakai `waMotion` yang ada, tidak menambah animasi paralel. Nonaktifkan efek gerak pada Reduce Motion dan tombol disabled.
- Efek magnet hanya pada tombol aksi kecil saat mouse berada di atasnya, maksimal 2 px per sumbu. Gunakan satu frame terjadwal per gerakan, tanpa loop idle; posisi layout tetap. Reset saat keluar, klik, fokus keyboard, scroll, blur, atau tombol dinonaktifkan. Touch, Reduce Motion, baris kontak, input, dan media tidak memakai magnet.

## Verifikasi perubahan

- Pengaturan → Danger zone dipisahkan dari General/autosave. Gunakan kartu merah redup yang terbaca pada light/dark, nomor aktif terlihat, cakupan hapus/simpan dan peringatan permanen ringkas. Tombol reset wajib konfirmasi serta ketikan persis `RESET ALL`; batal/salah ketik tidak mengirim POST. Selama pending/retry nonaktifkan kedua tombol penghapusan, tampilkan satu status, jangan auto-repeat POST saat koneksi tidak pasti.

- Usage: pisahkan kartu sisa kuota akun dari token aplikasi. Bar memakai persentase **sisa**, terpisah per provider/periode; hijau >30%, kuning 11–30%, merah ≤10%. Tampilkan reset dan waktu observasi. Data lama abu-abu dengan label laporan terakhir; data tidak tersedia/pasca-reset tidak diberi persentase rekaan. Gunakan native progress dengan label aksesibel, tata letak dua kolom desktop/satu kolom mobile, dan warna dark yang konsisten.

- Pengaturan → Evaluation: switch pembelajaran otomatis (default off), status tunggal, info popover, dan disclosure pola/riwayat. Aktivasi membutuhkan AI aktif dan skill `eval`/`evaluation`. Skill inti tidak ditimpa; tambahan otomatis bernama `conversation-learning`.
- Hanya empat pola terkurasi: inisiatif foto, pertanyaan berulang, format pilihan, dan goal prematur. Minimal tiga pelanggan berbeda dengan evaluasi mutakhir dalam 30 hari; maksimal satu kandidat per 24 jam/workspace, dua panggilan replay, mulai hanya saat antrean chat idle. Temuan kebijakan bisnis hanya untuk tinjauan manusia.
- Tampilkan hasil baseline vs kandidat (8 skenario sintetis), status versi, dan rollback versi aktif. Kandidat wajib lolos semua kasus dan memperbaiki baseline; bukan bukti kenaikan order rate. Kegagalan provider tidak menerapkan perubahan; maksimal tiga percobaan per kandidat/baseline dengan jeda harian. Rollback menjeda otomatis dan menahan aturan yang dibatalkan dari penerapan ulang.
- Pengubahan manual/deletion skill pembelajaran menahan otomatis; jangan menimpa edit pemilik. Riwayat skill tetap ada saat chat dihapus, tetapi referensi bukti chat di riwayat dibersihkan. Simulasi berjalan tanpa tool bisnis dan tidak mengirim pesan.

Uji English/Indonesia, desktop 1440 px dan mobile 390 px. Pastikan tinggi dropdown/angka/tanggal/teks sama, baris sejajar, teks tidak terpotong, keyboard dapat dipakai, halaman dapat di-scroll, serta tidak ada horizontal overflow. Tes UI memakai API tiruan: jangan mengubah order, pembayaran, pengaturan live, atau mengirim WhatsApp untuk pengujian visual. Naikkan versi aset yang berubah pada layout.
