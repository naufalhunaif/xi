// Pengaturan → Jev: kunci API, saklar per keputusan, dan Akurasi (nilai Benar/Salah tiap keputusan, v3.6.36).
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
    if (filter.options.length <= 1) {
      filter.append(new Option(t('Perlu dicek'), 'cek'), new Option(t('Sudah dinilai'), 'dinilai'))
      for (const item of state.decisions) filter.append(new Option(t(item.label), item.key))
    }
    for (const item of state.decisions) {
      const row = el('li', 'wa-quality-item')
      const stats = summary.find((entry) => entry.decision === item.key)
      row.append(el('span', '', t(item.label)))
      row.append(
        el(
          'small',
          'wa-note',
          !stats?.total
            ? t('Belum ada data')
            : stats.reviewed
              ? `${t('{0}% benar dari {1} dinilai', stats.accuracy, stats.reviewed)} · ${t('belum dinilai {0}', stats.unreviewed)}`
              : `${t('{0} keputusan', stats.total)} · ${t('belum dinilai')}`
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

  // v3.6.36: tiap keputusan dijelaskan — pesan yang dibaca, pertanyaan, jawaban, akibat — lalu dinilai Benar/Salah.
  const appRoot = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const pct = (value) => `${Math.round(Number(value) * 100)}%`
  async function judge(row, verdict, correct = '') {
    try {
      await call(`/api/beta3/jev/decisions/${row.id}`, 'POST', { verdict, correct })
      await loadRecent()
    } catch (error) {
      status(error.message)
    }
  }
  function verdictControls(row) {
    const box = el('div', 'wa-jev-actions')
    const verdict = row.verdict || (Number(row.wrong) ? 'salah' : '')
    if (verdict) {
      const label =
        verdict === 'benar'
          ? t('Ditandai benar')
          : row.correct_answer
            ? `${t('Ditandai salah')} → ${row.options?.[row.correct_answer] || row.correct_answer}`
            : t('Ditandai salah')
      box.append(el('span', `wa-pill ${verdict === 'benar' ? 'ok' : 'warn'}`, label))
      const undo = el('button', 'button small', t('Batalkan'))
      undo.type = 'button'
      undo.addEventListener('click', () => void judge(row, ''))
      box.append(undo)
      return box
    }
    const right = el('button', 'button small', t('Benar'))
    right.type = 'button'
    right.addEventListener('click', () => void judge(row, 'benar'))
    const wrong = el('button', 'button small danger', t('Salah'))
    wrong.type = 'button'
    box.append(right, wrong)
    wrong.addEventListener('click', () => {
      const choices = Object.entries(row.options || {}).filter(([key]) => key !== row.answer)
      if (!choices.length) return void judge(row, 'salah')
      // Pilih jawaban yang seharusnya (membantu memperbaiki Jev nanti).
      box.replaceChildren()
      const select = el('select')
      select.setAttribute('aria-label', t('Jawaban yang benar'))
      select.append(new Option(t('Jawaban yang benar…'), ''))
      for (const [key, label] of choices) select.append(new Option(label, key))
      const save = el('button', 'button small danger', t('Simpan salah'))
      save.type = 'button'
      save.addEventListener('click', () => void judge(row, 'salah', select.value))
      const cancel = el('button', 'button small', t('Batal'))
      cancel.type = 'button'
      cancel.addEventListener('click', () => void loadRecent())
      box.append(select, save, cancel)
    })
    return box
  }

  function paintRecent(rows) {
    const list = byId('jevRecent')
    list.replaceChildren()
    if (!rows.length) list.append(el('li', 'wa-empty', t('Belum ada keputusan Jev.')))
    const labels = Object.fromEntries(state.decisions.map((item) => [item.key, item.label]))
    for (const row of rows) {
      // v3.6.37: dibaca seperti chat — pesan di atas, jawaban Jev di bawahnya, lalu Benar/Salah.
      const item = el('li', 'wa-quality-item wa-jev-card')
      const head = el('div', 'wa-jev-head')
      head.append(el('span', 'wa-jev-kind', t(labels[row.decision] || row.decision)))
      const who = row.contact_name || String(row.jid || '').split('@')[0] || '—'
      const meta = el('small', 'wa-note', `${who} · ${window.waTime.ago(row.created_at)}`)
      meta.title = window.waTime.full(row.created_at)
      head.append(meta)
      if (row.jid && !String(row.jid).startsWith('ig:')) {
        const open = el('a', 'wa-jev-open', t('Buka chat'))
        open.href = `${appRoot}/?jid=${encodeURIComponent(row.jid)}`
        head.append(open)
      }
      item.append(head)
      const message = el('div', 'wa-jev-bubble')
      message.append(el('small', '', row.source_label || t('Pelanggan')))
      message.append(el('p', '', row.input_text ? String(row.input_text) : '—'))
      item.append(message)
      const reply = el('div', `wa-jev-bubble jev${Number(row.used) ? '' : ' unsure'}`)
      reply.append(el('small', '', `Jev · ${t('yakin')} ${pct(row.confidence)}`))
      reply.append(el('p', '', row.says || row.answer_label || row.answer))
      if (row.effect) reply.append(el('small', 'wa-jev-effect', `→ ${row.effect}`))
      item.append(reply)
      const more = el('details', 'wa-jev-more')
      more.append(el('summary', '', t('Detail')))
      more.append(el('p', '', `${t('Pertanyaan ke Jev')}: ${row.question || row.decision}`))
      if (row.alternatives?.length)
        more.append(
          el('p', '', `${t('Pilihan lain')}: ${row.alternatives.slice(0, 3).map((alt) => `${alt.label} ${alt.pct}%`).join(' · ')}`)
        )
      item.append(more)
      item.append(verdictControls(row))
      list.append(item)
    }
  }

  async function loadRecent() {
    // Kartu Akurasi juga ada di halaman Usage: keadaan Jev dimuat dulu bila belum.
    if (!state) state = await call('/api/beta3/jev')
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
