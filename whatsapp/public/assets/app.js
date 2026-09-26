;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const appUrl = document.querySelector('meta[name="app-url"]')?.content?.replace(/\/$/, '') || ''
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const byId = (id) => document.getElementById(id)
  const notice = byId('notice')
  async function api(path, options = {}) {
    const response = await fetch(`${appUrl}${path}`, {
      ...options,
      headers: {
        'accept': 'application/json',
        ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        'x-csrf-token': csrf,
        ...(options.headers || {}),
      },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(t(data.error || 'Permintaan gagal.'))
    return data
  }
  function showNotice(message, error = false) {
    if (!notice) return
    notice.textContent = message
    notice.classList.toggle('error', error)
    notice.hidden = !message
    if (message && !error)
      window.setTimeout(() => {
        notice.hidden = true
      }, 1800)
  }
  const launcherButton = byId('launcherButton')
  const launcherMenu = byId('launcherMenu')
  const launcherItems = launcherMenu ? [...launcherMenu.querySelectorAll('[role="menuitem"]')] : []
  function setLauncher(open, restoreFocus = false) {
    if (!launcherMenu || !launcherButton) return
    if (window.waMotion) window.waMotion.visible(launcherMenu, open)
    else launcherMenu.hidden = !open
    launcherButton.setAttribute('aria-expanded', String(open))
    if (!open && restoreFocus) launcherButton.focus()
  }
  launcherButton?.addEventListener('click', () => {
    setLauncher(launcherButton.getAttribute('aria-expanded') !== 'true')
  })
  launcherButton?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setLauncher(true)
      launcherItems[0]?.focus()
    }
  })
  launcherMenu?.addEventListener('keydown', (event) => {
    const current = launcherItems.indexOf(document.activeElement)
    let next = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = (current + 1) % launcherItems.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (current - 1 + launcherItems.length) % launcherItems.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = launcherItems.length - 1
    if (next !== null) {
      event.preventDefault()
      launcherItems[next]?.focus()
    }
  })
  document.addEventListener('click', (event) => {
    if (
      launcherMenu &&
      launcherButton &&
      !launcherMenu.contains(event.target) &&
      !launcherButton.contains(event.target)
    )
      setLauncher(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && launcherMenu && !launcherMenu.hidden) setLauncher(false, true)
  })

  const statusLabels = {
    disconnected: t('Terputus'),
    connecting: t('Menghubungkan'),
    qr: t('Scan QR'),
    connected: t('Terhubung'),
    error: t('Belum terhubung'),
    worker_offline: t('Belum terhubung'),
  }
  document.addEventListener('ui-language:change', () => {
    for (const key of Object.keys(statusLabels)) statusLabels[key] = t(statusLabels[key])
    updateStatus()
    updateContacts()
    updateOAuth()
    updateClaudeOAuth()
    updateMcpOAuth()
    updateCodexStatus()
    updateClaudeStatus()
  })
  // Koneksi dikelola di Pengaturan → Nomor; chat hanya menampilkan tautan bila belum terhubung.
  function renderConnectionStatus(status, phone = '', linesConnected = 0) {
    const label = statusLabels[status] || t('Belum terhubung')
    const digits = String(phone || '').replace(/\D/g, '')
    const number = digits.startsWith('62')
      ? digits.replace(/^62(\d{3})(\d{4})(\d{1,4})$/, '+62 $1 $2 $3')
      : digits
    const hint = byId('connectHint')
    if (hint) hint.hidden = status === 'connected' || linesConnected > 0
    if (!byId('statusText')) return
    byId('statusText').textContent = label
    byId('phoneText').textContent = number || t('Belum ada nomor terhubung')
    const tone = status === 'connected' ? 'ok' : ['connecting', 'qr'].includes(status) ? 'warn' : 'err'
    byId('statusPill').className = `wa-pill ${tone}`
  }
  async function updateStatus() {
    try {
      const state = await api('/api/status')
      const status = String(state.status || 'disconnected')
      renderConnectionStatus(status, state.phone, Number(state.linesConnected || 0))
      const badge = byId('ordersBadge')
      if (badge && state.pendingOrders !== undefined) {
        badge.textContent = String(state.pendingOrders)
        badge.hidden = !Number(state.pendingOrders)
      }
      if (!byId('connectButton')) return
      byId('qrPanel').hidden = !(status === 'qr' && state.qr_data_url)
      if (state.qr_data_url) byId('qrImage').src = state.qr_data_url
      const canDisconnect =
        ['connected', 'connecting', 'qr'].includes(status) || Boolean(state.desired_connected)
      byId('connectButton').hidden = canDisconnect
      byId('connectButton').disabled = status === 'worker_offline'
      byId('disconnectButton').hidden = !canDisconnect
    } catch {
      renderConnectionStatus('disconnected')
    }
  }
  async function connectionAction(path) {
    try {
      await api(path, { method: 'POST', body: '{}' })
      await updateStatus()
    } catch {
      showNotice(t('Belum bisa terhubung.'), true)
    }
  }
  byId('connectButton')?.addEventListener('click', () => connectionAction('/api/connect'))
  byId('disconnectButton')?.addEventListener('click', () => {
    if (!window.confirm(t('Putuskan nomor utama? Chat yang sudah ada tetap tersimpan.'))) return
    void connectionAction('/api/disconnect')
  })
  const messages = byId('messages')
  const messageList = byId('messageList')
  const compareMessages = (left, right) =>
    ((Date.parse(left.created_at) || 0) - (Date.parse(right.created_at) || 0)) ||
    Number(left.id) - Number(right.id)
  let loadedMessages = []
  let latestRenderedMessage = null
  let adjustingMessageScroll = 0
  let updatingMessages = false
  let messageCursor = null
  let olderMessageCursor = null
  let hasOlderMessages = true
  let loadingOlderMessages = false
  let unreadBoundaryId = null
  let stickToLatest = true
  let readRequestPending = false
  let lastAcknowledgedId = 0
  async function acknowledgeVisibleRoom() {
    if (!messages?.dataset.jid || document.hidden || !document.hasFocus() || readRequestPending)
      return
    const bounds = messages.getBoundingClientRect()
    if (!messages.clientHeight || bounds.bottom <= 0 || bounds.top >= window.innerHeight) return
    if (messages.scrollHeight - messages.scrollTop - messages.clientHeight >= 80) return
    const throughId = Number(messages.dataset.lastId || 0)
    if (!throughId || throughId <= lastAcknowledgedId) return
    readRequestPending = true
    try {
      await api('/api/contacts/read', {
        method: 'POST',
        body: JSON.stringify({ jid: messages.dataset.jid, throughId }),
      })
      lastAcknowledgedId = throughId
      await updateContacts()
    } catch {
    } finally {
      readRequestPending = false
    }
  }
  window.addEventListener('focus', () => void acknowledgeVisibleRoom())
  document.addEventListener('visibilitychange', () => void acknowledgeVisibleRoom())
  function scrollMessagesToLatest() {
    if (!messages || !stickToLatest) return
    setMessageScroll(messages.scrollHeight)
  }
  function setMessageScroll(top) {
    const adjustment = ++adjustingMessageScroll
    messages.scrollTop = top
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (adjustingMessageScroll === adjustment) adjustingMessageScroll = 0
    }))
  }
  function messageElement(message) {
    const article = document.createElement('article')
    const senderType = message.sender_type || (message.direction === 'out' ? 'cs' : 'customer')
    article.className = `message ${message.direction === 'out' ? 'out' : 'in'} source-${senderType} ${message.media_type ? 'has-media' : ''}`
    article.dataset.id = String(message.id)
    article.dataset.messageId = message.message_id
    article.dataset.body = message.body || message.media_type || 'Media'

    const actions = document.createElement('div')
    actions.className = 'message-actions'
    const replyButton = document.createElement('button')
    replyButton.type = 'button'
    replyButton.dataset.reply = ''
    replyButton.ariaLabel = 'Reply'
    replyButton.textContent = '↩'
    const reactionToggle = document.createElement('button')
    reactionToggle.type = 'button'
    reactionToggle.dataset.reactionToggle = ''
    reactionToggle.ariaLabel = 'Reaction'
    reactionToggle.textContent = '☺'
    const picker = document.createElement('div')
    picker.className = 'reaction-picker'
    picker.hidden = true
    for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🙏']) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.reaction = emoji
      button.textContent = emoji
      picker.append(button)
    }
    actions.append(replyButton, reactionToggle, picker)
    article.append(actions)

    if (message.reply) {
      const reply = document.createElement('div')
      reply.className = 'message-reply-preview'
      reply.textContent = message.reply.body || message.reply.media_type || 'Media'
      article.append(reply)
    }
    if (message.media_type) {
      const mediaWrap = document.createElement('div')
      mediaWrap.className = 'message-media-wrap'
      const source = message.media_url || message.thumbnail_url
      if (message.media_url && message.media_type === 'document') {
        const link = document.createElement('a')
        link.className = 'message-document'
        link.href = message.media_url
        link.download = message.media_name || t('Dokumen')
        link.textContent = `${message.media_name || t('Dokumen')} ↓`
        mediaWrap.append(link)
      } else if (message.media_url && message.media_type === 'audio') {
        const audio = document.createElement('audio')
        audio.className = 'message-audio'
        audio.src = message.media_url
        audio.controls = true
        audio.preload = 'metadata'
        mediaWrap.append(audio)
      } else if (message.media_url && ['gif', 'video'].includes(message.media_type)) {
        const video = document.createElement('video')
        video.className = 'message-media'
        video.src = message.media_url
        if (message.thumbnail_url) video.poster = message.thumbnail_url
        video.playsInline = true
        if (message.media_type === 'gif') {
          video.autoplay = true
          video.loop = true
          video.muted = true
        } else {
          video.controls = true
          video.preload = 'metadata'
        }
        mediaWrap.append(video)
      } else if (source) {
        const image = document.createElement('img')
        image.className = `message-media ${message.media_type === 'sticker' ? 'sticker' : ''} ${!message.media_url ? 'thumbnail' : ''}`
        image.src = source
        image.alt = ''
        mediaWrap.append(image)
      } else if (['audio', 'document', 'location', 'contact'].includes(message.media_type)) {
        // Jenis non-foto tanpa berkas: tampilkan keterangan singkat, bukan kotak kosong.
        const chip = document.createElement('div')
        chip.className = 'message-document'
        chip.textContent = {
          audio: t('Pesan suara'),
          document: message.media_name || t('Dokumen'),
          location: t('Lokasi'),
          contact: t('Kontak'),
        }[message.media_type]
        mediaWrap.append(chip)
      } else {
        const placeholder = document.createElement('div')
        placeholder.className = 'message-media-placeholder'
        placeholder.ariaHidden = 'true'
        mediaWrap.append(placeholder)
      }
      // Media lama yang sudah tidak ada di server cukup ditandai netral, bukan "gagal".
      const mediaLabel = {
        downloading: t('Mengunduh…'),
        later: t('Media lama'),
        failed: t('Media lama'),
        expired: t('Media lama'),
      }[message.media_status]
      if (mediaLabel && !message.media_url) {
        const state = document.createElement('span')
        state.className = 'message-media-state'
        state.textContent = mediaLabel
        mediaWrap.append(state)
      }
      article.append(mediaWrap)
    }
    const meta = document.createElement('div')
    meta.className = 'message-meta'
    if (message.direction === 'out') {
      const source = document.createElement('span')
      source.className = 'message-source-badge'
      source.textContent = senderType === 'ai' ? 'AI' : 'CS'
      meta.append(source)
    } else {
      // Riwayat sering tanpa nama pengirim: pakai nama room, jangan tampilkan ID internal.
      const roomTitle = byId('roomName')?.textContent?.trim()
      meta.textContent = message.contact_name || roomTitle || fallbackName(message.jid)
    }
    article.append(meta)
    if (message.body) {
      const body = document.createElement('div')
      body.className = 'message-body'
      body.textContent = message.body
      article.append(body)
    }
    const footer = document.createElement('div')
    footer.className = 'message-footer'
    const reactions = document.createElement('span')
    reactions.className = 'message-reactions'
    for (const reaction of message.reactions || []) {
      const emoji = document.createElement('span')
      emoji.textContent = reaction.emoji
      reactions.append(emoji)
    }
    footer.append(reactions)
    if (message.direction === 'out') {
      const status = document.createElement('span')
      status.className = `message-status ${message.status}`
      status.title = message.status
      status.textContent = ['read', 'delivered'].includes(message.status)
        ? '✓✓'
        : message.status === 'failed'
          ? '!'
          : '✓'
      footer.append(status)
    }
    article.append(footer)
    if (message.trace_id) {
      const detail = document.createElement('button')
      detail.type = 'button'
      detail.className = 'wa-trace-link'
      detail.dataset.traceId = message.trace_id
      detail.textContent = t('Detail proses')
      article.append(detail)
    }
    if (message.direction === 'out' && senderType === 'ai' && message.body) {
      // Koreksi pemilik: jadi contoh jawaban / aturan toko + kasus uji (quality.js).
      const correct = document.createElement('button')
      correct.type = 'button'
      correct.className = 'wa-trace-link wa-correct-link'
      correct.dataset.correctId = String(message.id)
      correct.textContent = t('Koreksi')
      article.append(correct)
    }
    return article
  }
  function renderMessages(items) {
    if (!messages) return
    const signature = JSON.stringify(
      items.map((message) => [
        message.id,
        message.created_at,
        message.status,
        message.sender_type,
        message.trace_id,
        message.body,
        message.media_url,
        message.thumbnail_url,
        message.media_status,
        message.reply_to_message_id,
        (message.reactions || []).map((reaction) => reaction.emoji),
      ])
    )
    if (messages.dataset.signature === signature) return
    messages.dataset.signature = signature
    const newest = items.at(-1)
    const firstNew = newest && (!latestRenderedMessage || compareMessages(newest, latestRenderedMessage) > 0)
    const shouldFollowLatest = (stickToLatest || Boolean(firstNew)) && !roomSearchHoldsView()
    latestRenderedMessage = newest || null
    if (shouldFollowLatest) stickToLatest = true
    const anchor = [...messages.querySelectorAll('.message')].find(
      (message) => message.getBoundingClientRect().bottom > messages.getBoundingClientRect().top
    )
    const anchorId = anchor?.dataset.id
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top : 0
    if (shouldFollowLatest) unreadBoundaryId = null
    // Ignore scroll clamping caused by replacing a long list with an empty one.
    setMessageScroll(messages.scrollTop)
    messageList.replaceChildren()
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'wa-empty'
      empty.textContent = t('Pilih kontak')
      messageList.append(empty)
      return
    }
    for (const message of items) {
      if (String(message.id) === unreadBoundaryId) {
        const divider = document.createElement('div')
        divider.className = 'new-message-divider'
        divider.textContent = t('Pesan baru')
        messageList.append(divider)
      }
      messageList.append(messageElement(message))
    }
    messages.dataset.lastId = String(items.reduce((max, item) => Math.max(max, Number(item.id)), 0))
    if (shouldFollowLatest) {
      scrollMessagesToLatest()
      window.requestAnimationFrame(scrollMessagesToLatest)
    } else if (anchorId) {
      const nextAnchor = messages.querySelector(`.message[data-id="${CSS.escape(anchorId)}"]`)
      if (nextAnchor) setMessageScroll(messages.scrollTop + nextAnchor.getBoundingClientRect().top - messages.getBoundingClientRect().top - anchorOffset)
    }
    applyRoomSearch(false)
  }
  async function updateMessages() {
    if (!messages || updatingMessages) return
    const jid = messages.dataset.jid || ''
    if (!jid) return
    updatingMessages = true
    let catchUp = false
    try {
      const data = await api(`/api/messages?jid=${encodeURIComponent(jid)}&latest=1`)
      const wasEmpty = loadedMessages.length === 0
      // Refresh recent statuses, but page forward from our cursor too: a burst
      // larger than the latest page must not leave a permanent hole in the room.
      const newer =
        messageCursor === null
          ? null
          : await api(`/api/messages?jid=${encodeURIComponent(jid)}&after=${messageCursor}`)
      const merged = new Map(loadedMessages.map((message) => [String(message.id), message]))
      for (const message of data.messages || []) merged.set(String(message.id), message)
      for (const message of newer?.messages || []) merged.set(String(message.id), message)
      if (messageCursor === null)
        messageCursor = data.syncCursor ?? Math.max(0, ...(data.messages || []).map((item) => Number(item.id)))
      else if (newer?.messages?.length)
        messageCursor = Math.max(messageCursor, ...newer.messages.map((item) => Number(item.id)))
      catchUp = Boolean(newer?.hasMore)
      loadedMessages = [...merged.values()].sort(compareMessages)
      if (wasEmpty) {
        hasOlderMessages = Boolean(data.hasMore)
        olderMessageCursor = data.messages?.[0]?.id || null
      }
      renderMessages(loadedMessages)
      window.requestAnimationFrame(() => void acknowledgeVisibleRoom())
      if (wasEmpty && hasOlderMessages) {
        window.setTimeout(() => void loadOlderMessages(), 150)
      }
    } catch {
    } finally {
      updatingMessages = false
      if (catchUp) window.setTimeout(() => void updateMessages(), 150)
    }
  }
  async function loadOlderMessages() {
    if (!messages || loadingOlderMessages || !hasOlderMessages) return
    const jid = messages.dataset.jid || ''
    const oldestId = olderMessageCursor
    if (!jid || !oldestId) return
    loadingOlderMessages = true
    try {
      const data = await api(
        `/api/messages?jid=${encodeURIComponent(jid)}&before=${encodeURIComponent(oldestId)}`
      )
      const merged = new Map(loadedMessages.map((message) => [String(message.id), message]))
      for (const message of data.messages || []) merged.set(String(message.id), message)
      loadedMessages = [...merged.values()].sort(compareMessages)
      hasOlderMessages = Boolean(data.hasMore)
      olderMessageCursor = data.messages?.[0]?.id || null
      renderMessages(loadedMessages)
    } catch {
    } finally {
      loadingOlderMessages = false
      if (hasOlderMessages) window.setTimeout(() => void loadOlderMessages(), 150)
    }
  }
  if (messages) {
    scrollMessagesToLatest()
    window.requestAnimationFrame(scrollMessagesToLatest)
    messages.addEventListener('scroll', () => {
      if (!adjustingMessageScroll)
        stickToLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
      if (!stickToLatest) return
      unreadBoundaryId = null
      messages.querySelector('.new-message-divider')?.remove()
      void acknowledgeVisibleRoom()
    })
    const followLoadedMedia = (event) => {
      if (!stickToLatest || !event.target.matches?.('img, video')) return
      window.requestAnimationFrame(scrollMessagesToLatest)
    }
    messages.addEventListener('load', followLoadedMedia, true)
    messages.addEventListener('loadedmetadata', followLoadedMedia, true)
    // Font/media loading and composer/layout resizing can change height after render.
    // Observe the list, not just the viewport, to keep the newest bubble visible.
    const messageResizeObserver = new ResizeObserver(scrollMessagesToLatest)
    messageResizeObserver.observe(messages)
    if (messageList) messageResizeObserver.observe(messageList)
  }
  const contacts = byId('contacts')
  // ID internal WhatsApp (@lid) bukan nomor HP; jangan ditampilkan seolah nomor.
  const fallbackName = (jid) =>
    String(jid).endsWith('@lid') ? t('Tanpa nama') : `+${String(jid).split('@')[0]}`
  const inboxKeys = ['all', 'ai', 'cs', 'payment', 'order']
  // Pencarian kotak masuk: nama, nomor, pratinjau (langsung) + isi chat (server).
  const normalizeSearch = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
  const searchDigits = (value) => {
    const digits = String(value || '').replace(/\D/g, '')
    return digits.startsWith('0') ? `62${digits.slice(1)}` : digits
  }
  let inboxQuery = normalizeSearch(new URLSearchParams(location.search).get('q'))
  let inboxSearchHits = new Map()
  function inboxState() {
    const params = new URLSearchParams(location.search)
    return {
      filter: inboxKeys.includes(params.get('inbox')) ? params.get('inbox') : 'all',
      unanswered: params.get('unanswered') === '1',
    }
  }
  function applyInboxFilters() {
    if (!contacts || !byId('inboxFilters')) return
    const state = inboxState()
    const rows = [...contacts.querySelectorAll('.wa-contact')]
    const matches = (row, key) =>
      key === 'all' ||
      (key === 'ai' && row.dataset.mode !== 'cs') ||
      (key === 'cs' && row.dataset.mode === 'cs') ||
      (key === 'payment' && row.dataset.payment === 'true') ||
      (key === 'order' && row.dataset.order === 'true')
    document.querySelectorAll('[data-inbox-filter]').forEach((button) => {
      const key = button.dataset.inboxFilter
      button.setAttribute('aria-pressed', String(key === state.filter))
      const count = rows.filter((row) => matches(row, key)).length
      button.querySelector('[data-filter-count]').textContent = String(count)
      button.title = t("{0} percakapan{1}", count, key === 'payment' ? t(' menunggu konfirmasi pembayaran') : '')
    })
    byId('unansweredFilter').setAttribute('aria-pressed', String(state.unanswered))
    byId('unansweredCount').textContent = String(
      rows.filter((row) => matches(row, state.filter) && Number(row.dataset.unanswered) > 0).length
    )
    let visible = 0
    const queryDigits = searchDigits(inboxQuery)
    for (const row of rows) {
      const preview = row.querySelector('.wa-contact-content small')
      const hit = inboxQuery ? inboxSearchHits.get(row.dataset.jid) : null
      if (inboxQuery) {
        // Saat mencari, semua tab ikut dicari.
        const text = row.dataset.search || ''
        const byText = text.includes(inboxQuery)
        const byNumber = queryDigits.length >= 3 && (row.dataset.digits || '').includes(queryDigits)
        row.hidden = !(byText || byNumber || hit)
        if (preview && hit && !byText && !byNumber) {
          preview.textContent = hit.snippet
          preview.classList.add('search-snippet')
        }
      } else {
        row.hidden = !matches(row, state.filter) || (state.unanswered && !Number(row.dataset.unanswered))
      }
      if (preview && (!hit || !inboxQuery) && preview.classList.contains('search-snippet')) {
        preview.textContent = row.dataset.preview || ''
        preview.classList.remove('search-snippet')
      }
      if (!row.hidden) visible++
      const url = new URL(row.href)
      url.searchParams.delete('inbox')
      url.searchParams.delete('unanswered')
      url.searchParams.delete('q')
      if (state.filter !== 'all') url.searchParams.set('inbox', state.filter)
      if (state.unanswered) url.searchParams.set('unanswered', '1')
      if (inboxQuery) url.searchParams.set('q', inboxQuery)
      row.href = url.href
    }
    // Going back from a room keeps the queue the chat was opened from.
    const back = byId('roomBack')
    if (back) {
      const backUrl = new URL(back.href)
      backUrl.searchParams.delete('jid')
      backUrl.searchParams.delete('inbox')
      backUrl.searchParams.delete('unanswered')
      if (state.filter !== 'all') backUrl.searchParams.set('inbox', state.filter)
      if (state.unanswered) backUrl.searchParams.set('unanswered', '1')
      back.href = backUrl.href
    }
    contacts.querySelectorAll('.wa-empty').forEach((element) => element.remove())
    if (!visible) {
      const empty = document.createElement('div')
      empty.className = 'wa-empty'
      empty.textContent = inboxQuery
        ? t('Tidak ada hasil')
        : state.unanswered
        ? t('Semua sudah dibalas')
        : state.filter === 'all' ? t('Belum ada kontak') : t('Tidak ada percakapan di tab ini')
      contacts.append(empty)
    }
  }
  // Filter kotak masuk: geser ke samping; panah ▾ membuka semua bila tidak muat.
  const inboxMore = byId('inboxFiltersMore')
  const inboxTabs = document.querySelector('#inboxFilters .wa-inbox-tabs')
  function syncInboxMore() {
    if (!inboxMore || !inboxTabs) return
    const expanded = inboxMore.getAttribute('aria-expanded') === 'true'
    inboxMore.hidden = !expanded && inboxTabs.scrollWidth <= inboxTabs.clientWidth + 2
  }
  inboxMore?.addEventListener('click', () => {
    const open = inboxMore.getAttribute('aria-expanded') !== 'true'
    inboxMore.setAttribute('aria-expanded', String(open))
    byId('inboxFilters').classList.toggle('expanded', open)
    syncInboxMore()
  })
  window.addEventListener('resize', syncInboxMore)
  setTimeout(syncInboxMore, 0)
  setTimeout(syncInboxMore, 1500)
  byId('inboxFilters')?.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button || button.id === 'inboxFiltersMore') return
    const state = inboxState()
    const url = new URL(location.href)
    if (button.dataset.inboxFilter) {
      url.searchParams.set('inbox', button.dataset.inboxFilter)
      // Switching queues shows all work, including payments already acknowledged in chat.
      url.searchParams.delete('unanswered')
    } else if (button.id === 'unansweredFilter') {
      if (state.unanswered) url.searchParams.delete('unanswered')
      else url.searchParams.set('unanswered', '1')
    }
    history.replaceState(null, '', url)
    applyInboxFilters()
  })
  window.addEventListener('popstate', applyInboxFilters)
  const inboxSearch = byId('inboxSearch')
  let inboxSearchTimer
  let inboxSearchVersion = 0
  async function fetchInboxSearch() {
    const version = ++inboxSearchVersion
    if (inboxQuery.length < 2) {
      inboxSearchHits = new Map()
      return applyInboxFilters()
    }
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(inboxQuery)}`)
      if (version !== inboxSearchVersion) return
      inboxSearchHits = new Map((data.hits || []).map((hit) => [hit.jid, hit]))
      applyInboxFilters()
    } catch {}
  }
  if (inboxSearch) {
    inboxSearch.value = new URLSearchParams(location.search).get('q') || ''
    inboxSearch.addEventListener('input', () => {
      inboxQuery = normalizeSearch(inboxSearch.value)
      const url = new URL(location.href)
      if (inboxQuery) url.searchParams.set('q', inboxSearch.value.trim())
      else url.searchParams.delete('q')
      history.replaceState(null, '', url)
      applyInboxFilters()
      clearTimeout(inboxSearchTimer)
      inboxSearchTimer = setTimeout(() => void fetchInboxSearch(), 300)
    })
    inboxSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && inboxSearch.value) {
        inboxSearch.value = ''
        inboxSearch.dispatchEvent(new Event('input'))
      }
    })
    if (inboxQuery) void fetchInboxSearch()
  }
  applyInboxFilters()
  let contactsRequestVersion = 0
  function renderContacts(items) {
    if (!contacts) return
    const selectedJid = contacts.dataset.selectedJid || ''
    contacts.replaceChildren()
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'wa-empty'
      empty.textContent = t('Belum ada kontak')
      contacts.append(empty)
      applyInboxFilters()
      return
    }
    for (const contact of items) {
      const name = contact.contact_name || fallbackName(contact.jid)
      const link = document.createElement('a')
      link.className = `wa-contact ${contact.jid === selectedJid ? 'active' : ''}`
      link.classList.toggle('ai-running', contact.ai_running === true)
      link.href = `${appUrl}/?jid=${encodeURIComponent(contact.jid)}`
      link.dataset.jid = contact.jid
      link.dataset.mode = contact.handling_mode || 'ai'
      link.dataset.payment = String(Boolean(contact.needs_payment))
      link.dataset.order = String(Boolean(contact.has_order))
      link.dataset.unanswered = String(Number(contact.unanswered_count) || 0)
      link.dataset.preview = contact.activity || contact.body || ''
      link.dataset.search = normalizeSearch(`${name} ${contact.contact_name || ''} ${contact.body || ''}`)
      link.dataset.digits = `${searchDigits(contact.jid)} ${searchDigits(contact.phone_jid)}`
      const avatar = contact.profile_picture_url
        ? document.createElement('img')
        : document.createElement('span')
      avatar.className = 'wa-contact-avatar'
      if (contact.profile_picture_url) {
        avatar.src = contact.profile_picture_url
        avatar.alt = ''
        avatar.loading = 'lazy'
        avatar.addEventListener(
          'error',
          () => {
            const fallback = document.createElement('span')
            fallback.className = 'wa-contact-avatar'
            fallback.textContent = String(name).slice(0, 1).toUpperCase()
            avatar.replaceWith(fallback)
          },
          { once: true }
        )
      } else {
        avatar.textContent = String(name).slice(0, 1).toUpperCase()
      }
      const content = document.createElement('span')
      content.className = 'wa-contact-content'
      const title = document.createElement('strong')
      title.textContent = name
      if (contact.line_label) {
        const chip = document.createElement('span')
        chip.className = 'wa-line-chip'
        chip.title = t('Nomor penerima')
        chip.textContent = contact.line_label
        title.append(chip)
      }
      const preview = document.createElement('small')
      preview.textContent = contact.activity || contact.body || ''
      preview.classList.toggle('active', Boolean(contact.activity))
      content.append(title, preview)
      const mode = document.createElement('span')
      mode.className = `wa-contact-mode ${contact.handling_mode === 'cs' ? 'cs' : 'ai'}`
      mode.textContent = contact.handling_mode === 'cs' ? 'CS' : 'AI'
      const meta = document.createElement('span')
      meta.className = 'wa-contact-meta'
      if (Number(contact.unanswered_count) > 0) {
        const pending = document.createElement('span')
        pending.className = 'wa-contact-pending'
        pending.textContent = `${contact.unanswered_count} ↩`
        pending.title = t("{0} pesan belum dibalas", contact.unanswered_count)
        pending.setAttribute('aria-label', pending.title)
        meta.append(pending)
      }
      const unread = Math.max(0, Number(contact.unread_count) || 0)
      if (unread) {
        const badge = document.createElement('span')
        badge.className = 'wa-unread-count'
        badge.textContent = String(unread)
        badge.setAttribute('aria-label', t("{0} pesan belum dibaca", unread))
        meta.append(badge)
      }
      meta.append(mode)
      link.append(avatar, content, meta)
      contacts.append(link)
    }
    applyInboxFilters()
  }
  async function updateContacts() {
    if (!contacts) return
    const version = ++contactsRequestVersion
    try {
      const data = await api('/api/contacts')
      if (version !== contactsRequestVersion) return
      renderContacts(data.contacts || [])
      const selected = (data.contacts || []).find(
        (contact) => contact.jid === contacts.dataset.selectedJid
      )
      updateRoomMode(selected?.handling_mode || 'ai', Boolean(selected), Boolean(selected?.ai_excluded), Boolean(selected?.schedule_paused))
      updateRoomDetails(selected)
      const goalStatus = byId('roomGoalStatus')
      if (goalStatus) {
        goalStatus.textContent =
          {
            waiting: t('Menunggu'),
            waiting_answer: t('Menunggu jawaban'),
            waiting_payment: t('Menunggu pembayaran'),
            waiting_approval: t('Menunggu persetujuan'),
            waiting_cs: '',
            completed: t('Selesai'),
            paused: t('Dijeda'),
            retrying: t('Menunggu percobaan ulang'),
          }[selected?.goal_status] || ''
        goalStatus.title = selected?.goal_status === 'retrying' && selected?.goal_retry_at
          ? `${t('Percobaan ulang')}: ${new Date(selected.goal_retry_at).toLocaleString()}`
          : selected?.goal_waiting_for || ''
      }
      if (selected) {
        const name = selected.contact_name || fallbackName(selected.jid)
        if (byId('roomName')) {
          byId('roomName').textContent = name
          byId('roomName').title = name
        }
        const currentAvatar = byId('roomAvatar')
        if (selected.profile_picture_url && currentAvatar?.tagName === 'IMG') {
          if (currentAvatar.getAttribute('src') !== selected.profile_picture_url)
            currentAvatar.src = selected.profile_picture_url
        } else if (selected.profile_picture_url) {
          const avatar = document.createElement('img')
          avatar.id = 'roomAvatar'
          avatar.className = 'wa-room-avatar'
          avatar.src = selected.profile_picture_url
          avatar.alt = ''
          currentAvatar?.replaceWith(avatar)
        }
      }
    } catch {}
  }
  function updateRoomMode(mode, visible = true, excluded = false, schedulePaused = false) {
    const handling = byId('roomHandling')
    const badge = byId('roomMode')
    const button = byId('roomModeButton')
    if (!handling || !badge || !button) return
    const selectedMode = mode === 'cs' ? 'cs' : 'ai'
    if (!visible || handling.dataset.mode !== selectedMode) closeRoomDetails()
    handling.hidden = !visible
    if (byId('roomStatus')) byId('roomStatus').hidden = !visible
    if (byId('roomGoalStatus')) byId('roomGoalStatus').textContent = ''
    handling.dataset.mode = selectedMode
    handling.dataset.schedulePaused = String(schedulePaused)
    badge.className = `wa-room-mode ${selectedMode}`
    badge.textContent = excluded ? t('Tanpa AI') : selectedMode === 'cs' ? t('Ditangani CS') : t('Ditangani AI')
    button.textContent = selectedMode === 'cs' ? t('Aktifkan AI') : t('Ambil alih')
    button.disabled = excluded || schedulePaused
    button.title = excluded ? t('Hapus dari daftar Jangan dibalas AI terlebih dahulu') : schedulePaused ? t('Di luar jam kerja AI') : ''
    const exclusion = byId('roomExclusionButton')
    if (exclusion) {
      exclusion.setAttribute('aria-pressed', String(excluded))
      exclusion.title = excluded ? t('Hapus dari daftar Jangan dibalas AI') : t('Jangan dibalas AI')
      exclusion.setAttribute('aria-label', exclusion.title)
    }
  }
  let roomDetailsContact = null
  function closeRoomDetails(restoreFocus = false) {
    const panel = byId('roomHandlingDetails')
    if (!panel || panel.hidden) return
    panel.hidden = true
    byId('roomMode')?.setAttribute('aria-expanded', 'false')
    if (byId('roomMode')) byId('roomMode').title = byId('roomMode').dataset.summary || ''
    if (restoreFocus) byId('roomMode')?.focus()
  }
  function positionRoomDetails() {
    const panel = byId('roomHandlingDetails')
    const badge = byId('roomMode')
    if (!panel || panel.hidden || !badge) return
    const rect = badge.getBoundingClientRect()
    panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 12))}px`
    const top = rect.bottom + 8 + panel.offsetHeight <= window.innerHeight - 12
      ? rect.bottom + 8 : rect.top - panel.offsetHeight - 8
    panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - panel.offsetHeight - 12))}px`
  }
  function updateRoomDetails(contact) {
    roomDetailsContact = contact
    const badge = byId('roomMode')
    const body = byId('roomHandlingDetailsBody')
    if (!badge || !body) return
    if (!contact) { closeRoomDetails(); return }
    const cs = contact.handling_mode === 'cs'
    const rawReason = cs && !contact.ai_excluded ? String(contact.handoff_reason || '').trim() : ''
    const reason = contact.schedule_paused ? t(rawReason) : rawReason
    const fallback = contact.ai_excluded ? t('Kontak ini dikecualikan dari balasan AI.')
      : cs ? t('Percakapan ini ditangani CS. Belum ada alasan pengalihan tercatat.')
        : t('Percakapan ini ditugaskan ke AI.')
    const fields = [[reason ? t('Alasan pengalihan') : t('Penanganan'), reason || fallback]]
    if (!contact.ai_excluded && (!cs || reason)) {
      if (contact.goal_waiting_for) fields.push([t('Kebutuhan yang menunggu'), contact.goal_waiting_for])
      if (contact.goal_next_action) fields.push([t('Langkah berikutnya'), contact.goal_next_action])
      if (reason && contact.handling_note && contact.handling_note.trim() !== reason)
        fields.push([t('Catatan internal'), contact.handling_note])
    }
    badge.dataset.summary = reason || fallback
    badge.title = byId('roomHandlingDetails')?.hidden ? badge.dataset.summary : ''
    badge.setAttribute('aria-label', t('Detail penanganan: {0}', badge.textContent.trim()))
    // Business context is untrusted plain text, never HTML or automatically translated.
    const signature = JSON.stringify(fields)
    if (body.dataset.signature !== signature) {
      body.dataset.signature = signature
      const list = document.createElement('dl')
      for (const [label, value] of fields) {
        const term = document.createElement('dt')
        const detail = document.createElement('dd')
        term.textContent = label
        detail.textContent = value
        list.append(term, detail)
      }
      body.replaceChildren(list)
    }
    positionRoomDetails()
  }
  byId('roomMode')?.addEventListener('click', () => {
    const panel = byId('roomHandlingDetails')
    if (!panel || !roomDetailsContact) return
    if (!panel.hidden) return closeRoomDetails()
    panel.hidden = false
    byId('roomMode').setAttribute('aria-expanded', 'true')
    byId('roomMode').title = ''
    positionRoomDetails()
    window.waMotion?.enter(panel)
  })
  byId('roomHandlingDetailsClose')?.addEventListener('click', () => closeRoomDetails(true))
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#roomMode, #roomHandlingDetails')) closeRoomDetails()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !byId('roomHandlingDetails')?.hidden) closeRoomDetails(true)
  })
  window.addEventListener('resize', positionRoomDetails)
  window.addEventListener('scroll', positionRoomDetails, true)
  if (byId('roomMode')) updateRoomDetails({
    handling_mode: byId('roomHandling')?.dataset.mode,
    ai_excluded: byId('roomExclusionButton')?.getAttribute('aria-pressed') === 'true',
    handoff_reason: byId('roomMode').dataset.reason,
    schedule_paused: byId('roomMode').dataset.schedulePaused === 'true',
    handling_note: byId('roomMode').dataset.note,
    goal_waiting_for: byId('roomMode').dataset.waiting,
    goal_next_action: byId('roomMode').dataset.next,
  })
  document.addEventListener('ai-exclusions:updated', () => void updateContacts())
  byId('roomModeButton')?.addEventListener('click', async () => {
    const handling = byId('roomHandling')
    const jid = messages?.dataset.jid || ''
    if (!handling || !jid) return
    const mode = handling.dataset.mode === 'cs' ? 'ai' : 'cs'
    const button = byId('roomModeButton')
    button.disabled = true
    try {
      await api('/api/contacts/mode', {
        method: 'POST',
        body: JSON.stringify({ jid, mode }),
      })
      updateRoomMode(mode)
      await updateContacts()
    } catch (error) {
      showNotice(error.message, true)
    } finally {
      button.disabled = byId('roomExclusionButton')?.getAttribute('aria-pressed') === 'true' || handling.dataset.schedulePaused === 'true'
    }
  })
  function clearReply() {
    const form = byId('messageForm')
    if (!form) return
    form.elements.namedItem('replyToId').value = ''
    form.elements.namedItem('replyToMessageId').value = ''
    byId('replyComposer').hidden = true
    byId('replyComposerText').textContent = ''
  }
  messages?.addEventListener('click', async (event) => {
    const button = event.target.closest('button')
    const article = event.target.closest('.message')
    if (!button || !article) return
    if (button.matches('[data-reaction-toggle]')) {
      const picker = article.querySelector('.reaction-picker')
      messages.querySelectorAll('.reaction-picker').forEach((item) => {
        if (item !== picker) item.hidden = true
      })
      picker.hidden = !picker.hidden
      return
    }
    if (button.matches('[data-reply]')) {
      const form = byId('messageForm')
      form.elements.namedItem('replyToId').value = article.dataset.id
      form.elements.namedItem('replyToMessageId').value = article.dataset.messageId
      byId('replyComposerText').textContent = article.dataset.body || 'Media'
      byId('replyComposer').hidden = false
      form.elements.namedItem('body').focus()
      return
    }
    if (button.matches('[data-reaction]')) {
      try {
        await api('/api/messages/reaction', {
          method: 'POST',
          body: JSON.stringify({
            messageRowId: article.dataset.id,
            messageId: article.dataset.messageId,
            emoji: button.dataset.reaction,
          }),
        })
        article.querySelector('.reaction-picker').hidden = true
        await updateMessages()
      } catch (error) {
        showNotice(error.message, true)
      }
    }
  })
  byId('cancelReply')?.addEventListener('click', clearReply)
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.message-actions')) {
      messages?.querySelectorAll('.reaction-picker').forEach((picker) => {
        picker.hidden = true
      })
    }
  })
  let mediaPreviewUrl = ''
  let composerBusy = false
  function clearMedia() {
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl)
    mediaPreviewUrl = ''
    if (!byId('mediaInput')) return
    byId('mediaInput').value = ''
    byId('mediaComposer').hidden = true
    byId('mediaPreview').hidden = true
    byId('mediaPreview').removeAttribute('src')
    byId('mediaFileName').textContent = ''
    const input = byId('messageForm').elements.namedItem('body')
    input.maxLength = 4096
    input.placeholder = t('Pesan')
  }
  byId('attachMedia')?.addEventListener('click', () => byId('mediaInput').click())
  byId('cancelMedia')?.addEventListener('click', clearMedia)
  byId('mediaInput')?.addEventListener('change', (event) => {
    const file = event.target.files[0]
    if (!file) {
      clearMedia()
      return
    }
    if (!file.size || file.size > 16 * 1024 * 1024) {
      clearMedia()
      showNotice(t('Ukuran file maksimal 16 MB.'), true)
      return
    }
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl)
    mediaPreviewUrl = ''
    byId('mediaPreview').hidden = true
    byId('mediaPreview').removeAttribute('src')
    if (/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
      mediaPreviewUrl = URL.createObjectURL(file)
      byId('mediaPreview').src = mediaPreviewUrl
      byId('mediaPreview').hidden = false
    }
    byId('mediaFileName').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`
    byId('mediaComposer').hidden = false
    const input = byId('messageForm').elements.namedItem('body')
    input.maxLength = 1024
    input.placeholder = t('Caption (opsional)')
    input.focus()
  })
  window.addEventListener('pagehide', () => {
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl)
  })
  byId('messageForm')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (composerBusy) return
    const form = event.currentTarget
    const bodyInput = form.elements.namedItem('body')
    const payload = {
      jid: form.elements.namedItem('jid').value,
      body: bodyInput.value,
      replyToId: form.elements.namedItem('replyToId').value,
      replyToMessageId: form.elements.namedItem('replyToMessageId').value,
    }
    const file = byId('mediaInput').files[0]
    if (!payload.body.trim() && !file) return
    if (file && payload.body.length > 1024) {
      showNotice(t('Caption maksimal 1.024 karakter.'), true)
      return
    }
    let requestBody = JSON.stringify(payload)
    if (file) {
      requestBody = new FormData()
      for (const [key, value] of Object.entries(payload)) requestBody.append(key, value)
      requestBody.append('media', file)
    }
    const button = form.querySelector('button[type="submit"]')
    composerBusy = true
    const controls = [...form.querySelectorAll('button, input')]
    controls.forEach((control) => {
      control.disabled = true
    })
    button.textContent = file ? t('Mengunggah…') : t('Mengirim…')
    try {
      await api('/api/messages/send', { method: 'POST', body: requestBody })
      bodyInput.value = ''
      clearReply()
      clearMedia()
      await updateMessages()
      await updateContacts()
    } catch (error) {
      showNotice(error.message, true)
    } finally {
      composerBusy = false
      controls.forEach((control) => {
        control.disabled = false
      })
      button.textContent = t('Kirim')
      bodyInput.focus()
    }
  })
  let chatgptLoginError = ''
  let chatgptLoginStarting = false
  let chatgptLoginAttempt = 0
  function renderOAuth(state) {
    if (typeof state.connected !== 'boolean' || typeof state.pending !== 'boolean')
      throw new Error(t('Respons login tidak valid. Periksa layanan WEB.'))
    const verificationUrl = window.waChatgptLogin?.verificationUrl(state.verificationUrl) || ''
    const codeReady = Boolean(state.userCode && verificationUrl)
    const pendingLabel = codeReady ? 'Menunggu login ChatGPT' : 'Meminta kode perangkat…'
    if (state.connected || (state.userCode && verificationUrl)) chatgptLoginError = ''
    const loginError = state.error || chatgptLoginError
    const message = byId('oauthMessage')
    message.textContent = t(loginError || (state.pending ? pendingLabel : 'Klik Hubungkan untuk mendapatkan kode'))
    message.hidden = state.connected || Boolean(state.userCode && verificationUrl)
    const status = byId('oauthStatus')
    const button = byId('oauthButton')
    const device = byId('oauthDevice')
    status.textContent = state.connected
      ? t('Terhubung')
      : loginError ? t(loginError) : state.pending
        ? t(pendingLabel)
        : t(state.error || 'Belum terhubung')
    status.classList.toggle('connected', state.connected)
    status.title = status.textContent
    status.hidden = !state.connected && !loginError && !state.pending
    button.title = state.pending ? t(pendingLabel) : t('Hubungkan ChatGPT')
    button.hidden = state.connected
    button.disabled = state.pending || chatgptLoginStarting
    device.hidden = state.connected
    byId('oauthLink').hidden = !verificationUrl || !state.userCode
    byId('oauthLink').href = verificationUrl || '#'
    byId('oauthCode').value = state.userCode || ''
    byId('oauthCode').placeholder = '—'
    byId('oauthCopy').disabled = !state.userCode
  }
  async function updateOAuth() {
    if (!byId('oauthStatus')) return
    if (chatgptLoginStarting) return
    const attempt = chatgptLoginAttempt
    try {
      const state = await api('/api/ai/oauth/status')
      if (!chatgptLoginStarting && attempt === chatgptLoginAttempt) renderOAuth(state)
    } catch {
      if (chatgptLoginStarting || attempt !== chatgptLoginAttempt) return
      byId('oauthStatus').hidden = false
      byId('oauthStatus').textContent = t('Status login gagal dimuat. Muat ulang halaman.')
      byId('oauthMessage').hidden = false
      byId('oauthMessage').textContent = t('Status login gagal dimuat. Muat ulang halaman.')
      // A polling outage does not invalidate a code already returned by this login.
      // Keep the manual link/code available; only a server state change clears them.
    }
  }
  async function startChatgptLogin(restart = false) {
    if (chatgptLoginStarting) return
    chatgptLoginStarting = true
    chatgptLoginAttempt += 1
    chatgptLoginError = ''
    renderOAuth({ connected: false, pending: true })
    byId('oauthButton').disabled = true
    byId('oauthRestart').disabled = true
    byId('oauthCode').value = ''
    byId('oauthLink').hidden = true
    byId('oauthLink').href = '#'
    byId('oauthCopy').disabled = true
    try {
      const state = await window.waChatgptLogin.request((signal) => api('/api/ai/oauth/start', {
        method: 'POST', body: JSON.stringify({ restart }), signal,
      }))
      chatgptLoginStarting = false
      renderOAuth(state)
    } catch (error) {
      chatgptLoginStarting = false
      chatgptLoginError = error.name === 'AbortError'
        ? 'Permintaan login belum selesai. Periksa status atau mulai ulang login.' : error.message
      renderOAuth({ connected: false, pending: false, error: chatgptLoginError })
    } finally {
      chatgptLoginStarting = false
      byId('oauthRestart').disabled = false
    }
  }
  byId('oauthButton')?.addEventListener('click', () => startChatgptLogin())
  byId('oauthCopy')?.addEventListener('click', async () => {
    const input = byId('oauthCode')
    if (!input.value) return
    try {
      await navigator.clipboard.writeText(input.value)
      showNotice(t('Kode disalin.'))
    } catch {
      input.focus()
      input.select()
      showNotice(t('Salin kode yang dipilih.'), true)
    }
  })
  async function restartOAuth(provider) {
    const isClaude = provider === 'claude'
    if (!isClaude) return startChatgptLogin(true)
    const button = byId(isClaude ? 'claudeOauthRestart' : 'oauthRestart')
    button.disabled = true
    byId(isClaude ? 'claudeOauthCode' : 'oauthCode').value = ''
    try {
      await api(isClaude ? '/api/ai/claude/oauth/start' : '/api/ai/oauth/start', {
        method: 'POST', body: JSON.stringify({ restart: true }),
      })
      if (isClaude) await updateClaudeOAuth()
      else await updateOAuth()
    } catch (error) {
      showNotice(t(error.message), true)
    } finally {
      button.disabled = false
    }
  }
  byId('oauthRestart')?.addEventListener('click', () => restartOAuth('chatgpt'))
  byId('claudeOauthRestart')?.addEventListener('click', () => restartOAuth('claude'))
  function updateProviderPanels() {
    // Tanpa pilihan mesin: akun AI di daftar yang dipakai; panel ChatGPT & Claude tampil semua.
    const provider = byId('aiProvider')?.value || ''
    document.querySelectorAll('[data-ai-provider-panel]').forEach((panel) => {
      panel.hidden = Boolean(provider) && panel.dataset.aiProviderPanel !== provider
    })
    updateMcpOAuth()
  }
  byId('aiProvider')?.addEventListener('change', updateProviderPanels)
  let claudeLoginId = ''
  let claudeVerificationBusy = false
  async function updateClaudeOAuth() {
    const status = byId('claudeOauthStatus')
    if (!status) return
    try {
      const state = await api('/api/ai/claude/oauth/status')
      const button = byId('claudeOauthButton')
      const device = byId('claudeOauthDevice')
      status.textContent = state.connected
        ? t('Terhubung')
        : state.pending
          ? t('Menunggu login')
          : t(state.error || 'Belum terhubung')
      status.classList.toggle('connected', state.connected)
      status.title = status.textContent
      status.hidden = !state.connected && !state.error
      button.title = state.pending ? t('Menunggu login Claude') : t('Hubungkan Claude')
      button.hidden = state.connected
      button.disabled = state.pending
      device.hidden = state.connected || !state.pending
      byId('claudeOauthLink').hidden = !state.verificationUrl
      byId('claudeOauthLink').href = state.verificationUrl || '#'
      const input = byId('claudeOauthCode')
      if (claudeLoginId !== state.loginId || !state.pending || state.connected) input.value = ''
      claudeLoginId = state.loginId || ''
      input.disabled = !state.pending || !state.verificationUrl || state.codeSubmitted || claudeVerificationBusy
      byId('claudeOauthVerify').disabled = input.disabled || !input.value.trim()
      const help = byId('claudeOauthHelp')
      help.dataset.i18n = state.codeSubmitted ? 'Kode sedang diverifikasi.' : 'Tempel kode dari halaman Claude.'
      help.textContent = t(help.dataset.i18n)
    } catch (error) {
      status.textContent = t('Status login gagal dimuat. Muat ulang halaman.')
      status.classList.remove('connected')
      status.title = error.message
      status.hidden = false
      byId('claudeOauthDevice').hidden = true
      byId('claudeOauthCode').value = ''
      claudeLoginId = ''
    }
  }
  byId('claudeOauthButton')?.addEventListener('click', async () => {
    try {
      await api('/api/ai/claude/oauth/start', { method: 'POST', body: '{}' })
      await updateClaudeOAuth()
    } catch (error) {
      showNotice(error.message, true)
    }
  })
  async function verifyClaudeCode() {
    const input = byId('claudeOauthCode')
    if (input.disabled || claudeVerificationBusy || !input.value.trim() || !claudeLoginId) return
    claudeVerificationBusy = true
    input.disabled = true
    byId('claudeOauthVerify').disabled = true
    byId('claudeOauthRestart').disabled = true
    let code = input.value.trim()
    input.value = ''
    try {
      const result = await api('/api/ai/claude/oauth/verify', {
        method: 'POST', body: JSON.stringify({ loginId: claudeLoginId, code }),
      })
      if (result.submitted !== true) throw new Error('Status login gagal dimuat. Muat ulang halaman.')
    } catch (error) {
      showNotice(t(error.message), true)
    } finally {
      code = ''
      claudeVerificationBusy = false
      byId('claudeOauthRestart').disabled = false
      await updateClaudeOAuth()
    }
  }
  byId('claudeOauthVerify')?.addEventListener('click', verifyClaudeCode)
  byId('claudeOauthCode')?.addEventListener('input', (event) => {
    byId('claudeOauthVerify').disabled = claudeVerificationBusy || !event.target.value.trim()
  })
  byId('claudeOauthCode')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void verifyClaudeCode()
    }
  })
  window.addEventListener('pagehide', () => {
    if (byId('claudeOauthCode')) byId('claudeOauthCode').value = ''
    if (byId('oauthCode')) byId('oauthCode').value = ''
  })
  function renderMcpConnections(connections) {
    const list = byId('mcpConnections')
    if (!list) return
    list.replaceChildren()
    if (!connections.length) {
      const empty = document.createElement('div')
      empty.className = 'wa-skill-empty'
      empty.textContent = t('Belum ada koneksi')
      list.append(empty)
      return
    }
    for (const connection of connections) {
      const row = document.createElement('div')
      row.className = 'wa-mcp-row'
      row.dataset.mcpRow = connection.slug

      const source = document.createElement('div')
      source.className = 'wa-mcp-source'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'wa-switch'
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-label', t("Aktifkan {0}", connection.name))
      toggle.dataset.mcpEnabled = connection.slug
      setSwitch(toggle, Boolean(connection.enabled))
      settingsSaved.set(`mcp:${connection.slug}`, Boolean(connection.enabled))
      const details = document.createElement('span')
      const name = document.createElement('strong')
      name.textContent = connection.name
      const status = document.createElement('small')
      status.className = 'wa-connection-indicator'
      status.dataset.mcpStatus = ''
      status.classList.toggle('connected', Boolean(connection.authenticated))
      status.textContent = connection.authenticated
        ? t('Terhubung')
        : connection.error
          ? t('Gagal')
          : connection.pending
            ? t('Menunggu login')
            : t('Belum terhubung')
      status.title = connection.error ? t(connection.error) : status.textContent
      details.append(name, status)
      source.append(details)

      const connect = document.createElement('button')
      connect.className = 'wa-setting-icon wa-icon-connect'
      connect.type = 'button'
      connect.dataset.mcpConnect = connection.slug
      connect.textContent = t('Hubungkan')
      connect.title = t("Hubungkan {0}", connection.name)
      connect.setAttribute('aria-label', connect.title)
      connect.hidden = Boolean(connection.sharedAuthenticated)
      connect.disabled = Boolean(connection.pending)

      const login = document.createElement('a')
      login.className = 'wa-mcp-login wa-setting-icon wa-icon-external'
      login.dataset.mcpLogin = ''
      login.href = connection.verificationUrl || '#'
      login.target = '_blank'
      login.rel = 'noopener'
      login.textContent = t('Login')
      login.title = t("Login {0}", connection.name)
      login.setAttribute('aria-label', login.title)
      login.hidden = Boolean(connection.sharedAuthenticated || !connection.verificationUrl)

      const remove = document.createElement('button')
      remove.className = 'wa-setting-icon wa-icon-delete'
      remove.type = 'button'
      remove.dataset.mcpDelete = connection.slug
      remove.setAttribute('aria-label', t("Hapus {0}", connection.name))
      remove.textContent = t('Hapus')
      remove.title = t("Hapus {0}", connection.name)
      const actions = document.createElement('div')
      actions.className = 'wa-setting-actions'
      actions.append(connect, login, remove, toggle)
      row.append(source, actions)
      list.append(row)
    }
  }
  function updateMcpVerification(row, connection, provider) {
    let panel = row.querySelector('[data-mcp-verification]')
    if (!connection.pending || connection.authenticated) {
      panel?.remove()
      return
    }
    if (panel && (panel.dataset.loginId !== connection.loginId || panel.dataset.provider !== provider)) {
      panel.remove()
      panel = null
    }
    if (!panel) {
      panel = document.createElement('div')
      panel.className = 'wa-oauth-verification'
      panel.dataset.mcpVerification = ''
      panel.dataset.loginId = connection.loginId
      panel.dataset.provider = provider
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'password'
      input.id = `mcp-callback-${connection.slug}`
      input.dataset.mcpCallback = ''
      input.autocomplete = 'off'
      input.spellcheck = false
      input.maxLength = 8192
      label.htmlFor = input.id
      label.textContent = t('URL callback')
      const help = document.createElement('small')
      help.className = 'wa-muted'
      help.dataset.mcpCallbackHelp = ''
      help.id = `${input.id}-help`
      help.textContent = t('Jika halaman 127.0.0.1 gagal terbuka, tempel URL lengkap dari bilah alamat di sini.')
      input.setAttribute('aria-describedby', help.id)
      const controls = document.createElement('div')
      controls.className = 'wa-oauth-controls'
      const verify = document.createElement('button')
      verify.type = 'button'
      verify.className = 'button primary'
      verify.dataset.mcpVerify = ''
      verify.textContent = t('Verifikasi')
      const restart = document.createElement('button')
      restart.type = 'button'
      restart.className = 'button'
      restart.dataset.mcpRestart = ''
      restart.textContent = t('Mulai ulang')
      controls.append(input, verify, restart)
      const result = document.createElement('small')
      result.dataset.mcpVerificationResult = ''
      result.setAttribute('role', 'status')
      result.hidden = true
      panel.append(label, controls, help, result)
      row.append(panel)
    }
    const input = panel.querySelector('[data-mcp-callback]')
    const submitted = connection.callbackSubmitted || panel.dataset.submitted === 'true'
    input.hidden = !connection.manualCallback
    input.disabled = submitted
    if (submitted) input.value = ''
    panel.querySelector('label').hidden = !connection.manualCallback
    panel.querySelector('[data-mcp-callback-help]').hidden = !connection.manualCallback || submitted
    const verify = panel.querySelector('[data-mcp-verify]')
    verify.hidden = !connection.manualCallback
    verify.disabled = submitted || panel.dataset.busy === 'true' || !input.value.trim()
    if (submitted && !panel.dataset.failed) {
      const result = panel.querySelector('[data-mcp-verification-result]')
      result.hidden = false
      result.textContent = t('Menunggu hasil verifikasi MCP…')
    }
  }
  byId('mcpConnections')?.addEventListener('input', (event) => {
    if (!event.target.matches('[data-mcp-callback]')) return
    const panel = event.target.closest('[data-mcp-verification]')
    panel.querySelector('[data-mcp-verify]').disabled = panel.dataset.busy === 'true'
      || panel.dataset.submitted === 'true' || !event.target.value.trim()
  })
  byId('mcpConnections')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('[data-mcp-callback]')) {
      event.preventDefault()
      event.target.closest('[data-mcp-verification]').querySelector('[data-mcp-verify]').click()
    }
  })
  window.addEventListener('pagehide', () => {
    document.querySelectorAll('[data-mcp-callback]').forEach((input) => { input.value = '' })
  })
  let mcpStatusRequest = 0
  const mcpStatusPending = new Set()
  async function updateMcpOAuth() {
    if (!byId('mcpConnections')) return
    const provider = byId('aiProvider')?.value || 'chatgpt'
    if (mcpStatusPending.has(provider)) return
    mcpStatusPending.add(provider)
    const requestId = ++mcpStatusRequest
    try {
      const state = await api(`/api/mcp/oauth/status?provider=${encodeURIComponent(provider)}`)
      if (requestId !== mcpStatusRequest || provider !== (byId('aiProvider')?.value || 'chatgpt')) return
      for (const connection of state.connections || []) {
        const row = [...document.querySelectorAll('[data-mcp-row]')].find(
          (item) => item.dataset.mcpRow === connection.slug
        )
        if (!row) continue
        const status = row.querySelector('[data-mcp-status]')
        const button = row.querySelector('[data-mcp-connect]')
        const link = row.querySelector('[data-mcp-login]')
        status.textContent = connection.authenticated
          ? t('Terhubung')
          : connection.error
            ? t('Gagal')
            : connection.pending
              ? t('Menunggu login')
              : t('Belum terhubung')
        status.classList.toggle('connected', connection.authenticated)
        const providerName = provider === 'claude' ? 'Claude' : 'ChatGPT'
        const otherName = provider === 'claude' ? 'ChatGPT' : 'Claude'
        const otherAuthenticated = provider === 'claude' ? connection.chatgptAuthenticated : connection.claudeAuthenticated
        status.title = connection.error ? t(connection.error) : connection.sharedAuthenticated
          ? t('Koneksi bersama ChatGPT dan Claude')
          : connection.authenticated
            ? t('Hubungkan sekali untuk dipakai ChatGPT dan Claude')
            : `${providerName} · ${connection.error ? t(connection.error) : status.textContent}`
        if (!connection.sharedAuthenticated && !connection.authenticated && otherAuthenticated)
          status.title = t('Terhubung di {0}. Hubungkan {1} untuk provider ini.', otherName, providerName)
        button.title = connection.pending ? t("Menunggu login {0}", connection.name) : t("Hubungkan {0}", connection.name)
        button.hidden = connection.sharedAuthenticated
        button.disabled = connection.pending
        link.hidden = connection.sharedAuthenticated || !connection.verificationUrl
        if (connection.verificationUrl) link.href = connection.verificationUrl
        updateMcpVerification(row, connection, provider)
        // Preserve unsaved choices while refreshing connection status.
      }
    } catch {
      if (requestId !== mcpStatusRequest || provider !== (byId('aiProvider')?.value || 'chatgpt')) return
      for (const status of document.querySelectorAll('[data-mcp-status]')) {
        status.textContent = t('Status belum dapat diperiksa')
        status.classList.remove('connected')
        status.title = t('Koneksi belum pulih. Coba lagi.')
      }
    } finally {
      mcpStatusPending.delete(provider)
    }
  }
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#business') void updateMcpOAuth()
  })
  window.addEventListener('pageshow', () => void updateMcpOAuth())
  window.addEventListener('wa:network-restored', () => {
    void updateMcpOAuth()
    void updateOAuth()
    void updateClaudeOAuth()
    void updateStatus()
    void updateContacts()
    void updateMessages()
  })
  byId('mcpConnections')?.addEventListener('click', async (event) => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.matches('[data-mcp-verify], [data-mcp-restart]')) {
      const panel = button.closest('[data-mcp-verification]')
      if (panel.dataset.busy === 'true') return
      const input = panel.querySelector('[data-mcp-callback]')
      const result = panel.querySelector('[data-mcp-verification-result]')
      const restart = button.matches('[data-mcp-restart]')
      panel.dataset.busy = 'true'
      button.disabled = true
      try {
        const payload = {
          slug: button.closest('[data-mcp-row]').dataset.mcpRow,
          provider: panel.dataset.provider,
          ...(restart ? { restart: true } : { loginId: panel.dataset.loginId, callbackUrl: input.value.trim() }),
        }
        input.value = ''
        const data = await api(`/api/mcp/oauth/${restart ? 'start' : 'verify'}`, {
          method: 'POST', body: JSON.stringify(payload),
        })
        if (!restart && data.submitted !== true) throw new Error(t('Verifikasi gagal.'))
        if (restart) panel.remove()
        else {
          panel.dataset.submitted = 'true'
          delete panel.dataset.failed
          input.disabled = true
          result.hidden = false
          result.textContent = t('Menunggu hasil verifikasi MCP…')
        }
        await updateMcpOAuth()
      } catch (error) {
        panel.dataset.failed = 'true'
        result.hidden = false
        result.textContent = error.message
      } finally {
        panel.dataset.busy = 'false'
        button.disabled = !restart && (panel.dataset.submitted === 'true' || !input.value.trim())
      }
      return
    }
    if (button.matches('[data-mcp-connect]')) {
      button.disabled = true
      try {
        await api('/api/mcp/oauth/start', {
          method: 'POST',
          body: JSON.stringify({
            slug: button.dataset.mcpConnect,
            provider: byId('aiProvider')?.value || 'chatgpt',
          }),
        })
        const row = button.closest('[data-mcp-row]')
        if (row) {
          setSwitch(row.querySelector('[data-mcp-enabled]'), true)
          settingsSaved.set(`mcp:${button.dataset.mcpConnect}`, true)
        }
        await updateMcpOAuth()
      } catch (error) {
        showNotice(error.message, true)
      } finally {
        button.disabled = false
      }
      return
    }
    if (button.matches('[data-mcp-delete]')) {
      if (!window.confirm(t('Hapus koneksi MCP?'))) return
      button.disabled = true
      try {
        const state = await api(
          `/api/settings/mcp/${encodeURIComponent(button.dataset.mcpDelete)}`,
          { method: 'DELETE', body: '{}' }
        )
        renderMcpConnections(state.connections || [])
        showNotice(t('Koneksi dihapus'))
      } catch (error) {
        button.disabled = false
        showNotice(error.message, true)
      }
    }
  })
  byId('mcpAddButton')?.addEventListener('click', async () => {
    const button = byId('mcpAddButton')
    const name = byId('mcpName').value.trim()
    const url = byId('mcpUrl').value.trim()
    if (!name || !url) {
      showNotice(t('Nama dan URL MCP harus diisi.'), true)
      return
    }
    button.disabled = true
    try {
      const state = await api('/api/settings/mcp', {
        method: 'POST',
        body: JSON.stringify({ name, url }),
      })
      renderMcpConnections(state.connections || [])
      byId('mcpName').value = ''
      byId('mcpUrl').value = ''
      showNotice(t('Koneksi ditambahkan'))
    } catch (error) {
      showNotice(error.message, true)
    } finally {
      button.disabled = false
    }
  })
  function renderSkills(skills) {
    const list = byId('skillList')
    if (!list) return
    list.replaceChildren()
    if (!skills.length) {
      const empty = document.createElement('div')
      empty.className = 'wa-skill-empty'
      empty.textContent = t('Belum ada skill')
      list.append(empty)
      return
    }
    for (const skill of skills) {
      const row = document.createElement('div')
      row.className = 'wa-skill-row'
      row.dataset.skillRow = skill.id
      const name = document.createElement('strong')
      name.textContent = skill.name
      const info = document.createElement('div')
      const updated = document.createElement('small')
      updated.className = 'wa-skill-updated'
      const time = document.createElement('time')
      time.dateTime = skill.updatedAt
      time.dataset.relativeTime = ''
      time.title = t("Diperbarui {0}", skill.updatedAtLabel)
      time.textContent = 'just now'
      updated.append(time)
      info.append(name, updated)
      const button = document.createElement('button')
      button.className = 'button'
      button.type = 'button'
      button.dataset.skillDelete = skill.id
      button.setAttribute('aria-label', t("Hapus {0}", skill.name))
      button.textContent = t('Hapus')
      const actions = document.createElement('div')
      actions.className = 'wa-skill-actions'
      const download = document.createElement('a')
      download.className = 'wa-skill-download'
      download.href = `${appUrl}/api/settings/skills/${encodeURIComponent(skill.id)}/download`
      download.dataset.skillDownload = skill.id
      download.dataset.i18nTitle = 'Unduh skill'
      download.dataset.i18nAriaLabel = 'Unduh skill'
      download.title = t('Unduh skill')
      download.setAttribute('aria-label', t('Unduh skill'))
      download.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></svg>'
      actions.append(download, button)
      row.append(info, actions)
      list.append(row)
    }
    document.dispatchEvent(new Event('skills:updated'))
  }
  document.addEventListener('skills:replace', (event) => {
    if (Array.isArray(event.detail)) renderSkills(event.detail)
  })
  byId('skillList')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-skill-delete]')
    if (!button || !window.confirm(t('Hapus skill?'))) return
    button.disabled = true
    try {
      const settings = await api(`/api/settings/skills/${button.dataset.skillDelete}`, {
        method: 'DELETE',
        body: '{}',
      })
      renderSkills(settings.skills || [])
      const aiEnabled = byId('settingsForm')?.elements.namedItem('aiEnabled')
      if (aiEnabled) setSwitch(aiEnabled, settings.aiEnabled)
      settingsSaved.set('aiEnabled', settings.aiEnabled)
      showNotice(t('Skill dihapus'))
    } catch (error) {
      button.disabled = false
      showNotice(error.message, true)
    }
  })
  async function updateCodexStatus(override) {
    const label = byId('codexStatus')
    if (!label) return
    const form = byId('settingsForm')
    const value =
      override === undefined ? form?.elements.namedItem('codexBin')?.value || '' : override
    try {
      const query = value ? `?codexBin=${encodeURIComponent(value)}` : ''
      const state = await api(`/api/ai/codex/status${query}`)
      label.textContent = state.found
        ? t("Siap — {0}", state.version || state.bin)
        : state.error || t('Tidak ditemukan')
      label.classList.toggle('connected', Boolean(state.found))
    } catch (error) {
      label.textContent = error.message
      label.classList.remove('connected')
    }
  }
  byId('codexCheck')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    byId('codexStatus').textContent = t('memeriksa…')
    await updateCodexStatus()
    button.disabled = false
  })
  async function updateClaudeStatus(override) {
    const label = byId('claudeStatus')
    if (!label) return
    const form = byId('settingsForm')
    const value =
      override === undefined ? form?.elements.namedItem('claudeBin')?.value || '' : override
    try {
      const query = value ? `?claudeBin=${encodeURIComponent(value)}` : ''
      const state = await api(`/api/ai/claude/status${query}`)
      label.textContent = state.found
        ? t("Siap — {0}", state.version || state.bin)
        : state.error || t('Tidak ditemukan')
      label.classList.toggle('connected', Boolean(state.found))
    } catch (error) {
      label.textContent = error.message
      label.classList.remove('connected')
    }
  }
  byId('claudeCheck')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    byId('claudeStatus').textContent = t('memeriksa…')
    await updateClaudeStatus()
    button.disabled = false
  })
  function setSwitch(button, enabled) {
    if (!button) return
    button.value = String(Boolean(enabled))
    button.setAttribute('aria-checked', button.value)
  }
  const settingsForm = byId('settingsForm')
  const settingsPending = new Map()
  const settingsTimers = new Map()
  const settingsSaved = new Map()
  const settingsErrors = new Map()
  let settingsActive = null
  const settingKey = (input) => input.dataset.mcpEnabled ? `mcp:${input.dataset.mcpEnabled}` : input.name
  const settingValue = (input) => input.matches('[role="switch"]') ? input.value === 'true' : input.value
  const isSetting = (input) => input.matches('input[name], select[name], button[name], [data-mcp-enabled]') && !input.closest('#settings-payments')
  settingsForm?.querySelectorAll('input[name], select[name], button[name], [data-mcp-enabled]').forEach((input) => {
    settingsSaved.set(settingKey(input), settingValue(input))
  })
  function settingsStatus(message) {
    const status = byId('settingsSaveState')
    if (!status) return
    status.textContent = settingsErrors.size ? [...settingsErrors.values()][0] : message
    status.classList.toggle('error', settingsErrors.size > 0)
  }
  async function flushSettings() {
    if (settingsActive) return
    while (settingsPending.size) {
      const [key, task] = settingsPending.entries().next().value
      settingsPending.delete(key)
      settingsActive = task
      settingsStatus(key === 'skillFile' ? t('Mengimpor…') : t('Menyimpan…'))
      const { input, value } = task
      if (key === 'skillFile') {
        input.disabled = true
        byId('skillList')?.querySelectorAll('button').forEach((button) => { button.disabled = true })
      }
      try {
        const payload = key === 'skillFile'
          ? { skills: await Promise.all(task.files.map(async (file) => ({ fileName: file.name, content: await file.text() }))) }
          : input.dataset.mcpEnabled ? { mcpConnections: { [input.dataset.mcpEnabled]: value } } : { [input.name]: value }
        const settings = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) })
        if (typeof settings.aiEnabled !== 'boolean') throw new Error(t('Sesi berakhir. Muat ulang halaman untuk masuk kembali.'))
        document.dispatchEvent(new CustomEvent('settings:updated', { detail: settings }))
        settingsErrors.delete(key)
        input.removeAttribute('aria-invalid')
        if (key === 'skillFile') {
          renderSkills(settings.skills || [])
          input.value = ''
        } else {
          const saved = input.dataset.mcpEnabled
            ? settings.mcpConnections?.find((connection) => connection.slug === input.dataset.mcpEnabled)?.enabled ?? value
            : settings[input.name] ?? value
          settingsSaved.set(key, input.matches('[role="switch"]') ? Boolean(saved) : String(saved))
          if (settingValue(input) === value && !settingsPending.has(key) && !settingsTimers.has(key)) {
            if (input.matches('[role="switch"]')) setSwitch(input, saved)
            else input.value = String(saved)
          }
          if (key === 'codexBin') void updateCodexStatus()
          if (key === 'claudeBin') void updateClaudeStatus()
          input.dispatchEvent(new Event('settings:saved'))
        }
      } catch (error) {
        settingsErrors.set(key, t("Belum tersimpan: {0}", t(error.message)))
        if (settingValue(input) === value && !settingsPending.has(key)) {
          if (input.matches('[role="switch"], select')) {
            if (input.matches('[role="switch"]')) setSwitch(input, settingsSaved.get(key))
            else input.value = String(settingsSaved.get(key))
            updateProviderPanels()
            input.dispatchEvent(new Event('settings:reverted'))
          } else input.setAttribute('aria-invalid', 'true')
        }
      } finally {
        if (key === 'skillFile') {
          input.disabled = false
          byId('skillList')?.querySelectorAll('button').forEach((button) => { button.disabled = false })
        }
        settingsActive = null
      }
    }
    settingsStatus(settingsTimers.size ? t('Menunggu selesai mengetik…') : t('Tersimpan'))
  }
  function queueSetting(input) {
    const key = settingKey(input)
    clearTimeout(settingsTimers.get(key))
    settingsTimers.delete(key)
    if (!input.checkValidity()) {
      settingsErrors.set(key, t('Periksa nilai isian sebelum disimpan.'))
      input.setAttribute('aria-invalid', 'true')
      settingsStatus('')
      return
    }
    const value = settingValue(input)
    settingsErrors.delete(key)
    if (key !== 'skillFile' && !settingsActive && !settingsPending.has(key) && value === settingsSaved.get(key)) {
      settingsStatus(t('Tersimpan'))
      return
    }
    if (settingsActive?.input === input && settingsActive.value === value && key !== 'skillFile') {
      settingsPending.delete(key)
      return
    }
    const files = key === 'skillFile' ? [...input.files] : []
    if (key === 'skillFile' && !files.length) return
    settingsPending.set(key, { input, value, files })
    void flushSettings()
  }
  settingsForm?.addEventListener('click', (event) => {
    const toggle = event.target.closest('button[role="switch"]')
    if (!toggle || toggle.disabled) return
    setSwitch(toggle, toggle.value !== 'true')
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
  })
  settingsForm?.addEventListener('input', (event) => {
    const input = event.target
    if (!isSetting(input) || input.type === 'file' || input.matches('select, [role="switch"]')) return
    const key = settingKey(input)
    clearTimeout(settingsTimers.get(key))
    settingsErrors.delete(key)
    input.removeAttribute('aria-invalid')
    settingsTimers.set(key, setTimeout(() => queueSetting(input), 800))
    settingsStatus(t('Menunggu selesai mengetik…'))
  })
  settingsForm?.addEventListener('change', (event) => { if (isSetting(event.target)) queueSetting(event.target) })
  settingsForm?.addEventListener('submit', (event) => event.preventDefault())
  window.addEventListener('beforeunload', (event) => {
    if (window.waAuthExpired) return
    if (settingsActive || settingsPending.size || settingsTimers.size || settingsForm?.querySelector('[aria-invalid="true"]')) event.preventDefault()
  })
  const mcpResultUrl = new URL(window.location.href)
  const mcpResult = mcpResultUrl.searchParams.get('mcp_oauth')
  if (settingsForm && mcpResult) {
    const messages = {
      complete: 'Login MCP berhasil.', pending: 'Menunggu hasil verifikasi MCP…',
      denied: 'Login MCP dibatalkan.', failed: 'Login MCP belum berhasil. Mulai ulang login.',
    }
    if (Object.hasOwn(messages, mcpResult)) showNotice(t(messages[mcpResult]), mcpResult === 'failed')
    mcpResultUrl.searchParams.delete('mcp_oauth')
    window.history.replaceState(null, '', mcpResultUrl.pathname + mcpResultUrl.search + mcpResultUrl.hash)
  }
  // Cari di dalam room: sorot bubble yang cocok, ↑ lebih lama, ↓ lebih baru.
  const roomSearchBar = byId('roomSearchBar')
  const roomSearchInput = byId('roomSearchInput')
  let roomQuery = ''
  let roomHitId = null
  let roomPendingScroll = false
  function roomSearchHoldsView() {
    return Boolean(roomQuery && roomHitId)
  }
  function roomHits() {
    if (!messageList || !roomQuery) return []
    return [...messageList.querySelectorAll('.message')].filter((article) =>
      normalizeSearch(article.dataset.body).includes(roomQuery)
    )
  }
  function applyRoomSearch(scroll, step = 0) {
    if (!messageList) return
    const hits = roomHits()
    messageList.querySelectorAll('.message.search-hit, .message.search-current').forEach((el) =>
      el.classList.remove('search-hit', 'search-current')
    )
    const count = byId('roomSearchCount')
    if (!roomQuery) {
      roomHitId = null
      if (count) count.textContent = ''
      return
    }
    hits.forEach((el) => el.classList.add('search-hit'))
    let index = hits.findIndex((el) => el.dataset.id === roomHitId)
    if (index < 0) index = hits.length - 1
    else index = Math.min(hits.length - 1, Math.max(0, index + step))
    const current = hits[index]
    roomHitId = current?.dataset.id || null
    if (count) count.textContent = hits.length ? `${index + 1}/${hits.length}` : t('Tidak ada hasil')
    if (!current) {
      // Pesan masih dimuat: gulir ke hasil begitu muncul.
      if (scroll) roomPendingScroll = true
      return
    }
    current.classList.add('search-current')
    if (scroll || roomPendingScroll) {
      roomPendingScroll = false
      stickToLatest = false
      current.scrollIntoView({ block: 'center' })
    }
  }
  function openRoomSearch(value = '') {
    if (!roomSearchBar) return
    roomSearchBar.hidden = false
    byId('roomSearchButton')?.setAttribute('aria-expanded', 'true')
    if (value) roomSearchInput.value = value
    roomQuery = normalizeSearch(roomSearchInput.value)
    roomHitId = null
    roomSearchInput.focus()
    applyRoomSearch(true)
  }
  function closeRoomSearch() {
    if (!roomSearchBar) return
    roomSearchBar.hidden = true
    byId('roomSearchButton')?.setAttribute('aria-expanded', 'false')
    roomSearchInput.value = ''
    roomQuery = ''
    applyRoomSearch(false)
    stickToLatest = true
    scrollMessagesToLatest()
  }
  byId('roomSearchButton')?.addEventListener('click', () =>
    roomSearchBar?.hidden ? openRoomSearch() : closeRoomSearch()
  )
  byId('roomSearchClose')?.addEventListener('click', closeRoomSearch)
  byId('roomSearchPrev')?.addEventListener('click', () => applyRoomSearch(true, -1))
  byId('roomSearchNext')?.addEventListener('click', () => applyRoomSearch(true, 1))
  roomSearchInput?.addEventListener('input', () => {
    roomQuery = normalizeSearch(roomSearchInput.value)
    roomHitId = null
    applyRoomSearch(true)
  })
  roomSearchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      applyRoomSearch(true, event.shiftKey ? 1 : -1)
    } else if (event.key === 'Escape') closeRoomSearch()
  })
  // Dibuka dari hasil pencarian kotak masuk: kata yang sama langsung dicari di room.
  const openedQuery = new URLSearchParams(location.search).get('q')
  if (openedQuery && messages?.dataset.jid) openRoomSearch(openedQuery)

  updateStatus()
  updateMessages()
  updateOAuth()
  updateClaudeOAuth()
  updateMcpOAuth()
  updateCodexStatus()
  updateClaudeStatus()
  updateProviderPanels()
  window.setInterval(updateStatus, 2000)
  window.setInterval(updateMessages, 2500)
  window.setInterval(updateContacts, 3000)
  window.setInterval(updateOAuth, 3000)
  window.setInterval(updateClaudeOAuth, 3000)
  window.setInterval(updateMcpOAuth, 3000)
})()
