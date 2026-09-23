import { test } from '@japa/runner'
import { strict as assertSchema } from 'node:assert'
import { DECISION_SCHEMA } from '#services/ai_service'
import { VISUAL_MATCH_SCHEMA } from '#services/visual_match_contract'

// Structured Outputs requires every object property in required, even nullable fields.
// Walk nested variants too: checking only the JSON output misses a rejected request schema.
function checkObjects(schema: any, path = '$') {
  if (!schema || typeof schema !== 'object') return
  if (schema.properties) {
    assertSchema.equal(
      schema.additionalProperties,
      false,
      `${path}: extra properties must be disabled`
    )
    assertSchema.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${path}: all properties must be required`
    )
  }
  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value))
      value.forEach((entry, index) => checkObjects(entry, `${path}.${key}[${index}]`))
    else if (value && typeof value === 'object') checkObjects(value, `${path}.${key}`)
  }
}

test('text reply request satisfies strict output schema object rules', () => {
  checkObjects(DECISION_SCHEMA)
})

test('visual reply request satisfies strict output schema object rules', () => {
  checkObjects({
    ...DECISION_SCHEMA,
    properties: { ...DECISION_SCHEMA.properties, visualMatch: VISUAL_MATCH_SCHEMA },
    required: [...DECISION_SCHEMA.required, 'visualMatch'],
  })
})
