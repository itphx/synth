# PROP-082: Full-образы и базовое развёртывание (flavor'ы с toolchain)

> **Статус:** 🧩 Предложение — all-in-one образ (control plane + toolchain + исполнитель) и образы worker'ов; flavor'ы `slim`/`core`/`dev`/`devops`/`browser`/`full`; переключатель топологии — `execution.mode` (PROP-077)
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-21
> **Источник:** переработано 2026-10-21 (проработка двух топологий развёртывания: all-in-one vs отдельные контейнеры-исполнители)
> **Согласовано:** Debian для `browser`/`full`; `buildah` вместо `kaniko`; docker — только CLI (без socket); `lite` → `core`; публикация flavor'ов — в **приватный реестр Gitea** `git.itphx.ru` (не в Docker Hub).
> **Ближайший шаг:** split-топология (PROP-077, шаги 7–10). Шаги 1–6 сделаны.

**Решение:** развёртывание Synth описывается **двумя топологиями одной конфигурации**. По умолчанию (`execution.mode: inline`) работает **all-in-one** — один контейнер, в котором рядом живут control plane (backend), toolchain (набор инструментов для агентских тулов) и рантайм исполнителя. Вторая топология (`execution.mode: remote`) — **split**: control plane без toolchain'а (`synth-backend:<v>`) плюс отдельные контейнеры-исполнители (`synth-executor:<v>-<flavor>`). Переключатель — **параметр запуска** (секция `execution` в `config.yaml`, env `SYNTH_EXECUTION_MODE`, CLI `--execution-mode`), смена топологии — только перезапуск процесса. Исполнитель и all-in-one образ — **один и тот же код**: он умеет работать и отдельным сервисом, и локально внутри backend'а; различает их только порт исполнения `ExecutionPort` (в репозитории есть — шаг 1 плана реализации; см. «Дельта», п. 1). Split-топология, доверенная граница backend → исполнитель, S3 и жизненный цикл worker'ов — предмет [PROP-077](./prop-077-runtime-toolchain.md); здесь фиксируются all-in-one, flavor-матрица образов и единая модель переключения.

## Две топологии развёртывания: all-in-one и split

| Режим | `execution.mode` | Где исполняется | Образы |
|---|---|---|---|
| **Inline (all-in-one)** | `inline` (дефолт) | в процессе backend'а | один образ: control plane + toolchain (+ рантайм исполнителя) |
| **Remote (split)** | `remote` | в отдельных контейнерах-исполнителях | `synth-backend` (control plane, без toolchain) + `synth-executor` (worker) |

### All-in-one: что в одном контейнере

Физически в одном контейнере (образ `synth-backend:<v>-<flavor>`):

- **Control plane** — процесс `@itphx/synth-backend`: OIDC/RBAC, API v2, LLM Gateway. Сегодня это ровно образ `docker/Dockerfile.backend` (сборка из исходников монорепо — `docker/Dockerfile.backend:1-3`, запуск `node dist/main.js` — `docker/Dockerfile.backend:69`).
- **Toolchain** — инструменты, которые нужны агентским тулам: `git`, `ripgrep`, `python3`, `openssh-client` и далее по тирам (см. «Общий состав» и «Тиры инструментов»). В **базовом** образе control plane (`slim`) пакетов **нет ни одного** — только `COPY`/`ENV`/`CMD`, без `apk add` (`docker/Dockerfile:62-95`, `docker/Dockerfile.ui:25-43`); toolchain'а добавляют flavor-стадии `core`/`dev`/`devops`/`browser`/`full` (шаги 2, 4, 5).
- **Рантайм исполнителя** — тот же код, что и в образе worker'а (`synth-executor`), но запущенный локально: отдельный процесс (или изолированный поток) внутри контейнера, а не смешанный с процессом backend'а. Именно он — «исполнитель» из [PROP-077](./prop-077-runtime-toolchain.md), только встроенный, а не отдельный сервис.
- **Workspace и кэши** — рабочий каталог проекта и кэши инструментов живут на том же volume'е, что и данные инстанса: PVC `data` → `/var/synth/data` (`charts/synth/templates/backend-deployment.yaml:133-135`, `charts/synth/values.yaml:39-50`), provisioning workspace — `packages/core/src/engine/workspace-provision.ts` (ADR-075).

**Почему это не «просто большой backend».** Границы остаются теми же, что и в split-топологии:

- LLM-ключи и OIDC-секреты живут **только у control plane** — они приходят из Kubernetes Secret (`charts/synth/values.yaml:386-390`, `charts/synth/templates/backend-deployment.yaml:69-85`), в ConfigMap/образ не попадают (инвариант 13).
- Исполнитель — **отдельный процесс** с собственным контекстом: свой пользователь ОС, свой `HOME`, свой набор env, лимиты и квоты. Он не имеет доступа к keychain'у backend'а в объёме, сопоставимом с его собственной работой, и не делит с backend'ом один `process.env` — сейчас shell-тул наследует весь `process.env` процесса backend'а и подставляет `HOME` по умолчанию `/root` (`packages/core/src/engine/tools/shell.ts:52`), что при `runAsUser: 1000` (`charts/synth/values.yaml:113-118`) не writable.

**Преимущества all-in-one:**

- один образ — одно расписание pull'ов и одна версия toolchain'а на инстанс (в split-топологии версия toolchain'а привязана к версии worker'а и может «разъехаться» с control plane);
- toolchain-слои не размножаются на число HTTP-реплик control plane — в split-топологии каждый worker тянет свой полный образ с toolchain'ом;
- нет сетевой границы и токена в доверенном контуре: исполнение локально, workspace виден напрямую, RWX-PVC не нужен;
- нулевая задержка запуска команды (без сетевого round-trip) и отсутствие классификации «исполнитель недоступен».

**Риски смешения в одном контейнере:**

