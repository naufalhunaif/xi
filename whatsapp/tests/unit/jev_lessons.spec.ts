import { test } from '@japa/runner'
import { lessonTarget, withLessons } from '#beta3/jev'
import { explainDecision } from '#beta3/jev_explain'

// v3.6.130 — Jev belajar dari penilaian CS di Jev accuracy (contoh fiktif).
test.group('Jev belajar dari penilaian', () => {
  test('pertanyaan dipetakan ke keputusan yang dinilai CS', ({ assert }) => {
    assert.deepEqual(lessonTarget('topik_ongkir'), { decision: 'topik', sub: 'ongkir' })
    assert.deepEqual(lessonTarget('hati_rasa'), { decision: 'hati', sub: 'rasa' })
    assert.deepEqual(lessonTarget('seri'), { decision: 'harga_konteks', sub: 'seri' })
    assert.deepEqual(lessonTarget('ulang', 'cek-balasan'), { decision: 'cek_balasan', sub: 'ulang' })
    assert.deepEqual(lessonTarget('susulan', 'cek-susulan'), { decision: 'cek_balasan', sub: 'susulan' })
    assert.deepEqual(lessonTarget('dana_masuk'), { decision: 'dana_masuk', sub: '' })
    assert.isNull(lessonTarget('ulang', 'pahami'))
    assert.isNull(lessonTarget('apa_saja'))
  })

  test('koreksi toko ikut di instruksi pertanyaan yang sama saja', ({ assert }) => {
    const lessons = new Map([
      ['dana_masuk', [{ input: 'pesanannya sudah selesai, sisa pembayarannya 400.000 bisa dilunasi', correct: 'tidak' }]],
      ['topik:ongkir', [{ input: 'Jadi berapa', correct: 'ya' }]],
    ])
    const dana = withLessons('dana_masuk', { type: 'noul' as const, instructions: 'Apakah toko menyatakan dana masuk?' }, lessons)
    assert.include(dana.instructions, 'Koreksi dari toko')
    assert.include(dana.instructions, 'sisa pembayarannya 400.000 bisa dilunasi" → tidak')
    const topic = withLessons('topik_ongkir', { type: 'noul' as const, instructions: 'Tentang ongkir?' }, lessons)
    assert.include(topic.instructions, '"Jadi berapa" → ya')
    const other = withLessons('topik_bayar', { type: 'noul' as const, instructions: 'Tentang bayar?' }, lessons)
    assert.equal(other.instructions, 'Tentang bayar?')
  })

  test('pilihan jawaban per sub-pertanyaan (tidak tercampur)', ({ assert }) => {
    const susulan = explainDecision({ decision: 'cek_balasan', answer: 'kirim', detail: 'susulan', used: 0 })
    assert.deepEqual(Object.keys(susulan.options || {}), ['kirim', 'jangan', 'kaku'])
    assert.include(susulan.question, 'follow-up')
    const ulang = explainDecision({ decision: 'cek_balasan', answer: 'tidak', detail: 'ulang', used: 1 })
    assert.deepEqual(Object.keys(ulang.options || {}), ['ya', 'tidak'])
    const rasa = explainDecision({ decision: 'hati', answer: 'netral', detail: 'rasa', used: 1 })
    assert.notProperty(rasa.options || {}, 'bertanya')
    const level = explainDecision({ decision: 'kesulitan', answer: 'tingkat 2', used: 0 })
    assert.property(level.options || {}, 'tingkat 3')
  })
})
