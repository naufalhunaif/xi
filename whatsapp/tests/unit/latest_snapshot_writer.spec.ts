import { test } from '@japa/runner'
import { latestSnapshotWriter } from '#services/latest_snapshot_writer'

test('slow trace writes coalesce updates and flush the complete terminal snapshot', async ({
  assert,
}) => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: Record<string, unknown>[] = []
  const writer = latestSnapshotWriter(
    async (value) => {
      writes.push(value)
      if (writes.length === 1) await blocked
    },
    () => assert.fail('Unexpected failure')
  )
  writer.enqueue({ steps_json: 'initial', label: 'starting' })
  await Promise.resolve()
  for (let index = 1; index <= 100; index++)
    writer.enqueue({ steps_json: `all steps through ${index}`, label: `step ${index}` })
  writer.enqueue({ status: 'completed', decision_json: 'verified', message_id: 'sent-message' })
  const flushing = writer.flush()
  assert.lengthOf(writes, 1)
  release()
  await flushing
  assert.lengthOf(writes, 2)
  assert.deepEqual(writes[1], {
    steps_json: 'all steps through 100',
    label: 'step 100',
    status: 'completed',
    decision_json: 'verified',
    message_id: 'sent-message',
  })
})

test('failed trace write does not queue retries of old snapshots or lose latest step fields', async ({
  assert,
}) => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let errors = 0
  const writes: Record<string, unknown>[] = []
  const writer = latestSnapshotWriter(
    async (value) => {
      writes.push(value)
      if (writes.length === 1) {
        await blocked
        throw new Error('DB timeout')
      }
    },
    () => {
      errors++
    }
  )
  writer.enqueue({ steps_json: 'complete step history' })
  await Promise.resolve()
  writer.enqueue({ status: 'failed' })
  release()
  await writer.flush()
  assert.equal(errors, 1)
  assert.lengthOf(writes, 2)
  assert.deepEqual(writes[1], { steps_json: 'complete step history', status: 'failed' })
  writer.enqueue({ status: 'cancelled' })
  await writer.flush()
  assert.equal(writes[2].status, 'cancelled')
})

test('updates arriving during a write flush in order without concurrent writes', async ({
  assert,
}) => {
  let active = 0
  let maximum = 0
  const values: unknown[] = []
  const writer = latestSnapshotWriter(
    async (value) => {
      maximum = Math.max(maximum, ++active)
      values.push(value.step)
      if (value.step === 1) writer.enqueue({ step: 2 })
      await Promise.resolve()
      active--
    },
    () => assert.fail('Unexpected failure')
  )
  writer.enqueue({ step: 1 })
  await writer.flush()
  assert.deepEqual(values, [1, 2])
  assert.equal(maximum, 1)
})
