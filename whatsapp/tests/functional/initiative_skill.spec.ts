import { test } from '@japa/runner'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'
import { readFile } from 'node:fs/promises'

async function fixtureSettings() {
  const settings = await readSettings(true)
  const content = await readFile('skills/cs-format-jawaban/SKILL.md', 'utf8')
  return {
    ...settings,
    mcpConnections: [],
    paymentMethods: [],
    skills: settings.skills.map((skill) =>
      skill.name === 'cs-format-jawaban' ? { ...skill, content } : skill
    ),
  }
}

// Explicit opt-in: uses OAuth quota, but never sends WhatsApp or changes a room.
// Business facts below are isolated test fixtures, not real orders or prices.
const live = process.env.AI_SKILL_LIVE_TEST === '1'
const isolatedProgress = live && process.env.DISCOUNT_DB_TEST === '1'
const passiveGate =
  /(?:kalau|jika|bila|apabila)\s+(?:jadi|mau|ingin|berminat)|konfirmasi\s+(?:untuk\s+)?lanjut|belum\s+(?:ada\s+)?konfirmasi|mau\s+(?:lanjut|pesan|checkout)/i

async function progressSettings() {
  const settings = await readSettings(true)
  const skills = await Promise.all(
    ['cs-format-jawaban', 'cs-cart-order'].map(async (name, index) => ({
      id: index + 1,
      name,
      description: name,
      content: await readFile(`skills/${name}/SKILL.md`, 'utf8'),
    }))
  )
  return { ...settings, skills, mcpConnections: [], paymentMethods: [], aiFailover: false }
}

const context = `UJI TERISOLASI: semua nama/alamat/angka berikut fixture fiktif, bukan pesanan nyata.
Tidak boleh mengubah data bisnis atau mengirim pesan WhatsApp.
Snapshot data bisnis terverifikasi KHUSUS FIXTURE: Jas Uji navy size M tersedia,
harga Rp400.000; celana Uji navy size 30 tersedia, harga Rp200.000;
layanan REG ke alamat fixture Rp10.000, estimasi 3–6 hari. Tidak ada diskon/biaya lain.
RIWAYAT SESI YANG SAMA:
PELANGGAN [message_id: fixture-items-1]: Saya jadi pesan Jas Uji navy M satu dan celana Uji navy 30 satu.
CS: Jas Rp400.000, celana Rp200.000. REG Rp10.000 (3–6 hari), YES Rp20.000 (1 hari).
PELANGGAN [message_id: fixture-shipping-1]: Pakai REG. Penerima Budi Uji, nomor 081200000000.
CS: Alamat lengkapnya bos?
CATATAN: produk, jumlah, ukuran, penerima, nomor, REG sudah dipilih.
Menunggu alamat, belum pernah mengirim rekap, belum ada pembayaran.
PESAN PELANGGAN SAAT INI [message_id: fixture-address-1]: Alamatnya Jalan Contoh Uji 12, RT 01 RW 02, Kelurahan Uji, Kecamatan Uji, Kabupaten Uji, 12345.`

