# Windows 原生运行 worker（预览）—— 运维说明

> 适用：**Windows 10 1809+ / Windows 11 x64** 上原生运行 worker（不是 WSL、不是 Docker Desktop）。
> 首版范围：**仅 opencode 引擎**（`WORKER_ENGINE=dsh` 在 Windows 上启动即报错，不做静默回退）；**自更新默认不执行**（`WORKER_WINDOWS_SELF_UPDATE=1` 是自备重启桥后的逃生开关，见 §6）。
>
> 状态声明（请先读）：本目录的脚本与命令**未在 Windows 真机验证**（本仓库在 macOS 上开发）。
> 真机已实测的只有上游侧与旧 worker 的失败点：`npm i -g @opencode/cli@2.0.32` 可装（18s，落 213MB 原生 `opencode.exe`）、`opencode --version` = `v2.0.32`、`opencode serve` + Basic Auth `/api/info` 200、`tar.exe` 可解 `.tar.gz`、`spawn('opencode')` ENOENT、`process.kill(-pid)` ESRCH、Windows 无 `HOME`。
> 详见仓库 `docs/windows-worker-feasibility.md`（可行性报告）与 `worker/README.md`「Windows（原生，预览）」章节。
>
> 本目录提供运维脚本：`enable-firewall.ps1`（防火墙）、`start-worker.ps1`（前台启动/排障）、
> `stop-worker.ps1`（停止 + 进程树清理）、`uninstall-worker.ps1`（卸载）。**Windows 一键安装器**
> 位于控制面静态资源 `web/public/install-worker.ps1`（由安装页 Windows Tab 生成命令），本文 §0 给出用法。
> 所有 `.ps1` 均为 **UTF-8 带 BOM**（Windows PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 解码，中文会乱码；
> 带 BOM 才能 5.1/7 双兼容），`.cmd` 为 ANSI。脚本与命令**均未在 Windows 真机验证**。

---

## 0. 一键安装器（`install-worker.ps1`，预览）

由控制面 web 静态服务分发（`<web-origin>/install-worker.ps1`），安装页「Windows PowerShell」Tab 会生成：

```powershell
Invoke-WebRequest -UseBasicParsing '<web-origin>/install-worker.ps1' -OutFile "$env:TEMP\install-worker.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-worker.ps1" `
  -Server '<server-url>' -SrcUrl '<web-origin>/worker-src.tar.gz' `
  -WorkerId '<worker-id>' -Concurrency 8 -Token '<token>' [-AdvertiseHost '<worker-lan-ip>'] [-McpUrl '<url>']
```

流程：前置检查（OS/架构/管理员/执行策略/TLS）→ 目录 `<dir>\{node,npm-global,app,work,data,logs,bin,run}` →
便携 Node（nodejs.org/npmmirror/tuna + SHASUMS256）→ npm 全局装 opencode（v2 闸门 + 解析 `OPENCODE_BIN`）→
下载发布包（可选 `-SrcSha256`）→ 调 `stop-worker.ps1` 停旧实例 → `tar.exe` 解包 → `npm ci --omit=dev` →
写 `.env`（UTF-8 无 BOM、保留旧键、`icacls` 收权）→ 防火墙（调 `enable-firewall.ps1 -Port 4198`）→
服务化（`-ServiceManager auto`：WinSW 2.12 优先，取不到回退计划任务）→ 自检（服务/任务 → 4198 监听 → 本机 HTTP 探测）。

常用参数：`-Dir`（缺省：管理员 `%ProgramData%\vteam-worker`，否则 `%LOCALAPPDATA%\vteam-worker`）、
`-TokenFile`（无人值守）、`-NoService -NoFirewall`（普通用户前台试用）、`-Force`（升级：重下发布包/重建服务）、
`-WinswPath`（内网离线提供 WinSW）、`-Registry`（npm 镜像）、`-SkipNpmCi`（离线包自带 node_modules 时）。

⚠️ 安装器要求 **Node ≥ 20.6**（服务模式用 `node --env-file` 读 `.env`）；`-NoService` 前台路径不受此限（走 `start-worker.ps1` 自解析）。

---

## 1. 依赖检查清单

在目标机打开 **Windows PowerShell 5.1**（或 PowerShell 7），逐条执行，任一失败先修依赖再继续：

