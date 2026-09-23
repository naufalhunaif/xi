import { test } from '@japa/runner'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

const live = process.env.AI_SKILL_LIVE_TEST === '1' && process.env.DISCOUNT_DB_TEST === '1'
const cases = [
  {
    id: 'color-change',
    text: 'Badan jasnya biru navy, kerahnya item aja ya. Celananya tetep.',
    color: 'navy',
    lapel: 'hitam',
  },
  {
    id: 'color-reverse',
    text: 'Kebalik bos: badannya hitam, kerah navy. Celananya tetap.',
    color: 'hitam',
    lapel: 'navy',
  },
  {
    id: 'color-preserve',
    text: 'Jangan diganti hitam badannya, tetap navy. Kerah tetap hitam.',
    unchanged: true,
  },
  {
    id: 'color-question',
    text: 'Kalau badan jas dibuat putih bisa nggak? Tanya dulu, jangan diubah dulu.',
    unchanged: true,
  },
  {
    id: 'model-question',
    text: 'Bedanya Peak sama Tuxedo apa? Saya belum minta ganti model.',
    unchanged: true,
  },
  {
    id: 'partial-cancel',
    text: 'Celananya nggak jadi, jasnya tetep ambil ya bos.',
    action: 'remove',
  },
  { id: 'cancel-negation', text: 'Jangan dibatalin, dua-duanya tetap ya bos.', unchanged: true },
  {
    id: 'cancel-all',
    text: 'Dua-duanya batal aja bos, belum jadi pesan kali ini.',
    action: 'cancel',
  },
] as const
const colors = (v: unknown) =>
  String(v || '')
    .toLowerCase()
    .replace(/black|item/g, 'hitam')

test.group('Live order intent contrast pairs', (group) => {
  group.each.skip(!live, 'Explicit live opt-in and disposable database required.')
  const results: unknown[] = []
  group.teardown(async () => {
    if (!live) return
    const dir = await mkdtemp(join(tmpdir(), 'wa-order-intent-'))
    await writeFile(join(dir, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
    console.log(`Synthetic order intent results: ${dir}/results.json`)
  })
  for (const entry of cases)
    test(`order intent ${entry.id}`, async ({ assert }) => {
      const c: any = entry
      const settings = await readSettings(true)
      const skills = await Promise.all(
        ['cs-format-jawaban', 'cs-cart-order'].map(async (name, i) => ({
          id: i + 1,
          name,
          description: name,
          content: await readFile(`skills/${name}/SKILL.md`, 'utf8'),
        }))
      )
      const items = [
        {
          id: 'jacket',
          productId: 'peak-fixture',
          name: 'Peak Suit - Black',
          size: 'S',
          unitPrice: 485000,
          color: 'navy',
          lapel: 'hitam',
        },
        {
          id: 'pants',
          productId: 'pants-fixture',
          name: 'Pants - Navy 2.0',
          size: '30',
          unitPrice: 220000,
          color: 'navy',
          lapel: '',
        },
      ].map(({ color, lapel, ...item }) => ({
        ...item,
        quantity: 1,
        image: 'https://example.com/fixture.jpg',
        modelType: 'catalog',
        approval: 'standard',
        modelApproval: 'standard',
        requestedSize: '',
        measurements: {},
        note: '',
        productionDetails: {
          heightCm: 167,
          weightKg: 56,
          fit: '',
          color,
          lapel,
          material: '',
          buttons: '',
          measurements: [],
          pending: [],
          notes: '',
          sourceMessageIds: ['original'],
        },
      }))
      const result = await createReply(
        { ...settings, skills, mcpConnections: [], paymentMethods: [], aiFailover: false },
        c.text,
        undefined,
        undefined,
        `UJI FIKTIF TERISOLASI tanpa tool bisnis/WhatsApp. CART adalah draft belum checkout, belum dibayar. Harga dan produk fixture sudah terverifikasi. Tidak ada tarif ongkir atau rekap checkout. Sumber [original] pelanggan memilih Peak Suit badan navy lapel hitam S dan celana navy 30. Tidak ada persetujuan CS untuk perubahan baru; jangan mengarang persetujuan. Simpan pilihan sebagai draft jika masih perlu CS. Jika ditanya fakta produk yang tidak tersedia, akui perlu verifikasi tanpa mengarang.
CART ${JSON.stringify({ items, recipient: { name: '', phone: '', address: '' }, shipping: { service: '', cost: null }, note: '' })}
Pesan pelanggan terbaru [current]: ${c.text}
Petakan tindakan berdasarkan maksud; confirmationMessageId=current. Sync mempertahankan itemId dan semua fakta lain. Jangan sync jika tidak ada perubahan. Hapus satu item lewat removeItemIds, bukan cancel seluruh cart.`
      )
      results.push({ id: c.id, input: c.text, result })
      assert.notEqual(result.cartIntent?.action, 'checkout_balance')
      assert.notEqual(result.cartIntent?.action, 'report_payment')
      if (c.action) {
        assert.equal(result.cartIntent?.action, c.action)
        if (c.action === 'remove') assert.deepEqual(result.cartIntent?.removeItemIds, ['pants'])
      } else if (c.unchanged) {
        assert.isNull(result.cartIntent, 'Question/negation must not mutate the cart')
      } else {
        // Already-navy may correctly need no sync; a reversal must change both roles.
        if (c.id === 'color-change' && !result.cartIntent) return
        assert.equal(result.cartIntent?.action, 'sync')
        const jacket = result.cartIntent!.items.find((i) => i.id === 'jacket')!
        const pants = result.cartIntent!.items.find((i) => i.id === 'pants')!
        assert.exists(jacket)
        assert.exists(pants)
        assert.include(colors(jacket.productionDetails?.color), c.color)
        assert.include(colors(jacket.productionDetails?.lapel), c.lapel)
        assert.include(colors(pants.productionDetails?.color), 'navy')
        assert.equal(jacket.size, 'S')
        assert.equal(pants.size, '30')
        assert.isNotOk(jacket.modelConsent, 'No invented human approval')
      }
    }).timeout(180_000)
})