test.group('Live imported initiative skill', () => {
  for (const alreadyAsked of [false, true])
    test(`confirmed customization continues without checkout consent: destination ${alreadyAsked ? 'already asked' : 'missing'}`, async ({
      assert,
    }) => {
      const result = await createReply(
        await progressSettings(),
        alreadyAsked ? 'Review internal, tidak ada pesan pelanggan baru.' : 'Gimana bos',
        undefined,
        undefined,
        `UJI TERISOLASI: produk dan harga di bawah adalah fixture fiktif; jangan menghubungi MCP atau mengirim WhatsApp.
PELANGGAN: Jas Uji Black bisa dibuat badan navy dan lapel hitam?
CS: Iya bisa bos.
PELANGGAN: Celananya yang serasi saja, size 30.
AI: Jas Uji navy lapel hitam dan Pants Uji Navy 30 total barang Rp705.000. Untuk tinggi 167 cm/berat 56 kg, rekomendasi jas S. Mau pakai S ya bos?
PELANGGAN: Iya.
PELANGGAN: Gimana bos.
${alreadyAsked ? 'AI (SUDAH TERKIRIM SETELAH PESAN GIMANA): Kecamatan tujuan pengirimannya mana bos?\nPelanggan belum membalas pertanyaan kecamatan tersebut.' : 'Belum pernah meminta tujuan pengiriman; pesan Gimana belum dijawab.'}
CART TERVERIFIKASI FIXTURE: Jas Uji katalog size S, badan navy, lapel hitam, modelApproval approved dengan bukti CS; Pants Uji Navy 30. Harga/stok sudah diperiksa. Tujuan/alamat/ongkir belum ada, belum ada rekap checkout, dana atau order.
CATATAN AI LAMA: pelanggan belum menyatakan ingin checkout; tunggu keputusan ingin memesan.
Tidak perlu lookup bisnis untuk satu pertanyaan data yang kurang. Jangan menyatakan order sudah dibuat atau meminta pembayaran.`
      )
      if (alreadyAsked) {
        assert.equal(result.decision, 'silent')
        assert.equal(result.message, '')
        assert.equal(result.initiative || '', '')
      } else {
        assert.equal(result.decision, 'reply')
        const messages = [result.message, result.initiative || ''].filter(Boolean)
        assert.lengthOf(messages, 1)
        assert.match(messages[0], /kecamatan|tujuan|alamat/i)
        assert.notMatch(messages[0], /mau (lanjut|pesan|checkout)|transfer|rekening|size.*\?/i)
        assert.notMatch(messages.join('\n'), passiveGate)
        assert.match(result.goal?.waiting_for || '', /kecamatan|tujuan|alamat/i)
      }
      assert.notEqual(result.cartIntent?.action, 'checkout_balance')
      assert.notEqual(result.cartIntent?.action, 'report_payment')
    })
      .skip(!isolatedProgress)
      .timeout(180_000)

  test('confirmed selection requests the missing recipient directly', async ({ assert }) => {
    const result = await createReply(
      await progressSettings(),
      'Pakai REG bos',
      undefined,
      undefined,
      `UJI TERISOLASI, semua data fixture, tidak ada MCP atau WhatsApp nyata.
Pelanggan telah memilih Jas Uji navy M dan celana navy 30. Total barang Rp600.000 sudah diverifikasi.
Pelanggan sudah memberi alamat Jalan Contoh 12, Kecamatan Uji, Kota Uji, kode pos 12345, nomor penerima 081200000000.
Tarif tool fixture: REG Rp10.000 (3–6 hari), YES Rp20.000 (1 hari). AI sudah menyampaikan pilihan tarif itu. Pesan saat ini memilih REG.
Nama penerima belum diketahui/belum ditanyakan. Semua pilihan barang, ukuran, alamat, nomor, tarif REG sudah pasti. Belum ada rekap final atau pembayaran.
Catatan AI lama: tunggu pelanggan menyatakan jadi pesan sebelum melengkapi data. Tidak ada penundaan atau penolakan dari pelanggan.`
    )
    assert.equal(result.decision, 'reply')
    const text = [result.message, result.initiative || ''].filter(Boolean).join('\n')
    assert.match(text, /nama|atas nama/i)
    assert.match(text, /penerima|siapa/i)
    assert.notMatch(text, passiveGate)
    assert.notMatch(text, /(?:kirim|minta|tulis|isi|sebutkan).*alamat|kecamatan.*(?:mana|apa)/i)
    assert.match(result.goal?.waiting_for || '', /nama|penerima/i)
    assert.notEqual(result.cartIntent?.action, 'checkout_balance')
    assert.notEqual(result.cartIntent?.action, 'report_payment')
  })
    .skip(!isolatedProgress)
    .timeout(180_000)

  test('active service respects a customer postponing a selected cart', async ({ assert }) => {
    const result = await createReply(
      await progressSettings(),
      'Nanti dulu ya bos, saya pikir-pikir dulu. Jangan ditawari dulu.',
      undefined,
      undefined,
      `Fixture fiktif tanpa MCP/WhatsApp nyata. Pelanggan telah memilih Jas Uji navy M dan celana navy 30. Cart memuat pilihan itu; alamat belum ada. Pesan terbaru pelanggan menunda dan meminta tidak ditawari. Belum ada rekap, persetujuan transaksi, order atau pembayaran.`
    )
    assert.notEqual(result.decision, 'handoff')
    assert.equal(result.initiative || '', '')
    assert.notMatch(result.message, /\?|kecamatan|alamat|penerima|transfer|rekening|promo|diskon/i)
    assert.isNull(result.goal?.follow_up ?? null)
    assert.notEqual(result.cartIntent?.action, 'checkout_balance')
    assert.notEqual(result.cartIntent?.action, 'report_payment')
  })
    .skip(!isolatedProgress)
    .timeout(180_000)

  test('complete order triggers a separate recap with verified total', async ({ assert }) => {
    const settings = await fixtureSettings()
    const result = await createReply(
      { ...settings, mcpConnections: [], paymentMethods: [] },
      'Alamatnya Jalan Contoh Uji 12, RT 01 RW 02, Kelurahan Uji, Kecamatan Uji, Kabupaten Uji, 12345.',
      undefined,
      undefined,
      context
    )
    assert.equal(result.decision, 'reply')
    const recap = result.initiative || ''
    assert.include(recap, 'Jas')
    assert.match(recap, /celana/i)
    assert.include(recap, '30')
    assert.include(recap, 'Budi')
    assert.include(recap, 'Contoh Uji 12')
    assert.include(recap, 'REG')
    assert.match(recap, /610[.,]?000/)
    assert.isAbove(recap.split('\n').length, 4)
    assert.isNotEmpty(result.goal?.waiting_for || '')
    assert.notEqual(result.goal?.status, 'completed')
  })
    .skip(!live)
    .timeout(180_000)

  test('missing size does not trigger a premature recap or measurement-policy dump', async ({
    assert,
  }) => {
    const settings = await fixtureSettings()
    const result = await createReply(
      { ...settings, mcpConnections: [], paymentMethods: [] },
      'Tinggi saya 167 cm dan berat 56 kg.',
      undefined,
      undefined,
      'Uji terisolasi, jangan mengubah data atau mengirim pesan. Pelanggan baru memilih jas dan celana, belum memilih model dan ukuran. CS baru menanyakan tinggi dan berat. Belum ada data pesanan atau harga terverifikasi.'
    )
    assert.equal(result.decision, 'reply')
    assert.isNotEmpty(result.message)
    assert.equal(result.initiative || '', '')
    assert.notMatch(result.message, /wewangian|pengembalian maksimal|label masih utuh/i)
    assert.notEqual(result.goal?.status, 'completed')
  })
    .skip(!live)
    .timeout(180_000)

  test('confirmed choices lead to the missing address, not another size or service acknowledgement', async ({
    assert,
  }) => {
    const result = await createReply(
      await fixtureSettings(),
      'Iya betul, sama seperti yang tadi.',
      undefined,
      undefined,
      `UJI TERISOLASI, semua data fiktif, tidak ada pesan nyata/tool eksternal.
RIWAYAT SESI SAMA:
PELANGGAN: Pesan jas dan rompi size S, celana nomor 30. Satu set, pakai YES.
CS (AI): Siap bos, yang sebelumnya jas dan rompi size S, celana nomor 30 ya?
PELANGGAN (PESAN SAAT INI): Iya betul, sama seperti yang tadi.
CATATAN: pilihan produk, ukuran dan YES sudah pasti. Nama penerima Budi Uji, telepon 081200000000; hanya alamat lengkap yang belum diberikan. Harga/ongkir belum tersedia karena tujuan belum diketahui. Belum ada rekap/pembayaran. Tidak ada pertanyaan lain yang perlu dijawab.`
    )
    assert.equal(result.decision, 'reply')
    const messages = [result.message, result.initiative || ''].filter(Boolean)
    assert.lengthOf(messages, 1)
    assert.match(messages[0], /alamat/i)
    assert.notMatch(messages[0], /\bYES\b|\bsize\s*S\b|\b30\b|jas dan rompi/i)
    assert.notEqual(result.goal?.status, 'completed')
  })
    .skip(!live)
    .timeout(180_000)

  test('internal review waits silently for an already-sent confirmation', async ({ assert }) => {
    const result = await createReply(
      await fixtureSettings(),
      'Review internal AI aktif, tidak ada pesan pelanggan baru.',
      undefined,
      undefined,
      `UJI TERISOLASI, semua data fiktif, tidak ada pesan nyata/tool eksternal.
RIWAYAT: PELANGGAN memilih jas/rompi S dan celana 30, layanan YES. CS (AI) sudah mengirim rekap lengkap beserta harga, penerima, alamat dan layanan, lalu meminta konfirmasi rekap. Pelanggan BELUM membalas.
STATE: goal waiting_customer, waiting_for konfirmasi rekap; cart sudah sesuai rekap, tidak ada perubahan data, tidak ada susulan jatuh tempo, tidak ada pembayaran. Pemeriksaan bisnis fixture sudah selesai tanpa perubahan. Review bukan pesan pelanggan dan bukan konfirmasi rekap.`
    )
    assert.equal(result.decision, 'silent')
    assert.equal(result.message, '')
    assert.equal(result.initiative || '', '')
    assert.notEqual(result.goal?.status, 'completed')
  })
    .skip(!live)
    .timeout(180_000)
})
