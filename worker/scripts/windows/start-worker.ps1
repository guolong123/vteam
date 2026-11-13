<#
.SYNOPSIS
    vteam worker 的 Windows 前台启动器（替代 worker/scripts/start.sh；安装器、计划任务、运维手工排障共用）。

.DESCRIPTION
    为什么需要这个脚本，而不是直接 `node dist\index.js`：
      - Windows 上没有 `source .env` 可用（POSIX 的 `set -a; source .env` 在 PowerShell 里会踩 CRLF/BOM/
        引号/中文，还会被当成命令执行）⇒ 这里**手工解析** `<安装根>\app\.env` 再导出到本进程环境；
        只影响本进程与子进程，**不改系统环境变量**（安装器没有改 PATH 的约定，本脚本也不改）。
      - 把「启动即崩」的错误提前成一句可读中文：token 缺失/还是示例值、OPENCODE_BIN 指错、
        node 或 dist 不存在 —— 这些若留到 node 里，只会看到一串堆栈或 ENOENT。
      - 写 `<安装根>\run\worker.pid`（**真正的 node 进程 PID**，不是本脚本的 PID）：
        Windows 服务停止是 TerminateProcess 语义，node 收不到 SIGTERM、`shutdown()` 不执行，
        opencode serve 子进程可能残留；stop-worker.ps1 要靠这个 pid + `taskkill /T /F` 清干净。
        因此这里用 `Start-Process -PassThru` 拿到 node 的 PID，而不是 `$PID`（那是 PowerShell 自己）。

    与安装器/服务模式的衔接（约定，不要改）：
      - 安装根：<dir>\{node,npm-global,app,work,data,logs,bin,run}；配置：<dir>\app\.env；
        pid：<dir>\run\worker.pid；服务名：vteam-worker。
      - 安装器/计划任务调用方式：
        powershell -NoProfile -ExecutionPolicy Bypass -File <dir>\app\scripts\windows\start-worker.ps1 -InstallDir <dir>
      - 服务（WinSW）模式下推荐直接用 `node --env-file=<dir>\app\.env` 启动（少一层包装、日志由包装器接管）；
        本脚本作为 `-NoService` 前台模式、计划任务兜底、以及排障入口必须可用。

    为什么默认前台（阻塞）运行：服务包装器/计划任务都要监控「真正在跑的那个进程」；本脚本阻塞在
    node 上，包装器停它时 `taskkill /T` 才能连带清子进程；手工排障时也能直接看 stdout。

