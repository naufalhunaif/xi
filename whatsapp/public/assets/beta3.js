;(() => {
  const root = document.getElementById('beta3Page')
  if (!root) return
  const byId = (id) => document.getElementById(id)
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) => new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const notice = (message, error = false) => {
    byId('beta3Notice').textContent = message
    byId('beta3Notice').classList.toggle('error', error)
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.redirected) throw new Error(t('Sesi berakhir. Muat ulang halaman.'))
    if (response.status === 204) return {}
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || t('Permintaan gagal.'))
    return result
  }
  const el = (tag, text, className) => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className) node.className = className
    return node
  }
  const mcpDialog = byId('beta3McpDialog')
  const openMcp = () => {
    byId('beta3McpOpen').setAttribute('aria-expanded', 'true')
    if (typeof mcpDialog.showModal === 'function') mcpDialog.showModal()
    else mcpDialog.setAttribute('open', '')
  }
  const closeMcp = () => {
    if (mcpDialog.open) mcpDialog.close()
    byId('beta3McpOpen').setAttribute('aria-expanded', 'false')
  }
  byId('beta3McpOpen').addEventListener('click', openMcp)
  byId('beta3McpClose').addEventListener('click', closeMcp)
  mcpDialog.addEventListener('click', (event) => {
    if (event.target === mcpDialog) closeMcp()
  })

  function describeMcp(result) {
    if (result.error) return t('Gagal: {0}', result.error)
    if (!result.url) return t('Belum ada koneksi. Tambahkan dan hubungkan di Pengaturan → Data bisnis.')
    return `${result.name || result.url} · ${result.connected ? t('Terhubung.') : t('Belum terhubung.')}`
  }

  async function loadMcp() {
    const result = await api('/api/beta3/mcp')
    const select = byId('beta3McpSlug')
    select.replaceChildren(new Option(t('— otomatis —'), ''))
    for (const source of result.sources || []) {
      select.append(new Option(`${source.name}${source.connected ? '' : ` (${t('belum terhubung')})`}`, source.slug))
    }
    select.value = result.slug || ''
    byId('beta3McpStatus').textContent = describeMcp(result)
    byId('beta3Sync').disabled = !result.connected
    byId('beta3Sync').title = result.connected ? t('Tarik katalog terbaru dari MCP') : t('Pilih sumber data dulu (ikon roda gigi)')
    return result
  }

  byId('beta3Sync').addEventListener('click', async () => {
    const button = byId('beta3Sync')
    button.disabled = true
    button.classList.add('is-busy')
    button.setAttribute('aria-label', t('Menyinkronkan…'))
    try {
      // v3.6.66: tombol Sync selalu menarik penuh (toko, bahan, size chart, diskon grosir ikut).
      const result = await api('/api/beta3/catalog/sync', 'POST', { force: true })
      notice(result.unchanged ? t('Katalog sudah terbaru.') : t('{0} varian disinkronkan.', result.count))
      await loadCatalog()
    } catch (error) {
      notice(error.message, true)
    } finally {
      button.classList.remove('is-busy')
      button.setAttribute('aria-label', t('Sync katalog'))
      button.disabled = false
    }
  })
  byId('beta3McpForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    byId('beta3McpStatus').textContent = t('Menguji…')
    try {
      const result = await api('/api/beta3/mcp', 'POST', { slug: byId('beta3McpSlug').value })
      byId('beta3McpStatus').textContent = describeMcp(result)
      byId('beta3Sync').disabled = !result.connected
      if (result.connected) setTimeout(closeMcp, 800)
    } catch (error) {
      byId('beta3McpStatus').textContent = error.message
    }
  })

  // Dialog helpers (digest, impor, contoh) memakai pola yang sama dengan Sumber data.
  const dialogPair = (dialog, opener, closer) => {
    const open = () => {
      if (opener) opener.setAttribute('aria-expanded', 'true')
      if (dialog.classList.contains('wa-order-drawer') && window.waMotion) window.waMotion.showDialog(dialog)
      else if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    }
    const close = () => {
      if (dialog.classList.contains('wa-order-drawer') && window.waMotion) window.waMotion.closeDialog(dialog)
      else if (dialog.open) dialog.close()
      if (opener) opener.setAttribute('aria-expanded', 'false')
    }
    if (opener) opener.addEventListener('click', open)
    closer.addEventListener('click', close)
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close()
    })
    return { open, close }
  }
  const digestDialog = dialogPair(byId('beta3DigestDialog'), byId('beta3DigestOpen'), byId('beta3DigestClose'))
  const importDialog = dialogPair(byId('beta3ImportDialog'), byId('beta3ImportOpen'), byId('beta3ImportClose'))
  const exampleDialog = dialogPair(byId('beta3ExampleDialog'), byId('beta3ExampleOpen'), byId('beta3ExampleClose'))

  // v3.6.73: ringkasan katalog dalam bahasa biasa; token & versi di "Detail teknis"; pola harga sebagai tabel.
  const ITEM_LABEL = () => ({ jas: t('Jas'), celana: t('Celana'), setelan: t('Setelan'), rompi: t('Rompi') })
  const SERIES_LABEL = { reguler: 'Reguler', signature: 'Signature', premium: 'Premium', tradero: 'Tradero' }
  const rupiah = (value) => new Intl.NumberFormat('id-ID').format(Number(value || 0))
  function renderPriceTable(series) {
    const box = byId('beta3PriceTable')
    box.replaceChildren()
    const keys = Object.keys(series || {})
    if (!keys.length) {
      box.append(el('p', t('Belum ada katalog — tekan Sync katalog.'), 'wa-muted'))
      return
    }
    const items = ['jas', 'celana', 'setelan', 'rompi']
    const table = el('table', undefined, 'wa-order-table wa-price-grid')
    const head = el('tr')
    head.append(el('th', t('Seri')))
    for (const item of items) head.append(el('th', ITEM_LABEL()[item], 'wa-order-amount'))
    const thead = el('thead')
    thead.append(head)
    const body = el('tbody')
    for (const key of ['reguler', 'signature', 'premium', 'tradero']) {
      const entry = series[key]
      if (!entry) continue
      for (const model of ['standar', 'db']) {
        if (!items.some((item) => entry.cells?.[`${item}:${model}`])) continue
        const row = el('tr')
        const name = el('td')
        name.append(el('span', `${SERIES_LABEL[key] || key}${model === 'db' ? ' · DB' : ''}`))
        if (entry.materials?.length && model === 'standar') name.append(el('small', entry.materials.join(', '), 'wa-price-materials'))
        row.append(name)
        for (const item of items) {
          const cell = entry.cells?.[`${item}:${model}`]
          const td = el('td', cell ? rupiah(cell.price) : '—', 'wa-order-amount')
          if (cell?.big && cell.big !== cell.price) td.append(el('small', `XXL+ ${rupiah(cell.big)}`, 'wa-price-big'))
          row.append(td)
        }
        body.append(row)
      }
    }
    table.append(thead, body)
    box.append(table)
  }
  async function loadCatalog() {
    const result = await api('/api/beta3/catalog')
    // v3.6.76: "Dicek" = terakhir dicocokkan ke website (bukan waktu halaman dibuka).
    const checked = result.checkedAt || result.changedAt
    byId('beta3SyncedAt').textContent = checked ? t('Dicek {0}', window.waTime.ago(checked)) : ''
    byId('beta3SyncedAt').title = checked ? window.waTime.full(checked) : ''
    const stats = result.stats || {}
    byId('beta3CatalogStatus').textContent = stats.colors
      ? t('{0} produk · {1} warna', stats.products, stats.colors)
      : t('Belum ada katalog — tekan Sync katalog.')
    const list = byId('beta3CatalogStats')
    list.hidden = !stats.colors
    const value = {
      onWeb: t('{0} warna', stats.onWeb || 0),
      ready: t('{0} warna', stats.ready || 0),
      inactive: String(stats.inactive || 0),
      changedAt: result.changedAt ? window.waTime.ago(result.changedAt) : '—',
    }
    for (const cell of list.querySelectorAll('[data-stat]')) cell.textContent = value[cell.dataset.stat]
    list.querySelector('[data-stat-row="inactive"]').hidden = !stats.inactive
    if (result.changedAt) list.querySelector('[data-stat="changedAt"]').title = window.waTime.full(result.changedAt)
    byId('beta3CatalogTech').textContent = [t('≈{0} token', result.tokens), result.version ? t('versi {0}', String(result.version).slice(0, 8)) : '']
      .filter(Boolean).join(' · ')
    byId('beta3CatalogDigest').textContent = result.digest
    byId('beta3PricePattern').textContent = result.pricePattern || t('Belum ada katalog — tekan Sync katalog.')
    renderPriceTable(result.priceTable)
    const options = [...new Set(result.rows.filter((row) => row.active && row.photoUrl).map((row) => (row.color ? `${row.product} - ${row.color}` : row.product)))]
    byId('simRoomImages').replaceChildren(...options.map((value) => Object.assign(document.createElement('option'), { value })))
  }

  let examples = []
  function renderExamples() {
    const q = byId('beta3ExampleSearch').value.trim().toLowerCase()
    const shown = q
      ? examples.filter((example) => [example.situation, example.customerText, example.csText, example.tags].join(' ').toLowerCase().includes(q))
      : examples
    const list = byId('beta3ExampleList')
    list.replaceChildren()
    byId('beta3ExampleCount').textContent = q ? t('{0} dari {1} contoh', shown.length, examples.length) : t('{0} contoh', examples.length)
    if (!shown.length) {
      const row = el('tr')
      const cell = el('td', t('Belum ada contoh.'), 'wa-order-empty')
      cell.colSpan = 5
      row.append(cell)
      list.append(row)
      return
    }
    for (const example of shown) {
      const row = el('tr')
      const situation = el('td', example.situation || '—')
      const remove = el('button', undefined, 'wa-mini')
      remove.innerHTML = '<svg class="wa-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>'
      remove.title = t('Hapus')
      remove.setAttribute('aria-label', t('Hapus'))
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        if (!confirm(t('Hapus contoh ini?'))) return
        try {
          await api(`/api/beta3/examples/${example.id}`, 'DELETE')
          await loadExamples()
        } catch (error) {
          notice(error.message, true)
        }
      })
      const actions = el('td')
      actions.append(remove)
      const source = el('td', example.source || '—', 'wa-tag')
      if (example.tags) source.title = example.tags
      row.append(situation, el('td', example.customerText, 'wa-muted'), el('td', example.csText), source, actions)
      list.append(row)
    }
  }
  async function loadExamples() {
    examples = (await api('/api/beta3/examples')).examples || []
    renderExamples()
  }
  byId('beta3ExampleSearch').addEventListener('input', renderExamples)

  // Impor katalog: baca file .json di browser, kirim isinya apa adanya.
  byId('beta3CatalogFile').addEventListener('change', () => {
    const file = byId('beta3CatalogFile').files?.[0]
    byId('beta3CatalogFileInfo').textContent = file ? `${file.name} · ${Math.round(file.size / 1024)} KB` : ''
  })
  byId('beta3CatalogForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const file = byId('beta3CatalogFile').files?.[0]
    if (!file) return
    try {
      const json = await file.text()
      JSON.parse(json)
      const result = await api('/api/beta3/catalog', 'POST', { json, replace: byId('beta3CatalogReplace').checked })
      notice(t('{0} varian diimpor (≈{1} token).', result.imported, result.tokens))
      byId('beta3CatalogForm').reset()
      byId('beta3CatalogFileInfo').textContent = ''
      importDialog.close()
      await loadCatalog()
    } catch (error) {
      notice(error instanceof SyntaxError ? t('File bukan JSON yang valid.') : error.message, true)
    }
  })
  byId('beta3ExampleForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await api('/api/beta3/examples', 'POST', {
        situation: byId('beta3ExampleSituation').value,
        customerText: byId('beta3ExampleCustomer').value,
        csText: byId('beta3ExampleCs').value,
        tags: byId('beta3ExampleTags').value,
      })
      byId('beta3ExampleForm').reset()
      exampleDialog.close()
      notice(t('Contoh disimpan.'))
      await loadExamples()
    } catch (error) {
      notice(error.message, true)
    }
  })
  // v3.6.78 Uji percakapan: hasil putaran terakhir; dipantau tiap 5 dtk selama berjalan.
  let simTimer = null
  function renderSimResult(result) {
    const item = el('li', undefined, `wa-sim-item ${result.lulus ? 'ok' : 'err'}`)
    const head = el('details')
    const summary = el('summary')
    summary.append(el('span', '', `wa-st ${result.lulus ? 'ok' : 'err'}`), el('span', result.judul, 'wa-sim-title'))
    if (result.nilai) summary.append(el('span', `${result.nilai}/5`, 'wa-sim-score'))
    if (result.manusia) summary.append(el('span', t('rasa {0}/5', result.manusia), 'wa-sim-score'))
    head.append(summary)
    if (result.rasa) head.append(el('p', t('Rasa bahasa: {0}', result.rasa), 'wa-sim-feel'))
    if (result.dipelajari) head.append(el('p', t('{0} jawaban CS asli ditambahkan ke Contoh jawaban CS', result.dipelajari), 'wa-sim-feel'))
    if (result.aturan) {
      const rule = el('p', undefined, 'wa-sim-rule')
      const add = el('button', t('Tambah ke Aturan toko'), 'wa-mini wa-sim-rule-add')
      add.type = 'button'
      add.addEventListener('click', async (event) => {
        event.preventDefault()
        try {
          await api('/api/beta3/rules', 'POST', { text: result.aturan })
          add.disabled = true
          add.textContent = t('Ditambahkan')
        } catch (error) {
          notice(error.message, true)
        }
      })
      rule.append(el('span', t('Aturan dari CS asli: {0}', result.aturan)), add)
      head.append(rule)
    }
    if (result.masalah?.length) {
      const issues = el('ul', undefined, 'wa-sim-issues')
      for (const text of result.masalah) issues.append(el('li', text))
      head.append(issues)
    }
    const chat = el('div', undefined, 'wa-sim-chat')
    for (const turn of result.giliran || []) {
      chat.append(el('p', turn.pelanggan, 'wa-sim-in'))
      for (const bubble of turn.balasan || []) chat.append(el('p', bubble, 'wa-sim-out'))
      for (const caption of turn.foto || []) chat.append(el('p', `🖼 ${caption}`, 'wa-sim-out wa-sim-photo'))
      if (turn.total) chat.append(el('p', turn.total, 'wa-sim-out wa-sim-total'))
      if (turn.serah_cs) chat.append(el('p', t('Diserahkan ke CS · {0}', turn.alasan || ''), 'wa-sim-handoff'))
      if (turn.error) chat.append(el('p', turn.error, 'wa-sim-handoff'))
      if (turn.jejak?.length) {
        const steps = el('details', undefined, 'wa-sim-steps')
        steps.append(el('summary', t('Langkah ({0})', turn.jejak.length)), el('pre', turn.jejak.join('\n')))
        chat.append(steps)
      }
    }
    head.append(chat)
    item.append(head)
    return item
  }
  async function loadSim() {
    const data = await api('/api/beta3/sim')
    byId('beta3SimCount').textContent = t('{0} skenario', data.scenarios.length)
    const run = data.last
    const list = byId('beta3SimList')
    list.replaceChildren()
    const busy = run?.status === 'running'
    byId('beta3SimRun').disabled = busy
    byId('beta3SimCustomRun').disabled = busy
    if (!run) {
      byId('beta3SimSummary').textContent = t('Belum pernah dijalankan.')
    } else {
      const when = run.finishedAt || run.startedAt
      byId('beta3SimSummary').textContent = busy
        ? t('Berjalan {0}/{1} · {2} lulus', run.done, run.total, run.passed)
        : t('{0}/{1} lulus · {2} · {3}', run.passed, run.total, t(run.label), when ? window.waTime.ago(when) : '')
      const sorted = [...run.results].sort((a, b) => Number(a.lulus) - Number(b.lulus))
      for (const result of sorted) list.append(renderSimResult(result))
    }
    clearTimeout(simTimer)
    if (busy) simTimer = setTimeout(() => loadSim().catch(() => {}), 5000)
  }
  async function startSim(body) {
    try {
      const result = await api('/api/beta3/sim/run', 'POST', body)
      if (!result.started) notice(t(result.reason || 'Uji sedang berjalan.'), true)
      await loadSim()
    } catch (error) {
      notice(error.message, true)
    }
  }
  byId('beta3SimRun').addEventListener('click', () => startSim({}))
  byId('beta3SimReal').addEventListener('click', () => {
    const count = Math.max(1, Math.min(300, Number(byId('beta3SimGenCount').value) || 50))
    startSim({ real: count, parallel: 3 })
  })
  // v3.6.87: pelajari semua jawaban CS manusia (latar), status diperbarui sampai selesai.
  let learnTimer = null
  const showLearn = (state) => {
    const node = byId('beta3SimLearnStatus')
    if (!node || !state) return
    const button = byId('beta3SimLearn')
    if (button) button.disabled = Boolean(state.running)
    if (state.running) {
      node.hidden = false
      node.textContent = t('Mempelajari chat CS…')
      clearTimeout(learnTimer)
      learnTimer = setTimeout(async () => showLearn((await api('/api/beta3/sim').catch(() => ({}))).learning), 5000)
    } else if (state.result) {
      node.hidden = false
      node.textContent = t('Dipelajari: {added} contoh baru dari {chats} chat ({pairs} tanya-jawab).')
        .replace('{added}', state.result.added)
        .replace('{chats}', state.result.chats)
        .replace('{pairs}', state.result.pairs)
    } else if (state.error) {
      node.hidden = false
      node.textContent = state.error
    }
  }
  byId('beta3SimLearn')?.addEventListener('click', async () => {
    try {
      showLearn(await api('/api/beta3/sim/learn', 'POST', {}))
    } catch (error) {
      notice(error.message, true)
    }
  })
  api('/api/beta3/sim').then((result) => showLearn(result.learning)).catch(() => {})
  byId('beta3SimGenerate').addEventListener('click', () => {
    const count = Math.max(1, Math.min(500, Number(byId('beta3SimGenCount').value) || 50))
    startSim({ generate: count, parallel: 3 })
  })

  // v3.6.79 Ruang simulasi: tonton uji yang berjalan, atau chat sendiri sebagai pelanggan.
  let roomView = 'live'
  let roomTimer = null
  let roomKey = ''
  const roomTabs = [...document.querySelectorAll('#simRoom [data-room]')]
  const checkerNote = (turn) => {
    const steps = turn.jejak || []
    if (steps.some((step) => step.includes('ditulis ulang'))) return t('Diperiksa Jev · ditulis ulang')
    if (steps.some((step) => step.includes('Pemeriksa balasan · sesuai'))) return t('Diperiksa Jev · sesuai')
    if (steps.some((step) => step.includes('Pemeriksa balasan'))) return t('Diperiksa Jev · ada catatan')
    return ''
  }
  function roomTurn(turn) {
    const out = []
    const inBubble = el('div', undefined, 'wa-sim-room-msg in')
    if (turn.gambar) {
      const image = el('img')
      image.src = turn.gambar
      image.alt = ''
      image.loading = 'lazy'
      inBubble.append(image)
    }
    if (turn.pelanggan) inBubble.append(el('span', turn.pelanggan))
    out.push(inBubble)
    const [first, ...rest] = turn.balasan || []
    const bubble = (text, extra = '') => el('div', text, `wa-sim-room-msg out ${extra}`)
    if (first) out.push(bubble(first))
    ;(turn.foto || []).forEach((caption, index) => {
      const photo = el('div', undefined, 'wa-sim-room-msg out photo')
      const url = (turn.fotoUrl || [])[index]
      if (url) {
        const image = el('img')
        image.src = url
        image.alt = caption
        image.loading = 'lazy'
        photo.append(image)
      }
      photo.append(el('span', caption))
      out.push(photo)
    })
    for (const text of rest) out.push(bubble(text))
    if (turn.total) out.push(bubble(turn.total, 'total'))
    if (turn.susulan)
      out.push(
        el(
          'div',
          turn.susulan.kirim
            ? t('Susulan bila pelanggan diam: {0}', turn.susulan.teks)
            : t('Susulan dibatalkan pemeriksa: {0} · {1}', turn.susulan.asli, turn.susulan.alasan),
          `wa-sim-room-msg out nudge${turn.susulan.kirim ? '' : ' cancelled'}`
        )
      )
    if (turn.serah_cs) out.push(el('div', t('Diserahkan ke CS · {0}', turn.alasan || ''), 'wa-sim-room-note'))
    if (turn.error) out.push(el('div', turn.error, 'wa-sim-room-note err'))
    const meta = [checkerNote(turn), turn.ms ? `${(turn.ms / 1000).toFixed(1)} s` : ''].filter(Boolean).join(' · ')
    if (meta) out.push(el('div', meta, 'wa-sim-room-meta'))
    if (turn.draf) {
      const box = el('details', undefined, 'wa-sim-room-draft')
      box.append(
        el('summary', t('Draf sebelum diperbaiki')),
        el('pre', [...turn.draf.pesan, ...turn.draf.foto.map((caption) => `🖼 ${caption}`), '', ...turn.draf.masalah.map((item) => `✗ ${item}`)].join('\n'))
      )
      out.push(box)
    }
    return out
  }
  async function loadRoom() {
    const data = await api('/api/beta3/sim/room')
    const chat = byId('simRoomChat')
    let turns = []
    let info = ''
    let pending = false
    if (roomView === 'live') {
      const live = data.live
      if (live?.current) {
        turns = live.current.giliran || []
        info = t('Uji berjalan {0}/{1} · {2} lulus · {3}', live.done + 1, live.total, live.passed, live.current.judul)
        pending = true
      } else info = t('Tidak ada uji yang berjalan. Jalankan uji, atau pilih Chat uji untuk mengetik sendiri.')
    } else {
      turns = data.turns || []
      pending = data.busy
      info = data.busy ? t('AI sedang membalas…') : turns.length ? t('{0} giliran', turns.length) : t('Tulis pesan sebagai pelanggan. Tidak ada yang dikirim ke WhatsApp.')
    }
    byId('simRoomInfo').textContent = info
    byId('simRoomForm').hidden = roomView !== 'mine'
    byId('simRoomReset').hidden = roomView !== 'mine'
    byId('simRoomSend').disabled = Boolean(data.busy)
    const key = JSON.stringify([roomView, turns.length, turns.at(-1)?.ms || 0, pending])
    if (key !== roomKey) {
      roomKey = key
      chat.replaceChildren(...turns.flatMap(roomTurn))
      if (roomView === 'mine' && data.busy) chat.append(el('div', t('AI sedang membalas…'), 'wa-sim-room-note'))
      chat.scrollTop = chat.scrollHeight
    }
    clearTimeout(roomTimer)
    if (document.visibilityState === 'visible') roomTimer = setTimeout(() => loadRoom().catch(() => {}), pending || data.live ? 3000 : 15000)
  }
  for (const tab of roomTabs)
    tab.addEventListener('click', () => {
      roomView = tab.dataset.room
      for (const other of roomTabs) other.setAttribute('aria-pressed', String(other === tab))
      roomKey = ''
      loadRoom().catch((error) => notice(error.message, true))
    })
  byId('simRoomForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const teks = byId('simRoomText').value.trim()
    const gambar = byId('simRoomImage').value.trim()
    if (!teks && !gambar) return
    try {
      await api('/api/beta3/sim/room', 'POST', { teks, gambar })
      byId('simRoomText').value = ''
      byId('simRoomImage').value = ''
      await loadRoom()
    } catch (error) {
      notice(error.message, true)
    }
  })
  byId('simRoomReset').addEventListener('click', async () => {
    await api('/api/beta3/sim/room/reset', 'POST', {}).catch((error) => notice(error.message, true))
    roomKey = ''
    await loadRoom().catch(() => {})
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadRoom().catch(() => {})
  })
  byId('beta3SimCustomRun').addEventListener('click', () => {
    const giliran = byId('beta3SimCustom').value.split('\n').map((line) => line.trim()).filter(Boolean)
    if (!giliran.length) return
    startSim({ custom: [{ judul: t('Coba sendiri'), giliran }] })
  })
  const refresh = () => Promise.all([loadCatalog(), loadExamples(), loadMcp(), loadSim(), loadRoom()]).catch((error) => notice(error.message, true))
  refresh()
  setInterval(() => {
    if (document.visibilityState === 'visible') loadCatalog().catch(() => {})
  }, 60_000)
})()
