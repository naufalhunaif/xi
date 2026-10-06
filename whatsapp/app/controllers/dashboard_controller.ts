import { contactCleanupPreview } from '#services/contact_cleanup_service'
import { statusPostsByIds } from '#services/status_posts'
import type { HttpContext } from '@adonisjs/core/http'
import { listLines } from '#services/line_service'
import { workspaceScope } from '#services/workspace_context'
import { startSharedMcpLogin, completeSharedMcpLogin } from '#services/shared_mcp_oauth_service'
import { archiveWorkspace, workspaceState, workspaceWorkerReady } from '#services/workspace_service'
import { requestChatCleanup, chatCleanupStatus } from '#services/chat_cleanup_service'
import { orderMessages } from '#services/order_message_evidence'
import db from '#services/workspace_database'
import { isAiWorking } from '#services/ai_work_schedule'
import env from '#start/env'
import { appVersion, appChannel, appVersionLabel } from '#services/app_version'
import { readAccess, setDomain, unsetDomain } from '#services/access_service'
import { pendingOrderCount } from '#services/pending_orders'
import { readRuns, readUsage } from '#services/usage_service'
import { readTrace } from '#services/trace_service'
import {
  createMcpConnection,
  deleteMcpConnection,
  deleteSkill,
  ensureDefaults,
  readSettings,
  saveSettings,
} from '#services/settings_service'
import {
  codexBinaryStatus,
  oauthState,
  startOAuthLogin,
} from '#services/codex_oauth_service'
import {
  claudeBinaryStatus,
  claudeOAuthState,
  startClaudeOAuthLogin,
  verifyClaudeOAuthLogin,
} from '#services/claude_oauth_service'
import {
  cancelMcpOAuthLogin,
  mcpOAuthState,
  verifyMcpOAuthCallback,
  completePublicMcpOAuth,
} from '#services/mcp_oauth_service'
import { createHash } from 'node:crypto'
import { queueOutgoingMessage, setHandlingMode } from '#services/message_service'
import { presentedAnalysisStatus } from '#services/analysis_retry_service'
import { latestInboxMessages, markRoomRead, roomLine, setRoomsReadState, type InboxQuery } from '#services/contact_inbox_service'
import { changedRooms, currentCursor, decodeCursor, encodeCursor, subscribeInbox, touchRoom } from '#services/inbox_changes'
import { readConnectionStatus } from '#services/connection_status_service'
import { setAiExcluded } from '#services/ai_exclusion_service'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { storeCsMedia, removeCsMedia, csMediaPath, type CsMedia } from '#services/cs_media_service'

const ROOM_PAGE_SIZE = 50

/** Room = pelanggan + nomor penerima; line 1 = nomor utama (line_id kosong atau 1). */
function whereLine<T extends { where: any; whereNull: any }>(query: T, line: number): T {
  if (line > 1) query.where('line_id', line)
  else query.where((inner: any) => inner.whereNull('line_id').orWhere('line_id', '<=', 1))
  return query
}

/** Kutipan balasan: teks + gambar kecil pesan yang dibalas, dan id untuk melompat ke pesannya (v3.6.25). */
function replyPreview(reply: Record<string, any> | undefined) {
  if (!reply) return null
  const type = String(reply.media_type || '')
  const thumb =
    ['image', 'sticker'].includes(type)
      ? reply.media_url || reply.thumbnail_url || null
      : ['video', 'gif'].includes(type)
        ? reply.thumbnail_url || null
        : null
  const labels: Record<string, string> = {
    image: 'Foto',
    sticker: 'Stiker',
    video: 'Video',
    gif: 'GIF',
    audio: 'Pesan suara',
    document: reply.media_name || 'Dokumen',
    location: 'Lokasi',
    contact: 'Kontak',
  }
  return {
    message_id: String(reply.message_id),
    body: String(reply.body || ''),
    media_type: type || null,
    thumb,
    label: labels[type] || (type ? 'Media' : ''),
  }
}

