;(() => {
  const root = document.getElementById('beta3OrdersPage')
  if (!root) return
  const byId = (id) => document.getElementById(id)
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const notice = (message, error = false) => {
    byId('beta3OrdersNotice').textContent = message || ''
    byId('beta3OrdersNotice').classList.toggle('error', Boolean(error))
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.redirected) throw new Error(t('Sesi berakhir. Muat ulang halaman.'))
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const button = (label, action, primary = false) => {
    const node = el('button', label, primary ? 'button primary' : 'button')
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }
  const statusLabel = {
    pending: t('Menunggu total'),
    awaiting_payment: t('Menunggu pembayaran'),
    paid: t('Lunas'),
    cancelled: t('Dibatalkan'),
  }
  const statusTone = { pending: 'waiting', awaiting_payment: 'waiting', paid: 'done', cancelled: 'muted' }
  const groupLabel = { pending: t('grup: antre'), sent: t('grup: terkirim'), failed: t('grup: gagal') }
  const when = (value) =>
    value
      ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
      : ''

  let status = 'all'
  let orders = []
  let selected = null
  let searchTimer
  const drawer = byId('beta3OrderDrawer')

  async function load() {
    const q = byId('beta3OrdersSearch').value.trim()
    try {
      const result = await api(`/api/beta3/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`)
      orders = result.orders || []
      for (const [key, value] of Object.entries(result.counts || {})) {
        const badge = root.querySelector(`[data-count="${key}"]`)
        if (badge) badge.textContent = String(value)
      }
      render()
      if (selected) {
        const fresh = orders.find((order) => order.id === selected)
        if (fresh) renderDetail(fresh)
      }
    } catch (error) {
      notice(error.message, true)
    }
  }
  function render() {
    const list = byId('beta3OrdersList')
    list.replaceChildren()
    byId('beta3OrdersCount').textContent = byId('beta3OrdersSearch').value.trim() ? t('{0} order cocok', orders.length) : t('{0} order', orders.length)
    if (!orders.length) {
      const row = el('tr')
      const cell = el('td', t('Tidak ada order.'), 'wa-order-empty')
      cell.colSpan = 5
      row.append(cell)
      list.append(row)
      return
    }
    for (const order of orders) {
      const row = el('tr')
      row.dataset.orderId = order.id
      row.dataset.selected = String(order.id === selected)
      row.tabIndex = 0
      const head = el('td')
      head.append(el('span', when(order.created_at)), el('br'), el('small', order.order_number || `#${order.id}`, 'wa-muted'))
      const who = el('td')
      who.append(el('span', order.customer_name || '-'), el('br'), el('small', order.regency || order.district || '', 'wa-muted'))
      const items = el('td')
      // Satu baris ringkas dari teks pesanan: produk · jas/celana · size.
      const summary = String(order.text || order.spec || order.items || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' · ')
      items.append(el('span', summary.slice(0, 140), 'wa-order-items'))
      const total = el('td', order.total ? money(order.total) : '—', 'wa-order-amount')
      const state = el('td')
      const badge = el('span', statusLabel[order.status] || order.status, 'wa-order-badge')
      badge.dataset.tone = statusTone[order.status] || ''
      state.append(badge)
      if (order.status === 'pending' && order.auto_total_reason) state.append(el('br'), el('small', order.auto_total_reason, 'wa-muted'))
      if (groupLabel[order.group_status]) state.append(el('br'), el('small', groupLabel[order.group_status], 'wa-muted'))
      if (order.source === 'rekap') state.append(el('br'), el('small', t('Rekap dari chat'), 'wa-order-source'))
      row.append(head, who, items, total, state)
      const open = () => openOrder(order)
      row.addEventListener('click', open)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
      list.append(row)
    }
  }
  function openOrder(order) {
    selected = order.id
    for (const row of byId('beta3OrdersList').querySelectorAll('[data-order-id]'))
      row.dataset.selected = String(Number(row.dataset.orderId) === selected)
    renderDetail(order)
    if (!drawer.open) {
      if (window.waMotion) window.waMotion.showDialog(drawer)
      else drawer.showModal()
    }
    byId('beta3OrderDrawerClose').focus()
  }
  function closeOrder() {
    if (window.waMotion) window.waMotion.closeDialog(drawer)
    else drawer.close()
    selected = null
    render()
  }
  // Rekap order lama: dikerjakan worker satu chat per menit; progres dipantau di sini.
  let recapTimer
  function showRecap(progress) {
    clearTimeout(recapTimer)
    if (!progress) return
    if (progress.running) {
      notice(t('Rekap berjalan: {0}/{1} chat dibaca, {2} order dicatat. Tidak ada pesan ke pelanggan.', progress.done, progress.total || '…', progress.created))
      byId('beta3RecapStart').disabled = true
      recapTimer = setTimeout(checkRecap, 15000)
    } else {
      byId('beta3RecapStart').disabled = false
      if (progress.finishedAt && Date.now() - progress.finishedAt < 10 * 60_000)
        notice(t('Rekap selesai: {0} chat dibaca, {1} order dicatat.', progress.done, progress.created))
    }
  }
  async function checkRecap() {
    try {
      const result = await api('/api/beta3/recap')
      const before = byId('beta3RecapStart').disabled
      showRecap(result.progress)
      if (before && !result.progress?.running) load()
      else if (result.progress?.running) load()
    } catch {}
  }
  byId('beta3RecapStart').addEventListener('click', async () => {
    try {
      const result = await api('/api/beta3/recap', 'POST', { days: Number(byId('beta3RecapDays').value) })
      showRecap(result.progress)
    } catch (error) {
      notice(error.message, true)
    }
  })
  checkRecap()

  byId('beta3OrderDrawerClose').addEventListener('click', closeOrder)
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) closeOrder()
  })
  drawer.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeOrder()
  })

  function renderDetail(order) {
    const box = byId('beta3OrderDetail')
    box.replaceChildren()
    byId('beta3OrderDrawerTitle').textContent = `${order.customer_name || '-'} · ${statusLabel[order.status] || order.status}`
    if (Array.isArray(order.photos) && order.photos.length) {
      const photos = el('div', undefined, 'wa-order-photos')
      for (const photo of order.photos) {
        const figure = el('figure')
        const img = el('img')
        img.src = photo.url
        img.alt = `${photo.product} ${photo.color}`.trim()
        img.loading = 'lazy'
        img.addEventListener('error', () => figure.remove())
        figure.append(img)
        photos.append(figure)
      }
      box.append(photos)
    }
    box.append(el('pre', String(order.text || order.spec || order.items || '—'), 'wa-b3-spec'))
    const address = [order.address, order.district, order.regency, order.postal_code]
      .filter(Boolean)
      .filter((part, index, all) => index === 0 || !String(all[0]).toLowerCase().includes(String(part).toLowerCase()))
      .join(', ')
    const to = [order.phone, address].filter(Boolean).join(' · ')
    if (to) box.append(el('p', `${t('Kirim ke')}: ${to}`, 'wa-muted'))
    if (order.total) {
      const summary = el('dl', undefined, 'wa-cart-summary')
      for (const [label, amount, cls] of [
        [t('Subtotal'), order.subtotal],
        [`${t('Ongkir')}${order.shipping_service ? ` ${order.shipping_service}` : ''}`, order.shipping_cost],
        [t('Total'), order.total, 'wa-cart-total'],
      ]) {
        if (amount === null || amount === undefined) continue
        const row = el('div', undefined, cls || '')
        row.append(el('dt', label), el('dd', money(amount)))
        summary.append(row)
      }
      box.append(summary)
    }
    const actions = el('div', undefined, 'actions')
    const act = (label, path, done, primary = true) =>
      button(label, async () => {
        if (path.endsWith('/cancel') && !confirm(t('Batalkan order ini?'))) return
        try {
          await api(path, 'POST', {})
          notice(done)
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      }, primary)
    if (order.status === 'pending') {
      if (order.auto_total_reason) box.append(el('p', `${t('Total belum otomatis')}: ${order.auto_total_reason}`, 'wa-muted'))
      let options = []
      try {
        options = (JSON.parse(order.shipping_options || 'null')?.prices || []).filter((row) => Number(row.price) > 0)
      } catch {}
      const form = el('form', undefined, 'wa-cart-form')
      const subtotal = el('input'); subtotal.inputMode = 'numeric'; subtotal.required = true; subtotal.placeholder = t('Harga barang (Rp)')
      const shipping = el('select')
      for (const row of options) {
        const name = String(row.service).replace(/\d+$/, '')
        const option = new Option(`${name} ${money(row.price)}`, name)
        option.dataset.cost = String(row.price)
        shipping.append(option)
      }
      const manual = el('input'); manual.inputMode = 'numeric'; manual.placeholder = t('Ongkir (Rp)')
      const submit = el('button', t('Kirim total + rekening'), 'button primary'); submit.type = 'submit'
      form.append(subtotal, options.length ? shipping : manual, submit)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        submit.disabled = true
        try {
          await api(`/api/beta3/orders/${order.id}/approve`, 'POST', {
            itemsText: order.spec || order.items,
            subtotal: subtotal.value,
            shippingService: options.length ? shipping.value : '',
            shippingCost: options.length ? shipping.selectedOptions[0]?.dataset.cost : manual.value,
          })
          notice(t('Total dan rekening dikirim ke pelanggan.'))
          await load()
        } catch (error) {
          notice(error.message, true)
        } finally {
          submit.disabled = false
        }
      })
      box.append(form)
      actions.append(act(t('Batalkan'), `/api/beta3/orders/${order.id}/cancel`, t('Order dibatalkan.'), false))
    } else if (order.status === 'awaiting_payment') {
      actions.append(act(t('Dana masuk · Lunas'), `/api/beta3/orders/${order.id}/paid`, t('Lunas. Pesanan dikirim ke grup produksi.')))
      actions.append(act(t('Batalkan'), `/api/beta3/orders/${order.id}/cancel`, t('Order dibatalkan.'), false))
    } else if (order.status === 'paid') {
      actions.append(
        act(order.group_status === 'sent' ? t('Kirim ulang ke grup') : t('Kirim ke grup'), `/api/beta3/orders/${order.id}/resend-group`, t('Diantrekan ke grup produksi.'), false)
      )
      if (order.group_error) box.append(el('p', `${t('Grup gagal')}: ${order.group_error}`, 'error'))
    }
    if (actions.childElementCount) box.append(actions)
  }
  byId('beta3OrdersRefresh').addEventListener('click', load)
  byId('beta3OrdersSearch').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(load, 250)
  })
  for (const tab of byId('beta3OrdersTabs').querySelectorAll('[data-status]')) {
    tab.addEventListener('click', () => {
      status = tab.dataset.status
      for (const other of byId('beta3OrdersTabs').querySelectorAll('[data-status]'))
        other.setAttribute('aria-pressed', String(other === tab))
      load()
    })
  }
  load()
  setInterval(() => {
    if (document.visibilityState === 'visible') load()
  }, 30_000)
})()
