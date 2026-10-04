// Pengaturan → Jev: kunci API, saklar per keputusan, dan Akurasi (tandai keputusan yang salah).
;(() => {
  const panel = document.getElementById('settings-jev')
  if (!panel) return
  const byId = (id) => document.getElementById(id)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ??
    value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  async function call(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
        'X-WhatsApp-Workspace': workspace(),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  const status = (text) => (byId('jevStatus').textContent = text || '')
  let state = null
  let summary = []

  function paintState() {
    const pill = byId('jevState')
    pill.textContent = !state.configured
      ? t('Belum ada kunci')
      : state.enabled
        ? t('Aktif')
        : t('Mati')
    pill.className = `wa-pill ${state.configured && state.enabled ? 'ok' : 'warn'}`
    byId('jevKey').placeholder = state.configured ? t('(tersimpan — isi untuk mengganti)') : 'ts_…'
    const toggle = byId('jevEnabled')
    toggle.disabled = !state.configured
    toggle.setAttribute('aria-checked', String(state.configured && state.enabled))
    if (state.lastError && state.configured) status(`${t('Masalah terakhir')}: ${state.lastError}`)
  }

  function paintDecisions() {
    const list = byId('jevDecisionList')
    list.replaceChildren()
    const filter = byId('jevFilter')
    if (filter.options.length <= 1)
      for (const item of state.decisions) filter.append(new Option(t(item.label), item.key))
    for (const item of state.decisions) {
      const row = el('li', 'wa-quality-item')
      const stats = summary.find((entry) => entry.decision === item.key)
      row.append(el('span', '', t(item.label)))
      row.append(
        el(
          'small',
          'wa-note',
          stats?.total
            ? `${stats.accuracy}% · ${t('{0} keputusan', stats.total)}`
            : t('Belum ada data')
        )
      )
      const toggle = el('button', 'wa-switch')
      toggle.type = 'button'
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-label', t(item.label))
      toggle.setAttribute('aria-checked', String(!state.off.includes(item.key)))
      toggle.disabled = !state.configured
      toggle.addEventListener('click', async () => {
        const off = state.off.includes(item.key)
          ? state.off.filter((key) => key !== item.key)
          : [...state.off, item.key]
        try {
          state = await call('/api/beta3/jev', 'POST', { off })
          paintDecisions()
          status(t('Tersimpan'))
        } catch (error) {
          status(error.message)
        }
      })
      row.append(toggle)
      list.append(row)
    }
  }

  function paintRecent(rows) {
    const list = byId('jevRecent')
    list.replaceChildren()
    if (!rows.length) list.append(el('li', 'wa-empty', t('Belum ada keputusan Jev.')))
    const labels = Object.fromEntries(state.decisions.map((item) => [item.key, item.label]))
    for (const row of rows) {
      const item = el('li', 'wa-quality-item')
      const time = new Date(row.created_at).toLocaleString(window.waI18n?.locale || 'id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
      const who = row.contact_name || String(row.jid || '').split('@')[0] || '—'
      const text = el('span')
      text.append(el('strong', '', `${t(labels[row.decision] || row.decision)}: ${row.answer}`))
      text.append(
        el(
          'small',
          'wa-note',
          ` · ${Math.round(Number(row.confidence) * 100)}% · ${who} · ${time}${Number(row.used) ? '' : ` · ${t('ragu, cara lama dipakai')}`}`
        )
      )
      item.append(text)
      const wrong = Boolean(Number(row.wrong))
      const button = el(
        'button',
        `button small${wrong ? ' danger' : ''}`,
        wrong ? t('Ditandai salah') : t('Salah?')
      )
      button.type = 'button'
      button.setAttribute('aria-pressed', String(wrong))
      button.addEventListener('click', async () => {
        try {
          await call(`/api/beta3/jev/decisions/${row.id}`, 'POST', { wrong: !wrong })
          await loadRecent()
        } catch (error) {
          status(error.message)
        }
      })
      item.append(button)
      list.append(item)
    }
  }

  async function loadRecent() {
    const filter = byId('jevFilter').value
    const result = await call(
      `/api/beta3/jev/decisions${filter ? `?decision=${encodeURIComponent(filter)}` : ''}`
    )
    summary = result.summary || []
    paintDecisions()
    paintRecent(result.decisions || [])
  }

  let loaded = false
  async function load() {
    if (loaded) return
    loaded = true
    try {
      state = await call('/api/beta3/jev')
      paintState()
      paintDecisions()
      await loadRecent()
    } catch (error) {
      loaded = false
      status(error.message)
    }
  }

  byId('jevSave').addEventListener('click', async () => {
    const apiKey = byId('jevKey').value.trim()
    try {
      state = await call('/api/beta3/jev', 'POST', apiKey ? { apiKey, enabled: true } : {})
      byId('jevKey').value = ''
      paintState()
      paintDecisions()
      status(t('Tersimpan'))
    } catch (error) {
      status(error.message)
    }
  })
  // Tersimpan otomatis saat kunci ditempel/diubah.
  byId('jevKey').addEventListener('change', () => byId('jevSave').click())
  byId('jevEnabled').addEventListener('click', async () => {
    try {
      state = await call('/api/beta3/jev', 'POST', { enabled: !state.enabled })
      paintState()
      status(t('Tersimpan'))
    } catch (error) {
      status(error.message)
    }
  })
  byId('jevTest').addEventListener('click', async () => {
    status(t('Menguji…'))
    try {
      const result = await call('/api/beta3/jev/test', 'POST')
      status(t('Terhubung · {0} ms', result.ms))
    } catch (error) {
      status(error.message)
    }
  })
  byId('jevFilter').addEventListener(
    'change',
    () => void loadRecent().catch((error) => status(error.message))
  )

  const watch = () => {
    if (!panel.hidden) void load()
  }
  window.addEventListener('hashchange', watch)
  new MutationObserver(watch).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
  // Kartu Akurasi ada di halaman Pemakaian.
  const usagePanel = byId('settings-usage')
  const watchUsage = () => {
    if (usagePanel && !usagePanel.hidden) void loadRecent().catch((error) => status(error.message))
  }
  if (usagePanel) new MutationObserver(watchUsage).observe(usagePanel, { attributes: true, attributeFilter: ['hidden'] })
  watch()
  watchUsage()
})()
