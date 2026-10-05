# Pelajaran dari chat CS (kumpulan, belum diterapkan)

Contoh chat CS asli yang dikumpulkan pemilik sebagai bahan perbaikan AI (skill `skills-beta3/beta3-cs-inti/SKILL.md`).
**Jangan diterapkan ke skill sampai pemilik bilang "update".** Setelah contoh cukup, rangkum semua menjadi satu perubahan skill dengan contoh sebelum/sesudah.

**Status:** #1–#5 sudah diterapkan di v3.4.163 (skill + sistem):
- kebijakan tukar size jadi pengaturan (Pengaturan → Data bisnis), dipakai AI persis;
- ucapan setelah konfirmasi dana: barang ready "Terimakasih bos, siap kirim hari ini ya" (lewat jam 15 WIB: "besok"), pre-order/custom/DP "Terimakasih bos, prosess ya";
- total otomatis ditahan bila nomor celana setelan belum diketahui;
- AI melihat ORDER BERJALAN (status produksi, target kirim, resi) untuk "sudah jadi?/sudah dikirim?";
- size chart dari data website (tanpa gambar).
Belum: pesan resi otomatis (resi dibuat di luar aplikasi ini, CS tetap mengirimnya). Contoh baru mulai dari #6.

Format tiap contoh: ringkasan chat → yang sudah sesuai skill → usulan perubahan (kalimat CS dipakai persis).

---

## #1 · 2 Okt 2026 · size XL habis → pre-order, set jas + celana + rompi

**Ringkasan chat**
- Pelanggan: "Boleh mas gapapa xl ada? Atau harus po?"
- CS: "size XL habis bos, paling pre order ya"
- Pelanggan: "Iya kak PO aja"
- CS: "oke siap, mau jas saja atau sekalian dengan celananya ya, biar serasi?"
- Pelanggan: "Jas celana rompi ya mas"
- CS: "oke siap bos" → "celana menyesuaikan kah atau pakai No. berapa ya?"
- Pelanggan: "Menyesuaikan aja mass"
- CS: "oke siap" → kirim template form order (sama persis dengan skill)
- Pelanggan mengisi form, `Note : set jas, rompi, celana XL warna ash grey`
- CS: "ongkir mau pakai apa ya bos?"

**Sudah sesuai skill (tidak perlu diubah)**
- Tawaran celana: kalimatnya sama dengan skill.
- Template form order: sama persis.
- Size kosong → tawarkan pre-order. Skill malah lebih lengkap karena menyebut lama pengerjaan dari ESTIMASI PRODUKSI. CS di chat ini tidak menyebutnya, jadi tetap pakai versi skill.

**Usulan perubahan**
1. **Nomor celana belum jelas** (tanpa REKOMENDASI SIZE celana)
   - Kalimat CS: "celana menyesuaikan kah atau pakai No. berapa ya?" (skill sekarang: "celananya biasa pakai no berapa bos?").
   - Pelanggan jawab "menyesuaikan" → jangan tanya nomor lagi, tulis di spesifikasi `Size XL, celana menyesuaikan`. Tetap jangan menebak angka nomor celana.
2. **Pelanggan menambah rompi** saat ditawari celana ("jas celana rompi")
   - Balas "oke siap bos".
   - Spesifikasi `Jas, Celana, Rompi`; rompi ikut size jas.
   - Harga rompi dari KATALOG di baris `order`.
3. **Form masuk tapi layanan ongkir belum dipilih**
   - AI bertanya sendiri, sekali (skill sekarang: diserahkan ke CS).
   - Ada bagian ONGKIR → "siap bos, datanya sudah masuk. ke {kecamatan} ongkirnya REG {tarif} ({estimasi}) atau JTR {tarif}, mau pakai yang mana bos?"
   - Tidak ada ONGKIR → kalimat CS: "ongkir mau pakai apa ya bos?"
4. **Baca `Note :` di form** sebagai sumber spesifikasi (produk, size, warna), mis. "set jas, rompi, celana XL warna ash grey".

**Catatan lain**
- Jeda balasan CS di chat ini sampai ±3 jam. Ini bukan aturan skill, tapi alasan AI perlu menangani tahap-tahap ini sendiri.

---

## #2 · 2 Okt 2026 · jas saja (ready) → total → bayar → kirim hari itu → resi

**Ringkasan chat**
- Pelanggan mengirim foto produk ("Ini bosku").
- CS: "Oke siap, mau jas saja atau sekalian dengan celananya ya, biar serasi?"
- Pelanggan: "Jas aja bosku"
- CS: "Siap"
- CS kirim total:
  ```
  Jas 485.000
  ongkir 80.000

  Total 485.000 + 80.000 = 565.000 bos
  ```
- CS: "Untuk pembayaran tf ke rek {rekening resmi} agar pesanan langsung kami proses"
- Setelah dana masuk, CS: "Terimakasih bos, siap kirim hari ini ya"
- Pelanggan: "Siap terimakasih" → CS: "Siap sama sama bos"
- Sore hari CS: "Pesanan sudah di kirim bos dengan No. Resi {resi} (JNE)"
- Pelanggan: "makasih borku" → CS: "Siap sama sama bos"

**Sudah sesuai skill/sistem (tidak perlu diubah)**
- Tawaran celana: kalimatnya sama.
- Format total dari sistem sama dengan CS: baris produk, baris ongkir, lalu "Total a + b = c bos". Versi sistem menambah nama layanan ongkir.
- Kalimat rekening dari sistem sama persis: "Untuk pembayaran tf ke rek … agar pesanan langsung kami proses".
- Penutup "siap sama sama bos" sudah ada di skill.

