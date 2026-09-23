type Skill = { name: string; content: string }

const REPLACEMENTS: Record<string, string[]> = {
  'chameleon-cs-gabungan': [
    'cs-chameleon-cloth',
    'cs-chameleon-media',
    'cs-chameleon-batas',
    'cs-chameleon-eval',
  ],
  'chameleon-cs-gabungan-2': [
    'cs-chameleon-cloth',
    'cs-chameleon-konteks',
    'cs-chameleon-media',
    'cs-chameleon-batas',
    'cs-chameleon-eval',
  ],
}

/** Customer replies omit the explicitly offline rubric as well as retired bundles. */
export function selectReplySkills(imports: Skill[]) {
  return selectActiveSkills(imports, true)
}

/** Evaluation retains its complete rubric and all active business rules verbatim. */
export function selectEvaluationSkills(imports: Skill[]) {
  return selectActiveSkills(imports, false)
}

function selectActiveSkills(imports: Skill[], customerReply: boolean) {
  const snapshot = imports.map((skill) => ({ ...skill }))
  const available = new Set(
    snapshot.filter((skill) => skill.content.trim()).map((skill) => skill.name)
  )
  const excluded: Array<{ name: string; reason: string; replacements: string[] }> = []
  const retainedBundles: Array<{ name: string; reason: string; missing: string[] }> = []
  const skills = snapshot.filter((skill) => {
    const expected = REPLACEMENTS[skill.name]
    // Names alone never retire a skill. Require its explicit status declaration,
    // every known replacement, and any additional module attributed in the bundle.
    const status = skill.content
      .match(/^# STATUS(?: DAN PRIORITAS)? SKILL\s*\n([\s\S]*)$/m)?.[1]
      ?.replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
    if (
      expected &&
      status &&
      /(?:tidak dipakai sebagai acuan aktif|bukan acuan aktif)/i.test(status) &&
      /Jangan muat atau terapkan (?:bersama|berkas ini bersamaan dengan)/i.test(status) &&
      /Gunakan skill modular yang sesuai kebutuhan/i.test(status)
    ) {
      const origins = [...skill.content.matchAll(/^\(asal: skill `([^`]+)`\)\s*$/gm)].map(
        (match) => match[1]
      )
      const replacements = [...new Set([...expected, ...origins])]
      if (replacements.every((name) => available.has(name))) {
        excluded.push({ name: skill.name, reason: 'superseded_by_available_modules', replacements })
        return false
      }
      retainedBundles.push({
        name: skill.name,
        reason: 'replacement_modules_missing',
        missing: replacements.filter((name) => !available.has(name)),
      })
    } else if (expected) {
      retainedBundles.push({
        name: skill.name,
        reason: 'retirement_declaration_not_found',
        missing: [],
      })
    }
    // This specific imported evaluation guide declares an offline maintenance scope.
    // Other skills (including unknown evaluation guides) remain untouched.
    if (
      customerReply &&
      skill.name === 'cs-chameleon-eval' &&
      /^# EVALUASI & PEMBELAJARAN CS CHAMELEON CLOTH\s*$/m.test(skill.content) &&
      /Pakai setiap kali skill CS diubah, saat evaluasi bulanan, atau saat konversi turun\./.test(
        skill.content
      ) &&
      /^## Kapan dijalankan\s*$/m.test(skill.content)
    ) {
      excluded.push({ name: skill.name, reason: 'offline_evaluation_scope', replacements: [] })
      return false
    }
    return true
  })
  return {
    skills,
    detail: {
      importedCount: snapshot.length,
      activeCount: skills.length,
      excluded,
      retainedBundles,
      sourceChars: snapshot.reduce((sum, skill) => sum + skill.content.length, 0),
      activeChars: skills.reduce((sum, skill) => sum + skill.content.length, 0),
    },
  }
}
