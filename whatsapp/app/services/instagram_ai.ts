import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { readSettings } from '#services/settings_service'
import { runLeanProvider } from '#beta3/provider'
import { catalogDigest } from '#beta3/catalog_service'
import { readIgConfig, readKey, writeKey } from '#services/instagram_store'
import { isQuestionComment } from '#services/instagram_worker'
import { isMediaFile, mediaPath, type PostItem, type PostKind } from '#services/instagram_publish'

/**
 * AI untuk konten Instagram:
 * - caption postingan baru (sesuai jenis, foto, katalog, dan gaya postingan yang terbukti ramai);
 * - analisis postingan yang sudah naik → apa yang mendatangkan pertanyaan & order.
 */

const run = promisify(execFile)

async function providerSettings() {
  const settings = await readSettings(true)
  return { ...settings, aiProvider: settings.aiProvider === 'claude' ? ('claude' as const) : ('chatgpt' as const) }
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

const clip = (value: unknown, max: number) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)

/* ───── Sinyal penjualan per postingan ───── */

export type PostSignals = { comments: number; questions: number; orders: number }

/**
 * Dari komentar yang masuk: berapa yang bertanya (minat beli) dan berapa penanya
 * yang akhirnya punya order (room Instagram mereka = `<id>@ig`).
 */
export async function postSignals(mediaIds: string[]): Promise<Map<string, PostSignals>> {
  const out = new Map<string, PostSignals>()
  const ids = [...new Set(mediaIds.filter(Boolean))]
  if (!ids.length) return out
  const rows = (await db
    .from('whatsapp_ig_comments')
    .whereIn('media_id', ids)
    .select('media_id', 'from_id', 'body')) as { media_id: string; from_id: string; body: string | null }[]
  const askers = new Map<string, Set<string>>()
  for (const row of rows) {
    const key = String(row.media_id)
    const entry = out.get(key) || { comments: 0, questions: 0, orders: 0 }
    entry.comments++
    if (isQuestionComment(String(row.body || ''))) {
      entry.questions++
      if (!askers.has(key)) askers.set(key, new Set())
      askers.get(key)!.add(`${row.from_id}@ig`)
    }
    out.set(key, entry)
  }
  const jids = [...new Set([...askers.values()].flatMap((set) => [...set]))]
  if (jids.length) {
    const buyers = new Set(
      (
        (await db
          .from('whatsapp_beta3_orders')
          .whereIn('jid', jids)
          .whereNot('status', 'cancelled')
          .select('jid')) as { jid: string }[]
      ).map((row) => row.jid)
    )
    for (const [key, set] of askers) out.get(key)!.orders = [...set].filter((jid) => buyers.has(jid)).length
  }
  return out
}

/* ───── Postingan terbaik sebagai contoh gaya ───── */

type StoredMedia = {
  id: string
  product: string
  type: string
  caption: string
  postedAt: string
  stats: Record<string, number>
}

async function storedMedia(limit: number): Promise<StoredMedia[]> {
  const rows = (await db
    .from('whatsapp_ig_media_stats')
    .whereNot('product', 'STORY')
    .orderBy('posted_at', 'desc')
    .limit(limit)) as any[]
  return rows.map((row) => {
    const meta = JSON.parse(row.meta || '{}')
    return {
      id: String(row.media_id),
      product: String(row.product || 'FEED'),
      type: meta.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : row.product === 'REELS' ? 'reels' : 'feed',
      caption: String(meta.caption || ''),
      postedAt: meta.timestamp || row.posted_at,
      stats: { likes: meta.like_count, comments: meta.comments_count, ...JSON.parse(row.stats || '{}') },
    }
  })
}

const score = (media: StoredMedia, signals?: PostSignals) =>
  Number(media.stats.reach || 0) +
  Number(media.stats.total_interactions || 0) * 10 +
  (signals?.questions || 0) * 200 +
  (signals?.orders || 0) * 1000

/* ───── Caption ───── */

const CAPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caption'],
  properties: {
    caption: {
      type: 'string',
      description: 'Caption siap posting, termasuk hashtag di akhir. Tanpa penjelasan tambahan.',
    },
  },
}

const KIND_GUIDE: Record<PostKind, string> = {
  feed: 'Feed 1 foto: 2–4 kalimat pendek. Baris pertama = hook yang membuat berhenti scroll.',
  carousel:
    'Carousel beberapa slide: hook di baris pertama, ajak geser ("geser →"), sebut singkat isi slide (mis. pilihan warna/detail), lalu ajakan.',
  reels: 'Reels/video: hook sangat pendek (≤ 8 kata) di baris pertama, 1–3 kalimat saja, lalu ajakan.',
  story: 'Story tidak memakai caption.',
}

