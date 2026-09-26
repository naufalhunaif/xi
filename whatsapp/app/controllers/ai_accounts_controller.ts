import type { HttpContext } from '@adonisjs/core/http'
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import { latestInboxMessages } from '#services/contact_inbox_service'
import app from '@adonisjs/core/services/app'
import { rm } from 'node:fs/promises'
import { withAiAccount } from '#services/ai_account_context'
import {
  AI_ACCOUNT_PROVIDERS,
  aiAccountRef,
  busyAiAccounts,
  recentAiEvents,
  lastAccountByJid,
  aiTokenUsage,
  aiSpreadMode,
  setAiSpreadMode,
  SPREAD_WINDOW_MS,
  createAiAccount,
  deleteAiAccount,
  listAiAccounts,
  setAiAccountOrder,
  readAiAccount,
  updateAiAccount,
  type AiAccount,
  type AiProviderName,
} from '#services/ai_accounts'
import { isChatgptConnected, oauthState, startOAuthLogin } from '#services/codex_oauth_service'
import {
  claudeOAuthState,
  isClaudeConnected,
  startClaudeOAuthLogin,
  verifyClaudeOAuthLogin,
} from '#services/claude_oauth_service'

const NAMES: Record<AiProviderName, string> = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }

async function connected(account: AiAccount) {
  if (account.provider === 'gemini') return Boolean(account.apiKey)
  return withAiAccount(aiAccountRef(account), () =>
    account.provider === 'claude' ? isClaudeConnected() : isChatgptConnected()
  )
}

/** AI boleh aktif selama ada minimal satu akun AI yang aktif dan tersambung, apa pun jenisnya. */
export async function anyAiAccountReady() {
  const accounts = (await listAiAccounts()).filter((account) => account.enabled)
  for (const account of accounts) if (await connected(account).catch(() => false)) return true
  return false
}

function view(account: AiAccount, isConnected: boolean, now = Date.now()) {
  return {
    id: account.id,
    provider: account.provider,
    name: account.label || `${NAMES[account.provider]}${account.legacy ? ' utama' : ` #${account.id}`}`,
    legacy: account.legacy,
    enabled: account.enabled,
    model: account.model,
    scope: account.scope,
    hasKey: Boolean(account.apiKey),
    connected: isConnected,
    limitedUntil: account.limitedUntil > now ? account.limitedUntil : 0,
    limitedCode: account.limitedUntil > now ? account.limitedCode : '',
    lastError: account.lastError,
    lastUsedAt: account.lastUsedAt,
  }
}

async function found(params: Record<string, any>) {
  const account = await readAiAccount(Number(params.id))
  if (!account) throw new Error('Akun AI tidak ditemukan.')
  return account
}

/**
 * Pelanggan terbaru (maks 80) + akun yang terakhir melayani, untuk peta ala graph view.
 * Disimpan 15 detik: daftar kotak masuk cukup berat untuk ditanya tiap 2 detik.
 */
const customerCache = new Map<string, { at: number; data: any[] }>()
async function orchestraCustomers(now: number) {
  const key = workspaceScope().prefix
  const cached = customerCache.get(key)
  if (cached && now - cached.at < 15_000) return cached.data
  const inbox = workspaceScope().id
    ? ((await latestInboxMessages().catch(() => [])) as any[]).filter((row) => !String(row.jid).endsWith('@g.us')).slice(0, 80)
    : []
  const handled = await lastAccountByJid(
    inbox.map((row) => String(row.jid)),
    now - 7 * 86_400_000
  ).catch(() => new Map<string, number>())
  const profiles = inbox.length
    ? await db.from('whatsapp_contacts').whereIn('jid', inbox.map((row) => String(row.jid))).select('jid', 'handling_mode', 'name')
    : []
  const modeOf = new Map(profiles.map((p: any) => [String(p.jid), p]))
  const customers = inbox.map((row) => {
    const profile: any = modeOf.get(String(row.jid))
    const phone = String(row.phone_jid || '').split('@')[0]
    return {
      jid: String(row.jid),
      name: String(profile?.name || row.contact_name || (phone ? `+${phone}` : 'Tanpa nama')).slice(0, 40),
      mode: profile?.handling_mode === 'cs' ? 'cs' : 'ai',
      order: Boolean(Number(row.has_order)),
      payment: Boolean(Number(row.needs_payment)),
      unread: Number(row.unread_count || 0),
      unanswered: Number(row.unanswered_count || 0),
      at: new Date(row.created_at).getTime(),
      accountId: handled.get(String(row.jid)) || 0,
    }
  })
  customerCache.set(key, { at: now, data: customers })
  return customers
}

