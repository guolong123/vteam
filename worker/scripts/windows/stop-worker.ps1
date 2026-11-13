<#
.SYNOPSIS
    停止 vteam worker，并清理 Windows 服务停止语义（TerminateProcess）留下的 opencode 残留子进程。

.DESCRIPTION
    为什么不能只 `sc.exe stop` / `Stop-ScheduledTask` 就完事：
      - Windows 服务停止是 TerminateProcess 语义：node 收不到 SIGTERM/SIGINT，`shutdown()` 不执行；
        opencode serve 若不在包装器的进程树里（detached / 中间多一层 cmd.exe），**会残留**，
        占着 opencode 端口、锁着 opencode.db，下一次启动就可能失败。
      - 所以本脚本按「四条线索」逐层清理，幂等、每步打印做了什么：
        ① Windows 服务（WinSW/NSSM 注册的 `vteam-worker`）→ `sc.exe stop` + 等服务 Stopped；
        ② 计划任务（无管理员模式）→ `Stop-ScheduledTask` / `schtasks /End`；
        ③ `<安装根>\run\worker.pid` → `taskkill /PID <pid> /T /F`（/T = 连同子进程树）；
        ④ pid 缺失/陈旧/命令行不匹配时，按「命令行同时含 <安装根> 与 dist\index.js 的 node.exe」兜底，
           再清「父进程是本安装目录的 node 或命令行/镜像路径在 <安装根> 下」的 opencode.exe。
           为什么加这两道限制：机器上可能同时有别的 opencode（手工开的、其它 worker），
           无差别 `Get-Process opencode | Stop-Process` 会误杀别人，绝不做。

    为什么结束用 `taskkill /T /F` 而不是 Stop-Process：`/T` 能一次带走整棵进程树（node → cmd → opencode），
    比逐个 Stop-Process 少竞态；`/F` 对应服务停止的强制语义，避免进程忽略关闭请求。

    服务停止超时还有一层兜底：拿 Win32_Service 的 ProcessId（包装器 PID）后再 `taskkill /T /F`，
    覆盖「sc stop 已接受但服务卡在 StopPending」的情况。

    与安装器/服务模式的衔接（约定，不要改）：
      - 安装器调用：powershell -NoProfile -ExecutionPolicy Bypass -File <dir>\app\scripts\windows\stop-worker.ps1 -InstallDir <dir>
      - 也可作为 WinSW 3.x 的 `<prestop>`（无参数调用，靠脚本位置推断 <dir>）：
        此时本脚本自己就在服务进程树内，会**跳过**对服务的 sc stop/强杀，只做 pid/命令行清理；
        服务本身的停止交给包装器。
      - 卸载：uninstall-worker.ps1 第一步就是调用本脚本；本脚本退出码 0 = 已停/本来未运行，1 = 有失败项。

.PARAMETER InstallDir
    安装根（例如 `C:\ProgramData\vteam-worker`）。缺省从脚本位置推断（<dir>\app\scripts\windows\ → <dir>）；
    计划任务/包装器没有传参时也能工作。路径含空格请整体加引号。

.PARAMETER ServiceName
    Windows 服务名 / 计划任务名，缺省 `vteam-worker`（安装器约定，不要改）。
    只允许字母/数字/点/下划线/连字符，避免把参数拼进 WQL 过滤串时被注入。

.PARAMETER TimeoutSec
    等待服务变为 Stopped 的秒数，缺省 20（对齐 WinSW 的 stoptimeout 量级）。超时后进入强制清理。

.EXAMPLE
    # 安装器/运维常用（幂等，可重复执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\vteam-worker\app\scripts\windows\stop-worker.ps1" -InstallDir "C:\ProgramData\vteam-worker"

.EXAMPLE
    # 只预演要做什么（不真的停/杀；由 PowerShell 的 ShouldProcess 输出 What if 行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-worker.ps1 -InstallDir "C:\ProgramData\vteam-worker" -WhatIf

