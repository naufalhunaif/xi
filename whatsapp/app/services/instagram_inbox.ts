import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import db from '#services/workspace_database'
import { workspaceFileName } from '#services/workspace_context'
import { invalidateConversationGoal } from '#services/conversation_goal_service'
import { resumeAiAfterHumanReply } from '#services/message_service'
import { readSettings } from '#services/settings_service'
import { ensureIgTables, igJid, readIgConfig, type IgConfig } from '#services/instagram_store'
import { profile } from '#services/instagram_api'

/**
 * Webhook Instagram → tabel pesan yang sama dengan WhatsApp. Balasan AI dikerjakan worker
 * (instagram_worker) setelah jeda penggabungan pesan, seperti giliran WhatsApp.
 */
type Messaging = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    is_deleted?: boolean
    is_unsupported?: boolean
    reply_to?: { mid?: string; story?: { url?: string; id?: string } }
    attachments?: Array<{ type?: string; payload?: { url?: string; title?: string; ig_post_media_id?: string } }>
  }
}

/** Reel = video: tautannya disimpan di teks (CS bisa membuka). */
const REEL = new Set(['ig_reel', 'reel'])
const SAMPLE_LIMIT = 300
/**
 * v3.6.109 — contoh webhook Instagram (lampiran, balasan story, pesan tidak didukung) disimpan (maks 300 baris)
 * supaya format baru dari Instagram bisa ditangani dari data asli, bukan tebakan.
 */
