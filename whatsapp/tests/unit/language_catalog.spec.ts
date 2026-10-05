import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// v3.6.26: katalog Indonesia dihapus; tampilan hanya Inggris (kunci = teks sumber Indonesia di kode).
test('English catalog is well-formed and placeholders survive translation', async ({ assert }) => {
  const sandbox = { window: {} as { waLocales?: Record<string, Record<string, string>> } }
  vm.runInNewContext(await readFile('public/lang/en.js', 'utf8'), sandbox)
  const { en } = sandbox.window.waLocales!
  assert.isAbove(Object.keys(en).length, 400)
  for (const key of Object.keys(en)) {
    assert.isString(en[key])
    const placeholders = (value: string) => [...new Set(value.match(/\{\d+\}/g) || [])].sort()
    assert.deepEqual(placeholders(en[key]), placeholders(key), key)
  }
  const runtime = await readFile('public/assets/i18n.js', 'utf8')
  assert.include(runtime, 'window.waLocales?.en')
  assert.notInclude(runtime, "'Salin nomor':")
  const layout = await readFile('resources/views/components/layout.edge', 'utf8')
  assert.notInclude(layout, 'lang/id.js')
})

test('every UI text used in views and scripts has an English translation', async ({ assert }) => {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const sandbox = { window: {} as { waLocales?: Record<string, Record<string, string>> } }
  vm.runInNewContext(await readFile('public/lang/en.js', 'utf8'), sandbox)
  const en = sandbox.window.waLocales!.en
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(edge|js)$/.test(entry.name) && !path.includes('public/lang')) files.push(path)
    }
  }
  await walk('resources/views')
  await walk('public/assets')
  const missing = new Set<string>()
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const texts = [
      ...[...source.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map((match) =>
        match[1].replace(/&amp;/g, '&')
      ),
      ...[...source.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g)]
        .filter((match) => !match[2].includes('${'))
        .map((match) => match[2].replace(/\\'/g, "'").replace(/\\n/g, '\n')),
    ]
    for (const text of texts)
      if (!text.includes('{{') && !(text in en)) missing.add(`${file}: ${text}`)
  }
  assert.deepEqual([...missing], [])
})
