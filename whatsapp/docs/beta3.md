# Beta 3 — satu-satunya alur AI CS

Sejak v3.5.0 Beta 1/2 dihapus (catatan lama di `docs/arsip/`). Semua logika AI CS ada di
`app/beta3/*` (alias `#beta3/*`); infrastruktur bersama hanya sesi WhatsApp, penyimpanan
pesan/kontak, trace, koneksi MCP di Data bisnis, rekening, dan antrean pesan keluar.

| Bagian | Lokasi |
|---|---|
| Kode | `app/beta3/*` |
| Tabel | `whatsapp_beta3_*` (termasuk `whatsapp_beta3_chats`, `whatsapp_beta3_decisions`) |
| Skill | `skills-beta3/beta3-cs-inti` (terpasang otomatis) |
| Contoh CS awal | `resources/beta3/cs_examples.json` |
| Halaman | `/beta3`, Order, Pengaturan → Jev |
| API | `/api/beta3/*` |
| Perintah | `beta3:catalog`, `beta3:mcp` |
| Fase usage | `beta3-reply`, `beta3-ciri`, `jev-*` |

Titik sambung ke worker hanya di `commands/whatsapp_listen.ts`
(`runBeta3Turn`, `runBeta3Nudge`, sinkron katalog, grup produksi, jawaban setelah CS)
dan pembersihan chat (`deleteBeta3ChatData`).

Sumber data MCP Beta 3 dipilih sendiri (ikon roda gigi di /beta3) — state-nya
terpisah, walau daftar koneksinya sama dengan Data bisnis.

## Jev (v3.5)

Jev (TypeSafe AI, `app/beta3/jev.ts` + `jev_decisions.ts`) menjawab keputusan kecil; model AI tetap menulis balasan.

| Keputusan | Dipakai untuk | Cadangan bila Jev mati/ragu |
|---|---|---|
| `maksud`, `form`, `serah_cs`, `setuju`, `layanan` | Satu panggilan sebelum balasan: catatan sistem, tier model ringan untuk sapaan, layanan ongkir pilihan pelanggan | Regex & aturan lama |
| `total_toko` | Pesan toko sudah berisi total/rekening (form terlewat) | `looksLikeTotalSent` |
| `janji_total` | Menahan janji total tanpa order | Pola kata `guardTotalPromise` |
| `varian` | Warna katalog di spesifikasi | `fixCatalogColors` |
| `terjawab` | Jawaban setelah CS: lewati bila semua sudah dijawab | AI menilai sendiri |
| `komentar_ig` | Komentar Instagram perlu dijawab | `isQuestionComment` |
| `tanggapan` (v3.5.11) | "oke/siap" yang cukup tanda terima → tidak dibalas, AI tidak dipanggil (0 token) | AI menilai sendiri |
| `topik` (v3.5.11) | Ongkir/ukuran/bayar/custom/warna → bagian skill & data yang dikirim | Pola kata `token_saver` |
| `kesulitan` (v3.5.11) | Model ringan/standar/berat (mode "Otomatis") lewat `model_tier.ts`: sederhana → ringan (standar bila ada ongkir/catatan sistem/custom/bayar), biasa → standar, rumit/komplain → berat; alasan di trace "Tingkat model" | `autoTier` |
| `tujuan_baru` (v3.5.11) | Lanjutan obrolan ongkir: nama tempat baru atau bukan ("reg aja") | Daftar kata `NOT_A_PLACE` |
| `sudah_tf` (v3.5.11) | "Sudah tf" tanpa foto → tahap bukti_dikirim, masuk filter Pembayaran | AI menilai sendiri |
| `dana_masuk` (v3.5.11) | Pemeriksa kedua sebelum order ditandai lunas dari chat (AI & Jev harus sama) | AI saja |
| `lanjut` (v3.5.11) | Tunda → susulan dibatalkan; batal → order belum dibayar ditutup | AI mengosongkan susulan |
| `urgensi` (v3.5.11) | Skor 1–5 → badge "Penting" di kotak masuk (24 jam, chat belum dibalas/CS) | — |
| `harga_konteks` (v3.5.12) | Seri (reguler/signature/premium) & barang yang ditanya → angka dari POLA HARGA + pemeriksa harga sesuai konteks (`price_pattern.ts`) | Seri terakhir yang disebut di chat |
| `warna_gambar` (v3.5.8) | Warna produk di gambar pelanggan dari hasil ukur piksel (`app/beta3/image_color.ts`) vs foto katalog | Warna terdekat bila selisihnya jelas, selain itu kandidat ke AI |

