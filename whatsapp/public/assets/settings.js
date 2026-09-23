;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const form = document.getElementById('settingsForm')
  if (!form) return
  const panels = [...form.querySelectorAll('[data-settings-panel]')]
  const menu = [...document.querySelectorAll('[data-settings-menu]')]
  const byId = (id) => document.getElementById(id)
  const number = (value) => new Intl.NumberFormat((window.waI18n?.locale || 'id-ID')).format(value)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  let loading = false
  let evaluationLoading = false
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

  function selectPanel() {
    const hash = window.location.hash.slice(1)
    const selected = panels.some((panel) => panel.dataset.settingsPanel === hash) ? hash : 'ai'
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== selected
    for (const link of menu) {
      if (link.dataset.settingsMenu === selected) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    if (selected === 'usage') updateUsage()
    if (selected === 'evaluation') updateEvaluations()
  }
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
  async function updateUsage() {
    if (loading || document.hidden) return
    loading = true
    byId('usageRefresh').disabled = true
    try {
      const response = await fetch(`${base}/api/ai/usage`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok || response.redirected)
        throw new Error(t('Usage belum dapat dimuat. Coba perbarui.'))
      const data = await response.json()
      const cards = byId('usageCards')
      cards.replaceChildren()
      for (const usage of data.providers) {
        const card = textElement('article', '', 'wa-usage-card')
        card.append(textElement('h3', usage.provider === 'claude' ? 'Claude' : 'ChatGPT'))
        card.append(
          textElement(
            'strong',
            usage.measured ? number(usage.input + usage.output) : '—',
            'wa-usage-total'
          )
        )
        card.append(textElement('span', t('token tercatat'), 'wa-usage-caption'))
        const details = document.createElement('dl')
        for (const [label, value] of [
          ['Input', usage.measured ? number(usage.input) : '—'],
          ['Output', usage.measured ? number(usage.output) : '—'],
          [t('Cache dibaca'), usage.measured ? number(usage.cached) : '—'],
          [t('Cache ditulis'), usage.measured ? number(usage.cacheWrite) : '—'],
          [t('Proses AI'), number(usage.runs)],
          [t('Gagal'), number(usage.failed)],
          [t('Rata-rata'), usage.runs ? t("{0} dtk", number(Math.round(usage.durationMs / 1000))) : '—'],
        ])
          details.append(textElement('dt', label), textElement('dd', value))
        card.append(details)
        if (usage.runs > usage.measured)
          card.append(
            textElement(
              'small',
              t("{0} proses tanpa laporan token", number(usage.runs - usage.measured)),
              'wa-usage-caption'
            )
          )
        cards.append(card)
      }
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
          line.title = t("Rata-rata {0} dtk per proses", number(Math.round(row.durationMs / 1000)))
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
      const recent = byId('usageRecent')
      recent.replaceChildren()
      for (const run of data.recent) {
        const row = document.createElement('tr')
        const date = new Intl.DateTimeFormat((window.waI18n?.locale || 'id-ID'), {
          timeZone: 'Asia/Jakarta',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(run.createdAt))
        for (const value of [
          date,
          run.phase || '—',
          `${run.provider === 'claude' ? 'Claude' : 'ChatGPT'} / ${run.model}`,
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
        recent.append(row)
      }
      if (!data.recent.length) {
        const row = document.createElement('tr')
        const cell = textElement('td', t('Belum ada penggunaan tercatat'))
        cell.colSpan = 6
        row.append(cell)
        recent.append(row)
      }
      byId('usageStatus').textContent = t('Diperbarui otomatis setiap 15 detik')
    } catch (error) {
      byId('usageStatus').textContent = error.message
    } finally {
      loading = false
      byId('usageRefresh').disabled = false
    }
  }
  byId('usageRefresh').addEventListener('click', updateUsage)
  async function updateEvaluations() {
    if (evaluationLoading || document.hidden) return
    evaluationLoading = true
    byId('evaluationRefresh').disabled = true
    try {
      const response = await fetch(`${base}/api/ai/evaluations`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok || response.redirected) throw new Error(t('Evaluasi belum dapat dimuat.'))
      const data = await response.json()
      byId('evaluationStatus').textContent = !data.skills.length
        ? 'Import skill eval/evaluation untuk mulai mengevaluasi.'
        : !data.enabled
          ? t('Evaluasi dijeda karena AI nonaktif.')
          : t("Menggunakan {0} · Otomatis di latar belakang setelah percakapan berubah.", data.skills.join(', '))
      const metrics = byId('evaluationMetrics')
      metrics.replaceChildren()
      for (const [label, value] of [
        [t('Pelanggan'), number(data.customers)],
        [t('Dengan order'), number(data.ordered)],
        [
          'Order rate',
          data.orderRate === null ? '—' : `${number(Math.round(data.orderRate * 10) / 10)}%`,
        ],
      ]) {
        const card = textElement('article', '', 'wa-usage-card')
        card.append(textElement('h3', label), textElement('strong', value, 'wa-usage-total'))
        metrics.append(card)
      }
      const list = byId('evaluationList')
      const opened = new Set(
        [...list.querySelectorAll('details[open]')].map((item) => item.dataset.jid)
      )
      list.replaceChildren()
      const states = {
        pending: t('Menunggu evaluasi terbaru'),
        running: t('Sedang dievaluasi'),
        completed: t('Selesai'),
        failed: t('Belum selesai'),
      }
      const stages = {
        discovery: t('Kebutuhan'),
        selection: t('Pilihan produk'),
        checkout: t('Data pesanan'),
        payment: t('Pembayaran'),
        ordered: 'Order',
        support: t('Layanan'),
        unknown: t('Belum jelas'),
      }
      for (const row of data.recent) {
        const card = textElement('details', '', 'wa-evaluation-card')
        card.dataset.jid = row.jid
        card.open = opened.has(row.jid)
        card.append(textElement('summary', `${row.name} · ${states[row.status] || row.status}`))
        card.append(
          textElement(
            'small',
            new Intl.DateTimeFormat((window.waI18n?.locale || 'id-ID'), {
              timeZone: 'Asia/Jakarta',
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(row.updatedAt)) + ' WIB',
            'wa-usage-caption'
          )
        )
        if (row.result) {
          card.append(textElement('p', row.result.summary))
          const detail = textElement('dl', '', 'wa-evaluation-details')
          for (const [label, value] of [
            [t('Tahap'), stages[row.result.stage] || row.result.stage],
            [t('Kebutuhan terlewat'), row.result.missedNeeds.join('\n') || t('Tidak teridentifikasi')],
            [t('Tindak lanjut'), row.result.nextAction],
            [t('Bukti pesan'), row.result.evidenceMessageIds.join(', ') || t('Belum tersedia')],
            [
              t('Batas evaluasi'),
              row.result.limitations.join('\n') ||
                t('Observasi satu percakapan; bukan kesimpulan peningkatan konversi.'),
            ],
          ]) {
            detail.append(textElement('dt', label), textElement('dd', value))
          }
          card.append(detail)
        } else if (row.error) card.append(textElement('p', row.error))
        const versions = textElement('details')
        versions.append(textElement('summary', t('Skill saat evaluasi')))
        for (const skill of row.skills)
          versions.append(
            textElement(
              'p',
              `${skill.name} · ${skill.updatedAt ? new Date(skill.updatedAt).toLocaleString((window.waI18n?.locale || 'id-ID'), { timeZone: 'Asia/Jakarta' }) + ' WIB' : t('Waktu belum tercatat')}`
            )
          )
        card.append(versions)
        list.append(card)
      }
      if (!data.recent.length)
        list.append(textElement('p', t('Belum ada evaluasi tercatat.'), 'wa-usage-caption'))
    } catch (error) {
      byId('evaluationStatus').textContent = error.message
    } finally {
      evaluationLoading = false
      byId('evaluationRefresh').disabled = false
    }
  }
  byId('evaluationRefresh').addEventListener('click', updateEvaluations)
  window.setInterval(() => {
    if (!byId('settings-usage').hidden) updateUsage()
    if (!byId('settings-evaluation').hidden) updateEvaluations()
  }, 15000)
})()
