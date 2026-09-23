;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const byId = (id) => document.getElementById(id)
  const opener = byId('cartOpen')
  if (!opener) return
  const dialog = byId('cartDialog')
  // Beta 2: panel pesanan ditangani lean_room.js; cart/saldo Beta 1 tidak dirender.
  if (dialog?.dataset.leanMode === 'true' || dialog?.dataset.beta3Mode === 'true') return
  const payment = byId('cartPaymentForm')
  const app = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (amount) =>
    new Intl.NumberFormat((window.waI18n?.locale || 'id-ID'), {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0,
    }).format(amount)
  const node = (tag, className, text) => {
    const el = document.createElement(tag)
    el.className = className || ''
    if (text !== undefined) el.textContent = text
    return el
  }
  const button = (label, action) => {
    const el = node('button', 'button', label)
    el.type = 'button'
    el.addEventListener('click', () => void action())
    return el
  }
  const productionStages = {
    unverified: 'Belum diperbarui',
    awaiting_details: 'Menunggu detail',
    queued: 'Antre produksi',
    production: 'Produksi',
    qc: 'QC',
    ready: 'Siap kirim',
    shipped: 'Dikirim',
    completed: 'Selesai',
  }
  function orderProgress(order) {
    // Payment and production are independent. An AWB alone is not proof of shipping.
    if (order.status === 'cancelled') return null
    const rawStage = order.operations?.stage
    const stage = Object.hasOwn(productionStages, rawStage) ? rawStage : 'unverified'
    const progress = node('div', 'wa-cart-order-progress')
    progress.dataset.stage = stage
    progress.append(
      node('small', 'wa-muted', t('Status produksi')),
      node('span', 'wa-cart-stage', t(productionStages[stage]))
    )
    return progress
  }
  let state = null
  let jid = ''
  let busy = false
  let loading = false
  let paymentReview = null
  let paymentRequestKey = ''
  let readingSequence = 0
  let selectedOrderId = null
  let refreshFailures = 0
  let retryAt = 0
  const countBadge = byId('cartCount')
  const moneyBadge = byId('cartMoney')
  const paymentIcon = '<svg class="wa-cart-payment-icon" viewBox="0 0 30 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 2h3l2 12h12l2-8H5M7 14l-1 3h9"/><circle cx="8" cy="21" r="1"/><circle cx="15" cy="21" r="1"/><rect x="16" y="12" width="13" height="9" rx="1.5"/><circle cx="22.5" cy="16.5" r="2"/></svg>'
  for (const id of ['cartConfirmPayment', 'cartPaymentApprove'])
    byId(id)?.insertAdjacentHTML('afterbegin', paymentIcon)

  function renderIndicator() {
    const count = (state?.cart.items || []).reduce((sum, item) => {
      const quantity = Number(item.quantity)
      return sum + (Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0)
    }, 0)
    const pending = state?.cart.paymentStatus === 'reported'
    if (countBadge) {
      countBadge.textContent = count > 99 ? '99+' : String(count)
      countBadge.hidden = count === 0
    }
    if (moneyBadge) moneyBadge.hidden = !pending
    const label = [t('Cart dan order'), state ? t('{0} item di cart', count) : '', pending ? t('Transfer perlu diperiksa') : ''].filter(Boolean).join(' · ')
    opener.title = label
    opener.setAttribute('aria-label', label)
  }

  function syncRoom() {
    const next = byId('messages')?.dataset.jid || ''
    if (next === jid) return
    jid = next
    state = null
    renderIndicator()
  }
  const detailPanel = byId('orderDetailPanel')
  function closeOrderDetail(restoreFocus = true) {
    const previous = selectedOrderId
    selectedOrderId = null
    if (window.waMotion) window.waMotion.visible(detailPanel, false)
    else detailPanel.hidden = true
    dialog.classList.remove('has-order-detail')
    dialog.querySelectorAll('[data-order-detail]').forEach((button) => {
      button.setAttribute('aria-expanded', 'false')
      button.closest('.wa-cart-order').classList.remove('selected')
    })
    if (restoreFocus)
      dialog.querySelector(`[data-order-detail="${previous}"]`)?.focus({ preventScroll: true })
  }
  function openOrderDetail(order) {
    const changed = selectedOrderId !== order.id
    selectedOrderId = order.id
    renderOrderDetail(order)
    if (changed) byId('orderDetailContent').scrollTop = 0
    byId('orderDetailClose').focus({ preventScroll: true })
  }
  function renderOrderDetail(order) {
    if (window.waMotion) window.waMotion.visible(detailPanel, true)
    else detailPanel.hidden = false
    dialog.classList.add('has-order-detail')
    byId('orderDetailTitle').textContent = order.number
    dialog.querySelectorAll('[data-order-detail]').forEach((button) => {
      const selected = button.dataset.orderDetail === String(order.id)
      button.setAttribute('aria-expanded', String(selected))
      button.closest('.wa-cart-order').classList.toggle('selected', selected)
    })
    const content = byId('orderDetailContent')
    content.replaceChildren()
    const products = node('section', 'wa-cart-section wa-cart-current')
    products.append(node('h3', '', t('Produk')))
    for (const item of order.cart.items) {
      const row = node('div', 'wa-cart-item wa-cart-order-item')
      if (item.image) {
        const image = node('img')
        image.src = item.image
        image.alt = item.name
        image.loading = 'lazy'
        image.referrerPolicy = 'no-referrer'
        image.addEventListener('error', () => {
          image.hidden = true
          row.classList.add('no-image')
        })
        row.append(image)
      } else row.classList.add('no-image')
      const details = node('div')
      details.append(
        node('strong', '', item.name),
        node('small', '', t("Jumlah: {0} · {1}", item.quantity, `${item.size}${item.requestedSize ? ` ${item.requestedSize}` : ''}`))
      )
      const measurements = Object.entries(item.measurements || {})
        .map(([name, value]) => `${name}: ${value} cm`)
        .join('\n')
      if (measurements) details.append(node('small', '', measurements))
      if (item.note) details.append(node('small', '', item.note))
      window.waOrderItemDetails?.(details, item)
      row.append(details)
      products.append(row)
    }
    const delivery = node('section', 'wa-cart-section wa-order-delivery')
    delivery.append(node('h3', '', t('Penerima & pengiriman')))
    for (const [label, value] of [
      [t('Penerima'), order.cart.recipient.name],
      [t('Nomor'), order.cart.recipient.phone],
      [t('Alamat'), order.cart.recipient.address],
      [t('Pengiriman'), order.cart.shipping.service],
      [t('Catatan'), order.cart.note],
    ]) {
      if (value) delivery.append(node('small', 'wa-muted', label), node('p', '', value))
    }
    const costs = node('section', 'wa-cart-section wa-cart-current')
    costs.append(node('h3', '', t('Rincian biaya')))
    const summary = node('dl', 'wa-cart-summary')
    const subtotal = order.cart.subtotal ?? order.cart.items.reduce(
      (sum, item) => sum + item.quantity * (item.unitPrice || 0), 0
    )
    for (const [label, amount] of [
      ['Subtotal', subtotal],
      [t('Diskon'), order.cart.discount ? -order.cart.discount : 0],
      [t('Ongkir'), order.cart.shipping.cost],
      ['Total', order.total],
    ]) {
      const row = node('div', label === 'Total' ? 'wa-cart-total' : '')
      row.append(node('dt', '', label), node('dd', '', amount === null ? '—' : money(amount)))
      summary.append(row)
    }
    costs.append(summary)
    content.append(products, delivery, costs)
  }
  function notice(message = '') {
    byId('cartNotice').textContent = message
    byId('cartNotice').hidden = !message
  }
  async function api(path, body) {
    const response = await fetch(`${app}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  async function action(name, body = {}) {
    if (busy || loading || !state) return false
    busy = true
    notice()
    try {
      const result = await api(`/api/cart/${name}`, { jid, version: state.cart.version, ...body })
      state = result
      render()
      return true
    } catch (error) {
      notice(error.message)
      return false
    } finally {
      busy = false
    }
  }
  async function load(manual = false) {
    if (loading || busy) return
    syncRoom()
    if (!jid || (!manual && Date.now() < retryAt)) return
    loading = true
    const room = jid
    try {
      const result = await api(`/api/cart?jid=${encodeURIComponent(room)}`)
      if (room !== jid) return
      refreshFailures = 0
      retryAt = 0
      state = result
      renderIndicator()
      if (dialog.open) render()
    } catch (error) {
      refreshFailures++
      retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(refreshFailures, 4))
      if (room === jid && dialog.open) notice(error.message)
    } finally {
      loading = false
    }
  }
  function render() {
    if (!state) return
    renderIndicator()
    const cart = state.cart
    const customerBalance = state.customerBalance || { balance: 0, entries: [] }
    byId('cartCustomerBalance').textContent = money(customerBalance.balance)
    byId('cartBalanceHistory').hidden = !customerBalance.entries.length
    const balanceEntries = byId('cartBalanceEntries')
    balanceEntries.replaceChildren()
    for (const entry of customerBalance.entries) {
      const row = node('div', 'wa-cart-order')
      row.append(
        node(
          'strong',
          '',
          `${entry.amount > 0 ? '+' : '−'}${money(Math.abs(entry.amount))} · ${entry.orderNumber}`
        )
      )
      row.append(
        node(
          'p',
          '',
          `${entry.amount < 0 ? t('Pembayaran dari saldo') : t('Kelebihan pembayaran')}\n${new Date(entry.createdAt).toLocaleString((window.waI18n?.locale || 'id-ID'))}${entry.reference ? `\nRef: ${entry.reference}` : ''}`
        )
      )
      balanceEntries.append(row)
    }
    const list = byId('cartItems')
    list.replaceChildren()
    if (!cart.items.length) list.append(node('small', 'wa-muted', t('Cart kosong')))
    for (const item of cart.items) {
      const name = item.name
      const row = node('article', 'wa-cart-item')
      row.dataset.itemId = item.id
      const image = node('img')
      image.src = item.image
      image.alt = name
      image.referrerPolicy = 'no-referrer'
      const content = node('div')
      content.append(
        node('strong', '', name),
        node(
          'small',
          '',
          `${item.quantity} × ${item.catalogVerification === 'pending' ? t('Draft · menunggu verifikasi katalog') : item.unitPrice === null ? t('Harga belum ditetapkan') : money(item.unitPrice)} · ${item.size}${item.requestedSize ? ` ${item.requestedSize}` : ''}`
        )
      )
      if (Object.keys(item.measurements).length)
        content.append(
          node(
            'small',
            '',
            Object.entries(item.measurements)
              .map(([name, value]) => `${name}: ${value} cm`)
              .join('\n')
          )
        )
      if (item.note) content.append(node('small', '', item.note))
      window.waOrderItemDetails?.(content, item)
      const actions = node('div', 'actions')
      const preorder = item.fulfillment === 'preorder'
      content.append(
        node(
          'span',
          `wa-cart-approval ${preorder ? 'pending' : 'standard'}`,
          preorder ? t('Pre-order · keputusan lokal') : t('Ready stock')
        )
      )
      if (item.fulfillmentNote) content.append(node('small', '', item.fulfillmentNote))
      actions.append(
        button(preorder ? t('Jadikan ready') : t('Tandai pre-order'), async () => {
          if (
            !confirm(
              preorder
                ? t('Kembalikan item ini ke ready stock?')
                : t('Tandai item ini pre-order? Stok kosong saja bukan dasar pre-order.')
            )
          )
            return
          const note = preorder ? '' : prompt(t('Catatan internal keputusan pre-order:')) || ''
          await action('fulfillment', {
            itemId: item.id,
            fulfillment: preorder ? 'ready' : 'preorder',
            note,
          })
        })
      )
      if (item.modelType === 'custom') {
        content.append(
          node(
            'span',
            `wa-cart-approval ${item.modelApproval}`,
            {
              pending: t('Model · menunggu persetujuan CS'),
              approved: t('Model · disetujui CS'),
              rejected: t('Model · ditolak CS'),
            }[item.modelApproval]
          )
        )
        if (item.modelApprovalNote) content.append(node('small', '', item.modelApprovalNote))
        actions.append(
          button(t('Setujui model'), async () => {
            if (
              confirm(
                t("Setujui model ini? {0}", item.unitPrice === null ? t('Harga belum ditetapkan.') : t("Harga {0}.", money(item.unitPrice)))
              )
            )
              await action('model', { itemId: item.id, approved: true, note: '' })
          }),
          button(t('Tolak model'), async () => {
            const note = prompt(t('Catatan internal penolakan model:'))
            if (note?.trim()) await action('model', { itemId: item.id, approved: false, note })
          })
        )
      }
      if (item.size === 'custom') {
        const hasMeasurements = Object.keys(item.measurements).length > 0 || Boolean(item.productionDetails?.measurements?.length)
        content.append(
          node(
            'span',
            `wa-cart-approval ${item.approval}`,
            {
              pending: hasMeasurements
                ? t('Ukuran · menunggu persetujuan CS')
                : t('Ukuran · menunggu detail'),
              approved: t('Ukuran · disetujui CS'),
              rejected: t('Ukuran · ditolak CS'),
            }[item.approval]
          )
        )
        if (item.approvalNote) content.append(node('small', '', item.approvalNote))
        const approveSize = button(t('Setujui ukuran'), async () => {
          if (confirm(t('Setujui seluruh detail ukuran custom ini?')))
            await action('custom', { itemId: item.id, approved: true, note: '' })
        })
        approveSize.disabled = !hasMeasurements
        actions.append(
          approveSize,
          button(t('Tolak'), async () => {
            const note = prompt(t('Catatan internal penolakan ukuran:'))
            if (note?.trim()) await action('custom', { itemId: item.id, approved: false, note })
          })
        )
      }
      content.append(actions)
      row.append(image, content)
      list.append(row)
    }
    const details = byId('cartDetails')
    details.replaceChildren()
    details.hidden = !cart.items.length
    for (const [label, value] of [
      [t('Penerima'), cart.recipient.name],
      [t('Nomor'), cart.recipient.phone],
      [t('Alamat'), cart.recipient.address],
      [t('Pengiriman'), cart.shipping.service],
      [t('Catatan'), cart.note],
    ]) {
      if (label === t('Catatan') && !value) continue
      details.append(node('small', 'wa-muted', label), node('p', '', value || t('Belum dikonfirmasi')))
    }
    const hasItems = cart.items.length > 0
    const missingPrice = cart.items.some((item) => item.unitPrice === null)
    const missingShipping = hasItems && cart.shipping.cost === null
    const subtotal =
      cart.subtotal ??
      cart.items.reduce((sum, item) => sum + item.quantity * (item.unitPrice || 0), 0)
    const discount = cart.discount ?? 0
    byId('cartSubtotal').textContent = missingPrice ? t('Menunggu harga') : money(subtotal)
    byId('cartDiscount').textContent = discount > 0 ? `−${money(discount)}` : money(0)
    byId('cartShipping').textContent = !hasItems
      ? '—'
      : missingShipping
        ? t('Belum ditentukan')
        : money(cart.shipping.cost)
    byId('cartTotal').textContent = missingPrice
      ? t('Menunggu harga')
      : missingShipping
        ? t('Menunggu ongkir')
        : money(cart.total)
    byId('cartPaymentStatus').textContent =
      cart.paymentStatus === 'reported' ? t('Transfer perlu diperiksa') : ''
    const quote = cart.paymentQuote
    byId('cartCreditRow').hidden = !(hasItems && quote?.balanceToUse > 0)
    byId('cartDueRow').hidden = !(hasItems && quote?.balanceToUse > 0)
    byId('cartCredit').textContent = `−${money(quote?.balanceToUse || 0)}`
    byId('cartDue').textContent = quote?.amountDue == null ? '—' : money(quote.amountDue)
    byId('cartConfirmPayment').hidden = cart.paymentStatus !== 'reported'
    byId('cartCancel').disabled = !cart.items.length
    const orders = byId('cartOrders')
    orders.replaceChildren()
    if (!state.orders.length) orders.append(node('small', 'wa-muted', t('Belum ada order')))
    for (const order of state.orders) {
      const card = node('article', 'wa-cart-order')
      card.dataset.orderId = order.id
      const heading = node('div', 'wa-cart-heading')
      const number = node('div', 'wa-order-number')
      const copy = button('', async () => {
        copy.disabled = true
        try {
          await navigator.clipboard.writeText(order.number)
          copy.classList.add('copied')
          copy.title = t('Nomor order disalin')
          copy.setAttribute('aria-label', copy.title)
          setTimeout(() => {
            copy.classList.remove('copied')
            copy.title = t('Salin nomor order {0}', order.number)
            copy.setAttribute('aria-label', copy.title)
          }, 2000)
        } catch {
          notice(t('Tidak dapat menyalin. Nomor order: {0}', order.number))
        } finally {
          copy.disabled = false
        }
      })
      copy.className = 'wa-order-copy'
      copy.title = t('Salin nomor order {0}', order.number)
      copy.setAttribute('aria-label', copy.title)
      copy.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="wa-copy-glyph"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></g><path class="wa-copy-check" d="m5 12 4 4L19 6"/></svg>'
      number.append(node('strong', '', order.number), copy)
      heading.append(
        number,
        node(
          'small',
          `wa-order-status ${order.status === 'cancelled' ? 'cancelled' : order.balance ? 'pending' : 'paid'}`,
          order.status === 'cancelled' ? t('Dibatalkan') : order.balance ? (order.paid > 0 ? t('DP') : t('Belum lunas')) : t('Lunas')
        )
      )
      card.append(heading)
      const progress = orderProgress(order)
      if (progress) card.append(progress)
      const shippingProgress = window.waShippingProgress?.(order)
      if (shippingProgress) card.append(shippingProgress)
      if (order.operations?.trackingNumber && order.status !== 'cancelled')
        card.append(node('small', 'wa-muted wa-shipping-status', `${t('Resi')}: ${order.operations.trackingNumber}`))
      const summary = node('dl', 'wa-cart-summary')
      summary.setAttribute('aria-label', t('Rincian pembayaran'))
      const partial = order.status === 'active' && order.paid > 0 && order.balance > 0
      for (const [label, amount] of [
        ['Total', order.total],
        [partial ? t('DP diterima') : t('Dibayar'), order.paid],
        [
          order.status === 'cancelled' ? t('Sisa sebelum pembatalan') : t('Sisa pembayaran'),
          order.balance,
        ],
      ]) {
        const row = node('div', label === t('Sisa pembayaran') ? 'wa-cart-total' : '')
        row.append(node('dt', '', label), node('dd', '', money(amount)))
        summary.append(row)
      }
      if (order.overpayment > 0) {
        const row = node('div')
        row.append(node('dt', '', t('Kelebihan → saldo')), node('dd', '', money(order.overpayment)))
        summary.append(row)
      }
      if (order.balanceApplied > 0) {
        const row = node('div')
        row.append(node('dt', '', t('Termasuk saldo')), node('dd', '', money(order.balanceApplied)))
        summary.append(row)
      }
      card.append(summary)
      const actions = node('div', 'actions')
      const expand = button(t('← Detail'), () => {
        if (selectedOrderId === order.id) closeOrderDetail()
        else openOrderDetail(order)
      })
      expand.dataset.orderDetail = order.id
      expand.setAttribute('aria-controls', 'orderDetailPanel')
      expand.setAttribute('aria-expanded', String(selectedOrderId === order.id))
      expand.setAttribute('aria-label', t("Detail {0}", order.number))
      actions.append(expand)
      if (order.status === 'active') {
        if (order.balance > 0) {
          const confirmPayment = button(t('Konfirmasi pelunasan'), () => openPayment(order))
          confirmPayment.insertAdjacentHTML('afterbegin', paymentIcon)
          confirmPayment.classList.add('primary')
          actions.append(confirmPayment)
        }
        actions.append(
          button(t('Batalkan order'), async () => {
            if (
              confirm(
                t("Batalkan {0}? Riwayat pembayaran tetap tersimpan. Ini tidak mengembalikan dana otomatis.", order.number)
              )
            )
              await action('cancel-order', { orderId: order.id })
          })
        )
      }
      card.append(actions)
      orders.append(card)
    }
    if (selectedOrderId !== null) {
      const selected = state.orders.find((order) => order.id === selectedOrderId)
      if (selected) renderOrderDetail(selected)
      else closeOrderDetail()
    }
  }
  async function openPayment(order) {
    if (!state || busy || loading) return
    closeOrderDetail(false)
    const sequence = ++readingSequence
    const room = jid
    const version = state.cart.version
    paymentReview = null
    paymentRequestKey = crypto.randomUUID()
    byId('cartPaymentTitle').textContent = order
      ? t("Pelunasan {0}", order.number)
      : t('Konfirmasi pembayaran')
    byId('cartPaymentReading').textContent = t('Membaca bukti transfer…')
    byId('cartPaymentReadingDetails').hidden = true
    byId('cartPaymentProofLink').hidden = true
    byId('cartPaymentApprove').disabled = true
    payment.hidden = false
    payment.scrollIntoView({ block: 'nearest' })
    try {
      const { review } = await api('/api/cart/read-payment', {
        jid: room,
        version,
        orderId: order?.id,
      })
      if (sequence !== readingSequence || room !== jid || payment.hidden) return
      paymentReview = { ...review, version }
      byId('cartPaymentAmount').textContent =
        review.amount === null ? t('Belum terbaca') : money(review.amount)
      byId('cartPaymentBill').textContent = money(review.billAmount)
      byId('cartPaymentBalanceRow').hidden = !(review.paymentQuote?.balanceToUse > 0)
      byId('cartPaymentBalance').textContent = `−${money(review.paymentQuote?.balanceToUse || 0)}`
      byId('cartPaymentDue').textContent = money(review.paymentQuote?.amountDue ?? review.billAmount)
      byId('cartPaymentExcessRow').hidden = !(review.overpayment > 0)
      byId('cartPaymentExcess').textContent = money(review.overpayment || 0)
      byId('cartPaymentMethod').textContent = review.methodName || t('Belum cocok')
      byId('cartPaymentDestination').textContent = review.destination || t('Belum terbaca')
      byId('cartPaymentReference').textContent = review.reference || '—'
      byId('cartPaymentProof').src = review.proofUrl
      byId('cartPaymentProofLink').href = review.proofUrl
      byId('cartPaymentProofLink').hidden = false
      byId('cartPaymentReadingDetails').hidden = false
      byId('cartPaymentReading').textContent = review.ready
        ? t('Periksa bukti dan mutasi rekening sebelum mengonfirmasi.') +
          (review.overpayment > 0
            ? t('\nKelebihan masuk saldo dan otomatis mengurangi sisa tagihan pelanggan, mulai order tertua.')
            : '')
        : review.issues.join('\n')
      byId('cartPaymentApprove').disabled = !review.ready
      payment.scrollIntoView({ block: 'start' })
    } catch (error) {
      if (sequence === readingSequence) byId('cartPaymentReading').textContent = error.message
    }
  }
  opener.addEventListener('click', async () => {
    readingSequence++
    paymentReview = null
    jid = byId('messages')?.dataset.jid || ''
    if (!jid) return
    state = null
    closeOrderDetail(false)
    byId('cartItems').replaceChildren()
    byId('cartDetails').replaceChildren()
    byId('cartOrders').replaceChildren()
    byId('cartCustomerBalance').textContent = '—'
    byId('cartBalanceHistory').hidden = true
    byId('cartBalanceEntries').replaceChildren()
    byId('cartTotal').textContent = '—'
    byId('cartCreditRow').hidden = true
    byId('cartDueRow').hidden = true
    byId('cartPaymentStatus').textContent = ''
    byId('cartConfirmPayment').hidden = true
    byId('cartCancel').disabled = true
    notice()
    payment.hidden = true
    if (window.waMotion) window.waMotion.showDialog(dialog)
    else dialog.showModal()
    await load(true)
  })
  byId('cartClose').addEventListener('click', () => {
    if (window.waMotion) window.waMotion.closeDialog(dialog)
    else dialog.close()
  })
  byId('orderDetailClose').addEventListener('click', () => closeOrderDetail())
  dialog.addEventListener('cancel', (event) => {
    if (selectedOrderId !== null) {
      event.preventDefault()
      closeOrderDetail()
    } else if (window.waMotion) {
      event.preventDefault()
      window.waMotion.closeDialog(dialog)
    }
  })
  byId('cartConfirmPayment').addEventListener('click', () => void openPayment())
  byId('cartCancel').addEventListener('click', async () => {
    if (confirm(t('Batalkan dan kosongkan cart ini?'))) await action('cancel')
  })
  byId('cartPaymentCancel').addEventListener('click', () => {
    readingSequence++
    paymentReview = null
    payment.hidden = true
  })
  payment.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!paymentReview?.ready || busy) return
    if (
      !confirm(
        t("Saya sudah memeriksa mutasi rekening dan dana {0} benar-benar masuk.{1}\nSaldo tersedia otomatis mengurangi sisa tagihan pelanggan, mulai order tertua. Konfirmasi?", money(paymentReview.amount), paymentReview.overpayment > 0 ? t("\nKelebihan {0} masuk saldo pelanggan.", money(paymentReview.overpayment)) : '')
      )
    )
      return
    byId('cartPaymentApprove').disabled = true
    const success = await action('confirm-payment', {
      reviewId: paymentReview.id,
      requestKey: paymentRequestKey,
      version: paymentReview.version,
      verified: true,
    })
    if (success) payment.hidden = true
    else byId('cartPaymentApprove').disabled = false
  })
  window.setInterval(() => {
    if (!document.hidden && !busy && (!dialog.open || payment.hidden)) void load()
  }, 5000)
  document.addEventListener('ui-language:change', renderIndicator)
  const messages = byId('messages')
  if (messages) new MutationObserver(() => { syncRoom(); void load() }).observe(messages, { attributes: true, attributeFilter: ['data-jid'] })
  syncRoom()
  void load()
})()
