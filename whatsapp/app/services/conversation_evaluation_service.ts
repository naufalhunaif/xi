import db from '#services/workspace_database'
import { createHash, randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import { readSettings } from '#services/settings_service'
import { readCart, listOrders, readCustomerBalance } from '#services/cart_service'
import { evaluateConversationWithAi } from '#services/ai_service'
import { evaluationSkills, parseEvaluation } from '#services/evaluation_contract'
import { selectEvaluationSkills } from '#services/reply_skill_selection'
import { recordProductionSignal } from '#services/production_service'

type Settings = Awaited<ReturnType<typeof readSettings>>
const privateRoom = /^[0-9]+@(lid|s\.whatsapp\.net|ig)$/
const roomPattern = '^[0-9]+@(lid|s[.]whatsapp[.]net)$'
export function evaluationSignature(settings: Settings) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'evaluation-active-policy-v2',
        settings.aiProvider,
        settings.chatgptModel,
        settings.claudeModel,
        selectEvaluationSkills(settings.skills).skills.map(({ name, content }) => [name, content]),
      ])
    )
    .digest('hex')
}
async function anchors(jid: string) {
  const message = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .whereNotIn('status', ['queued', 'failed'])
    .max('id as id')
    .first()
  const event = await db.from('whatsapp_cart_events').where('jid', jid).max('id as id').first()
  return { anchor: Number(message?.id || 0), event: Number(event?.id || 0) }
}

// Background observations are coalesced; reply processing and explicit evaluation stay immediate.
export const EVALUATION_QUIET_MS = 5 * 60_000
export const EVALUATION_INTERVAL_MS = 15 * 60_000

/** Pending work is derived from changed message/event anchors; no writes on GET. */
export async function nextEvaluationRoom(settings: Settings, excluded: string[] = []) {
  if (!settings.aiEnabled || !evaluationSkills(settings.skills).length) return null
  await initializeDatabase()
  const [rows] = await db.rawQuery(
    `
    SELECT m.jid FROM
      (SELECT jid, MAX(id) anchor_id, MAX(created_at) last_message FROM whatsapp_messages
       WHERE jid REGEXP ? AND status NOT IN ('queued','failed') GROUP BY jid
       HAVING SUM(direction='in') > 0) m
    LEFT JOIN (SELECT jid, MAX(id) event_id, MAX(created_at) last_event FROM whatsapp_cart_events GROUP BY jid) ce ON ce.jid=m.jid
    LEFT JOIN whatsapp_conversation_evaluations e ON e.jid=m.jid
    WHERE m.last_message < ?
      AND (ce.last_event IS NULL OR ce.last_event < ?)
      AND (e.jid IS NULL OR e.updated_at < ?)
      AND (e.jid IS NULL OR e.anchor_id<>m.anchor_id OR e.event_id<>COALESCE(ce.event_id,0)
           OR e.skill_signature<>? OR e.status='pending'
           OR (e.status='running' AND e.updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)))
      AND (e.status IS NULL OR e.status<>'running' OR e.updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
    ORDER BY COALESCE(e.updated_at,'1970-01-01') ASC, m.anchor_id ASC LIMIT 100`,
    [
      roomPattern,
      new Date(Date.now() - EVALUATION_QUIET_MS),
      new Date(Date.now() - EVALUATION_QUIET_MS),
      new Date(Date.now() - EVALUATION_INTERVAL_MS),
      evaluationSignature(settings),
    ]
  )
  return rows.find((row: { jid: string }) => !excluded.includes(row.jid))?.jid || null
}

