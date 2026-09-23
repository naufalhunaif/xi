;(() => {
  const input = document.getElementById('skillEditInstruction')
  const button = document.getElementById('skillEditSubmit')
  const status = document.getElementById('skillEditStatus')
  if (!input || !button || !status) return
  const t = (key) => window.waI18n?.t(key) ?? key
  const base = document.querySelector('meta[name="app-url"]')?.content?.replace(/\/$/, '') || ''
  const scope = document.querySelector('meta[name="whatsapp-workspace"]')?.content || ''
  const storageKey = `${base}:${scope}:skill-edit`
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  let pending = null
  let timer
  let busy = false
  let phase = ''
  function remember(value) {
    try { value ? sessionStorage.setItem(storageKey, JSON.stringify(value)) : sessionStorage.removeItem(storageKey) } catch {}
  }
  function show(message, error = false) {
    status.textContent = message
    status.hidden = !message
    status.classList.toggle('error', error)
  }
  function lock(value) {
    busy = value
    input.disabled = value
    button.disabled = value
    button.setAttribute('aria-busy', String(value))
    button.textContent = t(value ? 'Memperbarui skill…' : 'Update dengan AI')
  }
  async function request(path, body) {
    const response = await fetch(`${base}/api/settings/skill-edits${path}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = await response.json()
    if (!response.ok || response.redirected) {
      const error = new Error(t(data.error || 'Status pembaruan belum tersedia.'))
      error.status = response.status
      throw error
    }
    return data
  }
  function render(job) {
    if (!['pending', 'running', 'completed', 'failed'].includes(job.status)) throw new Error(t('Status pembaruan belum tersedia.'))
    phase = job.status
    if (['pending', 'running'].includes(job.status)) {
      lock(true)
      show(t('Memperbarui skill…'))
      clearTimeout(timer)
      timer = setTimeout(poll, 3000)
      return
    }
    clearTimeout(timer)
    lock(false)
    pending = null
    remember(null)
    if (job.status === 'completed') {
      const names = (job.changes || []).map((change) => change.name).join(', ')
      show([t(names ? 'Skill diperbarui' : 'Tidak ada perubahan skill'), names, job.summary].filter(Boolean).join(' · '))
      document.dispatchEvent(new CustomEvent('skills:replace', { detail: job.skills || [] }))
    } else show([job.errorCode, t(job.summary || 'Pembaruan skill gagal. Skill sebelumnya tetap digunakan.')].filter(Boolean).join(' · '), true)
  }
  async function poll() {
    if (!pending) return
    try { render(await request(`/${encodeURIComponent(pending.requestKey)}`)) }
    catch (error) {
      if ([401, 403, 409, 422].includes(error.status)) {
        lock(false)
        pending = null
        remember(null)
        show(error.message, true)
        return
      }
      // A network failure is not proof the edit failed. Poll only; never submit twice.
      show(error.message, true)
      timer = setTimeout(poll, 8000)
    }
  }
  button.addEventListener('click', async () => {
    if (busy) return
    if (!input.value.trim()) { show(t('Tulis instruksi perubahan skill.'), true); input.focus(); return }
    if (!pending || pending.instruction !== input.value.trim())
      pending = { requestKey: crypto.randomUUID(), instruction: input.value.trim() }
    remember(pending)
    lock(true)
    show(t('Memperbarui skill…'))
    try { render(await request('', pending)) }
    catch (error) { lock(false); show(error.message, true) }
  })
  document.addEventListener('ui-language:change', () => {
    lock(busy)
    if (['pending', 'running'].includes(phase)) show(t('Memperbarui skill…'))
  })
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
    if (saved?.requestKey && typeof saved.instruction === 'string') {
      pending = saved
      input.value = saved.instruction
      lock(true)
      void poll()
    }
  } catch {}
})()