.PARAMETER InstallDir
    安装根，例如 `C:\ProgramData\vteam-worker`（其下应有 app\node\work\data\logs\bin\run）。
    缺省：从脚本自身位置向上找含 `app\` 子目录的目录（安装器把本脚本放在 <dir>\app\scripts\windows\，
    所以缺省能自动推断出 <dir>）。显式传时写法要点：路径含空格必须整体加引号。

.PARAMETER Foreground
    前台运行（**缺省即前台**，不需要传）。本脚本只支持前台语义：服务/计划任务都依赖「包装器能监控并
    杀进程树」；若要从别的脚本后台拉起 worker，请用 `Start-Process` 调本脚本，或用 WinSW 注册服务。
    显式传 -Foreground:$false 会直接报错，避免出现「脚本退出了但 node 没被托管」的半吊子状态。

.PARAMETER DryRun
    只做校验（安装根/.env/token/node/dist、目录、pid 冲突、端口占用），打印摘要后退出，不启动 node、
    也不创建目录。安装器自检、排障时先跑这个可以避免「起一半」。

.EXAMPLE
    # 安装器/计划任务用（显式安装根；路径含空格要引号）：
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\vteam-worker\app\scripts\windows\start-worker.ps1" -InstallDir "C:\ProgramData\vteam-worker"

.EXAMPLE
    # 手工排障：先只校验，不启动：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\start-worker.ps1 -InstallDir "C:\ProgramData\vteam-worker" -DryRun

.EXAMPLE
    # 前台启动（Ctrl+C 中断；node 会走 SIGINT 优雅退出，比服务 TerminateProcess 干净）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\start-worker.ps1 -InstallDir "C:\ProgramData\vteam-worker"

.NOTES
    执行方式：`powershell -NoProfile -ExecutionPolicy Bypass -File <本文件>`（进程级执行，不改机器 ExecutionPolicy）。
    停止/回滚：`stop-worker.ps1 -InstallDir <dir>`（本脚本退出时会删自己的 pid 文件；异常残留由 stop 兜底）。
    本脚本不修改系统环境变量 / PATH / ExecutionPolicy：.env 只导入当前进程，退出即失效。
    排障：退出码非 0 先看本控制台输出；服务模式看 <dir>\logs\ 下 WinSW/NSSM 的日志（worker 自己不写文件日志）。
    安全：不打印 X_WORKER_TOKEN / OPENCODE_SERVER_PASSWORD 的值（只打印是否已设置与长度）。
    验证状态：**未在 Windows 真机验证**（本仓库在 macOS 上开发，按 Windows PowerShell 5.1 语法编写）。
    真机验收重点：.env 带 BOM/CRLF/引号/中文值各来一份能否正确加载；dist 路径含空格能否启动；
    Ctrl+C 后 `run\worker.pid` 是否被清理；`stop-worker.ps1` 能否清掉 opencode 残留。
#>
[CmdletBinding()]
param(
    [string]$InstallDir = '',

    # 不写 `= $true` 默认值：switch 参数的缺省本就是 $false，这里用 IsPresent 区分
    # 「没传」和「显式传了 $false」，避免依赖 switch 默认值的解析细节（PS 5.1 上更稳）。
    [switch]$Foreground,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ── 0) 环境守卫 ───────────────────────────────────────────────────────────────
# 便携 node 布局、taskkill、Windows 服务都是 Windows 语义；在 macOS/Linux 上误跑要立刻说清楚。
if ($env:OS -ne 'Windows_NT') {
    throw ("本脚本只支持 Windows（当前不是 Windows 环境）。在 macOS/Linux 上请用 worker/scripts/start.sh。" +
        "（检测到 env:OS=$($env:OS)）")
}

if ($Foreground.IsPresent -and -not $Foreground) {
    throw ('本脚本只支持前台运行（-Foreground 缺省即前台）；服务/计划任务依赖“包装器监控并杀进程树”这一语义。' +
        '若要从脚本里后台拉起，请用 Start-Process 调用本脚本，或用 WinSW 注册服务（见 worker/scripts/windows/README.md §5）。')
}

# ── 1) 公共辅助函数 ───────────────────────────────────────────────────────────

# 统一成绝对路径 + 去掉尾部分隔符（保留 C:\ 这类根路径的 3 个字符）。
function Get-NormalizedPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
}

# 解析安装根：显式参数优先；否则从脚本位置向上找含 app\ 的目录（<dir>\app\scripts\windows\ → <dir>）。
function Resolve-InstallRoot([string]$ExplicitDir) {
    if (-not [string]::IsNullOrWhiteSpace($ExplicitDir)) {
        return Get-NormalizedPath -Path $ExplicitDir
    }
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw ('无法从脚本位置推断安装根（$PSScriptRoot 为空）。' +
            '请显式传 -InstallDir <安装根>，例如 -InstallDir C:\ProgramData\vteam-worker')
    }
    $dir = $PSScriptRoot
    while (-not [string]::IsNullOrWhiteSpace($dir)) {
        $appCandidate = Join-Path $dir 'app'
        if (Test-Path -LiteralPath $appCandidate -PathType Container) {
            return Get-NormalizedPath -Path $dir
        }
        $parent = Split-Path -Parent $dir
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $dir) { break }
        $dir = $parent
    }
    throw ("无法从脚本位置推断安装根：$PSScriptRoot 的上级目录里没有 app\ 子目录。" +
        '安装器/运维请显式传 -InstallDir <安装根>（其下应有 app\node\npm-global\work\data\logs\run\bin）。')
}

# 只解析 .env 的值，不执行任何内容（绝不 source/Invoke-Expression）。
# 支持：KEY=VALUE、# 注释、空行、值内的 =、双/单引号、双引号内 \\ \" \$ \` 转义、行尾注释、CRLF/LF。
function ConvertFrom-DotEnvValue([string]$RawValue, [string]$EnvPath, [int]$LineNo) {
    $v = $RawValue.Trim()
    if ($v.Length -eq 0) { return '' }

    $quote = $v[0]
    if ($quote -eq '"' -or $quote -eq "'") {
        $sb = New-Object System.Text.StringBuilder
        $i = 1
        $closed = $false
        while ($i -lt $v.Length) {
            $ch = $v[$i]
            # 双引号内只把 \\ \" \$ \` 当转义（与 bash 双引号语义对齐）；
            # 不把 \n \t 转义成换行/制表符，否则 Windows 路径（如 "C:\tools\..."）会被改坏。
            if ($quote -eq '"' -and $ch -eq '\' -and ($i + 1) -lt $v.Length) {
                $next = $v[$i + 1]
                if ($next -eq '\' -or $next -eq '"' -or $next -eq '$' -or $next -eq '`') {
                    [void]$sb.Append($next)
                    $i += 2
                    continue
                }
                [void]$sb.Append($ch)
                $i += 1
                continue
            }
            if ($ch -eq $quote) {
                $closed = $true
                $i += 1
                break
            }
            [void]$sb.Append($ch)
            $i += 1
        }
        if (-not $closed) {
            throw ("配置文件第 $LineNo 行解析失败（$EnvPath）：引号没有闭合。" +
                '值必须用成对引号包裹，且值内不能跨行。')
        }
        $rest = $v.Substring($i).Trim()
        if ($rest -ne '' -and -not $rest.StartsWith('#')) {
            throw ("配置文件第 $LineNo 行解析失败（$EnvPath）：结束引号后还有多余内容。" +
                '注释请写在引号后面并留空格（KEY="值" # 注释）。')
        }
        return $sb.ToString()
    }

    # 未加引号：允许行尾注释（要求 # 前有空白，避免把 URL 里的 # 当注释）。
    $m = [regex]::Match($v, '\s+#')
    if ($m.Success) { $v = $v.Substring(0, $m.Index) }
    return $v.TrimEnd()
}

