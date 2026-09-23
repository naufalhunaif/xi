import type { TraceSink } from '#services/trace_service'
import {
  LEVEL_LIMITS,
  type ProcessingLevel,
  type planConversationLevel,
} from '#services/conversation_levels'

/** Observe actual escalation as well as the initial plan; no extra model calls. */
export function conversationLevelTrace(
  plan: ReturnType<typeof planConversationLevel>,
  sink?: TraceSink
) {
  let highestLevel = plan.level
  let modelRuns = 0
  let toolCalls = 0
  let cacheHits = 0
  let cacheMisses = 0
  let cacheBypasses = 0
  const providerUsage = new Map<string, { input: number; cached: number }>()
  let retrievalReads = 0
  const seen = new Set<string>()
  const runningPhases = new Set<string>()
  const enter = (level: ProcessingLevel, reason: string) => {
    if (level <= highestLevel) return
    highestLevel = level
    sink?.({
      key: `level-${level}`,
      label: `Naik ke level ${level}`,
      status: 'completed',
      detail: { level, reason },
    })
  }
  sink?.({
    key: 'conversation-level',
    label: `Level ${plan.level} · pemetaan kebutuhan`,
    status: 'completed',
    detail: {
      version: 'beta-levels-v2',
      initialLevel: plan.level,
      indices: plan.indices,
      reason: plan.reason,
      localResolution: Boolean(plan.localGoal),
      limits: LEVEL_LIMITS,
    },
  })
  const emit: TraceSink = (event) => {
    const detail = event.detail as any
    if (event.status !== 'running' && detail?.usage) {
      const valid = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
      providerUsage.set(event.key, {
        input: valid(detail.usage.input),
        cached: valid(detail.usage.cached),
      })
    }
    if (
      /(?:^|:)(index-analysis|analysis|comparison|visual-recheck|business-recheck-run)$/.test(
        event.key
      )
    ) {
      if (event.status === 'running' && !runningPhases.has(event.key)) {
        runningPhases.add(event.key)
        modelRuns++
      } else if (event.status !== 'running') {
        runningPhases.delete(event.key)
      }
    }
    if (event.key === 'skill-routing-fallback') enter(4, 'unread_policy_required')
    if (event.key === 'index-escalation')
      enter(detail?.level === 2 ? 2 : 4, 'index_requires_more_context')
    const attemptKey = `${modelRuns}:${event.key}`
    if (
      event.key.includes(':mcp-cache:') &&
      event.status === 'completed' &&
      !seen.has(attemptKey)
    ) {
      seen.add(attemptKey)
      if (detail?.cache?.source === 'cache') cacheHits++
      else if (detail?.cache?.status === 'miss' || detail?.cache?.status === 'expired')
        cacheMisses++
      else if (detail?.cache?.status === 'bypass' && detail?.modelVisible !== true) cacheBypasses++
      // Deferred gateway already reports the model's invocation; its app-side
      // upstream read is evidence/cache telemetry, not another model tool round.
      if (detail?.modelVisible === false) {
        sink?.(event)
        return
      }
      toolCalls++
      if (['read_conversation_history', 'read_customer_memory'].includes(detail?.tool)) {
        retrievalReads++
        enter(3, 'original_customer_evidence')
      } else if (detail?.tool === 'read_business_skill') {
        if (detail?.arguments?.all === true) enter(4, 'full_policy_requested')
      } else enter(2, detail?.cache?.source === 'cache' ? 'domain_cache' : 'live_business_evidence')
    }
    sink?.(event)
  }
  return {
    emit,
    finish(status: 'completed' | 'failed') {
      const providerInputTokens = [...providerUsage.values()].reduce(
        (sum, value) => sum + value.input,
        0
      )
      const providerCachedInputTokens = [...providerUsage.values()].reduce(
        (sum, value) => sum + value.cached,
        0
      )
      sink?.({
        key: 'level-summary',
        label: providerCachedInputTokens
          ? `Ringkasan level · ${providerCachedInputTokens.toLocaleString('id-ID')} token input dari cache provider`
          : 'Ringkasan level pemrosesan',
        status,
        detail: {
          initialLevel: plan.level,
          highestLevel,
          modelRuns,
          toolCalls,
          cacheHits,
          cacheMisses,
          cacheBypasses,
          providerInputTokens,
          providerCachedInputTokens,
          retrievalReads,
          modelSkipped: status === 'completed' && modelRuns === 0,
          note: 'modelRuns=percobaan fase, bukan putaran API. cacheHits=hasil MCP; providerCachedInputTokens=cache input provider yang tetap termasuk input. Cache bukan balasan AI tersimpan.',
        },
      })
    },
  }
}
