import { test } from '@japa/runner'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

const live = process.env.AI_SKILL_LIVE_TEST === '1' && process.env.DISCOUNT_DB_TEST === '1'
const cases = [
  {
    id: 'A01',
    text: 'Lengan jas saya yang tadi enam puluh, jadi lima puluh delapan senti aja bos.',
    expected: 58,
  },
  {
    id: 'A02',
    text: 'Tangannya yg jas gw itu pendekin dua senti dr yg 60 tadi ya bang.',
    expected: 58,
  },
  {
    id: 'A03',
    text: 'Ｐａｎｊａｎｇ ｌｅｎｇａｎ ｊａｓ ｓａｙａ ｇａｎｔｉ ｊａｄｉ ５８ ｃｍ ｙａ',
    expected: 58,
  },
  {
    id: 'B01',
    text: 'Jangan dipendekin jadi 58, tetap yang 60 cm tadi bos.',
    expected: 60,
    unchanged: true,
  },
  {
    id: 'D01',
    text: 'Lengan jas saya pendekin dikit ya bos.',
    expected: 60,
    unclear: 'unclear_change',
  },
  {
    id: 'E01',
    text: 'Yang punya bapak lengannya 59 senti aja, punya saya jangan diubah.',
    expected: 59,
    target: 'father',
  },
  {
    id: 'C01',
    text: 'Lingkar pinggang badan saya 32 inci ya bos, itu ukuran badan bukan nomor celana.',
    expected: 81.28,
    waist: true,
  },
  { id: 'C02', text: 'Nomor celana saya 32 bos.', waist: true, labelOnly: true },
  {
    id: 'F01',
    text: 'Pakai ukuran pesanan lama saya saja bos.',
    unclear: 'unclear_reference',
    oldMissing: true,
  },
] as const

test.group('Live custom size semantic intent', (group) => {
  group.each.skip(!live, 'Explicit live opt-in and disposable database required.')
  const results: unknown[] = []
  group.teardown(async () => {
    if (!live) return
    const directory = await mkdtemp(join(tmpdir(), 'wa-custom-size-semantic-'))
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2), {
      mode: 0o600,
    })
    console.log(`Synthetic semantic results: ${directory}/results.json`)
  })
  for (const entry of cases)
    test(`intent ${entry.id}: ${entry.text}`, async ({ assert }) => {
      const c: any = entry
      const settings = await readSettings(true)
      const skills = await Promise.all(
        ['cs-format-jawaban', 'cs-cart-order'].map(async (name, index) => ({
          id: index + 1,
          name,
          description: name,
          content: await readFile(`skills/${name}/SKILL.md`, 'utf8'),
        }))
      )
      const measure = c.waist ? 'Lingkar pinggang' : 'Panjang lengan'
      const basis = c.waist ? 'body' : 'garment'
      const items = ['self', 'father'].map((wearer, index) => ({
        id: wearer,
        productId: c.waist ? 'pants-test' : 'jacket-test',
        name: c.waist ? 'Pants Uji' : 'Jas Uji',
        image: 'https://example.com/fixture.jpg',
        size: 'custom',
        requestedSize: '',
        quantity: 1,
        unitPrice: 400000,
        modelType: 'catalog',
        approval: 'pending',
        modelApproval: 'standard',
        measurements: {},
        note: wearer === 'self' ? 'Untuk pelanggan sendiri' : 'Untuk bapak pelanggan',
        productionDetails: {
          heightCm: null,
          weightKg: null,
          fit: '',
          color: '',
          material: '',
          lapel: '',
          buttons: '',
          measurements:
            c.labelOnly || c.oldMissing
              ? []
              : [{ name: measure, value: c.waist ? 80 : 60 + index * 2, basis }],
          notes: '',
          pending: [],
          sourceMessageIds: ['fixture-original'],
        },
      }))
      const result = await createReply(
        { ...settings, skills, mcpConnections: [], paymentMethods: [], aiFailover: false },
        c.text,
        undefined,
        undefined,
        `UJI TERISOLASI: semua data adalah fixture fiktif. Tidak ada MCP atau WhatsApp nyata.
Produk, gambar dan harga custom Rp400000 per item sudah diverifikasi di fixture. Model katalog; hanya ukuran custom yang masih memerlukan verifikasi teknis CS setelah lengkap. Jangan meminta foto model atau lookup katalog lagi untuk koreksi ukuran.
Pelanggan memesan untuk dua pemakai: item self untuk dirinya, father untuk bapaknya. Mereka berbeda ukuran. Riwayat ukuran tersimpan di CART, semua dalam cm dan basis eksplisit. Bukti pesan pelanggan [fixture-original] mendukung ukuran masing-masing yang tercantum. Harga CS [fixture-price] untuk masing-masing item ini. Belum ada rekap, ongkir, transaksi atau pembayaran.
${c.oldMissing ? 'Pesanan lama yang dirujuk pelanggan TIDAK tersedia dalam konteks; cart sekarang belum berisi ukuran.' : ''}
CART: ${JSON.stringify({ items, recipient: { name: '', phone: '', address: '' }, shipping: { service: '', cost: null }, note: '' })}
Pesan pelanggan BARU [fixture-current]: ${c.text}
Jika sync, confirmationMessageId fixture-current, bawa seluruh item dan pertahankan fakta yang tidak diubah. Gunakan sourceMessageIds nyata fixture-original/fixture-current yang sesuai. Jangan membuat persetujuan CS atas ukuran.`
      )
      results.push({ id: c.id, input: c.text, result })
      assert.notEqual(result.cartIntent?.action, 'checkout_balance')
      assert.notEqual(result.cartIntent?.action, 'report_payment')
      if (c.unclear || c.labelOnly) {
        assert.equal(result.decision, 'reply')
        assert.isNotNull(result.customSizeQuestion)
        assert.equal(result.customSizeQuestion?.kind, c.unclear || 'missing_value')
        if (result.cartIntent?.action === 'sync') {
          const updated = result.cartIntent.items.find((i) => i.id === 'self')!
          assert.exists(updated)
          const values = updated.productionDetails?.measurements.map((m) => m.value) || []
          if (c.oldMissing || c.labelOnly) assert.deepEqual(values, [])
          else assert.include(values, 60)
        }
      } else if (c.unchanged && !result.cartIntent) {
        assert.notEqual(result.decision, 'handoff')
      } else {
        assert.equal(result.cartIntent?.action, 'sync')
        const target = result.cartIntent!.items.find((i) => i.id === (c.target || 'self'))!
        assert.exists(target)
        assert.isTrue(
          target.productionDetails?.measurements.some(
            (m) => m.basis === basis && Math.abs(m.value - c.expected) < 0.001
          )
        )
        const other = result.cartIntent!.items.find(
          (i) => i.id === (c.target === 'father' ? 'self' : 'father')
        )!
        assert.exists(other)
        assert.isTrue(
          other.productionDetails?.measurements.some(
            (m) => m.value === (c.waist ? 80 : c.target === 'father' ? 60 : 62)
          )
        )
      }
    }).timeout(180_000)
})
