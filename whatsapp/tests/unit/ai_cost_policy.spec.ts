import { test } from '@japa/runner'
import { AiLoopGuard, phaseAllowsHistory, claudeTaskArgs } from '#services/ai_cost_policy'
import { switchableFailure } from '#services/ai_provider_failover'

const resultEvent = (id: string, value = 1, args = { id: 'p1' }) => ({
  type: 'item.completed',
  item: {
    id,
    type: 'mcp_tool_call',
    server: 'store',
    tool: 'get_product',
    arguments: args,
    result: { content: [{ type: 'text', text: JSON.stringify({ value }) }] },
  },
})

test('useful work beyond 16 tools continues and new evidence resets the loop guard', ({
  assert,
}) => {
  const guard = new AiLoopGuard()
  const observe = guard.observer('chatgpt')
  for (let i = 0; i < 40; i++) assert.isTrue(observe(resultEvent(String(i), i)))
  assert.equal(guard.calls, 40)
  assert.isTrue(observe(resultEvent('40', 39)))
  assert.isTrue(observe(resultEvent('41', 39)))
  assert.isTrue(observe(resultEvent('42', 40)))
  assert.isTrue(observe(resultEvent('43', 40)))
})

test('stops only four identical completed calls and never switches provider for a local loop', ({
  assert,
}) => {
  const guard = new AiLoopGuard()
  const observe = guard.observer('chatgpt')
  for (let i = 0; i < 3; i++) {
    const event = resultEvent(String(i))
    assert.isTrue(observe({ ...event, type: 'item.started' }))
    assert.isTrue(observe(event))
    assert.isTrue(observe(event)) // duplicate event is not another call/result
  }
  assert.equal(guard.calls, 3)
  assert.isFalse(observe(resultEvent('3')))
  assert.isFalse(switchableFailure('AI_TOOL_LOOP'))
  // A new phase may legitimately verify the same result with IDs reused by a new CLI.
  assert.isTrue(guard.observer('chatgpt')(resultEvent('0')))
})

test('different arguments or sources with identical output are distinct evidence', ({ assert }) => {
  const observe = new AiLoopGuard().observer('chatgpt')
  for (let i = 0; i < 20; i++) assert.isTrue(observe(resultEvent(String(i), 1, { id: `p${i}` })))
  for (let i = 20; i < 40; i++) {
    const event = resultEvent(String(i))
    event.item.server = `source-${i}`
    assert.isTrue(observe(event))
  }
})

test('Claude loop detection waits for results and preserves legitimate parallel tools', ({
  assert,
}) => {
  const guard = new AiLoopGuard()
  const observe = guard.observer('claude')
  for (let i = 0; i < 4; i++) {
    assert.isTrue(
      observe({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: String(i),
              name: 'mcp__store__get_product',
              input: { id: 'p1' },
            },
          ],
        },
      })
    )
    assert.equal(
      observe({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: String(i), content: 'same evidence' }],
        },
      }),
      i < 3
    )
  }
  const nextPhase = guard.observer('claude')
  assert.isTrue(
    nextPhase({
      type: 'assistant',
      message: {
        content: Array.from({ length: 20 }, (_, i) => ({
          type: 'tool_use',
          id: String(i),
          name: 'mcp__store__get_product',
          input: { id: `p${i}` },
        })),
      },
    })
  )
})

test('customer and visual analysis retain history access; snapshot-only tasks do not', ({
  assert,
}) => {
  for (const phase of ['analysis', 'business-recheck-run', 'comparison', 'visual-recheck'])
    assert.isTrue(phaseAllowsHistory(phase))
  for (const phase of [
    'receipt',
    'evaluation',
    'learning-replay',
    'shipping-notice',
    'shipment-analysis-1',
  ])
    assert.isFalse(phaseAllowsHistory(phase), phase)
})

test('Claude exposes image Read when needed without inherited coding context', ({ assert }) => {
  for (const images of [false, true]) {
    const args = claudeTaskArgs(images)
    assert.equal(args[args.indexOf('--tools') + 1], images ? 'Read' : '')
    assert.include(args, '--system-prompt')
    assert.include(args, '--disable-slash-commands')
    assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  }
})

test('new evidence from another tool breaks an otherwise repeated sequence', ({ assert }) => {
  const observe = new AiLoopGuard(2).observer('claude')
  for (let i = 0; i < 3; i++) {
    assert.isTrue(
      observe({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: `mcp-${i}`, name: 'mcp__store__get_product', input: {} },
          ],
        },
      })
    )
    assert.isTrue(
      observe({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: `mcp-${i}`, content: 'same result' }],
        },
      })
    )
    assert.isTrue(
      observe({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: `read-${i}`,
              name: 'Read',
              input: { file_path: `image-${i}.jpg` },
            },
          ],
        },
      })
    )
    assert.isTrue(
      observe({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: 'image content' }],
        },
      })
    )
  }
})
