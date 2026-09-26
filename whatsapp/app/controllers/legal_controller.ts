import type { HttpContext } from '@adonisjs/core/http'

// Halaman publik sederhana untuk syarat Google (Branding: Privacy policy & Terms of service).
const page = (title: string, body: string) => `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1d1f1d}h1{font-size:22px}h2{font-size:15px;margin-top:24px}@media(prefers-color-scheme:dark){body{background:#000;color:#e6ebe7}}</style>
</head><body><h1>${title}</h1>${body}<p style="color:#737873;font-size:13px">Terakhir diperbarui: 27 September 2026</p></body></html>`

export default class LegalController {
  async privacy({ response, request }: HttpContext) {
    const host = request.host() || 'aplikasi ini'
    response.header('content-type', 'text/html; charset=utf-8')
    return response.send(
      page(
        'Kebijakan Privasi',
        `<p>${host} adalah aplikasi internal untuk mengelola percakapan pelanggan dan pesanan toko. Aplikasi hanya dipakai oleh pemilik dan tim toko.</p>
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
        `<p>${host} adalah aplikasi internal milik toko untuk melayani pelanggan dan mengelola pesanan. Akses hanya untuk pemilik dan tim yang diberi akun.</p>
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
