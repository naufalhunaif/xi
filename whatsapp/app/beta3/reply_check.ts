// v3.6.78 — Pemeriksa balasan (Jev): setiap draf balasan AI dinilai SEBELUM dikirim — foto cocok dengan
// yang diucapkan, maksud pelanggan terjawab, fakta (harga/warna/size) sesuai katalog, tidak mengulang.
// Ada masalah → AI menulis ulang sekali dengan catatan pemeriksa. Penilaian memakai MAKSUD (Jev), bukan
// daftar kata; pemeriksaan pasti (foto yang tidak ada di katalog) tetap dilakukan kode.
import { withPromoPrices, type ChatPromo } from '#beta3/promos'
import { askJev, confident, jevOn, logDecision, maskPii, scoreLevel, type JevAnswer } from '#beta3/jev'
import { findCatalogVariant, type LeanCatalogRow } from '#beta3/catalog_service'
import type { LeanDecision, LeanHistoryRow } from '#beta3/prompt'
import type { TokenUsage } from '#services/usage_service'
import { runLeanProvider, type LeanProviderSettings } from '#beta3/provider'

export type CheckIssue = {
  code: 'foto_tidak_ada' | 'foto_kurang' | 'foto_lebih' | 'foto_beda' | 'tidak_menjawab' | 'fakta_salah' | 'mengulang'
  detail: string
}

export const CHECK_LABEL: Record<CheckIssue['code'], string> = {
  foto_tidak_ada: 'Foto yang dipilih tidak ada di katalog',
  foto_kurang: 'Balasan menyebut/menjanjikan foto yang tidak ikut dikirim',
  foto_lebih: 'Ada foto yang tidak disebut dan tidak diminta',
  foto_beda: 'Foto berbeda dengan produk/warna yang dibahas',
  tidak_menjawab: 'Maksud pelanggan belum terjawab',
  fakta_salah: 'Harga/warna/size tidak sesuai katalog',
  mengulang: 'Mengulang pertanyaan/isi yang sudah dibahas',
}

const fold = (value: string) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Caption foto yang benar-benar akan terkirim (varian katalog yang punya foto). */
export function photoCaptions(rows: LeanCatalogRow[], labels: string[]) {
  const sent: string[] = []
  const missing: string[] = []
  for (const label of labels) {
    const row = findCatalogVariant(rows, label)
    if (!row?.photoUrl) {
      missing.push(label)
      continue
    }
    const caption = row.color ? `${row.product} - ${row.color}` : row.product
    if (!sent.includes(caption)) sent.push(caption)
  }
  return { sent, missing }
}

/**
 * Fakta katalog yang relevan untuk dinilai: produk yang disebut di pesan pelanggan, riwayat singkat,
 * balasan, atau foto. Satu baris per produk: harga, warna (✓ = ada foto, [size ready]).
 */
export function relevantFacts(rows: LeanCatalogRow[], texts: string[], limit = 8) {
  const haystack = fold(texts.join('\n'))
  const active = rows.filter((row) => row.active)
  const names = [...new Set(active.map((row) => row.product))].sort((a, b) => b.length - a.length)
  let blanked = haystack
  const picked: string[] = []
  for (const name of names) {
    const key = fold(name)
    if (key.length < 3 || !blanked.includes(key)) continue
    picked.push(name)
    blanked = blanked.split(key).join(' ')
    if (picked.length >= limit) break
  }
  return picked.map((name) => {
    const variants = active.filter((row) => row.product === name)
    const prices = [...new Set(variants.map((row) => row.price).filter(Boolean))].map((price) => Number(price).toLocaleString('id-ID'))
    const big = [...new Set(variants.map((row) => (String(row.note || '').match(/XXL[^;]*?(\d{1,3}(?:\.\d{3})+)/) || [])[1]).filter(Boolean))]
    const colors = variants
      .map((row) => `${row.color}${row.photoUrl ? ' ✓' : ''}${row.sizesReady ? ` [${row.sizesReady}]` : ''}`)
      .join(', ')
    return `${name} (${variants[0]?.category || ''}): ${prices.join('/')}${big.length ? ` (XXL+ ${big.join('/')})` : ''} | warna: ${colors}`.slice(0, 900)
  })
}

const recentLines = (history: LeanHistoryRow[]) =>
  history
    .filter((row) => !row.current && (row.body || row.mediaType))
    .slice(-6)
    .map((row) => `${row.direction === 'in' ? 'Pelanggan' : 'Toko'}: ${row.mediaType ? `[${row.mediaType === 'image' ? 'foto' : row.mediaType}] ` : ''}${maskPii(String(row.body || '')).slice(0, 240)}`)

/**
 * Nilai draf balasan. Mengembalikan masalah yang yakin (ambang keputusan "cek_balasan"); kosong = aman.
 * Jev mati/gagal → hanya pemeriksaan pasti (foto tidak ada di katalog).
 */
/**
 * v3.6.86 — Harga per warna (pasti, dari katalog): "setelan Sage Green mulai 705.000" padahal setelan Sage
 * Green termurah 955.000 (seri lain). Satu warna + satu harga di bubble yang sama → harga tidak boleh di
 * bawah harga termurah warna itu (untuk jenis yang disebut: setelan / jas).
 */
