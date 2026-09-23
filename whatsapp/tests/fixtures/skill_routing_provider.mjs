#!/usr/bin/env node
// Local protocol fixture only. Never calls a paid provider or WhatsApp.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString()
const args = process.argv.slice(2)
const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))
assert.deepEqual(
  [...schema.required].sort(),
  Object.keys(schema.properties).sort(),
  'Provider requires all output properties, including needsFullSkillContext'
)
assert.ok(prompt.includes('CUSTOMER_HISTORY_ORIGINAL'))
assert.ok(prompt.includes('CORE_RULE_ORIGINAL'))
assert.ok(prompt.includes('CATALOG_RULE_ORIGINAL'))
assert.ok(
  !prompt.includes('RETIRED_RULE_MUST_NOT_RETURN'),
  'Retired snapshots must stay excluded in every provider/fallback phase'
)
if (/SCENARIO_(SCHEMA_ERROR|CONTEXT_ERROR)/.test(prompt)) {
  process.stdout.write(
    JSON.stringify({
      type: 'error',
      message: prompt.includes('SCHEMA_ERROR')
        ? 'Invalid schema for response_format: private-fixture'
        : 'context_length_exceeded JSON private-fixture',
    }) + '\n'
  )
  // Reproduce a CLI that emits an explicit error, then exits without a final message.
  process.exit(0)
}
const routed = prompt.includes('BAGIAN TERSEDIA:')
assert.equal(prompt.includes('DEFERRED_PAYMENT_ORIGINAL'), !routed)
const patternScenario = /SCENARIO_PATTERN_(NAVY|MAROON)/.test(prompt)
if (routed && (prompt.includes('SCENARIO_READ') || patternScenario)) {
  const config = (key) =>
    JSON.parse(args.find((arg) => arg.startsWith(`${key}=`)).slice(key.length + 1))
  const url = config('mcp_servers.business_skill_library.url')
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const tokenName = config('mcp_servers.business_skill_library.bearer_token_env_var')
  const client = new Client({ name: 'skill-routing-fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${process.env[tokenName]}` } },
      })
    )
    const tools = await client.listTools()
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['read_business_skill']
    )
    const result = await client.callTool({
      name: 'read_business_skill',
      arguments: patternScenario ? { patternIds: ['catalog-design', 'fit'] } : { all: true },
    })
    assert.ok(JSON.stringify(result).includes('DEFERRED_PAYMENT_ORIGINAL'))
    if (patternScenario) {
      const parsed = JSON.parse(result.content[0].text)
      assert.ok(parsed.procedures.some((p) => p.id === 'catalog-design'))
      const repeated = await client.callTool({
        name: 'read_business_skill',
        arguments: { patternIds: ['catalog-design'] },
      })
      assert.equal(JSON.parse(repeated.content[0].text).alreadyLoaded, true)
      assert.deepEqual(JSON.parse(repeated.content[0].text).policy, [])
      assert.ok(!JSON.stringify(result).includes('CURRENT_VARIANT'))
    }
  } finally {
    await client.close()
  }
}
const payment = /SCENARIO_(READ|LATE|LOW_SAVING)/.test(prompt)
const result = {
  decision: 'reply',
  message: payment ? 'Pembayaran transfer tersedia.' : 'Harga produk tersedia.',
  reason: 'Local fixture',
  note: '',
  business_lookup_required: false,
  initiative: '',
  needsFullSkillContext: prompt.includes('SCENARIO_UNCERTAIN'),
}
if (patternScenario) {
  const color = prompt.includes('SCENARIO_PATTERN_NAVY') ? 'navy' : 'maroon'
  assert.ok(
    prompt.includes(`CURRENT_VARIANT=${color}`),
    'Current source details must remain in the prompt on cache hits'
  )
  result.message = `Rincian yang ditanyakan: badan ${color}.`
}
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(result) },
  }) + '\n'
)
