import type { HttpContext } from '@adonisjs/core/http'
import {
  readCart,
  saveCart,
  approveCustom,
  approveModel,
  setItemFulfillment,
  reportPayment,
  cancelCart,
  listOrders,
  readCustomerBalance,
  confirmPayment,
  cancelOrder,
} from '#services/cart_service'
import { requestAiReview } from '#services/ai_review_service'
import { resumeAiAfterHumanReply } from '#services/message_service'
import { preparePaymentReview } from '#services/payment_review_service'

export default class CartsController {
  async index({ request, response }: HttpContext) {
    try {
      const jid = String(request.input('jid', ''))
      response.header('cache-control', 'no-store')
      return response.json({
        cart: await readCart(jid),
        orders: await listOrders(jid),
        customerBalance: await readCustomerBalance(jid),
      })
    } catch (error) {
      return response.unprocessableEntity({ error: (error as Error).message })
    }
  }

  async mutate({ request, params, session, response }: HttpContext) {
    try {
      const input = request.all()
      const jid = String(input.jid || '')
      const version = String(input.version || '')
      const actor = String(session.get('account')?.sub || '')
      let order
      switch (params.action) {
        case 'read-payment':
          return response.json({
            review: await preparePaymentReview(
              jid,
              version,
              input.orderId ? Number(input.orderId) : undefined
            ),
          })
        case 'model':
          if (typeof input.approved !== 'boolean') throw new Error('Persetujuan tidak valid.')
          await approveModel(
            jid,
            version,
            String(input.itemId || ''),
            input.approved,
            String(input.note || ''),
            actor
          )
          break
        case 'save':
          await saveCart(jid, version, input, actor)
          break
        case 'custom':
          if (typeof input.approved !== 'boolean') throw new Error('Persetujuan tidak valid.')
          await approveCustom(
            jid,
            version,
            String(input.itemId || ''),
            input.approved,
            String(input.note || ''),
            actor
          )
          break
        case 'fulfillment':
          await setItemFulfillment(
            jid,
            version,
            String(input.itemId || ''),
            input.fulfillment === 'preorder' ? 'preorder' : 'ready',
            String(input.note || ''),
            actor
          )
          break
        case 'transfer':
          await reportPayment(jid, version, input.proofMessageId, actor)
          break
        case 'cancel':
          await cancelCart(jid, version, actor)
          break
        case 'confirm-payment':
          if (!input.reviewId) throw new Error('Baca bukti transfer terlebih dahulu.')
          order = await confirmPayment(
            jid,
            {
              version,
              reviewId: String(input.reviewId),
              requestKey: input.requestKey,
              verified: input.verified,
            },
            actor
          )
          break
        case 'cancel-order':
          await cancelOrder(jid, Number(input.orderId), actor)
          break
        default:
          throw new Error('Tindakan tidak valid.')
      }
      if (['model', 'custom', 'fulfillment', 'confirm-payment'].includes(params.action))
        await resumeAiAfterHumanReply(jid, 'human_decision')
      else await requestAiReview(jid, 'enabled')
      return response.json({
        cart: await readCart(jid),
        orders: await listOrders(jid),
        customerBalance: await readCustomerBalance(jid),
        order,
      })
    } catch (error) {
      return response.unprocessableEntity({
        error: (error as Error).message || 'Cart tidak dapat diperbarui.',
      })
    }
  }
}
