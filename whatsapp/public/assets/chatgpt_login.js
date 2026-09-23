;(() => {
  // Keep login in the settings page until there is an actual code to enter.
  window.waChatgptLogin = {
    verificationUrl(value) {
      try {
        const url = new URL(value)
        return url.origin === 'https://auth.openai.com' && url.pathname === '/codex/device'
          && !url.username && !url.password && !url.search && !url.hash ? url.href : ''
      } catch { return '' }
    },
    async request(send, timeout = 30_000) {
      const controller = new AbortController()
      let timer
      try {
        return await Promise.race([
          send(controller.signal),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Permintaan login belum selesai. Periksa status atau mulai ulang login.'))
              controller.abort()
            }, timeout)
          }),
        ])
      } finally { clearTimeout(timer) }
    },
  }
})()
