# Windows 安装 worker：可行性验证与落地方案

> 目标：验证「在 Windows 上安装 vteam worker」是否可行，并给出可落地的方案与分阶段计划。
> 目标形态（按用户 2026-11-13 选择）：**Windows 10/11 桌面机原生安装 + 服务化/开机自启 + 首版只支持 opencode 引擎**。
>
> 验证方式：① 静态审计（worker/server/web 全链路，逐条 `file:line`）；② **真机验证**：在 GitHub Actions `windows-latest`（Windows Server 2022 / 10.0.26100，x64，Node 22）跑临时 smoke workflow，实测 npm 全局安装 opencode、`opencode serve`、Basic Auth、XDG 隔离、`.cmd` spawn 语义、`process.kill(-pid)`、`tar.exe`、以及 worker 本体的 typecheck/build/jest/独立模式启动。临时 CI 分支与 run 已全部清理（证据与可复现脚本保留在本仓 `.design/windows-worker/ci-evidence/`）。
>
> 审计底稿（未入库，工作区可见）：
> - [.design/windows-worker/notes-runtime-port.md](../.design/windows-worker/notes-runtime-port.md)（运行时 P0/P1/P2）
> - [.design/windows-worker/notes-installer-service.md](../.design/windows-worker/notes-installer-service.md)（安装器/服务化/升级卸载）
> - [.design/windows-worker/notes-engine-support.md](../.design/windows-worker/notes-engine-support.md)（opencode/dsh 引擎与 Node 语义）
> - [.design/windows-worker/notes-control-plane.md](../.design/windows-worker/notes-control-plane.md)（控制面/安装页/发布链）
> - [.design/windows-worker/ci-evidence/](../.design/windows-worker/ci-evidence/)（本次真机日志、探针脚本、探针 JSON）

---

## 0. 结论（先看这一节）

**结论：可行，但不是「加个安装脚本」就能上线——需要约 6 处代码改动 + 一套 Windows 安装/服务化资产。首版建议只承诺 opencode 引擎 + Windows 10/11 x64 桌面。**

| 维度 | 判定 | 依据（实测/静态） |
|------|------|------------------|
| opencode v2.0.32 在 Windows 能否安装/运行 | **能**（`npm i -g @opencode/cli@2.0.32` 成功，18s，落 213MB 原生 `bin\opencode.exe`；`opencode --version` = `v2.0.32`；`opencode serve` 起得来，`/api/info` 带 Basic Auth 200，2s 内就绪） | 本次真机 |
| worker 进程在 Windows 能否启动 | **当前不能**。能一路启动到「拉起 serve」这一步，然后 `spawn opencode ENOENT` → `exit(1)`（实测日志与静态审计 P0-1 完全一致）。修掉 CLI 解析即可跨过 | 本次真机 |
| 隔离配置域（HOME/XDG）在 Windows 是否生效 | **XDG_\* 生效**（隔离域内出现 `config/opencode`、`data/opencode/{log,opencode.db,...}`、`state/opencode`）→ 凭据/会话库/日志可隔离；但 **HOME 不生效**（Node `os.homedir()` 走 `USERPROFILE`），`global.home` 系路径（`<USERPROFILE>\.agents` 等）仍会泄漏，需补 `OPENCODE_TEST_HOME` | 本次真机 |
| 控制面协议是否需要改 | **不需要**（注册/心跳纯 JSON + `X-Worker-Token`，调度纯 DB 过滤，拨号按 `capabilities.execPort` 拼端点）。可选的 `capabilities.platform` 只是为了可观测/混合池过滤 | 静态 |
| 安装与服务化是否有技术阻断 | **无**。PS1 安装器 + WinSW/NSSM 服务 + `tar.exe` 解包 + `icacls` 收权都验证过/有确定等价物 | 静态 + 真机（tar） |
| 自更新 | Windows 上**默认不可用**（无 systemd；且 `systemctl`/`npm`/`tar` 裸名 spawn 在 Windows 会失败）。首版建议：Windows 关闭自更新，升级走「重跑安装器」；二期补服务重启桥 | 静态 |
| dsh 引擎 | **不进首版**（上游有 win32 沙箱但强度 partial、且 `flock` 在 win32 抛错；本仓安装链/bwrap 补丁全是 Linux 形状） | 静态（与用户选择一致） |
| Agent 任务在 Windows 上的成功率 | **未验证，属最大产品级风险**。agent 的 shell 习惯（bash、`/tmp`、`chmod`、POSIX 路径）在原生 Windows 上大概率退化 | 待真机任务级验证 |

**工作量估算（1 人）**：M0 运行时可跑 ≈ 2 人日（+0.5 天真机）→ M1 安装器/服务化/UI ≈ 2–3 人日 → M2 功能对齐 ≈ 3–5 人日。**首版（M0+M1，能装、能注册、能接任务）约 5 人日**；完整对齐约 8–10 人日。

---

## 1. 真机验证结果（可复核）

### 1.1 环境与方法

- Runner：`windows-latest` = Windows Server 2022（`10.0.26100`），x64，`node v22.23.4`、`npm 10.9.9`、`bsdtar 3.8.9`。
- 方法：临时分支 `ci/windows-worker-smoke` + 仅 `push` 触发的 workflow（避免污染 main），两个 job：
  - `opencode-smoke`：装 `@opencode/cli@2.0.32` → 跑探针脚本（spawn/kill/tar/serve/隔离）；
  - `worker-windows`：`npm ci` → `tsc --noEmit` → `jest` → `npm run build` → 以 `WORKER_STANDALONE=true` 启动 `node dist/index.js` 60s 观察真实失败点。
- 复现：探针脚本 [windows-smoke-probe.mjs](../.design/windows-worker/ci-evidence/windows-smoke-probe.mjs) + workflow [windows-worker-smoke.yml](../.design/windows-worker/ci-evidence/windows-worker-smoke.yml)，原始输出见同目录 `*.log` / `windows-smoke-probe.json`。
- ⚠️ 边界：runner 是 **Windows Server**（内核/API 与 Win10/11 桌面一致，但**桌面特有行为未覆盖**：Defender 智能屏/EDR、桌面会话、WinSW 服务安装、防火墙交互弹窗、WinNAT 保留端口等）。下文标注「需桌面真机」。

### 1.2 关键实测结论

