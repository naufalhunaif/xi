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

  test('orders/contacts/instagram: judul ringan + eyebrow, aksi ikon, foto pelanggan, tanpa baris kelompok (v3.6.72)', async ({ assert }) => {
    const orders = await readFile('resources/views/partials/orders_beta3.edge', 'utf8')
    assert.include(orders, 'id="beta3RecapStart" class="button wa-icon-only"')
    assert.include(orders, 'data-i18n="Tanggal"')
    const ordersJs = await readFile('public/assets/beta3_orders.js', 'utf8')
    assert.notInclude(ordersJs, "el('tr', undefined, 'wa-order-group')")
    assert.include(ordersJs, "'wa-order-photo'")
    const controller = await readFile('app/controllers/beta3_controller.ts', 'utf8')
    assert.include(controller, "select('jid', 'name', 'profile_picture_url')")
    const contacts = await readFile('public/assets/contact_directory.js', 'utf8')
    assert.include(contacts, 'const formatPhone = (value) =>')
    const ig = await readFile('public/assets/instagram_comments.js', 'utf8')
    assert.include(ig, "}, false, 'reply')")
  })

  test('AI & Settings: menu "AI", pola harga sebagai tabel, token/versi di Detail teknis, tombol tambah berupa ikon (v3.6.73)', async ({ assert }) => {
    const nav = await readFile('resources/views/pages/dashboard.edge', 'utf8')
    assert.include(nav, '<span class="nav-text">AI</span>')
    assert.notInclude(nav, '<span class="nav-text">Beta 3</span>')
    const page = await readFile('resources/views/partials/beta3.edge', 'utf8')
    assert.include(page, 'id="beta3PriceTable"')
    assert.include(page, 'id="beta3CatalogTech"')
    const js = await readFile('public/assets/beta3.js', 'utf8')
    assert.include(js, 'function renderPriceTable(series)')
    assert.notInclude(js, "button.textContent = t('Menyinkronkan…')")
    const controller = await readFile('app/controllers/beta3_controller.ts', 'utf8')
    assert.include(controller, 'priceTable: prices.series')
    for (const file of ['resources/views/partials/settings/ai.edge', 'resources/views/partials/settings/payments.edge', 'resources/views/partials/settings/business.edge'])
      assert.include(await readFile(file, 'utf8'), 'class="button wa-add-button"', file)
  })

  test('halaman masuk pakai font offline; ponsel: tabel order/kontak tanpa kolom panjang (v3.6.74)', async ({ assert }) => {
    const auth = await readFile('public/assets/auth.css', 'utf8')
    assert.include(auth, 'url("fonts/instrument-sans.woff2")')
    assert.include(auth, 'url("fonts/jetbrains-mono.woff2")')
    const css = await readFile('public/assets/mono.css', 'utf8')
    assert.include(css, '.wa-orders-page .wa-order-table td:nth-child(6)')
    assert.include(css, '.wa-directory-table td:nth-child(3)')
  })

  test('dialog terbuka: halaman belakang dikunci dan posisi gulir dikembalikan (v3.6.75)', async ({ assert }) => {
    const motion = await readFile('public/assets/motion.js', 'utf8')
    assert.include(motion, "root.classList.add('wa-modal-open')")
    assert.include(motion, "attributeFilter: ['open']")
    const css = await readFile('public/assets/mono.css', 'utf8')
    assert.include(css, 'html.wa-modal-open body.workspace-ui #messages')
    assert.include(css, 'overscroll-behavior: contain')
    const process = await readFile('public/assets/process.js', 'utf8')
    assert.include(process, 'lastTrigger.focus({ preventScroll: true })')
    assert.notInclude(process, 'lastTrigger.focus()')
  })
})
