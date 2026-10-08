// v3.6.70 — Penanda memuat bergaya Wireframe: bentuk kawat 3D (sphere, spiral, core, rings) yang
// berputar selama ada proses. Satu loop requestAnimationFrame untuk semua penanda yang terlihat.
// Ukuran kecil (< 32px) memakai bentuk sederhana, garis lebih tebal dan putaran lebih cepat agar
// tetap jelas. Minimal 20px. prefers-reduced-motion → bentuk diam.
//   <svg class="wa-wf" data-shape="sphere|spiral|core|rings" data-size="20"></svg>  (otomatis)
//   window.waLoader.make('spiral', 36) → SVGElement
//   Setiap .wa-loading otomatis mendapat sphere (inline: 20px, blok: 56px).
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const CAM = 3.4
  const SCALE = 82
  const C = 100
  const MIN = 20
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const circ = (r, cx, cy, cz, plane, seg) => {
    const pts = []
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2
      const c = Math.cos(a) * r
      const s = Math.sin(a) * r
      pts.push(plane === 'xy' ? [cx + c, cy + s, cz] : plane === 'xz' ? [cx + c, cy, cz + s] : [cx, cy + c, cz + s])
    }
    return pts
  }
  const ring = (n, r, y, ph) => {
    const pts = []
    for (let i = 0; i <= n; i++) {
      const a = ph + (i / n) * Math.PI * 2
      pts.push([Math.cos(a) * r, y, Math.sin(a) * r])
    }
    return pts
  }
  const rotX = (p, a) => p.map(([x, y, z]) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)])
  const rotY = (p, a) => p.map(([x, y, z]) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)])
  const rotZ = (p, a) => p.map(([x, y, z]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z])
  const spiralPts = (turns, n) => {
    const pts = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = t * turns * Math.PI * 2
      const r = 0.15 + 0.75 * t
      pts.push([Math.cos(a) * r, -1 + 2 * t, Math.sin(a) * r])
    }
    return pts
  }
  const norm = (lines) => {
    let far = 0
    for (const line of lines) for (const [x, y, z] of line) far = Math.max(far, Math.hypot(x, y, z))
    return lines.map((line) => line.map(([x, y, z]) => [x / far, y / far, z / far]))
  }

  const SHAPES = {
    sphere: () => norm([
      ...[-0.55, 0, 0.55].map((y) => circ(Math.sqrt(1 - y * y), 0, y, 0, 'xz', 48)),
      ...[0, Math.PI / 3, (2 * Math.PI) / 3].map((a) => rotY(circ(1, 0, 0, 0, 'xy', 48), a)),
      rotZ(rotX(circ(1.3, 0, 0, 0, 'xz', 64), 0.9), 0.3),
      rotZ(rotX(circ(1.3, 0, 0, 0, 'xz', 64), -0.7), -0.5),
    ]),
    'sphere-lite': () => norm([
      circ(1, 0, 0, 0, 'xz', 40),
      circ(1, 0, 0, 0, 'xy', 40),
      rotY(circ(1, 0, 0, 0, 'xy', 40), Math.PI / 2),
    ]),
    spiral: () => norm([spiralPts(3.5, 140), circ(0.9, 0, 1, 0, 'xz', 56)]),
    'spiral-lite': () => norm([spiralPts(2.5, 90), circ(0.9, 0, 1, 0, 'xz', 40)]),
    rings: () => norm([
      ...[0, 1, 2, 3].map((k) => rotY(circ(0.5, 0.5, 0, 0, 'xy', 40), (k * Math.PI) / 2)),
      circ(1, 0, 0, 0, 'xz', 64),
    ]),
    'rings-lite': () => norm([0, 1, 2].map((k) => rotY(circ(0.5, 0.5, 0, 0, 'xy', 32), (k * 2 * Math.PI) / 3))),
    core: () => {
      const top = ring(7, 1, -0.75, 0)
      const bot = ring(7, 1, 0.75, 0)
      const base = ring(4, 0.6, 0.45, Math.PI / 4)
      const apex = [0, -0.55, 0]
      return norm([top, bot, ...top.slice(0, 7).map((p, i) => [p, bot[i]]), base, ...base.slice(0, 4).map((p) => [p, apex])])
    },
    'core-lite': () => {
      const top = ring(5, 1, -0.75, 0)
      const bot = ring(5, 1, 0.75, 0)
      const base = ring(4, 0.6, 0.45, Math.PI / 4)
      const apex = [0, -0.55, 0]
      return norm([top, bot, ...top.slice(0, 5).map((p, i) => [p, bot[i]]), base, ...base.slice(0, 4).map((p) => [p, apex])])
    },
  }
  const cache = new Map()
  const geometry = (name) => {
    if (!cache.has(name)) cache.set(name, (SHAPES[name] || SHAPES.sphere)())
    return cache.get(name)
  }

  const live = new Set()
  function project(item, time) {
    const { lines, paths, speed, phase, minOpacity } = item
    const yaw = phase + time * speed
    const pitch = item.pitch
    const tilt = Math.sin(time * 0.7 + phase) * 0.06
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), ct = Math.cos(tilt), st = Math.sin(tilt)
    lines.forEach((line, index) => {
      let depth = 0
      let d = ''
      line.forEach(([x, y, z], i) => {
        const x1 = x * cy + z * sy
        const z1 = -x * sy + z * cy
        const y2 = y * cp - z1 * sp
        const z2 = y * sp + z1 * cp
        const x3 = x1 * ct - y2 * st
        const y3 = x1 * st + y2 * ct
        const f = CAM / (CAM + z2)
        d += `${i ? 'L' : 'M'}${(C + x3 * SCALE * f).toFixed(1)} ${(C + y3 * SCALE * f).toFixed(1)}`
        depth += z2
      })
      paths[index].setAttribute('d', d)
      paths[index].style.opacity = String(Math.max(minOpacity, Math.min(1, 0.72 - (depth / line.length) * 0.38)).toFixed(2))
    })
  }

  let frame = 0
  let last = 0
  function tick(now) {
    frame = 0
    if (now - last >= 33) {
      last = now
      const time = now / 1000
      for (const item of live) {
        if (!item.svg.isConnected) {
          live.delete(item)
          continue
        }
        if (!item.svg.getClientRects().length) continue
        project(item, time)
      }
    }
    if (live.size && !reduce) frame = requestAnimationFrame(tick)
  }
  const wake = () => {
    if (!frame && live.size && !reduce) frame = requestAnimationFrame(tick)
  }

  function mount(svg) {
    if (!svg || svg.dataset.wfMounted) return svg
    svg.dataset.wfMounted = '1'
    const size = Math.max(MIN, Number(svg.dataset.size) || svg.getBoundingClientRect().width || 24)
    const base = svg.dataset.shape || 'sphere'
    const small = size < 32
    const name = small && SHAPES[`${base}-lite`] ? `${base}-lite` : base
    svg.setAttribute('viewBox', '0 0 200 200')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    svg.classList.add('wa-wf')
    if (small) svg.classList.add('is-small')
    svg.style.width = svg.style.width || `${size}px`
    svg.style.height = svg.style.height || `${size}px`
    const lines = geometry(name)
    const paths = lines.map(() => {
      const path = document.createElementNS(NS, 'path')
      svg.append(path)
      return path
    })
    const item = {
      svg,
      lines,
      paths,
      speed: base === 'spiral' ? (small ? 2.6 : 2.2) : small ? 2.4 : 1.1,
      phase: Math.random() * Math.PI * 2,
      minOpacity: small ? 0.55 : 0.32,
      pitch: base === 'spiral' ? -0.28 : base === 'rings' ? -0.55 : -0.42,
    }
    project(item, performance.now() / 1000)
    live.add(item)
    wake()
    return svg
  }

  function make(shape = 'sphere', size = 24) {
    const svg = document.createElementNS(NS, 'svg')
    svg.dataset.shape = shape
    svg.dataset.size = String(Math.max(MIN, size))
    return mount(svg)
  }

  // .wa-loading (dipakai di banyak halaman): sphere di depan teksnya.
  function decorate(node) {
    if (!(node instanceof Element)) return
    const targets = node.matches?.('.wa-loading, svg.wa-wf[data-shape]') ? [node] : []
    targets.push(...node.querySelectorAll?.('.wa-loading, svg.wa-wf[data-shape]') || [])
    for (const target of targets) {
      if (target.matches('svg')) mount(target)
      else if (!target.querySelector(':scope > .wa-wf')) {
        const inline = target.classList.contains('inline') || target.closest('button')
        target.prepend(make(inline ? 'rings' : 'sphere', inline ? 20 : 56))
      }
    }
  }

  window.waLoader = { make, mount, decorate }
  const start = () => {
    decorate(document.body)
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) decorate(node)
    }).observe(document.body, { childList: true, subtree: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
