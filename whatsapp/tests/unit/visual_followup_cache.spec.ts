import { test } from '@japa/runner'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { visualFollowupCache, visualFingerprint } from '#services/visual_followup_cache'
import type { CacheEntry } from '#services/evidence_cache'
import type { VisualMatch } from '#services/visual_match_contract'

test('follow-up observations are bounded and invalidate on reference, room, pixels, skills, model and expiry', async ({
  assert,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'wa-followup-cache-'))
  try {
    const file = join(directory, 'pixels')
    await writeFile(file, 'pixels')
    const entries = new Map<string, CacheEntry>()
    const store = {
      get: async (key: string) => entries.get(key) || null,
      put: async (key: string, value: CacheEntry) => {
        entries.set(key, value)
      },
    }
    let now = 100
    const context = { jid: 'room', model: 'A', skills: ['v1'] }
    const read = (ctx = context, id = 'photo') =>
      visualFollowupCache(file, id, ctx, store, () => now)
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
    const observation = {
      match,
      candidates: [{ id: 'p1', server: 'store' }],
      fingerprint: await visualFingerprint([file], ['catalog']),
    }
    const first = await read()
    assert.isNull(first.cached)
    await first.save(observation)
    assert.deepEqual((await read()).cached?.match, match)
    assert.isNull((await read({ ...context, jid: 'other' })).cached)
    assert.isNull((await read({ ...context, model: 'B' })).cached)
    assert.isNull((await read({ ...context, skills: ['v2'] })).cached)
    assert.isNull((await read(context, 'new-photo')).cached)
    await writeFile(file, 'changed')
    assert.isNull((await read()).cached)
    await writeFile(file, 'pixels')
    await first.save({ ...observation, match: { ...match, status: 'uncertain' } })
    assert.equal(entries.size, 1)
    assert.notProperty([...entries.values()][0].value, 'cartIntent')
    now += 86400000
    assert.isNull((await read()).cached)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
