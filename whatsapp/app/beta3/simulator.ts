// v3.6.78 — Uji percakapan: pelanggan tiruan bertanya dengan bahasa yang beragam (slang, salah ketik,
// bahasa daerah, maksud tidak langsung) lalu balasan AI diproses PERSIS seperti chat sungguhan
// (createLeanReply + pemeriksa), tanpa mengirim apa pun ke WhatsApp. Tiap percakapan dinilai:
// pemeriksaan pasti (harga di luar katalog, tidak membalas, serah CS tanpa perlu, kata wajib) dan
// penilai AI yang membaca katalog lengkap. Data uji (jid "…@sim") dihapus sesudah tiap percakapan.
import app from '@adonisjs/core/services/app'
import { ACK, isBusinessPitch, isOtherBot } from '#beta3/token_saver'
import { imageNotes } from '#beta3/refs_service'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import db from '#services/workspace_database'
import { ownsWorkspaceMedia, workspaceScope } from '#services/workspace_context'
import { maskPii } from '#beta3/jev'
import { ensureLeanTables, readLeanState, writeBeta3ChatNote } from '#beta3/tables'
import { catalogDigest, findCatalogVariant } from '#beta3/catalog_service'
import { downloadOutgoingImage } from '#services/outgoing_image_service'
import { renderPaymentMessage, renderTotalMessage } from '#beta3/order_service'
import { pricePattern, renderPricePattern } from '#beta3/price_pattern'
import { renderWholesaleRule, wholesaleDiscounts } from '#beta3/wholesale'
import { runLeanProvider } from '#beta3/provider'
import { allowedPrices, unknownPrices } from '#beta3/quality_service'
import { reviewNudge } from '#beta3/reply_check'
import { addLeanExample, listLeanExamples } from '#beta3/examples_service'
import { memoryFromChat, mergeChatMemory, readCustomerNote, writeCustomerNote } from '#beta3/customer_service'
import { readExchangePolicy, renderExchangePolicy } from '#beta3/store_policy'
import { STORE_BASICS, bubblesToSend, createLeanReply, productionRanges, type LeanSettings } from '#beta3/reply_service'
import { fastAnswer, fastIntent, type FastIntent } from '#beta3/fast_reply'
import { renderProductionEstimate, type LeanHistoryRow } from '#beta3/prompt'
import { generateScenarios, rng, roughen } from '#beta3/sim_generator'

export type SimScenario = {
  id: string
  judul: string
  /** Apa yang diinginkan pelanggan + jawaban yang benar (untuk penilai). */
  maksud: string
  /** Pesan pelanggan per giliran; bisa dengan gambar ("Produk - Warna" dari katalog, atau URL https). */
  giliran: Array<string | SimMessage>
  /** Chat nyata: pertanyaan asli + jawaban CS manusia per giliran (kebenaran toko). */
  asal?: Array<{ teks: string; jawaban: string[] }>
  /** Chat nyata: pesan sebelum giliran pertama (konteks yang dilihat CS waktu itu). */
  riwayat?: Array<{ arah: 'in' | 'out'; teks: string; gambar?: boolean; catatan?: string }>
  harap?: {
    /** false = harus dijawab AI sendiri (tidak diserahkan ke CS). */
    serah_cs?: boolean
    /** Pola (regex, huruf besar/kecil sama) yang wajib muncul di balasan. */
    sebut?: string[]
    /** Pola yang tidak boleh muncul. */
    tidak_sebut?: string[]
    /** true = harus ada foto; false = tidak boleh ada foto. */
    foto?: boolean
    /** Foto yang harus terkirim, persis (urutan bebas): caption "Produk - Warna". */
    foto_persis?: string[]
  }
}

export type SimMessage = { teks: string; gambar?: string; kutip?: string }
export const messageText = (item: string | SimMessage) => (typeof item === 'string' ? item : String(item?.teks || ''))
export const messageImage = (item: string | SimMessage) => (typeof item === 'string' ? '' : String(item?.gambar || ''))

export type SimTurn = {
  pelanggan: string
  /** Pesan yang dikutip pelanggan. */
  kutip?: string
  /** Gambar yang dikirim pelanggan (URL foto). */
  gambar?: string
  /** URL foto yang dikirim AI (urut sama dengan `foto`). */
  fotoUrl?: string[]
  /** Data alat yang dipakai AI giliran ini (ongkir, size, resi, ukuran) — untuk penilai. */
  alat?: string[]
  /** Susulan bila pelanggan diam: rencana AI + hasil penilaian (v3.6.82). */
  susulan?: { asli: string; kirim: boolean; teks: string; alasan: string }
  /** Draf AI sebelum ditulis ulang pemeriksa (bila ada) + catatan pemeriksanya. */
  draf?: { pesan: string[]; foto: string[]; masalah: string[] }
  balasan: string[]
  foto: string[]
  total?: string
  serah_cs: boolean
  alasan: string
  jejak: string[]
  ms: number
  error?: string
}

export type SimResult = {
  id: string
  judul: string
  lulus: boolean
  nilai: number | null
  /** Rasa manusia 1–5 dari penilai (v3.6.80) + catatannya (v3.6.82). */
  manusia?: number | null
  rasa?: string
  /** Chat nyata: aturan toko dari jawaban CS yang dilanggar AI (saran untuk Aturan toko). */
  aturan?: string
  /** Chat nyata: contoh jawaban CS asli yang ditambahkan supaya AI belajar. */
  dipelajari?: number
  masalah: string[]
  giliran: SimTurn[]
}

/** Jid percakapan uji: tidak pernah lolos isDirectContactJid (tidak bisa dikirimi pesan). */
export const SIM_DOMAIN = '@sim'
export const isSimJid = (jid: string) => String(jid || '').endsWith(SIM_DOMAIN)

/** Tabel yang bisa terisi saat uji (dihapus per jid sesudah percakapan). */
const SIM_TABLES = [
  'whatsapp_beta3_chats',
  'whatsapp_beta3_customers',
  'whatsapp_beta3_orders',
  'whatsapp_beta3_specs',
  'whatsapp_beta3_priority',
  'whatsapp_beta3_refs',
  'whatsapp_beta3_proofs',
  'whatsapp_beta3_shipments',
  'whatsapp_beta3_decisions',
  'whatsapp_chat_goals',
  'whatsapp_customer_memory',
]

export async function cleanupSim(jid: string) {
  if (!isSimJid(jid)) return
  for (const table of SIM_TABLES) await db.from(table).where('jid', jid).delete().catch(() => 0)
  // Keadaan per chat di tabel state (mis. "ongkir:last:<jid>", cache catatan).
  await db.from('whatsapp_beta3_state').where('name', 'like', `%${jid}%`).delete().catch(() => 0)
}

export async function loadScenarios(): Promise<SimScenario[]> {
  const raw = await readFile(app.makePath('resources/beta3/sim_scenarios.json'), 'utf8')
  return (JSON.parse(raw) as SimScenario[]).filter((item) => item.id && item.giliran?.length)
}

