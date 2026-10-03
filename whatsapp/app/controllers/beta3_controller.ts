// Beta 3 — salinan terisolasi dari LeanController; hanya menyentuh #beta3/*.
import { scanShipments } from '#beta3/shipments'
import type { HttpContext } from '@adonisjs/core/http'
import { catalogDigest, importLeanCatalog, rupiah } from '#beta3/catalog_service'
import {
  addLeanExample,
  listLeanExamples,
  removeLeanExample,
  seedLeanExamples,
} from '#beta3/examples_service'
import {
  sendLeanTotal,
  readLeanOrder,
  cancelLeanOrder,
  listLeanOrders,
  countLeanOrders,
  latestLeanOrder,
  markLeanOrderPaid,
  markLeanOrderReady,
  settleLeanOrder,
  recheckPaidOrders,
  setLeanPaidAmount,
  requeueLeanOrderGroup,
  updatePendingOrderSpec,
  renderGroupOrderMessage,
  pendingSettlement,
  isOrderShipped,
  paidThanksMessage,
} from '#beta3/order_service'
import {
  readCustomerNote,
  writeCustomerNote,
  readOrderSpec,
  writeOrderSpec,
} from '#beta3/customer_service'
import db from '#services/workspace_database'
import { queueOutgoingMessage } from '#services/message_service'
import { estimateTokens } from '#services/prompt_size_service'
import { readLeanState, readBeta3ChatNote } from '#beta3/tables'
import { recoverHandledOrder } from '#beta3/reply_service'
import { fixCatalogColors } from '#beta3/color_fix'
import { readExchangePolicy, saveExchangePolicy } from '#beta3/store_policy'
import {
  customerImagesForOrder,
  listActiveRefs,
  orderProofImages,
  proofTotalSince,
  refCaption,
  refsForOrder,
} from '#beta3/refs_service'
import { readRecapProgress, requestRecap } from '#beta3/recap_service'
import { skillStatus, syncRemoteSkills } from '#beta3/skill_sync'
import { ensureDefaults, readSettings } from '#services/settings_service'
import {
  addRule,
  listRules,
  listTests,
  removeRule,
  removeTest,
  runTests,
  saveCorrection,
} from '#beta3/quality_service'
import {
  readLeanMcpConfig,
  listLeanMcpSources,
  writeLeanMcpConfig,
  callLeanTool,
  syncLeanCatalog,
} from '#beta3/mcp'
import { describeCatalogPhotos } from '#beta3/catalog_vision'
import { attachOrderPhotos } from '#beta3/order_photos'
import { ITEM_TYPES, orderWeightGrams, readItemWeights, saveItemWeights } from '#beta3/weights'
import env from '#start/env'

/** Beta 2: katalog digest, contoh CS, order menunggu CS, catatan pelanggan. */
/** Bukti transfer yang nominalnya sedang/baru dibaca AI (sekali per 10 menit per order). */
const proofReads = new Map<string, number>()

export default class Beta3Controller {
  async page({ view, session }: HttpContext) {
    await ensureDefaults()
    return view.render('pages/dashboard', {
      page: 'beta3',
      account: session.get('account'),
      bundle: (env.get('ACCOUNT_URL') || '')
        .replace(/\/$/, '')
        .replace(/\/account$/, ''),
    })
  }

  async catalog({ response }: HttpContext) {
    const digest = await catalogDigest(true)
    return response.json({
      rows: digest.rows,
      digest: digest.text,
      tokens: estimateTokens(digest.text),
      updatedAt: new Date(digest.at).toISOString(),
      version: await readLeanState('catalog_version_sf2'),
    })
  }

  /** Tombol Sync: tarik katalog dari MCP bila versinya berubah. */
  async syncCatalog({ request, response }: HttpContext) {
    const body = request.body() as { force?: unknown }
    try {
      const result = await syncLeanCatalog({ force: body.force === true || body.force === 'true' })
      if (!result.configured)
        return response.badRequest({ error: 'Sumber data belum dipilih (ikon roda gigi).' })
      // Ciri model dari foto dianalisis di latar; digest berikutnya sudah memuatnya.
      void describeCatalogPhotos().catch(() => {})
      const digest = await catalogDigest(true)
      return response.json({
        ...result,
        rows: digest.rows.length,
        tokens: estimateTokens(digest.text),
        digest: digest.text,
      })
    } catch (error) {
      return response.badRequest({
        error: error instanceof Error ? error.message : 'Sync gagal.',
      })
    }
  }