/** Ambil satu frame dari video (bila ffmpeg tersedia) agar AI bisa melihat isinya. */
async function videoFrame(file: string) {
  const dir = app.makePath('storage', 'ig-media', 'frames')
  const out = `${dir}/${file.replace(/\.\w+$/, '')}.jpg`
  try {
    await access(out)
    return out
  } catch {}
  try {
    await mkdir(dir, { recursive: true })
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '1', '-i', mediaPath(file), '-frames:v', '1', '-vf', 'scale=720:-2', out], {
      timeout: 20_000,
    })
    return out
  } catch {
    return ''
  }
}

export async function generateCaption(input: { kind: PostKind; items: PostItem[]; note: string }) {
  if (input.kind === 'story') throw new Error('Story tidak memakai caption.')
  const files = input.items.filter((item) => isMediaFile(item.file)).slice(0, 6)
  const images: string[] = []
  for (const item of files) {
    if (images.length >= 4) break
    if (item.type === 'image') images.push(mediaPath(item.file))
    else {
      const frame = await videoFrame(item.file)
      if (frame) images.push(frame)
    }
  }
  if (!images.length && !input.note.trim()) throw new Error('Pilih foto/video atau tulis poin singkat dulu.')

  const config = await readIgConfig()
  const recent = await storedMedia(40)
  const signals = await postSignals(recent.map((media) => media.id))
  const best = recent
    .filter((media) => media.caption.trim())
    .sort((a, b) => score(b, signals.get(b.id)) - score(a, signals.get(a.id)))
    .slice(0, 5)
  const examples = best
    .map(
      (media, index) =>
        `#${index + 1} (${media.type}, jangkauan ${media.stats.reach ?? '?'}, pertanyaan ${signals.get(media.id)?.questions ?? 0})\n${media.caption.slice(0, 600)}`
    )
    .join('\n\n')
  const catalog = (await catalogDigest().catch(() => null))?.text.slice(0, 6000) || ''

  const system = `Kamu copywriter Instagram untuk toko pakaian ${config.username ? `@${config.username}` : ''}. Tulis caption Bahasa Indonesia yang membuat orang bertanya dan membeli.
Aturan:
- Ikuti gaya bahasa akun dari contoh caption terbaik (sapaan, panjang, emoji, hashtag). Bila tidak ada contoh: santai, sopan, singkat.
- ${KIND_GUIDE[input.kind]}
- Bila produk di foto cocok dengan katalog, sebut nama produk/warna persis seperti di katalog. Jangan mengarang produk.
- Jangan menulis harga, diskon, atau promo kecuali disebut di catatan pemilik.
- Akhiri dengan ajakan yang jelas: komentar atau DM untuk tanya ukuran/harga/order.
- 3–8 hashtag relevan di baris terakhir. Maksimal 1.500 karakter.
- Jawab hanya JSON sesuai skema.`
  const user = [
    `Jenis postingan: ${input.kind}${files.length ? ` · ${files.length} media (${files.map((item) => item.type).join(', ')})` : ''}`,
    images.length ? 'Foto/frame postingan terlampir.' : 'Tidak ada foto; tulis dari catatan saja.',
    input.note.trim() ? `Catatan/draf dari pemilik (wajib diikuti):\n${input.note.trim().slice(0, 1500)}` : '',
    examples ? `Contoh caption terbaik akun ini:\n${examples}` : '',
    catalog ? `Katalog toko (ringkas):\n${catalog}` : '',
    'Tulis caption-nya.',
  ]
    .filter(Boolean)
    .join('\n\n')
  const result = await runLeanProvider(
    await providerSettings(),
    { system, user },
    images,
    'ig-caption',
    CAPTION_SCHEMA as unknown as Record<string, unknown>
  )
  const parsed = parseJson(result.text)
  const caption = String(parsed?.caption ?? result.text ?? '').trim().slice(0, 2200)
  if (!caption) throw new Error('AI belum berhasil membuat caption. Coba lagi.')
  return caption
}

/* ───── Analisis konten ───── */

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ringkasan', 'berhasil', 'kurang', 'saran', 'ide', 'waktu'],
  properties: {
    ringkasan: { type: 'string', description: '2–3 kalimat: kondisi konten & hubungannya dengan minat beli.' },
    berhasil: {
      type: 'array',
      items: { type: 'string' },
      description: 'Pola yang terbukti mendatangkan jangkauan/pertanyaan/order. Sebut contoh postingannya (#nomor).',
    },
    kurang: { type: 'array', items: { type: 'string' }, description: 'Pola yang lemah/sepi pertanyaan.' },
    saran: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tindakan konkret ke depan untuk menaikkan pertanyaan & penjualan (jenis, hook, ajakan, frekuensi).',
    },
    ide: { type: 'array', items: { type: 'string' }, description: '3–5 ide konten berikutnya, satu kalimat masing-masing.' },
    waktu: { type: 'string', description: 'Hari/jam posting terbaik menurut data (WIB), atau "belum cukup data".' },
  },
}

