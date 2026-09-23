# xi — WhatsApp AI CS (standalone)

Aplikasi WhatsApp balas otomatis berbasis AI (AdonisJS + Baileys), berjalan sendiri di server Anda:
login lokal, dipasang di akar domain, dikendalikan lewat perintah `wa`.

## Pasang (Ubuntu 22.04/24.04, Debian 12, atau aaPanel)

```bash
curl -fsSL https://raw.githubusercontent.com/naufalhunaif/xi/main/deploy/install.sh | sudo bash
```

Domain dan email ditanya saat berjalan. Di aaPanel, buat dulu website untuk domain tersebut (dengan SSL).
Lalu buka `https://wa.domainku.com/setup` untuk membuat akun pemilik.

- Panduan lengkap: [`whatsapp/docs/install.md`](whatsapp/docs/install.md)
- Perintah server: `wa` (menu), `wa update`, `wa status`, `wa backup`, `wa user`, …
- Rilis: tag `v3.x.y` di repo ini; server cukup `wa update`.
