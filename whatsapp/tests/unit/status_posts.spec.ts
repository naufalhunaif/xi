import { test } from '@japa/runner'
import { describeStatus, statusImageFile } from '#services/status_posts'

// Balasan pelanggan ke status WhatsApp toko (diunggah dari HP): AI harus tahu status mana yang dimaksud.
test.group('status WhatsApp toko', () => {
  test('caption status dipakai sebagai kutipan untuk AI', ({ assert }) => {
    assert.equal(
      describeStatus({ caption: 'Tuxedo navy   ready size M\nharga 650rb', media_type: 'image' }),
      'status WhatsApp toko (foto): "Tuxedo navy ready size M harga 650rb"'
    )
    assert.equal(describeStatus({ caption: '', media_type: 'image' }), 'status WhatsApp toko (foto, tanpa caption)')
    assert.equal(describeStatus({ caption: 'promo', media_type: 'video' }), 'status WhatsApp toko (video): "promo"')
    assert.equal(describeStatus({ caption: 'Buka sampai jam 9', media_type: null }), 'status WhatsApp toko: "Buka sampai jam 9"')
  })

  test('foto status: media penuh bila sudah terunduh, thumbnail bila belum; video selalu thumbnail', ({ assert }) => {
    assert.equal(statusImageFile({ media_type: 'image', media_url: '/media/status-A1.jpg', thumbnail_url: '/media/thumb-A1.jpg' }), 'status-A1.jpg')
    assert.equal(statusImageFile({ media_type: 'image', media_url: null, thumbnail_url: '/media/thumb-status-A1.jpg' }), 'thumb-status-A1.jpg')
    assert.equal(statusImageFile({ media_type: 'video', media_url: '/media/status-A1.mp4', thumbnail_url: '/media/thumb-A1.jpg' }), 'thumb-A1.jpg')
    assert.isNull(statusImageFile({ media_type: null, media_url: null, thumbnail_url: null }))
  })
})
