<#
.SYNOPSIS
    Windows 一键安装 vteam worker（原生，预览）：自举 Node.js/opencode CLI → 下载 worker 发布包 →
    写 .env → 注册服务（WinSW 或计划任务）→ 放行防火墙 → 安装后自检。

.DESCRIPTION
    本脚本由控制面 web 静态服务分发（web/public/install-worker.ps1）。安装页 Windows Tab 生成的命令形如：

      Invoke-WebRequest -UseBasicParsing '<控制面地址>/install-worker.ps1' -OutFile "$env:TEMP\install-worker.ps1"
      powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-worker.ps1" `
        -Server 'http://<控制面地址>' -SrcUrl '<控制面地址>/worker-src.tar.gz' `
        -WorkerId 'w_win_01' -Concurrency 8 -Token '<token>' `
        [-AdvertiseHost '192.168.1.10'] [-McpUrl 'http://<控制面>/api/v1/platform-mcp']

    为什么是「先下载成文件、再 -File 执行」而不是 `irm ... | iex`：
      irm|iex 无法传参数（只能拼环境变量/字符串，极易出错）、中途失败没有文件可复查，而且
      杀软/EDR 对「IEX + 远程下载」高度敏感（企业环境常直接拦）。成文件执行还能让企业先审后跑。
      -ExecutionPolicy Bypass 只作用于**本次进程**，不改机器的 ExecutionPolicy（不调用 Set-ExecutionPolicy）。

    安装流程（幂等：重复执行 = 修复；加 -Force = 升级）：
      ① 前置检查（Windows 版本/架构/管理员/执行策略/TLS）
      ② 目录布局 <dir>\{node,npm-global,app,work,data,logs,bin,run}
      ③ 自举便携 Node（nodejs.org → npmmirror → tuna；校验 SHASUMS256，不可达则告警继续）
      ④ npm 全局装 opencode 到 <dir>\npm-global（自检主版本必须 == 2，解析 OPENCODE_BIN）
      ⑤ 检测 Git（只检测不安装：缺失时 worker 的 git 工具族退化）
      ⑥ 停止已运行实例（调用发布包内 scripts\windows\stop-worker.ps1，不重复实现停止逻辑）
      ⑦ 下载 worker-src.tar.gz → tar.exe 解到 <dir>\app → npm ci --omit=dev
      ⑧ 生成 <dir>\app\.env（UTF-8 无 BOM；未传的键保留旧值；密钥加双引号转义）→ icacls 收紧
      ⑨ 服务化：WinSW 2.12（主选）或计划任务（回退）；-NoService 则前台运行（调用 start-worker.ps1）
      ⑩ 防火墙只放行执行端点 4198（调用发布包内 enable-firewall.ps1；-NoFirewall 跳过）
      ⑪ 自检：服务/进程 → 4198 监听 → 本机 HTTP 探测 → 提示到控制面确认 online

    ⚠️ 状态声明：本脚本**未在 Windows 真机验证**（本仓库在 macOS 上开发）。它按 Windows PowerShell 5.1
       与 PowerShell 7 双兼容编写；首次真机运行请保留完整输出与 <安装目录>\logs 便于排障。

    安全说明：
      - 任何日志都不打印 X_WORKER_TOKEN / OPENCODE_SERVER_PASSWORD 明文（只打印「已写入/已沿用」）。
      - 不调用 Set-ExecutionPolicy（不改机器执行策略）、不改系统 PATH（只在本进程内前置 PATH）。
      - 用 -Token 明文传参时 token 会落 PowerShell 命令历史（PSReadLine 的 ConsoleHost_history.txt）；
        安装结束会打印清理命令但**不自动执行**。交互式/批量场景建议省略 -Token（安全提示输入）或用 -TokenFile。
      - 不自动安装 Git：只检测并告警（静默下载 50MB+ 安装包在企业网络里更容易失败）。
      - 不修改用户 .npmrc：registry 只作为 npm 命令的 --registry 参数传入。

.PARAMETER Server
    控制面基址，缺省 http://localhost:3000。写入 .env 的 SERVER_URL。

.PARAMETER WorkerId
    worker 唯一 id（写入 WORKER_ID）；缺省 w_<计算机名>（非法字符替换为 -）。

.PARAMETER Concurrency
    并发上限（写入 WORKER_MAX_INSTANCES，取值 1-1024）。不传则不写，保留 worker 缺省 5。

.PARAMETER Token
    注册 token（写入 X_WORKER_TOKEN，需与 server 侧 WORKER_TOKEN 一致）。不传则：先沿用 .env 已有值，
    再退化为交互式 Read-Host -AsSecureString 提示输入（不回显、不进命令历史）。

.PARAMETER TokenFile
    从文件读取 token（批量/无人值守用；内容首尾空白会被去掉）。与 -Token 互斥。

.PARAMETER AdvertiseHost
    控制面可达的本机地址（写入 WORKER_ADVERTISE_HOST；可只填 IP，自动补 http://）。
    ⚠️ Windows 多网卡/WSL/Hyper-V/VPN 机器上**必须显式给**：worker 的自动探测黑名单是 Linux 网卡名口径，
    可能选中 vEthernet 的 172.x 地址 ⇒ 注册成功但派发全部 fetch failed。

.PARAMETER McpUrl
    内置 vteam MCP 地址覆盖（写入 WORKER_MCP_URL）。集群外 worker 必须设为外部可达地址
    （如 http://<控制面外部地址>/api/v1/platform-mcp）；集群内可省略（用 server 下发的默认地址）。

.PARAMETER SrcUrl
    worker 发布包完整 URL。缺省按 -WebUrl 推导，再回退 $Server/worker-src.tar.gz。
    内网反代/静态资源与控制面不同源时请显式传。

.PARAMETER WebUrl
    静态资源（install-worker.ps1 / worker-src.tar.gz 所在）基址；用于缺省推导 -SrcUrl。

.PARAMETER Dir
    安装目录（别名 -InstallDir）。缺省：管理员 → $env:ProgramData\vteam-worker；
    非管理员 → $env:LOCALAPPDATA\vteam-worker。

.PARAMETER Opencode
    opencode CLI 的 npm spec，缺省 @opencode/cli@2.0.32（与 worker/Dockerfile 同版）。
    可传 2.0.32 / v2.0.32 / latest / 完整 spec；装完强制自检主版本 == 2。

.PARAMETER NodeVersion
    便携 Node 版本，缺省 v22.12.0（与 Linux 安装脚本同版，避免两条路径版本分叉）。
    ⚠️ 服务化/计划任务模式用 `node --env-file` 加载 .env（Node >= 20.6 才支持）；只有 -NoService
    的前台模式可以接受更旧的 Node（由 start-worker.ps1 自行解析 .env）。

.PARAMETER NodePath
    复用已有 Node（传 node.exe 路径或其所在目录）；传了就不下载便携 zip。

.PARAMETER Registry
    npm 镜像，缺省 https://registry.npmmirror.com。只作为 npm 命令的 --registry 参数传入，
    不改用户 .npmrc（避免污染机器上的其它项目）。

.PARAMETER ServiceManager
    auto（缺省）/ winsw / task / none。auto = 能取得 WinSW 就用 WinSW，否则回退计划任务。

.PARAMETER WinswPath
    本地 WinSW 可执行文件（WinSW 2.12，如 WinSW.NET461.exe）；传了就不下载。

.PARAMETER WinswUrl
    WinSW 下载地址，缺省 v2.12.0 的 WinSW.NET461.exe（要求 .NET Framework 4.6.1，Win10/11/Server2019 自带；
    内网请用 -WinswPath 给本地文件，或先手工放到 <安装目录>\bin\winsw.exe）。

.PARAMETER SrcSha256
    可选：worker-src.tar.gz 的 SHA-256（与 web/public/worker-src.version.json 的 sha256 一致）。
    传了就校验，不匹配立即失败且不覆盖安装目录。

.PARAMETER SkipNpmCi
    跳过 npm ci --omit=dev。仅当发布包自带 node_modules（离线包场景）时使用；普通安装不要加
    （缺生产依赖会让 worker 启动即失败）。

.PARAMETER NoFirewall
    不创建防火墙入站规则（非管理员场景与 -NoService 配套使用）。

.PARAMETER NoService
    不注册服务/计划任务，最后前台启动（Ctrl+C 停止）。等价 -ServiceManager none。

.PARAMETER Force
    允许覆盖：重新下载并替换 app（升级）、重建服务/计划任务、接管同名但路径不同的服务。
    注意：不会强制重装已就绪的 Node/opencode（损坏或版本不符时会自动重装），避免升级时白等数百 MB。

.EXAMPLE
    # 交互式（推荐）：token 不回显、不进命令历史
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-worker.ps1 -Server 'http://10.0.0.5:3000' -WorkerId w_win_01 -AdvertiseHost 10.0.0.21

.EXAMPLE
    # 无人值守（token 放文件，装完删除该文件）
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-worker.ps1 -Server 'http://10.0.0.5:3000' -SrcUrl 'http://10.0.0.5:3000/worker-src.tar.gz' -WorkerId w_win_01 -TokenFile C:\temp\vteam-token.txt -AdvertiseHost 10.0.0.21

.EXAMPLE
    # 普通用户试用（无服务、无防火墙规则；装到 %LOCALAPPDATA%）
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-worker.ps1 -Server 'http://localhost:3000' -NoService -NoFirewall

.EXAMPLE
    # 升级（重跑 + -Force：停旧实例 → 换 app → 重启 → 自检；保留 .env 已有 token/密码）
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-worker.ps1 -Server 'http://10.0.0.5:3000' -Force

.NOTES
    文件编码：本脚本以 UTF-8（带 BOM）+ LF 保存。Windows PowerShell 5.1 对「无 BOM 的 UTF-8 脚本」按
    系统 ANSI 代码页解码 ⇒ 中文注释/输出会乱码；带 BOM 才能 5.1 与 7 都正确读取。脚本**生成**的文件
    （.env / 服务 XML / install.json）一律 UTF-8 **无 BOM**：Node 的 --env-file 读到 BOM 会让首键失效。

    退出码：成功 0；失败 1（错误信息带可操作提示）。日志：<安装目录>\logs（WinSW 模式有
    .out/.err/.wrapper.log；计划任务模式没有文件日志，排障请改用 -ServiceManager winsw 或前台模式）。

    手工执行方式（推荐）：
      powershell -NoProfile -ExecutionPolicy Bypass -File <本文件> -Server <控制面> ...
    只影响本次进程的执行策略，不改机器策略；若组策略强制 AllSigned，Bypass 会被忽略，脚本会给出提示。
#>
#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Server = 'http://localhost:3000',

    [string]$WorkerId = '',

    [int]$Concurrency = 0,

    [string]$Token = '',

    [string]$TokenFile = '',

    [string]$AdvertiseHost = '',

    [string]$McpUrl = '',

    [string]$SrcUrl = '',

    [string]$WebUrl = '',

    [Alias('InstallDir')]
    [string]$Dir = '',

    [string]$Opencode = '@opencode/cli@2.0.32',

    [string]$NodeVersion = 'v22.12.0',

    [string]$NodePath = '',

    [string]$Registry = 'https://registry.npmmirror.com',

    [ValidateSet('auto', 'winsw', 'task', 'none')]
    [string]$ServiceManager = 'auto',

    [string]$WinswPath = '',

    [string]$WinswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe',

    [string]$SrcSha256 = '',

    [switch]$SkipNpmCi,

    [switch]$NoFirewall,

    [switch]$NoService,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
# 下载进度条会让 Invoke-WebRequest 明显变慢（PS5.1 已知问题），安装器也不需要进度条。
$ProgressPreference = 'SilentlyContinue'

# --------------------------------------------------------------------------
# 固定契约（与 worker/scripts/windows/*.ps1、防火墙规则名、卸载脚本保持一致，不要改名）
# --------------------------------------------------------------------------
$Script:ServiceName = 'vteam-worker'
$Script:TaskName = 'vteam-worker'
$Script:FirewallRuleName = 'vteam-worker-exec'
$Script:ExecPort = 4198
$Script:Tag = '[install-worker]'
$Script:DefaultOpencodeSpec = '@opencode/cli@2.0.32'
$Script:WinswFileName = 'vteam-worker-service.exe'

# ==========================================================================
# 输出助手
#   为什么统一走 Write-Host：安装器的输出要让人在控制台直接看懂进度（Write-Verbose 只在 -Verbose 时出现，
#   用作「细节」），同时避免 Write-Output 污染管道/返回值。任何密钥都不进这些函数。
# ==========================================================================
function Write-Step {
    param([string]$Message)
    Write-Host ("{0} {1}" -f $Script:Tag, $Message)
}

function Write-Ok {
    param([string]$Message)
    Write-Host ("{0} ✔ {1}" -f $Script:Tag, $Message) -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("{0} ⚠️  {1}" -f $Script:Tag, $Message) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host ("{0} ERROR: {1}" -f $Script:Tag, $Message) -ForegroundColor Red
}

function Write-Detail {
    param([string]$Message)
    Write-Verbose ("{0} {1}" -f $Script:Tag, $Message)
}

function Write-List {
    param([string[]]$Lines)
    foreach ($line in $Lines) {
        Write-Host ("    {0}" -f $line)
    }
}

