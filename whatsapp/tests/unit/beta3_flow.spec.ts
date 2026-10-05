import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { recoverHandledOrder, missedOrderForm, totalFromStoreMessages, finishLeanGoal, claimLeanNudge } from '#beta3/reply_service'
import { saveLeanOrder, applyCsTotalMessage, approveLeanOrder, reopenLeanOrderForChange, readLeanOrder, reconcileCsTotals, applyCsPaymentConfirm } from '#beta3/order_service'
import { fixCatalogColors, swapColorWords } from '#beta3/color_fix'
import Beta3Controller from '#controllers/beta3_controller'
import { writeOrderSpec } from '#beta3/customer_service'
import { latestLeanOrder } from '#beta3/order_service'

test.group('beta3 · alur order (database)', () => {
  test('form terlewat + total CS → order menunggu pembayaran', async ({ assert }) => {
    const jid = 'tmprec@s.whatsapp.net'
    await latestLeanOrder(jid)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const now = Date.now()
    const at = (min: number) => new Date(now - min * 60_000)
    const base = { jid, status: 'received' }
    const form =
      'Nama : Budi\nAlamat lengkap : Jl Contoh 1\nKecamatan : Wara\nKabupaten : Kota Palopo\nKode Pos : 91922\nNo. telp : 081200000000\n\nNote : -'
    await db.table('whatsapp_messages').multiInsert([
      {
        ...base,
        message_id: 'r1',
        direction: 'in',
        sender_type: 'customer',
        body: form,
        created_at: at(180),
      },
      {
        ...base,
        message_id: 'r2',
        direction: 'out',
        sender_type: 'cs',
        body: 'untuk dp minimal 50% bos',
        created_at: at(178),
      },
      {
        ...base,
        message_id: 'r3',
        direction: 'out',
        sender_type: 'cs',
        body: 'Beskap, Celana 705.000, ongkir 95.000, Total 705.000 + 95.000 = 800.000 bos',
        created_at: at(140),
      },
      {
        ...base,
        message_id: 'r4',
        direction: 'out',
        sender_type: 'cs',
        body: 'Untuk pembayaran tf ke rek BRI 1112223334445 An Toko agar pesanan langsung kami proses',
        created_at: at(134),
      },
      {
        ...base,
        message_id: 'r5',
        direction: 'in',
        sender_type: 'customer',
        body: '',
        media_type: 'image',
        created_at: at(10),
      },
    ])
    assert.deepEqual(
      totalFromStoreMessages([
        'Beskap, Celana 705.000, ongkir 95.000, Total 705.000 + 95.000 = 800.000 bos',
      ]),
      { total: 800000, ongkir: 95000 }
    )
    const found = await missedOrderForm(jid, new Set(), ['1112223334445'], { name: '', phone: '' })
    assert.isTrue(found?.handled)
    const id = await recoverHandledOrder(jid, ['1112223334445'])
    assert.isNumber(id)
    const order = await latestLeanOrder(jid)
    assert.equal(order.status, 'awaiting_payment')
    assert.equal(Number(order.total), 800000)
    assert.equal(Number(order.shipping_cost), 95000)
    // Bukti transfer setelah total CS ikut tampil untuk dicek.
    assert.isBelow(new Date(order.updated_at).getTime(), Date.now() - 100 * 60_000)
    assert.isNull(await recoverHandledOrder(jid, ['1112223334445']))
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
  })

  // v3.6.30 (ulasan #17): total yang diketik CS setelah total sistem terkirim memperbarui order saat itu juga.
  test('total CS di chat memperbarui order yang sudah menunggu pembayaran (belum dibayar)', async ({ assert }) => {
    const jid = 'tmpcstotal@s.whatsapp.net'
    await latestLeanOrder(jid)
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const id = await saveLeanOrder({
      jid,
      form: { customerName: 'Retno', address: 'Sidomoro', district: 'Buluspesantren', regency: 'Kebumen', postalCode: '54391', phone: '0812', note: '' } as any,
      items: 'Basic Suit - Cream size L 485.000',
      spec: 'Basic Suit - Cream, size L\nJas',
      shippingOptions: { prices: [{ service: 'CTC', price: 18000 }], grams: 800 },
    })
    await approveLeanOrder({ id, shippingService: 'CTC', shippingCost: 18000, subtotal: 485000 })
    assert.equal((await readLeanOrder(id))?.status, 'awaiting_payment')
    // Pesan CS biasa tidak mengubah apa pun.
    assert.isNull(await applyCsTotalMessage(jid, 'Untuk pembayaran tf ke rek BRI 1112223334445 An Toko'))
    const applied = await applyCsTotalMessage(jid, 'Jas, Celana, Rompi 880.000\nongkir 2kg, 2 x 18.000 =36.000 \n\ntotal 880.000 + 36.000 =916.000 bos')
    assert.equal(applied?.total, 916000)
    const order = await readLeanOrder(id)
    assert.equal(order.status, 'awaiting_payment')
    assert.equal(Number(order.total), 916000)
    assert.equal(Number(order.shipping_cost), 36000)
    assert.equal(Number(order.subtotal), 880000)
    assert.equal(String(order.items), 'Jas, Celana, Rompi 880.000')
    assert.equal(String(order.cs_note), 'total dikirim CS di chat')
    // Total yang sama dikirim lagi → tidak ada perubahan.
    assert.isNull(await applyCsTotalMessage(jid, 'total 880.000 + 36.000 = 916.000 bos'))
    // Item berubah sebelum dibayar → order bisa dibuka lagi untuk dihitung sistem; sudah dibayar → tidak.
    assert.isTrue(await reopenLeanOrderForChange(id))
    assert.equal((await readLeanOrder(id))?.status, 'pending')
    await db.from('whatsapp_beta3_orders').where('id', id).update({ status: 'awaiting_payment', paid_amount: 916000 })
    assert.isFalse(await reopenLeanOrderForChange(id))
    assert.isNull(await applyCsTotalMessage(jid, 'total 900.000 + 36.000 = 936.000 bos'))
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
  })

  // v3.6.32 (Retno): total CS dikirim sebelum v3.6.30, dana 916.000 dikonfirmasi, order tetap 503.000.
  test('order lunas yang totalnya tertinggal disamakan dengan total CS yang nominalnya = dana masuk', async ({ assert }) => {
    const jid = 'tmpreconcile@s.whatsapp.net'
    await latestLeanOrder(jid)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const id = await saveLeanOrder({
      jid,
      form: { customerName: 'Retno', address: 'Sidomoro', district: 'Buluspesantren', regency: 'Kebumen', postalCode: '54391', phone: '0812', note: '' } as any,
      items: 'Basic Suit - Cream\nJas, Celana, Rompi',
      spec: 'Basic Suit - Cream\nJas, Celana, Rompi',
    })
    await db.from('whatsapp_beta3_orders').where('id', id).update({
      status: 'paid', subtotal: 485000, shipping_cost: 18000, total: 503000, paid_amount: 916000, created_at: new Date(Date.now() - 3600_000),
    })
    const at = (min: number) => new Date(Date.now() - min * 60_000)
    await db.table('whatsapp_messages').multiInsert([
      { jid, message_id: 'rc1', direction: 'out', sender_type: 'ai', status: 'sent', body: 'Basic Suit - Cream size L 485.000\nOngkir REG 18.000\n\nTotal 485.000 + 18.000 = 503.000 bos', created_at: at(40) },
      { jid, message_id: 'rc2', direction: 'out', sender_type: 'cs', status: 'sent', body: 'Jas, Celana, Rompi 880.000\nongkir 2kg, 2 x 18.000 =36.000 \n\ntotal 880.000 + 36.000 =916.000 bos', created_at: at(20) },
    ])
    assert.isAtLeast(await reconcileCsTotals(), 1)
    const order = await readLeanOrder(id)
    assert.equal(Number(order.total), 916000)
    assert.equal(Number(order.shipping_cost), 36000)
    assert.equal(Number(order.subtotal), 880000)
    assert.equal(Number(order.paid_amount), 916000)
    assert.equal(String(order.items), 'Jas, Celana, Rompi 880.000')
    // Sudah sama → tidak diubah lagi.
    assert.equal(await reconcileCsTotals(), 0)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
  })

  test('konfirmasi dana dari CS di chat → lunas saat itu juga, hanya bila Jev yakin', async ({ assert }) => {
    const jid = 'tmppayconfirm@s.whatsapp.net'
    await latestLeanOrder(jid)
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const id = await saveLeanOrder({
      jid,
      form: { customerName: 'Budi', address: 'Jl 1', district: 'Wara', regency: 'Palopo', postalCode: '91922', phone: '0812', note: '' } as any,
      items: 'Setelan Basic Suit - Black 705.000',
    })
    await approveLeanOrder({ id, shippingService: 'REG', shippingCost: 20000, subtotal: 705000 })
    // Bukan konfirmasi dana → tidak bertanya Jev.
    let asked = 0
    const yes = async () => { asked++; return true as boolean | undefined }
    assert.isNull(await applyCsPaymentConfirm(jid, 'siap bos, ditunggu ya', yes))
    assert.equal(asked, 0)
    // Jev ragu → tidak dicatat.
    assert.isNull(await applyCsPaymentConfirm(jid, 'sudah masuk ya bos, terimakasih proses ya', async () => undefined))
    assert.equal((await readLeanOrder(id))?.status, 'awaiting_payment')
    const paid = await applyCsPaymentConfirm(jid, 'sudah masuk ya bos, terimakasih proses ya', yes)
    assert.equal(paid?.amount, 725000)
    const order = await readLeanOrder(id)
    assert.equal(order.status, 'paid')
    assert.equal(Number(order.paid_amount), 725000)
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
  })

  test('form terlewat tanpa total CS → diproses AI, sekali saja', async ({ assert }) => {
    const jid = 'tmpmissed@s.whatsapp.net'
    await latestLeanOrder(jid)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const now = Date.now()
    const at = (min: number) => new Date(now - min * 60_000)
    const base = { jid, status: 'received' }
    const form =
      'Nama : Budi\nAlamat Lengkap : Jl Merdeka 1\nKecamatan : Wara\nKabupaten : Palopo\nKode pos : 91911\nNo telp : 081234567890\n\nNote : setelan jas + celana'
    await db.table('whatsapp_messages').multiInsert([
      {
        ...base,
        message_id: 'm1',
        direction: 'in',
        sender_type: 'customer',
        body: form,
        created_at: at(20),
      },
      {
        ...base,
        message_id: 'm3',
        direction: 'out',
        sender_type: 'cs',
        body: 'bisa bos DP 50%, estimasi 7 hari',
        created_at: at(18),
      },
      {
        ...base,
        message_id: 'm4',
        direction: 'in',
        sender_type: 'customer',
        body: 'Berarti 800 ribu ya totalnya?',
        created_at: at(1),
      },
    ])
    const found = await missedOrderForm(jid, new Set(['m4']), [], { name: '', phone: '' })
    assert.equal(found?.messageId, 'm1')
    assert.isFalse(found?.handled)
    assert.isNull(await recoverHandledOrder(jid, []))
    await saveLeanOrder({ jid, sourceMessageId: 'm1', form: found!.form, items: 'x' })
    assert.isNull(await missedOrderForm(jid, new Set(['m4']), [], { name: '', phone: '' }))
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
  })

  test('panel room: form terlewat + total CS → tombol konfirmasi & bukti transfer tampil', async ({
    assert,
  }) => {
    const jid = 'tmproom@s.whatsapp.net'
    await latestLeanOrder(jid)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const at = (min: number) => new Date(Date.now() - min * 60_000)
    const base = { jid, status: 'received' }
    const form =
      'Nama : Budi\nAlamat lengkap : Jl Contoh 1\nKecamatan : Wara\nKabupaten : Kota Palopo\nKode Pos : 91922\nNo. telp : 081200000000\n\nNote : -'
    await db.table('whatsapp_messages').multiInsert([
      {
        ...base,
        message_id: 'q1',
        direction: 'in',
        sender_type: 'customer',
        body: form,
        created_at: at(180),
      },
      {
        ...base,
        message_id: 'q3',
        direction: 'out',
        sender_type: 'cs',
        body: 'Beskap, Celana 705.000, ongkir 95.000, Total 705.000 + 95.000 = 800.000 bos',
        created_at: at(140),
      },
      {
        ...base,
        message_id: 'q4',
        direction: 'out',
        sender_type: 'cs',
        body: 'Untuk pembayaran tf ke rek BRI 1112223334445 An Toko',
        created_at: at(134),
      },
      {
        ...base,
        message_id: 'q5',
        direction: 'in',
        sender_type: 'customer',
        body: '',
        media_type: 'image',
        media_url: '/media/proof.jpg',
        created_at: at(10),
      },
    ])
    await writeOrderSpec(jid, 'Bescap Cross Placket - Brown\nJas, Celana')
    let out: any
    const ctx: any = {
      request: { qs: () => ({ jid }) },
      response: { header() {}, json: (v: any) => (out = v), badRequest: (v: any) => (out = v) },
    }
    await new Beta3Controller().room(ctx)
    assert.equal(out.order?.status, 'awaiting_payment')
    assert.equal(Number(out.order?.total), 800000)
    assert.deepEqual(out.proofs, [{ media_url: '/media/proof.jpg' }])
    // Order dicatat dengan waktu form, bukan waktu panel dibuka.
    assert.isBelow(new Date(out.order.created_at).getTime(), Date.now() - 170 * 60_000)
    // Order lama yang tercatat belakangan (created_at sesudah bukti) tetap menampilkan buktinya.
    await db.from('whatsapp_beta3_orders').where('jid', jid).update({ created_at: new Date() })
    await new Beta3Controller().room(ctx)
    assert.deepEqual(out.proofs, [{ media_url: '/media/proof.jpg' }])
    // Nominal belum terbaca: tidak dianggap lunas (isian kosong, bukan total).
    assert.equal(Number(out.order.reported_amount || 0), 0)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
  })
})

