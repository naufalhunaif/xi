import db from '#services/workspace_database'
import {
  readWorkSchedule,
  validateWorkSchedule,
  workScheduleColumns,
  isAiWorking,
} from '#services/ai_work_schedule'
import { runtimeOptions, saveRuntimeOptions } from '#services/ai_runtime_options'
import { sharedMcpConnected } from '#services/shared_mcp_contract'
import env from '#start/env'
import { initializeDatabase } from '#services/init_model'
import { listPaymentMethods } from '#services/payment_method_service'
import { requestRecentAiReviews } from '#services/ai_review_service'
import { syncBundledSkills } from '#services/lean/lean_skill_sync'
import { syncBundledSkills as syncBeta3Skills } from '#beta3/skill_sync'
import { readProductionPolicy } from '#services/production_service'
import { isLocalAuth } from '#services/local_auth_service'
import {
  ensureWaitNoticeSkill,
  parseWaitNoticePolicy,
  WAIT_NOTICE_SKILL,
} from '#services/wait_notice_skill'

const BUSINESS_SOURCES = [
  { slug: 'store', name: 'Store' },
  { slug: 'material', name: 'Material' },
  { slug: 'invoice', name: 'Invoice' },
  { slug: 'fit', name: 'Fit Advisor' },
] as const

import { workspaceScope } from '#services/workspace_context'
const workspaceDefaults = new Map<string, Promise<void>>()

function workspaceBaseUrl() {
  return env
    .get('APP_URL')
    .replace(/\/$/, '')
    .replace(/\/whatsapp$/, '')
}

async function ensureBusinessSources() {
  // Standalone: tidak ada bundle Store/Material/Invoice/Fit, jadi tidak diseed.
  if (isLocalAuth()) return
  const settings = await db.from('whatsapp_settings').where('id', 1).firstOrFail()
  if (settings.mcp_seeded) return
  const baseUrl = workspaceBaseUrl()
  for (const source of BUSINESS_SOURCES) {
    await db.rawQuery(
      `INSERT INTO whatsapp_mcp_connections
       (slug, name, url, enabled, oauth_authenticated, last_error, updated_at)
       VALUES (?, ?, ?, 0, 0, NULL, ?)
       ON DUPLICATE KEY UPDATE slug = slug`,
      [source.slug, source.name, `${baseUrl}/${source.slug}/mcp`, new Date()]
    )
  }
  await db
    .from('whatsapp_settings')
    .where('id', 1)
    .update({ mcp_seeded: true, updated_at: new Date() })
}

export function ensureDefaults() {
  const key = workspaceScope().prefix
  let defaults = workspaceDefaults.get(key)
  if (defaults) return defaults
  defaults = (async () => {
    await initializeDatabase()
    const now = new Date()
    // Standalone: mulai langsung di Beta 3 (Beta 1/2 tidak dipakai di pemasangan ini).
    const beta3Default = isLocalAuth() ? 1 : 0
    await db.rawQuery(
      `INSERT IGNORE INTO whatsapp_settings
       (id, ai_enabled, mcp_seeded, skill_name, skill_content, chatgpt_reasoning, claude_reasoning, chatgpt_speed, claude_speed, lean_mode, beta3_mode, updated_at)
       VALUES (1, 0, 0, NULL, NULL, 'auto', 'auto', 'standard', 'standard', ?, ?, ?)`,
      [beta3Default ? 0 : 1, beta3Default, now]
    )
    await db.rawQuery(
      `INSERT IGNORE INTO whatsapp_connection (id, desired_connected, status, phone, qr_data_url, last_error, updated_at)
       VALUES (1, 0, 'disconnected', NULL, NULL, NULL, ?)`,
      [now]
    )
    await ensureBusinessSources()
    await ensureWaitNoticeSkill()
    // Skill bawaan repo ikut terpasang setiap deploy; tak perlu import manual.
    await syncBundledSkills().catch(() => {})
    await syncBeta3Skills().catch(() => {})
  })().catch((error) => {
    workspaceDefaults.delete(key)
    throw error
  })
  workspaceDefaults.set(key, defaults)
  return defaults
}

