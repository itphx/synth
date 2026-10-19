# Offline-дистрибутивы Synth (portable)

Каталог собирает **portable-архивы** Synth для закрытого контура: приложение +
pinned Node 22 + ripgrep + launcher'ы + установщики. Нативные пакеты
(`.deb`/`.rpm`/`.msi`/`.pkg`) **не выпускаются** — только `tar.gz`/`zip` и
offline Docker/Helm (вне этого каталога).

| Платформа | Артефакт | Примечание |
|---|---|---|
| Linux x64 | `synth-<ver>-linux-x64.tar.gz` | RHEL 8/9, Ubuntu 20.04/22.04/24.04, Debian 11/12, Astra 1.8.x, RED OS 8 |
| Linux arm64 | `synth-<ver>-linux-arm64.tar.gz` | только по явному `--platform linux-arm64`; в `all` не входит (arm64 — Docker-образы) |
| macOS Intel | `synth-<ver>-darwin-x64.tar.gz` | macOS 26 Tahoe |
| macOS ARM | `synth-<ver>-darwin-arm64.tar.gz` | macOS 26 Tahoe / 27 Golden Gate |
| Windows x64 | `synth-<ver>-win-x64.zip` | Windows 10/11, per-user, без admin rights |

LLM в поставку не входит. Документация в бандле — заглушка (`share/docs/README.md`),
пользовательские доки ведутся отдельно.

## Сборка

Требования к build-машине: Node 22+, pnpm 11+, GNU tar (для детерминированного
`tar.gz`; на macOS — `gnu-tar`/`gtar`), `zip` и `unzip` (для Windows-бандла и
распаковки), `git` (для `gitCommit` в manifest).

```bash
cd synth

# все portable-платформы (linux-x64, darwin-x64, darwin-arm64, win-x64)
node scripts/offline-bundle.mjs

# одна платформа
node scripts/offline-bundle.mjs --platform linux-x64

# без пересборки пакетов (dist/ уже собран)
node scripts/offline-bundle.mjs --platform linux-x64 --skip-build

# воспроизводимая упаковка
node scripts/offline-bundle.mjs --platform linux-x64 \
  --source-date-epoch 1767225600
```

Опции:

| Опция | Назначение |
|---|---|
| `--platform <name\|all>` | платформа или `all` (по умолчанию `all`) |
| `--out <dir>` | каталог артефактов (по умолчанию `dist/offline`) |
| `--node-version <ver>` | версия Node 22 (по умолчанию — latest-v22.x) |
| `--node-cache <dir>` | кэш архивов Node |
| `--node-dir <dir>` | локальная распаковка Node вместо скачивания |
| `--rg-version <ver>` | версия ripgrep (по умолчанию `14.1.1`) |
| `--rg-cache <dir>` | кэш архивов ripgrep |
| `--rg-dir <dir>` | локальный `rg` вместо скачивания |
| `--skip-build` | не запускать `pnpm build` |
| `--source-date-epoch <s>` | фиксированный mtime для детерминизма |

Порядок сборки: `pnpm build` (если не `--skip-build`) → `pnpm --filter
@itphx/synth deploy --prod --legacy --config.node-linker=hoisted` → копирование
app на каждую платформу → Node/ripgrep → launcher'ы/установщики → manifest →
упаковка. Один `deploy` переиспользуется для всех платформ: в дереве
зависимостей нет нативных модулей (проверяется отсутствием `*.node`).

### Сборка без интернета (закрытый build-контур)

Сеть нужна только для скачивания официальных архивов Node/ripgrep. Варианты:

```bash
# 1. Предзаполненный кэш (структура: <cache>/node/v22.x.y/, <cache>/ripgrep/14.1.1/)
node scripts/offline-bundle.mjs --platform linux-x64 \
  --node-cache /opt/offline/node --rg-cache /opt/offline/ripgrep

# 2. Локальные распаковки (SHA256 архива в manifest будет null)
node scripts/offline-bundle.mjs --platform win-x64 \
  --node-dir /opt/node22 --rg-dir /opt/ripgrep
```

Оба архива проверяются по SHA256 официальных источников
(`nodejs.org/dist/.../SHASUMS256.txt`, `...<asset>.sha256` для ripgrep). При
несовпадении хеша архив удаляется, сборка падает. Без сети и без кэша сборка
завершается с внятной ошибкой.

## Артефакты и SHA256SUMS

```
dist/offline/
├── synth-0.11.1-linux-x64.tar.gz
├── synth-0.11.1-darwin-x64.tar.gz
├── synth-0.11.1-darwin-arm64.tar.gz
├── synth-0.11.1-win-x64.zip
└── SHA256SUMS
```

Проверка целостности:

```bash
cd dist/offline
sha256sum -c SHA256SUMS          # Linux
shasum -a 256 -c SHA256SUMS      # macOS
Get-FileHash -Algorithm SHA256 <archive>  # Windows (сверить со строкой в SHA256SUMS)
```

Каждый архив содержит `manifest.json` (версии Synth/Node/ripgrep, SHA256
скачанных архивов, `gitCommit`, `builtAt`, список верхнеуровневых файлов с
хешами) и `LICENSES/`.

## Структура бандла

```
synth-<ver>-<platform>/
├── bin/synth                # sh-wrapper (Linux/macOS)
├── bin/synth.cmd            # Windows
├── app/...                  # hoisted pnpm deploy (dist + node_modules)
├── runtime/node/bin/node    # Node 22 + LICENSE (win: runtime/node/node.exe)
├── tools/rg                 # ripgrep + лицензии (win: rg.exe)
├── etc/config.example.yaml
├── etc/synth.env.example
├── share/docs/README.md     # заглушка
├── install.sh / uninstall.sh          # Linux + macOS
├── install.ps1 / uninstall.ps1        # Windows
├── start-synth.ps1 / stop-synth.ps1   # Windows
├── manifest.json
├── LICENSES/
└── SHA256SUMS               # только рядом с архивом (dist/offline)
```

