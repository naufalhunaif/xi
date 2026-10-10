;(() => {
  // v3.6.121 — Orkestra AI ala n8n: alur kerja balasan sebagai simpul & garis.
  // Pesan masuk → Jev → akun AI (urutan cadangan) → Pemeriksa → Kirim → Order / Bayar / CS.
  // Panel sempit: atas → bawah; mode Perbesar: kiri → kanan. Posisi tetap (tanpa simulasi fisika), hanya
  // status yang berubah; garis yang sedang dilalui bergerak lewat CSS → ringan.
  const root = document.getElementById('aiOrchestra')
  if (!root) return
  const svg = document.getElementById('aiOrchestraGraph')
  const stage = svg.parentElement
  const tip = document.getElementById('aiOrchestraTip')
  const logList = document.getElementById('aiOrchestraLog')
  const nowText = document.getElementById('aiOrchestraNow')
  const expandButton = document.getElementById('aiOrchestraExpand')
  const NS = 'http://www.w3.org/2000/svg'
  const shown = () => root.getClientRects().length > 0
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const make = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    if (parent) parent.append(node)
    return node
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  const ago = (ms) => (ms ? window.waTime?.ago(ms) || clock(ms) : t('belum pernah'))
  const phaseLabel = (phase) =>
    /recap/.test(phase)
      ? t('rekap order')
      : /catalog|vision|ciri/.test(phase)
        ? t('baca katalog')
        : /check|cek/.test(phase)
          ? t('pemeriksaan balasan')
          : /image|gambar/.test(phase)
            ? t('baca gambar')
            : /probe/.test(phase)
              ? t('cek akun')
              : /judge|sim/.test(phase)
                ? t('uji simulasi')
                : t('balasan chat')

  // Ikon garis sederhana (24×24), digambar dengan stroke.
  const ICON = {
    trigger: 'M4 5h16v11H10l-6 4z',
    jev: 'M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z',
    ai: 'M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9zM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z',
    check: 'M12 3l7 3v5.5c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V6zM8.5 12l2.4 2.4L15.5 10',
    send: 'M3 11.5L21 4l-7.5 17-2.2-7.3z',
    order: 'M6 8h12l-1 12H7zM9 8V7a3 3 0 0 1 6 0v1',
    pay: 'M3 6.5h18v11H3zM3 10.5h18M7 14.5h3',
    cs: 'M4.5 14v-2a7.5 7.5 0 0 1 15 0v2M4.5 13.5h3v5h-3zM16.5 13.5h3v5h-3z',
  }
  const SIZE = 54
  const HALF = SIZE / 2

  // ── lapisan ──
  const viewport = make('g', {}, svg)
  const layerEdges = make('g', { class: 'orc-edges' }, viewport)
  const layerPackets = make('g', { class: 'orc-packets' }, viewport)
  const layerNodes = make('g', { class: 'orc-nodes' }, viewport)

  let accounts = []
  let customers = []
  let busy = new Set()
  let lastEventId = 0
  let loaded = false
  let lastTrouble = null
  let horizontal = false
  // v3.6.122 — jalur data: eksekusi terakhir (seperti hasil run n8n) + titik data yang mengalir saat AI bekerja.
  let stats = { replies: {}, total: 0, jev: 0, checks: 0 }
  const runs = new Map() // jid → { jid, jev, account, check, at }
  let lastRun = null
  const nodes = new Map() // id → { el, shape, icon, label, sub, badge, x, y, kind, info }
  const edges = new Map() // key → { path, label, from, to }
  const flashes = new Map()

  // ── simpul ──
  function roundedPath(w, h, left, right) {
    const x = -w / 2
    const y = -h / 2
    return `M${x + left},${y}H${x + w - right}A${right},${right} 0 0 1 ${x + w},${y + right}V${y + h - right}A${right},${right} 0 0 1 ${x + w - right},${y + h}H${x + left}A${left},${left} 0 0 1 ${x},${y + h - left}V${y + left}A${left},${left} 0 0 1 ${x + left},${y}Z`
  }
  function nodeFor(id, kind) {
    let node = nodes.get(id)
    if (node) return node
    const el = make('g', { class: `orc-n k-${kind}`, tabindex: 0, role: 'img' }, layerNodes)
    if (kind === 'trigger') make('path', { class: 'ring', d: roundedPath(SIZE + 10, SIZE + 10, HALF + 5, 15) }, el)
    const shape = make('path', { class: 'box', d: roundedPath(SIZE, SIZE, kind === 'trigger' ? HALF : 10, 10) }, el)
    const icon = make('path', { class: 'icon', d: ICON[kind] || ICON.ai, transform: 'translate(-12 -12)' }, el)
    const spin = make('circle', { class: 'spin', r: 6, cx: HALF - 3, cy: -HALF + 3 }, el)
    const badge = make('g', { class: 'badge' }, el)
    make('circle', { r: 7, cx: HALF - 3, cy: -HALF + 3 }, badge)
    const badgeText = make('text', { x: HALF - 3, y: -HALF + 6, 'text-anchor': 'middle' }, badge)
    const inPort = make('rect', { class: 'port in', width: 4, height: 10, rx: 1.5 }, el)
    const outPort = make('circle', { class: 'port out', r: 4 }, el)
    const label = make('text', { class: 'label', 'text-anchor': 'middle' }, el)
    const sub = make('text', { class: 'sub', 'text-anchor': 'middle' }, el)
    const model = make('text', { class: 'model', 'text-anchor': 'middle' }, el)
    node = { id, kind, el, shape, icon, spin, badge, badgeText, inPort, outPort, label, sub, model, x: 0, y: 0, info: [] }
    el.addEventListener('mouseenter', () => showTip(node))
    el.addEventListener('focus', () => showTip(node))
    el.addEventListener('mouseleave', hideTip)
    el.addEventListener('blur', hideTip)
    nodes.set(id, node)
    return node
  }
  function place(node, x, y) {
    node.x = x
    node.y = y
    node.el.setAttribute('transform', `translate(${x} ${y})`)
    const port = horizontal
      ? { x: -HALF - 2, y: -5, width: 4, height: 10, cx: HALF, cy: 0 }
      : { x: -5, y: -HALF - 2, width: 10, height: 4, cx: 0, cy: HALF }
    for (const key of ['x', 'y', 'width', 'height']) node.inPort.setAttribute(key, port[key])
    node.outPort.setAttribute('cx', port.cx)
    node.outPort.setAttribute('cy', port.cy)
    // v3.6.122: model di bawah nama (di dalam pil kecil), status di bawahnya.
    node.label.setAttribute('y', HALF + 16)
    node.model.setAttribute('y', HALF + 29)
    node.sub.setAttribute('y', node.model.textContent ? HALF + 42 : HALF + 29)
  }
  // Nama model dipendekkan: "claude-sonnet-4-5-20250929" → "sonnet-4-5", "models/gemini-2.5-flash" → "gemini-2.5-flash".
  const shortModel = (value) =>
    String(value || '')
      .replace(/^models\//, '')
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
      .replace(/-latest$/, '')
      .slice(0, 24)
  function setNode(node, { label, sub = '', state = 'idle', provider = '', count = '', info = [], extra = '', model = '' }) {
    node.model.textContent = model
    node.sub.setAttribute('y', model ? HALF + 42 : HALF + 29)
    node.el.setAttribute('class', `orc-n k-${node.kind} s-${state}${provider ? ` p-${provider}` : ''}${flashes.get(node.id) ? ` f-${flashes.get(node.id)}` : ''}${onPath(node.id) ? ' on-path' : ''}${extra ? ` ${extra}` : ''}`)
    node.label.textContent = label
    node.sub.textContent = sub
    node.badge.style.display = count === '' ? 'none' : ''
    node.badgeText.textContent = String(count)
    node.info = [label, ...info].filter(Boolean)
    node.el.setAttribute('aria-label', node.info.join(' · '))
  }

  // ── garis ──
  function edgeFor(from, to, labelText = '') {
    const key = `${from.id}>${to.id}`
    let edge = edges.get(key)
    if (!edge) {
      const path = make('path', { class: 'orc-e' }, layerEdges)
      const label = make('text', { class: 'orc-e-label', 'text-anchor': 'middle' }, layerEdges)
      edge = { key, path, label }
      edges.set(key, edge)
    }
    edge.from = from
    edge.to = to
    edge.used = true
    const [ox, oy] = horizontal ? [from.x + HALF + 2, from.y] : [from.x, from.y + HALF + 2]
    const [ix, iy] = horizontal ? [to.x - HALF - 2, to.y] : [to.x, to.y - HALF - 2]
    const bend = Math.max(30, (horizontal ? ix - ox : iy - oy) / 2)
    edge.path.setAttribute(
      'd',
      horizontal
        ? `M${ox},${oy} C${ox + bend},${oy} ${ix - bend},${iy} ${ix},${iy}`
        : `M${ox},${oy} C${ox},${oy + bend} ${ix},${iy - bend} ${ix},${iy}`
    )
    edge.label.textContent = labelText
    edge.label.setAttribute('x', ((ox + ix) / 2 + (horizontal ? 0 : 10)).toFixed(1))
    edge.label.setAttribute('y', ((oy + iy) / 2 - (horizontal ? 6 : 0)).toFixed(1))
    return edge
  }
  function edgeState(edge, state, provider = '') {
    edge.path.setAttribute('class', `orc-e s-${state}${provider ? ` p-${provider}` : ''}`)
  }

  // ── jalur eksekusi terakhir ──
  const recent = () => lastRun && Date.now() - lastRun.at < 15 * 60_000
  function pathIds(run) {
    if (!run) return []
    const ids = ['trigger']
    if (run.jev) ids.push('a0')
    if (run.account !== undefined) ids.push(`a${run.account}`)
    if (run.check || run.account !== undefined) ids.push('check')
    if (run.sent) ids.push('send', ...run.outputs)
    return ids
  }
  const onPath = (id) => pathIds(lastRun).includes(id)
  const pathEdge = (from, to) => {
    const ids = pathIds(lastRun)
    const a = ids.indexOf(from)
    const b = ids.indexOf(to)
    return a >= 0 && b >= 0 && (b === a + 1 || (from === 'send' && b > a))
  }
  const today = (n) => (n ? t('{0} hari ini', n) : '')

  // ── tata letak & isi ──
  const JEV = (account) => account.provider === 'jev'
  function render() {
    horizontal = stage.clientWidth >= 560
    for (const edge of edges.values()) edge.used = false
    const aiAccounts = accounts.filter((account) => !JEV(account))
    const jev = accounts.find(JEV)
    const working = aiAccounts.filter((account) => busy.has(account.id))
    const anyBusy = working.length > 0 || (jev && busy.has(jev.id))
    const waiting = customers.filter((c) => c.mode === 'ai' && c.unanswered > 0).length
    const orders = customers.filter((c) => c.order).length
    const payments = customers.filter((c) => c.payment).length
    const handover = customers.filter((c) => c.mode === 'cs').length
    const lastReply = Math.max(0, ...aiAccounts.map((account) => account.lastUsedAt || 0))

    // Kolom alur (setiap kolom berisi satu atau beberapa simpul).
    const columns = []
    const trigger = nodeFor('trigger', 'trigger')
    setNode(trigger, {
      label: t('Pesan masuk'),
      sub: waiting ? t('{0} menunggu', waiting) : t('WhatsApp · Instagram'),
      state: waiting ? 'wait' : 'idle',
      count: waiting || '',
      extra: anyBusy ? '' : 'listen',
      info: [
        t('Pesan pelanggan dari WhatsApp & Instagram'),
        waiting ? t('{0} chat belum dibalas', waiting) : t('Semua chat sudah dibalas'),
        anyBusy ? '' : t('Menunggu pesan baru…'),
      ],
    })
    columns.push([trigger])
    let jevNode = null
    if (jev) {
      jevNode = nodeFor(`a${jev.id}`, 'jev')
      setNode(jevNode, {
        label: 'Jev',
        sub: busy.has(jev.id) ? t('memahami…') : !jev.enabled ? t('mati') : today(stats.jev) || t('pemahaman'),
        state: !jev.enabled ? 'off' : busy.has(jev.id) ? 'busy' : 'idle',
        provider: 'jev',
        model: shortModel(jev.model),
        info: [t('Membaca maksud pelanggan sebelum AI menjawab'), jev.model ? t('Model {0}', jev.model) : '', t('Terakhir {0}', ago(jev.lastUsedAt))],
      })
      columns.push([jevNode])
    }
    const accountNodes = aiAccounts.map((account, index) => {
      const node = nodeFor(`a${account.id}`, 'ai')
      const state = !account.enabled ? 'off' : busy.has(account.id) ? 'busy' : account.limitedUntil ? 'paused' : 'idle'
      setNode(node, {
        label: account.name,
        sub:
          state === 'busy'
            ? t('bekerja…')
            : state === 'paused'
              ? t('jeda s/d {0}', clock(account.limitedUntil))
              : state === 'off'
                ? t('mati')
                : stats.replies[account.id]
                  ? t('{0} balasan hari ini', stats.replies[account.id])
                  : account.lastUsedAt
                    ? ago(account.lastUsedAt)
                    : t('siap'),
        state,
        provider: account.provider,
        count: index + 1,
        model: shortModel(account.model) || t('model otomatis'),
        info: [
          t('Urutan cadangan #{0}', index + 1),
          account.model ? t('Model {0}', account.model) + (account.modelAuto ? ` (${t('otomatis')})` : '') : t('Model otomatis'),
          account.tokens5h ? t('{0} token dalam 5 jam', Number(account.tokens5h).toLocaleString('id-ID')) : '',
          t('Terakhir {0}', ago(account.lastUsedAt)),
        ],
      })
      node.account = account
      node.state = state
      return node
    })
    if (accountNodes.length) columns.push(accountNodes)
    const check = nodeFor('check', 'check')
    setNode(check, {
      label: t('Pemeriksa'),
      sub: anyBusy ? t('menunggu draf') : today(stats.checks) || t('harga · fakta · foto'),
      state: anyBusy ? 'wait' : 'idle',
      info: [t('Memeriksa balasan sebelum dikirim: harga, fakta katalog, foto, tidak mengulang')],
    })
    columns.push([check])
    const send = nodeFor('send', 'send')
    setNode(send, {
      label: t('Kirim balasan'),
      sub: stats.total ? t('{0} balasan hari ini', stats.total) : lastReply ? ago(lastReply) : '',
      state: anyBusy ? 'wait' : 'idle',
      info: [t('Balasan terkirim ke pelanggan'), t('Terakhir {0}', ago(lastReply)), stats.total ? t('{0} balasan hari ini', stats.total) : ''],
    })
    columns.push([send])
    const outOrder = nodeFor('order', 'order')
    setNode(outOrder, { label: t('Order'), sub: t('{0} chat', orders), count: orders || '', info: [t('Chat dengan pesanan berjalan')] })
    const outPay = nodeFor('pay', 'pay')
    setNode(outPay, { label: t('Bayar'), sub: t('{0} chat', payments), count: payments || '', state: payments ? 'wait' : 'idle', info: [t('Menunggu / mengecek pembayaran')] })
    const outCs = nodeFor('cs', 'cs')
    setNode(outCs, { label: 'CS', sub: t('{0} chat', handover), count: handover || '', info: [t('Ditangani CS (AI diam)')] })
    columns.push([outOrder, outPay, outCs])

    // Posisi: kolom berurutan, simpul dalam kolom ditengahkan.
    const step = horizontal ? 160 : 132
    const spread = horizontal ? 128 : 124
    columns.forEach((column, c) => {
      column.forEach((node, i) => {
        const along = c * step
        const across = (i - (column.length - 1) / 2) * spread
        if (horizontal) place(node, along, across)
        else place(node, across, along)
      })
    })
    const keep = new Set(columns.flat().map((node) => node.id))
    for (const [id, node] of nodes)
      if (!keep.has(id)) {
        node.el.remove()
        nodes.delete(id)
      }

    // Garis. Jalur eksekusi terakhir = hijau (≤15 mnt) / hijau pudar; yang sedang dilalui = bergerak.
    const entry = jevNode || trigger
    const done = recent() ? 'done' : 'past'
    const idleOr = (from, to, base = 'idle') => (pathEdge(from.id, to.id) ? done : base)
    if (jevNode) edgeState(edgeFor(trigger, jevNode), anyBusy ? 'run' : idleOr(trigger, jevNode), 'jev')
    for (const node of accountNodes) {
      const run = node.state === 'busy'
      const base = node.state === 'idle' ? 'idle' : 'muted'
      edgeState(edgeFor(entry, node), run ? 'run' : idleOr(entry, node, base), run ? node.account.provider : '')
      edgeState(edgeFor(node, check), run ? 'run' : idleOr(node, check, base), run ? node.account.provider : '')
    }
    if (!accountNodes.length) edgeState(edgeFor(entry, check), 'idle')
    edgeState(edgeFor(check, send), anyBusy ? 'run' : idleOr(check, send))
    edgeState(edgeFor(send, outOrder, orders ? String(orders) : ''), idleOr(send, outOrder))
    edgeState(edgeFor(send, outPay, payments ? String(payments) : ''), idleOr(send, outPay))
    edgeState(edgeFor(send, outCs, handover ? String(handover) : ''), idleOr(send, outCs))
    for (const [key, edge] of edges)
      if (!edge.used) {
        edge.path.remove()
        edge.label.remove()
        edges.delete(key)
      }

    const lastWho = lastRun ? customers.find((c) => c.jid === lastRun.jid)?.name : ''
    nowText.textContent = working.length
      ? t('Sedang bekerja: {0}', working.map((account) => account.name).join(', '))
      : lastRun?.sent
        ? t('Siaga · jalur terakhir {0}{1}', ago(lastRun.at), lastWho ? ` · ${lastWho}` : '')
        : lastReply
          ? t('Siaga · terakhir {0} ({1})', ago(lastReply), aiAccounts.find((a) => a.lastUsedAt === lastReply)?.name || '')
          : t('Siaga')
    fit()
  }

  // ── kamera: muat semua simpul; roda = zoom, seret = geser, klik 2x = reset ──
  let view = null
  let userView = false
  function bounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const node of nodes.values()) {
      minX = Math.min(minX, node.x - HALF - 40)
      maxX = Math.max(maxX, node.x + HALF + 40)
      minY = Math.min(minY, node.y - HALF - 14)
      maxY = Math.max(maxY, node.y + HALF + 50)
    }
    return { minX, maxX, minY, maxY }
  }
  function apply() {
    if (view) svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`)
  }
  function fit(force = false) {
    if (userView && !force) return
    if (!nodes.size) return
    const box = bounds()
    const width = stage.clientWidth || 300
    const height = stage.clientHeight || 300
    const ratio = height / width
    let w = box.maxX - box.minX
    let h = box.maxY - box.minY
    if (h / w > ratio) w = h / ratio
    else h = w * ratio
    // Graf kecil tidak diperbesar berlebihan (maks 1.25×; mode Perbesar 1.8×).
    const minW = width / (root.classList.contains('expanded') ? 1.8 : 1.25)
    if (w < minW) {
      w = minW
      h = w * ratio
    }
    view = { x: (box.minX + box.maxX) / 2 - w / 2, y: (box.minY + box.maxY) / 2 - h / 2, w, h }
    apply()
  }
  svg.addEventListener(
    'wheel',
    (event) => {
      if (!view) return
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      const px = view.x + ((event.clientX - rect.left) / rect.width) * view.w
      const py = view.y + ((event.clientY - rect.top) / rect.height) * view.h
      const factor = Math.min(1.5, Math.max(0.67, Math.exp(event.deltaY * 0.0015)))
      view = { x: px - (px - view.x) * factor, y: py - (py - view.y) * factor, w: view.w * factor, h: view.h * factor }
      userView = true
      apply()
    },
    { passive: false }
  )
  let drag = null
  svg.addEventListener('pointerdown', (event) => {
    if (!view || event.button !== 0) return
    drag = { x: event.clientX, y: event.clientY, view: { ...view } }
    svg.setPointerCapture(event.pointerId)
    svg.classList.add('panning')
  })
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return
    const rect = svg.getBoundingClientRect()
    view = {
      ...drag.view,
      x: drag.view.x - ((event.clientX - drag.x) / rect.width) * drag.view.w,
      y: drag.view.y - ((event.clientY - drag.y) / rect.height) * drag.view.h,
    }
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3) userView = true
    apply()
  })
  const endDrag = () => {
    drag = null
    svg.classList.remove('panning')
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', endDrag)
  svg.addEventListener('dblclick', () => {
    userView = false
    fit(true)
  })
  new ResizeObserver(() => {
    const wasHorizontal = horizontal
    if ((stage.clientWidth >= 560) !== wasHorizontal) render()
    else fit()
  }).observe(stage)

  // ── keterangan simpul ──
  function showTip(node) {
    const rect = stage.getBoundingClientRect()
    const box = node.shape.getBoundingClientRect()
    tip.replaceChildren(
      ...node.info.map((line, index) => {
        const el = document.createElement(index ? 'span' : 'strong')
        el.textContent = line
        return el
      })
    )
    tip.style.left = `${box.left + box.width / 2 - rect.left}px`
    tip.style.top = `${box.top - rect.top}px`
    tip.hidden = false
  }
  function hideTip() {
    tip.hidden = true
  }

  // ── aktivitas (seperti daftar eksekusi n8n) ──
  const logItems = []
  function addLog(text, kind, at, jid = '') {
    logItems.unshift({ text, kind, at, jid })
    logItems.length = Math.min(logItems.length, 6)
    logList.replaceChildren(
      ...logItems.map((item) => {
        const li = document.createElement('li')
        li.className = `k-${item.kind}`
        const time = document.createElement('time')
        time.textContent = clock(item.at)
        const span = document.createElement('span')
        span.textContent = item.text
        li.append(time, span)
        if (item.jid) {
          li.classList.add('clickable')
          li.tabIndex = 0
          li.title = t('Klik untuk membuka chat')
          const open = () => (location.href = `${base}/?jid=${encodeURIComponent(item.jid)}`)
          li.addEventListener('click', open)
          li.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              open()
            }
          })
        }
        return li
      })
    )
  }
  function flash(id, kind) {
    flashes.set(id, kind)
    setTimeout(() => {
      if (flashes.get(id) === kind) flashes.delete(id)
      render()
    }, 2200)
  }
  // Titik data mengalir di sepanjang garis (sekali jalan, lalu hilang). Antrean per poll supaya berurutan.
  let packetDelay = 0
  function packet(fromId, toId, provider = '') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const delay = packetDelay
    packetDelay += 380
    setTimeout(() => {
      const edge = edges.get(`${fromId}>${toId}`)
      if (!edge || !shown()) return
      const length = edge.path.getTotalLength()
      const dot = make('circle', { class: `orc-packet${provider ? ` p-${provider}` : ''}`, r: 5 }, layerPackets)
      const begin = performance.now()
      const step = (now) => {
        const k = Math.min(1, (now - begin) / 650)
        const point = edge.path.getPointAtLength(length * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2))
        dot.setAttribute('cx', point.x.toFixed(1))
        dot.setAttribute('cy', point.y.toFixed(1))
        if (k < 1) requestAnimationFrame(step)
        else dot.remove()
      }
      requestAnimationFrame(step)
    }, delay)
  }
  const IGNORED = /^probe$|judge/
  function track(event, live) {
    if (IGNORED.test(event.phase || '') || event.kind === 'cancel') return
    const key = event.jid || `x${event.accountId}`
    const run = runs.get(key) || { jid: event.jid, outputs: [], at: event.at }
    runs.set(key, run)
    const provider = accounts.find((item) => item.id === event.accountId)?.provider || ''
    const entry = run.jev ? 'a0' : 'trigger'
    if (event.accountId === 0 && /pahami/.test(event.phase) && event.kind === 'ok') {
      run.jev = true
      if (live) packet('trigger', 'a0', 'jev')
    } else if (event.accountId !== 0 && /reply/.test(event.phase)) {
      if (event.kind === 'start' && live) packet(entry, `a${event.accountId}`, provider)
      if (event.kind === 'ok') {
        run.account = event.accountId
        run.at = event.at
        if (live) packet(`a${event.accountId}`, 'check', provider)
        // Pemeriksa Jev/AI bisa tidak berjalan (balasan sederhana): dianggap terkirim sesudah balasan jadi.
        finish(run, live, 1500)
      }
    } else if (/check|cek-balasan/.test(event.phase) && event.kind === 'ok') {
      run.check = true
      if (run.account !== undefined) finish(run, live, 0)
    }
  }
  function finish(run, live, wait) {
    clearTimeout(run.timer)
    const close = () => {
      if (run.sent) return
      run.sent = true
      const customer = customers.find((c) => c.jid === run.jid)
      run.outputs = customer ? [customer.mode === 'cs' ? 'cs' : '', customer.payment ? 'pay' : '', customer.order ? 'order' : ''].filter(Boolean) : []
      lastRun = run
      if (live) {
        packet('check', 'send')
        for (const output of run.outputs) packet('send', output)
        flash('send', 'ok')
      } else render()
    }
    if (live) run.timer = setTimeout(close, wait)
    else close()
  }

  function handleEvent(event, live) {
    track(event, live)
    if (event.kind === 'cancel') return
    const account = accounts.find((item) => item.id === event.accountId)
    const name = account?.name || `#${event.accountId}`
    const who = customers.find((c) => c.jid === event.jid)?.name
    if (event.kind === 'start') {
      if (lastTrouble && lastTrouble.id !== event.accountId && event.at - lastTrouble.at < 15000) {
        const from = accounts.find((item) => item.id === lastTrouble.id)
        addLog(
          t('{0} {1} → pindah ke {2}', from?.name || '', lastTrouble.kind === 'limited' ? t('habis kuota/perlu login') : t('gagal'), name),
          'switch',
          event.at
        )
        lastTrouble = null
      }
      return
    }
    if (event.kind === 'ok') {
      if (account?.provider === 'jev') return
      addLog(who && /reply/.test(event.phase) ? t('{0} membalas {1}', name, who) : t('{0} menyelesaikan {1}', name, phaseLabel(event.phase)), 'ok', event.at, event.jid || '')
      if (live) flash(`a${event.accountId}`, 'ok')
      return
    }
    if (account?.provider !== 'jev') lastTrouble = { id: event.accountId, at: event.at, kind: event.kind }
    addLog(
      event.kind === 'limited'
        ? t('{0} habis kuota / perlu login', name)
        : t('{0} gagal ({1})', name, (event.detail || '-').replace(/^[A-Z_]+: /, '').slice(0, 90)),
      event.kind,
      event.at
    )
    if (live) flash(`a${event.accountId}`, 'err')
  }

  expandButton?.addEventListener('click', () => {
    const open = !root.classList.contains('expanded')
    root.classList.toggle('expanded', open)
    expandButton.setAttribute('aria-pressed', String(open))
    expandButton.textContent = open ? t('Kecilkan') : t('Perbesar')
    userView = false
    requestAnimationFrame(() => render())
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('expanded')) expandButton?.click()
  })

  // ── data ──
  let pollTimer
  async function poll() {
    clearTimeout(pollTimer)
    const visible = !document.hidden && shown()
    if (visible) {
      try {
        const response = await fetch(`${base}/api/ai/orchestra?after=${lastEventId}`, {
          cache: 'no-store',
          headers: { Accept: 'application/json', 'X-WhatsApp-Workspace': workspace() },
        })
        if (response.ok) {
          const data = await response.json()
          accounts = data.accounts || []
          busy = new Set(data.busy || [])
          customers = data.customers || customers
          stats = data.stats || stats
          packetDelay = 0
          // Garis harus sudah ada sebelum titik data berjalan.
          render()
          for (const event of data.events || []) {
            handleEvent(event, loaded)
            lastEventId = Math.max(lastEventId, event.id)
          }
          loaded = true
          render()
        }
      } catch {}
    }
    // Ada AI bekerja → 2 dtk; diam → 5 dtk; panel tidak terlihat → 15 dtk (hanya cek terlihat).
    pollTimer = setTimeout(poll, !visible ? 15000 : busy.size ? 2000 : 5000)
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll()
  })
  poll()
})()
