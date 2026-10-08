// Beta 3 — alur AI CS. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { phoneFromJid } from '#services/customer_identity_service'
import { estimateTokens } from '#services/prompt_size_service'
import type { TraceSink } from '#services/trace_service'
import { catalogDigest, findCatalogVariant, renderCatalogDigest, type LeanCatalogRow } from '#beta3/catalog_service'
import { listLeanExamples, pickExamples, seedLeanExamples } from '#beta3/examples_service'
import { readCustomerNote, readOrderSpec, writeOrderSpec } from '#beta3/customer_service'
import {
  parseOrderForm,
  parseLooseAddress,
  tidyLooseAddress,
  looseAddressForm,
  syncOrderFromChat,
  parsePrices,
  saveLeanOrder,
  updatePendingOrderSpec,
  latestLeanOrder,
  cancelLeanOrder,
  readLeanOrder,
  noteAutoTotalReason,
  verifyAutoTotal,
  renderActiveOrder,
  updatePendingOrderRates,
  orderPartsOf,
  reopenLeanOrderForChange,
  reopenUntotaledOrder,
  totalWasSent,
  adoptCsTotal,
  type VerifiedAutoTotal,
} from '#beta3/order_service'
import {
  buildLeanPrompt,
  parseLeanDecision,
  renderProductionEstimate,
  type LeanDecision,
  type LeanHistoryRow,
} from '#beta3/prompt'
import { autoTier, runLeanProvider, type LeanProviderSettings } from '#beta3/provider'
import { chooseReplyTier, TIER_LABEL } from '#beta3/model_tier'
import { normalizeStyle, storeStyle, styleForChat, styleGuide } from '#beta3/style_service'
import {
  callLeanTool,
  extractBodyMeasure,
  extractShippingQuery,
  type DestinationRow,
  type DestinationArea,
  groupDestinations,
  normalizeCity,
  pickArea,
  type LeanMcpConfig,
  renderDestinationChoices,
  readLeanMcpConfig,
  renderFitResult,
  renderShippingRates,
  type FitResult,
  type ShippingRates,
  type AwbTracking,
  extractAwb,
  renderAwbTracking,
} from '#beta3/mcp'
import { DEFAULT_ITEM_GRAMS, orderWeightGrams } from '#beta3/weights'
import { detectAwb, looksSelfDelivery } from '#beta3/shipments'
import { readLeanState, writeLeanState, readBeta3ChatNote, saveChatPriority } from '#beta3/tables'
import { imageNotes, recordImageKinds, saveAiRefs } from '#beta3/refs_service'
import { describeStatus, statusPostsByIds } from '#services/status_posts'
import { cancelsOrder, dropGuessedPantsNumber, dropRepeatedWait, fixCodClaim, keepCustomInChat } from '#beta3/reply_guards'
import { focusCatalog, isBusinessPitch, isOtherBot, promptNeeds, quickReply, skillContext, trimSkill } from '#beta3/token_saver'
import { bubblesFromText, tidyReply } from '#beta3/reply_tidy'
import { imageColorNote } from '#beta3/image_color'
import { pricePattern, productPriceMap, renderPricePattern, seriesMentioned, type PriceSeries } from '#beta3/price_pattern'
import { completePhotos, pointToSentPhotos, polishText, polishWithPhotos, skipSentPhotos } from '#beta3/reply_polish'
import { allowedPrices, listRules, renderRules, unknownPrices } from '#beta3/quality_service'
import { readExchangePolicy, renderExchangePolicy } from '#beta3/store_policy'
import { fixCatalogColors, swapColorWords } from '#beta3/color_fix'
import {
  chooseVariant,
  promisesTotal,
  storeSentTotal,
  understandTurn,
  isNewDestination,
  storeConfirmedPayment,
  type TurnUnderstanding,
} from '#beta3/jev_decisions'
import { collectContext, compareWithSizeChart, measureFromHistory } from '#beta3/context_service'
import { digestPrompt, skillForPrompt } from '#beta3/skill_digest'
import { renderWholesaleRule, wholesaleDiscounts } from '#beta3/wholesale'
import { renderPaymentMessage } from '#beta3/order_service'
import { alignPhotos, CHECK_LABEL, checkReply, mergeUsage, reviewNudge, revisionNote, stripUnknownLinks, type CheckIssue } from '#beta3/reply_check'
import { GREETED, calmForFeeling, dropRepeatedGreeting, dropRepeatedSentences, heartLabel, heartNote, notedInsteadOfAnswer } from '#beta3/hati'

/**
 * Jalur balas ramping (beta 2): satu panggilan AI, tanpa tool, prompt ≈ 6–10rb
 * token. Angka/tahap ditangani kode; AI hanya menulis kata-kata.
 */
export const LEAN_SKILL_NAME = 'beta3-cs-inti'
export const LEAN_SKILL_TOKEN_LIMIT = 7000
// Riwayat 20 pesan; keadaan yang lebih lama tersimpan di CATATAN CHAT & spesifikasi.
const HISTORY_LIMIT = 20
// v3.6.29: saat order sedang disusun/menunggu total, riwayat diperpanjang supaya pembahasan item
// sebelumnya (bagian bawah/celana, rompi, referensi dari CS) tidak terpotong — kasus Retno.
const HISTORY_LIMIT_ORDER = 60

export type LeanSettings = LeanProviderSettings & {
  production?: Parameters<typeof renderProductionEstimate>[0]
  skills: Array<{ name: string; content: string }>
  paymentMethods: Array<{
    name: string
    destination: string
    accountName: string
    enabled: boolean
  }>
}

export type LeanReply = {
  decision: LeanDecision
  photos: Array<{ caption: string; url: string }>
  promptTokens: number
  promptSections: Array<{ key: string; chars: number; tokens: number }>
  usage: Awaited<ReturnType<typeof runLeanProvider>>['usage']
  durationMs: number
  orderId: number | null
  autoTotal: VerifiedAutoTotal | null
  skillName: string
}

const WAIT_NOTICE = 'waiting-notices'

export function selectLeanSkill(skills: Array<{ name: string; content: string }>) {
  const preferred = skills.find((skill) => skill.name === LEAN_SKILL_NAME)
  const chosen =
    preferred || skills.find((skill) => skill.name !== WAIT_NOTICE && skill.content.trim())
  if (!chosen) throw new Error(`Import skill ${LEAN_SKILL_NAME} (satu file) terlebih dahulu.`)
  return chosen
}

/** Susulan yang menyebut total / DP / rekening / transfer (butuh total yang sudah terkirim). */
export function susulanNeedsTotal(text: string) {
  return /\b(total\w*|dp|rekening|rek|transfer|tf|pelunasan|lunas|bayar\w*)\b/i.test(String(text || ''))
}

function stageFromNote(note: string) {
  const match = note.match(/tahap\s*[:=]\s*([a-z_]+)/i)
  return match ? match[1].toLowerCase() : ''
}

async function history(jid: string, currentIds: Set<string>, long = false): Promise<LeanHistoryRow[]> {
  const active = await latestLeanOrder(jid).catch(() => null)
  // v3.6.43: form order masuk giliran ini (order baru dibuat sesudah riwayat dibaca) → riwayat
  // panjang juga, supaya harga & pilihan yang dibahas sebelumnya tidak terpotong.
  const limit = long || (active && ['pending', 'awaiting_payment'].includes(String(active.status))) ? HISTORY_LIMIT_ORDER : HISTORY_LIMIT
  const rows = await db
    .from('whatsapp_messages')
    .select('message_id', 'direction', 'sender_type', 'body', 'media_type', 'media_url', 'created_at', 'reply_to_message_id')
    .where('jid', jid)
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
  // Pesan yang dikutip pelanggan ("yang ini berapa" sambil membalas foto Tuxedo).
  const quotedIds = [...new Set(rows.map((row) => row.reply_to_message_id).filter(Boolean))]
  const quoted = new Map<string, string>()
  if (quotedIds.length) {
    const found = await db
      .from('whatsapp_messages')
      .select('message_id', 'body', 'media_type')
      .whereIn('message_id', quotedIds as string[])
    for (const item of found) {
      const text = String(item.body || '').trim().replace(/\s+/g, ' ').slice(0, 160)
      quoted.set(String(item.message_id), text || (item.media_type ? `[${item.media_type}]` : ''))
    }
    // Kutipan ke status WhatsApp toko (diunggah dari HP): bukan pesan chat, disimpan terpisah.
    const missing = (quotedIds as string[]).filter((id) => !quoted.has(String(id)))
    if (missing.length) {
      const statuses = await statusPostsByIds(missing).catch(() => new Map())
      for (const [id, post] of statuses) quoted.set(id, describeStatus(post))
    }
  }
  // Gambar lama yang tidak dilihat AI (mis. dikirim saat CS membalas) diberi keterangan
  // singkat, supaya "yang hitam itu" merujuk produk di gambar, bukan tebakan.
  const notes = await imageNotes(jid, rows as any[], currentIds).catch(() => new Map<string, string>())
  return rows.reverse().map((row) => ({
    replyTo: row.reply_to_message_id ? quoted.get(String(row.reply_to_message_id)) || null : null,
    direction: row.direction === 'in' ? 'in' : 'out',
    senderType: row.sender_type,
    body: row.body,
    mediaType: row.media_type,
    mediaNote: notes.get(String(row.message_id)) || '',
    createdAt: row.created_at,
    current: currentIds.has(String(row.message_id)),
  }))
}

/**
 * Tanpa form order, total + rekening tidak pernah dikirim sistem: kalimat "ini totalnya saya
 * kirimkan" dibuang, diganti minta data pengiriman (atau "saya cek dulu" bila alamat sudah ada).
 */
export function guardTotalPromise(
  pesan: string[],
  options: { address: string; hasAddress: boolean; jev?: boolean; asked?: boolean }
) {
  const promise = /\b(ini|berikut|saya kirim\w*|kami kirim\w*|menyusul)\b[^.?!\n]*\btotal\w*\b[^.?!\n]*/i
  const promiseAfter = /\btotal\w*\b[^.?!\n]*\b(saya kirim\w*|kami kirim\w*|menyusul|dikirim\w*)\b[^.?!\n]*/i
  const matched = pesan.some((bubble) => promise.test(bubble) || promiseAfter.test(bubble))
  // Jev yakin (true/false) menang atas pola kata.
  if (options.jev === false || (options.jev === undefined && !matched)) return { pesan, changed: false, waitCs: false }
  const kept = pesan
    .map((bubble) =>
      matched
        ? bubble.replace(promise, '').replace(promiseAfter, '')
        : // Jev menemukan janji yang tidak tertangkap pola: buang kalimat yang menyebut total/rekening.
          bubble.replace(/[^.?!\n]*\b(total\w*|rekening)\b[^.?!\n]*[.?!]?/gi, '')
    )
    .map((bubble) => bubble.replace(/\s*[.,]\s*$/, '').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
  kept.push(
    options.hasAddress
      ? `Totalnya saya cek dulu ya ${options.address}`
      : options.asked
        ? // v3.6.82: format data pengiriman sudah diminta → tidak diulang panjang (terasa seperti bot).
          `Ditunggu data pengirimannya ya ${options.address}`
        : `Boleh kirim data pengirimannya dulu ${options.address}? (nama, alamat lengkap + kecamatan, kota, no HP) biar totalnya langsung saya kirim`
  )
  return { pesan: kept, changed: true, waitCs: options.hasAddress }
}

/**
 * Varian yang dimaksud pelanggan menurut Jev, hanya untuk kasus ragu: warna di spesifikasi adalah
 * warna katalog yang tidak pernah difotokan, padahal produk itu sudah difotokan di chat.
 * null = Jev tidak dipakai/ragu → aturan foto terakhir (`fixCatalogColors`).
 */
async function jevVariantFix(
  jid: string,
  spec: string,
  catalog: Array<{ product: string; color: string }>,
  rows: LeanHistoryRow[]
) {
  const norm = (value: string) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const chat = rows.map((row) => ({ direction: row.direction, body: row.body, mediaType: row.mediaType }))
  const lines = String(spec || '').split('\n')
  const swaps: Array<[string, string]> = []
  let decided = false
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)(.+?)\s+-\s+(.+?)\s*$/)
    if (!match) continue
    const colors = [...new Set(catalog.filter((row) => norm(row.product) === norm(match[2])).map((row) => row.color))]
    if (colors.length < 2 || !colors.some((color) => norm(color) === norm(match[3]))) continue
    const shown = chat
      .filter((row) => row.direction !== 'in' && row.mediaType === 'image')
      .map((row) => String(row.body || '').trim().match(/^(.+?)\s+-\s+(.+)$/))
      .filter((found) => found && norm(found[1]) === norm(match[2]))
      .map((found) => norm(found![2]))
    if (!shown.length || shown.includes(norm(match[3]))) continue
    const chosen = await chooseVariant(jid, match[2], colors, chat)
    if (chosen === undefined) continue
    decided = true
    if (chosen && norm(chosen) !== norm(match[3])) {
      swaps.push([match[3], chosen])
      lines[index] = `${match[1]}${match[2]} - ${chosen}`
    }
  }
  return decided ? { text: lines.join('\n'), swaps } : null
}

/** Layanan ongkir yang ditawarkan (alias huruf kecil, tanpa JTR) dari shipping_options order. */
export function offeredServices(raw: unknown) {
  let options: any = null
  try {
    options = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    options = null
  }
  const names = (Array.isArray(options?.prices) ? options.prices : [])
    .filter((row: any) => Number(row.price) > 0 && !/JTR/i.test(String(row.service)))
    .map((row: any) => String(row.service).toLowerCase().replace(/[^a-z]/g, '').replace(/^ctc/, '') || 'reg')
  return [...new Set<string>(names)]
}

/** Pesan toko yang sudah berisi total/rekening: order itu sudah ditangani (mis. oleh CS). */
export function looksLikeTotalSent(body: string, destinations: string[] = []) {
  const text = String(body || '')
  const digits = text.replace(/\D/g, '')
  if (destinations.some((dest) => dest.replace(/\D/g, '').length >= 6 && digits.includes(dest.replace(/\D/g, ''))))
    return true
  if (/\b(no\.?\s*rek|rek|rekening|atas nama|a\.n\.?)\b/i.test(text) && /\d{6,}/.test(digits)) return true
  return /\btotal\w*\b[^\n]*\d{1,3}(?:\.\d{3}){1,}/i.test(text) && /\b(transfer|tf|rek|rekening)\b/i.test(text)
}

