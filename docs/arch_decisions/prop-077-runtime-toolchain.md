# PROP-077: Инструментальное окружение исполнения (toolchain и executor)

> **Статус:** 🧩 Предложение — Toolchain/executor: thin backend + сервис-executor, общий volume для workspace, S3; после PROP-032
> **Решение до:** 2026-11-14
> **Источник:** переработано 2026-09-30 (обсуждение эксплуатации managed-Synth); первоначальная редакция от 2026-09-23 («tools-образ + volume в тот же pod») заменена полностью.
> **Порядок:** реализуется **после перевода хранения на PostgreSQL** (PROP-032) — см. «Открытые вопросы» и «Порядок реализации».
> **Ближайший шаг:** toolchain в образе для local и базового managed — [PROP-082](./prop-082-full-images-deployment.md).

**Решение:** в **managed**-развёртывании инструменты, нужные агентским тулам (`git`, `ripgrep`, `python3`/`pip`, `ssh`), выносятся в отдельный сервис **executor**; backend остаётся «тонким» control plane. **Workspace в первой фазе executor'у не передаётся** — backend и executor видят его через **общий volume**. **S3** (S3-совместимое объектное хранилище) — зафиксированное целевое направление для хранения, архивации и восстановления workspace.

## Терминология

| Термин | Что |
|---|---|
| **executor** | отдельный сервис **исполнения команд** с toolchain (`git`/`rg`/`python`/`ssh`), exec-API, жизненным циклом (spawn/timeout/stop) и, в перспективе, изоляцией |
| **workspace** | рабочий каталог проекта (`project.workspace`, ADR-075); в первой фазе остаётся у backend'а |

## Решение

### Managed

- backend остаётся **control plane** (сессии, история, контекст, permissions, RBAC/OIDC, LLM Gateway, API v2) и **не раздувается** toolchain'ом: слои образа множатся на число реплик.
- toolchain уезжает в **executor** — отдельный сервис с exec-API. Исполнение — это отдельный пул, который масштабируется по нагрузке исполнения (число активных сессий), а не по числу HTTP-реплик backend'а; executor'ы планируются на ноды независимо.
- **workspace не передаётся executor'у** в первой фазе: backend и executor монтируют **общий volume** с workspace. Backend сохраняет provisioning (`engine/workspace-provision.ts`, ADR-075), FS-роуты и `project.repos`; executor выполняет команды по тем же файлам. Требование: общий volume доступен всем репликам backend и всем executor'ам (RWX-класс: NFS/CephFS и т.п.).
- **S3** — целевое хранилище: архивация/восстановление workspace, бэкап, перенос между нодами, снижение зависимости от локального PVC.

Локальные режимы (local host, local containerized) и toolchain в образе для базового managed закрываются отдельно — [PROP-082](./prop-082-full-images-deployment.md).

### Executor

Executor — рамки подсистемы (детальная проработка — отдельным AD; здесь фиксируется объём):

- **Отдельный сервис**: собственный процесс/деплой; при managed — контейнер (в перспективе pod).
- **exec-API**: выполнение команды (`command`, `cwd`, `env`, `timeout`) → `stdout`/`stderr`/`exitCode`/`truncated`; отмена (аналог `toolAbortController`); лимиты вывода (сейчас `maxBuffer` 10 МБ, обрезка 100 КБ). Транспорт — уточняется (HTTP/gRPC/unix-socket).
- **Жизненный цикл**: spawn на сессию (lazily при первом tool-call или на старте сессии); остановка по **idle-timeout** и максимальному времени жизни; graceful kill; очистка orphan'ов после рестарта backend'а.
- **Toolchain**: `git`, `ripgrep`, `python3`/`pip`, `ssh`; версионирование образа; в перспективе — разные версии инструментов и **кастомные** бинарники (выбор образа/тега на уровне проекта/сессии).
- **Изоляция**: в перспективе — namespaces/cgroups/seccomp, network policy, лимиты на вызов, отдельный ServiceAccount.
- **Безопасность**: executor не должен видеть LLM-ключи, OIDC-секреты и чужой workspace; доступ — только к своему workspace и toolchain.

### Workspace и S3

- Workspace живёт на **общем volume** (backend ↔ executor). Backend остаётся владельцем provisioning'а и FS-роутов; executor — исполнитель.
- **S3** — целевое хранилище: архивация/восстановление workspace, бэкап, перенос между нодами. Форматы, шифрование, lifecycle — открытые вопросы.

## Что уже есть