# ==========================================================================
# 通用小工具
# ==========================================================================
function Test-IsAdmin {
    # WindowsPrincipal.IsInRole(Administrator) 在 UAC 已提权时为 true；这是服务注册/防火墙的判据。
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Test-InteractiveHost {
    # 输入被重定向时 Read-Host 读不到人的输入（CI/远程执行），必须提前给出 -Token/-AdvertiseHost 提示。
    try {
        return (-not [Console]::IsInputRedirected)
    } catch {
        return $true
    }
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-LogTail {
    # WinSW 的日志文件名取决于 <id> 或 exe 名（2.x 行为随版本有差异），所以这里扫目录取最新几个 log，
    # 而不是硬编码一个文件名 —— 自检失败时能直接看到真正的原因。
    param([string]$LogDir, [int]$Lines = 20)
    if (-not (Test-Path -LiteralPath $LogDir)) { return '' }
    $files = @(Get-ChildItem -LiteralPath $LogDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 3)
    if ($files.Count -eq 0) { return '' }
    $parts = @()
    foreach ($file in $files) {
        $parts += ("--- {0} ---" -f $file.Name)
        $parts += @(Get-Content -LiteralPath $file.FullName -Encoding UTF8 -Tail $Lines -ErrorAction SilentlyContinue)
    }
    return ($parts -join "`n")
}

# ==========================================================================
# 下载（curl.exe 优先，Invoke-WebRequest 回退）
#   为什么优先 curl.exe：Win10 1803+ 自带，行为与 Linux 一致、不依赖 IE 引擎；PS5.1 的
#   Invoke-WebRequest 在无交互会话/代理环境下可能卡住或报「基础连接已关闭」。
# ==========================================================================
function Invoke-Download {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$OutFile,
        [switch]$Optional,
        [int]$TimeoutSec = 180
    )

    $outDir = Split-Path -Parent $OutFile
    if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }
    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }

    $ok = $false
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
        Write-Detail "curl.exe 下载：$Url"
        & $curl --fail --silent --show-error --location --retry 2 --retry-delay 2 --connect-timeout 20 --max-time $TimeoutSec --output $OutFile $Url 2>$null
        $ok = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $OutFile)
        if (-not $ok) {
            Write-Detail "curl.exe 下载失败（退出码 $LASTEXITCODE），回退 Invoke-WebRequest"
        }
    }

    if (-not $ok) {
        $oldPref = $ErrorActionPreference
        $ErrorActionPreference = 'Stop'
        try {
            Write-Detail "Invoke-WebRequest 下载：$Url"
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -TimeoutSec $TimeoutSec
            $ok = Test-Path -LiteralPath $OutFile
        } catch {
            Write-Detail "Invoke-WebRequest 下载失败：$($_.Exception.Message)"
            $ok = $false
        } finally {
            $ErrorActionPreference = $oldPref
        }
    }

    if (-not $ok) {
        if ($Optional) { return $false }
        throw ("下载失败：$Url`n" +
            "  请检查：① 目标机能否访问该地址（代理/防火墙/DNS）；② 内网环境请显式传 -SrcUrl / -WinswPath；" +
            "③ npm 相关失败可传 -Registry <内网镜像>。")
    }
    return $true
}

# ==========================================================================
# .env 读写
#   格式与 Linux 版 install-worker.sh 保持同一份文件语义（KEY=VALUE，可双平台搬运）：
#     - UTF-8 无 BOM（PS5.1 的 Out-File -Encoding utf8 会写 BOM，必须用 .NET 显式写）；
#     - 行尾统一 LF（便于和 Linux 比对；Node 的 --env-file 与手工解析都接受 LF/CRLF）；
#     - 幂等：本次要写的键先删旧行再追加，未涉及的键/注释原样保留（运维手改的配置不能被重装洗掉）。
# ==========================================================================
function Format-EnvValue {
    param([string]$Value)
    if ($null -eq $Value) { $Value = '' }
    # 裸值：允许 Windows 路径（反斜杠）、URL、字母数字等。这类值不加引号 ⇒ 不需要任何转义，
    # 也就不会出现「手工解析 .env 的脚本没反转义反斜杠」的兼容问题。
    if ($Value -match '^[A-Za-z0-9._~+/=@:\\-]+$') { return $Value }
    # 含空格/引号等：加双引号；按 .env 通行转义规则处理反斜杠与双引号。
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    return ('"' + $escaped + '"')
}

function Get-EnvValue {
    # 读 .env 中的某个键（不存在返回 $null）。忽略注释行；双引号值做反转义（与 Format-EnvValue 对称）。
    param([string]$Path, [Parameter(Mandatory)][string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $line = [string]$lines[$i]
        if ($line.Length -gt 0 -and $line[0] -eq [char]0xFEFF) { $line = $line.Substring(1) }  # 兼容历史 BOM
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $name = $line.Substring(0, $eq).Trim()
        if ($name -ne $Key) { continue }
        $raw = $line.Substring($eq + 1).Trim()
        if ($raw.Length -ge 2) {
            if ($raw[0] -eq '"' -and $raw[$raw.Length - 1] -eq '"') {
                $raw = $raw.Substring(1, $raw.Length - 2).Replace('\\', '\').Replace('\"', '"')
            } elseif ($raw[0] -eq "'" -and $raw[$raw.Length - 1] -eq "'") {
                $raw = $raw.Substring(1, $raw.Length - 2)
            }
        }
        return $raw
    }
    return $null
}

function Write-EnvFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Values
    )

    $keys = @($Values.Keys)
    $kept = @()
    if (Test-Path -LiteralPath $Path) {
        $existing = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)
        foreach ($line in $existing) {
            $trimmed = ([string]$line).Trim()
            if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { $kept += $line; continue }
            $eq = ([string]$line).IndexOf('=')
            if ($eq -lt 1) { $kept += $line; continue }
            $name = ([string]$line).Substring(0, $eq).Trim()
            if ($keys -contains $name) { continue }   # 本次写入的键：删旧行（幂等）
            $kept += $line
        }
    }

    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $kept) { $out.Add([string]$line) }
    foreach ($key in $keys) {
        $value = Format-EnvValue ([string]$Values[$key])
        $out.Add(("{0}={1}" -f $key, $value))
    }
    $text = (($out -join "`n") + "`n")
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function New-HexSecret {
    # 32 字节 CSPRNG → 64 位 hex。为什么不用 Get-Random：Get-Random 不是密码学安全随机源，
    # 而 OPENCODE_SERVER_PASSWORD 是 opencode serve 的 Basic Auth 密码。
    param([int]$ByteLength = 32)
    $bytes = New-Object byte[] $ByteLength
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        # RandomNumberGenerator 的 IDisposable 实现在不同 .NET 版本上可用性略有差异：释放失败不影响安全性。
        try { $rng.Dispose() } catch { }
    }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# ==========================================================================
# 前置检查
# ==========================================================================
function Assert-Prerequisites {
    param([switch]$NeedAdmin, [switch]$WantFirewall)

    # 平台：POSIX 上运行直接给明确错误（避免在 macOS/Linux 上误跑看到一堆莫名报错）
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw '本脚本只支持 Windows（Windows 10 1803+ / Windows 11 / Server 2019+）。Linux/macOS 请用 install-worker.sh。'
    }

    $osVersion = [System.Environment]::OSVersion.Version
    Write-Detail ("Windows 版本号：{0}.{1}.{2}" -f $osVersion.Major, $osVersion.Minor, $osVersion.Build)
    if ($osVersion.Build -lt 17134) {
        Write-Warn ("Windows 内部版本 {0} 低于 17134（Win10 1803）：系统可能没有 tar.exe（解 worker-src.tar.gz 需要）。" -f $osVersion.Build)
        Write-List @(
            '建议升级到 Windows 10 1803+ / Windows 11 / Server 2019+；',
            '或先手工在 PATH 上提供 tar.exe（例如 Git for Windows 自带的 usr\bin\tar.exe）。'
        )
    }

    # 架构：Worker 用官方便携 zip，只有 x64 / arm64 两种官方产物；32 位系统不支持。
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'x86' -and $env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    if ($arch -eq 'ARM64') {
        Write-Detail '架构：arm64（Windows on ARM）'
    } elseif ($arch -eq 'AMD64') {
        Write-Detail '架构：x64'
    } else {
        # 这里只剩真 32 位系统（x86 且没有 ARCHITEW6432）：官方 Node zip 没有 win-x86 产物。
        throw ("不支持的处理器架构：$arch（x86/32 位）。本安装器只支持 x64/arm64 的 Windows；" +
            "请在 64 位 Windows 上安装（本机也可以先用 -NodePath 指向 32 位 Node 手工试，但 out-of-box 不支持）。")
    }

    # TLS：PS5.1 在旧 .NET 上默认可能是 SSL3/TLS1.0，Win Server 2016+ 常已禁 SSL3 ⇒ 下载会莫名失败。
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        Write-Detail "设置 TLS1.2 失败（忽略）：$($_.Exception.Message)"
    }

    # ExecutionPolicy：只提示，不改。真正能决定成败的是调用方是否带了 -ExecutionPolicy Bypass。
    try {
        $policies = @(Get-ExecutionPolicy -List)
        foreach ($p in $policies) {
            if ($p.Scope -eq 'MachinePolicy' -and $p.ExecutionPolicy -eq 'AllSigned') {
                Write-Warn '机器策略（Group Policy）为 AllSigned 且可能不可覆盖：-ExecutionPolicy Bypass 会被忽略。'
                Write-List @(
                    '请让企业给本脚本签名（内网代码签名证书），或由管理员在受控范围放开/临时调整策略；',
                    '排查命令：Get-ExecutionPolicy -List'
                )
            }
        }
    } catch {
        Write-Detail "读取执行策略失败（忽略）：$($_.Exception.Message)"
    }

    if ($NeedAdmin -and -not (Test-IsAdmin)) {
        throw ("服务化安装需要管理员权限（注册 Windows 服务 / 计划任务）。`n" +
            "  请这样重跑：右键开始菜单 →『Windows PowerShell（管理员）』，再执行同一条命令；`n" +
            "  或改用「普通用户前台试用」：加 -NoService -NoFirewall（不注册服务、不放行防火墙，装到用户目录）。")
    }

    if ($WantFirewall -and -not (Test-IsAdmin)) {
        Write-Warn '当前不是管理员：将跳过防火墙规则（非管理员不能建入站规则）。'
        Write-List @(
            '装完后请让管理员执行（只放行执行端点 4198）：',
            ('  New-NetFirewallRule -Name ''{0}'' -DisplayName ''vteam worker 执行端点 (TCP {1})'' -Direction Inbound -Protocol TCP -LocalPort {1} -Action Allow -Profile Domain,Private' -f $Script:FirewallRuleName, $Script:ExecPort)
        )
    }
}

function New-DirectoryLayout {
    param([Parameter(Mandatory)][string]$InstallDir)

    $names = @('node', 'npm-global', 'app', 'work', 'data', 'logs', 'bin', 'run')
    try {
        if (-not (Test-Path -LiteralPath $InstallDir)) {
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        }
        foreach ($name in $names) {
            $path = Join-Path $InstallDir $name
            if (-not (Test-Path -LiteralPath $path)) {
                New-Item -ItemType Directory -Path $path -Force | Out-Null
            }
        }
    } catch {
        throw ("无法创建安装目录 $InstallDir：$($_.Exception.Message)`n" +
            "  常见原因：① 没有权限（ProgramData 需要管理员；普通用户请用 -NoService -NoFirewall 或 -Dir 指向用户目录）；" +
            "② 目录被安全软件锁定。")
    }
    Write-Detail ("目录布局就绪：{0}\{node,npm-global,app,work,data,logs,bin,run}" -f $InstallDir)
}

# ==========================================================================
# 便携 Node 自举
#   为什么用 zip 而不是 winget/MSI：① 不需要管理员、不写注册表/系统 PATH（卸载=删目录）；
#   ② 离线内网可随包分发；③ 版本完全可控（与 Linux 安装脚本钉同版，避免两条路径分叉）。
#   注意 Node 官方 zip 解出来的目录是 node-v22.12.0-win-x64\，node.exe 与 npm.cmd 都在**根**（不是 bin/）。
# ==========================================================================
function Get-NodeArch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'x86' -and $env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    if ($arch -eq 'ARM64') { return 'arm64' }
    return 'x64'
}

function Resolve-NodeDirectory {
    # 把 -NodePath（可能是 node.exe 或目录）解析成目录；未传返回 $null。
    param([string]$NodePath)
    if ([string]::IsNullOrWhiteSpace($NodePath)) { return $null }
    $resolved = $NodePath.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $resolved)) {
        throw ("-NodePath 指向的路径不存在：$resolved`n" +
            "  请传 node.exe 的完整路径，或 Node 安装目录（例如 C:\Program Files\nodejs）。")
    }
    $item = Get-Item -LiteralPath $resolved
    if ($item.PSIsContainer) { return $item.FullName }
    return $item.DirectoryName
}

function Get-NodeVersionOf {
    param([Parameter(Mandatory)][string]$NodeExe)
    if (-not (Test-Path -LiteralPath $NodeExe)) { return $null }
    $out = @(& $NodeExe --version 2>&1)
    if ($LASTEXITCODE -ne 0) { return $null }
    $text = (($out | Out-String).Trim())
    if ($text -match '^v?(\d+)\.(\d+)\.(\d+)') { return ($text.Trim()) }
    return $null
}

