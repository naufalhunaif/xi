
export type FollowUpPolicy = {
  skill_name: string
  reason: string
  first_delay_hours: number
  repeat_delay_hours: number
  max_attempts: number
  send_start_hour: number
  send_end_hour: number
  time_zone: string
}

export type GoalPlan = {
  /** Turn-level lifecycle assessment; optional for older stored/internal plans. */
  stage?: 'discovery' | 'selection' | 'checkout' | 'fulfillment' | 'service' | 'closed'
  current_task?: string
  objective: string
  status:
    'active' | 'waiting' | 'waiting_answer' | 'waiting_payment' | 'waiting_approval' | 'completed'
  waiting_for: string
  next_action: string
  follow_up: FollowUpPolicy | null
}
