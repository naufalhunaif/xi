import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { ensureLeanTables } from '#beta3/tables'
import { imageNotes, storeImageCatalog, storeImageNote } from '#beta3/refs_service'
import { findCatalogVariant } from '#beta3/catalog_service'
import { matchAutoTotal } from '#beta3/order_service'
import { renderHistory } from '#beta3/prompt'

// v3.6.52 — cs-pelajaran #25: pelanggan minta "jas doff abu agak tua"; warna itu tidak ada, CS
// mengirim foto "ada seperti ini bos" dan pelanggan setuju. Foto CS tidak pernah dilihat AI, sehingga
// "ash grey" (sebutan pelanggan) dipakai sebagai produk dan totalnya dihitung dari harga yang salah.
const JID = '620000000778@s.whatsapp.net'
const row = (product: string, color: string, price: number, material = '') =>
  ({ id: 0, product, color, price, material, note: '', active: true }) as any
const catalog = [
  row('Basic Suit', 'Light Gray', 485000, 'Maximotion'),
  row('Basic Suit', 'Signature Light Gray', 500000, 'Scuro'),
  row('Pants', 'Light Gray', 220000, 'Novus'),
  row('Pants Signature', 'Light Gray', 220000, 'Scuro'),
  row('Vest', 'Light Gray', 175000, 'Maximotion'),
  row('Vest Signature', 'Broken White', 185000, 'Scuro'),
]

test.group('gambar dari CS = produk yang ditawarkan (v3.6.52)', (group) => {
  group.each.setup(async () => {
    await ensureLeanTables()
    await db.from('whatsapp_beta3_proofs').where('jid', JID).delete()
  })
  group.teardown(async () => {
    await db.from('whatsapp_beta3_proofs').where('jid', JID).delete()
  })

  test('daftar katalog ringkas & catatan gambar CS memakai nama katalog persis', ({ assert }) => {
    const list = storeImageCatalog(catalog)
    assert.include(list, 'Basic Suit [bahan Scuro]: Signature Light Gray')
    assert.include(list, 'Vest Signature [bahan Scuro]: Broken White')
    const match = findCatalogVariant(catalog, 'Basic Suit - Signature Light Gray')
    assert.equal(storeImageNote(match, 'jas abu doff'), 'contoh dari toko: Basic Suit - Signature Light Gray')
    // Tidak cocok katalog → ciri saja, tanpa harga.
    assert.equal(storeImageNote(undefined, 'jas abu tua doff 450.000'), 'contoh dari toko (tidak cocok katalog): jas abu tua doff')
  })

  test('riwayat AI menampilkan produk dari foto CS (sudah dilihat, tanpa memanggil AI)', async ({ assert }) => {
    await db.table('whatsapp_beta3_proofs').insert({
      message_id: 'SI-CS-1', jid: JID, kind: 'contoh', note: 'contoh dari toko: Basic Suit - Signature Light Gray', created_at: new Date(),
    })
    const notes = await imageNotes(JID, [
      { message_id: 'SI-CS-1', media_url: '/media/x.jpg', media_type: 'image', direction: 'out', sender_type: 'owner' },
      // Foto katalog yang dikirim AI tidak perlu dilihat lagi (namanya sudah diketahui).
      { message_id: 'SI-AI-1', media_url: '/media/y.jpg', media_type: 'image', direction: 'out', sender_type: 'ai' },
    ], new Set(), 0)
    assert.equal(notes.get('SI-CS-1'), 'contoh dari toko: Basic Suit - Signature Light Gray')
    assert.isFalse(notes.has('SI-AI-1'))
    const history = renderHistory([
      { direction: 'in', body: 'Mau buat jas doff warna kaya gini ya, abu2 agak tua', createdAt: new Date(), mediaType: 'image' },
      { direction: 'out', senderType: 'owner', body: '', mediaType: 'image', mediaNote: notes.get('SI-CS-1'), createdAt: new Date() },
      { direction: 'out', senderType: 'owner', body: 'ada seperti ini bos', createdAt: new Date() },
    ])
    assert.include(history, 'CS (manusia): [image: contoh dari toko: Basic Suit - Signature Light Gray]')
  })

  test('produk dari foto CS → total PO seri yang benar (905.000), bukan jumlah satuan "ash grey" (880.000)', ({ assert }) => {
    const prices = [{ service: 'CTCYES', price: 11000 }]
    const fromPhoto = matchAutoTotal(
      {
        rincian:
          'Basic Suit - Signature Light Gray size XL 500.000\nPants Signature - Light Gray menyesuaikan 220.000\nVest Signature - Light Gray size XL 185.000',
        subtotal: 905000,
        layanan: 'YES',
      },
      catalog,
      prices,
      ['yes']
    )
    assert.isTrue(fromPhoto.ok)
    assert.equal(fromPhoto.ok && fromPhoto.subtotal, 905000)
    // Warna yang tidak ada kainnya di seri itu ("ash grey") tetap ditahan → menunggu CS.
    const ash = matchAutoTotal({ rincian: 'Vest Signature - Ash Grey size XL 185.000', subtotal: 185000, layanan: 'YES' }, catalog, prices, ['yes'])
    assert.isFalse(ash.ok)
    // Warna dari seri bahan LAIN tidak dipakai (beda seri beda harga).
    const other = [...catalog, row('Tuxedo Double Breasted', 'Black', 535000, 'Maximotion'), row('Tuxedo', 'Maroon', 485000, 'Aldo Moretti')]
    assert.isFalse(matchAutoTotal({ rincian: 'Tuxedo Double Breasted - Maroon size S 535.000', subtotal: 535000, layanan: 'YES' }, other, prices, ['yes']).ok)
  })
})
