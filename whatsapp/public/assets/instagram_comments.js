;(() => {
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const byId = (id) => document.getElementById(id)
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.redirected) throw new Error(t('Sesi berakhir. Muat ulang halaman.'))
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(t(result.error || 'Permintaan gagal.'))
    return result
  }

  // Menu "Instagram" muncul bila terhubung; badge (menu & tab Komentar) = komentar yang perlu dibalas.
  async function badge() {
    const nav = byId('igNav')
    if (!nav) return
    try {
      const state = await api('/api/instagram/comments/count')
      if (state.connected) nav.hidden = false
      for (const pill of [byId('commentsBadge'), byId('igTabBadge')]) {
        if (!pill) continue
        pill.textContent = state.open ? String(state.open) : ''
        pill.hidden = !state.open
      }
    } catch {}
  }
  badge()
  setInterval(() => document.visibilityState === 'visible' && badge(), 20_000)

  const root = byId('igCommentsPage')
  if (!root) return
  // Halaman Instagram bertab: cek otomatis hanya saat tab Komentar terbuka.
  const page = byId('igPage')
  const active = () => !page || page.dataset.igTab === 'comments'
  let media = null
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined && text !== null) node.textContent = text
    if (className) node.className = className
    return node
  }
  const STATUS = () => ({
    pending: [t('Diproses AI'), 'warn'],
    processing: [t('Diproses AI'), 'warn'],
    replied: [t('Dibalas lewat DM'), 'ok'],
    cs: [t('Perlu CS'), 'err'],
    skipped: [t('Belum dibalas'), 'warn'],
    failed: [t('Gagal'), 'err'],
    ignored: [t('Bukan pertanyaan'), ''],
  })
  let status = 'all'
  let seq = 0
  const notice = (message, error = false) => {
    byId('igcNotice').textContent = message || ''
    byId('igcNotice').classList.toggle('error', Boolean(error))
  }

  // Tautan kecil bergaya teks (hemat tempat).
  // v3.6.72: aksi berupa ikon (Balas = panah balas, Balas pakai AI = ikon AI) dengan tooltip.
  const ICON_PATH = {
    reply: 'M10 6 4 12l6 6M4 12h11a5 5 0 0 1 5 5v1',
    ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  }
  const link = (label, action, primary = false, icon = '') => {
    const node = el('button', icon ? undefined : label, `wa-igc-link${primary ? ' primary' : ''}${icon ? ' wa-igc-icon' : ''}`)
    if (icon) {
      node.innerHTML = `<svg class="wa-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="${ICON_PATH[icon]}"/></svg>`
      node.title = label
      node.setAttribute('aria-label', label)
    }
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }

  const NEEDS_REPLY = ['failed', 'skipped', 'cs']
  const TONE = { replied: 'ok', pending: 'busy', processing: 'busy', failed: 'open', skipped: 'open', cs: 'open', ignored: 'muted' }

  /** Satu komentar: titik status, nama, isi, waktu; balasan satu baris; aksi muncul saat dibutuhkan. */
  function item(entry) {
    const open = NEEDS_REPLY.includes(entry.status)
    const node = el('li', undefined, `wa-igc-item${open ? ' needs' : ''}`)
    const [label] = STATUS()[entry.status] || [entry.status]
    const line = el('div', undefined, 'wa-igc-line')
    const dot = el('span', undefined, `wa-igc-dot ${TONE[entry.status] || 'muted'}`)
    dot.title = entry.error && entry.status === 'failed' ? `${label}: ${entry.error}` : label
    dot.setAttribute('aria-label', label)
    const name = entry.username ? `@${entry.username}` : 'Instagram'
    let who
    if (['replied', 'cs'].includes(entry.status)) {
      who = el('a', name, 'wa-igc-name')
      who.href = `${base}/?jid=${encodeURIComponent(entry.jid)}`
      who.title = t('Buka chat')
    } else who = el('strong', name, 'wa-igc-name')
    line.append(dot, who, el('span', entry.body, 'wa-igc-text'), Object.assign(window.waTime.node(entry.createdAt), { className: 'wa-igc-time' }))
    node.append(line)
    if (entry.reply) {
      // Balasan DM turun dari komentarnya sebagai cabang kecil.
      const sub = el('ol', undefined, 'wa-igc-subthread')
      const reply = el('li', undefined, 'wa-igc-subitem')
      reply.title = entry.reply
      reply.append(el('b', t('Balasan DM'), 'wa-igc-subname'), el('span', entry.reply, 'wa-igc-subtext'))
      sub.append(reply)
      node.append(sub)
    }

    const form = el('div', undefined, 'wa-igc-form')
    form.hidden = true
    const input = el('textarea')
    input.rows = 2
    input.placeholder = t('Tulis balasan…')
    const send = (via) => async () => {
      const text = input.value.trim()
      if (!text) return input.focus()
      form.querySelectorAll('button').forEach((b) => (b.disabled = true))
      try {
        await api(`/api/instagram/comments/${encodeURIComponent(entry.id)}/reply`, 'POST', { text, via })
        notice(via === 'dm' ? t('Balasan DM terkirim.') : t('Balasan di komentar terkirim.'))
        form.hidden = true
        load()
      } catch (error) {
        notice(error.message, true)
        form.querySelectorAll('button').forEach((b) => (b.disabled = false))
      }
    }
    const row = el('div', undefined, 'wa-igc-form-actions')
    if (entry.canDm) {
      const dm = el('button', t('Kirim DM'), 'button primary')
      dm.type = 'button'
      dm.addEventListener('click', send('dm'))
      row.append(dm)
    }
    const pub = el('button', t('Balas di komentar'), 'button')
    pub.type = 'button'
    pub.addEventListener('click', send('public'))
    row.append(pub)
    form.append(input, row)

    const actions = el('div', undefined, 'wa-igc-actions')
    actions.append(
      link(t('Balas'), () => {
        form.hidden = !form.hidden
        if (!form.hidden) input.focus()
      }, false, 'reply')
    )
    if (entry.canDm && !['pending', 'processing'].includes(entry.status)) {
      const ai = link(t('Balas pakai AI'), async () => {
        ai.disabled = true
        try {
          await api(`/api/instagram/comments/${encodeURIComponent(entry.id)}/ai`, 'POST', {})
          notice(t('AI sedang membalas lewat DM…'))
          load()
        } catch (error) {
          notice(error.message, true)
          ai.disabled = false
        }
      }, false, 'ai')
      actions.append(ai)
    }
    // HP: ketuk komentar untuk memunculkan tombol.
    line.addEventListener('click', (event) => {
      if (event.target.closest('a')) return
      node.classList.toggle('show-actions')
    })
    node.append(actions, form)
    return node
  }

  // Utas per postingan: postingan sekali di atas, komentar bercabang di bawahnya.
  const SHOWN = 3
  const expanded = new Set()
  function post(group) {
    const first = group.items[0]
    const node = el('article', undefined, 'wa-igc-card')
    const head = el('header', undefined, 'wa-igc-post-head')
    const target = first.permalink || first.image
    const media = el(target ? 'a' : 'span', undefined, 'wa-igc-thumb-link')
    if (target) {
      media.href = target
      media.target = '_blank'
      media.rel = 'noopener'
      media.title = first.permalink ? t('Lihat postingan') : t('Lihat foto postingan')
    }
    if (first.image) {
      const thumb = el('img', undefined, 'wa-igc-thumb')
      thumb.src = first.image
      thumb.alt = t('Foto postingan')
      thumb.loading = 'lazy'
      media.append(thumb)
    } else media.append(el('span', 'IG', 'wa-igc-thumb empty'))
    head.append(media)
    const info = el('div', undefined, 'wa-igc-post-info')
    info.append(el('p', first.caption ? first.caption.replace(/\s+/g, ' ') : t('Postingan'), 'wa-igc-caption'))
    const meta = el('span', t('{0} komentar', group.items.length), 'wa-igc-post-meta')
    const waiting = group.items.filter((entry) => NEEDS_REPLY.includes(entry.status)).length
    if (waiting) meta.append(' · ', el('b', t('{0} perlu dibalas', waiting), 'wa-igc-open'))
    if (first.mediaId || first.permalink)
      meta.append(
        ' · ',
        link(t('Lihat detail'), () =>
          document.dispatchEvent(new CustomEvent('ig:open-post', { detail: { mediaId: first.mediaId, permalink: first.permalink } }))
        )
      )
    info.append(meta)
    head.append(info)

    const main = group.items.filter((entry) => entry.status !== 'ignored')
    const others = group.items.filter((entry) => entry.status === 'ignored')
    const all = expanded.has(group.key)
    const visible = all ? [...main, ...others] : main.slice(0, SHOWN)
    const hidden = group.items.length - visible.length
    const thread = el('ol', undefined, 'wa-igc-thread')
    thread.append(...visible.map(item))
    if (hidden > 0 || all) {
      const more = el('li', undefined, 'wa-igc-item wa-igc-more')
      more.append(
        link(all ? t('Sembunyikan') : t('+{0} komentar lain', hidden), () => {
          if (all) expanded.delete(group.key)
          else expanded.add(group.key)
          render()
        })
      )
      if (all && group.items.length <= SHOWN && !others.length) more.remove()
      else thread.append(more)
    }
    node.append(head, thread)
    return node
  }

  let current = []
  function render() {
    const groups = new Map()
    for (const entry of current) {
      const key = entry.mediaId || entry.permalink || entry.caption || 'none'
      if (!groups.has(key)) groups.set(key, { key, items: [] })
      groups.get(key).items.push(entry)
    }
    byId('igcList').replaceChildren(...[...groups.values()].map(post))
  }

  let lastData = ''
  // Saat sedang menulis balasan, daftar tidak diganti supaya ketikan tidak hilang.
  const busy = () => [...root.querySelectorAll('.wa-igc-form')].some((form) => !form.hidden)
  async function load(auto = false) {
    if (auto && busy()) return
    const mine = ++seq
    const q = byId('igcSearch').value.trim()
    try {
      const data = await api(
        `/api/instagram/comments?status=${status}&q=${encodeURIComponent(q)}${media ? `&media=${encodeURIComponent(media.mediaId)}` : ''}`
      )
      if (mine !== seq) return
      const snapshot = JSON.stringify(data)
      if (auto && (snapshot === lastData || busy())) return
      lastData = snapshot
      const account = byId('igcAccount')
      if (account) account.textContent = data.connected ? `@${data.username}` : t('Instagram belum terhubung')
      for (const [key, value] of Object.entries(data.counts || {})) {
        const slot = root.querySelector(`[data-count="${key}"]`)
        if (slot) slot.textContent = value ? String(value) : ''
      }
      const list = byId('igcList')
      current = data.comments
      render()
      if (!data.comments.length)
        list.append(el('p', data.connected ? t('Belum ada komentar.') : t('Hubungkan Instagram di Pengaturan → Instagram.'), 'wa-muted'))
      badge()
    } catch (error) {
      if (mine === seq) notice(error.message, true)
    }
  }

  byId('igcTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-status]')
    if (!button) return
    status = button.dataset.status
    byId('igcTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
    load()
  })
  let timer
  byId('igcSearch').addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(load, 300)
  })
  byId('igcRefresh').addEventListener('click', () => {
    notice('')
    load()
  })
  document.addEventListener('ui-language:change', () => {
    lastData = ''
    load()
  })
  // Filter "komentar untuk postingan ini" (dari detail postingan di tab Konten).
  function showFilter() {
    const box = byId('igcMediaFilter')
    if (!box) return
    box.hidden = !media
    if (!media) return box.replaceChildren()
    const caption = (media.caption || '').replace(/\s+/g, ' ').trim()
    box.replaceChildren(
      el('span', t('Komentar untuk: {0}', caption ? (caption.length > 60 ? `${caption.slice(0, 60)}…` : caption) : t('Postingan'))),
      link(t('Tampilkan semua'), () => {
        media = null
        showFilter()
        load()
      })
    )
  }
  document.addEventListener('ig:comments-for', (event) => {
    media = event.detail?.mediaId ? event.detail : null
    showFilter()
    load()
  })
  document.addEventListener('ig:tab', (event) => event.detail?.tab === 'comments' && load())
  load()
  // Komentar baru muncul sendiri (cek tiap 8 detik saat tab Komentar terbuka).
  setInterval(() => document.visibilityState === 'visible' && active() && load(true), 8_000)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && active() && load(true))
})()
