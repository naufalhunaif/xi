import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import db from '#services/workspace_database'
import { createHash, randomBytes } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import {
  countUsers,
  createUser,
  isLocalAuth,
  localSession,
  verifyUser,
} from '#services/local_auth_service'
import { appVersion } from '#services/app_version'
import { publicAppUrl } from '#services/public_url'

const clientId = 'whatsapp'
const appUrl = (request?: HttpContext['request']) => publicAppUrl(request)
const accountUrl = () => String(env.get('ACCOUNT_URL') || '').replace(/\/$/, '')
const random = () => randomBytes(32).toString('base64url')

async function jsonRequest(url: string, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' })
    const data = (await response.json()) as any
    if (!response.ok) throw new Error(data?.error_description || 'Account tidak dapat dihubungi.')
    return data
  } finally {
    clearTimeout(timer)
  }
}

function authPage(
  view: HttpContext['view'],
  request: HttpContext['request'],
  mode: 'login' | 'setup',
  extra: Record<string, unknown> = {}
) {
  return view.render('pages/auth', {
    mode,
    appUrl: appUrl(request),
    appVersion: appVersion(),
    error: '',
    email: '',
    name: '',
    ...extra,
  })
}

export default class AccountController {
  async login({ request, session, response, view }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    // This endpoint starts a fresh login, including when an old signed cookie remains.
    session.forget('account')
    if (isLocalAuth()) {
      await initializeDatabase()
      if ((await countUsers()) === 0)
        return response
          .redirect()
          .withQs(false)
          .toPath(`${appUrl(request)}/setup`)
      return authPage(view, request, 'login')
    }
    const state = random()
    const verifier = random()
    session.put('account_oauth', { state, verifier, expires: Date.now() + 600_000 })
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: `${appUrl()}/auth/callback`,
      scope: 'account:login',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })
    return response
      .redirect()
      .withQs(false)
      .toPath(`${accountUrl()}/oauth/account/authorize?${params}`)
  }

  /** Login lokal (standalone). */
  async loginPost({ request, session, response, view }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    if (!isLocalAuth())
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    const email = String(request.input('email', '')).trim()
    const password = String(request.input('password', ''))
    try {
      await initializeDatabase()
      const user = await verifyUser(email, password, request.ip())
      session.regenerate()
      session.put('account', localSession(user))
      return response.redirect().withQs(false).toPath(appUrl(request))
    } catch (error) {
      return authPage(view, request, 'login', {
        email,
        error: error instanceof Error ? error.message : 'Login gagal.',
      })
    }
  }

  /** Wizard akun pertama (hanya saat belum ada user). */
  async setup({ request, response, view }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    if (!isLocalAuth())
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    await initializeDatabase()
    if ((await countUsers()) > 0)
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    return authPage(view, request, 'setup')
  }

  async setupPost({ request, session, response, view }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    if (!isLocalAuth())
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    await initializeDatabase()
    if ((await countUsers()) > 0)
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    const email = String(request.input('email', '')).trim()
    const name = String(request.input('name', '')).trim()
    const password = String(request.input('password', ''))
    const confirm = String(request.input('password_confirm', ''))
    try {
      if (password !== confirm) throw new Error('Ulangi password tidak sama.')
      const id = await createUser({ email, name, password })
      session.regenerate()
      session.put('account', localSession({ id, email: email.toLowerCase(), name }))
      return response.redirect().withQs(false).toPath(appUrl(request))
    } catch (error) {
      return authPage(view, request, 'setup', {
        email,
        name,
        error: error instanceof Error ? error.message : 'Pendaftaran gagal.',
      })
    }
  }

  async callback({ request, session, response }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    if (isLocalAuth())
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    const pending = session.get('account_oauth')
    session.forget('account_oauth')
    const state = request.input('state')
    const code = request.input('code')
    const issuer = request.input('iss')
    if (
      !pending ||
      pending.expires < Date.now() ||
      typeof state !== 'string' ||
      state !== pending.state ||
      typeof code !== 'string' ||
      issuer !== accountUrl()
    ) {
      return response.redirect().withQs(false).toPath(`${appUrl()}/login`)
    }
    try {
      await initializeDatabase()
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: `${appUrl()}/auth/callback`,
        code,
        code_verifier: pending.verifier,
      })
      const token = await jsonRequest(`${accountUrl()}/oauth/account/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      const user = await jsonRequest(`${accountUrl()}/oauth/account/userinfo`, {
        headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
      })
      if (
        !/^[a-f0-9]{64}$/.test(String(user.sub)) ||
        user.iss !== accountUrl() ||
        user.aud !== clientId ||
        !/^[A-Za-z0-9_-]{43}$/.test(String(token.session_token))
      )
        throw new Error('Identitas Account tidak valid.')
      await db.rawQuery(
        `INSERT INTO account_identity (id, owner_handle, issuer, verified_at) VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE owner_handle=VALUES(owner_handle), issuer=VALUES(issuer), verified_at=VALUES(verified_at)`,
        [user.sub, user.iss, new Date()]
      )
      session.regenerate()
      session.put('account', {
        sub: user.sub,
        issuer: user.iss,
        sessionToken: token.session_token,
        name: String(user.name || 'Pemilik'),
        username: String(user.preferred_username || ''),
        picture: String(user.picture || ''),
        checkedAt: Date.now(),
      })
      return response.redirect().withQs(false).toPath(appUrl())
    } catch {
      return response
        .status(503)
        .send('Login belum berhasil. Buka kembali halaman login WhatsApp untuk mencoba lagi.')
    }
  }

  async logout({ request, session, response }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    session.clear()
    if (isLocalAuth())
      return response
        .redirect()
        .withQs(false)
        .toPath(`${appUrl(request)}/login`)
    const params = new URLSearchParams({ return_to: `${appUrl()}/login` })
    return response
      .redirect()
      .withQs(false)
      .toPath(`${accountUrl()}/oauth/account/logout?${params}`)
  }
}
