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

  /* ───── Tab ───── */
  let tab = 'schedule'
  function showTab(next) {
    tab = next
    byId('igpTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)))
    root.querySelectorAll('[data-panel]').forEach((panel) => (panel.hidden = panel.dataset.panel !== tab))
    if (tab === 'schedule') loadPosts()
    if (tab === 'posts') loadPerformance()
    if (tab === 'summary') loadSummary()
    try {
      history.replaceState(null, '', `#${tab}`)
    } catch {}
  }
  byId('igpTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]')
    if (button) showTab(button.dataset.tab)
  })

  /* ───── Status akun ───── */
  async function loadState() {
    try {
      const state = await api('/api/instagram/content')
      byId('igpAccount').textContent = state.connected ? `@${state.username}` : t('Instagram belum terhubung')
      byId('igpReconnect').hidden = !state.connected || state.ready
    } catch {}
  }

  /* ───── Form buat/ubah postingan ───── */
  let kind = 'feed'
  let items = []
  let editing = 0
  let uploading = 0
  const form = byId('igpForm')
  const pad = (n) => String(n).padStart(2, '0')
  // Nilai datetime-local dalam WIB.
  const localInput = (date) => {
    const wib = new Date(date.getTime() + 7 * 3_600_000)
    return `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}T${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}`
  }
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
        const media = el(item.type === 'video' ? 'video' : 'img')
        media.src = item.url
        if (item.type === 'video') {
          media.muted = true
          media.preload = 'metadata'
        }
        const remove = el('button', '×', 'wa-igp-remove')
        remove.type = 'button'
        remove.title = t('Hapus')
        remove.addEventListener('click', () => {
          items.splice(index, 1)
          renderMedia()
        })
        tile.append(media, remove)
        if (kind === 'carousel') tile.append(el('span', String(index + 1), 'wa-igp-index'))
        return tile
      })
    )
    const full = kind === 'carousel' ? items.length >= 10 : items.length >= 1
    byId('igpPick').hidden = full
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
      notice(t('Mengunggah {0}…', file.name))
      uploading++
      const data = new FormData()
      data.append('kind', kind)
      data.append('file', file)
      try {
        items.push(await api('/api/instagram/uploads', 'POST', data))
        renderMedia()
        notice('')
      } catch (error) {
        notice(error.message, true)
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
    syncSave()
    setKind(post?.kind || 'feed')
    form.hidden = false
    byId('igpNew').hidden = true
    form.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function closeForm() {
    form.hidden = true
    byId('igpNew').hidden = false
    items = []
    editing = 0
  }
  byId('igpNew').addEventListener('click', () => openForm())
  byId('igpCancel').addEventListener('click', closeForm)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (uploading) return notice(t('Tunggu unggahan selesai.'), true)
    const now = whenValue() === 'now'
    if (!now && !byId('igpAt').value) return notice(t('Isi tanggal dan jam.'), true)
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
      closeForm()
      loadPosts()
    } catch (error) {
      notice(error.message, true)
    } finally {
      byId('igpSave').disabled = false
    }
  })

  /* ───── Daftar jadwal ───── */
  const STATUS = () => ({
    scheduled: [t('Terjadwal'), 'warn'],
    publishing: [t('Sedang diposting'), 'warn'],
    published: [t('Terbit'), 'ok'],
    failed: [t('Gagal'), 'err'],
    cancelled: [t('Dibatalkan'), ''],
  })
  const textLink = (label, action) => {
    const node = el('button', label, 'wa-igc-link')
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }
  let postsTimer
  function postRow(post) {
    const row = el('article', undefined, 'wa-igp-row')
    const first = post.items[0]
    const thumb = el(first?.type === 'video' ? 'video' : 'img', undefined, 'wa-igp-thumb')
    if (first) thumb.src = first.url
    if (first?.type === 'video') thumb.muted = true
    const info = el('div', undefined, 'wa-igp-info')
    const top = el('div', undefined, 'wa-igp-top')
    top.append(el('b', `${KIND()[post.kind] || post.kind}${post.items.length > 1 ? ` · ${post.items.length}` : ''}`))
    top.append(el('span', when(post.status === 'published' ? post.publishedAt : post.scheduledAt), 'wa-muted'))
    const [label, tone] = STATUS()[post.status] || [post.status, '']
    top.append(el('span', label, `wa-pill ${tone}`))
    info.append(top)
    if (post.caption) info.append(el('p', post.caption.replace(/\s+/g, ' '), 'wa-igp-text'))
    if (post.error && post.status === 'failed') info.append(el('p', post.error, 'wa-igc-error'))
    const actions = el('div', undefined, 'wa-igc-actions wa-igp-actions-row')
    const run = (path, done) => async () => {
      try {
        await api(path, 'POST', {})
        notice(done)
        loadPosts()
      } catch (error) {
        notice(error.message, true)
      }
    }
    if (['scheduled', 'failed', 'cancelled'].includes(post.status)) actions.append(textLink(t('Ubah'), () => openForm(post)))
    if (post.status === 'scheduled')
      actions.append(textLink(t('Batalkan'), run(`/api/instagram/posts/${post.id}/cancel`, t('Jadwal dibatalkan.'))))
    if (['failed', 'cancelled'].includes(post.status))
      actions.append(textLink(t('Posting sekarang'), run(`/api/instagram/posts/${post.id}/retry`, t('Sedang diposting ke Instagram…'))))
    if (post.permalink) {
      const view = el('a', t('Lihat di Instagram'), 'wa-igc-link')
      view.href = post.permalink
      view.target = '_blank'
      view.rel = 'noopener'
      actions.append(view)
    }
    if (post.status !== 'publishing')
      actions.append(
        textLink(t('Hapus'), () => {
          if (window.confirm(t('Hapus dari daftar? Postingan yang sudah terbit tetap ada di Instagram.')))
            run(`/api/instagram/posts/${post.id}/delete`, t('Dihapus.'))()
        })
      )
    info.append(actions)
    row.append(thumb, info)
    return row
  }
  async function loadPosts() {
    clearTimeout(postsTimer)
    try {
      const { posts } = await api('/api/instagram/posts')
      const list = byId('igpList')
      const groups = [
        [t('Akan datang'), posts.filter((p) => ['scheduled', 'publishing'].includes(p.status)).reverse()],
        [t('Gagal / dibatalkan'), posts.filter((p) => ['failed', 'cancelled'].includes(p.status))],
        [t('Sudah terbit'), posts.filter((p) => p.status === 'published')],
      ]
      list.replaceChildren()
      for (const [title, rows] of groups) {
        if (!rows.length) continue
        list.append(el('h2', `${title} · ${rows.length}`, 'wa-igp-sub'), ...rows.map(postRow))
      }
      if (!posts.length) list.append(el('p', t('Belum ada postingan. Klik "+ Buat postingan".'), 'wa-muted'))
      const soon = posts.some(
        (p) => p.status === 'publishing' || (p.status === 'scheduled' && new Date(p.scheduledAt).getTime() - Date.now() < 120_000)
      )
      if (soon && tab === 'schedule') postsTimer = setTimeout(loadPosts, 8000)
    } catch (error) {
      notice(error.message, true)
    }
  }

  /* ───── Performa postingan ───── */
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
  function card(media) {
    const node = el('article', undefined, 'wa-igp-card')
    const cover = el('a', undefined, 'wa-igp-cover')
    if (media.permalink) {
      cover.href = media.permalink
      cover.target = '_blank'
      cover.rel = 'noopener'
    }
    const image = el('img')
    image.src = media.thumbnail_url || media.media_url || ''
    image.alt = ''
    image.loading = 'lazy'
    const type =
      media.product === 'REELS'
        ? t('Reels')
        : media.product === 'STORY'
          ? t('Story')
          : media.media_type === 'CAROUSEL_ALBUM'
            ? t('Carousel')
            : t('Feed')
    cover.append(image, el('span', type, 'wa-igp-badge'))
    node.append(cover, el('small', when(media.timestamp), 'wa-muted'))
    const stats = { likes: media.like_count, comments: media.comments_count, ...media.stats }
    const keys =
      media.product === 'STORY'
        ? ['reach', 'views', 'replies', 'shares']
        : media.product === 'REELS'
          ? ['views', 'reach', 'likes', 'comments', 'shares', 'ig_reels_avg_watch_time']
          : ['reach', 'views', 'likes', 'comments', 'saved', 'shares']
    const grid = el('dl', undefined, 'wa-igp-stats')
    for (const key of keys) {
      if (stats[key] === undefined) continue
      const item = el('div')
      item.append(el('dt', METRIC()[key]), el('dd', key === 'ig_reels_avg_watch_time' ? seconds(stats[key]) : num(stats[key])))
      grid.append(item)
    }
    node.append(grid)
    return node
  }
  async function loadPerformance() {
    try {
      const data = await api('/api/instagram/performance')
      byId('igpPosts').replaceChildren(...data.posts.map(card))
      if (!data.posts.length)
        byId('igpPosts').append(el('p', data.error ? t(data.error) : t('Belum ada postingan.'), 'wa-muted'))
      byId('igpStories').replaceChildren(...data.stories.map(card))
      if (!data.stories.length)
        byId('igpStories').append(
          el('p', t('Story yang tayang akan tersimpan di sini (data story hilang dari Instagram setelah 24 jam).'), 'wa-muted')
        )
    } catch (error) {
      notice(error.message, true)
    }
  }

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
    node.append(el('h3', title))
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
        const node = el('div', undefined, 'wa-igp-chart')
        node.append(el('h3', title), points.length ? bars(points) : el('p', t('Belum ada data.'), 'wa-muted'))
        return node
      }
      const charts = el('div', undefined, 'wa-igp-charts')
      charts.append(chart(t('Jangkauan harian'), o.reach || []), chart(t('Pengikut baru harian'), o.followers || []))
      const gender = { F: t('Perempuan'), M: t('Laki-laki'), U: t('Lainnya') }
      const people = el('div', undefined, 'wa-igp-people')
      people.append(
        topList(t('Umur'), data.audience?.age),
        topList(t('Jenis kelamin'), data.audience?.gender, (k) => gender[k] || k),
        topList(t('Kota'), data.audience?.city),
        topList(t('Negara'), data.audience?.country)
      )
      const refresh = textLink(t('Perbarui data'), () => loadSummary(true))
      box.replaceChildren(cards, charts, el('h2', t('Pengikut'), 'wa-igp-sub'), people, refresh)
      if (o.error && !Object.keys(o.metrics || {}).length) box.prepend(el('p', o.error, 'wa-igc-error'))
    } catch (error) {
      box.replaceChildren(el('p', error.message, 'wa-igc-error'))
    }
  }
  byId('igpDays').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-days]')
    if (!button) return
    days = Number(button.dataset.days)
    byId('igpDays').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    loadSummary()
  })
  document.addEventListener('ui-language:change', () => {
    setKind(kind)
    showTab(tab)
  })

  loadState()
  setKind('feed')
  const start = location.hash.slice(1)
  showTab(['schedule', 'posts', 'summary'].includes(start) ? start : 'schedule')
})()