```powershell
node --version                                  # 需要 >= 18，推荐 22 LTS（node --env-file 需要 >= 20.6）
npm --version
git --version                                   # Git for Windows；worker 的 git 工具族依赖 git.exe
ssh -V                                          # Git for Windows 自带，或系统可选功能 OpenSSH Client
Test-Path "$env:SystemRoot\System32\tar.exe"    # True = 有 bsdtar（Win10 1803+ 自带，用于解 .tar.gz）
```

| 依赖 | 版本要求 | 检查方式 | 说明 |
|------|---------|---------|------|
| Node.js | >= 18；推荐 22 LTS | `node --version` | 用官方安装包或便携 zip 均可；`node --env-file` 需要 >= 20.6（Node 18 见 §3 的 .env 导入片段） |
| npm | 随 Node | `npm --version` | 只用于装 opencode 与 worker 依赖 |
| opencode CLI | v2（本仓库对着 `2.0.32` 验证） | `opencode --version` | 见 §1.1；**主版本 < 2 时 worker 启动 fail-fast** |
| Git for Windows | 任意近期版本 | `git --version`、`ssh -V` | `git.exe` 必须在 PATH；提供 ssh 给 git 凭证注入 |
| tar.exe | Win10 1803+ 自带 | 上一行 `Test-Path` | 解 `worker-src.tar.gz`；`Expand-Archive` **不支持** `.tar.gz` |
| 管理员权限 | 仅以下操作需要 | — | 防火墙规则、安装 Windows 服务；**前台运行不需要** |

### 1.1 安装 opencode 并解析 `OPENCODE_BIN`

```powershell
# 1) 安装（本仓库对着 2.0.32 验证；已实测在 windows-latest 可用）
#    ⚠️ 这属于「上游未承诺」的渠道：上游文档写明 Windows 包管理器不受支持；
#    因此装完必须自检，失败就停下（不要带着坏 CLI 继续装 worker）。
npm install -g @opencode/cli@2.0.32

# 2) 自检：必须打印版本
opencode --version        # 期望：opencode v2.0.32

# 3) 解析绝对路径（worker 的 OPENCODE_BIN 指向它）
$prefix = (npm prefix -g).Trim()
Get-ChildItem (Join-Path $prefix 'opencode*') | Select-Object Name, FullName
# 典型输出：
#   opencode.cmd     ← npm 的 cmd shim（推荐 OPENCODE_BIN 指向它）
#   opencode.ps1     ← PowerShell shim
#   opencode         ← 无扩展名 sh 脚本（Git Bash 用；Node spawn 它 = ENOENT，别用）
Test-Path (Join-Path $prefix 'node_modules\@opencode\cli\bin\opencode.exe')   # 原生 exe（备选指向）
```

把路径写进 `.env`（见 §2）：

```ini
# 推荐（npm shim，随 npm 升级仍有效）：
OPENCODE_BIN=C:\Users\<你>\AppData\Roaming\npm\opencode.cmd
# 或直接指向原生 exe（更「稳定」，但 opencode 升级后路径不变、内容更新）：
# OPENCODE_BIN=C:\Users\<你>\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe
```

> 为什么必须设：npm 在 Windows 只生成 `.cmd` / `.ps1` shim，worker 裸 `spawn('opencode')` 会 `ENOENT`（已实测）。
> 不设 `OPENCODE_BIN` 时 worker 会尝试在 PATH 上解析并跳过无扩展名 shim，但**显式设置最可靠**（服务账户的 PATH 与你登录会话的 PATH 不同）。

---

## 2. 配置：`.env` 与权限

### 2.1 放置位置

| 运行方式 | `.env` 位置 | 说明 |
|---------|------------|------|
| 前台（仓库/解包目录） | `<worker 目录>\.env` | 从 `.env.example` 复制；本文以 `C:\vteam\worker` 为例 |
| Windows 服务（推荐机器级布局） | `C:\ProgramData\vteam-worker\app\.env` | 与 §5.2 的目录布局配合；服务账户需要读权限 |

```powershell
cd C:\vteam\worker
Copy-Item .env.example .env
notepad .env    # 至少填：X_WORKER_TOKEN / OPENCODE_SERVER_PASSWORD / OPENCODE_BIN / WORKER_ADVERTISE_HOST
```

### 2.2 必填与 Windows 关键项