| # | 实测项 | 结果 | 对方案的含义 |
|---|--------|------|--------------|
| R1 | `npm install -g @opencode/cli@2.0.32` | ✅ 成功（`added 3 packages in 18s`），全局包内含 `@opencode/cli/bin/opencode.exe`（**213 MB**）+ `cli-windows-x64`/`-baseline` 两个平台包 | npm 渠道在 Windows 可用。⚠️ 上游 docs 写「Windows package managers are not supported」，属**未被官方承诺**的渠道 → 安装器必须装完即自检，上游变更要在安装期响亮失败 |
| R2 | `opencode --version` / `serve` | ✅ `opencode v2.0.32`；`serve --port 4199 --hostname 127.0.0.1 --print-logs` 2.0s 内 `/api/info` 带 Basic Auth 返回 200（`{"version":"2.0.32","pid":...}`）；stdout 有 `server listening on ...`，stderr 有结构化日志 | worker 的 serve 契约（v2 + 恒开鉴权）在 Windows 成立；`--print-logs` 行为与 worker 假设一致（此前担心的「server logs require --standalone」不成立） |
| R3 | `spawn('opencode')`（worker 现状） | ❌ `ENOENT spawn opencode ENOENT` | 与 worker 实测启动日志完全一致 → **P0 根因** |
| R4 | `spawn('opencode.cmd')`（无 shell） | ❌ 抛 `EINVAL`（Node ≥18.20/20.12 对 `.cmd` 的 CVE-2024-27980 限制） | 不能简单地把命令名改成 `.cmd` |
| R5 | `spawn(..., {shell:true})` / `cmd.exe /d /s /c "opencode ..."` | ✅ 退出码 0，输出 `opencode v2.0.32` | 两条可用修法；推荐 `cmd /c`（参数整体一条命令行，注入面可控）或直接解析 `opencode.exe` 绝对路径 |
| R6 | `where.exe opencode` 的首条结果 | ⚠️ `C:\npm\prefix\opencode`（**无扩展名的 sh 脚本**）→ 直接 spawn 它 = `ENOENT`；`.cmd` 在第二条；真正的 exe 在 `node_modules\@opencode\cli\bin\opencode.exe` | 解析逻辑必须**优先 `.exe`/`.cmd`，跳过无扩展名 shim**，这是最容易踩的坑 |
| R7 | `process.kill(-pid, 'SIGTERM'/'SIGKILL')`（进程组） | ❌ `ESRCH`（Windows 无进程组语义），两次都失败且被现有 `catch{}` **静默吞掉** | `opencode-server.ts:404/411` 的清理在 Windows 完全不生效 → serve 杀不掉、退出后残留 |
| R8 | `process.kill(pid)` / `taskkill /PID <pid> /T /F` | ✅ 单 pid 可终止；`taskkill /T /F` 实测把 `cmd` → `opencode serve` 整棵树（3 个 PID）全部清掉 | 修法确定：win32 用 `taskkill /T /F`（上游 opencode 自己也这么做） |
| R9 | `tar -xzf` / `Expand-Archive .tar.gz` | ✅ 系统自带 `bsdtar 3.8.9`，`tar -xzf` 正常（含空格路径）；❌ `Expand-Archive` 不支持 `.tar.gz` | 安装器与自更新器沿用 `tar.exe` 即可；不需要改发布物格式（zip 仅 Win Server 2016 等老系统才需要） |
| R10 | worker 在 Windows 上 `tsc --noEmit` / `npm run build` | ✅ 均通过（dist 是纯 JS，无平台绑定） | 构建链路无需改 |
| R11 | worker jest（Windows） | ⚠️ `63 failed / 1447`（11 个 suite 失败，35 通过/5 跳过），失败集中在 `exec-server`(secret-command)、`git-tools`、`git-credential-injector`、`worker-updater`、`sensitive-command`、`config`、`index`、`opencode-server.integration` 等**平台假设用例** | 与静态审计结论一致：这些正是要改的点；也说明「Windows CI 必须加平台 skip/双跑」 |
| R12 | worker 独立模式启动（`WORKER_STANDALONE=true`） | ⚠️ 启动到「`[opencode-server] spawn 失败: spawn opencode ENOENT`」后 `exit(1)`；其余环节全部正常：隔离域创建、git 工具注入（`D:\a\_temp\...\.opencode\plugins\git.ts`）、system-handoff 插件、omo 种子、`WORK_DIR` 反斜杠路径、网卡自动探测 | **窗口很清楚**：唯一硬阻断就是 CLI 解析；修掉后就能起服务、注册、接任务 |
| R13 | Windows 网卡 | `Ethernet 3, Loopback Pseudo-Interface 1, vEthernet (nat)` | 确认 Windows 存在 `vEthernet` 虚拟网卡；`detectLocalIPv4` 的前缀表是 Linux 视角 → 在有 WSL/Hyper-V/Docker Desktop 的机器上**可能**选错地址（顺序相关），必须让安装器强制显式 `WORKER_ADVERTISE_HOST` |
| R14 | `HOME` 环境变量 | ⚠️ Windows 上 **`HOME` 不存在**（只有 `USERPROFILE`）；`os.homedir()` = `C:\Users\<user>` | worker 注入 `HOME` 对 opencode 的 "home" 语义无效 → 需补 `OPENCODE_TEST_HOME`；同时 `%ProgramData%\opencode` 不受 XDG 控制（等价 Linux `/etc/opencode`） |
| R15 | 隔离域实际落盘 | ✅ `cache/opencode`、`config/opencode`、`data/opencode/{log/opencode.log, opencode.db, repos}`、`state/opencode` 全在隔离根内 | T16b 的「隔离配置域」设计在 Windows 上**依然成立**（XDG 生效），这是最大的好消息；但安装期 npm postinstall 不受隔离（见 §4.2） |

> **审计纠偏（Lead 复核）**：控制面审计曾提出「`worker.client.ts` 解析 IPv6 advertise 时丢方括号」——实测 `new URL('http://[::1]:4199').hostname === '[::1]'`，**该 bug 不成立**，不要按此改代码。真正脆弱的是 `resolveAdvertiseOrigin` 的兜底分支（`raw` 不是合法 URL 时 `split(':')` 会切坏 IPv6），只在非法输入时触发，低优先级。

---

## 2. 可行性判定（分项）

### 2.1 核心执行链路：可行（需 M0 修复）

worker 的 v2 拓扑不变：worker 进程 → spawn `opencode serve`（回环 + Basic Auth）→ 对外只暴露执行端点 `:4198`（`X-Worker-Token`）→ 控制面拨 `capabilities.execPort`。本链路在 Windows 上**唯一硬阻断**是 CLI 命令解析（R3/R4），其余（HTTP 驱动、端口探测、隔离域、注入、心跳）实测或静态均无平台绑定。

### 2.2 安装与服务化：可行（工作量在脚本，无技术未知）

Linux 的 29 步安装链在 Windows 上**没有一步能原样复用**（bash / `source` / systemd / tar.xz / glibc 全不可用），但每一步都有确定等价物（详见 [installer 笔记 §1 逐步骤对照表](../.design/windows-worker/notes-installer-service.md)）。关键选型：

- 安装入口：`install-worker.ps1`（`-File` 方式）+ `install-worker.cmd` 包装；不用 `irm | iex`（无法传参、EDR 敏感、不可校验）。
- 运行时：便携 Node zip 解到安装目录（不依赖 winget/MSI/系统 PATH）；opencode 用 `npm -g --prefix <install>\npm-global` 落安装目录。
- 服务化：**WinSW**（单 exe、可离线捆绑、崩溃重启、日志滚动、preboot 自启）为主；**NSSM** 为备选（stop 走 Ctrl+C，可能优雅停机，但项目停更）；`sc.exe create` 直挂 node 不可行（服务不实现 SCM 回调 → 1053）。
- 端口：只放行 **4198**（执行端点）；serve 端口绑回环、对外不放行（v2 拓扑本来就不需要）。

### 2.3 升级：可行但首版应「关闭自更新」

Windows 没有 systemd，worker 的 updater 会：① `systemctl`/`npm`/`tar` 裸名 spawn 失败（不是干净地落 `ready-manual`，而是 reject，见 P1-5）；② 覆盖 `dist` 后同进程心跳就上报新 `codeVersion` → 控制面误判「已对齐」清掉更新指令，而进程仍跑旧码（`code-version.ts` 按文本重读，`workers.service.ts:669` 收敛）。**首版建议 Windows 直接禁用自更新**，升级=重跑安装器；二期加 `WORKER_SERVICE_RESTART_COMMAND`（由 worker 自报/安装器写入，服务重启，不由控制面下发命令，避免 RCE 面）。

