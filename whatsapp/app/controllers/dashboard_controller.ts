import { contactCleanupPreview } from '#services/contact_cleanup_service'
import type { HttpContext } from '@adonisjs/core/http'
import { startSharedMcpLogin, completeSharedMcpLogin } from '#services/shared_mcp_oauth_service'
import { archiveWorkspace, workspaceState, workspaceWorkerReady } from '#services/workspace_service'
import { requestChatCleanup, chatCleanupStatus } from '#services/chat_cleanup_service'
import { orderMessages } from '#services/order_message_evidence'
import db from '#services/workspace_database'
import { isAiWorking } from '#services/ai_work_schedule'
import env from '#start/env'
import { appVersion } from '#services/app_version'
import { readAccess, setDomain, unsetDomain } from '#services/access_service'
import { readUsage } from '#services/usage_service'
import { evaluationOverview } from '#services/conversation_evaluation_service'
import { readTrace } from '#services/trace_service'
import {
  createMcpConnection,
  deleteMcpConnection,
  deleteSkill,
  ensureDefaults,
  readSettings,
  saveSettings,
  isLeanMode,
  isBeta3Mode,
} from '#services/settings_service'
import {
  codexBinaryStatus,
  isChatgptConnected,
  oauthState,
  startOAuthLogin,
} from '#services/codex_oauth_service'
import {
  claudeBinaryStatus,
  claudeOAuthState,
  isClaudeConnected,
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
import { latestInboxMessages, markRoomRead } from '#services/contact_inbox_service'
import { readConnectionStatus } from '#services/connection_status_service'
import { setAiExcluded } from '#services/ai_exclusion_service'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { storeCsMedia, removeCsMedia, csMediaPath, type CsMedia } from '#services/cs_media_service'

const ROOM_PAGE_SIZE = 50

export default class DashboardController {
  async evaluations({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json(await evaluationOverview())
  }
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
            .select('message_id', 'body', 'media_type')
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
    const traces = await db
      .from('whatsapp_ai_traces')
      .select('id', 'message_id')
      .whereIn('message_id', messageIds)
    const tracesByMessage = new Map(traces.map((trace) => [trace.message_id, trace.id]))
    return messages.map((message) => ({
      ...message,
      trace_id: tracesByMessage.get(message.message_id) || null,
      reactions: reactionsByMessage.get(message.message_id) || [],
      reply: repliesById.get(message.reply_to_message_id) || null,
    }))
  }

  private async contacts() {
    const messages = await latestInboxMessages()
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
        contact_name: profile?.name || message.contact_name,
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
    const [connection, contacts] = await Promise.all([readConnectionStatus(), this.contacts()])
    const requestedJid = String(request.input('jid', '')).slice(0, 190)
    const selectedContact = contacts.find((contact) => contact.jid === requestedJid) || null
    const selectedJid = String(selectedContact?.jid || '')
    const roomMessages = selectedJid
      ? await db
          .from('whatsapp_messages')
          .where('jid', selectedJid)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(ROOM_PAGE_SIZE)
      : []
    const messages = await this.decorateMessages(roomMessages.reverse())
    const accountUrl = (env.get('ACCOUNT_URL') || '').replace(/\/$/, '')
    const leanMode = await isLeanMode().catch((error) => {
      console.error('leanMode tidak terbaca:', error instanceof Error ? error.message : error)
      return false
    })
    const beta3Mode = await isBeta3Mode().catch(() => false)
    return view.render('pages/dashboard', {
      page: 'chat',
      leanMode,
      beta3Mode,
      connection,
      contacts,
      selectedJid,
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
    return response.json({ version: appVersion(), node: process.versions.node })
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
    return response.json(await readConnectionStatus())
  }
  async usage({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    return response.json(await readUsage())
  }
  async quotas({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const { readAccountQuotas } = await import('#services/ai_quota_service')
    return response.json(await readAccountQuotas())
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
    const latest = request.input('latest') === '1'
    let messages: Record<string, any>[] = []
    let hasMore = false
    let syncCursor: number | undefined
    if (jid) {
      const query = db.from('whatsapp_messages').where('jid', jid)
      if (latest || before) {
        if (before) {
          // History is chronological; older messages can have higher IDs after backfill.
          const anchor = await db
            .from('whatsapp_messages')
            .where('jid', jid)
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
          const last = await db
            .from('whatsapp_messages')
            .where('jid', jid)
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
      await queueOutgoingMessage({ jid, body, replyToId, replyToMessageId, media })
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

  async contactsList({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    return response.json({ contacts: await this.contacts() })
  }
  async contactRead({ request, response }: HttpContext) {
    try {
      await markRoomRead(String(request.input('jid', '')), Number(request.input('throughId')))
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Room tidak valid.',
      })
    }
  }
  async contactMode({ request, response }: HttpContext) {
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
  async contactExclusion({ request, response }: HttpContext) {
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
        const provider =
          request.input('aiProvider', current.aiProvider) === 'claude' ? 'claude' : 'chatgpt'
        const connected =
          provider === 'claude' ? await isClaudeConnected() : await isChatgptConnected()
        if (!connected) {
          return response.unprocessableEntity({
            error: `Hubungkan ${provider === 'claude' ? 'Claude' : 'ChatGPT'} OAuth.`,
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
