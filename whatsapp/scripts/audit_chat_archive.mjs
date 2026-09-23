// Offline, aggregate-only archive audit. Point this at a disposable copy of
// msgstore.db plus its WAL, never at a live WhatsApp database.
// No text, identifiers, credentials, phone numbers or addresses are exported.
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { currentFitRequest } from '../app/services/fit_routing_service.ts'
import { isProductCombinationQuestion } from '../app/services/product_routing_service.ts'

if (!process.argv[2])
  throw new Error('Usage: node scripts/audit_chat_archive.mjs /path/to/snapshot/msgstore.db')
const db = new DatabaseSync(resolve(process.argv[2]), { readOnly: true })
db.exec('PRAGMA query_only=ON')
const total = db
  .prepare('SELECT count(*) messages, count(distinct chat_row_id) chats FROM message')
  .get()
const rows = db
  .prepare(
    `SELECT m._id id, m.chat_row_id chat, m.from_me outgoing,
  m.timestamp ts, m.message_type type, m.text_data body,
  q.text_data quoted, q.message_row_id quote_id
  FROM message m JOIN chat c ON c._id=m.chat_row_id JOIN jid j ON j._id=c.jid_row_id
  LEFT JOIN message_quoted q ON q.message_row_id=m._id
  WHERE j.server IN ('s.whatsapp.net','lid') ORDER BY m.chat_row_id,m.timestamp,m._id`
  )
  .all()
const domain = /\b(jas|celana|suit|tuxedo|rompi|beskap|chameleon)\b/i
const domainCounts = new Map()
for (const row of rows)
  if (row.outgoing && domain.test(row.body || ''))
    domainCounts.set(row.chat, (domainCounts.get(row.chat) || 0) + 1)
const selected = rows.filter((row) => (domainCounts.get(row.chat) || 0) >= 2)
const categories = {
  product: /\b(jas|celana|suit|tuxedo|rompi|beskap|model|bahan)\b/i,
  selection: /\b(yang|yg|ini|itu|aja|saja|pilih|casual|black|hitam|sage)\b/i,
  fit: /\b(size|ukuran|tinggi|berat|tb|bb|slim|regular|pinggang)\b/i,
  custom: /\b(custom|custome|jahit|lapel|kancing|kerah)\b/i,
  shipping: /\b(ongkir|ongkos|kirim|pengiriman|kecamatan|kabupaten|kode pos|reg|yes|jne|jnt)\b/i,
  payment: /\b(bayar|pembayaran|transfer|dp|lunas|rekening|saldo|lebihan|kurang bayar)\b/i,
  production: /\b(selesai|pre.?order|produksi|jahit|jadi|acara|deadline|estimasi)\b/i,
  complaint: /\b(komplain|refund|retur|tukar|rusak|salah|kekecilan|kebesaran)\b/i,
  photo_request: /\b(foto|photo|gambar|katalog|liat|lihat)\b/i,
  quantity: /\b(pcs|pasang|stel|lusin|grosir|borongan|seragam)\b/i,
}
const counts = Object.fromEntries(Object.keys(categories).map((key) => [key, 0]))
let incomingText = 0,
  shortText = 0,
  quotedText = 0,
  quotedLong = 0,
  longOutgoing = 0
let shortAfterLong = 0,
  adjacentFitFragments = 0,
  multiTopic = 0
let explicitMeasurements = 0,
  fitGuardTriggered = 0,
  combinationGuardTriggered = 0
const mediaTypes = {}
let first = Infinity,
  last = -Infinity
let previous
for (const row of selected) {
  const body = String(row.body || '').trim()
  const clipped = body.replace(/\s+/g, ' ')
  if (row.outgoing && clipped.length > 600) longOutgoing++
  if (!row.outgoing) {
    mediaTypes[row.type] = (mediaTypes[row.type] || 0) + 1
    if (body) {
      incomingText++
      if (
        /\b(tb|tinggi)\s*[:=]?\s*\d{2,3}\b/i.test(body) &&
        /\b(bb|berat)\s*[:=]?\s*\d{2,3}\b/i.test(body)
      )
        explicitMeasurements++
      if (currentFitRequest(body)) fitGuardTriggered++
      if (isProductCombinationQuestion(body)) combinationGuardTriggered++
      if (body.length <= 60) shortText++
      if (row.quote_id) quotedText++
      if (String(row.quoted || '').replace(/\s+/g, ' ').length > 600) quotedLong++
      const hits = Object.entries(categories).filter(([, regex]) => regex.test(body))
      for (const [key] of hits) counts[key]++
      if (hits.length >= 3) multiTopic++
      if (
        previous?.chat === row.chat &&
        previous.outgoing &&
        String(previous.body || '').replace(/\s+/g, ' ').length > 600 &&
        body.length <= 60
      )
        shortAfterLong++
      // Counts a risk pattern, not an inference that a size recommendation failed.
      if (
        previous?.chat === row.chat &&
        !previous.outgoing &&
        row.ts - previous.ts < 300_000 &&
        /\b(tb|tinggi|berat|bb)\b/i.test(body + ' ' + previous.body) &&
        /\d/.test(body) &&
        /\d/.test(previous.body || '')
      )
        adjacentFitFragments++
    }
  }
  if (row.ts > 0) {
    first = Math.min(first, row.ts)
    last = Math.max(last, row.ts)
  }
  previous = row
}
console.log(
  JSON.stringify(
    {
      source: 'msgstore.db snapshot (main database + WAL; original not opened)',
      selectionRule:
        'Direct chats with at least two outgoing garment-keyword messages; heuristic, not verified customer labels',
      total,
      selected: {
        chats: new Set(selected.map((row) => row.chat)).size,
        messages: selected.length,
        incomingText,
        shortTextAtMost60: shortText,
        incomingQuotedText: quotedText,
        quotedBodyOver600: quotedLong,
        outgoingBodyOver600: longOutgoing,
        shortReplyAfterLongOutgoing: shortAfterLong,
        adjacentMeasurementFragments: adjacentFitFragments,
        explicitHeightAndWeightLabels: explicitMeasurements,
        currentFitGuardTriggered: fitGuardTriggered,
        currentCombinationGuardTriggered: combinationGuardTriggered,
        incomingWithAtLeast3KeywordCategories: multiTopic,
        first: Number.isFinite(first) ? new Date(first).toISOString() : null,
        last: Number.isFinite(last) ? new Date(last).toISOString() : null,
      },
      incomingKeywordMatches: counts,
      incomingRawMessageTypes: mediaTypes,
      limits: [
        'Categories overlap; counts are not failure or conversion rates.',
        'Outgoing archive messages do not identify AI versus human authors.',
        'No media pixels, live MCP, provider calls, orders or payment verification evaluated.',
      ],
    },
    null,
    2
  )
)
db.close()
