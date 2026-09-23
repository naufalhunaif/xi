import { test } from '@japa/runner'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

test('real OAuth + business MCP answers a combination price question without inventing a custom request', async ({
  assert,
}) => {
  const calls: any[] = []
  const result = await createReply(
    await readSettings(true),
    'Kalo yang sage sama celana berapa?',
    undefined,
    undefined,
    'UJI TERISOLASI: tidak mengirim WhatsApp atau mengubah order/cart. Pelanggan sebelumnya menanyakan jas ready dan foto Sage Green. Foto Premium Basic Suit - Sage Green sudah ditunjukkan; ukuran jas XL dari rekomendasi Fit, belum konfirmasi beli. Produk ID d6862e2a-1374-4ddc-ac88-528e5b6f1562. Pelanggan belum menyebut warna celana atau meminta custom. Ada urusan produksi order lama TEST-PRODUCT yang menunggu owner; jangan mencari order nyata. Pertanyaan sekarang tentang harga produk baru. Cart tidak perlu diubah.',
    [],
    (event) => {
      if (event.status === 'completed' && (event.detail as any)?.parameters) calls.push(event)
    }
  )
  assert.equal(result.decision, 'reply')
  assert.isAtLeast(calls.filter((event) => event.label.includes('get_product')).length, 2)
  const answer = `${result.message}\n${result.initiative || ''}`
  assert.notMatch(answer, /(?:teruskan|tanyakan|dibantu|dialihkan).*\b(?:CS|owner|admin)\b/i)
  console.log(
    JSON.stringify({
      answer,
      reason: result.reason,
      tools: calls.map((event) => ({ label: event.label, parameters: event.detail.parameters })),
    })
  )
})
  .skip(process.env.AI_PRODUCT_LIVE_TEST !== '1')
  .timeout(360_000)
