import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import app from '@adonisjs/core/services/app'
import StaticMiddleware from '@adonisjs/static/static_middleware'
import staticConfig from '#config/static'
import { posix } from 'node:path'

const assets = new StaticMiddleware(app.publicPath(), { ...staticConfig, maxAge: '1h' })
// URL ber-versi (?v=…) tidak pernah berubah isinya → simpan di browser 1 tahun, tanpa cek ulang ke server.
const versioned = new StaticMiddleware(app.publicPath(), {
  ...staticConfig,
  maxAge: '365d',
  immutable: true,
} as typeof staticConfig)
export default class PublicAssetsMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    // Media must pass account authentication + active-number ownership first.
    let path: string
    try {
      path = posix.normalize(decodeURIComponent(ctx.request.url()).replaceAll('\\', '/'))
    } catch {
      return ctx.response.badRequest()
    }
    if (path.startsWith('/oauth/mcp/callback/')) {
      ctx.response.header('Referrer-Policy', 'no-referrer')
      ctx.response.header('Cache-Control', 'no-store, private')
    }
    if (!path.startsWith('/assets/') && !path.startsWith('/lang/')) return next()
    return (ctx.request.qs().v ? versioned : assets).handle(ctx, next)
  }
}
