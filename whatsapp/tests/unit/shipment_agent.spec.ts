import { test } from '@japa/runner'
import { parseShipmentAction, SHIPMENT_AGENT_INSTRUCTIONS } from '#services/shipment_agent_contract'

test.group('Conversation shipping tool boundary', () => {
  test('accepts only scoped tool choices and bounded audit summaries', ({ assert }) => {
    assert.equal(
      parseShipmentAction({
        tool: 'wait',
        reason: 'Awaiting approval',
        waitingFor: 'approval',
        nextAction: 'recheck',
      }).tool,
      'wait'
    )
    for (const value of [
      null,
      { tool: 'delete_orion_data' },
      { tool: 'wait', reason: 'a'.repeat(1201), waitingFor: '', nextAction: '' },
    ])
      assert.throws(() => parseShipmentAction(value))
  })
  test('defines silent work and rejects blind create after an uncertain result', ({ assert }) => {
    assert.include(SHIPMENT_AGENT_INSTRUCTIONS, 'uncertain=true')
    assert.include(SHIPMENT_AGENT_INSTRUCTIONS, 'Tidak ada pesan pelanggan yang dikirim')
    assert.include(SHIPMENT_AGENT_INSTRUCTIONS, 'Ready to ship tanpa AWB')
  })
})
