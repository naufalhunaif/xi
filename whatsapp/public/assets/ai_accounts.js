;(() => {
  const card = document.getElementById('aiAccountsCard')
  if (!card) return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const list = byId('aiAccountsList')
  const status = (text) => (byId('aiAccountsStatus').textContent = text || '')
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const time = (ms) =>
    new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })

  async function call(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
        'X-WhatsApp-Workspace': workspace(),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || result.message || t('Permintaan gagal.'))
    return result
  }

  function state(account) {
    if (!account.enabled) return [t('Nonaktif'), '']
    if (account.limitedUntil) return [t('Jeda s/d {0}', time(account.limitedUntil)), 'warn']
    if (!account.connected)
      return [account.provider === 'gemini' ? t('Isi API key') : t('Perlu login'), 'err']
    return [t('Siap'), 'ok']
  }

  function button(label, action, className = 'button small') {
    const node = el('button', className, label)
    node.type = 'button'
    node.addEventListener('click', async () => {
      node.disabled = true
      try {
        await action()
      } catch (error) {
        status(error.message)
      } finally {
        node.disabled = false
      }
    })
    return node
  }

  // Login per akun: ChatGPT kode perangkat, Claude tempel kode.
  let polling
  async function login(account, holder, restart = false) {
    clearTimeout(polling)
    const data = await call(`/api/ai/accounts/${account.id}/login`, 'POST', { restart })
    showLogin(account, holder, data)
  }
  function showLogin(account, holder, data) {
    holder.replaceChildren()
    if (data.connected) {
      status(t('{0} terhubung.', account.name))
      refresh()
      return
    }
    const box = el('div', 'wa-ai-login')
    if (account.provider === 'chatgpt') {
      if (data.userCode) {
        box.append(el('p', 'wa-note', t('Buka link, login ke akun ChatGPT yang ingin ditambahkan, lalu masukkan kode:')))
        box.append(el('code', 'wa-ai-code', data.userCode))
      } else box.append(el('p', 'wa-note', t('Menyiapkan kode login…')))
      if (data.verificationUrl) {
        const link = el('a', 'button primary small', t('Buka login'))
        link.href = data.verificationUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        box.append(link)
      }
    } else {
      box.append(el('p', 'wa-note', t('Buka link, login ke akun Claude yang ingin ditambahkan, lalu tempel kodenya di sini.')))
      const row = el('div', 'actions wa-actions-start')
      if (data.verificationUrl) {
        const link = el('a', 'button primary small', t('Buka login'))
        link.href = data.verificationUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        row.append(link)
      }
      const input = el('input')
      input.type = 'password'
      input.placeholder = t('Tempel kode')
      input.autocomplete = 'off'
      input.addEventListener('keydown', (event) => event.key === 'Enter' && event.preventDefault())
      row.append(
        input,
        button(t('Verifikasi'), async () => {
          await call(`/api/ai/accounts/${account.id}/verify`, 'POST', {
            loginId: data.loginId,
            code: input.value,
          })
          status(t('Memeriksa login…'))
        })
      )
      box.append(row)
    }
    if (data.error) box.append(el('p', 'wa-alert', data.error))
    box.append(button(t('Mulai ulang'), () => login(account, holder, true)))
    holder.append(box)
    const poll = () =>
      (polling = setTimeout(async () => {
        if (!holder.isConnected) return
        try {
          const next = { ...data, ...(await call(`/api/ai/accounts/${account.id}/login`)) }
          next.loginId = next.loginId || data.loginId
          const changed = ['connected', 'userCode', 'verificationUrl', 'error'].some((key) => next[key] !== data[key])
          if (changed) return showLogin(account, holder, next)
        } catch {}
        poll()
      }, 4000))
    poll()
  }

  function render(accounts) {
    list.replaceChildren()
    accounts.forEach((account, index) => {
      const item = el('div', 'wa-kv-row')
      const name = el('span', '', `${index + 1}. ${account.name}`)
      const [label, tone] = state(account)
      const info = el('code', '', account.lastError && account.limitedUntil ? account.lastError : account.model || '')
      const side = el('div', 'actions')
      side.append(el('span', `wa-pill ${tone}`, label))
      const holder = el('div', 'wa-span-full')
      if (index > 0)
        side.append(button('↑', async () => {
          await call(`/api/ai/accounts/${account.id}/move`, 'POST', { direction: -1 })
          refresh()
        }))
      if (index < accounts.length - 1)
        side.append(button('↓', async () => {
          await call(`/api/ai/accounts/${account.id}/move`, 'POST', { direction: 1 })
          refresh()
        }))
      if (account.limitedUntil)
        side.append(button(t('Coba lagi'), async () => {
          await call(`/api/ai/accounts/${account.id}/update`, 'POST', { resume: true })
          refresh()
        }))
      if (!account.connected && account.provider !== 'gemini')
        side.append(
          account.legacy
            ? el('small', '', t('login di bawah'))
            : button(t('Login'), () => login(account, holder))
        )
      if (account.provider === 'gemini')
        side.append(button(t('Ganti key'), async () => {
          const key = window.prompt(t('API key Gemini baru'))
          if (!key) return
          await call(`/api/ai/accounts/${account.id}/update`, 'POST', { apiKey: key, resume: true })
          refresh()
        }))
      side.append(button(account.enabled ? t('Nonaktifkan') : t('Aktifkan'), async () => {
        await call(`/api/ai/accounts/${account.id}/update`, 'POST', { enabled: !account.enabled })
        refresh()
      }))
      if (!account.legacy)
        side.append(button(t('Hapus'), async () => {
          if (!window.confirm(t('Hapus akun {0}?', account.name))) return
          await call(`/api/ai/accounts/${account.id}`, 'DELETE')
          refresh()
        }))
      item.append(name, info, side)
      list.append(item, holder)
    })
  }

  let timer
  async function refresh() {
    clearTimeout(timer)
    if (list.querySelector('.wa-ai-login')) return
    try {
      const data = await call('/api/ai/accounts')
      render(data.accounts || [])
    } catch (error) {
      status(error.message)
    }
    timer = setTimeout(refresh, 60000)
  }

  const provider = byId('aiAccountProvider')
  const syncKey = () => (byId('aiAccountKeyField').hidden = provider.value !== 'gemini')
  provider.addEventListener('change', syncKey)
  for (const input of [byId('aiAccountLabel'), byId('aiAccountKey')])
    input.addEventListener('keydown', (event) => event.key === 'Enter' && event.preventDefault())
  byId('aiAccountAdd').addEventListener('click', async () => {
    const add = byId('aiAccountAdd')
    add.disabled = true
    try {
      const result = await call('/api/ai/accounts', 'POST', {
        provider: provider.value,
        label: byId('aiAccountLabel').value,
        apiKey: byId('aiAccountKey').value,
      })
      byId('aiAccountLabel').value = ''
      byId('aiAccountKey').value = ''
      await refresh()
      if (provider.value !== 'gemini') {
        const index = [...list.querySelectorAll('.wa-kv-row')].length - 1
        const holder = list.querySelectorAll('.wa-kv-row + .wa-span-full')[index]
        const data = await call('/api/ai/accounts')
        const account = (data.accounts || []).find((a) => a.id === result.id)
        if (account && holder) await login(account, holder)
      } else status(t('Akun Gemini ditambahkan.'))
    } catch (error) {
      status(error.message)
    } finally {
      add.disabled = false
    }
  })
  syncKey()
  refresh()
})()
