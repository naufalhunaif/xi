import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { talksWholesale, wholesaleOrder } from '#beta3/reply_service'
import { CATALOG_SYNC_SCHEMA, renderWholesale, syncLeanCatalog } from '#beta3/mcp'
import { writeLeanState } from '#beta3/tables'
import db from '#services/workspace_database'
import { lineQty, matchAutoTotal, renderTotalMessage } from '#beta3/order_service'
import { renderWholesaleRule, wholesaleDiscounts, wholesaleGroup } from '#beta3/wholesale'

// v3.6.56 — "pesan banyak dapat diskon?" bisa dijawab: diskon grosir per kategori (potongan tetap
// per pcs) diatur di website (Admin → Invoice → Diskon grosir) dan ikut catalog_digest (wholesale).
// v3.6.60 — syarat pemilik: mulai 6 jas (setelan = jas + celana, dihitung jas). Bila terpenuhi, jas,
// setelan, celana, rompi di pesanan dipotong per pcs dan total otomatis dikirim dengan baris potongan
// (dulu "grosir: ya" menahan total untuk invoice). Celana/rompi tanpa 6 jas: tanpa potongan.
const discounts = { celana: 10000, setelan: 25000, jas: 15000, rompi: 5000 }
const catalog = [
  { product: 'Basic Suit', color: 'Black 2.0', price: 485000, note: '', active: true, category: 'Suits' },
  { product: 'Setelan Basic Suit', color: 'Black 2.0', price: 705000, note: '', active: true, category: 'Setelan' },
  { product: 'Pants', color: 'Black 2.0', price: 220000, note: '', active: true, category: 'Pants' },
  { product: 'Vest', color: 'Black 2.0', price: 165000, note: '', active: true, category: 'Vest' },
]
const prices = [{ service: 'CTC', price: 30000 }]
const draft = (rincian: string, subtotal = 0) => ({ rincian, subtotal, layanan: 'CTC' })