Skor Jev dimulai dari 0 (tiga tingkat = 0 … 2); selalu dibaca lewat `scoreLevel` (v3.5.14).
Batas waktu 800 ms per panggilan; ambang yakin per keputusan di `JEV_THRESHOLD`. Setiap keputusan
dicatat; pemilik menandai yang salah di Pengaturan → Jev (Akurasi 30 hari) dan bisa mematikan
keputusan satu per satu.

## Hemat token (v3.5.3)

- `app/beta3/token_saver.ts`: sapaan/terima kasih dijawab tanpa AI (`quickReply`); size chart, bahan, dan katalog
  hanya masuk prompt bila dibutuhkan giliran itu (`promptNeeds`, dibantu maksud dari Jev). Trace menampilkan
  "Balasan cepat tanpa AI" atau "Hemat token · tanpa …".
- v3.5.6: skill dikirim per bagian (`trimSkill`): inti (cara bicara, urutan tahap, batas wewenang, catatan chat)
  selalu; size, spesifikasi, ongkir, setelah bayar, foto pelanggan, komentar IG hanya bila dibutuhkan; bagian
  buatan pemilik selalu ikut. Katalog fokus ke produk/warna yang dibahas (`focusCatalog`) + satu baris produk lain;
  ragu/gambar/komentar IG → katalog lengkap. Riwayat 20 pesan. Perkiraan prompt ±10 ribu → ±6–7 ribu token.
- Claude: JSON lewat instruksi dalam satu panggilan (mode skema CLI memakai tool StructuredOutput = dua panggilan).
- Perapian oleh sistem (`app/beta3/reply_tidy.ts`, v3.5.4), tanpa bertanya ulang ke AI: JSON rusak diperbaiki
  (`repairJson`), teks biasa untuk pelanggan dipakai sebagai pesan (`bubblesFromText`), gaya bubble dirapikan
  (`tidyReply`). Hanya keluaran yang sama sekali tidak terbaca yang diulang.

## CS membalas sebagian & chat yang menunggu CS

- **CS membalas sebagian** (mis. menjawab DP & estimasi, tapi form order terlewat): sapuan memeriksa chat yang pesan terakhirnya dari CS/pemilik (≥ 3 menit, `AI_AFTER_HUMAN_MS`). Pesan pelanggan sejak balasan AI terakhir dikirim ke AI dengan catatan "jawab hanya poin yang belum dijawab CS; kosongkan bila semua sudah". Sekali per balasan CS.
- **Dialihkan AI ke CS tapi CS belum membalas** selama 20 menit (`AI_HANDOFF_GRACE_MS`): pesan baru pelanggan tetap dijawab AI dengan catatan bahwa hal yang diserahkan masih dicek tim. Mode CS yang dipilih manual tidak terpengaruh.

## Susulan menuju pembelian (v3.5.16)

Goal chat = order. Selama belum order/bayar, AI menulis `susulan` yang nyambung dengan produk/harga yang
barusan dibahas (20 menit; form 45 menit; transfer 3 jam; tidak malam). Tidak ada kalimat bawaan dari sistem:
susulan tanpa konteks terasa tidak nyambung. "Oke" yang tidak dibalas tetap mengirim susulan AI yang sudah
direncanakan (`quietAfter`). Trace: "Susulan HH:MM bila pelanggan diam · …".