export async function readSettings(includeSkill = false) {
  await ensureDefaults()
  const [row, mcpConnections, skills, paymentMethods] = await Promise.all([
    db.from('whatsapp_settings').where('id', 1).firstOrFail(),
    db.from('whatsapp_mcp_connections').orderBy('id', 'asc'),
    db
      .from('whatsapp_skills')
      .select(
        'id',
        'name',
        'description',
        ...(includeSkill ? (['content'] as const) : []),
        'created_at',
        'updated_at'
      )
      .orderBy('id', 'asc'),
    listPaymentMethods(),
  ])
  return {
    production: await readProductionPolicy(),
    paymentMethods,
    aiEnabled: Boolean(row.ai_enabled),
    ...readWorkSchedule(row),
    aiWorkingNow: isAiWorking(row),
    aiProvider: row.ai_provider === 'claude' ? 'claude' : 'chatgpt',
    aiFailover: Boolean(row.ai_failover),
    // Mode saling eksklusif: beta3 menang atas beta2 (lean).
    beta3Mode: Boolean(row.beta3_mode ?? 0),
    leanMode: Boolean(row.lean_mode ?? 1) && !(row.beta3_mode ?? 0),
    aiMode: (row.beta3_mode ? 'beta3' : (row.lean_mode ?? 1) ? 'beta2' : 'beta1') as
      'beta1' | 'beta2' | 'beta3',
    chatgptModel: String(row.chatgpt_model || ''),
    chatgptSpeed: runtimeOptions(row, 'chatgpt').speed,
    chatgptReasoning: runtimeOptions(row, 'chatgpt').reasoning,
    codexBin: String(row.codex_bin || ''),
    claudeModel: String(row.claude_model || ''),
    claudeSpeed: runtimeOptions(row, 'claude').speed,
    claudeReasoning: runtimeOptions(row, 'claude').reasoning,
    claudeBin: String(row.claude_bin || ''),
    turnWindowMs: Number(row.turn_window_ms ?? 6000),
    historyLimit: Number(row.history_limit ?? 60),
    sweepEnabled: Boolean(row.sweep_enabled ?? 1),
    sweepMaxAgeHours: Number(row.sweep_max_age_hours ?? 48),
    sweepBatch: Number(row.sweep_batch ?? 10),
    hasSkill: skills.some((skill) => skill.name !== WAIT_NOTICE_SKILL),
    skills: skills.map((skill) => ({
      id: Number(skill.id),
      name: String(skill.name),
      description: String(skill.description || ''),
      content: includeSkill ? String(skill.content || '') : '',
      updatedAt: new Date(skill.updated_at).toISOString(),
      updatedAtLabel:
        new Intl.DateTimeFormat('id-ID', {
          timeZone: 'Asia/Jakarta',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(skill.updated_at)) + ' WIB',
    })),
    mcpConnections: mcpConnections.map((connection) => ({
      slug: String(connection.slug),
      name: String(connection.name),
      url: String(connection.url),
      enabled: Boolean(connection.enabled),
      authenticated: sharedMcpConnected(connection, String(row.ai_provider)),
      sharedAuthenticated: Boolean(connection.shared_authenticated),
      chatgptAuthenticated: Boolean(
        connection.chatgpt_authenticated ?? connection.oauth_authenticated
      ),
      claudeAuthenticated: Boolean(connection.claude_authenticated),
      error: String(connection.last_error || ''),
    })),
  }
}

export async function saveSettings(input: Record<string, unknown>) {
  await ensureDefaults()
  if (input.aiEnabled !== undefined && typeof input.aiEnabled !== 'boolean')
    throw new Error('Status AI tidak valid.')
  const aiEnabled = input.aiEnabled === true
  const importedSkills = Array.isArray(input.skills)
    ? input.skills.map((item) => ({
        content: String((item as Record<string, unknown>)?.content || '').trim(),
        fileName: String((item as Record<string, unknown>)?.fileName || '').trim(),
      }))
    : String(input.skillContent || '').trim()
      ? [{ content: String(input.skillContent).trim(), fileName: '' }]
      : []
  const current = await readSettings(false)
  const reservedNames = new Set(current.skills.map((skill) => skill.name))
  const batchNames = new Set<string>()
  const skills = importedSkills.map((file) => {
    if (!file.content) throw new Error('Skill kosong.')
    const frontmatter = file.content.match(/^---\s*\n([\s\S]*?)\n---/)
    const declaredName = frontmatter?.[1]
      ?.match(/^name:\s*(.+)$/im)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
    const declaredDescription = frontmatter?.[1]
      ?.match(/^description:\s*(.+)$/im)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
    const sourceName = declaredName || file.fileName.replace(/\.[^.]+$/, '') || 'skill'
    const baseName =
      sourceName
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'skill'
    let name = baseName
    let suffix = 2
    if (!declaredName) {
      while (reservedNames.has(name) || batchNames.has(name)) {
        name = `${baseName.slice(0, 60)}-${suffix}`
        suffix += 1
      }
    }
    if (batchNames.has(name)) throw new Error('Nama skill tidak boleh sama.')
    batchNames.add(name)
    reservedNames.add(name)
    const description = declaredDescription || `Skill ${name}`
    const hasUsableMetadata =
      Boolean(declaredName && declaredDescription) &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(declaredName))
    const content = hasUsableMetadata
      ? file.content
      : `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${file.content}`
    if (name === WAIT_NOTICE_SKILL) parseWaitNoticePolicy(content)
    return { name, description, content }
  })
  if (aiEnabled && !skills.some((skill) => skill.name !== WAIT_NOTICE_SKILL) && !current.hasSkill)
    throw new Error('Import SKILL.md terlebih dahulu.')
  const values: Record<string, unknown> = {
    updated_at: new Date(),
  }
  if (input.aiEnabled !== undefined) values.ai_enabled = aiEnabled
  if (Object.keys(workScheduleColumns).some((key) => input[key] !== undefined)) {
    const schedule = validateWorkSchedule({ ...current, ...input })
    // Only write the changed fields: another autosave must not overwrite this schedule.
    for (const [key, column] of Object.entries(workScheduleColumns))
      if (input[key] !== undefined) values[column] = schedule[key as keyof typeof schedule]
  }
  if (input.aiProvider !== undefined) {
    if (!['chatgpt', 'claude'].includes(String(input.aiProvider)))
      throw new Error('Mesin AI tidak valid.')
    values.ai_provider = String(input.aiProvider)
  }
  if (input.aiMode !== undefined) {
    const mode = String(input.aiMode)
    if (!['beta1', 'beta2', 'beta3'].includes(mode)) throw new Error('Mode AI tidak dikenal.')
    values.lean_mode = mode === 'beta2' ? 1 : 0
    values.beta3_mode = mode === 'beta3' ? 1 : 0
  }
  if (input.leanMode !== undefined) {
    values.lean_mode = input.leanMode === true || input.leanMode === 'on' ? 1 : 0
  }
  if (input.aiFailover !== undefined) {
    values.ai_failover = input.aiFailover === true || input.aiFailover === 'on'
  }
  if (input.chatgptModel !== undefined) {
    const model = String(input.chatgptModel || '').trim()
    if (model.length > 120 || (model && !/^[a-zA-Z0-9._-]+$/.test(model)))
      throw new Error('Model ChatGPT tidak valid.')
    values.chatgpt_model = model || null
  }
  Object.assign(values, saveRuntimeOptions(input, current, 'chatgpt'))
  if (input.codexBin !== undefined) {
    const bin = String(input.codexBin || '').trim()
    if (bin.length > 500) throw new Error('Lokasi codex terlalu panjang.')
    values.codex_bin = bin || null
  }
  if (input.claudeModel !== undefined) {
    const model = String(input.claudeModel || '').trim()
    if (model.length > 120 || (model && !/^[a-zA-Z0-9._-]+$/.test(model)))
      throw new Error('Model Claude tidak valid.')
    values.claude_model = model || null
  }
  Object.assign(values, saveRuntimeOptions(input, current, 'claude'))
  if (input.claudeBin !== undefined) {
    const bin = String(input.claudeBin || '').trim()
    if (bin.length > 500) throw new Error('Lokasi claude terlalu panjang.')
    values.claude_bin = bin || null
  }
  if (input.turnWindowMs !== undefined) {
    const window = Number(input.turnWindowMs)
    if (!Number.isFinite(window) || window < 0 || window > 60000)
      throw new Error('Jendela giliran harus 0-60000 milidetik.')
    values.turn_window_ms = Math.round(window)
  }
  if (input.sweepEnabled !== undefined) {
    values.sweep_enabled = input.sweepEnabled === true || input.sweepEnabled === 'on'
  }
  if (input.sweepMaxAgeHours !== undefined) {
    const hours = Number(input.sweepMaxAgeHours)
    if (!Number.isFinite(hours) || hours < 1 || hours > 168)
      throw new Error('Batas usia sapuan harus 1-168 jam.')
    values.sweep_max_age_hours = Math.round(hours)
  }
  if (input.sweepBatch !== undefined) {
    const batch = Number(input.sweepBatch)
    if (!Number.isFinite(batch) || batch < 1 || batch > 50)
      throw new Error('Jumlah chat per sapuan harus 1-50.')
    values.sweep_batch = Math.round(batch)
  }
  if (input.historyLimit !== undefined) {
    const limit = Number(input.historyLimit)
    if (!Number.isFinite(limit) || limit < 5 || limit > 200)
      throw new Error('Jumlah riwayat harus 5-200 pesan.')
    values.history_limit = Math.round(limit)
  }
  await db.transaction(async (trx) => {
    for (const skill of skills) {
      await trx.rawQuery(
        `INSERT INTO whatsapp_skills (name, description, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description), content = VALUES(content),
         updated_at = VALUES(updated_at)`,
        [skill.name, skill.description, skill.content, new Date(), new Date()]
      )
    }
    await trx.from('whatsapp_settings').where('id', 1).update(values)
    if (input.mcpConnections && typeof input.mcpConnections === 'object') {
      const selected = input.mcpConnections as Record<string, unknown>
      const connections = await trx.from('whatsapp_mcp_connections').select('slug')
      for (const connection of connections) {
        if (!Object.hasOwn(selected, connection.slug)) continue
        await trx
          .from('whatsapp_mcp_connections')
          .where('slug', connection.slug)
          .update({ enabled: selected[connection.slug] === true, updated_at: new Date() })
      }
    }
  })
  if (aiEnabled && !current.aiEnabled) {
    await requestRecentAiReviews(
      'enabled',
      Number(values.sweep_max_age_hours || current.sweepMaxAgeHours)
    )
  }
  return readSettings()
}

