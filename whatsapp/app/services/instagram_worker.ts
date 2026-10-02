import env from '#start/env'
import db from '#services/workspace_database'
import { readSettings } from '#services/settings_service'
import { isAiWorking } from '#services/ai_work_schedule'
import { beginGoalTurn, isCurrentGoalRun, pauseGoalRun } from '#services/conversation_goal_service'
import { markGoalDelivery, recordAnalysisFailure } from '#services/analysis_retry_service'
import { aiFailureDetail } from '#services/ai_failure_service'
import { startTrace } from '#services/trace_service'
import { setHandlingMode, resumeAiAfterHumanReply } from '#services/message_service'
import { createLeanReply, finishLeanGoal, claimLeanNudge } from '#beta3/reply_service'
import { sendLeanTotal } from '#beta3/order_service'
import { writeBeta3ChatNote } from '#beta3/tables'
import { learnFromHumanReply } from '#beta3/examples_service'
import {
  ensureIgTables,
  igJid,
  igsidOf,
  noteIgError,
  readIgConfig,
  updateIgToken,
  type IgConfig,
} from '#services/instagram_store'
import * as ig from '#services/instagram_api'
import { saveRemoteImage } from '#services/instagram_inbox'
import { publishTick } from '#services/instagram_publish'
import { driveMediaTick, removePublishedSchedules, sweepMedia } from '#services/instagram_media_store'
import { workspaceScope } from '#services/workspace_context'
import { captureStories } from '#services/instagram_insights'

/**
 * Worker Instagram (dipanggil berkala oleh worker WhatsApp, terlepas dari koneksi nomor):
 * 1) kirim antrean pesan CS/sistem ke room Instagram, 2) giliran AI DM, 3) komentar → DM,
 * 4) perpanjang token. Semua di workspace aktif.
 */
const DAY = 86_400_000
const WINDOW_MS = 24 * 3_600_000
let running = false

export async function instagramTick() {
  if (running) return
  running = true
  try {
    await ensureIgTables()
    const config = await readIgConfig()
    if (!config.token || !config.userId) return
    await refreshIfNeeded(config)
    await flushOutbox(config)
    await runDueTurns(config)
    await runComments(config)
    await backfillPosts(config)
    await driveMediaTick(workspaceScope().prefix).catch(() => {})
    await publishTick(config).catch((error) => noteIgError(`Posting: ${error instanceof Error ? error.message : String(error)}`))
    await removePublishedSchedules().catch(() => {})
    await sweepMedia().catch(() => {})
    await captureStories(config).catch(() => {})
  } catch (error) {
    await noteIgError(error instanceof Error ? error.message : String(error)).catch(() => {})
  } finally {
    running = false
  }
}

async function refreshIfNeeded(config: IgConfig) {
  // Token 60 hari diperpanjang saat sisa < 20 hari (maks sekali sehari).
  if (!config.tokenExpires || config.tokenExpires - Date.now() > 20 * DAY) return
  const last = Number((await db.from('whatsapp_beta3_state').where('name', 'ig_token_refreshed').first())?.value || 0)
  if (Date.now() - last < DAY) return
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_state (name, value, updated_at) VALUES ('ig_token_refreshed', ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [String(Date.now()), new Date()]
  )
  const fresh = await ig.refreshToken(config.token)
  await updateIgToken(fresh.token, fresh.expiresIn)
  config.token = fresh.token
}

const absolute = (url: string) =>
  /^https?:\/\//.test(url) ? url : `${env.get('APP_URL').replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`

async function lastInboundAt(jid: string) {
  const row = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    .orderBy('created_at', 'desc')
    .first()
  return row ? new Date(row.created_at).getTime() : 0
}

