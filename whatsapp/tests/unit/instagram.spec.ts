import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { validSignature, authorizeUrl } from '#instagram/api'
import { igMessageId } from '#instagram/webhook'
import { cleanPublicReply, commentRoute, parseCommentDecision, waLink } from '#instagram/comments'
import { instagramJid, instagramUserId, isInstagramJid } from '#instagram/store'
import { isDirectContactJid } from '#services/message_service'

test.group('Instagram', () => {
  test('tanda tangan webhook diverifikasi dengan app secret', ({ assert }) => {
    const body = '{"object":"instagram","entry":[]}'
    const good = `sha256=${createHmac('sha256', 'rahasia').update(body).digest('hex')}`
    assert.isTrue(validSignature('rahasia', body, good))
    assert.isFalse(validSignature('lain', body, good))
    assert.isFalse(validSignature('rahasia', `${body} `, good))
    assert.isFalse(validSignature('rahasia', body, undefined))
    assert.isFalse(validSignature('', body, good))
  })

  test('room Instagram memakai akhiran @ig dan diterima sebagai kontak', ({ assert }) => {
    const jid = instagramJid('17841400000000001')
    assert.equal(jid, '17841400000000001@ig')
    assert.isTrue(isInstagramJid(jid))
    assert.equal(instagramUserId(jid), '17841400000000001')
    assert.isTrue(isDirectContactJid(jid))
    assert.isFalse(isInstagramJid('6281234@s.whatsapp.net'))
  })

  test('mid panjang diringkas agar muat di kolom message_id', ({ assert }) => {
    assert.equal(igMessageId('abc'), 'abc')
    const long = igMessageId('x'.repeat(300))
    assert.isAtMost(long.length, 190)
    assert.equal(long, igMessageId('x'.repeat(300)))
  })

  test('rute komentar mengikuti pengaturan', ({ assert }) => {
    const wa = waLink('+62 812-3456')
    assert.equal(wa, 'wa.me/628123456')
    assert.deepEqual(commentRoute('both', 'tanya', true, wa), { dm: true, waPublic: false, waInDm: true })
    assert.deepEqual(commentRoute('both', 'minat', false, wa), { dm: false, waPublic: true, waInDm: false })
    assert.deepEqual(commentRoute('dm', 'tanya', true, wa), { dm: true, waPublic: false, waInDm: false })
    assert.deepEqual(commentRoute('wa', 'tanya', true, wa), { dm: false, waPublic: true, waInDm: false })
    assert.deepEqual(commentRoute('both', 'pujian', true, wa), { dm: false, waPublic: false, waInDm: false })
    assert.deepEqual(commentRoute('wa', 'tanya', true, ''), { dm: false, waPublic: true, waInDm: false })
  })

  test('balasan komentar publik tanpa link dan nomor', ({ assert }) => {
    assert.equal(
      cleanPublicReply('Chat WhatsApp kami ya kak wa.me/6281234567890 atau https://bit.ly/x'),
      'Chat WhatsApp kami ya kak atau'
    )
    assert.equal(cleanPublicReply('Hubungi 0812-3456-7890 ya'), 'Hubungi ya')
    assert.equal(cleanPublicReply('Sudah kami DM ya kak 🙏'), 'Sudah kami DM ya kak 🙏')
  })

  test('jawaban AI komentar dibaca aman', ({ assert }) => {
    const parsed = parseCommentDecision(
      'ok {"jenis":"tanya","balasan_publik":"Sudah kami DM ya kak","pesan_dm":"Halo kak"}'
    )
    assert.equal(parsed?.jenis, 'tanya')
    assert.equal(parseCommentDecision('{"jenis":"aneh"}')?.jenis, 'lain')
    assert.isNull(parseCommentDecision('bukan json'))
  })

  test('URL login Instagram memuat izin DM & komentar', ({ assert }) => {
    const url = new URL(authorizeUrl('123', 'https://contoh.id/instagram/callback', 'abc'))
    assert.equal(url.hostname, 'www.instagram.com')
    assert.include(url.searchParams.get('scope') || '', 'instagram_business_manage_messages')
    assert.include(url.searchParams.get('scope') || '', 'instagram_business_manage_comments')
    assert.equal(url.searchParams.get('state'), 'abc')
  })
})
