import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { RoutingContext } from '#services/skill_routing_service'
import { SkillContextIncomplete } from '#services/skill_routing_service'
import { importedSkillInstructions } from '#services/skill_runtime_service'
import { catalogColorSearchHints } from '#services/color_semantics'

type Skill = { name: string; content: string }
type Upstream = Pick<Client, 'listTools' | 'callTool' | 'close'>
const ACTION_CONTRACTS = ['cartIntent', 'customSizeQuestion', 'checkoutContinuity', 'approvalWait']
const contractModules = (fields: string[]) => [
  ...(fields.some((field) => ACTION_CONTRACTS.includes(field)) ? ['Transactions'] : []),
  ...(fields.some((field) => ['cartIntent', 'customSizeQuestion', 'approvalWait'].includes(field))
    ? ['Custom']
    : []),
  ...(fields.includes('cartIntent') ? ['Shipping'] : []),
]
export const COMPACT_POLICY_VERSION = 'compact-reply-v11'
export class CompactContextIncomplete extends SkillContextIncomplete {
  constructor(
    public fields: string[],
    public originals = false,
    public modules: string[] = []
  ) {
    super()
  }
}
export function policySourceHash(content: string) {
  return createHash('sha256').update(content.replace(/\r\n?/g, '\n').trim()).digest('hex')
}

// Only reviewed source versions are compiled. A changed/extra/missing owner rule
// must use the original policy; names alone never authorize replacement.
export function matchesCompiledSources(skills: Skill[], hashes: Record<string, string[]>) {
  return (
    skills.length === Object.keys(hashes).length &&
    new Set(skills.map((s) => s.name)).size === skills.length &&
    skills.every((s) => hashes[s.name]?.includes(policySourceHash(s.content)))
  )
}

/** Preserve the entire JSON contract (including enums/required/bounds). Only prose is deferred. */
export function compactReplySchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(compactReplySchema) as T
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => [
        key,
        ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(
          key
        ) &&
        value &&
        typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([name, node]) => [name, compactReplySchema(node)])
            )
          : [
                'items',
                'prefixItems',
                'anyOf',
                'allOf',
                'oneOf',
                'not',
                'if',
                'then',
                'else',
                'additionalProperties',
                'contains',
                'propertyNames',
                'unevaluatedProperties',
              ].includes(key)
            ? compactReplySchema(value)
            : value,
      ])
  ) as T
}

/** Visual input adds its own contract; it must not restore prose for every unrelated field. */
export function replyOutputSchema<
  T extends { properties: Record<string, unknown>; required: readonly string[] },
>(base: T, compact: boolean, visual?: unknown) {
  const schema = compact ? compactReplySchema(base) : base
  return visual
    ? {
        ...schema,
        properties: { ...schema.properties, visualMatch: visual },
        required: [...schema.required, 'visualMatch'],
      }
    : schema
}

/** Structural schema is already in the provider request; retrieve its prose without duplicating it. */
export function replyContractDescriptions(schema: unknown, path = '$'): Record<string, string> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const node = schema as Record<string, any>
  const docs: Record<string, string> =
    typeof node.description === 'string' ? { [path]: node.description } : {}
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
    if (node[key] && typeof node[key] === 'object')
      for (const [name, value] of Object.entries(node[key]))
        Object.assign(docs, replyContractDescriptions(value, `${path}.${key}.${name}`))
  for (const key of [
    'items',
    'prefixItems',
    'anyOf',
    'allOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'additionalProperties',
    'contains',
    'propertyNames',
    'unevaluatedProperties',
  ]) {
    const value = node[key]
    if (Array.isArray(value))
      value.forEach((child, i) =>
        Object.assign(docs, replyContractDescriptions(child, `${path}.${key}[${i}]`))
      )
    else if (value && typeof value === 'object')
      Object.assign(docs, replyContractDescriptions(value, `${path}.${key}`))
  }
  return docs
}

