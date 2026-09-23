import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'
import {
  presentConnection,
  readConnectionStatus,
  startWorkerHeartbeat,
  touchWorkerHeartbeat,
  stopWorkerHeartbeat,
} from '#services/connection_status_service'

const session = {
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Pemilik',
    username: 'owner',
  },
}

test.group('Worker connection status', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  test('missing or expired heartbeat never reports an old connected/connecting state or QR', ({
    assert,
  }) => {
    const now = new Date('2026-09-13T09:00:00Z')
    for (const heartbeat of [null, new Date(now.getTime() - 21_000), 'invalid']) {
      for (const status of ['connecting', 'connected', 'qr']) {
        const result = presentConnection(
          { status, qr_data_url: 'old-qr', worker_heartbeat_at: heartbeat },
          now
        )
        assert.equal(result.status, 'worker_offline')
        assert.equal(result.status_label, 'Belum terhubung')
        assert.isNull(result.last_error)
        assert.isFalse(result.worker_online)
        assert.isNull(result.qr_data_url)
      }
    }
    const live = presentConnection({ status: 'connected', worker_heartbeat_at: now }, now)
    assert.equal(live.status_label, 'Terhubung')
    assert.isTrue(live.worker_online)
  })

  test('worker owns its heartbeat and an old worker shutdown cannot clear the new heartbeat', async ({
    assert,
  }) => {
    await startWorkerHeartbeat('worker-test-one')
    await startWorkerHeartbeat('worker-test-two')
    await stopWorkerHeartbeat('worker-test-one')
    await touchWorkerHeartbeat('worker-test-two')
    let state = await readConnectionStatus()
    assert.isTrue(state.worker_online)
    await stopWorkerHeartbeat('worker-test-two')
    state = await readConnectionStatus()
    assert.isFalse(state.worker_online)
  })

  test('UI/status reports worker offline and connect refuses to write misleading connecting state', async ({
    client,
    assert,
  }) => {
    await db.from('whatsapp_connection').where('id', 1).update({
      status: 'connecting',
      worker_id: null,
      worker_heartbeat_at: null,
      desired_connected: false,
    })
    const page = await client.get('/').withSession(session)
    page.assertStatus(200)
    page.assertTextIncludes('Belum terhubung')
    assert.notInclude(page.text(), 'Worker belum aktif')
    const status = await client.get('/api/status').withSession(session)
    status.assertHeader('cache-control', 'no-store')
    assert.equal(status.body().status, 'worker_offline')
    assert.isNull(status.body().last_error)
    const connect = await client.post('/api/connect').withSession(session).withCsrfToken().json({})
    connect.assertStatus(503)
    const row = await db.from('whatsapp_connection').where('id', 1).firstOrFail()
    assert.equal(Number(row.desired_connected), 0)
  })
})
