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
# Имена файлов манифеста/сумм — те же, что у производителя (scripts/offline-bundle.mjs).
$InnerSumsName = 'files.sha256'
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "manifest.json не найден — install.ps1 должен лежать в корне бандла ($BundleDir)."
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$Version = $Manifest.synthVersion
if (-not $Version) { throw 'В manifest.json нет synthVersion.' }
# Версия из манифеста попадает в путь каталога (Remove-Item -Recurse -Force) и в
# launcher/Scheduled Task — строгий шаблон, иначе «..\..\Windows» удалит не то.
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    throw "Недопустимый synthVersion в манифесте: '$Version' (ожидается X.Y.Z[-prerelease])."
}
if ($Manifest.platform -ne 'win32' -or $Manifest.arch -ne 'x64') {
    throw "Бандл предназначен для $($Manifest.platform)/$($Manifest.arch), а не win32/x64."
}

$NodeExe = Join-Path $BundleDir 'runtime\node\node.exe'
$CliJs = Join-Path $BundleDir 'app\dist\cli.js'
if (-not (Test-Path -LiteralPath $NodeExe)) { throw "runtime\node\node.exe не найден в бандле." }
if (-not (Test-Path -LiteralPath $CliJs)) { throw "app\dist\cli.js не найден в бандле." }

# --- проверка целостности бандла ----------------------------------------------
# Fail closed: любое расхождение с манифестом — отказ, до копирования файлов.

function Protect-File([string]$Path) {
    # ACL-эквивалент 0600: файл доступен только текущему пользователю.
    try {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl
    } catch {
        Write-Warn "не удалось ограничить права доступа к файлу $Path : $($_.Exception.Message)"
    }
}

function Get-Sha256([string]$Path) {
    # Эквивалент Get-FileHash -Algorithm SHA256 для одного файла.
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Fast([string]$Path) {
    # Тот же SHA256, но без накладных расходов cmdlet'а на каждый файл:
    # в бандле ~15 тыс. файлов, Get-FileHash на каждом — минуты.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hash = $sha.ComputeHash($stream)
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Assert-BundleIntegrity([string]$Dir, $ManifestData, [string]$SumsName) {
    # Путь к файлу сумм вычисляется ЗДЕСЬ: переменная, присвоенная внутри
    # функции, имеет область видимости функции (присваивание снаружи не видно).
    $sumsPath = Join-Path $Dir $SumsName
    if (-not $ManifestData.files -or $ManifestData.files.Count -eq 0) {
        throw 'В manifest.json нет списка files[] — целостность бандла не может быть проверена.'
    }

    $expected = @{}
    foreach ($entry in $ManifestData.files) {
        $name = [string]$entry.path
        if (-not $name) { throw 'В manifest.json есть запись без path.' }
        if ($name -match '[\\/]') { throw "Некорректная запись в manifest.json: '$name' (ожидаются верхнеуровневые имена)." }
        if ($expected.ContainsKey($name)) { throw "Дублирующаяся запись в manifest.json: '$name'." }
        $expected[$name] = $entry

        $target = Join-Path $Dir $name
        if ($entry.type -eq 'file') {
            if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
                throw "Файл '$name' отсутствует в бандле (ожидался по манифесту)."
            }
            if (-not $entry.sha256) {
                throw "В manifest.json нет sha256 для '$name' — целостность не может быть проверена."
            }
            $actual = Get-Sha256 $target
            if ($actual -ne ([string]$entry.sha256).ToLowerInvariant()) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: sha256 файла '$name' не совпадает с манифестом (ожидался $($entry.sha256), получен $actual)."
            }
        } elseif ($entry.type -eq 'directory') {
            if (-not (Test-Path -LiteralPath $target -PathType Container)) {
                throw "Каталог '$name' отсутствует в бандле (ожидался по манифесту)."
            }
            $files = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force)
            $count = $files.Count
            $bytes = 0
            foreach ($f in $files) { $bytes += $f.Length }
            if ($null -eq $entry.files -or $count -ne [int]$entry.files) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: в каталоге '$name' $count файл(ов), по манифесту $($entry.files)."
            }
            if ($null -eq $entry.bytes -or $bytes -ne [int64]$entry.bytes) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: каталог '$name' — $bytes байт, по манифесту $($entry.bytes)."
            }
        } else {
            throw "Неизвестный тип '$($entry.type)' для '$name' в manifest.json."
        }
    }

    # Состав верхнего уровня: лишних/недостающих записей и симлинков быть не должно.
    $actualTop = @(Get-ChildItem -LiteralPath $Dir -Force | Where-Object { $_.Name -ne 'manifest.json' })
    foreach ($item in $actualTop) {
        if ($item.LinkType) { throw "В бандле есть симлинк: $($item.Name)." }
        if (-not $expected.ContainsKey($item.Name)) {
            throw "В бандле есть лишний объект верхнего уровня: '$($item.Name)' (нет его в манифесте)."
        }
    }
    foreach ($name in $expected.Keys) {
        if (-not ($actualTop | Where-Object { $_.Name -eq $name })) {
            throw "В бандле нет объекта '$name' (ожидался по манифесту)."
        }
    }

    # files.sha256 — sha256 каждого файла бандла + точное совпадение состава.
    if (Test-Path -LiteralPath $sumsPath -PathType Leaf) {
        $listed = @{}
        foreach ($line in [System.IO.File]::ReadAllLines($sumsPath)) {
            if (-not $line.Trim()) { continue }
            if ($line.Length -lt 67) { throw "Некорректная строка в ${SumsName}: '$line'." }
            $hash = $line.Substring(0, 64).ToLowerInvariant()
            $path = $line.Substring(66)
            if ($path.StartsWith('*')) { $path = $path.Substring(1) }
            if ($listed.ContainsKey($path)) { throw "Дубликат в ${SumsName}: '$path'." }
            $listed[$path] = $hash
            $full = Join-Path $Dir ($path -replace '/', '\')
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: файл '$path' отсутствует в бандле (есть в ${SumsName})."
            }
            $actual = Get-Sha256Fast $full
            if ($actual -ne $hash) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: sha256 файла '$path' не совпадает с ${SumsName} (ожидался $hash, получен $actual)."
            }
        }
        $onDisk = @{}
        foreach ($f in Get-ChildItem -LiteralPath $Dir -Recurse -File -Force) {
            $rel = $f.FullName.Substring($Dir.Length).TrimStart([char[]]@('\', '/')) -replace '\\', '/'
            if ($rel -eq 'manifest.json' -or $rel -eq $SumsName) { continue }
            $onDisk[$rel] = $true
        }
        foreach ($rel in $listed.Keys) {
            if (-not $onDisk.ContainsKey($rel)) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: файл '$rel' есть в ${SumsName}, но отсутствует в бандле."
            }
        }
        foreach ($rel in $onDisk.Keys) {
            if (-not $listed.ContainsKey($rel)) {
                throw "НАРУШЕНА ЦЕЛОСТНОСТЬ: файл '$rel' есть в бандле, но отсутствует в ${SumsName}."
            }
        }
    }
}