function Invoke-NodeBootstrap {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$NodeVersion,
        [string]$NodePath
    )

    $nodeDir = Join-Path $InstallDir 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    $npmCmd = Join-Path $nodeDir 'npm.cmd'

    # ① 复用显式指定的 Node（-NodePath）
    $explicitDir = Resolve-NodeDirectory -NodePath $NodePath
    if ($explicitDir) {
        $explicitExe = Join-Path $explicitDir 'node.exe'
        if (-not (Test-Path -LiteralPath $explicitExe)) {
            throw "-NodePath 目录下没有 node.exe：$explicitExe"
        }
        $explicitNpm = Join-Path $explicitDir 'npm.cmd'
        $version = Get-NodeVersionOf -NodeExe $explicitExe
        if (-not $version) { throw "无法执行 -NodePath 指定的 node.exe（--version 失败）：$explicitExe" }
        Assert-NodeVersion -VersionText $version -NodeExe $explicitExe
        Write-Ok ("复用已有 Node：{0}（{1}）" -f $explicitExe, $version)
        if (-not (Test-Path -LiteralPath $explicitNpm)) {
            throw ("-NodePath 目录下没有 npm.cmd：$explicitNpm`n" +
                "  安装 opencode 与 worker 生产依赖都需要 npm；请指向完整的 Node 安装（官方 zip/MSI 都自带 npm.cmd）。")
        }
        return [pscustomobject]@{ NodeDir = $explicitDir; NodeExe = $explicitExe; NpmCmd = $explicitNpm; Version = $version }
    }

    # ② 复用安装目录里已有的便携 Node
    if (Test-Path -LiteralPath $nodeExe) {
        $version = Get-NodeVersionOf -NodeExe $nodeExe
        $major = 0
        if ($version -and ($version -match '^v?(\d+)\.')) { $major = [int]$Matches[1] }
        if ($version -and $major -ge 18) {
            Assert-NodeVersion -VersionText $version -NodeExe $nodeExe
            Write-Ok ("复用已安装的 Node：{0}（{1}）" -f $nodeExe, $version)
            if (-not (Test-Path -LiteralPath $npmCmd)) {
                throw ("已安装的 Node 缺少 npm.cmd（$npmCmd）。`n" +
                    "  请删除目录 $nodeDir 后重跑安装器，或用 -NodePath 指向一个完整的 Node 安装。")
            }
            return [pscustomobject]@{ NodeDir = $nodeDir; NodeExe = $nodeExe; NpmCmd = $npmCmd; Version = $version }
        }
        if ($version) {
            Write-Warn ("已安装的 Node 主版本 $major 过低（$version）：worker 要求 >= 18（推荐 22 LTS），重新下载便携 Node。")
        } else {
            Write-Warn ("已存在的 $nodeExe 无法执行（可能已损坏），重新下载便携 Node。")
        }
    }

    # ③ 下载便携 zip
    $versionNormalized = $NodeVersion.Trim()
    if ($versionNormalized -notmatch '^v') { $versionNormalized = 'v' + $versionNormalized }
    if ($versionNormalized -notmatch '^v\d+\.\d+\.\d+$') {
        throw ("-NodeVersion 格式不合法：$NodeVersion（应为 v22.12.0 或 22.12.0）。")
    }
    $arch = Get-NodeArch
    $zipName = 'node-{0}-win-{1}.zip' -f $versionNormalized, $arch
    $bases = @(
        ('https://nodejs.org/dist/{0}' -f $versionNormalized),
        ('https://registry.npmmirror.com/-/binary/node/{0}' -f $versionNormalized),
        ('https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/{0}' -f $versionNormalized)
    )

    $zipPath = Join-Path $InstallDir ('run\{0}' -f $zipName)
    $sumsPath = Join-Path $InstallDir 'run\SHASUMS256.txt'
    $downloaded = $false

    foreach ($base in $bases) {
        $zipUrl = '{0}/{1}' -f $base, $zipName
        Write-Step ("下载便携 Node {0}（{1}）：{2}" -f $versionNormalized, $arch, $zipUrl)
        if (-not (Invoke-Download -Url $zipUrl -OutFile $zipPath -Optional -TimeoutSec 300)) {
            Write-Warn ("镜像不可达，换下一个：{0}" -f $base)
            continue
        }

        # SHASUMS256.txt 必须单独下载；拿不到时告警继续（不能因为没校验就装不上），但拿到了就必须匹配。
        $sumsUrl = '{0}/SHASUMS256.txt' -f $base
        $verified = $false
        if (Invoke-Download -Url $sumsUrl -OutFile $sumsPath -Optional -TimeoutSec 60) {
            $matchLine = @(Get-Content -LiteralPath $sumsPath -Encoding ASCII -ErrorAction SilentlyContinue |
                Where-Object { $_ -match [regex]::Escape($zipName) })
            if ($matchLine.Count -gt 0) {
                $want = (($matchLine[0] -split '\s+')[0]).ToLowerInvariant()
                $got = Get-FileSha256 -Path $zipPath
                if ($want -ne $got) {
                    Write-Warn ("SHASUMS256 校验不匹配（期望 {0}，实际 {1}），丢弃该下载并换下一个镜像。" -f $want, $got)
                    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
                    continue
                }
                $verified = $true
                Write-Detail ("SHA-256 校验通过：{0}" -f $got)
            } else {
                Write-Warn 'SHASUMS256.txt 中未找到对应条目，跳过校验（下载层完整性未确认）。'
            }
        } else {
            Write-Warn ("无法下载 SHASUMS256.txt（{0}），跳过校验继续。" -f $sumsUrl)
        }

        $downloaded = $true
        if (-not $verified) { Write-Detail '本次下载未经 sha256 校验（镜像未提供校验文件）。' }
        break
    }

    if (-not $downloaded) {
        throw ("无法下载便携 Node $versionNormalized（已尝试 nodejs.org / npmmirror / tuna）。`n" +
            "  内网环境请：① 把 node-$versionNormalized-win-$arch.zip 预先放到 $nodeDir 并解压；或 ② 用 -NodePath 指向已安装的 Node；" +
            "或 ③ 配好代理后重试。")
    }

    # 解压：Expand-Archive 不支持 .tar.gz，但 .zip 是它在 PS5.1 上的原生能力。
    $tmp = Join-Path $env:TEMP ('vteam-node-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Write-Step '解压便携 Node ...'
        Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp -Force
        $inner = @(Get-ChildItem -LiteralPath $tmp -Directory -ErrorAction SilentlyContinue) | Select-Object -First 1
        if (-not $inner) {
            throw ("便携 Node zip 解压后没有目录（$tmp）：压缩包可能损坏，请删除 $zipPath 后重跑安装器。")
        }
        if (Test-Path -LiteralPath $nodeDir) {
            Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        Move-Item -LiteralPath $inner.FullName -Destination $nodeDir
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $sumsPath -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $nodeExe)) {
        throw ("便携 Node 解压后仍找不到 node.exe（期望 $nodeExe）。`n" +
            "  请检查磁盘空间/安全软件拦截；也可改用 -NodePath 指向已安装的 Node。")
    }
    if (-not (Test-Path -LiteralPath $npmCmd)) {
        throw ("便携 Node 解压后找不到 npm.cmd（期望 $npmCmd）：安装包不完整，请重跑安装器。")
    }

    $version = Get-NodeVersionOf -NodeExe $nodeExe
    Assert-NodeVersion -VersionText $version -NodeExe $nodeExe
    Write-Ok ("便携 Node 就绪：{0}（{1}）" -f $nodeExe, $version)
    return [pscustomobject]@{ NodeDir = $nodeDir; NodeExe = $nodeExe; NpmCmd = $npmCmd; Version = $version }
}

function Assert-NodeVersion {
    param([string]$VersionText, [string]$NodeExe)
    if (-not $VersionText) {
        throw ("无法执行 Node（--version 失败）：$NodeExe`n" +
            "  常见原因：下载不完整、被安全软件隔离、架构不匹配（x64/arm64）。请删除该目录后重跑安装器。")
    }
    if ($VersionText -match '^v?(\d+)\.') {
        $major = [int]$Matches[1]
        if ($major -lt 18) {
            throw ("Node 主版本 $major 过低（$VersionText）：worker 要求 Node >= 18（推荐 22 LTS），" +
                "且 node --env-file 需要 >= 20.6。请用 -NodeVersion 指一个 22.x 版本，或 -NodePath 指向新版 Node。")
        }
        Write-Detail ("Node 主版本 = {0}（要求 >= 18）" -f $major)
        return
    }
    throw ("无法解析 Node 版本号：'$VersionText'（$NodeExe）。请确认该文件是官方 Node 可执行文件。")
}

# ==========================================================================
# opencode CLI：装到 <dir>\npm-global（不改 %APPDATA%\npm）
#   为什么收敛到安装目录：① 服务账户（LocalSystem）的 %APPDATA% 与安装用户不同，装在用户目录
#   服务下完全不可见；② 改 PATH 要重新登录才生效；③ 卸载=删目录、离线可整包搬运。
# ==========================================================================
function Resolve-OpencodeSpec {
    param([string]$Spec)
    $value = $Spec.Trim()
    if ($value -eq '') { return $Script:DefaultOpencodeSpec }
    if ($value -ieq 'latest') {
        Write-Warn 'opencode spec 传了 latest（浮动标签）：控制面按 opencode 版本串精确过滤 worker，建议钉版本（缺省 2.0.32）。'
        return '@opencode/cli@latest'
    }
    if ($value -match '^[vV]?\d') {
        return ('@opencode/cli@{0}' -f ($value -replace '^[vV]', ''))
    }
    if ($value -match '^@[^/]+/[^@]+@.+$') { return $value }   # 完整 scoped spec：@opencode/cli@2.0.32
    if ($value -match '^@[^/]+/[^@]+$') {
        Write-Warn ("opencode spec 未带版本（{0}）：按缺省版本钉住，避免装到 v3（worker 驱动只验证过 v2）。" -f $value)
        return ('{0}@2.0.32' -f $value)
    }
    return $value
}

function Find-OpencodeBin {
    # 解析 opencode 可执行文件绝对路径。优先 .cmd shim（与 worker README/设计一致），再退原生 exe。
    # 不要返回无扩展名的 sh 脚本：那是给 Git Bash 的，Node 的 spawn 执行不了。
    param([Parameter(Mandatory)][string]$Prefix)
    $candidates = @(
        (Join-Path $Prefix 'opencode.cmd'),
        (Join-Path $Prefix 'bin\opencode.cmd'),
        (Join-Path $Prefix 'opencode.exe'),
        (Join-Path $Prefix 'bin\opencode.exe'),
        (Join-Path $Prefix 'node_modules\@opencode\cli\bin\opencode.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-ExeVersionInfo {
    param([Parameter(Mandatory)][string]$ExePath)
    $out = @(& $ExePath --version 2>&1)
    $code = $LASTEXITCODE
    $text = (($out | Out-String).Trim())
    if ($code -ne 0) {
        return [pscustomobject]@{ Ok = $false; Text = $text; Code = $code; Major = 0 }
    }
    if ($text -match '(\d+)\.(\d+)\.(\d+)') {
        return [pscustomobject]@{ Ok = $true; Text = $text; Code = 0; Major = [int]$Matches[1] }
    }
    return [pscustomobject]@{ Ok = $false; Text = $text; Code = 0; Major = 0 }
}

function Invoke-OpencodeEnsure {
    param(
        [Parameter(Mandatory)][string]$NpmCmd,
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$Spec,
        [string]$Registry,
        [switch]$Force
    )

    # spec 里钉了具体版本时，已安装版本必须一致才复用（否则 -Opencode 2.0.40 会被静默忽略）。
    $wantVersion = ''
    if ($Spec -match '@(\d+\.\d+\.\d+)$') { $wantVersion = $Matches[1] }

    $existing = Find-OpencodeBin -Prefix $Prefix
    if ($existing -and -not $Force) {
        $info = Get-ExeVersionInfo -ExePath $existing
        $versionMatches = ($wantVersion -eq '') -or ($info.Text -match [regex]::Escape($wantVersion))
        if ($info.Ok -and $info.Major -eq 2 -and $versionMatches) {
            Write-Ok ("复用已安装的 opencode：{0}（{1}）" -f $existing, $info.Text)
            return $existing
        }
        Write-Warn ("已存在的 opencode 不符合要求（{0}；要求主版本 2$(if ($wantVersion) { '、版本 ' + $wantVersion } else { '' })），重新安装。" -f $info.Text)
    }

    Write-Step ("npm 全局安装 opencode：{0} → {1}" -f $Spec, $Prefix)
    Write-List @('opencode 是较大的原生包（数百 MB），首次安装可能需要几分钟，请勿关闭窗口。')

    $npmArgs = @('install', '-g', '--prefix', $Prefix, '--no-fund', '--no-audit')
    if ($Registry) { $npmArgs += @('--registry', $Registry) }
    $npmArgs += @($Spec)

    $npmArgsText = ($npmArgs -join ' ')
    Write-Detail ('执行：{0} {1}' -f $NpmCmd, $npmArgsText)
    # | Out-Host 是关键：本函数用返回值传 $bin，原生命令的 stdout 若留在输出流里会被
    # 调用方 `$opencodeBin = Invoke-OpencodeEnsure ...` 一起捕获 ⇒ .env 里写入一堆 npm 日志。
    & $NpmCmd @npmArgs | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw ("npm 安装 opencode 失败（退出码 $code）。`n" +
            "  常见原因：① registry 不可达（内网请传 -Registry <内网 npm 镜像>）；② 代理未配置；" +
            "③ 磁盘空间不足。`n" +
            "  可手工复现：& '$NpmCmd' $npmArgsText`n" +
            "  另：npm uninstall -g opencode-ai 可清掉 v1 时代的旧包（两个包都往全局 bin 放 opencode）。")
    }

    $bin = Find-OpencodeBin -Prefix $Prefix
    if (-not $bin) {
        throw ("npm 安装结束但没找到 opencode 可执行文件（期望 $Prefix\opencode.cmd）。`n" +
            "  npm 的 --prefix 全局 bin 落点随版本有差异：请检查 $Prefix 与 $Prefix\bin；" +
            "仍找不到时请把 npm 输出与目录清单反馈给维护者。")
    }

    # 主版本闸门：worker 驱动只验证过 v2；v1 包已冻结、v3 未验证 ⇒ 不是 2 就停下来，不带着坏 CLI 继续。
    $info = Get-ExeVersionInfo -ExePath $bin
    if (-not $info.Ok) {
        throw ("opencode 已安装但 --version 执行失败（$bin）：$($info.Text)`n" +
            "  请手工执行 & '$bin' --version 排查（缺 VC++ 运行库/被杀软拦截/平台产物缺失都可能）。")
    }
    Write-Detail ("opencode 版本输出：{0}" -f $info.Text)
    if ($info.Major -ne 2) {
        throw ("opencode 主版本为 $($info.Major)（$($info.Text)）：worker 只支持 v2（本仓库对着 @opencode/cli@2.0.32 验证）。`n" +
            "  v1 已冻结在 1.19.3（永远到不了 v2），v3 未经 worker 驱动验证。`n" +
            "  请用 -Opencode 2.0.32 显式钉版本后重跑安装器。")
    }
    Write-Ok ("opencode 就绪：{0}（{1}）" -f $bin, $info.Text)
    return $bin
}

# ==========================================================================
# Git：只检测，不自动安装
#   worker 的 git 工具族（git-tools / git-credentials）本质是调用 git.exe；没有 git 属「功能降级」
#   （Agent 只能读写工作区），不是装不上。企业网络里静默下载 50MB+ 安装包的失败率反而更高。
# ==========================================================================
function Test-GitAvailability {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if ($git) {
        $version = ''
        try { $version = ((& $git.Source --version 2>&1) | Out-String).Trim() } catch { $version = '' }
        Write-Ok ("检测到 Git：{0}（{1}）" -f $git.Source, $version)
        return $true
    }
    Write-Warn '未检测到 git.exe：worker 的 git 工具族（clone/commit/凭证注入）会不可用，其余功能正常。'
    Write-List @(
        '如需 git 能力：安装 Git for Windows（https://git-scm.com/download/win），确保 git.exe 在**系统** PATH 上（服务账户不继承用户 PATH），',
        '装完重跑本安装器（或重启 vteam-worker 服务）即可生效。'
    )
    return $false
}

# ==========================================================================
# WORKER_ADVERTISE_HOST 解析
#   Windows 上必须显式设置：worker 的自动探测黑名单是 Linux 网卡名口径（docker/veth/br-...），
#   而 Windows 的虚拟网卡叫 vEthernet (WSL)/vEthernet (Default Switch)/Tailscale ... ⇒ 会误报
#   172.x 的容器网段 ⇒ 注册成功但控制面派发全部 fetch failed（最难排查的一类问题）。
# ==========================================================================
function Format-AdvertiseHost {
    param([Parameter(Mandatory)][string]$Value)
    $v = $Value.Trim().Trim('"')
    if ($v -match '://') {
        return $v.TrimEnd('/')
    }
    return ('http://' + $v.TrimEnd('/'))
}

function Get-CandidateAdvertiseHosts {
    $rows = @()
    try {
        $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)
    } catch {
        Write-Warn ("无法枚举本机 IPv4（Get-NetIPAddress 不可用：{0}）；请直接用 -AdvertiseHost 指定。" -f $_.Exception.Message)
        return @()
    }
    $virtualPattern = '(?i)(vethernet|wsl|hyper-v|default switch|docker|loopback|tailscale|zerotier|openvpn|wireguard|anyconnect|pangp|vpn|tap|tun)'
    foreach ($addr in $addrs) {
        $ip = [string]$addr.IPAddress
        if ($ip -match '^127\.') { continue }
        if ($ip -match '^169\.254\.') { continue }   # 链路本地地址不算可达
        $isVirtual = ([string]$addr.InterfaceAlias) -match $virtualPattern
        $rows += [pscustomobject]@{
            Alias   = [string]$addr.InterfaceAlias
            IP      = $ip
            Virtual = $isVirtual
            Prefix  = $addr.PrefixLength
        }
    }
    return $rows
}

