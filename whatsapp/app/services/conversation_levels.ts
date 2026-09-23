import { createHash } from 'node:crypto'
import type { GoalPlan } from '#services/goal_contract'

/** Numeric indices select context, never authorize a transaction or replace meaning. */
export const INTENT_INDEX = {
  0: 'unknown',
  1: 'ack',
  2: 'catalog',
  3: 'sizing',
  4: 'custom',
  5: 'cart',
  6: 'payment',
  7: 'shipping',
  8: 'service',
  9: 'visual',
} as const
export type IntentIndex = keyof typeof INTENT_INDEX
export type ProcessingLevel = 0 | 1 | 2 | 3 | 4
export const LEVEL_LIMITS = {
  local: { modelCalls: 0, mutations: 0, currentMessages: 1, checkpointHours: 24 },
  active: { initialMemoryFacts: 12, mandatoryRules: 'always', unknown: 'escalate' },
  domain: { identicalResults: 4, cache: 'existing_exact_key_ttl', writesCached: false },
  retrieval: { messagesPerRead: 20, memoryFactsPerRead: 16, crossRoom: false },
  full: { policyFallbacks: 1, analysisRetries: 2, usefulEvidenceHardCutoff: false },
} as const

export const normalizeIntentText = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
export const levelDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const levelPolicyHash = (skills: Array<{ name: string; content: string }>) =>
  levelDigest(skills)

// Unknown accents/wording fall through to the semantic model, never a guessed local action.
export function isPlainAcknowledgment(text: string) {
  return /^(?:(?:iya|ya|oke|ok|baik|siap)(?: (?:siap|makasih|terima kasih))?|terima kasih|makasih|thanks|thank you)(?: (?:bos|kak|pak|bu))?[.!]?$/.test(
    normalizeIntentText(text)
  )
}
const TOPICS: Partial<Record<IntentIndex, RegExp>> = {
  2: /\b(harga|price|stok|stock|produk|product|katalog|catalog|jas|suit|celana|pants|rompi|bahan)\b/,
  3: /\b(size|ukuran|fit|tinggi|berat|lingkar|tb|bb|slim|regular)\b|\b\d{3}\s*\/\s*\d{2,3}\b/,
  4: /\b(custom|kustom|warna|color|lapel|kerah|modifikasi|jahit|model)\b/,
  5: /\b(cart|keranjang|order|pesanan|pesan|checkout|beli|jumlah|qty|rekap|diskon|batal|cancel)\b/,
  6: /\b(bayar|payment|pembayaran|transfer|rekening|dp|lunas|pelunasan|saldo|dana|refund|invoice)\b/,
  7: /\b(kirim|pengiriman|shipping|ongkir|alamat|kecamatan|kurir|resi|awb|tracking|ekspedisi|tiba)\b/,
  8: /\b(komplain|complaint|retur|tukar|rusak|keluhan|refund)\b/,
  9: /\b(foto|photo|gambar|image|visual|referensi)\b/,
}
export function intentIndices(text: string): IntentIndex[] {
  const normalized = normalizeIntentText(text).replace(/\b(\p{L}+)nya\b/gu, '$1')
  return Object.entries(TOPICS)
    .filter(([, pattern]) => pattern!.test(normalized))
    .map(([id]) => Number(id) as IntentIndex)
}

export type LevelCheckpoint = {
  v: 1
  sourceId: string
  sourceDigest: string
  anchorId: number
  cartVersion: string
  policyHash: string
  savedAt: number
  goal: GoalPlan
}
export type ActiveConversationState = {
  currentMessageCount: number
  currentText: string
  hasMedia: boolean
  hasQuote: boolean
  cartVersion: string
  cartItems: number
  orderCount: number
  pendingMemory: boolean
  lastMessageId: string
  lastMessageDigest: string
  lastSender: string
  previousExternalId: number
  lastQuestion: string
  waitingFor: string
  checkpoint: LevelCheckpoint | null
}
export function makeLevelCheckpoint(input: {
  decision: {
    decision: string
    message: string
    initiative?: string
    cartIntent?: unknown
    approvalWait?: unknown
  }
  goal: GoalPlan | null
  source: any
  anchorId: number
  cartVersion: string
  policyHash: string
}): LevelCheckpoint | null {
  const { decision, goal, source } = input
  const closing = /^(?:sama[ -]sama|terima kasih|makasih)(?: (?:bos|kak|pak|bu))?[.!]?$/.test(
    normalizeIntentText(decision.message)
  )
  if (
    decision.decision !== 'reply' ||
    !decision.message ||
    decision.initiative ||
    !closing ||
    decision.cartIntent ||
    decision.approvalWait ||
    goal?.status !== 'completed' ||
    goal.stage !== 'closed' ||
    goal.waiting_for ||
    goal.next_action ||
    goal.follow_up ||
    !source ||
    source.direction !== 'out' ||
    source.sender_type !== 'ai' ||
    ['failed', 'queued'].includes(source.status) ||
    source.media_type ||
    /[?？]/.test(decision.message) ||
    String(source.body || '') !== decision.message
  )
    return null
  return {
    v: 1,
    sourceId: source.message_id,
    sourceDigest: levelDigest(source.body),
    anchorId: input.anchorId,
    cartVersion: input.cartVersion,
    policyHash: input.policyHash,
    savedAt: Date.now(),
    goal,
  }
}
export function readLevelCheckpoint(value: unknown): LevelCheckpoint | null {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value
    if (
      !data ||
      data.v !== 1 ||
      typeof data.sourceId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.sourceDigest) ||
      !/^[a-f0-9]{64}$/.test(data.policyHash) ||
      !Number.isSafeInteger(data.anchorId) ||
      !Number.isFinite(data.savedAt) ||
      typeof data.cartVersion !== 'string' ||
      data.goal?.status !== 'completed' ||
      data.goal.stage !== 'closed' ||
      data.goal.waiting_for !== '' ||
      data.goal.next_action !== '' ||
      data.goal.follow_up !== null
    )
      return null
    return data
  } catch {
    return null
  }
}

