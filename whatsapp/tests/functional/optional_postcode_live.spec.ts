import { test } from '@japa/runner'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

test('resolves a public destination and quotes shipping without a supplied postcode', async ({
  assert,
}) => {
  const calls: any[] = []
  const result = await createReply(
    await readSettings(true),
    'Cek ongkir ke Desa Cinyawang, Kecamatan Patimuan, Kabupaten Cilacap. Berat paket 1 kg. Saya belum tahu kode posnya.',
    undefined,
    undefined,
    'UJI SINTETIS TERISOLASI: hanya cek tarif untuk nama wilayah publik dan berat paket contoh 1 kg, tidak ada pelanggan, cart atau order nyata. Tidak mengirim WhatsApp, tidak membuat cart/order. Gunakan tujuan dan berat contoh tersebut untuk cek tarif MCP baca saja.',
    [],
    (event) => {
      if (event.status === 'completed' && (event.detail as any)?.parameters) calls.push(event)
    }
  )
  const answer = `${result.message}\n${result.initiative || ''}`
  assert.equal(result.decision, 'reply')
  assert.isTrue(calls.some((event) => /destination/i.test(event.label)))
  assert.isTrue(calls.some((event) => /check_shipping_rates/i.test(event.label)))
  assert.notMatch(
    answer,
    /(?:berapa|minta|butuh|perlu|wajib|sebutkan|boleh tahu)[^.!?\n]*kode\s*pos|kode\s*pos[^.!?\n]*\?/i
  )
  assert.match(answer, /REG|YES|JNE/i)
  console.log(
    JSON.stringify({
      answer,
      tools: calls.map((event) => ({ label: event.label, parameters: event.detail.parameters })),
    })
  )
})
  .skip(process.env.AI_SHIPPING_LIVE_TEST !== '1')
  .timeout(360_000)
