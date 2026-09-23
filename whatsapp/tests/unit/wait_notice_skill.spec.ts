import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { parseWaitNoticePolicy, oneMinuteWaitNoticeContent } from '#services/wait_notice_skill'

test.group('Waiting notice skill policy', () => {
  const resource = () => readFile(app.makePath('resources/skills/waiting-notices/SKILL.md'), 'utf8')
  const block = (value: unknown) => '```wait-notice-policy\n' + JSON.stringify(value) + '\n```'

  test('bundled skill defines a one-minute combined approval notice', async ({ assert }) => {
    const content = await resource()
    const policy = parseWaitNoticePolicy(content)
    assert.include(content, 'name: waiting-notices')
    assert.include(content, 'description:')
    assert.equal(policy.delay_seconds, 60)
    assert.isTrue(policy.payment.enabled)
    assert.isTrue(policy.approval.enabled)
    assert.include(policy.approval.model_size, 'model dan ukurannya')
  })

  test('upgrades only the old delay and preserves custom wording and disabled notices', async ({ assert }) => {
    const content = (await resource()).replace('"delay_seconds": 60', '"delay_seconds": 180')
      .replace('"enabled": true', '"enabled": false')
      .replace('Sebentar ya, pembayaran kami cek dulu.', 'Kami periksa sebentar ya.')
    const updated = oneMinuteWaitNoticeContent(content)
    assert.equal(updated, content.replace('"delay_seconds": 180', '"delay_seconds": 60'))
    assert.equal(parseWaitNoticePolicy(updated).delay_seconds, 60)
    assert.equal(oneMinuteWaitNoticeContent(updated), updated)
    const custom = content.replace('"delay_seconds": 180', '"delay_seconds": 240')
    assert.equal(oneMinuteWaitNoticeContent(custom), custom)
    assert.equal(oneMinuteWaitNoticeContent('invalid'), 'invalid')
  })

  test('text, delay and per-case switches can be edited independently', async ({ assert }) => {
    const policy = parseWaitNoticePolicy(await resource())
    policy.delay_seconds = 240
    policy.payment.enabled = false
    policy.approval.model = 'Sebentar, kami cek modelnya dulu ya.'
    assert.deepEqual(parseWaitNoticePolicy(block(policy)), policy)
  })

  test('invalid or ambiguous policy fails closed', async ({ assert }) => {
    const content = await resource()
    for (const invalid of [
      '',
      content + content,
      block(null),
      block({}),
      '```wait-notice-policy\n{\n```',
    ])
      assert.throws(() => parseWaitNoticePolicy(invalid))
    for (const seconds of [0, 59, 3601, 180.5]) {
      const policy = parseWaitNoticePolicy(content)
      policy.delay_seconds = seconds
      assert.throws(() => parseWaitNoticePolicy(block(policy)))
    }
    for (const text of ['', ' ', 'x'.repeat(321)]) {
      const policy = parseWaitNoticePolicy(content)
      policy.payment.text = text
      assert.throws(() => parseWaitNoticePolicy(block(policy)))
    }
  })
})
