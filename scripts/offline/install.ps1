#Requires -Version 5.1
<#
.SYNOPSIS
    Установка Synth из offline-бандла (Windows 10/11 x64, per-user, без admin rights).

.DESCRIPTION
    Приложение:  %LOCALAPPDATA%\Programs\Synth\<version>  (+ junction current)
    Данные:      %LOCALAPPDATA%\Synth  (данные в <DataDir>\data, логи в <DataDir>\logs)
    Launcher:    %LOCALAPPDATA%\Programs\Synth\bin\synth.cmd (опционально в user PATH)

    Служба Windows не создаётся. Автозапуск (опционально) — Scheduled Task «At log on».

.PARAMETER DryRun
    Показать действия, ничего не менять.

.PARAMETER Autostart
    Создать Scheduled Task «At log on» (по умолчанию автозапуск выключен).

.PARAMETER NoAutostart
    Не создавать автозапуск (и удалить существующий task).

.PARAMETER Port
    Порт сервера (по умолчанию 4300).

.PARAMETER DataDir
    Каталог данных Synth (home; данные в <DataDir>\data). По умолчанию %LOCALAPPDATA%\Synth.

.PARAMETER Prefix
    Базовый каталог установки. По умолчанию %LOCALAPPDATA%\Programs\Synth.

.PARAMETER NoStart
    Не запускать сервер после установки.

.PARAMETER NoPath
    Не добавлять bin в user PATH.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Autostart,
    [switch]$NoAutostart,
    [int]$Port = 4300,
    [string]$DataDir = '',
    [string]$Prefix = '',
    [switch]$NoStart,
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "== $Message" }
function Write-Info([string]$Message) { Write-Host $Message }
function Write-Warn([string]$Message) { Write-Warning $Message }

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Поддерживается только 64-битная Windows (x64).'
}

$BundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $BundleDir 'manifest.json'
if (-not (Test-Path $ManifestPath)) {
    throw "manifest.json не найден — install.ps1 должен лежать в корне бандла ($BundleDir)."
}
$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
$Version = $Manifest.synthVersion
if (-not $Version) { throw 'В manifest.json нет synthVersion.' }
if ($Manifest.platform -ne 'win32' -or $Manifest.arch -ne 'x64') {
    throw "Бандл предназначен для $($Manifest.platform)/$($Manifest.arch), а не win32/x64."
}

$NodeExe = Join-Path $BundleDir 'runtime\node\node.exe'
$CliJs = Join-Path $BundleDir 'app\dist\cli.js'
if (-not (Test-Path $NodeExe)) { throw "runtime\node\node.exe не найден в бандле." }
if (-not (Test-Path $CliJs)) { throw "app\dist\cli.js не найден в бандле." }

if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'Programs\Synth' }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'Synth' }
$Prefix = [System.IO.Path]::GetFullPath($Prefix)
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$AppDir = Join-Path $Prefix $Version
$CurrentDir = Join-Path $Prefix 'current'
$BinDir = Join-Path $Prefix 'bin'
$Launcher = Join-Path $BinDir 'synth.cmd'
$LogsDir = Join-Path $DataDir 'logs'
$TaskName = 'Synth'

Write-Info "Synth v$Version (offline, per-user)"
Write-Info "  приложение: $AppDir"
Write-Info "  current:    $CurrentDir"
Write-Info "  данные:     $DataDir (данные в $DataDir\data)"
Write-Info "  логи:       $LogsDir"
Write-Info "  launcher:   $Launcher"
Write-Info "  URL:        http://127.0.0.1:$Port"

function Remove-JunctionItem([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    $item = Get-Item $Path -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        [System.IO.Directory]::Delete($Path, $false)
    } else {
        Remove-Item $Path -Recurse -Force
    }
}

if ($DryRun) {
    Write-Host ''
    Write-Info '[dry-run] будут выполнены:'
    Write-Info "  копирование $BundleDir -> $AppDir"
    Write-Info "  junction $CurrentDir -> $AppDir"
    Write-Info "  launcher $Launcher"
    if ($NoPath) { Write-Info '  PATH не изменяется (-NoPath)' } else { Write-Info "  добавление $BinDir в user PATH (если отсутствует)" }
    if ($Autostart -and -not $NoAutostart) { Write-Info "  Scheduled Task '$TaskName' (At log on)" }
    if ($NoAutostart) { Write-Info "  удаление Scheduled Task '$TaskName'" }
    if (-not $NoStart) { Write-Info '  запуск сервера (start-synth.ps1)' }
    Write-Info "  данные: $DataDir (не удаляются)"
    exit 0
}

