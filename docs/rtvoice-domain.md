# rtvoice.com Deployment Notes

Use `rtvoice.com` as the public HTTPS origin and keep the internal services on localhost/private ports:

- Next.js renderer: `127.0.0.1:4000`
- FastAPI backend: `127.0.0.1:8012`
- Public site: `https://rtvoice.com`

## DNS

Create these records at the domain registrar/DNS provider:

```txt
A      @      <SERVER_PUBLIC_IP>
CNAME  www    rtvoice.com
```

Wait until both resolve before requesting certificates:

```bash
dig +short rtvoice.com
dig +short www.rtvoice.com
```

## Nginx reverse proxy

Install Nginx and Certbot, then use this server block. It serves the UI from port `4000` and proxies API/WebSocket traffic to port `8012`.

```nginx
server {
    listen 80;
    server_name rtvoice.com www.rtvoice.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:8012/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8012/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable HTTPS:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d rtvoice.com -d www.rtvoice.com
```

## App behavior

When opened over `https://rtvoice.com`, the renderer now uses the same origin for API calls:

- health check: `https://rtvoice.com/health`
- WebSocket: `wss://rtvoice.com/ws/audio`

When opened from a non-HTTPS remote host, it keeps the old direct backend behavior and uses port `8012`.
