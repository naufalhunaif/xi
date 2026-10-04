// Pengaturan v3.6: formulir tambah/ubah tampil sebagai jendela mengambang (satu tombol per bagian).
;(() => {
  const byId = (id) => document.getElementById(id)
  const open = (dialog, focus) => {
    if (!dialog || dialog.open) return
    dialog.showModal()
    if (focus) byId(focus)?.focus()
  }
  const close = (dialog) => dialog?.open && dialog.close()
  for (const dialog of document.querySelectorAll('dialog.wa-settings-dialog')) {
    dialog.querySelector('[data-dialog-close]')?.addEventListener('click', () => close(dialog))
    // Klik latar (di luar kartu) menutup.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(dialog)
    })
  }
  // Pembayaran: Tambah metode / Edit → jendela; selesai tersimpan atau Selesai → tutup.
  const payment = byId('paymentDialog')
  if (payment) {
    byId('paymentAddOpen')?.addEventListener('click', () => open(payment, 'paymentName'))
    byId('paymentList')?.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('button')?.hasAttribute('data-payment-edit')) open(payment, 'paymentName')
      },
      true
    )
    const cancel = byId('paymentCancel')
    const status = byId('paymentStatus')
    // Tambah: status "Tersimpan" dengan tombol Selesai tersembunyi = selesai menambah.
    new MutationObserver(() => {
      if (!payment.open || !cancel) return
      if (cancel.hidden && /tersimpan|saved/i.test(status.textContent || '')) setTimeout(() => close(payment), 350)
    }).observe(status, { childList: true, characterData: true, subtree: true })
    // Edit: tombol Selesai kembali tersembunyi = edit selesai.
    if (cancel)
      new MutationObserver(() => {
        if (payment.open && cancel.hidden && !status.classList.contains('error')) setTimeout(() => close(payment), 350)
      }).observe(cancel, { attributes: true, attributeFilter: ['hidden'] })
  }
  // Sumber data MCP.
  const mcp = byId('mcpDialog')
  if (mcp) {
    byId('mcpAddOpen')?.addEventListener('click', () => open(mcp, 'mcpName'))
    const name = byId('mcpName')
    const url = byId('mcpUrl')
    // Berhasil ditambahkan: app.js mengosongkan kedua kolom.
    const check = () => {
      if (mcp.open && name && url && !name.value && !url.value && !byId('mcpAddButton')?.disabled) close(mcp)
    }
    byId('mcpAddButton')?.addEventListener('click', () => {
      const timer = setInterval(() => {
        check()
        if (!mcp.open) clearInterval(timer)
      }, 200)
      setTimeout(() => clearInterval(timer), 15000)
    })
  }
})()
