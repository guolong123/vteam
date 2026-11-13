<#
.SYNOPSIS
    卸载 vteam worker：停止进程树 → 删除 Windows 服务/计划任务/防火墙规则 → 按 -PurgeData 决定是否删除安装目录。

.DESCRIPTION
    卸载必须**幂等**（可重复跑，没装也能跑成 0），且按清单清理（验收就按这个顺序查）：
      ① 停止 worker：调用同目录的 stop-worker.ps1（服务 → 计划任务 → pid/命令行 → opencode 残留）；
      ② 删除 Windows 服务：优先用 WinSW 包装器 `<安装根>\bin\vteam-worker-service.exe uninstall`
         （或 svc\ 下的旧布局），包装器不在就回退 `sc.exe delete vteam-worker`；
      ③ 删除计划任务 `vteam-worker`（无管理员自启模式才会存在）；
      ④ 删除防火墙规则 `vteam-worker-exec`（-KeepFirewallRule 可保留；规则名与 enable-firewall.ps1 一致）；
      ⑤ 目录：-PurgeData 才整目录删除（含 work\、data\、app\.env —— 不可恢复，先备份！）；
         缺省**保留数据与配置**，只打印保留位置与手工清理命令。

    为什么默认保留 work\、data\、app\.env：
      - work\ 是 Agent 的工作区与产物，data\ 是 opencode 隔离配置域（含 auth.json 的明文模型 key），
        .env 里有注册 token 与 serve 密码 —— 这些都不是「程序文件」，误删不可恢复；
      - 保留它们也保证「卸载后重跑安装器」能原地修复/升级，而不是从零再来（安装器的幂等前提）。

    为什么 -PurgeData 前要做安全校验：
      脚本会对变量拼接出的路径执行递归删除；一旦 -InstallDir 传错（例如传成 C:\ 或某个大目录），
      就是灾难。所以删除前必须确认：不是磁盘根、不是系统受保护目录、且目录里能找到
      app/run/bin/node/logs/npm-global/work/data 任一 vteam 安装特征；不满足就拒绝并给手工命令。

    PATH / 环境变量：本脚本**不改系统/用户 PATH**（安装器约定也不改；worker 靠绝对路径启动）。
      如曾手工把 <安装根>\node、<安装根>\npm-global 加进 PATH，请自行清理（本脚本只提示，不代劳）。

    与安装器/服务模式的衔接（约定，不要改）：
      - 安装器调用：powershell -NoProfile -ExecutionPolicy Bypass -File <dir>\app\scripts\windows\uninstall-worker.ps1 -InstallDir <dir> [-PurgeData]
      - 服务名固定 `vteam-worker`；安装根 <dir>\{node,npm-global,app,work,data,logs,bin,run}；
        防火墙规则固定 `vteam-worker-exec`。
      - 回滚/重装：不带 -PurgeData 卸载后，重跑 install-worker.ps1 会识别现有 app\node\npm-global 并原地修复。

.PARAMETER InstallDir
    安装根（例如 `C:\ProgramData\vteam-worker`）。缺省从脚本位置推断（<dir>\app\scripts\windows\ → <dir>）。
    路径含空格请整体加引号。这是**递归删除的唯一依据**，-PurgeData 时脚本会先校验再删。

.PARAMETER ServiceName
    Windows 服务名 / 计划任务名，缺省 `vteam-worker`（安装器约定，不要改）。
    只允许字母/数字/点/下划线/连字符（会拼进 WQL 过滤串与命令行）。

.PARAMETER PurgeData
    连数据一起删：整个安装根（含 work\、data\、app\.env、logs\、node\）递归删除，**不可恢复**。
    缺省不加 = 保留数据与配置。建议先备份 work\ 与 data\。

.PARAMETER KeepFirewallRule
    保留防火墙规则 `vteam-worker-exec`（缺省删除；若机器上还有别的 worker 共用该规则名，用这个开关）。

.PARAMETER Strict
    失败即停：任一步骤失败立刻抛错退出（缺省是「继续执行 + 末尾汇总」，便于一次把能清的都清掉）。
    安装器做严格验收时建议加 -Strict。

