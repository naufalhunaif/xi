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

Batas waktu 800 ms per panggilan; ambang yakin per keputusan di `JEV_THRESHOLD`. Setiap keputusan
dicatat; pemilik menandai yang salah di Pengaturan → Jev (Akurasi 30 hari) dan bisa mematikan
keputusan satu per satu.

## CS membalas sebagian & chat yang menunggu CS

- **CS membalas sebagian** (mis. menjawab DP & estimasi, tapi form order terlewat): sapuan memeriksa chat yang pesan terakhirnya dari CS/pemilik (≥ 3 menit, `AI_AFTER_HUMAN_MS`). Pesan pelanggan sejak balasan AI terakhir dikirim ke AI dengan catatan "jawab hanya poin yang belum dijawab CS; kosongkan bila semua sudah". Sekali per balasan CS.
- **Dialihkan AI ke CS tapi CS belum membalas** selama 20 menit (`AI_HANDOFF_GRACE_MS`): pesan baru pelanggan tetap dijawab AI dengan catatan bahwa hal yang diserahkan masih dicek tim. Mode CS yang dipilih manual tidak terpengaruh.
