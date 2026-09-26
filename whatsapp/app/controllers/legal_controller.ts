import type { HttpContext } from '@adonisjs/core/http'

// Halaman publik: beranda "Chat", Kebijakan Privasi, Syarat Layanan (syarat Google OAuth).
const ICON = `<svg width="28" height="28" viewBox="0 0 512 512" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="36" stroke-linejoin="round" d="M87.49 380c1.19-4.38-1.44-10.47-3.95-14.86a44.86 44.86 0 00-2.54-3.8 199.81 199.81 0 01-33-110C47.65 139.09 140.73 48 255.83 48 356.21 48 440 117.54 459.58 209.85a199 199 0 014.42 41.64c0 112.41-89.49 204.93-204.59 204.93-18.3 0-43-4.6-56.47-8.37s-26.92-8.77-30.39-10.11a31.09 31.09 0 00-11.12-2.07 30.71 30.71 0 00-12.09 2.43l-67.83 24.48a16 16 0 01-4.67 1.22 9.6 9.6 0 01-9.57-9.74 15.85 15.85 0 01.6-3.29z"/></svg>`

function shell(title: string, content: string) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title === 'Chat' ? 'Chat' : `${title} · Chat`}</title>
<meta name="description" content="Chat — layanan pelanggan dan pengelolaan pesanan toko.">
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1f1d;--muted:#6b716c;--line:#e4e6e3;--accent:#18865b}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#171719;--text:#e6ebe7;--muted:#9aa59d;--line:#2c2c30;--accent:#88d9ad}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px 16px;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{width:min(460px,100%);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-weight:600;font-size:18px}
h1{margin:18px 0 6px;font-size:20px;font-weight:600}
p{margin:0 0 12px;color:var(--muted)}
ul{margin:0;padding:0;list-style:none;display:grid;gap:10px}
li{display:grid;grid-template-columns:18px 1fr;gap:8px;color:var(--text)}
li::before{content:"";width:6px;height:6px;margin:9px 0 0 4px;border-radius:50%;background:var(--accent)}
.button{display:block;margin-top:22px;padding:10px 14px;border-radius:6px;background:var(--accent);color:#fff;text-align:center;text-decoration:none;font-weight:500}
@media(prefers-color-scheme:dark){.button{color:#06150e}}
footer{display:flex;gap:16px;font-size:12px;color:var(--muted)}
footer a{color:inherit;text-decoration:none}footer a:hover{color:var(--text)}
small{display:block;margin-top:18px;color:var(--muted);font-size:12px}
</style></head><body>
<main><a class="brand" href="/">${ICON}<span>Chat</span></a>${content}</main>
<footer><a href="/">Beranda</a><a href="/privacy">Privasi</a><a href="/terms">Syarat</a></footer>
</body></html>`
}

/** Beranda publik (tanpa login) — nama sama dengan layar izin Google: "Chat". */
export function landingPage(_host = '') {
  return shell(
    'Chat',
    `<a class="button" href="/login">Login</a>`
  )
}

export default class LegalController {
  async privacy({ response }: HttpContext) {
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      shell(
        'Kebijakan Privasi',
        `<h1>Kebijakan Privasi</h1>
<ul>
<li>Chat dipakai internal oleh pemilik dan tim toko.</li>
<li>Google Drive hanya dipakai untuk menyimpan &amp; memulihkan file backup buatan aplikasi ini (izin drive.file). File lain tidak dibaca.</li>
<li>Email akun Google hanya untuk menampilkan akun yang terhubung.</li>
<li>Data tidak dijual, tidak dibagikan, dan tidak dipakai untuk iklan.</li>
<li>Akses bisa dicabut kapan saja di Pengaturan → Backup atau myaccount.google.com/permissions.</li>
</ul>
<small>Diperbarui 27 September 2026</small>`
      )
    )
  }

  async terms({ response }: HttpContext) {
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      shell(
        'Syarat Layanan',
        `<h1>Syarat Layanan</h1>
<ul>
<li>Chat adalah aplikasi internal; akses hanya untuk akun yang diberikan pemilik toko.</li>
<li>Pengguna bertanggung jawab atas data yang dimasukkan dan layanan yang dihubungkan.</li>
<li>Backup Google Drive hanya menyimpan &amp; memulihkan file milik aplikasi ini.</li>
<li>Aplikasi disediakan apa adanya untuk keperluan toko.</li>
</ul>
<small>Diperbarui 27 September 2026</small>`
      )
    )
  }
}
