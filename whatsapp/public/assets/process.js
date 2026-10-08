;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const byId = (id) => document.getElementById(id)
  const jid = byId('messages')?.dataset.jid
  if (!jid) return
  const dialog = byId('aiTraceDialog')
  const progress = byId('aiProgress')
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const states = {
    running: t('Berjalan'),
    completed: t('Selesai'),
    failed: t('Gagal'),
    cancelled: t('Dibatalkan'),
    interrupted: t('Proses terputus'),
  }
  let latest = null
  let selectedId = null
  let polling = false
  let requestVersion = 0
  let lastSignature = ''
  let lastTrigger = null
  function visibleSteps(trace) {
    const steps = (trace.steps || []).filter((step) => step.label?.trim())
    return steps.filter((step) => {
      if (
        step.key === 'business-check' &&
        steps.some((item) => item.key === 'analysis' &&
          (['running', 'completed'].includes(step.status) || (step.status === 'failed' && item.status === 'failed' && !step.detail?.note)))
      )
        return false
      // An authentication failure belongs to its named MCP, not two wrapper rows.
      if (step.key === 'analysis' && step.status === 'failed' && step.detail?.stage === 'mcp_auth' &&
          steps.some(item => item.key.startsWith('analysis:mcp-auth:') && item.status === 'failed' &&
            item.detail?.source === step.detail.source && item.detail?.code === step.detail.code)) return false
      if (step.status !== 'completed') return true
      // Setup already has its own input/skills disclosure. Keep failures and real tool results.
      if (step.key === 'skills' || (step.key === 'media' && step.label === 'Input teks siap'))
        return false
      return true
    })
  }
  // A view of the stored trace, never a replacement for its evidence. Group by
  // phase/key rather than label: two identically named AI runs still cost twice.
  function processTree(steps) {
    const phaseSteps = steps.filter(step => step.detail?.usage ||
      /^(?:analysis|index-analysis|comparison|business-recheck-run|visual-recheck|cart-notes-repair)$/.test(step.key) ||
      steps.some(child => child.key === `${step.key}:model-selection`))
    const phases = phaseSteps.map((step, i) => ({ step, key: step.key, children: [],
      label: t(i ? 'Analisis lanjutan · {0}' : 'Analisis · {0}', i + 1), branch: true }))
    const prefixes = [...phases].sort((a, b) => b.key.length - a.key.length)
    const roots = [], placed = new Set()
    for (const step of steps) {
      const phase = phases.find(node => node.step === step)
      const parent = phase || prefixes.find(node => step.key.startsWith(`${node.key}:`))
      if (parent) {
        if (!placed.has(parent.key)) { roots.push(parent); placed.add(parent.key) }
        if (!phase) parent.children.push({ step, key: step.key })
      } else roots.push({ step, key: step.key })
    }
    const group = (key, label, children) => ({ key: `tree:${key}`, label: t(label), children, branch: true })
    const toolIdentity = step => {
      if (step.detail?.tool) return [String(step.detail.server || 'MCP').replace(/^business_/, ''), step.detail.tool].join(' · ')
      // Provider events store the name in label, while the bridge stores fields.
      if (step.detail && Object.hasOwn(step.detail, 'parameters') && /^[\w-]+ · [\w-]+$/.test(step.label))
        return step.label.replace(/^business_/, '')
      return null
    }
    for (const phase of phases) {
      const setup = [], work = [], families = new Map()
      for (const node of phase.children) {
        const step = node.step
        if (/:mcp-(auth|tools):/.test(step.key) || step.key.endsWith(':model-selection')) {
          if (/:mcp-auth:/.test(step.key)) node.label = `${t('Akses')} · ${step.detail?.source || step.key.split(':').at(-1)}`
          if (/:mcp-tools:/.test(step.key)) node.label = `${t('Skema')} · ${String(step.detail?.server || step.key.split(':').at(-1)).replace(/^business_/, '')}`
          setup.push(node)
          continue
        }
        const identity = toolIdentity(step)
        if (!identity) { work.push(node); continue }
        if (!families.has(identity)) {
          const family = group(`${phase.key}:tool:${identity}`, identity, [])
          family.label = identity
          families.set(identity, family)
          work.push(family)
        }
        families.get(identity).children.push(node)
      }
      for (const family of families.values()) {
        if (family.children.length === 1) {
          const index = work.indexOf(family)
          work[index] = { ...family.children[0], label: family.label }
          continue
        }
        const calls = family.children.filter(node => node.step.detail?.tool && node.step.detail.modelVisible !== false)
        const records = family.children.filter(node => !calls.includes(node))
        // Provider/bridge records are grouped, not guessed to be the same call.
        // Every key, argument, result and error remains individually inspectable.
        family.count = calls.length ? t('{0} panggilan', calls.length) : t('{0} catatan', records.length)
        family.children = calls.map((node, i) => ({ ...node, label: t('Panggilan {0}', i + 1) }))
        if (records.length) family.children.push(group(`${family.key}:records`, 'Catatan penghubung',
          records.map((node, i) => ({ ...node, label: t('Catatan {0}', i + 1) }))))
      }
      phase.children = [...(setup.length ? [group(`${phase.key}:setup`, 'Persiapan layanan', setup)] : []), ...work]
    }
    const result = []
    let pending = [], seenPhase = false
    const flush = () => {
      result.push(...(pending.length > 2 ? [group(`local:${pending[0].key}`,
        !phases.length ? 'Proses lokal' : seenPhase ? 'Langkah lanjutan' : 'Persiapan', pending)] : pending))
      pending = []
    }
    for (const node of roots) {
      if (node.branch) { flush(); result.push(node); seenPhase = true }
      else pending.push(node)
    }
    flush()
    return result
  }
  function updateProgressVisibility() {
    progress.hidden =
      dialog.open || !latest || latest.status === 'completed' || latest.status === 'cancelled'
    const goal = byId('roomGoalStatus')
    if (goal) goal.hidden = latest?.status === 'running'
  }
  // Where a step's data came from. The icon only marks it; the label and detail still explain.
  const ORIGINS = {
    live: {
      label: 'Data langsung',
      hint: 'Diambil langsung dari layanan saat giliran ini.',
      path: 'M7 18h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1.3A4 4 0 0 0 7 18Z',
    },
    cache: {
      label: 'Dari cache',
      hint: 'Hasil tersimpan yang masih berlaku; tidak memanggil layanan lagi.',
      path: 'M3.5 5.5h17v10h-17zM9 19h6M12 15.5V19',
    },
    system: {
      label: 'Dari sistem',
      hint: 'Dihitung aplikasi dari data lokal, bukan panggilan AI atau MCP.',
      path: 'M5 7.5h14v9H5zM8 16.5v3M12 16.5v3M16 16.5v3M8.5 10.5h7v3h-7z',
    },
  }
  const num = (value) =>
    new Intl.NumberFormat(window.waI18n?.locale || 'id-ID').format(Math.round(value))
  function estimatedCount(detail) {
    const count = detail?.estimatedTokens ?? detail?.tokens
    if (Number.isFinite(count) && count >= 0) return count
    return Number.isFinite(detail?.chars) && detail.chars >= 0
      ? Math.round(detail.chars / 3.7) : null
  }
  /** Provider counts when reported, our own character estimate otherwise. */
  function stepTokens(step) {
    const usage = step.detail?.usage
    if (usage && Number.isFinite(usage.input)) {
      const total = (usage.input || 0) + (usage.output || 0)
      const cached = usage.cached || 0
      return {
        text: t('{0} token', num(total)),
        title: t(
          'Input {0} · output {1} · cache dibaca {2} · cache ditulis {3}. Angka dari layanan AI.',
          num(usage.input || 0),
          num(usage.output || 0),
          num(cached),
          num(usage.cacheWrite || 0)
        ),
        exact: true,
      }
    }
    const estimated = estimatedCount(step.detail)
    if (Number.isFinite(estimated) && estimated > 0)
      return {
        text: t('≈{0} token', num(estimated)),
        title: t('Perkiraan lokal dari jumlah karakter, bukan hitungan layanan AI.'),
        exact: false,
      }
    return null
  }
  function promptSizeBlock(step, parent) {
    const detail = step.detail || {}
    const sections = Array.isArray(detail.sections) ? detail.sections : []
    if (!sections.length) return false
    // Older stored traces redacted token metrics as strings. Reconstruct estimates
    // from their original character counts, never display NaN or a false zero.
    const estimate = (row) => estimatedCount(row) === null ? '—' : num(estimatedCount(row))
    const block = document.createElement('details')
    block.dataset.key = step.key
    block.append(element('summary', ''))
    const summary = block.querySelector('summary')
    summary.className = 'wa-trace-step-title'
    summary.append(originMark('system'))
    summary.append(element('span', t(step.label), 'wa-trace-step-label'))
    summary.append(
      element('span', t('≈{0} token', estimate(detail)), 'wa-trace-step-meta')
    )
    const table = element('table', '', 'wa-trace-sizes')
    const total = Number.isFinite(detail.chars) && detail.chars > 0
      ? detail.chars : sections.reduce((sum, row) => sum + (row.chars || 0), 0) || 1
    for (const row of sections) {
      const line = document.createElement('tr')
      const share = Math.round(((row.chars || 0) / total) * 100)
      for (const [value, className] of [
        [row.key, ''],
        [t('≈{0} token', estimate(row)), 'wa-trace-size-amount'],
        [`${share}%`, 'wa-trace-size-share'],
      ]) {
        const cell = element('td', value, className)
        line.append(cell)
      }
      table.append(line)
    }
    block.append(table)
    if (detail.note) block.append(element('small', t(detail.note), 'wa-trace-muted'))
    parent.append(block)
    return true
  }
  /** Tool results stay in context for every later step, so their total is the multiplier
   * that turns a ~35k prompt into a several-hundred-thousand-token call. */
  function toolAccounting(steps) {
    let calls = 0
    let resultTokens = 0
    let schemaTokens = 0
    for (const step of steps) {
      const detail = step.detail || {}
      if (detail.tool && detail.modelVisible !== false) {
        calls++
        resultTokens += estimatedCount(detail) || 0
      } else if (Number.isFinite(detail.tools)) {
        schemaTokens += estimatedCount(detail) || 0
      }
    }
    return { calls, resultTokens, schemaTokens }
  }
  function toolAccountingLine(steps) {
    const { calls, resultTokens, schemaTokens } = toolAccounting(steps)
    if (!calls && !schemaTokens) return null
    const line = element('p', '', 'wa-trace-tools wa-trace-muted')
    line.append(originMark('live'))
    line.append(
      element(
        'span',
        t(
          '{0} panggilan tool · hasil ≈{1} token · skema ≈{2} token',
          num(calls),
          num(resultTokens),
          num(schemaTokens)
        )
      )
    )
    line.title = t(
      'Hasil tool dan skema ikut dikirim ulang pada setiap langkah berikutnya dalam panggilan yang sama, sehingga biayanya berlipat.'
    )
    return line
  }
  function stepOrigin(step) {
    const detail = step.detail || {}
    if (detail.cache?.source === 'cache' || detail.source === 'cache') return 'cache'
    if (
      detail.cache?.source === 'mcp' ||
      detail.source === 'analysis' ||
      detail.stage === 'provider' ||
      detail.stage === 'mcp_auth' ||
      detail.provider
    )
      return 'live'
    return 'system'
  }
  function originMark(origin) {
    const meta = ORIGINS[origin]
    const mark = document.createElement('span')
    mark.className = 'wa-trace-origin'
    mark.dataset.origin = origin
    mark.title = `${t(meta.label)} · ${t(meta.hint)}`
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', t(meta.label))
    mark.innerHTML =
      `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${meta.path}"/></svg>`
    return mark
  }
  function originLegend() {
    const legend = element('p', '', 'wa-trace-legend wa-trace-muted')
    for (const origin of Object.keys(ORIGINS)) {
      const entry = element('span', '', 'wa-trace-legend-item')
      entry.append(originMark(origin), element('span', t(ORIGINS[origin].label)))
      entry.title = t(ORIGINS[origin].hint)
      legend.append(entry)
    }
    return legend
  }
  // v3.6.70: langkah teknis (ukuran prompt, hemat token, tingkat model, persiapan layanan) hanya di Detail teknis.
  const TECHNICAL_STEP = /^(?:prompt-size|beta3-trim|beta3-tier|beta3-skill|beta3-image-color|beta3-tidy-text|beta3-quick|reply-timing|queue-timing|trace-finished|skills|media|business-check)$|:mcp-|:model-selection$|^compact-/
  // Nama langkah dalam bahasa biasa; label asli tetap tampil kecil di bawahnya sebagai rinciannya.
  const FRIENDLY_STEP = [
    [/^beta3-ai$|^analysis$/, 'Menyusun balasan'],
    [/^send-|^ig-send-/, 'Balasan terkirim'],
    [/^beta3-rates$/, 'Menghitung ongkir'],
    [/^beta3-(?:order|order-sync)$/, 'Memperbarui order'],
    [/^beta3-(?:total|wholesale)$/, 'Memeriksa total'],
    [/^beta3-(?:fit|sizechart)$/, 'Menyarankan ukuran'],
    [/^beta3-awb$/, 'Melacak paket'],
    [/^beta3-hati$/, 'Membaca maksud & perasaan pelanggan'],
    [/^beta3-(?:refs|photo-complete|photo-repeat)$/, 'Menyiapkan foto'],
    [/^beta3-(?:paid-claim|paid-check)$/, 'Memeriksa pembayaran'],
    [/^beta3-cancel$/, 'Membatalkan order'],
    [/^beta3-(?:guard|cod|color|custom|price-context|nudge-plan|handoff-reply|hati-[a-z]+)$/, 'Memeriksa balasan dengan aturan toko'],
  ]
  const STEP_ICONS = {
    ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    live: 'M3 12h4l2-5 4 10 2-5h6',
    cache: 'M4 7h16M4 12h16M4 17h16',
    system: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9',
  }
  function stepIcon(name, label) {
    const mark = document.createElement('span')
    mark.className = 'wa-why-icon'
    mark.title = label
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', label)
    mark.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${STEP_ICONS[name] || STEP_ICONS.system}"/></svg>`
    return mark
  }
  function element(tag, text, className) {
    const node = document.createElement(tag)
    node.textContent = text
    if (className) node.className = className
    return node
  }
  function currentActivity(trace) {
    const steps = visibleSteps(trace)
    if (trace.status === 'failed') {
      const failure = steps.filter((step) => step.status === 'failed').at(-1)
      if (failure?.detail?.code === 'USAGE_LIMIT') {
        const name = failure.detail.source || (({ claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' })[failure.detail.provider] || 'AI')
        return { label: t('Limit penggunaan {0} tercapai.', name), active: false, state: 'failed' }
      }
      const label = failure?.detail?.message
        ? `${failure.detail.source || failure.detail.provider || 'AI'} · ${t(failure.detail.message)}`
        : failure?.label || t('Proses AI belum selesai')
      return { label, active: false, state: 'failed' }
    }
    const step =
      ['running', 'interrupted'].includes(trace.status)
        ? steps.filter((item) => item.status === 'running').at(-1) || steps.at(-1)
        : steps.at(-1)
    const active = trace.status === 'running' && (!step || step.status === 'running')
    const labels = { analysis: 'Thinking…', media: 'Understanding media…', send: 'Typing…' }
    const label = active
      ? labels[step?.key] ||
        (step?.key?.startsWith('compact-') ? 'Compacting context…' : step?.label) ||
        'Thinking…'
      : step?.label || trace.label || t('Proses AI')
    return {
      label,
      active,
      state: trace.status === 'running' ? step?.status || 'running' : trace.status,
    }
  }
  async function getTrace(id) {
    const response = await fetch(
      `${base}/api/ai/trace?jid=${encodeURIComponent(jid)}${id ? `&id=${encodeURIComponent(id)}` : ''}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' }
    )
    if (!response.ok || response.redirected)
      throw new Error(t('Detail proses belum dapat dimuat. Coba buka kembali.'))
    return (await response.json()).trace
  }
  function render(trace) {
    const signature = JSON.stringify(trace)
    if (lastSignature === signature) return
    lastSignature = signature
    const content = byId('aiTraceContent')
    const previousOpen = new Map([...content.querySelectorAll('details[data-key]')]
      .map(node => [node.dataset.key, node.open]))
    const expanded = new Set([...previousOpen].filter(([, open]) => open).map(([key]) => key))
    const focusedKey = document.activeElement?.matches('summary')
      ? document.activeElement.parentElement.dataset.key : null
    const scrollTop = content.scrollTop
    content.replaceChildren()
    if (!trace) {
      byId('aiTraceStatus').textContent = ''
      content.append(element('p', t('Belum ada detail proses tercatat.')))
      return
    }
    // v3.6.70: tampilan ringkas "Kenapa AI membalas begini" — ringkasan, pesan pelanggan, langkah
    // dalam bahasa biasa, langkah berikutnya. Semua bukti teknis (token, model, prompt, pohon proses)
    // tetap utuh di "Detail teknis" yang tertutup.
    const statusLabel = byId('aiTraceStatus')
    statusLabel.textContent = states[trace.status] || trace.status
    statusLabel.className = `wa-st ${{ completed: 'ok', running: 'ink', failed: 'bad', interrupted: 'warn', cancelled: '' }[trace.status] ?? ''}`
    const activityNow = currentActivity(trace)
    if (trace.status === 'running') {
      const live = element('p', '', 'wa-why-live')
      if (window.waLoader) live.append(window.waLoader.make('core', 28))
      live.append(element('span', activityNow.label))
      content.append(live)
    }
    const summaryText = trace.decision?.summary || trace.decision?.reason || trace.decision?.error
    if (summaryText) content.append(element('p', summaryText, 'wa-why-summary'))
    const whenParts = []
    const startedAt = trace.createdAt ? new Date(trace.createdAt) : null
    if (startedAt && !Number.isNaN(startedAt.getTime()))
      whenParts.push(startedAt.toLocaleTimeString('en-US', { timeZone: 'Asia/Jakarta', hour: 'numeric', minute: '2-digit' }))
    const aiStep = (trace.steps || []).find((step) => step.key === 'beta3-ai' || step.detail?.usage)
    if (Number.isFinite(aiStep?.durationMs)) whenParts.push(t('{0} dtk', Math.max(1, Math.round(aiStep.durationMs / 1000))))
    if (trace.decision?.decision)
      whenParts.push(trace.decision.decision === 'silent' ? t('Tidak membalas (sesuai skill)')
        : trace.decision.decision === 'handoff' || trace.decision.decision === 'cs' ? t('Serahkan ke CS') : t('Balas pelanggan'))
    if (whenParts.length) content.append(element('p', whenParts.join(' · '), 'wa-why-meta'))

    const section = (title) => {
      const block = element('section', '', 'wa-why-section')
      block.append(element('h3', title, 'wa-why-eyebrow'))
      content.append(block)
      return block
    }
    const said = section(t('Pesan pelanggan'))
    said.append(element('p', trace.input.text || t('(tanpa teks)'), 'wa-why-quote'))
    if (trace.media?.length) {
      const images = element('div', '', 'wa-trace-media')
      for (const media of trace.media) {
        const url =
          media.thumbnail_url ||
          (['image', 'sticker'].includes(media.media_type) ? media.media_url : null)
        if (!url) continue
        const parsed = new URL(url, window.location.href)
        if (parsed.origin !== window.location.origin || !parsed.pathname.includes('/media/'))
          continue
        const image = document.createElement('img')
        image.src = parsed.href
        image.alt = media.media_type || t('Media pelanggan')
        if (media.media_url) {
          const full = new URL(media.media_url, window.location.href)
          if (full.origin === window.location.origin && full.pathname.includes('/media/')) {
            image.dataset.fullMediaUrl = full.href
            image.dataset.fullMediaType = media.media_type
          }
        }
        image.loading = 'lazy'
        images.append(image)
      }
      said.append(images)
    }

    const stepsBlock = section(t('Langkah'))
    const list = element('ol', '', 'wa-why-steps')
    stepsBlock.append(list)
    const allSteps = visibleSteps(trace)
    const shown = allSteps.filter((step) => !TECHNICAL_STEP.test(step.key))
    for (const step of shown) {
      const running = trace.status === 'running' && step.status === 'running'
      const item = element('li', '', `wa-why-step is-${running ? 'running' : step.status}`)
      const text = element('span', '', 'wa-why-step-text')
      const plain = FRIENDLY_STEP.find(([pattern]) => pattern.test(step.key))?.[1]
      const original = t(step.label).replace(/\s*·\s*(?:cache|live|langsung)\s*$/i, '')
      text.append(element('span', plain ? t(plain) : original, 'wa-why-step-label'))
      if (plain && original && original !== t(plain)) text.append(element('small', original, 'wa-why-step-note'))
      item.append(text)
      const mark = element('span', '', 'wa-why-step-mark')
      if (running && window.waLoader) mark.append(window.waLoader.make('core', 20))
      else if (step.status === 'failed') mark.append(element('span', t('Gagal'), 'wa-st bad'))
      else if (step.key === 'beta3-ai' || step.detail?.usage) mark.append(stepIcon('ai', t('AI')))
      else {
        const origin = stepOrigin(step)
        mark.append(stepIcon(origin, t(ORIGINS[origin].label)))
      }
      item.append(mark)
      list.append(item)
    }
    if (!shown.length) list.append(element('li', activityNow.label, 'wa-why-step'))
    const goal = trace.decision?.goal
    const next = goal?.next_action || goal?.waiting_for
    if (next) section(t('Langkah berikutnya')).append(element('p', next))

    const tech = document.createElement('details')
    tech.dataset.key = 'technical'
    tech.open = expanded.has('technical')
    tech.className = 'wa-why-tech'
    const techSummary = element('summary', t('Detail teknis'))
    const usageTotal = allSteps.reduce((sum, step) => {
      const usage = step.detail?.usage
      return usage && Number.isFinite(usage.input) ? sum + (usage.input || 0) + (usage.output || 0) : sum
    }, 0)
    const techMeta = [trace.input.provider || '', trace.input.model || '', usageTotal ? t('{0} token', num(usageTotal)) : '']
      .filter(Boolean).join(' · ')
    if (techMeta) techSummary.append(element('span', techMeta, 'wa-why-tech-meta'))
    tech.append(techSummary)
    const area = element('div', '', 'wa-why-tech-body')
    tech.append(area)
    content.append(tech)
    function disclosure(key, title, value, parent = area) {
      const block = document.createElement('details')
      block.dataset.key = key
      block.open = expanded.has(key)
      block.append(element('summary', title))
      const plainNote =
        value && typeof value === 'object' && Object.keys(value).length === 1 && value.note
      block.append(
        element(
          plainNote || typeof value === 'string' ? 'p' : 'pre',
          plainNote || (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
          'wa-trace-detail'
        )
      )
      parent.append(block)
      return block
    }
    disclosure('skills', t('Skill yang dimuat'), trace.input.skills?.join('\n') || t('Tidak ada skill.'))
    area.append(element('h3', t('Aktivitas')))
    area.append(originLegend())
    const activity = currentActivity(trace)
    const steps = visibleSteps(trace)
    const tree = processTree(steps)
    const phaseCount = tree.filter(node => node.step && node.branch).length
    const toolLine = toolAccountingLine(steps)
    if (toolLine) area.append(toolLine)
    const group = element('section', '', 'wa-trace-activity')
    group.dataset.key = 'activity-timeline'
    const summary = element('div', '', `wa-trace-current is-${activity.state}`)
    summary.append(
      element(
        'span',
        activity.label,
        `wa-trace-current-label${activity.active ? ' wa-text-glow' : ''}`
      )
    )
    // One customer message can trigger several full AI runs; show what the whole turn cost.
    const spent = steps.reduce(
      (sum, step) => {
        const usage = step.detail?.usage
        if (!usage || !Number.isFinite(usage.input)) return sum
        return {
          total: sum.total + (usage.input || 0) + (usage.output || 0),
          cached: sum.cached + (usage.cached || 0),
          written: sum.written + (usage.cacheWrite || 0),
          runs: sum.runs + 1,
        }
      },
      { total: 0, cached: 0, written: 0, runs: 0 }
    )
    const expandedLabel = element(
      'span',
      spent.runs
        ? t('Alur proses · {0} panggilan AI · {1} token', phaseCount, num(spent.total))
        : t('Alur proses'),
      'wa-trace-expanded-label'
    )
    if (spent.runs)
      expandedLabel.title = t(
        '{0} panggilan AI pada giliran ini · {1} token dibaca dari cache · {2} ditulis.',
        num(spent.runs),
        num(spent.cached),
        num(spent.written)
      )
    summary.append(expandedLabel)
    summary.append(
      element('span', states[activity.state] || activity.state, 'wa-trace-current-state')
    )
    group.append(summary)
    const timeline = element('ul', '', 'wa-trace-timeline')
    group.append(timeline)
    area.append(group)
    if (trace.status === 'failed') {
      const failure = trace.decision?.failure || steps.filter(step => step.status === 'failed').at(-1)?.detail
      if (failure?.code && failure?.action) {
        area.append(element('p', `${failure.source || failure.provider || 'AI'} · ${failure.code}\n${t(failure.action)}`, 'wa-trace-detail'))
      }
    }
    if (trace.status === 'interrupted') {
      const diagnostic = trace.interruption || {}
      area.append(element('p',
        `${diagnostic.code || 'TRACE_UPDATES_STALE'} · ${t(diagnostic.message || 'Tidak ada pembaruan aktivitas selama lebih dari 4 menit. Penyebab proses belum terkonfirmasi.')}\n${t(diagnostic.action || 'Periksa log dan status worker pada waktu tersebut, termasuk restart/deploy atau kehabisan memori. Jangan menjalankan ulang sebelum memastikan proses sebelumnya sudah berhenti.')}`,
        'wa-trace-diagnostic'))
    }
    const effectiveState = step => step.status === 'running' && trace.status !== 'running'
      ? (trace.status === 'cancelled' ? 'cancelled' : 'interrupted') : step.status
    const nodeState = node => {
      const statuses = [...(node.step ? [effectiveState(node.step)] : []), ...(node.children || []).map(nodeState)]
      return ['running', 'failed', 'interrupted', 'cancelled'].find(status => statuses.includes(status)) || 'completed'
    }
    const appendMeta = (title, step, state) => {
      const measuredMs = ['reply-timing', 'queue-timing'].includes(step.key) && Number.isFinite(step.detail?.elapsedMs)
        ? Math.max(0, step.detail.elapsedMs) : step.durationMs
      const seconds = measuredMs === undefined ? ''
        : t(' · {0} dtk', measuredMs < 100 ? '<0,1' : (measuredMs / 1000).toLocaleString(window.waI18n?.locale || 'id-ID', { maximumFractionDigits: 1 }))
      const tokens = stepTokens(step)
      const meta = element('span', `${states[state] || state}${seconds}${tokens ? ` · ${tokens.text}` : ''}`, 'wa-trace-step-meta')
      if (tokens) { meta.title = tokens.title; meta.dataset.tokens = tokens.exact ? 'exact' : 'estimated' }
      title.append(meta)
    }
    const drawNode = (node, parent) => {
      const step = node.step
      const state = nodeState(node)
      const active = trace.status === 'running' && state === 'running'
      const item = element('li', '', `wa-trace-step is-${state}${node.branch ? ' wa-trace-branch' : ''}${active ? ' is-active' : ''}`)
      if (step) item.dataset.stepKey = step.key
      parent.append(item)
      if (!node.branch && step.detail?.sections && promptSizeBlock(step, item)) {
        item.querySelector('details').open = expanded.has(step.key)
        return
      }
      const hasDetail = step?.detail && (typeof step.detail !== 'object' || Object.keys(step.detail).length > 0)
      let title, block
      if (node.branch) {
        block = element('section', '', 'wa-trace-branch-content')
        block.dataset.key = node.key
        title = element('div', '', 'wa-trace-step-title')
        block.append(title)
        item.append(block)
      } else if (hasDetail) title = disclosure(step.key, '', step.detail, item).querySelector('summary')
      else { title = element('div', '', 'wa-trace-step-title'); item.append(title) }
      if (step) title.title = t(step.label)
      const stepLabel = node.label || (step.detail?.tool
        ? `${String(step.detail.server || '').replace(/^business_/, '')} · ${step.detail.tool}`
        : t(step.label).replace(/\s*·\s*(?:cache|live|langsung)\s*$/i, ''))
      if (step) title.append(originMark(stepOrigin(step)))
      title.append(element('span', stepLabel, `wa-trace-step-label${active ? ' wa-text-glow' : ''}`))
      if (step) appendMeta(title, step, state)
      else title.append(element('span', `${node.count || t('{0} langkah', node.children.length)} · ${states[state] || state}`, 'wa-trace-step-meta'))
      if (node.branch) {
        const children = element('ul', '', 'wa-trace-timeline wa-trace-children')
        block.append(children)
        drawList(node.children, children)
        if (hasDetail) disclosure(`evidence:${step.key}`, t('Detail fase'), { phase: step.key, label: step.label, ...step.detail }, block)
      }
    }
    function drawList(nodes, parent) {
      // Animate the connecting route only as far as the last active descendant.
      // A completed node on that route stays completed; its own branch is static.
      const lastActive = trace.status === 'running'
        ? nodes.findLastIndex(node => nodeState(node) === 'running') : -1
      parent.classList.toggle('has-active-route', lastActive >= 0)
      for (const [index, node] of nodes.entries()) {
        drawNode(node, parent)
        if (index < lastActive) parent.lastElementChild.classList.add('has-active-route')
      }
    }
    drawList(tree, timeline)
    if (trace.decision?.goal) disclosure('goal', t('Tujuan & tindak lanjut'), trace.decision.goal)
    if (focusedKey) {
      const target = [...content.querySelectorAll('details[data-key]')].find(node => node.dataset.key === focusedKey)
      target?.querySelector(':scope > summary')?.focus({ preventScroll: true })
    }
    content.scrollTop = scrollTop

  }
  async function openTrace(id, trigger) {
    selectedId = id
    lastTrigger = trigger
    lastSignature = ''
    const version = ++requestVersion
    byId('aiTraceStatus').textContent = t('Memuat…')
    byId('aiTraceContent').replaceChildren()
    if (!dialog.open) {
      if (window.waMotion) window.waMotion.showDialog(dialog)
      else dialog.showModal()
    }
    updateProgressVisibility()
    byId('aiTraceClose').focus()
    try {
      const trace = await getTrace(id)
      if (dialog.open && version === requestVersion) {
        selectedId = trace?.id || id
        render(trace)
      }
    } catch (error) {
      if (version === requestVersion) byId('aiTraceStatus').textContent = error.message
    }
  }
  progress.addEventListener('click', () => openTrace(latest?.id, progress))
  byId('messages').addEventListener('click', (event) => {
    const button = event.target.closest('[data-trace-id]')
    if (button) openTrace(button.dataset.traceId, button)
  })
  function closeTrace() {
    if (window.waMotion) window.waMotion.closeDialog(dialog)
    else dialog.close()
  }
  byId('aiTraceClose').addEventListener('click', closeTrace)
  dialog.addEventListener('cancel', (event) => {
    if (!window.waMotion) return
    event.preventDefault()
    closeTrace()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeTrace()
  })
  dialog.addEventListener('close', () => {
    ++requestVersion
    selectedId = null
    updateProgressVisibility()
    if (lastTrigger?.isConnected) lastTrigger.focus()
  })
  async function refresh() {
    if (polling || document.hidden) return
    polling = true
    try {
      latest = await getTrace()
      updateProgressVisibility()
      if (latest) {
        const elapsed = Math.max(
          0,
          Math.round((Date.now() - new Date(latest.createdAt).getTime()) / 1000)
        )
        const activity = currentActivity(latest)
        byId('aiProgressLabel').classList.toggle('wa-text-glow', activity.active)
        byId('aiProgressLabel').textContent =
          latest.status === 'running'
            ? t("{0} · {1} dtk", activity.label, elapsed)
            : `${activity.label} · ${states[latest.status] || latest.status}`
      }
      if (dialog.open && selectedId === latest?.id) render(latest)
      else if (dialog.open && selectedId) {
        const version = requestVersion
        const trace = await getTrace(selectedId)
        if (dialog.open && version === requestVersion) render(trace)
      }
    } catch {
      byId('aiProgressLabel').classList.remove('wa-text-glow')
      if (!progress.hidden)
        byId('aiProgressLabel').textContent = t('Pembaruan progres terputus. Mencoba kembali…')
    } finally {
      polling = false
    }
  }
  refresh()
  window.setInterval(refresh, 2000)
})()
