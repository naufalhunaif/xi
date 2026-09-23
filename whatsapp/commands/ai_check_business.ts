import { withActiveWorkspace } from '#services/workspace_service'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

/** Explicit diagnostic: uses the configured model and MCP reads, never sends WhatsApp. */
export default class AiCheckBusiness extends BaseCommand {
  static commandName = 'ai:check-business'
  static description =
    'Uji pencarian data bisnis dengan AI/OAuth aktif tanpa mengirim WhatsApp (menggunakan kuota AI)'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Pertanyaan bisnis untuk uji baca MCP' })
  declare question: string

  async run() {
    return withActiveWorkspace(() => this.runInWorkspace())
  }

  private async runInWorkspace() {
    if (!this.question?.trim()) {
      this.logger.error('Isi --question untuk menjalankan uji AI dan baca MCP.')
      this.exitCode = 1
      return
    }
    const settings = await readSettings(true)
    const result = await createReply(
      settings,
      this.question,
      undefined,
      undefined,
      'Uji terisolasi oleh pemilik. Tidak ada percakapan/angka harga terverifikasi sebelumnya. Dilarang mengubah data bisnis atau mengirim pesan. Gunakan tool baca saja.',
      [],
      (event) => this.logger.info(`${event.status}: ${event.label}`)
    )
    this.logger.info(JSON.stringify(result))
  }
}
