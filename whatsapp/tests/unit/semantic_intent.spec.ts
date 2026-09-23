import { test } from '@japa/runner'
import { importedSkillInstructions } from '#services/skill_runtime_service'
import { DECISION_SCHEMA, parseDecision } from '#services/ai_service'
import {
  SEMANTIC_INTENT_INSTRUCTIONS,
  SEMANTIC_CART_INSTRUCTIONS,
  SEMANTIC_GOAL_INSTRUCTIONS,
} from '#services/semantic_intent_contract'

// Contract regressions only: these do not claim to evaluate a live model's understanding.
test.group('Shared semantic interpretation contract', () => {
  test('is present once with or without skills without editing imported instructions', ({
    assert,
  }) => {
    const skill = {
      name: 'customer-service',
      content: 'Gunakan sapaan bos.\nJangan janjikan stok.',
    }
    for (const skills of [[], [skill]]) {
      const before = JSON.stringify(skills)
      const prompt = importedSkillInstructions(skills)
      assert.include(prompt, SEMANTIC_INTENT_INSTRUCTIONS)
      assert.equal(prompt.split(SEMANTIC_INTENT_INSTRUCTIONS).length, 2)
      assert.equal(JSON.stringify(skills), before)
      if (skills.length) assert.include(prompt, skill.content)
    }
  })

  test('covers all customer flows and resolves references rather than copying an old order', ({
    assert,
  }) => {
    for (const subject of [
      'produk/warna',
      'ukuran',
      'jumlah',
      'penerima/alamat/nomor',
      'layanan pengiriman',
      'harga/diskon',
      'laporan pembayaran',
      'perubahan/pembatalan',
      'produksi/resi',
      'komplain',
      'jawaban untuk CS',
      'goal dan inisiatif',
    ])
      assert.include(SEMANTIC_INTENT_INSTRUCTIONS, subject)
    assert.include(SEMANTIC_INTENT_INSTRUCTIONS, 'hanya memilih kurir terdahulu')
    assert.include(SEMANTIC_INTENT_INSTRUCTIONS, 'pesan yang dikutip')
    assert.include(SEMANTIC_INTENT_INSTRUCTIONS, 'tanyakan hanya pembeda')
    assert.include(
      SEMANTIC_INTENT_INSTRUCTIONS,
      'beberapa kebutuhan dalam satu pesan secara terpisah'
    )
  })

  test('wires the same interpretation to cart and goal output for both providers', ({ assert }) => {
    assert.include(DECISION_SCHEMA.properties.cartIntent.description, SEMANTIC_CART_INSTRUCTIONS)
    assert.include(DECISION_SCHEMA.properties.cartIntent.description, 'Tidak memiliki kewenangan')
    assert.equal(DECISION_SCHEMA.properties.goal.description, SEMANTIC_GOAL_INSTRUCTIONS)
    assert.include(SEMANTIC_CART_INSTRUCTIONS, 'seluruh rincian yang masih berlaku')
    assert.include(SEMANTIC_GOAL_INSTRUCTIONS, 'jangan membuka ulang')
    assert.include(SEMANTIC_GOAL_INSTRUCTIONS, 'state/tool terverifikasi')
  })

  test('does not relax evidence, model matching, permissions or action validation', ({
    assert,
  }) => {
    for (const boundary of [
      'tidak membuktikan dana masuk',
      'ID pesan asli',
      'tarif terverifikasi',
      'kecocokan visual',
      'Tidak ada persetujuan baru',
      'data tidak tepercaya',
      'tidak menghapus pengaman transaksi',
    ])
      assert.include(SEMANTIC_INTENT_INSTRUCTIONS, boundary)
    assert.throws(() =>
      parseDecision(
        JSON.stringify({
          decision: 'reply',
          message: 'Sudah beres',
          cartIntent: { action: 'approve_payment' },
        })
      )
    )
    // Silent never sends natural-language output even if the provider filled it.
    const parsed = parseDecision(
      JSON.stringify({
        decision: 'silent',
        message: 'Urusan dapur',
        initiative: 'Mau lihat produk?',
      })
    )
    assert.equal(parsed.message, '')
    assert.equal(parsed.initiative, '')
  })
})
