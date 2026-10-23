# @itphx/synth-core

> Точечные правила пакета. Общие инварианты, команды, порты и стиль — в корневом
> `AGENTS.md`; HTTP-спека — в `docs/API_V2.md` (здесь не дублируется).

## Роль и границы

`@itphx/synth-core` — единственный источник движка и общей логики Synth: сессии,
очередь, контекст, LLM, MCP, permissions, безопасность, хранилище, HTTP API v2
(Hono), гибридный режим, CLI.

- **backend импортирует core; core не импортирует backend/ui** — зависимости
  идут только «вниз»: `shared → core → backend/ui`.
- Режимы: **standalone** (`synth serve`/`synth chat`, свой HTTP API + локальный
  `FileStore`, один API-ключ); **managed** (core как библиотека внутри backend:
  OIDC/RBAC — на стороне backend; `createStandaloneApp` поднимает
  `@itphx/synth`); **hybrid** (локальный core + удалённый backend).
- `src/main.ts` — точка входа CLI (внутренний инструмент: `serve`, `chat`,
  `connect`, `project publish|fork`, `config`, `session`, `audit`, `update`,
  `storage migrate` — перенос данных между backend'ами, `analytics rebuild` —
  бэкфилл роллапов аналитики, ADR-096/ADR-102).
  Публичный CLI `synth` — это пакет `@itphx/synth`, не core.

## Инварианты core

- Публичные точки входа: `createStandaloneApp()` (`server/app.ts`),
  `createToolRegistry()` (`engine/tools/index.ts`), `createAgentRegistry()`
  (`engine/agents/index.ts`), `FileStore`/`JsonStore`/`ProjectStore`/
  `FileProfileStore`/`RuntimeSettingsStore`/`SSHKeyStore`/`ServiceApiKeyStore` (`storage/*`),
  слой хранения — `StorageContext` (в т.ч. опциональные `close?()` —
  освобождение ресурсов backend'а, напр. пула БД, на graceful shutdown — `locks?`, `health?`,
  `schemaMigrations?`, `purgeSchema?`, `degraded?` — см. ADR-098)/
  `createFileStorage`/`createMemoryStorage`/
  `createStorageContext` (`@deprecated`; для `postgres` бросает) и async-каскад
  `createStorageContextAsync`/`buildStorageContext` (`storage/storage-context.ts`), `FileBlobStore`
  (`storage/file-blob-store.ts`, порт `BlobStore`), `DefaultsStore` (`storage/defaults-store.ts`),
  `ChatOrchestrator`
  (`engine/orchestrator.ts`), `SessionManager` (`sessions/manager.ts`),
  `QueueProcessorManager` (`queue/processor.ts`), `EventBus` (`events/bus.ts`),
  `INSTANCE_EVENT_CHANNEL` (`events/bus.ts` — инстансный канал шины, ADR-101).
- **Пайплайны (ADR-101).** Публичные экспорты `src/index.ts`: движок
  (`PipelineEngine`, `PipelineEngineError`, `PIPELINE_ERROR_CODES`) и точки расширения
  (`StepExecutor`/`StepOutcome`/`StepGateOutcome`, `PipelineExitHandler`,
  `NoopPipelineExitHandler`, `createPipelineExitHandler`); исполнители шагов
  (`createToolStepExecutor`/`createScriptStepExecutor`/`createHumanStepExecutor`/
  `createAgentStepExecutor` + `executeToolStep`/`executeScriptStep`/`executeAgentStep`);
  контекст и правила шага (`buildPipelineStepContext`, `checkPipelineToolPermission`,
  `evaluateCondition`, `resolveStepInput`, `resolveSpecVars`, `resolvePipelinePath`,
  `nextNodeId`, `MAX_PIPELINE_TRANSITIONS`, `sanitizeRecord`/`sanitizeTrigger`/
  `sanitizeValue`, `buildShellCommand`, `buildStepUserMessage`, `buildToolContext`,
  `findTool`, `stepWorkingDir`, гейт-хелперы `humanGate`/`gateDecisionResult`/
  `gateRejectedResult`/`gateTimeoutResult`/`startGateTimeout`/`isStepGateOutcome`);
  HTTP-фабрики (`createPipelineProjectRoutes` + `legacyDefinitionToPipelineSpec`,
  `createPipelinesRoutes`, `createPacksRoutes`); порты и типы хранения
  (`ProjectPipelineRepository`/`PipelineRunRepository` + их записи, файловые и
  in-memory реализации); метрики (`createPipelineMetrics` + нормализаторы лейблов и
  корзины `PIPELINE_*_DURATION_BUCKETS`); провайдерский seam `toCoreProviderConfig`
  (`engine/router/index.ts` — конфиг провайдера для движка вне сессий).
- Движок stateless: история и состояние — на бэкенде; движок получает историю +
  новое сообщение + контекст (ADR-022).
- История для LLM формируется только через `ChatOrchestrator._sessionMessagesToLlm`
  (`engine/orchestrator.ts`): сообщения чужого агента (иной `agentRole`; пустой
  `agentRole` — «своё») отдаются как текст с атрибуцией `[agentRole]:`/`{author}:`,
  но tool-chain сохраняется структурно — assistant с `toolCalls` остаётся ролью
  `assistant` + `toolUse`, `tool`-результаты идут парными по `toolCallId`.
  Осиротевших `tool`-сообщений (без предшествующего `tool_calls`) в выдаче быть не
  должно: это ломает OpenAI-совместимые API и Anthropic (`tool_result` требует
  парный `tool_use`).
- Любой LLM-вызов — через `GatewayProvider`
  (`engine/gateway/gateway-provider.ts`: guard, обфускация, rate limit, аудит);
  провайдера напрямую не дёргать (ADR-036).
- **Наблюдаемость — контракт (ADR-094).** `metrics/*` — свой реестр без внешних
  зависимостей (рендер exposition 0.0.4 внутри core, новых пакетов не добавлять);
  имена `synth_*` и лейблы фиксированы, `route` — шаблон, `session_id`/`user_id`/
  сырые пути запрещены, SSE/WS вне гистограммы. `GET /metrics` — **вне** `/api/*`,
  off by default, опциональный bearer; `/ready` ≠ liveness (деградация хранилища
  остаётся ready). Runtime `metrics.enabled` — в UI «Метрики» (`settings.json`/PG;
  приоритет env > runtime > config, `resolveMetricsEnabled`), применяется рестартом
  (`restartRequired`); токен — только env/файл (`token.ts`: status/write/remove,
  write-only из UI). Единственная точка LLM-метрик — `GatewayProvider.onCall`
  (или `createLlmCallRecorder(opts.metrics)`) — не считать вызовы в обход Gateway.
- Permissions и режимы — только через `PermissionEvaluator`
  (`engine/permission/evaluator.ts`): `plan`/`act`/`yolo`,
  `allow`/`deny`/`ask`; не хардкодить проверки в тулах (ADR-025/028/029).
- Хранилище — только через порты слоя хранения (`StorageContext`, ADR-096); файловая
  реализация — `FileStore`/`JsonStore`/… (JSON + атомарная запись tmp→rename,
  ADR-005); писать в `$SYNTH_DATA_DIR` в обход порта нельзя.
- Исполнение агентских команд — **только через порт** `ExecutionPort` (`execution/ports`), а не
  прямым `execFile`; реализация по умолчанию — `InlineExecutionPort` (в процессе), удалённая —
  шаг 7b плана ADR-077 (пакет `@itphx/synth-executor`, динамический `import()`). Выбор
  реализации — `execution/factory.ts` (`createExecutionPortForConfig`) при старте процесса;
  шов внедрения — `ctx.extra.executionPort` (`resolveExecutionPort(ctx)`);
  не-туловые точки (резолвер проектных инструкций, детект зависимостей, inline-shell) берут
  тот же порт через композицию. Вне порта остаются операции, не относящиеся к агентским
  командам: `simple-git` (`git/git-service.ts` — clone/fetch/init с SSH/CA-окружением), MCP
  stdio (`engine/mcp/client.ts`), обслуживание (`maintenance/update.ts`) — они уезжают в
  исполнитель по фазам 2–3 плана ADR-077.
- **Доступность программы — вопрос порта, а не control plane (ADR-077 шаг A).**
  `ExecRequest.requires?: string[]` — бинарные требования команды; канонический словарь
  базовых возможностей — `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`) в
  `execution/ports/execution-port.ts` (единственный источник истины для обеих сторон:
  исполнитель отдаёт тот же словарь в `GET /capabilities`). У порта — необязательные
  `probe?(bin, args?)` («доступен ли бинарь в моём окружении») и `capabilitySummary?(bin)`
  (сводка «в пуле: N из M»); удалённая реализация отвечает по **инвентарю пула**
  (ADR-077, `packages/executor/src/client.ts`), inline — локальной пробой. Проба — **только**
  через `execution/probe.ts` (`probeBinaryThroughPort`): `ENOENT` → `false`, прочая ошибка →
  `true` (fail-open, ADR-078); второй реализации пробы не заводить. Слой доступности
  (`engine/tools/runtime-deps.ts`) спрашивает **порт**, а не пробует локально; кэш детекции —
  **по экземпляру порта** (`WeakMap`) на `RUNTIME_DEPS_CACHE_TTL_MS` (60 с): локальная (inline)
  проба не отравляет remote-кэш, а состав пула обновляется — бессрочный кэш залипал бы ложным
  negative после раскатки. Сам снимок доступности — живой: ход сессии перечитывает его
  `refreshRuntimeDeps()` (запись по месту — объект разделяется с permission-слоем шагов пайплайнов).
  Требования тулов берутся из карты `TOOL_RUNTIME_DEP` (`runtimeRequires()`/
  `toolRuntimeRequires()`) — строки не дублируются руками.
- Конфиг — через `@itphx/synth-shared/config` (ADR-023); приоритет
  CLI-флаги > `SYNTH_*` env > config.yaml > defaults.
- **Доверие TLS/CA исходящих соединений — единый слой (ADR-099).**
  `security/tls.ts`: `initTlsTrust` — инициализация при старте процесса
  (`main.ts`, `server/app.ts`, backend) **до** первого исходящего запроса;
  `buildTlsTrust` — чтение PEM CA/клиентского серта; `applyGlobalTlsTrust` —
  глобальный undici-dispatcher (`setGlobalDispatcher`, покрывает обычный `fetch`
  по всему процессу); `egressFetch` — `fetch` с **явным** dispatcher (не зависит
  от глобального состояния); `getTlsCaPath`/`gitCaConfig` — путь CA для git.
  **Новые исходящие вызовы — только через `egressFetch`** (или
  `fetchWithEgressGuard`/`web.ts`-обёртки поверх него), своих `Agent`/dispatcher
  не создавать; пустая конфигурация — системное доверие, поведение прежнее.
  git-CA (`git/git-service.ts`): `simpleGit({ config: ['http.sslCAInfo=…'] })` —
  env-канал `GIT_SSL_CAINFO` недоступен (`sanitizeGitEnv`/`allowEnvironment`),
  CA передаётся только пер-вызовом; `caFile` (путь), не `caPem`.
- **Host-binding секретных заголовков (ADR-105 §7).**
  `engine/net/egress-guard.ts`: режим `fetchWithEgressGuard(..., { bindSecretHeaders: true })` —
  при редиректе на **другой origin** (сравнение scheme+host+port) заголовки
  `authorization`/`proxy-authorization`/`x-api-key`/`cookie` не пересылаются,
  остальные — как раньше; без редиректов поведение не меняется. Режим **выключен
  по умолчанию** (поведение существующих потребителей не затронуто) — включают
  те, кто несёт токен наружу (OAuth-вызовы; в MCP-транспорте токен добавляется
  сам — `engine/mcp/credential-auth.ts`).
- **TLS runtime и профили (ADR-099).** `security/tls.ts`: `initTlsTrust` читает bootstrap
  (`tlsRuntime`/`dataDir`) до PG, строит `EgressDispatcher` с `tlsProfiles`; `getTlsStatus` — статус без
  PEM/ключей (ca count/subjects, client/mapping subjects, `running`/`saved`, `restartRequired`).
  `security/proxy-dispatcher.ts` выбирает TLS-профиль по origin (`profileFor`) и прокси-маршрут через
  `resolveProxyRoute` (ADR-099 п. 27: `mode`/`profiles`/`rules`, first match, `noProxy` важнее); PostgreSQL —
  `selectTlsClientProfile` по host (`storage-postgres/pool.ts`, `tlsRuntime`). Профильные секреты —
  `security/proxy-password.ts` (`secrets/proxy/<name>.password`) и `security/proxy-tls-secrets.ts`
  (`secrets/proxy/<name>/`), диагностика — `security/proxy-check.ts`
  (`checkProxyConnectivity` — к прокси, `checkProxyTarget`/`describeProxyRoute` — к цели с маршрутом). API —
  `server/routes/settings-tls.ts` (`/settings/tls*`, write-only client, mappings, validate) и
  `server/routes/settings.ts` (`/settings/proxy*`, профили/правила/`/proxy/test`), аудит
  `scope:'tls'`/`scope:'proxy'`; изменения — при следующем старте.
- Секреты at-rest (SSH-ключи, ADR-076) — AES-256-GCM (`security/crypto.ts`);
  мастер-ключ — `SYNTH_SECRET_KEY` > `security.secretKey` > файл
  `{dataDir}/secrets/master.key` (`0600`, каталог `0700`, создаётся при первом
  запуске); секреты не отдаются наружу (`reveal()` — только для git). Ротация
  мастера — `synth secrets rotate` (`security/rotate.ts` + `SSHKeyStore.rotateMasterKey`,
  preflight + dry-run); ключи с passphrase — через askpass (`git/ssh-env.ts`),
  наружу — `sshkey.env_failed`.
- План — в `project.plan`, todo — в `session.todos`; состояние менять только
  тулами `plan_*`/`todo_*`, не JSON-блоком в ответе модели (ADR-039).
- Ошибки LLM — через `classifyLlmError`/`isLlmErrorRecoverable`
  (`engine/llm-error.ts`); строки движка — по ключам `shared/i18n` (ADR-041).
- События сессии — локальный `EventBus`; UI слушает через EventHub/TransportClient
  (`/ws/events`) с SSE-фоллбеком (ADR-008/009/024).
- **Инстансный канал событий (ADR-101).** Прогон пайплайна — не сессия, поэтому его события
  `pipeline.run.*` публикуются в **инстансный канал** той же шины
  (`EventBus.publishInstance`, канал `INSTANCE_EVENT_CHANNEL = 'instance'`, `events/bus.ts`): их
  видят глобальные подписчики (SSE-хаб `GET /api/v2/events`, watch-all клиенты managed-хаба
  `EventHub`, движок исходящих webhooks), а per-session подписки — нет. Новых транспортных
  каналов не заводим (инвариант 6); предупреждение «EVENT LOST» для инстансных событий не
  печатается.
- Машинный доступ внешних сервисов — через **service-key** (ADR-052 этап I): `ServiceApiKeyStore`
  + синтетический пользователь + `scopes`/`allowedProjects`; enforcement — `requireScope`/
  `checkServiceProjectProjection` (`server/service-scope.ts`), **не** через permission-слой тулов (тот
  роль-оси не имеет, ADR-029). Каталог scope включает зонтичный `addons:install` (установка
  аддонов: MCP-реестр/скиллы), зонтичный `automation:install` (установщик **пакетов
  расширений**: агенты и их ролевые промпты, пайплайны, а также порождаемые пакетом
  правила маршрутизации и расписания — наборы «любой из» в
  `SERVICE_SCOPE_SETS`: `routesWrite`/`schedulesWrite`/`agentsWrite`; `addons:install`
  создание агентов **не** открывает) и `users:read`. Провижининг installer-ключа — `security.bootstrapServiceKeys`
  (config) / env `SYNTH_BOOTSTRAP_SERVICE_KEYS` (JSON) → `applyBootstrapServiceKeys` при старте.
- Создание сессии — через единый funnel `RequestSessionService`
  (`engine/events/request-session.ts`): явный запрос — `direct`, внешнее событие —
  через `EventRouter`; `SessionManager.createSession` — materialization-примитив
  (fork/import/материализация), не для прямых запросов (ADR-089). Материализация
  `ephemeral`/`bind` проставляет владельца, чтобы сессия не выпадала из
  `listSessions({ userId })`, по приоритету: `deps.resolveExternalIdentity`
  (`createExternalIdentityResolver`: override `identityMap` по `identity.principalId`, затем
  `identity.chatKey` → иначе профиль по `principalId`; чат-fallback внутри резолвера) →
  `deps.identityMap` (фоллбек-совместимость: при подключённом резолвере карта уже проверена
  им первой, поэтому шаг фактически недостижим) → per-event
  `ownerId` (пользователь/создатель ключа привязки) → `deps.resolveOwnerId`
  (standalone — `local`). Владелец — **человек (`principalId`)**, а не чат: в группе
  `chatKey` = группа, поэтому чат определяет только routing, а не ownership;
  `identity.principalId` — внешний идентификатор (`tg:<id>`), не id пользователя
  инстанса (как владелец не подставляется). Attribution сообщения (функция
  `eventToMessage`): для всех внешних источников в `metadata` — `principal_id`/
  `chat_key`/`thread_key`, `author` выводится из `payload.from` (username →
  `@username`; иначе `firstName lastName`; иначе `principalId`); cron — по-прежнему
  `Scheduler`; для источников без `from`/`principalId` `author` не задаётся.
  Дефолтные `provider`/`model` инстанса (`deps.resolveLlmDefaults`:
  standalone — `llm.defaultProvider`/`llm.defaultModel` через `StandaloneConfig.llmDefaults`;
  managed — `synth.llm`), иначе сессия из внешнего события не могла ответить без ручной
  простановки модели — явные значения `settings` приоритетнее, поля добираются по отдельности.
  Глобальный SSE-хаб `GET /api/v2/events` подписан на все события шины
  (`eventBus.subscribeAll`) — доставляет и позже созданные (funnel) сессии (ADR-089).
  Для per-session подписок (managed backend `EventHub`) funnel вызывает необязательный
  `deps.onSessionMaterialized(session)` сразу после создания сессии и **до** доставки
  события — потребитель подписывает клиентов владельца (`subscribeToSession`).
  Standalone-core подключает тот же шов к WS: `EventWebSocketSubscriptions`
  (`server/app/ws-events.ts`) — реестр подписок клиентов владельца, заполняется из
  `onSessionMaterialized` (сессии после connect) и из `onSessionCreated`/`onSessionForked`
  сессионных фабрик (fork/import мимо funnel) — плюс **авто-подписка по событию**
  (`session.created`/`session.fork.created` в канале новой сессии → `subscribeToNewSession`
  с форвардом; `session.created`/`child.*`/`subagent.resume.*` в канале родителя → подписка
  на child); детект — общий `events/child-session.ts` (`extractChildSessionId`/`extractCreatedSession`,
  один код на managed `EventHub` и standalone-хаб), поэтому путь создания сессии уведомляет хаб,
  лишь публикуя событие (инвариант 18 корневого `AGENTS.md`); `forkProjectToLocal`
  (`remote/transfer.ts`) публикует `session.created` сам. Подписка строго по владельцу — чужую
  сессию не подписывает и не доставляет.
