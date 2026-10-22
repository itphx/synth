# ADR-077: Инструментальное окружение исполнения — единый порт ExecutionPort и режим remote

> **Статус:** ⚠️ Частично — реализованы порт `ExecutionPort` с реализациями inline/remote, выбор режима через `execution.mode`, динамический `import()` пакета `@itphx/synth-executor/client`, fail-closed проверка на старте, чарт split-развёртывания (значения `execution.*`/`executor.*`, шаблоны `executor-*.yaml`, общий том workspace, `NetworkPolicy` пула) и **шаг A** — доступность инструментов в remote-режиме определяется составом пула исполнителей (инвентарь `GET /capabilities`, `ExecRequest.requires`, `probe()` у порта, причина `dependency_missing`); остаток — метрики `synth_executor_*` и runbook (шаг 7d) и перенос `simple-git` и MCP-stdio в исполнитель (шаги 8–9).
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
8. **Доступность инструмента в remote-режиме определяется составом пула (шаг A).** «Есть ли программа»
   — вопрос не про control plane, а про то окружение, где команда будет выполнена. Поэтому:
   - **Порт** получил необязательные `probe(bin, args?)` и `capabilitySummary(bin)`, а запрос —
     `requires?: string[]` — бинарные требования команды. Словарь базовых возможностей — общий для обеих
     сторон: `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`) в core; исполнитель отдаёт **тот же**
     словарь в `GET /capabilities`.
   - **Инвентарь пула** — карта «адрес → множество программ», собранная удалённым портом по
     `GET /capabilities` **всех** адресов (TTL `REMOTE_CAPABILITIES_TTL_MS = 120_000`, обновление
     **ленивое** — перед пробой/маршрутизацией, если снимок просрочен).
   - **Маршрутизация по требованиям:** команда с `requires` уходит в адрес, чей инвентарь покрывает все
     требуемые бинари. Адрес **без** нужного бинаря и адрес, **не ответивший** на `/capabilities`, в
     маршрутизации не участвуют (состав неизвестен — fail-closed); подходящего адреса нет —
     различимая ошибка `dependency_missing` (`EDEPENDENCY`) с текстом «в пуле: N из M».
   - **Слой доступности (ADR-078) спрашивает порт**, а не пробует локально: `probe()` отвечает по
     инвентарю пула. Порт без `probe` (inline) проверяется локальной пробой `bin --version` —
     `packages/core/src/execution/probe.ts`, **единственная** реализация пробы: `ENOENT` → программы нет,
     прочие ошибки → fail-open (неоднозначная ошибка не блокирует инструмент).
   - **Кэш детекции — по экземпляру порта** (`WeakMap`): локальная (inline) проба больше не отравляет
     remote-кэш — иначе control plane считал бы доступным бинарь, которого нет ни у одного исполнителя.
   - **Inline-режим не изменился**: те же локальная проба и дефолты, порт игнорирует `requires`.

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
- **Операционные следствия шага A (доступность по составу пула):**
  - **(а) Состав пула известен только из `/capabilities`** ⇒ control plane и исполнитель обязаны быть
    **одной версии протокола**: инвентарь приходит от исполнителя, а не вычисляется на стороне control
    plane. При rolling update возможно окно, когда старый исполнитель ещё не знает `sh` (словарь
    базовых возможностей расширен) и не может обслужить `execute_shell` — команда уйдёт в другой адрес
    или вернёт `dependency_missing`. Обновление пула ⇒ обновление control plane (или наоборот).
  - **(б) Fail-open при недоступном инвентаре, fail-closed в маршрутизации.** Если **ни один** адрес не
    ответил на `/capabilities`, состав пула неизвестен ⇒ тул **не** блокируется (ADR-078: неоднозначная
    ошибка не должна отключать инструмент) — команда падает с `EUNREACHABLE`, ошибка видна модели. Если же
    адрес **ответил**, но нужной программы у него нет, — такой адрес из маршрутизации **исключается**
    (fail-closed): неизвестный/отсутствующий состав нельзя считать подходящим.
  - **(в) Ограничение «все реплики пула — один образ ⇒ один инвентарь».** Сейчас пул — это Deployment из
    однотипных реплик: инвентарь у них общий. Перечисление **отдельных** реплик (адрес → свой состав)
    потребовало бы стабильных адресов/имён — то есть StatefulSet. Это **открытый вопрос**, а не решённый
    факт: до решения пул описывается как «один образ — один инвентарь».
  - **(г) Снимок доступности вычисляется один раз на порт** (кэш детекции — `WeakMap` по экземпляру
    порта; фактически — при старте процесса, до первого запроса) и **не пересчитывается** при обновлении
    инвентаря по TTL: обновление инвентаря влияет на **маршрутизацию команд**, но не на «зелёный/красный»
    статус тула. Изменился состав пула — снимок пересчитается после рестарта control plane (инвариант 24:
    process-глобальные решения не переинициализируются на лету).

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
- **Шаг A — доступность инструментов по составу пула исполнителей (ADR-077/ADR-078):**
  - **Порт:** `packages/core/src/execution/ports/execution-port.ts` — `ExecRequest.requires?: string[]`
    (бинарные требования команды), `ExecutionPort.probe?(bin, args?)` («доступен ли бинарь в моём
    окружении»), `ExecutionPort.capabilitySummary?(bin)` (сводка «в пуле: N из M»), тип
    `ExecutionCapabilitySummary` (`available`/`missing`/`total`/`unreachable`), канонический словарь
    `EXECUTION_BASE_CAPABILITIES = ['git','rg','sh']`, новая причина отказа `dependency_missing`;
    реэкспорт — `ports/index.ts`, `packages/core/src/index.ts`.
  - **Единственная проба:** `packages/core/src/execution/probe.ts` (`probeBinaryThroughPort`) — `bin --version`
    через порт: `ENOENT` → `false`, прочая ошибка → `true` (fail-open, ADR-078);
    `inline-execution-port.ts` реализует `probe()` поверх неё — поведение inline не изменилось.
  - **Слой доступности:** `packages/core/src/engine/tools/runtime-deps.ts` — детект через `port.probe`
    (remote) либо локальная проба (inline); кэш детекции **по экземпляру порта** (`WeakMap`) — локальная
    проба больше не отравляет remote-кэш; `runtimeRequires()`/`toolRuntimeRequires()` (источник — карта
    `TOOL_RUNTIME_DEP`, строки не дублируются), `RuntimeDeps.details` — деталь недоступности.
  - **Требования тулов:** `engine/tools/shell.ts` (`execute_shell → ['sh']`), `engine/tools/search.ts`
    (`grep_files → ['rg']`), `engine/tools/git.ts` (все git-тулы → `['git']`).
  - **Деталь до модели:** `engine/permission/availability.ts` (`ToolAvailability.detail`),
    `engine/permission/evaluator.ts` (деталь в тексте deny), `engine/orchestrator.ts` и
    `engine/pipelines/step-context.ts` (`UnavailableTool.detail`), `engine/context/state-messages.ts`
    (рендер строки недоступного тула).
  - **Инвентарь и маршрутизация (клиент исполнителя):** `packages/executor/src/client.ts` —
    `RemoteExecutionPort` собирает инвентарь пула по `GET /capabilities` **всех** адресов
    (`REMOTE_CAPABILITIES_TTL_MS = 120_000`, ленивое обновление), отвечает `probe()`/`capabilitySummary()`,
    маршрутизирует команду с `requires` в адрес с нужными бинарями; адрес без нужного бинаря и не
    ответивший адрес не участвуют; подходящего адреса нет → `dependency_missing`/`EDEPENDENCY` с текстом
    «в пуле: N из M».
  - **Словарь исполнителя:** `packages/executor/src/toolchain.ts` — базовый словарь берётся из core
    (`EXECUTION_BASE_CAPABILITIES`, точечный динамический `import()`), допсведения отделены
    (`EXTRA_TOOLCHAIN_BINARIES = ['python3']`), проба различает `ENOENT` («программы нет») и «есть, но не
    поддержал `--version`» (программа есть).
  - **Тесты:** контракт порта (`packages/core/src/execution/contract/execution.ts` — `probe`, `requires`),
    `packages/core/src/engine/tools/runtime-deps.test.ts` (remote-детект, деталь, отсутствие отравления
    кэша, inline без изменений), `packages/executor/src/client.test.ts` (инвентарь, маршрутизация,
    недоступный адрес, `EDEPENDENCY`, сводка пула), `packages/executor/src/toolchain.test.ts`,
    `packages/core/src/execution/port-wiring.test.ts` (требования тулов), `availability.test.ts`,
    `storage-degraded.test.ts` (рендер детали).
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
  и MCP-stdio в исполнитель (шаги 8–9, фазы 2–3 матрицы), спека `docs/EXECUTION.md` — синхронизация
  описания инвентаря пула и словаря базовых возможностей.

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
  вынесены в [docs/EXECUTION.md](../EXECUTION.md) (Spec); **шаг A**: доступность инструментов
  определяется составом пула исполнителей — `probe()`/`capabilitySummary()` у порта,
  `ExecRequest.requires`, инвентарь пула по `GET /capabilities` (TTL + ленивое обновление),
  маршрутизация команды по требуемым бинарям, причина `dependency_missing` + деталь «в пуле: N из M»,
  кэш детекции по экземпляру порта; зафиксированы операционные следствия (единая версия протокола
  control plane и исполнителя, fail-open при недоступном инвентаре и fail-closed в маршрутизации,
  «один образ — один инвентарь», снимок доступности при старте).
