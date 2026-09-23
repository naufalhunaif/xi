import { createHash, timingSafeEqual } from 'node:crypto'
import { PATTERN_IDS } from '#services/conversation_patterns'

export type DiagnosticAccess = { tokenHash: string; workspaceId: number; expiresAt: number }
export function diagnosticAuthorized(access: DiagnosticAccess, header = '', now = Date.now()) {
  if (
    !/^[a-f0-9]{64}$/.test(access?.tokenHash || '') ||
    !Number.isSafeInteger(access?.workspaceId) ||
    access.workspaceId < 1 ||
    !Number.isFinite(access.expiresAt) ||
    access.expiresAt <= now
  )
    return false
  const token = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
  if (!token) return false
  return timingSafeEqual(
    Buffer.from(access.tokenHash, 'hex'),
    createHash('sha256').update(token).digest()
  )
}

const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const code = (value: unknown) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined
const name = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,100}$/.test(value) ? value : undefined

// Only fixed application messages become codes. Never expose arbitrary model/customer text.
export function cartDiagnosticCode(value: unknown) {
  const reasons: Record<string, string> = {
    'Referensi persetujuan model tidak valid.': 'MODEL_CONSENT_REFERENCE_INVALID',
    'Detail desain katalog tidak cocok dengan permintaan yang disetujui CS.':
      'CATALOG_DESIGN_MISMATCH_LEGACY',
    'Penempatan warna badan/lapel tidak cocok dengan permintaan yang disetujui CS.':
      'CATALOG_COLOR_PLACEMENT_MISMATCH',
    'Catatan desain katalog memuat detail yang belum cocok dengan permintaan yang disetujui CS.':
      'CATALOG_DESIGN_NOTES_MISMATCH',
    'Permintaan perubahan warna katalog belum jelas.': 'CATALOG_DESIGN_REQUEST_UNCLEAR',
    'Persetujuan model harus berasal dari CS di percakapan pesanan ini.':
      'MODEL_CONSENT_SOURCE_INVALID',
    'Pesan CS belum menyatakan persetujuan model secara jelas.': 'MODEL_CONSENT_NOT_EXPLICIT',
    'Balasan CS mengacu ke pertanyaan lain.': 'MODEL_CONSENT_OTHER_REPLY',
    'Jawaban CS tidak langsung terkait permintaan model.': 'MODEL_CONSENT_CONTEXT_MISMATCH',
    'Jawaban singkat CS perlu merujuk permintaan desain, bukan pertanyaan lain di antaranya.':
      'MODEL_CONSENT_AMBIGUOUS_REPLY',
    'Rincian jawaban CS berbeda atau bersyarat; jangan menganggap seluruh desain disetujui.':
      'MODEL_CONSENT_CONDITIONAL',
    'Bahan katalog tidak cocok dengan permintaan yang disetujui CS.': 'CATALOG_MATERIAL_MISMATCH',
    'Kancing katalog tidak cocok dengan permintaan yang disetujui CS.': 'CATALOG_BUTTONS_MISMATCH',
    'Warna badan yang disebut dalam permintaan belum tersimpan pada detail katalog.':
      'CATALOG_BODY_COLOR_MISSING',
    'Warna lapel yang disebut dalam permintaan belum tersimpan pada detail katalog.':
      'CATALOG_LAPEL_COLOR_MISSING',
    'Bahan yang disebut dalam permintaan belum tersimpan pada detail katalog.':
      'CATALOG_MATERIAL_MISSING',
    'Kancing yang disebut dalam permintaan belum tersimpan pada detail katalog.':
      'CATALOG_BUTTONS_MISSING',
  }
  return typeof value === 'string' && Object.hasOwn(reasons, value) ? reasons[value] : undefined
}

function parsedObject(value: unknown) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Current stored field presence, not a reconstruction of the cart at trace time. */
export function diagnosticCart(itemsJson: unknown, updatedAt: unknown) {
  if (itemsJson === null || itemsJson === undefined) return undefined
  let items: any
  try {
    items = typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson
  } catch {}
  if (!Array.isArray(items)) return { unavailable: true }
  const present = (v: unknown) => typeof v === 'string' && v.trim().length > 0
  return {
    updatedAt: safeDate(updatedAt),
    itemCount: items.length,
    items: items.slice(0, 30).map((item: any, index: number) => ({
      index,
      modelType: ['catalog', 'custom'].includes(item?.modelType) ? item.modelType : 'unknown',
      modelApproval: ['standard', 'pending', 'approved', 'rejected'].includes(item?.modelApproval)
        ? item.modelApproval
        : 'unknown',
      customSize: item?.size === 'custom',
      consentReferencePresent:
        present(item?.modelConsentEvidence?.requestMessageId) &&
        present(item?.modelConsentEvidence?.approvalMessageId),
      designFieldsPresent: ['color', 'lapel', 'material', 'buttons', 'notes'].filter((key) =>
        present(item?.productionDetails?.[key])
      ),
    })),
  }
}

