import { DateTime } from 'luxon'

export const workScheduleDefaults = {
  aiWorkMode: 'always',
  aiWorkTimezone: 'Asia/Jakarta',
  aiWorkDays: '1,2,3,4,5,6,7',
  aiWorkStart: '09:00',
  aiWorkEnd: '17:00',
}
export const workScheduleColumns = {
  aiWorkMode: 'ai_work_mode',
  aiWorkTimezone: 'ai_work_timezone',
  aiWorkDays: 'ai_work_days',
  aiWorkStart: 'ai_work_start',
  aiWorkEnd: 'ai_work_end',
} as const

export function readWorkSchedule(row: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(workScheduleColumns).map(([key, column]) => [
      key,
      row[key] ?? row[column] ?? workScheduleDefaults[key as keyof typeof workScheduleDefaults],
    ])
  ) as typeof workScheduleDefaults
}

export function validateWorkSchedule(input: Record<string, unknown>) {
  for (const key of Object.keys(workScheduleColumns))
    if (Object.hasOwn(input, key) && typeof input[key] !== 'string')
      throw new Error('Jadwal AI tidak valid.')
  const value = readWorkSchedule(input)
  if (!['always', 'scheduled'].includes(value.aiWorkMode))
    throw new Error('Mode jadwal AI tidak valid.')
  if (
    typeof value.aiWorkTimezone !== 'string' ||
    value.aiWorkTimezone.length > 80 ||
    !DateTime.now().setZone(value.aiWorkTimezone).isValid
  )
    throw new Error('Zona waktu tidak valid.')
  if (typeof value.aiWorkDays !== 'string' || !/^(?:[1-7](?:,[1-7])*)?$/.test(value.aiWorkDays))
    throw new Error('Hari kerja AI tidak valid.')
  value.aiWorkDays = [...new Set(value.aiWorkDays.split(',').filter(Boolean))].sort().join(',')
  for (const time of [value.aiWorkStart, value.aiWorkEnd])
    if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new Error('Jam kerja AI tidak valid.')
  if (value.aiWorkStart === value.aiWorkEnd)
    throw new Error(
      'Jam mulai dan selesai harus berbeda. Gunakan mode 24 jam untuk sepanjang hari.'
    )
  return value
}

/** End-exclusive. For overnight shifts the selected weekday is the start day.
 * Accepts both public settings and DB rows; malformed persisted schedules fail closed.
 */
export function isAiWorking(settings: Record<string, any> | undefined | null, now = new Date()) {
  if (!settings || !(settings.aiEnabled ?? settings.ai_enabled)) return false
  try {
    const schedule = validateWorkSchedule(settings)
    if (schedule.aiWorkMode === 'always') return true
    const local = DateTime.fromJSDate(now, { zone: schedule.aiWorkTimezone })
    if (!local.isValid) return false
    const time = local.toFormat('HH:mm')
    const days = schedule.aiWorkDays.split(',')
    const today = days.includes(String(local.weekday))
    if (schedule.aiWorkStart < schedule.aiWorkEnd)
      return today && time >= schedule.aiWorkStart && time < schedule.aiWorkEnd
    return (
      (today && time >= schedule.aiWorkStart) ||
      (days.includes(String(local.minus({ days: 1 }).weekday)) && time < schedule.aiWorkEnd)
    )
  } catch {
    return false
  }
}
