import { test } from '@japa/runner'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { visualEvidenceCache } from '#services/visual_evidence_cache'
import type { CacheEntry } from '#services/evidence_cache'
import type { VisualMatch } from '#services/visual_match_contract'

test('visual cache stores only validated observations and invalidates pixels, candidates, focus, model, skill and expiry', async ({
  assert,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'wa-visual-cache-test-'))
  try {
    const files = ['customer', 'catalog'].map((name) => join(directory, name))
    for (const file of files) await writeFile(file, 'fixture pixels ' + file)
    const entries = new Map<string, CacheEntry>()
    const store = {
      get: async (key: string) => entries.get(key) || null,
      put: async (key: string, entry: CacheEntry) => {
        entries.set(key, entry)
      },
    }
    let now = 100
    const candidates = [{ id: 'p1', server: 'store' }]
    const context = { question: 'model ini ada?', model: 'modelA', skills: ['v1'] }
    const get = (ctx = context, choices = candidates) =>
      visualEvidenceCache(files, ctx, choices, store, () => now)
    const match: VisualMatch = {
      status: 'matched',
      targetImage: 1,
      productId: 'p1',
      server: 'store',
      findings: [
        { feature: 'lapel', customer: 'notch', catalog: 'notch', relation: 'match' },
        { feature: 'buttons', customer: 'one', catalog: 'one', relation: 'match' },
      ],
    }
    assert.isNull((await get()).cached)
    await (await get()).save(match)
    assert.deepEqual((await get()).cached?.match, match)
    assert.isNull((await get({ ...context, question: 'berapa kancing lengan?' })).cached)
    assert.isNull((await get({ ...context, model: 'modelB' })).cached)
    assert.isNull((await get({ ...context, skills: ['v2'] })).cached)
    assert.isNull((await get(context, [{ id: 'p2', server: 'store' }])).cached)
    await writeFile(files[0], 'new customer pixels')
    assert.isNull((await get()).cached)
    await (await get()).save({ ...match, productId: 'not-a-candidate' })
    assert.isNull((await get()).cached)
    await (await get()).save({ ...match, status: 'uncertain', productId: '', server: '' })
    assert.isNull((await get()).cached)
    await (await get()).save(match)
    now += 86400000
    assert.isNull((await get()).cached)
    for (const entry of entries.values()) {
      assert.notProperty(entry.value, 'message')
      assert.notProperty(entry.value, 'cartIntent')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
