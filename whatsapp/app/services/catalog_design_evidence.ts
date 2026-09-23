/** Deterministic equivalence for explicit color assignments; unknown design claims stay unapproved. */
import { normalizeColorLanguage } from '#services/color_semantics'

export const catalogDesignWords = (value: unknown) =>
  normalizeColorLanguage(value)
    .replace(/\bwarnanya\b/g, 'warna')
    .replace(/\b(?:badannya|body)\b/g, 'badan')
    .replace(/\b(?:kerahnya|kerah|collar)\b/g, 'lapel')
    .replace(/\bkancingnya\b/g, 'kancing')
    .replace(/\btetep\b/g, 'tetap')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bwarna lapel\b/g, 'lapel')

const colorLink = '(?:(?:jadi|menjadi|tetap|warna|berwarna|diubah|diganti) )*'
export const bodyLabel = '(?:warna(?: badan)?(?: jas)?|badan(?: jas)?)'
export type ColorAssignment = { label: string; color: string }
export const catalogColor = (value: unknown, label: string) =>
  catalogDesignWords(value)
    .replace(new RegExp(`^${label} `), '')
    .replace(new RegExp(`^${colorLink}`), '')
    .trim()

export function catalogAssignments(details: { color?: string; lapel?: string } | null | undefined) {
  return [
    { label: bodyLabel, color: catalogColor(details?.color, bodyLabel) },
    { label: 'lapel', color: catalogColor(details?.lapel, 'lapel') },
  ].filter((entry) => entry.color)
}

export function catalogDesignAssignments(
  details:
    | {
        color?: string
        lapel?: string
        material?: string
        buttons?: string
      }
    | null
    | undefined
) {
  return [
    ...catalogAssignments(details),
    { label: '(?:bahan|material)', color: catalogColor(details?.material, '(?:bahan|material)') },
    { label: 'kancing', color: catalogColor(details?.buttons, 'kancing') },
  ].filter((entry) => entry.color)
}

function forward({ label, color }: ColorAssignment) {
  return `${label} ${colorLink}${color}`
}
function reversed({ label, color }: ColorAssignment) {
  return `${color} (?:untuk|di|pada) ${label}`
}
// A shade/material modifier immediately after a color is part of the fact, not filler.
const afterColor =
  '(?= (?:$|(?:dan|dengan|lapel|badan|warna|bisa|boleh|bos|bosku|kak|ya|kombinasi|untuk|aja|saja|model|bahan|kancing)\\b))'

/** Every occurrence must agree, so a second conflicting assignment cannot be hidden. */
export function catalogRequestMatches(body: string, assignments: ColorAssignment[]) {
  const text = ` ${catalogDesignWords(body).replace(/\bbisa (?:gak|nggak|ga|tidak)\b/g, 'bisa')} `
  if (
    !assignments.length ||
    /\b(tidak|tak|gak|nggak|ga|bukan|jangan|batal|atau|belum)\b/.test(text)
  )
    return false
  return assignments.every((assignment) => {
    if (
      !new RegExp(` (?:${forward(assignment)}${afterColor}|${reversed(assignment)}(?= ))`).test(
        text
      )
    )
      return false
    for (const match of text.matchAll(new RegExp(` ${assignment.label}(?= )`, 'g'))) {
      const after = text.slice(match.index)
      const through = text.slice(0, match.index + match[0].length)
      if (
        !new RegExp(`^ ${forward(assignment)}${afterColor}`).test(after) &&
        !new RegExp(` ${reversed(assignment)}$`).test(through)
      )
        return false
    }
    return true
  })
}

/** Notes may restate the structured facts, but cannot swap roles or add material/buttons. */
export function catalogNotesMatch(notes: string, assignments: ColorAssignment[]) {
  let remaining = ` ${catalogDesignWords(notes)} `
  // Provenance prose adds no design fact. The caller must still verify the actual CS message.
  remaining = remaining.replace(
    /\b(?:(?:sesuai|berdasarkan) (?:permintaan pelanggan|persetujuan cs)|(?:sudah |telah )?disetujui (?:oleh )?cs)\b/g,
    ' '
  )
  for (const assignment of assignments) {
    remaining = remaining.replace(
      new RegExp(` (?:${forward(assignment)}|${reversed(assignment)})(?= )`, 'g'),
      ' '
    )
  }
  remaining = remaining.replace(/\b(?:custom|perubahan|kombinasi|dengan|dan|warna)\b/g, ' ')
  return !remaining.trim()
}

/** Explicit affirmative only; a bare "iya" or a conditional/negative answer is insufficient. */
export function modelApprovalRemainder(body: string): string | null {
  if (/[?\p{Extended_Pictographic}]/u.test(body)) return null
  const match = body
    .trim()
    .match(
      /^(?:(?:iya+|ya+|oke+|ok|siap|yes)[,\s]*)?(?:bisa|boleh|disetujui|setuju|approved)(?=$|[\s,.!])([\s\S]*)$/i
    )
  if (!match) return null
  return match[1]
    .replace(/\b(?:bosku|bos|kak|ka|gan|ya)\b/gi, ' ')
    .replace(/[,!.]/g, ' ')
    .trim()
}
