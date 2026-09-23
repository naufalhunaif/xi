// Creates/drops only a freshly named disposable local schema; never runs against the app DB.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

process.loadEnvFile('.env')
const testFilters = process.argv.slice(3)
if (testFilters.some((arg) => !arg.startsWith('--tests=')))
  throw new Error('Only exact --tests= filters are allowed after the suite.')
const orderDetails = process.argv[2] === '--order-details'
const waitNotices = process.argv[2] === '--wait-notices'
const shippingQueue = process.argv[2] === '--shipping-queue'
const paymentReview = process.argv[2] === '--payment-review'
const skillEdits = process.argv[2] === '--skill-edits'
const inboxRead = process.argv[2] === '--inbox-read'
const visualMatch = process.argv[2] === '--visual-match'
const humanCart = process.argv[2] === '--human-cart'
const chatCleanup = process.argv[2] === '--chat-cleanup'
const evidenceCache = process.argv[2] === '--evidence-cache'
const conversationMemory = process.argv[2] === '--conversation-memory'
const aiRuntimeSettings = process.argv[2] === '--ai-runtime-settings'
const learning = process.argv[2] === '--learning'
const contactDirectory = process.argv[2] === '--contact-directory'
const aiQuotas = process.argv[2] === '--ai-quotas'
const catalogDrafts = process.argv[2] === '--catalog-drafts'
const workSchedule = process.argv[2] === '--work-schedule'
const preorder = process.argv[2] === '--preorder'
const failover = process.argv[2] === '--failover'
const waiting = process.argv[2] === '--waiting'
const skillRouting = process.argv[2] === '--skill-routing'
const compactReply = process.argv[2] === '--compact-reply'
const salesProgress = process.argv[2] === '--sales-progress'
if (salesProgress && (process.env.AI_SKILL_LIVE_TEST !== '1' || !process.env.COMPACT_SKILL_FIXTURE_DIR))
  throw new Error('Sales semantic tests require explicit live opt-in and local policy fixtures.')
if (compactReply && !process.env.COMPACT_SKILL_FIXTURE_DIR)
  throw new Error('COMPACT_SKILL_FIXTURE_DIR must point to local exported skills; fixture provider only.')
const conversationLevels = process.argv[2] === '--conversation-levels'
const diagnostics = process.argv[2] === '--diagnostics'
const analysisRetry = process.argv[2] === '--analysis-retry'
const initiativeProgress = process.argv[2] === '--initiative-progress'
const orderIntentSemantic = process.argv[2] === '--order-intent-semantic'
if (orderIntentSemantic && process.env.AI_SKILL_LIVE_TEST !== '1')
  throw new Error('Semantic tests require AI_SKILL_LIVE_TEST=1 (uses OAuth quota).')
const customSizeSemantic = process.argv[2] === '--custom-size-semantic'
if (customSizeSemantic && process.env.AI_SKILL_LIVE_TEST !== '1')
  throw new Error('Semantic tests require AI_SKILL_LIVE_TEST=1 (uses OAuth quota).')
if (initiativeProgress && process.env.AI_SKILL_LIVE_TEST !== '1')
  throw new Error('Live initiative tests require AI_SKILL_LIVE_TEST=1 (uses OAuth quota).')
if (
  process.argv[2] &&
  !orderDetails &&
  !waitNotices &&
  !shippingQueue &&
  !paymentReview &&
  !skillEdits &&
  !inboxRead &&
  !visualMatch &&
  !humanCart &&
  !evidenceCache &&
  !conversationMemory &&
  !aiRuntimeSettings &&
  !learning &&
  !contactDirectory &&
  !aiQuotas &&
  !catalogDrafts &&
  !workSchedule &&
  !preorder &&
  !failover &&
  !waiting &&
  !skillRouting &&
  !compactReply &&
  !salesProgress &&
  !conversationLevels &&
  !diagnostics &&
  !analysisRetry &&
  !initiativeProgress &&
  !customSizeSemantic &&
  !orderIntentSemantic &&
  !chatCleanup
)
  throw new Error('Unknown test suite.')
const host = process.env.DB_HOST || '127.0.0.1'
if (!['localhost', '127.0.0.1'].includes(host))
  throw new Error('Only local fixture databases are allowed.')
const name = `wa_discount_test_${randomBytes(8).toString('hex')}`
if (!/^wa_discount_test_[a-f0-9]{16}$/.test(name)) throw new Error('Invalid fixture name.')
const connection = await mysql.createConnection({
  host,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})
