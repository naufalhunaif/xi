import type { HttpContext } from '@adonisjs/core/http'
import { startSkillEdit, skillEditStatus } from '#services/skill_edit_service'
import { SkillEditError } from '#services/skill_edit_contract'

export default class SkillEditsController {
  async create({ request, response, session }: HttpContext) {
    try {
      const result = await startSkillEdit(
        String(request.input('requestKey', '')),
        String(request.input('instruction', '')),
        String(session.get('account')?.sub || '')
      )
      return response.accepted(result)
    } catch (error) {
      return response.unprocessableEntity({
        error:
          error instanceof SkillEditError ? error.message : 'Pembaruan skill belum dapat dimulai.',
      })
    }
  }
  async show({ params, response }: HttpContext) {
    response.header('cache-control', 'no-store')
    try {
      return response.json(await skillEditStatus(String(params.id)))
    } catch (error) {
      return response.unprocessableEntity({
        error: error instanceof SkillEditError ? error.message : 'Status pembaruan belum tersedia.',
      })
    }
  }
}
