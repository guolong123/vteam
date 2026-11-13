@echo off
rem ============================================================================
rem install-worker.cmd -- 薄包装：定位同目录的 install-worker.ps1 并执行
rem
rem 用途：把 install-worker.ps1 与 install-worker.cmd 放在同一目录（共享目录 / U 盘 /
rem        离线包 / 已经下载到目标机的临时目录）时，可以：
rem          install-worker.cmd -Server http://10.0.0.5:3000 -WorkerId w_win_01 -TokenFile C:\temp\vteam-token.txt
rem        或在资源管理器里双击（不带参数 = 全部走缺省值 + 交互式输入 token）。
rem
rem 安装页（控制面 workers -> 安装 -> Windows PowerShell Tab）生成的命令仍以
rem install-worker.ps1 为主体（先 Invoke-WebRequest 下载到 %TEMP% 再 -File 执行）；
rem 本包装只服务「整包拷到目标机 / 无外网下载脚本」的场景，两者参数完全一致。
rem
rem 需要管理员权限的安装（注册 Windows 服务 / 计划任务 / 放行防火墙）：
rem        右键「以管理员身份运行」打开命令提示符或 PowerShell，再执行本文件。
rem 本包装**不做**自动提权：UAC 提权会另起一个控制台，安装输出与退出码都不好回收，
rem 也会让用户不清楚脚本在哪个窗口里跑。请按上面提示手动用管理员窗口执行。
rem
rem 唯一职责是「找脚本 + 以进程级 Bypass 拉起 PowerShell」：
rem   -ExecutionPolicy Bypass 只影响本次进程，不修改机器的 ExecutionPolicy；
rem   不写任何注册表/PATH，不改系统策略。
rem ============================================================================
setlocal

set "PS1=%~dp0install-worker.ps1"
if not exist "%PS1%" (
    echo [install-worker] ERROR: install-worker.ps1 not found next to this file:
    echo     %PS1%
    echo   Put install-worker.ps1 and install-worker.cmd in the same directory,
    echo   or download the script directly:
    echo     Invoke-WebRequest -UseBasicParsing '^<control-plane^>/install-worker.ps1' -OutFile "$env:TEMP\install-worker.ps1"
    echo     powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-worker.ps1" -Server ...
    exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo [install-worker] ERROR: powershell.exe not found.
    echo   Requires Windows PowerShell 5.1 or PowerShell 7 (Windows 10 1803+ / Windows 11 / Server 2019+).
    exit /b 1
)

rem 参数原样透传：%* 已保留引号，-Token / -TokenFile 等由 install-worker.ps1 解析。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