.EXAMPLE
    # 服务卡在 StopPending：缩短等待、尽快进强制清理：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-worker.ps1 -InstallDir "C:\ProgramData\vteam-worker" -TimeoutSec 10

.NOTES
    退出码：0 = worker 已停止或本来未运行（幂等）；1 = 至少一项失败（失败项会在末尾汇总，重跑即可）。
    恢复：重新启动用 `start-worker.ps1 -InstallDir <dir>`（服务模式用 `sc.exe start <服务名>` /
    `Start-ScheduledTask <任务名>`；本脚本只负责停与清理，不会改注册表/环境变量）。
    权限：停止服务、结束服务账户（SYSTEM/专用账户）的进程需要管理员；前台（当前用户启动）的 worker 通常不需要。
    不 `Set-ExecutionPolicy`：用 `powershell -NoProfile -ExecutionPolicy Bypass -File` 进程级执行。
    验证状态：**未在 Windows 真机验证**（本仓库在 macOS 上开发，按 Windows PowerShell 5.1 语法编写）。
    真机验收重点：服务停止后 `Get-Process opencode` 是否为空；`run\worker.pid` 是否被清理；
    `-WhatIf` 不产生任何副作用；未提权时失败提示是否可操作。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$InstallDir = '',

    [ValidateNotNullOrEmpty()]
    [string]$ServiceName = 'vteam-worker',

    [ValidateRange(1, 600)]
    [int]$TimeoutSec = 20
)

# 停止/清理是「尽力而为 + 汇总失败」，所以不用 Stop：单个步骤失败不应中断后面的清理。
$ErrorActionPreference = 'Continue'

# ── 0) 环境与参数守卫 ─────────────────────────────────────────────────────────
if ($env:OS -ne 'Windows_NT') {
    throw ("本脚本只支持 Windows（当前不是 Windows 环境）。在 macOS/Linux 上请用 worker/scripts/stop.sh 或 kill。" +
        "（检测到 env:OS=$($env:OS)）")
}
if ($ServiceName -notmatch '^[A-Za-z0-9._-]+$') {
    throw "-ServiceName 含非法字符（只允许字母/数字/点/下划线/连字符）：$ServiceName"
}

$script:Failures = New-Object System.Collections.ArrayList
function Add-StopFailure([string]$Message) {
    [void]$script:Failures.Add($Message)
    Write-Warning $Message
}

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

if (-not (Test-IsAdministrator)) {
    Write-Warning ('当前不是管理员：停止/删除 Windows 服务、结束服务账户的进程需要管理员权限；' +
        '前台（当前用户启动）的 worker 通常可以直接停止。若下面出现「拒绝访问」，请以管理员身份重跑。')
}

# ── 1) 公共辅助函数 ───────────────────────────────────────────────────────────

function Get-NormalizedPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
}

# 解析安装根：显式参数优先；否则从脚本位置向上找含 app\ 的目录；
# 若 app 已被删（部分卸载后再跑 stop），退回 <dir>\app\scripts\windows 的位置规律推断 <dir>。
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
    # 位置规律兜底：<dir>\app\scripts\windows\{start,stop,uninstall}-worker.ps1
    $scriptsCandidate = Split-Path -Parent $PSScriptRoot          # ...\app\scripts
    $appCandidate2 = Split-Path -Parent $scriptsCandidate         # ...\app
    if (-not [string]::IsNullOrWhiteSpace($appCandidate2) -and
        (Split-Path -Leaf $appCandidate2) -eq 'app' -and
        (Split-Path -Leaf $scriptsCandidate) -eq 'scripts') {
        return Get-NormalizedPath -Path (Split-Path -Parent $appCandidate2)
    }
    throw ("无法从脚本位置推断安装根：$PSScriptRoot。" +
        '请显式传 -InstallDir <安装根>，例如 -InstallDir C:\ProgramData\vteam-worker')
}

