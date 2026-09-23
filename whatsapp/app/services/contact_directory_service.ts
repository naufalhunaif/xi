import db from '#services/workspace_database'
import { phoneFromJid } from '#services/customer_identity_service'
import { readCustomerMemory } from '#services/conversation_memory'

type Address = {
  name: string
  phone: string
  address: string
  source: 'cart' | 'order' | 'conversation'
}
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const object = (value: unknown) => {
  try {
    return typeof value === 'string' ? JSON.parse(value) || {} : value || {}
  } catch {
    return {}
  }
}
export function directoryAddresses(
  candidates: Array<{ recipient: unknown; source: Address['source'] }>
): Address[] {
  const seen = new Set<string>()
  const addresses = new Set<string>()
  return candidates.flatMap(({ recipient, source }) => {
    const data = object(recipient)
    const row = {
      name: text(data.name),
      phone: text(data.phone),
      address: text(data.address),
      source,
    }
    if (!row.address) return []
    const addressKey = row.address.toLowerCase().replace(/\s+/g, ' ')
    if (!row.name && !row.phone && addresses.has(addressKey)) return []
    const key = [row.name, row.phone, row.address]
      .map((value) => value.toLowerCase().replace(/\s+/g, ' '))
      .join('\0')
    if (seen.has(key)) return []
    seen.add(key)
    addresses.add(addressKey)
    return [row]
  })
}

/** Read-only directory, scoped to the connected WhatsApp workspace. LIDs are never phone numbers. */
export async function contactDirectory(input: {
  query?: string
  page?: number
  limit?: number
  after?: string
}) {
  const page = Math.max(1, Math.min(100000, Math.floor(Number(input.page) || 1)))
  const limit = Math.max(1, Math.min(200, Math.floor(Number(input.limit) || 30)))
  const query = db
    .from('whatsapp_contacts as c')
    .where((q) => q.where('c.jid', 'like', '%@lid').orWhere('c.jid', 'like', '%@s.whatsapp.net'))
  const search = text(input.query).slice(0, 100)
  if (search)
    query.where((q) => {
      q.whereRaw('LOCATE(?, COALESCE(c.name, ?)) > 0', [search, ''])
        .orWhereRaw('LOCATE(?, COALESCE(c.phone_jid, ?)) > 0', [search, ''])
        .orWhereRaw('LOCATE(?, c.jid) > 0', [search])
        .orWhereIn(
          'c.jid',
          db
            .from('whatsapp_carts')
            .select('jid')
            .whereRaw('LOCATE(?, recipient_json) > 0', [search])
        )
        .orWhereIn(
          'c.jid',
          db
            .from('whatsapp_orders')
            .select('jid')
            .whereRaw("LOCATE(?, JSON_EXTRACT(snapshot_json, '$.recipient')) > 0", [search])
        )
        .orWhereIn(
          'c.jid',
          db
            .from('whatsapp_customer_memory')
            .select('jid')
            .where('topic', 'recipient')
            .whereRaw('LOCATE(?, value) > 0', [search])
        )
    })
  const total =
    input.after === undefined
      ? Number((await query.clone().count('* as count').first())?.count || 0)
      : undefined
  if (input.after !== undefined) query.where('c.jid', '>', input.after)
  const rows = await query
    .select('c.jid', 'c.name', 'c.phone_jid', 'c.profile_picture_url')
    .orderBy('c.jid', 'asc')
    .limit(limit)
    .offset(input.after === undefined ? (page - 1) * limit : 0)
  const ids = rows.map((row) => row.jid)
  if (!ids.length) return { contacts: [], total, page, limit, next: null }
  const carts = await db.from('whatsapp_carts').whereIn('jid', ids).select('jid', 'recipient_json')
  const orders = await db
    .from('whatsapp_orders')
    .whereIn('jid', ids)
    .select('jid')
    .select(db.raw("JSON_EXTRACT(snapshot_json, '$.recipient') as recipient_json"))
    .orderBy('id', 'desc')
  const contacts = []
  for (const row of rows) {
    const facts = await readCustomerMemory(row.jid)
    const addresses = directoryAddresses([
      ...carts
        .filter((item) => item.jid === row.jid)
        .map((item) => ({ recipient: item.recipient_json, source: 'cart' as const })),
      ...orders
        .filter((item) => item.jid === row.jid)
        .map((item) => ({ recipient: item.recipient_json, source: 'order' as const })),
      ...facts
        .filter(
          (fact) =>
            fact.topic === 'recipient' && /(?:^|[_-])(?:address|alamat)(?:[_-]|$)/i.test(fact.key)
        )
        .map((fact) => ({ recipient: { address: fact.value }, source: 'conversation' as const })),
    ])
    contacts.push({
      jid: row.jid,
      name: text(row.name),
      phone: phoneFromJid(row.jid) || phoneFromJid(row.phone_jid) || '',
      photo: text(row.profile_picture_url),
      addresses,
    })
  }
  return {
    contacts,
    total,
    page,
    limit,
    next: rows.length === limit ? (rows.at(-1)!.jid as string) : null,
  }
}

/** Quote RFC4180 cells and neutralize spreadsheet formulas from untrusted contact/chat text. */
export function csvCell(value: unknown) {
  let cell = String(value ?? '').replace(/\0/g, '')
  if (/^[\s\uFEFF]*[=+\-@]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`
  return `"${cell.replaceAll('"', '""')}"`
}
export function contactCsvRows(contacts: Awaited<ReturnType<typeof contactDirectory>>['contacts']) {
  return contacts
    .flatMap((contact) =>
      (contact.addresses.length
        ? contact.addresses
        : [{ name: '', phone: '', address: '', source: '' }]
      ).map(
        (address) =>
          [contact.name, contact.phone, address.name, address.phone, address.address]
            .map(csvCell)
            .join(',') + '\r\n'
      )
    )
    .join('')
}
