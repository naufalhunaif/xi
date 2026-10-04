# Beta: keputusan menurut level kebutuhan

Berbasis `origin/main` pada `009a93f`; level index v2 dilanjutkan runtime `beta-patterns-v1`.
Lihat [cache pola penanganan](beta-conversation-patterns.md) untuk pemakaian ulang
alur dengan rincian pelanggan berbeda. Pengembangan ini hanya untuk branch `beta`.
Model, aturan bisnis, bukti persetujuan CS, validasi cart, pembayaran dan inisiatif
tetap mengikuti alur utama. Tidak ada classifier terpisah yang wajib dijalankan
pada semua pesan: fase index ringan boleh langsung menjawab atau meneruskan ke
jalur utama jika perlu. Indeks lokal adalah petunjuk awal; pemahaman maksud tetap tugas model bila
keputusan belum dapat dibuktikan oleh state.

## Level eksekusi

| Level | Kapan dipakai | Pekerjaan | Batas dan kenaikan level |
| --- | --- | --- | --- |
| 0 | Penerimaan singkat sesudah penutupan yang tervalidasi | Selesaikan anchor pesan lokal, tanpa balasan tambahan | Nol panggilan model/MCP; tidak mengubah cart/order/memori/ledger. Gagal satu guard berarti lanjut ke model. |
| 1 | Pembuka/penerimaan tanpa kebutuhan bisnis aktif | AI membaca konteks asli dan aturan umum dengan skema balasan kecil, tanpa MCP | Hanya teks, satu inisiatif dan goal sederhana. Kebutuhan bisnis atau output tidak sah diteruskan dengan konteks asli. Jawaban untuk pilihan ukuran/cart langsung ke jalur utama. |
| 2 | Kebutuhan domain seperti produk, ukuran atau ongkir | AI menggunakan data tersedia, cache domain, lalu MCP bila perlu | Kunci/TTL cache lama tetap berlaku. Angka/harga/persetujuan tidak berasal dari indeks. |
| 3 | Rujukan pesan lama, kutipan, atau konflik memori | Ambil fakta/sumber asli room ini, kemudian data bisnis yang masih kurang | Riwayat maksimal 20 pesan per baca; memori maksimal 16 indeks per baca. Pembacaan berikutnya tetap tersedia. |
| 4 | Maksud belum jelas, kebijakan belum tercakup, atau model meminta semua aturan | Konteks skill lengkap dan validasi utama | Fallback skill satu kali per `createReply`; retry analisis tetap maksimal dua sesuai kebijakan existing. Tidak ada pemotongan bukti berguna demi target token. |

Level bukan lima model berbeda dan bukan lima analisis wajib. Permintaan bisa
langsung mulai di level yang diperlukan. Pemanggilan MCP tidak harus didahului
pengambilan riwayat jika rujukan sudah jelas. Naik level lewat pembacaan tool
tidak selalu berarti memulai analisis dari nol; fallback lengkap memang dapat
memerlukan analisis tambahan dan tercatat.

## Delapan lapisan dan batasnya

1. **Index/intent:** `0` ambigu, `1` penerimaan, `2` katalog, `3` ukuran,
   `4` custom/model/warna, `5` cart, `6` pembayaran, `7` pengiriman,
   `8` layanan, `9` visual. Satu pesan boleh memiliki beberapa indeks. Bukan
   enum tindakan dan tidak dapat menyetujui checkout, custom atau dana.
2. **Core rules/guardrails:** aturan umum, kewenangan, pemahaman maksud,
   validasi bukti dan inisiatif tetap aktif. Skill tidak dikenal tetap utuh.
   Model dan pengaturan kualitas tidak diganti. Fase index langsung menghasilkan
   balasan bila cukup; kebutuhan bisnis yang sudah dikenali melewati fase ini.
3. **Active conversation state:** pertanyaan terakhir, kebutuhan yang menunggu,
   versi cart, keberadaan order, jumlah pesan pada giliran, media/kutipan, serta
   checkpoint penutupan. State dicek ulang sebelum penyelesaian lokal.
4. **Dynamic skills:** nomor bagian berupa `1`, `2`, dst, dengan indeks ringkas
   `[id, judul]` per skill. Isi asli dan aturan induk tetap dapat dibaca. Routing
   domain hanya dipakai jika penghematan karakter termasuk indeks minimal 25%; ini bukan
   janji penghematan token 25%. Konteks level 4 langsung memakai aturan lengkap.
   Fase index memakai hanya bagian umum/orisinal yang aman serta semua aturan
   tidak dikenal. Bagian domain ditunda karena fase ini tidak boleh menjalankan
   tindakan domain, dan tidak memuat tool library. Skill tidak diringkas otomatis.
