import type { AiDecision } from '#services/ai_service'
import { COLOR_INTENT_INSTRUCTIONS } from '#services/color_semantics'

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
})
const string = { type: 'string' }
export const VISUAL_MATCH_SCHEMA = object({
  status: { type: 'string', enum: ['matched', 'no_match', 'uncertain', 'not_product'] },
  targetImage: { type: 'integer', minimum: 1 },
  productId: string,
  server: string,
  findings: {
    type: 'array',
    maxItems: 32,
    items: object({
      feature: {
        type: 'string',
        enum: [
          'lapel',
          'trim',
          'buttons',
          'pockets',
          'construction',
          'pattern',
          'color',
          'fabric',
          'sleeves',
          'hem',
          'back',
          'fit',
          'accessories',
          'visibility',
          'other',
        ],
      },
      customer: {
        type: 'string',
        maxLength: 600,
        description:
          'Observasi rinci pada foto PELANGGAN untuk satu ciri, termasuk posisi/jumlah/bentuk jika terlihat; tulis tidak terlihat/tidak pasti jika bukti tidak cukup. Bukan penalaran atau dugaan.',
      },
      catalog: {
        type: 'string',
        maxLength: 600,
        description:
          'Observasi ciri yang sama dari foto KANDIDAT yang benar-benar dilihat. Jangan menyalin detail pelanggan; tidak terlihat/tidak ada foto harus dinyatakan.',
      },
      relation: { type: 'string', enum: ['match', 'different', 'unknown'] },
    }),
  },
})

export type VisualMatch = {
  status: 'matched' | 'no_match' | 'uncertain' | 'not_product'
  targetImage: number
  productId: string
  server: string
  findings: Array<{ feature: string; customer: string; catalog: string; relation: string }>
}
export type VisualCandidate = { id: string; server: string; imageUrls?: string[] }

export const VISUAL_CUSTOM_INQUIRY_INSTRUCTIONS = `LAYANAN FOTO REFERENSI:
Hasil pencocokan katalog adalah bukti identitas, bukan keputusan jenis layanan. Pada bisnis yang melayani custom, foto yang belum cocok tetap referensi permintaan yang bisa ditindaklanjuti; dapat berasal dari contoh custom/postingan toko yang belum masuk katalog. Jangan menyatakan pasti produk toko, pasti custom, bisa dibuat persis, harga atau ready tanpa bukti. Tidak cocok katalog sendiri bukan kesalahan layanan: jangan otomatis minta maaf atau membuka balasan dengan "model persis belum ditemukan dalam pemeriksaan katalog".
Pada bisnis yang mengutamakan custom, tentukan langkah dari maksud pelanggan, referensi, rincian yang diminta dan kondisi produk; jangan meminta pelanggan memilih jalur "custom atau ready" sebagai prasyarat layanan. Foto referensi tanpa permintaan ready langsung ditindaklanjuti dengan pemeriksaan desain/harga custom yang diperlukan, tanpa menawarkan "cek kemungkinan custom" atau meminta izin custom lagi. Jika model/warna/size persis sesuai kebutuhan dan stok terverifikasi ada, tawarkan ready; jangan mengganti modifikasi yang diminta dengan stok standar. Jika model katalog sesuai tetapi size kosong, periksa kelayakan pre-order dari aturan/keputusan LOKAL; bila sah sampaikan opsi beserta estimasi/syaratnya dan lanjut kebutuhan terdekat. Stok belum diketahui bukan stok kosong; no_match bukan bukti ready habis dan SKU mirip bukan pengganti referensi.
Permintaan eksplisit ready saja/tidak mau menunggu membatasi jalur: periksa ready yang sesuai, jangan otomatis mengalihkannya ke custom/PO. Preferensi, negasi, syarat, koreksi, deadline yang sudah disebut dan persetujuan sah tetap diikuti; jangan mengulang pilihan atau menanyakan waktu/acara tanpa kebutuhan. Jika diminta kedua opsi, periksa keduanya; jika bersyarat, periksa kondisi terlebih dahulu. Jalur pemeriksaan custom/PO bukan persetujuan membeli, kelayakan produksi, harga atau izin mengubah cart. Klarifikasi hanya detail nyata yang belum ada dan menentukan jawaban, misalnya bagian desain, ukuran atau jas/set; jangan memakai urutan form baku atau menanyakan data yang sudah tersedia.
Pertanyaan harga tetap tugas toko: harga sah yang tersedia dijawab; harga custom yang belum sah diperiksa melalui alur yang berwenang, jangan pinjam harga SKU mirip atau meminta seluruh form order. Foto dari postingan CS bukan bukti stok/harga/persetujuan; gunakan sumber yang sudah ada, minta caption/kode hanya jika benar-benar membedakan model. Foto tidak terbaca perlu satu klarifikasi visual, bukan kesimpulan custom. Data yang sudah lengkap langsung dipakai; jangan menunda dengan janji pemeriksaan tanpa tindakan. Untuk no_match/uncertain, pertanyaan/langkah relevan ditulis di message (initiative kosong); goal mengikuti pertanyaan terkirim atau pemeriksaan toko yang masih tertunda, bukan otomatis menunggu pelanggan membeli.`

