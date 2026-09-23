;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const images = 'img.message-media, img.wa-contact-avatar, img.wa-room-avatar, img.avatar, .wa-cart-item img, #cartPaymentProof, #mediaPreview, #qrImage, .wa-trace-media img'
  const players = '.message-media-wrap video, .message-media-wrap audio'
  const documents = 'a.message-document'
  const selector = `${images}, ${players}, ${documents}`
  const viewer = document.createElement('dialog')
  viewer.id = 'mediaViewer'
  viewer.className = 'wa-media-viewer'
  viewer.setAttribute('aria-labelledby', 'mediaViewerTitle')
  viewer.innerHTML = `
    <header class="wa-viewer-header">
      <strong id="mediaViewerTitle">Media</strong>
      <div class="wa-viewer-actions">
        <button type="button" id="mediaZoomOut" aria-label="Perkecil gambar" title="Perkecil" data-i18n-aria-label="Perkecil gambar" data-i18n-title="Perkecil">−</button>
        <button type="button" id="mediaZoomReset" aria-label="Sesuaikan gambar dengan layar" title="Sesuaikan layar" data-i18n="Pas" data-i18n-aria-label="Sesuaikan gambar dengan layar" data-i18n-title="Sesuaikan layar">Pas</button>
        <button type="button" id="mediaZoomIn" aria-label="Perbesar gambar" title="Perbesar" data-i18n-aria-label="Perbesar gambar" data-i18n-title="Perbesar">+</button>
        <a id="mediaViewerOpen" target="_blank" rel="noopener noreferrer" aria-label="Buka media di tab baru" title="Buka di tab baru" data-i18n-aria-label="Buka media di tab baru" data-i18n-title="Buka di tab baru">↗</a>
        <a id="mediaViewerDownload" download target="_blank" rel="noopener noreferrer" aria-label="Unduh media" title="Unduh" data-i18n-aria-label="Unduh media" data-i18n-title="Unduh">↓</a>
        <button type="button" id="mediaViewerClose" aria-label="Tutup media" title="Tutup (Esc)" data-i18n-aria-label="Tutup media" data-i18n-title="Tutup (Esc)">×</button>
      </div>
    </header>
    <div id="mediaViewerStage" class="wa-viewer-stage"></div>
    <p id="mediaViewerNotice" class="wa-viewer-notice" role="status" hidden></p>`
  document.body.append(viewer)
  const byId = (id) => document.getElementById(id)
  const stage = byId('mediaViewerStage')
  let origin = null
  let zoom = 1
  let display = null
  let documentUrl = ''
  let documentRequest = null
  function safeUrl(value) {
    if (!value) return ''
    try {
      const url = new URL(value, location.href)
      return ['http:', 'https:', 'blob:'].includes(url.protocol) ||
        /^data:(image\/|video\/|audio\/|application\/pdf[;,])/i.test(value) ? url.href : ''
    } catch { return '' }
  }
  function setZoom(next) {
    const previousBounds = viewer.open && display?.tagName === 'IMG' ? display.getBoundingClientRect() : null
    zoom = Math.max(1, Math.min(4, next))
    stage.classList.toggle('zoomed', zoom > 1)
    if (display?.tagName === 'IMG') {
      display.style.width = zoom === 1 ? '' : `${display.naturalWidth * zoom}px`
    }
    byId('mediaZoomOut').disabled = zoom === 1
    byId('mediaZoomIn').disabled = zoom === 4
    byId('mediaZoomReset').textContent = zoom === 1 ? t('Pas') : `${zoom}×`
    if (previousBounds) window.waMotion?.resize(display, previousBounds)
  }
  function open(source) {
    const url = safeUrl(source.dataset.fullMediaUrl || source.currentSrc || source.src || source.href)
    if (!url) return
    origin = source
    const kind = source.dataset.fullMediaType || source.tagName.toLowerCase()
    const title = source.alt || source.getAttribute('download') ||
      (kind === 'a' ? source.textContent.trim().replace(/\s*↓$/, '') : '') ||
      ({ video: 'Video', gif: 'GIF', audio: 'Audio' }[kind] || t('Gambar'))
    byId('mediaViewerTitle').textContent = title
    byId('mediaViewerOpen').href = url
    byId('mediaViewerDownload').href = url
    byId('mediaViewerDownload').download = source.getAttribute('download') || ''
    byId('mediaViewerNotice').hidden = true
    stage.replaceChildren()
    const image = ['img', 'image', 'sticker'].includes(kind)
    for (const id of ['mediaZoomIn', 'mediaZoomOut', 'mediaZoomReset']) byId(id).hidden = !image
    if (image) {
      display = document.createElement('img')
      display.alt = title
      display.referrerPolicy = 'no-referrer'
    } else if (['video', 'gif', 'audio'].includes(kind)) {
      display = document.createElement(kind === 'audio' ? 'audio' : 'video')
      display.controls = true
      display.playsInline = true
      display.preload = 'metadata'
      display.loop = source.loop || kind === 'gif'
      display.muted = source.muted || kind === 'gif'
      if (source.poster) display.poster = source.poster
      if (source.pause) {
        const time = source.currentTime
        source.pause()
        display.addEventListener('loadedmetadata', () => {
          if (Number.isFinite(time)) display.currentTime = time
        }, { once: true })
      }
    } else {
      // Only PDFs are embedded. Other document types open in their own application/tab.
      if (/\.pdf(?:$|[?#])/i.test(url) || /\.pdf$/i.test(title)) {
        display = document.createElement('iframe')
        display.title = title
        display.setAttribute('sandbox', 'allow-same-origin')
        display.referrerPolicy = 'no-referrer'
      } else {
        display = document.createElement('p')
        display.textContent = t('Buka di tab baru atau unduh untuk melihat dokumen ini.')
      }
    }
    display.addEventListener('error', () => {
      byId('mediaViewerNotice').textContent = t('Media belum bisa ditampilkan. Coba buka di tab baru atau unduh.')
      byId('mediaViewerNotice').hidden = false
    })
    if (display.tagName === 'IFRAME') {
      const frame = display
      documentRequest = new AbortController()
      // Fetching a PDF as a blob also supports protected downloads served with
      // Content-Disposition: attachment, without changing the download endpoint.
      fetch(url, { signal: documentRequest.signal, credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) throw new Error('PDF unavailable')
          const blob = await response.blob()
          if (!(await blob.slice(0, 1024).text()).includes('%PDF-')) throw new Error('Invalid PDF')
          if (display !== frame || !viewer.open) return
          documentUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
          frame.src = documentUrl
        })
        .catch((error) => {
          if (error.name === 'AbortError' || display !== frame) return
          byId('mediaViewerNotice').textContent = t('Pratinjau PDF belum tersedia. Buka di tab baru atau unduh.')
          byId('mediaViewerNotice').hidden = false
        })
    } else if (display.tagName !== 'P') display.src = url
    stage.append(display)
    setZoom(1)
    if (window.waMotion) window.waMotion.showDialog(viewer)
    else viewer.showModal()
    byId('mediaViewerClose').focus()
    if (display.play) void display.play().catch(() => {})
  }
  function decorate(root) {
    if (!(root instanceof Element) || root.closest('#mediaViewer')) return
    const media = [...root.querySelectorAll(selector)]
    if (root.matches(selector)) media.unshift(root)
    for (const source of media) {
      if (source.matches(players)) {
        if (source.nextElementSibling?.hasAttribute('data-media-expand')) continue
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'wa-media-expand'
        button.dataset.mediaExpand = ''
        button.textContent = '⛶'
        button.title = t('Buka media ukuran besar')
        button.setAttribute('aria-label', t('Buka media ukuran besar'))
        button.setAttribute('aria-haspopup', 'dialog')
        source.after(button)
      } else {
        source.dataset.mediaView = ''
        source.setAttribute('aria-haspopup', 'dialog')
        if (source.tagName === 'IMG') {
          source.tabIndex = 0
          source.setAttribute('role', 'button')
          source.setAttribute('aria-label', t("Perbesar {0}", source.alt || 'gambar'))
          source.title = t('Klik untuk memperbesar')
        }
      }
    }
  }
  // Capture prevents a profile photo from navigating into its room and a receipt
  // link from leaving the current payment dialog.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-media-expand]')
    const source = button?.previousElementSibling || event.target.closest('[data-media-view]')
    if (!source || source.closest('#mediaViewer')) return
    event.preventDefault()
    event.stopPropagation()
    open(source)
  }, true)
  document.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key) || !event.target.matches('img[data-media-view]')) return
    event.preventDefault()
    event.stopPropagation()
    open(event.target)
  }, true)
  byId('mediaZoomIn').addEventListener('click', () => setZoom(zoom + 1))
  byId('mediaZoomOut').addEventListener('click', () => setZoom(zoom - 1))
  byId('mediaZoomReset').addEventListener('click', () => setZoom(1))
  function closeViewer() {
    if (window.waMotion) window.waMotion.closeDialog(viewer)
    else viewer.close()
  }
  byId('mediaViewerClose').addEventListener('click', closeViewer)
  viewer.addEventListener('cancel', (event) => {
    if (!window.waMotion) return
    event.preventDefault()
    closeViewer()
  })
  viewer.addEventListener('close', () => {
    documentRequest?.abort()
    documentRequest = null
    if (documentUrl) URL.revokeObjectURL(documentUrl)
    documentUrl = ''
    if (display?.pause) {
      display.pause()
      if (origin?.isConnected && origin.pause && Number.isFinite(display.currentTime))
        origin.currentTime = display.currentTime
      display.removeAttribute('src')
      display.load()
    }
    stage.replaceChildren()
    display = null
    if (origin?.isConnected) origin.focus({ preventScroll: true })
    origin = null
  })
  decorate(document.body)
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) decorate(node)
  }).observe(document.body, { childList: true, subtree: true })
})()
