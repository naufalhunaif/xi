;(() => {
  const version = document.querySelector('meta[name="whatsapp-workspace"]')?.content
  const app = document.querySelector('meta[name="app-url"]')?.content?.replace(/\/$/, '')
  if (!version || !app) return
  const base = new URL(app, location.href)
  // Dipasang di akar domain: pathname '/' → awalan API harus '/api/', bukan '//api/'.
  const apiPrefix = `${base.pathname.replace(/\/$/, '')}/api/`
  const originalFetch = window.fetch.bind(window)
  let changing = false
  let retryAt = 0
  let recovering = false
  let checking = false
  let failures = 0
  let suspended = false
  let failure = null
  const controllers = new Set()
  const t = (value) => window.waI18n?.t(value) || value
  const online = () => navigator.onLine !== false
  const abortError = () => new DOMException('Request canceled', 'AbortError')
  function snapshot() {
    // No query strings, OAuth codes, cookies, customer IDs, tokens or response bodies.
    return {
      client: 'workspace-3', pageOrigin: location.origin, apiOrigin: base.origin,
      online: online(), failures, paused: failures >= 3,
      retryInSeconds: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)),
      failure: failure ? { ...failure } : null,
    }
  }
  function renderNetwork() {
    const panel = document.getElementById('networkNotice')
    if (!panel) return
    panel.hidden = !recovering || changing
    document.getElementById('networkNoticeText').textContent = t(
      failures >= 3 ? 'Koneksi belum pulih. Coba lagi.' : 'Koneksi terputus. Mencoba kembali…'
    )
    document.getElementById('networkRetry').disabled = checking || !online()
  }
  function failed(url, kind, response, probe) {
    if (failure?.kind === 'csp_blocked' && kind === 'network_error' && failures >= 3) return
    // Parallel errors belong to one failure wave, not separate retry attempts.
    if (!recovering || probe) {
      failures += 1
      retryAt = Date.now() + Math.min(60_000, 10_000 * 2 ** (failures - 1))
    }
    recovering = true
    const requestId = response?.headers.get('X-Request-ID') || ''
    failure = {
      kind, path: url.pathname, status: response?.status || 0,
      requestId: /^[A-Za-z0-9_-]{1,100}$/.test(requestId) ? requestId : '',
      at: new Date().toISOString(),
    }
    renderNetwork()
  }
  function unavailable() {
    return new Response(JSON.stringify({ code: 'CONNECTION_UNAVAILABLE', error: t('Koneksi belum pulih. Coba lagi.') }), {
      status: 503, headers: { 'content-type': 'application/json', 'Retry-After': '10' },
    })
  }
  function requireLogin() {
    if (changing) return
    changing = true
    window.waAuthExpired = true
    controllers.forEach((controller) => controller.abort())
    document.documentElement.style.visibility = 'hidden'
    // Navigation, not fetch: OAuth must never run inside a polling request.
    location.replace(`${app}/login`)
  }
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href)
    if (url.origin !== base.origin || !url.pathname.startsWith(apiPrefix))
      return originalFetch(input, init)
    if (changing || suspended) throw abortError()
    if (base.origin !== location.origin) {
      requireLogin()
      throw new Error(t('Sesi berakhir. Silakan masuk kembali.'))
    }
    if (!online()) {
      if (!recovering) failed(url, 'offline', null, false)
      return unavailable()
    }
    // Only check() can probe a failed connection. Never queue or replay mutations.
    if (recovering) return unavailable()
    return request(input, init, url)
  }
  async function request(input, init, url, probe = false) {
    const recoveryProbe = probe && recovering
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined)
    )
    headers.set('X-WhatsApp-Workspace', version)
    headers.set('Accept', 'application/json')
    const signal = init?.signal || (input instanceof Request ? input.signal : undefined)
    if (signal?.aborted) throw abortError()
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    controllers.add(controller)
    let timedOut = false
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const timeout = ['GET', 'HEAD'].includes(method)
      ? setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
      : undefined
    let response
    try {
      response = await originalFetch(input, {
        ...init, headers, cache: 'no-store', credentials: 'same-origin',
        mode: 'same-origin', redirect: 'manual', signal: controller.signal,
      })
    } catch (error) {
      // Do not replay a POST: it may already have reached the server.
      if (!changing && !suspended && !signal?.aborted && (timedOut || error.name !== 'AbortError'))
        failed(url, timedOut ? 'timeout' : 'network_error', null, recoveryProbe)
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      controllers.delete(controller)
    }
    if (changing || suspended) throw abortError()
    if (response.type === 'opaqueredirect' || (response.status === 401 && response.headers.get('X-WhatsApp-Auth') === 'required')) {
      requireLogin()
      throw new Error(t('Sesi berakhir. Silakan masuk kembali.'))
    }
    const current = response.headers.get('X-WhatsApp-Workspace')
    if (current && current !== version) {
      changing = true
      controllers.forEach((controller) => controller.abort())
      // Drop the old room, cart and unsaved form together; never reuse a JID across numbers.
      document.documentElement.style.visibility = 'hidden'
      location.replace(`${app}/`)
      throw new Error('Workspace changed')
    }
    if (response.status >= 500 || response.status === 429) {
      failed(url, response.headers.get('X-WhatsApp-Auth') === 'unavailable' ? 'auth_unavailable' : 'http_error', response, recoveryProbe)
    } else if (probe) {
      // The heartbeat must prove both authentication and workspace identity.
      if (response.status === 204 && current === version) {
        if (recovering && !recoveryProbe) return response
        const restored = recovering
        recovering = false
        failures = 0
        retryAt = 0
        renderNetwork()
        if (restored) window.dispatchEvent(new Event('wa:network-restored'))
      } else failed(url, 'unexpected_response', response, recoveryProbe)
    }
    return response
  }
  async function check(manual = false) {
    if (checking || changing || suspended || !online() || document.hidden) return
    if (!manual && recovering && (failures >= 3 || Date.now() < retryAt)) return
    checking = true
    renderNetwork()
    try {
      if (base.origin !== location.origin) return requireLogin()
      const url = new URL(`${app}/api/workspace`)
      await request(url.href, undefined, url, true)
    } catch {
    } finally {
      checking = false
      renderNetwork()
    }
  }
  window.waNetwork = { snapshot, retry: () => check(true) }
  document.addEventListener('securitypolicyviolation', (event) => {
    try {
      const url = new URL(event.blockedURI)
      if (url.origin !== base.origin || !url.pathname.startsWith(apiPrefix) ||
          !['connect-src', 'default-src'].includes(event.effectiveDirective)) return
      if (!recovering) failed(url, 'csp_blocked', null, false)
      failure = { ...failure, kind: 'csp_blocked', directive: event.effectiveDirective }
      failures = 3
      renderNetwork()
    } catch {}
  })
  document.addEventListener('DOMContentLoaded', () => {
    renderNetwork()
    document.getElementById('networkRetry')?.addEventListener('click', () => void check(true))
    document.getElementById('networkCopy')?.addEventListener('click', async () => {
      const data = JSON.stringify(snapshot(), null, 2)
      try {
        await navigator.clipboard.writeText(data)
        document.getElementById('networkNoticeText').textContent = t('Diagnostik disalin.')
      } catch {
        const field = document.getElementById('networkDetails')
        field.hidden = false
        field.value = data
        field.focus()
        field.select()
      }
    })
  })
  setInterval(() => {
    if (!document.hidden) void check()
  }, 2000)
  window.addEventListener('pagehide', () => {
    suspended = true
    controllers.forEach((controller) => controller.abort())
  })
  window.addEventListener('pageshow', () => { suspended = false; void check() })
  window.addEventListener('online', () => void check(true))
  document.addEventListener('ui-language:change', renderNetwork)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check()
  })
})()
