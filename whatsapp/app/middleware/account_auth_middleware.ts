import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import env from '#start/env'
import { isLocalAuth } from '#services/local_auth_service'
import { publicAppUrl } from '#services/public_url'

const accountUrl = () => String(env.get('ACCOUNT_URL') || '').replace(/\/$/, '')

export default class AccountAuthMiddleware {
  async handle({ session, response, request }: HttpContext, next: NextFn) {
    response.header('Cache-Control', 'no-store, private')
    const account = session.get('account')
    const login = `${publicAppUrl(request)}/login`
    const api = request.url().startsWith('/api/') || request.accepts(['html', 'json']) === 'json'
    const unauthenticated = () => {
      session.forget('account')
      if (api) {
        response.header('X-WhatsApp-Auth', 'required')
        return response.unauthorized({
          code: 'AUTH_REQUIRED',
          error: 'Sesi berakhir. Silakan masuk kembali.',
        })
      }
      return response.redirect().withQs(false).toPath(login)
    }
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(String(account?.sessionToken || '')) ||
      !/^[a-f0-9]{64}$/.test(String(account?.sub || '')) ||
      (account.issuer && account.issuer !== accountUrl())
    ) {
      return unauthenticated()
    }
    // Login lokal (standalone): sesi dibuat oleh aplikasi ini sendiri, tidak ada server Account.
    if (isLocalAuth()) {
      if (account.local !== true) return unauthenticated()
      return next()
    }
    if (account.local === true) return unauthenticated()
    const checkedAt = Number(account.checkedAt || 0)
    if (!Number.isFinite(checkedAt) || checkedAt > Date.now() || checkedAt < Date.now() - 30_000) {
      try {
        const check = await fetch(`${accountUrl()}/oauth/account/session`, {
          headers: {
            authorization: `Bearer ${account.sessionToken}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        })
        if (check.status === 401 || check.status === 403) return unauthenticated()
        if (!check.ok || !check.headers.get('content-type')?.includes('application/json'))
          throw new Error('Account unavailable')
        const data = (await check.json()) as any
        if (
          data.active !== true ||
          data.sub !== account.sub ||
          data.aud !== 'whatsapp' ||
          data.iss !== accountUrl()
        )
          return unauthenticated()
        account.checkedAt = Date.now()
        session.put('account', account)
      } catch {
        // A timeout, rate limit, redirect or gateway error must not destroy a valid session.
        // Access still fails closed: controllers are not called while validation is unavailable.
        response.header('Retry-After', '10')
        response.header('X-WhatsApp-Auth', 'unavailable')
        return response.serviceUnavailable({
          code: 'AUTH_UNAVAILABLE',
          error: 'Layanan login sementara tidak tersedia. Coba lagi sebentar.',
        })
      }
    }
    return next()
  }
}
