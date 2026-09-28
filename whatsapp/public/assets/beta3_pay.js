// Beta 3: kontrol pembayaran order yang sama untuk halaman Order dan dialog Order di chat.
// Sedikit tombol: nominal dibayar tersimpan otomatis; tombol hanya untuk aksi ke pelanggan/grup.
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
  const amountInput = (value, label) => {
    const input = el('input')
    input.inputMode = 'numeric'
    input.value = format(value)
    input.setAttribute('aria-label', label)
    input.addEventListener('blur', () => (input.value = format(digits(input.value))))
    return input
  }
  // Tanda DP/Lunas di samping nominal.
  const tone = (pill, value, total) => {
    pill.textContent = !total || !value ? '' : value < total ? `${t('DP')} · ${t('Sisa')} ${money(total - value)}` : t('Lunas')
    pill.className = value && total && value < total ? 'wa-pill warn' : 'wa-pill ok'
  }

  /**
   * ctx: { post(path, body), notice(text, error), reload(), groupJid?(), confirmGroup?() }
   * Mengembalikan elemen kontrol untuk order berstatus awaiting_payment / paid, atau null.
   */
  function render(order, ctx) {
    const total = Number(order.total || 0)
    if (order.status === 'awaiting_payment') {
      // Nominal awal dari bukti transfer (dibaca AI); kurang dari total = DP.
      const form = el('form', undefined, 'wa-cart-form wa-b3-pay')
      const input = amountInput(Number(order.reported_amount || 0) || total, t('Nominal dana masuk'))
      input.required = true
      const pill = el('small', '')
      const update = () => tone(pill, digits(input.value), total)
      input.addEventListener('input', update)
      update()
      const submit = el('button', t('Konfirmasi dana masuk'), 'button primary')
      submit.type = 'submit'
      form.append(input, pill, submit)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        if (ctx.confirmGroup && !ctx.confirmGroup()) return
        submit.disabled = true
        try {
          const result = await ctx.post(`/api/beta3/orders/${order.id}/paid`, {
            amount: digits(input.value),
            ...(ctx.groupJid ? { groupJid: ctx.groupJid() || null } : {}),
          })
          ctx.notice(result.dp ? t('DP tercatat. Pesanan dikirim ke grup produksi.') : t('Lunas. Pesanan dikirim ke grup produksi.'))
          await ctx.reload()
        } catch (error) {
          ctx.notice(error.message, true)
        } finally {
          submit.disabled = false
        }
      })
      return form
    }
    if (order.status !== 'paid') return null
    const paid = Number(order.paid_amount || total)
    const box = el('div', undefined, 'wa-b3-after')
    let sisa = Math.max(0, total - paid)
    const readyLabel = () => (sisa > 0 ? t('Pesanan selesai · minta pelunasan') : t('Pesanan selesai · kabari pelanggan'))
    let ready = null

    // Nominal dibayar: langsung diubah, tersimpan otomatis (mis. DP lalu pelunasan). Tanpa pesan ke pelanggan.
    if (total) {
      const row = el('label', undefined, 'wa-b3-pay wa-b3-paid')
      const input = amountInput(paid, t('Nominal dibayar'))
      const pill = el('small', '')
      const state = el('small', '', 'wa-muted')
      state.setAttribute('role', 'status')
      tone(pill, paid, total)
      let saved = paid
      let timer
      const save = async () => {
        clearTimeout(timer)
        const value = digits(input.value)
        if (!value || value === saved) return
        state.textContent = t('Menyimpan…')
        try {
          await ctx.post(`/api/beta3/orders/${order.id}/paid-amount`, { amount: value })
          saved = value
          sisa = Math.max(0, total - value)
          if (ready) ready.textContent = readyLabel()
          state.textContent = t('Tersimpan')
        } catch (error) {
          state.textContent = error.message
        }
      }
      input.addEventListener('input', () => {
        tone(pill, digits(input.value), total)
        clearTimeout(timer)
        timer = setTimeout(save, 900)
      })
      input.addEventListener('blur', save)
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        input.blur()
      })
      row.append(el('span', t('Dibayar')), input, pill, state)
      box.append(row)
    }
    ready = el('button', readyLabel(), order.ready_at ? 'button' : 'button primary')
    ready.type = 'button'
    ready.addEventListener('click', async () => {
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
    box.append(ready)
    if (order.ready_at)
      box.append(
        el(
          'small',
          `${t('Sudah dikabari')} ${new Date(order.ready_at).toLocaleString(window.waI18n?.locale || 'id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
          'wa-note'
        )
      )
    return box
  }

  window.waBeta3Pay = { render }
})()
