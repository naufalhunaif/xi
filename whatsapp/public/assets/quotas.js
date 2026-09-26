;(() => {
  const root = document.getElementById('quotaCards')
  if (!root) return
  const panel = document.getElementById('settings-usage')
  const status = document.getElementById('quotaStatus')
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const t = (key, ...args) => window.waI18n?.t(key, ...args) ?? key.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
  const locale = () => window.waI18n?.locale || 'en-US'
  const el = (tag, text = '', className = '') => {
    const node = document.createElement(tag)
    node.textContent = text
    node.className = className
    return node
  }
  let loading = false
  let failed = false
  let providers = []
  let configuredProvider = ''
  let failoverEnabled = false
  const period = (window) => {
    const suffix = {
      seven_day_opus: ' · Opus', seven_day_sonnet: ' · Sonnet',
      seven_day_overage_included: ` · ${t('Kuota tambahan')}`, overage: '',
    }[window.key] || ''
    const minutes = window.minutes
    const name = !minutes ? t('Periode layanan') : minutes % 1440 === 0
      ? t('{0} hari', minutes / 1440) : minutes % 60 === 0
        ? t('{0} jam', minutes / 60) : t('{0} menit', minutes)
    const bucket = window.bucket && !['codex', 'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage'].includes(window.bucket)
      ? ` · ${window.bucket}` : ''
    return name + suffix + bucket
  }
  const resetLabel = (at) => {
    if (!at) return t('Waktu reset belum tersedia')
    const minutes = Math.ceil((at * 1000 - Date.now()) / 60000)
    if (minutes <= 0) return t('Menunggu data setelah reset')
    const duration = minutes >= 1440 ? t('{0} hari', Math.ceil(minutes / 1440))
      : minutes >= 60 ? t('{0} jam', Math.ceil(minutes / 60)) : t('{0} menit', minutes)
    return t('Reset dalam {0}', duration)
  }
  let accounts = []
  const shortPeriod = (window) => {
    const minutes = window.minutes
    if (!minutes) return t('Periode')
    return minutes % 1440 === 0 ? t('{0} hari', minutes / 1440) : minutes % 60 === 0 ? t('{0} jam', minutes / 60) : t('{0} menit', minutes)
  }
  const tokens = (n) => (n >= 1000 ? `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(n / 1000)}rb` : String(n))
  // Semua akun AI terdaftar: satu baris per akun, progres kecil per jendela kuota.
  function renderAccounts() {
    root.replaceChildren()
    root.classList.add('wa-quota-accounts')
    for (const account of accounts) {
      const row = el('div', '', 'wa-quota-account')
      const who = el('div', '', 'wa-quota-who')
      who.append(el('strong', account.name))
      const meta = [account.provider === 'chatgpt' ? 'ChatGPT' : account.provider === 'claude' ? 'Claude' : 'Gemini']
      if (!account.enabled) meta.push(t('Nonaktif'))
      who.append(el('small', meta.join(' · '), 'wa-usage-caption'))
      row.append(who)
      const bars = el('div', '', 'wa-quota-mini-list')
      const windows = (account.windows || []).filter((window) => !['overage', 'seven_day_overage_included'].includes(window.key))
      for (const window of windows.slice(0, 3)) {
        const expired = window.expired || (window.resetsAt && window.resetsAt * 1000 <= Date.now())
        const stale = failed || window.stale || Date.now() - window.observedAt > 600000
        const remaining = !expired && typeof window.remainingPercent === 'number' ? Math.max(0, Math.min(100, window.remainingPercent)) : expired ? 100 : null
        const item = el('div', '', 'wa-quota-mini')
        const label = el('span', shortPeriod(window), 'wa-quota-mini-label')
        const bar = el('progress', '', 'wa-quota-bar wa-quota-bar--mini')
        bar.max = 100
        bar.value = remaining ?? 0
        bar.dataset.level = remaining === null || stale ? 'stale' : remaining <= 10 ? 'low' : remaining <= 30 ? 'warning' : 'good'
        const value = el('span', remaining === null ? '—' : `${Math.round(remaining)}%`, 'wa-quota-mini-value')
        const title = [`${account.name} · ${shortPeriod(window)}`, remaining === null ? '' : t('Sisa {0}%', Math.round(remaining)), resetLabel(window.resetsAt), stale && window.observedAt ? t('Diperbarui {0}', new Date(window.observedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })) : '']
          .filter(Boolean)
          .join(' · ')
        item.title = title
        bar.setAttribute('aria-label', title)
        item.append(label, bar, value)
        bars.append(item)
      }
      if (!windows.length)
        bars.append(
          el(
            'small',
            account.provider === 'gemini'
              ? t('Kuota tidak dilaporkan · {0} token / 5 jam', tokens(account.tokens5h || 0))
              : account.provider === 'claude'
                ? t('Muncul setelah akun ini dipakai AI')
                : t('Kuota belum terbaca'),
            'wa-usage-caption'
          )
        )
      row.append(bars)
      if (account.limitedUntil > Date.now()) {
        const until = new Date(account.limitedUntil).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
        row.append(el('span', t('Jeda s/d {0}', until), 'wa-pill warn'))
      }
      root.append(row)
    }
  }
  function render() {
    if (accounts.length) return renderAccounts()
    root.classList.remove('wa-quota-accounts')
    root.replaceChildren()
    for (const provider of ['chatgpt', 'claude']) {
      const data = providers.find((item) => item.provider === provider)
      const name = provider === 'claude' ? 'Claude' : 'ChatGPT / Codex'
      const card = el('article', '', 'wa-usage-card wa-quota-card')
      card.append(el('h3', name))
      const limitedUntil = Number(data?.limitedUntil || 0)
      if (limitedUntil > Date.now()) {
        const minutes = Math.ceil((limitedUntil - Date.now()) / 60000)
        const duration = minutes >= 1440 ? t('{0} hari', Math.ceil(minutes / 1440))
          : minutes >= 60 ? t('{0} jam', Math.ceil(minutes / 60)) : t('{0} menit', minutes)
        const badge = el('small', t('Ditandai habis · dicoba lagi dalam {0}', duration), 'wa-usage-caption wa-quota-limited')
        badge.title = new Date(limitedUntil).toLocaleString(locale())
        card.append(badge)
      } else if (failoverEnabled && provider !== configuredProvider) {
        card.append(el('small', t('Mesin cadangan otomatis'), 'wa-usage-caption'))
      }
      if (!data?.windows?.length) {
        card.append(el('span', t('Kuota belum tersedia'), 'wa-usage-caption'))
      }
      for (const window of data?.windows || []) {
        const expired = window.expired || (window.resetsAt && window.resetsAt * 1000 <= Date.now())
        const stale = failed || data.refreshFailed || window.stale || Date.now() - window.observedAt > 300000
        const remaining = !expired && typeof window.remainingPercent === 'number'
          ? Math.max(0, Math.min(100, window.remainingPercent)) : null
        const block = el('div', '', 'wa-quota-window')
        const line = el('div', '', 'wa-quota-line')
        line.append(el('span', period(window)))
        const amount = remaining === null ? '—' : t(stale ? 'Terakhir: sisa {0}%' : 'Sisa {0}%',
          new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(remaining))
        line.append(el('strong', amount))
        block.append(line)
        if (remaining !== null) {
          const bar = el('progress', '', 'wa-quota-bar')
          bar.max = 100
          bar.value = remaining
          bar.setAttribute('aria-label', `${name} · ${period(window)} · ${amount}`)
          bar.dataset.level = stale ? 'stale' : remaining <= 10 ? 'low' : remaining <= 30 ? 'warning' : 'good'
          block.append(bar)
        }
        const reset = el('small', resetLabel(window.resetsAt), 'wa-usage-caption')
        if (window.resetsAt) reset.title = new Date(window.resetsAt * 1000).toLocaleString(locale())
        block.append(reset)
        if (!expired && window.status === 'rejected')
          block.append(el('small', t(stale ? 'Batas tercapai pada pembaruan terakhir' : 'Batas pemakaian tercapai'), 'wa-usage-caption'))
        if (window.observedAt) {
          const updated = el('small', t('Diperbarui {0}', new Date(window.observedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })), 'wa-usage-caption')
          updated.title = new Date(window.observedAt).toLocaleString(locale())
          block.append(updated)
        }
        card.append(block)
      }
      if (provider === 'claude')
        card.append(el('small', t('Diperbarui dari laporan limit Claude saat AI berjalan.'), 'wa-usage-caption'))
      root.append(card)
    }
  }
  async function refresh() {
    if (loading || panel.hidden || document.hidden) return
    loading = true
    root.setAttribute('aria-busy', 'true')
    try {
      const response = await fetch(`${base}/api/ai/quotas`, {
        headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      })
      if (!response.ok || response.redirected) throw new Error('Unavailable')
      const data = await response.json()
      if (!Array.isArray(data.providers)) throw new Error('Invalid response')
      providers = data.providers
      accounts = Array.isArray(data.accounts) ? data.accounts : []
      configuredProvider = data.configuredProvider || ''
      failoverEnabled = data.failoverEnabled === true
      failed = false
      status.textContent = providers.some((item) => item.refreshFailed)
        ? t('Pembaruan kuota belum tersedia. Data terakhir mungkin sudah berubah.') : ''
    } catch {
      failed = true
      status.textContent = t('Pembaruan kuota belum tersedia. Data terakhir mungkin sudah berubah.')
    } finally {
      loading = false
      root.setAttribute('aria-busy', 'false')
      render()
    }
  }
  document.getElementById('usageRefresh')?.addEventListener('click', refresh)
  window.addEventListener('hashchange', refresh)
  document.addEventListener('visibilitychange', refresh)
  document.addEventListener('ui-language:change', () => { render(); refresh() })
  window.setInterval(() => { if (!panel.hidden && !document.hidden) { render(); refresh() } }, 30000)
  render()
  refresh()
})()
