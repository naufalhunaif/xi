import { importedSkillInstructions } from '#services/skill_runtime_service'
import {
  normalizeIntentText,
  levelPolicyHash,
  levelDigest,
  type ActiveConversationState,
  type IntentIndex,
} from '#services/conversation_levels'
import { workspaceScope } from '#services/workspace_context'
import { PatternPlanCache } from '#services/pattern_plan_cache'
import type { ShippingCartState } from '#services/shipping_evidence_service'
import {
  PATTERN_VERSION,
  PATTERN_IDS,
  validPatternIds,
  patternRoutes,
  patternProcedures,
  patternInstructions,
} from '#services/conversation_patterns'

/** Routing selects initial policy text, never rewrites business rules or customer history. */
export type RoutingContext = {
  /** Full app contracts available on demand to the compact policy; never customer data. */
  runtimeRules?: string
  /** Source context without transaction instructions; never a summary from the index model. */
  indexContext?: string
  lastQuestion?: string
  waitingFor?: string
  hasCart?: boolean
  activeState?: ActiveConversationState
  /** Current server state, used by verification only. Never part of the policy-plan cache. */
  savedCart?: ShippingCartState
}
type Skill = { name: string; content: string }
type Route =
  'catalog' | 'visual' | 'sizing' | 'custom' | 'cart' | 'payment' | 'shipping' | 'service'
type Section = {
  id: string
  skill: number
  title: string
  text: string
  routes: Route[]
  parents: string[]
}

const ROUTES: Record<Route, RegExp> = {
  catalog:
    /\b(katalog|catalog|produk|product|harga|price|stok|stock|model|bahan|material|warna|color|jas|suit|celana|rompi)\b/i,
  visual: /\b(visual|foto|photo|gambar|image|mirip|cocok|referensi|lapel|kancing|saku)\b/i,
  sizing: /\b(ukuran|size|sizing|fit|tinggi|berat|lingkar|badan|tb|bb|slim|regular)\b/i,
  custom: /\b(custom|kustom|jahit|jahitan|modifikasi|pengerjaan|produksi)\b/i,
  cart: /\b(cart|keranjang|order|pesan|pesanan|checkout|beli|jumlah|qty|rekap|diskon|discount|batal|cancel)\b/i,
  payment:
    /\b(bayar|pembayaran|payment|transfer|rekening|dp|lunas|pelunasan|saldo|dana|refund|invoice)\b/i,
  shipping:
    /\b(kirim|pengiriman|shipping|ongkir|alamat|kurir|resi|awb|tracking|ekspedisi|sampai|tiba)\b/i,
  service: /\b(komplain|complaint|retur|tukar|rusak|keluhan|refund)\b/i,
}
const DEPENDENCIES: Record<Route, Route[]> = {
  catalog: ['catalog'],
  visual: ['visual', 'catalog'],
  sizing: ['sizing', 'catalog'],
  custom: ['custom', 'sizing', 'catalog', 'cart'],
  cart: ['cart', 'custom', 'sizing', 'catalog', 'payment', 'shipping'],
  payment: ['payment', 'cart', 'custom', 'catalog', 'shipping'],
  shipping: ['shipping', 'cart', 'custom', 'catalog'],
  service: Object.keys(ROUTES) as Route[],
}
function routesIn(text: string): Route[] {
  const normalized = normalizeIntentText(text).replace(/\b(\p{L}+)nya\b/giu, '$1')
  return (Object.keys(ROUTES) as Route[]).filter((route) => ROUTES[route].test(normalized))
}
function expand(routes: Route[]) {
  return new Set(routes.flatMap((route) => DEPENDENCIES[route]))
}

