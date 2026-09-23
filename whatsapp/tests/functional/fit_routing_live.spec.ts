import { test } from '@japa/runner'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

test('real OAuth + Fit MCP handles a size question despite an older pending production decision', async ({
  assert,
}) => {
  const settings = await readSettings(true)
  const calls: any[] = []
  const question = 'Gan kalo tinggi 168 berat 84 bagusnya celana pake no berapa ya'
  const result = await createReply(
    settings,
    question,
    undefined,
    undefined,
    'UJI TERISOLASI, tidak mengirim pesan WhatsApp. Riwayat: pelanggan sebelumnya menanyakan estimasi kirim pesanan custom TEST-FIT. Status produksi belum tersedia, membutuhkan keputusan owner. Goal lama waiting_approval. Sekarang pelanggan beralih menanyakan estimasi nomor celana. Usia dan preferensi belum diketahui. Cart tidak perlu diubah; jangan mencari atau mengubah order nyata.',
    [],
    (event) => {
      if (event.label.includes('fit_advisor')) calls.push(event)
    }
  )
  assert.equal(result.decision, 'reply')
  assert.isTrue(
    calls.some(
      (event) =>
        event.status === 'completed' &&
        event.detail?.parameters?.height === 168 &&
        event.detail?.parameters?.weight === 84
    )
  )
  const answer = `${result.message}\n${result.initiative || ''}`
  assert.match(answer, /\b(37|38|39)\b|slim[\s\S]*regular/i)
  assert.notMatch(answer, /(?:teruskan|tanyakan|dibantu|dialihkan).*\b(?:CS|owner|admin)\b/i)
  console.log(JSON.stringify({ answer, goal: result.goal, fitCalls: calls.length }))
})
  .skip(process.env.AI_FIT_LIVE_TEST !== '1')
  .timeout(360_000)