function Resolve-AdvertiseHost {
    param(
        [string]$ExplicitValue,
        [Parameter(Mandatory)][string]$EnvFile,
        [switch]$NonInteractive
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitValue)) {
        $formatted = Format-AdvertiseHost -Value $ExplicitValue
        if ($formatted -match '^(?i)https?://(127\.0\.0\.1|localhost)(:|$)') {
            Write-Warn ("-AdvertiseHost 是回环地址（{0}）：控制面（其它机器）无法访问，派发会失败。" -f $formatted)
        }
        Write-Ok ("上报地址（显式指定）：{0}" -f $formatted)
        return $formatted
    }

    $existing = Get-EnvValue -Path $EnvFile -Key 'WORKER_ADVERTISE_HOST'
    if (-not [string]::IsNullOrWhiteSpace($existing)) {
        $formatted = Format-AdvertiseHost -Value $existing
        Write-Ok ("沿用 .env 已有 WORKER_ADVERTISE_HOST：{0}" -f $formatted)
        return $formatted
    }

    $candidates = @(Get-CandidateAdvertiseHosts)
    $physical = @($candidates | Where-Object { -not $_.Virtual })
    $virtual = @($candidates | Where-Object { $_.Virtual })

    if ($virtual.Count -gt 0) {
        Write-Warn ("检测到 {0} 块虚拟网卡（WSL/Hyper-V/Docker/VPN）：它们**不能**作为上报地址。" -f $virtual.Count)
        Write-List @($virtual | ForEach-Object { ("{0} → {1}" -f $_.Alias, $_.IP) })
    }

    if ($candidates.Count -eq 0) {
        throw ("未探测到可用的非回环 IPv4 地址，无法确定 WORKER_ADVERTISE_HOST。`n" +
            "  请显式传 -AdvertiseHost <控制面可达的本机 IP>（只填 IP 即可，脚本会补 http://）。")
    }

    # 只有一个物理网卡候选：直接用它（最省事且最不容易错）
    if ($physical.Count -eq 1) {
        $pick = $physical[0]
        Write-Ok ("上报地址（探测到唯一物理网卡）：http://{0}（{1}）" -f $pick.IP, $pick.Alias)
        Write-List @('若控制面不在该网段，请用 -AdvertiseHost 显式指定控制面可达的地址。')
        return ('http://' + $pick.IP)
    }

    $pool = if ($physical.Count -gt 0) { $physical } else { $candidates }
    if ($pool.Count -gt 1) {
        Write-Warn '检测到多个候选地址（多网卡/多 IP），必须显式确认——不会静默挑一个：'
        $index = 0
        foreach ($row in $pool) {
            $index++
            $suffix = if ($row.Virtual) { '（虚拟网卡，不建议）' } else { '' }
            Write-Host ("    [{0}] {1}  →  {2}  ({3}){4}" -f $index, $row.Alias, $row.IP, $row.Prefix, $suffix)
        }
        if (-not $NonInteractive -and (Test-InteractiveHost)) {
            while ($true) {
                $answer = Read-Host ("请输入要上报的序号（1-{0}），或直接输入一个 IP" -f $pool.Count)
                $answer = ([string]$answer).Trim()
                if ($answer -match '^\d+$') {
                    $n = [int]$answer
                    if ($n -ge 1 -and $n -le $pool.Count) {
                        $chosen = $pool[$n - 1]
                        Write-Ok ("上报地址（交互选择）：http://{0}（{1}）" -f $chosen.IP, $chosen.Alias)
                        return ('http://' + $chosen.IP)
                    }
                    Write-Warn '序号超出范围，请重输。'
                    continue
                }
                if ($answer -match '^\d{1,3}(\.\d{1,3}){3}$') {
                    $formatted = Format-AdvertiseHost -Value $answer
                    Write-Ok ("上报地址（手工输入）：{0}" -f $formatted)
                    return $formatted
                }
                Write-Warn '输入无法识别：请输入序号或点分十进制 IP。'
            }
        }
    }

    throw ("无法自动确定 WORKER_ADVERTISE_HOST（探测到多个候选地址）。`n" +
        "  请在**控制面机器**上执行 Test-NetConnection <候选IP> -Port $($Script:ExecPort)，选中那个能通的地址，`n" +
        "  再用 -AdvertiseHost <IP> 重跑本安装器（这是「注册成功但派发 503/fetch failed」的根因）。")
}

# ==========================================================================
# token 解析（明文只存在于内存与 .env；不进任何日志）
# ==========================================================================
function Resolve-WorkerToken {
    param([string]$Token, [string]$TokenFile, [Parameter(Mandatory)][string]$EnvFile)

    if (-not [string]::IsNullOrWhiteSpace($Token) -and -not [string]::IsNullOrWhiteSpace($TokenFile)) {
        throw '-Token 与 -TokenFile 不能同时使用：请只保留一个（批量场景用 -TokenFile，交互场景省略两者）。'
    }

    $value = ''
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $value = $Token.Trim()
        Write-Detail 'token 来源：-Token 命令行参数'
    } elseif (-not [string]::IsNullOrWhiteSpace($TokenFile)) {
        $file = $TokenFile.Trim().Trim('"')
        if (-not (Test-Path -LiteralPath $file)) {
            throw ("-TokenFile 指向的文件不存在：$file`n" +
                "  请先写 token 到文件（单行，无额外内容），例如：Set-Content -Path C:\temp\vteam-token.txt -Value '<TOKEN>' -NoNewline -Encoding ascii")
        }
        $value = ((Get-Content -LiteralPath $file -Raw -Encoding UTF8 -ErrorAction Stop) | Out-String).Trim()
        Write-Detail "token 来源：-TokenFile $file"
        Write-Warn ("已从 $file 读取 token：安装完成后请删除该文件（del `"$file`"），避免明文留存。")
    } else {
        $existing = Get-EnvValue -Path $EnvFile -Key 'X_WORKER_TOKEN'
        if (-not [string]::IsNullOrWhiteSpace($existing) -and $existing -ne 'change-me-worker-token') {
            Write-Ok '沿用 .env 已有 X_WORKER_TOKEN（不覆盖）'
            return $existing
        }
        if (-not (Test-InteractiveHost)) {
            throw ('缺少注册 token，且当前会话不是交互式（stdin 被重定向）。' +
                "请改用 -TokenFile <path> 或 -Token <token>；交互式场景可省略两者，脚本会安全提示输入。")
        }
        Write-Step '请输入 worker 注册 token（与 server 侧 WORKER_TOKEN 一致；输入不回显、不进命令历史）'
        $secure = Read-Host -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        $value = ([string]$value).Trim()
        Write-Detail 'token 来源：交互式输入（SecureString）'
    }

    if ([string]::IsNullOrWhiteSpace($value)) {
        throw ("缺少 X_WORKER_TOKEN（注册鉴权 token，需与 server 侧 WORKER_TOKEN 一致）。`n" +
            "  交互式：重跑并省略 -Token，按提示粘贴；批量：-TokenFile <path>；或手改 <安装目录>\app\.env 后重启服务。")
    }
    if ($value -match "[\r\n]") {
        throw ('X_WORKER_TOKEN 含换行/回车：.env 是「一行一个 KEY=VALUE」的格式，换行会让配置错位。' +
            '请检查 -TokenFile 文件内容（应只有一行 token），或改用交互式输入。')
    }
    if ($value -eq 'change-me-worker-token') {
        throw ('X_WORKER_TOKEN 仍是 .env.example 的占位值 change-me-worker-token。' +
            '请到控制面 workers 页面取真实注册 token（GET /api/v1/workers/register-token），再用 -Token/-TokenFile 重跑。')
    }
    Write-Detail ("token 已就绪（长度 {0}，内容不打印）" -f $value.Length)
    return $value
}

# ==========================================================================
# worker 发布包：下载 → tar.exe 解压 → 校验 → npm ci
#   发布包（scripts/pack-worker.sh 产物）是平台无关的：dist/ + package.json + package-lock.json
#   + scripts/ + .env.example。目标机不需要任何仓库凭证，也不需要 git clone。
# ==========================================================================
function Get-TarExe {
    $candidates = @(
        (Join-Path $env:SystemRoot 'System32\tar.exe'),
        (Join-Path $env:SystemRoot 'Sysnative\tar.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $cmd = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Expand-WorkerPackage {
    param(
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$AppDir
    )

    $tar = Get-TarExe
    if (-not $tar) {
        throw ("本机没有 tar.exe（Win10 1803 及以上自带；Server 2016 及更早没有）。`n" +
            "  worker 发布包是 .tar.gz（与 Linux 同产物），请：① 升级系统；或 ② 把 Git for Windows 的 usr\bin\tar.exe 放进 PATH；" +
            "或 ③ 向维护者索取带 tar.exe 的离线包。")
    }

    Write-Step ("解压 worker 发布包：{0} → {1}" -f $ArchivePath, $AppDir)
    if (-not (Test-Path -LiteralPath $AppDir)) {
        New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
    }

    # 先清 dist/ 与 scripts/：发布包这两个目录是完整交付，覆盖解压会留下旧版残留文件
    # （例如已删除的模块仍在 dist 里），先删后解才是干净的升级。package.json / node_modules / .env 保留。
    foreach ($name in @('dist', 'scripts')) {
        $target = Join-Path $AppDir $name
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    & $tar -xzf $ArchivePath -C $AppDir
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw ("tar.exe 解压失败（退出码 $code）：$ArchivePath`n" +
            "  常见原因：① 压缩包下载不完整（可删掉重下）；② 目标目录被占用/被杀软锁定；③ 磁盘空间不足。")
    }

    $indexPath = Join-Path $AppDir 'dist\index.js'
    if (-not (Test-Path -LiteralPath $indexPath)) {
        throw ("发布包缺少 dist\index.js（$indexPath）：发布包不完整。`n" +
            "  请确认 -SrcUrl 指向的是 scripts/pack-worker.sh 的产物 worker-src.tar.gz（不是 git 源码包）。")
    }
    Write-Ok ("发布包就绪：{0}" -f $indexPath)
}

function Invoke-NpmCi {
    param(
        [Parameter(Mandatory)][string]$NpmCmd,
        [Parameter(Mandatory)][string]$AppDir,
        [string]$Registry
    )

    $lock = Join-Path $AppDir 'package-lock.json'
    if (-not (Test-Path -LiteralPath $lock)) {
        throw ("发布包缺少 package-lock.json（$lock）：无法执行 npm ci。请确认控制面 worker-src.tar.gz 完整。")
    }

    Write-Step 'npm ci --omit=dev（安装 worker 生产依赖）...'
    $npmArgs = @('ci', '--omit=dev', '--no-fund', '--no-audit')
    if ($Registry) { $npmArgs += @('--registry', $Registry) }

    $code = -1
    $pushed = $false
    Push-Location -LiteralPath $AppDir
    $pushed = $true
    try {
        Write-Detail ('执行：{0} {1}（cwd={2}）' -f $NpmCmd, ($npmArgs -join ' '), $AppDir)
        & $NpmCmd @npmArgs | Out-Host
        $code = $LASTEXITCODE
    } finally {
        # 只有真的 Push 成功才 Pop：否则会把调用方的当前位置弹掉。
        if ($pushed) { Pop-Location }
    }
    if ($code -ne 0) {
        throw ("npm ci 失败（退出码 $code）。`n" +
            "  常见原因：① npm registry 不可达（内网请传 -Registry <内网镜像>）；② package-lock.json 与 registry 元数据不一致；" +
            "③ 磁盘空间不足。`n" +
            "  也可在 $AppDir 手工复现：& '$NpmCmd' ci --omit=dev；离线包（发布包自带 node_modules）可加 -SkipNpmCi。")
    }
    Write-Ok 'worker 生产依赖安装完成'
}

# ==========================================================================
# 停止已运行实例
#   安装器**不重复实现**停止逻辑：优先调用发布包内 scripts\windows\stop-worker.ps1（由 M1 服务脚本任务实现，
#   负责服务/计划任务停止 + 进程树清理）。仅在旧发布包没有该脚本时才退化为「只让服务管理器停」并告警。
# ==========================================================================
function Get-WorkerStopScript {
    param([Parameter(Mandatory)][string]$InstallDir)
    return (Join-Path $InstallDir 'app\scripts\windows\stop-worker.ps1')
}

function Get-PortListeners {
    param([Parameter(Mandatory)][int]$Port)
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        try {
            return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        } catch {
            return @()
        }
    }
    # 极端场景（精简版系统没有 NetTCPIP 模块）：netstat 回退，只取 PID 用于提示。
    $rows = @()
    try {
        $lines = @(netstat.exe -ano -p TCP 2>$null | Select-String -SimpleMatch (':' + $Port + ' '))
        foreach ($line in $lines) {
            $text = [string]$line
            if ($text -notmatch 'LISTENING') { continue }
            $parts = @($text -split '\s+' | Where-Object { $_ -ne '' })
            $pidText = $parts[$parts.Count - 1]
            if ($pidText -match '^\d+$') {
                $rows += [pscustomobject]@{ LocalPort = $Port; State = 'Listen'; OwningProcess = [int]$pidText }
            }
        }
    } catch {
        Write-Detail "netstat 回退失败（忽略）：$($_.Exception.Message)"
    }
    return $rows
}

function Invoke-StopExisting {
    param([Parameter(Mandatory)][string]$InstallDir, [switch]$AllowMissingScript)

    $service = Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue
    $task = $null
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        try { $task = Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue } catch { $task = $null }
    }
    $listeners = @(Get-PortListeners -Port $Script:ExecPort)

    if (-not $service -and -not $task -and $listeners.Count -eq 0) {
        Write-Detail '未检测到已运行的 worker（服务/计划任务/端口都为空），按全新安装处理。'
        return
    }

    $stopScript = Get-WorkerStopScript -InstallDir $InstallDir
    if (Test-Path -LiteralPath $stopScript) {
        Write-Step ("停止已运行的 worker：{0} -InstallDir `"{1}`"" -f $stopScript, $InstallDir)
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript -InstallDir $InstallDir
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            throw ("stop-worker.ps1 执行失败（退出码 $code）：$stopScript`n" +
                "  请查看上方输出；手工排障：Get-Service $($Script:ServiceName)；Get-Process node；" +
                "必要时 taskkill /IM node.exe /T /F（确认没有其它 node 业务）后重跑安装器。")
        }
        Start-Sleep -Milliseconds 500
        $left = @(Get-PortListeners -Port $Script:ExecPort)
        if ($left.Count -gt 0) {
            throw ("stop-worker.ps1 已执行，但端口 $($Script:ExecPort) 仍在监听（PID $($left[0].OwningProcess)）。`n" +
                "  可能有残留进程：taskkill /PID $($left[0].OwningProcess) /T /F 后重跑安装器。")
        }
        Write-Ok '已停止旧实例'
        return
    }

    if (-not $AllowMissingScript) {
        Write-Warn ("发布包内没有 stop-worker.ps1（旧版本发布包？）：{0}" -f $stopScript)
        Write-Warn '将只通过服务管理器/计划任务停止；残留的 opencode 子进程可能需要手工清理。'
    }

    # 只调用服务管理器停止（不重复实现进程树清理逻辑）
    $svcExe = Join-Path $InstallDir ('bin\' + $Script:WinswFileName)
    if ($service) {
        Write-Step ("停止 Windows 服务：{0}" -f $Script:ServiceName)
        if (Test-Path -LiteralPath $svcExe) {
            & $svcExe stop 2>$null | Out-Null
        } else {
            & sc.exe stop $Script:ServiceName 2>$null | Out-Null
        }
        Start-Sleep -Seconds 2
    }
    if ($task) {
        Write-Step ("停止计划任务：{0}" -f $Script:TaskName)
        try { Stop-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue } catch {
            Write-Detail "Stop-ScheduledTask 失败（忽略）：$($_.Exception.Message)"
        }
        Start-Sleep -Seconds 1
    }
    $still = @(Get-PortListeners -Port $Script:ExecPort)
    if ($still.Count -gt 0) {
        throw ("端口 $($Script:ExecPort) 仍被占用（PID $($still[0].OwningProcess)），无法安全替换 app 目录。`n" +
            "  请手工停止该进程后重跑安装器：taskkill /PID $($still[0].OwningProcess) /T /F（或先补上发布包内 scripts\windows\stop-worker.ps1）。")
    }
    Write-Ok '已停止旧实例（未做子进程树清理，如仍占端口请手工处理）'
}

