# ADR-077: Инструментальное окружение исполнения — единый порт ExecutionPort и режим remote

> **Статус:** ⚠️ Частично — реализованы порт `ExecutionPort` с реализациями inline/remote, выбор режима через `execution.mode`, динамический `import()` пакета `@itphx/synth-executor/client`, fail-closed проверка на старте и чарт split-развёртывания (значения `execution.*`/`executor.*`, шаблоны `executor-*.yaml`, общий том workspace, `NetworkPolicy` пула); остаток — метрики `synth_executor_*` и runbook (шаг 7d), перенос `simple-git` и MCP-stdio в исполнитель (шаги 8–9) и правка `packages/core/AGENTS.md` под порт.
> **Дата:** 2026-10-21
> **Связано:** [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) (образец портов и контрактного suite), [ADR-099](./adr-099-egress-tls-trust.md) (доверенная граница и исходящий транспорт), [ADR-092](./adr-092-instance-lifecycle-maintenance.md) (рестарт, exit 75), [ADR-094](./adr-094-observability-metrics.md) (метрики), [ADR-075](./adr-075-project-workspace-provisioning.md) (workspace), [ADR-076](./adr-076-git-repo-registry-ssh.md) (git-реестр и SSH), [ADR-078](./adr-078-runtime-dependency-availability.md) (детект зависимостей), [ADR-036](./adr-036-llm-gateway.md) (в исполнителе LLM-ключей нет), [ADR-038](./adr-038-npm-packages.md) (поставка пакета); детали и формат — [docs/EXECUTION.md](../EXECUTION.md) (Spec).

## Контекст

Агентские команды исполнялись прямо в процессе backend'а: `sh -c` (`execute_shell`), `rg` (`grep_files`), `git` (argv), `simple-git`, `spawn` MCP-stdio. Шва не было — у каждой точки исполнения своя реализация, поэтому «вынести toolchain в отдельный контейнер» означало бы переписывать точки исполнения по одной. Control plane и инструментальное окружение были сварены в один процесс: образ без toolchain'а не мог исполнять shell, а образ с toolchain'ом нёс в control plane лишние секреты и поверхность.

Нужен был шов уровня порта (как порты слоя хранения) и решение, где живёт исполнитель. Решение не могло быть runtime-настройкой: смена режима затрагивает process-глобальные решения (инвариант 24 корневого `AGENTS.md`).

## Решение

1. **Единый порт исполнения `ExecutionPort`** (`packages/core/src/execution/ports/execution-port.ts`) — одна
   точка исполнения агентских команд: `execute(req: ExecRequest): Promise<ExecResult>`. Запрос — дискриминированный
   union (`shell` — `sh -c <команда>`; `argv` — бинарник без shell), ошибка — типизированная
   `ExecutionError` (`reason`: `timeout`/`aborted`/`spawn_failed`/`nonzero_exit`/`max_output`), лимит буфера —
   `DEFAULT_MAX_OUTPUT_BYTES` (10 МБ).
2. **Две взаимозаменяемые реализации.** `InlineExecutionPort` — исполнение в процессе control plane (прежнее
   поведение). Удалённая — HTTP/1.1 + JSON к исполнителю: exec-API `/exec`, `/capabilities`, `/health`,
   протокол `EXECUTOR_PROTOCOL_VERSION = 1`, bearer-токен `synth_exec_…` **из файла** (`execution.remote.tokenSecret`
   — путь, не значение; инвариант 13). Исполнитель поставляется отдельным in-tree пакетом
   `@itphx/synth-executor` (`packages/executor`), который core подключает **динамическим `import()`**
   (`@itphx/synth-executor/client`) — по образцу драйвера хранилища (ADR-097).
3. **Выбор реализации — параметр запуска `execution.mode`** (`inline` — дефолт, `remote` — split). Топология —
   один параметр, а не runtime-настройка: смена — только рестартом процесса (ADR-092, инвариант 24).
4. **Fail-closed.** Запрошен `remote`, а пакет исполнителя недоступен / токен не читается / список адресов пуст —
   **старт прерывается**, а не тихий откат в `inline`: тихий откат означал бы, что оператор запросил изоляцию
   control plane от toolchain'а, а получил локальное исполнение.
5. **Доверенная граница backend → исполнитель** — по ADR-099: исходящие вызовы через общий транспорт
   (`egressFetch`), TLS/CA — из секции `security.tls`, containment `cwd` проверяет **исполнитель**, в исполнителе
   нет LLM-ключей, OIDC-секретов и чужих workspace.