# --- приложение -------------------------------------------------------------
Write-Step 'копирование приложения'
if (Test-Path $AppDir) {
    Write-Info "переустановка версии $Version (каталог уже существует)"
    Remove-Item $AppDir -Recurse -Force
}
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
Copy-Item -Path (Join-Path $BundleDir '*') -Destination $AppDir -Recurse -Force

# install.json — для start/stop/uninstall.
$InstallInfo = [ordered]@{
    synthVersion = $Version
    appDir       = $AppDir
    prefix       = $Prefix
    home         = $DataDir
    port         = $Port
    host         = '127.0.0.1'
    installedAt  = (Get-Date).ToUniversalTime().ToString('o')
}
$InstallInfo | ConvertTo-Json | Set-Content -Path (Join-Path $AppDir 'install.json') -Encoding UTF8

# --- current (junction) -----------------------------------------------------
Write-Step 'current'
Remove-JunctionItem $CurrentDir
try {
    New-Item -ItemType Junction -Path $CurrentDir -Target $AppDir -Force | Out-Null
} catch {
    Write-Warn "не удалось создать junction current: $($_.Exception.Message). Launcher будет указывать на версионированный каталог."
}

$LauncherTarget = if (Test-Path $CurrentDir) { Join-Path $CurrentDir 'bin\synth.cmd' } else { Join-Path $AppDir 'bin\synth.cmd' }
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$LauncherMarker = 'rem Synth offline launcher (managed by install.ps1)'
if (Test-Path $Launcher) {
    $existingLauncher = Get-Content $Launcher -Raw
    if ($existingLauncher -notmatch [regex]::Escape($LauncherMarker)) {
        throw "Уже существует $Launcher (не launcher Synth offline-бандла). Удалите/переименуйте его или используйте -Prefix."
    }
}
$LauncherBody = @"
@echo off
$LauncherMarker
call "$LauncherTarget" %*
"@
Set-Content -Path $Launcher -Value $LauncherBody -Encoding Default

# --- данные и логи ----------------------------------------------------------
New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

# --- PATH -------------------------------------------------------------------
if (-not $NoPath) {
    Write-Step 'user PATH'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($userPath) { $parts = @($userPath -split ';' | Where-Object { $_ -ne '' }) }
    $already = $parts | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }
    if ($already) {
        Write-Info "уже в PATH: $BinDir"
    } else {
        $newPath = (@($parts) + $BinDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Info "добавлено в user PATH: $BinDir (нужен новый терминал)"
    }
} else {
    Write-Info '-NoPath: PATH не изменяется'
}

# --- автозапуск (Scheduled Task, не служба) ---------------------------------
if ($NoAutostart) {
    Write-Step 'автозапуск отключён'
    try {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
        Write-Info "task '$TaskName' удалён (если был)"
    } catch {
        Write-Warn "не удалось удалить task '$TaskName': $($_.Exception.Message)"
    }
} elseif ($Autostart) {
    Write-Step 'автозапуск при входе'
    try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $AppDir 'start-synth.ps1')`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
            -Description 'Synth — локальный сервер (запуск при входе пользователя)' -Force | Out-Null
        Write-Info "task '$TaskName' зарегистрирован"
    } catch {
        Write-Warn "не удалось зарегистрировать task '$TaskName': $($_.Exception.Message). Запуск автозапуска можно повторить: install.ps1 -Autostart"
    }
} else {
    Write-Info 'автозапуск не включён (используйте -Autostart)'
}

# --- запуск -----------------------------------------------------------------
if (-not $NoStart) {
    Write-Step 'запуск'
    try {
        & (Join-Path $AppDir 'start-synth.ps1')
    } catch {
        Write-Warn "не удалось запустить сервер: $($_.Exception.Message)"
        Write-Warn "запустите вручную: powershell -File `"$(Join-Path $AppDir 'start-synth.ps1')`""
    }
} else {
    Write-Info '-NoStart: сервер не запущен'
}

Write-Host ''
Write-Info 'Готово.'
Write-Info "  URL:      http://127.0.0.1:$Port"
Write-Info "  API-ключ: $DataDir\data\secrets\api-key"
Write-Info '            (создаётся при первом запуске; значение не выводится)'
Write-Info "  логи:     $LogsDir"
Write-Info "  удаление: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $AppDir 'uninstall.ps1')`""