function displayPhone(jid: string | null | undefined) {
  const digits = /^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid || ''))?.[1]
  if (!digits) return null
  if (!digits.startsWith('62')) return `+${digits}`
  const rest = digits.slice(2)
  return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`.replace(/-$/, '')
}

/** v3.6.43: daftar kotak masuk yang baru disusun, dipakai bersama sebentar (per workspace). */
const CONTACTS_CACHE_MS = 2000
/** v3.6.44: room pada muatan pertama kotak masuk. */
const INBOX_FIRST_PAGE = 60
const contactsCache = new Map<string, { at: number; body: string; etag: string }>()
export function clearContactsCache() {
  contactsCache.clear()
}

export default class DashboardController {
  private async decorateMessages(messages: Record<string, any>[]) {
    if (!messages.length) return messages
    const messageIds = messages.map((message) => String(message.message_id))
    const replyIds = messages
      .map((message) => String(message.reply_to_message_id || ''))
      .filter(Boolean)
    const [reactions, replies] = await Promise.all([
      db.from('whatsapp_reactions').whereIn('target_message_id', messageIds).orderBy('id', 'asc'),
      replyIds.length
        ? db
            .from('whatsapp_messages')
            .select('message_id', 'body', 'media_type', 'media_url', 'thumbnail_url', 'media_name')
            .whereIn('message_id', replyIds)
        : [],
    ])
    const reactionsByMessage = new Map<string, Record<string, any>[]>()
    for (const reaction of reactions) {
      const current = reactionsByMessage.get(reaction.target_message_id) || []
      current.push(reaction)
      reactionsByMessage.set(reaction.target_message_id, current)
    }
    const repliesById = new Map(replies.map((reply) => [reply.message_id, reply]))
    // Balasan ke status WhatsApp toko: tampilkan caption statusnya sebagai kutipan.
    const missingReplies = replyIds.filter((id) => !repliesById.has(id))
    if (missingReplies.length) {
      const statuses = await statusPostsByIds(missingReplies).catch(() => new Map())
      for (const [id, post] of statuses)
        repliesById.set(id, {
          message_id: id,
          body: `Status · ${post.caption || (post.media_type === 'video' ? 'video' : 'foto')}`,
          media_type: post.media_type,
          media_url: post.media_url,
          thumbnail_url: post.thumbnail_url,
        })
    }
    const traces = await db
      .from('whatsapp_ai_traces')
      .select('id', 'message_id')
      .whereIn('message_id', messageIds)
    const tracesByMessage = new Map(traces.map((trace) => [trace.message_id, trace.id]))
    return messages.map((message) => ({
      ...message,
      trace_id: tracesByMessage.get(message.message_id) || null,
      reactions: reactionsByMessage.get(message.message_id) || [],
      reply: replyPreview(repliesById.get(message.reply_to_message_id)),
    }))
  }

  private async contacts(query: InboxQuery = {}) {
    const messages = await latestInboxMessages(query)
    if (!messages.length) return []
    const profiles = await db.from('whatsapp_contacts').whereIn(
      'jid',
      messages.map((message) => message.jid)
    )
    const profilesByJid = new Map(profiles.map((profile) => [profile.jid, profile]))
    const goals = await db
      .from('whatsapp_chat_goals')
      .select('jid', 'status', 'waiting_for', 'next_action', 'recovery_json', 'next_run_at')
      .whereIn(
        'jid',
        messages.map((message) => message.jid)
      )
    const goalsByJid = new Map(goals.map((goal) => [goal.jid, goal]))
    // Multi nomor: tanda SIM 1/2/… (urutan: utama, lalu nomor tambahan) hanya bila ada nomor tambahan.
    const lines = (await listLines().catch(() => [])).filter((line) => line.desired_connected)
    const linePhones = new Map(lines.map((line) => [Number(line.id), String(line.phone || '')]))
    const lineIndex = new Map(lines.map((line, index) => [Number(line.id), index + 2]))
    const lineLabel = (lineId: unknown) => {
      if (!lines.length) return null
      const phone = Number(lineId) > 1 ? linePhones.get(Number(lineId)) : workspaceScope().phone
      return phone ? `+${phone}` : null
    }
    const lineSim = (lineId: unknown) => (!lines.length ? 0 : Number(lineId) > 1 ? lineIndex.get(Number(lineId)) || 0 : 1)
    const [recentTraces, connection, settings] = await Promise.all([
      db
        .from('whatsapp_ai_traces')
        .select('jid', 'status')
        .whereIn(
          'jid',
          messages.map((message) => message.jid)
        )
        .where('updated_at', '>=', new Date(Date.now() - 240_000))
        .orderBy('created_at', 'desc')
        .orderBy('updated_at', 'desc'),
      readConnectionStatus(),
      db.from('whatsapp_settings').where('id', 1).first(),
    ])
    const latestTraceStatus = new Map<string, string>()
    for (const trace of recentTraces) {
      if (!latestTraceStatus.has(trace.jid)) latestTraceStatus.set(trace.jid, trace.status)
    }
    const working = isAiWorking(settings)
    const schedulePaused = Boolean(
      settings?.ai_enabled && settings?.ai_work_mode === 'scheduled' && !working
    )
    return messages.map((message) => {
      const profile = profilesByJid.get(message.jid)
      const activityIsFresh =
        profile?.activity_updated_at &&
        Date.now() - new Date(profile.activity_updated_at).getTime() < 20_000
      const activityLabels: Record<string, string> = {
        understanding: 'Understanding…',
        thinking: 'Thinking…',
        compacting: 'Compacting context…',
        typing: 'Typing…',
      }
      return {
        ...message,
        // Tanpa nama: tampilkan nomor HP (bila sudah terpetakan), bukan ID internal.
        contact_name: profile?.name || message.contact_name || displayPhone(message.phone_jid),
        // Nomor penerima room: dari kontak (claimRoom), bila kosong dari pesan terakhir.
        line_label: lineLabel(message.line),
        line_sim: String(message.jid).endsWith('@ig') ? 0 : lineSim(message.line),
        line_id: message.line,
        profile_picture_url: profile?.profile_picture_url || null,
        activity:
          activityIsFresh && !schedulePaused
            ? activityLabels[profile.activity] || profile.activity
            : null,
        ai_running: Boolean(
          working &&
          connection.worker_online &&
          connection.status === 'connected' &&
          profile?.handling_mode !== 'cs' &&
          !profile?.ai_excluded &&
          latestTraceStatus.get(message.jid) === 'running'
        ),
        handling_mode:
          profile?.handling_mode === 'cs' || profile?.ai_excluded || schedulePaused ? 'cs' : 'ai',
        schedule_paused: schedulePaused,
        ai_excluded: Boolean(profile?.ai_excluded),
        role: String(profile?.role || ''),
        handoff_reason:
          schedulePaused && profile?.handling_mode !== 'cs' && !profile?.ai_excluded
            ? 'Di luar jam kerja AI. Chat ditangani manusia sampai jadwal AI dimulai.'
            : String(profile?.handoff_reason || ''),
        handling_note:
          profile?.handling_mode === 'cs' && profile?.handoff_reason && !profile?.ai_excluded
            ? String(profile.chat_note || '')
            : '',
        goal_status:
          profile?.handling_mode === 'cs' || schedulePaused
            ? 'waiting_cs'
            : presentedAnalysisStatus(goalsByJid.get(message.jid)),
        goal_retry_at: goalsByJid.get(message.jid)?.next_run_at || null,
        goal_waiting_for: String(goalsByJid.get(message.jid)?.waiting_for || ''),
        goal_next_action: String(goalsByJid.get(message.jid)?.next_action || ''),
      }
    })
  }

  async index({ view, session, request }: HttpContext) {
    await ensureDefaults()
    // v3.6.44: halaman pertama kotak masuk saja (60 room terbaru); sisanya dimuat browser di belakang.
    const [connection, contacts, inboxLines] = await Promise.all([
      readConnectionStatus(),
      this.contacts({ limit: INBOX_FIRST_PAGE }),
      this.inboxLines(),
    ])
    const requestedJid = String(request.input('jid', '')).slice(0, 190)
    const requestedLine = roomLine(request.input('line', 1))
    // Room yang dibuka lewat tautan tetapi di luar halaman pertama: ambil room itu saja.
    if (requestedJid && !contacts.some((contact) => contact.jid === requestedJid))
      contacts.push(...(await this.contacts({ jids: [requestedJid] }).catch(() => [])))
    const selectedContact =
      contacts.find((contact) => contact.jid === requestedJid && contact.line_id === requestedLine) ||
      (requestedLine === 1 ? contacts.find((contact) => contact.jid === requestedJid) : null) ||
      null
    const selectedJid = String(selectedContact?.jid || '')
    const selectedLine = selectedContact?.line_id || 1
    const roomMessages = selectedJid
      ? await whereLine(db.from('whatsapp_messages').where('jid', selectedJid), selectedLine)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(ROOM_PAGE_SIZE)
      : []
    const messages = await this.decorateMessages(roomMessages.reverse())
    const accountUrl = (env.get('ACCOUNT_URL') || '').replace(/\/$/, '')
    return view.render('pages/dashboard', {
      page: 'chat',
      connection,
      contacts,
      inboxLines,
      selectedJid,
      selectedLine,
      selectedContact,
      messages,
      account: session.get('account'),
      bundle: accountUrl.replace(/\/account$/, ''),
    })
  }

  async access({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json(readAccess())
  }

  async setAccessDomain({ request, response }: HttpContext) {
    try {
      const domain = setDomain(String(request.input('domain', '')))
      return response.json({ ok: true, requested: domain, ...readAccess() })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async unsetAccessDomain({ response }: HttpContext) {
    try {
      unsetDomain()
      return response.json({ ok: true, ...readAccess() })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async version({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({
      version: appVersion(),
      channel: appChannel(),
      label: appVersionLabel(),
      node: process.versions.node,
    })
  }

  async settingsPage({ view, session }: HttpContext) {
    const settings = await readSettings()
    const [oauth, claudeOauth, mcp] = await Promise.all([
      oauthState(),
      claudeOAuthState(),
      mcpOAuthState(settings.aiProvider === 'claude' ? 'claude' : 'chatgpt'),
    ])
    const mcpState = new Map(mcp.connections.map((connection) => [connection.slug, connection]))
    const accountUrl = (env.get('ACCOUNT_URL') || '').replace(/\/$/, '')
    return view.render('pages/dashboard', {
      page: 'settings',
      settings: {
        ...settings,
        mcpConnections: settings.mcpConnections.map((connection) => ({
          ...connection,
          ...mcpState.get(connection.slug),
        })),
      },
      oauth,
      claudeOauth,
      account: session.get('account'),
      bundle: accountUrl.replace(/\/account$/, ''),
    })
  }
  async status({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const [state, pendingOrders, lines] = await Promise.all([
      readConnectionStatus(),
      pendingOrderCount(),
      listLines().catch(() => []),
    ])
    const linesConnected = lines.filter((line) => line.status === 'connected').length
    return response.json({ ...state, pendingOrders, linesConnected })
  }
  async usage({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    return response.json(await readUsage({ days: Number(request.qs().days || 30), date: String(request.qs().date || '') }))
  }
  async usageRuns({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const qs = request.qs()
    return response.json(
      await readRuns({
        days: Number(qs.days || 30),
        date: String(qs.date || ''),
        before: Number(qs.before || 0),
        model: String(qs.model || '').slice(0, 120),
        phase: String(qs.phase || '').slice(0, 40),
        provider: ['chatgpt', 'claude', 'gemini'].includes(String(qs.provider)) ? String(qs.provider) : '',
      })
    )
  }
  async quotas({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const { readAccountQuotas } = await import('#services/ai_quota_service')
    const { readAiAccountQuotas } = await import('#services/ai_account_quota')
    const accounts = await readAiAccountQuotas().catch(() => [])
    // Tampilan lama (per penyedia) hanya bila belum ada akun AI terdaftar.
    const legacy = accounts.length
      ? { providers: [] }
      : await readAccountQuotas().catch(() => ({ providers: [] }))
    return response.json({ ...legacy, accounts })
  }
  async trace({ request, response }: HttpContext) {
    const jid = String(request.input('jid', '')).trim().slice(0, 190)
    const id = String(request.input('id', '')).trim()
    response.header('Cache-Control', 'no-store')
    if (!jid || (id && !/^[a-f0-9-]{36}$/i.test(id)))
      return response.badRequest({ error: 'Proses tidak valid.' })
    const trace = await readTrace(jid, id || undefined)
    if (id && !trace) return response.notFound({ error: 'Detail proses tidak ditemukan.' })
    return response.json({ trace })
  }
  async messages({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const after = Math.max(0, Number(request.input('after', 0)) || 0)
    const before = Math.max(0, Number(request.input('before', 0)) || 0)
    const jid = String(request.input('jid', '')).slice(0, 190)
    const line = roomLine(request.input('line', 1))
    const latest = request.input('latest') === '1'
    let messages: Record<string, any>[] = []
    let hasMore = false
    let syncCursor: number | undefined
    if (jid) {
      const query = whereLine(db.from('whatsapp_messages').where('jid', jid), line)
      if (latest || before) {
        if (before) {
          // History is chronological; older messages can have higher IDs after backfill.
          const anchor = await whereLine(db.from('whatsapp_messages').where('jid', jid), line)
            .where('id', before)
            .first()
          if (!anchor) return response.json({ messages: [], hasMore: false })
          query.where((older) => {
            older.where('created_at', '<', anchor.created_at).orWhere((sameTime) => {
              sameTime.where('created_at', anchor.created_at).where('id', '<', anchor.id)
            })
          })
        } else {
          // Capture the ingestion watermark before reading the latest page, so arrivals
          // during the query are still included by the subsequent ID-based delta poll.
          const last = await whereLine(db.from('whatsapp_messages').where('jid', jid), line)
            .max('id as cursor')
            .first()
          syncCursor = Number(last?.cursor || 0)
        }
        messages = await query
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(ROOM_PAGE_SIZE + 1)
        hasMore = messages.length > ROOM_PAGE_SIZE
        if (hasMore) messages.pop()
        messages.reverse()
      } else {
        messages = await query
          .where('id', '>', after)
          .orderBy('id', 'asc')
          .limit(ROOM_PAGE_SIZE + 1)
        hasMore = messages.length > ROOM_PAGE_SIZE
        if (hasMore) messages.pop()
      }
    }
    return response.json({ messages: await this.decorateMessages(messages), hasMore, syncCursor })
  }

  async sendMessage({ request, response }: HttpContext) {
    const jid = String(request.input('jid', '') ?? '')
      .trim()
      .slice(0, 190)
    const body = String(request.input('body', '') ?? '').trim()
    const line = roomLine(request.input('line', 1))
    const replyToId = Math.max(0, Number(request.input('replyToId', 0)) || 0)
    const replyToMessageId = String(request.input('replyToMessageId', '') ?? '')
      .trim()
      .slice(0, 190)
    let media: CsMedia | undefined
    try {
      const files = request.files('media', { size: '16mb' })
      if (files.length > 1) throw new Error('Kirim satu file per pesan.')
      const file = files[0]
      if (file) {
        if (!file.isValid || !file.tmpPath) throw new Error('File tidak valid atau melebihi 16 MB.')
        media = await storeCsMedia(await readFile(file.tmpPath), file.clientName)
      }
      await queueOutgoingMessage({ jid, line, body, replyToId, replyToMessageId, media })
      return response.json({ ok: true })
    } catch (error) {
      if (media) {
        // Retain a file if the queue insert succeeded but a later mode update failed.
        const referenced = await db
          .from('whatsapp_messages')
          .where('media_upload_id', media.id)
          .first()
          .catch(() => true)
        if (!referenced) await removeCsMedia(media.id).catch(() => {})
      }
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Pesan tidak valid.',
      })
    }
  }

  /** Minta worker mengunduh ulang media yang belum termuat (HP perlu online). */
  async mediaRetry({ request, response }: HttpContext) {
    const messageId = String(request.input('message_id') || '').slice(0, 190)
    if (!messageId) return response.badRequest({ error: 'Pesan tidak valid.' })
    // Data unduhan tersimpan → unduh langsung; belum ada → minta riwayat chat ke HP dulu.
    const known = await db.from('whatsapp_media_protos').where('message_id', messageId).first()
    const changed = await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .whereNull('media_url')
      .whereIn('media_type', ['image', 'video', 'sticker'])
      .update({ media_status: known ? 'retry' : 'history' })
    if (!Number(changed)) return response.unprocessableEntity({ error: 'Media ini tidak bisa dimuat ulang.' })
    return response.json({ ok: true })
  }

  async media({ params, request, response }: HttpContext) {
    if (!/^[a-f0-9-]{36}$/i.test(params.id)) return response.notFound()
    const message = await orderMessages().where('media_upload_id', params.id).first()
    if (!message) return response.notFound()
    response.header('X-Content-Type-Options', 'nosniff')
    response.header('Cache-Control', 'private, no-store')
    response.header('Content-Type', message.media_mime || 'application/octet-stream')
    const name = String(message.media_name || 'Lampiran')
    const disposition = message.media_type === 'document' ? 'attachment' : 'inline'
    response.header(
      'Content-Disposition',
      `${disposition}; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", '%27')}`
    )
    const path = csMediaPath(params.id)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return response.notFound()
    response.header('Accept-Ranges', 'bytes')
    let start = 0
    let end = info.size - 1
    const range = request.header('range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2]))
        return response.status(416).header('Content-Range', `bytes */${info.size}`).send('')
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]))
      else {
        start = Number(match[1])
        end = match[2] ? Math.min(end, Number(match[2])) : end
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      )
        return response.status(416).header('Content-Range', `bytes */${info.size}`).send('')
      response.status(206).header('Content-Range', `bytes ${start}-${end}/${info.size}`)
    }
    response.header('Content-Length', end - start + 1)
    return response.stream(createReadStream(path, { start, end }))
  }

  async reactMessage({ request, response }: HttpContext) {
    const messageRowId = Math.max(0, Number(request.input('messageRowId', 0)) || 0)
    const messageId = String(request.input('messageId', '')).trim().slice(0, 190)
    const emoji = String(request.input('emoji', '')).trim()
    const allowed = ['👍', '❤️', '😂', '😮', '😢', '🙏']
    const target = messageRowId
      ? await db.from('whatsapp_messages').where('id', messageRowId).first()
      : await db.from('whatsapp_messages').where('message_id', messageId).first()
    if (!target || !allowed.includes(emoji)) {
      return response.unprocessableEntity({ error: 'Reaction tidak valid.' })
    }
    await db.rawQuery(
      `INSERT INTO whatsapp_reactions
       (target_message_id, jid, sender, emoji, from_me, status, created_at)
       VALUES (?, ?, 'me', ?, 1, 'queued', ?)
       ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), status = 'queued', created_at = VALUES(created_at)`,
      [target.message_id, target.jid, emoji, new Date()]
    )
    return response.json({ ok: true })
  }

  /** Cari isi chat di semua room: satu hasil terbaru per room + potongan teks. */
  async searchMessages({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const q = String(request.input('q', '')).trim().slice(0, 80)
    if (q.length < 2) return response.json({ hits: [] })
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`
    const rows = await db
      .from('whatsapp_messages')
      .select('id', 'jid', 'body', 'created_at')
      .whereRaw('body LIKE ?', [like])
      .whereNot('jid', 'like', '%@g.us')
      .orderBy('id', 'desc')
      .limit(300)
    const seen = new Map<string, { jid: string; id: number; snippet: string; count: number }>()
    for (const row of rows) {
      const hit = seen.get(row.jid)
      if (hit) {
        hit.count++
        continue
      }
      const body = String(row.body || '')
      const at = body.toLowerCase().indexOf(q.toLowerCase())
      const start = Math.max(0, at - 30)
      const snippet = `${start ? '…' : ''}${body.slice(start, start + 90).replace(/\s+/g, ' ')}`
      seen.set(row.jid, { jid: row.jid, id: Number(row.id), snippet, count: 1 })
    }
    return response.json({ hits: [...seen.values()] })
  }
  /** Daftar nomor untuk filter kotak masuk (hanya bila ada nomor tambahan): utama = id 1. */
  private async inboxLines() {
    const lines = (await listLines().catch(() => [])).filter((line) => line.desired_connected)
    if (!lines.length) return []
    const full = (phone: unknown) => (phone ? `+${phone}` : '')
    return [
      { id: 1, sim: 1, label: full(workspaceScope().phone) || 'Main' },
      ...lines.map((line, index) => ({ id: line.id, sim: index + 2, label: full(line.phone) || `#${line.id}` })),
    ]
  }
  async contactsList({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    // v3.6.44 — pembaruan per kejadian: hanya room yang berubah sejak cursor.
    const since = decodeCursor(request.input('since'))
    if (since) {
      const change = await changedRooms(since)
      if (change.full) return response.json({ full: true, cursor: encodeCursor(change.cursor) })
      const rows = change.jids.length ? await this.contacts({ jids: change.jids }) : []
      return response.json({ contacts: rows, jids: change.jids, cursor: encodeCursor(change.cursor) })
    }
    // Muat bertahap: halaman room terbaru (cursor diambil SEBELUM menyusun, supaya perubahan
    // selama memuat ikut terbaca di pembaruan berikutnya).
    const limit = Math.max(0, Math.min(500, Number(request.input('limit')) || 0))
    if (limit) {
      const offset = Math.max(0, Number(request.input('offset')) || 0)
      const cursor = await currentCursor()
      const [rows, lines] = await Promise.all([
        this.contacts({ limit, offset }),
        offset ? Promise.resolve(undefined) : this.inboxLines(),
      ])
      return response.json({ contacts: rows, lines, cursor: encodeCursor(cursor), more: rows.length >= limit })
    }
    // v3.6.43 (server terasa lambat): kotak masuk menanyakan daftar ini tiap 3 dtk per tab, dan
    // menyusunnya ±1 dtk (565 chat, ±400 KB). Hasil dipakai bersama 2 dtk untuk semua tab, dan
    // bila isinya sama dengan yang sudah dimiliki browser cukup dijawab 304 (tanpa kirim & render ulang).
    const key = `${workspaceScope().prefix}|${workspaceScope().id}`
    const cached = contactsCache.get(key)
    let entry = cached && Date.now() - cached.at < CONTACTS_CACHE_MS ? cached : null
    if (!entry) {
      const [contacts, lines] = await Promise.all([this.contacts(), this.inboxLines()])
      const body = JSON.stringify({ contacts, lines })
      entry = { at: Date.now(), body, etag: `"${createHash('sha1').update(body).digest('base64url')}"` }
      contactsCache.set(key, entry)
    }
    response.header('ETag', entry.etag)
    if (request.header('if-none-match') === entry.etag) return response.status(304).send('')
    response.header('Content-Type', 'application/json; charset=utf-8')
    return response.send(entry.body)
  }
  /**
   * v3.6.44 — dorong kejadian kotak masuk (Server-Sent Events). Browser menerima "changed" lalu
   * mengambil room yang berubah saja. nginx: X-Accel-Buffering no; detak tiap 20 dtk.
   */
  async inboxEvents({ request, response }: HttpContext) {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough()
    response.header('Content-Type', 'text/event-stream; charset=utf-8')
    response.header('Cache-Control', 'no-store, no-transform')
    response.header('Connection', 'keep-alive')
    response.header('X-Accel-Buffering', 'no')
    let pending: NodeJS.Timeout | null = null
    const send = (text: string) => {
      if (!stream.destroyed) stream.write(text)
    }
    send('retry: 3000\n\n')
    send('event: ready\ndata: {}\n\n')
    const unsubscribe = subscribeInbox(() => {
      // Beberapa perubahan beruntun digabung (±300 ms).
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        send(`event: changed\ndata: ${Date.now()}\n\n`)
      }, 300)
    })
    const heartbeat = setInterval(() => send(': ping\n\n'), 20_000)
    // Sambungan diperbarui tiap 10 menit (EventSource menyambung lagi sendiri).
    const lifetime = setTimeout(() => stream.end(), 10 * 60_000)
    const close = () => {
      clearInterval(heartbeat)
      clearTimeout(lifetime)
      if (pending) clearTimeout(pending)
      unsubscribe()
      if (!stream.destroyed) stream.end()
    }
    request.request.on('close', close)
    stream.on('close', close)
    response.stream(stream)
  }

  async contactRead({ request, response }: HttpContext) {
    contactsCache.clear()
    touchRoom(String(request.input('jid', '')))
    try {
      await markRoomRead(
        String(request.input('jid', '')),
        Number(request.input('throughId')),
        roomLine(request.input('line', 1))
      )
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Room tidak valid.',
      })
    }
  }
  /** Pilihan di kotak masuk: tandai dibaca / belum dibaca. */
  async contactsReadState({ request, response }: HttpContext) {
    contactsCache.clear()
    const jids = Array.isArray(request.input('jids')) ? request.input('jids').map(String) : []
    const rooms = Array.isArray(request.input('rooms'))
      ? request
          .input('rooms')
          .filter((room: unknown) => room && typeof room === 'object')
          .map((room: { jid?: unknown; line?: unknown }) => ({ jid: String(room.jid || ''), line: roomLine(room.line) }))
      : []
    const state = request.input('state') === 'unread' ? 'unread' : 'read'
    for (const jid of [...jids, ...rooms.map((room: { jid: string }) => room.jid)]) touchRoom(jid)
    try {
      const changed = await setRoomsReadState([...jids, ...rooms], state)
      return response.json({ ok: true, changed })
    } catch (error) {
      return response.unprocessableEntity({ error: error instanceof Error ? error.message : 'Room tidak valid.' })
    }
  }
  async contactMode({ request, response }: HttpContext) {
    contactsCache.clear()
    touchRoom(String(request.input('jid', '')).trim())
    const jid = String(request.input('jid', '')).trim().slice(0, 190)
    const mode = request.input('mode') === 'cs' ? 'cs' : request.input('mode') === 'ai' ? 'ai' : ''
    try {
      if (!mode) throw new Error('Mode tidak valid.')
      await setHandlingMode(jid, mode)
      return response.json({ ok: true, mode })
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Mode tidak valid.',
      })
    }
  }
  async aiExclusions({ response }: HttpContext) {
    await ensureDefaults()
    response.header('cache-control', 'no-store')
    const contacts = await this.contacts()
    return response.json({
      contacts: contacts.map((contact) => ({
        jid: contact.jid,
        name: contact.contact_name || contact.jid.split('@')[0],
        excluded: contact.ai_excluded,
      })),
    })
  }
  /** Peran kontak diatur CS: pelanggan / vendor / lainnya (v3.6.31). */
  async contactRole({ request, response }: HttpContext) {
    contactsCache.clear()
    touchRoom(String(request.input('jid', '') ?? '').trim())
    try {
      const { setContactRole } = await import('#beta3/contact_role')
      const role = String(request.input('role', '') ?? '').trim()
      await setContactRole(String(request.input('jid', '') ?? '').trim(), role as any, true)
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({ error: error instanceof Error ? error.message : 'Kontak tidak valid.' })
    }
  }
  async contactExclusion({ request, response }: HttpContext) {
    contactsCache.clear()
    touchRoom(String(request.input('jid', '') ?? '').trim())
    try {
      await setAiExcluded(String(request.input('jid', '') ?? '').trim(), request.input('excluded'))
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Pengaturan kontak gagal disimpan.',
      })
    }
  }
  async connect({ response }: HttpContext) {
    await ensureDefaults()
    if (!(await workspaceWorkerReady()))
      return response.status(503).json({ error: 'Belum bisa terhubung.' })
    const workspace = await workspaceState()
    if (!workspace.active_id && workspace.session_id)
      return response.conflict({ error: 'Tunggu sampai koneksi sebelumnya selesai diputuskan.' })
    const connection = await readConnectionStatus()
    if (!connection.worker_online) {
      return response.status(503).json({ error: 'Belum bisa terhubung.', status: 'worker_offline' })
    }
    await db.from('whatsapp_connection').where('id', 1).update({
      desired_connected: true,
      status: 'connecting',
      last_error: null,
      updated_at: new Date(),
    })
    return response.json({ ok: true })
  }
  async disconnect({ response }: HttpContext) {
    if (!(await workspaceWorkerReady()))
      return response.status(503).json({ error: 'Koneksi belum siap. Coba lagi sebentar.' })
    await archiveWorkspace()
    response.header('X-WhatsApp-Workspace', (await workspaceState()).version)
    return response.json({ ok: true })
  }
  async contactCleanupPreview({ request, response }: HttpContext) {
    try {
      return response.json(await contactCleanupPreview(request.input('jid')))
    } catch (error) {
      return response.badRequest({
        error: error instanceof Error ? error.message : 'Permintaan gagal.',
      })
    }
  }
  async chatCleanupStatus({ response }: HttpContext) {
    return response.json(await chatCleanupStatus())
  }
  async chatCleanup({ request, response }: HttpContext) {
    const state = await workspaceState()
    if (
      !state.cleanup_worker_id ||
      state.cleanup_worker_id !== state.worker_id ||
      !(await workspaceWorkerReady()) ||
      !(await readConnectionStatus()).worker_online
    )
      return response
        .status(409)
        .json({ error: 'Penghapusan belum dapat dimulai. Coba lagi sebentar.' })
    try {
      const requestId = await requestChatCleanup(
        request.input('confirmation'),
        request.input('mode', 'chat'),
        request.input('jid')
      )
      return response.status(202).json({ status: 'pending', requestId })
    } catch (error) {
      return response.badRequest({
        error: error instanceof Error ? error.message : 'Permintaan gagal.',
      })
    }
  }
  async settings({ request, response }: HttpContext) {
    try {
      const current = await readSettings(false)
      const enabled = request.input('aiEnabled', current.aiEnabled)
      if (
        enabled === true &&
        (request.input('aiEnabled') === true || request.input('aiProvider') !== undefined)
      ) {
        const { anyAiAccountReady } = await import('#controllers/ai_accounts_controller')
        if (!(await anyAiAccountReady())) {
          return response.unprocessableEntity({
            error: 'Tambahkan minimal satu akun AI di Pengaturan → AI.',
          })
        }
      }
      return response.json(await saveSettings(request.all()))
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Pengaturan tidak valid.',
      })
    }
  }

  async skillDelete({ params, response }: HttpContext) {
    try {
      return response.json(await deleteSkill(Number(params.id)))
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Skill tidak valid.',
      })
    }
  }

  async skillDownload({ params, response }: HttpContext) {
    response.header('cache-control', 'private, no-store')
    response.header('x-content-type-options', 'nosniff')
    if (!/^[1-9]\d*$/.test(String(params.id)) || !Number.isSafeInteger(Number(params.id)))
      return response.notFound({ error: 'Skill not found.' })
    const skill = await db
      .from('whatsapp_skills')
      .where('id', Number(params.id))
      .select('name', 'content')
      .first()
    if (!skill) return response.notFound({ error: 'Skill not found.' })
    const name =
      String(skill.name)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 64) || 'skill'
    response.header('content-type', 'text/markdown; charset=utf-8')
    response.header('content-disposition', `attachment; filename="${name}.md"`)
    return response.send(String(skill.content ?? ''))
  }

  async oauthStatus({ response }: HttpContext) {
    return response.json(await oauthState())
  }

  async oauthStart({ request, response }: HttpContext) {
    return response.json(await startOAuthLogin(request.input('restart') === true))
  }

  async codexStatus({ request, response }: HttpContext) {
    const override = String(request.input('codexBin') || '').trim()
    return response.json(await codexBinaryStatus(override))
  }

  async claudeOauthStatus({ response }: HttpContext) {
    return response.json(await claudeOAuthState())
  }

  async claudeOauthStart({ request, response }: HttpContext) {
    return response.json(await startClaudeOAuthLogin(request.input('restart') === true))
  }

  async claudeOauthVerify({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    try {
      return response.json(
        await verifyClaudeOAuthLogin(request.input('loginId'), request.input('code'))
      )
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Verifikasi gagal.',
      })
    }
  }

  async claudeStatus({ request, response }: HttpContext) {
    const override = String(request.input('claudeBin') || '').trim()
    return response.json(await claudeBinaryStatus(override))
  }

  async mcpOauthStatus({ request, response }: HttpContext) {
    const provider = request.input('provider') === 'claude' ? 'claude' : 'chatgpt'
    return response.json(await mcpOAuthState(provider))
  }

  async mcpOauthStart({ request, response, session }: HttpContext) {
    try {
      const slug = String(request.input('slug', '')).trim()
      const provider = request.input('provider') === 'claude' ? 'claude' : 'chatgpt'
      const binding = createHash('sha256')
        .update(String(session.get('account')?.sessionToken || ''))
        .digest('hex')
      cancelMcpOAuthLogin(slug)
      await startSharedMcpLogin(slug, binding, request.input('restart') === true)
      return response.json(await mcpOAuthState(provider))
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Koneksi MCP gagal.',
      })
    }
  }

  async mcpOauthCallback({ request, response, session, params }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    response.header('Referrer-Policy', 'no-referrer')
    if (request.method() !== 'GET') return response.header('Allow', 'GET').status(405).send('')
    let result = 'failed'
    try {
      const binding = createHash('sha256')
        .update(String(session.get('account')?.sessionToken || ''))
        .digest('hex')
      const query = request.url(true).split('?').slice(1).join('?')
      result = await completePublicMcpOAuth(
        String(params.loginId),
        binding,
        params.callbackId,
        query
      )
    } catch {
      // Never reflect/log the callback query, authorization code, or provider HTML.
    }
    return response
      .redirect()
      .withQs(false)
      .status(303)
      .toPath(`${env.get('APP_URL').replace(/\/$/, '')}/settings?mcp_oauth=${result}#business`)
  }

  async sharedMcpCallback({ request, response, session, params }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    response.header('Referrer-Policy', 'no-referrer')
    let result = 'failed'
    try {
      const binding = createHash('sha256')
        .update(String(session.get('account')?.sessionToken || ''))
        .digest('hex')
      const query = new URLSearchParams(request.url(true).split('?').slice(1).join('?'))
      result = await completeSharedMcpLogin(String(params.slug), binding, query)
    } catch {
      /* Never reflect codes or provider responses. */
    }
    return response
      .redirect()
      .withQs(false)
      .status(303)
      .toPath(`${env.get('APP_URL').replace(/\/$/, '')}/settings?mcp_oauth=${result}#business`)
  }

  async mcpOauthVerify({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    try {
      const provider = request.input('provider')
      if (provider !== 'chatgpt' && provider !== 'claude') {
        return response.unprocessableEntity({
          error: 'Sesi login MCP tidak valid. Mulai ulang login.',
        })
      }
      return response.json(
        await verifyMcpOAuthCallback(
          String(request.input('slug', '')).trim(),
          provider,
          request.input('loginId'),
          request.input('callbackUrl')
        )
      )
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Verifikasi gagal.',
      })
    }
  }

  async mcpCreate({ request, response }: HttpContext) {
    try {
      await createMcpConnection(request.all())
      const settings = await readSettings()
      return response.json(
        await mcpOAuthState(settings.aiProvider === 'claude' ? 'claude' : 'chatgpt')
      )
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Koneksi MCP tidak valid.',
      })
    }
  }

  async mcpDelete({ params, response }: HttpContext) {
    const slug = String(params.slug || '').trim()
    try {
      cancelMcpOAuthLogin(slug)
      await deleteMcpConnection(slug)
      const settings = await readSettings()
      return response.json(
        await mcpOAuthState(settings.aiProvider === 'claude' ? 'claude' : 'chatgpt')
      )
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Koneksi MCP tidak valid.',
      })
    }
  }
}
