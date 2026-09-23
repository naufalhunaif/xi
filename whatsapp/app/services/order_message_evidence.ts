import db from '#services/workspace_database'
import type { DatabaseQueryBuilderContract } from '@adonisjs/lucid/types/querybuilder'

/** Order-only readers can verify retained source evidence without restoring chat history. */
export function orderMessages(client: any = db): DatabaseQueryBuilderContract<any> {
  return client.from(
    client
      .from('whatsapp_messages')
      .select('*')
      .union(client.from('whatsapp_order_message_evidence').select('*'))
      .as('order_messages')
  )
}