export function colorPriceIssues(pesan: string[], rows: LeanCatalogRow[]): CheckIssue[] {
  const colors = [...new Set(rows.map((row) => fold(row.color).replace(/\s*\d+(?:\.\d+)?$/, '')).filter((color) => color.length >= 3))]
  const issues: CheckIssue[] = []
  for (const bubble of pesan) {
    const text = ` ${fold(bubble)} `
    const named = colors.filter((color) => text.includes(` ${color} `) || text.includes(` ${color},`) || text.includes(` ${color}.`))
    const distinct = named.filter((color) => !named.some((other) => other !== color && other.includes(color)))
    // Ongkir, DP, diskon, potongan bukan harga barang.
    const prices = [...bubble.matchAll(/\b(\d{2,3})(?:[.,]000\b|\s?(?:rb|ribu|k)\b)/gi)]
      .filter((match) => !/(ongkir|ongkos|kirim|dp|diskon|potongan|hemat|kurang|tambah|selisih)\D{0,18}$/i.test(bubble.slice(0, match.index)))
      .map((match) => Number(match[1]) * 1000)
    if (distinct.length !== 1 || new Set(prices).size !== 1) continue
    const set = /\bsetelan\b|\bjas\b.{0,25}\bcelana\b|\bsama celana\b/.test(text)
    const candidates = rows.filter(
      (row) =>
        row.price &&
        fold(row.color).replace(/\s*\d+(?:\.\d+)?$/, '') === distinct[0] &&
        (set ? /^setelan\b/i.test(row.product) : true)
    )
    if (!candidates.length) continue
    const lowest = Math.min(...candidates.map((row) => Number(row.price)))
    if (prices[0] < lowest)
      issues.push({
        code: 'fakta_salah',
        detail: `${CHECK_LABEL.fakta_salah}: harga ${set ? 'setelan ' : ''}${candidates[0].color} termurah ${lowest.toLocaleString('id-ID')} (${candidates.find((row) => row.price === lowest)?.product}), bukan ${prices[0].toLocaleString('id-ID')}.`,
      })
  }
  return issues
}

/**
 * v3.6.112 — Harga per produk (pasti, dari katalog): uji 88 chat — "Premium Basic Suit satu set 705.000" (setelannya
 * 955.000), "jas aja tetap 700.000" (harga setelan). Satu produk + satu harga dalam satu kalimat → harga harus milik
 * produk itu (jas) atau setelannya; "setelan/satu stel/jas+celana" → harga setelan; "jas aja" → harga jas.
 */
export function productPriceIssues(pesan: string[], rows: LeanCatalogRow[]): CheckIssue[] {
  const active = rows.filter((row) => row.active !== false && Number(row.price) > 0)
  const bigOf = (row: LeanCatalogRow) => {
    const hit = String(row.note || '').match(/XXL(?:-\d?X*L)?\s+([\d.]+)/)
    return hit ? Number(hit[1].replace(/\./g, '')) : 0
  }
  const pricesOf = (name: string) => {
    const set = new Set<number>()
    for (const row of active)
      if (fold(row.product) === name) {
        set.add(Number(row.price))
        const big = bigOf(row)
        if (big) set.add(big)
      }
    return set
  }
  const bases = [...new Set(active.map((row) => fold(row.product)).filter((name) => !/^setelan\b/.test(name) && name.length >= 4))].sort((a, b) => b.length - a.length)
  const issues: CheckIssue[] = []
  const DOT = '\u2024'
  for (const bubble of pesan) {
    const sentences = bubble.replace(/(\d)\.(?=\d{3}\b)/g, `$1${DOT}`).split(/(?<=[.!?\n])/).map((part) => part.split(DOT).join('.'))
    for (const sentence of sentences) {
      if (/\b(total|ongkir|ongkos|dp|diskon|potongan|tambah\w*|selisih|sisa|\+|x\s*\d|kali|lusin|pcs)\b/i.test(sentence)) continue
      const prices = [...sentence.matchAll(/\b(\d{1,3}(?:\.\d{3})+)\b/g)].map((match) => Number(match[1].replace(/\./g, '')))
      if (new Set(prices).size !== 1 || prices[0] < 50_000) continue
      let text = ` ${fold(sentence).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `
      const named: string[] = []
      for (const name of bases)
        if (text.includes(` ${name} `)) {
          named.push(name)
          text = text.split(` ${name} `).join(' ')
        }
      if (named.length !== 1) continue
      const name = named[0]
      // Seri disebut terpisah ("Tuxedo premium") tapi nama produk yang cocok tanpa seri → ragu, lewati.
      const series = (fold(sentence).match(/\b(premium|signature)\b/g) || []).filter((word) => !name.includes(word))
      if (series.length) continue
      const jas = pricesOf(name)
      const setelan = pricesOf(`setelan ${name}`)
      const wantSet = /\b(setelan|stelan|satu\s+stel|1\s+stel|set|full\s*set|jas\s+(?:dan|sama|\+|&)\s+celana)\b/i.test(sentence)
      const jasOnly = /\b(jas|jasnya)\s+(?:aja|saja|doang|nya\s+aja)\b|\bhanya\s+jas\b|\btanpa\s+celana\b/i.test(sentence)
      const allowed = wantSet && setelan.size ? setelan : jasOnly && jas.size ? jas : new Set([...jas, ...setelan])
      if (!allowed.size || allowed.has(prices[0])) continue
      const label = active.find((row) => fold(row.product) === name)?.product || name
      const list = (values: Set<number>) => [...values].sort((a, b) => a - b).map((value) => value.toLocaleString('id-ID')).join(' / ')
      issues.push({
        code: 'fakta_salah',
        detail: `${CHECK_LABEL.fakta_salah}: harga ${label}${jas.size ? ` jas ${list(jas)}` : ''}${setelan.size ? `, setelan ${list(setelan)}` : ''} (KATALOG), bukan ${prices[0].toLocaleString('id-ID')}.`,
      })
    }
  }
  return issues
}

const words = (text: string) => new Set(fold(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2))
/**
 * v3.6.112 — Mengulang isi balasan toko sebelumnya (uji: daftar 8 model yang sama dikirim dua giliran berturut-turut,
 * daftar ukuran diulang kata per kata). Bubble panjang yang ≥ 80% sama dengan pesan toko 6 terakhir → mengulang.
 */
export function repeatIssues(pesan: string[], history: LeanHistoryRow[]): CheckIssue[] {
  const previous = history.filter((row) => row.direction === 'out' && !row.current && String(row.body || '').length >= 80).slice(-6)
  for (const bubble of pesan) {
    // Rekening, total, dan format order memang boleh dikirim ulang bila diminta lagi.
    if (bubble.length < 80 || /\b(rek|rekening|total|nama\s*:|alamat\s*:)/i.test(bubble)) continue
    const mine = words(bubble)
    for (const row of previous) {
      const theirs = words(String(row.body || ''))
      const shared = [...mine].filter((word) => theirs.has(word)).length
      if (shared / Math.max(1, Math.min(mine.size, theirs.size)) >= 0.8)
        return [{ code: 'mengulang', detail: `${CHECK_LABEL.mengulang}: isi ini sudah dikirim toko sebelumnya ("${String(row.body).slice(0, 80)}…"). Jangan kirim ulang daftar/rincian yang sama; jawab pertanyaan barunya saja, singkat.` }]
    }
  }
  return []
}

const NOT_READY = /\b(kosong|habis|pre[\s-]?order|belum ready|tidak ready|gak ready|ga ready|belum ada stok|stoknya (?:lagi )?kosong)\b/i
/**
 * v3.6.89 — Stok ready (pasti, dari katalog): "jas Maroon size L pre order, stok kosong" padahal Basic Suit
 * Maroon size L ready. Satu warna + satu size + klaim kosong → dicek ke sizes ready varian warna itu.
 */