/** Pemeriksaan pasti untuk satu percakapan (tanpa AI). */
export function deterministicIssues(
  scenario: Pick<SimScenario, 'harap'>,
  turns: SimTurn[],
  allowed: ReturnType<typeof allowedPrices>
) {
  const issues: string[] = []
  turns.forEach((turn, index) => {
    const n = index + 1
    if (turn.error) issues.push(`Giliran ${n}: gagal diproses (${turn.error}).`)
    // Diam atas "oke 😁" bisa tepat (seperti CS manusia); biar penilai yang menilai.
    else if (!turn.balasan.length && !turn.foto.length && !turn.serah_cs && !ACK.test(String(turn.pelanggan || '').trim()))
      issues.push(`Giliran ${n}: tidak membalas.`)
    const unknown = unknownPrices(turn.balasan, allowed)
    if (unknown.length) issues.push(`Giliran ${n}: harga ${unknown.map((value) => value.toLocaleString('id-ID')).join(', ')} tidak ada di katalog/ongkir.`)
  })
  const harap = scenario.harap || {}
  const handed = turns.find((turn) => turn.serah_cs)
  if (harap.serah_cs === false && handed) issues.push(`Diserahkan ke CS padahal bisa dijawab (${handed.alasan || 'tanpa alasan'}).`)
  if (harap.serah_cs === true && !handed) issues.push('Seharusnya diserahkan ke CS.')
  const text = turns.flatMap((turn) => [...turn.balasan, ...turn.foto, turn.total || '']).join('\n')
  for (const pattern of harap.sebut || [])
    if (!new RegExp(pattern, 'i').test(text)) issues.push(`Balasan tidak menyebut: ${pattern}`)
  for (const pattern of harap.tidak_sebut || [])
    if (new RegExp(pattern, 'i').test(text)) issues.push(`Balasan menyebut yang dilarang: ${pattern}`)
  const photos = turns.reduce((total, turn) => total + turn.foto.length, 0)
  if (harap.foto === true && !photos) issues.push('Seharusnya mengirim foto.')
  if (harap.foto === false && photos) issues.push('Seharusnya tidak mengirim foto.')
  if (harap.foto_persis?.length) {
    const sent = new Set(turns.flatMap((turn) => turn.foto.map((caption) => caption.toLowerCase())))
    const want = new Set(harap.foto_persis.map((caption) => caption.toLowerCase()))
    const missing = [...want].filter((caption) => !sent.has(caption))
    const extra = [...sent].filter((caption) => !want.has(caption))
    if (missing.length) issues.push(`Foto kurang: ${missing.join(', ')}.`)
    if (extra.length) issues.push(`Foto lebih/beda: ${extra.join(', ')}.`)
  }
  return issues
}

/** Transkrip untuk penilai (dan untuk dibaca pemilik). */
/** v3.6.86 — konteks chat sebelum uji (juga dilihat AI) untuk penilai; dulu penilai tidak melihatnya. */
export function priorContext(scenario: Pick<SimScenario, 'riwayat'>) {
  const lines = (scenario.riwayat || []).map(
    (item) =>
      `${item.arah === 'in' ? 'Pelanggan' : 'Toko'}: ${item.gambar ? `[gambar${item.catatan ? `: ${item.catatan}` : ''}] ` : ''}${maskPii(item.teks || '').slice(0, 300)}`
  )
  return lines.length ? `PERCAKAPAN SEBELUMNYA (konteks yang juga dilihat AI; isi yang berasal dari sini BUKAN karangan):\n${lines.join('\n')}\n\n` : ''
}

export function transcript(turns: SimTurn[]) {
  return turns
    .flatMap((turn) => [
      `Pelanggan: ${turn.kutip ? `(membalas pesan: "${turn.kutip}") ` : ''}${turn.gambar ? '[mengirim foto] ' : ''}${turn.pelanggan}`,
      ...(turn.alat || []).map((data) => `(data alat untuk AI — ${data})`),
      // Urutan kirim sama dengan listener: bubble pertama → foto → bubble berikutnya.
      ...turn.balasan.slice(0, 1).map((bubble) => `AI: ${bubble}`),
      ...turn.foto.map((caption) => `AI: [foto] ${caption}`),
      ...turn.balasan.slice(1).map((bubble) => `AI: ${bubble}`),
      ...(turn.total ? [`Sistem: ${turn.total}`] : []),
      ...(turn.susulan
        ? // v3.6.104: susulan yang dibatalkan pemeriksa tidak pernah terkirim → tidak ikut dinilai.
          turn.susulan.kirim
          ? [`(susulan bila pelanggan diam: ${turn.susulan.teks})`]
          : []
        : []),
      ...(turn.serah_cs ? [`(diserahkan ke CS: ${turn.alasan})`] : []),
    ])
    .join('\n')
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nilai: { type: 'integer', description: '1 (buruk) – 5 (seperti CS terbaik)' },
    manusia: { type: 'integer', description: 'Rasa manusia 1 (kaku seperti bot) – 5 (seperti CS manusia terbaik toko ini)' },
    rasa: { type: 'string', description: 'Satu-dua kalimat: bagian mana yang terasa bot/kaku dan contoh kalimat yang lebih manusia. Kosong bila sudah natural.' },
    bertentangan_cs: { type: 'boolean', description: 'true bila balasan AI bertentangan dengan jawaban CS manusia (chat nyata) soal kebijakan/kemampuan toko.' },
    aturan: { type: 'string', description: 'Bila bertentangan: satu kalimat aturan toko umum dari jawaban CS (mis. "Toko tidak membuat jas anak-anak"). Kosong bila tidak ada.' },
    lulus: { type: 'boolean' },
    masalah: { type: 'array', items: { type: 'string' } },
  },
  required: ['nilai', 'manusia', 'rasa', 'bertentangan_cs', 'aturan', 'lulus', 'masalah'],
}

