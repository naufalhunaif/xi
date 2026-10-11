import { test } from '@japa/runner'
import { stripWeakParts } from '#beta3/reply_check'

// v3.6.164 — tiap bagian balasan ditinjau; bagian lemah tidak diikutkan.
test.group('tinjauan per bagian balasan', () => {
  test('kalimat basa-basi dan ekor lemah dibuang; template & rincian utuh', ({ assert }) => {
    const out = stripWeakParts([
      'Jas 485.000 bos, setelan 705.000. Semoga membantu ya!',
      'Untuk pembayaran tf ke rek BRI 1234 an Toko agar pesanan langsung kami proses',
      'Kancing 2 bisa bos, tambahan detailnya nanti saya kabari harganya',
      'Jangan ragu hubungi kami lagi',
      'Bisa dibantu isi format ordernya bos\nNama :\nAlamat lengkap :',
    ])
    assert.deepEqual(out.pesan, [
      'Jas 485.000 bos, setelan 705.000.',
      'Untuk pembayaran tf ke rek BRI 1234 an Toko agar pesanan langsung kami proses',
      'Kancing 2 bisa bos',
      'Bisa dibantu isi format ordernya bos\nNama :\nAlamat lengkap :',
    ])
    assert.lengthOf(out.dibuang, 3)
    assert.isTrue(out.dibuang.every((item) => item.tujuan === 'lemah'))
  })

  test('balasan pendek yang perlu tidak diubah', ({ assert }) => {
    const out = stripWeakParts(['Iya aman bos, M masih masuk', 'Celananya pakai nomor berapa bos?'])
    assert.deepEqual(out.pesan, ['Iya aman bos, M masih masuk', 'Celananya pakai nomor berapa bos?'])
    assert.lengthOf(out.dibuang, 0)
  })
})
