import { createHmac, timingSafeEqual } from 'node:crypto'

/** Instagram API with Instagram Login (graph.instagram.com). Tanpa Facebook Page. */
export const IG_GRAPH = 'https://graph.instagram.com/v23.0'
export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
]

export class IgApiError extends Error {
  constructor(
    message: string,
    public code = 0,
    public status = 0
  ) {
    super(message)
  }
}

async function call(url: string, init: RequestInit = {}) {
  // Token dikirim sebagai access_token di query (cara yang didukung semua endpoint graph.instagram.com).
  const headers = new Headers(init.headers)
  const auth = headers.get('Authorization') || ''
  const target = new URL(url)
  if (auth.startsWith('Bearer ')) {
    target.searchParams.set('access_token', auth.slice(7))
    headers.delete('Authorization')
  }
  const response = await fetch(target, { ...init, headers, signal: AbortSignal.timeout(20_000) })
  const data = (await response.json().catch(() => ({}))) as any
  if (!response.ok || data?.error) {
    const error = data?.error || {}
    const where = target.pathname.replace(/^\/v[\d.]+/, '')
    throw new IgApiError(
      `${String(error.error_user_msg || error.message || error.error_message || data?.error_message || `Instagram API ${response.status}`)} (${where})`,
      Number(error.code || 0),
      response.status
    )
  }
  return data
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

export function authorizeUrl(appId: string, redirectUri: string, state: string) {
  const params = new URLSearchParams({
    enable_fb_login: '0',
    force_authentication: '1',
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state,
  })
  return `https://www.instagram.com/oauth/authorize?${params}`
}

/** Kode login → token jangka pendek → token 60 hari. */
export async function exchangeCode(input: { appId: string; appSecret: string; redirectUri: string; code: string }) {
  const short = await call('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.appId,
      client_secret: input.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      code: input.code.replace(/#_$/, ''),
    }),
  })
  const shortToken = String(short.access_token || short.data?.[0]?.access_token || '')
  const granted = short.permissions ?? short.data?.[0]?.permissions ?? ''
  const listed = (Array.isArray(granted) ? granted : String(granted).split(',')).map((x: string) => x.trim()).filter(Boolean)
  // Bila Instagram tidak menyebut izin yang diberikan, anggap sesuai yang diminta.
  const permissions = listed.length ? listed : [...IG_SCOPES]
  if (!shortToken) throw new IgApiError('Token Instagram tidak diterima.')
  const query = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: input.appSecret,
    access_token: shortToken,
  })
  const long = await firstOk([
    `https://graph.instagram.com/access_token?${query}`,
    `${IG_GRAPH}/access_token?${query}`,
  ])
  return { token: String(long.access_token), expiresIn: Number(long.expires_in || 0), permissions }
}

/** Coba beberapa bentuk URL yang setara; lempar error pertama bila semua gagal. */
async function firstOk(urls: string[]) {
  let first: unknown
  for (const url of urls) {
    try {
      return await call(url)
    } catch (error) {
      first ??= error
    }
  }
  throw first
}

export async function refreshToken(token: string) {
  const query = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })
  const data = await firstOk([
    `https://graph.instagram.com/refresh_access_token?${query}`,
    `${IG_GRAPH}/refresh_access_token?${query}`,
  ])
  return { token: String(data.access_token), expiresIn: Number(data.expires_in || 0) }
}

export async function me(token: string) {
  const data = await call(`${IG_GRAPH}/me?fields=user_id,username`, { headers: bearer(token) })
  return {
    userId: String(data.user_id || data.id || ''),
    username: String(data.username || ''),
    name: String(data.name || data.username || ''),
  }
}

/** Langganan webhook akun ini: DM, komentar, dan (v3.6.119) reaksi pesan. */
export const IG_FIELDS = 'messages,comments,message_reactions'
export async function subscribe(token: string, fields = IG_FIELDS) {
  return call(`${IG_GRAPH}/me/subscribed_apps?subscribed_fields=${fields}`, {
    method: 'POST',
    headers: bearer(token),
  })
}

/** v3.6.119 — reaksi ke pesan pelanggan. Instagram hanya mendukung "love" (❤️). */
export const sendReaction = (token: string, igsid: string, messageId: string, remove = false) =>
  send(token, {
    recipient: { id: igsid },
    sender_action: remove ? 'unreact' : 'react',
    payload: remove ? { message_id: messageId } : { message_id: messageId, reaction: 'love' },
  })

