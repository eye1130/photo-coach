#!/usr/bin/env bash
# =============================================================================
# 拍照指导 —— 服务器一键部署（华为云 ECS / 任意 Linux）
#
# 干四件事：
#   1. 装 nginx 和依赖
#   2. 从 GitHub Release 拉最新网页包，解到 /var/www/photo-coach
#   3. 写 nginx 站点配置（HTTP → 签证书 → HTTPS）
#   4. 配 acme.sh 自动续期
#
# 用法（服务器上以 root 执行）：
#   DOMAIN=photo.galois1130.site bash setup-server.sh
#
# 可选环境变量：
#   DOMAIN   必填，要绑定的域名
#   EMAIL    Let's Encrypt 通知邮箱，可空
#   SKIP_CERT=1  只部署文件、不签证书（证书已有或想手动签时用）
#   FORCE=1      跳过 DNS 解析检查（确认解析还没生效但想先把服务架起来）
#
# 幂等：可以反复跑。已装的包会跳过，已有证书不会重签。
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-photo.galois1130.site}"
EMAIL="${EMAIL:-}"
SKIP_CERT="${SKIP_CERT:-0}"
FORCE="${FORCE:-0}"

WEBROOT="/var/www/photo-coach"
ACME_ROOT="/var/www/acme"
SSL_DIR="/etc/nginx/ssl/${DOMAIN}"
NGINX_CONF="/etc/nginx/conf.d/photo-coach.conf"
REPO="eye1130/photo-coach"
BUNDLE_URL="https://github.com/${REPO}/releases/download/web-latest/dist.tar.gz"
# 国内直连 GitHub 偶尔抽风，失败时依次尝试加速镜像
BUNDLE_MIRRORS=(
  ""
  "https://ghfast.top/"
  "https://gh-proxy.com/"
)

# 脚本所在目录（用于读同目录下的 nginx 模板）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- 输出
c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m·\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
c_step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 0. 前置检查
c_step "前置检查"

[ "$(id -u)" -eq 0 ] || c_die "请用 root 运行（或 sudo bash setup-server.sh）"
[ -n "$DOMAIN" ] || c_die "必须指定 DOMAIN，例如 DOMAIN=photo.galois1130.site"

# 服务器自己看到的公网 IP，用来和域名解析比对
detect_public_ip() {
  local ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip; do
    ip="$(curl -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]')" || true
    if printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

PUBLIC_IP="$(detect_public_ip || true)"
if [ -n "$PUBLIC_IP" ]; then
  c_ok "服务器公网 IP：${PUBLIC_IP}"
else
  c_warn "没能自动识别公网 IP（不影响部署，但下面的 DNS 检查会跳过）"
fi

# DNS 没生效就签证书，Let's Encrypt 会返回明确的失败，不如提前说清楚
RESOLVED_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -z "$RESOLVED_IP" ]; then
  if [ "$FORCE" = "1" ]; then
    c_warn "域名 $DOMAIN 解析不到，但 FORCE=1，继续"
  else
    c_die "域名 $DOMAIN 还没有解析记录。
      请先去腾讯云 DNSPod 加一条 A 记录：photo → ${PUBLIC_IP:-你的服务器公网IP}
      解析生效（通常 1~10 分钟）后重跑本脚本。
      如果只想先把服务架起来、证书以后再说：加 FORCE=1 重跑。"
  fi
elif [ -n "$PUBLIC_IP" ] && [ "$RESOLVED_IP" != "$PUBLIC_IP" ]; then
  if [ "$FORCE" = "1" ]; then
    c_warn "$DOMAIN 解析到 ${RESOLVED_IP}，不是本机 ${PUBLIC_IP}，但 FORCE=1，继续"
  else
    c_die "$DOMAIN 当前解析到 ${RESOLVED_IP}，但本机公网 IP 是 ${PUBLIC_IP}。
      证书签不下来（验证请求会打到别的机器）。请先改 DNS，或确认服务器 IP 有没有看错。"
  fi
