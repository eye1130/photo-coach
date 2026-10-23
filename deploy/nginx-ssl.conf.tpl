# ============================================================================
# 拍照指导 —— 正式站点配置（HTTPS + 缓存策略）
#
# 占位符：
#   __DOMAIN__  → 实际域名
#   __HTTP2__   → nginx >= 1.25.1 时为 "http2 on;"，否则为空（写在 listen 里）
#
# 缓存策略不是抄模板，每一条都对应一个踩过的坑，原因写在各段注释里。
# ============================================================================

# ---------------------------------------------------------------- 80：只做跳转和 ACME
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# ---------------------------------------------------------------- 443：正式服务
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    __HTTP2__
    server_name __DOMAIN__;

    ssl_certificate     /etc/nginx/ssl/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/__DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:PhotoCoachSSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    root /var/www/photo-coach;
    index index.html;
    charset utf-8;
    server_tokens off;

    # ------------------------------------------------------------ 压缩
    # MediaPipe 的 wasm 有 18MB，gzip 后约 4MB。这条不是优化，是「能不能用」的分界线：
    # 不压的话手机 4G 上打开要几十秒，用户早关了。
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        application/javascript
        application/json
        application/manifest+json
        application/wasm
        image/svg+xml;

    # ------------------------------------------------------------ 安全头
    # 注意 nginx 的坑：location 里只要出现任何 add_header，server 级的所有
    # add_header 全部失效。所以下面每个带 add_header 的 location 都重复了一遍。
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header X-Frame-Options SAMEORIGIN always;

    # ------------------------------------------------------------ 绝不缓存
    # sw.js：一旦被缓存住，用户永远拿不到新版本，改完网页等于没改。
    # index.html：里面引用的 JS 文件名带 hash，缓存 HTML 等于把用户钉死在旧版。
    location = /sw.js {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    location = /index.html {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    location = /manifest.webmanifest {
        default_type application/manifest+json;
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    # ------------------------------------------------------------ 长缓存：构建产物
    # /assets/ 下的文件名自带内容 hash，内容变了文件名就变，所以可以永久缓存。
    location ^~ /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    # ------------------------------------------------------------ 中缓存：模型 / 剪影 / 图标
    # 这些文件名不带 hash，所以不敢给 immutable。7 天足够减少重复下载，
    # 又不至于让资源更新永远追不上。真要强制刷新，改 sw.js 的 VERSION。
    location ^~ /mp/ {
        add_header Cache-Control "public, max-age=604800" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    location ^~ /sil/ {
        add_header Cache-Control "public, max-age=604800" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    location ^~ /icons/ {
        add_header Cache-Control "public, max-age=604800" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri =404;
    }

    # ------------------------------------------------------------ 兜底
    # 单页应用：任何不存在的路径都回 index.html。
    # 同时兜底的 HTML 也不缓存，避免用户拿到旧入口。
    location / {
        add_header Cache-Control "no-cache, must-revalidate" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header X-Frame-Options SAMEORIGIN always;
        try_files $uri $uri/ /index.html;
    }
}
