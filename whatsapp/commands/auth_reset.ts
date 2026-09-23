import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { randomBytes } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import { countUsers, createUser, resetPassword } from '#services/local_auth_service'
import db from '#services/workspace_database'

/**
 * node ace auth:reset EMAIL [--password=...] [--name=...]
 * Mengganti password akun lokal; bila email belum ada, akun dibuat.
 * Tanpa --password, password acak dibuat dan dicetak sekali.
 */
export default class AuthReset extends BaseCommand {
  static commandName = 'auth:reset'
  static description = 'Reset/buat akun login lokal (mode standalone)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Email akun' })
  declare email: string

  @flags.string({ description: 'Password baru (min. 8 karakter); kosong = acak' })
  declare password?: string

  @flags.string({ description: 'Nama tampilan (hanya saat akun baru)' })
  declare name?: string

  async run() {
    await initializeDatabase()
    const password = this.password || randomBytes(9).toString('base64url')
    const email = this.email.trim().toLowerCase()
    const exists = await db.from('wa_users').where('email', email).first()
    if (exists) {
      await resetPassword(email, password)
      this.logger.success(`Password ${email} diganti.`)
    } else {
      await createUser({ email, name: this.name || '', password })
      this.logger.success(`Akun ${email} dibuat (total akun: ${await countUsers()}).`)
    }
    if (!this.password) this.logger.info(`Password baru: ${password}`)
  }
}
