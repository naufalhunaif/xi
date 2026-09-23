;(() => {
  const button = document.getElementById('contactDeleteButton')
  const jid = document.getElementById('messages')?.dataset.jid
  const dialog = document.getElementById('contactDeleteDialog')
  if (!button || !jid || !dialog) return
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const input = document.getElementById('contactDeleteConfirmation')
  const submit = document.getElementById('contactDeleteConfirm')
  const status = document.getElementById('contactDeleteStatus')
  const t = (text) => window.waI18n?.t(text) || text
  let target = null,
    requestId = null,
    busy = false,
    polling = false,
    opening = 0,
    uncertain = false
  const render = () => {
    input.disabled = !target || busy || uncertain
    submit.disabled = !target || busy || uncertain || input.value !== target.confirmation
    button.disabled = busy || uncertain
  }
  const read = async (response) => {
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Permintaan gagal.')
    return data
  }
  async function check() {
    if (!requestId || polling || document.hidden) return
    polling = true
    try {
      const data = await read(
        await fetch(`${base}/api/chats/cleanup`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
      )
      // Never mistake an older or another customer's job for our deletion.
      if (data.requestId !== requestId) return
      if (data.status === 'completed') {
        requestId = null
        busy = false
        status.textContent = t('Data pelanggan telah dihapus.')
        // Discard stale room, cart and memory shown in this browser.
        location.replace(`${base}/`)
      } else
        status.textContent = t(
          data.status === 'retrying'
            ? 'Penghapusan belum selesai. Mencoba kembali…'
            : 'Menghapus data pelanggan…'
        )
    } catch {
      status.textContent = t(
        'Status penghapusan belum tersedia. Muat ulang untuk memeriksa; jangan kirim ulang penghapusan.'
      )
    } finally {
      polling = false
      render()
    }
  }
  button.addEventListener('click', async () => {
    if (busy || uncertain) return
    const version = ++opening
    target = null
    input.value = ''
    document.getElementById('contactDeleteIdentity').textContent = ''
    document.getElementById('contactDeleteExpected').textContent = ''
    document.getElementById('contactDeleteCounts').replaceChildren()
    status.textContent = t('Memuat…')
    render()
    dialog.showModal()
    try {
      const data = await read(
        await fetch(`${base}/api/chats/cleanup/contact?jid=${encodeURIComponent(jid)}`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
      )
      if (version !== opening || !dialog.open) return
      target = data
      document.getElementById('contactDeleteIdentity').textContent = [
        data.name,
        data.phone ? `+${data.phone}` : data.jid,
      ]
        .filter(Boolean)
        .join(' · ')
      document.getElementById('contactDeleteExpected').textContent = data.confirmation
      for (const [key, label] of Object.entries({
        messages: 'Pesan',
        memory: 'Ingatan AI',
        orders: 'Order',
        carts: 'Cart',
        media: 'Pesan bermedia',
      })) {
        const dt = document.createElement('dt'),
          dd = document.createElement('dd')
        dt.textContent = t(label)
        dd.textContent = String(data.counts[key] || 0)
        document.getElementById('contactDeleteCounts').append(dt, dd)
      }
      status.textContent = ''
      render()
      input.focus()
    } catch (error) {
      status.textContent = t(error.message || 'Permintaan gagal.')
    }
  })
  input.addEventListener('input', render)
  submit.addEventListener('click', async () => {
    if (submit.disabled || !target || busy) return
    busy = true
    render()
    status.textContent = t('Menghapus data pelanggan…')
    try {
      const response = await fetch(`${base}/api/chats/cleanup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ mode: 'contact', jid: target.jid, confirmation: input.value }),
      })
      // Explicit client-side rejection is safe to correct. A lost/5xx response is ambiguous.
      if (response.status >= 400 && response.status < 500) {
        busy = false
        await read(response)
      }
      const data = await read(response)
      if (!data.requestId) throw new Error('Status penghapusan belum tersedia.')
      requestId = data.requestId
      await check()
    } catch (error) {
      uncertain = busy
      status.textContent = uncertain
        ? t(
            'Status penghapusan belum tersedia. Muat ulang untuk memeriksa; jangan kirim ulang penghapusan.'
          )
        : t(error.message || 'Permintaan gagal.')
      render()
    }
  })
  document.getElementById('contactDeleteClose').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    opening++
    if (!button.disabled) button.focus()
  })
  window.setInterval(check, 2500)
})()
