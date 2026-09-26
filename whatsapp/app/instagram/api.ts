// Instagram API dengan login Instagram (graph.instagram.com). Tanpa SDK.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { InstagramConfig } from '#instagram/store'

export const IG_VERSION = process.env.INSTAGRAM_API_VERSION || 'v25.0'
const GRAPH = `https://graph.instagram.com/${IG_VERSION}`
export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
]

async function call<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
  const data = (await response.json().catch(() => ({}))) as any
  if (!response.ok || data?.error) {
    const message = data?.error?.message || data?.error_message || `HTTP ${response.status}`
    throw new Error(`Instagram: ${String(message).slice(0, 250)}`)
  }
  return data as T
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

export function authorizeUrl(appId: string, redirectUri: string, state: string) {
  const query = new URLSearchParams({
    enable_fb_login: '0',
    force_authentication: '1',
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state,
  })
  return `https://www.instagram.com/oauth/authorize?${query}`
}

/** Kode OAuth → token jangka panjang (±60 hari) + id & username akun. */
export async function exchangeCode(config: InstagramConfig, code: string, redirectUri: string) {
  const form = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  })
  const short = await call<{ access_token: string }>('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body: form,
  })
  const long = await call<{ access_token: string; expires_in: number }>(
    `https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: config.appSecret,
      access_token: short.access_token,
    })}`
  )
  const me = await call<{ user_id?: string; id?: string; username?: string }>(
    `${GRAPH}/me?fields=user_id,username`,
    { headers: bearer(long.access_token) }
  )
  return {
    accessToken: long.access_token,
    expiresAt: new Date(Date.now() + Number(long.expires_in || 5_184_000) * 1000),
    igUserId: String(me.user_id || me.id || ''),
    username: String(me.username || ''),
  }
}

/** Token yang dibuat di dashboard Meta ("Generate access token") → id & username akun. */
export async function accountFromToken(token: string) {
  const me = await call<{ user_id?: string; id?: string; username?: string }>(
    `${GRAPH}/me?fields=user_id,username`,
    { headers: bearer(token) }
  )
  const igUserId = String(me.user_id || me.id || '')
  if (!igUserId) throw new Error('Instagram: token tidak valid.')
  return { igUserId, username: String(me.username || '') }
}

export async function refreshToken(token: string) {
  const data = await call<{ access_token: string; expires_in: number }>(
    `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: token,
    })}`
  )
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + Number(data.expires_in || 5_184_000) * 1000),
  }
}

/** Aktifkan webhook DM & komentar untuk akun ini. */
export async function subscribeApp(token: string) {
  return call(`${GRAPH}/me/subscribed_apps?subscribed_fields=messages,comments`, {
    method: 'POST',
    headers: bearer(token),
  })
}

export async function userProfile(token: string, igsid: string) {
  return call<{ username?: string; name?: string }>(`${GRAPH}/${igsid}?fields=name,username`, {
    headers: bearer(token),
  }).catch(() => ({}) as { username?: string; name?: string })
}

async function sendRaw(token: string, body: unknown) {
  return call<{ recipient_id?: string; message_id?: string }>(`${GRAPH}/me/messages`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function sendText(token: string, igsid: string, text: string) {
  return sendRaw(token, { recipient: { id: igsid }, message: { text } })
}

export async function sendImage(token: string, igsid: string, url: string) {
  try {
    return await sendRaw(token, {
      recipient: { id: igsid },
      message: { attachment: { type: 'image', payload: { url } } },
    })
  } catch {
    // Beberapa versi dokumentasi memakai `attachments`.
    return sendRaw(token, {
      recipient: { id: igsid },
      message: { attachments: { type: 'image', payload: { url } } },
    })
  }
}

/** Balasan pribadi dari komentar (satu kali per komentar, maks. 7 hari). */
export async function privateReply(token: string, commentId: string, text: string) {
  return sendRaw(token, { recipient: { comment_id: commentId }, message: { text } })
}

export async function replyComment(token: string, commentId: string, message: string) {
  return call<{ id?: string }>(`${GRAPH}/${commentId}/replies`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ message }),
  })
}

export type IgComment = {
  id: string
  text?: string
  timestamp?: string
  username?: string
  from?: { id?: string; username?: string }
  parent_id?: string
  media?: { id?: string }
}

/** Postingan terbaru akun sendiri (untuk cek komentar berkala). */
export async function recentMedia(token: string, limit = 10) {
  const data = await call<{ data?: Array<{ id: string; timestamp?: string; comments_count?: number }> }>(
    `${GRAPH}/me/media?fields=id,timestamp,comments_count&limit=${limit}`,
    { headers: bearer(token) }
  )
  return data.data || []
}

/** Komentar + balasan di satu postingan (terbaru dulu). */
export async function mediaComments(token: string, mediaId: string) {
  const fields = 'id,text,timestamp,username,from,parent_id,replies{id,text,timestamp,username,from,parent_id}'
  const data = await call<{ data?: Array<IgComment & { replies?: { data?: IgComment[] } }> }>(
    `${GRAPH}/${mediaId}/comments?fields=${encodeURIComponent(fields)}&limit=50`,
    { headers: bearer(token) }
  )
  const out: IgComment[] = []
  for (const comment of data.data || []) {
    out.push({ ...comment, media: { id: mediaId } })
    for (const reply of comment.replies?.data || [])
      out.push({ ...reply, parent_id: reply.parent_id || comment.id, media: { id: mediaId } })
  }
  return out
}

export async function hideComment(token: string, commentId: string) {
  return call(`${GRAPH}/${commentId}?hide=true`, { method: 'POST', headers: bearer(token) })
}

/** Tanda tangan webhook Meta: X-Hub-Signature-256 = sha256=HMAC(app secret, body mentah). */
export function validSignature(appSecret: string, rawBody: string, header: string | undefined) {
  if (!appSecret || !header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const given = header.slice(7)
  return (
    given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  )
}
