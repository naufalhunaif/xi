// Komentar Instagram: AI membaca maksud komentar, membalas singkat di publik, lalu
// mengarahkan calon pembeli ke DM (balasan pribadi) dan/atau WhatsApp.
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import { readSettings } from '#services/settings_service'
import { isAiWorking } from '#services/ai_work_schedule'
import { runLeanProvider } from '#beta3/provider'
import { selectLeanSkill } from '#beta3/reply_service'
import { readInstagram, type InstagramConfig } from '#instagram/store'
import { hideComment, privateReply, replyComment } from '#instagram/api'

export const COMMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jenis: {
      type: 'string',
      enum: ['tanya', 'minat', 'keluhan', 'pujian', 'spam', 'lain'],
      description:
        'Maksud komentar (bukan kata kunci). tanya = bertanya produk/harga/ukuran/stok/cara order; minat = ingin beli/pesan/"mau"/"order"/tag teman untuk dibelikan; keluhan = masalah pesanan; pujian = memuji/emoji tanpa pertanyaan; spam = promosi/judi/link asing/bot; lain = selain itu.',
    },
    balasan_publik: {
      type: 'string',
      description:
        'Balasan singkat di kolom komentar (maks. 150 karakter), ramah, tanpa harga/rekening/data pribadi. Kosong bila spam.',
    },
    pesan_dm: {
      type: 'string',
      description:
        'Pesan DM pembuka untuk tanya/minat/keluhan (maks. 400 karakter): sapa, sebut yang ditanyakan, tanyakan satu hal yang dibutuhkan untuk lanjut. Jangan menyebut harga/stok yang tidak pasti. Kosong untuk jenis lain.',
    },
  },
  required: ['jenis', 'balasan_publik', 'pesan_dm'],
} as const

type CommentDecision = {
  jenis: 'tanya' | 'minat' | 'keluhan' | 'pujian' | 'spam' | 'lain'
  balasan_publik: string
  pesan_dm: string
}

export function parseCommentDecision(text: string): CommentDecision | null {
  try {
    const start = text.indexOf('{')
    const value = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
    const jenis = ['tanya', 'minat', 'keluhan', 'pujian', 'spam', 'lain'].includes(value.jenis)
      ? value.jenis
      : 'lain'
    return {
      jenis,
      balasan_publik: String(value.balasan_publik || '').trim().slice(0, 300),
      pesan_dm: String(value.pesan_dm || '').trim().slice(0, 900),
    }
  } catch {
    return null
  }
}

const NEEDS_HELP = new Set(['tanya', 'minat', 'keluhan'])

export function waLink(phone: string | null | undefined) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits ? `wa.me/${digits}` : ''
}

/** Rute komentar sesuai pengaturan: DM, WhatsApp, atau keduanya. */
export function commentRoute(
  target: InstagramConfig['commentTarget'],
  jenis: CommentDecision['jenis'],
  canDm: boolean,
  wa: string
) {
  const help = NEEDS_HELP.has(jenis)
  const dm = help && canDm && target !== 'wa'
  const waPublic = help && (target === 'wa' || (target === 'both' && !dm))
  const waInDm = dm && target === 'both' && Boolean(wa)
  return { dm, waPublic, waInDm }
}

function routeInstruction(target: InstagramConfig['commentTarget']) {
  const rule =
    target === 'wa'
      ? 'Untuk tanya/minat/keluhan: balasan publik mengajak lanjut lewat WhatsApp kami.'
      : target === 'dm'
        ? 'Untuk tanya/minat/keluhan: balasan publik bilang sudah kami balas lewat DM (mis. "sudah kami DM ya kak").'
        : 'Untuk tanya/minat/keluhan: balasan publik bilang sudah kami DM, atau bisa juga lewat WhatsApp kami.'
  return `${rule} Cukup sebut DM/WhatsApp — jangan tulis nomor, link, atau username.`
}

/** Balasan publik tidak boleh memuat link atau nomor (cukup menyebut DM/WhatsApp). */
export function cleanPublicReply(text: string) {
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:wa\.me|api\.whatsapp\.com|bit\.ly)\/\S*/gi, '')
    .replace(/(?:\+?62|0)[\d\s.-]{8,}\d/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
}

