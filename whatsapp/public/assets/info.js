;(() => {
  let active = null
  const close = (restoreFocus = false) => {
    if (!active) return
    const { button, panel } = active
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
    active = null
    if (restoreFocus) button.focus({ preventScroll: true })
  }
  const position = () => {
    if (!active) return
    const { button, panel } = active
    const rect = button.getBoundingClientRect()
    const viewport = window.visualViewport
    const width = viewport?.width || innerWidth
    const height = viewport?.height || innerHeight
    const left = viewport?.offsetLeft || 0
    const top = viewport?.offsetTop || 0
    panel.style.maxHeight = `${Math.max(80, height - 24)}px`
    panel.style.width = `${Math.min(360, width - 24)}px`
    panel.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - panel.offsetWidth - 12))}px`
    const below = rect.bottom + 8
    const y =
      below + panel.offsetHeight <= top + height - 12 ? below : rect.top - panel.offsetHeight - 8
    panel.style.top = `${Math.max(top + 12, Math.min(y, top + height - panel.offsetHeight - 12))}px`
  }
  for (const button of document.querySelectorAll('[data-info-target]')) {
    const panel = document.getElementById(button.dataset.infoTarget)
    if (!panel) continue
    // Escape clipped/closed containers without replacing live translated content.
    ;(button.closest('dialog') || document.body).append(panel)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (active?.button === button) return close()
      close()
      active = { button, panel }
      panel.hidden = false
      button.setAttribute('aria-expanded', 'true')
      position()
      panel.querySelector('[data-info-close]')?.focus({ preventScroll: true })
    })
    panel.querySelector('[data-info-close]')?.addEventListener('click', () => close(true))
  }
  document.addEventListener('pointerdown', (event) => {
    if (active && !active.panel.contains(event.target) && !active.button.contains(event.target))
      close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) {
      event.preventDefault()
      close(true)
    }
  })
  document.addEventListener('focusin', (event) => {
    if (active && !active.panel.contains(event.target) && event.target !== active.button) close()
  })
  window.addEventListener(
    'scroll',
    (event) => {
      if (!active || active.panel.contains(event.target)) return
      const rect = active.button.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > innerHeight) close()
      else position()
    },
    true
  )
  window.addEventListener('resize', position)
  window.visualViewport?.addEventListener('resize', position)
  window.addEventListener('hashchange', () => close())
  document.addEventListener('ui-language:change', position)
})()
