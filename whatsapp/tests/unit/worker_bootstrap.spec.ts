import { test } from '@japa/runner'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import app from '@adonisjs/core/services/app'

test('Ace can import the WhatsApp worker before Lucid boots', async ({ assert }) => {
  const result = await promisify(execFile)(process.execPath, ['ace', 'whatsapp:listen', '--help'], {
    cwd: app.makePath(),
    timeout: 8000,
  })
  assert.include(result.stdout, 'whatsapp:listen')
  assert.notInclude(result.stderr, 'Cannot create proxy')
}).timeout(10000)