export function readyClaimIssues(pesan: string[], rows: LeanCatalogRow[]): CheckIssue[] {
  const base = (color: string) => fold(color).replace(/\s*\d+(?:\.\d+)?$/, '')
  const colors = [...new Set(rows.map((row) => base(row.color)).filter((color) => color.length >= 3))]
  const products = [...new Set(rows.map((row) => fold(row.product)))].sort((a, b) => b.length - a.length)
  const issues: CheckIssue[] = []
  for (const bubble of pesan) {
    if (!NOT_READY.test(bubble)) continue
    const text = ` ${fold(bubble).replace(/[^a-z0-9.\s-]/g, ' ')} `
    const said = (color: string) =>
      [color, ...(COLOR_ALIASES[color] || [])].some((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:nya)?\\b`).test(text))
    const named = colors.filter(said)
    const distinct = named.filter((color) => !named.some((other) => other !== color && other.includes(color)))
    const sizes = [...new Set([...text.matchAll(/\bsize\s+(xs|s|m|l|xl|xxl|[2-5]xl)\b/g)].map((match) => match[1].toUpperCase()))]
    if (distinct.length !== 1 || sizes.length !== 1) continue
    const product = products.find((name) => text.includes(` ${name} `))
    const set = /\bsetelan\b|\bset\b/.test(text)
    const hit = rows.find(
      (row) =>
        base(row.color) === distinct[0] &&
        (product ? fold(row.product) === product : set ? /^setelan\b/i.test(row.product) : !/^(setelan|vest|rompi|celana)\b/i.test(row.product)) &&
        String(row.sizesReady || '').toUpperCase().split(/[\s,/]+/).includes(sizes[0])
    )
    if (hit)
      issues.push({
        code: 'fakta_salah',
        detail: `${CHECK_LABEL.fakta_salah}: ${hit.product} ${hit.color} size ${sizes[0]} READY (stok ada), bukan kosong/pre-order.`,
      })
  }
  return issues
}

export async function checkReply(input: {
  jid: string
  customerText: string
  history: LeanHistoryRow[]
  decision: Pick<LeanDecision, 'pesan' | 'foto' | 'serah_cs'>
  rows: LeanCatalogRow[]
  extraFacts?: string[]
  /** Ada → pemeriksa AI ikut menilai bersamaan dengan Jev (v3.6.79). */
  settings?: LeanProviderSettings
  /** v3.6.101 — keadaan chat (resi, pembayaran, harga yang sudah disebut, data pelanggan). */
  chatState?: string
  /** v3.6.120 — promo biasa yang berlaku: harga promo tidak dianggap salah. */
  promos?: ChatPromo[]
}): Promise<{ issues: CheckIssue[]; jev: boolean; ai?: boolean }> {
  const issues: CheckIssue[] = []
  const { sent, missing } = photoCaptions(input.rows, input.decision.foto || [])
  if (missing.length)
    issues.push({ code: 'foto_tidak_ada', detail: `Tidak ada foto katalog untuk: ${missing.join(', ')}. Pakai nama varian persis dari KATALOG yang bertanda foto.` })
  if (input.decision.serah_cs || !input.decision.pesan.length) return { issues, jev: false }
  issues.push(
    ...colorPriceIssues(input.decision.pesan, withPromoPrices(input.rows, input.promos || [])),
    ...readyClaimIssues(input.decision.pesan, input.rows),
    ...productPriceIssues(input.decision.pesan, withPromoPrices(input.rows, input.promos || [])),
    ...repeatIssues(input.decision.pesan, input.history)
  )
  const jevAllowed = await jevOn('cek_balasan')
  if (!jevAllowed && !input.settings) return { issues, jev: false }
  const recent = recentLines(input.history)
  const facts = [
    ...relevantFacts(input.rows, [input.customerText, ...recent, ...input.decision.pesan, ...sent]),
    ...(input.extraFacts || []),
  ]
  const state = {
    pesan_pelanggan: maskPii(input.customerText).slice(0, 1200),
    percakapan_sebelumnya: recent,
    balasan: input.decision.pesan.map((bubble) => maskPii(bubble).slice(0, 900)),
    foto_dikirim: sent,
    fakta_katalog: facts,
    ...(input.chatState ? { keadaan_chat: maskPii(input.chatState).slice(0, 1500) } : {}),
  }
  const reviewing = input.settings ? aiReview(input.settings, state, input.jid).catch(() => null) : Promise.resolve(null)
  const answers = !jevAllowed ? null : await askJev(
    'cek-balasan',
    state,
    {
      foto: {
        type: 'choice',
        instructions:
          'Bandingkan balasan dengan foto_dikirim (caption "Produk - Warna") dan pesan_pelanggan. Apakah foto yang dikirim cocok dengan yang diucapkan balasan dan yang diminta pelanggan?',
        criteria: {
          sesuai: 'Cocok: foto sama dengan yang disebut/diminta, atau tidak ada foto dan balasan tidak menjanjikan foto',
          kurang: 'Balasan menjanjikan foto (mis. "ini fotonya", "ini semua warnanya") atau pelanggan minta LIHAT foto, tapi foto yang dimaksud tidak ada atau hanya sebagian. Sekadar menyebut daftar warna (tanpa menjanjikan foto tiap warna) BUKAN kurang',
          lebih: 'Ada foto yang tidak disebut balasan dan tidak diminta pelanggan',
          beda: 'Foto berbeda produk atau warna dengan yang dibahas balasan',
        },
      },
      jawab: {
        type: 'score',
        instructions:
          'Seberapa tepat balasan menanggapi MAKSUD pesan_pelanggan (pahami maksudnya walau bahasanya tidak baku, salah ketik, atau tidak langsung)?',
        criteria: [
          'Salah tangkap maksud / tidak nyambung',
          'Sebagian; ada pertanyaan atau permintaan yang terlewat',
          'Tepat menanggapi semua maksudnya',
        ],
      },
      fakta: {
        type: 'choice',
        instructions:
          'Periksa harga, warna, size ready, dan info toko di balasan terhadap fakta_katalog (✓ = ada foto, [..] = size ready).',
        criteria: {
          sesuai: 'Semua yang disebut balasan sesuai fakta_katalog, atau balasan tidak menyebut fakta',
          bertentangan: 'Ada harga, warna, atau size yang bertentangan dengan fakta_katalog',
          tidak_bisa_dinilai: 'fakta_katalog tidak memuat yang disebut balasan',
        },
      },
      ulang: {
        type: 'noul',
        instructions:
          'Apakah balasan menanyakan lagi hal yang sudah dijawab pelanggan di percakapan_sebelumnya, atau mengulang isi balasan toko sebelumnya tanpa perlu?',
      },
    },
    { timeoutMs: 3000, jid: input.jid }
  )
  const review = await reviewing
  const add = (issue: CheckIssue) => {
    if (!issues.some((item) => item.code === issue.code)) issues.push(issue)
  }
  for (const item of review?.issues || []) add(item)
  if (!answers) return { issues, jev: false, ai: Boolean(review) }
  const logged = `Pelanggan: ${state.pesan_pelanggan}\nBalasan: ${state.balasan.join(' / ')}\nFoto: ${sent.join(', ') || '-'}`
  const sure = (answer: JevAnswer | undefined) => confident('cek_balasan', answer)
  const foto = answers.foto
  if (foto?.type === 'choice' && foto.choice !== 'sesuai' && sure(foto)) {
    const code = foto.choice === 'kurang' ? 'foto_kurang' : foto.choice === 'lebih' ? 'foto_lebih' : 'foto_beda'
    issues.push({ code, detail: `${CHECK_LABEL[code]} (foto: ${sent.join(', ') || 'tidak ada'}).` })
  }
  const jawab = answers.jawab
  if (jawab?.type === 'score' && sure(jawab) && scoreLevel(jawab, 3) < 3)
    issues.push({ code: 'tidak_menjawab', detail: `${CHECK_LABEL.tidak_menjawab} — baca lagi maksud pesan pelanggan, jawab semua pertanyaan/permintaannya.` })
  const fakta = answers.fakta
  if (fakta?.type === 'choice' && fakta.choice === 'bertentangan' && sure(fakta))
    issues.push({ code: 'fakta_salah', detail: `${CHECK_LABEL.fakta_salah} — cocokkan lagi dengan KATALOG/POLA HARGA.` })
  const ulang = answers.ulang
  if (ulang?.type === 'noul' && ulang.noul >= 0.5 && sure(ulang))
    issues.push({ code: 'mengulang', detail: `${CHECK_LABEL.mengulang}.` })
  for (const [key, answer] of Object.entries(answers))
    await logDecision({
      jid: input.jid,
      decision: 'cek_balasan',
      answer: answer as JevAnswer,
      used: sure(answer as JevAnswer),
      detail: key,
      input: logged,
    })
  return { issues, jev: true, ai: Boolean(review) }
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    masalah: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jenis: { type: 'string', enum: ['foto_kurang', 'foto_lebih', 'foto_beda', 'tidak_menjawab', 'fakta_salah', 'mengulang'] },
          penjelasan: { type: 'string' },
        },
        required: ['jenis', 'penjelasan'],
      },
    },
  },
  required: ['ok', 'masalah'],
}

/**
 * v3.6.79 — Pemeriksa AI (model biasa, prompt kecil) di samping Jev: uji 8 Okt menunjukkan Jev
 * menilai "sesuai" pada foto yang kurang dan salah tangkap "item" (= hitam). Hanya masalah jelas.
 */
async function aiReview(settings: LeanProviderSettings, state: Record<string, unknown>, jid: string) {
  const reply = await runLeanProvider(
    settings,
    {
      system: [
        'Kamu pemeriksa balasan CS toko jas SEBELUM dikirim ke pelanggan. Balas HANYA JSON sesuai skema.',
        'Periksa: (1) maksud pesan_pelanggan terjawab — pahami bahasa tidak baku, daerah, salah ketik, singkatan, dan sebutan warna (item/hitem/ireng = hitam, dongker = navy, marun = maroon, krem = cream, abu = gray, pth = putih); (2) foto_dikirim PERSIS sama dengan produk & warna yang disebut atau dijanjikan balasan — warna yang dijanjikan fotonya ("ini fotonya …") tapi tidak ada fotonya = foto_kurang (sekadar menyebut daftar warna tanpa menjanjikan foto tiap warna BUKAN foto_kurang), foto yang tidak disebut/diminta = foto_lebih, produk/warna berbeda = foto_beda; pelanggan minta semua warna tapi hanya sebagian padahal fakta_katalog punya foto (✓) lainnya = foto_kurang; (3) harga, warna, size ready, dan TOTAL gabungan (mis. jas + celana = harga setelan) sesuai fakta_katalog; angka ongkir harus dari data alat di fakta_katalog — tanpa data, menanyakan info yang kurang itu BENAR; (4) tidak menanyakan ulang yang sudah dijawab; data yang sudah diberi pelanggan (size, nomor celana, alamat) diakui dulu; (5) tidak mengarang = fakta_salah: alasan (mis. kenaikan harga), janji layanan (mis. dikabari saat diantar), klaim (terlaris), atau paket yang tidak ada di fakta_katalog (setelan hanya untuk produk berlabel Setelan); lama/tanggal pengerjaan beda dengan ESTIMASI PRODUKSI, atau bilang "belum ada fotonya" padahal fakta_katalog bertanda ✓ = fakta_salah; size yang disarankan beda dengan "Paling dekat" di PERBANDINGAN SIZE CHART = fakta_salah; menyatakan pesanan/data "belum tercatat" atau meminta ulang data yang ada di percakapan_sebelumnya = mengulang; pertanyaan yang jawabannya ada di data (bahan, lama jadi, alamat) malah dibalas pertanyaan balik = tidak_menjawab; pelanggan mau datang saat toko tutup (lihat Waktu sekarang & jam buka) tapi tidak diberi tahu = tidak_menjawab; (6) pesan bukan soal produk (keluhan website, tawaran kerja sama/jasa dari bisnis lain) dijawab dengan topik lain = tidak_menjawab; (7) keadaan_chat = hal yang SUDAH terjadi di chat (resi, pembayaran, harga yang sudah disebut, data pelanggan): balasan yang membantahnya = fakta_salah, yang menanyakannya ulang atau bilang "saya cek dulu" padahal sudah ada = mengulang.',
        'Laporkan hanya masalah yang JELAS. Bila balasan benar atau kamu ragu → ok=true, masalah=[]. penjelasan: satu kalimat bahasa Indonesia yang menyebut apa yang harus diubah.',
      ].join('\n'),
      user: JSON.stringify(state),
    },
    [],
    'beta3-check-ai',
    REVIEW_SCHEMA,
    // v3.6.93: model ringan ChatGPT (median 5 dtk); Claude Haiku lewat jalur ini median 34 dtk.
    { jid, tier: 'light', providers: ['chatgpt'] }
  )
  const parsed = JSON.parse(reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1)) as {
    ok?: boolean
    masalah?: Array<{ jenis?: string; penjelasan?: string }>
  }
  const codes = new Set(Object.keys(CHECK_LABEL))
  const issues: CheckIssue[] = parsed.ok === true
    ? []
    : (parsed.masalah || [])
        .filter((item) => item.jenis && codes.has(item.jenis))
        .map((item) => ({ code: item.jenis as CheckIssue['code'], detail: `${CHECK_LABEL[item.jenis as CheckIssue['code']]}: ${String(item.penjelasan || '').slice(0, 300)}` }))
  return { issues, usage: reply.usage }
}

/**
 * v3.6.91 — Foto yang warnanya tidak disebut pelanggan maupun balasan, padahal ada warna lain yang disebut,
 * dibuang (pasti, dari katalog). Tanpa warna yang disebut sama sekali → tidak diubah.
 */
export function offColorPhotos(foto: string[], texts: string[], rows: LeanCatalogRow[]) {
  const text = ` ${fold(texts.join(' ')).replace(/[^a-z0-9.\s-]/g, ' ')} `
  const said = (color: string) =>
    [color, ...(COLOR_ALIASES[color] || [])].some((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:nya)?\\b`).test(text))
  const colorOf = (label: string) => baseColor(findCatalogVariant(rows, label)?.color || label.split(' - ').slice(1).join(' - '))
  const colors = [...new Set(rows.map((row) => baseColor(row.color)).filter((color) => color.length >= 3))]
  const mentioned = colors.filter(said)
  if (!mentioned.length) return []
  return foto.filter((label) => {
    const color = colorOf(label)
    return color && !said(color) && !mentioned.some((other) => other.includes(color) || color.includes(other))
  })
}

