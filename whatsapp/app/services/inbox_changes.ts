// v3.6.44 — Kotak masuk berbasis kejadian.
//
// Dulu browser meminta seluruh daftar chat (565+ room, ±400 KB, ±1 dtk kerja server) tiap 3 dtk.
// Sekarang:
//   1. muat bertahap: halaman pertama 60 room, sisanya di belakang;
//   2. pembaruan: browser bertanya "apa yang berubah sejak <cursor>?" → hanya room yang berubah;
//   3. dorong: /api/inbox/events (Server-Sent Events) memberi tahu browser begitu ada perubahan.
// Perubahan dibaca dari kolom waktu yang sudah ada (pesan baru, kontak, baca, order, goal, proses AI,
// dll.) — tanpa trigger database. Pengaman: browser tetap memuat ulang penuh sesekali.
import db from '#services/workspace_database'
import { inWorkspace, workspaceScope, type WorkspaceScope } from '#services/workspace_context'

/**
 * Tabel kecil yang mempengaruhi tampilan room, dengan kolom waktunya. Proses AI (ai_traces, tabel
 * besar) tidak dipindai: selama AI bekerja kolom aktivitas kontak ("Typing…") ikut berubah.
 */
const TIMED: Array<[table: string, columns: string[]]> = [
  ['whatsapp_contacts', ['updated_at', 'activity_updated_at', 'handoff_at']],
  ['whatsapp_room_reads', ['updated_at']],
  ['whatsapp_chat_goals', ['updated_at']],
  ['whatsapp_beta3_orders', ['updated_at']],
  ['whatsapp_beta3_chats', ['updated_at']],
  ['whatsapp_beta3_specs', ['updated_at']],
  ['whatsapp_beta3_shipments', ['created_at']],
  ['whatsapp_beta3_proofs', ['created_at']],
  ['whatsapp_beta3_priority', ['created_at']],
]
/** Selisih jam/pembulatan detik kolom DATETIME: rentang dibaca mundur sedikit (duplikat tidak masalah). */
const OVERLAP_MS = 3000
/** Lebih dari ini room berubah sekaligus → browser memuat ulang penuh. */
export const DELTA_MAX_ROOMS = 120

const scopeKey = (scope: WorkspaceScope) => `${scope.prefix}|${scope.id}`

/* ------------------------------------------------ sentuhan dari proses web (aksi CS) */
const touched = new Map<string, Array<{ jid: string; at: number }>>()
/** Dipanggil aksi CS di proses web (baca, mode, peran, kecualikan): room langsung ikut berubah. */
export function touchRoom(jid: string) {
  const key = scopeKey(workspaceScope())
  const list = (touched.get(key) || []).filter((item) => Date.now() - item.at < 10 * 60_000)
  list.push({ jid, at: Date.now() })
  touched.set(key, list)
  notify(key)
}

/* ------------------------------------------------ cursor */
export type InboxCursor = { at: number; messageId: number }
export function encodeCursor(cursor: InboxCursor) {
  return `${cursor.at}.${cursor.messageId}`
}
export function decodeCursor(value: unknown): InboxCursor | null {
  const match = String(value || '').match(/^(\d{10,})\.(\d+)$/)
  return match ? { at: Number(match[1]), messageId: Number(match[2]) } : null
}

/** Waktu database sekarang + id pesan terakhir: titik awal pembaruan berikutnya. */
export async function currentCursor(): Promise<InboxCursor> {
  const result = await db.rawQuery(
    `SELECT ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000) AS at, (SELECT COALESCE(MAX(id), 0) FROM whatsapp_messages) AS message_id`
  )
  const row = (result[0] as any[])[0] || {}
  return { at: Number(row.at) || Date.now(), messageId: Number(row.message_id) || 0 }
}

/**
 * Room (jid) yang berubah sejak cursor. `full` = terlalu banyak / pengaturan berubah → muat ulang penuh.
 */
export async function changedRooms(since: InboxCursor) {
  const cursor = await currentCursor()
  const from = new Date(since.at - OVERLAP_MS)
  const jids = new Set<string>()
  const add = (rows: any) => {
    for (const row of (Array.isArray(rows) ? rows : []) as Array<{ jid?: string }>) if (row?.jid) jids.add(String(row.jid))
  }
  // Pesan baru (indeks id), dan pesan keluar 5 menit terakhir (status antre → terkirim).
  add(
    await db
      .from('whatsapp_messages')
      .where('id', '>', since.messageId)
      .where('id', '<=', cursor.messageId)
      .distinct('jid')
      .limit(DELTA_MAX_ROOMS + 1)
  )
  add(
    await db
      .from('whatsapp_messages')
      .where('direction', 'out')
      .where('created_at', '>=', new Date(Math.min(from.getTime(), cursor.at - 5 * 60_000)))
      .distinct('jid')
      .limit(DELTA_MAX_ROOMS + 1)
  )
  for (const [table, columns] of TIMED) {
    const rows = await db
      .from(table)
      .where((query) => {
        for (const column of columns)
          // Label "Typing…" hilang sendiri 20 dtk kemudian: room ber-aktivitas dikirim ulang ±25 dtk.
          query.orWhere(column, '>=', column === 'activity_updated_at' ? new Date(from.getTime() - 25_000) : from)
      })
      .distinct('jid')
      .limit(DELTA_MAX_ROOMS + 1)
      .catch(() => [])
    add(rows)
  }
  for (const item of touched.get(scopeKey(workspaceScope())) || []) if (item.at >= from.getTime()) jids.add(item.jid)
  const settings = await db
    .from('whatsapp_settings')
    .where('updated_at', '>=', from)
    .first()
    .catch(() => null)
  return { cursor, jids: [...jids], full: Boolean(settings) || jids.size > DELTA_MAX_ROOMS }
}