# ==========================================================================
# 防火墙
#   只放行执行端点 4198（v2 拓扑下控制面只连 worker 的执行端点）。**不要**放行 opencode serve 端口：
#   控制面不直连 serve，放行等于把本机模型代理暴露给局域网。
#   优先调用发布包内 scripts\windows\enable-firewall.ps1（规则名/幂等/回滚都由它负责）；
#   旧发布包没有脚本时内联建规则（规则名与 M0 文档一致）。
# ==========================================================================
function Enable-ExecFirewall {
    param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][int]$Port, [switch]$Skip)

    if ($Skip) {
        Write-Detail '按要求跳过防火墙规则（-NoFirewall）。'
        return
    }
    if (-not (Test-IsAdmin)) {
        Write-Warn '非管理员：跳过防火墙规则。控制面将无法访问本机执行端点（注册成功但派发失败）。'
        Write-List @(
            '请让管理员执行下面任一条（只需放行执行端点）：',
            ('  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1}' -f (Join-Path $InstallDir 'app\scripts\windows\enable-firewall.ps1'), $Port),
            ('  New-NetFirewallRule -Name ''{0}'' -DisplayName ''vteam worker 执行端点 (TCP {1})'' -Direction Inbound -Protocol TCP -LocalPort {1} -Action Allow -Profile Domain,Private' -f $Script:FirewallRuleName, $Port)
        )
        return
    }

    $fwScript = Join-Path $InstallDir 'app\scripts\windows\enable-firewall.ps1'
    if (Test-Path -LiteralPath $fwScript) {
        Write-Step ("放行防火墙入站规则（执行端点 TCP {0}）：{1}" -f $Port, $fwScript)
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fwScript -Port $Port
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            throw ("enable-firewall.ps1 执行失败（退出码 $code）。`n" +
                "  手工排障：Get-NetFirewallRule -Name '$($Script:FirewallRuleName)' | Get-NetFirewallPortFilter；" +
                "若已有同名规则但端口不符，先 Remove-NetFirewallRule -Name '$($Script:FirewallRuleName)' 再重跑安装器。")
        }
        Write-Ok '防火墙规则就绪（只放行执行端点）'
        return
    }

    Write-Warn ("发布包内没有 enable-firewall.ps1（旧版本？），使用内联规则：{0}" -f $fwScript)
    $existing = Get-NetFirewallRule -Name $Script:FirewallRuleName -ErrorAction SilentlyContinue
    if ($existing) {
        $portFilter = @($existing | Get-NetFirewallPortFilter)
        $ports = @($portFilter | ForEach-Object { [string]$_.LocalPort })
        if ($ports -contains [string]$Port) {
            Write-Ok ("防火墙规则已存在：{0}（TCP {1}）" -f $Script:FirewallRuleName, $Port)
            return
        }
        throw ("已存在防火墙规则 $($Script:FirewallRuleName) 但端口不是 $Port（实际：$($ports -join ',')）。`n" +
            "  请先删除旧规则再重跑：Remove-NetFirewallRule -Name '$($Script:FirewallRuleName)'")
    }
    # -Profile 用变量传数组：PowerShell 本身接受 `-Profile Domain,Private`（逗号在参数位置即数组），
    # 但静态语法解析器未必认这种写法；用变量两边都无歧义。
    $fwProfiles = @('Domain', 'Private')
    New-NetFirewallRule -Name $Script:FirewallRuleName -DisplayName ("vteam worker 执行端点 (TCP {0})" -f $Port) `
        -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile $fwProfiles | Out-Null
    Write-Ok ("防火墙规则已创建：{0}（TCP {1}，Domain,Private）" -f $Script:FirewallRuleName, $Port)
}

# ==========================================================================
# .env 权限收紧（icacls）
#   C:\ProgramData 默认继承 Users:(RX) ⇒ 不收权就是「本机所有用户可读 token」。
#   只保留 SYSTEM + Administrators + 运行账户（管理员安装时 worker 以 LocalSystem 运行）。
#   这不是可选项：收紧失败必须让安装失败（不能只 warn）。
# ==========================================================================
function Test-AclExposesUsers {
    # 用 SID 判断而不是名字：Windows 的组名是本地化的（中文系统显示名不同），按文本匹配会误判。
    param([Parameter(Mandatory)][string]$Path)
    try {
        $acl = Get-Acl -LiteralPath $Path
        $usersSid = 'S-1-5-32-545'   # BUILTIN\Users
        $worldSid = 'S-1-1-0'        # Everyone
        foreach ($rule in $acl.Access) {
            $sid = $null
            try {
                $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
            } catch {
                $sid = $null
            }
            if ($sid -and ($sid.Value -eq $usersSid -or $sid.Value -eq $worldSid)) {
                return $true
            }
        }
        return $false
    } catch {
        Write-Detail "Get-Acl 校验失败（$($_.Exception.Message)），回退 icacls 文本检查"
        $text = ((& icacls.exe $Path 2>$null) | Out-String)
        return ($text -match 'Users|Everyone')
    }
}

function Protect-EnvFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw ("internal: 待收权的 .env 不存在：$Path")
    }
    Write-Step "收紧 .env 权限（icacls：移除继承，仅 SYSTEM/Administrators/当前账户）"

    $grant = @('*S-1-5-18:(F)', '*S-1-5-32-544:(F)', ('{0}\{1}:(F)' -f $env:USERDOMAIN, $env:USERNAME))
    & icacls.exe $Path /inheritance:r 2>$null | Out-Null
    & icacls.exe $Path '/grant:r' $grant 2>$null | Out-Null
    # 去掉显式授权里的 Users/Everyone（继承已移除，通常无显式条目，失败忽略）
    & icacls.exe $Path '/remove:g' '*S-1-5-32-545' 2>$null | Out-Null
    & icacls.exe $Path '/remove:g' '*S-1-1-0' 2>$null | Out-Null

    if (Test-AclExposesUsers -Path $Path) {
        throw ("${Path} 的 ACL 仍对普通用户可读（收紧失败）。token/服务密码可读是安全问题，安装中止。`n" +
            "  请手工执行（管理员 PowerShell）：icacls `"$Path`" /inheritance:r /grant:r `"SYSTEM:(F)`" `"BUILTIN\Administrators:(F)`" `"$($env:USERNAME):(F)`"")
    }
    Write-Ok '.env 权限已收紧'
}

# ==========================================================================
# 服务化：WinSW 2.12
#   为什么 WinSW：单 exe 可离线捆绑、声明式 XML、崩溃重启、日志滚动、开机自启、维护活跃。
#   为什么不 sc.exe create 直挂 node：SCM 要求被启动进程 30s 内上报 SERVICE_RUNNING，
#   而 node.exe 是普通控制台程序 ⇒ `sc start` 报「错误 1053」，服务直接被判失败。
#   为什么 -ServiceManager auto 允许回退计划任务：内网常常下载不到 GitHub 的 WinSW；
#   计划任务的代价是**没有日志文件**（node stdout 无处可去）且停止无优雅信号。
# ==========================================================================
function Wait-ServiceState {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$State, [int]$TimeoutSec = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if (-not $svc) {
            if ($State -eq 'Gone') { return $true }
            return $false
        }
        if ([string]$svc.Status -eq $State) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Resolve-WinswSource {
    param([Parameter(Mandatory)][string]$InstallDir, [switch]$Required)

    $binDir = Join-Path $InstallDir 'bin'
    $cached = Join-Path $binDir 'winsw.exe'
    $installed = Join-Path $binDir $Script:WinswFileName

    if (-not [string]::IsNullOrWhiteSpace($WinswPath)) {
        $candidate = $WinswPath.Trim().Trim('"')
        if (-not (Test-Path -LiteralPath $candidate)) {
            throw ("-WinswPath 指向的文件不存在：$candidate`n" +
                "  请从 https://github.com/winsw/winsw/releases 下载 WinSW 2.12（WinSW.NET461.exe 或 WinSW-x64.exe）。")
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    if (Test-Path -LiteralPath $cached) {
        Write-Detail ("使用已缓存的 WinSW：$cached")
        return $cached
    }
    if (Test-Path -LiteralPath $installed) {
        Write-Detail ("复用已安装的 WinSW：$installed")
        return $installed
    }

    Write-Step ("下载 WinSW 2.12（Windows 服务包装器）：$WinswUrl")
    if (Invoke-Download -Url $WinswUrl -OutFile $cached -Optional -TimeoutSec 120) {
        Write-Ok 'WinSW 已下载'
        return $cached
    }
    if ($Required) {
        throw ("无法下载 WinSW：$WinswUrl`n" +
            "  内网环境请：① 把 WinSW.NET461.exe 拷到本机后用 -WinswPath <文件> 重跑；" +
            "或 ② 手工放到 $cached 后重跑；或 ③ 改用 -ServiceManager task（计划任务，无日志文件）或 -NoService。")
    }
    return $null
}

function New-WinswXmlContent {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$AppDir,
        [Parameter(Mandatory)][string]$OpencodeBin
    )
    $esc = { param($value) return [System.Security.SecurityElement]::Escape([string]$value) }

    $nodeDir = Join-Path $InstallDir 'node'
    $npmDir = Join-Path $InstallDir 'npm-global'
    $logsDir = Join-Path $InstallDir 'logs'
    $appIndex = Join-Path $AppDir 'dist\index.js'
    $pathValue = ('{0};{1};{2}\System32;{2};{2}\System32\Wbem;{2}\System32\WindowsPowerShell\v1.0' -f $nodeDir, $npmDir, $env:SystemRoot)
    # WinSW 把 <arguments> 原文交给 CreateProcess；node 的 CRT 会正确处理中间的双引号，
    # 所以路径含空格也能解析成 `--env-file=C:\...\.env` 与 `C:\...\dist\index.js` 两个参数。
    $argumentsLine = ('--env-file="{0}" "{1}"' -f $EnvFile, $appIndex)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('<?xml version="1.0" encoding="utf-8"?>')
    [void]$sb.AppendLine('<!-- 本文件由 install-worker.ps1 渲染生成。改配置请改 app\.env 后重启服务，不要手改本文件。 -->')
    [void]$sb.AppendLine('<service>')
    [void]$sb.AppendLine(('  <id>{0}</id>' -f ($esc.Invoke($Script:ServiceName))))
    [void]$sb.AppendLine('  <name>vteam AI Worker</name>')
    [void]$sb.AppendLine('  <description>vteam worker（opencode 引擎）：注册到控制面并执行 Agent 会话。</description>')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('  <!-- 主进程直接跑 node：.env 由 node 的 env-file 启动参数注入（Node >= 20.6）⇒ .env 是唯一配置源 -->')
    [void]$sb.AppendLine(('  <executable>{0}</executable>' -f ($esc.Invoke($NodeExe))))
    [void]$sb.AppendLine(('  <arguments>{0}</arguments>' -f ($esc.Invoke($argumentsLine))))
    [void]$sb.AppendLine(('  <workingdirectory>{0}</workingdirectory>' -f ($esc.Invoke($AppDir))))
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('  <!-- 服务进程不继承安装会话的 PATH：显式把便携 node/npm-global 放最前 -->')
    [void]$sb.AppendLine(('  <env name="PATH" value="{0}" />' -f ($esc.Invoke($pathValue))))
    [void]$sb.AppendLine(('  <env name="OPENCODE_BIN" value="{0}" />' -f ($esc.Invoke($OpencodeBin))))
    [void]$sb.AppendLine('  <env name="PYTHONIOENCODING" value="utf-8" />')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('  <startmode>Automatic</startmode>')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('  <!-- 崩溃重启：延迟 10s；1 小时内稳定则重置失败计数 -->')
    [void]$sb.AppendLine('  <onfailure action="restart" delay="10 sec" />')
    [void]$sb.AppendLine('  <resetfailure>1 hour</resetfailure>')
    [void]$sb.AppendLine('  <stoptimeout>15sec</stoptimeout>')
    [void]$sb.AppendLine('  <stopparentprocessfirst>true</stopparentprocessfirst>')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine(('  <logpath>{0}</logpath>' -f ($esc.Invoke($logsDir))))
    [void]$sb.AppendLine('  <log mode="roll-by-size-time">')
    [void]$sb.AppendLine('    <sizeThreshold>10240</sizeThreshold>')
    [void]$sb.AppendLine('    <pattern>yyyyMMdd</pattern>')
    [void]$sb.AppendLine('    <autoRollAtTime>00:00:00</autoRollAtTime>')
    [void]$sb.AppendLine('  </log>')
    [void]$sb.AppendLine('</service>')
    return $sb.ToString()
}

