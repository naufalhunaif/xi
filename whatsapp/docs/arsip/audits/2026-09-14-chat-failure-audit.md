# Audit simulasi percakapan WhatsApp — 14 September 2026

## Pembaruan setelah perbaikan diagnostik

Pengujian ulang: **41 lulus, 13 gagal dari 54 skenario**. T02 sudah lulus setelah
event kegagalan provider diteruskan ke timeline dengan detail tersanitasi, termasuk
limit Claude dan ChatGPT. Temuan lainnya di bawah masih terbuka; angka 40/14 pada
bagian hasil awal adalah kondisi sebelum perbaikan ini.

Suite unit terpisah: **100 lulus**. Pengujian tampilan kegagalan lulus di Chromium
dan WebKit. Benturan ID pesan keluar juga mendapat perbaikan dan tes dengan
repository/socket simulasi; belum diuji dengan transaksi MySQL atau pengiriman
WhatsApp nyata. Perbaikan ini tidak mengatasi seluruh temuan audit dan tidak
membuktikan bahwa limit akun provider telah pulih.

## Hasil utama

**54 skenario offline: 40 memenuhi ekspektasi, 14 tidak memenuhi ekspektasi.**
Selain itu, 88 unit test yang sudah ada dan 18 test JavaScript jaringan/login lulus.
14 kegagalan audit adalah celah kontrak/validasi pada kondisi uji, **bukan persentase chat pelanggan yang gagal**.
Tes audit sengaja terpisah dan tetap merah supaya tidak menyembunyikan temuan sebelum perbaikan.

Tidak menjalankan model AI, login akun, tool bisnis asli, worker WhatsApp, server HTTP,
atau transaksi MySQL. Semua pesan simulasi sintetis; semua respons tool sintetis.
Tidak mengubah skill atau logika produksi aplikasi. Perubahan OAuth yang sudah ada
sebelum audit tidak diubah oleh audit ini.

## Arsip yang dipakai

Sumber: `Downloads/wa_extract/db/databases_raw/msgstore.db`, dibaca melalui salinan
sementara berikut WAL-nya. Database sumber, arsip autentikasi dan kunci enkripsi tidak dibuka untuk penulisan.
Tidak menyalin isi chat, nomor, identitas, alamat, atau bukti transfer ke repository.

| Ukuran | Hasil |
| --- | ---: |
| Seluruh arsip | 356.106 pesan / 13.505 chat |
| Seleksi chat langsung yang membahas pakaian | 293.216 pesan / 3.648 chat |
| Pesan masuk berisi teks dalam seleksi | 136.093 |
| Teks masuk ≤60 karakter | 123.931 (sekitar 91,1%) |
| Teks masuk dengan kutipan | 17.765 |
| Kutipan lebih dari 600 karakter | 187 |
| Pesan keluar lebih dari 600 karakter | 29 |
| Balasan pendek langsung setelah pesan keluar panjang | 6 |
| Pola pengukuran beruntun dalam ≤5 menit | 379 |
| Teks dengan ≥3 kategori kata kunci | 4.215 |

Seleksi bersifat heuristik: chat langsung dengan minimal dua pesan keluar berisi
kata pakaian (`jas/celana/suit/tuxedo/rompi/beskap/chameleon`). Bukan label pelanggan
terverifikasi; bisa mencakup percakapan nonpenjualan. Rentang seleksi 24 Januari 2018–12 September 2026.

Kategori masuk yang cocok kata kunci (saling tumpang tindih): produk 18.890; pilihan
33.556; ukuran 12.829; custom 2.761; pengiriman 8.337; pembayaran 2.610;
produksi/waktu 4.434; keluhan 1.134; foto 2.394; kuantitas 1.049.

Parser Fit saat ini terpicu pada 43 teks arsip; ada 947 teks dengan label tinggi dan
berat eksplisit serta 379 pola pesan pengukuran beruntun. **Angka tersebut bukan
recall atau jumlah kegagalan Fit**: tidak setiap penyebutan ukuran adalah permintaan
rekomendasi, dan LLM masih menerima konteks. Temuannya: pengujian tidak boleh hanya
mencakup satu kalimat lengkap dengan jenis barang, tinggi, berat, dan pertanyaan sekaligus.

## Temuan yang direproduksi

