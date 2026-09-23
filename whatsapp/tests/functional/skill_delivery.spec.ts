import { test } from '@japa/runner'
import { fileURLToPath } from 'node:url'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { createReply } from '#services/ai_service'
import type { TraceEvent } from '#services/trace_service'

test.group('Imported skill delivery', () => {
  for (const provider of ['chatgpt', 'claude']) {
    test(`delivers all skills via stdin to ${provider} without built-in skill injection`, async ({
      assert,
    }) => {
      await initializeDatabase()
      await db.beginGlobalTransaction()
      try {
        const binary = fileURLToPath(new URL('../fixtures/skill_provider.mjs', import.meta.url))
        const events: TraceEvent[] = []
        const result = await createReply(
          {
            aiProvider: provider,
            codexBin: binary,
            claudeBin: binary,
            skills: [
              { name: 'gaya', content: 'Isi lengkap.\n'.repeat(26000) + 'ATURAN TERAKHIR' },
              {
                name: 'inisiatif',
                content: 'Cara memakai tool dan berinisiatif dari skill pengguna.',
              },
            ],
            mcpConnections: [],
            paymentMethods: [
              {
                id: 1,
                name: 'BANK-FIXTURE',
                destination: '000123456789',
                accountName: 'OWNER-FIXTURE',
                enabled: true,
              },
              {
                id: 2,
                name: 'DISABLED-FIXTURE',
                destination: 'DO-NOT-SEND-THIS-ACCOUNT',
                accountName: '',
                enabled: false,
              },
            ],
          },
          'PESAN UJI',
          undefined,
          undefined,
          undefined,
          [],
          (event) => events.push(event)
        )
        assert.equal(result.decision, 'silent')
        assert.equal(result.message, '')
        assert.equal(result.note, 'Catatan internal')
        assert.deepEqual(
          events.find((event) => event.key === 'skills' && event.status === 'completed')?.detail,
          {
            skills: ['gaya', 'inisiatif'],
            delivery: 'full-content',
          }
        )
      } finally {
        await db.rollbackGlobalTransaction()
      }
    })
  }
})
