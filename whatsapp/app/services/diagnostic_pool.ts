import database from '@adonisjs/lucid/services/db'

/** Observe already-created pools; never initialize a connection or acquire one. */
export function applicationPoolMetrics() {
  try {
    return [...database.manager.connections.values()].slice(0, 4).flatMap((entry) => {
      const pool = (entry.connection?.client as any)?.client?.pool
      return pool
        ? [
            {
              used: pool.numUsed(),
              free: pool.numFree(),
              pendingAcquires: pool.numPendingAcquires(),
              pendingCreates: pool.numPendingCreates(),
              maximum: pool.max,
            },
          ]
        : []
    })
  } catch {
    return []
  }
}
