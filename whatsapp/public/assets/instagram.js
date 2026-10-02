// Pengaturan → Instagram: App ID/secret, hubungkan akun, isian webhook untuk Meta.
;(() => {
  const card = document.getElementById('igCard')
  if (!card) return
  const byId = (id) => document.getElementById(id)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  async function call(path, method = 'GET', body) {
    const response = await fetch(`${base}${path}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf, 'X-WhatsApp-Workspace': workspace() },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  const status = (text) => (byId('igStatus').textContent = text || '')
  const when = (ms) =>
    ms ? new Date(ms).toLocaleString(window.waI18n?.locale || 'id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  function render(state) {
    byId('igAppId').value = state.appId || ''
    byId('igAppSecret').value = ''
    byId('igAppSecret').placeholder = state.hasSecret ? t('Tersimpan (isi untuk mengganti)') : ''
    byId('igComments').checked = state.comments !== false
    byId('igWebhookUrl').value = state.webhookUrl || ''
    byId('igVerifyToken').value = state.verifyToken || ''
    byId('igRedirectUri').value = state.redirectUri || ''
    const pill = byId('igState')
    pill.textContent = state.connected ? `@${state.username}` : t('Belum terhubung')
    pill.className = `wa-pill ${state.connected ? 'ok' : ''}`
    byId('igConnect').href = `${base}/instagram/connect`
    byId('igConnect').textContent = state.connected ? t('Hubungkan ulang') : t('Hubungkan Instagram')
    byId('igConnect').classList.toggle('disabled', !state.appId || !state.hasSecret)
    byId('igDisconnect').hidden = !state.connected
    const notice = byId('igNotice')
    const parts = []
    if (state.lastError) parts.push(`⚠ ${t(state.lastError)}`)
    if (state.connected) parts.push(state.lastWebhookAt ? t('Pesan terakhir diterima {0}', when(state.lastWebhookAt)) : t('Belum ada DM/komentar yang diterima.'))
    notice.textContent = parts.join(' · ')
    notice.hidden = !parts.length
    notice.className = state.lastError ? 'wa-alert' : 'wa-note'
  }
  let loaded = false
  async function load() {
    try {
      render(await call('/api/instagram'))
      loaded = true
    } catch (error) {
      status(error.message)
    }
  }
  byId('igSave').addEventListener('click', async () => {
    status(t('Menyimpan…'))
    try {
      const body = { appId: byId('igAppId').value.trim(), comments: byId('igComments').checked }
      if (byId('igAppSecret').value.trim()) body.appSecret = byId('igAppSecret').value.trim()
      render(await call('/api/instagram', 'POST', body))
      status(t('Tersimpan'))
    } catch (error) {
      status(error.message)
    }
  })
  byId('igComments').addEventListener('change', () => byId('igSave').click())
  byId('igConnect').addEventListener('click', (event) => {
    if (byId('igConnect').classList.contains('disabled')) {
      event.preventDefault()
      status(t('Isi App ID dan App Secret lalu simpan dulu.'))
    }
  })
  byId('igDisconnect').addEventListener('click', async () => {
    if (!window.confirm(t('Putuskan akun Instagram? DM tidak akan dibalas sampai dihubungkan lagi.'))) return
    try {
      render(await call('/api/instagram/disconnect', 'POST'))
    } catch (error) {
      status(error.message)
    }
  })
  for (const id of ['igWebhookUrl', 'igVerifyToken', 'igRedirectUri'])
    byId(id).addEventListener('focus', (event) => event.target.select())
  const result = new URLSearchParams(location.search).get('instagram')
  if (result) {
    const messages = {
      connected: t('Instagram terhubung.'),
      cancelled: t('Login Instagram dibatalkan.'),
      failed: t('Gagal menghubungkan Instagram. Lihat pesan di atas.'),
      state: t('Sesi login kedaluwarsa, coba lagi.'),
      missing: t('Isi App ID dan App Secret lalu simpan dulu.'),
    }
    status(messages[result] || '')
    history.replaceState(null, '', location.pathname + location.hash)
  }
  const visible = () => !card.closest('[hidden]')
  const observer = new MutationObserver(() => {
    if (visible() && !loaded) load()
  })
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] })
  if (visible()) load()
  document.addEventListener('ui-language:change', () => loaded && load())
})()
