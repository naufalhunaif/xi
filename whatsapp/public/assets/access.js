;(() => {
  const card = document.getElementById('accessCard')
  if (!card) return
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (m, i) => args[i] ?? m)
  const appUrl = card.dataset.appUrl.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const $ = (id) => document.getElementById(id)
  const form = $('accessDomainForm')
  const input = $('accessDomain')
  const save = $('accessDomainSave')
  const unset = $('accessDomainUnset')
  const status = $('accessStatus')
  const log = $('accessLog')
  let timer = null

  async function api(path, options = {}) {
    const response = await fetch(`${appUrl}${path}`, {
      ...options,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Permintaan gagal.')
    return data
  }
  function render(state) {
    $('accessUrl').textContent = state.appUrl
    $('accessHintPanel').hidden = !state.aapanel
    $('accessHint').hidden = state.aapanel
    unset.hidden = !state.domain
    if (state.domain && !input.value) input.value = state.domain
    const job = state.job
    const busy = Boolean(job && !job.done)
    save.disabled = busy
    unset.disabled = busy
    if (!job) return
    log.hidden = !job.log
    log.textContent = job.log
    if (!job.done) {
      status.textContent = job.action === 'unset' ? t('Sedang melepas domain…') : t('Sedang memasang domain…')
      if (!timer) timer = window.setTimeout(poll, 3000)
    } else if (job.ok) {
      const target = job.action === 'unset' ? state.appUrl : `https://${job.domain}`
      status.innerHTML = ''
      const link = document.createElement('a')
      link.href = target
      link.textContent = target
      status.append(t('Selesai. Buka {0}', ''), link)
    } else {
      status.textContent = t('Gagal. Lihat log di bawah.')
      log.hidden = false
    }
  }
  async function poll() {
    timer = null
    try {
      render(await api('/api/access'))
    } catch (error) {
      // WEB sedang restart: coba lagi.
      timer = window.setTimeout(poll, 3000)
    }
  }
  async function attach(event) {
    event?.preventDefault?.()
    const domain = input.value.trim().toLowerCase()
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      status.textContent = t('Domain tidak valid. Contoh: wa.contoh.com')
      return
    }
    save.disabled = true
    status.textContent = t('Sedang memasang domain…')
    try {
      render(await api('/api/access/domain', { method: 'POST', body: JSON.stringify({ domain }) }))
    } catch (error) {
      save.disabled = false
      status.textContent = error.message
    }
  }
  save.addEventListener('click', attach)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attach(event)
  })
  unset.addEventListener('click', async () => {
    if (!window.confirm(t('Lepas domain dan kembali ke alamat IP:port?'))) return
    unset.disabled = true
    status.textContent = t('Sedang melepas domain…')
    try {
      render(await api('/api/access/domain/unset', { method: 'POST' }))
    } catch (error) {
      unset.disabled = false
      status.textContent = error.message
    }
  })
  poll()
})()
