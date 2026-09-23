import { test } from '@japa/runner'
import {
  updateDestinationGuide,
  OLD_DESTINATION_GUIDE,
  DESTINATION_GUIDE,
  DESTINATION_GUIDE_V1,
  DESTINATION_GUIDE_V2,
  DESTINATION_GUIDE_V3,
  DESTINATION_GUIDE_V4,
} from '../../commands/update_shipping_skills.js'

test.group('Optional postcode skill correction', () => {
  for (const newline of ['\n', '\r\n']) {
    test(`updates only the reviewed block and remains idempotent (${JSON.stringify(newline)})`, ({
      assert,
    }) => {
      const before = 'Aturan asal kirim, harga, dan stok tidak berubah.' + newline
      const after = newline + 'Form order: Kode Pos. Tarif wajib dari MCP.'
      const content = before + OLD_DESTINATION_GUIDE.replaceAll('\n', newline) + after
      const corrected = updateDestinationGuide(content)
      assert.equal(corrected, before + DESTINATION_GUIDE.replaceAll('\n', newline) + after)
      assert.equal(updateDestinationGuide(corrected), corrected)
    })
  }
  test('upgrades the deployed optional-postcode guide without duplicating it', ({ assert }) => {
    for (const guide of [
      DESTINATION_GUIDE_V1,
      DESTINATION_GUIDE_V2,
      DESTINATION_GUIDE_V3,
      DESTINATION_GUIDE_V4,
    ]) {
      const result = updateDestinationGuide('before\n' + guide + '\nafter')
      assert.equal(result, 'before\n' + DESTINATION_GUIDE + '\nafter')
      assert.equal(updateDestinationGuide(result), result)
    }
  })
  test('refuses unknown versions and duplicate blocks instead of overwriting guidance', ({
    assert,
  }) => {
    assert.throws(() => updateDestinationGuide('Panduan versi baru pengguna'), /dibatalkan/)
    assert.throws(() => updateDestinationGuide(OLD_DESTINATION_GUIDE.repeat(2)), /dibatalkan/)
  })
})
