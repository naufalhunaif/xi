import { test } from '@japa/runner'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createReply } from '#services/ai_service'
import { initializeDatabase } from '#services/init_model'
import { resetQuota } from '#services/ai_quota_store'
import { defaultProductionPolicy } from '#services/production_contract'
import env from '#start/env'

// Explicit opt-in; six synthetic turns at most, no business MCP or WhatsApp sends.
test.group('Sales progress semantic regression (live provider, synthetic customer)', (group) => {
  group.each.skip(
    process.env.AI_SKILL_LIVE_TEST !== '1' ||
      !process.env.COMPACT_SKILL_FIXTURE_DIR ||
      process.env.DISCOUNT_DB_TEST !== '1'
  )
  group.setup(async () => {
    if (process.env.AI_SKILL_LIVE_TEST !== '1' || process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable database only')
    await initializeDatabase()
  })
  for (const compact of [true, false])
    for (const scenario of ['preorder', 'disabled', 'paused']) {
      const paused = scenario === 'paused'
      const allowed = scenario !== 'disabled'
      test(`sales preference ${compact ? 'compact' : 'full'} ${scenario}`, async ({ assert }) => {
        const directory = process.env.COMPACT_SKILL_FIXTURE_DIR!
        const skills = await Promise.all(
          (await readdir(directory))
            .filter((name) => name.endsWith('.md'))
            .map(async (name) => ({
              name: name.replace(/\.md$/, ''),
              content: await readFile(join(directory, name), 'utf8'),
            }))
        )
        env.set('AI_COMPACT_REPLY_ENABLED', compact as unknown as string)
        env.set('AI_ADAPTIVE_ROUTING_ENABLED', false as unknown as string)
        await resetQuota('chatgpt')
        const production = defaultProductionPolicy()
        production.version = 'synthetic-preorder-policy'
        production.rules.preorder = {
          enabled: allowed,
          minDays: 7,
          maxDays: 14,
          estimateDays: 10,
          dayType: 'working',
          startsAfter: 'payment_details',
        }
        const current = paused
          ? 'Yang coco bagus nih, tapi nanti dulu ya jangan ditawari dulu.'
          : 'Yang coco bagus nih'
        const context = `UJI TERISOLASI, seluruh percakapan dan data berikut fixture fiktif. Tidak ada MCP/WhatsApp/transaksi nyata.
Sumber bisnis fixture yang sudah diperiksa: Basic Suit Cream size S ready, Basic Suit Choco size S kosong; masing-masing Rp485.000 jas saja. ${allowed ? 'KEPUTUSAN PRODUKSI LOKAL FIXTURE: CS fixture mengizinkan Basic Suit Choco size S dipreorder, mengikuti aturan produksi lokal. Ini izin menawarkan, BUKAN persetujuan preorder dari pelanggan; belum pernah ditawarkan.' : 'KEPUTUSAN PRODUKSI LOKAL FIXTURE: preorder Choco tidak tersedia; jangan menggantinya dengan data MCP.'} Tidak ada tanggal restock yang sah. Tidak ada cart/order. Sumber lokal sudah lengkap untuk menentukan opsi yang tersedia; jangan meminta waktu/acara sebelum menawarkan solusi stok. Customer sudah menyebut size S, bukan rekomendasi AI. Waktu/acara pemakaian belum diketahui/belum ditanyakan. Belum pernah menawarkan celana.
RIWAYAT:
PELANGGAN [fixture-size]: Biasa S bos.
PELANGGAN [fixture-colors]: Cream sama choco coba.
AI: Ini Basic Suit Cream dan Choco, bos. Masing-masing Rp485.000 untuk jas saja. Size S: Cream ready, Choco kosong.
AI: [foto Cream dan Choco sudah dikirim]
AI [fixture-question]: Dari dua warna ini, bos lebih suka yang mana?
PELANGGAN [fixture-choice]: ${current}
Goal lama waiting_answer, menunggu pilihan warna. Pesan terbaru menjawab pertanyaan itu; belum merupakan otorisasi order/pembayaran.`
        const traces: any[] = []
        const result = await createReply(
          {
            aiProvider: 'chatgpt',
            aiFailover: false,
            chatgptModel: process.env.AI_TEST_MODEL || 'gpt-5.5',
            chatgptReasoning: 'high',
            skills,
            production,
            mcpConnections: [],
            paymentMethods: [],
            routingContext: {
              indexContext: context,
              lastQuestion: 'Dari dua warna ini, bos lebih suka yang mana?',
              waitingFor: 'Pilihan warna',
              hasCart: false,
            },
          },
          current,
          undefined,
          undefined,
          context,
          [],
          (event) => traces.push(event)
        )
        const answer = [result.message, result.initiative || ''].filter(Boolean).join('\n')
        console.log(
          JSON.stringify({
            compact,
            scenario,
            message: result.message,
            initiative: result.initiative,
            salesProgress: result.salesProgress,
            usage: traces
              .filter((row) => row.detail?.usage)
              .map((row) => ({ phase: row.key, ...row.detail.usage })),
          })
        )
        assert.equal(result.decision, 'reply')
        assert.notEqual(result.cartIntent?.action, 'checkout_balance')
        assert.notEqual(result.cartIntent?.action, 'report_payment')
        if (paused) {
          assert.equal(result.initiative || '', '')
          assert.notMatch(answer, /\?|？/)
          assert.isNull(result.goal?.follow_up ?? null)
        } else {
          // A relevant next step may stand alone in message; a second bubble is not required.
          const nextStep =
            result.initiative ||
            (result.salesProgress?.delivery === 'message' ? result.message : '')
          assert.isNotEmpty(nextStep)
          assert.notMatch(nextStep, /kapan|acara|keperluan|kebutuhan|dipakai|pemakaian/i)
          if (allowed) {
            assert.match(answer, /pre[ -]?order|\bPO\b/i)
            assert.match(answer, /estimasi|sekitar/i)
            assert.match(answer, /hari kerja/i)
            assert.match(nextStep, /pre[ -]?order|\bPO\b|lanjut|tunggu/i)
          } else {
            assert.match(nextStep, /cream|alternatif|warna lain|model lain/i)
            assert.notMatch(answer, /(?:bisa|tersedia|boleh).{0,12}pre[ -]?order/i)
          }
          assert.notMatch(nextStep, /(?:size|ukuran).*(?:apa|berapa|mana)/i)
          assert.notMatch(answer, /choco.*(?:S ready|pasti tersedia|pasti bisa|restock \d)/i)
          assert.notEqual(result.goal?.status, 'completed')
          assert.notMatch(result.goal?.waiting_for || '', /^pilihan warna$/i)
        }
      }).timeout(180000)
    }
})
