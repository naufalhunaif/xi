import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { raceAccounts } from '#beta3/provider'
import { accountsToProbe, probeVerdict, PROBE_IDLE_MS } from '#services/ai_health'
import { saveRemoteDigest, skillForPrompt } from '#beta3/skill_digest'
import { ensureLeanTables } from '#beta3/tables'

// v3.6.57 — chat Instagram 7 Okt: ChatGPT macet 120 dtk, Gemini macet 120 dtk dua kali, baru
// Gemini Flash menjawab → pelanggan menunggu 6 menit. Skill online juga lebih baru dari DIGEST.md
// aplikasi → ringkasan tidak terpakai (prompt ±2.300 token lebih besar).
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.group('kecepatan AI: cadangan paralel (v3.6.57)', () => {
  test('akun pertama lambat → akun kedua mulai setelah batas, jawaban tercepat dipakai, yang lambat dibatalkan', async ({ assert }) => {
    const aborted: string[] = []
    const started: string[] = []
    const run = (name: string, signal: AbortSignal) => {
      started.push(name)
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(name), name === 'lambat' ? 1000 : 30)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          aborted.push(name)
          reject(new Error('dibatalkan'))
        })
      })
    }
    const result = await raceAccounts(['lambat', 'cepat', 'ketiga'], run, 50)
    assert.equal(result, 'cepat')
    assert.deepEqual(started, ['lambat', 'cepat'])
    assert.deepEqual(aborted, ['lambat'])
  })

  test('akun gagal → akun berikutnya langsung dicoba (tanpa menunggu batas)', async ({ assert }) => {
    const begun: number[] = []
    const t0 = Date.now()
    const run = async (name: string) => {
      begun.push(Date.now() - t0)
      if (name === 'gagal') throw new Error('timeout')
      return name
    }
    assert.equal(await raceAccounts(['gagal', 'oke'], run, 5_000), 'oke')
    assert.isBelow(begun[1], 1000)
  })

  test('akun pertama cepat → akun lain tidak pernah dijalankan; semua gagal → error terakhir', async ({ assert }) => {
    const started: string[] = []
    const ok = await raceAccounts(['a', 'b'], async (name: string) => (started.push(name), name), 50)
    assert.equal(ok, 'a')
    await wait(80)
    assert.deepEqual(started, ['a'])
    await assert.rejects(() => raceAccounts(['x', 'y'], async (name: string) => { throw new Error(`gagal ${name}`) }, 10), 'gagal y')
  })
})

test.group('kecepatan AI: cek kesehatan akun diam (v3.6.57)', () => {
  const account = (id: number, over: Record<string, unknown> = {}) =>
    ({ id, provider: 'chatgpt', enabled: true, limitedUntil: 0, limitedCode: '', lastUsedAt: null, apiKey: '', ...over }) as any

  test('yang dicek: akun lama diam atau baru pulih dari gagal; akun yang baru dipakai / sedang jeda tidak', ({ assert }) => {
    const now = Date.parse('2026-10-08T03:00:00Z')
    const accounts = [
      account(1, { lastUsedAt: new Date(now - 5 * 60_000) }),
      account(2, { lastUsedAt: new Date(now - PROBE_IDLE_MS - 60_000) }),
      account(3, { limitedUntil: now + 60_000, limitedCode: 'AI_PROCESS_FAILED' }),
      account(4, { lastUsedAt: new Date(now - 60_000), limitedUntil: now - 1000, limitedCode: 'AI_PROCESS_FAILED' }),
      account(5, { enabled: false }),
      account(6, { provider: 'gemini', apiKey: '', lastUsedAt: null }),
    ]
    assert.deepEqual(accountsToProbe(accounts, now, new Map()).map((a) => a.id).sort(), [2, 4])
    // Sudah dicek barusan → tidak dicek lagi sampai diam 30 menit.
    assert.deepEqual(accountsToProbe(accounts, now, new Map([[2, now - 1000], [4, now - 500]])).map((a) => a.id), [])
  })

  test('hasil cek: gagal atau lambat (> 45 dtk) → dijeda; cepat → sehat', ({ assert }) => {
    assert.deepEqual(probeVerdict({ ok: true, ms: 4000 }), { healthy: true, code: '' })
    assert.deepEqual(probeVerdict({ ok: true, ms: 60_000 }), { healthy: false, code: 'AI_SLOW' })
    assert.deepEqual(probeVerdict({ ok: false, ms: 75_000, code: 'AI_TIMEOUT' }), { healthy: false, code: 'AI_TIMEOUT' })
  })
})

test.group('ringkasan skill dari rilis online (v3.6.57)', (group) => {
  group.each.setup(async () => {
    await ensureLeanTables()
  })

  test('skill online lebih baru dari DIGEST.md aplikasi → DIGEST.md online dipakai', async ({ assert }) => {
    const skill = await readFile(new URL('../../skills-beta3/beta3-cs-inti/SKILL.md', import.meta.url), 'utf8')
    const digest = await readFile(new URL('../../skills-beta3/beta3-cs-inti/DIGEST.md', import.meta.url), 'utf8')
    // Versi online: skill berubah sedikit, DIGEST.md online ikut menunjuk isi barunya.
    const online = skill.replace('# CS Chameleon Cloth — inti', '# CS Chameleon Cloth — inti ')
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(online).digest('hex')
    const onlineDigest = digest.replace(/^digest_of:\s*[a-f0-9]{64}/m, `digest_of: ${hash}`)
    // DIGEST.md yang tidak menunjuk isi skill ini ditolak.
    assert.isFalse(await saveRemoteDigest(online, digest))
    assert.isTrue(await saveRemoteDigest(online, onlineDigest))
    const used = await skillForPrompt({ name: 'beta3-cs-inti', content: online })
    assert.isTrue(used.digest)
    assert.isBelow(used.content.length, online.length * 0.9)
  })
})