- **Права внешнего отправителя (ADR-089 этап 5).** База — роли **профиля** Synth
  отправителя; `identity.roles` (роль из allowlist шлюза) только **сужают** (пересечение),
  не повышают; несопознанный (нет профиля) → прав нет (fail-closed). Резолвер —
  `resolveEffectiveRoles` (`engine/events/identity-roles.ts`); funnel считает контекст и
  передаёт `EventDeliveryContext {roles, linked}` в `deliver`, который пишет
  `metadata.effective_roles`/`identity_linked`. **Роль-оси в permission-слое
  (`PermissionEvaluator`, ADR-029) нет — by design:** роли = доступность **эндпоинтов** (HTTP,
  `requirePermission`); внутри сессии набор тулов/разрешений одинаков для всех (режим, capabilities
  агента, MCP/скиллы). Эффективные роли доставляются в ход для аудита/attribution; машинный доступ
  интеграций сужается scoped **service-key** (ADR-052), а не ролями отправителя.

## Гибрид (core-специфика)

- Флаги `serve`: `--connect <url>` (адрес backend), `--token <api-key>`,
  `--oidc-issuer`/`--oidc-client-id` (fallback дискавери) — `src/main.ts`.
- `RemoteBackendClient` (`remote/client.ts`) — HTTP-клиент к backend;
  `RemoteEventBridge` (`remote/event-bridge.ts`) — мост SSE `/api/v2/events` →
  локальный `EventBus`.
- Идентификация: id удалённых сущностей — `remote:<uuid>`, маршрутизация по полю
  `origin`; id не смешивать (`remote/aggregate.ts`).
- LLM локальных сессий в гибриде — через `RemoteProvider` →
  `POST /api/v2/llm/chat/completions` (`providers/remote.ts`); режим — `remote.llm`
  (`server` | `local` | `auto`).
- Runtime-подключение: `connectRemote*`/`disconnectRemote` на хэндле
  `createStandaloneApp`; профили серверов — `profiles.ts` (`getProfilesPath(home)` →
  `<home>/profiles.json`; без home — XDG `~/.config/synth/profiles.json`),
  credentials — `remote/credentials.ts` (`defaultCredentialsPath(home)`); в
  `createStandaloneApp` путь задаётся опцией `profilesPath` рядом с
  `remoteCredentialsPath` (ADR-042/045/079).

## Карта модулей

- `main.ts` — CLI/точка входа (`serve`, `chat`, `connect`, `project publish|fork`, `secrets rotate`, `analytics rebuild`, …).
- `execution/` — ADR-077 (шаги 1, 3, 7b + шаг A): порт исполнения команд, выбор реализации по
  режиму и проверка режима при старте —
  `ports/execution-port.ts`
  (`ExecutionPort`, `ExecRequest`, `ExecResult`, `ExecCommand` — union `shell`/`argv`,
  `ExecutionError`, `DEFAULT_MAX_OUTPUT_BYTES`; **шаг A**: `ExecRequest.requires?: string[]`,
  `ExecutionPort.probe?(bin, args?)`, `ExecutionPort.capabilitySummary?(bin)`,
  `ExecutionCapabilitySummary`, `EXECUTION_BASE_CAPABILITIES = ['git','rg','sh']`,
  причина отказа `dependency_missing`), `inline-execution-port.ts`
  (`InlineExecutionPort` — исполнение в процессе поверх `execFile`; `probe()` — поверх общей пробы),
  `probe.ts` (**единственная** проба `bin --version` через порт: `ENOENT` → `false`, прочая ошибка →
  `true`, fail-open, ADR-078), `contract/`
  (контрактный suite порта — обязателен для любой реализации, как `storage/contract/`;
  общий набор проверок + блоки `describeInlineOnlyExecutionChecks`/`describeRemoteOnlyExecutionChecks`
  — разделение намеренное: у remote `cwd` обязан лежать в workspace исполнителя, у inline
  такого ограничения нет; `probe`/`requires` проверяются в общем наборе, `dependency_missing` —
  в remote-блоке), `remote.ts` (загрузчик удалённого порта: **динамический `import()`
  по строке-константе** `'@itphx/synth-executor/client'` + локальный интерфейс модуля +
  каст — по образцу драйвера хранилища в `storage/storage-context.ts`; чтение токена из
  файла по `execution.remote.tokenSecret` — **fail-closed**, значение токена не логируется
  и не попадает в текст ошибок; `RemoteExecutionUnavailableError` — отдельный класс;
  **инвентарь пула и маршрутизация по `requires` живут в клиенте пакета** —
  `packages/executor/src/client.ts`: карта «адрес → состав программ» по `GET /capabilities`
  всех адресов, TTL `REMOTE_CAPABILITIES_TTL_MS = 120_000` с ленивым обновлением,
  `probe()`/`capabilitySummary()` по инвентарю, маршрутизация команды в адрес с нужными
  бинарями; адрес без нужного бинаря и не ответивший адрес из маршрутизации исключаются,
  подходящего адреса нет → `dependency_missing`/`EDEPENDENCY` с текстом «в пуле: N из M»),
  `factory.ts` (`createExecutionPortForConfig` — выбор порта по режиму: `inline` →
  `InlineExecutionPort`, `remote` → удалённый порт; экземпляр на каждый вызов, без
  process-глобальных синглтонов), `tool-port.ts` (`resolveExecutionPort(ctx)` — шов: берёт
  порт из `ctx.extra.executionPort`, иначе inline-фоллбэк), `startup.ts`
  (`checkExecutionMode`/`assertExecutionModeSupported` — **async**, fail-closed при старте:
  `mode: remote` без адресов → «требуется хотя бы один адрес исполнителя»; с адресами, но
  без пакета исполнителя или без читаемого токена → «удалённый режим недоступен» с
  технической причиной). Пакет `@itphx/synth-executor` объявлен в `optionalDependencies`
  core и подключается **динамическим `import()`** (fail-closed: нет пакета/токена/адресов →
  старт прерывается, а не «молча уходит в inline» — тихий возврат означал бы, что оператор
  запросил удалённое исполнение, а получил локальное).
- `metrics/` — ADR-094: `registry.ts` (counter/gauge/histogram, лимит серий 2000,
  `synth_metrics_series_dropped_total`, `addCollector`), `renderer.ts` (text exposition 0.0.4,
  golden-тесты), `http.ts` (Hono-middleware: `method`/шаблон `route`/`status`, `in_flight`,
  `streams_active`; `/metrics` пропускается, SSE/WS вне гистограммы), `process.ts` (RSS/heap/CPU/
  event loop lag/uptime/`build_info`), `token.ts` (`SYNTH_METRICS_TOKEN` → `{dataDir}/secrets/metrics-token`;
  `getMetricsTokenStatus`/`writeMetricsToken`/`removeMetricsToken`, минимум 16 символов, атомарно `0600`),
  `collectors/*` (`bus` — turns/streams/retries/cost, `llm` — `createLlmCallRecorder` для
  `GatewayProvider.onCall`, `sessions` — 15 c, `storage` — записи/деградация 60 c и `{dataDir}` 300 c,
  `events` — ingest/decisions + журнал 5 мин, `scheduler`, `webhooks`, `hybrid`, `decision`,
  `authority` — `createAuthorityMetrics`: `synth_authority_decisions_total` (ADR-106 Ф1 — решения
  Authority-слоя; лейблы только `action`/`effect`/`source`, значения приводятся к конечным наборам,
  неизвестное → `other`; id принципалов/сессий/ходов в лейблах нет), `ready`,
  `pipelines` — `createPipelineMetrics`: `synth_pipeline_*` (ADR-101 — прогоны/шаги/длительности/
  HITL-ожидания; лейблы только `status`/`source`/`kind`/`outcome`, id прогонов и узлов в лейблах нет —
  значения приводятся к конечным наборам, неизвестное → `other`; ошибка метрик не влияет на прогон)).
  Роуты — `server/routes/metrics.ts` (`/metrics`: 404 при disabled, 401 при токене, `no-store`),
  `server/routes/health.ts` (`/health`, `/ready`) и `server/routes/metrics-settings.ts`
  (`createMetricsSettingsRoutes`: runtime/status/token, `resolveMetricsEnabled` — env > runtime > config > default).
  Каталог метрик — `docs/OBSERVABILITY.md`.
- `server/app.ts` — `createStandaloneApp`: фасад-композиция (auth/bootstrap service-key,
  middleware, вызовы вынесенных модулей, сборка хендла). ADR-095 (шаг 4a) вынес блоки
  в `server/app/*`: `deps.ts` (сборка зависимостей), `mount-routes.ts` (весь порядок
  монтирования — порядок критичен для приоритетов роутов), `hybrid-remote.ts`
  (зеркала/`injectRemoteProvider`), `ws-events.ts` (`/ws/events`), `sse-events.ts`
  (`GET /api/v2/events`), `http-server.ts` (Node-адаптер), `static.ts` (раздача UI).
  ADR-052 (этап I): глобальный per-key rate limit service-key (`KeyRateLimiter`, fixed
  window 60 c, ключ — `keyId`) — после `requireAuth`, до роутов; `rateLimitPerMinute`
  ключа, 0/не задан — без лимита, превышение → 429 `RATE_LIMITED` (паритет с backend).
  При старте — `applyBootstrapServiceKeys` (ADR-052/O1: installer-ключи из `security.bootstrapServiceKeys`).
- `server/routes/*` — `health`, `hybrid`, `auth`, `sessions`, `messages`, `projects`,
  `project-transfer`, `project-portable`, `providers`, `models`, `agents`, `fs`, `queue`, `updates`,
  `settings`, `metrics-settings` (ADR-094: `/settings/metrics*`), `dictionaries`, `mcp`, `skills`,
  `commands`, `skill-bundles`, `skill-scope`, `git`, `ssh-keys`, `events`, `identities`,
  `service-keys`, `webhooks`, `maintenance`, `analytics`.
