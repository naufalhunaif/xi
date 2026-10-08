// v3.6.78 — Pemeriksa balasan (Jev): setiap draf balasan AI dinilai SEBELUM dikirim — foto cocok dengan
// yang diucapkan, maksud pelanggan terjawab, fakta (harga/warna/size) sesuai katalog, tidak mengulang.
// Ada masalah → AI menulis ulang sekali dengan catatan pemeriksa. Penilaian memakai MAKSUD (Jev), bukan
// daftar kata; pemeriksaan pasti (foto yang tidak ada di katalog) tetap dilakukan kode.
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
export async function checkReply(input: {
  jid: string
  customerText: string
  history: LeanHistoryRow[]
  decision: Pick<LeanDecision, 'pesan' | 'foto' | 'serah_cs'>
  rows: LeanCatalogRow[]
  extraFacts?: string[]
  /** Ada → pemeriksa AI ikut menilai bersamaan dengan Jev (v3.6.79). */
  settings?: LeanProviderSettings
}): Promise<{ issues: CheckIssue[]; jev: boolean; ai?: boolean }> {
  const issues: CheckIssue[] = []
  const { sent, missing } = photoCaptions(input.rows, input.decision.foto || [])
  if (missing.length)
    issues.push({ code: 'foto_tidak_ada', detail: `Tidak ada foto katalog untuk: ${missing.join(', ')}. Pakai nama varian persis dari KATALOG yang bertanda foto.` })
  if (input.decision.serah_cs || !input.decision.pesan.length) return { issues, jev: false }
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
          kurang: 'Balasan menyebut/menjanjikan foto (mis. "ini fotonya", "ini warnanya", "ini semua warnanya") atau pelanggan minta lihat, tapi foto yang dimaksud tidak ada atau hanya sebagian padahal dijanjikan semua',
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
        'Periksa: (1) maksud pesan_pelanggan terjawab — pahami bahasa tidak baku, daerah, salah ketik, singkatan, dan sebutan warna (item/hitem/ireng = hitam, dongker = navy, marun = maroon, krem = cream, abu = gray, pth = putih); (2) foto_dikirim PERSIS sama dengan produk & warna yang disebut atau dijanjikan balasan — warna yang disebut "ini fotonya/tersedia" tapi tidak ada fotonya = foto_kurang, foto yang tidak disebut/diminta = foto_lebih, produk/warna berbeda = foto_beda; pelanggan minta semua warna tapi hanya sebagian padahal fakta_katalog punya foto (✓) lainnya = foto_kurang; (3) harga, warna, size ready sesuai fakta_katalog/info_toko; (4) tidak menanyakan ulang yang sudah dijawab.',
        'Laporkan hanya masalah yang JELAS. Bila balasan benar atau kamu ragu → ok=true, masalah=[]. penjelasan: satu kalimat bahasa Indonesia yang menyebut apa yang harus diubah.',
      ].join('\n'),
      user: JSON.stringify(state),
    },
    [],
    'beta3-check-ai',
    REVIEW_SCHEMA,
    { jid, tier: 'standard' }
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
 * difoto dan disebut di balasan ikut dikirim bila punya foto; ≥3 foto satu produk (menunjukkan
 * pilihan warna) → semua warna produk itu yang punya foto ikut (maks 10).
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
    const shown = chosen.filter((row) => row.product === product).length
    for (const row of variants) {
      const base = baseColor(row.color)
      if (!base) continue
      const words = COLOR_ALIASES[base] || [base]
      if (words.some((word) => text.includes(` ${word} `) || text.includes(` ${word},`) || text.includes(` ${word}.`))) push(row)
    }
    if (shown >= 3) for (const row of variants) push(row)
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
    'Tulis ulang keputusan LENGKAP (format JSON yang sama) yang sudah memperbaiki masalah di atas. Isi foto harus persis produk/warna yang kamu sebut atau janjikan (nama varian dari KATALOG yang punya foto); kalau tidak ada fotonya, jangan janjikan foto. Jawab maksud pelanggan, angka harus dari KATALOG/POLA HARGA.',
  ].join('\n')
}

/** Jumlah pemakaian token dua panggilan (draf + tulis ulang). */
export function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b
  if (!b) return a
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite }
}
