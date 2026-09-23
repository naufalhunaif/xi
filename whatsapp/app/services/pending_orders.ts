import db from '#services/workspace_database'
import { isBeta3Mode, isLeanMode } from '#services/settings_service'

/** Jumlah order yang menunggu tindakan CS (isi total) — untuk badge menu Order. */
export async function pendingOrderCount() {
  try {
    const table = (await isBeta3Mode())
      ? 'whatsapp_beta3_orders'
      : (await isLeanMode())
        ? 'whatsapp_lean_orders'
        : ''
    if (!table) return 0
    const row = await db.from(table).where('status', 'pending').count('* as total').first()
    return Number(row?.total || 0)
  } catch {
    return 0
  }
}
