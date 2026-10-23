#!/usr/bin/env python3
"""
拍照指导 —— 通过 SSH 从本地完成服务器部署。

给「不想自己在服务器上敲命令」的场景用：本地一条命令，远程装好 nginx、
放好网页、签好证书。

用法（PowerShell）：
    $env:SSH_HOST="1.2.3.4"; $env:SSH_PASSWORD="xxxx"; python remote-deploy.py

用法（bash）：
    SSH_HOST=1.2.3.4 SSH_PASSWORD=xxxx python remote-deploy.py

环境变量：
    SSH_HOST      必填，服务器 IP 或域名
    SSH_PORT      默认 22
    SSH_USER      默认 root
    SSH_PASSWORD  密码登录
    SSH_KEY       私钥路径（与密码二选一）
    DOMAIN        默认 photo.galois1130.site
    STEP          probe = 只诊断不改动（默认）；deploy = 真正执行

安全：密码只从环境变量读，不落盘、不写进任何文件、不打印。
"""

import os
import sys
import tarfile
import time
from pathlib import Path

import paramiko

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
DIST = PROJECT / "dist"

HOST = os.environ.get("SSH_HOST", "").strip()
PORT = int(os.environ.get("SSH_PORT", "22"))
USER = os.environ.get("SSH_USER", "root").strip()
PASSWORD = os.environ.get("SSH_PASSWORD", "")
KEY_PATH = os.environ.get("SSH_KEY", "").strip()
DOMAIN = os.environ.get("DOMAIN", "photo.galois1130.site").strip()
STEP = os.environ.get("STEP", "probe").strip()
# 透传给 setup-server.sh：DNS 还没生效时用 FORCE=1，只想先架起 HTTP 时用 SKIP_CERT=1
FORCE = os.environ.get("FORCE", "").strip()
SKIP_CERT = os.environ.get("SKIP_CERT", "").strip()

REMOTE_DIR = "/root/photo-coach-deploy"
REMOTE_BUNDLE = "/root/dist.tar.gz"

C = {
    "ok": "\033[32m", "info": "\033[36m", "warn": "\033[33m",
    "err": "\033[31m", "bold": "\033[1m", "end": "\033[0m",
}


def say(kind, text):
    print(f"{C[kind]}{text}{C['end']}", flush=True)


def section(text):
    print(f"\n{C['bold']}==> {text}{C['end']}", flush=True)


def connect():
    if not HOST:
        say("err", "缺少 SSH_HOST")
        sys.exit(2)

    client = paramiko.SSHClient()
    # 第一次连一台新机器没有 known_hosts 记录，自动接受；
    # 这是部署脚本，不是长期运维工具，取舍写在 README 里。
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kwargs = dict(hostname=HOST, port=PORT, username=USER, timeout=20,
                  banner_timeout=20, auth_timeout=20)
    if KEY_PATH:
        kwargs["key_filename"] = KEY_PATH
        kwargs["look_for_keys"] = False
        kwargs["allow_agent"] = False
    elif PASSWORD:
        kwargs["password"] = PASSWORD
        kwargs["look_for_keys"] = False
        kwargs["allow_agent"] = False
    else:
        # 没给密码也没给密钥，走本机 ~/.ssh 里的默认密钥
        pass

    try:
        client.connect(**kwargs)
    except paramiko.AuthenticationException:
        say("err", "认证失败：用户名或密码/密钥不对")
        sys.exit(3)
    except Exception as exc:  # noqa: BLE001
        say("err", f"连不上 {USER}@{HOST}:{PORT} —— {type(exc).__name__}: {exc}")
        say("warn", "常见原因：安全组没放行 22 端口、IP 写错、服务器没开机")
        sys.exit(4)
    return client


def run(client, cmd, quiet=False):
    """执行命令并流式打印输出，返回 (退出码, 完整输出)。"""
    chan = client.get_transport().open_session()
    chan.settimeout(None)
    chan.exec_command(cmd)
    chunks = []
    while True:
        data = chan.recv(4096)
        if not data:
            break
        text = data.decode("utf-8", "replace")
        chunks.append(text)
        if not quiet:
            sys.stdout.write(text)
            sys.stdout.flush()
    status = chan.recv_exit_status()
    return status, "".join(chunks)


