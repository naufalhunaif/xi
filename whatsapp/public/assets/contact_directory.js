;(() => {
  if (!document.getElementById('contactDirectory')) return
  const byId = (id) => document.getElementById(id)
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const t = (key, ...args) =>
    window.waI18n?.t(key, ...args) ?? key.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
  const node = (tag, text = '', cls = '') => {
    const el = document.createElement(tag)
    el.textContent = text
    el.className = cls
    return el
  }
  // +62 812-0000-0101 dari 6281200000101 (nomor lain apa adanya).
  const formatPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '')
    if (!digits.startsWith('62') || digits.length < 10) return value || ''
    const rest = digits.slice(2)
    return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}${rest.length > 7 ? `-${rest.slice(7)}` : ''}`
  }
  let page = 1,
    revision = 0,
    timer,
    data,
    loading = false
  const query = () => byId('directorySearch').value.trim()
  async function request(path) {
    const response = await fetch(base + path, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok || response.redirected)
      throw new Error(t('Kontak belum dapat dimuat. Coba lagi.'))
    return response
  }
  function render() {
    if (!data) return
    const rows = byId('directoryRows')
    rows.replaceChildren()
    for (const contact of data.contacts) {
      const row = node('tr'),
        cell = node('td'),
        link = node('a', '', 'wa-directory-contact')
      const name = contact.name || contact.phone || t('Tanpa nama')
      link.href = `${base}/?jid=${encodeURIComponent(contact.jid)}`
      const fallback = node(
        'span',
        Array.from(name)[0]?.toUpperCase() || '?',
        'wa-directory-avatar'
      )
      fallback.setAttribute('aria-hidden', 'true')
      link.append(fallback)
      if (contact.photo) {
        try {
          const url = new URL(contact.photo, location.origin)
          if (['https:', 'http:'].includes(url.protocol)) {
            const image = node('img', '', 'wa-directory-avatar')
            image.alt = ''
            image.loading = 'lazy'
            image.width = 36
            image.height = 36
            image.referrerPolicy = 'no-referrer'
            image.addEventListener('error', () => image.replaceWith(fallback), { once: true })
            image.src = url.href
            fallback.replaceWith(image)
          }
        } catch {}
      }
      link.append(node('strong', name))
      cell.append(link)
      // v3.6.72: alamat satu baris (sumber + jumlah alamat lain di tooltip); nomor HP diformat.
      const addresses = node('td', '', 'wa-directory-addresses')
      const first = contact.addresses[0]
      if (first) {
        const line = node('span', first.address, 'wa-directory-address-line')
        const more = contact.addresses.length - 1
        line.title = contact.addresses
          .map((address) => [[address.name, address.phone].filter(Boolean).join(' · '), address.address].filter(Boolean).join('\n'))
          .join('\n\n')
        addresses.append(line)
        if (more > 0) addresses.append(node('span', ` +${more}`, 'wa-muted'))
      } else addresses.textContent = '—'
      row.append(cell, node('td', formatPhone(contact.phone) || '—', 'wa-directory-phone'), addresses)
      rows.append(row)
    }
    if (!data.contacts.length) {
      const row = node('tr'),
        cell = node('td', t('Belum ada kontak'))
      cell.colSpan = 3
      row.append(cell)
      rows.append(row)
    }
    byId('directoryCount').textContent = t('{0} kontak', data.total)
    const from = data.total ? (data.page - 1) * data.limit + 1 : 0
    byId('directoryPage').textContent = `${from}–${Math.min(data.total, data.page * data.limit)} / ${data.total}`
    byId('directoryPrevious').disabled = page <= 1
    byId('directoryNext').disabled = page * data.limit >= data.total
  }
  async function load() {
    const id = ++revision
    loading = true
    byId('directoryRows').setAttribute('aria-busy', 'true')
    byId('directoryNotice').textContent = ''
    try {
      const result = await (
        await request(`/api/contact-directory?${new URLSearchParams({ query: query(), page })}`)
      ).json()
      if (id !== revision) return
      data = result
      render()
    } catch (error) {
      if (id === revision) byId('directoryNotice').textContent = error.message
    } finally {
      if (id === revision) {
        loading = false
        byId('directoryRows').setAttribute('aria-busy', 'false')
      }
    }
  }
  byId('directorySearch').addEventListener('input', () => {
    clearTimeout(timer)
    revision++
    timer = setTimeout(() => {
      page = 1
      void load()
    }, 300)
  })
  byId('directoryPrevious').addEventListener('click', () => {
    if (!loading && page > 1) {
      page--
      void load()
    }
  })
  byId('directoryNext').addEventListener('click', () => {
    if (!loading && data && page * data.limit < data.total) {
      page++
      void load()
    }
  })
  byId('directoryExport').addEventListener('click', async () => {
    const button = byId('directoryExport')
    button.disabled = true
    byId('directoryNotice').textContent = ''
    try {
      const response = await request(
        `/api/contact-directory/export?${new URLSearchParams({ query: query(), language: document.documentElement.lang })}`
      )
      if (!response.headers.get('content-type')?.includes('text/csv'))
        throw new Error(t('Ekspor belum berhasil. Coba lagi.'))
      const url = URL.createObjectURL(await response.blob())
      const link = node('a')
      link.href = url
      link.download = 'contacts-addresses.csv'
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (error) {
      byId('directoryNotice').textContent = error.message
    } finally {
      button.disabled = false
    }
  })
  document.addEventListener('ui-language:change', render)
  void load()
})()
