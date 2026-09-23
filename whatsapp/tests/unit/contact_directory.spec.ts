import { test } from '@japa/runner'
import { directoryAddresses, csvCell, contactCsvRows } from '#services/contact_directory_service'

test.group('Contact directory boundaries', () => {
  test('deduplicates addresses but preserves different recipients and ignores invalid JSON', ({
    assert,
  }) => {
    const address = { name: 'Recipient', phone: '081234567890', address: 'Street A, City' }
    const rows = directoryAddresses([
      { source: 'cart', recipient: JSON.stringify(address) },
      { source: 'order', recipient: { ...address, address: 'Street A,  City' } },
      { source: 'order', recipient: { ...address, name: 'Other recipient' } },
      { source: 'conversation', recipient: { address: address.address } },
      { source: 'cart', recipient: '{invalid' },
    ])
    assert.lengthOf(rows, 2)
    assert.equal(rows[0].source, 'cart')
    assert.equal(rows[1].name, 'Other recipient')
  })
  test('CSV quotes commas, quotes and multiline addresses, and neutralizes spreadsheet formulas', ({
    assert,
  }) => {
    assert.equal(csvCell('Street, "A"\nCity'), '"Street, ""A""\nCity"')
    for (const value of ['=SUM(1,2)', '+123', '-1', '@A1', '  =1', '\t=1', '\r=1'])
      assert.isTrue(csvCell(value).startsWith('"\''))
    const csv = contactCsvRows([
      { jid: '123@lid', name: 'Customer', phone: '', photo: '', addresses: [] },
    ])
    assert.equal(csv, '"Customer","","","",""\r\n')
    assert.notInclude(csv, '123')
  })
})
