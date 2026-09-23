import type { HttpContext } from '@adonisjs/core/http'
import {
  LearningConflict,
  learningOverview,
  setLearningEnabled,
  rollbackLearning,
} from '#services/conversation_learning_service'

export default class LearningController {
  async index({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json(await learningOverview())
  }
  async save({ request, response }: HttpContext) {
    if (typeof request.input('enabled') !== 'boolean')
      return response.unprocessableEntity({ error: 'Pengaturan tidak valid.' })
    try {
      await setLearningEnabled(request.input('enabled'), String(request.input('revision', '')))
      return response.json(await learningOverview())
    } catch (error) {
      return response.conflict({
        error:
          error instanceof LearningConflict
            ? error.message
            : 'Pembelajaran belum dapat diperbarui.',
      })
    }
  }
  async rollback({ params, request, response, session }: HttpContext) {
    const id = Number(params.id)
    if (!Number.isSafeInteger(id) || id < 1)
      return response.unprocessableEntity({ error: 'Versi pembelajaran tidak valid.' })
    try {
      await rollbackLearning(
        id,
        String(request.input('revision', '')),
        String(session.get('account')?.sub || '')
      )
      return response.json(await learningOverview())
    } catch (error) {
      return response.conflict({
        error:
          error instanceof LearningConflict ? error.message : 'Versi belum dapat dikembalikan.',
      })
    }
  }
}
