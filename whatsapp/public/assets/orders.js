;(() => {
  const root = document.getElementById('orderPage')
  if (!root) return
  const t = (key, ...args) =>
    window.waI18n?.t(key, ...args) ?? key.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) =>
    new Intl.NumberFormat(window.waI18n?.locale || 'en-US', {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0,
    }).format(n)
  const stages = {
    unverified: 'Belum diperbarui',
    awaiting_details: 'Menunggu detail',
    queued: 'Antre produksi',
    production: 'Produksi',
    qc: 'QC',
    ready: 'Siap kirim',
    shipped: 'Dikirim',
    completed: 'Selesai',
    cancelled: 'Dibatalkan',
  }
  const deliveries = {
    not_queued: 'Belum diantrekan',
    queued: 'Dalam antrean',
    sending: 'Mengirim',
    sent: 'Terkirim',
    failed: 'Gagal sebelum kirim',
    uncertain: 'Periksa hasil kirim',
    cancelled: 'Dibatalkan',
  }
  const node = (tag, text = '', cls = '') => {
    const el = document.createElement(tag)
    el.textContent = text
    el.className = cls
    return el
  }
  const button = (title, action) => {
    const el = node('button', t(title), 'button')
    el.type = 'button'
    el.addEventListener('click', action)
    return el
  }
  let routing,
    data,
    orderTab = 'active',
    selected = null,
    page = 1,
    dirty = false,
    busy = false,
    searchTimer,
    loading = false,
    refreshingProgress = false,
    loadRevision = 0,
    progressRetryAt = 0,
    progressFailures = 0
  let routingDirty = false,
    routingBusy = false
  const drawer = byId('orderDrawer')
  const routingDialog = byId('orderRoutingDialog')
  const routingForm = byId('orderRoutingForm')
  function routingNotice(message = '', error = false) {
    byId('orderRoutingNotice').textContent = message
    byId('orderRoutingNotice').classList.toggle('error', error)
  }
  function closeRouting() {
    if (routingBusy) return
    if (routingDirty && !confirm(t('Muat ulang dan buang perubahan yang belum tersimpan?'))) return
    routingDirty = false
    if (!byId('orderRoutingInfo').hidden)
      byId('orderRoutingInfo').querySelector('[data-info-close]').click()
    if (window.waMotion) window.waMotion.closeDialog(routingDialog)
    else routingDialog.close()
  }
  byId('orderRoutingOpen').addEventListener('click', () => {
    if (routing) {
      groups(byId('orderDefaultGroup'), routing.groupJid)
      byId('orderDefaultTrigger').value = routing.paymentTrigger
      routingStatus()
    }
    routingNotice()
    byId('orderRoutingOpen').setAttribute('aria-expanded', 'true')
    if (window.waMotion) window.waMotion.showDialog(routingDialog)
    else routingDialog.showModal()
    byId('orderRoutingClose').focus()
  })
  byId('orderRoutingClose').addEventListener('click', closeRouting)
  routingForm.addEventListener('input', () => {
    routingDirty = true
  })
  routingDialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeRouting()
  })
  routingDialog.addEventListener('click', (event) => {
    if (event.target !== routingDialog) return
    const rect = routingDialog.getBoundingClientRect()
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeRouting()
  })
  routingDialog.addEventListener('close', () => {
    byId('orderRoutingOpen').setAttribute('aria-expanded', 'false')
    byId('orderRoutingOpen').focus({ preventScroll: true })
  })
  let returnOrderId = null
  function openOrder(order) {
    selected = order.id
    returnOrderId = order.id
    renderOrder(order)
    for (const row of byId('orderList').querySelectorAll('[data-order-id]'))
      row.dataset.selected = String(Number(row.dataset.orderId) === selected)
    if (drawer.open) return
    drawer.insertBefore(byId('orderPageNotice'), byId('orderDetail'))
    if (window.waMotion) window.waMotion.showDialog(drawer)
    else drawer.showModal()
    byId('orderDrawerClose').focus()
  }
  function closeOrder() {
    if (busy) return
    if (dirty && !confirm(t('Muat ulang dan buang perubahan yang belum tersimpan?'))) return
    dirty = false
    if (window.waMotion) window.waMotion.closeDialog(drawer)
    else drawer.close()
  }
  byId('orderDrawerClose').addEventListener('click', closeOrder)
  drawer.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeOrder()
  })
  // Keep Tab at the sheet boundaries; the separate media dialog handles its own focus.
  function trapTab(event) {
    if (event.key !== 'Tab') return
    const controls = [
      ...event.currentTarget.querySelectorAll(
        'button, a[href], input, select, textarea, summary, [tabindex]'
      ),
    ].filter(
      (element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length
    )
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
  drawer.addEventListener('keydown', trapTab)
  routingDialog.addEventListener('keydown', trapTab)
  drawer.addEventListener('click', (event) => {
    if (event.target !== drawer) return
    const bounds = drawer.getBoundingClientRect()
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      closeOrder()
  })
  drawer.addEventListener('close', () => {
    selected = null
    root.insertBefore(byId('orderPageNotice'), root.querySelector('.wa-order-workspace'))
    for (const row of byId('orderList').querySelectorAll('[data-order-id]'))
      row.dataset.selected = 'false'
    const trigger = byId('orderList').querySelector(`[data-order-id="${returnOrderId}"] button`)
    ;(trigger || byId('orderSearch')).focus({ preventScroll: true })
  })
  function rowCells(row, order) {
    row.replaceChildren()
    const number = node('td')
    const open = button('', () =>
      openOrder(data.orders.find((item) => item.id === order.id) || order)
    )
    open.textContent = order.number
    open.className = 'wa-order-open'
    open.setAttribute('aria-label', `${t('Detail order')} · ${order.number}`)
    open.setAttribute('aria-haspopup', 'dialog')
    open.setAttribute('aria-controls', 'orderDrawer')
    number.append(open)
    const payment = node('td')
    const paid = order.paid >= order.total
    const paymentBadge = node(
      'span',
      t(paid ? 'Lunas' : order.paid > 0 ? 'DP' : 'Belum lunas'),
      'wa-order-badge'
    )
    paymentBadge.dataset.tone = paid ? 'success' : 'waiting'
    payment.append(paymentBadge)
    const production = node('td')
    const stage = order.status === 'cancelled' ? 'cancelled' : order.operations.stage
    const stageBadge = node('span', t(stages[stage] || 'Belum diperbarui'), 'wa-order-badge')
    stageBadge.dataset.tone = ['ready', 'shipped', 'completed'].includes(stage)
      ? 'success'
      : ['production', 'qc'].includes(stage)
        ? 'active'
        : 'neutral'
    production.append(stageBadge)
    row.append(
      number,
      node('td', order.cart.recipient.name, 'wa-order-customer'),
      node('td', money(order.total), 'wa-order-amount'),
      payment,
      production
    )
  }
  function notice(message = '', error = false) {
    byId('orderPageNotice').textContent = message
    byId('orderPageNotice').classList.toggle('error', error)
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.redirected)
      throw new Error(t('Sesi berakhir. Muat ulang halaman untuk masuk kembali.'))
    const result = await response.json()
    if (!response.ok) throw new Error(t(result.error || 'Permintaan gagal.'))
    return result
  }
  function options(select, items, value) {
    select.replaceChildren()
    for (const [key, title] of items) {
      const option = node('option', title)
      option.value = key
      select.append(option)
    }
    select.value = value || ''
  }
  function groups(select, value) {
    const list = [['', t('Tidak ada grup')], ...(routing?.groups || []).map((g) => [g.jid, g.name])]
    if (value && !list.some(([id]) => id === value)) list.push([value, t('Grup tidak tersedia')])
    options(select, list, value)
  }
  async function loadRouting() {
    routing = await api('/api/orders/routing')
    groups(
      byId('orderDefaultGroup'),
      routingDirty ? byId('orderDefaultGroup').value : routing.groupJid
    )
    if (!routingDirty) byId('orderDefaultTrigger').value = routing.paymentTrigger
    routingStatus()
    const current = byId('orderDestinationGroup')
    if (current) groups(current, current.value)
  }
  function routingStatus() {
    byId('orderGroupsStatus').textContent = routing.refreshRequested
      ? t('Menunggu sinkronisasi grup…')
      : routing.groups.length
        ? t('{0} grup tersedia', routing.groups.length)
        : t('Hubungkan nomor lalu perbarui grup.')
  }
  function field(form, title, name, value, type = 'text', choices) {
    const label = node('label')
    label.append(node('span', t(title)))
    const input = node(choices ? 'select' : type === 'textarea' ? 'textarea' : 'input')
    input.name = name
    if (choices)
      options(
        input,
        choices.map(([key, text]) => [key, t(text)]),
        value
      )
    else {
      if (type !== 'textarea') input.type = type
      input.value = value || ''
    }
    label.append(input)
    form.append(label)
    return input
  }
  function productionBox(order) {
    const box = node('section', '', 'wa-order-production-box')
    const op = order.operations
    const progress = node('div', '', 'wa-order-progress')
    const current = node('div')
    current.append(
      node('h3', t('Produksi')),
      node('strong', t(stages[op.stage] || 'Belum diperbarui'), 'wa-order-progress-stage')
    )
    progress.append(current)
    const next =
      order.nextProductionStage ??
      (['unverified', 'awaiting_details'].includes(op.stage)
        ? 'queued'
        : op.stage === 'queued'
          ? op.kind === 'standard'
            ? 'ready'
            : 'production'
          : ['production', 'qc'].includes(op.stage)
            ? 'ready'
            : null)
    if (order.status === 'active' && next) {
      const advance = button(
        next === 'queued'
          ? 'Masukkan antrean'
          : next === 'production'
            ? 'Mulai produksi'
            : 'Siap kirim',
        () =>
          mutate(async () => {
            await api(`/api/orders/${order.id}/operations`, 'PUT', {
              version: order.version,
              advance: true,
            })
          })
      )
      advance.id = 'orderAdvance'
      advance.classList.add('primary')
      progress.append(advance)
    }
    box.append(progress)
    if (order.operationsUpdatedAt)
      box.append(
        node(
          'small',
          `${t('Diperbarui')}: ${new Date(order.operationsUpdatedAt).toLocaleString(window.waI18n?.locale)} · ${op.source === 'orion' ? 'Orion' : t(op.source === 'operator' ? 'Operator' : 'Pembayaran terverifikasi')}`,
          'wa-muted'
        )
      )
    if (op.estimate)
      box.append(
        node(
          'p',
          `${t('Estimasi tersimpan')}: ${op.estimate.estimateDays} ${t(op.estimate.dayType === 'working' ? 'Hari kerja' : 'Hari kalender')}${op.eligibleAt ? ` · ${new Date(op.eligibleAt).toLocaleDateString(window.waI18n?.locale)}` : ''}`,
          'wa-muted'
        )
      )
    else
      box.append(
        node(
          'p',
          t(op.kind === 'standard' ? 'Ready stock' : 'Estimasi belum ditetapkan'),
          'wa-muted'
        )
      )
    if (op.expectedReadyOn)
      box.append(node('small', `${t('Estimasi siap kirim')}: ${op.expectedReadyOn}`, 'wa-muted'))
    const shipping = window.waShippingProgress?.(order)
    if (shipping) {
      shipping.classList.add('wa-order-shipping-wait')
      box.append(shipping)
    }
    if (op.trackingNumber)
      box.append(
        node(
          'p',
          `${t('Resi')}: ${op.trackingNumber}${op.carrier ? ` · ${op.carrier}` : ''}`,
          'wa-muted'
        )
      )
    return box
  }
  function renderOrder(order) {
    const detail = byId('orderDetail')
    detail.replaceChildren()
    const heading = node('div', '', 'wa-order-editor-heading')
    const number = node('div', '', 'wa-order-number')
    number.append(node('h2', order.number))
    const copy = button('', async () => {
      try {
        await navigator.clipboard.writeText(order.number)
        copy.title = t('Nomor order disalin')
      } catch {
        notice(order.number)
      }
    })
    copy.className = 'wa-order-copy'
    copy.title = t('Salin nomor order {0}', order.number)
    copy.setAttribute('aria-label', copy.title)
    copy.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>'
    number.append(copy)
    heading.append(number)
    const chat = node('a', t('Buka chat'))
    chat.href = `${base}/?jid=${encodeURIComponent(order.jid)}`
    heading.append(chat)
    detail.append(heading)
    detail.append(
      node('p', order.cart.recipient.name),
      node(
        'small',
        `${t('Total')}: ${money(order.total)} · ${t('Dibayar')}: ${money(order.paid)} · ${t('Sisa pembayaran')}: ${money(Math.max(0, order.total - order.paid))}`,
        'wa-muted'
      )
    )
    for (const item of order.cart.items) {
      const row = node('div', '', 'wa-order-product wa-cart-item')
      if (item.image) {
        const image = node('img')
        image.src = item.image
        image.alt = item.name
        image.loading = 'lazy'
        image.referrerPolicy = 'no-referrer'
        row.append(image)
      } else row.append(node('span'))
      const text = node('div')
      text.append(
        node('p', item.name),
        node(
          'p',
          `${item.quantity} pcs · ${item.size}${item.requestedSize ? ` ${item.requestedSize}` : ''}`
        )
      )
      const measurements = Object.entries(item.measurements || {})
        .map(([k, v]) => `${k}: ${v} cm`)
        .join('\n')
      if (measurements) text.append(node('p', measurements))
      if (item.note) text.append(node('p', item.note))
      window.waOrderItemDetails?.(text, item)
      row.append(text)
      detail.append(row)
    }
    detail.append(productionBox(order))
    const destination = node('section', '', 'wa-order-group-box')
    destination.append(
      node('h3', t('Grup produksi')),
      node('p', t(deliveries[order.dispatch] || order.dispatch), 'wa-muted')
    )
    const groupForm = node('form', '', 'wa-order-fields')
    groupForm.id = 'orderDestinationForm'
    const group = field(groupForm, 'Grup', 'groupJid', order.groupJid, 'text', [])
    group.id = 'orderDestinationGroup'
    groups(group, order.groupJid)
    field(groupForm, 'Kirim setelah', 'paymentTrigger', order.paymentTrigger, 'text', [
      ['first_payment', 'Pembayaran pertama / DP'],
      ['fully_paid', 'Lunas'],
    ])
    const routeActions = node('div', '', 'actions')
    const assign = node('button', t('Tetapkan grup'), 'button')
    assign.type = 'submit'
    routeActions.append(assign)
    groupForm.append(routeActions)
    groupForm.addEventListener('input', () => {
      dirty = true
    })
    groupForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (
        group.value &&
        !confirm(
          t(
            'Kirim detail order ke {0} setelah syarat pembayaran terpenuhi? Tanpa alamat dan nomor telepon.',
            group.selectedOptions[0].textContent
          )
        )
      )
        return
      await mutate(async () => {
        await api(`/api/orders/${order.id}/operations`, 'PUT', {
          version: data.orders.find((current) => current.id === order.id)?.version || order.version,
          ...Object.fromEntries(new FormData(groupForm)),
        })
      })
    })
    if (order.dispatch !== 'not_queued' || order.status === 'cancelled')
      for (const control of groupForm.elements) control.disabled = true
    destination.append(groupForm)
    if (order.dispatch === 'uncertain')
      destination.append(
        button('Sudah ada di grup', async () => {
          if (
            !confirm(
              t('Bagian terakhir sudah terlihat di grup? Tandai terkirim tanpa mengirim ulang.')
            )
          )
            return
          await mutate(() =>
            api(`/api/orders/${order.id}/acknowledge-group`, 'POST', { reviewed: true })
          )
        })
      )
    if (['failed', 'uncertain'].includes(order.dispatch))
      destination.append(
        button('Coba kirim lagi', async () => {
          const reviewed = order.dispatch === 'uncertain'
          if (
            !confirm(
              t(
                reviewed
                  ? 'Pastikan bagian terakhir belum terkirim di grup. Mencoba ulang dapat menduplikasi pesan. Lanjutkan?'
                  : 'Coba lagi bagian yang belum terkirim?'
              )
            )
          )
            return
          await mutate(() => api(`/api/orders/${order.id}/retry-group`, 'POST', { reviewed }))
        })
      )
    const preview = node('details')
    preview.append(node('summary', t('Pratinjau kiriman grup')))
    const snapshot = order.preview
    preview.append(
      node(
        'pre',
        [
          `Order ${snapshot.number}`,
          snapshot.customerName,
          snapshot.payment,
          ...snapshot.items.flatMap((i) => [
            `${i.name} · ${i.quantity} pcs · ${i.size}`,
            ...i.measurements.map((m) => `${m.name}: ${m.value} cm`),
          ]),
        ].join('\n')
      )
    )
    destination.append(preview)
    detail.append(destination)
    const history = node('details')
    history.append(node('summary', t('Riwayat order')))
    history.addEventListener('toggle', async () => {
      if (!history.open || history.dataset.loaded) return
      try {
        const result = await api(`/api/orders/${order.id}/history`)
        for (const part of result.parts) {
          const content = JSON.parse(part.content_json)
          history.append(
            node(
              'p',
              `${Number(part.part_index) + 1}. ${t(deliveries[part.status] || part.status)}${part.last_error ? ` · ${t(part.last_error)}` : ''}\n${content.text}`,
              'wa-order-event'
            )
          )
        }
        for (const event of result.events) {
          const before = JSON.parse(event.before_json),
            after = JSON.parse(event.after_json)
          const change = node('div', '', 'wa-order-event')
          change.append(
            node('time', new Date(event.created_at).toLocaleString(window.waI18n?.locale))
          )
          const oldStage = before.operations?.stage || before.stage,
            newStage = after.operations?.stage || after.stage
          change.append(
            node(
              'p',
              oldStage || newStage
                ? `${t(stages[oldStage] || 'Belum diperbarui')} → ${t(stages[newStage] || 'Belum diperbarui')}`
                : t('Pembaruan pengiriman grup')
            )
          )
          history.append(change)
        }
        history.dataset.loaded = 'true'
      } catch (error) {
        notice(error.message, true)
      }
    })
    detail.append(history)
  }
  async function mutate(action) {
    if (busy) return
    busy = true
    byId('orderDrawerClose').disabled = true
    notice(t('Menyimpan…'))
    try {
      await action()
      dirty = false
      await load(true)
      notice(t('Tersimpan'))
    } catch (error) {
      notice(error.message, true)
    } finally {
      busy = false
      byId('orderDrawerClose').disabled = false
    }
  }
  async function load(force = false) {
    if (!force && dirty && !confirm(t('Muat ulang dan buang perubahan yang belum tersimpan?')))
      return
    const revision = ++loadRevision
    loading = true
    byId('orderList').setAttribute('aria-busy', 'true')
    try {
      const loaded = await api(
        `/api/orders?${new URLSearchParams({ query: byId('orderSearch').value, stage: byId('orderStageFilter').value, tab: orderTab, page })}`
      )
      if (revision !== loadRevision) return
      data = loaded
      dirty = false
      byId('orderCount').textContent = t('{0} order', data.total)
      byId('orderPageNumber').textContent =
        `${data.page} / ${Math.max(1, Math.ceil(data.total / 30))}`
      byId('orderPrevious').disabled = page <= 1
      byId('orderNext').disabled = page * 30 >= data.total
      const list = byId('orderList')
      list.replaceChildren()
      if (!data.orders.length) {
        const row = node('tr')
        const empty = node('td', t('Belum ada order'), 'wa-order-empty')
        empty.colSpan = 5
        row.append(empty)
        list.append(row)
      }
      for (const order of data.orders) {
        const item = node('tr')
        item.addEventListener('click', (event) => {
          if (!event.target.closest('button')) item.querySelector('button').click()
        })
        item.dataset.orderId = order.id
        item.dataset.selected = String(selected === order.id)
        rowCells(item, order)
        list.append(item)
      }
      const current = data.orders.find((o) => o.id === selected)
      if (current) {
        const focusedId = drawer.contains(document.activeElement) ? document.activeElement.id : null
        openOrder(current)
        if (focusedId) byId(focusedId)?.focus({ preventScroll: true })
      } else {
        selected = null
        if (drawer.open) drawer.close()
      }
    } catch (error) {
      if (revision === loadRevision) notice(error.message, true)
    } finally {
      if (revision === loadRevision) {
        loading = false
        byId('orderList').setAttribute('aria-busy', 'false')
      }
    }
  }
  async function refreshProgress() {
    if (
      !selected ||
      !data ||
      dirty ||
      busy ||
      loading ||
      refreshingProgress ||
      Date.now() < progressRetryAt
    )
      return
    const id = selected
    const revision = loadRevision
    refreshingProgress = true
    try {
      const result = await api(`/api/orders?${new URLSearchParams({ orderId: String(id) })}`)
      if (id !== selected || revision !== loadRevision || dirty || busy || loading) return
      const fresh = result.orders.find((order) => order.id === id)
      const box = byId('orderDetail').querySelector('.wa-order-production-box')
      if (!fresh || !box || box.contains(document.activeElement)) return
      data.orders = data.orders.map((order) => (order.id === id ? fresh : order))
      box.replaceWith(productionBox(fresh))
      const row = byId('orderList').querySelector(`[data-order-id="${id}"]`)
      if (row) rowCells(row, fresh)
      progressFailures = 0
      progressRetryAt = 0
      if (byId('orderPageNotice').textContent === t('Status pengiriman belum dapat diperbarui.'))
        notice('')
    } catch {
      progressFailures++
      progressRetryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(progressFailures, 4))
      notice(t('Status pengiriman belum dapat diperbarui.'), true)
    } finally {
      refreshingProgress = false
    }
  }
  options(
    byId('orderStageFilter'),
    [['', t('Semua')], ...Object.entries(stages).map(([k, v]) => [k, t(v)])],
    ''
  )
  const initial = new URL(location.href).searchParams.get('order')
  if (initial && /^\d+$/.test(initial)) {
    orderTab = 'all'
    byId('orderSearch').value = initial
    selected = Number(initial)
  }
  function renderTabs() {
    for (const tab of byId('orderTabs').querySelectorAll('[data-order-tab]'))
      tab.setAttribute('aria-pressed', String(tab.dataset.orderTab === orderTab))
  }
  renderTabs()
  byId('orderTabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-order-tab]')
    if (!tab || busy || dirty || tab.dataset.orderTab === orderTab) return
    orderTab = tab.dataset.orderTab
    page = 1
    byId('orderStageFilter').value = ''
    renderTabs()
    void load(true)
  })
  // Move completed shipments out of the active list even with no drawer open.
  setInterval(() => {
    if (!document.hidden && !drawer.open && !dirty && !busy && !loading) void load(true)
  }, 30000)
  byId('orderRoutingForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!routing || routingBusy) return
    const group = byId('orderDefaultGroup')
    if (
      group.value &&
      !confirm(
        t(
          'Order baru akan otomatis dikirim ke {0} setelah pembayaran terverifikasi. Lanjutkan?',
          group.selectedOptions[0].textContent
        )
      )
    )
      return
    routingBusy = true
    const trigger = byId('orderDefaultTrigger').value
    for (const control of routingForm.elements) control.disabled = true
    byId('orderRoutingClose').disabled = true
    routingNotice(t('Menyimpan…'))
    try {
      routing = await api('/api/orders/routing', 'PUT', {
        version: routing.version,
        groupJid: group.value,
        paymentTrigger: trigger,
      })
      routingDirty = false
      routingNotice(t('Tersimpan'))
    } catch (error) {
      routingNotice(error.message, true)
    } finally {
      routingBusy = false
      for (const control of routingForm.elements) control.disabled = false
      byId('orderRoutingClose').disabled = false
    }
  })
  byId('orderRefreshGroups').addEventListener('click', async () => {
    try {
      await api('/api/orders/groups/refresh', 'POST', {})
      await loadRouting()
    } catch (error) {
      routingNotice(error.message, true)
    }
  })
  byId('orderRefresh').addEventListener('click', () => load())
  byId('orderStageFilter').addEventListener('change', () => {
    page = 1
    const stage = byId('orderStageFilter').value
    if (stage === 'completed') orderTab = 'completed'
    else if (stage === 'cancelled') orderTab = 'all'
    else if (stage && orderTab === 'completed') orderTab = 'active'
    renderTabs()
    void load()
  })
  byId('orderSearch').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      page = 1
      void load()
    }, 500)
  })
  byId('orderPrevious').addEventListener('click', () => {
    page--
    void load()
  })
  byId('orderNext').addEventListener('click', () => {
    page++
    void load()
  })
  window.addEventListener('beforeunload', (event) => {
    if (dirty || busy || routingDirty || routingBusy) event.preventDefault()
  })
  document.addEventListener('ui-language:change', () => {
    if (!dirty) {
      notice('')
      options(
        byId('orderStageFilter'),
        [['', t('Semua')], ...Object.entries(stages).map(([k, v]) => [k, t(v)])],
        byId('orderStageFilter').value
      )
      void load(true)
    }
  })
  setInterval(() => {
    if (!document.hidden && routing?.refreshRequested) void loadRouting().catch(() => {})
    if (!document.hidden) void refreshProgress()
  }, 5000)
  void loadRouting()
    .then(() => load())
    .catch((error) => notice(error.message, true))
})()
