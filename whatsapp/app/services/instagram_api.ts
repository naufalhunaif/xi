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

/** Langganan webhook akun ini: DM dan komentar. */
export async function subscribe(token: string) {
  return call(`${IG_GRAPH}/me/subscribed_apps?subscribed_fields=messages,comments`, {
    method: 'POST',
    headers: bearer(token),
  })
}

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

export const mediaCaption = async (token: string, mediaId: string) => (await mediaInfo(token, mediaId)).caption

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

export async function recentMedia(token: string, limit = 24) {
  const data = await call(`${IG_GRAPH}/me/media?fields=${MEDIA_FIELDS}&limit=${limit}`, { headers: bearer(token) })
  return (data.data || []) as any[]
}

export async function activeStories(token: string) {
  const data = await call(`${IG_GRAPH}/me/stories?fields=${MEDIA_FIELDS}`, { headers: bearer(token) })
  return (data.data || []) as any[]
}

const MEDIA_METRICS: Record<string, string[]> = {
  FEED: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'profile_visits', 'follows'],
  REELS: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'],
  STORY: ['reach', 'views', 'replies', 'shares', 'total_interactions', 'navigation', 'follows', 'profile_visits'],
}

/** Insights satu postingan; bila ada metrik yang tidak didukung, coba set yang lebih kecil. */
export async function mediaInsights(token: string, id: string, productType: string) {
  const full = MEDIA_METRICS[productType] || MEDIA_METRICS.FEED
  for (const metrics of [full, ['reach', 'views', 'total_interactions'], ['reach']]) {
    try {
      const data = await call(`${IG_GRAPH}/${encodeURIComponent(id)}/insights?metric=${metrics.join(',')}`, {
        headers: bearer(token),
      })
      const out: Record<string, number> = {}
      for (const row of (data.data || []) as any[])
        out[row.name] = Number(row.total_value?.value ?? row.values?.[0]?.value ?? 0)
      return out
    } catch {}
  }
  return {}
}