/** Pesan antre (CS manual, total & rekening, konfirmasi bayar, dll.) untuk room Instagram. */
async function flushOutbox(config: IgConfig) {
  const queued = await db
    .from('whatsapp_messages')
    .where('direction', 'out')
    .where('status', 'queued')
    .where('jid', 'like', '%@ig')
    .orderBy('id', 'asc')
    .limit(10)
  for (const message of queued as any[]) {
    const jid = String(message.jid)
    const igsid = igsidOf(jid)
    try {
      await db.from('whatsapp_messages').where('id', message.id).update({ status: 'sending' })
      let mid = ''
      if (message.media_url && ['image', 'sticker'].includes(String(message.media_type)))
        mid = await ig.sendImage(config.token, igsid, absolute(String(message.media_url)))
      if (message.body) mid = (await ig.sendText(config.token, igsid, String(message.body))) || mid
      await db
        .from('whatsapp_messages')
        .where('id', message.id)
        .update({ status: 'sent', ...(mid ? { message_id: mid } : {}) })
      if (config.lastError) {
        config.lastError = ''
        await noteIgError('').catch(() => {})
      }
      if (message.sender_type === 'cs') {
        await resumeAiAfterHumanReply(jid).catch(() => {})
        if (mid) await learnFromHumanReply(jid, mid).catch(() => {})
      }
    } catch (error) {
      await db.from('whatsapp_messages').where('id', message.id).update({ status: 'failed' })
      const outside = Date.now() - (await lastInboundAt(jid)) > WINDOW_MS
      await noteIgError(
        outside
          ? 'Pesan Instagram tidak terkirim: lewat 24 jam sejak pesan terakhir pelanggan.'
          : `Pesan Instagram tidak terkirim: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

async function aiAllowed(jid: string) {
  const settings = await readSettings(true)
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  return {
    settings,
    ok:
      Boolean(settings.beta3Mode) &&
      isAiWorking(settings) &&
      Boolean(settings.hasSkill) &&
      contact?.handling_mode !== 'cs' &&
      !contact?.ai_excluded,
  }
}

async function runDueTurns(config: IgConfig) {
  const due = await db.from('whatsapp_ig_turns').where('due_at', '<=', new Date()).orderBy('due_at', 'asc').limit(3)
  for (const turn of due as any[]) {
    const jid = String(turn.jid)
    // Gambar masih diunduh: tunggu sebentar (maks 30 detik).
    const downloading = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('media_status', 'downloading')
      .where('created_at', '>=', new Date(Date.now() - 30_000))
      .first()
    if (downloading) {
      await db.from('whatsapp_ig_turns').where('jid', jid).update({ due_at: new Date(Date.now() + 3000) })
      continue
    }
    await db.from('whatsapp_ig_turns').where('jid', jid).where('anchor_message_id', turn.anchor_message_id).delete()
    await runTurn(config, jid, String(turn.anchor_message_id)).catch(() => {})
  }
}

/** Pesan pelanggan sejak balasan toko terakhir (digabung jadi satu giliran). */
async function pendingInbound(jid: string) {
  const lastOut = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'out')
    .whereNotIn('status', ['failed'])
    .orderBy('created_at', 'desc')
    .first()
  const rows = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    .where('created_at', '>', lastOut ? lastOut.created_at : new Date(0))
    .orderBy('created_at', 'asc')
    .limit(8)
  return rows as any[]
}

async function runTurn(
  config: IgConfig,
  jid: string,
  anchor: string,
  comment?: CommentTurn
): Promise<boolean> {
  const allowed = await aiAllowed(jid)
  if (!allowed.ok) return false
  const settings = allowed.settings
  const run = await beginGoalTurn(jid, anchor)
  if (!run) return false
  const items = comment
    ? ((await db.from('whatsapp_messages').where('message_id', anchor).limit(1)) as any[])
    : await pendingInbound(jid)
  if (!items.length) return false
  const text = items.map((row) => String(row.body || '')).filter(Boolean).join('\n')
  const images = items.filter((row) => row.media_type === 'image' && row.media_url && row.media_status === 'ready')
  const imagePaths = images
    .map((row) => {
      const name = String(row.media_url).split('/').pop() || ''
      return /^[a-zA-Z0-9_.-]+$/.test(name) ? `public/media/${name}` : ''
    })
    .filter(Boolean)
  const { default: app } = await import('@adonisjs/core/services/app')
  const trace = await startTrace(jid, {
    text,
    mode: comment ? 'beta3-instagram-comment' : 'beta3-instagram',
    provider: settings.aiProvider,
    messages: items.map((row) => ({ id: row.message_id })),
  }).catch(() => undefined)
  try {
    const reply = await createLeanReply({
      jid,
      messageIds: items.map((row) => String(row.message_id)),
      text,
      imagePaths: imagePaths.map((path) => app.makePath(path)).slice(0, 3),
      imageIds: images.map((row) => String(row.message_id)).slice(0, 3),
      settings: { ...(settings as any), aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt' },
      onTrace: trace?.emit,
    })
    const { decision } = reply
    const canSend = async () => (await isCurrentGoalRun(run)) && (await aiAllowed(jid)).ok
    if (!(await canSend())) {
      await pauseGoalRun(run, 'Konteks atau status AI berubah.')
      await trace?.finish('cancelled', { reason: 'Konteks berubah; balasan lama dibatalkan.' })
      return false
    }
    if (!(await markGoalDelivery(run))) return false
    const igsid = igsidOf(jid)
    let firstId = ''
    const record = async (body: string, image: string | null, send: () => Promise<string>) => {
      const temp = `ig-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await db.table('whatsapp_messages').insert({
        message_id: temp,
        jid,
        contact_name: null,
        direction: 'out',
        sender_type: 'ai',
        body,
        media_type: image ? 'image' : null,
        media_url: image,
        thumbnail_url: image,
        media_status: image ? 'ready' : null,
        status: 'sending',
        created_at: new Date(),
      })
      try {
        const mid = await send()
        await db.from('whatsapp_messages').where('message_id', temp).update({ status: 'sent', ...(mid ? { message_id: mid } : {}) })
        firstId ||= mid || temp
        return true
      } catch (error) {
        await db.from('whatsapp_messages').where('message_id', temp).update({ status: 'failed' })
        trace?.emit({
          key: `ig-send-${temp}`,
          label: 'Balasan Instagram gagal terkirim',
          status: 'failed',
          detail: { error: error instanceof Error ? error.message : String(error) },
        })
        return false
      }
    }
    const bubbles = decision.serah_cs ? [] : decision.pesan
    if (comment) {
      // Komentar: hanya SATU balasan pribadi per komentar → semua bubble digabung.
      const body = bubbles.join('\n')
      if (body) {
        const sent = await record(body, null, () => ig.privateReply(config.token, comment.id, body))
        if (sent) comment.sent = body
        if (sent && comment.publicReply) {
          const note = 'Sudah kami balas lewat DM ya bos'
          if (await ig.replyComment(config.token, comment.id, note).catch(() => '')) comment.publicSent = note
        }
      }
    } else {
      const sendPhotos = async () => {
        for (const photo of reply.photos) {
          await record('', photo.url, () => ig.sendImage(config.token, igsid, photo.url))
          if (photo.caption) await record(photo.caption, null, () => ig.sendText(config.token, igsid, photo.caption))
        }
      }
      if (!decision.serah_cs && !bubbles.length) await sendPhotos()
      for (const [index, body] of bubbles.entries()) {
        if (!(await canSend())) break
        if (!(await record(body, null, () => ig.sendText(config.token, igsid, body)))) break
        if (index === 0) await sendPhotos()
      }
      if (reply.autoTotal && !decision.serah_cs) {
        try {
          const sent = await sendLeanTotal(reply.autoTotal, 'ai')
          decision.tahap = 'tunggu_bayar'
          decision.catatan = `${decision.catatan.replace(/tahap\s*[:=]\s*\w+/i, 'tahap: tunggu_bayar')}\ntotal ${sent.orderNumber}: ${sent.total} dikirim otomatis`
        } catch {}
      }
    }
    if (decision.catatan) await writeBeta3ChatNote(jid, decision.catatan)
    const goal = await finishLeanGoal(run, decision)
    if (decision.serah_cs) {
      if (comment) comment.handoff = true
      await setHandlingMode(jid, 'cs', decision.alasan || 'Diserahkan ke CS oleh AI (Instagram).')
    }
    await trace?.finish(
      'completed',
      {
        decision: decision.serah_cs ? 'handoff' : decision.pesan.length ? 'reply' : 'silent',
        summary: decision.alasan,
        tahap: decision.tahap,
        channel: 'instagram',
        goal,
      },
      firstId || undefined
    )
    return Boolean(firstId) || decision.serah_cs
  } catch (error) {
    const failure = aiFailureDetail(error, {
      stage: 'processing',
      provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
    })
    await recordAnalysisFailure(run, failure).catch(() => {})
    await trace?.finish('failed', { error: failure.message, failure })
    return false
  }
}

/** Komentar yang bertanya (harga, stok, size, dll.) dijawab lewat DM; pujian/tag dibiarkan. */
export function isQuestionComment(text: string) {
  const value = String(text || '').toLowerCase()
  if (value.replace(/[@#][\w.]+/g, '').replace(/[^\p{L}\p{N}?]/gu, '').length < 2) return false
  return /\?|harga|berapa|brp|price|pm\b|dm\b|info|ready|stok|stock|size|ukuran|order|pesan|beli|bisa|warna|bahan|cara|alamat|lokasi|ongkir|kirim|custom|sewa|available|cod/.test(
    value
  )
}

type CommentTurn = { id: string; publicReply: boolean; sent?: string; publicSent?: string; handoff?: boolean }

/** Isi postingan yang dikomentari (caption, tautan, foto) — sekali per postingan. */
export async function ensurePostInfo(config: IgConfig, row: any) {
  if (Number(row.media_checked || 0) || !row.media_id) return row
  const mediaId = String(row.media_id)
  const known = await db
    .from('whatsapp_ig_comments')
    .where('media_id', mediaId)
    .where('media_checked', 1)
    .first()
  let info = known
    ? { caption: known.media_caption || '', permalink: known.permalink || '', image: known.media_image || '' }
    : null
  if (!info) {
    const fetched = await ig.mediaInfo(config.token, mediaId)
    const image = fetched.image ? await saveRemoteImage(`igp-${mediaId}`, fetched.image).catch(() => '') : ''
    info = { caption: fetched.caption, permalink: fetched.permalink, image }
  }
  const update = {
    media_caption: info.caption || null,
    permalink: info.permalink || null,
    media_image: info.image || null,
    media_checked: 1,
  }
  await db.from('whatsapp_ig_comments').where('comment_id', row.comment_id).update(update)
  return { ...row, ...update }
}

/** Room DM pengomentar + pesan masuk "[Komentar di postingan …]" (dengan foto postingan) sebagai konteks. */
export async function ensureCommentRoom(config: IgConfig, source: any) {
  const row = await ensurePostInfo(config, source)
  const jid = igJid(String(row.from_id))
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  if (!contact)
    await db.table('whatsapp_contacts').insert({
      jid,
      name: row.username ? `@${row.username}` : 'Instagram',
      handling_mode: 'ai',
      updated_at: new Date(),
    })
  const caption = String(row.media_caption || '').replace(/\s+/g, ' ').trim()
  const anchor = `igc-${row.comment_id}`
  if (!(await db.from('whatsapp_messages').where('message_id', anchor).first()))
    await db.table('whatsapp_messages').insert({
      message_id: anchor,
      jid,
      contact_name: row.username ? `@${row.username}` : null,
      direction: 'in',
      sender_type: 'customer',
      body: `[Komentar di postingan Instagram${caption ? `: "${caption.slice(0, 300)}"` : ''}${row.media_image ? '; foto postingan terlampir' : ''}] ${row.body}`,
      media_type: row.media_image ? 'image' : null,
      media_url: row.media_image || null,
      thumbnail_url: row.media_image || null,
      media_status: row.media_image ? 'ready' : null,
      status: 'received',
      created_at: new Date(row.created_at),
    })
  return { jid, anchor }
}

/** Komentar lama (sebelum foto postingan disimpan): lengkapi foto & caption, juga di room chat. */
async function backfillPosts(config: IgConfig) {
  const rows = await db
    .from('whatsapp_ig_comments')
    .where('media_checked', 0)
    .whereNotNull('media_id')
    .whereNot('status', 'pending')
    .orderBy('created_at', 'desc')
    .limit(3)
  for (const source of rows as any[]) {
    const row = await ensurePostInfo(config, source).catch(() => null)
    if (!row?.media_image) continue
    await db
      .from('whatsapp_messages')
      .where('message_id', `igc-${row.comment_id}`)
      .whereNull('media_url')
      .update({ media_type: 'image', media_url: row.media_image, thumbnail_url: row.media_image, media_status: 'ready' })
  }
}

async function runComments(config: IgConfig) {
  const pending = await db
    .from('whatsapp_ig_comments')
    .where('status', 'pending')
    .where('created_at', '>=', new Date(Date.now() - 6 * DAY))
    .orderBy('created_at', 'asc')
    .limit(2)
  for (const row of pending as any[]) {
    const done = (status: string, extra: Record<string, unknown> = {}) =>
      db
        .from('whatsapp_ig_comments')
        .where('comment_id', row.comment_id)
        .update({ status, processed_at: new Date(), force_ai: 0, ...extra })
    await ensurePostInfo(config, row).catch(() => {})
    const forced = Boolean(Number(row.force_ai || 0))
    if (!config.comments && !forced) {
      await done('skipped')
      continue
    }
    if (!forced && !isQuestionComment(String(row.body || ''))) {
      await done('ignored')
      continue
    }
    await done('processing')
    try {
      const { jid, anchor } = await ensureCommentRoom(config, row)
      const turn: CommentTurn = { id: String(row.comment_id), publicReply: true }
      const replied = await runTurn(config, jid, anchor, turn)
      await done(turn.sent ? 'replied' : turn.handoff ? 'cs' : replied ? 'replied' : 'skipped', {
        error: null,
        ...(turn.sent ? { reply: turn.sent } : {}),
        ...(turn.publicSent ? { public_reply: turn.publicSent } : {}),
      })
    } catch (error) {
      await done('failed', { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
    }
  }
}

/** Susulan Beta 3 untuk room Instagram (hanya dalam 24 jam sejak pesan terakhir pelanggan). */
export async function instagramNudge(jid: string) {
  const config = await readIgConfig()
  if (!config.token) return
  if (Date.now() - (await lastInboundAt(jid)) > WINDOW_MS - 10 * 60_000) return
  const nudge = await claimLeanNudge(jid)
  if (!nudge) return
  const mid = await ig.sendText(config.token, igsidOf(jid), nudge.text)
  await db.table('whatsapp_messages').insert({
    message_id: mid || `ig-out-${Date.now()}`,
    jid,
    contact_name: null,
    direction: 'out',
    sender_type: 'ai',
    body: nudge.text,
    status: 'sent',
    created_at: new Date(),
  })
}
