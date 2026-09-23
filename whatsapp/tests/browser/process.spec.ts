import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { startTrace, readTrace } from '#services/trace_service'

test('live progress and saved audit details are accessible without breaking the composer', async ({
  client,
  browserContext,
  assert,
}) => {
  await initializeDatabase()
  await db.beginGlobalTransaction()
  const jid = '10000000123456@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'audit-browser-reply',
      jid,
      contact_name: 'Audit Test',
      direction: 'out',
      sender_type: 'ai',
      body: 'Harga dari Store',
      status: 'sent',
      created_at: new Date(),
    })
    const trace = await startTrace(jid, {
      text: 'Harga kemeja?',
      provider: 'chatgpt',
      skills: ['cs'],
    })
    trace.emit({
      key: 'mcp',
      label: 'Store · get_product',
      status: 'completed',
      detail: { parameters: { id: 12 }, result: { name: 'Kemeja', price: 100000 } },
    })
    await trace.finish(
      'completed',
      {
        decision: 'reply',
        summary: 'Harga diambil dari Store; warna perlu dikonfirmasi.',
        goal: { objective: 'Lengkapi pilihan pelanggan', status: 'waiting', next_run_at: null },
      },
      'audit-browser-reply'
    )
    const saved = await readTrace(jid, trace.id)
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Pemilik',
        username: 'owner',
      },
    }
    const response = await client.get(`/?jid=${jid}`).withSession(session)
    response.assertStatus(200)
    const messagesResponse = await client
      .get(`/api/messages?jid=${jid}&latest=1`)
      .withSession(session)
    const page = await browserContext.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // Existing regression scenarios use the Indonesian UI explicitly.
    await page.addInitScript(() => {
      ;(globalThis as any).localStorage.setItem(
        'http://localhost/alogaritm--app/whatsapp:ui-language',
        'id'
      )
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let running = true
    let failed = false
    let failureKind = 'analysis'
    let liveStage = 'analysis'
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      let json: unknown = {}
      if (path.endsWith('/ai/trace'))
        json = {
          trace: failed
            ? {
                ...saved,
                status: 'failed',
                decision: { error: 'Proses AI atau pengiriman gagal.' },
                steps:
                  failureKind !== 'analysis'
                    ? [
                        {
                          key: 'tool',
                          label: 'business_chameleon-cloth · list_records',
                          status: 'completed',
                          detail: { result: 'Data tersedia' },
                        },
                        ...(failureKind === 'image'
                          ? [
                              {
                                key: 'outgoing-media',
                                label: 'Menyiapkan gambar balasan',
                                status: 'failed',
                                detail: {
                                  error:
                                    'Sumber gambar belum terverifikasi di room atau data bisnis.',
                                },
                              },
                            ]
                          : []),
                      ]
                    : [
                        {
                          key: 'business-check',
                          label: 'Memeriksa data bisnis sebelum menjawab',
                          status: 'failed',
                          durationMs: 0,
                          detail: { note: 'Proses berakhir tanpa konfirmasi selesai.' },
                        },
                        {
                          key: 'analysis',
                          label: 'Menganalisis input dan data bisnis',
                          status: 'failed',
                          durationMs: 0,
                          detail: null,
                        },
                      ],
              }
            : running
              ? {
                  ...saved,
                  status: 'running',
                  steps: [
                    { key: 'empty', label: '', status: 'completed' },
                    { key: 'skills', label: 'Skill dimuat', status: 'completed' },
                    { key: 'media', label: 'Input teks siap', status: 'completed' },
                    {
                      key: 'business-check',
                      label: 'Pemeriksaan kebutuhan bisnis selesai',
                      status: 'completed',
                    },
                    {
                      key: 'analysis',
                      label: 'Menganalisis input dan data bisnis',
                      status: liveStage === 'analysis' ? 'running' : 'completed',
                    },
                    ...(liveStage === 'mcp' ? [{ ...saved!.steps[0], status: 'running' }] : []),
                    ...(liveStage === 'compact'
                      ? [{ key: 'compact-test', label: 'Compacting context…', status: 'running' }]
                      : []),
                  ],
                  decision: null,
                }
              : saved,
        }
      if (path.endsWith('/messages')) json = messagesResponse.body()
      if (path.endsWith('/contacts'))
        json = {
          contacts: [
            {
              jid,
              contact_name: 'Audit Test',
              activity: running ? 'Thinking…' : '',
              handling_mode: 'ai',
              goal_status: running ? 'processing' : 'waiting_answer',
            },
          ],
        }
      return route.fulfill({ json })
    })
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.locator('#aiProgress').waitFor({ state: 'visible' })
    assert.include(await page.locator('#aiProgressLabel').innerText(), 'Thinking…')
    assert.equal(await page.locator('#roomActivity').count(), 0)
    assert.equal(await page.locator('#roomGoalStatus:visible').count(), 0)
    await page.locator('#contacts').getByText('Thinking…', { exact: true }).waitFor()
    await page.locator('#aiProgress').click()
    await page.locator('.wa-trace-current-label').getByText('Thinking…', { exact: true }).waitFor({ state: 'attached' })
    assert.equal(await page.locator('.wa-trace-current:visible').count(), 1)
    assert.equal(await page.locator('#aiProgress:visible').count(), 0)
    assert.equal(await page.locator('.wa-trace-activity > .wa-trace-timeline:visible').count(), 1)
    assert.equal(await page.locator('.wa-trace-current .wa-text-glow').count(), 1)
    await page.screenshot({ path: '/private/tmp/whatsapp-process-open-desktop.png' })
    liveStage = 'compact'
    await page
      .locator('.wa-trace-current-label')
      .getByText('Compacting context…', { exact: true })
      .waitFor({ state: 'attached' })
    liveStage = 'mcp'
    await page
      .locator('.wa-trace-current-label')
      .getByText('Store · get_product', { exact: true })
      .waitFor({ state: 'attached' })
    assert.equal(await page.locator('.wa-trace-activity > .wa-trace-timeline:visible').count(), 1)
    await page.locator('.wa-trace-current').click()
    // Graph headers no longer collapse; only individual evidence does.
    await page.locator('.wa-trace-activity > .wa-trace-timeline').waitFor({ state: 'visible' })
    assert.equal(await page.locator('.wa-trace-timeline > li:visible').count(), 2)
    assert.equal(await page.locator('ol.wa-trace-timeline').count(), 0)
    assert.notInclude(
      await page.locator('.wa-trace-activity > .wa-trace-timeline').innerText(),
      'Pemeriksaan kebutuhan bisnis selesai'
    )
    await page.locator('details[data-key="mcp"] summary').click()
    assert.include(await page.locator('#aiTraceContent').innerText(), '100000')
    running = false
    await page
      .locator('#aiTraceContent')
      .getByText('Harga diambil dari Store; warna perlu dikonfirmasi.', { exact: true })
      .waitFor()
    assert.isTrue(
      await page.locator('details[data-key="mcp"]').evaluate((node) => node.hasAttribute('open'))
    )
    assert.equal(await page.locator('.wa-trace-timeline .wa-text-glow').count(), 0)
    await page.locator('details[data-key="goal"] summary').click()
    assert.include(
      await page.locator('details[data-key="goal"]').innerText(),
      'Lengkapi pilihan pelanggan'
    )
    await page.keyboard.press('Escape')
    await page.locator('#aiTraceDialog').waitFor({ state: 'hidden' })
    await page.locator('#aiProgress').waitFor({ state: 'hidden' })
    await page.locator('[data-trace-id]').click()
    await page.locator('#aiTraceDialog').waitFor({ state: 'visible' })
    await page.setViewportSize({ width: 390, height: 640 })
    const bounds = await page.locator('#aiTraceDialog').boundingBox()
    assert.isAtMost(bounds!.width, 390)
    assert.isAtMost(bounds!.height, 640)
    assert.equal(await page.locator('.wa-trace-activity > .wa-trace-timeline:visible').count(), 1)
    failed = true
    await page
      .locator('#aiTraceContent')
      .getByText('Proses AI atau pengiriman gagal.', { exact: true })
      .waitFor()
    assert.equal(await page.locator('.wa-trace-current .wa-text-glow').count(), 0)
    await page.screenshot({ path: '/private/tmp/whatsapp-process-open-mobile.png' })
    await page.locator('.wa-trace-current').click()
    assert.equal(await page.locator('.wa-trace-timeline > li').count(), 2)
    assert.equal(await page.locator('.wa-trace-step details').count(), 1)
    assert.notInclude(
      await page.locator('#aiTraceContent').innerText(),
      'Tidak ada detail tambahan.'
    )
    await page.locator('details[data-key="business-check"] summary').click()
    assert.include(
      await page.locator('#aiTraceContent').innerText(),
      'Proses berakhir tanpa konfirmasi selesai.'
    )
    assert.equal(await page.locator('details[data-key="business-check"] pre').count(), 0)
    const styles = await page
      .locator('.wa-trace-step')
      .first()
      .evaluate((node) => ({
        line: node.ownerDocument.defaultView!.getComputedStyle(node, '::before').width,
        text: node.ownerDocument.defaultView!.getComputedStyle(node).fontSize,
        border: node.ownerDocument.defaultView!.getComputedStyle(node.querySelector('details')!)
          .borderWidth,
        overflow:
          node.ownerDocument.getElementById('aiTraceContent')!.scrollWidth >
          node.ownerDocument.getElementById('aiTraceContent')!.clientWidth,
      }))
    assert.equal(styles.line, '1px')
    assert.equal(styles.text, '11px')
    assert.equal(styles.border, '0px')
    assert.isFalse(styles.overflow)
    await page.screenshot({ path: '/private/tmp/whatsapp-process-timeline-mobile.png' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: '/private/tmp/whatsapp-process-timeline-desktop.png' })
    await page.setViewportSize({ width: 390, height: 640 })
    await page.locator('#aiTraceClose').click()
    const composer = await page.locator('#messageForm').boundingBox()
    assert.isAtMost(composer!.y + composer!.height, 640)
    failureKind = 'legacy'
    await page
      .locator('#aiProgressLabel')
      .getByText('Proses AI belum selesai · Gagal', { exact: true })
      .waitFor()
    assert.notInclude(await page.locator('#aiProgressLabel').innerText(), 'list_records')
    failureKind = 'image'
    await page
      .locator('#aiProgressLabel')
      .getByText('Menyiapkan gambar balasan · Gagal', { exact: true })
      .waitFor()
    await page.locator('#aiProgress').click()
    await page
      .locator('.wa-trace-current-label')
      .getByText('Menyiapkan gambar balasan', { exact: true })
      .waitFor()
    await page.locator('.wa-trace-current').click()
    assert.include(await page.locator('.wa-trace-step.is-completed').innerText(), 'list_records')
    assert.include(
      await page.locator('.wa-trace-step.is-failed').innerText(),
      'Menyiapkan gambar balasan'
    )
    await page.screenshot({ path: '/private/tmp/whatsapp-mcp-image-failure-mobile.png' })
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
})
