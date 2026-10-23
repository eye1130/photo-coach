# 部署到自有服务器（华为云 + galois1130.site）

这套方案替换掉之前那个「每次部署都换域名」的临时托管。

**核心变化**：域名固定成 `photo.galois1130.site`，网页更新只需要在服务器上跑一条命令，
APK 里的地址永远不用改，用户也不用重装。

---

## 一、整体结构

```
你手机 / 浏览器
      │  https://photo.galois1130.site
      ▼
华为云 ECS（nginx）
      │  静态文件：/var/www/photo-coach
      │
      └─ 更新时从 GitHub Release 拉 dist.tar.gz
         https://github.com/eye1130/photo-coach/releases/download/web-latest/dist.tar.gz
         （这个地址固定不变，由 .github/workflows/web.yml 每次 push 自动更新）
```

为什么不让服务器自己 `git clone` + 构建？因为要在服务器装 Node，华为云的
EulerOS 装 Node 经常踩版本坑。让 GitHub Actions 构建好、服务器只负责解压，
少一层依赖，也少一类故障。

---

## 二、你需要做的三件事

### 第 1 件：加一条 DNS 记录

去腾讯云 DNSPod（`console.dnspod.cn`）→ 找到 `galois1130.site` → **解析** → **添加记录**：

| 字段 | 填什么 |
| --- | --- |
| 主机记录 | `photo` |
| 记录类型 | `A` |
| 记录值 | 你华为云服务器的**公网 IP** |
| 线路 | 默认 |
| TTL | 600 |

用 `photo` 子域名而不是直接顶掉 `galois1130.site`，是因为你之前那两个服务还挂在
主域名/`www` 上，动主域名会把它们带崩。子域名完全独立，互不影响。

华为云的公网 IP 在：控制台 → 弹性云服务器 ECS → 实例列表 → 「弹性公网IP」那一列。

### 第 2 件：华为云安全组放行 80 和 443

控制台 → 弹性云服务器 ECS → 点进那台机器 → **安全组** → 配置规则 → **入方向** → 添加规则：

| 优先级 | 协议端口 | 源地址 | 说明 |
| --- | --- | --- | --- |
| 1 | `TCP 80` | `0.0.0.0/0` | HTTP，签证书要用 |
| 1 | `TCP 443` | `0.0.0.0/0` | HTTPS，正式访问 |

> 华为云的安全组和服务器本机的防火墙（firewalld/ufw）是**两层**，脚本会处理本机那层，
> 安全组只能你在控制台点。这一步漏了，浏览器就是一直转圈直到超时。

### 第 3 件：把部署脚本跑一遍

服务器是 Linux 的话，用华为云控制台的**远程登录**（ECS → 实例 → 远程登录 →
CloudShell 登录），不用装任何 SSH 工具，直接在浏览器里就有终端：

```bash
curl -fsSL https://raw.githubusercontent.com/eye1130/photo-coach/main/deploy/setup-server.sh -o /tmp/setup.sh \
  && DOMAIN=photo.galois1130.site bash /tmp/setup.sh
```

`raw.githubusercontent.com` 国内有时打不开。打不开就换 jsDelivr 镜像（内容一样）：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/eye1130/photo-coach@main/deploy/setup-server.sh -o /tmp/setup.sh \
  && DOMAIN=photo.galois1130.site bash /tmp/setup.sh
```

脚本会自动做完：装 nginx → 拉网页包 → 写配置 → 申请 Let's Encrypt 证书 → 配自动续期。
跑完最后会打印访问地址和自检结果。

**如果 GitHub 拉不动**，把仓库 `deploy/` 目录整个传到服务器再执行：

```bash
# 本地执行（把 IP 换成你的）
scp -r deploy root@你的IP:/root/
# 服务器上执行
cd /root/deploy && DOMAIN=photo.galois1130.site bash setup-server.sh
```

---

## 三、日常更新网页

改完代码 push 到 GitHub 后，等 Actions 跑完（约 1 分钟），在服务器上：

```bash
cd /root/deploy && bash update.sh
```

或者在 CloudShell 里一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/eye1130/photo-coach/main/deploy/update.sh -o /tmp/u.sh && bash /tmp/u.sh
```

