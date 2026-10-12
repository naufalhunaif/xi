import { test } from '@japa/runner'
import { dropOpenerRepeat, quickOpener } from '#beta3/quick_opener'
import { assignQuotes } from '#beta3/reply_quotes'

// v3.6.158 — pembuka cepat (dikirim sebelum model selesai) & balasan yang mengutip pesan pelanggan.
test.group('pembuka cepat', () => {
  test('ukuran badan → "dicatat" tanpa fakta; salam dijawab; gabungan keduanya', ({ assert }) => {
    assert.equal(quickOpener({ text: 'Bb 96 tb 170cm, dada 120 bahu 53' }), 'Siap bos, tinggi 170, berat 96, dada 120 dicatat ya')
    assert.equal(quickOpener({ text: 'Assalamualaikum mas selamat sore' }), 'Waalaikumsalam bos')
    assert.equal(quickOpener({ text: 'assalamualaikum, tinggi 178 bb 80 masuk L atau XL?', address: 'kak' }), 'Waalaikumsalam kak, tinggi 178, berat 80 dicatat ya')
  })

  test('bukti transfer / sudah bayar / form order; pertanyaan biasa tanpa pembuka', ({ assert }) => {
    assert.equal(quickOpener({ text: '', hasImage: true, awaitingPayment: true }), 'Siap bos, bukti transfernya kami cek dulu ya')
    assert.equal(quickOpener({ text: 'udah tf ya kak', paidClaim: true }), 'Siap bos, kami cek dulu ya')
    assert.equal(quickOpener({ text: 'Nama: Budi\nAlamat: …', formReceived: true }), 'Siap bos, datanya sudah masuk ya')
    assert.equal(quickOpener({ text: 'jas navy XL ready?' }), '')
    assert.equal(quickOpener({ text: 'ini berapa?', hasImage: true }), '')
    // Toko baru saja bilang hal yang sama → tidak diulang.
    assert.equal(quickOpener({ text: 'tb 170 bb 96', recentStore: ['Siap bos, tinggi 170, berat 96 dicatat ya'] }), '')
  })

  test('balasan model yang mengulang pembuka dibuang, isinya tetap', ({ assert }) => {
    const opener = 'Siap bos, tinggi 170, berat 96 dicatat ya'
    assert.deepEqual(dropOpenerRepeat(['Siap bos, tinggi 170 dan berat 96 sudah saya catat.', 'Dada 120 paling dekat 3XL bos'], opener), ['Dada 120 paling dekat 3XL bos'])
    assert.deepEqual(dropOpenerRepeat(['Siap bos, dicatat ya. Dada 120 paling dekat size 3XL (dadanya 120 cm)'], opener), ['Dada 120 paling dekat size 3XL (dadanya 120 cm)'])
    assert.deepEqual(dropOpenerRepeat(['Waalaikumsalam bos, jasnya 485.000'], 'Waalaikumsalam bos'), ['Jasnya 485.000'])
    assert.deepEqual(dropOpenerRepeat(['Waalaikumsalam bos'], 'Waalaikumsalam bos'), [])
  })
})

test.group('balasan mengutip pesan pelanggan', () => {
  const messages = [
    { id: 'm1', text: 'Bahan putihnya glossy atau doff ka?' },
    { id: 'm2', text: 'terus celana no 33 ada?' },
  ]
  test('dua pertanyaan → tiap bubble mengutip pesan yang dijawabnya', ({ assert }) => {
    assert.deepEqual(assignQuotes(['Bahan putihnya doff bos', 'Celana no 33 ready bos'], messages), ['m1', 'm2'])
    // Pembuka tanpa kutipan, jawaban pesan terakhir tanpa kutipan bila tak ada yang mengutip pesan sebelumnya.
    assert.deepEqual(assignQuotes(['Siap bos', 'Celana no 33 ready bos'], messages), [null, null])
    assert.deepEqual(assignQuotes(['Siap bos', 'Bahannya doff bos'], messages), [null, 'm1'])
  })
  test('satu pesan pelanggan atau tidak jelas → tanpa kutipan', ({ assert }) => {
    assert.deepEqual(assignQuotes(['Doff bos'], [messages[0]]), [null])
    assert.deepEqual(assignQuotes(['Iya bisa bos'], messages), [null])
  })
})

// v3.6.171 — uji alur #59 real-28: jawaban size jangan ikut terbuang sebagai "ulangan pembuka".
test.group('pembuka cepat: info baru tidak dibuang', () => {
  test('kalimat size tetap, ulangan murni dibuang', async ({ assert }) => {
    const { dropOpenerRepeat } = await import('#beta3/quick_opener')
    const opener = 'Siap bos, tinggi 175, berat 77 dicatat ya'
    assert.deepEqual(dropOpenerRepeat(['Tinggi 175 berat 77 masuk XL bos'], opener), ['Tinggi 175 berat 77 masuk XL bos'])
    assert.deepEqual(dropOpenerRepeat(['Siap bos, tinggi 175 berat 77 sudah dicatat ya', 'Masuknya size XL bos'], opener), ['Masuknya size XL bos'])
    assert.deepEqual(dropOpenerRepeat(['Siap bos, dicatat ya. Dada 120 paling dekat 3XL'], opener), ['Dada 120 paling dekat 3XL'])
  })
})
