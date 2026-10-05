;(() => {
  const en = window.waLocales?.en || {}
  // v3.6.26: katalog Indonesia dihapus — hanya Inggris.
  const id = {}
  const app = document.querySelector('meta[name="app-url"]')?.content?.replace(/\/$/, '') || ''
  const workspace = document.querySelector('meta[name="whatsapp-workspace-id"]')?.content || '1'
  const key = workspace === '1' ? `${app}:ui-language` : `${app}:${workspace}:ui-language`
  // v3.6.5: tampilan selalu Inggris (pilihan bahasa dihapus; teks campur EN/ID membingungkan).
  let language = 'en'
  void key
  const reverse = new Map([...Object.entries(en), ...Object.entries(id)].map(([key, translated]) => [translated, key]))
  const t = (text, ...values) => {
    const source = reverse.get(text) || text
    const value = language === 'en' ? (en[source] ?? text) : (id[source] ?? source)
    return values.length
      ? value.replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match)
      : value
  }
  const normalize = (text) => text.replace(/\s+/g, ' ').trim()
  const patterns = Object.entries(en)
    .filter(([source]) => source.includes('{0}'))
    .flatMap(([source, target]) =>
      [...new Set([source, target, id[source] || source])].map((value) => ({
        source,
        expression: new RegExp(
          '^' +
            normalize(value)
              .split(/\{\d+\}/)
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('(.*?)') +
            '$'
        ),
      }))
    )
  const translateKnown = (text) => {
    const value = normalize(text)
    const source = Object.hasOwn(en, value) ? value : reverse.get(value)
    if (source) return text.replace(value, t(source))
    for (const pattern of patterns) {
      const match = value.match(pattern.expression)
      if (match) return t(pattern.source, ...match.slice(1))
    }
    return text
  }
  function apply(root = document) {
    const elements = [
      ...root.querySelectorAll(
        '[data-i18n], [data-i18n-auto], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-alt]'
      ),
    ]
    if (root instanceof Element) elements.unshift(root)
    for (const element of elements) {
      if (
        element.hasAttribute('data-i18n') &&
        !element.hasAttribute('data-i18n-auto') &&
        !element.matches('time[data-relative-time]')
      ) {
        // Only annotate literal UI text, never customer/business/skill content.
        for (const node of element.childNodes)
          if (node.nodeType === Node.TEXT_NODE && node.textContent.trim())
            node.textContent = node.textContent.replace(
              node.textContent.trim(),
              t(element.dataset.i18n)
            )
      }
      if (element.hasAttribute('data-i18n-auto')) {
        for (const node of element.childNodes)
          if (node.nodeType === Node.TEXT_NODE) node.textContent = translateKnown(node.textContent)
      }
      for (const attribute of ['title', 'placeholder', 'aria-label', 'alt']) {
        const source = element.getAttribute(`data-i18n-${attribute}`)
        if (source) element.setAttribute(attribute, t(source))
      }
    }
    // These selectors contain application controls, not customer names, messages,
    // product descriptions, skill contents, or business records.
    for (const control of root.querySelectorAll(
      '#settingsForm .wa-setting-icon, #settingsForm [data-skill-delete], #settingsForm .wa-switch, #settingsForm .wa-connection-indicator, #settingsForm .wa-payment-details small, #settingsForm [data-payment-edit], #settingsForm [data-payment-delete], #settingsForm [data-remove-exclusion], time[data-relative-time]'
    )) {
      if (!control.matches('time[data-relative-time]'))
        for (const node of control.childNodes)
          if (node.nodeType === Node.TEXT_NODE) node.textContent = translateKnown(node.textContent)
      for (const attribute of ['aria-label', 'title']) {
        if (control.hasAttribute(attribute))
          control.setAttribute(attribute, translateKnown(control.getAttribute(attribute)))
      }
    }
  }
  function sync() {
    document.documentElement.lang = language
    const select = document.getElementById('uiLanguage')
    if (select) select.value = language
    apply()
    // Relative ages deliberately retain the compact "ago" format in both languages.
    document.dispatchEvent(new CustomEvent('skills:updated'))
  }
  function setLanguage(value) {
    language = value === 'id' ? 'id' : 'en'
    try {
      localStorage.setItem(key, language)
    } catch {}
    sync()
    document.dispatchEvent(new CustomEvent('ui-language:change'))
  }
  window.waI18n = {
    t,
    apply,
    setLanguage,
    get language() {
      return language
    },
    get locale() {
      return language === 'id' ? 'id-ID' : 'en-US'
    },
  }
  document.documentElement.lang = language

  // v3.6.10: waktu relatif ringkas untuk label "terakhir …" (1s ago, 5m ago, 3h ago, 2d ago).
  // <time data-relative-time datetime="…"> disegarkan tiap 10 detik; judulnya menyimpan tanggal lengkap.
  const toMs = (value) =>
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime()
  const fullDate = (value) =>
    new Date(toMs(value)).toLocaleString('en-US', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  const ago = (value) => {
    const ms = toMs(value)
    if (!Number.isFinite(ms)) return '—'
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (seconds < 1) return 'just now'
    const units = [
      [31536000, 'y'],
      [2592000, 'mo'],
      [86400, 'd'],
      [3600, 'h'],
      [60, 'm'],
    ]
    const unit = units.find(([size]) => seconds >= size)
    return unit ? `${Math.floor(seconds / unit[0])}${unit[1]} ago` : `${seconds}s ago`
  }
  const relativeNode = (value, node) => {
    const time = node || document.createElement('time')
    const ms = toMs(value)
    if (!Number.isFinite(ms)) {
      time.textContent = '—'
      return time
    }
    time.dateTime = new Date(ms).toISOString()
    time.dataset.relativeTime = ''
    time.title = fullDate(ms)
    time.textContent = ago(ms)
    return time
  }
  const refreshRelative = () => {
    for (const time of document.querySelectorAll('time[data-relative-time]')) time.textContent = ago(time.dateTime)
  }
  window.setInterval(refreshRelative, 10_000)
  window.waTime = { ago, full: fullDate, node: relativeNode, refresh: refreshRelative }

  document.addEventListener('DOMContentLoaded', () => {
    refreshRelative()
    sync()
    document
      .getElementById('uiLanguage')
      ?.addEventListener('change', (event) => {
        setLanguage(event.target.value)
        // Bagian yang dirender skrip (daftar nomor, pilihan model, tabel) ikut berganti bahasa: muat ulang.
        window.setTimeout(() => window.location.reload(), 150)
      })
  })
})()
