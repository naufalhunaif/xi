# Model dan reasoning sesuai kebutuhan

Level konteks bukan ukuran kecerdasan model. Index kata membantu memilih konteks awal; maksud, state asli dan bukti tetap menentukan keputusan. Routing profil dilakukan lokal, tanpa request model klasifikasi tambahan untuk setiap pesan.

| Jalur | Model ChatGPT bawaan | Reasoning | Batas |
|---|---|---|---|
| L0: penerimaan setelah penutupan terverifikasi | Tidak ada | Tidak ada | Checkpoint, pesan sumber, cart, kebijakan dan state harus cocok; bukan mencocokkan kata “iya” saja |
| Index sosial terbatas | gpt-5.6-luna | low | Tanpa MCP, cart, memori baru, harga, stok atau keputusan bisnis. Bentuk keluaran dan state sebelum pengiriman tetap divalidasi |
| Katalog sederhana, state lengkap tanpa cart/order/media/kutipan | gpt-5.6-terra | medium | Baca katalog; tindakan, ketidakpastian, tool di luar katalog atau kebutuhan kompleks harus naik |
| Rujukan lama, custom, ukuran, transaksi, pembayaran, keluhan, visual, konteks tidak jelas | Model utama pemilik, misalnya Sol atau GPT-5.5 | Minimal high pada model yang dukungannya dikenali; setelan lebih tinggi dipertahankan | Semua pemeriksaan bukti tetap berlaku |
| Profil sebelumnya meminta penalaran mendalam secara eksplisit | Model utama pemilik | Minimal xhigh pada model yang dikenali | Satu kenaikan per fase sebelum pengiriman/tindakan; tidak otomatis memuat semua skill |

Model utama tidak diganti dengan model yang dianggap lebih baru. Model yang dukungan reasoning-nya belum dikenali tetap memakai effort konfigurasi pemilik. Claude memakai Haiku/auto untuk index, Sonnet/medium untuk katalog, dan model utama untuk konteks kompleks. Profil ringan/menengah memakai kecepatan Standard; tidak menyalakan Fast berbayar. Jalur utama mempertahankan kecepatan yang dipilih pemilik.

Keluaran tidak valid/penolakan proses pada profil ringan/menengah dapat dicoba sekali dengan profil utama. Error kuota dan jaringan tetap mengikuti mekanisme cooldown/failover provider, bukan pergantian model berulang. Hasil yang butuh kontrak/aturan tambahan juga memakai model utama. Tidak ada teks parsial dari model pertama yang dikirim sebelum pemeriksaan selesai.

## Aktivasi

Pada beta, routing adaptif mengikuti opt-in compact jika `AI_ADAPTIVE_ROUTING_ENABLED` belum diisi. Jadi server yang sudah memakai `AI_COMPACT_REPLY_ENABLED=true` mengaktifkannya setelah deploy dan restart WEB/WORKER. Tanpa compact dan tanpa flag eksplisit, pemilihan model lama tetap berlaku. Flag `false` mematikan pergantian model/reasoning, sementara compact dapat tetap aktif.

Opsional, isi `.env` VPS untuk override; bukan wajib agar mode otomatis bekerja:

```dotenv
AI_ADAPTIVE_ROUTING_ENABLED=true
AI_CHATGPT_LIGHT_MODEL=gpt-5.6-luna
AI_CHATGPT_LIGHT_REASONING=low
AI_CHATGPT_STANDARD_MODEL=gpt-5.6-terra
AI_CHATGPT_STANDARD_REASONING=medium
```

Jika ingin mengukur GPT-5.5 atau GPT-5.4 sebagai profil ringan, ubah hanya `AI_CHATGPT_LIGHT_MODEL`, mulai dari `low`, lalu bandingkan pada contoh yang sama. Nama model harus tersedia untuk akun/provider CLI server. Field Claude setara: `AI_CLAUDE_LIGHT_MODEL`, `AI_CLAUDE_LIGHT_REASONING`, `AI_CLAUDE_STANDARD_MODEL`, `AI_CLAUDE_STANDARD_REASONING`. Model utama tetap dari Settings aplikasi. Tidak ada token/kunci baru yang perlu ditempel ke chat.

## Cache yang berbeda

| Jenis | Perilaku saat ini |
|---|---|
| Cache prompt provider | Dilaporkan pada `usage.cached`; tetap bagian input. Pengguna tidak perlu mengaktifkan cache MCP untuk mendapat cache ini. Kecocokan prefix, model/effort dan perilaku CLI/provider memengaruhi hit |
| Cache hasil MCP | Exact key meliputi workspace, sumber, identitas akses, schema, versi dan argumen; bukan kemiripan pertanyaan |
| Daftar katalog tanpa filter | 6 jam, berbentuk indeks pencarian; detail harga/stok tetap diverifikasi dengan get_product |
| Pencarian produk/get_product | 60 detik dalam satu balasan, dibagi lintas fase/retry; bukan cache harga/stok lintas chat |
| Tarif ongkir | 15 menit untuk argumen identik; perubahan paket/tujuan mengubah key |
| Wilayah dan Fit Advisor | 24 jam untuk input identik dan hasil sah |
| Mutasi, pembayaran, pelacakan dan tool tidak dikenal | Tetap langsung; error/hasil kosong tidak dijadikan bukti tersimpan |

Memanggil tool berbeda atau argumen berbeda bukan cache hit. Fase baru tetap perlu menerima bukti agar model dapat membacanya; cache MCP menghindari panggilan upstream, bukan seluruh token model. Balasan final, persetujuan atau fakta pelanggan tidak dipakai ulang lintas room melalui semantic cache. Tidak ada knob cache baru yang memperpanjang masa berlaku stok/harga demi menaikkan angka hit.

Prompt utama menaruh aturan stabil sebelum indeks level/state giliran, supaya perubahan indeks tidak memutus prefix aturan sejak awal. Model dan reasoning yang berbeda tetap dapat memiliki cache berbeda; hit provider bukan jaminan hanya karena teks tampak sama. Integrasi memakai CLI provider, sehingga kontrol cache API seperti breakpoint tidak diasumsikan tersedia atau dipaksakan melalui argumen CLI yang tidak didukung.

## Pengukuran

- `routing-timing`: waktu memilih jalur secara lokal, `localModelCalls: 0`, dan kelayakan index/compact.
- `*:model-selection`: model, tier, reasoning, speed dan alasan pemilihan untuk setiap fase, termasuk kenaikan/failover. Ini enum konfigurasi, bukan isi penalaran model.
- `index-prompt-size`: ukuran input index sebelum provider; batas 24.000 karakter dengan compact. Melebihi batas berarti masuk jalur utama, bukan memotong konteks.
- `level-summary`: `cacheHits` hasil MCP terpisah dari `providerCachedInputTokens` dan `providerInputTokens`. Cache provider juga muncul pada judul ringkasan bila ada.
- Usage tetap angka asli provider. Bandingkan durasi total, input baru (`input - cached`), output, frekuensi kenaikan profil, dan kualitas keputusan. Model murah yang sering naik profil bisa lebih lambat/mahal daripada langsung memakai model utama.

Pengujian offline membuktikan argumen CLI, guard dan urutan naik profil. Ini bukan bukti bahwa Luna/Terra telah menyamai kualitas model utama pada seluruh percakapan pelanggan. Evaluasi internal/audit masih memakai model utama dan kebijakan evaluasinya; perubahan ini tidak mengompakkan prompt evaluasi. Pantau keputusan, inisiatif dan akurasi bukti pada percakapan sesudah deploy, tanpa menurunkan validasi untuk mengejar angka token.

Referensi: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