# 读取 .env 为 key→value 的哈希表。为什么先读字节：必须在解码前发现 BOM，
# 并给出可操作的修复指引（PS 5.1 的 Out-File/Set-Content -Encoding utf8 会写 BOM）。
function Read-DotEnvFile([string]$EnvPath) {
    if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
        throw ("缺少配置文件：$EnvPath" +
            '。安装器应已生成；也可从 app\.env.example 复制为 app\.env 后填写（见 worker/scripts/windows/README.md §2）。')
    }

    $bytes = $null
    try {
        $bytes = [System.IO.File]::ReadAllBytes($EnvPath)
    }
    catch {
        throw ("读取配置文件失败：$EnvPath（$($_.Exception.Message)）。" +
            '若 .env 已按 README §2.3 用 icacls 收紧权限，请以运行账户或管理员身份运行本脚本。')
    }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw ("配置文件带 UTF-8 BOM（EF BB BF）：$EnvPath" +
            '。BOM 会让首行键名变成「<BOM>X_WORKER_TOKEN」⇒ token 读不到、启动 fail-fast。' +
            '请用 UTF-8 无 BOM 重写该文件（PowerShell：Get-Content -Raw 读出后 [System.IO.File]::WriteAllText + UTF8Encoding($false)，见 README §2.4）。')
    }
    if ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) {
        throw "配置文件是 UTF-16 编码（带 BOM）：$EnvPath。请另存为 UTF-8 无 BOM（见 README §2.4）。"
    }

    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $map = @{}
    $lineNo = 0
    foreach ($line in ($text -split "\r\n|\n|\r")) {
        $lineNo++
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        # 兼容 Linux 侧习惯的 `export KEY=VALUE`（安装器生成的文件本身不带 export）。
        if ($t -match '^export\s+(.+)$') { $t = $matches[1].Trim() }

        $eq = $t.IndexOf('=')
        if ($eq -lt 1) {
            throw ("配置文件第 $lineNo 行不是 KEY=VALUE 格式：$EnvPath（缺 '=' 或键为空）。" +
                '空行/注释行请以 # 开头，值内的 = 无需转义（只按第一个 = 切分）。')
        }
        $key = $t.Substring(0, $eq).Trim()
        if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw ("配置文件第 $lineNo 行的变量名非法：'$key'（只允许字母/数字/下划线，且不能以数字开头）：$EnvPath")
        }
        $map[$key] = ConvertFrom-DotEnvValue -RawValue $t.Substring($eq + 1) -EnvPath $EnvPath -LineNo $lineNo
    }
    return $map
}

