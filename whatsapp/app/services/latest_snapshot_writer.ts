/** Coalesce complete snapshots while a slow sink is busy; never queue every intermediate write. */
export function latestSnapshotWriter(
  write: (snapshot: Record<string, unknown>) => Promise<unknown>,
  onError: () => void
) {
  let latest: Record<string, unknown> = {}
  let version = 0
  let written = 0
  let running: Promise<void> | undefined
  const start = () => {
    if (running || written === version) return
    running = Promise.resolve()
      .then(async () => {
        while (written < version) {
          const target = version
          try {
            await write({ ...latest })
          } catch {
            onError()
          }
          written = target
        }
      })
      .finally(() => {
        running = undefined
        start()
      })
  }
  return {
    enqueue(values: Record<string, unknown>) {
      latest = { ...latest, ...values }
      version++
      start()
    },
    async flush() {
      while (running) await running
    },
  }
}