- исполняемые агентом команды живут в том же окружении, где лежат OIDC/LLM-секреты control plane, — компрометация исполнителя = компрометация control plane; в split-топологии эта граница естественна (у worker'а нет ни LLM-ключей, ни OIDC-секретов);
- отсутствует сетевой барьер между «произвольным shell» и egress'ом control plane — компенсируется только egress-политикой `egress.tools` (ADR-099) и запретом `docker.sock`;
- при переходе на split-топологию all-in-one образ остаётся как «толстый control plane» — его нельзя откатить вчерашним `synth-backend:<v>` без смены `execution.mode` (перезапуск).

Отсюда правила: `docker.sock` **не монтируется ни в одном flavor'е**; docker — только CLI (без демона); исполнение изолируется пользователем ОС и лимитами; сеть исполнителя ограничивается egress-политикой.

### Переключатель execution.mode (кратко, отсылка к PROP-077)

Секция `execution` в `config.yaml`:

| Поле | Значение | Смысл |
|---|---|---|
| `mode` | `inline` (дефолт) \| `remote` | топология исполнения |
| `remote.url` | список адресов исполнителей (пул), например `http://synth-executor:5100` | адреса split-топологии; пусто при `remote` → fail-closed на старте |
| `remote.timeoutMs` | по умолчанию 30 с (shell — до 120 с) | таймаут команды; сейчас 30 с / максимум 120 с (`packages/core/src/engine/tools/shell.ts:14`, `packages/core/src/engine/tools/shell.ts:22`) |
| `remote.concurrency` | число одновременных команд (дефолт — число CPU backend'а) | ограничение нагрузки на worker'ов |
| `remote.failMode` | `fail` (дефолт, fail-closed) \| `inline-fallback` | что делать, если исполнитель недоступен |
| `remote.tokenSecret` | путь/ссылка на токен | **не значение** (инвариант 13) |

Env-имена: `SYNTH_EXECUTION_MODE`, `SYNTH_EXECUTION_REMOTE_URL`, `SYNTH_EXECUTION_TOKEN`, `SYNTH_EXECUTION_TIMEOUT_MS`, `SYNTH_EXECUTION_CONCURRENCY`, `SYNTH_EXECUTION_FAIL_MODE`. Приоритет — **CLI-флаг > env > `config.yaml` > дефолт** (ADR-023), как у `storage.backend` (ADR-023/ADR-096: `packages/shared/src/config/resolve.ts:283-306`).

**Смена — только перезапуск процесса.** Переключатель меняет не «настройку», а то, с каким набором процесс-глобальных singleton'ов работает инстанс (диспетчер/пул/исполнитель), поэтому переинициализация «на лету» запрещена инвариантом 24 — перезапуск инстанса только graceful, с кодом 75 (`packages/core/src/server/restart.ts:23`, `packages/core/src/server/restart.ts:176-191`). Обоснование — тот же класс решения, что у `storage.backend` (ADR-096) и у режимов-полюсов PROP-080 (переключение standalone↔hybrid — тоже только при запуске).

## Общий состав (hard deps)

Во **всех flavor'ах, кроме `slim`**, присутствуют обязательные инструменты тулов: `git`, `ripgrep`, `python3` (+`pip`, `venv`), `openssh-client`, `ca-certificates`.

| Инструмент | Зачем | Где нужен сейчас |
|---|---|---|
| `git` | git-тулы (`git_status`…`git_stash`) | `packages/core/src/engine/tools/git.ts:30`, `packages/core/src/git/git-service.ts:132` |
| `ripgrep` | `grep_files` | `packages/core/src/engine/tools/search.ts:49` (вывод обрезается до 200 строк — `packages/core/src/engine/tools/search.ts:58`) |
| `python3` (+`pip`, `venv`) | пользовательский код в `execute_shell` | `packages/core/src/engine/tools/shell.ts:45` |
| `openssh-client` | SSH к репозиториям (ADR-076) | `packages/core/src/git/git-service.ts:132`, `packages/core/src/storage/ssh-key-store.ts` |
| `ca-certificates` | https-git и `pip` | https-git: `packages/core/src/git/git-service.ts:116-132` (CA передаётся per-вызовом, `packages/core/src/security/tls.ts:302`) |

В базовом образе control plane (`slim`) ни одного из них нет (см. «Что уже есть»): тулы с внешней зависимостью помечаются недоступными с причиной `dependency` (`packages/core/src/engine/permission/availability.ts:22`, `packages/core/src/engine/tools/runtime-deps.ts:47-61`), детект — `bin --version` с таймаутом 3 с, fail-open и кэшем на уровне модуля (`packages/core/src/engine/tools/runtime-deps.ts:19`, `packages/core/src/engine/tools/runtime-deps.ts:77-99`). В flavor-образах (шаги 2, 4, 5) они присутствуют — состав по тирам в разделе «Состав по тирам».

## Тиры инструментов

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

`kaniko` **не** используется как инструмент внутри flavor'ов (это не утилита для вызова из шелла): в образ идёт `buildah`, CI-билдер переводится с `kaniko` на `buildah` (в репозитории CI пока kaniko — `.gitverse/workflows/release.yaml:372`, `.gitverse/workflows/release.yaml:570`).

## Flavor-матрица (all-in-one и образы worker'ов)

Разводим три вида тегов:

| Тег | Что это | Состав |
|---|---|---|
| `synth-backend:<v>` | control plane **без** toolchain'а (базовый, «slim») | node-приложение + рантайм, без внешних инструментов |
| `synth-backend:<v>-<flavor>` | **all-in-one**: control plane + toolchain'а (+ рантайм исполнителя) | control plane + слои toolchain'а |
| `synth-executor:<v>-<flavor>` | **worker**: только toolchain + рантайм исполнителя | слои toolchain'а без node-приложения |

### All-in-one образы (`synth-backend:<v>-<flavor>`)

| Flavor | База | Состав | Размер | Тег |
|---|---|---|---|---|
| **slim** | alpine | как сейчас (без инструментов) | **64,0 МБ** (измерен) | `synth-backend:<v>` |
| **core** | alpine | hard deps + tier 0 | **101,6 МБ** (измерен) | `synth-backend:<v>-core` |
| **dev** | alpine | core + tier 1 + tier 4 + БД + buildah | **320,1 МБ** (измерен) | `synth-backend:<v>-dev` |
| **devops** | alpine | dev + tier 2 + diag + docker CLI + buildah (`devops ⊃ dev`) | **508,5 МБ** (измерен) | `synth-backend:<v>-devops` |
| **browser** | debian | hard deps + tier 0 + tier 1 + tier 3 + playwright-MCP + diag | **674,9 МБ** (измерен) | `synth-backend:<v>-browser` |
| **full** | debian | всё перечисленное (tier 2–4 + БД + diag + docker + buildah) | **925,5 МБ** (измерен) | `synth-backend:<v>-full` |

Размеры — **измерения** (content, `docker image inspect .Size`, amd64, node 22.23.3; alpine 3.24.2 / bookworm). Шаги 2 и 4 дали `slim`/`core`/`dev`/`devops`; шаг 5 добавил debian-ветку `browser`/`full` и worker-образы `synth-executor` (`core` — **107,0 МБ**, `full` — **930,8 МБ**). Прежние **оценки** для `browser`/`full` (1,8 ГБ / 2,5–3 ГБ) оказались завышены — см. «Замеры размеров» в разделе шага 5. Регрессии по `slim` нет: состав образа не изменился (манифест из 9224 записей совпадает с эталоном — расходятся только `.modules.yaml` с меткой времени pnpm и `/etc/hostname`/`/etc/hosts`, которые выдаёт рантайм контейнера).

### Flavor `core`: точный состав (реализовано, шаг 2)

Образ `synth-backend:<v>-core` — all-in-one: control plane (тот же `node dist/main.js`, что и в `slim`) + toolchain. Сборка — `docker build -f docker/Dockerfile.backend --target core`.

| Группа | Состав |
|---|---|
| hard deps | `git`, `ripgrep`, `python3` (+`pip`, `venv`), `openssh-client`, `ca-certificates` |
| tier 0 | `bash`, `curl`, `jq`, `yq`, `unzip`/`zip`, `xz`, `zstd`, GNU `coreutils`/`findutils`/`grep`/`sed`/`gawk`, `less`, `tree`, `openssl` |

Список пакетов — **один на тир**, без дублей между дистрибутивами; расхождение имён зафиксировано в скриптах (`docker/install-hard-deps.sh`, `docker/install-tier-0.sh` + общий `docker/install-lib.sh`, который сам выбирает `apk`/`apt` по базе; POSIX `sh`, `set -eu`, идемпотентно, без интерактива):

| Пакет | alpine (`apk`) | debian (`apt`) |
|---|---|---|
| `git`, `ripgrep`, `python3`, `ca-certificates` | те же | те же |
| `pip` | `py3-pip` | `python3-pip` |
| `venv` | `python3` — отдельного пакета venv нет, в `python3` входит `ensurepip` | `python3-venv` |
| `openssh-client` | `openssh-client` (виртуальное имя → `openssh-client-default`) | `openssh-client` |
| `xz` | `xz` | `xz-utils` |
| `yq` | `yq` — Go-реализация mikefarah/yq (v4) | `yq` — python-реализация kislyuk/yq, **CLI несовместим**; для debian-ветки (`browser`/`full`) нужен пин Go-варианта (PROP-068) |
| остальные tier 0 | те же | те же |

Python-окружение в flavor-стадии: `HOME=/home/synth`, `PYTHONUSERBASE=/home/synth/.local`, `PIP_CACHE_DIR=/home/synth/.cache/pip`; каталоги принадлежат **uid 1000** — в базовом `node:22-alpine` этот uid уже занят пользователем `node`, второй аккаунт с uid 1000 создать нельзя, поэтому отдельная учётная запись не заводится (важен uid: под `runAsUser: 1000` каталоги writable). `HOME` по умолчанию `/root` при `runAsUser: 1000` не writable. В `slim` ничего не меняется. Volume под кэши + `fsGroup` в чарте/compose — шаги 7/12.

### Реализация шага 4: flavor'ы `dev`/`devops` (alpine-ветка)

Обе ветки — **alpine** (`node:22-alpine`), та же база, что у `core`/`slim`; отличаются только составом toolchain'а. Реализовано в `docker/Dockerfile.backend`: стадия `core` (шаг 2) → стадия `dev` → стадия `devops`; стадия `slim` осталась **последней** и не изменилась ни байтом (63,8 МБ — те же, что после шага 2).

| Стадия | База | Что добавляет | Где |
|---|---|---|---|
| `dev` | `FROM core` | tier 1 (сборка) + БД-клиенты + buildah + tier 4 (MCP-серверы npm) | `docker/Dockerfile.backend:149-168` |
| `devops` | `FROM dev` | tier 2 (инфра) + диагностика + docker CLI | `docker/Dockerfile.backend:180-193` |
| `slim` | `node:22-alpine` | ничего — цель по умолчанию | `docker/Dockerfile.backend:203-224` |

В стадии `dev` слои разделены на два `RUN`: сначала системные пакеты (tier 1 → БД → buildah), затем отдельный npm-слой (tier 4) — смена состава MCP-серверов не должна инвалидировать слои с системными пакетами (`docker/Dockerfile.backend:160-168`). В стадии `devops` все скрипты идут одним `RUN` (`docker/Dockerfile.backend:189-193`).

#### Скрипты установки

| Скрипт | Назначение | Строки |
|---|---|---|
| `docker/install-lib.sh` | общий код: выбор пакетного менеджера, разбор таблиц `logical\|apk\|apt`, upstream-бинарники (пин + sha256), npm-пакеты (пин + integrity) | `docker/install-lib.sh:42-236` |
| `docker/install-tier-1.sh` | tier 1 — сборка (нативные модули, проекты) | `docker/install-tier-1.sh:48-61` |
| `docker/install-db-clients.sh` | клиенты БД (sqlite3/psql/redis-cli/mysql) | `docker/install-db-clients.sh:47-54` |
| `docker/install-buildah.sh` | buildah + зависимости + диапазоны subuid/subgid | `docker/install-buildah.sh:88-113` |
| `docker/install-tier-4.sh` | MCP-серверы SCM-хостингов (npm, пин + integrity) | `docker/install-tier-4.sh:53-73` |
| `docker/install-tier-2.sh` | tier 2: дистрибутивные пакеты + upstream-релизы + симлинк `terraform` | `docker/install-tier-2.sh:50-94` |
| `docker/install-diag.sh` | диагностические утилиты (dig/nc/traceroute/lsof/ss) | `docker/install-diag.sh:39-47` |
| `docker/install-docker-cli.sh` | docker CLI (alpine — пакет; debian — fail-closed) | `docker/install-docker-cli.sh:24-40` |

Все скрипты — POSIX `sh`, `set -eu`, идемпотентны, неинтерактивны (`apk --no-cache`, `apt-get -y --no-install-recommends`), **не знают про дистрибутив**: сами выбирают `apk`/`apt-get` по наличию менеджера, неизвестная база → fail-closed с ошибкой, а не «молча пропустить» пакеты (`docker/install-lib.sh:42-51`, `docker/install-lib.sh:57-93`). Списки пакетов — **по одному на тир** в формате `logical|apk|apt`; различаются только ИМЕНА пакетов (`docker/install-lib.sh:5-14`).

#### Точный состав пакетов

**Tier 1 — сборка** (`docker/install-tier-1.sh:48-59`):

| logical | apk | apt |
|---|---|---|
| `make` | `make` | `make` |
| `gcc` | `gcc` | `gcc` |
| `g++` | `g++` | `g++` |
| `musl-dev` | `musl-dev` | `build-essential` (вместе с `libc6-dev`) |
| `python3-dev` | `python3-dev` | `python3-dev` |
| `pkgconf` | `pkgconf` | `pkg-config` (виртуальное имя на pkgconf) |
| `patch` | `patch` | `patch` |
| `diffutils` | `diffutils` | `diffutils` |
| `git-lfs` | `git-lfs` | `git-lfs` |
| `rsync` | `rsync` | `rsync` |

**Клиенты БД** (`docker/install-db-clients.sh:47-52`):

| logical | apk | apt |
|---|---|---|
| `sqlite3` | `sqlite` | `sqlite3` |
| `psql` | `postgresql17-client` | `postgresql-client` |
| `redis-cli` | `redis` (клиент вместе с сервером; сервер не запускается) | `redis-tools` (без сервера) |
| `mysql-client` | `mysql-client` | `mariadb-client` (в debian `mysql-client` — виртуальное имя) |

В alpine версия PG-клиента зафиксирована явно (`postgresql17-client`): виртуальное имя `postgresql-client` резолвится в postgresql-BDR-клиент 9.4 — это не то, что нужно; клиент PG17 совместим с серверами 9.2+ (`docker/install-db-clients.sh:37-40`).

**Buildah и зависимости** (`docker/install-buildah.sh:88-96`):

| logical | apk | apt |
|---|---|---|
| `buildah` | `buildah` | `buildah` |
| `crun` | `crun` | `crun` |
| `netavark` | `netavark` | `netavark` |
| `aardvark-dns` | `aardvark-dns` | `aardvark-dns` |
| `fuse-overlayfs` | `fuse-overlayfs` | `fuse-overlayfs` |
| `slirp4netns` | `slirp4netns` | `slirp4netns` |
| `shadow-subids` | `shadow-subids` | `uidmap` |

В alpine `netavark`/`aardvark-dns` кладутся в `/usr/libexec/podman/`, а не в `PATH` — buildah находит их сам (проверено сборкой образа). Дополнительно скрипт добавляет диапазон `node:100000:65536` в `/etc/subuid` и `/etc/subgid` — без него buildah не может маппить uid/gid непривилегированного пользователя («no subuid ranges found for user "node"»); правка идемпотентна (`docker/install-buildah.sh:100-113`).

**Tier 2 — дистрибутивная часть** (`docker/install-tier-2.sh:50-55`): имена в alpine и debian **совпадают** (в отличие от hard-deps/tier 0/tier 1):

| logical | apk | apt |
|---|---|---|
| `ansible` | `ansible` | `ansible` |
| `ansible-lint` | `ansible-lint` | `ansible-lint` |
| `yamllint` | `yamllint` | `yamllint` |
| `shellcheck` | `shellcheck` | `shellcheck` |

**Tier 2 — upstream-релизы** (`docker/install-tier-2.sh:79-85`): состав **не зависит от дистрибутива** — одна таблица на обе ветки (alpine `devops` и debian-ветка шага 5):

| logical | версия | источник | sha256 amd64 | sha256 arm64 |
|---|---|---|---|---|
| `kubectl` | 1.37.1 | `dl.k8s.io/release/v1.37.1/bin/linux/<arch>/kubectl` | `65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8` | `ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7` |
| `helm` | 3.22.1 | `get.helm.sh/helm-v3.22.1-linux-<arch>.tar.gz` | `896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea` | `4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d` |
| `kustomize` | 5.8.3 | релиз `kubernetes-sigs/kustomize` | `cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61` | `9867b76482cfc6d25b546abc1d2b5a32bd137505aba640649b4b378f64f6d68f` |
| `tofu` (OpenTofu) | 1.13.1 | релиз `opentofu/opentofu` | `378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69` | `9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3` |
| `hadolint` | 2.15.1 | релиз `hadolint/hadolint` | `c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507` | `f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d` |

Контрольные суммы взяты из официальных файлов релизов и зафиксированы вместе с источниками, чтобы ревизор мог их перепроверить: `kubectl.sha256`, `helm-*.tar.gz.sha256sum`, `checksums.txt` (kustomize), `tofu_1.13.1_SHA256SUMS` (OpenTofu), `checksums.sha256` (hadolint) (`docker/install-tier-2.sh:71-77`).

**Диагностика** (`docker/install-diag.sh:39-45`):

| logical | apk | apt |
|---|---|---|
| `dig` | `bind-tools` | `dnsutils` |
| `netcat` | `netcat-openbsd` | `netcat-openbsd` |
| `traceroute` | `traceroute` | `traceroute` |
| `lsof` | `lsof` | `lsof` |
| `ss` | `iproute2` | `iproute2` |

**Docker** (`docker/install-docker-cli.sh:24-40`): в alpine ставится отдельный пакет `docker-cli` (только клиент, зависит лишь от `ca-certificates`; демон в него не входит). В debian отдельного пакета нет, а `docker.io` тянет `dockerd`+`containerd` — поэтому debian-ветка **fail-closed**: скрипт печатает явное сообщение и завершает работу с ненулевым кодом (сборка падает, а не молча ставит демон в образ). Вариант для debian — статический bundle `download.docker.com` (см. «Открытые вопросы»).

#### Tier 4: MCP-серверы (npm, пин + integrity)

MCP-серверы публикуются в npm, поэтому ставятся не дистрибутивными пакетами, а через npm — но **с зафиксированной версией и проверкой integrity тарбола** (`docker/install-tier-4.sh:36-58`):

| logical | npm-пакет | версия | integrity (sha512, base64) | режим запуска |
|---|---|---|---|---|
| `mcp-server-github` | `@modelcontextprotocol/server-github` (официальный) | 2025.4.8 | `8N43bQw9MlUB0piTZHK2JMh8kYPKxH57d4Z7Wb8PS4by2MkZ0FzI5xPImg3xumpev82VZw2VWHQJJJYp+WkwEw==` | `bin` |
| `mcp-server-gitlab` | `@modelcontextprotocol/server-gitlab` (официальный) | 2025.4.25 | `IQY57XkHjaIcSOWi+Qs9w8ZZMqhz5YOYOkU3v1CTbHU8rcIm/NhtX4/7XBeFRgXwRpvTuGP+WdnWg+1hH/wJdw==` | `bin` |
| `gitea-mcp` | `@boringstudio_org/gitea-mcp` (сторонний — официального MCP-сервера Gitea в npm нет) | 2.0.0 | `75pRunAZ/LD+Jw8bLg3YmzPjIuUJZnEkpnMXQMMQQFXTBJheYfIZcxRHpUAyRKiH6c+gTpfYBxDhNqVUKQCGvQ==` | `direct` |
| `gitverse-mcp` | `@grigoriy-grisha/gitverse-mcp` (сторонний: штатный GitVerse MCP — удалённый HTTP-сервис `mcp.gitverse.ru`, stdio-вариант нужен именно как локальный бинарь) | 1.1.0 | `RmdjgIx8131Gpytst2eVGwbh53el4TbczlPbxaxbXrGHM8oUNZep/We/XTM9LUrm6npAnnyYI6EdA/+cMurnMw==` | `bin` |

Порядок установки: тарбол скачивается напрямую по зафиксированному URL → сверяется sha512 с зафиксированным значением → только при совпадении выполняется `npm install -g` (зависимости самого сервера npm проверяет по integrity реестра) → для серверов с режимом запуска `direct` npm-бин заменяется launcher'ом (см. «Обход дефекта пакета `gitea-mcp`»). Расхождение контрольной суммы = **ошибка сборки** (fail-closed) (`docker/install-lib.sh:212-236`). Пакеты выбраны так, чтобы работать на node 22 в образе; кандидаты с `engines.node >= 24` отклонены (`docker/install-tier-4.sh:24-25`).

**Обход дефекта пакета `gitea-mcp`.** Пакет `@boringstudio_org/gitea-mcp@2.0.0` поднимает сервер **только** под guard'ом `if (process.argv[1] === fileURLToPath(import.meta.url))`. npm кладёт bin **симлинком** (`/usr/local/bin/gitea-mcp` → `../lib/node_modules/@boringstudio_org/gitea-mcp/index.js`), node в `process.argv[1]` оставляет путь **симлинка**, а ESM-лоадер в `import.meta.url` — **реальный** путь (симлинки резолвятся). Пути не совпадают → guard не срабатывает → процесс **молча завершается с кодом 0**, stdio-транспорт не поднимается (дефект пакета, не наш).

Обход — в таблице состава tier 4 добавлено поле «режим запуска» (`bin` | `direct`); для `gitea-mcp` — `direct`: **после** установки (пин версии и integrity при этом **не меняются** — launcher создаётся уже после успешной установки проверенного тарбола) npm-бин заменяется launcher'ом `synth_npm_direct_launcher` (`docker/install-lib.sh:264-302`, вызов — `docker/install-tier-4.sh:93-95`). Launcher запускает **реальный** файл пакета по его собственному пути — тогда `process.argv[1]` совпадает с `import.meta.url`, и guard срабатывает. Файл пакета не копируется и остаётся на месте: иначе ломаются относительные `require`'ы внутри пакета. Остальные три сервера работают через обычный npm-бин.

**Токены хостингов в образ НЕ запекаются** (ADR-076/ADR-036) — MCP-сервер читает их из окружения в рантайме: `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITLAB_PERSONAL_ACCESS_TOKEN`/`GITLAB_API_URL`, `GITEA_TOKEN`/`GITEA_API_URL`, `GITVERSE_TOKEN` (`docker/install-tier-4.sh:17-22`).

#### Почему upstream-поставки, а не дистрибутивные пакеты

Разделение сделано **по свойству инструмента**, а не по вкусу:

| Критерий | Дистрибутивный пакет (`apk`/`apt`) | Upstream-релиз (пин + sha256) |
|---|---|---|
| Версия | версия дистрибутива — под нашим контролем только косвенно | фиксируется точно; версия привязана к целевому кластеру/проекту |
| Проверка целостности | подпись репозитория дистрибутива | явный sha256 каждого артефакта, сверить с официальным файлом релизов |
| Воспроизводимость сборочного окружения | «сегодня alpine 3.24 → завтра 3.25» — состав может поехать | один и тот же бинарь при любой базе |
| Supply-chain (PROP-068) | доверие к дистрибутиву | доверие к конкретному артефакту с зафиксированной суммой |

Поэтому `kubectl`/`helm`/`kustomize`/`tofu`/`hadolint` берутся из upstream-релизов с пином версии и sha256, а `ansible`/`ansible-lint`/`yamllint`/`shellcheck` — из репозитория дистрибутива: их версии не привязаны к целевому кластеру, а состав и так совпадает в обеих ветках. SHA256 проверяется **до** распаковки, несовпадение — fail-closed (`docker/install-lib.sh:162-171`); загрузка идёт с `curl --retry 5 --retry-delay 3 --retry-all-errors` (`--retry-all-errors` — чтобы повторялись и сетевые сбои вроде отказа DNS, а не только таймауты/5xx; контрольная сумма проверяется после скачивания, поэтому повторы на безопасность не влияют) (`docker/install-lib.sh:155-163`).

#### OpenTofu вместо Terraform

В образ ставится **OpenTofu** (бинарь `tofu`) — FOSS-продолжение HashiCorp Terraform — и создаётся симлинк `terraform` → `tofu` для привычного интерфейса (команды и формат конфигурации/стейтов совместимы; `terraform version` при этом честно печатает «OpenTofu»). Сам HashiCorp Terraform (лицензия BUSL) в образ **не кладём** (`docker/install-tier-2.sh:89-94`).

#### Ограничения buildah в контейнере

В образ попадают только **клиентские части**; работоспособность определяется правами рантайма, а не составом образа. В образе нет ничего, что выдавало бы нерабочий сценарий за рабочий (никаких «готовых» конфигов и подсказок в `PATH`) (`docker/install-buildah.sh:8-24`, `docker/install-buildah.sh:49-54`).

Проверенные требования (rootful, в контейнере):

```bash
docker run --rm \
  --cap-add=SYS_ADMIN --cap-add=SYS_RESOURCE \
  --device /dev/fuse \
  -e TMPDIR=/dev/shm \
  synth-backend:<v>-devops \
  buildah bud --isolation=chroot -t demo:latest .
```

- без `CAP_SYS_ADMIN` — падение на `unshare(CLONE_NEWUSER): Operation not permitted`;
- без `CAP_SYS_RESOURCE` — падение на `RLIMIT_NOFILE`;
- без `/dev/fuse` — падение на `fuse-overlayfs` (драйвер хранилища по умолчанию — overlay);
- без `TMPDIR` не на overlayfs — падение на монтировании контекста сборки («invalid argument»): это свойство ФС хоста, а не образа;
- `--isolation=chroot` обязателен: по умолчанию buildah использует `runc` + mount-пространства, что внутри контейнера без `CAP_SYS_ADMIN` не работает.

Rootless (от uid 1000) — те же требования плюс writable `--root`/`--runroot` (каталог `/run/containers` по умолчанию непривилегированному пользователю недоступен) и диапазоны subuid/subgid (в образе заведены):

```bash
buildah --root "$HOME/.local/share/containers/storage" \
         --runroot /dev/shm/runroot \
         bud --isolation=chroot -t demo:latest .
```

В типовом pod'е (например, с `allowPrivilegeEscalation: false` и без `SYS_ADMIN`, `charts/synth/values.yaml:112-118`) эти условия недоступны — то есть **полноценная сборка образов из сессии в типовом развёртывании не работает**; в образе зафиксированы только клиентские части, а решение по worker'у (отдельный профиль capability либо вынос сборки образов из образов Synth) — открытый вопрос (см. «Открытые вопросы»).

#### Что проверено сборками и smoke-тестами

| Проверка | Результат |
|---|---|
| Сборка `slim` / `core` / `dev` / `devops` | EXIT=0 для всех четырёх таргетов |
| Регрессия `slim` | состав образа не изменился (манифест совпадает с эталоном — расходятся только `.modules.yaml` и `/etc/hostname`/`/etc/hosts`); toolchain'а в нём нет (`dig`/`kubectl`/`buildah`/`docker`/`python3`/`git` отсутствуют), `nc` и `lsof` остались busybox-апплетами базового образа (симлинки на `/bin/busybox`) |
| `dev`: бинарники tier 1 | `make`/`gcc`/`g++`/`pkgconf`/`patch`/`diff`/`diff3`/`git-lfs`/`rsync` на месте; `musl-dev`/`python3-dev` — пакеты с заголовками, не команды |
| `dev`: MCP-серверы | все четыре в `/usr/local/bin` и **все четыре отвечают на `initialize` по stdio** (`mcp-server-github` — `serverInfo.version` 0.6.2, внутренняя версия пакета `@modelcontextprotocol/server-github@2025.4.8`; `gitea-mcp` — `serverInfo.name` = `gitea-proxy-agent`, через launcher на реальный файл пакета, без него stdio не поднимается) |
| `dev`: python | `python3 -m venv` работает; запуск от `--user 1000:1000` → `HOME`/`~/.local`/`~/.cache/pip` writable |
| `dev`/`devops`: control plane | `node dist/main.js` → `GET /health` = 200 |
| `devops`: tier 2 | `kubectl` v1.37.1, `helm` v3.22.1, `kustomize` v5.8.3, `tofu` v1.13.1 (+ симлинк `terraform`), `ansible`, `ansible-lint`, `yamllint`, `shellcheck`, `hadolint` 2.15.1 — работают |
| `devops`: диаг/БД | `dig`, `nc`, `traceroute`, `lsof`, `ss`, `sqlite3`, `psql`, `redis-cli`, `mysql` — работают |
| `devops`: docker | `docker --version` = 29.8.2; `docker info` падает («no such file or directory») — демона нет, ожидаемо; `dockerd`, `containerd`, `docker.sock` в образе отсутствуют |
| `devops`: buildah | end-to-end сборка образа проходит с `--cap-add=SYS_ADMIN --cap-add=SYS_RESOURCE --device /dev/fuse -e TMPDIR=/dev/shm buildah bud --isolation=chroot`; rootless от uid 1000 — с `--root`/`--runroot`; без этих условий — падение (см. выше) |

Замеры размера — content (`docker image inspect <tag> --format '{{.Size}}'`), amd64, node 22.23.3 / alpine 3.24.2: `slim` — **63,8 МБ** (на шаге 5 пересчитано: **64,0 МБ** — вырос состав развёрнутых зависимостей монорепо; регрессии по **составу** образа нет, см. проверку манифеста), `core` — **101,6 МБ**, `dev` — **320,1 МБ**, `devops` — **508,5 МБ**.

### Реализация шага 5: flavor'ы `browser`/`full` (debian-ветка) и образы исполнителей

Шаг 5 закрывает две вещи:

1. **debian-ветка flavor'ов** `browser`/`full` — там, где нужен Playwright/Chromium: под musl (alpine) готовых сборок браузеров нет, поэтому база этих flavor'ов — glibc (`node:22-bookworm-slim`);
2. **образы исполнителей** `synth-executor:<v>-<flavor>` — worker'ы split-топологии ([PROP-077](./prop-077-runtime-toolchain.md)): toolchain + рантайм исполнителя, без control plane.

Реализовано в `docker/Dockerfile.backend` (стадии `browser`/`full`) и в новом `docker/Dockerfile.executor` (все пять flavor'ев). Списки пакетов **не дублируются** — обе ветки используют одни и те же distro-aware скрипты `docker/install-*.sh`.

#### Схема стадий

`docker/Dockerfile.backend` — all-in-one (control plane + toolchain):

```text
build (--platform=$BUILDPLATFORM) — сборка монорепо, pnpm deploy, chmod
  ├─► core    (alpine) — hard deps + tier 0 + control plane                  (шаг 2)
  │    └─► dev    (alpine) — + tier 1 + БД + buildah + tier 4                (шаг 4)
  │         └─► devops (alpine) — + tier 2 + diag + docker CLI               (шаг 4)
  ├─► browser (debian) — hard deps + tier 0 + tier 1 + tier 3 + diag        (шаг 5)
  │    └─► full    (debian) — + tier 2 + tier 4 + БД + docker CLI + buildah (шаг 5)
  └─► slim    (alpine) — control plane без toolchain'а; ПОСЛЕДНЯЯ стадия ⇒
                         сборка без --target даёт ровно прежний slim-образ
```

`docker/Dockerfile.executor` — worker (toolchain + рантайм исполнителя, без control plane):

```text
build (--platform=$BUILDPLATFORM) — сборка монорепо (shared → core → executor),
                                    два pnpm deploy: /out/app и /out/core
  ├─► core    (alpine) — hard deps + tier 0 + рантайм исполнителя
  │    └─► dev    (alpine) — + tier 1 + БД + buildah + tier 4
  │         └─► devops (alpine) — + tier 2 + diag + docker CLI
  ├─► browser (debian) — hard deps + tier 0 + tier 1 + tier 3 + diag        (шаг 5)
  │    └─► full    (debian) — + tier 2 + tier 4 + БД + docker CLI + buildah (шаг 5)
```

Стадии `slim` в `Dockerfile.executor` нет: worker без toolchain'а бессмысленен. Порядок стадий в `Dockerfile.backend` («slim» — последняя) сохранён: сборка без `--target` даёт ровно прежний control plane без toolchain'а.

#### Состав по тирам (`logical|apk|apt`)

Таблицы — **фактические**, из `docker/install-*.sh`; формат `logical|имя_пакета_apk|имя_пакета_apt`. Расхождение только в именах — сам список пакетов на тир один.

**Hard deps** (`docker/install-hard-deps.sh:48-56`):

| logical | apk | apt |
|---|---|---|
| `git` | `git` | `git` |
| `ripgrep` | `ripgrep` | `ripgrep` |
| `python3` | `python3` | `python3` |
| `pip` | `py3-pip` | `python3-pip` |
| `venv` | `python3` (ensurepip внутри `python3`) | `python3-venv` |
| `openssh-client` | `openssh-client` (виртуальное имя → `openssh-client-default`) | `openssh-client` |
| `ca-certificates` | `ca-certificates` | `ca-certificates` |

**Tier 0** (`docker/install-tier-0.sh:50-66`) — плюс `yq` **вне таблицы** (см. решения):

| logical | apk | apt |
|---|---|---|
| `bash` | `bash` | `bash` |
| `curl` | `curl` | `curl` |
| `jq` | `jq` | `jq` |
| `unzip` | `unzip` | `unzip` |
| `zip` | `zip` | `zip` |
| `xz` | `xz` | `xz-utils` |
| `zstd` | `zstd` | `zstd` |
| `coreutils` | `coreutils` | `coreutils` |
| `findutils` | `findutils` | `findutils` |
| `grep` | `grep` | `grep` |
| `sed` | `sed` | `sed` |
| `gawk` | `gawk` | `gawk` |
| `less` | `less` | `less` |
| `tree` | `tree` | `tree` |
| `openssl` | `openssl` | `openssl` |
| `yq` | `yq` (дистрибутивный = Go v4) | **вне таблицы**: Go-вариант из upstream (пин + sha256) |

**Tier 1 — сборка** (`docker/install-tier-1.sh:48-59`):

| logical | apk | apt |
|---|---|---|
| `make` | `make` | `make` |
| `gcc` | `gcc` | `gcc` |
| `g++` | `g++` | `g++` |
| `musl-dev` | `musl-dev` | `build-essential` (вместе с `libc6-dev`) |
| `python3-dev` | `python3-dev` | `python3-dev` |
| `pkgconf` | `pkgconf` | `pkg-config` (виртуальное имя на pkgconf) |
| `patch` | `patch` | `patch` |
| `diffutils` | `diffutils` | `diffutils` |
| `git-lfs` | `git-lfs` | `git-lfs` |
| `rsync` | `rsync` | `rsync` |

**Tier 2 — дистрибутивная часть** (`docker/install-tier-2.sh:50-55`) — имена в alpine и debian совпадают:

| logical | apk | apt |
|---|---|---|
| `ansible` | `ansible` | `ansible` |
| `ansible-lint` | `ansible-lint` | `ansible-lint` |
| `yamllint` | `yamllint` | `yamllint` |
| `shellcheck` | `shellcheck` | `shellcheck` |

**Tier 2 — upstream-релизы** (`docker/install-tier-2.sh:79-85`) — состав **не зависит от дистрибутива**: одна таблица на alpine- и debian-ветку (`kubectl` 1.37.1, `helm` 3.22.1, `kustomize` 5.8.3, OpenTofu 1.13.1 + симлинк `terraform`, `hadolint` 2.15.1; пин + sha256 — см. таблицу в разделе шага 4).

**Tier 3 — веб/браузер** (`docker/install-tier-3.sh:81-103`) — **только debian**:

| logical | apk | apt | примечание |
|---|---|---|---|
| `libxml2-utils` | — (ветка fail-closed) | `libxml2-utils` | бинарь `xmllint` |
| `playwright` | — | npm `1.64.0-alpha-1790635538000` | CLI + браузеры; печатается в образ |
| `playwright-mcp` | — | npm `0.0.83` | MCP-сервер Playwright (stdio) |

**Tier 4 — MCP-хостинги** (`docker/install-tier-4.sh:53-58`) — npm, пин + integrity: `mcp-server-github` 2025.4.8, `mcp-server-gitlab` 2025.4.25, `gitea-mcp` 2.0.0, `gitverse-mcp` 1.1.0 (таблица — в разделе шага 4).

**Клиенты БД** (`docker/install-db-clients.sh:47-52`):

| logical | apk | apt |
|---|---|---|
| `sqlite3` | `sqlite` | `sqlite3` |
| `psql` | `postgresql17-client` | `postgresql-client` |
| `redis-cli` | `redis` (клиент вместе с сервером; сервер не запускается) | `redis-tools` (без сервера) |
| `mysql-client` | `mysql-client` | `mariadb-client` (`mysql-client` в debian — виртуальное имя) |

**Диагностика** (`docker/install-diag.sh:39-45`):

| logical | apk | apt |
|---|---|---|
| `dig` | `bind-tools` | `dnsutils` |
| `netcat` | `netcat-openbsd` | `netcat-openbsd` |
| `traceroute` | `traceroute` | `traceroute` |
| `lsof` | `lsof` | `lsof` |
| `ss` | `iproute2` | `iproute2` |

**Buildah** (`docker/install-buildah.sh:88-96`) — тот же состав в обеих ветках, кроме пакетов subid:

| logical | apk | apt |
|---|---|---|
| `buildah` | `buildah` | `buildah` |
| `crun` | `crun` | `crun` |
| `netavark` | `netavark` | `netavark` |
| `aardvark-dns` | `aardvark-dns` | `aardvark-dns` |
| `fuse-overlayfs` | `fuse-overlayfs` | `fuse-overlayfs` |
| `slirp4netns` | `slirp4netns` | `slirp4netns` |
| `shadow-subids` | `shadow-subids` | `uidmap` (бинарни `newuidmap`/`newgidmap`) |

**Docker CLI** (`docker/install-docker-cli.sh:32-60`) — состав **различается принципиально**:

| logical | apk | apt |
|---|---|---|
| `docker` | `docker-cli` (дистрибутивный пакет, только клиент) | **вне таблицы**: статический бандл upstream (пин 29.9.2 + sha256), из архива берётся только `docker` |

#### Решения debian-ветки

**`yq` — Go-вариант и в debian.** Дистрибутивный apt-пакет `yq` — это python-реализация kislyuk/yq (синтаксис `yq r`), CLI **несовместим** с Go-вариантом mikefarah/yq, на который рассчитывают агентский код и пользовательские скрипты. Поэтому в debian ставится Go-вариант из upstream-релиза (пин `v4.54.1` + sha256, как `kubectl`/`helm` в tier 2), а не apt-пакет (`docker/install-tier-0.sh:70-102`). Проверено: `yq --version` → `yq (https://github.com/mikefarah/yq/) version v4.54.1`.

**docker CLI в debian — вариант (а): статический бандл.** Отдельного пакета `docker-cli` в apt нет, а `docker.io` тянет демон (`dockerd` + `containerd`) — а демон в образе недопустим («Две топологии развёртывания»: docker — только CLI, без сокета). Вариант (б) (apt-репозиторий docker с `docker-ce-cli`) требует добавления чужого GPG-ключа в образ — отклонён. Вариант (в) (не включать docker CLI в debian-ветку) отклонён: `full`/`devops` без docker CLI теряют сценарий работы с удалённым builder'ом.

Поэтому debian-ветка берёт статический бандл `download.docker.com/linux/static/stable/<arch>/docker-29.9.2.tgz`: это статический бинарь без зависимостей (`file` → «not a dynamic executable»), из архива берётся **только** `docker` — демон, `containerd`, `runc` и `containerd-shim` в образ не попадают.

**Оговорка по контрольной сумме.** Docker **не публикует** файл checksum'ов для статического бандла (в `download.docker.com/linux/static/stable/` лежат только `.tgz`), поэтому sha256 (`9ac22599…` x86_64 / `873b3e02…` aarch64) зафиксированы в репозитории по скачанному артефакту. Fail-closed при этом сохраняется: любое изменение бандла ломает сборку (`docker/install-docker-cli.sh:50-59`).

**Playwright: пины парой на одну alpha-сборку.** `@playwright/mcp` 0.0.83 жёстко зависит от конкретной alpha-сборки `playwright` — `1.64.0-alpha-1790635538000` (ревизия Chromium **1247**), тогда как стабильная `1.64.1` использует ревизию **1248**. Смешивать их нельзя: в образе было бы **два** набора Chromium (+~300 МБ), причём CLI и MCP-сервер смотрели бы в разные каталоги. Поэтому обе части пинятся на одну и ту же сборку — ровно ту, что использует официальный MCP-сервер (`docker/install-tier-3.sh:19-30`). Проверено: в образе ровно один набор — `chromium-1247` + `chromium_headless_shell-1247` (+ `ffmpeg-1011`).

**Браузеры печатся в образ** (решение закрывает вопрос «Playwright-браузеры» из раздела «Python-окружение и кэши»): `playwright install --with-deps chromium` выполняется на этапе сборки, каталог — общий `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` (не на `HOME`, чтобы был читаем при `runAsUser: 1000`). Только chromium: firefox/webkit стоили бы ещё ~200 МБ, а tier 3 — это UI-верификация, а не кросс-браузерное тестирование.

**`buildah` в debian — тот же состав.** Дистрибутивные пакеты debian (`buildah`, `crun`, `netavark`, `aardvark-dns`, `fuse-overlayfs`, `slirp4netns`) + `uidmap` вместо `shadow-subids` (бинарни `newuidmap`/`newgidmap` даёт `uidmap`; файлы `/etc/subuid`/`/etc/subgid` — из `passwd`). Диапазон `node:100000:65536` добавляется скриптом в обеих ветках. **Ограничения прежние** и от дистрибутива не зависят: работоспособность определяется правами рантайма (`CAP_SYS_ADMIN`/`CAP_SYS_RESOURCE`, `/dev/fuse`, `TMPDIR` не на overlayfs, writable `--root`/`--runroot` для rootless) — рецепты в разделе «Ограничения buildah в контейнере».

**OpenTofu в debian — то же решение, что в alpine.** Бинарь `tofu` (пин 1.13.1 + sha256) + симлинк `terraform` → `tofu`; HashiCorp Terraform (лицензия BUSL) в образ не кладём. Таблица upstream-релизов tier 2 общая для обеих веток, поэтому отдельного решения для debian не потребовалось.

**В worker-образе несётся `dist` core — уточнение к формулировке «без node-приложения».** Ранняя формулировка «образ worker'а — слои toolchain'а без node-приложения» для `synth-executor` оказалась неточной: `@itphx/synth-executor` объявляет `@itphx/synth-core` как **peerDependency** и импортирует его **в рантайме** (`InlineExecutionPort`, `ExecutionError`, `egressFetch`), поэтому в образ обязателен `dist` core.

Как это решено:

- `pnpm deploy` не поднимает peer-зависимость в верхний уровень `node_modules` — пакет доступен только по явному симлинку: `/app/node_modules/@itphx/synth-core` → `/opt/synth-core`, куда core разворачивается вторым `pnpm deploy` (`docker/Dockerfile.executor:114-130`);
- проверка в образе — **fail-closed**: `node -e "import('@itphx/synth-core')…"` обязан увидеть `InlineExecutionPort`, иначе сборка падает (а не падает в рантайме у пользователя);
- Node разыменовывает симлинку и резолвит зависимости core от её реального пути (`/opt/synth-core/node_modules`) — рантайм самодостаточен.

Итог: worker-образ — **не** «toolchain без node-приложения», а «toolchain + рантайм исполнителя + `dist` core» (≈42 МБ). Развязка на будущее — перенос порта исполнения в `@itphx/synth-shared` (тогда worker-образу достаточно рантайма исполнителя без core); это отдельная задача, здесь не делается.

#### Замеры размеров

Content (`docker image inspect <tag> --format '{{.Size}}'`), amd64, node 22.23.3; alpine 3.24.2 / bookworm (glibc 2.36):

| Образ | Байт | Размер |
|---|---|---|
| `synth-backend:slim` | 67 081 448 | **64,0 МБ** |
| `synth-backend:core` | 106 560 061 | **101,6 МБ** |
| `synth-backend:dev` | 335 658 597 | **320,1 МБ** |
| `synth-backend:devops` | 533 191 150 | **508,5 МБ** |
| `synth-backend:browser` | 707 654 233 | **674,9 МБ** |
| `synth-backend:full` | 970 503 811 | **925,5 МБ** |
| `synth-executor:core` | 112 232 756 | **107,0 МБ** |
| `synth-executor:full` | 975 967 509 | **930,8 МБ** |

Оценки для `browser`/`full` (1,8 ГБ / 2,5–3 ГБ) оказались **завышены**: debian-ветка легче alpine-ветки по базе (`bookworm-slim` против `alpine`), а Chromium (~300 МБ) — единственный крупный добавок. При этом `full` тяжелее `devops` всего в ~1,8 раза, а не в 5–6 раз, как предполагалось.

Сборки `synth-executor:dev`/`dev`/`devops` для замеров не собирались (в шаге 5 собирались `core` и `full`); их размеры оцениваются по разнице `executor:core` (107,0 МБ) − `backend:core` (101,6 МБ) ≈ 5,4 МБ — то есть worker-образ примерно на 5 МБ больше соответствующего all-in-one за счёт рантайма исполнителя + `dist` core.

#### Что проверено сборками и smoke-тестами

| Проверка | Результат |
|---|---|
| Сборка `browser` | EXIT=0 (`--target browser`, debian-ветка); повтор из-за сетевой флаки песочницы (502/503 от `registry.npmjs.org`) — 2 попытки |
| Сборка `full` | EXIT=0 (`--target full`); 1 попытка |
| Сборка `synth-executor:full` | EXIT=0 (`docker/Dockerfile.executor --target full`); 1 попытка |
| `browser`: playwright | `playwright --version` → `Version 1.64.0-alpha-1790635538000`; `playwright-mcp --help` отвечает |
| `browser`: Chromium | headless-рендер через `playwright` — Chromium **155.0.8059.12**, `setContent('<h1>ok</h1>')` → «ok»; каталог `/opt/ms-playwright`: `chromium-1247`, `chromium_headless_shell-1247`, `ffmpeg-1011` (одна ревизия, дублей нет) |
| `browser`: tier 3 | `xmllint --version` → `libxml version 20914` |
| `browser`: hard deps / tier 0 | `git` 2.39.5, `ripgrep` 13.0.0, `python3` 3.11.2, `ssh` OpenSSH 9.2p1, `yq` v4.54.1 (Go), `jq` 1.6, `bash` 5.2.15 |
| `browser`: control plane | `node dist/main.js` → `GET /health` = 200 (`{"status":"healthy","version":"0.11.4",…}`) |
| `full`: tier 2 | `kubectl` v1.37.1, `helm` v3.22.1, `kustomize` v5.8.3, `tofu` OpenTofu v1.13.1 (+ симлинк `terraform` → «OpenTofu v1.13.1»), `ansible` 2.14.18, `ansible-lint` 6.13.1, `yamllint` 1.29.0, `shellcheck`, `hadolint` 2.15.1 |
| `full`: docker CLI | `docker --version` → 29.9.2; бинарь **статический** («not a dynamic executable»); `docker info` падает («failed to connect to the docker API at unix:///var/run/docker.sock») — демона нет, ожидаемо; `dockerd`/`containerd`/`docker.sock` в образе отсутствуют |
| `full`: buildah | `buildah --version` → 1.28.2 (image-spec 1.1.0-rc2) |
| `full`: клиенты БД | `sqlite3` 3.40.1, `psql` 15.19, `redis-cli` 7.0.15, `mysql`/`mariadb` 10.11.19 — работают |
| `full`: диаг | `dig` 9.18.49, `nc` (OpenBSD) 1.219, `lsof`, `ss` (iproute2 6.1.0), `traceroute` 2.1.2 |
| `full`: tier 4 | все четыре MCP-сервера (`mcp-server-github`, `mcp-server-gitlab`, `gitea-mcp`, `gitverse-mcp`) в `/usr/local/bin`, у всех четверых реальный handshake `initialize` по stdio |
| `full`: Chromium | headless-рендер — Chromium 155.0.8059.12, «ok» |
| `full`: control plane | `node dist/main.js` → `GET /health` = 200 |
| `synth-executor:full`: toolchain | полный набор `browser`+`full` (tier 0–4, БД, diag, buildah, docker CLI, Playwright + Chromium) — все команды на месте и отвечают |
| `synth-executor:full`: рантайм | `GET /health` → 200 (`{"status":"ok","protocol":1,…}`); `GET /capabilities` без токена → **401**, с токеном → **200** `{protocol:1, toolchain:{git, rg, python3}, os:"linux", arch:"x64", node:"v22.23.3"}`; `POST /exec` без токена → **401**; `cwd` вне workspace → **400** `cwd_outside_workspace` (`EWORKSPACE`); `cwd=/workspace` → **200** `{stdout:"hi\n", exitCode:0}` |
| `synth-executor:full`: core в образе | симлинк `/app/node_modules/@itphx/synth-core` → `/opt/synth-core`; `InlineExecutionPort`/`ExecutionError`/`egressFetch` импортируются в рантайме (fail-closed-проверка на этапе сборки) |
| `synth-executor:full`: секреты | секретов нет (`env` без `SYNTH_*KEY/TOKEN/SECRET/PASSWORD`), `/var/synth` нет, `config.yaml`/`credentials.json`/каталога секретов нет |
| Регрессия `slim` | манифест из 9224 записей совпал с эталоном `synth-backend:slim-baseline`; различаются только `/app/node_modules/.modules.yaml` (метка времени `prunedAt` у pnpm) и `/etc/hostname`/`/etc/hosts` (их выдаёт рантайм контейнера) |

### Образы worker'ов (`synth-executor:<v>-<flavor>`)

Worker'у **не нужны** control plane (OIDC/RBAC, LLM-конфигурация), UI-ассеты и ключи — но нужны сами рантаймы toolchain'а и рантайм исполнителя. Поэтому worker-образы строятся на тех же toolchain-слоях, но без приложения control plane.

| Flavor | База | Что берём из all-in-one | Что убираем | Размер |
|---|---|---|---|---|
| **core** | alpine | hard deps + tier 0 | control plane, UI, OIDC/LLM-конфигурация | **107,0 МБ** (измерен) |
| **dev** | alpine | core + tier 1 + tier 4 + БД + buildah | то же | ~315 МБ (оценка) |
| **devops** | alpine | dev + tier 2 + diag + docker CLI + buildah | то же | ~503 МБ (оценка) |
| **browser** | debian | hard deps + tier 0 + tier 1 + tier 3 + playwright-MCP + diag | то же | ~680 МБ (оценка) |
| **full** | debian | полный состав | то же | **930,8 МБ** (измерен) |

Образы `synth-executor:core` и `synth-executor:full` **собраны** (шаг 5) — см. замеры и smoke-тесты в разделе «Реализация шага 5». Оценки для `dev`/`devops`/`browser` получены по разнице `executor:core` (107,0 МБ) − `backend:core` (101,6 МБ) ≈ 5,4 МБ — worker-образ примерно на 5 МБ больше соответствующего all-in-one за счёт рантайма исполнителя и `dist` core.

Worker-образ `slim` **не имеет смысла**: без toolchain'а в нём нет ничего, кроме рантайма исполнителя, — worker всегда «с инструментами».

**Базы:** `slim`/`core`/`dev`/`devops` — alpine; `browser`/`full` — Debian (`node:22-bookworm-slim`), т.к. Playwright не поддерживает musl/glibc-несовместимость.

**Теги, а не репозитории:** один репозиторий на образ, flavor — суффикс тега. В чарте — `backend.image.flavor` (по умолчанию `slim`) плюс отдельный `executor.image.repository` для worker'а.

## Multistage-сборка

Flavor'ы строятся **кумулятивно** (`FROM ... AS`), т.к. `COPY --from` не переносит установленные пакеты корректно (метаданные apk/apt, `.so`, пути). Дублирование списков между alpine и debian недопустимо — установка тиров выносится в **distro-aware скрипты** (`install-tier-N.sh`, выбирают `apk`/`apt`).

```
реализовано (alpine, docker/Dockerfile.backend):
  build ─► core(hard deps + tier 0) ─► dev(core + tier 1 + БД + buildah + tier 4)
                                        └─► devops(dev + tier 2 + diag + docker CLI)
  slim (node:22-alpine, без toolchain'а) — ПОСЛЕДНЯЯ стадия, цель по умолчанию

реализовано (debian-ветка, шаг 5, docker/Dockerfile.backend):
  build ─► browser(hard deps + tier 0 + tier 1 + tier 3 + playwright-MCP + diag)
            └─► full(browser + tier 2 + tier 4 + БД + diag + docker + buildah)

реализовано (worker, шаг 5, docker/Dockerfile.executor):
  build ─► core ─► dev ─► devops            (alpine)
            └─► browser ─► full             (debian)
  рантайм исполнителя + `dist` core (peer-dep) — в каждой стадии
```

**Ограничение из текущих Dockerfile'ов, которое прямо влияет на flavor'ы.** Сегодня в runtime-стадии **нет ни одного `RUN`** — всё, что требует исполнения кода, делается в builder-стадии; именно это позволяет собирать arm64-образ на amd64-раннере без QEMU/binfmt (`docker/Dockerfile:21-24`, `docker/Dockerfile.backend:5-8`). Для flavor'ов это правило не всегда выполнимо: `kubectl`/`helm`/`terraform`/`playwright` — **архитектурно-зависимые** бинарники, их нельзя ставить в builder-стадию `$BUILDPLATFORM` и переносить `COPY --from` в целевую стадию.

Отсюда два допустимых пути:

- **per-arch сборка** flavor'ов (buildx/kaniko под целевую платформу, QEMU/binfmt обязателен) — тогда в целевой стадии `RUN` разрешён;
- **отказ от «no RUN» для flavor'ов** и сборка arm64 только под arm64 — тогда образы `browser`/`full`/`devops` не появятся в multi-arch.

### Реализация шагов 2, 4 и 5: стадии `docker/Dockerfile.backend` и `docker/Dockerfile.executor`

`docker/Dockerfile.backend` (all-in-one):

```text
build  (--platform=$BUILDPLATFORM)  — сборка монорепо, pnpm deploy, chmod
core   (целевая платформа, с RUN)  — all-in-one: control plane + toolchain
dev    (целевая платформа, с RUN)  — core + tier 1 + БД + buildah + tier 4   (шаг 4)
devops (целевая платформа, с RUN)  — dev + tier 2 + diag + docker CLI        (шаг 4)
browser (целевая платформа, с RUN) — hard deps + tier 0 + tier 1 + tier 3 +
                                      playwright-MCP + diag                   (шаг 5)
full   (целевая платформа, с RUN)  — browser + tier 2 + tier 4 + БД +
                                      docker CLI + buildah                    (шаг 5)
slim   (целевая платформа, без RUN) — control plane без toolchain'а; ПОСЛЕДНЯЯ
                                       стадия ⇒ сборка без --target даёт ровно
                                       прежний slim-образ
```

`docker/Dockerfile.executor` (worker) — те же flavor'ы, но без control plane: стадии `core`/`dev`/`devops` (alpine) и `browser`/`full` (debian); в каждой стадии — рантайм исполнителя (`/app`) и `dist` core (`/opt/synth-core`, peer-dep) с fail-closed-проверкой импорта.

`--target core` — all-in-one образ; `--target dev`/`--target devops` — расширенные all-in-one (шаг 4, раздел «Реализация шага 4»); `--target browser`/`--target full` — debian-ветка (шаг 5, раздел «Реализация шага 5»); `--target slim` — control plane. Стадия `core` копирует приложение из `build` (JS/архитектурно-независимо) и добавляет слои toolchain'а.

**Решение по arm64 — вариант A: per-arch сборка flavor'ов.** Flavor-стадия содержит `RUN` (установка пакетов) и потому собирается под целевую архитектуру; arm64-сборка flavor'а требует QEMU/binfmt на раннере. Обоснование:

1. `core` — основной публикуемый flavor; отказ от arm64 (вариант B) оставил бы arm64-пользователей без all-in-one — это функциональный пробел (невозможен inline-режим с toolchain'ом), а не только публикационная особенность;
2. все пакеты `core` есть в alpine-репозиториях для обеих архитектур — цена эмуляции ограничена одним слоем `apk add` (+1–3 мин на QEMU);
3. путь `slim` не меняется: в нём по-прежнему нет ни одного `RUN`, поэтому multi-arch slim продолжает собираться на amd64-раннере без QEMU — релиз slim не регрессирует, эмуляция нужна только flavor'ам;
4. требование к CI остаётся явным: регистрация QEMU/binfmt на раннере (или нативный arm64-раннер) — фактически в шаге 6 flavor'ы публикуются **amd64-only** (kaniko без эмуляции, `--platform` не задаётся — см. «Реестры и публикация»), поэтому multi-arch для flavor'ов остаётся отдельной задачей; релиз при этом не ломается.

Техническая деталь: явный `--platform=${TARGETPLATFORM}` в flavor-стадии **недопустим** — kaniko автоматические ARG-платформы не задаёт (проверено на kaniko v1.24.0: `BUILDPLATFORM` и `TARGETPLATFORM` пустые), а kaniko — amd64-билдер в CI. Стадия `core` оставлена **без явного `--platform`**: под buildx она собирается под `$TARGETPLATFORM`, под kaniko — под его собственный arch. Синтаксис `${BUILDPLATFORM:-linux/amd64}` в стадии `build` сохранён (дефолт для kaniko/legacy `docker build`). Поэтому и в flavor-шагах публикации `--platform` **не задаётся вовсе** — образ выходит под архитектуру раннера (amd64).

Для **базовых** образов (`synth`/`synth-backend`/`synth-ui` → `gitverse.ru`/`ghcr.io`) amd64 собирает kaniko, arm64 — buildx, затем best-effort manifest-list перезаписывает тег (`.gitverse/workflows/release.yaml:487-502`, `.gitverse/workflows/release.yaml:507-515`). Flavor'ы в Gitea публикуются amd64-only, без manifest-list.

## Реестры и публикация

**Политика (решение владельца):** **все** flavor-образы обоих образов публикуются в **приватный реестр Gitea** `git.itphx.ru/itphx/…`. В `gitverse.ru`/`ghcr.io` уходят только **базовые** образы (`synth`, `synth-backend`, `synth-ui`) — как и раньше.

| Образ | Тег в Gitea | Состав |
|---|---|---|
| `synth-backend` | `:<v>` | slim: control plane без toolchain'а |
| `synth-backend` | `:<v>-core` … `:<v>-full` | all-in-one: control plane + toolchain'а |
| `synth-executor` | `:<v>-core` … `:<v>-full` | образы исполнителей (worker'ы) |

Полные адреса: `git.itphx.ru/itphx/synth-backend:<v>-core`, `git.itphx.ru/itphx/synth-executor:<v>-full`.

**Почему именно Gitea, а не Docker Hub:**

- **лимит ~500 МБ на репозиторий** в `gitverse.ru` и `ghcr.io` — реальное ограничение: на 0.9.0 вышло 607,4 МБ из 500, поэтому туда попадают только лёгкие образы (`.gitverse/workflows/release.yaml:356-360`, `docs/PUBLISHING.md:53`);
- **Gitea этого лимита не имеет** — туда проходят и тяжёлые образы (`full` — 925,5 МБ, `browser` — 674,9 МБ);
- **Gitea уже используется** для тестового контура (`git.itphx.ru/itphx/synth-backend`, `synth-ui`), и pull-secret `git.itphx.ru` в namespace `synth` уже существует — новый реестр и новый секрет в кластере не нужны;
- **решение владельца**: публикуем **все** flavor'ы в Gitea — иначе тяжёлые образы нечем проверить в K3s (в `gitverse.ru`/`ghcr.io` они просто не помещаются).

**Теги — только версионные, без `latest`.** Pull в K3s идёт по конкретной версии (`<v>-<flavor>`), поэтому развёртывание остаётся воспроизводимым; `latest` не публикуется (политика тегов общая для всех реестров).

**Секрет** — `GV_GITEA_TOKEN` (логин `itphx`); локально и в `synth-deploy` — `GITEA_TOKEN`/`GITEA_USER`. Без токена публикация **fail-closed** с понятным сообщением, а не молчаливый пропуск: `scripts/docker-auth-gitea.sh:24-28`, `scripts/publish-images.sh:192-194`.

**Публикация — по тегу релиза.** Джоба `publish-images-gitea` в `.gitverse/workflows/release.yaml` (`.gitverse/workflows/release.yaml:543-760`) собирает каждый flavor отдельным шагом kaniko с `--target` и `--destination=git.itphx.ru/itphx/<образ>:<v>-<flavor>`. В `ci.yaml` (push/PR) публикации нет — там только сборка и smoke-тесты (джоба `images`, `.gitverse/workflows/ci.yaml:305-326`).

**Push — последовательный, с ретраями** (`scripts/publish-images.sh:223-245`): DNS `git.itphx.ru` на nameserver `10.0.0.245` сбрасывает **параллельные** DNS-запросы (`Temporary failure in name resolution`), а последовательные ходит стабильно. Поэтому параллельный пуш слоёв не используется, между попытками — пауза с backoff (`SYNTH_IMAGE_PUSH_RETRIES`, `SYNTH_IMAGE_PUSH_RETRY_DELAY`).

**Явный `--platform` в flavor-шагах не задаётся** — kaniko не выставляет `BUILDPLATFORM`/`TARGETPLATFORM` (проверено на v1.24.0), пустое значение уронило бы сборку (см. «Multstage-сборка»). Flavor'ы публикуются для архитектуры раннера (amd64), без manifest-list.

**Registry-кэш включён** (`--cache=true --cache-repo=git.itphx.ru/itphx/synth-buildcache`): без него одиннадцать сборок повторяли бы тяжёлую стадию `build` (сборка монорепо). Если кэш недоступен, сборка всё равно проходит — просто медленнее.

**Smoke-тесты образов — есть.** `scripts/smoke-image.sh` запускает контейнер и проверяет состав **по flavor'у** (не только «бинарник существует»): версии печатаются, `venv` создаётся, MCP-сервер отвечает по stdio, Chromium реально стартует headless; для `slim` — негативная проверка (бинарников toolchain'а быть не должно). В CI их гоняет `scripts/ci-images.sh` (джоба `images` — `.gitverse/workflows/ci.yaml:324-326`; без docker-демона — best-effort: kaniko `--no-push` проверяет, что flavor-стадии собираются). Для базовых образов проверка запуска осталась в джобе `offline-images` (список образов с health-путями — `scripts/offline-images.sh:63-66`, запуск контейнера — `scripts/offline-images.sh:275`).

**Очистка старых тегов** — `node scripts/docker-cleanup.mjs <images>` перед публикацией базовых образов (`.gitverse/workflows/release.yaml:418-421`); для репозиториев Gitea шаг надо расширить (квоты там нет, но мусор копится).

**Порядок сборки**: `build-docker` идёт **после** публикации npm-пакетов — образ `synth` ставит `@itphx/synth@<version>` из npmjs, иначе гонка `ETARGET` (`.gitverse/workflows/release.yaml:361-362`); для `synth-backend`/`synth-executor`, собираемых из исходников, эта зависимость снимается, но единый порядок сохраняем.

**`imagePullSecrets`** — в чарте значения есть (`charts/synth/values.yaml:31`, `charts/synth/values.yaml:236`, `charts/synth/templates/backend-deployment.yaml:54-55`, `charts/synth/templates/executor-deployment.yaml:30-31`), но по умолчанию пусты: публичные образы тянутся анонимно, а для приватного Gitea-реестра пользователь задаёт `backend.imagePullSecrets`/`executor.imagePullSecrets` сам (pull-secret `git.itphx.ru` в namespace `synth` уже существует). В чарте worker'а образ уже указывает на Gitea (`charts/synth/values.yaml:230`), у backend'а — пока базовый образ из `gitverse.ru` (`charts/synth/values.yaml:24`).

## Python-окружение и кэши

`HOME`, `PYTHONUSERBASE`, `PIP_CACHE_DIR` — на persistent-volume, иначе `pip install --user` эфемерен. Аналогично кэши: npm/pnpm, ansible-galaxy, helm-repos, `~/.config`.

- **All-in-one** — те же volume'а, что и у инстанса (PVC `data` → `/var/synth/data`, `charts/synth/templates/backend-deployment.yaml:133-135`); при `runAsUser: 1000` (`charts/synth/values.yaml:115`) `HOME` по умолчанию `/root` недоступен для записи — поэтому `HOME` надо задать на volume явно (`packages/core/src/engine/tools/shell.ts:52` подставляет `process.env.HOME` со fallback'ом `/root`).
- **Worker** — **отдельный** volume под кэши: в split-топологии worker'ы не делят `data` инстанса (там только workspace), и общий кэш `pip`/`npm` между репликами worker'ов даёт конкуренцию — либо per-worker том, либо отдельный read-mostly cache-PVC.
- **Playwright-браузеры** — **печатаются в образ** (`playwright install --with-deps chromium` на этапе сборки, каталог `/opt/ms-playwright`, общий для всех пользователей образа); в рантайме ничего не скачивается. Реализовано в шаге 5 (`docker/install-tier-3.sh:120-138`).

## MCP-серверы

MCP остаётся **конфигурацией реестра** (ADR-071); flavor'ы несут только рантаймы/бинари (tier 3–4). Бинари MCP-серверов **пекутся в образ** (pin + checksum; supply-chain — референс PROP-068), а не устанавливаются в рантайме. Токены хостингов — из секрет-стора Synth (по образцу ADR-076), инъекция при спавне, обфускация guard'ом (ADR-036), **не в образ**.

Следствие для worker'а: MCP stdio-клиент сейчас спавнится в процессе control plane (`packages/core/src/engine/mcp/client.ts:169-170`), поэтому в split-топологии stdio-серверы либо остаются у control plane, либо переезжают в worker вместе с командой — это решается в [PROP-077](./prop-077-runtime-toolchain.md).

## Локальный containerized: docker-compose

**Сейчас** compose поднимает только standalone-образ `synth` (`docker-compose.yml:21-24`), ключ API обязателен из `.env` (`docker-compose.yml:32`), режим рестарта — `process` (`docker-compose.yml:36`), отдельно доступны профили `ollama` и `postgres` (`docker-compose.yml:91-106`, `docker-compose.yml:114-138`), тома — `synth-data`/`ollama-data`/`postgres-data` (`docker-compose.yml:140-143`). Backend и UI в compose **не разведены** — только standalone-образ.

**Предлагается** (один файл compose, два профиля):

- **all-in-one** — `synth-backend` (all-in-one flavor) + `synth-ui` + `postgres` + общий volume workspace; `SYNTH_EXECUTION_MODE` не задаётся (дефолт `inline`), либо задаётся явно `inline` для ясности;
- **split** — `synth-backend` (slim, без toolchain) + `synth-executor` (worker-образ flavor'а) + `synth-ui` + `postgres`; backend получает `SYNTH_EXECUTION_MODE=remote` и `SYNTH_EXECUTION_REMOTE_URL=http://synth-executor:…`, токен — из `.env`/Secret.

Общее для обоих: `SYNTH_API_KEY` обязателен из `.env` (как сейчас — `docker-compose.yml:32`); workspace — общий volume (в split — именно то, что в Kubernetes потребует RWX-PVC).

## Managed single-instance и переход к split

Managed-деплой сегодня — **одна** реплика backend'а, потому что JSON-хранилище не масштабируется (`charts/synth/values.yaml:16`), с PVC `data` (`charts/synth/values.yaml:39-50`), probes `GET /health` (`charts/synth/values.yaml:103-110`), `runAsUser: 1000` / `allowPrivilegeEscalation: false` (`charts/synth/values.yaml:112-118`). В чарте **нет** `Role`/`RoleBinding` и **нет** `NetworkPolicy` (каталог шаблонов: `charts/synth/templates/` — `serviceaccount.yaml`, `backend-deployment.yaml`, `backend-pvc.yaml`, …; произвольные объекты добавляются через `extraObjects: []` — `charts/synth/values.yaml:427`).

**Переход single-instance → split** (split-топология технически возможна и при одной реплике control plane — пул worker'ов масштабируется независимо; PostgreSQL обязателен для масштабирования самого control plane, т.е. >1 реплики — ADR-096/PROP-032):

1. `execution.mode: remote` в config.yaml (или `SYNTH_EXECUTION_MODE=remote`) + перезапуск;
2. отдельный Deployment `synth-executor` (`executor.replicaCount`, `executor.image.*`, `executor.resources`);
3. **общий том workspace**: backend и worker монтируют один и тот же claim — это требует RWX-класса, которого в чарте сейчас нет (`charts/synth/values.yaml:45` — `accessMode: ReadWriteOnce`);
4. `executor.podSecurityContext`/`executor.containerSecurityContext` (seccomp/capabilities, `runAsNonRoot`), `executor.networkPolicy` с ограниченным egress, `executor.workspace.{claimName,mountPath}`;
5. токен доверия — `synth_exec_…` из Secret (`execution.remote.existingSecret`/`tokenKey`), TLS — через общий транспорт `egressFetch` и секцию `security.tls` (ADR-099: `packages/core/src/security/tls.ts:302`, `charts/synth/values.yaml:195-209`).

**Что остаётся в control plane в split-топологии:** FS-роуты (`packages/core/src/server/routes/fs.ts`), provisioning workspace (`packages/core/src/engine/workspace-provision.ts`), git-реестр и SSH-ключи (ADR-076: `packages/core/src/storage/ssh-key-store.ts`), хранение и слой портов (`packages/core/src/storage/ports/index.ts`, контрактный suite — `packages/core/src/storage/contract/index.ts`), RBAC/OIDC и LLM Gateway.

**Изоляция и квоты worker'а:** CPU/memory limits, timeout команды, idle-timeout, max-lifetime, лимит одновременных команд, seccomp/capabilities, **без** `docker.sock`, NetworkPolicy с ограниченным egress.

**Наблюдаемость** — по контракту ADR-094 (имена `synth_*`, реестр — `packages/core/src/metrics/registry.ts:19`, `packages/core/src/metrics/registry.ts:27`, коллекторы — `packages/core/src/metrics/collectors/index.ts`): `synth_executor_queue_depth`, `synth_executor_workers_busy`, `synth_executor_wait_seconds`, `synth_executor_commands_total{outcome}`. Существующая `synth_queue_pending` — это очередь **сообщений**, а не исполнения (`packages/core/src/metrics/collectors/sessions.ts:30`).

## Что уже есть

| Факт | Где |
|---|---|
| Образы на `node:22-alpine`, **ни одного `apk add`**; нет `git`/`rg`/`python`/`ssh` | `docker/Dockerfile`, `docker/Dockerfile.backend`, `docker/Dockerfile.ui` |
| В runtime-стадии **нет `RUN`** — arm64 собирается без QEMU/binfmt | `docker/Dockerfile:21-24`, `docker/Dockerfile.backend:5-8` |
| Standalone-образ `synth`: `ENTRYPOINT synth serve --port 4300`, `VOLUME /var/synth/data`, USER не задан (процесс от root), healthcheck'а нет | `docker/Dockerfile:91-95` |
| `synth-backend`: сборка из исходников монорепо, `pnpm deploy --prod --legacy`, права чинятся в builder; нет `EXPOSE`/`VOLUME`/`HEALTHCHECK`/`USER` | `docker/Dockerfile.backend:18`, `docker/Dockerfile.backend:38`, `docker/Dockerfile.backend:46`, `docker/Dockerfile.backend:48-69` |
| `synth-ui` — nginx:alpine, nginx от root, probes нет | `docker/Dockerfile.ui:25-43`, `charts/synth/values.yaml:344-350` |
| Слой `npm install -g` ≈280 МБ → GitVerse registry отклонял blob с **413 Request Entity Too Large** | `docker/Dockerfile:14` |
| CI (базовые образы): kaniko, **три отдельных шага** (по Dockerfile на образ), `--push-retry=3`, registry-cache не включён, smoke-тестов нет | `.gitverse/workflows/release.yaml:372`, `.gitverse/workflows/release.yaml:431-474` |
| CI (базовые образы): amd64 — kaniko, arm64 — buildx, затем manifest-list (best-effort); таймаут 75 мин | `.gitverse/workflows/release.yaml:377`, `.gitverse/workflows/release.yaml:487-515` |
| Базовые образы публикуются в `gitverse.ru`/`ghcr.io` **только версионными тегами**; лимит ~500 МБ (на 0.9.0 — 607,4 МБ из 500) — только к этим реестрам | `.gitverse/workflows/release.yaml:356-360`, `docs/PUBLISHING.md:53` |
| **Политика реестров (факт):** **все** flavor'ы (`slim`/`core`/`dev`/`devops`/`browser`/`full` у `synth-backend` и `synth-executor`) публикуются в **приватный Gitea** `git.itphx.ru/itphx/…` версионными тегами; в `gitverse.ru`/`ghcr.io` — только базовые образы. Docker Hub не используется | `.gitverse/workflows/release.yaml:423-430`, `.gitverse/workflows/release.yaml:517-543`, `scripts/publish-images.sh:1-45` |
| Публикация flavor'ов: джоба `publish-images-gitea` (по тегу релиза), секрет `GV_GITEA_TOKEN` (логин `itphx`, fail-closed без токена), kaniko с registry-кэшем `git.itphx.ru/itphx/synth-buildcache`, `--platform` не задаётся | `.gitverse/workflows/release.yaml:543-760`, `scripts/docker-auth-gitea.sh:24-40` |
| Локальная публикация: `scripts/publish-images.sh` — сборка всех flavor'ов, **последовательный** push с ретраями (DNS `git.itphx.ru` сбрасывает параллельные запросы), сводка (образ/тег/размер/digest) | `scripts/publish-images.sh:223-245`, `scripts/publish-images.sh:271-308` |
| Smoke-тесты flavor'ов: `scripts/smoke-image.sh` (проверки по flavor'у, для `slim` — негативные) + `scripts/ci-images.sh`; в CI — джоба `images` в `ci.yaml` (сборка + smoke, **публикации нет**) | `scripts/smoke-image.sh:1-27`, `scripts/ci-images.sh:1-22`, `.gitverse/workflows/ci.yaml:291-326` |
| Helm: backend — 1 реплика (JSON-хранилище не масштабируется), PVC `data` → `/var/synth/data`, `runAsUser 1000`, probes `GET /health` | `charts/synth/values.yaml:16`, `charts/synth/values.yaml:39-50`, `charts/synth/values.yaml:103-118` |
| В чарте **нет** `Role`/`RoleBinding` и **нет** `NetworkPolicy`; RWX-claim'а нет (`accessMode: ReadWriteOnce`) | `charts/synth/templates/`, `charts/synth/values.yaml:45`, `charts/synth/values.yaml:427` |
| `imagePullSecrets` в чарте есть, но пуст (публичные образы тянутся анонимно); для приватного Gitea-реестра — `backend.imagePullSecrets`/`executor.imagePullSecrets` | `charts/synth/values.yaml:31`, `charts/synth/values.yaml:236`, `charts/synth/templates/backend-deployment.yaml:54-55`, `charts/synth/templates/executor-deployment.yaml:30-31` |
| Всё исполнение — **в процессе backend/core**: `sh -c`, `execFile('git')`, `execFile('rg')`, `simple-git`, MCP stdio `spawn` | `packages/core/src/engine/tools/shell.ts:45`, `packages/core/src/engine/tools/git.ts:30`, `packages/core/src/engine/tools/search.ts:49`, `packages/core/src/git/git-service.ts:132`, `packages/core/src/engine/mcp/client.ts:169` |
| `execute_shell` наследует весь `process.env`, `HOME` по умолчанию `/root` (при `runAsUser: 1000` — не writable); таймаут 30 с (макс 120 с), `maxBuffer` 10 МБ, обрезка 100 КБ | `packages/core/src/engine/tools/shell.ts:13-14`, `packages/core/src/engine/tools/shell.ts:22`, `packages/core/src/engine/tools/shell.ts:51-52`, `packages/core/src/engine/tools/shell.ts:59-60` |
| Ещё один `sh -c` — inline-команды (`!`cmd``) | `packages/core/src/engine/commands/inline-shell.ts:39` |
| Детект внешних бинарников (`git`/`rg`/`sh`), fail-open, кэш модуля; `unavailable(dependency)` | `packages/core/src/engine/tools/runtime-deps.ts:19`, `packages/core/src/engine/tools/runtime-deps.ts:77-99`, `packages/core/src/engine/permission/availability.ts:22` |
| MCP — клиент + реестр (system/project/session), stdio и Streamable HTTP | `packages/core/src/engine/mcp/{client,manager,scope}.ts` (ADR-071) |
| Локально: `docker-compose.yml` поднимает только standalone-образ `synth`; `SYNTH_API_KEY` обязателен из `.env`; профили `ollama`/`postgres` | `docker-compose.yml:21-32`, `docker-compose.yml:91-138` |
| Dev-режим — порты 5000/4300/5002, `SYNTH_AUTH_DEBUG=true`, `SYNTH_CONFIG=packages/backend/config.yaml`; standalone — порт 4400, host 127.0.0.1, авто-ключ в `<home>/data/secrets/api-key` | `scripts/dev.sh:36`, `scripts/dev.sh:39`, `scripts/dev.sh:46`, `scripts/dev.sh:50-59`, `scripts/standalone.sh:22`, `scripts/standalone.sh:74-75` |
| `storage.backend` — `file`/`memory`/`postgres`, env `SYNTH_STORAGE_BACKEND`, **fail-closed** на неизвестном явном значении | `packages/shared/src/config/resolve.ts:283-306`, `packages/shared/src/config/resolve.ts:309-311` |
| Рестарт инстанса — graceful, **exit code 75**; режимы `disabled`/`process`/`supervisor` | `packages/core/src/server/restart.ts:23`, `packages/core/src/server/restart.ts:176-191`, `charts/synth/values.yaml:21` |
| Наблюдаемость: `/metrics` (off by default, вне `/api/v2`), `/ready`, реестр и доменные коллекторы | `packages/core/src/server/routes/metrics.ts`, `packages/core/src/server/routes/health.ts`, `packages/core/src/metrics/registry.ts:19`, `packages/core/src/metrics/collectors/index.ts` |
| Единый egress-транспорт `egressFetch` + секция `security.tls` в чарте | `packages/core/src/security/tls.ts:302`, `charts/synth/values.yaml:195-209` |
| Порт исполнения `ExecutionPort` + `InlineExecutionPort` + контрактный suite (шаг 1); секция `execution` в конфиге, env `SYNTH_EXECUTION_*`, CLI `--execution-mode` (шаг 3) — **реализованы** | `packages/core/src/execution/`, `packages/shared/src/config/execution.ts:1`, `packages/core/src/execution/startup.ts:1` |
| Flavor'ы `core`/`dev`/`devops` (alpine) — стадии `core`/`dev`/`devops` в `docker/Dockerfile.backend`, tier-скрипты в `docker/install-*.sh`; измерены 101,6 / 320,1 / 508,5 МБ (шаги 2 и 4) — **реализованы** | `docker/Dockerfile.backend:81-193`, `docker/install-lib.sh:42-236`, `docker/install-tier-1.sh:48-61`, `docker/install-tier-2.sh:50-94`, `docker/install-tier-4.sh:53-73`, `docker/install-db-clients.sh:47-54`, `docker/install-diag.sh:39-47`, `docker/install-buildah.sh:88-113`, `docker/install-docker-cli.sh:24-40` |
| `RemoteExecutionPort` (control plane → исполнитель), пакет `@itphx/synth-executor` и образы `synth-executor` — **реализованы** (PROP-077, шаг 7a + PROP-082, шаг 5); метрики `synth_executor_*` и развёртывание split-топологии в чарте — шаг 10 и далее | `packages/core/src/execution/remote.ts`, `packages/executor/`, `docker/Dockerfile.executor` |
| Flavor'ы `browser`/`full` (debian-ветка) + образы исполнителей — стадии `browser`/`full` в `docker/Dockerfile.backend` и `docker/Dockerfile.executor`; измерены 674,9 / 925,5 МБ (backend) и 107,0 / 930,8 МБ (executor) — **реализованы** (шаг 5) | `docker/Dockerfile.backend:219-310`, `docker/Dockerfile.executor:182-256`, `docker/install-tier-3.sh` |

## Дельта

1. **Порт исполнения** `ExecutionPort.execute(req) → ExecResult` (`req`: `{ command, cwd, env?, timeoutMs?, stdin? }`; `ExecResult`: `{ stdout, stderr, exitCode, truncated, durationMs }`) + реализации `InlineExecutionPort` (обёртка над текущими in-process вызовами: `packages/core/src/engine/tools/shell.ts:45`, `packages/core/src/engine/tools/search.ts:49`, `packages/core/src/engine/tools/git.ts:30`, `packages/core/src/git/git-service.ts:132`) и `RemoteExecutionPort`. Рефакторинг **без изменения поведения**; контрактный suite по образцу слоя хранения (`packages/core/src/storage/contract/index.ts`).
2. **Секция `execution`** в конфиге: `packages/shared/src/config/types.ts` + `defaults.ts` + `resolve.ts` — `mode`, `remote.url`, `remote.timeoutMs`, `remote.concurrency`, `remote.failMode`, `remote.tokenSecret`; env `SYNTH_EXECUTION_*`; CLI-флаг `--execution-mode`; **fail-closed** на неизвестном `mode` (образец — `packages/shared/src/config/resolve.ts:283-306`); значение токена в конфиге не хранится (инвариант 13).
3. **Multistage Dockerfile** с flavor-таргетами (`slim`/`core`/`dev`/`devops`/`browser`/`full`) и distro-aware скриптами тиров `docker/install-tier-N.sh` (единый список пакетов на тир, выбор `apk`/`apt`). *Шаги 2, 4 и 5 (сделано): `docker/Dockerfile.backend` (стадии `build`/`core`/`dev`/`devops`/`browser`/`full`/`slim`), `docker/Dockerfile.executor` (стадии `build`/`core`/`dev`/`devops`/`browser`/`full`), `docker/install-lib.sh`, `docker/install-hard-deps.sh`, `docker/install-tier-0.sh`, `docker/install-tier-1.sh`, `docker/install-tier-2.sh`, `docker/install-tier-3.sh`, `docker/install-tier-4.sh`, `docker/install-db-clients.sh`, `docker/install-diag.sh`, `docker/install-buildah.sh`, `docker/install-docker-cli.sh`.*
4. **All-in-one образ** `synth-backend:<v>-<flavor>`: control plane + toolchain + рантайм исполнителя в одном контейнере; исполнитель — отдельный процесс с собственным `HOME`/env/лимитами.
5. **Образ worker'а** `synth-executor:<v>-<flavor>`: toolchain-слои + рантайм исполнителя, без control plane и без UI; entrypoint — рантайм исполнителя (PROP-077). *Уточнение шага 5: в образ также входит `dist` core — `@itphx/synth-core` объявлен peer-зависимостью исполнителя и импортируется в рантайме (см. раздел шага 5).*
6. **Реестры и публикация**: **все** flavor-образы обоих образов — в **приватный Gitea** `git.itphx.ru/itphx/…` (версионные теги, без `latest`); базовые образы — как раньше, в `gitverse.ru`/`ghcr.io`; секрет `GV_GITEA_TOKEN` (fail-closed без токена); последовательный push с ретраями; `imagePullSecrets` для backend'а и worker'а. *Реализовано (шаг 6): `scripts/publish-images.sh` (сборка всех flavor'ов + push + сводка), `scripts/docker-auth-gitea.sh` (авторизация), джоба `publish-images-gitea` в `.gitverse/workflows/release.yaml` (по тегу релиза, отдельный kaniko-шаг на flavor с registry-кэшем), smoke-тесты `scripts/smoke-image.sh` + `scripts/ci-images.sh` и джоба `images` в `.gitverse/workflows/ci.yaml` (публикации нет).* Осталось: расширить `scripts/docker-cleanup.mjs` на репозитории Gitea.
7. **CI**: registry-cache (`--cache=true`), **smoke-тесты на каждый flavor** (`git --version`, `rg --version`, `python3 --version`, `kubectl version --client`, `playwright --version`) — ловят проблемы базы (glibc/musl); перевод билдера с `kaniko` на `buildah`; per-arch сборка flavor'ев.
8. **Helm**: `execution.mode`, `execution.remote.url`, `execution.remote.existingSecret`/`execution.remote.tokenKey`, `execution.remote.timeoutMs`, `execution.remote.concurrency`, `execution.remote.failMode`, `executor.enabled`, `executor.image.repository`/`.tag`/`.pullPolicy`, `executor.replicaCount`, `executor.resources`, `executor.workspace.claimName`/`.mountPath`, `executor.podSecurityContext`/`executor.containerSecurityContext`, `executor.networkPolicy`; RWX-claim для workspace в split-режиме.
9. **Кэши на volume**: `HOME`/`PYTHONUSERBASE`/`PIP_CACHE_DIR` + npm/pnpm/ansible-galaxy/helm-repos — в all-in-one на PVC инстанса, в worker'е — отдельный том.
10. **Наблюдаемость**: коллектор исполнителя в `packages/core/src/metrics/collectors/` с метриками `synth_executor_queue_depth`, `synth_executor_workers_busy`, `synth_executor_wait_seconds`, `synth_executor_commands_total{outcome}`.
11. **docker-compose**: профили all-in-one и split в одном файле (ключ API обязателен из `.env`, как сейчас).
12. **Документация**: состав flavor'ов, размеры, матрица «all-in-one vs split», требования к workspace-томам, диагностика отсутствующих бинарей.

## Открытые вопросы

**Закрыто (согласовано в этой редакции и на шагах 5–6):**

- **Набор flavor'ов** — `slim`/`core`/`dev`/`devops`/`browser`/`full`; `lite` → `core`.
- **Базы** — alpine для `slim`/`core`/`dev`/`devops`, Debian (glibc) для `browser`/`full`.
- **Публикация** — **все** flavor-образы обоих образов (`synth-backend:<v>`, `synth-backend:<v>-<flavor>`, `synth-executor:<v>-<flavor>`) публикуются в **приватный реестр Gitea** `git.itphx.ru/itphx/…`, **только версионными тегами** (без `latest`); в `gitverse.ru`/`ghcr.io` — только базовые образы (`synth`, `synth-backend`, `synth-ui`). Обоснование: лимит ~500 МБ на репозиторий у GitVerse/GHCR (у Gitea такого лимита нет), уже существующий pull-secret `git.itphx.ru` в namespace `synth` и тестовый контур на Gitea; решение владельца — публикуем **все** flavor'ы в Gitea, иначе тяжёлые образы нечем проверить в K3s. Docker Hub не используется. Реализовано: джоба `publish-images-gitea` в `release.yaml` (по тегу релиза), `scripts/publish-images.sh`, `scripts/docker-auth-gitea.sh` (секрет `GV_GITEA_TOKEN`, fail-closed).
- **docker в образе** — только CLI, **без** `docker.sock`.
- **Инструмент сборки образов** — `buildah` (rootless) вместо `kaniko`; CI-билдер переводится на `buildah`.
- **Судьба `slim`** — не сворачивается: это базовый образ control plane без toolchain'а (`synth-backend:<v>`).
- **Per-arch vs «no RUN»** — **вариант A**: per-arch сборка flavor'ов (целевая стадия с `RUN`), arm64 требует QEMU/binfmt на раннере; `slim` остаётся multi-arch без эмуляции. Реализовано в `docker/Dockerfile.backend` (шаг 2); фактически в шаге 6 flavor'ы публикуются **amd64-only** (kaniko без эмуляции, `--platform` не задаётся) — multi-arch для flavor'ов остаётся отдельной задачей.
- **`terraform` → OpenTofu** — в образ кладётся **OpenTofu** (бинарь `tofu`) + симлинк `terraform` → `tofu`; HashiCorp Terraform (лицензия BUSL) не используется. Реализовано в обеих ветках: таблица upstream-релизов tier 2 общая для alpine и debian (`docker/install-tier-2.sh:79-94`).
- **docker CLI в debian-ветке** — **вариант (а)**: статический бандл `download.docker.com` (пин 29.9.2 + sha256), из архива берётся только CLI; демона в образе нет. Вариант (б) (apt-репозиторий docker со сторонним GPG-ключом) и вариант (в) (не включать docker CLI) отклонены. Оговорка: docker не публикует checksum'ов для статического бандла — суммы зафиксированы в репозитории по артефакту, fail-closed сохранён. Реализовано в шаге 5 (`docker/install-docker-cli.sh:24-60`).
- **Playwright-браузеры** — **печатаются в образ** (`playwright install --with-deps chromium`, каталог `/opt/ms-playwright`, общий для всех пользователей); в рантайме ничего не скачивается. Реализовано в шаге 5 (`docker/install-tier-3.sh:120-138`).

**Открыто:**

- **Версии тулов** — `kubectl`/`helm`/`terraform` версионно-зависимы от целевого кластера/проекта: фиксировать в образе или делать настраиваемыми (и как — отдельный flavor на версию или подстановка в volume)? *Для alpine-ветки пины уже зафиксированы в образе* (`kubectl` 1.37.1, `helm` 3.22.1, `kustomize` 5.8.3, OpenTofu 1.13.1, `hadolint` 2.15.1 — `docker/install-tier-2.sh:79-85`); открытым остаётся, только ли это нерасширяемый набор, или база для настраиваемых версий.
- **`uv`/`uvx`** — включать в образ (python-MCP, быстрые установки) или ограничиться `pip`/`venv`?
- **Node-версии** — нужен ли version manager (`fnm`/`volta`) в образе или остаётся одна версия 22 (`docker/Dockerfile:27`)?
- **`buildah` в контейнере** — в образе зафиксированы только клиентские части; полноценная сборка образов из сессии требует прав, недоступных в типовом pod'е: `CAP_SYS_ADMIN`/`CAP_SYS_RESOURCE`, `/dev/fuse`, `TMPDIR` не на overlayfs, а для rootless — ещё и writable `--root`/`--runroot` (рецепты и причины падений — в разделе «Ограничения buildah в контейнере»). Ограничение надо связать с решением по образу worker'а: либо worker получает отдельный профиль capability (`executor.podSecurityContext`, PROP-077), либо сборка образов из сессии выносится из образов Synth вообще (отдельный сервис-билдер).
- **MCP-серверы tier 4** — версии зафиксированы в образе (`docker/install-tier-4.sh:53-58`): обновление = пересборка образа (supply-chain — референс PROP-068). Нужно решить, как обновляются зафиксированные версии (автоматический PR на bump + пересборка в CI или ручной bump) и допускается ли в образе «плавающая» версия.
- **Размер и pull-time** — приемлемый бюджет для all-in-one/worker-образов; локальные кэши и `docker save`-бандлы (для закрытого контура) против `docker pull` из сети; `offline-images` уже собирает бандлы только для базовых образов (`.gitverse/workflows/release.yaml:772-775`).
- **Кастомные образы и доверие к ним** — кто может подменить toolchain (digest'ы, подпись, admission-проверка) — референс PROP-068 и «Изоляция/квоты» в PROP-077.
- **Отдельный ли репозиторий/пакет для `synth-executor`** — *закрыто на шаге 5*: **отдельный npm-пакет в монорепо** — `@itphx/synth-executor` (`packages/executor`, публикуется вместе с остальными пакетами, ADR-038) + собственный `docker/Dockerfile.executor`; образы worker'ов собираются из исходников монорепо, как `synth-backend`.
- **Взаимодействие с PROP-068 (trust/scan)** — как бинари, запечённые в образ (MCP-серверы, tier-инструменты), проходят регистрацию/сканирование реестра скиллов и агентов?

## Зависимости

- **PROP-077** — split-топология, доверенная граница, жизненный цикл и S3; здесь — all-in-one и единый переключатель топологии.
- **PROP-032** — предпосылка масштабирования control plane (несколько реплик ⇒ PostgreSQL); на all-in-one не влияет.
- **ADR-038** — сборка/публикация образов и npm-пакетов (образы публикуются только по тегу релиза).
- **ADR-023** — приоритет конфигурации `CLI > env > config.yaml > defaults` (секция `execution`).
- **ADR-075** — workspace проекта: provisioning, `workspaceOutsideRoot`; в split-топологии workspace — общий том.
- **ADR-076** — git-репозитории и SSH-ключи (`openssh-client` в образе; доставка SSH-материала в worker'а — PROP-077).
- **ADR-078** — детект отсутствующих бинарников: в worker'е детект должен делать исполнитель, а не локальный `execFile`.
- **ADR-071** — MCP: реестр и политики; flavor'ы несут только рантаймы/бинари.
- **ADR-094** — контракт наблюдаемости (имена `synth_*`, запрет сырых путей и `session_id`).
- **ADR-096/ADR-097** — образец портов и контрактного suite (для `ExecutionPort`).
- **ADR-099** — единый egress-слой: TLS/CA и прокси — доверие backend → исполнитель.
- **ADR-052** — образец scoped-токена (service-key) для аутентификации backend'а на worker'е (`synth_exec_…`).
- **ADR-092** — рестарт инстанса (exit code 75) — смена `execution.mode` только через рестарт.
- **ADR-042** — гибрид: локальный core и удалённый backend (в hybrid локальный core — отдельный случай inline-исполнения).
- **PROP-080/081** — режимы-полюса и политики гибрида (прецедент «режим — параметр запуска»).
- **PROP-068** — trust/supply-chain для бинарей MCP и кастомных образов.
- **PROP-097** — реестр фоновых процессов (долгоживущие команды исполнителя).

## Связи

- [PROP-077](./prop-077-runtime-toolchain.md) «Инструментальное окружение исполнения (toolchain и executor)» — split-топология, доверенная граница, S3.
- [PROP-032](./prop-032-history-storage-postgresql.md) «Второй вариант хранения — БД (PostgreSQL) за единым слоем» — предпосылка масштабирования control plane.
- [ADR-023](./adr-023-configuration.md) «Конфигурация» — приоритет CLI/env/config.yaml.
- [ADR-038](./adr-038-npm-packages.md) «Монорепо как набор публикуемых npm-пакетов» — сборка и публикация образов.
- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог (создание и выбор)» — workspace и его provisioning.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и доступ (SSH)» — `git`/`openssh-client` в образе.
- [ADR-078](./adr-078-runtime-dependency-availability.md) «Авто-отключение инструментов при отсутствии внешней зависимости» — детект бинарников.
- [ADR-071](./adr-071-mcp-servers-prompt.md) «MCP-серверы — уровни, скоуп и представление в промпте» — рантаймы MCP в flavor'ах.
- [ADR-094](./adr-094-observability-metrics.md) «Наблюдаемость — Prometheus-метрики, liveness/readiness и эксплуатационные алерты» — контракт имён метрик.
- [ADR-096](./adr-096-storage-layer.md) «Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами» и [ADR-097](./adr-097-storage-provider-class.md) «Класс расширения «хранилище» (storage)» — образец порта и контрактного suite.
- [ADR-099](./adr-099-egress-tls-trust.md) «Единый egress-слой — доверие TLS/CA (mTLS), адресная политика и прокси» — доверие между control plane и исполнителем.
- [PROP-068](./prop-068-skills-agents-registry.md) «Реестр и каталог скиллов и агентов (контент-платформа)» — доверие к бинарям в образе.
- [PROP-080](./prop-080-managed-hybrid-modes.md) «Управляемый гибрид: режимы-полюса, идентичность и установка локально» — прецедент «режим — параметр запуска».
- [docs/PUBLISHING.md](../PUBLISHING.md) — сборка Docker/Helm, политика реестров и лимиты.
- [docs/DEVELOPMENT.md](../DEVELOPMENT.md) — dev-окружение, скрипты.
- [docs/OBSERVABILITY.md](../OBSERVABILITY.md) — каталог метрик и runbook.

## Порядок реализации

План **общий с [PROP-077](./prop-077-runtime-toolchain.md)** — нумерация шагов единая; владелец шага указан в таблице.

| Шаг | Содержание | Владелец | Зависимость от PostgreSQL (PROP-032) |
|---|---|---|---|
| **1** | Порт исполнения `ExecutionPort` + `InlineExecutionPort`: вынести 5+ точек исполнения за порт **без изменения поведения**; контрактный suite — **сделано** | общий | не нужна |
| **2** | Multistage Dockerfile + distro-aware скрипты тиров + flavor `core` → all-in-one образ `synth-backend:<v>-core` — **сделано** | PROP-082 | не нужна |
| **3** | Секция `execution` в конфиге (`mode`, `remote.*`), env `SYNTH_EXECUTION_*`, CLI `--execution-mode`, fail-closed на неизвестном `mode` — **сделано** | общий | не нужна |
| **4** | Flavor'ы `dev`/`devops` (alpine-ветка) — **сделано** | PROP-082 | не нужна |
| **5** | Flavor'ы `browser`/`full` (debian-ветка, Playwright) + образ worker'а `synth-executor:<v>-<flavor>` — **сделано** | PROP-082 | не нужна |
| **6** | CI: публикация **всех** flavor'ов обоих образов в **приватный Gitea** `git.itphx.ru/itphx/…` (версионные теги, секрет `GV_GITEA_TOKEN`, последовательный push с ретраями), registry-cache, smoke-тесты на каждый flavor (`scripts/smoke-image.sh` + `scripts/ci-images.sh`), `scripts/docker-cleanup.mjs` под новые репозитории — **сделано** (осталось расширить cleanup на репозитории Gitea) | PROP-082 | не нужна |
| **7** | Executor-сервис: exec-API, `RemoteExecutionPort`, токен `synth_exec_…`, чарт `executor.*` (Deployment/Service/пул), **фаза 1** матрицы (`execute_shell`/`grep_files`/`python`) | PROP-077 | нужна для >1 реплики control plane; при 1 реплике — нет |
| **8** | **Фаза 2** матрицы: git-тулы + доставка SSH-материала в исполнителя | PROP-077 | не нужна |
| **9** | **Фаза 3** матрицы: MCP stdio-серверы и inline-shell | PROP-077 | не нужна |
| **10** | Изоляция и квоты (`NetworkPolicy`, `ResourceQuota`/`LimitRange`, лимиты worker'а, без `docker.sock`); наблюдаемость: метрики `synth_executor_*`, `/metrics` исполнителя, алерты; детект зависимостей (ADR-078) на стороне исполнителя | PROP-077 | не нужна |
| **11** | Workspace-v2: per-worker копия или S3-совместимое объектное хранилище (снимает «один RWX-том на всех») | PROP-077 | желательна |
| **12** | Миграции и документация: переключение топологии (runbook — `docs/MAINTENANCE.md`), секция `execution` в `docs/CONFIGURATION.md`, метрики в `docs/OBSERVABILITY.md`, примеры в `charts/synth/README.md`, диагностика в `docs/TROUBLESHOOTING.md`; compose-сценарии all-in-one/split | общий | не нужна |

Шаги 1–3 и 6 не требуют PostgreSQL и могут идти до перехода на БД; шаг 7 — первый, где PG нужна для полного эффекта (несколько реплик control plane); шаги 1, 2, 3, 4, 5, 6, 10, 12 от PG не зависят.

Split-топология технически возможна и при одной реплике control plane (пул worker'ов масштабируется независимо); PostgreSQL обязателен для масштабирования самого control plane — больше одной реплики.

## История

- 2026-10-21 — переработано: all-in-one образ (control plane + toolchain + исполнитель), образы worker'ов, flavor-матрица и единый переключатель топологии `execution.mode` (PROP-077).
- 2026-10-21 — шаг 2: multistage `docker/Dockerfile.backend` (стадии `build`/`core`/`slim`), distro-aware скрипты тиров, flavor `core` (hard deps + tier 0) — решение по arm64: **вариант A** (per-arch, QEMU/binfmt для flavor'ов; `slim` без `RUN` — multi-arch без эмуляции).
- 2026-10-21 — шаги 4–5: flavor'ы dev/devops (alpine) и browser/full (debian) + образы исполнителей; замеры и решения по yq/docker-CLI/Playwright; 2026-10-22 — шаг 6: решение владельца — **все** flavor'ы публикуются в приватный Gitea `git.itphx.ru/itphx/…` (в `gitverse.ru`/`ghcr.io` — только базовые образы, Docker Hub не используется).
