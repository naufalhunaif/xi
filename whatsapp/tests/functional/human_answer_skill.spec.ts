import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { readSettings } from '#services/settings_service'
import { createReply } from '#services/ai_service'

test('live skill understands a CS answer and waits for the customer instead of re-escalating', async ({
  assert,
}) => {
  const settings = await readSettings(true)
  const content = await readFile('skills/cs-handoff-state/SKILL.md', 'utf8')
  const decision = await createReply(
    {
      ...settings,
      mcpConnections: [],
      skills: [...settings.skills, { name: 'cs-handoff-state', content }],
    },
    'MODE MEMAHAMI JAWABAN CS. CS sudah menjawab, pahami saja. Ini pemicu internal, bukan pesan pelanggan baru.',
    undefined,
    undefined,
    'Uji fiktif terisolasi, tidak ada tools atau pesan yang boleh dikirim. PELANGGAN: Ukurannya apa ya? CS AI: [handoff internal untuk konfirmasi ukuran]. CS MANUSIA: Ukurannya M ya bos. Untuk alamat lengkapnya ke mana? Pesan terakhir adalah jawaban CS manusia, belum ada jawaban pelanggan. STATE GOAL lama: paused, menunggu konfirmasi ukuran dari CS. STATE CART: kosong. Perbarui goal dari fakta terbaru; jangan mengulangi handoff lama.'
  )
  assert.equal(decision.decision, 'silent')
  assert.equal(decision.message, '')
  assert.equal(decision.goal?.status, 'waiting_answer')
  assert.match(decision.goal?.waiting_for || '', /alamat/i)
  assert.isNull(decision.goal?.follow_up)
})
  .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
  .timeout(180_000)