Assert-BundleIntegrity -Dir $BundleDir -ManifestData $Manifest -SumsName $InnerSumsName

if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'Programs\Synth' }
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'Synth' }
# --Prefix/--DataDir попадают в пути, которые удаляются и пишутся в launcher и
# Scheduled Task: только абсолютные пути без недопустимых для Windows символов.
foreach ($pair in @(@('--Prefix', $Prefix), @('-DataDir', $DataDir))) {
    $value = [string]$pair[1]
    if (-not $value) { throw "$($pair[0]) требует непустое значение." }
    if (-not [System.IO.Path]::IsPathRooted($value)) {
        throw "$($pair[0]) должен быть абсолютным путём: '$value'."
    }
    if ($value -match '[<>:"|?*]' -or $value -match '[\x00-\x1F]') {
        throw "$($pair[0]) содержит недопустимые для Windows символы: '$value'."
    }
}
$Prefix = [System.IO.Path]::GetFullPath($Prefix)
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$AppDir = Join-Path $Prefix $Version
$CurrentDir = Join-Path $Prefix 'current'
$BinDir = Join-Path $Prefix 'bin'
$Launcher = Join-Path $BinDir 'synth.cmd'
$LogsDir = Join-Path $DataDir 'logs'
$TaskName = 'Synth'

# Каталог версии обязан канонически лежать внутри каталога установки —
# иначе Remove-Item -Recurse -Force уйдёт за его пределы.
$prefixFull = $Prefix.TrimEnd([char[]]@('\', '/'))
$appFull = [System.IO.Path]::GetFullPath($AppDir)
if (-not $appFull.StartsWith($prefixFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Каталог версии ($appFull) находится вне каталога установки ($prefixFull)."
}

Write-Info "Synth v$Version (offline, per-user)"
Write-Info "  приложение: $AppDir"
Write-Info "  current:    $CurrentDir"
Write-Info "  данные:     $DataDir (данные в $DataDir\data)"
Write-Info "  логи:       $LogsDir"
Write-Info "  launcher:   $Launcher"
Write-Info "  URL:        http://127.0.0.1:$Port"

$LauncherMarker = 'rem Synth offline launcher (managed by install.ps1)'
if (Test-Path -LiteralPath $Launcher) {
    $existingLauncher = Get-Content -LiteralPath $Launcher -Raw
    if ($existingLauncher -notmatch [regex]::Escape($LauncherMarker)) {
        throw "Уже существует $Launcher (не launcher Synth offline-бандла). Удалите/переименуйте его или используйте -Prefix."
    }
}

function Remove-JunctionItem([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        [System.IO.Directory]::Delete($Path, $false)
    } else {
        Remove-Item -LiteralPath $Path -Recurse -Force
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
if (Test-Path -LiteralPath $AppDir) {
    Write-Info "переустановка версии $Version (каталог уже существует)"
    Remove-Item -LiteralPath $AppDir -Recurse -Force
}
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
Get-ChildItem -LiteralPath $BundleDir -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $AppDir -Recurse -Force
}

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
$InstallInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $AppDir 'install.json') -Encoding UTF8
Protect-File (Join-Path $AppDir 'install.json')

# --- current (junction) -----------------------------------------------------
Write-Step 'current'
Remove-JunctionItem $CurrentDir
try {
    New-Item -ItemType Junction -Path $CurrentDir -Target $AppDir -Force | Out-Null
} catch {
    Write-Warn "не удалось создать junction current: $($_.Exception.Message). Launcher будет указывать на версионированный каталог."
}

$LauncherTarget = if (Test-Path -LiteralPath $CurrentDir) { Join-Path $CurrentDir 'bin\synth.cmd' } else { Join-Path $AppDir 'bin\synth.cmd' }
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
# «%» в .cmd расширяется переменной окружения — экранируем как «%%».
$LauncherTargetEscaped = $LauncherTarget -replace '%', '%%'
$LauncherBody = @"
@echo off
$LauncherMarker
call "$LauncherTargetEscaped" %*
"@
Set-Content -LiteralPath $Launcher -Value $LauncherBody -Encoding Default
Protect-File $Launcher

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
