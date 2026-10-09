import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import db from '#services/workspace_database'
import { workspaceFileName } from '#services/workspace_context'
import { invalidateConversationGoal } from '#services/conversation_goal_service'
import { resumeAiAfterHumanReply } from '#services/message_service'
import { readSettings } from '#services/settings_service'
import { ensureIgTables, igJid, readIgConfig, type IgConfig } from '#services/instagram_store'
import { conversationMessages, mediaInfo, messageDetail, profile } from '#services/instagram_api'

/**
 * Webhook Instagram → tabel pesan yang sama dengan WhatsApp. Balasan AI dikerjakan worker
 * (instagram_worker) setelah jeda penggabungan pesan, seperti giliran WhatsApp.
 */
type Messaging = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  /** v3.6.119 — reaksi (❤️ dll.) ke sebuah pesan; action "unreact" = dicabut. */
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string }
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
  if (!event.reaction && (!message || (!message.attachments?.length && !message.reply_to?.story && !message.is_unsupported))) return
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

const REACTION_EMOJI: Record<string, string> = {
  love: '❤️', like: '👍', haha: '😂', wow: '😮', sad: '😢', angry: '😡', smile: '😊', yay: '🎉',
}

/** v3.6.119 — reaksi Instagram (pelanggan atau pemilik dari aplikasi IG) tampil di pesan yang dituju. */
export async function ingestIgReaction(event: Messaging, config: IgConfig) {
  const reaction = event.reaction
  const target = String(reaction?.mid || '')
  if (!reaction || !target) return
  await recordIgSample(event).catch(() => {})
  const senderId = String(event.sender?.id || '')
  const fromMe = Boolean(senderId) && senderId === config.userId
  const customer = String((fromMe ? event.recipient?.id : event.sender?.id) || '')
  if (!customer) return
  const jid = igJid(customer)
  const sender = fromMe ? 'me' : jid
  if (String(reaction.action || 'react') === 'unreact') {
    await db.from('whatsapp_reactions').where('target_message_id', target).where('sender', sender).delete()
    return
  }
  const emoji = String(reaction.emoji || REACTION_EMOJI[String(reaction.reaction || '')] || '❤️').slice(0, 16)
  await db.rawQuery(
    `INSERT INTO whatsapp_reactions (target_message_id, jid, sender, emoji, from_me, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'received', ?)
     ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), status = IF(status = 'queued', status, 'received'), created_at = VALUES(created_at)`,
    [target, jid, sender, emoji, fromMe ? 1 : 0, new Date()]
  )
}

async function ingestMessaging(event: Messaging, config: IgConfig) {
  if (event.reaction) return ingestIgReaction(event, config)
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
  // v3.6.114 — video, pesan suara, file, dan reel juga disimpan sebagai media (dulu hanya teks "[video]").
  const other = image ? undefined : attachments.find((item) => FILE_KIND[String(item?.type || '')] && item?.payload?.url)
  const otherKind = other ? FILE_KIND[String(other.type)] : null
  await db.table('whatsapp_messages').insert({
    message_id: mid,
    jid,
    contact_name: null,
    direction: 'in',
    sender_type: 'customer',
    body: text,
    media_type: image ? 'image' : otherKind,
    media_url: null,
    thumbnail_url: null,
    media_mime: image ? 'image/jpeg' : null,
    media_status: image || otherKind ? 'downloading' : null,
    reply_to_message_id: message.reply_to?.mid || null,
    status: 'received',
    created_at: created,
  })
  // Postingan toko sendiri yang dibagikan (ig_post_media_id tanpa url) → gambar & keterangan dari API.
  const sharedMedia = !photo && !shared ? attachments.find((item) => item?.payload?.ig_post_media_id) : undefined
  if (photo?.payload?.url) await downloadImage(mid, photo.payload.url).catch(() => {})
  else if (shared?.payload?.url) await downloadSharedPreview(mid, shared.payload.url).catch(() => {})
  else if (sharedMedia && config.token) {
    const info = await mediaInfo(config.token, String(sharedMedia.payload!.ig_post_media_id))
    if (info.image) await downloadSharedPreview(mid, info.image).catch(() => {})
  }
  else if (storyPreview) await downloadSharedPreview(mid, storyPreview.payload.url).catch(() => {})
  else if (other?.payload?.url && otherKind) await downloadAttachment(mid, other.payload.url, otherKind).catch(() => {})
  await invalidateConversationGoal(jid).catch(() => {})
  await scheduleTurn(jid, mid)
}

