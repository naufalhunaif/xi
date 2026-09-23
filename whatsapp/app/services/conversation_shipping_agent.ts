import db from '#services/workspace_database'
import { isAiWorking } from '#services/ai_work_schedule'
import { readSettings } from '#services/settings_service'
import { buildTurnContext } from '#services/context_service'
import { chooseShipmentTool } from '#services/ai_service'
import { startTrace } from '#services/trace_service'
import { workspaceScope } from '#services/workspace_context'
import type { ShipmentAgentFactory } from '#services/shipment_agent_contract'

export const conversationShippingAgent: ShipmentAgentFactory = async (job) => {
  const settings = await readSettings(true)
  const latestMessage = () =>
    db
      .from('whatsapp_messages')
      .where('jid', job.order.jid)
      .whereNotIn('status', ['queued', 'failed'])
      .max('id as id')
      .first()
  const anchor = Number((await latestMessage())?.id || 0)
  const allowed = async () => {
    const current = await readSettings(false)
    const contact = await db.from('whatsapp_contacts').where('jid', job.order.jid).first()
    const workspace = await db.from('whatsapp_workspace_state').where('id', 1).first()
    return Boolean(
      isAiWorking(current) &&
      current.hasSkill &&
      !contact?.ai_excluded &&
      contact?.handling_mode !== 'cs' &&
      Number(workspace?.active_id) === workspaceScope().id &&
      current.aiProvider === settings.aiProvider &&
      Number((await latestMessage())?.id || 0) === anchor
    )
  }
  if (!(await allowed())) return null
  const trace = await startTrace(job.order.jid, {
    trigger: 'order_shipping',
    orderId: job.order_id,
    provider: settings.aiProvider,
    model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
    skills: settings.skills.map((skill) => skill.name),
  })
  return {
    allowed,
    emit: trace.emit,
    async decide(state) {
      const context = await buildTurnContext(job.order.jid, [], settings.historyLimit)
      return chooseShipmentTool(
        settings,
        context.prompt,
        {
          ...state,
          order: {
            id: job.order_id,
            invoice: state.invoice,
            operations: job.operations,
            cart: JSON.parse(job.order.snapshot_json),
            total: job.order.total,
            paid: job.order.paid,
          },
          previousAssessment: job.agent_state_json ? JSON.parse(job.agent_state_json) : null,
        },
        trace.emit
      )
    },
    finish: (status, detail) => trace.finish(status, detail),
  }
}
