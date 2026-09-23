import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { dirname, delimiter } from 'node:path'
import { codexRuntimeEnv, codexCommand } from '#services/workspace_oauth'

test('aaPanel child PATH uses running Node and bundled Codex without mutating WEB environment', ({
  assert,
}) => {
  const original = process.env.PATH
  const result = codexRuntimeEnv()
  const paths = String(result.PATH).split(delimiter)
  assert.equal(paths[0], dirname(process.execPath))
  assert.equal(paths[1], app.makePath('node_modules', '.bin'))
  assert.equal(process.env.PATH, original)
  assert.isUndefined(result.OPENAI_API_KEY)
  assert.isUndefined(result.CODEX_API_KEY)
})

test('Codex default uses this release rather than a global CLI, explicit overrides remain intact', ({
  assert,
}) => {
  for (const value of [undefined, '', 'codex', ' codex ']) {
    assert.equal(codexCommand(value), app.makePath('node_modules', '.bin', 'codex'))
  }
  assert.equal(codexCommand('/custom/bin/codex'), '/custom/bin/codex')
  assert.equal(codexCommand('custom-codex'), 'custom-codex')
})
