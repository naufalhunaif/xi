import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { flatPrompt } from '#beta3/provider'

// v3.6.137 — tulis ulang: prompt asli utuh + catatan pemeriksa sebagai blok terpisah (cache).
test.group('Tulis ulang hemat token', () => {
  test('penyedia tanpa blok: catatan digabung di akhir', ({ assert }) => {
    assert.deepEqual(flatPrompt({ system: 's', user: 'u', tail: 'catatan' }), { system: 's', user: 'u\n\ncatatan' })
    assert.deepEqual(flatPrompt({ system: 's', user: 'u' }), { system: 's', user: 'u' })
  })

  test('tulis ulang memakai prompt & gambar yang sama dengan balasan', async ({ assert }) => {
    const source = await readFile(new URL('../../app/beta3/reply_service.ts', import.meta.url), 'utf8')
    assert.include(source, '{ system: prompt.system, user: prompt.user, tail: revisionNote(decision, check.issues) }')
    assert.match(source, /tail: revisionNote[^\n]*\n\s*contextImage \? \[contextImage\] : input\.imagePaths/)
    const provider = await readFile(new URL('../../app/beta3/provider.ts', import.meta.url), 'utf8')
    assert.include(provider, "...(prompt.tail ? ['--input-format', 'stream-json'] : [])")
  })
})
