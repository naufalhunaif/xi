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
  // v3.6.50: detak jantung saat sehat cukup tiap 30 dtk (dulu 2 dtk); saat terputus dicoba
  // terus dengan jeda 5 → 10 → 20 → 30 dtk (dulu berhenti setelah 3 kali gagal).
  const HEARTBEAT_MS = 30_000
  const RETRY_MAX_MS = 30_000
  let lastProbe = 0
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
    // Sederhana: tanpa internet → cukup keterangan (pulih sendiri saat internet kembali);
    // server belum terjangkau → "menghubungkan ulang", tombol Coba lagi hanya bila tetap gagal.
    const offline = !online()
    const paused = failures >= 3 && !offline
    panel.dataset.state = offline ? 'offline' : paused ? 'paused' : 'retrying'
    document.getElementById('networkNoticeText').textContent = t(
      offline ? 'Tidak ada internet' : paused ? 'Server belum bisa dihubungi' : 'Menghubungkan ulang…'
    )
    const retry = document.getElementById('networkRetry')
    retry.hidden = !paused
    retry.disabled = checking
  }
  function note(url, kind, response) {
    const requestId = response?.headers.get('X-Request-ID') || ''
    failure = {
      kind, path: url.pathname, status: response?.status || 0,
      requestId: /^[A-Za-z0-9_-]{1,100}$/.test(requestId) ? requestId : '',
      at: new Date().toISOString(),
    }
  }
  /**
   * v3.6.50: satu permintaan gagal/lambat TIDAK lagi membekukan seluruh halaman. Hanya permintaan
   * itu yang gagal; koneksi diperiksa sekali (detak /api/workspace). Mode "menghubungkan ulang"
   * hanya bila pemeriksaan itu juga gagal.
   */
  function suspect(url, kind, response) {
    note(url, kind, response)
    if (!recovering) void check(true)
  }
  function failed(url, kind, response) {
    if (failure?.kind === 'csp_blocked' && kind === 'network_error' && failures >= 3) return
    failures += 1
    retryAt = Date.now() + Math.min(RETRY_MAX_MS, 5_000 * 2 ** (failures - 1))
    recovering = true
    note(url, kind, response)
    renderNetwork()
  }
  function restored() {
    if (!recovering) return
    recovering = false
    failures = 0
    retryAt = 0
    renderNetwork()
    window.dispatchEvent(new Event('wa:network-restored'))
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
      if (!recovering) failed(url, 'offline', null)
      return unavailable()
    }
    // Saat menghubungkan ulang, permintaan tetap diteruskan (tidak ditahan); yang berhasil
    // langsung memulihkan halaman. Mutasi tidak pernah diantrikan atau diulang.
    return request(input, init, url)
  }
  async function request(input, init, url, probe = false) {
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
      if (!changing && !suspended && !signal?.aborted && (timedOut || error.name !== 'AbortError')) {
        if (probe) failed(url, timedOut ? 'timeout' : 'network_error', null)
        else suspect(url, timedOut ? 'timeout' : 'network_error', null)
      }
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
    const kind = response.headers.get('X-WhatsApp-Auth') === 'unavailable' ? 'auth_unavailable' : 'http_error'
    if (probe) {
      // The heartbeat must prove both authentication and workspace identity.
      if (response.status === 204 && current === version) restored()
      else failed(url, response.status >= 500 || response.status === 429 ? kind : 'unexpected_response', response)
    } else if (response.status >= 500 || response.status === 429) suspect(url, kind, response)
    else if (recovering) restored()
    return response
  }
  async function check(manual = false) {
    if (checking || changing || suspended || !online()) return
    if (!manual) {
      if (document.hidden) return
      if (recovering ? Date.now() < retryAt : Date.now() - lastProbe < HEARTBEAT_MS) return
    }
    lastProbe = Date.now()
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
      if (!recovering) failed(url, 'csp_blocked', null)
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
  window.addEventListener('offline', () => {
    if (!recovering && !changing) failed(new URL(`${app}/api/workspace`), 'offline', null)
    else renderNetwork()
  })
  document.addEventListener('ui-language:change', renderNetwork)
  // Kembali ke tab saat terputus → langsung dicoba (tidak menunggu jeda).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check(recovering)
  })
})()
