import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { ensureDefaults } from '#services/settings_service'
import { activeWorkspace } from '#services/workspace_service'
import { inWorkspace } from '#services/workspace_context'

export default class AppInit extends BaseCommand {
  static commandName = 'app:init'
  static description = 'Membuat tabel aplikasi jika belum tersedia'
  static options: CommandOptions = { startApp: true }

  async run() {
    await ensureDefaults()
    const scope = await activeWorkspace()
    await inWorkspace(scope, () => ensureDefaults())
    this.logger.success('Database WhatsApp siap')
  }
}