else
  c_ok "域名 $DOMAIN → ${RESOLVED_IP}，与本机一致"
fi

# ---------------------------------------------------------------- 1. 装依赖
c_step "安装 nginx 与依赖"

PKG=""
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
elif command -v yum >/dev/null 2>&1; then
  PKG=yum
elif command -v zypper >/dev/null 2>&1; then
  PKG=zypper
else
  c_die "认不出包管理器（既没有 apt 也没有 dnf/yum/zypper），请手动装 nginx 后重跑"
fi
c_info "包管理器：${PKG}"

install_pkgs() {
  case "$PKG" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq nginx curl tar openssl ca-certificates cron
      ;;
    dnf)    dnf install -y -q nginx curl tar openssl ca-certificates cronie ;;
    yum)    yum install -y -q nginx curl tar openssl ca-certificates cronie ;;
    zypper) zypper --non-interactive install nginx curl tar openssl ca-certificates cron ;;
  esac
}
install_pkgs
c_ok "依赖就绪"

# cron 不一定是自启的，acme.sh 续期要靠它
systemctl enable --now crond >/dev/null 2>&1 || systemctl enable --now cron >/dev/null 2>&1 || true

NGINX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
c_ok "nginx ${NGINX_VER}"

# ---------------------------------------------------------------- 2. MIME 类型
c_step "校正 MIME 类型"

# wasm 拿不到 application/wasm 时，MediaPipe 会走 WebAssembly.instantiate 的降级路径，
# 慢一倍以上。manifest 同理，类型不对浏览器会忽略 PWA 配置。
MIME_FILE="/etc/nginx/mime.types"
[ -f "$MIME_FILE" ] || c_die "找不到 $MIME_FILE，nginx 安装似乎不完整"

if ! grep -q 'application/wasm' "$MIME_FILE"; then
  # 插到 types { 之后，保持文件结构合法
  sed -i 's|^types {|types {\n    application/wasm                wasm;|' "$MIME_FILE"
  c_ok "已补 application/wasm"
else
  c_ok "application/wasm 已存在"
fi

if ! grep -q 'webmanifest' "$MIME_FILE"; then
  sed -i 's|^types {|types {\n    application/manifest+json     webmanifest;|' "$MIME_FILE"
  c_ok "已补 application/manifest+json"
else
  c_ok "webmanifest 已存在"
fi

# ---------------------------------------------------------------- 3. 部署网页
c_step "部署网页文件"

mkdir -p "$WEBROOT" "$ACME_ROOT"

fetch_bundle() {
  local prefix="$1" tmp="/tmp/photo-coach-dist.tar.gz"
  c_info "下载 ${prefix}${BUNDLE_URL}"
  if curl -fL --retry 2 --retry-delay 2 --connect-timeout 10 --max-time 300 \
       -o "$tmp" "${prefix}${BUNDLE_URL}" 2>/dev/null; then
    # 校验是不是真的 gzip：GitHub 出错时会返回 HTML 页面
    if tar -tzf "$tmp" >/dev/null 2>&1; then
      printf '%s' "$tmp"
      return 0
    fi
    c_warn "下载到的不是有效的 tar.gz，换下一个源"
  fi
  return 1
}

BUNDLE=""
for mirror in "${BUNDLE_MIRRORS[@]}"; do
  if BUNDLE="$(fetch_bundle "$mirror")"; then break; fi
  BUNDLE=""
done

