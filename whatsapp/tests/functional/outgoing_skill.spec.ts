import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

const live = process.env.AI_SKILL_LIVE_TEST === '1'
async function settings() {
  const current = await readSettings(true)
  const updates = new Map(
    await Promise.all(
      ['cs-detail-visual', 'cs-cart-order', 'cs-format-jawaban'].map(
        async (name) => [name, await readFile(`skills/${name}/SKILL.md`, 'utf8')] as const
      )
    )
  )
  return {
    ...current,
    mcpConnections: [],
    paymentMethods: [],
    skills: current.skills.map((skill) => ({
      ...skill,
      content: updates.get(skill.name) || skill.content,
    })),
  }
}

test.group('Live photo and default quantity skills', () => {
  test('requests a photo attachment instead of exposing its URL to the customer', async ({
    assert,
  }) => {
    const url = 'https://catalog.example/products/jas-uji.jpg'
    const result = await createReply(
      await settings(),
      'Boleh lihat foto jas yang tadi?',
      undefined,
      undefined,
      `UJI FIKTIF TERISOLASI, tidak boleh mengirim WhatsApp atau mengubah data. Pelanggan merujuk satu produk Jas Uji yang sudah jelas. Data fixture pengganti hasil get_product MCP yang sudah dibaca: {"id":"jas-uji","name":"Jas Uji","img":"${url}"}. Tidak ada kebutuhan harga/ukuran/order pada giliran ini. Gambar belum pernah dikirim ke pelanggan; sumber tersedia untuk dilampirkan, bukan untuk dianalisis piksel pada tes ini.`
    )
    assert.equal(result.decision, 'reply')
    assert.lengthOf(result.images || [], 1)
    assert.equal(result.images![0].url, url)
    assert.notInclude(
      `${result.message} ${result.initiative || ''} ${result.images![0].caption}`,
      url
    )
  })
    .skip(!live)
    .timeout(180_000)

  for (const quantity of [1, 3])
    test(`quantity is ${quantity} without an unnecessary quantity question`, async ({ assert }) => {
      const message = `Fix pesan Jas Uji hitam size S${quantity === 3 ? ' 3 pcs' : ''}.`
      const result = await createReply(
        await settings(),
        message,
        undefined,
        undefined,
        `UJI FIKTIF TERISOLASI, tidak boleh mengirim WhatsApp atau mengubah data bisnis. Data fixture pengganti MCP sudah diperiksa: produk id jas-uji, nama Jas Uji, warna hitam, ukuran S, harga Rp400.000, stok 10, img https://catalog.example/products/jas-uji.jpg. Tidak ada varian/model lain. Cart masih kosong. Belum ada nama/alamat penerima, belum ada ongkir/pembayaran. PESAN PELANGGAN SAAT INI [message_id: fixture-quantity-confirm]: ${message}`
      )
      assert.equal(result.cartIntent?.action, 'sync')
      assert.lengthOf(result.cartIntent?.items || [], 1)
      assert.equal(result.cartIntent!.items[0].quantity, quantity)
      assert.notMatch(
        `${result.message} ${result.initiative || ''}`,
        /berapa\s+(pcs|buah|set|jumlah)|jumlahnya\s+berapa|satu\s+(ya|dulu)[? ]|qty.*\?/i
      )
    })
      .skip(!live)
      .timeout(180_000)
})
