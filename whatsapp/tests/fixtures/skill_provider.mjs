#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Local protocol fixture: no provider, network, OAuth, or WhatsApp calls.
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString()
const args = process.argv.slice(2)
const codex = args[0] === 'exec'
const directory = codex ? args[args.indexOf('-C') + 1] : process.cwd()
const root = join(directory, codex ? '.agents' : '.claude', 'skills')
assert.deepEqual((await readdir(root)).sort(), ['gaya', 'inisiatif'])
for (const name of ['gaya', 'inisiatif']) {
  const skill = await readFile(join(root, name, 'SKILL.md'), 'utf8')
  assert.ok(prompt.includes(skill), `Full skill ${name} must reach provider stdin`)
}
assert.ok(prompt.length > 300_000, 'Long skills must not be truncated')
assert.ok(prompt.includes('ATURAN TERAKHIR'))
assert.ok(prompt.includes('PESAN UJI'))
assert.ok(prompt.includes('GOAL PER PELANGGAN'))
assert.ok(prompt.includes('CHAT TERPISAH'))
assert.ok(prompt.includes('DATA TUJUAN PEMBAYARAN'))
assert.ok(prompt.includes('000123456789'))
assert.ok(prompt.includes('OWNER-FIXTURE'))
assert.ok(!prompt.includes('DO-NOT-SEND-THIS-ACCOUNT'))
if (codex) {
  const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))
  assert.ok(schema.required.includes('initiative'))
  assert.ok(schema.required.includes('goal'))
}
const result = {
  decision: 'silent',
  message: '',
  reason: 'Sesuai skill',
  note: 'Catatan internal',
  business_lookup_required: false,
  handoff_category: 'none',
}
process.stdout.write(
  JSON.stringify(
    codex
      ? { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }
      : { type: 'result', structured_output: result }
  ) + '\n'
)
