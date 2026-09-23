// Beta 3 — salinan terisolasi perintah lean.
import { readFile } from 'node:fs/promises'
import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { withActiveWorkspace } from '#services/workspace_service'
import { catalogDigest, importLeanCatalog } from '#beta3/catalog_service'
import { estimateTokens } from '#services/prompt_size_service'
import { readLeanMcpConfig, syncLeanCatalog } from '#beta3/mcp'
import { describeCatalogPhotos } from '#beta3/catalog_vision'

/** Beta 2: impor katalog digest dari file JSON (ekspor web/MCP/Excel). */
export default class Beta3Catalog extends BaseCommand {
  static commandName = 'beta3:catalog'
  static description =
    'Impor katalog jalur ramping dari file JSON dan tampilkan digest yang dibaca AI'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Path file JSON berisi array produk', required: false })
  declare file: string

  @flags.boolean({ description: 'Ganti seluruh katalog, bukan upsert' })
  declare replace: boolean

  @flags.boolean({ description: 'Tarik dari koneksi MCP yang dipilih di Beta 2 / Data bisnis' })
  declare sync: boolean

  @flags.boolean({ description: 'Abaikan versi tersimpan; tarik ulang seluruh katalog' })
  declare force: boolean

  @flags.boolean({ description: 'Analisis ciri model dari foto (hanya yang belum punya ciri)' })
  declare describe: boolean

  async run() {
    return withActiveWorkspace(async () => {
      if (this.sync || !this.file) {
        const config = await readLeanMcpConfig()
        if (!config.url || config.error) {
          this.logger.error(
            config.error || 'Sumber data belum dipilih. Jalankan beta3:mcp --slug=… dulu.'
          )
          this.exitCode = 1
          return
        }
        const result = await syncLeanCatalog({ force: Boolean(this.force) })
        if (result.unchanged) {
          this.logger.info(
            `Katalog belum berubah (versi ${result.version}); digest lama tetap dipakai.`
          )
          return
        }
        this.logger.info(
          `${result.count} varian disinkronkan dari ${config.name || config.url} (versi ${result.version || '-'}).`
        )
        if (this.describe) {
          const seen = await describeCatalogPhotos(50, (line) => this.logger.info(line))
          this.logger.info(`Ciri model: ${seen.done} foto dianalisis.`)
        }
      } else if (this.file) {
        const parsed = JSON.parse(await readFile(this.file, 'utf8'))
        const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.products
        const count = await importLeanCatalog(items, Boolean(this.replace))
        this.logger.info(`${count} varian diimpor.`)
      }
      const digest = await catalogDigest(true)
      this.logger.info(
        `Digest ≈ ${estimateTokens(digest.text)} token, ${digest.rows.length} varian:`
      )
      console.log(digest.text)
    })
  }
}
