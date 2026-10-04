import { createHash } from 'node:crypto'
import type { GoalPlan } from '#services/goal_contract'

/** Numeric indices select context, never authorize a transaction or replace meaning. */
export const INTENT_INDEX = {
  0: 'unknown',
  1: 'ack',
  2: 'catalog',
  3: 'sizing',
  4: 'custom',
  5: 'cart',
  6: 'payment',
  7: 'shipping',
  8: 'service',
  9: 'visual',
} as const
export type IntentIndex = keyof typeof INTENT_INDEX
export type ProcessingLevel = 0 | 1 | 2 | 3 | 4

export const normalizeIntentText = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
export const levelDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const levelPolicyHash = (skills: Array<{ name: string; content: string }>) =>
  levelDigest(skills)

export type LevelCheckpoint = {
  v: 1
  sourceId: string
  sourceDigest: string
  anchorId: number
  cartVersion: string
  policyHash: string
  savedAt: number
  goal: GoalPlan
}
export type ActiveConversationState = {
  currentMessageCount: number
  currentText: string
  hasMedia: boolean
  hasQuote: boolean
  cartVersion: string
  cartItems: number
  orderCount: number
  pendingMemory: boolean
  lastMessageId: string
  lastMessageDigest: string
  lastSender: string
  previousExternalId: number
  lastQuestion: string
  waitingFor: string
  checkpoint: LevelCheckpoint | null
}
