# Perilaku yang sudah settle (jangan sampai rusak lagi)

Daftar ini dibaca **sebelum** mengubah fitur yang bersinggungan, dan dicek **sebelum** rilis.
Setiap baris punya tes; kalau tes gagal, berarti ada perilaku lama yang rusak.

## Aturan kerja

0. **Ulasan chat pemilik** diputar ulang di `tests/unit/review_chats.spec.ts` lewat jalur yang sama dengan balasan asli (`reply_polish`). Ulasan baru = kasus baru di file itu, di commit yang sama dengan perbaikannya.

1. **Sebelum mengubah**: cari bagian terkait di daftar ini. Perubahan yang menyentuh bagian itu
   harus tetap memenuhi semua barisnya.
2. **Bug diperbaiki** → tambah tes yang menangkap bug itu + satu baris di daftar ini (commit yang sama).
3. **Perilaku sengaja diubah** (diminta pemilik) → ubah tes dan baris di daftar ini di commit yang sama.
   Jangan menghapus/melonggarkan tes hanya supaya lulus.
4. **Sebelum rilis** (wajib, di salinan Linux dengan MariaDB menyala):
   - `npx tsc --noEmit` bersih.
   - `node ace test unit` → **semua lulus** (tidak ada "gagal yang sudah biasa").
   - Ada perubahan tampilan: cek Playwright 1440 px & 390 px.
   - **Tidak boleh dilewati**, sekecil apa pun perubahannya (termasuk file tes): v3.6.53 gagal dibangun di server karena cek tipe dilewati. Rencana pengaman otomatis (gerbang rilis, laporan harian perilaku AI, cek kesehatan + rollback setelah update, satu aturan satu tempat, peta keterkaitan) belum dikerjakan.
5. Tes yang butuh database ada di `tests/unit/beta3_flow.spec.ts`; tes lain murni (tanpa jaringan).

## Beta 3 — order & total

| Perilaku | Tes |
|---|---|
| Form order (berlabel atau alamat tempelan) dibaca jadi order; ongkir dicek dari kecamatan + kota | `beta3.spec` · form order |
| Total + rekening dikirim otomatis hanya bila rincian cocok KATALOG dan subtotal benar | `beta3.spec` · total otomatis |
| Lebih dari satu layanan ongkir → harus dipilih pelanggan, AI tidak memilihkan | `beta3.spec` · total otomatis |
| Ongkir menyebut kecamatan & kota ("Ongkir ke Patimuan, Cilacap"), estimasi "1-1 hari" ditulis "1 hari" | `beta3.spec` · review chat ongkir cinyawang |
| Memilih layanan ("reg aja", "yang yes") bukan nama tempat: tujuan tetap, tidak ditanya kecamatan lagi | `beta3.spec` · review chat ongkir cinyawang |
| Alamat tempelan tanpa label kecamatan/kabupaten: ongkir dari tujuan yang tadi dicek di chat, atau dicari dari kode pos → total tetap terkirim | `beta3.spec` · review chat ongkir cinyawang (+ cek manual) |
| Hanya satu layanan (JTR tidak ditawarkan untuk < 8 kg) → langsung dipakai, tidak ditanya | `beta3.spec` · ongkir ditulis ringkas |
| Setelan tanpa nomor celana → total ditahan, tanya "celana menyesuaikan kah atau pakai No. berapa" | `beta3.spec` · pelajaran chat CS |
| Form yang terkirim saat CS membalas tetap diproses di giliran berikutnya (sekali saja) | `beta3_flow.spec` · form terlewat |
| Form terlewat + CS sudah kirim total manual → order tercatat "menunggu pembayaran" dengan total CS, bukti transfer tampil, tombol konfirmasi muncul; total tidak dikirim ulang | `beta3_flow.spec` · total CS |
| "Dana masuk" saat menunggu bayar = nominal yang dibaca dari bukti transfer; belum terbaca → kosong + "Cek nominal di bukti transfer", tidak pernah otomatis = total (DP 400 ribu tidak jadi lunas) | `beta3_flow.spec` · panel room (+ cek Playwright `beta3_pay.js`) |
| Bukti transfer tampil di panel walau order tercatat belakangan; gambar yang gagal dimuat tetap ditandai "Gambar belum terunduh" | `beta3_flow.spec` · panel room |
| Pesan toko berisi total/rekening dikenali; janji AI ("ini totalnya saya kirimkan") tidak dianggap total | `beta3.spec` · form terlewat |
| Tanpa form order, AI tidak menjanjikan total; minta data pengiriman / "saya cek dulu" | `beta3.spec` · janji total tanpa order |
| Pesan grup produksi: tanpa harga, alamat, telepon; ditutup nama + nomor order | `beta3.spec` · pesan grup produksi |
| Data pesanan (panel, halaman Order, grup): judul "Produk - Warna" + "Jas, Celana", detail diberi "- ", ukuran celana dipisah satu baris kosong dari jas; ringkasan satu baris di daftar Order tanpa "- " | `beta3.spec` · data pesanan rapi |

