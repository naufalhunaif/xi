import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { activeWorkspace, workspaceState } from '#services/workspace_service'
import { withChatMutationLock } from '#services/chat_cleanup_service'
import { inWorkspace } from '#services/workspace_context'
import { ensureDefaults } from '#services/settings_service'
import { appVersion } from '#services/app_version'
import { publicAppUrl } from '#services/public_url'

export default class WorkspaceMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const scope = await activeWorkspace()
    ctx.response.header('X-WhatsApp-Workspace', scope.version)
    ctx.response.header('Cache-Control', 'no-store')
    ctx.view.share({
      workspaceVersion: scope.version,
      workspaceId: scope.id,
      appVersion: appVersion(),
      appUrl: publicAppUrl(ctx.request),
    })
    const expected = ctx.request.header('X-WhatsApp-Workspace')
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.request.method())
    const allowed = [
      '/api/connect',
      '/api/disconnect',
      '/logout',
      '/api/access/domain',
      '/api/access/domain/unset',
    ].includes(ctx.request.url())
    if (
      (expected && expected !== scope.version) ||
      (mutation && !allowed && (!scope.id || expected !== scope.version))
    ) {
      return ctx.response.conflict({
        error: 'Hubungkan nomor WhatsApp terlebih dahulu atau muat ulang halaman.',
        workspaceChanged: true,
      })
    }
    return inWorkspace(scope, async () => {
      await ensureDefaults()
      if (!mutation || !scope.id) return next()
      try {
        return await withChatMutationLock(async () => {
          const current = await workspaceState()
          if (current.version !== scope.version)
            return ctx.response.conflict({ workspaceChanged: true })
          if (current.cleanup_workspace_id)
            return ctx.response.status(423).json({ error: 'Penghapusan chat sedang berjalan.' })
          return next()
        })
      } catch (error) {
        if (error instanceof Error && error.message === 'CHAT_MUTATION_BUSY')
          return ctx.response.status(423).json({ error: 'Ada proses lain. Coba lagi sebentar.' })
        throw error
      }
    })
  }
}