if [ -z "$BUNDLE" ]; then
  if [ -f "$WEBROOT/index.html" ]; then
    c_warn "所有源都下载失败，保留现有网页文件继续"
  else
    c_die "网页包下载失败，且服务器上还没有任何文件。
      可以先在本地执行 npm run build，再 scp -r dist/* root@本机IP:${WEBROOT}/"
  fi
else
  # 先解到临时目录再整体替换，避免用户正好在访问时拿到半套文件
  rm -rf "${WEBROOT}.new"
  mkdir -p "${WEBROOT}.new"
  tar -xzf "$BUNDLE" -C "${WEBROOT}.new"
  [ -f "${WEBROOT}.new/index.html" ] || c_die "网页包里没有 index.html，包是坏的"

  rm -rf "${WEBROOT}.old"
  if [ -d "$WEBROOT" ]; then mv "$WEBROOT" "${WEBROOT}.old"; fi
  mv "${WEBROOT}.new" "$WEBROOT"
  rm -rf "${WEBROOT}.old"
  rm -f "$BUNDLE"
  c_ok "网页已就位（$(du -sh "$WEBROOT" | cut -f1)，$(find "$WEBROOT" -type f | wc -l) 个文件）"
fi

# ---------------------------------------------------------------- 4. 权限与 SELinux
c_step "校正权限"

chown -R root:root "$WEBROOT"
chmod -R a+rX "$WEBROOT"

# SELinux 开着（华为云 EulerOS / CentOS 默认开）时，文件上下文不对会直接 403，
# 而且报错只说 Forbidden，看不出是 SELinux 干的。
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  chcon -R -t httpd_sys_content_t "$WEBROOT" 2>/dev/null || true
  c_ok "SELinux 已放行静态目录"
else
  c_ok "SELinux 未启用（或不是强制模式）"
fi

# ---------------------------------------------------------------- 5. 第一次写配置
c_step "配置 nginx"

[ -f "$SCRIPT_DIR/nginx-http.conf.tpl" ] || c_die "缺少模板文件 nginx-http.conf.tpl，请确认 deploy/ 目录完整"

# 证书在不在，决定写哪套配置
if [ -f "$SSL_DIR/fullchain.pem" ] && [ -f "$SSL_DIR/privkey.pem" ]; then
  HAVE_CERT=1
else
  HAVE_CERT=0
fi

write_http_conf() {
  sed "s|__DOMAIN__|${DOMAIN}|g" "$SCRIPT_DIR/nginx-http.conf.tpl" > "$NGINX_CONF"
}

write_ssl_conf() {
  # nginx 1.25.1 起 http2 从 listen 参数改成独立指令，写法必须跟着版本走
  local http2_line=""
  if [ "$(printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V | head -1)" = "$NGINX_VER" ]; then
    http2_line="http2 on;"
  fi
  sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__HTTP2__|${http2_line}|g" \
      "$SCRIPT_DIR/nginx-ssl.conf.tpl" > "$NGINX_CONF"
}

if [ "$HAVE_CERT" = "1" ]; then
  write_ssl_conf
  c_ok "已存在证书，直接写 HTTPS 配置"
else
  write_http_conf
  c_ok "还没有证书，先写 HTTP 配置（签证书需要 80 端口能访问）"
fi

# 配置写坏了必须当场发现，否则 nginx 起不来，后面签证书也全废
if ! nginx -t 2>&1 | tail -3; then
  c_die "nginx 配置有语法错误，上面是详情。配置文件：${NGINX_CONF}"
fi

systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
c_ok "nginx 已启动"

# ---------------------------------------------------------------- 6. 防火墙
c_step "放行端口"

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --add-service=http  >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  c_ok "firewalld 已放行 80/443"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  c_ok "ufw 已放行 80/443"
else
  c_ok "本机防火墙未启用（华为云还要单独放行安全组，见 README）"
fi

# ---------------------------------------------------------------- 7. 签证书
if [ "$HAVE_CERT" = "1" ]; then
  c_step "证书已存在，跳过签发"
elif [ "$SKIP_CERT" = "1" ]; then
  c_step "SKIP_CERT=1，跳过证书签发"
  c_warn "现在只有 HTTP。摄像头需要 HTTPS 才能用，记得稍后补签。"
else
  c_step "申请 HTTPS 证书（Let's Encrypt）"

  ACME_SH="$HOME/.acme.sh/acme.sh"
  if [ ! -x "$ACME_SH" ]; then
    c_info "安装 acme.sh"
    # get.acme.sh 走 Cloudflare，偶尔被墙；失败就换 gitee 上的同版本
    if ! curl -fsSL --connect-timeout 10 --max-time 120 https://get.acme.sh | sh -s "email=${EMAIL:-}" >/dev/null 2>&1; then
      c_warn "官方源失败，改用 gitee 镜像"
      tmp_install="$(mktemp -d)"
      git clone --depth 1 https://gitee.com/neilpang/acme.sh.git "$tmp_install/acme.sh" >/dev/null 2>&1 \
        || c_die "acme.sh 装不上，请手动安装后加 SKIP_CERT=1 重跑"
      ( cd "$tmp_install/acme.sh" && ./acme.sh --install -m "${EMAIL:-}" >/dev/null 2>&1 )
      rm -rf "$tmp_install"
    fi
    [ -x "$ACME_SH" ] || c_die "acme.sh 安装后找不到可执行文件，请检查 $HOME/.acme.sh"
  fi
  c_ok "acme.sh 就绪"

  # 用 Let's Encrypt 而不是默认的 ZeroSSL：不需要注册账号，签发更省事
  c_info "签发中（webroot 模式，约 10~30 秒）"
  if ! "$ACME_SH" --issue -d "$DOMAIN" -w "$ACME_ROOT" --server letsencrypt --keylength ec-256; then
    c_die "证书签发失败。
      常见原因：
        1. 华为云安全组没放行 80 端口（最常见）—— 去控制台 → 安全组 → 入方向 → 加 80
        2. DNS 还没生效 —— 等几分钟再试
        3. 80 端口被别的服务占了 —— ss -lntp | grep :80 看看
      网页已经部署好了，只是暂时只有 HTTP。修好上面任意一条后重跑本脚本即可。"
  fi
  c_ok "证书已签发"

  mkdir -p "$SSL_DIR"
  "$ACME_SH" --install-cert -d "$DOMAIN" --ecc \
    --key-file       "${SSL_DIR}/privkey.pem" \
    --fullchain-file "${SSL_DIR}/fullchain.pem" \
    --reloadcmd      "systemctl reload nginx" >/dev/null
  chmod 600 "${SSL_DIR}/privkey.pem"
  c_ok "证书已装到 ${SSL_DIR}"

  # 换成 HTTPS 配置
  write_ssl_conf
  nginx -t >/dev/null 2>&1 || c_die "HTTPS 配置有语法错误：nginx -t 看详情"
  systemctl reload nginx
  c_ok "已切到 HTTPS"
fi

# ---------------------------------------------------------------- 8. 收尾自检
c_step "自检"

CODE_HTTP="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1/" -H "Host: ${DOMAIN}" || true)"
c_info "本机 HTTP  → ${CODE_HTTP}"

if [ -f "$SSL_DIR/fullchain.pem" ]; then
  CODE_HTTPS="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "https://127.0.0.1/" -H "Host: ${DOMAIN}" || true)"
  c_info "本机 HTTPS → ${CODE_HTTPS}"
  EXP="$(openssl x509 -enddate -noout -in "$SSL_DIR/fullchain.pem" | cut -d= -f2)"
  c_ok "证书有效期至 ${EXP}"
fi

printf '\n'
c_ok "服务器部署完成"
printf '\n  访问地址：  https://%s/\n' "$DOMAIN"
printf '  网页目录：  %s\n' "$WEBROOT"
printf '  站点配置：  %s\n' "$NGINX_CONF"
printf '  日常更新：  bash update.sh   （在本目录执行）\n\n'
c_warn "如果浏览器打开是超时而不是报错，99%% 是华为云「安全组」没放行 80/443，"
c_warn "服务器本机防火墙是另一层，两处都要开。"
