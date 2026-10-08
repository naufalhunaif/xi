import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { talksWholesale, wholesaleOrder } from '#beta3/reply_service'
import { renderWholesale } from '#beta3/mcp'

// v3.6.56 — "pesan banyak dapat diskon?" bisa dijawab: diskon grosir per kategori (potongan tetap
// per pcs) diatur di website (Admin → Invoice → Diskon grosir) dan ikut catalog_digest (wholesale).
test.group('diskon grosir (v3.6.56)', () => {
  test('topik pesanan banyak / diskon dikenali; pertanyaan biasa tidak', ({ assert }) => {
    for (const text of [
      'Misal pesen banyak dapet diskon gak nih',
      'kalau 60-80 jas sekali pesan bisa? buat seragam kantor',
      'ambil 20 stel ada potongan?',
      'harga grosir berapa min',
    ])
      assert.isTrue(talksWholesale(text), text)
    for (const text of ['Basic suit hitam ready size M?', 'ongkir ke Cilacap berapa', 'jas + celana berapa'])
      assert.isFalse(talksWholesale(text), text)
  })

  test('catatan "grosir: ya" menahan total otomatis (total grosir dibuat lewat invoice)', ({ assert }) => {
    assert.isTrue(wholesaleOrder('produk: Basic Suit - Black 2.0\ngrosir: ya\ntahap: minta_alamat'))
    assert.isFalse(wholesaleOrder('produk: Basic Suit - Black 2.0\ntahap: minta_alamat'))
    assert.isFalse(wholesaleOrder('grosir: tidak'))
  })

  test('skill: diskon grosir dijawab dari DISKON GROSIR, bukan langsung serah CS', async ({ assert }) => {
    const skill = await readFile(new URL('../../skills-beta3/beta3-cs-inti/SKILL.md', import.meta.url), 'utf8')
    assert.include(skill, 'Pesan banyak + ada DISKON GROSIR → sebut potongan per pcs, tanya jumlah, catat `grosir: ya`')
    assert.include(skill, 'diskon di luar DISKON GROSIR')
  })

  test('data diskon grosir dari website ditulis dengan sebutan pelanggan (Suits → Jas)', ({ assert }) => {
    const text = renderWholesale({
      text: 'DISKON GROSIR ... Suits 15.000',
      items: [
        { category: 'Pants', discount: 10000 },
        { category: 'Setelan', discount: 25000 },
        { category: 'Suits', discount: 15000 },
        { category: 'Vest', discount: 5000 },
      ],
    })
    assert.include(text, 'Celana 10.000, Setelan 25.000, Jas 15.000, Rompi 5.000')
    assert.include(text, 'invoice toko')
    assert.equal(renderWholesale({ text: 'teks website' }), 'teks website')
    assert.equal(renderWholesale(undefined), '')
  })
})
