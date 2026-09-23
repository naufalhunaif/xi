#!/usr/bin/env node
// Local provider contract fixture; never contacts AI services or WhatsApp.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let prompt = ''
for await (const chunk of process.stdin) prompt += chunk.toString()
const args = process.argv.slice(2)
const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))
assert.ok(!args.some((arg) => arg.startsWith('mcp_servers.')))
assert.ok(!prompt.includes('RETIRED_MUST_NOT_RETURN'))
for (const marker of [
  'ORIGINAL_cs-chameleon-cloth',
  'ORIGINAL_cs-chameleon-media',
  'ORIGINAL_cs-chameleon-batas',
  'ORIGINAL_cs-chameleon-konteks',
  'LEARNING_ORIGINAL',
  'OWNER_ORIGINAL',
])
  assert.ok(prompt.includes(marker))
const evaluation = Boolean(schema.properties.summary)
assert.equal(prompt.includes('RUBRIC_ORIGINAL'), evaluation)
if (evaluation) assert.ok(prompt.includes('EVIDENCE_ORIGINAL'))
const result = evaluation
  ? {
      summary: 'Fixture evaluation',
      stage: 'unknown',
      nextAction: '',
      missedNeeds: [],
      evidenceMessageIds: [],
      limitations: [],
      productionSignal: null,
      learningSignals: [],
    }
  : { fixture: true }
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: JSON.stringify(result),
    },
  }) + '\n'
)
