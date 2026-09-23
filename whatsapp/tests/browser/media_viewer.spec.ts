import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

test('media viewer supports dynamic images, players, documents, keyboard and nested dialogs', async ({
  browserContext,
  assert,
}) => {
  const page = await browserContext.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Existing regression scenarios use the Indonesian UI explicitly.
  await page.addInitScript(() => {
    ;(globalThis as any).localStorage.setItem(
      'http://localhost/alogaritm--app/whatsapp:ui-language',
      'id'
    )
  })
  const js = await readFile('public/assets/media_viewer.js', 'utf8')
  const css = await readFile('public/assets/media_viewer.css', 'utf8')
  const image =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#41645a"/><circle cx="600" cy="400" r="160" fill="#adc8af"/></svg>'
    )
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
  const video = execFileSync(ffmpeg, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=160x120:r=10',
    '-t',
    '1',
    '-c:v',
    'libvpx',
    '-f',
    'webm',
    'pipe:1',
  ])
  const audio = execFileSync(ffmpeg, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=8000:cl=mono',
    '-t',
    '1',
    '-f',
    'wav',
    'pipe:1',
  ])
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/viewer-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body{font-family:Arial}.message-media{width:180px}.wa-contact-avatar{width:40px}.message-media-wrap{width:220px;margin:16px;position:relative}#parent img{width:120px}${css}
      </style></head><body class="workspace-ui">
      <a id="contact" href="/should-not-navigate"><img class="wa-contact-avatar" src="${image}" alt="Foto profil"></a>
      <div id="messages"><div class="message-media-wrap"><img id="photo" class="message-media" src="${image}" alt="Gambar pelanggan"></div>
      <div class="message-media-wrap"><video id="video" class="message-media" controls src="/test.webm"></video></div>
      <div class="message-media-wrap"><video id="gif" class="message-media" loop muted autoplay src="/test.webm"></video></div>
      <div class="message-media-wrap"><audio id="audio" class="message-audio" controls src="/test.wav"></audio></div>
      <a class="message-document" id="pdf" href="/test.pdf" download="nota.pdf">nota.pdf ↓</a>
      <a class="message-document" id="doc" href="/test.docx" download="order.docx">order.docx ↓</a></div>
      <button id="openParent" onclick="document.querySelector('#parent').showModal()">Buka cart</button>
      <dialog id="parent"><a href="/should-not-navigate"><img id="cartPaymentProof" src="${image}" alt="Bukti pembayaran"></a></dialog>
      <script>${js}</script></body></html>`,
    })
  )
  await page.route('**/test.webm', (route) =>
    route.fulfill({ contentType: 'video/webm', body: video })
  )
  await page.route('**/test.wav', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: audio })
  )
  await page.route('**/test.pdf', (route) =>
    route.fulfill({
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'attachment; filename="nota.pdf"' },
      body: '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    })
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://localhost/viewer-fixture')
  await page.locator('#photo').click()
  const viewer = page.locator('#mediaViewer')
  await viewer.waitFor({ state: 'visible' })
  await page.locator('#mediaViewerStage img').evaluate((img: any) => img.decode())
  const picture = await page.locator('#mediaViewerStage img').boundingBox()
  assert.isAbove(picture!.width, 180)
  assert.isAtMost(picture!.height, 840)
  await page.locator('#mediaZoomIn').click()
  assert.equal(await page.locator('#mediaZoomReset').innerText(), '2×')
  await page.locator('#mediaZoomReset').click()
  await page.screenshot({ path: '/private/tmp/whatsapp-media-large-desktop.png' })
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => (globalThis as any).document.activeElement?.id), 'photo')
  await page.locator('.wa-contact-avatar').click()
  assert.include(page.url(), '/viewer-fixture')
  await page.locator('#mediaViewerClose').click()
  await page.locator('#photo').focus()
  await page.keyboard.press('Enter')
  assert.isTrue(await viewer.isVisible())
  await page.keyboard.press('Escape')
  await page.evaluate((src) => {
    const sticker = (globalThis as any).document.createElement('img')
    sticker.id = 'sticker'
    sticker.className = 'message-media sticker'
    sticker.src = src
    ;(globalThis as any).document.querySelector('#messages').append(sticker)
  }, image)
  await page.locator('#sticker[data-media-view]').click()
  assert.equal(await page.locator('#mediaViewerStage img').getAttribute('src'), image)
  await page.keyboard.press('Escape')
  for (const id of ['video', 'gif', 'audio']) {
    await page.locator(`#${id} + [data-media-expand]`).click()
    const kind = id === 'audio' ? 'audio' : 'video'
    await page.locator(`#mediaViewerStage ${kind}`).waitFor()
    await page.waitForFunction(() => {
      const player = (globalThis as any).document.querySelector(
        '#mediaViewerStage video, #mediaViewerStage audio'
      )
      return player.readyState >= 2
    })
    assert.isTrue(
      await page.locator(`#mediaViewerStage ${kind}`).evaluate((player: any) => player.controls)
    )
    assert.isTrue(await page.locator(`#${id}`).evaluate((player: any) => player.paused))
    if (id === 'gif')
      assert.isTrue(
        await page
          .locator('#mediaViewerStage video')
          .evaluate((player: any) => player.loop && player.muted)
      )
    await page.keyboard.press('Escape')
    await page
      .locator('#mediaViewerStage video, #mediaViewerStage audio')
      .waitFor({ state: 'detached' })
  }
  await page.locator('#pdf').click()
  await page.locator('#mediaViewerStage iframe[src^="blob:"]').waitFor()
  assert.equal(await page.locator('#mediaViewerStage iframe').getAttribute('title'), 'nota.pdf')
  await page.keyboard.press('Escape')
  await page.locator('#doc').click()
  assert.include(await page.locator('#mediaViewerStage').innerText(), 'Buka di tab baru')
  assert.equal(await page.locator('#mediaViewerDownload').getAttribute('download'), 'order.docx')
  await page.keyboard.press('Escape')
  await page.locator('#openParent').click()
  await page.locator('#cartPaymentProof').click()
  assert.isTrue(await viewer.isVisible())
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await viewer.boundingBox()
  assert.isAtMost(bounds!.width, 390)
  assert.isAtMost(bounds!.height, 844)
  await page.screenshot({ path: '/private/tmp/whatsapp-media-large-mobile.png' })
  await page.keyboard.press('Escape')
  assert.isTrue(await page.locator('#parent').isVisible())
  assert.equal(
    await page.evaluate(() => (globalThis as any).document.activeElement?.id),
    'cartPaymentProof'
  )
  assert.deepEqual(errors, [])
}).timeout(60_000)