async function decide(config: InstagramConfig, row: Record<string, any>) {
  const settings = await readSettings(true)
  let skill = ''
  try {
    skill = selectLeanSkill(settings.skills).content.slice(0, 3000)
  } catch {}
  const system = [
    'Kamu admin Instagram toko. Baca MAKSUD komentar (bukan kata kunci), lalu isi JSON.',
    routeInstruction(config.commentTarget),
    'Pujian: balas terima kasih singkat. Lain (obrolan/tag teman tanpa minat): balasan singkat atau kosong. Spam: semua kosong.',
    'Gunakan gaya sapaan dan bahasa toko dari aturan di bawah bila ada. Jangan mengarang harga, stok, atau janji.',
    skill ? `\nAturan & gaya toko (ringkas):\n${skill}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const user = `Komentar dari @${row.username || 'pengguna'}${row.parent_id ? ' (balasan di utas komentar)' : ''}:\n"${String(row.text || '').slice(0, 1500)}"`
  const result = await runLeanProvider(
    { ...settings, aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt' },
    { system, user },
    [],
    'instagram-comment',
    COMMENT_SCHEMA as unknown as Record<string, unknown>
  )
  return parseCommentDecision(result.text)
}

/** Sudah pernah di-DM dari komentar dalam 24 jam → jangan kirim DM baru. */
async function recentlyMessaged(fromId: string) {
  return Boolean(
    await db
      .from('whatsapp_instagram_comments')
      .where('from_id', fromId)
      .whereNotNull('private_reply')
      .where('updated_at', '>=', new Date(Date.now() - 24 * 3_600_000))
      .first()
  )
}

/** Proses beberapa komentar baru. Dipanggil listener tiap beberapa detik. */
export async function processInstagramComments(limit = 3) {
  const config = await readInstagram()
  if (!config.connected || !config.commentsEnabled) return 0
  const settings = await readSettings()
  if (!isAiWorking(settings)) return 0
  // Proses yang terputus tidak diulang (bisa sudah terbalas); ditandai gagal.
  await db
    .from('whatsapp_instagram_comments')
    .where('status', 'processing')
    .where('updated_at', '<', new Date(Date.now() - 15 * 60_000))
    .update({ status: 'failed', error: 'Proses terputus.', updated_at: new Date() })
  const rows = await db
    .from('whatsapp_instagram_comments')
    .where('status', 'new')
    .orderBy('id', 'asc')
    .limit(limit)
  const wa = waLink(workspaceScope().phone)
  for (const row of rows) {
    const claimed = await db
      .from('whatsapp_instagram_comments')
      .where('id', row.id)
      .where('status', 'new')
      .update({ status: 'processing', updated_at: new Date() })
    if (!claimed) continue
    const update: Record<string, unknown> = { status: 'done' }
    try {
      // Komentar lebih dari 7 hari tidak bisa dibalas pribadi; lewati yang basi.
      if (Date.now() - new Date(row.created_at).getTime() > 6 * 24 * 3_600_000) {
        update.status = 'skipped'
        continue
      }
      const decision = await decide(config, row)
      if (!decision) throw new Error('Jawaban AI tidak valid.')
      update.kind = decision.jenis
      if (decision.jenis === 'spam') {
        if (config.hideSpam) await hideComment(config.accessToken, row.comment_id)
        update.status = config.hideSpam ? 'hidden' : 'spam'
        continue
      }
      const route = commentRoute(
        config.commentTarget,
        decision.jenis,
        Boolean(decision.pesan_dm) && config.dmEnabled && !(await recentlyMessaged(row.from_id)),
        wa
      )
      if (route.dm) {
        const dmText = route.waInDm
          ? `${decision.pesan_dm}\n\nBisa juga lewat WhatsApp: ${wa}`
          : decision.pesan_dm
        const sent = await privateReply(config.accessToken, row.comment_id, dmText)
        update.private_reply = dmText
        // Komentar tidak dicampur ke chat DM; cukup dicatat id penerimanya.
        if (sent.recipient_id) update.dm_igsid = String(sent.recipient_id)
      }
      let publicText = cleanPublicReply(decision.balasan_publik)
      // Utas balasan (bukan komentar utama) hanya dibalas bila ada maksud bertanya/beli.
      if (row.parent_id && !NEEDS_HELP.has(decision.jenis)) publicText = ''
      else if (!publicText && route.dm) publicText = 'Sudah kami DM ya kak 🙏'
      else if (!publicText && route.waPublic) publicText = 'Info lengkap bisa lewat WhatsApp kami ya kak 🙏'
      if (publicText) {
        await replyComment(config.accessToken, row.comment_id, publicText.slice(0, 2000))
        update.public_reply = publicText
      }
    } catch (error) {
      update.status = 'failed'
      update.error = (error instanceof Error ? error.message : String(error)).slice(0, 290)
    } finally {
      await db
        .from('whatsapp_instagram_comments')
        .where('id', row.id)
        .update({ ...update, updated_at: new Date() })
    }
  }
  return rows.length
}
