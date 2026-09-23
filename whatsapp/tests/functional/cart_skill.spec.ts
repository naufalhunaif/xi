import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

test('live model fills a confirmed cart rather than asking CS to complete a form', async ({
  assert,
}) => {
  const settings = await readSettings(true)
  const content = await readFile('skills/cs-cart-order/SKILL.md', 'utf8')
  const result = await createReply(
    {
      ...settings,
      mcpConnections: [],
      paymentMethods: [],
      skills: [{ name: 'cs-cart-order', content }],
    },
    'Fix Basic Suit - Black custom 1 set, panjang jas 67 cm, panjang tangan 59 cm, pakai REG. Penerima Uji, 0812000000, Jalan Uji 10. Catatan tanpa bordir.',
    undefined,
    undefined,
    `Uji fiktif terisolasi, tidak ada tool dan tidak boleh mengirim pesan atau mengubah data nyata. Katalog fixture terverifikasi: id basic-black, name Basic Suit - Black, img https://example.com/basic.jpg, custom price 705000; ongkir layanan REG 8000. Semua angka harga fixture sudah dikonfirmasi pelanggan dalam riwayat.\nSTATE CART DAN ORDER: {"cart":{"items":[],"recipient":{"name":"","phone":"","address":""},"shipping":{"service":"","cost":null},"note":"","paymentStatus":"none"},"orders":[]}\nPELANGGAN message_id: fixture-confirm-1: Fix Basic Suit - Black custom 1 set, panjang jas 67 cm, panjang tangan 59 cm, pakai REG. Penerima Uji, 0812000000, Jalan Uji 10. Catatan tanpa bordir.`
  )
  assert.equal(result.cartIntent?.action, 'sync')
  assert.equal(result.cartIntent?.confirmationMessageId, 'fixture-confirm-1')
  assert.equal(result.cartIntent?.items[0].name, 'Basic Suit - Black')
  assert.equal(result.cartIntent?.items[0].size, 'custom')
  assert.equal(result.cartIntent?.items[0].modelType, 'catalog')
  assert.equal(result.cartIntent?.items[0].unitPrice, 705000)
  assert.deepEqual(
    result.cartIntent?.items[0].measurements.map((row) => row.value).sort(),
    [59, 67]
  )
  assert.equal(result.cartIntent?.recipient.phone, '0812000000')
  assert.equal(result.cartIntent?.shipping.cost, 8000)
  assert.notMatch(
    `${result.message} ${result.initiative || ''}`,
    /isi(?:kan)? form|persetujuan CS|approval/i
  )
})
  .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
  .timeout(180_000)
