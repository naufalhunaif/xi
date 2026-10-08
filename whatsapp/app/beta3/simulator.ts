// v3.6.78 — Uji percakapan: pelanggan tiruan bertanya dengan bahasa yang beragam (slang, salah ketik,
// bahasa daerah, maksud tidak langsung) lalu balasan AI diproses PERSIS seperti chat sungguhan
// (createLeanReply + pemeriksa), tanpa mengirim apa pun ke WhatsApp. Tiap percakapan dinilai:
// pemeriksaan pasti (harga di luar katalog, tidak membalas, serah CS tanpa perlu, kata wajib) dan
// penilai AI yang membaca katalog lengkap. Data uji (jid "…@sim") dihapus sesudah tiap percakapan.
import app from '@adonisjs/core/services/app'
import { readFile } from 'node:fs/promises'
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeBeta3ChatNote } from '#beta3/tables'
import { catalogDigest } from '#beta3/catalog_service'
import { renderTotalMessage } from '#beta3/order_service'
import { pricePattern, renderPricePattern } from '#beta3/price_pattern'
import { renderWholesaleRule, wholesaleDiscounts } from '#beta3/wholesale'
import { runLeanProvider } from '#beta3/provider'
import { allowedPrices, unknownPrices } from '#beta3/quality_service'
import { bubblesToSend, createLeanReply, type LeanSettings } from '#beta3/reply_service'
import type { LeanHistoryRow } from '#beta3/prompt'

export type SimScenario = {
  id: string
  judul: string
  /** Apa yang diinginkan pelanggan + jawaban yang benar (untuk penilai). */
  maksud: string
  giliran: string[]
  harap?: {
    /** false = harus dijawab AI sendiri (tidak diserahkan ke CS). */
    serah_cs?: boolean
    /** Pola (regex, huruf besar/kecil sama) yang wajib muncul di balasan. */
    sebut?: string[]
    /** Pola yang tidak boleh muncul. */
    tidak_sebut?: string[]
    /** true = harus ada foto; false = tidak boleh ada foto. */
    foto?: boolean
  }
}

export type SimTurn = {
  pelanggan: string
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
  const text = turns.flatMap((turn) => [...turn.balasan, turn.total || '']).join('\n')
  for (const pattern of harap.sebut || [])
    if (!new RegExp(pattern, 'i').test(text)) issues.push(`Balasan tidak menyebut: ${pattern}`)
  for (const pattern of harap.tidak_sebut || [])
    if (new RegExp(pattern, 'i').test(text)) issues.push(`Balasan menyebut yang dilarang: ${pattern}`)
  const photos = turns.reduce((total, turn) => total + turn.foto.length, 0)
  if (harap.foto === true && !photos) issues.push('Seharusnya mengirim foto.')
  if (harap.foto === false && photos) issues.push('Seharusnya tidak mengirim foto.')
  return issues
}