/** Gambar CDN Instagram kedaluwarsa: disalin ke media aplikasi seperti WhatsApp. */
/** Unduh gambar Instagram ke public/media; kembalikan path lokal. */
const FILE_KIND: Record<string, string> = { video: 'video', audio: 'audio', file: 'document', ig_reel: 'video', reel: 'video' }
const EXTENSION: Array<[RegExp, string]> = [
  [/png/i, 'png'], [/webp/i, 'webp'], [/jpe?g/i, 'jpg'], [/gif/i, 'gif'],
  [/video\/mp4/i, 'mp4'], [/quicktime/i, 'mov'], [/webm/i, 'webm'],
  [/audio\/(?:mp4|x-m4a|aac)/i, 'm4a'], [/mpeg/i, 'mp3'], [/ogg/i, 'ogg'], [/wav/i, 'wav'],
  [/pdf/i, 'pdf'],
]
/** v3.6.114 — unduh media apa pun (gambar/video/suara/dokumen) ke public/media; jenis dari content-type. */
export async function saveRemoteMedia(name: string, url: string, accept: RegExp) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim()
  if (!accept.test(type)) throw new Error(`Jenis ${type || '?'} tidak diterima`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Media terlalu besar')
  const extension = EXTENSION.find(([pattern]) => pattern.test(type))?.[1] || 'bin'
  await mkdir(app.makePath('public', 'media'), { recursive: true })
  const filename = workspaceFileName(`${name.replace(/[^a-z0-9_-]/gi, '').slice(-60)}.${extension}`)
  await writeFile(app.makePath('public', 'media', filename), bytes, { mode: 0o644 })
  const kind = /^image\//i.test(type) ? 'image' : /^video\//i.test(type) ? 'video' : /^audio\//i.test(type) ? 'audio' : 'document'
  return { url: `${env.get('APP_BASE_PATH') || ''}/media/${filename}`, mime: type, kind, filename }
}

/** v3.6.114 — video / pesan suara / file dari DM; gagal → tautannya ditambahkan ke teks. */
export async function downloadAttachment(messageId: string, url: string, kind: string) {
  try {
    const saved = await saveRemoteMedia(`ig-${messageId}`, url, /^(image|video|audio|application)\//i)
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({
        media_type: saved.kind === 'image' ? 'image' : kind,
        media_mime: saved.mime,
        media_url: saved.url,
        thumbnail_url: saved.kind === 'image' ? saved.url : null,
        media_name: kind === 'document' ? saved.filename : null,
        media_status: 'ready',
      })
  } catch {
    const row = await db.from('whatsapp_messages').where('message_id', messageId).first()
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({ media_type: null, media_mime: null, media_status: null, body: [String(row?.body || '').trim(), url].filter(Boolean).join('\n').slice(0, 4000) })
  }
}

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
    // v3.6.114: story/postingan video ikut tampil (dulu hanya gambar); jenis media selalu diisi.
    const saved = await saveRemoteMedia(`ig-${messageId}`, url, /^(image|video)\//i)
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({ media_type: saved.kind, media_mime: saved.mime, media_url: saved.url, thumbnail_url: saved.kind === 'image' ? saved.url : null, media_status: 'ready' })
  } catch {
    const row = await db.from('whatsapp_messages').where('message_id', messageId).first()
    await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .update({ media_type: null, media_mime: null, media_status: null, body: [String(row?.body || '').trim(), url].filter(Boolean).join('\n').slice(0, 4000) })
  }
}

