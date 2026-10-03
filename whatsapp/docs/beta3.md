# Beta 3 — salinan Beta 2 yang terisolasi

Tujuan: mengembangkan jalur ramping tanpa terpengaruh Beta 1/2. Semua yang
khas Beta 3 hidup di tempatnya sendiri; hanya infrastruktur bersama yang dipakai
(sesi WhatsApp, penyimpanan pesan/kontak, trace, koneksi MCP di Data bisnis,
rekening, antrean pesan keluar).

| Bagian | Beta 2 | Beta 3 |
|---|---|---|
| Kode | `app/services/lean/*` | `app/beta3/*` (alias `#beta3/*`) |
| Tabel | `whatsapp_lean_*`, `whatsapp_contacts.chat_note` | `whatsapp_beta3_*` termasuk `whatsapp_beta3_chats` (catatan chat sendiri) |
| Skill | `skills/cs-inti` → `cs-inti` | `skills-beta3/beta3-cs-inti` → `beta3-cs-inti` (terpasang otomatis) |
| Contoh CS awal | `resources/lean/cs_examples.json` | `resources/beta3/cs_examples.json` |
| Halaman | `/lean`, Order (mode beta2) | `/beta3`, Order (mode beta3) |
| API | `/api/lean/*` | `/api/beta3/*` |
| Perintah | `lean:catalog`, `lean:mcp` | `beta3:catalog`, `beta3:mcp` |
| Fase usage | `lean-reply`, `lean-ciri` | `beta3-reply`, `beta3-ciri` |
| Panel keranjang | panel lean | panel beta3 |

Mode dipilih di Pengaturan → Perilaku → **Mode AI** (Beta 1 / Beta 2 / Beta 3),
saling eksklusif; disimpan di `whatsapp_settings.lean_mode` + `beta3_mode`.
Titik sambung ke worker hanya di `commands/whatsapp_listen.ts`
(`runBeta3Turn`, `runBeta3Nudge`, sinkron katalog, grup produksi, pembelajaran
dari jawaban CS) dan pembersihan chat (`deleteBeta3ChatData`).

Sumber data MCP Beta 3 dipilih sendiri (ikon roda gigi di /beta3) — state-nya
terpisah, walau daftar koneksinya sama dengan Data bisnis.

Perilaku saat ini identik dengan Beta 2 pada commit pemisahan; perubahan
berikutnya di Beta 3 tidak menyentuh Beta 2, dan sebaliknya.

## CS membalas sebagian & chat yang menunggu CS

- **CS membalas sebagian** (mis. menjawab DP & estimasi, tapi form order terlewat): sapuan memeriksa chat yang pesan terakhirnya dari CS/pemilik (≥ 3 menit, `AI_AFTER_HUMAN_MS`). Pesan pelanggan sejak balasan AI terakhir dikirim ke AI dengan catatan "jawab hanya poin yang belum dijawab CS; kosongkan bila semua sudah". Sekali per balasan CS.
- **Dialihkan AI ke CS tapi CS belum membalas** selama 20 menit (`AI_HANDOFF_GRACE_MS`): pesan baru pelanggan tetap dijawab AI dengan catatan bahwa hal yang diserahkan masih dicek tim. Mode CS yang dipilih manual tidak terpengaruh.
