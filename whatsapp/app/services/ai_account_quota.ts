// Sisa kuota per akun AI terdaftar. ChatGPT dibaca dari akun (app-server, dibatasi per 2 menit);
// Claude dari laporan limit saat AI berjalan; Gemini tidak melaporkan kuota.
import env from '#start/env'
import { readSettings } from '#services/settings_service'
import { withAiAccount } from '#services/ai_account_context'
import { codexCommand, codexOAuthArguments, codexOAuthEnv } from '#services/workspace_oauth'
import { readCodexQuota } from '#services/codex_quota_reader'
import { codexQuotaWindows, quotaPresentation } from '#services/ai_quota_contract'
import {
  SPREAD_WINDOW_MS,
  aiAccountRef,
  aiTokenUsage,
  listAiAccounts,
  readAiAccountQuota,
  saveAiAccountQuota,
} from '#services/ai_accounts'

const NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' } as const
const lastRead = new Map<number, number>()
const REFRESH_MS = 120_000

export async function readAiAccountQuotas() {
  const accounts = await listAiAccounts()
  const settings = await readSettings()
  const command = codexCommand(settings.codexBin || env.get('CODEX_BIN'))
  const now = Date.now()
  await Promise.all(
    accounts
      .filter((account) => account.provider === 'chatgpt' && account.enabled)
      .filter((account) => now - (lastRead.get(account.id) || 0) >= REFRESH_MS)
      .map(async (account) => {
        lastRead.set(account.id, now)
        try {
          const raw = await withAiAccount(aiAccountRef(account), () =>
            readCodexQuota(command, codexOAuthArguments(), codexOAuthEnv())
          )
          await saveAiAccountQuota(account.id, codexQuotaWindows(raw))
        } catch {
          // Kuota tidak terbaca (belum login / layanan sibuk): tampilkan data terakhir.
        }
      })
  )
  const used = await aiTokenUsage(now - SPREAD_WINDOW_MS).catch(() => new Map<number, number>())
  return Promise.all(
    accounts.map(async (account) => {
      const quota = await readAiAccountQuota(account.id)
      return {
        id: account.id,
        provider: account.provider,
        name: account.label || `${NAMES[account.provider]}${account.legacy ? ' utama' : ` #${account.id}`}`,
        enabled: account.enabled,
        limitedUntil: account.limitedUntil > now ? account.limitedUntil : 0,
        tokens5h: used.get(account.id) || 0,
        observedAt: quota.at,
        windows: quotaPresentation(quota.windows as any),
      }
    })
  )
}
