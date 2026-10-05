import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { digestMissing, mergeDigest, skillBody, skillForPrompt, setSkillDigestOff, skillDigestView } from '#beta3/skill_digest'
import { ensureLeanTables, writeLeanState } from '#beta3/tables'
import { trimSkill } from '#beta3/token_saver'

const root = new URL('../../skills-beta3/beta3-cs-inti/', import.meta.url)

// v3.6.39: skill asli tidak berubah; digest = isi sama, format ringkas.
test.group('skill digest', () => {
  test('DIGEST.md lengkap: semua kalimat CS, angka, bagian, field & judul tetap ada', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    const digest = await readFile(new URL('DIGEST.md', root), 'utf8')
    assert.deepEqual(digestMissing(skill, digest), [])
    // digest_of harus menunjuk isi skill sekarang (skill diubah → DIGEST.md wajib ikut diperbarui).
    const of = digest.match(/^digest_of:\s*([a-f0-9]{64})/m)?.[1]
    assert.equal(of, createHash('sha256').update(skill).digest('hex'))
    const merged = mergeDigest(skill, digest)
    assert.isNotNull(merged)
    assert.deepEqual(merged!.fallback, [])
    // Jauh lebih ringkas dari skill asli.
    assert.isBelow(merged!.text.length, skillBody(skill).length * 0.8)
  })

  test('bagian yang tidak lengkap memakai teks asli; judul tetap bisa dipangkas trimSkill', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    const digest = await readFile(new URL('DIGEST.md', root), 'utf8')
    const broken = digest.replace('"Sudah harga pas bos"', '"harga pas"')
    const merged = mergeDigest(skill, broken)
    assert.include(merged!.fallback, 'Cara bicara')
    assert.include(merged!.text, 'Nego harga: "Sudah harga pas bos"')
    const trimmed = trimSkill(merged!.text, {
      size: false, spec: false, catalog: false, shipping: false, paid: false, photo: false, instagram: false,
    })
    assert.includeMembers(trimmed.skipped, ['Ongkir', 'Setelah bayar'])
  })

  test('dipakai saat membalas: DIGEST.md bawaan, bisa dimatikan, skill diubah → dibuat AI sekali', async ({ assert }) => {
    await ensureLeanTables()
    await setSkillDigestOff(false)
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    const digest = await readFile(new URL('DIGEST.md', root), 'utf8')
    const used = await skillForPrompt({ name: 'beta3-cs-inti', content: skill })
    assert.isTrue(used.digest)
    assert.include(used.content, '(digest)')
    const view = await skillDigestView({ name: 'beta3-cs-inti', content: skill })
    assert.isBelow(view.digestTokens, view.originalTokens)
    // Dimatikan → skill asli.
    await setSkillDigestOff(true)
    assert.isFalse((await skillForPrompt({ name: 'beta3-cs-inti', content: skill })).digest)
    await setSkillDigestOff(false)
    // Skill diubah (isi lain) tanpa DIGEST.md baru → skill asli dulu, digest dibuat di latar sekali.
    const edited = `${skill}\n`
    const hash = createHash('sha256').update(edited).digest('hex')
    await writeLeanState(`skill-digest:${hash.slice(0, 32)}`, '')
    await writeLeanState(`skill-digest:${hash.slice(0, 32)}:tried`, '')
    let calls = 0
    const make = async () => {
      calls++
      return skillBody(digest)
    }
    const first = await skillForPrompt({ name: 'beta3-cs-inti', content: edited }, make)
    assert.isFalse(first.digest)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const second = await skillForPrompt({ name: 'beta3-cs-inti', content: edited }, make)
    assert.isTrue(second.digest)
    assert.equal(calls, 1)
    await writeLeanState(`skill-digest:${hash.slice(0, 32)}`, '')
    await writeLeanState(`skill-digest:${hash.slice(0, 32)}:tried`, '')
  })
})
