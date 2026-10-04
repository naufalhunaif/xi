import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import { ensureDefaults } from '#services/settings_service'
import { orderRouting, saveOrderRouting, requestOrderGroups } from '#services/order_operations_service'

export default class OrdersController {
  async page({ view, session }: HttpContext) {
    await ensureDefaults()
    return view.render('pages/dashboard', {
      page: 'orders',
      account: session.get('account'),
      bundle: (env.get('ACCOUNT_URL') || '')
        .replace(/\/$/, '')
        .replace(/\/account$/, ''),
    })
  }
  async routing({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json(await orderRouting())
  }
  async saveRouting({ request, response }: HttpContext) {
    try {
      return response.json(await saveOrderRouting(request.all()))
    } catch (error) {
      return response.unprocessableEntity({ error: (error as Error).message })
    }
  }
  async refreshGroups({ response }: HttpContext) {
    await requestOrderGroups()
    return response.json({ ok: true })
  }
}