| 变量 | 是否必填 | Windows 建议值 | 说明 |
|------|---------|---------------|------|
| `X_WORKER_TOKEN` | 必填 | 与控制面 `WORKER_TOKEN` 一致 | 注册鉴权（`X-Worker-Token`） |
| `OPENCODE_SERVER_PASSWORD` | 必填 | 随机 32 字节 hex | v2 serve 恒开鉴权；为空则 worker 启动 fail-fast |
| `OPENCODE_BIN` | 强烈建议 | `<npm 前缀>\opencode.cmd` | Windows 上裸 `spawn('opencode')` = ENOENT；见 §1.1 |
| `WORKER_ADVERTISE_HOST` | 强烈建议显式 | `http://<worker 局域网 IP>` | Windows 有 WSL/Hyper-V/Docker Desktop 时自动探测可能选到 `vEthernet` 的 172.x ⇒ 注册成功但派发全失败 |
| `WORK_DIR` | 可选 | 缺省 `%LOCALAPPDATA%\vteam-worker`；服务化建议 `C:\ProgramData\vteam-worker\work` | Windows 缺省不再用 `/data/vteam-worker`（普通用户建不了 `C:\data`） |
| `WORKER_EXEC_PORT` | 可选 | `4198` | 执行端点端口；防火墙只放行这个端口 |
| `OPENCODE_SERVE_HOSTNAME` | 不需要改 | `127.0.0.1`（缺省） | 控制面不直连 serve；**不要**对外开放 serve 端口 |
| `WORKER_ENGINE` | 不要设 dsh | `opencode`（缺省） | Windows 首版仅 opencode；`dsh` 启动即报错 |

挑选 `WORKER_ADVERTISE_HOST` 的地址（排除虚拟网卡）：

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and
    $_.InterfaceAlias -notmatch 'vEthernet|WSL|Hyper-V|Docker|Loopback|Tailscale|ZeroTier|OpenVPN|WireGuard|AnyConnect|PANGP'
  } | Select-Object InterfaceAlias, IPAddress, PrefixLength
# 选中「控制面能访问、且 Test-NetConnection <IP> -Port 4198 能通」的那条，写成 http://<IP>
```

### 2.3 收紧 `.env` 权限（`chmod` 在 Windows 无效，用 `icacls`）

`.env` 里有注册 token，可能还有 serve 密码 ⇒ **只让运行账户、SYSTEM、Administrators 可读**：

```powershell
$envFile = (Resolve-Path .env).Path

# 前台/当前用户方式（运行账户 = 你本人）
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $envFile /inheritance:r
& icacls.exe $envFile /grant:r "${me}:(F)" "SYSTEM:(F)" "BUILTIN\Administrators:(F)"

# 服务账户方式（LocalSystem）：仍要先 /inheritance:r，再只授 SYSTEM/Administrators
# & icacls.exe $envFile /inheritance:r
# & icacls.exe $envFile /grant:r "SYSTEM:(F)" "BUILTIN\Administrators:(F)"

# 验证：输出里不应出现 BUILTIN\Users / Everyone / Authenticated Users
& icacls.exe $envFile
```

要点：

- **必须 `/inheritance:r`**：`%ProgramData%` 下默认 `Users:(RX)`，不收继承 = 所有本地用户都能读 token。
- 用 `${me}` / `${env:USERNAME}` 而不是 `"$env:USERNAME:(F)"`——后者会被 PowerShell 解析成 `$env:USERNAME:` + `(F)`，授权目标变成空。
- 同样的 ACL 建议施加到 `work\`（agent 工作区）与 `data\`（`auth.json` 里有明文模型 key）。

### 2.4 `.env` 编码：UTF-8 **无 BOM**

PowerShell 5.1 的 `Set-Content -Encoding utf8` / `Out-File` 会写 BOM，`node --env-file` 解析首行键可能失效。要统一无 BOM 时：

```powershell
$envFile = (Resolve-Path .env).Path
$text = Get-Content -LiteralPath $envFile -Raw -Encoding UTF8
[System.IO.File]::WriteAllText($envFile, $text, (New-Object System.Text.UTF8Encoding($false)))
```

---

## 3. 前台启动（排障用）

```powershell
cd C:\vteam\worker
npm install
npm run build                 # 产出 dist\index.js
node --env-file=.env dist\index.js     # Node >= 20.6：让 node 直接读 .env
```

Node 18（无 `--env-file`）时，先把 `.env` 导进当前进程再启动（只影响本会话）：

```powershell
Get-Content .env -Encoding UTF8 | Where-Object { $_ -match '^\s*[^#][^=]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim().Trim('"'), 'Process')
}
node dist\index.js
```

启动成功的日志锚点：

- `[exec] 执行端点就绪: POST http://0.0.0.0:4198/execute`
- `注册成功: workerId=...`
- 不应出现 `spawn 失败` / `ENOENT` / `ESRCH`