async function recordIgSample(event: Messaging) {
  const message = event.message
  if (!message || (!message.attachments?.length && !message.reply_to?.story && !message.is_unsupported)) return
  const file = app.makePath('storage', 'ig-webhook-samples.jsonl')
  await mkdir(app.makePath('storage'), { recursive: true })
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`)
  const lines = String(await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  if (lines.length > SAMPLE_LIMIT) await writeFile(file, `${lines.slice(-SAMPLE_LIMIT).join('\n')}\n`)
}

/** Lampiran yang punya gambar pratinjau (postingan / story yang dibagikan). Reel = video, tetap teks. */
const SHARED_PREVIEW = new Set(['share', 'ig_post', 'story_mention'])

const ATTACHMENT_NOTE: Record<string, string> = {
  image: '',
  video: '[video]',
  audio: '[pesan suara]',
  file: '[file]',
  share: '[membagikan postingan]',
  ig_reel: '[membagikan reel]',
  reel: '[membagikan reel]',
  story_mention: '[menyebut toko di story]',
  ig_post: '[membagikan postingan]',
}

export async function ingestInstagramWebhook(body: any) {
  await ensureIgTables()
  const config = await readIgConfig()
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const event of Array.isArray(entry?.messaging) ? (entry.messaging as Messaging[]) : [])
      await ingestMessaging(event, config).catch(() => {})
    for (const change of Array.isArray(entry?.changes) ? entry.changes : [])
      if (change?.field === 'comments') await ingestComment(change.value, config).catch(() => {})
  }
}

async function ensureContact(jid: string, igsid: string, config: IgConfig) {
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  if (contact?.name) return
  const info = config.token ? await profile(config.token, igsid) : null
  const name = (info?.name || (info?.username ? `@${info.username}` : '') || 'Instagram').slice(0, 190)
  if (contact)
    await db
      .from('whatsapp_contacts')
      .where('jid', jid)
      .update({ name, profile_picture_url: info?.picture || null, updated_at: new Date() })
  else
    await db.table('whatsapp_contacts').insert({
      jid,
      name,
      profile_picture_url: info?.picture || null,
      handling_mode: 'ai',
      updated_at: new Date(),
    })
}

async function scheduleTurn(jid: string, anchor: string) {
  const settings = await readSettings(true)
  const windowMs = Math.max(2000, Number(settings.turnWindowMs) || 6000)
  await db.rawQuery(
    `INSERT INTO whatsapp_ig_turns (jid, anchor_message_id, due_at, updated_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE anchor_message_id = VALUES(anchor_message_id), due_at = VALUES(due_at), updated_at = VALUES(updated_at)`,
    [jid, anchor, new Date(Date.now() + windowMs), new Date()]
  )
}

async function ingestMessaging(event: Messaging, config: IgConfig) {
  const message = event.message
  const mid = String(message?.mid || '')
  if (!message || !mid || message.is_deleted) return
  await recordIgSample(event).catch(() => {})
  const echo = Boolean(message.is_echo)
  // v3.6.109: pesan yang tidak didukung API (mis. stiker/format baru) dulu dibuang → pelanggan tidak terbalas.
  if (message.is_unsupported && echo) return
  const customer = String((echo ? event.recipient?.id : event.sender?.id) || '')
  if (!customer || customer === config.userId) return
  const jid = igJid(customer)
  if (await db.from('whatsapp_messages').where('message_id', mid).first()) return
  const created = new Date(Number(event.timestamp) || Date.now())
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const photo = attachments.find((item) => item?.type === 'image' && item.payload?.url)
  // v3.6.108 — postingan/story yang dibagikan pelanggan: gambar pratinjaunya disimpan & tampil di room
  // (dulu hanya teks "[membagikan postingan]"), keterangan postingan ikut sebagai teks.
  const shared = photo ? undefined : attachments.find((item) => SHARED_PREVIEW.has(String(item?.type || '')) && item.payload?.url)
  // v3.6.109 — membalas story toko: dulu story-nya hilang (tidak ada mid) → AI tidak tahu konteksnya.
  const story = message.reply_to?.story?.url ? message.reply_to.story : undefined
  const storyPreview = !photo && !shared && story?.url ? { type: 'story', payload: { url: story.url } } : undefined
  const image = photo || shared || storyPreview
  const notes = attachments
    .map((item) => {
      const type = String(item?.type || '')
      const note = type in ATTACHMENT_NOTE ? ATTACHMENT_NOTE[type] : type ? `[lampiran ${type}]` : ''
      const title = String(item?.payload?.title || '').replace(/\s+/g, ' ').trim()
      const link = REEL.has(type) && item?.payload?.url ? `\n${item.payload.url}` : ''
      return note && title ? `${note} "${title.slice(0, 300)}"${link}` : `${note}${note ? link : ''}`
    })
    .filter(Boolean)
  const text = [
    story ? '[membalas story toko]' : '',
    String(message.text || '').trim(),
    ...notes,
    message.is_unsupported ? '[pesan Instagram yang tidak bisa dibuka di sini — minta pelanggan mengirim ulang dalam bentuk teks/foto]' : '',
  ]
    .filter(Boolean)
    .join('\n')
  if (echo) {
    // Kiriman aplikasi ini sendiri juga kembali sebagai echo: sudah tercatat (isi sama, baru saja).
    const own = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .where('created_at', '>=', new Date(Date.now() - 10 * 60_000))
      .where((query) => {
        query.where('body', text)
        if (image) query.orWhere('media_type', 'image')
      })
      .whereIn('status', ['queued', 'sending', 'sent'])
      .first()
    if (own) return
    // Pemilik membalas langsung dari aplikasi Instagram: dicatat, giliran AI dibatalkan.
    await db.table('whatsapp_messages').insert({
      message_id: mid,
      jid,
      contact_name: null,
      direction: 'out',
      sender_type: 'owner',
      body: text,
      media_type: image ? 'image' : null,
      media_url: image?.payload?.url || null,
      thumbnail_url: image?.payload?.url || null,
      media_status: image ? 'ready' : null,
      status: 'sent',
      created_at: created,
    })
    await db.from('whatsapp_ig_turns').where('jid', jid).delete()
    await resumeAiAfterHumanReply(jid).catch(() => {})
    return
  }
  if (!text && !image) return
  await ensureContact(jid, customer, config)
  await db.table('whatsapp_messages').insert({
    message_id: mid,
    jid,
    contact_name: null,
    direction: 'in',
    sender_type: 'customer',
    body: text,
    media_type: image ? 'image' : null,
    media_url: null,
    thumbnail_url: null,
    media_mime: image ? 'image/jpeg' : null,
    media_status: image ? 'downloading' : null,
    reply_to_message_id: message.reply_to?.mid || null,
    status: 'received',
    created_at: created,
  })
  if (photo?.payload?.url) await downloadImage(mid, photo.payload.url).catch(() => {})
  else if (shared?.payload?.url) await downloadSharedPreview(mid, shared.payload.url).catch(() => {})
  else if (storyPreview) await downloadSharedPreview(mid, storyPreview.payload.url).catch(() => {})
  await invalidateConversationGoal(jid).catch(() => {})
  await scheduleTurn(jid, mid)
}

/** Gambar CDN Instagram kedaluwarsa: disalin ke media aplikasi seperti WhatsApp. */
/** Unduh gambar Instagram ke public/media; kembalikan path lokal. */
export async function saveRemoteImage(name: string, url: string, requireImage = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Media terlalu besar')
  const type = String(response.headers.get('content-type') || '')
  if (requireImage && !/^image\//i.test(type)) throw new Error('Bukan gambar')
  const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
  const directory = app.makePath('public', 'media')
  await mkdir(directory, { recursive: true })
  const filename = workspaceFileName(`${name.replace(/[^a-z0-9_-]/gi, '').slice(-60)}.${extension}`)
  await writeFile(app.makePath('public', 'media', filename), bytes, { mode: 0o644 })
  return `${env.get('APP_BASE_PATH') || ''}/media/${filename}`
}

export async function downloadImage(messageId: string, url: string) {
  try {
    const local = await saveRemoteImage(`ig-${messageId}`, url)
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({ media_url: local, thumbnail_url: local, media_status: 'ready' })
  } catch {
    await db.from('whatsapp_messages').where('message_id', messageId).update({ media_status: 'failed' })
  }
}

/**
 * v3.6.108 — pratinjau postingan yang dibagikan. Bukan gambar (mis. tautan halaman) → tanpa media, tautannya
 * ditambahkan ke teks supaya CS tetap bisa membukanya.
 */
export async function downloadSharedPreview(messageId: string, url: string) {
  try {
    const local = await saveRemoteImage(`ig-${messageId}`, url, true)
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({ media_url: local, thumbnail_url: local, media_status: 'ready' })
  } catch {
    const row = await db.from('whatsapp_messages').where('message_id', messageId).first()
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({ media_type: null, media_mime: null, media_status: null, body: [String(row?.body || '').trim(), url].filter(Boolean).join('\n').slice(0, 4000) })
  }
}

async function ingestComment(value: any, config: IgConfig) {
  const commentId = String(value?.id || '')
  const fromId = String(value?.from?.id || '')
  const text = String(value?.text || '').trim()
  if (!commentId || !fromId || !text || fromId === config.userId) return
  // Balasan di bawah komentar (thread) dari toko sendiri tidak diproses.
  if (String(value?.from?.username || '') === config.username) return
  await db.rawQuery(
    `INSERT IGNORE INTO whatsapp_ig_comments (comment_id, media_id, from_id, username, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      commentId,
      String(value?.media?.id || '') || null,
      fromId,
      String(value?.from?.username || '').slice(0, 190) || null,
      text.slice(0, 2000),
      config.comments ? 'pending' : 'skipped',
      new Date(),
    ]
  )
}