test.group('beta3 · warna katalog', () => {
  test('warna spesifikasi mengikuti foto katalog di chat; warna custom dibiarkan', ({ assert }) => {
    const catalog = [
      { product: 'Bescap Cross Placket', color: 'Black' },
      { product: 'Bescap Cross Placket', color: 'Choco' },
      { product: 'Tuxedo', color: 'Brown' },
    ]
    // Warna di luar katalog = permintaan custom ("Broken White"): tidak diganti.
    assert.lengthOf(
      fixCatalogColors('Bescap Cross Placket - Broken White\nTuxedo - Brown', catalog).swaps,
      0
    )
    assert.deepEqual(swapColorWords(['warna brown-nya cocok', 'Brown ya'], [['Brown', 'Choco']]), [
      'warna choco-nya cocok',
      'Choco ya',
    ])
    // Produk punya Brown & Choco: warna mengikuti foto yang ditunjukkan di chat.
    const both = [...catalog, { product: 'Bescap Cross Placket', color: 'Brown' }]
    const chat = [
      { direction: 'out', mediaType: 'image', body: 'Bescap Cross Placket - Black' },
      { direction: 'in', mediaType: 'image', body: 'Yang seperti ini kak' },
      { direction: 'out', mediaType: 'image', body: 'Bescap Cross Placket - Choco' },
      { direction: 'in', body: 'Menurut kk jas/bahannya nikahable ga?' },
    ]
    assert.equal(
      fixCatalogColors('Bescap Cross Placket - Brown\nJas, Celana', both, chat).text,
      'Bescap Cross Placket - Choco\nJas, Celana'
    )
    // Pelanggan menyebut warnanya sendiri → tidak diubah.
    const said = [...chat, { direction: 'in', body: 'yang brown aja kak' }]
    assert.lengthOf(fixCatalogColors('Bescap Cross Placket - Brown', both, said).swaps, 0)
    const black = [...chat, { direction: 'in', body: 'saya pilih yang hitam' }]
    assert.lengthOf(fixCatalogColors('Bescap Cross Placket - Black', both, black).swaps, 0)
    // "coklat" ambigu (Brown & Choco) → tetap mengikuti foto.
    const coklat = [...chat, { direction: 'in', body: 'yang coklat ya' }]
    assert.equal(
      fixCatalogColors('Bescap Cross Placket - Brown', both, coklat).text,
      'Bescap Cross Placket - Choco'
    )
  })
})

