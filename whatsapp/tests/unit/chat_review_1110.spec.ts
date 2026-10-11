import { test } from '@japa/runner'
import { inlineShortLists } from '#beta3/reply_polish'
import { offColorPhotos, repeatsStoreMessage } from '#beta3/reply_check'
import type { LeanCatalogRow } from '#beta3/catalog_service'
import type { LeanHistoryRow } from '#beta3/prompt'

// v3.6.144 — temuan review chat 11 Okt (data contoh).
const row = (product: string, color: string): LeanCatalogRow => ({
  id: Math.random(), product, color, category: 'Suits', price: 485000, sizesReady: 'S M', sizesAll: '', photoUrl: 'x.jpg', materialAvailable: true,
  features: '', featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '',
})
const out = (body: string): LeanHistoryRow => ({ direction: 'out', body, createdAt: new Date().toISOString() }) as LeanHistoryRow

test.group('Review chat 11 Okt', () => {
  test('daftar berpoin pendek jadi kalimat', ({ assert }) => {
    const res = inlineShortLists(['Nanti kirim ukurannya ya: - lingkar dada - lingkar pinggang - panjang jas'])
    assert.equal(res.pesan[0], 'Nanti kirim ukurannya ya: lingkar dada, lingkar pinggang, dan panjang jas')
    const multi = inlineShortLists(['Ada bos:\n- Basic Suit Brown 485.000\n- Basic Suit Choco 485.000\nMau yang mana?'])
    assert.equal(multi.pesan[0], 'Ada bos: Basic Suit Brown 485.000, dan Basic Suit Choco 485.000 Mau yang mana?')
    assert.isFalse(inlineShortLists(['Siap bos, ditunggu ya']).changed)
  })

  test('"Semua" atas daftar warna coklat → foto Choco tidak dibuang', ({ assert }) => {
    const rows = [row('Basic Suit', 'Brown 2.0'), row('Basic Suit', 'Choco')]
    assert.deepEqual(offColorPhotos(['Basic Suit - Brown 2.0', 'Basic Suit - Choco'], ['Semua', 'Ini fotonya semua yang warna coklat tadi bos'], rows), [])
    assert.deepEqual(offColorPhotos(['Basic Suit - Brown 2.0', 'Basic Suit - Choco'], ['yang coklat ada?', 'Ada yang coklat bos'], rows), [])
  })

  test('susulan yang sama dengan pesan toko sebelumnya tidak diulang', ({ assert }) => {
    const history = [out('Kalau mau ambil kemeja White yang ready, saya bantu cek size-nya dari tinggi & berat badan ya bos')]
    assert.isTrue(repeatsStoreMessage('Kalau mau warna Black, saya bantu cek size-nya dari tinggi dan berat badan ya bos.', history))
    assert.isFalse(repeatsStoreMessage('Kalau alamatnya sudah ada, kirim nama penerima dan kecamatannya ya bos', history))
  })
})