## Beta 3 — isi balasan

| Perilaku | Tes |
|---|---|
| Warna di spesifikasi & balasan = warna KATALOG yang difotokan di chat (foto Choco tidak ditulis "Brown"), kecuali pelanggan menyebut warnanya sendiri; warna di luar katalog (custom, mis. "Broken White") tidak diganti | `beta3_flow.spec` · warna spesifikasi |
| Daftar model dalam satu kalimat dirapikan tanpa memotong pembuka ("Ini pilihan jas hitamnya bos, masing-masing 485.000:" lalu satu model per baris) | `beta3.spec` · review chat jas hitam |
| Ada foto: urutan jawaban → foto → pertanyaan (pertanyaan di ujung bubble dipisah) | `beta3.spec` · review chat jas hitam |
| "Mau custom bisa?" dijawab sendiri ("Bisa bos, untuk custom nanti di sesuaikan ukuran ya" + tanya custom apa), tidak diserahkan ke CS; custom + warna/bahan/diskon tetap ke CS | `beta3.spec` · review chat jas hitam |
| Warna produk di gambar pelanggan diukur dari piksel dan dibandingkan dengan foto katalog (putih bersih ≠ broken white ≠ krem); screenshot (bar aplikasi gelap), latar dinding, manekin, dan foto redup tidak mengacaukan hasil (contoh asli: `tests/fixtures/ig_broken_white.jpg`); Jev memilih warnanya bila yakin, selain itu warna terdekat yang jelas | `beta3.spec` · warna dari piksel, `jev.spec` · warna gambar |
| Pola harga per seri (reguler/signature/premium × jas/celana/setelan/rompi, Double Breasted, XXL+) dihitung dari katalog dan selalu ikut prompt; "setelan premium 685.000" dibetulkan jadi 955.000, celana premium 270.000; kalimat perbandingan tidak diubah | `beta3.spec` · pola harga per seri, `jev.spec` · seri & barang |
| "Ada bos," hanya untuk "ada X?"; pertanyaan "apa aja / seperti apa / berapa" dijawab langsung | `review_chats.spec` · #10/#11 |
| "Seperti apa?" + foto → pengantar "Ini fotonya bos" (+ harga sekali), nama produk/warna cukup di caption foto | `review_chats.spec` · #7, #11 |
| Pemeriksa harga tidak mengubah daftar harga (≥ 2 baris) dan angka yang memang harga produk yang disebut ("Basic Suit 485.000" di konteks premium) | `review_chats.spec` · #10 |
| Susulan tetap terjadwal bila AI menulisnya walau tahap "lain"; tahap mirip ("tanya_harga") dipetakan; "oke" tanda terima tidak menghapus susulan yang sudah direncanakan | `review_chats.spec` · #11 |
| Tingkat model: dasar pola kata v3.5.7 (`autoTier`), Jev hanya menaikkan (rumit/komplain → berat), skor Jev mulai 0 (`scoreLevel`); alasan di trace "Tingkat model" | `review_chats.spec` · #12/#14, `beta3.spec` · model otomatis, `jev.spec` · skor Jev mulai 0 |
| Susulan selalu dari AI (tanpa kalimat bawaan); "oke" yang tidak dibalas tetap mengirim susulan AI yang sudah direncanakan | `beta3_flow.spec` · susulan menuju pembelian |
| "Ini fotonya" / minta lihat + beberapa model disebut → semua model yang disebut dikirim fotonya (`completePhotos`, maks 6; teks tidak diubah) | `review_chats.spec` · #16 |
| Daftar model dengan harga berbeda tidak diringkas jadi "Ini fotonya"; pengantar singkat hanya bila harganya satu | `review_chats.spec` · #13 |
| Catatan harga dari seri Jev hanya bila cocok dengan seri yang disebut di chat; teks chat lebih dipercaya | `beta3.spec` · pola harga |
| Jev menerima konteks penuh (10 baris × 500 huruf, layanan & pesan toko terakhir) — tidak dipotong demi token | `jev.spec` · skor Jev mulai 0 |
| Kebijakan tukar size dari Pengaturan masuk prompt; v3.6.55 (diminta pemilik): syaratnya ditulis ulang gaya CS (tidak disalin persis); custom tidak bisa tukar; refund → tanya tim (tetap dibalas) | `beta3.spec` · pelajaran chat CS, `random_questions.spec` |
| v3.6.55: diserahkan ke CS tetap dibalas singkat (balasan AI; kosong → balasan cadangan); ditahan pemeriksa harga → bubble tanpa harga tak dikenal tetap terkirim. WhatsApp & Instagram memakai satu aturan (`bubblesToSend`) | `random_questions.spec` |
| v3.6.63: penjaga Hati CS — kalimat sama di 10 pesan keluar terakhir dibuang (kecuali angka/salam/daftar/seluruhnya ulangan); kesal/pamit → tanpa susulan & tawaran; keberatan harga → tanpa susulan; ucapan "selamat" sekali; bertanya dijawab "dicatat" ditandai | `hati.spec` · penjaga |
| v3.6.62: Jev (panggilan yang sama) membaca bentuk/rasa/momen → CATATAN HATI hanya bila yakin & tidak netral; ucapan momen tidak diulang; bisa dimatikan (keputusan `hati`); dijelaskan di Jev accuracy | `hati.spec` · Jev |
| v3.6.61: skill inti "Hati CS" menggantikan "Rasa" — 4 lapis berurutan (pikiran → rasa → jiwa → tindakan) + contoh Agus/Nofita; aturan pindahan dari "Cara bicara" tidak dobel; ringkasan lengkap; prompt penuh < 10 ribu token | `hati.spec`, `skill_digest.spec`, `beta3.spec` · token |
| v3.6.60: grosir mulai 6 jas (setelan = jas): jas/setelan/celana/rompi dipotong per pcs dari website, total otomatis dengan baris "Diskon grosir"; subtotal AI sebelum/sesudah potongan diterima; < 6 jas / celana-rompi saja tanpa potongan; `grosir: ya` tanpa potongan → dicek toko. Jumlah pcs: "6 pcs", "x6", "3 stel" | `wholesale.spec` |
| v3.6.59: skill inti punya bagian "Rasa" (bertanya ≠ meminta, tanpa kalimat berulang, saran gaya + alasan, pamit/kemahalan hangat tanpa susulan); "Siap sama sama bos" hanya untuk terima kasih; Jev: kemahalan = menunda. Prompt penuh tetap < 10 ribu token | `hati.spec` (dulu rasa.spec), `skill_digest.spec`, `beta3.spec` · token |
| v3.6.58: foto — jawaban berisi saran tidak diringkas jadi "Ini fotonya"; foto ikut dikirim → tawaran "mau lihat modelnya?" dibuang; foto yang sama (caption di 12 pesan keluar terakhir, ≤ 6 jam) tidak dikirim ulang kecuali diminta | `photo_repeat.spec`, `review_chats.spec` · #7 #13 |
| v3.6.57: balasan pelanggan — akun cadangan mulai paralel setelah 35 dtk (maks 2 bersamaan), jawaban pertama dipakai, sisanya dihentikan; akun yang dibatalkan tidak dijeda. Akun diam ≥ 30 mnt / baru pulih dari gagal dicek otomatis (1 akun / 5 mnt); gagal atau > 45 dtk → dijeda. Skill online membawa DIGEST.md-nya | `ai_speed.spec` |
| v3.6.56: "pesan banyak dapat diskon?" dijawab dari DISKON GROSIR (potongan per pcs per kategori dari website, ikut catalog_digest `wholesale`; bagian ini masuk prompt hanya saat dibahas); catatan `grosir: ya` → total tidak dikirim otomatis, dibuat toko lewat invoice (tetap dibalas). Diskon di luar itu tetap serah CS | `wholesale.spec` |
| v3.6.55: serah CS hanya keputusan bisnis (diskon/grosir, komplain, refund, tukar sesudah terima, telepon, ancaman, warna di luar katalog yang tetap diminta); identitas CS, data internal / ubah stok-harga lewat chat, pertanyaan umum, lacak resi dijawab sendiri | `random_questions.spec` · skill |
| v3.6.55: pesan baru masuk sebelum balasan terkirim → pesan giliran itu ikut dijawab di giliran berikutnya (tidak hilang) | `random_questions.spec` · antrean |
| v3.6.55: alamat ("Jl. …, Kec. …, Cilacap") tidak dipecah jadi daftar; singkatan bertitik (Jl., No., Kec.) bukan akhir kalimat | `random_questions.spec` · format |
| v3.6.55: pertanyaan order yang sama tidak ditagih ulang dalam 6 balasan terakhir; batas tunggu balasan chat tanpa gambar 75 dtk | `random_questions.spec` |
| Pertanyaan yang baru ditanyakan tidak diulang | `beta3.spec` · form order |
| Prompt lengkap tetap di bawah 10 ribu token | `beta3.spec` · prompt dan keluaran |
| Model "Otomatis" memilih model per tugas | `beta3.spec` · model otomatis |