/** Total (dan ongkir) yang ditulis toko di chat, mis. "Total 705.000 + 95.000 = 800.000". */
export function totalFromStoreMessages(bodies: string[]) {
  let total = 0
  let ongkir = 0
  const money = (value: string) => Number(value.replace(/\./g, '')) || 0
  for (const body of bodies) {
    for (const line of String(body || '').split(/\n/)) {
      const totalPart = line.match(/\btotal\w*\b(.*)$/i)?.[1] || ''
      const amounts = totalPart.match(/\d{1,3}(?:\.\d{3})+/g)
      if (amounts?.length) total = money(amounts[amounts.length - 1])
      const fee = line.match(/\bongkir\w*\b[^\d\n]{0,20}(\d{1,3}(?:\.\d{3})+)/i)?.[1]
      if (fee) ongkir = money(fee)
    }
  }
  return { total, ongkir: ongkir > 0 && ongkir < total ? ongkir : 0 }
}

/**
 * Form order yang terlewat: pelanggan mengirimnya saat CS sedang membalas (giliran AI
 * dibatalkan), jadi belum tercatat. Dicari di pesan masuk 24 jam terakhir yang lebih
 * baru dari order terakhir. `handled` = toko sudah mengirim total/rekening setelahnya
 * (order tetap dicatat dengan total dari CS, tanpa kirim total lagi).
 */
export async function missedOrderForm(
  jid: string,
  currentIds: Set<string>,
  destinations: string[],
  fallback: { name: string; phone: string }
) {
  const latest = await latestLeanOrder(jid).catch(() => null)
  const floor = Date.now() - 24 * 60 * 60_000
  const since = latest ? Math.max(floor, new Date(latest.created_at).getTime()) : floor
  const rows = await db
    .from('whatsapp_messages')
    .select('message_id', 'direction', 'body', 'created_at')
    .where('jid', jid)
    .where('created_at', '>', new Date(since))
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(80)
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const id = String(row.message_id || '')
    if (row.direction !== 'in' || !row.body || currentIds.has(id)) continue
    if (latest && String(latest.source_message_id || '') === id) return null
    const text = String(row.body)
    const typed = parseOrderForm(text)
    const form = typed || looseAddressForm(text, fallback.name, fallback.phone)
    if (!form) continue
    const storeRows = rows
      .slice(0, index)
      .filter((later) => later.direction !== 'in')
      .reverse()
    const store = storeRows.map((later) => String(later.body || ''))
    // Jev (bila aktif dan yakin) menilai pesan toko; tanpa Jev: pola kata total/rekening.
    const jevHandled = await storeSentTotal(jid, store).catch(() => undefined)
    const handled = jevHandled ?? store.some((body) => looksLikeTotalSent(body, destinations))
    // Saat total dikirim toko: bukti transfer setelahnya yang ditampilkan untuk dicek.
    const totalRow = storeRows.find((later) => /\btotal\w*\b[^\n]*\d{1,3}(?:\.\d{3})+/i.test(String(later.body || '')))
    return {
      form,
      text,
      messageId: id,
      formAt: new Date(row.created_at),
      pasted: !typed,
      handled,
      storeTotal: handled ? totalFromStoreMessages(store) : null,
      storeTotalAt: totalRow ? new Date(totalRow.created_at) : null,
    }
  }
  return null
}

/**
 * Form terlewat yang totalnya sudah dikirim CS manual: catat ordernya langsung sebagai
 * "menunggu pembayaran" dengan total dari CS, supaya tombol konfirmasi pembayaran muncul.
 * Tidak mengirim pesan apa pun. Mengembalikan id order atau null.
 */
export async function recoverHandledOrder(jid: string, destinations: string[]) {
  const latest = await latestLeanOrder(jid).catch(() => null)
  if (latest && ['pending', 'awaiting_payment'].includes(String(latest.status))) return null
  const contact = await db.from('whatsapp_contacts').where('jid', jid).select('name').first()
  const waPhone = phoneFromJid(jid)
  const found = await missedOrderForm(jid, new Set(), destinations, {
    name: contact?.name ? String(contact.name) : '',
    phone: waPhone ? `0${waPhone.replace(/^62/, '')}` : '',
  })
  if (!found?.handled || !found.storeTotal?.total) return null
  const [spec, chatNote] = await Promise.all([readOrderSpec(jid), readBeta3ChatNote(jid)])
  const id = await saveLeanOrder({
    jid,
    sourceMessageId: found.messageId,
    form: found.form,
    items: spec || [found.form.note, chatNote].filter(Boolean).join('\n'),
    spec: spec || undefined,
    chatNote: chatNote || undefined,
  })
  await syncOrderFromChat(jid, {
    total: found.storeTotal.total,
    ongkir: found.storeTotal.ongkir,
    layanan: '',
    dibayar: 0,
    dikonfirmasi: false,
  })
  // Waktu asli: order dibuat saat form masuk, total saat CS mengirimnya (dasar bukti transfer).
  await db
    .from('whatsapp_beta3_orders')
    .where('id', id)
    .update({ created_at: found.formAt, ...(found.storeTotalAt ? { updated_at: found.storeTotalAt } : {}) })
  return id
}

/** Ganti bubble yang menyebut ongkir berderet dalam satu kalimat dengan blok ongkir rapi. */
export function tidyShippingBubbles(bubbles: string[], notes: string[], address: string) {
  const block = notes
    .map((note) => note.match(/<<<ONGKIR\n([\s\S]+?)\nONGKIR>>>/)?.[1])
    .filter(Boolean)
    .pop()
  if (!block) return bubbles
  const prices = block
    .split('\n')
    .slice(1)
    .map((line) => line.match(/\s(\d{1,3}(?:\.\d{3})+)/)?.[1])
    .filter(Boolean) as string[]
  if (prices.length < 1) return bubbles
  return bubbles.map((bubble) => {
    const hits = prices.filter((price) => bubble.includes(price)).length
    if (hits < Math.min(2, prices.length) || bubble.includes(block.split('\n')[1])) return bubble
    const question =
      bubble
        .split(/(?<=[.!?])\s+/)
        .filter((part) => part.trim().endsWith('?') && !prices.some((price) => part.includes(price)))
        .pop() || `Mau pakai yang mana ${address}?`
    return `${block}\n\n${question.trim()}`
  })
}

/** Pesan sekarang yang membalas pesan lain: sebut jelas produk yang dimaksud. */
function replyContext(rows: LeanHistoryRow[]) {
  const quotes = [...new Set(rows.filter((row) => row.current && row.replyTo).map((row) => row.replyTo))]
  return quotes.length
    ? `(Pelanggan membalas pesan: ${quotes.map((quote) => `"${quote}"`).join(', ')} — "yang ini" berarti itu, jangan tanya ulang modelnya.)\n`
    : ''
}

/**
 * Pelanggan menyetujui tawaran terakhir toko ("kalau mau saya kirimkan daftar modelnya" → "boleh"),
 * walau setelahnya menulis pertanyaan lain. Tawaran itu harus langsung dikerjakan, bukan ditunggu.
 */
export function acceptedOffer(rows: LeanHistoryRow[]) {
  const current = rows.filter((row) => row.current && row.direction === 'in')
  if (!current.length) return ''
  const firstCurrent = rows.indexOf(current[0])
  const lastOut = rows
    .slice(0, firstCurrent)
    .reverse()
    .find((row) => row.direction === 'out' && row.body)
  const isOffer = (text: string) =>
    /\b(kalau|kalo|klo|bila|jika)\s+(mau|berkenan)|\bmau\s+(saya|sy|aku)\b|\bsaya\s+(kirim|kirimkan|kirimin|buatkan|cekkan|carikan)\b/i.test(text)
  const isYes = (text: string) =>
    /^(boleh|oke|ok|okk|okay|iya|iyaa|ya|yaa|mau|siap|gas|bisa|silakan|silahkan|monggo|lanjut|kirim|kirimin|kirimkan)\b[^?]{0,24}$/i.test(text.trim()) ||
    /^(bisa|tolong|minta)\s+(di\s*)?kirim/i.test(text.trim())
  // Setuju sambil membalas (kutip) tawarannya, atau setuju setelah tawaran di pesan keluar terakhir.
  const quoted = current.find((row) => row.replyTo && isOffer(String(row.replyTo)) && isYes(String(row.body || '')))
  const offer = String(quoted?.replyTo || lastOut?.body || '').trim()
  if (!isOffer(offer)) return ''
  const agree = Boolean(quoted) || current.some((row) => isYes(String(row.body || '')))
  return agree
    ? `(Pelanggan sudah SETUJU tawaranmu: "${offer.slice(0, 160)}". Kerjakan sekarang di balasan ini (mis. kirim daftar/foto dari KATALOG), sekaligus jawab pertanyaan lain di pesannya. Jangan bertanya ulang atau menunggu.)\n`
    : ''
}

/**
 * Buang bubble pertanyaan yang sudah ditanyakan di balasan keluar terakhir
 * ("biasanya pakai size apa bos?" dua kali berturut-turut). Bubble lain tetap;
 * kalau semua bubble adalah ulangan, balasan dibiarkan apa adanya.
 */
