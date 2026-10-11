import { test } from '@japa/runner'
import { dropRepeatedTopics, singleQuestion } from '#beta3/reply_guards'

// v3.6.146 — pertanyaan bertopik sama tidak diulang (chat 11 Okt: "mau model apa" 4× dalam 6 menit).
const out = (body: string) => ({ direction: 'out', body })
const inn = (body: string) => ({ direction: 'in', body })

test.group('Pertanyaan tidak berputar', () => {
  test('model sudah ditanya → tidak ditanya lagi dengan kalimat lain', ({ assert }) => {
    const history = [out('Siap bos, ukurannya saya catat.'), out('Mau model apa bos?'), inn('Lingkar lengan 47cm')]
    const res = dropRepeatedTopics(['Siap bos, lingkar lengan 47 cm dicatat.', 'Mau jas saja atau sekalian dengan celananya?'], history, 'Lingkar lengan 47cm')
    assert.isTrue(res.changed)
    assert.deepEqual(res.pesan, ['Siap bos, lingkar lengan 47 cm dicatat.'])
  })

  test('pelanggan sedang membahas topik itu → boleh ditanya', ({ assert }) => {
    const history = [out('Mau model apa bos?'), inn('ganti model aja deh')]
    assert.isFalse(dropRepeatedTopics(['Siap bos, mau model apa?'], history, 'ganti model aja deh').changed)
  })

  test('balasan tidak jadi kosong', ({ assert }) => {
    const history = [out('Mau model apa bos?')]
    const res = dropRepeatedTopics(['Mau model apa bos?'], history, 'hmm')
    assert.deepEqual(res.pesan, ['Mau model apa bos?'])
  })

  test('satu pertanyaan per balasan', ({ assert }) => {
    const res = singleQuestion(['Lingkar pinggang 27 itu inci atau cm bos?', 'Untuk warnanya mau hitam atau abu?'])
    assert.deepEqual(res.pesan, ['Lingkar pinggang 27 itu inci atau cm bos?'])
    assert.isFalse(singleQuestion(['Harganya 485.000 bos.', 'Mau model apa?']).changed)
  })
})