| Prioritas | ID | Kondisi uji | Perilaku saat ini / risiko |
| --- | --- | --- | --- |
| P0 | B01–B04 | Tool error, hasil null, sumber tidak terdaftar, atau tool tidak relevan | Gerbang pemeriksaan bisnis menerima keberadaan panggilan sebagai bukti. Jawaban produk dapat lolos tanpa bukti relevan yang berhasil. |
| P0 | B07 | Semua MCP tidak terautentikasi, jawaban masih menandai lookup wajib | Pemeriksaan tambahan dilewati; tidak ada penahanan di gerbang ini. |
| P0 | J01–J03 | JSON terpotong, teks diagnostik biasa, decision tidak dikenal | Parser dapat mengubahnya menjadi `reply`. Ini risiko pada keluaran model yang mencapai parser, bukan bukti bahwa stderr CLI otomatis dikirim. |
| P1 | P02 | Setelah CS memberi daftar model, pelanggan memilih “Yang casual”; model memberi label handoff umum | Guard kombinasi harga tidak aktif untuk pilihan pendek; `human_authorization` bisa melewati cek tanpa tool. Bukan berarti setiap pilihan pendek pasti di-handoff. |
| P1 | I02–I03 | Produk hanya memakai `structuredContent`, atau membawa `isError` bersama data produk | Format camel-case tidak diekstrak; hasil gagal masih bisa menjadi kandidat gambar. Perlu normalisasi dan pemeriksaan sukses, sebelum gambar/cart digunakan. |
| P1 | C02–C03 | Detail pilihan atau pengukuran berada di akhir pesan/kutipan panjang | Render konteks memangkas setelah 600 karakter, termasuk kutipan yang seharusnya membantu disambiguasi. |
| P1 | T02 | Provider mengirim event `turn.failed` | Adapter trace tool mengabaikan event itu; tahap pembungkus akhirnya gagal dengan informasi generik. Penyebab spesifik perlu event kegagalan tersanitasi. |

Sumber kode utama:

- `app/services/skill_runtime_service.ts`: `needsBusinessVerification`.
- `app/services/ai_service.ts`: `parseDecision`, `extractCatalogProducts`, `toolResultValue`, `runAi`.
- `app/services/context_service.ts`: `BODY_LIMIT`, `bodyOf`, `renderContext`.
- `app/services/trace_service.ts`: `traceProviderEvents`, `startTrace.finish`.
- `commands/whatsapp_listen.ts`: catch `runTurn` menyimpan detail teknis pada log worker.

## Yang lolos pada simulasi

| Area | ID yang lulus | Batas pembuktian |
| --- | --- | --- |
| Konteks pilihan pendek, kutipan hilang, urutan pengukuran | C01, C04–C05 | Pembuatan konteks, bukan penalaran model. |
| Fit lengkap, tidak menebak jenis barang/format angka ambigu, permintaan manusia | F01–F06 | F04–F05 mengembalikan tidak terdeteksi; perlu klarifikasi atau resolusi dari konteks, bukan menebak. |
| Harga kombinasi | P01 | Mendeteksi pertanyaan kombinasi, belum menguji kualitas harga dari MCP asli. |
| Bukti valid/discovery, sapaan, retry sekali, gagal sementara terlihat | B05–B06, B08–B11 | Gagal sementara dilempar sebagai error; lulus uji ini tidak berarti pemulihan otomatis sudah baik. |
| Balasan kosong, handoff, gambar tidak ada/HTML | J04–J05, I01, I04–I05 | Tidak membuktikan kemampuan melihat piksel atau keberhasilan pengiriman gambar. |
| Custom nomor 38, konflik ukuran, konfirmasi cart | K01–K03 | Nomor celana tidak dianggap cm; tidak menguji penyimpanan cart/MySQL. |
| Ongkir gagal, layanan/tarif tidak cocok, alamat berubah | S01–S03 | Validasi bukti; tidak menguji lookup destination nyata. |
| Rekening benar/salah, pending, nominal salah tipe, rekening duplikat | M01–M05 | Pemeriksaan pembacaan bukti sintetis, bukan verifikasi uang masuk. |
| Jawaban CS, race pesan baru, handoff, gagal read receipt | D01–D04 | Socket palsu; gagal read tetap menahan pengiriman. |
| Tool MCP gagal pada timeline | T01 | Event tool ada; beda dari kegagalan sebelum tool berjalan. |
| Pengaturan produksi, sumber estimasi lokal, bukti evaluasi | O01–O03 | Kontrak pengaturan, bukan status order/produksi aktual. |

## Mengapa “Yang casual” bisa gagal sekitar 9 detik?

C01 membuktikan bahwa pada konteks pendek, daftar CS dan pilihan pelanggan tetap
tersedia. Ini tidak mendukung anggapan bahwa kalimat pelanggan kurang jelas.
Pemotongan 600 karakter tidak boleh dianggap penyebab kasus itu tanpa melihat konteks aktual.

Dari inspeksi kode (belum reproduksi pada server):

1. `runAi` mengambil/refresh token setiap MCP aktif **sebelum** menjalankan provider.
   Error satu sumber dapat membatalkan seluruh proses, termasuk sumber yang tidak
   diperlukan untuk pilihan Casual. Belum ada trace per-sumber untuk fase ini.
