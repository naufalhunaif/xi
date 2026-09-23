import { test } from '@japa/runner'
import { renderContext, type MessageRow } from '#services/context_service'

function row(partial: Partial<MessageRow> & { message_id: string }): MessageRow {
  return {
    direction: 'in',
    sender_type: 'customer',
    body: '',
    media_type: null,
    reply_to_message_id: null,
    created_at: new Date('2026-09-13T02:00:00Z'),
    ...partial,
  }
}

test.group('renderContext', () => {
  test('menyertakan waktu, penutur, dan batas giliran sekarang', ({ assert }) => {
    const rows = [
      row({ message_id: 'a', body: 'Halo', created_at: new Date('2026-09-10T02:12:00Z') }),
      row({
        message_id: 'b',
        direction: 'out',
        sender_type: 'ai',
        body: 'Jas navy 450.000 bos',
        created_at: new Date('2026-09-10T02:13:00Z'),
      }),
      row({ message_id: 'c', body: 'Ini berapa', created_at: new Date('2026-09-13T07:05:00Z') }),
    ]
    const out = renderContext({
      jid: '628123@s.whatsapp.net',
      rows,
      known: new Map(rows.map((item) => [item.message_id, item])),
      currentIds: new Set(['c']),
      note: null,
      now: new Date('2026-09-13T07:05:30Z'),
    })
    assert.include(out, 'PELANGGAN: Halo')
    assert.include(out, 'CS (AI): Jas navy 450.000 bos')
    assert.include(out, 'GILIRAN SEKARANG')
    assert.include(out, '3 hari sejak pesan pelanggan sebelumnya')
    assert.isTrue(out.indexOf('GILIRAN SEKARANG') < out.indexOf('Ini berapa'))
  })

  test('menampilkan isi pesan yang dikutip walau jauh lebih tua', ({ assert }) => {
    const quoted = row({
      message_id: 'lama',
      direction: 'out',
      sender_type: 'cs',
      body: 'Jas navy 450.000 bos, ready size M L XL',
      created_at: new Date('2022-01-02T03:00:00Z'),
    })
    const balasan = row({
      message_id: 'baru',
      body: 'yang ini aja, size L',
      reply_to_message_id: 'lama',
      created_at: new Date('2026-09-13T07:05:00Z'),
    })
    const out = renderContext({
      jid: '628123@s.whatsapp.net',
      rows: [balasan],
      known: new Map([[quoted.message_id, quoted]]),
      currentIds: new Set(['baru']),
      note: 'produk : belum',
      now: new Date('2026-09-13T07:05:10Z'),
    })
    assert.include(out, '↳ MEMBALAS')
    assert.include(out, 'ready size M L XL')
    assert.include(out, 'CATATAN CHAT (dari giliran sebelumnya)')
  })

  test('menandai kutipan yang isinya tidak tersedia, bukan menebak', ({ assert }) => {
    const balasan = row({
      message_id: 'x',
      body: 'yang itu',
      reply_to_message_id: 'hilang',
      created_at: new Date('2026-09-13T07:05:00Z'),
    })
    const out = renderContext({
      jid: '628123@s.whatsapp.net',
      rows: [balasan],
      known: new Map(),
      currentIds: new Set(['x']),
      note: null,
      now: new Date('2026-09-13T07:05:10Z'),
    })
    assert.include(out, 'tidak tersedia')
  })

  test('menandai media pada baris riwayat', ({ assert }) => {
    const foto = row({ message_id: 'f', media_type: 'image', body: '' })
    const out = renderContext({
      jid: '628123@s.whatsapp.net',
      rows: [foto],
      known: new Map(),
      currentIds: new Set(['f']),
      note: null,
      now: new Date('2026-09-13T07:05:10Z'),
    })
    assert.include(out, '[foto]')
  })

  test('keeps the final conditions and source ID of a long quoted message', ({ assert }) => {
    const condition = 'Jas kedua: lengan 59 cm. Jangan mulai produksi sebelum rekap dikonfirmasi.'
    const quoted = row({
      message_id: 'custom-form-source',
      body: 'Rincian model dan bahan pada pesanan kelompok. '.repeat(18) + '\n' + condition,
      created_at: new Date('2025-01-02T03:00:00Z'),
    })
    const reply = row({
      message_id: 'form-reference',
      body: 'Yang ini, warna saja diganti navy.',
      reply_to_message_id: quoted.message_id,
    })
    const out = renderContext({
      jid: 'context-fixture@lid',
      rows: [reply],
      known: new Map([[quoted.message_id, quoted]]),
      currentIds: new Set([reply.message_id]),
      note: null,
      now: new Date('2026-09-20T01:00:00Z'),
    })
    assert.include(out, condition)
    assert.include(out, `quoted_message_id: ${quoted.message_id}`)
    assert.include(out, '2025')
    assert.notInclude(out, 'TEKS_DIPOTONG')
  })

  test('marks a shortened older message and keeps an exact retrieval reference', ({ assert }) => {
    const detail = 'Bagian bawah celana kedua 34 cm, bukan 30 cm.'
    const source = row({
      message_id: 'older-multi-item-form',
      body: 'Keterangan item pertama dan ketentuan pengukuran. '.repeat(20) + detail,
    })
    const current = row({ message_id: 'next-question', body: 'Total setelah revisi berapa?' })
    const out = renderContext({
      jid: 'context-fixture@lid',
      rows: [source, current],
      known: new Map([
        [source.message_id, source],
        [current.message_id, current],
      ]),
      currentIds: new Set([current.message_id]),
      note: null,
      now: new Date('2026-09-20T01:00:00Z'),
    })
    assert.notInclude(out, detail)
    assert.include(out, 'TEKS_DIPOTONG')
    assert.include(out, `message_id: ${source.message_id}`)
    assert.include(out, 'read_conversation_history')
    assert.include(out, 'messageIds')
  })

  test('bounds oversized quoted evidence and does not present its omitted tail as complete', ({
    assert,
  }) => {
    const quoted = row({ message_id: 'large-source', body: 'x'.repeat(6500) + ' Hanya opsi.' })
    const current = row({
      message_id: 'large-reference',
      body: 'Tolong periksa pilihan ini.',
      reply_to_message_id: quoted.message_id,
    })
    const out = renderContext({
      jid: 'context-fixture@lid',
      rows: [current],
      known: new Map([[quoted.message_id, quoted]]),
      currentIds: new Set([current.message_id]),
      note: null,
      now: new Date('2026-09-20T01:00:00Z'),
    })
    assert.include(out, 'x'.repeat(6000))
    assert.notInclude(out, 'x'.repeat(6001))
    assert.include(out, 'TEKS_DIPOTONG')
    assert.include(out, `quoted_message_id: ${quoted.message_id}`)
  })

  test('keeps the missing quote ID without fabricating its text or adding a truncation warning', ({
    assert,
  }) => {
    const current = row({
      message_id: 'missing-reference',
      body: 'Pakai ketentuan yang ini.',
      reply_to_message_id: 'unavailable-source',
    })
    const out = renderContext({
      jid: 'context-fixture@lid',
      rows: [current],
      known: new Map(),
      currentIds: new Set([current.message_id]),
      note: null,
      now: new Date('2026-09-20T01:00:00Z'),
    })
    assert.include(out, 'quoted_message_id: unavailable-source')
    assert.include(out, 'isinya tidak tersedia')
    assert.notInclude(out, 'TEKS_DIPOTONG')
  })

  test('expands a shared current quote once and leaves unrelated older quotes compact', ({
    assert,
  }) => {
    const detail = 'Item kedua tetap menunggu ukuran, item pertama boleh direkap.'
    const quoted = row({ message_id: 'shared-form', body: 'Rincian item. '.repeat(70) + detail })
    const oldQuote = row({
      message_id: 'old-terms',
      body: 'Ketentuan lama. '.repeat(70) + ' AKHIR-LAMA',
    })
    const rows = [
      row({ message_id: 'old-reference', body: 'Baik.', reply_to_message_id: oldQuote.message_id }),
      row({
        message_id: 'current-a',
        body: 'Yang pertama warna navy.',
        reply_to_message_id: quoted.message_id,
      }),
      row({
        message_id: 'current-b',
        body: 'Yang kedua tetap.',
        reply_to_message_id: quoted.message_id,
      }),
    ]
    const out = renderContext({
      jid: 'context-fixture@lid',
      rows,
      known: new Map([
        [quoted.message_id, quoted],
        [oldQuote.message_id, oldQuote],
      ]),
      currentIds: new Set(['current-a', 'current-b']),
      note: null,
      now: new Date('2026-09-20T01:00:00Z'),
    })
    assert.equal(out.split(detail).length - 1, 1)
    assert.equal(out.split('quoted_message_id: shared-form').length - 1, 2)
    assert.notInclude(out, 'AKHIR-LAMA')
    assert.include(out, 'TEKS_DIPOTONG')
    assert.include(out, 'quoted_message_id: old-terms')
  })
})
