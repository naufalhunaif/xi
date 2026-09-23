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

export function customerIdentityContext(
  jid: string,
  mappedJid?: string | null,
  shopPhone?: string | null
) {
  const resolved = phoneFromJid(jid) || (jid.endsWith('@lid') ? phoneFromJid(mappedJid) : null)
  const phone = resolved === shopPhone ? null : resolved
  return [
    'IDENTITAS WHATSAPP PELANGGAN (metadata sistem, bukan hasil tebakan):',
    JSON.stringify({
      customerWhatsAppPhone: phone,
      phoneStatus: phone ? 'resolved' : 'unavailable',
      source: phone ? (phoneFromJid(jid) ? 'whatsapp_phone_jid' : 'whatsapp_lid_mapping') : null,
      shopWhatsAppPhone: shopPhone || null,
    }),
    'ID room bukan nomor telepon. Jangan memakai angka dari @lid sebagai nomor penerima.',
    'Jika pelanggan meminta "pakai nomor ini/nomor WhatsApp ini", gunakan customerWhatsAppPhone yang resolved untuk recipient.phone dalam cartIntent. Tidak perlu meminta nomor atau konfirmasi ulang yang sudah jelas. Lanjutkan kebutuhan tersisa sesuai konteks, bukan hanya "Siap, bos" atau menunggu persetujuan memakai nomor itu lagi.',
    'Nomor pengirim dan nomor penerima adalah data berbeda. Jangan otomatis mengisi atau menimpa nomor penerima tanpa pilihan pelanggan. Jika pelanggan memilih nomor lain, ikuti nomor itu; jika rujukannya ambigu, tanyakan satu klarifikasi singkat.',
    'Jika nomor pengirim unavailable, jangan mengarang: minta nomor hanya ketika diperlukan. Nomor toko, nomor rekening, ID order, kode pos, dan ID room bukan pengganti nomor pelanggan. Nomor penerima yang diberikan pelanggan tidak wajib terdaftar WhatsApp.',
  ].join('\n')
}

/** Reject the common hallucination even when a numeric LID passes phone-format validation. */
export function assertNotInternalPhone(jid: string, phone: string) {
  if (jid.endsWith('@lid') && phone && phone.replace(/[^0-9]/g, '') === jid.split(/[:@]/)[0])
    throw new Error(
      'Nomor penerima masih berupa ID internal WhatsApp. Gunakan nomor pelanggan yang terpetakan atau nomor yang diberikan pelanggan.'
    )
}
