// v3.7.0 (pemilik 13 Okt) — AI belajar dari balasan CS manusia sebelumnya: contoh dipilih per situasi,
// balasan CS ditampilkan utuh per bubble, auto-reply/template/salinan AI tidak dipelajari.
import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { clearExampleCache, pickExamples, renderExamples, type LeanExample } from '#beta3/examples_service'
import { exampleFromSegment, isHoldout, learnNewCsReplies, realSegments } from '#beta3/simulator'
import { ensureLeanTables } from '#beta3/tables'

const example = (id: number, customerText: string, csText: string, source = 'riwayat', situation = ''): LeanExample => ({
  id,
  situation,
  customerText,
  csText,
  tags: source === 'riwayat' ? 'riwayat' : 'tanya_model',
  source,
})

test.group('Belajar dari CS · memilih & menampilkan contoh', () => {
  test('pesan pendek ("brp bos") tetap menemukan jawaban CS asli lewat singkatan & produk', ({ assert }) => {
    const examples = [
      example(1, 'Halo', 'Halo bos, ada yang bisa kami bantu', 'seed'),
      example(2, 'harga jas hitam berapa kak', 'jas hitam 485rb bos\nmau model yang mana?'),
      example(3, 'ongkir ke bandung brp', 'ongkir ke bandung 25rb bos'),
    ]
    const picked = pickExamples(examples, 'brp bos jas nya', '')
    assert.equal(picked[0].id, 2)
    assert.notInclude(picked.map((item) => item.id), 3)
    // "hitamnya" = hitam; "berapa" bukan berarti harga (contoh "berapa hari" / komplain jas tidak ikut).
    const more = [
      ...examples,
      example(4, 'Berapa hari kira kira?', 'biasanya 3-7 hari kerja bos', 'seed'),
      example(5, 'Jasnya sampe tapi kancingnya lepas', 'Maaf bos, boleh difotokan ya', 'seed'),
    ]
    const ids = pickExamples(more, 'brp bos jas hitamnya', '').map((item) => item.id)
    assert.equal(ids[0], 2)
    assert.notInclude(ids, 4)
    assert.notInclude(ids, 5)
  })

  test('situasi sebelumnya ikut menentukan; jawaban sama persis cukup sekali; chat asli didahulukan', ({ assert }) => {
    const examples = [
      example(1, 'warna navy ada apa aja', 'navy ada tuxedo dan basic suit bos', 'seed'),
      example(2, 'yang navy ready kak warnanya', 'navy ready semua size bos', 'riwayat', 'sebelumnya — Toko: ini foto tuxedo navy'),
      example(3, 'yang abu ready warnanya', 'abu ready bos', 'riwayat', 'sebelumnya — Toko: ini foto basic suit'),
      example(4, 'warna navy ready ga', 'navy ready semua size bos'),
    ]
    const picked = pickExamples(examples, 'warna navy ready kak?', '', 8, 'Toko: ini foto tuxedo navy bos')
    assert.equal(picked[0].id, 2)
    // Jawaban sama persis (id 4) tidak diulang.
    assert.notInclude(picked.map((item) => item.id), 4)
    // Contoh bawaan yang mirip (seed) tetap ikut, di belakang contoh chat asli.
    assert.equal(picked[picked.length - 1].source, 'seed')
  })

  test('balasan CS tampil utuh per bubble, tidak dipotong 220 huruf', ({ assert }) => {
    const long = 'Untuk bahan premium kami pakai wool blend dari Italia bos, jatuhnya lebih adem dan tidak gampang kusut, cocok untuk acara outdoor seharian dan tetap rapi sampai malam'
    const text = renderExamples([example(1, 'bahannya apa kak', `${long}\nmau lihat fotonya bos?`, 'riwayat', 'sebelumnya — Toko: ini foto premium')])
    assert.include(text, 'CONTOH JAWABAN CS ASLI')
    assert.include(text, `   CS: ${long}`)
    assert.include(text, '   CS: mau lihat fotonya bos?')
    assert.include(text, '[sebelumnya — Toko: ini foto premium]')
  })
})