// Only recognised modular skills can be deferred wholesale. Unknown imports remain core.
const MODULES: Record<string, Route[]> = {
  'cs-detail-visual': ['visual'],
  'cs-chameleon-media': ['visual', 'catalog'],
}
const INDEX_MODULES: Record<string, Route[]> = {
  ...MODULES,
  'cs-cart-order': ['cart'],
  'cs-chameleon-eval': ['service'],
  'waiting-notices': ['custom'],
}
const INDEX_SECTIONED = new Set(['cs-chameleon-batas', 'cs-chameleon-konteks', 'cs-format-jawaban'])
const BUNDLES = /^(?:chameleon-cs-gabungan(?:-\d+)?|cs-chameleon-cloth)$/
const CORE =
  /\b(umum|global|general|wajib|larangan|batas|prinsip|prioritas|keamanan|otorisasi|kewenangan|handoff|format|konteks|identity|identitas|persona)\b/i

/** Lossless chunks, with fenced code left intact and ancestor policy included. */
function sectionsFor(skill: Skill, index: number, indexOnly = false): Section[] {
  const module = (indexOnly ? INDEX_MODULES : MODULES)[skill.name]
  if (!BUNDLES.test(skill.name) && !(indexOnly && INDEX_SECTIONED.has(skill.name)))
    return [
      {
        id: `${index}:0`,
        skill: index,
        title: skill.name,
        text: skill.content,
        routes: module || [],
        parents: [],
      },
    ]
  const result: Section[] = []
  let fence = ''
  let start = 0
  let offset = 0
  let title = skill.name
  let routes: Route[] = []
  let parents: string[] = []
  const stack: Array<{ level: number; id: string; routes: Route[] }> = []
  const push = (end: number) => {
    if (end > start)
      result.push({
        id: `${index}:${result.length}`,
        skill: index,
        title,
        text: skill.content.slice(start, end),
        routes,
        parents: [...parents],
      })
    start = end
  }
  for (const line of skill.content.split(/(?<=\n)/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        /^\s*$/.test(line.slice(marker[0].length))
      )
        fence = ''
    }
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      push(offset)
      while (stack.length && stack[stack.length - 1].level >= heading[1].length) stack.pop()
      title = heading[2]
      const direct = routesIn(title)
      routes = CORE.test(title) ? [] : direct.length ? direct : stack.at(-1)?.routes || []
      parents = stack.map((entry) => entry.id)
      stack.push({ level: heading[1].length, id: `${index}:${result.length}`, routes })
    }
    offset += line.length
  }
  push(skill.content.length)
  return result
}

export class SkillContextIncomplete extends Error {
  constructor() {
    super('Keputusan membutuhkan bagian skill yang belum dimuat.')
  }
}

function routingShape(
  text: string,
  context: RoutingContext | undefined,
  hasVisual: boolean,
  forceFull: boolean,
  initialIndices: IntentIndex[],
  indexOnly: boolean
) {
  const indexRoutes: Partial<Record<IntentIndex, Route>> = {
    2: 'catalog',
    3: 'sizing',
    4: 'custom',
    5: 'cart',
    6: 'payment',
    7: 'shipping',
    8: 'service',
    9: 'visual',
  }
  const direct = [
    ...routesIn(text),
    ...initialIndices.flatMap((id) => (indexRoutes[id] ? [indexRoutes[id]!] : [])),
  ]
  const contextual =
    text.trim().split(/\s+/).length <= 8
      ? routesIn(`${context?.lastQuestion || ''} ${context?.waitingFor || ''}`)
      : []
  const requested = [...direct, ...contextual, ...(hasVisual ? ['visual' as const] : [])]
  const fallback = forceFull || (!indexOnly && requested.length === 0)
  if (context?.hasCart) requested.push('cart')
  return { fallback, routes: [...expand(requested)].sort() }
}

const patternCache = new PatternPlanCache<ReturnType<typeof buildSkillPlan>>()

