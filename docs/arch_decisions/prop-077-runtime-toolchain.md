# PROP-077: Инструментальное окружение исполнения (toolchain и executor)

> **Статус:** 🧩 Предложение — split-топология: control plane + отдельные контейнеры-исполнители (worker/executor); all-in-one — PROP-082; общий переключатель `execution.mode`
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-21
> **Источник:** переработано 2026-10-21 (проработка двух топологий развёртывания: отдельные контейнеры-исполнители vs all-in-one)
> **Ближайший шаг:** порт исполнения + all-in-one образ — [PROP-082](./prop-082-full-images-deployment.md); flavor'ы образов — там же.

**Решение:** инструментальное окружение исполнения (toolchain) и сам механизм исполнения команд
выносятся из процесса backend'а в **отдельный сервис-исполнитель (executor/worker)** — это
**split-топология**: backend становится тонким control plane (сессии, история, контекст, permissions,
RBAC/OIDC, LLM Gateway, API v2), а команды агентских тулов (`execute_shell`, `grep_files`, git-тулы)
выполняются в отдельных контейнерах с toolchain'ом. Исполнение за этим швом скрыто **портом
исполнения** (`ExecutionPort`) — по образцу портов слоя хранения ([ADR-096](./adr-096-storage-layer.md),
[ADR-097](./adr-097-storage-provider-class.md)): две взаимозаменяемые реализации, `InlineExecutionPort`
(нынешнее in-process исполнение) и `RemoteExecutionPort` (HTTP к исполнителю), и один контрактный
suite на обе. Топология выбирается **одним параметром запуска** — `execution.mode`
(`inline` — дефолт, обратная совместимость; `remote` — split), а не runtime-настройкой: смена режима
требует перезапуска процесса, как и остальные process-глобальные решения ([ADR-092](./adr-092-instance-lifecycle-maintenance.md)).
**All-in-one топология** (один образ: control plane + toolchain + рантайм исполнителя) — предмет
[PROP-082](./prop-082-full-images-deployment.md); здесь она только упоминается как второй режим той же
конфигурации, а код исполнителя — общий.

## Топологии развёртывания: split и all-in-one

Две топологии — **два режима одной конфигурации**, а не две разных систем. Разница — только в том,
**где физически живёт исполнитель**; код домена, порт исполнения и контракт — одни и те же.

| Режим | `execution.mode` | Где исполняется | Образы |
|---|---|---|---|
| **Inline (all-in-one)** | `inline` (дефолт) | в процессе backend'а | один образ: control plane + toolchain (+ рантайм исполнителя) |
| **Remote (split)** | `remote` | в отдельных контейнерах-исполнителях | `synth-backend` (control plane, без toolchain) + `synth-executor` (worker) |

