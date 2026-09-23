import type { HttpContext } from '@adonisjs/core/http'
import {
  deletePaymentMethod,
  listPaymentMethods,
  savePaymentMethod,
} from '#services/payment_method_service'

export default class PaymentMethodsController {
  async index({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({ paymentMethods: await listPaymentMethods() })
  }

  async save({ request, params, response }: HttpContext) {
    try {
      const id = params.id === undefined ? undefined : Number(params.id)
      return response.json({ paymentMethods: await savePaymentMethod(request.all(), id) })
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Metode pembayaran tidak valid.',
      })
    }
  }

  async delete({ params, response }: HttpContext) {
    try {
      return response.json({ paymentMethods: await deletePaymentMethod(Number(params.id)) })
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Metode pembayaran tidak valid.',
      })
    }
  }
}