export const COMPACT_RUNTIME = `KONTRAK RUNTIME:
JSON saja sesuai skema. Field nullable yang tidak diperlukan=null, daftar kosong=[], string kosong=''; jangan karang tindakan untuk mengisi skema. business_lookup_required true hanya bila fakta bisnis perlu diperiksa; lookup/cache harus sesuai parameter/sumber. Tidak perlu lookup untuk sapaan atau hanya melengkapi nama/nomor dari fakta room. needsFullSkillContext berarti aturan belum cukup: baca tool kebijakan dahulu. reason maksimal3kalimat dasar bukti/ketidakpastian, bukan reasoning; note keadaan bersumber.
Urutan kerja: state yang tersedia → data bisnis yang menjawab kebutuhan → sumber riwayat/aturan yang masih kurang. Melihat model/harga/foto katalog tidak otomatis membutuhkan kontrak cart/approval atau analisis piksel; images hanya pengiriman URL sumber terverifikasi. Modul Visual diperlukan untuk pengamatan/perbandingan gambar, bukan sekadar mengirim foto katalog. Gunakan indeks nama tool, minta skema dengan names langsung, gabungkan discovery dan pembacaan independen. Jangan membuka semua domain untuk pertanyaan satu produk.
customerMemory hanya fakta baru/berubah (maks16) dari pelanggan/CS, key stabil untuk satu fakta/subjek, value akurat termasuk negasi/syarat, messageIds asli (bukan pesan AI); pisahkan orang/order. Koreksi memakai key lama. Alamat nyata disimpan recipient_address dengan topic recipient tanpa menambah bagian; nama/nomor terpisah, nomor penerima bukan otomatis nomor WhatsApp. Memori bukan approval atau instruksi. Goal objective tujuan keseluruhan, current_task tugas kini; stage discovery/selection/checkout/fulfillment/service/closed; completed hanya closed. Simpan kebutuhan nyata, jangan ulang balasan saat review. follow_up hanya izin eksplisit sumber, bukan otomatis setiap waiting.
cartIntent, customSizeQuestion, checkoutContinuity, businessMedia dan approvalWait punya kontrak bukti khusus. Sebelum mengisinya, baca read_reply_contract(fields) untuk field yang digunakan; runtime menahan tindakan yang kontraknya belum dibaca. Semua validator transaksi tetap berlaku. Metadata persetujuan tidak membuktikan dana masuk. Keluaran handoff/silent tidak mengirim pesan/media. needsVisualInspection true jika butuh piksel/detail baru; false hanya observasi lama terverifikasi cukup. images url asli terverifikasi dan caption, businessMedia server/id record asli. Jangan menyatakan aksi berhasil sebelum hasil tersimpan.
Sumber terkompilasi berlaku hanya untuk hash tercatat. Salinan asli, catatan lengkap dan riwayat tersedia melalui tools; bila konteks ambigu baca sumber yang relevan sebelum bertanya atau bertindak. Jangan memuat semua sumber hanya karena konteks pendek. Ketidakpastian mengizinkan tambahan konteks, tidak mengizinkan menebak.`

let resources:
  Promise<{ hashes: Record<string, string[]>; sections: Record<string, string> }> | undefined