test.group('Belajar dari CS · pasangan yang layak', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 13, 3, 0, seconds))
  const row = (id: number, direction: string, sender: string | null, body: string, seconds: number) => ({
    id,
    jid: '6281@s.whatsapp.net',
    message_id: `m${id}`,
    reply_to_message_id: null,
    direction,
    sender_type: sender,
    body,
    media_type: null,
    media_url: null,
    created_at: at(seconds),
  })

  test('balasan CS dari HP (owner) dipelajari dengan percakapan sebelumnya', ({ assert }) => {
    const rows = [
      row(1, 'out', 'owner', 'ini foto tuxedo navy bos', 0),
      row(2, 'in', null, 'yang ini ready size L kak?', 60),
      row(3, 'out', 'owner', 'ready bos size L', 120),
      row(4, 'out', 'owner', 'mau sekalian celananya?', 125),
    ]
    const [segment] = realSegments(rows)
    const learned = exampleFromSegment(rows, segment)
    assert.isNotNull(learned)
    assert.equal(learned!.csText, 'ready bos size L\nmau sekalian celananya?')
    assert.include(learned!.situation, 'Toko: ini foto tuxedo navy bos')
    assert.include(learned!.tags, 'riwayat')
  })

  test('auto-reply (< 5 dtk), template, dan salinan pesan AI tidak dipelajari', ({ assert }) => {
    const auto = [row(1, 'in', null, 'kak mau tanya harga jas', 0), row(2, 'out', 'owner', 'Terima kasih telah menghubungi kami, pesan anda akan segera dibalas', 1)]
    assert.isNull(exampleFromSegment(auto, realSegments(auto)[0]))
    const template = [row(1, 'in', null, 'kak mau tanya harga jas', 0), row(2, 'out', 'owner', 'Terima kasih telah menghubungi Chameleon Cloth ya bos', 90)]
    assert.isNull(exampleFromSegment(template, realSegments(template)[0]))
    const away = [row(1, 'in', null, 'kak mau tanya harga jas', 0), row(2, 'out', 'owner', 'Halo, terima kasih sudah menghubungi kami. Pesan anda akan kami balas segera', 90)]
    assert.isNull(exampleFromSegment(away, realSegments(away)[0]))
    const copy = [
      row(1, 'in', null, 'jas hitam ready kak?', 0),
      row(2, 'out', 'ai', 'ready bos jas hitamnya', 20),
      row(3, 'in', null, 'kalau navy ready kak?', 60),
      row(4, 'out', 'owner', 'ready bos jas hitamnya', 120),
    ]
    const segments = realSegments(copy)
    assert.isTrue(segments.every((segment) => exampleFromSegment(copy, segment) === null))
  })
})

test.group('Belajar dari CS · otomatis dari chat baru (database)', () => {
  test('balasan CS baru dipelajari sekali; quick reply di ≥ 3 chat tidak; chat uji (holdout) tidak', async ({ assert }) => {
    await ensureLeanTables()
    const jids: string[] = []
    let hold = ''
    for (let index = 0; (jids.length < 4 || !hold) && index < 300; index++) {
      const jid = `62877${String(index).padStart(6, '0')}@s.whatsapp.net`
      if (isHoldout(jid)) hold ||= jid
      else if (jids.length < 4) jids.push(jid)
    }
    const now = Date.now()
    const message = (jid: string, n: number, direction: string, sender: string, body: string) => ({
      jid,
      message_id: `t370-${jid}-${n}`,
      direction,
      sender_type: sender,
      body,
      status: 'sent',
      created_at: new Date(now - (10 - n) * 60_000),
    })
    const quick = 'Siap bos, untuk pemesanan bisa isi format order ya uji370'
    const rows = [
      message(jids[0], 1, 'in', 'customer', 'bahannya adem ga kak buat outdoor uji370'),
      message(jids[0], 2, 'out', 'owner', 'adem bos, bahannya wool blend jadi gak gerah'),
      ...[1, 2, 3].flatMap((k) => [
        message(jids[k], 1, 'in', 'customer', `mau order kak gimana caranya ${k} uji370`),
        message(jids[k], 2, 'out', 'owner', quick),
      ]),
      message(hold, 1, 'in', 'customer', 'toko buka jam berapa kak uji370'),
      message(hold, 2, 'out', 'cs', 'buka jam 9 pagi bos sampai sore'),
    ]
    try {
      await db.table('whatsapp_messages').multiInsert(rows)
      clearExampleCache()
      const first = await learnNewCsReplies(30)
      assert.isAtLeast(first.added, 1)
      clearExampleCache()
      const learned = await db.from('whatsapp_beta3_examples').where('customer_text', 'like', '%uji370%').where('active', 1).select('customer_text', 'cs_text', 'source')
      assert.deepEqual(learned.map((item: any) => item.customer_text), ['bahannya adem ga kak buat outdoor uji370'])
      assert.equal(learned[0].source, 'riwayat')
      // Jalan lagi tanpa pesan baru → tidak ada yang dipelajari ulang.
      const again = await learnNewCsReplies(30)
      assert.equal(again.added, 0)
    } finally {
      await db.from('whatsapp_messages').whereIn('jid', [...jids, hold]).delete()
      await db.from('whatsapp_beta3_examples').where('customer_text', 'like', '%uji370%').delete()
      clearExampleCache()
    }
  })
})
