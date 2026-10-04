import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'

/** Only a phone-number JID is a phone. LIDs and bare numeric IDs are never decoded. */
export function phoneFromJid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^([1-9][0-9]{6,14})(?::[0-9]+)?@s\.whatsapp\.net$/.exec(value)?.[1] || null
}

export async function resolveCustomerPhoneJid(
  jid: string,
  lookup: (lid: string) => Promise<string | null | undefined>,
  alternate?: string | null
): Promise<string | null> {
  const direct = phoneFromJid(jid)
  if (direct) return `${direct}@s.whatsapp.net`
  if (!/^[0-9]+(?::[0-9]+)?@lid$/.test(jid)) return null
  const supplied = phoneFromJid(alternate)
  let mapped: string | null = null
  try {
    mapped = phoneFromJid(await lookup(jid))
  } catch {
    // A temporary mapping lookup failure must not interrupt message ingestion.
  }
  if (supplied && mapped && supplied !== mapped) return null
  const phone = mapped || supplied
  return phone ? `${phone}@s.whatsapp.net` : null
}

export async function rememberCustomerPhone(
  jid: string,
  lookup: (lid: string) => Promise<string | null | undefined>,
  alternate?: string | null
) {
  const phoneJid = await resolveCustomerPhoneJid(jid, lookup, alternate)
  if (!phoneJid || phoneFromJid(phoneJid) === workspaceScope().phone) return
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, phone_jid, phone_resolved_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE phone_jid = VALUES(phone_jid),
       phone_resolved_at = VALUES(phone_resolved_at)`,
    [jid, phoneJid, new Date(), new Date()]
  )
}
