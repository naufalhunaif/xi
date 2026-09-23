import type { HttpContext } from '@adonisjs/core/http'
import { productionOverview, saveProductionPolicy } from '#services/production_service'

export default class ProductionController {
  async index({ response }: HttpContext) {
    return response.json(await productionOverview())
  }
  async save({ request, response }: HttpContext) {
    try {
      return response.json(await saveProductionPolicy(request.all()))
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof Error ? error.message : 'Invalid production settings.',
      })
    }
  }
}