Симлинков в архиве нет: `app/node_modules/.bin` удаляется, остальные
проверяются (`find -type l`); при обнаружении сборка падает.

## Установка

### Linux (per-user, без root)

```bash
tar -xzf synth-<ver>-linux-x64.tar.gz
cd synth-<ver>-linux-x64
./install.sh                      # ~/.local, systemd --user, запуск сразу
./install.sh --port 4400 --no-autostart
./install.sh --dry-run            # показать действия
```

Раскладка: приложение `~/.local/lib/synth/<version>` (+ symlink `current`),
launcher `~/.local/bin/synth`, данные `~/.local/share/synth` (внутри `<home>/data`),
env `~/.config/synth/synth.env`, unit `~/.config/systemd/user/synth.service`.
Unit: `Restart=on-failure`, `RestartSec=3`, `EnvironmentFile` (если есть).
Exit code 75 (graceful restart, ADR-092) считается сбоем — systemd поднимает
процесс заново.

### Linux (system)

```bash
sudo ./install.sh --system                 # /opt/synth/<version>, пользователь synth
sudo ./install.sh --system --no-start
```

`/opt/synth/<version>` (+ `current`), `/var/lib/synth`, `/etc/synth/synth.env`,
`/etc/systemd/system/synth.service`; launcher `/usr/local/bin/synth`.

### macOS (per-user)

```bash
tar -xzf synth-<ver>-darwin-arm64.tar.gz
cd synth-<ver>-darwin-arm64
./install.sh                      # + LaunchAgent ru.itphx.synth (KeepAlive)
./install.sh --no-autostart       # без LaunchAgent
```

Приложение `~/Library/Application Support/Synth/<version>` (+ `current`),
launcher `~/bin/synth` (или `/usr/local/bin/synth`, если writable), данные
`~/Library/Application Support/Synth/data`, конфиг
`~/Library/Application Support/Synth/config.yaml`, логи
`~/Library/Logs/Synth/`, plist `~/Library/LaunchAgents/ru.itphx.synth.plist`.

### Windows (per-user, без admin)

```powershell
Expand-Archive synth-<ver>-win-x64.zip -DestinationPath .
cd synth-<ver>-win-x64
powershell -ExecutionPolicy Bypass -File .\install.ps1            # без автозапуска
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Autostart # Scheduled Task (At log on)
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

Приложение `%LOCALAPPDATA%\Programs\Synth\<version>` (+ junction `current`),
данные `%LOCALAPPDATA%\Synth` (данные в `<DataDir>\data`, логи в `<DataDir>\logs`),
launcher `%LOCALAPPDATA%\Programs\Synth\bin\synth.cmd` (опционально в user PATH).
Автозапуск — **Scheduled Task**, не служба; WinSW не используется.

## Проверка бандла

```bash
./scripts/offline/smoke-test.sh --archive dist/offline/synth-<ver>-linux-x64.tar.gz
# или уже распакованный:
./scripts/offline/smoke-test.sh --dir /tmp/synth-<ver>-linux-x64
```

Проверяет SHA256 архива по `SHA256SUMS`, `manifest.json`, отсутствие симлинков,
версии Node/ripgrep/Synth, запуск `bin/synth serve` на временном порту и ответы
`/health` и `/ready`, создание файла API-ключа. Временный каталог удаляется,
`--keep` — сохранить.

Ручная проверка:

```bash
tar -xzf synth-<ver>-linux-x64.tar.gz -C /tmp
/tmp/synth-<ver>-linux-x64/bin/synth --version
/tmp/synth-<ver>-linux-x64/bin/synth serve --home /tmp/synth-home --port 4497
curl -s http://127.0.0.1:4497/health
```

## API-ключ и доступ

Адрес по умолчанию — `http://127.0.0.1:4300` (host/port задаются при установке).
API-ключ создаётся при первом запуске в `<home>/data/secrets/api-key`
(Linux user: `~/.local/share/synth/data/secrets/api-key`; Windows:
`%LOCALAPPDATA%\Synth\data\secrets\api-key`). Установщики печатают **путь**, не
значение. Все API, кроме `GET /health`, требуют `Authorization: Bearer <key>`.

## Пререквизиты, которые остаются

| Платформа | Что нужно отдельно | Зачем |
|---|---|---|
| Linux | `git` | git-инструменты агента (clone/commit/push), репозитории проекта |
| Linux | systemd (для автозапуска) | unit `synth.service`; без systemd установка работает, но сервис не включается |
| macOS | `git` (Xcode CLT) | git-инструменты агента |
| macOS | LaunchAgent (для автозапуска) | `~/Library/LaunchAgents` |
| Windows | **Git for Windows** | `execute_shell` (bash-среду Synth не поставляет) и git-инструменты; в бандл не входит |
| Windows | PowerShell 5.1+ | установщик/start/stop |
| Все | LLM-провайдер | в поставку не входит, настраивается локально |

`rg` поставляется в бандле (`tools/rg`), отдельная установка не нужна.

## Ограничения

- Только x64 для Linux/Windows; macOS — x64 и arm64.
- `linux-arm64` собирается только явным флагом (portable для arm64 Linux не
  выпускается по решению владельца; arm64 — Docker-образы).
- Данные при `uninstall` сохраняются; удаление — `--purge` / `-Purge`.
- `synth serve` печатает API-ключ в свой stdout при первом запуске — в
  systemd/LaunchAgent это попадает в журнал; ключ хранится в файле с правами 0600.