export async function createMcpConnection(input: Record<string, unknown>) {
  await ensureDefaults()
  const name = String(input.name || '').trim()
  const rawUrl = String(input.url || '').trim()
  if (!name || name.length > 120) throw new Error('Nama MCP tidak valid.')
  if (!rawUrl || rawUrl.length > 1000) throw new Error('URL MCP tidak valid.')

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('URL MCP tidak valid.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL MCP tidak valid.')
  url.hash = ''

  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 52) || 'data-bisnis'
  const rows = await db.from('whatsapp_mcp_connections').select('slug')
  const existing = new Set(rows.map((row) => String(row.slug)))
  let slug = base
  let suffix = 2
  while (existing.has(slug)) {
    slug = `${base.slice(0, 58)}-${suffix}`
    suffix += 1
  }

  await db.table('whatsapp_mcp_connections').insert({
    slug,
    name,
    url: url.toString(),
    enabled: false,
    oauth_authenticated: false,
    last_error: null,
    updated_at: new Date(),
  })
  return readSettings()
}

export async function deleteMcpConnection(slug: string) {
  await ensureDefaults()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('Koneksi MCP tidak valid.')
  const deleted = await db.from('whatsapp_mcp_connections').where('slug', slug).delete()
  if (!deleted) throw new Error('Koneksi MCP tidak ditemukan.')
  return readSettings()
}

