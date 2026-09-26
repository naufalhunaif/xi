// Kualitas: Aturan Toko, Koreksi balasan AI dari room, dan Kasus uji (dijalankan manual).
;(() => {
  const byId = (id) => document.getElementById(id)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
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
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrf,
        'X-WhatsApp-Workspace': workspace(),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
    if (response.status === 204) return {}
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || result.message || t('Permintaan gagal.'))
    return result
  }

  /* ---------- Aturan Toko ---------- */
  const rulesList = byId('rulesList')
  const rulesStatus = (text) => byId('rulesStatus') && (byId('rulesStatus').textContent = text || '')
  function renderRules(rules) {
    if (!rulesList) return
    rulesList.replaceChildren()
    if (!rules.length) rulesList.append(el('li', 'wa-empty', t('Belum ada aturan.')))
    for (const rule of rules) {
      const item = el('li', 'wa-quality-item')
      item.append(el('span', '', rule.text))
      const remove = el('button', 'button small', t('Hapus'))
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        try {
          renderRules((await call(`/api/beta3/rules/${rule.id}`, 'DELETE')).rules || [])
        } catch (error) {
          rulesStatus(error.message)
        }
      })
      item.append(remove)
      rulesList.append(item)
    }
  }
  async function loadRules() {
    if (!rulesList) return
    try {
      renderRules((await call('/api/beta3/rules')).rules || [])
    } catch (error) {
      rulesStatus(error.message)
    }
  }
  async function addRule() {
    const input = byId('ruleInput')
    const text = input?.value.trim()
    if (!text) return
    try {
      renderRules((await call('/api/beta3/rules', 'POST', { text })).rules || [])
      input.value = ''
      rulesStatus(t('Aturan disimpan.'))
    } catch (error) {
      rulesStatus(error.message)
    }
  }
  byId('ruleAdd')?.addEventListener('click', addRule)
  byId('ruleInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addRule()
    }
  })

  /* ---------- Kasus uji ---------- */
  const testsList = byId('testsList')
  let pollTimer = null
  function renderTests(tests) {
    if (!testsList) return
    testsList.replaceChildren()
    const done = tests.filter((test) => test.lastPass !== null)
    const passed = done.filter((test) => test.lastPass).length
    const busy = tests.some((test) => ['queued', 'running'].includes(test.status))
    const summary = byId('testsSummary')
    if (summary)
      summary.textContent = !tests.length
        ? t('Belum ada kasus uji. Tekan "Koreksi" pada balasan AI di chat untuk membuatnya.')
        : busy
          ? t('Sedang menguji… {0}/{1} selesai', tests.filter((x) => x.status === 'idle').length, tests.length)
          : done.length
            ? t('{0}/{1} lulus', passed, done.length)
            : t('{0} kasus, belum dijalankan', tests.length)
    const run = byId('testsRun')
    if (run) run.disabled = busy || !tests.length
    for (const test of tests) {
      const item = el('li', 'wa-quality-test')
      const head = el('div', 'wa-quality-test-head')
      const badge =
        test.status === 'running'
          ? el('span', 'wa-pill warn', t('Menguji…'))
          : test.status === 'queued'
            ? el('span', 'wa-pill warn', t('Antre'))
            : test.lastPass === null
              ? el('span', 'wa-pill', t('Belum diuji'))
              : el('span', `wa-pill ${test.lastPass ? 'ok' : 'err'}`, test.lastPass ? t('Lulus') : t('Gagal'))
      head.append(badge, el('strong', '', test.customerText.split('\n').pop().slice(0, 90)))
      const remove = el('button', 'button small', t('Hapus'))
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        await call(`/api/beta3/tests/${test.id}`, 'DELETE').catch(() => {})
        loadTests()
      })
      head.append(remove)
      item.append(head)
      const detail = el('details')
      detail.append(el('summary', '', t('Lihat detail')))
      const rows = [
        [t('Pelanggan'), test.customerText],
        [t('Jawaban salah dulu'), test.wrongText],
        [t('Jawaban benar'), test.expectedText],
        ...(test.lastAnswer || test.lastReason
          ? [
              [t('Jawaban AI terakhir'), test.lastAnswer || '—'],
              [t('Penilaian'), `${test.lastReason}${test.lastModel ? ` (${test.lastModel})` : ''}`],
            ]
          : []),
      ]
      for (const [label, value] of rows) {
        const row = el('div', 'wa-quality-row')
        row.append(el('small', '', label), el('p', '', value))
        detail.append(row)
      }
      item.append(detail)
      testsList.append(item)
    }
    clearTimeout(pollTimer)
    if (busy) pollTimer = setTimeout(loadTests, 4000)
  }
  async function loadTests() {
    if (!testsList) return
    try {
      renderTests((await call('/api/beta3/tests')).tests || [])
    } catch {}
  }
  byId('testsRun')?.addEventListener('click', async () => {
    try {
      const result = await call('/api/beta3/tests/run', 'POST', {})
      if (!result.started && result.reason) byId('testsSummary').textContent = result.reason
    } catch (error) {
      byId('testsSummary').textContent = error.message
    }
    loadTests()
  })

  // Muat saat panel Kualitas dibuka.
  const panel = byId('settings-quality')
  if (panel) {
    const refresh = () => {
      if (!panel.hidden) {
        loadRules()
        loadTests()
      }
    }
    new MutationObserver(refresh).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
    refresh()
  }

  /* ---------- Koreksi dari room ---------- */
  let dialog = null
  function openCorrection(messageId, aiText, trigger) {
    dialog?.remove()
    dialog = el('div', 'wa-correct-overlay')
    const box = el('div', 'wa-correct-box')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    const header = el('div', 'wa-card-head')
    header.append(el('strong', '', t('Koreksi balasan AI')))
    const x = el('button', 'shell-icon-button', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', t('Tutup'))
    header.append(x)
    box.append(header)
    const original = el('p', 'wa-correct-original', aiText)
    box.append(original)
    const answer = el('textarea')
    answer.rows = 4
    answer.setAttribute('aria-label', t('Jawaban yang benar'))
    answer.placeholder = t('Tulis jawaban yang seharusnya…')
    box.append(answer)
    const kinds = el('div', 'wa-correct-kinds')
    const option = (value, label, hint, checked) => {
      const wrap = el('label', 'wa-correct-kind')
      const radio = el('input')
      radio.type = 'radio'
      radio.name = 'correctKind'
      radio.value = value
      radio.checked = checked
      wrap.append(radio, el('span', '', label), el('small', '', hint))
      kinds.append(wrap)
      return radio
    }
    option('example', t('Contoh jawaban'), t('Untuk kasus serupa'), true)
    const ruleRadio = option('rule', t('Aturan toko'), t('Berlaku umum, semua chat'), false)
    box.append(kinds)
    const rule = el('input')
    rule.type = 'text'
    rule.maxLength = 300
    rule.placeholder = t('Aturan singkat, mis. "Kargo JTR minimal 8 kg"')
    rule.hidden = true
    box.append(rule)
    kinds.addEventListener('change', () => (rule.hidden = !ruleRadio.checked))
    const note = el('small', 'wa-note', t('Setiap koreksi juga disimpan sebagai kasus uji.'))
    const status = el('small', 'wa-correct-status')
    const actions = el('div', 'actions')
    const cancel = el('button', 'button', t('Batal'))
    cancel.type = 'button'
    const save = el('button', 'button primary', t('Simpan'))
    save.type = 'button'
    actions.append(cancel, save)
    box.append(note, status, actions)
    dialog.append(box)
    document.body.append(dialog)
    answer.focus()
    const close = () => {
      dialog?.remove()
      dialog = null
      trigger?.focus()
    }
    cancel.addEventListener('click', close)
    x.addEventListener('click', close)
    dialog.addEventListener('click', (event) => event.target === dialog && close())
    box.addEventListener('keydown', (event) => event.key === 'Escape' && close())
    save.addEventListener('click', async () => {
      const kind = ruleRadio.checked ? 'rule' : 'example'
      if (kind === 'example' && !answer.value.trim()) return (status.textContent = t('Tulis jawaban yang benar.'))
      if (kind === 'rule' && !rule.value.trim() && !answer.value.trim())
        return (status.textContent = t('Tulis aturannya.'))
      save.disabled = true
      try {
        await call('/api/beta3/corrections', 'POST', {
          messageId,
          correct: answer.value.trim(),
          kind,
          rule: rule.value.trim(),
        })
        status.textContent = t('Tersimpan. AI memakai koreksi ini mulai pesan berikutnya.')
        setTimeout(close, 1200)
      } catch (error) {
        status.textContent = error.message
        save.disabled = false
      }
    })
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-correct-id]')
    if (!button) return
    event.preventDefault()
    const article = button.closest('article')
    openCorrection(Number(button.dataset.correctId), article?.dataset.body || '', button)
  })
})()
