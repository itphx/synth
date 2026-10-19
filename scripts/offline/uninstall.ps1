#Requires -Version 5.1
<#
.SYNOPSIS
    Удаление Synth, установленного из offline-бандла (Windows, per-user).

.DESCRIPTION
    Удаляет Scheduled Task, launcher и приложение. По умолчанию данные и логи
    сохраняются; полное удаление — -Purge.

.PARAMETER Purge
    Удалить данные и логи (%LOCALAPPDATA%\Synth).

.PARAMETER DryRun
    Показать действия, ничего не менять.

.PARAMETER Prefix
    Базовый каталог установки (как при install). По умолчанию %LOCALAPPDATA%\Programs\Synth.
#>
[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$DryRun,
    [string]$Prefix = ''
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) { Write-Host $Message }
function Write-Warn([string]$Message) { Write-Warning $Message }

if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'Programs\Synth' }
$Prefix = [System.IO.Path]::GetFullPath($Prefix)
$CurrentDir = Join-Path $Prefix 'current'
$BinDir = Join-Path $Prefix 'bin'
$TaskName = 'Synth'

# install.json: сначала через current, потом из бандла (если запущен оттуда).
$InstallFile = Join-Path $CurrentDir 'install.json'
if (-not (Test-Path $InstallFile)) {
    $candidate = Join-Path $PSScriptRoot 'install.json'
    if (Test-Path $candidate) { $InstallFile = $candidate }
}

$AppDir = $null
$DataDir = Join-Path $env:LOCALAPPDATA 'Synth'
if (Test-Path $InstallFile) {
    $info = Get-Content $InstallFile -Raw | ConvertFrom-Json
    if ($info.appDir) { $AppDir = $info.appDir }
    if ($info.home) { $DataDir = $info.home }
}
if (-not $AppDir -and (Test-Path $CurrentDir)) {
    $target = (Get-Item $CurrentDir -Force).Target
    if ($target -is [System.Array]) { $target = $target[0] }
    $AppDir = $target
}

# Не удаляем каталог вне Prefix, даже если install.json повреждён/подменён.
if ($AppDir) {
    $prefixFull = [System.IO.Path]::GetFullPath($Prefix).TrimEnd('\') + '\'
    $appFull = [System.IO.Path]::GetFullPath($AppDir)
    if (-not $appFull.StartsWith($prefixFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Отказ: appDir '$appFull' находится вне Prefix '$Prefix'."
    }
}

Write-Info 'Удаление Synth'
Write-Info "  приложение: $AppDir"
if ($Purge) {
    Write-Info "  данные:     $DataDir (будут удалены)"
} else {
    Write-Info "  данные:     $DataDir (сохраняются)"
}

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
    Write-Info '  остановка сервера (stop-synth.ps1)'
    Write-Info "  удаление Scheduled Task '$TaskName'"
    Write-Info "  удаление $BinDir из user PATH"
    Write-Info "  удаление launcher $BinDir\synth.cmd"
    Write-Info "  удаление $CurrentDir и $AppDir"
    if ($Purge) { Write-Info "  удаление данных: $DataDir" }
    exit 0
}

# --- остановка --------------------------------------------------------------
$startScript = if ($AppDir) { Join-Path $AppDir 'stop-synth.ps1' } else { $null }
if ($startScript -and (Test-Path $startScript)) {
    try { & $startScript -DataDir $DataDir | Out-Null } catch { Write-Warn "stop-synth.ps1: $($_.Exception.Message)" }
} else {
    $pidFile = Join-Path $DataDir 'logs\synth.pid'
    if (Test-Path $pidFile) {
        $proc = Get-Process -Id ([int](Get-Content $pidFile -Raw).Trim()) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match '^node$') { Stop-Process -Id $proc.Id -Force }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

# --- Scheduled Task ---------------------------------------------------------
try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Info "task '$TaskName' удалён"
    }
} catch {
    Write-Warn "не удалось удалить task '$TaskName': $($_.Exception.Message)"
}

# --- PATH -------------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $parts = @($userPath -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ine $BinDir.TrimEnd('\') })
    $newPath = $parts -join ';'
    if ($newPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Info "удалено из user PATH: $BinDir"
    }
}

# --- launcher / приложение --------------------------------------------------
Remove-JunctionItem $CurrentDir
if ($AppDir -and (Test-Path $AppDir)) {
    Remove-Item $AppDir -Recurse -Force
    Write-Info "удалено приложение: $AppDir"
}
$Launcher = Join-Path $BinDir 'synth.cmd'
if (Test-Path $Launcher) {
    $launcherText = Get-Content $Launcher -Raw
    if ($launcherText -match [regex]::Escape('rem Synth offline launcher (managed by install.ps1)')) {
        Remove-Item $Launcher -Force
        Write-Info "удалён launcher: $Launcher"
    } else {
        Write-Warn "launcher $Launcher создан не offline-установщиком — не удаляю"
    }
}
if (Test-Path $BinDir) {
    $remaining = Get-ChildItem $BinDir -Force -ErrorAction SilentlyContinue
    if (-not $remaining) { Remove-Item $BinDir -Force }
}

# --- данные -----------------------------------------------------------------
if ($Purge) {
    if (Test-Path $DataDir) {
        Remove-Item $DataDir -Recurse -Force
        Write-Info "удалены данные: $DataDir"
    }
} else {
    Write-Info "данные сохранены: $DataDir"
    Write-Info 'для полного удаления повторите с -Purge'
}

Write-Info 'Готово.'
