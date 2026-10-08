import { test } from '@japa/runner'
import { readFile, stat } from 'node:fs/promises'

// v3.6.70 — tampilan monokrom yang disetujui pemilik: font offline, lapisan mono.css terakhir,
// penanda memuat kawat 3D, aksi chat berupa ikon.
test.group('tampilan monokrom (v3.6.70)', () => {
  test('mono.css dimuat setelah wire.css; wire_loader.js sebelum app.js; font ada di repo', async ({ assert }) => {
    const layout = await readFile('resources/views/components/layout.edge', 'utf8')
    assert.isAbove(layout.indexOf('assets/mono.css'), layout.indexOf('assets/wire.css'))
    assert.isBelow(layout.indexOf('assets/wire_loader.js'), layout.indexOf('assets/app.js'))
    for (const font of ['instrument-sans.woff2', 'jetbrains-mono.woff2', 'OFL-instrument-sans.txt', 'OFL-jetbrains-mono.txt'])
      assert.isAbove((await stat(`public/assets/fonts/${font}`)).size, 1000, font)
    const css = await readFile('public/assets/mono.css', 'utf8')
    assert.include(css, "url('fonts/instrument-sans.woff2')")
    assert.include(css, "url('fonts/jetbrains-mono.woff2')")
    // body sendiri ber-kelas workspace-ui: selektor harus "body.workspace-ui", bukan "body .workspace-ui".
    assert.notInclude(css, 'body .workspace-ui')
  })

  test('penanda memuat: empat bentuk, minimal 20px, versi sederhana di ukuran kecil, hormati reduced motion', async ({ assert }) => {
    const js = await readFile('public/assets/wire_loader.js', 'utf8')
    for (const shape of ['sphere', 'spiral', 'core', 'rings']) {
      assert.include(js, `${shape}: () =>`)
      assert.include(js, `'${shape}-lite': () =>`)
    }
    assert.include(js, 'const MIN = 20')
    assert.include(js, 'prefers-reduced-motion')
    assert.include(js, "'.wa-loading")
  })

  test('chat: ikon untuk Reply/React/Detail proses/Koreksi/Kirim, foto + kanal di daftar, AI membalas = spiral', async ({ assert }) => {
    const app = await readFile('public/assets/app.js', 'utf8')
    assert.notInclude(app, "replyButton.textContent = '↩'")
    assert.notInclude(app, "reactionToggle.textContent = '☺'")
    assert.include(app, "detail.append(icon('why', 13))")
    assert.include(app, "correct.append(icon('edit', 13))")
    assert.include(app, "photo.className = 'wa-contact-photo'")
    assert.include(app, "window.waLoader.make('spiral', 20)")
    const view = await readFile('resources/views/pages/dashboard.edge', 'utf8')
    assert.include(view, 'class="button primary wa-send"')
    assert.include(view, 'data-shape="spiral"')
    assert.include(view, 'data-channel="wa" aria-pressed="false" aria-label="WhatsApp"')
  })

  test('process details: ringkasan + langkah biasa; langkah teknis hanya di Detail teknis (v3.6.71)', async ({ assert }) => {
    const js = await readFile('public/assets/process.js', 'utf8')
    assert.include(js, "tech.dataset.key = 'technical'")
    assert.include(js, 'const TECHNICAL_STEP = /^(?:prompt-size|beta3-trim|beta3-tier')
    assert.include(js, "[/^beta3-rates$/, 'Menghitung ongkir']")
    assert.notInclude(js, "t('Ringkasan dari AI; periksa kecocokannya dengan bukti MCP.')")
    assert.notInclude(js, "t('Hasil relevan diringkas dan data sensitif disamarkan. Bukan penalaran internal mentah.')")
    const view = await readFile('resources/views/partials/process_detail.edge', 'utf8')
    assert.include(view, 'data-i18n="Kenapa AI membalas begini"')
  })

  test('order panel: nomor & status di header, langkah order, item rata kanan, edit lewat ikon (v3.6.71)', async ({ assert }) => {
    const view = await readFile('resources/views/partials/cart.edge', 'utf8')
    assert.include(view, 'id="beta3RoomProgress"')
    assert.include(view, 'id="beta3RoomEdit"')
    assert.notInclude(view, '<summary data-i18n="Ubah detail pesanan">')
    const js = await readFile('public/assets/beta3_room.js', 'utf8')
    assert.include(js, 'function renderProgress(order)')
    assert.include(js, "el('ul', undefined, 'wa-b3-items')")
  })
})