2. Proses provider bisa gagal karena executable, izin, OAuth, pembatasan usage,
   jaringan, atau keluaran yang tidak sesuai. Dua label Failed adalah tahap bertingkat,
   bukan bukti dua tool independen gagal.
3. Error asli disimpan di log worker; tahap analisis hanya menyimpan status, sedangkan
   tahap bisnis yang masih berjalan ditutup dengan pesan generik.

Durasi 9,1–9,2 detik **tidak mengidentifikasi penyebab**. Perlu log worker/trace
server pada waktu kejadian untuk membedakan refresh MCP, login AI, atau masalah lain.

## Matriks lanjutan: belum dijalankan secara end-to-end

| Keluarga kasus | Skenario | Hasil yang harus dijaga |
| --- | --- | --- |
| Jaringan/MCP | 401/403, token refresh gagal, 429, 5xx, timeout, satu sumber mati | Kegagalan per sumber jelas; retry baca dibatasi/backoff; jangan mengarang data atau mengulang operasi tulis. |
| Model | Limit akun, process exit, JSON parsial, model salah konfigurasi | Tidak mengirim error mentah; satu keputusan valid atau status tertunda yang jelas. |
| Produk | “yang itu” + foto, pilihan warna, beberapa model serupa, stok berubah | Resolusi konteks dan bukti terbaru; klarifikasi hanya bagian ambigu. |
| Custom | Nomor di luar stok, detail lapel/kancing, harga belum disetujui, berat tidak ada | Simpan pilihan pasti sebagai draft; harga belum sah null; persetujuan internal tanpa pesan pengalihan. |
| Ongkir | Kota tanpa kode pos, destination ganda, ganti alamat/qty, berat custom | Pilih destination dari data nyata; jangan menggunakan tarif lama untuk konteks berbeda. |
| Media | Video/GIF/stiker rusak, unduhan gagal, >4 gambar, foto bukti buram | Nyatakan ketidaktersediaan visual; retry aman; tidak mengklaim analisis piksel yang tidak diterima. |
| Pembayaran | DP bertahap, kelebihan bayar, saldo mengurangi order lama, bukti dipakai ulang, nominal admin | Transaksi atomik/idempotent, saldo benar, dana tetap butuh otorisasi sesuai alur pemilik. |
| Order | Dua order aktif, invoice lama, estimasi versus progres, lewat tenggat | Gunakan order lokal yang tepat; pisahkan draft baru; jangan mengarang tahap produksi. |
| Sinkronisasi | Restart saat balas, reconnect nomor sama/berbeda, CS takeover, whitelist/AI off | Tidak ada duplikasi, silang nomor, balasan setelah takeover, atau kehilangan pesan belum dijawab. |
| Percakapan | Data ukuran terpisah, koreksi angka, topik lama kembali, negasi | Fakta terbaru dengan asal pesan; jangan menggabungkan ukuran orang/barang berbeda. |

Tes integrasi yang menyentuh MySQL/worker sengaja tidak dijalankan pada database
pengguna. Pengujian lanjutan memerlukan database khusus tes dan provider/MCP
stub atau sesi live terbatas yang disetujui; mengirim ulang seluruh arsip ke AI
bukan bagian audit ini. Semua kemungkinan bahasa manusia tidak dapat dibuktikan
oleh 54 skenario; kasus baru perlu ditambah sebagai regresi.

## Urutan perbaikan yang disarankan

1. Catat sumber dan kategori kegagalan tersanitasi (refresh MCP, provider, parsing,
   validasi bisnis, media, delivery), tanpa token atau penalaran mentah.
2. Perketat kontrak: hasil tool harus sukses, relevan, dan dari sumber aktif;
   keputusan invalid ditahan, bukan fallback reply.
3. Normalisasi format respons MCP sebelum bukti harga/gambar/cart dipakai.
4. Resolusi pilihan pendek/pengukuran dari konteks; lindungi kutipan dan detail
   penting dari pemotongan tanpa mengubah panduan gaya/skill pengguna.
5. Uji pemulihan dan transaksi pada database tes, lalu canary chat internal.

## Menjalankan ulang

Dari folder `whatsapp` (Node sesuai proyek):

```sh
node scripts/audit_chat_archive.mjs /path/to/disposable-snapshot/msgstore.db
node --import=@poppinss/ts-exec scripts/run_chat_audit.ts
node --import=@poppinss/ts-exec bin/test.ts unit
node --test tests/workspace_fetch.test.mjs tests/chatgpt_login.test.mjs
```

Perintah audit skenario sekarang keluar dengan kode 1 karena **13 ekspektasi belum
terpenuhi**, bukan karena test runner gagal boot. File pengujian:
`tests/audit/chat_failure_matrix.spec.ts`. Tidak masuk suite unit/functional biasa.
