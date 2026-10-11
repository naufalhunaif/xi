// Beta 3 — v3.6.161 Pelajaran dari uji: setiap percakapan uji yang gagal menghasilkan (1) koreksi jawaban
// (contoh "Koreksi uji", dipakai saat pertanyaan serupa muncul) dan (2) pelajaran umum satu baris yang
// dirangkum di prompt, supaya kesalahan yang sama tidak diulang dan uji berikutnya tidak sia-sia.
import { readLeanState, writeLeanState } from '#beta3/tables'
import { addLeanExample, listLeanExamples } from '#beta3/examples_service'

export type SimLesson = { text: string; count: number; lastAt: string; contoh: string[] }

const STATE = 'sim_lessons'
/** v3.6.166: 60 → 250 — pelajaran hasil tinjauan pemilik (±200 baris) harus muat; ke prompt tetap hanya yang nyambung. */
export const MAX_LESSONS = 300
/** Pelajaran yang ikut ke prompt (paling sering terjadi & terbaru). */
export const PROMPT_LESSONS = 10

const LESSON_STOP = new Set(
  'saat pelanggan jawab jangan yang dengan untuk bila kalau sebut jelas tanya tanpa lalu dulu juga atau dari ke di dan bos itu ini sudah belum ada tidak hanya langsung harus perlu bisa'.split(' ')
)
const lessonWords = (text: string) =>
  new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !LESSON_STOP.has(word))
  )
/**
 * v3.6.166 — mirip = Jaccard kata inti ≥ 0.5. Dulu "kata sama / himpunan terkecil ≥ 0.6" menggabungkan pelajaran
 * pendek yang beda topik (mis. "lama pengerjaan…" dengan "toko terdekat…") karena kata umum seperti "jawab/sebut".
 */
const similar = (a: string, b: string) => {
  const x = lessonWords(a)
  const y = lessonWords(b)
  if (!x.size || !y.size) return false
  const shared = [...x].filter((word) => y.has(word)).length
  return shared / (x.size + y.size - shared) >= 0.5
}

export async function listLessons(): Promise<SimLesson[]> {
  try {
    const raw = String((await readLeanState(STATE)) || '[]')
    const list = JSON.parse(raw) as SimLesson[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function saveLessons(list: SimLesson[]) {
  const sorted = [...list].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, MAX_LESSONS)
  await writeLeanState(STATE, JSON.stringify(sorted))
  return sorted
}

/** Tambah pelajaran; yang mirip digabung (hitungannya naik), supaya daftar tetap ringkas. */
export async function addLesson(text: string, contoh = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220)
  if (clean.split(' ').length < 4) return null
  const list = await listLessons()
  const hit = list.find((item) => similar(item.text, clean))
  const now = new Date().toISOString()
  if (hit) {
    hit.count += 1
    hit.lastAt = now
    if (contoh && !hit.contoh.includes(contoh)) hit.contoh = [...hit.contoh, contoh].slice(-3)
  } else list.push({ text: clean, count: 1, lastAt: now, contoh: contoh ? [contoh] : [] })
  await saveLessons(list)
  return hit || list[list.length - 1]
}

/** v3.6.163 — pemilik membenarkan teks pelajaran. */
export async function updateLesson(index: number, text: string) {
  const list = await listLessons()
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220)
  if (index < 0 || index >= list.length || clean.split(' ').length < 3) return false
  list[index].text = clean
  await saveLessons(list)
  return true
}

export async function removeLesson(index: number) {
  const list = await listLessons()
  if (index < 0 || index >= list.length) return false
  list.splice(index, 1)
  await saveLessons(list)
  return true
}

/** Bagian prompt: pelajaran teratas (sering terjadi & terbaru). */
export function renderLessons(lessons: SimLesson[], limit = PROMPT_LESSONS, customerText = '') {
  const top = pickLessons(lessons, customerText, limit)
  if (!top.length) return ''
  return ['PELAJARAN DARI UJI (kesalahan AI sebelumnya — jangan diulang):', ...top.map((item, index) => `${index + 1}. ${item.text}`)].join('\n')
}

/**
 * v3.6.165 — Pelajaran yang ikut ke prompt: yang NYAMBUNG dengan pesan pelanggan (kata kunci sama) didahulukan,
 * sisanya yang paling sering terjadi. Dulu hanya 10 teratas global, jadi pelajaran soal celana muncul saat ditanya
 * ongkir.
 */
export function pickLessons(lessons: SimLesson[], customerText: string, limit = PROMPT_LESSONS) {
  const words = lessonWords(customerText)
  const scored = lessons.map((lesson) => {
    const own = lessonWords(lesson.text)
    const shared = [...own].filter((word) => words.has(word)).length
    return { lesson, score: shared }
  })
  const related = scored
    .filter((item) => item.score >= 1)
    .sort((a, b) => b.score - a.score || b.lesson.count - a.lesson.count)
    .slice(0, limit)
    .map((item) => item.lesson)
  const frequent = [...lessons]
    .filter((lesson) => !related.includes(lesson))
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, Math.max(0, limit - related.length))
  return [...related, ...frequent]
}

/**
 * Simpan koreksi dari penilai sebagai contoh "Koreksi uji" (pertanyaan pelanggan → jawaban yang seharusnya).
 * Satu pertanyaan hanya sekali; jawaban kosong/terlalu panjang tidak disimpan.
 */
export async function saveSimCorrection(input: { customerText: string; correct: string; lesson: string; scenarioId: string }) {
  const customerText = String(input.customerText || '').trim().slice(0, 600)
  const correct = String(input.correct || '').trim().slice(0, 400)
  if (!customerText || customerText.length < 3 || !correct || correct.length < 4) return false
  const existing = await listLeanExamples()
  const key = customerText.toLowerCase().replace(/\s+/g, ' ')
  if (existing.some((example) => example.source === 'uji' && example.customerText.toLowerCase().replace(/\s+/g, ' ') === key)) return false
  await addLeanExample({
    situation: `Koreksi uji${input.lesson ? `: ${String(input.lesson).slice(0, 160)}` : ''}`,
    customerText,
    csText: correct,
    tags: `uji,${input.scenarioId}`.slice(0, 190),
    source: 'uji',
  })
  return true
}
