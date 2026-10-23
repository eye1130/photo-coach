# ============================================================================
# 拍照指导 —— 第一阶段配置（只有 HTTP）
#
# 只在「还没拿到证书」时使用。acme.sh 的 HTTP-01 验证必须能访问 80 端口，
# 所以这一步不能直接跳过去写 HTTPS —— 没有证书的 ssl_certificate 指令会让
# nginx 直接起不来，然后就再也签不了证书，死锁。
#
# 占位符 __DOMAIN__ 由 setup-server.sh 替换。
# ============================================================================

server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    root /var/www/photo-coach;
    index index.html;

    # ACME 验证目录：必须留在 80 上，且不能被 301 到 https
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
