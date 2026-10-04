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
