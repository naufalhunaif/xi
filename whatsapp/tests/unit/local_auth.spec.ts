import { test } from '@japa/runner'
import { localSession, loginBlocked, validatePassword } from '#services/local_auth_service'

test.group('Local auth (standalone)', () => {
  test('local sessions match the OAuth session shape accepted by the middleware', ({ assert }) => {
    const session = localSession({ id: 7, email: 'owner@shop.test', name: 'Owner' })
    assert.isTrue(session.local)
    assert.match(session.sub, /^[a-f0-9]{64}$/)
    assert.match(session.sessionToken, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(session.issuer, '')
    assert.equal(session.username, 'owner@shop.test')
    assert.equal(session.name, 'Owner')
    assert.notEqual(
      localSession({ id: 8, email: 'owner@shop.test', name: '' }).sub,
      session.sub,
      'sub is bound to the user id'
    )
    assert.equal(localSession({ id: 9, email: 'x@y.z', name: '' }).name, 'x@y.z')
  })

  test('short passwords are rejected and unknown keys are not blocked', ({ assert }) => {
    assert.throws(() => validatePassword('1234567'))
    assert.doesNotThrow(() => validatePassword('12345678'))
    assert.isFalse(loginBlocked('nobody@shop.test|127.0.0.1'))
  })
})
