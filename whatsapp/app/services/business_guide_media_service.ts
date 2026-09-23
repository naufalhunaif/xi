import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { mcpMediaFetch } from '#services/mcp_oauth_fetch'
import {
  parseBusinessMedia,
  type BusinessGuide,
  type GuideConnection,
} from '#services/business_guide_contract'
import type { AiDecision } from '#services/ai_service'
import { stripImageLinks, type OutgoingImage } from '#services/outgoing_image_service'
import { workspaceFileName } from '#services/workspace_context'

const MAX_BYTES = 16 * 1024 * 1024
export async function downloadGuideMedia(
  guide: BusinessGuide,
  fetcher = mcpMediaFetch(guide.connectionUrl)
) {
  const response = await fetcher(guide.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (
    !response.ok ||
    response.redirected ||
    !['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf'].includes(mime)
  ) {
    await response.body?.cancel()
    throw new Error('Media panduan MCP tidak tersedia atau format tidak didukung.')
  }
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) {
    await response.body?.cancel()
    throw new Error('Media panduan MCP melebihi 16 MB.')
  }
  if (!response.body) throw new Error('Media panduan MCP kosong.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > MAX_BYTES) throw new Error('Media panduan MCP melebihi 16 MB.')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = Buffer.concat(chunks)
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined)
  if (!detected || detected.mime !== mime || (guide.mime && guide.mime !== mime))
    throw new Error('Isi media panduan MCP tidak sesuai formatnya.')
  if (guide.kind === 'tutorial' && mime !== 'video/mp4')
    throw new Error('Tutorial MCP harus berupa video MP4.')
  if (guide.kind === 'size_chart' && !mime.startsWith('image/') && mime !== 'application/pdf')
    throw new Error('Size chart MCP harus berupa gambar atau PDF.')
  if (mime.startsWith('image/')) {
    const image = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .jpeg({ quality: 95 })
      .toBuffer()
    if (image.length > MAX_BYTES) throw new Error('Media panduan MCP melebihi 16 MB.')
    return {
      bytes: image,
      mime: 'image/jpeg',
      type: 'image' as const,
      extension: 'jpg',
    }
  }
  return {
    bytes,
    mime,
    type: mime === 'video/mp4' ? ('video' as const) : ('document' as const),
    extension: mime === 'video/mp4' ? 'mp4' : 'pdf',
  }
}

/** Server/id is resolved only against fresh evidence, never an AI-provided download URL. */
export function selectedBusinessGuides(decision: AiDecision, connections: GuideConnection[]) {
  if (decision.decision !== 'reply') return []
  const selected = new Map<string, { guide: BusinessGuide; caption: string }>()
  for (const intent of parseBusinessMedia(decision.businessMedia)) {
    const guide = decision.guideEvidence?.find(
      (g) => g.server === intent.server && g.id === intent.id
    )
    if (
      !guide ||
      !connections.some(
        (c) =>
          c.enabled &&
          c.authenticated &&
          `business_${c.slug}` === guide.server &&
          c.url === guide.connectionUrl
      )
    )
      throw new Error('Panduan belum terverifikasi dari MCP aktif pada proses ini.')
    selected.set(`${intent.server}:${intent.id}`, { guide, caption: intent.caption })
  }
  return [...selected.values()]
}

export async function prepareBusinessGuideMedia(
  jid: string,
  decision: AiDecision,
  connections: GuideConnection[],
  fetcher?: typeof fetch
) {
  const selected = selectedBusinessGuides(decision, connections)
  const urls = (decision.guideEvidence || []).flatMap((g) => [g.url, g.sourceUrl])
  for (const guide of decision.guideEvidence || []) {
    const text = `${decision.message}\n${decision.initiative || ''}`
    if (
      [guide.url, guide.sourceUrl].some((url) => url.length > 5 && text.includes(url)) &&
      !selected.some((item) => item.guide.server === guide.server && item.guide.id === guide.id)
    )
      throw new Error(
        'Panduan harus dipilih sebagai lampiran businessMedia, bukan tautan pada balasan.'
      )
  }
  const cleaned = {
    ...decision,
    message: stripImageLinks(decision.message, urls),
    initiative: stripImageLinks(decision.initiative || '', urls),
  }
  const media: OutgoingImage[] = []
  const seen = new Set<string>()
  for (const { guide, caption } of selected) {
    const downloaded = await downloadGuideMedia(guide, fetcher)
    const hash = createHash('sha256').update(jid).update(downloaded.bytes).digest('hex')
    if (seen.has(hash)) continue
    seen.add(hash)
    const filename = workspaceFileName(`guide-${hash}.${downloaded.extension}`)
    const root = app.makePath('public', 'media')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, filename), downloaded.bytes)
    media.push({
      bytes: downloaded.bytes,
      caption: stripImageLinks(caption, urls),
      kind: 'answer',
      mediaUrl: `${(env.get('APP_BASE_PATH') || '')}/media/${filename}`,
      mediaType: downloaded.type,
      mime: downloaded.mime,
      fileName: `${guide.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 100) || 'Size chart'}.${downloaded.extension}`,
    })
  }
  return { decision: cleaned, media }
}