> 前台按 `Ctrl+C` 时 Node 收到 `SIGINT`，会走 `shutdown()`（清 `auth.json`、flush 事件）。
> **作为 Windows 服务停止时是 TerminateProcess 语义**，`SIGINT/SIGTERM` 到不了，效果不同——见 §5.3。

---

## 4. 防火墙：只放行执行端点 `4198`

v2 拓扑下**控制面只连 worker 的执行端点**（`POST /execute`，端口 = `WORKER_EXEC_PORT`，缺省 4198）。
`opencode serve` 绑 `127.0.0.1`，控制面不直连 ⇒ **不要**为 serve 开入站端口。

```powershell
# 以管理员身份打开 PowerShell，然后（在仓库/解包目录下）：
powershell -NoProfile -ExecutionPolicy Bypass -File .\worker\scripts\windows\enable-firewall.ps1

# 只预演（不落规则）：
powershell -NoProfile -ExecutionPolicy Bypass -File .\worker\scripts\windows\enable-firewall.ps1 -WhatIf

# 换端口 / 限定控制面网段：
powershell -NoProfile -ExecutionPolicy Bypass -File .\worker\scripts\windows\enable-firewall.ps1 -Port 4200 -RemoteAddress '10.0.0.0/8'

# 回滚：
Remove-NetFirewallRule -Name 'vteam-worker-exec'
```

脚本行为（详见脚本头注释）：

- 规则名固定 `vteam-worker-exec`，`-Profile` 缺省 `Domain,Private`（**不默认放行 Public**）；
- 先按规则名查：已存在且端口一致 ⇒ 幂等跳过；端口不一致 ⇒ 报错并提示先删后建（不静默改动）；
- 需管理员：未提权时直接抛错并提示以管理员身份运行；`-WhatIf` 由 PowerShell `ShouldProcess` 输出 `What if:` 行。

自检：

```powershell
Get-NetFirewallRule -Name 'vteam-worker-exec' | Get-NetFirewallPortFilter
Get-NetTCPConnection -LocalPort 4198 -State Listen        # worker 运行时应为 Listen
Test-NetConnection <worker 局域网 IP> -Port 4198            # 在控制面机器上跑
```

> 域环境若由 GPO 管理防火墙，脚本建的规则可能被 GPO 覆盖：先看 `Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction`，并找域管理员确认。

---

## 5. 服务化（手工路径；安装器已自动化，**均未在真机验证**）

Windows 没有 systemd。下面两种包装器都**未在本仓库的真机流程验证过**，请在目标机按 §5.5 自检确认。

### 5.1 选型对比

| 方案 | 结论 | 说明 |
|------|------|------|
| **WinSW 2.12**（v2.12.0） | **主选** | 单 exe 可离线分发，两种产物：`WinSW.NET461.exe`（约 0.6MB，要求 .NET Framework 4.6.1，Win10/11 自带）或 `WinSW-x64.exe`（自包含 .NET Core 3.1，约 18MB，**不要求目标机装 .NET**）；2.12 的 XML 元素支持 `onfailure` 崩溃重启、按大小/时间滚动日志、`stoptimeout` |
| **NSSM 2.24** | **备选** | stop 默认先向控制台进程发 Ctrl+C（Node 走 `SIGINT` ⇒ 有机会优雅退出）；但项目 2014 年后基本停更，参数多、脚本化更繁琐 |
| `sc.exe create` 直挂 `node.exe` | **不可行** | node 不实现 SCM 回调 ⇒ 启动报 **1053**；`sc failure` 只能给已有服务补恢复动作 |
| 计划任务（登录自启） | 无管理员场景备选 | 无崩溃重启、无日志轮转、用户登出即停；仅作兜底 |