.PARAMETER TimeoutSec
    等待服务停止/删除的秒数，缺省 20。

.EXAMPLE
    # 常规卸载（保留 work\、data\、app\.env；幂等，可重复执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\vteam-worker\app\scripts\windows\uninstall-worker.ps1" -InstallDir "C:\ProgramData\vteam-worker"

.EXAMPLE
    # 彻底删除（先把 work\ 与 data\ 备份出去！）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-worker.ps1 -InstallDir "C:\ProgramData\vteam-worker" -PurgeData

.EXAMPLE
    # 保留防火墙规则（同一台机器还有别的 worker 复用该规则名），失败即停：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-worker.ps1 -InstallDir "C:\ProgramData\vteam-worker" -KeepFirewallRule -Strict

.NOTES
    退出码：0 = 卸载完成（或本来就没装）；1 = 有失败项（非 -Strict 时汇总后返回）；-Strict 时失败立即抛错。
    回滚/恢复：不加 -PurgeData 时 work\、data\、app\.env 与程序文件都还在，重跑 install-worker.ps1
    即可原地恢复；加了 -PurgeData 则不可恢复（删前必须先备份 work\ 与 data\）。
    权限：删除服务/防火墙规则需要管理员；无管理员模式（计划任务 + 用户目录安装）可不提权卸载，
          但防火墙规则删不掉（会在汇总里提示，可稍后以管理员重跑）。
    执行方式：`powershell -NoProfile -ExecutionPolicy Bypass -File <本文件>`（进程级，不改机器 ExecutionPolicy）。
    验证状态：**未在 Windows 真机验证**（本仓库在 macOS 上开发，按 Windows PowerShell 5.1 语法编写）。
    真机验收重点：连跑两次第二次仍退出 0；服务/任务/防火墙从 Get-Service/Get-ScheduledTask/
    Get-NetFirewallRule 里消失；-PurgeData 前安全校验能拦住错误路径；不带 -PurgeData 时数据文件原样保留。
#>
[CmdletBinding()]
param(
    [string]$InstallDir = '',

    [ValidateNotNullOrEmpty()]
    [string]$ServiceName = 'vteam-worker',

    [switch]$PurgeData,

    [switch]$KeepFirewallRule,

    [switch]$Strict,

    [ValidateRange(1, 600)]
    [int]$TimeoutSec = 20
)

# 卸载是「尽力清理 + 汇总」：单步失败（比如没提权删不掉防火墙）不应阻断其它清理。
$ErrorActionPreference = 'Continue'

# 与 enable-firewall.ps1/README 保持一致，不要改名（改名会让卸载与运维文档对不上）。
$FirewallRuleName = 'vteam-worker-exec'

# ── 0) 环境与参数守卫 ─────────────────────────────────────────────────────────
if ($env:OS -ne 'Windows_NT') {
    throw ("本脚本只支持 Windows（当前不是 Windows 环境）。（检测到 env:OS=$($env:OS)）")
}
if ($ServiceName -notmatch '^[A-Za-z0-9._-]+$') {
    throw "-ServiceName 含非法字符（只允许字母/数字/点/下划线/连字符）：$ServiceName"
}

$script:Failures = New-Object System.Collections.ArrayList

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

$isAdmin = Test-IsAdministrator
if (-not $isAdmin) {
    Write-Warning ('当前不是管理员：删除 Windows 服务与防火墙规则需要管理员权限，可能失败；' +
        '无管理员模式（计划任务 + 用户目录）通常可以卸载进程与任务。失败项会在末尾汇总，可稍后以管理员重跑（幂等）。')
}

# ── 1) 公共辅助函数 ───────────────────────────────────────────────────────────

function Get-NormalizedPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
}