/** Kata warna sehari-hari untuk warna katalog (dasar tanpa "2.0"). */
const COLOR_ALIASES: Record<string, string[]> = {
  black: ['black', 'hitam', 'item'],
  white: ['white', 'putih'],
  putih: ['putih', 'white'],
  gray: ['gray', 'grey', 'abu'],
  navy: ['navy', 'dongker'],
  maroon: ['maroon', 'marun'],
  cream: ['cream', 'krem'],
  brown: ['brown'],
  choco: ['choco'],
}
const baseColor = (color: string) => fold(color).replace(/\s*\d+(?:\.\d+)?$/, '')

/**
 * v3.6.79 — Foto diselaraskan dengan teks (pasti, berdasarkan katalog): warna produk yang sedang
 * difoto dan disebut di balasan ikut dikirim bila punya foto (maks 10).
 */
export function alignPhotos(pesan: string[], foto: string[], rows: LeanCatalogRow[], max = 10) {
  const text = ` ${fold(pesan.join(' ')).replace(/[^a-z0-9.\s-]/g, ' ')} `
  const chosen = foto.map((label) => findCatalogVariant(rows, label)).filter((row): row is LeanCatalogRow => Boolean(row?.photoUrl))
  const labels = [...foto]
  const added: string[] = []
  const has = (row: LeanCatalogRow) => chosen.some((item) => item.product === row.product && item.color === row.color)
  const push = (row: LeanCatalogRow) => {
    if (labels.length >= max || has(row)) return
    const label = row.color ? `${row.product} - ${row.color}` : row.product
    chosen.push(row)
    labels.push(label)
    added.push(label)
  }
  for (const product of [...new Set(chosen.map((row) => row.product))]) {
    const variants = rows.filter((row) => row.product === product && row.active && row.photoUrl && !/tidak tampil di web/i.test(row.note || ''))
    const mentioned = variants.filter((row) => {
      const base = baseColor(row.color)
      if (!base) return false
      const words = COLOR_ALIASES[base] || [base]
      return words.some((word) => text.includes(` ${word} `) || text.includes(` ${word},`) || text.includes(` ${word}.`))
    })
    // >3 warna disebut = daftar warna (bukan janji foto tiap warna) → tidak ditambah.
    if (mentioned.length <= 3) for (const row of mentioned) push(row)
  }
  return { foto: labels, added }
}