test.group('akun AI · tugas latar (v3.5.10)', () => {
  test('akun "latar saja" (Gemini) didahulukan untuk tugas latar, dicadangkan untuk balasan pelanggan', async ({ assert }) => {
    const { createAiAccount, deleteAiAccount, usableAiAccounts } = await import('#services/ai_accounts')
    const claude = await createAiAccount({ provider: 'claude', label: 'uji-claude' })
    const gemini = await createAiAccount({ provider: 'gemini', label: 'uji-gemini', apiKey: 'uji-bukan-kunci-asli' })
    try {
      const order = async (phase: string) =>
        (await usableAiAccounts(Date.now(), phase)).map((a) => a.id).filter((id) => id === claude || id === gemini)
      assert.deepEqual(await order('beta3-ciri'), [gemini, claude])
      assert.deepEqual(await order('ig-analysis'), [gemini, claude])
      assert.deepEqual(await order('beta3-reply'), [claude, gemini])
      assert.deepEqual(await order('beta3-test'), [claude, gemini])
    } finally {
      await deleteAiAccount(claude)
      await deleteAiAccount(gemini)
    }
  })
})

test.group('prioritas chat · kotak masuk (v3.5.11)', () => {
  test('skor Jev tersimpan per chat dan dibatasi 1–5', async ({ assert }) => {
    const db = (await import('#services/workspace_database')).default
    const { saveChatPriority } = await import('#beta3/tables')
    const jid = 'prioritas-uji@s.whatsapp.net'
    try {
      await saveChatPriority(jid, 7)
      assert.equal(Number((await db.from('whatsapp_beta3_priority').where('jid', jid).first()).score), 5)
      await saveChatPriority(jid, 2)
      assert.equal(Number((await db.from('whatsapp_beta3_priority').where('jid', jid).first()).score), 2)
    } finally {
      await db.from('whatsapp_beta3_priority').where('jid', jid).delete()
    }
  })
})