/** Explicit projection, never arbitrary trace detail, customer text, arguments or tool results. */
export function diagnosticStep(event: any) {
  const d = event?.detail || {}
  const selection = d.sourceSelection
  return {
    key: name(event?.key),
    status: ['running', 'completed', 'failed', 'cancelled'].includes(event?.status)
      ? event.status
      : 'unknown',
    startedAt: safeDate(event?.startedAt),
    finishedAt: safeDate(event?.finishedAt),
    durationMs: number(event?.durationMs ?? d.durationMs),
    code: code(d.code ?? d.failure?.code),
    cartValidationCode: event?.key === 'cart' ? cartDiagnosticCode(d.reason ?? d.error) : undefined,
    stage: name(d.stage),
    retryable: typeof d.retryable === 'boolean' ? d.retryable : undefined,
    retry:
      event?.key === 'analysis-retry'
        ? {
            status: name(d.status),
            attempt: number(d.attempt),
            maximum: number(d.maximum),
            nextAttemptAt: safeDate(d.nextAttemptAt),
          }
        : undefined,
    toolCallsInTask: number(d.toolCallsInTask),
    routingTiming:
      event?.key === 'routing-timing'
        ? {
            localModelCalls: number(d.localModelCalls),
            indexEligible: d.indexEligible === true,
            compactEligible: d.compactEligible === true,
            adaptiveEnabled: d.adaptiveEnabled === true,
          }
        : undefined,
    modelSelection: d.modelSelection
      ? {
          model: name(d.modelSelection.model),
          reasoning: name(d.modelSelection.reasoning),
          speed: name(d.modelSelection.speed),
          tier: ['light', 'standard', 'complex'].includes(d.modelSelection.tier)
            ? d.modelSelection.tier
            : undefined,
          adaptive: d.modelSelection.adaptive === true,
          reason: name(d.modelSelection.reason),
        }
      : undefined,
    processingLevel: [
      'conversation-level',
      'index-escalation',
      'level-summary',
      'level-1',
      'level-2',
      'level-3',
      'level-4',
    ].includes(event?.key)
      ? {
          initial: [0, 1, 2, 3, 4].includes(d.initialLevel) ? d.initialLevel : undefined,
          highest: [0, 1, 2, 3, 4].includes(d.highestLevel) ? d.highestLevel : undefined,
          entered: [0, 1, 2, 3, 4].includes(d.level) ? d.level : undefined,
          indices: Array.isArray(d.indices)
            ? d.indices
                .filter((v: unknown) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 9)
                .slice(0, 10)
            : undefined,
          modelRuns: number(d.modelRuns),
          toolCalls: number(d.toolCalls),
          cacheHits: number(d.cacheHits),
          cacheMisses: number(d.cacheMisses),
          cacheBypasses: number(d.cacheBypasses),
          providerInputTokens: number(d.providerInputTokens),
          providerCachedInputTokens: number(d.providerCachedInputTokens),
          retrievalReads: number(d.retrievalReads),
          modelSkipped: typeof d.modelSkipped === 'boolean' ? d.modelSkipped : undefined,
        }
      : undefined,
    schemaFingerprint: name(d.schemaFingerprint),
    provider: ['chatgpt', 'claude'].includes(d.provider) ? d.provider : undefined,
    server: name(d.server),
    tool: name(d.tool),
    patternIds:
      d.tool === 'read_business_skill' && Array.isArray(d.arguments?.patternIds)
        ? [...new Set(d.arguments.patternIds.filter((id: any) => PATTERN_IDS.includes(id)))].slice(
            0,
            PATTERN_IDS.length
          )
        : undefined,
    estimatedTokens: number(d.estimatedTokens ?? d.tokens),
    upstreamEstimatedTokens: number(d.upstreamEstimatedTokens),
    modelVisible: typeof d.modelVisible === 'boolean' ? d.modelVisible : undefined,
    usage: d.usage
      ? {
          input: number(d.usage.input),
          output: number(d.usage.output),
          cached: number(d.usage.cached),
        }
      : undefined,
    runtime: d.runtime
      ? {
          policyVersion: name(d.runtime.policyVersion),
          fingerprint: name(d.runtime.fingerprint),
          workerPid: number(d.runtime.workerPid),
        }
      : undefined,
    routing: d.delivery
      ? {
          delivery: name(d.delivery),
          reason: name(d.reason),
          minimumSavingRatio: number(d.minimumSavingRatio),
          candidateSavingPercent: number(d.candidateSavingPercent),
        }
      : undefined,
    compactPolicy: d.compactPolicy
      ? {
          enabled: d.compactPolicy.enabled === true,
          eligible: d.compactPolicy.eligible === true,
          reason: [
            'reviewed_source_hashes',
            'source_version_not_reviewed',
            'opt_in_disabled',
          ].includes(d.compactPolicy.reason)
            ? d.compactPolicy.reason
            : undefined,
        }
      : undefined,
    compactExpansion:
      event?.key === 'skill-routing-expand'
        ? {
            reason: ['visual_analysis_rules_missing', 'action_contract_missing'].includes(
              d.expansionReason
            )
              ? d.expansionReason
              : undefined,
            fields: Array.isArray(d.fields)
              ? d.fields.filter(
                  (v: unknown) =>
                    typeof v === 'string' &&
                    [
                      'cartIntent',
                      'customSizeQuestion',
                      'checkoutContinuity',
                      'approvalWait',
                      'businessMedia',
                    ].includes(v)
                )
              : [],
            modules: Array.isArray(d.modules)
              ? d.modules.filter((v: unknown) => v === 'Visual')
              : [],
            retry: number(d.retry),
          }
        : undefined,
    patternCache:
      event?.key === 'pattern-cache'
        ? {
            status: ['hit', 'miss'].includes(d.status) ? d.status : undefined,
            version: name(d.version),
            policyHash: /^[a-f0-9]{16}$/.test(d.policyHash || '') ? d.policyHash : undefined,
            patternCount: number(d.patternCount),
            candidateSavingPercent: number(d.candidateSavingPercent),
            customerDataCached: false,
          }
        : undefined,
    selection: selection
      ? {
          importedCount: number(selection.importedCount),
          activeCount: number(selection.activeCount),
          sourceChars: number(selection.sourceChars),
          activeChars: number(selection.activeChars),
          excluded: Array.isArray(selection.excluded)
            ? selection.excluded
                .slice(0, 20)
                .map((item: any) => ({ name: name(item.name), reason: name(item.reason) }))
            : [],
          retainedBundles: Array.isArray(selection.retainedBundles)
            ? selection.retainedBundles.slice(0, 10).map((item: any) => ({
                name: name(item.name),
                reason: name(item.reason),
                missing: Array.isArray(item.missing) ? item.missing.slice(0, 20).map(name) : [],
              }))
            : [],
        }
      : undefined,
    cache: d.cache
      ? {
          status: name(d.cache.status),
          source: name(d.cache.source),
          scope: name(d.cache.scope),
          ageSeconds: number(d.cache.ageSeconds),
          reason: name(d.cache.reason),
        }
      : undefined,
    sections: Array.isArray(d.sections)
      ? d.sections.slice(0, 40).map((item: any) => ({
          key: name(String(item.key || '').replace(/^skill: /, 'skill:')),
          chars: number(item.chars),
          tokens: number(item.tokens),
        }))
      : undefined,
  }
}

