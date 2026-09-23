import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import db from '#services/workspace_database'
import { ensureDefaults, isLeanMode, isBeta3Mode } from '#services/settings_service'
import {
  operationalOrders,
  orderRouting,
  saveOrderRouting,
  requestOrderGroups,
  saveOrderOperations,
} from '#services/order_operations_service'
import { retryOrderGroup, acknowledgeOrderGroup } from '#services/order_group_delivery_service'

export default class OrdersController {
  async page({ view, session }: HttpContext) {
    await ensureDefaults()
    // Beta 2: halaman Order menampilkan order lean (form pelanggan), bukan order Beta 1.
    const leanMode = await isLeanMode().catch((error) => {
      console.error('leanMode tidak terbaca:', error instanceof Error ? error.message : error)
      return false
    })
    const beta3Mode = await isBeta3Mode().catch(() => false)
    return view.render('pages/dashboard', {
      page: 'orders',
      leanMode,
      beta3Mode,
      account: session.get('account'),
      bundle: (env.get('ACCOUNT_URL') || '')
        .replace(/\/$/, '')
        .replace(/\/account$/, ''),
    })
  }
  async index({ request, response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json(
      await operationalOrders({
        query: String(request.input('query', '')).trim(),
        stage: request.input('stage'),
        tab: request.input('tab'),
        page: Number(request.input('page', 1)),
        orderId:
          request.input('orderId') === undefined ? undefined : Number(request.input('orderId')),
      })
    )
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
  async save({ params, request, response, session }: HttpContext) {
    try {
      const id = Number(params.id)
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Order tidak valid.')
      await saveOrderOperations(id, request.all(), String(session.get('account')?.sub || 'owner'))
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({ error: (error as Error).message })
    }
  }
  async retry({ params, request, response, session }: HttpContext) {
    try {
      await retryOrderGroup(
        Number(params.id),
        request.input('reviewed') === true,
        String(session.get('account')?.sub || 'owner')
      )
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({ error: (error as Error).message })
    }
  }
  async history({ params, response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({
      events: await db
        .from('whatsapp_order_operation_events')
        .where('order_id', Number(params.id))
        .orderBy('id', 'desc')
        .limit(30),
      parts: await db
        .from('whatsapp_order_group_parts')
        .where('order_id', Number(params.id))
        .orderBy('part_index', 'asc')
        .select('part_index', 'message_id', 'content_json', 'status', 'last_error', 'updated_at'),
    })
  }
  async acknowledge({ params, request, response, session }: HttpContext) {
    try {
      await acknowledgeOrderGroup(
        Number(params.id),
        request.input('reviewed') === true,
        String(session.get('account')?.sub || 'owner')
      )
      return response.json({ ok: true })
    } catch (error) {
      return response.unprocessableEntity({ error: (error as Error).message })
    }
  }
}
