;(() => {
  const card = document.getElementById('skillCard')
  if (!card) return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const when = (value, id) => {
    const node = byId(id)
    node.title = value ? window.waTime.full(value) : ''
    node.textContent = value ? window.waTime.ago(value) : '—'
  }
  function render(data) {
    byId('skillName').textContent = data.name || '—'
    byId('skillSource').textContent = data.installed ? `(${data.source === 'online' ? t('dari rilis online') : t('bawaan aplikasi')})` : t('(belum terpasang)')
    when(data.updatedAt, 'skillUpdated')
    when(data.checkedAt, 'skillChecked')
    byId('skillContent').textContent = data.content || ''
    // v3.6.39: skill ringkas (digest) — isi sama, format ringkas; mati = skill asli dikirim ke AI.
    const digest = data.digest || {}
    const toggle = byId('skillDigestToggle')
    toggle.setAttribute('aria-checked', String(!digest.off))
    byId('skillDigestInfo').textContent = digest.ready
      ? `${digest.off ? t('Mati — skill asli dipakai') : t('Aktif')} · ${t('{0} → {1} token', digest.originalTokens.toLocaleString('id-ID'), digest.digestTokens.toLocaleString('id-ID'))}${digest.fallback?.length ? ` · ${t('{0} bagian memakai teks asli', digest.fallback.length)}` : ''}`
      : t('Sedang disiapkan — skill asli dipakai dulu')
    byId('skillDigestContent').textContent = digest.content || '—'
  }
  async function call(path, method = 'GET', body = {}) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
        'X-WhatsApp-Workspace': document.querySelector('meta[name="whatsapp-workspace"]')?.content || '',
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  let current = null
  call('/api/beta3/skill')
    .then((data) => render((current = data)))
    .catch(() => {})
  byId('skillDigestToggle').addEventListener('click', async () => {
    try {
      current = await call('/api/beta3/skill/digest', 'POST', { off: !current?.digest?.off })
      render(current)
      byId('skillStatus').textContent = t('Tersimpan')
    } catch (error) {
      byId('skillStatus').textContent = error.message
    }
  })
  byId('skillUpdate').addEventListener('click', async () => {
    const button = byId('skillUpdate')
    button.disabled = true
    byId('skillStatus').textContent = t('Mengambil skill terbaru…')
    try {
      const data = await call('/api/beta3/skill/update', 'POST')
      render((current = data))
      byId('skillStatus').textContent = data.updated?.length ? t('Skill diperbarui.') : t('Skill sudah yang terbaru.')
    } catch (error) {
      byId('skillStatus').textContent = error.message
    } finally {
      button.disabled = false
    }
  })
})()
