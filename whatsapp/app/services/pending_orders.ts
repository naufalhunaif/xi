import db from '#services/workspace_database'

/** Jumlah order yang menunggu tindakan CS (isi total) — untuk badge menu Order. */
export async function pendingOrderCount() {
  try {
    const row = await db.from('whatsapp_beta3_orders').where('status', 'pending').count('* as total').first()
    return Number(row?.total || 0)
  } catch {
    return 0
  }
}