> 配置元素注意：**WinSW 2.x 没有 `<prestop>` 钩子**（`<prestop>` 是 3.x 的）；2.x 的优雅停机手段是 `<stoparguments>`/`<stopexecutable>` 或依赖 `<stoptimeout>` 内的 Ctrl+C。选 3.x 时配置格式会变，不要混用本文的 XML。

### 5.2 建议目录布局（手工准备；安装器未落地）

```
C:\ProgramData\vteam-worker\
├─ node\node.exe              # Node 22 便携版（node.exe 与 npm.cmd 同目录）
├─ app\                       # worker 代码：dist\、package.json、.env
├─ work\                      # WORK_DIR（agent 工作区/仓库/产物）
├─ data\                      # OPENCODE_ISOLATION_ROOT（隔离配置域）
├─ logs\                      # 服务日志（WinSW/NSSM 输出）
└─ svc\                       # vteam-worker.exe + vteam-worker.xml（或 nssm.exe）
```

### 5.3 WinSW 2.12：最小可用配置

1. 从 [winsw/winsw releases](https://github.com/winsw/winsw/releases) 的 **v2.12.0** 下载包装器：`WinSW.NET461.exe`（体积小，依赖系统自带 .NET Framework 4.6.1）或 `WinSW-x64.exe`（自包含 .NET，约 18MB）；**不要**用 3.x 的 exe 配本文的 XML；
2. 重命名为 `vteam-worker.exe`，与 `vteam-worker.xml` 放在同一目录（WinSW 按「同名同目录」查找配置）。
3. WinSW 文档建议 `<id>` 用字母数字；若 `install` 报 id/服务名非法，把 `<id>` 改成 `vteamworker`（并同步本文其余命令里的服务名）。

`C:\ProgramData\vteam-worker\svc\vteam-worker.xml`：

```xml
<service>
  <id>vteam-worker</id>
  <name>vteam AI Worker</name>
  <description>vteam worker（opencode 引擎）：注册到控制面并执行 Agent 会话。</description>

  <!-- 主进程：node 直跑 dist\index.js；.env 用 --env-file 注入（Node >= 20.6，单一事实源） -->
  <executable>C:\ProgramData\vteam-worker\node\node.exe</executable>
  <arguments>--env-file=C:\ProgramData\vteam-worker\app\.env dist\index.js</arguments>
  <workingdirectory>C:\ProgramData\vteam-worker\app</workingdirectory>

  <!-- 服务账户的 PATH 不继承你的登录会话：git/ssh 必须显式给（按实际安装路径调整） -->
  <env name="PATH" value="C:\Windows\System32;C:\Windows;C:\Program Files\Git\cmd;C:\Program Files\Git\usr\bin" />

  <startmode>Automatic</startmode>

  <!-- 崩溃重启：10s 后第一次，30s 后后续；连续运行 1h 后重置失败计数 -->
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>

  <!-- 停机：先尝试 Ctrl+C，最多等 15s，然后 TerminateProcess -->
  <stoptimeout>15sec</stoptimeout>

  <logpath>C:\ProgramData\vteam-worker\logs</logpath>
  <log mode="roll-by-size-time">
    <sizeThreshold>20480</sizeThreshold>
    <pattern>yyyyMMdd</pattern>
    <autoRollAtTime>00:00:00</autoRollAtTime>
  </log>

  <!-- 默认 LocalSystem（跑得起来但权限过大）；生产建议改专用低权账户，见下方说明 -->
  <serviceaccount>
    <user>LocalSystem</user>
  </serviceaccount>
</service>
```

安装/启动/停止/卸载（均需**管理员**）：

```powershell
$svcDir = 'C:\ProgramData\vteam-worker\svc'
Copy-Item .\WinSW-x64.exe (Join-Path $svcDir 'vteam-worker.exe') -Force
# 把上面的 XML 保存为 $svcDir\vteam-worker.xml（文件名必须与 exe 同名同目录）

& (Join-Path $svcDir 'vteam-worker.exe') install
& (Join-Path $svcDir 'vteam-worker.exe') start
Start-Sleep -Seconds 3
Get-Service vteam-worker | Select-Object Status, StartType
Get-Content 'C:\ProgramData\vteam-worker\logs\vteam-worker.out.log' -Tail 50 -Encoding UTF8

# 停止 / 查状态 / 卸载
& (Join-Path $svcDir 'vteam-worker.exe') stop
& (Join-Path $svcDir 'vteam-worker.exe') status
& (Join-Path $svcDir 'vteam-worker.exe') uninstall   # 删服务（不删目录）
```

**停机语义的真实风险（务必知情）**：

- WinSW 2.12 stop = 先尝试 Ctrl+C → 等 `stoptimeout` → **TerminateProcess 强杀**。node 作为服务通常没有可接收 Ctrl+C 的控制台 ⇒ 实际是强杀，`shutdown()` 不执行（`auth.json` 不清、待发事件不 flush）。
- opencode serve 若是子进程树内的仍会被一起清；若实测**残留 `opencode.exe`**（占端口/锁 `opencode.db`），兜底：
  ```powershell
  $p = (Get-CimInstance Win32_Service -Filter "Name='vteam-worker'").ProcessId
  if ($p) { & taskkill.exe /PID $p /T /F }
  Get-Process opencode -ErrorAction SilentlyContinue | Stop-Process -Force
  ```
- 2.12 没有 `<prestop>`，此兜底只能手工/外部脚本做；若真机确认残留且必须自动化，改用 **WinSW 3.x 的 `<prestop>`** 或 **NSSM**。

**服务账户安全提示**：默认 `LocalSystem` 能跑通，但 worker 的 `/file?path=` 端点目前**没有目录白名单**，以 LocalSystem 运行 = 持有 token 即可读整机文件。生产建议专用低权本地账户（只授 `C:\ProgramData\vteam-worker` 权限）：

```xml
<serviceaccount>
  <domain>.</domain>
  <user>vteam-worker</user>
  <password>改成强密码</password>
  <allowservicelogon>true</allowservicelogon>
</serviceaccount>
```

> XML 里有明文密码：`vteam-worker.xml` 也要按 §2.3 用 `icacls` 收紧（仅 SYSTEM/Administrators）。

### 5.4 NSSM 2.24：备选

```powershell
# 以管理员身份；nssm.exe 放在 svc\ 或 PATH 上
$nssm = 'C:\ProgramData\vteam-worker\svc\nssm.exe'

& $nssm install vteam-worker 'C:\ProgramData\vteam-worker\node\node.exe' `
    '--env-file=C:\ProgramData\vteam-worker\app\.env' 'dist\index.js'
& $nssm set vteam-worker AppDirectory 'C:\ProgramData\vteam-worker\app'
& $nssm set vteam-worker AppStdout 'C:\ProgramData\vteam-worker\logs\worker.out.log'
& $nssm set vteam-worker AppStderr 'C:\ProgramData\vteam-worker\logs\worker.err.log'
& $nssm set vteam-worker AppRotateFiles 1
& $nssm set vteam-worker AppRotateOnline 1
& $nssm set vteam-worker AppRotateBytes 1048576
& $nssm set vteam-worker AppExit Default Restart
& $nssm set vteam-worker AppRestartDelay 10000
& $nssm set vteam-worker Start SERVICE_AUTO_START
& $nssm start vteam-worker

# 停止 / 删除服务
& $nssm stop vteam-worker
& $nssm remove vteam-worker confirm
```

NSSM 的取舍：stop 默认用 `AppStopMethodConsole`（向控制台进程发 Ctrl+C，默认等约 1.5s），Node 能收到 `SIGINT` ⇒ 优雅退出概率比 WinSW 2.12 高（**需真机确认**）；但项目自 2014 年后基本停更、命令行参数多，部分参数（如环境变量、停机顺序）行为也要在真机确认。若 `git` 不在**系统** PATH，请先把 Git for Windows 加进系统 PATH 再重启服务，而不是依赖用户级 PATH。

### 5.5 服务自检（4 步）

```powershell
# ① 服务在跑且是自动启动
Get-Service vteam-worker | Select-Object Name, Status, StartType
(Get-CimInstance Win32_Service -Filter "Name='vteam-worker'").ProcessId

# ② 本机执行端点已监听
Get-NetTCPConnection -LocalPort 4198 -State Listen -ErrorAction SilentlyContinue

# ③ 本机探测执行端点（未带 token 时返回 401/403 属正常；200 也接受）
try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4198/execute' -Method Post -TimeoutSec 5).StatusCode }
catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { throw } }

