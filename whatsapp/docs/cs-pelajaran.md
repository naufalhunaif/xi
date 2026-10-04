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
- "Halo" → AI: "Halo bos, ada yang bisa kami bantu" (dilarang skill).
- "Jas hitam ada?" → "Ada bos, jas hitam mulai 485.000. Mau model Basic Suit, Tuxedo, atau Peak Suit?" (sudah benar).
- "Seperti apa ya?" → daftar terpotong ("Ini pilihan jas:" / "hitamnya bos" / …), mengulang harga, dan pertanyaan "Yang cocok yang mana bos?" terkirim sebelum foto.
- "Mau custkm bisa" → diserahkan ke CS tanpa balasan ("custom tanpa detail perlu konfirmasi produksi").

**Pelajaran**
1. Sapaan cukup "Halo bos" — kalimat "ada yang bisa kami bantu" dibuang sistem.
2. "Seperti apa?" setelah model disebut → kirim foto model yang dibahas ("ini fotonya bos"), jangan mengulang daftar/harga. Pertanyaan lanjutan dikirim sesudah foto.
3. Custom bukan alasan serah CS: "Bisa bos, untuk custom nanti di sesuaikan ukuran ya" → "Mau custom ukurannya atau ada detail model yang mau diubah bos?". Tetap ke CS bila menyangkut warna/bahan di luar katalog, diskon/seragam, atau tanggal kirim.

