// Pengaturan → Berat & ongkir: berat per jenis barang (gram) untuk menghitung ongkir.
;(() => {
  const panel = document.getElementById('settings-weights')
  if (!panel) return
  const byId = (id) => document.getElementById(id)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  async function call(method, body) {
    const response = await fetch(`${base}/api/beta3/weights`, {
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
  const status = (text) => (byId('weightStatus').textContent = text || '')
  function render(types) {
    const box = byId('weightFields')
    box.replaceChildren()
    for (const type of types) {
      const label = document.createElement('label')
      const name = document.createElement('span')
      name.textContent = t(type.label)
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '1'
      input.max = '50000'
      input.step = '10'
      input.inputMode = 'numeric'
      input.value = String(type.grams)
      input.dataset.weightKey = type.key
      input.dataset.settingsIgnore = ''
      input.setAttribute('aria-label', `${t(type.label)} (gram)`)
      // Satuan ditulis di judul kartu (gram), bukan diulang di tiap kolom.
      label.append(name, input)
      box.append(label)
    }
  }
  let loaded = false
  async function load() {
    if (loaded) return
    loaded = true
    try {
      render((await call('GET')).types || [])
    } catch (error) {
      loaded = false
      status(error.message)
    }
  }
  // Tersimpan otomatis saat angka diubah.
  byId('weightFields').addEventListener('change', () => byId('weightSave').click())
  byId('weightSave').addEventListener('click', async () => {
    const weights = {}
    for (const input of panel.querySelectorAll('[data-weight-key]')) weights[input.dataset.weightKey] = Number(input.value)
    byId('weightSave').disabled = true
    status(t('Menyimpan…'))
    try {
      render((await call('POST', { weights })).types || [])
      status(t('Tersimpan'))
    } catch (error) {
      status(error.message)
    } finally {
      byId('weightSave').disabled = false
    }
  })
  new MutationObserver(() => {
    if (!panel.hidden) void load()
  }).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
  if (!panel.hidden) void load()
})()
