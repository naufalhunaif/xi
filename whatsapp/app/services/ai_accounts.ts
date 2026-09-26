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

let ready = false
async function ensureTable() {
  if (ready) return
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
  // Dulu tabel ini per nomor: salin akun dari workspace aktif sekali saja.
  const prefix = workspaceScope().prefix
  let count = await db.from('whatsapp_ai_accounts').count('* as total').first()
  if (!Number(count?.total || 0) && prefix) {
    const [found] = await db.rawQuery(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      [`${prefix}whatsapp_ai_accounts`]
    )
    if (Number(found?.[0]?.n || 0)) {
      await db.rawQuery(`INSERT IGNORE INTO whatsapp_ai_accounts SELECT * FROM \`${prefix}whatsapp_ai_accounts\``)
      count = await db.from('whatsapp_ai_accounts').count('* as total').first()
    }
  }
  // Pertama kali: akun lama (satu ChatGPT + satu Claude) menjadi dua baris pertama.
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
        enabled: 1,
        legacy: 1,
        created_at: now,
        updated_at: now,
      },
    ])
  }
  // Dulu akun utama kedua hanya aktif bila "alih otomatis" dinyalakan. Kini semua akun
  // di daftar dipakai: aktifkan sekali, kecuali yang sengaja dinonaktifkan pengguna.
  const [cols] = await db.rawQuery(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'whatsapp_ai_accounts' AND column_name = 'user_set'"
  )
  if (!Number(cols?.[0]?.n || 0)) {
    await db.rawQuery('ALTER TABLE whatsapp_ai_accounts ADD COLUMN IF NOT EXISTS user_set TINYINT(1) NOT NULL DEFAULT 0')
    await db.from('whatsapp_ai_accounts').where('legacy', 1).update({ enabled: 1 })
  }
  ready = true
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

/** Urutan baru hasil seret-lepas; id yang tidak dikirim tetap di belakang. */
export async function setAiAccountOrder(ids: number[]) {
  const accounts = await listAiAccounts()
  const known = new Set(accounts.map((a) => a.id))
  const ordered = [
    ...ids.filter((id) => known.has(id)),
    ...accounts.map((a) => a.id).filter((id) => !ids.includes(id)),
  ]
  for (const [position, id] of ordered.entries())
    await db.from('whatsapp_ai_accounts').where('id', id).update({ position: position + 1 })
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
  code === 'USAGE_LIMIT'
    ? 60 * 60_000
    : code === 'AI_AUTH_REQUIRED' || code === 'ACCESS_DENIED'
      ? 30 * 60_000
      : 5 * 60_000

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

// ── Jejak kerja AI (untuk visual "orkestra" di Pengaturan) ─────────────────────────
export type AiEventKind = 'start' | 'ok' | 'limited' | 'fail'
let eventsReady = false
async function ensureEvents() {
  if (eventsReady) return
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_ai_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id INT UNSIGNED NOT NULL,
    kind VARCHAR(12) NOT NULL,
    phase VARCHAR(40) NULL,
    detail VARCHAR(200) NULL,
    created_at DATETIME(3) NOT NULL,
    KEY whatsapp_ai_events_account (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  eventsReady = true
}

export async function recordAiEvent(accountId: number, kind: AiEventKind, phase = '', detail = '') {
  await ensureEvents()
  await db.table('whatsapp_ai_events').insert({
    account_id: accountId,
    kind,
    phase: phase.slice(0, 40) || null,
    detail: detail.slice(0, 200) || null,
    created_at: new Date(),
  })
  // Simpan jejak terbaru saja.
  if (Math.random() < 0.02)
    await db.rawQuery(
      'DELETE FROM whatsapp_ai_events WHERE id < (SELECT id FROM (SELECT id FROM whatsapp_ai_events ORDER BY id DESC LIMIT 1 OFFSET 500) t)'
    )
}

export async function recentAiEvents(after = 0, limit = 40) {
  await ensureEvents()
  const rows = await db
    .from('whatsapp_ai_events')
    .where('id', '>', after)
    .orderBy('id', 'desc')
    .limit(limit)
  return rows.reverse().map((row: any) => ({
    id: Number(row.id),
    accountId: Number(row.account_id),
    kind: String(row.kind) as AiEventKind,
    phase: String(row.phase || ''),
    detail: String(row.detail || ''),
    at: new Date(row.created_at).getTime(),
  }))
}

/** Akun yang sedang mengerjakan (event start terakhir belum ditutup, < 3 menit). */
export async function busyAiAccounts(now = Date.now()) {
  await ensureEvents()
  const rows = await db
    .from('whatsapp_ai_events')
    .where('created_at', '>', new Date(now - 180_000))
    .orderBy('id', 'asc')
  const open = new Map<number, number>()
  for (const row of rows as any[]) {
    const id = Number(row.account_id)
    if (row.kind === 'start') open.set(id, (open.get(id) || 0) + 1)
    else if (open.get(id)) open.set(id, open.get(id)! - 1)
  }
  return [...open.entries()].filter(([, n]) => n > 0).map(([id]) => id)
}