**Usulan perubahan / ide**
1. **Setelah toko mengonfirmasi dana masuk, untuk barang ready.**
   - Kalimat CS: "Terimakasih bos, siap kirim hari ini ya".
   - Bisa jadi pesan otomatis saat CS menekan "Konfirmasi dana masuk" di aplikasi.
   - Lewat jam kirim → "siap kirim besok ya". Pre-order → pakai estimasi produksi, bukan "hari ini".
   - AI sendiri tetap tidak boleh menyatakan dana masuk sebelum toko konfirmasi.
2. **Pesan resi.**
   - Kalimat CS: "Pesanan sudah di kirim bos dengan No. Resi {resi} (JNE)".
   - Bisa dikirim otomatis saat resi/AWB dibuat untuk order itu, dengan kalimat persis ini.
3. **Pelanggan berterima kasih setelah pesan toko** ("Siap terimakasih", "makasih borku").
   - Balas cukup "Siap sama sama bos". Jangan menambah pertanyaan atau penawaran baru.

**Catatan lain**
- Alur barang ready singkat sekali: foto → tawar celana → total + rekening. AI tidak perlu menanyakan hal lain bila size dan alamat sudah jelas sebelumnya.

---

## #3 · 7 & 18 Sep 2026 · tanya marketplace, beda Peak vs Basic Suit, kirim sehari sampai

**Ringkasan chat**
- Pelanggan: "sore kak tokonya ada di tokped gak?"
- CS: "Sore, maaf bos gak tersedia di marketplace ya" → "untuk pemesanan bisa melalui cs di whatsapp dan website chameleoncloth.com ya bos"
- (11 hari kemudian) Pelanggan: "halo kak peak suit sama basic suit black beda nya apa?"
- CS: "Halo" → "beda dari model kerahnya bos, untuk peak suit kombinasi hitam mengkilap di bagian kerah"
- Pelanggan: "ada pengiriman yg sampe sehari gak ke sukabumi?"
- CS: "ke kecamatan apa ya bos?" → Pelanggan: "warudoyong sukabumi" → CS: "ada service YES bos"

**Sudah sesuai skill (tidak perlu diubah)**
- Tujuan terlalu luas → tanya kecamatan dulu, satu pertanyaan.
- Ekspedisi JNE dengan layanan REG/YES/JTR sudah dikenal skill.

**Usulan perubahan**
1. **Ditanya marketplace** (Tokopedia/Shopee/TikTok Shop/Lazada, "ada di tokped?"). Belum ada di skill.
   - Kalimat CS, dua bubble: "maaf bos gak tersedia di marketplace ya" → "untuk pemesanan bisa melalui cs di whatsapp dan website chameleoncloth.com ya bos".
   - Ikuti salam pelanggan ("Sore, …").
   - Jangan mengarang link toko marketplace.
2. **Beda model kerah**, misalnya "peak suit sama basic suit beda nya apa?".
   - Jawab bedanya langsung, singkat: "beda dari model kerahnya bos, untuk peak suit kombinasi hitam mengkilap di bagian kerah".
   - Ambil dari ciri di KATALOG bila ada. Perlu konfirmasi pemilik: Basic Suit = kerah biasa/senada, Peak Suit = kerah peak dengan kombinasi hitam mengkilap (satin).
   - Boleh kirim foto keduanya lewat field `foto` supaya jelas.
   - Skill sekarang hanya "bedanya di modelnya bos, saya kirim fotonya ya" bila data tidak ada.
3. **Tanya pengiriman cepat** ("sampe sehari", "besok sampai").
   - Sesudah kecamatan jelas dan ada bagian ONGKIR, jawab layanan YES **beserta tarif dan estimasinya** dari ONGKIR. Contoh: "ada bos, pakai YES ke Warudoyong {tarif}, estimasi besok sampai".
   - Lebih lengkap dari CS ("ada service YES bos").
   - YES tidak tersedia untuk tujuan itu → sebut layanan tercepat yang ada beserta estimasinya.
   - Ingatkan bila pesanan pre-order: tetap menunggu pengerjaan dulu.

**Catatan lain**
- Jeda balasan CS sampai ±3 jam (8:50 → 11:25, 11:28 → 14:27) untuk pertanyaan sederhana. AI bisa menjawab ini langsung.

---

## #4 · 2–12 Sep 2026 · setelan custom: nomor celana terlewat, tanya progres, ganti alamat, resi

**Ringkasan chat**
- CS kirim total "Jas, Celana 705.000 / Ongkir 19.000 / Total … = 724.000 bos" + kalimat rekening.
- Pelanggan: "Sudah" (sudah transfer) → CS: "Terimakasih bos, proses ya" → "Makasih" → "siap sama sama bos"
- **5 hari kemudian** CS: "pagi bos, mengkonfirmasi kembali untuk celana pakai No. berapa ya?" → Pelanggan: "31"
- Pelanggan: "Sudah jadi kah untuk jasnya ?" → CS: "iya sedang proses bos, insyaallah hari ini masuk proses finishing"
- Pelanggan: "Sudah dikirim pesanan saya ?" → **tidak dibalas ±1 hari**
- Pelanggan mengirim alamat baru: "… Kec. Benowo, 60198 · Ini alamatnya di format salah isi"
- Sehari kemudian CS hanya mengirim: "Pesanan sudah di kirim dengan No. Resi {resi} (JNE)". Perubahan alamat tidak ditanggapi.

**Sudah sesuai skill/sistem**
- Format total & kalimat rekening sama dengan pesan otomatis sistem.
- Skill sudah mewajibkan nomor celana ditanyakan **sebelum** form/total. Chat ini contoh nyata kenapa: nomor terlewat sampai 5 hari setelah bayar.

