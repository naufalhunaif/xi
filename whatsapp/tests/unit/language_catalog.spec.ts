import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('shared English and Indonesian catalogs have matching keys and placeholders', async ({
  assert,
}) => {
  const sandbox = { window: {} as { waLocales?: Record<string, Record<string, string>> } }
  for (const language of ['en', 'id'])
    vm.runInNewContext(await readFile(`public/lang/${language}.js`, 'utf8'), sandbox)
  const { en, id } = sandbox.window.waLocales!
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort())
  assert.isAbove(Object.keys(en).length, 400)
  for (const key of Object.keys(en)) {
    assert.isString(en[key])
    assert.isString(id[key])
    const placeholders = (value: string) => [...new Set(value.match(/\{\d+\}/g) || [])].sort()
    assert.deepEqual(placeholders(en[key]), placeholders(id[key]), key)
  }
  const runtime = await readFile('public/assets/i18n.js', 'utf8')
  assert.include(runtime, 'window.waLocales?.en')
  assert.notInclude(runtime, "'Salin nomor':")
})
