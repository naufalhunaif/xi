import db from '#services/workspace_database'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { AiDecision } from '#services/ai_service'
import { catalogImageUrls } from '#services/ai_service'
import { parseOutgoingImages } from '#services/outgoing_image_contract'
import { readCart } from '#services/cart_service'

export type OutgoingImage = {
  mediaType?: 'image' | 'video' | 'document'
  mime?: string
  fileName?: string
  caption: string
  kind: 'answer' | 'initiative'
  bytes: Buffer
  mediaUrl: string
}

const LIMIT = 8_000_000
const imageLink = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i
const links = (text: string) =>
  [...text.matchAll(/https?:\/\/[^\s<>"'`]+|\/[^\s<>"'`]*\/media\/[^\s<>"'`]+/g)].map((match) =>
    match[0].replace(/[),.!?\]]+$/, '')
  )
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function stripImageLinks(text: string, urls: string[]) {
  for (const url of urls) {
    const escaped = escape(url)
    text = text
      .replace(new RegExp(`!?\\[([^\\]]*)\\]\\(${escaped}\\)`, 'g'), '')
      .replace(new RegExp(`<?${escaped}>?`, 'g'), '')
  }
  return text
    .replace(/^[ \t]*[-*]?[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function downloadOutgoingImage(url: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (
    !response.ok ||
    !/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(response.headers.get('content-type') || '')
  )
    throw new Error('File gambar tidak tersedia.')
  if (Number(response.headers.get('content-length') || 0) > LIMIT) {
    await response.body?.cancel()
    throw new Error('Ukuran gambar terlalu besar.')
  }
  if (!response.body) throw new Error('File gambar kosong.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > LIMIT) throw new Error('Ukuran gambar terlalu besar.')
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel()
  }
  if (!size) throw new Error('File gambar kosong.')
  return Buffer.concat(chunks)
}

/** Only actual image sources from this room or verified MCP products can become attachments. */
export async function prepareOutgoingImages(
  jid: string,
  decision: AiDecision,
  connections: Array<{ url: string; enabled: boolean; authenticated: boolean }>,
  scheduled = false,
  fetcher: typeof fetch = fetch
) {
  if (decision.decision !== 'reply') return { decision, images: [] as OutgoingImage[] }
  const requested = parseOutgoingImages(decision.images).map((image) => ({
    ...image,
    kind: 'answer' as 'answer' | 'initiative',
  }))
  const sources = new Map<string, string[]>()
  const active = connections.filter((connection) => connection.enabled && connection.authenticated)
  const allowRemote = (alias: string, urls: string[]) => {
    const verified = [
      ...new Set(
        urls
          .filter((url) => /^https?:\/\//i.test(url))
          .flatMap((url) => active.flatMap((connection) => catalogImageUrls(url, connection.url)))
      ),
    ]
    if (!verified.length) return
    sources.set(alias, verified)
    for (const url of verified) sources.set(url, verified)
  }
  for (const product of decision.cartEvidence?.products || []) {
    const urls = Array.isArray(product.imageUrls) ? product.imageUrls : []
    if (product.img) allowRemote(String(product.img), [...urls, String(product.img)])
    for (const url of urls) allowRemote(url, urls)
  }
  const textLinks = [
    ...links(decision.message),
    ...(!scheduled ? links(decision.initiative || '') : []),
  ]
  // Avoid reading cart/database for ordinary replies without media.
  if (!requested.length && !textLinks.length) return { decision, images: [] as OutgoingImage[] }
  const cart = await readCart(jid)
  for (const item of cart.items)
    if (item.image && /^https?:\/\//i.test(item.image)) allowRemote(item.image, [item.image])
  const possibleLocal = [...new Set([...requested.map((item) => item.url), ...textLinks])].filter(
    (url) => url.startsWith(`${(env.get('APP_BASE_PATH') || '')}/media/`)
  )
  if (possibleLocal.length) {
    const rows = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .whereIn('media_type', ['image', 'sticker'])
      .whereIn('media_url', possibleLocal)
    for (const row of rows) sources.set(row.media_url, [row.media_url])
  }
  for (const [body, kind] of [
    [decision.message, 'answer'],
    [scheduled ? '' : decision.initiative || '', 'initiative'],
  ] as const) {
    for (const url of links(body)) {
      if (!sources.has(url) && !imageLink.test(url)) continue // Product/website links remain text.
      if (!requested.some((item) => item.url === url)) requested.push({ url, caption: '', kind })
    }
  }
  if (!requested.length) return { decision, images: [] as OutgoingImage[] }
  if (requested.length > 4) throw new Error('Terlalu banyak gambar untuk satu balasan.')
  for (const item of requested)
    if (!sources.has(item.url))
      throw new Error('Sumber gambar belum terverifikasi di room atau data bisnis.')
  const urls = [...new Set(requested.flatMap((item) => [item.url, ...sources.get(item.url)!]))]
  for (const item of requested) {
    if (links(item.caption).some((url) => imageLink.test(url) && !urls.includes(url)))
      throw new Error('Tautan gambar tambahan harus dilampirkan dari sumber terverifikasi.')
  }
  const images: OutgoingImage[] = []
  const seen = new Set<string>()
  const root = app.makePath('public', 'media')
  await mkdir(root, { recursive: true })
  for (const item of requested) {
    let bytes: Buffer | undefined
    for (const url of sources.get(item.url)!) {
      try {
        let source: Buffer
        if (url.startsWith(`${(env.get('APP_BASE_PATH') || '')}/media/`)) {
          const name = url.slice(`${(env.get('APP_BASE_PATH') || '')}/media/`.length)
          if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Gambar lokal tidak valid.')
          const resolvedRoot = await realpath(root)
          const path = await realpath(join(resolvedRoot, name))
          const info = await stat(path)
          if (!path.startsWith(`${resolvedRoot}${sep}`) || !info.isFile() || info.size > LIMIT)
            throw new Error('Gambar lokal tidak valid.')
          source = await readFile(path)
        } else source = await downloadOutgoingImage(url, fetcher)
        bytes = await sharp(source, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer()
        break
      } catch {
        /* Try another verified variant; never fall back to sending its URL. */
      }
    }
    if (!bytes)
      throw new Error('Gambar belum berhasil dimuat; balasan tidak dikirim sebagai tautan.')
    const hash = createHash('sha256').update(jid).update(bytes).digest('hex')
    if (seen.has(hash)) continue
    seen.add(hash)
    const filename = workspaceFileName(`outgoing-${hash}.jpg`)
    await writeFile(join(root, filename), bytes)
    images.push({
      bytes,
      mediaUrl: `${(env.get('APP_BASE_PATH') || '')}/media/${filename}`,
      caption: stripImageLinks(item.caption, urls),
      kind: item.kind,
    })
  }
  return {
    images,
    decision: {
      ...decision,
      message: stripImageLinks(decision.message, urls),
      initiative: stripImageLinks(decision.initiative || '', urls),
    },
  }
}

export function outgoingMessagePayload(body: string, image?: OutgoingImage) {
  if (image?.mediaType === 'video')
    return { video: image.bytes, caption: body, mimetype: image.mime || 'video/mp4' }
  if (image?.mediaType === 'document')
    return {
      document: image.bytes,
      caption: body,
      mimetype: image.mime || 'application/pdf',
      fileName: image.fileName || 'Size chart.pdf',
    }
  return image
    ? { image: image.bytes, caption: body, mimetype: 'image/jpeg' as const }
    : { text: body }
}
import { workspaceFileName } from '#services/workspace_context'
