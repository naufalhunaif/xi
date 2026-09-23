;(() => {
  const root = document.getElementById('productionSettings')
  if (!root) return
  const t = (key, ...args) => window.waI18n?.t(key, ...args) ?? key
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const byId = (id) => document.getElementById(id)
  const kinds = ['preorder', 'custom']
  const label = (kind) => (kind === 'preorder' ? 'Pre-order' : 'Custom')
  let policy,
    pending = false,
    busy = false,
    dirty = false,
    timer,
    loaded = false
  const element = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text) node.textContent = text
    if (className) node.className = className
    return node
  }
  function status(text, error = false) {
    byId('productionSaveStatus').textContent = text
    byId('productionSaveStatus').classList.toggle('error', error)
  }
  async function request(method = 'GET', body) {
    const response = await fetch(`${base}/api/settings/production`, {
      method,
      cache: 'no-store',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content || '',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.redirected)
      throw new Error(t('Sesi berakhir. Muat ulang halaman untuk masuk kembali.'))
    const data = await response.json()
    if (!response.ok) throw new Error(t(data.error || 'Invalid production settings.'))
    if (!data.policy?.rules) throw new Error(t('Invalid production settings.'))
    return data
  }
  function toggle(button, value) {
    button.value = String(value)
    button.setAttribute('aria-checked', String(value))
  }
  function renderRules() {
    const container = byId('productionRules')
    container.replaceChildren()
    toggle(byId('productionAuto'), policy.autoAdjust)
    byId('productionAuto').disabled = false
    for (const kind of kinds) {
      const rule = policy.rules[kind]
      const card = element('section', '', 'wa-production-rule')
      const heading = element('div', '', 'wa-toggle-row')
      heading.append(element('h3', label(kind)))
      const enabled = element('button', '', 'wa-switch')
      enabled.type = 'button'
      enabled.setAttribute('role', 'switch')
      enabled.setAttribute('aria-label', `${t('Aktifkan')} ${label(kind)}`)
      toggle(enabled, rule.enabled)
      enabled.dataset.productionKind = kind
      enabled.dataset.productionField = 'enabled'
      heading.append(enabled)
      card.append(heading)
      const days = element('div', '', 'wa-production-days')
      for (const [field, title] of [
        ['minDays', 'Minimum (hari)'],
        ['estimateDays', 'Estimasi (hari)'],
        ['maxDays', 'Maksimum (hari)'],
      ]) {
        const wrapper = element('label')
        wrapper.append(element('span', t(title)))
        const input = element('input')
        input.type = 'number'
        input.min = '1'
        input.max = '365'
        input.step = '1'
        input.value = rule[field] ?? ''
        input.dataset.productionKind = kind
        input.dataset.productionField = field
        wrapper.append(input)
        days.append(wrapper)
      }
      card.append(days)
      const settings = element('div', '', 'wa-production-options')
      for (const [field, title, options] of [
        [
          'dayType',
          'Jenis hari',
          [
            ['calendar', 'Hari kalender'],
            ['working', 'Hari kerja'],
          ],
        ],
        [
          'startsAfter',
          'Dihitung sejak',
          [
            ['payment_details', 'DP + detail lengkap'],
            ['full_payment_details', 'Lunas + detail lengkap'],
            ['approval', 'Persetujuan produksi'],
          ],
        ],
      ]) {
        const wrapper = element('label')
        wrapper.append(element('span', t(title)))
        const input = element('select')
        input.dataset.productionKind = kind
        input.dataset.productionField = field
        for (const [value, title] of options) {
          const option = element('option', t(title))
          option.value = value
          input.append(option)
        }
        input.value = rule[field]
        wrapper.append(input)
        settings.append(wrapper)
      }
      card.append(settings)
      container.append(card)
    }
  }
  function renderInfo(data) {
    byId('productionEvaluationStatus').textContent = t(
      data.evaluationReady ? 'AI eval siap' : 'AI eval belum siap'
    )
    byId('productionEvaluationDetail').textContent = !data.evaluationReady
      ? t('Auto-adjust menunggu AI aktif dan skill eval/evaluation.')
      : t('AI eval siap. Sinyal pelanggan bukan bukti kenaikan konversi.')
    if (data.signals?.length)
      byId('productionEvaluationDetail').textContent +=
        ' ' +
        t(
          'Sinyal evaluasi: {0}',
          data.signals
            .map(
              (signal) =>
                `${label(signal.kind)} ${signal.direction === 'shorter' ? '↓' : '↑'} ${signal.customers}`
            )
            .join(' · ')
        )
    const container = byId('productionHistory')
    container.replaceChildren()
    if (!data.history.length) container.append(element('p', t('Belum ada penyesuaian.')))
    for (const item of data.history) {
      const row = element('article', '', 'wa-production-change')
      row.append(element('strong', item.actor === 'ai_eval' ? 'AI eval' : t('Pemilik')))
      const time = element('time')
      time.dateTime = item.createdAt
      time.dataset.relativeTime = ''
      time.title = new Date(item.createdAt).toLocaleString(window.waI18n?.locale || 'en-US')
      row.append(document.createTextNode(' · '), time)
      for (const kind of kinds) {
        const before = item.before.rules[kind],
          after = item.after.rules[kind]
        if (JSON.stringify(before) === JSON.stringify(after)) continue
        const format = (r) =>
          `${r.enabled ? t('Aktif') : t('Nonaktif')} · ${r.estimateDays ?? '—'} ${t(r.dayType === 'working' ? 'Hari kerja' : 'Hari kalender')} (${r.minDays ?? '—'}–${r.maxDays ?? '—'}) · ${t({ payment_details: 'DP / pembayaran & detail lengkap', full_payment_details: 'Lunas & detail lengkap', approval: 'Persetujuan produksi' }[r.startsAfter])}`
        row.append(element('p', `${label(kind)}\n${format(before)} → ${format(after)}`))
      }
      if (item.before.autoAdjust !== item.after.autoAdjust)
        row.append(
          element(
            'p',
            `${t('Penyesuaian AI eval')}: ${item.after.autoAdjust ? t('Aktif') : t('Nonaktif')}`
          )
        )
      if (item.actor === 'ai_eval') row.append(element('p', item.reason))
      if (item.evidence?.length) {
        const details = element('details')
        details.append(element('summary', t('Lihat percakapan')))
        for (const evidence of item.evidence) {
          const link = element('a', `${t('Lihat percakapan')} · ${evidence.reason}`)
          link.href = `${base}/?jid=${encodeURIComponent(evidence.jid)}`
          const p = element('p')
          p.append(link)
          details.append(p)
        }
        row.append(details)
      }
      container.append(row)
    }
    document.dispatchEvent(new Event('skills:updated'))
  }
  function draft() {
    const next = structuredClone(policy)
    next.autoAdjust = byId('productionAuto').value === 'true'
    for (const input of root.querySelectorAll('[data-production-field]')) {
      const field = input.dataset.productionField
      next.rules[input.dataset.productionKind][field] =
        field === 'enabled'
          ? input.value === 'true'
          : input.type === 'number'
            ? input.value === ''
              ? null
              : Number(input.value)
            : input.value
    }
    return next
  }
  async function flush() {
    if (busy || !loaded) return
    busy = true
    while (pending) {
      pending = false
      const body = draft()
      status(t('Menyimpan…'))
      try {
        const data = await request('PUT', body)
        policy = data.policy
        renderInfo(data)
        if (!pending && !timer) {
          dirty = false
          status(t('Tersimpan'))
        }
      } catch (error) {
        status(t('Belum tersimpan: {0}', error.message), true)
        pending = false
        break
      }
    }
    busy = false
  }
  root.addEventListener('input', (event) => {
    if (!event.target.matches('input[data-production-field]')) return
    dirty = true
    clearTimeout(timer)
    status(t('Menunggu selesai mengetik…'))
    timer = setTimeout(() => {
      timer = null
      pending = true
      void flush()
    }, 1000)
  })
  root.addEventListener('change', (event) => {
    if (!event.target.matches('[data-production-field], #productionAuto')) return
    clearTimeout(timer)
    timer = null
    dirty = true
    pending = true
    void flush()
  })
  // Switches are toggled by the existing settings form handler (including keyboard activation).
  async function load() {
    if (busy) return
    if (dirty && !window.confirm(t('Muat ulang dan buang perubahan yang belum tersimpan?'))) return
    clearTimeout(timer)
    timer = null
    pending = false
    busy = true
    status(t('Memuat…'))
    try {
      const data = await request()
      policy = data.policy
      loaded = true
      dirty = false
      renderRules()
      renderInfo(data)
      status(t('Tersimpan otomatis'))
    } catch (error) {
      status(error.message, true)
    } finally {
      busy = false
    }
  }
  byId('productionReload').addEventListener('click', load)
  const open = () => {
    if (location.hash === '#production' && !loaded) void load()
  }
  window.addEventListener('hashchange', open)
  document.addEventListener('ui-language:change', () => {
    if (loaded && !dirty && !busy) {
      renderRules()
      void load()
    }
  })
  window.addEventListener('beforeunload', (event) => {
    if (dirty || busy || pending || timer) event.preventDefault()
  })
  open()
})()
