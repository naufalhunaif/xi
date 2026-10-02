import encryption from '@adonisjs/core/services/encryption'
import { randomBytes } from 'node:crypto'
import db from '#services/workspace_database'
import { readLeanState, writeLeanState } from '#beta3/tables'
import { workspaceScope } from '#services/workspace_context'

/**
 * Instagram (DM & komentar) lewat Instagram API with Instagram Login.
 * Konfigurasi disimpan per workspace di whatsapp_beta3_state; secret & token dienkripsi.
 * Room Instagram memakai jid "<IGSID>@ig" sehingga inbox, AI Beta 3, order, dan
 * catatan memakai tabel yang sama dengan WhatsApp.
 */
export const IG_SUFFIX = '@ig'
export const isIgJid = (jid: unknown) => String(jid || '').endsWith(IG_SUFFIX)
export const igJid = (igsid: string) => `${String(igsid).replace(/\D/g, '')}${IG_SUFFIX}`
export const igsidOf = (jid: string) => String(jid).replace(/@ig$/, '')

const PURPOSE = 'instagram'
const secretKeys = new Set(['ig_app_secret', 'ig_token'])

async function readKey(name: string) {
  const value = await readLeanState(name)
  if (!value || !secretKeys.has(name)) return value
  try {
    return String(encryption.decrypt<string>(value, PURPOSE) || '')
  } catch {
    return ''
  }
}
async function writeKey(name: string, value: string) {
  await writeLeanState(name, value && secretKeys.has(name) ? encryption.encrypt(value, undefined, PURPOSE) : value)
}

export type IgConfig = {
  appId: string
  appSecret: string
  verifyToken: string
  token: string
  tokenExpires: number
  userId: string
  username: string
  comments: boolean
  lastWebhookAt: number
  lastError: string
}

export async function readIgConfig(): Promise<IgConfig> {
  let verifyToken = await readKey('ig_verify_token')
  if (!verifyToken) {
    verifyToken = randomBytes(18).toString('base64url')
    await writeKey('ig_verify_token', verifyToken)
  }
  return {
    appId: await readKey('ig_app_id'),
    appSecret: await readKey('ig_app_secret'),
    verifyToken,
    token: await readKey('ig_token'),
    tokenExpires: Number(await readKey('ig_token_expires')) || 0,
    userId: await readKey('ig_user_id'),
    username: await readKey('ig_username'),
    comments: (await readKey('ig_comments')) !== '0',
    lastWebhookAt: Number(await readKey('ig_last_webhook_at')) || 0,
    lastError: await readKey('ig_last_error'),
  }
}

export async function saveIgConfig(values: Partial<Record<'appId' | 'appSecret' | 'comments', string>>) {
  if (values.appId !== undefined) await writeKey('ig_app_id', values.appId.replace(/\D/g, '').slice(0, 30))
  if (values.appSecret !== undefined && values.appSecret.trim())
    await writeKey('ig_app_secret', values.appSecret.trim().slice(0, 100))
  if (values.comments !== undefined) await writeKey('ig_comments', values.comments === '0' ? '0' : '1')
}

export async function saveIgAccount(input: { token: string; expiresIn: number; userId: string; username: string }) {
  await writeKey('ig_token', input.token)
  await writeKey('ig_token_expires', String(Date.now() + Math.max(0, input.expiresIn) * 1000))
  await writeKey('ig_user_id', input.userId)
  await writeKey('ig_username', input.username)
  await writeKey('ig_last_error', '')
}

export async function updateIgToken(token: string, expiresIn: number) {
  await writeKey('ig_token', token)
  await writeKey('ig_token_expires', String(Date.now() + Math.max(0, expiresIn) * 1000))
}

export async function clearIgAccount() {
  for (const key of ['ig_token', 'ig_token_expires', 'ig_user_id', 'ig_username', 'ig_last_error'])
    await writeKey(key, '')
}

export const noteIgWebhook = () => writeKey('ig_last_webhook_at', String(Date.now()))
export const noteIgError = (message: string) => writeKey('ig_last_error', message.slice(0, 300))

const ready = new Set<string>()
export async function ensureIgTables() {
  const key = workspaceScope().prefix
  if (ready.has(key)) return
  // Giliran AI per room (pesan pelanggan digabung beberapa detik seperti WhatsApp).
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_ig_turns (
    jid VARCHAR(190) NOT NULL PRIMARY KEY,
    anchor_message_id VARCHAR(190) NOT NULL,
    due_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  // Komentar di postingan: dijawab lewat DM (private reply, sekali per komentar).
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_ig_comments (
    comment_id VARCHAR(80) NOT NULL PRIMARY KEY,
    media_id VARCHAR(80) NULL,
    from_id VARCHAR(80) NOT NULL,
    username VARCHAR(190) NULL,
    body TEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    reply TEXT NULL,
    error VARCHAR(300) NULL,
    created_at DATETIME NOT NULL,
    processed_at DATETIME NULL,
    KEY whatsapp_ig_comments_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  // Halaman Komentar: info postingan, balasan publik, dan permintaan balas ulang oleh AI.
  for (const column of [
    'media_caption TEXT NULL',
    'permalink VARCHAR(500) NULL',
    'public_reply TEXT NULL',
    'force_ai TINYINT(1) NOT NULL DEFAULT 0',
    'media_image VARCHAR(500) NULL',
    'media_checked TINYINT(1) NOT NULL DEFAULT 0',
  ])
    await db.rawQuery(`ALTER TABLE whatsapp_ig_comments ADD COLUMN IF NOT EXISTS ${column}`)
  ready.add(key)
}