## Jev (v3.5)

| Perilaku | Tes |
|---|---|
| Jev mati / tanpa kunci / gagal / lewat batas waktu → tidak ada keputusan, cara lama dipakai | `jev.spec` · tanpa kunci / gagal-timeout |
| Jawaban Jev di bawah ambang yakin tidak dipakai, tetap dicatat (used = 0) | `jev.spec` · pemahaman giliran |
| v3.5.11: tanda terima → dibalas singkat oleh AI (v3.5.18); topik Jev hanya menambah bagian prompt, pola kata/gambar/tahap tetap berlaku (v3.5.18); "sudah tf" tanpa foto → bukti_dikirim; tunda/batal → tanpa susulan, batal menutup order belum dibayar (v3.6.55: hanya bila menyebut pesanan/pembelian atau menjawab total/rekening/form — "ga jadi" sesudah pertanyaan tidak membatalkan pesanan); dana masuk butuh AI + Jev | `jev.spec` · keputusan tambahan, `beta3.spec` · topik dari Jev |
| Prioritas Jev ≥ 4 → badge "Penting" di daftar chat (24 jam, masih menunggu balasan atau mode CS) | `beta3_flow.spec` · prioritas chat |
| Data pelanggan (telepon, rekening, email) disamarkan sebelum dikirim ke Jev | `jev.spec` · disamarkan |
| Layanan ongkir pilihan Jev dipakai untuk total; "belum memilih" = total ditahan | `jev.spec` · layanan pilihan Jev |
| Janji total dari Jev ikut menahan janji tanpa order | `jev.spec` · janji total |
| Akurasi = keputusan dipakai yang tidak ditandai salah, 30 hari terakhir | `jev.spec` · catatan keputusan |