let created = false
try {
  await connection.query(
    `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  created = true
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import=@poppinss/ts-exec',
        'bin/test.ts',
        'functional',
        ...testFilters,
        ...(waiting ? [
          '--files=tests/functional/conversation_goal.spec.ts',
          '--files=tests/functional/ai_recovery.spec.ts',
          '--files=tests/functional/conversation_evaluation.spec.ts',
        ] : []),
        ...(initiativeProgress ? [
          '--tests=confirmed customization continues without checkout consent: destination missing',
          '--tests=confirmed customization continues without checkout consent: destination already asked',
          '--tests=confirmed selection requests the missing recipient directly',
          '--tests=active service respects a customer postponing a selected cart',
        ] : []),
        salesProgress
          ? '--files=tests/functional/sales_progress_live.spec.ts'
          : compactReply
          ? '--files=tests/functional/compact_reply_database.spec.ts'
          : conversationLevels
          ? '--files=tests/functional/conversation_levels_database.spec.ts'
          : orderIntentSemantic
          ? '--files=tests/functional/order_intent_semantic.spec.ts'
          : customSizeSemantic
          ? '--files=tests/functional/custom_size_semantic.spec.ts'
          : initiativeProgress
          ? '--files=tests/functional/initiative_skill.spec.ts'
          : analysisRetry
          ? '--files=tests/functional/analysis_retry_database.spec.ts'
          : diagnostics
          ? '--files=tests/functional/diagnostics_database.spec.ts'
          : skillRouting
          ? '--files=tests/functional/skill_routing_database.spec.ts'
          : waiting
          ? '--files=tests/functional/waiting_idempotency_database.spec.ts'
          : failover
          ? '--files=tests/functional/ai_provider_failover_database.spec.ts'
          : preorder
          ? '--files=tests/functional/preorder_fulfillment_database.spec.ts'
          : workSchedule
          ? '--files=tests/functional/ai_work_schedule_database.spec.ts'
          : catalogDrafts
          ? '--files=tests/functional/catalog_drafts_database.spec.ts'
          : aiQuotas
          ? '--files=tests/functional/ai_quota_database.spec.ts'
          : contactDirectory
          ? '--files=tests/functional/contact_directory_database.spec.ts'
          : learning
          ? '--files=tests/functional/conversation_learning_database.spec.ts'
          : aiRuntimeSettings
          ? '--files=tests/functional/ai_runtime_settings_database.spec.ts'
          : conversationMemory
          ? '--files=tests/functional/conversation_memory_database.spec.ts'
          : evidenceCache
            ? '--files=tests/functional/evidence_cache_database.spec.ts'
            : chatCleanup
              ? '--files=tests/functional/chat_cleanup_database.spec.ts'
              : humanCart
                ? '--files=tests/functional/human_cart_evidence_database.spec.ts'
                : visualMatch
                  ? '--files=tests/functional/visual_detail.spec.ts'
                  : inboxRead
                    ? '--files=tests/functional/incoming_read_database.spec.ts'
                    : skillEdits
                      ? '--files=tests/functional/skill_edits_database.spec.ts'
                      : paymentReview
                        ? '--files=tests/functional/payment_review.spec.ts'
                        : shippingQueue
                          ? '--files=tests/functional/order_shipping_queue_database.spec.ts'
                          : waitNotices
                            ? '--files=tests/functional/payment_wait_notice_database.spec.ts'
                            : orderDetails
                              ? '--files=tests/functional/order_item_details_database.spec.ts'
                              : '--files=tests/functional/cart_discount_database.spec.ts',
      ],
      {
        env: {
          ...process.env,
          ...(compactReply ? { AI_COMPACT_REPLY_ENABLED: 'true' } : {}),
          DB_DATABASE: name,
          ...(chatCleanup ? { SESSION_DRIVER: 'memory' } : {}),
          ...(contactDirectory ? { SESSION_DRIVER: 'memory', APP_BASE_PATH: '/', APP_URL: 'http://127.0.0.1:33987' } : {}),
          DISCOUNT_DB_TEST: '1',
          ORDER_DETAILS_DB_TEST: orderDetails ? '1' : '0',
          WAIT_NOTICES_DB_TEST: waitNotices ? '1' : '0',
          SHIPPING_QUEUE_DB_TEST: shippingQueue ? '1' : '0',
          PORT: '33987',
          HOST: '127.0.0.1',
        },
        stdio: 'inherit',
      }
    )
    child.once('error', reject)
    child.once('exit', (value) => resolve(value ?? 1))
  })
  process.exitCode = code
} finally {
  if (created) {
    await connection.query(`DROP DATABASE \`${name}\``)
    console.log('Disposable discount test database removed; application database unchanged.')
  }
  await connection.end()
}
