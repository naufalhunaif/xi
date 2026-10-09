import { test } from '@japa/runner'
import { activePromos, normalizePromos, renderPromoRule, withPromoPrices, bestPromo } from '#beta3/promos'
import { matchAutoTotal } from '#beta3/order_service'
import { allowedPrices, unknownPrices } from '#beta3/quality_service'
import { productPriceIssues } from '#beta3/reply_check'
import type { LeanCatalogRow } from '#beta3/catalog_service'

// v3.6.120 — promo website: hanya promo BIASA yang berlaku lewat chat; tidak ada = tidak ada promo lewat chat.
const row = (product: string, color: string, price: number, category = 'Suits'): LeanCatalogRow => ({
  id: 0, product, color, category, price, sizesReady: '', sizesAll: '', photoUrl: null, materialAvailable: true, features: '',
  featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '',
})
const catalog = [row('Tuxedo', 'Black', 485000), row('Tuxedo', 'Navy', 485000), row('Pants', 'Black', 220000, 'Pants')]
const raw = {
  items: [
    { name: 'Promo 10.10', scope: 'category', category: 'Suits', products: [], discount_type: 'percentage', discount_value: 10, minimum_spend: 0, starts_at: '2026-10-01 00:00:00', ends_at: '2026-10-12 23:59:59' },
    { name: 'Lewat', scope: 'all', products: [], discount_type: 'fixed', discount_value: 50000, minimum_spend: 0, starts_at: '2026-09-01 00:00:00', ends_at: '2026-09-30 23:59:59' },
  ],
  web_only: { random: 1, vouchers: 2 },
}
const during = new Date('2026-10-10T05:00:00Z')

test.group('promo website untuk chat', () => {
  test('hanya promo yang sedang berlaku; tanpa promo = tidak ada promo lewat chat', ({ assert }) => {
    const state = normalizePromos(raw)
    assert.deepEqual(activePromos(state, during).map((promo) => promo.name), ['Promo 10.10'])
    const text = renderPromoRule(state, during)
    assert.include(text, 'Promo 10.10: diskon 10% untuk kategori Suits')
    assert.include(text, 'checkout di website')
    assert.notInclude(text, 'Lewat')
    const after = renderPromoRule(state, new Date('2026-10-20T05:00:00Z'))
    assert.include(after, 'tidak ada promo untuk pesanan lewat chat')
    assert.include(renderPromoRule(normalizePromos(null)), 'tidak ada promo')
  })

  test('total otomatis memotong promo; grosir dan promo tidak digabung', ({ assert }) => {
    const promos = activePromos(normalizePromos(raw), during)
    const result = matchAutoTotal({ rincian: 'Tuxedo - Black size L\nPants - Black no 32', subtotal: 0, layanan: 'CTC' }, catalog, [{ service: 'CTC', price: 45000 }], ['reg'], [], undefined, {}, promos)
    assert.isTrue(result.ok)
    if (!result.ok) return
    assert.equal(result.subtotal, 485000 - 48500 + 220000)
    assert.include(result.items, 'Promo 10.10 -48.500')
    // AI menulis subtotal sesudah promo → diterima.
    assert.isTrue(matchAutoTotal({ rincian: 'Tuxedo - Black size L', subtotal: 436500, layanan: 'CTC' }, catalog, [{ service: 'CTC', price: 45000 }], ['reg'], [], undefined, {}, promos).ok)
    // Min belanja tidak terpenuhi → tanpa promo.
    const min = activePromos(normalizePromos({ items: [{ ...raw.items[0], minimum_spend: 1000000 }] }), during)
    const none = matchAutoTotal({ rincian: 'Tuxedo - Black size L', subtotal: 0, layanan: 'CTC' }, catalog, [{ service: 'CTC', price: 45000 }], ['reg'], [], undefined, {}, min)
    assert.isTrue(none.ok && none.subtotal === 485000)
    // Grosir 6 jas (15.000/pcs = 90.000) vs promo 10% (291.000) → promo dipakai, satu baris saja.
    const six = matchAutoTotal({ rincian: 'Tuxedo - Black size L 6 pcs', subtotal: 0, layanan: 'CTC' }, catalog, [{ service: 'CTC', price: 45000 }], ['reg'], [], undefined, { jas: 15000 }, promos)
    assert.isTrue(six.ok)
    if (six.ok) {
      assert.equal(six.subtotal, 485000 * 6 - 291000)
      assert.notInclude(six.items, 'Diskon grosir')
    }
  })

  test('harga promo sah di pemeriksa harga; harga karangan tetap ditahan', ({ assert }) => {
    const promos = activePromos(normalizePromos(raw), during)
    const allowed = allowedPrices(catalog, [], {}, promos)
    assert.deepEqual(unknownPrices(['Tuxedo Black lagi promo jadi 436.500 bos'], allowed), [])
    assert.deepEqual(unknownPrices(['Tuxedo Black jadi 400.000 bos'], allowed), [400000])
    assert.lengthOf(productPriceIssues(['Tuxedo sekarang 436.500 bos'], withPromoPrices(catalog, promos)), 0)
    assert.isNull(bestPromo(promos, catalog[2], 220000))
  })
})