# 结束整棵进程树。返回 $true=已确认进程不在了（成功或本来就不在）/ $false=失败。
function Stop-ProcessTree([int]$ProcessId, [string]$Reason) {
    if ($ProcessId -le 4) {
        Write-Warning "拒绝结束 PID $ProcessId（系统关键进程）：$Reason"
        return $false
    }
    if ($ProcessId -eq $PID) {
        Write-Warning "拒绝结束本脚本自身（PID $PID）：$Reason"
        return $false
    }
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
        Write-Host "[skip] PID $ProcessId 已不存在（$Reason）"
        return $true
    }
    Write-Host "[kill] taskkill /PID $ProcessId /T /F —— $Reason"
    $out = @()
    $rc = 1
    try {
        $out = @(& taskkill.exe /PID $ProcessId /T /F 2>&1)
        $rc = $LASTEXITCODE
    }
    catch {
        Write-Warning "调用 taskkill 失败：$($_.Exception.Message)"
        return $false
    }
    foreach ($line in $out) {
        $s = ([string]$line).Trim()
        if ($s -ne '') { Write-Host "    $s" }
    }
    if (Wait-ProcessGone -ProcessId $ProcessId -Seconds 5) {
        Write-Host "[ok] 已结束 PID $ProcessId 及其子进程树"
        return $true
    }
    Write-Warning ("taskkill 未能结束 PID $ProcessId（退出码 $rc：0=成功 / 1=权限不足或拒绝访问 / 128=进程不存在）。" +
        '若为服务账户进程，请以管理员身份重跑本脚本。')
    return $false
}

