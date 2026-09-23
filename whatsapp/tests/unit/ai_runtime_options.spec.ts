import { test } from '@japa/runner'
import {
  runtimeOptions,
  saveRuntimeOptions,
  codexPerformanceArgs,
  claudePerformanceArgs,
} from '#services/ai_runtime_options'

test('legacy speed remains reasoning, never enables Fast', ({ assert }) => {
  for (const provider of ['chatgpt', 'claude'] as const) {
    for (const effort of ['low', 'medium', 'high']) {
      assert.deepEqual(runtimeOptions({ [`${provider}_speed`]: effort }, provider), {
        reasoning: effort,
        speed: 'standard',
      })
      assert.deepEqual(saveRuntimeOptions({ [`${provider}Speed`]: effort }, {}, provider), {
        [`${provider}_reasoning`]: effort,
        [`${provider}_speed`]: 'standard',
      })
    }
  }
})

test('reasoning and speed produce separate CLI parameters', ({ assert }) => {
  const standard = codexPerformanceArgs('high', 'standard')
  const fast = codexPerformanceArgs('high', 'fast')
  assert.include(standard, 'model_reasoning_effort="high"')
  assert.include(fast, 'model_reasoning_effort="high"')
  assert.include(fast, 'service_tier="fast"')
  assert.include(fast, 'features.fast_mode=true')
  assert.include(standard, 'features.fast_mode=false')
  assert.deepEqual(claudePerformanceArgs('high', 'fast'), [
    '--effort',
    'high',
    '--settings',
    '{"fastMode":true}',
  ])
  assert.deepEqual(claudePerformanceArgs('high', 'standard'), [
    '--effort',
    'high',
    '--settings',
    '{"fastMode":false}',
  ])
  assert.deepEqual(claudePerformanceArgs('auto'), ['--settings', '{"fastMode":false}'])
  assert.notInclude(codexPerformanceArgs('auto').join(' '), 'model_reasoning_effort')
})

test('partial updates are independent and incompatible Fast never silently changes model', ({
  assert,
}) => {
  assert.deepEqual(
    saveRuntimeOptions({ chatgptReasoning: 'high' }, { chatgptSpeed: 'fast' }, 'chatgpt'),
    { chatgpt_reasoning: 'high' }
  )
  assert.deepEqual(
    saveRuntimeOptions(
      { claudeSpeed: 'fast' },
      { claudeModel: 'opus', claudeReasoning: 'max' },
      'claude'
    ),
    { claude_speed: 'fast' }
  )
  assert.throws(
    () => saveRuntimeOptions({ claudeSpeed: 'fast' }, { claudeModel: 'sonnet' }, 'claude'),
    /Standard/
  )
  assert.throws(
    () => saveRuntimeOptions({ claudeModel: 'haiku' }, { claudeSpeed: 'fast' }, 'claude'),
    /Standard/
  )
  assert.deepEqual(
    saveRuntimeOptions({ claudeSpeed: 'standard' }, { claudeModel: 'opus' }, 'claude'),
    { claude_speed: 'standard' }
  )
  assert.throws(() => saveRuntimeOptions({ chatgptReasoning: 'fast' }, {}, 'chatgpt'), /Reasoning/)
  assert.throws(() => saveRuntimeOptions({ claudeSpeed: 'turbo' }, {}, 'claude'), /Kecepatan/)
  assert.deepEqual(saveRuntimeOptions({ chatgptSpeed: 'auto' }, {}, 'chatgpt'), {
    chatgpt_speed: 'standard',
  })
})