export function dropRepeatedQuestions(pesan: string[], rows: LeanHistoryRow[]) {
  const norm = (text: string) =>
    text
      .toLowerCase()
      .replace(/\b(bos|ka|kak|ya)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const recent = rows
    .filter((row) => row.direction === 'out' && !row.current && row.body)
    // v3.6.55: 6 balasan terakhir (dulu 3) — sesudah selingan topik lain, pertanyaan order tidak ditagih ulang.
    .slice(-6)
    .map((row) => norm(String(row.body)))
  const kept = pesan.filter((body) => {
    if (!body.includes('?')) return true
    const key = norm(body)
    return key.length < 8 || !recent.some((prev) => prev.includes(key))
  })
  return kept.length ? kept : pesan
}

export function resolvePhotos(rows: LeanCatalogRow[], labels: string[]) {
  const photos: Array<{ caption: string; url: string }> = []
  for (const label of labels) {
    const row = findCatalogVariant(rows, label)
    if (!row?.photoUrl) continue
    const caption = row.color ? `${row.product} - ${row.color}` : row.product
    if (photos.some((photo) => photo.url === row.photoUrl)) continue
    photos.push({ caption, url: row.photoUrl })
  }
  // v3.6.78: maks 10 (pelanggan minta lihat semua warna); biasanya AI memilih 1–3.
  return photos.slice(0, 10)
}

export async function createLeanReply(input: {
  jid: string
  messageIds: string[]
  text: string
  imagePaths?: string[]
  /** message_id tiap gambar di imagePaths (urutan sama), untuk referensi per bagian. */
  imageIds?: string[]
  settings: LeanSettings
  onTrace?: TraceSink
  /** Catatan sistem untuk giliran ini (mis. CS sudah menjawab sebagian, chat sedang menunggu CS). */
  note?: string
  /** v3.6.78 Uji percakapan: riwayat dari simulasi (bukan tabel pesan). */
  history?: LeanHistoryRow[]
  /** v3.6.78 Uji percakapan: tanpa efek ke data pelanggan (prioritas, referensi gambar, sinkron order). */
  simulate?: boolean
}): Promise<LeanReply> {
  const { jid, settings, onTrace } = input
  const skill = selectLeanSkill(settings.skills)
  const skillTokens = estimateTokens(skill.content)

  // v3.6.39: isi skill sama, format ringkas (digest). Skill asli tidak diubah; digest belum ada /
  // tidak lengkap → skill asli. Skill diubah tanpa DIGEST.md baru → digest dibuat AI sekali di latar.
  const skillUsed = await skillForPrompt(skill, async (content) => {
    const made = await runLeanProvider(
      { ...settings, aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt' },
      digestPrompt(content),
      [],
      'beta3-digest',
      { type: 'object', additionalProperties: false, properties: { digest: { type: 'string' } }, required: ['digest'] },
      { tier: 'standard' }
    )
    return String(JSON.parse(made.text).digest || '')
  }).catch(() => ({ content: skill.content, digest: false, fallback: [] as string[] }))
  // v3.6.66: peringatan hanya bila skill ASLI yang terkirim (ringkasan dipakai → tidak relevan).
  if (!skillUsed.digest && skillTokens > LEAN_SKILL_TOKEN_LIMIT)
    onTrace?.({
      key: 'beta3-skill',
      label: `Skill ${skill.name} terlalu panjang (~${skillTokens} token, batas ${LEAN_SKILL_TOKEN_LIMIT})`,
      status: 'completed',
      detail: { tokens: skillTokens, limit: LEAN_SKILL_TOKEN_LIMIT },
    })

  await seedLeanExamples().catch(() => 0)
  const [digest, examples, customerNote, chatNote, rows, spec, rules] = await Promise.all([
    catalogDigest(),
    listLeanExamples(),
    readCustomerNote(jid),
    readBeta3ChatNote(jid),
    input.history
      ? Promise.resolve(input.history)
      : history(jid, new Set(input.messageIds), Boolean(parseOrderForm(input.text) || parseLooseAddress(input.text))),
    readOrderSpec(jid),
    listRules(),
  ])
  const stage = stageFromNote(chatNote)
  // Gaya balasan toko: sama untuk ChatGPT, Claude, dan Gemini; sapaan mengikuti CS di chat ini.
  const style = styleForChat(await storeStyle(examples).catch(() => null), rows)
  // Sapaan / terima kasih: jawabannya selalu sama → tanpa memanggil AI (0 token).
  const quickRaw = quickReply({
    text: input.text,
    imageCount: input.imagePaths?.length || 0,
    note: input.note,
    stage,
    rows,
  })
  // v3.6.85 — Tawaran jasa/kerja sama dari bisnis lain: bukan pelanggan → sapa singkat & serahkan ke owner.
  // Balasan otomatis bot bisnis lain ("ketik 1 untuk …") tidak dibalas.
  const pitch = !input.imagePaths?.length && isBusinessPitch(input.text)
  const otherBot = !pitch && !input.imagePaths?.length && isOtherBot(input.text)
  const quickText = pitch ? ['Halo, salam kenal. Terima kasih infonya, saya sampaikan ke owner dulu ya'] : otherBot ? [] : quickRaw
  const quick = quickText && style && !pitch ? normalizeStyle(quickText, style) : quickText
  if (quick) {
    onTrace?.({
      key: 'beta3-quick',
      label: pitch ? 'Tawaran bisnis lain → owner (0 token)' : quick.length ? 'Balasan cepat tanpa AI (0 token)' : 'Tidak perlu dibalas (0 token)',
      status: 'completed',
      detail: { pesan: quick },
    })
    return {
      decision: {
        pesan: quick,
        foto: [],
        catatan: chatNote,
        tahap: (stage || 'lain') as LeanDecision['tahap'],
        serah_cs: pitch,
        alasan: pitch ? 'Tawaran jasa/kerja sama dari bisnis lain' : '',
        // Diam ("makasih" sesudah "sama-sama"): susulan yang sudah direncanakan tetap jalan.
        susulan: quick.length || otherBot ? '' : await previousNudge(jid),
        spesifikasi: String(spec || ''),
      },
      autoTotal: null,
      photos: [],
      promptTokens: 0,
      promptSections: [],
      usage: null,
      durationMs: 0,
      orderId: null,
      skillName: skill.name,
    }
  }
  // Berat pesanan dari spesifikasi × berat produk (MCP toko): ongkir dicek sesuai berat asli.
  const orderGrams = await orderWeightGrams(String(spec || '')).catch(() => DEFAULT_ITEM_GRAMS)

  // Tool dipanggil KODE pada event: TB/BB → fit advisor, form → ongkir. Model tidak memanggil tool.
  const mcp = await readLeanMcpConfig()
  const toolNotes: string[] = []
  const fitLastKey = `fit:last:${jid}`
  // Tinggi & berat bisa dikirim terpisah; rangkai dari riwayat. Fit advisor dipanggil saat
  // pesan ini melengkapi datanya atau pelanggan menanyakan size/rekomendasi.
  const asksSize =
    /\b(size|ukuran|celana|nomor|no|rekomendasi|rekomen|pake apa|pakai apa|cocok|muat|pas)\b/i.test(input.text)
  const historyMeasure = measureFromHistory(rows)
  const lastFit = parseJson<{ note: string; at: number; key?: string }>(await readLeanState(fitLastKey))
  const measure =
    extractBodyMeasure(input.text) ||
    (historyMeasure &&
    (asksSize ||
      /\d{2,3}/.test(input.text) ||
      lastFit?.key !== `${historyMeasure.height}:${historyMeasure.weight}`)
      ? historyMeasure
      : null)
  if (measure && mcp.url) {
    // Jas dan celana sekaligus, supaya "celananya no berapa" nanti tidak ditebak model.
    const cacheKey = `fit:${jid}:${measure.height}:${measure.weight}`
    try {
      let cached = await readLeanState(cacheKey)
      if (!cached) {
        const notes: string[] = []
        for (const type of ['suit', 'pants'] as const) {
          const fit = await callLeanTool<FitResult>('fit_advisor', { type, ...measure }, mcp)
          if (fit?.recommended_size) notes.push(renderFitResult(fit, measure, type))
        }
        cached = notes.join('\n')
        if (cached) await writeLeanState(cacheKey, cached)
      }
      if (cached) {
        await writeLeanState(
          fitLastKey,
          JSON.stringify({ note: cached, at: Date.now(), key: `${measure.height}:${measure.weight}` })
        )
        toolNotes.push(cached)
        onTrace?.({
          key: 'beta3-fit',
          label: `Fit advisor · ${cached.split(':')[1]?.trim().split('.')[0] || ''}`,
          status: 'completed',
          detail: { measure },
        })
      }
    } catch (error) {
      onTrace?.({
        key: 'beta3-fit',
        label: 'Fit advisor tidak tersedia',
        status: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  } else if (asksSize) {
    // Pertanyaan size/celana beberapa pesan setelah TB/BB: ulangi rekomendasi yang sama (3 jam).
    if (lastFit?.note && Date.now() - lastFit.at < 3 * 60 * 60_000) toolNotes.push(lastFit.note)
  }
  // Warna produk di gambar pelanggan diukur dari piksel (+ Jev), bukan ditebak mata model.
  if (input.imagePaths?.length) {
    const colorNote = await imageColorNote({
      jid,
      paths: input.imagePaths,
      rows: digest.rows,
      text: input.text,
      history: rows,
    }).catch(() => null)
    if (colorNote?.note) {
      toolNotes.push(colorNote.note)
      onTrace?.({
        key: 'beta3-image-color',
        label: `Warna gambar diukur · ${colorNote.detail.map((item) => item.pick || item.shade).join(', ')}`,
        status: 'completed',
        detail: colorNote.detail,
      })
    }
  }
  // Ukuran badan (pinggang/dada/…) dibandingkan dengan SIZE CHART oleh kode.
  const sizeCharts = await readLeanState('size_charts')
  const chartNote = compareWithSizeChart(rows, String(sizeCharts || ''))
  if (chartNote) {
    toolNotes.push(chartNote)
    onTrace?.({ key: 'beta3-sizechart', label: 'Size chart dibandingkan', status: 'completed', detail: { catatan: chartNote } })
  }

  // Jalur 2: form order dibaca kode, disimpan untuk CS. AI tetap menulis balasannya.
  let orderId: number | null = null
  let systemNote = ''
  const typedForm = parseOrderForm(input.text)
  // Alamat yang ditempel bebas juga dianggap form order supaya total terkirim otomatis.
  let pasted: ReturnType<typeof looseAddressForm> = null
  let typedLookback: ReturnType<typeof parseOrderForm> = null
  let formText = input.text
  let formMessageId = input.messageIds[input.messageIds.length - 1]
  let missed = false
  if (!typedForm) {
    const contact = await db.from('whatsapp_contacts').where('jid', jid).select('name').first()
    const waPhone = phoneFromJid(jid)
    const fallback = {
      name: contact?.name ? String(contact.name) : '',
      phone: waPhone ? `0${waPhone.replace(/^62/, '')}` : '',
    }
    pasted = looseAddressForm(input.text, fallback.name, fallback.phone)
    // Form yang dikirim saat CS membalas belum tercatat: ambil sekarang supaya ongkir
    // dicek dan total bisa dikirim otomatis, bukan menunggu CS.
    if (!pasted) {
      const found = await missedOrderForm(
        jid,
        new Set(input.messageIds),
        settings.paymentMethods.map((method) => method.destination),
        fallback
      ).catch(() => null)
      if (found?.handled) {
        // Total sudah dikirim CS: catat order + totalnya saja, jangan kirim total lagi.
        const recovered = await recoverHandledOrder(
          jid,
          settings.paymentMethods.map((method) => method.destination)
        ).catch(() => null)
        if (recovered)
          onTrace?.({
            key: 'beta3-order',
            label: `Order #${recovered} dicatat dari form + total CS · menunggu pembayaran`,
            status: 'completed',
            detail: { orderId: recovered },
          })
      } else if (found) {
        missed = true
        formText = found.text
        formMessageId = found.messageId
        if (found.pasted) pasted = found.form
        else typedLookback = found.form
      }
    }
  }
  const form = typedForm || typedLookback || pasted
  // v3.6.41: No. telp di form kosong → pakai nomor WhatsApp chat ini (seperti CS: "pakai nomor ini
  // aja"), jangan ditanyakan sambil total dikirim. Kontak @lid (tanpa nomor) tetap ditanyakan AI.
  let phoneFromWa = false
  if (form && !form.phone) {
    const waPhone = phoneFromJid(jid)
    if (waPhone) {
      form.phone = `0${waPhone.replace(/^62/, '')}`
      phoneFromWa = true
    }
  }

  // Pertanyaan ongkir bebas ("ongkir ke cinyawang berapa"): kode cari tujuan lalu tarif.
  // Lanjutannya ("kalo ke jakarta?", "mampang", "jakarta selatan") dikenali 30 menit.
  // Tarif per KECAMATAN; kelurahan tidak ditanyakan.
  const lastKey = `ongkir:last:${jid}`
  const last = form ? null : parseJson<LastShipping>(await readLeanState(lastKey))
  // Juga saat AI baru bertanya "pengiriman kemana": jawaban "ke pulogadung" langsung dicek.
  const followUp = Boolean(last && Date.now() - last.at < 30 * 60_000) || stage === 'minta_alamat'

  // Alamat lengkap yang ditempel tanpa format form: ongkirnya langsung dicek,
  // supaya balasan menyebut tarif, bukan hanya "alamatnya sudah dicatat".
  const loose = form ? null : parseLooseAddress(input.text)
  if (loose && mcp.url) {
    try {
      const rates = await ratesForAddress(loose, last?.resolved || null, mcp, orderGrams, input.text)
      const rateText = rates ? renderShippingRates(rates, orderGrams) : ''
      if (rateText) {
        toolNotes.push(rateText)
        systemNote +=
          '\n\nCATATAN SISTEM: pelanggan mengirim alamat pengiriman; sebut ongkirnya memakai blok ONGKIR (satu layanan per baris) di balasan ini, jangan hanya "alamatnya sudah dicatat".'
      }
      onTrace?.({
        key: 'beta3-rates',
        label: rateText ? `Ongkir dicek · ${rates?.destination?.district || loose.district || loose.regency}` : 'Ongkir alamat tidak ditemukan',
        status: rateText ? 'completed' : 'failed',
        detail: { loose, rates },
      })
    } catch (error) {
      onTrace?.({
        key: 'beta3-rates',
        label: 'Ongkir tidak tersedia',
        status: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  const extracted = form || loose ? null : extractShippingQuery(input.text, followUp)
  // v3.6.80: jawaban singkat atas pilihan tujuan ("kab", "yang kota") tidak berisi nama tempat.
  const choiceHit = !form && !loose && followUp && last?.pending && last.choices?.length ? pickArea(input.text, last.choices) : null
  const place = extracted || (choiceHit ? last?.place || choiceHit.label : null)
  if (place && mcp.url) {
    try {
      let note = ''
      let pending = false
      let choices: DestinationArea[] = []
      let resolved: DestinationArea | null = null
      let kept = false
      // Jawaban atas pilihan yang tadi ditanyakan: cocokkan dulu, tanpa cari ulang.
      if (choiceHit) resolved = choiceHit
      else if (followUp && last?.pending && last.choices?.length)
        resolved = pickArea(input.text, last.choices)
      if (!resolved) {
        // Lanjutan obrolan ongkir tanpa kata "ongkir": Jev memastikan ini memang tujuan baru.
        const ambiguous = Boolean(followUp && last?.resolved && !last.pending && !/ongkir|kirim/i.test(input.text))
        const fresh = ambiguous
          ? await isNewDestination(jid, input.text, place, last!.resolved!.label).catch(() => undefined)
          : undefined
        let areas = fresh === false ? [] : groupDestinations(await findDestinations(place, mcp))
        if (!areas.length && fresh !== false && last?.pending && last.place && !place.includes(last.place))
          areas = groupDestinations(await findDestinations(`${place} ${last.place}`, mcp))
        if (!areas.length && ambiguous && last?.resolved) {
          // Tujuan sudah jelas sebelumnya; jawaban ini bukan nama tempat baru (mis. "reg aja").
          onTrace?.({ key: 'beta3-rates', label: `Bukan tujuan baru · tetap ${last.resolved.label}`, status: 'completed', detail: { place } })
          kept = true
          note = `TUJUAN tetap ${last.resolved.label}; ongkirnya sudah disebut di chat. Pesan ini bukan tujuan baru (mis. memilih layanan) — jangan tanya kecamatan/ongkir lagi, lanjut tahap berikutnya.`
        }
        if (kept) {
          // tetap memakai tujuan sebelumnya
        } else if (!areas.length) {
          pending = true
          note = `TUJUAN "${place}" tidak ditemukan di data ekspedisi. Tanyakan kecamatan dan kabupatennya (satu pertanyaan).`
        } else if (areas.length > 4) {
          pending = true
          note = `TUJUAN "${place}" terlalu luas (banyak kecamatan). Tanyakan kecamatannya (satu pertanyaan), jangan sebut ongkir dulu.`
        } else if (areas.length > 1) {
          pending = true
          choices = areas
          note = renderDestinationChoices(place, areas)
        } else {
          resolved = areas[0]
        }
      }
      if (resolved) {
        const cacheKey = `ongkir4:${resolved.code}:${orderGrams}:${new Date().toISOString().slice(0, 10)}`
        note = await readLeanState(cacheKey)
        if (!note) {
          const rates = await callLeanTool<ShippingRates>(
            'check_shipping_rates',
            { destination: resolved.code, weight_grams: orderGrams },
            mcp
          )
          // Nama kecamatan & kota dari hasil cari tujuan ("Ongkir ke Patimuan, Cilacap", bukan "ke tujuan").
          note = rates ? renderShippingRates(withArea(rates, resolved), orderGrams) : ''
          if (note) await writeLeanState(cacheKey, note)
        }
      }
      if (!kept)
        await writeLeanState(
          lastKey,
          JSON.stringify({ place, pending, at: Date.now(), choices, resolved } satisfies LastShipping)
        )
      if (note) {
        toolNotes.push(note)
        onTrace?.({
          key: 'beta3-rates',
          label: `Ongkir dicek · ${resolved?.label || place}`,
          status: 'completed',
          detail: { place, note, followUp },
        })
      }
    } catch (error) {
      onTrace?.({
        key: 'beta3-rates',
        label: 'Ongkir tidak tersedia',
        status: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  // Lacak resi: pelanggan menanyakan posisi paket → resi dari pesan ini atau dari pesan
  // toko terakhir yang menyebut resi, lalu track_awb (cache 30 menit).
  const asksTracking =
    /\b(resi|paket|lacak|tracking|posisi|sampai mana|sampe mana|nyampe|sudah sampai|udah sampai|belum sampai|belum datang|kapan sampai|kapan datang|kapan tiba|dikirim|sudah kirim|udah kirim|sdh dikirim)\b/i.test(
      input.text
    )
  // Dipanggil lagi sesudah Jev bila maksud pesannya "status pesanan" tapi pola kata tidak menangkapnya.
  let tracked = false
  const trackParcel = async () => {
    if (tracked || !mcp.url) return
    tracked = true
    let awb = extractAwb(input.text)
    let selfDelivery = false
    if (!awb)
      for (const row of [...rows].reverse()) {
        if (row.direction !== 'out') continue
        awb = detectAwb(String(row.body || ''))
        if (awb) break
        // v3.6.31: toko sudah bilang diantar sendiri/diambil → tidak ada resi untuk dilacak.
        if (looksSelfDelivery(String(row.body || ''))) {
          selfDelivery = true
          break
        }
      }
    if (selfDelivery) {
      toolNotes.push('PENGIRIMAN: pesanan diantar langsung oleh tim toko / diambil pelanggan — tidak ada resi. Jangan menjanjikan atau menanyakan nomor resi; jawab dari status pengantarannya.')
      onTrace?.({ key: 'beta3-awb', label: 'Diantar tim sendiri · tanpa resi', status: 'completed', detail: {} })
    }
    if (awb) {
      try {
        const cacheKey = `awb:${awb}`
        const cached = parseJson<{ note: string; at: number }>(await readLeanState(cacheKey))
        let note = cached && Date.now() - cached.at < 30 * 60_000 ? cached.note : ''
        if (!note) {
          const result = await callLeanTool<AwbTracking>('track_awb', { awb }, mcp)
          note = result ? renderAwbTracking(result, awb) : ''
          if (note) await writeLeanState(cacheKey, JSON.stringify({ note, at: Date.now() }))
        }
        if (note) {
          toolNotes.push(note)
          onTrace?.({ key: 'beta3-awb', label: `Resi dilacak · ${awb}`, status: 'completed', detail: { awb, note } })
        }
      } catch (error) {
        toolNotes.push(`LACAK RESI ${awb}: data pelacakan belum tersedia. Sampaikan nomor resinya dan bahwa paket sedang dalam perjalanan; jangan menebak posisi.`)
        onTrace?.({
          key: 'beta3-awb',
          label: 'Lacak resi tidak tersedia',
          status: 'failed',
          detail: { awb, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }
  if (asksTracking) await trackParcel()

  if (form) {
    let rates: ShippingRates | null = null
    if (mcp.url && (form.district || form.postalCode)) {
      try {
        const lastResolved = parseJson<LastShipping>(await readLeanState(lastKey))?.resolved
        rates = await ratesForAddress(
          { district: form.district, regency: form.regency, postalCode: form.postalCode },
          lastResolved || null,
          mcp,
          orderGrams,
          formText || input.text
        )
        // Alamat tempelan dirapikan ulang dengan nama resmi tujuan dari cek ongkir.
        const tidy = pasted ? tidyLooseAddress(formText, rates?.destination || null) : null
        if (tidy) {
          form.address = tidy.full
          form.district = tidy.district || form.district
          form.regency = tidy.regency || form.regency
        }
        onTrace?.({
          key: 'beta3-rates',
          label: `Ongkir dicek · ${rates?.destination?.district || form.district}`,
          status: 'completed',
          detail: rates,
        })
      } catch (error) {
        onTrace?.({
          key: 'beta3-rates',
          label: 'Ongkir tidak tersedia',
          status: 'failed',
          detail: { error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
    orderId = await saveLeanOrder({
      jid,
      sourceMessageId: formMessageId,
      form,
      items: spec || [form.note, chatNote].filter(Boolean).join('\n'),
      spec,
      chatNote,
      shippingOptions: rates?.prices?.length ? rates : null,
    })
    const rateText = rates ? renderShippingRates(rates, orderGrams) : ''
    if (rateText) toolNotes.push(rateText)
    systemNote =
      '\n\nCATATAN SISTEM: form order pelanggan sudah tercatat (#' +
      orderId +
      ')' +
      (missed ? ' — form ini dikirim pelanggan sebelumnya (saat CS membalas) dan baru tercatat sekarang; lanjutkan prosesnya sendiri, jangan menunggu CS' : '') +
      '. Jangan menulis total atau rekening di pesan — sistem yang mengirimnya. ' +
      (phoneFromWa ? 'No. telp di form kosong: sistem memakai nomor WhatsApp chat ini — jangan menanyakan nomor telp. ' : '') +
      'Isi field order (rincian per item dengan nama persis KATALOG + harga, subtotal, layanan ongkir yang dipilih pelanggan). ' +
      'Kalau ada TB/BB dan size yang dipilih terlihat tidak cocok, konfirmasi size dulu (satu pertanyaan). ' +
      (rateText
        ? 'Kalau bagian ONGKIR punya lebih dari satu layanan dan pelanggan belum memilih, tanyakan (satu pertanyaan) dan kosongkan layanan; bila hanya satu layanan, langsung pakai itu. Kalau sudah lengkap: balas "siap bos, datanya sudah masuk ya, ini totalnya" — total + rekening menyusul otomatis. tahap = tunggu_cs.'
        : 'Ongkir belum bisa dihitung: balas singkat bahwa ongkir dan totalnya dikabari sebentar lagi; kosongkan layanan. tahap = tunggu_cs.')
    onTrace?.({
      key: 'beta3-order',
      label: `Form order tercatat #${orderId} · menunggu CS isi ongkir/total`,
      status: 'completed',
      detail: { orderId, form },
    })
  }

  // Form sudah masuk di giliran sebelumnya tapi total belum terkirim (mis. rincian
  // belum cocok, layanan belum dipilih, ongkir gagal): tetap minta AI mengisi `order`
  // supaya total bisa dikirim otomatis di giliran ini, dan coba hitung ongkir lagi.
  if (!form && !orderId) {
    const pending = await latestLeanOrder(jid)
    if (pending && pending.status === 'pending' && mcp.url) {
      orderId = Number(pending.id)
      let rates: (ShippingRates & { grams?: number }) | null = pending.shipping_options
        ? (parseJson<ShippingRates>(String(pending.shipping_options)) as ShippingRates | null)
        : null
      // Berat berubah (item bertambah/berkurang) → tarif lama tidak dipakai, dihitung ulang.
      const ratesGrams = Number(rates?.grams ?? (rates as any)?.weight_grams ?? 0)
      if (!rates?.prices?.length || (ratesGrams && ratesGrams !== orderGrams)) {
        try {
          const lastResolved = parseJson<LastShipping>(await readLeanState(lastKey))?.resolved
          rates = await ratesForAddress(
            {
              district: String(pending.district || ''),
              regency: String(pending.regency || ''),
              postalCode: String(pending.postal_code || ''),
            },
            lastResolved || null,
            mcp,
            orderGrams,
            String(pending.address || '')
          )
          if (rates?.prices?.length) await updatePendingOrderRates(orderId, { ...rates, grams: orderGrams })
        } catch (error) {
          onTrace?.({
            key: 'beta3-rates',
            label: 'Ongkir tidak tersedia',
            status: 'failed',
            detail: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      const rateText = rates ? renderShippingRates(rates, orderGrams) : ''
      if (rateText) toolNotes.push(rateText)
      systemNote =
        '\n\nCATATAN SISTEM: form order #' +
        orderId +
        ' sudah tercatat, total belum terkirim. Jangan menulis total atau rekening di pesan. ' +
        'Isi field order (rincian per item dengan nama persis KATALOG + harga, subtotal, layanan ongkir pilihan pelanggan) supaya sistem mengirim total + rekening otomatis setelah pesanmu. ' +
        (rateText
          ? 'Kalau bagian ONGKIR punya lebih dari satu layanan dan pelanggan belum memilih, tanyakan (satu pertanyaan) dan kosongkan layanan; bila hanya satu layanan, langsung pakai itu. Kalau sudah jelas: balas "siap bos, ini totalnya ya". tahap = tunggu_cs.'
          : 'Ongkir belum bisa dihitung: balas singkat bahwa totalnya dikabari sebentar lagi; kosongkan layanan. tahap = tunggu_cs.')
      onTrace?.({
        key: 'beta3-order',
        label: `Order #${orderId} masih menunggu total`,
        status: 'completed',
        detail: { orderId, rates: Boolean(rateText) },
      })
    }
  }

  // Jev (bila aktif): pahami pesan ini — maksud, data pengiriman, perlu CS, setuju, layanan ongkir.
  const pendingForJev = orderId ? await readLeanOrder(orderId).catch(() => null) : await latestLeanOrder(jid).catch(() => null)
  const understanding = await understandTurn({
    jid,
    text: input.text,
    history: rows.map((row) => ({ direction: row.direction, body: row.body, mediaType: row.mediaType })),
    services: offeredServices(pendingForJev?.status === 'pending' ? pendingForJev.shipping_options : null),
    offerPending: rows.some((row, index) => index >= rows.length - 4 && row.direction === 'out' && /total|\d{1,3}(?:\.\d{3})+/i.test(String(row.body || ''))),
    awaitingPayment: pendingForJev?.status === 'awaiting_payment',
  }).catch(() => ({}) as TurnUnderstanding)
  // Prioritas chat untuk kotak masuk ("Penting").
  if (understanding.urgency && !input.simulate) await saveChatPriority(jid, understanding.urgency).catch(() => {})
  // Maksud "status pesanan" yang tidak tertangkap pola kata → lacak resi juga.
  if (understanding.intent === 'status_pesanan') await trackParcel()
  // "oke/siap" tanda terima tetap dibalas singkat oleh AI (seperti v3.5.7); diam membuat chat terasa putus.
  if (understanding.reaction === 'terima' && !systemNote && !toolNotes.length && !form && !loose)
    // Bukan "CATATAN SISTEM" supaya tidak memaksa model berat untuk sekadar "oke".
    systemNote += '\n\n(Pesan ini hanya tanda terima: balas satu kalimat singkat yang nyambung, tanpa pertanyaan baru; isi susulan langkah berikutnya.)'
  // v3.6.87 — link luar (Instagram/TikTok/Shopee…) tidak bisa dibuka AI: jangan memastikan bisa dibuat.
  if (foreignLink(input.text))
    systemNote +=
      '\n\nCATATAN SISTEM: pelanggan mengirim link yang tidak bisa kamu buka. Jangan memastikan model/produk di link itu bisa dibuat; minta screenshot/foto modelnya biar dicek.'
  if (understanding.paidClaim && pendingForJev?.status === 'awaiting_payment')
    systemNote +=
      '\n\nCATATAN SISTEM: pelanggan menyatakan SUDAH transfer. Balas "siap bos, kami cek dulu ya" (minta bukti transfernya bila belum dikirim); jangan bilang sudah diterima. tahap = bukti_dikirim.'
  if (understanding.hasShippingData && !form && !loose)
    systemNote +=
      '\n\nCATATAN SISTEM: pelanggan sepertinya mengirim data pengiriman, tapi belum lengkap terbaca. Minta bagian yang kurang (nama, alamat lengkap, kecamatan, kota, no HP) dalam satu pesan.'
  if (understanding.csReason && understanding.csReason !== 'tidak_perlu')
    systemNote += `\n\nCATATAN SISTEM: pesan ini kemungkinan perlu ditangani manusia (${understanding.csReason.replace(/_/g, ' ')}). Ikuti aturan serah_cs di skill.`
  if (understanding.agreed && pendingForJev?.status === 'pending')
    systemNote += '\n\nCATATAN SISTEM: pelanggan sudah menyetujui. Isi field order lengkap supaya total + rekening terkirim otomatis.'
  // v3.6.62 Hati CS: bacaan Jev (bentuk kalimat, rasa, momen) → petunjuk singkat untuk AI.
  const greeted = rows.some((row) => row.direction === 'out' && !row.current && GREETED.test(String(row.body || '')))
  const hati = heartNote(understanding.heart, greeted)
  if (hati) {
    systemNote += `\n\n${hati}`
    onTrace?.({ key: 'beta3-hati', label: heartLabel(understanding.heart), status: 'completed', detail: { ...understanding.heart } })
  }
  const storeProfile = await readLeanState('store_profile')
  const storedWholesale = String((await readLeanState('wholesale').catch(() => '')) || '')
  // v3.6.60: teks lama ("dibuat lewat invoice") ditulis ulang dengan syarat mulai 6 jas.
  const wholesale = renderWholesaleRule(wholesaleDiscounts(storedWholesale)) || storedWholesale
  // v3.6.78: aturan grosir SELALU ikut (±80 token) — AI memahami maksud "beli banyak/kurang ga"
  // dalam bahasa apa pun; dulu ikut hanya bila pola kata cocok, sehingga kalimat tak biasa terlewat.
  const store = [storeProfile, wholesale]
    .filter(Boolean)
    .join('\n')
  const policy = await readExchangePolicy()
  const activeOrder = await renderActiveOrder(jid).catch(() => '')
  // Pola harga per seri (dihitung dari katalog): selalu ikut, dan dipakai pemeriksa harga sesudah balasan.
  const prices = pricePattern(digest.rows)
  const priceText = renderPricePattern(prices)
  // Seri dari teks chat lebih dipercaya; tebakan Jev dipakai bila teks tidak menyebut seri.
  const textSeries = seriesMentioned([...rows.slice(-6).map((row) => String(row.body || '')), input.text])
  const priceSeries: PriceSeries | null = textSeries || understanding.series || null
  const seriesAgree = !understanding.series || !textSeries || understanding.series === textSeries
  let priceNote = ''
  if (understanding.item && priceSeries && seriesAgree) {
    const cell =
      prices.series[priceSeries]?.cells[`${understanding.item}:standar`]
    if (cell)
      priceNote = `\n\nCATATAN SISTEM: pelanggan menanyakan harga ${understanding.item} seri ${priceSeries}: ${cell.price.toLocaleString('id-ID')}${cell.big && cell.big !== cell.price ? ` (XXL ke atas ${cell.big.toLocaleString('id-ID')})` : ''} menurut POLA HARGA. Pakai angka ini.`
  }
  // Bagian prompt yang tidak dibutuhkan giliran ini tidak dikirim (hemat token).
  const needs = promptNeeds({
    stage,
    text: input.text,
    imageCount: input.imagePaths?.length || 0,
    rows,
    intent: understanding.intent,
    hasFit: toolNotes.some((note) => /fit advisor|rekomendasi size|size chart/i.test(note)),
    topics: understanding.topics,
  })
  // Skill hanya bagian yang dibutuhkan; katalog hanya produk/warna yang sedang dibahas.
  const skillNeed = skillContext({
    stage,
    text: input.text,
    imageCount: input.imagePaths?.length || 0,
    rows,
    spec: String(spec || ''),
    needs,
    shippingNotes: Boolean(systemNote) || toolNotes.some((note) => /ONGKIR|TUJUAN/.test(note)),
    hasOrder: Boolean(activeOrder) || Boolean(pendingForJev),
    topics: understanding.topics,
  })
  const trimmedSkill = trimSkill(skillUsed.content, skillNeed)
  const focus = needs.catalog
    ? focusCatalog(digest.rows, {
        text: input.text,
        history: rows,
        spec: String(spec || ''),
        chatNote,
        imageCount: input.imagePaths?.length || 0,
      })
    : null
  const skipped = [
    ...Object.entries(needs).filter(([, needed]) => !needed).map(([key]) => key),
    ...trimmedSkill.skipped.map((name) => `skill ${name}`),
  ]
  if (skipped.length || focus)
    onTrace?.({
      key: 'beta3-trim',
      label: `Hemat token${focus ? ` · katalog ${focus.rows.length} varian` : ''}${skipped.length ? ` · tanpa ${skipped.join(', ')}` : ''}`,
      status: 'completed',
      detail: { needs, skill: skillNeed, focus: focus ? { products: focus.products, colors: focus.colors } : null },
    })
  const productionText = settings.production ? renderProductionEstimate(settings.production, new Date(), String(store || '')) : ''
  const prompt = buildLeanPrompt({
    policy: renderExchangePolicy(policy.text),
    activeOrder,
    skill: trimmedSkill.text,
    store,
    fabrics: needs.fabrics
      ? await readLeanState('fabrics')
      : 'BAHAN TERSEDIA: tidak dimuat di giliran ini (tidak ada pertanyaan warna/bahan).',
    sizeCharts: needs.sizeCharts
      ? sizeCharts
      : sizeCharts
        ? 'SIZE CHART: tidak dimuat di giliran ini (tidak ada pertanyaan ukuran). Ditanya ukuran → jawab dari size ready di KATALOG.'
        : '',
    catalog: [
      priceText,
      needs.catalog
        ? focus
          ? `${renderCatalogDigest(focus.rows).replace(/^KATALOG \(/, 'KATALOG (produk yang sedang dibahas; ')}${focus.otherLine ? `\n${focus.otherLine}` : ''}`
          : digest.text
        : 'KATALOG: tidak dimuat di giliran ini (pesanan sudah berjalan, pelanggan tidak menanyakan produk). Ditanya produk/harga baru → "saya cek dulu ya bos".',
    ]
      .filter(Boolean)
      .join('\n\n'),
    // Koreksi pemilik selalu ikut (12 terbaru); contoh lain dipilih yang paling mirip.
    examples: pickExamples(examples.filter((example) => example.source !== 'koreksi'), input.text, stage),
    corrections: examples.filter((example) => example.source === 'koreksi').slice(-12),
    styleGuide: style ? styleGuide(style) : '',
    rules: renderRules(rules),
    customerNote,
    chatNote,
    spec,
    history: rows,
    context: collectContext({ history: rows, catalog: digest.rows, text: input.text }),
    message: `${replyContext(rows)}${acceptedOffer(rows)}${input.text}${toolNotes.length ? `\n\n${toolNotes.join('\n')}` : ''}${systemNote}${priceNote}${input.note ? `\n\nCATATAN SISTEM: ${input.note}` : ''}`,
    paymentMethods: settings.paymentMethods.filter((method) => method.enabled),
    production: productionText,
    imageCount: input.imagePaths?.length || 0,
  })
  onTrace?.({
    key: 'prompt-size',
    label: `Ukuran prompt ≈ ${prompt.size.tokens} token (skill ~${skillUsed.digest ? `${estimateTokens(skillUsed.content)} digest, asli ${skillTokens}` : skillTokens})`,
    status: 'completed',
    detail: { ...prompt.size, skillName: skill.name, skillDigest: skillUsed.digest, skillDigestFallback: skillUsed.fallback, catalogRows: digest.rows.length },
  })

  // Tingkat model: aturan pola kata (v3.5.7) sebagai dasar; Jev hanya menaikkan. Alasan tampil di trace.
  const tierChoice = chooseReplyTier(understanding, autoTier('beta3-reply', prompt, input.imagePaths?.length || 0))
  onTrace?.({
    key: 'beta3-tier',
    label: `Tingkat model: ${TIER_LABEL[tierChoice.tier]} · ${tierChoice.reason}`,
    status: 'completed',
    detail: { ...tierChoice, difficulty: understanding.difficulty ?? null },
  })
  onTrace?.({ key: 'beta3-ai', label: 'Menyusun balasan · tanpa tool', status: 'running' })
  const result = await runLeanProvider(settings, prompt, input.imagePaths || [], undefined, undefined, {
    jid,
    tier: tierChoice.tier,
  })
  let decision: LeanDecision
  try {
    decision = parseLeanDecision(result.text)
  } catch (error) {
    // Model menulis teks biasa: dipakai sebagai pesan, catatan/tahap/spesifikasi tetap yang lama.
    const bubbles = bubblesFromText(result.text)
    if (!bubbles) throw error
    decision = {
      pesan: bubbles,
      foto: [],
      catatan: chatNote,
      tahap: (stage || 'lain') as LeanDecision['tahap'],
      serah_cs: false,
      alasan: '',
      susulan: '',
      spesifikasi: String(spec || ''),
    }
    onTrace?.({ key: 'beta3-tidy-text', label: 'Jawaban teks biasa dirapikan sistem', status: 'completed', detail: { bubbles } })
  }
  // v3.6.78 Pemeriksa balasan (Jev): draf dinilai sebelum kirim — foto sesuai ucapan, maksud terjawab,
  // fakta sesuai katalog, tidak mengulang. Ada masalah yakin → AI menulis ulang SEKALI dengan catatannya.
  const check = await checkReply({
    jid,
    customerText: input.text,
    history: rows,
    decision,
    rows: digest.rows,
    extraFacts: [store, priceText, productionText, ...toolNotes].filter(Boolean),
    settings,
  }).catch(() => ({ issues: [] as CheckIssue[], jev: false }))
  if (check.issues.length) {
    onTrace?.({
      key: 'beta3-check',
      label: `Pemeriksa balasan · ${check.issues.map((issue) => CHECK_LABEL[issue.code]).join(' · ')}`,
      status: 'failed',
      detail: { masalah: check.issues, draf: { pesan: decision.pesan, foto: decision.foto } },
    })
    try {
      const revised = await runLeanProvider(
        settings,
        { system: prompt.system, user: `${prompt.user}\n\n${revisionNote(decision, check.issues)}` },
        input.imagePaths || [],
        'beta3-revise',
        undefined,
        { jid, tier: tierChoice.tier }
      )
      const fixed = parseLeanDecision(revised.text)
      decision = fixed
      result.usage = mergeUsage(result.usage, revised.usage)
      onTrace?.({ key: 'beta3-revise', label: 'Balasan ditulis ulang sesuai pemeriksa', status: 'completed', detail: { pesan: fixed.pesan, foto: fixed.foto } })
    } catch (error) {
      onTrace?.({ key: 'beta3-revise', label: 'Tulis ulang gagal · draf awal dipakai', status: 'failed', detail: { error: error instanceof Error ? error.message : String(error) } })
    }
  } else if (check.jev || (check as { ai?: boolean }).ai)
    onTrace?.({ key: 'beta3-check', label: 'Pemeriksa balasan · sesuai', status: 'completed', detail: {} })
  // Warna di spesifikasi & balasan = warna KATALOG yang ditunjukkan di chat (foto Choco tidak ditulis "Brown").
  const jevColor = await jevVariantFix(jid, decision.spesifikasi, digest.rows, rows).catch(() => null)
  const colorFix = jevColor || fixCatalogColors(decision.spesifikasi, digest.rows, rows)
  if (colorFix.swaps.length) {
    decision.spesifikasi = colorFix.text
    decision.pesan = swapColorWords(decision.pesan, colorFix.swaps)
    onTrace?.({
      key: 'beta3-color',
      label: `Warna disesuaikan katalog · ${colorFix.swaps.map(([from, to]) => `${from} → ${to}`).join(', ')}`,
      status: 'completed',
      detail: colorFix.swaps,
    })
  }
  decision.pesan = dropRepeatedQuestions(decision.pesan, rows)
  const cod = fixCodClaim(decision.pesan, input.text)
  if (cod.changed) {
    decision.pesan = cod.pesan
    onTrace?.({ key: 'beta3-cod', label: 'Klaim COD diganti · COD tidak tersedia', status: 'completed', detail: {} })
  }
  // v3.6.63 Hati CS: kalimat yang sama tidak diulang, ucapan momen sekali, pelanggan kesal/pamit tidak didesak.
  if (!decision.serah_cs) {
    const repeated = dropRepeatedSentences(decision.pesan, rows)
    if (repeated.removed.length) {
      decision.pesan = repeated.pesan
      onTrace?.({ key: 'beta3-hati-repeat', label: `Kalimat tidak diulang · ${repeated.removed.join(' / ').slice(0, 120)}`, status: 'completed', detail: { dibuang: repeated.removed } })
    }
    const greeting = dropRepeatedGreeting(decision.pesan, rows)
    if (greeting.changed) {
      decision.pesan = greeting.pesan
      onTrace?.({ key: 'beta3-hati-moment', label: 'Ucapan selamat tidak diulang', status: 'completed', detail: {} })
    }
  }
  const calm = calmForFeeling(decision.pesan, understanding.heart?.feeling)
  if (calm.stopSusulan) {
    if (calm.changed) decision.pesan = calm.pesan
    if (calm.changed || decision.susulan)
      onTrace?.({ key: 'beta3-hati-calm', label: `Tanpa desakan · pelanggan ${String(understanding.heart?.feeling).replace(/_/g, ' ')}`, status: 'completed', detail: { tawaranDibuang: calm.changed, susulan: decision.susulan } })
    decision.susulan = ''
  }
  if (notedInsteadOfAnswer(decision.pesan, understanding.heart?.form))
    onTrace?.({ key: 'beta3-hati-noted', label: 'Pertanyaan dijawab "dicatat" — cek', status: 'completed', detail: { pesan: decision.pesan } })
  if (style) {
    decision.pesan = normalizeStyle(decision.pesan, style, [policy.text])
  }
  // Ongkir selalu tampil rapi (satu layanan per baris), model apa pun yang menulis.
  decision.pesan = tidyShippingBubbles(decision.pesan, toolNotes, style?.address || 'bos')
  // Satu jalur perapian (sama dengan tes ulasan chat): daftar, gaya CS, harga sesuai seri, pembuka.
  const polished = polishText(decision.pesan, {
    customerText: input.text,
    address: style?.address || 'bos',
    verbatim: [policy.text],
    prices,
    series: priceSeries,
    productPrices: productPriceMap(digest.rows),
  })
  decision.pesan = polished.pesan
  const priceFix = { changes: polished.priceChanges }
  if (priceFix.changes.length) {
    onTrace?.({
      key: 'beta3-price-context',
      label: `Harga dibetulkan · ${priceFix.changes.map((c) => `${c.item} ${c.from.toLocaleString('id-ID')} → ${c.to.toLocaleString('id-ID')}`).join(', ')}`,
      status: 'completed',
      detail: { series: priceSeries, changes: priceFix.changes },
    })
  }
  if (decision.susulan) decision.susulan = tidyReply([decision.susulan], { address: style?.address || 'bos' })[0] || ''
  // "Mau custom bisa?" bukan alasan serah CS: jawab bisa + tanya custom apa.
  const custom = keepCustomInChat(decision, input.text)
  if (custom) {
    decision.serah_cs = false
    decision.pesan = custom.pesan
    if (decision.tahap === 'tunggu_cs') decision.tahap = 'tanya_size'
    decision.catatan = decision.catatan.replace(/tahap\s*[:=]\s*tunggu_cs/i, 'tahap: tanya_size')
    onTrace?.({
      key: 'beta3-custom',
      label: 'Custom dijawab sendiri (tidak diserahkan ke CS)',
      status: 'completed',
      detail: { alasan: decision.alasan },
    })
    decision.alasan = ''
  }
  // Pelanggan menunda / membatalkan (Jev): tidak ada susulan; batal → order yang belum dibayar ditutup.
  if (understanding.follow === 'tunda' || understanding.follow === 'batal') decision.susulan = ''
  if (
    understanding.follow === 'batal' &&
    cancelsOrder(input.text, rows) &&
    pendingForJev &&
    ['pending', 'awaiting_payment'].includes(String(pendingForJev.status)) &&
    !Number(pendingForJev.paid_amount || 0)
  ) {
    await cancelLeanOrder(Number(pendingForJev.id), 'Pelanggan membatalkan di chat (dibaca Jev)').catch(() => {})
    onTrace?.({ key: 'beta3-cancel', label: `Order ${pendingForJev.order_number || `#${pendingForJev.id}`} dibatalkan · pelanggan tidak jadi`, status: 'completed', detail: {} })
  }
  // "Sudah tf" tanpa foto (Jev): chat masuk filter Pembayaran supaya CS mengecek mutasi.
  if (understanding.paidClaim && pendingForJev?.status === 'awaiting_payment' && !input.imagePaths?.length && !decision.serah_cs) {
    decision.tahap = 'bukti_dikirim'
    const base = decision.catatan || chatNote
    decision.catatan = /tahap\s*[:=]/i.test(base)
      ? base.replace(/tahap\s*[:=]\s*\w+/i, 'tahap: bukti_dikirim')
      : `${base}\ntahap: bukti_dikirim`.trim()
    onTrace?.({ key: 'beta3-paid-claim', label: 'Pelanggan bilang sudah transfer (Jev) · menunggu dicek', status: 'completed', detail: {} })
  }
  // Pemeriksa sebelum kirim: harga yang tidak ada di katalog/ongkir/chat tidak dikirim.
  if (!decision.serah_cs && decision.pesan.length) {
    const allowed = allowedPrices(digest.rows, [
      ...toolNotes,
      systemNote,
      input.text,
      ...rows.map((row) => String(row.body || '')),
      spec || '',
      ...settings.paymentMethods.map((method) => method.destination),
      store,
      priceText,
    ], wholesaleDiscounts(storedWholesale))
    const unknown = unknownPrices(decision.pesan, allowed)
    if (unknown.length) {
      decision.serah_cs = true
      // v3.6.55: bubble tanpa harga tak dikenal tetap dikirim (pelanggan tidak didiamkan).
      decision.aman = decision.pesan.filter((bubble) => !unknownPrices([bubble], allowed).length)
      decision.alasan = `Pemeriksa harga: ${unknown.map((value) => value.toLocaleString('id-ID')).join(', ')} tidak ada di katalog/ongkir, balasan ditahan untuk CS. ${decision.alasan}`.slice(0, 500)
      onTrace?.({
        key: 'beta3-guard',
        label: `Balasan ditahan · harga ${unknown.map((value) => value.toLocaleString('id-ID')).join(', ')} tidak dikenal`,
        status: 'failed',
        detail: { unknown, pesan: decision.pesan },
      })
    }
  }
  // v3.6.83: pelanggan minta rekening (Jev) → rekening RESMI dari Pengaturan ditambahkan apa adanya
  // (uji chat nyata: AI menjawab "rekeningnya nanti" lalu menawarkan model lagi).
  if (understanding.asksAccount && !decision.serah_cs) {
    const methods = settings.paymentMethods.filter((method) => method.enabled)
    const payment = renderPaymentMessage(methods.map((method) => ({ bank: method.name, number: method.destination, holder: (method as { accountName?: string }).accountName || '' })))
    if (payment && !decision.pesan.some((bubble) => methods.some((method) => bubble.includes(method.destination)))) {
      decision.pesan = [...decision.pesan.filter((bubble) => !/rekening\w*\s+(?:nanti|menyusul|saya kirim)/i.test(bubble)), payment]
      onTrace?.({ key: 'beta3-account', label: 'Pelanggan minta rekening · rekening resmi ditambahkan', status: 'completed', detail: {} })
    }
  }
  // v3.6.79: tautan karangan (mis. link maps yang tidak ada di data toko) tidak dikirim.
  {
    const links = stripUnknownLinks(decision.pesan, [
      store,
      ...toolNotes,
      input.text,
      ...rows.map((row) => String(row.body || '')),
      ...settings.paymentMethods.map((method) => method.destination),
    ])
    if (links.removed.length) {
      decision.pesan = links.pesan
      onTrace?.({ key: 'beta3-link', label: `Tautan tidak dikenal dibuang · ${links.removed.join(', ').slice(0, 120)}`, status: 'completed', detail: { dibuang: links.removed } })
    }
  }
  if (style) {
    if (decision.susulan) decision.susulan = normalizeStyle([decision.susulan], style)[0] || ''
  }
  // Cadangan bila model tidak menandai referensi: gambar giliran ini yang disebut di
  // spesifikasi ("Model sesuai gambar") disimpan sebagai referensi model. Bukti transfer tidak.
  if (
    !decision.referensi?.length &&
    input.imageIds?.length &&
    /sesuai gambar|seperti gambar|kayak gambar|dari gambar/i.test(decision.spesifikasi) &&
    !/transfer|bukti|struk|resi|bayar/i.test(`${input.text} ${decision.tahap}`)
  )
    decision.referensi = input.imageIds.map((_, index) => ({
      gambar: index + 1,
      bagian: /ukuran\s+sesuai\s+gambar/i.test(decision.spesifikasi) && !/model\s+sesuai\s+gambar/i.test(decision.spesifikasi)
        ? 'ukuran'
        : 'model',
    }))
  // AI melihat gambarnya: catat mana bukti pembayaran dan mana gambar model/lain.
  // Tahap bukti_dikirim tanpa nomor → semua gambar giliran ini dianggap bukti.
  if (input.imageIds?.length) {
    const ids = input.imageIds
    // v3.6.30: hanya gambar yang AI tandai tegas sebagai bukti; tahap "bukti_dikirim" saja tidak
    // menjadikan semua gambar bukti (foto jas sesudah rekening pernah dianggap bukti).
    const proofNumbers = decision.bukti?.length ? decision.bukti : []
    const proofIds = proofNumbers.map((number) => ids[number - 1]).filter(Boolean)
    if (proofNumbers.length)
      decision.referensi = (decision.referensi || []).filter((ref) => !proofNumbers.includes(ref.gambar))
    await recordImageKinds(jid, ids, proofIds, decision.referensi || []).catch(() => {})
  }
  if (decision.referensi?.length && input.imageIds?.length) {
    const saved = await saveAiRefs(jid, decision.referensi, input.imageIds).catch(() => 0)
    if (saved)
      onTrace?.({ key: 'beta3-refs', label: `Referensi gambar dicatat · ${saved}`, status: 'completed', detail: decision.referensi })
  }
  if (decision.spesifikasi !== spec) {
    // Lembar spesifikasi menggantikan cart: ditulis ulang AI, disimpan kode.
    await writeOrderSpec(jid, decision.spesifikasi)
    if (decision.spesifikasi) await updatePendingOrderSpec(jid, decision.spesifikasi)
  }
  // Total otomatis: rincian AI diverifikasi kode ke katalog + tarif; dikirim listener setelah bubble.
  let autoTotal: VerifiedAutoTotal | null = null
  // Order pending yang tertinggal (mis. sebelum fitur ini) dicoba lagi saat pelanggan
  // menanyakan totalnya atau memilih layanan.
  let totalOrderId = orderId
  const specNow = decision.spesifikasi || spec
  if (!totalOrderId) {
    const pending = await latestLeanOrder(jid)
    if (pending && pending.status === 'pending') totalOrderId = Number(pending.id)
    // v3.6.50: order "menunggu bayar" tanpa total (rekap chat CS lama) = total belum pernah dikirim.
    else if (pending && pending.status === 'awaiting_payment' && !totalWasSent(pending) && (await reopenUntotaledOrder(Number(pending.id)))) {
      totalOrderId = Number(pending.id)
      onTrace?.({ key: 'beta3-total', label: 'Order dari rekap CS belum punya total · dihitung sekarang', status: 'completed', detail: {} })
    }
    // Total sudah terkirim, belum dibayar, lalu item berubah (tambah rompi/celana): buka lagi
    // dan hitung total baru di giliran ini — janji "saya cek ulang" ditepati sistem (v3.6.29).
    else if (
      pending &&
      pending.status === 'awaiting_payment' &&
      !Number(pending.paid_amount || 0) &&
      // Bandingkan dengan spesifikasi awal giliran (spec): spesifikasi order sudah ditimpa di atas.
      orderPartsOf(String(spec || '')).join() !== orderPartsOf(String(specNow || '')).join() &&
      (await reopenLeanOrderForChange(Number(pending.id)))
    ) {
      totalOrderId = Number(pending.id)
      onTrace?.({ key: 'beta3-total', label: 'Item berubah setelah total · dihitung ulang', status: 'completed', detail: { before: spec, after: specNow } })
    }
  }
  // v3.6.51: CS sudah mengirim total di chat (mis. dari HP) → catat, jangan hitung/janjikan lagi.
  if (totalOrderId && !orderId) {
    const adopted = await adoptCsTotal(totalOrderId).catch(() => null)
    if (adopted) {
      onTrace?.({ key: 'beta3-total', label: `Total sudah dikirim CS di chat · ${adopted.total}`, status: 'completed', detail: adopted })
      totalOrderId = null
    }
  }
  if (totalOrderId) {
    // Berat sesuai spesifikasi terbaru (giliran ini): tarif ongkir diambil ulang bila berubah.
    const gramsNow = await orderWeightGrams(String(specNow || '')).catch(() => orderGrams)
    const current = await readLeanOrder(totalOrderId)
    const storedRates = current?.shipping_options
      ? (parseJson<ShippingRates & { grams?: number }>(String(current.shipping_options)) as (ShippingRates & { grams?: number }) | null)
      : null
    // Tarif lama menyimpan berat sebagai weight_grams (dari MCP); yang baru juga grams.
    const storedGrams = Number(storedRates?.grams ?? (storedRates as any)?.weight_grams ?? 0)
    // v3.6.50: order tanpa tarif (dibuat dari rekap chat CS / alamat dikirim saat CS menangani):
    // ongkir dicek sekarang dari alamat di order, supaya total bisa dihitung.
    if (current && mcp.url && !storedRates?.prices?.length && (current.district || current.regency || current.address)) {
      try {
        const lastResolved = parseJson<LastShipping>(await readLeanState(lastKey))?.resolved
        const fresh = await ratesForAddress(
          { district: String(current.district || ''), regency: String(current.regency || ''), postalCode: String(current.postal_code || '') },
          lastResolved || null,
          mcp,
          gramsNow,
          String(current.address || '')
        )
        if (fresh?.prices?.length) {
          await updatePendingOrderRates(totalOrderId, { ...fresh, grams: gramsNow })
          onTrace?.({ key: 'beta3-rates', label: `Ongkir dicek dari alamat order · ${gramsNow} g`, status: 'completed', detail: fresh })
        }
      } catch (error) {
        onTrace?.({ key: 'beta3-rates', label: 'Ongkir dari alamat order gagal', status: 'completed', detail: { error: error instanceof Error ? error.message : String(error) } })
      }
    } else if (current && mcp.url && storedRates?.prices?.length && storedGrams !== gramsNow) {
      try {
        const lastResolved = parseJson<LastShipping>(await readLeanState(lastKey))?.resolved
        const fresh = await ratesForAddress(
          { district: String(current.district || ''), regency: String(current.regency || ''), postalCode: String(current.postal_code || '') },
          lastResolved || null,
          mcp,
          gramsNow,
          String(current.address || '')
        )
        if (fresh?.prices?.length) {
          await updatePendingOrderRates(totalOrderId, { ...fresh, grams: gramsNow })
          onTrace?.({ key: 'beta3-rates', label: `Ongkir dihitung ulang · ${gramsNow} g`, status: 'completed', detail: fresh })
        }
      } catch (error) {
        onTrace?.({ key: 'beta3-rates', label: 'Ongkir ulang gagal', status: 'completed', detail: { error: error instanceof Error ? error.message : String(error) } })
      }
    }
    // Cadangan bila AI tidak mengisi field order: rincian dari lembar spesifikasi,
    // subtotal dihitung kode dari katalog (0 = jangan bandingkan), layanan dicari
    // di catatan/spesifikasi/pesan ("ongkir: CTCYES", "pakai YES").
    const draft =
      decision.order && decision.order.rincian
        ? decision.order
        : { rincian: specNow, subtotal: 0, layanan: '' }
    // Harga yang sudah disebut toko di chat (CS/AI), untuk pre-order atau produk di luar katalog.
    // v3.6.43: dibaca dari seluruh percakapan 30 hari terakhir (dulu hanya riwayat 20 pesan, sehingga
    // "harganya 535.000" yang disebut lebih awal tidak terbaca dan total pre-order tertahan).
    const storeBodies = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .whereNotNull('body')
      .whereNotIn('status', ['failed', 'queued'])
      .where('created_at', '>=', new Date(Date.now() - 30 * 86_400_000))
      .orderBy('id', 'desc')
      .limit(400)
      .select('body')
      .catch(() => [] as Array<{ body: string }>)
    const statedPrices = [
      ...rows.filter((row) => row.direction === 'out' && row.body).map((row) => String(row.body)),
      ...(storeBodies as Array<{ body: string }>).map((row) => String(row.body || '')),
    ].flatMap((body) => parsePrices(body))
    // Pilihan layanan hanya dari pesan PELANGGAN (bukan catatan AI yang memuat daftar ongkir).
    const lastOngkir = rows.map((row, index) => (row.direction === 'out' && /ongkir/i.test(String(row.body || '')) ? index : -1)).reduce((a, b) => Math.max(a, b), -1)
    const customerText = [
      ...rows.slice(lastOngkir + 1).filter((row) => row.direction === 'in').map((row) => String(row.body || '')),
      input.text,
    ]
    const verdict = await verifyAutoTotal(
      totalOrderId,
      draft,
      digest.rows,
      customerText,
      statedPrices,
      String(specNow || ''),
      understanding.service,
      // v3.6.60: mulai 6 jas → potongan grosir dihitung di total otomatis (dulu ditahan untuk invoice).
      wholesaleDiscounts(String((await readLeanState('wholesale').catch(() => '')) || ''))
    )
    const bulk = verdict.ok ? verdict.total.items.match(/^Diskon grosir .+$/m)?.[0] : undefined
    if (verdict.ok && !bulk && wholesaleOrder(decision.catatan || chatNote || '')) {
      // Dicatat grosir tapi jumlah jas < 6 / jumlah pcs tidak terbaca di rincian: jangan kirim total
      // yang mungkin salah hitung — toko yang mengecek (seperti v3.6.56).
      decision.serah_cs = true
      decision.alasan = `Pesanan grosir: jumlah jas belum 6 atau jumlah pcs tidak terbaca, total dicek toko. ${decision.alasan}`.slice(0, 500)
      onTrace?.({ key: 'beta3-total', label: 'Pesanan grosir · jumlah jas belum 6 / tidak terbaca · total dicek toko', status: 'completed', detail: {} })
    } else if (verdict.ok) {
      autoTotal = verdict.total
      if (bulk) onTrace?.({ key: 'beta3-wholesale', label: `Total grosir · ${bulk}`, status: 'completed', detail: {} })
    }
    await noteAutoTotalReason(totalOrderId, verdict.ok ? '' : verdict.reason)
    // Ongkir lebih dari satu dan pelanggan belum memilih: tanyakan, jangan dipilihkan.
    if (!verdict.ok && verdict.reason === 'layanan belum dipilih' && !decision.serah_cs) {
      const block = toolNotes
        .map((note) => note.match(/<<<ONGKIR\n([\s\S]+?)\nONGKIR>>>/)?.[1])
        .filter(Boolean)
        .pop()
      // Tanya layanan wajib menyertakan tarifnya (blok ONGKIR), bukan hanya "REG atau YES?".
      const shown = Boolean(block) && decision.pesan.some((bubble) => /\d{1,3}(?:\.\d{3})+/.test(bubble) && /(reg|yes|jtr|ongkir)/i.test(bubble))
      const serviceQuestion = /[^.!?\n]*\b(reg|yes|jtr|layanan|pengiriman|ekspedisi|kurir|ongkir)\b[^.!?\n]*\?/gi
      if (block && !shown)
        decision.pesan = decision.pesan.map((bubble) => bubble.replace(serviceQuestion, '').replace(/\s{2,}/g, ' ').trim())
      const asks = shown && decision.pesan.some((bubble) => /\?/.test(bubble) && /(mana|pilih|layanan|reg|yes)/i.test(bubble))
      decision.pesan = decision.pesan
        .map((bubble) => bubble.replace(/,?\s*(ini|berikut)\s+totalnya.*$/i, '').trim())
        .filter((bubble) => bubble && !/\b(ini|berikut)\b[^.?!]*\btotal/i.test(bubble))
      if (!asks) {
        const address = style?.address || 'bos'
        decision.pesan.push(block ? `${block}\n\nMau pakai yang mana ${address}?` : `Pengirimannya mau pakai yang mana ${address}?`)
      }
      if (!decision.pesan.length) decision.pesan.push(`Siap ${style?.address || 'bos'}, datanya sudah masuk ya`)
    }
    // Bagian yang disebut (celana/rompi) belum ada di rincian: jangan kirim total jas saja —
    // konfirmasi dulu, total menyusul setelah jelas (v3.6.29).
    if (!verdict.ok && verdict.reason.startsWith('item belum lengkap') && !decision.serah_cs) {
      const parts = verdict.reason.replace('item belum lengkap: ', '').split(', ')
      decision.pesan = decision.pesan
        .map((bubble) => bubble.replace(/,?\s*(ini|berikut)\s+totalnya.*$/i, '').trim())
        .filter((bubble) => bubble && !/\b(ini|berikut)\b[^.?!]*\btotal/i.test(bubble))
      // v3.6.41: bagian yang sudah dipilih pelanggan (ada di spesifikasi) tidak ditanyakan lagi —
      // total ditahan untuk dihitung (rincian/harga belum cocok katalog), bukan "mau jas saja?".
      const open = parts.filter((part) => !new RegExp(`\\b${part}`, 'i').test(String(spec || '')))
      const asked = decision.pesan.some((bubble) => /\?/.test(bubble) && open.some((part) => new RegExp(part, 'i').test(bubble)))
      if (open.length && !asked)
        decision.pesan.push(
          `mau jas saja atau sekalian ${open.length > 1 ? 'celana dan rompinya' : `${open[0]}nya`} ${style?.address || 'bos'}? biar totalnya pas`
        )
      if (!open.length && !decision.pesan.length)
        decision.pesan.push(`siap ${style?.address || 'bos'}, datanya sudah masuk ya, totalnya saya hitung dulu`)
    }
    // Setelan tanpa nomor celana: tanya dulu (kalimat CS), total menyusul setelah dijawab.
    if (!verdict.ok && verdict.reason === 'nomor celana belum diketahui' && !decision.serah_cs) {
      decision.pesan = decision.pesan
        .map((bubble) => bubble.replace(/,?\s*(ini|berikut)\s+totalnya.*$/i, '').trim())
        .filter((bubble) => bubble && !/\b(ini|berikut)\b[^.?!]*\btotal/i.test(bubble))
      if (!decision.pesan.some((bubble) => /celana/i.test(bubble) && /\?/.test(bubble)))
        decision.pesan.push(`celana menyesuaikan kah atau pakai No. berapa ya ${style?.address || 'bos'}?`)
    }
    // Total belum bisa dikirim: jangan menjanjikan "ini totalnya" yang tidak pernah datang.
    if (!verdict.ok && !decision.serah_cs) {
      const promise = /\b(ini|berikut|kami kirim|menyusul)\b[^.?!]*\btotal/i
      decision.pesan = decision.pesan.map((bubble) =>
        promise.test(bubble)
          ? `${bubble.replace(/,?\s*(ini|berikut)\s+totalnya.*$/i, '').replace(/\s*bos$/i, '').trim()}, totalnya saya hitung dulu ya bos`
          : bubble
      )
    }
    onTrace?.({
      key: 'beta3-total',
      label: verdict.ok
        ? `Total diverifikasi · ${verdict.total.subtotal + verdict.total.shippingCost}`
        : `Total menunggu CS · ${verdict.reason}`,
      status: 'completed',
      detail: { draft, fromAi: Boolean(decision.order), verdict },
    })
  } else if (
    !decision.serah_cs &&
    // v3.6.50: "menunggu bayar" baru dianggap sudah ada total bila totalnya memang tercatat.
    !(await latestLeanOrder(jid).then((latest) => latest?.status === 'awaiting_payment' && totalWasSent(latest)))
  ) {
    // Belum ada form/order: total + rekening tidak akan terkirim otomatis. Jangan janji
    // "ini totalnya saya kirimkan"; minta data pengiriman, atau tunggu CS bila alamat sudah ada.
    const jevPromise = /total|rekening/i.test(decision.pesan.join(' '))
      ? await promisesTotal(jid, decision.pesan).catch(() => undefined)
      : undefined
    const guarded = guardTotalPromise(decision.pesan, {
      jev: jevPromise,
      address: style?.address || 'bos',
      hasAddress: rows.some(
        (row) => row.direction === 'in' && /\b(alamat|kecamatan|kec\.|kabupaten|kab\.|kode ?pos)\b/i.test(String(row.body || ''))
      ),
      asked: rows.filter((row) => row.direction === 'out' && !row.current).slice(-3).some((row) => /data pengiriman|alamat lengkap/i.test(String(row.body || ''))),
    })
    if (guarded.changed) {
      // v3.6.82: kalimat yang dipotong pola sering patah ("rekeningnya nanti .", "DP-nya sekitar setengah
      // dari") — AI menulis ulang dulu dengan bahasa wajar; hasilnya dicek pola yang sama, gagal → potongan lama.
      const hasAddress = rows.some((row) => row.direction === 'in' && /\b(alamat|kecamatan|kec\.|kabupaten|kab\.|kode ?pos)\b/i.test(String(row.body || '')))
      const asked = rows.filter((row) => row.direction === 'out' && !row.current).slice(-3).some((row) => /data pengiriman|alamat lengkap/i.test(String(row.body || '')))
      const rewritten = await runLeanProvider(
        settings,
        {
          system: prompt.system,
          user: `${prompt.user}\n\nDRAF BALASANMU: ${JSON.stringify(decision.pesan)}\nMasalah: draf menjanjikan total/rekening, padahal total + rekening hanya dikirim SISTEM setelah ${hasAddress ? 'order dicek' : 'data pengiriman (nama, alamat lengkap + kecamatan, kota, no HP) masuk'}. Tulis ulang keputusan LENGKAP (JSON sama): jawab pertanyaan pelanggan dengan wajar seperti CS manusia, jangan tulis nomor rekening, jangan janji "saya kirim totalnya"; ${hasAddress ? 'bilang totalnya dicek dulu' : asked ? 'data pengiriman sudah diminta sebelumnya — jangan ulang format panjangnya, cukup ingatkan singkat bila perlu' : 'minta data pengirimannya secara singkat'}.`,
        },
        [],
        'beta3-total-rewrite',
        undefined,
        { jid, tier: tierChoice.tier }
      )
        .then((made) => parseLeanDecision(made.text).pesan)
        .catch(() => null)
      const clean =
        rewritten?.length &&
        !guardTotalPromise(rewritten, { address: style?.address || 'bos', hasAddress }).changed &&
        !rewritten.some((bubble) => /\d{9,}/.test(bubble.replace(/[\s.-]/g, '')))
      decision.pesan = clean ? rewritten! : guarded.pesan
      if (guarded.waitCs) decision.tahap = 'tunggu_cs'
      onTrace?.({
        key: 'beta3-total',
        label: guarded.waitCs ? 'Janji total tanpa order · menunggu CS' : 'Janji total tanpa form order · minta data pengiriman',
        status: 'completed',
        detail: {},
      })
    }
  }
  // Janji "saya hitung/cek dulu" tidak diulang saat pelanggan cuma mengiyakan (v3.6.29).
  if (!decision.serah_cs && !autoTotal) {
    const lastOutgoing = [...rows].reverse().find((row) => row.direction === 'out' && !row.current)
    const repeated = dropRepeatedWait(decision.pesan, String(lastOutgoing?.body || ''), input.text)
    if (repeated.changed) {
      decision.pesan = repeated.pesan
      onTrace?.({ key: 'beta3-total', label: repeated.pesan.length ? 'Janji tunggu tidak diulang' : 'Diam · janji tunggu sudah dikirim', status: 'completed', detail: {} })
    }
  }
  // v3.6.43: susulan tidak menyebut total/DP/rekening sebelum total benar-benar dikirim.
  if (decision.susulan && !autoTotal && susulanNeedsTotal(decision.susulan)) {
    const latest = await latestLeanOrder(jid).catch(() => null)
    if (!totalWasSent(latest)) {
      onTrace?.({ key: 'beta3-nudge-plan', label: 'Susulan dibatalkan · menyebut total yang belum dikirim', status: 'completed', detail: { susulan: decision.susulan } })
      decision.susulan = ''
    }
  }
  // Total/pembayaran yang dikerjakan CS langsung di chat ikut tercatat di order.
  // Dana masuk = soal uang: AI dan Jev harus sama-sama yakin toko sudah menyatakannya.
  if (decision.pembayaran?.dikonfirmasi) {
    const storeSays = await storeConfirmedPayment(
      jid,
      rows.filter((row) => row.direction === 'out').map((row) => String(row.body || ''))
    ).catch(() => undefined)
    if (storeSays === false) {
      decision.pembayaran.dikonfirmasi = false
      onTrace?.({ key: 'beta3-paid-check', label: 'Dana masuk belum dinyatakan toko (Jev) · tidak ditandai lunas', status: 'completed', detail: {} })
    }
  }
  if (!autoTotal && decision.pembayaran && !input.simulate) {
    const synced = await syncOrderFromChat(jid, decision.pembayaran).catch(() => null)
    if (synced)
      onTrace?.({ key: 'beta3-order-sync', label: `Order diperbarui dari chat · ${synced}`, status: 'completed', detail: decision.pembayaran })
  }
  onTrace?.({
    key: 'beta3-ai',
    label: 'Balasan tersusun',
    status: 'completed',
    detail: {
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      durationMs: result.durationMs,
      decision,
    },
  })
  // "Ini fotonya" / pelanggan minta lihat: semua model yang disebut di balasan harus ada fotonya.
  const missing = completePhotos(decision.pesan, decision.foto, input.text, digest.rows)
  if (missing.length) {
    decision.foto = [...decision.foto, ...missing]
    onTrace?.({ key: 'beta3-photo-complete', label: `Foto dilengkapi · ${missing.join(', ')}`, status: 'completed', detail: { ditambah: missing } })
  }
  // v3.6.79: warna yang disebut ikut difoto; ≥3 foto satu produk → semua warnanya yang punya foto.
  const aligned = alignPhotos(decision.pesan, decision.foto, digest.rows)
  if (aligned.added.length) {
    decision.foto = aligned.foto
    onTrace?.({ key: 'beta3-photo-align', label: `Foto diselaraskan dengan teks · ${aligned.added.join(', ')}`, status: 'completed', detail: { ditambah: aligned.added } })
  }
  let photos = resolvePhotos(digest.rows, decision.foto)
  // v3.6.58: foto yang baru saja dikirim tidak diulang (kecuali pelanggan minta kirim ulang).
  const fresh = skipSentPhotos(photos, rows, input.text)
  if (fresh.repeated.length) {
    photos = fresh.photos
    if (!photos.length) decision.pesan = pointToSentPhotos(decision.pesan)
    onTrace?.({ key: 'beta3-photo-repeat', label: `Foto tidak diulang · ${fresh.repeated.join(', ')}`, status: 'completed', detail: { dilewati: fresh.repeated } })
  }
  // Urutan seperti CS: jawaban → foto → pertanyaan (pertanyaan di ujung bubble dipisah).
  if (!decision.serah_cs) decision.pesan = polishWithPhotos(decision.pesan, photos, input.text, style?.address || 'bos')
  // v3.6.86 — nomor celana tidak ditebak dari TB/BB.
  if (!decision.serah_cs) {
    const known = [input.text, ...rows.filter((row) => row.direction === 'in' || row.senderType === 'cs' || row.senderType === 'owner').map((row) => String(row.body || '')), ...toolNotes].join('\n')
    const pants = dropGuessedPantsNumber(decision.pesan, known, style?.address || 'bos')
    if (pants.changed) {
      decision.pesan = pants.pesan
      onTrace?.({ key: 'beta3-pants-guess', label: 'Nomor celana tebakan dibuang → ditanyakan', status: 'completed', detail: {} })
    }
  }
  // v3.6.85 — AI tidak melihat semua pesanan lama: jangan pernah bilang pesanan "belum tercatat / tidak ada"
  // (uji chat nyata: pesanan pelanggan sedang finishing, AI bilang belum tercatat). Cek oleh CS.
  if (!decision.serah_cs && deniesOrder(decision.pesan)) {
    decision.pesan = [`Saya cek dulu pesanannya ya ${style?.address || 'bos'}`]
    decision.serah_cs = true
    decision.alasan = 'Menanyakan pesanan yang tidak ada di data AI'
    photos = []
    onTrace?.({ key: 'beta3-order-unknown', label: 'Pesanan tidak ada di data AI → dicek CS (tidak bilang "belum tercatat")', status: 'completed', detail: {} })
  }
  // v3.6.55: diserahkan ke CS tetap dibalas singkat — dulu pesan dibuang dan pelanggan didiamkan.
  if (ensureHandoffReply(decision)) {
    onTrace?.({ key: 'beta3-handoff-reply', label: 'Serah CS · balasan singkat dari sistem (AI tidak menulis balasan)', status: 'completed', detail: {} })
  }
  return {
    decision,
    autoTotal,
    photos,
    promptTokens: prompt.size.tokens,
    promptSections: prompt.size.sections,
    usage: result.usage,
    durationMs: result.durationMs,
    orderId,
    skillName: skill.name,
  }
}

// v3.6.77: juga "beli/ambil/pesen banyak", "banyak … kurang/murah/nego" (salah ketik "kurng"), dan
// pesanan satu set per size ("set S sampai 3xl", "S-3XL"). Kasus 8 Okt: "Kalo beli banyak bisa kurng ga"
// tidak dikenali → aturan DISKON GROSIR tidak ikut → AI menyerahkan ke CS dan pelanggan menunggu.
const WHOLESALE_TOPIC = new RegExp(
  [
    '\\b(diskon|grosir|grosiran|borong|borongan|seragam|lusin|kodi|partai|potongan|rombongan)\\b',
    '\\b(?:beli|pesan|pesen|pesanan|ambil|order|bikin|buat)\\s+(?:\\w+\\s+)?banyak\\b',
    '\\bbanyak\\b.{0,30}\\b(?:kura?ng(?:in|i)?|murah(?:in)?|nego|harga khusus)\\b',
    '\\b(?:kura?ng(?:in|i)?|murah(?:in)?|nego)\\b.{0,30}\\bbanyak\\b',
    '\\b(?:[6-9]|\\d{2,})\\s*(?:pcs|stel|setel|set|potong|buah|orang|jas|setelan)\\b',
    '\\b(?:set|stel|setel|jas)\\s+(?:size\\s+)?s\\s*(?:-|–|sampai|sampe|s/?d|hingga|ke)\\s*(?:[2-5]?x+l|[2-5]xl)\\b',
  ].join('|'),
  'i'
)
/** Link selain situs toko sendiri. */
export function foreignLink(text: string) {
  return (String(text || '').match(/https?:\/\/[^\s]+/gi) || []).some((url) => !/chameleoncloth\.com|naufalhunaif\.com/i.test(url))
}
const NO_ORDER =
  /\b(?:belum|tidak|gak|ga|nggak)\s+(?:ada\s+yang\s+)?(?:tercatat|ditemukan|terdata)\b|\b(?:tidak|belum|gak|ga|nggak)\s+ada\s+(?:pesanan|orderan|order)\b/i
/** v3.6.85 — balasan menyangkal pesanan pelanggan ("belum tercatat", "tidak ada pesanan"). */
export function deniesOrder(pesan: string[]) {
  return pesan.some((bubble) => NO_ORDER.test(String(bubble || '')))
}
/** v3.6.56 — percakapan menyinggung pesanan banyak / diskon grosir. */
export function talksWholesale(text: string) {
  return WHOLESALE_TOPIC.test(text)
}

/** Catatan chat menandai pesanan grosir ("grosir: ya"). */
export function wholesaleOrder(note: string) {
  return /\bgrosir\s*[:=]\s*ya\b/i.test(note)
}

/** Balasan cadangan saat diserahkan ke CS dan AI tidak menulis apa pun. */
export const HANDOFF_REPLY = 'Siap bos, untuk itu saya tanyakan dulu ke tim ya, ditunggu sebentar'

/**
 * v3.6.55 — bubble yang benar-benar dikirim ke pelanggan (satu aturan untuk WhatsApp & Instagram).
 * Diserahkan ke CS: balasan singkat AI tetap dikirim; bila ditahan pemeriksa harga, hanya bubble
 * tanpa harga tak dikenal.
 */
export function bubblesToSend(decision: Pick<LeanDecision, 'serah_cs' | 'pesan' | 'aman'>) {
  if (!decision.serah_cs) return decision.pesan
  return decision.aman ?? decision.pesan
}

/** Diserahkan ke CS tapi tidak ada yang bisa dikirim → balasan singkat cadangan. true bila diisi. */
export function ensureHandoffReply(decision: Pick<LeanDecision, 'serah_cs' | 'pesan' | 'aman'>) {
  if (!decision.serah_cs || bubblesToSend(decision).length) return false
  if (decision.aman) decision.aman = [HANDOFF_REPLY]
  else decision.pesan = [HANDOFF_REPLY]
  return true
}

export const LEAN_NUDGE_DELAY_MS = 20 * 60_000
export const LEAN_NUDGE_MAX_PER_CHAT = 2

/**
 * Waktu susulan mengikuti tahap: pilih model/size 20 menit, data pengiriman 45 menit,
 * menunggu transfer 3 jam. Tidak dikirim 21.00–08.00 WIB (digeser ke 09.00).
 */
export function nudgeTime(stage: string, now = Date.now()) {
  const delay = stage === 'tunggu_bayar'
    ? 3 * 60 * 60_000
    : ['minta_alamat', 'kirim_form', 'tunggu_form'].includes(stage)
      ? 45 * 60_000
      : LEAN_NUDGE_DELAY_MS
  const due = new Date(now + delay)
  const wibHour = (due.getUTCHours() + 7) % 24
  if (wibHour >= 21 || wibHour < 8) {
    // Geser ke 09.00 WIB (02.00 UTC) berikutnya.
    const next = new Date(due)
    next.setUTCHours(2, 0, 0, 0)
    if (next.getTime() <= due.getTime()) next.setUTCDate(next.getUTCDate() + 1)
    return next
  }
  return due
}

/**
 * Tutup goal giliran ini: status ikut tahap. Kalau AI menyiapkan `susulan`,
 * dijadwalkan sekali (tanpa panggilan AI) dan hanya terkirim bila pelanggan
 * diam; pesan baru apa pun membatalkannya.
 */
/**
 * Status chat sesudah balasan. Menunggu = ada langkah yang ditunggu dari pelanggan; juga bila AI
 * menulis susulan (mis. tahap "lain" saat pelanggan tanya-tanya model/harga), supaya susulan tetap
 * terkirim. Selesai/serah CS tidak pernah disusul.
 */
/** Susulan yang terakhir direncanakan untuk chat ini (policy_json), atau kosong. */
async function previousNudge(jid: string) {
  const goal = await db.from('whatsapp_chat_goals').where('jid', jid).first().catch(() => null)
  try {
    const policy = JSON.parse(String(goal?.policy_json || 'null')) as { nudge?: string } | null
    return String(policy?.nudge || '').slice(0, 300)
  } catch {
    return ''
  }
}

export function goalStatus(decision: Pick<LeanDecision, 'serah_cs' | 'tahap' | 'susulan'>) {
  if (decision.serah_cs) return 'paused' as const
  if (decision.tahap === 'selesai') return 'completed' as const
  const waitingStage =
    decision.tahap.startsWith('tunggu') ||
    decision.tahap.startsWith('tanya') ||
    decision.tahap === 'minta_alamat' ||
    decision.tahap === 'tawar_celana' ||
    decision.tahap === 'kirim_form'
  return waitingStage || Boolean(decision.susulan) ? ('waiting' as const) : ('completed' as const)
}

export async function finishLeanGoal(
  run: { jid: string; version: string; anchor_id: number },
  decision: LeanDecision
) {
  const previous = await db.from('whatsapp_chat_goals').where('jid', run.jid).first()
  // Hitungan susulan mulai dari nol lagi setiap pelanggan membalas.
  const lastIn = await db
    .from('whatsapp_messages')
    .where('jid', run.jid)
    .where('direction', 'in')
    .orderBy('id', 'desc')
    .first()
  const lastNudge = previous?.last_followup_at ? new Date(previous.last_followup_at).getTime() : 0
  const nudges =
    lastIn && new Date(lastIn.created_at).getTime() > lastNudge ? 0 : Number(previous?.followup_count || 0)
  const status = goalStatus(decision)
  const nudge =
    status === 'waiting' && decision.susulan && nudges < LEAN_NUDGE_MAX_PER_CHAT
      ? decision.susulan
      : ''
  // Tidak dibalas ("oke" tanda terima): pesan terakhir di room milik pelanggan; susulan tetap boleh.
  const quietAfter = decision.pesan.length ? undefined : run.anchor_id
  const values = {
    analyzed_anchor_id: run.anchor_id,
    status,
    objective: decision.tahap,
    waiting_for: status === 'waiting' ? decision.tahap : '',
    next_action: nudge,
    policy_json: nudge
      ? JSON.stringify({ lean: true, nudge, stage: decision.tahap, ...(quietAfter ? { quietAfter } : {}) })
      : null,
    skill_hash: null,
    ...(nudges === 0 && Number(previous?.followup_count || 0) ? { followup_count: 0 } : {}),
    next_run_at: nudge ? nudgeTime(decision.tahap) : null,
    last_error: null,
    updated_at: new Date(),
  }
  const changed = await db
    .from('whatsapp_chat_goals')
    .where('jid', run.jid)
    .where('version', run.version)
    .update(values)
  return Number(changed)
    ? {
        ...values,
        next_run_at: values.next_run_at?.toISOString() || null,
        updated_at: values.updated_at.toISOString(),
      }
    : null
}

/**
 * Ambil susulan yang jatuh tempo. Hanya bila: goal masih menunggu, tidak ada
 * pesan baru sejak balasan AI (pesan terakhir di room adalah AI), dan room
 * tidak dipegang CS. Mengembalikan teks susulan atau null.
 */
/**
 * v3.6.82 — Susulan dinilai saat jatuh tempo (bukan saat balasan dibuat, supaya balasan tidak
 * melambat): masih perlu? bahasanya seperti CS manusia? Tidak perlu → tidak dikirim; kaku → ditulis ulang.
 */
export async function vetLeanNudge(jid: string, text: string, settings: LeanSettings) {
  const rows = await history(jid, new Set()).catch(() => [] as LeanHistoryRow[])
  const style = styleForChat(await storeStyle(await listLeanExamples()).catch(() => null), rows)
  return reviewNudge({ jid, settings, susulan: text, history: rows, address: style?.address || 'bos' })
}

export async function claimLeanNudge(jid: string, now = new Date()) {
  const goal = await db.from('whatsapp_chat_goals').where('jid', jid).first()
  if (!goal || goal.status !== 'waiting' || !goal.next_run_at || new Date(goal.next_run_at) > now)
    return null
  let policy: { lean?: boolean; nudge?: string; quietAfter?: number } | null = null
  try {
    policy = JSON.parse(String(goal.policy_json || 'null'))
  } catch {}
  const clear = () =>
    db
      .from('whatsapp_chat_goals')
      .where('jid', jid)
      .where('version', goal.version)
      .update({ next_run_at: null, policy_json: null, next_action: '', updated_at: now })
  if (!policy?.lean || !policy.nudge) {
    await clear()
    return null
  }
  const last = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .whereNotIn('status', ['queued', 'failed'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first()
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  // Pesan terakhir harus balasan AI, atau pesan pelanggan yang sengaja tidak dibalas ("oke").
  const quiet = Boolean(policy.quietAfter) && last?.direction === 'in' && Number(last.id) === Number(policy.quietAfter)
  if (
    !last ||
    (!quiet && (last.direction !== 'out' || last.sender_type !== 'ai')) ||
    contact?.handling_mode === 'cs' ||
    contact?.ai_excluded
  ) {
    await clear()
    return null
  }
  const changed = await db
    .from('whatsapp_chat_goals')
    .where('jid', jid)
    .where('version', goal.version)
    .where('status', 'waiting')
    .update({
      next_run_at: null,
      policy_json: null,
      next_action: '',
      followup_count: Number(goal.followup_count || 0) + 1,
      last_followup_at: now,
      updated_at: now,
    })
  return Number(changed) ? { text: String(policy.nudge), anchorId: Number(goal.anchor_id) } : null
}

type LastShipping = {
  place: string
  pending: boolean
  at: number
  choices?: DestinationArea[]
  resolved?: DestinationArea | null
}

function parseJson<T>(raw: string): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function findDestinations(q: string, mcp: LeanMcpConfig): Promise<DestinationRow[]> {
  return searchDestinations(q, async (query) => {
    const found = await callLeanTool<{ destinations?: DestinationRow[] }>('check_destination', { q: query }, mcp)
    return found?.destinations || []
  })
}

/**
 * v3.6.79 — Cari tujuan bertahap: kalimat utuh dulu; kosong → kata depan saja (kecamatan) lalu disaring
 * dengan kata sisanya (kota). Uji: "tambun selatan bekasi" tidak ditemukan padahal "tambun selatan" ada
 * (Kab. Bekasi) → AI lalu mengarang ongkir.
 */
export async function searchDestinations<T extends { city?: string; province?: string; district?: string; subdistrict?: string }>(
  q: string,
  search: (query: string) => Promise<T[]>
): Promise<T[]> {
  const first = await search(q)
  if (first.length) return first
  const words = q.trim().split(/\s+/)
  for (let cut = words.length - 1; cut >= 1; cut--) {
    const head = words.slice(0, cut).join(' ')
    if (head.length < 3) break
    const found = await search(head)
    if (!found.length) continue
    const tail = words.slice(cut).join(' ').toLowerCase()
    const narrowed = found.filter((row) =>
      [row.city, row.province, row.district, row.subdistrict].join(' ').toLowerCase().includes(tail)
    )
    return narrowed.length ? narrowed : found
  }
  return []
}

/**
 * Tarif untuk alamat form: kode tujuan dari obrolan (bila kecamatannya sama) →
 * nama kecamatan + kota → nama kecamatan saja. Null bila semuanya gagal.
 */
/** Lengkapi nama kecamatan & kota hasil tarif dari tujuan yang sudah dicari. */
export function withArea(rates: ShippingRates, area: DestinationArea | null): ShippingRates {
  if (!area) return rates
  const destination = rates.destination || {}
  return {
    ...rates,
    destination: {
      ...destination,
      code: destination.code || area.code,
      district: destination.district || area.district,
      city: destination.city || area.city,
    },
  }
}

const ADDRESS_STOP = new Set(['jalan', 'desa', 'dusun', 'kecamatan', 'kabupaten', 'kelurahan', 'provinsi', 'perumahan', 'komplek', 'kompleks', 'nomor', 'blok', 'gang', 'jawa', 'tengah', 'barat', 'timur', 'utara', 'selatan', 'indonesia'])

/**
 * Alamat tanpa label kecamatan/kabupaten ("…, cinyawang patimuan cilacap 53264"): cari tujuan
 * dari kata-kata alamat (dari belakang) dan ambil yang kode posnya sama. Maks 4 pencarian.
 */
async function areaFromPostal(text: string, postal: string, mcp: LeanMcpConfig): Promise<DestinationArea | null> {
  if (!postal || !text) return null
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .replace(/(?:\+?62|0)8[\d\s-]{7,16}/g, ' ')
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 5 && !ADDRESS_STOP.has(word))
    ),
  ]
    .reverse()
    .slice(0, 4)
  for (const word of words) {
    const rows = await findDestinations(word, mcp).catch(() => [] as DestinationRow[])
    const hit = rows.find((row) => String(row.zip_code || '') === postal && row.code && row.district)
    if (hit)
      return {
        code: String(hit.code),
        district: String(hit.district || ''),
        city: String(hit.city || ''),
        label: [hit.district, hit.city].filter(Boolean).join(', '),
        terms: String(hit.subdistrict || '').toLowerCase(),
      }
  }
  return null
}

async function ratesForAddress(
  address: { district: string; regency: string; postalCode: string },
  lastResolved: DestinationArea | null,
  mcp: LeanMcpConfig,
  grams = DEFAULT_ITEM_GRAMS,
  /** Teks alamat asli: dipakai bila kecamatan/kabupaten tidak berlabel. */
  text = ''
): Promise<ShippingRates | null> {
  const city = address.regency ? normalizeCity(address.regency) : ''
  const districtMatchesLast =
    lastResolved &&
    address.district &&
    lastResolved.district.toLowerCase().includes(address.district.toLowerCase().split(' ')[0])
  const attempts: Array<Record<string, unknown>> = []
  if (districtMatchesLast && lastResolved) attempts.push({ destination: lastResolved.code })
  if (address.district || address.regency)
    attempts.push({
      destination: address.district || address.regency,
      ...(city ? { city } : {}),
      ...(address.postalCode ? { zip_code: address.postalCode } : {}),
    })
  if (address.district && city) attempts.push({ destination: address.district })
  // Hasil harus benar-benar kecamatan & kota yang diminta: "Wara, Palopo" pernah terbaca
  // "Warambe, Muna" (nama mirip di kota lain) → ongkir salah. Hasil yang tidak cocok dibuang.
  const squash = (value: unknown) => String(value || '').toLowerCase().replace(/[^a-z]/g, '')
  const wantDistrict = squash(address.district)
  const wantCity = squash(city)
  const fits = (rates: ShippingRates | null) => {
    const found = rates?.destination
    if (!found?.district && !found?.city) return true
    if (wantCity && found.city && !squash(found.city).includes(wantCity) && !wantCity.includes(squash(found.city))) return false
    if (wantDistrict && found.district && squash(found.district) !== wantDistrict && !(found as any).subdistrict?.toString().toLowerCase().replace(/[^a-z]/g, '').includes(wantDistrict))
      return false
    return true
  }
  let lastError: unknown = null
  for (const args of attempts) {
    try {
      const rates = await callLeanTool<ShippingRates>(
        'check_shipping_rates',
        { ...args, weight_grams: grams },
        mcp
      )
      if (rates?.prices?.length && (args.destination === lastResolved?.code || fits(rates))) return rates
    } catch (error) {
      lastError = error
    }
  }
  // Cadangan: cari daftar tujuan di kota itu, pilih kecamatan yang namanya persis sama.
  if (wantDistrict && city) {
    try {
      const area = groupDestinations(await findDestinations(city, mcp)).find(
        (item) => squash(item.district) === wantDistrict && squash(item.city).includes(wantCity)
      )
      if (area) {
        const rates = await callLeanTool<ShippingRates>('check_shipping_rates', { destination: area.code, weight_grams: grams }, mcp)
        if (rates?.prices?.length) return { ...rates, destination: { ...(rates.destination || {}), code: area.code, district: area.district, city: area.city } }
      }
    } catch (error) {
      lastError = lastError || error
    }
  }
  // Alamat tanpa label: tujuan yang tadi dicek di chat (namanya ada di alamat), atau cari dari kode pos.
  if (!address.district && !address.regency && text) {
    const hay = text.toLowerCase().replace(/[^a-z]/g, '')
    const mentioned =
      lastResolved &&
      [lastResolved.district, lastResolved.city, ...lastResolved.terms.split(' ')]
        .map((value) => squash(value))
        .some((value) => value.length >= 4 && hay.includes(value))
    try {
      const area = mentioned ? lastResolved : await areaFromPostal(text, address.postalCode, mcp)
      if (area) {
        const rates = await callLeanTool<ShippingRates>('check_shipping_rates', { destination: area.code, weight_grams: grams }, mcp)
        if (rates?.prices?.length) return withArea(rates, area)
      }
    } catch (error) {
      lastError = lastError || error
    }
  }
  if (lastError) throw lastError
  return null
}
