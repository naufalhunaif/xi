// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { ensureLeanTables } from '#beta3/tables'

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
