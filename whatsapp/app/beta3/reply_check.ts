// v3.6.78 — Pemeriksa balasan (Jev): setiap draf balasan AI dinilai SEBELUM dikirim — foto cocok dengan
// yang diucapkan, maksud pelanggan terjawab, fakta (harga/warna/size) sesuai katalog, tidak mengulang.
// Ada masalah → AI menulis ulang sekali dengan catatan pemeriksa. Penilaian memakai MAKSUD (Jev), bukan
// daftar kata; pemeriksaan pasti (foto yang tidak ada di katalog) tetap dilakukan kode.
import { askJev, confident, jevOn, logDecision, maskPii, scoreLevel, type JevAnswer } from '#beta3/jev'
import { findCatalogVariant, type LeanCatalogRow } from '#beta3/catalog_service'
import type { LeanDecision, LeanHistoryRow } from '#beta3/prompt'
import type { TokenUsage } from '#services/usage_service'

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
}): Promise<{ issues: CheckIssue[]; jev: boolean }> {
  const issues: CheckIssue[] = []
  const { sent, missing } = photoCaptions(input.rows, input.decision.foto || [])
  if (missing.length)
    issues.push({ code: 'foto_tidak_ada', detail: `Tidak ada foto katalog untuk: ${missing.join(', ')}. Pakai nama varian persis dari KATALOG yang bertanda foto.` })
  if (input.decision.serah_cs || !input.decision.pesan.length || !(await jevOn('cek_balasan'))) return { issues, jev: false }
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
  const answers = await askJev(
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
  if (!answers) return { issues, jev: false }
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
  return { issues, jev: true }
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