/** URL gambar/video/tautan pertama dari detail pesan DM (format API bisa berbeda-beda). */
export function sharedUrlFromDetail(data: any): { url: string; mediaId: string } {
  const found: string[] = []
  let mediaId = ''
  const walk = (value: any, depth = 0) => {
    if (!value || depth > 6) return
    if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1))
    if (typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^https?:\/\//.test(item) && /url|link|src|preview/i.test(key)) found.push(item)
      else if (typeof item === 'string' && /ig_post_media_id|media_id/.test(key)) mediaId = mediaId || item
      else walk(item, depth + 1)
    }
  }
  walk({ attachments: data?.attachments, shares: data?.shares, story: data?.story })
  const image = found.find((url) => /\.(jpe?g|png|webp)(\?|$)/i.test(url) || /scontent|cdninstagram|fbcdn/i.test(url))
  return { url: image || found[0] || '', mediaId }
}

/**
 * v3.6.113 — pesan lama "[membagikan postingan]" / story tanpa gambar (sebelum v3.6.108): ambil ulang isinya dari
 * API Instagram lalu simpan pratinjaunya. Maks `limit` pesan per jalan, 60 hari terakhir.
 */
export async function repairSharedPosts(limit = 40) {
  const config = await readIgConfig()
  if (!config.token) return { checked: 0, fixed: 0, sample: null as unknown, error: 'Instagram belum tersambung' }
  const rows = (await db
    .from('whatsapp_messages')
    .where('jid', 'like', '%@ig')
    .whereNull('media_type')
    .where('created_at', '>', new Date(Date.now() - 60 * 86_400_000))
    .where((query) =>
      query
        .where('body', 'like', '%[membagikan postingan]%')
        .orWhere('body', 'like', '%[membagikan reel]%')
        .orWhere('body', 'like', '%[menyebut toko di story]%')
        .orWhere('body', 'like', '%[membalas story toko]%')
        .orWhere('body', 'like', '%[video]%')
        .orWhere('body', 'like', '%[pesan suara]%')
        .orWhere('body', 'like', '%[file]%')
    )
    .whereNot('body', 'like', '%http%')
    .orderBy('id', 'desc')
    .limit(limit)) as Array<{ message_id: string; jid: string; body: string | null }>
  let fixed = 0
  let sample: unknown = null
  const report: Array<{ id: string; found: string; tries?: unknown; conversation?: string }> = []
  // v3.6.115: cadangan dari daftar pesan percakapan (sekali per pelanggan).
  const threads = new Map<string, any[] | string>()
  const fromThread = async (jid: string, messageId: string) => {
    if (!threads.has(jid))
      threads.set(
        jid,
        await conversationMessages(config.token, jid.replace(/@ig$/, '')).catch((error) =>
          (error instanceof Error ? error.message : String(error)).slice(0, 200)
        )
      )
    const list = threads.get(jid)
    if (typeof list === 'string') return { detail: null, note: list }
    const hit = list!.find((item) => String(item?.id || '') === messageId)
    return { detail: hit || null, note: hit ? 'ada' : `tidak ada di ${list!.length} pesan terbaru` }
  }
  for (const row of rows) {
    const detail: any = await messageDetail(config.token, row.message_id).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    if (!sample) sample = JSON.stringify(detail).slice(0, 1500)
    let { url, mediaId } = sharedUrlFromDetail(detail)
    let conversation = ''
    if (!url && !mediaId && row.jid) {
      const thread = await fromThread(row.jid, row.message_id)
      conversation = thread.note
      if (thread.detail) ({ url, mediaId } = sharedUrlFromDetail(thread.detail))
    }
    report.push({ id: row.message_id.slice(-12), found: url ? 'url' : mediaId ? 'media' : '-', tries: detail?._tries, conversation })
    let target = url
    if (!target && mediaId) target = (await mediaInfo(config.token, mediaId)).image
    if (!target) continue
    const kind = /\[video\]|\[membagikan reel\]/.test(String(row.body)) ? 'video' : /\[pesan suara\]/.test(String(row.body)) ? 'audio' : /\[file\]/.test(String(row.body)) ? 'document' : ''
    await db.from('whatsapp_messages').where('message_id', row.message_id).update({ media_type: kind || 'image', media_status: 'downloading' })
    if (kind) await downloadAttachment(row.message_id, target, kind).catch(() => {})
    else await downloadSharedPreview(row.message_id, target).catch(() => {})
    fixed++
  }
  return { checked: rows.length, fixed, sample, report }
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