### 2.4 dsh 引擎：首版不支持（与用户选择一致）

上游 `dsh-sandbox-local` 其实列了 `win32:["windows-acl"]`（强度 partial），但：① 本仓 dsh 链路全是 Linux 形状（bash 安装器、bwrap `/proc` 补丁、Node 24 下载、注入器占位）；② `dsh-session-persistence-jsonl` 依赖的 `flock` 在 win32 抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`（是否致命未确证）；③ Windows 上 `dsh` 同样只有 `.cmd` shim，且 `src/driver/dsh-rpc-client.ts:180` 的 spawn **没有 `'error'` 监听** → ENOENT 会变成未捕获异常直接崩进程。**结论：Windows 首版只支持 opencode；dsh 在 Windows 上明确报错不支持（不要静默回落）。**

### 2.5 Agent 任务层面：最大产品级风险（未验证）

即使 worker 跑起来，**Agent 执行任务的行为**仍是 Windows 化的最大不确定性：agent 的 shell 工具、`bash` 习惯、`/tmp`、`chmod`、POSIX 路径、git hooks、npm 脚本都可能在原生 Windows 上退化。建议：① 目标机装 Git for Windows（提供 `bash.exe`）并验证 opencode 的 shell 选择；② 首版验收必须包含**真实任务级** smoke（读文件 / `git clone`+`git push` / 跑一次 `npm test` / 生成产物）；③ 若不达标，先把 Windows worker 定位为「特定任务池」（如无 shell 依赖的文档/分析类），而不是替代 Linux worker。

---

## 3. 必须改的代码（按阻断性排序）

> 所有行号基于审计时工作树（HEAD `8963b2e2`/`0f639bbd` 一代）；证据详见 [runtime 笔记](../.design/windows-worker/notes-runtime-port.md)。

### 3.1 P0（不改就起不来 / 核心功能全废）

| # | 问题 | 证据 | Windows 现象（实测/静态） | 修法 | 量 |
|---|------|------|---------------------------|------|----|
| P0-1 | 全部外部 CLI 都是「裸命令名 + 无 shell」`spawn`/`spawnSync` | `worker/src/runtime/opencode-server.ts:558,422`、`worker/src/index.ts:648`、`worker/src/update/worker-updater.ts:533,579,935`、`worker/src/driver/dsh-rpc-client.ts:180`、`worker/src/browser/browser-tools.ts:176`、`worker/src/resources/custom-tool.ts:117` | 实测 `spawn opencode ENOENT`；`.cmd` 直调 `EINVAL`；报错文案误导成「没装 opencode」 | 新增 `resolveCliCommand()`：win32 优先解析 npm 全局 `@opencode/cli/bin/opencode.exe`（或 `where` 结果里跳过无扩展名 shim 选 `.exe/.cmd`），再以 `cmd.exe /d /s /c` 或直接 exe 启动；新增 `OPENCODE_BIN` env 由安装器写入绝对路径。8 个调用点统一走一个 helper | M |
| P0-2 | `/secret-command` 硬编码 `/bin/sh -c` | `worker/src/exec/sensitive-command.ts:43,323` | 该功能域在 Windows 100% 失败（ENOENT 被伪装成「命令执行失败」，HTTP 仍 200） | 抽 `WORKER_SHELL`（win32 默认 `cmd.exe /d /s /c`，或 PowerShell）；能力位上报；不支持时返回明确 503/错误码 | M |
| P0-3 | dsh 驱动 spawn 无 `'error'` 监听 | `worker/src/driver/dsh-rpc-client.ts:180` | 若 Windows 上误开 dsh：ENOENT → uncaughtException → 进程崩 | 首版：Windows 启动期直接拒绝 `WORKER_ENGINE=dsh`（明确文案）；顺手补 `'error'` 监听 | S |

### 3.2 P1（能跑但残缺 / 运维必须救火）

| # | 问题 | 证据 | Windows 现象 | 修法 | 量 |
|---|------|------|--------------|------|----|
| P1-1 | `detached:true` + `kill(-pid)` 无进程组语义，且 catch 静默吞 | `opencode-server.ts:404,411`；`sensitive-command.ts:218` | 实测 `ESRCH` → serve 停不掉、重启/退出后残留、超时命令杀不干净 | win32 分支 `taskkill /PID <pid> /T /F`；失败必须**可见**（日志 + 上报） | M |
| P1-2 | 优雅退出依赖 `SIGTERM/SIGINT` | `worker/src/index.ts:2358-2359` | 服务停止 = `TerminateProcess` → `shutdown()` 整段不执行（**明文 `auth.json` 不清理**、事件不 flush） | 启动期清理 stale `auth.json`；支持 `SIGBREAK`；提供 `stop-worker.ps1`/IPC「shutdown」SOP；服务包装器尽量走 Ctrl+C | S |
| P1-3 | `GIT_ASKPASS` 是 `#!/bin/sh` 脚本；`GIT_SSH_COMMAND` 里 `C:\...` 未加引号 | `worker/src/git/git-tools.ts:363-372,387` | https token / ssh key 凭证链路在 Windows 断（git clone/push 失败） | askpass 生成 `.cmd`（或 `GIT_ASKPASS_REQUIRE=force` 指向 exe）；ssh 命令参数化/加引号；`chmod` 改 `icacls` | M |
| P1-4 | `WORK_DIR` 缺省 `/data/vteam-worker` | `worker/src/config.ts:442` | 非管理员建不了 `C:\data`，且失败文案与 P0-1 撞车 | 平台缺省：`%LOCALAPPDATA%\vteam-worker`（用户级）或安装器显式写入；启动 preflight 做可写性探测 | S |
| P1-5 | 自更新链（`tar`/`npm ci`/`systemctl`） | `worker-updater.ts:533,579,935,625-632` | 更新在 Windows 上 reject（不一定落 `ready-manual`）；`dist.prev` 可能被吃掉，升级有变砖风险 | **首版 win32 禁用 updater**（心跳上报 `updateState=disabled` 或忽略指令）；二期接服务重启桥 + Node 侧解压/`npm.cmd` | M |
| P1-6 | `detectLocalIPv4` 虚拟网卡前缀表是 Linux 视角、大小写敏感 | `worker/src/config.ts:297-311` | 有 WSL/Hyper-V/Docker Desktop 时可能上报 `vEthernet` 的 172.x → 控制面「online 但派发 503」 | 安装器强制写 `WORKER_ADVERTISE_HOST`；代码侧补 `vethernet/wsl/vmware/virtualbox/hyper-v` + 优先有默认网关的网卡 | S |
| P1-7 | 执行端点 `listen('0.0.0.0')` + Windows 防火墙默认 deny 入站 | `worker/src/exec/exec-server.ts:797` | 注册/心跳全绿，但派发 100% 503（症状与 P1-6 相同） | 安装器加 `New-NetFirewallRule -Direction Inbound -Protocol TCP -LocalPort 4198`；文档写「Windows 排障第一步」 | S |
| P1-8 | 隔离域只重定向 `HOME`/`XDG_*` | `worker/src/config.ts:153-157,237`、`opencode-server.ts` env 构建 | 实测 XDG 生效但 `HOME` 不被使用 → `global.home` 系（`<USERPROFILE>\.agents`、`.claude`）仍进作用域 | spawn env 补 `OPENCODE_TEST_HOME=<iso>/home`（上游 `global.home` 取该变量），并复核 `%ProgramData%\opencode` 抑制 | S |
| P1-9 | 服务化/安装脚本缺失 | 仓库只有 `Dockerfile` + `worker/scripts/start.sh` | 无 `.ps1`、无服务注册、无开机自启 | 见 §4（新增 `install-worker.ps1` / `start-worker.ps1` / WinSW XML） | M |

