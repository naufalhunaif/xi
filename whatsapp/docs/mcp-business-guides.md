# Tutorial dan size chart melalui MCP

WhatsApp adalah konsumen data, bukan tempat upload panduan kedua. Kompatibilitas ini tidak membuat tool atau data baru pada MCP sumber. Berlaku untuk ChatGPT dan Claude melalui koneksi bisnis yang aktif dan terautentikasi.

## Tool baca

Gunakan salah satu kontrak sesuai skema yang dipublikasikan server:

- `list_tutorials`, `search_tutorials`, `get_tutorial`.
- `list_size_charts`, `search_size_charts`, `get_size_chart`.
- `list_records` / `get_record` dengan argumen `table`, `resource`, atau `entity` bernilai `tutorials`, `measurement_tutorials`, atau `size_charts`.

Respons boleh berupa `structuredContent`, `structured_content`, atau JSON di `content[type=text]`. Record tunggal, array, serta pembungkus `data`, `result`, `records`, `items`, `tutorials`, `size_charts`, `record`, `tutorial`, `size_chart` didukung. Hasil error/draft/nonaktif tidak boleh menjadi lampiran. ID harus unik dalam satu sumber, termasuk antara tutorial dan size chart.

## Contoh record

```json
{
  "id": "tutorial-waist-body",
  "kind": "tutorial",
  "title": "Mengukur lingkar pinggang badan",
  "category": "pants",
  "measurement": "waist",
  "basis": "body",
  "description": "Posisi meteran untuk lingkar pinggang badan, bukan lebar celana dibentangkan.",
  "media": { "url": "https://assets.example/tutorial-waist.mp4", "mime_type": "video/mp4" }
}
```

```json
{
  "id": "chart-pants-black-v2",
  "kind": "size_chart",
  "title": "Pants Black 2.0",
  "product_id": "pants-black-2",
  "category": "pants",
  "basis": "garment",
  "unit": "cm",
  "columns": { "waist": "Lingkar pinggang pakaian jadi", "length": "Panjang celana" },
  "rows": [{ "size": "30", "waist": 80, "length": 100 }],
  "media": { "url": "https://assets.example/chart-pants-black.jpg", "mime_type": "image/jpeg" }
}
```

Angka contoh hanya fixture kontrak, bukan ukuran katalog sebenarnya. `rows` dan definisi ukuran memungkinkan AI menjawab pertanyaan ukuran. Gambar/PDF saja bisa dikirim sebagai lampiran, tetapi tidak otomatis menjadi angka terverifikasi. Metadata video memungkinkan pemilihan jenis tutorial, bukan klaim telah menonton seluruh video atau membaca audionya.

Untuk media, `title`/`name` dan `id` wajib. Alias URL: `media.url`, `media_url`, `video_url`, `image_url`, `file_url`. MIME opsional: `media.mime_type`, `mime_type`, `mime`. Tutorial: MP4; chart: JPEG/PNG/WebP/PDF; maksimum 16 MB/file. MIME HTTP dan isi file harus cocok. Size chart tanpa media tetap dapat digunakan untuk jawaban teks dari tabel MCP, tetapi tidak dipilih sebagai lampiran.

URL harus unduhan langsung HTTPS, termasuk signed URL bila privat. Redirect/halaman login/HTML ditolak. Aplikasi tidak meneruskan token OAuth MCP ke host file. Alamat privat, metadata cloud, DNS rebinding dan kredensial di URL ditolak. HTTP localhost hanya diizinkan bila origin persis sama dengan MCP lokal yang dikonfigurasi. URL relatif mengikuti resolusi standar terhadap URL MCP; lebih baik gunakan URL absolut atau root-relative.

## Keputusan AI

```json
{"businessMedia":[{"server":"business_store","id":"tutorial-waist-body","caption":""}]}
```

Maksimum tiga panduan per giliran, hanya dari hasil tool sukses giliran itu. ID lintas sumber tidak saling menggantikan; bukan URL yang dikarang AI. Aplikasi memuat dan memvalidasi semua lampiran sebelum mulai mengirim balasan, menyimpan salinan media dengan namespace nomor WhatsApp, dan memeriksa ulang status koneksi/room sebelum setiap bubble. Tidak mengirim pada `handoff`/`silent`. Kegagalan unduhan tidak diganti tautan dan tidak dianggap sukses.

Unggah ulang `skills/cs-cart-order/SKILL.md` di Pengaturan → Skills agar panduan pemilihan terbaru digunakan; skill tersimpan tidak ditimpa saat deploy. Jika MCP sumber belum memiliki tool/data di atas, pengelola project sumber perlu menyediakannya. Tidak ada upload atau mutasi MCP dari fitur ini.
