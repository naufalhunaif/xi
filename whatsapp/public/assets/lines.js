;(() => {
  const card = document.getElementById('linesCard')
  if (!card) return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const list = byId('linesList')
  const status = (text) => (byId('linesStatus').textContent = text || '')
  const phoneLabel = (phone) => (phone ? `+${phone}` : t('Menunggu scan QR'))
  const pill = (state) => {
    const map = {
      connected: [t('Terhubung'), 'ok'],
      qr: [t('Scan QR'), 'warn'],
      connecting: [t('Menghubungkan'), 'warn'],
      disconnecting: [t('Memutuskan'), 'warn'],
      offline: [t('Offline'), 'err'],
      error: [t('Gagal'), 'err'],
      disconnected: [t('Terputus'), 'err'],
    }
    const [label, tone] = map[state] || [state || '—', '']
    const el = document.createElement('span')
    el.className = `wa-pill ${tone}`
    el.textContent = label
    return el
  }

  async function call(path, method = 'GET') {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
        'X-WhatsApp-Workspace': workspace(),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }

  function row(label, value, state, extra) {
    const item = document.createElement('div')
    item.className = 'wa-kv-row'
    const name = document.createElement('span')
    name.textContent = label
    const main = document.createElement('code')
    main.textContent = value
    const side = document.createElement('div')
    side.className = 'actions'
    side.append(pill(state))
    if (extra) side.append(extra)
    item.append(name, main, side)
    return item
  }

  function render(data) {
    list.replaceChildren()
    // Nomor utama dikelola di kartu atasnya (Hubungkan/Putuskan + QR).
    for (const line of data.lines || []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'button small'
      button.textContent = t('Putuskan')
      button.disabled = line.status === 'disconnecting'
      button.addEventListener('click', async () => {
        if (!window.confirm(t('Putuskan nomor {0}? Chat yang sudah ada tetap tersimpan.', phoneLabel(line.phone)))) return
        try {
          await call(`/api/lines/${line.id}/disconnect`, 'POST')
          refresh()
        } catch (error) {
          status(error.message)
        }
      })
      list.append(row(t('Nomor tambahan'), phoneLabel(line.phone), line.status, button))
      if (line.qr) {
        const qr = document.createElement('img')
        qr.className = 'wa-line-qr'
        qr.alt = t('Kode QR')
        qr.src = line.qr
        list.append(qr)
      }
      if (line.error) {
        const error = document.createElement('p')
        error.className = 'wa-alert'
        error.textContent = line.error
        list.append(error)
      }
    }
  }

  let timer
  async function refresh() {
    clearTimeout(timer)
    try {
      const data = await call('/api/lines')
      render(data)
      const busy = (data.lines || []).some((line) => ['qr', 'connecting', 'disconnecting'].includes(line.status))
      timer = setTimeout(refresh, busy ? 3000 : 15000)
    } catch (error) {
      status(error.message)
      timer = setTimeout(refresh, 15000)
    }
  }
  byId('lineAdd').addEventListener('click', async () => {
    const button = byId('lineAdd')
    button.disabled = true
    try {
      await call('/api/lines', 'POST')
      status(t('Menyiapkan QR… scan dari HP nomor tambahan (Perangkat tertaut).'))
      refresh()
    } catch (error) {
      status(error.message)
    } finally {
      button.disabled = false
    }
  })
  refresh()
})()
