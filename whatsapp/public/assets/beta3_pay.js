// Beta 3: pembayaran order (halaman Order & dialog Order di chat), sesederhana mungkin:
// satu baris "Dana masuk / Dibayar" di rincian biaya (readonly; klik untuk mengubah, tersimpan
// otomatis) + tombol aksi di baris tombol yang sudah ada (sebelah "Kirim ulang ke grup").
;(() => {
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const money = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const format = (n) => (n ? new Intl.NumberFormat('id-ID').format(n) : '')
  const digits = (value) => Number(String(value || '').replace(/\D/g, '')) || 0
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }

  /**
   * ctx: { post(path, body), notice(text, error), reload(), groupJid?(), confirmGroup?() }
   * Mengembalikan { row, buttons } untuk order awaiting_payment / paid, atau null.
   */
  function create(order, ctx) {
    if (!['awaiting_payment', 'paid'].includes(order.status)) return null
    const total = Number(order.total || 0)
    const waiting = order.status === 'awaiting_payment'
    // Menunggu bayar: nominal dari bukti transfer (dibaca AI). Belum terbaca = kosong, diisi CS
    // (tidak diisi total: DP bisa terkonfirmasi sebagai lunas).
    let value = waiting ? Number(order.reported_amount || 0) : Number(order.paid_amount || total)
    let saved = value
    let ready = null

    const row = el('div', undefined, 'wa-b3-dp-row')
    const input = el('input', undefined, 'wa-b3-dp')
    input.inputMode = 'numeric'
    input.readOnly = true
    input.value = format(value)
    input.placeholder = t('Isi nominal')
    input.title = t('Klik untuk mengubah')
    input.setAttribute('aria-label', waiting ? t('Nominal dana masuk') : t('Nominal dibayar'))
    const pill = el('small', '')
    const paint = () => {
      if (!value) {
        pill.textContent = t('Cek nominal di bukti transfer')
        pill.className = 'wa-pill warn'
        return
      }
      pill.textContent = !total ? '' : value < total ? `${t('DP')} · ${t('Sisa')} ${money(total - value)}` : t('Lunas')
      pill.className = total && value < total ? 'wa-pill warn' : 'wa-pill ok'
    }
    paint()
    input.addEventListener('click', () => {
      if (!input.readOnly) return
      input.readOnly = false
      input.select()
    })
    input.addEventListener('input', () => {
      value = digits(input.value)
      paint()
    })
    const lock = async () => {
      if (input.readOnly) return
      input.readOnly = true
      value = digits(input.value) || saved
      input.value = format(value)
      paint()
      // Sudah dibayar: koreksi tersimpan otomatis (tanpa pesan ke pelanggan).
      if (!waiting && value !== saved) {
        try {
          await ctx.post(`/api/beta3/orders/${order.id}/paid-amount`, { amount: value })
          saved = value
          if (ready) ready.textContent = readyLabel()
          ctx.notice(t('Tersimpan'))
        } catch (error) {
          ctx.notice(error.message, true)
        }
      }
    }
    input.addEventListener('blur', lock)
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      input.blur()
    })
    const cell = el('dd')
    cell.append(input, pill)
    row.append(el('dt', waiting ? t('Dana masuk') : t('Dibayar')), cell)
    // Bukti pelunasan dari pelanggan (DP) tampil kecil di bawah nominal.
    if (!waiting && order.settlement?.images?.length) {
      const shots = el('div', undefined, 'wa-beta3-proofs')
      shots.append(el('small', t('Ada bukti pelunasan')))
      for (const url of order.settlement.images) {
        const link = el('a')
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener'
        const img = el('img')
        img.src = url
        img.alt = t('Ada bukti pelunasan')
        img.loading = 'lazy'
        link.append(img)
        shots.append(link)
      }
      cell.append(shots)
    }

    const buttons = []
    if (waiting) {
      const confirm = el('button', t('Konfirmasi dana masuk'), 'button primary')
      confirm.type = 'button'
      confirm.addEventListener('click', async () => {
        if (!(digits(input.value) || value)) {
          ctx.notice(t('Isi nominal dana masuk dulu.'), true)
          input.readOnly = false
          input.focus()
          return
        }
        if (ctx.confirmGroup && !ctx.confirmGroup()) return
        confirm.disabled = true
        try {
          const result = await ctx.post(`/api/beta3/orders/${order.id}/paid`, {
            amount: digits(input.value) || value,
            ...(ctx.groupJid ? { groupJid: ctx.groupJid() || null } : {}),
          })
          ctx.notice(result.dp ? t('DP tercatat. Pesanan dikirim ke grup produksi.') : t('Lunas. Pesanan dikirim ke grup produksi.'))
          await ctx.reload()
        } catch (error) {
          ctx.notice(error.message, true)
          confirm.disabled = false
        }
      })
      buttons.push(confirm)
      return { row, buttons }
    }

    // DP: pelanggan sudah mengirim bukti pelunasan → konfirmasi seperti pembayaran awal.
    const settle = order.settlement
    if (settle && settle.amount > 0) {
      const confirmSettle = el('button', `${t('Konfirmasi pelunasan')} ${money(settle.amount)}`, 'button primary')
      confirmSettle.type = 'button'
      confirmSettle.addEventListener('click', async () => {
        if (!window.confirm(t('Pelunasan {0} sudah masuk? Pelanggan akan dikabari.', money(settle.amount)))) return
        confirmSettle.disabled = true
        try {
          const result = await ctx.post(`/api/beta3/orders/${order.id}/settle`, { amount: settle.amount })
          ctx.notice(result.lunas ? t('Lunas. Pelanggan sudah dikabari.') : t('Pelunasan tercatat. Pelanggan sudah dikabari.'))
          await ctx.reload()
        } catch (error) {
          ctx.notice(error.message, true)
          confirmSettle.disabled = false
        }
      })
      buttons.push(confirmSettle)
    }

    const readyLabel = () => (total && saved < total ? t('Selesai · minta pelunasan') : t('Selesai · kabari pelanggan'))
    // Sudah dikirim (ada resi): tidak perlu kabari pesanan selesai lagi.
    if (order.shipped) return { row, buttons }
    ready = el('button', readyLabel(), 'button')
    ready.type = 'button'
    if (order.ready_at)
      ready.title = `${t('Sudah dikabari')} ${new Date(order.ready_at).toLocaleString(window.waI18n?.locale || 'id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    ready.addEventListener('click', async () => {
      const sisa = Math.max(0, total - saved)
      const question = sisa > 0 ? t('Kabari pelanggan pesanan selesai dan minta pelunasan {0}?', money(sisa)) : t('Kabari pelanggan pesanan selesai?')
      if (!window.confirm(question)) return
      ready.disabled = true
      try {
        await ctx.post(`/api/beta3/orders/${order.id}/ready`, {})
        ctx.notice(t('Pelanggan sudah dikabari.'))
        await ctx.reload()
      } catch (error) {
        ctx.notice(error.message, true)
        ready.disabled = false
      }
    })
    buttons.push(ready)
    return { row, buttons }
  }

  window.waBeta3Pay = { create }
})()
