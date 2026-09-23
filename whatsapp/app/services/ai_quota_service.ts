import db from '#services/workspace_database'
import env from '#start/env'
import { readSettings } from '#services/settings_service'
import { workspaceScope } from '#services/workspace_context'
import { codexCommand, codexOAuthArguments, codexOAuthEnv } from '#services/workspace_oauth'
import { readCodexQuota } from '#services/codex_quota_reader'
import { codexQuotaWindows, quotaPresentation } from '#services/ai_quota_contract'
import { quotaState, storedQuotaWindows, saveQuotaWindows } from '#services/ai_quota_store'
import { aiProviderOf, providerLimit } from '#services/ai_provider_failover'

/** Shared DB cooldown prevents a CLI process per browser poll or WEB replica. */
export async function readAccountQuotas(fetchCodex: typeof readCodexQuota = readCodexQuota) {
  if (!workspaceScope().id) return { providers: [] }
  let chatgpt = await quotaState('chatgpt')
  const now = Date.now()
  if (now - Number(chatgpt.checked_at) >= 60_000) {
    const claimed = await db
      .from('whatsapp_ai_quota')
      .where({
        provider: 'chatgpt',
        generation: chatgpt.generation,
        checked_at: chatgpt.checked_at,
      })
      .update({ checked_at: now })
    if (claimed) {
      try {
        const settings = await readSettings()
        const raw = await fetchCodex(
          codexCommand(settings.codexBin || env.get('CODEX_BIN')),
          codexOAuthArguments(),
          codexOAuthEnv()
        )
        await saveQuotaWindows('chatgpt', chatgpt.generation, codexQuotaWindows(raw), true)
      } catch {
        await db
          .from('whatsapp_ai_quota')
          .where({ provider: 'chatgpt', generation: chatgpt.generation })
          .update({ failed: true })
      }
      chatgpt = await quotaState('chatgpt')
    }
  }
  const claude = await quotaState('claude')
  const settings = await readSettings()
  const limits = Object.fromEntries(
    await Promise.all(
      (['chatgpt', 'claude'] as const).map(async (name) => [name, await providerLimit(name)])
    )
  )
  return {
    configuredProvider: aiProviderOf(settings.aiProvider),
    failoverEnabled: settings.aiFailover,
    providers: [chatgpt, claude].map((row) => ({
      provider: row.provider,
      source: row.provider === 'claude' ? 'response' : 'account',
      refreshFailed: Boolean(row.failed),
      // Recorded refusals outlive a single turn so the fallback engine is not re-tried blindly.
      limitedUntil: limits[row.provider]?.until ?? null,
      limitedCode: limits[row.provider]?.code ?? '',
      windows: quotaPresentation(storedQuotaWindows(row)).map((window) => ({
        ...window,
        stale: window.stale || Boolean(row.failed),
      })),
    })),
  }
}