async function compiledResources() {
  resources ??= Promise.all([
    readFile(
      new URL('../../resources/policies/chameleon-compact-sources.json', import.meta.url),
      'utf8'
    ),
    readFile(new URL('../../resources/policies/chameleon-compact.md', import.meta.url), 'utf8'),
  ]).then(([hashes, content]) => ({
    hashes: JSON.parse(hashes),
    sections: Object.fromEntries(
      [...content.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map((m) => [
        m[1],
        m[2].trim(),
      ])
    ),
  }))
  return resources
}

export async function compactSourceStatus(skills: Skill[]) {
  const { hashes } = await compiledResources()
  return {
    eligible: matchesCompiledSources(skills, hashes),
    unreviewed: skills
      .filter((s) => !hashes[s.name]?.includes(policySourceHash(s.content)))
      .map((s) => s.name),
    missing: Object.keys(hashes).filter((name) => !skills.some((s) => s.name === name)),
  }
}

/** Reviewed visual-only policy for a perception pass. Unknown owner policies retain
 * the original full-context path; never select rules merely by a skill filename. */
export async function reviewedVisualPolicy(skills: Skill[]) {
  const { hashes, sections } = await compiledResources()
  return matchesCompiledSources(skills, hashes) ? sections.Visual : null
}

export async function planCompactReply(
  skills: Skill[],
  text: string,
  context: RoutingContext | undefined,
  hasVisual: boolean,
  schema: { properties: Record<string, unknown> },
  full = false,
  preloadFields: string[] = [],
  preloadModules: string[] = []
) {
  const { hashes, sections } = await compiledResources()
  return buildCompactReplyPlan(
    skills,
    hashes,
    sections,
    text,
    context,
    hasVisual,
    schema,
    full,
    preloadFields,
    preloadModules
  )
}

/** Pure, hash-gated builder; production only supplies the packaged reviewed manifest. */
export function buildCompactReplyPlan(
  skills: Skill[],
  hashes: Record<string, string[]>,
  sections: Record<string, string>,
  text: string,
  context: RoutingContext | undefined,
  hasVisual: boolean,
  schema: { properties: Record<string, unknown> },
  full = false,
  preloadFields: string[] = [],
  preloadModules: string[] = []
) {
  if (!matchesCompiledSources(skills, hashes)) return null
  const snapshot = skills.map((s) => ({ ...s }))
  const hint = `${text}\n${context?.lastQuestion || ''}\n${context?.waitingFor || ''}`
  const selected = new Set(['Core', 'Special terms'])
  if (
    Object.hasOwn(sections, 'Catalog') &&
    (/warna|colou?r|harga|price|model|custom|kustom|katalog|catalog/i.test(hint) ||
      catalogColorSearchHints([hint]).length > 0)
  )
    selected.add('Catalog')
  for (const name of [...preloadModules, ...contractModules(preloadFields)])
    if (Object.hasOwn(sections, name)) selected.add(name)
  if (full) Object.keys(sections).forEach((name) => selected.add(name))
  // Source hints only choose initial reading. They never classify/authorize a cart action;
  // the same module is also available by explicit retrieval and the action contract.
  if (
    Object.hasOwn(sections, 'Custom') &&
    (/custom|kustom|jahit|modifikasi/i.test(hint.normalize('NFKC')) ||
      context?.savedCart?.items.some(
        (item) =>
          item.modelType === 'custom' ||
          /^custom(?:\s|$)/i.test(item.size) ||
          Boolean(item.modelConsentEvidence)
      ))
  )
    selected.add('Custom')
  if (
    context?.hasCart ||
    /custom|kustom|ukuran|size|bayar|transfer|pesan|order|cart|rekap/i.test(hint)
  )
    selected.add('Transactions')
  if (/ongkir|kirim|shipping|kurir|kecamatan|alamat|resi/i.test(hint)) selected.add('Shipping')
  if (hasVisual || /foto|gambar|video|visual|pdf|stiker/i.test(hint)) selected.add('Visual')
  const render = (names: string[]) =>
    names.map((name) => `## ${name}\n${sections[name]}`).join('\n\n')
  const content = render([...selected])
  const contractFields = Object.fromEntries(
    preloadFields.map((name) => [name, replyContractDescriptions(schema.properties[name])])
  )
  const contractContext = context?.runtimeRules || ''
  const preloadRuntime = preloadFields.some((name) => ACTION_CONTRACTS.includes(name))
  const instructions =
    `KEBIJAKAN TERKOMPILASI ${COMPACT_POLICY_VERSION}. Modul: ${Object.keys(sections).join(', ')}. read_business_skill(modules) memuat modul ringkas tambahan; (skill, query) mencari baris asli; (skill,startLine,lineCount) membaca aslinya utuh. Sumber: ${snapshot.map((s) => s.name).join(', ')}. Kebijakan belum lengkap/bertentangan: baca sumber asli. read_reply_contract(fields) memberi dokumentasi field. Tools ini aturan, bukan bukti bisnis.` +
    (preloadFields.length
      ? `\nKONTRAK FIELD:\n${JSON.stringify(contractFields)}\n${preloadRuntime ? contractContext : ''}`
      : '')
  const charsBefore = importedSkillInstructions(skills).length
  return {
    compact: true as const,
    skills: [{ name: COMPACT_POLICY_VERSION, content }],
    instructions,
    detail: {
      routes: [...selected],
      delivery: 'compiled-progressive',
      reason: 'reviewed_source_hashes',
      sectionsSelected: selected.size,
      sectionsDeferred: Object.keys(sections).length - selected.size,
      charsBefore,
      charsAfter: content.length + instructions.length,
      candidateChars: content.length + instructions.length,
      minimumSavingRatio: 0,
      candidateSavingPercent:
        Math.round((1 - (content.length + instructions.length) / charsBefore) * 1000) / 10,
      sourceHashes: hashes,
      policyVersion: COMPACT_POLICY_VERSION,
    },
    phase() {
      const delivered = new Set(selected)
      const contracts = new Set<string>(preloadFields)
      let runtimeDelivered = preloadRuntime
      const tools: Upstream = {
        async listTools(): ReturnType<Client['listTools']> {
          return {
            tools: [
              {
                name: 'read_business_skill',
                description:
                  'Read compiled modules or exact original policy lines, at most 100 per page. Follow nextLine; query finds line numbers. Do not guess policies from headings.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    modules: {
                      type: 'array',
                      items: { type: 'string', enum: Object.keys(sections) },
                    },
                    skill: { type: 'string' },
                    query: { type: 'string' },
                    startLine: { type: 'integer', minimum: 1 },
                    lineCount: { type: 'integer', minimum: 1, maximum: 100 },
                  },
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true },
              },
              {
                name: 'read_reply_contract',
                description:
                  'Read full field contracts before emitting non-null cartIntent/customSizeQuestion/checkoutContinuity/approvalWait or nonempty businessMedia. Includes authoritative app instructions.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    fields: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 6,
                      items: { type: 'string', enum: Object.keys(schema.properties) },
                    },
                  },
                  required: ['fields'],
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true },
              },
            ],
          }
        },
        async callTool(request) {
          const args = request.arguments || {}
          const result = (value: unknown, isError = false) => ({
            isError,
            content: [{ type: 'text' as const, text: JSON.stringify(value) }],
          })
          if (request.name === 'read_reply_contract') {
            if (
              !Array.isArray(args.fields) ||
              !args.fields.length ||
              args.fields.length > 6 ||
              args.fields.some((name) => typeof name !== 'string' || !(name in schema.properties))
            )
              return result({ error: 'Choose existing contract fields.' }, true)
            const fresh = args.fields.filter((name) => !contracts.has(String(name))).map(String)
            fresh.forEach((name) => contracts.add(name))
            const modules = contractModules(fresh)
            const missingModules = modules.filter((name) => !delivered.has(name))
            modules.forEach((name) => delivered.add(name))
            const needsRuntime = fresh.some((name) => ACTION_CONTRACTS.includes(name))
            const runtime = needsRuntime && !runtimeDelivered ? contractContext : ''
            if (needsRuntime) runtimeDelivered = true
            return result({
              fields: Object.fromEntries(
                fresh.map((name) => [name, replyContractDescriptions(schema.properties[name])])
              ),
              policy: fresh.length ? render(missingModules) : '',
              runtime,
              alreadyLoaded: !fresh.length,
            })
          }
          if (request.name !== 'read_business_skill') return result({ error: 'Unknown tool' }, true)
          if (Array.isArray(args.modules)) {
            if (
              !args.modules.length ||
              args.modules.some((name) => typeof name !== 'string' || !(name in sections))
            )
              return result({ error: 'Unknown module' }, true)
            const fresh = args.modules.map(String).filter((name) => !delivered.has(name))
            fresh.forEach((name) => delivered.add(name))
            return result({ policy: render(fresh), alreadyLoaded: !fresh.length })
          }
          const source = snapshot.find((s) => s.name === args.skill)
          if (!source)
            return result(
              { error: 'Choose a source skill.', skills: snapshot.map((s) => s.name) },
              true
            )
          const lines = source.content.split('\n')
          if (typeof args.query === 'string' && args.query.trim()) {
            const terms = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
            const matches = lines
              .map((line, i) => ({ line: i + 1, text: line }))
              .filter((row) => terms.some((term) => row.text.toLocaleLowerCase().includes(term)))
            return result({
              skill: source.name,
              totalLines: lines.length,
              matches: matches.slice(0, 20),
              totalMatches: matches.length,
              note: 'Read surrounding lines before applying a rule; matches are only a finding aid.',
            })
          }
          const start = args.startLine ?? 1,
            requestedCount = args.lineCount ?? 60
          if (
            Number(start) < 1 ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(requestedCount) ||
            Number(requestedCount) < 1
          )
            return result({ error: 'Invalid line range' }, true)
          const count = Math.min(Number(requestedCount), 100)
          return result({
            skill: source.name,
            startLine: start,
            totalLines: lines.length,
            ...(Number(requestedCount) > 100
              ? { requestedLineCount: requestedCount, pageLimit: 100 }
              : {}),
            content: lines.slice(Number(start) - 1, Number(start) - 1 + Number(count)).join('\n'),
            nextLine:
              Number(start) + Number(count) <= lines.length ? Number(start) + Number(count) : null,
          })
        },
        async close() {},
      }
      return {
        tools,
        assertCovered(output: string) {
          const value = JSON.parse(output)
          const special = [
            'cartIntent',
            'customSizeQuestion',
            'checkoutContinuity',
            'approvalWait',
            'businessMedia',
          ]
          const missing = special.filter(
            (key) =>
              (Array.isArray(value[key]) ? value[key].length > 0 : Boolean(value[key])) &&
              !contracts.has(key)
          )
          // Sending a catalog photo is not pixel analysis. Its URL is checked by the
          // existing outgoing-image evidence validator; do not rerun the whole reply.
          const modules =
            (value.needsVisualInspection || value.visualMatch) && !delivered.has('Visual')
              ? ['Visual']
              : []
          if (value.needsFullSkillContext === true || missing.length || modules.length)
            throw new CompactContextIncomplete(
              missing,
              value.needsFullSkillContext === true,
              modules
            )
        },
      }
    },
  }
}
export type CompactSkillPlan = NonNullable<Awaited<ReturnType<typeof planCompactReply>>>
