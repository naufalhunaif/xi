;(() => {
  const form = document.getElementById('settingsForm')
  const status = document.getElementById('aiWorkStatus')
  if (!form || !status) return
  const t = (text) => window.waI18n?.t(text) ?? text
  const field = (key) => form.elements.namedItem(key)
  // Only use server-confirmed values for the current-status badge.
  const saved = Object.fromEntries(
    ['aiWorkMode', 'aiWorkTimezone', 'aiWorkDays', 'aiWorkStart', 'aiWorkEnd'].map((key) => [
      key,
      field(key).value,
    ])
  )
  let enabled = status.dataset.aiEnabled === 'true'
  function update() {
    document.getElementById('aiWorkFields').hidden = field('aiWorkMode').value === 'always'
    document.getElementById('aiWorkOvernight').hidden =
      field('aiWorkStart').value <= field('aiWorkEnd').value
    for (const button of form.querySelectorAll('[data-work-day]'))
      button.setAttribute(
        'aria-pressed',
        String(field('aiWorkDays').value.split(',').includes(button.dataset.workDay))
      )
    let active = enabled && saved.aiWorkMode === 'always'
    if (enabled && saved.aiWorkMode === 'scheduled') {
      try {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: saved.aiWorkTimezone,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          })
            .formatToParts(new Date())
            .map((p) => [p.type, p.value])
        )
        const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1
        const time = `${parts.hour}:${parts.minute}`
        const days = saved.aiWorkDays.split(',')
        active =
          saved.aiWorkStart < saved.aiWorkEnd
            ? days.includes(String(day)) && time >= saved.aiWorkStart && time < saved.aiWorkEnd
            : (days.includes(String(day)) && time >= saved.aiWorkStart) ||
              (days.includes(String(day === 1 ? 7 : day - 1)) && time < saved.aiWorkEnd)
      } catch {
        active = false
      }
    }
    status.textContent = t(
      !enabled ? 'Balas otomatis nonaktif' : active ? 'Sekarang: AI' : 'Sekarang: manusia'
    )
    status.dataset.active = String(active)
  }
  form.addEventListener('click', (event) => {
    const button = event.target.closest('[data-work-day]')
    if (!button) return
    const input = field('aiWorkDays')
    const days = new Set(input.value.split(',').filter(Boolean))
    days.has(button.dataset.workDay)
      ? days.delete(button.dataset.workDay)
      : days.add(button.dataset.workDay)
    input.value = [...days].sort().join(',')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    update()
  })
  for (const key of Object.keys(saved)) field(key).addEventListener('settings:reverted', update)
  document.addEventListener('settings:updated', (event) => {
    for (const key of Object.keys(saved))
      if (typeof event.detail?.[key] === 'string') saved[key] = event.detail[key]
    enabled = event.detail.aiEnabled === true
    update()
  })
  form.addEventListener('change', update)
  document.addEventListener('ui-language:change', update)
  window.setInterval(update, 30_000)
  update()
})()
