import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import type { PaymentMethod } from '#services/payment_context_service'

export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  await initializeDatabase()
  const rows = await db.from('whatsapp_payment_methods').orderBy('id', 'asc')
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    destination: String(row.destination),
    accountName: String(row.account_name || ''),
    enabled: Boolean(row.enabled),
  }))
}

function field(
  input: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
  required = true
) {
  if (typeof input[key] !== 'string') {
    if (!required && input[key] === undefined) return ''
    throw new Error(`${label} tidak valid.`)
  }
  const value = input[key].trim()
  if (
    (required && !value) ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error(`${label} tidak valid.`)
  return value
}

function validId(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Metode pembayaran tidak valid.')
}

export async function savePaymentMethod(input: Record<string, unknown>, id?: number) {
  await initializeDatabase()
  const name = field(input, 'name', 'Nama metode', 120)
  const destination = field(input, 'destination', 'Tujuan pembayaran', 1000)
  const accountName = field(input, 'accountName', 'Atas nama', 190, false)
  if (typeof input.enabled !== 'boolean') throw new Error('Status metode tidak valid.')
  // Links are stored/displayed as text; never fetched or executed by the application.
  if (/^[a-z][a-z\d+.-]*:/i.test(destination)) {
    let url: URL
    try {
      url = new URL(destination)
    } catch {
      throw new Error('Tautan pembayaran tidak valid.')
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Gunakan tautan pembayaran HTTPS tanpa kredensial.')
  }
  const values = {
    name,
    destination,
    account_name: accountName,
    enabled: input.enabled,
    updated_at: new Date(),
  }
  if (id === undefined) {
    await db.table('whatsapp_payment_methods').insert({ ...values, created_at: new Date() })
  } else {
    validId(id)
    const changed = await db.from('whatsapp_payment_methods').where('id', id).update(values)
    if (!Number(changed)) throw new Error('Metode pembayaran tidak ditemukan.')
  }
  return listPaymentMethods()
}

export async function deletePaymentMethod(id: number) {
  await initializeDatabase()
  validId(id)
  const removed = await db.from('whatsapp_payment_methods').where('id', id).delete()
  if (!Number(removed)) throw new Error('Metode pembayaran tidak ditemukan.')
  return listPaymentMethods()
}
