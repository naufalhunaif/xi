// v3.6.57 — Cek kesehatan akun AI yang lama tidak dipakai. Akun yang gagal/lambat ditandai jeda
// SEBELUM dipakai untuk membalas pelanggan, jadi pelanggan tidak menunggu kegagalannya.
import type { AiAccount } from '#services/ai_accounts'

/** Akun dianggap "diam" bila tidak dipakai/dicek selama ini. */
export const PROBE_IDLE_MS = 30 * 60_000
/** Tes kecil lebih lama dari ini = lambat → dijeda singkat seperti gagal. */
export const PROBE_SLOW_MS = 45_000
/** Kode jeda dari kegagalan biasa: setelah jedanya habis, dicek ulang dulu sebelum dipercaya lagi. */
const RECHECK_CODES = new Set(['AI_PROCESS_FAILED', 'AI_SLOW'])

const lastProbe = new Map<number, number>()

/**
 * Akun yang perlu dicek sekarang (paling lama dulu): aktif, tidak sedang dijeda, dan
 * (lama tidak dipakai & lama tidak dicek) atau baru pulih dari jeda karena gagal/lambat.
 */
export function accountsToProbe(accounts: AiAccount[], now: number, probed: Map<number, number> = lastProbe) {
  return accounts
    .filter((account) => account.enabled && account.limitedUntil <= now)
    .filter((account) => account.provider !== 'gemini' || Boolean(account.apiKey))
    .filter((account) => {
      const checked = probed.get(account.id) || 0
      const used = account.lastUsedAt ? account.lastUsedAt.getTime() : 0
      const recovering = RECHECK_CODES.has(account.limitedCode) && checked < account.limitedUntil
      const idle = now - Math.max(used, checked) >= PROBE_IDLE_MS
      return recovering || idle
    })
    .sort((a, b) => Math.max(a.lastUsedAt?.getTime() || 0, probed.get(a.id) || 0) - Math.max(b.lastUsedAt?.getTime() || 0, probed.get(b.id) || 0))
}

/** Hasil tes → tindakan: sehat, lambat, atau gagal (kode jeda). */
export function probeVerdict(result: { ok: boolean; ms: number; code?: string }) {
  if (!result.ok) return { healthy: false, code: result.code || 'AI_PROCESS_FAILED' }
  if (result.ms > PROBE_SLOW_MS) return { healthy: false, code: 'AI_SLOW' }
  return { healthy: true, code: '' }
}

/** Cek SATU akun (yang paling lama diam) per panggilan; dipanggil berkala oleh worker. */
export async function probeIdleAccount(settings: Record<string, any>, now = Date.now()) {
  const { listAiAccounts, markAiAccountLimited, recordAiEvent, updateAiAccount } = await import('#services/ai_accounts')
  const [account] = accountsToProbe(await listAiAccounts(), now)
  if (!account) return null
  lastProbe.set(account.id, now)
  const { testAiAccount } = await import('#beta3/provider')
  const result = await testAiAccount(settings as any, account)
  const verdict = probeVerdict(result)
  if (verdict.healthy) {
    // Pulih: hapus catatan gagal tanpa mengubah "terakhir dipakai".
    if (account.limitedCode) await updateAiAccount(account.id, { limited_code: null, last_error: null }).catch(() => {})
    await recordAiEvent(account.id, 'ok', 'probe', `cek ${Math.round(result.ms / 1000)} dtk`).catch(() => {})
  } else {
    const message = 'error' in result && result.error ? String(result.error) : `cek lambat ${Math.round(result.ms / 1000)} dtk`
    await markAiAccountLimited(account.id, verdict.code, `Cek otomatis: ${message}`).catch(() => {})
    await recordAiEvent(account.id, 'fail', 'probe', `${verdict.code}: ${message}`).catch(() => {})
  }
  return { id: account.id, ...verdict, ms: result.ms }
}
