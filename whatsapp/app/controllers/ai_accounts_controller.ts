import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { rm } from 'node:fs/promises'
import { withAiAccount } from '#services/ai_account_context'
import {
  AI_ACCOUNT_PROVIDERS,
  aiAccountRef,
  createAiAccount,
  deleteAiAccount,
  listAiAccounts,
  moveAiAccount,
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

function view(account: AiAccount, isConnected: boolean, now = Date.now()) {
  return {
    id: account.id,
    provider: account.provider,
    name: account.label || `${NAMES[account.provider]}${account.legacy ? ' utama' : ` #${account.id}`}`,
    legacy: account.legacy,
    enabled: account.enabled,
    model: account.model,
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

/** Banyak akun AI: daftar, urutan cadangan, login per akun, API key Gemini. */
export default class AiAccountsController {
  async index({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const accounts = await listAiAccounts()
    const states = await Promise.all(accounts.map((a) => connected(a).catch(() => false)))
    return response.json({ accounts: accounts.map((a, i) => view(a, states[i])) })
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
    if (request.input('enabled') !== undefined) values.enabled = request.input('enabled') ? 1 : 0
    if (request.input('label') !== undefined) values.label = String(request.input('label')).trim().slice(0, 80)
    if (request.input('model') !== undefined) values.model = String(request.input('model')).trim().slice(0, 80)
    if (request.input('apiKey') !== undefined && account.provider === 'gemini') {
      const key = String(request.input('apiKey')).trim()
      if (key) values.api_key = key
    }
    // Diubah manual → jeda lama dihapus supaya langsung dicoba lagi.
    if (request.input('resume')) Object.assign(values, { limited_until: 0, limited_code: null, last_error: null })
    if (Object.keys(values).length) await updateAiAccount(account.id, values)
    return response.json({ ok: true })
  }

  async move({ params, request, response }: HttpContext) {
    const account = await found(params)
    await moveAiAccount(account.id, Number(request.input('direction')) < 0 ? -1 : 1)
    return response.json({ ok: true })
  }

  async destroy({ params, response }: HttpContext) {
    const account = await found(params)
    if (account.legacy)
      return response.unprocessableEntity({ error: 'Akun utama tidak bisa dihapus, cukup nonaktifkan.' })
    await deleteAiAccount(account.id)
    await rm(
      app.makePath('storage', 'ai-accounts', String(account.id)),
      { recursive: true, force: true }
    ).catch(() => {})
    return response.json({ ok: true })
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
