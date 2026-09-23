;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const byId = (id) => document.getElementById(id)
  const panel = byId('settings-payments')
  if (!panel) return
  const list = byId('paymentList')
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  let editing = null
  let busy = false
  let saveTimer = null
  let savedBody = ''
  const fields = ['paymentName', 'paymentDestination', 'paymentAccountName', 'paymentEnabled']
  function status(text, error = false) {
    byId('paymentStatus').textContent = text
    byId('paymentStatus').classList.toggle('error', error)
  }
  function reset() {
    clearTimeout(saveTimer)
    saveTimer = null
    savedBody = ''
    editing = null
    for (const id of fields.slice(0, 3)) byId(id).value = ''
    byId('paymentEnabled').value = 'true'
    byId('paymentEnabled').setAttribute('aria-checked', 'true')
    byId('paymentSave').hidden = false
    byId('paymentSave').textContent = t('Tambah')
    byId('paymentCancel').hidden = true
  }
  function node(tag, text, className) {
    const element = document.createElement(tag)
    element.textContent = text
    if (className) element.className = className
    return element
  }
  function render(methods) {
    list.replaceChildren()
    if (!methods.length) list.append(node('div', t('Belum ada metode pembayaran'), 'wa-skill-empty'))
    for (const method of methods) {
      const row = node('div', '', 'wa-payment-row')
      Object.assign(row.dataset, { paymentId: method.id, name: method.name, destination: method.destination,
        accountName: method.accountName, enabled: String(method.enabled) })
      const details = node('div', '', 'wa-payment-details')
      details.append(node('strong', method.name), node('span', method.destination))
      if (method.accountName) details.append(node('span', method.accountName))
      details.append(node('small', method.enabled ? t('Aktif') : t('Nonaktif')))
      const actions = node('div', '', 'wa-payment-actions')
      for (const [action, label] of [['paymentEdit', 'Edit'], ['paymentDelete', t('Hapus')]]) {
        const button = node('button', label, 'button')
        button.type = 'button'
        button.dataset[action] = ''
        button.setAttribute('aria-label', `${label} ${method.name}`)
        actions.append(button)
      }
      row.append(details, actions)
      list.append(row)
    }
  }
  async function request(path, method, body = {}) {
    if (busy) return null
    busy = true
    for (const input of panel.querySelectorAll('button, input')) input.disabled = true
    try {
      const response = await fetch(`${base}/api/settings/payments${path}`, {
        method, headers: { 'accept': 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok || response.redirected) throw new Error(data.error || t('Pembayaran gagal disimpan.'))
      return data.paymentMethods
    } catch (error) {
      status(error.message, true)
      return null
    } finally {
      busy = false
      for (const input of panel.querySelectorAll('button, input')) input.disabled = false
    }
  }
  async function save() {
    clearTimeout(saveTimer)
    saveTimer = null
    if (busy) return
    const body = { name: byId('paymentName').value.trim(), destination: byId('paymentDestination').value.trim(),
      accountName: byId('paymentAccountName').value.trim(), enabled: byId('paymentEnabled').value === 'true' }
    if (!body.name || !body.destination) { status(t('Isi nama metode dan tujuan pembayaran.'), true); return }
    if (editing && JSON.stringify(body) === savedBody) return true
    status(t('Menyimpan…'))
    const methods = await request(editing ? `/${editing}` : '', editing ? 'PUT' : 'POST', body)
    if (methods) {
      render(methods)
      if (editing) savedBody = JSON.stringify(body)
      else reset()
      status(t('Tersimpan'))
      return true
    }
    return false
  }
  byId('paymentSave').addEventListener('click', save)
  byId('paymentCancel').addEventListener('click', async () => {
    if (editing && !(await save())) return
    reset(); status(''); byId('paymentName').focus()
  })
  function scheduleSave() {
    if (!editing || busy) return
    clearTimeout(saveTimer)
    status(t('Menunggu selesai mengetik…'))
    saveTimer = setTimeout(() => void save(), 800)
  }
  byId('paymentEditor').addEventListener('input', scheduleSave)
  byId('paymentEditor').addEventListener('change', scheduleSave)
  window.addEventListener('beforeunload', (event) => {
    if (busy || saveTimer || (editing && byId('paymentStatus').classList.contains('error'))) event.preventDefault()
  })
  byId('paymentEditor').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) { event.preventDefault(); void save() }
  })
  list.addEventListener('click', async (event) => {
    if (busy) return
    const button = event.target.closest('button')
    const row = button?.closest('[data-payment-id]')
    if (!row) return
    if (button.hasAttribute('data-payment-edit')) {
      if (editing && !(await save())) return
      editing = row.dataset.paymentId
      byId('paymentName').value = row.dataset.name
      byId('paymentDestination').value = row.dataset.destination
      byId('paymentAccountName').value = row.dataset.accountName
      byId('paymentEnabled').value = row.dataset.enabled
      byId('paymentEnabled').setAttribute('aria-checked', row.dataset.enabled)
      savedBody = JSON.stringify({ name: row.dataset.name, destination: row.dataset.destination, accountName: row.dataset.accountName, enabled: row.dataset.enabled === 'true' })
      byId('paymentSave').hidden = true
      byId('paymentCancel').hidden = false
      byId('paymentCancel').textContent = t('Selesai')
      status('')
      byId('paymentName').focus()
    } else if (button.hasAttribute('data-payment-delete') && window.confirm(t("Hapus {0}?", row.dataset.name))) {
      clearTimeout(saveTimer)
      saveTimer = null
      const methods = await request(`/${row.dataset.paymentId}`, 'DELETE')
      if (methods) { if (editing === row.dataset.paymentId) reset(); render(methods); status(t('Dihapus')) }
    }
  })
})()