test.group('susulan menuju pembelian (v3.5.16)', () => {
  test('"oke" tidak dibalas → susulan AI yang sudah direncanakan tetap terkirim walau pesan terakhir milik pelanggan', async ({ assert }) => {
    const jid = 'susulan-uji@s.whatsapp.net'
    const clean = async () => {
      await db.from('whatsapp_messages').where('jid', jid).delete()
      await db.from('whatsapp_chat_goals').where('jid', jid).delete()
    }
    await clean()
    try {
      const now = Date.now()
      const base = { jid, status: 'received' }
      await db.table('whatsapp_messages').multiInsert([
        { ...base, message_id: 'n1', direction: 'in', sender_type: 'customer', body: 'Set berapa ya', created_at: new Date(now - 3 * 60_000) },
        { ...base, message_id: 'n2', direction: 'out', sender_type: 'ai', status: 'sent', body: 'Setelan premium 955.000 bos, sudah jas + celana', created_at: new Date(now - 2 * 60_000) },
        { ...base, message_id: 'n3', direction: 'in', sender_type: 'customer', body: 'Oke', created_at: new Date(now - 60_000) },
      ])
      const oke = await db.from('whatsapp_messages').where('jid', jid).where('message_id', 'n3').first()
      await db.table('whatsapp_chat_goals').insert({
        jid,
        version: 'uji-susulan',
        anchor_id: oke.id,
        status: 'processing',
        objective: '',
        waiting_for: '',
        next_action: '',
        created_at: new Date(),
        updated_at: new Date(),
      })
      const goal = await finishLeanGoal(
        { jid, version: 'uji-susulan', anchor_id: Number(oke.id) },
        {
          pesan: [],
          foto: [],
          catatan: '',
          tahap: 'tanya_model',
          serah_cs: false,
          alasan: '',
          susulan: 'Mau sekalian saya bantu cek size setelan premiumnya bos? Cukup info tinggi & berat badannya',
          spesifikasi: '',
        }
      )
      assert.equal(goal?.status, 'waiting')
      assert.include(String(goal?.next_action), 'tinggi & berat badannya')
      await db.from('whatsapp_chat_goals').where('jid', jid).update({ next_run_at: new Date(now - 1000) })
      const nudge = await claimLeanNudge(jid)
      assert.include(String(nudge?.text), 'tinggi & berat badannya')

      // AI tidak menulis susulan → tidak ada kalimat bawaan (susulan selalu dari AI, nyambung konteks).
      const later = await finishLeanGoal(
        { jid, version: 'uji-susulan', anchor_id: Number(oke.id) },
        { pesan: ['Siap bos'], foto: [], catatan: '', tahap: 'lain', serah_cs: false, alasan: '', susulan: '', spesifikasi: '' }
      )
      assert.equal(later?.next_action, '')
    } finally {
      await clean()
    }
  })
})

