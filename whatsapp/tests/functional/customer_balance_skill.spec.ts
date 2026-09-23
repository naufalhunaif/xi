import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

test('acknowledges verified overpayment as customer balance without promising an automatic refund', async ({
  assert,
}) => {
  const current = await readSettings(true)
  const content = await readFile('skills/cs-cart-order/SKILL.md', 'utf8')
  const result = await createReply(
    {
      ...current,
      mcpConnections: [],
      paymentMethods: [],
      skills: current.skills.map((skill) =>
        skill.name === 'cs-cart-order' ? { ...skill, content } : skill
      ),
    },
    'Review internal: manusia baru mengonfirmasi dana masuk. Sampaikan hasil pembayaran sesuai state.',
    undefined,
    undefined,
    `UJI FIKTIF TERISOLASI; tidak boleh mengirim WhatsApp atau mengubah data bisnis. Seluruh detail order, ukuran, alamat dan pengiriman sudah disepakati. Pelanggan terakhir: "Sudah saya transfer Rp770.000". CS memeriksa mutasi dan mengonfirmasi dana. Belum ada balasan setelah konfirmasi ini. Tidak ada kebutuhan cek produk/ongkir baru, pembayaran lanjutan, refund atau pemakaian saldo. STATE CART DAN ORDER: {"cart":{"items":[]},"orders":[{"number":"WA-000123","total":713000,"paid":770000,"balance":0,"overpayment":57000,"status":"active"}],"customerBalance":{"balance":57000,"currency":"IDR","entries":[{"orderNumber":"WA-000123","amount":57000,"reason":"overpayment"}]}}`
  )
  assert.equal(result.decision, 'reply')
  assert.isNull(result.cartIntent)
  const answer = `${result.message} ${result.initiative || ''}`
  assert.match(answer, /saldo/i)
  assert.match(answer, /57[.,]?000/)
  assert.notMatch(answer, /(?:otomatis|sudah|telah)\s+(?:di)?(?:refund|kembalikan|potong)/i)
  assert.notMatch(answer, /(?:silakan|tolong|mohon)\s+(?:segera\s+)?(?:lunasi|transfer lagi)/i)
})
  .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
  .timeout(180_000)

test('reports the actual balance used for an older DP, not the original excess as available credit', async ({
  assert,
}) => {
  const current = await readSettings(true)
  const content = await readFile('skills/cs-cart-order/SKILL.md', 'utf8')
  const result = await createReply(
    {
      ...current,
      mcpConnections: [],
      paymentMethods: [],
      skills: current.skills.map((skill) =>
        skill.name === 'cs-cart-order' ? { ...skill, content } : skill
      ),
    },
    'Review internal: dana baru dikonfirmasi dan saldo sudah dialokasikan. Sampaikan hasil pembayaran.',
    undefined,
    undefined,
    `UJI FIKTIF TERISOLASI, tidak mengirim WhatsApp atau mengubah data bisnis. Detail barang, alamat dan ongkir sudah lengkap dan terkonfirmasi; tidak ada pencarian MCP baru. Belum ada pemberitahuan pembayaran. Manusia sudah verifikasi transfer Rp770.000 untuk order WA-000123 (total713000), kelebihannya57000. Sistem sudah memakai50000 untuk sisa DP order lama WA-000122, kini lunas; saldo tersisa7000. STATE CART DAN ORDER: {"cart":{"items":[]},"orders":[{"number":"WA-000123","total":713000,"paid":770000,"cashPaid":770000,"balanceApplied":0,"balance":0,"overpayment":57000,"status":"active"},{"number":"WA-000122","total":100000,"paid":100000,"cashPaid":50000,"balanceApplied":50000,"balance":0,"overpayment":0,"status":"active"}],"customerBalance":{"balance":7000,"currency":"IDR","entries":[{"orderNumber":"WA-000122","amount":-50000,"reason":"order_payment"},{"orderNumber":"WA-000123","amount":57000,"reason":"overpayment"}]}}`
  )
  assert.equal(result.decision, 'reply')
  assert.isNull(result.cartIntent)
  const answer = `${result.message} ${result.initiative || ''}`
  assert.match(answer, /50[.,]?000/)
  assert.match(answer, /7[.,]?000/)
  assert.match(answer, /lunas/i)
  assert.notMatch(answer, /(?:silakan|tolong|mohon)\s+(?:segera\s+)?(?:lunasi|transfer lagi)/i)
})
  .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
  .timeout(180_000)
