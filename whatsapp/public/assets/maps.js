// Pengaturan → Google Maps (v3.6.98): kunci API untuk mencari alamat pelanggan seperti CS membuka Google Maps.
;(() => {
  const panel = document.getElementById('settings-maps')
  if (!panel) return
  const byId = (id) => document.getElementById(id)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  async function call(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
        'X-WhatsApp-Workspace': workspace(),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  const status = (text) => (byId('mapsStatus').textContent = text || '')
  function paint(state) {
    const pill = byId('mapsState')
    pill.textContent = state.configured ? t('Aktif') : t('Belum ada kunci')
    pill.className = `wa-pill ${state.configured ? 'ok' : 'warn'}`
    byId('mapsKey').placeholder = state.configured ? t('(tersimpan — isi untuk mengganti)') : 'AIza…'
    byId('mapsRemove').hidden = !state.configured
    status(state.lastError ? `${t('Masalah terakhir')}: ${state.lastError}` : '')
  }
  async function load() {
    try {
      paint(await call('/api/beta3/maps'))
    } catch (error) {
      status(error.message)
    }
  }
  byId('mapsSave').addEventListener('click', async () => {
    try {
      paint(await call('/api/beta3/maps', 'POST', { apiKey: byId('mapsKey').value }))
      byId('mapsKey').value = ''
      status(t('Tersimpan.'))
    } catch (error) {
      status(error.message)
    }
  })
  byId('mapsRemove').addEventListener('click', async () => {
    try {
      paint(await call('/api/beta3/maps', 'POST', { removeKey: true }))
    } catch (error) {
      status(error.message)
    }
  })
  byId('mapsTest').addEventListener('click', async () => {
    status(t('Menguji…'))
    try {
      const result = await call('/api/beta3/maps/test', 'POST', {})
      status(t('Tersambung ({0} ms): {1}', result.ms, result.display))
    } catch (error) {
      status(error.message)
    }
  })
  load()
})()
