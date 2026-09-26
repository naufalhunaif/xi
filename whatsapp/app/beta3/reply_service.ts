// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { phoneFromJid } from '#services/customer_identity_service'
import { estimateTokens } from '#services/prompt_size_service'
import type { TraceSink } from '#services/trace_service'
import { catalogDigest, findCatalogVariant, type LeanCatalogRow } from '#beta3/catalog_service'
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
  noteAutoTotalReason,
  verifyAutoTotal,
  updatePendingOrderRates,
  type VerifiedAutoTotal,
} from '#beta3/order_service'
import {
  buildLeanPrompt,
  parseLeanDecision,
  renderProductionEstimate,
  type LeanDecision,
  type LeanHistoryRow,
} from '#beta3/prompt'
import { runLeanProvider, type LeanProviderSettings } from '#beta3/provider'
import { normalizeStyle, storeStyle, styleGuide } from '#beta3/style_service'
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
} from '#beta3/mcp'
import { readLeanState, writeLeanState, readBeta3ChatNote } from '#beta3/tables'
import { saveAiRefs } from '#beta3/refs_service'
import { tidyLists } from '#beta3/list_tidy'
import { collectContext, compareWithSizeChart, measureFromHistory } from '#beta3/context_service'

/**
 * Jalur balas ramping (beta 2): satu panggilan AI, tanpa tool, prompt ≈ 6–10rb
 * token. Angka/tahap ditangani kode; AI hanya menulis kata-kata.
 */
export const LEAN_SKILL_NAME = 'beta3-cs-inti'
export const LEAN_SKILL_TOKEN_LIMIT = 6000
const HISTORY_LIMIT = 30

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

function stageFromNote(note: string) {
  const match = note.match(/tahap\s*[:=]\s*([a-z_]+)/i)
  return match ? match[1].toLowerCase() : ''
}