# ── 2) 解析安装根与关键路径 ───────────────────────────────────────────────────
$installRoot = Resolve-InstallRoot -ExplicitDir $InstallDir
Write-Verbose "安装根：$installRoot"

# 常见误用：把 <dir>\app 当成安装根传进来。显式拦一下，避免报一堆「找不到 app\app」。
if ((Split-Path -Leaf $installRoot) -eq 'app') {
    throw ("-InstallDir 看起来传成了 app 目录（$installRoot）。" +
        '请传安装根，例如 -InstallDir C:\ProgramData\vteam-worker（其下应有 app\node\work\data\logs\run\bin）。')
}

$appDir = Join-Path $installRoot 'app'
$envFile = Join-Path $appDir '.env'
$indexJs = Join-Path $appDir 'dist\index.js'
$pidFile = Join-Path $installRoot 'run\worker.pid'

if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
    throw ("安装根不存在：$installRoot。请先运行安装器（web/public/install-worker.ps1）完成安装，" +
        '或确认 -InstallDir 是否写错。')
}
if (-not (Test-Path -LiteralPath $appDir -PathType Container)) {
    throw "安装根下没有 app 目录：$appDir（安装不完整：安装器应把 worker 发布包解压到 app\）。"
}

# ── 3) 解析 .env 并导出到进程环境 ─────────────────────────────────────────────
Write-Host "[worker] 解析配置：$envFile"
$envMap = Read-DotEnvFile -EnvPath $envFile
foreach ($key in $envMap.Keys) {
    # Process 作用域：只影响本进程与其子进程；不会改用户/系统环境变量。
    [Environment]::SetEnvironmentVariable($key, [string]$envMap[$key], 'Process')
}
Write-Host "[ok] 已把 $($envMap.Count) 个键导出到本进程环境（不改系统 PATH / 用户环境变量）。"

# ── 4) 必填项与引擎校验（对齐 start.sh 与 worker/src/config.ts 的 fail-fast 语义）──
$token = ([string]$env:X_WORKER_TOKEN).Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
    throw ("缺少必填环境变量 X_WORKER_TOKEN（注册鉴权 token，对齐 X-Worker-Token header）。" +
        "请在 $envFile 里填写（与控制面 WORKER_TOKEN 一致），或从 app\.env.example 复制后填写。")
}
if ($token -eq 'change-me-worker-token') {
    throw ("X_WORKER_TOKEN 还是示例值 change-me-worker-token：$envFile" +
        '。请改成与控制面一致的注册 token（示例值会被控制面拒绝，且等于没有鉴权）。')
}

$engine = ([string]$env:WORKER_ENGINE).Trim()
if ($engine -ne '' -and $engine -ne 'opencode') {
    throw ("Windows 原生 worker 首版只支持 WORKER_ENGINE=opencode（当前 '$engine'）：dsh 引擎的 Linux 沙箱链在 Windows 不可用。" +
        '请把 .env 里的 WORKER_ENGINE 改回 opencode，或删除该行走缺省。')
}