### 3.3 P2（可接受/文档说明，或顺手修）

- `chmod 0o600` 在 Windows 是 no-op（凭据/`.env` 只靠继承 ACL）→ 安装器 `icacls /inheritance:r`。
- `/file?path=` **无目录白名单** + Windows 设备名/命名管道（`CON`、`\\.\pipe\...`）可阻塞 handler → 建议加白名单（**安全项**，且若服务以 LocalSystem 跑会被放大）。
- 长路径（>260）需 `LongPathsEnabled`；`fs.rename` 覆盖有占用窗口；`engines.node` 建议收敛到单一 LTS。
- CRLF / 编码：已确认无问题（渲染产物统一 `\n`、行解析已处理 `\r\n`、`tsc` 平台无关）。
- `getWorkerImage` 只认 POSIX 绝对路径（`server/src/workers/workers.controller.ts:167-173`）→ Windows worker 的截图预览永远 400；放宽为「POSIX 或 `^[A-Za-z]:[\\/]`」，仍禁 NUL/限扩展名。
- 既有隐患（与 Windows 无关但会咬到裸机安装）：`install-worker.sh:187` 从 `SERVER_URL` 推导发布包 URL，而 tarball 实际只在 **web origin**（`web/middleware.ts:99` 只代理 `/api/v1`、`/uploads`）→ compose 双端口（13000/13001）下裸机安装会 404。写 PS1 时别继承这个写法，改用 web origin 或 `--src-url`。

---

## 4. 推荐方案（Windows 原生）

### 4.1 目标形态与前提

- OS：Windows 10 1809+ / Windows 11 / Windows Server 2019+，x64（arm64 后置）。
- 权限：安装需**管理员**（服务注册 + 防火墙）；运行时用**专用低权账户**（不建议 LocalSystem，见 §4.7）。
- 引擎：只 opencode（`WORKER_ENGINE=opencode`，锁 `@opencode/cli@2.0.32` 或经安装器自检通过的同族 v2）。
- 网络：控制面 → `<worker 主机>:4198` 可达；worker → 控制面 `SERVER_URL` 出站可达。

### 4.2 安装器（`install-worker.ps1` + `install-worker.cmd`）

流程（对齐 `install-worker.sh` 的语义，逐步骤都有 Windows 等价物）：

1. 参数：`-Server` / `-WorkerId` / `-Concurrency` / `-Token`（或 `-TokenFile`，交互式默认 `Read-Host -AsSecureString`，避免落 PSReadLine 历史）/ `-AdvertiseHost` / `-McpUrl` / `-Dir` / `-NoService` / `-Opencode <ver>` / `-SrcUrl`。
2. ExecutionPolicy：`powershell -NoProfile -ExecutionPolicy Bypass -File`（进程级，不改机器策略）；脚本不 `irm|iex`。
3. 下载：`curl.exe` 优先（Win10 1803+ 自带），回退 `Invoke-WebRequest -UseBasicParsing`；TLS1.2 显式开启；发布包走 **web origin**（不要继承 `SERVER_URL` 推导）。
4. Node：下载官方 `node-v22.x-win-x64.zip` → `Expand-Archive` 到 `<install>\node`（**无需管理员**），`$env:PATH` 前置；`npm.cmd` 与 `node.exe` 同目录（不是 `bin/`）。
5. opencode：`npm.cmd install -g --prefix <install>\npm-global @opencode/cli@2.0.32`；装完**立即自检** `& <bin>\opencode.cmd --version`（或直接跑 exe `--version`），失败硬失败；把解析出的 `opencode.exe` 绝对路径写进 `.env` 的 `OPENCODE_BIN`。
6. 隔离环境：npm 安装与首次启动都注入 `OPENCODE_ISOLATION_ROOT` / `XDG_*` / `OPENCODE_TEST_HOME`（避免 postinstall 把文件写进 `%USERPROFILE%\.config|.local\share`，实测已观察到这两个目录被 npm 安装步骤创建）。
7. 发布包：`curl.exe` 下载 `worker-src.tar.gz` → `tar.exe -xzf ... -C <install>\app`（实测可用）；`dist\index.js` 存在性校验。
8. `npm.cmd ci --omit=dev`（离线机器用 `-Offline` + 发布包自带 `node_modules`）。
9. `.env` 生成（UTF-8 **无 BOM**，CRLF 统一；先删旧键再追加，未传参保留旧值；密钥加引号转义）：`SERVER_URL`、`X_WORKER_TOKEN`、`WORKER_ID`、`WORKER_ENGINE=opencode`、`OPENCODE_BIN`、`OPENCODE_SERVER_PASSWORD`（随机 32B hex，只提示「已写入」，不回显）、`WORKER_EXEC_PORT=4198`、`WORKER_MAX_INSTANCES`、`WORKER_MCP_URL`、`WORKER_ADVERTISE_HOST`、`WORK_DIR`、`OPENCODE_ISOLATION_ROOT`、`OPENCODE_TEST_HOME`。
10. 权限：`icacls .env /inheritance:r /grant:r "<运行账户>:(F)" "SYSTEM:(F)" "BUILTIN\Administrators:(F)"`（ProgramData 默认 `Users:(RX)`，不收继承=所有本地用户可读 token）。
11. 服务：渲染 WinSW XML（见 §4.4）→ `winsw install` + `start` → 2–5s 后 `Get-Service` 校验 + 日志尾部。
12. 防火墙：`New-NetFirewallRule -DisplayName 'vteam-worker-exec' -Direction Inbound -Protocol TCP -LocalPort 4198 -Action Allow -Profile Domain,Private`。
13. 自检（4 步，失败即硬失败）：① 服务 Running/Automatic；② 本机 `4198` 监听；③ 本机带 token 探测执行端点（401/403 也算通；200/业务错误都不阻断）；④ 日志出现「注册成功」+ 控制面列表可见。
14. 幂等：重跑即升级/修复；`-NoService` 前台模式便于排障；产出 `uninstall-worker.ps1`（停删服务、删防火墙规则、默认保留 `work\`/`data\`，`-PurgeData` 才全删）。

### 4.3 目录布局（推荐机器级 + 专用账户）

```
C:\ProgramData\vteam-worker\        # 安装根（服务账户可写；ACL 收紧）
├─ app\           # worker 发布包（dist/、package.json、scripts/start.ps1、.env.example）
├─ node\          # 便携 Node 22（node.exe / npm.cmd）
├─ npm-global\    # 全局 opencode（bin\opencode.exe 213MB + shims）
├─ conf\.env      # 服务配置（ACL：仅运行账户/SYSTEM/Administrators）
├─ work\          # WORK_DIR（agent 工作区/仓库/产物）
├─ data\          # OPENCODE_ISOLATION_ROOT（home/config/data/state/cache）
├─ logs\          # WinSW 滚动日志 + worker stdout/stderr
└─ bin\winsw.exe  # 服务包装器（离线随包）
```

无管理员场景（企业办公机）：`%LOCALAPPDATA%\vteam-worker` + 登录自启（计划任务 `-AtLogOn`），不注册系统服务，功能可用但不满足「开机即上线」。

### 4.4 服务化（WinSW XML 骨架）

```xml
<service>
  <id>vteam-worker</id>
  <name>vteam AI worker</name>
  <description>vteam worker (workerId=${WORKER_ID})</description>
  <executable>%BASE%\node\node.exe</executable>
  <arguments>"%BASE%\app\dist\index.js"</arguments>
  <workingdirectory>%BASE%\app</workingdirectory>
  <env name="PATH" value="%BASE%\node;%BASE%\npm-global;%PATH%"/>
  <!-- 关键：.env 由 start-worker.ps1 解析，或 node --env-file（Node>=20.6） -->
  <env name="VT_WORKER_HOME" value="%BASE%"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="20 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>%BASE%\logs</logpath>
  <log mode="roll-by-size-time"><sizeThreshold>10240</sizeThreshold><pattern>yyyyMMdd</pattern></log>
  <stoptimeout>15 sec</stoptimeout>
  <prestop>%BASE%\node\node.exe "%BASE%\app\scripts\stop-hook.js"</prestop>
