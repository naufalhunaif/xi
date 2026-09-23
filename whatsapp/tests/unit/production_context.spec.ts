import { test } from '@japa/runner'
import { defaultProductionPolicy, productionDataContext } from '#services/production_contract'

test.group('Local pre-order decision context', () => {
  test('keeps the local-source rule even when settings are missing or disabled', ({ assert }) => {
    for (const policy of [undefined, defaultProductionPolicy()]) {
      const context = productionDataContext(policy)
      assert.include(context, 'PENENTUAN PRE-ORDER')
      assert.include(
        context,
        'Jangan memanggil tool MCP untuk memeriksa apakah pre-order diizinkan'
      )
      assert.include(context, 'termasuk hasil MCP yang tersimpan di cache')
      assert.include(
        context,
        'jangan mengaktifkan pre-order atau mengisi estimasi dari MCP sebagai fallback'
      )
      assert.include(context, '"enabled":false')
    }
  })

  test('passes the local estimate without treating stock or enabled rules as product approval', ({
    assert,
  }) => {
    const policy = defaultProductionPolicy()
    policy.rules.preorder = {
      enabled: true,
      minDays: 3,
      maxDays: 10,
      estimateDays: 7,
      dayType: 'working',
      startsAfter: 'payment_details',
    }
    const context = productionDataContext(policy)
    assert.include(context, JSON.stringify(policy))
    assert.include(context, 'bukan bukti bahwa setiap produk otomatis pre-order')
    assert.include(context, 'Stok kosong tidak otomatis berarti pre-order atau custom')
    assert.include(context, 'keputusan pre-order mengikuti sumber lokal, bukan MCP')
    assert.include(
      context,
      'Harga, stok aktual, ukuran, gambar, dan detail model tetap boleh diverifikasi melalui MCP'
    )
    assert.include(context, 'Jangan mengganti estimasi/tanggal yang sudah disepakati')
  })
})
