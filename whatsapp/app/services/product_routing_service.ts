/** Only route the current shopping question, never an old order's approval state. */
export function isProductCombinationQuestion(text: string) {
  if (
    /\b(custom|refund|komplain|grosir|diskon|nego|borongan)\b/i.test(text) ||
    /\b(mau|ingin|minta|hubungkan|bicara|panggil)\b.{0,35}\b(cs|admin|owner|manusia)\b/i.test(text)
  )
    return false
  return (
    /\b(berapa|brp|harga|harganya|kena)\b/i.test(text) &&
    /\b(sama|dengan|sekalian|plus|dan|setelan|paket|set)\b|\+/i.test(text) &&
    /\b(celana|pants|jas|suit|rompi|vest|beskap|setelan)\b/i.test(text)
  )
}

export function productRoutingInstructions(active: boolean) {
  if (!active) return ''
  return `VALIDASI PERTANYAAN KOMBINASI PRODUK SAAT INI:
- Pelanggan sedang bertanya harga kombinasi barang, bukan meminta persetujuan custom. Identifikasi barang utama dari konteks terbaru. "Sama celana" belum berarti celana wajib berwarna sama; jangan menambahkan syarat senada/custom yang tidak disebut pelanggan.
- Periksa produk utama dan detail komponen lewat MCP. Hasil kosong untuk nama/warna persis bukan bukti semua kombinasi tidak tersedia. Perluas pencarian kategori/jenis, baca get_product kandidat komponen (harga per size, bahan, warna, stok), dan aturan harga/bundle serta komposisinya bila tersedia. list_products yang hanya berisi nama tanpa harga belum cukup untuk menyimpulkan harga komponen tidak ada. Jangan mengulang query kosong identik.
- Gunakan pola kategori/bahan/komposisi dari data bisnis aktual untuk menemukan pilihan yang relevan. Harga pasti hanya dari produk/varian yang sesuai atau aturan harga yang cakupannya terbukti cocok. Jika tidak ada bundle, jumlahkan harga komponen terverifikasi untuk kombinasi yang disebut jelas, bukan membuat diskon/paket baru. Harga contoh di skill/riwayat bukan sumber harga, dan kesamaan harga beberapa warna tidak membuktikan stok atau harga warna yang tidak tercatat.
- Bila pilihan komponen belum jelas, tetap decision reply: jawab bagian terverifikasi dan ajukan satu klarifikasi relevan atau tawarkan pilihan yang benar-benar tersedia. Jangan menetapkan celana senada/custom atau warna alternatif tanpa persetujuan pelanggan. Jangan mengalihkan ke CS hanya karena SKU warna/bundle persis tidak ditemukan. Jangan membuat cart atau menjanjikan custom dari pertanyaan harga saja.
- Pisahkan pertanyaan produk ini dari persetujuan/produksi order lama: jawab kebutuhan sekarang, pertahankan catatan tunggu untuk urusan lama saja. Gaya, format dan inisiatif tetap dari skill terimpor.`
}
