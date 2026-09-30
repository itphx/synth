# AD-082: Full-образы и базовое развёртывание (flavor'ы с toolchain)

> **Статус:** ⏳ Не реализовано
> **Источник:** 2026-09-30 (выделено из [AD-077](./ad-077-runtime-toolchain.md); ближайший практический шаг)
> **Согласовано:** Debian для `browser`/`full`; `buildah` вместо `kaniko`; docker — только CLI (без socket); `lite` → `core`.

**Решение:** до появления executor'ов (AD-077, после AD-032) инструменты поставляются набором **flavor-образов** с toolchain. Базовый `slim` остаётся на alpine и публикуется в gitverse как сейчас; новые flavor'ы собираются multistage и публикуются (пока) в **gitea**. Образы применяются в **local containerized** (docker-compose, один пользователь) и **managed single-instance** (backend в 1 реплике). Исполнение остаётся в процессе backend'а.

## Решение

### Общий состав (hard deps)

Во **всех flavor'ах, кроме `slim`**, присутствуют обязательные инструменты тулов: `git`, `ripgrep`, `python3` (+`pip`, `venv`), `openssh-client`, `ca-certificates`. `git`/`openssh-client` — обязательны для git-тулов и SSH (AD-076), `ca-certificates` — для https-git и `pip`.

### Тиры

| Tier | Состав | Назначение |
|---|---|---|
| **0. Ядро** | `bash`, `curl`, `jq`, `yq`, `unzip`/`zip`, `xz`, `zstd`, GNU `coreutils`/`findutils`/`grep`/`sed`/`gawk`, `less`, `tree`, `openssl` | предсказуемый shell (busybox неполон: `grep -P`, GNU-флаги) |
| **1. Сборка** | `make`, `gcc`/`g++`, `musl-dev` (alpine) / `build-essential` (debian), `python3-dev`, `pkgconf`, `patch`, `diffutils`, `git-lfs`, `rsync` | нативные npm/pip-модули, сборка проектов |
| **2. Инфра/девопс** | `kubectl`, `helm`, `kustomize`, `ansible` (+`ansible-lint`), `terraform`/`opentofu`, `yamllint`, `shellcheck`, `hadolint` | инфраструктурные задачи |
| **3. Веб/браузер** | `playwright` + Chromium (+deps), `@playwright/mcp`, `libxml2-utils` | UI-верификация, webapp-тестирование |
| **4. MCP-хостинги** | MCP-серверы github, gitea, gitverse, gitlab | работа с SCM-хостингами |
| **БД** | `sqlite3`, `psql` (postgresql-client), `redis-cli`, `mysql-client` | клиенты БД |
| **Diag** | `bind-tools` (dig), `netcat`, `traceroute`, `lsof`, `iproute2`/`ss` | диагностика сети |
| **Docker** | docker **CLI** (без socket/демона) | работа с удалённым builder'ом |
| **Buildah** | `buildah` (rootless) | сборка образов из сессии |

`kaniko` **не** используется как инструмент внутри flavor'ов (это не утилита для вызова из шелла). Сборочный механизм самого CI пока остаётся прежним (kaniko в `release.yaml`); перевод CI на другой билдер — отдельное решение.

### Flavor-матрица

| Flavor | База | Состав | ≈ размер | Тег |
|---|---|---|---|---|
| **slim** | alpine | как сейчас (без инструментов) | ~130 МБ | `synth-backend:<v>` (gitverse) |
| **core** | alpine | hard deps + tier 0 | ~200 МБ | `:<v>-core` |
| **dev** | alpine | core + tier 1 + tier 4 + БД + buildah | ~700 МБ | `:<v>-dev` |
| **devops** | alpine | dev + tier 2 + diag + docker CLI + buildah (`devops ⊃ dev`) | ~1.2 ГБ | `:<v>-devops` |
| **browser** | debian | hard deps + tier 0 + tier 1 + tier 3 + playwright-MCP + diag | ~1.8 ГБ | `:<v>-browser` |
| **full** | debian | всё перечисленное (tier 2–4 + БД + diag + docker + buildah) | ~2.5–3 ГБ | `:<v>-full` |

- **Базы:** `slim`/`core`/`dev`/`devops` — alpine; `browser`/`full` — Debian (`node:22-bookworm-slim`), т.к. Playwright не поддерживает musl/glibc-несовместимость.
- **Теги, а не репозитории:** один репозиторий на образ, flavor — суффикс тега. В чарте — `backend.image.flavor` (по умолчанию `slim`).
- **`slim`** — легаси/базовый образ (публикуется как сейчас); при стабилизации `core` возможно его сворачивание.

### Multistage

Flavor'ы строятся **кумулятивно** (`FROM ... AS`), т.к. `COPY --from` не переносит установленные пакеты корректно (метаданные apk/apt, `.so`, пути). Дублирование списков между alpine и debian недопустимо — установка тиров выносится в **distro-aware скрипты** (`install-tier-N.sh`, выбирают `apk`/`apt`).

```
alpine:  common(0) ─► build(01) ─► mcp(014) ─► dev(014+БД+buildah) ─► devops(014+2+diag+docker+buildah)
debian:  common-d(0) ─► build-d(01) ─► browser(01+3+playwright-MCP+diag)
                                    └─► full(01+2+3+4+БД+diag+docker+buildah)
```

### Реестры и публикация

- `slim` — **gitverse** (как сейчас).
- Новые flavor'ы — **gitea** (пока), в перспективе gitverse. Два реестра одновременно: в CI нужны креды к gitea; в чарте — `imagePullSecrets`.
- **CI-сборка:** kaniko-шаги на каждый flavor; включить registry-cache (`--cache=true`), иначе повторные установки сделают сборку медленной.
- **Smoke-тест на каждый flavor в CI:** `git --version`, `rg --version`, `python3 --version`, `kubectl version --client`, `playwright --version` — ловит проблемы базы (особенно glibc/musl).

