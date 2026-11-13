<#
.SYNOPSIS
    为 vteam worker 的执行端点创建 Windows 防火墙「入站放行」规则（幂等，支持 -WhatIf）。

.DESCRIPTION
    为什么只放行执行端点（缺省 4198）：
      - v2 拓扑下控制面**只连 worker 的执行端点**（node:http 的 POST /execute，端口取
        env WORKER_EXEC_PORT，缺省 4198）：注册、心跳、派单、事件回流都走 worker 进程本身。
      - opencode serve 绑在回环地址（env OPENCODE_SERVE_HOSTNAME，缺省 127.0.0.1），
        控制面**不直连** serve ⇒ **不要**把 OPENCODE_SERVE_PORT 放行到入站：
        那等于把本机的模型代理暴露给局域网，而且 serve 没有控制面的 token 校验语义。
      - 因此本脚本只建一条规则，名字固定为 `vteam-worker-exec`（卸载/回滚按名字删，
        不要手工改名字，否则运维文档和卸载脚本会对不上）。

    行为：
      1) 需要管理员权限（New-NetFirewallRule / Get-NetFirewallRule 都要提权），
         未提权时直接抛出可读错误并提示「以管理员身份运行」；
      2) 先按规则名查：已存在且端口一致 ⇒ 幂等跳过（退出码 0）；
         已存在但端口不一致 ⇒ 报错（退出码非 0）并打印「先删后建」的命令，不静默改动；
      3) -WhatIf 只打印将要做什么（由 PowerShell 的 ShouldProcess 输出 What if 行），
         不会真的创建规则；
      4) 结束前统一打印回滚命令与自检命令。

.PARAMETER Port
    执行端点端口，缺省 4198（与 env WORKER_EXEC_PORT 保持一致）。
    只有改了 WORKER_EXEC_PORT 才需要同步传这个参数。

.PARAMETER Profile
    规则生效的网络配置文件（Network Profile），缺省 Domain,Private（域网络 + 专用网络），
    不默认放行 Public（公共网络/咖啡厅 Wi-Fi 不应放行）。可传数组：-Profile Domain,Private；
    也可以 -Profile Any（不建议，等于三个 profile 全开）。

.PARAMETER RemoteAddress
    可选：限定来源地址（如控制面网段），示例 -RemoteAddress '10.0.0.0/8','192.168.1.0/24'。
    不填 = 任意来源（仍要求控制面能路由到本机，规则不是唯一防线）。

.EXAMPLE
    # 以管理员身份打开 PowerShell（开始菜单搜索 PowerShell → 右键「以管理员身份运行」），然后：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\worker\scripts\windows\enable-firewall.ps1

.EXAMPLE
    # 只预演，不落规则：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\worker\scripts\windows\enable-firewall.ps1 -WhatIf

.EXAMPLE
    # 换端口 + 只允许控制面网段：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\worker\scripts\windows\enable-firewall.ps1 -Port 4200 -RemoteAddress '10.0.0.0/8'

.NOTES
    执行方式：本脚本按「进程级执行」使用 —— `powershell -NoProfile -ExecutionPolicy Bypass -File <本文件>`，
    只影响这一次进程，不修改机器的 ExecutionPolicy（不要 Set-ExecutionPolicy 全局放开）。

    域环境注意：若防火墙策略由 GPO 统一管理，本脚本创建的规则可能被 GPO 覆盖；
    先运行 Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction 看现状。

    验证状态：**未在 Windows 真机验证**（本仓库在 macOS 上开发，脚本按 Windows PowerShell 5.1 语法编写）。
    真机验证时请重点确认：规则 read-back 的 LocalPort/Profile/Action 与预期一致、
    以及控制面机器上 Test-NetConnection <worker IP> -Port 4198 能通。

    回滚：Remove-NetFirewallRule -Name 'vteam-worker-exec'
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [int]$Port = 4198,

    [ValidateSet('Domain', 'Private', 'Public', 'Any')]
    [string[]]$Profile = @('Domain', 'Private'),

    [string[]]$RemoteAddress = @()
)

$ErrorActionPreference = 'Stop'

# 规则名/组名固定：安装、卸载、文档都按这个名字引用，不要改。
$RuleName = 'vteam-worker-exec'
$RuleGroup = 'vteam-worker'
$DisplayName = "vteam worker 执行端点 (TCP $Port)"

# --- 1) 管理员检测 -----------------------------------------------------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ("需要管理员权限：创建/查询 Windows 防火墙规则都要提权。" +
        "请以管理员身份打开 PowerShell（右键 → 以管理员身份运行）后重跑本脚本。" +
        "当前账户：$($identity.Name)")
}

