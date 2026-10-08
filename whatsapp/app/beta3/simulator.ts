// v3.6.78 — Uji percakapan: pelanggan tiruan bertanya dengan bahasa yang beragam (slang, salah ketik,
// bahasa daerah, maksud tidak langsung) lalu balasan AI diproses PERSIS seperti chat sungguhan
// (createLeanReply + pemeriksa), tanpa mengirim apa pun ke WhatsApp. Tiap percakapan dinilai:
// pemeriksaan pasti (harga di luar katalog, tidak membalas, serah CS tanpa perlu, kata wajib) dan
// penilai AI yang membaca katalog lengkap. Data uji (jid "…@sim") dihapus sesudah tiap percakapan.
import app from '@adonisjs/core/services/app'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeBeta3ChatNote } from '#beta3/tables'
import { catalogDigest, findCatalogVariant } from '#beta3/catalog_service'
import { downloadOutgoingImage } from '#services/outgoing_image_service'
import { renderTotalMessage } from '#beta3/order_service'
import { pricePattern, renderPricePattern } from '#beta3/price_pattern'
import { renderWholesaleRule, wholesaleDiscounts } from '#beta3/wholesale'
import { runLeanProvider } from '#beta3/provider'
import { allowedPrices, unknownPrices } from '#beta3/quality_service'
import { bubblesToSend, createLeanReply, type LeanSettings } from '#beta3/reply_service'
import { renderProductionEstimate, type LeanHistoryRow } from '#beta3/prompt'
import { generateScenarios } from '#beta3/sim_generator'

export type SimScenario = {
  id: string
  judul: string
  /** Apa yang diinginkan pelanggan + jawaban yang benar (untuk penilai). */
  maksud: string
  /** Pesan pelanggan per giliran; bisa dengan gambar ("Produk - Warna" dari katalog, atau URL https). */
  giliran: Array<string | SimMessage>
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

export type SimMessage = { teks: string; gambar?: string }
export const messageText = (item: string | SimMessage) => (typeof item === 'string' ? item : String(item?.teks || ''))
export const messageImage = (item: string | SimMessage) => (typeof item === 'string' ? '' : String(item?.gambar || ''))

export type SimTurn = {
  pelanggan: string
  /** Gambar yang dikirim pelanggan (URL foto). */
  gambar?: string
  /** URL foto yang dikirim AI (urut sama dengan `foto`). */
  fotoUrl?: string[]
  /** Data alat yang dipakai AI giliran ini (ongkir, size, resi, ukuran) — untuk penilai. */
  alat?: string[]
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
    else if (!turn.balasan.length && !turn.foto.length && !turn.serah_cs) issues.push(`Giliran ${n}: tidak membalas.`)
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
export function transcript(turns: SimTurn[]) {
  return turns
    .flatMap((turn) => [
      `Pelanggan: ${turn.gambar ? '[mengirim foto] ' : ''}${turn.pelanggan}`,
      ...(turn.alat || []).map((data) => `(data alat untuk AI — ${data})`),
      ...turn.balasan.map((bubble) => `AI: ${bubble}`),
      ...turn.foto.map((caption) => `AI: [foto] ${caption}`),
      ...(turn.total ? [`Sistem: ${turn.total}`] : []),
      ...(turn.serah_cs ? [`(diserahkan ke CS: ${turn.alasan})`] : []),
    ])
    .join('\n')
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nilai: { type: 'integer', description: '1 (buruk) – 5 (seperti CS terbaik)' },
    lulus: { type: 'boolean' },
    masalah: { type: 'array', items: { type: 'string' } },
  },
  required: ['nilai', 'lulus', 'masalah'],
}

async function judge(settings: LeanSettings, scenario: SimScenario, turns: SimTurn[], facts: string) {
  const reply = await runLeanProvider(
    settings,
    {
      system: [
        'Kamu auditor CS toko jas Chameleon Cloth. Nilai percakapan uji antara pelanggan dan AI CS. Balas HANYA JSON sesuai skema.',
        'Periksa ketat: (1) maksud pelanggan dipahami walau bahasanya tidak baku/daerah/salah ketik/tidak langsung; (2) setiap angka harga, warna, size ready, dan info toko benar menurut FAKTA; (3) foto yang dikirim persis sesuai yang diucapkan/dijanjikan balasan (tidak kurang, tidak lebih, tidak beda); (4) tidak mengarang, tidak mengulang pertanyaan yang sudah dijawab, tidak menyerahkan ke CS bila jawabannya ada di FAKTA; (5) gaya chat CS singkat dan sopan.',
        'Baris "(data alat untuk AI — …)" adalah hasil alat toko (ongkir, size, resi) yang dibaca AI: angka yang cocok dengan data itu BENAR, bukan karangan.',
        'lulus = true hanya bila tidak ada kesalahan fakta, foto cocok, dan maksud terjawab. masalah: kalimat pendek bahasa Indonesia, sebut giliran & kutip bagian yang salah. Tanpa masalah → [].',
        `FAKTA TOKO:\n${facts}`,
      ].join('\n\n'),
      user: `MAKSUD PELANGGAN & JAWABAN YANG DIHARAPKAN:\n${scenario.maksud}\n\nPERCAKAPAN:\n${transcript(turns)}`,
    },
    [],
    'beta3-sim-judge',
    JUDGE_SCHEMA,
    { providers: ['claude', 'chatgpt'] }
  )
  const parsed = JSON.parse(reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1)) as {
    nilai?: number
    lulus?: boolean
    masalah?: string[]
  }
  return {
    nilai: Math.max(1, Math.min(5, Math.round(Number(parsed.nilai) || 1))),
    lulus: parsed.lulus === true,
    masalah: (parsed.masalah || []).map(String).filter(Boolean).slice(0, 8),
  }
}

