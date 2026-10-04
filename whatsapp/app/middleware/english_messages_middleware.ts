import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { englishBody } from '#services/english_messages'

/** Pesan JSON (error/message) dari API dikirim dalam bahasa Inggris. */
export default class EnglishMessagesMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await next()
    try {
      const body = ctx.response.getBody()
      if (body && typeof body === 'object' && !Buffer.isBuffer(body) && typeof (body as any).pipe !== 'function') {
        const mapped = englishBody(body)
        if (mapped !== body) ctx.response.send(mapped)
      }
    } catch {}
  }
}