# 与 start/stop 相同的推断规则：显式参数 → 向上找 app\ → <dir>\app\scripts\windows 位置规律兜底。
function Resolve-InstallRoot([string]$ExplicitDir) {
    if (-not [string]::IsNullOrWhiteSpace($ExplicitDir)) {
        return Get-NormalizedPath -Path $ExplicitDir
    }
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw '无法从脚本位置推断安装根（$PSScriptRoot 为空）。请显式传 -InstallDir <安装根>。'
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
    $scriptsCandidate = Split-Path -Parent $PSScriptRoot
    $appCandidate2 = Split-Path -Parent $scriptsCandidate
    if (-not [string]::IsNullOrWhiteSpace($appCandidate2) -and
        (Split-Path -Leaf $appCandidate2) -eq 'app' -and
        (Split-Path -Leaf $scriptsCandidate) -eq 'scripts') {
        return Get-NormalizedPath -Path (Split-Path -Parent $appCandidate2)
    }
    throw ("无法从脚本位置推断安装根：$PSScriptRoot。" +
        '请显式传 -InstallDir <安装根>，例如 -InstallDir C:\ProgramData\vteam-worker')
}

function Find-WinswExe([string]$Root, [string]$Name) {
    $candidates = @(
        (Join-Path $Root ('bin\{0}-service.exe' -f $Name)),   # 本仓库安装器约定
        (Join-Path $Root ('bin\{0}.exe' -f $Name)),
        (Join-Path $Root ('svc\{0}.exe' -f $Name)),          # README/设计文档里的布局
        (Join-Path $Root ('svc\{0}-service.exe' -f $Name))
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { return $c }
    }
    return $null
}

# -PurgeData 的最后一道闸：宁可拒绝删除，也不能对拼错的路径递归删除。
function Assert-SafeInstallDir([string]$Path) {
    $full = Get-NormalizedPath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrWhiteSpace($root)) {
        throw "拒绝删除：无法解析 '$full' 的盘符/根路径。"
    }
    if ($full -eq $root -or $full -eq $root.TrimEnd('\')) {
        throw "拒绝删除：'$full' 是磁盘根目录。"
    }
    if ([string]::IsNullOrWhiteSpace((Split-Path -Leaf $full))) {
        throw "拒绝删除：无法解析 '$full' 的目录名。"
    }

    $protectedCandidates = @(
        $env:SystemRoot,
        $env:ProgramFiles,
        [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
        $env:ProgramData,
        $env:USERPROFILE,
        $env:LOCALAPPDATA,
        $env:APPDATA
    )
    foreach ($p in $protectedCandidates) {
        if ([string]::IsNullOrWhiteSpace($p)) { continue }
        $pf = Get-NormalizedPath -Path $p
        if ($full -eq $pf) {
            throw "拒绝删除受保护目录：$full"
        }
    }

    # 必须能找到 vteam worker 安装根的特征子目录，否则大概率 -InstallDir 传错了。
    $markers = @('app', 'run', 'bin', 'node', 'logs', 'npm-global', 'work', 'data')
    $foundMarker = $false
    foreach ($m in $markers) {
        if (Test-Path -LiteralPath (Join-Path $full $m)) { $foundMarker = $true; break }
    }
    if (-not $foundMarker) {
        throw ("拒绝删除：'$full' 看起来不是 vteam worker 安装根" +
            '（未找到 app/run/bin/node/logs/npm-global/work/data 任一子目录）。' +
            "为避免误删，本脚本不执行递归删除；如确认要删，请手工：Remove-Item -LiteralPath '$full' -Recurse -Force")
    }
}

# 单步执行器：失败默认汇总继续；-Strict 时立刻抛错停止。
function Invoke-UninstallStep([string]$Title, [scriptblock]$Action) {
    Write-Host ''
    Write-Host "== $Title =="
    try {
        & $Action
    }
    catch {
        $message = "$Title 失败：$($_.Exception.Message)"
        if ($Strict) {
            Write-Host ''
            Write-Host "[strict] 失败即停：$message"
            throw $message
        }
        [void]$script:Failures.Add($message)
        Write-Warning $message
        Write-Host '  继续执行后续步骤（缺省汇总后退出；修复后可重跑本脚本，幂等）。'
    }
}

# ── 2) 解析安装根 ─────────────────────────────────────────────────────────────
$installRoot = Resolve-InstallRoot -ExplicitDir $InstallDir
Write-Verbose "安装根：$installRoot"

if ((Split-Path -Leaf $installRoot) -eq 'app') {
    throw ("-InstallDir 看起来传成了 app 目录（$installRoot）。请传安装根，例如 C:\ProgramData\vteam-worker。")
}

# 用变量拼好再打印，避免在双引号里塞 `$(if ...)` 这类复杂子表达式（PS 5.1 上更易读、更不易踩解析坑）。
$dataPolicyText = '缺省：保留 work\ 与 data\ 以及 app\.env'
if ($PurgeData) { $dataPolicyText = '-PurgeData：删除整个安装根（含 work\、data\、app\.env）' }
$strictText = 'False'
if ($Strict) { $strictText = 'True' }
$keepFwText = 'False'
if ($KeepFirewallRule) { $keepFwText = 'True' }

Write-Host "[uninstall] 安装根：$installRoot"
Write-Host "[uninstall] 服务名：$ServiceName；防火墙规则：$FirewallRuleName"
Write-Host "[uninstall] 数据保留策略：$dataPolicyText"
Write-Host "[uninstall] 管理员=$isAdmin；-Strict=$strictText；-KeepFirewallRule=$keepFwText"
Write-Host '提示：本脚本不改系统/用户 PATH（安装器约定也不改）；如曾手工加过 <安装根>\node 等，请自行清理。'

# ── 3) ① 停止 worker ─────────────────────────────────────────────────────────
Invoke-UninstallStep -Title '1/5 停止 worker（服务/计划任务/进程树/opencode 残留）' -Action {
    $stopScript = Join-Path $PSScriptRoot 'stop-worker.ps1'
    if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) {
        Write-Warning ("未找到 stop-worker.ps1：$stopScript —— 跳过停止步骤。" +
            '若 worker 仍在运行，后面的服务删除/目录删除可能失败。')
        return
    }
    $stopArgs = @{
        InstallDir  = $installRoot
        ServiceName = $ServiceName
        TimeoutSec  = $TimeoutSec
    }
    $rc = 0
    & $stopScript @stopArgs
    $rc = $LASTEXITCODE
    if ($rc -ne 0) {
        throw "stop-worker.ps1 返回退出码 $rc（详见上面的输出）。请先按提示处理（例如以管理员重跑），或在已确认进程已停的情况下继续。"
    }
}