# ── 5) OPENCODE_BIN 校验（Windows 的头号启动失败点）────────────────────────────
$opencodeBinRaw = ([string]$env:OPENCODE_BIN).Trim()
$opencodeBinDisplay = '(未设置)'
if ([string]::IsNullOrWhiteSpace($opencodeBinRaw)) {
    Write-Warning ('未设置 OPENCODE_BIN：Windows 上 npm 全局安装只生成 opencode.cmd/.ps1 shim，' +
        'worker 裸 spawn(''opencode'') 会 ENOENT。强烈建议在 .env 里写绝对路径，' +
        '例如 <安装根>\npm-global\opencode.cmd（解析方法见 worker/scripts/windows/README.md §1.1）。')
    $opencodeBinDisplay = '(未设置：依赖 PATH 解析，不推荐)'
}
else {
    $opencodeBinDisplay = $opencodeBinRaw
    if (Test-Path -LiteralPath $opencodeBinRaw -PathType Leaf) {
        Write-Host "[ok] OPENCODE_BIN：$opencodeBinRaw"
    }
    elseif ($opencodeBinRaw -match '[\\/]') {
        throw ("OPENCODE_BIN 指向的文件不存在：$opencodeBinRaw" +
            '。请改成实际存在的 opencode 绝对路径（npm 全局安装通常为 <安装根>\npm-global\opencode.cmd）。')
    }
    else {
        Write-Warning ("OPENCODE_BIN 是裸名（'$opencodeBinRaw'），不是绝对路径：Windows 上不可靠" +
            '（服务账户的 PATH 与登录会话不同）。请改成绝对路径，例如 <安装根>\npm-global\opencode.cmd。')
        $resolved = Get-Command $opencodeBinRaw -ErrorAction SilentlyContinue
        if (-not $resolved) {
            Write-Warning "PATH 上也找不到 '$opencodeBinRaw'：worker 拉起 opencode serve 时很可能 ENOENT。"
        }
    }
    if ([System.IO.Path]::GetFileName($opencodeBinRaw) -eq 'opencode') {
        Write-Warning ('OPENCODE_BIN 指向了“无扩展名 shim”（Git Bash 用），Node 无法直接执行它（ENOENT）。' +
            '请指向 opencode.cmd 或 opencode.exe。')
    }
}

# ── 6) node 与 dist 校验 ──────────────────────────────────────────────────────
$nodeExe = Join-Path $installRoot 'node\node.exe'
if (Test-Path -LiteralPath $nodeExe -PathType Leaf) {
    Write-Host "[ok] node.exe：$nodeExe（安装目录内便携 node）"
}
else {
    $nodeCmd = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { $nodeCmd = Get-Command 'node' -ErrorAction SilentlyContinue }
    if (-not $nodeCmd) {
        throw ("找不到 node：$nodeExe 不存在，PATH 上也没有 node。" +
            '请重跑安装器，或把便携 Node（node.exe 与 npm.cmd 同目录）解压到 <安装根>\node\。')
    }
    $nodeExe = [string]$nodeCmd.Source
    if ([string]::IsNullOrWhiteSpace($nodeExe)) { $nodeExe = [string]$nodeCmd.Definition }
    Write-Warning ("未使用 <安装根>\node\node.exe，改用 PATH 上的 node：$nodeExe" +
        '。服务账户的 PATH 与登录会话不同，服务化时请用安装目录内的便携 node。')
}

if (-not (Test-Path -LiteralPath $indexJs -PathType Leaf)) {
    throw ("缺少入口文件：$indexJs（发布包不完整：安装器应把 dist\ 解压到 app\）。" +
        '若刚替换过发布包，请确认压缩包解压层级没有多套一层目录。')
}

# ── 7) 目录准备 ───────────────────────────────────────────────────────────────
# work/data 是 worker 的工作区与 opencode 隔离根，logs/run 是包装器日志与 pid 落点；
# worker 自己只会 ensure WORK_DIR，不会建 data/logs/run，所以在启动前统一备好（-DryRun 不落盘）。
$requiredDirs = @(
    (Join-Path $installRoot 'work'),
    (Join-Path $installRoot 'data'),
    (Join-Path $installRoot 'logs'),
    (Join-Path $installRoot 'run')
)
foreach ($d in $requiredDirs) {
    if (Test-Path -LiteralPath $d -PathType Container) { continue }
    if ($DryRun) {
        Write-Host "[dry-run] 将创建目录：$d"
        continue
    }
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    Write-Host "[ok] 已创建目录：$d"
}

