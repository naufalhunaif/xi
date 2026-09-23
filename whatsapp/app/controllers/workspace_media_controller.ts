import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import StaticMiddleware from '@adonisjs/static/static_middleware'
import { ownsWorkspaceMedia } from '#services/workspace_context'

const media = new StaticMiddleware(app.publicPath(), {
  enabled: true,
  etag: false,
  lastModified: false,
  dotFiles: 'deny',
  maxAge: 0,
  headers: () => ({ 'Cache-Control': 'private, no-store' }),
})
export default class WorkspaceMediaController {
  async show(ctx: HttpContext) {
    const name = ctx.params['*'].join('/')
    if (!ownsWorkspaceMedia(name)) return ctx.response.notFound()
    return media.handle(ctx, async () => {
      ctx.response.notFound()
    })
  }
}
