import db from '#services/workspace_database'

/** Preview only: existing debts have priority; reading a cart never spends credit. */
export async function customerBalanceQuote(
  jid: string,
  billAmount: number,
  complete = true,
  orderId?: number,
  client: any = db
) {
  const ledger = await client
    .from('whatsapp_customer_balance_entries')
    .where('jid', jid)
    .sum('amount as balance')
    .first()
  const debts = client
    .from('whatsapp_orders')
    .where('jid', jid)
    .where('status', 'active')
    .whereColumn('paid', '<', 'total')
  if (orderId) debts.where('id', '<', orderId)
  const olderOrders = await debts.select('total', 'paid')
  const availableBalance = Math.max(0, Number(ledger?.balance || 0))
  const reservedForOrders = Math.min(
    availableBalance,
    olderOrders.reduce(
      (sum: number, order: any) => sum + Math.max(0, Number(order.total) - Number(order.paid)),
      0
    )
  )
  const balanceToUse = complete
    ? Math.min(Math.max(0, billAmount), availableBalance - reservedForOrders)
    : 0
  return {
    availableBalance,
    reservedForOrders,
    balanceToUse,
    amountDue: complete ? Math.max(0, billAmount - balanceToUse) : null,
  }
}