export type IgAnalysis = {
  status: 'idle' | 'running' | 'done' | 'failed'
  at: number
  posts?: number
  error?: string
  result?: { ringkasan: string; berhasil: string[]; kurang: string[]; saran: string[]; ide: string[]; waktu: string }
}

const ANALYSIS_KEY = 'ig_analysis'
const RUNNING_LIMIT_MS = 5 * 60_000

export async function readAnalysis(): Promise<IgAnalysis> {
  try {
    const saved = JSON.parse((await readKey(ANALYSIS_KEY)) || 'null') as IgAnalysis | null
    if (!saved) return { status: 'idle', at: 0 }
    if (saved.status === 'running' && Date.now() - saved.at > RUNNING_LIMIT_MS)
      return { ...saved, status: 'failed', error: 'Analisis terlalu lama. Coba lagi.' }
    return saved
  } catch {
    return { status: 'idle', at: 0 }
  }
}

const wib = (value: string) =>
  new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

/** Mulai analisis di latar (hasil disimpan; halaman cukup menanyakan statusnya). */
export async function startAnalysis() {
  const current = await readAnalysis()
  if (current.status === 'running') return current
  const media = await storedMedia(40)
  if (media.length < 3) throw new Error('Butuh minimal 3 postingan dengan data performa. Buka tabel postingan dulu agar datanya terambil.')
  const next: IgAnalysis = { ...current, status: 'running', at: Date.now(), error: '' }
  await writeKey(ANALYSIS_KEY, JSON.stringify(next))
  void analyze(media).catch(async (error) => {
    await writeKey(
      ANALYSIS_KEY,
      JSON.stringify({ ...current, status: 'failed', at: Date.now(), error: error instanceof Error ? error.message : String(error) })
    ).catch(() => {})
  })
  return next
}

async function analyze(media: StoredMedia[]) {
  const signals = await postSignals(media.map((item) => item.id))
  const n = (value: unknown) => (value === undefined || value === null ? '-' : String(value))
  const lines = media.map((item, index) => {
    const s = signals.get(item.id)
    return `#${index + 1} | ${wib(item.postedAt)} | ${item.type} | jangkauan ${n(item.stats.reach)} | tayangan ${n(item.stats.views)} | suka ${n(item.stats.likes)} | komentar ${n(item.stats.comments)} | simpan ${n(item.stats.saved)} | bagikan ${n(item.stats.shares)} | kunjungan profil ${n(item.stats.profile_visits)} | pertanyaan ${s?.questions ?? 0} | order dari penanya ${s?.orders ?? 0} | caption: ${clip(item.caption, 220) || '(kosong)'}`
  })
  const system = `Kamu analis konten Instagram untuk toko pakaian. Tujuan utama: lebih banyak pertanyaan (minat beli) dan order, bukan sekadar likes.
Baca data postingan (terbaru di atas). "pertanyaan" = komentar yang bertanya harga/ukuran/stok; "order dari penanya" = penanya yang akhirnya order.
Bandingkan jenis (feed/carousel/reels), hook & ajakan di caption, topik produk, dan hari/jam posting. Bahasa Indonesia sederhana, tiap poin satu kalimat, tanpa istilah teknis. Jangan mengarang angka di luar data. Jawab hanya JSON sesuai skema.`
  const result = await runLeanProvider(
    await providerSettings(),
    { system, user: `Data ${media.length} postingan:\n${lines.join('\n')}\n\nBuat analisisnya.` },
    [],
    'ig-analysis',
    ANALYSIS_SCHEMA as unknown as Record<string, unknown>
  )
  const raw = parseJson(result.text)
  if (!raw) throw new Error('AI belum berhasil membuat analisis. Coba lagi.')
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .map((item) => clip(item, 400))
      .filter(Boolean)
      .slice(0, 6)
  const saved: IgAnalysis = {
    status: 'done',
    at: Date.now(),
    posts: media.length,
    result: {
      ringkasan: clip(raw.ringkasan, 800),
      berhasil: list(raw.berhasil),
      kurang: list(raw.kurang),
      saran: list(raw.saran),
      ide: list(raw.ide),
      waktu: clip(raw.waktu, 300),
    },
  }
  await writeKey(ANALYSIS_KEY, JSON.stringify(saved))
}
