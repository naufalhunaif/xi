import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

test('live model flags a design outside the catalog without borrowing its price', async ({
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
    'Fix pesan model referensi saya: peak lapel, double breasted enam kancing, size M satu set. Jangan pakai model katalog notch dua kancing.',
    undefined,
    undefined,
    'Uji fiktif terisolasi. Tidak ada tool, tidak ada pesan nyata yang boleh dikirim. Data bisnis fixture sudah diperiksa: hanya model katalog notch lapel dua kancing seharga Rp705.000, tidak ada model peak lapel enam kancing dan belum ada harga untuk model referensi. STATE CART DAN ORDER: {"cart":{"items":[],"recipient":{"name":"","phone":"","address":""},"shipping":{"service":"","cost":null},"note":""},"orders":[]}. Riwayat PELANGGAN [foto] message_id: photo-ref-1, caption: jas peak lapel double breasted enam kancing. PELANGGAN message_id: confirm-model-1: Fix pesan model referensi saya peak lapel enam kancing, size M satu set. Nama referensi pasti Jas peak lapel enam kancing. Detail visual di fixture sudah diverifikasi, tugas ini klasifikasi cart, bukan menebak piksel.'
  )
  assert.equal(result.cartIntent?.action, 'sync')
  assert.equal(result.cartIntent?.items[0].modelType, 'custom')
  assert.match(result.cartIntent?.items[0].name || '', /^Custom\b/i)
  assert.match(result.cartIntent?.items[0].name || '', /peak/i)
  assert.notMatch(result.cartIntent?.items[0].name || '', /tuxedo/i)
  assert.equal(result.cartIntent?.items[0].referenceMessageId, 'photo-ref-1')
  assert.isNull(result.cartIntent?.items[0].unitPrice)
  assert.equal(result.cartIntent?.items[0].size, 'M')
  assert.notMatch(
    `${result.message} ${result.initiative || ''}`,
    /705[.,]?000|transfer|persetujuan CS|isi form/i
  )
})
  .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
  .timeout(180_000)
