import { test } from '@japa/runner'
import { addLesson, listLessons, removeLesson, renderLessons, saveSimCorrection } from '#beta3/sim_lessons'
import { listLeanExamples, removeLeanExample } from '#beta3/examples_service'
import { renderCorrections } from '#beta3/prompt'

// v3.6.161 — uji tidak sia-sia: kesalahan jadi koreksi + pelajaran untuk chat berikutnya.
test.group('pelajaran dari uji', () => {
  test('pelajaran mirip digabung, dirangkum ke prompt, bisa dihapus', async ({ assert }) => {
    const before = await listLessons()
    for (let i = 0; i < before.length; i++) await removeLesson(0)
    await addLesson('Saat pelanggan menyebut warna di luar katalog, jawab belum ada dan tawarkan warna terdekat', 'real-1')
    await addLesson('Saat warna yang diminta tidak ada di katalog, jawab "belum ada bos" lalu tawarkan warna terdekat', 'real-2')
    await addLesson('Saat ditanya rekening, kirim rekening dulu sebelum bertanya size', 'real-3')
    const list = await listLessons()
    assert.lengthOf(list, 2)
    assert.equal(list[0].count, 2)
    assert.deepEqual(list[0].contoh, ['real-1', 'real-2'])
    const text = renderLessons(list)
    assert.include(text, 'PELAJARAN DARI UJI')
    assert.include(text, '1. Saat pelanggan menyebut warna di luar katalog')
    assert.isTrue(await removeLesson(0))
    assert.lengthOf(await listLessons(), 1)
    await removeLesson(0)
    assert.isNull(await addLesson('terlalu pendek'))
  })

  test('koreksi penilai jadi contoh "Koreksi uji" sekali per pertanyaan; tampil terpisah dari koreksi pemilik', async ({ assert }) => {
    const customerText = 'uji-koreksi: celana no 33 hitam ada?'
    assert.isTrue(await saveSimCorrection({ customerText, correct: 'Celana no 33 Black 2.0 ready bos, 220.000', lesson: 'Jawab stok dulu', scenarioId: 'real-9' }))
    assert.isFalse(await saveSimCorrection({ customerText, correct: 'lain', lesson: '', scenarioId: 'real-9' }))
    const saved = (await listLeanExamples()).filter((example) => example.source === 'uji' && example.customerText === customerText)
    assert.lengthOf(saved, 1)
    assert.equal(saved[0].situation, 'Koreksi uji: Jawab stok dulu')
    const text = renderCorrections([{ situation: '', customerText: 'A', csText: 'B', tags: '', source: 'koreksi' }, saved[0]])
    assert.include(text, 'KOREKSI DARI PEMILIK')
    assert.include(text, 'KOREKSI DARI UJI')
    assert.include(text, 'Seharusnya: Celana no 33 Black 2.0 ready bos')
    for (const example of saved) await removeLeanExample(example.id!)
  })
})
