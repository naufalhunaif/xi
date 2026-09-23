# Fit Advisor MCP OAuth — aaPanel

Fit sudah memiliki login Account, halaman persetujuan MCP, registrasi klien,
PKCE, token, refresh, dan pencabutan akses. Jangan membuat login/password terpisah.
URL MCP yang dipasang di klien: `https://keepbelanja.com/fit/mcp`.

WhatsApp kini juga menyediakan OAuth bersama dengan fallback metadata CI3 khusus Fit.
Lihat `WHATSAPP-SHARED-MCP.md`: hubungkan ulang sekali setelah deploy. Perbaikan
Nginx di bawah tetap diperlukan agar discovery berfungsi untuk klien MCP lainnya.

## Jika tombol authorize/login MCP tidak muncul

Jika `/fit/.well-known/oauth-authorization-server` mengembalikan 404, tetapi
`/fit/index.php/.well-known/oauth-authorization-server` mengembalikan JSON 200,
discovery belum diteruskan ke PHP oleh konfigurasi Nginx yang aktif.
Build WhatsApp atau `git pull` tidak otomatis mengubah konfigurasi website aaPanel.

1. Buka **Website → keepbelanja.com → Configuration**. Salin konfigurasi lama sebagai cadangan.
2. Di dalam blok `server { ... }` website tersebut, tambahkan aturan berikut yang belum ada.
   Aturan ini juga tersedia dalam `deploy/nginx-rewrite.conf`; jangan menggandakan
   `location` yang sama jika konfigurasi itu sudah dipasang/include.
3. Jangan hapus konfigurasi PHP, SSL, `.well-known/acme-challenge`, atau proteksi file rahasia.
4. Simpan setelah validasi konfigurasi berhasil, lalu reload Nginx lewat aaPanel bila diperlukan.

```nginx
location = /fit/.well-known/oauth-protected-resource {
    rewrite ^ /fit/index.php/.well-known/oauth-protected-resource last;
}
location = /fit/.well-known/oauth-protected-resource/mcp {
    rewrite ^ /fit/index.php/.well-known/oauth-protected-resource/mcp last;
}
location = /fit/.well-known/oauth-authorization-server {
    rewrite ^ /fit/index.php/.well-known/oauth-authorization-server last;
}
location = /fit/.well-known/openid-configuration {
    rewrite ^ /fit/index.php/.well-known/openid-configuration last;
}
location = /.well-known/oauth-protected-resource/fit/mcp {
    return 302 /fit/.well-known/oauth-protected-resource/mcp;
}
location = /.well-known/oauth-authorization-server/fit {
    return 302 /fit/.well-known/oauth-authorization-server;
}
location = /.well-known/openid-configuration/fit {
    return 302 /fit/.well-known/openid-configuration;
}
```

Gunakan aturan spesifik ini, bukan membuka akses semua dotfile.
Tidak perlu build Node atau restart WORKER untuk perubahan routing Fit ini.

## Verifikasi

- Buka `https://keepbelanja.com/fit/.well-known/oauth-authorization-server`:
  harus JSON 200, issuer `https://keepbelanja.com/fit`, authorization endpoint
  `https://keepbelanja.com/fit/oauth/authorize`.
- Buka `https://keepbelanja.com/fit/.well-known/oauth-protected-resource`:
  harus JSON 200, resource `https://keepbelanja.com/fit/mcp`.
- `/fit/mcp` tanpa bearer token **harus tetap 401**, bukan akses anonim.
- Mulai ulang koneksi Fit dari pengaturan MCP klien/WhatsApp. Klien membuat
  permintaan authorize lengkap; jika belum login, masuk melalui Account,
  kemudian halaman **Izinkan akses?** muncul. Setujui hanya klien yang dikenali.
- Jangan membuka `/fit/oauth/authorize` sendirian untuk login: endpoint ini
  memerlukan permintaan OAuth yang valid dari klien (client, redirect URI, PKCE, dll.).

Jika discovery tetap 404, periksa bahwa perubahan diterapkan pada virtual host
HTTPS `keepbelanja.com` yang aktif. Jangan mematikan CSP/CORS atau proteksi login.