/** Transkrip untuk penilai (dan untuk dibaca pemilik). */
export function transcript(turns: SimTurn[]) {
  return turns
    .flatMap((turn) => [
      `Pelanggan: ${turn.pelanggan}`,
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
export async function judgeFacts() {
  const digest = await catalogDigest()
  const wholesaleText = String((await readLeanState('wholesale').catch(() => '')) || '')
  return [
    String((await readLeanState('store_profile').catch(() => '')) || ''),
    renderWholesaleRule(wholesaleDiscounts(wholesaleText)) || wholesaleText,
    renderPricePattern(pricePattern(digest.rows)),
    digest.text,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Jalankan satu percakapan uji. */
export async function runScenario(
  scenario: SimScenario,
  settings: LeanSettings,
  options: { judge?: boolean; facts?: string } = {}
): Promise<SimResult> {
  const jid = `uji-${scenario.id.replace(/[^a-z0-9-]/gi, '').slice(0, 40)}-${Date.now().toString(36)}${SIM_DOMAIN}`
  const rows: LeanHistoryRow[] = []
  const turns: SimTurn[] = []
  const start = Date.now() - scenario.giliran.length * 90_000
  try {
    for (const [index, text] of scenario.giliran.entries()) {
      const at = new Date(start + index * 90_000)
      for (const row of rows) row.current = false
      rows.push({ direction: 'in', senderType: 'customer', body: text, createdAt: at, current: true })
      const jejak: string[] = []
      const began = Date.now()
      const turn: SimTurn = { pelanggan: text, balasan: [], foto: [], serah_cs: false, alasan: '', jejak, ms: 0 }
      try {
        const reply = await createLeanReply({
          jid,
          messageIds: [],
          text,
          settings,
          history: rows.map((row) => ({ ...row })),
          simulate: true,
          onTrace: (event) => {
            if (event.status !== 'running' && event.label) jejak.push(`${event.status === 'failed' ? '✗' : '·'} ${event.label}`)
          },
        })
        const { decision } = reply
        turn.balasan = bubblesToSend(decision)
        turn.foto = reply.photos.map((photo) => photo.caption)
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
        const out = (body: string, image = false) =>
          rows.push({ direction: 'out', senderType: 'ai', body, mediaType: image ? 'image' : null, createdAt: new Date(at.getTime() + 20_000) })
        const [first, ...rest] = turn.balasan
        if (first) out(first)
        for (const caption of turn.foto) out(caption, true)
        for (const bubble of rest) out(bubble)
        if (turn.total) out(turn.total)
        if (decision.catatan) await writeBeta3ChatNote(jid, decision.catatan)
      } catch (error) {
        turn.error = error instanceof Error ? error.message.slice(0, 300) : String(error)
      }
      turn.ms = Date.now() - began
      turns.push(turn)
      // Diserahkan ke CS: AI berhenti di chat ini (seperti chat sungguhan).
      if (turn.serah_cs || turn.error) break
    }
    const digest = await catalogDigest()
    const allowed = allowedPrices(digest.rows, [
      ...rows.map((row) => String(row.body || '')),
      ...turns.flatMap((turn) => turn.jejak),
    ])
    const masalah = deterministicIssues(scenario, turns, allowed)
    let nilai: number | null = null
    let judged = true
    if (options.judge !== false && !turns.some((turn) => turn.error)) {
      try {
        const verdict = await judge(settings, scenario, turns, options.facts || (await judgeFacts()))
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
    await cleanupSim(jid)
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
  ready = true
}

let running = false

/** Putaran berjalan di latar; hasil disimpan per percakapan supaya bisa dipantau. */
export async function startSimRun(
  settings: LeanSettings,
  input: { ids?: string[]; custom?: SimScenario[]; judge?: boolean; label?: string } = {}
) {
  await ensureSimTable()
  if (running) return { started: false, reason: 'Uji sedang berjalan.' }
  const all = await loadScenarios()
  const picked = [
    ...(input.ids?.length ? all.filter((item) => input.ids!.includes(item.id)) : input.custom?.length ? [] : all),
    ...(input.custom || []),
  ]
  if (!picked.length) return { started: false, reason: 'Tidak ada percakapan uji.' }
  const [id] = await db.table('whatsapp_beta3_sim_runs').insert({
    status: 'running',
    total: picked.length,
    label: String(input.label || (input.custom?.length && !input.ids?.length ? 'Coba sendiri' : 'Semua skenario')).slice(0, 190),
    results: '[]',
    started_at: new Date(),
  })
  running = true
  void (async () => {
    const results: SimResult[] = []
    try {
      const facts = await judgeFacts().catch(() => '')
      for (const scenario of picked) {
        const result = await runScenario(scenario, settings, { judge: input.judge, facts }).catch(
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
      await db.from('whatsapp_beta3_sim_runs').where('id', id).update({ status: 'done', finished_at: new Date() })
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
  }
}