5. **Domain cache:** memakai cache existing, bukan cache jawaban pelanggan.
   Daftar katalog tanpa filter 6 jam; detail/pencarian produk 60 detik dalam
   satu balasan; Fit Advisor dan tujuan kirim 24 jam; tarif ongkir 15 menit.
   Identitas koneksi, argumen, skema dan masa berlaku tetap diperiksa. Operasi
   tulis dan pemeriksaan pembayaran tidak dijawab dari cache ini.
6. **Deep memory:** jendela awal 12 fakta untuk permintaan domain yang cukup
   jelas tanpa cart. Batas ini lunak: constraints dan pending selalu ikut,
   walaupun melampaui 12. Input ambigu, rujukan lama, cart, pembayaran atau
   layanan tetap mempertahankan memori lengkap. Fakta di luar jendela tidak
   dihapus; tersedia indeks dengan key/topic tanpa menyalin semua nilainya.
7. **Retrieval:** `read_customer_memory(indices)` mengembalikan fakta beserta
   sumber asli yang masih valid. Indeks hanya berlaku untuk giliran itu. Sumber
   yang berubah/dihapus tidak dikembalikan sebagai fakta sah; koreksi setelah
   anchor tidak bocor ke proses lama. Akses dibatasi workspace, room dan anchor.
   Riwayat existing tetap tersedia untuk menemukan sumber yang belum diringkas.
8. **MCP dan validasi akhir:** tool bisnis tetap tersedia saat bukti diperlukan.
   Pengaman empat panggilan/hasil identik berturut-turut tetap berlaku, bukan
   batas empat tool total. Validasi asli memeriksa hasil sebelum tindakan.

## Kapan `iya bos` benar-benar nol token?

Semua syarat ini harus terpenuhi:

- Tepat satu pesan teks baru; tidak ada media, kutipan, pertanyaan, syarat,
  perubahan, atau kebutuhan tambahan di dalamnya.
- Balasan AI sebelumnya adalah penutup sederhana seperti `Sama-sama bos.`,
  telah tercatat terkirim, tanpa inisiatif, cartIntent atau kebutuhan approval.
- Goal sebelumnya `completed`, stage `closed`, tanpa waiting/next action/susulan.
- Tidak ada barang cart, order, atau memori kebutuhan tertunda. Memori harus
  berhasil dibaca; kegagalan database tidak dianggap sebagai state kosong.
- ID dan digest balasan, anchor eksternal sebelumnya, versi cart dan hash
  kebijakan sama; umur checkpoint maksimal 24 jam.
- Pemeriksaan tersebut lulus lagi tepat sebelum penyelesaian. Checkpoint habis
  setelah dipakai; marker lokal tidak dapat diisi oleh JSON keluaran model.

`iya bos` sesudah `Mau size S?`, `Alamat ini benar?`, atau rekap pembayaran
tetap menggunakan model dan validasi. NFKC, kapital dan markup sederhana boleh
dinormalisasi untuk jalur lokal. Aksen/ungkapan lain yang tidak dikenali diarahkan
ke pemahaman model, tidak ditebak atau diabaikan. Semua contoh pengujian sintetis.

## Aturan bawaan di kode dan skill

Menyimpan teks skill di source code saja tidak mengurangi token. Penghematan
terjadi ketika pekerjaan pasti ditangani oleh kode sehingga model tidak perlu
membaca instruksi dan skema untuk pekerjaan itu pada giliran yang tidak relevan.

| Lapisan | Yang dikerjakan kode | Yang tetap membutuhkan skill/model |
| --- | --- | --- |
| State dan pengulangan | Guard pesan yang sudah dianalisis, checkpoint penutupan, eligibility index dan pemeriksaan state sebelum kirim | Memahami kebutuhan baru dan jawaban yang bergantung pada konteks |
| Kontrak balasan index | Allowlist JSON, larangan field cart/order/memori/media/approval, pemeriksaan tujuan dan eskalasi | Bahasa, maksud, gaya, dan pertanyaan pembuka yang relevan |
| Data bisnis | Cache, identitas sumber, validasi harga/stok/persetujuan, perhitungan dan transaksi existing dari main | Menentukan data yang diperlukan dan menjelaskannya sesuai aturan bisnis |
| Pemilihan aturan | Memuat bagian skill sesuai fase, menyimpan sumber utuh dan hash kebijakan | Aturan umum atau baru yang belum punya padanan teruji di kode |

Ini bukan compiler bebas yang mengubah semua skill menjadi kode. Memindahkan
aturan bisnis baru ke kode perlu pemetaan sumber, prioritas/pengecualian dan uji
kesetaraan perilaku. Perubahan skill tetap dibaca dari snapshot terbaru; aturan
yang tidak dikenal tidak boleh dibuang demi target ukuran prompt.

## Fase index yang benar-benar lebih kecil