/** Fakta lengkap untuk penilai: profil toko, katalog, pola harga, grosir. */
export async function judgeFacts(settings?: LeanSettings) {
  const digest = await catalogDigest()
  const production = settings?.production ? renderProductionEstimate(settings.production) : ''
  const wholesaleText = String((await readLeanState('wholesale').catch(() => '')) || '')
  return [
    String((await readLeanState('store_profile').catch(() => '')) || ''),
    renderWholesaleRule(wholesaleDiscounts(wholesaleText)) || wholesaleText,
    renderPricePattern(pricePattern(digest.rows)),
    production,
    digest.text,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Langkah yang membawa data alat (dibaca AI) — ikut ke penilai & pemeriksa harga uji. */
const TOOL_TRACES = new Set(['beta3-rates', 'beta3-fit', 'beta3-sizechart', 'beta3-awb', 'beta3-total', 'beta3-wholesale', 'beta3-price-context'])

/** Gambar pelanggan untuk uji: label katalog ("Produk - Warna") atau URL https → file sementara. */
async function simImage(ref: string, rows: Awaited<ReturnType<typeof catalogDigest>>['rows']) {
  const url = /^https:\/\//i.test(ref) ? ref : findCatalogVariant(rows, ref)?.photoUrl || ''
  if (!url) throw new Error(`Gambar uji tidak ditemukan: ${ref}`)
  const bytes = await downloadOutgoingImage(url)
  const path = join(tmpdir(), `wa-sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`)
  await writeFile(path, bytes)
  return { url, path }
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
  try {
    const digest = await catalogDigest()
    if (image) {
      const got = await simImage(image, digest.rows)
      file = got.path
      turn.gambar = got.url
    }
    for (const row of state.rows) row.current = false
    state.rows.push({ direction: 'in', senderType: 'customer', body: text, mediaType: image ? 'image' : null, createdAt: at, current: true })
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
  } catch (error) {
    turn.error = error instanceof Error ? error.message.slice(0, 300) : String(error)
  } finally {
    if (file) await rm(file, { force: true }).catch(() => {})
  }
  turn.ms = Date.now() - began
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
    let judged = true
    if (options.judge !== false && !turns.some((turn) => turn.error)) {
      try {
        const verdict = await judge(settings, scenario, turns, options.facts || (await judgeFacts(settings)))
        nilai = verdict.nilai
        judged = verdict.lulus
        masalah.push(...verdict.masalah.map((item) => `Penilai: ${item}`))
      } catch (error) {
        masalah.push(`Penilai gagal: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
        judged = false
      }
    }
    const hard = masalah.filter((item) => !item.startsWith('Penilai'))
    return { id: scenario.id, judul: scenario.judul, lulus: !hard.length && judged, nilai, masalah, giliran: turns }
  } finally {
    await cleanupSim(state.jid)
  }
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
export async function startSimRun(
  settings: LeanSettings,
  input: { ids?: string[]; custom?: SimScenario[]; judge?: boolean; label?: string; generate?: { count: number; seed?: number }; parallel?: number } = {}
) {
  await ensureSimTable()
  if (running) return { started: false, reason: 'Uji sedang berjalan.' }
  const all = await loadScenarios()
  const generated = input.generate?.count
    ? generateScenarios((await catalogDigest()).rows, Math.min(500, Math.max(1, input.generate.count)), input.generate.seed)
    : []
  const picked = [
    ...(input.ids?.length ? all.filter((item) => input.ids!.includes(item.id)) : input.custom?.length || generated.length ? [] : all),
    ...(input.custom || []),
    ...generated,
  ]
  if (!picked.length) return { started: false, reason: 'Tidak ada percakapan uji.' }
  const [id] = await db.table('whatsapp_beta3_sim_runs').insert({
    status: 'running',
    total: picked.length,
    label: String(
      input.label ||
        (generated.length ? `Acak ${generated.length} · seed ${input.generate?.seed ?? ''}` : input.custom?.length && !input.ids?.length ? 'Coba sendiri' : 'Semua skenario')
    ).slice(0, 190),
    results: '[]',
    started_at: new Date(),
  })
  running = true
  void (async () => {
    const results: SimResult[] = []
    try {
      const facts = await judgeFacts(settings).catch(() => '')
      // v3.6.79: beberapa percakapan sekaligus (maks 4) supaya uji banyak skenario lebih cepat.
      const queue = [...picked]
      const one = async () => {
        while (queue.length) {
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
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, input.parallel || 1)) }, one))
      await db.from('whatsapp_beta3_sim_runs').where('id', id).update({ status: 'done', finished_at: new Date(), current: null })
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
