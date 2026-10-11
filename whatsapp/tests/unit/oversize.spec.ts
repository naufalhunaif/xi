import { test } from '@japa/runner'
import { capOversize, maxCatalogSize } from '#beta3/reply_guards'

// v3.6.145 — size di atas varian terbesar (chat 11 Okt: "5XL bisa dibuatkan" → salah).
test.group('Size di atas varian terbesar', () => {
  test('varian terbesar dari katalog', ({ assert }) => {
    assert.equal(maxCatalogSize([{ sizesAll: 'S M L XL XXL 3XL 4XL' }, { sizesAll: 'S M L XL', sizesReady: 'S M' }]), '4XL')
    assert.equal(maxCatalogSize([{ sizesAll: 'S M L XL XXL' }]), 'XXL')
  })

  test('5XL tidak disanggupi', ({ assert }) => {
    const out = capOversize(
      ['Size 5XL bisa dibuatkan. Untuk size besar harga jas mulai 585.000 (Basic Suit, Tuxedo, Peak Suit), setelan dengan celana 855.000', 'Mau model apa bos?'],
      'Adalah size 5xl ??brp harga ?',
      '4XL'
    )
    assert.isTrue(out.changed)
    assert.equal(out.pesan[0], 'Size paling besar 4XL bos, 5XL belum bisa dibuatkan.')
    assert.notInclude(out.pesan.join(' '), '5XL bisa')
    assert.include(out.pesan.join(' '), '585.000')
    // "xxxxxl" juga dikenali.
    assert.isTrue(capOversize(['Bisa bos'], 'ada xxxxxl?', '4XL').changed)
  })

  test('size yang ada tidak diubah', ({ assert }) => {
    assert.isFalse(capOversize(['4XL ada bos'], 'ada 4xl?', '4XL').changed)
    assert.isFalse(capOversize(['XXL ready bos'], 'xxl ada?', '4XL').changed)
  })
})