/** Catatan untuk AI menulis ulang draf (sekali). */
export function revisionNote(decision: Pick<LeanDecision, 'pesan' | 'foto'>, issues: CheckIssue[]) {
  return [
    'PEMERIKSA BALASAN menemukan masalah pada drafmu (belum terkirim):',
    ...issues.map((issue) => `- ${issue.detail}`),
    `DRAF pesan: ${JSON.stringify(decision.pesan)}`,
    `DRAF foto: ${JSON.stringify(decision.foto)}`,
    'Tulis ulang keputusan LENGKAP (format JSON yang sama) yang sudah memperbaiki masalah di atas. Isi foto harus persis produk/warna yang kamu sebut atau janjikan (nama varian dari KATALOG yang punya foto); kalau tidak ada fotonya, jangan janjikan foto. Jawab maksud pelanggan, angka harus dari KATALOG/POLA HARGA/data alat. JANGAN mengarang angka: data belum ada (mis. tujuan ongkir tidak ditemukan) → tanyakan info yang kurang.',
  ].join('\n')
}

/** v3.6.101 — skema perbaikan: hanya kata-kata & foto (kolom lain tetap dari draf). */
export const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pesan: { type: 'array', items: { type: 'string' }, description: 'Bubble WhatsApp yang sudah diperbaiki, urut. Biasanya 1, maksimal 2.' },
    foto: { type: 'array', items: { type: 'string' }, description: 'Nama varian persis dari FAKTA (Produk - Warna, bertanda ✓) yang fotonya dikirim; kosong bila tidak ada.' },
  },
  required: ['pesan', 'foto'],
} as const

