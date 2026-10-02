# Pelajaran dari chat CS (kumpulan, belum diterapkan)

Contoh chat CS asli yang dikumpulkan pemilik sebagai bahan perbaikan AI (skill `skills-beta3/beta3-cs-inti/SKILL.md`).
**Jangan diterapkan ke skill sampai pemilik bilang "update".** Setelah contoh cukup, rangkum semua menjadi satu perubahan skill dengan contoh sebelum/sesudah.

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
