import type { HttpContext } from '@adonisjs/core/http'

// Halaman publik sederhana untuk syarat Google (Branding: Privacy policy & Terms of service).
const page = (title: string, body: string) => `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Chat</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1d1f1d}h1{font-size:22px}h2{font-size:15px;margin-top:24px}@media(prefers-color-scheme:dark){body{background:#000;color:#e6ebe7}}</style>
</head><body><p><a href="/" style="color:inherit">Chat</a></p><h1>${title}</h1>${body}<p style="color:#737873;font-size:13px">Terakhir diperbarui: 27 September 2026</p></body></html>`

/** Beranda publik (tanpa login) — nama aplikasi sama dengan layar izin Google: "Chat". */
export function landingPage(host: string) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat</title>
<meta name="description" content="Chat — aplikasi layanan pelanggan dan pengelolaan pesanan toko.">
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#1d1f1d}h1{font-size:28px;margin:0 0 4px}.muted{color:#737873}a.button{display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#18865b;color:#fff;text-decoration:none}ul{padding-left:18px}footer{margin-top:40px;font-size:13px}footer a{color:inherit;margin-right:16px}@media(prefers-color-scheme:dark){body{background:#000;color:#e6ebe7}}</style>
</head><body>
<svg width="40" height="40" viewBox="0 0 512 512" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="32" stroke-linejoin="round" d="M87.49 380c1.19-4.38-1.44-10.47-3.95-14.86a44.86 44.86 0 00-2.54-3.8 199.81 199.81 0 01-33-110C47.65 139.09 140.73 48 255.83 48 356.21 48 440 117.54 459.58 209.85a199 199 0 014.42 41.64c0 112.41-89.49 204.93-204.59 204.93-18.3 0-43-4.6-56.47-8.37s-26.92-8.77-30.39-10.11a31.09 31.09 0 00-11.12-2.07 30.71 30.71 0 00-12.09 2.43l-67.83 24.48a16 16 0 01-4.67 1.22 9.6 9.6 0 01-9.57-9.74 15.85 15.85 0 01.6-3.29z"/></svg>
<h1>Chat</h1>
<p class="muted">Aplikasi layanan pelanggan dan pengelolaan pesanan untuk toko di ${host}.</p>
<p>Chat membantu tim toko membalas pertanyaan pelanggan dengan bantuan AI, mencatat pesanan, dan meneruskan pesanan ke tim produksi.</p>
<ul>
<li>Kotak masuk percakapan pelanggan dan balasan dengan bantuan AI.</li>
<li>Pencatatan pesanan, ongkir, dan status pembayaran.</li>
<li>Backup data ke Google Drive milik pemilik toko (izin <b>drive.file</b>: hanya file backup yang dibuat aplikasi ini).</li>
</ul>
<p class="muted">Aplikasi ini dipakai secara internal oleh pemilik dan tim toko.</p>
<a class="button" href="/login">Masuk</a>
<footer><a href="/privacy">Kebijakan Privasi</a><a href="/terms">Syarat Layanan</a></footer>
</body></html>`
}

export default class LegalController {
  async privacy({ response, request }: HttpContext) {
    const host = request.host() || 'aplikasi ini'
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      page(
        'Kebijakan Privasi',
        `<p>Chat (${host}) adalah aplikasi internal untuk mengelola percakapan pelanggan dan pesanan toko. Aplikasi hanya dipakai oleh pemilik dan tim toko.</p>
<h2>Data Google yang diakses</h2>
<p>Bila pemilik menghubungkan Google Drive, aplikasi memakai izin <b>drive.file</b>: hanya membuat, membaca, dan menghapus file backup yang dibuat oleh aplikasi ini sendiri (folder "WA Backup"). Aplikasi tidak membaca file lain di Google Drive. Alamat email akun Google dipakai hanya untuk menampilkan akun yang terhubung.</p>
<h2>Penggunaan & penyimpanan</h2>
<p>File backup berisi data operasional toko (percakapan, pesanan, pengaturan) dan disimpan di Google Drive milik pemilik toko. Data tidak dijual, tidak dibagikan ke pihak ketiga, dan tidak dipakai untuk iklan. Token akses Google disimpan di server milik pemilik.</p>
<h2>Menghapus akses</h2>
<p>Pemilik dapat memutus koneksi kapan saja di Pengaturan → Backup, atau mencabut akses di myaccount.google.com/permissions.</p>`
      )
    )
  }

  async terms({ response, request }: HttpContext) {
    const host = request.host() || 'aplikasi ini'
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      page(
        'Syarat Layanan',
        `<p>Chat (${host}) adalah aplikasi internal milik toko untuk melayani pelanggan dan mengelola pesanan. Akses hanya untuk pemilik dan tim yang diberi akun.</p>
<h2>Penggunaan</h2>
<p>Pengguna bertanggung jawab atas data yang dimasukkan dan atas koneksi layanan pihak ketiga (misalnya Google Drive) yang dihubungkan ke aplikasi.</p>
<h2>Google Drive</h2>
<p>Fitur backup hanya menyimpan dan memulihkan file backup milik aplikasi ini di Google Drive pengguna, sesuai Kebijakan Privasi.</p>
<h2>Batasan</h2>
<p>Aplikasi disediakan apa adanya untuk keperluan internal toko.</p>`
      )
    )
  }
}