</service>
```

选型说明：
- **WinSW 2.12（.NET Framework 4.6.1 版）**：Win10/11/Server2019+ 默认自带 .NET Framework，**零额外运行时依赖**，单 exe 离线可分发；`onfailure` 崩溃重启、日志滚动、`prestop` 钩子齐全。WinSW 3.x（.NET 6/8）需额外运行时或选 self-contained 包，体积/兼容性需在目标机确认。
- **NSSM 2.24** 备选：stop 会先发 Ctrl+C（Node 的 `SIGINT` handler 可达 → 有机会优雅退出），但项目自 2014 停更，仅作兜底。
- `sc.exe create` 直挂 `node.exe` **不可行**（进程不实现 SCM 回调，启动报 1053）；`sc failure` 只能给已有服务配恢复动作。

### 4.5 控制面/UI 改动（最小）

- 静态资源：`web/public/install-worker.ps1` + `install-worker.cmd`（`web/Dockerfile:41` 整目录 COPY，无需改 Dockerfile/CI）。
- 安装页：`web/app/(main)/workers/install/page.tsx` 增加第 3 个 Tab「Windows（PowerShell）」：
  - `type InstallMethod`（`:56`）、`methods` 数组（`:418-421`）、Tab 网格 `1fr 1fr` → 3 列（`:669`）、命令生成（`:379-389`）、标题（`:736`）；
  - 命令模板：`powershell -NoProfile -ExecutionPolicy Bypass -File install-worker.ps1 -Server <serverUrl> -WorkerId <id> -Concurrency <n> -Token <token> -AdvertiseHost <ip>`；
  - 复用现有 `data-testid`（默认仍选中 curl，避免 e2e `pages.spec.ts:550-575` 断言失效；如新增 testid 需同步 `web/e2e/reference/testids.ts`）。
- 协议：**不改**。可选（二期）新增 `capabilities.platform/os/arch`：旧 server 不会 400（`server/src/main.ts:95-101` `forbidNonWhitelisted:false`），但**必须同步** `workers.service.ts:1184-1212` 的列表摘要 SQL `JSON_EXTRACT`，否则列表页永远看不到平台（最容易漏的一步）；混合池调度若要按平台过滤，还需先有「需求生产者」（当前 `engine` 字段没有任何生产调用方）。
- 文档：`docs/deployment.md` 的 §4.4.1/§8.1.1 假设 systemd，需补 Windows 分支；**自更新在 docs 里目前完全没有章节**，补一节「Windows 升级=重跑安装器」。

### 4.6 发布物与升级

- 发布物：沿用 `worker-src.tar.gz`（`tar.exe` 实测可解）+ `worker-src.version.json`（sha256 不变）；`worker-src.zip` 仅当要支持 Win Server 2016 等无 `tar.exe` 的系统时再加（二期）。
- 升级（首版）：重跑 `install-worker.ps1`（幂等；停服务→替换 dist→重启→自检）。自更新在 win32 默认关闭（避免 §3.2 P1-5 的「假对齐/变砖」）。
- 升级（二期）：worker 侧增加「服务重启桥」——安装器写 `WORKER_SERVICE_RESTART_COMMAND`（如 `sc.exe stop vteam-worker & sc.exe start vteam-worker` 或 `restart-worker.ps1`），worker 在 ready-manual 时**自己调用**；insist 不由控制面下发命令字符串（避免 RCE 面）。

### 4.7 安全边界（必须写进方案，否则 Windows 会放大风险）

1. **不要用 LocalSystem**：`/file?path=` 端点目前**无目录白名单**（`exec-server.ts` 的 `/file` handler），以 LocalSystem 运行 = 持有 token 即可读整机文件。用**专用本地账户**（如 `vteam-worker`，只授安装目录/工作目录权限）或至少给 `/file` 加白名单。
2. `.env`/`auth.json` 的 `chmod` 在 Windows 无效 → 必须 `icacls /inheritance:r`；否则 ProgramData 下所有本地用户可读 token/密钥。
3. 只放行 4198 入站；`opencode serve` 继续绑 `127.0.0.1`（不要为「让控制面连 serve」开端口——v2 不需要）。
4. 企业环境：213MB 未签名 `opencode.exe` + agent 自动执行代码 → Defender/EDR/应用白名单可能拦截；安装器需给出「EDR 拦截时如何排查/加白」的文档，并在发布流程考虑代码签名。
5. 遵守「不引入控制面→本机命令执行」的既有边界（自更新重启桥只能由 worker 侧读取本地配置执行）。

### 4.8 备选路径（今天就能用，零代码）

**Docker Desktop（WSL2 后端）跑现有 Linux worker 镜像**：镜像 linux/amd64 零改造可用，适合「先让 Windows 机器贡献算力」的短期诉求。注意：
- 命令要改成 PowerShell 语法：`$(openssl rand -hex 32)` 在 PowerShell 不可用，先 `$pw = -join (...)` 再 `-e OPENCODE_SERVER_PASSWORD=$pw`；`SERVER_URL` 用 `http://host.docker.internal:13000`（或控制面 LAN 地址）；`--advertise-host` 必须填**宿主机 LAN IP**（不能用容器 IP/host.docker.internal）。
- Windows Server 不支持 Docker Desktop → 服务器场景只能原生安装或 Linux VM。
- 长期方案仍是原生安装（资源占用、WSL2 依赖、端口/网络复杂度）。

---

## 5. 分阶段落地计划

### 阶段 M0：能起来 + 接一个任务（≈2 人日 + 0.5 天真机）

| 任务 | 产出 | 验收 |
|------|------|------|
| CLI 解析平台化（P0-1） | `resolveCliCommand()` + 8 调用点 + `OPENCODE_BIN` | Windows 上 `node dist/index.js` 起 serve、`/api/info` 200、`opencodeVersion` 不再是 `unknown` |
| kill 树（P1-1） | win32 `taskkill /T /F` | 重启 serve 后任务管理器无残留；退出后无孤儿 |
| `WORK_DIR` 平台缺省 + 可写性 preflight（P1-4） | 缺省 `%LOCALAPPDATA%\vteam-worker`（服务模式由安装器覆盖） | 非管理员也能起；失败文案可操作 |
| 网卡探测 + advertise（P1-6） | 前缀表补 Windows + 默认网关优先 | 多网卡机上报地址 = 控制面可达地址 |
| 防火墙文档/脚本（P1-7） | 安装器加规则 + 排障文档 | 另一台机器 `Test-NetConnection <ip> 4198` 通 |
| 真机验收 | 控制面注册 → 派单轮任务 → 事件回流全通 | 状态 online、任务跑完、控制面无 503 |