# ── 8) 单实例保护（pid 文件）──────────────────────────────────────────────────
$existingPid = 0
if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $rawPid = ''
    try {
        $rawPid = ([System.IO.File]::ReadAllText($pidFile, [System.Text.Encoding]::UTF8)).Trim()
    }
    catch {
        throw ("发现 pid 文件但读不了：$pidFile" + "。原因：$($_.Exception.Message)" +
            '。若 worker 由服务账户（SYSTEM/专用账户）运行，pid 文件属于该账户，请以管理员身份运行本脚本或 stop-worker.ps1。')
    }
    if ($rawPid -match '^\d+$') {
        $existingPid = [int]$rawPid
    }
    elseif ($rawPid -ne '') {
        Write-Warning "pid 文件内容不是数字（'$rawPid'），按陈旧文件处理：$pidFile"
    }
}
if ($existingPid -gt 0) {
    $runningProc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($runningProc) {
        if ($DryRun) {
            Write-Warning "检测到已有 worker 进程（pid=$existingPid）：真正启动会拒绝重入，请先运行 stop-worker.ps1。"
        }
        else {
            throw ("已有 worker 在运行（pid=$existingPid，来自 $pidFile）：拒绝重复启动（会争抢 4198 端口与 opencode 状态）。" +
                "请先执行 stop-worker.ps1 -InstallDir '$installRoot'；若确认该 pid 文件是陈旧的（进程已退出），删除 $pidFile 后重试。")
        }
    }
    else {
        Write-Host "[skip] 发现陈旧 pid 文件（pid=$existingPid 已不存在），启动时会覆盖为本次 node 的 PID。"
    }
}

# ── 9) 执行端口占用提示（仅告警，不拦截：也可能是别的程序临时占用）────────────
$execPort = 4198
$portText = ([string]$env:WORKER_EXEC_PORT).Trim()
if ($portText -ne '') {
    $parsedPort = 0
    if ([int]::TryParse($portText, [ref]$parsedPort) -and $parsedPort -ge 1 -and $parsedPort -le 65535) {
        $execPort = $parsedPort
    }
    else {
        Write-Warning "WORKER_EXEC_PORT 取值非法（'$portText'），worker 会回退缺省 4198。"
    }
}
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listening = @()
    try { $listening = @(Get-NetTCPConnection -LocalPort $execPort -State Listen -ErrorAction Stop) }
    catch { $listening = @() }
    if ($listening.Count -gt 0) {
        Write-Warning ("执行端口 $execPort 已在监听（可能已有 worker 或其它进程占用）：worker 启动时可能 EADDRINUSE。" +
            "排查：Get-NetTCPConnection -LocalPort $execPort -State Listen；" +
            '若命中系统保留端口段：netsh int ipv4 show excludedportrange protocol=tcp（见 README §8）。')
    }
}

# ── 10) 摘要与 -DryRun ────────────────────────────────────────────────────────
Write-Host ''
Write-Host '[worker] 启动摘要：'
Write-Host "  安装根        ：$installRoot"
Write-Host "  app 目录      ：$appDir"
Write-Host "  .env          ：$envFile（已解析 $($envMap.Count) 个键；值不打印）"
Write-Host "  node.exe      ：$nodeExe"
Write-Host "  入口          ：$indexJs"
Write-Host "  OPENCODE_BIN  ：$opencodeBinDisplay"
Write-Host "  执行端口      ：$execPort"
Write-Host "  pid 文件      ：$pidFile"
Write-Host "  X_WORKER_TOKEN：已设置（长度 $($token.Length)，出于安全不打印）"

if ($DryRun) {
    Write-Host ''
    Write-Host '[dry-run] 校验通过：未启动 worker、未创建目录。'
    exit 0
}