export async function profile(token: string, igsid: string) {
  try {
    const data = await call(`${IG_GRAPH}/${encodeURIComponent(igsid)}?fields=name,username,profile_pic`, {
      headers: bearer(token),
    })
    return {
      name: String(data.name || ''),
      username: String(data.username || ''),
      picture: String(data.profile_pic || ''),
    }
  } catch {
    return null
  }
}

async function send(token: string, body: Record<string, unknown>) {
  const data = await call(`${IG_GRAPH}/me/messages`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return String(data.message_id || '')
}

export const sendText = (token: string, igsid: string, text: string) =>
  send(token, { recipient: { id: igsid }, message: { text: text.slice(0, 1000) } })

export const sendImage = (token: string, igsid: string, url: string) =>
  send(token, { recipient: { id: igsid }, message: { attachment: { type: 'image', payload: { url } } } })

/** Balasan pribadi (DM) untuk satu komentar; hanya sekali per komentar, maks 7 hari. */
export const privateReply = (token: string, commentId: string, text: string) =>
  send(token, { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } })

/** Balasan publik di bawah komentar. */
export async function replyComment(token: string, commentId: string, text: string) {
  const data = await call(
    `${IG_GRAPH}/${encodeURIComponent(commentId)}/replies?${new URLSearchParams({ message: text.slice(0, 300) })}`,
    { method: 'POST', headers: bearer(token) }
  )
  return String(data.id || '')
}

export async function mediaInfo(token: string, mediaId: string) {
  try {
    const data = await call(
      `${IG_GRAPH}/${encodeURIComponent(mediaId)}?fields=caption,permalink,media_type,media_url,thumbnail_url`,
      { headers: bearer(token) }
    )
    // Video/reels: pakai gambar sampul.
    const image = String(data.media_type === 'VIDEO' ? data.thumbnail_url || '' : data.media_url || data.thumbnail_url || '')
    return { caption: String(data.caption || ''), permalink: String(data.permalink || ''), image }
  } catch {
    return { caption: '', permalink: '', image: '' }
  }
}

/** v3.6.113 — isi satu pesan DM (lampiran, postingan dibagikan, story) untuk memperbaiki pesan lama. */
/**
 * v3.6.115 — isi pesan DM dari API. Bidang lampiran/postingan baru keluar bila sub-bidangnya diminta
 * (attachments{image_data,…}, shares{link}); format API bisa berbeda, jadi dicoba beberapa susunan dan
 * hasilnya digabung. `_tries` = ringkasan percobaan (tanpa token) untuk diagnosa.
 */
const DETAIL_FIELDS = [
  'id,message,is_unsupported,attachments{image_data,video_data,audio_data,file_url,generic_template,name,mime_type},shares{link,name,description,template},story',
  'id,message,shares{link,name}',
  'id,message,attachments{image_data,video_data,file_url}',
  'id,message,attachments,shares,story',
]
export async function messageDetail(token: string, messageId: string) {
  const merged: Record<string, any> = {}
  const tries: Array<{ fields: string; keys?: string[]; error?: string }> = []
  for (const fields of DETAIL_FIELDS) {
    try {
      const data = await call(`${IG_GRAPH}/${encodeURIComponent(messageId)}?fields=${encodeURIComponent(fields)}`, { headers: bearer(token) })
      for (const [key, value] of Object.entries(data || {})) if (merged[key] === undefined || merged[key] === '') merged[key] = value
      tries.push({ fields: fields.slice(0, 48), keys: Object.keys(data || {}) })
    } catch (error) {
      tries.push({ fields: fields.slice(0, 48), error: (error instanceof Error ? error.message : String(error)).slice(0, 200) })
    }
  }
  return { ...merged, _tries: tries }
}

/**
 * v3.6.115 — cadangan: pesan-pesan percakapan dengan satu pelanggan (IGSID), lengkap dengan lampiran &
 * postingan yang dibagikan. API hanya memberi pesan terbaru; pesan lama bisa tidak ada.
 */