# ④ 日志出现注册成功；并在控制面机器上确认 4198 可达
Get-Content 'C:\ProgramData\vteam-worker\logs\vteam-worker.out.log' -Tail 200 -Encoding UTF8 |
  Select-String -Pattern '注册成功'
# 控制面机器上：
Test-NetConnection <worker 局域网 IP> -Port 4198
```

---

## 6. 升级与回滚

Windows 上**自更新默认不执行**（无 systemd、也没有服务重启桥；worker 收到 `update-worker` 指令时状态落 `ready-manual`，日志会提示重跑安装器/替换 `dist` 后重启）。只有在你**已自备服务重启桥**时，才在 `.env` 里设 `WORKER_WINDOWS_SELF_UPDATE=1` 放开（风险自负）。升级 = 停服务 → 替换 `app\` 内容 → 启服务：

```powershell
$svcDir = 'C:\ProgramData\vteam-worker\svc'
& (Join-Path $svcDir 'vteam-worker.exe') stop

# 备份（可选，回滚用；先删旧备份，避免 Copy-Item 把 app 套进 app.bak\app）
Remove-Item 'C:\ProgramData\vteam-worker\app.bak' -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item 'C:\ProgramData\vteam-worker\app' 'C:\ProgramData\vteam-worker\app.bak' -Recurse -Force

