import { BaseCommand, flags } from '@adonisjs/core/ace'
import { startWorkerDiagnostics } from '#services/worker_diagnostics'
import { workspaceSocket } from '#services/workspace_socket'
import { executeChatCleanup, filterDeletedChatHistory } from '#services/chat_cleanup_service'
import { cleanupWorkspace } from '#services/workspace_service'
import {
  activateWorkspace,
  activeWorkspace,
  adoptWorkspace,
  archiveWorkspace,
  clearWorkspaceSession,
  ensureWorkspaceRegistry,
  registerWorkspaceWorker,
  workspaceState,
} from '#services/workspace_service'
import {
  inWorkspace,
  workspaceScope,
  workspaceFileName,
  type WorkspaceScope,
} from '#services/workspace_context'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '#services/workspace_database'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  jidNormalizedUser,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import pino from 'pino'

/** Versi WhatsApp Web terbaru (versi bawaan Baileys bisa ditolak server bila usang). */
let waVersion: { value?: [number, number, number]; at: number } = { at: 0 }
async function latestWaVersion() {
  if (waVersion.value && Date.now() - waVersion.at < 6 * 3_600_000) return waVersion.value
  try {
    const result = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) } as any)
    if (result?.version?.length === 3)
      waVersion = { value: result.version as [number, number, number], at: Date.now() }
  } catch {
    // Tetap pakai versi terakhir yang diketahui / bawaan.
  }
  return waVersion.value
}
import { databaseAuthState, clearAuthRows } from '#services/baileys_auth_service'
import { currentLine, setCurrentLine, lineColumns, lineOf } from '#services/line_context'
import { listLines, readLine, removeLineNow, updateLine } from '#services/line_service'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createReply,
  repairCatalogNotesWithAi,
  type AiContextImage,
  type AiMedia,
  type AiDecision,
} from '#services/ai_service'
import { buildTurnContext, saveChatNote } from '#services/context_service'
import { createLeanReply, finishLeanGoal, claimLeanNudge } from '#services/lean/lean_reply_service'
import { syncLeanCatalog } from '#services/lean/lean_mcp'
import { sendLeanTotal } from '#services/lean/lean_order_service'
import { describeCatalogPhotos } from '#services/lean/lean_catalog_vision'
import * as beta3Reply from '#beta3/reply_service'
import * as beta3Order from '#beta3/order_service'
import * as beta3Tables from '#beta3/tables'
import * as beta3Mcp from '#beta3/mcp'
import * as beta3Vision from '#beta3/catalog_vision'
import * as beta3Examples from '#beta3/examples_service'
import * as beta3Catalog from '#beta3/catalog_service'
import * as beta3Refs from '#beta3/refs_service'
import * as beta3Recap from '#beta3/recap_service'
import * as beta3SkillSync from '#beta3/skill_sync'
const beta3 = {
  ...beta3Reply,
  ...beta3Order,
  ...beta3Tables,
  ...beta3Mcp,
  ...beta3Vision,
  ...beta3Examples,
  ...beta3Catalog,
}
import { learnFromHumanReply } from '#services/lean/lean_examples_service'
import {
  nextLeanGroupOrder,
  finishLeanGroupOrder,
  renderGroupOrderMessage,
} from '#services/lean/lean_order_service'
import { catalogDigest, findCatalogVariant } from '#services/lean/lean_catalog_service'
import { downloadOutgoingImage } from '#services/outgoing_image_service'
import { setHandlingMode } from '#services/message_service'
import { saveCustomerMemory } from '#services/conversation_memory'
import { rememberCustomerPhone, phoneFromJid } from '#services/customer_identity_service'
import { readCart } from '#services/cart_service'
import {
  incompleteCartSelection,
  cartSelectionRecoveryPrompt,
  conversationOnlyCartRecovery,
} from '#services/cart_selection_recovery'
import {
  CATALOG_NOTES_MISMATCH,
  catalogNotesRepairInput,
  applyCatalogNotesRepair,
} from '#services/catalog_notes_repair'
import {
  cacheOrderGroups,
  orderRouting,
  recoverOrderGroupQueue,
} from '#services/order_operations_service'
import { deliverNextOrderGroup } from '#services/order_group_delivery_service'
import { processNextShipment, nextShipmentConversation } from '#services/order_shipping_service'
import { dueShippingNotices, deliverShippingNotice } from '#services/shipping_notice_service'
import {
  duePaymentWaitNotices,
  deliverPaymentWaitNotice,
} from '#services/payment_wait_notice_service'
import { dueApprovalWaitNotices, deliverApprovalWaitNotice } from '#services/approval_wait_service'
import {
  applyAiCartIntent,
  CartVerificationError,
  CartReferenceError,
  CatalogLookupError,
  holdCatalogDraft,
  holdUnverifiedCartReply,
  resolveCartIssues,
  holdCheckoutForReview,
} from '#services/ai_cart_service'
import { isAiWorking } from '#services/ai_work_schedule'
import { CheckoutConsentError } from '#services/checkout_consent_service'
import { handleInternalDecision } from '#services/internal_decision_service'
import { understandHumanAnswer } from '#services/human_answer_service'
import { readSettings } from '#services/settings_service'
import env from '#start/env'
import { startTrace } from '#services/trace_service'
import { aiFailureDetail, AiProcessFailure } from '#services/ai_failure_service'
import {
  recordAnalysisFailure,
  flushAnalysisFailures,
  dueAnalysisRetries,
  recoverInterruptedAnalyses,
  recoverLegacyPausedAnalyses,
  recoverCatalogConsentHandoffs,
  markGoalDelivery,
} from '#services/analysis_retry_service'
import { planProviderRun } from '#services/ai_provider_failover'
import {
  isTrackedOutgoingMessage,
  trackOutgoingMessage,
  saveSentAiMessage,
} from '#services/outgoing_delivery_service'
import { nextEvaluationRoom, evaluateConversation } from '#services/conversation_evaluation_service'
import { runConversationLearning } from '#services/conversation_learning_service'
import { saveSyncRetry, dueSyncRetries, finishSyncRetry } from '#services/sync_retry_service'
import { sendPreparedReply } from '#services/reply_presence_service'
import { sendAiMessageSequence } from '#services/ai_message_sequence'
import { recordBalanceRecap, tryConfirmedBalanceCheckout } from '#services/cart_service'
import { recordCheckoutContinuity } from '#services/checkout_continuity'
import { prepareOutgoingImages, outgoingMessagePayload } from '#services/outgoing_image_service'
import {
  prepareBusinessGuideMedia,
  selectedBusinessGuides,
} from '#services/business_guide_media_service'
import { paymentDataSignature } from '#services/payment_context_service'
import { resumeAiAfterHumanReply } from '#services/message_service'
import { csOutgoingPayload, csMediaPath } from '#services/cs_media_service'
import { markRoomRead } from '#services/contact_inbox_service'
import { isInternalOnlyQuestion } from '#services/customer_scope_service'
import { readIncomingThrough, flushWorkspaceReads } from '#services/incoming_read_service'
import {
  requestAiReview,
  requestRecentAiReviews,
  finishAiReview,
} from '#services/ai_review_service'
import {
  startWorkerHeartbeat,
  touchWorkerHeartbeat,
  stopWorkerHeartbeat,
} from '#services/connection_status_service'
import {
  beginGoalTurn,
  alreadyAnalyzedMessage,
  failedGoalMessage,
  invalidateConversationGoal,
  isCurrentGoalRun,
  saveGoalDecision,
  dueConversationGoals,
  claimConversationGoal,
  pauseGoalRun,
  type GoalRun,
  scheduledGoalStillAllowed,
} from '#services/conversation_goal_service'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type IncomingMedia = {
  mediaType: 'image' | 'gif' | 'video' | 'sticker' | 'audio' | 'document' | 'location' | 'contact'
  mediaMime: string
  extension: string
  thumbnailUrl: string | null
  thumbnailPath: string | null
  /** Media yang bisa dilihat AI (gambar/video). Sisanya cuma dicatat apa adanya. */
  visual: boolean
  /** Keterangan jujur untuk media yang isinya tidak bisa dibaca sistem. */
  note: string
}

const VISUAL_MEDIA = new Set(['image', 'gif', 'video', 'sticker'])

type PendingMessage = {
  queuedAt?: number
  id: string
  text: string
  message: WAMessage
  media: Awaited<ReturnType<WhatsappListen['prepareMedia']>>
  mediaDownload: Promise<string | null>
}

/**
 * Pelanggan sering mengirim beberapa pesan beruntun (foto lalu "ini berapa").
 * Pesan dikumpulkan sebentar lalu dijawab sebagai SATU giliran, bukan satu per satu.
 */
const FALLBACK_TURN_WINDOW_MS = Number(process.env.AI_TURN_WINDOW_MS || 6000)
const SWEEP_INTERVAL_MS = Number(process.env.AI_SWEEP_INTERVAL_MS || 300_000)
const LEAN_SYNC_INTERVAL_MS = 30 * 60_000

