// v3.6.65 — Model AI "sesuai penyedia": daftar model diambil dari penyedia (Gemini: API daftar model
// per API key; ChatGPT: katalog model akun lewat `codex debug models`), bukan nama tebakan / alias
// "latest". Daftar disimpan 24 jam dan diperbarui di latar (balasan pelanggan tidak menunggu).
// Claude memakai alias resmi CLI (haiku/sonnet/opus) yang diterjemahkan penyedia sendiri.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const DAY_MS = 24 * 60 * 60_000
/** Gagal mengambil daftar → coba lagi 30 menit kemudian (daftar lama tetap dipakai). */
const RETRY_MS = 30 * 60_000

type Entry = { at: number; models: string[] }
const cache = new Map<string, Entry>()
const pending = new Map<string, Promise<void>>()

/** Untuk tes. */
export function resetModelCatalogs() {
  cache.clear()
  pending.clear()
}

/**
 * Daftar model yang diketahui untuk kunci ini (null = belum ada). Bila kosong atau > 24 jam,
 * pembaruan dijalankan di latar; pemanggil tidak menunggu.
 */
export function knownModels(key: string, load: () => Promise<string[]>, now = Date.now()) {
  const entry = cache.get(key)
  if ((!entry || now - entry.at > DAY_MS) && !pending.has(key)) {
    const job = load()
      .then((models) => {
        if (models.length) cache.set(key, { at: Date.now(), models })
        else throw new Error('daftar kosong')
      })
      .catch(() => {
        cache.set(key, { at: Date.now() - DAY_MS + RETRY_MS, models: entry?.models || [] })
      })
      .finally(() => pending.delete(key))
    pending.set(key, job)
  }
  return entry?.models.length ? entry.models : null
}

/** Menunggu pembaruan yang sedang berjalan (tes / tombol cek). */
export async function settleModelCatalogs() {
  await Promise.all([...pending.values()])
}

// ── Gemini ──────────────────────────────────────────────────────────────────────────────────────

export const geminiCatalogKey = (apiKey: string) => `gemini:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`

/** Respons ListModels → nama model yang bisa generateContent ("gemini-3.5-flash", tanpa "models/"). */
export function parseGeminiCatalog(data: any) {
  return (Array.isArray(data?.models) ? data.models : [])
    .filter((model: any) => (model?.supportedGenerationMethods || []).includes('generateContent'))
    .map((model: any) => String(model?.name || '').replace(/^models\//, ''))
    .filter((name: string) => /^gemini-/.test(name))
}

export async function loadGeminiCatalog(apiKey: string) {
  const names: string[] = []
  let token = ''
  for (let page = 0; page < 5; page++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Gemini ListModels HTTP ${response.status}`)
    const data = (await response.json()) as any
    names.push(...parseGeminiCatalog(data))
    token = String(data?.nextPageToken || '')
    if (!token) break
  }
  return names
}

const version = (name: string) => Number(name.match(/^gemini-(\d+(?:\.\d+)?)-/)?.[1] || 0)
const byVersion = (a: string, b: string) => version(b) - version(a)

/**
 * Model utama + cadangan dari daftar penyedia. Utama: model akun bila ada di daftar, selain itu Flash
 * stabil terbaru (bukan preview/alias). Cadangan: Flash-Lite stabil terbaru lalu Flash lain — hanya
 * nama yang benar-benar ada di daftar.
 */
export function pickGeminiModels(names: string[], configured = '') {
  const flash = names.filter((name) => /^gemini-\d+(?:\.\d+)?-flash$/.test(name)).sort(byVersion)
  const lite = names.filter((name) => /^gemini-\d+(?:\.\d+)?-flash-lite$/.test(name)).sort(byVersion)
  const main =
    (configured && names.includes(configured) ? configured : '') ||
    flash[0] ||
    lite[0] ||
    (names.includes('gemini-flash-latest') ? 'gemini-flash-latest' : '') ||
    configured
  const fallbacks = [...lite, ...flash].filter((name, index, all) => name !== main && all.indexOf(name) === index).slice(0, 3)
  return { main, fallbacks }
}

// ── ChatGPT (Codex CLI) ─────────────────────────────────────────────────────────────────────────

/** Keluaran `codex debug models` → slug model, urut prioritas penyedia. */
export function parseCodexCatalog(text: string) {
  try {
    const data = JSON.parse(text) as any
    return (Array.isArray(data?.models) ? data.models : [])
      .filter((model: any) => typeof model?.slug === 'string' && model.slug)
      .sort((a: any, b: any) => Number(a?.priority ?? 999) - Number(b?.priority ?? 999))
      .map((model: any) => String(model.slug))
  } catch {
    return []
  }
}

export function loadCodexCatalog(command: string, args: string[], childEnv: NodeJS.ProcessEnv) {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(command, ['debug', 'models', ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout?.on('data', (chunk) => (output += String(chunk)))
    child.on('error', (error) => (clearTimeout(timer), reject(error)))
    child.on('close', () => {
      clearTimeout(timer)
      const models = parseCodexCatalog(output.slice(output.indexOf('{')))
      if (models.length) resolve(models)
      else reject(new Error('katalog model Codex kosong'))
    })
  })
}

/**
 * Model ChatGPT yang dikirim ke CLI: dipakai bila ada di katalog akun; tidak ada → kosong
 * (CLI memakai model bawaan penyedia untuk akun itu). Katalog belum diketahui → apa adanya.
 */
export function pickCodexModel(wanted: string, catalog: string[] | null) {
  if (!wanted || !catalog?.length) return wanted
  return catalog.includes(wanted) ? wanted : ''
}
