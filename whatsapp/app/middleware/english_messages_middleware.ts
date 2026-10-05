import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { englishBody } from '#services/english_messages'
import { englishHtml } from '#services/ui_english'

/** Pesan JSON (error/message) dari API dan halaman HTML (v3.6.26) dikirim dalam bahasa Inggris. */
export default class EnglishMessagesMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await next()
    try {
      const body = ctx.response.getBody()
      if (typeof body === 'string' && ctx.request.method() === 'GET' && /^\s*<!doctype html/i.test(body)) {
        ctx.response.send(englishHtml(body))
        return
      }
      if (body && typeof body === 'object' && !Buffer.isBuffer(body) && typeof (body as any).pipe !== 'function') {
        const mapped = englishBody(body)
        if (mapped !== body) ctx.response.send(mapped)
      }
    } catch {}
  }
}
