/** Local size accounting only. The provider's own counts stay authoritative for billing. */
export type PromptSection = { key: string; chars: number; tokens: number }
export type PromptBreakdown = {
  sections: PromptSection[]
  chars: number
  tokens: number
  estimated: true
}

// Mixed Indonesian prose and JSON lands near 3.7 characters per BPE token. This is a
// budgeting aid for comparing sections, never a billing figure: the phase rows carry the
// provider's exact totals next to it so the ratio can be checked against reality.
const CHARS_PER_TOKEN = 3.7
export function estimateTokens(value: string | number) {
  const chars = typeof value === 'number' ? value : String(value || '').length
  return Math.round(Math.max(0, chars) / CHARS_PER_TOKEN)
}

export function promptBreakdown(sections: Array<[string, unknown]>): PromptBreakdown {
  const measured = sections
    .map(([key, value]) => {
      const chars = typeof value === 'number' ? value : String(value || '').length
      return { key, chars, tokens: estimateTokens(chars) }
    })
    .filter((section) => section.chars > 0)
    .sort((a, b) => b.chars - a.chars)
  return {
    sections: measured.slice(0, 40),
    chars: measured.reduce((sum, section) => sum + section.chars, 0),
    tokens: measured.reduce((sum, section) => sum + section.tokens, 0),
    estimated: true,
  }
}

/** Serialized size of what actually crosses the wire, not the in-memory object. */
export function payloadChars(value: unknown) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}
