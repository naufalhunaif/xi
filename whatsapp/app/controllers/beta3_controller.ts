// Beta 3 — salinan terisolasi dari LeanController; hanya menyentuh #beta3/*.
import type { HttpContext } from '@adonisjs/core/http'
import { catalogDigest, importLeanCatalog } from '#beta3/catalog_service'
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
  requeueLeanOrderGroup,
  updatePendingOrderSpec,
  renderGroupOrderMessage,
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
import { listActiveRefs, refCaption, refsForOrder } from '#beta3/refs_service'
import { readRecapProgress, requestRecap } from '#beta3/recap_service'
import { skillStatus, syncRemoteSkills } from '#beta3/skill_sync'
import { ensureDefaults } from '#services/settings_service'
import {
  readLeanMcpConfig,
  listLeanMcpSources,
  writeLeanMcpConfig,
  callLeanTool,
  syncLeanCatalog,
} from '#beta3/mcp'
import { describeCatalogPhotos } from '#beta3/catalog_vision'
import { attachOrderPhotos } from '#beta3/order_photos'
import env from '#start/env'

/** Beta 2: katalog digest, contoh CS, order menunggu CS, catatan pelanggan. */
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
      version: await readLeanState('catalog_version'),
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
    const status = String(request.qs().status || '')
    const q = String(request.qs().q || '')
    response.header('cache-control', 'no-store')
    const [orders, counts] = await Promise.all([
      listLeanOrders(status || undefined, q || undefined),
      countLeanOrders(),
    ])
    const withText = orders.map((order: Record<string, any>) => ({
      spec: order.spec as unknown,
      ...order,
      // Foto dicocokkan dari isi pesanan saja, bukan dari catatan chat.
      chat_note: '',
      text: renderGroupOrderMessage(order),
    }))
    return response.json({ orders: await attachOrderPhotos(withText), counts })
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

  async paidOrder({ params, request, response }: HttpContext) {
    const body = request.body() as Record<string, unknown>
    try {
      const order = await markLeanOrderPaid(
        Number(params.id),
        body.csNote ? String(body.csNote) : undefined,
        undefined,
        body.groupJid ? String(body.groupJid) : null
      )
      if (body.notify !== false)
        await queueOutgoingMessage({ jid: String(order.jid), body: 'Terimakasih bos, prosess ya' })
      return response.json({ ok: true, groupQueued: Boolean(order.group_jid) })
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
    const jid = String(request.qs().jid || '')
    if (!jid) return response.badRequest({ error: 'jid wajib.' })
    const [spec, order, contact, chatNote] = await Promise.all([
      readOrderSpec(jid),
      latestLeanOrder(jid),
      db.from('whatsapp_contacts').where('jid', jid).first(),
      readBeta3ChatNote(jid),
    ])
    // Bukti transfer: gambar pelanggan setelah total dikirim (untuk dicek sebelum Lunas).
    const proofs =
      order && order.status === 'awaiting_payment'
        ? await db
            .from('whatsapp_messages')
            .where('jid', jid)
            .where('direction', 'in')
            .where('media_type', 'image')
            .where('created_at', '>', order.updated_at)
            .whereNotNull('media_url')
            .orderBy('id', 'desc')
            .limit(3)
            .select('media_url')
        : []
    // Pesanan yang tampil: order aktif; kalau tidak ada, detail yang sedang ditulis AI;
    // kalau kosong juga, order terakhir yang sudah lunas.
    const active = order && ['pending', 'awaiting_payment'].includes(String(order.status))
    const shown = active ? order : spec ? null : order && order.status === 'paid' ? order : null
    const text = shown ? renderGroupOrderMessage(shown) : spec
    const refs = shown && shown.status === 'paid' ? await refsForOrder(Number(shown.id)) : await listActiveRefs(jid)
    const [withPhotos] = await attachOrderPhotos([{ spec: text, items: '', chat_note: '' }])
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
}