手机上刷新页面 → Service Worker 会弹「有新版本，点这里刷新」→ 点一下才是新版。
这是故意不自动刷新的，原因见 `AGENTS.md` §9.2（自动刷新会造成页面还是旧 JS、
缓存已是新资源的错位，表现为白屏）。

**APK 完全不用动。** 这是这次改动的最大收益。

---

## 四、文件说明

| 文件 | 干什么 |
| --- | --- |
| `setup-server.sh` | 首次部署：装环境 + 部署 + 签证书。可重复跑 |
| `update.sh` | 只换网页文件，3~5 秒，不碰证书 |
| `remote-deploy.py` | 从**本地**通过 SSH 完成上面两件事，不用登服务器敲命令 |
| `nginx-http.conf.tpl` | 还没证书时的临时配置（签证书必须走 80） |
| `nginx-ssl.conf.tpl` | 正式配置，含缓存策略和 gzip |
| `../.github/workflows/web.yml` | 构建 dist 并发布到 `web-latest` Release |

### 用 remote-deploy.py 远程部署

适合不想在服务器上敲命令的情况。先跑 `probe` 模式只诊断、不改动：

```powershell
# PowerShell
$env:SSH_HOST="你的服务器IP"; $env:SSH_PASSWORD="密码"; python deploy/remote-deploy.py
```

```bash
# bash
SSH_HOST=你的服务器IP SSH_PASSWORD=密码 python deploy/remote-deploy.py
```

诊断会检查系统版本、内存磁盘、nginx 是否已装、80/443 是否被占、SELinux、
防火墙、DNS 是否解析到本机、能不能访问 GitHub。**这一步不会改服务器任何东西。**

确认没问题后加 `STEP=deploy` 真正执行：

```powershell
$env:STEP="deploy"; python deploy/remote-deploy.py
```

脚本会做的事：上传部署文件 → 服务器连不上 GitHub 就用本地上传的网页包 →
执行 `setup-server.sh` → 从服务器内部验证 HTTP/HTTPS 和证书有效期。

> 密码只从环境变量读，不落盘、不写进任何文件、不打印。
> 如果用了密码登录，部署完建议改一次密码。

---

## 五、排错

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 浏览器一直转圈到超时 | 华为云安全组没放行 | 回第 2 件 |
| 连接被重置 / 显示备案提示 | 域名没备案或接入商不一致 | 见下面「关于备案」 |
| `502` / `403 Forbidden` | SELinux 上下文不对 | 重跑 `setup-server.sh`，它会自动 `chcon` |
| 证书签不下来 | 80 端口不通 / DNS 没生效 | `ss -lntp \| grep :80` 看端口；`getent hosts photo.galois1130.site` 看解析 |
| 打开是旧版本 | Service Worker 缓存 | 页面上点「刷新」提示；或浏览器里清站点数据 |
| 摄像头打不开 | 不是 HTTPS | 地址栏必须是 `https://`，`http://` 下 `getUserMedia` 直接被禁 |
| 改了网页服务器上没变 | Actions 没跑完 | 去 Actions 页面看 `Publish Web Bundle` 是否绿了 |

### 关于备案

你的域名之前挂在腾讯云服务器上，如果那两个服务能正常访问，说明 `galois1130.site`
**已经有 ICP 备案**，子域名可以直接用。

严格来说，备案是按接入商走的 —— 域名指向华为云，规范做法是办一次「接入备案」
（在华为云备案系统里新增接入，免费，只是要等审核）。实际访问会不会被拦，
各地管局策略不同，最快的验证方式就是部署完直接用手机流量打开试一下：

- 能打开 → 不用管，先跑起来
- 打不开且显示备案相关页面 → 需要办接入备案，或者干脆把网页放回腾讯云那台机器上
  （`setup-server.sh` 在腾讯云上一样能跑，脚本不绑定厂商）

---

## 六、如果要换服务器 / 换域名

脚本所有关键值都在文件头部，改这三行即可：

```bash
DOMAIN="photo.galois1130.site"     # 换域名
WEBROOT="/var/www/photo-coach"     # 换目录
REPO="eye1130/photo-coach"         # 换仓库
```

换域名后记得同步改 `android/app/build.gradle.kts` 的 `APP_URL` 和
`MainActivity.java` 的 `APP_HOST`，然后重新出包（这是唯一需要重装 APK 的场景）。