test.group('diskon grosir (v3.6.56 → v3.6.60)', () => {
  test('topik pesanan banyak / diskon dikenali; pertanyaan biasa tidak', ({ assert }) => {
    for (const text of [
      'Misal pesen banyak dapet diskon gak nih',
      'kalau 60-80 jas sekali pesan bisa? buat seragam kantor',
      'ambil 20 stel ada potongan?',
      'harga grosir berapa min',
      'kalau ambil 6 jas gimana',
    ])
      assert.isTrue(talksWholesale(text), text)
    for (const text of ['Basic suit hitam ready size M?', 'ongkir ke Cilacap berapa', 'jas + celana berapa', 'ambil 2 jas'])
      assert.isFalse(talksWholesale(text), text)
  })

  test('6 jas → jas & rompi dipotong per pcs, total otomatis memuat baris potongan', ({ assert }) => {
    const result = matchAutoTotal(
      draft('Basic Suit - Black 2.0 size M 2 pcs\nBasic Suit - Black 2.0 size L 4 pcs\nVest - Black 2.0 size L 6 pcs'),
      catalog, prices, ['reg'], [], undefined, discounts
    )
    assert.isTrue(result.ok)
    if (!result.ok) return
    // 6 × 485.000 + 6 × 165.000 = 3.900.000; potongan 6 × 15.000 + 6 × 5.000 = 120.000.
    assert.equal(result.discount, 120000)
    assert.equal(result.subtotal, 3780000)
    assert.include(result.items, 'Diskon grosir 6 jas -120.000')
    const message = renderTotalMessage({ items: result.items, subtotal: result.subtotal, shippingService: 'CTC', shippingCost: 30000 })
    assert.include(message, 'Diskon grosir 6 jas -120.000')
    assert.include(message, 'Total 3.780.000 + 30.000 = 3.810.000 bos')
  })

  test('setelan dihitung jas; celana ikut dipotong; subtotal AI sebelum/sesudah potongan sama-sama diterima', ({ assert }) => {
    const rincian = 'Setelan Basic Suit - Black 2.0 size M 4 pcs\nBasic Suit - Black 2.0 size L 2 pcs\nPants - Black 2.0 no 32 2 pcs'
    // 4 × 705.000 + 2 × 485.000 + 2 × 220.000 = 4.230.000; potongan 4 × 25.000 + 2 × 15.000 + 2 × 10.000 = 150.000.
    for (const subtotal of [0, 4230000, 4080000]) {
      const result = matchAutoTotal(draft(rincian, subtotal), catalog, prices, ['reg'], [], undefined, discounts)
      assert.isTrue(result.ok, String(subtotal))
      assert.equal(result.ok && result.subtotal, 4080000)
    }
    assert.isFalse(matchAutoTotal(draft(rincian, 4000000), catalog, prices, ['reg'], [], undefined, discounts).ok)
  })

  test('kurang dari 6 jas, atau celana/rompi saja → tanpa potongan', ({ assert }) => {
    const five = matchAutoTotal(draft('Basic Suit - Black 2.0 size M 5 pcs\nPants - Black 2.0 no 32 5 pcs'), catalog, prices, ['reg'], [], undefined, discounts)
    assert.isTrue(five.ok)
    assert.equal(five.ok && five.discount, 0)
    assert.equal(five.ok && five.subtotal, 5 * 485000 + 5 * 220000)
    assert.notInclude(five.ok ? five.items : '', 'Diskon')
    const pants = matchAutoTotal(draft('Pants - Black 2.0 no 32 12 pcs'), catalog, prices, ['reg'], [], undefined, discounts)
    assert.equal(pants.ok && pants.discount, 0)
    // Tanpa data diskon dari website → tanpa potongan walau 6 jas.
    const none = matchAutoTotal(draft('Basic Suit - Black 2.0 size M 6 pcs'), catalog, prices, ['reg'])
    assert.equal(none.ok && none.subtotal, 6 * 485000)
  })

  test('catatan "grosir: ya" tanpa potongan (jas < 6 / jumlah tidak terbaca) → total dicek toko', ({ assert }) => {
    assert.isTrue(wholesaleOrder('produk: Basic Suit - Black 2.0\ngrosir: ya\ntahap: minta_alamat'))
    assert.isFalse(wholesaleOrder('produk: Basic Suit - Black 2.0\ntahap: minta_alamat'))
    assert.isFalse(wholesaleOrder('grosir: tidak'))
  })

  test('jumlah pcs & kelompok kategori', ({ assert }) => {
    assert.equal(lineQty('Basic Suit - Black 2.0 size M 6 pcs'), 6)
    assert.equal(lineQty('Basic Suit - Black 2.0 size M x6'), 6)
    assert.equal(lineQty('Setelan Basic Suit 3 stel'), 3)
    assert.equal(lineQty('Basic Suit - Black 2.0 size 3XL'), 1)
    assert.equal(lineQty('Basic Suit - Black 2.0 size XL 485.000'), 1)
    assert.equal(wholesaleGroup('Suits', 'Tuxedo'), 'jas')
    assert.equal(wholesaleGroup('Setelan', 'Setelan Basic Suit'), 'setelan')
    assert.equal(wholesaleGroup('Pants', 'Pants Premium'), 'celana')
    assert.equal(wholesaleGroup('Vest', 'Vest Signature'), 'rompi')
    assert.equal(wholesaleGroup('Shirt', 'Kemeja'), '')
  })

  test('skill: syarat mulai 6 jas disebut, jumlah ditulis di order; diskon lain tetap serah CS', async ({ assert }) => {
    const skill = await readFile(new URL('../../skills-beta3/beta3-cs-inti/SKILL.md', import.meta.url), 'utf8')
    assert.include(skill, 'Pesan banyak + ada DISKON GROSIR → sebut syaratnya mulai 6 jas (setelan dihitung jas)')
    assert.include(skill, 'baris `order` pakai jumlah ("6 pcs"), potongan dihitung sistem')
    assert.include(skill, 'diskon di luar DISKON GROSIR')
  })

  test('data diskon grosir dari website → kalimat DISKON GROSIR mulai 6 jas (Suits → Jas); teks lama ditulis ulang', ({ assert }) => {
    const text = renderWholesale({
      text: 'DISKON GROSIR ... Suits 15.000',
      items: [
        { category: 'Pants', discount: 10000 },
        { category: 'Setelan', discount: 25000 },
        { category: 'Shirt', discount: 15000 },
        { category: 'Suits', discount: 15000 },
        { category: 'Vest', discount: 5000 },
      ],
    })
    assert.include(text, 'DISKON GROSIR mulai 6 jas (setelan dihitung jas')
    assert.include(text, 'Jas 15.000, Setelan 25.000, Celana 10.000, Rompi 5.000')
    assert.include(text, 'Kurang dari 6 jas tanpa potongan')
    assert.notInclude(text, 'invoice')
    assert.equal(renderWholesale({ text: 'teks website' }), 'teks website')
    assert.equal(renderWholesale(undefined), '')
    // Teks yang tersimpan versi v3.6.56 dibaca ulang jadi aturan baru (tanpa menunggu sinkron katalog).
    const old = 'DISKON GROSIR (pesanan banyak/seragam; potongan per pcs dari harga KATALOG): Celana 10.000, Setelan 25.000, Kemeja 15.000, Jas 15.000, Rompi 5.000. Kategori lain tanpa potongan. Total grosir dibuat lewat invoice toko.'
    assert.deepEqual(wholesaleDiscounts(old), discounts)
    assert.equal(renderWholesaleRule(wholesaleDiscounts(old)), text)
    assert.deepEqual(wholesaleDiscounts(text), discounts)
  })
})

