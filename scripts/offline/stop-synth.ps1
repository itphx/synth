#Requires -Version 5.1
<#
.SYNOPSIS
    Остановка Synth-сервера, запущенного start-synth.ps1 (Windows, per-user).
#>
[CmdletBinding()]
param(
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

$InstallFile = Join-Path $Root 'install.json'
if (Test-Path $InstallFile) {
    $info = Get-Content $InstallFile -Raw | ConvertFrom-Json
    if (-not $DataDir -and $info.home) { $DataDir = $info.home }
}
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'Synth' }

$PidFile = Join-Path $DataDir 'logs\synth.pid'

if (-not (Test-Path $PidFile)) {
    Write-Host 'Synth не запущен: PID-файл не найден.'
    exit 0
}

$raw = (Get-Content $PidFile -Raw).Trim()
if (-not $raw) {
    Remove-Item $PidFile -Force
    Write-Host 'PID-файл пуст — удалён.'
    exit 0
}

$proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
if (-not $proc) {
    Remove-Item $PidFile -Force
    Write-Host "Процесс PID $raw не найден — PID-файл удалён."
    exit 0
}

# Останавливаем только процесс node из этого бандла.
if ($proc.ProcessName -notmatch '^node$') {
    Write-Warning "PID $raw принадлежит '$($proc.ProcessName)', а не node. Остановка отменена."
    exit 1
}

Stop-Process -Id $proc.Id -Force
try { [void]$proc.WaitForExit(10000) } catch { }
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "Synth остановлен (PID $($proc.Id))."
