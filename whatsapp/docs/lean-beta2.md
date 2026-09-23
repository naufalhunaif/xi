# Beta 2 — jalur ramping

Tujuan: jawaban seefektif CS manusia dengan biaya ±5–10rb token per balasan
(sebelumnya 16rb pada mode compact sampai 400rb–2jt pada mode biasa).

## Prinsip

AI hanya menulis kata-kata. Angka, tahap, dan verifikasi dikerjakan kode.

| Tugas | Beta 1 | Beta 2 |
|---|---|---|
| Tahu produk/harga/size/foto | AI memanggil MCP tiap giliran | **Digest katalog** teks, diimpor ke tabel, ditempel ke prompt |
| Aturan gaya & tahap | 9–12 skill (40–95rb token) | **Satu skill `cs-inti`** (~1,6rb token) + **contoh jawaban CS asli** yang dipilih per pesan |
| Memori pelanggan | JSON klaim + aturan, ditulis AI | Catatan ≤10 baris per nomor, ditulis kode saat order disetujui |
| Catatan chat | goal + state cart + memori | 6 baris teks yang ditulis AI sendiri (`catatan`) |
| Form order | AI parse + cart sync + evidence | **Kode** membaca form → order menunggu CS di halaman Beta 2 |
| Ongkir, total, rekening | AI hitung + verifikasi MCP | CS isi subtotal + ongkir → **kode** kirim total & rekening |
| Bukti transfer | AI review | AI jawab "kami cek dulu"; CS tekan Lunas → kode kirim "prosess ya" |
| Evaluasi / learning / skill edit | tiap percakapan | mati; jawaban CS saat takeover otomatis jadi contoh |
| Tool / MCP saat membalas | ya, banyak fase | **tidak ada** — satu panggilan, satu schema kecil |

Jalur lama tetap ada: matikan toggle **Beta 2 · Jalur ramping** di Pengaturan →
Perilaku balasan untuk kembali ke pipeline beta 1 (tanpa mengubah data).

## Cara menjalankan

1. `node ace app:init` (tabel `whatsapp_lean_*` dan kolom `lean_mode` dibuat otomatis).
2. Pengaturan → Skill: hapus skill lama, import **hanya** `skills/cs-inti/SKILL.md`.
   Skill lain boleh tetap ada, tapi jalur ramping hanya membaca `cs-inti`.
3. Halaman **Beta 2** (`/lean`): impor katalog (JSON), periksa digest dan jumlah tokennya.
   Atau: `node ace lean:catalog path/katalog.json --replace`.
4. Pengaturan → Pembayaran: isi rekening aktif (dipakai kode saat kirim total).
5. Restart web dan worker. Detail proses tetap menampilkan ukuran prompt, token, dan keputusan.

## Alur satu order

```
pelanggan: "Mau order jasnya"        → AI: "Siap bos, mau model apa?"
pelanggan: "Tuxedo brown"            → AI: "belum ada fotonya bos, kalau mau bisa di buatkan ya" (dari digest: bahan ada)
pelanggan: "pesan, size M"           → AI: "mau jas aja atau sekalian celananya?"
pelanggan: "jas aja"                 → AI: "untuk pengiriman kemana ya bos?"
pelanggan: "Bogor"                   → AI: kirim template form
pelanggan: (form)                    → KODE: simpan order #12 menunggu CS
                                       AI: konfirmasi size dari TB/BB bila perlu, lalu "ongkir & total saya kabari sebentar"
CS di halaman Beta 2: subtotal 485000, ongkir 19000, layanan "one day"
                                     → KODE: kirim "Total 485.000 + 19.000 = 504.000 bos" + rekening
pelanggan: (bukti transfer)          → AI: "siap bos, kami cek dulu ya"
CS: tekan Lunas                      → KODE: "Terimakasih bos, prosess ya"; catatan pelanggan diperbarui
```

## Format data katalog yang paling mudah di-digest

Satu baris per **varian yang bisa dipesan** (produk + warna), bukan per SKU/size.
Field yang dipakai digest (nama lain seperti `nama/warna/harga/ready/foto/bahan` juga dikenali):

```json
[
  {
    "product": "Tuxedo",
    "color": "Black",
    "category": "Tuxedo",
    "price": 485000,
    "sizesReady": "S M XL",
    "sizesAll": "XS S M L XL XXL",
    "photoUrl": "https://chameleoncloth.com/img/tuxedo-black-1.jpg",
    "materialAvailable": true,
    "fit": "slim fit",
    "note": ""
  },
  {
    "product": "Tuxedo",
    "color": "Brown",
    "category": "Tuxedo",
    "price": 485000,
    "sizesReady": "",
    "photoUrl": null,
    "materialAvailable": true
  }
]
```

Saran penataan data di web agar ekspor ini otomatis dan digest tetap kecil:

