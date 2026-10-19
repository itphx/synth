#Requires -Version 5.1
<#
.SYNOPSIS
    Запуск Synth-сервера в фоне (Windows, per-user, без службы).

.DESCRIPTION
    Запускает bundle runtime\node\node.exe app\dist\cli.js serve --home <home> ...
    скрыто, с перенаправлением stdout/stderr в <home>\logs и записью PID.
    Параметры по умолчанию берутся из install.json (создаёт install.ps1).

.PARAMETER Port
.PARAMETER DataDir
.PARAMETER WaitSeconds
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$DataDir = '',
    [string]$HostName = '127.0.0.1',
    [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

$InstallFile = Join-Path $Root 'install.json'
if (Test-Path $InstallFile) {
    $info = Get-Content $InstallFile -Raw | ConvertFrom-Json
    if ($Port -eq 0 -and $info.port) { $Port = [int]$info.port }
    if (-not $DataDir -and $info.home) { $DataDir = $info.home }
}
if ($Port -eq 0) { $Port = 4300 }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'Synth' }

$NodeExe = Join-Path $Root 'runtime\node\node.exe'
$CliJs = Join-Path $Root 'app\dist\cli.js'
$LogsDir = Join-Path $DataDir 'logs'
$PidFile = Join-Path $LogsDir 'synth.pid'
$OutLog = Join-Path $LogsDir 'synth.out.log'
$ErrLog = Join-Path $LogsDir 'synth.err.log'

if (-not (Test-Path $NodeExe)) { throw "Не найден $NodeExe" }
if (-not (Test-Path $CliJs)) { throw "Не найден $CliJs" }
New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

function Test-ExistingProcess {
    if (-not (Test-Path $PidFile)) { return $false }
    $raw = (Get-Content $PidFile -Raw).Trim()
    if (-not $raw) { return $false }
    $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    # PID мог быть переиспользован другим процессом — проверяем имя.
    return ($proc -and $proc.ProcessName -match '^node$')
}

if (Test-ExistingProcess) {
    $pidValue = (Get-Content $PidFile -Raw).Trim()
    Write-Host "Synth уже запущен (PID $pidValue): http://${HostName}:$Port"
    exit 0
}

# Ротация логов (не разрастаться бесконечно).
if (Test-Path $OutLog) { Move-Item $OutLog "$OutLog.1" -Force }
if (Test-Path $ErrLog) { Move-Item $ErrLog "$ErrLog.1" -Force }

$arguments = '"{0}" serve --home "{1}" --port {2} --host {3}' -f $CliJs, $DataDir, $Port, $HostName
$proc = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog `
    -WorkingDirectory $Root
Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

Write-Host "Synth запускается (PID $($proc.Id))..."

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
        Write-Host "Процесс завершился с кодом $($proc.ExitCode)."
        break
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://${HostName}:$Port/health" -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
        # сервер ещё стартует
    }
}

if ($healthy) {
    Write-Host "Synth работает: http://${HostName}:$Port"
    Write-Host "API-ключ: $DataDir\data\secrets\api-key (значение не выводится)"
    Write-Host "Логи: $OutLog, $ErrLog"
    exit 0
}

Write-Host "Сервер не ответил на /health за $WaitSeconds с. Смотрите логи:"
if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 20 | ForEach-Object { Write-Host "  $_" } }
exit 1
