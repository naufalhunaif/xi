import { test } from '@japa/runner'
import { createCatalogPricePatternIndex } from '#services/catalog_price_pattern'

const product = (
  id: string,
  color: string,
  price = 535000,
  extra: Record<string, unknown> = {}
) => ({
  id,
  name: `Tuxedo Double Breasted - ${color}`,
  is_active: 1,
  currency: 'IDR',
  material: 'Material A',
  sizes: [
    { size_name: 'S', price },
    { size_name: 'M', price },
  ],
  ...extra,
})
const result = (row: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(row) }] })

test.group('Internal catalog price samples', () => {
  test('old detail reads expire and cache rereads do not refresh evidence age', ({ assert }) => {
    let now = 0
    const read = createCatalogPricePatternIndex(() => now)
    read('a', 'get_product', result(product('1', 'BW')), 0)
    now = 30_000
    read('a', 'get_product', result(product('1', 'BW')), 0)
    assert.isNotNull(read('a', 'get_product', result(product('2', 'Navy')), now))
    now = 60_000
    assert.isNull(read('a', 'get_product', result(product('2', 'Navy')), 30_000))
    assert.isNull(read('a', 'get_product', result(product('1', 'BW')), 0))
  })
  test('computes actual same-size prices, counts products once and retains exceptions', ({
    assert,
  }) => {
    const read = createCatalogPricePatternIndex()
    assert.isNull(read('catalog', 'get_product', result(product('1', 'Navy'))))
    assert.isNull(read('catalog', 'get_product', result(product('1', 'Navy'))))
    const uniform = read('catalog', 'get_product', result(product('2', 'BW')))!
    assert.equal(uniform.status, 'internal_review_only')
    assert.equal(uniform.patterns[0].dominantPrice, 535000)
    assert.equal(uniform.patterns[0].products, 2)
    assert.isTrue(uniform.patterns[0].consistent)
    const varied = read('catalog', 'get_product', result(product('3', 'Black', 600000)))!
    assert.equal(varied.patterns[0].dominantPrice, 535000)
    assert.equal(varied.patterns[0].max, 600000)
    assert.isFalse(varied.patterns[0].consistent)
    const changed = read('catalog', 'get_product', result(product('1', 'Navy', 600000)))!
    assert.equal(changed.patterns[0].dominantPrice, 600000)
    assert.equal(changed.patterns[0].products, 3)
    assert.notProperty(changed, 'unitPrice')
  })

  test('does not promote a tie or transfer a price across sizes', ({ assert }) => {
    const read = createCatalogPricePatternIndex()
    read('a', 'get_product', result(product('1', 'Navy')))
    const compared = read(
      'a',
      'get_product',
      result(
        product('2', 'Black', 600000, {
          sizes: [
            { size_name: 'S', price: 600000 },
            { size_name: 'XL', price: 800000 },
          ],
        })
      )
    )!
    assert.lengthOf(compared.patterns, 1)
    assert.isNull(compared.patterns[0].dominantPrice)
    assert.equal(compared.patterns[0].min, 535000)
    assert.equal(compared.patterns[0].size, 's')
  })

  test('isolates sources, model tiers, materials, currencies and independent runs', ({
    assert,
  }) => {
    const read = createCatalogPricePatternIndex()
    read('a', 'get_product', result(product('1', 'Navy')))
    for (const row of [
      product('2', 'BW', 535000, { material: 'Material B' }),
      product('3', 'BW', 535000, { currency: 'USD' }),
      product('4', 'BW', 535000, { name: 'Premium Tuxedo Double Breasted - BW' }),
      product('5', 'BW', 535000, { name: 'Tuxedo Double Breasted Set - BW' }),
      product('6', 'BW', 535000, { material: undefined }),
    ])
      assert.isNull(read('a', 'get_product', result(row)))
    assert.isNull(read('b', 'get_product', result(product('7', 'BW'))))
    assert.isNull(createCatalogPricePatternIndex()('a', 'get_product', result(product('2', 'BW'))))
  })

  test('ignores listings, errors, inactive products and misleading or custom prices', ({
    assert,
  }) => {
    const read = createCatalogPricePatternIndex()
    read('a', 'get_product', result(product('1', 'Navy')))
    assert.isNull(read('a', 'list_products', result(product('2', 'BW'))))
    assert.isNull(read('a', 'get_product', { ...result(product('2', 'BW')), isError: true }))
    for (const extra of [
      { is_active: 0 },
      { status: 'archived' },
      { sizes: [{ size_name: 'custom', price: 535000 }] },
      { sizes: [{ size_name: 'S', internal_price: 535000 }] },
      { sizes: [{ size_name: 'S', price: null }] },
      { sizes: [{ size_name: 'S', price: '535.000 mulai dari' }] },
      {
        sizes: [
          { size_name: 'S', price: 535000 },
          { size_name: 'S', price: 600000 },
        ],
      },
    ])
      assert.isNull(read('a', 'get_product', result(product('2', 'BW', 535000, extra))))
  })

  test('inactive or unpriced updated products cannot remain in later samples', ({ assert }) => {
    const read = createCatalogPricePatternIndex()
    read('a', 'get_product', result(product('1', 'Navy')))
    read('a', 'get_product', result(product('2', 'BW')))
    read('a', 'get_product', result(product('1', 'Navy', 535000, { is_active: 0 })))
    assert.isNull(read('a', 'get_product', result(product('2', 'BW'))))
  })
})
