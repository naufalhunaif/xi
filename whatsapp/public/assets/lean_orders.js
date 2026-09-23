;(() => {
  const root = document.getElementById('leanOrdersPage')
  if (!root) return
  const byId = (id) => document.getElementById(id)
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const notice = (message, error = false) => {
    byId('leanOrdersNotice').textContent = message || ''
    byId('leanOrdersNotice').classList.toggle('error', Boolean(error))
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
  const drawer = byId('leanOrderDrawer')

  async function load() {
    const q = byId('leanOrdersSearch').value.trim()
    try {
      const result = await api(`/api/lean/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`)
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
    const list = byId('leanOrdersList')
    list.replaceChildren()
    byId('leanOrdersCount').textContent = byId('leanOrdersSearch').value.trim() ? t('{0} order cocok', orders.length) : t('{0} order', orders.length)
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
      head.append(el('strong', order.order_number || `#${order.id}`), el('br'), el('small', when(order.created_at), 'wa-muted'))
      const who = el('td')
      who.append(el('span', order.customer_name || '-'), el('br'), el('small', [order.district, order.regency].filter(Boolean).join(', '), 'wa-muted'))
      const items = el('td', String(order.spec || order.items || '').split('\n').slice(0, 2).join(' · ').slice(0, 120))
      const total = el('td', order.total ? money(order.total) : '—', 'wa-order-amount')
      const state = el('td')
      const badge = el('span', statusLabel[order.status] || order.status, 'wa-order-badge')
      badge.dataset.tone = statusTone[order.status] || ''
      state.append(badge)
      if (order.status === 'pending' && order.auto_total_reason) state.append(el('br'), el('small', order.auto_total_reason, 'wa-muted'))
      if (groupLabel[order.group_status]) state.append(el('br'), el('small', groupLabel[order.group_status], 'wa-muted'))
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
    for (const row of byId('leanOrdersList').querySelectorAll('[data-order-id]'))
      row.dataset.selected = String(Number(row.dataset.orderId) === selected)
    renderDetail(order)
    if (!drawer.open) {
      if (window.waMotion) window.waMotion.showDialog(drawer)
      else drawer.showModal()
    }
    byId('leanOrderDrawerClose').focus()
  }
  function closeOrder() {
    if (window.waMotion) window.waMotion.closeDialog(drawer)
    else drawer.close()
    selected = null
    render()
  }
  byId('leanOrderDrawerClose').addEventListener('click', closeOrder)
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) closeOrder()
  })
  drawer.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeOrder()
  })

  function field(label, node) {
    const wrap = el('label')
    wrap.append(el('span', label), node)
    return wrap
  }
  function renderDetail(order) {
    const box = byId('leanOrderDetail')
    box.replaceChildren()
    byId('leanOrderDrawerTitle').textContent = `${order.order_number || `#${order.id}`} · ${statusLabel[order.status] || order.status}`
    const info = el('dl', undefined, 'wa-cart-summary')
    for (const [label, value] of [
      [t('Pelanggan'), order.customer_name || '-'],
      [t('Telepon'), order.phone || '-'],
      [t('Alamat'), [order.address, order.district, order.regency, order.postal_code].filter(Boolean).join(', ')],
      [t('Dibuat'), when(order.created_at)],
      [t('Catatan pelanggan'), order.note || ''],
    ]) {
      if (!value) continue
      const row = el('div')
      row.append(el('dt', label), el('dd', value))
      info.append(row)
    }
    box.append(info)
    box.append(el('h2', t('Pesanan')))
    box.append(el('pre', String(order.spec || order.items || '—'), 'wa-lean-chatnote'))
    if (order.chat_note) {
      box.append(el('h2', t('Catatan chat saat form masuk')))
      box.append(el('pre', order.chat_note, 'wa-lean-chatnote'))
    }
    const summary = el('dl', undefined, 'wa-cart-summary')
    for (const [label, amount, cls] of [
      [t('Subtotal'), order.subtotal, ''],
      [`${t('Ongkir')}${order.shipping_service ? ` (${order.shipping_service})` : ''}`, order.shipping_cost, ''],
      [t('Total'), order.total, 'wa-cart-total'],
    ]) {
      const row = el('div', undefined, cls)
      row.append(el('dt', label), el('dd', amount === null || amount === undefined ? '—' : money(amount)))
      summary.append(row)
    }
    box.append(summary)
    if (order.cs_note) box.append(el('p', `${t('Catatan CS')}: ${order.cs_note}`, 'wa-muted'))

    const actions = el('div', undefined, 'actions')
    if (order.status === 'pending') {
      let options = []
      try {
        options = JSON.parse(order.shipping_options || 'null')?.prices || []
      } catch {}
      const priced = options.filter((row) => Number(row.price) > 0)
      if (order.auto_total_reason) box.append(el('p', `${t('Total otomatis gagal')}: ${order.auto_total_reason}`, 'wa-order-shipping-wait'))
      const form = el('form', undefined, 'wa-order-fields')
      const items = el('textarea')
      items.rows = 3
      items.value = order.spec || order.items || ''
      items.placeholder = t('Rincian barang untuk pesan total, mis. Tuxedo Brown 485.000')
      const subtotal = el('input')
      subtotal.type = 'number'
      subtotal.required = true
      subtotal.placeholder = t('Subtotal barang (Rp)')
      const service = el('input')
      service.type = 'text'
      service.placeholder = t('Layanan (REG / YES / one day)')
      const shipping = el('input')
      shipping.type = 'number'
      shipping.required = true
      shipping.placeholder = t('Ongkir (Rp)')
      form.append(field(t('Rincian'), items), field(t('Subtotal barang (Rp)'), subtotal))
      if (priced.length) {
        const picks = el('div', undefined, 'actions')
        for (const row of priced) {
          const name = String(row.service).replace(/\d+$/, '')
          picks.append(
            button(`${name} ${money(row.price)}${row.etd ? ` (${String(row.etd).replace('day', t('hari'))})` : ''}`, () => {
              service.value = name
              shipping.value = Math.round(row.price)
            })
          )
        }
        form.append(field(t('Ongkir tersedia'), picks))
      }
      form.append(field(t('Layanan'), service), field(t('Ongkir (Rp)'), shipping))
      const submit = button(t('Kirim total + rekening'), () => {}, true)
      submit.type = 'submit'
      const cancel = button(t('Batalkan order'), async () => {
        if (!confirm(t('Batalkan order ini?'))) return
        try {
          await api(`/api/lean/orders/${order.id}/cancel`, 'POST', {})
          notice(t('Order dibatalkan.'))
          closeOrder()
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      const row = el('div', undefined, 'actions')
      row.append(submit, cancel)
      form.append(row)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        submit.disabled = true
        try {
          await api(`/api/lean/orders/${order.id}/approve`, 'POST', {
            itemsText: items.value,
            subtotal: subtotal.value,
            shippingService: service.value,
            shippingCost: shipping.value,
          })
          notice(t('Total dan rekening dikirim untuk order #{0}.', order.id))
          await load()
        } catch (error) {
          notice(error.message, true)
        } finally {
          submit.disabled = false
        }
      })
      box.append(form)
    } else if (order.status === 'awaiting_payment') {
      actions.append(
        button(t('Dana masuk · Lunas'), async () => {
          try {
            await api(`/api/lean/orders/${order.id}/paid`, 'POST', {})
            notice(t('Order #{0} lunas, pelanggan dikabari.', order.id))
            await load()
          } catch (error) {
            notice(error.message, true)
          }
        }, true)
      )
    } else if (order.status === 'paid') {
      actions.append(
        button(order.group_status === 'sent' ? t('Kirim ulang ke grup') : t('Kirim ke grup'), async () => {
          try {
            await api(`/api/lean/orders/${order.id}/resend-group`, 'POST', {})
            notice(t('Order {0} diantrekan ke grup produksi.', order.order_number || `#${order.id}`))
            await load()
          } catch (error) {
            notice(error.message, true)
          }
        })
      )
    }
    if (order.jid) {
      const chat = el('a', t('Buka chat'), 'button')
      chat.href = `${base}/?jid=${encodeURIComponent(order.jid)}`
      actions.append(chat)
    }
    if (actions.childElementCount) box.append(actions)
  }

  byId('leanOrdersRefresh').addEventListener('click', load)
  byId('leanOrdersSearch').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(load, 250)
  })
  for (const tab of byId('leanOrdersTabs').querySelectorAll('[data-status]')) {
    tab.addEventListener('click', () => {
      status = tab.dataset.status
      for (const other of byId('leanOrdersTabs').querySelectorAll('[data-status]'))
        other.setAttribute('aria-pressed', String(other === tab))
      load()
    })
  }
  load()
  setInterval(() => {
    if (document.visibilityState === 'visible') load()
  }, 30_000)
})()