  async importCatalog({ request, response }: HttpContext) {
    const body = request.body() as { items?: unknown; replace?: unknown; json?: unknown }
    let items = body.items
    if (typeof body.json === 'string') {
      try {
        items = JSON.parse(body.json)
      } catch {
        return response.badRequest({ error: 'JSON katalog tidak valid.' })
      }
    }
    if (items && typeof items === 'object' && !Array.isArray(items))
      items =
        (items as Record<string, unknown>).items ?? (items as Record<string, unknown>).products
    if (!Array.isArray(items) || !items.length)
      return response.badRequest({ error: 'Kirim array produk pada field items.' })
    try {
      const count = await importLeanCatalog(items, body.replace === true || body.replace === 'true')
      const digest = await catalogDigest(true)
      return response.json({ imported: count, tokens: estimateTokens(digest.text) })
    } catch (error) {
      return response.badRequest({
        error: error instanceof Error ? error.message : 'Import gagal.',
      })
    }
  }

  async examples({ response }: HttpContext) {
    await seedLeanExamples().catch(() => 0)
    return response.json({ examples: await listLeanExamples() })
  }

  async addExample({ request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    try {
      const id = await addLeanExample({
        situation: String(body.situation || ''),
        customerText: String(body.customerText || ''),
        csText: String(body.csText || ''),
        tags: String(body.tags || ''),
        source: 'manual',
      })
      return response.json({ id })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async removeExample({ params, response }: HttpContext) {
    await removeLeanExample(Number(params.id))
    return response.noContent()
  }

  async orders({ request, response }: HttpContext) {
    // Order lunas lama: cek nominal bukti transfer di latar (DP terdeteksi pada muat berikutnya).
    void recheckPaidOrders().catch(() => {})
    const status = String(request.qs().status || '')
    const q = String(request.qs().q || '')
    response.header('cache-control', 'no-store')
    // Resi terbaru dari chat supaya tab Selesai ikut terbarui walau kotak masuk belum dibuka.
    await scanShipments().catch(() => {})
    const [orders, counts] = await Promise.all([
      listLeanOrders(status || undefined, q || undefined),
      countLeanOrders(),
    ])
    // Nama pelanggan dari kontak bila order belum punya nama (chat lama / rekap).
    const jids = [...new Set(orders.map((order: Record<string, any>) => String(order.jid || '')).filter(Boolean))]
    const contacts = jids.length
      ? await db.from('whatsapp_contacts').whereIn('jid', jids).select('jid', 'name').catch(() => [])
      : []
    const nameOf = new Map(contacts.map((row: any) => [String(row.jid), String(row.name || '')]))
    const withText = orders.map((order: Record<string, any>) => ({
      spec: order.spec as unknown,
      contact_name: nameOf.get(String(order.jid || '')) || '',
      ...order,
      // Foto dicocokkan dari isi pesanan saja, bukan dari catatan chat.
      chat_note: '',
      text: renderGroupOrderMessage({ ...order, contact_name: nameOf.get(String(order.jid || '')) || '' }),
    }))
    // Gambar dari pelanggan (referensi) ikut tampil di detail order.
    const withRefs = await Promise.all(
      withText.map(async (order: Record<string, any>): Promise<Record<string, any> & { spec?: unknown }> => {
        const refs =
          order.status === 'paid' || order.status === 'cancelled'
            ? await refsForOrder(Number(order.id)).catch(() => [])
            : await listActiveRefs(String(order.jid || '')).catch(() => [])
        return {
          ...order,
          refs: refs.map((ref) => ({ url: ref.image_url, caption: refCaption(ref) })),
        }
      })
    )
    const withPhotos = await attachOrderPhotos(withRefs)
    // Sama seperti kiriman grup: tanpa foto katalog & referensi → gambar pelanggan di chat order.
    for (const order of withPhotos as Array<Record<string, any>>) {
      if (order.photos?.length || order.refs?.length) continue
      order.refs = await customerImagesForOrder(order).catch(() => [])
    }
    // Berat pesanan (dasar ongkir) tampil di detail order.
    for (const order of withPhotos as Array<Record<string, any>>)
      order.weight_grams = await orderWeightGrams(String(order.spec || order.items || '')).catch(() => null)
    // DP: bukti pelunasan yang menunggu konfirmasi → tombol "Konfirmasi pelunasan".
    for (const order of withPhotos as Array<Record<string, any>>)
      order.settlement = await pendingSettlement(order).catch(() => null)
    return response.json({ orders: withPhotos, counts })
  }

  /** CS mengisi ongkir + subtotal → sistem kirim total lalu rekening ke pelanggan. */
  async approveOrder({ params, request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    const shippingCost = Math.round(Number(String(body.shippingCost ?? '').replace(/[^\d]/g, '')))
    const subtotal = Math.round(Number(String(body.subtotal ?? '').replace(/[^\d]/g, '')))
    if (!Number.isFinite(shippingCost) || !Number.isFinite(subtotal) || subtotal <= 0)
      return response.badRequest({ error: 'Isi subtotal dan ongkir dalam rupiah.' })
    try {
      const current = await readLeanOrder(Number(params.id))
      const sent = await sendLeanTotal({
        orderId: Number(params.id),
        items: String(body.itemsText || current?.items || '').trim(),
        subtotal,
        shippingService: String(body.shippingService || '').trim(),
        shippingCost,
        csNote: body.csNote ? String(body.csNote) : undefined,
      })
      const order = { total: sent.total }
      return response.json({ ok: true, total: order.total })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  /** Dana masuk: nominal diisi CS (awal = nominal dari bukti transfer). Kurang dari total = DP. */
  async paidOrder({ params, request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    try {
      const current = await readLeanOrder(Number(params.id))
      const total = Number(current?.total || 0)
      const amount = Math.round(Number(String(body.amount ?? '').replace(/\D/g, '')) || 0) || total
      const dp = total > 0 && amount > 0 && amount < total
      const order = await markLeanOrderPaid(
        Number(params.id),
        dp ? `DP ${rupiah(amount)}, sisa ${rupiah(total - amount)}` : body.csNote ? String(body.csNote) : undefined,
        amount || undefined,
        body.groupJid ? String(body.groupJid) : null
      )
      if (body.notify !== false)
        await queueOutgoingMessage({
          jid: String(order.jid),
          sender: 'system',
          body: await paidThanksMessage(current || order, dp),
        })
      return response.json({ ok: true, dp, groupQueued: Boolean(order.group_jid) })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  /** Pelunasan sisa pembayaran order DP. */
  async settleOrder({ params, request, response }: HttpContext) {
    try {
      const amount = Math.round(Number(String(request.input('amount', '')).replace(/\D/g, '')) || 0)
      if (amount <= 0) return response.badRequest({ error: 'Isi nominal pelunasan.' })
      const order = await settleLeanOrder(Number(params.id), amount)
      await queueOutgoingMessage({
        jid: String(order.jid),
        sender: 'system',
        body: order.lunas
          ? 'Terimakasih bos, pelunasan sudah kami terima. Pesanan kami kirim secepatnya ya, nomor resi kami kabari setelah dikirim.'
          : `Terimakasih bos, ${rupiah(amount)} sudah kami terima. Sisa ${rupiah(order.sisa)} ya bos.`,
      })
      return response.json({ ok: true, lunas: order.lunas })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  /** Koreksi nominal dibayar tanpa pesan ke pelanggan. */
  async paidAmount({ params, request, response }: HttpContext) {
    try {
      const amount = Math.round(Number(String(request.input('amount', '')).replace(/\D/g, '')) || 0)
      if (amount <= 0) return response.badRequest({ error: 'Isi nominal dibayar.' })
      await setLeanPaidAmount(Number(params.id), amount)
      return response.json({ ok: true })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  /** Pesanan selesai diproduksi: kabari pelanggan (minta pelunasan bila masih DP). */
  async readyOrder({ params, response }: HttpContext) {
    try {
      const order = await markLeanOrderReady(Number(params.id))
      // Sapaan sesuai jam WIB; malam hari pengiriman dijanjikan besok.
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(new Date())
      )
      const greet = hour >= 4 && hour < 11 ? 'pagi' : hour < 15 && hour >= 11 ? 'siang' : hour >= 15 && hour < 18 ? 'sore' : 'malam'
      const when = greet === 'malam' ? 'besok' : 'hari ini'
      await queueOutgoingMessage({
        jid: String(order.jid),
        sender: 'system',
        body: order.sisa > 0
          ? `Selamat ${greet} bos, pesanannya sudah selesai ya. Untuk sisa pembayarannya Rp${rupiah(order.sisa)}, bisa dilunasi ke rekening yang sama bos, biar ${when} langsung kami kirim. Terimakasih`
          : `Selamat ${greet} bos, pesanannya sudah selesai ya. ${when === 'besok' ? 'Besok' : 'Hari ini'} kami kirim, nomor resinya nanti kami kabari. Terimakasih`,
      })
      return response.json({ ok: true, sisa: order.sisa })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async resendGroup({ params, request, response }: HttpContext) {
    try {
      const groupJid = request.input('groupJid')
      await requeueLeanOrderGroup(Number(params.id), groupJid ? String(groupJid) : null)
      return response.json({ ok: true })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async cancelOrder({ params, request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    await cancelLeanOrder(Number(params.id), body.csNote ? String(body.csNote) : undefined)
    return response.noContent()
  }

  /** Panel ruang chat (pengganti cart): detail pesanan, order terakhir, catatan pelanggan. */
  async room({ request, response }: HttpContext) {
    void recheckPaidOrders().catch(() => {})
    const jid = String(request.qs().jid || '')
    if (!jid) return response.badRequest({ error: 'jid wajib.' })
    // Spesifikasi lama yang warnanya tidak sesuai foto yang ditunjukkan di chat / KATALOG dirapikan.
    const storedSpec = await readOrderSpec(jid)
    if (storedSpec) {
      const chat = await db
        .from('whatsapp_messages')
        .where('jid', jid)
        .orderBy('id', 'desc')
        .limit(200)
        .select('direction', 'body', 'media_type')
      const fixed = fixCatalogColors(
        String(storedSpec),
        (await catalogDigest().catch(() => ({ rows: [] }))).rows,
        chat.map((row: any) => ({ direction: String(row.direction), body: row.body, mediaType: row.media_type })).reverse()
      )
      if (fixed.swaps.length) {
        await writeOrderSpec(jid, fixed.text)
        await updatePendingOrderSpec(jid, fixed.text)
      }
    }
    // Form yang terlewat saat CS membalas + total dikirim CS manual: order dicatat supaya
    // tombol konfirmasi pembayaran muncul.
    const payment = await readSettings().catch(() => null)
    await recoverHandledOrder(jid, (payment?.paymentMethods || []).map((method) => String(method.destination || ''))).catch(() => null)
    const [spec, order, contact, chatNote] = await Promise.all([
      readOrderSpec(jid),
      latestLeanOrder(jid),
      db.from('whatsapp_contacts').where('jid', jid).first(),
      readBeta3ChatNote(jid),
    ])
    // Bukti transfer untuk dicek sebelum Lunas. Nominalnya dibaca AI dari gambar (di latar)
    // supaya isian "Dana masuk" tidak otomatis = total (DP 400 ribu terbaca lunas).
    const proofs = order && order.status === 'awaiting_payment' ? await orderProofImages(jid, order).catch(() => []) : []
    const readKey = `${order?.id}:${proofs.length}`
    if (
      order &&
      order.status === 'awaiting_payment' &&
      proofs.length &&
      !Number(order.reported_amount || 0) &&
      Date.now() - (proofReads.get(readKey) || 0) > 10 * 60_000
    ) {
      proofReads.set(readKey, Date.now())
      void proofTotalSince(
        jid,
        new Date(Math.min(new Date(order.created_at).getTime(), new Date(order.updated_at).getTime()))
      )
        .then((amount) =>
          amount > 0
            ? db.from('whatsapp_beta3_orders').where('id', order.id).whereNull('reported_amount').update({ reported_amount: amount })
            : null
        )
        .catch(() => null)
    }
    // Pesanan yang tampil: order aktif; kalau tidak ada, detail yang sedang ditulis AI;
    // kalau kosong juga, order terakhir yang sudah lunas.
    const active = order && ['pending', 'awaiting_payment'].includes(String(order.status))
    const shown = active ? order : spec ? null : order && order.status === 'paid' ? order : null
    const text = shown ? renderGroupOrderMessage(shown) : spec
    const refs = shown && shown.status === 'paid' ? await refsForOrder(Number(shown.id)) : await listActiveRefs(jid)
    const [withPhotos] = await attachOrderPhotos([{ spec: text, items: '', chat_note: '' }])
    if (order) {
      ;(order as Record<string, any>).shipped = await isOrderShipped(order).catch(() => false)
      ;(order as Record<string, any>).settlement = await pendingSettlement(order).catch(() => null)
    }
    response.header('cache-control', 'no-store')
    return response.json({
      jid,
      spec,
      order,
      proofs,
      photos: withPhotos.photos,
      refs: refs.map((ref) => ({ image_url: ref.image_url, caption: refCaption(ref) })),
      groupPreview: text,
      chatNote: chatNote || (contact?.chat_note ? String(contact.chat_note) : ''),
      handling: { mode: contact?.handling_mode === 'cs' ? 'cs' : 'ai' },
    })
  }

  /** Pengaturan → Skill: status skill + tombol ambil skill terbaru dari rilis online. */
  async skill({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json(await skillStatus())
  }

  async updateSkill({ response }: HttpContext) {
    const result = await syncRemoteSkills()
    return response.json({ updated: result.updated, ...(await skillStatus()) })
  }

  /** Rekap order dari chat lama yang dilayani CS manusia (dikerjakan worker di latar). */
  async recapStatus({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({ progress: await readRecapProgress() })
  }

  async startRecap({ request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    return response.json({ progress: await requestRecap(Number(body.days) || 30) })
  }

  async saveSpec({ request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    const jid = String(body.jid || '')
    if (!jid) return response.badRequest({ error: 'jid wajib.' })
    const spec = await writeOrderSpec(jid, String(body.spec || ''))
    if (spec) await updatePendingOrderSpec(jid, spec)
    return response.json({ jid, spec })
  }

  async mcp({ response }: HttpContext) {
    const [config, sources] = await Promise.all([readLeanMcpConfig(), listLeanMcpSources()])
    return response.json({
      slug: config.slug || '',
      name: config.name || '',
      url: config.url,
      connected: Boolean(config.url && config.token && !config.error),
      error: config.error || '',
      sources,
    })
  }

  async saveMcp({ request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    const slug = String(body.slug ?? '').trim()
    if (slug) {
      const sources = await listLeanMcpSources()
      if (!sources.some((source) => source.slug === slug))
        return response.badRequest({ error: 'Koneksi tidak ada di Data bisnis.' })
    }
    // Slug menggantikan URL+token lama; kosongkan keduanya supaya tidak membingungkan.
    const config = await writeLeanMcpConfig({ slug, url: '', token: '' })
    const base = {
      slug: config.slug || '',
      name: config.name || '',
      url: config.url,
      connected: false,
      error: config.error || '',
    }
    if (!slug) return response.json({ ...base, ok: true })
    if (config.error) return response.json(base)
    try {
      const check = await callLeanTool(
        'catalog_digest',
        { format: 'json', if_version: 'x' },
        config,
        15_000
      )
      return response.json({ ...base, connected: Boolean(check), ok: Boolean(check) })
    } catch (error) {
      return response.json({
        ...base,
        error: error instanceof Error ? error.message : 'MCP tidak bisa dihubungi.',
      })
    }
  }

  async customer({ request, response }: HttpContext) {
    const jid = String(request.qs().jid || '')
    if (!jid) return response.badRequest({ error: 'jid wajib.' })
    return response.json({ jid, note: await readCustomerNote(jid), spec: await readOrderSpec(jid) })
  }

  async saveCustomer({ request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    const jid = String(body.jid || '')
    if (!jid) return response.badRequest({ error: 'jid wajib.' })
    return response.json({ jid, note: await writeCustomerNote(jid, String(body.note || '')) })
  }

  // ---- Berat barang per jenis (untuk cek ongkir) ----
  async weights({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    const weights = await readItemWeights()
    return response.json({ types: ITEM_TYPES.map((type) => ({ key: type.key, label: type.label, grams: weights[type.key] })) })
  }

  async saveWeights({ request, response }: HttpContext) {
    const weights = await saveItemWeights((request.input('weights') || {}) as Record<string, unknown>)
    return response.json({ types: ITEM_TYPES.map((type) => ({ key: type.key, label: type.label, grams: weights[type.key] })) })
  }

  /** Kebijakan tukar size (Pengaturan → Data bisnis): satu teks untuk AI & CS. */
  async policy({ response }: HttpContext) {
    return response.json(await readExchangePolicy())
  }

  async savePolicy({ request, response }: HttpContext) {
    try {
      return response.json(await saveExchangePolicy(request.input('text', '')))
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  // ---- Kualitas: Aturan Toko, Koreksi, Kasus uji ----
  async rules({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({ rules: await listRules() })
  }

  async addRule({ request, response }: HttpContext) {
    try {
      return response.json({ rules: await addRule(String(request.input('text', ''))) })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async removeRule({ params, response }: HttpContext) {
    return response.json({ rules: await removeRule(Number(params.id)) })
  }

  async correction({ request, response }: HttpContext) {
    try {
      const kind = request.input('kind') === 'rule' ? 'rule' : 'example'
      return response.json(
        await saveCorrection({
          messageId: Number(request.input('messageId')),
          correct: String(request.input('correct', '')),
          kind,
          rule: String(request.input('rule', '')),
        })
      )
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async tests({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({ tests: await listTests() })
  }

  async runTests({ request, response }: HttpContext) {
    const settings = await readSettings(true)
    const ids = (Array.isArray(request.input('ids')) ? request.input('ids') : [])
      .map(Number)
      .filter((id: number) => id > 0)
    return response.json(
      await runTests(
        { ...settings, aiProvider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt' } as any,
        ids
      )
    )
  }

  async removeTest({ params, response }: HttpContext) {
    await removeTest(Number(params.id))
    return response.noContent()
  }
}
