// Isolated audit suite: no HTTP server, database initialization, WhatsApp socket,
// real AI process or external MCP. Failing expectations are findings to fix later.
process.env.NODE_ENV = 'test'
import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, run } from '@japa/runner'
import { assert } from '@japa/assert'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'

const root = new URL('../', import.meta.url)
new Ignitor(root, {
  importer: (path) => (path.startsWith('.') ? import(new URL(path, root).href) : import(path)),
})
  .tap((app) =>
    app.booting(async () => {
      await import('#start/env')
    })
  )
  .testRunner()
  .configure(async (app) => {
    configure({
      suites: [
        { name: 'audit', files: ['tests/audit/chat_failure_matrix.spec.ts'], timeout: 5000 },
      ],
      plugins: [assert(), pluginAdonisJS(app)],
      teardown: [() => app.terminate()],
    })
  })
  .run(() => run())
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })
