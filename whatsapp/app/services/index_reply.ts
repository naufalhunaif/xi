import type { AiDecision } from '#services/ai_service'
import { TASK_SYSTEM_PROMPT } from '#services/ai_task_prompt'
import { CUSTOMER_SCOPE_INSTRUCTIONS } from '#services/customer_scope_service'
import { parseGoal } from '#services/goal_contract'
import { CONVERSATION_PROGRESS_INSTRUCTIONS } from '#services/semantic_intent_contract'
import { importedSkillInstructions } from '#services/skill_runtime_service'
import type { CompactSkillPlan } from '#services/compact_reply_policy'
import { planSkillRouting, type RoutingContext } from '#services/skill_routing_service'
import {
  intentIndices,
  levelDigest,
  levelPolicyHash,
  type IntentIndex,
} from '#services/conversation_levels'

// Includes the system prompt and output schema. Never truncate rules or customer evidence to fit.
export const INDEX_INPUT_CHARACTER_LIMIT = 100_000
const string = { type: 'string' } as const
export const INDEX_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['reply', 'silent', 'escalate'] },
    indices: { type: 'array', items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } },
    needsFullSkillContext: { type: 'boolean' },
    message: string,
    initiative: string,
    reason: string,
    goal: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: string,
        stage: { type: 'string', enum: ['discovery', 'closed'] },
        status: { type: 'string', enum: ['waiting_answer', 'completed'] },
        current_task: string,
        waiting_for: string,
        next_action: string,
        follow_up: { type: 'null' },
      },
      required: [
        'objective',
        'stage',
        'status',
        'current_task',
        'waiting_for',
        'next_action',
        'follow_up',
      ],
    },
  },
  required: [
    'decision',
    'indices',
    'needsFullSkillContext',
    'message',
    'initiative',
    'reason',
    'goal',
  ],
} as const

export function indexReplyEligible(
  context: RoutingContext | undefined,
  text: string,
  hasVisual = false
) {
  const state = context?.activeState
  return Boolean(
    state &&
    context?.indexContext &&
    text.trim() &&
    text.length <= 1000 &&
    state.currentText === text &&
    state.currentMessageCount > 0 &&
    !hasVisual &&
    !state.hasMedia &&
    !state.hasQuote &&
    !state.cartItems &&
    !state.orderCount &&
    !state.pendingMemory &&
    !context?.hasCart &&
    // A reply to prior CS context can select an option without any domain word
    // ("yang coco bagus", "the second one", "iku wae"). Never let the social-only
    // schema, which cannot preserve a selection, close this exchange.
    !state.lastQuestion.trim() &&
    !state.waitingFor.trim() &&
    !context?.lastQuestion?.trim() &&
    !context?.waitingFor?.trim() &&
    !intentIndices(`${text}\n${state.lastQuestion}\n${state.waitingFor}`).length &&
    !/\b(kemarin|sebelumnya|tadi|dulu|yang itu|seperti itu|sama seperti)\b/i.test(text)
  )
}

const INSTRUCTIONS = `LEVEL INDEX — BALASAN RINGAN, BUKAN TRANSAKSI.
Pahami maksud seluruh pesan dan konteks, termasuk bahasa informal, typo, aksen tertulis dan jawaban singkat. Indeks kata aplikasi hanya petunjuk; kebutuhan bisnis dapat ada walau tidak ada kata baku.
I:0=belum jelas,1=sapaan/penerimaan,2=katalog,3=ukuran,4=custom,5=cart,6=bayar,7=kirim,8=layanan,9=visual.
Di fase ini hanya sapaan/penerimaan sosial atau pertanyaan pembuka umum yang tidak membutuhkan fakta/tindakan bisnis. Aturan umum pada paket tetap berlaku. Aturan kurang jelas atau kebutuhan domain harus escalate karena tidak boleh menjalankan keputusan domain di sini.
Jika ini jawaban untuk pilihan, perubahan, keluhan, permintaan data, rujukan lama, butuh memori baru, handoff, media, penjadwalan atau skill yang belum dibaca: decision=escalate, kosongkan message/initiative, isi indices sesuai maksud. Jangan menyelesaikan kebutuhan bisnis dengan sapaan atau diam. needsFullSkillContext=true bila maksud/aturan masih belum pasti; aplikasi meneruskan teks dan bukti asli ke jalur lengkap. Tidak ada tool di fase ini.
Jangan menyebut harga, stok, ukuran, estimasi, kemampuan custom, dana, status order atau menjanjikan tindakan. Jangan mengarang bukti atau mengubah fakta/catatan. Jangan membalas pesan internal yang diabaikan menurut batas topik.
Ikuti gaya dan prioritas skill. Pada pembuka tanpa kebutuhan, ajukan paling banyak satu pertanyaan berguna sesuai skill; setelah bertanya goal.stage=discovery/status=waiting_answer, waiting_for sesuai pertanyaan. Jika benar-benar selesai, stage=closed/status=completed dan waiting_for/next_action kosong. follow_up selalu null; kebutuhan susulan harus escalate. Silent hanya bila tidak meninggalkan kebutuhan yang belum dijawab. Keluarkan JSON sesuai skema; tanpa penalaran internal.`