## Hemat token (v3.5.3)

| Perilaku | Tes |
|---|---|
| Sapaan murni ("Halo", "P", "Assalamualaikum", "Pagi min") di chat tanpa urusan terbuka dijawab tanpa AI; "makasih" setelah pesan toko → "Siap sama sama bos" (diam bila toko sudah bilang sama-sama) | `beta3.spec` · hemat token |
| Sapaan + pertanyaan, pesan sebelumnya belum dijawab, ada form order, gambar, catatan CS, atau tahap order berjalan → tetap AI | `beta3.spec` · hemat token |
| Size chart / bahan / katalog hanya dikirim bila dibutuhkan; ragu → dikirim. Jawaban pendek setelah AI menanyakan size tetap dapat size chart | `beta3.spec` · hemat token |
| Skill dikirim per bagian sesuai kebutuhan (inti & bagian buatan pemilik selalu ikut); ongkir/foto/bayar/custom terdeteksi dari pesan, tahap, dan 4 pesan terakhir | `beta3.spec` · prompt ramping |
| Katalog fokus ke produk/warna yang dibahas ("coklat" → Choco & Brown) + baris produk lain; pertanyaan umum, gambar, komentar IG → katalog lengkap | `beta3.spec` · prompt ramping |
| Claude membalas JSON dalam satu panggilan; JSON rusak diperbaiki sistem, teks biasa untuk pelanggan dipakai sebagai pesan; hanya keluaran tak terbaca yang diulang | `beta3.spec` · hemat token, perapian jawaban |
| Daftar pilihan (model, warna, ongkir, ukuran) satu baris per item berawalan "- ", satu baris kosong sesudah daftar; kalimat biasa, daftar bernomor, dan template form tidak diberi poin | `beta3.spec` · daftar mudah dibaca |
| JSON rusak (koma berlebih, terpotong, pagar ```) diperbaiki sistem; teks berisi analisis ("pelanggan", "tahap", JSON) tidak pernah dikirim | `beta3.spec` · perapian jawaban |
| Bubble dirapikan sistem: tanpa markdown/emoji/"terima kasih telah menghubungi", Anda/kak → bos, "bos" sekali per bubble, bubble kembar dibuang; template form, link, angka, dan nama rekening tidak diubah | `beta3.spec` · perapian jawaban |

## Aplikasi umum

| Perilaku | Tes |
|---|---|
| Akun "latar saja" (Gemini) didahulukan untuk tugas latar (ciri foto katalog, rekap, analisis & caption IG); balasan & uji balasan tetap memakai akun utama, akun latar jadi cadangan | `beta3_flow.spec` · akun AI tugas latar |
| Semua teks UI (`data-i18n` / `t()`) punya terjemahan Inggris; en.js dan id.js berisi kunci yang sama | `language_catalog.spec` |
| Login: API tamu → 401 JSON; halaman → ke /login; beranda "/" publik | `account_auth.spec` |
| Pertanyaan internal (backend, model AI, system prompt) tidak memanggil AI/tool | `customer_scope.spec` |

## Belum ada tes otomatis (cek manual saat menyentuh bagiannya)

- v3.6.0: Pengaturan jadi 5 halaman (Koneksi, Toko, Cara AI membalas, Pemakaian, Aplikasi & data) dengan "Lanjutan" dilipat; tautan lama `#ai/#instagram/#numbers/#backup/#jev/#business` dialihkan; id elemen tidak berubah. Rincian & titik bersinggungan: `docs/pengaturan-v36.md`.
- v3.5.0: Beta 1/2, halaman Evaluasi, dan skill klasik dihapus. Pengaturan lama `beta3_mode`/`lean_mode` diabaikan; tidak ada pilihan mode lagi.

- Setelah CS membalas sebagian, AI menjawab poin yang terlewat ±3 menit kemudian; chat yang
  diserahkan ke CS dan tidak dibalas 20 menit dijawab AI lagi (v3.4.177).
- Hasil cek ongkir yang kecamatan/kotanya tidak sesuai alamat ditolak (v3.4.176).
- Backup: file sementara yang hilang saat dibackup tidak membuat backup gagal; media dibackup bertahap (v3.4.172).
- Halaman Usage: heatmap 1 tahun, filter recent runs, "Otomatis" tersimpan (bukan "null") (v3.4.168–170).