# ── 11) 前台启动 node ─────────────────────────────────────────────────────────
# 为什么用 Start-Process -PassThru 而不是 `& $nodeExe`：
#   `&` 是把 node 当子进程同步执行，此时 $PID 是本 PowerShell 的 PID，pid 文件就会写错，
#   stop 时 taskkill /T 的根就变成 PowerShell（还可能连运维自己的终端一起杀掉）。
# -NoNewWindow：子进程继承当前控制台，stdout/stderr 直接显示（前台排障）；同时仍是本进程的子进程，
#   服务/计划任务停止时能按进程树一起清。
# 注意不要加 -Wait：PS 5.1 的 Start-Process -Wait 会等整棵后代进程退出，
#   若 opencode serve 在 node 退出后仍短暂存活，会把本脚本挂住；这里只等 node 自己（WaitForExit）。
Write-Host ''
Write-Host ('[worker] 前台启动："{0}" "{1}"（工作目录 {2}）' -f $nodeExe, $indexJs, $appDir)
$proc = $null
try {
    # 用 @splat 而不是反引号续行：反引号后混入空格/全角字符会静默截断命令，是 PS 脚本的经典坑。
    $startParams = @{
        FilePath         = $nodeExe
        ArgumentList     = ('"' + $indexJs + '"')
        WorkingDirectory = $appDir
        NoNewWindow      = $true
        PassThru         = $true
        ErrorAction      = 'Stop'
    }
    $proc = Start-Process @startParams
}
catch {
    throw ("启动 node 失败：$($_.Exception.Message)" +
        "。请确认 node 可执行且 $indexJs 存在；若是服务账户，确认其对 $appDir 有读权限。")
}
if ($null -eq $proc) {
    throw "Start-Process 未返回进程对象，无法写 pid 文件（异常状态，请重跑并保留输出）。"
}

# pid 文件写的是 node 的 PID（stop-worker.ps1 依赖它做 taskkill /T /F 根进程）。
try {
    [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[ok] worker 已启动：pid=$($proc.Id)（已写入 $pidFile）"
}
catch {
    # 写 pid 失败不阻止 worker 继续跑，但要让运维知道 stop 会退化为「按命令行匹配」。
    Write-Warning ("worker 已启动（pid=$($proc.Id)），但写 pid 文件失败：$($_.Exception.Message)" +
        '。stop-worker.ps1 将退回按命令行匹配清理（可能漏掉脱离进程树的子进程）。')
}
Write-Host '[worker] 前台运行中：Ctrl+C 可中断（node 走 SIGINT 优雅退出，优于服务 TerminateProcess）。'

$procExited = $false
$finalCode = 0
try {
    $proc.WaitForExit()
    $procExited = $true
    try { $finalCode = [int]$proc.ExitCode } catch { $finalCode = 0 }
}
finally {
    if ($procExited) {
        # 只删「自己写的」pid 文件：避免误删后来实例（并发/重入）的 pid。
        try {
            if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
                $currentPidText = ([System.IO.File]::ReadAllText($pidFile, [System.Text.Encoding]::UTF8)).Trim()
                if ($currentPidText -eq [string]$proc.Id) {
                    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
                    Write-Host "[ok] 已清理 pid 文件：$pidFile"
                }
            }
        }
        catch {
            Write-Warning "清理 pid 文件失败（不影响本次退出；下次启动会按陈旧 pid 文件处理）：$($_.Exception.Message)"
        }

        Write-Host ""
        Write-Host "[worker] 已退出（pid=$($proc.Id)，退出码 $finalCode）。"
        if ($finalCode -ne 0) {
            Write-Host ('[worker] 退出码非 0：先看上面的日志；常见原因是 X_WORKER_TOKEN/OPENCODE_SERVER_PASSWORD 未配置、' +
                'OPENCODE_BIN 指向不可执行的 shim、执行端口被占用。服务模式请看 <安装根>\logs\ 下包装器日志。')
        }
    }
    else {
        Write-Host ''
        Write-Host ('[worker] 前台等待被中断：worker 可能仍在退出中；pid 文件已保留，' +
            "可运行 stop-worker.ps1 -InstallDir '$installRoot' 兜底清理。")
    }
}

if ($procExited) { exit $finalCode }
exit 0
