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
  function render() {
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
