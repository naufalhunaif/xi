// Kirim DM Instagram atas nama akun yang terhubung (dipakai listener).
import { readInstagram, instagramUserId, isInstagramJid } from '#instagram/store'
import { sendImage, sendText } from '#instagram/api'
import { publishShare } from '#instagram/media'
import { igMessageId } from '#instagram/webhook'
import db from '#services/workspace_database'

/** Instagram hanya mengizinkan balasan dalam 24 jam sejak pesan terakhir pelanggan. */
export const IG_REPLY_WINDOW_MS = 24 * 3_600_000

export async function lastCustomerMessageAt(jid: string) {
  const row = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    // Komentar (igc_) tidak membuka jendela 24 jam; hanya DM pelanggan.
    .whereNot('message_id', 'like', 'igc\\_%')
    .orderBy('created_at', 'desc')
    .first()
  return row ? new Date(row.created_at).getTime() : 0
}

export async function canReplyInstagram(jid: string) {
  if (!isInstagramJid(jid)) return false
  const config = await readInstagram()
  if (!config.connected || !config.dmEnabled) return false
  return Date.now() - (await lastCustomerMessageAt(jid)) < IG_REPLY_WINDOW_MS - 60_000
}

/** Teks dipecah per 1000 karakter (batas DM Instagram). */
function chunks(text: string) {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > 1000) {
    const cut = Math.max(rest.lastIndexOf('\n', 1000), rest.lastIndexOf(' ', 1000), 500)
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Kirim teks dan/atau gambar. Hasil: id pesan pertama (untuk disimpan). */
export async function sendInstagram(
  jid: string,
  content: { text?: string; image?: { bytes: Buffer; mime?: string } }
) {
  const config = await readInstagram()
  if (!config.connected) throw new Error('Instagram belum terhubung.')
  const igsid = instagramUserId(jid)
  const ids: string[] = []
  if (content.image) {
    const url = await publishShare(content.image.bytes, content.image.mime || 'image/jpeg')
    const sent = await sendImage(config.accessToken, igsid, url)
    if (sent.message_id) ids.push(igMessageId(sent.message_id))
  }
  for (const part of chunks(content.text || '')) {
    const sent = await sendText(config.accessToken, igsid, part)
    if (sent.message_id) ids.push(igMessageId(sent.message_id))
  }
  if (!ids.length) throw new Error('Pengiriman Instagram belum dikonfirmasi.')
  return ids[0]
}
