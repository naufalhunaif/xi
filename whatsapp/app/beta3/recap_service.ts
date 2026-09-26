// Beta 3 — rekap order dari chat yang dilayani CS manusia (tanpa mengirim pesan apa pun).
import db from '#services/workspace_database'
import { readSettings } from '#services/settings_service'
import { runLeanProvider } from '#beta3/provider'
import { renderHistory, type LeanHistoryRow } from '#beta3/prompt'
import {
  ensureLeanTables,
  readLeanState,
  writeLeanState,
  writeBeta3ChatNote,
} from '#beta3/tables'
import { nextOrderNumber, tidyLooseAddress } from '#beta3/order_service'
import { writeOrderSpec } from '#beta3/customer_service'

export const RECAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['lunas', 'menunggu_bayar', 'belum_order'],
      description:
        'lunas = pelanggan sudah transfer/kirim bukti DAN toko sudah mengonfirmasi (mis. "sudah masuk", "prosess ya"). menunggu_bayar = produk & total sudah disepakati tapi belum ada konfirmasi dana. belum_order = masih tanya-tanya / batal.',
    },
    rincian: {
      type: 'string',
      description:
        'Catatan untuk penjahit, baris pendek tanpa harga/label: per item "Produk - Warna", "Jas, Celana" (yang dibuat), "Size M/31", "Tinggi 164/68" bila ada, lalu detail custom satu per baris. Item dipisah baris kosong. Kosong bila belum_order.',
    },
    nama: { type: 'string', description: 'Nama penerima; kosong bila tidak disebut.' },
    hp: { type: 'string', description: 'Nomor HP penerima; kosong bila tidak disebut.' },
    alamat: { type: 'string', description: 'Alamat pengiriman lengkap persis dari chat; kosong bila tidak ada.' },
    total: { type: 'integer', description: 'Total yang disepakati/ditransfer (rupiah), 0 bila tidak jelas.' },
    ongkir: { type: 'integer', description: 'Ongkir (rupiah), 0 bila tidak jelas.' },
    layanan: { type: 'string', description: 'Layanan kirim (REG/YES/JTR/…); kosong bila tidak jelas.' },
    catatan: {
      type: 'string',
      description:
        'Catatan chat maksimal 6 baris "kunci: isi": produk, size, alamat, tahap, menunggu apa.',
    },
  },
  required: ['status', 'rincian', 'nama', 'hp', 'alamat', 'total', 'ongkir', 'layanan', 'catatan'],
} as const

export type ChatRecap = {
  status: 'lunas' | 'menunggu_bayar' | 'belum_order'
  rincian: string
  nama: string
  hp: string
  alamat: string
  total: number
  ongkir: number
  layanan: string
  catatan: string
}

const SYSTEM = `Kamu merangkum chat WhatsApp toko jas Chameleon Cloth untuk data order internal.
Tugasmu HANYA membaca riwayat chat lalu mengisi JSON; kamu tidak membalas pelanggan.
Aturan:
- Semua isi harus berasal dari chat. Jangan mengarang produk, harga, alamat, atau status.
- Pesan "CS (manusia)" dan "AI" sama-sama dari pihak toko.
- Bila ada beberapa pesanan dalam riwayat, rangkum pesanan TERAKHIR saja.
- status lunas hanya bila ada bukti transfer/pernyataan sudah bayar DAN toko mengonfirmasi dananya.
- Bila ragu soal angka, isi 0 atau kosong.`

function parseRecap(text: string): ChatRecap | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const status = ['lunas', 'menunggu_bayar', 'belum_order'].includes(String(raw.status))
      ? (String(raw.status) as ChatRecap['status'])
      : 'belum_order'
    const str = (value: unknown, max: number) => String(value || '').trim().slice(0, max)
    return {
      status,
      rincian: str(raw.rincian, 3000),
      nama: str(raw.nama, 190),
      hp: str(raw.hp, 40),
      alamat: str(raw.alamat, 600),
      total: Math.max(0, Math.round(Number(raw.total) || 0)),
      ongkir: Math.max(0, Math.round(Number(raw.ongkir) || 0)),
      layanan: str(raw.layanan, 40),
      catatan: str(raw.catatan, 1500),
    }
  } catch {
    return null
  }
}

