;(() => {
  const dialog = document.getElementById('cartDialog')
  if (!dialog || dialog.dataset.beta3Mode !== 'true') return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const panel = byId('beta3RoomPanel')
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const statusLabel = {
    pending: t('Menunggu CS isi total'),
    awaiting_payment: t('Menunggu pembayaran'),
    paid: t('Lunas'),
    cancelled: t('Dibatalkan'),
  }
  const groupLabel = { none: '', pending: t('grup: antre'), sent: t('grup: terkirim'), failed: t('grup: gagal') }
  let jid = ''
  let current = null
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
    lain: t('Lain-lain'),
  }
  function renderStatus(result) {
    const handling = result.handling || { mode: 'ai', reason: '' }
    byId('beta3RoomHandling').textContent =
      handling.mode === 'cs'
        ? `${t('Ditangani CS')}${handling.reason ? ` · ${handling.reason}` : ''}`
        : t('Ditangani AI')
    const note = String(result.chatNote || '')
    const stage = note.match(/tahap\s*[:=]\s*([a-z_]+)/i)?.[1]?.toLowerCase() || ''
    const waiting = note.match(/menunggu\s*[:=]\s*(.+)/i)?.[1]?.trim() || ''
    byId('beta3RoomStage').textContent = [
      stage ? `${t('Tahap')}: ${stageLabel[stage] || stage}` : t('Belum ada tahap'),
      waiting ? `${t('Menunggu')}: ${waiting}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const rest = note
      .split('\n')
      .filter((line) => !/^\s*(tahap|menunggu)\s*[:=]/i.test(line))
      .join('\n')
      .trim()
    byId('beta3RoomChatNote').textContent = rest
    byId('beta3RoomChatNote').hidden = !rest
  }

  function renderOrder(order, proofs = [], groupPreview = '') {
    const box = byId('beta3RoomOrder')
    box.replaceChildren()
    byId('beta3RoomOrderStatus').textContent = ''
    if (!order) {
      box.append(el('p', t('Belum ada form order dari pelanggan.'), 'wa-muted'))
      return
    }
    byId('beta3RoomOrderStatus').textContent = [order.order_number || `#${order.id}`, statusLabel[order.status] || order.status, order.status === 'pending' && order.auto_total_reason ? t('Otomatis gagal: {0}', order.auto_total_reason) : '', groupLabel[order.group_status] || '']
      .filter(Boolean)
      .join(' · ')
    const who = el('p', `${order.customer_name || '-'} · ${[order.district, order.regency].filter(Boolean).join(', ')}`)
    box.append(who)
    const items = String(order.spec || order.items || '').trim()
    if (items) box.append(el('pre', items, 'wa-lean-chatnote'))
    if (order.status === 'pending') {
      let options = []
      try {
        options = JSON.parse(order.shipping_options || 'null')?.prices || []
      } catch {}
      const priced = options.filter((row) => Number(row.price) > 0)
      box.append(
        el(
          'p',
          priced.length
            ? `${t('Ongkir tersedia')}: ${priced.map((row) => `${String(row.service).replace(/\d+$/, '')} ${money(row.price)}${row.etd ? ` (${String(row.etd).replace('day', t('hari'))})` : ''}`).join(', ')}`
            : t('Ongkir belum terhitung untuk alamat ini.'),
          'wa-muted'
        )
      )
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
    const actions = el('div', undefined, 'actions')
    if (order.status === 'pending') {
      const form = el('form', undefined, 'wa-cart-form')
      const subtotal = el('input'); subtotal.type = 'number'; subtotal.placeholder = t('Subtotal barang (Rp)'); subtotal.required = true
      const service = el('input'); service.type = 'text'; service.placeholder = t('Layanan (REG / YES / one day)')
      const shipping = el('input'); shipping.type = 'number'; shipping.placeholder = t('Ongkir (Rp)'); shipping.required = true
      const submit = el('button', t('Kirim total + rekening'), 'button primary'); submit.type = 'submit'
      form.append(subtotal, service, shipping, submit)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        try {
          await api(`/api/beta3/orders/${order.id}/approve`, {
            itemsText: byId('beta3RoomSpec').value || order.items,
            subtotal: subtotal.value,
            shippingService: service.value,
            shippingCost: shipping.value,
          })
          notice(t('Total dan rekening dikirim ke pelanggan.'))
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      box.append(form)
    } else if (order.status === 'awaiting_payment') {
      const proofBox = el('div', undefined, 'wa-beta3-proofs')
      proofBox.append(el('small', proofs.length ? t('Bukti transfer dari pelanggan') : t('Belum ada bukti transfer'), 'wa-muted'))
      for (const proof of proofs) {
        const link = el('a'); link.href = proof.media_url; link.target = '_blank'; link.rel = 'noopener'
        const img = el('img'); img.src = proof.thumbnail_url || proof.media_url; img.alt = t('Bukti transfer'); img.loading = 'lazy'
        link.append(img)
        proofBox.append(link)
      }
      box.append(proofBox)
      const paid = el('button', t('Konfirmasi dana masuk · Lunas'), 'button primary'); paid.type = 'button'
      paid.addEventListener('click', async () => {
        try {
          const result = await api(`/api/beta3/orders/${order.id}/paid`, {})
          notice(result.groupQueued ? t('Lunas. Pesanan diantrekan ke grup produksi.') : t('Lunas. Grup produksi default belum diatur, tidak dikirim ke grup.'))
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      actions.append(paid)
    } else if (order.status === 'paid') {
      const resend = el('button', order.group_status === 'sent' ? t('Kirim ulang ke grup') : t('Kirim ke grup'), 'button'); resend.type = 'button'
      resend.addEventListener('click', async () => {
        try {
          await api(`/api/beta3/orders/${order.id}/resend-group`, {})
          notice(t('Diantrekan ke grup produksi.'))
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      actions.append(resend)
      if (order.group_error) box.append(el('p', `Grup gagal: ${order.group_error}`, 'error'))
    }
    if (actions.childElementCount) box.append(actions)
    if (groupPreview) {
      const details = el('details', undefined, 'wa-beta3-group')
      details.append(
        el('summary', order.status === 'paid' ? t('Pesan ke grup produksi') : t('Pratinjau pesan ke grup (dikirim setelah lunas)')),
        el('pre', groupPreview, 'wa-lean-chatnote')
      )
      box.append(details)
    }
  }
  async function load() {
    jid = byId('messages')?.dataset.jid || ''
    if (!jid) return
    try {
      const result = await api(`/api/beta3/room?jid=${encodeURIComponent(jid)}`)
      if (result.jid !== jid) return
      current = result
      renderStatus(result)
      byId('beta3RoomSpec').value = result.spec || ''
      byId('beta3RoomNote').value = result.note || ''
      renderOrder(result.order, result.proofs || [], result.groupPreview || '')
    } catch (error) {
      notice(error.message, true)
    }
  }
  byId('beta3RoomSpecSave').addEventListener('click', async () => {
    try {
      await api('/api/beta3/room/spec', { jid, spec: byId('beta3RoomSpec').value })
      notice(t('Detail pesanan disimpan.'))
    } catch (error) {
      notice(error.message, true)
    }
  })
  byId('beta3RoomNoteSave').addEventListener('click', async () => {
    try {
      await api('/api/beta3/customer', { jid, note: byId('beta3RoomNote').value })
      notice(t('Catatan pelanggan disimpan.'))
    } catch (error) {
      notice(error.message, true)
    }
  })
  const opener = byId('cartOpen')
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
  opener?.addEventListener('click', openPanel)
  byId('cartClose')?.addEventListener('click', closePanel)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closePanel()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closePanel()
  })
  // Segarkan saat room berganti selagi panel terbuka.
  const messages = byId('messages')
  if (messages)
    new MutationObserver(() => {
      if (dialog.open) load()
    }).observe(messages, { attributes: true, attributeFilter: ['data-jid'] })
})()
