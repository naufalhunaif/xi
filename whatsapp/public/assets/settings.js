;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const form = document.getElementById('settingsForm')
  if (!form) return
  // Lima halaman (Koneksi, Toko, Cara AI membalas, Pemakaian, Aplikasi & data). Bagian lama
  // (#ai, #backup, #instagram, …) tetap bisa dibuka lewat tautan lama: dialihkan ke halamannya.
  const views = [...form.querySelectorAll('[data-settings-view]')]
  const panels = [...form.querySelectorAll('[data-settings-panel]')]
  const menu = [...document.querySelectorAll('[data-settings-menu]')]
  const viewOf = (panel) => panel.closest('[data-settings-view]')?.dataset.settingsView || ''
  const byId = (id) => document.getElementById(id)
  const number = (value) => new Intl.NumberFormat((window.waI18n?.locale || 'id-ID')).format(value)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  let loading = false
  // Usage: rentang/tanggal terpilih & cache kalender (dipakai selectPanel saat halaman dibuka).
  const usageState = { days: 30, date: '' }
  const runsState = { filter: null, next: 0, total: 0, shown: 0, extended: false, busy: false }
  let calendarKey = ''
  let lastCalendar = []
  function refreshRelativeTimes() {
    for (const time of document.querySelectorAll('time[data-relative-time]')) {
      const seconds = Math.max(0, (Date.now() - new Date(time.dateTime).getTime()) / 1000)
      const units = [
        [31536000, 'y'],
        [2592000, 'mo'],
        [86400, 'd'],
        [3600, 'h'],
        [60, 'm'],
      ]
      const unit = units.find(([size]) => seconds >= size)
      time.textContent = !Number.isFinite(seconds)
        ? '—'
        : unit
          ? `${Math.floor(seconds / unit[0])}${unit[1]} ago`
          : 'just now'
    }
  }
  refreshRelativeTimes()
  document.addEventListener('skills:updated', refreshRelativeTimes)
  window.setInterval(refreshRelativeTimes, 60_000)

  let lastView = ''
  function selectPanel() {
    const hash = window.location.hash.slice(1)
    const section = panels.find((panel) => panel.dataset.settingsPanel === hash)
    const selected = views.some((view) => view.dataset.settingsView === hash) ? hash : section ? viewOf(section) : 'connect'
    for (const view of views) {
      view.hidden = view.dataset.settingsView !== selected
      // Bagian di dalam halaman: hidden mengikuti halamannya (skrip per bagian memuat data saat tampil).
      for (const panel of view.querySelectorAll('[data-settings-panel]')) panel.hidden = view.hidden
    }
    for (const link of menu) {
      if (link.dataset.settingsMenu === selected) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    if (section) {
      // Tautan lama ke satu bagian: buka "Lanjutan" bila perlu, lalu gulir ke bagian itu.
      const advanced = section.closest('details.wa-advanced')
      if (advanced) advanced.open = true
      if (lastView !== selected || hash !== lastHash) section.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else if (lastView && lastView !== selected) window.scrollTo({ top: 0 })
    lastView = selected
    lastHash = hash
    if (selected === 'usage') updateUsage()
  }
  let lastHash = ''
  window.addEventListener('hashchange', selectPanel)
  document.addEventListener('ui-language:change', selectPanel)
  form.addEventListener(
    'invalid',
    (event) => {
      const panel = event.target.closest('[data-settings-panel]')
      if (panel?.hidden) {
        window.location.hash = panel.dataset.settingsPanel
        selectPanel()
      }
    },
    true
  )
  // Native anchor navigation supports keyboard, bookmarks, and browser back/forward.
  selectPanel()

  function textElement(tag, value, className) {
    const element = document.createElement(tag)
    element.textContent = value
    if (className) element.className = className
    return element
  }
  /* ───── Usage: kalender 1 tahun (seperti GitHub), rentang, ringkasan, rincian bertab ───── */
  const locale = () => window.waI18n?.locale || 'id-ID'
  const compact = (value) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  const dayLabel = (iso, options = { day: 'numeric', month: 'short', year: 'numeric' }) =>
    new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', ...options }).format(new Date(`${iso}T00:00:00Z`))
  const isoOf = (date) => date.toISOString().slice(0, 10)
  function todayWib() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date())
    return new Date(`${parts}T00:00:00Z`)
  }
  window.addEventListener('resize', () => {
    if (byId('settings-usage')?.hidden || !lastCalendar.length) return
    calendarKey = ''
    renderCalendar(lastCalendar)
  })
  // Grafik naik-turun: token per hari per penyedia untuk rentang yang dipilih (SVG sederhana).
  const PROVIDER_LINES = [
    ['chatgpt', 'ChatGPT', 'var(--orc-chatgpt, #10a37f)'],
    ['claude', 'Claude', 'var(--orc-claude, #d97757)'],
    ['gemini', 'Gemini', 'var(--orc-gemini, #4f7df3)'],
    ['typesafe', 'Jev', 'var(--orc-jev, #8b5cf6)'],
  ]
  function renderTrend(calendar) {
    const svg = byId('usageTrend')
    const legend = byId('usageTrendLegend')
    if (!svg || !legend) return
    const days = usageState.date ? 7 : Math.min(usageState.days, 365)
    const end = usageState.date ? new Date(`${usageState.date}T00:00:00Z`) : todayWib()
    const dates = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end)
      d.setUTCDate(d.getUTCDate() - i)
      dates.push(isoOf(d))
    }
    const byDate = new Map(calendar.map((row) => [row.date, row]))
    const series = PROVIDER_LINES.map(([key, label, color]) => ({
      key,
      label,
      color,
      values: dates.map((date) => Number(byDate.get(date)?.by?.[key] || 0)),
    })).filter((line) => line.values.some((v) => v > 0))
    const W = 600
    const H = 160
    const pad = { l: 36, r: 8, t: 10, b: 22 }
    const max = Math.max(1, ...series.flatMap((line) => line.values))
    const x = (i) => pad.l + (dates.length === 1 ? 0 : (i / (dates.length - 1)) * (W - pad.l - pad.r))
    const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
    const parts = []
    // Garis bantu & label sumbu (3 tingkat).
    for (const q of [0, 0.5, 1]) {
      const yy = y(max * q).toFixed(1)
      parts.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" class="grid"/>`)
      parts.push(`<text x="${pad.l - 6}" y="${(Number(yy) + 3.5).toFixed(1)}" text-anchor="end" class="axis">${compact(max * q)}</text>`)
    }
    const labelEvery = Math.max(1, Math.ceil(dates.length / 6))
    dates.forEach((date, i) => {
      if (i % labelEvery === 0 || i === dates.length - 1)
        parts.push(`<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${dayLabel(date, { day: 'numeric', month: 'short' })}</text>`)
    })
    for (const line of series) {
      const d = line.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
      parts.push(`<path d="${d}" fill="none" stroke="${line.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
      line.values.forEach((v, i) => {
        if (v > 0 && dates.length <= 31) parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2" fill="${line.color}"><title>${line.label} · ${dayLabel(dates[i])} · ${number(v)}</title></circle>`)
      })
    }
    svg.innerHTML = parts.join('')
    legend.replaceChildren(
      ...series.map((line) => {
        const item = document.createElement('span')
        const dot = document.createElement('i')
        dot.style.background = line.color
        item.append(dot, line.label)
        return item
      })
    )
    svg.closest('.wa-trend')?.toggleAttribute('hidden', !series.length)
  }
  function renderCalendar(calendar) {
    const box = byId('usageHeatmap')
    if (!box) return
    lastCalendar = calendar
    const key = JSON.stringify(calendar) + usageState.date + locale() + box.clientWidth
    if (key === calendarKey) return
    calendarKey = key
    const byDate = new Map(calendar.map((row) => [row.date, row]))
    const values = calendar.map((row) => row.tokens).filter((value) => value > 0).sort((a, b) => a - b)
    const cut = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))] || 0
    const steps = [cut(0.25), cut(0.5), cut(0.75)]
    const level = (tokens) => (!tokens ? 0 : tokens <= steps[0] ? 1 : tokens <= steps[1] ? 2 : tokens <= steps[2] ? 3 : 4)
    // 53 minggu ke belakang, kolom = minggu (Senin di atas), seperti GitHub. Digambar sebagai SVG.
    const end = todayWib()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - 364)
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
    const columns = Math.floor((end - start) / 86_400_000 / 7) + 1
    const left = 26
    const top = 16
    // Ukuran kotak menyesuaikan lebar panel; layar sempit → geser ke samping (terbaru di kanan).
    const fit = Math.floor((box.clientWidth - left) / columns)
    const gap = fit >= 13 ? 3 : 2
    const cell = Math.max(8, Math.min(13, fit - gap))
    const step = cell + gap
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    const width = left + columns * step
    const height = top + 7 * step
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('class', 'wa-heat')
    const text = (value, x, y, anchor = 'start') => {
      const node = document.createElementNS(NS, 'text')
      node.setAttribute('x', String(x))
      node.setAttribute('y', String(y))
      node.setAttribute('text-anchor', anchor)
      node.textContent = value
      svg.append(node)
      return node
    }
    for (const [row, iso] of [[0, '2024-01-01'], [2, '2024-01-03'], [4, '2024-01-05']])
      text(dayLabel(iso, { weekday: 'short' }), left - 6, top + row * step + cell - 1, 'end')
    let column = 0
    let lastMonth = -1
    let lastLabel = null
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const weekday = (cursor.getUTCDay() + 6) % 7
      if (weekday === 0 && cursor > start) column++
      const iso = isoOf(cursor)
      if (weekday === 0 && cursor.getUTCMonth() !== lastMonth) {
        lastMonth = cursor.getUTCMonth()
        // Label bulan berdekatan (bulan pertama yang terpotong) → pakai yang baru saja.
        if (lastLabel && column - lastLabel.column < 3) lastLabel.node.remove()
        if (column < columns - 2) lastLabel = { column, node: text(dayLabel(iso, { month: 'short' }), left + column * step, top - 5) }
      }
      const row = byDate.get(iso)
      const rect = document.createElementNS(NS, 'rect')
      rect.setAttribute('x', String(left + column * step))
      rect.setAttribute('y', String(top + weekday * step))
      rect.setAttribute('width', String(cell))
      rect.setAttribute('height', String(cell))
      rect.setAttribute('rx', '2')
      rect.dataset.date = iso
      rect.dataset.level = String(level(row?.tokens || 0))
      if (iso === usageState.date) rect.dataset.selected = 'true'
      const title = document.createElementNS(NS, 'title')
      title.textContent = row
        ? t('{0}: {1} token · {2} proses', dayLabel(iso), number(row.tokens), number(row.runs))
        : t('{0}: tidak ada pemakaian', dayLabel(iso))
      rect.append(title)
      svg.append(rect)
    }
    box.replaceChildren(svg)
    box.scrollLeft = box.scrollWidth
    const total = calendar.reduce((sum, row) => sum + row.tokens, 0)
    const busiest = calendar.reduce((best, row) => (row.tokens > (best?.tokens || 0) ? row : best), null)
    byId('usageHeatSummary').textContent = calendar.length
      ? t('{0} token dalam 1 tahun · tersibuk {1} ({2})', compact(total), dayLabel(busiest.date, { day: 'numeric', month: 'short' }), compact(busiest.tokens))
      : t('Belum ada penggunaan tercatat')
  }
  byId('usageHeatmap')?.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-date]')
    if (!cell) return
    usageState.date = usageState.date === cell.dataset.date ? '' : cell.dataset.date
    runsState.extended = false
    updateUsage()
  })
  byId('usageDay')?.addEventListener('click', () => {
    usageState.date = ''
    runsState.extended = false
    updateUsage()
  })
  byId('usageRange')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]')
    if (!button) return
    usageState.days = Number(button.dataset.days)
    usageState.date = ''
    runsState.extended = false
    updateUsage()
  })
  byId('usageTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-usage-show]')
    if (!button) return
    showUsageTab(button.dataset.usageShow)
  })
  function renderSummary(data) {
    const sum = (key) => data.providers.reduce((total, row) => total + Number(row[key] || 0), 0)
    const input = sum('input')
    const output = sum('output')
    const runs = sum('runs')
    const failed = sum('failed')
    const measured = sum('measured')
    const duration = runs ? data.providers.reduce((total, row) => total + row.durationMs * row.runs, 0) / runs : 0
    const cards = byId('usageCards')
    cards.replaceChildren()
    for (const [label, value, extra] of [
      [t('Token'), measured ? compact(input + output) : '—', measured ? t('input {0} · output {1}', compact(input), compact(output)) : ''],
      [t('Proses AI'), number(runs), failed ? t('{0} gagal', number(failed)) : ''],
      [t('Cache dibaca'), input ? `${Math.round((sum('cached') / input) * 100)}%` : '—', input ? t('{0} token dari cache', compact(sum('cached'))) : ''],
      [t('Rata-rata'), runs ? t('{0} dtk', number(Math.round(duration / 1000))) : '—', t('per proses')],
    ]) {
      const card = textElement('article', '', 'wa-usage-stat')
      card.append(textElement('small', label), textElement('strong', value))
      if (extra) card.append(textElement('span', extra, 'wa-usage-caption'))
      cards.append(card)
    }
    const names = { claude: 'Claude', gemini: 'Gemini', chatgpt: 'ChatGPT', typesafe: 'Jev' }
    const used = data.providers.filter((row) => row.runs)
    byId('usageProviders').textContent = used.length
      ? used.map((row) => `${names[row.provider] || row.provider} ${row.measured ? compact(row.input + row.output) : '—'} (${number(row.runs)} ${t('proses')})`).join(' · ')
      : ''
    for (const button of byId('usageRange').querySelectorAll('button'))
      button.setAttribute('aria-pressed', String(!usageState.date && Number(button.dataset.days) === usageState.days))
    const chip = byId('usageDay')
    chip.hidden = !usageState.date
    chip.textContent = usageState.date ? `${dayLabel(usageState.date)} ×` : ''
    chip.title = t('Kembali ke rentang')
  }
  /* Proses terbaru: 20 per halaman, "Muat lebih banyak", filter dari klik baris model/fase. */
  function runRow(run) {
    const row = document.createElement('tr')
    const date = new Intl.DateTimeFormat(locale(), {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(run.createdAt))
    for (const value of [
      date,
      run.phase || '—',
      `${({ claude: 'Claude', gemini: 'Gemini', typesafe: 'Jev' })[run.provider] || 'ChatGPT'} / ${String(run.model).replace(' (otomatis)', ` (${t('otomatis')})`)}`,
      run.tokens === null ? '—' : number(run.tokens),
      t("{0} dtk", number(Math.round(run.durationMs / 1000))),
      run.status === 'completed' ? t('Selesai') : t('Gagal'),
    ])
      row.append(textElement('td', value))
    if (run.input !== null)
      row.title = t(
        'Input {0} · output {1} · cache dibaca {2} · cache ditulis {3}',
        number(run.input),
        number(run.output),
        number(run.cached),
        number(run.cacheWrite || 0)
      )
    return row
  }
  function runsQuery(before = 0) {
    const params = new URLSearchParams(usageState.date ? { date: usageState.date } : { days: String(usageState.days) })
    const filter = runsState.filter
    if (filter?.model) params.set('model', filter.model)
    if (filter?.provider) params.set('provider', filter.provider)
    if (filter?.phase) params.set('phase', filter.phase)
    if (before) params.set('before', String(before))
    return params
  }
  async function loadRuns(append, fallback = []) {
    const recent = byId('usageRecent')
    if (!recent || runsState.busy) return
    runsState.busy = true
    const more = byId('usageRunsMore')
    if (more) more.disabled = true
    let data
    try {
      const response = await fetch(`${base}/api/ai/usage/runs?${runsQuery(append ? runsState.next : 0)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok || response.redirected) throw new Error('runs')
      data = await response.json()
    } catch {
      data = append ? null : { runs: runsState.filter ? [] : fallback, total: runsState.filter ? 0 : fallback.length, next: 0 }
    }
    runsState.busy = false
    if (!data) {
      if (more) more.disabled = false
      return
    }
    if (!append) {
      recent.replaceChildren()
      runsState.shown = 0
    }
    for (const run of data.runs) recent.append(runRow(run))
    runsState.shown += data.runs.length
    runsState.next = data.next
    runsState.total = data.total
    if (!runsState.shown) {
      const row = document.createElement('tr')
      const cell = textElement('td', t('Belum ada penggunaan tercatat'))
      cell.colSpan = 6
      row.append(cell)
      recent.append(row)
    }
    const info = byId('usageRunsInfo')
    if (info) info.textContent = runsState.total ? t('Menampilkan {0} dari {1} proses', number(runsState.shown), number(runsState.total)) : ''
    if (more) {
      more.hidden = !runsState.next
      more.disabled = false
    }
    const chip = byId('usageRunsFilter')
    if (chip) {
      const f = runsState.filter
      chip.hidden = !f
      chip.textContent = f ? `${f.phase ? t('Fase: {0}', f.phase) : t('Model: {0}', f.model.replace(' (otomatis)', ` (${t('otomatis')})`))} ×` : ''
    }
  }
  function showUsageTab(name) {
    for (const item of byId('usageTabs').querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset.usageShow === name))
    for (const panel of document.querySelectorAll('[data-usage-tab]')) panel.hidden = panel.dataset.usageTab !== name
  }
  byId('usageRunsMore')?.addEventListener('click', () => {
    runsState.extended = true
    loadRuns(true)
  })
  byId('usageRunsFilter')?.addEventListener('click', () => {
    runsState.filter = null
    runsState.extended = false
    loadRuns(false)
  })
  for (const id of ['usageModels', 'usagePhases'])
    byId(id)?.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-filter-model], tr[data-filter-phase]')
      if (!row) return
      runsState.filter = row.dataset.filterPhase
        ? { phase: row.dataset.filterPhase }
        : { model: row.dataset.filterModel, provider: row.dataset.filterProvider }
      runsState.extended = true
      showUsageTab('recent')
      loadRuns(false)
    })
  async function updateUsage() {
    if (loading || document.hidden) return
    loading = true
    byId('usageRefresh').disabled = true
    try {
      const query = usageState.date ? `date=${usageState.date}` : `days=${usageState.days}`
      const response = await fetch(`${base}/api/ai/usage?${query}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok || response.redirected)
        throw new Error(t('Usage belum dapat dimuat. Coba perbarui.'))
      const data = await response.json()
      renderCalendar(data.calendar || [])
      renderTrend(data.calendar || [])
      renderSummary(data)
      const phases = byId('usagePhases')
      if (phases) {
        phases.replaceChildren()
        const spent = (data.phases || []).map((row) => row.input + row.output)
        const largest = Math.max(1, ...spent)
        ;(data.phases || []).forEach((row, index) => {
          const line = document.createElement('tr')
          for (const [value, className] of [
            [row.phase, ''],
            [number(row.runs), 'wa-usage-number'],
            [number(row.input), 'wa-usage-number'],
            [number(row.cached), 'wa-usage-number'],
            [number(row.cacheWrite), 'wa-usage-number'],
            [number(row.output), 'wa-usage-number'],
            [`${Math.round((spent[index] / largest) * 100)}%`, 'wa-usage-number'],
          ])
            line.append(textElement('td', value, className))
          line.title = `${t("Rata-rata {0} dtk per proses", number(Math.round(row.durationMs / 1000)))} · ${t('Klik untuk melihat prosesnya')}`
          line.dataset.filterPhase = row.phase
          phases.append(line)
        })
        if (!(data.phases || []).length) {
          const line = document.createElement('tr')
          const cell = textElement('td', t('Belum ada penggunaan tercatat'))
          cell.colSpan = 7
          line.append(cell)
          phases.append(line)
        }
      }
      const models = byId('usageModels')
      if (models) {
        models.replaceChildren()
        // Ringkas: satu angka token (input + output) dan porsinya; cache tidak dihitung.
        const totalTokens = (data.models || []).reduce((sum, row) => sum + row.input + row.output, 0) || 1
        for (const row of data.models || []) {
          const line = document.createElement('tr')
          const name = textElement('td', '')
          const dot = document.createElement('i')
          dot.className = `wa-provider-dot ${row.provider}`
          name.append(dot, ` ${row.model.replace(' (otomatis)', ` (${t('otomatis')})`)}`)
          line.append(name)
          for (const [value, className] of [
            [number(row.runs), 'wa-usage-number'],
            [compact(row.input + row.output), 'wa-usage-number'],
            [`${Math.round(((row.input + row.output) / totalTokens) * 100)}%`, 'wa-usage-number'],
          ])
            line.append(textElement('td', value, className))
          line.dataset.filterModel = row.model
          line.dataset.filterProvider = row.provider
          line.title = t('Klik untuk melihat prosesnya')
          models.append(line)
        }
        if (!(data.models || []).length) {
          const line = document.createElement('tr')
          const cell = textElement('td', t('Belum ada penggunaan tercatat'))
          cell.colSpan = 4
          line.append(cell)
          models.append(line)
        }
      }
      // Proses terbaru: halaman pertama dari /runs (bisa difilter & dimuat lagi); cadangan data.recent.
      if (!runsState.extended) await loadRuns(false, data.recent)
      byId('usageStatus').textContent = ''
    } catch (error) {
      byId('usageStatus').textContent = error.message
    } finally {
      loading = false
      byId('usageRefresh').disabled = false
    }
  }
  byId('usageRefresh').addEventListener('click', updateUsage)
  window.setInterval(() => {
    if (!byId('settings-usage').hidden) updateUsage()
  }, 15000)
})()