export async function deleteSkill(id: number) {
  await ensureDefaults()
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Skill tidak valid.')
  const deleted = await db.from('whatsapp_skills').where('id', id).delete()
  if (!deleted) throw new Error('Skill tidak ditemukan.')
  const remaining = await db
    .from('whatsapp_skills')
    .whereNot('name', WAIT_NOTICE_SKILL)
    .count('* as total')
    .firstOrFail()
  if (Number(remaining.total) === 0) {
    await db
      .from('whatsapp_settings')
      .where('id', 1)
      .update({ ai_enabled: false, updated_at: new Date() })
  }
  return readSettings()
}

/**
 * Nilai sakelar Beta 2 untuk halaman (tanpa ensureDefaults, tanpa menelan error):
 * dibaca langsung dari whatsapp_settings supaya tampilan chat/Order selalu sama
 * dengan yang dipakai worker.
 */
export async function isLeanMode() {
  const row = await db
    .from('whatsapp_settings')
    .where('id', 1)
    .select('lean_mode', 'beta3_mode')
    .first()
  return Boolean(row?.lean_mode ?? 1) && !(row?.beta3_mode ?? 0)
}

export async function isBeta3Mode() {
  const row = await db.from('whatsapp_settings').where('id', 1).select('beta3_mode').first()
  return Boolean(row?.beta3_mode ?? 0)
}