export async function conversationMessages(token: string, igsid: string) {
  const list = await call(
    `${IG_GRAPH}/me/conversations?platform=instagram&user_id=${encodeURIComponent(igsid)}&fields=id`,
    { headers: bearer(token) }
  )
  const id = String(list?.data?.[0]?.id || '')
  if (!id) return [] as any[]
  const fields = 'messages.limit(50){id,created_time,message,attachments{image_data,video_data,audio_data,file_url,generic_template},shares{link,name,description},story}'
  const data = await call(`${IG_GRAPH}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`, { headers: bearer(token) })
  return (Array.isArray(data?.messages?.data) ? data.messages.data : []) as any[]
}

/** X-Hub-Signature-256 = HMAC-SHA256(Instagram app secret, body mentah). */
export function validSignature(secret: string, raw: string, header: string) {
  if (!secret || !raw || !/^sha256=[a-f0-9]{64}$/.test(String(header || ''))) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'))
  const given = Buffer.from(String(header).slice(7))
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/* ───────────── Posting konten ───────────── */

const form = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][])

/** Membuat container media (feed/carousel item/reels/story). Kembalikan id container. */
export async function createContainer(token: string, params: Record<string, string | undefined>) {
  const data = await call(`${IG_GRAPH}/me/media`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  })
  return String(data.id || '')
}

/** Status pemrosesan container: IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED. */
export async function containerStatus(token: string, id: string) {
  const data = await call(`${IG_GRAPH}/${encodeURIComponent(id)}?fields=status_code,status`, { headers: bearer(token) })
  return { code: String(data.status_code || ''), detail: String(data.status || '') }
}

export async function publishContainer(token: string, creationId: string) {
  const data = await call(`${IG_GRAPH}/me/media_publish`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ creation_id: creationId }),
  })
  return String(data.id || '')
}

export async function mediaPermalink(token: string, id: string) {
  try {
    const data = await call(`${IG_GRAPH}/${encodeURIComponent(id)}?fields=permalink`, { headers: bearer(token) })
    return String(data.permalink || '')
  } catch {
    return ''
  }
}

/* ───────────── Insights ───────────── */

export async function profileStats(token: string) {
  return call(`${IG_GRAPH}/me?fields=username,followers_count,follows_count,media_count,profile_picture_url`, {
    headers: bearer(token),
  })
}

/** Total satu metrik akun dalam rentang (metric_type=total_value). */
export async function accountTotal(token: string, userId: string, metric: string, since: number, until: number) {
  const data = await call(
    `${IG_GRAPH}/${encodeURIComponent(userId)}/insights?${new URLSearchParams({
      metric,
      period: 'day',
      metric_type: 'total_value',
      since: String(since),
      until: String(until),
    })}`,
    { headers: bearer(token) }
  )
  const row = data.data?.[0]
  return {
    value: Number(row?.total_value?.value ?? 0),
    breakdowns: (row?.total_value?.breakdowns?.[0]?.results || []).map((r: any) => ({
      key: (r.dimension_values || []).join(' · '),
      value: Number(r.value || 0),
    })),
  }
}

/** Deret harian satu metrik akun (reach, follower_count). */
export async function accountSeries(token: string, userId: string, metric: string, since: number, until: number) {
  const data = await call(
    `${IG_GRAPH}/${encodeURIComponent(userId)}/insights?${new URLSearchParams({
      metric,
      period: 'day',
      since: String(since),
      until: String(until),
    })}`,
    { headers: bearer(token) }
  )
  return ((data.data?.[0]?.values || []) as any[]).map((v) => ({ date: String(v.end_time || ''), value: Number(v.value || 0) }))
}

