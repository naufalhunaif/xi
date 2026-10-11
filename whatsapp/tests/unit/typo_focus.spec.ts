import { test } from '@japa/runner'
import { focusCatalog } from '#beta3/token_saver'
import { catalogColorSearchHints } from '#services/color_semantics'
import type { LeanCatalogRow } from '#beta3/catalog_service'

// v3.6.143 — salah ketik model/warna dari uji 40 pertanyaan acak (data contoh).
const row = (id: number, product: string, color: string): LeanCatalogRow => ({
  id, product, color, category: 'Suits', price: 485000, sizesReady: 'S M', sizesAll: '', photoUrl: null, materialAvailable: true,
  features: '', featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '',
})
let id = 0
const rows = ['Basic Suit', 'Tuxedo', 'Peak Suit', 'Beskap Clean Look', 'Bescap Cross Placket'].flatMap((product) =>
  ['Black', 'Navy', 'Denim', 'Gold', 'Choco'].map((color) => row(++id, product, color))
)
const ask = (text: string) => focusCatalog(rows, { text, history: [], spec: '', chatNote: '', imageCount: 0 })

test.group('Salah ketik model & warna', () => {
  test('"besik suit" dan "tuksedo" membuka modelnya', ({ assert }) => {
    assert.isTrue(ask('misi pengen lihat yang denim besik suit')!.rows.some((r) => r.product === 'Basic Suit' && r.color === 'Denim'))
    assert.isTrue(ask('liat tuksedo irng & nevi dong bos')!.rows.some((r) => r.product === 'Tuxedo' && r.color === 'Black'))
  })

  test('"bescap" juga membuka Beskap Clean Look', ({ assert }) => {
    const picked = ask('min, pengen lihat yang gold sm hitem bescap ya')!.rows
    assert.isTrue(picked.some((r) => r.product === 'Bescap Cross Placket' && r.color === 'Black'))
    assert.isTrue(picked.some((r) => r.product === 'Beskap Clean Look'))
  })

  test('"irng" dan "itam" = hitam', ({ assert }) => {
    assert.equal(catalogColorSearchHints(['irng'])[0]?.catalogColor, 'hitam')
    assert.equal(catalogColorSearchHints(['itam'])[0]?.catalogColor, 'hitam')
  })
})
