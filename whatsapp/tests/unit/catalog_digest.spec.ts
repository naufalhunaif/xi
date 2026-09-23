import { test } from '@japa/runner'
import {
  shapeCatalogResult,
  isProductListing,
  isUnfilteredProductListing,
} from '#services/catalog_digest_service'
import { mcpCacheTtl, cacheableMcpResult } from '#services/mcp_cache_policy'

const product = (index: number) => ({
  id: `11111111-2222-3333-4444-00000000000${index}`,
  name: `Basic Suit ${index}`,
  public_name: `Jas Formal ${index}`,
  sku: `SKU-${index}`,
  internal_price: 500000,
  weight: 1200,
  image_urls: [
    'https://store.example.test/uploads/products/very-long-image-name-front.jpg',
    'https://store.example.test/uploads/products/very-long-image-name-back.jpg',
  ],
  is_active: 1,
  archived_at: null,
  created_at: '2026-01-01 00:00:00',
  category: 'Suit',
  variants: 12,
  stock: 40,
})
const envelope = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError: false,
})
const listing = (count: number) => ({
  rows: Array.from({ length: count }, (_, index) => product(index)),
  total: count,
  store_id: 'store-1',
})
const parse = (result: any) => JSON.parse(result.content[0].text)

test.group('Catalog listing shaping', () => {
  test('recognises only an unfiltered product listing', ({ assert }) => {
    assert.isTrue(isProductListing('list_records', { resource: 'products' }))
    assert.isTrue(isUnfilteredProductListing('list_records', { resource: 'products' }))
    assert.isTrue(isUnfilteredProductListing('list_records', { resource: 'products', q: '  ' }))
    assert.isFalse(isUnfilteredProductListing('list_records', { resource: 'products', q: 'navy' }))
    assert.isFalse(isUnfilteredProductListing('list_records', { resource: 'categories' }))
    assert.isFalse(isUnfilteredProductListing('get_record', { resource: 'products' }))
  })

  test('covers the catalogue tools whatever the row key is called', ({ assert }) => {
    // The connection that serves the catalogue exposes list_products as well as list_records.
    assert.isTrue(isUnfilteredProductListing('list_products', {}))
    assert.isFalse(isUnfilteredProductListing('list_products', { query: 'navy' }))
    assert.isFalse(isUnfilteredProductListing('list_products', { search: 'navy' }))
    const rows = Array.from({ length: 4 }, (_, index) => product(index))
    for (const key of ['rows', 'products', 'data']) {
      const shaped = shapeCatalogResult('list_products', {}, envelope({ [key]: rows, total: 4 }))
      assert.equal(shaped.shape, 'digest', key)
      assert.lengthOf(parse(shaped.result).products, 4)
    }
    // A list that is not products is left alone even under a products-shaped key.
    const other = envelope({ rows: [{ code: 'JNE', service: 'REG' }] })
    assert.equal(shapeCatalogResult('list_products', {}, other).shape, 'unchanged')
  })

  test('drops every photo url variant from a keyword search', ({ assert }) => {
    const rows = [
      { id: 'p1', name: 'Jas', img: 'https://x.test/a.jpg', images: ['https://x.test/b.jpg'] },
      {
        id: 'p2',
        name: 'Celana',
        image_url: 'https://x.test/c.jpg',
        thumbnail_url: 'https://x.test/d.jpg',
      },
    ]
    const shaped = shapeCatalogResult(
      'list_products',
      { query: 'navy' },
      envelope({ products: rows })
    )
    assert.equal(shaped.shape, 'trimmed')
    const value = parse(shaped.result)
    assert.lengthOf(value.products, 2)
    for (const field of ['img', 'images', 'image_url', 'thumbnail_url'])
      assert.notProperty({ ...value.products[0], ...value.products[1] }, field)
    for (const row of value.products) assert.property(row, 'name')
  })

  test('replaces a full scan with an identity digest', ({ assert }) => {
    const shaped = shapeCatalogResult(
      'list_records',
      { resource: 'products' },
      envelope(listing(300))
    )
    assert.equal(shaped.shape, 'digest')
    assert.equal(shaped.rows, 300)
    const value = parse(shaped.result)
    assert.lengthOf(value.products, 300)
    assert.equal(value.total, 300)
    assert.equal(value.store_id, 'store-1')
    assert.equal(
      value.products[0],
      '11111111-2222-3333-4444-000000000000 | Basic Suit 0 (Jas Formal 0) | Suit'
    )
    // Price, stock and photos must not be quotable from a cached snapshot.
    const serialised = JSON.stringify(value)
    for (const leak of ['500000', 'image_urls', 'store.example.test', '"stock"', 'internal_price'])
      assert.notInclude(serialised, leak)
    // A stale snapshot must not read as an exhaustive catalogue.
    assert.include(value.note, 'q')
    assert.include(value.note, 'JANGAN')
    assert.isBelow(shaped.after, shaped.before / 4)
  })

  test('keeps every catalog identity, numeric IDs and upstream continuation', ({ assert }) => {
    const shaped = shapeCatalogResult(
      'list_products',
      {},
      envelope({
        products: Array.from({ length: 10000 }, (_, id) => ({ id, name: 'Produk ' + id })),
        total: 20000,
        next_cursor: 'page-2',
        has_more: true,
      })
    )
    const value = parse(shaped.result)
    assert.lengthOf(value.products, 10000)
    assert.match(value.products[0], /^0 \| Produk 0/)
    assert.match(value.products[9999], /^9999 \| Produk 9999/)
    assert.equal(value.total, 20000)
    assert.equal(value.next_cursor, 'page-2')
    assert.isTrue(value.has_more)
    const search = parse(
      shapeCatalogResult('list_products', { query: 'suit' }, envelope(listing(100))).result
    )
    assert.lengthOf(search.rows, 100)
  })

  test('a keyword search keeps its rows and only loses the photo links', ({ assert }) => {
    const shaped = shapeCatalogResult(
      'list_records',
      { resource: 'products', q: 'navy' },
      envelope(listing(3))
    )
    assert.equal(shaped.shape, 'trimmed')
    const value = parse(shaped.result)
    assert.lengthOf(value.rows, 3)
    // Everything the model needs to identify and price-check the row survives.
    for (const field of ['id', 'name', 'sku', 'internal_price', 'category', 'stock', 'variants'])
      assert.property(value.rows[0], field)
    assert.notProperty(value.rows[0], 'image_urls')
    assert.include(value.note, 'get_record')
    assert.isBelow(shaped.after, shaped.before)
  })

  test('never shapes a result the app itself parses', ({ assert }) => {
    // Guide results carry a url the business guide service reads, so they must stay intact.
    const guide = envelope({
      rows: [
        {
          id: 'g1',
          name: 'Panduan ukur',
          image_url: 'https://x.test/g.jpg',
          url: 'https://x.test/g.pdf',
        },
      ],
    })
    for (const tool of [
      'get_product',
      'check_shipping_rates',
      'fit_advisor',
      'read_conversation_history',
      'list_tutorials',
      'search_tutorials',
      'get_tutorial',
      'list_size_charts',
      'search_size_charts',
      'get_size_chart',
    ]) {
      const shaped = shapeCatalogResult(tool, {}, guide)
      assert.equal(shaped.shape, 'unchanged', tool)
      assert.strictEqual(shaped.result, guide)
    }
  })

  test('drops photo urls from any other server listing, not just the catalogue', ({ assert }) => {
    // Data sits on separate MCP servers, so the rule follows the result shape, not the name.
    const shaped = shapeCatalogResult(
      'list_orion_data',
      { resource: 'shipments' },
      envelope({
        data: [
          {
            id: 'o1',
            name: 'Paket A',
            img: 'https://x.test/a.jpg',
            label_url: 'https://x.test/l.pdf',
          },
        ],
      })
    )
    assert.equal(shaped.shape, 'trimmed')
    const row = parse(shaped.result).data[0]
    assert.notProperty(row, 'img')
    // Only photo fields go; anything else the server returns is left alone.
    assert.equal(row.label_url, 'https://x.test/l.pdf')
    assert.equal(row.name, 'Paket A')
  })

  test('passes through anything it does not recognise', ({ assert }) => {
    for (const [tool, args, result] of [
      ['get_record', { resource: 'products' }, envelope(product(1))],
      ['list_records', { resource: 'products' }, { content: [{ type: 'text', text: 'not json' }] }],
      ['list_records', { resource: 'products' }, { ...envelope(listing(2)), isError: true }],
      ['list_records', { resource: 'products' }, envelope({ rows: [] })],
      [
        'list_records',
        { resource: 'categories' },
        envelope({ rows: [{ id: 'c1', name: 'Suit' }] }),
      ],
      ['check_shipping_rates', {}, envelope({ ok: true })],
      ['list_records', { resource: 'products' }, null],
    ] as const) {
      const shaped = shapeCatalogResult(tool, args as Record<string, any>, result)
      assert.equal(shaped.shape, 'unchanged', tool + JSON.stringify(args))
      assert.strictEqual(shaped.result, result)
    }
  })

  test('keeps structured content consistent with the text block', ({ assert }) => {
    const value = listing(2)
    const shaped = shapeCatalogResult(
      'list_records',
      { resource: 'products' },
      { ...envelope(value), structuredContent: value }
    )
    assert.equal(shaped.shape, 'digest')
    assert.deepEqual((shaped.result as any).structuredContent, parse(shaped.result))
  })

  test('holds the snapshot the digest is built from, and only when it has rows', ({ assert }) => {
    assert.equal(mcpCacheTtl('list_records', { resource: 'products' }), 6 * 60 * 60_000)
    // A keyword search stays live so a newly added product is still findable.
    assert.equal(mcpCacheTtl('list_records', { resource: 'products', q: 'navy' }), 0)
    assert.equal(mcpCacheTtl('list_records', { resource: 'categories' }), 0)
    const args = { resource: 'products' }
    assert.isTrue(cacheableMcpResult('list_records', args, envelope(listing(2))))
    assert.isFalse(cacheableMcpResult('list_records', args, envelope({ rows: [] })))
    assert.isFalse(
      cacheableMcpResult('list_records', args, { ...envelope(listing(2)), isError: true })
    )
  })

  test('stock is never served from a snapshot', ({ assert }) => {
    // Stock is the field that actually moves, so every path that can report it stays live.
    for (const tool of ['get_record', 'get_product', 'get_product_options', 'store_overview'])
      assert.equal(mcpCacheTtl(tool, { resource: 'products', id: 'p1' }), 0, tool)
    assert.equal(mcpCacheTtl('list_records', { resource: 'products', q: 'navy' }), 0)
    // The cached snapshot carries identity only; there is no stock in it to go stale.
    const shaped = shapeCatalogResult(
      'list_records',
      { resource: 'products' },
      envelope(listing(5))
    )
    assert.notInclude(JSON.stringify(parse(shaped.result)), 'stock')
  })
})
