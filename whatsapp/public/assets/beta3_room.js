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
  const pointLabel = {
    produk: t('Produk'),
    size: t('Size'),
    celana: t('Celana'),
    alamat: t('Alamat'),
    nama: t('Nama'),
    ongkir: t('Ongkir'),
    total: t('Total'),
    stok: t('Stok'),
    kirim: t('Kirim'),
    catatan: t('Catatan'),
  }
  const capital = (value) => value.charAt(0).toUpperCase() + value.slice(1)
  /** Catatan AI "kunci: isi" → poin rapi; tahap & menunggu tampil terpisah. */
  function notePoints(note) {
    const points = []
    for (const line of String(note || '').split('\n')) {
      const text = line.replace(/^\s*[-•*]\s*/, '').trim()
      if (!text || /^(tahap|menunggu)\s*[:=]/i.test(text)) continue
      const match = text.match(/^([a-z][a-z _/]{1,24})\s*[:=]\s*(.+)$/i)
      if (match) {
        const key = match[1].trim().toLowerCase()
        points.push([pointLabel[key] || capital(key), match[2].trim()])
      } else points.push(['', text])
    }
    return points
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
    const stageBox = byId('beta3RoomStage')
    stageBox.textContent = stage ? stageLabel[stage] || stage : t('Belum ada tahap')
    stageBox.dataset.stage = stage
    const waitBox = byId('beta3RoomWaiting')
    waitBox.textContent = waiting ? `${t('Menunggu')}: ${waiting}` : ''
    waitBox.hidden = !waiting

    const photos = byId('beta3RoomPhotos')
    photos.replaceChildren()
    for (const photo of result.photos || []) {
      const figure = el('figure')
      const link = el('a'); link.href = photo.url; link.target = '_blank'; link.rel = 'noopener'
      const img = el('img'); img.src = photo.url; img.alt = photo.product; img.loading = 'lazy'
      link.append(img)
      figure.append(link, el('figcaption', [photo.product, photo.color].filter(Boolean).join(' · ')))
      photos.append(figure)
    }
    photos.hidden = !photos.childElementCount

    const list = byId('beta3RoomPoints')
    list.replaceChildren()
    for (const [label, value] of summaryPoints(result)) {
      const row = el('div')
      if (label) row.append(el('dt', label))
      row.append(el('dd', value))
      list.append(row)
    }
    if (!list.childElementCount) list.append(el('p', t('Belum ada ringkasan dari AI.'), 'wa-muted'))

    const spec = String(result.spec || '').trim()
    const specView = byId('beta3RoomSpecView')
    specView.textContent = spec
    specView.hidden = !spec
  }

  const serviceName = (row) => String(row.service || '').replace(/\d+$/, '')
  const priceText = (row) =>
    `${serviceName(row)} ${new Intl.NumberFormat('id-ID').format(Number(row.price || 0))}${row.etd ? ` (${String(row.etd).replace('day', t('hari'))})` : ''}`
  /** Poin catatan AI + alamat rapi hasil cek ongkir (menggantikan alamat mentah). */
  function summaryPoints(result) {
    const address = result.shippingAddress
    let points = notePoints(result.chatNote)
    if (!address?.full) return points
    points = points.filter(([label]) => label !== pointLabel.alamat)
    const extra = []
    const who = [address.name, address.phone].filter(Boolean).join(' · ')
    if (who) extra.push([t('Penerima'), who])
    extra.push([pointLabel.alamat, address.full])
    if (address.prices?.length && !points.some(([label]) => label === pointLabel.ongkir))
      extra.push([pointLabel.ongkir, address.prices.map(priceText).join(', ')])
    return [...points, ...extra]
  }

  /** Referensi per bagian: gambar + kotak merah yang bisa ditarik ulang, label, catatan. */
  function renderRefs(result) {
    const box = byId('beta3RoomRefs')
    box.replaceChildren()
    const refs = result.refs || []
    byId('beta3RoomRefsCount').textContent = refs.length ? `· ${refs.length}` : ''
    if (!refs.length) box.append(el('p', t('Belum ada referensi. AI menandai otomatis saat pelanggan mengirim contoh bagian.'), 'wa-muted'))
    for (const ref of refs) {
      const card = el('div', undefined, 'wa-b3-ref')
      const stage = el('div', undefined, 'wa-b3-ref-stage')
      const img = el('img'); img.src = ref.image_url; img.alt = ref.part || t('Referensi'); img.draggable = false
      const mark = el('div', undefined, 'wa-b3-ref-box')
      let current = ref.box
      const place = (value) => {
        mark.hidden = !value
        if (!value) return
        const [x, y, w, h] = value
        Object.assign(mark.style, { left: `${x / 10}%`, top: `${y / 10}%`, width: `${w / 10}%`, height: `${h / 10}%` })
      }
      place(current)
      stage.append(img, mark)
      const point = (event) => {
        const rect = stage.getBoundingClientRect()
        return [
          Math.min(1000, Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * 1000))),
          Math.min(1000, Math.max(0, Math.round(((event.clientY - rect.top) / rect.height) * 1000))),
        ]
      }
      let start = null
      stage.addEventListener('pointerdown', (event) => {
        start = point(event)
        stage.setPointerCapture(event.pointerId)
        event.preventDefault()
      })
      stage.addEventListener('pointermove', (event) => {
        if (!start) return
        const [x, y] = point(event)
        place([Math.min(start[0], x), Math.min(start[1], y), Math.abs(x - start[0]) || 1, Math.abs(y - start[1]) || 1])
      })
      stage.addEventListener('pointerup', (event) => {
        if (!start) return
        const [x, y] = point(event)
        const w = Math.abs(x - start[0])
        const h = Math.abs(y - start[1])
        current = w > 15 && h > 15 ? [Math.min(start[0], x), Math.min(start[1], y), w, h] : current
        place(current)
        start = null
        save.classList.add('primary')
      })
      const part = el('input'); part.value = ref.part; part.placeholder = t('Bagian, mis. kerah')
      const note = el('input'); note.value = ref.note; note.placeholder = t('Ciri yang terlihat, mis. hitam mengkilap')
      for (const input of [part, note]) input.addEventListener('input', () => save.classList.add('primary'))
      const save = el('button', t('Simpan'), 'button'); save.type = 'button'
      save.addEventListener('click', async () => {
        try {
          await api(`/api/beta3/refs/${ref.id}`, { part: part.value, note: note.value, box: current })
          notice(t('Referensi disimpan.'))
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      const remove = el('button', t('Hapus'), 'button'); remove.type = 'button'
      remove.addEventListener('click', async () => {
        try {
          await api(`/api/beta3/refs/${ref.id}/delete`, {})
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      const actions = el('div', undefined, 'actions')
      actions.append(save, remove)
      card.append(stage, part, note, actions)
      box.append(card)
    }
    const pick = byId('beta3RoomChatImages')
    pick.replaceChildren()
    const used = new Set(refs.map((ref) => ref.message_id))
    for (const image of result.chatImages || []) {
      const button = el('button', undefined, 'wa-b3-pick-item'); button.type = 'button'
      button.title = image.direction === 'in' ? t('Dari pelanggan') : t('Dikirim toko')
      const thumb = el('img'); thumb.src = image.media_url; thumb.alt = button.title; thumb.loading = 'lazy'
      button.append(thumb, el('small', button.title))
      if (used.has(image.message_id)) button.classList.add('is-used')
      button.addEventListener('click', async () => {
        try {
          await api('/api/beta3/refs', { jid, messageId: image.message_id })
          await load()
        } catch (error) {
          notice(error.message, true)
        }
      })
      pick.append(button)
    }
    if (!pick.childElementCount) pick.append(el('p', t('Belum ada gambar di chat ini.'), 'wa-muted'))
  }

  /** Belum ada form order tapi pelanggan sudah bayar: CS konfirmasi dari ringkasan. */
  function renderManualPaid(box, result, lastOrder) {
    const note = String(result.chatNote || '')
    const points = notePoints(note)
    const pick = (key) => points.find(([label]) => label === (pointLabel[key] || capital(key)))?.[1] || ''
    const waiting = note.match(/menunggu\s*[:=]\s*(.+)/i)?.[1] || ''
    const amount = (waiting.match(/(\d{1,3}(?:\.\d{3})+)/) || [])[1] || ''
    const stage = note.match(/tahap\s*[:=]\s*([a-z_]+)/i)?.[1]?.toLowerCase() || ''
    const details = el('details', undefined, 'wa-b3-manual')
    // Terbuka otomatis hanya bila bukti transfer dicatat AI setelah order terakhir diproses.
    details.open =
      stage === 'bukti_dikirim' &&
      (!lastOrder || new Date(lastOrder.updated_at) < new Date(result.chatUpdatedAt || 0))
    details.append(el('summary', t('Pelanggan sudah bayar tanpa form? Konfirmasi lunas di sini')))
    const form = el('form', undefined, 'wa-cart-form')
    const field = (label, input) => {
      const wrap = el('label')
      wrap.append(el('span', label), input)
      return wrap
    }
    const tidy = result.shippingAddress || {}
    const name = el('input'); name.value = tidy.name || pick('nama') || result.contactName || ''; name.required = true
    const phone = el('input'); phone.inputMode = 'tel'; phone.value = tidy.phone || ''
    const address = el('textarea'); address.rows = 2; address.value = tidy.full || pick('alamat')
    const prices = Array.isArray(tidy.prices) ? tidy.prices : []
    const shipping = el('select')
    shipping.append(new Option(t('Tanpa ongkir / belum dipilih'), ''))
    const mentioned = `${note}\n${result.spec || ''}`.toUpperCase()
    for (const row of prices) {
      const option = new Option(priceText(row), serviceName(row))
      option.dataset.cost = String(row.price)
      if (new RegExp(`\\b${serviceName(row)}\\b`).test(mentioned) && !shipping.value) option.selected = true
      shipping.append(option)
    }
    if (!shipping.value && prices.length === 1) shipping.selectedIndex = 1
    const spec = el('textarea'); spec.rows = 4; spec.required = true
    spec.value =
      String(result.spec || '').trim() ||
      points.filter(([label]) => label && label !== pointLabel.alamat && label !== pointLabel.nama).map(([label, value]) => `${label}: ${value}`).join('\n')
    const total = el('input'); total.inputMode = 'numeric'; total.required = true; total.value = amount
    const submit = el('button', t('Konfirmasi lunas & kirim ke grup'), 'button primary'); submit.type = 'submit'
    form.append(field(t('Nama'), name), field(t('No. HP'), phone), field(t('Alamat'), address))
    if (prices.length) form.append(field(t('Ongkir'), shipping))
    form.append(field(t('Rincian pesanan'), spec), field(t('Total dibayar (Rp)'), total), submit)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      submit.disabled = true
      try {
        const saved = await api('/api/beta3/room/paid', {
          jid,
          customerName: name.value,
          phone: phone.value,
          address: address.value,
          district: tidy.district || '',
          regency: tidy.regency || '',
          postalCode: tidy.postalCode || '',
          shippingService: shipping.value,
          shippingCost: shipping.selectedOptions[0]?.dataset.cost || '',
          spec: spec.value,
          total: total.value,
        })
        notice(saved.groupQueued ? t('Lunas. Pesanan diantrekan ke grup produksi.') : t('Lunas. Grup produksi default belum diatur, tidak dikirim ke grup.'))
        await load()
      } catch (error) {
        notice(error.message, true)
      } finally {
        submit.disabled = false
      }
    })
    details.append(form)
    box.append(details)
  }

  function renderOrder(order, proofs = [], groupPreview = '') {
    const box = byId('beta3RoomOrder')
    box.replaceChildren()
    byId('beta3RoomOrderStatus').textContent = ''
    if (!order) {
      box.append(el('p', t('Belum ada form order dari pelanggan.'), 'wa-muted'))
      if (current) renderManualPaid(box, current, null)
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
    // Order terakhir sudah selesai/batal: pesanan baru tanpa form tetap bisa dikonfirmasi.
    if (['paid', 'cancelled'].includes(order.status) && current) renderManualPaid(box, current, order)
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
      renderRefs(result)
      renderOrder(result.order, result.proofs || [], result.groupPreview || '')
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