/** Demografi pengikut: breakdown age | gender | city | country. */
export async function demographics(token: string, userId: string, breakdown: string) {
  const data = await call(
    `${IG_GRAPH}/${encodeURIComponent(userId)}/insights?${new URLSearchParams({
      metric: 'follower_demographics',
      period: 'lifetime',
      timeframe: 'this_month',
      metric_type: 'total_value',
      breakdown,
    })}`,
    { headers: bearer(token) }
  )
  return ((data.data?.[0]?.total_value?.breakdowns?.[0]?.results || []) as any[])
    .map((r) => ({ key: (r.dimension_values || []).join(' · '), value: Number(r.value || 0) }))
    .sort((a, b) => b.value - a.value)
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count'

/** Satu halaman postingan profil; `after` = kursor halaman berikutnya ('' bila sudah habis). */
export async function mediaPage(token: string, limit = 24, after = '') {
  const cursor = after ? `&after=${encodeURIComponent(after)}` : ''
  const data = await call(`${IG_GRAPH}/me/media?fields=${MEDIA_FIELDS}&limit=${limit}${cursor}`, { headers: bearer(token) })
  return {
    items: (data.data || []) as any[],
    after: data.paging?.next ? String(data.paging?.cursors?.after || '') : '',
  }
}

/** Isi carousel (foto/video satu per satu). */
export async function mediaChildren(token: string, id: string) {
  const data = await call(
    `${IG_GRAPH}/${encodeURIComponent(id)}/children?fields=id,media_type,media_url,thumbnail_url`,
    { headers: bearer(token) }
  )
  return (data.data || []) as any[]
}

export async function activeStories(token: string) {
  const data = await call(`${IG_GRAPH}/me/stories?fields=${MEDIA_FIELDS}`, { headers: bearer(token) })
  return (data.data || []) as any[]
}

const MEDIA_METRICS: Record<string, string[]> = {
  // total_likes/total_comments/total_views = termasuk hasil iklan (boost); Instagram hanya memberinya pada
  // login lewat Facebook — bila ditolak, otomatis dilewati (lihat `unsupported`).
  FEED: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'profile_visits', 'follows', 'total_likes', 'total_comments', 'total_views'],
  REELS: [
    'reach',
    'views',
    'likes',
    'comments',
    'shares',
    'saved',
    'total_likes',
    'total_comments',
    'total_views',
    'total_interactions',
    'ig_reels_avg_watch_time',
    'ig_reels_video_view_total_time',
    'profile_visits',
    'follows',
  ],
  STORY: ['reach', 'views', 'replies', 'shares', 'total_interactions', 'navigation', 'follows', 'profile_visits'],
}
/** Metrik yang pernah ditolak Instagram per jenis postingan → tidak diminta lagi (hemat panggilan). */
const unsupported = new Map<string, Set<string>>()

/**
 * Insights satu postingan. Semua metrik diminta sekaligus; bila ada yang ditolak, diambil satu per satu
 * agar metrik lain tetap ada. Untuk feed/reels juga rincian aktivitas profil (klik link bio, alamat, dll.).
 */
export async function mediaInsights(token: string, id: string, productType: string) {
  const skip = unsupported.get(productType) || new Set<string>()
  const metrics = (MEDIA_METRICS[productType] || MEDIA_METRICS.FEED).filter((metric) => !skip.has(metric))
  const read = (data: any) => {
    const out: Record<string, number> = {}
    for (const row of (data.data || []) as any[]) out[row.name] = Number(row.total_value?.value ?? row.values?.[0]?.value ?? 0)
    return out
  }
  const fetchMetrics = (list: string[]) =>
    call(`${IG_GRAPH}/${encodeURIComponent(id)}/insights?metric=${list.join(',')}`, { headers: bearer(token) })
  let out: Record<string, number> = {}
  try {
    out = read(await fetchMetrics(metrics))
  } catch {
    const parts = await Promise.all(
      metrics.map((metric) =>
        fetchMetrics([metric])
          .then(read)
          .catch(() => {
            skip.add(metric)
            return {}
          })
      )
    )
    // Bila semua gagal (mis. postingan dihapus/izin), jangan tandai metrik sebagai tidak didukung.
    if (parts.some((part) => Object.keys(part).length)) unsupported.set(productType, skip)
    out = Object.assign({}, ...parts)
  }
  if (productType !== 'STORY' && !skip.has('profile_activity')) {
    try {
      const data = await call(
        `${IG_GRAPH}/${encodeURIComponent(id)}/insights?metric=profile_activity&breakdown=action_type`,
        { headers: bearer(token) }
      )
      const row = (data.data || [])[0]
      if (row) {
        out.profile_activity = Number(row.total_value?.value ?? 0)
        for (const result of (row.total_value?.breakdowns?.[0]?.results || []) as any[])
          out[`pa_${String(result.dimension_values?.[0] || '').toLowerCase()}`] = Number(result.value || 0)
      }
    } catch {
      if (Object.keys(out).length) {
        skip.add('profile_activity')
        unsupported.set(productType, skip)
      }
    }
  }
  return out
}
