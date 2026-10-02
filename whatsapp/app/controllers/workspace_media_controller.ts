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
  // Nama file media unik per pesan dan tidak berubah → boleh disimpan browser (khusus pengguna ini).
  headers: (path: string) => ({
    'Cache-Control': path.includes('/profiles/') ? 'private, max-age=3600' : 'private, max-age=604800',
  }),
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
