;(() => {
  // Umpan balik instan saat berpindah halaman/room: bar tipis di atas + kerangka (skeleton) isi.
  const plain = (event, link) =>
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    link &&
    !link.target &&
    !link.hasAttribute('download') &&
    link.origin === location.origin &&
    !(link.pathname === location.pathname && link.search === location.search && link.hash)
  const el = (className, parent) => {
    const node = document.createElement('div')
    node.className = className
    parent?.append(node)
    return node
  }
  function progress() {
    document.querySelector('.wa-progress')?.remove()
    el('wa-progress', document.body)
  }
  // Penanda memuat yang sederhana: putaran kecil + "Memuat…".
  const t = (value) => window.waI18n?.t(value) ?? value
  function spinner(parent) {
    const node = el('wa-loading', parent)
    node.textContent = t('Memuat…')
    return node
  }
  function openingRoom(link) {
    document.querySelectorAll('.wa-contact.active').forEach((row) => row.classList.remove('active'))
    link.classList.add('active')
    const name = link.querySelector('.wa-contact-content strong')?.textContent?.trim() || ''
    const messages = document.getElementById('messageList')
    if (messages && messages.offsetParent !== null) {
      // Komputer: panel chat tetap, isinya diganti penanda memuat sampai room baru tampil.
      messages.replaceChildren()
      spinner(messages)
      const title = document.getElementById('roomName')
      if (name && title) title.textContent = name
    } else {
      // HP: layar room sementara (nama + penanda memuat).
      const overlay = el('wa-skel-overlay', document.body)
      const head = el('wa-skel-overlay-head', overlay)
      el('wa-skel-overlay-title', head).textContent = name
      spinner(overlay)
    }
  }
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]')
    if (!plain(event, link)) return
    // Tunggu handler lain selesai; kalau klik ditangani di halaman (bukan pindah halaman), jangan tampilkan apa pun.
    setTimeout(() => {
      if (event.defaultPrevented) return
      progress()
      if (link.matches('.wa-contact')) openingRoom(link)
    }, 0)
  })
  // Kembali lewat tombol back (bfcache): bersihkan sisa kerangka.
  window.addEventListener('pageshow', () => {
    document.querySelectorAll('.wa-progress, .wa-skel-overlay').forEach((node) => node.remove())
  })

  // Foto di bubble: kerangka berkilau sampai gambarnya selesai dimuat.
  const SELECTOR = 'img.message-media, .wa-igc-thumb'
  const done = (image) => image.classList.add('loaded')
  const watch = (image) => {
    if (image.classList.contains('loaded')) return
    if (image.complete) return done(image)
    image.addEventListener('load', () => done(image), { once: true })
    image.addEventListener('error', () => done(image), { once: true })
  }
  const scan = (root) => {
    if (!(root instanceof Element)) return
    if (root.matches(SELECTOR)) watch(root)
    root.querySelectorAll(SELECTOR).forEach(watch)
  }
  const start = () => {
    scan(document.body)
    new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) scan(node)
    }).observe(document.body, { childList: true, subtree: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
