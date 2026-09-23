import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { withActiveWorkspace } from '#services/workspace_service'
import { listLeanExamples, syncSeedExamples } from '#services/lean/lean_examples_service'

/** Beta 2: tambahkan contoh CS baru dari resources/lean/cs_examples.json tanpa menghapus yang ada. */
export default class LeanExamples extends BaseCommand {
  static commandName = 'lean:examples'
  static description = 'Sinkronkan contoh jawaban CS bawaan (tambah yang belum ada)'
  static options: CommandOptions = { startApp: true }

  async run() {
    return withActiveWorkspace(async () => {
      const added = await syncSeedExamples()
      const examples = await listLeanExamples()
      const total = examples.length
      this.logger.info(`${added} contoh ditambahkan, total ${total}.`)
    })
  }
}
