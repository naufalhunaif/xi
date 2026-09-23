import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import sharp from 'sharp'
import { catalogImageUrls, extractCatalogProducts, prepareVisualInputs } from '#services/ai_service'

const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string

function run(command: string, argumentsList: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Perintah berhenti dengan kode ${code}.`))
    )
  })
}

test.group('AI media analysis', () => {
  test('extracts MCP product details and resolves same-site catalog images', ({ assert }) => {
    const products = extractCatalogProducts([
      {
        server: 'business_chameleon-cloth',
        tool: 'get_product',
        arguments: { id: 'product-1' },
        result: {
          structured_content: {
            id: 'product-1',
            name: 'Basic Suit - Navy',
            img: 'uploads/products/navy.jpg',
            sizes: [{ size_name: 'M', price: '485000.00', stock: '2' }],
          },
        },
      },
    ])
    assert.lengthOf(products, 1)
    assert.equal(products[0].name, 'Basic Suit - Navy')
    assert.deepEqual(
      catalogImageUrls('uploads/products/navy.jpg', 'https://chameleoncloth.com/mcp'),
      [
        'https://cdn.chameleoncloth.com/cdn-cgi/image/fit=scale-down,width=1200,quality=82,format=auto,metadata=none/uploads/products/navy.jpg',
        'https://chameleoncloth.com/uploads/products/navy.jpg',
        'https://cdn.chameleoncloth.com/uploads/products/navy.jpg',
      ]
    )
    assert.deepEqual(
      catalogImageUrls('https://untrusted.example/image.jpg', 'https://chameleoncloth.com/mcp'),
      []
    )
  })

  test('prepares photos, stickers, videos, and video thumbnail fallbacks', async ({ assert }) => {
    const directory = await mkdtemp(join(tmpdir(), 'whatsapp-media-test-'))
    try {
      const photo = join(directory, 'photo.png')
      const sticker = join(directory, 'sticker.webp')
      const video = join(directory, 'video.mp4')
      await sharp({
        create: { width: 120, height: 80, channels: 3, background: '#16a36f' },
      })
        .png()
        .toFile(photo)
      await sharp({
        create: { width: 80, height: 80, channels: 4, background: '#ffffff00' },
      })
        .webp()
        .toFile(sticker)
      await run(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x120:rate=2:duration=5',
        '-pix_fmt',
        'yuv420p',
        video,
      ])

      const photoOutput = await mkdtemp(join(tmpdir(), 'whatsapp-photo-output-'))
      const stickerOutput = await mkdtemp(join(tmpdir(), 'whatsapp-sticker-output-'))
      const videoOutput = await mkdtemp(join(tmpdir(), 'whatsapp-video-output-'))
      const fallbackOutput = await mkdtemp(join(tmpdir(), 'whatsapp-fallback-output-'))
      try {
        const photos = await prepareVisualInputs({ type: 'image', path: photo }, photoOutput)
        const stickers = await prepareVisualInputs(
          { type: 'sticker', path: sticker },
          stickerOutput
        )
        const frames = await prepareVisualInputs({ type: 'video', path: video }, videoOutput)
        const fallback = await prepareVisualInputs(
          { type: 'gif', path: join(directory, 'missing.mp4'), thumbnailPath: photo },
          fallbackOutput
        )

        assert.lengthOf(photos, 1)
        assert.lengthOf(stickers, 1)
        assert.isAtLeast(frames.length, 2)
        assert.isAtMost(frames.length, 6)
        assert.lengthOf(fallback, 1)
        const frameMetadata = await sharp(frames[0]).metadata()
        assert.equal(frameMetadata.format, 'jpeg')
      } finally {
        await Promise.all(
          [photoOutput, stickerOutput, videoOutput, fallbackOutput].map((path) =>
            rm(path, { recursive: true, force: true })
          )
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