| Факт | Где |
|---|---|
| Образы на `node:22-alpine`, **ни одного `apk add`**; нет `git`/`rg`/`python`/`ssh` | `docker/Dockerfile`, `docker/Dockerfile.backend`, `docker/Dockerfile.ui` |
| Всё исполнение — в процессе backend/core: `sh -c`, `execFile('git')`, `execFile('rg')`, `simple-git`, MCP stdio `spawn` | `packages/core/src/engine/tools/{shell,git,search}.ts`, `packages/core/src/git/git-service.ts`, `packages/core/src/engine/mcp/client.ts` |
| Детект внешних бинарников (`git`/`rg`/`sh`) + `unavailable(dependency)`, локализованное пояснение модели | `packages/core/src/engine/tools/runtime-deps.ts`, `packages/core/src/engine/permission/availability.ts` (ADR-078) |
| backend: **1 реплика** (JSON-хранилище не масштабируется), PVC `data` → `/var/synth/data`, `runAsUser 1000`, `allowPrivilegeEscalation: false`, нет `docker.sock`/`Role`/`RoleBinding` | `charts/synth/values.yaml`, `templates/backend-deployment.yaml`, `templates/backend-pvc.yaml` |
| workspace — на PVC backend'а; provisioning — `engine/workspace-provision.ts` (ADR-075); git-репозитории и SSH-ключи — `project.repos`, `secrets/ssh-keys` (ADR-076) | `packages/core/src/engine/workspace-provision.ts`, `packages/core/src/storage/ssh-key-store.ts` |
| `execute_shell` наследует `process.env`, `HOME` по умолчанию `/root` (при `runAsUser: 1000` — не writable) | `packages/core/src/engine/tools/shell.ts` |
| S3/объектного хранилища нет | — |

## Дельта

1. **executor-сервис**: отдельный сервис/пакет, exec-API, клиент в core; вынесение исполнения из процесса backend.
2. **Общий volume**: workspace смонтирован и в backend, и в executor (RWX); без переноса владения workspace.
3. **Toolchain-образ executor'а**: состав, версионирование, кастомные бинарники.
4. **Жизненный цикл и распределение нагрузки**: spawn/timeout/kill executor'ов, лимиты, планирование.
5. **S3**: хранение/архивация/восстановление workspace.
6. **Документация**: требования к инструментам, диагностика отсутствующих бинарей при вынесенном исполнении.

## Открытые вопросы

- **Спавн executor'ов в K8s**: scoped `Role` backend'у (pods/jobs) / отдельный контроллер-оператор (backend создаёт CRD) / статический пул с очередью.
- **Гранулярность executor'а**: сессия / пользователь / проект.
- **Что уезжает в executor первым**: `execute_shell`/`grep_files`/`python` vs git/SSH vs FS-роуты (в первой фазе остаются в backend).
- **Git и SSH в executor'е** (если переезжают): как доставлять расшифрованный SSH-материал (ADR-076) при том, что ключи шифрованы в `{dataDir}` backend'а.
- **Общий volume**: RWX-класс (NFS/CephFS); конкуренция за данные при >1 реплике backend.
- **S3**: S3-совместимый (MinIO) vs облачный; шифрование, lifecycle, формат архива; что именно архивируется.
- **Изоляция и квоты**: namespaces/cgroups/seccomp, network egress, лимиты CPU/RAM/времени, доверие к кастомным образам (референс — PROP-068).
- **Детект ADR-078**: при вынесенном исполнении наличие бинарников должен проверять executor, а не локальный `execFile`.

## Зависимости

- **PROP-032** — PostgreSQL: **предпосылка** реализации PROP-077 (масштабируемое состояние backend'а).
- **PROP-082** — full-образы и базовое развёртывание (ближайший шаг; toolchain в образе).
- **ADR-022** — Runner-архитектура (stateless-движки); концептуальная база для отдельного сервиса-исполнителя.
- **ADR-038** — сборка/публикация образов и пакетов (npm/Docker/Helm).
- **ADR-042** — гибрид (где исполняется local vs managed).
- **ADR-075** — workspace проекта: provisioning, `workspaceOutsideRoot`.
- **ADR-076** — git-репозитории и SSH-ключи (доставка материала в executor).
- **ADR-078** — реакция на отсутствие бинарников; источник детекта при вынесенном исполнении.
- **ADR-005** — JSON-хранилище: ограничение на общий volume и конкуренцию.

## Связи

- [PROP-032](./prop-032-history-storage-postgresql.md) «Миграция хранения истории на PostgreSQL».
- [PROP-082](./prop-082-full-images-deployment.md) «Full-образы и базовое развёртывание».
- [ADR-022](./adr-022-typescript-stack-runner.md) «Единый TypeScript стек + Runner-архитектура».
- [ADR-038](./adr-038-npm-packages.md) «Монорепо как набор публикуемых npm-пакетов».
- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог».
- [ADR-076](./adr-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и доступ (SSH)».
- [ADR-078](./adr-078-runtime-dependency-availability.md) «Авто-отключение инструментов при отсутствии внешней зависимости».
- [docs/PUBLISHING.md](../PUBLISHING.md) — сборка Docker/Helm.

## Порядок реализации

1. **Предпосылка:** перевод хранения на PostgreSQL (PROP-032) — масштабируемое состояние backend'а.
2. **executor MVP**: сервис + exec-API + клиент в core; общий volume с workspace; первые вынесенные операции — `execute_shell`/`grep_files`/`python`.
3. **Жизненный цикл и масштабирование**: spawn/timeout/kill, лимиты, способ спавна, планирование.
4. **S3**: архивация/восстановление workspace.
