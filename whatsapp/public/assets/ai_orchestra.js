;(() => {
  // Orkestra AI: peta akun AI ala graph view. Akun yang sedang bekerja menyala,
  // denyut berjalan dari "WhatsApp" ke akun, dan perpindahan akun digambar sebagai busur.
  const root = document.getElementById('aiOrchestra')
  if (!root) return
  const svg = document.getElementById('aiOrchestraGraph')
  const tip = document.getElementById('aiOrchestraTip')
  const logList = document.getElementById('aiOrchestraLog')
  const nowText = document.getElementById('aiOrchestraNow')
  const NS = 'http://www.w3.org/2000/svg'
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const workspace = () => document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  const make = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    if (parent) parent.append(node)
    return node
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  const ago = (ms) => {
    if (!ms) return t('belum pernah')
    const minutes = Math.round((Date.now() - ms) / 60000)
    if (minutes < 1) return t('baru saja')
    if (minutes < 60) return t('{0} mnt lalu', minutes)
    const hours = Math.round(minutes / 60)
    return hours < 24 ? t('{0} jam lalu', hours) : t('{0} hari lalu', Math.round(hours / 24))
  }
  const phaseLabel = (phase) =>
    /recap/.test(phase) ? t('rekap order') : /catalog|vision/.test(phase) ? t('baca katalog') : t('balasan chat')

  // Lapisan gambar: garis → busur perpindahan → denyut → simpul.
  const layerEdges = make('g', { class: 'orc-edges' }, svg)
  const layerArcs = make('g', { class: 'orc-arcs' }, svg)
  const layerPulses = make('g', { class: 'orc-pulses' }, svg)
  const layerNodes = make('g', { class: 'orc-nodes' }, svg)
  const hub = { id: 'hub', x: 0, y: 0, vx: 0, vy: 0, fixed: true }
  hub.el = make('g', { class: 'orc-node orc-hub' }, layerNodes)
  make('circle', { class: 'halo', r: 26 }, hub.el)
  make('circle', { class: 'core', r: 15 }, hub.el)
  make('text', { class: 'label', y: 32, 'text-anchor': 'middle' }, hub.el).textContent = 'WhatsApp'

  const nodes = new Map()
  let accounts = []
  let busy = new Set()
  let lastEventId = 0
  let loaded = false
  let pulses = []
  let arcs = []
  let lastTrouble = null // { id, at, kind } untuk mendeteksi perpindahan
  const logItems = []

  function nodeFor(account, index, total) {
    let node = nodes.get(account.id)
    if (!node) {
      const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
      node = { id: account.id, x: Math.cos(angle) * 115, y: Math.sin(angle) * 115, vx: 0, vy: 0 }
      node.edge = make('line', { class: 'orc-edge' }, layerEdges)
      node.el = make('g', { class: 'orc-node', tabindex: 0 }, layerNodes)
      make('circle', { class: 'halo', r: 22 }, node.el)
      make('circle', { class: 'core', r: 10 }, node.el)
      node.badge = make('text', { class: 'badge', y: 3.5, 'text-anchor': 'middle' }, node.el)
      node.label = make('text', { class: 'label', y: 25, 'text-anchor': 'middle' }, node.el)
      node.sub = make('text', { class: 'sub', y: 36, 'text-anchor': 'middle' }, node.el)
      node.el.addEventListener('pointerenter', () => showTip(node))
      node.el.addEventListener('pointerleave', hideTip)
      node.el.addEventListener('focus', () => showTip(node))
      node.el.addEventListener('blur', hideTip)
      node.el.addEventListener('pointerdown', (event) => startDrag(event, node))
      nodes.set(account.id, node)
    }
    return node
  }

  function render() {
    const seen = new Set()
    accounts.forEach((account, index) => {
      const node = nodeFor(account, index, accounts.length)
      node.account = account
      node.order = index + 1
      seen.add(account.id)
      const state = !account.enabled
        ? 'off'
        : busy.has(account.id)
          ? 'busy'
          : account.limitedUntil
            ? 'paused'
            : 'ready'
      node.state = state
      node.el.setAttribute('class', `orc-node p-${account.provider} s-${state}`)
      node.edge.setAttribute('class', `orc-edge p-${account.provider} s-${state}`)
      node.badge.textContent = String(index + 1)
      // Ukuran simpul = porsi token 5 jam terakhir (terlihat merata atau tidak).
      const maxTokens = Math.max(1, ...accounts.map((a) => a.tokens5h || 0))
      node.el.querySelector('.core').setAttribute('r', String(8 + 7 * Math.sqrt((account.tokens5h || 0) / maxTokens)))
      node.label.textContent = account.name
      node.sub.textContent =
        state === 'paused' ? t('jeda s/d {0}', clock(account.limitedUntil)) : state === 'busy' ? t('bekerja…') : ''
    })
    for (const [id, node] of nodes)
      if (!seen.has(id)) {
        node.el.remove()
        node.edge.remove()
        nodes.delete(id)
      }
    const working = accounts.filter((a) => busy.has(a.id))
    const last = [...accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    nowText.textContent = working.length
      ? t('Sedang bekerja: {0}', working.map((a) => a.name).join(', '))
      : last?.lastUsedAt
        ? t('Siaga · terakhir {0} ({1})', last.name, ago(last.lastUsedAt))
        : t('Siaga')
  }

  function stateText(node) {
    const a = node.account
    if (node.state === 'off') return t('Nonaktif')
    if (node.state === 'busy') return t('Sedang bekerja')
    if (node.state === 'paused') return t('Jeda s/d {0}', clock(a.limitedUntil))
    return t('Siap')
  }
  function showTip(node) {
    if (!node.account) return
    tip.replaceChildren()
    const title = document.createElement('strong')
    title.textContent = `${node.order}. ${node.account.name}`
    const line = document.createElement('span')
    line.textContent = `${stateText(node)} · ${t('dipakai')} ${ago(node.account.lastUsedAt)}`
    const tokens = document.createElement('span')
    tokens.textContent = t('{0} token dalam 5 jam', (node.account.tokens5h || 0).toLocaleString('id-ID'))
    tip.append(title, line, tokens)
    tip.hidden = false
    const box = svg.getBoundingClientRect()
    const scale = box.width / 360
    tip.style.left = `${(node.x + 180) * scale}px`
    tip.style.top = `${(node.y + 180) * scale}px`
  }
  function hideTip() {
    tip.hidden = true
  }

  // Seret simpul seperti graph view; dilepas → kembali mengambang.
  function toGraph(event) {
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    return point.matrixTransform(svg.getScreenCTM().inverse())
  }
  function startDrag(event, node) {
    event.preventDefault()
    node.fixed = true
    const move = (next) => {
      const p = toGraph(next)
      node.x = Math.max(-165, Math.min(165, p.x))
      node.y = Math.max(-165, Math.min(165, p.y))
      node.vx = node.vy = 0
      kick()
    }
    const end = () => {
      node.fixed = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      kick()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  function pulse(from, to, kind) {
    if (reduce.matches) return
    const dot = make('circle', { class: `orc-pulse k-${kind} p-${to.account?.provider || from.account?.provider || ''}`, r: 3.2 }, layerPulses)
    pulses.push({ from, to, t: 0, dot })
    kick()
  }
  function flash(node, kind) {
    node.el.classList.add(`flash-${kind}`)
    setTimeout(() => node.el.classList.remove(`flash-${kind}`), 1600)
  }
  function switchArc(from, to) {
    const path = make('path', { class: 'orc-arc', 'marker-end': 'url(#orcArrow)' }, layerArcs)
    arcs.push({ from, to, path, born: performance.now() })
    kick()
  }
  make('marker', { id: 'orcArrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, make('defs', {}, svg))
  make('path', { d: 'M0,0 L10,5 L0,10 z', class: 'orc-arrow' }, svg.querySelector('#orcArrow'))

  function addLog(text, kind, at) {
    logItems.unshift({ text, kind, at })
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
        return li
      })
    )
  }

  function handleEvent(event, animate) {
    const node = nodes.get(event.accountId)
    const name = node?.account?.name || `#${event.accountId}`
    if (event.kind === 'start') {
      if (lastTrouble && lastTrouble.id !== event.accountId && event.at - lastTrouble.at < 15000) {
        const from = nodes.get(lastTrouble.id)
        addLog(
          t('{0} {1} → pindah ke {2}', from?.account?.name || '', lastTrouble.kind === 'limited' ? t('habis kuota/perlu login') : t('gagal'), name),
          'switch',
          event.at
        )
        if (animate && from && node) switchArc(from, node)
        lastTrouble = null
      }
      if (animate && node) pulse(hub, node, 'start')
    } else if (event.kind === 'ok') {
      addLog(t('{0} menyelesaikan {1}', name, phaseLabel(event.phase)), 'ok', event.at)
      if (animate && node) pulse(node, hub, 'ok')
    } else {
      lastTrouble = { id: event.accountId, at: event.at, kind: event.kind }
      addLog(
        event.kind === 'limited' ? t('{0} habis kuota / perlu login', name) : t('{0} gagal ({1})', name, (event.detail || '-').replace(/^[A-Z_]+: /, '').slice(0, 90)),
        event.kind,
        event.at
      )
      if (animate && node) flash(node, event.kind)
    }
  }

  // ── simulasi ringan: pegas ke pusat + tolak-menolak, sedikit mengambang ──
  let running = false
  let lastFrame = 0
  let busyTimer = 0
  function kick() {
    if (running || document.hidden || root.offsetParent === null) return
    running = true
    lastFrame = performance.now()
    requestAnimationFrame(frame)
  }
  function frame(now) {
    const dt = Math.min(50, now - lastFrame)
    lastFrame = now
    const list = [...nodes.values()]
    const radius = list.length > 5 ? 130 : 112
    let energy = 0
    for (const node of list) {
      if (node.fixed) continue
      const dist = Math.hypot(node.x, node.y) || 1
      let fx = (-(dist - radius) * 0.012 * node.x) / dist
      let fy = (-(dist - radius) * 0.012 * node.y) / dist
      for (const other of list) {
        if (other === node) continue
        const dx = node.x - other.x
        const dy = node.y - other.y
        const d2 = Math.max(80, dx * dx + dy * dy)
        fx += (dx / d2) * 38
        fy += (dy / d2) * 38
      }
      if (!reduce.matches) {
        // Mengambang pelan seperti graph view.
        fx += Math.sin(now / 1900 + node.id) * 0.012
        fy += Math.cos(now / 2300 + node.id * 1.7) * 0.012
      }
      node.vx = (node.vx + fx) * 0.86
      node.vy = (node.vy + fy) * 0.86
      node.x = Math.max(-160, Math.min(160, node.x + node.vx))
      node.y = Math.max(-160, Math.min(160, node.y + node.vy))
      energy += Math.abs(node.vx) + Math.abs(node.vy)
    }
    for (const node of list) {
      node.el.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
      node.edge.setAttribute('x1', '0')
      node.edge.setAttribute('y1', '0')
      node.edge.setAttribute('x2', node.x.toFixed(1))
      node.edge.setAttribute('y2', node.y.toFixed(1))
    }
    // Denyut untuk akun yang sedang bekerja.
    if (!reduce.matches && busy.size && now - busyTimer > 520) {
      busyTimer = now
      for (const id of busy) {
        const node = nodes.get(id)
        if (node) pulse(hub, node, 'busy')
      }
    }
    pulses = pulses.filter((item) => {
      item.t += dt / 750
      if (item.t >= 1) {
        item.dot.remove()
        return false
      }
      const e = item.t < 0.5 ? 2 * item.t * item.t : 1 - (-2 * item.t + 2) ** 2 / 2
      item.dot.setAttribute('cx', (item.from.x + (item.to.x - item.from.x) * e).toFixed(1))
      item.dot.setAttribute('cy', (item.from.y + (item.to.y - item.from.y) * e).toFixed(1))
      return true
    })
    arcs = arcs.filter((arc) => {
      const age = now - arc.born
      if (age > 4000) {
        arc.path.remove()
        return false
      }
      const mx = (arc.from.x + arc.to.x) / 2
      const my = (arc.from.y + arc.to.y) / 2
      const len = Math.hypot(mx, my) || 1
      const bend = 55
      const cx = mx + (mx / len) * bend
      const cy = my + (my / len) * bend
      arc.path.setAttribute('d', `M${arc.from.x},${arc.from.y} Q${cx},${cy} ${arc.to.x},${arc.to.y}`)
      arc.path.style.opacity = String(Math.min(1, (4000 - age) / 1200))
      return true
    })
    const calm = energy < 0.05 && !pulses.length && !arcs.length && !busy.size
    if (!document.hidden && root.offsetParent !== null && (!calm || !reduce.matches) && !(calm && reduce.matches)) {
      requestAnimationFrame(frame)
    } else running = false
  }

  // ── data ──
  let pollTimer
  async function poll() {
    clearTimeout(pollTimer)
    const visible = !document.hidden && root.offsetParent !== null
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
          render()
          for (const event of data.events || []) {
            handleEvent(event, loaded)
            lastEventId = Math.max(lastEventId, event.id)
          }
          loaded = true
          kick()
        }
      } catch {}
    }
    pollTimer = setTimeout(poll, visible ? 2000 : 8000)
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      poll()
      kick()
    }
  })
  window.addEventListener('resize', kick)
  poll()
})()
