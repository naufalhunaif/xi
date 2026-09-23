/** Reusable procedures, never customer answers, facts or authorization. */
export const PATTERN_VERSION = 'patterns-v2'
export type PatternRoute =
  'catalog' | 'visual' | 'sizing' | 'custom' | 'cart' | 'payment' | 'shipping' | 'service'

const patterns = [
  {
    id: 'catalog',
    routes: ['catalog'],
    purpose: 'Memilih, membandingkan atau menanyakan produk/harga/stok.',
    steps:
      'Tentukan produk/varian dari rujukan asli; baca katalog yang masih berlaku; jawab kebutuhan dan bantu satu pilihan berikutnya.',
    variables: 'productId, variant, quantity, price, stock',
    recheck:
      'Produk/varian/jumlah berubah: cocokkan ulang produk, harga dan stok; jangan menyalin angka pelanggan lain.',
  },
  {
    id: 'fit',
    routes: ['sizing', 'catalog'],
    purpose: 'Menentukan ukuran katalog atau menanggapi rekomendasi ukuran.',
    steps:
      'Bedakan pemakai dan jenis pakaian; pakai ukuran/badan yang sudah ada; minta hanya data kurang; verifikasi Fit Advisor sebelum rekomendasi; penerimaan ukuran bukan checkout.',
    variables: 'wearer, productId, height, weight, measurements, size, fitPreference',
    recheck:
      'Pemakai, ukuran badan atau jenis pakaian berubah: hasil fit lama tidak berlaku otomatis.',
  },
  {
    id: 'custom-size',
    routes: ['custom', 'sizing', 'catalog', 'cart'],
    purpose: 'Ukuran khusus di luar katalog.',
    steps:
      'Pisahkan preferensi fit dari ukuran custom; ikat ukuran pada item/pemakai; cari persetujuan CS asli untuk ukuran yang diminta; simpan rincian lewat cartIntent tervalidasi; lanjutkan data yang kurang.',
    variables: 'itemId, wearer, measurements, size, sizeApprovalMessageId',
    recheck:
      'Perubahan ukuran/pemakai perlu pemeriksaan persetujuan ukuran; persetujuan model tidak menyetujui ukuran.',
  },
  {
    id: 'catalog-design',
    routes: ['custom', 'sizing', 'catalog', 'cart'],
    purpose: 'Mengubah warna, lapel, bahan atau detail produk katalog.',
    steps:
      'Pertahankan produk dasar dan rincian yang tidak diubah; identifikasi perubahan; cocokkan bukti CS asli dengan rincian itu; simpan productionDetails/modelConsent lewat validasi utama; lanjutkan kebutuhan nyata berikutnya.',
    variables: 'itemId, productId, color, lapel, material, buttons, designNotes, modelConsent',
    recheck:
      'Perubahan warna/lapel/bahan/desain memerlukan pemeriksaan cakupan persetujuan model dan harga; ukuran yang tidak diubah tetap disimpan.',
  },
  {
    id: 'reference-design',
    routes: ['visual', 'custom', 'sizing', 'catalog', 'cart'],
    purpose: 'Model dari gambar atau referensi pelanggan.',
    steps:
      'Periksa referensi asli dan kecocokan visual; bedakan produk katalog dari model khusus; pakai bukti model/harga CS yang terkait gambar dan permintaan; jangan mewarisi identitas dari kemiripan saja.',
    variables: 'referenceMessageId, image, productId, designDetails, modelConsent, priceEvidence',
    recheck: 'Foto atau ciri yang dirujuk berubah: periksa visual dan cakupan persetujuan lagi.',
  },
  {
    id: 'cart-details',
    routes: ['cart', 'custom', 'sizing', 'catalog', 'payment', 'shipping'],
    purpose: 'Melanjutkan pilihan menjadi rincian pesanan lengkap.',
    steps:
      'Pertahankan pilihan yang sudah sah; petakan data yang belum ada; setelah pilihan jelas minta satu data penerima/tujuan yang diperlukan tanpa syarat konfirmasi lanjut; siapkan rekap setelah lengkap; otorisasi transaksi diperiksa terpisah.',
    variables: 'items, quantity, recipient, destination, shipping, approvals',
    recheck:
      'Ubah hanya field yang diminta; jangan sync hanya untuk parafrase. Persetujuan ukuran atau pengumpulan alamat bukan persetujuan rekap.',
  },
  {
    id: 'shipping',
    routes: ['shipping', 'cart', 'custom', 'catalog'],
    purpose: 'Mengisi tujuan atau memilih ongkir.',
    steps:
      'Gunakan tujuan tersimpan yang benar; minta pembeda bila ambigu; hitung tarif untuk tujuan/berat/layanan aktual; simpan pilihan yang diterima melalui jalur utama.',
    variables: 'destinationCode, recipient, weight, service, shippingCost',
    recheck:
      'Tujuan, berat atau layanan berubah: periksa tarif lagi. Kota yang mirip belum tentu kode tujuan yang sama.',
  },
  {
    id: 'payment',
    routes: ['payment', 'cart', 'custom', 'catalog', 'shipping'],
    purpose: 'Rekap, DP, saldo, laporan transfer atau pelunasan.',
    steps:
      'Gunakan total dan ledger aktual; bedakan laporan transfer dari dana terverifikasi; periksa penerimaan rekap/fingerprint dan semua approval sebelum checkout; hindari nominal/pembayaran ganda.',
    variables: 'orderId, cartVersion, recap, amountDue, ledger, paymentProof, confirmation',
    recheck:
      'Perubahan rincian/total/tujuan/ledger dapat membatalkan quote atau penerimaan lama; transaksi dan verifikasi dana tidak pernah diambil dari cache pola.',
  },
  {
    id: 'order-progress',
    routes: ['service', 'shipping', 'payment', 'cart', 'custom', 'catalog', 'sizing', 'visual'],
    purpose: 'Menanyakan progres produksi atau kiriman pesanan yang sudah ada.',
    steps:
      'Tentukan order yang dirujuk; baca status operasional terverifikasi; bedakan rencana/estimasi dari kejadian nyata; tangani kekurangan status tanpa mengubah draft lain.',
    variables: 'orderId, operations, shipment, tracking, verifiedAt',
    recheck:
      'Order atau status operasional berbeda: baca sumbernya; pola tidak menyimpan status terkirim, tanggal tiba atau resi.',
  },
  {
    id: 'after-sales',
    routes: ['service', 'shipping', 'payment', 'cart', 'custom', 'catalog', 'sizing', 'visual'],
    purpose: 'Keluhan, retur, penukaran atau pengembalian dana.',
    steps:
      'Pahami masalah dan order terkait; kumpulkan bukti kurang sesuai skill; periksa kebijakan/otorisasi; jangan menjanjikan persetujuan atau refund dari kasus sebelumnya.',
    variables: 'orderId, issue, evidence, eligibility, humanDecision',
    recheck:
      'Kondisi barang, tanggal, jenis custom dan keputusan CS harus diperiksa pada kasus sekarang.',
  },
  {
    id: 'change-order',
    routes: ['cart', 'custom', 'sizing', 'catalog', 'payment', 'shipping'],
    purpose: 'Mengubah, menunda atau membatalkan pilihan/pesanan.',
    steps:
      'Bedakan pertanyaan, larangan mengubah, penundaan dan pembatalan; tentukan field/item/order yang dimaksud; pertahankan detail lain; hitung ulang bukti yang terdampak sebelum tindakan.',
    variables: 'target, changedFields, previousValues, requestedValues, conditions',
    recheck:
      'Pertanyaan perkembangan bukan perubahan atau pembatalan; jangan menerapkan operasi dari pola tanpa maksud dan bukti baru yang cocok.',
  },
] as const