- **Nama produk tanpa warna** (`Tuxedo`, `Basic Suit`, `Bescap Cross Placket`) dan **warna sebagai kolom terpisah** dengan ejaan konsisten (`Black`, bukan `black`/`hitam`/`BLK`). Digest menulis `Produk - Warna` persis seperti CS menyebutnya.
- **Satu harga per varian** (bukan per size) — kalau ada size dengan harga beda (Big size), jadikan varian sendiri: `Tuxedo | Black Big`.
- **Stok per size → diringkas jadi `sizesReady`** oleh web saat ekspor (`stok > 0`). AI tidak butuh angka stok.
- **`materialAvailable`** = ada bahan warna itu di gudang material → AI boleh bilang "bisa dibuatkan". Ini yang menggantikan handoff "warna tidak ada".
- **Satu foto utama per varian** (`photoUrl`). Foto lain tidak perlu; AI hanya mengirim satu foto per varian.
- **`category`** untuk mengelompokkan digest (Jas, Tuxedo, Celana, Beskap, Rompi). Urutkan sesuai yang paling sering ditanya.
- **`fit`/`note`** pendek (≤ 40 karakter): `slim fit`, `bahan wol`, `include dasi kupu`. Jangan deskripsi panjang; itu membengkakkan digest.
- Nonaktifkan varian dengan `active: false` daripada menghapusnya, agar nama lama tetap dikenali.
- Ekspor otomatis: MCP chameleoncloth-main sudah punya tool `catalog_digest` yang mengembalikan persis format ini. Sinkron dari worker: `node ace lean:catalog` (cron 30–60 menit). Tanpa MCP: cron memanggil `POST /api/lean/catalog` (`{"items": [...], "replace": true}`). Snapshot 6 jam pun masih aman karena kode memverifikasi ulang saat CS mengisi total.

Ukuran: digest dikelompokkan per produk + harga, warna ditulis menurut keadaannya
(ready / foto / tanpa foto). Katalog Chameleon 328 varian ≈ 1,8rb token, 120 baris.
Sinkron dari MCP selalu tarik penuh (87 KB JSON, bukan token AI) dan hanya bila
`version` berubah — incremental tidak perlu.

## Spesifikasi pesanan (pengganti cart) dan grup produksi

AI menulis ulang lembar `spesifikasi` tiap giliran: produk, warna, size/ukuran
badan, dan setiap detail custom persis kata pelanggan (kerah, saku, list,
kancing, bahan, warna bagian). Disimpan per nomor (`whatsapp_lean_specs`),
ditempel ke prompt giliran berikutnya, ikut ke order saat form masuk, dan tampil
di halaman Beta 2 (sudah terisi di kolom rincian saat CS mengisi total).

Saat CS tekan **Lunas**: order diberi nomor `PO-YYYYMMDD-NNN`, dikirim worker ke
**grup produksi default** (Order → Grup produksi default) sebagai satu pesan
(teks spesifikasi + foto produk bila ada), tanpa alamat/telepon/bukti transfer.
Status grup (antre/terkirim/gagal) dan tombol kirim ulang ada di halaman Beta 2.
Spesifikasi lalu dikosongkan; ringkasan order masuk ke catatan pelanggan.

## MCP satu pintu — dipanggil kode, bukan model

`chameleoncloth-main/mcp` sekarang punya `catalog_digest`, `fit_advisor`,
`check_destination`, `check_shipping_rates`, `track_awb` (tiga terakhir memakai
library Shipping_api/Fit_advisor yang sama dengan storefront → connect.alogaritm).
Beta 2 tidak punya koneksi sendiri: ia memakai koneksi MCP di Pengaturan →
Data bisnis (tambah URL, tekan Hubungkan/OAuth). Di Beta 2 tinggal pilih
sumbernya lewat ikon roda gigi (atau `node ace.js lean:mcp --slug=chameleoncloth`);
kalau hanya satu koneksi yang terhubung, itu dipakai otomatis. Kode memanggilnya
pada event:

- pelanggan menyebut tinggi/berat → `fit_advisor` → "REKOMENDASI SIZE: XS (86%)"
  masuk prompt (dicache per nilai);
- pelanggan tanya ongkir bebas ("ongkir ke cinyawang berapa") → `check_destination`
  lalu `check_shipping_rates`; tujuan ambigu/terlalu luas → AI tanya kecamatan,
  dan jawaban lanjutan ("kalo ke jakarta?", "mampang") dikenali 30 menit;
- form order masuk → `check_shipping_rates` (kecamatan + kota/kode pos) → pilihan
  ongkir masuk prompt (AI menanyakan layanan) dan jadi tombol isi cepat di
  halaman Beta 2 / panel Pesanan;
- `node ace.js lean:catalog` tanpa argumen menarik katalog dari koneksi itu (cron).

Uji: `node ace.js lean:mcp --test=fit_advisor --input='{"type":"suit","height":161,"weight":43}'`.

## Skill terpasang otomatis

