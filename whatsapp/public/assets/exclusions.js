;(() => {
  const t = (value, ...args) => window.waI18n?.t(value, ...args) ?? value.replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match)
  const byId = (id) => document.getElementById(id)
  const list = byId('exclusionList')
  const roomButton = byId('roomExclusionButton')
  if (!list && !roomButton) return
  const base = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
  const csrf = document.querySelector('meta[name="csrf-token"]').content
  let busy = false
  async function request(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = await response.json()
    if (!response.ok || response.redirected)
      throw new Error(data.error || t('Belum tersimpan. Coba lagi.'))
    return data
  }
  function status(message, error = false) {
    const element = byId('exclusionStatus') || byId('notice')
    if (!element) return
    element.textContent = message
    element.hidden = !message
    element.classList.toggle('error', error)
  }
  async function refresh() {
    if (!list) return
    const { contacts = [] } = await request('/api/ai/exclusions')
    const select = byId('exclusionContact')
    select.replaceChildren(new Option(t('Pilih kontak'), ''))
    list.replaceChildren()
    for (const contact of contacts) {
      if (!contact.excluded) {
        select.add(new Option(contact.name, contact.jid))
        continue
      }
      const row = document.createElement('div')
      row.className = 'wa-exclusion-row'
      const name = document.createElement('span')
      name.textContent = contact.name
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'wa-setting-icon wa-icon-delete'
      remove.dataset.removeExclusion = contact.jid
      remove.setAttribute('aria-label', t("Hapus {0} dari pengecualian AI", contact.name))
      remove.title = t('Hapus dari daftar')
      remove.textContent = t('Hapus')
      row.append(name, remove)
      list.append(row)
    }
    if (!list.children.length) {
      const empty = document.createElement('small')
      empty.textContent = t('Belum ada kontak')
      list.append(empty)
    }
  }
  async function change(jid, excluded) {
    if (busy || !jid) return
    busy = true
    const controls = [
      ...document.querySelectorAll(
        '#exclusionAdd, #exclusionContact, [data-remove-exclusion], #roomExclusionButton'
      ),
    ]
    controls.forEach((button) => {
      button.disabled = true
    })
    status(t('Menyimpan…'))
    try {
      await request('/api/contacts/exclusion', { jid, excluded })
      if (roomButton) {
        roomButton.setAttribute('aria-pressed', String(excluded))
        roomButton.title = excluded ? t('Hapus dari daftar Jangan dibalas AI') : t('Jangan dibalas AI')
        roomButton.setAttribute('aria-label', roomButton.title)
        byId('roomModeButton').disabled = excluded
      }
      document.dispatchEvent(new Event('ai-exclusions:updated'))
      status(
        excluded
          ? t('AI tidak akan membalas kontak ini.')
          : t('Dihapus. Aktifkan AI dari room jika diperlukan.')
      )
      await refresh()
    } catch (error) {
      status(error.message, true)
    } finally {
      busy = false
      controls.forEach((button) => {
        button.disabled = false
      })
    }
  }
  byId('exclusionAdd')?.addEventListener(
    'click',
    () => void change(byId('exclusionContact').value, true)
  )
  list?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-exclusion]')
    if (button) void change(button.dataset.removeExclusion, false)
  })
  roomButton?.addEventListener(
    'click',
    () =>
      void change(byId('messages')?.dataset.jid, roomButton.getAttribute('aria-pressed') !== 'true')
  )
  void refresh().catch((error) => status(error.message, true))
})()