export const VISUAL_MATCH_INSTRUCTIONS = `BATAS BUKTI VISUAL:
${COLOR_INTENT_INSTRUCTIONS}
Gambar 1 adalah referensi utama yang sedang dibahas. Gambar baru pelanggan menggantikan dugaan identitas gambar sebelumnya; jangan menyalin identitas dari catatan, cart, atau jawaban AI lama.
Bedakan sumber gambar secara ketat. Foto katalog MCP adalah KANDIDAT PEMBANDING, bukan foto pelanggan, bukan pilihan pelanggan, dan bukan bukti persetujuan membeli.
Amati referensi utama dahulu: lapel, list/piping/panel kontras, kancing, kantong, konstruksi. Baru bandingkan kandidat. Jangan meminjam detail kandidat untuk melengkapi bagian referensi yang tidak terlihat.
ANALISIS SANGAT DETAIL, disimpan sebagai observasi terstruktur findings, bukan uraian penalaran atau paragraf panjang untuk pelanggan:
- Lapel/kerah: bentuk notch/peak/shawl bila jelas, lekuk/titik puncak, proporsi lebar, simetri, sambungan kerah, lapisan/panel kontras. Jangan memaksakan nama lapel jika tertutup.
- List/trim: posisi tepat (tepi lapel, kerah, kantong), arah, warna relatif, lebar relatif dan kilap yang tampak. Bedakan list tipis dari seluruh panel lapel; kilap tidak membuktikan satin atau jenis bahan.
- Kancing/penutup: single/double-breasted jika terlihat, jumlah BARIS/KOLOM dan kancing depan yang benar-benar terlihat, letak, warna/bentuk; pisahkan kancing lengan dari kancing depan. Kancing tersembunyi tidak dihitung sebagai tidak ada.
- Kantong: dada dan pinggang secara terpisah, flap/welt/patch jika jelas, arah, posisi, jumlah yang terlihat, list/trim; tangan atau pose dapat menutupi flap.
- Konstruksi/potongan: panel depan, garis jahitan/dart, overlap, bentuk bukaan depan, ujung bawah/hem, panjang relatif; lengan/cuff dan bahu hanya dari bagian tampak. Jangan menentukan ukuran tubuh atau size dari foto dipakai.
- Tekstur/pola/warna: polos atau motif yang terlihat, tekstur/kilap, perbedaan pencahayaan. Komposisi kain, kualitas, merek, gramasi, elastisitas, lining, dan detail dalam tidak bisa dipastikan dari foto luar saja.
- Belakang: vent/belahan satu/dua/tanpa hanya jika bagian belakang terlihat cukup jelas; tampak depan saja HARUS tidak terlihat, bukan dianggap tanpa belahan.
- Foto dipakai: pisahkan produk dari kemeja/kaus, dasi, rompi, aksesori dan pose; jangan menganggap aksesori termasuk produk/paket. Catat detail yang tertutup, blur, crop, atau terlalu kecil pada visibility.
Cakup minimal lapel, trim, buttons, pockets, construction, color, back dan visibility untuk foto jas, termasuk batas ketidakpastiannya; tambahkan fabric/sleeves/hem/fit/pattern/accessories yang relevan. Boleh beberapa findings dengan feature sama untuk subdetail berbeda (mis. buttons depan dan buttons lengan). Untuk celana/rompi/produk lain sesuaikan ciri, jangan mengarang lapel jas. Setiap pengamatan harus terikat ke foto sumber dan dibandingkan pada ciri yang sama. Gunakan relation=unknown bila salah satu sisi tidak terlihat, bukan match/different.
Pengamatan detail disimpan agar pertanyaan lanjutan dapat memakai bukti lama. Jika pelanggan menanyakan detail yang belum tercatat atau meminta pemeriksaan lebih rinci, needsVisualInspection=true dan periksa gambar kembali. Balasan pelanggan cukup menjawab kebutuhannya sesuai skill; rincian observasi tersedia di detail proses.
Foto dipakai, jas terbuka, pose, pencahayaan, aksesori, dan detail tertutup bukan bukti perubahan model; bagian tak terlihat berstatus unknown. Caption/nama/logo hanya petunjuk pencarian, bukan bukti visual kecocokan. Untuk not_product, kosongkan productId, server dan findings.
Isi visualMatch: targetImage=1; matched hanya jika foto kandidat benar-benar dilampirkan dan sedikitnya dua ciri konstruksi pembeda terlihat cocok tanpa pertentangan. Warna/kategori/nama saja tidak cukup. Catat pengamatan referensi dan katalog TERPISAH di findings, bukan penalaran internal.
Jika tidak cocok dengan kandidat yang diperiksa, pilih no_match dan kosongkan productId/server. Jangan memilih kandidat paling mirip hanya karena tool mengembalikan produk. Untuk uncertain, productId/server juga kosong. Jika foto kurang jelas, pencarian belum memadai, atau gambar MCP gagal dimuat, pilih uncertain. Tidak menemukan kandidat bukan bukti seluruh katalog tidak punya model itu. not_product hanya untuk media yang bukan permintaan identifikasi/perbandingan produk, misalnya bukti transfer.
${VISUAL_CUSTOM_INQUIRY_INSTRUCTIONS}
Untuk no_match: lanjutkan jalur layanan dari maksud pelanggan sesuai aturan di atas; hasil pencocokan tetap dicatat internal, bukan alasan otomatis menolak atau handoff.
Untuk uncertain: jangan mengklaim cocok atau tidak tersedia; tanyakan satu detail penentu atau lanjutkan pemeriksaan yang diperlukan. Tidak perlu mengalihkan ke CS hanya karena kemiripan belum pasti.
Jangan mengirim foto kandidat pengganti, mengubah referensi menjadi SKU mirip, atau menawarkan harga SKU itu sebagai harga referensi. Untuk no_match/uncertain, kosongkan images, businessMedia dan initiative; cartIntent null kecuali draft custom berikut. Hasil visual bukan persetujuan order.
Draft custom: hanya bila pilihan pelanggan sudah jelas, boleh simpan modelType=custom, referenceMessageId persis ID referensi terbaru, unitPrice=null, tanpa SKU pengganti. Satu cart boleh berisi custom bersama item katalog ready/preorder yang dipilih terpisah dan memiliki bukti katalog sendiri atau sudah tersimpan terverifikasi. Pertahankan baris, status dan persetujuan masing-masing, jangan mengubah semua menjadi custom/PO atau menghapus pelengkap karena foto utama belum cocok. Persetujuan produksi/harga dan validasi tiap item tetap diperlukan; jangan menyalin persetujuan model sebelumnya.
Untuk matched, productId dan server harus menunjuk kandidat yang benar-benar dibandingkan. Jangan menyebut nama model lain sebagai identitas referensi. Semua gaya bahasa tetap mengikuti skill.`