Fase ini hanya tersedia jika pesan teks singkat dan konteks sumber berhasil
dibaca, tanpa media/kutipan, item cart, order, memori kebutuhan tertunda, rujukan
lama atau kebutuhan bisnis yang dikenali pada pesan/pertanyaan aktif. Kata kunci
hanya memilih jalur awal: dialek/typo yang belum dikenali tetap dibaca model.
Model harus meneruskan kebutuhan domain atau ketidakpastian, bukan mengabaikannya.

Kontrak index tidak menyediakan cartIntent, checkout, memori baru, handoff,
media atau penjadwalan. Output tidak sesuai kontrak tidak dikirim sebagai teks
mentah. Aplikasi meneruskan ke jalur utama satu kali dengan pesan, riwayat dan
skill sumber yang sama, bukan ringkasan buatan model index. Aturan retry error
provider tetap berlaku. State dan hash kebijakan diperiksa lagi sebelum kirim;
perubahan membatalkan hasil index lama dan menjadi kegagalan yang dapat dicoba ulang.

Prompt index, system prompt dan skema dibatasi 100.000 karakter gabungan.
Jika melebihi batas, aplikasi langsung memakai jalur utama tanpa memotong aturan
atau bukti. Batas ini bukan batas token tertagih dan tidak berlaku pada kasus bisnis.

Audit lokal terhadap 12 skill yang diunduh (9 aktif) dengan konteks sapaan sintetis:
prompt index sekitar **20.645 token perkiraan**, termasuk system prompt dan skema,
tanpa skema MCP. Skill aktif lengkap saja sekitar **41.292 token perkiraan**, belum
termasuk skema cart, konteks dan MCP jalur utama. Kedua angka berbeda cakupan;
bukan perbandingan tagihan provider dan bukan jaminan semua pesan di bawah 60 ribu.
Konteks nyata menambah ukuran. Pengujian provider lokal membuktikan isolasi,
eskalasi dan pengiriman, bukan akurasi semantik model produksi pada semua dialek.

## Diagnostik dan pengukuran

- `conversation-level`: level awal, indeks, alasan dan batas tiap lapisan.
- `index-prompt-size`: perkiraan input index, tanpa skema MCP; identitas runtime.
- `index-analysis`: waktu dan usage provider untuk fase index.
- `index-escalation`: diteruskan ke domain/lengkap dengan konteks asli.
- `level-3`/`level-4`: kenaikan aktual karena retrieval atau aturan lengkap.
- `level-summary`: level tertinggi, jumlah proses model, tool selesai, cache hit,
  pembacaan sumber dan apakah benar tidak ada model yang dijalankan.
- Prompt breakdown memisahkan `index-level` dan `index-memori`.
- `memoryFacts`/`memoryDeferred` memperlihatkan jendela awal dan fakta tertunda.

Jumlah proses model berbeda dari jumlah putaran internal model-tool. Cache MCP
tidak membuat token pembacaan hasilnya gratis. Bandingkan total input/output,
cached input, fallback, latency dan kesalahan pemahaman secara bersama-sama.
Jangan mengklaim persentase penghematan produksi dari fixture lokal.

`modelRuns` menghitung percobaan fase analisis, termasuk persiapan yang gagal
sebelum provider menerima permintaan. Pergantian provider dihitung sebagai
percobaan berikutnya meskipun nama fase sama. `modelSkipped` hanya benar pada
penyelesaian sukses tanpa fase analisis, termasuk pengabaian topik internal.
Indeks juga ikut memilih bagian skill: misalnya `167/56` dapat membuka aturan
ukuran tanpa harus memuat semua domain, tetapi tidak mengotorisasi rekomendasi
ukuran atau checkout tanpa bukti yang diwajibkan.

## Pengujian dan pemasangan

Tes database memakai runner `node scripts/test_cart_discount_database.mjs
--conversation-levels`, yang hanya membuat/menghapus schema lokal acak.
Provider sengaja dibuat tidak tersedia pada tes nol token; tes gagal bila jalur
itu menyentuh provider. Fase index memakai executable provider lokal yang memeriksa
prompt/skema/argumen MCP sebenarnya, termasuk eskalasi keluaran rusak dan penolakan
field transaksi. Pengiriman memakai socket tiruan, termasuk penyimpanan waiting
setelah satu inisiatif dan pencegahan analisis ulang anchor yang sama. Tidak ada
pesan WhatsApp nyata atau evaluasi berbayar.

Schema menambahkan satu kolom nullable `level_state_json` pada tabel goal lewat
inisialisasi existing. Record lama tanpa checkpoint masuk alur AI biasa.
Kolom ini hanya metadata optimasi, bukan sumber otorisasi. Mengembalikan aplikasi
ke main tidak memerlukan penghapusan data atau kolom.

Branch beta tidak otomatis berarti server telah menjalankannya. Build, migrasi
existing dan restart worker baru dilakukan saat beta memang akan dipasang.
Audit pelanggan privat tetap di worktree lokal yang terpisah dan tidak termasuk
perubahan ini.
