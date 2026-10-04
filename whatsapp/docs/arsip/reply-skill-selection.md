# Pemilihan skill untuk balasan pelanggan

Audit 20 September 2026 terhadap 12 skill ekspor menemukan dua snapshot gabungan
yang secara eksplisit melarang pemakaian bersama modul aktif. Runtime sebelumnya
tetap mengirim keduanya. Salinan lama juga memuat aturan yang sudah diralat modul
aktif, termasuk tambahan biaya custom dan respons saat pelanggan menanyakan
identitas bot.

`selectReplySkills` menjalankan pemilihan sumber sebelum routing kebutuhan:

- `chameleon-cs-gabungan` dan `chameleon-cs-gabungan-2` dikecualikan hanya jika
  deklarasi status nonaktif ditemukan dan seluruh modul pengganti tersedia.
  Modul tambahan yang disebut melalui `(asal: skill ...)` juga wajib tersedia.
- Modul tidak dikenal dan snapshot tanpa deklarasi tersebut tetap dipertahankan.
- `cs-chameleon-eval` dengan deklarasi khusus evaluasi bulanan/perubahan skill
  dikecualikan dari balasan pelanggan. Sumber untuk pekerjaan evaluasi tetap utuh.
- Isi modul aktif tidak diringkas atau ditulis ulang. Riwayat, memori, aturan
  aplikasi, pemeriksaan bukti MCP, model, serta skema keluaran tetap berlaku.
- Fallback dan analisis visual lanjutan menggunakan pilihan sumber aktif yang
  sama. Semua sumber asli tetap menjadi bagian fingerprint cache visual sehingga
  perubahan kebijakan membatalkan penggunaan cache lama.

Detail trace `skill-routing.sourceSelection` memuat jumlah sumber, sumber yang
dikecualikan, alasan, modul pengganti, dan ukuran karakter. Tidak ada isi skill
atau data pelanggan di detail pemilihan ini. Berkas unduhan tidak diubah dan
tidak perlu diimpor ulang jika isi skill pada server sama dengan ekspor ini.

`retainedBundles` menjelaskan snapshot yang tetap dipakai: deklarasi nonaktif
tidak ditemukan atau daftar modul pengganti belum lengkap. Detail `runtime`
mencatat versi kebijakan, PID worker, dan SHA-256 pendek file `ai_service` yang
sedang digunakan. Fingerprint source TypeScript berbeda dari hasil build JavaScript;
bandingkan fingerprint trace dengan runtime worker, bukan source.

Jika ringkasan aktivitas belum menjelaskan versi yang berjalan, jalankan dari
checkout server setelah mengambil source terbaru (tidak perlu deploy dahulu):

```sh
node deploy/whatsapp-reply-diagnostic.mjs
```

Pemeriksaan ini hanya membaca revisi checkout, file source/build `current`, serta
working directory proses web/worker yang terlihat melalui `/proc`. Tidak membaca
`.env`, database, log pelanggan, atau argumen proses ke output; tidak menghentikan
worker. `processes: []` tidak membuktikan worker berhenti karena izin `/proc` bisa
membatasi pengamatan. Script deploy sendiri tidak melakukan `git pull`.

Pencatatan trace kini menggabungkan snapshot yang menunggu penulisan database:
seluruh langkah tetap ada di snapshot terbaru, tetapi database lambat tidak lagi
menyebabkan antrean satu query untuk setiap event lama. Ini tidak mengatasi database
yang mati atau membuktikan penyebab `TRACE_UPDATES_STALE`; status tersebut tetap
berarti aktivitas tidak mendapat pembaruan, bukan konfirmasi provider masih bekerja.

## Pengukuran lokal

| Instruksi skill | Karakter | Estimasi token |
| --- | ---: | ---: |
| Semua sumber lama | 349.461 | 94.449 |
| Semua modul aktif | 152.782 | 41.292 |

Pengurangan **56,3%** berlaku pada instruksi skill ter-render, termasuk pembungkus
dan instruksi semantik. Ini bukan total prompt atau tagihan provider. Percakapan,
skema keluaran, aturan aplikasi lain, skema MCP, gambar, dan pengulangan provider
dihitung terpisah. Angka token memakai estimator lokal 3,7 karakter/token.

Contoh katalog, foto, checkout, dan pesan ambigu pada ekspor ini memilih seluruh
modul aktif: penghematan routing tambahan di bawah ambang 25%, sehingga tidak
membuka jalur fallback karena skill belum terbaca. Batas ini mencegah penghematan
kecil memicu analisis ulang yang mahal. Kumpulan skill lain masih dapat memakai
routing dan pembacaan modul sesuai kebutuhan.

Ulangi audit tanpa AI, database, atau pengiriman pesan:

```sh
cd whatsapp
node --import=@poppinss/ts-exec scripts/audit_reply_skills.mjs /path/to/skills
```

## Validasi dan pengamatan setelah deploy

Uji unit memeriksa sumber aktif utuh, sumber tidak dikenal, modul hilang/kosong,
deklarasi lama/CRLF, modul tambahan, serta lingkup evaluasi. Uji pipeline memakai
provider tiruan dan database sementara, termasuk pembacaan MCP lokal dan fallback:
snapshot yang dinonaktifkan tidak boleh muncul kembali di prompt provider.

Setelah build dan restart worker, verifikasi `sourceSelection` menunjukkan 12
sumber menjadi 9 aktif untuk ekspor ini. Bandingkan sampel percakapan dengan
jenis kebutuhan serupa sebelum/sesudah: token provider per balasan berhasil,
durasi p50/p95, frekuensi fallback, validasi keluaran gagal, ketepatan harga/custom,
konteks reply/quote, dan kasus menunggu tanpa pesan baru. Periksa hasil awal sehari
setelah deploy dan tinjau ulang setelah tujuh hari. Uji lokal membuktikan mekanisme
pemilihan, bukan jaminan kualitas jawaban model atau persentase penghematan produksi.