def probe(client):
    section("服务器诊断")

    checks = [
        ("系统", "cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|VERSION)=' || uname -a"),
        ("内核 / 架构", "uname -r; uname -m"),
        ("当前用户", "id -un; echo '---'; whoami"),
        ("内存", "free -h 2>/dev/null | head -2 || true"),
        ("磁盘 /var", "df -h /var 2>/dev/null | tail -1 || df -h / | tail -1"),
        ("公网 IP", "curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || echo '(取不到)'"),
        ("nginx", "nginx -v 2>&1 || echo '(未安装)'"),
        ("80 端口", "ss -lntp 2>/dev/null | grep ':80 ' || echo '(空闲)'"),
        ("443 端口", "ss -lntp 2>/dev/null | grep ':443 ' || echo '(空闲)'"),
        ("已监听端口", "ss -lntp 2>/dev/null | awk 'NR>1{print $4}' | sort -u | head -15"),
        ("SELinux", "getenforce 2>/dev/null || echo '(未启用)'"),
        ("防火墙", "systemctl is-active firewalld 2>/dev/null; systemctl is-active ufw 2>/dev/null; true"),
        ("DNS 解析", f"getent ahostsv4 {DOMAIN} 2>/dev/null | awk '{{print $1}}' | sort -u || echo '(解析不到)'"),
        ("现有站点", "ls /etc/nginx/conf.d/ 2>/dev/null; ls /etc/nginx/sites-enabled/ 2>/dev/null; true"),
        ("已有证书", f"ls -la /etc/nginx/ssl/{DOMAIN}/ 2>/dev/null || echo '(无)'"),
        ("能否访问 GitHub", "curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 https://github.com 2>/dev/null || echo '失败'"),
    ]

    results = {}
    for name, cmd in checks:
        print(f"{C['info']}· {name}{C['end']}")
        _, out = run(client, cmd, quiet=True)
        out = out.strip()
        results[name] = out
        for line in out.splitlines()[:6]:
            print(f"    {line}")

    section("诊断结论")
    os_name = results.get("系统", "")
    if "PRETTY_NAME" in os_name or "Linux" in os_name:
        say("ok", "系统是 Linux，脚本可用")
    nginx_v = results.get("nginx", "")
    say("info", f"nginx：{nginx_v or '未安装（脚本会自动装）'}")
    pub = results.get("公网 IP", "")
    dns = results.get("DNS 解析", "")
    if pub and dns and pub in dns:
        say("ok", f"DNS 已生效：{DOMAIN} → {pub}")
    elif "(解析不到)" in dns:
        say("warn", f"{DOMAIN} 还没有解析记录，证书签不下来（需先加 A 记录）")
    elif dns:
        say("warn", f"{DOMAIN} 解析到 {dns}，但本机是 {pub}，两者不一致")
    port80 = results.get("80 端口", "")
    if "(空闲)" not in port80:
        say("warn", f"80 端口已被占用，需要先腾出来：{port80}")
    gh = results.get("能否访问 GitHub", "")
    if gh.strip() in ("200", "301", "302"):
        say("ok", "服务器能访问 GitHub，可直接拉网页包")
    else:
        say("warn", "服务器访问 GitHub 有问题，部署时我会改用本地上传")
    return results


def build_bundle():
    """把 dist/ 打成 tar.gz，返回路径。"""
    if not (DIST / "index.html").exists():
        say("err", f"找不到 {DIST / 'index.html'}，先在本地执行 npm run build")
        sys.exit(5)
    out = Path(os.environ.get("TEMP", "/tmp")) / "photo-coach-dist.tar.gz"
    with tarfile.open(out, "w:gz") as tar:
        for item in sorted(DIST.rglob("*")):
            arc = item.relative_to(DIST)
            tar.add(item, arcname=str(arc))
    say("ok", f"本地打包完成：{out.name} {out.stat().st_size / 1024 / 1024:.1f}MB")
    return out


