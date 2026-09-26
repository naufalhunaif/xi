;(() => {
  const card = document.getElementById('igCard')
  if (!card) return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const switches = [...card.querySelectorAll('[data-ig]')]
  const message = (text) => (byId('igMessage').textContent = text || '')
  const when = (value) =>
    new Intl.DateTimeFormat(window.waI18n?.locale || 'id-ID', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))

  function render(data) {
    const pill = byId('igPill')
    pill.className = `wa-pill ${data.connected ? (data.lastError ? 'warn' : 'ok') : ''}`
    pill.textContent = data.connected ? (data.lastError ? t('Perlu dicek') : t('Terhubung')) : t('Belum terhubung')
    byId('igStatus').textContent = data.connected ? `@${data.username || '—'}` : t('Belum terhubung')
    byId('igWebhook').textContent = !data.connected
      ? t('DM masuk ke inbox dan dijawab AI. Komentar dibalas singkat lalu diarahkan ke DM atau WhatsApp.')
      : data.lastWebhookAt
        ? `${t('Webhook terakhir diterima: {0}', when(data.lastWebhookAt))}${data.lastWebhookNote ? ` · ${data.lastWebhookNote}` : ''}`
        : t('Belum ada webhook yang masuk dari Meta.')
    byId('igError').textContent = data.lastError || ''
    byId('igDisconnect').hidden = !data.connected
    byId('igAppId').value = data.appId || ''
    byId('igAppSecret').value = ''
    byId('igAppSecret').placeholder = data.hasSecret ? t('Tersimpan — isi untuk mengganti') : ''
    byId('igAccessToken').placeholder = data.connected ? t('Tersimpan — isi untuk mengganti') : ''
    byId('igCallbackUrl').textContent = data.callbackUrl
    byId('igWebhookUrl').textContent = data.webhookUrl
    byId('igVerifyToken').textContent = data.verifyToken
    byId('igPrivacyUrl').textContent = data.privacyUrl || ''
    byId('igDeletionUrl').textContent = data.deletionUrl || ''
    byId('igCommentTarget').value = data.commentTarget || 'both'
    for (const toggle of switches) {
      const on = Boolean(data[toggle.dataset.ig])
      toggle.value = String(on)
      toggle.setAttribute('aria-checked', String(on))
    }
    const c = data.comments || {}
    const done = (c.done || 0) + (c.hidden || 0) + (c.spam || 0)
    byId('igStats').textContent = data.connected
      ? t('Komentar 7 hari: {0} ditangani, {1} gagal, {2} antre', done, c.failed || 0, (c.new || 0) + (c.processing || 0))
      : ''
  }

  async function call(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  async function save(values) {
    try {
      render(await call('/api/instagram', 'POST', values))
      return true
    } catch (error) {
      message(error.message)
      return false
    }
  }
  const credentials = () => {
    const values = { appId: byId('igAppId').value.trim() }
    if (byId('igAppSecret').value.trim()) values.appSecret = byId('igAppSecret').value.trim()
    return values
  }

  call('/api/instagram').then(render).catch(() => {})
  const result = new URLSearchParams(window.location.search).get('instagram')
  if (result === 'connected') message(t('Instagram terhubung.'))
  else if (result === 'failed') message(t('Gagal menghubungkan Instagram.'))
  else if (result === 'missing') message(t('Isi App ID dan App Secret dulu.'))

  byId('igSaveToken').addEventListener('click', async () => {
    const button = byId('igSaveToken')
    const accessToken = byId('igAccessToken').value.trim()
    button.disabled = true
    message(accessToken ? t('Memeriksa token…') : t('Menyimpan…'))
    try {
      if (!(await save(credentials()))) return
      if (accessToken) {
        render(await call('/api/instagram/token', 'POST', { accessToken }))
        byId('igAccessToken').value = ''
        message(t('Instagram terhubung.'))
      } else message(t('Tersimpan.'))
    } catch (error) {
      message(error.message)
    } finally {
      button.disabled = false
    }
  })
  byId('igConnect').addEventListener('click', async () => {
    if (!(await save(credentials()))) return
    window.location.href = `${base}/instagram/connect`
  })
  byId('igDisconnect').addEventListener('click', async () => {
    if (!window.confirm(t('Putuskan Instagram? DM dan komentar baru tidak akan diproses.'))) return
    try {
      render(await call('/api/instagram/disconnect', 'POST'))
      message(t('Instagram diputuskan.'))
    } catch (error) {
      message(error.message)
    }
  })
  card.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]')
    if (!button) return
    try {
      await navigator.clipboard.writeText(byId(button.dataset.copy).textContent || '')
      button.textContent = t('Tersalin')
      setTimeout(() => (button.textContent = t('Salin')), 1500)
    } catch {
      message(t('Salin manual: pilih teksnya lalu tekan Ctrl/Cmd+C.'))
    }
  })
  byId('igCommentTarget').addEventListener('change', (event) => {
    event.stopPropagation()
    save({ commentTarget: event.target.value }).then((ok) => ok && message(t('Tersimpan.')))
  })
  for (const toggle of switches)
    toggle.addEventListener('change', () =>
      save({ [toggle.dataset.ig]: toggle.value === 'true' }).then((ok) => ok && message(t('Tersimpan.')))
    )
})()