# ── 4) ② 删除 Windows 服务 ───────────────────────────────────────────────────
Invoke-UninstallStep -Title '2/5 删除 Windows 服务' -Action {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "[skip] 服务 $ServiceName 不存在（已删除或从未注册）。"
        return
    }

    $winsw = Find-WinswExe -Root $installRoot -Name $ServiceName
    $uninstalledByWinsw = $false
    if ($winsw) {
        Write-Host "[uninstall] 调用 WinSW 卸载：$winsw uninstall"
        $out = @()
        $rc = 1
        try {
            $out = @(& $winsw uninstall 2>&1)
            $rc = $LASTEXITCODE
        }
        catch {
            $rc = 1
            $out = @($_.Exception.Message)
        }
        foreach ($line in $out) {
            $s = ([string]$line).Trim()
            if ($s -ne '') { Write-Host "    $s" }
        }
        if ($rc -eq 0) {
            $uninstalledByWinsw = $true
        }
        else {
            Write-Warning "WinSW uninstall 返回 $rc，回退到 sc.exe delete"
        }
    }
    else {
        Write-Host '[info] 未找到 WinSW 包装器 exe（bin\ 或 svc\），使用 sc.exe delete。'
    }

    if (-not $uninstalledByWinsw) {
        $out = @()
        $rc = 1
        try {
            $out = @(& sc.exe delete $ServiceName 2>&1)
            $rc = $LASTEXITCODE
        }
        catch {
            $rc = 1
            $out = @($_.Exception.Message)
        }
        foreach ($line in $out) {
            $s = ([string]$line).Trim()
            if ($s -ne '') { Write-Host "    $s" }
        }
        if ($rc -ne 0 -and $rc -ne 1060) {
            # 0=成功；1060=服务不存在；5=权限不足；1072=已标记删除（句柄未释放，重启后消失）
            Write-Warning "sc.exe delete 返回 $rc（0=成功 / 1060=不存在 / 5=权限不足 / 1072=已标记删除）"
        }
    }

    # 等服务条目真正消失（WinSW 删除是异步的；sc delete 也可能停在「标记删除」）。
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        throw ("服务 $ServiceName 仍存在。可能原因：① 未以管理员运行；② 服务处于「标记删除」（有句柄未释放，" +
            '重启后消失）。请以管理员执行 sc.exe delete ' + $ServiceName + '，或重启后重跑本脚本（幂等）。')
    }
    Write-Host "[ok] 服务 $ServiceName 已删除。"
}

