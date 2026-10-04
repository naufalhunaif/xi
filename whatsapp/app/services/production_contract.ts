export const PRODUCTION_KINDS = ['preorder', 'custom'] as const
export type ProductionKind = (typeof PRODUCTION_KINDS)[number]
export type ProductionRule = {
  enabled: boolean
  minDays: number | null
  maxDays: number | null
  estimateDays: number | null
  dayType: 'calendar' | 'working'
  startsAfter: 'payment_details' | 'full_payment_details' | 'approval'
}
export type ProductionPolicy = {
  version: string
  autoAdjust: boolean
  rules: Record<ProductionKind, ProductionRule>
}
export function defaultProductionPolicy(): ProductionPolicy {
  const rule = (): ProductionRule => ({
    enabled: false,
    minDays: null,
    maxDays: null,
    estimateDays: null,
    dayType: 'calendar',
    startsAfter: 'payment_details',
  })
  return { version: 'unconfigured', autoAdjust: true, rules: { preorder: rule(), custom: rule() } }
}
export function validateProductionPolicy(input: unknown): ProductionPolicy {
  const data = input as ProductionPolicy
  if (
    !data ||
    typeof data.version !== 'string' ||
    typeof data.autoAdjust !== 'boolean' ||
    !data.rules
  )
    throw new Error('Invalid production settings.')
  const rules = {} as ProductionPolicy['rules']
  for (const kind of PRODUCTION_KINDS) {
    const rule = data.rules[kind]
    if (
      !rule ||
      typeof rule.enabled !== 'boolean' ||
      !['calendar', 'working'].includes(rule.dayType) ||
      !['payment_details', 'full_payment_details', 'approval'].includes(rule.startsAfter)
    )
      throw new Error('Invalid production rule.')
    const values = [rule.minDays, rule.maxDays, rule.estimateDays]
    if (values.some((n) => n !== null && (!Number.isInteger(n) || n < 1 || n > 365)))
      throw new Error('Production days must be whole numbers from 1 to 365.')
    if (rule.enabled && values.some((n) => n === null))
      throw new Error('Set the minimum, maximum and estimate before enabling.')
    if (rule.minDays !== null && rule.maxDays !== null && rule.minDays > rule.maxDays)
      throw new Error('Minimum cannot exceed maximum.')
    if (
      rule.estimateDays !== null &&
      ((rule.minDays !== null && rule.estimateDays < rule.minDays) ||
        (rule.maxDays !== null && rule.estimateDays > rule.maxDays))
    )
      throw new Error('Estimate must be within the permitted range.')
    rules[kind] = {
      enabled: rule.enabled,
      minDays: rule.minDays,
      maxDays: rule.maxDays,
      estimateDays: rule.estimateDays,
      dayType: rule.dayType,
      startsAfter: rule.startsAfter,
    }
  }
  return { version: data.version, autoAdjust: data.autoAdjust, rules }
}