export type PatternId = (typeof patterns)[number]['id']
export const PATTERN_IDS = patterns.map((pattern) => pattern.id)
export function validPatternIds(value: unknown): value is PatternId[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= patterns.length &&
    value.every((id) => PATTERN_IDS.includes(id))
  )
}
export function patternRoutes(ids: PatternId[]): PatternRoute[] {
  return [
    ...new Set(
      patterns
        .filter((pattern) => ids.includes(pattern.id))
        .flatMap((pattern) => [...pattern.routes])
    ),
  ]
}
export function patternProcedures(ids: PatternId[]) {
  return patterns
    .filter((pattern) => ids.includes(pattern.id))
    .map((pattern) => structuredClone(pattern))
}
export function patternInstructions() {
  return `POLA PENANGANAN ${PATTERN_VERSION}: prosedur pakai ulang, tidak berisi jawaban/fakta/otorisasi pelanggan.
Pahami maksud dan beberapa kebutuhan dari pesan serta konteks asli, termasuk typo/dialek, negasi, syarat dan rujukan. Pilih pola secara semantik melalui read_business_skill(patternIds); kata kunci/rute awal hanya petunjuk. Variabel dan bukti diisi dari percakapan/state/tool SAAT INI, tidak diwarisi dari cache. Setelah membaca pola, jalankan hanya langkah yang prasyaratnya terpenuhi. Jangan mengulangi langkah/data yang sudah sah. Skill asli mengungguli panduan pola; semua validasi transaksi tetap berlaku.
Jika belum cocok/ambigu, baca aturan asli yang perlu atau all=true; needsFullSkillContext=true bila masih kurang. Jangan memaksa satu pola untuk beberapa maksud atau menganggap kemiripan sebagai persetujuan. Perubahan field memicu pemeriksaan dependensi pola, bukan penghapusan rincian lain. Pemilihan pola tidak mengirim pesan atau menjalankan tindakan.
POLA [id,maksud]: ${JSON.stringify(patterns.map(({ id, purpose }) => [id, purpose]))}`
}
