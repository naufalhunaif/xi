// Beta 3: ringkasan pembayaran order (halaman Order & dialog Order di chat). Tanpa form:
// nominal tampil sebagai teks (klik angka untuk mengoreksi, tersimpan otomatis), satu tombol aksi.
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

  /** Angka yang bisa diklik untuk dikoreksi; onChange dipanggil saat selesai (Enter/blur). */
  function amount(value, label, onChange) {
    const node = el('button', money(value), 'wa-b3-amount')
    node.type = 'button'
    node.title = t('Klik untuk mengoreksi')
    node.setAttribute('aria-label', `${label}: ${money(value)}`)
    node.addEventListener('click', () => {
      const input = el('input')
      input.inputMode = 'numeric'
      input.value = String(value)
      input.className = 'wa-b3-amount-input'
      input.setAttribute('aria-label', label)
      let done = false
      const finish = async (commit) => {
        if (done) return
        done = true
        const next = digits(input.value)
        if (commit && next && next !== value) {
          value = next
          node.textContent = money(value)
          await onChange(value)
        }
        input.replaceWith(node)
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') finish(false)
      })
      input.addEventListener('blur', () => finish(true))
      node.replaceWith(input)
      input.focus()
      input.select()
    })
    return node
  }

  const status = (pill, value, total) => {
    pill.textContent = !total ? '' : value < total ? `${t('DP')} · ${t('Sisa')} ${money(total - value)}` : t('Lunas')
    pill.className = total && value < total ? 'wa-pill warn' : 'wa-pill ok'
  }

  /**
   * ctx: { post(path, body), notice(text, error), reload(), groupJid?(), confirmGroup?() }
   * Mengembalikan elemen untuk order berstatus awaiting_payment / paid, atau null.
   */
  function render(order, ctx) {
    const total = Number(order.total || 0)
    const box = el('div', undefined, 'wa-b3-after')
    const line = el('div', undefined, 'wa-b3-paid')
    const pill = el('small', '')

    if (order.status === 'awaiting_payment') {
      // Nominal dari bukti transfer (dibaca AI); belum ada bukti = total.
      let value = Number(order.reported_amount || 0) || total
      line.append(
        el('span', t('Dana masuk')),
        amount(value, t('Nominal dana masuk'), (next) => {
          value = next
          status(pill, value, total)
        }),
        pill
      )
      status(pill, value, total)
      const confirm = el('button', t('Konfirmasi dana masuk'), 'button primary')
      confirm.type = 'button'
      confirm.addEventListener('click', async () => {
        if (ctx.confirmGroup && !ctx.confirmGroup()) return
        confirm.disabled = true
        try {
          const result = await ctx.post(`/api/beta3/orders/${order.id}/paid`, {
            amount: value,
            ...(ctx.groupJid ? { groupJid: ctx.groupJid() || null } : {}),
          })
          ctx.notice(result.dp ? t('DP tercatat. Pesanan dikirim ke grup produksi.') : t('Lunas. Pesanan dikirim ke grup produksi.'))
          await ctx.reload()
        } catch (error) {
          ctx.notice(error.message, true)
          confirm.disabled = false
        }
      })
      box.append(line, confirm)
      return box
    }
    if (order.status !== 'paid') return null

    let paid = Number(order.paid_amount || total)
    const readyLabel = () =>
      total && paid < total ? t('Pesanan selesai · minta pelunasan') : t('Pesanan selesai · kabari pelanggan')
    const ready = el('button', readyLabel(), order.ready_at ? 'button' : 'button primary')
    if (total) {
      // Koreksi/pelunasan: klik angka, tersimpan otomatis. Tanpa pesan ke pelanggan.
      line.append(
        el('span', t('Dibayar')),
        amount(paid, t('Nominal dibayar'), async (next) => {
          try {
            await ctx.post(`/api/beta3/orders/${order.id}/paid-amount`, { amount: next })
            paid = Math.min(next, total)
            status(pill, paid, total)
            ready.textContent = readyLabel()
            ctx.notice(t('Tersimpan'))
          } catch (error) {
            ctx.notice(error.message, true)
          }
        }),
        pill
      )
      status(pill, paid, total)
      box.append(line)
    }
    ready.type = 'button'
    ready.addEventListener('click', async () => {
      const sisa = Math.max(0, total - paid)
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
