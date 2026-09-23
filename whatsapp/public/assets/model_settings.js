(() => {
  document.querySelectorAll('[data-model-control]').forEach((control) => {
    const picker = control.querySelector('[data-model-picker]')
    const custom = control.querySelector('[data-model-custom]')
    const input = custom.querySelector('input')
    const sync = () => {
      const known = [...picker.options].some((option) => option.value !== '__custom__' && option.value === input.value)
      picker.value = known ? input.value : '__custom__'
      custom.hidden = known && input.getAttribute('aria-invalid') !== 'true'
      if (input.getAttribute('aria-invalid') === 'true') picker.setAttribute('aria-invalid', 'true')
      else picker.removeAttribute('aria-invalid')
    }
    sync()
    picker.addEventListener('change', () => {
      custom.hidden = picker.value !== '__custom__'
      if (!custom.hidden) {
        input.focus()
        input.select()
        return
      }
      input.value = picker.value
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    input.addEventListener('settings:saved', sync)
    new MutationObserver(() => {
      if (input.getAttribute('aria-invalid') === 'true') sync()
    }).observe(input, { attributes: true, attributeFilter: ['aria-invalid'] })
  })
})()