/**
 * v3.6.101 — Perbaikan bagian yang salah saja (bukan tulis ulang penuh): bahan kecil tapi konteks tetap
 * lengkap — riwayat terakhir, keadaan chat, catatan, fakta yang dipakai pemeriksa, draf, dan masalahnya.
 * Uji: tulis ulang penuh 45–120 dtk dan hanya lulus 49% (putaran 10–15).
 */
export function fixPrompt(input: {
  rules?: string
  style?: string
  customerText: string
  history: LeanHistoryRow[]
  chatState?: string
  notes?: string[]
  facts: string[]
  draft: Pick<LeanDecision, 'pesan' | 'foto'>
  issues: CheckIssue[]
}) {
  const system = [
    'Kamu CS toko jas di WhatsApp. Tugasmu sekarang HANYA memperbaiki draf balasan yang ditandai pemeriksa: ubah bagian yang bermasalah, pertahankan bagian lain yang sudah benar, gaya bicara tetap sama (singkat, santai, sapaan sama). Angka, warna, stok, dan info toko hanya dari FAKTA dan KEADAAN CHAT; data tidak ada → tanyakan yang kurang, jangan mengarang. Balas HANYA JSON sesuai skema.',
    input.style || '',
    input.rules || '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const recent = input.history.slice(-12).map((row) => {
    const who = row.direction === 'in' ? 'Pelanggan' : 'Toko'
    const media = row.mediaType ? `[${row.mediaType === 'image' ? 'foto' : row.mediaType}${row.mediaNote ? `: ${row.mediaNote}` : ''}] ` : ''
    return `${row.current ? '>> ' : ''}${who}: ${row.replyTo ? `(membalas "${row.replyTo}") ` : ''}${media}${String(row.body || '').replace(/\s+/g, ' ').slice(0, 400)}`
  })
  const user = [
    `RIWAYAT TERAKHIR (">>" = pesan yang dijawab):\n${recent.join('\n')}`,
    input.chatState || '',
    ...(input.notes || []).filter(Boolean),
    `FAKTA:\n${input.facts.filter(Boolean).join('\n')}`,
    `PESAN PELANGGAN SEKARANG:\n${input.customerText || '(hanya media)'}`,
    'PEMERIKSA BALASAN menemukan masalah pada drafmu (belum terkirim):',
    ...input.issues.map((issue) => `- ${issue.detail}`),
    `DRAF pesan: ${JSON.stringify(input.draft.pesan)}`,
    `DRAF foto: ${JSON.stringify(input.draft.foto)}`,
    'Perbaiki HANYA yang bermasalah. Foto harus persis produk/warna yang disebut atau dijanjikan (✓ di FAKTA); tidak ada fotonya → jangan janjikan foto.',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { system, user }
}

/** Hasil perbaikan: {pesan, foto}; null bila tidak terbaca / kosong (pakai cara lama). */
export function parseFix(text: string): Pick<LeanDecision, 'pesan' | 'foto'> | null {
  try {
    const raw = String(text || '')
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { pesan?: unknown; foto?: unknown }
    const pesan = Array.isArray(parsed.pesan) ? parsed.pesan.map((item) => String(item || '').trim()).filter(Boolean) : []
    const foto = Array.isArray(parsed.foto) ? parsed.foto.map((item) => String(item || '').trim()).filter(Boolean) : []
    return pesan.length ? { pesan: pesan.slice(0, 3), foto: foto.slice(0, 10) } : null
  } catch {
    return null
  }
}

/** Jumlah pemakaian token dua panggilan (draf + tulis ulang). */
export function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b
  if (!b) return a
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite }
}

const LINK = /\b(?:https?:\/\/|www\.)[^\s)]+|\b(?:maps\.app\.goo\.gl|goo\.gl|bit\.ly|wa\.me)\/[^\s)]*/gi

/**
 * v3.6.79 — Tautan yang tidak ada di data toko/chat tidak boleh dikirim (uji: AI mengarang
 * "https://maps.app.goo.gl/cilacap"). Tautan dibuang dari kalimat; kalimat yang tinggal pengantar
 * tautan ("ini maps-nya") ikut dibuang.
 */
export function stripUnknownLinks(pesan: string[], allowedTexts: string[]) {
  const allowed = allowedTexts.join('\n').toLowerCase()
  const removed: string[] = []
  const out = pesan
    .map((bubble) =>
      bubble.replace(LINK, (link) => {
        const clean = link.replace(/[.,!?]+$/, '')
        if (allowed.includes(clean.toLowerCase())) return link
        removed.push(clean)
        return ''
      })
    )
    .map((bubble, index) =>
      bubble === pesan[index]
        ? bubble
        : bubble
            .replace(/[,;:]?\s*(?:ini|berikut|cek)\s+(?:link\s*)?(?:maps|map|lokasi|link)(?:-?nya)?\s*(?:ya\s*)?(?:bos|kak)?\s*:?/gi, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+([,.!?])/g, '$1')
            .trim()
    )
    .filter(Boolean)
  return { pesan: out.length ? out : pesan.map((bubble) => bubble.replace(LINK, '').trim()).filter(Boolean), removed }
}

