# Lokasi proxy WhatsApp standalone. Dipakai oleh vhost bare (nginx-wa.conf) maupun
# di-include ke vhost aaPanel. Semua permintaan diteruskan ke proses WEB (127.0.0.1:__PORT__).
location ^~ /.well-known/acme-challenge/ { try_files $uri =404; }

# Kode OAuth tidak boleh masuk access log; jangan pernah proxy langsung ke port CLI 3334.
location ^~ /oauth/mcp/callback/ {
    access_log off;
    add_header Referrer-Policy no-referrer always;
    proxy_pass http://127.0.0.1:__PORT__/oauth/mcp/callback/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location ^~ / {
    proxy_pass http://127.0.0.1:__PORT__/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
