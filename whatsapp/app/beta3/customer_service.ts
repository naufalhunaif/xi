// Beta 3 — alur AI CS. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { ensureLeanTables } from '#beta3/tables'
import { parseOrderForm } from '#beta3/order_service'
import { extractBodyMeasure } from '#beta3/mcp'

/**
 * Memori pelanggan = catatan pendek per nomor (maks ±10 baris), seperti CS
 * mengingat pelanggan lama. Ditulis oleh kode saat order disetujui, bukan oleh
 * AI tiap giliran. Dibaca apa adanya ke prompt.
 */
export const CUSTOMER_NOTE_LIMIT = 1200

export async function readCustomerNote(jid: string) {
  await ensureLeanTables()
  const row = await db.from('whatsapp_beta3_customers').where('jid', jid).first()
  return row?.note ? String(row.note) : ''
}

export async function writeCustomerNote(jid: string, note: string) {
  await ensureLeanTables()
  const value = note.trim().slice(0, CUSTOMER_NOTE_LIMIT)
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_customers (jid, note, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE note = VALUES(note), updated_at = VALUES(updated_at)`,
    [jid, value, new Date()]
  )
  return value
}

/** Gabungkan fakta baru ke catatan lama: baris berlabel sama diganti, sisanya dipertahankan. */
export function mergeCustomerNote(previous: string, facts: Record<string, string>) {
  const lines = previous
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const byLabel = new Map<string, string>()
  const order: string[] = []
  for (const line of lines) {
    const label = line.split(':')[0]?.trim().toLowerCase() || line
    if (!byLabel.has(label)) order.push(label)
    byLabel.set(label, line)
  }
  for (const [label, value] of Object.entries(facts)) {
    if (!value?.trim()) continue
    const key = label.trim().toLowerCase()
    if (!byLabel.has(key)) order.push(key)
    byLabel.set(key, `${label.trim()}: ${value.trim()}`)
  }
  return order
    .map((label) => byLabel.get(label)!)
    .join('\n')
    .slice(0, CUSTOMER_NOTE_LIMIT)
}

/**
 * Lembar spesifikasi pesanan per nomor — pengganti cart. Teks bebas yang ditulis
 * ulang lengkap oleh AI tiap giliran (produk, warna, size/ukuran, detail custom:
 * saku, kerah, list, kancing, dst.). Ikut ke order dan ke grup produksi.
 */
export const SPEC_LIMIT = 3000

export async function readOrderSpec(jid: string) {
  await ensureLeanTables()
  const row = await db.from('whatsapp_beta3_specs').where('jid', jid).first()
  return row?.spec ? String(row.spec) : ''
}

export async function writeOrderSpec(jid: string, spec: string) {
  await ensureLeanTables()
  const value = spec.trim().slice(0, SPEC_LIMIT)
  if (!value) {
    await db.from('whatsapp_beta3_specs').where('jid', jid).delete()
    return ''
  }
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_specs (jid, spec, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE spec = VALUES(spec), updated_at = VALUES(updated_at)`,
    [jid, value, new Date()]
  )
  return value
}

/**
 * v3.6.96 — Ingatan dari chat lama (seperti CS yang ingat pelanggannya): form order terakhir, tinggi/berat,
 * size jas dan nomor celana yang pernah disebut pelanggan. Dipakai bila belum ada catatan dari order.
 */
export function memoryFromChat(rows: Array<{ direction: string; body?: string | null }>) {
  const facts: Record<string, string> = {}
  for (const row of rows) {
    if (row.direction !== 'in') continue
    const text = String(row.body || '')
    const form = parseOrderForm(text)
    if (form) {
      facts['Nama'] = form.customerName
      facts['Alamat'] = [form.address, form.district, form.regency, form.postalCode].filter(Boolean).join(', ')
    }
    const body = extractBodyMeasure(text)
    if (body) facts['Tinggi/berat'] = `${body.height} cm / ${body.weight} kg`
    const size = text.match(/\b(?:size|ukuran|uk|pakai|biasa)\s*(xs|s|m|l|xl|xxl|[2-5]xl)\b/i)?.[1]
    if (size) facts['Size jas'] = size.toUpperCase()
    const pants = text.match(/\bcelana\w*\s+(?:no\.?\s*|nomor\s+|size\s+|ukuran\s+)?(2[6-9]|3\d|4[0-6])\b/i)?.[1]
    if (pants) facts['Celana'] = `no ${pants}`
  }
  return facts
}

/** Tambahkan ingatan dari chat lama ke catatan pelanggan tanpa menimpa data dari order. */
export function mergeChatMemory(previous: string, facts: Record<string, string>) {
  const known = new Set(previous.split('\n').map((line) => line.split(':')[0]?.trim().toLowerCase()).filter(Boolean))
  const fresh = Object.fromEntries(Object.entries(facts).filter(([label]) => !known.has(label.toLowerCase())))
  return Object.keys(fresh).length ? mergeCustomerNote(previous, fresh) : previous
}
