;(() => {
  const root = document.getElementById('conversationLearning')
  if (!root) return
  const toggle = document.getElementById('learningToggle')
  const status = document.getElementById('learningStatus')
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const t = (key, ...args) => window.waI18n?.t(key, ...args) ?? key.replace(/\{(\d+)\}/g, (m, i) => args[i] ?? m)
  const labels = { photo_initiative: 'Inisiatif setelah foto', repeated_question: 'Pertanyaan berulang', readable_options: 'Format pilihan', premature_goal: 'Goal ditutup terlalu cepat', protected_business: 'Kebijakan bisnis — tinjauan manusia' }
  const states = { testing: 'Sedang diuji', applied: 'Diterapkan', rejected: 'Tidak diterapkan', failed: 'Pengujian gagal', rolled_back: 'Dikembalikan' }
  let snapshot, busy = false, fingerprint = '', errorMessage = ''
  const el = (tag, text = '', cls = '') => { const node = document.createElement(tag); node.textContent = text; node.className = cls; return node }
  function locks() {
    toggle.disabled = busy || !snapshot || (snapshot.blocked && !snapshot.enabled) || (!snapshot.ready && !snapshot.enabled)
    root.querySelectorAll('[data-rollback]').forEach(button => { button.disabled = busy || snapshot?.blocked })
    root.setAttribute('aria-busy', String(busy))
  }
  function render(data) {
    snapshot = data
    toggle.setAttribute('aria-checked', String(data.enabled))
    status.dataset.error = String(Boolean(errorMessage || data.blocked))
    status.textContent = errorMessage || t(data.blocked ? 'Skill pembelajaran berubah manual. Otomatis ditahan.' : !data.ready ? 'Aktifkan AI dan import skill eval/evaluation.' : data.enabled ? 'Mengamati pola percakapan' : 'Pembelajaran baru dijeda')
    const key = JSON.stringify([data.patterns, data.versions, window.waI18n?.locale])
    if (key !== fingerprint) {
      fingerprint = key
      const patterns = document.getElementById('learningPatterns')
      patterns.replaceChildren()
      if (!data.patterns.length) patterns.append(el('p', t('Belum ada pola berulang.'), 'wa-usage-caption'))
      for (const pattern of data.patterns) {
        const row = el('div', '', 'wa-learning-item')
        row.append(el('strong', t(labels[pattern.kind] || pattern.label)), el('p', t('{0} pelanggan', pattern.customers) + ' · ' + t(pattern.kind === 'protected_business' ? 'Tinjauan manusia' : pattern.eligible ? 'Bukti cukup untuk diuji' : 'Mengumpulkan bukti')))
        patterns.append(row)
      }
      const versions = document.getElementById('learningVersions')
      const open = new Set([...versions.querySelectorAll('details[open]')].map(node => node.dataset.version))
      versions.replaceChildren()
      if (!data.versions.length) versions.append(el('p', t('Belum ada versi pembelajaran.'), 'wa-usage-caption'))
      for (const version of data.versions) {
        const row = el('div', '', 'wa-learning-item')
        const heading = el('div', '', 'wa-learning-heading')
        heading.append(el('strong', `v${version.id} · ${t(labels[version.kind] || version.label)}`), el('small', t(states[version.status] || version.status)))
        const time = el('time'); time.dateTime = version.updatedAt; time.dataset.relativeTime = ''; heading.append(time)
        if (version.canRollback) {
          const button = el('button', t('Rollback'), 'button'); button.type = 'button'; button.dataset.rollback = version.id
          button.addEventListener('click', () => {
            if (!busy && window.confirm(t('Kembalikan versi sebelumnya dan jeda pembelajaran otomatis?'))) void mutate(`/${version.id}/rollback`, 'POST', {})
          }); heading.append(button)
        }
        row.append(heading)
        const details = el('details'); details.dataset.version = String(version.id); details.open = open.has(String(version.id))
        details.append(el('summary', t('Detail pengujian')), el('pre', version.proposal))
        if (version.tests) {
          const before = version.tests.before || [], after = version.tests.after || []
          details.append(el('p', t('Lolos: baseline {0}/{1} → kandidat {2}/{1}', before.filter(test => test.passed).length, after.length, after.filter(test => test.passed).length)))
          const list = el('ul', '', 'wa-learning-tests')
          for (const test of after) list.append(el('li', `${test.id} · ${t(test.passed ? 'Lolos' : 'Gagal')}`))
          details.append(list)
        }
        if (version.error) details.append(el('p', t(version.error)))
        row.append(details); versions.append(row)
      }
      document.dispatchEvent(new Event('skills:updated'))
    }
    locks()
  }
  async function request(path = '', method = 'GET', body) {
    const response = await fetch(`${base}/api/ai/learning${path}`, { method, cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await response.json()
    if (!response.ok || response.redirected) throw new Error(t(data.error || 'Pembelajaran belum dapat dimuat.'))
    if (!data.revision || !Array.isArray(data.patterns) || !Array.isArray(data.versions)) throw new Error(t('Pembelajaran belum dapat dimuat.'))
    return data
  }
  async function load() {
    if (busy || document.hidden || location.hash !== '#evaluation') return
    busy = true; locks()
    try { const data = await request(); errorMessage = ''; render(data) }
    catch (error) { status.textContent = error.message; status.dataset.error = 'true' }
    finally { busy = false; locks() }
  }
  async function mutate(path, method, values) {
    if (busy || !snapshot) return
    busy = true; locks()
    try { const data = await request(path, method, { ...values, revision: snapshot.revision }); errorMessage = ''; render(data) }
    catch (error) { errorMessage = error.message; status.textContent = errorMessage; status.dataset.error = 'true'; snapshot = null }
    finally { busy = false; locks() }
  }
  toggle.addEventListener('click', event => {
    event.stopPropagation() // This switch is not a general-settings form field.
    if (snapshot) void mutate('', 'PUT', { enabled: !snapshot.enabled })
  })
  document.getElementById('evaluationRefresh')?.addEventListener('click', load)
  window.addEventListener('hashchange', load)
  document.addEventListener('visibilitychange', load)
  document.addEventListener('ui-language:change', () => { fingerprint = ''; if (snapshot) render(snapshot) })
  setInterval(load, 30_000)
  void load()
})()
