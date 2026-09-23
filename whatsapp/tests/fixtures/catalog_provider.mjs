#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString()
const args = process.argv.slice(2)
const skill = await readFile(
  new URL('../../skills/cs-detail-visual/SKILL.md', import.meta.url),
  'utf8'
)
const observation = prompt.includes('[VISUAL OBSERVATION ONLY]')
if (!observation && !prompt.includes('SPLIT'))
  assert.ok(prompt.includes(skill), 'Complete visual skill reaches each answer stage')
if (observation) {
  assert.ok(!prompt.includes('requiresDeepReasoning'), 'Observation schema has no routing flag')
  assert.ok(!prompt.includes('KONTRAK RUNTIME'))
  assert.ok(!prompt.includes('KONTRAK GOAL'))
  assert.ok(
    args.filter((arg) => arg.includes('mcp_servers.') && arg.endsWith('enabled=true')).length === 0,
    'Observation has no MCP tools'
  )
}
const instructionArg = args.find((arg) => arg.startsWith('model_instructions_file='))
assert.ok(instructionArg, 'Codex replaces unrelated coding instructions')
const instructions = await readFile(
  JSON.parse(instructionArg.split('=').slice(1).join('=')),
  'utf8'
)
assert.ok(instructions.includes('Ikuti seluruh skill dan aturan tugas.'))
const images = args.filter((arg) => arg === '--image').length
const comparison = prompt.includes('[CANDIDATE MCP VERIFIED]')
const cached =
  prompt.includes('OBSERVASI VISUAL TERVERIFIKASI') ||
  prompt.includes('CACHE OBSERVASI TERVERIFIKASI:')
const followup = prompt.includes('OBSERVASI GAMBAR LAMA TERVERIFIKASI (bukan foto baru):')
const extra = prompt.includes('OLD_REFERENCE') ? 1 : 0
assert.equal(
  images,
  cached || followup ? 0 : (comparison || observation ? 2 : 1) + extra,
  'Comparison must include reference and candidate images'
)
if (comparison) {
  assert.ok(!prompt.includes('Initial draft'), 'Initial identity guesses cannot bias comparison')
  assert.ok(
    prompt.includes('Foto berikutnya hanya kandidat MCP'),
    'Catalog photos must be labeled as candidates'
  )
}
if (extra && !cached) {
  const paths = args.flatMap((arg, index) => (arg === '--image' ? [args[index + 1]] : []))
  assert.ok(paths[0].endsWith('visual-1.jpg'), 'Latest uploaded media must remain the first image')
  assert.ok(paths[1].endsWith('context-1.jpg'), 'Old reference stays supplemental')
  assert.ok(prompt.includes('message_id=latest-image'), 'Latest reference retains its message ID')
}
if (!comparison && !observation) {
  process.stdout.write(
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'business_fixture',
        tool: 'get_product',
        arguments: { id: 'suit' },
        result: {
          structured_content: {
            id: 'suit',
            name: 'Suit Fixture',
            img: '/suit.png',
            description: 'Two buttons',
          },
        },
      },
    }) + '\n'
  )
}
const result = {
  needsVisualInspection: followup ? prompt.includes('NEW_DETAIL') : true,
  customerMemory: [],
  decision: 'reply',
  message: followup
    ? 'Fresh follow-up answer from current business data'
    : comparison
      ? 'Compared reference and catalog'
      : 'Initial draft',
  reason: 'Local protocol fixture',
  note: '',
  business_lookup_required: !comparison,
  handoff_category: 'none',
  visualMatch: {
    targetImage: 1,
    status: comparison || observation ? 'matched' : 'uncertain',
    productId: 'suit',
    server: 'business_fixture',
    findings: [
      { feature: 'lapel', customer: 'Notch', catalog: 'Notch', relation: 'match' },
      { feature: 'buttons', customer: 'Two buttons', catalog: 'Two buttons', relation: 'match' },
    ],
  },
}
if ((comparison || observation) && prompt.includes('WRONG_TARGET')) {
  result.visualMatch.targetImage = prompt.includes('VALIDASI:') ? 1 : images
  if (prompt.includes('VALIDASI:')) {
    result.visualMatch.status = 'uncertain'
    result.message = 'Foto terbaru belum dapat dipastikan.'
  }
}
if ((comparison || observation) && prompt.includes('NO_MATCH')) {
  result.visualMatch.status = 'no_match'
  result.message = 'Untuk model sesuai foto ini, ukuran yang biasa dipakai apa, bos?'
  result.images = prompt.includes('VALIDASI:')
    ? []
    : [{ url: 'https://example.test/substitute.jpg', caption: 'Wrong substitute' }]
}
if (comparison && prompt.includes('MIXED_NO_MATCH')) {
  const line = {
    id: '',
    productId: 'suit',
    name: 'Suit Fixture',
    image: '',
    size: 'S',
    quantity: 1,
    unitPrice: 500000,
    modelType: 'catalog',
    fulfillment: 'ready',
    referenceMessageId: '',
    measurements: [],
    note: '',
  }
  result.cartIntent = {
    action: 'sync',
    confirmationMessageId: 'customer-selection',
    items: [
      line,
      { ...line, size: 'M', fulfillment: 'preorder' },
      {
        ...line,
        productId: '',
        name: 'Custom reference',
        modelType: 'custom',
        referenceMessageId: 'older-image',
        unitPrice: null,
      },
    ],
    recipient: { name: '', phone: '', address: '' },
    shipping: { service: '', cost: null },
    removeItemIds: [],
    note: '',
  }
  result.message = 'Pilihan ready, pre-order dan model sesuai foto dicatat terpisah.'
}
if ((comparison || observation) && prompt.includes('STUCK_TARGET'))
  result.visualMatch.targetImage = images
// An inspection request need not invent a customer reply before the image pass.
if (followup && prompt.includes('NEW_DETAIL')) result.message = ''
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: JSON.stringify(observation ? { visualMatch: result.visualMatch } : result),
    },
  }) + '\n'
)