async function chatHistory(jid: string, since: Date) {
  const rows = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('created_at', '>=', since)
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(120)
    .select('direction', 'sender_type', 'body', 'media_type', 'created_at', 'id')
  return rows.reverse()
}

/** Rangkum satu chat lewat AI. Null bila AI gagal. */
export async function summarizeChat(jid: string, since: Date): Promise<ChatRecap | null> {
  const rows = await chatHistory(jid, since)
  if (!rows.length) return null
  const settings = await readSettings(true)
  const history: LeanHistoryRow[] = rows.map((row) => ({
    direction: row.direction === 'in' ? 'in' : 'out',
    senderType: row.sender_type,
    body: row.body,
    mediaType: row.media_type,
    createdAt: row.created_at,
  }))
  const result = await runLeanProvider(
    { ...settings, aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt' },
    { system: SYSTEM, user: `${renderHistory(history)}\n\nIsi JSON rangkuman pesanan terakhir di chat ini.` },
    [],
    'beta3-recap',
    RECAP_SCHEMA as unknown as Record<string, unknown>
  )
  return parseRecap(result.text)
}

/**
 * Simpan hasil rangkuman: catatan chat diperbarui; bila ada pesanan, order dicatat
 * (sumber "rekap"), tanpa pesan ke pelanggan dan tanpa dikirim ulang ke grup.
 * Order aktif yang sudah ada diperbarui, bukan dibuat dobel.
 */
export async function saveRecap(jid: string, recap: ChatRecap) {
  await ensureLeanTables()
  if (recap.catatan) await writeBeta3ChatNote(jid, recap.catatan)
  if (recap.status === 'belum_order' || !recap.rincian) return null
  const tidy = recap.alamat ? tidyLooseAddress(`${recap.nama}\n${recap.hp}\n${recap.alamat}`) : null
  const now = new Date()
  const paid = recap.status === 'lunas'
  const values: Record<string, unknown> = {
    customer_name: (recap.nama || tidy?.name || '').slice(0, 190),
    address: tidy?.full || recap.alamat || null,
    district: (tidy?.district || '').slice(0, 120),
    regency: (tidy?.regency || '').slice(0, 120),
    postal_code: (tidy?.postalCode || '').slice(0, 20),
    phone: (recap.hp || tidy?.phone || jid.split('@')[0]).replace(/\D/g, '').slice(0, 40),
    items: recap.rincian.slice(0, 4000),
    spec: recap.rincian.slice(0, 4000),
    shipping_service: recap.layanan.slice(0, 40),
    shipping_cost: recap.ongkir || null,
    subtotal: recap.total && recap.ongkir && recap.total > recap.ongkir ? recap.total - recap.ongkir : null,
    total: recap.total || null,
    updated_at: now,
  }
  const active = await db
    .from('whatsapp_beta3_orders')
    .where('jid', jid)
    .whereIn('status', ['pending', 'awaiting_payment'])
    .orderBy('id', 'desc')
    .first()
  if (active) {
    await db
      .from('whatsapp_beta3_orders')
      .where('id', active.id)
      .update({
        ...values,
        status: paid ? 'paid' : 'awaiting_payment',
        order_number: active.order_number || (paid ? await nextOrderNumber() : null),
      })
    if (paid) await writeOrderSpec(jid, '')
    return Number(active.id)
  }
  // Order yang sudah lunas untuk pesanan yang sama tidak dibuat ulang.
  const since = new Date(Date.now() - 45 * 86_400_000)
  const done = await db
    .from('whatsapp_beta3_orders')
    .where('jid', jid)
    .where('status', 'paid')
    .where('created_at', '>=', since)
    .orderBy('id', 'desc')
    .first()
  if (done && (!recap.total || Number(done.total) === recap.total)) return null
  const [id] = await db.table('whatsapp_beta3_orders').insert({
    jid,
    ...values,
    status: paid ? 'paid' : 'awaiting_payment',
    order_number: paid ? await nextOrderNumber() : null,
    group_status: 'none',
    source: 'rekap',
    created_at: now,
  })
  if (paid) await writeOrderSpec(jid, '')
  else await writeOrderSpec(jid, recap.rincian)
  return Number(id)
}

/**
 * Chat yang pernah dibalas CS manusia dalam rentang hari dan belum punya order
 * (atau order-nya masih tertahan "menunggu total", mis. total dikirim CS manual).
 * Tidak memakai kata kunci: AI yang menilai dari maksud chat apakah ada pesanan.
 */
export async function recapCandidates(days: number) {
  await ensureLeanTables()
  const since = new Date(Date.now() - days * 86_400_000)
  const result = await db.rawQuery(
    `SELECT m.jid, MAX(m.id) AS last_id
       FROM whatsapp_messages m
      WHERE m.created_at >= ? AND (m.jid LIKE '%@s.whatsapp.net' OR m.jid LIKE '%@lid' OR m.jid LIKE '%@ig')
      GROUP BY m.jid
     HAVING SUM(m.direction = 'out' AND m.sender_type IN ('cs', 'owner')) > 0
        AND SUM(m.direction = 'in') > 0 AND COUNT(*) >= 4
        AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.created_at >= ?
          AND b.status <> 'pending')
      ORDER BY MAX(m.created_at) DESC
      LIMIT 500`,
    [since, since]
  )
  const rows = (Array.isArray(result) ? result[0] : result) as Array<{ jid: string; last_id: number }>
  const out: Array<{ jid: string; lastId: number }> = []
  for (const row of rows) {
    const done = await readLeanState(`rekap:${row.jid}`)
    if (done && Number(done) === Number(row.last_id)) continue
    out.push({ jid: row.jid, lastId: Number(row.last_id) })
  }
  return out
}

export type RecapProgress = {
  running: boolean
  days: number
  total: number
  done: number
  created: number
  failed: number
  startedAt: number
  finishedAt?: number
}

export async function readRecapProgress(): Promise<RecapProgress | null> {
  try {
    return JSON.parse((await readLeanState('rekap:progress')) || 'null')
  } catch {
    return null
  }
}

export async function requestRecap(days: number) {
  const current = await readRecapProgress()
  if (current?.running) return current
  const progress: RecapProgress = {
    running: true,
    days: Math.min(Math.max(Math.round(days) || 30, 1), 180),
    total: 0,
    done: 0,
    created: 0,
    failed: 0,
    startedAt: Date.now(),
  }
  await writeLeanState('rekap:progress', JSON.stringify(progress))
  return progress
}

/** Dijalankan worker: satu chat per panggilan supaya tidak memblokir balasan live. */
export async function runRecapStep() {
  const progress = await readRecapProgress()
  if (!progress?.running) return false
  const candidates = await recapCandidates(progress.days)
  if (!progress.total) progress.total = candidates.length + progress.done
  const next = candidates[0]
  if (!next) {
    progress.running = false
    progress.finishedAt = Date.now()
    await writeLeanState('rekap:progress', JSON.stringify(progress))
    return false
  }
  try {
    const recap = await summarizeChat(next.jid, new Date(Date.now() - progress.days * 86_400_000))
    if (recap && (await saveRecap(next.jid, recap))) progress.created++
    if (!recap) progress.failed++
  } catch {
    progress.failed++
  }
  progress.done++
  await writeLeanState(`rekap:${next.jid}`, String(next.lastId))
  await writeLeanState('rekap:progress', JSON.stringify(progress))
  return true
}