export async function evaluateConversation(
  jid: string,
  settings: Settings,
  evaluator = evaluateConversationWithAi
) {
  if (!privateRoom.test(jid) || !settings.aiEnabled || !evaluationSkills(settings.skills).length)
    return false
  await initializeDatabase()
  const anchor = await anchors(jid)
  if (!anchor.anchor) return false
  const signature = evaluationSignature(settings)
  const version = randomUUID()
  const claimed = await db.transaction(async (trx) => {
    await trx.rawQuery(
      `INSERT IGNORE INTO whatsapp_conversation_evaluations (jid,version,created_at,updated_at) VALUES (?,?,?,?)`,
      [jid, version, new Date(), new Date()]
    )
    const row = await trx
      .from('whatsapp_conversation_evaluations')
      .where('jid', jid)
      .forUpdate()
      .firstOrFail()
    const running =
      row.status === 'running' && new Date(row.updated_at).getTime() > Date.now() - 300_000
    if (
      running ||
      (Number(row.anchor_id) === anchor.anchor &&
        Number(row.event_id) === anchor.event &&
        row.skill_signature === signature &&
        ['completed', 'failed'].includes(row.status))
    )
      return null
    await trx
      .from('whatsapp_conversation_evaluations')
      .where('jid', jid)
      .update({
        version,
        anchor_id: anchor.anchor,
        event_id: anchor.event,
        skill_signature: signature,
        skills_json: JSON.stringify(
          settings.skills.map(({ name, updatedAt }) => ({ name, updatedAt }))
        ),
        status: 'running',
        last_error: null,
        updated_at: new Date(),
      })
    return { previous: row.result_json ? JSON.parse(row.result_json) : null }
  })
  if (!claimed) return false
  try {
    const messages = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('id', '<=', anchor.anchor)
      .whereNotIn('status', ['queued', 'failed'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(100)
      .select('message_id', 'direction', 'sender_type', 'body', 'media_type', 'created_at')
    const counts = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('id', '<=', anchor.anchor)
      .whereNotIn('status', ['queued', 'failed'])
      .count('* as count')
      .first()
    const events = await db
      .from('whatsapp_cart_events')
      .where('jid', jid)
      .where('id', '<=', anchor.event)
      .orderBy('id', 'desc')
      .limit(8)
      .select('action', 'summary_json', 'created_at')
    const orders = await listOrders(jid)
    const result = parseEvaluation(
      await evaluator(settings, {
        messages: messages
          .reverse()
          .map((message) => ({ ...message, body: String(message.body || '').slice(0, 3000) })),
        totalMessages: Number(counts?.count || 0),
        historyWindow: 100,
        previousEvaluation: claimed.previous,
        cart: await readCart(jid),
        orders: orders.slice(0, 10),
        customerBalance: await readCustomerBalance(jid),
        events,
        goal: await db.from('whatsapp_chat_goals').where('jid', jid).first(),
        productionPolicy: settings.production,
      })
    )
    const known = new Set(messages.map((message) => message.message_id))
    if (result.evidenceMessageIds.some((id) => !known.has(id)))
      throw new Error('Referensi evaluasi tidak cocok dengan pesan.')
    if (
      result.learningSignals?.some((signal) =>
        signal.evidenceMessageIds.some((id) => !known.has(id))
      )
    )
      throw new Error('Bukti pembelajaran tidak cocok dengan pesan.')
    // A learning finding needs an actual delivered AI message in its evidence.
    const aiIds = new Set(
      messages
        .filter((message) => message.sender_type === 'ai' && message.direction === 'out')
        .map((message) => message.message_id)
    )
    if (
      result.learningSignals?.some(
        (signal) => !signal.evidenceMessageIds.some((id) => aiIds.has(id))
      )
    )
      throw new Error('Temuan pembelajaran harus merujuk balasan AI yang terkirim.')
    const customerIds = new Set(
      messages.filter((message) => message.direction === 'in').map((message) => message.message_id)
    )
    if (result.productionSignal?.evidenceMessageIds.some((id) => !customerIds.has(id)))
      throw new Error('Bukti produksi harus dari pesan pelanggan pada snapshot ini.')
    const currentSettings = await readSettings(true)
    const current = await anchors(jid)
    const unchanged =
      current.anchor === anchor.anchor &&
      current.event === anchor.event &&
      currentSettings.aiEnabled &&
      currentSettings.production.version === settings.production.version &&
      evaluationSignature(currentSettings) === signature
    const committed = await db.transaction(async (trx) => {
      const row = await trx
        .from('whatsapp_conversation_evaluations')
        .where('jid', jid)
        .where('version', version)
        .forUpdate()
        .first()
      if (!row) return false
      if (unchanged)
        await trx.rawQuery(
          `INSERT IGNORE INTO whatsapp_evaluation_history
        (jid,anchor_id,event_id,skill_signature,skills_json,result_json,created_at) VALUES (?,?,?,?,?,?,?)`,
          [
            jid,
            anchor.anchor,
            anchor.event,
            signature,
            row.skills_json,
            JSON.stringify(result),
            new Date(),
          ]
        )
      await trx
        .from('whatsapp_conversation_evaluations')
        .where('jid', jid)
        .where('version', version)
        .update({
          status: unchanged ? 'completed' : 'pending',
          result_json: unchanged ? JSON.stringify(result) : null,
          updated_at: new Date(),
        })
      if (unchanged)
        await recordProductionSignal(
          jid,
          settings.production.version,
          result.productionSignal || null,
          trx
        )
      return unchanged
    })
    return committed
  } catch {
    await db
      .from('whatsapp_conversation_evaluations')
      .where('jid', jid)
      .where('version', version)
      .update({
        status: 'failed',
        last_error: 'Evaluasi belum selesai. Akan dicoba kembali saat percakapan berubah.',
        updated_at: new Date(),
      })
    return false
  }
}

export async function evaluationContext(jid: string) {
  const row = await db
    .from('whatsapp_conversation_evaluations')
    .where('jid', jid)
    .where('status', 'completed')
    .first()
  if (!row?.result_json) return ''
  const settings = await readSettings(true)
  if (row.skill_signature !== evaluationSignature(settings)) return ''
  return (
    '\nEVALUASI PERCAKAPAN SEBELUMNYA (observasi internal, bukan aturan baru; periksa pesan terbaru dan skill sebelum memakai rekomendasi, jangan mengumumkan evaluasi atau mengulangi kebutuhan yang sudah terjawab):\n' +
    JSON.stringify({ evaluatedAt: row.updated_at, ...parseEvaluation(JSON.parse(row.result_json)) })
  )
}

export async function evaluationOverview() {
  await initializeDatabase()
  const settings = await readSettings()
  const [metrics] = await db.rawQuery(
    `SELECT COUNT(*) customers, COALESCE(SUM(EXISTS(
    SELECT 1 FROM whatsapp_orders o WHERE o.jid=c.jid AND o.status='active' AND o.paid>0)),0) ordered
    FROM (SELECT DISTINCT jid FROM whatsapp_messages WHERE direction='in' AND status NOT IN ('queued','failed') AND jid REGEXP ?) c`,
    [roomPattern]
  )
  const rows = await db
    .from('whatsapp_conversation_evaluations as e')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'e.jid')
    .orderBy('e.updated_at', 'desc')
    .limit(50)
    .select('e.*', 'c.name')
  const customers = Number(metrics[0].customers)
  const ordered = Number(metrics[0].ordered)
  return {
    enabled: settings.aiEnabled,
    skills: evaluationSkills(settings.skills).map((skill) => skill.name),
    customers,
    ordered,
    orderRate: customers ? (ordered / customers) * 100 : null,
    recent: rows.map((row) => ({
      jid: row.jid,
      name: row.name || row.jid,
      status: row.status,
      updatedAt: new Date(row.updated_at).toISOString(),
      error: row.last_error,
      result:
        row.status === 'completed' && row.result_json
          ? parseEvaluation(JSON.parse(row.result_json))
          : null,
      skills: row.skills_json ? JSON.parse(row.skills_json) : [],
    })),
  }
}