# --- 2) 参数校验 -------------------------------------------------------------
if ($Port -lt 1 -or $Port -gt 65535) {
    throw "-Port 取值无效：$Port（合法范围 1-65535）"
}

$profiles = @($Profile | Where-Object { $_ } | Select-Object -Unique)
if ($profiles.Count -eq 0) {
    throw '-Profile 不能为空（示例：-Profile Domain,Private）'
}
if ($profiles -contains 'Any') {
    $profiles = @('Any')
}

# --- 3) 打印当前 profile 状态（GPO 是否已关/已接管，一眼可见）-----------------
$profileState = Get-NetFirewallProfile |
    Where-Object { $profiles -contains 'Any' -or $profiles -contains $_.Name } |
    Select-Object Name, Enabled, DefaultInboundAction
Write-Host '当前防火墙配置文件状态（Enabled=False 表示该 profile 的防火墙已关闭）：'
$profileState | Format-Table -AutoSize | Out-String | Write-Host

# --- 4) 幂等：按规则名先查后建 ----------------------------------------------
$existing = @(Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue)
$needCreate = $true

if ($existing.Count -gt 0) {
    $existingPorts = @(
        $existing |
            Get-NetFirewallPortFilter |
            ForEach-Object { [string]$_.LocalPort } |
            Select-Object -Unique
    )
    if ($existingPorts -contains [string]$Port) {
        $needCreate = $false
        Write-Host "[skip] 防火墙规则已存在且端口一致：$RuleName (TCP $Port)，无需改动（幂等）。"
    }
    else {
        throw ("防火墙规则 '$RuleName' 已存在但端口不一致（现有：$($existingPorts -join ', ')；本次参数：$Port）。" +
            "本脚本不会静默改动现有规则。如确认要改，请先执行：" +
            "`n  Remove-NetFirewallRule -Name '$RuleName'" +
            "`n再重跑本脚本。")
    }
}

# --- 5) 创建规则 -------------------------------------------------------------
if ($needCreate) {
    $ruleParams = @{
        Name        = $RuleName
        DisplayName = $DisplayName
        Group       = $RuleGroup
        Description = 'vteam worker 执行端点（控制面 <-> worker 的 POST /execute）。由 worker/scripts/windows/enable-firewall.ps1 创建。'
        Direction   = 'Inbound'
        Protocol    = 'TCP'
        LocalPort   = $Port
        Action      = 'Allow'
        Profile     = $profiles
        Enabled     = 'True'
    }
    if ($RemoteAddress.Count -gt 0) {
        $ruleParams['RemoteAddress'] = $RemoteAddress
    }

    $target = "$RuleName (TCP $Port / Profile=$($profiles -join ','))"
    if ($PSCmdlet.ShouldProcess($target, '创建 Windows 防火墙入站放行规则')) {
        New-NetFirewallRule @ruleParams | Out-Null

        # read-back 校验：必须是 TCP + 该端口 + Allow，否则视为失败（不要只看「没报错」）
        $created = Get-NetFirewallRule -Name $RuleName -ErrorAction Stop
        $createdPorts = @($created | Get-NetFirewallPortFilter | ForEach-Object { [string]$_.LocalPort })
        if (-not ($createdPorts -contains [string]$Port)) {
            throw "规则创建后校验失败：$RuleName 的 LocalPort 为 [$($createdPorts -join ', ')]，期望 $Port"
        }
        if ($created.Action -ne 'Allow' -or $created.Direction -ne 'Inbound') {
            throw "规则创建后校验失败：Action=$($created.Action) Direction=$($created.Direction)，期望 Allow/Inbound"
        }
        Write-Host "[ok] 已创建防火墙规则：$RuleName -> TCP $Port 入站放行（Profile=$($profiles -join ',')）"
    }
}

# --- 6) 回滚与自检命令（两种路径都打印，便于复制留档）------------------------
Write-Host ''
Write-Host '回滚（删除本规则）：'
Write-Host "  Remove-NetFirewallRule -Name '$RuleName'"
Write-Host ''
Write-Host '自检：'
Write-Host "  Get-NetFirewallRule -Name '$RuleName' | Get-NetFirewallPortFilter"
Write-Host "  Get-NetTCPConnection -LocalPort $Port -State Listen        # worker 运行时应为 Listen"
Write-Host "  Test-NetConnection <worker 局域网 IP> -Port $Port           # 在控制面机器上跑"
Write-Host ''
Write-Host '提示：本规则只放行执行端点；不要为 opencode serve 另开入站（serve 绑 127.0.0.1，控制面不直连）。'
Write-Host '提示：入站放行只是必要条件，控制面能否到达还取决于路由/网段/VPN（见 scripts/windows/README.md 常见问题）。'
