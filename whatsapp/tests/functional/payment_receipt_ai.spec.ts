import { test } from '@japa/runner'
import sharp from 'sharp'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readReceiptImage } from '#services/ai_service'
import { readSettings } from '#services/settings_service'

// Explicit OAuth opt-in. Synthetic, visibly labelled fixture; no payment or WhatsApp action.
test('OAuth vision reads transferred amount and destination, not fee, debit or sender', async ({
  assert,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'wa-receipt-test-'))
  try {
    const lines = [
      'SIMULASI UJI - BUKAN TRANSAKSI NYATA',
      'BUKTI TRANSFER',
      'Status: Berhasil',
      'Bank pengirim: Bank Asal Uji',
      'Rekening pengirim: 111122223333',
      'Bank tujuan: Bank Uji',
      'Rekening tujuan: 999988887777',
      'Nominal transfer: Rp300.000',
      'Biaya admin: Rp2.500',
      'Total debit: Rp302.500',
      'Nomor referensi: UJI-REF-300001',
    ]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="920"><rect width="100%" height="100%" fill="white"/>${lines.map((line, index) => `<text x="35" y="${55 + index * 75}" font-family="Arial" font-size="32" fill="black">${line}</text>`).join('')}</svg>`
    const path = join(directory, 'fixture.png')
    await sharp(Buffer.from(svg)).png().toFile(path)
    const reading = await readReceiptImage(await readSettings(), path)
    assert.equal(reading.amount, 300000)
    assert.equal(reading.currency, 'IDR')
    assert.equal(reading.recipientAccount, '999988887777')
    assert.equal(reading.reference, 'UJI-REF-300001')
    assert.equal(reading.status, 'success')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
  .skip(process.env.AI_RECEIPT_LIVE_TEST !== '1')
  .timeout(180_000)