export default class WhatsappListen extends BaseCommand {
  private sessionScope?: WorkspaceScope
  private tasks = new Set<Promise<unknown>>()
  private track<T>(work: () => Promise<T>): Promise<T> {
    const task = work()
    this.tasks.add(task)
    task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task)
    )
    return task
  }
  private pendingTurns = new Map<string, { items: PendingMessage[]; timer: NodeJS.Timeout }>()
  private chatLocks = new Map<string, Promise<unknown>>()
  private sweeping = false
  private sweepTimer?: NodeJS.Timeout
  private leanSyncTimer?: NodeJS.Timeout
  private recapTimer?: NodeJS.Timeout
  private recapRunning = false
  private goalSweepRunning = false
  private lastGoalSweepAt = 0
  private evaluationRunning = false
  private lastEvaluationAt = 0

  static commandName = 'whatsapp:listen'
  static description = 'Menjalankan koneksi Baileys dan balasan AI'
  static options: CommandOptions = { startApp: true, staysAlive: true }

  @flags.boolean({ description: 'Tampilkan log Baileys' })
  declare verbose: boolean

  @flags.number({ description: 'Nomor tambahan (line ≥ 2); kosong = nomor utama' })
  declare line?: number

  private lineChildren = new Map<number, ChildProcess>()
  private lastLineSuperviseAt = 0
  private get primary() {
    return currentLine() === 1
  }

  private socket?: WASocket
  private connecting = false
  // Gagal konek berturut-turut: jeda bertahap + coba variasi versi/perangkat.
  private connectFailures = 0
  private retryAt = 0
  private connectVariant = 0
  private stopping = false
  private lastProfileRefreshAt = 0
  private orderGroupRunning = false
  private lastOrderGroupAt = 0
  private lastPaymentWaitAt = 0
  private lastOrderGroupSyncAt = 0
  private lastOrderGroupRecoveryAt = 0
  private shippingRunning = false
  private lastShippingAt = 0
  private socketOpen = false
  private receivedPending = false
  private syncReadyAt = 0
  private ingesting = 0
  private ingestion: Promise<void> = Promise.resolve()
  private reviewing = false
  private retryingSync = false
  private retryingAnalysis = false
  private lastAnalysisRetryAt = 0
  private lastAnalysisRecoveryAt = 0
  private lastSyncRetryAt = 0
  private syncRetryFallback = new Map<string, { message: WAMessage; attempts: number }>()

  private readyForAi() {
    return (
      this.socketOpen && this.receivedPending && !this.ingesting && Date.now() >= this.syncReadyAt
    )
  }

  async run() {
    setCurrentLine(Number(this.line) || 1)
    if (!this.primary) return this.runLine()
    const stopDiagnostics = await startWorkerDiagnostics(
      this.app.makePath('storage', 'diagnostics')
    )
    this.app.terminating(stopDiagnostics)
    await ensureWorkspaceRegistry()
    const initialScope = await activeWorkspace()
    if (initialScope.id) this.sessionScope = initialScope
    const workerId = randomUUID()
    await startWorkerHeartbeat(workerId)
    await registerWorkspaceWorker(workerId)
    const heartbeatTimer = setInterval(() => {
      void touchWorkerHeartbeat(workerId).catch(() => {})
    }, 5000)
    this.app.terminating(async () => {
      this.stopping = true
      clearInterval(heartbeatTimer)
      await stopWorkerHeartbeat(workerId).catch(() => {})
      if (this.sweepTimer) clearInterval(this.sweepTimer)
      if (this.leanSyncTimer) clearInterval(this.leanSyncTimer)
      if (this.recapTimer) clearInterval(this.recapTimer)
      for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer)
      this.pendingTurns.clear()
      for (const child of this.lineChildren.values()) child.kill('SIGTERM')
      this.socket?.end(undefined)
    })
    this.logger.info(`Listener WhatsApp aktif (pid=${process.pid}, build=${process.cwd()})`)
    while (!this.stopping) {
      try {
        const cleanupState = await workspaceState()
        if (cleanupState.cleanup_workspace_id) {
          const cleanupScope = await cleanupWorkspace()
          if (cleanupScope.id === Number(cleanupState.cleanup_workspace_id)) {
            // End only the transport, retaining Baileys credentials and all account settings.
            const socket = this.socket
            this.socket = undefined
            this.socketOpen = false
            this.receivedPending = false
            for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer)
            this.pendingTurns.clear()
            socket?.end(undefined)
            await Promise.allSettled([...this.chatLocks.values(), this.ingestion])
            while (this.tasks.size) await Promise.allSettled([...this.tasks])
            for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer)
            this.pendingTurns.clear()
            this.chatLocks.clear()
            this.syncRetryFallback.clear()
            this.ingestion = Promise.resolve()
            try {
              await inWorkspace(cleanupScope, () => executeChatCleanup())
            } catch (error) {
              await inWorkspace(cleanupScope, async () => {
                await db
                  .from('whatsapp_chat_cleanup')
                  .where('id', 1)
                  .whereNot('status', 'completed')
                  .update({ status: 'retrying', updated_at: new Date() })
              })
              await wait(10000)
              throw error
            }
            this.sessionScope = await activeWorkspace()
          }
          await wait(1500)
          continue
        }
        const connection = await db.from('whatsapp_connection').where('id', 1).firstOrFail()
        if (!connection.desired_connected && (this.socket || (await workspaceState()).session_id))
          await this.disconnect()
        if (connection.desired_connected && !this.socket && !this.connecting && !this.tasks.size)
          await this.connect()
        if (!this.sessionScope && Date.now() - this.lastIdleScopeAt >= 30_000) {
          // Nomor utama belum terhubung: tugas workspace tetap jalan untuk nomor tambahan.
          this.lastIdleScopeAt = Date.now()
          const active = await activeWorkspace()
          this.idleScope = active.id ? active : undefined
          if (this.idleScope) this.ensureWorkspaceTimers()
        }
        if (Date.now() - this.lastLineSuperviseAt >= 5000) {
          this.lastLineSuperviseAt = Date.now()
          await this.superviseLines().catch((error) =>
            this.logger.error(`Nomor tambahan: ${String(error)}`)
          )
        }
        const scope = this.sessionScope
        if (scope && (await workspaceState()).active_id === scope.id)
          await inWorkspace(scope, async () => {
            if (!this.shippingRunning && Date.now() - this.lastShippingAt >= 5000) {
              this.lastShippingAt = Date.now()
              this.shippingRunning = true
              void this.track(() => this.processShippingConversation())
                .catch(() => {
                  this.logger.error('Antrean pengiriman akan diperiksa ulang.')
                })
                .finally(() => {
                  this.shippingRunning = false
                })
            }
            if (
              this.socketOpen &&
              !this.orderGroupRunning &&
              Date.now() - this.lastOrderGroupAt > 3000
            ) {
              this.lastOrderGroupAt = Date.now()
              this.orderGroupRunning = true
              void this.track(() => this.processOrderGroups())
                .catch(() => {})
                .finally(() => {
                  this.orderGroupRunning = false
                })
            }
            if (
              this.socketOpen &&
              !this.retryingSync &&
              Date.now() - this.lastSyncRetryAt >= 1000
            ) {
              this.lastSyncRetryAt = Date.now()
              void this.track(() => this.retrySyncMessages())
            }
            if (!this.evaluationRunning && Date.now() - this.lastEvaluationAt >= 30_000) {
              this.lastEvaluationAt = Date.now()
              void this.track(() => this.evaluateNextConversation())
            }
            if (this.socket && this.readyForAi()) {
              await this.flushOutbox()
              await this.flushReactions()
              await flushWorkspaceReads(this.socket, currentLine()).catch(() => {
                this.logger.error('Tanda baca WhatsApp akan dicoba kembali.')
              })
              if (Date.now() - this.lastPaymentWaitAt >= 10_000) {
                this.lastPaymentWaitAt = Date.now()
                await this.sendPaymentWaitNotice()
              }
              void this.track(() => this.consumeAiReviews()).catch((error) =>
                this.logger.error(String(error))
              )
              if (!this.retryingAnalysis && Date.now() - this.lastAnalysisRetryAt >= 5000) {
                this.lastAnalysisRetryAt = Date.now()
                void this.track(() => this.consumeAnalysisRetries()).catch(() =>
                  this.logger.error('Antrean pemulihan analisis akan diperiksa kembali.')
                )
              }
              if (Date.now() - this.lastGoalSweepAt >= 60_000 && !this.goalSweepRunning) {
                this.lastGoalSweepAt = Date.now()
                void this.track(() => this.sweepConversationGoals())
              }
              if (Date.now() - this.lastProfileRefreshAt > 10 * 60 * 1000) {
                this.lastProfileRefreshAt = Date.now()
                this.track(() => this.refreshContactProfiles(true)).catch(() => {})
              }
            }
          })
      } catch (error) {
        this.logger.error(error instanceof Error ? error.message : String(error))
      }
      await wait(1500)
    }
  }

  /** Room dimiliki nomor yang terakhir menerima pesan pelanggan (NULL = nomor utama). */
  private async ownsRoom(jid: string) {
    if (!jid) return false
    const contact = await db.from('whatsapp_contacts').where('jid', jid).select('line_id').first()
    return lineOf(contact?.line_id) === currentLine()
  }

  /** Pesan pelanggan masuk lewat nomor ini → balasan (AI/CS) keluar dari nomor ini. */
  private async claimRoom(jid: string) {
    await db.rawQuery(
      `INSERT INTO whatsapp_contacts (jid, line_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE line_id = VALUES(line_id)`,
      [jid, this.primary ? null : currentLine(), new Date()]
    )
  }

  /**
   * Nomor tambahan memakai workspace aktif (inbox, AI, pengaturan). Tanpa nomor utama pun
   * boleh: workspace nomor ini yang diaktifkan.
   */
  private async lineWorkspace(phone: string | null) {
    const connection = await db.from('whatsapp_connection').where('id', 1).first()
    if (phone && connection?.desired_connected && String(connection.phone || '') === phone)
      throw new Error('Nomor ini sudah menjadi nomor utama.')
    const other = (await listLines()).find(
      (line) => line.id !== currentLine() && line.phone === phone && line.desired_connected
    )
    if (other) throw new Error('Nomor ini sudah terhubung sebagai nomor tambahan lain.')
    const scope = await activeWorkspace()
    return scope.id ? scope : adoptWorkspace(phone)
  }

  /** Nomor tambahan diputus: logout, hapus sesi & baris line, lalu proses selesai. */
  /**
   * Tutup soket untuk dihapus: logout hanya bila benar-benar terhubung (maks 5 detik);
   * soket yang masih menampilkan QR langsung diakhiri (logout di sana bisa menggantung).
   */
  private async closeSocket(socket: WASocket | undefined, wasOpen: boolean) {
    if (!socket) return
    if (wasOpen)
      await Promise.race([socket.logout().catch(() => {}), wait(5000)]).catch(() => {})
    try {
      socket.end(undefined)
    } catch {
      /* sudah tertutup */
    }
  }

  private async removeLine() {
    const line = currentLine()
    const socket = this.socket
    const wasOpen = this.socketOpen
    this.socket = undefined
    this.socketOpen = false
    await this.closeSocket(socket, wasOpen)
    await db.transaction(async (trx) => {
      await clearAuthRows(trx, line)
      await trx.from('whatsapp_lines').where('id', line).delete()
    })
    this.stopping = true
  }

  /** Worker utama menyalakan satu proses per nomor tambahan dan menghidupkannya lagi bila mati. */
  private lineRemovalSeen = new Map<number, number>()
  private async superviseLines() {
    let lines = await listLines()
    // Nomor yang diminta dihapus tapi prosesnya macet > 20 detik → dihapus paksa.
    for (const line of lines) {
      if (line.status !== 'disconnecting') {
        this.lineRemovalSeen.delete(line.id)
        continue
      }
      const since = this.lineRemovalSeen.get(line.id) ?? Date.now()
      this.lineRemovalSeen.set(line.id, since)
      if (Date.now() - since > 20_000) {
        this.lineChildren.get(line.id)?.kill('SIGKILL')
        await removeLineNow(line.id).catch(() => {})
        this.lineRemovalSeen.delete(line.id)
        this.logger.info(`Nomor tambahan #${line.id}: dihapus paksa.`)
      }
    }
    lines = await listLines()
    const wanted = new Set(lines.filter((line) => line.desired_connected || line.status === 'disconnecting').map((line) => line.id))
    for (const [id, child] of this.lineChildren) {
      if (!wanted.has(id) && child.exitCode === null) child.kill('SIGTERM')
    }
    for (const id of wanted) {
      const running = this.lineChildren.get(id)
      if (running && running.exitCode === null && running.signalCode === null) continue
      const child = spawn(process.execPath, [process.argv[1], 'whatsapp:listen', `--line=${id}`], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      child.on('exit', () => {
        if (this.lineChildren.get(id) === child) this.lineChildren.delete(id)
      })
      this.lineChildren.set(id, child)
      this.logger.info(`Nomor tambahan #${id}: proses dimulai (pid ${child.pid}).`)
    }
  }

  /**
   * Proses nomor tambahan: satu soket WhatsApp di workspace yang sama dengan nomor
   * utama. Hanya menerima/mengirim & menjawab room miliknya; tugas lain (grup order,
   * pengiriman, rekap, katalog) tetap di nomor utama.
   */
  private async runLine() {
    const line = currentLine()
    this.logger.info(`Nomor tambahan #${line} aktif (pid=${process.pid}).`)
    this.app.terminating(async () => {
      this.stopping = true
      if (this.sweepTimer) clearInterval(this.sweepTimer)
      for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer)
      this.socket?.end(undefined)
    })
    process.on('SIGTERM', () => {
      this.stopping = true
      this.socket?.end(undefined)
      setTimeout(() => process.exit(0), 3000).unref()
    })
    while (!this.stopping) {
      try {
        const row = await readLine(line)
        if (!row) break
        await updateLine(line, { heartbeat_at: new Date() })
        if (!row.desired_connected) {
          await this.removeLine()
          break
        }
        // Setelah gagal (mis. nomor sama dengan nomor utama) tunggu sampai diputus/ditambah ulang.
        if (!this.socket && !this.connecting && !this.tasks.size && row.status !== 'error')
          await this.connect()
        const state = await workspaceState()
        const scope = this.sessionScope
        if (scope && state.active_id === scope.id && !state.cleanup_workspace_id)
          await inWorkspace(scope, async () => {
            if (!this.socket || !this.readyForAi()) return
            await this.flushOutbox()
            await this.flushReactions()
            await flushWorkspaceReads(this.socket, line).catch(() => {})
            if (Date.now() - this.lastPaymentWaitAt >= 10_000) {
              this.lastPaymentWaitAt = Date.now()
              await this.sendPaymentWaitNotice()
            }
            void this.track(() => this.consumeAiReviews()).catch((error) =>
              this.logger.error(String(error))
            )
            if (Date.now() - this.lastGoalSweepAt >= 60_000 && !this.goalSweepRunning) {
              this.lastGoalSweepAt = Date.now()
              void this.track(() => this.sweepConversationGoals())
            }
          })
      } catch (error) {
        this.logger.error(`Nomor #${line}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await wait(1500)
    }
    process.exit(0)
  }

  private async processShippingConversation() {
    if (!this.socket || !this.readyForAi() || this.stopping) return
    const settings = await readSettings(false)
    if (!isAiWorking(settings) || !settings.hasSkill) return
    const candidate = await nextShipmentConversation()
    if (!candidate || this.chatLocks.has(candidate.jid) || this.pendingTurns.has(candidate.jid))
      return
    const jid = String(candidate.jid)
    const task = (async () => {
      await this.setActivity(jid, 'thinking')
      try {
        await processNextShipment(undefined, undefined, jid)
      } finally {
        await this.setActivity(jid, null).catch(() => {})
      }
    })()
    this.chatLocks.set(jid, task)
    try {
      await task
    } finally {
      if (this.chatLocks.get(jid) === task) this.chatLocks.delete(jid)
    }
  }

  private async processOrderGroups() {
    const socket = this.socket
    if (!socket || !this.socketOpen || this.stopping) return
    const routing = await orderRouting()
    if (
      Date.now() - this.lastOrderGroupSyncAt > 60_000 &&
      (routing.refreshRequested ||
        !routing.groupsUpdatedAt ||
        Date.now() - new Date(routing.groupsUpdatedAt).getTime() > 600_000)
    ) {
      this.lastOrderGroupSyncAt = Date.now()
      try {
        await cacheOrderGroups(Object.values(await socket.groupFetchAllParticipating()))
      } catch {
        /* Retry discovery later; do not block existing jobs. */
      }
    }
    if (Date.now() - this.lastOrderGroupRecoveryAt > 30_000) {
      this.lastOrderGroupRecoveryAt = Date.now()
      try {
        await recoverOrderGroupQueue()
      } catch {
        this.logger.error('Antrean order grup yang terlewat akan diperiksa ulang.')
      }
    }
    await this.deliverLeanGroupOrders(socket)
    await this.deliverBeta3GroupOrders(socket)
    await deliverNextOrderGroup({
      validateGroup: async (jid) => {
        if (this.stopping || !this.socketOpen || this.socket !== socket)
          throw new Error('Disconnected')
        const metadata = await socket.groupMetadata(jid)
        const self = [socket.user?.id, socket.user?.lid]
          .filter(Boolean)
          .map((id) => jidNormalizedUser(id!))
        const participant = metadata.participants.find((p) =>
          [p.id, p.lid, p.phoneNumber].some((id) => id && self.includes(jidNormalizedUser(id)))
        )
        if (
          !participant ||
          metadata.isCommunity ||
          (metadata.announce &&
            !participant.admin &&
            !participant.isAdmin &&
            !participant.isSuperAdmin)
        )
          throw new Error('Group unavailable')
      },
      send: async (jid, payload, messageId) => {
        if (this.stopping || !this.socketOpen || this.socket !== socket)
          throw new Error('Disconnected')
        const sent = await socket.sendMessage(jid, payload, { messageId })
        return sent?.key.id
      },
    })
  }

  /** Beta 2: order lean yang sudah lunas dikirim ke grup produksi default (teks + foto produk). */
  private async deliverLeanGroupOrders(socket: WASocket) {
    const order = await nextLeanGroupOrder().catch(() => null)
    if (!order) return
    const groupJid = String(order.group_jid)
    try {
      if (this.stopping || !this.socketOpen || this.socket !== socket) return
      const text = renderGroupOrderMessage(order)
      let image: { bytes: Buffer; caption: string } | null = null
      try {
        const digest = await catalogDigest()
        const firstLine = String(order.spec || order.items || '').split('\n')[0] || ''
        const variant = findCatalogVariant(
          digest.rows,
          firstLine.replace(/^\d+[.)]\s*/, '').split(/[,|]/)[0]
        )
        if (variant?.photoUrl) {
          const bytes = await downloadOutgoingImage(variant.photoUrl)
          image = { bytes, caption: text }
        }
      } catch {
        image = null
      }
      const sent = await socket.sendMessage(
        groupJid,
        image ? { image: image.bytes, caption: image.caption, mimetype: 'image/jpeg' } : { text }
      )
      if (!sent?.key.id) throw new Error('Pengiriman ke grup belum dikonfirmasi.')
      await finishLeanGroupOrder(Number(order.id))
    } catch (error) {
      await finishLeanGroupOrder(
        Number(order.id),
        error instanceof Error ? error.message : String(error)
      )
      this.logger.error(
        `Order lean #${order.id} gagal ke grup: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  /** Beta 3: order beta3 yang sudah lunas dikirim ke grup produksi default (teks + foto produk). */
  private async deliverBeta3GroupOrders(socket: WASocket) {
    const order = await beta3.nextLeanGroupOrder().catch(() => null)
    if (!order) return
    const groupJid = String(order.group_jid)
    try {
      if (this.stopping || !this.socketOpen || this.socket !== socket) return
      const text = beta3.renderGroupOrderMessage(order)
      let image: { bytes: Buffer; caption: string } | null = null
      try {
        const digest = await beta3.catalogDigest()
        const firstLine = String(order.spec || order.items || '').split('\n')[0] || ''
        const variant = beta3.findCatalogVariant(
          digest.rows,
          firstLine.replace(/^\d+[.)]\s*/, '').split(/[,|]/)[0]
        )
        if (variant?.photoUrl) {
          const bytes = await downloadOutgoingImage(variant.photoUrl)
          image = { bytes, caption: text }
        }
      } catch {
        image = null
      }
      const sent = await socket.sendMessage(
        groupJid,
        image ? { image: image.bytes, caption: image.caption, mimetype: 'image/jpeg' } : { text }
      )
      if (!sent?.key.id) throw new Error('Pengiriman ke grup belum dikonfirmasi.')
      // Gambar referensi per bagian, apa adanya: "Model kerah seperti ini".
      for (const ref of await beta3Refs.refsForOrder(Number(order.id)).catch(() => [])) {
        if (this.stopping || this.socket !== socket) break
        try {
          await socket.sendMessage(groupJid, {
            image: await beta3Refs.loadImage(ref.image_url),
            caption: beta3Refs.refCaption(ref),
          })
        } catch (error) {
          this.logger.error(
            `Referensi #${ref.id} order #${order.id} gagal ke grup: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      await beta3.finishLeanGroupOrder(Number(order.id))
    } catch (error) {
      await beta3.finishLeanGroupOrder(
        Number(order.id),
        error instanceof Error ? error.message : String(error)
      )
      this.logger.error(
        `Order lean #${order.id} gagal ke grup: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private async evaluateNextConversation() {
    if (this.stopping || this.evaluationRunning || this.pendingTurns.size || this.chatLocks.size)
      return
    this.evaluationRunning = true
    try {
      const settings = await readSettings(true)
      if (settings.leanMode || settings.beta3Mode) return // Beta 2/3: evaluasi/learning per chat dimatikan; contoh CS yang dipakai.
      const jid = await nextEvaluationRoom(settings, [
        ...this.pendingTurns.keys(),
        ...this.chatLocks.keys(),
      ])
      if (jid && !this.stopping) await evaluateConversation(jid, settings)
      if (!this.stopping && !this.pendingTurns.size && !this.chatLocks.size)
        await runConversationLearning(settings)
    } catch {
      this.logger.error('Evaluasi percakapan belum dapat dijalankan.')
    } finally {
      this.evaluationRunning = false
    }
  }

  private async setState(values: Record<string, unknown>) {
    if (!this.primary) {
      const { worker_id: _w, ...rest } = values
      await updateLine(currentLine(), rest)
      return
    }
    await db
      .from('whatsapp_connection')
      .where('id', 1)
      .update({ ...values, updated_at: new Date() })
  }

  private async connect() {
    if (Date.now() < this.retryAt) return
    this.connecting = true
    this.socketOpen = false
    this.receivedPending = false
    await this.setState({ status: 'connecting', qr_data_url: null, last_error: null })
    try {
      const authVersion = (await workspaceState()).auth_version
      const auth = await databaseAuthState(currentLine())
      // Sebelum terhubung, error Baileys dicatat agar penyebab gagal konek terlihat di log.
      const logger = pino({ level: this.verbose ? 'info' : 'error' })
      // Bila gagal berulang: bergantian versi WA Web terbaru / bawaan Baileys.
      const variant = this.connectVariant % 2
      const version = variant === 0 ? await latestWaVersion() : undefined
      const registered = Boolean(auth.state.creds.registered || auth.state.creds.me)
      const socket = workspaceSocket(
        makeWASocket({
          ...(version ? { version } : {}),
          auth: {
            creds: auth.state.creds,
            keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
          },
          logger,
          markOnlineOnConnect: false,
          // Perangkat "Desktop" kini ditolak WhatsApp sebelum QR muncul (kode 428) → pakai Chrome.
          browser: Browsers.macOS('Chrome'),
          syncFullHistory: true,
          shouldSyncHistoryMessage: () => true,
          generateHighQualityLinkPreview: false,
        })
      )
      this.socket = socket
      let resolveScope: (scope: WorkspaceScope | null) => void = () => {}
      const ready = new Promise<WorkspaceScope | null>((resolve) => {
        resolveScope = resolve
      })
      let connectedScope: WorkspaceScope | undefined
      let opened = false
      const onScoped = <K extends keyof BaileysEventMap>(
        name: K,
        handler: (event: BaileysEventMap[K]) => Promise<void>
      ) => {
        socket.ev.on(name, (event) => {
          void ready
            .then((scope) => {
              if (!scope || this.socket !== socket) return
              return inWorkspace(scope, () => this.track(() => handler(event)))
            })
            .catch((error) => this.logger.error(String(error)))
        })
      }
      socket.ev.on('creds.update', auth.saveCreds)
      socket.ev.on(
        'connection.update',
        async ({ connection, lastDisconnect, qr, receivedPendingNotifications }) => {
          if (this.socket !== socket) return
          if (receivedPendingNotifications) {
            this.receivedPending = true
            this.syncReadyAt = Date.now() + 2000
            if (connectedScope)
              await inWorkspace(connectedScope, async () => {
                const settings = await readSettings()
                if (settings.sweepEnabled)
                  await requestRecentAiReviews('reconnected', settings.sweepMaxAgeHours)
              })
          }
          if (qr) {
            this.connectFailures = 0
            this.retryAt = 0
          }
          if (qr)
            await this.setState({
              status: 'qr',
              qr_data_url: await QRCode.toDataURL(qr, { width: 320, margin: 1 }),
            })
          if (connection === 'open') {
            const phone = socket.user?.id?.split(':')[0]?.split('@')[0] || null
            try {
              connectedScope = this.primary
                ? await activateWorkspace(phone, authVersion)
                : await this.lineWorkspace(phone)
            } catch (error) {
              this.logger.error(
                `WhatsApp terhubung tapi gagal diaktifkan: ${error instanceof Error ? error.message : String(error)}`
              )
              if (!this.primary)
                await this.setState({
                  status: 'error',
                  last_error: (error instanceof Error ? error.message : String(error)).slice(0, 290),
                })
              resolveScope(null)
              socket.end(undefined)
              this.socket = undefined
              return
            }
            if (this.socket !== socket) {
              resolveScope(null)
              return
            }
            this.sessionScope = connectedScope
            this.socketOpen = true
            opened = true
            this.connectFailures = 0
            this.retryAt = 0
            if (!this.verbose) logger.level = 'silent'
            resolveScope(connectedScope)
            await this.setState({ status: 'connected', phone, qr_data_url: null, last_error: null })
            if (this.receivedPending)
              await inWorkspace(connectedScope, async () => {
                const settings = await readSettings()
                if (settings.sweepEnabled)
                  await requestRecentAiReviews('reconnected', settings.sweepMaxAgeHours)
              })
            this.lastProfileRefreshAt = Date.now()
            if (this.primary)
              inWorkspace(connectedScope, () =>
                this.track(() => this.refreshContactProfiles(true))
              ).catch(() => {})
          }
          if (connection === 'close') {
            resolveScope(null)
            for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer)
            this.pendingTurns.clear()
            this.socketOpen = false
            this.receivedPending = false
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
            const reason = String((lastDisconnect?.error as any)?.message || '').slice(0, 200)
            const wasOpen = opened
            // 408 = QR kedaluwarsa tanpa di-scan: bukan kegagalan, langsung buat QR baru.
            if (!wasOpen && statusCode !== DisconnectReason.loggedOut && statusCode !== 408) {
              this.connectFailures++
              if (this.connectFailures % 2 === 0) this.connectVariant++
              this.retryAt = Date.now() + Math.min(60_000, 3000 * 2 ** Math.min(this.connectFailures - 1, 5))
            }
            this.logger.error(
              `Koneksi${this.primary ? '' : ` #${currentLine()}`} tertutup (kode ${statusCode ?? '-'}${reason ? `: ${reason}` : ''}; ${registered ? 'sesi lama' : 'sesi baru'}, percobaan ${this.connectFailures}, varian ${variant}).`
            )
            this.socket = undefined
            if (statusCode === DisconnectReason.loggedOut && !this.primary) {
              // Nomor tambahan dilepas dari HP: hapus sesinya, baris line ikut dihapus.
              await this.removeLine()
            } else if (
              this.primary &&
              registered &&
              !wasOpen &&
              this.connectFailures >= 8
            ) {
              // Sesi lama tidak bisa dipakai lagi → buang sesi, tampilkan QR baru otomatis.
              this.logger.error('Sesi WhatsApp lama gagal terus; sesi direset agar QR baru muncul.')
              this.connectFailures = 0
              this.retryAt = 0
              await archiveWorkspace()
              await this.disconnect()
              await this.setState({
                desired_connected: true,
                status: 'connecting',
                phone: null,
                qr_data_url: null,
                last_error: 'Sesi lama direset.',
              })
            } else if (statusCode === DisconnectReason.loggedOut) {
              await archiveWorkspace()
              await this.disconnect()
              await this.setState({
                desired_connected: false,
                status: 'disconnected',
                phone: null,
                qr_data_url: null,
              })
            } else {
              await this.setState({
                status: 'disconnected',
                qr_data_url: null,
                last_error: `Koneksi terputus${statusCode ? ` (kode ${statusCode})` : ''}.`,
              })
            }
          }
        }
      )
      if (!this.sweepTimer) {
        this.sweepTimer = setInterval(() => {
          if (this.sessionScope && this.socketOpen)
            void inWorkspace(this.sessionScope, () => this.track(() => this.sweepUnanswered()))
        }, SWEEP_INTERVAL_MS)
      }
      this.ensureWorkspaceTimers()
      onScoped('messages.upsert', async ({ messages, type }) => {
        if (this.socket !== socket) return
        // A live notification stays live while another batch is being stored.
        await this.ingestMessages(messages, type !== 'notify' || !this.receivedPending)
      })
      onScoped('messaging-history.set', async ({ messages, contacts, lidPnMappings }) => {
        if (this.socket !== socket) return
        const ingestion = this.ingestMessages(messages, true)
        // Pasangan LID ↔ nomor dari riwayat: room LID jadi punya nomor (dan nama kontaknya).
        for (const mapping of lidPnMappings || [])
          if (mapping?.lid && mapping?.pn)
            await this.refreshCustomerPhone(mapping.lid, mapping.pn).catch(() => {})
        for (const contact of contacts) {
          await this.rememberContactIdentity(contact)
          for (const jid of this.contactAliases(contact))
            await this.rememberContact(
              jid,
              contact.name || contact.notify || contact.verifiedName || '',
              false,
              jid === contact.id ? contact.imgUrl : undefined
            ).catch(() => {})
        }
        await ingestion
      })
      onScoped('messages.update', async (updates) => {
        for (const { key, update } of updates) {
          if (!key.id || update.status === undefined) continue
          await db
            .from('whatsapp_messages')
            .where('message_id', key.id)
            .update({ status: this.deliveryStatus(Number(update.status)) })
        }
      })
      onScoped('message-receipt.update', async (updates) => {
        for (const { key, receipt } of updates) {
          if (!key.id) continue
          const status = receipt.readTimestamp
            ? 'read'
            : receipt.receiptTimestamp
              ? 'delivered'
              : ''
          if (status)
            await db.from('whatsapp_messages').where('message_id', key.id).update({ status })
        }
      })
      onScoped('messages.reaction', async (updates) => {
        for (const { key, reaction } of updates) await this.onReaction(key, reaction)
      })
      onScoped('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
          await this.rememberContactIdentity(contact)
          for (const jid of this.contactAliases(contact))
            await this.rememberContact(
              jid,
              contact.name || contact.notify || contact.verifiedName || '',
              false,
              jid === contact.id ? contact.imgUrl : undefined
            )
        }
      })
      onScoped('contacts.update', async (contacts) => {
        for (const contact of contacts) {
          await this.rememberContactIdentity(contact)
          for (const jid of this.contactAliases(contact))
            await this.rememberContact(
              jid,
              contact.name || contact.notify || contact.verifiedName || '',
              jid === contact.id,
              jid === contact.id ? contact.imgUrl : undefined
            )
        }
      })
      onScoped('lid-mapping.update', async ({ lid, pn }) => {
        await this.refreshCustomerPhone(lid, pn)
      })
      onScoped('presence.update', async ({ id, presences }) => {
        const typing = Object.values(presences).some((presence) =>
          ['composing', 'recording'].includes(String(presence.lastKnownPresence))
        )
        await this.setActivity(id, typing ? 'typing' : null)
      })
    } catch (error) {
      this.socket = undefined
      this.logger.error(`Gagal memulai koneksi nomor: ${error instanceof Error ? error.message : String(error)}`)
      await this.setState({
        status: 'error',
        last_error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.connecting = false
    }
  }

  private textOf(message: WAMessage) {
    const content = normalizeMessageContent(message.message)
    return String(
      content?.conversation ||
        content?.extendedTextMessage?.text ||
        content?.imageMessage?.caption ||
        content?.videoMessage?.caption ||
        content?.documentMessage?.caption ||
        content?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        ''
    ).trim()
  }

  private messageDate(message: WAMessage) {
    const milliseconds = Number(message.messageTimestamp) * 1000
    return Number.isFinite(milliseconds) && milliseconds > 0
      ? new Date(Math.min(milliseconds, Date.now()))
      : new Date()
  }

  private async ingestMessages(messages: WAMessage[], replay: boolean) {
    messages = await filterDeletedChatHistory(messages, replay)
    // Fix arrival time once, including retries of messages without a WA timestamp.
    messages = messages.map((message) => ({
      ...message,
      messageTimestamp: Math.floor(this.messageDate(message).getTime() / 1000),
    }))
    this.ingesting++
    if (replay) this.syncReadyAt = Date.now() + 2000
    const task = this.ingestion
      .catch(() => {})
      .then(async () => {
        const ordered = [...messages].sort(
          (a, b) => this.messageDate(a).getTime() - this.messageDate(b).getTime()
        )
        for (const message of ordered) {
          try {
            if (replay) await this.storeSyncedMessage(message)
            else await this.onMessage(message)
          } catch {
            await this.retainSyncFailure(message, 1)
          }
        }
      })
    this.ingestion = task
    try {
      await task
    } catch (error) {
      this.logger.error(`Sinkronisasi: ${String(error)}`)
    } finally {
      this.ingesting--
      if (replay) this.syncReadyAt = Date.now() + 2000
    }
  }

  private async retainSyncFailure(message: WAMessage, attempts: number) {
    this.logger.error(`Sinkronisasi pesan tertunda (percobaan ${attempts}/5).`)
    try {
      await saveSyncRetry(message, attempts)
    } catch {
      // Retain in memory during DB outages, then persist as soon as DB recovers.
      this.syncRetryFallback ||= new Map()
      if (message.key.id) this.syncRetryFallback.set(message.key.id, { message, attempts })
    }
  }

  private async retrySyncMessages() {
    if (this.retryingSync || this.stopping) return
    this.retryingSync = true
    try {
      for (const [id, pending] of this.syncRetryFallback || []) {
        await saveSyncRetry(pending.message, pending.attempts)
        this.syncRetryFallback.delete(id)
      }
      for (const pending of await dueSyncRetries()) {
        if (this.stopping) break
        // Reuse the same ingestion lock. Retry storage, never an uncertain outgoing send.
        this.ingesting++
        const task = this.ingestion
          .catch(() => {})
          .then(async () => {
            try {
              const existing = await db
                .from('whatsapp_messages')
                .where('message_id', pending.message.key.id!)
                .first()
              if (existing) await this.recoverStoredSyncMessage(existing)
              else await this.storeSyncedMessage(pending.message)
              await finishSyncRetry(pending.message.key.id!)
            } catch {
              await this.retainSyncFailure(pending.message, pending.attempts + 1)
            }
          })
        this.ingestion = task
        try {
          await task
        } finally {
          this.ingesting--
        }
      }
    } catch {
      this.logger.error('Antrean sinkronisasi akan diperiksa ulang.')
    } finally {
      this.retryingSync = false
    }
  }

  private async recoverStoredSyncMessage(message: Record<string, any>) {
    const jid = String(message.jid)
    if (this.pendingTurns?.has(jid) || this.chatLocks?.has(jid)) return
    const latest = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .whereNotIn('status', ['queued', 'failed'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first()
    if (latest?.message_id !== message.message_id || message.sender_type === 'ai') return
    if (await alreadyAnalyzedMessage(jid, String(message.message_id))) return
    if (await failedGoalMessage(jid, String(message.message_id))) return
    if (message.direction === 'out') await resumeAiAfterHumanReply(jid)
    else {
      await invalidateConversationGoal(jid)
      await requestAiReview(jid, 'reconnected')
    }
  }

  /** History/offline events are persisted first, never answered one-by-one. */
  private async storeSyncedMessage(message: WAMessage) {
    const id = message.key.id
    const jid = message.key.remoteJid
    if (!id || !jid || !/@(?:s\.whatsapp\.net|lid)$/.test(jid)) return
    await this.refreshCustomerPhone(jid, message.key.remoteJidAlt)
    if (message.key.fromMe && isTrackedOutgoingMessage(jid, id)) return
    if (await db.from('whatsapp_messages').where('message_id', id).first()) return
    const text = this.textOf(message)
    const media = await this.prepareMedia(message)
    if (!text && !media) return
    const latest = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first()
    const createdAt = this.messageDate(message)
    // Riwayat lama: cukup teks + thumbnail. Media lama umumnya sudah kedaluwarsa di
    // server WhatsApp dan mengunduhnya satu per satu membuat sinkron sangat lambat.
    const downloadable = Boolean(media?.visual) && Date.now() - createdAt.getTime() < 3 * 86_400_000
    await db.table('whatsapp_messages').insert({
      ...lineColumns(),
      message_id: id,
      jid,
      contact_name: message.pushName || null,
      direction: message.key.fromMe ? 'out' : 'in',
      sender_type: message.key.fromMe ? 'owner' : 'customer',
      body: text,
      media_type: media?.mediaType || null,
      media_url: null,
      thumbnail_url: media?.thumbnailUrl || null,
      media_mime: media?.mediaMime || null,
      media_status: media?.visual ? (downloadable ? 'downloading' : 'failed') : null,
      reply_to_message_id: this.replyIdOf(message) || null,
      status: message.key.fromMe ? 'sent' : 'received',
      created_at: createdAt,
    })
    void this.rememberContact(jid, message.pushName || '').catch(() => {})
    // Chat/thumbnail is already available; downloads must not block the next message.
    const mediaDownload = downloadable && media
      ? this.downloadMedia(message, media).catch(async () => {
          await this.retainSyncFailure(message, 1)
          return null
        })
      : null
    // Older backfill must not undo a later handoff or reopen a completed conversation.
    if (latest && createdAt.getTime() < new Date(latest.created_at).getTime()) return
    if (!message.key.fromMe) await this.claimRoom(jid)
    const settings = await readSettings()
    if (Date.now() - createdAt.getTime() > settings.sweepMaxAgeHours * 3_600_000) return
    if (message.key.fromMe) await resumeAiAfterHumanReply(jid)
    else {
      await invalidateConversationGoal(jid)
      if (mediaDownload) {
        void mediaDownload
          .then(async () => {
            const row = await db.from('whatsapp_messages').where('message_id', id).first()
            if (row) await this.recoverStoredSyncMessage(row)
          })
          .catch(() => this.retainSyncFailure(message, 1))
      } else await requestAiReview(jid, 'reconnected')
    }
  }

  private deliveryStatus(status: number) {
    if (status >= 4) return 'read'
    if (status === 3) return 'delivered'
    if (status === 2) return 'sent'
    if (status === 1) return 'pending'
    return 'failed'
  }

  private async setActivity(jid: string, activity: string | null) {
    if (!jid || jid.endsWith('@g.us')) return
    await db.rawQuery(
      `INSERT INTO whatsapp_contacts (jid, name, profile_picture_url, activity, activity_updated_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?, ?)
       ON DUPLICATE KEY UPDATE activity = VALUES(activity),
         activity_updated_at = VALUES(activity_updated_at), updated_at = VALUES(updated_at)`,
      [jid, activity, activity ? new Date() : null, new Date()]
    )
  }

  private async cacheProfilePicture(jid: string, suppliedUrl?: string | null) {
    if (!this.socket) return null
    const candidates = [jid]
    if (jid.endsWith('@lid')) {
      const phoneJid = await this.socket.signalRepository.lidMapping.getPNForLID(jid)
      if (phoneJid) candidates.unshift(phoneJid)
    }
    let remoteUrl = suppliedUrl && !['changed', 'removed'].includes(suppliedUrl) ? suppliedUrl : ''
    for (const candidate of [...new Set(candidates)]) {
      if (remoteUrl) break
      try {
        for (const size of ['preview', 'image'] as const) {
          remoteUrl = (await this.socket.profilePictureUrl(candidate, size, 10_000)) || ''
          if (remoteUrl) break
        }
      } catch {}
    }
    if (!remoteUrl || new URL(remoteUrl).protocol !== 'https:') return null
    try {
      const response = await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return remoteUrl
      const data = new Uint8Array(await response.arrayBuffer())
      if (!data.byteLength || data.byteLength > 5 * 1024 * 1024) return remoteUrl
      const mime = response.headers.get('content-type') || ''
      const extension = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
      const directory = this.app.makePath('public', 'media', 'profiles')
      await mkdir(directory, { recursive: true })
      const safeJid = jid.replace(/[^a-z0-9_-]/gi, '')
      const filename = workspaceFileName(`${safeJid}.${extension}`)
      await writeFile(this.app.makePath('public', 'media', 'profiles', filename), data, {
        mode: 0o644,
      })
      return `${(env.get('APP_BASE_PATH') || '')}/media/profiles/${filename}?v=${Date.now()}`
    } catch {
      return remoteUrl
    }
  }

  private async refreshCustomerPhone(jid: string, alternate?: string | null) {
    const socket = this.socket
    if (!socket) return
    await rememberCustomerPhone(
      jid,
      (lid) => socket.signalRepository.lidMapping.getPNForLID(lid),
      alternate
    )
  }

  /**
   * Satu kontak WhatsApp bisa punya dua ID (LID dan nomor HP). Room chat sering
   * memakai LID sedangkan daftar kontak memakai nomor, jadi nama disimpan di keduanya.
   */
  private contactAliases(contact: { id?: string; lid?: string; phoneNumber?: string }) {
    const jids = [contact.id, contact.lid, contact.phoneNumber]
      .map((value) => String(value || '').trim())
      .map((value) => (/^\d{6,20}$/.test(value) ? `${value}@s.whatsapp.net` : value))
      .filter((value) => /^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(value))
    return [...new Set(jids)]
  }

  private async rememberContactIdentity(contact: {
    id?: string
    lid?: string
    phoneNumber?: string
  }) {
    if (contact.id) await this.refreshCustomerPhone(contact.id, contact.phoneNumber)
    if (contact.lid && contact.lid !== contact.id)
      await this.refreshCustomerPhone(
        contact.lid,
        contact.phoneNumber || (phoneFromJid(contact.id) ? contact.id : undefined)
      )
  }

  private async customerTurnContext(...args: Parameters<typeof buildTurnContext>) {
    // Retry unresolved old rooms before every AI turn, independently of avatar loading.
    await this.refreshCustomerPhone(args[0])
    return buildTurnContext(...args)
  }

  private rememberContact(...args: Parameters<WhatsappListen['rememberContactScoped']>) {
    return this.track(() => this.rememberContactScoped(...args))
  }
  private async rememberContactScoped(
    jid: string,
    name = '',
    refreshPicture = false,
    suppliedPictureUrl?: string | null
  ) {
    if (!jid || jid.endsWith('@g.us')) return
    await this.refreshCustomerPhone(jid)
    const current = await db.from('whatsapp_contacts').where('jid', jid).first()
    let picture = current?.profile_picture_url || null
    const isCached = String(picture || '').includes('/media/profiles/')
    const hasSuppliedPicture =
      Boolean(suppliedPictureUrl) && !['changed', 'removed'].includes(String(suppliedPictureUrl))
    if ((!picture || !isCached || refreshPicture || hasSuppliedPicture) && this.socket) {
      try {
        picture = (await this.cacheProfilePicture(jid, suppliedPictureUrl)) || picture
      } catch {}
    }
    await db.rawQuery(
      `INSERT INTO whatsapp_contacts (jid, name, profile_picture_url, activity, activity_updated_at, updated_at)
       VALUES (?, NULLIF(?, ''), ?, NULL, NULL, ?)
       ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name),
         profile_picture_url = COALESCE(VALUES(profile_picture_url), profile_picture_url),
         updated_at = VALUES(updated_at)`,
      [jid, name, picture, new Date()]
    )
  }

  /** Room LID yang belum punya nomor: coba petakan dari data LID ↔ nomor yang sudah dikenal. */
  private async backfillCustomerPhones() {
    const result = await db.rawQuery(
      `SELECT DISTINCT m.jid FROM whatsapp_messages m
         LEFT JOIN whatsapp_contacts c ON c.jid = m.jid
        WHERE m.jid LIKE '%@lid' AND COALESCE(c.phone_jid, '') = ''
        LIMIT 1000`
    )
    const rows = (Array.isArray(result) ? result[0] : result) as Array<{ jid: string }>
    for (const row of rows || []) {
      if (!this.socket) return
      await this.refreshCustomerPhone(String(row.jid)).catch(() => {})
    }
  }

  private refreshContactProfiles(refreshPicture = false) {
    return this.track(() => this.refreshContactProfilesScoped(refreshPicture))
  }
  private async refreshContactProfilesScoped(refreshPicture = false) {
    await this.backfillCustomerPhones().catch(() => {})
    const contacts = await db
      .from('whatsapp_messages')
      .distinct('jid', 'contact_name')
      .whereNot('jid', 'like', '%@g.us')
      .limit(200)
    for (const contact of contacts) {
      if (!this.socket) return
      await this.rememberContact(contact.jid, contact.contact_name || '', refreshPicture)
      await wait(75)
    }
  }

  private async prepareMedia(message: WAMessage): Promise<IncomingMedia | null> {
    const content = normalizeMessageContent(message.message)
    const document =
      content?.documentMessage || content?.documentWithCaptionMessage?.message?.documentMessage
    let mediaType: IncomingMedia['mediaType'] | null = null
    let mime = ''
    let extension = ''
    let note = ''
    let thumbnail: Uint8Array | null | undefined
    if (content?.imageMessage) {
      mediaType = 'image'
      mime = content.imageMessage.mimetype || 'image/jpeg'
      extension = mime.includes('png') ? 'png' : 'jpg'
      thumbnail = content.imageMessage.jpegThumbnail
    } else if (document && String(document.mimetype || '').startsWith('image/')) {
      // Dua pertiga "dokumen" dari pelanggan sebenarnya foto yang dikirim lewat
      // tombol Dokumen agar tidak pecah. Perlakukan sebagai foto.
      mediaType = 'image'
      mime = document.mimetype || 'image/jpeg'
      extension = mime.includes('png') ? 'png' : 'jpg'
      thumbnail = document.jpegThumbnail
    } else if (content?.videoMessage?.gifPlayback) {
      mediaType = 'gif'
      mime = content.videoMessage.mimetype || 'video/mp4'
      extension = 'mp4'
      thumbnail = content.videoMessage.jpegThumbnail
    } else if (content?.videoMessage) {
      mediaType = 'video'
      mime = content.videoMessage.mimetype || 'video/mp4'
      extension = mime.includes('quicktime') ? 'mov' : 'mp4'
      thumbnail = content.videoMessage.jpegThumbnail
    } else if (content?.stickerMessage) {
      mediaType = 'sticker'
      mime = content.stickerMessage.mimetype || 'image/webp'
      extension = 'webp'
      thumbnail = content.stickerMessage.pngThumbnail
    } else if (content?.audioMessage) {
      const seconds = Number(content.audioMessage.seconds || 0)
      mediaType = 'audio'
      mime = content.audioMessage.mimetype || 'audio/ogg'
      extension = 'ogg'
      note = content.audioMessage.ptt
        ? `[Pelanggan mengirim voice note${seconds ? ` ${seconds} detik` : ''}. Sistem tidak bisa mendengarkan isinya.]`
        : `[Pelanggan mengirim berkas audio${seconds ? ` ${seconds} detik` : ''}. Sistem tidak bisa mendengarkan isinya.]`
    } else if (document) {
      const name = String(document.fileName || 'tanpa nama')
      mediaType = 'document'
      mime = document.mimetype || 'application/octet-stream'
      extension = 'bin'
      note = `[Pelanggan mengirim dokumen "${name}" (${mime}). Isinya tidak bisa dibaca sistem.]`
    } else if (content?.locationMessage || content?.liveLocationMessage) {
      const place = content.locationMessage
      mediaType = 'location'
      mime = 'text/location'
      extension = 'txt'
      const label = [place?.name, place?.address].filter(Boolean).join(', ')
      note = `[Pelanggan mengirim titik lokasi${label ? `: ${label}` : ''}. Jangan menebak kota dari titik peta, tanyakan daerahnya.]`
    } else if (content?.contactMessage || content?.contactsArrayMessage) {
      const name = String(
        content.contactMessage?.displayName ||
          content.contactsArrayMessage?.contacts?.[0]?.displayName ||
          'tanpa nama'
      )
      mediaType = 'contact'
      mime = 'text/vcard'
      extension = 'vcf'
      note = `[Pelanggan mengirim kontak "${name}". Konfirmasi ulang nama dan nomornya sebagai teks sebelum dipakai.]`
    } else {
      return null
    }

    const visual = VISUAL_MEDIA.has(mediaType)
    let thumbnailUrl: string | null = null
    let thumbnailPath: string | null = null
    if (thumbnail?.byteLength && message.key.id) {
      const directory = this.app.makePath('public', 'media')
      await mkdir(directory, { recursive: true })
      const safeId = message.key.id.replace(/[^a-z0-9_-]/gi, '')
      const filename = workspaceFileName(`thumb-${safeId}.jpg`)
      thumbnailPath = this.app.makePath('public', 'media', filename)
      await writeFile(thumbnailPath, thumbnail, { mode: 0o644 })
      thumbnailUrl = `${(env.get('APP_BASE_PATH') || '')}/media/${filename}`
    }

    return { mediaType, mediaMime: mime, extension, thumbnailUrl, thumbnailPath, visual, note }
  }

  private downloadMedia(message: WAMessage, media: IncomingMedia) {
    return this.track(() => this.downloadMediaScoped(message, media))
  }
  private async downloadMediaScoped(message: WAMessage, media: IncomingMedia) {
    const messageId = message.key.id
    if (!this.socket || !messageId) return null
    try {
      const data = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
          logger: pino({ level: 'silent' }),
          reuploadRequest: this.socket.updateMediaMessage,
        }
      )
      if (data.byteLength > 50 * 1024 * 1024) throw new Error('Media melebihi batas 50 MB')
      const directory = this.app.makePath('public', 'media')
      await mkdir(directory, { recursive: true })
      const filename = workspaceFileName(
        `${messageId.replace(/[^a-z0-9_-]/gi, '')}.${media.extension}`
      )
      const mediaPath = this.app.makePath('public', 'media', filename)
      await writeFile(mediaPath, data, { mode: 0o644 })
      await db
        .from('whatsapp_messages')
        .where('message_id', messageId)
        .update({
          media_url: `${(env.get('APP_BASE_PATH') || '')}/media/${filename}`,
          media_status: 'ready',
        })
      return mediaPath
    } catch (error) {
      await db
        .from('whatsapp_messages')
        .where('message_id', messageId)
        .update({ media_status: 'failed' })
      this.logger.error(
        `Media ${messageId}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  private replyIdOf(message: WAMessage) {
    const content = normalizeMessageContent(message.message)
    return String(
      content?.extendedTextMessage?.contextInfo?.stanzaId ||
        content?.imageMessage?.contextInfo?.stanzaId ||
        content?.videoMessage?.contextInfo?.stanzaId ||
        content?.stickerMessage?.contextInfo?.stanzaId ||
        content?.documentMessage?.contextInfo?.stanzaId ||
        content?.audioMessage?.contextInfo?.stanzaId ||
        content?.documentWithCaptionMessage?.message?.documentMessage?.contextInfo?.stanzaId ||
        ''
    )
  }

  private async onReaction(
    key: WAMessageKey,
    reaction: { key?: WAMessageKey | null; text?: string | null }
  ) {
    const targetId = reaction.key?.id
    const jid = key.remoteJid
    if (!targetId || !jid) return
    const sender = key.fromMe ? 'me' : key.participant || jid
    const emoji = String(reaction.text || '')
    if (!emoji) {
      await db
        .from('whatsapp_reactions')
        .where('target_message_id', targetId)
        .where('sender', sender)
        .delete()
      return
    }
    await db.rawQuery(
      `INSERT INTO whatsapp_reactions
       (target_message_id, jid, sender, emoji, from_me, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'received', ?)
       ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), status = 'received', created_at = VALUES(created_at)`,
      [targetId, jid, sender, emoji, key.fromMe ? 1 : 0, new Date()]
    )
  }

  private async sendPaymentWaitNotice() {
    const socket = this.socket
    if (!socket || !this.readyForAi() || this.stopping) return
    if (!isAiWorking(await readSettings())) return
    const notices = [
      ...(await duePaymentWaitNotices()).map((notice) => ({ ...notice, kind: 'payment' })),
      ...(await dueApprovalWaitNotices()).map((notice) => ({ ...notice, kind: 'approval' })),
      ...(await dueShippingNotices()).map((notice) => ({
        ...notice,
        id: notice.order_id,
        due_at: notice.next_attempt_at,
        kind: 'shipping',
      })),
    ].sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
    for (const notice of notices) {
      if (this.pendingTurns.has(notice.jid) || this.chatLocks.has(notice.jid)) continue
      if (!(await this.ownsRoom(notice.jid))) continue
      const deliver =
        notice.kind === 'shipping'
          ? deliverShippingNotice
          : notice.kind === 'approval'
            ? deliverApprovalWaitNotice
            : deliverPaymentWaitNotice
      const task = deliver(
        notice.id,
        async (pending, canSend, reserve) =>
          trackOutgoingMessage(pending.jid, async (outgoingId) => {
            const anchor = await db
              .from('whatsapp_messages')
              .where('id', pending.anchorId)
              .where('jid', pending.jid)
              .first()
            const keys = anchor
              ? [{ id: anchor.message_id, remoteJid: pending.jid, fromMe: false }]
              : []
            const sent = await sendPreparedReply(
              socket,
              pending.jid,
              keys,
              async () => {
                if (!(await reserve(outgoingId))) return null
                return socket.sendMessage(
                  pending.jid,
                  { text: pending.text },
                  { messageId: outgoingId }
                )
              },
              {
                canSend,
                read: () =>
                  readIncomingThrough(socket, pending.jid, Number(pending.anchorId), canSend),
                onRead: () => markRoomRead(pending.jid, pending.anchorId).then(() => {}),
                onTyping: () => this.setActivity(pending.jid, 'typing'),
                onDone: () => this.setActivity(pending.jid, null),
              }
            )
            if (!sent?.key.id) return null
            await saveSentAiMessage({
              message_id: sent.key.id,
              jid: pending.jid,
              direction: 'out',
              sender_type: 'ai',
              body: pending.text,
              status: 'sent',
              created_at: new Date(),
            })
            return sent.key.id
          }),
        () => this.socket === socket && this.readyForAi() && !this.stopping
      )
      this.chatLocks.set(notice.jid, task)
      try {
        await task
      } finally {
        if (this.chatLocks.get(notice.jid) === task) this.chatLocks.delete(notice.jid)
      }
      break
    }
  }

  private async flushOutbox() {
    if (!this.socket) return
    const line = currentLine()
    const queued = await db
      .from('whatsapp_messages')
      .where('direction', 'out')
      .where('status', 'queued')
      // Tiap nomor hanya mengirim antrean miliknya (NULL = nomor utama).
      .where((query) => {
        if (line > 1) query.where('line_id', line)
        else query.whereNull('line_id').orWhere('line_id', '<=', 1)
      })
      .orderBy('id', 'asc')
      .limit(20)
    for (const message of queued) {
      let sentMessageId = ''
      try {
        let quoted: WAMessage | undefined
        if (message.reply_to_message_id) {
          const target = await db
            .from('whatsapp_messages')
            .where('message_id', message.reply_to_message_id)
            .first()
          if (target) {
            quoted = {
              key: {
                id: target.message_id,
                remoteJid: target.jid,
                fromMe: target.direction === 'out',
              },
              message: { conversation: target.body || 'Media' },
            }
          }
        }
        const payload = await csOutgoingPayload(message)
        if (message.sender_type === 'ai' && !(await this.canSendAiReply(message.jid, this.socket)))
          continue
        const sent = await this.socket.sendMessage(
          message.jid,
          payload,
          quoted ? { quoted } : undefined
        )
        if (!sent?.key.id) throw new Error('Pengiriman belum dikonfirmasi.')
        const sentId = sent.key.id
        sentMessageId = sentId
        if (sentId !== message.message_id) {
          await db
            .from('whatsapp_reactions')
            .where('target_message_id', message.message_id)
            .update({ target_message_id: sentId })
          await db
            .from('whatsapp_messages')
            .where('reply_to_message_id', message.message_id)
            .update({ reply_to_message_id: sentId })
        }
        await db
          .from('whatsapp_messages')
          .where('id', message.id)
          .update({ status: 'sent', message_id: sentId })
      } catch {
        await db.from('whatsapp_messages').where('id', message.id).update({ status: 'failed' })
        continue
      }
      // A mode-update error must not turn an already sent message into a failed send.
      if (message.sender_type === 'cs') {
        await resumeAiAfterHumanReply(message.jid)
        // Beta 2: jawaban CS menjadi kandidat contoh untuk AI, tanpa mengedit skill.
        try {
          const latestSettings = await readSettings()
          if (latestSettings.beta3Mode) await beta3.learnFromHumanReply(message.jid, sentMessageId)
          else if (latestSettings.leanMode) await learnFromHumanReply(message.jid, sentMessageId)
        } catch {
          /* Contoh opsional; jangan mengganggu pengiriman. */
        }
      }
    }
  }

  private async flushReactions() {
    if (!this.socket) return
    const queued = await db
      .from('whatsapp_reactions')
      .where('from_me', true)
      .where('status', 'queued')
      .orderBy('id', 'asc')
      .limit(20)
    for (const reaction of queued) {
      if (!(await this.ownsRoom(String(reaction.jid || '')))) continue
      const target = await db
        .from('whatsapp_messages')
        .where('message_id', reaction.target_message_id)
        .first()
      if (!target) continue
      try {
        await this.socket.sendMessage(reaction.jid, {
          react: {
            text: reaction.emoji,
            key: {
              id: target.message_id,
              remoteJid: target.jid,
              fromMe: target.direction === 'out',
            },
          },
        })
        await db.from('whatsapp_reactions').where('id', reaction.id).update({ status: 'sent' })
      } catch {
        await db.from('whatsapp_reactions').where('id', reaction.id).update({ status: 'failed' })
      }
    }
  }

  private async onMessage(message: WAMessage) {
    const id = message.key.id
    const jid = message.key.remoteJid
    if (!id || !jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return
    await this.refreshCustomerPhone(jid, message.key.remoteJidAlt)
    if (message.key.fromMe && isTrackedOutgoingMessage(jid, id)) return
    const exists = await db.from('whatsapp_messages').where('message_id', id).first()
    if (exists) return
    // Pesan yang dikirim pemilik langsung dari HP tetap dicatat. Tanpa ini AI
    // tidak tahu chat itu sudah dijawab manusia, lalu menjawab ulang.
    if (message.key.fromMe) return this.recordOwnMessage(message, id, jid)
    const text = this.textOf(message)
    const media = await this.prepareMedia(message)
    if (!text && !media) return
    this.rememberContact(jid, message.pushName || '').catch(() => {})
    await this.claimRoom(jid)
    await db.table('whatsapp_messages').insert({
      ...lineColumns(),
      message_id: id,
      jid,
      contact_name: message.pushName || null,
      direction: 'in',
      sender_type: 'customer',
      body: text,
      media_type: media?.mediaType || null,
      media_url: null,
      thumbnail_url: media?.thumbnailUrl || null,
      media_mime: media?.mediaMime || null,
      media_status: media && media.visual ? 'downloading' : null,
      reply_to_message_id: this.replyIdOf(message) || null,
      status: 'received',
      created_at: this.messageDate(message),
    })
    const mediaDownload =
      media && media.visual ? this.downloadMedia(message, media) : Promise.resolve(null)
    await invalidateConversationGoal(jid)
    const settings = await readSettings(true)
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    if (
      !isAiWorking(settings) ||
      !settings.hasSkill ||
      contact?.handling_mode === 'cs' ||
      contact?.ai_excluded ||
      !this.socket
    ) {
      void mediaDownload
      return
    }
    this.queueTurn(jid, { id, text, message, media, mediaDownload }, settings.turnWindowMs)
  }

  private async recordOwnMessage(message: WAMessage, id: string, jid: string) {
    const text = this.textOf(message)
    const media = await this.prepareMedia(message)
    if (!text && !media) return
    // Giliran yang sedang menunggu dibatalkan: pemilik sudah menjawab duluan.
    const pending = this.pendingTurns.get(jid)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingTurns.delete(jid)
    }
    await db.table('whatsapp_messages').insert({
      ...lineColumns(),
      message_id: id,
      jid,
      contact_name: null,
      direction: 'out',
      sender_type: 'owner',
      body: text,
      media_type: media?.mediaType || null,
      media_url: null,
      thumbnail_url: media?.thumbnailUrl || null,
      media_mime: media?.mediaMime || null,
      media_status: null,
      reply_to_message_id: this.replyIdOf(message) || null,
      status: 'sent',
      created_at: this.messageDate(message),
    })
    await resumeAiAfterHumanReply(jid)
  }

  private queueTurn(jid: string, item: PendingMessage, windowMs?: number) {
    item.queuedAt ??= Date.now()
    const delay = Number.isFinite(windowMs) ? Number(windowMs) : FALLBACK_TURN_WINDOW_MS
    const pending = this.pendingTurns.get(jid)
    if (pending) {
      clearTimeout(pending.timer)
      pending.items.push(item)
      pending.timer = setTimeout(() => void this.flushTurn(jid), delay)
      return
    }
    this.pendingTurns.set(jid, {
      items: [item],
      timer: setTimeout(() => void this.flushTurn(jid), delay),
    })
    this.setActivity(jid, 'understanding').catch(() => {})
  }

  private flushTurn(jid: string) {
    return this.track(() => this.flushTurnScoped(jid))
  }
  private async flushTurnScoped(jid: string) {
    // Satu chat dikerjakan satu per satu. Tanpa ini, giliran berikutnya bisa
    // berjalan sebelum balasan giliran sebelumnya tersimpan, lalu menjawab dua kali.
    const previous = this.chatLocks.get(jid) || Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.runTurn(jid))
    this.chatLocks.set(jid, task)
    try {
      await task
    } finally {
      if (this.chatLocks.get(jid) === task) this.chatLocks.delete(jid)
    }
  }

  private async imagePathOfMessage(messageId: string) {
    if (!messageId) return null
    const row = await db.from('whatsapp_messages').where('message_id', messageId).first()
    if (!row || !['image', 'sticker', 'video', 'gif'].includes(String(row.media_type || '')))
      return null
    const source = ['video', 'gif'].includes(row.media_type)
      ? row.thumbnail_url
      : row.media_url || row.thumbnail_url
    if (!source) return null
    const name = String(source).split('/').pop()
    if (!name) return null
    const path =
      row.media_upload_id && ['image', 'sticker'].includes(row.media_type)
        ? csMediaPath(row.media_upload_id)
        : this.app.makePath('public', 'media', name)
    try {
      await access(path)
      return path
    } catch {
      return null
    }
  }

  private async runTurn(jid: string) {
    const pending = this.pendingTurns.get(jid)
    this.pendingTurns.delete(jid)
    if (!pending?.items.length) return
    const items = pending.items
    const last = items[items.length - 1]
    const visualItems = items.filter((item) => item.media?.visual)
    const primary = visualItems.length ? visualItems[visualItems.length - 1] : undefined
    const notes = items
      .map((item) => item.media?.note)
      .filter((note): note is string => Boolean(note))
    const text = [...items.map((item) => item.text), ...notes].filter(Boolean).join('\n')

    const settings = await readSettings(true)
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    if (
      !isAiWorking(settings) ||
      !settings.hasSkill ||
      contact?.handling_mode === 'cs' ||
      contact?.ai_excluded ||
      !this.socket
    ) {
      for (const item of items) void item.mediaDownload
      return
    }

    const goalRun = await beginGoalTurn(jid, last.id)
    if (!goalRun) return
    const turnSocket = this.socket
    if (settings.beta3Mode) {
      const downloadedB3 = new Map<string, string | null>()
      for (const item of visualItems) downloadedB3.set(item.id, await item.mediaDownload)
      for (const item of items) if (!visualItems.includes(item)) void item.mediaDownload
      const imagesB3 = visualItems
        .map((item) => ({ id: item.id, path: downloadedB3.get(item.id) }))
        .filter((image): image is { id: string; path: string } => Boolean(image.path))
        .slice(0, 3)
      await this.runBeta3Turn(jid, goalRun, turnSocket, settings, {
        text,
        messageIds: items.map((item) => item.id),
        keys: items.map((item) => item.message.key),
        imagePaths: imagesB3.map((image) => image.path),
        imageIds: imagesB3.map((image) => image.id),
      })
      return
    }
    if (settings.leanMode) {
      const downloadedLean = new Map<string, string | null>()
      for (const item of visualItems) downloadedLean.set(item.id, await item.mediaDownload)
      for (const item of items) if (!visualItems.includes(item)) void item.mediaDownload
      await this.runLeanTurn(jid, goalRun, turnSocket, settings, {
        text,
        messageIds: items.map((item) => item.id),
        keys: items.map((item) => item.message.key),
        imagePaths: visualItems
          .map((item) => downloadedLean.get(item.id))
          .filter((path): path is string => Boolean(path))
          .slice(0, 3),
      })
      return
    }
    let trace: Awaited<ReturnType<typeof startTrace>> | undefined
    try {
      trace = await startTrace(jid, {
        text,
        provider: settings.aiProvider,
        model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
        skills: settings.skills.map((skill) => skill.name),
        messages: items.map((item) => ({ id: item.id, mediaType: item.media?.mediaType || null })),
      }).catch(() => undefined)
      trace?.emit({ key: 'input', label: 'Menerima pesan dan menyiapkan media', status: 'running' })
      trace?.emit({
        key: 'queue-timing',
        label: 'Waktu tunggu antrean',
        status: 'completed',
        detail: {
          elapsedMs: Math.max(
            0,
            Date.now() - Math.min(...items.map((item) => item.queuedAt || Date.now()))
          ),
          includesMessageBatching: true,
        },
      })
      await this.setActivity(jid, 'understanding')

      const downloaded = new Map<string, string | null>()
      for (const item of visualItems) downloaded.set(item.id, await item.mediaDownload)
      for (const item of items) if (!visualItems.includes(item)) void item.mediaDownload

      const context = await this.customerTurnContext(
        jid,
        items.map((item) => item.id),
        settings.historyLimit
      )
      trace?.emit({
        key: 'input',
        label: 'Input dan konteks siap',
        status: 'completed',
        detail: {
          context: context.prompt,
          quotedMessageId: context.quotedMessageId,
          efficiency: context.efficiency,
          promptCharacters: context.prompt.length,
        },
      })

      // Gambar lain di giliran yang sama (pelanggan sering mengirim beberapa foto
      // sekaligus) dan gambar yang sedang dikutip pelanggan ikut dilampirkan.
      const contextImages: AiContextImage[] = []
      for (const item of [...visualItems].reverse()) {
        if (item === primary) continue
        const path = downloaded.get(item.id)
        if (path && (item.media?.mediaType === 'image' || item.media?.mediaType === 'sticker')) {
          contextImages.push({
            path,
            messageId: item.id,
            label: 'foto sebelumnya di giliran yang sama; bukan pengganti foto terbaru',
          })
        }
      }
      if (context.quotedMessageId && context.quotedMessageId !== primary?.id) {
        const quotedPath = await this.imagePathOfMessage(context.quotedMessageId)
        if (quotedPath) {
          contextImages.push({
            path: quotedPath,
            messageId: context.quotedMessageId,
            previouslyAnalyzed: true,
            label: 'gambar yang dikutip pelanggan; tidak menggantikan lampiran baru',
          })
        }
      }

      const decision = await createReply(
        { ...settings, conversationAccess: context.access, routingContext: context.routing },
        text,
        (activity) => {
          this.setActivity(jid, activity).catch(() => {})
          if (activity === 'compacting')
            trace?.emit({
              key: `compact-${Date.now()}`,
              label: 'Provider melaporkan pemadatan konteks',
              status: 'completed',
            })
        },
        primary?.media?.visual
          ? {
              type: primary.media.mediaType as AiMedia['type'],
              messageId: primary.id,
              path: downloaded.get(primary.id) || null,
              thumbnailPath: primary.media.thumbnailPath,
            }
          : undefined,
        context.prompt,
        contextImages.slice(0, 4),
        trace?.emit,
        text,
        true,
        context.sections
      )
      decision.cartVersion = context.cartVersion
      await this.deliverAiDecision(
        goalRun,
        turnSocket,
        settings,
        decision,
        items.map((item) => item.message.key),
        false,
        trace,
        context.quotedMessageId ? last.message : undefined
      )
    } catch (error) {
      const failure = aiFailureDetail(error, {
        stage: 'processing',
        provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
      })
      const retry = await recordAnalysisFailure(goalRun, failure)
      if (retry)
        trace?.emit({
          key: 'analysis-retry',
          label: retry.nextAttemptAt
            ? 'Analisis akan dicoba ulang otomatis'
            : 'Analisis memerlukan pemeriksaan',
          status: 'completed',
          detail: retry,
        })
      await trace?.finish('failed', {
        error: failure.message,
        failure,
      })
      this.logger.error(JSON.stringify({ traceId: trace?.id, ...failure }))
    } finally {
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  /**
   * Beta 2 — jalur ramping: satu panggilan AI tanpa tool, kirim 1–2 bubble +
   * foto katalog, simpan catatan chat, tutup goal. Tidak ada cart/evidence/MCP.
   */
  private async runLeanTurn(
    jid: string,
    run: GoalRun,
    socket: WASocket,
    settings: Awaited<ReturnType<typeof readSettings>>,
    input: { text: string; messageIds: string[]; keys: WAMessageKey[]; imagePaths: string[] }
  ) {
    let trace: Awaited<ReturnType<typeof startTrace>> | undefined
    const canSend = async () =>
      (await isCurrentGoalRun(run)) &&
      (await this.waitForDeliverySync(socket)) &&
      (await this.canSendAiReply(jid, socket)) &&
      (await isCurrentGoalRun(run))
    try {
      trace = await startTrace(jid, {
        text: input.text,
        mode: 'lean',
        provider: settings.aiProvider,
        model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
        messages: input.messageIds.map((id) => ({ id })),
      }).catch(() => undefined)
      await this.setActivity(jid, 'understanding')
      const reply = await createLeanReply({
        jid,
        messageIds: input.messageIds,
        text: input.text,
        imagePaths: input.imagePaths,
        settings: {
          ...settings,
          aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
        },
        onTrace: trace?.emit,
      })
      const { decision } = reply
      if (!(await canSend())) {
        await pauseGoalRun(run, 'Konteks, koneksi, atau status AI berubah.')
        await trace?.finish('cancelled', { reason: 'Konteks berubah; balasan lama dibatalkan.' })
        return
      }
      if (!(await markGoalDelivery(run))) return
      let firstMessageId: string | undefined
      const sendBubble = async (body: string, image?: { bytes: Buffer; url: string }) => {
        return trackOutgoingMessage(jid, async (outgoingId) => {
          const sent = await sendPreparedReply(
            socket,
            jid,
            firstMessageId ? [] : input.keys,
            () =>
              socket.sendMessage(
                jid,
                image
                  ? { image: image.bytes, caption: body, mimetype: 'image/jpeg' as const }
                  : { text: body },
                { messageId: outgoingId }
              ),
            {
              canSend,
              read: () =>
                firstMessageId
                  ? Promise.resolve()
                  : readIncomingThrough(socket, jid, Number(run.anchor_id), canSend),
              onTyping: async () => {
                await this.setActivity(jid, 'typing')
              },
              onDone: () => this.setActivity(jid, null),
            }
          )
          if (sent === null) return false
          if (!sent?.key.id) throw new Error('Pengiriman belum dikonfirmasi.')
          const messageId = sent.key.id
          await saveSentAiMessage({
            message_id: messageId,
            jid,
            contact_name: null,
            direction: 'out',
            sender_type: 'ai',
            body,
            media_type: image ? 'image' : null,
            media_url: image?.url || null,
            thumbnail_url: image?.url || null,
            media_mime: image ? 'image/jpeg' : null,
            media_name: null,
            media_size: image?.bytes.length || null,
            media_status: image ? 'ready' : null,
            reply_to_message_id: null,
            status: 'sent',
            created_at: new Date(),
          })
          if (!firstMessageId)
            await markRoomRead(jid, run.anchor_id).catch(() => {
              this.logger.error('Status baca workspace belum diperbarui.')
            })
          firstMessageId ||= messageId
          return true
        })
      }
      // Urutan seperti CS: jawaban pertama → foto → pertanyaan berikutnya.
      const bubbles = decision.serah_cs ? [] : decision.pesan
      let aborted = false
      const sendPhotos = async () => {
        for (const photo of reply.photos) {
          try {
            const bytes = await downloadOutgoingImage(photo.url)
            if (!(await sendBubble(photo.caption, { bytes, url: photo.url }))) {
              aborted = true
              break
            }
            trace?.emit({
              key: `photo-${photo.caption}`,
              label: `Foto terkirim · ${photo.caption}`,
              status: 'completed',
            })
          } catch (error) {
            trace?.emit({
              key: `photo-${photo.caption}`,
              label: `Foto tidak terkirim · ${photo.caption}`,
              status: 'failed',
              detail: { error: error instanceof Error ? error.message : String(error) },
            })
          }
        }
      }
      if (!decision.serah_cs && !bubbles.length) await sendPhotos()
      for (const [index, body] of bubbles.entries()) {
        if (aborted || !(await sendBubble(body))) {
          aborted = true
          break
        }
        trace?.emit({ key: `send-${index + 1}`, label: 'Balasan terkirim', status: 'completed' })
        if (index === 0) await sendPhotos()
      }
      if (!aborted && reply.autoTotal && !decision.serah_cs) {
        // Total + rekening dikirim sistem (bukan AI) setelah rincian lolos verifikasi katalog.
        try {
          const sent = await sendLeanTotal(reply.autoTotal)
          decision.tahap = 'tunggu_bayar'
          decision.catatan = `${decision.catatan.replace(/tahap\s*[:=]\s*\w+/i, 'tahap: tunggu_bayar')}\ntotal ${sent.orderNumber}: ${sent.total} dikirim otomatis (${reply.autoTotal.shippingService})`
          trace?.emit({
            key: 'lean-total-sent',
            label: `Total ${sent.total} + rekening dikirim · ${sent.orderNumber}`,
            status: 'completed',
            detail: reply.autoTotal,
          })
        } catch (error) {
          trace?.emit({
            key: 'lean-total-sent',
            label: 'Total otomatis gagal dikirim; menunggu CS',
            status: 'failed',
            detail: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      if (decision.catatan) await saveChatNote(jid, decision.catatan)
      const goal = await finishLeanGoal(run, decision)
      if (decision.serah_cs) {
        await setHandlingMode(jid, 'cs', decision.alasan || 'Diserahkan ke CS oleh AI (lean).')
        trace?.emit({
          key: 'handoff',
          label: 'Room diserahkan ke CS',
          status: 'completed',
          detail: { reason: decision.alasan },
        })
      }
      await trace?.finish(
        'completed',
        {
          decision: decision.serah_cs ? 'handoff' : decision.pesan.length ? 'reply' : 'silent',
          summary: decision.alasan,
          tahap: decision.tahap,
          promptTokens: reply.promptTokens,
          usage: reply.usage,
          orderId: reply.orderId,
          goal,
        },
        firstMessageId
      )
    } catch (error) {
      const failure = aiFailureDetail(error, {
        stage: 'processing',
        provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
      })
      const retry = await recordAnalysisFailure(run, failure)
      if (retry)
        trace?.emit({
          key: 'analysis-retry',
          label: retry.nextAttemptAt
            ? 'Analisis akan dicoba ulang otomatis'
            : 'Analisis memerlukan pemeriksaan',
          status: 'completed',
          detail: retry,
        })
      await trace?.finish('failed', { error: failure.message, failure })
      this.logger.error(JSON.stringify({ traceId: trace?.id, mode: 'lean', ...failure }))
    } finally {
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  private async runBeta3Turn(
    jid: string,
    run: GoalRun,
    socket: WASocket,
    settings: Awaited<ReturnType<typeof readSettings>>,
    input: {
      text: string
      messageIds: string[]
      keys: WAMessageKey[]
      imagePaths: string[]
      imageIds?: string[]
    }
  ) {
    let trace: Awaited<ReturnType<typeof startTrace>> | undefined
    const canSend = async () =>
      (await isCurrentGoalRun(run)) &&
      (await this.waitForDeliverySync(socket)) &&
      (await this.canSendAiReply(jid, socket)) &&
      (await isCurrentGoalRun(run))
    try {
      trace = await startTrace(jid, {
        text: input.text,
        mode: 'beta3',
        provider: settings.aiProvider,
        model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
        messages: input.messageIds.map((id) => ({ id })),
      }).catch(() => undefined)
      await this.setActivity(jid, 'understanding')
      const reply = await beta3.createLeanReply({
        jid,
        messageIds: input.messageIds,
        text: input.text,
        imagePaths: input.imagePaths,
        imageIds: input.imageIds,
        settings: {
          ...settings,
          aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
        },
        onTrace: trace?.emit,
      })
      const { decision } = reply
      if (!(await canSend())) {
        await pauseGoalRun(run, 'Konteks, koneksi, atau status AI berubah.')
        await trace?.finish('cancelled', { reason: 'Konteks berubah; balasan lama dibatalkan.' })
        return
      }
      if (!(await markGoalDelivery(run))) return
      let firstMessageId: string | undefined
      const sendBubble = async (body: string, image?: { bytes: Buffer; url: string }) => {
        return trackOutgoingMessage(jid, async (outgoingId) => {
          const sent = await sendPreparedReply(
            socket,
            jid,
            firstMessageId ? [] : input.keys,
            () =>
              socket.sendMessage(
                jid,
                image
                  ? { image: image.bytes, caption: body, mimetype: 'image/jpeg' as const }
                  : { text: body },
                { messageId: outgoingId }
              ),
            {
              canSend,
              read: () =>
                firstMessageId
                  ? Promise.resolve()
                  : readIncomingThrough(socket, jid, Number(run.anchor_id), canSend),
              onTyping: async () => {
                await this.setActivity(jid, 'typing')
              },
              onDone: () => this.setActivity(jid, null),
            }
          )
          if (sent === null) return false
          if (!sent?.key.id) throw new Error('Pengiriman belum dikonfirmasi.')
          const messageId = sent.key.id
          await saveSentAiMessage({
            message_id: messageId,
            jid,
            contact_name: null,
            direction: 'out',
            sender_type: 'ai',
            body,
            media_type: image ? 'image' : null,
            media_url: image?.url || null,
            thumbnail_url: image?.url || null,
            media_mime: image ? 'image/jpeg' : null,
            media_name: null,
            media_size: image?.bytes.length || null,
            media_status: image ? 'ready' : null,
            reply_to_message_id: null,
            status: 'sent',
            created_at: new Date(),
          })
          if (!firstMessageId)
            await markRoomRead(jid, run.anchor_id).catch(() => {
              this.logger.error('Status baca workspace belum diperbarui.')
            })
          firstMessageId ||= messageId
          return true
        })
      }
      // Urutan seperti CS: jawaban pertama → foto → pertanyaan berikutnya.
      const bubbles = decision.serah_cs ? [] : decision.pesan
      let aborted = false
      const sendPhotos = async () => {
        for (const photo of reply.photos) {
          try {
            const bytes = await downloadOutgoingImage(photo.url)
            if (!(await sendBubble(photo.caption, { bytes, url: photo.url }))) {
              aborted = true
              break
            }
            trace?.emit({
              key: `photo-${photo.caption}`,
              label: `Foto terkirim · ${photo.caption}`,
              status: 'completed',
            })
          } catch (error) {
            trace?.emit({
              key: `photo-${photo.caption}`,
              label: `Foto tidak terkirim · ${photo.caption}`,
              status: 'failed',
              detail: { error: error instanceof Error ? error.message : String(error) },
            })
          }
        }
      }
      if (!decision.serah_cs && !bubbles.length) await sendPhotos()
      for (const [index, body] of bubbles.entries()) {
        if (aborted || !(await sendBubble(body))) {
          aborted = true
          break
        }
        trace?.emit({ key: `send-${index + 1}`, label: 'Balasan terkirim', status: 'completed' })
        if (index === 0) await sendPhotos()
      }
      if (!aborted && reply.autoTotal && !decision.serah_cs) {
        // Total + rekening dikirim sistem (bukan AI) setelah rincian lolos verifikasi katalog.
        try {
          const sent = await beta3.sendLeanTotal(reply.autoTotal)
          decision.tahap = 'tunggu_bayar'
          decision.catatan = `${decision.catatan.replace(/tahap\s*[:=]\s*\w+/i, 'tahap: tunggu_bayar')}\ntotal ${sent.orderNumber}: ${sent.total} dikirim otomatis (${reply.autoTotal.shippingService})`
          trace?.emit({
            key: 'beta3-total-sent',
            label: `Total ${sent.total} + rekening dikirim · ${sent.orderNumber}`,
            status: 'completed',
            detail: reply.autoTotal,
          })
        } catch (error) {
          trace?.emit({
            key: 'beta3-total-sent',
            label: 'Total otomatis gagal dikirim; menunggu CS',
            status: 'failed',
            detail: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      if (decision.catatan) await beta3.writeBeta3ChatNote(jid, decision.catatan)
      const goal = await beta3.finishLeanGoal(run, decision)
      if (decision.serah_cs) {
        await setHandlingMode(jid, 'cs', decision.alasan || 'Diserahkan ke CS oleh AI (beta 3).')
        trace?.emit({
          key: 'handoff',
          label: 'Room diserahkan ke CS',
          status: 'completed',
          detail: { reason: decision.alasan },
        })
      }
      await trace?.finish(
        'completed',
        {
          decision: decision.serah_cs ? 'handoff' : decision.pesan.length ? 'reply' : 'silent',
          summary: decision.alasan,
          tahap: decision.tahap,
          promptTokens: reply.promptTokens,
          usage: reply.usage,
          orderId: reply.orderId,
          goal,
        },
        firstMessageId
      )
    } catch (error) {
      const failure = aiFailureDetail(error, {
        stage: 'processing',
        provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
      })
      const retry = await recordAnalysisFailure(run, failure)
      if (retry)
        trace?.emit({
          key: 'analysis-retry',
          label: retry.nextAttemptAt
            ? 'Analisis akan dicoba ulang otomatis'
            : 'Analisis memerlukan pemeriksaan',
          status: 'completed',
          detail: retry,
        })
      await trace?.finish('failed', { error: failure.message, failure })
      this.logger.error(JSON.stringify({ traceId: trace?.id, mode: 'beta3', ...failure }))
    } finally {
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  /**
   * Menyapu chat yang pesan terakhirnya dari pelanggan dan belum dibalas siapa pun
   * — misalnya karena worker mati atau panggilan AI gagal. Balasan terlambat
   * terbukti tetap berguna: di arsip, percakapan tetap lanjut 86% setelah dibalas
   * lebih dari 6 jam, dibanding 91% kalau dibalas di bawah 1 jam.
   */
  private async sweepUnanswered() {
    if (!this.socket || !this.readyForAi() || this.sweeping) return
    this.sweeping = true
    try {
      const settings = await readSettings(true)
      if (!isAiWorking(settings) || !settings.hasSkill || !settings.sweepEnabled) return
      if (settings.leanMode) return // Beta 2 dihentikan.
      const maxAgeMs = Math.max(1, settings.sweepMaxAgeHours) * 3_600_000
      // Jangan menyerobot giliran yang masih dalam jendela penggabungan.
      const minAgeMs = Math.max(60_000, (settings.turnWindowMs || 6000) * 3)
      const now = Date.now()
      const since = new Date(now - maxAgeMs)
      const batch = Math.max(1, Math.min(50, settings.sweepBatch))
      // Chat yang sudah dipegang manusia disaring di SQL. Kalau tidak, chat
      // bermode 'cs' akan terus menempati antrean teratas dan menyumbat sapuan.
      const result = await db.rawQuery(
        `SELECT t.jid, t.created_at
           FROM whatsapp_messages t
           JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY jid ORDER BY created_at DESC, id DESC) AS position
                  FROM whatsapp_messages WHERE created_at >= ? AND status NOT IN ('failed', 'queued')) x
             ON x.id = t.id AND x.position = 1
           LEFT JOIN whatsapp_contacts c ON c.jid = t.jid
           LEFT JOIN whatsapp_chat_goals g ON g.jid = t.jid
          WHERE t.direction = 'in'
            AND GREATEST(COALESCE(c.line_id, 1), 1) = ?
            AND COALESCE(c.handling_mode, 'ai') <> 'cs'
            AND COALESCE(c.ai_excluded, 0) = 0
            AND COALESCE(g.analyzed_anchor_id, 0) <> t.id
            AND NOT (COALESCE(g.status, '') = 'processing' AND g.anchor_id = t.id)
            AND NOT (COALESCE(g.status, '') = 'paused' AND g.anchor_id = t.id AND COALESCE(g.last_error, '') <> '')
            AND NOT EXISTS (SELECT 1 FROM whatsapp_ai_reviews r WHERE r.jid=t.jid AND r.status IN ('pending','processing'))
          ORDER BY t.created_at ASC
          LIMIT ?`,
        [since, currentLine(), batch * 5]
      )
      const candidates = (Array.isArray(result) ? result[0] : result) as Array<{
        jid: string
        created_at: Date | string
      }>
      let handled = 0
      for (const candidate of candidates || []) {
        if (handled >= batch) break
        const last = new Date(candidate.created_at as string).getTime()
        if (!Number.isFinite(last) || now - last < minAgeMs) continue
        if (this.pendingTurns.has(candidate.jid) || this.chatLocks.has(candidate.jid)) continue
        // Diperiksa ulang: mode bisa berubah antara kueri dan giliran ini.
        const contact = await db.from('whatsapp_contacts').where('jid', candidate.jid).first()
        if (contact?.handling_mode === 'cs' || contact?.ai_excluded) continue
        if (settings.beta3Mode) {
          const task = this.answerBacklogBeta3(candidate.jid, settings)
          this.chatLocks.set(candidate.jid, task)
          try {
            await task
          } finally {
            if (this.chatLocks.get(candidate.jid) === task) this.chatLocks.delete(candidate.jid)
            await this.setActivity(candidate.jid, null).catch(() => {})
          }
        } else await this.answerBacklog(candidate.jid, settings)
        handled += 1
      }
    } catch (error) {
      this.logger.error(`Sapuan: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.sweeping = false
    }
  }

  private async answerBacklog(jid: string, settings: Awaited<ReturnType<typeof readSettings>>) {
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    if (contact?.ai_excluded) return
    const lastOut = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .whereNotIn('status', ['failed', 'queued'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first()
    const unanswered = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'in')
      .where((query) => {
        if (lastOut)
          query
            .where('created_at', '>', lastOut.created_at)
            .orWhere((sameTime) =>
              sameTime.where('created_at', lastOut.created_at).where('id', '>', lastOut.id)
            )
      })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
    if (!unanswered.length) return
    // A deliberate non-answer about internals must not be retried every sweep.
    if (
      unanswered.every((row) => !row.media_type) &&
      isInternalOnlyQuestion(unanswered.map((row) => String(row.body || '')).join('\n'))
    )
      return

    const previous = this.chatLocks.get(jid) || Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (!this.socket) return
        const socket = this.socket
        if (!(await this.canSendAiReply(jid, socket))) return
        const goalRun = await beginGoalTurn(jid, String(unanswered.at(-1).message_id))
        if (!goalRun) return
        let trace: Awaited<ReturnType<typeof startTrace>> | undefined
        try {
          const ids = unanswered.map((row) => String(row.message_id))
          trace = await startTrace(jid, {
            text: unanswered
              .map((row) => String(row.body || ''))
              .filter(Boolean)
              .join('\n'),
            provider: settings.aiProvider,
            model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
            skills: settings.skills.map((skill) => skill.name),
            trigger: 'backlog',
            diagnosticsVersion: 2,
            messages: unanswered.map((row) => ({
              id: String(row.message_id),
              mediaType: row.media_type || null,
            })),
          }).catch(() => undefined)
          const context = await this.customerTurnContext(jid, ids, settings.historyLimit)
          trace?.emit({
            key: 'input',
            label: 'Input dan konteks siap',
            status: 'completed',
            detail: { efficiency: context.efficiency, promptCharacters: context.prompt.length },
          })
          const text = unanswered
            .map((row) => String(row.body || ''))
            .filter(Boolean)
            .join('\n')
          const images: AiContextImage[] = []
          for (const row of [...unanswered].reverse()) {
            const path = await this.imagePathOfMessage(String(row.message_id))
            if (path)
              images.push({
                path,
                messageId: String(row.message_id),
                label: images.length
                  ? 'gambar sebelumnya dari pesan tertunda'
                  : 'gambar terbaru dari pesan tertunda; referensi utama',
              })
            else if (
              !images.length &&
              ['image', 'video', 'gif', 'sticker'].includes(row.media_type)
            )
              throw new Error(
                'Gambar terbaru belum tersedia; gambar lama tidak boleh menggantikannya.'
              )
            if (images.length === 4) break
          }
          if (!text && !images.length) {
            const failure = aiFailureDetail(new Error('Media belum tersedia.'), {
              stage: 'processing',
            })
            const retry = await recordAnalysisFailure(goalRun, failure)
            if (retry)
              trace?.emit({
                key: 'analysis-retry',
                label: 'Pemulihan analisis dijadwalkan',
                status: 'completed',
                detail: retry,
              })
            await trace?.finish('failed', { error: failure.message, failure })
            return
          }
          const decision = await createReply(
            { ...settings, conversationAccess: context.access, routingContext: context.routing },
            text || '[Pelanggan mengirim media tanpa teks]',
            (activity) => {
              void this.setActivity(jid, activity).catch(() => {})
            },
            undefined,
            context.prompt,
            images.slice(0, 4),
            trace?.emit,
            text || '[Pelanggan mengirim media tanpa teks]',
            true,
            context.sections
          )
          decision.cartVersion = context.cartVersion
          await this.deliverAiDecision(
            goalRun,
            socket,
            settings,
            decision,
            ids.map((id) => ({ id, remoteJid: jid, fromMe: false })),
            false,
            trace
          )
          this.logger.info(
            `Sapuan: pemeriksaan ${ids.length} pesan di ${jid} berakhir (anchor=${goalRun.anchor_id})`
          )
        } catch (error) {
          const failure = aiFailureDetail(error, {
            stage: 'processing',
            provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
          })
          const retry = await recordAnalysisFailure(goalRun, failure)
          if (retry)
            trace?.emit({
              key: 'analysis-retry',
              label: retry.nextAttemptAt
                ? 'Analisis akan dicoba ulang otomatis'
                : 'Analisis memerlukan pemeriksaan',
              status: 'completed',
              detail: retry,
            })
          await trace?.finish('failed', { error: failure.message, failure })
          this.logger.error(JSON.stringify({ traceId: trace?.id, ...failure }))
          throw new AiProcessFailure(failure)
        }
      })
    this.chatLocks.set(jid, task)
    try {
      await task
    } finally {
      if (this.chatLocks.get(jid) === task) this.chatLocks.delete(jid)
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  /**
   * Beta 3: jawab pesan pelanggan yang belum dibalas (telat sinkron, masuk saat
   * offline, sapuan). Chat yang pesan terakhirnya sudah dianalisis (selesai, diam,
   * menunggu) dilewati oleh beginGoalTurn, jadi tidak dijawab dua kali.
   */
  private async answerBacklogBeta3(jid: string, settings: Awaited<ReturnType<typeof readSettings>>) {
    if (!this.socket || !isAiWorking(settings) || !settings.hasSkill) return
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    if (contact?.ai_excluded || contact?.handling_mode === 'cs') return
    const lastOut = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .whereNotIn('status', ['failed', 'queued'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first()
    const unanswered = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'in')
      .where((query) => {
        if (lastOut)
          query
            .where('created_at', '>', lastOut.created_at)
            .orWhere((sameTime) =>
              sameTime.where('created_at', lastOut.created_at).where('id', '>', lastOut.id)
            )
      })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
    if (!unanswered.length) return
    const newest = new Date(unanswered.at(-1).created_at).getTime()
    if (Date.now() - newest > Math.max(1, settings.sweepMaxAgeHours) * 3_600_000) return
    const goalRun = await beginGoalTurn(jid, String(unanswered.at(-1).message_id))
    if (!goalRun) return
    const images: Array<{ id: string; path: string }> = []
    for (const row of [...unanswered].reverse()) {
      if (images.length >= 3) break
      if (row.media_type !== 'image') continue
      const path = await this.imagePathOfMessage(String(row.message_id))
      if (path) images.unshift({ id: String(row.message_id), path })
    }
    const text = unanswered
      .map((row) => String(row.body || '').trim() || (row.media_type ? `[${row.media_type}]` : ''))
      .filter(Boolean)
      .join('\n')
    await this.runBeta3Turn(jid, goalRun, this.socket, settings, {
      text,
      messageIds: unanswered.map((row) => String(row.message_id)),
      keys: unanswered.map((row) => ({ remoteJid: jid, id: String(row.message_id), fromMe: false })),
      imagePaths: images.map((image) => image.path),
      imageIds: images.map((image) => image.id),
    })
  }

  private async canSendAiReply(jid: string, socket: WASocket) {
    if (this.stopping || this.socket !== socket || !this.readyForAi()) return false
    const settings = await readSettings()
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    return (
      isAiWorking(settings) &&
      settings.hasSkill &&
      contact?.handling_mode !== 'cs' &&
      !contact?.ai_excluded
    )
  }

  /** A replay/own-message echo is a temporary delivery barrier, not a cancelled turn. */
  private async waitForDeliverySync(socket: WASocket) {
    const deadline = Date.now() + 10_000
    while (!this.readyForAi()) {
      if (
        this.stopping ||
        this.socket !== socket ||
        !this.socketOpen ||
        !this.receivedPending ||
        Date.now() >= deadline
      )
        return false
      await wait(50)
    }
    return true
  }

  private workScheduleOpen = new Map<string, boolean>()

  private async consumeAiReviews() {
    if (this.reviewing || !this.socket || !this.readyForAi() || this.stopping) return
    this.reviewing = true
    try {
      const settings = await readSettings(true)
      if (settings.leanMode) {
        // Beta 2: pemeriksaan ulang ala Beta 1 (analisis penuh + MCP) tidak dipakai.
        await db
          .from('whatsapp_ai_reviews')
          .where('status', 'pending')
          .update({ status: 'skipped' })
        return
      }
      const working = isAiWorking(settings) && settings.hasSkill
      const scope = workspaceScope().prefix
      if (
        working &&
        this.workScheduleOpen.get(scope) !== true &&
        (settings.aiWorkMode === 'scheduled' || this.workScheduleOpen.get(scope) === false)
      ) {
        await requestRecentAiReviews('schedule_open', settings.sweepMaxAgeHours)
      }
      this.workScheduleOpen.set(scope, working)
      if (!working) return
      const requests = await db
        .from('whatsapp_ai_reviews as r')
        .leftJoin('whatsapp_contacts as c', 'c.jid', 'r.jid')
        .where('r.status', 'pending')
        .where((query) => query.whereNull('c.ai_excluded').orWhere('c.ai_excluded', false))
        .where((query) => query.whereNull('c.handling_mode').orWhereNot('c.handling_mode', 'cs'))
        .select('r.*', 'c.line_id')
        .orderBy('r.requested_at', 'asc')
        .limit(50)
      for (const request of requests) {
        if (this.pendingTurns.has(request.jid) || this.chatLocks.has(request.jid)) continue
        if (lineOf(request.line_id) !== currentLine()) continue
        if (
          await db
            .from('whatsapp_messages')
            .where('jid', request.jid)
            .where('status', 'queued')
            .first()
        )
          continue
        const claimed = await db
          .from('whatsapp_ai_reviews')
          .where('jid', request.jid)
          .where('version', request.version)
          .where('status', 'pending')
          .update({ status: 'processing' })
        if (!Number(claimed)) continue
        // Beta 3: pesan yang telat tersinkron / masuk saat offline / di luar jam kerja
        // dijawab lewat jalur Beta 3 (bukan analisis penuh Beta 1).
        const task = settings.beta3Mode
          ? this.answerBacklogBeta3(request.jid, settings)
          : this.reviewChat(request, settings)
        this.chatLocks.set(request.jid, task)
        try {
          await task
          await finishAiReview(request.jid, request.version)
        } catch (error) {
          await finishAiReview(request.jid, request.version, true)
          this.logger.error(`Pemeriksaan chat: ${String(error)}`)
        } finally {
          if (this.chatLocks.get(request.jid) === task) this.chatLocks.delete(request.jid)
          await this.setActivity(request.jid, null).catch(() => {})
        }
        break
      }
    } finally {
      this.reviewing = false
    }
  }

  private async consumeAnalysisRetries() {
    if (this.retryingAnalysis || this.stopping || !this.socket || !this.readyForAi()) return
    this.retryingAnalysis = true
    try {
      const settings = await readSettings(true)
      if (!isAiWorking(settings) || !settings.hasSkill || settings.leanMode || settings.beta3Mode)
        return
      await flushAnalysisFailures()
      if (!this.lastAnalysisRecoveryAt || Date.now() - this.lastAnalysisRecoveryAt >= 60_000) {
        await recoverInterruptedAnalyses()
        await recoverLegacyPausedAnalyses()
        await recoverCatalogConsentHandoffs()
        this.lastAnalysisRecoveryAt = Date.now()
      }
      const rows = await dueAnalysisRetries()
      for (const row of rows) {
        if (this.pendingTurns.has(row.jid) || this.chatLocks.has(row.jid)) continue
        const plan = await planProviderRun(settings)
        if (!plan.order.length) {
          const until = Math.min(...plan.limits.map((limit) => limit.until))
          await db
            .from('whatsapp_chat_goals')
            .where({ jid: row.jid, version: row.version, status: 'paused' })
            .update({
              next_run_at: new Date(
                Number.isFinite(until) ? Math.max(Date.now() + 30_000, until) : Date.now() + 60_000
              ),
            })
          continue
        }
        const task = this.reviewChat(
          { jid: row.jid, reason: 'analysis_retry', retryVersion: row.version },
          settings
        )
        this.chatLocks.set(row.jid, task)
        try {
          await task
        } catch (error) {
          this.logger.error(
            `Pemulihan analisis: ${error instanceof Error ? error.message : String(error)}`
          )
        } finally {
          if (this.chatLocks.get(row.jid) === task) this.chatLocks.delete(row.jid)
          await this.setActivity(row.jid, null).catch(() => {})
        }
        break
      }
    } finally {
      this.retryingAnalysis = false
    }
  }

  private async createReviewDecision(...args: Parameters<typeof createReply>) {
    return createReply(...args)
  }

  private async repairCartDesignNotes(...args: Parameters<typeof repairCatalogNotesWithAi>) {
    return repairCatalogNotesWithAi(...args)
  }

  private async reviewChat(
    request: { jid: string; reason: string; retryVersion?: string },
    settings: Awaited<ReturnType<typeof readSettings>>
  ) {
    const socket = this.socket
    const jid = request.jid
    if (!socket || !(await this.canSendAiReply(jid, socket))) return
    const anchor = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where((query) => query.where('direction', 'in').orWhereNot('sender_type', 'ai'))
      .whereNotIn('status', ['failed', 'queued'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first()
    if (!anchor) return
    const understandingOnly =
      request.reason !== 'human_decision' &&
      anchor.direction === 'out' &&
      ['cs', 'owner'].includes(anchor.sender_type)
    const run = await beginGoalTurn(jid, anchor.message_id, {
      humanDecision: request.reason === 'human_decision',
      retryFailed: request.reason === 'enabled',
      autoRetryVersion: request.reason === 'analysis_retry' ? request.retryVersion : undefined,
    })
    if (!run) return
    const trigger = `${understandingOnly ? 'MODE MEMAHAMI JAWABAN CS: pahami dan perbarui catatan/cart/goal saja. Jangan mengirim balasan, inisiatif, atau handoff ulang. Pilih silent dan status menunggu yang tepat atau completed.\n' : ''}Pemeriksaan ulang percakapan (${request.reason}). Ini pemicu internal, BUKAN pesan pelanggan baru.
Baca seluruh konteks termasuk jawaban CS/AI terakhir. Periksa kebutuhan yang belum ditangani dan langkah berikutnya menurut skill.
Jangan mengulang jawaban yang sudah dikirim atau membalas pesan CS seolah itu pertanyaan pelanggan.
Jika semua sudah dijawab atau sedang menunggu pelanggan, pilih silent; jangan mempercepat susulan terjadwal.
Jangan menganggap sedang menunggu data pelanggan bila pertanyaan data itu belum pernah dikirim. Catatan internal "belum menyatakan ingin checkout" bukan alasan diam ketika pilihan sudah disepakati dan pertanyaan tujuan ongkir belum pernah dikirim, kecuali pelanggan menunda/menolak. Meminta data berikutnya tidak mengizinkan checkout atau pembayaran.
Jika ada kebutuhan yang benar-benar terlewat, atau inisiatif langsung yang sudah memenuhi syarat skill, tangani dengan data bisnis terverifikasi.
Jangan menyebut pemeriksaan internal ini kepada pelanggan.`
    let trace: Awaited<ReturnType<typeof startTrace>> | undefined
    try {
      trace = await startTrace(jid, {
        text: trigger,
        provider: settings.aiProvider,
        model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
        skills: settings.skills.map((skill) => skill.name),
      })
      const context = await this.customerTurnContext(jid, [], settings.historyLimit)
      const imagePath = await this.imagePathOfMessage(anchor.message_id)
      const latestMessage = await db
        .from('whatsapp_messages')
        .where('jid', jid)
        .whereNotIn('status', ['queued', 'failed'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .first()
      let decision: AiDecision = await this.createReviewDecision(
        { ...settings, conversationAccess: context.access, routingContext: context.routing },
        trigger,
        (activity) => {
          void this.setActivity(jid, activity).catch(() => {})
        },
        undefined,
        context.prompt,
        imagePath
          ? [
              {
                path: imagePath,
                messageId: anchor.message_id,
                label: 'media dalam konteks percakapan',
              },
            ]
          : [],
        trace.emit,
        latestMessage?.direction === 'in' ? String(latestMessage.body || '') : '',
        true,
        context.sections
      )
      if (understandingOnly) decision = understandHumanAnswer(decision)
      decision.cartVersion = context.cartVersion
      await this.deliverAiDecision(
        run,
        socket,
        settings,
        decision,
        anchor.direction === 'in' ? [{ id: anchor.message_id, remoteJid: jid, fromMe: false }] : [],
        false,
        trace,
        undefined,
        understandingOnly
      )
    } catch (error) {
      const failure = aiFailureDetail(error, {
        stage: 'processing',
        provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt',
      })
      const retry = await recordAnalysisFailure(run, failure)
      if (retry)
        trace?.emit({
          key: 'analysis-retry',
          label: retry.nextAttemptAt
            ? 'Analisis akan dicoba ulang otomatis'
            : 'Analisis memerlukan pemeriksaan',
          status: 'completed',
          detail: retry,
        })
      await trace?.finish('failed', { error: failure.message, failure })
      this.logger.error(JSON.stringify({ traceId: trace?.id, ...failure }))
      throw new AiProcessFailure(failure)
    }
  }

  private async deliverAiDecision(
    run: GoalRun,
    socket: WASocket,
    settings: Awaited<ReturnType<typeof readSettings>>,
    decision: AiDecision,
    keys: WAMessageKey[],
    scheduled = false,
    trace?: Awaited<ReturnType<typeof startTrace>>,
    quoted?: WAMessage,
    understandingOnly = false
  ) {
    const jid = run.jid
    let guideMediaPrepared = false
    const canSend = async () => {
      if (!(await isCurrentGoalRun(run)) || !(await this.waitForDeliverySync(socket))) return false
      if (!(await this.canSendAiReply(jid, socket)) || !(await isCurrentGoalRun(run))) return false
      if (decision.cartVersion) {
        const cart = await readCart(jid)
        if (cart.version !== decision.cartVersion) return false
      }
      const latestSettings = await readSettings()
      try {
        if (guideMediaPrepared) selectedBusinessGuides(decision, latestSettings.mcpConnections)
      } catch {
        return false // A revoked/changed MCP source cannot send a previously prepared guide.
      }
      if (
        paymentDataSignature(latestSettings.paymentMethods) !==
        paymentDataSignature(settings.paymentMethods)
      )
        return false
      if (!scheduled) return true
      const current = await readSettings(true)
      return current.sweepEnabled && (await scheduledGoalStillAllowed(run, current.skills))
    }
    if (!(await canSend())) {
      await pauseGoalRun(run, 'Konteks, koneksi, atau status AI berubah.')
      await trace?.finish('cancelled', {
        reason: 'Konteks atau status berubah; keluaran lama dibatalkan.',
      })
      return
    }
    if (decision.indexReply) {
      const { indexReplyEligible } = await import('#services/index_reply')
      const { levelDigest, levelPolicyHash } = await import('#services/conversation_levels')
      const fresh = await this.customerTurnContext(
        jid,
        keys.map((key) => String(key.id || '')),
        settings.historyLimit
      )
      const currentSettings = await readSettings(true)
      if (
        !indexReplyEligible(fresh.routing, fresh.routing.activeState?.currentText || '') ||
        levelDigest(fresh.routing.activeState) !== decision.indexReply.stateDigest ||
        levelPolicyHash(currentSettings.skills) !== decision.indexReply.policyHash
      ) {
        throw new AiProcessFailure({
          stage: 'processing',
          code: 'AI_PROCESS_INTERRUPTED',
          message: 'State berubah sebelum balasan index dikirim.',
          action: 'Analisis ulang memakai state terbaru.',
          retryable: true,
        })
      }
    }
    if (decision.localResolution === 'closed_ack') {
      const { localAckGoal, levelPolicyHash } = await import('#services/conversation_levels')
      const fresh = await this.customerTurnContext(
        jid,
        keys.map((key) => String(key.id || '')),
        settings.historyLimit
      )
      const currentSettings = await readSettings(true)
      if (
        !localAckGoal(
          fresh.routing.activeState,
          fresh.routing.activeState?.currentText || '',
          levelPolicyHash(currentSettings.skills),
          false
        )
      ) {
        throw new AiProcessFailure({
          stage: 'processing',
          code: 'AI_PROCESS_INTERRUPTED',
          message: 'State berubah sebelum penyelesaian lokal.',
          action: 'Analisis ulang memakai state terbaru.',
          retryable: true,
        })
      }
    }
    let cartSelectionDeferred = false
    const missingSelection = incompleteCartSelection(decision.cartIntent)
    if (missingSelection.length && !scheduled && decision.cartVersion) {
      cartSelectionDeferred = true
      trace?.emit({
        key: 'cart-selection',
        label: 'Melanjutkan percakapan · pilihan belum lengkap',
        status: 'running',
        detail: { missingSelection, cartChanged: false },
      })
      if (understandingOnly) {
        decision = {
          ...decision,
          decision: 'silent',
          message: '',
          initiative: '',
          images: [],
          businessMedia: [],
          cartIntent: null,
          checkoutContinuity: null,
          customSizeQuestion: null,
          approvalWait: null,
          handoff_category: 'none',
        }
      } else {
        try {
          const context = await this.customerTurnContext(
            jid,
            keys.map((key) => String(key.id || '')),
            settings.historyLimit
          )
          const repaired = await this.createReviewDecision(
            { ...settings, conversationAccess: context.access, routingContext: context.routing },
            cartSelectionRecoveryPrompt(decision.cartIntent!),
            (activity) => {
              void this.setActivity(jid, activity).catch(() => {})
            },
            undefined,
            context.prompt,
            [],
            trace?.emit,
            ''
          )
          decision = conversationOnlyCartRecovery(decision, repaired)
        } catch (error) {
          trace?.emit({
            key: 'cart-selection',
            label: 'Kelanjutan percakapan belum valid',
            status: 'failed',
            detail: aiFailureDetail(error, { stage: 'processing' }),
          })
          throw error
        }
      }
      if (!(await canSend())) {
        await pauseGoalRun(run, 'Konteks berubah saat melengkapi pilihan.')
        await trace?.finish('cancelled', { reason: 'Konteks berubah; kelanjutan lama dibatalkan.' })
        return
      }
      trace?.emit({
        key: 'cart-selection',
        label: 'Percakapan dilanjutkan · cart tetap',
        status: 'completed',
        detail: { missingSelection, cartChanged: false, extraAiCalls: understandingOnly ? 0 : 1 },
      })
    }
    if (!(await markGoalDelivery(run))) return
    if (decision.localResolution === 'closed_ack') {
      // This path may only consume the incoming anchor. Never run checkout, cart,
      // media, memory, handoff or notification effects for a zero-model acknowledgment.
      const goal = await saveGoalDecision(run, decision, settings.skills, false)
      await trace?.finish(goal ? 'completed' : 'cancelled', {
        decision: 'silent',
        localResolution: 'closed_ack',
        tokens: 0,
        goal,
      })
      return
    }
    let firstMessageId: string | undefined
    if (!scheduled && decision.customerMemory?.length) {
      const started = performance.now()
      try {
        const saved = await saveCustomerMemory(jid, Number(run.anchor_id), decision.customerMemory)
        trace?.emit({
          key: 'customer-memory',
          label: 'Memori pelanggan diperbarui',
          status: 'completed',
          detail: {
            factsSaved: saved,
            elapsedMs: Math.round(performance.now() - started),
            source: 'original_messages',
            transactionalAuthority: false,
          },
        })
      } catch {
        trace?.emit({
          key: 'customer-memory',
          label: 'Memori pelanggan belum diperbarui',
          status: 'completed',
          detail: { fallback: 'original_history', replyBlocked: false },
        })
      }
    }
    if (decision.checkoutContinuity && decision.cartVersion && !scheduled && !understandingOnly) {
      const cart = await readCart(jid)
      if (cart.version === decision.cartVersion) {
        const reviewed = await recordCheckoutContinuity(cart, decision.checkoutContinuity)
        trace?.emit({
          key: 'checkout-context',
          label: 'Konteks persetujuan diperiksa',
          status: 'completed',
          detail: { reviewedMessages: reviewed, grantsNewConsent: false },
        })
      }
    }
    let settledCart: Awaited<ReturnType<typeof tryConfirmedBalanceCheckout>> = null
    let cartVerified = !cartSelectionDeferred
    if (decision.cartIntent) {
      if (scheduled || !decision.cartVersion)
        throw new Error('Perubahan cart memerlukan konteks pelanggan terbaru.')
      trace?.emit({ key: 'cart', label: 'Memperbarui cart', status: 'running' })
      try {
        let cart: Awaited<ReturnType<typeof applyAiCartIntent>>
        try {
          cart = await applyAiCartIntent(
            jid,
            decision.cartVersion,
            decision.cartIntent,
            decision.cartEvidence || { products: [], shipping: [] }
          )
        } catch (error) {
          const input = catalogNotesRepairInput(decision.cartIntent)
          if (
            !(error instanceof CartVerificationError) ||
            error.message !== CATALOG_NOTES_MISMATCH ||
            understandingOnly ||
            !input.length ||
            input.length > 20
          )
            throw error
          trace?.emit({
            key: 'cart-notes-recheck',
            label: 'Memperbaiki penulisan detail desain',
            status: 'running',
          })
          let repaired: ReturnType<typeof applyCatalogNotesRepair> = null
          try {
            repaired = applyCatalogNotesRepair(
              decision.cartIntent,
              await this.repairCartDesignNotes(settings, input, trace?.emit)
            )
          } catch {
            /* Failed repair does not authorize an unverified cart. */
          }
          if (!(await isCurrentGoalRun(run))) {
            await trace?.finish('cancelled', {
              reason: 'Pesan baru mengubah konteks saat pemeriksaan desain.',
            })
            return
          }
          trace?.emit({
            key: 'cart-notes-recheck',
            label: repaired
              ? 'Penulisan detail diperbaiki · verifikasi ulang'
              : 'Detail desain masih perlu diperiksa',
            status: repaired ? 'completed' : 'failed',
            detail: {
              attempts: 1,
              code: repaired ? 'CATALOG_NOTES_REPAIRED' : 'CATALOG_NOTES_REPAIR_UNRESOLVED',
            },
          })
          if (!repaired) throw error
          cart = await applyAiCartIntent(
            jid,
            decision.cartVersion,
            repaired,
            decision.cartEvidence || { products: [], shipping: [] }
          )
          decision.cartIntent = repaired
        }
        // One bounded evidence repair, not recursive retries or a human-approval request.
        if (
          cart.catalogIssues?.length &&
          cart.issues?.length === cart.catalogIssues.length &&
          !understandingOnly
        ) {
          const originalIntent = decision.cartIntent
          trace?.emit({
            key: 'catalog-recheck',
            label: 'Memeriksa ulang data katalog · MCP',
            status: 'running',
          })
          try {
            const context = await this.customerTurnContext(jid, [], settings.historyLimit)
            const repair = await this.createReviewDecision(
              { ...settings, conversationAccess: context.access, routingContext: context.routing },
              `PEMERIKSAAN KATALOG ULANG (maksimal satu kali pada giliran ini). Pilihan pelanggan sudah disimpan sebagai draft, BUKAN order atau harga terverifikasi.\nMasalah: ${JSON.stringify(cart.catalogIssues)}\nPeriksa ulang tool MCP untuk ukuran, harga dan stok produk yang sama. Jangan mengubah identitas produk/ukuran/jumlah/model agar lolos validasi. Pre-order mengikuti pengaturan lokal, bukan stok ready atau label MCP; jangan menjanjikan ketersediaan atau mengarang harga. Kekurangan bukti MCP bukan alasan meminta persetujuan CS.\nJika bukti tersedia, sync pilihan yang sama dengan data terverifikasi. Jika belum, jangan meminta pembayaran/konfirmasi rekap atau meneruskan ke CS. Lanjutkan satu pertanyaan pilihan yang masih diperlukan sesuai skill dan konteks (contoh pilihan jas saja atau bersama celana, hanya bila belum dijawab). Jangan ulangi konfirmasi size/fit yang sudah disetujui. Tulis pertanyaan saja tanpa klaim harga, stok, estimasi atau kemampuan custom. Jika tidak ada pertanyaan relevan, silent dan jelaskan kebutuhan verifikasi internal di goal.`,
              (activity) => {
                void this.setActivity(jid, activity).catch(() => {})
              },
              undefined,
              context.prompt,
              [],
              trace?.emit,
              ''
            )
            if (!(await isCurrentGoalRun(run))) {
              await trace?.finish('cancelled', {
                reason: 'Pesan baru mengubah konteks saat verifikasi katalog.',
              })
              return
            }
            const proposed = repair.cartIntent
            const sameSelection =
              proposed?.action === 'sync' &&
              proposed.items.length === originalIntent.items.length &&
              originalIntent.items.every((item) =>
                proposed.items.some(
                  (next) =>
                    next.productId === item.productId &&
                    next.name === item.name &&
                    next.size === item.size &&
                    next.quantity === item.quantity &&
                    (next.modelType || 'catalog') === (item.modelType || 'catalog')
                )
              )
            if (sameSelection) {
              cart = await applyAiCartIntent(
                jid,
                cart.version,
                {
                  ...originalIntent,
                  items: originalIntent.items.map((item, index) => ({
                    ...item,
                    id: cart.items[index].id,
                    unitPrice: proposed!.items.find(
                      (next) => next.productId === item.productId && next.size === item.size
                    )!.unitPrice,
                  })),
                },
                repair.cartEvidence || { products: [], shipping: [] }
              )
            }
            decision = { ...repair, cartVersion: cart.version, cartIntent: null }
            trace?.emit({
              key: 'catalog-recheck',
              label: cart.catalogIssues?.length
                ? 'Draft tersimpan · verifikasi katalog tertunda'
                : 'Data katalog terverifikasi',
              status: 'completed',
              detail: {
                attempts: 1,
                issues: cart.catalogIssues || [],
                humanApprovalRequired: false,
              },
            })
          } catch {
            // Keep the original skill-written safe question if the lookup/provider is unavailable.
            // The draft remains non-payable; never mask this as a successful verification.
            trace?.emit({
              key: 'catalog-recheck',
              label: 'Pemeriksaan ulang belum tersedia · draft disimpan',
              status: 'completed',
              detail: { attempts: 1, issues: cart.catalogIssues, verified: false },
            })
          }
        }
        decision.cartVersion = cart.version
        if (cart.settledOrder) settledCart = { ...cart, settledOrder: cart.settledOrder }
        cartVerified = !cart.issues?.length
        if (cart.issues?.length) decision = resolveCartIssues(decision, cart, understandingOnly)
        trace?.emit({
          key: 'cart',
          label: cart.settledOrder
            ? 'Pesanan lunas dari saldo'
            : cart.catalogIssues?.length
              ? 'Draft tersimpan · menunggu verifikasi katalog'
              : cart.items.some((item) => item.unitPrice === null)
                ? 'Cart tersimpan · menunggu harga'
                : cart.items.some(
                      (item) => item.size === 'custom' && !Object.keys(item.measurements).length
                    )
                  ? 'Cart tersimpan · menunggu ukuran'
                  : 'Cart diperbarui',
          status: 'completed',
          detail: {
            itemsSaved: cart.items.length,
            issues: cart.issues || [],
            catalogIssues: cart.catalogIssues || [],
            ...(cart.settledOrder
              ? {
                  orderNumber: cart.settledOrder.number,
                  balanceApplied: cart.settledOrder.balanceApplied,
                }
              : {}),
          },
        })
      } catch (error) {
        if (error instanceof CheckoutConsentError) {
          decision = holdCheckoutForReview(decision, error)
          cartVerified = false
          trace?.emit({
            key: 'cart',
            label: 'Checkout menunggu pemeriksaan',
            status: 'completed',
            detail: error.detail,
          })
        } else {
          if (!(error instanceof CartVerificationError)) {
            trace?.emit({
              key: 'cart',
              label: 'Cart perlu diperiksa',
              status: 'failed',
              detail: { error: (error as Error).message },
            })
            throw error
          }
          // Continue through current-context checks and the normal goal/handoff path.
          // Understanding a CS reply must never bounce the room straight back to CS.
          decision =
            error instanceof CatalogLookupError
              ? holdCatalogDraft(decision, [error.issue], understandingOnly)
              : holdUnverifiedCartReply(decision, error.message, understandingOnly)
          if (error instanceof CartReferenceError && decision.goal) {
            decision.goal.waiting_for = 'Pemeriksaan referensi foto model custom oleh CS'
            decision.goal.next_action =
              'Cocokkan message_id foto pelanggan di room ini dan pastikan apakah pilihannya model custom atau hanya ukuran custom pada produk katalog. Jangan meminta foto ulang sebelum memeriksa riwayat.'
          }
          cartVerified = false
          trace?.emit({
            key: 'cart',
            label: 'Cart menunggu verifikasi',
            status: 'completed',
            detail: {
              reason: error.message,
              decision: decision.decision,
              ...(error instanceof CartReferenceError
                ? { code: error.code, referenceIssue: error.referenceIssue }
                : {}),
            },
          })
        }
      }
    }
    if (
      !decision.indexReply &&
      !settledCart &&
      cartVerified &&
      !scheduled &&
      !understandingOnly &&
      decision.cartVersion
    ) {
      try {
        settledCart = await tryConfirmedBalanceCheckout(jid, decision.cartVersion)
      } catch (error) {
        if (!(error instanceof CheckoutConsentError)) throw error
        decision = holdCheckoutForReview(decision, error)
        trace?.emit({
          key: 'balance-checkout',
          label: 'Checkout menunggu pemeriksaan',
          status: 'completed',
          detail: error.detail,
        })
      }
    }
    if (settledCart) {
      const order = settledCart.settledOrder
      const rupiah = (amount: number) => `Rp${amount.toLocaleString('id-ID')}`
      // A pre-checkout reply/handoff may now be stale. Only report the committed receipt.
      decision = {
        ...decision,
        decision: 'reply',
        handoff_category: 'none',
        approvalWait: null,
        reason: '',
        cartIntent: null,
        images: [],
        initiative: '',
        message: `Terima kasih, bos. Pesanannya sudah lunas menggunakan kelebihan pembayaran sebelumnya.\n\nNomor pesanan: ${order.number}\nTotal: ${rupiah(order.total)}\nSisa kelebihan pembayaran: ${rupiah(settledCart.paymentQuote.availableBalance)}`,
        goal: {
          objective: `Memproses pesanan ${order.number}`,
          status: 'waiting',
          waiting_for: 'Perkembangan pengerjaan atau pengiriman pesanan',
          next_action:
            'Pantau status order; jangan meminta pembayaran atau persetujuan yang sudah sah lagi.',
          follow_up: null,
        },
      }
    }
    if (settledCart) {
      decision.cartVersion = settledCart.version
      trace?.emit({
        key: 'balance-checkout',
        label: 'Pesanan lunas dari saldo',
        status: 'completed',
        detail: {
          orderNumber: settledCart.settledOrder.number,
          balanceApplied: settledCart.settledOrder.balanceApplied,
        },
      })
    }
    if (decision.decision === 'reply') {
      let prepared: Awaited<ReturnType<typeof prepareOutgoingImages>>
      try {
        const guides = await prepareBusinessGuideMedia(jid, decision, settings.mcpConnections)
        prepared = await prepareOutgoingImages(
          jid,
          guides.decision,
          settings.mcpConnections,
          scheduled
        )
        prepared.images.push(...guides.media)
        guideMediaPrepared = true
        if (prepared.images.length)
          trace?.emit({
            key: 'outgoing-media',
            label: 'Media balasan siap',
            status: 'completed',
            detail: { count: prepared.images.length },
          })
      } catch (error) {
        trace?.emit({
          key: 'outgoing-media',
          label: 'Menyiapkan media balasan',
          status: 'failed',
          detail: {
            error: error instanceof Error ? error.message : 'Media belum dapat disiapkan.',
          },
        })
        throw error
      }
      decision = prepared.decision
      let imageNumber = 0
      const complete = await sendAiMessageSequence(
        decision,
        scheduled,
        canSend,
        async (body, kind, image) => {
          const traceKey = image
            ? `send-image-${++imageNumber}`
            : kind === 'answer'
              ? 'send'
              : 'initiative'
          return trackOutgoingMessage(jid, async (outgoingId) => {
            const sent = await sendPreparedReply(
              socket,
              jid,
              firstMessageId ? [] : keys,
              () =>
                socket.sendMessage(jid, outgoingMessagePayload(body, image), {
                  messageId: outgoingId,
                  ...(kind === 'answer' && quoted ? { quoted } : {}),
                }),
              {
                canSend,
                read: () =>
                  firstMessageId
                    ? Promise.resolve()
                    : readIncomingThrough(socket, jid, Number(run.anchor_id), canSend),
                onTyping: async () => {
                  await this.setActivity(jid, 'typing')
                  trace?.emit({
                    key: traceKey,
                    label: image
                      ? 'Mengirim media · Typing'
                      : kind === 'answer'
                        ? 'Menyiapkan balasan · Typing'
                        : 'Menyiapkan inisiatif · Typing',
                    status: 'running',
                  })
                },
                onDone: () => this.setActivity(jid, null),
              }
            )
            if (sent === null) return false
            if (!sent?.key.id) throw new Error('Pengiriman belum dikonfirmasi.')
            const messageId = sent?.key.id || `ai-${randomUUID()}`
            await saveSentAiMessage({
              message_id: messageId,
              jid,
              contact_name: quoted?.pushName || null,
              direction: 'out',
              sender_type: 'ai',
              body,
              media_type: image ? image.mediaType || 'image' : null,
              media_url: image?.mediaUrl || null,
              thumbnail_url:
                image && (!image.mediaType || image.mediaType === 'image') ? image.mediaUrl : null,
              media_mime: image ? image.mime || 'image/jpeg' : null,
              media_name: image?.fileName || null,
              media_size: image?.bytes.length || null,
              media_status: image ? 'ready' : null,
              reply_to_message_id: kind === 'answer' ? quoted?.key.id || null : null,
              status: 'sent',
              created_at: new Date(),
            })
            if (decision.cartVersion && !image)
              await recordBalanceRecap(jid, decision.cartVersion, messageId, body)
            if (!firstMessageId) {
              // A delivered AI answer has handled this snapshot, not messages that arrived
              // while it was thinking/sending. Never use the new outgoing row as the watermark.
              await markRoomRead(jid, run.anchor_id).catch(() => {
                // The reply is already sent: an unread-badge failure must not resend it.
                this.logger.error('Status baca workspace belum diperbarui.')
              })
            }
            firstMessageId ||= messageId
            trace?.emit({
              key: traceKey,
              label: image
                ? 'Media terkirim'
                : kind === 'answer'
                  ? 'Balasan terkirim'
                  : 'Inisiatif terkirim terpisah',
              status: 'completed',
            })
            return true
          })
        },
        prepared.images
      )
      if (!complete) {
        await pauseGoalRun(run, 'Pesan berikutnya dibatalkan karena konteks atau status berubah.')
        await trace?.finish(
          'cancelled',
          { reason: 'Pesan berikutnya dibatalkan karena konteks atau status berubah.' },
          firstMessageId
        )
        return
      }
    }
    if (!(await canSend())) {
      await pauseGoalRun(run, 'Konteks berubah setelah pengiriman; jadwal lama tidak diteruskan.')
      await trace?.finish(
        'cancelled',
        { reason: 'Konteks berubah; jadwal lama dibatalkan.' },
        firstMessageId
      )
      return
    }
    const goal = await saveGoalDecision(run, decision, settings.skills, scheduled)
    if (!goal) {
      await trace?.finish(
        'cancelled',
        { reason: 'Tujuan berubah; keputusan lama tidak diterapkan.' },
        firstMessageId
      )
      return
    }
    if (!(await handleInternalDecision(jid, decision)) && decision.note)
      await saveChatNote(jid, decision.note)
    trace?.emit({
      key: 'goal',
      label: goal?.next_run_at
        ? 'Tujuan disimpan · susulan dijadwalkan'
        : 'Tujuan percakapan disimpan',
      status: 'completed',
      detail: goal,
    })
    await trace?.finish(
      'completed',
      {
        decision: decision.decision,
        summary: decision.reason,
        handoffCategory: decision.handoff_category,
        businessLookupRequired: decision.business_lookup_required,
        goal,
      },
      firstMessageId
    )
  }

  /** Beta 2: susulan yang disiapkan AI pada giliran sebelumnya; dikirim tanpa panggilan AI. */
  private async runLeanNudge(jid: string, socket: WASocket) {
    const nudge = await claimLeanNudge(jid)
    if (!nudge) return
    const canSend = async () =>
      (await this.waitForDeliverySync(socket)) && (await this.canSendAiReply(jid, socket))
    try {
      await trackOutgoingMessage(jid, async (outgoingId) => {
        const sent = await sendPreparedReply(
          socket,
          jid,
          [],
          () => socket.sendMessage(jid, { text: nudge.text }, { messageId: outgoingId }),
          {
            canSend,
            onTyping: async () => {
              await this.setActivity(jid, 'typing')
            },
            onDone: () => this.setActivity(jid, null),
          }
        )
        if (!sent?.key.id) return false
        await saveSentAiMessage({
          message_id: sent.key.id,
          jid,
          contact_name: null,
          direction: 'out',
          sender_type: 'ai',
          body: nudge.text,
          media_type: null,
          media_url: null,
          thumbnail_url: null,
          media_mime: null,
          media_name: null,
          media_size: null,
          media_status: null,
          reply_to_message_id: null,
          status: 'sent',
          created_at: new Date(),
        })
        return true
      })
    } catch (error) {
      this.logger.error(`Susulan lean: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  private async runBeta3Nudge(jid: string, socket: WASocket) {
    const nudge = await beta3.claimLeanNudge(jid)
    if (!nudge) return
    const canSend = async () =>
      (await this.waitForDeliverySync(socket)) && (await this.canSendAiReply(jid, socket))
    try {
      await trackOutgoingMessage(jid, async (outgoingId) => {
        const sent = await sendPreparedReply(
          socket,
          jid,
          [],
          () => socket.sendMessage(jid, { text: nudge.text }, { messageId: outgoingId }),
          {
            canSend,
            onTyping: async () => {
              await this.setActivity(jid, 'typing')
            },
            onDone: () => this.setActivity(jid, null),
          }
        )
        if (!sent?.key.id) return false
        await saveSentAiMessage({
          message_id: sent.key.id,
          jid,
          contact_name: null,
          direction: 'out',
          sender_type: 'ai',
          body: nudge.text,
          media_type: null,
          media_url: null,
          thumbnail_url: null,
          media_mime: null,
          media_name: null,
          media_size: null,
          media_status: null,
          reply_to_message_id: null,
          status: 'sent',
          created_at: new Date(),
        })
        return true
      })
    } catch (error) {
      this.logger.error(`Susulan lean: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  private async sweepConversationGoals() {
    if (this.goalSweepRunning || !this.socket || !this.readyForAi() || this.stopping) return
    this.goalSweepRunning = true
    try {
      const settings = await readSettings(true)
      if (!isAiWorking(settings) || !settings.hasSkill || !settings.sweepEnabled) return
      for (const goal of await dueConversationGoals()) {
        const contact = await db.from('whatsapp_contacts').where('jid', goal.jid).first()
        if (contact?.ai_excluded) continue
        if (lineOf(contact?.line_id) !== currentLine()) continue
        if (
          await db
            .from('whatsapp_ai_reviews')
            .where('jid', goal.jid)
            .whereIn('status', ['pending', 'processing'])
            .first()
        )
          continue
        const jid = String(goal.jid)
        if (this.pendingTurns.has(jid) || this.chatLocks.has(jid)) continue
        const task = this.runScheduledGoal(jid)
        this.chatLocks.set(jid, task)
        try {
          await task
        } finally {
          if (this.chatLocks.get(jid) === task) this.chatLocks.delete(jid)
        }
      }
    } catch (error) {
      this.logger.error(`Goal: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.goalSweepRunning = false
    }
  }

  private async runScheduledGoal(jid: string) {
    const socket = this.socket
    if (!socket || !(await this.canSendAiReply(jid, socket))) return
    const settings = await readSettings(true)
    if (!settings.sweepEnabled) return
    if (settings.beta3Mode) return this.runBeta3Nudge(jid, socket)
    if (settings.leanMode) return this.runLeanNudge(jid, socket)
    const run = await claimConversationGoal(jid, settings.skills)
    if (!run) return
    let trace: Awaited<ReturnType<typeof startTrace>> | undefined
    try {
      const trigger =
        'PEMICU SUSULAN TERJADWAL: tidak ada pesan pelanggan baru. Satu percobaan susulan saat ini sudah dicadangkan dalam followup_attempts_reserved. Periksa ulang kelayakan, skill, dan data bisnis; hanya satu pesan jika masih sesuai. Jangan mengulang jawaban sebelumnya. Jika tidak layak, silent tanpa jadwal baru.'
      trace = await startTrace(jid, {
        text: trigger,
        provider: settings.aiProvider,
        model: settings.aiProvider === 'claude' ? settings.claudeModel : settings.chatgptModel,
        skills: settings.skills.map((skill) => skill.name),
        messages: [],
        trigger: 'scheduled_goal',
      })
      const context = await this.customerTurnContext(jid, [], settings.historyLimit)
      const decision = await createReply(
        { ...settings, conversationAccess: context.access, routingContext: context.routing },
        trigger,
        (activity) => {
          void this.setActivity(jid, activity).catch(() => {})
        },
        undefined,
        context.prompt,
        [],
        trace.emit,
        ''
      )
      decision.cartVersion = context.cartVersion
      await this.deliverAiDecision(run, socket, settings, decision, [], true, trace)
    } catch (error) {
      await pauseGoalRun(run, 'Susulan gagal; tidak diulang otomatis untuk mencegah pesan ganda.')
      await trace?.finish('failed', {
        error: 'Susulan gagal; jadwal dihentikan. Periksa log server.',
      })
      this.logger.error(`Goal: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await this.setActivity(jid, null).catch(() => {})
    }
  }

  /** Nomor utama yang sedang tidak terhubung tetap menjalankan tugas workspace (katalog, rekap). */
  private idleScope?: WorkspaceScope
  private leanSyncRunning = false
  private lastIdleScopeAt = 0
  private timerScope() {
    return this.sessionScope ?? this.idleScope
  }

  private ensureWorkspaceTimers() {
    if (!this.recapTimer && this.primary) {
      // Beta 3: rekap order dari chat CS manusia (tombol di halaman Order), satu chat
      // per menit, tanpa pesan ke pelanggan. Hanya berjalan setelah tombol ditekan.
      this.recapTimer = setInterval(() => {
        const scope = this.timerScope()
        if (!scope || this.recapRunning) return
        this.recapRunning = true
        void inWorkspace(scope, async () => {
          try {
            const settings = await readSettings(true)
            if (!settings.beta3Mode || !settings.aiEnabled || !settings.hasSkill) return
            await beta3Recap.runRecapStep()
          } catch (error) {
            this.logger.error(`Rekap order: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            this.recapRunning = false
          }
        })
      }, 60_000)
    }
    if (!this.leanSyncTimer && this.primary) {
      // Beta 2: katalog/TOKO/bahan ditarik sendiri tiap 30 menit (murah: if_version), lalu ciri foto di latar.
      const syncLean = () => {
        const scope = this.timerScope()
        if (!scope || this.leanSyncRunning) return
        this.leanSyncRunning = true
        // Tanpa soket nomor utama, sinkron berjalan di latar tanpa menahan koneksi baru.
        const run = (task: () => Promise<void>) => (this.socket ? this.track(task) : task())
        void inWorkspace(scope, () =>
          run(async () => {
            const settings = await readSettings(true)
            if (!settings.leanMode && !settings.beta3Mode) {
              this.leanSyncRunning = false
              return
            }
            try {
              const result = settings.beta3Mode
                ? await beta3.syncLeanCatalog()
                : await syncLeanCatalog()
              if (result.configured && !result.unchanged)
                this.logger.info(
                  `${settings.beta3Mode ? 'Beta 3' : 'Beta 2'}: katalog disinkronkan (${result.count} varian).`
                )
              if (result.configured) {
                if (settings.beta3Mode) await beta3.describeCatalogPhotos()
                else await describeCatalogPhotos()
              }
              // Update ringan: skill terbaru dari rilis online, tanpa `wa update`.
              if (settings.beta3Mode)
                await beta3SkillSync.syncRemoteSkills((line) => this.logger.info(line)).catch(() => {})
            } catch (error) {
              this.logger.warning(
                `Beta 2: sync katalog gagal: ${error instanceof Error ? error.message : String(error)}`
              )
            } finally {
              this.leanSyncRunning = false
            }
          })
        ).catch(() => (this.leanSyncRunning = false))
      }
      setTimeout(syncLean, 20_000)
      this.leanSyncTimer = setInterval(syncLean, LEAN_SYNC_INTERVAL_MS)
    }
  }

  private async disconnect() {
    const socket = this.socket
    const wasOpen = this.socketOpen
    this.socket = undefined
    this.socketOpen = false
    this.receivedPending = false
    for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer)
    this.pendingTurns.clear()
    await this.closeSocket(socket, wasOpen)
    await Promise.allSettled([...this.chatLocks.values(), this.ingestion])
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
    this.chatLocks.clear()
    this.syncRetryFallback.clear()
    this.ingestion = Promise.resolve()
    this.sessionScope = undefined
    await clearWorkspaceSession()
    await this.setState({
      status: 'disconnected',
      phone: null,
      qr_data_url: null,
      last_error: null,
    })
  }
}
