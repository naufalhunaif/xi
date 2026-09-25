// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'
import { appVersion } from '#services/app_version'

/**
 * Skill bawaan repo (whatsapp/skills/<nama>/SKILL.md) ikut terpasang otomatis:
 * tiap worker mulai (= tiap deploy), file yang berubah sejak sinkron terakhir
 * di-upsert ke whatsapp_skills. Tidak perlu import manual lagi.
 * Hash per skill disimpan, jadi suntingan lewat UI tidak ditimpa selama filenya
 * tidak berubah.
 */
/** Hanya skill Beta 2 yang terpasang otomatis; skill Beta 1 tetap ada di repo untuk diimpor manual. */
const BUNDLED = ['beta3-cs-inti']

export async function syncBundledSkills(log?: (line: string) => void) {
  await ensureLeanTables()
  const root = app.makePath('skills-beta3')
  let names: string[] = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { updated: [] as string[] }
  }
  // Rapikan sisa sinkron lama yang sempat memasang semua folder skills/*.
  for (const dir of names) {
    if (BUNDLED.includes(dir)) continue
    const key = `beta3_skill_file:${dir}`
    if (!(await readLeanState(key))) continue
    await db.from('whatsapp_skills').where('name', dir).delete()
    await db.from('whatsapp_beta3_state').where('name', key).delete()
    log?.(`Skill ${dir} dilepas dari sinkron otomatis.`)
  }
  const updated: string[] = []
  for (const dir of names.filter((name) => BUNDLED.includes(name))) {
    let content = ''
    try {
      content = await readFile(join(root, dir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const name = await installSkill(dir, content, 'file')
    if (!name) continue
    updated.push(name)
    log?.(`Skill ${name} diperbarui dari file.`)
  }
  return { updated }
}

/** Pasang isi SKILL.md ke whatsapp_skills bila berbeda dari yang terakhir dipasang sumber ini. */
async function installSkill(dir: string, content: string, source: 'file' | 'remote') {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || ''
  const name = (frontmatter.match(/^name:\s*(.+)$/im)?.[1] || dir).trim().replace(/^['"]|['"]$/g, '')
  const description = (frontmatter.match(/^description:\s*(.+)$/im)?.[1] || `Skill ${name}`)
    .trim()
    .replace(/^['"]|['"]$/g, '')
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return null
  const hash = createHash('sha256').update(content).digest('hex')
  const key = source === 'file' ? `beta3_skill_file:${name}` : `beta3_skill_remote:${name}`
  if ((await readLeanState(key)) === hash) return null
  await db.rawQuery(
    `INSERT INTO whatsapp_skills (name, description, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE description = VALUES(description), content = VALUES(content),
       updated_at = VALUES(updated_at)`,
    [name, description, content, new Date(), new Date()]
  )
  await writeLeanState(key, hash)
  return name
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

/**
 * Update ringan tanpa `wa update`: skill terbaru diambil dari repo rilis publik
 * (cabang main) tiap sync katalog. Skill yang butuh versi aplikasi lebih baru
 * (frontmatter `min_app: 3.x.y`) dilewati sampai aplikasinya diperbarui.
 */
export async function syncRemoteSkills(log?: (line: string) => void) {
  const base = (
    process.env.SKILL_REMOTE_URL ||
    'https://raw.githubusercontent.com/naufalhunaif/xi/main/whatsapp/skills-beta3'
  ).replace(/\/$/, '')
  if (base === 'off') return { updated: [] as string[] }
  await ensureLeanTables()
  const updated: string[] = []
  for (const dir of BUNDLED) {
    try {
      const response = await fetch(`${base}/${dir}/SKILL.md`, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) continue
      const content = await response.text()
      if (!content.startsWith('---')) continue
      const minApp = content.match(/^min_app:\s*([\d.]+)/im)?.[1]
      if (minApp && newer(minApp, appVersion())) continue
      const name = await installSkill(dir, content, 'remote')
      if (name) {
        updated.push(name)
        log?.(`Skill ${name} diperbarui dari rilis online.`)
      }
    } catch {}
  }
  await writeLeanState('beta3_skill_checked', new Date().toISOString())
  return { updated }
}

/** Info skill untuk halaman Pengaturan → Skill. */
export async function skillStatus() {
  await ensureLeanTables()
  const name = BUNDLED[0]
  const row = await db.from('whatsapp_skills').where('name', name).select('name', 'content', 'updated_at').first()
  const content = row?.content ? String(row.content) : ''
  const hash = content ? createHash('sha256').update(content).digest('hex') : ''
  const source = hash && hash === (await readLeanState(`beta3_skill_remote:${name}`)) ? 'online' : 'aplikasi'
  return {
    name,
    installed: Boolean(row),
    updatedAt: row?.updated_at || null,
    checkedAt: (await readLeanState('beta3_skill_checked')) || null,
    source,
    content,
  }
}
