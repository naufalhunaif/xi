import { readFile } from 'node:fs/promises'
import { evidenceKey, evidenceStore, type EvidenceStore } from '#services/evidence_cache'
import { workspaceScope } from '#services/workspace_context'
import {
  verifyVisualDecision,
  VISUAL_MATCH_INSTRUCTIONS,
  type VisualMatch,
  type VisualCandidate,
} from '#services/visual_match_contract'

export async function visualFingerprint(files: string[], metadata: unknown) {
  const hashes = []
  for (const path of files) hashes.push(evidenceKey((await readFile(path)).toString('base64')))
  return evidenceKey([hashes, metadata])
}
type Observation = { match: VisualMatch; candidates: VisualCandidate[]; fingerprint: string }
export async function visualFollowupCache(
  file: string,
  referenceId: string,
  context: unknown,
  store: EvidenceStore = evidenceStore,
  now = Date.now
) {
  const key = evidenceKey([
    'visual-followup-v1',
    workspaceScope().id,
    referenceId,
    await visualFingerprint([file], context),
    VISUAL_MATCH_INSTRUCTIONS,
  ])
  const valid = (value: any): value is Observation => {
    if (
      !value ||
      !['matched', 'no_match'].includes(value.match?.status) ||
      !Array.isArray(value.candidates) ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint)
    )
      return false
    try {
      verifyVisualDecision(
        { decision: 'silent', message: '', reason: '', note: '', visualMatch: value.match },
        value.candidates,
        referenceId
      )
      return true
    } catch {
      return false
    }
  }
  let cached: (Observation & { storedAt: number; expiresAt: number }) | null = null
  try {
    const entry = await store.get(key)
    if (entry && entry.storedAt <= now() && entry.expiresAt > now() && valid(entry.value))
      cached = { ...entry.value, storedAt: entry.storedAt, expiresAt: entry.expiresAt }
  } catch {}
  return {
    cached,
    async save(value: Observation) {
      if (!valid(value)) return
      // Explicit projection: never save the reply, cart, approvals, or arbitrary model fields.
      try {
        await store.put(key, {
          value: {
            match: value.match,
            candidates: value.candidates,
            fingerprint: value.fingerprint,
          },
          storedAt: now(),
          expiresAt: now() + 86400000,
        })
      } catch {}
    },
  }
}
