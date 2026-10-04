// Pengaturan → AI: tabel akun AI. Masalah per akun di ikon ⚠ (klik = keterangan),
// tambah akun & login lewat dialog.
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
  const ICON = {
    warn: '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5M12 17h.01"/>',
    test: '<path d="M7 5l12 7-12 7z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  }
  const svg = (name) => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      width: '16',
      height: '16',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    }))
      icon.setAttribute(key, value)
    icon.innerHTML = ICON[name]
    return icon
  }
  const PROVIDERS = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }
  const time = (ms) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })

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
    if (!account.connected) return [account.provider === 'gemini' ? t('Isi API key') : t('Perlu login'), 'err']
    return [t('Siap'), 'ok']
  }

  function button(label, action, className = 'button small') {
    const node = el('button', className, label)
    node.type = 'button'
    node.addEventListener('click', async (event) => {
      event.stopPropagation()
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
  function iconButton(icon, label, action, className = 'wa-ai-icon') {
    const node = button('', action, className)
    node.append(svg(icon))
    node.title = label
    node.setAttribute('aria-label', label)
    return node
  }

  // ---- Keterangan ⚠: satu popover dipakai bersama ----
  const pop = el('section', 'wa-handling-details wa-info-popover wa-ai-pop')
  pop.hidden = true
  pop.setAttribute('role', 'region')
  document.body.append(pop)
  let popOwner = null
  function closePop(focus = false) {
    if (!popOwner) return
    pop.hidden = true
    popOwner.setAttribute('aria-expanded', 'false')
    if (focus) popOwner.focus({ preventScroll: true })
    popOwner = null
  }
  function openPop(owner, title, lines, actions = []) {
    if (popOwner === owner) return closePop()
    closePop()
    popOwner = owner
    owner.setAttribute('aria-expanded', 'true')
    const head = el('header')
    const close = el('button', '', '×')
    close.type = 'button'
    close.setAttribute('aria-label', t('Tutup'))
    close.addEventListener('click', () => closePop(true))
    head.append(el('strong', '', title), close)
    pop.setAttribute('aria-label', title)
    pop.replaceChildren(head, ...lines.map((line) => el('p', '', line)))
    if (actions.length) {
      const row = el('div', 'actions wa-actions-start')
      row.append(...actions)
      pop.append(row)
    }
    pop.hidden = false
    const rect = owner.getBoundingClientRect()
    const width = Math.min(340, innerWidth - 24)
    pop.style.width = `${width}px`
    pop.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`
    const below = rect.bottom + 8
    pop.style.top = `${below + pop.offsetHeight <= innerHeight - 12 ? below : Math.max(12, rect.top - pop.offsetHeight - 8)}px`
  }
  document.addEventListener('pointerdown', (event) => {
    if (popOwner && !pop.contains(event.target) && !popOwner.contains(event.target)) closePop()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && popOwner) closePop(true)
  })
  window.addEventListener('scroll', (event) => !pop.contains(event.target) && closePop(), true)

  function problems(account) {
    const lines = []
    if (account.lastError) lines.push(account.lastError)
    if (account.limitedUntil)
      lines.push(t('Kuota habis atau dibatasi; dipakai lagi otomatis sekitar {0}.', time(account.limitedUntil)))
    if (account.modelBlocked)
      lines.push(t('Model {0} tidak tersedia di akun ini, memakai model bawaan', account.modelBlocked))
    if (account.enabled && !account.connected)
      lines.push(account.provider === 'gemini' ? t('API key belum diisi atau tidak valid.') : t('Akun perlu login ulang.'))
    return lines
  }

  // ---- Tabel ----
  function render(accounts) {
    closePop()
    list.replaceChildren()
    if (!accounts.length) {
      const row = el('tr')
      const cell = el('td', 'wa-note', t('Belum ada akun AI'))
      cell.colSpan = 6
      row.append(cell)
      list.append(row)
      return
    }
    accounts.forEach((account, index) => {
      const row = el('tr', 'wa-ai-item')
      row.dataset.id = String(account.id)
      const order = el('td', 'wa-ai-order')
      const handle = el('button', 'wa-drag-handle', '⠿')
      handle.type = 'button'
      handle.setAttribute('aria-label', t('Urutan'))
      handle.addEventListener('pointerdown', (event) => startDrag(event, row))
      order.append(handle, el('span', '', String(index + 1)))

      // Status = titik warna di depan nama (hijau siap, kuning jeda, merah perlu login, abu nonaktif).
      const name = el('td', 'wa-ai-acct')
      const [label, tone] = state(account)
      const dot = el(account.enabled && !account.connected ? 'button' : 'span', `wa-dot ${tone}`)
      dot.title = label
      dot.setAttribute('aria-label', label)
      if (dot.tagName === 'BUTTON') {
        dot.type = 'button'
        dot.addEventListener('click', () => openLogin(account))
      }
      const nameBox = el('div', 'wa-ai-name')
      nameBox.append(dot, el('strong', '', account.name))
      const provider = el('small', `wa-provider ${account.provider}`, PROVIDERS[account.provider] || account.provider)
      name.append(nameBox, provider)

      const model = el('td')
      model.append(modelPicker(account))
      const scope = el('td')
      scope.append(scopePicker(account))

      const issues = problems(account)
      if (issues.length) {
        const warn = el('button', `wa-ai-warn ${tone === 'err' || account.lastError ? 'err' : 'warn'}`)
        warn.type = 'button'
        warn.append(svg('warn'))
        warn.title = t('Lihat keterangan')
        warn.setAttribute('aria-label', t('Keterangan {0}', account.name))
        warn.setAttribute('aria-expanded', 'false')
        warn.addEventListener('click', (event) => {
          event.stopPropagation()
          const actions = []
          if (account.limitedUntil)
            actions.push(
              button(t('Coba lagi sekarang'), async () => {
                await call(`/api/ai/accounts/${account.id}/update`, 'POST', { resume: true })
                closePop()
                refresh()
              })
            )
          if (!account.connected && account.provider !== 'gemini')
            actions.push(
              button(t('Login'), async () => {
                closePop()
                openLogin(account)
              }, 'button primary small')
            )
          if (account.provider === 'gemini')
            actions.push(
              button(t('Ganti key'), async () => {
                closePop()
                openLogin(account)
              })
            )
          openPop(warn, account.name, issues, actions)
        })
        nameBox.append(warn)
      }

      const active = el('td')
      const toggle = el('button', 'wa-switch')
      toggle.type = 'button'
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-checked', String(Boolean(account.enabled)))
      toggle.setAttribute('aria-label', t('Aktifkan {0}', account.name))
      toggle.addEventListener('click', async () => {
        toggle.disabled = true
        try {
          await call(`/api/ai/accounts/${account.id}/update`, 'POST', { enabled: !account.enabled })
          refresh()
        } catch (error) {
          status(error.message)
          toggle.disabled = false
        }
      })
      active.append(toggle)

      const actions = el('td', 'wa-ai-actions')
      actions.append(
        iconButton('test', t('Tes {0}', account.name), async () => {
          status(t('Menguji {0}…', account.name))
          const result = await call(`/api/ai/accounts/${account.id}/test`, 'POST')
          status(
            result.ok
              ? t('{0} berhasil ({1} detik, model {2}).', account.name, (result.ms / 1000).toFixed(1), result.model || '-')
              : t('{0} gagal: {1}', account.name, result.error || result.code || '-')
          )
          refresh()
        }),
        iconButton(
          'trash',
          t('Hapus {0}', account.name),
          async () => {
            if (!window.confirm(t('Hapus akun {0}?', account.name))) return
            await call(`/api/ai/accounts/${account.id}`, 'DELETE')
            refresh()
          },
          'wa-ai-icon danger'
        )
      )
      row.append(order, name, model, scope, active, actions)
      list.append(row)
    })
  }

  // Seret-lepas urutan (mouse & sentuh); urutan disimpan saat dilepas.
  function startDrag(event, row) {
    event.preventDefault()
    row.classList.add('dragging')
    const before = [...list.children].map((node) => node.dataset.id).join(',')
    const move = (next) => {
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest('.wa-ai-item')
      if (!target || target === row || target.parentElement !== list) return
      const box = target.getBoundingClientRect()
      list.insertBefore(row, next.clientY < box.top + box.height / 2 ? target : target.nextSibling)
    }
    const end = async () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      row.classList.remove('dragging')
      const ids = [...list.children].map((node) => Number(node.dataset.id))
      if (ids.join(',') === before) return
      try {
        await call('/api/ai/accounts/order', 'POST', { ids })
        status(t('Urutan disimpan.'))
      } catch (error) {
        status(error.message)
      }
      refresh()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const MODEL_LABELS = {"opus": "opus (selalu terbaru)", "sonnet": "sonnet (selalu terbaru)", "haiku": "haiku (selalu terbaru)", "claude-opus-5-5": "Opus 5.5", "claude-opus-5": "Opus 5", "claude-opus-4-8": "Opus 4.8", "claude-opus-4-7": "Opus 4.7", "claude-opus-4-6": "Opus 4.6", "claude-opus-4-5-20251101": "Opus 4.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-sonnet-5": "Sonnet 5", "claude-sonnet-4-6": "Sonnet 4.6", "claude-haiku-4-5-20251001": "Haiku 4.5"}
  const MODELS = {
    chatgpt: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    // Alias (opus/sonnet/haiku) selalu ikut versi terbaru; versi tertentu bisa dipilih langsung.
    claude: ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    gemini: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  }
  function modelPicker(account) {
    const select = el('select', 'wa-ai-model')
    select.setAttribute('aria-label', t('Model {0}', account.name))
    const options = [...(MODELS[account.provider] || [])]
    if (account.model && !options.includes(account.model)) options.push(account.model)
    select.append(new Option(t('Otomatis (hemat)'), ''))
    select.title = t('Otomatis: model ringan/menengah/utama dipilih per tugas supaya hemat.')
    for (const model of options) select.append(new Option(MODEL_LABELS[model] ? t(MODEL_LABELS[model]) : model, model))
    select.append(new Option(t('Model lainnya…'), '__custom__'))
    select.value = account.model || ''
    select.addEventListener('change', async () => {
      let model = select.value
      if (model === '__custom__') {
        model = (window.prompt(t('ID model untuk {0}', account.name), account.model || '') || '').trim()
        if (!model) {
          select.value = account.model || ''
          return
        }
      }
      try {
        await call(`/api/ai/accounts/${account.id}/update`, 'POST', { model, resume: true })
        status(t('Model {0}: {1}', account.name, model || t('otomatis')))
      } catch (error) {
        status(error.message)
      }
      refresh()
    })
    return select
  }

  // Tugas akun: semua, atau hanya tugas latar (katalog/rekap) agar gaya balasan ke pelanggan seragam.
  function scopePicker(account) {
    const select = el('select', 'wa-ai-model')
    select.setAttribute('aria-label', t('Tugas {0}', account.name))
    select.title = t('Latar saja = katalog & rekap, tidak membalas pelanggan')
    select.append(new Option(t('Balas + latar'), 'all'))
    select.append(new Option(t('Latar saja'), 'background'))
    select.value = account.scope === 'background' ? 'background' : 'all'
    select.addEventListener('change', async () => {
      try {
        await call(`/api/ai/accounts/${account.id}/update`, 'POST', { scope: select.value })
        status(t('Tugas {0} diperbarui.', account.name))
      } catch (error) {
        status(error.message)
      }
      refresh()
    })
    return select
  }

  // Berurutan = akun atas dipakai dulu. Merata = token 5 jam terakhir paling sedikit didahulukan.
  function showSpread(mode) {
    card.querySelectorAll('[data-ai-spread]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.aiSpread === mode))
      b.title =
        b.dataset.aiSpread === 'even'
          ? t('Akun yang paling sedikit terpakai dalam 5 jam terakhir dipakai lebih dulu, jadi kuota semua akun habis merata.')
          : t('Akun paling atas selalu dipakai dulu; akun di bawahnya jadi cadangan saat habis.')
    })
  }
  card.querySelectorAll('[data-ai-spread]').forEach((b) =>
    b.addEventListener('click', async () => {
      showSpread(b.dataset.aiSpread)
      try {
        await call('/api/ai/accounts/spread', 'POST', { mode: b.dataset.aiSpread })
      } catch (error) {
        status(error.message)
      }
    })
  )

  let timer
  async function refresh() {
    clearTimeout(timer)
    if (list.querySelector('.dragging') || popOwner) {
      timer = setTimeout(refresh, 15000)
      return
    }
    try {
      const data = await call('/api/ai/accounts')
      render(data.accounts || [])
      showSpread(data.spread || 'order')
      const advanced = document.querySelector('.wa-ai-advanced')
      if (advanced) advanced.hidden = !(data.accounts || []).some((a) => a.legacy)
    } catch (error) {
      status(error.message)
    }
    timer = setTimeout(refresh, 60000)
  }

  // ---- Dialog: tambah akun & login ----
  let dialog = null
  let polling = null
  const onDialogKey = (event) => {
    if (event.key === 'Escape') closeDialog()
  }
  function closeDialog() {
    clearTimeout(polling)
    dialog?.remove()
    dialog = null
    document.removeEventListener('keydown', onDialogKey)
    byId('aiAccountOpen')?.focus({ preventScroll: true })
    refresh()
  }
  function frame(title) {
    clearTimeout(polling)
    dialog?.remove()
    dialog = el('div', 'wa-correct-overlay')
    const box = el('div', 'wa-correct-box wa-ai-dialog')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', title)
    const head = el('div', 'wa-ai-dialog-head')
    const close = el('button', 'wa-ai-icon', '×')
    close.type = 'button'
    close.setAttribute('aria-label', t('Tutup'))
    close.addEventListener('click', closeDialog)
    head.append(el('strong', '', title), close)
    const body = el('div', 'wa-ai-dialog-body')
    const note = el('small', 'wa-correct-status')
    note.setAttribute('role', 'status')
    box.append(head, body, note)
    dialog.append(box)
    dialog.addEventListener('pointerdown', (event) => event.target === dialog && closeDialog())
    document.body.append(dialog)
    document.removeEventListener('keydown', onDialogKey)
    document.addEventListener('keydown', onDialogKey)
    return { body, note: (text) => (note.textContent = text || '') }
  }

  // Langkah 1: pilih penyedia, nama opsional, (Gemini) API key.
  function openAdd() {
    const { body, note } = frame(t('Tambah akun AI'))
    let provider = 'chatgpt'
    const hints = {
      chatgpt: t('Login akun ChatGPT'),
      claude: t('Login akun Claude'),
      gemini: t('Pakai API key'),
    }
    const tiles = el('div', 'wa-ai-tiles')
    tiles.setAttribute('role', 'radiogroup')
    tiles.setAttribute('aria-label', t('Penyedia'))
    const keyField = el('label', 'wa-ai-key')
    keyField.append(el('span', '', t('API key Gemini')))
    const key = el('input')
    key.type = 'password'
    key.autocomplete = 'off'
    key.spellcheck = false
    const keyHelp = el('small', 'wa-note', `${t('Buat API key di')} `)
    const keyLink = el('a', '', 'aistudio.google.com/apikey')
    keyLink.href = 'https://aistudio.google.com/apikey'
    keyLink.target = '_blank'
    keyLink.rel = 'noopener noreferrer'
    keyHelp.append(keyLink)
    keyField.append(key, keyHelp)
    const pick = (value) => {
      provider = value
      tiles.querySelectorAll('button').forEach((tile) => tile.setAttribute('aria-checked', String(tile.dataset.provider === value)))
      keyField.hidden = value !== 'gemini'
    }
    for (const value of ['chatgpt', 'claude', 'gemini']) {
      const tile = el('button', 'wa-ai-tile')
      tile.type = 'button'
      tile.dataset.provider = value
      tile.setAttribute('role', 'radio')
      tile.append(el('strong', '', PROVIDERS[value]), el('small', '', hints[value]))
      tile.addEventListener('click', () => pick(value))
      tiles.append(tile)
    }
    const nameField = el('label')
    nameField.append(el('span', '', t('Nama (opsional)')))
    const name = el('input')
    name.type = 'text'
    name.maxLength = 80
    name.placeholder = t('mis. Akun kantor')
    nameField.append(name)
    const actions = el('div', 'actions')
    const next = button(
      t('Lanjut'),
      async () => {
        note(t('Menyimpan…'))
        try {
          const result = await call('/api/ai/accounts', 'POST', { provider, label: name.value, apiKey: key.value })
          if (provider === 'gemini') {
            status(t('Akun Gemini ditambahkan.'))
            return closeDialog()
          }
          const data = await call('/api/ai/accounts')
          const account = (data.accounts || []).find((a) => a.id === result.id)
          if (account) openLogin(account)
          else closeDialog()
        } catch (error) {
          note(error.message)
        }
      },
      'button primary'
    )
    actions.append(button(t('Batal'), async () => closeDialog(), 'button'), next)
    for (const input of [name, key])
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        next.click()
      })
    body.append(tiles, nameField, keyField, actions)
    pick('chatgpt')
    tiles.querySelector('button')?.focus()
  }

  // Langkah 2: login akun (ChatGPT kode perangkat, Claude tempel kode) atau ganti key Gemini.
  function openLogin(account) {
    const { body, note } = frame(t('Login {0}', account.name))
    if (account.provider === 'gemini') {
      const field = el('label')
      field.append(el('span', '', t('API key Gemini baru')))
      const key = el('input')
      key.type = 'password'
      key.autocomplete = 'off'
      field.append(key)
      const actions = el('div', 'actions')
      actions.append(
        button(t('Batal'), async () => closeDialog(), 'button'),
        button(
          t('Simpan'),
          async () => {
            if (!key.value.trim()) return note(t('Isi API key.'))
            await call(`/api/ai/accounts/${account.id}/update`, 'POST', { apiKey: key.value, resume: true })
            closeDialog()
          },
          'button primary'
        )
      )
      body.append(field, actions)
      key.focus()
      return
    }
    body.append(el('p', 'wa-note', t('Menyiapkan login…')))
    const show = (data) => {
      if (!dialog) return
      body.replaceChildren()
      if (data.connected) {
        body.append(el('p', '', t('{0} terhubung.', account.name)))
        status(t('{0} terhubung.', account.name))
        setTimeout(closeDialog, 900)
        return
      }
      const steps = el('ol', 'wa-ai-steps')
      const link = el('a', 'button primary small', t('Buka halaman login'))
      if (data.verificationUrl) {
        link.href = data.verificationUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
      } else link.setAttribute('aria-disabled', 'true')
      if (account.provider === 'chatgpt') {
        const one = el('li')
        one.append(`${t('Salin kode ini:')} `, el('code', 'wa-ai-code', data.userCode || '…'))
        if (data.userCode)
          one.append(
            button(t('Salin'), async () => {
              await navigator.clipboard?.writeText(data.userCode)
              note(t('Kode disalin.'))
            })
          )
        const two = el('li')
        two.append(link, ` ${t('lalu login ke akun ChatGPT yang ingin ditambahkan dan masukkan kodenya.')}`)
        steps.append(one, two, el('li', '', t('Dialog ini tersambung sendiri setelah login.')))
      } else {
        const one = el('li')
        one.append(link, ` ${t('lalu login ke akun Claude yang ingin ditambahkan.')}`)
        const two = el('li', '', t('Salin kode yang muncul, tempel di sini:'))
        const row = el('div', 'wa-ai-paste')
        const input = el('input')
        input.type = 'password'
        input.placeholder = t('Tempel kode')
        input.autocomplete = 'off'
        const verify = button(
          t('Verifikasi'),
          async () => {
            if (!input.value.trim()) return note(t('Tempel kodenya dulu.'))
            await call(`/api/ai/accounts/${account.id}/verify`, 'POST', { loginId: data.loginId, code: input.value })
            note(t('Memeriksa login…'))
          },
          'button primary small'
        )
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          verify.click()
        })
        row.append(input, verify)
        two.append(row)
        steps.append(one, two)
      }
      body.append(steps)
      if (data.error) body.append(el('p', 'wa-alert', data.error))
      const actions = el('div', 'actions')
      actions.append(button(t('Mulai ulang'), () => start(true), 'button'), button(t('Nanti saja'), async () => closeDialog(), 'button'))
      body.append(actions)
      clearTimeout(polling)
      const poll = () =>
        (polling = setTimeout(async () => {
          if (!dialog) return
          try {
            const next = { ...data, ...(await call(`/api/ai/accounts/${account.id}/login`)) }
            next.loginId = next.loginId || data.loginId
            const changed = ['connected', 'userCode', 'verificationUrl', 'error'].some((key) => next[key] !== data[key])
            if (changed) return show(next)
          } catch {}
          poll()
        }, 4000))
      poll()
    }
    const start = async (restart = false) => {
      try {
        show(await call(`/api/ai/accounts/${account.id}/login`, 'POST', { restart }))
      } catch (error) {
        note(error.message)
      }
    }
    start()
  }

  byId('aiAccountOpen').addEventListener('click', openAdd)
  refresh()
})()