### 阶段 M1：装得上、停电自愈、可卸载（≈2–3 人日）

`install-worker.ps1`/`.cmd`、`start-worker.ps1`、`stop-worker.ps1`、`uninstall-worker.ps1`、WinSW XML、`.env`/ACL/防火墙/自检、安装页 Windows Tab + e2e 同步、文档章节。
验收：全新 Win10/11 机器一条命令装完 → 服务自启（重启机器后自动回来）→ 控制面在线 → 卸载干净。

### 阶段 M2：功能对齐（≈3–5 人日，可与 M1 并行部分）

git 凭证（askpass `.cmd` / ssh 路径）、`/secret-command` shell 抽象、`OPENCODE_TEST_HOME` 隔离补齐、`/file` 白名单、自更新桥（或明确关闭）、Windows CI（`windows-latest` 跑 typecheck + 平台跳过后的 jest 子集 + smoke workflow 入库）、可选 `capabilities.platform`/混合池维度。
验收：私有库 clone/push 成功；图片预览可用；更新走安装器/服务重启；CI 对 Windows 回归有门禁。

### 验收总表（真机，桌面机）

1. 全新 Win10/11：一条命令安装成功（含 Node/opencode 自举、服务注册、防火墙）。
2. 重启机器 → 服务自动 Running → 控制面 online（30s 内）。
3. 派 1 个「读文件 + 改文件 + git 提交」任务 → 成功；日志无 ENOENT/503。
4. 派 1 个「跑 npm test」任务 → 记录成功率（用于决定 Windows worker 的任务池定位）。
5. 停服/重启/升级/卸载：无残留进程、无端口占用、无孤儿服务。
6. 安全：非管理员账户读不到 `.env`/`auth.json`；`/file` 越权路径被拒。

---

## 6. 风险与未验证项（按重要性）

| # | 风险/未知 | 影响 | 建议 |
|---|-----------|------|------|
| X1 | Agent 任务在原生 Windows 的 shell 兼容性（bash/`/tmp`/`chmod`/路径） | 高：worker 在线但任务失败率高 | 真机任务级 smoke（§5 验收 4）；装 Git Bash；必要时限定任务池 |
| X2 | opencode npm 渠道官方不承诺 Windows（docs 原文） | 中：升级 opencode 版本可能突然不兼容 | 安装器装完自检（version+serve+`/api/info`）；锁版；Windows 侧固定版本升级需人工验证 |
| X3 | WinSW/NSSM 与目标机 .NET/EDR/组策略的兼容性 | 中：服务起不来或被杀软拦 | 桌面真机验证；WinSW 2.12（Framework）优先；准备 NSSM 备选 |
| X4 | 防火墙/Windows 安全中心交互弹窗（首次监听 4198） | 中：无人值守安装可能被弹窗阻塞 | 安装器先加防火墙规则；文档说明 |
| X5 | 长路径 / `%ProgramData%` ACL / 多用户 | 低中：部署后偶发权限/路径问题 | 文档约束 + 安装器自检 |
| X6 | `OPENCODE_TEST_HOME` 属测试语义变量，长期是否稳定 | 低中：隔离不全 | 桌面真机验证 `<USERPROFILE>\.agents` 是否仍被读；必要时在安装/启动脚本清理 |
| X7 | WinNAT/Hyper-V 保留端口段与 4198/4199 冲突 | 低：端口绑不上 | 安装器探测 + `netsh int ipv4 show excludedportrange` 排障 |
| X8 | Windows Server 场景（无 Docker Desktop、无桌面会话） | — | 本次未验证；如需支持，另立小项（服务账户/无交互/计划任务差异） |

---

## 7. 附：证据与复现

- 真机探针输出：`[.design/windows-worker/ci-evidence/windows-smoke-probe.log](../.design/windows-worker/ci-evidence/windows-smoke-probe.log)`、`[...json](../.design/windows-worker/ci-evidence/windows-smoke-probe.json)`
- worker 真机日志：`[.../worker-standalone.log](../.design/windows-worker/ci-evidence/worker-standalone.log)`（起服务到失败）、`[.../worker-standalone.err.log](../.design/windows-worker/ci-evidence/worker-standalone.err.log)`（`spawn opencode ENOENT`）、`[.../worker-jest.log](../.design/windows-worker/ci-evidence/worker-jest.log)`（63 failed/1447 明细）
- 复现方法：把 `ci-evidence/windows-worker-smoke.yml` 放进 `.github/workflows/`（仅 `workflow_dispatch` 或临时分支 `push` 触发），`scripts/ci/windows-smoke-probe.mjs` 放 `scripts/ci/`，在仓库 Actions 页手动跑即可；跑完删除分支/run。桌面机可用等价 PowerShell 步骤手工跑探针脚本（`node windows-smoke-probe.mjs`）。
- 关键代码索引：见 §3 各表「证据」列；安装器逐步骤对照见 [installer 笔记 §1](../.design/windows-worker/notes-installer-service.md)；引擎/npm 元数据证据见 [engine 笔记](../.design/windows-worker/notes-engine-support.md)。

---

## 8. M0 实现进度（worktree feat/windows-worker-native）

> **本节由实现分支追加**（分支 `feat/windows-worker-native`，worktree `.worktrees/windows-worker-native`，2026-11-13）。
> §0–§7 是立项/可行性阶段的结论与设计（其中「真机验证」= GitHub Actions `windows-latest`，验证的是**上游 opencode 与本仓旧 worker 的失败点**）。
> 本节只记录 **M0 已落地的代码/文档改动**及其验证状态：**本仓库的 Windows 改动尚未在 Windows 真机验证**，下表的「真机复验」列才是验收依据。
>
> 说明：本文件从主工作区（当时未跟踪）复制进实现分支；文首的 `.design/windows-worker/*` 审计底稿仍只在主工作区工作树（未入库），在 worktree 内访问这些链接可能 404，以主工作区为准。

### 8.1 改动文件与验证状态

