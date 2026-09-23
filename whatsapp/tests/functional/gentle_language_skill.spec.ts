import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

const cases = [
  {
    name: 'shipping choices retain verified rates and separate lines',
    message: 'Ongkirnya ada pilihan apa aja?',
    context:
      'Fixture pengganti hasil tool bisnis yang sudah diperiksa: ongkir REG Rp8000 estimasi3–6hari, YES Rp9000 estimasi1hari untuk alamat dan berat pesanan yang sudah pasti. Pelanggan belum memilih layanan. Jangan memakai tarif lain atau melakukan panggilan tool baru pada tes ini.',
    numbers: [/8[.,]?000/, /9[.,]?000/],
    forbidden: /total|grand total/i,
  },
  {
    name: 'balance notice keeps actual allocation and remaining bill',
    message:
      'Review internal: pembayaran sudah diverifikasi dan saldo telah dipakai. Belum ada pemberitahuan ke pelanggan.',
    context:
      'Semua detail order sudah disepakati. STATE CART DAN ORDER: {"cart":{"items":[]},"orders":[{"number":"WA-000047","total":889000,"paid":816000,"cashPaid":770000,"balanceApplied":46000,"balance":73000,"status":"active"}],"customerBalance":{"balance":0,"currency":"IDR","entries":[{"orderNumber":"WA-000047","amount":-46000,"reason":"order_payment"}]},"events":[{"action":"balance_applied","details":{"allocations":[{"orderNumber":"WA-000047","amount":46000}],"remainingBalance":0}}]}. Tidak ada pembayaran atau refund lain; sisa Rp73000 belum dibayar.',
    numbers: [/46[.,]?000/, /73[.,]?000/],
    forbidden: /(?:sudah|telah)\s+lunas|(?:sudah|telah|otomatis)\s+(?:di)?refund/i,
  },
  {
    name: 'friendlier wording does not change the no-COD rule',
    message: 'Bisa COD?',
    context:
      'Kebijakan bisnis fixture yang sudah diverifikasi: toko tidak menerima COD, pembayaran lewat transfer. Jawab pertanyaan ini saja; belum ada cart atau pesanan terkonfirmasi. Jangan mengubah kebijakan atau menjanjikan pengecualian.',
    numbers: [],
    forbidden: /(?:bisa|boleh|tersedia|menerima)\s+COD\s+(?:ya|bos|kok)/i,
  },
]

for (const scenario of cases) {
  test(scenario.name, async ({ assert }) => {
    const current = await readSettings(true)
    const content = await readFile('skills/cs-format-jawaban/SKILL.md', 'utf8')
    const result = await createReply(
      {
        ...current,
        mcpConnections: [],
        paymentMethods: [],
        skills: current.skills.map((skill) =>
          skill.name === 'cs-format-jawaban' ? { ...skill, content } : skill
        ),
      },
      scenario.message,
      undefined,
      undefined,
      `UJI FIKTIF TERISOLASI: tidak mengirim WhatsApp atau mengubah data bisnis. ${scenario.context}`
    )
    assert.equal(result.decision, 'reply')
    const answer = `${result.message}\n${result.initiative || ''}`
    for (const number of scenario.numbers) assert.match(answer, number)
    assert.notMatch(answer, scenario.forbidden)
    assert.notMatch(answer, /sayang|bestie|!!|dengan hormat|dengan ini kami informasikan/i)
    if (scenario.name.startsWith('shipping')) assert.include(result.message, '\n')
    if (scenario.name.includes('no-COD'))
      assert.match(answer, /(?:tidak|belum|nggak|gak|ga).*COD|COD.*(?:tidak|belum|nggak|gak|ga)/i)
    console.log(JSON.stringify({ scenario: scenario.name, answer }))
  })
    .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
    .timeout(180_000)
}