async function judge(settings: LeanSettings, scenario: SimScenario, turns: SimTurn[], facts: string) {
  const reply = await runLeanProvider(
    settings,
    {
      system: [
        'Kamu auditor CS toko jas Chameleon Cloth. Nilai percakapan uji antara pelanggan dan AI CS. Balas HANYA JSON sesuai skema.',
        'Periksa ketat: (1) maksud pelanggan dipahami walau bahasanya tidak baku/daerah/salah ketik/tidak langsung; (2) setiap angka harga, warna, size ready, dan info toko benar menurut FAKTA; (3) foto yang dikirim persis sesuai yang diucapkan/dijanjikan balasan (tidak kurang, tidak lebih, tidak beda); (4) tidak mengarang, tidak mengulang pertanyaan yang sudah dijawab, tidak menyerahkan ke CS bila jawabannya ada di FAKTA; (5) gaya chat CS singkat dan sopan.',
        'Chat nyata: "CS manusia waktu itu" adalah KEBENARAN toko untuk kebijakan, kemampuan, dan prosedur (tidak bisa = tidak bisa, tidak melayani = tidak melayani). Hanya angka harga/stok yang mengikuti FAKTA saat ini bila berbeda. Balasan AI yang bertentangan dengan CS manusia = masalah + bertentangan_cs=true.',
        'Baris "(susulan bila pelanggan diam: …)" dikirim otomatis bila pelanggan tidak membalas: nilai juga perlu tidaknya dan rasa manusianya (tidak menagih, tidak mengulang, nyambung).',
        'Data internal yang TIDAK ada di FAKTA maupun percakapan (progres produksi pesanan tertentu, status kirim tanpa resi, kapan pesanan tertentu jadi): AI yang bilang "saya cek dulu" dan menyerahkan ke CS itu BENAR, bukan masalah — yang salah adalah mengarang.',
        'Baris "(data alat untuk AI — …)" adalah hasil alat toko (ongkir, size, resi) yang dibaca AI: angka yang cocok dengan data itu BENAR, bukan karangan.',
        'Rasa manusia (nilai manusia): balasan harus terasa seperti CS manusia toko ini — santai, singkat, hangat, bahasa chat sehari-hari, menjawab dulu baru bertanya, tidak kaku, tidak bertele-tele, tidak memakai daftar/format bila cukup satu kalimat, tidak mengulang sapaan atau kalimat template. Bila ada "Jawaban CS manusia waktu itu", jadikan acuan gaya (isi harga/stok tetap ikut FAKTA saat ini). Rasa robotik ≤ 2 = masalah.',
        `Waktu uji: ${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date())} WIB. Jawaban soal buka/tutup toko, hari ini/besok, dan tanggal dinilai terhadap waktu uji ini (chat asli bisa terjadi di jam lain).`,
        'lulus = true hanya bila tidak ada kesalahan fakta, foto cocok, maksud terjawab, dan rasa manusia ≥ 3. masalah: kalimat pendek bahasa Indonesia, sebut giliran & kutip bagian yang salah. Tanpa masalah → [].',
        `FAKTA TOKO:\n${facts}`,
      ].join('\n\n'),
      user: `MAKSUD PELANGGAN & JAWABAN YANG DIHARAPKAN:\n${scenario.maksud}\n\n${priorContext(scenario)}PERCAKAPAN:\n${transcript(turns)}`,
    },
    [],
    'beta3-sim-judge',
    JUDGE_SCHEMA,
    { providers: ['claude', 'chatgpt'] }
  )
  const parsed = JSON.parse(reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1)) as {
    nilai?: number
    manusia?: number
    rasa?: string
    bertentangan_cs?: boolean
    aturan?: string
    lulus?: boolean
    masalah?: string[]
  }
  const human = Math.max(1, Math.min(5, Math.round(Number(parsed.manusia) || 3)))
  return {
    nilai: Math.max(1, Math.min(5, Math.round(Number(parsed.nilai) || 1))),
    manusia: human,
    rasa: String(parsed.rasa || '').slice(0, 500),
    bertentanganCs: parsed.bertentangan_cs === true,
    aturan: String(parsed.aturan || '').trim().slice(0, 300),
    lulus: parsed.lulus === true && human >= 3 && parsed.bertentangan_cs !== true,
    masalah: (parsed.masalah || []).map(String).filter(Boolean).slice(0, 8),
  }
}

