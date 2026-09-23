;(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const easing = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const active = new Map()
  function stop(element) {
    const previous = active.get(element)
    if (!previous) return
    active.delete(element)
    previous.animation.cancel()
  }
  function animate(element, frames, duration = 280, complete = () => {}) {
    stop(element)
    if (reduced.matches || document.hidden || !element.animate) {
      complete()
      return
    }
    const animation = element.animate(frames, { duration, easing, fill: 'both' })
    const record = {
      animation,
      finish: () => {
        if (active.get(element) !== record) return
        active.delete(element)
        complete()
        animation.cancel()
      },
    }
    active.set(element, record)
    animation.finished.then(record.finish).catch(() => {})
  }
  function enter(element, kind = 'panel') {
    if (!element || element.hidden || !element.isConnected) return
    const from =
      kind === 'sheet' ? 'translateX(28px)' : kind === 'media' ? 'scale(0.975)' : 'translateY(6px)'
    animate(
      element,
      [
        { opacity: 0, transform: from },
        { opacity: 1, transform: 'none' },
      ],
      kind === 'sheet' ? 340 : 260
    )
  }
  function showDialog(dialog) {
    stop(dialog)
    dialog.classList.remove('wa-dialog-leaving')
    const alreadyOpen = dialog.open
    if (!alreadyOpen) dialog.showModal()
    if (!alreadyOpen)
      enter(
        dialog,
        dialog.id === 'cartDialog' || dialog.dataset.motion === 'sheet' ? 'sheet' : 'media'
      )
  }
  function closeDialog(dialog) {
    if (!dialog.open || dialog.classList.contains('wa-dialog-leaving')) return
    const opacity = getComputedStyle(dialog).opacity
    dialog.classList.add('wa-dialog-leaving')
    // Stop sound immediately; dialog cleanup still runs through its native close event.
    dialog.querySelectorAll('video, audio').forEach((player) => player.pause())
    animate(
      dialog,
      [
        { opacity, transform: getComputedStyle(dialog).transform },
        {
          opacity: 0,
          transform:
            dialog.id === 'cartDialog' || dialog.dataset.motion === 'sheet'
              ? 'translateX(18px)'
              : 'scale(0.985)',
        },
      ],
      180,
      () => {
        dialog.classList.remove('wa-dialog-leaving')
        dialog.close()
      }
    )
  }
  function visible(element, show) {
    if (!element) return
    const closing = active.has(element)
    if (show) {
      stop(element)
      const wasHidden = element.hidden
      element.hidden = false
      if (!wasHidden && closing) enter(element)
    } else if (!element.hidden) {
      animate(
        element,
        [
          {
            opacity: getComputedStyle(element).opacity,
            transform: getComputedStyle(element).transform,
          },
          { opacity: 0, transform: 'translateY(3px)' },
        ],
        150,
        () => {
          element.hidden = true
        }
      )
    }
  }
  function resize(element, before) {
    if (!element || !before?.width || !before?.height || reduced.matches) return
    const after = element.getBoundingClientRect()
    if (!after.width || !after.height) return
    animate(
      element,
      [
        {
          transformOrigin: 'top left',
          transform: `translate(${before.x - after.x}px, ${before.y - after.y}px) scale(${before.width / after.width}, ${before.height / after.height})`,
        },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      300
    )
  }
  window.waMotion = { enter, showDialog, closeDialog, visible, resize }
  // One delegated listener and at most one frame per pointer move burst. No idle loop.
  // Only compact action controls attract the mouse, never rows, inputs or media.
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  const magneticButtons = '.button, .shell-icon-button, .wa-icon-button, .wa-setting-icon, .wa-info-button, .wa-order-copy, .wa-skill-download, .message-actions > button, .reaction-picker button'
  let magnet = null
  let magnetBounds = null
  let magnetFrame = 0
  let magnetPoint = null
  function resetMagnet() {
    if (magnetFrame) cancelAnimationFrame(magnetFrame)
    magnetFrame = 0
    magnet?.style.removeProperty('--wa-magnet-x')
    magnet?.style.removeProperty('--wa-magnet-y')
    magnet = magnetBounds = magnetPoint = null
  }
  document.addEventListener('pointermove', (event) => {
    const button = event.target instanceof Element ? event.target.closest(magneticButtons) : null
    if (reduced.matches || !finePointer.matches || event.pointerType !== 'mouse' || event.buttons ||
      !button?.closest('.workspace-ui') || button.matches(':disabled, [aria-disabled="true"]') || button.closest('[inert]')) {
      resetMagnet()
      return
    }
    if (button !== magnet) {
      resetMagnet()
      magnet = button
      // Stable bounds prevent drift/oscillation as the button follows the pointer.
      magnetBounds = button.getBoundingClientRect()
    }
    magnetPoint = { x: event.clientX, y: event.clientY }
    if (magnetFrame) return
    magnetFrame = requestAnimationFrame(() => {
      magnetFrame = 0
      if (!magnet?.isConnected || !magnetBounds?.width || !magnetBounds.height) return resetMagnet()
      const offset = (position, start, size) => Math.max(-1, Math.min(1, (position - start - size / 2) / (size / 2))) * 2
      magnet.style.setProperty('--wa-magnet-x', `${offset(magnetPoint.x, magnetBounds.left, magnetBounds.width).toFixed(2)}px`)
      magnet.style.setProperty('--wa-magnet-y', `${offset(magnetPoint.y, magnetBounds.top, magnetBounds.height).toFixed(2)}px`)
    })
  }, { passive: true })
  document.addEventListener('pointerout', (event) => {
    if (magnet && (!(event.relatedTarget instanceof Node) || !magnet.contains(event.relatedTarget))) resetMagnet()
  }, { passive: true })
  for (const event of ['pointerdown', 'pointercancel', 'keydown', 'focusin'])
    document.addEventListener(event, resetMagnet, { passive: true })
  document.addEventListener('scroll', resetMagnet, { passive: true, capture: true })
  window.addEventListener('resize', resetMagnet, { passive: true })
  window.addEventListener('blur', resetMagnet)
  finePointer.addEventListener('change', resetMagnet)
  const reveals =
    '[data-settings-panel], #launcherMenu, .reaction-picker, #replyComposer, #mediaComposer, #cartPaymentForm, #orderDetailPanel, #qrPanel, .wa-oauth-device'
  new MutationObserver((records) => {
    for (const record of records) {
      const element = record.target
      if (magnet?.matches(':disabled, [aria-disabled="true"]')) resetMagnet()
      if (record.attributeName !== 'hidden') continue
      if (record.oldValue !== null && !element.hidden && element.matches(reveals)) enter(element)
    }
  }).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'disabled', 'aria-disabled'],
    attributeOldValue: true,
  })
  document.addEventListener('click', (event) => {
    const summary = event.target.closest('summary')
    if (!summary || event.target.closest('a, button, input, select')) return
    const details = summary.parentElement
    if (details.tagName !== 'DETAILS' || !details.closest('.workspace-ui')) return
    if (reduced.matches) return
    event.preventDefault()
    const wasClosing = details.dataset.motionClosing === 'true'
    const shouldOpen = !details.open || wasClosing
    const start = details.getBoundingClientRect().height
    stop(details)
    details.dataset.motionClosing = String(!shouldOpen)
    details.open = true
    const end = shouldOpen
      ? details.getBoundingClientRect().height
      : summary.getBoundingClientRect().height +
        parseFloat(getComputedStyle(details).paddingTop) +
        parseFloat(getComputedStyle(details).paddingBottom) +
        parseFloat(getComputedStyle(details).borderTopWidth) +
        parseFloat(getComputedStyle(details).borderBottomWidth)
    animate(
      details,
      [
        { height: `${start}px`, overflow: 'hidden' },
        { height: `${end}px`, overflow: 'hidden' },
      ],
      300,
      () => {
        details.open = shouldOpen
        delete details.dataset.motionClosing
      }
    )
  })
  function finishAll() {
    for (const record of [...active.values()]) record.finish()
  }
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      resetMagnet()
      finishAll()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resetMagnet()
      finishAll()
    }
  })
  // Avoid animating a saved sidebar preference during the initial page load.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.documentElement.classList.add('wa-motion-ready'))
  )
})()
