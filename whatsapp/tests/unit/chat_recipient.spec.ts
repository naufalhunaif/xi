import { test } from '@japa/runner'
import { recipientForm } from '#beta3/order_service'
import { dropAiTotal, guardTotalPromise } from '#beta3/reply_service'
import { LEAN_OUTPUT_SCHEMA, parseLeanDecision } from '#beta3/prompt'

// v3.6.124 — data penerima dikumpulkan lewat obrolan (bukan form) menjadi order. Data contoh fiktif.
const chat = ['Basic hitam aja', 'S', 'Jas aja', 'Jl melati sukamaju patimuan cilacap', 'Budi', 'Pake nomor ini aja', 'Belum tau'].join('\n')
const recipient = { nama: 'Budi', alamat: 'Jl Melati, Sukamaju', kecamatan: 'Patimuan', kota: 'Cilacap', kode_pos: '53264', telp: 'nomor ini' }

test.group('Beta3 data penerima dari obrolan', () => {
  test('nama + alamat + "pakai nomor ini" → form order dengan nomor WhatsApp, kode pos tebakan dibuang', ({ assert }) => {
    const built = recipientForm(recipient, chat, '081200000001')
    assert.isNotNull(built)
    assert.equal(built!.form.customerName, 'Budi')
    assert.equal(built!.form.district, 'Patimuan')
    assert.equal(built!.form.regency, 'Cilacap')
    assert.equal(built!.form.phone, '081200000001')
    assert.isTrue(built!.fromWa)
    // Pelanggan bilang "belum tau" → kode pos dari AI tidak dipakai.
    assert.equal(built!.form.postalCode, '')
    assert.equal(built!.form.address, 'Jl Melati, Sukamaju, Kec. Patimuan, Cilacap')
    // Nama kecamatan yang juga nama jalan tetap ditulis sebagai kecamatan.
    const street = recipientForm({ ...recipient, alamat: 'Jl Patimuan, Sukamaju, Cilacap' }, `${chat}\njl patimuan`, '081200000001')
    assert.equal(street!.form.address, 'Jl Patimuan, Sukamaju, Kec. Patimuan, Cilacap')
  })

  test('nomor dan kode pos yang ditulis pelanggan dipakai', ({ assert }) => {
    const built = recipientForm({ ...recipient, telp: '+62 812-0000-0002', kode_pos: '53264' }, `${chat}\n0812 0000 0002\n53264`, '081200000001')
    assert.equal(built!.form.phone, '081200000002')
    assert.isFalse(built!.fromWa)
    assert.equal(built!.form.postalCode, '53264')
  })

  test('data yang tidak pernah ditulis pelanggan / belum lengkap → bukan order', ({ assert }) => {
    assert.isNull(recipientForm({ ...recipient, nama: 'Andi' }, chat, '081200000001'))
    assert.isNull(recipientForm({ ...recipient, kecamatan: 'Kedungreja', kota: 'Banyumas' }, chat, '081200000001'))
    assert.isNull(recipientForm({ ...recipient, alamat: '' }, chat, '081200000001'))
    // Instagram: tanpa nomor WhatsApp dan tanpa nomor ditulis → tanyakan nomor dulu.
    assert.isNull(recipientForm(recipient, chat, ''))
    assert.isNull(recipientForm(null, chat, '081200000001'))
  })

  test('skema keluaran punya penerima (boleh null) dan parser membacanya', ({ assert }) => {
    assert.include(LEAN_OUTPUT_SCHEMA.required as readonly string[], 'penerima')
    assert.include(LEAN_OUTPUT_SCHEMA.properties.penerima.anyOf[0].description, 'Kode pos TIDAK wajib')
    const decision = parseLeanDecision(
      JSON.stringify({ pesan: ['siap bos'], foto: [], catatan: '', tahap: 'tunggu_cs', serah_cs: false, alasan: '', susulan: '', spesifikasi: 'Basic Suit - Black 2.0', referensi: [], bukti: [], pembayaran: null, order: null, penerima: recipient })
    )
    assert.deepEqual(decision.penerima, recipient)
    const none = parseLeanDecision(
      JSON.stringify({ pesan: ['siap'], foto: [], catatan: '', tahap: 'lain', serah_cs: false, alasan: '', susulan: '', spesifikasi: '', referensi: [], bukti: [], pembayaran: null, order: null, penerima: null })
    )
    assert.isUndefined(none.penerima)
  })

  test('alur balasan mencatat order dari data obrolan lalu menyusun ulang sekali', async ({ assert }) => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../../app/beta3/reply_service.ts', import.meta.url), 'utf8')
    assert.include(source, 'const viaChatOrder = await chatOrderReply(decision.penerima)')
    assert.include(source, 'input.chatOrder')
    assert.include(source, 'chatOrder: true')
  })

  test('"saya proses dulu totalnya" tanpa order dianggap janji total', ({ assert }) => {
    const guarded = guardTotalPromise(['Siap bos, data pesanannya sudah lengkap ya, saya proses dulu totalnya'], { address: 'bos', hasAddress: true })
    assert.isTrue(guarded.changed)
    assert.notInclude(guarded.pesan.join(' '), 'proses dulu totalnya')
  })

  test('total otomatis terkirim → total tulisan AI dibuang (tidak dobel)', ({ assert }) => {
    const dup = dropAiTotal(['Siap bos, totalnya 460.050\nJas Basic Suit - Black 2.0 promo 451.050\nOngkir REG 9.000'])
    assert.isTrue(dup.changed)
    assert.deepEqual(dup.pesan, ['Siap bos, ini totalnya ya'.replace('Siap', 'siap')])
    const kept = dropAiTotal(['Siap bos, ini totalnya ya'])
    assert.isFalse(kept.changed)
    const mixed = dropAiTotal(['Siap bos, REG ya', 'Totalnya 460.050 bos'])
    assert.deepEqual(mixed.pesan, ['Siap bos, REG ya'])
  })
})
