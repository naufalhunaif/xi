# PR ke depan (belum dikerjakan)

Daftar ide yang sudah dibahas dan disetujui untuk nanti. **Jangan dikerjakan tanpa persetujuan pemilik.** Saat salah satu dikerjakan, pindahkan ke catatan rilis dan hapus dari sini.

---

## 1. Ads Manager (Meta Ads) — iklan → chat → order

**Tujuan:** tahu iklan mana yang benar-benar menghasilkan penjualan, bukan cuma klik, lalu AI memberi saran perbaikan.

**Ide utama**
- Chat dari iklan Click-to-WhatsApp / iklan ke DM Instagram biasanya membawa penanda iklan (ID iklan) di pesan pertama. Perlu dicek dulu apakah ikut terbawa lewat WhatsApp Web (Baileys: `contextInfo.externalAdReply.sourceId`) dan webhook Instagram (`referral.ad_id`).
- Simpan penanda itu per room. Order dari room tersebut dihitung sebagai hasil iklan.
- **ROAS asli** = omzet order sungguhan ÷ biaya iklan.

**Halaman "Iklan"** (pola tabel seperti Order)
- Tabel kolom: iklan + gambar, status, biaya, jangkauan, klik/CTR, chat masuk, biaya per chat, order, omzet, ROAS asli.
- Filter rentang 7 / 14 / 30 hari. Tab Aktif · Dijeda · Semua.
- Detail di panel kanan:
  - materi iklan
  - grafik harian biaya vs chat vs order
  - umur/jenis kelamin/kota/penempatan
  - daftar chat & order dari iklan itu, bisa diklik ke room
- Analisis AI, mencari:
  - iklan boros (chat banyak, order nol)
  - iklan jenuh (frekuensi tinggi, CTR turun)
  - biaya per chat naik
  - peluang menaikkan budget
  - kualitas chat (serius tanya ukuran/harga vs "info" lalu hilang)
  - rekomendasi materi berikutnya

**Tahapan**
1. Baca data (`ads_read`), tanpa mengubah apa pun di Ads Manager.
2. Sambungkan ke chat & order (ROAS asli).
3. Opsional: jeda iklan / ubah budget dari aplikasi (`ads_management`), selalu dengan konfirmasi.

**Persiapan & batasan**
- Koneksi terpisah dari Instagram: **Facebook Login** + izin `ads_read`, tombol "Hubungkan Meta Ads". Untuk akun iklan sendiri biasanya cukup mode tester.
- Chat lama (sebelum fitur aktif) tidak punya penanda iklan.
- Orang yang chat manual tanpa klik iklan tidak tercatat.
- Angka Meta bisa tertinggal beberapa jam.

---

## 2. Caption AI yang tidak kaku

**Masalah:** setiap caption mengikuti satu pola (hook → isi → ajakan DM → hashtag), jadi monoton dan cenderung formal.

**Rencana** (prioritas 1–4, nomor 5 menyusul)
1. **Profil gaya** dari semua caption lama: sapaan khas ("men", "bos"), panjang, emoji, gaya hook, hashtag yang biasa dipakai, kata yang tidak pernah dipakai. Bisa dibaca dan diubah pemilik, diperbarui tiap minggu.
2. **Variasi pola**, dipilih sesuai foto dan data yang terbukti ramai:
   - tebak harga / pertanyaan
   - cerita momen (akad, wisuda, kondangan)
   - detail produk singkat
   - tips padu padan
   - behind the scene
   - satu kalimat + emoji
3. **3 pilihan sekaligus** (pendek / santai / bercerita), pemilik tinggal pilih.
4. **Belajar dari koreksi**: bila caption AI diubah sebelum disimpan, perbedaannya diingat untuk caption berikutnya.
5. **Contoh caption favorit** dari brand fashion lain, ditempel manual. AI mempelajari pola, bukan menyalin. Membaca akun lain langsung butuh Facebook Login (Business Discovery).

**Aturan yang dilonggarkan**
- Hashtag & ajakan tidak wajib dan bervariasi.
- Daftar kata klise dilarang ("Hadir dengan…", "Dapatkan sekarang juga", "kualitas premium terbaik").
- Baris pertama pendek, sebelum terpotong "…lebih banyak".
- Testimoni hanya dari pelanggan asli.

---

## 3. Upload foto/video lebih cepat

- Foto dikecilkan di browser sebelum dikirim (lebar 1440 px, JPEG). Contoh: ±6 MB jadi ±0,5 MB.
- Carousel dikirim 2–3 file sekaligus; urutan slide tetap dijaga.
- (Persentase unggah sudah ada sejak v3.4.156.)

---

## 4. Menyambungkan nomor lama (riwayat ±300 ribu chat)

**Ditunda atas permintaan pemilik ("belum siap").** Sebelum menyambungkan nomor besar:

- **A. Mode per nomor:** AI / Hanya CS / AI untuk pelanggan baru saja. Saat ini kontak dari riwayat default ke mode AI dan sapuan bisa membalas chat 48 jam terakhir.
- **B. Batasi impor riwayat** (mis. 30–90 hari terakhir saja).
- **C. Inbox ringan:** daftar chat dibatasi/paging, query tanpa ROW_NUMBER atas semua pesan dan tanpa subquery per chat.
- **D. Filter per nomor** di inbox.