export function safeDate(value: unknown) {
  if (!(typeof value === 'string' || value instanceof Date || typeof value === 'number'))
    return undefined
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

export function diagnosticTrace(row: any, now = Date.now()) {
  let steps: any[] = []
  try {
    const parsed = JSON.parse(row.steps_json)
    if (Array.isArray(parsed)) steps = parsed.slice(0, 100)
  } catch {}
  const updatedAt = safeDate(row.updated_at)
  const decision = parsedObject(row.decision_json)
  const recovery = parsedObject(row.recovery_json)
  return {
    id: row.id,
    status: name(row.status),
    createdAt: safeDate(row.created_at),
    updatedAt,
    outcome: ['reply', 'silent', 'handoff'].includes(decision.decision)
      ? decision.decision
      : 'unknown',
    cartValidationCode: cartDiagnosticCode(decision.summary ?? decision.reason),
    replyRecorded: typeof row.message_id === 'string' && row.message_id.length > 0,
    currentCart: diagnosticCart(row.cart_items_json, row.cart_updated_at),
    currentGoal: row.goal_status
      ? {
          status: [
            'active',
            'processing',
            'waiting',
            'waiting_answer',
            'waiting_approval',
            'paused',
            'completed',
            'cancelled',
          ].includes(row.goal_status)
            ? row.goal_status
            : 'unknown',
          updatedAt: safeDate(row.goal_updated_at),
          nextRunAt: safeDate(row.next_run_at),
          recoveryStatus: ['running', 'scheduled', 'blocked', 'exhausted'].includes(recovery.status)
            ? recovery.status
            : 'none',
          attempts: number(recovery.attempts),
          phase: ['analysis', 'delivery'].includes(recovery.phase) ? recovery.phase : undefined,
          technicalRecovered: recovery.technicalRecovered === true,
          catalogWordingRecovered: recovery.catalogWordingRecovered === true,
          catalogNotesRecovered: recovery.catalogNotesRecovered === true,
          handlingMode: ['ai', 'cs'].includes(row.handling_mode) ? row.handling_mode : 'unknown',
          aiExcluded: row.ai_excluded === true || row.ai_excluded === 1,
        }
      : undefined,
    updatesStale:
      row.status === 'running' && Boolean(updatedAt) && now - Date.parse(updatedAt!) > 240_000,
    steps: steps.map(diagnosticStep),
  }
}