/** The same original skill snapshot remains available to the main path on escalation. */
export function planIndexReply(
  skills: Array<{ name: string; content: string }>,
  context: RoutingContext | undefined,
  text: string,
  hasVisual = false,
  compact?: CompactSkillPlan | null
) {
  if (!indexReplyEligible(context, text, hasVisual)) return null
  const policy = compact || planSkillRouting(skills, '', undefined, false, false, [], true)
  const prompt = [
    INSTRUCTIONS,
    compact
      ? `KEBIJAKAN TERKOMPILASI INDEX\n${policy.skills.map((skill) => skill.content).join('\n\n')}`
      : importedSkillInstructions(policy.skills),
    CUSTOMER_SCOPE_INSTRUCTIONS,
    compact ? '' : CONVERSATION_PROGRESS_INSTRUCTIONS,
    context!.indexContext,
    `PESAN ASLI GILIRAN INI:\n${text}`,
  ].join('\n\n')
  const characters =
    prompt.length + JSON.stringify(INDEX_REPLY_SCHEMA).length + TASK_SYSTEM_PROMPT.length
  if (characters > (compact ? 24_000 : INDEX_INPUT_CHARACTER_LIMIT)) return null
  return { prompt, characters, policy, stateDigest: levelDigest(context!.activeState) }
}

/** Strict allowlist: no raw-text recovery and no model-supplied business effects. */
export function readIndexReply(
  output: string,
  plan: NonNullable<ReturnType<typeof planIndexReply>>,
  skills: Array<{ name: string; content: string }>
) {
  const fallback = { decision: null, indices: [] as IntentIndex[], full: true }
  try {
    const value = JSON.parse(output)
    const keys = Object.keys(INDEX_REPLY_SCHEMA.properties)
    if (
      !value ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !(key in value)) ||
      !['reply', 'silent', 'escalate'].includes(value.decision) ||
      typeof value.needsFullSkillContext !== 'boolean' ||
      !['message', 'initiative', 'reason'].every((key) => typeof value[key] === 'string') ||
      !Array.isArray(value.indices) ||
      !value.indices.length ||
      value.indices.length > 10 ||
      !value.indices.every(
        (index: unknown) => Number.isInteger(index) && Number(index) >= 0 && Number(index) <= 9
      )
    )
      return fallback
    const indices = value.indices as IntentIndex[]
    if (
      value.decision === 'escalate' ||
      value.needsFullSkillContext ||
      indices.some((index) => index >= 2)
    )
      return {
        decision: null,
        indices,
        full: value.needsFullSkillContext || !indices.some((index) => index >= 2),
      }
    if (indices.includes(0) || value.message.length + value.initiative.length > 1500)
      return fallback
    const goalKeys = Object.keys(INDEX_REPLY_SCHEMA.properties.goal.properties)
    if (
      !value.goal ||
      Object.keys(value.goal).length !== goalKeys.length ||
      goalKeys.some((key) => !(key in value.goal)) ||
      value.goal.follow_up !== null ||
      !['discovery', 'closed'].includes(value.goal.stage) ||
      !['waiting_answer', 'completed'].includes(value.goal.status) ||
      !['objective', 'current_task', 'waiting_for', 'next_action'].every(
        (key) => typeof value.goal[key] === 'string'
      )
    )
      return fallback
    const customerText = `${value.message}\n${value.initiative}`
    // Conservative output checks supplement the semantic escalation decision, never authorize data.
    if (
      intentIndices(customerText).length ||
      /\p{N}|https?:|\b(ready|selesai diproses|sudah dikirim|sudah masuk|diskon|promo|lunas|approved|paid|sent|available)\b/iu.test(
        customerText
      )
    )
      return fallback
    if (value.decision === 'reply' && !customerText.trim()) return fallback
    if (value.decision === 'silent' && customerText.trim()) return fallback
    if (
      value.goal.stage === 'closed' &&
      (value.goal.status !== 'completed' ||
        value.goal.waiting_for ||
        value.goal.next_action ||
        /[?？]/.test(customerText))
    )
      return fallback
    if (
      value.goal.stage === 'discovery' &&
      (value.goal.status !== 'waiting_answer' || !value.goal.waiting_for)
    )
      return fallback
    plan.policy.phase().assertCovered(JSON.stringify({ ...value, business_lookup_required: false }))
    const decision: AiDecision = {
      decision: value.decision,
      message: value.message.trim(),
      initiative: value.initiative.trim(),
      reason: value.reason.trim(),
      note: '',
      goal: parseGoal(value.goal),
      business_lookup_required: false,
      handoff_category: 'none',
      cartIntent: null,
      images: [],
      businessMedia: [],
      customerMemory: [],
      approvalWait: null,
      indexReply: { stateDigest: plan.stateDigest, policyHash: levelPolicyHash(skills) },
    }
    return { decision, indices, full: false }
  } catch {
    return fallback
  }
}
