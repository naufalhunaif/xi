import db from '#services/workspace_database'
import { readKey, writeKey, type IgConfig } from '#services/instagram_store'
import * as ig from '#services/instagram_api'

/** Insights Instagram: ringkasan akun, performa postingan, dan story (disimpan sebelum hilang 24 jam). */
const TTL_MS = 30 * 60_000
const DEMO_TTL_MS = 6 * 3_600_000
const TOTALS = [
  'reach',
  'views',
  'accounts_engaged',
  'total_interactions',
  'likes',
  'comments',
  'shares',
  'saves',
  'profile_links_taps',
  'follows_and_unfollows',
]

async function cached<T>(key: string, ttl: number, load: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh) {
    try {
      const saved = JSON.parse((await readKey(key)) || 'null')
      if (saved && Date.now() - Number(saved.at) < ttl) return saved.data as T
    } catch {}
  }
  const data = await load()
  await writeKey(key, JSON.stringify({ at: Date.now(), data })).catch(() => {})
  return data
}

const permissionError = (error: unknown) =>
  error instanceof ig.IgApiError && [10, 200, 190].includes(error.code)

export async function accountOverview(config: IgConfig, days: number, fresh = false) {
  const span = [1, 7, 14, 30].includes(days) ? days : 7
  return cached(
    `ig_ins_${span}`,
    TTL_MS,
    async () => {
      const until = Math.floor(Date.now() / 1000)
      const since = until - span * 86_400
      const [profile, ...totals] = await Promise.allSettled([
        ig.profileStats(config.token),
        ...TOTALS.map((metric) => ig.accountTotal(config.token, config.userId, metric, since, until)),
      ])
      const [reach, followers] = await Promise.allSettled([
        ig.accountSeries(config.token, config.userId, 'reach', since, until),
        ig.accountSeries(config.token, config.userId, 'follower_count', Math.max(since, until - 30 * 86_400), until),
      ])
      const failures = [profile, ...totals].filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
      const metrics: Record<string, { value: number; breakdowns: { key: string; value: number }[] }> = {}
      TOTALS.forEach((metric, index) => {
        const result = totals[index]
        if (result.status === 'fulfilled') metrics[metric] = result.value
      })
      return {
        days: span,
        needsReconnect: failures.length === totals.length + 1 && failures.some((f) => permissionError(f.reason)),
        error: failures.length && !Object.keys(metrics).length ? String(failures[0].reason?.message || '') : '',
        profile: profile.status === 'fulfilled' ? profile.value : null,
        metrics,
        reach: reach.status === 'fulfilled' ? reach.value : [],
        followers: followers.status === 'fulfilled' ? followers.value : [],
      }
    },
    fresh
  )
}

export async function audience(config: IgConfig, fresh = false) {
  return cached(
    'ig_demo',
    DEMO_TTL_MS,
    async () => {
      const out: Record<string, { key: string; value: number }[]> = {}
      for (const breakdown of ['age', 'gender', 'city', 'country']) {
        try {
          out[breakdown] = (await ig.demographics(config.token, config.userId, breakdown)).slice(0, 8)
        } catch {
          out[breakdown] = []
        }
      }
      return out
    },
    fresh
  )
}

const productOf = (media: any) =>
  String(media.media_product_type || '') === 'REELS' ? 'REELS' : String(media.media_product_type || '') === 'STORY' ? 'STORY' : 'FEED'

async function saveStats(media: any, product: string, stats: Record<string, number>) {
  await db.rawQuery(
    `INSERT INTO whatsapp_ig_media_stats (media_id, product, meta, stats, posted_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE product = VALUES(product), meta = VALUES(meta), stats = VALUES(stats),
       posted_at = VALUES(posted_at), fetched_at = VALUES(fetched_at)`,
    [
      String(media.id),
      product,
      JSON.stringify(media),
      JSON.stringify(stats),
      media.timestamp ? new Date(media.timestamp) : null,
      new Date(),
    ]
  )
}

/** Umur data performa sebelum diambil ulang: postingan baru angkanya masih naik cepat. */
function statsTtl(timestamp: unknown) {
  const age = Date.now() - new Date(String(timestamp || 0)).getTime()
  if (age < 2 * 86_400_000) return 5 * 60_000
  if (age < 7 * 86_400_000) return 15 * 60_000
  return TTL_MS
}

/**
 * Postingan profil + performanya, per halaman 24.
 * Data disimpan sementara: postingan < 2 hari 5 menit, < 7 hari 15 menit, lebih lama 30 menit.
 * Halaman pertama: maks 8 diambil ulang per permintaan (semua bila `fresh`, dari tombol Perbarui).
 * Halaman lama (`after`): semua yang perlu diambil, 6 sekaligus.
 */
export async function mediaPerformance(config: IgConfig, after = '', fresh = false) {
  // Halaman pertama juga mengambil jumlah total postingan di profil (untuk hitungan tab).
  const [page, profile] = await Promise.all([
    ig.mediaPage(config.token, 24, after),
    after ? null : ig.profileStats(config.token).catch(() => null),
  ])
  const media = page.items
  const ids = media.map((m) => String(m.id))
  const rows = ids.length ? await db.from('whatsapp_ig_media_stats').whereIn('media_id', ids) : []
  const known = new Map((rows as any[]).map((row) => [String(row.media_id), row]))
  const statsOf = new Map<string, Record<string, number>>()
  const stale: any[] = []
  for (const item of media) {
    const row = known.get(String(item.id))
    if (row) statsOf.set(String(item.id), JSON.parse(row.stats || '{}'))
    if (fresh || !row || Date.now() - new Date(row.fetched_at).getTime() > statsTtl(item.timestamp)) stale.push(item)
  }
  const refresh = after || fresh ? stale : stale.slice(0, 8)
  for (let index = 0; index < refresh.length; index += 6) {
    await Promise.all(
      refresh.slice(index, index + 6).map(async (item) => {
        const product = productOf(item)
        const stats = await ig.mediaInsights(config.token, String(item.id), product)
        statsOf.set(String(item.id), stats)
        await saveStats(item, product, stats).catch(() => {})
      })
    )
  }
  const posts = media.map((item) => ({ ...item, product: productOf(item), stats: statsOf.get(String(item.id)) || {} }))
  if (after) return { posts, stories: [], next: page.after }
  // Story yang sudah lewat 24 jam (tersimpan oleh worker).
  const stories = await db
    .from('whatsapp_ig_media_stats')
    .where('product', 'STORY')
    .orderBy('posted_at', 'desc')
    .limit(30)
  return {
    posts,
    stories: (stories as any[]).map((row) => ({ ...JSON.parse(row.meta || '{}'), product: 'STORY', stats: JSON.parse(row.stats || '{}') })),
    next: page.after,
    total: Number(profile?.media_count) || 0,
  }
}

/** Worker: simpan insights story yang masih tayang (tiap 30 menit), karena hilang setelah 24 jam. */
export async function captureStories(config: IgConfig) {
  const last = Number((await readKey('ig_story_capture')) || 0)
  if (Date.now() - last < TTL_MS) return
  await writeKey('ig_story_capture', String(Date.now()))
  const stories = await ig.activeStories(config.token).catch(() => [])
  for (const story of stories) {
    const stats = await ig.mediaInsights(config.token, String(story.id), 'STORY')
    await saveStats(story, 'STORY', stats).catch(() => {})
  }
}