export function planSkillRouting(
  skills: Skill[],
  text: string,
  context?: RoutingContext,
  hasVisual = false,
  forceFull = false,
  initialIndices: IntentIndex[] = [],
  indexOnly = false,
  patterns = false
) {
  const shape = routingShape(text, context, hasVisual, forceFull, initialIndices, indexOnly)
  if (!patterns || indexOnly) return buildSkillPlan(skills, shape, indexOnly, false)
  // Only policy and route shape are cached. No text, room, state values, facts or approvals.
  const scope = workspaceScope()
  const policyHash = levelPolicyHash(skills)
  const key = levelDigest([
    PATTERN_VERSION,
    scope.id,
    scope.prefix,
    scope.version,
    policyHash,
    shape,
  ])
  const cached = patternCache.read(key, () => buildSkillPlan(skills, shape, false, true))
  const plan = cached.value
  return {
    ...plan,
    skills: plan.skills.map((skill) => ({ ...skill })),
    detail: {
      ...structuredClone(plan.detail),
      patternCache: {
        status: cached.status,
        version: PATTERN_VERSION,
        key: key.slice(0, 16),
        policyHash: policyHash.slice(0, 16),
        scope: 'workspace_policy',
        customerDataCached: false,
      },
    },
  }
}

function buildSkillPlan(
  skills: Skill[],
  shape: ReturnType<typeof routingShape>,
  indexOnly: boolean,
  patterns: boolean
) {
  // Snapshot prevents edits/other rooms from changing a turn's policy library.
  const snapshot = skills.map((skill) => ({ ...skill }))
  const sections = snapshot.flatMap((skill, index) =>
    sectionsFor(skill, index, indexOnly || patterns)
  )
  // Short public IDs; retain the original hierarchy while assigning turn-local indices.
  const aliases = new Map(sections.map((section, i) => [section.id, String(i + 1)]))
  for (const section of sections) {
    section.parents = section.parents.map((id) => aliases.get(id)!)
    section.id = aliases.get(section.id)!
  }
  const { fallback } = shape
  const routes = new Set(shape.routes)
  const selected = new Set(
    sections
      .filter(
        (section) =>
          fallback ||
          !section.routes.length ||
          // Cart follow-ups can schedule from the main policy. Keep that source
          // complete without also loading unrelated standalone visual modules.
          (patterns && routes.has('cart') && BUNDLES.test(snapshot[section.skill].name)) ||
          section.routes.some((route) => routes.has(route))
      )
      .map((section) => section.id)
  )
  const includeParents = (ids: Set<string>) => {
    for (const section of sections)
      if (ids.has(section.id)) for (const parent of section.parents) ids.add(parent)
  }
  includeParents(selected)
  const deferred = sections.filter((section) => !selected.has(section.id))
  const selectedSkills = snapshot
    .map((skill, index) => ({
      ...skill,
      content: sections
        .filter((section) => section.skill === index && selected.has(section.id))
        .map((section) => section.text)
        .join(''),
    }))
    .filter((skill) => skill.content.length)
  const instructions = deferred.length
    ? [
        'PETA SKILL: aturan umum dan bagian relevan dimuat di atas. Bagian tertunda tetap berlaku; ini pemilihan konteks awal, bukan izin mengabaikan aturan. Sebelum menjawab topik lain, membuat inisiatif, atau jika ada rujukan/keraguan, baca bagian terkait melalui business_skill_library.read_business_skill (sectionIds). Untuk seluruh aturan gunakan all=true. Gunakan isi asli; jangan menebak kebijakan dari judul. Jika konteks tetap kurang, keluarkan needsFullSkillContext=true; runtime akan memuat seluruh skill sebelum mengirim jawaban. Tool ini hanya sumber aturan, BUKAN bukti harga/stok/pembayaran MCP.',
        'INDEX [id,judul] per skill; baca sectionIds. BAGIAN TERSEDIA: ' +
          JSON.stringify(
            Object.fromEntries(
              snapshot
                .map((skill, index) => [
                  skill.name,
                  deferred
                    .filter((section) => section.skill === index)
                    .map((section) => [section.id, section.title]),
                ])
                .filter(([, entries]) => entries.length)
            )
          ),
      ].join('\n')
    : ''
  const patternGuide = patterns ? patternInstructions() : ''
  const routedInstructions = [instructions, patternGuide].filter(Boolean).join('\n\n')
  // Compare the text actually rendered, including exact-duplicate aliases and
  // the routing index. Pattern mode can read missing policy in the same phase,
  // so don't discard a useful 10–20% reduction merely for being below 25%.
  const charsBefore = importedSkillInstructions(snapshot).length
  const candidateChars = [importedSkillInstructions(selectedSkills), routedInstructions]
    .filter(Boolean)
    .join('\n\n').length
  const savingRatio = charsBefore > 0 ? (charsBefore - candidateChars) / charsBefore : 0
  // Conservative policy, not a guarantee about model usage or fallback probability.
  const minimumSavingRatio = indexOnly ? 0 : patterns ? 0.05 : 0.25
  const enabled = deferred.length > 0 && savingRatio >= minimumSavingRatio
  return {
    skills: enabled ? selectedSkills : snapshot,
    instructions: enabled ? routedInstructions : patternGuide,
    detail: {
      routes: [...routes],
      delivery: enabled ? 'routed' : 'full-content',
      reason: fallback
        ? 'ambiguous_input'
        : enabled
          ? 'mapped_sections'
          : deferred.length && savingRatio > 0
            ? 'small_saving_full_context'
            : 'no_safe_saving',
      sectionsSelected: enabled ? selected.size : sections.length,
      sectionsDeferred: enabled ? deferred.length : 0,
      charsBefore,
      charsAfter: enabled
        ? candidateChars
        : charsBefore + (patternGuide ? patternGuide.length + 2 : 0),
      candidateChars,
      minimumSavingRatio,
      candidateSavingPercent: Math.round(savingRatio * 1000) / 10,
      ...(patterns
        ? {
            patternLibrary: PATTERN_VERSION,
            patternCount: PATTERN_IDS.length,
          }
        : {}),
    },
    phase() {
      const delivered = new Set(enabled ? selected : sections.map((section) => section.id))
      return {
        assertCovered(output: string) {
          if (!enabled) return
          let decision: Record<string, any>
          try {
            decision = JSON.parse(output)
          } catch {
            throw new SkillContextIncomplete()
          }
          const needs = routesIn(`${decision.message || ''} ${decision.initiative || ''}`)
          if (decision.cartIntent || decision.checkoutContinuity) needs.push('cart')
          if (
            decision.visualMatch ||
            decision.needsVisualInspection ||
            decision.images?.length ||
            decision.businessMedia?.length
          )
            needs.push('visual')
          if (decision.approvalWait) needs.push('custom', 'sizing')
          if (decision.goal?.status === 'waiting_payment') needs.push('payment')
          // A handoff can conceal a misunderstood need; inspect full rules before holding it.
          const all =
            decision.needsFullSkillContext === true ||
            decision.decision === 'handoff' ||
            decision.goal?.status === 'waiting_approval'
          // A schedule requires its complete cited policy, not every unrelated
          // module (e.g. visual inspection when collecting a recipient name).
          const followUpSkill = decision.goal?.follow_up?.skill_name
          const followUpSource = snapshot.findIndex((skill) => skill.name === followUpSkill)
          if (decision.goal?.follow_up && followUpSource < 0) throw new SkillContextIncomplete()
          const needed = expand(needs)
          if (
            sections.some(
              (section) =>
                !delivered.has(section.id) &&
                (all ||
                  (Boolean(decision.goal?.follow_up) && section.skill === followUpSource) ||
                  section.routes.some((route) => needed.has(route)))
            )
          )
            throw new SkillContextIncomplete()
        },
        tools:
          enabled || patterns
            ? {
                getInstructions: () =>
                  'Baca skill lengkap/section sesuai peta sebelum mengambil keputusan. Snapshot hanya untuk giliran dan workspace ini; bukan bukti data bisnis.',
                getServerCapabilities: () => ({ tools: {} }),
                async listTools() {
                  return {
                    tools: [
                      {
                        name: 'read_business_skill',
                        description:
                          'Baca isi asli skill dan induk section. sectionIds dari peta; all=true untuk seluruh skill jika kebutuhan ambigu.' +
                          (patterns
                            ? ' patternIds memilih prosedur berdasarkan maksud saat ini beserta seluruh aturan terkait; tidak ada fakta pelanggan dari cache.'
                            : ''),
                        inputSchema: {
                          type: 'object' as const,
                          additionalProperties: false,
                          properties: {
                            sectionIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
                            all: { type: 'boolean' },
                            ...(patterns
                              ? {
                                  patternIds: {
                                    type: 'array',
                                    items: { type: 'string', enum: PATTERN_IDS },
                                    minItems: 1,
                                    maxItems: PATTERN_IDS.length,
                                  },
                                }
                              : {}),
                          },
                        },
                        annotations: {
                          readOnlyHint: true,
                          destructiveHint: false,
                          idempotentHint: true,
                        },
                      },
                    ],
                  }
                },
                async callTool(request: { name: string; arguments?: Record<string, unknown> }) {
                  const args = request.arguments || {}
                  if (
                    request.name !== 'read_business_skill' ||
                    Object.keys(args).some(
                      (key) =>
                        !['all', 'sectionIds', ...(patterns ? ['patternIds'] : [])].includes(key)
                    ) ||
                    (args.all !== undefined && typeof args.all !== 'boolean') ||
                    (args.patternIds !== undefined && !validPatternIds(args.patternIds))
                  )
                    throw new Error('Invalid skill request')
                  if (
                    (args.sectionIds !== undefined ||
                      (args.all !== true && args.patternIds === undefined)) &&
                    (!Array.isArray(args.sectionIds) ||
                      !args.sectionIds.length ||
                      !args.sectionIds.every(
                        (id) =>
                          typeof id === 'string' && sections.some((section) => section.id === id)
                      ))
                  )
                    throw new Error('Unknown skill section')
                  const ids = new Set(
                    args.all === true
                      ? sections.map((section) => section.id)
                      : ((args.sectionIds || []) as string[])
                  )
                  const selectedPatterns = validPatternIds(args.patternIds) ? args.patternIds : []
                  const patternNeeds = expand(patternRoutes(selectedPatterns))
                  if (selectedPatterns.length)
                    for (const section of sections)
                      if (
                        !section.routes.length ||
                        section.routes.some((route) => patternNeeds.has(route))
                      )
                        ids.add(section.id)
                  includeParents(ids)
                  const previouslyDelivered = new Set(delivered)
                  for (const id of ids) delivered.add(id)
                  const read = sections
                    .filter(
                      (section) =>
                        ids.has(section.id) &&
                        // Explicit all/section requests still return exact originals. Pattern reads
                        // avoid repeatedly adding already-delivered policy to the model context.
                        (!selectedPatterns.length ||
                          args.all === true ||
                          args.sectionIds !== undefined ||
                          !previouslyDelivered.has(section.id))
                    )
                    .map((section) => ({
                      id: section.id,
                      skill: snapshot[section.skill].name,
                      content: section.text,
                    }))
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: JSON.stringify(
                          selectedPatterns.length
                            ? {
                                version: PATTERN_VERSION,
                                procedures: patternProcedures(selectedPatterns),
                                policy: read,
                                alreadyLoaded: read.length === 0,
                                note: 'Isi variabel dengan bukti percakapan sekarang. Pola bukan data atau persetujuan bisnis. Aturan yang sudah diberikan tetap berlaku.',
                              }
                            : read
                        ),
                      },
                    ],
                  }
                },
                async close() {},
              }
            : undefined,
      }
    },
  }
}
export type SkillRoutingPlan = ReturnType<typeof planSkillRouting>