# ── 5) ③ 删除计划任务 ────────────────────────────────────────────────────────
Invoke-UninstallStep -Title '3/5 删除计划任务（无管理员自启模式）' -Action {
    $taskExists = $false
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        try {
            $null = Get-ScheduledTask -TaskName $ServiceName -ErrorAction Stop
            $taskExists = $true
        }
        catch {
            $taskExists = $false
        }
        if (-not $taskExists) {
            Write-Host "[skip] 计划任务 $ServiceName 不存在。"
            return
        }
        Write-Host "[uninstall] 删除计划任务：$ServiceName"
        try {
            Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction Stop
        }
        catch {
            throw ("删除计划任务失败：$($_.Exception.Message)。" +
                "可手工执行：schtasks.exe /Delete /TN '$ServiceName' /F")
        }
        Write-Host '[ok] 计划任务已删除。'
        return
    }

    # 回退：极老的 Windows 没有 ScheduledTasks 模块。
    $rc = 1
    try {
        $null = & schtasks.exe /Query /TN $ServiceName 2>&1
        $rc = $LASTEXITCODE
    }
    catch {
        $rc = 1
    }
    if ($rc -ne 0) {
        Write-Host "[skip] 计划任务 $ServiceName 不存在（schtasks 回退路径）。"
        return
    }
    Write-Host "[uninstall] 删除计划任务：$ServiceName（schtasks 回退路径）"
    $rc2 = 1
    try {
        $null = & schtasks.exe /Delete /TN $ServiceName /F 2>&1
        $rc2 = $LASTEXITCODE
    }
    catch {
        $rc2 = 1
    }
    if ($rc2 -ne 0) {
        throw "schtasks.exe /Delete 返回 $rc2（可手工以管理员身份执行 schtasks.exe /Delete /TN '$ServiceName' /F）"
    }
    Write-Host '[ok] 计划任务已删除（schtasks 回退路径）。'
}

# ── 6) ④ 删除防火墙规则 ──────────────────────────────────────────────────────
Invoke-UninstallStep -Title '4/5 删除防火墙规则' -Action {
    if ($KeepFirewallRule) {
        Write-Host "[skip] 按 -KeepFirewallRule 保留防火墙规则 $FirewallRuleName。"
        return
    }
    if (-not (Get-Command Remove-NetFirewallRule -ErrorAction SilentlyContinue)) {
        Write-Warning '本机没有 NetSecurity 模块（Remove-NetFirewallRule 不可用）：如曾创建规则请手工删除。'
        return
    }
    $rules = @()
    try {
        $rules = @(Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue)
    }
    catch {
        $rules = @()
    }
    if ($rules.Count -eq 0) {
        Write-Host "[skip] 防火墙规则 $FirewallRuleName 不存在。"
        return
    }
    Write-Host "[uninstall] 删除防火墙规则：$FirewallRuleName"
    try {
        Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction Stop
    }
    catch {
        throw ("删除防火墙规则失败：$($_.Exception.Message)。删除防火墙规则需要管理员权限；" +
            "请以管理员身份重跑本脚本，或手工执行 Remove-NetFirewallRule -Name '$FirewallRuleName'。")
    }
    $left = @()
    try {
        $left = @(Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue)
    }
    catch {
        $left = @()
    }
    if ($left.Count -gt 0) {
        throw "删除后仍能查到防火墙规则 $FirewallRuleName，请手工检查（可能被 GPO 重新下发）。"
    }
    Write-Host "[ok] 防火墙规则 $FirewallRuleName 已删除。"
}