- `maintenance/*` — ADR-091/ADR-092: обслуживание инстанса. `service.ts` — сервисный слой
  admin-API/UI (список/создание бэкапов, отложенное восстановление
  `scheduleRestore`/`getPendingRestore`/`cancelPendingRestore`, сводный статус; запросы —
  `{dataDir}/maintenance/`), `backup.ts`/`restore.ts` (архив/снятие), `doctor.ts` (`synth doctor`),
  `update.ts` (`synth update` — проверка/обновление/**откат** пакета `--to <version>`, аудит
  `update.applied`/`rollback.applied`/`update.failed`), `startup.ts` (`applyPendingRestore` —
  офлайн-восстановление при старте, `applyStartupMigrations` — авто-миграции со страховочной копией),
  `audit.ts` (`recordMaintenanceAudit` — best-effort запись аудит-событий обслуживания
  `backup`/`restore`/`migrate`/`update`/`rollback`/`uninstall`, ADR-092; порт
  `MaintenanceAuditRepository`). HTTP-фабрика — `server/routes/maintenance.ts`
  (`createMaintenanceRoutes`).
- `analytics/*` — ADR-102: аналитика и отчётность инстанса. `recorder.ts` — `AnalyticsRecorder`
  (best-effort инкремент бакетов `usage`/`activity`/`decision` через порт `AnalyticsRollupRepository`,
  ошибки порта не пробрасываются), `hooks.ts` — `attachAnalyticsActivityHooks` (жизненный цикл
  сессии/инструментов/саб-агентов → `activity`), `prune.ts` — `startAnalyticsRollupPruner`
  (retention по `analytics.retentionDays`, старт + каждые 6 ч), `service.ts` — `AnalyticsService`
  (период/`groupBy`, чтение роллапов, дериваты), `derive.ts` — `deriveMeasures`
  (`total_tokens`/`cache_hit_rate`/`reasoning_ratio`/`output_tps`), `export.ts` — `toCsv`/`toJson`
  (CSV RFC 4180 + BOM + `TOTAL`), `rebuild.ts`/`rebuild-command.ts` — идемпотентный бэкфилл
  `synth analytics rebuild` (`--from`/`--dry-run`/`--yes`; `decision` не пересобирается, `prompt` —
  проекция на чтении). HTTP-фабрика — `server/routes/analytics.ts` (`createAnalyticsRoutes`).
- `server/restart.ts` — ADR-092 п. 7: graceful restart инстанса. `configureRestart` (вызов на старте
  процесса — `main.ts`/backend `main.ts`), `resolveRestartMode` (`--restart-mode` > `SYNTH_RESTART_MODE`;
  неизвестное → `disabled` + warn), `getRestartStatus` (`supported`/`mode`/`reason`/`startedAt`/`version`),
  `requestRestart` (идемпотентный `rst_<uuid>`, аудит через `beforeRequest`, `setTimeout` → `process.exit(75)`;
  `RESTART_EXIT_CODE = 75`), `getProcessStartedAt` (тот же `startedAt` в `/health`). Роуты —
  `GET/POST /api/v2/maintenance/restart` (`server/routes/maintenance.ts`); переинициализацию
  процесс-глобальных singleton'ов не делать — только выход.
- `server/service-scope.ts` — ADR-052 (этап I): enforcement service-key — `requireScope(...)`
  (scope-гейт рядом с `requirePermission`; для интерактивных кред — no-op), `requireScopeOrAdminRole(...)`
  (тот же гейт, но service-key проходит и по **роли ADMIN** среди выданных ролей — зонтичный
  `automation:install` не отбирает прежние права ключа с ролью ADMIN; интерактив — no-op),
  `checkServiceProjectProjection`/
  `isProjectAllowed` (проектная проекция `allowedProjects`; это **не** RBAC), `getServiceCredential`
  (`serviceKey` из контекста), типы `ScopeGuardFactory`/`ServiceProjectProjectionGuard`. Прежние имена
  `checkProjectAccess`/`ProjectGuard` оставлены `@deprecated`-алиасами — в коде и доках использовать новые.
- `server/session-access-guard.ts` — инвариант авторизации сессий (ADR-089): единый prefix-guard
  `createSessionAccessGuard` (`app.use('/:id', requireAuth, guard)` + `/:id/*`, до регистрации маршрутов —
  покрывает и будущие), `createSessionAccessPredicate` (владелец → роль → участие в проекте), `accessKindOf`
  (вид `read`/`write` из HTTP-метода). Один факт нарушения → один код (`403`), нет сессии → `404`;
  read/write-разграничение ролей проекта живёт в ОДНОЙ точке, а не в обработчиках. Матрица —
  `packages/backend/src/routes/session-idor-matrix.test.ts`.
- `server/session-export-guard.ts` — ADR-036 (security-фикс 0.11.3): route-level guard экспорта
  сессии `createSessionExportGuard` — резолвит сессию, решает привилегию карты обфускации
  (полный экспорт — владелец|`ADMIN`|`AUDITOR`; остальным читателям — очищенный) и кладёт решение в
  контекст Hono (`SESSION_EXPORT_CONTEXT_KEY`, чтение — `getSessionExportDecision`); `isSessionExportPath` —
  признак маршрута экспорта (роль аудита — читатель сессии именно там). Доступ (403/404) решает
  prefix-guard, в обработчике проверок доступа нет (инвариант 16).
- `server/session-visibility.ts` — ADR-089: `isSessionVisible` (+ `SessionOwnerCtx`) —
  единое правило видимости сессии в списке (elevated/владелец/ownerless/проект-участие).
- `server/routes/identities.ts` — `createIdentityRoutes` (ADR-089): идентичности текущего
  пользователя (`GET /api/v2/me/identities` → `{identities: ExternalIdentity[]}`;
  `DELETE /api/v2/me/identities/:provider/:externalId` — отвязка только своих, 404 если нет;
  `POST /api/v2/me/identities/claim` `{code}` → 201 `{identity}` — подтверждение владения
  идентичностью по **одноразовому** коду, привязка с `linkedBy` = id профиля).
  `resolveProfileId` возвращает **id профиля** (`ProfileData.id`), НЕ OIDC `sub`/
  username (core-дефолт — профиль `local`, backend — профиль по `username`),
  `messages` для i18n, `claimStore`
  (`IdentityClaimStore`; без него роут claim не монтируется). Прямой линковки произвольного
  чужого id нет — только claim-flow. Ошибки: 400 `VALIDATION_ERROR` (пустой код),
  401 `UNAUTHORIZED` (профиль не определён — пустой id),
  404 `NOT_FOUND` (неизвестен/истёк/использован), 409 `CONFLICT` (занят другим профилем);
  `provider`/`externalId` берутся из серверной записи claim, не из тела.
- `server/routes/events.ts` — `createEventRoutes` (ADR-089): приём `POST /` (API-ключ привязки —
  `resolveApiKeySecret`/`touchApiKey`; иначе fallback `ingestGuard`; `ingestPreGuard` — rate limit
  до выбора способа аутентификации; per-key rate limit `KeyRateLimiter` — `rateLimitPerMinute` либо
  `getKeyRateLimitPerMinute()`; `isEnabled()` — мастер-выключатель → 503) и CRUD bindings/routes/keys
  (`writeGuard`/`keyReadGuard`; core-дефолты — `requireAuth`, backend передаёт RBAC). Ключи: `GET/POST`
  списка/создания, `PATCH` метаданных, `POST .../revoke` (мягкий отзыв), `DELETE`; `label` обязательна
  и уникальна глобально (дубль → 409 `CONFLICT`). ADR-052: scope-гейты на роутах
  (`events:ingest`, `events:watch`, `bindings:read|write`, `keys:read|write`, `routes:read|write`)
  и проектная проекция через `scopeGuard`/`serviceProjectProjection` (core-дефолты — `requireScope`/`checkServiceProjectProjection`).
  Запись правил маршрутизации — `SERVICE_SCOPE_SETS.routesWrite` (`routes:write` **или**
  `automation:install` — достаточно любого из двух).
- `server/routes/service-keys.ts` — `createServiceKeyRoutes` (ADR-052 этап I): CRUD service-key
  инстанса (`GET/POST /api/v2/service-keys`, `GET /scopes` — каталог scope'ов/семейств/ролей из shared,
  `GET/PATCH/DELETE /:id`, `POST /:id/revoke`),
  store `ServiceApiKeyStore`; `opts.writeGuard`/`readGuard` (core — `requireAuth`, managed — ADMIN),
  `messages` (i18n), `resolveUserId` (creator). Секрет — единожды в ответе `POST`.
  `storage/service-api-key-store.ts` — `ServiceApiKeyStore` (`{dataDir}/service-keys.json`):
  sha256 at-rest, `resolveBySecret` (revoked/expired → `null`), `revoke`/`touch`,
  `ServiceApiKeyConflictError`; `ServiceKeyCredential` — контекст enforcement.
- `server/routes/webhooks.ts` — `createWebhookRoutes` (ADR-052 этап II): CRUD подписок
  исходящих webhooks (`GET/POST /api/v2/webhooks`, `GET/PATCH/DELETE /:id`,
  `POST /:id/regenerate|revoke|test`, `GET /:id/deliveries`), store `WebhookStore`
  + журнал `WebhookDeliveryStore` + движок `WebhookService` (тест-доставка);
  `opts.writeGuard`/`readGuard` (core — `requireAuth`, managed — ADMIN), `messages`,
  `isEnabled` (мастер `webhooks.enabled`: `false` → 503 на мутации/тест),
  `allowPrivateTargets`; URL валидируется SSRF-политикой (`evaluateWebhookTarget`),
  секрет — единожды в `POST /`/`regenerate`.
- `engine/webhooks/*` — ADR-052 этап II: `WebhookService`
  (подписка на `eventBus.subscribeAll`, фильтр `matchWebhookEvent`, HMAC-подпись,
  retry/backoff с джиттером и таймаутом, дедуп по (подписка+событие), журнал доставок;
  `computeBackoffMs`), `signature.ts` (`buildSignatureHeader`/`verifyWebhookSignature`,
  `X-Synth-Signature: t=…,v1=…`, окно 300 c), `network.ts` (`evaluateWebhookTarget` —
  SSRF-политика над `engine/mcp/network-policy.ts`, https + запрет private/loopback),
  `prune.ts` (`startWebhookDeliveryPruner` — retention журнала доставок, раз в 6 ч).
- `engine/oauth/*` — ADR-105 Ф2: OAuth-клиент и сервис слоя внешних доступов.
  `types.ts` (описание провайдера — **данные**: authorize/token/revoke URL, `client_id`,
  scope'ы; `OAuthError` с машинным кодом), `pkce.ts` (PKCE S256 по RFC 7636,
  `buildAuthorizationUrl`), `client-secret.ts` (`client_secret` — только env
  `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` или файл
  `{dataDir}/secrets/oauth/<provider>.client_secret`, `0600`; в конфиге его нет и
  в логах он не появляется), `client.ts` (`OAuthClient`: обмен кода RFC 6749 §4.1.3,
  refresh §6, revoke RFC 7009 — best-effort; сеть — **только** `egressFetch`,
  ADR-099), `service.ts` (`OAuthCredentialService` — обмен кода + запись доступа,
  refresh, отзыв; единственный путь записи — порт `ExternalCredentialRepository`,
  прямой записи в `{dataDir}` нет). Гонка refresh: **один** сетевой вызов при
  параллельном refresh (single-flight) + **CAS по `refreshEnc`** (кто первый
  обновил — тот и записал); `invalid_grant` → доступ в `status:'error'` через порт.
  Device Flow не дублируется — обобщён `remote/device-flow.ts` (`postFormDetailed`:
  HTTP-статус + тело, инъекция транспорта для тестов). ADR-105 Ф3: `registry.ts`
  (реестр описаний OAuth-провайдеров инстанца — источник каталога `oauth.providers`
  в конфиге; описание — **данные**, кода провайдера в ядре нет; из описания строится
  клиент для refresh), `credential-binding.ts` (правило права привязки доступа к
  коннектору), `server/credential-bind-guard.ts` (guard привязки на границе —
  инвариант 16). Ф4 (роуты/UI/аудит/ротация/бэкап) — не реализован.
- `engine/mcp/credential-auth.ts` — ADR-105 Ф3: источник access-токена для
  MCP-транспорта (`McpCredentialSource`: `getAccessToken`/`refreshAccessToken`;
  реализация поверх порта — `reveal()`, наружу токен не отдаётся) и
  `createCredentialFetch` — добавляет `Authorization: Bearer <token>` в **каждый**
  HTTP-запрос коннектора с `auth: { kind: 'credential' }` и обновляет токен по
  `401` (refresh — **ровно один** на запрос; повторный `401` возвращается как есть).
  Ошибки — `McpCredentialError` (`not_found`/`revoked`/`reauthorization_required`/
  `no_refresh`/`unavailable`); значение токена в текстах ошибок не появляется.
- `server/chat.ts`, `server/proxy.ts`, `server/serialize.ts`,
  `server/connection-watcher.ts` — одиночный чат, проксирование remote, сериализация,
  watcher подключения. Проксирование — `REMOTE_PROXY_PREFIXES` (простые префиксы) +
  `REMOTE_PROXY_PATTERNS` (regex: nested `/api/v2/agents/:id/ssh-keys`; прочие
  подпути `/agents` — локальны). `server/serialize.ts` отдаёт в `status` сессии
  `cancel_requested`/`cancel_requested_at` (ADR-005); `server/routes/sessions.ts` —
  `POST /:id/abort` (надёжный «Стоп»: персистентный флаг + graceful `orchestrator.cancel`
  + `QueueProcessorManager.requestStop`; без процессора флаг снимается).
- `server/fs-workspace.ts` — резолв workspace проекта для FS-роутов
  (`resolveProjectWorkspace`, ADR-075) и детект бинарных файлов (`isTextFile`).
- `engine/orchestrator.ts` — `ChatOrchestrator` (цикл LLM + Tool Use); опциональная зависимость `isCancelRequested` (персистентный флаг сессии) останавливает многоитерационный Tool Use (верх `while (toolIteration < maxIterations)`), когда живой cancelToken недоступен. ADR-095 (шаг 6a): самостоятельные методы вынесены в `engine/orchestrator/*` (`usage`, `fs-change`, `errors`, `persistence`, `routing`, `prompt-info`, `commands`, `debug`, `summarization`) — класс делегирует через тонкие обёртки/`*Deps()`-геттеры; (шаг 6b-1): из `_processMessage` вынесены фазы `engine/orchestrator/phases/*` — `process-early.ts` (системные сообщения, `/`-команды, micro-first), `process-setup.ts` (подготовка запроса: провайдер → MCP → state → Composer → тулы), `process-finalize.ts` (эпилог: отмена/фоллбеки/quality-check+escalation/персист/`stream.done`/авто-тайтл); в `_processMessage` остались пролог-скаляры, тело цикла Tool Use и его обработчики. Сборка промпта (ADR-070): `getPromptInfo(session)` → `PromptDiagnostics` (manifest + `history` + `promptState` активного агента + `lastPromptMeta` + `toolsDetail`), `_buildPromptHistoryInfo` зеркалит `_sessionMessagesToLlm`; state-сообщения (`syncStateMessages`) превращаются в синтетические user-сообщения `<system-state>`; `promptStates[agentKey]` читается/пишется по generation, `_cachePolicy` (`llm.cache`) уезжает в `SystemPromptPayload`; `_filterToolsByMode` удалён — список тулов постоянен.
  **Seam-методы для движка пайплайнов (ADR-101):** `getComposer()` — тот же инстанс
  `SystemPromptComposer`, что у сессий (промпт агентского шага собирается той же
  подсистемой — иначе разойдутся блоки, политики и кэш-маркеры);
  `getInstructionsResolver()` — резолвер проектных инструкций ADR-069 (политика
  trust/dedup/лимиты общие; `null` — инструкции инстанса выключены);
  `wrapProviderWithGateway(provider)` — общая обвязка провайдера в `GatewayProvider`
  (ADR-036) для движков вне сессии — инвариант «любой LLM-вызов через gateway» сохраняется.
  **Шов точки `llmFilters` (Ф3б):** `getLlmFilters()` — реестр фильтров LLM-вызовов
  (`LlmFilterRegistry`) инстанса: **тот же экземпляр** уходит во все gateway-точки (основной ход,
  пул провайдеров, decision, оптимизатор/суммаризация) и в фасад плагинов
  (`PluginHostOptions.llmFilters`) — плагин регистрирует фильтр, gateway его применяет. Опции —
  `Options.llmFilters` (готовый реестр) и `Options.llmFilterTimeoutMs` (`plugins.llmFilterTimeoutMs`,
  бюджет новых регистраций); не задан реестр — создаётся пустой (поведение прежнее).
  Шаг пайплайна — не сессия, поэтому он работает с суженным контрактом Composer'а
  `ComposerSessionLike = Pick<Session, 'settings' | 'promptStates' | 'projectId'>`
  (`engine/context/composer.ts`) — обычная `Session` структурно совместима.
- `engine/gateway/*` — `GatewayProvider`, guard'ы, обфускация, аудит, rate limit; `decide()` — не-chat
  decision-вызов (ADR-084: guard/обфускация `state`, тот же `_prepare`/аудит, что у chat-путей).
  `SystemPromptPayload` (`stablePrefix`/`cacheKey`/`cachePolicy`, ADR-070) проходит через Gateway в
  провайдер без изменений — prompt-cache-маркеры ставятся в провайдерах **после** guard/обфускации.
  **Фильтры LLM-вызовов (точка `llmFilters`, ADR-090, Ф3б):** `llm-filter-registry.ts` —
  `LlmFilterRegistry` (fail-closed `register` + disposer, `unregister`/`get`/`list(phase)`/`size`/`clear`;
  метаданные владельца `trustLevel`/`pluginName`/`pluginVersion`/`onAudit`/`failMode`/`timeoutMs`;
  `canVetoLlmFilter` — вето только у trust ≥ `trusted`, `LLM_FILTER_VETO_TRUST_LEVEL`;
  `defaultLlmFilterFailMode` — блокирующий класс `closed`, наблюдательный `open`;
  `setDefaultTimeoutMs` — runtime-бюджет **последующих** регистраций, у зарегистрированных бюджет
  зафиксирован). Три фазы в `gateway-provider.ts`: `pre_request` (`_applyPreRequestFilters`, после
  `saveMap` — фильтр видит **обфусцированный** запрос; `redact` отклоняется хостом), `post_response`
  (`_applyPostResponseFilters` в `_auditCompletion` — **только наблюдение**, блокировка/правка требуют
  буферизации, ADR-036), `embedding` (`_prepareEmbedding` внутри `embed` — `deny` не пускает вызов,
  `redact` заменяет `texts`). Таймаут — `Promise.race` с `unref`-таймером; вердикт недоверенного
  понижается до `allow`. **`embed` больше не обходит контур:** эмбеддинги (в т.ч. микро-слой через
  `ProviderPool`) идут через `GatewayProvider` — дыра инварианта 3 закрыта. Аудит — `type: 'plugin_filter'`
  в аудите gateway (`filterId`/`filterPhase`/`filterTrust`/`filterVerdict`/`filterEffectiveVerdict`/
  `filterDowngraded`/`filterCode`/`filterTimeoutMs`, **без текста**); коды хоста
  (`plugin_filter.allowed`/`.timeout`/`.error`/`.redact_unsupported`/`.buffering_required`/`.redact_invalid`)
  живут только там, в журнал плагинов уходят лишь канонические `denied`/`deny_downgraded`/`unavailable`.
  `filters` прокидывается из оркестратора (`Options.llmFilters`/`llmFilterTimeoutMs`, шов
  `getLlmFilters()`) в пул, decision- и optimizer-gateway; пустой реестр — поведение прежнее.
- `engine/router/*` — routing моделей и micro-model слой (ADR-034/035); decision-слой — `DecisionContentClassifier` (`decision-content-classifier.ts`, ADR-084), `DecisionModel` в `micro/models/` (`kind='decision'`, per-session `decisionFirst`), единый каскад `decision-cascade.ts` (`decideChoiceCascade`: `primary → escalation` по необязательной паре `escalationProvider`/`escalationModel`, fail-safe) и агрегатные метрики `decision-metrics.ts` (синглтон `decisionMetrics`: `calls`/`handled`/`fallback`/`escalated`/`attempts`/`rejected`/`by_model`). Мультимодальный контракт (задел PROP-085): `MicroInput.images`/`videos`, `ClassifyRequest.images`/`videos`, `DecisionProvider.decide(opts.images/videos)` — добавляются в тело запроса только если непусты.
- `engine/permission/*` — permissions (`PERMISSION_GROUPS`; группа `plugin` — ADR-090 Ф3в: матчится
  **по источнику** `ToolSource` (`getToolGroups(toolName, capabilities, source?)`,
  `PermissionCheckInput.toolSource`), а не по capability, — плагин с `file_read`/`search` не
  «выписывается» из правила `plugin`); `engine/security/*` — injection/shell/protected paths; слой доступности (`engine/permission/availability.ts`, ось `ToolAccess` — ADR-070: `allow`/`ask`/`deny`/`unavailable(mode|role|dependency|workspace)`) учитывает причины `dependency` — нет внешней программы тула (`engine/tools/runtime-deps.ts`, ADR-078; источник — порт, ADR-077 шаг A) — и `workspace` — не задан рабочий каталог проекта для file/shell/git-тулов (`isWorkspaceDependentTool`, ADR-075); деталь недоступности (`ToolAvailability.detail` — «в пуле: N из M») доходит до текста deny в `evaluator.ts` и до модели через `UnavailableTool.detail` (`engine/context/state-messages.ts`); `security/crypto.ts` — AES-256-GCM и мастер-ключ секретов, `security/rotate.ts` — ротация мастера (ADR-076).
- `engine/context/*` — `ContextBuilder`, `ContextOptimizer`, `ContextConfig`, интервью (статус — поле `ProfileData.interviewCompleted`; блок `[INTERVIEW]` — только первое сообщение сессии от пользователя при незаполненном профиле и доступном агенту `profile_update`, гейт `interviewEligible`).
  Системный промпт (ADR-070): `composer.ts` — `SystemPromptComposer` (единственная точка сборки
  промпта основной сессии и саб-агентов: `compose()` идемпотентно собирает из состояния, `manifest()` —
  манифест источников; типы `ComposedPrompt`/`PromptBlock`, **`PromptBlockProvider`-шов**
  (`{ key, tier, order, load(ctx) }` — точка `promptBlocks`, ADR-090; имя `ContextSource` из
  `shared/types/provider.ts` — метаданные модели, к промпт-блокам отношения не имеет));
  `prompt-blocks.ts` — тиры `stable`/`context`/`volatile` и детерминированная склейка
  (`sortPromptBlocks`/`joinPromptBlocks`); `prompt-state.ts` — состояние промпта per-agent
  (`agentKeyOf`/`DEFAULT_AGENT_KEY`, `buildPromptState`/`computeExpected`/`validateExpected`, запись
  `session.promptStates[agentKey]` только при смене generation); `state-messages.ts` — chronological
  state-сообщения (`mode_change`/`plan_updated`/`todos_updated`/`agent_switch`, `syncStateMessages`,
  обёртка `<system-state type="…">`, `UnavailableTool`). Специализированные промпты debug-эха и
  `SUMMARIZER.{lang}.md` идут мимо Composer (inline). Манифест: system-блоки в реальном порядке +
  запись `tools` (`source: 'tools'`, в конце тира `stable`), `PromptHistoryInfo` — слой истории
  (`_buildPromptHistoryInfo` зеркалит `_sessionMessagesToLlm`).
  Профиль/интервью в промпте резолвит единый `_resolveProfile(userId)` (`loadProfile(userId) ??
  getProfileByUsername(userId)`; `session.userId` — username, профиль ключуется по id-UUID); `profilesStore`
  проброшен и в standalone `ContextBuilder` (`server/app.ts`, `server/chat.ts`).
  **Реестр блоков промпта (PROP-090 §«Точка `promptBlocks``, Ф3а).**
  `engine/context/prompt-block-registry.ts` — `PromptBlockRegistry`: реестр провайдеров блоков
  системного промпта; `register()` — **fail-closed** (пустой ключ / нечисловой `order` / занятый ключ /
  тир `stable` → `PromptBlockRegistrationError`), возвращает **disposer** (идемпотентный);
  `unregister`/`get`/`list`/`size`/`clear`. Провайдер (`PromptBlockProvider`,
  `shared/src/types/prompt-blocks.ts`) вызывается композером **раз в ход**; тир ограничен
  `context`/`volatile` **на уровне типа** — `stable` запрещён (граница prompt-cache, ADR-070 §2.1).
  Блоки провайдеров добавляются в `SystemPromptComposer._collectProviderBlocks` — **тот же** массив
  блоков, что и встроенные (один манифест, одна склейка, одна сортировка по тирам); при
  `session.settings.systemPrompt` (override) блоки **не добавляются**.
  Правила: ошибка провайдера → `warning` в лог, блок пуст, **ход не падает**; пустой результат →
  `status: 'empty'`; содержимое длиннее бюджета → хост обрезает (голова+хвост, свой маркер усечения
  без `read_file`) и ставит `status: 'truncated'`. **Бюджет символов блока** —
  `plugins.promptBlockMaxChars` (дефолт 4 000 — `DEFAULT_PROMPT_BLOCK_MAX_CHARS` в `shared`).
  **Контекст хода** (`PromptBlockContext`): `sessionId`/`agentRole`/`language`/`projectId?`/`mode` +
  `query?`/`turnId?`/`timestamp?`; `query` — **только текст сообщения пользователя** (не системные и не
  state-сообщения, не отключённые — `resolveTurnQuery`, `engine/orchestrator/prompt-info.ts`); история
  сессии наружу не отдаётся. Инвалидация состояния промпта: блоки провайдеров лежат вне тира
  `stable`, поэтому трек ведётся отдельно (`PromptBlock.source='provider'` →
  `PromptBlockState.provider`, `isBlockChanged` — как у блока `instructions`).
  Регистрация из плагина — `PluginFacade.registerPromptBlock` (`engine/plugins/activation.ts`,
  реализация — `PluginHost`): при отказе — предупреждение в лог, активация плагина не падает.
  Проектные инструкции (ADR-069): `instructions.ts` — `ProjectInstructionsResolver`
  (merged chain `git root → … → workspace`, кандидаты `AGENTS.override.md` > `AGENTS.md` >
  `agents.md` > `CLAUDE.md` (opt-in) > `CONTEXT.md` (deprecated); дедуп sha256;
  provenance `--- from … ---`; `waterFillAllocate` + `truncateHeadTail` с маркером `read_file`;
  `resolveInstructionsCap` — динамический кап; `config.sources` `before`/`after` + URL-fetch
  с TTL-кэшем `{dataDir}/instructions-cache`; `project-trust` (`skills.trustedProjectDirs` +
  авто-trust `workspacesRoot`) и install-tree guard; блочный резолвер `buildInstructionsInfo`/
  `createInstructionsInfoResolver` — снимок для `GET /api/v2/context/instructions`),
  `lazy-instructions.ts` — `LazyInstructionsLoader` (tool-result догрузка: `LAZY_TRIGGER_TOOLS`,
  `extractLazyTargetDir`/`extractShellDir`, ≤`lazy.maxAncestors` внутри workspace,
  `LAZY_INSTRUCTIONS_PREFIX`, реестры `loaded`/`claims` + sha256; резолвер stateless,
  состояние per-session — в оркестраторе, `seed()` инициализирует `loaded` из merged chain).
  Резолвится оркестратором и отдаётся composer'у как блок `instructions` тира `context`
  (ADR-070); per-turn мемоизация — `_resolveProjectInstructions(turnId)` в `engine/orchestrator.ts`.
- `engine/file-signature.ts` — ADR-069 (R5) / ADR-046: `filesSignature`/`dirsSignature`
  (`id:floor(mtimeMs):size`, отсутствующий кандидат — маркер `!`) для ленивой инвалидации
  кэшей (общий со скиллами).
- `engine/agents/*` — `AgentRegistry`, определения агентов, режимы, нормализация;
  `createAgentRegistry(toolRegistry, overridesDir)` — встроенные агенты + merge с файловым
  каталогом `{dataDir}/agents`; `registerStoredAgents(registry, agents)` — регистрация
  агентов из **стора** (ADR-096) в реестр при старте (merge как в `GET /api/v2/agents`:
  override встроенного выигрывает, custom регистрируется, `isOverridden: true`). Нужно,
  потому что при `storage.backend=postgres` стор агентов — БД, а `createAgentRegistry`
  читает только каталог: без этого агент, поставленный пакетом расширения (ADR-086),
  после рестарта не резолвился в Router (`agentTemplate` → `null`, сессия не создавалась).
  Вызывается в `server/app/deps.ts` и `backend/app/deps.ts` (обе сборки — async).
- `engine/authority/*` — ADR-106: слой полномочий (модель — `shared/types/authority.ts`).
  **`activation.ts`** — активация контента `provides.authority` пакета в **политику инстанса**
  (чистые функции; запись делает `server/routes/packs.ts`): активация — при одобрении пакета
  (`POST /packs/:name/approve`), снятие — при `DELETE /packs/:name` (идемпотентно, роли/привязки
  другого пакета остаются). Правила: **пересечение** с потолком инстанса (не дарование),
  **trust-floor** (мутирующие гранты — только при trust ≥ `trusted`; мутирующим считается всё,
  кроме `read` — признаку пакета не доверяют), **политика — источник истины** (роль из политики
  контентом не перезаписывается), **валидация, а не каст** (манифест проверяется до активации).
  Ось `agent` резолвера берёт роли агента из `policy.agents[]` (связи из контента пакета).
  **Политика — снимок при старте процесса**: резолвер собирается в `server/app/deps.ts` /
  `backend/app/deps.ts` из прочитанной политики; изменение после старта (в т.ч. активация
  контента) видно **только после рестарта** (инвариант 24).
- `engine/mcp/*` — `McpClient`/`McpManager`, настройки MCP; `executor-mcp-source.ts` +
  `executor-mcp-client.ts` — состав MCP-серверов пула исполнителей и вызовы их инструментов
  поверх HTTP API исполнителя (ADR-077, шаг B2): TTL снимка 120 с, а **неудачный** discovery
  (404/сеть/таймаут) повторяется через `EXECUTOR_MCP_SOURCE_RETRY_MS` (15 с) — иначе backend,
  стартовавший раньше пода исполнителя, «запоминал» пустой состав на весь TTL; успешный
  пустой ответ — валидный снимок и живёт до TTL.
  **`idle` = «ещё не поднят», а не «недоступен»** (ленивый старт исполнителя: сервер
  поднимает `GET /mcp/tools`, а `GET /mcp/servers` только показывает состояние): источник
  активирует сервер вызовом `/mcp/tools` и перечитывает `/mcp/servers` (после активации
  сервер `up`); ошибка активации не ломает снимок — сервер помечается `down` с причиной,
  остальные сохраняются, повтор через 15 с (не TTL). Иначе первый ход агента после раскатки
  исполнителя шёл без браузерных инструментов (тулы появлялись только к следующему ходу).
  Состав исполнителя обновляется **до** расчёта MCP-скоупа хода
  (`engine/orchestrator/phases/process-setup.ts` → `refreshExecutorServers`): иначе сервер,
  найденный в этом ходе, не попадает в список подключаемых (`ensureToolsLoaded`) и первый
  ход остаётся без тулов. В `inline` источника нет — поведение прежнее.
- `engine/skills/*` — discovery/реестр/каталог/загрузка/CRUD скиллов (ADR-046);
  гейты уровней (system/project/session) — `scope.ts` (`resolveSkillAvailability`,
  `skill.scope_disabled`), сид новых проектов — `seed.ts` (мастер `disabled` +
  `disabledForNewProjects`); ленивая инвалидация кэша по mtime/size — `watcher.ts`;
  per-skill права `permission.rules.skill` (allow/deny/ask + glob, наследование) —
  `permission/evaluator.ts`/`derive.ts`.
  **Формат `SKILL.md` (spec):** Markdown + толерантный YAML-frontmatter
  (`shared/src/skills/frontmatter.ts`, js-yaml; невалидный YAML → `issues` без throw,
  неизвестные ключи → `SkillMeta.extra`). Обязательные — `name` (1–64, `^[a-z0-9]+(-[a-z0-9]+)*$`, совпадает с
  именем каталога) и `description` (1–1024); опциональные — `license`, `compatibility`,
  `metadata`, `allowed-tools` (advisory), `when_to_use`, `model`, `agent`, `argument-hint`,
  `user-invocable` (default `true`), `disable-model-invocation` (default `false`);
  `metadata.synth.*` — `tags`, `category`, `related_skills`, `requires_capabilities`,
  `requires_toolsets`, `fallback_for_capabilities`, `agents`, `groups`, `scope`,
  `trigger`, `command`, `mode`. `invocation` — комбинация двух флагов: `both`/`user`/
  `model`/`none` (`scope.ts`). Невалидный скилл не попадает в реестр (ошибка в
  `GET /api/v2/skills?diagnostics=1`), discovery остальных не ломает. Встроенные
  (`builtin.ts`) — `skill-creator` и `synth-agents-md` (ADR-069: команда `/agents-md`,
  capability-aware `file_read`/`search`/`file_write`). Тесты —
  `engine/skills/*.test.ts`.
- `engine/commands/*` — slash-команды и bundles (ADR-046): `parser`/`template`/
  `discovery`/`registry`/`bundles`/`builtin`/`resolver`/`service`; резолвинг в core
  до LLM, событие `command.invoked`; per-command права `permission.rules.command`;
  локальные builtin-ответы — `Message.ephemeral` (вне LLM-контекста); inline shell
  (`` !`cmd` ``) — opt-in через `execute_shell`; встроенная `/init` (ADR-069) —
  prompt-команда генерации/обновления `AGENTS.md` (`INIT_INSTRUCTION_PATH`). Тесты — `engine/commands/*.test.ts`.
- `engine/tools/*` — `ToolRegistry` + встроенные тулы (fs, shell, git, search, web,
  plan, todo, project, task, skill, profile_update). Реестр держит **три слоя** по
  `ToolDefinition.source` (`builtin` | `mcp` | `plugin`, ADR-071 §2.1 + ADR-090):
  `registerPlugin(tool, pluginName)` — единственный путь регистрации плагинного тула, **атомарная**
  валидация с отказом `invalid_name`/`invalid_definition`/`invalid_capability`/`name_conflict`;
  имя всегда `plugin_<ns>_<tool>` (namespace — из `manifest.name`, хелперы в
  `shared/types/plugin-tools.ts`: `pluginToolFullName`/`pluginToolLocalName`), capability `mcp`
  (слой MCP) и `runtime` (примитивы ядра неотключаемы админом) зарезервированы, пустой набор
  capabilities — отказ. Выборка по слоям — `selectForSession` → `{ builtin, plugin, mcp }`
  (склейка промпта — `builtin → plugin → mcp`), `listPlugin(pluginName?)`/`pluginLocalNames()`;
  `deregister`/`deregisterByCapability` работают с плагинными как с обычными.
  git-тулы принимают необязательный `repo_path`
  (containment внутри `project.workspace`), SSH-окружение — `engine/tools/git-ssh.ts`
  (ADR-076; ошибки — `sshkey.env_failed`). Тул `task` (ADR-095 шаг 5) разбит на
  `engine/tools/task/*`: `tool.ts` (`taskTool`), `fork.ts` (fork/контекст-режимы ADR-026 +
  permissions), `child-session.ts` (создание/сообщения/события), `run-cycle.ts` (общий
  tool-loop `runSubagent`, используемый и `task-resume.ts`), `prompt.ts`, `args.ts`, `types.ts`;
  `task.ts` — фасад-реэкспорт. Тулы `task`/`task-resume` собирают промпт
  саб-агента (`resolveSubagentPrompt`) — проектные инструкции (ADR-069) добавляются,
  кроме `task(skip_context_files=true)`. Тулы управления проектом:
  `project_update`/`project_workspace_set` (`project-manage.ts`) и
  `project_repo_clone|init|add|fetch|remove` (`project-repos.ts`) — проект берётся
  из сессии, смена workspace/регистрация репозиториев сохраняются `ProjectStore.save`
  и публикуют `project.updated`; `project_update` валидирует `icon`/`color` по
  `PROJECT_ICON_KEYS`/`PROJECT_COLOR_KEYS` (невалидно → ошибка с перечнем ключей).
  Метаданные `icon`/`color` проекта и сессии — канонические ключи shared:
  валидация на записи (роуты `projects`/`sessions` → 400 `VALIDATION_ERROR`),
  сброс невалидных значений при чтении (`ProjectStore.load`, `FileStore.deserializeSession`,
  `remote/transfer`); у сессий — сквозной проход (`Session`, `SessionManager.createSession`
  и fork, `serializeSession`). Запись проектных данных (`project_log_write`/
  `project_invariants_write`/`plan_write`) гейтится `engine/tools/project-access.ts`
  (`canEditProject`, ADR-075/D5). `engine/workspace-provision.ts` — общий
  provisioning workspace (нормализация/containment/создание каталога) для
  HTTP-роутов и тулов (ADR-075). `engine/tools/runtime-deps.ts` — детект внешних
  бинарников (`git`/`rg`/`sh`; источник — **порт** (`probe()`), в inline — локальная
  проба; fail-open; кэш детекции — **по экземпляру порта**, `WeakMap`, TTL 60 с;
  снимок перечитывается ходом — `refreshRuntimeDeps`) и карта
  `TOOL_RUNTIME_DEP`; из неё же берутся бинарные требования тулов
  (`runtimeRequires()`/`toolRuntimeRequires()` → `ExecRequest.requires`); деталь
  недоступности — в `RuntimeDeps.details` («в пуле: N из M» в remote-режиме) и далее
  в `ToolAvailability.detail` → `UnavailableTool.detail` → текст модели. Отсутствие
  программы даёт `unavailable(dependency)` (ADR-078), тулы из реестра не удаляются.
  `profile_update` (`profile-update.ts`) — онбординг владельца сессии: сохраняет
  `display_name`/`email`/`phone`/`notes` и завершает интервью (`ProfileData.interviewCompleted`);
  capability `user` (отключаемая группа `user` в `permission/groups.ts`; выдана только агенту
  `assistant`), поэтому тул доступен не всем агентам и блок `[INTERVIEW]` инжектится только
  при доступном агенту `profile_update` (гейт `_interviewEligible` — `_availabilityPredicate` +
  `_isAdminDisabled`, fail-closed без тула); стор приходит через `ToolContext.extra.profilesStore`,
  нет владельца — понятная ошибка.
- `engine/llm-error.ts`, `engine/system-messages.ts` — таксономия ошибок и i18n-ключи.
- `engine/hooks/*` — `HookBus` (ADR-030): ядровая in-process шина хуков
  (`on/off/emit/emitAsync`, priority, `sync`/`async`, `builtin`), отдельная от
  session-`EventBus`. Политика `builtin` (Ф0 ADR-090): регистрация ядра (`builtin: true`)
  **не снимается** ни `off(name, handler)`, ни функцией отписки из `on` (отказ + лог, без
  исключения); явный путь владельца регистрации — `offBuiltin(name, handler)`; `removeAll()` —
  служебный (тесты). Пример — `analytics/hooks.ts` (подписки `builtin`, отписка `offBuiltin`).
  Эмиты: `pre_tool_use`/`post_tool_use`/`plan_approved`/`plan_rejected` (`plan_exit` с ошибкой)/
  `permission_denied`/`agent_spawned|completed|failed`/`session_start|end`/`session_requested`/
  `external_event`/`message_received` (только `role: user`, первая попытка, без текста)/
  `schedule_fired` (метаданные расписания, без текста задания). `callback` объявлен, но в core
  не эмитится — нет точки «нажатие инлайн-кнопки» (контракт внешнего канала, ADR-087/ADR-103).
- `engine/plugins/*` — ADR-090: загрузчик плагинов `PluginHost` и его пайплайн активации
  (**resolve → integrity → semver-гейт → trust/scan → политика режима → import → facade**).
  **Исполнение кода по умолчанию выключено** — `plugins.executionEnabled` (default `false`), шаг `import`
  останавливается явно. **Ф4а:** `inline`-загрузчик реализован (`inline-loader.ts`); **Ф5б-1: подключён** —
  `PluginRuntime` (`runtime.ts`) собирает хост с этим загрузчиком в `server/app/deps.ts` и
  `backend/app/deps.ts`, а `main.ts` обоих режимов делает **старт-активацию** установленного
  (`activateInstalled`, `executionEnabled=false` → no-op) и `dispose()` при остановке. Файлы: `plugin-host.ts`
  (`PluginHost`/`PluginHostOptions`/`DEFAULT_EXTENSION_CONTRACT_VERSION`; реестр активных плагинов,
  обратная прокрутка disposers, аудит **каждого** исхода — успех и отказ), `activation.ts`
  (контракты: `PLUGIN_ACTIVATION_STEPS`, `PluginActivationDescriptor`/`PluginActivationHandle`/
  `PluginActivationResult`/`PluginDeactivationResult`, `PluginDisposer`, `PluginFacade`,
  `PluginModule`, `PluginLogger`, `PluginLoadError`/`pluginLoadFailureReason` — машиночитаемая причина
  отказа шага `import`), `inline-loader.ts` (**Ф4а** — `createInlinePluginLoader`:
  `rootDir` обязателен, точка входа `join(rootDir, entry ?? 'dist/index.js')`, **containment** по
  `realpath` (`..`/абсолютный путь/симлинк наружу — отказ), расширение только `.js`/`.mjs`, предел
  `maxBundleBytes` (8 МиБ), cache-busting `?v=<contentHash|mtimeMs>`, формы модуля `apply` /
  `default.apply` / `default`-функция, иначе `plugin.module_invalid`; bundle-only — npm-зависимости
  не резолвятся, `@itphx/*` — external, их резолвит Node из `node_modules` ядра),
  `remote/*` (**Ф4б-1** — транспорт `out-of-process`): `client.ts` (`RemotePluginClient`:
  loopback-only `127.0.0.1`/`::1`/`localhost` и только `http://`, Bearer на
  `/capabilities`/`/invoke` (без токена — только `/health`), `AbortSignal.timeout` (5 000 мс),
  причина отказа из тела `{error:{reason,…}}` или HTTP-статуса, `RemotePluginUnavailableError`;
  токен **никогда** не пишется в `message` — тексты процесса редактируются), `loader.ts`
  (`createRemotePluginLoader`: `mode: 'remote'|'both'` иначе `plugin.loader_unavailable`,
  `PluginActivationDescriptor.remote {url, token}`, `capabilities()` **до** активации,
  прокси-провайдеры `promptBlocks`/`llmFilters`; ответ блока — строка/`{content}` ≤ 64 КиБ,
  вердикт — по `LLM_FILTER_VERDICTS` + `redactedContent`/`redactedTexts`; ошибки **вызова**
  пробрасываются — композер/gateway деградируют, `failMode` фильтра применяет gateway),
  `index.ts` — баррел. Управление процессом (spawn/health-ожидание/stop, файл токена) — **Ф4б-2**,
  точка `tools` — **Ф4б-3** (`points.tools[]` → `facade.registerTool`: локальное имя, JSON-Schema из
  протокола как `jsonSchema`, «проницаемая» zod-схема `z.object({}).passthrough()` вместо локальной
  валидации; `execute` → `POST /invoke` `{parameters, context:{sessionId,messageId,workingDir}}`;
  ответ `{content, isError?}`, `isError: true` — контент без броска, сеть/таймаут — бросок);
  `PluginActivationDescriptor.remote` заполняет установка,
  `integrity.ts` (`computePluginContentHash`/
  `verifyPluginIntegrity`), `exact-host-exceptions.ts` (`readExactHostExceptions` — файл точных
  исключений семвер-гейта: **одна полная semver-версия host в строке**, `#` — комментарий,
  не-semver строка пропускается с предупреждением, недоступный файл → исключений нет
  (fail-closed)), `index.ts` — баррел. **Коды отказа** (`PLUGIN_AUDIT_REASONS`,
  `shared/src/types/plugin-audit.ts`, всего **29**): `plugin.not_found` (resolve),
  `plugin.source_unavailable` (Д1 — источник бандла недоступен или не прошёл проверку целостности:
  локальный путь/архив не распакован, npm без SRI / с несовпадением SRI-sha512 или shasum, URL без pin
  или с несовпадением sha256; отказ **до** гейтов установщика), `plugin.manifest_invalid` (resolve),
  `plugin.integrity_mismatch`/`plugin.integrity_unverifiable` (integrity),
  `plugin.contract_mismatch`/`plugin.host_mismatch` (semver), `plugin.trust_below_floor`/
  `plugin.scan_rejected`/`plugin.approval_required` (trust/scan), `plugin.disabled`/
  `plugin.not_allowlisted`/`plugin.denylisted`/`plugin.runtime_install_denied` (policy),
  `plugin.scan_disabled_with_execution` (trust; Ф3а — **fail-closed**: `plugins.scan='disabled'` вместе
  с `plugins.executionEnabled=true` → отказ, исполняемый код обязан быть просканирован),
  `plugin.execution_disabled`/`plugin.loader_unavailable`/`plugin.module_invalid` (import — Ф4а:
  модуль загружен, но контракт `PluginModule` не выполнен), `plugin.already_active`,
  `plugin.not_active`, `plugin.disposer_failed`, `plugin.provides_mismatch` (facade; Ф3б — объявленное в
  `provides` не совпало с фактическими регистрациями, см. ниже), `plugin_filter.denied`/
  `plugin_filter.deny_downgraded`/`plugin_filter.unavailable` (журнал решений фильтров), `plugin.hybrid_not_allowed` (Ф7 — серверная allow-list гибрида запрещает активацию). Seam'ы:
  `PluginScanHook` (**Ф2 — закрыт**,
  дефолтная реализация встроенная), `PluginLoader` (**Ф4а — `inline` реализован**; **Ф4б-1 —
  `remote`-загрузчик `createRemotePluginLoader`**; управление процессом — Ф4б-2), `PluginFacade`
  (**Ф3а — `registerPromptBlock`**: регистрация провайдера блока промпта с возвратом disposer'а;
  **Ф3б — `registerLlmFilter`**: регистрация фильтра LLM-вызовов от имени плагина — хост подставляет
  `pluginName`/`pluginVersion` и **фактическое** доверие активации, `onAudit` пишет в журнал плагинов;
  **Ф3в — `registerTool(def: PluginToolDefinition)`**: инструмент плагина под namespace-именем
  `plugin_<ns>_<tool>` (имя составляет **хост**, плагин передаёт локальное); отказ любой точки —
  предупреждение в лог, активация плагина не падает).
  **Сверка `provides` (Ф3б).** После `apply()` и **до** фиксации активации `PluginHost` сверяет
  `provides.promptBlocks[]`/`provides.llmFilters[]` с фактическими регистрациями (`diffPackProvides`):
  расхождение в любую сторону (`missing`/`unexpected`) → **отказ** `plugin.provides_mismatch` с обратной
  прокруткой disposers (отклонённый плагин не оставляет блоков/фильтров/тулов в живых реестрах).
  Отклонённая регистрация (например, тир `stable`) «зарегистрированной» не считается.
  **Ф3в:** сверяются все три вида — `provides.promptBlocks[]`, `provides.llmFilters[]`,
  `provides.tools[]`; тулы — по **локальным** именам (в манифесте `"tools": ["memory_search"]`, в реестре
  `plugin_<ns>_memory_search`). Опции хоста: `promptBlocks` (**Ф3а**), `llmFilters` (**Ф3б**, тот же
  экземпляр, что у `GatewayProvider`, — `orchestrator.getLlmFilters()`), `tools` (**Ф3в**, общий
  `ToolRegistry` — тот же, что у оркестратора и permission-слоя); не переданы — точка недоступна
  (предупреждение, no-op).
  **Контрактный suite расширений (Ф3в).** `engine/plugins/contract/*` — «паспорт» плагина по образцу
  `storage/contract/*`: `describePluginContract(name, make)` + `PluginContractHarness` (операции:
  `activate`/`deactivate`/`composeSystem`/`manifest`/`runPreRequest`/`checkPermission`/списки реестров) +
  8 фикстур (`fixtures.ts`: эталон с блоком/пустым блоком/двумя фильтрами/тулом и «плохие» —
  `stable-block`, `bad-phase`, `bad-verdict`, `provides-mismatch`, `unknown-capability`,
  `reserved-tool-name`, `untrusted-deny`). Проверки: тир/ключи/бюджет блоков; порядок и `failMode`
  фильтров; namespace, источник `plugin` и **прохождение через permission-слой** тулов; сверка
  `provides` (все три вида); **dispose-дисциплина** (после `deactivate()` ни одной регистрации);
  запрет обхода (неизвестная/зарезервированная capability, заявленный trust не повышает фактический).
  Suite работает только через операции харнесса, поэтому **параметризован транспортом** (Ф4б-3):
  `PluginContractHarness.transport: 'inline' | 'remote'`, сборка — `contract/harness.ts`
  (`createContractHarness({transport, loader|loaders, descriptorExtra, cleanup})`, общая часть —
  реестры/композер/gateway/permission-слой). Прогоны: `engine/plugins/plugin-contract.test.ts`
  (in-memory, `createFixtureLoader`) и `engine/plugins/plugin-contract-remote.test.ts`
  (`loaders.remote` + **реальный** `node:http` на `127.0.0.1:0`: `/health`/`/capabilities`/`/invoke`
  по фикстуре, сервер на фикстуру поднимается лениво и закрывается в `dispose()`) — по 23 проверки
  (46 суммарно). Различие транспортов одно: невалидный вклад отклоняет реестр при регистрации
  (inline) либо `checkPluginCapabilities` на `/capabilities` (remote, fail-closed) — suite проверяет
  «регистрации не появилось + причина названа» (`refusalText`).
- `engine/plugins/scan/*` — ADR-090 / PROP-068 §4.3: встроенный статический сканер расширений
  (**advisory**: код не исполняется, сканер лишь выносит вердикт; блокирует матрица install-policy).
  Файлы: `rules.ts` (таблица правил `PLUGIN_SCAN_RULES` по 7 категориям — 6 базовых + `invisible_unicode`;
  `INVISIBLE_UNICODE_PATTERNS` — zero-width/bidi/unicode-tag/soft-hyphen), `scanner.ts`
  (`scanPluginFiles`/`scanPluginDirectory`; бинарники по расширению и по NUL-признаку; исполняемый
  файл → `high`, обычный бинарник → `info`; квоты; словарный детектор IPI — **существующий**
  `engine/security/prompt-injection.ts`, свой словарь не заводится; content-hash — **та же** функция
  `computePluginContentHash`, что и в шаге integrity), `ignore.ts` (`.skillignore` в стиле gitignore:
  `#` — комментарий, `!` — отрицание, `/` — только в корне, `*`/`?`/`**`, «последнее совпадение
  выигрывает»), `cache.ts` (`PluginScanCache`, ключ
  `sha256(версияПравил\0source\0sourceUrl\0contentHash)` — **версия правил входит в ключ**
  (`PLUGIN_SCAN_RULES_VERSION`, `shared/src/types/plugin-scan.ts`): при изменении правил сканера старый
  вердикт из кэша **не переиспользуется** — идёт пересчёт; **in-process**, FIFO 100 записей),
  `hook.ts` (`createPluginScanHook` — дефолтная реализация seam'а
  `PluginScanHook`), `index.ts` — баррел. **Квоты** (`PLUGIN_SCAN_QUOTAS` + `PLUGIN_SCAN_QUOTA_SEVERITIES`,
  `shared/src/types/plugin-scan.ts`): 50 файлов / 1024 КиБ суммарно → `medium` (вердикт не выше `caution`),
  256 КиБ на файл → `high` (`dangerous`).
- `engine/plugins/layout.ts` — ADR-090: раскладка слоя плагинов на диске. `resolvePluginLayout`
  (приоритет корня: явный home > env `SYNTH_HOME` > `{dataDir}/plugin` — ADR-079) →
  `<home>/plugin/{installed,quarantine,plugins.lock.json,plugins.json}`; `pluginInstalledDir`/
  `pluginQuarantineDir` (`<name>@<version>`); `stagePluginBundle` (решение install-policy: `allow` →
  в `installed/` + `PLUGIN_INTEGRITY.json`; `ask`/`block` → остаётся в `quarantine/`, в `installed/`
  **не попадает**); `releaseFromQuarantine` (перенос из карантина после подтверждения владельца).
  `PLUGIN_INTEGRITY.json` (Ф5а) хранит не только `sha256`/`source`/`fetched_at`, но и `trust_level?`/
  `install_kind?`/`identifier?`/`ref?` — иначе подтверждение из карантина не знало бы фактическое
  доверие (его резолвит источник, не манифест).
- **Бюджеты слоя плагинов (долги Д3).** `OrchestratorOptions.promptBlockMaxChars` → `ComposerContext`
  (`plugins.promptBlockMaxChars`; до Д3 ключ **не доходил** до композера и бюджет всегда был дефолтным);
  `OrchestratorOptions.llmFilterTimeoutMs` → `LlmFilterRegistry`. Живое применение —
  `setPromptBlockMaxChars` (со следующего хода) и `setLlmFilterTimeoutMs` (последующие регистрации
  фильтров) через `onPluginsChange` роута `/api/v2/settings/plugins` (эффективный `mergePluginsConfig`).
  Остальные ключи секции — только рестартом (инвариант 24).
- `engine/plugins/runtime.ts` — **Ф5б-1: `PluginRuntime`** — сборка слоя плагинов на инстанс:
  раскладка (`resolvePluginLayout`), порты `StorageContext.pluginAudit`/`pluginLock` (ADR-096), `PluginHost`
  (с `createInlinePluginLoader` по умолчанию), `PluginInstaller`; реестры `promptBlocks`/`llmFilters`/`tools`
  — **те же экземпляры**, что у оркестратора и композера (иначе вклады попадут в «теневой» реестр).
  `activateInstalled({actor})`: lock (порядок по имени) → дескриптор (`rootDir` из раскладки,
  `entry`/`content_hash`/`trust_level` из записи, `installKind: 'deploy'`, `files` — `collectBundleFiles`,
  иначе шаг integrity отклонит плагин) → `host.activate`; уже активные пропускаются; **никогда не бросает**,
  сбой одного плагина не мешает остальным; `executionEnabled=false` → `[]`. `list()` — установленные +
  `active`/`mode` (карантин не входит); `activate(name)`/`deactivate(name)` — по lock без броска
  (`plugin.not_found`/`plugin.not_active`); `dispose()` — деактивация в обратном порядке.
  `OrchestratorOptions.promptBlocks` прокидывается в `SystemPromptComposer` — **один** реестр на инстанс
  (до Ф5б-1 композер создавал собственный, и блоки плагинов в промпт не попадали).
- `engine/plugins/installer.ts` — **Ф5а: `PluginInstaller`**, сервис установки/подтверждения/снятия
  (API/CLI — Ф5б/Ф5в). `installFromDirectory({dir, trustLevel, source, identifier?, ref?, installKind?,
  activate?, actor?})`: порядок **манифест (`validatePackManifest`, `kind: 'plugin'`) → состав бандла и
  content-hash → fail-closed (`scan=disabled` + `executionEnabled`) → trust-floor → скан →
  `runtimeInstall=deny` → install-policy**; `allow` → `installed/<name>@<version>/` + `lock.save` +
  аудит `install`; `ask` → `quarantine/…` (lock **не** пишется, аудит `install/rejected`
  `plugin.approval_required`); `block`/`dangerous` → `plugin.scan_rejected`. `approve(name, {version?,
  activate?})` ищет lock, затем карантин; сверяет `PLUGIN_INTEGRITY.json` с фактическим хешем
  (`plugin.integrity_mismatch`/`plugin.integrity_unverifiable`), повторяет гейты и переносит
  `releaseFromQuarantine` только без `block`; нет данных доверия → fail-closed `community`.
  `uninstall(name, {removeFiles?})` — деактивация активного (`host.deactivate`) → `lock.delete` →
  `rm -rf installed/<name>@<version>` и одноимённого карантина → аудит `uninstall`; повтор —
  `{removed:false}` без записи. `activation: true` вызывает `host.activate` с `rootDir`/`files`/
  `contentHash`/`entry`; отказ активации установку не отменяет. **Правило `entry`**:
  `dist/index.js` → первый по алфавиту `.js`/`.mjs` в `dist/` → `dist/index.js`. Состав бандла:
  рекурсивный обход (сортировка, симлинки/`node_modules`/`.git` пропускаются, `PLUGIN_INTEGRITY.json`
  исключён); бинарные файлы не входят в `files`/content-hash, но **копируются байтами** при
  установке (`PluginBundleStageInput.binaryFiles`/`sourceDir` → `mkdir -p` + `copyFile`, containment
  относительного пути) — поэтому хеш совпадает с `scanPluginDirectory`, а ассеты не теряются.
  После успешной установки новой версии каталог предыдущей удаляется (`_cleanupPreviousVersion`),
  **кроме** случая, когда плагин активен (модуль загружен в процесс) — тогда остаётся + warning. Идемпотентность: lock —
  upsert по имени (`installed_at` иммутабелен, `updated_at` обновляется); другая версия заменяет
  запись, каталог прежней версии остаётся (известное ограничение, чистка — Ф5б).
  **Д1 — `installFromSource(request)`** (`PluginInstallFromSourceRequest`: `kind`/`ref`/`version?`/
  `sha256?` + `trustLevel`/`installKind?`/`activate?`/`actor?`/`sourceContext?`): резолвит источник
  (`sources.ts`) → `installFromDirectory` с `source`/`identifier`/`ref` резолвера → `cleanup()` в
  `finally` (ошибка уборки — warning); ошибка резолвинга → `plugin.source_unavailable` (аудит
  `install/rejected`), на диск ничего не пишется.
- `engine/plugins/archive.ts` — **Д1: свой tar-ридер и распаковка** `.tar.gz`/`.tgz` **без новых
  зависимостей** (`node:zlib` + разбор tar; `node:zlib/promises` в Node нет — `promisify`).
  `extractPluginArchive(bytes, {limits?, stripPrefix?, destDir?})` → `{dir, files, totalBytes, cleanup}`:
  блоки 512, ustar/pax (`x`/`g`)/GNU long name (`L`), **только** обычные файлы (`0`/`NUL`/`7`) и каталоги
  (`5`); симлинки/hardlink/устройства/FIFO — отказ; путь нормализуется (`\`→`/`, `./`), отклоняются
  абсолютный путь, `..`, windows-диск (`C:`), NUL, пустое имя файла, длина > `maxPathLength`; лимиты
  **500 записей / 16 МиБ файл / 64 МиБ сумма** проверяются по заголовку до записи (плюс
  `maxOutputLength` у `gunzip` — защита от бомбы); `stripPrefix` срезается только если **все** записи
  под ним (иначе «неожиданная раскладка архива»); `destDir` по умолчанию `mkdtemp(<tmp>/synth-plugin-)`,
  финальная проверка `resolve(destDir, rel)` на containment; `cleanup` идемпотентен. Модуль **не**
  переиспользует `maintenance/archive.ts` (ADR-091): там симлинки пропускаются и pax не разбирается.
- `engine/plugins/sources.ts` — **Д1: резолвинг источников установки** `dir`/`archive`/`npm`/`url`
  (`PLUGIN_INSTALL_SOURCE_KINDS`, `inferPluginSourceKind`, `isValidNpmPackageName`,
  `PluginSourceError` с `code: invalid_request|network|integrity|archive`). `dir` — обязательный
  `synth.pack` (иначе отказ), `cleanup` — no-op; `archive` — лимит `maxDownloadBytes` (32 МиБ) и
  `ref: sha256:<hash архива>`; `npm` — имя по
  `^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`, metadata `https://registry.npmjs.org/<name>`
  (scoped → `@scope%2Fname`), **обязательный** `dist.integrity` (SRI `sha512`) + `dist.shasum` при
  наличии, `stripPrefix: 'package'`, `ref` — точная версия; `url` — только `https:` и **обязательный**
  `sha256` (64 hex), `ref: sha256:<hash>`. Сеть — **только** `ctx.fetch ?? egressFetch` (ADR-099),
  `redirect: 'manual'`, до 3 переходов с повторной проверкой `https:`, не-2xx → отказ, таймаут 30 с,
  тело читается стримом с подсчётом байт. В раскладку плагинов ничего не пишет — только tmp-каталог.
- `cli/plugin-commands.ts` — **Ф5б-3: CLI `synth plugin *`**. `createPluginCommand` (группа `plugin`:
  `list` (`--json`), `install <ref>` (`--source dir|archive|npm|url` — по умолчанию вид выводится по
  `<ref>`; `--version`/`--sha256`/`--trust`/`--activate`/`--yes` — источник: каталог, `.tgz`/`.tar.gz`,
  npm-имя или https-URL; `--sha256` обязателен для `url`), `approve`, `enable`,
  `disable`, `remove` (`--keep-files`/`--yes`), `scan <path>` (dry-run)) и `createPluginCliContext`
  (сборка: `loadConfig` → `resolveHome`/`resolveDataDir` → `resolvePluginLayout` → `buildStorageContext`
  с `pluginLockPath` из раскладки → `mergePluginsConfig(config, runtime)` → `PluginRuntime`; при
  `backend=postgres` — тот же путь, что `doctor`/`backup`). Контекст освобождается в `finally`
  (`dispose` + `close`), коды — `process.exitCode`: `0` успех/карантин, `1` отказ (код причины в stderr).
  **`install` — офлайн-операция**: передаёт `installKind: 'deploy'`, поэтому `plugins.runtimeInstall`
  к ней не применяется; изменения — после рестарта (инвариант 24). `enable`/`disable` в одноразовом
  процессе проверяют пайплайн, но не переключают живой инстанс (для этого API/UI). Подключён в
  `main.ts` **и** `packages/synth/src/cli.ts` (subpath-экспорт `./cli/plugin-commands.js` — точный путь,
  wildcard не резолвится TS).
- `server/routes/plugins.ts` — **Ф5б-2: HTTP-контур плагинов**. `createPluginsRoutes(auth, deps, opts)`:
  `GET /`, `GET /:name` (манифест + `PLUGIN_INTEGRITY.json` — best-effort, порча не даёт 500),
  `POST /install` (`201`/`202`/`400`/`403`/`409`/`502`; тело `{source?, path?, name?, version?, url?,
  sha256?, trustLevel?}` — вид источника выводится из полей, старое `{path}` = `dir`; метка `source` в
  lock — результат резолвинга; `plugin.source_unavailable` → `400` локально / `502` сетево),
  `POST /:name/approve`, `/:name/enable`, `/:name/disable`, `DELETE /:name`
  (идемпотентно), `POST /update` (**501**, долги Д2). Таблица `PLUGIN_REASON_HTTP` (причина → HTTP) и
  `httpStatusForRejection` — **единственное** место маппинга. `createPluginSettingsRoutes` —
  `/api/v2/settings/plugins` (`pluginsConfigSchema.partial().strict()`, неизвестный ключ → 400,
  `restartRequired: true` всегда — рантайм собирается при старте, инвариант 24). Монтаж: core —
  `requireAuth` + `localInstall: true`; managed — ADMIN, install/enable — scope `addons:install`, approve и
  DELETE — только ADMIN, `localInstall: false` (запрещает **только** локальные `dir`/`archive`;
  сетевые `npm`/`url` разрешены — это не путь с ФС хоста). Опция `sourceContext` — инъекция
  сети/лимитов источников (тесты). ⚠️ Backend импортирует core из `dist` — после правок
  `server/routes/*` обязателен `pnpm --filter @itphx/synth-core build` перед backend-тестами.
- **Гибридный контур плагинов (Ф7).** `engine/plugins/hybrid-policy.ts` — `resolvePluginServerPolicy`
  (эффективная политика инстанса), `describePluginServerPolicy` (представление для API: список имён
  — только при `mode: 'allowlist'`), `pluginServerPolicyStatus`; контракт — в `shared`
  (`types/plugin-hybrid.ts`: публичный сигнал `{enabled, mode}`, статусы
  `unverified|allowed|denied`, `PLUGIN_ID_HEADER` = `X-Synth-Plugin-Id`, `PLUGIN_INVOKE_SCOPE` =
  `plugins:invoke`). **Уровень 1 (cooperative):** `PluginHostOptions.serverPolicy` — резолвер
  серверной политики; в шаге `policy` активации режим `allowlist` без плагина в списке → отказ
  `plugin.hybrid_not_allowed` (HTTP 403), политика неизвестна → активация проходит, а
  `PluginRuntimeEntry.serverPolicy` = `unverified` (маркер «не проверен сервером»). **Уровень 2
  (server-scoped токены):** `POST /api/v2/plugins/token` (выдача service-key с привязкой
  `plugin_id`; секрет единожды, at-rest sha256; `opts.tokenGuard` — ADMIN в managed) и
  enforcement на границе — `checkPluginTokenBinding`/`requirePluginTokenBinding`
  (`server/service-scope.ts`): заголовок `X-Synth-Plugin-Id` должен совпадать с `plugin_id`, scope
  `plugins:invoke` обязателен, `plugin_id` — в серверном allow-list при `mode: 'allowlist'`;
  fail-closed, отказы 403 `PLUGIN_ID_MISMATCH`/`SCOPE_REQUIRED`/`PLUGIN_NOT_ALLOWED`. Правило
  действует на все серверные API (guard вешается после `requireAuth`, где уже разрешён
  service-кредентал). Дискавери: `remote/connection.ts` — сигнал `plugins` из `/auth/oidc-meta` и
  `refreshPluginPolicy()` (полный allow-list из `GET /api/v2/settings/plugins`, кэш с TTL).
- **Managed deploy-time (Ф5в).** `engine/plugins/deploy.ts` — `listDeployPlugins(dir)`: подкаталоги =
  бандлы, манифест `synth.pack` валидируется, битый → запись пропущена с `warn` (разбор не ломается).
  `PluginRuntime.installDeployPlugins({actor})` — установка образных бандлов (**те же** гейты, что у
  обычной установки; `source: 'deploy'`, `identifier` = путь, `installKind: 'deploy'`, без активации);
  та же версия и тот же content-hash → `skipped`; ошибка одного бандла → `failed` + `warn`, старт не
  падает. Порядок в `main.ts` (оба режима): установка → активация. **Неприкосновенность:** плагин
  управляемый ⇔ `managedReadonly === true` **и** (`lock.source === 'deploy'` **или** `identifier`
  внутри `plugins.deployDir`); `uninstall`/`update` → отказ `plugin.managed_readonly` (**28** кодов),
  API → 403, CLI → код 1.
- **Транспорты исполнения (Ф4б-1/Ф4б-2/Ф4б-3).** `engine/plugins/remote/*`: `client.ts`
  (`RemotePluginClient` — **только loopback** `127.0.0.1/::1/localhost`, bearer на `/capabilities` и
  `/invoke`, таймаут через `AbortSignal`, токен вырезается из текстов ошибок), `loader.ts`
  (`createRemotePluginLoader` — режим `remote|both`, `descriptor.remote {url,token}` приоритетнее,
  `capabilities()` до активации, прокси-регистрация блоков/фильтров **и тулов** с валидацией
  ответов: тул регистрируется через `facade.registerTool` с JSON-Schema из протокола, `execute` →
  `POST /invoke` `{parameters, context}` → `{content, isError?}`),
  `process.ts` (`PluginProcessManager` — spawn `process.execPath` без shell, env **ровно**
  `PATH`/`NODE_ENV`/`SYNTH_PLUGIN_PORT`/`SYNTH_PLUGIN_TOKEN`, готовность по строке
  `SYNTH_PLUGIN_READY port=<n>` + опрос `/health`, адрес только `127.0.0.1`, `SIGTERM`→`SIGKILL`,
  токен-файл `{dataDir}/secrets/plugin-token` — `0600`, каталог `0700`, read-after-write ради общих
  PVC реплик). **Выбор транспорта** — в шаге `import` хоста (`_selectLoader`): `descriptor.remote` →
  remote; `manifest.mode` (`inline`/`remote`/`both`, дефолт `inline`); `both` → inline при наличии
  `dist/index.js`. Загрузчики — опция хоста `loaders: { inline?, remote? }` (`loader` = inline).
  `PluginRuntime` получает `loaders` и `processManager` — `dispose()` гасит процессы плагинов.
  В lock — `mode`/`remote_entry` (PostgreSQL: миграция `010_plugin_lock_mode`); `mode: remote` без
  `dist/server.js` → отказ `plugin.remote_entry_missing` (**27** кодов отказа).
- **Обновление и откат (долги Д2).** `PluginInstaller.update(name, {version?, sha256?, activate?})`:
  источник берётся **из lock** (`npm` → `identifier` + `version`/`latest`; `local` → существующий каталог
  (`dir`) или `.tgz|.tar.gz` (`archive`); `url` → `identifier` + **обязательный** новый `sha256`;
  `catalog`/прочее → `plugin.source_unavailable`); резолвинг → `collectBundleFiles` + hash → совпал с
  lock → **`unchanged`** (ни lock, ни `updated_at` не меняются); иначе `installFromDirectory` с
  `keepPrevious: true` (каталог прежней версии **не** удаляется, в lock пишется
  `previous = {version, content_hash, entry?, installed_at}` — **одна** ступень), затем активация по
  факту (был активен → деактивация старого модуля + активация нового; `activate` переопределяет).
  Доверие — из lock (не запрашивается заново); гейты — те же, что у установки. `rollback(name)`:
  ступень `previous` + каталог `installed/<name>@<prev>` обязательны (иначе `plugin.rollback_unavailable`
  — новый код), деактивация активного → **swap** (`version`/`content_hash`/`entry` ← `previous`,
  `previous` ← откатанная; `installed_at` иммутабелен) → аудит `rollback` → активация откатанной
  версии. Хранилище: `PluginLockEntry.previous` — файл/память как есть, PG — колонка `previous jsonb`
  (миграция `009_plugin_lock_previous`), кейс в контрактном suite порта.
- **Шаг trust/scan в `PluginHost` (Ф2).** Порядок: **trust-floor → скан → install-policy**.
  Trust-floor проверяется **до** install-policy (`plugins.trustFloor`; ниже порога — отказ
  `plugin.trust_below_floor` **при любом вердикте**). Скан — встроенный или подключённый хук
  (`PluginScanHook`): вердикт `dangerous` → `plugin.scan_rejected` (блок), `caution` →
  `plugin.approval_required` (**ask**, не блок) — по ячейке `kind: 'plugin'` матрицы install-policy
  (`installPolicyDecision`, `shared/src/types/plugin-scan.ts`). Сбой сканера — **fail-closed**
  (`plugin.scan_rejected`). При `plugins.scan: 'disabled'` сканирование **не выполняется**, вердикт
  `safe`, в аудите — `scanPerformed: false`; доверие при этом всё равно проверяется по trust-floor.
  **Аудит:** действия `install`/`activate`/`deactivate`/`rollback`/`uninstall`/`scan`/`filter`
  (`PLUGIN_AUDIT_ACTIONS`; порядок — жизненный цикл; `rollback` добавлен долгами Д2); запись получила
  поля `scanVerdict?`/`scanPerformed?`/`scanFindings?`.
- `engine/pipelines/*` — ADR-101: **второй движок** рядом с `ChatOrchestrator`
  (шаг пайплайна ≠ сессия; движок сам по себе не знает про HTTP/сессии/очередь).
  `engine.ts` — `PipelineEngine`: цикл прогона по опубликованной версии спецификации,
  выбор следующего узла (`planner.ts`: условные переходы по порядку → линейный переход,
  лимит `MAX_PIPELINE_TRANSITIONS`), условия (`condition.ts` — структурированный DSL
  `{path, op, value}`, fail-soft, без `eval`), маппинг входа шага (`mapping.ts`),
  пути (`paths.ts`), санитизация payload'а журнала (`payload.ts`), ретраи/таймауты шага,
  HITL-пауза (`awaiting_human`) и возобновление (`resume`), отмена через `AbortSignal`.
  `step-context.ts` — контекст шага (`buildPipelineStepContext`: проект, workspace,
  режим пайплайна, инструменты, MCP-скоуп, проектные инструкции, скиллы, агент шага);
  `permissions.ts` — permission-обёртка (`checkPipelineToolPermission` поверх
  `PermissionEvaluator.check()`; `ask` → гейт); `gate.ts` — помощники гейта и активный
  таймаут; `exits.ts` — `createPipelineExitHandler` (выходы `session`/`file`/`gateway`/
  `none`, containment файла по workspace, ADR-075); `types.ts` — `StepExecutor`/
  `StepOutcome`/`StepGateOutcome`. Исполнители — `executors/`: `tool-step.ts`
  (через `executeToolDef`), `script-step.ts` (только через shell-тул `execute_shell`),
  `human-step.ts` (HITL-вопрос с таймаутом), `agent-step.ts` (**свой Tool-Use-цикл внутри
  движка**: LLM — только через `GatewayProvider`; `ask` → гейт `tool_approval` →
  `resume` применяет одобрение к тому же вызову), `common.ts` (общая «проверка права +
  вызов тула»). Точки расширения: `StepExecutor` (по виду узла), `PipelineExitHandler`,
  зависимости `PipelineEngineDeps` (`projectStore`/`toolRegistry`/`mcpManager`/
  `instructionsResolver`/`agentRegistry`/`skillsCatalog`/`exits`/`metrics`) — глобальных
  синглтонов нет, сборка — в `server/app/deps.ts` (standalone) и `backend/app/deps.ts`
  (managed).
- `server/routes/pipeline-project-routes.ts` — ADR-101 (Э6): `createPipelineProjectRoutes`
  — единая фабрика (core + backend) для трёх контуров: пайплайны проекта
  (`/projects/:id/pipelines*` — создание, правка черновика, публикация неизменяемой
  версии, удаление), прогоны (`/pipeline-runs/:runId*` — заголовок + журнал, HITL
  `resume`, отмена `cancel`) и шаблоны инстанца (`/pipeline-templates*` — список и
  инстанцирование в проект). `legacyDefinitionToPipelineSpec` — конвертация
  legacy-определения ADR-100 в `PipelineSpec` **на лету при инстанцировании** (шаги
  `agent` → узлы `agent`; шаги `loop` не конвертируются — 409
  `PIPELINE_TEMPLATE_UNSUPPORTED`; миграций данных нет). Права — по правилам проекта
  (ADR-089 §5.5/§5.8): чтение — право чтения, запись — право изменения содержимого
  (инвариант 21); шаблоны — ADMIN; service-key — scope `automation:install` + проекция
  `allowedProjects`. Проверка доступа — **на границе** (guard), в обработчиках её нет
  (инвариант 16).
- `engine/events/*` — ADR-089: `EventRouter` (`allowedSources` → dedup → `EventBinding`
  → `RouteRuleProvider` → фоллбек: при `autoBind` и `identity.chatKey|threadKey` — `{kind:'bind'}`
  (auto-bind, `signals:['auto-bind']`), иначе по `defaultMode`: `bound` → `drop no_route`,
  `ephemeral` → временная сессия; `updateConfig` — live-обновление из runtime-настроек),
  `RequestSessionService` (единый funnel:
  explicit → `direct`, внешние → Router; резолвинг `agentTemplate` через
  `AgentRegistry` + политика `unknownAgentTemplate` `drop`/`default-agent`;
  `deps.bindingStore` — материализация `kind:'bind'`: постоянная сессия без `expiresAt` +
  `EventBinding{mode:'bound'}`, повтор/гонка → переиспользование привязки;
  `deps.resolveLlmDefaults` — добор дефолтных `provider`/`model` инстанса
  (`llm.defaultProvider`/`llm.defaultModel`) для `ephemeral`/`bind`/explicit;
  `deps.resolveDefaultAgent` — агент по умолчанию инстанса для событийной сессии без
  явного шаблона (`_resolveSessionAgent`: приоритет явного шаблона; `unknownAgentTemplate: 'drop'`
  → `agent_not_found`; без резолвера — `agentRole` не проставляется; проводка —
  core `createStandaloneApp`/backend `createBackendApp`: `getDefaultAgentId` — значение
  раздела «Агенты» поверх `DEFAULT_AGENT_ID`);
  `_maybeReassignOwner` — при доставке в **существующую** сессию (`kind:'bound'`, `kind:'bind'`
  с найденной привязкой) владелец-человек из `deps.resolveExternalIdentity` переустанавливается,
  если текущий пуст/машинный (`service:<keyId>`), сессия сохраняется и уведомляется хаб
  (`onSessionMaterialized`); «чужой человеческий» владелец не трогается, несопознанный/ошибка — fail-safe;
  `deps.resolveExternalIdentity` — резолвинг внешнего отправителя (`identity.principalId`)
  в пользователя инстанса (человек-владелец, приоритетнее чата; профильная ветка возвращает
  и `roles` профиля — базу эффективных прав, ADR-089 этап 5);
  `deps.identityMap` — маппинг `identity.principalId`/`chatKey` на владельца сессии;
  `deps.issueIdentityClaim` — выпуск одноразового claim-кода неизвестному отправителю
  (вызывается в `handleEvent`, когда резолвер вернул `null` и задан `identity.principalId`;
  результат — `identityHint` в ответе ingest, ADR-089 claim-flow);
  `deps.onSessionMaterialized` — колбэк после создания сессии до доставки (подписка хаба);
  `updateConfig` — live TTL/политика/identityMap),
  `identity-roles.ts` (ADR-089 этап 5: `resolveEffectiveRoles(profileRoles, identityRoles)` →
  `{roles, linked}` — эффективные роли внешнего отправителя: база — роли профиля, `identity.roles`
  только **сужают** (пересечение, не повышают), несопознанный (`profileRoles === null`) → `[]`/
  `linked:false` (fail-closed); `normalizeRole` — trim+upper. `RequestSessionService.handleEvent`
  считает роли **от самого отправителя** (`_resolveDeliveryContext`, резолвер внешней идентичности;
  ошибка резолвера → fail-closed `[]`) и передаёт их в `deliver` контекстом
  `EventDeliveryContext {roles, linked}` — `deliver` (core/backend) пишет `metadata.effective_roles`/
  `identity_linked`. **Роль-оси в permission-слое (`PermissionEvaluator`, ADR-029) нет — by design:**
  роли = доступность **эндпоинтов** (HTTP), внутри сессии тулы/разрешения одинаковы для всех (режим,
  capabilities агента, MCP/скиллы). Роли доставляются в ход для аудита/attribution; машинный доступ
  интеграций сужается scoped **service-key** (ADR-052). Практический эффект:
  права машинного аккаунта шлюза не раздаются внешним отправителям),
  `external-identity.ts` (`createExternalIdentityResolver({profiles, getIdentityMap})` — резолвер
  внешнего отправителя → `{userId, displayName?, roles?} | null`: override `identityMap` (по `principalId`,
  затем `chatKey`; роли не несёт) → профиль по `parsePrincipalId` (`identities`, + роли профиля);
  `getIdentityMap` — геттер для live-обновления runtime-настройки; без кэша),
  `EventIngress` (ingest/нормализация), `RouteRuleProvider` (seam),
  `ProjectRuleProvider` (правила `match` → `target` из `RouteRuleStore`; в цели
  `ephemeral`/`bind` — необязательное поле `pipeline: {id, step}` («ссылка на шаг
  пайплайна: эта сессия — шаг `step` пайплайна `id`») — **семантическое** поле
  (учёт экземпляров пайплайна и гейты), в `bound`/`queue` отвергается схемой),
  `DecisionRuleProvider` (`decision-rule-provider.ts`, ADR-084: decision-шаг после project-правил при
  `events.decisionRouting`, fail-safe → `null`; на успехе — лог `info('DECISION', …)` с агентом/уверенностью/
  порогом/моделью/latency, промахи — `warning` с latency; мета `confidence`/`signals` уезжает в решение),
  `target-decision.ts` (`decisionFromTarget` — единый маппинг цели, приклеивает `confidence`/`signals`;
  `pipeline` прокидывается в решение),
  `EventDelivery` (`run`/`defer` + необязательный `EventDeliveryContext {roles, linked}`), `credential.ts` (`EventKeyCredential` — контекст машинной
  аутентификации по API-ключу привязки: `keyId`/`bindingId`/`rateLimitPerMinute`, задел `scopes`/`principalId`),
  `key-rate-limiter.ts` (`KeyRateLimiter` — in-memory fixed-window 60 c per-key, ADR-089/ADR-052),
  `journal-prune.ts` (`startEventJournalPruner` — retention-очистка журнала: prune на старте и
  каждые 6 ч, `journalRetentionDays <= 0` — без ограничения), `types`. Хуки не
  эмитят — это делает `RequestSessionService`/оркестратор. `dedup-store.ts`
  (ADR-051/ADR-089): `DedupStore` — `MemoryDedupStore` (in-process `Set`, default) и
  `FileDedupStore` (межпроцессный атомарный claim `{dataDir}/events/dedup/<sha256(key)>`).
- `engine/scheduler/*` — ADR-051: `SchedulerService` (тикер `unref`, in-flight guard
  по `scheduleId`, catch-up на старте, Job-история, force-run `runNow`),
  `SchedulerRuleProvider` (cron-событие → `bound`/`queue`/`ephemeral`/`drop`),
  `cron.ts` (5 полей UTC), `duration.ts` (`30s|15m|1h|24h`), `schedule-time.ts`,
  `leader.ts` (`SchedulerLeader`: `AlwaysLeader` default / `FileLeader` — file-лок
  `{dataDir}/scheduler/leader.lock`); публикует `{source:'cron', type:'schedule_fired'}`
  через `EventIngress`, а перед публикацией (при наличии подписчиков) эмитит хук
  `schedule_fired` (async, метаданные расписания — `scheduleId`/`name`/`target`/`cron`/`trigger`,
  без текста задания; шина — `SchedulerServiceDeps.hooks`, ADR-030/Ф0 ADR-090).
  Тикер стартует только у лидера (`scheduler.leaderElection`).
- `engine/fs-change.ts` — `resolveFsChange`: классификация мутирующих тулов → событие `fs.changed` (scope `file`/`all`, `workspaceChanged`, `op: 'write'|'delete'|'mkdir'|'move'` для файловых тулов; `move` (`from`/`to`) выделяется из простой `mv`/`git mv` в `execute_shell`, вне workspace/непростая команда → `{scope:'all'}`); read-only → `null` (событие не публикуется).
- `git/*` — `git-service.ts` (clone/init/fetch/remove/log, `simple-git`) и
  `ssh-env.ts` (`GIT_SSH_COMMAND`, temp-ключ `0600`; passphrase — askpass-скрипт
  `0700` + `SSH_ASKPASS_REQUIRE=force`, `env_failed`). ADR-099: доверие CA для
  git-over-https — `simpleGit({ config: ['http.sslCAInfo=<path>'] })` из
  `gitCaConfig()` (путь берётся из уже инициализированного `initTlsTrust`).
- `storage/` — **слой хранения (ADR-096):** доменные порты `storage/ports/*` (41 — 39 файлов-описаний, `DocumentRepository<T>` даёт три поля; `AnalyticsRollupRepository` — суточные роллапы аналитики, ADR-102;
  `ExternalCredentialRepository` — внешние доступы к коннекторам (ADR-105 Ф1; файловое/в-памяти
  хранилища — `ExternalCredentialStore`, контракт — `storage/contract/external-credential-repository.contract.ts`);
  `AuthorityPolicyRepository`/`AuthorityDecisionJournal` — политика полномочий и журнал решений
  Authority-слоя (ADR-106 Ф1; PostgreSQL — `packages/storage-postgres/src/ports/authority.ts`,
  миграция `014` — контрактный suite гоняется на **живой** БД, гейт `SYNTH_TEST_POSTGRES_DSN`);
  контент `provides.authority` пакета активируется в `authorityPolicy` при одобрении пакета и
  снимается при снятии установки (см. `engine/authority/activation.ts`));
  конфиг-словари `providers`/`models`/`agents`; методы под SQL-выборки помечены `@future-backend`),
  **`SessionRepository`: `save` — полная замена истории, `appendMessage`/`updateMessage` — точечная
  запись одного сообщения** (пошаговая персистентность оркестратора без перезаписи истории; `seq`/`id`/
  `origin` назначает порт, `update` целится по `seq` с fallback по `id`), `loadLight`/`listLight` —
  метаданные без истории; семантика — часть контракта порта (`storage/contract/*`), нормализация
  сообщений для file/memory — `storage/message-write.ts`,
  файловые реализации (объявляют `implements` портов — поведение не менялось), in-memory
  `storage/memory/*`, контрактный suite `storage/contract/*` («паспорт» порта, обязателен для любой
  реализации), `storage/storage-context.ts` — `StorageContext` (в т.ч. опциональные
  `close?`/`locks?`/`health?`/`schemaMigrations?`/`purgeSchema?`/`degraded?`) + `createFileStorage`/`createMemoryStorage`/
  `createStorageContext` (`@deprecated`) и **async-каскад** `createStorageContextAsync`/`buildStorageContext`
  (backend по `storage.backend`, env `SYNTH_STORAGE_BACKEND`),
  `storage/file-blob-store.ts` (`FileBlobStore`, порт `BlobStore`), `storage/defaults-store.ts`
  (`DefaultsStore` — перенесён из backend, там реэкспорт). Пайплайны ADR-101 — отдельные порты:
  `storage/ports/project-pipeline-repository.ts` (`ProjectPipelineRepository` — черновик пайплайна
  + журнал опубликованных версий; `scope` = `project`|`instance`, `installedBy` — провенанс пакета) и
  `storage/ports/pipeline-run-repository.ts` (`PipelineRunRepository` — заголовки прогонов +
  append-only журнал); файловые реализации — `storage/file-project-pipeline-store.ts`
  (`{dataDir}/pipelines/{pipelines,versions}.json`) и `storage/file-pipeline-run-store.ts`
  (`{dataDir}/pipelines/{runs.json,run-events.jsonl}`), in-memory — `storage/memory/pipelines.ts`;
  контрактные suite — `storage/contract/{project-pipeline-repository,pipeline-run-repository}.contract.ts`.
  Точка сборки standalone —
  `createStandaloneStorage` (`server/app/deps.ts`, строится до `auth`: реестр `serviceKeys` нужен
  резолверу ключа). Опциональный БД-драйвер (ADR-097/ADR-096) — отдельный in-tree пакет
  `@itphx/synth-storage-postgres` (`createPostgresStorage(config): Promise<StorageContext>`), объявлен
  в `optionalDependencies` core и подключается динамическим `import()` по `storage.backend === 'postgres'`
  (`pg` — optional у драйвера, core его рантаймом не тянет); драйвер применяет/проверяет схему и
  **удерживает соединение в `StorageContext`** — `close?()` закрывает пул, ресурсы освобождает домен;
  **все порты реализованы** (по группам `src/ports/*`: `sessions`/`principals`/`events`/`content`/`audit`/`analytics`/`pipelines`/`plugins`),
  координация — `StorageContext.locks` (`PgMutex`/`PgLeader`, scheduler `leaderElection: postgres`).
  **Деградированный режим** (ADR-098): недоступность БД → файловый фоллбек строго read-only
  (`createStorageContextAsync` публикует состояние в `engine/permission/storage-state.ts`), HTTP-guard и
  `GET /api/v2/storage/status` — `server/storage-degraded.ts`, `/health` → `degraded`; `doctor`/`backup`/
  `uninstall --purge-db` и перенос `synth storage migrate` учитывают `storage.backend` (`maintenance/*`).
- `storage/*` — `FileStore`, `JsonStore`, `ProjectStore`, `FileProfileStore`
  (профиль владельца; поле `interviewCompleted` + legacy-backfill из `[ИНТЕРВЬЮ]`; ADR-089 —
  `identities: ExternalIdentity[]` в snake_case (`external_id`/`display_name`/`linked_at`/`linked_by`),
  legacy без поля → `[]`, методы `findProfileByExternalId`/`linkIdentity`/`unlinkIdentity`),
  `FileStore.listForUserScope(userId, projectIds)` — «свои + сессии моих проектов» (ADR-089;
  `listForUser` — только свои),
  `FileMutex` (`file-mutex.ts`, ADR-051/ADR-089: `mkdir`-лок + stale takeover для общего
  `dataDir`; `ScheduleStore.crossProcess` сериализует мутации) — реализация интерфейса
  `Mutex` (`mutex.ts`: `withLock(fn, opts?)`; `ScheduleStore`/лок миграций зависят от
  интерфейса, а не класса; ADR-097 — при `storage.backend=postgres` подставляется
  `PgMutex` драйвера через `StorageContext.locks`), `RuntimeSettingsStore`
  (`events` + `mergeEventsConfig` — runtime-настройки раздела «События» (включая `identityMap` — **override**
  поверх основного источника — привязок в `ProfileData.identities[]`), ADR-089; `decision` +
  `mergeDecisionConfig` — runtime-настройки decision-слоя, ADR-084, включая `escalationProvider`/`escalationModel`;
  `metrics` — runtime `metrics.enabled` (ADR-094), резолв — `resolveMetricsEnabled`;
  `plugins` + `mergePluginsConfig` — runtime-настройки слоя плагинов (ADR-090: `enabled`/
  `runtimeInstall`/`trustFloor`/`scan`/`allowlist`/`denylist`/`remoteAllowlist`/`exactHostExceptions`/
  `promptBlockMaxChars`/`executionEnabled` (главный переключатель исполнения кода плагинов, default
  `false`); приоритет runtime > config > defaults; `getPlugins`/`setPlugins`/`clearPlugins`),
  `McpRegistryStore` (единый реестр MCP, ADR-071),
  `SkillStore`, `CommandStore`, `SkillBundleStore` (ADR-046), `SSHKeyStore`
  (`secrets/ssh-keys`, шифрование at-rest, ADR-076),
  `ExternalCredentialStore` (ADR-105 Ф1: внешние доступы к коннекторам —
  `secrets/oauth/credentials.json`, `0600`; access/refresh-токены зашифрованы
  мастер-ключом (`enc:v1:…`), наружу отдаются только метаданные с маской;
  `revoke` идемпотентен и необратим, `markError` — после `invalid_grant`; порт
  `ExternalCredentialRepository`, контракт —
  `storage/contract/external-credential-repository.contract.ts`),
  `ServiceApiKeyStore` (`service-keys.json`, ADR-052 этап I: scoped-ключи инстанса — sha256-хеш
  секрета `synth_svc_…` at-rest, plaintext один раз при `create`, `resolveBySecret` с проверкой
  `revokedAt`/`expiresAt`, `revoke`/`touch`/`update`, `ServiceApiKeyConflictError`; ADR-052/O1 —
  `ensure({label, secret, scopes, roles?})` (идемпотентный провижининг installer-ключа с внешним
  секретом из env/Secret: `created`/`updated`/`unchanged`, секрет не перезаписывается) и
  `applyBootstrapServiceKeys` (best-effort на старте, лог без секретов)),
  `EventBindingStore`
  (`events/bindings.json`), `EventJournalStore` (`events/journal.jsonl`, ADR-089),
  `RouteRuleStore` (`events/routes.json`, правила маршрутизации, ADR-089),
  `EventApiKeyStore` (`events/api-keys.json`, API-ключи привязок: sha256-хеш секрета at-rest,
  plaintext один раз при `create`, обязательная уникальная `label` (глобально по инстансу) +
  `description`/`expiresAt`/`rateLimitPerMinute`, `update`/`revoke` (мягкий отзыв), legacy-backfill
  `name`→`label`, каскад `removeByBinding`; ADR-089/ADR-052),
  `WebhookStore` (`webhooks/subscriptions.json`, ADR-052 этап II: подписки исходящих
  webhooks — signing-секрет `whsec_…` **шифруется at-rest** AES-256-GCM мастер-ключом
  (HMAC требует исходный секрет, в отличие от sha256-хеша API-ключей), plaintext один раз
  при `create`/`regenerateSecret`, обязательная уникальная `label` (глобально) + `url`/`events`/
  `enabled`/`setEnabled` (мягкое отключение `disabledAt`)/`getSecret`/`touchDelivery`),
  `WebhookDeliveryStore` (`webhooks/deliveries.jsonl`, append-only журнал доставок:
  `record`/`list`/`listBySubscription`/`prune`),
  `IdentityClaimStore` (`identity-claim-store.ts`, `events/identity-claims.json`, ADR-089 claim-flow:
  одноразовые коды подтверждения владения идентичностью; `create`/`consume`/`cleanup`/`list`;
  код `XXX-XXX`, алфавит base32 без `0/O/1/I`, 6 знаков ≈ 2³⁰ (перебор нецелесообразен),
  TTL 10 мин по умолчанию, нормализация ввода —
  upper + удаление дефисов/пробелов, одноразовость через `consumedAt`, гонка consume
  сериализуется `AsyncLock`; `provider`/`externalId` — из серверной записи; store
  **инстанс-локальный** — не переносится publish/fork, ADR-042/PROP-081)
  и `JobStore` (`scheduler/jobs.jsonl`, Job-история, ADR-051),
  `MaintenanceAuditStore` (`audit/maintenance.jsonl`, append-only аудит-журнал обслуживания, ADR-092);
  `FilePluginAuditStore` (`audit/plugins.jsonl`, append-only журнал аудита плагинов, ADR-090 —
  порт `PluginAuditRepository`, **отдельный**: `SECURITY_AUDIT_SCOPES` не расширяется; append под
  `AsyncLock`, `clear` атомарно tmp→rename), `MemoryPluginAuditRepository`
  (`storage/memory/plugin-audit.ts`), PostgreSQL — `packages/storage-postgres/src/ports/plugin-audit.ts`
  (таблица `plugin_audit`, миграция `006-plugin-audit.ts`); контрактный suite —
  `storage/contract/plugin-audit-repository.contract.ts` (file/memory/PG; прогон на живой БД —
  `storage/contract/postgres.test.ts`); подключение — `StorageContext.pluginAudit`;
  `FilePluginLockStore` (`storage/file-plugin-lock-store.ts`, порт `PluginLockRepository`,
  PROP-068 §4.4 / ADR-090 — lock-файл плагинов `plugins.lock.json`, **источник истины** для
  update/uninstall; путь задаёт раскладка `<home>/plugin/` или `{dataDir}/plugin/` — опция
  `pluginLockPath`; ключ записи — имя плагина, `installed_at` иммутабельно; атомарная запись
  tmp→rename), `MemoryPluginLockRepository` (`storage/memory/plugin-lock.ts`), PostgreSQL —
  `packages/storage-postgres/src/ports/plugin-lock.ts` (таблица `plugin_lock`, миграция
  `007-plugin-lock.ts`); контрактный suite —
  `storage/contract/plugin-lock-repository.contract.ts` (file/memory/PG; прогон на живой БД —
  `storage/contract/postgres.test.ts`); подключение — `StorageContext.pluginLock`;
  `migrations.ts` — идемпотентная разовая миграция снапшотов
  `mcpDefaultOn`/`skillsDefaultOn` (маркер `session-scope-snapshots-v1`).
- `sessions/ephemeral.ts` — ephemeral TTL (ADR-089): `parseTtl`
  (`30s`/`15m`/`24h`/`7d`), `startEphemeralSweeper` (sweep 60 c, unref); поля
  `Session.expiresAt`/`archivedAt`, списки сессий по умолчанию без архива.
- `sessions/stats.ts` — `computeSessionStats` (ADR-070): usage сообщений + рекурсивный usage
  саб-агентов (tool `task`), агрегаты по агентам/пользователям — для `GET /api/v2/sessions/:id/stats`.
- `queue/processor.ts` — `QueueProcessor`/`QueueProcessorManager`; надёжный «Стоп» — `requestStop()` (in-memory запрос: будит backoff, абортит активный LLM-вызов) + `_shouldStop`/`_handleStopRequest` (проверка in-memory запроса и персистентного `status.cancelRequested` на границах цикла, очистка `pendingMessages`, снятие `blocked`/флага и `stream.cancelled` ровно один раз).
- `remote/*` — клиент, сессии, credentials, device-flow, transfer, aggregate, event-bridge.
- `providers/*` — `ProviderFactory`, `BaseProvider`, OpenAI/Anthropic/Ollama/Remote, `DecisionProvider` (ADR-084: типы `decision` (RouterAI, `POST {base}/decisions`) и `systemone` (Ollama, `POST {base}/v1/systemone`) — endpoint выбирается по типу провайдера). Prompt-cache (ADR-070, `CachePolicy = 'auto' | 'none'` в `base.ts`): `SystemPromptPayload` (`text`/`stablePrefix`/`cacheKey`/`cachePolicy`) — Anthropic отдаёт `system` массивом блоков с `cache_control` (≤4 breakpoint'а, два system), OpenAI/Remote — `prompt_cache_key` (= id сессии) + `stream_options.include_usage`; `usage.ts` — нормализация usage и `computeCacheHitRate` (`cacheReadTokens / inputTokens`, 0 при нуле). Нормализация по провайдерам: Anthropic — `input = input_tokens + cacheRead + cacheWrite`; OpenAI — `prompt_tokens_details.cached_tokens` → `cacheRead`; Remote — usage из ответа прокси в тот же контракт; Ollama — cache-полей нет (`cacheRead = cacheWrite = 0`).
- `profiles.ts` — реестр серверных профилей гибрида.
- `prompts/` (system, roles, subagents, security), `definitions/`
  (`protected-paths.json`, `shell-policy.json`), `dictionaries/` — ассеты движка.

## Правила добавления тула / роута

- Тул: реализовать `ToolDefinition` (Zod `parameters` + `capabilities:
  ToolCapability[]`) и добавить в `ALL_BUILTIN_TOOLS` (`engine/tools/index.ts`);
  доступность — по capability, а не по имени в оркестраторе.
- Права на тул — правилами permission-слоя (`engine/permission/*`), не `if`
  внутри `execute`.
- Строки `description` и результаты — через `t()`/`i18n()`
  (`engine/system-messages.ts`, ключи `shared/i18n`), не литералами (ADR-041).
- Публичный роут: фабрика в `server/routes/*`, монтирование в `server/app.ts`
  (`app.route('/api/v2/...', ...)`); типы/схемы — из `@itphx/synth-shared`.
- **Стор — только через порт (ADR-096):** домену передаётся доменный порт из
  `StorageContext` (а не конкретный класс); новая реализация стора обязана пройти
  контрактный suite `storage/contract/*` (и иметь memory-эквивалент для тестов).
- Переиспользуемые фабрики — `createXxxRoutes(auth, deps, opts)` (общие для core и
  backend): `auth` — структурный `{ requireAuth: Middleware }`, совместим с backend
  `AuthKit` без каста (исключение — `createSettingsRoutes` принимает core-`AuthKit`);
  `opts` — guard'ы (`writeGuard`/`detailGuard`/`testGuard`/`canAccess`), `messages`
  (функции `(c) => string`: core — литералы, backend — `t()`), специфичные флаги и
  хуки. Гибридные ветки активны только при переданном optional-dep
  (`getRemoteClient`). Публичные типы — в `src/index.ts`. Существующие фабрики:
  `createSettingsRoutes`, `createDictionaryRoutes`, `createProviderRoutes`,
  `createModelRoutes`, `createSessionRoutes`,
  `createGitRoutes` (ADR-076: доступ к проекту — граничный guard ДО обработчика:
  `authorizeRead` — чтение git-данных (`scan`/`log`/`commit`), `authorizeProject` —
  изменение реестра/репозиториев; отказ — 403 `FORBIDDEN`, ADR-089/инвариант 16),
  `createSshKeyRoutes`, `createAgentSshKeyRoutes`, `createFsRoutes` (project-aware
  FS: плоский root / workspace проекта через `getProjectWorkspace`, ADR-075),
  `createServiceKeyRoutes` (ADR-052 этап I: CRUD service-key, `writeGuard`/`readGuard`/`messages`),
  `createMaintenanceRoutes` (ADR-091/ADR-092: admin-API обслуживания — status/doctor/migrations/
  backups/restore/**restart**; `writeGuard`/`readGuard`/`messages`/`maxUploadBytes`, восстановление — офлайн).
  `createAnalyticsRoutes` (ADR-102: только чтение — summary/usage/activity/decision/prompt/export;
  RBAC через `resolveElevated`/`resolveAuditor`/`resolveUserId`, `messages` — i18n).
  `createSessionRoutes`/`createEventRoutes`/`createSchedulerRoutes` принимают опции
  `scopeGuard`/`serviceProjectProjection` (ADR-052; core-дефолты — `requireScope`/`checkServiceProjectProjection`).
  `createAgentRoutes` — опция `scopeGuard` для записи агентов (ADR-052; дефолт —
  `requireScopeOrAdminRole`): достаточно любого из `SERVICE_SCOPE_SETS.agentsWrite`
  (сейчас — `automation:install`) **или** роли ADMIN у ключа.
  `createPipelineProjectRoutes` (ADR-101) — **паттерн граничных guard'ов**: доступ
  проверяется на границе, в обработчиках проверок нет (инвариант 16). Два guard'а
  различают вид доступа по HTTP-методу и резолвят ресурс **один раз**:
  `projectGuard('read'|'write')` — проект по `:id` (чтение — право чтения, запись —
  право изменения содержимого; `VIEWER` читает, но не мутирует — инвариант 21) и
  `runGuard('read'|'write')` — прогон по `:runId` (владелец/участник проекта, к
  которому принадлежит прогон). Guard кладёт разобранный ресурс в контекст Hono
  (`guardedProject`/`guardedRun`), обработчик только читает; нет ресурса → 404, нет
  прав → 403, чужой ресурс под чужим id → 404. Шаблоны инстанца — отдельный
  `adminGuard` (ADMIN), инстанцирование дополнительно требует право изменения
  целевого проекта.
  `createSettingsRoutes` (ADR-089/ADR-084): `GET/PUT/DELETE /settings/events` — runtime-настройки
  раздела «События» (`fallbackEvents` из config, `onEventsChange` — live-применение,
  мутации под `eventsWriteGuard`; core — `requireAuth`, backend — ADMIN) и
  `GET/PUT/DELETE /settings/decision` — runtime-настройки decision-слоя (ADR-084: `fallbackDecision`,
  `onDecisionChange`, мутации под `decisionWriteGuard`), а также `GET /settings/decision/metrics`
  (снимок `decisionMetrics`, `requireAuth`) и `DELETE /settings/decision/metrics` (сброс,
  `decisionWriteGuard`).
  Прокси (ADR-099 п. 27) — `GET/PUT/DELETE /settings/proxy` (профили/правила/`mode`/`defaultProfile`),
  `PUT/DELETE /settings/proxy/profiles/:name/password`, `.../tls/ca`, `.../tls/client` (профильные
  секреты write-only, `secrets/proxy/`), `POST /settings/proxy/test` (target-check: маршрут по saved,
  `HEAD` без редиректов, egress-политика до запроса); мутации — `settingsWriteGuard`, аудит `scope:'proxy'`.
- **Видимость сессий/проектов (ADR-089).** Единый хелпер — `server/session-visibility.ts`
  (`isSessionVisible(session, projectStore, { userId, elevated }, projectCache?)`): `elevated`
  (ADMIN/LEAD) → всё; владелец (`ownerId ?? userId`) → да; нет владельца → да; иначе сессия
  проекта видна его `ownerId`/любому `members` (любая роль), иначе — нет. Кэш проектов —
  `Map`, передаётся вызывающим на один скан (не модульный). Скан «свои + проектные» —
  `FileStore.listForUserScope(userId, projectIds)` (используется `SessionManager.listSessions`
  при `filter.projectIds`). Фабрики:
  - `createSessionRoutes` — опции `resolveElevated` (ADMIN/LEAD — все), `resolveMemberProjectIds`
    (проекты-участия), `resolveCanAccessExtra` (доступ по id, напр. участник проекта); `GET /`
    при elevated отдаёт `listSessions({})`, иначе `{ userId, projectIds }`.
  - `createProjectRoutes` — опции `canRead` (чтение по id: owner/любой участник/LEAD/ADMIN; **не**
    расширяет `canManage`/`canEditContent`) и `resolveElevated` (`GET /` — все проекты).
  Правила по ролям — `docs/API_V2.md` §5.5/§5.8, контекст — ADR-089.

## MCP

- Транспорты: stdio (`StdioClientTransport`) и Streamable HTTP
  (`StreamableHTTPClientTransport`) — `engine/mcp/client.ts`. ADR-090: `config.headers`
  пробрасываются в HTTP-транспорт (`requestInit: { headers }`) — auth/tenant-заголовки.
- Лимиты: connect 60 c; tool timeout 120 c (`config.timeout`, мс); результат
  усечён до 30 000 символов (`MAX_TOOL_RESULT`).
- Circuit breaker: 5 ошибок → блокировка на 60 c (`engine/mcp/manager.ts`).
- Тулы регистрируются с префиксом `{serverName}_{toolName}` и capability
  `ToolCapability.MCP`; деобфускация аргументов — в `execute` через `ObfuscationMapStore`.
- HTTP: `POST /api/v2/mcp/probe` (`server/routes/mcp.ts`); доступность MCP по
  режимам — `GET/PUT /api/v2/settings/mcp`. Отдельного `/mcp/session/:id` в core нет.
- Единый реестр серверов — `McpRegistryStore` (ADR-071): уровни system/project/session,
  per-item резолвинг эффективного набора — `engine/mcp/scope.ts`
  (`enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`,
  причины `system_disabled`/`project_disabled`/`session_optout`/`not_default`;
  мастер `enabled` (только реестр) и проектный `enabled` — live hard-gate (в т.ч. для
  системных), дефолты — snapshot `mcpDefaultOn`; `config.enabled` — лишь сид реестра,
  не гейт), сетевой доступ — `engine/mcp/network-policy.ts`
  (на старте применяется `mergeMcpNetworkPolicy(config, runtime)`).
- **Сетевая политика MCP (ADR-071 §2.3.1)** — `engine/mcp/network-policy.ts`
  (`evaluateMcpNetworkAccess`) + валидатор `engine/net/egress-policy.ts`
  (`isValidEgressRule`/`validateEgressPolicy` — общий с `egress.tools`/`egress.webhooks`).
  Грамматика правила (`list` и `exceptions`): **точный hostname** | **`*.suffix`**
  (только поддомены — сам suffix не матчится) | **CIDR** (`10.0.0.0/8`) |
  **одиночный IP-литерал** (`10.0.0.5` → /32, `::1` → /128). Паттерн `*`
  («любой хост») **недопустим** — валидатор его отвергает, а матчер
  (`hostMatchesRule`) возвращает `false` (fail-closed): исключение не должно
  снимать SSRF-защиту целиком. Семантика шаблона хоста — общая с ADR-099
  (`matchTlsHostPattern` из `@itphx/synth-shared`); дублировать её в подсистемах
  нельзя.
  Порядок проверок: **исключение (hostname, без DNS) → резолв всех A/AAAA →
  исключение (адресное) → `isLocalHostname` → `policy.list`**. Локальные имена
  (`localhost`/`*.localhost`/`*.local`/`*.internal` — в т.ч. `*.svc.cluster.local`
  в K3s) блокируются **до** `policy.list`, поэтому аддон в кластере разрешается
  именно hostname-исключением (`*.svc.cluster.local`), а не CIDR.
  Голый IP в `list`/`exceptions` **работает** (`parseAddressRule`: литерал ↔ CIDR
  с полной маской; IPv4-mapped `::ffff:a.b.c.d` нормализуется как у проверяемого
  адреса) — раньше литерал проходил валидатор, но не срабатывал никогда, и
  deny-список вроде `['169.254.169.254']` не блокировал адрес метаданных (fail-open).
  Пустая политика (`undefined`) — fail-closed (запрет), а не «разрешено всё».
- **Внешний доступ в транспорте (ADR-105 Ф3)** — коннектор с
  `auth: { kind: 'credential', credentialId }` не несёт токен в заголовках: access-токен берётся
  из порта доступов и подставляется в **каждый** HTTP-запрос (`engine/mcp/credential-auth.ts`,
  `McpCredentialSource` + `createCredentialFetch`), `401` обновляет токен (refresh) и повторяет
  запрос — **ровно один refresh на запрос**. Токен не попадает в конфиг/реестр MCP, логи и тексты
  ошибок; агент и модель его не видят.
- **Plaintext-секрет в коннекторе запрещён (ADR-105 Ф3)** — `authorization`/
  `proxy-authorization`/`x-api-key`/`cookie` в `headers`: запись реестра и `POST /api/v2/mcp/probe`
  → **400** `MCP_SECRET_HEADER_FORBIDDEN` (`MCP_SECRET_HEADER_ERROR_CODE` в `shared`); существующие
  записи реестра мигрируются в ссылку на доступ. `client_secret` OAuth-провайдера — только env
  `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` или файл `{dataDir}/secrets/oauth/<provider>.client_secret`.
- **Каталог OAuth-провайдеров** — `oauth.providers` в конфиге (env-оверрайд
  `SYNTH_OAUTH_PROVIDERS`) → описания в `OAuthProviderRegistry` (`engine/oauth/registry.ts`);
  описания — **данные**, из них `OAuthCredentialService` строит клиент для refresh.
- **Право привязки доступа к коннектору (ADR-105 Ф3)** — проверка **на границе** (инвариант 16):
  правило — `engine/oauth/credential-binding.ts`, guard — `server/credential-bind-guard.ts`.
  Свой доступ (`owner.kind='user'`/`'local'`) — его владелец; инстансный — `ADMIN`/`LEAD`;
  проектный (`projectId`) — участник проекта с правом **изменения** содержимого (`OWNER`/`EDITOR`,
  а также `LEAD`/`ADMIN`); нет доступа — 404, нет права — 403. Матрица тестов —
  `packages/backend/src/routes/mcp-credential-bind.test.ts`.

## Тесты и запуск

- Тесты: `pnpm --filter @itphx/synth-core test` (Vitest); точечно —
  `pnpm --filter @itphx/synth-core test -- --run src/engine/tools/task.test.ts`.
- Сборка: `pnpm --filter @itphx/synth-core build`; запуск собранного —
  `node dist/main.js serve` (`package.json`, scripts `start`).
- Dev-сервер — `./scripts/dev.sh core` (порт core — в корневом `AGENTS.md`).
- Публичный `synth` — пакет `@itphx/synth`; не добавлять в core команды, которых
  нет в `src/main.ts`.

## Чего не делать

- Не импортировать `backend`/`ui` из core (обратное направление).
- Не вызывать LLM мимо `GatewayProvider` (ADR-036).
- Не писать в `$SYNTH_DATA_DIR` в обход порта слоя хранения (`FileStore`/`JsonStore`/… — ADR-096/ADR-005).
- Не хардкодить permission-проверки в тулах (ADR-025/028/029).
- Не возвращать строки движка без i18n-ключа (ADR-041).
- Не вводить TSM/JSON-блок состояния — только Tool Use (ADR-039).
- Не дублировать спеку API (`docs/API_V2.md`) и общие правила корня.

## Куда смотреть

| Тема | Документ |
|------|----------|
| HTTP API v2 (спека) | `docs/API_V2.md` |
| Архитектура, слои | `docs/ARCHITECTURE.md` |
| Конфигурация | `docs/CONFIGURATION.md` |
| Гибридный режим | `docs/HYBRID.md` |
| Движки/runner, stateless | ADR-022 |
| LLM Gateway | ADR-036 |
| План/todo, Tool Use | ADR-039 |
| Ошибки LLM / i18n | ADR-041 |
| Гибрид | ADR-042, ADR-045 |
