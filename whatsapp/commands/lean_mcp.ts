import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { withActiveWorkspace } from '#services/workspace_service'
import { callLeanTool, readLeanMcpConfig, writeLeanMcpConfig } from '#services/lean/lean_mcp'

/** Beta 2: simpan/uji koneksi MCP satu pintu (katalog, fit advisor, ongkir, resi). */
export default class LeanMcp extends BaseCommand {
  static commandName = 'lean:mcp'
  static description = 'Pilih koneksi MCP (dari Data bisnis) untuk jalur ramping, lalu uji'
  static options: CommandOptions = { startApp: true }

  @flags.string({
    description: 'Slug koneksi di Pengaturan → Data bisnis, mis. --slug=chameleoncloth',
  })
  declare slug: string

  @flags.string({ description: 'Uji satu tool, mis. --test=fit_advisor' })
  declare test: string

  @flags.string({
    description: 'Argumen JSON untuk --test, mis. --input={"type":"suit","height":161,"weight":43}',
  })
  declare input: string

  async run() {
    return withActiveWorkspace(async () => {
      if (this.slug !== undefined) await writeLeanMcpConfig({ slug: this.slug, url: '', token: '' })
      const config = await readLeanMcpConfig()
      this.logger.info(
        `MCP: ${config.name || config.url || '(belum diatur)'} · ${config.error || (config.token ? 'terhubung' : 'tanpa token')}`
      )
      if (!config.url || config.error) return
      const tool = this.test || 'catalog_digest'
      const args = this.input
        ? JSON.parse(this.input)
        : tool === 'catalog_digest'
          ? { format: 'json', if_version: 'x' }
          : {}
      const result = await callLeanTool(tool, args, config)
      this.logger.info(`${tool} OK`)
      console.log(JSON.stringify(result, null, 1).slice(0, 1500))
    })
  }
}
