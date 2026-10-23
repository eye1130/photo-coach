#!/usr/bin/env bash
# =============================================================================
# 拍照指导 —— 更新网页（服务器上执行）
#
# 从 GitHub Release 拉最新网页包，原子替换 /var/www/photo-coach。
# 不重装、不碰证书，纯换文件，通常 3~5 秒。
#
# 用法：
#   bash update.sh
#
# 换完手机上刷新一次页面就生效。Service Worker 会弹「有新版本，点这里刷新」，
# 点一下才是新版本（这是故意的，见 AGENTS.md §9.2）。
# =============================================================================
set -euo pipefail

WEBROOT="/var/www/photo-coach"
REPO="eye1130/photo-coach"
BUNDLE_URL="https://github.com/${REPO}/releases/download/web-latest/dist.tar.gz"
# 实测：GitHub 原生 23KB/s，gh-proxy.com 561KB/s。镜像优先，原生兜底。
MIRRORS=("https://gh-proxy.com/" "https://ghfast.top/" "")

c_ok()   { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }
c_info() { printf '\033[36m·\033[0m %s\n' "$*" >&2; }
c_die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || c_die "请用 root 运行"

# 记下旧版本，方便对比和回滚
OLD_SW="$(grep -oE "VERSION *= *['\"][^'\"]+" "$WEBROOT/sw.js" 2>/dev/null | head -1 | grep -oE "[0-9][0-9.]*$" || echo "?")"
c_info "当前版本：${OLD_SW}"

TMP="/tmp/photo-coach-dist.tar.gz"
GOT=0
for prefix in "${MIRRORS[@]}"; do
  c_info "下载 ${prefix}${BUNDLE_URL}"
  if curl -fL --retry 2 --connect-timeout 10 --max-time 300 -o "$TMP" "${prefix}${BUNDLE_URL}" 2>/dev/null \
     && tar -tzf "$TMP" >/dev/null 2>&1; then
    GOT=1
    break
  fi
done
[ "$GOT" = "1" ] || c_die "下载失败。GitHub 可能不通，稍后重试，或用加速镜像前缀。"

rm -rf "${WEBROOT}.new"
mkdir -p "${WEBROOT}.new"
tar -xzf "$TMP" -C "${WEBROOT}.new"
[ -f "${WEBROOT}.new/index.html" ] || c_die "包损坏：没有 index.html"

chown -R root:root "${WEBROOT}.new"
chmod -R a+rX "${WEBROOT}.new"
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  chcon -R -t httpd_sys_content_t "${WEBROOT}.new" 2>/dev/null || true
fi

# 原子替换：新目录就位后才删旧的，用户不会撞上半套文件
rm -rf "${WEBROOT}.old"
mv "$WEBROOT" "${WEBROOT}.old"
mv "${WEBROOT}.new" "$WEBROOT"
rm -rf "${WEBROOT}.old"
rm -f "$TMP"

NEW_SW="$(grep -oE "VERSION *= *['\"][^'\"]+" "$WEBROOT/sw.js" 2>/dev/null | head -1 | grep -oE "[0-9][0-9.]*$" || echo "?")"
c_ok "已更新：${OLD_SW} → ${NEW_SW}（$(du -sh "$WEBROOT" | cut -f1)）"
c_info "手机上刷新页面即可；Service Worker 会提示点一下刷新才算真的换版。"
