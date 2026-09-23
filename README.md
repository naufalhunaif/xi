# xi — WhatsApp AI CS (standalone)

Aplikasi WhatsApp balas otomatis berbasis AI (AdonisJS + Baileys), berjalan sendiri di server Anda:
login lokal, langsung bisa dibuka lewat `http://IP:PORT` (seperti aaPanel), domain dipasang belakangan,
dikendalikan lewat perintah `wa`.

## Pasang (Ubuntu 22.04/24.04, Debian 12, atau aaPanel)

```bash
curl -fsSL https://raw.githubusercontent.com/naufalhunaif/xi/main/deploy/install.sh | sudo bash
```

Tidak ada yang ditanya. Setelah selesai buka `http://IP-SERVER:PORT/setup` (alamat dicetak di akhir)
untuk membuat akun pemilik. Pasang domain kapan saja: `wa domain wa.domainku.com`.

- Panduan lengkap: [`whatsapp/docs/install.md`](whatsapp/docs/install.md)
- Perintah server: `wa` (menu), `wa update`, `wa status`, `wa backup`, `wa user`, …
- Rilis: tag `v3.x.y` di repo ini; server cukup `wa update`.
