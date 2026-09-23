// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'

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
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || ''
    const name = (frontmatter.match(/^name:\s*(.+)$/im)?.[1] || dir)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    const description = (frontmatter.match(/^description:\s*(.+)$/im)?.[1] || `Skill ${name}`)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue
    const hash = createHash('sha256').update(content).digest('hex')
    const key = `beta3_skill_file:${name}`
    if ((await readLeanState(key)) === hash) continue
    await db.rawQuery(
      `INSERT INTO whatsapp_skills (name, description, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description), content = VALUES(content),
         updated_at = VALUES(updated_at)`,
      [name, description, content, new Date(), new Date()]
    )
    await writeLeanState(key, hash)
    updated.push(name)
    log?.(`Skill ${name} diperbarui dari file.`)
  }
  return { updated }
}
