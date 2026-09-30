import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { randomBytes } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import { countUsers, createUser, resetPassword } from '#services/local_auth_service'
import db from '#services/workspace_database'

/**
 * node ace auth:reset EMAIL [--password=...] [--stdin] [--name=...]
 * Mengganti password akun lokal; bila email belum ada, akun dibuat.
 * --stdin: password dibaca dari stdin (dipakai `wa password`, supaya tidak terlihat di daftar proses).
 * Tanpa --password/--stdin, password acak dibuat dan dicetak sekali.
 */
export default class AuthReset extends BaseCommand {
  static commandName = 'auth:reset'
  static description = 'Reset/buat akun login lokal (mode standalone)'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'Email akun' })
  declare email: string

  @flags.string({ description: 'Password baru (min. 8 karakter); kosong = acak' })
  declare password?: string

  @flags.boolean({ description: 'Baca password baru dari stdin; akun harus sudah ada' })
  declare stdin?: boolean

  @flags.string({ description: 'Nama tampilan (hanya saat akun baru)' })
  declare name?: string

  async run() {
    await initializeDatabase()
    const email = this.email.trim().toLowerCase()
    const exists = await db.from('wa_users').where('email', email).first()
    if (this.stdin) {
      if (!exists) {
        this.logger.error(`Email ${email} tidak terdaftar.`)
        this.exitCode = 1
        return
      }
      let input = ''
      for await (const chunk of process.stdin) input += chunk
      try {
        await resetPassword(email, input.replace(/\r?\n$/, ''))
        this.logger.success(`Password ${email} diganti.`)
      } catch (error) {
        this.logger.error(error instanceof Error ? error.message : String(error))
        this.exitCode = 1
      }
      return
    }
    const password = this.password || randomBytes(9).toString('base64url')
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