function Test-ProcessAlive([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

function Wait-ProcessGone([int]$ProcessId, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return (-not (Test-ProcessAlive -ProcessId $ProcessId))
}

function Wait-ServiceStopped([string]$Name, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if (-not $svc) { return $true }                     # 服务条目消失也算停住
        if ([string]$svc.Status -eq 'Stopped') { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 500
    }
}

# 判断本脚本是否运行在「服务包装器的进程树」内（WinSW 3.x prestop 场景）。
# 若是：不能对服务执行 sc stop / taskkill 自己的祖先（会把自己所在树杀掉、且包装器正在等我们返回）。
function Test-RunsInsideService([int]$ServicePid) {
    if ($ServicePid -le 0) { return $false }
    $current = $PID
    for ($depth = 0; $depth -lt 8; $depth++) {
        if ($current -le 0) { return $false }
        if ($current -eq $ServicePid) { return $true }
        $parent = 0
        try {
            $proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $current) -ErrorAction Stop
            if ($proc -and $proc.ParentProcessId) { $parent = [int]$proc.ParentProcessId }
        }
        catch {
            return $false
        }
        if ($parent -le 0 -or $parent -eq $current) { return $false }
        $current = $parent
    }
    return $false
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

# 判断文本（命令行/镜像路径）里是否出现「安装根 + 路径分隔符」。
# 为什么不能只做 IndexOf(安装根)：安装根 C:\vteam 是 C:\vteam2 的前缀，纯子串匹配会误杀另一个安装。
function Test-PathTokenInText([string]$Text, [string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Text) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    if ($Text.IndexOf($Root + '\', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    if ($Text.IndexOf($Root + '/', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    return $false
}

# 判定一个 Win32_Process 是否是本安装根的 worker node 进程：ours / unrelated / unknown。
# 依据：镜像名 node.exe + 命令行含 dist\index.js + （命令行或镜像路径）含 <安装根>。
# 为什么这么严：只按「node + dist\index.js」会命中别处部署的同款 worker，误杀代价太大。
function Get-WorkerProcessVerdict($Process, [string]$Root) {
    if ($null -eq $Process) { return 'unknown' }
    if ([string]$Process.Name -ne 'node.exe') { return 'unrelated' }
    $cmd = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return 'unknown' }
    $hasIndex = ($cmd.IndexOf('dist\index.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
                ($cmd.IndexOf('dist/index.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    if (-not $hasIndex) { return 'unrelated' }
    $hasRoot = Test-PathTokenInText -Text $cmd -Root $Root
    if (-not $hasRoot) {
        $exe = [string]$Process.ExecutablePath
        $hasRoot = Test-PathTokenInText -Text $exe -Root $Root
    }
    if ($hasRoot) { return 'ours' }
    return 'unrelated'
}

function Get-WorkerProcesses([string]$Root) {
    $result = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    }
    catch {
        Write-Warning "枚举 node.exe 进程失败（$($_.Exception.Message)）：按 pid 文件的清理仍继续。"
        return @()
    }
    foreach ($p in $procs) {
        if ((Get-WorkerProcessVerdict -Process $p -Root $Root) -eq 'ours') { $result += $p }
    }
    return $result
}

# 找残留的 opencode.exe：只清「父进程是本安装根的 node」或「命令行/镜像路径含 <安装根>」的。
# 不按镜像名无差别清理 —— 同一台机器上可能还有别的 opencode 会话。
function Get-ResidualOpencodeProcesses([string]$Root, [int[]]$KnownNodePids) {
    $result = @()
    $procs = @()
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'opencode%'" -ErrorAction Stop)
    }
    catch {
        Write-Warning "枚举 opencode 进程失败（$($_.Exception.Message)），跳过 opencode 残留清理。"
        return @()
    }
    foreach ($p in $procs) {
        $parentId = 0
        if ($p.ParentProcessId) { $parentId = [int]$p.ParentProcessId }
        $cmd = [string]$p.CommandLine
        $exe = [string]$p.ExecutablePath
        $isOurs = $false
        if ($KnownNodePids -contains $parentId) { $isOurs = $true }
        if (Test-PathTokenInText -Text $cmd -Root $Root) { $isOurs = $true }
        if (Test-PathTokenInText -Text $exe -Root $Root) { $isOurs = $true }
        if ($isOurs) { $result += $p }
    }
    return $result
}

# ── 2) 解析安装根与关键路径 ───────────────────────────────────────────────────
$installRoot = Resolve-InstallRoot -ExplicitDir $InstallDir
Write-Verbose "安装根：$installRoot"

if ((Split-Path -Leaf $installRoot) -eq 'app') {
    throw ("-InstallDir 看起来传成了 app 目录（$installRoot）。请传安装根，例如 C:\ProgramData\vteam-worker。")
}
$pidFile = Join-Path $installRoot 'run\worker.pid'
Write-Host "[stop] 安装根：$installRoot"

$whatIf = [bool]$WhatIfPreference
if ($whatIf) {
    Write-Host '[whatif] 预演模式：下面只打印将要执行的动作，不会停止服务/杀进程/删文件。'
}

# ── 3) ① 停止 Windows 服务 ────────────────────────────────────────────────────
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$servicePid = 0
if ($svc) {
    try {
        $svcCim = Get-CimInstance Win32_Service -Filter ("Name='{0}'" -f $ServiceName) -ErrorAction Stop
        if ($svcCim -and $svcCim.ProcessId) { $servicePid = [int]$svcCim.ProcessId }
    }
    catch {
        $servicePid = 0
    }
}

if ($svc) {
    $winsw = Find-WinswExe -Root $installRoot -Name $ServiceName
    $winswText = '按 SCM 处理'
    if ($winsw) { $winswText = $winsw }
    Write-Host ''
    Write-Host "[stop] ① 发现服务 $ServiceName（状态=$($svc.Status)，包装器=$winswText，PID=$servicePid）"

    if (($servicePid -gt 0) -and (Test-RunsInsideService -ServicePid $servicePid)) {
        Write-Host '[skip] 本脚本运行在服务进程树内（包装器 prestop 场景）：跳过对服务自身的 sc stop/强杀，停止由包装器完成；下面只清子进程。'
    }
    elseif ($svc.Status -eq 'Stopped') {
        Write-Host '[skip] 服务已是 Stopped，无需再停（残留子进程由下面步骤清理）。'
    }
    else {
        if ($PSCmdlet.ShouldProcess("服务 $ServiceName（当前 $($svc.Status)）", 'sc.exe stop 并等待 Stopped')) {
            Write-Host "[stop] sc.exe stop $ServiceName ..."
            $out = @()
            $rc = 1
            try {
                $out = @(& sc.exe stop $ServiceName 2>&1)
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
            if ($rc -ne 0 -and $rc -ne 1062) {
                # 1062 = 服务本来就没在运行；5 = 需要管理员；1060 = 服务不存在
                Write-Warning "sc.exe stop 返回 $rc（0=已接受 / 1062=本来未运行 / 5=权限不足 / 1060=服务不存在）"
            }

            if (Wait-ServiceStopped -Name $ServiceName -Seconds $TimeoutSec) {
                Write-Host "[ok] 服务 $ServiceName 已停止"
            }
            else {
                $curSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
                $stateText = '已不存在'
                if ($curSvc) { $stateText = [string]$curSvc.Status }
                Write-Warning "服务在 $TimeoutSec 秒内未变为 Stopped（当前：$stateText），进入强制清理"
                if ($servicePid -gt 0) {
                    if (-not (Stop-ProcessTree -ProcessId $servicePid -Reason '服务包装器进程（停止超时：强杀进程树）')) {
                        Add-StopFailure "无法结束服务包装器进程 PID $servicePid（taskkill 失败：多半是没提权，请以管理员重跑）"
                    }
                }
                else {
                    Add-StopFailure "服务停止超时且取不到服务 PID（Get-CimInstance Win32_Service）：请以管理员执行 sc.exe queryex $ServiceName 后手工 taskkill /T /F"
                }
            }
        }
    }
}
else {
    Write-Host ''
    Write-Host "[stop] ① 未发现 Windows 服务 $ServiceName（前台/计划任务模式，跳过）。"
}

# ── 4) ② 停止计划任务（无管理员自启模式）──────────────────────────────────────
$task = $null
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    try { $task = Get-ScheduledTask -TaskName $ServiceName -ErrorAction Stop }
    catch { $task = $null }
}
if ($task) {
    $taskState = [string]$task.State
    Write-Host ''
    Write-Host "[stop] ② 发现计划任务 $ServiceName（状态=$taskState）"
    if ($taskState -eq 'Disabled' -or $taskState -eq 'Ready') {
        Write-Host '[skip] 计划任务当前未运行，无需 Stop-ScheduledTask。'
    }
    else {
        if ($PSCmdlet.ShouldProcess("计划任务 $ServiceName（当前 $taskState）", 'Stop-ScheduledTask')) {
            try {
                Stop-ScheduledTask -TaskName $ServiceName -ErrorAction Stop
                Write-Host "[ok] 已请求停止计划任务 $ServiceName（它启动的进程由下面步骤按 pid/命令行清理）"
            }
            catch {
                Add-StopFailure "停止计划任务失败：$($_.Exception.Message)（可手工 schtasks.exe /End /TN '$ServiceName'）"
            }
        }
    }
}
else {
    # 极老的 Windows 没有 ScheduledTasks 模块：回退 schtasks.exe 查询。
    $rc = 1
    try {
        $null = & schtasks.exe /Query /TN $ServiceName 2>&1
        $rc = $LASTEXITCODE
    }
    catch {
        $rc = 1
    }
    if ($rc -eq 0) {
        Write-Host ''
        Write-Host "[stop] ② 发现计划任务 $ServiceName（schtasks 回退路径）"
        if ($PSCmdlet.ShouldProcess("计划任务 $ServiceName", 'schtasks /End')) {
            $rc2 = 1
            try {
                $null = & schtasks.exe /End /TN $ServiceName 2>&1
                $rc2 = $LASTEXITCODE
            }
            catch {
                $rc2 = 1
            }
            if ($rc2 -ne 0) {
                Add-StopFailure "schtasks.exe /End 返回 $rc2（可手工 schtasks.exe /End /TN '$ServiceName'）"
            }
            else {
                Write-Host "[ok] 已结束计划任务 $ServiceName 的运行实例"
            }
        }
    }
    else {
        Write-Host "[stop] ② 未发现计划任务 $ServiceName（跳过）。"
    }
}

# ── 5) ③ pid 文件 → taskkill /T /F ────────────────────────────────────────────
Write-Host ''
Write-Host '[stop] ③ 处理 pid 文件与 node 进程'
$pidFromFile = 0
$knownNodePids = New-Object System.Collections.ArrayList

if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $rawPid = ''
    try {
        $rawPid = ([System.IO.File]::ReadAllText($pidFile, [System.Text.Encoding]::UTF8)).Trim()
    }
    catch {
        Add-StopFailure "读取 pid 文件失败：$pidFile（$($_.Exception.Message)）。若 worker 由服务账户运行，请以管理员身份重跑。"
    }
    if ($rawPid -match '^\d+$') {
        $pidFromFile = [int]$rawPid
    }
    elseif ($rawPid -ne '') {
        Write-Warning "pid 文件内容不是数字（'$rawPid'），按陈旧 pid 文件处理：$pidFile"
    }
}
else {
    Write-Host "[skip] 没有 pid 文件：$pidFile"
}

if ($pidFromFile -gt 0) {
    [void]$knownNodePids.Add($pidFromFile)
    if ($pidFromFile -eq $PID) {
        Write-Warning "pid 文件指向本脚本自身（PID $pidFromFile，异常状态），跳过。"
    }
    elseif (-not (Test-ProcessAlive -ProcessId $pidFromFile)) {
        Write-Host "[skip] pid 文件指向的进程 $pidFromFile 已不存在（陈旧 pid 文件）。"
    }
    else {
        # 先核验，避免 PID 复用后把无关进程当 worker 杀掉。
        $procInfo = $null
        try {
            $procInfo = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $pidFromFile) -ErrorAction Stop
        }
        catch {
            $procInfo = $null
        }
        $verdict = 'unknown'
        if ($procInfo) { $verdict = Get-WorkerProcessVerdict -Process $procInfo -Root $installRoot }

        if ($verdict -eq 'unrelated') {
            Write-Warning ("pid 文件中的 PID $pidFromFile 不是本安装根的 worker（可能是 PID 复用或陈旧文件）：" +
                '不做强杀，避免误杀；下面用命令行匹配兜底。')
        }
        elseif ($PSCmdlet.ShouldProcess("PID $pidFromFile（来自 $pidFile）", 'taskkill /PID /T /F')) {
            if ($verdict -eq 'unknown') {
                Write-Warning "无法读取 PID $pidFromFile 的命令行（可能不是当前用户/需要提权）：仍按 pid 文件为准结束它。"
            }
            if (-not (Stop-ProcessTree -ProcessId $pidFromFile -Reason 'run\worker.pid（worker 主进程）')) {
                Add-StopFailure "无法结束 pid 文件中的 worker 进程 PID $pidFromFile（可能需要管理员权限）"
            }
        }
    }
}

# ── 6) ④ 命令行兜底扫描（pid 缺失/陈旧/不匹配时）──────────────────────────────
Write-Host ''
Write-Host "[stop] ④ 兜底扫描：命令行同时含 $installRoot 与 dist\index.js 的 node.exe"
$scanProcesses = @(Get-WorkerProcesses -Root $installRoot)
$scanPids = @()
foreach ($p in $scanProcesses) {
    $onePid = [int]$p.ProcessId
    if ($onePid -eq $PID) { continue }
    [void]$knownNodePids.Add($onePid)
    $scanPids += $onePid
}
$scanPids = @($scanPids | Select-Object -Unique)

if ($scanPids.Count -eq 0) {
    Write-Host '[skip] 未发现匹配的 worker node 进程'
}
else {
    foreach ($onePid in $scanPids) {
        if (-not $PSCmdlet.ShouldProcess("PID $onePid（命令行匹配本安装根的 worker）", 'taskkill /PID /T /F')) { continue }
        if (-not (Stop-ProcessTree -ProcessId $onePid -Reason "命令行匹配 worker（安装根 $installRoot）")) {
            Add-StopFailure "无法结束命令行匹配的 worker 进程 PID $onePid（可能需要管理员权限）"
        }
    }
}

# ── 7) opencode.exe 残留清理（仅限本安装根相关，避免误杀）──────────────────────
Write-Host ''
Write-Host '[stop] 清理 opencode serve 残留（仅父进程是 worker 或路径在本安装根下的）'
$knownNodePidsArray = @($knownNodePids | Select-Object -Unique)
$opencodeProcesses = @(Get-ResidualOpencodeProcesses -Root $installRoot -KnownNodePids $knownNodePidsArray)
$opencodePids = @()
foreach ($p in $opencodeProcesses) {
    $onePid = [int]$p.ProcessId
    if ($onePid -eq $PID) { continue }
    $opencodePids += $onePid
}
$opencodePids = @($opencodePids | Select-Object -Unique)

if ($opencodePids.Count -eq 0) {
    Write-Host '[skip] 未发现与本安装根相关的 opencode.exe 残留'
}
else {
    foreach ($onePid in $opencodePids) {
        if (-not $PSCmdlet.ShouldProcess("PID $onePid（opencode.exe 残留）", 'taskkill /PID /T /F')) { continue }
        if (-not (Stop-ProcessTree -ProcessId $onePid -Reason 'opencode serve 残留子进程（服务 TerminateProcess 不保证清子进程）')) {
            Add-StopFailure "无法结束 opencode 残留进程 PID $onePid（可能需要管理员权限）"
        }
    }
}

# ── 8) 收尾：复扫 + 清理 pid 文件 + 汇总 ──────────────────────────────────────
if ($whatIf) {
    Write-Host ''
    Write-Host '[whatif] 预演结束：未做任何改动（未停服务、未杀进程、未删 pid 文件）。'
    if ($script:Failures.Count -gt 0) {
        Write-Host "[whatif] 预演期间记录到 $($script:Failures.Count) 个错误（真跑时需处理）："
        foreach ($f in $script:Failures) { Write-Host "  - $f" }
    }
    exit 0
}

Write-Host ''
Write-Host '[stop] 收尾：确认无残留进程并清理 pid 文件'
$remaining = @(Get-WorkerProcesses -Root $installRoot)
if ($remaining.Count -gt 0) {
    $pidsText = @($remaining | ForEach-Object { [string]$_.ProcessId }) -join ', '
    Add-StopFailure ("仍有 worker node 进程存活（PID：$pidsText）。可能原因：未提权；或服务包装器又把它拉起来了。" +
        '排查：用 Get-CimInstance Win32_Process 列出 node.exe，挑 CommandLine 里含本安装根的那个（见 scripts/windows/README.md §7）。')
}
else {
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        try {
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction Stop
            Write-Host "[ok] 已删除 pid 文件：$pidFile"
        }
        catch {
            Add-StopFailure "删除 pid 文件失败：$($_.Exception.Message)（可手工删除 $pidFile）"
        }
    }
    else {
        Write-Host '[skip] 无 pid 文件需要清理'
    }
}

if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host "[result] 停止流程有 $($script:Failures.Count) 项未完成："
    foreach ($f in $script:Failures) { Write-Host "  - $f" }
    Write-Host '[result] 处理后重跑本脚本即可（幂等）。'
    exit 1
}

Write-Host ''
Write-Host '[result] 完成：worker 已停止（或本来未运行），pid 文件已清理。'
Write-Host '自检（以下应全部为空）：'
Write-Host "  Get-Service $ServiceName -ErrorAction SilentlyContinue"
Write-Host '  Get-Process opencode -ErrorAction SilentlyContinue'
Write-Host '  Get-CimInstance Win32_Process -Filter "Name=''node.exe''" | Where-Object { $_.CommandLine -like ''*dist\index.js*'' }'
Write-Host "  Test-Path '$pidFile'        # 应为 False"
Write-Host '  Get-NetTCPConnection -LocalPort 4198 -State Listen -ErrorAction SilentlyContinue   # 停止后应为空'
exit 0