**Usulan perubahan / ide**
1. **Pengaman sebelum total.**
   - Setelan (Jas, Celana) dengan nomor celana belum diketahui → sistem jangan kirim total otomatis; AI tanya nomor celana dulu.
   - "Menyesuaikan" (contoh #1) dihitung sudah jelas.
2. **Setelah toko konfirmasi dana masuk, untuk pre-order/custom.**
   - Kalimat CS: "Terimakasih bos, proses ya". Pasangan dari contoh #2 ("siap kirim hari ini ya" untuk barang ready).
   - Cocok jadi pesan otomatis saat CS menekan konfirmasi dana.
3. **Tanya progres** ("sudah jadi?", "sudah sampai mana?").
   - Jawab dari status produksi order di aplikasi dengan gaya CS: "iya sedang proses bos, insyaallah {tahap/perkiraan}", misalnya "hari ini masuk proses finishing".
   - Status belum diisi → sebut perkiraan dari ESTIMASI PRODUKSI. Jangan mengarang tahap.
4. **Tanya "sudah dikirim?"**
   - Ada resi di order → kirim kalimat resi (contoh #2).
   - Belum ada → jawab status produksi + perkiraan siap kirim.
   - Jangan dibiarkan tanpa jawaban. Di chat ini pelanggan menunggu ±1 hari.
5. **Ganti alamat setelah bayar** ("alamatnya salah isi" + alamat baru).
   - Balas "siap bos, alamatnya saya ganti ya" dan perbarui alamat di order.
   - Langsung tandai CS (serah_cs) karena paket mungkin sudah dikemas atau dikirim.
   - Sudah ada resi → "paketnya sudah dikirim bos, saya cek dulu ke ekspedisi untuk ganti alamatnya ya".
   - Alamat baru tetap dicek ongkirnya. Beda kecamatan bisa beda ongkir; selisihnya CS yang memutuskan.

**Catatan lain**
- Pesan resi di chat ini tanpa "bos". Kalimat baku tetap mengikuti contoh #2.

---

## #5 · 7–10 Sep 2026 · kebijakan tukar size, rentang size, rekomendasi dari TB/BB, size chart jas & celana

**Ringkasan chat**
- CS mengirim kebijakan tukar size (kemungkinan pesan template):
  ```
  Hai bos! Kalau ukuran ternyata kurang pas, jangan khawatir! Kamu bisa tukar size dengan syarat-syarat berikut:

  •  Pengembalian maksimal 3 hari setelah barang sampai
  •  Barang belum terkena wewangian
  •  Barang belum dipakai
  •  Label masih utuh
  •  Ongkir ditanggung oleh customer

  Catatan: Tukar size tidak berlaku untuk pesanan custom ya! 😊✨
  ```
- Pelanggan: "Berarti sizenya ada apa aja diitung dri XL L M ya ka?" → CS: "ada size S- 3XL bos"
- Pelanggan: "Klo untuk bb dan tb saya / Size brp ya ka?" → CS: "Kalau lihat dari tinggi dan berat badan pakai size L cocok bos"
- Pelanggan: "Lokasi dmn ya ka" → CS: "Lokasi store di Cilacap bos"
- Pelanggan: "Boleh kirim ukuran” size Lnya kak? Biar saya ukur di badan saya apakah sesuai" → CS kirim gambar size chart: "seperti ini bos"
- Pelanggan: "Klo untuk celana?" lalu "oke sebentar ya" → CS: "Siap bos". **Pertanyaan ukuran celana tidak dijawab.**

**Sudah sesuai skill**
- Rekomendasi size dari tinggi/berat lalu disebut ("pakai size L cocok bos").
- Lokasi dari bagian TOKO ("Lokasi store di Cilacap bos").
- Ukuran per size dari SIZE CHART.

**Usulan perubahan**
1. **Kebijakan tukar size sebagai fakta toko.**
   - Ditanya **sebelum beli** ("kalau kekecilan bisa tukar?", "bisa retur?") → kirim teks kebijakan di atas persis.
   - Tukar size **setelah barang diterima** tetap serah_cs seperti sekarang. Boleh sambil menyebut syaratnya.
   - Perlu konfirmasi pemilik: apakah teks ini resmi, dan sebaiknya disimpan di Pengaturan → Data bisnis supaya mudah diubah.
2. **Rentang size.** Ditanya "size ada apa aja?" → jawab dari KATALOG dengan gaya CS: "ada size S - 3XL bos". Tabel perkiraan di skill baru sampai XXL; 3XL perlu ditambah dari SIZE CHART.
3. **Minta ukuran detail suatu size** ("kirim ukuran size L").
   - Kirim gambar size chart bila tersedia, dengan kalimat "seperti ini bos".
   - Tidak ada gambar → sebut angka dari SIZE CHART: lingkar dada, panjang, bahu, lengan.
4. **Ukuran celana** ("klo untuk celana?").
   - Wajib dijawab: lingkar pinggang & panjang per nomor dari SIZE CHART celana, atau kirim gambarnya.
   - Di chat ini pertanyaan celana terlewat karena pelanggan langsung menambah "oke sebentar ya".
5. **Pelanggan bilang "sebentar ya" (sedang mengukur).** Balas "Siap bos" saja, tapi jawab dulu pertanyaan yang belum terjawab di bubble yang sama. Contoh: ukuran celana + "siap bos, ditunggu ya".

**Catatan lain**
- Gambar size chart: periksa apakah AI sudah punya gambar ini (media CS / panduan bisnis). Kalau belum, pemilik perlu mengunggahnya agar AI bisa mengirimkannya.

## #6 · 3 Okt 2026 · form masuk saat CS membalas → total tidak dikirim (diterapkan v3.4.178)

**Yang terjadi**
- Pelanggan mengirim form order lalu bertanya DP; CS menjawab DP lebih dulu. Giliran AI yang berisi form ikut batal, jadi order tidak tercatat.
- Akibatnya AI tidak punya ONGKIR dan tidak bisa mengirim total: menebak "REG atau YES" (ke tujuan itu hanya REG), lalu "ini totalnya saya kirimkan" tanpa total yang datang. CS mengirim total manual.

**Perubahan**
1. Form order yang terlewat (12 jam terakhir, lebih baru dari order terakhir) diambil di giliran berikutnya: ongkir dicek, order tercatat, total + rekening dikirim otomatis. Dilewati bila toko sudah mengirim total/rekening setelah form.
2. Tanpa form order, janji "ini totalnya saya kirimkan" diganti: minta data pengiriman, atau "totalnya saya cek dulu" bila alamat sudah ada di chat.
3. Skill: jangan sebut REG/YES yang tidak ada di ONGKIR; satu layanan → langsung pakai; ongkir yang disebut CS dipakai apa adanya.

**Lanjutan (v3.4.179)**
4. Form terlewat yang totalnya sudah dikirim CS manual tetap dicatat sebagai order "menunggu pembayaran" dengan total dari CS, supaya bukti transfer tampil dan tombol konfirmasi pembayaran muncul.
5. Warna di spesifikasi mengikuti foto katalog yang ditunjukkan di chat: pelanggan mengirim gambar, AI membalas foto Bescap Cross Placket - Choco, tapi spesifikasi ditulis "Brown" (Brown dan Choco sama-sama ada di katalog). Kode sekarang mengganti warna yang tidak pernah difotokan dan tidak disebut pelanggan dengan warna foto terakhir produk itu.

---

## #7 · 4 Okt 2026 · jas hitam: sapaan, "seperti apa?", "mau custom bisa" (diterapkan v3.5.1)

**Ringkasan chat (uji pemilik)**
- "Halo" → AI: "Halo bos, ada yang bisa kami bantu" (pemilik: sudah bagus).
- "Jas hitam ada?" → "Ada bos, jas hitam mulai 485.000. Mau model Basic Suit, Tuxedo, atau Peak Suit?" (sudah benar).
- "Seperti apa ya?" → daftar terpotong ("Ini pilihan jas:" / "hitamnya bos" / …), mengulang harga, dan pertanyaan "Yang cocok yang mana bos?" terkirim sebelum foto.
- "Mau custkm bisa" → diserahkan ke CS tanpa balasan ("custom tanpa detail perlu konfirmasi produksi").

**Pelajaran**
1. Sapaan "Halo bos, ada yang bisa kami bantu" boleh (dikoreksi pemilik di v3.5.2); yang dilarang hanya menambahkannya saat pelanggan sudah bertanya.
2. "Seperti apa?" setelah model disebut → kirim foto model yang dibahas ("ini fotonya bos"), jangan mengulang daftar/harga. Pertanyaan lanjutan dikirim sesudah foto.
3. Custom bukan alasan serah CS: "Bisa bos, untuk custom nanti di sesuaikan ukuran ya" → "Mau custom ukurannya atau ada detail model yang mau diubah bos?". Tetap ke CS bila menyangkut warna/bahan di luar katalog, diskon/seragam, atau tanggal kirim.

---

## #8 · 5 Okt 2026 · setelan Basic Suit, ongkir per desa, alamat tanpa label (diterapkan v3.5.7)

**Ringkasan chat (uji pemilik)**
- Jas hitam → foto model → "yang ini sama celana" 705.000 → size dari TB/BB (S, celana 30) → ukuran per size (sudah benar).
- "Ke cinyawang" → ongkir tampil "Ongkir ke tujuan" dan "YES (1-1 hari)".
- "Reg aja" → AI malah menanyakan kecamatan & kabupaten lagi (sistem mengira "reg" nama tempat).
- Pelanggan mengirim nama + alamat tanpa label ("…, cinyawang patimuan cilacap 53264") + HP → "ongkir dan totalnya saya kabari" — total tidak terkirim karena kecamatan/kabupaten tidak terbaca.

**Pelajaran**
1. Ongkir selalu menyebut kecamatan & kota tujuan; estimasi "1 hari", bukan "1-1 hari".
2. Jawaban memilih layanan (REG/YES) bukan alamat baru — lanjut minta data pengiriman.
3. Alamat tanpa label tetap dipakai: tujuan yang sudah dicek di chat, atau dicari dari kode pos, lalu total + rekening dikirim.

---

## #9 · 5 Okt 2026 · foto produk broken white dikenali "White" (diterapkan v3.5.8)

**Masalah:** pelanggan mengirim foto produk broken white, AI menyebutnya White.

**Pelajaran**
1. Warna putih bersih, broken white, dan krem tidak bisa diandalkan dari mata model. Sistem mengukur warna badan pakaian dari piksel dan membandingkannya dengan foto katalog.
2. Jev memilih warna katalog dari hasil ukur + kata pelanggan; bila ragu, warna terdekat yang selisihnya jelas; selain itu AI diberi kandidatnya.
3. Harga mengikuti produk yang benar-benar punya warna itu (mis. Broken White di seri Signature).
4. (v3.5.9) Screenshot postingan IG yang sama sempat terbaca "cream": jas di foto redup (lebih gelap dari dinding) dan ukuran lama mengambil bagian dinding/manekin. Sekarang area foto dipisah dari bar aplikasi, dinding & manekin dibuang, warna dikoreksi terhadap dinding dan terang foto → terbaca broken white.

---

## #10 · 6 Okt 2026 · harga setelan & celana premium (diterapkan v3.5.12)

**Ringkasan chat (uji pemilik)**
- Premium dibahas → "Set berapa ya" → AI: "setelan premium 685.000" (itu harga jas premium; setelan premium 955.000).
- "Itu jas saja atau sama celana" → AI: "celana mulai 220.000" (itu celana reguler; celana premium 270.000).
- "Bahannya sama kan?" → jawaban mengambang.

**Pelajaran**
1. Harga mengikuti SERI bahan: reguler / signature / premium. Setelan = harga produk setelan seri itu, bukan harga jas.
2. Pola harga dihitung sistem dari katalog dan dipakai AI + pemeriksa harga (angka salah seri dibetulkan otomatis).
3. "Bahannya sama?" dijawab tegas dengan nama bahan seri itu.

---

## #11 · 6 Okt 2026 · daftar model, "premium seperti apa", susulan tidak muncul (diterapkan v3.5.13)

**Ringkasan chat (uji pemilik)**
- "Ada model apa aja" → dibuka "Ada bos," (tidak pas untuk pertanyaan "apa aja").
- "Yang premium seperti apa" → kalimat panjang berisi nama produk, warna, kerah, kancing, padahal foto sudah dikirim dengan caption.
- "Kalo set berapa" → 955.000 (sudah benar sejak v3.5.12).
- Susulan tidak muncul setelah percakapan berhenti.

**Pelajaran**
1. "Ada bos" hanya untuk menjawab "ada X?". Pertanyaan "apa aja / seperti apa / berapa" langsung dijawab.
2. Kirim foto → pengantar cukup "Ini fotonya bos" (+ harga sekali); ciri model hanya bila ditanya bedanya.
3. Susulan dijadwalkan setiap kali AI menulisnya (kecuali selesai/serah CS), termasuk saat pelanggan masih tanya-tanya.
4. Semua ulasan diputar ulang otomatis di `tests/unit/review_chats.spec.ts` supaya perbaikan baru tidak merusak ulasan lama.

## #12 · Okt 2026 · model murah dipakai hampir terus (diterapkan v3.5.14)

**Laporan pemilik**
- Token Jev ±2.700 per giliran; prompt Claude 12–15 ribu (kadang 21 ribu).
- Balasan hampir selalu memakai model murah, bukan sesuai kapasitas yang diputuskan Jev.

**Penyebab**
- Skor Jev dimulai dari 0 (tiga tingkat = 0 … 2). Sistem membacanya mulai 1, jadi "Biasa" terbaca
  "Sederhana" (model ringan) dan "Rumit" terbaca "Biasa" (standar). Model berat tidak pernah dipilih.
- Skor urgensi juga bergeser satu tingkat: "Mendesak" tidak memunculkan badge "Penting".

**Pelajaran**
1. Skor Jev selalu lewat `scoreLevel` (0 → tingkat 1), jangan dibulatkan langsung.
2. Model ringan hanya untuk salam/tanda terima dan pertanyaan sederhana tanpa ongkir, catatan sistem, custom, atau pembayaran.
3. Trace balasan menampilkan "Tingkat model: … · alasan" supaya pilihan model bisa dicek.
4. Jev cukup 6 baris percakapan terakhir; data lain hanya dikirim bila pertanyaannya ditanyakan.

## #13 · Okt 2026 · "oke" sesudah harga setelan tanpa susulan (diterapkan v3.5.15–16)

**Ringkasan chat (uji pemilik)**
- "Harga jas berapa" → harga per seri (benar).
- "Seperti apa" → daftar 5 model berharga, tanpa foto.
- "Premium seperti apa gan" → "Ini model premiumnya bos, harganya 685.000" + 3 foto + pertanyaan (benar).
- "Set berapa ya" → "685.000 + 270.000 jadi 955.000" (angka benar, rinciannya tidak perlu).
- "Oke" → tidak dibalas dan tidak ada susulan; chat berhenti tanpa order.

**Pelajaran**
1. Goal chat = pembelian. Selama belum order/bayar, AI menulis susulan yang nyambung dengan produk/harga yang barusan dibahas, mengajak satu langkah menuju order. Susulan selalu dari AI (v3.5.16): kalimat bawaan tanpa token (v3.5.15) dihapus karena kehilangan konteks.
2. "Oke" tanda terima yang tidak dibalas tetap disusul (dulu susulan dibatalkan karena pesan terakhir milik pelanggan).
3. Susulan kosong bila pelanggan menunda/membatalkan, pesanan selesai, atau diserahkan ke CS.
4. "Seperti apa?" tanpa field foto → sistem mengirim foto produk yang disebut (maks 3), pengantar "Ini fotonya bos, mulai 485.000".
5. Harga setelan disebut langsung ("Setelan premium 955.000 bos, sudah jas + celana"), tanpa penjumlahan.

## #14 · Okt 2026 · jawaban terasa kurang tepat & kurang cerdas (diterapkan v3.5.17)

**Laporan pemilik**
- Pola jawaban sejak v3.5.14–16 terasa kurang tepat; v3.5.11 lebih stabil.

**Hasil tinjauan ulang**
1. Konteks Jev yang dipotong (6 baris × 300 huruf) membuat Jev lebih sering ragu → model murah terpilih lagi. Dikembalikan ke 10 × 500.
2. Model termurah kini hanya untuk salam/tanda terima. Pertanyaan apa pun (produk, harga, size, order) minimal model standar; rumit/komplain → berat.
3. Foto otomatis saat "seperti apa" dihapus: daftar model berharga beda sempat diganti "Ini fotonya bos, mulai 485.000" dan hanya 3 foto — informasi hilang. Pengantar singkat hanya bila harganya satu.
4. Aturan "harga setelan tanpa penjumlahan" dihapus (jawaban "685.000 + 270.000 jadi 955.000" jelas dan tidak dikeluhkan).

**Pelajaran**
- Hemat token tidak boleh memotong konteks keputusan (Jev maupun AI).
- Jangan menambah perapian otomatis yang membuang isi jawaban; perapian hanya merapikan bentuk.
- Perubahan yang tidak diminta pemilik tidak dimasukkan ke rilis perbaikan ulasan.

## #15 · Okt 2026 · perbandingan v3.5.7 (akurat) vs v3.5.17 (diterapkan v3.5.18)

**Temuan**
- v3.5.7 akurat terutama karena pola kata mengirim pesan serius (ukuran, custom, ongkir, transfer, catatan sistem) ke model paling kuat; sejak v3.5.11 Jev menggantikannya dan hampir semua turun ke standar.
- Topik Jev bisa membuang bagian prompt (size chart, ongkir, pembayaran) bila Jev salah menilai.
- Catatan harga dari tebakan seri Jev bisa memaksa angka yang salah bila seri keliru.
- "Oke" tidak dibalas sama sekali sejak v3.5.11 — chat terasa putus.

**Perubahan**
1. Tingkat model: dasar = aturan pola kata v3.5.7; Jev hanya boleh menaikkan (rumit/komplain → berat), tidak pernah menurunkan (`model_tier.ts`).
2. Topik Jev hanya menambah bagian prompt; pola kata tetap berlaku.
3. Catatan harga dipakai hanya bila seri dari Jev cocok dengan seri yang disebut di chat (teks lebih dipercaya).
4. "Oke" dibalas satu kalimat singkat oleh AI lagi, dengan susulan langkah berikutnya.

**Pelajaran**
- Jev untuk menambah sinyal, bukan menggantikan aturan yang sudah terbukti.
- Biaya model boleh naik; akurasi jawaban yang diutamakan pemilik.

## #16 · Okt 2026 · "bedanya apa" dijawab 5 model + "Ini contoh fotonya", foto tidak lengkap (diterapkan v3.5.19)

**Laporan pemilik**
- AI membandingkan Basic Suit, Tuxedo, Bescap, Peak Suit, Premium Basic Suit lalu bilang "Ini contoh fotonya", tapi tidak semua model itu dikirim fotonya.

**Penyebab**
- Field `foto` dibatasi 3 dan AI tidak diminta melengkapi semua model yang disebut.

**Perubahan**
1. Batas `foto` 3 → 5 (kiriman maks 6). Skill: menyebut/membandingkan beberapa model + "ini fotonya" → semua model itu harus ada fotonya.
2. Sistem melengkapi (`completePhotos`): bila balasan menjanjikan foto atau pelanggan minta lihat, produk yang disebut tapi belum ada di `foto` ditambahkan — urut sesuai sebutan, warna yang disebut dipilih, "Basic Suit" ≠ "Premium Basic Suit". Teks balasan tidak diubah. Trace: "Foto dilengkapi · …".

**Pelajaran**
- Janji di teks ("ini fotonya") harus ditepati sistem: yang disebut, itu yang dikirim.


## #17 · Okt 2026 · pesan jas+celana+rompi, total hanya jas; ongkir tidak dihitung ulang (diterapkan v3.6.29)

**Laporan pemilik (chat Retno)**
- Pelanggan lama kirim referensi full look; CS sebelumnya sudah membahas "bagian bawah". AI menanyakan celana ("menyesuaikan, karet"), lalu mengirim total **jas saja** 485.000 + ongkir 18.000.
- Pelanggan: "Lah ini jasnya tok? Celananya? Sama ini ada rompinya ga sii" → AI menyebut harga jas+celana 705.000 / +rompi 880.000, janji "ongkir saya cek ulang dulu" — tidak pernah ditepati; CS yang menghitung 2 kg = 2 × 18.000 → 916.000.
- "Totalnya saya hitung dulu ya bos" dikirim dua kali karena pelanggan menjawab "Iyaa mas"/"Oke".
- Pesan rekening pertama gagal terkirim (!), CS kirim ulang manual.

**Penyebab**
1. Total otomatis dihitung persis dari rincian AI; tidak ada pengecekan bahwa spesifikasi/chat menyebut celana & rompi yang tidak ada di rincian.
2. AI hanya membaca 20 pesan terakhir; pembahasan item oleh CS sudah di luar jendela, catatan chat tidak mencatat "jas+celana".
3. Tarif ongkir disimpan di order saat berat 1 kg; setelah item bertambah (berat 2 kg) tarif lama tetap dipakai dan tidak pernah diambil ulang. Order yang sudah terkirim totalnya (menunggu pembayaran) tidak bisa dihitung ulang sistem.
4. Janji tunggu tidak dicek terhadap pesan sebelumnya.
5. Pengiriman gagal langsung ditandai "!" tanpa coba ulang dan tanpa alasan.

**Perubahan**
1. `partsMissingFromItems`: bagian yang disebut di spesifikasi atau pesan pelanggan (celana, rompi — "gak usah rompi" dikecualikan) tapi tidak ada di rincian → total ditahan, AI bertanya "mau jas saja atau sekalian celana dan rompinya bos? biar totalnya pas". Produk "Setelan …" dihitung sudah memuat celana.
2. Saat ada order pending/menunggu pembayaran, riwayat yang dibaca AI 60 pesan (bukan 20); catatan chat wajib menulis bagian yang dipesan; rincian order wajib memuat semua bagian.
3. Berat pesanan dari spesifikasi terbaru dibandingkan dengan tarif tersimpan (`shipping_options.grams`); beda → tarif diambil ulang sebelum total dihitung. Order menunggu pembayaran yang belum dibayar dan itemnya berubah (bagian bertambah/berkurang) dibuka lagi (`reopenLeanOrderForChange`) dan total baru dikirim otomatis — nomor order tetap.
4. `dropRepeatedWait`: pesan sebelumnya sudah berjanji "saya hitung/cek dulu" dan pelanggan hanya mengiyakan → janji tidak diulang; bila tidak ada kalimat lain, AI diam.
5. Pengiriman gagal dicoba ulang sampai 3× (`send_attempts`), alasannya disimpan (`send_error`) dan tampil saat kursor di tanda "!".

**Pelajaran**
- Total resmi harus mencerminkan seluruh yang dibahas, bukan baris terakhir yang diisi AI: sistem mencocokkan bagian (celana/rompi) sebelum mengirim.
- Janji "saya cek ulang" harus punya mekanisme di sistem; kalau tidak ada, jangan dijanjikan.

## #18 · Okt 2026 · total CS di chat tidak tercatat; foto jas dianggap bukti transfer (diterapkan v3.6.30)

**Laporan pemilik**
- Setelah sistem terlanjur mengirim total (jas saja), CS mengirim total yang benar (916.000) di chat — order tetap 503.000 dengan item jas saja; saat dana masuk, ditandai lunas dengan angka lama.
- Pelanggan mengirim **foto jas** sesudah rekening → aplikasi menampilkan "pembayaran masuk/perlu konfirmasi", padahal belum bayar. Pemilik: "bukan berarti gambar setelah rekening pasti bukti transfer — belum tentu; semuanya dinamis, perlu Jev."

**Penyebab**
1. Total dari pesan CS hanya dibaca AI pada giliran berikutnya, dan hanya diterapkan bila order masih "pending" (belum ada total). Rincian item tidak pernah diambil dari pesan CS.
2. Penanda "Pembayaran" di kotak masuk untuk order menunggu pembayaran menghitung **setiap gambar** pelanggan sesudah total sebagai bukti — tanpa melihat isinya. Ditambah aturan "tahap bukti_dikirim → semua gambar giliran itu bukti" dan tebakan "gambar ≤48 jam setelah rekening = bukti".

**Perubahan**
1. `parseCsTotalMessage` + `applyCsTotalMessage` (listener, saat pesan CS terkirim): pesan CS berformat total (item + harga, ongkir, "total … = …", format baris atau satu baris) langsung memperbarui order — rincian item, subtotal, ongkir, total, catatan "total dikirim CS di chat" — untuk order pending maupun menunggu pembayaran yang belum ada dana masuk. Ongkir tidak disebut → ongkir order yang ada dipakai.
2. Bukti pembayaran dinilai dari **isi gambar**: setiap gambar pelanggan yang filenya siap dipilah AI di latar (`screenIncomingImage`: jenis bukti/model/ukuran/lain + keterangan), lalu Jev (`bukti_transfer`, ambang 0,9) menilai dari keterangan + teks pelanggan + status order. Hasil ini menang atas tebakan giliran AI. Berlaku di mode AI maupun CS.
3. Penanda "Pembayaran" (kotak masuk, panel room, pelunasan DP) hanya untuk gambar berjenis "bukti" atau yang belum/gagal dipilah; aturan "tahap bukti_dikirim → semua gambar" dan tebakan waktu dihapus. Caption pelanggan yang tegas ("ini bukti tf") tetap dihitung sampai pemilahan selesai.

**Pelajaran**
- Keputusan "ini bukti bayar?" harus dari isi gambar + konteks, bukan dari urutan pesan. Vision memberi keterangan, Jev memutuskan — pola yang sama bisa dipakai untuk keputusan dinamis lain.

## #19 · Okt 2026 · order Retno: total 503.000 padahal dana 916.000; ambil/antar dikonfirmasi CS di chat (diterapkan v3.6.32)

**Laporan pemilik**
- Order #PO-20261005-018: item sudah benar (jas+celana+rompi), tapi total tersimpan 485.000 + 18.000 = 503.000 (total otomatis jas saja), ongkir tarif 1 kg; dana 916.000 dikonfirmasi CS → status lunas dengan angka yang tidak cocok.
- Pesanan yang diambil/diantar dan dibayar di toko tetap ada di chat, tapi biasanya hanya berupa konfirmasi singkat dari CS ("pesanan sudah di antar ya", "sudah masuk, proses ya") — pelanggan sering tidak membalas lagi.

**Penyebab**
1. Total CS dikirim sebelum v3.6.30 (tidak berlaku surut); konfirmasi dana tidak mencocokkan nominal dengan total.
2. Konfirmasi dana dari CS hanya dibaca pada giliran AI (menunggu pesan pelanggan berikutnya).
3. Tarif lama menyimpan berat sebagai `weight_grams`, pengecekan berat v3.6.29 membaca `grams`.

**Perubahan**
1. `adoptCsTotal`: saat dana dikonfirmasi (tombol, nominal manual, atau chat) dan nominalnya ≠ total tersimpan, pesan total CS sesudah order dibuat yang nominalnya sama diadopsi (item, subtotal, ongkir, total). `reconcileCsTotals` menjalankan ini sekali per proses untuk order 90 hari terakhir (perbaikan data lama, termasuk Retno → 880.000 + 36.000 = 916.000).
2. `applyCsPaymentConfirm` (listener, saat pesan CS terkirim): kalimat konfirmasi dana + Jev `dana_masuk` yakin → order menunggu pembayaran dicatat lunas saat itu juga. Tanpa Jev tidak otomatis (keputusan uang).
3. Antar/ambil: kata "diambil di store", "datang ke toko/store", "sudah diterima" ikut dikenali (v3.6.31 sudah: diantar, diambil, kurir toko).
4. Berat tarif dibaca dari `grams` atau `weight_grams`.

## #20 · Okt 2026 · pelanggan yang pesanannya diantar ditandai vendor (diterapkan v3.6.33)

**Laporan pemilik:** chat Mauldy — pelanggan yang pesanannya diantar tim — bertanda VENDOR (AI ikut berhenti membalas).

**Penyebab:** penilaian peran (Jev `peran_kontak`, v3.6.31) hanya melihat 14 pesan terakhir; percakapan antar/alamat/"sudah diterima" mirip urusan dengan pemasok, dan riwayat transaksi pelanggan tidak dipertimbangkan.

**Perubahan**
1. Bukti transaksi menang: kontak yang punya order (tidak batal), pengiriman (resi atau diantar tim), atau bukti bayar tidak pernah ditandai vendor/lainnya otomatis (`hasCustomerHistory`).
2. Jev: ambang 0,95; instruksi menyebut pesanan diantar/diambil/alamat/"sudah diterima" = pelanggan, ragu = pelanggan.
3. Perbaikan sekali jalan (`repairAutoRoles`, saat kotak masuk dibuka): peran otomatis vendor/lainnya yang punya riwayat pelanggan → pelanggan; yang tanpa riwayat ditanyakan ulang ke Jev dengan instruksi baru, tetap vendor hanya bila Jev yakin. Pengecualian AI yang dibuat oleh penandaan otomatis ikut dicabut (mode CS, AI bisa diaktifkan lagi). Peran yang diatur manual CS tidak disentuh.
4. Pemindai pengiriman melewati chat vendor/lainnya ("kain sudah diterima" bukan pengiriman pesanan).

## #21 · Okt 2026 · halaman Order: Mauldi diantar tim belum Selesai; pembelian bahan ke vendor tampil sebagai order (diterapkan v3.6.34)

**Laporan pemilik:** di halaman Order, order Mauldi (diantar tim) belum masuk Selesai, dan "Pesen bahan Scuro 509 2pcs / Scuro 522 2pcs" (CS memesan bahan ke vendor Rozikin) tampil sebagai order lunas.

**Penyebab**
1. Mauldi: pesan CS "pesanan sudah **ta** antar ya" (bahasa Jawa) tidak cocok pola; lagi pula pesan itu (25 Sep) sudah dilewati pemindai sebelum pengenalan antar-sendiri ada (v3.6.31).
2. Rozikin: "Rekap dari chat" membuat order dari chat vendor; halaman Order tidak membedakan peran kontak.

**Perubahan**
1. Pola antar-sendiri + "ta/tak antar/anter", "sudah antar"; pindai ulang sekali (`rescanSelfDeliveries`, 120 hari, hanya chat yang punya order dan bukan vendor).
2. Order dari chat vendor/lainnya hanya tampil di tab baru **Vendor** (badge "Pembelian bahan", tanpa tombol order pelanggan), tidak dihitung di tab lain, tidak dikirim ke grup produksi, tidak dibuat oleh Rekap dari chat, dan chat vendor tidak bertanda order di kotak masuk.
3. Perbaikan data sekali per proses berjalan berurutan (total CS → peran vendor keliru → antar-sendiri lama) saat kotak masuk atau halaman Order dibuka pertama kali.

## #22 · Okt 2026 · uji pemilik: total salah (jas saja), rekening terkirim dua kali, "Ongkir CTC" (diterapkan v3.6.41)

**Percakapan uji:** pelanggan kirim foto Tuxedo Double Breasted maroon (AI: pre-order 535.000), minta sekalian celana (AI: 755.000), size S/31, celana panjang 102, REG ke Patimuan, form tanpa No. telp.

**Yang salah**
1. Total otomatis "Tuxedo Double Breasted - Maroon … Total 485.000 + 9.000" — harga produk lain ("Tuxedo - Maroon") dan celana tidak dihitung.
2. Pesan rekening masuk dua kali (sekali "AI", sekali "CS").
3. Baris ongkir "CTC 9.000" padahal pelanggan memilih REG.
4. AI menanyakan No. telp sementara total & rekening dikirim bersamaan.

**Penyebab**
1. Rincian dari spesifikasi dicocokkan longgar: baris berisi "tuxedo" + "maroon" jatuh ke produk "Tuxedo" warna Maroon. Pemeriksaan celana/rompi memakai seluruh rincian, dan baris detail "Jas, Celana" dianggap sudah mencakup celana.
2. Balapan pengiriman: salinan pesan dari WhatsApp tercatat sebagai "owner" sebelum pesan antrean diberi id-nya → pencatatan gagal (id kembar) → dianggap gagal kirim → dikirim ulang (fitur kirim ulang v3.6.29).
3. Kode JNE dalam kota (CTC) ditulis apa adanya.
4. Form tanpa No. telp.

**Perubahan**
1. Produk dengan nama terpanjang yang cocok menentukan baris; warna yang tidak ada di produk itu = di luar katalog (total ditahan, bukan memakai produk lain). Bagian celana/rompi dicek pada baris berharga saja; bagian yang sudah dipilih pelanggan tidak ditanyakan ulang ("mau jas saja?"), total ditahan untuk dihitung.
2. Setelah WhatsApp mengonfirmasi terkirim, pesan tidak pernah dikirim ulang; salinan "owner" ber-id sama dilebur. Percobaan ulang lebih dulu memeriksa salinan "owner" dengan isi sama (sudah terkirim → tidak dikirim lagi).
3. Total menampilkan REG/YES/JTR untuk CTC/CTCYES/CTCJTR.
4. No. telp kosong → nomor WhatsApp chat itu dipakai, AI diberi tahu untuk tidak menanyakannya.
