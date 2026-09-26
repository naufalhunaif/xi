;(() => {
  const button = document.getElementById('chatCleanupButton')
  const status = document.getElementById('chatCleanupStatus')
  const resetButton = document.getElementById('dataResetButton')
  const resetStatus = document.getElementById('dataResetStatus')
  const resetPhone = document.getElementById('dataResetPhone')
  if (!button || !status) return
  const base = document.querySelector('meta[name="app-url"]')?.content?.replace(/\/$/, '') || ''
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || ''
  const t = (text) => window.waI18n?.t(text) || text
  let pending = false
  let checking = false
  let label = ''
  let mode = 'chat'
  let phone = ''
  function render() {
    button.disabled = pending
    if (resetButton) resetButton.disabled = pending || !phone
    status.textContent = t(label)
    if (resetStatus) resetStatus.textContent = t(label)
    if (resetPhone) resetPhone.textContent = phone ? `+${phone}` : '—'
  }
  async function check() {
    if (checking || document.hidden) return
    checking = true
    try {
      const response = await fetch(`${base}/api/chats/cleanup`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Status penghapusan belum tersedia.')
      const data = await response.json()
      mode = data.mode || 'chat'
      phone = data.phone || ''
      pending = ['pending', 'deleting', 'retrying'].includes(data.status)
      label =
        data.status === 'retrying'
          ? 'Penghapusan belum selesai. Mencoba kembali…'
          : pending
            ? mode === 'contact'
              ? 'Menghapus data pelanggan…'
              : mode === 'all'
              ? 'Mereset data nomor aktif…'
              : 'Menghapus chat & media…'
            : data.status === 'completed'
              ? mode === 'contact'
                ? 'Data pelanggan telah dihapus.'
                : mode === 'all'
                ? 'Reset selesai. Data percakapan dan pesanan telah dihapus.'
                : 'Chat & media telah dihapus.'
              : ''
    } catch {
      if (pending) label = 'Status penghapusan belum tersedia.'
    } finally {
      checking = false
      render()
    }
  }
  async function startReset(all = false) {
    const warning = all
      ? `${phone ? `+${phone}\n\n` : ''}${t('Hapus seluruh chat, media, cart, order, pembayaran, saldo, alamat tersimpan, ingatan AI, dan antrean nomor aktif? Tidak dapat dibatalkan. Cadangkan data penting terlebih dahulu. Kontak dasar, skill, pengaturan, akun AI, dan koneksi nomor tetap disimpan. Data nomor lain dan Orion/MCP tidak diubah.')}`
      : t(
          'Hapus chat dan media pada nomor aktif? Tidak dapat dibatalkan. Catatan AI per chat (Beta 2) ikut dihapus. Kontak, cart, order, saldo, akun AI, skill, katalog, pengaturan, dan sesi nomor tetap tersimpan. Media referensi pesanan tetap disimpan.'
        )
    if (pending || (all && !phone) || !window.confirm(warning)) return
    if (
      all &&
      window.prompt(t('Ketik RESET ALL untuk menghapus permanen data nomor aktif.')) !== 'RESET ALL'
    )
      return
    pending = true
    mode = all ? 'all' : 'chat'
    label = all ? 'Mereset data nomor aktif…' : 'Menghapus chat & media…'
    render()
    try {
      const response = await fetch(`${base}/api/chats/cleanup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          'Accept': 'application/json',
        },
        body: JSON.stringify(
          all ? { mode: 'all', confirmation: 'RESET ALL' } : { confirmation: 'DELETE' }
        ),
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(data.error || 'Penghapusan belum dapat dimulai. Coba lagi sebentar.')
      await check()
    } catch (error) {
      // Never auto-repeat a destructive POST when the response is uncertain.
      label = error.message || 'Status penghapusan belum tersedia.'
      pending = false
      render()
      await check()
    }
  }
  button.addEventListener('click', () => startReset())
  resetButton?.addEventListener('click', () => startReset(true))
  document.addEventListener('ui-language:change', render)
  window.setInterval(check, 5000)
  void check()
})()
