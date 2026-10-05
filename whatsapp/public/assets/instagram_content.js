;(() => {
  const root = document.getElementById('igContentPage')
  if (!root) return
  const byId = (id) => document.getElementById(id)
  const page = byId('igPage')
  const activeTab = () => page?.dataset.igTab || 'content'
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  async function api(path, method = 'GET', body) {
    const isForm = body instanceof FormData
    const response = await fetch(base + path, {
      method,
      headers: { 'X-CSRF-TOKEN': csrf, ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(t(result.error || 'Permintaan gagal.'))
    return result
  }
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined && text !== null) node.textContent = text
    if (className) node.className = className
    return node
  }
  const notice = (message, error = false) => {
    byId('igpNotice').textContent = message || ''
    byId('igpNotice').classList.toggle('error', Boolean(error))
  }
  const formNotice = (message, error = false) => {
    byId('igpFormNotice').textContent = message || ''
    byId('igpFormNotice').classList.toggle('error', Boolean(error))
  }
  const locale = () => window.waI18n?.locale || 'id-ID'
  const when = (value) =>
    value
      ? new Intl.DateTimeFormat(locale(), {
          timeZone: 'Asia/Jakarta',
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(value))
      : ''
  // ≥ 10 ribu disingkat dengan 1 desimal: 31.1K / 31,1 rb (bukan dibulatkan jadi 31K).
  const num = (value) =>
    new Intl.NumberFormat(
      locale(),
      Number(value) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }
    ).format(Number(value || 0))
  const full = (value) => new Intl.NumberFormat(locale()).format(Number(value || 0))
  const KIND = () => ({ feed: t('Feed'), carousel: t('Carousel'), reels: t('Reels'), story: t('Story') })
  const STATUS = () => ({
    scheduled: [t('Terjadwal'), 'waiting', 'warn'],
    publishing: [t('Sedang diposting'), 'active', 'warn'],
    published: [t('Terbit'), 'success', 'ok'],
    failed: [t('Gagal'), 'danger', 'err'],
    cancelled: [t('Dibatalkan'), '', ''],
  })
  const METRIC = () => ({
    reach: t('Jangkauan'),
    views: t('Tayangan'),
    likes: t('Suka'),
    comments: t('Komentar'),
    saved: t('Simpan'),
    shares: t('Bagikan'),
    replies: t('Balasan'),
    ig_reels_avg_watch_time: t('Rata² tonton'),
    navigation: t('Navigasi'),
    total_interactions: t('Total interaksi'),
    profile_activity: t('Aktivitas profil'),
    profile_visits: t('Kunjungan profil'),
    pa_bio_link_clicked: t('Klik link eksternal'),
    pa_direction: t('Klik alamat bisnis'),
    pa_call: t('Klik telepon'),
    pa_email: t('Klik email'),
    pa_text: t('Klik pesan'),
    follows: t('Pengikut baru'),
  })
  const seconds = (ms) => `${(Number(ms || 0) / 1000).toFixed(1)}s`

  /* ───── Data: jadwal (aplikasi) + postingan & story dari Instagram ───── */
  let posts = []
  let media = []
  let stories = []
  let mediaError = ''
  let refreshing = false
  let nextCursor = ''
  let profileTotal = 0
  let postsLoaded = false
  let mediaLoaded = false
  let filter = 'all'
  // v3.6.11: filter jenis (Semua/Postingan/Reels/Story) & tampilan (daftar/grid), diingat per browser.
  let kindFilter = 'all'
  let view = 'list'
  try {
    view = localStorage.getItem(`${base}:ig-view`) === 'grid' ? 'grid' : 'list'
  } catch {}
  let selectedKey = ''
  const kindOfMedia = (item) =>
    item.product === 'REELS'
      ? 'reels'
      : item.product === 'STORY'
        ? 'story'
        : item.media_type === 'CAROUSEL_ALBUM'
          ? 'carousel'
          : 'feed'
  function buildRows() {
    const byMedia = new Map(posts.filter((post) => post.mediaId).map((post) => [String(post.mediaId), post]))
    const used = new Set()
    const rows = []
    for (const item of [...media, ...stories]) {
      const post = byMedia.get(String(item.id))
      if (post) used.add(post.id)
      rows.push({
        key: `m${item.id}`,
        kind: kindOfMedia(item),
        count: post?.items.length || 0,
        thumb: item.thumbnail_url || item.media_url || post?.items[0]?.url || '',
        video: false,
        // Selalu dari Instagram (file di server dihapus 1 hari setelah terbit).
        // Video/Reels bisa diputar; carousel diambil isinya saat detail dibuka.
        pictures:
          item.media_type === 'VIDEO' && item.media_url
            ? [{ url: item.media_url, poster: item.thumbnail_url || '', type: 'video' }]
            : [{ url: item.media_url || item.thumbnail_url || '', type: 'image' }],
        mediaId: String(item.id),
        carousel: item.media_type === 'CAROUSEL_ALBUM',
        noVideo: item.media_type === 'VIDEO' && !item.media_url,
        caption: item.caption || post?.caption || '',
        time: item.timestamp || post?.publishedAt,
        status: 'published',
        stats: { likes: item.like_count, comments: item.comments_count, ...(item.stats || {}) },
        signals: item.signals || null,
        permalink: item.permalink || post?.permalink || '',
        post,
      })
    }
    for (const post of posts) {
      if (used.has(post.id)) continue
      // Sudah terbit tapi halamannya belum dimuat: muncul nanti saat menggulir (dari data Instagram).
      if (post.status === 'published' && nextCursor && !mediaError) continue
      const first = post.items[0]
      rows.push({
        key: `p${post.id}`,
        kind: post.kind,
        count: post.items.length,
        thumb: first?.url || '',
        video: first?.type === 'video',
        pictures: post.items,
        caption: post.caption || '',
        time: post.status === 'published' ? post.publishedAt || post.scheduledAt : post.scheduledAt,
        status: post.status,
        stats: null,
        permalink: post.permalink || '',
        error: post.error || '',
        post,
      })
    }
    return rows
  }
  const groupOf = (row) =>
    ['scheduled', 'publishing'].includes(row.status) ? 'upcoming' : ['failed', 'cancelled'].includes(row.status) ? 'failed' : 'done'
  const FILTERS = {
    all: () => true,
    scheduled: (row) => groupOf(row) === 'upcoming',
    published: (row) => row.status === 'published' && row.kind !== 'story',
    story: (row) => row.kind === 'story',
    failed: (row) => groupOf(row) === 'failed',
  }
  const KINDS = {
    all: () => true,
    posts: (row) => row.kind === 'feed' || row.kind === 'carousel',
    reels: (row) => row.kind === 'reels',
    story: (row) => row.kind === 'story',
  }
  const stamp = (row) => new Date(row.time || 0).getTime()
  function sorted(rows) {
    const upcoming = rows.filter((row) => groupOf(row) === 'upcoming').sort((a, b) => stamp(a) - stamp(b))
    const rest = (group) => rows.filter((row) => groupOf(row) === group).sort((a, b) => stamp(b) - stamp(a))
    return [...upcoming, ...rest('failed'), ...rest('done')]
  }

  /* ───── Tabel ───── */
  const COLUMNS = 8
  const statCell = (row, key) => {
    // Tombol Perbarui: angka postingan Instagram diambil ulang → tampil memuat di tempatnya.
    if (refreshing && row.key.startsWith('m')) {
      const cell = el('td', undefined, 'wa-order-amount')
      const spin = el('span', '', 'wa-loading inline')
      spin.setAttribute('aria-label', t('Memuat…'))
      cell.append(spin)
      return cell
    }
    const value = row.stats?.[key]
    return el('td', value === undefined || value === null ? '—' : num(value), 'wa-order-amount')
  }
  function thumbOf(row, className) {
    const node = el(row.video ? 'video' : 'img', undefined, className)
    node.addEventListener('error', () => node.classList.add('is-missing'), { once: true })
    if (row.thumb) node.src = row.thumb
    if (row.video) {
      node.muted = true
      node.preload = 'metadata'
    } else {
      node.alt = ''
      node.loading = 'lazy'
    }
    return node
  }
  function render() {
    const all = buildRows()
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([key, test]) => [key, all.filter(test).length]))
    // Hitungan = seluruh postingan di profil, walau baru sebagian yang dimuat (sisanya dimuat saat menggulir).
    if (profileTotal) {
      const unmatched = all.filter((row) => row.key.startsWith('p') && row.status === 'published').length
      const notLoaded = Math.max(0, profileTotal - media.length - unmatched)
      counts.published += notLoaded
      counts.all += notLoaded
    }
    for (const [key, count] of Object.entries(counts)) {
      const badge = byId('igpTabs').querySelector(`[data-count="${key}"]`)
      if (badge) badge.textContent = count ? num(count) : ''
    }
    const query = byId('igpSearch').value.trim().toLowerCase()
    const rows = sorted(
      all.filter(FILTERS[filter]).filter(KINDS[kindFilter]).filter((row) => !query || row.caption.toLowerCase().includes(query))
    )
    byId('igpTableWrap').hidden = view === 'grid'
    byId('igpGrid').hidden = view !== 'grid'
    if (view === 'grid') return renderGrid(rows)
    const list = byId('igpList')
    list.replaceChildren()
    const loadingRow = () => {
      const tr = el('tr')
      const cell = el('td')
      cell.colSpan = COLUMNS
      cell.append(el('div', t('Memuat…'), 'wa-loading'))
      tr.append(cell)
      return tr
    }
    // Data belum lengkap: tampilkan penanda memuat, bukan "tidak ada postingan".
    // Muat bertahap hanya untuk tab yang isinya postingan profil (Semua, Terbit).
    // Story datang bersama data pertama; Terjadwal/Gagal dari aplikasi sendiri.
    const pageable = filter === 'all' || filter === 'published'
    const needsMedia = pageable || filter === 'story'
    byId('igpMoreButton').hidden = !pageable || !nextCursor || moreLoading || !mediaLoaded
    if (!rows.length && !(postsLoaded && (mediaLoaded || !needsMedia))) {
      list.append(loadingRow())
      return
    }
    if (!rows.length) {
      const tr = el('tr')
      const cell = el('td', mediaError ? t(mediaError) : t('Tidak ada postingan.'), 'wa-order-empty')
      cell.colSpan = COLUMNS
      tr.append(cell)
      list.append(tr)
      return
    }
    let last = 'upcoming'
    for (const row of rows) {
      const group = groupOf(row)
      if (filter === 'all' && group !== last) {
        last = group
        const divider = el('tr', undefined, 'wa-order-group')
        const cell = el('th', `${group === 'failed' ? t('Gagal / dibatalkan') : t('Sudah terbit')} · ${rows.filter((item) => groupOf(item) === group).length}`)
        cell.colSpan = COLUMNS
        cell.scope = 'rowgroup'
        divider.append(cell)
        list.append(divider)
      }
      const tr = el('tr')
      tr.dataset.orderId = row.key
      tr.dataset.selected = String(row.key === selectedKey)
      tr.tabIndex = 0
      const head = el('td')
      const box = el('div', undefined, 'wa-igp-cell')
      const text = el('div', undefined, 'wa-igp-cell-text')
      text.append(
        el('span', `${KIND()[row.kind] || row.kind}${row.count > 1 ? ` · ${row.count}` : ''}`, 'wa-igp-kind'),
        el('small', row.caption ? row.caption.replace(/\s+/g, ' ') : row.kind === 'story' ? '' : t('Tanpa caption'), 'wa-muted')
      )
      box.append(thumbOf(row, 'wa-igp-thumb'), text)
      head.append(box)
      const time = el('td', when(row.time), 'wa-igp-time')
      const state = el('td')
      const [label, tone] = STATUS()[row.status] || [row.status, '']
      const badge = el('span', label, 'wa-order-badge')
      badge.dataset.tone = tone
      state.append(badge)
      // Tanya = komentar yang bertanya (minat beli); hijau bila ada penanya yang order.
      const ask = el('td', row.signals ? num(row.signals.questions) : '—', 'wa-order-amount')
      if (row.signals?.orders) {
        ask.classList.add('wa-igp-ask-order')
        ask.title = t('{0} penanya sudah order', row.signals.orders)
      }
      tr.append(head, time, statCell(row, 'reach'), statCell(row, 'views'), statCell(row, 'likes'), statCell(row, 'comments'), ask, state)
      const open = () => openDetail(row)
      tr.addEventListener('click', open)
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
      list.append(tr)
    }
    if ((needsMedia && !mediaLoaded) || (pageable && moreLoading)) list.append(loadingRow())
  }
  byId('igpTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]')
    if (!button) return
    filter = button.dataset.filter
    byId('igpTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    render()
    continueMore()
  })
  byId('igpKinds').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-kind]')
    if (!button) return
    kindFilter = button.dataset.kind
    byId('igpKinds').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    render()
    continueMore()
  })
  byId('igpView').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]')
    if (!button) return
    view = button.dataset.view
    try {
      localStorage.setItem(`${base}:ig-view`, view)
    } catch {}
    byId('igpView').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    render()
    continueMore()
  })
  byId('igpView').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)))

  /* ───── Grid ala Instagram: ubin 3 kolom, angka suka · komentar · bagikan · simpan di bawah ───── */
  const ICON = {
    heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
    comment: 'M4 5h16v11h-9l-5 4V5Z',
    share: 'M21 3 3 10l8 2 2 8 8-17Z',
    save: 'M6 3h12v18l-6-4-6 4V3Z',
    play: 'M8 5l11 7-11 7z',
    layers: 'M8 4h12v12M4 8h12v12H4z',
  }
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', ICON[name])
    svg.append(path)
    return svg
  }
  function renderGrid(rows) {
    const grid = byId('igpGrid')
    grid.replaceChildren()
    const pageable = filter === 'all' || filter === 'published'
    const needsMedia = pageable || filter === 'story'
    byId('igpMoreButton').hidden = !pageable || !nextCursor || moreLoading || !mediaLoaded
    const skeleton = () => {
      for (let i = 0; i < 6; i++) grid.append(el('div', undefined, 'wa-igp-tile-card is-skeleton'))
    }
    if (!rows.length && !(postsLoaded && (mediaLoaded || !needsMedia))) return skeleton()
    if (!rows.length) return grid.append(el('div', mediaError ? t(mediaError) : t('Tidak ada postingan.'), 'wa-order-empty'))
    for (const row of rows) {
      const card = el('button', undefined, 'wa-igp-tile-card')
      card.type = 'button'
      card.setAttribute('role', 'listitem')
      card.dataset.orderId = row.key
      card.dataset.selected = String(row.key === selectedKey)
      card.dataset.kind = row.kind
      card.dataset.status = row.status
      card.title = row.caption ? row.caption.replace(/\s+/g, ' ').slice(0, 160) : ''
      card.append(thumbOf(row, 'wa-igp-tile-img'))
      // SVG: className hanya-baca → pakai atribut class.
      const typeIcon = row.kind === 'reels' || row.video ? 'play' : row.kind === 'carousel' || row.count > 1 ? 'layers' : ''
      if (typeIcon) {
        const mark = icon(typeIcon)
        mark.setAttribute('class', 'wa-igp-tile-type')
        card.append(mark)
      }
      if (row.status === 'published') {
        const bar = el('span', undefined, 'wa-igp-tile-stats')
        const labels = { likes: t('Suka'), comments: t('Komentar'), shares: t('Bagikan'), saved: t('Simpan') }
        for (const [key, name] of [['likes', 'heart'], ['comments', 'comment'], ['shares', 'share'], ['saved', 'save']]) {
          const stat = el('span', undefined, 'wa-igp-tile-stat')
          stat.title = labels[key]
          const value = row.stats?.[key]
          stat.append(icon(name), el('b', refreshing && row.key.startsWith('m') ? '…' : value === undefined || value === null ? '—' : num(value)))
          bar.append(stat)
        }
        card.append(bar)
      } else {
        const [label, tone] = STATUS()[row.status] || [row.status, '']
        const tag = el('span', `${label} · ${when(row.time)}`, 'wa-igp-tile-label')
        tag.dataset.tone = tone
        card.append(tag)
      }
      card.addEventListener('click', () => openDetail(row))
      grid.append(card)
    }
    if ((needsMedia && !mediaLoaded) || (pageable && moreLoading)) skeleton()
  }
  byId('igpSearch').addEventListener('input', render)

  /* ───── Muat data ───── */
  let postsTimer
  let lastStatuses = ''
  async function loadPosts() {
    clearTimeout(postsTimer)
    try {
      posts = (await api('/api/instagram/posts')).posts || []
      postsLoaded = true
      render()
      const statuses = posts.map((post) => `${post.id}:${post.status}`).join(',')
      if (lastStatuses && statuses !== lastStatuses && posts.some((post) => post.status === 'published')) loadMedia()
      lastStatuses = statuses
      const soon = posts.some(
        (post) =>
          post.status === 'publishing' ||
          (post.status === 'scheduled' && new Date(post.scheduledAt).getTime() - Date.now() < 120_000)
      )
      if (soon) postsTimer = setTimeout(loadPosts, 8000)
    } catch (error) {
      postsLoaded = true
      render()
      notice(error.message, true)
    }
  }
  let moreLoading = false
  async function loadMedia(fresh = false) {
    if (fresh) {
      refreshing = true
      render()
    }
    try {
      const data = await api(`/api/instagram/performance${fresh ? '?fresh=1' : ''}`)
      // Halaman pertama diganti, halaman lama yang sudah dimuat (gulir) tetap dipertahankan.
      const incoming = data.posts || []
      const ids = new Set(incoming.map((item) => String(item.id)))
      media = incoming.concat(media.filter((item) => !ids.has(String(item.id))))
      stories = data.stories || []
      mediaError = data.error || ''
      nextCursor = data.next || ''
      profileTotal = Number(data.total) || 0
    } catch (error) {
      notice(error.message, true)
    } finally {
      mediaLoaded = true
      refreshing = false
      render()
      continueMore()
    }
  }
  // Postingan lama dari profil: 24 per halaman, dimuat otomatis saat menggulir ke bawah.
  async function loadMore() {
    if (!nextCursor || moreLoading || !mediaLoaded || !['all', 'published'].includes(filter)) return
    moreLoading = true
    render()
    try {
      const data = await api(`/api/instagram/performance?after=${encodeURIComponent(nextCursor)}`)
      const known = new Set(media.map((item) => String(item.id)))
      media = media.concat((data.posts || []).filter((item) => !known.has(String(item.id))))
      nextCursor = data.next || ''
      if (data.error) notice(t(data.error), true)
    } catch (error) {
      notice(error.message, true)
    } finally {
      moreLoading = false
      render()
      continueMore()
    }
  }
  byId('igpMoreButton').addEventListener('click', loadMore)
  // Bawah tabel terlihat → muat halaman berikutnya (diulang selama masih terlihat).
  let moreVisible = false
  if ('IntersectionObserver' in window)
    new IntersectionObserver(
      (entries) => {
        moreVisible = entries.some((entry) => entry.isIntersecting)
        if (moreVisible) loadMore()
      },
      { rootMargin: '400px' }
    ).observe(byId('igpMore'))
  const continueMore = () => window.setTimeout(() => moreVisible && loadMore(), 300)
  async function loadState() {
    try {
      const state = await api('/api/instagram/content')
      byId('igpAccount').textContent = state.connected ? `@${state.username}` : t('Instagram belum terhubung')
      byId('igpReconnect').hidden = !state.connected || state.ready
    } catch {}
  }
  byId('igpRefresh').addEventListener('click', () => {
    notice('')
    loadPosts()
    loadMedia(true)
  })
  // Angka performa disegarkan sendiri tiap menit selama halaman terlihat (server mengambil ulang yang sudah usang).
  window.setInterval(() => {
    if (document.hidden || activeTab() !== 'content' || refreshing || moreLoading || drawer.open) return
    loadMedia()
  }, 60_000)

  /* ───── Dialog kanan: detail, form, ringkasan ───── */
  const drawer = byId('igpDrawer')
  let mode = ''
  let returnFocus = null
  function showDrawer(next, title) {
    mode = next
    byId('igpDrawerTitle').textContent = title
    byId('igpDetail').hidden = next !== 'detail'
    byId('igpForm').hidden = next !== 'form'
    if (!drawer.open) {
      returnFocus = document.activeElement
      if (window.waMotion) window.waMotion.showDialog(drawer)
      else drawer.showModal()
    }
    byId('igpDrawerClose').focus()
  }
  function closeDrawer(force = false) {
    if (!force && mode === 'form' && dirty() && !window.confirm(t('Buang perubahan?'))) return
    if (window.waMotion) window.waMotion.closeDialog(drawer)
    else drawer.close()
    mode = ''
    selectedKey = ''
    byId('igpList').querySelectorAll('[data-order-id]').forEach((row) => (row.dataset.selected = 'false'))
    try {
      returnFocus?.focus?.()
    } catch {}
  }
  byId('igpDrawerClose').addEventListener('click', () => closeDrawer())
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) closeDrawer()
  })
  drawer.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeDrawer()
  })

  /* Detail postingan */
  const section = (title) => {
    const node = el('section', undefined, 'wa-b3-section')
    node.append(el('h3', title))
    return node
  }
  /* Galeri detail: semua foto/video bisa dilihat; video diputar langsung, foto dibuka besar saat diklik. */
  function fillGallery(gallery, items) {
    gallery.replaceChildren(
      ...items
        .filter((item) => item.url)
        .map((item, index, all) => {
          const figure = el('figure')
          const node = el(item.type === 'video' ? 'video' : 'img')
          node.src = item.url
          if (item.type === 'video') {
            node.controls = true
            node.playsInline = true
            node.preload = 'metadata'
            if (item.poster) node.poster = item.poster
          } else {
            node.alt = all.length > 1 ? t('Slide {0}', index + 1) : ''
            node.loading = 'lazy'
          }
          figure.append(node)
          if (all.length > 1) figure.append(el('figcaption', `${index + 1}/${all.length}`))
          return figure
        })
    )
  }
  const childrenCache = new Map()
  async function loadChildren(row, gallery) {
    const loading = el('figure', undefined, 'wa-igp-gallery-loading')
    loading.append(el('div', t('Memuat…'), 'wa-loading'))
    gallery.append(loading)
    try {
      if (!childrenCache.has(row.mediaId))
        childrenCache.set(row.mediaId, (await api(`/api/instagram/media/${encodeURIComponent(row.mediaId)}/children`)).items || [])
      const items = childrenCache.get(row.mediaId)
      if (selectedKey === row.key && items.length)
        fillGallery(gallery, items.map((item) => ({ url: item.url, poster: item.thumb, type: item.type })))
      else loading.remove()
    } catch {
      loading.remove()
    }
  }
  /* Performa satu postingan: 4 angka utama besar, rincian interaksi sebagai batang, sisanya chip kecil. */
  function chips(pairs) {
    const list = el('div', undefined, 'wa-igp-chips')
    for (const [label, value] of pairs) {
      const chip = el('span', undefined, `wa-igp-chip${Number(value) ? '' : ' zero'}`)
      chip.append(el('span', label), el('b', typeof value === 'string' ? value : num(value)))
      list.append(chip)
    }
    return list
  }
  function statsBlocks(st) {
    const has = (key) => st[key] !== undefined && st[key] !== null
    const blocks = []
    const tiles = el('div', undefined, 'wa-igp-stats-grid wa-igp-post-stats')
    const tile = (label, value, extra = '', exact) => {
      const node = el('div', undefined, 'wa-igp-stat')
      const strong = el('strong', value)
      if (exact !== undefined) strong.title = full(exact)
      node.append(el('small', label), strong)
      if (extra) node.append(el('span', extra, 'wa-muted'))
      tiles.append(node)
    }
    if (has('views')) tile(t('Tayangan'), num(st.views), '', st.views)
    if (has('reach')) tile(t('Jangkauan'), num(st.reach), '', st.reach)
    if (has('total_interactions'))
      tile(
        t('Interaksi'),
        num(st.total_interactions),
        Number(st.reach) > 0 ? t('{0}% dari jangkauan', new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format((Number(st.total_interactions) / Number(st.reach)) * 100)) : '',
        st.total_interactions
      )
    const fourth = has('ig_reels_avg_watch_time') ? 'ig_reels_avg_watch_time' : has('profile_visits') ? 'profile_visits' : ''
    if (fourth === 'ig_reels_avg_watch_time') tile(t('Rata² tonton'), seconds(st.ig_reels_avg_watch_time))
    else if (fourth) tile(t('Kunjungan profil'), num(st.profile_visits), '', st.profile_visits)
    if (tiles.childElementCount) {
      const perf = section(t('Performa'))
      perf.append(tiles)
      blocks.push(perf)
    }
    // Rincian interaksi: batang sebanding supaya langsung terlihat mana yang paling banyak.
    const parts = ['likes', 'comments', 'saved', 'shares', 'replies'].filter(has)
    if (parts.length) {
      const max = Math.max(1, ...parts.map((key) => Number(st[key] || 0)))
      const list = el('div', undefined, 'wa-igp-split')
      for (const key of parts) {
        const line = el('div', undefined, `wa-igp-line${Number(st[key]) ? '' : ' zero'}`)
        const fill = el('i')
        fill.style.width = `${Math.round((Number(st[key] || 0) / max) * 100)}%`
        line.append(el('span', METRIC()[key]), el('b', num(st[key])), fill)
        list.append(line)
      }
      const group = section(t('Rincian interaksi'))
      group.append(list)
      blocks.push(group)
    }
    // Aktivitas profil yang tidak muncul berarti 0 (seperti di Instagram), khusus link & alamat.
    const value = (key) =>
      has(key) ? st[key] : ['pa_bio_link_clicked', 'pa_direction'].includes(key) && has('profile_activity') ? 0 : undefined
    const others = [
      ...(fourth === 'profile_visits' ? [] : ['profile_visits']),
      'profile_activity',
      'pa_bio_link_clicked',
      'pa_direction',
      'pa_call',
      'pa_email',
      'pa_text',
      'follows',
      'navigation',
    ]
      .filter((key) => value(key) !== undefined)
      .map((key) => [METRIC()[key] || key, value(key)])
    if (others.length) {
      const group = section(t('Profil & lainnya'))
      group.append(chips(others))
      blocks.push(group)
    }
    if (!blocks.length) {
      const perf = section(t('Performa'))
      perf.append(el('p', t('Belum ada data performa.'), 'wa-muted'))
      blocks.push(perf)
    }
    return blocks
  }

  /** Komentar postingan ini (terbaru), dengan tautan ke tab Komentar. */
  const COMMENT_STATUS = () => ({
    replied: t('Dibalas lewat DM'),
    cs: t('Perlu CS'),
    skipped: t('Belum dibalas'),
    failed: t('Gagal'),
    pending: t('Diproses AI'),
    processing: t('Diproses AI'),
    ignored: t('Bukan pertanyaan'),
  })
  function commentsSection(row) {
    const box = section(t('Komentar'))
    const list = el('div', undefined, 'wa-igp-comments')
    list.append(el('div', t('Memuat…'), 'wa-loading inline'))
    box.append(list)
    api(`/api/instagram/comments?status=all&media=${encodeURIComponent(row.mediaId)}`)
      .then((data) => {
        if (selectedKey !== row.key) return
        const comments = data.comments || []
        list.replaceChildren()
        if (!comments.length) return list.append(el('p', t('Belum ada komentar tercatat.'), 'wa-muted'))
        for (const entry of comments.slice(0, 3)) {
          const line = el('p', undefined, 'wa-igp-comment')
          line.append(
            el('b', entry.username ? `@${entry.username}` : 'Instagram'),
            el('span', entry.body),
            el('small', COMMENT_STATUS()[entry.status] || entry.status, 'wa-muted')
          )
          list.append(line)
        }
        const all = el('button', t('Lihat semua komentar ({0})', comments.length), 'button small')
        all.type = 'button'
        all.addEventListener('click', () => {
          closeDrawer(true)
          setTab('comments')
          document.dispatchEvent(new CustomEvent('ig:comments-for', { detail: { mediaId: row.mediaId, caption: row.caption } }))
        })
        list.append(all)
      })
      .catch(() => list.replaceChildren(el('p', t('Komentar belum bisa dimuat.'), 'wa-muted')))
    return box
  }

  function openDetail(row) {
    selectedKey = row.key
    byId('igpList').querySelectorAll('[data-order-id]').forEach((tr) => (tr.dataset.selected = String(tr.dataset.orderId === row.key)))
    const box = byId('igpDetail')
    box.replaceChildren()
    const [label, , pill] = STATUS()[row.status] || [row.status, '', '']
    const head = el('div', undefined, 'wa-b3-detail-head')
    head.append(el('span', label, `wa-pill ${pill}`), el('small', when(row.time), 'wa-muted'))
    box.append(head)

    const gallery = el('div', undefined, 'wa-igp-gallery')
    fillGallery(gallery, row.pictures)
    if (row.carousel) loadChildren(row, gallery)
    if (gallery.childElementCount) box.append(gallery)
    // Instagram tidak memberikan file video untuk Reels dengan musik berhak cipta → hanya sampulnya.
    if (row.noVideo) {
      const note = el('p', t('Video ini tidak bisa diputar di sini (biasanya karena musik berhak cipta).'), 'wa-note')
      if (row.permalink) {
        const link = el('a', t('Putar di Instagram'))
        link.href = row.permalink
        link.target = '_blank'
        link.rel = 'noopener'
        note.append(' ', link)
      }
      box.append(note)
    }
    if (row.error && row.status === 'failed') box.append(el('p', row.error, 'wa-alert'))
    if (row.caption) {
      const caption = section(t('Caption'))
      caption.append(el('pre', row.caption, 'wa-b3-spec'))
      box.append(caption)
    }
    if (row.stats) box.append(...statsBlocks(row.stats))
    if (row.signals) {
      const interest = section(t('Minat beli'))
      const values = [
        [t('Komentar masuk'), row.signals.comments],
        [t('Pertanyaan'), row.signals.questions],
        [t('Order dari penanya'), row.signals.orders],
      ]
      if (values.every(([, value]) => !Number(value))) interest.append(el('p', t('Belum ada pertanyaan dari komentar.'), 'wa-muted'))
      else interest.append(chips(values))
      box.append(interest)
    }

    if (row.mediaId) box.append(commentsSection(row))

    const actions = el('div', undefined, 'wa-b3-actions')
    const post = row.post
    const run = (path, done, ask) => async (event) => {
      if (ask && !window.confirm(ask)) return
      const button = event.currentTarget
      button.disabled = true
      try {
        await api(path, 'POST', {})
        notice(done)
        closeDrawer(true)
        loadPosts()
      } catch (error) {
        notice(error.message, true)
        button.disabled = false
      }
    }
    const button = (text, action, primary = false) => {
      const node = el('button', text, primary ? 'button primary' : 'button')
      node.type = 'button'
      node.addEventListener('click', action)
      return node
    }
    // Hanya untuk jadwal yang belum terbit. Postingan terbit dikelola di Instagram (datanya dari sana).
    if (post && ['scheduled', 'failed', 'cancelled'].includes(post.status))
      actions.append(
        button(
          t('Hapus jadwal'),
          run(`/api/instagram/posts/${post.id}/delete`, t('Jadwal dihapus.'), t('Hapus jadwal ini? Postingan tidak akan diposting.'))
        )
      )
    if (post?.status === 'scheduled')
      actions.append(button(t('Batalkan'), run(`/api/instagram/posts/${post.id}/cancel`, t('Jadwal dibatalkan.'), t('Batalkan jadwal ini?'))))
    if (post && ['failed', 'cancelled'].includes(post.status))
      actions.append(button(t('Posting sekarang'), run(`/api/instagram/posts/${post.id}/retry`, t('Sedang diposting ke Instagram…'))))
    if (row.permalink) {
      const view = el('a', t('Lihat di Instagram'), 'button')
      view.href = row.permalink
      view.target = '_blank'
      view.rel = 'noopener'
      actions.append(view)
    }
    if (post && ['scheduled', 'failed', 'cancelled'].includes(post.status))
      actions.append(button(t('Ubah'), () => openForm(post), true))
    if (actions.childElementCount) box.append(actions)
    showDrawer('detail', `${KIND()[row.kind] || row.kind}${row.count > 1 ? ` · ${row.count}` : ''} · ${when(row.time)}`)
  }

  /* ───── Form buat/ubah postingan ───── */
  let kind = 'feed'
  let items = []
  let editing = 0
  let uploading = 0
  let original = ''
  const form = byId('igpForm')
  const pad = (n) => String(n).padStart(2, '0')
  // Nilai datetime-local dalam WIB.
  const localInput = (date) => {
    const wib = new Date(date.getTime() + 7 * 3_600_000)
    return `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}T${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}`
  }
  const snapshot = () => JSON.stringify([kind, items.map((item) => item.file), byId('igpCaption').value, byId('igpAt').value])
  const dirty = () => !form.hidden && snapshot() !== original
  const HINT = () => ({
    feed: t('1 foto. Foto otomatis dipotong ke rasio 4:5 – 1.91:1.'),
    carousel: t('2–10 foto/video, urutan sesuai tampilan.'),
    reels: t('1 video (MP4/MOV), 3 detik – 15 menit.'),
    story: t('1 foto atau video, tampil 24 jam.'),
  })
  function setKind(next) {
    kind = next
    form.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)))
    const file = byId('igpFile')
    file.multiple = kind === 'carousel'
    file.accept = kind === 'reels' ? 'video/mp4,video/quicktime' : 'image/*,video/mp4,video/quicktime'
    byId('igpCaptionWrap').hidden = kind === 'story'
    byId('igpFeedWrap').hidden = kind !== 'reels'
    byId('igpHint').textContent = HINT()[kind]
    if (kind !== 'carousel' && items.length > 1) items = items.slice(0, 1)
    renderMedia()
  }
  function renderMedia() {
    const box = byId('igpMedia')
    box.replaceChildren(
      ...items.map((item, index) => {
        const tile = el('div', undefined, 'wa-igp-tile')
        const node = el(item.type === 'video' ? 'video' : 'img')
        node.src = item.url
        if (item.type === 'video') {
          node.muted = true
          node.preload = 'metadata'
        } else node.alt = ''
        const remove = el('button', '×', 'wa-igp-remove')
        remove.type = 'button'
        remove.setAttribute('aria-label', t('Hapus'))
        remove.addEventListener('click', () => {
          items.splice(index, 1)
          renderMedia()
        })
        tile.append(node, remove)
        if (kind === 'carousel') tile.append(el('span', String(index + 1), 'wa-igp-index'))
        return tile
      }),
      ...pending.map(uploadTile)
    )
    const used = items.length + pending.length
    byId('igpPick').hidden = kind === 'carousel' ? used >= 10 : used >= 1
  }

  /* Unggah dengan persentase: tiap file punya kotak sendiri sampai selesai. */
  let pending = []
  let uploadSeq = 0
  let formSession = 0
  function uploadTile(job) {
    const tile = el('div', undefined, 'wa-igp-tile is-uploading')
    tile.dataset.upload = String(job.id)
    const bar = el('i', undefined, 'wa-igp-upload-bar')
    bar.style.width = `${job.percent}%`
    tile.append(el('strong', uploadLabel(job), 'wa-igp-upload-label'), el('small', job.name, 'wa-igp-upload-name'), bar)
    tile.setAttribute('role', 'progressbar')
    tile.setAttribute('aria-valuemin', '0')
    tile.setAttribute('aria-valuemax', '100')
    tile.setAttribute('aria-valuenow', String(job.percent))
    tile.setAttribute('aria-label', job.name)
    return tile
  }
  const uploadLabel = (job) =>
    job.state === 'queued' ? t('Antre') : job.state === 'processing' ? t('Memproses…') : `${job.percent}%`
  function updateUploadTile(job) {
    const tile = byId('igpMedia').querySelector(`[data-upload="${job.id}"]`)
    if (!tile) return
    tile.querySelector('.wa-igp-upload-label').textContent = uploadLabel(job)
    tile.querySelector('.wa-igp-upload-bar').style.width = `${job.percent}%`
    tile.setAttribute('aria-valuenow', String(job.percent))
  }
  const workspaceVersion = document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  function uploadWithProgress(data, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${base}/api/instagram/uploads`)
      xhr.setRequestHeader('X-CSRF-TOKEN', csrf)
      xhr.setRequestHeader('Accept', 'application/json')
      if (workspaceVersion) xhr.setRequestHeader('X-WhatsApp-Workspace', workspaceVersion)
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
      })
      xhr.upload.addEventListener('load', () => onProgress(100))
      xhr.addEventListener('load', () => {
        let result = {}
        try {
          result = JSON.parse(xhr.responseText || '{}')
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(result)
        else reject(new Error(t(result.error || 'Permintaan gagal.')))
      })
      xhr.addEventListener('error', () => reject(new Error(t('Koneksi terputus. Coba lagi.'))))
      xhr.send(data)
    })
  }
  form.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-kind]')
    if (button) setKind(button.dataset.kind)
  })
  byId('igpFile').addEventListener('change', async (event) => {
    const room = (kind === 'carousel' ? 10 : 1) - items.length - pending.length
    const files = [...event.target.files].slice(0, Math.max(0, room))
    event.target.value = ''
    if (!files.length) return
    formNotice('')
    // Semua file langsung tampil sebagai kotak (antre), lalu diunggah berurutan agar urutan carousel tetap.
    const session = formSession
    const jobs = files.map((file) => ({ id: ++uploadSeq, name: file.name, file, percent: 0, state: 'queued' }))
    pending.push(...jobs)
    uploading += jobs.length
    renderMedia()
    for (const job of jobs) {
      if (session !== formSession) {
        uploading--
        continue
      }
      job.state = 'sending'
      updateUploadTile(job)
      const data = new FormData()
      data.append('kind', kind)
      data.append('file', job.file)
      try {
        const saved = await uploadWithProgress(data, (percent) => {
          job.percent = percent
          if (percent >= 100) job.state = 'processing'
          updateUploadTile(job)
        })
        pending = pending.filter((item) => item !== job)
        if (form.hidden || session !== formSession) continue
        items.push(saved)
      } catch (error) {
        pending = pending.filter((item) => item !== job)
        formNotice(`${job.name}: ${error.message}`, true)
      } finally {
        uploading--
        renderMedia()
      }
    }
  })
  byId('igpCaption').addEventListener('input', () => {
    byId('igpCount').textContent = `${byId('igpCaption').value.length}/2200`
  })
  const whenValue = () => form.querySelector('input[name="igpWhen"]:checked')?.value || 'later'
  const syncSave = () => {
    byId('igpSave').textContent = whenValue() === 'now' ? t('Posting sekarang') : t('Simpan jadwal')
    byId('igpAt').disabled = whenValue() === 'now'
  }
  form.querySelectorAll('input[name="igpWhen"]').forEach((input) => input.addEventListener('change', syncSave))
  function openForm(post) {
    formSession++
    pending = []
    editing = post?.id || 0
    items = post ? post.items.map((item) => ({ ...item })) : []
    byId('igpCaption').value = post?.caption || ''
    byId('igpCount').textContent = `${byId('igpCaption').value.length}/2200`
    byId('igpShareFeed').checked = post ? post.shareToFeed : true
    const at = post ? Math.max(Date.now() + 10 * 60_000, new Date(post.scheduledAt).getTime()) : Date.now() + 3_600_000
    byId('igpAt').value = localInput(new Date(at))
    form.querySelector('input[name="igpWhen"][value="later"]').checked = true
    formNotice('')
    aiStatus(t('Tulis poin singkat (opsional), lalu klik Buat dengan AI.'))
    syncSave()
    setKind(post?.kind || 'feed')
    showDrawer('form', editing ? t('Ubah postingan') : t('Buat postingan'))
    original = snapshot()
  }
  byId('igpNew').addEventListener('click', () => openForm())

  /* Caption dari AI: isi kolom caption (bila ada) dipakai sebagai catatan/draf. */
  const aiStatus = (text, error = false) => {
    byId('igpAiStatus').textContent = text || ''
    byId('igpAiStatus').classList.toggle('error', Boolean(error))
  }
  byId('igpAi').addEventListener('click', async () => {
    if (uploading) return aiStatus(t('Tunggu unggahan selesai.'), true)
    const area = byId('igpCaption')
    const button = byId('igpAi')
    button.disabled = true
    area.readOnly = true
    byId('igpAiLoading').hidden = false
    aiStatus('')
    try {
      const { caption } = await api('/api/instagram/caption', 'POST', {
        kind,
        items: items.map(({ file, type }) => ({ file, type })),
        note: area.value,
      })
      area.value = caption
      byId('igpCount').textContent = `${caption.length}/2200`
      aiStatus(t('Caption dari AI. Cek dan ubah bila perlu.'))
    } catch (error) {
      aiStatus(error.message, true)
    } finally {
      button.disabled = false
      area.readOnly = false
      byId('igpAiLoading').hidden = true
    }
  })
  byId('igpCancel').addEventListener('click', () => closeDrawer())
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (uploading) return formNotice(t('Tunggu unggahan selesai.'), true)
    const now = whenValue() === 'now'
    if (!now && !byId('igpAt').value) return formNotice(t('Isi tanggal dan jam.'), true)
    byId('igpSave').disabled = true
    try {
      await api('/api/instagram/posts', 'POST', {
        id: editing || undefined,
        kind,
        items: items.map(({ file, type }) => ({ file, type })),
        caption: byId('igpCaption').value,
        shareToFeed: byId('igpShareFeed').checked,
        scheduledAt: now ? 'now' : byId('igpAt').value,
      })
      notice(now ? t('Sedang diposting ke Instagram…') : t('Jadwal tersimpan.'))
      closeDrawer(true)
      loadPosts()
    } catch (error) {
      formNotice(error.message, true)
    } finally {
      byId('igpSave').disabled = false
    }
  })

  /* ───── Ringkasan akun ─────
     Kerangka dibuat sekali; saat ganti rentang hanya angka/grafik yang berubah jadi "memuat". */
  let days = 7
  let summarySeq = 0
  let skeleton = null
  const spinner = () => el('span', t('Memuat…'), 'wa-loading inline')
  const STAT_KEYS = () => [
    ['followers', t('Pengikut')],
    ['reach', t('Jangkauan')],
    ['views', t('Tayangan')],
    ['engaged', t('Akun berinteraksi')],
    ['interactions', t('Interaksi')],
    ['taps', t('Klik link profil')],
  ]
  function buildSkeleton() {
    const fields = {}
    const cards = el('div', undefined, 'wa-igp-stats-grid')
    for (const [key, label] of STAT_KEYS()) {
      const node = el('div', undefined, 'wa-igp-stat')
      const value = el('strong')
      const extra = el('span', '', 'wa-muted')
      node.append(el('small', label), value, extra)
      cards.append(node)
      fields[key] = { value, extra }
    }
    const chart = (title) => {
      const node = section(title)
      const sum = el('small', '', 'wa-igp-chart-sum')
      const body = el('div', undefined, 'wa-igp-bars')
      node.append(sum, body)
      body.sum = sum
      body.title = node.querySelector('h3')
      return [node, body]
    }
    const [reachNode, reachBody] = chart(t('Jangkauan harian'))
    const [followNode, followBody] = chart(t('Pengikut baru harian'))
    reachBody.titles = [t('Jangkauan harian'), t('Jangkauan per minggu')]
    followBody.titles = [t('Pengikut baru harian'), t('Pengikut baru per minggu')]
    const people = section(t('Pengikut'))
    const grid = el('div', undefined, 'wa-igp-people')
    const lists = {}
    for (const [key, label] of [
      ['age', t('Umur')],
      ['gender', t('Jenis kelamin')],
      ['city', t('Kota')],
      ['country', t('Negara')],
    ]) {
      const node = el('div', undefined, 'wa-igp-top-list')
      const body = el('div', undefined, 'wa-igp-top-body')
      node.append(el('h4', label), body)
      grid.append(node)
      lists[key] = body
    }
    people.append(grid)
    const alert = el('p', '', 'wa-alert')
    byId('igpSummary').replaceChildren(alert, cards, reachNode, followNode, people)
    skeleton = { fields, reachBody, followBody, lists, alert, audience: false }
  }
  function loadingState(withAudience) {
    // Keterangan kecil disembunyikan (bukan dihapus) agar tinggi kartu tidak berubah.
    for (const { value, extra } of Object.values(skeleton.fields)) {
      value.replaceChildren(spinner())
      extra.classList.add('wa-igp-pending')
    }
    skeleton.reachBody.replaceChildren(spinner())
    skeleton.reachBody.sum.textContent = ''
    if (!skeleton.followBody.childElementCount) skeleton.followBody.replaceChildren(spinner())
    if (withAudience) for (const body of Object.values(skeleton.lists)) body.replaceChildren(spinner())
  }
  /* Grafik harian dengan angka: nilai di atas batang, tanggal di bawah, ringkasan di atas grafik. */
  const compact = (value) =>
    new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0))
  const dayOf = (date, options) => new Intl.DateTimeFormat(locale(), { timeZone: 'Asia/Jakarta', ...options }).format(new Date(date))
  /** Lebih dari 45 hari: batang per minggu (7 hari) supaya angkanya tetap terbaca. */
  function weekly(points) {
    const out = []
    for (let index = 0; index < points.length; index += 7) {
      const chunk = points.slice(index, index + 7)
      out.push({ date: chunk[0].date, end: chunk[chunk.length - 1].date, value: chunk.reduce((sum, point) => sum + Number(point.value || 0), 0) })
    }
    return out
  }
  function fillBars(box, points, note = '') {
    if (box.sum) box.sum.textContent = ''
    if (!points.length) return box.replaceChildren(el('span', t('Belum ada data.'), 'wa-muted wa-igp-bars-empty'))
    const daily = points
    const byWeek = points.length > 45
    if (box.title && box.titles) box.title.textContent = box.titles[byWeek ? 1 : 0]
    if (byWeek) {
      const weeks = weekly(points)
      const values = daily.map((point) => Number(point.value || 0))
      const total = values.reduce((sum, value) => sum + value, 0)
      const best = daily[values.indexOf(Math.max(...values))]
      if (box.sum)
        box.sum.textContent =
          t(
            'Total {0} · rata-rata {1}/hari · tertinggi {2} ({3})',
            num(total),
            num(Math.round(total / daily.length)),
            num(best.value),
            dayOf(best.date, { weekday: 'short', day: 'numeric', month: 'short' })
          ) + (note ? ` · ${note}` : '')
      const max = Math.max(1, ...weeks.map((week) => week.value))
      box.classList.remove('is-dense')
      box.replaceChildren(
        ...weeks.map((week) => {
          const col = el('div', undefined, 'wa-igp-col')
          const range = `${dayOf(week.date, { day: 'numeric', month: 'short' })} – ${dayOf(week.end, { day: 'numeric', month: 'short' })}`
          col.title = `${range}: ${num(week.value)}`
          const bar = el('i', undefined, 'wa-igp-bar')
          bar.style.height = `${Math.max(2, Math.round((week.value / max) * 64))}px`
          col.append(el('b', compact(week.value), 'wa-igp-val'), bar, el('small', dayOf(week.date, { day: 'numeric', month: 'short' }), 'wa-igp-day'))
          return col
        })
      )
      return
    }
    const values = points.map((point) => Number(point.value || 0))
    const max = Math.max(1, ...values)
    const total = values.reduce((sum, value) => sum + value, 0)
    const best = points[values.indexOf(Math.max(...values))]
    if (box.sum)
      box.sum.textContent = t(
        'Total {0} · rata-rata {1}/hari · tertinggi {2} ({3})',
        num(total),
        num(Math.round(total / points.length)),
        num(best.value),
        dayOf(best.date, { weekday: 'short', day: 'numeric', month: 'short' })
      ) + (note ? ` · ${note}` : '')
    const dense = points.length > 14
    box.classList.toggle('is-dense', dense)
    box.replaceChildren(
      ...points.map((point, index) => {
        const col = el('div', undefined, 'wa-igp-col')
        col.title = `${dayOf(point.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${num(point.value)}`
        const bar = el('i', undefined, 'wa-igp-bar')
        bar.style.height = `${Math.max(2, Math.round((Number(point.value || 0) / max) * 64))}px`
        // Banyak hari: tanggal ditampilkan tiap 5 hari (dan hari terakhir) agar tidak berdesakan.
        const showDay = !dense || index % 5 === 0 || index === points.length - 1
        col.append(
          el('b', compact(point.value), 'wa-igp-val'),
          bar,
          el('small', showDay ? dayOf(point.date, { day: 'numeric' }) : '', 'wa-igp-day')
        )
        return col
      })
    )
  }
  function fillList(body, rows, rename = (k) => k) {
    if (!rows?.length) return body.replaceChildren(el('p', t('Belum cukup data (butuh ≥100 pengikut).'), 'wa-muted'))
    const total = rows.reduce((sum, row) => sum + row.value, 0) || 1
    body.replaceChildren(
      ...rows.slice(0, 6).map((row) => {
        const line = el('div', undefined, 'wa-igp-line')
        const fill = el('i')
        const share = Math.round((row.value / total) * 100)
        fill.style.width = `${share}%`
        line.append(el('span', rename(row.key)), el('b', `${share}%`), fill)
        return line
      })
    )
  }
  function emptyState(message) {
    for (const { value, extra } of Object.values(skeleton.fields)) {
      value.textContent = '—'
      extra.textContent = ''
      extra.classList.remove('wa-igp-pending')
    }
    for (const body of [skeleton.reachBody, skeleton.followBody]) {
      body.replaceChildren()
      body.sum.textContent = ''
    }
    for (const body of Object.values(skeleton.lists)) body.replaceChildren()
    skeleton.alert.textContent = message
  }
  async function loadSummary(fresh = false) {
    if (!skeleton) buildSkeleton()
    const seq = ++summarySeq
    const withAudience = fresh || !skeleton.audience
    skeleton.alert.textContent = ''
    loadingState(withAudience)
    try {
      const data = await api(`/api/instagram/insights?days=${days}${fresh ? '&fresh=1' : ''}`)
      if (seq !== summarySeq) return
      if (!data.connected) return emptyState(t('Instagram belum terhubung'))
      const o = data.overview
      if (o.needsReconnect) byId('igpReconnect').hidden = false
      const m = (key) => o.metrics?.[key]?.value
      const f = skeleton.fields
      const follow = o.metrics?.follows_and_unfollows?.breakdowns || []
      const gained = follow.find((b) => /^follower/i.test(b.key))?.value
      const lost = follow.find((b) => /non_follower|unfollow/i.test(b.key))?.value
      const set = (key, value, extra = '', exact) => {
        f[key].value.textContent = value
        f[key].value.title = exact === undefined || exact === null ? '' : full(exact)
        f[key].extra.textContent = extra
        f[key].extra.classList.remove('wa-igp-pending')
      }
      set('followers', num(o.profile?.followers_count), gained !== undefined ? t('+{0} / −{1}', num(gained), num(lost || 0)) : '', o.profile?.followers_count)
      const approx = (key) => (o.metrics?.[key]?.approx ? t('perkiraan') : '')
      set('reach', num(m('reach')), approx('reach'), m('reach'))
      set('views', num(m('views')), '', m('views'))
      set('engaged', num(m('accounts_engaged')), approx('accounts_engaged'), m('accounts_engaged'))
      set(
        'interactions',
        num(m('total_interactions')),
        t('{0} suka · {1} komentar · {2} simpan · {3} bagikan', num(m('likes')), num(m('comments')), num(m('saves')), num(m('shares'))),
        m('total_interactions')
      )
      set('taps', num(m('profile_links_taps')), '', m('profile_links_taps'))
      fillBars(skeleton.reachBody, o.reach || [])
      fillBars(skeleton.followBody, o.followers || [], days > 30 ? t('Instagram hanya memberi 30 hari terakhir') : '')
      if (withAudience) {
        const gender = { F: t('Perempuan'), M: t('Laki-laki'), U: t('Lainnya') }
        fillList(skeleton.lists.age, data.audience?.age)
        fillList(skeleton.lists.gender, data.audience?.gender, (k) => gender[k] || k)
        fillList(skeleton.lists.city, data.audience?.city)
        fillList(skeleton.lists.country, data.audience?.country)
        skeleton.audience = true
      }
      if (o.error && !Object.keys(o.metrics || {}).length) skeleton.alert.textContent = o.error
    } catch (error) {
      if (seq === summarySeq) emptyState(error.message)
    }
  }
  /* Analisis AI: postingan mana yang mendatangkan pertanyaan & order. Berjalan di latar. */
  let analysisTimer
  function renderAnalysis(data) {
    const body = byId('igpAnalysisBody')
    const button = byId('igpAnalyze')
    clearTimeout(analysisTimer)
    button.disabled = data.status === 'running'
    button.textContent = data.result ? t('Analisis ulang') : t('Analisis sekarang')
    const parts = []
    if (data.status === 'running') {
      parts.push(el('div', t('AI sedang menganalisis…'), 'wa-loading'))
      if (activeTab() === 'summary') analysisTimer = setTimeout(loadAnalysis, 4000)
    } else if (data.status === 'failed') parts.push(el('p', t(data.error || 'Analisis gagal. Coba lagi.'), 'wa-alert'))
    if (data.result && data.status !== 'running') {
      const r = data.result
      if (r.ringkasan) parts.push(el('p', r.ringkasan, 'wa-igp-analysis-lead'))
      for (const [title, list] of [
        [t('Yang berhasil'), r.berhasil],
        [t('Yang kurang'), r.kurang],
        [t('Saran'), r.saran],
        [t('Ide konten berikutnya'), r.ide],
      ]) {
        if (!list?.length) continue
        const group = el('div', undefined, 'wa-igp-analysis-group')
        const ul = el('ul')
        for (const line of list) ul.append(el('li', line))
        group.append(el('h4', title), ul)
        parts.push(group)
      }
      if (r.waktu) {
        const group = el('div', undefined, 'wa-igp-analysis-group')
        group.append(el('h4', t('Waktu posting terbaik')), el('p', r.waktu))
        parts.push(group)
      }
      parts.push(el('small', t('Dianalisis {0} dari {1} postingan', when(data.at), data.posts || 0), 'wa-muted'))
    }
    if (!parts.length)
      parts.push(el('p', t('Klik Analisis sekarang untuk melihat konten yang paling mendatangkan pertanyaan dan order.'), 'wa-muted'))
    body.replaceChildren(...parts)
  }
  async function loadAnalysis() {
    try {
      renderAnalysis(await api('/api/instagram/analysis'))
    } catch (error) {
      byId('igpAnalysisBody').replaceChildren(el('p', error.message, 'wa-alert'))
    }
  }
  byId('igpAnalyze').addEventListener('click', async () => {
    byId('igpAnalyze').disabled = true
    byId('igpAnalysisBody').replaceChildren(el('div', t('AI sedang menganalisis…'), 'wa-loading'))
    try {
      renderAnalysis(await api('/api/instagram/analysis', 'POST', {}))
    } catch (error) {
      byId('igpAnalyze').disabled = false
      byId('igpAnalysisBody').replaceChildren(el('p', error.message, 'wa-alert'))
    }
  })
  /* ───── Tab halaman: Konten · Komentar · Ringkasan ───── */
  function setTab(tab) {
    if (!page) return
    page.dataset.igTab = tab
    byId('igTabs')
      .querySelectorAll('[data-ig-tab]')
      .forEach((button) => button.setAttribute('aria-selected', String(button.dataset.igTab === tab)))
    try {
      const url = new URL(location.href)
      if (tab === 'content') url.searchParams.delete('tab')
      else url.searchParams.set('tab', tab)
      url.hash = ''
      history.replaceState(history.state, '', url)
    } catch {}
    document.dispatchEvent(new CustomEvent('ig:tab', { detail: { tab } }))
    if (tab === 'summary') {
      loadAnalysis()
      loadSummary()
    }
  }
  byId('igTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ig-tab]')
    if (button && button.dataset.igTab !== activeTab()) setTab(button.dataset.igTab)
  })
  byId('igTabs')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const buttons = [...byId('igTabs').querySelectorAll('[data-ig-tab]')]
    const index = buttons.findIndex((button) => button.dataset.igTab === activeTab())
    const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]
    setTab(next.dataset.igTab)
    next.focus()
  })
  // Dari tab Komentar: buka detail postingan di tab Konten.
  document.addEventListener('ig:open-post', (event) => {
    const { mediaId, permalink } = event.detail || {}
    setTab('content')
    const row = buildRows().find((item) => item.mediaId && item.mediaId === String(mediaId))
    if (row) openDetail(row)
    else if (permalink) window.open(permalink, '_blank', 'noopener')
    else notice(t('Postingan ini belum dimuat. Gulir ke bawah untuk memuat lebih banyak.'))
  })
  byId('igpSummaryRefresh').addEventListener('click', () => loadSummary(true))
  byId('igpDays').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]')
    if (!button || Number(button.dataset.days) === days) return
    days = Number(button.dataset.days)
    byId('igpDays').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    loadSummary()
  })

  document.addEventListener('ui-language:change', () => {
    setKind(kind)
    render()
    // Label ringkasan ikut bahasa: bangun ulang kerangkanya.
    skeleton = null
    if (activeTab() === 'summary') loadSummary()
  })

  loadState()
  setKind('feed')
  loadPosts()
  loadMedia()
  if (location.hash === '#summary') setTab('summary')
  else if (activeTab() === 'summary') {
    loadAnalysis()
    loadSummary()
  }
})()