function Remove-WorkerScheduledTask {
    param([Parameter(Mandatory)][string]$InstallDir, [switch]$Force)
    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { return }
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue } catch { $task = $null }
    if (-not $task) { return }
    # 同名任务不一定是我们装的：不是本安装目录启动的就要 -Force 才肯删。
    $taskIsOurs = $false
    try {
        $execPath = [string]$task.Actions[0].Execute
        if ($execPath -and $execPath.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $taskIsOurs = $true }
    } catch { $taskIsOurs = $false }
    if (-not $taskIsOurs -and -not $Force) {
        throw ("已存在同名计划任务 $($Script:TaskName)，但它不属于本安装目录。`n" +
            "  确认要接管（删除重建）请加 -Force；或先手工删除：schtasks.exe /Delete /TN $($Script:TaskName) /F。")
    }
    Write-Step ("删除计划任务 {0}（避免与 Windows 服务重复启动）" -f $Script:TaskName)
    try { Stop-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue } catch { }
    Unregister-ScheduledTask -TaskName $Script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

function Remove-WorkerService {
    param([Parameter(Mandatory)][string]$InstallDir)
    $svc = Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    $svcExe = Join-Path $InstallDir ('bin\' + $Script:WinswFileName)
    $stopScript = Get-WorkerStopScript -InstallDir $InstallDir
    Write-Step ("删除已注册的 Windows 服务 {0}（切换服务管理器）" -f $Script:ServiceName)
    if (Test-Path -LiteralPath $stopScript) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript -InstallDir $InstallDir | Out-Null
    } elseif (Test-Path -LiteralPath $svcExe) {
        & $svcExe stop 2>$null | Out-Null
    } else {
        & sc.exe stop $Script:ServiceName 2>$null | Out-Null
    }
    [void](Wait-ServiceState -Name $Script:ServiceName -State 'Stopped' -TimeoutSec 20)
    if (Test-Path -LiteralPath $svcExe) {
        & $svcExe uninstall 2>$null | Out-Null
    }
    Start-Sleep -Seconds 1
    if (Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue) {
        & sc.exe delete $Script:ServiceName 2>$null | Out-Null
        Start-Sleep -Seconds 1
    }
    if (Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue) {
        throw ("无法删除旧服务 $($Script:ServiceName)（可能仍在停止中）。请稍后重试，或手工执行：sc.exe stop $($Script:ServiceName); sc.exe delete $($Script:ServiceName)")
    }
    Write-Ok ("已删除旧 Windows 服务：{0}" -f $Script:ServiceName)
}

function Install-WorkerWindowsService {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$WinswSource,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$AppDir,
        [Parameter(Mandatory)][string]$OpencodeBin
    )

    $binDir = Join-Path $InstallDir 'bin'
    $svcExe = Join-Path $binDir $Script:WinswFileName
    $svcXml = [System.IO.Path]::ChangeExtension($svcExe, '.xml')

    if (-not (Test-Path -LiteralPath $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    # 已存在同名服务时：先确认归属（避免把别人的服务顶掉），再停/删/重装（XML 变化必须重新注册）。
    $existing = Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        $wmi = $null
        try { $wmi = Get-CimInstance Win32_Service -Filter ("Name='{0}'" -f $Script:ServiceName) -ErrorAction SilentlyContinue } catch { $wmi = $null }
        if ($wmi -and $wmi.PathName -and ($wmi.PathName.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) {
            if (-not $Force) {
                throw ("已存在同名 Windows 服务 $($Script:ServiceName)，但它不属于本安装目录（$($wmi.PathName)）。`n" +
                    "  确认要接管请加 -Force；或先手工删除：sc.exe stop $($Script:ServiceName); sc.exe delete $($Script:ServiceName)。")
            }
            Write-Warn ("接管已存在的同名服务（-Force）：$($wmi.PathName)")
        }
    }

    if ($existing) {
        Write-Step ("停止并重新注册 Windows 服务 {0}（配置/路径可能已变化）" -f $Script:ServiceName)
        if (Test-Path -LiteralPath $svcExe) { & $svcExe stop 2>$null | Out-Null } else { & sc.exe stop $Script:ServiceName 2>$null | Out-Null }
        [void](Wait-ServiceState -Name $Script:ServiceName -State 'Stopped' -TimeoutSec 25)
        if (Test-Path -LiteralPath $svcExe) { & $svcExe uninstall 2>$null | Out-Null }
        Start-Sleep -Seconds 1
        if (Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue) {
            & sc.exe delete $Script:ServiceName 2>$null | Out-Null
            Start-Sleep -Seconds 1
        }
    }

    # 计划任务与 Windows 服务不能同时存在（会双实例抢 4198）
    Remove-WorkerScheduledTask -InstallDir $InstallDir -Force:$Force

    $sourceFull = (Resolve-Path -LiteralPath $WinswSource).Path
    if ($sourceFull -ne $svcExe) {
        Copy-Item -LiteralPath $sourceFull -Destination $svcExe -Force
    }
    if (-not (Test-Path -LiteralPath $svcExe)) {
        throw ("WinSW 复制失败：$svcExe（来源 $sourceFull）。请检查磁盘空间/杀软拦截，或改用 -ServiceManager task。")
    }

    $xmlText = New-WinswXmlContent -InstallDir $InstallDir -NodeExe $NodeExe -EnvFile $EnvFile -AppDir $AppDir -OpencodeBin $OpencodeBin
    [System.IO.File]::WriteAllText($svcXml, ($xmlText + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Detail ("WinSW 配置：$svcXml")
    # XML 里可能含账号信息（本安装器不写 serviceaccount，但保持收权习惯，便于以后扩展）
    & icacls.exe $svcXml /inheritance:r 2>$null | Out-Null
    & icacls.exe $svcXml '/grant:r' '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' 2>$null | Out-Null

    Write-Step ("注册 Windows 服务：{0}（服务名 {1}）" -f $svcExe, $Script:ServiceName)
    & $svcExe install
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw ("WinSW 注册服务失败（退出码 $code）。`n" +
            "  常见原因：① 未以管理员身份运行；② 服务名 $($Script:ServiceName) 被占用（sc.exe query $($Script:ServiceName)）；" +
            "③ XML 格式/路径非法（WinSW 2.x 旧文档还要求 <id> 纯字母数字，若报 id 非法请把服务名改为 vteamworker 并同步 -ServiceName）；`n" +
            "  手工复现：& '$svcExe' install；卸载：& '$svcExe' uninstall。")
    }

    Write-Step ("启动 Windows 服务：{0}" -f $Script:ServiceName)
    & $svcExe start
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw ("WinSW 启动服务失败（退出码 $code）。`n" +
            "  常见原因：node.exe/.env 路径错误、缺 X_WORKER_TOKEN、opencode 无法启动。`n" +
            "  日志：$(Join-Path $InstallDir 'logs')（.err.log / .wrapper.log）")
    }

    if (-not (Wait-ServiceState -Name $Script:ServiceName -State 'Running' -TimeoutSec 30)) {
        $svc = Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue
        $state = if ($svc) { [string]$svc.Status } else { 'NotFound' }
        $tail = Get-LogTail -LogDir (Join-Path $InstallDir 'logs') -Lines 20
        throw ("服务未在 30s 内进入 Running（当前状态：$state）。`n  日志尾部：`n$tail`n" +
            "  常见原因见 worker/scripts/windows/README.md 的排障表（.env 编码/token/opencode 路径）。")
    }
    Write-Ok ("Windows 服务运行中：{0}（StartType=Automatic）" -f $Script:ServiceName)
}

function New-WorkerTaskSettings {
    $interval = New-TimeSpan -Minutes 1
    try {
        return (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval $interval)
    } catch {
        Write-Warn ("计划任务设置不支持 RestartCount/RestartInterval（$($_.Exception.Message)），退化为无自动重启。")
        return (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero))
    }
}

function Install-WorkerScheduledTask {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$AppDir
    )

    if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw ("本机没有 ScheduledTasks 模块（Get-ScheduledTask 不可用），无法创建计划任务。`n" +
            "  请改用 -ServiceManager winsw（需要能取得 WinSW），或加 -NoService 前台运行。")
    }
    if (-not (Test-IsAdmin)) {
        throw ("计划任务模式需要管理员权限（任务以 SYSTEM 身份在开机时启动）。`n" +
            "  请以管理员身份重跑；或加 -NoService -NoFirewall 做普通用户前台试用。")
    }

    # Windows 服务与计划任务互斥：先删旧服务（切换服务管理器时）
    Remove-WorkerService -InstallDir $InstallDir

    $existingTask = Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        $taskIsOurs = $false
        try {
            $execPath = [string]$existingTask.Actions[0].Execute
            if ($execPath -and $execPath.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $taskIsOurs = $true
            }
        } catch {
            $taskIsOurs = $false
        }
        if (-not $taskIsOurs -and -not $Force) {
            $execPath = ''
            try { $execPath = [string]$existingTask.Actions[0].Execute } catch { }
            throw ("已存在同名计划任务 $($Script:TaskName)，但它的启动程序不在本安装目录（$execPath）。`n" +
                "  确认要接管请加 -Force（会删除旧任务重建）；或手工删除：schtasks.exe /Delete /TN $($Script:TaskName) /F。")
        }
        Write-Step ("停止并删除已有的计划任务：{0}" -f $Script:TaskName)
        try { Stop-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue } catch { }
        Unregister-ScheduledTask -TaskName $Script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    $appIndex = Join-Path $AppDir 'dist\index.js'
    # 注意：Action 直接指向 node.exe（不经 powershell）——父进程一旦被杀，powershell 不会把信号传给 node，
    # 反而更容易留下孤儿 node 进程；直接 node 也让任务管理器里能一眼看出是 worker。
    $arguments = ('--env-file="{0}" "{1}"' -f $EnvFile, $appIndex)
    $action = New-ScheduledTaskAction -Execute $NodeExe -Argument $arguments -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-WorkerTaskSettings
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    Write-Step ("注册计划任务：{0}（AtStartup / SYSTEM / Highest）" -f $Script:TaskName)
    Register-ScheduledTask -TaskName $Script:TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Description 'vteam worker（opencode 引擎）：注册到控制面并执行 Agent 会话。' -Force | Out-Null

    Write-Step ("启动计划任务：{0}" -f $Script:TaskName)
    Start-ScheduledTask -TaskName $Script:TaskName
    Start-Sleep -Seconds 2
    $task = Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        throw ("计划任务注册后不可见：$($Script:TaskName)（安全软件/组策略拦截？）。`n" +
            "  排查：Get-ScheduledTask -TaskName $($Script:TaskName)；事件查看器 → 任务计划程序。")
    }
    Write-Ok ("计划任务已注册：{0}（状态 {1}；注意：此模式没有日志文件）" -f $Script:TaskName, [string]$task.State)
}

# ==========================================================================
# 安装后自检
#   ① 服务/进程存在 → ② 4198 本机监听 → ③ 带 X-Worker-Token 本机探测执行端点（有 HTTP 响应即算通，
#   401/403/200/404/405 都正常；连接被拒才是失败）→ ④ 提示到控制面确认 online（不依赖控制面 API）。
#   探测用 GET 而不是 POST：POST /execute 可能真的触发一次执行，自检不该有副作用。
# ==========================================================================
function Test-ExecEndpoint {
    param([Parameter(Mandatory)][int]$Port, [string]$Token)
    $uri = ('http://127.0.0.1:{0}/execute' -f $Port)
    $requestParams = @{
        UseBasicParsing = $true
        Uri             = $uri
        Method          = 'Get'
        TimeoutSec      = 5
    }
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $requestParams['Headers'] = @{ 'X-Worker-Token' = $Token }
    }
    try {
        $resp = Invoke-WebRequest @requestParams
        return [pscustomobject]@{ Reachable = $true; StatusCode = [int]$resp.StatusCode; Error = '' }
    } catch {
        $response = $null
        try { $response = $_.Exception.Response } catch { $response = $null }
        if ($response) {
            $status = 0
            try { $status = [int]$response.StatusCode } catch { $status = 0 }
            return [pscustomobject]@{ Reachable = $true; StatusCode = $status; Error = '' }
        }
        return [pscustomobject]@{ Reachable = $false; StatusCode = 0; Error = $_.Exception.Message }
    }
}

