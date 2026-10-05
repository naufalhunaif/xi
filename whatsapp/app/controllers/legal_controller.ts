import type { HttpContext } from '@adonisjs/core/http'
import { appVersion } from '#services/app_version'

// Halaman publik (Inggris, gaya Wireframe): beranda "Chat", Privacy Policy, Terms of Service (syarat Google OAuth).
const ICON = `<svg width="28" height="28" viewBox="0 0 512 512" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="36" stroke-linejoin="round" d="M87.49 380c1.19-4.38-1.44-10.47-3.95-14.86a44.86 44.86 0 00-2.54-3.8 199.81 199.81 0 01-33-110C47.65 139.09 140.73 48 255.83 48 356.21 48 440 117.54 459.58 209.85a199 199 0 014.42 41.64c0 112.41-89.49 204.93-204.59 204.93-18.3 0-43-4.6-56.47-8.37s-26.92-8.77-30.39-10.11a31.09 31.09 0 00-11.12-2.07 30.71 30.71 0 00-12.09 2.43l-67.83 24.48a16 16 0 01-4.67 1.22 9.6 9.6 0 01-9.57-9.74 15.85 15.85 0 01.6-3.29z"/></svg>`

function shell(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/assets/brand.svg" type="image/svg+xml">
<title>${title === 'Chat' ? 'Chat' : `${title} · Chat`}</title>
<meta name="description" content="Chat — customer service and order management for the store.">
<link rel="stylesheet" href="/assets/public.css?v=${appVersion()}">
</head><body>
<main><a class="brand" href="/">${ICON}<span>Chat</span></a><span class="kicker">Customer service &amp; orders</span>${content}</main>
<footer><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
</body></html>`
}

/** Beranda publik (tanpa login) — nama sama dengan layar izin Google: "Chat". */
export function landingPage(_host = '') {
  return shell(
    'Chat',
    `<a class="button" href="/login">Sign in</a>`
  )
}

export default class LegalController {
  async privacy({ response }: HttpContext) {
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      shell(
        'Privacy Policy',
        `<h1>Privacy Policy</h1>
<ul>
<li>Chat is used internally by the store owner and team.</li>
<li>Google Drive is used only to store &amp; restore backup files created by this app (drive.file scope). No other files are read.</li>
<li>The Google account email is used only to show which account is connected.</li>
<li>Instagram: the app reads DMs and comments on the connected store Instagram account and replies on the store's behalf. Stored data: message/comment text, sender name and username, and photos sent.</li>
<li>Data is never sold, shared, or used for advertising.</li>
<li>Access can be revoked at any time in Settings → Backup or at myaccount.google.com/permissions. Instagram access is revoked in Settings → Instagram → Disconnect, or in Instagram settings (Apps and websites).</li>
</ul>
<h2 id="hapus-data">Data deletion</h2>
<p>To delete your conversation data, send "delete my data" via Instagram DM or the store's WhatsApp. Data is deleted within 30 days.</p>
<small>Updated 2 October 2026</small>`
      )
    )
  }

  async terms({ response }: HttpContext) {
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      shell(
        'Terms of Service',
        `<h1>Terms of Service</h1>
<ul>
<li>Chat is an internal app; access is limited to accounts granted by the store owner.</li>
<li>Users are responsible for the data they enter and the services they connect.</li>
<li>Google Drive backup only stores &amp; restores files belonging to this app.</li>
<li>The app is provided as is for the store's own use.</li>
</ul>
<small>Updated 27 September 2026</small>`
      )
    )
  }
}