# 解新发布包覆盖 app\（worker-src.tar.gz 用系统 tar.exe；保留 .env / work\ / data\）
tar.exe -xzf .\worker-src.tar.gz -C 'C:\ProgramData\vteam-worker\app'
& (Join-Path $svcDir 'vteam-worker.exe') start
Start-Sleep -Seconds 3
Get-Service vteam-worker | Select-Object Status
Get-Content 'C:\ProgramData\vteam-worker\logs\vteam-worker.out.log' -Tail 50 -Encoding UTF8
```

回滚：停服 → 把 `app.bak` 换回 `app` → 启服 → 看日志锚点。
手工前台进程升级时，先找到它再停（不要无差别 `taskkill /IM node.exe`）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist\index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 7. 卸载清理清单

按顺序执行（管理员 PowerShell），验收按这份清单查：

```powershell
# 1) 停并删服务（WinSW 优先）
$svcDir = 'C:\ProgramData\vteam-worker\svc'
& (Join-Path $svcDir 'vteam-worker.exe') stop
& (Join-Path $svcDir 'vteam-worker.exe') uninstall
# 兜底（服务名不通时）：
# & sc.exe stop vteam-worker; & sc.exe delete vteam-worker
# NSSM 方式：
# & nssm remove vteam-worker confirm

# 2) 清残留进程（TerminateProcess 遗留的 opencode 子进程）
Get-Process opencode -ErrorAction SilentlyContinue | Stop-Process -Force

# 3) 删防火墙规则
Remove-NetFirewallRule -Name 'vteam-worker-exec' -ErrorAction SilentlyContinue

# 4) 计划任务（仅当用过无管理员自启方案）
schtasks.exe /Delete /TN 'vteam-worker' /F 2>$null