6. **Шов внедрения** — `ctx.extra.executionPort` (`packages/core/src/execution/tool-port.ts`): порт кладёт
   оркестратор, тулы и не-туловые точки (резолвер проектных инструкций, детект зависимостей, inline-shell) берут
   **тот же** порт через композицию.
7. **Несколько реплик control plane — sticky-сессии как текущий компромисс.** Шина событий Synth —
   **in-process** (`packages/core/src/events/bus.ts`): событие, опубликованное в реплике A, не доходит
   до WS/SSE-клиента, подключённого к реплике B, поэтому при `backend.replicaCount > 1` чат и стримы
   ломаются. Дёшевое лечение — прибить клиента к реплике: `sessionAffinity: ClientIP` на Service
   control plane (`backend.service.sessionAffinity` в чарте). Это компромисс: sticky по IP делит под
   между пользователями за одним NAT и перебрасывает клиента при смене IP. Полноценное решение —
   **внешний транспорт событий** (общая шина между репликами вместо in-process) — отдельная задача;
   sticky-сессии её не заменяют, а лишь делают multireplica control plane безопасным на текущем этапе.

## Альтернативы

- **Исполнение в процессе, без порта** — отклонено: перенос toolchain'а в отдельный контейнер без порта означал бы
  переписывание каждой точки исполнения; разные реализации разошлись бы по семантике.
- **Runtime-переключатель топологии** — отклонено: process-глобальные решения (TLS-диспетчер, пул PG, MCP, шедулер)
  на лету не переинициализируются (инвариант 24); режим — параметр запуска.
