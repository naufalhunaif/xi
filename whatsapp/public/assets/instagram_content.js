;(() => {
  const root = document.getElementById('igContentPage')
  if (!root) return
  const byId = (id) => document.getElementById(id)
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
  const num = (value) =>
    new Intl.NumberFormat(locale(), { notation: Number(value) >= 10000 ? 'compact' : 'standard' }).format(Number(value || 0))
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
  })
  const seconds = (ms) => `${(Number(ms || 0) / 1000).toFixed(1)}s`

  /* ───── Data: jadwal (aplikasi) + postingan & story dari Instagram ───── */
  let posts = []
  let media = []
  let stories = []
  let mediaError = ''
  let postsLoaded = false
  let mediaLoaded = false
  let filter = 'all'
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
        pictures: post ? post.items : [{ url: item.thumbnail_url || item.media_url || '', type: 'image' }],
        caption: item.caption || post?.caption || '',
        time: item.timestamp || post?.publishedAt,
        status: 'published',
        stats: { likes: item.like_count, comments: item.comments_count, ...(item.stats || {}) },
        permalink: item.permalink || post?.permalink || '',
        post,
      })
    }
    for (const post of posts) {
      if (used.has(post.id)) continue
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
  const stamp = (row) => new Date(row.time || 0).getTime()
  function sorted(rows) {
    const upcoming = rows.filter((row) => groupOf(row) === 'upcoming').sort((a, b) => stamp(a) - stamp(b))
    const rest = (group) => rows.filter((row) => groupOf(row) === group).sort((a, b) => stamp(b) - stamp(a))
    return [...upcoming, ...rest('failed'), ...rest('done')]
  }

  /* ───── Tabel ───── */
  const COLUMNS = 7
  const statCell = (row, key) => {
    const value = row.stats?.[key]
    return el('td', value === undefined || value === null ? '—' : num(value), 'wa-order-amount')
  }
  function thumbOf(row, className) {
    const node = el(row.video ? 'video' : 'img', undefined, className)
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
    for (const [key, test] of Object.entries(FILTERS)) {
      const count = all.filter(test).length
      const badge = byId('igpTabs').querySelector(`[data-count="${key}"]`)
      if (badge) badge.textContent = count ? String(count) : ''
    }
    const query = byId('igpSearch').value.trim().toLowerCase()
    const rows = sorted(all.filter(FILTERS[filter]).filter((row) => !query || row.caption.toLowerCase().includes(query)))
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
    if (!rows.length && !(postsLoaded && mediaLoaded)) {
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
      tr.append(head, time, statCell(row, 'reach'), statCell(row, 'views'), statCell(row, 'likes'), statCell(row, 'comments'), state)
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
    if (!mediaLoaded) list.append(loadingRow())
  }
  byId('igpTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]')
    if (!button) return
    filter = button.dataset.filter
    byId('igpTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    render()
  })
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
  async function loadMedia() {
    try {
      const data = await api('/api/instagram/performance')
      media = data.posts || []
      stories = data.stories || []
      mediaError = data.error || ''
    } catch (error) {
      notice(error.message, true)
    } finally {
      mediaLoaded = true
      render()
    }
  }
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
    loadMedia()
  })

  /* ───── Dialog kanan: detail, form, ringkasan ───── */
  const drawer = byId('igpDrawer')
  let mode = ''
  let returnFocus = null
  function showDrawer(next, title) {
    mode = next
    byId('igpDrawerTitle').textContent = title
    byId('igpDetail').hidden = next !== 'detail'
    byId('igpForm').hidden = next !== 'form'
    byId('igpSummaryBox').hidden = next !== 'summary'
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
  function openDetail(row) {
    selectedKey = row.key
    byId('igpList').querySelectorAll('[data-order-id]').forEach((tr) => (tr.dataset.selected = String(tr.dataset.orderId === row.key)))
    const box = byId('igpDetail')
    box.replaceChildren()
    const [label, , pill] = STATUS()[row.status] || [row.status, '', '']
    const head = el('div', undefined, 'wa-b3-detail-head')
    head.append(el('span', label, `wa-pill ${pill}`), el('small', when(row.time), 'wa-muted'))
    box.append(head)

    const pictures = el('div', undefined, 'wa-b3-pictures')
    for (const item of row.pictures.filter((picture) => picture.url)) {
      const figure = el('figure')
      const node = el(item.type === 'video' ? 'video' : 'img')
      node.src = item.url
      if (item.type === 'video') {
        node.controls = true
        node.preload = 'metadata'
      } else node.alt = ''
      figure.append(node)
      pictures.append(figure)
    }
    if (pictures.childElementCount) box.append(pictures)
    if (row.error && row.status === 'failed') box.append(el('p', row.error, 'wa-alert'))
    if (row.caption) {
      const caption = section(t('Caption'))
      caption.append(el('pre', row.caption, 'wa-b3-spec'))
      box.append(caption)
    }
    if (row.stats) {
      const perf = section(t('Performa'))
      const keys =
        row.kind === 'story'
          ? ['reach', 'views', 'replies', 'shares']
          : row.kind === 'reels'
            ? ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'ig_reels_avg_watch_time']
            : ['reach', 'views', 'likes', 'comments', 'saved', 'shares']
      const list = el('dl', undefined, 'wa-b3-fields wa-igp-metrics')
      for (const key of keys) {
        if (row.stats[key] === undefined || row.stats[key] === null) continue
        const item = el('div')
        item.append(el('dt', METRIC()[key]), el('dd', key === 'ig_reels_avg_watch_time' ? seconds(row.stats[key]) : num(row.stats[key])))
        list.append(item)
      }
      if (list.childElementCount) perf.append(list)
      else perf.append(el('p', t('Belum ada data performa.'), 'wa-muted'))
      box.append(perf)
    }

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
    if (post && post.status !== 'publishing')
      actions.append(
        button(
          t('Hapus'),
          run(`/api/instagram/posts/${post.id}/delete`, t('Dihapus.'), t('Hapus dari daftar? Postingan yang sudah terbit tetap ada di Instagram.'))
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
      })
    )
    byId('igpPick').hidden = kind === 'carousel' ? items.length >= 10 : items.length >= 1
  }
  form.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-kind]')
    if (button) setKind(button.dataset.kind)
  })
  byId('igpFile').addEventListener('change', async (event) => {
    const files = [...event.target.files]
    event.target.value = ''
    for (const file of files) {
      if (kind === 'carousel' ? items.length >= 10 : items.length >= 1) break
      formNotice(t('Mengunggah {0}…', file.name))
      uploading++
      const data = new FormData()
      data.append('kind', kind)
      data.append('file', file)
      try {
        items.push(await api('/api/instagram/uploads', 'POST', data))
        renderMedia()
        formNotice('')
      } catch (error) {
        formNotice(error.message, true)
      } finally {
        uploading--
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
    editing = post?.id || 0
    items = post ? post.items.map((item) => ({ ...item })) : []
    byId('igpCaption').value = post?.caption || ''
    byId('igpCount').textContent = `${byId('igpCaption').value.length}/2200`
    byId('igpShareFeed').checked = post ? post.shareToFeed : true
    const at = post ? Math.max(Date.now() + 10 * 60_000, new Date(post.scheduledAt).getTime()) : Date.now() + 3_600_000
    byId('igpAt').value = localInput(new Date(at))
    form.querySelector('input[name="igpWhen"][value="later"]').checked = true
    formNotice('')
    syncSave()
    setKind(post?.kind || 'feed')
    showDrawer('form', editing ? t('Ubah postingan') : t('Buat postingan'))
    original = snapshot()
  }
  byId('igpNew').addEventListener('click', () => openForm())
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

  /* ───── Ringkasan akun ───── */
  let days = 7
  function bars(points) {
    const box = el('div', undefined, 'wa-igp-bars')
    const max = Math.max(1, ...points.map((p) => p.value))
    for (const point of points) {
      const bar = el('span')
      bar.style.height = `${Math.max(3, Math.round((point.value / max) * 100))}%`
      bar.title = `${new Intl.DateTimeFormat(locale(), { day: '2-digit', month: 'short' }).format(new Date(point.date))}: ${num(point.value)}`
      box.append(bar)
    }
    return box
  }
  function stat(label, value, extra) {
    const node = el('div', undefined, 'wa-igp-stat')
    node.append(el('small', label), el('strong', value))
    if (extra) node.append(el('span', extra, 'wa-muted'))
    return node
  }
  function topList(title, rows, rename = (k) => k) {
    const node = el('div', undefined, 'wa-igp-top-list')
    node.append(el('h4', title))
    if (!rows?.length) {
      node.append(el('p', t('Belum cukup data (butuh ≥100 pengikut).'), 'wa-muted'))
      return node
    }
    const total = rows.reduce((sum, row) => sum + row.value, 0) || 1
    for (const row of rows.slice(0, 6)) {
      const line = el('div', undefined, 'wa-igp-line')
      const fill = el('i')
      const share = Math.round((row.value / total) * 100)
      fill.style.width = `${share}%`
      line.append(el('span', rename(row.key)), el('b', `${share}%`), fill)
      node.append(line)
    }
    return node
  }
  async function loadSummary(fresh = false) {
    const box = byId('igpSummary')
    if (!box.childElementCount || fresh) box.replaceChildren(el('div', t('Memuat…'), 'wa-loading'))
    try {
      const data = await api(`/api/instagram/insights?days=${days}${fresh ? '&fresh=1' : ''}`)
      if (!data.connected) return box.replaceChildren(el('p', t('Instagram belum terhubung'), 'wa-muted'))
      const o = data.overview
      if (o.needsReconnect) byId('igpReconnect').hidden = false
      const m = (key) => o.metrics?.[key]?.value
      const follow = o.metrics?.follows_and_unfollows?.breakdowns || []
      const gained = follow.find((b) => /^follower/i.test(b.key))?.value
      const lost = follow.find((b) => /non_follower|unfollow/i.test(b.key))?.value
      const cards = el('div', undefined, 'wa-igp-stats-grid')
      cards.append(
        stat(t('Pengikut'), num(o.profile?.followers_count), gained !== undefined ? t('+{0} / −{1}', num(gained), num(lost || 0)) : ''),
        stat(t('Jangkauan'), num(m('reach'))),
        stat(t('Tayangan'), num(m('views'))),
        stat(t('Akun berinteraksi'), num(m('accounts_engaged'))),
        stat(
          t('Interaksi'),
          num(m('total_interactions')),
          t('{0} suka · {1} komentar · {2} simpan · {3} bagikan', num(m('likes')), num(m('comments')), num(m('saves')), num(m('shares')))
        ),
        stat(t('Klik link profil'), num(m('profile_links_taps')))
      )
      const chart = (title, points) => {
        const node = section(title)
        node.append(points.length ? bars(points) : el('p', t('Belum ada data.'), 'wa-muted'))
        return node
      }
      const gender = { F: t('Perempuan'), M: t('Laki-laki'), U: t('Lainnya') }
      const people = section(t('Pengikut'))
      const peopleGrid = el('div', undefined, 'wa-igp-people')
      peopleGrid.append(
        topList(t('Umur'), data.audience?.age),
        topList(t('Jenis kelamin'), data.audience?.gender, (k) => gender[k] || k),
        topList(t('Kota'), data.audience?.city),
        topList(t('Negara'), data.audience?.country)
      )
      people.append(peopleGrid)
      box.replaceChildren(cards, chart(t('Jangkauan harian'), o.reach || []), chart(t('Pengikut baru harian'), o.followers || []), people)
      if (o.error && !Object.keys(o.metrics || {}).length) box.prepend(el('p', o.error, 'wa-alert'))
    } catch (error) {
      box.replaceChildren(el('p', error.message, 'wa-alert'))
    }
  }
  function openSummary() {
    showDrawer('summary', t('Ringkasan akun'))
    loadSummary()
  }
  byId('igpSummaryOpen').addEventListener('click', openSummary)
  byId('igpSummaryRefresh').addEventListener('click', () => loadSummary(true))
  byId('igpDays').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]')
    if (!button) return
    days = Number(button.dataset.days)
    byId('igpDays').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    loadSummary()
  })

  document.addEventListener('ui-language:change', () => {
    setKind(kind)
    render()
  })

  loadState()
  setKind('feed')
  loadPosts()
  loadMedia()
  if (location.hash === '#summary') openSummary()
})()
