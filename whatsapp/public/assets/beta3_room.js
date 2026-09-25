;(() => {
  const dialog = document.getElementById('cartDialog')
  if (!dialog || dialog.dataset.beta3Mode !== 'true') return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const statusLabel = {
    pending: t('Menunggu total'),
    awaiting_payment: t('Menunggu pembayaran'),
    paid: t('Lunas'),
    cancelled: t('Dibatalkan'),
  }
  const groupLabel = { pending: t('grup: antre'), sent: t('grup: terkirim'), failed: t('grup: gagal') }
  const stageLabel = {
    tanya_model: t('Tanya model'),
    tanya_size: t('Tanya size'),
    tawar_celana: t('Tawar celana'),
    minta_alamat: t('Minta alamat'),
    kirim_form: t('Form dikirim'),
    tunggu_form: t('Menunggu form'),
    tunggu_cs: t('Menunggu total'),
    tunggu_bayar: t('Menunggu pembayaran'),
    bukti_dikirim: t('Bukti transfer dicek'),
    selesai: t('Selesai'),
    lain: '',
  }
  let jid = ''
  const notice = (message = '', error = false) => {
    const box = byId('beta3RoomNotice')
    box.textContent = message
    box.hidden = !message
    box.classList.toggle('error', error)
  }
  async function api(path, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status === 204) return {}
    const result = await response.json()
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
    node.addEventListener('click', async () => {
      node.disabled = true
      try {
        await action()
      } catch (error) {
        notice(error.message, true)
      } finally {
        node.disabled = false
      }
    })
    return node
  }
  const thumb = (url, caption) => {
    const figure = el('figure')
    const link = el('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'
    const img = el('img'); img.src = url; img.alt = caption; img.loading = 'lazy'
    img.addEventListener('error', () => figure.remove())
    link.append(img)
    figure.append(link, el('figcaption', caption))
    return figure
  }

  function render(result) {
    const handling = result.handling?.mode === 'cs' ? t('Ditangani CS') : t('Ditangani AI')
    const stage = String(result.chatNote || '').match(/tahap\s*[:=]\s*([a-z_]+)/i)?.[1]?.toLowerCase() || ''
    byId('beta3RoomStatus').textContent = [handling, stageLabel[stage] ?? stage].filter(Boolean).join(' · ')

    const photos = byId('beta3RoomPhotos')
    photos.replaceChildren()
    for (const photo of result.photos || []) photos.append(thumb(photo.url, [photo.product, photo.color].filter(Boolean).join(' - ')))
    for (const ref of result.refs || []) photos.append(thumb(ref.image_url, ref.caption))
    photos.hidden = !photos.childElementCount

    const text = String(result.groupPreview || result.spec || '').trim()
    byId('beta3RoomText').textContent = text || t('Belum ada pesanan.')
    byId('beta3RoomSpec').value = result.spec || ''
    renderOrder(result.order, result.proofs || [])
  }

  function renderOrder(order) {
    const box = byId('beta3RoomOrder')
    box.replaceChildren()
    const status = byId('beta3RoomOrderStatus')
    status.textContent = ''
    if (!order || order.status === 'cancelled') {
      box.append(el('p', t('Belum ada order. Order tercatat otomatis saat pelanggan mengirim alamat.'), 'wa-muted'))
      return
    }
    status.textContent = [order.order_number || `#${order.id}`, statusLabel[order.status], groupLabel[order.group_status]]
      .filter(Boolean)
      .join(' · ')
    const to = [order.customer_name, order.phone, order.address].filter(Boolean).join(' · ')
    if (to) box.append(el('p', `${t('Kirim ke')}: ${to}`, 'wa-muted wa-b3-to'))
    if (order.total) {
      const sum = el('dl', undefined, 'wa-cart-summary')
      for (const [label, amount, cls] of [
        [t('Subtotal'), order.subtotal],
        [`${t('Ongkir')}${order.shipping_service ? ` ${order.shipping_service}` : ''}`, order.shipping_cost],
        [t('Total'), order.total, 'wa-cart-total'],
      ]) {
        if (amount === null || amount === undefined) continue
        const row = el('div', undefined, cls || '')
        row.append(el('dt', label), el('dd', money(amount)))
        sum.append(row)
      }
      box.append(sum)
    }
    const actions = el('div', undefined, 'actions')
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
          const picked = shipping.selectedOptions?.[0]
          await api(`/api/beta3/orders/${order.id}/approve`, {
            itemsText: byId('beta3RoomSpec').value || order.items,
            subtotal: subtotal.value,
            shippingService: options.length ? shipping.value : '',
            shippingCost: options.length ? picked?.dataset.cost : manual.value,
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
    } else if (order.status === 'awaiting_payment') {
      if (proofsCache.length) {
        const proofs = el('div', undefined, 'wa-b3-photos')
        for (const proof of proofsCache) proofs.append(thumb(proof.media_url, t('Bukti transfer')))
        box.append(proofs)
      }
      actions.append(
        button(t('Dana masuk · Lunas'), async () => {
          const result = await api(`/api/beta3/orders/${order.id}/paid`, {})
          notice(result.groupQueued ? t('Lunas. Pesanan dikirim ke grup produksi.') : t('Lunas. Grup produksi belum diatur.'))
          await load()
        }, true)
      )
    } else if (order.status === 'paid') {
      actions.append(
        button(order.group_status === 'sent' ? t('Kirim ulang ke grup') : t('Kirim ke grup'), async () => {
          await api(`/api/beta3/orders/${order.id}/resend-group`, {})
          notice(t('Diantrekan ke grup produksi.'))
          await load()
        })
      )
    }
    if (actions.childElementCount) box.append(actions)
  }

  let proofsCache = []
  async function load() {
    jid = byId('messages')?.dataset.jid || ''
    if (!jid) return
    try {
      const result = await api(`/api/beta3/room?jid=${encodeURIComponent(jid)}`)
      if (result.jid !== jid) return
      proofsCache = result.proofs || []
      render(result)
    } catch (error) {
      notice(error.message, true)
    }
  }
  byId('beta3RoomSpecSave').addEventListener('click', async () => {
    try {
      await api('/api/beta3/room/spec', { jid, spec: byId('beta3RoomSpec').value })
      notice(t('Detail pesanan disimpan.'))
      await load()
    } catch (error) {
      notice(error.message, true)
    }
  })
  const openPanel = () => {
    if (!byId('messages')?.dataset.jid) return
    notice()
    if (window.waMotion) window.waMotion.showDialog(dialog)
    else dialog.showModal()
    load()
  }
  const closePanel = () => {
    if (window.waMotion) window.waMotion.closeDialog(dialog)
    else dialog.close()
  }
  byId('cartOpen')?.addEventListener('click', openPanel)
  byId('cartClose')?.addEventListener('click', closePanel)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closePanel()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closePanel()
  })
  const messages = byId('messages')
  if (messages)
    new MutationObserver(() => {
      if (dialog.open) load()
    }).observe(messages, { attributes: true, attributeFilter: ['data-jid'] })
})()