| 文件 / 改动 | 已在 macOS 上验证（tsc/jest） | 需 Windows 真机复验 |
|---|---|---|
| `worker/src/runtime/cli-command.ts`（新增） | `cli-command.spec.ts` 通过 | `OPENCODE_BIN` 指向 `.cmd` 与 `.exe` 两种形态都能拉起 serve；`where.exe` 解析跳过无扩展名 shim；路径含空格/中文 |
| `worker/src/runtime/process-tree.ts`（新增） | `process-tree.spec.ts` 通过 | `taskkill /PID <pid> /T /F` 能清掉 `cmd.exe → opencode serve` 整棵树；失败路径有可见日志（不再静默） |
| `worker/src/runtime/opencode-server.ts` | `opencode-server.spec.ts` 通过（spawn/清理改走 helper） | 起 serve + 重启/退出后无残留 `opencode.exe`；win32 下不依赖 `kill(-pid)` |
| `worker/src/config.ts` | `config.spec.ts` 通过（`defaultWorkDir` / `assertEngineSupported` / `detectLocalIPv4`） | 缺省 `WORK_DIR` 落在 `%LOCALAPPDATA%\vteam-worker`；`WORKER_ENGINE=dsh` 启动即报错且文案可操作；装 WSL/Hyper-V/Docker Desktop 的机器上探测选中物理网卡 |
| `worker/src/index.ts` | `index.spec.ts`、`ensure-work-dir.spec.ts` 通过 | `WORK_DIR` 不可写时启动即报可操作错误；版本探测与 serve 同源解析 |
| `worker/src/exec/sensitive-command.ts` | `sensitive-command.platform.spec.ts` 通过 | `/secret-command` 模板按 **cmd 语法**执行（`&&`/`%VAR%`），POSIX 引号写法不能照搬；超时/取消能 `taskkill /T /F` 清干净 |
| `worker/src/git/git-tools.ts` | `git-tools.spec.ts` 通过 | win32 askpass `.cmd` + `GIT_ASKPASS_REQUIRE=force` 生效；`GIT_SSH_COMMAND` 的引号/正斜杠路径可用；私有库 `clone`/`push` 成功 |
| `worker/src/driver/dsh-rpc-client.ts` | `dsh-rpc-client.spawn-error.spec.ts` 通过 | 不涉及（win32 已在 config 层拒绝 dsh）；POSIX 侧回归确认 spawn 失败不再崩进程 |
| `worker/src/update/worker-updater.ts` | `worker-updater.spec.ts` 通过 | `update-worker` 指令在 win32 落 `ready-manual`、**不覆盖 dist**；`WORKER_WINDOWS_SELF_UPDATE=1` 才放开（逃生开关） |
| `worker/README.md` | 文档（无编译产物）；新增「Windows（原生，预览）」章节 + 目录结构补 `scripts/windows/` | 按章节从零装一遍（Node → npm 装 opencode → `OPENCODE_BIN` → 防火墙 → 起服务） |
| `worker/.env.example` | 文档；补 `OPENCODE_BIN`、Windows `WORK_DIR` 缺省、`WORKER_ADVERTISE_HOST` 多网卡说明、`WORKER_WINDOWS_SELF_UPDATE` | 照注释填 `.env` 能直接起来；无 BOM |
| `worker/scripts/windows/enable-firewall.ps1`（新增） | 无（本机 macOS 无 PowerShell，脚本按 PS 5.1 语法人工审读） | 管理员/非管理员两种身份行为；`-WhatIf` 零副作用；重复执行幂等；`-Port`/`-Profile` 生效；read-back 校验通过；`Remove-NetFirewallRule` 可回滚 |
| `worker/scripts/windows/README.md`（新增） | 文档 | 服务化两条路（WinSW 2.12 / NSSM 2.24）在真机各装一遍；卸载清单逐项验证 |
| `docs/windows-worker-feasibility.md` | 本文件（新增本节） | — |

### 8.2 macOS 自测快照（2026-11-13，追加本节时）

已执行（worktree `feat/windows-worker-native`，macOS）：

```bash
cd worker

# 类型检查：通过（无输出）
npx tsc --noEmit

# Windows 相关定向用例：7 suites / 166 tests 全绿
npx jest --runInBand src/runtime/cli-command.spec.ts src/runtime/process-tree.spec.ts \
  src/config.spec.ts src/git/git-tools.spec.ts src/exec/sensitive-command.platform.spec.ts \
  src/driver/dsh-rpc-client.spawn-error.spec.ts src/ensure-work-dir.spec.ts

# 运行面用例：3 suites / 210 tests 全绿（含 updater 的 win32 分支、opencode-server、index）
npx jest --runInBand src/update src/runtime/opencode-server.spec.ts src/index.spec.ts
```

未执行（非失败，只是不在本轮文档任务的验证范围）：

- 完整 `npx jest`（1400+ 用例，建议由 Lead 收口时跑一次全量）；
- `npm run build`（会写 `dist/`，避免干扰并行验证）；
- 任何 PowerShell（本机 macOS 无 `pwsh`）：`enable-firewall.ps1` 仅做语法人工审读。

> 上述结果来自追加本节时的快照；分支上仍有并行改动，**最终以合入前 Lead 的验证记录为准**。

### 8.2.1 Lead 收口验证（提交前，2026-11-13，worktree `feat/windows-worker-native`）

```bash
cd worker

# 类型检查：通过（无输出）
npx tsc --noEmit

# 全量单测：53 suites passed / 3 skipped；1509 tests passed / 8 skipped
npm test
```

结论：本轮改动在 macOS 上 **tsc + 全量 jest 全绿**；Windows 真机行为（cmd 引号、taskkill、askpass、服务化、防火墙）仍按 §8.3 清单验收——**不要把「macOS 测试全绿」当成 Windows 可用**。

### 8.3 Windows 真机复验清单（按优先级，验收总表见 §5）

> 真机验收可直接触发仓库的 **`.github/workflows/windows-worker-smoke.yml`**（手动 `workflow_dispatch`）：
> 它会在 `windows-latest` 上安装 opencode、跑平台无关单测、断言 `WORK_DIR` 缺省 / dsh 拒绝 /
> cmd 包装，并真实启动 worker（`OPENCODE_BIN` → spawn serve → Basic Auth `/api/info` 200 → 无 spawn 失败）。
> 通过该 workflow 即视为 M0 的「起得来」验收项通过；其余清单项仍需在目标桌面机/服务器上验证。

1. **起得来**：全新 Win10/11 + Node 22 + `@opencode/cli@2.0.32`，设 `OPENCODE_BIN` → `node --env-file=.env dist\index.js` 到日志出现「注册成功」，且 `/api/info` 带 Basic Auth 返回 200。
2. **能派单**：控制面机器上 `Test-NetConnection <worker IP> -Port 4198` 通 → 派 1 个「读文件 + 改文件」任务成功，事件回流完整。
3. **清理**：重启 serve / 停进程后任务管理器无残留 `opencode.exe`；`taskkill /T /F` 路径有日志可查。
4. **隔离**：`<USERPROFILE>\.agents` 等 `global.home` 系路径是否仍被读（§6 X6 未决项）。
5. **服务化**：WinSW 2.12 的 install/start/stop/uninstall 全流程；重点看 stop 后是否残留 opencode 子进程（决定是否切 WinSW 3.x `<prestop>` 或 NSSM）。
6. **防火墙脚本**：`-WhatIf` 无副作用；重复执行幂等；`-Port` 改动与 `Remove-NetFirewallRule -Name 'vteam-worker-exec'` 回滚。
7. **git 凭证**：私有库 `clone`/`push`（askpass `.cmd` + SSH key 路径含空格）。
8. **dsh 拒绝**：`WORKER_ENGINE=dsh` 在 Windows 启动即报错且文案指明「首版只支持 opencode」。
9. **升级**：替换 `dist`/`app` 后重启 → 控制面 `codeVersion` 对齐；确认默认不执行自更新。
10. **可选**：`WORKER_WINDOWS_SELF_UPDATE=1` 才有 updater 行为（自备重启桥，风险自负）。

### 8.4 本轮明确不做（边界）

- `install-worker.ps1` / `install-worker.cmd` / `uninstall-worker.ps1` / `start-worker.ps1` 等安装器资产、安装页 Windows Tab、`worker-src.zip`、`capabilities.platform` —— 属 M1/二期，本轮未改。
- `docs/deployment.md` 的 Windows 章节未在本分支补；本轮 Windows 文档只落在 `worker/README.md`、`worker/.env.example`、`worker/scripts/windows/README.md` 与本文件。
- 控制面协议/调度**零改动**（§4.5 已论证不需要改）。

---

## 9. M1 实现进度（Windows 安装器 + 服务化 + 安装入口）

