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
  }
  async function call(path, method = 'GET') {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  call('/api/beta3/skill').then(render).catch(() => {})
  byId('skillUpdate').addEventListener('click', async () => {
    const button = byId('skillUpdate')
    button.disabled = true
    byId('skillStatus').textContent = t('Mengambil skill terbaru…')
    try {
      const data = await call('/api/beta3/skill/update', 'POST')
      render(data)
      byId('skillStatus').textContent = data.updated?.length ? t('Skill diperbarui.') : t('Skill sudah yang terbaru.')
    } catch (error) {
      byId('skillStatus').textContent = error.message
    } finally {
      button.disabled = false
    }
  })
})()
