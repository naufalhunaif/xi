#!/usr/bin/env node
// Local fake provider: inspects the real prompt/schema/CLI boundary, never calls AI or WhatsApp.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString()
const args = process.argv.slice(2)
const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))
const index = Boolean(schema.properties.indices)
let value
if (index) {
  assert.ok(
    !args.some((arg) => arg.includes('mcp_servers.')),
    'No business, history or skill MCP in index phase'
  )
  assert.ok(!('cartIntent' in schema.properties))
  assert.ok(prompt.includes('CORE_INDEX_ORIGINAL'))
  assert.ok(prompt.includes('SOURCE_CONTEXT_ORIGINAL'))
  assert.ok(!prompt.includes('CART_DOMAIN_ORIGINAL'))
  assert.ok(!prompt.includes('PAYMENT_DOMAIN_ORIGINAL'))
  assert.ok(!prompt.includes('MAIN_CONVERSATION_ORIGINAL'))
  value = {
    decision: 'reply',
    indices: [1],
    needsFullSkillContext: false,
    message: 'Halo bos.',
    initiative: 'Ada yang bisa dibantu?',
    reason: 'Sapaan pembuka.',
    goal: {
      objective: 'Membantu pelanggan',
      stage: 'discovery',
      status: 'waiting_answer',
      current_task: 'Memahami kebutuhan',
      waiting_for: 'Kebutuhan pelanggan',
      next_action: 'Bantu setelah kebutuhan disampaikan',
      follow_up: null,
    },
  }
  if (prompt.includes('ESCALATE'))
    value = { ...value, decision: 'escalate', indices: [3], message: '', initiative: '' }
  if (prompt.includes('MALFORMED')) value = 'unstructured private output'
  if (prompt.includes('FORGED')) value.cartIntent = { action: 'checkout' }
} else {
  assert.ok(
    prompt.includes('MAIN_CONVERSATION_ORIGINAL'),
    'Escalation must retain original full source context'
  )
  assert.ok(prompt.includes('CORE_INDEX_ORIGINAL'))
  assert.ok('cartIntent' in schema.properties, 'Main transaction validation stays available')
  value = {
    decision: 'reply',
    message: 'Kebutuhan mana yang dimaksud bos?',
    initiative: '',
    reason: 'Main fixture.',
    note: '',
    business_lookup_required: false,
    needsFullSkillContext: false,
  }
}
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: typeof value === 'string' ? value : JSON.stringify(value),
    },
  }) + '\n'
)
