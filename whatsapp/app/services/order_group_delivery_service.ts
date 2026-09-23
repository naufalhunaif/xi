import db from '#services/workspace_database'
import { orderMessages } from '#services/order_message_evidence'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import sharp from 'sharp'
import { catalogImageUrls } from '#services/ai_service'
import { downloadOutgoingImage } from '#services/outgoing_image_service'

type Part = { text: string; image?: string }
type Transport = {
  validateGroup(jid: string): Promise<void>
  send(
    jid: string,
    payload: { text: string } | { image: Buffer; caption: string },
    messageId: string
  ): Promise<string | undefined | null>
}
export async function orderGroupImage(url: string, jid: string) {
  const base = (env.get('APP_BASE_PATH') || '')
  const localUrl = url.startsWith(env.get('APP_URL').replace(/\/$/, '') + '/media/')
    ? new URL(url).pathname
    : url
  let bytes: Buffer
  if (localUrl.startsWith(`${base}/media/`)) {
    const name = localUrl.slice(`${base}/media/`.length)
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid product image.')
    const message = await orderMessages()
      .where('jid', jid)
      .where('media_url', localUrl)
      .whereIn('media_type', ['image', 'sticker'])
      .first()
    if (!message) throw new Error('Product image does not belong to this order room.')
    if (
      await db.from('whatsapp_order_payments').where('proof_message_id', message.message_id).first()
    )
      throw new Error('Payment receipts are private and cannot be forwarded as product images.')
    const root = await realpath(app.makePath('public', 'media'))
    const path = await realpath(join(root, name))
    const info = await stat(path)
    if (!path.startsWith(root + sep) || !info.isFile() || info.size > 8_000_000)
      throw new Error('Invalid product image.')
    bytes = await readFile(path)
  } else {
    const connections = await db
      .from('whatsapp_mcp_connections')
      .where('enabled', true)
      .select('url')
    if (
      !/^https?:\/\//i.test(url) ||
      !connections.some((c) => catalogImageUrls(url, c.url).includes(url))
    )
      throw new Error('Product image source is not trusted.')
    bytes = await downloadOutgoingImage(url)
  }
  return sharp(bytes, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/** At-most-once automatic transport attempt. Ambiguous network outcomes require human review. */
export async function deliverNextOrderGroup(transport: Transport, imageLoader = orderGroupImage) {
  const pending = await db.transaction(async (trx) => {
    const stale = new Date(Date.now() - 5 * 60_000)
    const interrupted = await trx
      .from('whatsapp_order_group_parts')
      .where('status', 'sending')
      .where('updated_at', '<', stale)
      .forUpdate()
    for (const part of interrupted) {
      await trx
        .from('whatsapp_order_group_parts')
        .where('order_id', part.order_id)
        .where('part_index', part.part_index)
        .update({
          status: 'uncertain',
          last_error: 'Periksa grup sebelum mencoba ulang.',
          updated_at: new Date(),
        })
      await trx
        .from('whatsapp_order_group_jobs')
        .where('order_id', part.order_id)
        .update({ status: 'uncertain', updated_at: new Date() })
    }
    await trx
      .from('whatsapp_order_group_parts')
      .where('status', 'preparing')
      .where('updated_at', '<', stale)
      .update({ status: 'queued', next_attempt_at: new Date() })
    const jobs = await trx
      .from('whatsapp_order_group_jobs')
      .whereIn('status', ['queued', 'sending'])
      .orderBy('order_id', 'asc')
      .limit(30)
      .forUpdate()
    for (const job of jobs) {
      const order = await trx.from('whatsapp_orders').where('id', job.order_id).first()
      if (!order || order.status !== 'active') {
        await trx
          .from('whatsapp_order_group_jobs')
          .where('order_id', job.order_id)
          .update({ status: 'cancelled', updated_at: new Date() })
        continue
      }
      const part = await trx
        .from('whatsapp_order_group_parts')
        .where('order_id', job.order_id)
        .whereNot('status', 'sent')
        .orderBy('part_index', 'asc')
        .first()
      if (
        !part ||
        part.status !== 'queued' ||
        new Date(part.next_attempt_at).getTime() > Date.now()
      )
        continue
      await trx
        .from('whatsapp_order_group_parts')
        .where('order_id', part.order_id)
        .where('part_index', part.part_index)
        .update({
          status: 'preparing',
          attempts: Number(part.attempts) + 1,
          updated_at: new Date(),
        })
      return { job, part, order, attempts: Number(part.attempts) + 1 }
    }
    return null
  })
  if (!pending) return false
  const { job, part, order } = pending
  const key = () =>
    db
      .from('whatsapp_order_group_parts')
      .where('order_id', part.order_id)
      .where('part_index', part.part_index)
  let transportStarted = false
  try {
    await transport.validateGroup(job.group_jid)
    const content = JSON.parse(part.content_json) as Part
    const payload = content.image
      ? { image: await imageLoader(content.image, order.jid), caption: content.text }
      : { text: content.text }
    const permitted = await db.transaction(async (trx) => {
      const current = await trx.from('whatsapp_orders').where('id', order.id).forUpdate().first()
      if (current?.status !== 'active') return false
      await trx
        .from('whatsapp_order_group_parts')
        .where('order_id', part.order_id)
        .where('part_index', part.part_index)
        .update({ status: 'sending', updated_at: new Date() })
      await trx
        .from('whatsapp_order_group_jobs')
        .where('order_id', part.order_id)
        .update({ status: 'sending', updated_at: new Date() })
      return true
    })
    if (!permitted) {
      await key().update({ status: 'cancelled', updated_at: new Date() })
      await db
        .from('whatsapp_order_group_jobs')
        .where('order_id', part.order_id)
        .update({ status: 'cancelled', updated_at: new Date() })
      return false
    }
    transportStarted = true
    const sentId = await transport.send(job.group_jid, payload, part.message_id)
    if (!sentId) throw new Error('Unconfirmed transport outcome')
    await db.transaction(async (trx) => {
      await trx
        .from('whatsapp_order_group_parts')
        .where('order_id', part.order_id)
        .where('part_index', part.part_index)
        .update({ status: 'sent', last_error: null, updated_at: new Date() })
      const remaining = await trx
        .from('whatsapp_order_group_parts')
        .where('order_id', part.order_id)
        .whereNot('status', 'sent')
        .first()
      await trx
        .from('whatsapp_order_group_jobs')
        .where('order_id', part.order_id)
        .update({ status: remaining ? 'queued' : 'sent', updated_at: new Date() })
    })
    return true
  } catch {
    const status = transportStarted ? 'uncertain' : pending.attempts >= 3 ? 'failed' : 'queued'
    await key().update({
      status,
      last_error: transportStarted
        ? 'Hasil kirim belum pasti. Periksa grup sebelum mencoba ulang.'
        : 'Grup atau gambar belum tersedia.',
      next_attempt_at: new Date(Date.now() + pending.attempts * 30_000),
      updated_at: new Date(),
    })
    await db
      .from('whatsapp_order_group_jobs')
      .where('order_id', part.order_id)
      .update({ status, updated_at: new Date() })
    return false
  }
}
export async function retryOrderGroup(orderId: number, reviewed: boolean, actor: string) {
  await db.transaction(async (trx) => {
    const order = await trx.from('whatsapp_orders').where('id', orderId).forUpdate().firstOrFail()
    if (order.status !== 'active') throw new Error('Order sudah dibatalkan.')
    const job = await trx
      .from('whatsapp_order_group_jobs')
      .where('order_id', orderId)
      .forUpdate()
      .firstOrFail()
    if (!['failed', 'uncertain'].includes(job.status))
      throw new Error('Pengiriman belum dapat dicoba ulang.')
    if (job.status === 'uncertain' && !reviewed)
      throw new Error('Periksa grup dan pastikan bagian terakhir belum terkirim.')
    await trx
      .from('whatsapp_order_group_parts')
      .where('order_id', orderId)
      .whereIn('status', ['failed', 'uncertain'])
      .update({
        status: 'queued',
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date(),
        updated_at: new Date(),
      })
    await trx
      .from('whatsapp_order_group_jobs')
      .where('order_id', orderId)
      .update({ status: 'queued', updated_at: new Date() })
    await trx.table('whatsapp_order_operation_events').insert({
      order_id: orderId,
      actor,
      before_json: JSON.stringify({ dispatch: job.status }),
      after_json: JSON.stringify({ dispatch: 'queued', manuallyChecked: reviewed }),
      created_at: new Date(),
    })
  })
}

export async function acknowledgeOrderGroup(orderId: number, reviewed: boolean, actor: string) {
  if (!reviewed) throw new Error('Periksa bahwa bagian terakhir benar-benar ada di grup.')
  await db.transaction(async (trx) => {
    const job = await trx
      .from('whatsapp_order_group_jobs')
      .where('order_id', orderId)
      .forUpdate()
      .firstOrFail()
    if (job.status !== 'uncertain') throw new Error('Tidak ada pengiriman yang perlu diperiksa.')
    const part = await trx
      .from('whatsapp_order_group_parts')
      .where('order_id', orderId)
      .where('status', 'uncertain')
      .orderBy('part_index', 'asc')
      .firstOrFail()
    await trx
      .from('whatsapp_order_group_parts')
      .where('order_id', orderId)
      .where('part_index', part.part_index)
      .update({ status: 'sent', last_error: null, updated_at: new Date() })
    const remaining = await trx
      .from('whatsapp_order_group_parts')
      .where('order_id', orderId)
      .whereNot('status', 'sent')
      .first()
    await trx
      .from('whatsapp_order_group_jobs')
      .where('order_id', orderId)
      .update({ status: remaining ? 'queued' : 'sent', updated_at: new Date() })
    await trx.table('whatsapp_order_operation_events').insert({
      order_id: orderId,
      actor,
      before_json: JSON.stringify({ dispatch: 'uncertain', part: part.part_index }),
      after_json: JSON.stringify({ dispatch: 'confirmed_in_group', part: part.part_index }),
      created_at: new Date(),
    })
  })
}
