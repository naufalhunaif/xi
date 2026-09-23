export const AI_MODELS = {
  chatgpt: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  claude: ['opus', 'sonnet', 'haiku'],
}
export const AI_REASONING = {
  chatgpt: ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
}
type Provider = keyof typeof AI_MODELS
const legacyEfforts = ['low', 'medium', 'high']
export function runtimeOptions(row: Record<string, any>, provider: Provider) {
  const reasoning =
    row[`${provider}_reasoning`] ??
    (legacyEfforts.includes(row[`${provider}_speed`]) ? row[`${provider}_speed`] : 'auto')
  return {
    reasoning: AI_REASONING[provider].includes(reasoning) ? reasoning : 'auto',
    speed: row[`${provider}_speed`] === 'fast' ? 'fast' : 'standard',
  }
}
export function supportsFast(provider: Provider, model: string) {
  return provider === 'claude'
    ? ['opus', 'claude-opus-5', 'claude-opus-4-8'].includes(model)
    : /^(?:gpt-6-astra|gpt-5\.6-(?:sol|terra|luna)|gpt-5\.[456])$/.test(model)
}
export function saveRuntimeOptions(
  input: Record<string, any>,
  current: Record<string, any>,
  provider: Provider
) {
  const values: Record<string, unknown> = {}
  const label = provider === 'claude' ? 'Claude' : 'ChatGPT'
  let reasoning = input[`${provider}Reasoning`]
  const speed = input[`${provider}Speed`]
  // Older open tabs submitted effort under Speed. Preserve its meaning; never enable paid Fast.
  if (legacyEfforts.includes(speed)) reasoning ??= speed
  if (reasoning !== undefined) {
    if (!AI_REASONING[provider].includes(reasoning))
      throw new Error(`Reasoning ${label} tidak valid.`)
    values[`${provider}_reasoning`] = reasoning
  }
  if (speed !== undefined) {
    if (!['auto', 'standard', 'fast', ...legacyEfforts].includes(speed))
      throw new Error(`Kecepatan ${label} tidak valid.`)
    values[`${provider}_speed`] = speed === 'fast' ? 'fast' : 'standard'
  }
  const model = String(input[`${provider}Model`] ?? current[`${provider}Model`] ?? '').trim()
  const effectiveSpeed = values[`${provider}_speed`] ?? current[`${provider}Speed`]
  if (
    (speed !== undefined || input[`${provider}Model`] !== undefined) &&
    effectiveSpeed === 'fast' &&
    !supportsFast(provider, model)
  )
    throw new Error('Pilih model yang mendukung Fast, atau gunakan Standard terlebih dahulu.')
  return values
}

/** Separate execution controls: changing service speed must never lower reasoning. */
export function codexPerformanceArgs(reasoning = 'auto', speed = 'standard') {
  return [
    ...(reasoning !== 'auto' && AI_REASONING.chatgpt.includes(reasoning)
      ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`]
      : []),
    '-c',
    `features.fast_mode=${speed === 'fast'}`,
    ...(speed === 'fast' ? ['-c', 'service_tier="fast"'] : []),
  ]
}
export function claudePerformanceArgs(reasoning = 'auto', speed = 'standard') {
  return [
    ...(reasoning !== 'auto' && AI_REASONING.claude.includes(reasoning)
      ? ['--effort', reasoning]
      : []),
    '--settings',
    JSON.stringify({ fastMode: speed === 'fast' }),
  ]
}
