;(() => {
  // Orkestra AI: peta ala graph view Obsidian. Pusat WhatsApp, cincin akun AI, dan awan
  // pelanggan yang menempel ke akun yang terakhir melayani. Akun yang bekerja menyala,
  // denyut mengalir pelanggan → akun → pelanggan, perpindahan akun tampil sebagai busur.
  const root = document.getElementById('aiOrchestra')
  if (!root) return
  const svg = document.getElementById('aiOrchestraGraph')
  const tip = document.getElementById('aiOrchestraTip')
  const logList = document.getElementById('aiOrchestraLog')
  const nowText = document.getElementById('aiOrchestraNow')
  const expandButton = document.getElementById('aiOrchestraExpand')
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
    /recap/.test(phase) ? t('rekap order') : /catalog|vision|ciri/.test(phase) ? t('baca katalog') : t('balasan chat')

  // ── kanvas: zoom (roda/pinch) & geser (seret latar) ──
  const view = { x: -200, y: -200, w: 400, h: 400 }
  // Tanpa zoom manual, kamera mengikuti seluruh graf (seperti Obsidian).
  let userView = false
  const applyView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`)
  applyView()
  const camera = make('g', {}, svg)
  const defs = make('defs', {}, svg)
  const marker = make('marker', { id: 'orcArrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, defs)
  make('path', { d: 'M0,0 L10,5 L0,10 z', class: 'orc-arrow' }, marker)
  const layerLinks = make('g', { class: 'orc-links' }, camera)
  const layerEdges = make('g', { class: 'orc-edges' }, camera)
  const layerArcs = make('g', { class: 'orc-arcs' }, camera)
  const layerPulses = make('g', { class: 'orc-pulses' }, camera)
  const layerCustomers = make('g', { class: 'orc-customers' }, camera)
  const layerNodes = make('g', { class: 'orc-nodes' }, camera)

  const hub = { id: 'hub', x: 0, y: 0, vx: 0, vy: 0, fixed: true }
  hub.el = make('g', { class: 'orc-node orc-hub' }, layerNodes)
  make('circle', { class: 'halo', r: 16 }, hub.el)
  make('circle', { class: 'core', r: 9 }, hub.el)
  make('text', { class: 'label', y: 20, 'text-anchor': 'middle' }, hub.el).textContent = 'WhatsApp'

  const nodes = new Map() // akun AI
  const people = new Map() // pelanggan
  let accounts = []
  let busy = new Set()
  let lastEventId = 0
  let loaded = false
  let pulses = []
  let arcs = []
  let lastTrouble = null
  const logItems = []

  function toGraph(event) {
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    return point.matrixTransform(svg.getScreenCTM().inverse())
  }
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const p = toGraph(event)
      const factor = Math.exp(event.deltaY * 0.0015)
      const w = Math.min(1400, Math.max(120, view.w * factor))
      const k = w / view.w
      view.x = p.x - (p.x - view.x) * k
      view.y = p.y - (p.y - view.y) * k
      view.w = view.h = w
      userView = true
      applyView()
      labelDensity()
    },
    { passive: false }
  )
  svg.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.orc-node, .orc-person')) return
    const start = toGraph(event)
    userView = true
    svg.classList.add('panning')
    const move = (next) => {
      const p = toGraph(next)
      view.x -= p.x - start.x
      view.y -= p.y - start.y
      applyView()
    }
    const end = () => {
      svg.classList.remove('panning')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  })
  svg.addEventListener('dblclick', () => {
    userView = false
    kick()
  })
  // Label pelanggan muncul saat diperbesar (seperti Obsidian), selalu untuk yang aktif.
  function labelDensity() {
    svg.classList.toggle('orc-zoomed', view.w < 300)
  }

  expandButton?.addEventListener('click', () => {
    const open = !root.classList.contains('expanded')
    root.classList.toggle('expanded', open)
    expandButton.setAttribute('aria-pressed', String(open))
    expandButton.textContent = open ? t('Kecilkan') : t('Perbesar')
    kick()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('expanded')) expandButton?.click()
  })

  // ── simpul akun AI ──
  function nodeFor(account, index, total) {
    let node = nodes.get(account.id)
    if (!node) {
      const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2
      node = { id: account.id, kind: 'account', x: Math.cos(angle) * 115, y: Math.sin(angle) * 115, vx: 0, vy: 0 }
      node.edge = make('line', { class: 'orc-edge' }, layerEdges)
      node.el = make('g', { class: 'orc-node', tabindex: 0 }, layerNodes)
      make('circle', { class: 'halo', r: 14 }, node.el)
      node.core = make('circle', { class: 'core', r: 6 }, node.el)
      node.badge = make('text', { class: 'badge', y: 2.3, 'text-anchor': 'middle' }, node.el)
      node.label = make('text', { class: 'label', y: 17, 'text-anchor': 'middle' }, node.el)
      node.sub = make('text', { class: 'sub', y: 25, 'text-anchor': 'middle' }, node.el)
      bindHover(node)
      node.el.addEventListener('pointerdown', (event) => startDrag(event, node))
      nodes.set(account.id, node)
      reheat(0.8)
    }
    return node
  }

  // ── simpul pelanggan ──
  function personFor(customer) {
    let node = people.get(customer.jid)
    if (!node) {
      const anchor = nodes.get(customer.accountId) || hub
      const angle = Math.random() * Math.PI * 2
      const r = anchor === hub ? 170 : 40
      node = {
        id: customer.jid,
        kind: 'person',
        x: anchor.x + Math.cos(angle) * r,
        y: anchor.y + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        seed: Math.random() * 100,
      }
      node.link = make('line', { class: 'orc-link' }, layerLinks)
      node.el = make('g', { class: 'orc-person', tabindex: 0 }, layerCustomers)
      node.dot = make('circle', { class: 'dot', r: 2.5 }, node.el)
      node.label = make('text', { class: 'plabel', y: 8, 'text-anchor': 'middle' }, node.el)
      bindHover(node)
      node.el.addEventListener('click', () => {
        if (node.dragged) return
        location.href = `${base}/?jid=${encodeURIComponent(node.customer.jid)}`
      })
      node.el.addEventListener('pointerdown', (event) => startDrag(event, node))
      people.set(customer.jid, node)
      reheat(0.6)
    }
    return node
  }

  function render(customers) {
    const seen = new Set()
    const maxTokens = Math.max(1, ...accounts.map((a) => a.tokens5h || 0))
    accounts.forEach((account, index) => {
      const node = nodeFor(account, index, accounts.length)
      node.account = account
      node.order = index + 1
      seen.add(account.id)
      const state = !account.enabled ? 'off' : busy.has(account.id) ? 'busy' : account.limitedUntil ? 'paused' : 'ready'
      node.state = state
      node.el.setAttribute('class', `orc-node p-${account.provider} s-${state}`)
      node.edge.setAttribute('class', `orc-edge p-${account.provider} s-${state}`)
      node.badge.textContent = String(index + 1)
      node.label.textContent = account.name
      node.sub.textContent =
        state === 'paused' ? t('jeda s/d {0}', clock(account.limitedUntil)) : state === 'busy' ? t('bekerja…') : ''
      // Ukuran = porsi token 5 jam terakhir.
      node.core.setAttribute('r', String(5 + 4 * Math.sqrt((account.tokens5h || 0) / maxTokens)))
    })
    for (const [id, node] of nodes)
      if (!seen.has(id)) {
        node.el.remove()
        node.edge.remove()
        nodes.delete(id)
      }

    if (customers) {
      const keep = new Set()
      const now = Date.now()
      for (const customer of customers) {
        const node = personFor(customer)
        if (node.customer && node.customer.accountId !== customer.accountId) reheat(0.3)
        node.customer = customer
        keep.add(customer.jid)
        const fresh = now - customer.at < 10 * 60_000
        const status = customer.payment
          ? 'payment'
          : customer.order
            ? 'order'
            : customer.mode === 'cs'
              ? 'cs'
              : customer.unanswered
                ? 'waiting'
                : 'ai'
        const provider = nodes.get(customer.accountId)?.account?.provider || ''
        node.el.setAttribute('class', `orc-person c-${status} ${fresh ? 'fresh' : ''} ${customer.unread ? 'unread' : ''}`)
        node.link.setAttribute('class', `orc-link ${customer.accountId && nodes.has(customer.accountId) ? `p-${provider}` : 'loose'} ${fresh ? 'fresh' : ''}`)
        node.dot.setAttribute('r', String(2.2 + Math.min(2.5, Math.log2(1 + customer.unread + customer.unanswered))))
        node.label.textContent = customer.name
      }
      for (const [jid, node] of people)
        if (!keep.has(jid)) {
          node.el.remove()
          node.link.remove()
          people.delete(jid)
        }
    }

    const working = accounts.filter((a) => busy.has(a.id))
    const last = [...accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    nowText.textContent = working.length
      ? t('Sedang bekerja: {0}', working.map((a) => a.name).join(', '))
      : last?.lastUsedAt
        ? t('Siaga · terakhir {0} ({1})', last.name, ago(last.lastUsedAt))
        : t('Siaga')
  }

  // ── keterangan saat kursor di atas simpul ──
  function bindHover(node) {
    node.el.addEventListener('pointerenter', () => showTip(node))
    node.el.addEventListener('pointerleave', hideTip)
    node.el.addEventListener('focus', () => showTip(node))
    node.el.addEventListener('blur', hideTip)
  }
  // Sorot simpul & tetangganya, redupkan sisanya (seperti hover di Obsidian).
  function highlight(node) {
    svg.classList.add('orc-focus')
    const lit = new Set([node])
    const litLines = new Set()
    if (node.kind === 'account') {
      lit.add(hub)
      litLines.add(node.edge)
      for (const person of people.values())
        if (person.customer.accountId === node.id) {
          lit.add(person)
          litLines.add(person.link)
        }
    } else if (node.kind === 'person') {
      const anchor = nodes.get(node.customer.accountId) || hub
      lit.add(anchor)
      litLines.add(node.link)
    } else {
      for (const account of nodes.values()) {
        lit.add(account)
        litLines.add(account.edge)
      }
    }
    for (const item of [hub, ...nodes.values(), ...people.values()]) item.el.classList.toggle('hl', lit.has(item))
    for (const item of [...nodes.values()]) item.edge.classList.toggle('hl', litLines.has(item.edge))
    for (const item of [...people.values()]) item.link.classList.toggle('hl', litLines.has(item.link))
  }
  function unhighlight() {
    svg.classList.remove('orc-focus')
  }
  hub.el.addEventListener('pointerenter', () => highlight(hub))
  hub.el.addEventListener('pointerleave', unhighlight)
  function showTip(node) {
    const lines = []
    if (node.kind === 'account' && node.account) {
      const a = node.account
      const state =
        node.state === 'off'
          ? t('Nonaktif')
          : node.state === 'busy'
            ? t('Sedang bekerja')
            : node.state === 'paused'
              ? t('Jeda s/d {0}', clock(a.limitedUntil))
              : t('Siap')
      lines.push(`${node.order}. ${a.name}`, `${state} · ${t('dipakai')} ${ago(a.lastUsedAt)}`)
      lines.push(t('{0} token dalam 5 jam', (a.tokens5h || 0).toLocaleString('id-ID')))
      const served = [...people.values()].filter((p) => p.customer.accountId === a.id).length
      if (served) lines.push(t('{0} pelanggan dilayani', served))
    } else if (node.kind === 'person' && node.customer) {
      const c = node.customer
      const by = nodes.get(c.accountId)?.account?.name
      lines.push(c.name)
      lines.push(
        [
          c.payment ? t('Menunggu konfirmasi bayar') : c.order ? t('Ada order') : c.mode === 'cs' ? t('Ditangani CS') : t('Ditangani AI'),
          c.unanswered ? t('{0} belum dibalas', c.unanswered) : '',
        ]
          .filter(Boolean)
          .join(' · ')
      )
      lines.push(`${by ? t('dilayani {0}', by) + ' · ' : ''}${ago(c.at)}`)
      lines.push(t('Klik untuk membuka chat'))
    } else return
    tip.replaceChildren(
      ...lines.map((text, i) => {
        const el = document.createElement(i ? 'span' : 'strong')
        el.textContent = text
        return el
      })
    )
    tip.hidden = false
    highlight(node)
    const box = svg.getBoundingClientRect()
    const stage = svg.parentElement.getBoundingClientRect()
    const point = svg.createSVGPoint()
    point.x = node.x
    point.y = node.y
    const screen = point.matrixTransform(svg.getScreenCTM())
    tip.style.left = `${screen.x - stage.left}px`
    tip.style.top = `${screen.y - stage.top}px`
    void box
  }
  function hideTip() {
    tip.hidden = true
    unhighlight()
  }

  function startDrag(event, node) {
    event.preventDefault()
    event.stopPropagation()
    node.fixed = true
    node.dragged = false
    const origin = { x: event.clientX, y: event.clientY }
    const move = (next) => {
      if (Math.hypot(next.clientX - origin.x, next.clientY - origin.y) > 3) node.dragged = true
      const p = toGraph(next)
      node.x = p.x
      node.y = p.y
      node.vx = node.vy = 0
      reheat(0.3)
    }
    const end = () => {
      node.fixed = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setTimeout(() => (node.dragged = false), 0)
      kick()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  function pulse(from, to, kind, provider) {
    if (reduce.matches || !from || !to) return
    const dot = make('circle', { class: `orc-pulse k-${kind} p-${provider || ''}`, r: 2 }, layerPulses)
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
    const person = event.jid ? people.get(event.jid) : null
    const who = person?.customer?.name
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
      if (animate && node) {
        const provider = node.account?.provider
        if (person) {
          // Pelanggan pindah menempel ke akun yang sedang melayani.
          if (person.customer.accountId !== event.accountId) reheat(0.3)
          person.customer.accountId = event.accountId
          pulse(person, node, 'start', provider)
        } else pulse(hub, node, 'start', provider)
      }
    } else if (event.kind === 'ok') {
      addLog(
        who ? t('{0} membalas {1}', name, who) : t('{0} menyelesaikan {1}', name, phaseLabel(event.phase)),
        'ok',
        event.at
      )
      if (animate && node) pulse(node, person || hub, 'ok', node.account?.provider)
      if (animate && person) flash(person, 'ok')
    } else {
      lastTrouble = { id: event.accountId, at: event.at, kind: event.kind }
      addLog(
        event.kind === 'limited'
          ? t('{0} habis kuota / perlu login', name)
          : t('{0} gagal ({1})', name, (event.detail || '-').replace(/^[A-Z_]+: /, '').slice(0, 90)),
        event.kind,
        event.at
      )
      if (animate && node) flash(node, event.kind)
    }
  }

  // ── simulasi: pegas + tolak-menolak ──
  let running = false
  let lastFrame = 0
  let busyTimer = 0
  const ALPHA_MIN = 0.004
  const ALPHA_DECAY = 0.0228
  let alpha = 1
  /** Panaskan tata letak (data berubah / simpul diseret) agar bergerak lalu tenang lagi. */
  function reheat(value = 0.3) {
    alpha = Math.max(alpha, value)
    kick()
  }
  function kick() {
    if (running || document.hidden || root.offsetParent === null) return
    running = true
    lastFrame = performance.now()
    requestAnimationFrame(frame)
  }
  function frame(now) {
    const dt = Math.min(50, now - lastFrame)
    lastFrame = now
    const accountList = [...nodes.values()]
    const peopleList = [...people.values()]
    const all = [...accountList, ...peopleList]
    // Tata letak gaya d3-force (seperti graph view Obsidian): pegas di garis, tolak-menolak,
    // tarikan ke tengah, anti-tumpuk, lalu "mendingin" sampai diam. Dipanaskan lagi bila berubah.
    if (alpha > ALPHA_MIN) {
      alpha += (0 - alpha) * ALPHA_DECAY
      const bodies = [hub, ...all]
      const links = []
      // [asal, tujuan, panjang, kekuatan]
      for (const node of accountList) links.push([hub, node, 70, 0.8])
      for (const node of peopleList) {
        const anchor = nodes.get(node.customer.accountId)
        links.push(anchor ? [anchor, node, 30, 0.6] : [hub, node, 125, 0.15])
      }
      const degree = new Map()
      for (const [s, t] of links) {
        degree.set(s, (degree.get(s) || 0) + 1)
        degree.set(t, (degree.get(t) || 0) + 1)
      }
      // Pegas garis.
      for (const [source, target, distance, strength] of links) {
        let dx = target.x + target.vx - source.x - source.vx || 0.01
        let dy = target.y + target.vy - source.y - source.vy || 0.01
        const l = Math.hypot(dx, dy)
        const k = ((l - distance) / l) * alpha * strength
        dx *= k
        dy *= k
        const bias = degree.get(source) / (degree.get(source) + degree.get(target))
        if (!target.fixed) {
          target.vx -= dx * bias
          target.vy -= dy * bias
        }
        if (!source.fixed) {
          source.vx += dx * (1 - bias)
          source.vy += dy * (1 - bias)
        }
      }
      // Tolak-menolak (muatan) + anti-tumpuk.
      const radius = (node) => (node === hub ? 12 : node.kind === 'account' ? 10 : 4)
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i]
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j]
          let dx = b.x - a.x || (Math.random() - 0.5) * 0.1
          let dy = b.y - a.y || (Math.random() - 0.5) * 0.1
          let d2 = dx * dx + dy * dy
          if (d2 > 90000) continue
          // Muatan per simpul (seperti d3 manyBody): akun & pusat lebih kuat dari pelanggan.
          const charge = (node) => (node === hub ? -140 : node.kind === 'account' ? -90 : -14)
          const inv = alpha / Math.max(d2, 25)
          if (!a.fixed) {
            a.vx += dx * charge(b) * inv
            a.vy += dy * charge(b) * inv
          }
          if (!b.fixed) {
            b.vx -= dx * charge(a) * inv
            b.vy -= dy * charge(a) * inv
          }
          const min = radius(a) + radius(b) + 2
          const d = Math.sqrt(d2) || 0.01
          if (d < min) {
            const push = ((min - d) / d) * 0.5
            if (!a.fixed) {
              a.x -= dx * push
              a.y -= dy * push
            }
            if (!b.fixed) {
              b.x += dx * push
              b.y += dy * push
            }
          }
        }
      }
      // Tarikan lembut ke tengah & redaman kecepatan.
      for (const node of all) {
        if (node.fixed) {
          node.vx = node.vy = 0
          continue
        }
        node.vx -= node.x * 0.004 * alpha
        node.vy -= node.y * 0.004 * alpha
        node.vx *= 0.6
        node.vy *= 0.6
        node.x += node.vx
        node.y += node.vy
      }
    }
    const energy = alpha
    if (!userView && all.length) {
      // Kamera mengikuti batas graf dengan halus.
      let minX = -60, maxX = 60, minY = -60, maxY = 60
      for (const node of all) {
        minX = Math.min(minX, node.x)
        maxX = Math.max(maxX, node.x)
        minY = Math.min(minY, node.y)
        maxY = Math.max(maxY, node.y)
      }
      // Minimal 380 agar graf kecil tetap tampil mungil, tidak diperbesar memenuhi panel.
      const size = Math.max(380, Math.max(maxX - minX, maxY - minY) + 70)
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const ease = 0.12
      view.w += (size - view.w) * ease
      view.h = view.w
      view.x += (cx - view.w / 2 - view.x) * ease
      view.y += (cy - view.h / 2 - view.y) * ease
      applyView()
      labelDensity()
    }
    for (const node of accountList) {
      node.el.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
      node.edge.setAttribute('x1', '0')
      node.edge.setAttribute('y1', '0')
      node.edge.setAttribute('x2', node.x.toFixed(1))
      node.edge.setAttribute('y2', node.y.toFixed(1))
    }
    for (const node of peopleList) {
      node.el.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
      const anchor = nodes.get(node.customer.accountId) || hub
      node.link.setAttribute('x1', anchor.x.toFixed(1))
      node.link.setAttribute('y1', anchor.y.toFixed(1))
      node.link.setAttribute('x2', node.x.toFixed(1))
      node.link.setAttribute('y2', node.y.toFixed(1))
    }
    if (!reduce.matches && busy.size && now - busyTimer > 520) {
      busyTimer = now
      for (const id of busy) {
        const node = nodes.get(id)
        if (node) pulse(hub, node, 'busy', node.account?.provider)
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
      const cx = mx + (mx / len) * 55
      const cy = my + (my / len) * 55
      arc.path.setAttribute('d', `M${arc.from.x},${arc.from.y} Q${cx},${cy} ${arc.to.x},${arc.to.y}`)
      arc.path.style.opacity = String(Math.min(1, (4000 - age) / 1200))
      return true
    })
    // Diam bila tata letak sudah dingin dan tidak ada animasi: hemat CPU.
    const calm = energy <= ALPHA_MIN && !pulses.length && !arcs.length && !busy.size
    if (!document.hidden && root.offsetParent !== null && !calm) requestAnimationFrame(frame)
    else running = false
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
          render(data.customers)
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