> 本节由实现分支追加（分支 `feat/windows-worker-native`，2026-11-13）。M0 见 §8。
> **M1 全部脚本为预览：未在 Windows 真机执行**；macOS 上能验证的只有类型检查/单测/静态语法与契约一致性。

### 9.1 交付物

| 文件 | 作用 | 验证状态 |
|---|---|---|
| `web/public/install-worker.ps1`（2249 行） | 一键安装器（控制面 web 静态分发）：前置检查 → 目录布局 → 便携 Node（3 镜像 + SHASUMS256）→ npm 全局 opencode（v2 闸门 + `OPENCODE_BIN`）→ 下载发布包（可选 `-SrcSha256`）→ 调 `stop-worker.ps1` 停旧实例 → `tar.exe` 解包 → `npm ci --omit=dev` → 写 `.env`（无 BOM/保留旧键/密钥转义）+ `icacls` → 防火墙 → 服务化（WinSW 2.12 主选 / 计划任务回退）→ 自检 | 静态：tree-sitter PowerShell 解析 0 error、括号/here-string 平衡、参数/调用一致性、WinSW XML well-formed、`.env` 与 `start-worker.ps1` 解析器 round-trip；**未真机执行** |
| `web/public/install-worker.cmd` | 薄包装：定位同目录 ps1 + `powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*`；不自动提权 | 静态（cmd 语法人工审查） |
| `worker/scripts/windows/start-worker.ps1` | 前台启动/排障：自解析 `.env`（BOM/UTF-16 报错、引号/转义/行尾注释/CRLF/LF）→ 校验 token/引擎/`OPENCODE_BIN`/node/dist → 建目录 → `Start-Process -PassThru` 跑 node，写 `run\worker.pid`、退出码透传；`-DryRun` 只校验 | 静态；**未真机执行** |
| `worker/scripts/windows/stop-worker.ps1` | 停止：`sc stop`（含 StopPending 超时兜底）→ 计划任务 → `run\worker.pid` `taskkill /T /F` → 命令行兜底（node.exe + 安装根前缀 + `dist\index.js`）→ 清理父进程命中/路径在安装根下的 `opencode.exe` 残留；`-WhatIf`/幂等/退出码 | 静态；**未真机执行** |
| `worker/scripts/windows/uninstall-worker.ps1` | 卸载：调 stop → WinSW uninstall（回退 `sc delete`）→ 删计划任务 → 删防火墙规则 → `-PurgeData` 前做安全校验（非盘根/含安装特征）否则保留 `work\`/`data\`/`.env` | 静态；**未真机执行** |
| `web/app/(main)/workers/install/page.tsx` | 安装向导新增第 3 个 Tab「Windows PowerShell」：生成「下载 ps1 + `-File` 执行」两条命令（`-Server/-SrcUrl/-WorkerId/-Concurrency/-Token/-AdvertiseHost/-McpUrl`），切到该 Tab 强制 opencode 引擎、dsh 置灰，附管理员/未验证/卸载提示 | `npx tsc --noEmit` ✅、`npx eslint` ✅；浏览器渲染/复制待 e2e |
| `web/e2e/pages.spec.ts` | install 页断言补 Windows Tab 联动（命令含 `install-worker.ps1` 与 `-SrcUrl`） | 未跑 Playwright（需完整栈）；tsc 覆盖 |
| `docs/deployment.md` §8.1.2 | Windows worker 安装章节：前置/一键命令/手工路径/目录布局/服务化/防火墙/升级卸载/排障/与 Linux 差异 | 文档 |
| `worker/README.md` / `worker/scripts/windows/README.md` | 一键安装入口、参数、脚本说明、编码约定（`.ps1` UTF-8 BOM、`.cmd` ANSI） | 文档 |

另：M0 的 `enable-firewall.ps1` 与三个新 `.ps1` 已统一转为 **UTF-8 带 BOM**（Windows PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 解码，中文提示会乱码；带 BOM 才能 5.1/7 双兼容）。

### 9.2 关键接口契约（后续改动不要破坏）

- 安装页命令参数名固定：`-Server -SrcUrl -WorkerId -Concurrency -Token [-AdvertiseHost] [-McpUrl]`；`-SrcUrl` 指向 **web origin**（`worker-src.tar.gz` 由 web 静态服务提供，集群内 server 与 web 可能不同源）。
- 安装根布局：`<dir>\{node,npm-global,app,work,data,logs,bin,run}`；`.env` 在 `<dir>\app\.env`；pid 文件 `<dir>\run\worker.pid`。
- 服务名/任务名固定 `vteam-worker`；WinSW 包装器 `<dir>\bin\vteam-worker-service.exe`；防火墙规则名 `vteam-worker-exec`；执行端点 `4198`。
- 服务/计划任务模式用 `node --env-file` 加载 `.env` ⇒ 要求 Node ≥ 20.6（安装器自举 v22.12.0 满足）；`-NoService` 前台走 `start-worker.ps1` 自解析，可用更旧 Node。
- 卸载/停止只在一个地方实现（`stop-worker.ps1` / `uninstall-worker.ps1`），安装器不重复实现。

### 9.3 macOS 上的最终验证（提交前）

```bash
cd worker && npx tsc --noEmit && npm test     # 53 suites / 1509 tests 通过（3 suites / 8 tests 原有 skip）
cd web && npx tsc --noEmit && npx eslint "app/(main)/workers/install/page.tsx" "e2e/pages.spec.ts"   # 均通过
```

### 9.4 Windows 真机验收清单（M1，按优先级）

1. 全新 Win10/11 + 管理员 PowerShell：跑安装页生成的命令 → 安装器完成（Node/opencode/发布包/.env/服务/防火墙/自检）。
2. `Get-Service vteam-worker` Running + 重启机器后自动 Running + 控制面显示 online。
3. `Test-NetConnection <worker-ip> -Port 4198` 通；控制面派 1 个任务成功（事件回流完整）。
4. `stop-worker.ps1` / `start-worker.ps1` / `uninstall-worker.ps1` 三个脚本全流程；停止后无残留 `opencode.exe`、`run\worker.pid` 被清理。
5. WinSW 2.12 路径：`install/start/stop/uninstall` 与日志滚动；WinSW 不可得时计划任务回退（`AtStartup`/`SYSTEM`）可启动、重启恢复。
6. 升级：重跑安装器（`-Force`）→ 停旧实例、换 app、重启、自检；`work\`/`data\`/`.env` 保留。
7. 防火墙：`enable-firewall.ps1` 幂等/`-WhatIf`/回滚；端口不一致时报错可操作。
8. 非管理员：`-NoService -NoFirewall` 装到 `%LOCALAPPDATA%` 能前台跑；不带这两个开关时错误提示可操作。
9. 安装页 Windows Tab：命令复制、curl 缺省 Tab 不回归、Windows Tab 下 dsh 置灰；Playwright 断言通过。

### 9.5 本轮仍未做（M2 及以后）

- 平台维度（`capabilities.platform`）与混合池调度过滤；`/file` 路径白名单；`OPENCODE_TEST_HOME` 已由 M0.5 补进 serve 隔离 env（`buildIsolatedServeEnv`），真机需确认 `<USERPROFILE>\.agents` 不再被读。
- Windows CI 常驻 job（`ci.yml` windows 矩阵）；发布流水线产出 Windows 安装包/签名；`worker-src.zip` 双产物（Win Server 2016 等无 `tar.exe` 场景）。
- 安装器与服务脚本的真机修 bug 迭代（按 §9.4 结果）。
