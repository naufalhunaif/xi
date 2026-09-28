// Beta 3: kontrol pembayaran order yang sama untuk halaman Order dan dialog Order di chat.
// Dana masuk (DP/Lunas), ubah nominal dibayar, pelunasan, dan kabar "pesanan selesai".
;(() => {
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const money = (n) => 'Rp' + new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const digits = (value) => Number(String(value || '').replace(/\D/g, '')) || 0
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }

  /** Isian nominal: terkunci (readonly), tombol Edit membuka bila perlu. */
  function amountField(value, label) {
    const input = el('input')
    input.inputMode = 'numeric'
    input.required = true
    input.readOnly = true
    input.value = value ? new Intl.NumberFormat('id-ID').format(value) : ''
    input.setAttribute('aria-label', label)
    const edit = el('button', t('Edit'), 'button small')
    edit.type = 'button'
    edit.addEventListener('click', () => {
      input.readOnly = false
      edit.hidden = true
      input.focus()
      input.select()
    })
    if (!input.value) {
      input.readOnly = false
      edit.hidden = true
    }
    return { input, edit }
  }

  function form(parts, label, onSubmit) {
    const node = el('form', undefined, 'wa-cart-form wa-b3-pay')
    const submit = el('button', label, 'button primary')
    submit.type = 'submit'
    node.append(...parts, submit)
    node.addEventListener('submit', async (event) => {
      event.preventDefault()
      submit.disabled = true
      try {
        await onSubmit()
      } finally {
        submit.disabled = false
      }
    })
    return node
  }

  /**
   * ctx: { post(path, body), notice(text, error), reload(), groupJid?() , confirmGroup?() }
   * Mengembalikan elemen kontrol untuk order berstatus awaiting_payment / paid, atau null.
   */
  function render(order, ctx) {
    const total = Number(order.total || 0)
    const run = async (task) => {
      try {
        await task()
        await ctx.reload()
      } catch (error) {
        ctx.notice(error.message, true)
      }
    }
    if (order.status === 'awaiting_payment') {
      // Nominal awal dari bukti transfer (dibaca AI); kurang dari total = DP.
      const { input, edit } = amountField(Number(order.reported_amount || 0) || total, t('Nominal dana masuk'))
      const hint = el('small', '')
      const update = () => {
        const value = digits(input.value)
        hint.textContent = !total || !value ? '' : value < total ? `${t('DP')} · ${t('Sisa')} ${money(total - value)}` : t('Lunas')
        hint.className = value && total && value < total ? 'wa-pill warn' : 'wa-pill ok'
      }
      input.addEventListener('input', update)
      update()
      return form([input, edit, hint], t('Konfirmasi dana masuk'), () =>
        run(async () => {
          if (ctx.confirmGroup && !ctx.confirmGroup()) return
          const result = await ctx.post(`/api/beta3/orders/${order.id}/paid`, {
            amount: input.value,
            ...(ctx.groupJid ? { groupJid: ctx.groupJid() || null } : {}),
          })
          ctx.notice(result.dp ? t('DP tercatat. Pesanan dikirim ke grup produksi.') : t('Lunas. Pesanan dikirim ke grup produksi.'))
        })
      )
    }
    if (order.status !== 'paid') return null
    const paid = Number(order.paid_amount || total)
    const sisa = Math.max(0, total - paid)
    const box = el('div', undefined, 'wa-b3-after')

    // Nominal dibayar: teks ringkas; "Ubah" membuka isian koreksi (mis. tercatat lunas padahal DP).
    if (total) {
      const line = el('div', undefined, 'wa-b3-paid')
      line.append(el('span', `${t('Dibayar')} ${money(paid)}${sisa > 0 ? ` · ${t('Sisa')} ${money(sisa)}` : ` · ${t('Lunas')}`}`))
      const change = el('button', t('Ubah'), 'button small')
      change.type = 'button'
      const input = el('input')
      input.inputMode = 'numeric'
      input.required = true
      input.value = new Intl.NumberFormat('id-ID').format(paid)
      input.setAttribute('aria-label', t('Nominal dibayar'))
      const fix = form([input], t('Simpan'), () =>
        run(async () => {
          await ctx.post(`/api/beta3/orders/${order.id}/paid-amount`, { amount: input.value })
          ctx.notice(t('Nominal dibayar disimpan.'))
        })
      )
      fix.hidden = true
      change.addEventListener('click', () => {
        fix.hidden = false
        change.hidden = true
        input.focus()
        input.select()
      })
      line.append(change)
      box.append(line, fix)
    }
    if (sisa > 0) {
      const { input, edit } = amountField(sisa, t('Nominal pelunasan'))
      box.append(
        form([input, edit], t('Pelunasan masuk'), () =>
          run(async () => {
            const result = await ctx.post(`/api/beta3/orders/${order.id}/settle`, { amount: input.value })
            ctx.notice(result.lunas ? t('Lunas.') : t('Pembayaran tercatat.'))
          })
        )
      )
    }
    const ready = el(
      'button',
      sisa > 0 ? t('Pesanan selesai · minta pelunasan') : t('Pesanan selesai · kabari pelanggan'),
      order.ready_at ? 'button' : 'button primary'
    )
    ready.type = 'button'
    ready.addEventListener('click', () =>
      run(async () => {
        const question = sisa > 0 ? t('Kabari pelanggan pesanan selesai dan minta pelunasan {0}?', money(sisa)) : t('Kabari pelanggan pesanan selesai?')
        if (!window.confirm(question)) return
        ready.disabled = true
        await ctx.post(`/api/beta3/orders/${order.id}/ready`, {})
        ctx.notice(t('Pelanggan sudah dikabari.'))
      })
    )
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