/* ------------------------------------------------ dorong (Server-Sent Events) */
export type InboxEvent = 'changed' | 'status'
type Listener = (event: InboxEvent, data?: unknown) => void
type Hub = {
  scope: WorkspaceScope
  listeners: Set<Listener>
  signature: string
  timer: NodeJS.Timeout | null
  busy: boolean
  /** v3.6.116 — status sambungan terakhir yang dikirim (tanda tangan) + payloadnya untuk tab baru. */
  statusSignature: string
  status: unknown
  ticks: number
}
const hubs = new Map<string, Hub>()
const PROBE_MS = 1500
/** Status sambungan dibaca tiap 2 putaran (±3 dtk), sekali untuk semua tab. */
const STATUS_EVERY = 2

function notify(key: string) {
  const hub = hubs.get(key)
  if (hub) for (const listener of hub.listeners) listener('changed')
}

/**
 * v3.6.116 — tanda perubahan pesan yang sudah ada (bukan hanya pesan baru): status kirim (centang), media
 * selesai diunduh, isi diperbarui (mis. tautan postingan), reaksi. 300 pesan terakhir lewat rentang id (murah).
 */
export const RECENT_MESSAGES_SQL = `(SELECT COALESCE(BIT_XOR(CRC32(CONCAT_WS(',', id, status, COALESCE(media_status, ''), COALESCE(media_type, ''),
     COALESCE(media_url, ''), CHAR_LENGTH(COALESCE(body, ''))))), 0) FROM whatsapp_messages
     WHERE id > (SELECT COALESCE(MAX(id), 0) - 300 FROM whatsapp_messages))`

async function probeStatus(hub: Hub) {
  try {
    const { statusPayload, statusSignature } = await import('#services/live_status')
    const payload = await inWorkspace(hub.scope, () => statusPayload())
    const signature = statusSignature(payload as Record<string, any>)
    hub.status = payload
    if (signature !== hub.statusSignature) {
      const first = !hub.statusSignature
      hub.statusSignature = signature
      if (!first) for (const listener of hub.listeners) listener('status', payload)
    }
  } catch {
    // Coba lagi di putaran berikutnya.
  }
}

/** Status terakhir yang diketahui pemeriksa (untuk tab yang baru tersambung). */
export function lastStatus() {
  return hubs.get(scopeKey(workspaceScope()))?.status ?? null
}

/** Satu pemeriksaan murah per workspace (bukan per tab): berubah → semua tab diberi tahu. */
async function probe(hub: Hub) {
  if (hub.busy) return
  hub.busy = true
  try {
    const parts = TIMED.map(([table, columns]) =>
      columns.map((column) => `(SELECT MAX(${column}) FROM ${table})`).join(', ')
    ).join(', ')
    const signature = await inWorkspace(hub.scope, async () => {
      const result = await db.rawQuery(
        `SELECT CONCAT_WS('|',
           (SELECT COALESCE(MAX(id), 0) FROM whatsapp_messages),
           (SELECT COUNT(*) FROM whatsapp_messages WHERE direction = 'out' AND created_at >= NOW() - INTERVAL 5 MINUTE AND status IN ('sent', 'delivered', 'read')),
           (SELECT MAX(updated_at) FROM whatsapp_settings),
           ${RECENT_MESSAGES_SQL},
           (SELECT CONCAT(COUNT(*), ':', COALESCE(MAX(id), 0), ':', COALESCE(MAX(created_at), '')) FROM whatsapp_reactions),
           ${parts}) AS signature`
      )
      return String(((result[0] as any[])[0] || {}).signature || '')
    })
    if (hub.signature && signature !== hub.signature) for (const listener of hub.listeners) listener('changed')
    hub.signature = signature
    if (hub.ticks++ % STATUS_EVERY === 0) await probeStatus(hub)
  } catch {
    // Database sibuk sesaat: coba lagi di putaran berikutnya.
  } finally {
    hub.busy = false
  }
}

/** Daftarkan satu tab; kembalikan fungsi untuk melepas. */
export function subscribeInbox(listener: Listener) {
  const scope = workspaceScope()
  const key = scopeKey(scope)
  let hub = hubs.get(key)
  if (!hub) {
    hub = { scope, listeners: new Set(), signature: '', timer: null, busy: false, statusSignature: '', status: null, ticks: 0 }
    hubs.set(key, hub)
  }
  hub.listeners.add(listener)
  if (!hub.timer) {
    const active = hub
    void probe(active)
    active.timer = setInterval(() => void probe(active), PROBE_MS)
  }
  return () => {
    const current = hubs.get(key)
    if (!current) return
    current.listeners.delete(listener)
    if (!current.listeners.size) {
      if (current.timer) clearInterval(current.timer)
      hubs.delete(key)
    }
  }
}

/** Jumlah tab yang tersambung (untuk diagnosa/tes). */
export function inboxSubscribers() {
  let total = 0
  for (const hub of hubs.values()) total += hub.listeners.size
  return total
}
