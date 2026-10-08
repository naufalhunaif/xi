import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { mergeDigest } from '#beta3/skill_digest'
import { trimSkill } from '#beta3/token_saver'

// v3.6.59 — chat Agus & Nofita 7 Okt: bahasa AI kaku. "Kancing 1 ..ya" (bertanya) dijawab "dicatat ya",
// kalimat yang sama diulang ("dicatat ya", "cocok ya?"), pelanggan mundur karena harga dibalas
// "Siap sama sama bos" lalu disusul tawaran. Bagian "Rasa" di skill inti: baca maksud & perasaan dulu.
const root = new URL('../../skills-beta3/beta3-cs-inti/', import.meta.url)

test.group('skill Rasa (v3.6.59)', () => {
  test('bagian Rasa ada di skill & ringkasannya, selalu dimuat (tidak ikut dipangkas)', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    const digest = await readFile(new URL('DIGEST.md', root), 'utf8')
    for (const text of [
      '## Rasa — baca maksud & perasaan pelanggan',
      '**Bertanya ≠ meminta.**',
      '"Kancing 1 ..ya"',
      '"iya bos, kancingnya 1"',
      '("dicatat ya", "cocok ya?")',
      '"untuk gaya gen z biasanya slimfit warna gelap seperti Basic Suit bos, simpel dan rapi"',
      '"siap bos, kalau nanti mau lihat lagi kabari saya ya"',
      'Bukan "siap sama sama bos"',
    ])
      assert.include(skill, text)
    const merged = mergeDigest(skill, digest)!
    assert.include(merged.text, '## Rasa — baca maksud & perasaan pelanggan')
    assert.notInclude(merged.fallback, 'Rasa — baca maksud & perasaan pelanggan')
    const trimmed = trimSkill(merged.text, {
      size: false, spec: false, catalog: false, shipping: false, paid: false, photo: false, instagram: false,
    })
    assert.include(trimmed.text, '**Bertanya ≠ meminta**')
  })

  test('"siap sama sama bos" bukan lagi penutup umum — hanya balasan terima kasih', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    assert.notInclude(skill, 'CS yang menutup percakapan: "siap sama sama bos"')
    assert.include(skill, 'Terima kasih sesudah pesan toko ("siap terimakasih", "makasih") → "Siap sama sama bos" saja')
  })
})
