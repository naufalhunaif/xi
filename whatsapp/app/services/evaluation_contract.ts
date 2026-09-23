import {
  PRODUCTION_SIGNAL_SCHEMA,
  parseProductionSignal,
  type ProductionSignal,
} from '#services/production_contract'
import { LEARNING_SIGNAL_SCHEMA, parseLearningSignals, type LearningSignal } from '#services/learning_contract'

export type ConversationEvaluation = {
  learningSignals?: LearningSignal[]
  productionSignal?: ProductionSignal | null
  summary: string
  stage: 'discovery' | 'selection' | 'checkout' | 'payment' | 'ordered' | 'support' | 'unknown'
  missedNeeds: string[]
  nextAction: string
  evidenceMessageIds: string[]
  limitations: string[]
}
const shortText = { type: 'string' }
const list = { type: 'array', items: shortText }
export const EVALUATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    learningSignals: LEARNING_SIGNAL_SCHEMA,
    productionSignal: PRODUCTION_SIGNAL_SCHEMA,
    summary: shortText,
    stage: {
      type: 'string',
      enum: ['discovery', 'selection', 'checkout', 'payment', 'ordered', 'support', 'unknown'],
    },
    missedNeeds: list,
    nextAction: shortText,
    evidenceMessageIds: list,
    limitations: list,
  },
  required: [
    'learningSignals',
    'summary',
    'stage',
    'missedNeeds',
    'nextAction',
    'evidenceMessageIds',
    'limitations',
    'productionSignal',
  ],
}
export function parseEvaluation(value: unknown): ConversationEvaluation {
  if (!value || typeof value !== 'object') throw new Error('Evaluasi tidak valid.')
  const data = value as ConversationEvaluation
  if (
    !EVALUATION_SCHEMA.properties.stage.enum.includes(data.stage) ||
    ![data.summary, data.nextAction].every(
      (item) => typeof item === 'string' && item.length <= 2000
    ) ||
    ![data.missedNeeds, data.evidenceMessageIds, data.limitations].every(
      (items) =>
        Array.isArray(items) &&
        items.length <= 12 &&
        items.every((item) => typeof item === 'string' && item.length <= 1000)
    )
  )
    throw new Error('Format evaluasi tidak valid.')
  return {
    ...(data.learningSignals !== undefined ? { learningSignals: parseLearningSignals(data.learningSignals) } : {}),
    productionSignal: parseProductionSignal(data.productionSignal),
    summary: data.summary,
    stage: data.stage,
    missedNeeds: data.missedNeeds,
    nextAction: data.nextAction,
    evidenceMessageIds: data.evidenceMessageIds,
    limitations: data.limitations,
  }
}
export function evaluationSkills(skills: Array<{ name: string; content?: string }>) {
  return skills.filter((skill) =>
    /(?:^|[-_\s])(eval|evaluation|evaluasi)(?:$|[-_\s])/i.test(skill.name)
  )
}
