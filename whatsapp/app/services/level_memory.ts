import type { SourcedMemoryFact } from '#services/conversation_memory'
import { intentIndices, normalizeIntentText, LEVEL_LIMITS } from '#services/conversation_levels'

/** Initial window only; deferred facts stay source-validated and retrievable by numeric index. */
export function selectLevelMemory(facts: SourcedMemoryFact[], text: string, hasCart: boolean) {
  const indices = intentIndices(text)
  const reference = /\b(kemarin|sebelumnya|tadi|dulu|sama|itu)\b/.test(normalizeIntentText(text))
  if (
    hasCart ||
    !indices.length ||
    reference ||
    facts.length <= LEVEL_LIMITS.active.initialMemoryFacts
  )
    return { selected: facts, deferred: [], directory: [] }
  const relevant = new Set(['constraint', 'pending'])
  if (indices.some((i) => [2, 4, 9].includes(i))) relevant.add('product').add('preference')
  if (indices.includes(3)) relevant.add('measurements').add('preference')
  if (indices.includes(7)) relevant.add('recipient')
  if (indices.some((i) => [5, 6, 8].includes(i)))
    return { selected: facts, deferred: [], directory: [] }
  // Mandatory constraints/pending needs are never clipped to meet the soft window.
  const mandatory = facts.filter((fact) => ['constraint', 'pending'].includes(fact.topic))
  const candidates = facts
    .filter((fact) => !mandatory.includes(fact))
    .map((fact, order) => ({ fact, order, priority: relevant.has(fact.topic) ? 1 : 0 }))
    .sort((a, b) => b.priority - a.priority || b.order - a.order)
  const keep = new Set([
    ...mandatory,
    ...candidates
      .slice(0, Math.max(0, LEVEL_LIMITS.active.initialMemoryFacts - mandatory.length))
      .map(({ fact }) => fact),
  ])
  return {
    selected: facts.filter((fact) => keep.has(fact)),
    deferred: facts.filter((fact) => !keep.has(fact)),
    directory: facts.flatMap((fact, i) => (keep.has(fact) ? [] : [[i + 1, fact.key, fact.topic]])),
  }
}
