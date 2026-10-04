// Ikon gelombang 3D kawat (gaya Wireframe) untuk "momen": login, keadaan kosong, selesai.
// Dipasang ke setiap <svg class="wire-icon" viewBox="0 0 200 200"> yang ada, dan ke yang
// ditambahkan belakangan lewat window.waWire.mount(svg). Permukaan sinus sebagai polyline,
// proyeksi perspektif manual, berputar pelan; lebih cepat & mengikuti pointer saat hover/focus.
;(() => {
  const CAM = 3.4
  const SCALE = 70
  const C = 100
  const N = 22
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const wave = (x, z, phase) => 0.22 * Math.sin(x * 2.6 + phase) * Math.cos(z * 1.8) + 0.08 * Math.sin((x + z) * 4 + phase)

  const mount = (svg) => {
    if (!svg || svg.dataset.wireMounted) return
    svg.dataset.wireMounted = '1'
    const lines = []
    const build = (phase) => {
      lines.length = 0
      for (let zi = 0; zi < 7; zi++) {
        const z = -1 + (zi / 6) * 2
        const pts = []
        for (let i = 0; i <= N; i++) {
          const x = -1 + (i / N) * 2
          pts.push([x, wave(x, z, phase), z])
        }
        lines.push(pts)
      }
      for (let xi = 0; xi < 5; xi++) {
        const x = -1 + (xi / 4) * 2
        const pts = []
        for (let i = 0; i <= N; i++) {
          const z = -1 + (i / N) * 2
          pts.push([x, wave(x, z, phase), z])
        }
        lines.push(pts)
      }
      let far = 0
      for (const pts of lines) for (const [x, y, z] of pts) far = Math.max(far, Math.hypot(x, y, z))
      for (const pts of lines) for (const p of pts) { p[0] /= far; p[1] /= far; p[2] /= far }
    }
    build(0)
    const paths = lines.map(() => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      svg.append(path)
      return path
    })

    let yaw = Math.random() * Math.PI * 2
    let pitch = -0.42
    let tilt = 0
    let targetPitch = pitch
    let targetTilt = 0
    let speed = 0.28
    let targetSpeed = speed
    let phase = 0
    let last = performance.now()
    let running = false

    const project = ([x, y, z]) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw)
      const x1 = x * cy + z * sy
      const z1 = -x * sy + z * cy
      const cp = Math.cos(pitch), sp = Math.sin(pitch)
      const y2 = y * cp - z1 * sp
      const z2 = y * sp + z1 * cp
      const ct = Math.cos(tilt), st = Math.sin(tilt)
      const x3 = x1 * ct - y2 * st
      const y3 = x1 * st + y2 * ct
      const f = CAM / (CAM + z2)
      return [C + x3 * SCALE * f, C + y3 * SCALE * f, z2]
    }
    const draw = () => {
      lines.forEach((pts, index) => {
        let d = ''
        let depth = 0
        pts.forEach((p, i) => {
          const [sx, sy, z] = project(p)
          depth += z
          d += `${i ? 'L' : 'M'}${sx.toFixed(1)} ${sy.toFixed(1)}`
        })
        paths[index].setAttribute('d', d)
        paths[index].style.opacity = String(Math.max(0.28, Math.min(1, 0.72 - (depth / pts.length) * 0.38)))
      })
    }
    const frame = (now) => {
      if (!svg.isConnected || document.hidden) { running = false; return }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const ease = 1 - Math.pow(0.002, dt)
      speed += (targetSpeed - speed) * ease
      pitch += (targetPitch - pitch) * ease
      tilt += (targetTilt - tilt) * ease
      yaw += speed * dt
      phase += dt * 1.4
      build(phase)
      draw()
      requestAnimationFrame(frame)
    }
    const start = () => {
      if (running || reduce) return
      running = true
      last = performance.now()
      requestAnimationFrame(frame)
    }
    const host = svg.closest('[data-wire-host]') || svg.parentElement || svg
    host.addEventListener('pointermove', (event) => {
      const box = host.getBoundingClientRect()
      const nx = (event.clientX - box.left) / box.width - 0.5
      const ny = (event.clientY - box.top) / box.height - 0.5
      targetPitch = -0.42 + ny * 0.45
      targetTilt = nx * 0.3
      targetSpeed = 1.1
    })
    const rest = () => {
      targetPitch = -0.42
      targetTilt = 0
      targetSpeed = 0.28
    }
    host.addEventListener('pointerleave', rest)
    host.addEventListener('focusin', () => (targetSpeed = 1.1))
    host.addEventListener('focusout', rest)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) start() })
    draw()
    start()
  }

  const mountAll = (root = document) => root.querySelectorAll('svg.wire-icon').forEach(mount)
  window.waWire = { mount, mountAll }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAll())
  else mountAll()
})()
