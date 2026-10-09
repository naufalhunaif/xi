;(() => {
  const root = document.documentElement
  const app = document.querySelector('meta[name="app-url"]')?.content?.replace(/\/$/, '') || ''
  const workspace = document.querySelector('meta[name="whatsapp-workspace-id"]')?.content || '1'
  const key = `${app}:${workspace}:ui-theme`
  const system = window.matchMedia('(prefers-color-scheme: dark)')
  const normalize = (value) => ['light', 'dark'].includes(value) ? value : 'auto'
  let preference = 'auto'
  try { preference = normalize(localStorage.getItem(key)) } catch {}
  function apply() {
    const theme = preference === 'auto' ? (system.matches ? 'dark' : 'light') : preference
    root.dataset.theme = theme
    root.dataset.themePreference = preference
    root.style.colorScheme = theme
    const control = document.getElementById('uiTheme')
    if (control) control.value = preference
    document.dispatchEvent(new CustomEvent('ui-theme:change', { detail: { preference, theme } }))
  }
  function setPreference(value) {
    preference = normalize(value)
    try { localStorage.setItem(key, preference) } catch {}
    apply()
  }
  system.addEventListener('change', () => { if (preference === 'auto') apply() })
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      preference = normalize(event.newValue)
      apply()
    }
  })
  // Runs in the head, before styles and body, to avoid a light flash on dark systems.
  apply()
  document.addEventListener('DOMContentLoaded', () => {
    apply()
    document.getElementById('uiTheme')?.addEventListener('change', (event) => setPreference(event.target.value))
  })
})()

// v3.6.108 — tinggi layar dari jendela (bukan hanya 100dvh): sesudah jendela dibesarkan/diubah, Chrome kadang
// tidak memperbarui 100dvh sehingga ruang chat hanya terisi setengah layar (bawahnya hitam kosong).
;(() => {
  const set = () => document.documentElement.style.setProperty('--app-h', `${Math.round(window.innerHeight)}px`)
  set()
  window.addEventListener('resize', set)
  window.addEventListener('pageshow', set)
  window.addEventListener('focus', set)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && set())
})()