Разделение по образу — не «выключатель», а следствие режима: в `inline` backend'у нужен toolchain
(образ с flavor'ом — [PROP-082](./prop-082-full-images-deployment.md)), в `remote` — не нужен, зато
нужен отдельный образ worker'а.

### Единый переключатель execution.mode

- Переключатель — **параметр запуска, не runtime**: секция `execution` в `config.yaml`, env
  `SYNTH_EXECUTION_MODE`, CLI-флаг `--execution-mode`.
- Смена — **только перезапуск процесса**. Обоснование — тот же класс, что у `storage.backend`
  (выбор физического backend'а хранилища, `packages/core/src/storage/storage-context.ts:134`) и у
  режимов-полюсов гибрида ([PROP-080](./prop-080-managed-hybrid-modes.md)): process-глобальные
  singleton'ы (TLS-диспетчер, пул PG, MCP, шедулер) не переинициализируются на лету — только рестарт
  (инвариант 24 корневого `AGENTS.md`; graceful shutdown с exit code 75 —
  `packages/core/src/server/restart.ts:23`).
- Приоритет — как у всей конфигурации ([ADR-023](./adr-023-configuration.md)): **CLI-флаг > env >
  `config.yaml` > дефолт**.
- Дефолт `inline` — обратная совместимость: нынешнее поведение (исполнение в процессе backend'а)
  сохраняется без изменений; новая секция в конфиге отсутствует у всех существующих установок.
- Значение `mode` — **fail-closed**: неизвестное явное значение (например, опечатка `inlne`) валит
  старт, а не молча выбирает дефолт (как `storage.backend` — «fail-closed на неизвестном явном
  значении»).

### Что где исполняется (таблица компонентов)

| Компонент | Inline (`inline`) | Remote (`remote`) |
|---|---|---|
| **Control plane** (сессии, история, контекст, permissions, RBAC/OIDC, LLM Gateway, API v2) | в процессе backend'а | в процессе backend'а (1+ реплики — при PostgreSQL) |
| **Хранилище** | файловое (`{dataDir}`) или PostgreSQL | PostgreSQL (предпосылка: см. «Зависимости») |
| **Workspace проекта** (`project.workspace`, [ADR-075](./adr-075-project-workspace-provisioning.md)) | локальный каталог backend'а | общий том (backend ↔ исполнители), см. «Доступ к workspace» |
| **Toolchain** (`git`, `ripgrep`, `python3`, `openssh-client`) | в образе backend'а (flavor — PROP-082) | в образе worker'а (`synth-executor`) |
| **Исполнитель** (spawn/timeout/kill, лимиты вывода) | `InlineExecutionPort` — вызов `execFile` в процессе | `RemoteExecutionPort` — HTTP к `synth-executor` |
| **Исполняемые команды** (shell, grep, git) | в процессе backend'а | в контейнере worker'а |
| **FS-роуты** (чтение/запись файлов через HTTP) | backend | backend (не уезжают — см. матрицу) |
| **Provisioning workspace** | backend (`engine/workspace-provision.ts`) | backend (тот же модуль) |
| **Git-реестр** (`project.repos`, [ADR-076](./adr-076-git-repo-registry-ssh.md)) | backend | backend (реестр и SSH-материал — в backend'е) |
| **LLM-вызовы** (через `GatewayProvider`, [ADR-036](./adr-036-llm-gateway.md)) | backend | backend (в исполнителе LLM-ключей нет) |
| **Permission-слой** (`plan`/`act`/`yolo`, allow/deny/ask) | backend | backend (решение о допуске — до вызова порта) |
| **MCP stdio-серверы** | в процессе backend'а (spawn через `StdioClientTransport`) | в процессе backend'а на фазе 1; в исполнителе — на фазе 3 |
| **Наблюдаемость** | `/metrics` backend'а | `/metrics` backend'а + `/metrics` исполнителя (агрегация) |

## Режим исполнения в конфигурации

Секция `execution` — **новая**; в репозитории её нет (ни в `packages/shared/src/config/types.ts`,
ни в `packages/shared/src/config/defaults.ts`, ни в `packages/backend/config.yaml:1`). Состав:

| Поле | Тип / значения | Дефолт | Смысл |
|---|---|---|---|
| `execution.mode` | `inline` \| `remote` | `inline` | Топология (см. «Единый переключатель»). |
| `execution.remote.url` | список адресов исполнителей | `[]` | Куда ходить за исполнением (K8s Service `synth-executor`, `http://…`); пусто при `remote` → fail-closed на старте. |
| `execution.remote.timeoutMs` | число | 30 000 | Таймаут exec-вызова. По умолчанию — как у нынешних тулов: 30 с (`packages/core/src/engine/tools/shell.ts:14`, `packages/core/src/engine/tools/search.ts:50`, `packages/core/src/engine/tools/git.ts:30`); для shell разрешён больший таймаут (до 120 с — `packages/core/src/engine/tools/shell.ts:22`) — отдельным значением в самом туле, не в конфиге. |
| `execution.remote.concurrency` | число | число CPU backend'а | Лимит одновременных exec-вызовов на backend; превышение → очередь с ожиданием (см. `synth_executor_wait_seconds`). |
| `execution.remote.failMode` | `fail` \| `inline-fallback` | `fail` | Поведение при недоступном исполнителе. **`fail` — fail-closed**: инструмент недоступен с явной причиной (`unavailable(dependency)`-подобный статус), fallback на локальное исполнение — только явной настройкой. |
| `execution.remote.tokenSecret` | путь/ссылка на токен | — | **Путь/ссылка, не значение** (инвариант 13): путь к файлу с токеном или `existingSecret`/`tokenKey` (как у `security.tls` в чарте). Сам токен — `synth_exec_…` (формат по образцу service-key, `packages/core/src/storage/service-api-key-store.ts:19`). |

Env-имена (по одному на поле): `SYNTH_EXECUTION_MODE`, `SYNTH_EXECUTION_REMOTE_URL`,
`SYNTH_EXECUTION_TOKEN`, `SYNTH_EXECUTION_TIMEOUT_MS`, `SYNTH_EXECUTION_CONCURRENCY`,
`SYNTH_EXECUTION_FAIL_MODE`. Приоритет — CLI-флаг > env > `config.yaml` > дефолт
([ADR-023](./adr-023-configuration.md)).

CLI-флаг: `--execution-mode inline|remote` (рядом с `--restart-mode`,
`packages/core/src/main.ts:81`); в managed этот флаг задаётся через env/ConfigMap чарта
(`charts/synth/templates/backend-deployment.yaml:59`), в standalone/local — через `config.yaml` или env.

`failMode: inline-fallback` — **явная** настройка, не дефолт: она означает, что при недоступности
исполнителя backend исполнит команду сам (в своём окружении, со своим toolchain). Это удобно для
миграции и для dev, но в managed-контуре это обход изоляции — включать только осознанно.

## Контракт исполнения (порт)

Исполнение — **порт**, по образцу портов слоя хранения ([ADR-096](./adr-096-storage-layer.md)):
домен работает через интерфейс, физический backend — взаимозаменяем.

```ts
// Порт — в core, реализации — рядом с ним.
interface ExecutionPort {
  execute(req: ExecRequest): Promise<ExecResult>;
}

interface ExecRequest {
  command: string;                 // строка (shell-семантика) — как сейчас в execute_shell
  cwd: string;                     // абсолютный путь внутри workspace
  env?: Record<string, string>;    // ДОПОЛНИТЕЛЬНОЕ окружение (мержится с базовым)
  timeoutMs?: number;              // таймаут вызова
  stdin?: string;                  // ввод (для неинтерактивных сценариев)
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;              // вывод обрезан по лимиту
  durationMs: number;              // длительность исполнения
}
```

- **Реализации:** `InlineExecutionPort` — нынешние `execFileAsync` в 5+ местах
  (`packages/core/src/engine/tools/shell.ts:45`, `packages/core/src/engine/tools/search.ts:49`,
  `packages/core/src/engine/tools/git.ts:30`, `packages/core/src/engine/commands/inline-shell.ts:39`,
  `packages/core/src/engine/tools/runtime-deps.ts:79`); `RemoteExecutionPort` — HTTP к исполнителю.
- **Контрактный suite** — как у storage-драйвера ([ADR-097](./adr-097-storage-provider-class.md)):
  один набор тестов на обе реализации (`packages/core/src/storage/contract/index.ts:1` — образец
  «паспорта порта»). Проверяется: корректность `exitCode`, раздельность stdout/stderr, `truncated` при
  превышении лимита, таймаут, отмена (`AbortSignal`), поведение при недоступности (fail-closed в
  `RemoteExecutionPort` при `failMode: fail`).
- Точка подключения — **один шов**: сегодня исполнение разбросано по 5+ местам и общего шва нет
  (перечислено выше); после шага 1 (см. «Порядок реализации») все эти места ходят в порт.
- **Ошибки** — типизированы: `ENOENT` (нет бинарника) → `tool.binary_missing`
  (`packages/core/src/engine/tools/shell.ts` — текущая ветка ошибки), таймаут/отмена → отдельные
  коды; классификация — по образцу [ADR-041](./adr-041-llm-error-taxonomy.md), строки — через
  `shared/i18n`.

## Executor: сервис и разделение ответственности

**Executor (worker) — тот же код, что и inline-рантайм исполнителя.** Исполнитель умеет работать и
отдельным сервисом (слушает exec-API), и локально внутри backend'а (inline). Это исключает расхождение
поведения между топологиями: один набор тестов, одна реализация команд.

Ответственность разделена строго:

| В backend'е (control plane) | В исполнителе (worker) |
|---|---|
| Сессии, история, контекст, LLM-вызовы, permissions, RBAC/OIDC | Выполнение команды, разбор env, лимиты вывода, таймаут |
| Provisioning workspace ([ADR-075](./adr-075-project-workspace-provisioning.md)) | Чтение/запись файлов **в пределах переданного `cwd`** |
| Git-реестр `project.repos` и SSH-ключи ([ADR-076](./adr-076-git-repo-registry-ssh.md)) | Никаких LLM-ключей, OIDC-секретов и чужих workspace |
| Решение о допуске тула и о режиме (`plan`/`act`/`yolo`) | Изоляция, квоты, лимиты ресурсов |
| Очередь вызовов, ретраи, `failMode` | Никакого доступа к API v2 |

### Способы размещения в Kubernetes (таблица сравнения)

| Способ | Как выглядит | RBAC | Изоляция | Стоимость | HA | Оценка |
|---|---|---|---|---|---|---|
| **(а) Статический пул Deployment + очередь в backend** | `Deployment` `executor.replicaCount` реплик + `Service`; backend держит очередь и лимит `execution.remote.concurrency` | Не нужен (backend не управляет pod'ами) | На уровне pod'а (podSecurityContext, seccomp, resources) | Дёшево: фиксированный набор pod'ов, запуск при старте чарта | Да — несколько реплик за Service, отказ одного pod'а не влияет | **Рекомендуется для первой версии** — нет RBAC-эскалации у backend'а, нет CRD, масштабируется горизонтально, поведение предсказуемо |
| **(б) Job на сессию (TTL)** | На сессию/задачу — `Job` с `ttlSecondsAfterFinished`; backend создаёт через API | Нужен `Role` на `batch/jobs` (create/get/delete) у backend'а | Лучше (отдельный pod на задачу, чистится по TTL) | Дорого: pod + scheduling на каждую сессию; холодный старт на каждый запуск | Ограниченная: упавший Job не перезапустится (ttl) | Не рекомендуется сейчас: требует RBAC-эскалации у control plane, медленный cold start, сложная очистка |
| **(в) CRD-оператор** | Свой CRD `ExecutorPool` + оператор, решающий lifecycle | Нужен `Role` на CRD + оператор в кластере | Лучше всех (оператор может творить namespaces, квоты, поды) | Очень дорого: отдельный сервис в кластере, CRD, версионирование API | Да (оператор — HA-компонент) | Оставить на будущее: нужен отдельный релизный цикл и свой AD; перебор для первой версии |

**Рекомендация — (а).** Обоснование: у backend'а сейчас **нет** `Role`/`RoleBinding` (в чарте создаются
только ServiceAccount'ы — `charts/synth/templates/serviceaccount.yaml:1`), и выдавать control plane
право создавать pod'ы — заметное расширение поверхности. Статический пул не требует прав создания
pod'ов вовсе, не требует CRD и не добавляет в кластер новый контроллер. Способы (б) и (в) оставлены
как эволюция (вопросы — в «Открытые вопросы»).

### Жизненный цикл

- **Spawn.** В split-режиме worker'ы **статические** и поднимаются вместе с чартом (вариант (а));
  «ленивый spawn на сессию» в нём не нужен — задержки холодного старта нет. В вариантах (б)/(в)
  spawn ленивый: pod создаётся на первый exec-вызов сессии.
- **Idle-timeout.** Worker без активных вызовов завершает работу по простою; в статическом пуле это
  не «убить pod», а снять нагрузку (`executor.replicaCount` — постоянный ресурс; idle-timeout
  применяется к вариантам с динамическими pod'ами). Внутри worker'а — лимит простоя контейнера.
- **Max-lifetime.** Максимальное время жизни экземпляра исполнителя (для динамических pod'ов — TTL).
- **Graceful kill.** По завершении сессии/очереди: сначала SIGTERM, затем SIGKILL по таймауту; активные
  exec-вызовы получают статус «прервано» (не «упало»).
- **Лимиты вывода.** Единые для обеих топологий: сейчас обрезка `MAX_OUTPUT_LENGTH = 100_000`
  (`packages/core/src/engine/tools/shell.ts:13`) и `maxBuffer 10 МБ`
  (`packages/core/src/engine/tools/shell.ts:51`); для git — `MAX_GIT_OUTPUT = 20_000`
  (`packages/core/src/engine/tools/git.ts:16`); для `rg` — 200 строк
  (`packages/core/src/engine/tools/search.ts:57`). В remote-режиме лимит применяется **на стороне
  исполнителя** (он владеет буфером) и дублируется на клиенте (защита от обхода лимита через прямой
  exec-API).
- **Рестарт backend'а (exit 75).** Живые exec-вызовы **не выживают**: backend уходит через graceful
  shutdown (`packages/core/src/server/restart.ts:23`), активные HTTP-вызовы к исполнителю обрываются,
  команды в worker'ах остаются выполняться до их таймаута — их результат никому не доставится.
  Следствие: restart в remote-режиме должен быть **менее частым**; либо — принудительное завершение
  вызовов на исполнителе по сигналу (отдельный endpoint отмены, см. «Открытые вопросы»).
- **Падение исполнителя.** Поведение определяется `execution.remote.failMode`: `fail` (дефолт) — вызов
  возвращает явную ошибку «исполнитель недоступен», инструмент помечается недоступным с причиной
  (по аналогии с `unavailable(dependency)`,
  `packages/core/src/engine/permission/availability.ts:147`); `inline-fallback` — backend выполняет
  команду сам.
- **Очистка orphan-процессов.** Процессы, оставшиеся после падения исполнителя, — в зоне K8s
  (kubelet дочищает контейнер после смерти pod'а) и в зоне worker'а (собственный reaper: при старте
  worker убивает процессы предыдущего экземпляра, если они пережили перезапуск; `execute_shell` уже
  убивает процесс по SIGTERM при «Стопе», `packages/core/src/engine/tools/shell.ts:45`).
- **Интерактивность.** PTY/attach-режим — вне объёма этой версии (референс — PROP-064
  «UI-терминал»); exec-API — только неинтерактивные команды.

## Доверенная граница backend → исполнитель

Граница «control plane → исполнитель» — **граница доверия**, и она строится по образцу
[ADR-099](./adr-099-egress-tls-trust.md) и [ADR-052](./adr-052-public-api-platform.md).

- **TLS.** Общий транспорт исходящих вызовов — `egressFetch` (`packages/core/src/security/tls.ts:302`),
  глобальный undici-диспетчер, `initTlsTrust` при старте (`packages/core/src/security/tls.ts:241`).
  Подсистема **не создаёт** собственных
  HTTP-агентов и не полагается на `NODE_EXTRA_CA_CERTS` как на конфигурацию (инвариант 22).
  Доверие к сертификату исполнителя — секция `security.tls` + per-host mapping для его адреса
  (ADR-099); CA-материалы — в Secret, в config.yaml попадают только пути
  (`charts/synth/values.yaml:176` — комментарий «в config.yaml попадают ТОЛЬКО пути внутри контейнера»).
- **Аутентификация.** Статический токен `synth_exec_…` — по образцу service-key
  (`packages/core/src/storage/service-api-key-store.ts:19`): хранится в Secret, в конфиг/ConfigMap
  не попадает (инвариант 13); передаётся как bearer-заголовок. Опционально — **mTLS** (клиентский
  сертификат из того же `security.tls`).
- **Egress-политика.** Обращения backend'а к исполнителю проходят через политику встроенных
  инструментов (`egress.tools`, `packages/shared/src/config/types.ts:534`) — адрес исполнителя должен
  быть разрешён; `POST /api/v2/settings/egress/check` (ADR-099) — offline-проверка без запроса.
- **В исполнителе нет** LLM-ключей, OIDC-секретов, ключей API провайдеров и чужих workspace. В
  split-режиме образ worker'а собирается отдельно от образа backend'а — это и есть главный
  выигрыш топологии.
- **Политика `allowedProjects`/`scopes` к исполнителю не применяется** — исполнитель не является
  внешним сервисом с точки зрения публичного API; граница доверия здесь — сеть + токен + TLS.
- **Аудит.** Каждый exec-вызов логируется на backend'е (команда, `cwd`, длительность, исход) и на
  исполнителе; в журнал аудита (`{dataDir}/audit/`) попадает факт вызова, но **не** содержимое вывода
  (может содержать секреты).

## Доступ к workspace

Workspace проекта (`project.workspace`, [ADR-075](./adr-075-project-workspace-provisioning.md)) — то,
что делает split-топологию нетривиальной: backend и исполнитель должны видеть **одни и те же файлы**.

- **Кто владеет provisioning'ом** — backend, всегда: `resolveWorkspaceForLocalProject`
  (`packages/core/src/engine/workspace-provision.ts:47`), `validateManagedWorkspacePath`
  (`packages/core/src/engine/workspace-provision.ts:109`), `provisionManagedWorkspace`
  (`packages/core/src/engine/workspace-provision.ts:179`), единая точка `provisionWorkspace`
  (`packages/core/src/engine/workspace-provision.ts:232`). Исполнитель provisioning'ом не занимается.
- **Сейчас** workspace лежит на PVC backend'а (`charts/synth/templates/backend-deployment.yaml:134` —
  mount `data` → `/var/synth/data`), отдельного тома под workspace в чарте нет; `storage.workspacesRoot`
  по умолчанию пуст (`packages/shared/src/config/defaults.ts:25`).
- **В split-режиме** нужен **общий том**: backend и все исполнители монтируют один и тот же каталог
  workspace. Требование — RWX-класс (NFS/CephFS и т.п.). В чарте **RWX-варианта нет**: PVC создаётся
  с `accessMode: ReadWriteOnce` (`charts/synth/values.yaml:45`,
  `charts/synth/templates/backend-pvc.yaml:16`) и `replicaCount: 1` — «Хранилище JSON-файлы → НЕ
  масштабируется, всегда 1 реплика» (`charts/synth/values.yaml:11`).
- **Следствие для состояния**: файловая БД (JSON в `{dataDir}`) **не масштабируется** на несколько
  реплик backend'а — это отдельное ограничение, не связанное с исполнителем. Распределённое
  исполнение при 1 реплике backend'а — уже полезно (пул worker'ов на отдельных нодах), но требует
  общего тома под workspace.
- **Containment.** Границы путей не ослабляются: относительные пути — только внутри
  `project.workspace`; для git — `resolveRepoCwd` с проверкой симлинков
  (`packages/core/src/engine/tools/git.ts:52`); общий `cwd` исполнителя — корень workspace
  конкретного проекта, переданный в запросе, и ничего шире.
- **Альтернатива общему тому** — per-worker копия workspace (workspace-v2) или объектное хранилище:
  это шаг 11 «Порядка реализации» и открытый вопрос (см. «Открытые вопросы»).

## Матрица: что уезжает в исполнитель (по фазам)

| Фаза | Что уезжает | Что остаётся в backend'е | Обоснование |
|---|---|---|---|
| **1** | `execute_shell` (`packages/core/src/engine/tools/shell.ts:45`), `grep_files`/`rg` (`packages/core/src/engine/tools/search.ts:49`), python через shell | FS-роуты, provisioning workspace, git-реестр, хранение, LLM-вызовы, permission-слой, MCP stdio | Минимальный шов, максимальный выигрыш: shell — самая «тяжёлая» и самая частая операция; git и MCP требуют доставки ключей/реестров, поэтому идут позже |
| **2** | git-тулы (`packages/core/src/engine/tools/git.ts:30`) + доставка SSH-материала | git-реестр `project.repos` (в backend'е), расшифровка и выдача ключей (в backend'е) | SSH-ключи per-agent шифрованы at-rest (`enc:v1:…`, AES-256-GCM) в `{dataDir}/secrets/ssh-keys/` (`packages/core/src/storage/ssh-key-store.ts:15`, `:71`); их доставка исполнителю — отдельный протокол (открытый вопрос) |
| **3** | MCP stdio-серверы (`packages/core/src/engine/mcp/client.ts:169`) и inline-shell (`packages/core/src/engine/commands/inline-shell.ts:39`) | MCP-реестр и политики ([ADR-071](./adr-071-mcp-servers-prompt.md)), конфигурация серверов | MCP stdio — это `spawn` с окружением; в исполнителе нужен свой реестр бинарей и своя доставка конфигурации |

**Что не уезжает ни в одной фазе:**

- **FS-роуты** (`createFsRoutes`) — HTTP-API работы с файлами проекта; это API, а не исполнение
  команды; backend остаётся точкой доступа.
- **Provisioning workspace** — владелец путей и политик — backend (ADR-075).
- **Git-реестр** (`project.repos`) — состояние проекта, а не исполнение.
- **Хранилище** — сессии/история/проекты ([ADR-096](./adr-096-storage-layer.md)).
- **LLM-вызовы** — через `GatewayProvider` (инвариант 3; ADR-036): в исполнителе LLM-ключей нет.
- **Permission-слой** — `plan`/`act`/`yolo`, allow/deny/ask (ADR-025/ADR-028/ADR-029): решение о
  допуске принимается **до** вызова порта, в backend'е.
- **MCP stdio на фазе 1** — остаётся в backend'е (исполнитель без собственного MCP-реестра).
- **Детект зависимостей** (ADR-078) — на фазе 1 детект остаётся локальным
  (`packages/core/src/engine/tools/runtime-deps.ts:77`); в split-режиме детект должен спрашивать
  исполнителя (перенос — вместе с фазой 1, иначе backend будет считать `git`/`rg` доступными там,
  где их нет).

## Изоляция, лимиты и квоты

| Механизм | Значение | Где применяется |
|---|---|---|
| CPU/memory limits | `executor.resources` (для worker'а) | pod worker'а (K8s) |
| Timeout вызова | `execution.remote.timeoutMs` (дефолт 30 с) + лимит тула | порт + исполнитель |
| Idle-timeout / max-lifetime | для динамических pod'ов (варианты (б)/(в)) | исполнитель / оператор |
| Лимит одновременных команд | `execution.remote.concurrency` (backend) + лимит на worker'а | backend + worker |
| Лимит вывода | 100 КБ (shell), 20 КБ (git), 200 строк (rg), `maxBuffer` 10 МБ | порт/исполнитель |
| `runAsNonRoot`, `allowPrivilegeEscalation: false` | как у backend'а (`charts/synth/values.yaml:116`, `:118`) | pod worker'а |
| seccomp / capabilities | дефолтный seccomp-профиль K8s, `capabilities.drop: [ALL]` | pod worker'а |
| **Без `docker.sock`** | docker socket в worker'е не монтируется **никогда** | pod worker'а |
| NetworkPolicy | дефолтно — ограниченный egress (только нужные адреса) | pod worker'а |
| Отсутствие секретов | в worker'е нет LLM-ключей/OIDC/провайдерских ключей | образ + монтирование |

**NetworkPolicy в чарте сейчас нет**: в `charts/synth/templates/` есть Deployment/Service/PVC/
ServiceAccount/ConfigMap/Ingress/ServiceMonitor/PrometheusRule/extraObjects, но **`Role`/`RoleBinding`
и `NetworkPolicy` отсутствуют**. `ResourceQuota`/`LimitRange` в чарте тоже нет. Это часть «Дельты».

## Наблюдаемость

Имена — по контракту [ADR-094](./adr-094-observability-metrics.md) (префикс `synth_` фиксирован,
лейблы из закрытого списка; `session_id`/`user_id`/сырые пути запрещены).

| Метрика | Тип | Лейблы | Где | Смысл |
|---|---|---|---|---|
| `synth_executor_queue_depth` | gauge | — | backend | Запросов в очереди на отправку исполнителю |
| `synth_executor_workers_busy` | gauge | — | backend | Занятых исполнителей (по pool'у) |
| `synth_executor_wait_seconds` | histogram | — | backend | Время ожидания в очереди (до отправки) |
| `synth_executor_commands_total` | counter | `outcome` | backend + исполнитель | Выполненных команд по исходу (`ok`/`error`/`timeout`/`cancelled`) |

- **Исполнитель отдаёт свой `/metrics`** — тем же реестром, что и backend
  (`packages/core/src/metrics/registry.ts:245`), тем же рендером 0.0.4
  (`packages/core/src/metrics/renderer.ts`), тем же middleware (`packages/core/src/metrics/http.ts`).
  Backend **агрегирует** метрики пула (gauge по пулу) и отдаёт свои; метрики исполнения с
  лейблом `outcome` агрегируются в счётчик backend'а, чтобы не было двойного счёта при скрейпе обоих
  эндпоинтов.
- **Формат и правила** — как у остальных: `/metrics` вне `/api/v2`, 404 при выключенном, 401 при
  токене, `no-store` (`packages/core/src/server/routes/metrics.ts:52`, `:56`, `:63`, `:82`).
  Существующие `synth_sessions_active`/`synth_queue_pending`
  (`packages/core/src/metrics/collectors/sessions.ts:26`, `:30`) — про сессии и очередь **сообщений**,
  не про исполнение; дублировать их нельзя.
- **Лимит серий** — 2000 на метрику, при переполнении `synth_metrics_series_dropped_total`
  (`packages/core/src/metrics/registry.ts:19`, `:27`). Лейблов у метрик выше — ноль или один, риск
  кардинальности отсутствует.
- **Health/ready.** У backend'а `GET /health` и `GET /ready`
  (`packages/core/src/server/routes/health.ts:63`, `:65`). В split-режиме **живость control plane и
  готовность пула разойдутся**: backend готов, когда готов сам (даже если пул пуст), а «исполнители
  недоступны» — отдельный сигнал (`synth_executor_workers_busy` + счётчик ошибок + алерт). Проба
  backend'а в чарте — `GET /health` для liveness и readiness
  (`charts/synth/values.yaml:103`, `:107`) — её **не** меняем: деградация БД — штатный сценарий
  (комментарий в `charts/synth/values.yaml:97`).

## Развёртывание: чарт, образы, CI

### Значения чарта (предлагаемые)

| Ключ | Смысл |
|---|---|
| `execution.mode` | `inline` \| `remote` (рендерится в `config.yaml` и/или env backend'а) |
| `execution.remote.url` | Адреса исполнителей (список) |
| `execution.remote.existingSecret` / `execution.remote.tokenKey` | Secret с токеном `synth_exec_…` и ключ внутри него |
| `execution.remote.timeoutMs` | Таймаут exec-вызова |
| `execution.remote.concurrency` | Лимит одновременных вызовов |
| `execution.remote.failMode` | `fail` \| `inline-fallback` |
| `executor.enabled` | Включить split-топологию (рендерит Deployment/Service worker'а) |
| `executor.image.repository` / `.tag` / `.pullPolicy` | Образ worker'а (`synth-executor`) |
| `executor.replicaCount` | Размер пула |
| `executor.resources` | limits/requests worker'а |
| `executor.workspace.claimName` / `.mountPath` | Общий том с workspace (PVC) + точка монтирования |
| `executor.podSecurityContext` / `executor.containerSecurityContext` | Изоляция (как у backend'а) |
| `executor.networkPolicy` | Ограниченный egress |

Токен — **только** из Secret (`secretKeyRef`), по образцу `SYNTH_POSTGRES_PASSWORD`
(`charts/synth/templates/backend-deployment.yaml:125`) и `SYNTH_METRICS_TOKEN`
(`charts/synth/templates/backend-deployment.yaml:113`); в ConfigMap/values — никаких значений
(инвариант 13).

### Образы

- `synth-backend` — control plane, **без** toolchain в split-режиме (сегодня образ и так его не
  содержит: `docker/Dockerfile.backend:48` — `FROM node:22-alpine`, `apk add` отсутствует).
- `synth-executor` — **новый** образ: toolchain + рантайм исполнителя. В репозитории его нет
  (`docker/Dockerfile`, `docker/Dockerfile.backend`, `docker/Dockerfile.ui` — три файла; нового
  Dockerfile'а исполнителя нет). Содержимое toolchain'а — пересечение с flavor'ами PROP-082
  (hard deps: `git`, `ripgrep`, `python3`, `openssh-client`, `ca-certificates`).
- **Один код — два режима:** образ исполнителя содержит тот же рантайм, что и inline-исполнитель в
  backend'е; различается только точка входа (слушает exec-API против вызова in-process).

### CI

- Сборка и публикация образов — kaniko в джобе `build-docker`
  (`.gitverse/workflows/release.yaml:321`): три отдельных шага на `synth`
  (`.gitverse/workflows/release.yaml:377`), `synth-backend` (`:392`) и `synth-ui` (`:407`),
  push в `gitverse.ru` + `ghcr.io`, `--push-retry=3` (`:389`, `:404`, `:419`).
- **Что нужно изменить:** добавить шаг на `synth-executor`; **registry-cache не включён** — при
  сборке образа с toolchain это критично (повторная установка пакетов на каждой сборке);
  **smoke-тестов образов нет** — для worker'а они обязательны (иначе сломанный toolchain едет в
  прод).
- **Квота реестра:** публикуются **только версионные теги** — на 0.9.0 вышло 607,4 МБ из лимита
  500 МБ (`.gitverse/workflows/release.yaml:308`). Четвёртый образ в тот же реестр — риск; worker'а
  имеет смысл публиковать в отдельный репозиторий (как flavor'ы в PROP-082) либо в Docker Hub.
- multi-arch: amd64 — kaniko, arm64 — buildx (`.gitverse/workflows/release.yaml:316`); Dockerfile'ы
  кросс-собираются без QEMU — в runtime-стадии нет ни одного `RUN` (например
  `docker/Dockerfile.backend:48` — `FROM node:22-alpine` сразу, вся подготовка в builder'е). Для
  worker'а с toolchain это ограничение сохраняется: **`apk add` в runtime-стадии сломает arm64-сборку
  без QEMU** — установку надо делать в builder-стадии (или принять QEMU).

## Миграция между топологиями

### all-in-one (`inline`) → split (`remote`)

1. **Подготовить хранилище.** Если состояние в JSON-файлах (`{dataDir}`) — перевести на PostgreSQL
   (`synth storage migrate --to postgres`, [PROP-032](./prop-032-history-storage-postgresql.md)):
   файловое хранилище не масштабируется на несколько реплик backend'а
   (`charts/synth/values.yaml:11`).
2. **Подготовить общий том workspace** с RWX-классом: текущий PVC — RWO
   (`charts/synth/values.yaml:45`), RWX-варианта в чарте нет. Данные workspace **не мигрируют** —
   том подключается к прежнему каталогу (тот же `project.workspace`).
3. **Собрать и опубликовать образ `synth-executor`**; задеплоить пул (Deployment + Service) с
   ограниченным egress и без `docker.sock`.
4. **Выпустить токен** `synth_exec_…` в Secret; backend'у — адреса исполнителей.
5. **Переключить режим:** `execution.mode=remote` (config.yaml/env/CLI) → **рестарт** backend'а
   (переключатель — параметр запуска; рестарт — через graceful shutdown с exit 75,
   `packages/core/src/server/restart.ts:23`).
6. **Проверить:** exec-вызовы идут в исполнитель (метрики `synth_executor_*`), файлы в workspace
   те же, git-тулы работают (фаза 2 — после включения), MCP stdio (фаза 3) — по плану.

**Обратимо:** да — возврат `execution.mode=inline` + рестарт возвращает исполнение в процесс
backend'а. Данные не затронуты (workspace — тот же том, состояние — та же БД).

### split (`remote`) → all-in-one (`inline`)

1. Остановить/смасштабировать в ноль пул worker'ов (или оставить — они просто простаивают).
2. `execution.mode=inline` → рестарт backend'а. Backend должен иметь toolchain в образе — то есть
   образ со **flavor'ом** (PROP-082), иначе `execute_shell`/`grep_files` в inline-режиме упрутся в
   детект зависимостей (ADR-078) и будут недоступны.

**Обратимо:** да. **Необратимо** на этом этапе — ничего: формат данных не меняется, миграции схемы не
нужны.

### Что необратимо

На текущем этапе — **ничего**. Обратимость ломается только если дойти до workspace-v2/объектного
хранилища (шаг 11): перенос workspace в объектное хранилище — миграция данных с обратной
совместимостью (нужен dual-read/dual-write или явная миграция проекта).

## Что уже есть

| Факт | Где |
|---|---|
| Исполнение — в процессе backend/core, общего шва нет: `sh -c` (`execute_shell`), `rg` (`grep_files`), `git` (argv), `simple-git`, MCP stdio `spawn` | `packages/core/src/engine/tools/shell.ts:45`, `packages/core/src/engine/tools/search.ts:49`, `packages/core/src/engine/tools/git.ts:30`, `packages/core/src/git/git-service.ts:132`, `packages/core/src/engine/mcp/client.ts:169` |
| `execute_shell`: таймаут 30 с, `maxBuffer` 10 МБ, `env: { ...process.env, HOME: … \|\| '/root' }` (наследует весь process.env) | `packages/core/src/engine/tools/shell.ts:14`, `:51`, `:52` |
| Обрезка вывода: 100 КБ (shell), 20 КБ (git), 200 строк (rg) | `packages/core/src/engine/tools/shell.ts:13`, `packages/core/src/engine/tools/git.ts:16`, `packages/core/src/engine/tools/search.ts:57` |
| `git`: argv-массив без shell, `mergedEnv = { ...process.env, ...env }`, containment `resolveRepoCwd` (симлинки) | `packages/core/src/engine/tools/git.ts:29`, `:30`, `:52` |
| `simple-git`: env санитизируется (`sanitizeGitEnv` вырезает `git*` и blocklist `EDITOR`/`PAGER`/`SSH_ASKPASS`…), `GIT_TERMINAL_PROMPT=0` | `packages/core/src/git/git-service.ts:81`, `:107`, `:148` |
| MCP stdio: `StdioClientTransport`; SDK мержит `getDefaultEnvironment()` (whitelist HOME/PATH) | `packages/core/src/engine/mcp/client.ts:159`, `:169` |
| Детект бинарников `git`/`rg`/`sh`: `probeBinary` → `execFileAsync(bin, ['--version'], { timeout: 3000 })`; ENOENT → `false`, прочие ошибки → `true` (**fail-open**); кэш модульного уровня | `packages/core/src/engine/tools/runtime-deps.ts:77`, `:79`, `:92` |
| Причины недоступности тула: `mode`/`role`/`dependency`/`workspace`/`storage`; порядок проверок storage→role→mode→dependency→workspace; `WORKSPACE_CAPABILITIES` | `packages/core/src/engine/permission/availability.ts:22`, `:28`, `:94`, `:147`, `:152` |
| При деградации хранилища доступны только `skill`/`web_fetch`/`web_search`, прочие — `unavailable(storage)` | `packages/core/src/engine/permission/availability.ts:54`, `:113` |
| Workspace: provisioning в backend'е — `resolveWorkspaceForLocalProject`, `validateManagedWorkspacePath`, `provisionManagedWorkspace` (атомарный `mkdir` без `recursive`), единая точка `provisionWorkspace` | `packages/core/src/engine/workspace-provision.ts:47`, `:109`, `:179`, `:207`, `:232` |
| `storage.workspacesRoot` и `defaultWorkspace` по умолчанию пустые | `packages/shared/src/config/defaults.ts:25`, `:26` |
| Образы: `node:22-alpine`, **ни одного `apk add`** → нет `git`/`rg`/`python`/`ssh`; в runtime-стадии standalone-образа нет ни одного `RUN`; `EXPOSE 4300`, `VOLUME ["/var/synth/data"]`; USER не задан (root) | `docker/Dockerfile:62`, `:91`, `:93`; `docker/Dockerfile.backend:48`; `docker/Dockerfile.ui:25`, `:41` |
| В образах backend'а/UI нет `EXPOSE`/`VOLUME`/`HEALTHCHECK`/`USER`; UI — nginx, root | `docker/Dockerfile.backend:48`, `:69`; `docker/Dockerfile.ui:25`, `:43` |
| CI: сборка образов kaniko (`gcr.io/kaniko-project/executor:v1.24.0`), три образа, push в `gitverse.ru` + `ghcr.io`, `--push-retry=3`; **registry-cache не включён**; **smoke-тестов нет** | `.gitverse/workflows/release.yaml:321`, `:378`, `:392`, `:407`, `:389` |
| Квота реестра: только версионные теги; на 0.9.0 вышло 607,4 МБ из 500 | `.gitverse/workflows/release.yaml:308` |
| Чарт: `backend.replicaCount: 1` («Хранилище JSON-файлы → НЕ масштабируется»), PVC `data` → `/var/synth/data`, `accessMode: ReadWriteOnce`, RWX-варианта нет | `charts/synth/values.yaml:16`, `:11`, `:45`; `charts/synth/templates/backend-deployment.yaml:134`; `charts/synth/templates/backend-pvc.yaml:16` |
| В чарте **нет** `Role`/`RoleBinding`, `NetworkPolicy`, `ResourceQuota` — есть только ServiceAccount'ы | `charts/synth/templates/serviceaccount.yaml:1` |
| Probes backend'а — оба `GET /health` (не `/ready`): деградация БД — штатный сценарий | `charts/synth/values.yaml:103`, `:107`, `:97` |
| `runAsUser: 1000`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`; UI — `fsGroup: 101` | `charts/synth/values.yaml:113`, `:115`, `:118`; `:347` |
| Секреты в чарте — только из Secret (`SYNTH_POSTGRES_PASSWORD`, `SYNTH_METRICS_TOKEN`, `SYNTH_BOOTSTRAP_SERVICE_KEYS`, `SYNTH_API_KEY`), в ConfigMap/values — никаких значений | `charts/synth/templates/backend-deployment.yaml:79`, `:100`, `:113`, `:125` |
| Наблюдаемость: реестр с лимитом 2000 серий, рендер 0.0.4, `/metrics` (404/401/`no-store`), `/health` + `/ready`; метрик **очереди/занятости исполнителей нет** | `packages/core/src/metrics/registry.ts:19`, `:27`; `packages/core/src/server/routes/metrics.ts:52`, `:56`, `:63`, `:82`; `packages/core/src/server/routes/health.ts:63`, `:65` |
| `synth_sessions_active` / `synth_queue_pending` — про сессии и очередь **сообщений**, не про исполнение | `packages/core/src/metrics/collectors/sessions.ts:26`, `:30` |
| Секция `execution`, порт `ExecutionPort`, env `SYNTH_EXECUTION_*`, CLI `--execution-mode`, токен `synth_exec_…`, метрики `synth_executor_*`, образ `synth-executor` — **нет в репозитории** | — |
| Слой хранения — образец портов: 30 доменных портов, контрактный suite, `createFileStorage`/`createMemoryStorage`/`createPostgresStorage`/`createStorageContextAsync`/`buildStorageContext` | `packages/core/src/storage/ports/`, `packages/core/src/storage/contract/index.ts:1`, `packages/core/src/storage/storage-context.ts:467`, `:529`, `:599`, `:847`, `:917` |
| Ограничения >1 реплики: файловая БД не масштабируется; RWO PVC; `FileMutex` (эксклюзивный `mkdir` + stale-takeover) работает только на общем FS; `scheduler.leaderElection: none`, `crossProcessLocks: false` (в PG — `PgMutex`/`PgLeader`) | `charts/synth/values.yaml:11`, `:45`; `packages/core/src/storage/file-mutex.ts:33`, `:48`; `packages/core/src/storage/mutex.ts:7`; `packages/shared/src/config/defaults.ts:155` |
| Рестарт инстанса — graceful shutdown с exit code 75, режимы `disabled`/`process`/`supervisor` | `packages/core/src/server/restart.ts:20`, `:23`; `packages/core/src/main.ts:81` |
| Общий транспорт исходящих вызовов — `egressFetch` (ADR-099): единый источник доверия TLS/CA | `packages/core/src/security/tls.ts:302` |
| Формат service-key: `synth_svc_…` (префикс константой) — образец для токена исполнителя | `packages/core/src/storage/service-api-key-store.ts:19` |
| Локальные режимы: `dev.sh` — `SYNTH_RESTART_MODE=supervisor`, `SYNTH_DATA_DIR`, порты 5000/4300/5002, `SYNTH_CONFIG=packages/backend/config.yaml`; `standalone.sh` — порт 4400, host 127.0.0.1 | `scripts/dev.sh:30`, `:39`, `:46`, `:50`; `scripts/standalone.sh:74` |
| `docker-compose.yml` — только standalone-образ `synth` (+ профили `ollama`, `postgres`); backend и UI в compose не разведены | `docker-compose.yml:21`, `:91`, `:114` |
| S3/объектного хранилища нет | — |
| Корневого `config.yaml` в репозитории нет; есть `packages/backend/config.yaml` (18 строк: `mcp.servers`, `llm.default*`, `storage.backend: postgres`, `storage.degradedMode: halt`) | `packages/backend/config.yaml:1` |

## Дельта

1. **Порт исполнения** в core: `ExecutionPort` / `ExecRequest` / `ExecResult`, реализации
   `InlineExecutionPort` и `RemoteExecutionPort`; контрактный suite на обе (по образцу
   `packages/core/src/storage/contract/index.ts:1`).
2. **Рефакторинг 5+ точек исполнения** на порт без изменения поведения: `shell.ts:45`,
   `search.ts:49`, `git.ts:30`, `inline-shell.ts:39`, `runtime-deps.ts:79`.
3. **Секция `execution` в конфиге** (`packages/shared/src/config/types.ts` + `defaults.ts` +
   `env-overrides.ts`): `mode`, `remote.url`, `remote.timeoutMs`, `remote.concurrency`,
   `remote.failMode`, `remote.tokenSecret`; env `SYNTH_EXECUTION_*`; CLI `--execution-mode`;
   fail-closed на неизвестном `mode`.
4. **Executor-сервис**: отдельный пакет/процесс с exec-API (HTTP), тем же рантаймом, что и inline;
   клиент `RemoteExecutionPort` — через `egressFetch` (ADR-099), bearer `synth_exec_…`, опционально
   mTLS.
5. **Токен исполнителя**: формат `synth_exec_…`, хранение — Secret/файл (инвариант 13), выдача —
   через существующий контур секретов; в UI — write-only (по образцу `SYNTH_METRICS_TOKEN`).
6. **Образ `synth-executor`**: новый Dockerfile с toolchain'ом (пересечение с flavor'ами PROP-082);
   arm64-сборка без QEMU (установка пакетов — в builder-стадии).
7. **CI**: шаг сборки `synth-executor`, registry-cache, smoke-тест образа worker'а; решение по
   реестру (квота 500 МБ) — отдельный репозиторий или Docker Hub.
8. **Чарт**: значения `execution.*` и `executor.*`; шаблоны `executor-deployment.yaml`,
   `executor-service.yaml`, PVC общего workspace (RWX), `NetworkPolicy` для worker'а, токен из
   Secret; `executor.enabled` — переключатель split-развёртывания.
9. **Наблюдаемость**: метрики `synth_executor_queue_depth`, `synth_executor_workers_busy`,
   `synth_executor_wait_seconds`, `synth_executor_commands_total{outcome}`; `/metrics` исполнителя;
   агрегация на backend'е; алерты в `charts/synth/files/alerts/`.
10. **Детект зависимостей (ADR-078)** в split-режиме — спрашивать исполнителя, а не локальный
    `execFile` (иначе backend считает `git`/`rg` доступными там, где их нет).
11. **Миграции**: `synth storage migrate --to postgres` (уже есть) + процедура переключения
    топологии в `docs/MAINTENANCE.md`; миграции схемы БД для порта исполнения не требуются (состояние
    исполнителя эфемерно).
12. **Документация**: `docs/CONFIGURATION.md` (секция `execution`), `docs/API_V2.md` (если exec-API
    станет публичным — не планируется), `docs/OBSERVABILITY.md` (новые метрики), `charts/synth/README.md`
    (примеры split-развёртывания), `docs/TROUBLESHOOTING.md` (исполнитель недоступен).

## Открытые вопросы

**Закрыто решениями выше** (не открытые):

- Переключатель топологий — закрыт: `execution.mode`, параметр запуска, дефолт `inline`.
- Способ размещения в K8s — закрыт: статический пул Deployment + очередь в backend (вариант (а));
  (б) и (в) — эволюция.
- Матрица «что уезжает» по фазам — закрыта (1: shell/rg/python; 2: git+SSH; 3: MCP stdio/inline-shell);
  FS-роуты, provisioning, git-реестр, хранение, LLM-вызовы, permission-слой — не уезжают.
- Поведение при недоступности исполнителя — закрыто: `failMode: fail` (fail-closed) по умолчанию;
  `inline-fallback` — только явной настройкой.

**Реально открытые:**

- **Доставка расшифрованного SSH-материала в исполнитель** (фаза 2). Ключи per-agent шифрованы
  at-rest (`enc:v1:…`, AES-256-GCM) в `{dataDir}/secrets/ssh-keys/`
  (`packages/core/src/storage/ssh-key-store.ts:15`, `:71`), мастер-ключ — `{dataDir}/secrets/master.key`
  (`packages/core/src/security/crypto.ts:113`); исполнитель
  такого ключа не имеет. Варианты: одноразовый токен на операцию; расшифровка на стороне backend'а и
  передача «используемого» `GIT_SSH_COMMAND` с временным файлом ключа; проброс мастер-ключа в
  исполнитель (нежелательно — расширяет круг доверия). Требует отдельного AD по границе доверия.
- **Per-worker workspace против общего.** Общий том (RWX) — просто, но даёт всем исполнителям доступ
  ко всем workspace'ам проектов (ограничение — «исполнитель не видит чужих workspace» перестаёт
  работать на уровне тома; остаётся на уровне `cwd`). Per-worker копия — изоляция, но рассинхрон и
  стоимость. Связано с workspace-v2/объектным хранилищем (шаг 11).
- **HA пула.** Статический пул: что происходит при недоступности **всех** worker'ов (fail-closed →
  инструменты недоступны)? Нужен ли circuit breaker с автоматическим переходом в `inline-fallback`?
  Сейчас переход только явной настройкой — это осознанно (fail-closed), но требует runbook'а.
- **Образ worker'а: отдельный или общий с backend'ом.** Отдельный (`synth-executor`) даёт чистое
  разделение секретов и меньший образ control plane; общий (один образ, разные роли через env) —
  проще CI и не нужен четвёртый образ в реестре (квота 500 МБ). Нужно решение до шага 5 (образ
  worker'а `synth-executor:<v>-<flavor>`).
- **Взаимодействие с PROP-097** (реестр фоновых процессов). `execute_shell { background: true }` и
  пул исполнителей — один и тот же механизм исполнения; реестр процессов должен быть общим (иначе
  фоновая команда «уедет» в worker'а, а UI-реестр останется в backend'е).
- **Стоимость и квоты.** Кто платит за worker'ов (node pool, диск под workspace, квоты namespace)?
  Нужны ли `ResourceQuota`/`LimitRange` в namespace'е и кто их администрирует.
- **Отмена exec-вызовов при рестарте backend'а.** Сейчас вызовы обрываются; нужен ли endpoint отмены
  на исполнителе, чтобы команда не «работала вхолостую» после рестарта control plane.
- **Секьюрность multi-tenancy пула.** Если пул общий для нескольких проектов/пользователей — нужен
  ли per-tenant лимит и учёт в метриках (лейблы `tenant`/`project` в ADR-094 **запрещены** для
  session_id/user_id — как считать квоты без лейблов).

## Зависимости

- **PROP-082** — all-in-one образ с toolchain (ближайший шаг; flavor'ы). Исполнитель и inline-рантайм
  — **один код**; образ worker'а переиспользует состав toolchain'а из PROP-082.
- **PROP-032** — PostgreSQL: **предпосылка** для нескольких реплик backend'а в split-режиме
  (файловая БД не масштабируется, `charts/synth/values.yaml:11`). Обязательна для масштабирования
  control plane (шаг 7+ — executor-сервис), не нужна для шагов 1–6 (порт, образы, секция
  `execution`).
- **ADR-096 / ADR-097** — образец портов и контрактного suite для порта исполнения.
- **ADR-092** — graceful restart (exit 75) и режимы рестарта: параметр запуска, не runtime.
- **ADR-094** — контракт имён метрик и правила экспорта.
- **ADR-099** — единый egress-слой: TLS/CA, прокси, per-host mapping для адреса исполнителя.
- **ADR-052** — образец машинных ключей (`synth_svc_…`) для токена `synth_exec_…`.
- **ADR-075** — workspace: provisioning, `workspaceOutsideRoot`, managed-пути.
- **ADR-076** — git-реестр и SSH-ключи (доставка материала в исполнителя, фаза 2).
- **ADR-078** — детект внешних зависимостей: в split-режиме источник детекта — исполнитель.
- **ADR-022** — stateless-движки (Runner) — концептуальная база отдельного исполняющего сервиса;
  прецедент — [PROP-050](./prop-050-external-engines-runner.md).
- **ADR-036** — LLM Gateway: в исполнителе LLM-ключей нет; границы обфускации/аудита сохраняются.
- **ADR-038** — сборка/публикация образов и пакетов (npm/Docker/Helm).
- **PROP-097** — реестр фоновых процессов: общий механизм исполнения (открытый вопрос выше).
- **PROP-049** — git worktrees: per-session cwd — естественный кандидат на будущую «выделенную
  рабочую копию на исполнителя».
- **PROP-080 / PROP-081** — гибрид: режимы-полюса и политики утечек (где исполняется local vs managed).

## Связи

- [PROP-082](./prop-082-full-images-deployment.md) «Full-образы и базовое развёртывание (flavor'ы с toolchain)» — all-in-one топология и состав образов.
- [PROP-032](./prop-032-history-storage-postgresql.md) «Второй вариант хранения — БД (PostgreSQL) за единым слоем» — предпосылка масштабирования control plane.
- [PROP-050](./prop-050-external-engines-runner.md) «Внешние движки (opencode/cline) — Runner» — прецедент отдельного исполняющего сервиса.
- [PROP-097](./prop-097-background-processes-registry.md) «Фоновые процессы — реестр и контроль через UI» — общий реестр фоновых процессов.
- [PROP-049](./prop-049-git-worktrees.md) «Git worktrees» — персональный cwd как будущая единица работы на исполнителя.
- [PROP-080](./prop-080-managed-hybrid-modes.md) «Управляемый гибрид: режимы-полюса, идентичность и установка локально» — прецедент «режим — параметр запуска».
- [ADR-023](./adr-023-configuration.md) «Конфигурация» — приоритет CLI > env > config.yaml > defaults.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway — независимый слой безопасности» — в исполнителе LLM-ключей нет.
- [ADR-038](./adr-038-npm-packages.md) «Монорепо как набор публикуемых npm-пакетов» — сборка/публикация.
- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог (создание и выбор)» — provisioning остаётся в backend'е.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и доступ (SSH)» — фаза 2 и доставка SSH-материала.
- [ADR-078](./adr-078-runtime-dependency-availability.md) «Авто-отключение инструментов при отсутствии внешней зависимости» — детект на стороне исполнителя.
- [ADR-092](./adr-092-instance-lifecycle-maintenance.md) «Обслуживание инстанса — версия схемы данных, миграции и удаление» — рестарт (exit 75), режимы рестарта.
- [ADR-094](./adr-094-observability-metrics.md) «Наблюдаемость — Prometheus-метрики, liveness/readiness и эксплуатационные алерты» — контракт имён метрик.
- [ADR-096](./adr-096-storage-layer.md) «Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами» — образец порта.
- [ADR-097](./adr-097-storage-provider-class.md) «Класс расширения «хранилище» (storage)» — образец контрактного suite.
- [ADR-099](./adr-099-egress-tls-trust.md) «Единый egress-слой — доверие TLS/CA (mTLS), адресная политика и прокси» — доверие к исполнителю.
- [docs/CONFIGURATION.md](../CONFIGURATION.md) — конфигурация (сюда попадёт секция `execution`).
- [docs/OBSERVABILITY.md](../OBSERVABILITY.md) — каталог метрик (сюда попадут `synth_executor_*`).
- [docs/PUBLISHING.md](../PUBLISHING.md) — сборка Docker/Helm.
- [docs/MAINTENANCE.md](../MAINTENANCE.md) — runbook (сюда попадёт процедура переключения топологии).

## Порядок реализации

План **общий с [PROP-082](./prop-082-full-images-deployment.md)** — нумерация шагов единая; владелец шага указан в таблице.

| Шаг | Содержание | Владелец | Зависимость от PostgreSQL (PROP-032) |
|---|---|---|---|
| **1** | Порт исполнения `ExecutionPort` + `InlineExecutionPort`: вынести 5+ точек исполнения за порт **без изменения поведения**; контрактный suite | общий | не нужна |
| **2** | Multistage Dockerfile + distro-aware скрипты тиров + flavor `core` → all-in-one образ `synth-backend:<v>-core` | PROP-082 | не нужна |
| **3** | Секция `execution` в конфиге (`mode`, `remote.*`), env `SYNTH_EXECUTION_*`, CLI `--execution-mode`, fail-closed на неизвестном `mode` | общий | не нужна |
| **4** | Flavor'ы `dev`/`devops` (alpine-ветка) | PROP-082 | не нужна |
| **5** | Flavor'ы `browser`/`full` (debian-ветка, Playwright) + образ worker'а `synth-executor:<v>-<flavor>` | PROP-082 | не нужна |
| **6** | CI: публикация (лёгкие образы — `gitverse.ru`/`ghcr.io`, тяжёлые — Docker Hub), registry-cache, smoke-тесты на каждый flavor, `scripts/docker-cleanup.mjs` под новые репозитории | PROP-082 | не нужна |
| **7** | Executor-сервис: exec-API, `RemoteExecutionPort`, токен `synth_exec_…`, чарт `executor.*` (Deployment/Service/пул), **фаза 1** матрицы (`execute_shell`/`grep_files`/`python`) | PROP-077 | нужна для >1 реплики control plane; при 1 реплике — нет |
| **8** | **Фаза 2** матрицы: git-тулы + доставка SSH-материала в исполнителя | PROP-077 | не нужна |
| **9** | **Фаза 3** матрицы: MCP stdio-серверы и inline-shell | PROP-077 | не нужна |
| **10** | Изоляция и квоты (`NetworkPolicy`, `ResourceQuota`/`LimitRange`, лимиты worker'а, без `docker.sock`); наблюдаемость: метрики `synth_executor_*`, `/metrics` исполнителя, алерты; детект зависимостей (ADR-078) на стороне исполнителя | PROP-077 | не нужна |
| **11** | Workspace-v2: per-worker копия или S3-совместимое объектное хранилище (снимает «один RWX-том на всех») | PROP-077 | желательна |
| **12** | Миграции и документация: переключение топологии (runbook — `docs/MAINTENANCE.md`), секция `execution` в `docs/CONFIGURATION.md`, метрики в `docs/OBSERVABILITY.md`, примеры в `charts/synth/README.md`, диагностика в `docs/TROUBLESHOOTING.md`; compose-сценарии all-in-one/split | общий | не нужна |

Шаги 1–3 и 6 не требуют PostgreSQL и могут идти до перехода на БД; шаг 7 — первый, где PG нужна для полного эффекта (несколько реплик control plane); шаги 1, 2, 3, 4, 5, 6, 10, 12 от PG не зависят.

Split-топология технически возможна и при одной реплике control plane (пул worker'ов масштабируется независимо); PostgreSQL обязателен для масштабирования самого control plane — больше одной реплики.

## История

- 2026-10-21 — переработано: split-топология (control plane + отдельные контейнеры-исполнители) как предмет PROP-077, единый переключатель `execution.mode`, порт `ExecutionPort`, all-in-one вынесен в PROP-082.
