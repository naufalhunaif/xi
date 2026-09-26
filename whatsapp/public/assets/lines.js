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

  // Satu daftar nomor. Slot pertama memakai koneksi bawaan, sisanya nomor tambahan;
  // bagi pengguna semuanya sama: bisa ditambah, di-scan, dan dihapus.
  function removeButton(label, path) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'button small'
    button.textContent = t('Hapus')
    button.addEventListener('click', async () => {
      if (!window.confirm(t('Hapus nomor {0}? Chat yang sudah ada tetap tersimpan.', label))) return
      button.disabled = true
      try {
        await call(path, 'POST')
        refresh()
      } catch (error) {
        status(error.message)
        button.disabled = false
      }
    })
    return button
  }
  function appendQr(src, error) {
    if (src) {
      const box = document.createElement('div')
      box.className = 'wa-connect-qr'
      const qr = document.createElement('img')
      qr.className = 'wa-line-qr'
      qr.alt = t('Kode QR')
      qr.src = src
      const note = document.createElement('small')
      note.className = 'wa-note'
      note.textContent = t('Di HP buka Perangkat tertaut → Tautkan perangkat, lalu scan QR ini.')
      box.append(qr, note)
      list.append(box)
    }
    if (error) {
      const alert = document.createElement('p')
      alert.className = 'wa-alert'
      alert.textContent = error
      list.append(alert)
    }
  }
  let primaryActive = false
  function render(data) {
    list.replaceChildren()
    primaryActive = Boolean(data.primary?.active)
    let index = 0
    if (primaryActive) {
      index++
      const label = phoneLabel(data.primary.phone)
      list.append(row(t('Nomor {0}', index), label, data.primary.status, removeButton(label, '/api/disconnect')))
      appendQr(data.primary.qr)
    }
    for (const line of data.lines || []) {
      index++
      const label = phoneLabel(line.phone)
      const button = removeButton(label, `/api/lines/${line.id}/disconnect`)
      button.disabled = line.status === 'disconnecting'
      list.append(row(t('Nomor {0}', index), label, line.status, button))
      appendQr(line.qr, line.error)
    }
    if (!index) {
      const empty = document.createElement('p')
      empty.className = 'wa-note'
      empty.textContent = t('Belum ada nomor. Klik Tambah nomor lalu scan QR dari HP.')
      list.append(empty)
    }
  }

  let timer
  async function refresh() {
    clearTimeout(timer)
    try {
      const data = await call('/api/lines')
      render(data)
      const busy =
        ['qr', 'connecting'].includes(data.primary?.status) ||
        (data.lines || []).some((line) => ['qr', 'connecting', 'disconnecting'].includes(line.status))
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
      // Slot pertama kosong → pakai koneksi bawaan; selebihnya nomor tambahan.
      await call(primaryActive ? '/api/lines' : '/api/connect', 'POST')
      status(t('Menyiapkan QR… scan dari HP (Perangkat tertaut).'))
      refresh()
    } catch (error) {
      status(error.message)
    } finally {
      button.disabled = false
    }
  })
  refresh()
})()