// v3.6.66 — 8 Okt: diskon grosir tidak pernah tersimpan di server. Website sudah mengirim `wholesale`,
// tapi katalog dianggap "belum berubah" (if_version sama) sehingga sinkron tidak pernah menyimpan
// bagian baru itu; tombol Sync juga tidak memaksa tarik ulang.
test.group('sinkron katalog menarik ulang saat bagian baru ditambahkan (v3.6.66)', (group) => {
  const names = ['mcp_slug', 'mcp_url', 'mcp_token', 'catalog_version_sf2', 'catalog_sync_schema', 'product_weights']
  let saved: Array<{ name: string; value: string }> = []
  const realFetch = globalThis.fetch
  group.each.setup(async () => {
    saved = (await db.from('whatsapp_beta3_state').whereIn('name', names).select('name', 'value')) as any
    return async () => {
      globalThis.fetch = realFetch
      await db.from('whatsapp_beta3_state').whereIn('name', names).delete()
      for (const row of saved) await writeLeanState(row.name, row.value)
    }
  })

  test('skema sinkron lama → tanpa if_version (tarik penuh); skema sama → if_version', async ({ assert }) => {
    await writeLeanState('mcp_slug', '')
    await writeLeanState('mcp_url', 'https://mcp.test/x')
    await writeLeanState('mcp_token', '')
    await writeLeanState('catalog_version_sf2', 'v1')
    await writeLeanState('product_weights', '{}')
    await writeLeanState('catalog_sync_schema', '1')
    const sent: any[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).params.arguments)
      const text = JSON.stringify({ version: 'v1', unchanged: true })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }), { status: 200 })
    }) as unknown as typeof fetch
    await syncLeanCatalog()
    assert.notProperty(sent[0], 'if_version')
    await writeLeanState('catalog_sync_schema', CATALOG_SYNC_SCHEMA)
    await syncLeanCatalog()
    assert.equal(sent[1].if_version, 'v1')
    // Tombol Sync (force) selalu tarik penuh.
    await syncLeanCatalog({ force: true })
    assert.notProperty(sent[2], 'if_version')
  })
})
