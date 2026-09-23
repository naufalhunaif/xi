# Nginx untuk WhatsApp standalone (dibuat oleh deploy/install.sh; ditulis ulang oleh `wa domain` / `wa ssl`).
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name __DOMAIN__;

    ssl_certificate     __SSL_CERT__;
    ssl_certificate_key __SSL_KEY__;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 64m;
    access_log /var/log/nginx/wa.access.log;
    error_log  /var/log/nginx/wa.error.log;

    include __APP_DIR__/deploy/nginx-wa-locations.conf;
}