def upload(client, local, remote):
    sftp = client.open_sftp()
    size = Path(local).stat().st_size
    start = time.time()

    def progress(done, total):
        pct = done * 100 // max(total, 1)
        bar = "#" * (pct // 4) + "-" * (25 - pct // 4)
        sys.stdout.write(f"\r    [{bar}] {pct:3d}%  {done/1024/1024:.1f}/{total/1024/1024:.1f}MB")
        sys.stdout.flush()

    sftp.put(str(local), remote, callback=progress)
    sftp.close()
    sys.stdout.write("\n")
    say("ok", f"已上传 {Path(local).name} → {remote}（{size/1024/1024:.1f}MB，{time.time()-start:.1f}s）")


def deploy(client, probe_result):
    section("上传部署文件")

    run(client, f"mkdir -p {REMOTE_DIR}")

    for name in ("setup-server.sh", "nginx-http.conf.tpl", "nginx-ssl.conf.tpl"):
        upload(client, HERE / name, f"{REMOTE_DIR}/{name}")

    # 服务器连不上 GitHub 时，用本地打的包。
    # 另一个更常见的场景：GitHub 能连但慢得离谱（实测某台机器只有 23KB/s，
    # 9.8MB 要下 7 分钟）。所以支持 USE_LOCAL=1 强制走本地上传。
    gh = (probe_result.get("能否访问 GitHub") or "").strip()
    use_local = os.environ.get("USE_LOCAL", "").strip() == "1"
    if not use_local:
        use_local = gh not in ("200", "301", "302")
    bundle_arg = ""
    if use_local:
        say("info", "使用本地上传的网页包（不走 GitHub）")
        bundle = build_bundle()
        upload(client, bundle, REMOTE_BUNDLE)
        bundle_arg = f"LOCAL_BUNDLE={REMOTE_BUNDLE}"

    section("执行部署（装 nginx / 部署网页 / 签证书，约 1~3 分钟）")
    extra = ""
    if FORCE:
        extra += f" FORCE={FORCE}"
    if SKIP_CERT:
        extra += f" SKIP_CERT={SKIP_CERT}"
    cmd = (
        f"cd {REMOTE_DIR} && chmod +x setup-server.sh && "
        f"DOMAIN={DOMAIN}{extra} {bundle_arg} bash setup-server.sh 2>&1"
    )
    say("info", f"命令：{cmd}")
    status, _ = run(client, cmd)
    return status


def verify(client):
    section("外网验证")
    # 从服务器自己访问自己的域名，验证的是「配置对不对」
    # 真正的公网可达性还要靠手机/浏览器，安全组的问题本机看不出来
    for scheme in ("http", "https"):
        code = run(
            client,
            f"curl -sk -o /dev/null -w '%{{http_code}}' --max-time 10 "
            f"-H 'Host: {DOMAIN}' {scheme}://127.0.0.1/ || echo 000",
            quiet=True,
        )[1].strip()
        mark = "ok" if code in ("200", "301", "302") else "warn"
        say(mark, f"本机 {scheme.upper():5s} → HTTP {code}")

    cert = run(
        client,
        f"openssl x509 -noout -subject -enddate -in /etc/nginx/ssl/{DOMAIN}/fullchain.pem 2>/dev/null || echo '(无证书)'",
        quiet=True,
    )[1].strip()
    for line in cert.splitlines():
        print(f"    {line}")


def main():
    say("bold", f"目标：{USER}@{HOST}:{PORT}  域名：{DOMAIN}  模式：{STEP}")
    client = connect()
    say("ok", "SSH 连接成功")

    try:
        # 临时跑一条命令用：STEP=shell CMD="ls -la /var/www"
        if STEP == "shell":
            cmd = os.environ.get("CMD", "").strip()
            if not cmd:
                say("err", "STEP=shell 需要同时提供 CMD=...")
                return 2
            status, _ = run(client, cmd)
            return status

        info = probe(client)
        if STEP == "probe":
            print()
            say("info", "这只是诊断，没有改动服务器任何东西。")
            say("info", "确认无误后把 STEP 设成 deploy 再跑一次。")
            return 0

        status = deploy(client, info)
        if status != 0:
            say("err", f"部署脚本退出码 {status}，上面是详细输出")
            return status

        verify(client)
        print()
        say("ok", f"完成：https://{DOMAIN}/")
        say("warn", "如果手机打不开，先查华为云安全组有没有放行 80/443")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