- **Тихий откат в inline при недоступности исполнителя** — отклонено: оператор, запросивший split, получил бы
  исполнение в control plane (с его toolchain'ом и секретами) — ровно то, чего split-топология исключает.
- **gRPC/другой транспорт для exec-API** — отклонено: HTTP/1.1 + JSON — тот же стек, что весь Synth, без новых
  зависимостей.
- **Отдельный процесс на сессию (Job) или CRD-оператор** — отклонено на первой версии: требует RBAC-эскалации
  control plane и собственного release-цикла; эволюция — статический пул + очередь в backend.

## Последствия

- **Плюсы:** у точки исполнения один контракт и один контрактный suite; split-топология (тонкий control plane +
  отдельные исполнители) стала возможной без переписывания домена; в исполнителе нет LLM-ключей и OIDC-секретов.
- **Минусы:** ещё один порт и ещё один optional-пакет в сборке; удалённый режим добавляет сетевой отказ и
  round-trip к каждой команде; `simple-git` и MCP-stdio пока остаются в control plane (фазы 2–3).
- **Следствия:** образы разводятся по режиму (`synth-backend` — control plane, `synth-executor` — worker);
  `execution.*` — секция конфигурации, применяемая при старте; наблюдаемость исполнителя — отдельный `/metrics`
  (ADR-094).

## Статус в коде

- **Порт и контракт:** `packages/core/src/execution/ports/execution-port.ts` (`ExecutionPort`, `ExecRequest`,
  `ExecResult`, `ExecutionError`, `DEFAULT_MAX_OUTPUT_BYTES`), `ports/index.ts`; контрактный suite —
  `packages/core/src/execution/contract/execution.ts` (+ `contract/index.ts`), прогон против живого исполнителя —
  `contract/remote.test.ts`.
- **Реализации:** `packages/core/src/execution/inline-execution-port.ts` (в процессе) и удалённая —
  `packages/core/src/execution/remote.ts` (динамический `import()` `@itphx/synth-executor/client`, fail-closed,
  чтение токена из файла) + пакет `packages/executor/` (`protocol.ts` — `EXECUTOR_PROTOCOL_VERSION = 1`,
  `client.ts` — `RemoteExecutionPort`, `server.ts`, `exec-service.ts`, `auth.ts`, `workspace.ts` — containment `cwd`,
  `toolchain.ts`, `config.ts`, `main.ts`).
- **Выбор режима и шов:** `packages/core/src/execution/factory.ts` (`createExecutionPortForConfig`),
  `packages/core/src/execution/startup.ts` (`checkExecutionMode`/`assertExecutionModeSupported` — fail-closed),
  `packages/core/src/execution/tool-port.ts` (`resolveExecutionPort(ctx)` → `ctx.extra.executionPort`).
- **Конфигурация:** `execution.mode` / `execution.remote.*` — `packages/shared/src/config/types.ts`,
  `defaults.ts`, `execution.ts` (резолвер), env `SYNTH_EXECUTION_*`, CLI `--execution-mode`.
- **Потребители:** `packages/core/src/engine/tools/git.ts` (исполнение через порт), `engine/tools/shell.ts`,
  `engine/tools/search.ts`, `engine/commands/inline-shell.ts`, `engine/tools/runtime-deps.ts`.
- **Чарт split-развёртывания (шаг 7c):** `charts/synth/values.yaml` (`execution.*`, `executor.*`), шаблоны
  `charts/synth/templates/executor-deployment.yaml`, `executor-service.yaml`, `executor-pvc.yaml`
  (общий том workspace, RWX), `executor-networkpolicy.yaml` (ingress — только от pod'ов control plane,
  egress — по умолчанию только DNS), `executor-networkpolicy`/`executor.serviceaccount` — в шаблоне чарта;
  токен — из Secret (backend получает **файлом**, worker — **значением** в env), fail-closed проверки
  рендера (неизвестный `mode`/`failMode`, отсутствие адреса, `executor.enabled` без workspace,
  accessMode ≠ RWX); при `executor.enabled: false` рендер чарта побайтово не меняется.
- **Sticky-сессии control plane (подготовка к мультирепличности):** `charts/synth/values.yaml`
  (`backend.service.sessionAffinity` — `None` по умолчанию), шаблон
  `charts/synth/templates/backend-service.yaml` (поле рендерится только для значения, отличного от
  `None`, — дефолтный манифест Service не меняется побайтово); подробности и оговорки — README чарта
  («Sticky-сессии при нескольких репликах backend»).
- **Остаток:** метрики `synth_executor_*` и runbook переключения топологии (шаг 7d), перенос `simple-git`
  и MCP-stdio в исполнитель (шаги 8–9, фазы 2–3 матрицы), правка `packages/core/AGENTS.md` под порт
  исполнения.

## Связи

- [ADR-096](./adr-096-storage-layer.md) / [ADR-097](./adr-097-storage-provider-class.md) — образец доменного порта,
  контрактного suite и optional-пакета с динамическим `import()`.
- [ADR-099](./adr-099-egress-tls-trust.md) — единый egress-слой: доверие TLS/CA, исходящий транспорт, адресная политика.
- [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — рестарт инстанса (exit 75), параметр запуска, а не runtime.
- [ADR-094](./adr-094-observability-metrics.md) — контракт имён метрик (`synth_executor_*`) и liveness/readiness.
- [ADR-075](./adr-075-project-workspace-provisioning.md) — provisioning остаётся в backend'е; общий том workspace в split-режиме.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) — git-реестр и SSH-материал (фаза 2 — доставка в исполнителя).
- [ADR-078](./adr-078-runtime-dependency-availability.md) — детект внешних зависимостей: в split-режиме источник — исполнитель.
- [ADR-036](./adr-036-llm-gateway.md) — в исполнителе LLM-ключей нет; границы обфускации/аудита сохраняются.
- [ADR-038](./adr-038-npm-packages.md) — поставка пакета `@itphx/synth-executor` в npm.
- [docs/EXECUTION.md](../EXECUTION.md) — Spec: топологии, контракт порта, exec-API, развёртывание, миграция.

## История

- 2026-10-21 — переработано в split-топологию (control plane + отдельные контейнеры-исполнители), единый
  переключатель `execution.mode`, порт `ExecutionPort`, упаковка исполнителя — отдельный in-tree пакет
  `@itphx/synth-executor` по образцу слоя хранения, транспорт — HTTP/1.1 + JSON.
- 2026-10-21 — шаг 1: порт исполнения реализован (union shell/argv, типизированная `ExecutionError`,
  inline-реализация + контрактный suite); шаг 3: секция `execution` в конфиге, fail-closed на неизвестном
  `mode`; шаги 7a–7b: пакет исполнителя (exec-API `/exec`/`/capabilities`/`/health`, containment `cwd`) и
  подключение по `execution.mode=remote` (динамический `import()`, чтение токена из файла, стартовая
  проверка режима).
- 2026-10-22 — шаг 7c: чарт split-развёртывания (значения `execution.*`/`executor.*`, шаблоны
  `executor-*.yaml`, RWX-том workspace в backend и в пуле, `NetworkPolicy` пула, токен из Secret —
  backend файлом, worker значением, fail-closed проверки рендера); предложение повышено до ADR, детали
  вынесены в [docs/EXECUTION.md](../EXECUTION.md) (Spec).