### Python-окружение

`HOME`, `PYTHONUSERBASE`, `PIP_CACHE_DIR` — на persistent-volume, иначе `pip install --user` эфемерен. Аналогично кэши: npm/pnpm, ansible-galaxy, helm-repos, `~/.config`.

### MCP-серверы

MCP остаётся **конфигурацией реестра** (AD-071); flavor'ы несут только рантаймы/бинари (tier 3–4). Бинари MCP-серверов **пекутся в образ** (pin + checksum; supply-chain — референс AD-068), а не устанавливаются в рантайме. Токены хостингов — из секрет-стора Synth (по образцу AD-076), инъекция при спавне, обфускация guard'ом (AD-036), **не в образ**.

## Что уже есть

| Факт | Где |
|---|---|
| Образы на `node:22-alpine`, **ни одного `apk add`**; нет `git`/`rg`/`python`/`ssh` | `docker/Dockerfile`, `docker/Dockerfile.backend`, `docker/Dockerfile.ui` |
| Сборка и публикация образов kaniko (`synth`, `synth-backend`, `synth-ui`) | `.gitverse/workflows/release.yaml` |
| backend: 1 реплика, PVC `data` → `/var/synth/data`, `runAsUser 1000` | `charts/synth/values.yaml`, `templates/backend-deployment.yaml` |
| `execute_shell` наследует `process.env`, `HOME` по умолчанию `/root` (при `runAsUser: 1000` — не writable) | `packages/core/src/engine/tools/shell.ts` |
| Детект внешних бинарников + `unavailable(dependency)` | `packages/core/src/engine/tools/runtime-deps.ts` (AD-078) |
| MCP — клиент + реестр (system/project/session), stdio и Streamable HTTP | `packages/core/src/engine/mcp/{client,manager,scope}.ts` (AD-071) |

## Дельта

1. **Multistage Dockerfile** с flavor-таргетами (`slim`/`core`/`dev`/`devops`/`browser`/`full`) и distro-aware скриптами тиров.
2. **Состав тиров** (0–4, БД, diag, docker, buildah) с закреплёнными версиями/checksum.
3. **Python-окружение** (`HOME`/`PYTHONUSERBASE`/`PIP_CACHE_DIR`) — образ + чарт/`extraEnv`.
4. **Публикация flavor'ов** в gitea; `imagePullSecrets`; registry-cache в CI.
5. **Smoke-тесты** каждый flavor в CI.
6. **local containerized**: docker-compose сценарий (backend + UI + volume), выбор flavor.
7. **Документация**: состав flavor'ов, размеры, требования, диагностика.

## Открытые вопросы

- **Версии tool'ов**: `kubectl`/`helm`/`terraform` версионно-зависимы от целевого кластера/проекта — фиксировать в образе или делать настраиваемыми?
- **Docker CLI** без socket: сценарии использования (remote builder/contexts) и как это документировать, чтобы не ждали работающего `docker build`.
- **Playwright-браузеры**: печь в образ (тяжело) или кэш на volume; какие браузеры (только Chromium?).
- **Нативные сборки Python**: ограничиться tier 1 или документировать, что часть пакетов всё равно не соберётся?
- **`uv`/`uvx`**: включать (для python-MCP и быстрых установок)?
- **Node-версии**: нужен ли version manager (fnm/volta) или одна версия 22?
- **CI-билдер**: остаётся kaniko или переводим и его на buildah?
- **Судьба `slim`**: когда/чем заменяется `core`.
- **Размер**: приемлемый бюджет и влияние на pull-time.

## Зависимости

- **AD-077** — целевая архитектура (executor, S3); flavor'ы — промежуточный шаг.
- **AD-032** — предпосылка AD-077; на AD-082 не влияет (single-instance).
- **AD-038** — сборка/публикация образов (npm/Docker/Helm).
- **AD-078** — реакция на отсутствие бинарников (до появления toolchain в образе).
- **AD-071** — MCP: реестр и политики; flavor'ы несут рантаймы/stdio-серверы.
- **AD-042** — гибрид (локальный запуск).
- **AD-076** — git-репозитории и SSH (требует `openssh-client`).
- **AD-068** — trust/supply-chain (референс для бинарей MCP).

## Связи

- [AD-077](./ad-077-runtime-toolchain.md) «Инструментальное окружение исполнения (toolchain и executor)».
- [AD-078](./ad-078-runtime-dependency-availability.md) «Авто-отключение инструментов при отсутствии внешней зависимости».
- [AD-071](./ad-071-mcp-servers-prompt.md) «MCP: уровни, реестр, политики».
- [AD-038](./ad-038-npm-packages.md) «Монорепо как набор публикуемых npm-пакетов».
- [docs/PUBLISHING.md](../PUBLISHING.md) — сборка Docker/Helm.
- [docs/DEVELOPMENT.md](../DEVELOPMENT.md) — dev-окружение, скрипты.

## Порядок реализации

1. Multistage Dockerfile + distro-aware скрипты тиров; flavor `core`.
2. flavor `dev` и `devops` (alpine-ветка).
3. flavor `browser` и `full` (debian-ветка; Playwright).
4. Python-окружение и кэши на volume.
5. Публикация в gitea + `imagePullSecrets` + registry-cache; smoke-тесты в CI.
6. local containerized: docker-compose + документация.
7. Документация: состав, размеры, диагностика.
