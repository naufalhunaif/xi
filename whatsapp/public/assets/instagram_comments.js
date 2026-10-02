;(() => {
  const base = (document.querySelector('meta[name="app-url"]')?.content || '').replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const byId = (id) => document.getElementById(id)
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.redirected) throw new Error('Sesi berakhir. Muat ulang halaman.')
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Permintaan gagal.')
    return result
  }

  // Menu "Komentar" muncul bila Instagram terhubung; badge = komentar yang perlu dibalas.
  async function badge() {
    const nav = byId('commentsNav')
    if (!nav) return
    try {
      const state = await api('/api/instagram/comments/count')
      if (state.connected) nav.hidden = false
      const pill = byId('commentsBadge')
      if (pill) {
        pill.textContent = state.open ? String(state.open) : ''
        pill.hidden = !state.open
      }
    } catch {}
  }
  badge()
  setInterval(() => document.visibilityState === 'visible' && badge(), 20_000)

  const root = byId('igCommentsPage')
  if (!root) return
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined && text !== null) node.textContent = text
    if (className) node.className = className
    return node
  }
  const when = (value) =>
    value
      ? new Intl.DateTimeFormat('id-ID', {
          timeZone: 'Asia/Jakarta',
          day: '2-digit',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(value))
      : ''
  const STATUS = {
    pending: ['Diproses AI', 'warn'],
    processing: ['Diproses AI', 'warn'],
    replied: ['Dibalas lewat DM', 'ok'],
    cs: ['Perlu CS', 'err'],
    skipped: ['Belum dibalas', 'warn'],
    failed: ['Gagal', 'err'],
    ignored: ['Bukan pertanyaan', ''],
  }
  let status = 'all'
  let seq = 0
  const notice = (message, error = false) => {
    byId('igcNotice').textContent = message || ''
    byId('igcNotice').classList.toggle('error', Boolean(error))
  }

  function card(item) {
    const node = el('article', undefined, 'wa-igc-card')
    const head = el('header', undefined, 'wa-igc-head')
    head.append(el('strong', item.username ? `@${item.username}` : 'Instagram'), el('span', when(item.createdAt), 'wa-muted'))
    const [label, tone] = STATUS[item.status] || [item.status, '']
    head.append(el('span', label, `wa-pill ${tone}`))
    node.append(head)

    if (item.caption || item.permalink) {
      const post = el('div', undefined, 'wa-igc-post')
      post.append(el('span', item.caption ? `Postingan: ${item.caption.replace(/\s+/g, ' ').slice(0, 90)}` : 'Postingan'))
      if (item.permalink) {
        const link = el('a', 'Lihat postingan')
        link.href = item.permalink
        link.target = '_blank'
        link.rel = 'noopener'
        post.append(link)
      }
      node.append(post)
    }
    node.append(el('p', item.body, 'wa-igc-body'))
    if (item.reply) node.append(el('p', `DM: ${item.reply}`, 'wa-igc-reply'))
    if (item.publicReply) node.append(el('p', `Balasan di komentar: ${item.publicReply}`, 'wa-igc-reply'))
    if (item.error && item.status === 'failed') node.append(el('p', item.error, 'wa-igc-error'))

    const actions = el('div', undefined, 'wa-igc-actions')
    if (item.status === 'replied' || item.status === 'cs') {
      const open = el('a', 'Buka chat', 'button')
      open.href = `${base}/?jid=${encodeURIComponent(item.jid)}`
      actions.append(open)
    }
    const form = el('div', undefined, 'wa-igc-form')
    form.hidden = true
    const input = el('textarea')
    input.rows = 2
    input.placeholder = 'Tulis balasan…'
    const send = (via) => async () => {
      const text = input.value.trim()
      if (!text) return input.focus()
      form.querySelectorAll('button').forEach((b) => (b.disabled = true))
      try {
        await api(`/api/instagram/comments/${encodeURIComponent(item.id)}/reply`, 'POST', { text, via })
        notice(via === 'dm' ? 'Balasan DM terkirim.' : 'Balasan di komentar terkirim.')
        load()
      } catch (error) {
        notice(error.message, true)
        form.querySelectorAll('button').forEach((b) => (b.disabled = false))
      }
    }
    const row = el('div', undefined, 'wa-igc-form-actions')
    if (item.canDm) {
      const dm = el('button', 'Kirim DM', 'button primary')
      dm.type = 'button'
      dm.addEventListener('click', send('dm'))
      row.append(dm)
    }
    const pub = el('button', 'Balas di komentar', 'button')
    pub.type = 'button'
    pub.addEventListener('click', send('public'))
    row.append(pub)
    form.append(input, row)

    const reply = el('button', 'Balas', 'button')
    reply.type = 'button'
    reply.addEventListener('click', () => {
      form.hidden = !form.hidden
      if (!form.hidden) input.focus()
    })
    actions.append(reply)
    if (item.canDm && !['pending', 'processing'].includes(item.status)) {
      const ai = el('button', 'Balas pakai AI', 'button')
      ai.type = 'button'
      ai.addEventListener('click', async () => {
        ai.disabled = true
        try {
          await api(`/api/instagram/comments/${encodeURIComponent(item.id)}/ai`, 'POST', {})
          notice('AI sedang membalas lewat DM…')
          load()
        } catch (error) {
          notice(error.message, true)
          ai.disabled = false
        }
      })
      actions.append(ai)
    }
    node.append(actions, form)
    return node
  }

  let lastData = ''
  // Saat sedang menulis balasan, daftar tidak diganti supaya ketikan tidak hilang.
  const busy = () => [...root.querySelectorAll('.wa-igc-form')].some((form) => !form.hidden)
  async function load(auto = false) {
    if (auto && busy()) return
    const mine = ++seq
    const q = byId('igcSearch').value.trim()
    try {
      const data = await api(`/api/instagram/comments?status=${status}&q=${encodeURIComponent(q)}`)
      if (mine !== seq) return
      const snapshot = JSON.stringify(data)
      if (auto && (snapshot === lastData || busy())) return
      lastData = snapshot
      byId('igcAccount').textContent = data.connected ? `@${data.username}` : 'Instagram belum terhubung'
      for (const [key, value] of Object.entries(data.counts || {})) {
        const slot = root.querySelector(`[data-count="${key}"]`)
        if (slot) slot.textContent = value ? String(value) : ''
      }
      const list = byId('igcList')
      list.replaceChildren(...data.comments.map(card))
      if (!data.comments.length)
        list.append(el('p', data.connected ? 'Belum ada komentar.' : 'Hubungkan Instagram di Pengaturan → Instagram.', 'wa-muted'))
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
  load()
  // Komentar baru muncul sendiri (cek tiap 8 detik saat halaman terbuka).
  setInterval(() => document.visibilityState === 'visible' && load(true), 8_000)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load(true))
})()
