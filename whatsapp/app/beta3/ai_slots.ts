// v3.6.109 — Antrian AI: banyak chat masuk bersamaan tidak boleh menyalakan puluhan proses AI sekaligus
// (memori server habis → koneksi WhatsApp ikut putus). Maksimal N proses berjalan; sisanya menunggu giliran.
// Chat pelanggan asli selalu didahulukan dari uji simulasi.
import { freemem, loadavg, totalmem } from 'node:os'

export const DEFAULT_AI_SLOTS = 8
type Waiter = { priority: number; at: number; start: () => void; cancel: () => void }

let limit = Math.max(1, Number(process.env.AI_MAX_PARALLEL) || DEFAULT_AI_SLOTS)
let active = 0
const queue: Waiter[] = []
const stats = { since: Date.now(), maxActive: 0, maxQueued: 0, waits: [] as number[], minFreeMem: Number.POSITIVE_INFINITY, maxLoad: 0 }

/** Untuk tes & pengaturan: batas proses AI bersamaan. */
export function setAiSlotLimit(next: number) {
  limit = Math.max(1, Math.floor(next) || DEFAULT_AI_SLOTS)
  pump()
}

function sample() {
  stats.minFreeMem = Math.min(stats.minFreeMem, freemem())
  stats.maxLoad = Math.max(stats.maxLoad, loadavg()[0] || 0)
}

function pump() {
  while (active < limit && queue.length) {
    queue.sort((a, b) => a.priority - b.priority || a.at - b.at)
    const next = queue.shift()!
    next.start()
  }
}

/** Prioritas: 0 = pelanggan asli, 1 = uji simulasi. */
export const slotPriority = (jid?: string) => (String(jid || '').endsWith('@sim') ? 1 : 0)

/**
 * Jalankan satu proses AI dengan slot. Dibatalkan saat menunggu (akun lain sudah menjawab) → keluar
 * dari antrian tanpa memakai slot.
 */
export function withAiSlot<T>(priority: number, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queuedAt = Date.now()
    let started = false
    const begin = () => {
      started = true
      active++
      stats.maxActive = Math.max(stats.maxActive, active)
      stats.waits.push(Date.now() - queuedAt)
      if (stats.waits.length > 2000) stats.waits.splice(0, stats.waits.length - 2000)
      sample()
      Promise.resolve()
        .then(action)
        .then(resolve, reject)
        .finally(() => {
          active--
          sample()
          pump()
        })
    }
    const waiter: Waiter = {
      priority,
      at: queuedAt,
      start: begin,
      cancel: () => reject(signal?.reason instanceof Error ? signal.reason : new Error('Dibatalkan saat menunggu antrian AI.')),
    }
    if (signal?.aborted) return waiter.cancel()
    signal?.addEventListener(
      'abort',
      () => {
        if (started) return
        const index = queue.indexOf(waiter)
        if (index >= 0) queue.splice(index, 1)
        waiter.cancel()
      },
      { once: true }
    )
    queue.push(waiter)
    stats.maxQueued = Math.max(stats.maxQueued, queue.length)
    pump()
  })
}

const pct = (values: number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/** Ringkasan beban sejak `resetAiSlotStats` (untuk laporan uji beban). */
export function aiSlotStats() {
  sample()
  return {
    limit,
    active,
    queued: queue.length,
    maxActive: stats.maxActive,
    maxQueued: stats.maxQueued,
    waitMedianMs: pct(stats.waits, 0.5),
    waitP90Ms: pct(stats.waits, 0.9),
    waitMaxMs: stats.waits.length ? Math.max(...stats.waits) : 0,
    runs: stats.waits.length,
    memTotalMb: Math.round(totalmem() / 1048576),
    memFreeMinMb: Number.isFinite(stats.minFreeMem) ? Math.round(stats.minFreeMem / 1048576) : Math.round(freemem() / 1048576),
    memFreeNowMb: Math.round(freemem() / 1048576),
    loadMax: Math.round(stats.maxLoad * 100) / 100,
    sinceMs: Date.now() - stats.since,
  }
}

export function resetAiSlotStats() {
  stats.since = Date.now()
  stats.maxActive = active
  stats.maxQueued = queue.length
  stats.waits = []
  stats.minFreeMem = Number.POSITIVE_INFINITY
  stats.maxLoad = 0
}

/** Memori server menipis (< 10% atau < 400 MB): uji beban harus berhenti. */
export function memoryLow() {
  const free = freemem()
  return free < Math.max(400 * 1048576, totalmem() * 0.1)
}
