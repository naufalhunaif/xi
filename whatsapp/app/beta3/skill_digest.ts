// v3.6.39 — Skill digest: isi skill sama, ditulis ringkas (seperti katalog digest) supaya token
// balasan AI turun. Skill asli TIDAK diubah; digest hanya salinan yang dikirim ke AI.
//
// Sumber digest (urut):
//   1. file bawaan skills-beta3/<nama>/DIGEST.md yang `digest_of`-nya sama dengan sha skill,
//   2. tersimpan (state `skill-digest:<sha>`), dibuat AI sebelumnya,
//   3. dibuat AI di latar (sekali per sha) — selama belum ada, skill asli yang dipakai.
// Setiap digest diperiksa: semua kalimat CS ("…"), angka, nama bagian (KATALOG, ONGKIR, …),
// nama field (`…`) dan judul ## harus tetap ada. Gagal → bagian itu memakai teks asli.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { readLeanState, writeLeanState } from '#beta3/tables'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
// Nama state maks. 64 karakter: cukup 32 karakter awal sha.
const stateKey = (hash: string) => `skill-digest:${hash.slice(0, 32)}`
const OFF_KEY = 'skill-digest-off'
const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

/** Isi tanpa frontmatter. */
export function skillBody(text: string) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()
}

function sections(text: string) {
  const map = new Map<string, string>()
  for (const part of skillBody(text).split(/^(?=## )/m)) {
    const heading = part.startsWith('## ') ? part.slice(3).split('\n')[0].trim() : ''
    map.set(heading, part)
  }
  return map
}

/** Hal yang wajib tetap ada di digest: kalimat CS, angka, NAMA BAGIAN, `field`. */
export function mustKeep(text: string) {
  const body = skillBody(text)
  const quotes = [...body.matchAll(/"([^"\n]{3,})"/g)].map((match) => match[1].trim())
  const numbers = [...body.matchAll(/\d+(?:[.,]\d+)*/g)].map((match) => match[0])
  const upper = [...body.matchAll(/\b[A-Z][A-Z]{2,}(?:\s+[A-Z]{2,})*\b/g)].map((match) => match[0])
  const fields = [...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim())
  return { quotes, numbers, upper, fields }
}

/** Yang hilang dari digest dibanding sumber (kosong = lengkap). */
export function digestMissing(source: string, digest: string) {
  const keep = mustKeep(source)
  const target = norm(skillBody(digest))
  const raw = skillBody(digest)
  const missing: string[] = []
  for (const quote of new Set(keep.quotes)) if (!target.includes(norm(quote))) missing.push(`"${quote}"`)
  for (const number of new Set(keep.numbers)) if (!raw.includes(number)) missing.push(number)
  for (const word of new Set(keep.upper)) if (!raw.includes(word)) missing.push(word)
  for (const field of new Set(keep.fields)) if (!target.includes(norm(field))) missing.push(`\`${field}\``)
  for (const heading of sections(source).keys())
    if (heading && !sections(digest).has(heading)) missing.push(`## ${heading}`)
  return missing
}

/**
 * Gabungkan digest per bagian: bagian yang tidak lengkap memakai teks asli (aman), lalu pastikan
 * hasilnya memang lebih ringkas. null = digest tidak dipakai.
 */
export function mergeDigest(source: string, digest: string) {
  const from = sections(source)
  const to = sections(digest)
  const parts: string[] = []
  const fallback: string[] = []
  for (const [heading, original] of from) {
    const short = to.get(heading)
    if (short !== undefined && !digestMissing(original, short).length) parts.push(short)
    else {
      parts.push(original)
      if (heading) fallback.push(heading)
    }
  }
  // Pembuka digest (cara baca singkatan) selalu dari digest bila ada.
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > skillBody(source).length * 0.9) return null
  return { text, fallback }
}

async function bundledDigest(name: string, hash: string) {
  try {
    const file = await readFile(join(app.makePath('skills-beta3'), name, 'DIGEST.md'), 'utf8')
    const of = file.match(/^digest_of:\s*([a-f0-9]{64})\s*$/m)?.[1]
    return of === hash ? file : null
  } catch {
    return null
  }
}

const generating = new Set<string>()
const bundledCache = new Map<string, { text: string; fallback: string[] } | null>()

/** Digest yang sudah ada untuk isi skill ini (DIGEST.md bawaan, lalu buatan AI). null = belum ada. */
async function resolveDigest(skill: { name: string; content: string }) {
  const hash = sha(skill.content)
  // DIGEST.md bawaan didahulukan (bisa diperbaiki tanpa skill berubah); hasil gabungan disimpan di memori.
  if (!bundledCache.has(hash)) {
    const bundled = await bundledDigest(skill.name, hash)
    bundledCache.set(hash, bundled ? mergeDigest(skill.content, bundled) : null)
  }
  const fromFile = bundledCache.get(hash)
  if (fromFile) return { ...fromFile, source: 'file' as const }
  const saved = await readLeanState(stateKey(hash)).catch(() => '')
  if (saved)
    try {
      const value = JSON.parse(saved) as { text: string; fallback: string[] }
      if (value.text) return { text: value.text, fallback: value.fallback || [], source: 'ai' as const }
    } catch {}
  return null
}

/**
 * Skill yang dikirim ke AI: digest bila tersedia & lengkap, selain itu skill asli.
 * `make` dipanggil (di latar, sekali per isi skill) untuk membuat digest dengan AI.
 */
export async function skillForPrompt(
  skill: { name: string; content: string },
  make?: (content: string) => Promise<string>
): Promise<{ content: string; digest: boolean; fallback: string[] }> {
  const original = { content: skill.content, digest: false, fallback: [] as string[] }
  if ((await readLeanState(OFF_KEY).catch(() => '')) === '1') return original
  const found = await resolveDigest(skill)
  if (found) return { content: found.text, digest: true, fallback: found.fallback }
  const hash = sha(skill.content)
  if (make && !generating.has(hash) && !(await readLeanState(`${stateKey(hash)}:tried`).catch(() => ''))) {
    generating.add(hash)
    void (async () => {
      try {
        await writeLeanState(`${stateKey(hash)}:tried`, new Date().toISOString())
        const made = mergeDigest(skill.content, await make(skill.content))
        if (made) await writeLeanState(stateKey(hash), JSON.stringify(made))
        logger.info({ skill: skill.name, ok: Boolean(made), fallback: made?.fallback }, 'Skill digest dibuat')
      } catch (error) {
        logger.info({ skill: skill.name, error: String(error) }, 'Skill digest gagal dibuat; skill asli dipakai')
      } finally {
        generating.delete(hash)
      }
    })()
  }
  return original
}

/** Untuk Pengaturan → Skill CS: aktif/mati, ukuran asli vs digest (token), isi digest. */
export async function skillDigestView(skill: { name: string; content: string } | null) {
  const off = (await readLeanState(OFF_KEY).catch(() => '')) === '1'
  const found = skill?.content ? await resolveDigest(skill) : null
  const tokens = (text: string) => Math.round(text.length / 3.7)
  return {
    off,
    ready: Boolean(found),
    source: found?.source || null,
    originalTokens: skill?.content ? tokens(skillBody(skill.content)) : 0,
    digestTokens: found ? tokens(found.text) : 0,
    fallback: found?.fallback || [],
    content: found?.text || '',
  }
}

export async function setSkillDigestOff(off: boolean) {
  await writeLeanState(OFF_KEY, off ? '1' : '')
}

/** Prompt pembuatan digest oleh AI (dipakai bila skill diubah dan belum ada DIGEST.md yang cocok). */
export function digestPrompt(content: string) {
  return {
    system:
      'Kamu meringkas FORMAT sebuah skill CS tanpa mengubah isinya. Pertahankan setiap aturan, setiap kalimat contoh dalam tanda kutip "…" persis huruf per huruf, setiap angka, setiap nama bagian berhuruf besar (KATALOG, ONGKIR, …), setiap nama field dalam `backtick`, setiap judul "## …" persis sama dan urutannya, serta tabel dan blok ``` apa adanya. Yang boleh dibuang: kata pengantar, pengulangan, penjelasan panjang. Pakai gaya ringkas: "→" untuk "maka/jawab", "SC" untuk serah_cs = true (jelaskan singkatan ini sekali di awal). Keluarkan hanya teks skill ringkas (markdown), tanpa frontmatter.',
    user: skillBody(content),
  }
}
