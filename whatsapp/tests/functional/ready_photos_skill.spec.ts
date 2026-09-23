import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

const black = {
  id: 'beskap-hitam',
  name: 'Beskap Hitam',
  color: 'Hitam',
  total_stock: 3,
  sizes: [{ size_name: 'M', stock: 3 }],
  img: 'https://catalog.example/uploads/beskap-hitam.jpg',
}
const ivory = {
  id: 'beskap-ivory',
  name: 'Beskap Ivory',
  color: 'Ivory',
  total_stock: 2,
  sizes: [{ size_name: 'L', stock: 2 }],
  img: 'https://catalog.example/uploads/beskap-ivory.jpg',
}
const excluded = [
  { id: 'beskap-maroon', name: 'Beskap Maroon', color: 'Maroon', total_stock: 3, img: '' },
  {
    id: 'beskap-navy',
    name: 'Beskap Navy',
    color: 'Navy',
    total_stock: 0,
    img: 'https://catalog.example/uploads/beskap-navy.jpg',
  },
]
const cases = [
  {
    name: 'photo request offers ready colors before asking for a choice',
    message: 'Mau liat dongg foto beskap yang ready',
    products: [black, ivory, ...excluded],
    history: '',
    expected: 'choices',
  },
  {
    name: 'color question lists choices without exposing photo availability filtering',
    message: 'Ada warna apa saja?',
    products: [black, ivory, ...excluded],
    history: 'Pelanggan sebelumnya: Mau lihat foto beskap ready. Warna belum dipilih.',
    expected: 'choices',
  },
  {
    name: 'a short color answer continues the photo request without creating an order',
    message: 'Hitam',
    products: [black, ivory],
    history:
      'Pelanggan: Mau lihat foto beskap ready. AI: Ada hitam dan ivory, bos. Mau lihat warna yang mana? Goal: waiting_answer, menunggu pilihan warna untuk mengirim foto beskap. Tidak ada konfirmasi membeli.',
    expected: black.img,
  },
  {
    name: 'one ready color sends its photo immediately',
    message: 'Mau liat dongg foto beskap yang ready',
    products: [black, ...excluded],
    history: '',
    expected: black.img,
  },
  {
    name: 'explicit color request sends the selected photo even when multiple colors are ready',
    message: 'Lihat foto beskap ivory dong',
    products: [black, ivory],
    history: '',
    expected: ivory.img,
  },
]

for (const scenario of cases) {
  test(scenario.name, async ({ assert }) => {
    const current = await readSettings(true)
    const content = await readFile('skills/cs-detail-visual/SKILL.md', 'utf8')
    const result = await createReply(
      {
        ...current,
        mcpConnections: [],
        paymentMethods: [],
        skills: current.skills.map((skill) =>
          skill.name === 'cs-detail-visual' ? { ...skill, content } : skill
        ),
      },
      scenario.message,
      undefined,
      undefined,
      `UJI FIKTIF TERISOLASI: tidak mengirim WhatsApp atau mengubah data bisnis. Semua hasil list_products/get_product MCP untuk kategori Beskap sudah diperiksa tuntas dan tersedia dalam fixture berikut, tidak perlu tool baru pada tes ini: ${JSON.stringify(scenario.products)}. Sumber img yang tidak kosong merupakan foto produk warna tersebut yang dapat dilampirkan. ${scenario.history} Cart kosong. Belum ada keputusan membeli atau permintaan ukuran/pembayaran.`
    )
    const answer = `${result.message}\n${result.initiative || ''}\n${(result.images || []).map((image) => image.caption).join('\n')}`
    assert.equal(result.decision, 'reply')
    assert.isNull(result.cartIntent)
    assert.notMatch(
      answer,
      /https?:\/\/|MCP|(?:yang|karena)\s+(?:ada|punya|tersedia)\s+(?:foto|gambar)|(?:foto|gambar)(?:nya)?\s+(?:sudah\s+)?(?:ada|tersedia)/i
    )
    assert.notMatch(answer, /berapa\s+(?:pcs|jumlah|qty)|alamat.*\?|mau.*(?:pesan|order).*\?/i)
    if (scenario.expected === 'choices') {
      assert.lengthOf(result.images || [], 0)
      assert.match(answer, /hitam/i)
      assert.match(answer, /ivory/i)
      assert.notMatch(answer, /maroon|navy/i)
      assert.match(result.message, /\?/)
      const parts = result.message.split(/(?:\n\s*\n|[.!]\s+)/)
      const choicesBeforeQuestion = parts
        .slice(
          0,
          parts.findIndex((part) => part.includes('?'))
        )
        .join('\n')
      assert.notInclude(choicesBeforeQuestion, '?')
      assert.match(choicesBeforeQuestion, /hitam/i)
      assert.match(choicesBeforeQuestion, /ivory/i)
      assert.isBelow(result.message.toLowerCase().indexOf('ivory'), result.message.indexOf('?'))
    } else {
      assert.lengthOf(result.images || [], 1)
      assert.equal(result.images![0].url, scenario.expected)
      assert.notMatch(answer, /warna.*(?:apa|mana)|mau.*(?:foto|lihat).*\?/i)
    }
    console.log(JSON.stringify({ scenario: scenario.name, answer, images: result.images }))
  })
    .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
    .timeout(180_000)
}