# 5) 目录：先备份 work\ 与 data\（agent 产物/会话库），再整体删除
#    ⚠️ 删除前确认路径，不要对变量拼接出的路径执行 Remove-Item
Remove-Item -LiteralPath 'C:\ProgramData\vteam-worker' -Recurse -Force
```

必须清理的项：**服务（SCM 条目）→ 进程与子进程 → 防火墙规则 → 计划任务 → 目录 → 事件日志源（本方案不注册）→ `.env`（含 token/密码，必须删或随目录删）**。
清理后校验：

```powershell
Get-Service vteam-worker -ErrorAction SilentlyContinue       # 应无输出
Get-NetFirewallRule -Name 'vteam-worker-exec' -ErrorAction SilentlyContinue  # 应无输出
Get-Process opencode -ErrorAction SilentlyContinue           # 应为空
Test-Path 'C:\ProgramData\vteam-worker'                      # 应为 False
```

---

## 8. 常见问题

| 症状 | 最可能原因 | 处置 |
|------|-----------|------|
| 启动日志 `spawn 失败: spawn opencode ENOENT` | 未设 `OPENCODE_BIN`，或指向了无扩展名 shim | 按 §1.1 解析出 `opencode.cmd` 绝对路径写进 `.env`；`where.exe opencode` 第一条通常是无扩展名 shim，别用 |
| 注册成功、心跳正常，但派发任务全 503 / `fetch failed` | 防火墙未放行 4198，或 `WORKER_ADVERTISE_HOST` 填成了虚拟网卡/VPN 地址 | 跑 §4 脚本；控制面机器上 `Test-NetConnection <IP> -Port 4198`；按 §2.2 重选地址 |
| 控制面显示版本 `unknown` | `OPENCODE_BIN` 指向不可执行文件，或 `opencode --version` 本身失败 | 手工 `opencode --version`；再 `& $env:OPENCODE_BIN --version` 对比；主版本必须 >= 2 |
| 4198 未监听（但服务 Running） | node 启动即崩：缺 `X_WORKER_TOKEN`/`OPENCODE_SERVER_PASSWORD`，或 `--env-file` 路径错/BOM 导致首键失效 | 看 `vteam-worker.err.log` / `.wrapper.log` 尾部；按 §2.4 去 BOM；核对 `.env` 路径 |
| 服务启动报 **1053** | 用 `sc.exe create` 直挂了 `node.exe` | 改用 WinSW/NSSM（§5） |
| 停服务后 `opencode.exe` 残留 / 端口被占 | WinSW 2.12 TerminateProcess 语义 + serve 子进程未随树清理 | 按 §5.3 兜底 `taskkill /T /F`；确认残留则考虑 WinSW 3.x `<prestop>` 或 NSSM |
| `EADDRINUSE` / 端口绑不上 | 4198 命中 WinNAT/Hyper-V 保留端口段 | `netsh int ipv4 show excludedportrange protocol=tcp` 看保留段；换 `WORKER_EXEC_PORT` 并同步防火墙脚本 `-Port` |
| 日志中文乱码 | 读取时未指定 UTF-8 | `Get-Content ... -Encoding UTF8`（PS 5.1 缺省不是 UTF-8） |
| `npm install -g` 后新开的 shell 里 `opencode` 不是命令 | PATH 未刷新（npm 全局目录未进 PATH） | 重开终端；长期用 `OPENCODE_BIN` 绝对路径，不依赖 PATH |
| `WORKER_ENGINE=dsh` 启动即报错 | Windows 首版不支持 dsh（Linux 沙箱链不可用） | 改回 `opencode`；dsh 支持属后续版本 |

---

## 9. 与 Linux 运维的差异速查

| 维度 | Linux（现有） | Windows（本页） |
|------|--------------|----------------|
| 开机自启 | systemd unit | WinSW 2.12 / NSSM 服务（或计划任务兜底） |
| 配置加载 | `scripts/start.sh` 里 `source .env` | `node --env-file=.env`（Node >= 20.6）或手工导入环境变量 |
| 密钥权限 | `chmod 0600` | `icacls /inheritance:r` + 精确授权 |
| CLI 解析 | PATH 上的 `opencode`（可执行） | `OPENCODE_BIN` 指向 `.cmd`/`.exe`（npm 只产 shim） |
| 杀进程树 | `process.kill(-pid)`（进程组） | `taskkill /PID <pid> /T /F` |
| 优雅退出 | `SIGTERM` / `SIGINT` | 前台 Ctrl+C 有效；服务停止是 TerminateProcess（不可靠） |
| 注销/停止 | `systemctl stop` | 包装器 stop + 兜底 taskkill |
| 自更新 | systemd + tar + npm | **默认不执行**（`WORKER_WINDOWS_SELF_UPDATE=1` 才放开，需自备重启桥）；升级=停服→替换 dist→启服 |
| 解包 | `tar -xzf` | 系统自带 `tar.exe`（bsdtar） |
| 网络放行 | firewalld/ufw | `enable-firewall.ps1`（仅 TCP 4198 入站） |
| 隔离主目录 | `HOME` + `XDG_*` | `XDG_*` 生效、`HOME` 不生效（opencode 的 `global.home` 系路径仍走 `USERPROFILE`） |

---

## 10. 相关文档

- [worker/README.md](../../README.md) —— worker 总览、环境变量与「Windows（原生，预览）」章节
- [worker/.env.example](../../.env.example) —— 配置项注释（含 Windows 相关说明）
- [docs/windows-worker-feasibility.md](../../../docs/windows-worker-feasibility.md) —— 可行性报告、真机实测结论、M0 实现进度（§8）
- [enable-firewall.ps1](enable-firewall.ps1) —— 本目录的防火墙脚本（幂等、`-WhatIf`、可回滚）