/** A catalog result only proves existence. It does not prove the customer's photo matches it. */
export function verifyVisualDecision(
  decision: AiDecision,
  candidates: VisualCandidate[],
  referenceId = '',
  catalogItems: ReadonlyArray<{ productId: string; name: string }> = []
) {
  const match = decision.visualMatch
  if (!match || match.targetImage !== 1 || !Array.isArray(match.findings))
    throw new Error('Referensi gambar terbaru belum diverifikasi.')
  if (
    match.findings.length > 32 ||
    match.findings.some(
      (row) =>
        !row ||
        !['match', 'different', 'unknown'].includes(row.relation) ||
        typeof row.customer !== 'string' ||
        typeof row.catalog !== 'string' ||
        row.customer.length > 600 ||
        row.catalog.length > 600
    )
  )
    throw new Error(
      'Observasi visual harus rinci, terstruktur dan terbatas pada bukti yang terlihat.'
    )
  if (!['matched', 'no_match', 'uncertain', 'not_product'].includes(match.status))
    throw new Error('Status kecocokan visual tidak valid.')
  if (match.status === 'not_product') {
    if (match.productId || match.server || match.findings.length)
      throw new Error('Media bukan produk tidak boleh sekaligus mengklaim identitas katalog.')
    return decision
  }
  if (match.status === 'matched') {
    if (!candidates.some((row) => row.id === match.productId && row.server === match.server))
      throw new Error('Foto kandidat yang dipilih belum dibandingkan dengan referensi terbaru.')
    const candidate = candidates.find(
      (row) => row.id === match.productId && row.server === match.server
    )!
    if (
      candidate.imageUrls &&
      decision.images?.some((image) => !candidate.imageUrls!.includes(image.url))
    )
      throw new Error('Foto balasan bukan produk yang cocok dengan referensi terbaru.')
    const identifying = new Set(['lapel', 'trim', 'buttons', 'pockets', 'construction', 'pattern'])
    const matches = new Set(
      match.findings
        .filter(
          (row) =>
            identifying.has(row.feature) &&
            row.relation === 'match' &&
            typeof row.customer === 'string' &&
            row.customer.trim() &&
            typeof row.catalog === 'string' &&
            row.catalog.trim()
        )
        .map((row) => row.feature)
    )
    if (matches.size < 2 || match.findings.some((row) => row.relation === 'different'))
      throw new Error('Detail pembeda belum cukup cocok atau masih bertentangan.')
  } else {
    if (match.status === 'no_match' && !candidates.length)
      throw new Error('Belum ada foto kandidat yang diperiksa; hasil harus belum pasti.')
    const currentCustom = (item: NonNullable<AiDecision['cartIntent']>['items'][number]) =>
      item.modelType === 'custom' &&
      item.referenceMessageId === referenceId &&
      item.unitPrice === null
    // Keep the unmatched photo as its own custom line. Independently selected
    // companions need catalog evidence, not merely a candidate photo; the cart
    // service still validates their size, price, stock and local PO permission.
    const explicitCustom =
      decision.cartIntent?.action === 'sync' &&
      referenceId &&
      decision.cartIntent.items.some(currentCustom) &&
      decision.cartIntent.items.every(
        (item) =>
          currentCustom(item) ||
          ((item.modelType === 'catalog' || item.modelType === undefined) &&
            !item.referenceMessageId &&
            catalogItems.some(
              (source) => source.productId === item.productId && source.name === item.name
            ))
      )
    if (
      (decision.cartIntent && !explicitCustom) ||
      decision.images?.length ||
      decision.businessMedia?.length ||
      decision.initiative
    )
      throw new Error('Gambar belum cocok; penggantian produk atau cart tidak diizinkan.')
  }
  // A rejected/uncertain candidate is not a selected product, including in future notes.
  return match.status === 'matched'
    ? decision
    : {
        ...decision,
        visualMatch: { ...match, productId: '', server: '' },
      }
}

/** Completed means comparison finished, not that a match was found. */
export function visualResultTrace(match: VisualMatch, referenceId: string, comparedCount: number) {
  const labels = {
    matched: 'Produk katalog cocok dengan referensi',
    no_match: 'Tidak ada kandidat yang cocok',
    uncertain: 'Kecocokan produk belum dapat dipastikan',
    not_product: 'Media bukan untuk pencocokan produk',
  }
  return {
    key: 'visual-match',
    label: labels[match.status],
    status: 'completed' as const,
    detail: {
      result: match.status,
      referenceMessageId: referenceId || null,
      candidatesCompared: comparedCount,
      matchedProducts:
        match.status === 'matched' ? [{ id: match.productId, server: match.server }] : [],
      findings: match.findings,
    },
  }
}
