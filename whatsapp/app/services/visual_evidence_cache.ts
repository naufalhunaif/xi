import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { evidenceKey, evidenceStore, type EvidenceStore } from '#services/evidence_cache'
import { workspaceScope } from '#services/workspace_context'
import {
  verifyVisualDecision,
  VISUAL_MATCH_INSTRUCTIONS,
  type VisualMatch,
  type VisualCandidate,
} from '#services/visual_match_contract'

/** Cache observations only, never customer replies, cart actions, payment or human approvals. */
export async function visualEvidenceCache(
  files: string[],
  context: unknown,
  candidates: VisualCandidate[],
  store: EvidenceStore = evidenceStore,
  now = Date.now
) {
  const pixels = await Promise.all(
    files.map(async (path) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    )
  )
  const key = evidenceKey([
    'visual-v1',
    workspaceScope().id,
    pixels,
    context,
    candidates,
    VISUAL_MATCH_INSTRUCTIONS,
  ])
  const valid = (value: any): value is VisualMatch => {
    if (!['matched', 'no_match'].includes(value?.status)) return false
    try {
      verifyVisualDecision(
        { decision: 'silent', message: '', reason: '', note: '', visualMatch: value },
        candidates
      )
      return true
    } catch {
      return false
    }
  }
  let cached: { match: VisualMatch; storedAt: number; expiresAt: number } | null = null
  try {
    const entry = await store.get(key)
    if (entry && entry.storedAt <= now() && entry.expiresAt > now() && valid(entry.value))
      cached = { match: entry.value, storedAt: entry.storedAt, expiresAt: entry.expiresAt }
  } catch {} // Cache unavailable is not a visual-analysis failure.
  return {
    cached,
    async save(match: VisualMatch | undefined) {
      if (!valid(match)) return
      try {
        await store.put(key, { value: match, storedAt: now(), expiresAt: now() + 24 * 60 * 60_000 })
      } catch {}
    },
  }
}
