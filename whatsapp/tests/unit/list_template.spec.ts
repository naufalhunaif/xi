import { test } from '@japa/runner'
import { listReference, trimOrderTemplate } from '#beta3/reply_guards'

// v3.6.132 — rujukan urutan daftar & format order (contoh fiktif).
const store = (body: string) => ({ direction: 'out', body })
const list = store('Basic suit warnanya ada Army, Black, Blue Ice, Brown, Choco, Cream, Dark Gray, Denim, Light Gray, Maroon, Navy, sama Coast')

test.group('Rujukan urutan & format order', () => {
  test('"kedua dari terakhir" dihitung dari daftar toko terakhir', ({ assert }) => {
    assert.equal(listReference('yg kedua dr terakhir itu fotonya dong', [list])?.item, 'Navy')
    assert.equal(listReference('yang pertama aja', [list])?.item, 'Army')
    assert.equal(listReference('yang terakhir itu', [list])?.item, 'Coast')
    assert.equal(listReference('yang ke 3 dong', [list])?.item, 'Blue Ice')
    assert.isNull(listReference('ini pesanan pertama saya kak, biasanya lama ga ya pengirimannya ke luar jawa', [list]))
    assert.isNull(listReference('yang kedua', [store('ada yang lain bos?')]))
  })

  test('format order: baris yang sudah dijawab & kode pos dibuang', ({ assert }) => {
    const template = 'Bisa di bantu isi order formatnya bos\n\nNama :\nAlamat lengkap :\nKecamatan :\nKabupaten :\nKode Pos :\nNo. telp :\n\nNote :'
    const trimmed = trimOrderTemplate([template], ['kirim ke jl melati sukamaju patimuan cilacap'])
    assert.isTrue(trimmed.changed)
    assert.notInclude(trimmed.pesan[0], 'Kode Pos')
    assert.notInclude(trimmed.pesan[0], 'Alamat lengkap')
    assert.include(trimmed.pesan[0], 'Nama :')
    assert.include(trimmed.pesan[0], 'No. telp :')
    const fresh = trimOrderTemplate([template], ['mau order basic hitam size S'])
    assert.notInclude(fresh.pesan[0], 'Kode Pos')
    assert.include(fresh.pesan[0], 'Alamat lengkap :')
    assert.isFalse(trimOrderTemplate(['Siap bos'], ['jl melati']).changed)
  })
})