function Invoke-WorkerSelfCheck {
    param(
        [Parameter(Mandatory)][string]$Manager,
        [Parameter(Mandatory)][string]$InstallDir,
        [string]$Token,
        [int]$WaitSeconds = 60
    )

    $logDir = Join-Path $InstallDir 'logs'

    # ① 服务/进程存在
    if ($Manager -eq 'winsw') {
        $svc = Get-Service -Name $Script:ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            throw ("自检失败：Windows 服务 $($Script:ServiceName) 不存在（注册没成功？）。`n" +
                "  排查：sc.exe query $($Script:ServiceName)；日志：$logDir")
        }
        if ([string]$svc.Status -ne 'Running') {
            $tail = Get-LogTail -LogDir $logDir -Lines 20
            throw ("自检失败：服务 $($Script:ServiceName) 状态为 $($svc.Status)（应为 Running）。`n  日志尾部：`n$tail")
        }
        Write-Ok ("① 服务运行中：{0}" -f $Script:ServiceName)
    } elseif ($Manager -eq 'task') {
        $task = Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue
        if (-not $task) {
            throw ("自检失败：计划任务 $($Script:TaskName) 不存在。`n  排查：Get-ScheduledTask -TaskName $($Script:TaskName)")
        }
        if ([string]$task.State -ne 'Running') {
            throw ("自检失败：计划任务 $($Script:TaskName) 状态为 $([string]$task.State)（应为 Running）。`n" +
                "  排查：计划任务属性里的『上次运行结果』；本模式没有日志文件，建议改用 -ServiceManager winsw 复现。")
        }
        Write-Ok ("① 计划任务运行中：{0}" -f $Script:TaskName)
    }

    # ② 4198 本机监听（worker 启动 serve 需要时间，最多等 WaitSeconds 秒）
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $listeners = @()
    while ((Get-Date) -lt $deadline) {
        $listeners = @(Get-PortListeners -Port $Script:ExecPort)
        if ($listeners.Count -gt 0) { break }
        Start-Sleep -Seconds 1
    }
    if ($listeners.Count -eq 0) {
        $tail = Get-LogTail -LogDir $logDir -Lines 25
        throw ("自检失败：${WaitSeconds}s 内执行端点端口 $($Script:ExecPort) 未监听。`n" +
            "  最常见原因：① .env 里 X_WORKER_TOKEN/OPENCODE_SERVER_PASSWORD 缺失；② OPENCODE_BIN 指向的文件不可执行；" +
            "③ 端口已被其它进程占用（netstat -ano | findstr :$($Script:ExecPort)）。`n  日志尾部：`n$tail")
    }
    $ownerPid = 0
    try { $ownerPid = [int]$listeners[0].OwningProcess } catch { $ownerPid = 0 }
    $ownerName = ''
    if ($ownerPid -gt 0) {
        try { $ownerName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName } catch { $ownerName = '' }
    }
    Write-Ok ("② 执行端点监听中：127.0.0.1:$($Script:ExecPort)（PID=$ownerPid $ownerName）")
    if ($ownerName -and $ownerName -ne 'node') {
        Write-Warn ("监听 $($Script:ExecPort) 的不是 node（$ownerName）：可能有其它程序占用该端口，worker 未必真的起来了。")
    }

    # ③ 带 token 本机探测（任何 HTTP 响应都算通：401/403 = 鉴权生效，200/404/405 = 路由可达）
    $probe = Test-ExecEndpoint -Port $Script:ExecPort -Token $Token
    if (-not $probe.Reachable) {
        throw ("自检失败：本机访问 http://127.0.0.1:$($Script:ExecPort)/execute 连接失败（$($probe.Error)）。`n" +
            "  排查：worker 进程是否真的在监听（PID $ownerPid）；日志：$logDir")
    }
    Write-Ok ("③ 执行端点可达：HTTP $($probe.StatusCode)（401/403 属正常：鉴权已生效）")

    # ④ 不依赖控制面 API：只给确认指引（控制面可能开在别的地址/需要登录）
    Write-Host ''
    Write-Host '  ④ 最后一步请到控制面确认：'
    Write-Host ("     workers 列表里应出现 workerId（execPort=$($Script:ExecPort)，状态 online）；")
    Write-Host ("     若一直 offline：核对 token 与控制面 WORKER_TOKEN 是否一致，并在控制面机器上执行")
    Write-Host ("     Test-NetConnection <上报IP> -Port $($Script:ExecPort)。")
}

# ==========================================================================
# 安装元数据（供卸载/排障参考；**不含任何密钥**）
# ==========================================================================
function Write-InstallMeta {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$Manager,
        [Parameter(Mandatory)][string]$WorkerId,
        [Parameter(Mandatory)][string]$Advertise,
        [Parameter(Mandatory)][string]$NodeVersion,
        [Parameter(Mandatory)][string]$OpencodeBin
    )
    $meta = [ordered]@{
        installer      = 'install-worker.ps1 (Windows M1)'
        installedAt    = (Get-Date).ToString('o')
        installDir     = $InstallDir
        serviceName    = $Script:ServiceName
        serviceManager = $Manager
        execPort       = $Script:ExecPort
        workerId       = $WorkerId
        advertiseHost  = $Advertise
        nodeVersion    = $NodeVersion
        opencodeBin    = $OpencodeBin
        logDir         = (Join-Path $InstallDir 'logs')
    }
    $path = Join-Path (Join-Path $InstallDir 'run') 'install.json'
    $json = ($meta | ConvertTo-Json -Depth 4)
    [System.IO.File]::WriteAllText($path, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Detail ("安装元数据：$path")
}

