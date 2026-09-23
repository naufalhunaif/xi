import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

test('motion animates transitions, supports rapid reversals and respects reduced motion', async ({
  browserContext,
  assert,
}) => {
  const page = await browserContext.newPage()
  const js = await readFile('public/assets/motion.js', 'utf8')
  const styles = await Promise.all(
    [
      '../store/assets/css/app.css',
      '../store/assets/css/workspace.css',
      'public/assets/app.css',
      'public/assets/cart.css',
      'public/assets/motion.css',
    ].map((path) => readFile(path, 'utf8'))
  )
  const css = styles.join('\n')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/motion-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
      <body class="workspace-ui"><aside id="sidebar" class="sidebar">Sidebar</aside><div class="shell">
      <button id="toggle" onclick="document.documentElement.classList.toggle('wa-sidebar-collapsed')">Toggle</button>
      <button id="opener" onclick="waMotion.showDialog(document.querySelector('#cartDialog'))">Cart</button>
      <button id="reveal" onclick="waMotion.visible(document.querySelector('#launcherMenu'),true)">Menu</button>
      <div id="launcherMenu" hidden>Applications</div>
      <details id="details"><summary>Details</summary><div style="height:160px;padding:12px">Order details</div></details>
      <dialog id="cartDialog" class="wa-cart-dialog"><header class="wa-cart-header">Cart<button id="close" onclick="waMotion.closeDialog(document.querySelector('#cartDialog'))">Close</button></header>
      <div class="wa-cart-layout"><section id="orderDetailPanel" class="wa-order-detail" hidden>Order details</section><div class="wa-cart-body"><button id="expand" onclick="document.querySelector('#cartDialog').classList.toggle('has-order-detail');waMotion.visible(document.querySelector('#orderDetailPanel'),document.querySelector('#cartDialog').classList.contains('has-order-detail'))">Detail</button></div></div></dialog>
      </div><script>${js}</script><script>document.querySelector('#cartDialog').addEventListener('cancel',e=>{e.preventDefault();waMotion.closeDialog(e.target)})</script></body></html>`,
    })
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('http://localhost/motion-fixture')
  await page.locator('html.wa-motion-ready').waitFor()
  const waitAnimations = () =>
    page.evaluate(async () => {
      const doc = (globalThis as any).document
      await Promise.all(
        doc.getAnimations().map((animation: any) => animation.finished.catch(() => {}))
      )
    })
  await page.locator('#toggle').click()
  assert.isAbove(
    await page.locator('#sidebar').evaluate((element: any) => element.getAnimations().length),
    0
  )
  await waitAnimations()
  assert.equal((await page.locator('#sidebar').boundingBox())!.width, 64)
  assert.equal((await page.locator('.shell').boundingBox())!.x, 64)
  await page.locator('#opener').click()
  assert.isAbove(
    await page.locator('#cartDialog').evaluate((element: any) => element.getAnimations().length),
    0
  )
  await waitAnimations()
  await page.locator('#expand').click()
  await waitAnimations()
  const main = await page.locator('.wa-cart-body').boundingBox()
  assert.closeTo(main!.x + main!.width, 1440, 1)
  await page.locator('#expand').click()
  await waitAnimations()
  assert.isFalse(await page.locator('#orderDetailPanel').isVisible())
  assert.closeTo((await page.locator('#cartDialog').boundingBox())!.width, 520, 1)
  // Reopening a sheet mid-close cancels the pending close instead of hiding it later.
  await page.evaluate(() => {
    const w = globalThis as any
    const dialog = w.document.querySelector('#cartDialog')
    w.waMotion.closeDialog(dialog)
    w.waMotion.showDialog(dialog)
  })
  await waitAnimations()
  assert.isTrue(await page.locator('#cartDialog').isVisible())
  await page.keyboard.press('Escape')
  await page.locator('#cartDialog').waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => (globalThis as any).document.activeElement.id), 'opener')
  await page.locator('#reveal').click()
  await waitAnimations()
  await page.evaluate(() => {
    const w = globalThis as any
    const menu = w.document.querySelector('#launcherMenu')
    w.waMotion.visible(menu, false)
    w.waMotion.visible(menu, true)
  })
  await waitAnimations()
  assert.isTrue(await page.locator('#launcherMenu').isVisible())
  await page.locator('#details summary').click()
  await waitAnimations()
  assert.isAbove((await page.locator('#details').boundingBox())!.height, 160)
  await page.locator('#details summary').click()
  await waitAnimations()
  assert.isFalse(await page.locator('#details').evaluate((element: any) => element.open))
  // Toggling accessibility preferences mid-exit must finish the close immediately.
  await page.locator('#opener').click()
  await page.locator('#close').click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('#cartDialog').waitFor({ state: 'hidden' })
  await page.locator('#toggle').click()
  assert.equal((await page.locator('#sidebar').boundingBox())!.width, 212)
  assert.equal(
    await page.locator('#sidebar').evaluate((element: any) => element.getAnimations().length),
    0
  )
  await page.locator('#opener').click()
  assert.equal(
    await page.locator('#cartDialog').evaluate((element: any) => element.getAnimations().length),
    0
  )
  await page.locator('#close').click()
  assert.isFalse(await page.locator('#cartDialog').isVisible())
  assert.deepEqual(errors, [])
}).timeout(60_000)