async function history(jid: string, currentIds: Set<string>): Promise<LeanHistoryRow[]> {
  const rows = await db
    .from('whatsapp_messages')
    .select('message_id', 'direction', 'sender_type', 'body', 'media_type', 'created_at', 'reply_to_message_id')
    .where('jid', jid)
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(HISTORY_LIMIT)
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
  }
  return rows.reverse().map((row) => ({
    replyTo: row.reply_to_message_id ? quoted.get(String(row.reply_to_message_id)) || null : null,
    direction: row.direction === 'in' ? 'in' : 'out',
    senderType: row.sender_type,
    body: row.body,
    mediaType: row.media_type,
    createdAt: row.created_at,
    current: currentIds.has(String(row.message_id)),
  }))
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
    .slice(-3)
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
  return photos.slice(0, 3)
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
}): Promise<LeanReply> {
  const { jid, settings, onTrace } = input
  const skill = selectLeanSkill(settings.skills)
  const skillTokens = estimateTokens(skill.content)
  if (skillTokens > LEAN_SKILL_TOKEN_LIMIT)
    onTrace?.({
      key: 'beta3-skill',
      label: `Skill ${skill.name} terlalu panjang (~${skillTokens} token, batas ${LEAN_SKILL_TOKEN_LIMIT})`,
      status: 'completed',
      detail: { tokens: skillTokens, limit: LEAN_SKILL_TOKEN_LIMIT },
    })

  await seedLeanExamples().catch(() => 0)
  const [digest, examples, customerNote, chatNote, rows, spec] = await Promise.all([
    catalogDigest(),
    listLeanExamples(),
    readCustomerNote(jid),
    readBeta3ChatNote(jid),
    history(jid, new Set(input.messageIds)),
    readOrderSpec(jid),
  ])
  const stage = stageFromNote(chatNote)
  // Gaya balasan toko: sama untuk ChatGPT, Claude, dan Gemini.
  const style = await storeStyle(examples).catch(() => null)

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
  // Ukuran badan (pinggang/dada/…) dibandingkan dengan SIZE CHART oleh kode.
  const sizeCharts = await readLeanState('size_charts')
  const chartNote = compareWithSizeChart(rows, String(sizeCharts || ''))
  if (chartNote) {
    toolNotes.push(chartNote)
    onTrace?.({ key: 'beta3-sizechart', label: 'Size chart dibandingkan', status: 'completed', detail: {} })
  }

  // Jalur 2: form order dibaca kode, disimpan untuk CS. AI tetap menulis balasannya.
  let orderId: number | null = null
  let systemNote = ''
  const typedForm = parseOrderForm(input.text)
  // Alamat yang ditempel bebas juga dianggap form order supaya total terkirim otomatis.
  let pasted: ReturnType<typeof looseAddressForm> = null
  if (!typedForm) {
    const contact = await db.from('whatsapp_contacts').where('jid', jid).select('name').first()
    const waPhone = phoneFromJid(jid)
    pasted = looseAddressForm(
      input.text,
      contact?.name ? String(contact.name) : '',
      waPhone ? `0${waPhone.replace(/^62/, '')}` : ''
    )
  }
  const form = typedForm || pasted

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
      const rates = await ratesForAddress(loose, last?.resolved || null, mcp)
      const rateText = rates ? renderShippingRates(rates) : ''
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
  const place = form || loose ? null : extractShippingQuery(input.text, followUp)
  if (place && mcp.url) {
    try {
      let note = ''
      let pending = false
      let choices: DestinationArea[] = []
      let resolved: DestinationArea | null = null
      // Jawaban atas pilihan yang tadi ditanyakan: cocokkan dulu, tanpa cari ulang.
      if (followUp && last?.pending && last.choices?.length)
        resolved = pickArea(input.text, last.choices)
      if (!resolved) {
        let areas = groupDestinations(await findDestinations(place, mcp))
        if (!areas.length && last?.pending && last.place && !place.includes(last.place))
          areas = groupDestinations(await findDestinations(`${place} ${last.place}`, mcp))
        if (!areas.length) {
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
        const cacheKey = `ongkir:${resolved.code}:${new Date().toISOString().slice(0, 10)}`
        note = await readLeanState(cacheKey)
        if (!note) {
          const rates = await callLeanTool<ShippingRates>(
            'check_shipping_rates',
            { destination: resolved.code, weight_grams: 1000 },
            mcp
          )
          note = rates ? renderShippingRates(rates) : ''
          if (note) await writeLeanState(cacheKey, note)
        }
      }
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

  if (form) {
    let rates: ShippingRates | null = null
    if (mcp.url && (form.district || form.postalCode)) {
      try {
        const lastResolved = parseJson<LastShipping>(await readLeanState(lastKey))?.resolved
        rates = await ratesForAddress(
          { district: form.district, regency: form.regency, postalCode: form.postalCode },
          lastResolved || null,
          mcp
        )
        // Alamat tempelan dirapikan ulang dengan nama resmi tujuan dari cek ongkir.
        const tidy = pasted ? tidyLooseAddress(input.text, rates?.destination || null) : null
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
      sourceMessageId: input.messageIds[input.messageIds.length - 1],
      form,
      items: spec || [form.note, chatNote].filter(Boolean).join('\n'),
      spec,
      chatNote,
      shippingOptions: rates?.prices?.length ? rates : null,
    })
    const rateText = rates ? renderShippingRates(rates) : ''
    if (rateText) toolNotes.push(rateText)
    systemNote =
      '\n\nCATATAN SISTEM: form order pelanggan sudah tercatat (#' +
      orderId +
      '). Jangan menulis total atau rekening di pesan — sistem yang mengirimnya. ' +
      'Isi field order (rincian per item dengan nama persis KATALOG + harga, subtotal, layanan ongkir yang dipilih pelanggan). ' +
      'Kalau ada TB/BB dan size yang dipilih terlihat tidak cocok, konfirmasi size dulu (satu pertanyaan). ' +
      (rateText
        ? 'Kalau pelanggan belum memilih layanan dari bagian ONGKIR, tanyakan (satu pertanyaan) dan kosongkan layanan. Kalau sudah lengkap: balas "siap bos, datanya sudah masuk ya, ini totalnya" — total + rekening menyusul otomatis. tahap = tunggu_cs.'
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
      let rates: ShippingRates | null = pending.shipping_options
        ? (parseJson<ShippingRates>(String(pending.shipping_options)) as ShippingRates | null)
        : null
      if (!rates?.prices?.length) {
        try {
          const lastResolved = parseJson<LastShipping>(await readLeanState(lastKey))?.resolved
          rates = await ratesForAddress(
            {
              district: String(pending.district || ''),
              regency: String(pending.regency || ''),
              postalCode: String(pending.postal_code || ''),
            },
            lastResolved || null,
            mcp
          )
          if (rates?.prices?.length) await updatePendingOrderRates(orderId, rates)
        } catch (error) {
          onTrace?.({
            key: 'beta3-rates',
            label: 'Ongkir tidak tersedia',
            status: 'failed',
            detail: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      const rateText = rates ? renderShippingRates(rates) : ''
      if (rateText) toolNotes.push(rateText)
      systemNote =
        '\n\nCATATAN SISTEM: form order #' +
        orderId +
        ' sudah tercatat, total belum terkirim. Jangan menulis total atau rekening di pesan. ' +
        'Isi field order (rincian per item dengan nama persis KATALOG + harga, subtotal, layanan ongkir pilihan pelanggan) supaya sistem mengirim total + rekening otomatis setelah pesanmu. ' +
        (rateText
          ? 'Kalau pelanggan belum memilih layanan dari bagian ONGKIR, tanyakan (satu pertanyaan) dan kosongkan layanan. Kalau sudah jelas: balas "siap bos, ini totalnya ya". tahap = tunggu_cs.'
          : 'Ongkir belum bisa dihitung: balas singkat bahwa totalnya dikabari sebentar lagi; kosongkan layanan. tahap = tunggu_cs.')
      onTrace?.({
        key: 'beta3-order',
        label: `Order #${orderId} masih menunggu total`,
        status: 'completed',
        detail: { orderId, rates: Boolean(rateText) },
      })
    }
  }

  const store = await readLeanState('store_profile')
  const prompt = buildLeanPrompt({
    skill: skill.content,
    store,
    fabrics: await readLeanState('fabrics'),
    sizeCharts,
    catalog: digest.text,
    examples: pickExamples(examples, input.text, stage),
    styleGuide: style ? styleGuide(style) : '',
    customerNote,
    chatNote,
    spec,
    history: rows,
    context: collectContext({ history: rows, catalog: digest.rows, text: input.text }),
    message: `${replyContext(rows)}${input.text}${toolNotes.length ? `\n\n${toolNotes.join('\n')}` : ''}${systemNote}`,
    paymentMethods: settings.paymentMethods.filter((method) => method.enabled),
    production: settings.production ? renderProductionEstimate(settings.production, new Date(), String(store || '')) : '',
    imageCount: input.imagePaths?.length || 0,
  })
  onTrace?.({
    key: 'prompt-size',
    label: `Ukuran prompt ≈ ${prompt.size.tokens} token (skill ~${skillTokens})`,
    status: 'completed',
    detail: { ...prompt.size, skillName: skill.name, catalogRows: digest.rows.length },
  })

  onTrace?.({ key: 'beta3-ai', label: 'Menyusun balasan · tanpa tool', status: 'running' })
  const result = await runLeanProvider(settings, prompt, input.imagePaths || [], undefined, undefined, {
    jid,
  })
  const decision = parseLeanDecision(result.text)
  decision.pesan = dropRepeatedQuestions(decision.pesan, rows)
  if (style) {
    decision.pesan = normalizeStyle(decision.pesan, style)
  }
  // Ongkir selalu tampil rapi (satu layanan per baris), model apa pun yang menulis.
  decision.pesan = tidyShippingBubbles(decision.pesan, toolNotes, style?.address || 'bos')
  // Deretan pilihan/harga/produk dalam satu kalimat → satu per baris (semua model).
  decision.pesan = decision.pesan.map(tidyLists)
  if (style) {
    if (decision.susulan) decision.susulan = normalizeStyle([decision.susulan], style)[0] || ''
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
  if (!totalOrderId) {
    const pending = await latestLeanOrder(jid)
    if (pending && pending.status === 'pending') totalOrderId = Number(pending.id)
  }
  if (totalOrderId) {
    // Cadangan bila AI tidak mengisi field order: rincian dari lembar spesifikasi,
    // subtotal dihitung kode dari katalog (0 = jangan bandingkan), layanan dicari
    // di catatan/spesifikasi/pesan ("ongkir: CTCYES", "pakai YES").
    const specNow = decision.spesifikasi || spec
    const draft =
      decision.order && decision.order.rincian
        ? decision.order
        : { rincian: specNow, subtotal: 0, layanan: '' }
    // Harga yang sudah disebut toko di chat (CS/AI), untuk pre-order atau produk di luar katalog.
    const statedPrices = rows
      .filter((row) => row.direction === 'out' && row.body)
      .flatMap((row) => parsePrices(String(row.body)))
    const verdict = await verifyAutoTotal(
      totalOrderId,
      draft,
      digest.rows,
      [decision.catatan, specNow, chatNote, input.text],
      statedPrices
    )
    if (verdict.ok) autoTotal = verdict.total
    await noteAutoTotalReason(totalOrderId, verdict.ok ? '' : verdict.reason)
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
  }
  // Total/pembayaran yang dikerjakan CS langsung di chat ikut tercatat di order.
  if (!autoTotal && decision.pembayaran) {
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
  return {
    decision,
    autoTotal,
    photos: resolvePhotos(digest.rows, decision.foto),
    promptTokens: prompt.size.tokens,
    promptSections: prompt.size.sections,
    usage: result.usage,
    durationMs: result.durationMs,
    orderId,
    skillName: skill.name,
  }
}

export const LEAN_NUDGE_DELAY_MS = 10 * 60_000
export const LEAN_NUDGE_MAX_PER_CHAT = 2

/**
 * Tutup goal giliran ini: status ikut tahap. Kalau AI menyiapkan `susulan`,
 * dijadwalkan sekali (tanpa panggilan AI) dan hanya terkirim bila pelanggan
 * diam; pesan baru apa pun membatalkannya.
 */
export async function finishLeanGoal(
  run: { jid: string; version: string; anchor_id: number },
  decision: LeanDecision
) {
  const previous = await db.from('whatsapp_chat_goals').where('jid', run.jid).first()
  const nudges = Number(previous?.followup_count || 0)
  const status = decision.serah_cs
    ? 'paused'
    : decision.tahap.startsWith('tunggu') ||
        decision.tahap.startsWith('tanya') ||
        decision.tahap === 'minta_alamat' ||
        decision.tahap === 'tawar_celana' ||
        decision.tahap === 'kirim_form'
      ? 'waiting'
      : 'completed'
  const nudge =
    status === 'waiting' && decision.susulan && nudges < LEAN_NUDGE_MAX_PER_CHAT
      ? decision.susulan
      : ''
  const values = {
    analyzed_anchor_id: run.anchor_id,
    status,
    objective: decision.tahap,
    waiting_for: status === 'waiting' ? decision.tahap : '',
    next_action: nudge,
    policy_json: nudge ? JSON.stringify({ lean: true, nudge, stage: decision.tahap }) : null,
    skill_hash: null,
    next_run_at: nudge ? new Date(Date.now() + LEAN_NUDGE_DELAY_MS) : null,
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
export async function claimLeanNudge(jid: string, now = new Date()) {
  const goal = await db.from('whatsapp_chat_goals').where('jid', jid).first()
  if (!goal || goal.status !== 'waiting' || !goal.next_run_at || new Date(goal.next_run_at) > now)
    return null
  let policy: { lean?: boolean; nudge?: string } | null = null
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
  if (
    !last ||
    last.direction !== 'out' ||
    last.sender_type !== 'ai' ||
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
  const found = await callLeanTool<{ destinations?: DestinationRow[] }>(
    'check_destination',
    { q },
    mcp
  )
  return found?.destinations || []
}

/**
 * Tarif untuk alamat form: kode tujuan dari obrolan (bila kecamatannya sama) →
 * nama kecamatan + kota → nama kecamatan saja. Null bila semuanya gagal.
 */
async function ratesForAddress(
  address: { district: string; regency: string; postalCode: string },
  lastResolved: DestinationArea | null,
  mcp: LeanMcpConfig
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
  let lastError: unknown = null
  for (const args of attempts) {
    try {
      const rates = await callLeanTool<ShippingRates>(
        'check_shipping_rates',
        { ...args, weight_grams: 1000 },
        mcp
      )
      if (rates?.prices?.length) return rates
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return null
}
