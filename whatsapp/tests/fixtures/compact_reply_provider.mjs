#!/usr/bin/env node
// Offline CLI fixture. No real provider, business endpoint, or WhatsApp connection.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
const args = process.argv.slice(2)
const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))
const index = Boolean(schema.properties.indices)
const model = args[args.indexOf('--model') + 1]
const compact = prompt.includes('KEBIJAKAN TERKOMPILASI')
assert.ok(prompt.includes('CURRENT_FACT_UNCHANGED'))
assert.ok(prompt.includes('QUOTED_ORIGINAL_UNCHANGED'))
assert.ok(prompt.includes('CUSTOMER_CORRECTION_UNCHANGED'))
assert.equal(compact, !/SCENARIO_(EDITED|DISABLED|SALES_FULL)/.test(prompt))
if (compact) {
  if (!index)
    assert.ok(prompt.includes('L:1=state,2=domain,3=riwayat/memori,4=aturan tambahan terarah'))
  assert.ok(!JSON.stringify(schema).includes('description'))
  if (!prompt.includes('KONTRAK FIELD:'))
    assert.ok(!prompt.includes('DEFERRED_APP_CONTRACT_SENTINEL'))
  assert.ok(!prompt.includes('Diukur dari arsip'))
}
function blank(value) {
  if (
    value.anyOf?.some((v) => v.type === 'null') ||
    (Array.isArray(value.type) && value.type.includes('null'))
  )
    return null
  if (value.enum) return value.enum[0]
  if (value.type === 'object')
    return Object.fromEntries(
      Object.entries(value.properties).map(([key, val]) => [key, blank(val)])
    )
  if (value.type === 'array') return []
  if (value.type === 'boolean') return false
  if (value.type === 'integer' || value.type === 'number') return value.minimum || 0
  return ''
}
const result = {
  ...blank(schema),
  decision: 'reply',
  message: 'Iya bos',
  reason: 'Offline fixture',
  business_lookup_required: false,
  handoff_category: 'none',
  goal: {
    objective: 'Membantu pilihan pelanggan',
    stage: 'selection',
    status: 'waiting_answer',
    current_task: 'Menerima data',
    waiting_for: 'Nomor penerima',
    next_action: 'Lanjutkan setelah jawaban pelanggan',
    follow_up: null,
  },
}
if (prompt.includes('SCENARIO_SALES')) {
  assert.equal(index, false)
  assert.ok(schema.required.includes('salesProgress'))
  assert.ok(
    prompt.includes(
      compact ? 'salesProgress: step=hambatan berikut' : 'LANGKAH PENJUALAN (compact/lengkap)'
    )
  )
  const paused = prompt.includes('SALES_PAUSED')
  const messageOnly = prompt.includes('SALES_MESSAGE')
  result.message = paused
    ? 'Siap bos.'
    : messageOnly
      ? 'Mau pre-order Choco size S, bos?'
      : 'Choco size S sedang kosong bos.'
  result.initiative = '' // Provider omission: same-call chosen text must survive parsing.
  result.salesProgress = {
    step: 'selection',
    delivery: paused ? 'wait' : messageOnly ? 'message' : 'initiative',
    text: paused ? '' : 'Mau pre-order Choco size S, bos?',
    waitReason: paused ? 'customer_paused' : 'none',
  }
}
if (index) {
  delete result.business_lookup_required
  delete result.handoff_category
  assert.equal(model, 'gpt-5.6-luna')
  assert.ok(args.includes('model_reasoning_effort="low"'))
  assert.ok(!args.some((arg) => arg.startsWith('mcp_servers.')))
  result.indices = [1]
  result.message = 'Halo bos.'
  result.initiative = 'Ada yang bisa dibantu?'
  result.goal.stage = 'discovery'
  result.goal.waiting_for = 'Kebutuhan pelanggan'
  if (prompt.includes('SCENARIO_INDEX_ESCALATE')) {
    result.decision = 'escalate'
    result.indices = [4]
    result.message = ''
    result.initiative = ''
  }
} else if (prompt.includes('SCENARIO_INDEX_ESCALATE')) {
  assert.equal(model, 'gpt-5.6-sol')
  result.message = 'PRIMARY_REPLY'
}
if (prompt.includes('SCENARIO_ADAPTIVE')) {
  if (model === 'gpt-5.6-terra') {
    assert.ok(args.includes('model_reasoning_effort="medium"'))
    result.message = 'REDUCED_REPLY'
    if (prompt.includes('SCENARIO_ADAPTIVE_ESCALATE')) result.requiresDeepReasoning = true
    if (prompt.includes('SCENARIO_ADAPTIVE_FAIL')) process.exit(1)
  } else {
    assert.equal(model, 'gpt-5.6-sol')
    assert.ok(
      args.includes(
        prompt.includes('SCENARIO_ADAPTIVE_FAIL')
          ? 'model_reasoning_effort="high"'
          : 'model_reasoning_effort="xhigh"'
      )
    )
    result.message = 'PRIMARY_REPLY'
  }
}
if (prompt.includes('SCENARIO_CONTRACT') || prompt.includes('SCENARIO_PHOTO_DOCS')) {
  const photo = prompt.includes('SCENARIO_PHOTO_DOCS')
  const config = (key) =>
    JSON.parse(args.find((arg) => arg.startsWith(key + '=')).slice(key.length + 1))
  const url = config('mcp_servers.business_skill_library.url')
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const token = config('mcp_servers.business_skill_library.bearer_token_env_var')
  const client = new Client({ name: 'compact-fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${process.env[token]}` } },
      })
    )
    const response = await client.callTool({
      name: 'read_reply_contract',
      arguments: { fields: [photo ? 'images' : 'approvalWait'] },
    })
    assert.equal(JSON.stringify(response).includes('DEFERRED_APP_CONTRACT_SENTINEL'), !photo)
    if (!photo) {
      result.decision = 'handoff'
      result.message = ''
      result.approvalWait = 'model'
      result.handoff_category = 'human_authorization'
    }
  } finally {
    await client.close()
  }
}
if (prompt.includes('SCENARIO_CATALOG_PHOTO') || prompt.includes('SCENARIO_PHOTO_DOCS'))
  result.images = [{ url: 'https://catalog.invalid/image.jpg', caption: '' }]
if (prompt.includes('SCENARIO_LATE_CONTRACT')) {
  result.decision = 'handoff'
  result.message = ''
  result.approvalWait = 'model'
  result.handoff_category = 'human_authorization'
  if (prompt.includes('KONTRAK FIELD:'))
    assert.ok(prompt.includes('DEFERRED_APP_CONTRACT_SENTINEL'))
}
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(result) },
  }) + '\n'
)