`whatsapp/skills/cs-inti/SKILL.md` ikut di build dan di-upsert ke tabel skill
saat worker/web mulai (= tiap deploy) bila isinya berubah sejak sinkron terakhir
(hash di `whatsapp_lean_state`). Skill Beta 1 di folder yang sama tidak ikut —
impor manual bila Beta 1 dipakai lagi. Tidak perlu import manual untuk cs-inti;
suntingan lewat UI bertahan selama filenya tidak berubah.

Katalog, TOKO, dan BAHAN TERSEDIA ditarik worker otomatis 20 detik setelah
tersambung lalu tiap 30 menit (`if_version`, jadi murah bila tidak berubah);
tombol Sync katalog tetap ada untuk memaksa sekarang. Versi katalog di MCP ikut
berubah saat profil toko/material/format digest berubah.

## Ciri model (foto pelanggan vs katalog)

Digest katalog memuat ciri tiap warna dalam kurung siku, mis. `White (S M L)
[kerah shawl hitam, 1 kancing]`. Sumbernya dua: kolom "Ciri model" di Admin
produk chameleoncloth (menang bila diisi), atau hasil analisis AI dari foto
katalog — otomatis di latar setelah **Sync katalog** (sekali per foto, fase
`lean-ciri`, ±1–2k token per foto; `node ace.js lean:catalog --describe` untuk
menjalankan manual). Skill `cs-inti` mewajibkan AI menilai warna & kerah di foto
pelanggan dulu sebelum menyamakan dengan katalog.

## Halaman

- **Order** (leanMode): tabel order lean dengan pencarian (nomor, nama, telepon,
  produk, kecamatan) dan tab status; klik baris → panel detail (alamat, pesanan,
  catatan chat, rincian total, tarif ongkir yang tersedia sebagai tombol isi
  cepat, alasan total otomatis gagal, tombol Kirim total / Batalkan / Lunas /
  Kirim ke grup, Buka chat). Halaman Order Beta 1 tetap dipakai saat leanMode
  mati.
- **Beta 2**: Katalog (status + Lihat digest + Impor JSON dari file) dan Contoh
  jawaban CS (tabel + pencarian + dialog Tambah contoh). Sumber data lewat ikon
  roda gigi.

## Total otomatis setelah form

Saat form order masuk, AI mengisi field `order` (rincian item dengan nama
persis KATALOG + harga, subtotal, layanan ongkir yang dipilih pelanggan). Kode
memverifikasi: tiap baris rincian harus cocok satu produk+warna di katalog
(harga XXL-3XL dan qty "2x" dihitung), jumlahnya harus sama dengan subtotal AI,
dan layanan harus ada di tarif yang tersimpan pada order. Lolos → sistem
mengirim pesan total + rekening tepat setelah bubble AI, order jadi
`awaiting_payment`, tahap `tunggu_bayar`. Gagal satu saja → order tetap
`pending` menunggu CS seperti semula (alasan tercatat di Process details:
"Total menunggu CS · …").

## Susulan tanpa AI

AI tidak lagi menempelkan bubble "jadi lanjut yang X bos?" di tiap giliran.
Kalimat itu ditulis ke field `susulan`; kode menjadwalkannya 10 menit dan
mengirimnya **hanya bila** pesan terakhir di room masih balasan AI (pelanggan
diam, CS tidak ambil alih). Maksimal 2 susulan per chat, nol token.

## Sinkron katalog hemat

`catalog_digest` MCP mengembalikan `version` (sidik jari `MAX(updated_at)` +
jumlah baris produk/varian/material — ikut berubah saat stok dipotong checkout,
`adjust_stock`, atau edit admin). `node ace.js lean:catalog --url … --token …`
mengirim `if_version` versi tersimpan: kalau sama, server hanya menjawab
`{unchanged: true}` dan digest lama dipakai; kalau beda, seluruh katalog ditarik
sekali. Jadwalkan tiap 10–15 menit lewat cron; `--force` untuk tarik ulang paksa.

## Contoh jawaban CS

`resources/lean/cs_examples.json` diisi otomatis saat tabel kosong. Tiap pesan
pelanggan diambil 8 contoh paling mirip (irisan kata kunci + tag tahap). Jawaban
CS saat mengambil alih chat ikut masuk (`source: takeover`); hapus yang tidak
bagus dari halaman Beta 2. Ini pengganti "AI belajar sendiri" tanpa prompt
membesar.

## Yang tidak ada di beta 2 (sengaja)

Cart otomatis, saldo/ledger, approval custom via AI, Fit Advisor, pencocokan
gambar dengan katalog, susulan terjadwal, evaluasi per percakapan, skill edit
otomatis, MCP saat membalas. Bila salah satunya dibutuhkan lagi, tambahkan
sebagai langkah kode pada event (form/transfer), bukan ke prompt balasan.

## Uji

`node ace test unit --files=tests/unit/lean.spec.ts` — form order, digest,
pemilihan contoh, ukuran prompt (< 10rb token dengan 120 varian + 30 pesan),
parsing keluaran, memori pelanggan.
