import { createHash, randomBytes } from 'node:crypto'
import hash from '@adonisjs/core/services/hash'
import env from '#start/env'
import db from '#services/workspace_database'

/**
 * Login lokal (mode standalone): akun pemilik disimpan di tabel wa_users milik
 * aplikasi ini sendiri. Aktif bila ACCOUNT_URL kosong atau AUTH_MODE=local;
 * server bundle (ACCOUNT_URL terisi) tetap memakai OAuth Account seperti semula.
 */
export function isLocalAuth() {
  const mode = String(env.get('AUTH_MODE') || '').toLowerCase()
  if (mode === 'local') return true
  if (mode === 'oauth') return false
  return !String(env.get('ACCOUNT_URL') || '').trim()
}

export async function ensureUsersTable() {
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS wa_users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NOT NULL,
    last_login_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

const normalizeEmail = (email: string) =>
  String(email || '')
    .trim()
    .toLowerCase()

export async function countUsers() {
  await ensureUsersTable()
  const row = await db.from('wa_users').count('* as total').first()
  return Number(row?.total || 0)
}

export function validatePassword(password: string) {
  if (String(password || '').length < 8) throw new Error('Password minimal 8 karakter.')
}

export async function createUser(input: { email: string; name: string; password: string }) {
  await ensureUsersTable()
  const email = normalizeEmail(input.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email tidak valid.')
  validatePassword(input.password)
  const now = new Date()
  const [id] = await db.table('wa_users').insert({
    email,
    name:
      String(input.name || '')
        .trim()
        .slice(0, 120) || email.split('@')[0],
    password_hash: await hash.make(input.password),
    created_at: now,
    updated_at: now,
  })
  return Number(id)
}

export async function resetPassword(email: string, password: string) {
  await ensureUsersTable()
  validatePassword(password)
  const changed = await db
    .from('wa_users')
    .where('email', normalizeEmail(email))
    .update({ password_hash: await hash.make(password), updated_at: new Date() })
  if (!Number(changed)) throw new Error('Email tidak terdaftar.')
}

// Batas percobaan: 5 gagal per email+IP dalam 15 menit.
const attempts = new Map<string, { count: number; until: number }>()
const LIMIT = 5
const WINDOW_MS = 15 * 60_000

export function loginBlocked(key: string) {
  const entry = attempts.get(key)
  if (!entry) return false
  if (entry.until < Date.now()) {
    attempts.delete(key)
    return false
  }
  return entry.count >= LIMIT
}

function recordFailure(key: string) {
  const entry = attempts.get(key)
  if (!entry || entry.until < Date.now())
    attempts.set(key, { count: 1, until: Date.now() + WINDOW_MS })
  else entry.count += 1
}

export async function verifyUser(email: string, password: string, ip: string) {
  await ensureUsersTable()
  const key = `${normalizeEmail(email)}|${ip}`
  if (loginBlocked(key)) throw new Error('Terlalu banyak percobaan. Coba lagi 15 menit lagi.')
  const user = await db.from('wa_users').where('email', normalizeEmail(email)).first()
  const ok = user ? await hash.verify(String(user.password_hash), String(password || '')) : false
  if (!ok) {
    recordFailure(key)
    throw new Error('Email atau password salah.')
  }
  attempts.delete(key)
  await db.from('wa_users').where('id', user.id).update({ last_login_at: new Date() })
  return { id: Number(user.id), email: String(user.email), name: String(user.name || '') }
}

/** Bentuk sesi yang sama dengan mode OAuth supaya layout/middleware tidak berubah. */
export function localSession(user: { id: number; email: string; name: string }) {
  return {
    local: true,
    sub: createHash('sha256').update(`local:${user.id}:${user.email}`).digest('hex'),
    issuer: '',
    sessionToken: randomBytes(32).toString('base64url'),
    name: user.name || user.email,
    username: user.email,
    picture: '',
    checkedAt: Date.now(),
  }
}