export function localAckGoal(
  state: ActiveConversationState | undefined,
  text: string,
  policyHash: string,
  hasVisual: boolean,
  now = Date.now()
): GoalPlan | null {
  const checkpoint = state?.checkpoint
  if (
    !state ||
    !checkpoint ||
    !isPlainAcknowledgment(text) ||
    hasVisual ||
    state.hasMedia ||
    state.hasQuote ||
    state.currentMessageCount !== 1 ||
    state.currentText !== text ||
    state.cartItems ||
    state.orderCount ||
    state.pendingMemory ||
    state.lastSender !== 'ai' ||
    state.lastMessageId !== checkpoint.sourceId ||
    state.lastMessageDigest !== checkpoint.sourceDigest ||
    state.previousExternalId !== checkpoint.anchorId ||
    state.cartVersion !== checkpoint.cartVersion ||
    checkpoint.policyHash !== policyHash ||
    now < checkpoint.savedAt ||
    now - checkpoint.savedAt > 24 * 3_600_000
  )
    return null
  return checkpoint.goal
}

export function planConversationLevel(
  text: string,
  state?: ActiveConversationState,
  hasVisual = false,
  policyHash = ''
) {
  const localGoal = localAckGoal(state, text, policyHash, hasVisual)
  const direct = intentIndices(text)
  const short = normalizeIntentText(text).split(' ').length <= 8
  const contextual = short
    ? intentIndices(`${state?.lastQuestion || ''} ${state?.waitingFor || ''}`)
    : []
  // Unknown wording does not imply missing business policy when a cart question
  // is already active. The model still interprets the original reply and state;
  // this hint never fills a recipient, approves checkout or changes the cart.
  const activeCartQuestion = Boolean(
    short &&
    state?.currentText === text &&
    state.currentMessageCount > 0 &&
    state.cartItems > 0 &&
    state.lastQuestion.trim() &&
    state.waitingFor.trim()
  )
  const indices = [
    ...new Set<IntentIndex>([
      ...(isPlainAcknowledgment(text) ? [1 as const] : []),
      ...direct,
      ...contextual,
      ...(activeCartQuestion ? [5 as const] : []),
      ...(hasVisual ? [9 as const] : []),
    ]),
  ]
  if (!indices.length) indices.push(0)
  const retrieve =
    Boolean(state?.hasQuote) ||
    /\b(kemarin|sebelumnya|tadi|dulu|yang itu|seperti itu|sama seperti)\b/.test(
      normalizeIntentText(text)
    )
  const unknown = indices.every((index) => index === 0 || index === 1)
  const level: ProcessingLevel = localGoal
    ? 0
    : unknown
      ? 4
      : retrieve
        ? 3
        : direct.length || hasVisual
          ? 2
          : 1
  return {
    level,
    indices,
    localGoal,
    retrieve,
    reason: localGoal
      ? 'ack_after_verified_closure'
      : unknown
        ? 'meaning_requires_full_context'
        : retrieve
          ? 'original_reference_needed'
          : level === 1
            ? 'answer_to_active_question'
            : 'business_evidence_if_needed',
  }
}

export function levelInstructions(plan: ReturnType<typeof planConversationLevel>, compact = false) {
  return `L=${plan.level}; I=${plan.indices.join(',')}. I:0=ambigu,1=ack,2=katalog,3=ukuran,4=custom,5=cart,6=bayar,7=kirim,8=layanan,9=visual.
L:1=state,2=domain,3=riwayat/memori,4=${compact ? 'aturan tambahan terarah, bukan muat semua' : 'aturan lengkap'}. Indeks bukan otorisasi. Gunakan maksud asli; naik level bila bukti kurang. Rujukan/konflik: baca sumber tersimpan sebelum bertanya ulang. Skill, validasi dan inisiatif tetap berlaku; batas konteks awal tidak menghapus kebutuhan.`
}
