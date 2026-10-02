// Pengaturan → Backup: hubungkan Google Drive, backup sekarang/otomatis, pulihkan.
;(() => {
  const panel = document.getElementById('settings-backup')
  if (!panel) return
  const byId = (id) => document.getElementById(id)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)
  const when = (value) => new Date(value).toLocaleString(window.waI18n?.locale || 'id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  async function call(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf, 'X-WhatsApp-Workspace': workspace() },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || result.message || t('Permintaan gagal.'))
    return result
  }
  const alert = (text) => (byId('backupAlert').textContent = text || '')
  const status = (text) => (byId('backupStatus').textContent = text || '')
  const setSwitch = (node, on) => {
    node.setAttribute('aria-checked', String(on))
    node.value = String(on)
  }
  let state = null
  let poll = null

  function render() {
    if (!state) return
    const pill = byId('backupDriveState')
    pill.className = `wa-pill ${state.connected ? 'ok' : ''}`
    pill.textContent = state.connected ? (state.email ? `${t('Terhubung')} · ${state.email}` : t('Terhubung')) : t('Belum terhubung')
    byId('backupSetup').hidden = state.connected
    byId('backupConnect').hidden = state.connected
    byId('backupDisconnect').hidden = !state.connected
    byId('backupRedirect').textContent = state.redirectUri
    if (document.activeElement !== byId('backupClientId')) byId('backupClientId').value = state.clientId || ''
    byId('backupClientSecret').placeholder = state.hasSecret ? t('Tersimpan (isi untuk mengganti)') : ''
    setSwitch(byId('backupAuto'), state.auto)
    setSwitch(byId('backupMedia'), state.includeMedia)
    setSwitch(byId('backupIgMedia'), state.igOffload)
    byId('backupIgMedia').disabled = !state.connected
    const last = state.lastBackup
    byId('backupLast').textContent =
      state.running === 'backup'
        ? t('Sedang membuat backup…')
        : last
          ? last.ok
            ? t('Terakhir: {0} · {1}', when(last.at), size(last.size)) +
              (last.media
                ? ` · ${t('media: {0} file baru, total {1}', last.media.uploaded, last.media.total)}${last.media.pending ? ` · ${t('{0} menunggu backup berikutnya', last.media.pending)}` : ''}`
                : '')
            : t('Gagal {0}: {1}', when(last.at), last.error || '')
          : t('Belum pernah backup.')
    byId('backupNow').disabled = !state.connected || Boolean(state.running)
    byId('backupList').disabled = !state.connected || Boolean(state.running)
    if (state.running === 'restore' || (state.restore && !state.restore.ok && !state.restore.error)) status(t('Memulihkan data… jangan tutup halaman.'))
    else if (state.mediaRestoring) status(t('Media chat sedang diunduh bertahap dari Google Drive…'))
    else if (state.restore?.ok) status(t('Pemulihan selesai. Aplikasi dimulai ulang; muat ulang halaman lalu login dengan akun dari backup.'))
    else if (state.restore?.error) status(t('Pemulihan gagal: {0}', state.restore.error))
    clearTimeout(poll)
    if (state.running) poll = setTimeout(load, 3000)
  }
  async function load() {
    try {
      state = await call('/api/backup')
      render()
    } catch (error) {
      if (state?.restore?.ok || state?.running === 'restore') status(t('Aplikasi sedang dimulai ulang… muat ulang halaman sebentar lagi.'))
      else alert(error.message)
    }
  }
  const error = new URLSearchParams(location.search).get('backup_error')
  if (error) alert(error)

  byId('backupConnect').addEventListener('click', async () => {
    alert('')
    try {
      await call('/api/backup/settings', 'POST', {
        clientId: byId('backupClientId').value.trim(),
        clientSecret: byId('backupClientSecret').value.trim(),
      })
      location.href = `${base}/backup/google/connect`
    } catch (e) {
      alert(e.message)
    }
  })
  byId('backupDisconnect').addEventListener('click', async () => {
    if (!confirm(t('Putuskan Google Drive? Backup otomatis berhenti.'))) return
    state = await call('/api/backup/disconnect', 'POST').catch((e) => (alert(e.message), state))
    render()
  })
  byId('backupNow').addEventListener('click', async () => {
    alert('')
    try {
      await call('/api/backup/run', 'POST')
      await load()
    } catch (e) {
      alert(e.message)
    }
  })
  for (const [id, key] of [['backupAuto', 'auto'], ['backupMedia', 'includeMedia'], ['backupIgMedia', 'igOffload']]) {
    byId(id).addEventListener('click', async (event) => {
      event.stopPropagation()
      const on = byId(id).getAttribute('aria-checked') !== 'true'
      setSwitch(byId(id), on)
      try {
        state = { ...state, ...(await call('/api/backup/settings', 'POST', { [key]: on })) }
      } catch (e) {
        alert(e.message)
        setSwitch(byId(id), !on)
      }
    })
  }
  byId('backupList').addEventListener('click', async () => {
    const list = byId('backupItems')
    list.replaceChildren(el('li', 'wa-empty', t('Memuat…')))
    try {
      const { backups } = await call('/api/backup/list')
      list.replaceChildren()
      if (!backups.length) list.append(el('li', 'wa-empty', t('Belum ada backup di Google Drive.')))
      for (const item of backups) {
        const row = el('li', 'wa-quality-item')
        row.append(el('span', '', `${when(item.createdAt)} · ${size(item.size)}`))
        const restore = el('button', 'button small', t('Pulihkan'))
        restore.type = 'button'
        restore.addEventListener('click', async () => {
          const typed = prompt(t('Semua data di server ini akan ditimpa dengan backup {0}. Ketik PULIHKAN untuk lanjut.', when(item.createdAt)))
          if (typed !== 'PULIHKAN') return
          try {
            await call('/api/backup/restore', 'POST', { id: item.id, confirm: 'PULIHKAN' })
            status(t('Memulihkan data… jangan tutup halaman.'))
            setTimeout(load, 3000)
          } catch (e) {
            alert(e.message)
          }
        })
        row.append(restore)
        list.append(row)
      }
    } catch (e) {
      list.replaceChildren()
      alert(e.message)
    }
  })
  panel.addEventListener('click', async (event) => {
    const copy = event.target.closest?.('[data-copy]')
    if (!copy) return
    await navigator.clipboard?.writeText(byId(copy.dataset.copy)?.textContent || '').catch(() => {})
    copy.textContent = t('Tersalin')
    setTimeout(() => (copy.textContent = t('Salin')), 1500)
  })
  new MutationObserver(() => !panel.hidden && load()).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
  if (!panel.hidden) load()
})()
