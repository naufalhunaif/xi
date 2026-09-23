import { test } from '@japa/runner'
import {
  phoneFromJid,
  resolveCustomerPhoneJid,
  customerIdentityContext,
  assertNotInternalPhone,
} from '#services/customer_identity_service'
import { renderContext } from '#services/context_service'

const customer = '628120000001@s.whatsapp.net'
const lid = '123456789012345@lid'
const shop = '628120000002'

test.group('Customer WhatsApp phone identity', () => {
  test('extracts phone JIDs, including device suffix, without guessing country codes', ({
    assert,
  }) => {
    assert.equal(phoneFromJid(customer), '628120000001')
    assert.equal(phoneFromJid('447700900001:12@s.whatsapp.net'), '447700900001')
    for (const value of [
      lid,
      '123456789012345',
      '123456789@g.us',
      'status@broadcast',
      '08120000001',
      '+628120000001',
      '0@s.whatsapp.net',
      '1234567890123456@s.whatsapp.net',
    ])
      assert.isNull(phoneFromJid(value))
  })

  test('direct phone JID does not require a mapping or use alternate sender identity', async ({
    assert,
  }) => {
    let calls = 0
    const result = await resolveCustomerPhoneJid(
      customer,
      async () => {
        calls++
        return null
      },
      `${shop}@s.whatsapp.net`
    )
    assert.equal(result, customer)
    assert.equal(calls, 0)
  })

  test('resolves LID using the WhatsApp mapping store', async ({ assert }) => {
    const result = await resolveCustomerPhoneJid(lid, async (value) => {
      assert.equal(value, lid)
      return customer
    })
    assert.equal(result, customer)
  })

  test('uses paired WhatsApp remoteJidAlt or contact phoneNumber when mapping is not yet available', async ({
    assert,
  }) => {
    assert.equal(await resolveCustomerPhoneJid(lid, async () => null, customer), customer)
    assert.equal(
      await resolveCustomerPhoneJid(
        lid,
        async () => {
          throw new Error('temporary')
        },
        customer
      ),
      customer
    )
  })

  test('unresolved, malformed and conflicting mappings never produce a guessed phone', async ({
    assert,
  }) => {
    assert.isNull(await resolveCustomerPhoneJid(lid, async () => null))
    assert.isNull(await resolveCustomerPhoneJid(lid, async () => lid))
    assert.isNull(
      await resolveCustomerPhoneJid(lid, async () => customer, `${shop}@s.whatsapp.net`)
    )
    assert.isNull(await resolveCustomerPhoneJid('123@g.us', async () => customer, customer))
    assert.isNull(await resolveCustomerPhoneJid('123456789012345', async () => customer, customer))
  })

  test('a later mapping retries successfully instead of caching an unknown phone forever', async ({
    assert,
  }) => {
    assert.isNull(await resolveCustomerPhoneJid(lid, async () => null))
    assert.equal(await resolveCustomerPhoneJid(lid, async () => customer), customer)
  })

  test('context distinguishes sender phone, shop phone and chosen recipient', ({ assert }) => {
    const context = customerIdentityContext(lid, customer, shop)
    assert.include(context, '"customerWhatsAppPhone":"628120000001"')
    assert.include(context, '"shopWhatsAppPhone":"628120000002"')
    assert.include(context, '"phoneStatus":"resolved"')
    assert.include(context, 'recipient.phone dalam cartIntent')
    assert.include(context, 'Jangan otomatis mengisi atau menimpa')
  })

  test('shop/self identity is not presented as customer phone', ({ assert }) => {
    for (const jid of [lid, `${shop}@s.whatsapp.net`]) {
      const context = customerIdentityContext(jid, `${shop}@s.whatsapp.net`, shop)
      assert.include(context, '"customerWhatsAppPhone":null')
      assert.include(context, '"phoneStatus":"unavailable"')
    }
  })

  test('unavailable identity requests clarification rather than inventing a phone', ({
    assert,
  }) => {
    const context = customerIdentityContext(lid)
    assert.include(context, '"customerWhatsAppPhone":null')
    assert.include(context, 'minta nomor hanya ketika diperlukan')
    assert.notInclude(context, '"customerWhatsAppPhone":"123456789012345"')
  })

  test('both provider prompts receive the full labelled room ID and resolved phone', ({
    assert,
  }) => {
    const prompt = renderContext({
      jid: lid,
      phoneJid: customer,
      shopPhone: shop,
      rows: [],
      known: new Map(),
      currentIds: new Set(),
      note: null,
      now: new Date('2026-09-14T01:00:00Z'),
    })
    assert.include(prompt, `CHAT ID  : ${lid} (ID internal room, bukan nomor penerima)`)
    assert.include(prompt, '"customerWhatsAppPhone":"628120000001"')
  })

  test('cart rejects numeric LID but accepts a separately selected recipient number', ({
    assert,
  }) => {
    assert.throws(() => assertNotInternalPhone(lid, '123456789012345'), /ID internal/)
    assert.throws(() => assertNotInternalPhone(lid, '+123 456 789 012 345'), /ID internal/)
    for (const phone of ['', '08120000003', '+44 7700 900001', '628120000001'])
      assert.doesNotThrow(() => assertNotInternalPhone(lid, phone))
  })
})