# ── 7) ⑤ 处理安装目录 ────────────────────────────────────────────────────────
Invoke-UninstallStep -Title '5/5 处理安装目录（数据保留策略）' -Action {
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
        Write-Host "[skip] 安装根不存在：$installRoot（已是卸载完成状态）。"
        return
    }

    if ($PurgeData) {
        Assert-SafeInstallDir -Path $installRoot
        Write-Host "[purge] 递归删除安装根（含 work\、data\、app\.env，不可恢复）：$installRoot"
        try {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
        }
        catch {
            throw ("删除安装目录失败：$($_.Exception.Message)。常见原因：文件被占用（先停进程）、只读、权限不足。" +
                "可关闭占用后重跑本脚本，或手工执行：Remove-Item -LiteralPath '$installRoot' -Recurse -Force")
        }
        if (Test-Path -LiteralPath $installRoot) {
            throw ("删除后安装根仍存在：$installRoot（可能有文件被占用或权限不足）。" +
                "可手工检查并删除：Get-ChildItem -LiteralPath '$installRoot' -Force")
        }
        Write-Host '[ok] 安装目录已删除。'
        return
    }

    # 缺省：保留数据与配置（安全第一）。只打印位置与手工清理命令，不擅自删任何文件。
    $envPath = Join-Path $installRoot 'app\.env'
    $workDir = Join-Path $installRoot 'work'
    $dataDir = Join-Path $installRoot 'data'
    $logsDir = Join-Path $installRoot 'logs'
    $runDir = Join-Path $installRoot 'run'
    $appDirFull = Join-Path $installRoot 'app'
    $nodeDir = Join-Path $installRoot 'node'
    $npmDir = Join-Path $installRoot 'npm-global'
    $binDir = Join-Path $installRoot 'bin'

    Write-Host '[skip] 未加 -PurgeData：保留数据与配置（如需彻底删除请加 -PurgeData，先备份！）。'
    Write-Host "  保留（数据）：$workDir        ← Agent 工作区/产物"
    Write-Host "  保留（数据）：$dataDir        ← opencode 隔离配置域（含 auth.json 明文模型 key）"
    Write-Host "  保留（密钥）：$envPath        ← 含 X_WORKER_TOKEN / OPENCODE_SERVER_PASSWORD"
    Write-Host "  保留（日志）：$logsDir / $runDir"
    Write-Host "  保留（程序）：$appDirFull / $nodeDir / $npmDir / $binDir（重跑安装器可原地修复/升级）"
    Write-Host '如确认不再需要，手工清理（管理员 PowerShell）：'
    Write-Host "  Remove-Item -LiteralPath '$envPath' -Force"
    Write-Host "  Remove-Item -LiteralPath '$workDir' -Recurse -Force"
    Write-Host "  Remove-Item -LiteralPath '$dataDir' -Recurse -Force"
    Write-Host "  Remove-Item -LiteralPath '$installRoot' -Recurse -Force"
    Write-Host '或者直接重跑本脚本并加 -PurgeData。'
}

# ── 8) 汇总 ──────────────────────────────────────────────────────────────────
Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host "[result] 卸载有 $($script:Failures.Count) 项未完成："
    foreach ($f in $script:Failures) { Write-Host "  - $f" }
    Write-Host '[result] 按提示处理后重跑本脚本即可（幂等；失败项不阻断其它清理）。'
    exit 1
}

Write-Host '[result] 卸载完成（或本来未安装）。'
Write-Host '自检（以下应全部为空/False）：'
Write-Host "  Get-Service $ServiceName -ErrorAction SilentlyContinue"
Write-Host "  Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue"
Write-Host "  Get-NetFirewallRule -Name '$FirewallRuleName' -ErrorAction SilentlyContinue"
Write-Host '  Get-Process opencode -ErrorAction SilentlyContinue'
if ($PurgeData) {
    Write-Host "  Test-Path '$installRoot'        # -PurgeData 后应为 False"
}
else {
    Write-Host "  Test-Path '$installRoot\work'   # 缺省保留：应为 True（数据未被删）"
}
exit 0
