import { SEMANTIC_INTENT_INSTRUCTIONS } from '#services/semantic_intent_contract'

function renderedSkills(skills: Array<{ name: string; content: string }>) {
  const originals = new Map<string, string>()
  return skills.map((skill) => {
    const original = originals.get(skill.content)
    const reference = `Isi skill ini identik persis dengan skill ${JSON.stringify(original)} di atas; seluruh isinya berlaku juga di posisi ini.`
    const body =
      original !== undefined && reference.length < skill.content.length ? reference : skill.content
    if (original === undefined) originals.set(skill.content, skill.name)
    return [
      `skill: ${skill.name}`,
      `=== SKILL: ${skill.name} ===\n${body}\n=== AKHIR SKILL: ${skill.name} ===`,
    ] as [string, string]
  })
}

/** All unique contents remain inline; only byte-identical copies reference their original. */
export function importedSkillInstructions(skills: Array<{ name: string; content: string }>) {
  return [
    SEMANTIC_INTENT_INSTRUCTIONS,
    'SKILL TERIMPOR: seluruh isi di bawah tersedia langsung, tidak perlu dibaca lewat shell. Cara membalas, penggunaan tool, keputusan, dan inisiatif mengikuti skill ini. Tidak ada persona atau panduan bisnis bawaan lain.',
    ...renderedSkills(skills).map(([, content]) => content),
  ].join('\n\n')
}