# ==========================================================================
# 结尾汇总
# ==========================================================================
function Write-InstallSummary {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$Manager,
        [Parameter(Mandatory)][string]$WorkerId,
        [Parameter(Mandatory)][string]$Advertise,
        [Parameter(Mandatory)][string]$OpencodeBin,
        [string]$NodeVersion,
        [switch]$TokenInCommandLine
    )

    $stopScript = Get-WorkerStopScript -InstallDir $InstallDir
    $uninstallScript = Join-Path $InstallDir 'app\scripts\windows\uninstall-worker.ps1'
    $logDir = Join-Path $InstallDir 'logs'

    if ($Manager -eq 'winsw') {
        $managerText = "Windows 服务 $($Script:ServiceName)（WinSW 2.12，开机自启 + 崩溃重启）"
    } elseif ($Manager -eq 'task') {
        $managerText = "计划任务 $($Script:TaskName)（AtStartup / SYSTEM；**没有日志文件**）"
    } else {
        $managerText = '前台运行（未注册服务；关闭窗口即停止）'
    }

    Write-Host ''
    Write-Host '============================================================'
    Write-Host ' 安装完成（Windows 预览版；请到控制面确认 worker 状态）'
    Write-Host '============================================================'
    Write-Host ("  安装目录    : {0}" -f $InstallDir)
    Write-Host ("  服务化      : {0}" -f $managerText)
    Write-Host ("  WorkerId    : {0}" -f $WorkerId)
    Write-Host ("  上报地址    : {0}（执行端点端口 {1}）" -f $Advertise, $Script:ExecPort)
    Write-Host ("  Node        : {0}" -f $NodeVersion)
    Write-Host ("  opencode    : {0}" -f $OpencodeBin)
    Write-Host ("  配置文件    : {0}" -f (Join-Path $InstallDir 'app\.env'))
    if ($Manager -eq 'winsw') {
        Write-Host ("  日志目录    : {0}（推荐 Get-Content <目录>\*.err.log -Tail 100 -Encoding UTF8）" -f $logDir)
    } else {
        Write-Host ("  日志目录    : {0}（本模式可能没有 worker 日志；排障请加 -ServiceManager winsw）" -f $logDir)
    }
    Write-Host ''
    Write-Host '  常用命令（管理员 PowerShell）：'
    if (Test-Path -LiteralPath $stopScript) {
        Write-Host ("    停止  : powershell -NoProfile -ExecutionPolicy Bypass -File `"{0}`" -InstallDir `"{1}`"" -f $stopScript, $InstallDir)
    } else {
        Write-Host '    停止  : 发布包内缺少 scripts\windows\stop-worker.ps1（旧包）；请重新安装或手工 sc.exe stop'
    }
    if (Test-Path -LiteralPath $uninstallScript) {
        Write-Host ("    卸载  : powershell -NoProfile -ExecutionPolicy Bypass -File `"{0}`" -InstallDir `"{1}`"  （保留 work\ 与 data\；-PurgeData 全删）" -f $uninstallScript, $InstallDir)
    } else {
        Write-Host '    卸载  : 发布包内缺少 scripts\windows\uninstall-worker.ps1（旧包）；请重新安装后再卸载'
    }
    Write-Host ("    升级  : 重跑本安装器并加 -Force（停旧实例 → 替换 app → 重启 → 自检；保留 .env 的 token/密码）")
    Write-Host ''
    Write-Host '  下一步：'
    Write-Host ("    1) 控制面 workers 页面确认 online（若 offline：核对 token 与控制面 WORKER_TOKEN）；")
    Write-Host ("    2) 在**控制面机器**上执行 Test-NetConnection <上报IP> -Port $($Script:ExecPort)（应为 True）；")
    Write-Host ("    3) 派发一个会话验证执行链路（git 功能需要目标机有 git.exe，否则该工具族不可用）。")
    Write-Host ''

    if ($TokenInCommandLine) {
        # 只在用户真的用 -Token 明文传参时提示（不自动删历史：删别人的命令历史比留一条风险更大）
        Write-Warn '本次用 -Token 明文传参：token 已进入 PowerShell 命令历史（PSReadLine）。'
        Write-List @(
            '清理建议（手工执行，确认无其它需要保留的历史再删）：',
            '  Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue',
            '或只删含 token 的行：Clear-History 只清当前会话；历史文件需按上面命令删除。'
        )
    }
}

# ==========================================================================
# 主流程
# ==========================================================================
$installDir = ''
$exitCode = 0

try {
    Write-Host ''
    Write-Host '============================================================'
    Write-Host ' vteam worker — Windows 一键安装器（M1 预览）'
    Write-Host ' 状态：未在 Windows 真机验证；失败请保留完整输出与安装目录下的日志'
    Write-Host '============================================================'
    Write-Host ''

    # ------------------------------ 0. 参数组合校验 ------------------------------
    if ($NoService -and ($ServiceManager -eq 'winsw' -or $ServiceManager -eq 'task')) {
        throw ("-NoService 与 -ServiceManager $ServiceManager 冲突：-NoService 等价于 -ServiceManager none。")
    }
    if ($PSBoundParameters.ContainsKey('Concurrency')) {
        if ($Concurrency -lt 1 -or $Concurrency -gt 1024) {
            throw ("-Concurrency 必须是 1-1024 的正整数（当前：$Concurrency）。它写入 WORKER_MAX_INSTANCES，随注册上报 capabilities.maxInstances。")
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($SrcSha256) -and ($SrcSha256.Trim() -notmatch '^[0-9A-Fa-f]{64}$')) {
        throw ("-SrcSha256 必须是 64 位十六进制字符串（当前：$SrcSha256）。可用 worker-src.version.json 里的 sha256。")
    }

    $serverUrl = $Server.Trim().TrimEnd('/')
    if ($serverUrl -notmatch '^https?://') {
        throw ("-Server 必须是 http:// 或 https:// 开头的控制面基址（当前：$Server）。")
    }
    $reg = $Registry.Trim()
    if ([string]::IsNullOrWhiteSpace($reg)) { $reg = $null }
    if (-not [string]::IsNullOrWhiteSpace($McpUrl) -and ($McpUrl.Trim() -notmatch '^https?://')) {
        throw ("-McpUrl 必须是 http(s):// 开头的完整地址（当前：$McpUrl），例如 http://<控制面外部地址>/api/v1/platform-mcp。")
    }

    # ------------------------------ 1. 前置检查 ------------------------------
    # -NoService 与 -ServiceManager none 都表示「不注册服务」⇒ 不需要管理员权限。
    $scriptService = -not ($NoService -or ($ServiceManager -eq 'none'))
    Assert-Prerequisites -NeedAdmin:$scriptService -WantFirewall:(-not $NoFirewall)
    $isAdmin = Test-IsAdmin

    # ------------------------------ 2. 安装目录 ------------------------------
    if (-not [string]::IsNullOrWhiteSpace($Dir)) {
        $installDir = [System.IO.Path]::GetFullPath($Dir.Trim().Trim('"'))
    } elseif ($isAdmin) {
        # ProgramData 在极少数精简/特殊会话里可能为空：回退到系统盘根下的 ProgramData 约定位置。
        $programData = $env:ProgramData
        if ([string]::IsNullOrWhiteSpace($programData)) { $programData = Join-Path $env:SystemDrive 'ProgramData' }
        $installDir = Join-Path $programData 'vteam-worker'
    } else {
        $localAppData = $env:LOCALAPPDATA
        if ([string]::IsNullOrWhiteSpace($localAppData)) { $localAppData = $env:USERPROFILE }
        $installDir = Join-Path $localAppData 'vteam-worker'
    }
    if ($installDir.Length -gt 3) { $installDir = $installDir.TrimEnd('\') }
    Write-Step ("安装目录：$installDir")
    New-DirectoryLayout -InstallDir $installDir

    $appDir = Join-Path $installDir 'app'
    $envFile = Join-Path $appDir '.env'
    $logDir = Join-Path $installDir 'logs'

    # ------------------------------ 3. token / 上报地址 ------------------------------
    # token 先解析：交互式输入放在最前面，避免下载几分钟后才提示要输入。
    $tokenValue = Resolve-WorkerToken -Token $Token -TokenFile $TokenFile -EnvFile $envFile
    $tokenFromCli = -not [string]::IsNullOrWhiteSpace($Token)

    $advertise = Resolve-AdvertiseHost -ExplicitValue $AdvertiseHost -EnvFile $envFile

    # ------------------------------ 4. 便携 Node ------------------------------
    # 注意：-Force 只用于「重下发布包 / 重建服务」，不强制重装 Node/opencode ——
    # 它们已就绪时复用（损坏/版本不符会自动重装），避免升级时白等几百 MB 下载。
    $node = Invoke-NodeBootstrap -InstallDir $installDir -NodeVersion $NodeVersion -NodePath $NodePath
    # PATH 只在**本进程**前置：安装期 npm/opencode 立即可用；系统 PATH 一个字节都不改（卸载=删目录）。
    # 服务化时 WinSW XML 里单独写 PATH（服务进程不继承安装会话的环境）。
    $env:PATH = $node.NodeDir + ';' + $env:PATH
    Write-Detail ("本进程 PATH 已前置：{0}" -f $node.NodeDir)

    # ------------------------------ 5. opencode CLI ------------------------------
    $npmGlobalDir = Join-Path $installDir 'npm-global'
    $opencodeSpec = Resolve-OpencodeSpec -Spec $Opencode
    $opencodeBin = Invoke-OpencodeEnsure -NpmCmd $node.NpmCmd -Prefix $npmGlobalDir -Spec $opencodeSpec -Registry $reg

    # ------------------------------ 6. Git 检测 ------------------------------
    [void](Test-GitAvailability)

    # ------------------------------ 7. 发布包：下载 / 复用 ------------------------------
    $indexPath = Join-Path $appDir 'dist\index.js'
    $reuseApp = ((Test-Path -LiteralPath $indexPath) -and (-not $Force))

    if ($reuseApp) {
        Write-Warn ("复用已有 worker 发布包（{0}）：跳过下载/解压。升级到新版本请加 -Force。" -f $appDir)
        if (-not (Test-Path -LiteralPath (Join-Path $appDir 'scripts\windows\stop-worker.ps1'))) {
            Write-Warn '已有发布包内没有 scripts\windows\stop-worker.ps1（旧包）：停止/卸载会退化为服务管理器命令。'
        }
    } else {
        $src = $SrcUrl.Trim()
        if ([string]::IsNullOrWhiteSpace($src)) {
            if (-not [string]::IsNullOrWhiteSpace($WebUrl)) {
                $src = $WebUrl.Trim().TrimEnd('/') + '/worker-src.tar.gz'
            } else {
                $src = $serverUrl + '/worker-src.tar.gz'
                Write-Warn ("未显式传 -SrcUrl：按控制面地址推导 $src")
                Write-List @('若 worker 发布包不在控制面同源（内网反代/静态资源独立域名），请显式传 -SrcUrl <worker-src.tar.gz 完整 URL>（**内网环境建议总是显式传 -SrcUrl**）。')
            }
        }
        $archive = Join-Path (Join-Path $installDir 'run') 'worker-src.tar.gz'
        Write-Step ("下载 worker 发布包：$src")
        [void](Invoke-Download -Url $src -OutFile $archive -TimeoutSec 300)
        if (-not [string]::IsNullOrWhiteSpace($SrcSha256)) {
            $want = $SrcSha256.Trim().ToLowerInvariant()
            $got = Get-FileSha256 -Path $archive
            if ($want -ne $got) {
                Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
                throw ("worker-src.tar.gz 的 SHA-256 校验不匹配（期望 $want，实际 $got）。已删除下载文件，安装目录未被改动。`n" +
                    "  请核对 web/public/worker-src.version.json 的 sha256；或确认静态资源是否被缓存/代理篡改。")
            }
            Write-Ok 'worker-src.tar.gz SHA-256 校验通过'
        }
        # 先停旧实例再替换 app：node 正在运行时覆盖 dist/脚本目录是自找麻烦。
        Invoke-StopExisting -InstallDir $installDir
        Expand-WorkerPackage -ArchivePath $archive -AppDir $appDir
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }

    # ------------------------------ 8. worker 生产依赖 ------------------------------
    $nodeModulesDir = Join-Path $appDir 'node_modules'
    if ($SkipNpmCi) {
        Write-Warn '-SkipNpmCi：跳过 npm ci。仅适用于发布包自带 node_modules 的离线场景（缺生产依赖会启动即失败）。'
    } elseif ((-not $reuseApp) -or (-not (Test-Path -LiteralPath $nodeModulesDir))) {
        Invoke-NpmCi -NpmCmd $node.NpmCmd -AppDir $appDir -Registry $reg
    } else {
        Write-Ok '复用已有 node_modules（跳过 npm ci；要强制重装请加 -Force）'
    }

    # ------------------------------ 9. .env ------------------------------
    $serverPassword = Get-EnvValue -Path $envFile -Key 'OPENCODE_SERVER_PASSWORD'
    if ([string]::IsNullOrWhiteSpace($serverPassword) -or $serverPassword -eq 'change-me-serve-password') {
        $serverPassword = New-HexSecret -ByteLength 32
        Write-Ok '已生成随机 OPENCODE_SERVER_PASSWORD（64 位 hex，写入 .env；不打印明文）'
    } else {
        Write-Ok '沿用 .env 已有 OPENCODE_SERVER_PASSWORD（不覆盖；不打印明文）'
    }

    $workerIdValue = $WorkerId.Trim()
    if ([string]::IsNullOrWhiteSpace($workerIdValue)) {
        $hostName = $env:COMPUTERNAME
        if ([string]::IsNullOrWhiteSpace($hostName)) { $hostName = 'win' }
        $workerIdValue = 'w_' + ($hostName -replace '[^A-Za-z0-9_-]', '-')
    }
    if ($workerIdValue.Length -gt 120) {
        throw ("-WorkerId 过长（$($workerIdValue.Length) 字符，上限 120）：请用简短的机器标识，如 w_win_01。")
    }

    $envValues = [ordered]@{}
    $envValues['SERVER_URL'] = $serverUrl
    $envValues['X_WORKER_TOKEN'] = $tokenValue
    $envValues['WORKER_ID'] = $workerIdValue
    $envValues['WORKER_ENGINE'] = 'opencode'
    $envValues['OPENCODE_BIN'] = $opencodeBin
    $envValues['OPENCODE_SERVER_PASSWORD'] = $serverPassword
    $envValues['WORKER_EXEC_PORT'] = [string]$Script:ExecPort
    if ($PSBoundParameters.ContainsKey('Concurrency')) {
        $envValues['WORKER_MAX_INSTANCES'] = [string]$Concurrency
    }
    $envValues['WORKER_ADVERTISE_HOST'] = $advertise
    if (-not [string]::IsNullOrWhiteSpace($McpUrl)) {
        $envValues['WORKER_MCP_URL'] = $McpUrl.Trim()
    }
    # Windows 专属路径：不写 WORK_DIR 的话 /data/vteam-worker 会被解析成「当前盘符根下 \data\...」，
    # 看着能跑但与安装目录分离，卸载删不干净（worker README 已写明）。
    $envValues['WORK_DIR'] = Join-Path $installDir 'work'
    $envValues['OPENCODE_ISOLATION_ROOT'] = Join-Path $installDir 'data'
    $envValues['WORKER_WINDOWS_SELF_UPDATE'] = '0'

    Write-Step ("写入配置：$envFile")
    Write-EnvFile -Path $envFile -Values $envValues
    Protect-EnvFile -Path $envFile
    Write-Ok '配置已写入（UTF-8 无 BOM；未传的键保留旧值）'

    if ([string]::IsNullOrWhiteSpace($McpUrl)) {
        $existingMcp = Get-EnvValue -Path $envFile -Key 'WORKER_MCP_URL'
        if ([string]::IsNullOrWhiteSpace($existingMcp)) {
            Write-Warn '未配置 WORKER_MCP_URL：集群外 worker 的内置 vteam MCP 将不可达（server 下发的是集群内服务名）。'
            Write-List @(
                '集群外请设置：-McpUrl ''http://<控制面外部地址>/api/v1/platform-mcp''（或手改 .env 后重启服务）；',
                '集群内 worker 可忽略。'
            )
        }
    }

    # ------------------------------ 10. 服务管理器选择 ------------------------------
    $manager = 'none'
    $winswSource = $null
    if ((-not $NoService) -and ($ServiceManager -ne 'none')) {
        if ($ServiceManager -eq 'auto') {
            $winswSource = Resolve-WinswSource -InstallDir $installDir -Required:$false
            if ($winswSource) {
                $manager = 'winsw'
            } else {
                $manager = 'task'
                Write-Warn '未取得 WinSW（下载失败且无本地文件），回退计划任务。'
                Write-List @(
                    '计划任务模式的代价：没有日志文件、停止无优雅信号；',
                    '内网建议预先准备 WinSW 2.12 后用 -ServiceManager winsw -WinswPath <文件> 重跑。'
                )
            }
        } elseif ($ServiceManager -eq 'winsw') {
            $winswSource = Resolve-WinswSource -InstallDir $installDir -Required:$true
            $manager = 'winsw'
        } else {
            $manager = 'task'
        }
    }
    # 服务/计划任务模式都用 `node --env-file=<dir>\app\.env` 加载配置（.env 单一事实源），
    # 该参数从 Node 20.6 才有；旧 Node 会在服务启动时直接报 bad option（很隐蔽），所以这里提前拦。
    if ($manager -ne 'none' -and $node.Version -match '^v?(\d+)\.(\d+)\.') {
        $nodeMajor = [int]$Matches[1]
        $nodeMinor = [int]$Matches[2]
        if ($nodeMajor -lt 20 -or ($nodeMajor -eq 20 -and $nodeMinor -lt 6)) {
            throw ("当前 Node $($node.Version) 不支持 node --env-file（需要 >= 20.6；服务/计划任务模式靠它加载 .env）。`n" +
                "  请用 -NodeVersion v22.12.0 重跑（安装器会自举便携 Node），或 -NodePath 指向 Node >= 20.6；" +
                "仅前台试用（-NoService，走 start-worker.ps1 自解析 .env）才可以用更旧的 Node。")
        }
    }

    Write-InstallMeta -InstallDir $installDir -Manager $manager -WorkerId $workerIdValue -Advertise $advertise `
        -NodeVersion $node.Version -OpencodeBin $opencodeBin

    # ------------------------------ 11. 防火墙 ------------------------------
    Enable-ExecFirewall -InstallDir $installDir -Port $Script:ExecPort -Skip:$NoFirewall

    # ------------------------------ 12. 服务化 / 前台 ------------------------------
    if ($manager -eq 'none') {
        # 前台模式也要先把旧服务/计划任务停掉，否则会和旧实例抢 4198（双实例）。
        Invoke-StopExisting -InstallDir $installDir -AllowMissingScript
    }

    # 确认端口没被**别人的**进程占用（属于本安装目录的旧实例会被上面的停止流程/注册流程停掉）
    $busy = @(Get-PortListeners -Port $Script:ExecPort)
    if ($busy.Count -gt 0) {
        $ownerPid = 0
        try { $ownerPid = [int]$busy[0].OwningProcess } catch { $ownerPid = 0 }
        $ownerInfo = $null
        if ($ownerPid -gt 0) {
            try { $ownerInfo = Get-CimInstance Win32_Process -Filter ("ProcessId=$ownerPid") -ErrorAction SilentlyContinue } catch { $ownerInfo = $null }
        }
        $isOurs = $false
        if ($ownerInfo -and $ownerInfo.CommandLine -and $ownerInfo.CommandLine.IndexOf($installDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $isOurs = $true
        }
        if (-not $isOurs) {
            $ownerName = ''
            if ($ownerPid -gt 0) {
                try { $ownerName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName } catch { $ownerName = '' }
            }
            throw ("执行端点端口 $($Script:ExecPort) 已被其它进程占用（PID $ownerPid $ownerName），worker 无法监听。`n" +
                "  请先停止该进程（taskkill /PID $ownerPid /T /F，确认不是其它业务），再重跑安装器。")
        }
    }

    if ($manager -eq 'none') {
        # 前台启动：阻塞到 Ctrl+C/进程退出；退出码透传（便于脚本化判断）。
        Write-InstallSummary -InstallDir $installDir -Manager 'none' -WorkerId $workerIdValue -Advertise $advertise `
            -OpencodeBin $opencodeBin -NodeVersion $node.Version -TokenInCommandLine:$tokenFromCli
        Write-Host ''
        Write-Step '前台启动 worker（Ctrl+C 停止；本模式不注册服务、不开机自启）'
        $startScript = Join-Path $installDir 'app\scripts\windows\start-worker.ps1'
        if (Test-Path -LiteralPath $startScript) {
            # 优先用发布包内的 start-worker.ps1：它负责 .env 解析校验、目录创建、pid 文件（stop-worker 依赖），
            # 与「服务/手工排障」共用同一套启动语义（安装器不重复实现启动逻辑）。
            Write-Host ("    启动器：{0}" -f $startScript)
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -InstallDir $installDir
            $exitCode = $LASTEXITCODE
        } else {
            # 旧发布包（pre-M1）没有 start-worker.ps1：退化为直接跑 node（node --env-file 是设计主线之一）。
            Write-Warn '发布包内没有 scripts\windows\start-worker.ps1（旧包）：直接前台运行 node --env-file。'
            Write-Host ("    等价命令：& `"{0}`" `"--env-file={1}`" `"{2}`"" -f $node.NodeExe, $envFile, (Join-Path $appDir 'dist\index.js'))
            $pushed = $false
            Push-Location -LiteralPath $appDir
            $pushed = $true
            try {
                & $node.NodeExe ("--env-file=$envFile") (Join-Path $appDir 'dist\index.js')
                $exitCode = $LASTEXITCODE
            } finally {
                if ($pushed) { Pop-Location }
            }
        }
        Write-Step ("worker 已退出（退出码 {0}）" -f $exitCode)
        exit $exitCode
    }

    if ($manager -eq 'winsw') {
        Install-WorkerWindowsService -InstallDir $installDir -WinswSource $winswSource -NodeExe $node.NodeExe `
            -EnvFile $envFile -AppDir $appDir -OpencodeBin $opencodeBin
    } else {
        Install-WorkerScheduledTask -InstallDir $installDir -NodeExe $node.NodeExe -EnvFile $envFile -AppDir $appDir
    }

    # ------------------------------ 13. 自检 ------------------------------
    Invoke-WorkerSelfCheck -Manager $manager -InstallDir $installDir -Token $tokenValue -WaitSeconds 60

    # ------------------------------ 14. 汇总 ------------------------------
    Write-InstallSummary -InstallDir $installDir -Manager $manager -WorkerId $workerIdValue -Advertise $advertise `
        -OpencodeBin $opencodeBin -NodeVersion $node.Version -TokenInCommandLine:$tokenFromCli

    Write-Ok '安装结束（可重复执行本命令做修复；升级加 -Force）'
    exit 0
} catch {
    Write-Host ''
    Write-Fail ([string]$_.Exception.Message)
    Write-Host ''
    Write-Host '  排障提示：'
    Write-Host '    - 保留完整输出与 <安装目录>\logs（WinSW 模式）后重试；'
    Write-Host '    - 重复执行本安装器是幂等的（修复）；加 -Force 可强制重下发布包/重建服务（升级）；'
    Write-Host '    - 前台验证可加 -NoService -NoFirewall（不需要管理员，装到用户目录）；'
    if (-not [string]::IsNullOrWhiteSpace($installDir)) {
        Write-Host ("    - 安装目录：{0}" -f $installDir)
    }
    Write-Host '    - 文档：worker/scripts/windows/README.md、worker/README.md「Windows（原生，预览）」'
    exit 1
}