/** Banyak akun AI: daftar, urutan cadangan, login per akun, API key Gemini. */
export default class AiAccountsController {
  async index({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const accounts = await listAiAccounts()
    const [states, used, spread] = await Promise.all([
      Promise.all(accounts.map((a) => connected(a).catch(() => false))),
      aiTokenUsage(Date.now() - SPREAD_WINDOW_MS),
      aiSpreadMode(),
    ])
    return response.json({
      spread,
      accounts: accounts.map((a, i) => ({ ...view(a, states[i]), tokens5h: used.get(a.id) || 0 })),
    })
  }

  /** Data ringan untuk visual orkestra: tanpa cek login (tidak memanggil CLI). */
  async orchestra({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const after = Math.max(0, Number(request.input('after', 0)) || 0)
    const now = Date.now()
    const [accounts, events, busy, used, spread] = await Promise.all([
      listAiAccounts(),
      recentAiEvents(after),
      busyAiAccounts(),
      aiTokenUsage(now - SPREAD_WINDOW_MS),
      aiSpreadMode(),
    ])
    const customers = await orchestraCustomers(now)
    return response.json({
      now,
      busy,
      events,
      spread,
      customers,
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        name: a.label || `${NAMES[a.provider]}${a.legacy ? ' utama' : ` #${a.id}`}`,
        enabled: a.enabled,
        limitedUntil: a.limitedUntil > now ? a.limitedUntil : 0,
        lastUsedAt: a.lastUsedAt ? a.lastUsedAt.getTime() : 0,
        tokens5h: used.get(a.id) || 0,
      })),
    })
  }

  async spread({ request, response }: HttpContext) {
    await setAiSpreadMode(request.input('mode') === 'even' ? 'even' : 'order')
    return response.json({ ok: true, mode: await aiSpreadMode() })
  }

  async store({ request, response }: HttpContext) {
    const provider = String(request.input('provider') || '') as AiProviderName
    if (!AI_ACCOUNT_PROVIDERS.includes(provider))
      return response.unprocessableEntity({ error: 'Pilih ChatGPT, Claude, atau Gemini.' })
    const apiKey = String(request.input('apiKey') || '').trim()
    if (provider === 'gemini' && !apiKey)
      return response.unprocessableEntity({ error: 'Isi API key Gemini.' })
    const id = await createAiAccount({
      provider,
      label: String(request.input('label') || '').trim(),
      apiKey: provider === 'gemini' ? apiKey : '',
      model: String(request.input('model') || '').trim(),
    })
    return response.json({ ok: true, id })
  }

  async update({ params, request, response }: HttpContext) {
    const account = await found(params)
    const values: Record<string, unknown> = {}
    if (request.input('scope') !== undefined)
      values.scope = request.input('scope') === 'background' ? 'background' : 'all'
    if (request.input('enabled') !== undefined) {
      values.enabled = request.input('enabled') ? 1 : 0
      values.user_set = 1
    }
    if (request.input('label') !== undefined) values.label = String(request.input('label')).trim().slice(0, 80)
    if (request.input('model') !== undefined)
      values.model = String(request.input('model')).trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 80)
    if (request.input('apiKey') !== undefined && account.provider === 'gemini') {
      const key = String(request.input('apiKey')).trim()
      if (key) values.api_key = key
    }
    // Diubah manual → jeda lama dihapus supaya langsung dicoba lagi.
    if (request.input('resume')) Object.assign(values, { limited_until: 0, limited_code: null, last_error: null })
    if (Object.keys(values).length) await updateAiAccount(account.id, values)
    return response.json({ ok: true })
  }

  async order({ request, response }: HttpContext) {
    const ids = (Array.isArray(request.input('ids')) ? request.input('ids') : [])
      .map(Number)
      .filter((id: number) => Number.isSafeInteger(id) && id > 0)
    await setAiAccountOrder(ids)
    return response.json({ ok: true })
  }

  async destroy({ params, response }: HttpContext) {
    const account = await found(params)
    await deleteAiAccount(account.id)
    // Akun utama memakai folder login workspace bersama; hanya akun tambahan yang punya folder sendiri.
    if (!account.legacy) await rm(
      app.makePath('storage', 'ai-accounts', String(account.id)),
      { recursive: true, force: true }
    ).catch(() => {})
    return response.json({ ok: true })
  }

  async test({ params, response }: HttpContext) {
    const account = await found(params)
    const { readSettings } = await import('#services/settings_service')
    const { testAiAccount } = await import('#beta3/provider')
    const result = await testAiAccount((await readSettings()) as any, account)
    if (result.ok)
      await updateAiAccount(account.id, { limited_until: 0, limited_code: null, last_error: null })
    else await updateAiAccount(account.id, { last_error: String(result.error || '').slice(0, 290) })
    return response.json(result)
  }

  async loginStatus({ params, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const account = await found(params)
    if (account.provider === 'gemini') return response.json({ connected: Boolean(account.apiKey) })
    const state = await withAiAccount(aiAccountRef(account), () =>
      account.provider === 'claude' ? claudeOAuthState() : oauthState()
    )
    if (state.connected && account.limitedCode === 'AI_AUTH_REQUIRED')
      await updateAiAccount(account.id, { limited_until: 0, limited_code: null, last_error: null })
    return response.json(state)
  }

  async loginStart({ params, request, response }: HttpContext) {
    const account = await found(params)
    if (account.provider === 'gemini')
      return response.unprocessableEntity({ error: 'Gemini memakai API key, bukan login.' })
    const restart = Boolean(request.input('restart'))
    try {
      const state = await withAiAccount(aiAccountRef(account), () =>
        account.provider === 'claude' ? startClaudeOAuthLogin(restart) : startOAuthLogin(restart)
      )
      return response.json(state)
    } catch (error) {
      return response.unprocessableEntity({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  async loginVerify({ params, request, response }: HttpContext) {
    const account = await found(params)
    if (account.provider !== 'claude') return response.unprocessableEntity({ error: 'Hanya untuk Claude.' })
    try {
      const result = await withAiAccount(aiAccountRef(account), () =>
        verifyClaudeOAuthLogin(request.input('loginId'), request.input('code'))
      )
      return response.json(result)
    } catch (error) {
      return response.unprocessableEntity({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
