// Banyak akun AI (ChatGPT, Claude, Gemini) dipakai bergiliran: bila satu akun
// habis kuota / perlu login, otomatis pindah ke akun berikutnya sesuai urutan.
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import { readSettings } from '#services/settings_service'
import type { AiAccountRef } from '#services/ai_account_context'

export type AiProviderName = 'chatgpt' | 'claude' | 'gemini'
export const AI_ACCOUNT_PROVIDERS: AiProviderName[] = ['chatgpt', 'claude', 'gemini']

export type AiAccount = {
  id: number
  provider: AiProviderName
  label: string
  position: number
  enabled: boolean
  legacy: boolean
  model: string
  apiKey: string
  limitedUntil: number
  limitedCode: string
  lastError: string
  lastUsedAt: Date | null
}

const ready = new Set<string>()
async function ensureTable() {
  const key = workspaceScope().prefix
  if (ready.has(key)) return
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_ai_accounts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(20) NOT NULL,
    label VARCHAR(80) NOT NULL DEFAULT '',
    position INT NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    legacy TINYINT(1) NOT NULL DEFAULT 0,
    model VARCHAR(80) NOT NULL DEFAULT '',
    api_key TEXT NULL,
    limited_until BIGINT NOT NULL DEFAULT 0,
    limited_code VARCHAR(64) NULL,
    last_error VARCHAR(300) NULL,
    last_used_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  // Pertama kali: akun lama (satu ChatGPT + satu Claude) menjadi dua baris pertama.
  const count = await db.from('whatsapp_ai_accounts').count('* as total').first()
  if (!Number(count?.total || 0)) {
    const settings = await readSettings().catch(() => null)
    const primary: AiProviderName = settings?.aiProvider === 'claude' ? 'claude' : 'chatgpt'
    const secondary: AiProviderName = primary === 'claude' ? 'chatgpt' : 'claude'
    const now = new Date()
    await db.table('whatsapp_ai_accounts').multiInsert([
      { provider: primary, label: '', position: 1, enabled: 1, legacy: 1, created_at: now, updated_at: now },
      {
        provider: secondary,
        label: '',
        position: 2,
        enabled: settings?.aiFailover ? 1 : 0,
        legacy: 1,
        created_at: now,
        updated_at: now,
      },
    ])
  }
  ready.add(key)
}

const map = (row: any): AiAccount => ({
  id: Number(row.id),
  provider: AI_ACCOUNT_PROVIDERS.includes(row.provider) ? row.provider : 'chatgpt',
  label: String(row.label || ''),
  position: Number(row.position || 0),
  enabled: Boolean(row.enabled),
  legacy: Boolean(row.legacy),
  model: String(row.model || ''),
  apiKey: String(row.api_key || ''),
  limitedUntil: Number(row.limited_until || 0),
  limitedCode: String(row.limited_code || ''),
  lastError: String(row.last_error || ''),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
})

export async function listAiAccounts() {
  await ensureTable()
  const rows = await db.from('whatsapp_ai_accounts').orderBy('position', 'asc').orderBy('id', 'asc')
  return rows.map(map)
}

export async function readAiAccount(id: number) {
  await ensureTable()
  const row = await db.from('whatsapp_ai_accounts').where('id', id).first()
  return row ? map(row) : null
}

/** Akun yang boleh dicoba sekarang, sesuai urutan. */
export async function usableAiAccounts(now = Date.now()) {
  return (await listAiAccounts()).filter(
    (account) =>
      account.enabled &&
      account.limitedUntil <= now &&
      (account.provider !== 'gemini' || Boolean(account.apiKey))
  )
}

/** Semua akun sedang jeda: kapan yang paling cepat pulih. */
export async function nextAiRecovery(now = Date.now()) {
  const limited = (await listAiAccounts()).filter((a) => a.enabled && a.limitedUntil > now)
  return limited.length ? Math.min(...limited.map((a) => a.limitedUntil)) : 0
}

export async function createAiAccount(input: {
  provider: AiProviderName
  label?: string
  apiKey?: string
  model?: string
}) {
  await ensureTable()
  const last = await db.from('whatsapp_ai_accounts').max('position as max').first()
  const [id] = await db.table('whatsapp_ai_accounts').insert({
    provider: input.provider,
    label: String(input.label || '').slice(0, 80),
    position: Number(last?.max || 0) + 1,
    enabled: 1,
    legacy: 0,
    model: String(input.model || '').slice(0, 80),
    api_key: input.apiKey ? String(input.apiKey).trim() : null,
    created_at: new Date(),
    updated_at: new Date(),
  })
  return Number(id)
}

export async function updateAiAccount(id: number, values: Record<string, unknown>) {
  await ensureTable()
  await db
    .from('whatsapp_ai_accounts')
    .where('id', id)
    .update({ ...values, updated_at: new Date() })
}

export async function deleteAiAccount(id: number) {
  await ensureTable()
  await db.from('whatsapp_ai_accounts').where('id', id).delete()
}

/** Geser urutan satu langkah ke atas/bawah. */
export async function moveAiAccount(id: number, direction: -1 | 1) {
  const accounts = await listAiAccounts()
  const index = accounts.findIndex((a) => a.id === id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= accounts.length) return
  ;[accounts[index], accounts[target]] = [accounts[target], accounts[index]]
  for (const [position, account] of accounts.entries())
    await db.from('whatsapp_ai_accounts').where('id', account.id).update({ position: position + 1 })
}

/** Akun utama (login di panel lama) milik provider ini dipindah ke urutan teratas. */
export async function promoteLegacyAiAccount(provider: 'chatgpt' | 'claude') {
  const accounts = await listAiAccounts()
  const legacy = accounts.find((a) => a.legacy && a.provider === provider)
  if (!legacy) return
  const ordered = [legacy, ...accounts.filter((a) => a.id !== legacy.id)]
  for (const [position, account] of ordered.entries())
    await db
      .from('whatsapp_ai_accounts')
      .where('id', account.id)
      .update(
        account.id === legacy.id ? { position: 1, enabled: 1 } : { position: position + 1 }
      )
}

/** Jeda berbeda per penyebab: kuota lebih lama, gangguan sementara lebih singkat. */
const cooldownMs = (code: string) =>
  code === 'USAGE_LIMIT' ? 60 * 60_000 : code === 'AI_AUTH_REQUIRED' ? 30 * 60_000 : 10 * 60_000

export async function markAiAccountLimited(id: number, code: string, message: string, now = Date.now()) {
  await updateAiAccount(id, {
    limited_until: now + cooldownMs(code),
    limited_code: code.slice(0, 64),
    last_error: message.slice(0, 290),
  })
}

export async function markAiAccountUsed(id: number) {
  await updateAiAccount(id, {
    limited_until: 0,
    limited_code: null,
    last_error: null,
    last_used_at: new Date(),
  })
}

export const aiAccountRef = (account: AiAccount): AiAccountRef | null =>
  account.legacy ? null : { id: account.id, provider: account.provider }