/* ---------------- Susulan: perlu tidaknya & rasa bahasanya (v3.6.82) ---------------- */

export type NudgeVerdict = { kirim: boolean; teks: string; alasan: string; oleh: 'ai' | 'jev' | 'tidak_dinilai' }

const NUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keputusan: { type: 'string', enum: ['kirim', 'ubah', 'jangan'] },
    susulan: { type: 'string', description: 'Bila "ubah": susulan yang ditulis ulang, satu kalimat chat santai seperti CS manusia.' },
    alasan: { type: 'string' },
  },
  required: ['keputusan', 'susulan', 'alasan'],
}

/**
 * Susulan (dikirim saat pelanggan diam) dinilai dulu: masih perlu dan nyambung? bahasanya seperti CS
 * manusia, bukan bot/menagih? AI menilai + menulis ulang bila kaku; Jev ikut menilai (yakin "jangan" →
 * tidak dikirim). Gagal menilai → dikirim apa adanya (perilaku lama).
 */
export async function reviewNudge(input: {
  jid: string
  settings: LeanProviderSettings
  susulan: string
  history: LeanHistoryRow[]
  address?: string
}): Promise<NudgeVerdict> {
  const recent = input.history
    .filter((row) => row.body || row.mediaType)
    .slice(-8)
    .map((row) => `${row.direction === 'in' ? 'Pelanggan' : 'Toko'}: ${row.mediaType ? `[${row.mediaType === 'image' ? 'foto' : row.mediaType}] ` : ''}${maskPii(String(row.body || '')).slice(0, 240)}`)
  const state = { percakapan: recent, susulan: maskPii(input.susulan).slice(0, 400) }
  const jevAsk = (await jevOn('cek_balasan'))
    ? askJev(
        'cek-susulan',
        state,
        {
          susulan: {
            type: 'choice',
            instructions:
              'Pelanggan belum membalas. Pantaskah CS manusia mengirim susulan ini sekarang (melihat percakapan)?',
            criteria: {
              kirim: 'Perlu dan wajar: membantu langkah berikutnya, nyambung dengan yang terakhir dibahas, tidak menagih',
              jangan: 'Tidak perlu: pelanggan sudah pamit/menunda/menolak, semua sudah tuntas, mengulang pertanyaan yang belum dijawab pelanggan, atau terkesan menagih',
              kaku: 'Isinya perlu tapi bahasanya kaku seperti bot / template',
            },
          },
        },
        { timeoutMs: 3000, jid: input.jid }
      ).catch(() => null)
    : Promise.resolve(null)
  const aiAsk = runLeanProvider(
    input.settings,
    {
      system: [
        'Kamu CS senior toko jas. Pelanggan belum membalas pesan terakhir toko. Nilai SUSULAN yang akan dikirim otomatis. Balas HANYA JSON.',
        '"jangan" bila: pelanggan sudah pamit/menunda/bilang nanti, sudah tuntas, susulan hanya mengulang pertanyaan yang belum dijawab pelanggan, menagih/memaksa, atau tidak nyambung. Klaim yang tidak ada di percakapan (terlaris, promo, stok menipis) → "ubah" tanpa klaim itu.',
        '"ubah" bila perlu tapi bahasanya kaku/template/terlalu panjang: tulis ulang satu kalimat chat santai, hangat, seperti CS manusia (sapaan "' + (input.address || 'bos') + '"), tetap membantu langkah berikutnya, tanpa angka baru.',
        '"kirim" bila sudah wajar. alasan: satu kalimat.',
      ].join('\n'),
      user: JSON.stringify(state),
    },
    [],
    'beta3-nudge-check',
    NUDGE_SCHEMA,
    { jid: input.jid, tier: 'standard' }
  )
    .then((reply) => JSON.parse(reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1)) as { keputusan?: string; susulan?: string; alasan?: string })
    .catch(() => null)
  const [jev, ai] = await Promise.all([jevAsk, aiAsk])
  const jevAnswer = jev?.susulan
  if (jevAnswer)
    await logDecision({ jid: input.jid, decision: 'cek_balasan', answer: jevAnswer, used: confident('cek_balasan', jevAnswer), detail: 'susulan', input: `${recent.slice(-3).join('\n')}\nSusulan: ${state.susulan}` })
  const jevSaysNo = jevAnswer?.type === 'choice' && jevAnswer.choice === 'jangan' && confident('cek_balasan', jevAnswer)
  if (ai?.keputusan === 'jangan' || jevSaysNo)
    return { kirim: false, teks: '', alasan: String(ai?.alasan || 'Jev: susulan tidak perlu').slice(0, 300), oleh: ai?.keputusan === 'jangan' ? 'ai' : 'jev' }
  if (ai?.keputusan === 'ubah' && ai.susulan?.trim())
    return { kirim: true, teks: ai.susulan.trim().slice(0, 400), alasan: String(ai.alasan || '').slice(0, 300), oleh: 'ai' }
  return { kirim: true, teks: input.susulan, alasan: String(ai?.alasan || ''), oleh: ai ? 'ai' : jevAnswer ? 'jev' : 'tidak_dinilai' }
}
