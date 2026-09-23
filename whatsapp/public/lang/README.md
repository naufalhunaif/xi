# Bahasa antarmuka WhatsApp Workspace

- `en.js`: English (default).
- `id.js`: Bahasa Indonesia.
- `../assets/i18n.js`: pemilihan bahasa dan penerapan terjemahan; tidak menyimpan kamus.

Kedua kamus memakai key yang sama. Pertahankan placeholder `{0}`, `{1}`, dan seterusnya. Tambahkan istilah baru di kedua file, bukan kamus terpisah pada tiap halaman. Panggil `window.waI18n.t(key, ...values)` untuk UI dinamis atau gunakan atribut `data-i18n` untuk label statis. Semua halaman memuat kamus sebelum script UI agar bahasa default tidak berkedip.

Bahasa tampilan tersimpan per browser. Jangan menandai nama pelanggan, produk, percakapan, catatan bisnis, atau isi skill sebagai teks antarmuka. Mengganti bahasa tidak menerjemahkan atau menulis ulang data tersebut. Kiriman WhatsApp bukan label antarmuka.

Setelah mengubah kamus, naikkan versi URL `lang/en.js` dan `lang/id.js` pada `resources/views/components/layout.edge` agar browser mengambil versi terbaru.
