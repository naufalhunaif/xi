;(() => {
  const root = document.getElementById('leanPage')
  if (!root) return
  const byId = (id) => document.getElementById(id)
  const t = (value, ...args) =>
    window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  const money = (n) => new Intl.NumberFormat('id-ID').format(Number(n || 0))
  const notice = (message, error = false) => {
    byId('leanNotice').textContent = message
    byId('leanNotice').classList.toggle('error', error)
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
  const mcpDialog = byId('leanMcpDialog')
  const openMcp = () => {
    byId('leanMcpOpen').setAttribute('aria-expanded', 'true')
    if (typeof mcpDialog.showModal === 'function') mcpDialog.showModal()
    else mcpDialog.setAttribute('open', '')
  }
  const closeMcp = () => {
    if (mcpDialog.open) mcpDialog.close()
    byId('leanMcpOpen').setAttribute('aria-expanded', 'false')
  }
  byId('leanMcpOpen').addEventListener('click', openMcp)
  byId('leanMcpClose').addEventListener('click', closeMcp)
  mcpDialog.addEventListener('click', (event) => {
    if (event.target === mcpDialog) closeMcp()
  })

  function describeMcp(result) {
    if (result.error) return t('Gagal: {0}', result.error)
    if (!result.url) return t('Belum ada koneksi. Tambahkan dan hubungkan di Pengaturan → Data bisnis.')
    return `${result.name || result.url} · ${result.connected ? t('Terhubung.') : t('Belum terhubung.')}`
  }

  async function loadMcp() {
    const result = await api('/api/lean/mcp')
    const select = byId('leanMcpSlug')
    select.replaceChildren(new Option(t('— otomatis —'), ''))
    for (const source of result.sources || []) {
      select.append(new Option(`${source.name}${source.connected ? '' : ` (${t('belum terhubung')})`}`, source.slug))
    }
    select.value = result.slug || ''
    byId('leanMcpStatus').textContent = describeMcp(result)
    byId('leanSync').disabled = !result.connected
    byId('leanSync').title = result.connected ? t('Tarik katalog terbaru dari MCP') : t('Pilih sumber data dulu (ikon roda gigi)')
    return result
  }

  byId('leanSync').addEventListener('click', async () => {
    const button = byId('leanSync')
    button.disabled = true
    const label = button.textContent
    button.textContent = t('Menyinkronkan…')
    try {
      const result = await api('/api/lean/catalog/sync', 'POST', {})
      notice(
        result.unchanged
          ? t('Katalog belum berubah (versi {0}); tidak ada yang diunduh.', result.version.slice(0, 8))
          : t('{0} varian disinkronkan (versi {1}, ≈{2} token).', result.count, result.version.slice(0, 8), result.tokens)
      )
      await loadCatalog()
    } catch (error) {
      notice(error.message, true)
    } finally {
      button.textContent = label
      button.disabled = false
    }
  })
  byId('leanMcpForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    byId('leanMcpStatus').textContent = t('Menguji…')
    try {
      const result = await api('/api/lean/mcp', 'POST', { slug: byId('leanMcpSlug').value })
      byId('leanMcpStatus').textContent = describeMcp(result)
      byId('leanSync').disabled = !result.connected
      if (result.connected) setTimeout(closeMcp, 800)
    } catch (error) {
      byId('leanMcpStatus').textContent = error.message
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
  const digestDialog = dialogPair(byId('leanDigestDialog'), byId('leanDigestOpen'), byId('leanDigestClose'))
  const importDialog = dialogPair(byId('leanImportDialog'), byId('leanImportOpen'), byId('leanImportClose'))
  const exampleDialog = dialogPair(byId('leanExampleDialog'), byId('leanExampleOpen'), byId('leanExampleClose'))

  async function loadCatalog() {
    const result = await api('/api/lean/catalog')
    const when = result.updatedAt ? new Date(result.updatedAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : ''
    byId('leanCatalogStatus').textContent = result.rows.length
      ? [t('{0} varian', result.rows.length), t('≈{0} token', result.tokens), result.version ? t('versi {0}', String(result.version).slice(0, 8)) : '', when].filter(Boolean).join(' · ')
      : t('Belum ada katalog — tekan Sync katalog.')
    byId('leanCatalogDigest').textContent = result.digest
  }

  let examples = []
  function renderExamples() {
    const q = byId('leanExampleSearch').value.trim().toLowerCase()
    const shown = q
      ? examples.filter((example) => [example.situation, example.customerText, example.csText, example.tags].join(' ').toLowerCase().includes(q))
      : examples
    const list = byId('leanExampleList')
    list.replaceChildren()
    byId('leanExampleCount').textContent = q ? t('{0} dari {1} contoh', shown.length, examples.length) : t('{0} contoh', examples.length)
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
      const situation = el('td')
      situation.append(el('span', example.situation || '—'), el('br'), el('small', example.source, 'wa-muted'))
      const remove = el('button', t('Hapus'), 'button')
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        if (!confirm(t('Hapus contoh ini?'))) return
        try {
          await api(`/api/lean/examples/${example.id}`, 'DELETE')
          await loadExamples()
        } catch (error) {
          notice(error.message, true)
        }
      })
      const actions = el('td')
      actions.append(remove)
      row.append(situation, el('td', example.customerText), el('td', example.csText), el('td', example.tags || '—'), actions)
      list.append(row)
    }
  }
  async function loadExamples() {
    examples = (await api('/api/lean/examples')).examples || []
    renderExamples()
  }
  byId('leanExampleSearch').addEventListener('input', renderExamples)

  // Impor katalog: baca file .json di browser, kirim isinya apa adanya.
  byId('leanCatalogFile').addEventListener('change', () => {
    const file = byId('leanCatalogFile').files?.[0]
    byId('leanCatalogFileInfo').textContent = file ? `${file.name} · ${Math.round(file.size / 1024)} KB` : ''
  })
  byId('leanCatalogForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const file = byId('leanCatalogFile').files?.[0]
    if (!file) return
    try {
      const json = await file.text()
      JSON.parse(json)
      const result = await api('/api/lean/catalog', 'POST', { json, replace: byId('leanCatalogReplace').checked })
      notice(t('{0} varian diimpor (≈{1} token).', result.imported, result.tokens))
      byId('leanCatalogForm').reset()
      byId('leanCatalogFileInfo').textContent = ''
      importDialog.close()
      await loadCatalog()
    } catch (error) {
      notice(error instanceof SyntaxError ? t('File bukan JSON yang valid.') : error.message, true)
    }
  })
  byId('leanExampleForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await api('/api/lean/examples', 'POST', {
        situation: byId('leanExampleSituation').value,
        customerText: byId('leanExampleCustomer').value,
        csText: byId('leanExampleCs').value,
        tags: byId('leanExampleTags').value,
      })
      byId('leanExampleForm').reset()
      exampleDialog.close()
      notice(t('Contoh disimpan.'))
      await loadExamples()
    } catch (error) {
      notice(error.message, true)
    }
  })
  const refresh = () => Promise.all([loadCatalog(), loadExamples(), loadMcp()]).catch((error) => notice(error.message, true))
  refresh()
  setInterval(() => {
    if (document.visibilityState === 'visible') loadCatalog().catch(() => {})
  }, 60_000)
})()