/** Fakta lengkap untuk penilai: profil toko, katalog, pola harga, grosir. */
export async function judgeFacts(settings?: LeanSettings) {
  const digest = await catalogDigest()
  const profile = String((await readLeanState('store_profile').catch(() => '')) || '')
  // v3.6.86: hari libur toko ikut (sama dengan AI) — dulu penilai menghitung Sabtu libur → tanggal beda.
  const production = settings?.production ? renderProductionEstimate(settings.production, new Date(), profile) : ''
  const wholesaleText = String((await readLeanState('wholesale').catch(() => '')) || '')
  return [
    profile,
    renderWholesaleRule(wholesaleDiscounts(wholesaleText)) || wholesaleText,
    renderPricePattern(pricePattern(digest.rows)),
    production,
    // Kebijakan dasar yang juga diberikan ke AI (skill & pemeriksa COD).
    'CARA TOKO MENENTUKAN SIZE: dari tinggi & berat badan (alat Fit Advisor) atau ukuran badan dibanding size chart; CS biasa menanyakan tinggi dan berat badan.',
    STORE_BASICS,
    'KEBIJAKAN: pembayaran transfer; COD/bayar di tempat, rekber, Shopee, Tokopedia tidak tersedia. Pengiriman JNE (REG/YES; kargo JTR min 8 kg).',
    renderExchangePolicy((await readExchangePolicy().catch(() => ({ text: '' }))).text),
    // v3.6.86: rekening resmi toko (dulu dinilai "tidak ada di FAKTA").
    ((text) => (text ? `PEMBAYARAN RESMI (dikirim sistem bila diminta): ${text}` : ''))(
      renderPaymentMessage(
        (settings?.paymentMethods || [])
          .filter((method) => method.enabled)
          .map((method) => ({ bank: method.name, number: method.destination, holder: method.accountName || '' }))
      )
    ),
    // v3.6.85: size chart ikut fakta penilai (uji: saran size dari chart dianggap mengarang).
    ((chart) => (chart ? `SIZE CHART:\n${chart}` : ''))(String((await readLeanState('size_charts').catch(() => '')) || '')),
    digest.text,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Langkah yang membawa data alat (dibaca AI) — ikut ke penilai & pemeriksa harga uji. */
const TOOL_TRACES = new Set(['beta3-geo', 'beta3-rates', 'beta3-fit', 'beta3-sizechart', 'beta3-awb', 'beta3-total', 'beta3-wholesale', 'beta3-price-context'])

/** Gambar pelanggan untuk uji: label katalog ("Produk - Warna") atau URL https → file sementara. */
async function simImage(ref: string, rows: Awaited<ReturnType<typeof catalogDigest>>['rows']) {
  // v3.6.80: gambar dari chat nyata (/media/… milik workspace ini) dipakai langsung dari disk.
  if (/^\/media\/[\w./-]+$/.test(ref) && !ref.includes('..') && ownsWorkspaceMedia(ref.slice('/media/'.length))) {
    const path = app.publicPath(ref.slice(1))
    await access(path)
    return { url: ref, path, keep: true }
  }
  const url = /^https:\/\//i.test(ref) ? ref : findCatalogVariant(rows, ref)?.photoUrl || ''
  if (!url) throw new Error(`Gambar uji tidak ditemukan: ${ref}`)
  const bytes = await downloadOutgoingImage(url)
  const path = join(tmpdir(), `wa-sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`)
  await writeFile(path, bytes)
  return { url, path, keep: false }
}

export type SimState = { jid: string; rows: LeanHistoryRow[]; turns: SimTurn[] }
export const newSimState = (label: string): SimState => ({
  jid: `uji-${label.replace(/[^a-z0-9-]/gi, '').slice(0, 40)}-${Date.now().toString(36)}${SIM_DOMAIN}`,
  rows: [],
  turns: [],
})

/** Satu giliran: pesan pelanggan masuk → balasan diproses seperti chat sungguhan (tanpa dikirim). */
export async function runSimTurn(state: SimState, message: string | SimMessage, settings: LeanSettings, at = new Date()) {
  const text = messageText(message)
  const image = messageImage(message)
  const jejak: string[] = []
  const began = Date.now()
  const turn: SimTurn = { pelanggan: text, balasan: [], foto: [], fotoUrl: [], serah_cs: false, alasan: '', jejak, ms: 0 }
  let file = ''
  let keep = false
  try {
    const digest = await catalogDigest()
    if (image) {
      const got = await simImage(image, digest.rows)
      file = got.path
      keep = got.keep
      turn.gambar = got.url
    }
    for (const row of state.rows) row.current = false
    const kutip = typeof message === 'string' ? '' : String(message?.kutip || '')
    if (kutip) turn.kutip = kutip
    state.rows.push({ direction: 'in', senderType: 'customer', body: text, mediaType: image ? 'image' : null, createdAt: at, current: true, ...(kutip ? { replyTo: kutip } : {}) })
    const reply = await createLeanReply({
      jid: state.jid,
      messageIds: [],
      text,
      imagePaths: file ? [file] : [],
      settings,
      history: state.rows.map((row) => ({ ...row })),
      simulate: true,
      onTrace: (event) => {
        if (event.status !== 'running' && event.label) jejak.push(`${event.status === 'failed' ? '✗' : '·'} ${event.label}`)
        if (event.key === 'beta3-check' && event.status === 'failed' && event.detail) {
          const detail = event.detail as { masalah?: Array<{ detail: string }>; draf?: { pesan?: string[]; foto?: string[] } }
          turn.draf = {
            pesan: detail.draf?.pesan || [],
            foto: detail.draf?.foto || [],
            masalah: (detail.masalah || []).map((item) => item.detail),
          }
        }
        if (TOOL_TRACES.has(event.key) && event.status === 'completed' && event.detail)
          (turn.alat ||= []).push(`${event.label}: ${JSON.stringify(event.detail).slice(0, 1500)}`)
      },
    })
    const { decision } = reply
    turn.balasan = bubblesToSend(decision)
    turn.foto = reply.photos.map((photo) => photo.caption)
    turn.fotoUrl = reply.photos.map((photo) => photo.url)
    turn.serah_cs = decision.serah_cs
    turn.alasan = decision.alasan
    if (reply.autoTotal && !decision.serah_cs)
      turn.total = renderTotalMessage({
        items: reply.autoTotal.items,
        subtotal: reply.autoTotal.subtotal,
        shippingService: reply.autoTotal.shippingService,
        shippingCost: reply.autoTotal.shippingCost,
      })
    // Riwayat berikutnya: urutan kirim sama dengan chat sungguhan (bubble 1 → foto → sisanya).
    const out = (body: string, isImage = false) =>
      state.rows.push({ direction: 'out', senderType: 'ai', body, mediaType: isImage ? 'image' : null, createdAt: new Date(at.getTime() + 20_000) })
    const [first, ...rest] = turn.balasan
    if (first) out(first)
    for (const caption of turn.foto) out(caption, true)
    for (const bubble of rest) out(bubble)
    if (turn.total) out(turn.total)
    if (decision.catatan) await writeBeta3ChatNote(state.jid, decision.catatan)
    // v3.6.104: waktu yang dirasakan pelanggan = sampai balasan siap; pemeriksaan susulan (dikirim nanti) tidak dihitung.
    turn.ms = Date.now() - began
    if (decision.susulan && !decision.serah_cs) {
      const verdict = await reviewNudge({ jid: state.jid, settings, susulan: decision.susulan, history: state.rows.map((row) => ({ ...row, current: false })) }).catch(() => null)
      turn.susulan = { asli: decision.susulan, kirim: verdict?.kirim ?? true, teks: verdict?.teks || decision.susulan, alasan: verdict?.alasan || '' }
    }
  } catch (error) {
    turn.error = error instanceof Error ? error.message.slice(0, 300) : String(error)
  } finally {
    if (file && !keep) await rm(file, { force: true }).catch(() => {})
  }
  if (!turn.ms) turn.ms = Date.now() - began
  state.turns.push(turn)
  return turn
}

/** Jalankan satu percakapan uji. `onTurn` dipanggil tiap giliran selesai (tampilan langsung). */
export async function runScenario(
  scenario: SimScenario,
  settings: LeanSettings,
  options: { judge?: boolean; facts?: string; onTurn?: (turns: SimTurn[]) => Promise<void> | void } = {}
): Promise<SimResult> {
  const state = newSimState(scenario.id)
  const start = Date.now() - scenario.giliran.length * 90_000
  // Chat nyata: konteks sebelumnya ikut, seperti yang dilihat CS waktu itu.
  for (const [index, item] of (scenario.riwayat || []).entries())
    state.rows.push({
      direction: item.arah,
      senderType: item.arah === 'in' ? 'customer' : 'cs',
      body: item.teks,
      mediaType: item.gambar ? 'image' : null,
      mediaNote: item.catatan || '',
      createdAt: new Date(start - ((scenario.riwayat?.length || 0) - index) * 120_000),
    })
  try {
    for (const [index, message] of scenario.giliran.entries()) {
      const turn = await runSimTurn(state, message, settings, new Date(start + index * 90_000))
      await options.onTurn?.(state.turns)
      // Diserahkan ke CS: AI berhenti di chat ini (seperti chat sungguhan).
      if (turn.serah_cs || turn.error) break
    }
    const turns = state.turns
    const digest = await catalogDigest()
    const wholesale = String((await readLeanState('wholesale').catch(() => '')) || '')
    const allowed = allowedPrices(
      digest.rows,
      [
        ...state.rows.map((row) => String(row.body || '')),
        ...turns.flatMap((turn) => [...turn.jejak, ...(turn.alat || [])]),
        renderPricePattern(pricePattern(digest.rows)),
      ],
      wholesaleDiscounts(wholesale)
    )
    const masalah = deterministicIssues(scenario, turns, allowed)
    let nilai: number | null = null
    let manusia: number | null = null
    let rasa = ''
    let aturan = ''
    let dipelajari = 0
    let judged = true
    if (options.judge !== false && !turns.some((turn) => turn.error)) {
      try {
        const verdict = await judge(settings, scenario, turns, options.facts || (await judgeFacts(settings)))
        nilai = verdict.nilai
        manusia = verdict.manusia
        rasa = verdict.rasa
        if (verdict.bertentanganCs && scenario.asal?.length) {
          aturan = verdict.aturan
          dipelajari = await learnFromRealChat(scenario.asal).catch(() => 0)
        }
        judged = verdict.lulus
        masalah.push(...verdict.masalah.map((item) => `Penilai: ${item}`))
      } catch (error) {
        masalah.push(`Penilai gagal: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
        judged = false
      }
    }
    const hard = masalah.filter((item) => !item.startsWith('Penilai'))
    return { id: scenario.id, judul: scenario.judul, lulus: !hard.length && judged, nilai, manusia, rasa, aturan, dipelajari, masalah, giliran: turns }
  } finally {
    await cleanupSim(state.jid)
  }
}

/**
 * v3.6.87 — Satu dari lima chat (hash jid) disimpan khusus untuk UJI dan tidak pernah dipelajari, supaya
 * persentase lulus mengukur chat yang belum pernah dilihat AI (jujur, bukan hafalan).
 */
export function isHoldout(jid: string) {
  let hash = 2166136261
  for (const char of String(jid || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 5 === 0
}

const FORM_TEXT = /nama\s*:|alamat\s*(?:lengkap)?\s*:|kode\s*pos\s*:|no\.?\s*(?:hp|telp|wa)\s*:/i
/** Pasangan (pertanyaan, jawaban CS manusia) layak jadi contoh: berisi, tanpa data pribadi. */
export function learnablePair(customer: string, cs: string) {
  const question = customer.trim()
  const answer = cs.trim()
  if (question.length < 6 || answer.split(/\s+/).length < 3) return false
  if (FORM_TEXT.test(question) || FORM_TEXT.test(answer)) return false
  if (/\d{8,}|\[(?:nomor hp|angka panjang|email)\]/i.test(`${question} ${answer}`)) return false
  if (/\b(?:an|a\.n\.?|atas nama)\s+[A-Z]/.test(answer) && /\b(?:bri|bca|bni|mandiri|rek)/i.test(answer)) return false
  return true
}

/**
 * v3.6.87 — Pelajari semua jawaban CS manusia di chat nyata (kecuali chat uji): tiap pertanyaan pelanggan
 * + jawaban CS jadi Contoh (sumber "riwayat"), dipilih otomatis bila pertanyaan baru mirip. Pengetahuan
 * toko yang hanya ada di kepala CS (rute ke toko, model yang tidak dibuat, saran CS) ikut terbawa.
 */
export async function learnAllRealChats(days = 365) {
  await ensureLeanTables()
  const since = new Date(Date.now() - days * 86_400_000)
  const jids = (await db
    .from('whatsapp_messages')
    .select('jid')
    .where('created_at', '>', since)
    .whereIn('sender_type', ['cs', 'owner'])
    .where((query) => query.where('jid', 'like', '%@s.whatsapp.net').orWhere('jid', 'like', '%@lid'))
    .groupBy('jid')) as Array<{ jid: string }>
  const fold = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
  const existing = new Set((await listLeanExamples()).map((example) => fold(example.customerText)))
  let chats = 0
  let pairs = 0
  let added = 0
  for (const { jid } of jids) {
    if (isHoldout(jid)) continue
    chats++
    const rows = (await db
      .from('whatsapp_messages')
      .select('jid', 'message_id', 'reply_to_message_id', 'direction', 'sender_type', 'body', 'media_type', 'media_url', 'created_at')
      .where('jid', jid)
      .where('created_at', '>', since)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(600)) as RealRow[]
    for (const segment of realSegments(rows)) {
      pairs++
      const customerText = maskPii(segment.teks).replace(/\n+/g, ' / ').slice(0, 300).trim()
      const csText = maskPii(segment.jawaban.join('\n')).slice(0, 400).trim()
      const key = fold(customerText)
      if (!learnablePair(customerText, csText) || existing.has(key)) continue
      await addLeanExample({ situation: segment.kutip ? `membalas: ${segment.kutip.slice(0, 80)}` : '', customerText, csText, tags: 'riwayat', source: 'riwayat' })
      existing.add(key)
      added++
    }
  }
  // v3.6.96: ingatan per pelanggan dari chat lama (alamat form, size, tinggi/berat) — semua chat, termasuk chat uji.
  let customers = 0
  for (const { jid } of jids) {
    const rows = (await db
      .from('whatsapp_messages')
      .select('direction', 'body')
      .where('jid', jid)
      .where('direction', 'in')
      .whereNotNull('body')
      .orderBy('id', 'asc')
      .limit(800)) as Array<{ direction: string; body: string | null }>
    const facts = memoryFromChat(rows)
    if (!Object.keys(facts).length) continue
    const previous = await readCustomerNote(jid)
    const next = mergeChatMemory(previous, facts)
    if (next !== previous) {
      await writeCustomerNote(jid, next)
      customers++
    }
  }
  return { chats, pairs, added, customers }
}

type LearnState = { running: boolean; startedAt?: string; finishedAt?: string; result?: { chats: number; pairs: number; added: number; customers?: number }; error?: string }
const learning = new Map<string, LearnState>()
/** Status belajar dari semua chat nyata (per workspace). */
export function realLearningStatus(): LearnState {
  return learning.get(workspaceScope().prefix) || { running: false }
}
/** Mulai belajar di latar (sekali jalan per workspace). */
export function startRealLearning(days = 365) {
  const key = workspaceScope().prefix
  const now = learning.get(key)
  if (now?.running) return { ...now, started: false }
  const state: LearnState = { running: true, startedAt: new Date().toISOString() }
  learning.set(key, state)
  learnAllRealChats(days)
    .then((result) => learning.set(key, { running: false, startedAt: state.startedAt, finishedAt: new Date().toISOString(), result }))
    .catch((error) => learning.set(key, { running: false, startedAt: state.startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }))
  return { ...state, started: true }
}

/**
 * v3.6.83 — Jawaban CS manusia di chat nyata = kebenaran toko. AI bertentangan → pasangan
 * (pertanyaan asli, jawaban CS) masuk Contoh jawaban CS (sumber "chat-nyata"), dipakai AI di chat berikutnya.
 */
export async function learnFromRealChat(asal: Array<{ teks: string; jawaban: string[] }>) {
  const existing = new Set((await listLeanExamples()).map((example) => example.customerText.trim().toLowerCase()))
  let added = 0
  for (const item of asal) {
    const customerText = item.teks.trim()
    const csText = item.jawaban.join('\n').trim()
    if (!customerText || !csText || existing.has(customerText.toLowerCase())) continue
    await addLeanExample({ situation: 'Dari chat nyata', customerText, csText, tags: 'chat-nyata', source: 'chat-nyata' })
    existing.add(customerText.toLowerCase())
    added++
  }
  return added
}

/* ---------------- Skenario dari chat nyata (v3.6.80) ---------------- */

type RealRow = { jid: string; message_id?: string | null; reply_to_message_id?: string | null; direction: string; sender_type: string | null; body: string | null; media_type: string | null; media_url: string | null; created_at: Date | string }
type RealSegment = { teks: string; gambar?: string; jawaban: string[]; mulai?: number; kutip?: string }

/** Potong chat menjadi giliran: pesan pelanggan beruntun → balasan CS manusia (cs/owner) sesudahnya. */
export function realSegments(rows: RealRow[]) {
  const segments: RealSegment[] = []
  let asked: RealRow[] = []
  let answered: string[] = []
  let askedAt = 0
  const flush = () => {
    const texts = asked.map((row) => String(row.body || '').trim()).filter(Boolean)
    const image = asked.find((row) => row.media_type === 'image' && row.media_url)?.media_url || undefined
    // v3.6.86: pesan yang dikutip pelanggan ("yang ini berapa" sambil membalas foto) ikut, seperti di chat asli.
    const quotedId = asked.find((row) => row.reply_to_message_id)?.reply_to_message_id
    const quoted = quotedId ? rows.find((row) => row.message_id && row.message_id === quotedId) : undefined
    const kutip = quoted ? String(quoted.body || '').trim().slice(0, 160) || (quoted.media_type ? `[${quoted.media_type}]` : '') : ''
    if ((texts.length || image) && answered.length)
      segments.push({ teks: texts.join('\n').slice(0, 1500), gambar: image || undefined, jawaban: answered, mulai: askedAt, ...(kutip ? { kutip } : {}) })
    asked = []
    answered = []
  }
  for (const [index, row] of rows.entries()) {
    if (row.direction === 'in') {
      if (answered.length) flush()
      if (!asked.length) askedAt = index
      if (row.media_type && row.media_type !== 'image') continue
      asked.push(row)
    } else if (asked.length && ['cs', 'owner'].includes(String(row.sender_type || '')) && row.body) {
      answered.push(String(row.body).slice(0, 600))
    } else if (asked.length && row.sender_type === 'ai') {
      // Dijawab AI (bukan manusia): tidak dipakai sebagai acuan.
      asked = []
      answered = []
    }
  }
  flush()
  return segments
}

/**
 * Pertanyaan dari chat nyata toko (dijawab CS manusia), dipakai ulang sebagai pelanggan uji. Sebagian
 * dikombinasikan: kalimat diacak (singkatan, salah ketik, bahasa daerah) dan digabung dengan pertanyaan
 * pelanggan lain, supaya maksud yang sama diuji dalam bentuk yang lebih rumit.
 */
export async function realScenarios(count: number, seed: number, mix = 0.5) {
  const rand = rng(seed)
  const since = new Date(Date.now() - 180 * 86_400_000)
  const jids = (await db
    .from('whatsapp_messages')
    .select('jid')
    .where('created_at', '>', since)
    .whereIn('sender_type', ['cs', 'owner'])
    .where((query) => query.where('jid', 'like', '%@s.whatsapp.net').orWhere('jid', 'like', '%@lid'))
    .groupBy('jid')
    .orderByRaw('RAND(?)', [seed])
    .limit(Math.min(2000, count * 15))) as Array<{ jid: string }>
  const pool: Array<{ jid: string; segments: RealSegment[]; rows: RealRow[] }> = []
  const foldText = (text: string) => maskPii(text).replace(/\n+/g, ' / ').toLowerCase().replace(/\s+/g, ' ').trim()
  const learned = new Set((await listLeanExamples()).flatMap((example) => [foldText(example.customerText), example.customerText.toLowerCase().replace(/\s+/g, ' ').trim()]))
  for (const { jid } of jids) {
    // v3.6.87: uji hanya memakai chat yang tidak dipelajari.
    if (!isHoldout(jid)) continue
    const rows = (await db
      .from('whatsapp_messages')
      .select('jid', 'message_id', 'reply_to_message_id', 'direction', 'sender_type', 'body', 'media_type', 'media_url', 'created_at')
      .where('jid', jid)
      .where('created_at', '>', since)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(120)) as RealRow[]
    // Pertanyaan yang sudah jadi contoh (dipelajari dari uji sebelumnya) tidak diuji lagi.
    const segments = realSegments(rows).filter((segment) => (segment.teks.length >= 2 || segment.gambar) && !learned.has(foldText(segment.teks)))
    if (segments.length) pool.push({ jid, segments, rows })
    if (pool.length >= count * 2) break
  }
  const out: SimScenario[] = []
  // v3.6.89: chat uji terbatas (1 dari 5) → satu chat boleh dipakai beberapa kali dengan bagian yang berbeda.
  const used = new Map<string, Set<number>>()
  const turns: Array<[number, (typeof pool)[number], number]> = []
  for (let round = 0; round < 4; round++)
    for (const [index, chat] of pool.entries()) {
      const taken = used.get(chat.jid) || new Set<number>()
      const free = chat.segments.map((_, at) => at).filter((at) => !taken.has(at) && !taken.has(at - 1) && !taken.has(at + 1))
      if (!free.length) continue
      const start = free[Math.floor(rand() * free.length)]
      taken.add(start)
      used.set(chat.jid, taken)
      turns.push([index, chat, start])
    }
  for (const [index, chat, start] of turns) {
    if (out.length >= count) break
    const picked = chat.segments.slice(start, start + 2)
    const other = pool[(index + 1 + Math.floor(rand() * (pool.length - 1 || 1))) % pool.length]?.segments[0]
    // Tawaran bisnis / bot lain tidak digabung dengan pertanyaan pelanggan (tidak terjadi di chat nyata).
    const odd = (text = '') => isBusinessPitch(text) || isOtherBot(text) || text.length > 300
    const combined = rand() < mix && !odd(picked[0]?.teks) && !odd(other?.teks)
    const giliran = picked.map((segment, turn) => {
      let teks = segment.teks
      if (combined) {
        teks = roughen(rand, teks.replace(/\n+/g, ' '))
        // Giliran pertama digabung dengan pertanyaan pelanggan lain (dua maksud dalam satu pesan).
        if (turn === 0 && other && other.teks !== segment.teks) teks = `${teks}\n${roughen(rand, other.teks.replace(/\n+/g, ' '))}`
      }
      return segment.gambar || segment.kutip
        ? { teks, ...(segment.gambar ? { gambar: segment.gambar } : {}), ...(segment.kutip ? { kutip: segment.kutip } : {}) }
        : teks
    })
    const reference = picked
      .map((segment, turn) => `Giliran ${turn + 1} — CS manusia waktu itu: ${segment.jawaban.join(' / ')}`)
      .concat(combined && other ? [`Pertanyaan tambahan (digabung) — CS manusia waktu itu: ${other.jawaban.join(' / ')}`] : [])
    const before = chat.rows.slice(Math.max(0, (picked[0].mulai ?? 0) - 12), picked[0].mulai ?? 0)
    // Gambar di riwayat diberi keterangan seperti di sistem nyata (AI melihat isi gambar lama lewat catatan).
    const notes = await imageNotes(chat.jid, before.filter((row) => row.message_id) as any[]).catch(() => new Map<string, string>())
    out.push({
      id: `real-${out.length + 1}-s${seed}`,
      asal: picked.map((segment) => ({ teks: segment.teks, jawaban: segment.jawaban })),
      riwayat: before
        .filter((row) => row.body || row.media_type === 'image')
        .map((row) => ({
          arah: row.direction === 'in' ? ('in' as const) : ('out' as const),
          teks: String(row.body || '').slice(0, 600),
          gambar: row.media_type === 'image',
          ...(row.message_id && notes.get(String(row.message_id)) ? { catatan: notes.get(String(row.message_id)) } : {}),
        })),
      judul: `${combined ? 'Chat nyata (dikombinasikan)' : 'Chat nyata'} · ${maskPii(messageText(giliran[0])).replace(/\s+/g, ' ').slice(0, 48)}`,
      maksud: [
        'Pertanyaan dari chat nyata toko. Jawab semua maksudnya dengan benar menurut FAKTA saat ini, dengan rasa bahasa CS manusia.',
        'Acuan (harga/stok bisa sudah berubah — FAKTA saat ini yang berlaku):',
        ...reference,
      ].join('\n'),
      giliran,
    })
  }
  return out
}

/* ---------------- Riwayat uji (satu baris per putaran) ---------------- */

let ready = false
async function ensureSimTable() {
  if (ready) return
  await ensureLeanTables()
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_beta3_sim_runs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    total INT NOT NULL DEFAULT 0,
    done INT NOT NULL DEFAULT 0,
    passed INT NOT NULL DEFAULT 0,
    label VARCHAR(190) NOT NULL DEFAULT '',
    results LONGTEXT NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  // v3.6.79: percakapan yang sedang berjalan (tampilan langsung di Ruang simulasi).
  await db.rawQuery('ALTER TABLE whatsapp_beta3_sim_runs ADD COLUMN IF NOT EXISTS current LONGTEXT NULL')
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_beta3_sim_room (
    id INT UNSIGNED NOT NULL PRIMARY KEY,
    state LONGTEXT NULL,
    busy TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  ready = true
}

let running = false

/** Putaran berjalan di latar; hasil disimpan per percakapan supaya bisa dipantau. */
/** v3.6.94 — Uji berhenti bila akun AI terbaik sudah terpakai sebanyak ini (sisa untuk pelanggan sungguhan). */
export const SIM_QUOTA_LIMIT = 60
let stopRequested = ''
/** Hentikan uji yang sedang berjalan (selesai sesudah percakapan yang sedang diproses). */
export function stopSimRun(reason = 'Dihentikan') {
  if (!running) return { stopped: false }
  stopRequested = reason
  return { stopped: true }
}
type QuotaAccount = { provider: string; enabled: boolean; limitedUntil: number; windows: Array<{ usedPercent: number | null; expired?: boolean }> }
/** Sisa kuota: aman bila ada akun ChatGPT/Claude siap yang terpakai < SIM_QUOTA_LIMIT. */
export function quotaHeadroom(accounts: QuotaAccount[], limit = SIM_QUOTA_LIMIT) {
  // Belum ada akun terdaftar (mode penyedia tunggal lama): tidak dibatasi.
  if (!accounts.length) return { ok: true, used: 0, reason: '' }
  const ready = accounts.filter((account) => account.enabled && account.provider !== 'gemini' && !account.limitedUntil)
  if (!ready.length) return { ok: false, used: 100, reason: 'Tidak ada akun AI yang siap' }
  const used = Math.min(
    ...ready.map((account) => Math.max(0, ...account.windows.filter((window) => !window.expired).map((window) => Number(window.usedPercent ?? 0))))
  )
  return used >= limit
    ? { ok: false, used, reason: 'Kuota AI menipis — uji dihentikan agar pelanggan tetap dilayani' }
    : { ok: true, used, reason: '' }
}
/** v3.6.103 — pemilik mengizinkan uji memakai kuota lebih banyak (pelanggan ditangani CS): batas 95%. */
export const SIM_QUOTA_LIMIT_OWNER = 95
async function simQuotaHeadroom(limit = SIM_QUOTA_LIMIT) {
  const { readAiAccountQuotas } = await import('#services/ai_account_quota')
  const accounts = (await readAiAccountQuotas().catch(() => null)) as QuotaAccount[] | null
  return accounts ? quotaHeadroom(accounts, limit) : { ok: true, used: 0, reason: '' }
}

export async function startSimRun(
  settings: LeanSettings,
  input: {
    ids?: string[]
    custom?: SimScenario[]
    judge?: boolean
    label?: string
    generate?: { count: number; seed?: number }
    real?: { count: number; seed?: number; mix?: number }
    parallel?: number
    /** Pemilik mengizinkan memakai kuota sampai 95% (pelanggan ditangani CS). */
    ownerQuota?: boolean
  } = {}
) {
  const quotaLimit = input.ownerQuota ? SIM_QUOTA_LIMIT_OWNER : SIM_QUOTA_LIMIT
  await ensureSimTable()
  if (running) return { started: false, reason: 'Uji sedang berjalan.' }
  const headroom = await simQuotaHeadroom(quotaLimit)
  if (!headroom.ok) return { started: false, reason: headroom.reason }
  const all = await loadScenarios()
  const generated = input.generate?.count
    ? generateScenarios((await catalogDigest()).rows, Math.min(500, Math.max(1, input.generate.count)), input.generate.seed)
    : []
  const real = input.real?.count
    ? await realScenarios(Math.min(300, Math.max(1, input.real.count)), input.real.seed ?? Math.floor(Math.random() * 1_000_000), input.real.mix ?? 0.5)
    : []
  const picked = [
    ...(input.ids?.length ? all.filter((item) => input.ids!.includes(item.id)) : input.custom?.length || generated.length || real.length ? [] : all),
    ...(input.custom || []),
    ...real,
    ...generated,
  ]
  if (!picked.length) return { started: false, reason: 'Tidak ada percakapan uji.' }
  const [id] = await db.table('whatsapp_beta3_sim_runs').insert({
    status: 'running',
    total: picked.length,
    label: String(
      input.label ||
        (real.length
          ? `Chat nyata ${real.length}${generated.length ? ` + acak ${generated.length}` : ''}`
          : generated.length
            ? `Acak ${generated.length} · seed ${input.generate?.seed ?? ''}`
            : input.custom?.length && !input.ids?.length
              ? 'Coba sendiri'
              : 'Semua skenario')
    ).slice(0, 190),
    results: '[]',
    started_at: new Date(),
  })
  running = true
  stopRequested = ''
  void (async () => {
    const results: SimResult[] = []
    try {
      const facts = await judgeFacts(settings).catch(() => '')
      // v3.6.79: beberapa percakapan sekaligus (maks 4) supaya uji banyak skenario lebih cepat.
      const queue = [...picked]
      let checked = 0
      const one = async () => {
        while (queue.length && !stopRequested) {
          // Kuota dicek tiap 5 percakapan: uji tidak boleh menghabiskan jatah pelanggan.
          if (++checked % 5 === 0) {
            const headroom = await simQuotaHeadroom(quotaLimit)
            if (!headroom.ok) {
              stopRequested = headroom.reason
              break
            }
          }
          const scenario = queue.shift()!
          const live = (turns: SimTurn[]) =>
            db
              .from('whatsapp_beta3_sim_runs')
              .where('id', id)
              .update({ current: JSON.stringify({ id: scenario.id, judul: scenario.judul, giliran: turns }) })
              .then(() => {})
              .catch(() => {})
          await live([])
          const result = await runScenario(scenario, settings, { judge: input.judge, facts, onTurn: live }).catch(
            (error): SimResult => ({
              id: scenario.id,
              judul: scenario.judul,
              lulus: false,
              nilai: null,
              masalah: [`Gagal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)],
              giliran: [],
            })
          )
          results.push(result)
          await db
            .from('whatsapp_beta3_sim_runs')
            .where('id', id)
            .update({ done: results.length, passed: results.filter((item) => item.lulus).length, results: JSON.stringify(results) })
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, Math.max(1, input.parallel || 1)) }, one))
      await db
        .from('whatsapp_beta3_sim_runs')
        .where('id', id)
        .update(
          stopRequested
            ? { status: 'stopped', finished_at: new Date(), current: null, label: `${String(input.label || 'Uji')} · ${stopRequested}`.slice(0, 190) }
            : { status: 'done', finished_at: new Date(), current: null }
        )
    } catch (error) {
      await db
        .from('whatsapp_beta3_sim_runs')
        .where('id', id)
        .update({ status: 'failed', finished_at: new Date(), label: `Gagal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 190) })
        .catch(() => 0)
    } finally {
      running = false
    }
  })()
  return { started: true, id: Number(id), count: picked.length }
}

export async function listSimRuns(limit = 10) {
  await ensureSimTable()
  // Server dimulai ulang saat uji berjalan: putaran lama ditandai berhenti.
  if (!running)
    await db.from('whatsapp_beta3_sim_runs').where('status', 'running').update({ status: 'stopped', finished_at: new Date() }).catch(() => 0)
  const rows = await db.from('whatsapp_beta3_sim_runs').orderBy('id', 'desc').limit(limit)
  return rows.map((row: Record<string, any>) => ({
    id: Number(row.id),
    status: String(row.status),
    total: Number(row.total),
    done: Number(row.done),
    passed: Number(row.passed),
    label: String(row.label || ''),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }))
}

export async function readSimRun(id: number) {
  await ensureSimTable()
  const row = await db.from('whatsapp_beta3_sim_runs').where('id', id).first()
  if (!row) return null
  return {
    id: Number(row.id),
    status: String(row.status),
    total: Number(row.total),
    done: Number(row.done),
    passed: Number(row.passed),
    label: String(row.label || ''),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    results: JSON.parse(String(row.results || '[]')) as SimResult[],
    current: row.current ? (JSON.parse(String(row.current)) as { id: string; judul: string; giliran: SimTurn[] }) : null,
  }
}

/* ---------------- Ruang simulasi: chat uji yang diketik langsung (satu ruang per workspace) ---------------- */

type RoomState = SimState & { started: string }
async function readRoom(): Promise<{ state: RoomState; busy: boolean }> {
  await ensureSimTable()
  const row = await db.from('whatsapp_beta3_sim_room').where('id', 1).first()
  const state = row?.state ? (JSON.parse(String(row.state)) as RoomState) : null
  return {
    state: state || { ...newSimState('ruang'), started: new Date().toISOString() },
    // Sibuk lebih dari 3 menit = proses lama terputus (server dimulai ulang).
    busy: Boolean(row?.busy) && Date.now() - new Date(row.updated_at).getTime() < 3 * 60_000,
  }
}
async function writeRoom(state: RoomState, busy: boolean) {
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_sim_room (id, state, busy, updated_at) VALUES (1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), busy = VALUES(busy), updated_at = VALUES(updated_at)`,
    [JSON.stringify(state), busy ? 1 : 0, new Date()]
  )
}

/** Isi ruang simulasi + putaran uji yang sedang berjalan (untuk ditonton langsung). */
export async function simRoom() {
  const { state, busy } = await readRoom()
  const runs = await listSimRuns(1)
  const live = runs[0]?.status === 'running' ? await readSimRun(runs[0].id) : null
  return {
    turns: state.turns,
    busy,
    started: state.started,
    live: live ? { id: live.id, label: live.label, done: live.done, total: live.total, passed: live.passed, current: live.current, last: live.results.at(-1) || null } : null,
  }
}

/** Pesan baru di ruang simulasi; balasan diproses di latar (dipantau lewat simRoom). */
export async function sendSimRoom(settings: LeanSettings, message: SimMessage) {
  const { state, busy } = await readRoom()
  if (busy) return { started: false, reason: 'Balasan sebelumnya masih diproses.' }
  if (!message.teks.trim() && !message.gambar) return { started: false, reason: 'Pesan kosong.' }
  await writeRoom(state, true)
  void (async () => {
    try {
      await runSimTurn(state, { teks: message.teks.trim().slice(0, 2000), gambar: message.gambar }, settings)
    } finally {
      await writeRoom(state, false).catch(() => {})
    }
  })()
  return { started: true }
}

export async function resetSimRoom() {
  const { state } = await readRoom()
  await cleanupSim(state.jid)
  await writeRoom({ ...newSimState('ruang'), started: new Date().toISOString() }, false)
}


export type FastAuditItem = { intent: FastIntent; tanya: string; kilat: string[]; cs: string[] }
/**
 * v3.6.100 — Audit jalur kilat: pertanyaan pelanggan di chat nyata yang akan dijawab jalur kilat,
 * dibandingkan dengan jawaban CS manusia saat itu. Tanpa AI (0 kuota); untuk memastikan jawaban kilat
 * nyambung, benar, dan tidak menambah kata yang tidak perlu.
 */
export async function fastAudit(settings: LeanSettings, days = 365, perIntent = 40) {
  const since = new Date(Date.now() - days * 86_400_000)
  const jids = (await db
    .from('whatsapp_messages')
    .select('jid')
    .where('created_at', '>', since)
    .whereIn('sender_type', ['cs', 'owner'])
    .where((query) => query.where('jid', 'like', '%@s.whatsapp.net').orWhere('jid', 'like', '%@lid'))
    .groupBy('jid')) as Array<{ jid: string }>
  const methods = settings.paymentMethods.filter((method) => method.enabled)
  const facts = {
    store: String((await readLeanState('store_profile').catch(() => '')) || ''),
    rows: (await catalogDigest()).rows,
    ranges: productionRanges(settings.production),
    payment: renderPaymentMessage(methods.map((method) => ({ bank: method.name, number: method.destination, holder: method.accountName || '' }))),
    address: 'bos',
  }
  let segments = 0
  const counts: Record<string, number> = {}
  const items: FastAuditItem[] = []
  for (const { jid } of jids) {
    if (isSimJid(jid)) continue
    const rows = (await db
      .from('whatsapp_messages')
      .select('jid', 'message_id', 'reply_to_message_id', 'direction', 'sender_type', 'body', 'media_type', 'media_url', 'created_at')
      .where('jid', jid)
      .where('created_at', '>', since)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(600)) as RealRow[]
    for (const segment of realSegments(rows)) {
      segments++
      if (segment.gambar || segment.kutip) continue
      const intent = fastIntent(segment.teks)
      if (!intent) continue
      counts[intent] = (counts[intent] || 0) + 1
      const kilat = fastAnswer(intent, segment.teks, { ...facts, seed: `${jid}|${segment.mulai || 0}` })
      if (!kilat) continue
      items.push({ intent, tanya: maskPii(segment.teks).slice(0, 300), kilat, cs: segment.jawaban.map((text) => maskPii(text).slice(0, 400)) })
    }
  }
  const samples: FastAuditItem[] = []
  for (const intent of Object.keys(counts)) samples.push(...items.filter((item) => item.intent === intent).slice(-perIntent))
  return { chats: jids.length, segments, counts, samples }
}
