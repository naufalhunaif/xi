import { LEARNING_CASES } from '#services/learning_contract'
export function replayFixture(improved = true) {
  return { cases: LEARNING_CASES.map(fixture => ({
    id: fixture.id, decision: fixture.expect[0], nextStep: fixture.expect[1], goalStatus: fixture.expect[2],
    requestedFields: [...fixture.ask], changesBusinessRules: false, confirmsFunds: false,
    message: fixture.expect[0] !== 'reply' ? '' : fixture.id === 'shipping-options' ? 'REG Rp8.000\nYES Rp9.000\nMau layanan yang mana?' : 'Ini fotonya, bos.',
    initiative: fixture.id === 'photo-next' ? (improved ? 'Biasanya pakai ukuran berapa, bos?' : '') : '',
  })) }
}
