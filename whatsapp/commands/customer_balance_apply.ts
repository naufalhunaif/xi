import { withActiveWorkspace } from '#services/workspace_service'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { applyCustomerBalance } from '#services/cart_service'

export default class CustomerBalanceApply extends BaseCommand {
  static commandName = 'customer-balance:apply'
  static description =
    'Periksa saldo yang dapat menutup tagihan; --apply untuk mencatat pemakaiannya'
  static options: CommandOptions = { startApp: true }
  @flags.boolean() declare apply: boolean

  async run() {
    return withActiveWorkspace(() => this.runInWorkspace())
  }

  private async runInWorkspace() {
    await initializeDatabase()
    const customers = await db
      .from('whatsapp_customer_balance_entries as entry')
      .select('entry.jid')
      .groupBy('entry.jid')
      .havingRaw('SUM(entry.amount) > 0')
      .whereExists((query) =>
        query
          .from('whatsapp_orders as orders')
          .whereColumn('orders.jid', 'entry.jid')
          .where('orders.status', 'active')
          .whereColumn('orders.paid', '<', 'orders.total')
      )
    let amount = 0
    let orders = 0
    if (this.apply) {
      for (const customer of customers) {
        const allocations = await applyCustomerBalance(
          customer.jid,
          'operator:balance-reconciliation'
        )
        amount += allocations.reduce((sum, item) => sum + item.amount, 0)
        orders += allocations.length
      }
    }
    this.logger.info(
      JSON.stringify({
        mode: this.apply ? 'applied' : 'preview',
        customers: customers.length,
        orders,
        amount,
      })
    )
  }
}
