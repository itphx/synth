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
- Отключение **user**-реплики (`disabled`) выключает весь её ход:
  `suppressDisabledTurns` (`engine/context/disabled-turns.ts`) подавляет
  assistant/tool/error до следующей user-реплики; system-state и summary
  остаются. Отключённый assistant с `toolCalls` подавляет свои tool-результаты
  (иначе они осиротеют). Функция применяется в `process-setup` до optimizer и в
  `buildPromptHistoryInfo` — диагностика `GET /sessions/:id/prompt` совпадает с
  реальной отправкой (`excluded.disabled` считает подавленный ход целиком).
- Любой LLM-вызов — через `GatewayProvider`
  (`engine/gateway/gateway-provider.ts`: guard, обфускация, rate limit, аудит);
  провайдера напрямую не дёргать (ADR-036).
- **Отключённые администратором провайдер/модель — fail-closed.** `providerLoader`
  (`server/app/deps.ts`, `backend/app/deps.ts`) возвращает `null` при
  `provider.enabled === false` — провайдер не создаётся ни в чате, ни в ретраях,
  ни в пайплайнах/эмбеддингах/суммаризации. Ход получает понятную ошибку:
  `process-setup` (`providerAvailability` → `provider_disabled`,
  `resolveModelEnabled === false` → `model_disabled`, ключи `router.*` в
  `shared/i18n`), а `POST /api/v2/sessions/:id/prompt` проверяет эффективную пару
  (`body.provider/model` → настройки сессии) через `SessionRoutesDeps.llmAvailability`
  **до вложений и постановки в очередь** (`400 PROVIDER_DISABLED`/`MODEL_DISABLED`,
  `details {provider, model?}`). Нет записи в каталоге (`undefined`) — не блокируем.
  **Гибрид:** remote-ветка `POST /:id/prompt` вызывает `promptSession` с
  `allowHttpError: true` — 4xx удалённой стороны возвращается `Response` (статус +
  `code`/`details` тела) и пробрасывается клиенту; 401 по-прежнему `UNAUTHORIZED`,
  legacy WS-кадр `send_message` (`server/app/ws-events.ts`) опцию **не** передаёт.
- **Температура LLM-вызова — одна величина на прогон.** Приоритет:
  `AgentDefinition.temperature` → `session.settings.temperature` → дефолт модели
  (`undefined` — поле `temperature` в запросе **не отправляется**,
  `BaseProvider._applyTemperature`). Так во всех точках вызова: основной ход
  (`process-setup` → `routeProvider`), саб-агент `task`/`task-resume` и агентский
  шаг пайплайна (`executors/agent-step.ts`). Провайдеры кэшируются
  (`ProviderPool`, `temperature` входит в `cacheKey`), поэтому температура чужого
  прогона выставляется **клоном** — `BaseProvider.withTemperature` (оригинал не
  мутируется); `GatewayProvider` переопределяет метод и клонирует ещё и `inner`:
  в тело запроса температуру кладёт именно он.
  Значения встроенных агентов (`engine/agents/definitions/*.json`, перенесены из
  кастомных агентов OpenCode — `~/dev/harness/agents/*.md`): `leader` 0.15,
  `fixer`/`researcher` 0.2, `admin`/`devops`/`tester`/`security-auditor` 0.1,
  `title` 0.3. У `assistant`/`general`/`explore` температура **не задана** —
  Auto (дефолт модели). Лоадер (`loadSystemAgentDefinitions`) обязан пробрасывать
  поле из JSON: без этого значение из определения молча терялось. В UI (админка
  «Агенты») «Auto (model default)» = `undefined`, при сохранении уходит
  `temperature: null` — роут (`POST /api/v2/agents`) трактует `null` как сброс
  (поле не задано), а `null` в API ≠ `0`.
- **Провайдер/модель/sampling агента применяются при создании провайдера хода.**
  `AgentDefinition.provider`/`model`/`topP`/`topK` (поля есть в UI-админке «Агенты»
  и в сторе) читает `process-setup`: они собираются в `ProviderOverrides`
  (`engine/orchestrator/routing.ts`) и уходят в `routeProvider`. Приоритет
  `provider`/`model`: **агент → `message.provider`/`model` → `session.settings`**
  (агент задал только provider — модель берётся из сообщения/сессии, и наоборот;
  обе заданы — этот выбор **перекрывает роутер**, он не вызывается вовсе).
  `topP`/`topK`: только от агента (значение `> 0`; `0`/`undefined` — «не задано»,
  поле в запрос провайдера не попадает), в router-пути прокидываются в пул
  (`ModelRouter.getProvider` → `ProviderPool.getProvider`), а в пуле входят в
  `cacheKey` (`topP ?? 'auto'`, `topK ?? 'auto'`) — иначе агенты с разным
  sampling делили бы один экземпляр. `session.settings` агент **не мутирует**
  (это состояние следующих ходов): переопределения живут только в вызове.
  Escalation-фоллбек в `process-finalize` берёт `topP`/`topK` действующего агента
  (модель меняется — sampling агента сохраняется). Саб-агент `task`/`task-resume`
  применяет provider/model/topP/topK агента по тому же приоритету (пара — выше
  `router.subagent`/роутинга, sampling — клоном `withSampling`; фактическая пара
  фиксируется в настройках ребёнка), шаг пайплайна пока передаёт только
  `temperature` (остаток).
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
- **Вложения — только через `AttachmentService` (ADR-115).** Байты медиа живут в blob-порте
  (`{dataDir}/blobs`, content-addressed `attachments/<sha2>/<sha256>`), в сообщении — ссылка
  (`MediaPartData`); **единственная точка записи байтов** — `AttachmentService.upload`
  (MIME по сигнатуре, лимиты `attachments.*`, allowlist, запрет SVG). Оригинал хранится как
  есть, `stripMetadata` применяется **только на границе отправки провайдеру** (гидратация/aux-вызов).
  Второй политики лимитов/MIME не заводить: тулы, события и пайплайны ходят сюда же.
  Учёт ссылок — порт `BlobRefRepository` (`blob_refs`; `ownerKind`
  `message`|`pipeline-run`|`skill`|`process`), GC — `startAttachmentPruner`: сироты (нет ссылок
  **и** старше `attachments.gcDays`) + кэши `.thumbs`/`.derived` (по `gcDays`, без ссылок) +
  временные объекты `.uploads` (TTL 1 ч, независимо от `gcDays`).
- Исполнение агентских команд — **только через порт** `ExecutionPort` (`execution/ports`), а не
  прямым `execFile`; реализация по умолчанию — `InlineExecutionPort` (в процессе), удалённая —
  шаг 7b плана ADR-077 (пакет `@itphx/synth-executor`, динамический `import()`). Выбор
  реализации — `execution/factory.ts` (`createExecutionPortForConfig`) при старте процесса;
  шов внедрения — `ctx.extra.executionPort` (`resolveExecutionPort(ctx)`);
  не-туловые точки (резолвер проектных инструкций, детект зависимостей, inline-shell) берут
  тот же порт через композицию. `GitService` (`git/git-service.ts`) исполняет git
  **через тот же порт** (`git/exec.ts`): clone/fetch/init/log — argv без shell,
  `requires: ['git']`; в remote-режиме команды уходят исполнителю, поэтому slim-образ
  control plane не содержит git. Вне порта остаются операции, не относящиеся к
  агентским командам: MCP stdio (`engine/mcp/client.ts`), обслуживание
  (`maintenance/update.ts`) — они уезжают в исполнитель по фазам 2–3 плана ADR-077.
- **Доступность программы — вопрос порта, а не control plane (ADR-077 шаг A).**
  `ExecRequest.requires?: string[]` — бинарные требования команды; канонический словарь
  базовых возможностей — `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`/`bash`) в
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
  preflight + dry-run); перешифровываются **три** точки at-rest: SSH-ключи агентов,
  внешние доступы (`ExternalCredentialStore.rotateMasterKey`) и signing-секреты подписок
  исходящих webhooks (`WebhookStore.rotateMasterKey`) — общий preflight всех трёх ДО
  первой записи, затем запись и перезапись `master.key`; ключи с passphrase — через
  askpass (`git/ssh-env.ts`), наружу — `sshkey.env_failed`.
- План — в `project.plan`, todo — в `session.todos`; состояние менять только
  тулами `plan_*`/`todo_*`, не JSON-блоком в ответе модели (ADR-039).
- Ошибки LLM — через `classifyLlmError`/`isLlmErrorRecoverable`
  (`engine/llm-error.ts`); строки движка — по ключам `shared/i18n` (ADR-041).
- События сессии — локальный `EventBus`; UI слушает через EventHub/TransportClient
  (`/ws/events`) с SSE-фоллбеком (ADR-008/009/024).
- **Приём и наблюдение разведены (ADR-118).** `POST /api/v2/sessions/:id/prompt` **только
  принимает** сообщение (`202 {messageId, mode, position}`), наблюдение за ходом — события
  `turn.*`/`step.*`/`part.*` в шине. Возвращать `text/event-stream` из ответа приёма нельзя:
  иначе отмена соединения клиентом рвёт наблюдение, а подтверждение приёма теряется.
  Детали модели — раздел «Поток сообщений v2 (ADR-118)».
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

## Поток сообщений v2 (ADR-118)

Полная спецификация цикла обработки сообщений (приём → очередь → ход/шаги → финал, события, индикаторы, сценарии, карта файлов) — [../../docs/MESSAGE_FLOW.md](../../docs/MESSAGE_FLOW.md).

Модель хода: `Turn` (ход) → `Step` (один вызов LLM = **одно assistant-сообщение**) → `Part`.
Контракты — `shared/types/message-stream.ts` (`PromptAcceptedResponse`, `MessageStatus`,
`TurnStatus`, payload'ы событий, `InstanceCapabilities`, `supportsMessageModel`,
`MESSAGE_MODEL_QUERY_PARAM`). Приём и наблюдение разведены: приём — HTTP, наблюдение — шина событий.

- **Приём — всегда `202`.** `POST /api/v2/sessions/:id/prompt` отвечает
  `202 {messageId, mode, position}` и **не** отдаёт `text/event-stream`
  (`server/routes/sessions.ts`); обрыв соединения клиентом ход не прерывает. `messageId` — id
  принятого сообщения (клиентский `messageId` либо выданный сервером), он же уходит в
  `message.accepted`/`message.delivered`. В гибриде проксируется **только** `202`; ответ старой
  версии сервера → мягкая деградация `202 {messageId, mode:'queue', position:null}`.
- **Новые события.** Публикация — `engine/orchestrator/turn-events.ts` (единая точка
  `turn.*`/`step.*`/`part.*` и детерминированных `partId`: `msg:text:N`, `msg:reasoning:N`,
  `callId`), очередь — `queue/processor.ts`:
  `message.accepted` (адресное, `BusEvent.recipient = userId` отправителя),
  `message.enqueued` (адресное, **только владельцу/отправителю**: адресат — отправитель сообщения,
  иначе владелец сессии `ownerId ?? userId`; владельца нет — событие **не публикуется**
  (fail-closed, снимок с текстом в общий канал утекать не должен); со **снимком** сообщения:
  `messageId`, `delivery` `queue`/`steer`, `position`, `message` — id/role/author/content/parts/
  metadata/created_at, **без `ord`**, уже обфусцирован (ADR-036); публикуется один раз на сообщение —
  при отказе постановки события нет; `enqueueUserMessage` — `delivery:'queue'`,
  `enqueueSteerMessage` — `delivery:'steer'`; только для `role: user`),
  `queue.state` (`{pendingCount, steerCount}` — **без текста и автора**),
  `message.delivered` (`{messageId, ord, role, author?, principal?, turnId?}` — `turnId`
  аддитивный: ход сообщения, где сервер его знает: вмешательство на границе шага; у цикла
  сабагента ход ребёнка = id дочерней сессии),
  `turn.started`/`turn.finished`, `step.started`/`step.finished` (usage, стоимость, `attachments`,
  `debugInfo`, `timings`), аддитивные `step.tools.started`/`step.tools.finished` (исполнение
  инструментов шага: `callIds`, один раз на шаг с вызовами — до исполнения и после записи
  `metadata.tool_results`; `turn.finished` — после), `part.delta`/`part.updated` (upsert по
  `{messageId, partId}`).
- **Синхронизация мутаций (2026-11-02).** Роуты публикуют в канал сессии: `message.deleted`
  (`{message_id}`) — `DELETE /messages/:sessionId/:messageId`, batch `action:'delete'` и возврат
  сообщений из очереди (`POST /queue/:sessionId/return`); `message.updated`
  (`{message_id, pinned?|disabled?}`) — toggle/pin/batch/retry; `session.messages.cleared`
  (`{session_id}`) — `POST /sessions/:id/clear` (+ `queue.state{0,0}`); `plan.updated` — тул
  `plan_write`; `project.updated`/`project.deleted` (`{project_id}`) — `PUT`/`DELETE /projects/:id`
  в канал **каждой** сессии проекта (удаление — до удаления); `fs.changed` — HTTP-FS
  (`source:'http'`). Подробности — ADR-118 §4/§7.
- **Удалены без dual-emit:** `stream.chunk`, `stream.usage`, `stream.done`, `stream.interrupted`,
  `message.injected`, `message.queued`. Остаются `stream.start`, `stream.cancelled`, `stream.error`,
  `stream.retry`, `stream.ended`, `queue.stalled`, `steer.dropped`, `permission.*`, `tool_call.*`,
  `child.*`. ⚠️ **Остаток:** `message.added` (финальный assistant с усечённым текстом, вставки
  вложений тулов, дочерние сессии) пока публикуется — см. «Статус в коде» ADR-118.
- **Шаг = сообщение, «финал» = смена статуса.** Сообщение шага создаётся на `step.started` со
  `status: 'streaming'`, персистится инкрементально (`engine/orchestrator/stream-persistence.ts`),
  терминальный статус ставится на `step.finished`.
- **Снимок живого шага (ADR-118 §5).** `engine/live-stream-snapshot.ts` — in-memory снимок
  стримящегося шага (текст, reasoning, части), обновляется на каждом чанке и снимается на
  `step.finished`; отдаётся в DTO сессии как `current_stream.live` (аддитивно). Нужен, чтобы
  клиент открыл сессию посреди хода и увидел всё до текущего момента без ожидания дельты
  (переключение вкладок/reload/второй клиент). Не персистится: после рестарта источник — история. Вложения ответа (ADR-115) — в
  `step.finished.attachments` (`stream.done.attachments` больше нет).
- **Финал хода = последний шаг (ADR-118 §1).** Финальное assistant-сообщение несёт текст и
  reasoning **только последнего шага** (тексты прошлых шагов — в их сообщениях, дублей нет);
  tool-вызовы и результаты — в сообщении **своего** шага (`metadata.tool_results` → DTO
  `tool_calls`), в финале их нет; `metadata.intermediate_text_blocks` для сообщений хода
  (`step.turnId` задан) **не пишется** (legacy — только старые сообщения). DTO сессии несёт
  `current_stream.turn_id` (`turn_…` — id активного хода, `null` — хода нет): по нему клиент
  восстанавливает ход после reload (`stream_id` — не id хода); поле персистится в file-store
  (`current_stream.turn_id`) и PostgreSQL (тот же JSONB-документ).
- **`ord` — монотонный порядок.** Выдаётся при материализации записи в историю
  (`storage/message-write.ts`, `nextOrd`), **не перенумеровывается**; `seq` остаётся позиционным.
  DTO (`server/serialize.ts`) несёт `ord`/`turn_id`/`step_index`/`status`.
- **Шина** (`events/bus.ts`): адресная доставка по `BusEvent.recipient` (подписчик с чужим
  `recipient` событие не получает; широковещание — только для гибридного моста), **глобальный**
  монотонный `eventSeq` (сквозной по всем сессионным каналам инстанса — точка догона одна на
  инстанс, иначе события «хвостовой» сессии терялись) и кольцевой журнал для догона
  (`journalSince`; 200 событий на сессию, до 100 сессий). Инстансный канал (`pipeline.run.*`)
  номера не получает и в журнал не попадает; `latestEventSeq(sessionId)` — номер последнего
  события **этой** сессии; явный `opts.eventSeq` (удалённый источник) не ломает монотонность —
  `seq = max(глобальный счётчик + 1, явный)`.
- **`GET /api/v2/meta`** (`server/routes/meta.ts`, **без аутентификации**; монтируется и в core, и
  в backend): `{messageModel: 2, eventSeq: true, replay: true, version}`; аддитивное `attachments`
  (ADR-115) — эффективные лимиты вложений (`enabled`/`modalities`/лимиты; `MetaRoutesDeps.getAttachments`
  читается на каждый запрос).
- **Гейт версии клиента:** WS `/ws/events` без `messageModel=2` закрывается кодом `1008`
  (`messageModel=2 required`), SSE `GET /api/v2/events` отвечает `426 UPGRADE_REQUIRED`; догон —
  `?since=`/`Last-Event-ID`, SSE-кадр несёт `id: <eventSeq>`. Сессионного SSE нет —
  канал наблюдения один (глобальный `GET /api/v2/events`, ADR-118).
- **Миграция данных** — `storage/migrations.ts` (`migrateMessageStreamV2`, маркер
  `message-stream-v2`, запуск из `storage/instance-meta.ts`): построчно через `updateMessage`,
  идемпотентна, старые ответы разбиваются по итерациям; PostgreSQL — миграция `029`.
- **Миграция содержимого старых ходов** (`schemaVersion` 3) — `storage/migrations.ts`
  (`planMessageStepPartsCleanup` — чистая функция плана, `migrateMessageStreamV2StepParts`,
  маркер `migrations.message-stream-v2-step-parts`): reasoning/tool_results финала старого
  вида переносятся в сообщения своих шагов (слияние по `id` вызова), удаляется
  `intermediate_text_blocks`, у видимых шагов снимается `tool_chain`; только основные сессии
  (`parentId == null` — отчёт дочерней сессии монолитен), построчно и идемпотентно.
- **Адресация мутаций — только по `id` (ADR-118 §7)** (`server/routes/messages.ts`):
  `PATCH /:sessionId/:messageId/{toggle,pin}`, `DELETE /:sessionId/:messageId`,
  `POST /:sessionId/:messageId/retry`, `GET /:sessionId/:messageId/debug` и
  `POST /:sessionId/batch {messageIds[]}`; сообщение ищется по `id` под per-session
  локом, не найдено → `404 NOT_FOUND` (в `batch` — `{messageId, success:false}`),
  фоллбека на позицию/число в истории нет.
- **Перестановка очереди и точечная выдача сообщения (ADR-118 §4).**
  `POST /api/v2/queue/:sessionId/reorder {ids}` (`server/routes/queue.ts` →
  `queue/processor.ts` `reorderPendingMessages`): состав `ids` должен **точно** совпадать с
  `pendingMessages` под per-session локом, иначе `409 QUEUE_CHANGED` (клиент перечитывает),
  невалидный список — `400 VALIDATION_ERROR`; `steerInbox` не трогается (ADR-104),
  публикуется `queue.state`. `GET /api/v2/sessions/:id/messages/:messageId`
  (`server/routes/sessions.ts`) отдаёт одно сообщение тем же `serializeMessage`/
  `redactSecrets`; нет сообщения → `404 MESSAGE_NOT_FOUND`.

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

- `main.ts` — CLI/точка входа (`serve`, `chat`, `connect`, `project publish|fork`, `secrets rotate`, `analytics rebuild`, `memory`, …).
- `execution/` — ADR-077 (шаги 1, 3, 7b + шаг A): порт исполнения команд, выбор реализации по
  режиму и проверка режима при старте —
  `ports/execution-port.ts`
  (`ExecutionPort`, `ExecRequest`, `ExecResult`, `ExecCommand` — union `shell`/`argv`,
  `ExecutionError`, `isExecutionError` — **структурная** проверка типа ошибки порта: клиент
  удалённого порта создаёт ошибку через динамический `import()` (из `dist`), а core импортирует
  класс из исходников — это два разных объекта класса, и `instanceof` не срабатывает; проверка
  опирается на стабильный признак `name === 'ExecutionError'` и форму `reason`/`message`,
  `DEFAULT_MAX_OUTPUT_BYTES`; **шаг A**: `ExecRequest.requires?: string[]`,
  `ExecutionPort.probe?(bin, args?)`, `ExecutionPort.capabilitySummary?(bin)`,
  `ExecutionCapabilitySummary`, `EXECUTION_BASE_CAPABILITIES = ['git','rg','sh']`,
  причина отказа `dependency_missing`), `inline-execution-port.ts`
  (`InlineExecutionPort` — исполнение в процессе через `spawn` с `detached: true` (лидер
  собственной группы: «Стоп»/таймаут/лимит вывода гасят **группу** — `SIGTERM`, через 5 с
  `SIGKILL`; завершение — по `exit` + дренаж потоков 250 мс, а не по `close`, иначе внук,
  унаследовавший пайп, «подвешивал» вызов); `probe()` — поверх общей пробы;
  **ADR-113**: `spawnBackground?(req)` — фоновый запуск через `spawn` (не `execFile`):
  `processId` = `proc_<uuid>`, `pid`, поток `output` (`stdout`/`stderr` кусками), промис `exited`
  (`exitCode`/`signal`/`durationMs`), `stop(signal='SIGTERM')`; `timeoutMs > 0` — таймер
  (`unref`) `SIGTERM` → `SIGKILL` через 5 с; `requires`/`signal`/`maxOutputBytes` в фоне
  не применяются (проверка бинарных требований — на слое тула, отмена — через `stop()`)),
  `probe.ts` (**единственная** проба `bin --version` через порт: `ENOENT` → `false`, прочая ошибка →
  `true`, fail-open, ADR-078), `contract/`
  (контрактный suite порта — обязателен для любой реализации, как `storage/contract/`;
  общий набор проверок + блоки `describeInlineOnlyExecutionChecks`/`describeRemoteOnlyExecutionChecks`
  — разделение намеренное: у remote `cwd` обязан лежать в workspace исполнителя, у inline
  такого ограничения нет; `probe`/`requires` проверяются в общем наборе, `dependency_missing` —
  в remote-блоке; **ADR-113**: блок `describeBackgroundExecutionChecks` — фоновый запуск
  (поток вывода, `exitCode`, `stop()`, таймаут) — только там, где метод реализован;
  **фоновый запуск — в обеих реализациях** (inline и remote, ADR-077 шаг 7c): в
  remote-блоке проверяется, что `spawnBackground` **реализован** и что
  containment `cwd` действует и для фонового запуска), `remote.ts` (загрузчик удалённого порта: **динамический `import()`
  по строке-константе** `'@itphx/synth-executor/client'` + локальный интерфейс модуля +
  каст — по образцу драйвера хранилища в `storage/storage-context.ts`; чтение токена из
  файла по `execution.remote.tokenSecret` — **fail-closed**, значение токена не логируется
  и не попадает в текст ошибок; `RemoteExecutionUnavailableError` — отдельный класс;
  **инвентарь пула и маршрутизация по `requires` живут в клиенте пакета** —
  `packages/executor/src/client.ts`: карта «адрес → состав программ» по `GET /capabilities`
  всех адресов, TTL `REMOTE_CAPABILITIES_TTL_MS = 120_000` с ленивым обновлением,
  `probe()`/`capabilitySummary()` по инвентарю, маршрутизация команды в адрес с нужными
  бинарями; адрес без нужного бинаря и не ответивший адрес из маршрутизации исключаются,
  подходящего адреса нет → `dependency_missing`/`EDEPENDENCY` с текстом «в пуле: N из M»;
  **фоновый запуск в remote** (ADR-077 шаг 7c; ADR-113): `spawnBackground` — опрос состояния
  (`GET /exec/:id`, 500 мс) и журнала (`GET /exec/:id/logs`, 300 мс) исполнителя —
  стриминга на проводе нет; `stop(signal)` уходит на исполнителя телом
  `{ signal }` (`POST /exec/:id/stop`: `SIGTERM`|`SIGKILL`, иной сигнал — `400`),
  поэтому конкретный сигнал доезжает, а не подменяется дефолтом сервера;
  обёртка `RemoteExecutionPortWithExecutorMcp` пробрасывает
  метод **только если его умеет внутренний порт** (иначе «фон не поддерживается» не
  отличить от «метод есть, но падает»); исполнитель протокола < 3 (нет
  `features.background`) → `ExecutionError.code = 'EBACKGROUND'`
  (`EXECUTION_BACKGROUND_UNSUPPORTED_CODE`) → `background_unsupported` в
  `engine/processes`),
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
  `collectors/*` (`bus` — turns/streams/retries/cost (считаются по `turn.*`/`step.finished`, ADR-118: имена и лейблы не менялись), `llm` — `createLlmCallRecorder` для
  `GatewayProvider.onCall`, `sessions` — 15 c, `storage` — записи/деградация 60 c и `{dataDir}` 300 c,
  `events` — ingest/decisions + журнал 5 мин, `scheduler`, `webhooks`, `hybrid`, `decision`,
  `authority` — `createAuthorityMetrics`: `synth_authority_decisions_total` (ADR-106 Ф1 — решения
  Authority-слоя; лейблы только `action`/`effect`/`source`, значения приводятся к конечным наборам,
  неизвестное → `other`; id принципалов/сессий/ходов в лейблах нет), `ready`,
  `pipelines` — `createPipelineMetrics`: `synth_pipeline_*` (ADR-101 — прогоны/шаги/длительности/
  HITL-ожидания; лейблы только `status`/`source`/`kind`/`outcome`, id прогонов и узлов в лейблах нет —
  значения приводятся к конечным наборам, неизвестное → `other`; ошибка метрик не влияет на прогон),
  `executor` — `createExecutorMetricsCollector`: `synth_executor_*` (ADR-077 шаг 7d — сторона control
  plane: `synth_executor_queue_depth`/`_workers_busy`/`_wait_seconds`/`_commands_total{outcome}`; sink —
  `ExecutionMetricsSink` (`execution/ports/execution-port.ts`), который дёргает клиент удалённого порта;
  серии исполнителя (`_exec_duration_seconds`/`_inflight`/`_mcp_servers`) считает сам исполнитель в
  своём `/metrics` — `synth_executor_commands_total` есть на обеих сторонах и считает **разное**
  (доставленные вызовы vs исполненные команды), суммировать их нельзя)).
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
- `server/routes/*` — `health`, `hybrid`, `auth`, `sessions` (`GET /:id/memory` — агрегаты памяти сессии для вкладки «Память», ADR-107; `POST /:id/background` — detach блокирующих прогонов, ADR-111; вложенные маршруты `attachments.ts` — `POST /:id/attachments` / `GET /:id/attachments/:partId`), `messages`, `projects` (`memory` — политика памяти проекта),
  `project-transfer`, `project-portable`, `providers`, `models`, `agents`, `fs`, `queue`, `updates`,
  `settings`, `metrics-settings` (ADR-094: `/settings/metrics*`), `meta` (ADR-118: `GET /api/v2/meta` — возможности инстанса, без аутентификации), `dictionaries`, `mcp`, `skills`,
  `commands`, `skill-bundles`, `skill-scope`, `git`, `ssh-keys`, `events`, `identities`,
  `service-keys`, `webhooks`, `oauth` (ADR-105 Ф4: `/api/v2/oauth/credentials*` — выдача,
  метаданные, refresh, отзыв, привязка к MCP-коннектору), `maintenance`, `analytics`,
  `attachments-staging` (ADR-115: `/api/v2/attachments` — staging-загрузка без сессии и раздача
  по `sha256`), `settings-attachments` (`/settings/attachments` — runtime-настройки вложений),
  `processes` (ADR-111/PROP-096/097: `/api/v2/processes*` — единый реестр фоновых прогонов;
  в деградированном режиме хранилища контур **не монтируется** → 404).
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
  **Расход: сообщение = свой вызов, сумма по сообщениям = ход** (ADR-118 сделал шаг отдельным
  вызовом LLM, паритет с opencode). `usage` каждого assistant-сообщения — расход **ровно своего**
  вызова провайдера (у финального — последнего, не сумма); сумма usage сообщений хода = расход
  хода. В оркестраторе копится `turnUsage` (`engine/orchestrator/usage.ts: addTokenUsage` — по
  одному разу на итерацию, `iterationUsage`, а не по чанкам); он пишется в счётчики сессии
  (`Session.inputTokens`/…) и в роллап `usage` (одна запись на ход: `requests=1`/`messages=1`),
  а `usage` сообщения — в историю и `metadata.cost_*` (стоимость **своего** usage). **Инвариант:
  сумма usage assistant-сообщений + aux-вызовы = счётчики сессии.** Aux-вызовы (title, QA
  self-check, fork-summary, derive вложений, отклонённые вызовы micro/decision) идут через
  `engine/usage-accounting.ts` (`recordAuxUsage`: счётчики сессии + роллап `requests=1` **без**
  `messages`; best-effort; `messages:1` — для микро-ответа, `model=micro:<taskClass>`). `TokenUsage.cost` (стоимость от провайдера) приоритетнее каталога
  (`providers/usage.ts: parseUsageCost`/`computeUsageCost`; `0` достоверен, breakdown — нули,
  разные валюты не складываются); стоимость хода копится **по шагам их моделями**
  (`turnCostByCurrency`/`turnCostBreakdown`), поэтому смена модели между шагами не искажает
  аналитику. `metadata.step_duration_ms` — длительность своего вызова (TPS), `metadata.duration_ms`
  — хода (аналитика/`computeSessionStats`). `finalUsage` (расход последнего вызова) — оценка
  (`estimateUsage`), калибровка chars-per-token и событие `step.finished` (там расход **своего**
  шага; сумма по шагам = расход хода, метрики Prometheus не меняются). Бакеты сабагентов
  (`metadata.subagents`) считаются отдельно; при смене модели внутри прогона parent-аналитика
  группирует по `subagent_model` (известное ограничение). `analytics/rebuild.ts` агрегирует usage
  **по ходу** (`turn_id` → `metadata.stream_id` → id сообщения), `interrupted`-сообщение — отдельная
  запись (parity с live), включает usage скрытых `tool_chain`-шагов (иначе недосчёт); activity по
  `tool_chain` по-прежнему не считается. Старая история **не мигрируется** (у старых ходов usage
  финала = сумма, шаги без usage).
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
  инвариант 16). ADR-105 Ф4: `pending-flows.ts` (незавершённые выдачи PKCE/device —
  `state`, код верификатора, срок), `bind-connector.ts` (привязка доступа к записи
  реестра MCP), `audit.ts` (единая точка записи операций в журнал, best-effort);
  HTTP-контур — `server/routes/oauth.ts` (`createOAuthRoutes`, общий для core и
  backend; секрет наружу не отдаётся — только `ExternalCredentialMeta`; право
  распоряжаться доступом — на границе, инвариант 16); журнал операций — порт
  `CredentialAuditRepository` (`storage/ports/credential-audit-repository.ts`:
  append-only, `SECURITY_AUDIT_SCOPES` в `shared` **не расширяется**; файл
  `{dataDir}/audit/credentials.jsonl`, PG — миграция `014`; журнал **не** публичный
  API — эндпоинта чтения нет); ротация мастер-ключа — `security/rotate.ts`
  (`ExternalCredentialStore.rotateMasterKey`: preflight → перешифровка → `master.key`,
  `--dry-run`); остаток Ф4 — только UI «Доступы».
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
  + `QueueProcessorManager.requestStop`; без процессора флаг снимается; **только активный ход** —
  фоновые процессы/фоновые (detached/background) саб-агенты продолжают работу и останавливаются
  отдельно (`POST /processes/:id/stop`, «Стоп» дочерней сессии); решение 2026-10-31, взамен
  2026-10-28; `BackgroundRunService.stopBySession` из роута не вызывается — метод оставлен
  публичным API сервиса).
  Там же `POST /:id/permissions/:approvalId` — **HTTP-ответ на подтверждение**
  (`permission.asked`) для SSE/не-WS клиентов: то же решение, что у WS-кадра
  `permission_reply` (при подключённом реестре — `ApprovalRegistry.claim`,
  403 `APPROVAL_DENIED` с `details.reason`), `hold` публикует `permission.hold`;
  опция `resolvePermissionResponder` задаёт аутентифицированного принципала
  (core — локальный пользователь с ролью `ADMIN`). Ожидание подтверждения
  снимается «Стопом»: `PermissionApprovalManager.waitForDecision(..., signal)`
  (ADR-005) резолвится `{approved:false, cancelled:true}` без публикации
  `permission.asked`, причина в результате тула — ключ `permission.ask_cancelled`.
- `server/routes/fs.ts` — единственная FS-фабрика (core + backend, ADR-075). `GET /raw` —
  предпросмотр файла: inline **только** для `INLINE_PREVIEW_KINDS` (`image`/`video`/`audio`/`pdf`,
  MIME — `fileMime`), иначе `application/octet-stream` + `Content-Disposition: attachment` (HTML —
  никогда inline: XSS), SVG — CSP `default-src 'none'; style-src 'unsafe-inline'; sandbox`;
  `Range`/`206` + `Content-Range`, `If-None-Match`/`304`, `Accept-Ranges`, `ETag` (size+mtime),
  `Last-Modified`; поток `createReadStream` + `Readable.toWeb`; cap `storage.maxPreviewBytes`
  (`413 FILE_TOO_LARGE`, `details.reason='preview_size'`). `maxPreviewBytes` приходит из
  `resolveMaxPreviewBytes` в обе сборки (`server/app/mount-routes.ts`, backend
  `app/mount-routes.ts`/`lib/app-config.ts`).
- `server/fs-workspace.ts` — резолв workspace проекта для FS-роутов
  (`resolveProjectWorkspace`, ADR-075) и детект бинарных файлов (`isTextFile`).
- `engine/attachments/*` — ADR-115: вложения сообщений (сервис, MIME, приватность, GC,
  материализация, обработка aux-моделью, потоковая/chunked-загрузка `uploads.ts`,
  миниатюры `thumbnails.ts`, сжатие `compress.ts`). Устройство и правила — §«Вложения (ADR-115)» ниже.
- `engine/media/runner.ts` — единственный путь запуска `ffmpeg` (inline `spawn` / remote через
  `ExecutionPort.execute` с `requires: ['ffmpeg']`); типизированные исходы, каталог
  `{workspacesRoot}/.synth-media` в `finally`.
- `engine/media/pruner.ts` — `startMediaTempPruner`: уборка временных каталогов медиа-раннера
  `{workspacesRoot}/.synth-media/*` (после жёсткого kill раннер не успевает убрать каталог —
  `finally` не выполняется): TTL `MEDIA_TEMP_TTL_MS` = 1 ч, интервал 6 ч, `unref`, best-effort
  (ошибка одной записи не мешает остальным), каталог **не создаётся**; вызывается при старте
  (core `server/app/deps.ts`, backend `app/deps.ts`), останавливается на graceful shutdown
  (`stopMediaTempPruner`).
- `engine/orchestrator.ts` — `ChatOrchestrator` (цикл LLM + Tool Use); опциональная зависимость `isCancelRequested` (персистентный флаг сессии) останавливает многоитерационный Tool Use (верх `while (toolIteration < maxIterations)`), когда живой cancelToken недоступен. ADR-095 (шаг 6a): самостоятельные методы вынесены в `engine/orchestrator/*` (`usage`, `fs-change`, `errors`, `persistence`, `routing`, `prompt-info`, `commands`, `debug`, `summarization`) — класс делегирует через тонкие обёртки/`*Deps()`-геттеры; (шаг 6b-1): из `_processMessage` вынесены фазы `engine/orchestrator/phases/*` — `process-early.ts` (системные сообщения, `/`-команды, micro-first; микро-слой больше **не ставит** плашку `Dialog — <id8>` (прежний i18n-ключ `session.dialog_title` удалён) — она блокировала нормальное имя; имя сессии теперь даёт авто-тайтл), `process-setup.ts` (подготовка запроса: провайдер → MCP → state → Composer → тулы; после неё — ранний триггер авто-имени `_maybeAutoTitle`), `process-finalize.ts` (эпилог: отмена/фоллбеки/quality-check+escalation/персист шага/`turn.finished`, ADR-118 — авто-тайтла здесь больше нет); в `_processMessage` остались пролог-скаляры, тело цикла Tool Use и его обработчики. Сборка промпта (ADR-070): `getPromptInfo(session)` → `PromptDiagnostics` (manifest + `history` + `promptState` активного агента + `lastPromptMeta` + `toolsDetail`), `_buildPromptHistoryInfo` зеркалит `_sessionMessagesToLlm`; state-сообщения (`syncStateMessages`) превращаются в синтетические user-сообщения `<system-state>`; `promptStates[agentKey]` читается/пишется по generation, `_cachePolicy` (`llm.cache`) уезжает в `SystemPromptPayload`; `_filterToolsByMode` удалён — список тулов постоянен.
  **Финальный шаг по лимиту шагов (`AgentDefinition.maxSteps`) — механика opencode**
  (`engine/llm/max-steps.ts`, общий модуль с циклом саб-агента): лимит не обрывает ход
  отдельным вызовом «без инструментов», а добавляет ещё один обычный шаг того же цикла —
  инструменты **остаются в запросе** (у провайдера сохраняется кэшированный префикс),
  вызов запрещён `toolChoice: 'none'`, инструкция «отвечай только текстом» вставляется
  **assistant-сообщением** (в историю не пишется).
  **Нумерация шагов — off-by-one opencode (`0159927f`):** `stepLimitStep = iteration + 1 >= maxSteps`
  (`orchestrator.ts` и `run-cycle.ts`), то есть `maxSteps: N` даёт **N−1 рабочих шагов + шаг-лимит**,
  а `maxSteps: 1` — сразу только шаг-лимит (tool-вызовов в ходе нет; в тестах лимит считается
  именно так). Иначе трактовка «N рабочих шагов, потом отчёт» — ошибка.
  **«Непослушный» tool call на шаге-лимите — паритет с opencode.** Провайдер вернул `tool_calls`
  несмотря на `toolChoice: 'none'` — вызовы **не исполняются, но и не выбрасываются молча**:
  `assistant(tool_calls)` сохраняется, на каждый вызов пишется парный `tool`-результат с `isError`
  и ключом `tool.disabled_by_step_limit` (`{tool}`, `{limit}`; текст — «инструмент не выполнен —
  после достижения лимита шагов инструменты отключены»), публикуется `tool_call.result`, результат
  персистится (`_persistToolResult`), затем ход завершается отчётом (`break` после батча). Пары
  `toolUse`/`toolResult` не рвутся — иначе следующий LLM-вызов получил бы `400`
  «insufficient tool messages following tool_calls».
  **Отчёт по лимиту шагов — свой текст у каждого цикла.** Саб-агент: пустой ответ на шаге-лимите →
  `task.steps_limit_empty` (`{limit}`), а страховка `task.steps_limit` (`[steps_limit]`) дописывается
  к результату тула после отчёта — всегда, когда шаг-лимит исполнялся (короткая причина + лимит).
  Основной агент: пустой ответ →
  `session.steps_limit` (`{limit}`, паритет с саб-агентом; раньше подставлялся посторонний
  `session.max_iterations`), статус ответа — `limit` (`persistence.ts`), а `step_limit_reached: true`
  кладётся в метаданные финального assistant-сообщения (отдельного поля события больше нет: `stream.done` удалён, ADR-118). Флаг `stepLimitExecuted`
  ставит сам цикл (`orchestrator.ts`) — отчёт подставляется только когда шаг-лимит реально исполнялся;
  прежняя ветка `toolIteration >= maxIterations → session.max_iterations` в основном цикле не
  используется (ключ остался для шагов пайплайнов, `engine/pipelines/executors/agent-step.ts`).
  **Лимит вывода (`max_tokens`) — одна политика** (`engine/orchestrator/max-output.ts`; применяется в
  `engine/orchestrator/routing.ts` — `getProvider` и ветка роутера, значения приходят из
  `server/app/deps.ts` и `backend/app/deps.ts`). `SessionSettings.maxTokens = 0` — «авто»; приоритет
  источников: явное значение сессии → `ModelConfig.maxOutputTokens` (каталог; он же **кап** — больше
  заявленного моделью не отправляем) → `llm.maxTokens` конфига (дефолт 8192, env
  `SYNTH_LLM_MAX_TOKENS`) → 8192. У моделей с `compatibility.requireReasoning` (`ModelConfig.requiresReasoning`)
  действует **пол** `REASONING_MIN_OUTPUT_TOKENS = 8192` — adaptive thinking расходует тот же
  `max_tokens`, — но не выше каталога. Причина завершения нормализуется адаптерами в
  `LlmFinishReason` (`LLMChunk`/`LLMResponse.finishReason`: Anthropic `stop_reason`, OpenAI
  `finish_reason`, Ollama `done_reason`), thinking-токены — в `TokenUsage.reasoningTokens`. Пустой
  ответ с `finishReason: 'max_tokens'` получает текст `session.output_limit` (`max_tokens=N, из них
  M на размышления`, ADR-041) и статус `error`, а нормализованная причина всегда пишется в
  `metadata.finish_reason` финального сообщения — иначе «модель промолчала» и «бюджет ушёл в
  размышления» неразличимы.
  **Политика контекстного окна (`context.windowPolicy`).** `off` | `warn` (дефолт) | `enforce`;
  резолвер `resolveContextWindowPolicy` (env `SYNTH_CONTEXT_WINDOW_POLICY` > runtime
  `settings.json`/PG > `config.yaml` > default) читается оркестратором перед **каждым** LLM-вызовом,
  поэтому `/api/v2/settings/context-window` применяется без рестарта. Проверка —
  `checkContextWindowWindow` (`engine/context/window-guard.ts`): оценка промпта
  (`estimatePromptChars` + калиброванный chars-per-token) сравнивается с окном
  `ModelConfig.contextWindow` за вычетом резерва на вывод (`resolveMaxOutputTokens`); при `enforce`
  и `оценка > окно − резерв` провайдер **не вызывается**, ход завершается ошибкой
  `router.context_length_exceeded` (`error_type: 'context_length'`, metadata
  `context_window_exceeded`/`context_window_tokens`). Неизвестное окно (`0`) не блокирует никогда —
  это предохранитель, а не бюджетирование.
  **Дефолты оптимизации контекста новых сессий (`context.defaults`).** Instance-wide значения
  резолвит `resolveContextDefaults`
  (runtime `settings.json`/PG > `config.yaml` > дефолты схемы; env нет) — `SessionManager` читает
  live-геттер `contextDefaults` **при создании** сессии, поэтому `/api/v2/settings/context-defaults`
  применяется без рестарта. Явные `settings` запроса приоритетнее, существующие сессии не меняются;
  без опции `SessionManagerOptions.contextDefaults` поведение прежнее (литералы). Режим —
  `contextOptimization` (`none`|`sliding_window`|`summarization`|`compaction`, взаимоисключающие),
  дефолт новых сессий — `compaction`.
  **Сжатие контекста: два режима (ADR-119).** `summarization` — итоги беседы,
  `compaction` — рабочее состояние по коду/проекту; движок — `engine/context/optimizer.ts`
  (`effectiveMode` учитывает легаси `none`+`summarizationEnabled`, `shouldCompress`,
  `prepareCompression`/`completeCompression`, `canCompress`). Хвост — в **токенах**
  (`summarizationKeepTokens` 5000, `compactionKeepTokens` 15000), а не в сообщениях; суммаризация
  триггерится по `messages` (N реплик) или `tokens` (% окна), компактизация — только по токенам:
  `окно − max((100 − pct)% окна, 16000)`, при резерве ≥ окна и неизвестном окне авто-триггер
  выключен (ручной запуск/overflow работают). Оценка — `input+output` последнего assistant той же
  пары провайдер/модель + оценка последующих; измерение до последнего SUMMARY не используется.
  Сжатие — LLM-вызов через `GatewayProvider` (ADR-036), резюме — сообщение `role: summary` с
  `summaryOf` и `metadata {type:'auto_summary', mode, keepFrom}`; покрытые сообщения получают
  `disabled` + `metadata.compactedBy` (pinned не трогаются, хвост остаётся живым). Для LLM
  `getMessagesForLlm` отдаёт `[SUMMARY] + живой хвост`, а `phases/process-setup.ts` вынимает
  SUMMARY в системный блок `summary` (volatile, order 30, ADR-070) — история = хвост + новые.
  Промпты — `prompts/system/{SUMMARIZER,COMPACTOR}.{ru,en}.md`; валидация: компактизация ≥2
  заголовков шаблона, суммаризация — непустой ответ, один nudge-повтор. Бюджет запроса сжатия —
  окно минус `max(4000, 20% окна)`, при нехватке — уровни усечения от старых к новым (tool-капы
  300→80, аргументы 120→80), последний user-ход не выбрасывается. Overflow
  (`ContextLengthExceededError`/`classifyLlmError === 'context_length'`) — **одно** принудительное
  сжатие за ход, повтор шага с synthetic `[CONTEXT CHECKPOINT]` + хвост + текущий ход
  (`engine/orchestrator/overflow.ts`, пары tool-вызовов проверяются); второй overflow — штатная
  ошибка, при `none`/`sliding_window` сжатие не запускается. Событие
  `context.summarization_applied` (`reason`, `mode`, `covered_indices`, `keep_from`, `usage`) —
  в обычном пути и при overflow; ожидание — `context.summarization_pending`.
  **Лимиты заметок сессии (`context.stickyNotes`).** Instance-wide ограничения `maxCount`/`maxChars`
  (дефолты 50/2000) резолвит `resolveStickyNotesLimits` (runtime `settings.json`/PG > `config.yaml` >
  схема; env нет), опция `getStickyNoteLimits` core-фабрики сессий читается на каждую операцию —
  `/api/v2/settings/sticky-notes` применяется без рестарта; 409 `LIMIT_EXCEEDED`/400
  `VALIDATION_ERROR`, существующие заметки не обрезаются. Роуты заметок (`/sessions/:id/notes*`)
  живут **в core-фабрике** (единая реализация для standalone и backend).
  **Предохранитель бюджета контекста саб-агента (`agents.subagentMaxInputTokens`).**
  В цикле саб-агента (`engine/tools/task/run-cycle.ts`) перед **каждым** LLM-вызовом
  считается оценка промпта: `estimatePromptChars(messages, systemPrompt, tools)` →
  `estimateTokens(chars, tokenRatio)` (`engine/context/token-ratio.ts`). Ratio — **калиброванный
  chars-per-token модели прогона** (`loadTokenRatio` из `TaskExtra`/`SubagentResumeDeps` → тот же
  `_loadTokenRatio` оркестратора), резолвится один раз на прогон; нет калибровки/ошибка загрузчика —
  дефолт 4 (fail-open). Оценка выше лимита (и лимит `> 0`) — провайдер **не
  вызывается**: прогон завершается детерминированным отчётом без LLM
  (`task.context_budget`: токены, выполненные шаги, незавершённые задачи из `session.todos`
  либо из описания задачи — результаты инструментов не пересказываются), отчёт пишется
  обычным assistant-сообщением дочерней сессии со статусом `completed`, в metadata —
  `context_budget_exceeded`/`context_budget_tokens`/`steps`, родителю публикуется
  `subagent.context_budget`. **Шаг-лимит имеет приоритет:** финальный шаг-отчёт opencode
  (см. выше) превышением бюджета не считается. **Дефолт — `0` (без лимита)**, `0` —
  ограничение выключено; оценка недоступна/пуста — не блокируем. Это предохранитель объёма
  промпта, а не окно модели. Значение — instance-wide runtime-настройка
  `agents.subagentMaxInputTokens`: резолвер `resolveSubagentMaxInputTokens` (env
  `SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS` > runtime `settings.json`/PG > `config.yaml` > `0`)
  читается оркестратором при сборке `task` extra (`getSubagentMaxInputTokens`; в
  `TaskExtra`/`SubagentResumeDeps` — число или геттер), поэтому
  `/api/v2/settings/agents-limits` (UI «Пределы саб-агентов») применяется к **следующим**
  прогонам без рестарта.
  **Вложения из тулов (`_injectToolAttachments`, ADR-115).** Вызывается на границе
  итерации Tool Use — **после** того как все результаты итерации попали в `currentMessages`
  (`allToolCalls` с полем `iteration`) и **до** следующего LLM-вызова; порядок строго
  `assistant(tool_use) → tool(tool_result) → user(media)` (media-реплика — отдельное
  user-сообщение после буфера `tool_result`, пары не рвутся). Каждая ссылка
  `ToolResult.attachments` валидируется (`isToolAttachmentRefValid`: `blobPath` строго под
  `attachments/`, `sha256` 64 hex, `mime`, `size > 0`), дубли по `blobPath` схлопываются,
  бюджет — `MAX_TOOL_ATTACHMENTS_PER_TURN = 4` и `attachments.maxBytesPerMessage`
  (по умолчанию 20 МиБ); лишнее отбрасывается с логом (текст результата модель всё равно видит).
  Принятое вложение — отдельное сообщение `role: user`, `author: 'Tool'`,
  `metadata {source: 'tool-attachment', tool, call_id, agent_role}` (роль агента — для
  UI-подписи «Агент · <имя> · вложение»), публикуется в канал сессии
  (`message.added`/`session.updated`) и пишет ссылку в `blob_refs` (best-effort); байты
  в блобы кладёт только control plane — тул отдаёт ссылку, не base64. Сообщение —
  **служебное** (`isServiceUserMessage`): не реплика человека для авто-заголовка, не
  граница автора в `sessions/stats.ts` и не граница хода в `disabled-turns.ts`
  (вложение наследует `disabled` текущего хода).
  **Deny не останавливает ход (обновлено 2026-10-29).** Любой отказ permission-слоя —
  `role.unavailable` (тул недоступен агенту), ask→deny пользователя или запрет политики —
  возвращается модели как обычный `tool_result` с причиной; следующая LLM-итерация
  запускается, модель может выбрать другой инструмент. Защита от зацикливания: doom-loop,
  лимит шагов (`AgentDefinition.maxSteps`; без него — `DEFAULT_MAX_ITERATIONS = Infinity`;
  `session.max_iterations` в основном цикле больше не используется — он остался у шагов
  пайплайнов) и счётчик одинаковых deny-вызовов (`MAX_REPEATED_DENY_COUNT = 5` подряд → ход
  завершается).
  `session.role_tool_blocked` (`{tool}`, `{agent}`; статус `stopped`) — только фоллбек-текст,
  если модель так и не дала содержательного ответа (`process-finalize.ts` + `persistence.ts`).
  Саб-агент `task` ведёт себя так же (`run-cycle.ts`): `subagentDenied` — лишь фоллбек
  `task.stopped_by_deny`, цикл после deny продолжается; предохранитель — лимит шагов.
  **Detach блокирующих прогонов (ADR-111 §detach).** `activeRuns: ActiveRunRegistry`
  (`engine/background/active-runs.ts`, в памяти процесса) хранит хэндлы переводов в фон:
  `task` (саб-агент) и `execute_shell` регистрируют `{id, kind, title?, detach()}` на время
  блокирующего ожидания, `POST /api/v2/sessions/:id/background` (`server/routes/sessions.ts`)
  вызывает `detachAll(sessionId, {type?})` → прогон продолжается уже фоновым (свой
  `AbortController`/`streamId`, публикация в родительский стрим отключена), а ход получает
  «переведено в фон»; публикуется `process.detached`. Ответ — `{sessionId, detached[], failed?}`
  (пустой `detached` — штатный исход, не ошибка); гибридная (`remote:`) сессия — `400
  DETACH_UNSUPPORTED` (живого хэндла в этом процессе нет); повторный detach идемпотентен.
  **Исходящие вложения ответа.** `step.finished` несёт аддитивное
  `attachments?: Array<{sha256, mime, size, name?}>` — медиа-части **финального**
  assistant-сообщения хода (`collectOutboundAttachments`, `phases/process-finalize.ts`; `stream.done` удалён, ADR-118;
  `saveAssistantMessage` собирает `parts` = текст + накопленные `send_attachment`-части).
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
  «выписывается» из правила `plugin`); `engine/security/*` — injection/shell/protected paths
  (`shell-guard.ts`: `\` в POSIX-shell — экранирование/регэксп, а не разделитель пути, поэтому
  regex-аргументы (`grep -v '\.sample$'`) путями не считаются, а Windows-пути распознаются явно —
  `C:\…`, `\\server\share`; аргументы-паттерны (`sed`-скрипт, regexp `grep`, программа `awk`,
  набор `tr`, разделитель `cut`, фильтр `jq`) шаг 6 не спрашивает; значения `find` (включая
  `-path/-ipath/-wholename/-name/-iname/-regex/-iregex`) проверяются как пути — шаблон без `/`
  (`*.ts`) путём не считается; слитные перенаправления (`>&`, `>|`, `<>`, `&>`, `2>`) дают цель
  как операнд (fd `2>&1`/`>&-` пропускаются), а `tokenizeCommand` выделяет оператор отдельным
  токеном вне кавычек/`$(...)`;
  однокомпонентный и bare-glob (`dir/*.srl`, `*`, периметр передаёт `permission/evaluator.ts`) проверяется по
  фактическим совпадениям (`opendir` с лимитом 2000 + `globMatch`, realpath каждого): безопасные — `allow`,
  deny/approval среди совпадений — deny/ask; многокомпонентный glob, путь вне периметра, симлинк
  наружу, отсутствие совпадений и превышение лимита записей — `ask`. Deny приоритетнее ask (внутри сегмента и по сегментам),
  раскрытое значение-команда (`eval $C`, `sh -c "$C"`) — `ask`; динамическое имя команды
  раскрывается из биндингов (`for NAME in …`, `NAME=value`): простые значения переписывают сегмент
  и проверяются рекурсивно (deny/ask/allow), нерезолвимое или значение с пробелами/метасимволами — `ask`;
  префиксные обёртки (`sudo/env/timeout/command/builtin/exec/nohup/setsid/nice/stdbuf/ionice/watch/flock/xargs`)
  снимаются послойно и проверяется вложенная команда; shell-префиксы `!/time/{/(/if/while/until/for/case`
  снимаются до определения команды; плюс общий скан `EMBEDDED_EXECUTORS`
  (`su/runuser/doas/script/ssh/chroot/unshare/nsenter/systemd-run`, контейнеры `docker/podman/nerdctl/kubectl/oc`,
  интерпретаторы с версиями): аргументы-команды и код (`-c/--command/-e/-r/-p/-S`, `--eval=`/`--split-string=`,
  слитные кластеры `-qec…`/`-E…`, `-oKey=code`) проверяются рекурсивно (глубина ≤ 3), маркер → deny;
  код в опциях инструментов (`git -c`, `tar --to-command`, `rsync -e/--rsh`) — рекурсивно; `awk system(...)`,
  `find -exec/-execdir`, код `python/node/perl/ruby/php -c|-e` проверяются рекурсивно;
  `find` с `-delete/-exec` при стартовом пути вне периметра или с динамикой → ask, защищённый старт → deny;
  `cd/pushd`, `env -C`, `chroot`, `sudo -D` меняют cwd для последующих сегментов/рекурсии
  (нерезолвимая цель `cd` — fail-closed `ask`);
  код на stdin (`<<`, `<<-`, `<<<`) для shell/интерпретаторов/awk — fail-closed `ask`
  (тело heredoc не анализируется; `cat <<EOF`, `grep <<< "$x"` не трогаются);
  простой brace-expansion `{a,b}` раскрывается до проверки, неподдерживаемый (`{1..3}`) → ask
  (форматы `{{…}}`/jsonpath — литерал); `$VAR` в `[ ]`/`[[ ]]`/`test`/`(( ))` — значение, не путь;
  `/proc/<pid|self>/{root,cwd}/<path>` проверяется как `<path>`, `$1/${1}/$@/$*` — неизвестная динамика → ask;
  `shell-variables.ts` собирает `NAME=value`/`NAME+=value`/`for NAME in …`/`read` и раскрывает `$VAR`/
  `${VAR%pat}`/`${VAR#pat}`: если все значения — одиночные литеральные пути (без пробелов и
  шелл-метасимволов), проверяются как пути (deny/approval), неизвестная динамика (`$(...)`,
  `while read`, `$X`) по-прежнему `ask`); `engine/security/secret-files.ts` — политика «файлы и каталоги секретов» (`isSecretFileName`/`isSecretDirectoryName`; список имён и каталогов + шаблоны `.env*`/`credentials*`/`secret(s)*`/`service-account*`/`id_*`/`*.pem|key|p12|pfx|jks|keystore|ppk|kdbx`/`*.tfstate*`; отдаётся плагину через `facade.security`, т.к. сканер расширений блокирует бандл за упоминание имён секретных файлов); слой доступности (`engine/permission/availability.ts`, ось `ToolAccess` — ADR-070: `allow`/`ask`/`deny`/`unavailable(mode|role|dependency|workspace)`) учитывает причины `dependency` — нет внешней программы тула (`engine/tools/runtime-deps.ts`, ADR-078; источник — порт, ADR-077 шаг A) — и `workspace` — не задан рабочий каталог проекта для file/shell/git-тулов (`isWorkspaceDependentTool`, ADR-075; исключения — `WORKSPACE_FREE_TOOLS`: `ssh_keys_list`, ресурс инстанса, ADR-076); деталь недоступности (`ToolAvailability.detail` — «в пуле: N из M») доходит до текста deny в `evaluator.ts` и до модели через `UnavailableTool.detail` (`engine/context/state-messages.ts`); `security/crypto.ts` — AES-256-GCM и мастер-ключ секретов, `security/rotate.ts` — ротация мастера (ADR-076).
- `engine/context/*` — `ContextBuilder`, `ContextOptimizer` (два режима сжатия — суммаризация и компактизация, ADR-119), `ContextConfig`, интервью (статус — поле `ProfileData.interviewCompleted`; блок `[INTERVIEW]` — только первое сообщение сессии от пользователя при незаполненном профиле и доступном агенту `profile_update`, гейт `interviewEligible`).
  `ContextConfig.getMaxStepsPrompt(language)` — требование «только текст» для
  финального шага-отчёта по лимиту шагов — у **саб-агента** (`run-cycle.ts`) и **основного** агента
  (`orchestrator.ts`; общий модуль сборки — `engine/llm/max-steps.ts`, `prompts/system/MAX_STEPS.{lang}.md`;
  override — `{dataDir}/user/system/MAX_STEPS.{lang}.md`; пустая строка, если файла нет — тогда
  встроенный fallback `MAX_STEPS_FALLBACK_PROMPT`).
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
  обёртка `<system-state type="…">`, `UnavailableTool`). Блок `memory.guide` (`prompts/system/MEMORY.{ru,en}.md`, тир context, order 25) подключается только при доступной памяти — резолвер `context/memory-availability.ts` (проект не выключил память, capability `memory`, есть включённый тул плагина). Специализированные промпты debug-эха и
  `SUMMARIZER.{lang}.md` идут мимо Composer (inline). Манифест: system-блоки в реальном порядке +
  запись `tools` (`source: 'tools'`, в конце тира `stable`), слой плагинных тулов
  `plugin.tools` (ADR-090: `volatile`, сразу после `tools`, **вне** кэшируемого stable-префикса —
  состав плагинов меняется в runtime; запись появляется только при непустом составе) и
  `mcp.tools` (MCP, `volatile`), `PromptHistoryInfo` — слой истории
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
  **Миграция прежнего набора ролей** (`migrations.ts`, `LEGACY_AGENT_ROLE_ALIASES`:
  `pm`→`leader`, `developer`→`fixer`, `qa`→`tester`, `analyst`→`researcher`,
  `auditor`→`security-auditor`) — `migrateLegacyStoredAgents(store)` вызывается там же
  **до** `registerStoredAgents`: в сторе оставались полные копии прежних встроенных
  агентов (PM-идентичность/права при подменённом `contextFile`), из-за чего в списке
  жили две роли, а старая работала с чужими правами. Переносятся только пользовательские
  настройки (`enabled`/`provider`/`model`/`temperature`/`topP`/`topK`/`reasoningLevel`/`groups`),
  остальное — из встроенного определения целевого агента; существующая целевая запись не
  перетирается, устаревшая удаляется, вызов идемпотентен. Runtime-алиас —
  `ChatOrchestrator._resolveEffectiveAgentRole` (метка `session.settings.agentRole`
  остаётся исторической). Полнота ролевых файлов (RU+EN на каждый `contextFile`) —
  тест `definitions.test.ts` (падает при переименовании роли без правки агента).
  **Классы агентов:** `admin`/`devops` — `primary`+`subagent` (`maxSteps: 100`), чтобы
  `leader` мог делегировать инфраструктуру (CI/CD, деплой) и серверные задачи
  (systemd, пакеты, сеть, диски) через `task`; `assistant`/`leader` — только `primary`
  (у `assistant` capability `user`/`profile_update`, `leader` — сам не вызывается как
  сабагент, без рекурсии). **`leader` получает все capability, кроме `user`**
  (`profile_update`), включая запись (`file_write`/`git_write`), `shell`, `pipeline` и
  `schedule`: крупные изменения он делегирует исполнителям, сам делает быстрые проверки
  и мелкие правки (промпт `LEADER.{ru,en}.md` согласован с этим набором).
  `title` — `system`. Список сабагентов берётся из определений (`AgentRegistry.getSubagents`),
  отдельного статического перечня нет.
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
  **Периметр цели** `target.ts`/`compile.ts`/`security/trust.ts` — `workingDir` + `allowedRoots`
  (ADR-114): путь в корне проекта — `path` (не `outside`), `ref` — от того корня, где лежит путь;
  тул `patch` учитывается по `edits[].file_path` (общий `extractPathParams` в `permission/groups.ts`).
- `engine/mcp/*` — `McpClient`/`McpManager`, настройки MCP; `executor-mcp-source.ts` +
  `executor-mcp-client.ts` — состав MCP-серверов пула исполнителей и вызовы их инструментов
  поверх HTTP API исполнителя (ADR-077, шаг B2): TTL снимка 120 с, а **неудачный** discovery
  (404/сеть/таймаут) повторяется через `EXECUTOR_MCP_SOURCE_RETRY_MS` (15 с) — иначе backend,
  стартовавший раньше пода исполнителя, «запоминал» пустой состав на весь TTL; успешный
  пустой ответ — валидный снимок и живёт до TTL.
  **Вложения MCP-результата (ADR-115, протокол исполнителя 5):** `McpClient` (stdio/HTTP) и
  `ExecutorMcpClient` раскладывают `content` на текст и нетекстовые блоки
  (`collectMcpContent`: `text`/`resource.text` → текст, `image`/`audio`/`resource.blob` →
  `McpToolResult.attachments` в base64), `McpManager` пишет их через `AttachmentService.upload`
  и отдаёт `ToolResult.attachments` ссылками (дедуп по `blobPath`); транспортные капы — 25 МиБ
  на файл и 20 МиБ на вызов, `isError` → без вложений. Исполнитель ≤ 4 поля не отдаёт —
  результат остаётся текстовым, вызов не падает.
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
  (`builtin.ts`) объявлены **в коде** (ADR-046 §9.5; отдельного asset-каталога нет):
  `skill-creator` (команда `/skill-creator`, capability-aware `file_read`/`file_write`),
  `synth-agents-md` (ADR-069: команда `/agents-md` — не `/init`, та занята встроенной
  командой; `file_read`/`search`/`file_write`), `synth-storage-recovery` (ADR-098 W5: команда
  `/storage-recovery`, read-only runbook), `synth-pipelines` (ADR-101: команда `/pipelines`,
  capability `pipeline`) и `synth-schedules` (ADR-051: команда `/schedules`, capability
  `schedule`) — последние два описывают агенту жизненный цикл пайплайна (спецификация →
  публикация → прогон → журнал, шаблоны инстанца) и расписания (cron/интервал → цель, ручной
  запуск, история срабатываний). Команды встроенных скиллов **уникальны** и не пересекаются с
  встроенными slash-командами (`help`/`skills`/`commands`/`summary`/`init`) — иначе
  `resolveCatalog` (`engine/commands/resolver.ts`) эмитил бы диагностику `shadowed` и скилл
  был бы недостижим. Тесты — `engine/skills/*.test.ts`.
- `engine/commands/*` — slash-команды и bundles (ADR-046): `parser`/`template`/
  `discovery`/`registry`/`bundles`/`builtin`/`resolver`/`service`; резолвинг в core
  до LLM, событие `command.invoked`; per-command права `permission.rules.command`;
  локальные builtin-ответы — `Message.ephemeral` (вне LLM-контекста); inline shell
  (`` !`cmd` ``) — opt-in через `execute_shell`; встроенная `/init` (ADR-069) —
  prompt-команда генерации/обновления `AGENTS.md` (`INIT_INSTRUCTION_PATH`). Тесты — `engine/commands/*.test.ts`.
- `engine/tools/*` — `ToolRegistry` + встроенные тулы (fs, shell, git, search, web,
  plan, todo, project, task, skill, profile_update, вложения `attach_workspace_file`/
  `save_attachment`/`send_attachment`, каталог `list_models`, метаданные SSH-ключей
  `ssh_keys_list`). Атомарная мультифайловая правка — `patch` (`patch.ts`):
  JSON-массив `edits[]`, 1..50 правок за вызов, **всё-или-ничего** — все правки
  проверяются и применяются в памяти до записи, при любой ошибке ни один файл
  не меняется; запись атомарна по файлу (tmp в том же каталоге → rename), при сбое
  посередине — best-effort откат оригиналов; бинарный файл, не-обычный файл,
  превышение размера и абсолютный путь вне периметра — отказ. **`op` в правке**
  (`update` | `add` | `delete` | `rename`): `update` — `file_path`/`old_string`/
  `new_string`/`replace_all` (прежний вызов без `op` — валидный `update`,
  обратная совместимость), `add` — `file_path`/`content`, `delete` — `file_path`,
  `rename` — `from`/`to` (цель в новом каталоге создаётся). Фазы чтения/расчёта/
  записи и отката идут **под per-path локами** (`file-lock.ts`) — две параллельные
  правки одного файла не теряют друг друга. Пути правки собирает `extractPaths`
  permission-слоя (`file_path`, а у `rename` — `from` **и** `to`: file-паттерны,
  `external_directory`, `protected_paths`); в `fs.changed` переименование отдаёт
  оба пути. Итог — `fs.patch_summary` (`added`/`updated`/`deleted`/`renamed`) и
  строки по файлу (`fs.patch_file_line`/`_added`/`_deleted`/`_renamed`).
  **Запись файлов — общие модули `engine/tools/`:** `line-endings.ts`
  (`detectLineEndings`/`toLfView`/`fromLfView` — стиль файла `lf`/`crlf`/`mixed`;
  сопоставление правки идёт в LF-виде, `\r\n` сохраняются, mixed → отказ
  `fs.mixed_line_endings` без изменения файла), `atomic-file-write.ts`
  (`writeFileAtomic` — tmp в том же каталоге → `rename`: права существующего файла
  сохраняются, симлинк разыменовывается (пишем в цель, а не заменяем ссылку), tmp
  убирается при сбое; при `EACCES`/`EPERM`/`EROFS` на создании tmp — фолбэк на
  прямую запись цели, атомарность в этом краевом случае не гарантируется),
  `file-limits.ts` (`MAX_TOOL_FILE_BYTES` — 5 МиБ; общий предел для
  `write_file`/`edit_file`/`patch`, у `patch` — свой ключ `fs.patch_too_large`).
  Гейты `write_file`/`edit_file`: бинарный файл (`fs.write_binary`/`fs.edit_binary`),
  превышение размера (`fs.file_too_large`), отсутствующий файл у `edit_file`
  (`fs.file_not_found` — graceful-отказ вместо ENOENT); `edit_file` отказывает **до
  чтения** на `old_string === new_string` (`fs.no_changes`, сравнение по LF-виду) и
  пустом `old_string` (`fs.empty_old_string` — при `replace_all` он вставлял текст
  между каждым символом и портил файл). `patch` — те же CRLF-гейты
  (`fs.mixed_line_endings`) и `fs.no_changes`, запись атомарная через общий
  `writeFileAtomic` (откат оригиналов при сбое посередине). Реестр держит **три слоя** по
  `ToolDefinition.source` (`builtin` | `mcp` | `plugin`, ADR-071 §2.1 + ADR-090):
  `registerPlugin(tool, pluginName)` — единственный путь регистрации плагинного тула, **атомарная**
  валидация с отказом `invalid_name`/`invalid_definition`/`invalid_capability`/`name_conflict`;
  имя всегда `plugin_<ns>_<tool>` (namespace — из `manifest.name`, хелперы в
  `shared/types/plugin-tools.ts`: `pluginToolFullName`/`pluginToolLocalName`), capability `mcp`
  (слой MCP) и `runtime` (примитивы ядра неотключаемы админом) зарезервированы, пустой набор
  capabilities — отказ. Выборка по слоям — `selectForSession` → `{ builtin, plugin, mcp }`
  (склейка промпта — `builtin → plugin → mcp`; слой `plugin` отражается в манифесте промпта
  отдельной записью `plugin.tools` — ADR-090, volatile, вне stable-префикса),
  `listPlugin(pluginName?)`/`pluginLocalNames()`;
  `deregister`/`deregisterByCapability` работают с плагинными как с обычными.
  git-тулы принимают необязательный `repo_path`
  (containment внутри `project.workspace`), SSH-окружение — `engine/tools/git-ssh.ts`
  (ADR-076; ошибки — `sshkey.env_failed`). **Таймауты git-тулов — по классу операции:**
  read-only (`status`/`diff`/`log`/`show`/`blame`/`branch_list`) — 30 с
  (`GIT_READ_TIMEOUT_MS`), локальные изменяющие (`commit`/`checkout`/`stash`) —
  `git.localTimeoutMs` (дефолт 120 с), сетевые (`push`/`pull`) —
  `git.networkTimeoutMs` (дефолт 300 с); у всех git-тулов параметр `timeout`
  (0..600000, `0` — без лимита) перекрывает класс операции; истечение — отказ
  `git.timeout` с `metadata.reason='timeout'` (а не «Command failed»). Пределы из
  конфига инстанца приезжают в `ctx.extra` (`gitLocalTimeoutMs`/`gitNetworkTimeoutMs`),
  env — `SYNTH_GIT_LOCAL_TIMEOUT_MS`/`SYNTH_GIT_NETWORK_TIMEOUT_MS`
  (подробности — `docs/CONFIGURATION.md` §`git`).
  **Файловые и поисковые тулы — паритет с
  opencode** (`fs-read.ts`, `search.ts`): `read_file` читает **потоком**
  (`createReadStream`+`readline`, память постоянна) страницу `offset`/`limit`
  (`offset` 0-based, дефолт и максимум — **2000** строк, жёсткий cap **50 КБ**
  вывода, строка ≤ 2000 символов с маркером), нумерация в выводе — исходная
  1-based (`N: …`, префикс только для чтения); бинарь определяется по первым
  8 КБ (NUL/доля непечатных) и возвращается ошибкой с подсказкой
  (`attach_workspace_file` для картинок/PDF, `execute_shell`+`file`/`xxd` для
  остального), путь-каталог отдаёт **листинг** (каталоги → файлы, размеры, те же
  лимиты, `metadata.type='directory'`); `metadata` —
  `{path,type,totalLines|totalEntries,offset,limit,truncated,bytes}`. `glob` — на
  `rg --files` (`cwd` = каталог поиска, `hidden`, `limit` 100/макс 1000,
  сортировка по имени, `.git` и скрытые без `hidden` отсекает общий фильтр
  `isIgnoredSearchPath` в `path-utils.ts`); `grep_files` — `literal`,
  `caseSensitive` (default true), `hidden`, `limit` 100/макс 1000 (лимит общий по
  строкам совпадений); оба тула — предел 30 с (`SEARCH_TIMEOUT_MS`), истечение —
  `tool.search_timeout` с советом сузить путь/шаблон. Оба тула объявлены зависимыми от `rg`
  (`TOOL_RUNTIME_DEP`). `execute_shell` принимает `cwd` (относительно рабочего
  каталога), оболочка — bash, большой вывод усекается маркером; предел по умолчанию —
  120 с, параметр `timeout` (0..600000, `0` — без лимита) его перекрывает; истечение —
  `tool.shell_timeout` с подсказкой (тот же контракт у detach-пути,
  `shell-detachable.ts`); фоновый запуск — по умолчанию без лимита. Тул `task` (ADR-095 шаг 5) разбит на
  `engine/tools/task/*`: `tool.ts` (`taskTool`), `fork.ts` (fork/контекст-режимы ADR-026 +
  permissions), `child-session.ts` (создание/сообщения/события), `run-cycle.ts` (общий
  tool-loop `runSubagent`, используемый и `task-resume.ts`), `prompt.ts`, `args.ts`, `types.ts`;
  `task.ts` — фасад-реэкспорт. Тулы `task`/`task-resume` собирают промпт
  саб-агента (`resolveSubagentPrompt`) **только из файлов** — `prompts/subagents/<type>.{ru,en}.md`
  → `<type>.md` → `prompts/roles/<TYPE>.{ru,en}.md` → `<TYPE>.md`; поля промпта в определении
  агента (`AgentDefinition`) нет, фоллбека из JSON не существует (нет файла — пустой промпт;
  у встроенных `general`/`explore` файлы `prompts/subagents/*` обязательны — тест
  `engine/agents/definitions.test.ts`). Проектные инструкции (ADR-069) добавляются,
  кроме `task(skip_context_files=true)`. **Семантика как в opencode:** новый дочерний прогон
  получает системный блок `[SUBAGENT]` (`prompts/system/SUBAGENT.{ru,en}.md`, загрузчик —
  `ContextConfig.getSubagentNotice`) в начало system prompt; в user-сообщении и истории
  блока нет, продолжение `task_id`/resume его не получает; дефолт
  `context_mode: none` — свежий контекст; во всех режимах ребёнок получает
  `contextOptimization: 'none'` и `summarizationEnabled: false` (авто-суммаризация родителя не
  наследуется); `summary` — разовое сжатие истории родителя в системный промпт
  (`[PARENT SUMMARY]`, `PreparedChildSession.parentSummaryText`), без SUMMARY-сообщения
  в истории ребёнка (ADR-026, обновление 2026-10-29).
  **Выбор модели саб-агента (`tool.ts`, `resolveSubagentProvider`).** Приоритет:
  явные `params.provider`/`params.model` → пара агента
  (`AgentDefinition.provider`/`model`; недостающая половина — из родителя, пара,
  равная родительской, — базовый провайдер без пула) →
  `router.subagent.{provider,model}` → `routing_strategy:'none'` (пара родителя) →
  `modelRouter.route()` (ADR-034). Пункты 1–3 роутер не зовут: пара резолвится
  через `ModelRouter.getProvider` (с температурой и sampling `agent.topP`/`topK`;
  `0`/`undefined` — «не задано»).
  Составной `model` без `provider` (`provider/model`, в т.ч. с `/` внутри имени —
  `routerai/google/gemini-…`) разбирается: первый сегмент — провайдер, остаток —
  модель. Если оркестратор передал `extra.listModels` (тот же загрузчик, что у
  `list_models`), явная пара валидируется по каталогу (существует и не
  `enabled:false`); иначе — отказ `task.model_not_in_catalog` с доступными парами
  (до 10, `provider/model`) и отсылкой к `list_models`. Без каталога — прежняя
  проверка через пул провайдеров роутера (`task.model_unavailable`, без тихого
  отката на родителя).
  **Температура саб-агента.** `agentDef.temperature ?? extra.parentSessionSettings?.temperature`
  (иначе дефолт модели) уходит **двумя** путями: провайдеру прогона
  (`resolveSubagentProvider` — клон родительского через `withTemperature`,
  `ModelRouter.getProvider(decision, temperature)` для явной/роутнутой пары,
  `temperature` в `cacheKey` пула) и в настройки дочерней сессии
  (`prepareChildSession({temperature})` — все режимы контекста). Продолжение в
  текущем ходе (`task({task_id})`, `continueChildSession`) применяет ту же
  величину (`agentDef.temperature ?? child.settings.temperature`) к провайдеру
  прогона (клон родительского). `task-resume` считает ту же величину
  (`agentDef.temperature ?? child.settings.temperature`) и
  отдаёт `deps.getProvider` **клон сессии** с переопределённой температурой —
  stored-сессия не мутируется. Температура прогона передаётся в
  `SubagentRunConfig.temperature`: QA-эскалация (`run-cycle.ts`) поднимает
  другую модель из пула и запрашивает её `getProvider(decision, temperature)` —
  fallback-вызов идёт с температурой агента, а не с дефолтом модели.
  **Steering дочерней сессии (ADR-104 + ADR-111).** Цикл саб-агента применяет инъекции
  **на границе шага** (`run-cycle.ts`): перед каждым LLM-вызовом вычитывается `steerInbox`
  **сессии-ребёнка** (`sessionManager.takeSteerMessages`), сообщение персистится в истории
  ребёнка как `user`-реплика с `metadata.steer`, попадает в LLM-контекст текущего хода
  (`messageToLLMMessage`) и публикуется в канал ребёнка (`message.added` + `message.injected`);
  превышение лимита — `steer.dropped` в канале ребёнка (ход не падает). `interrupt` для
  ребёнка прогон **не** прерывает (на границе шага генерации нет) — применяется как обычная
  инъекция. Общая точка применения инъекций для основной сессии и ребёнка —
  `engine/steering/apply.ts` (`applySteerInjections`); оркестратор использует её же
  (`ChatOrchestrator._applySteerInjections`). Очереди родителя и ребёнка изолированы.
  **Tool-события ребёнка — в оба канала (2026-11-02).** `run-cycle` публикует
  `tool_call.started`/`tool_call.result` в родительский канал (как раньше, с `parent_call_id`) и в
  канал **ребёнка** (`publishToolEvent`: без `parent_call_id`, `session_id` = id ребёнка) — вкладка
  саб-агента подписана на свой канал и без этого не видит live-карточки инструментов. Assistant-сообщения
  шага ребёнка сохраняются с `turnId` (id дочерней сессии), `stepIndex` и терминальным `status` —
  иначе после reload вкладка не восстанавливает живой шаг.
  Остаток очереди ребёнка в конце прогона снимается до финализации —
  `dropSteerInjections(reason:'turn_ended')` с публикацией `steer.dropped` в канал
  ребёнка (общая точка для обычного завершения, шаг-лимита и бюджета контекста).
  **Live-прогресс саб-агента — дельты (`subagent.progress`, `f39b7878`).** Троттлинг ~300 мс
  публикует **только приращение** `content_delta`/`reasoning_delta` с прошлой публикации
  (поля `content`/`reasoning` с накопленным текстом убраны, пустые дельты не публикуются);
  префикс не совпал (рестарт стрима/новый текст) — публикуется весь текст. Суммарный объём
  дельт на прогон ограничен `SUBAGENT_PROGRESS_MAX_CHARS = 200 000` символов — дальше прогресс
  не публикуется (debug-лог), итоговый отчёт и расход шага (`step.finished.usage`) не страдают. Причина: полный текст
  каждые 300 мс при нескольких параллельных саб-агентах давал мегабайты кадров и задерживал ack
  отправки сообщений в том же WS-канале (в UI — ложный «Send timeout»).
  **Финал ребёнка на шаге-лимите.** Финальное assistant-сообщение **дочерней** сессии несёт
  `step_limit_reached: true` и числовой `step_limit` в `metadata` (та же метка — в `metadata`
  `task`-результата родителя), а при пустом отчёте — текст `task.steps_limit_empty`; иначе в
  истории ребёнка факт остановки по лимиту не виден (проверено живьём).
  Тулы управления проектом:
  `project_update`/`project_workspace_set` (`project-manage.ts`) и
  `project_repo_clone|init|add|fetch|remove` (`project-repos.ts`) — проект берётся
  из сессии, смена workspace/регистрация репозиториев и правки плана/лога/инвариантов
  сохраняются **атомарным** `ProjectRepository.mutate` (порт `storage/ports/project-repository.ts`:
  load → синхронный мутатор → запись под локом хранилища; файловая реализация — `AsyncLock`,
  PostgreSQL — транзакция с `FOR UPDATE OF p`). `load` + правка в памяти + `save` **не**
  использовать: лок у `save` только на запись, параллельная правка другой сессии теряется
  (lost update). Мутатор бросил → записи нет, ошибка пробрасывается. Публикация
  `project.updated` — после успешного сохранения; `project_update` валидирует `icon`/`color` по
  `PROJECT_ICON_KEYS`/`PROJECT_COLOR_KEYS` (невалидно → ошибка с перечнем ключей).
  `project_workspace_set` отклоняет пустую строку, корень и дегенеративные пути (`"."`, `".."`,
  `"/"`) — очистка workspace тулом не поддерживается; в managed подтверждение вне корня не
  применяется (только отказ).
  **SSH-ключи (`ssh-keys.ts`, ADR-076).** `ssh_keys_list` — метаданные ключей
  инстанса из `ctx.extra.sshKeyStore` (`list()`/`listForAgent()`; `reveal()` не
  вызывается, секретов в ответе и метаданных нет), capability `git_read` (группа
  `git_read`, plan разрешён), **к workspace не привязан** (исключение
  `WORKSPACE_FREE_TOOLS` в `permission/availability.ts` — второй аргумент
  `isWorkspaceDependentTool`). Отказ `project_repo_clone`/`_fetch` для SSH-URL без
  ключа перечисляет доступные ключи (`buildSshKeyRequiredResult`,
  `git.ssh_key_required_hint`, `id → name`, до 10) и отсылает к `ssh_keys_list`;
  стор недоступен — прежний `git.ssh_key_required` без списка.
  Метаданные `icon`/`color` проекта и сессии — канонические ключи shared:
  валидация на записи (роуты `projects`/`sessions` → 400 `VALIDATION_ERROR`),
  сброс невалидных значений при чтении (`ProjectStore.load`, `FileStore.deserializeSession`,
  `remote/transfer`); у сессий — сквозной проход (`Session`, `SessionManager.createSession`
  и fork, `serializeSession`). Запись проектных данных (`project_log_write`/
  `project_invariants_write`/`plan_write`) гейтится `engine/tools/project-access.ts`
  (`canEditProject`, ADR-075/D5). `engine/workspace-provision.ts` — общий
  provisioning workspace (нормализация/containment/создание каталога) для
  HTTP-роутов и тулов (ADR-075). `engine/tools/runtime-deps.ts` — детект внешних
  бинарников (`git`/`rg`/`sh`/`bash`; источник — **порт** (`probe()`), в inline — локальная
  проба; fail-open; кэш детекции — **по экземпляру порта**, `WeakMap`, TTL 60 с;
  снимок перечитывается ходом — `refreshRuntimeDeps`) и карта
  `TOOL_RUNTIME_DEP`; из неё же берутся бинарные требования тулов
  (`runtimeRequires()`/`toolRuntimeRequires()` → `ExecRequest.requires`); деталь
  недоступности — в `RuntimeDeps.details` («в пуле: N из M» в remote-режиме) и далее
  в `ToolAvailability.detail` → `UnavailableTool.detail` → текст модели. Отсутствие
  программы даёт `unavailable(dependency)` (ADR-078), тулы из реестра не удаляются.
  **Оболочка шелл-вызовов — `bash`** (`execute_shell`, detach-путь, фоновые процессы,
  inline-shell передают `shell: 'bash'` явно): `/bin/sh` в образах это dash/busybox ash,
  bash-синтаксис (`[[ ]]`, массивы, `pipefail`, `${var,,}`) там не работает; нет `bash` —
  тул недоступен, подмены на `sh` нет. Поэтому `TOOL_RUNTIME_DEP.execute_shell = 'bash'`.
  `profile_update` (`profile-update.ts`) — онбординг владельца сессии: сохраняет
  `display_name`/`email`/`phone`/`notes` и завершает интервью (`ProfileData.interviewCompleted`);
  capability `user` (отключаемая группа `user` в `permission/groups.ts`; выдана только агенту
  `assistant`), поэтому тул доступен не всем агентам и блок `[INTERVIEW]` инжектится только
  при доступном агенту `profile_update` (гейт `_interviewEligible` — `_availabilityPredicate` +
  `_isAdminDisabled`, fail-closed без тула); стор приходит через `ToolContext.extra.profilesStore`,
  нет владельца — понятная ошибка.
  **Тулы вложений (ADR-115).** `attach_workspace_file` (`attach-workspace-file.ts`,
  capability `file_read`) — файл из workspace (`stat` до чтения, containment: абсолютный путь/`..`/
  симлинк наружу → отказ) загружается через `AttachmentService.upload` и возвращается в
  `ToolResult.attachments`: оркестратор (`_injectToolAttachments`) вставляет медиа-часть в
  `currentMessages` **следующей итерации текущего хода**. Нового user-сообщения в очереди нет —
  иначе модель не видит результат в текущем ходе и зацикливается на повторных вызовах.
  `blob_refs` пишет инъекция оркестратора. `save_attachment` (`save-attachment.ts`, `file_write`) —
  обратное: медиа-часть **текущей** сессии выгружается в workspace без перезаписи
  (`link`/`COPYFILE_EXCL`, занято → `attach.tool.exists`); селекторы комбинируются — сообщение
  (`message_id`/`message_seq`), затем `sha256`/`name`/последняя; неоднозначное имя →
  `attach.tool.ambiguous`, нет вложений в указанном сообщении → `attach.tool.not_found`. `send_attachment` (`send-attachment.ts`, `file_read`) — файл
  уходит **получателю ответа**: часть кладётся в коллектор хода (`ctx.extra.outboundAttachments`),
  финализация добавляет её в `parts` финального assistant-сообщения и в `step.finished.attachments`
  (шлюзы раздают только их, ADR-118); ошибка/отмена хода ничего не отправляет. Три тула работают только
  с объектами `attachments/` и общими лимитами `attachments.*` — второй политики нет.
  `list_models` (`list-models.ts`) — capability `models` (группа `read`, разрешён в plan-режиме):
  каталог инстанса через `extra.listModels` (`modelStore.list()`) — `provider/model` +
  модальности, текущая пара и `defaultFor` (семейства из `attachments.modalityModels`); без
  аргументов ответ компактный, фильтры `modality`/`provider`, `limit` 1..50.
  `web_fetch({include_media})` (`web.ts`): медиа-ответ читается **стримом с капом**
  (`attachments.maxBytesPerFile`, до чтения — `content-length`), кладётся в blob через
  `AttachmentService` и возвращается в `ToolResult.attachments` (без `include_media` бинарь не
  читается вовсе — модель получает подсказку); SSRF-политика и TLS не меняются
  (`fetchWithEgressGuard`/`egressFetch`, ADR-099).
  **Тулы пайплайнов (ADR-101, B1).** `pipeline_list`/`pipeline_get`/`pipeline_save`/
  `pipeline_publish`/`pipeline_delete` (`engine/tools/pipeline-authoring.ts`) — чтение и
  авторство спецификации пайплайна **проекта сессии**; проект берётся только из сессии
  (аргумент `project_id` не принимается), мутации — по правам проекта (`canEditProject`,
  `VIEWER` только читает), пайплайн чужого проекта выглядит как отсутствующий
  (`pipeline.tool.not_found`). Версионирование (bump черновика, идемпотентность публикации) —
  общими авторскими операциями `engine/pipelines/authoring.ts` (те же, что у HTTP-роута).
  Рантайм (порты/движок) приходит через `ctx.extra.automation`
  (`engine/tools/automation-runtime.ts`); общие проверки (рантайм/проект/право) — в
  `engine/tools/automation-helpers.ts` (`getAutomation`/`loadAutomationScope`/`ensureCanEdit`).
  **Тулы прогонов (ADR-101, B2).** `pipeline_run`/`pipeline_run_status`/`pipeline_run_list`/
  `pipeline_run_resume`/`pipeline_run_cancel` (`engine/tools/pipeline-runs.ts`) — запуск
  опубликованной версии, заголовок + журнал прогона, список прогонов проекта, HITL-решение
  и отмена. Проект — только из сессии, прогон чужого проекта выглядит как чужой
  (`pipeline.tool.run_foreign`); запуск/резолюция/отмена — по правам проекта, чтение доступно
  `VIEWER`; запуск и отмена идут через **общий** реестр активных прогонов
  (`engine/pipelines/run-control.ts`) — soft-lock «второй прогон того же пайплайна» и отмена
  идущего прогона одинаковы для HTTP и для агента.
  **Тулы шаблонов (ADR-101, B2).** `pipeline_templates`/`pipeline_instantiate`
  (`engine/tools/pipeline-templates.ts`) — список шаблонов инстанса (оба формата: `adr-101` и
  legacy `adr-100`; проект не требуется — это ресурс инстанса) и инстанцирование шаблона в
  **черновик** пайплайна проекта сессии (`ensure` — идемпотентно, `installedBy.templateId` —
  провенанс). Гейт инстанцирования — право изменения **своего** проекта (`canEditProject`),
  а не роль `ADMIN` инстанца: шаблоны инстанса только читаются, а создаётся пайплайн проекта
  (HTTP-контур для managed закрыт `ADMIN` — это другой контур). Логика шаблонов — в движке
  (`engine/pipelines/authoring.ts`: `listPipelineTemplates`/`instantiatePipelineFromTemplate`) —
  оттуда же её берёт HTTP-роут, поэтому два контура не разойдутся.
  **Тулы расписаний (ADR-051).** `schedule_list`/`schedule_get`/`schedule_save`/`schedule_delete`/
  `schedule_run`/`schedule_jobs` (`engine/tools/schedules.ts`) — список/деталь расписания,
  создание и частичный патч, удаление, принудительный запуск и журнал срабатываний. Область
  доступа — **«свои + проект»**: расписание видно, если оно своё (`ownerId === userId` сессии)
  или его цель относится к проекту сессии (`pipeline`/`ephemeral`/`bound`/`queue`); проект у
  сессии не обязателен (свои расписания доступны и без проекта), чужие выглядят как
  отсутствующие (`schedule.tool.not_found`), мутации — по владению или по праву изменения
  содержимого проекта (`VIEWER` только читает). Цель не подсунуть: `pipeline` — только
  опубликованный пайплайн проекта сессии, `bound`/`queue` — своя сессия или сессия своего
  проекта. Scope/правила области — в `engine/tools/automation-helpers.ts`
  (`loadScheduleScope`/`isScheduleInScope`/`ensureScheduleMutable`).
  **Тулы реестра фоновых прогонов (ADR-111/PROP-097).** `process_list`/`process_logs`
  (`engine/tools/processes.ts`) — чтение **единого** реестра фоновой работы (фоновые
  саб-агенты и фоновые шелл-процессы) и лога фонового процесса; `process_stop` —
  остановка running-прогона (процесс — `SIGTERM`→`SIGKILL`, фоновый саб-агент — abort
  дочернего прогона), `process_delete` — удаление только терминальной записи
  (`BackgroundRunService.remove`). Скоуп — **«своя сессия +
  дочерние»**: видны прогоны текущей сессии и прогоны её дочерних сессий (`task`); чужой
  прогон выглядит как отсутствующий (`process.tool.not_found` — тот же текст, что и для
  несуществующего, существование чужого ресурса не раскрывается). Чтение + управление:
  `process_list`/`process_logs` разрешены в plan-режиме, `process_stop`/`process_delete`
  там заблокированы (`PLAN_BLOCKED_AUTOMATION_TOOLS`), группа `process`
  отключаема админом. Зависимости — из `ctx.extra`: `backgroundService` (реестр),
  `processService` (лог), `sessionManager` (дети сессии); нет сервиса — понятный отказ
  `process.tool.deps_unavailable`. **Лог есть только у `kind: 'process'`** — он читается из
  `BlobStore` по пути записи реестра (`processes/<runId>.log`) через `ProcessService.logs`
  (`offset`/`limit` в байтах, `truncated` — признак усечения лога при записи); у фонового
  саб-агента лога нет — тул отдаёт **summary** прогона и id дочерней сессии (её история —
  в `read_session_reference`). Capability `process` выдана агентам, которые ведут работу в
  проекте (`assistant`/`leader`/`devops`/`admin`/`fixer`/`tester`); у `researcher`/
  `security-auditor`/`explore`/`general`/`title` её нет (тест — `engine/agents/capabilities.test.ts`).
  **Контекст плагинного тула сужается.** Для `source: 'plugin'` `executeToolDef` отдаёт только
  `sessionId`/`messageId`/`workingDir`/`agentRole?`/`projectId?`/`abortSignal?` (`narrowToolContext`): `extra` и `dataDir`
  плагину **не передаются** — симметрично `out-of-process` (по проводу те же три поля). Встроенные и
  MCP-тулы получают контекст без изменений; правило действует и в шагах пайплайна, и в саб-агенте `task`
  (обе точки идут через `executeToolDef`).
  **Схемы на границе LLM (`json-schema.ts`, `schema-sanitize.ts`).** `zodToJsonSchema` сворачивает
  вырожденный union «одно-или-много» (`T | T[]`, T — один конкретный тип) в `{type:'array', items:T}`
  — модель видит одну форму вместо `anyOf` (массив — надмножество, одиночное значение по-прежнему
  принимает zod); `sanitizeToolSchema` применяется в `ToolRegistry._toolToLLM` ко **всем** тулам
  (встроенные, MCP, плагины): убирает вложенный `$schema`, повторяет сворачивание на чужих схемах, а
  `nullable` (`anyOf:[X,null]`), union скаляров (`pipeline_save.when.value` — `eq`/`ne` сравнивают
  строго) и вложенные `anyOf` не переписывает. `ToolDefinition.normalizeArgs` (аддитивное поле
  контракта) вызывается в `executeToolDef` **до** `safeParse` — терпимость к обёрткам слабых моделей
  (`todo_add`/`todo_delete`: `{item:…}`/`{items:…}`/`{ids:…}`), на схему не влияет. Текст
  `invalid_union` в `arg-error.ts` печатается по вариантам (`variant 1: …; variant 2: …`, до 3 issues
  и 300 символов на ветвь) вместо голого `Invalid input` — иначе модель не понимает, что не так, и
  повторяет тот же вызов.
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
  `shared/src/types/plugin-audit.ts`, всего **31**): `plugin.not_found` (resolve),
  `plugin.source_unavailable` (Д1 — источник бандла недоступен или не прошёл проверку целостности:
  локальный путь/архив не распакован, npm без SRI / с несовпадением SRI-sha512 или shasum, URL без pin
  или с несовпадением sha256; отказ **до** гейтов установщика), `plugin.manifest_invalid` (resolve),
  `plugin.integrity_mismatch`/`plugin.integrity_unverifiable` (integrity),
  `plugin.contract_mismatch`/`plugin.host_mismatch` (semver), `plugin.trust_below_floor`/
  `plugin.scan_rejected`/`plugin.approval_required` (trust/scan), `plugin.approval_expired`/
  `plugin.approval_stale` (ADR-090 п. 9 — недействительное подтверждение установки: истёк срок
  24 ч либо бандл в карантине изменён после выдачи), `plugin.disabled`/
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
  `<home>/plugin/{installed,quarantine,plugins.lock.json,plugins.json,plugin-approvals.json}`;
  `pluginInstalledDir`/
  `pluginQuarantineDir` (`<name>@<version>`); `stagePluginBundle` (решение install-policy: `allow` →
  в `installed/` + `PLUGIN_INTEGRITY.json`; `ask`/`block` → остаётся в `quarantine/`, в `installed/`
  **не попадает**); `releaseFromQuarantine` (перенос из карантина после подтверждения владельца).
  `PLUGIN_INTEGRITY.json` (Ф5а) хранит не только `sha256`/`source`/`fetched_at`, но и `trust_level?`/
  `install_kind?`/`identifier?`/`ref?` — иначе подтверждение из карантина не знало бы фактическое
  доверие (его резолвит источник, не манифест).
- `engine/plugins/approval.ts` — ADR-090 п. 9: **подтверждение установки** (`caution`): привязка к
  **content-hash** бандла, срок **24 ч** (`PLUGIN_APPROVAL_TTL_MS`/`PLUGIN_APPROVAL_TTL_HOURS`),
  кто выдал и когда. Состояние — `FilePluginApprovalStore` (файл `plugin-approvals.json` в **корне
  раскладки**, атомарная запись tmp→rename; путь — `PluginLayout.approvalsPath`, т.е. запись идёт
  через раскладку слоя плагинов, а не мимо неё), `MemoryPluginApprovalStore` — для тестов.
  Подтверждение лежит **вне** каталога бандла: замена бандла в карантине не стирает его, и
  расхождение хешей видно (`plugin.approval_stale`). Выдаётся на пути `install-policy: ask`,
  проверяется в `approve` **первым** (истёк срок → `plugin.approval_expired`; хеш не совпал →
  `plugin.approval_stale`); отдельного API отзыва нет.
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
  (`plugin.not_found`/`plugin.not_active`); `listAudit(opts)` — **чтение журнала аудита** через порт
  `pluginAudit` (записи «свежие первыми», фильтры `plugin`/`action`/`outcome`, `limit`; чтение не
  создаёт записей) — его отдаёт `GET /api/v2/plugins/audit`; `dispose()` — деактивация в обратном
  порядке.
  `OrchestratorOptions.promptBlocks` прокидывается в `SystemPromptComposer` — **один** реестр на инстанс
  (до Ф5б-1 композер создавал собственный, и блоки плагинов в промпт не попадали).
- `engine/plugins/installer.ts` — **Ф5а: `PluginInstaller`**, сервис установки/подтверждения/снятия
  (API/CLI — Ф5б/Ф5в). `installFromDirectory({dir, trustLevel, source, identifier?, ref?, installKind?,
  activate?, actor?})`: порядок **манифест (`validatePackManifest`, `kind: 'plugin'`) → состав бандла и
  content-hash → fail-closed (`scan=disabled` + `executionEnabled`) → trust-floor → скан →
  `runtimeInstall=deny` → install-policy**; `allow` → `installed/<name>@<version>/` + `lock.save` +
  аудит `install`; `ask` → `quarantine/…` (lock **не** пишется, аудит `install/rejected`
  `plugin.approval_required`); `block`/`dangerous` → `plugin.scan_rejected`. `approve(name, {version?,
  activate?})` ищет lock, затем карантин; **первым** проверяет подтверждение установки (ADR-090 п. 9:
  срок 24 ч → `plugin.approval_expired`, несовпадение content-hash → `plugin.approval_stale`), затем
  сверяет `PLUGIN_INTEGRITY.json` с фактическим хешем
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
- `cli/memory-commands.ts` — **CLI `synth memory`** (ADR-107): тонкий клиент HTTP API v2 портала
  памяти (`status`/`list`/`index`/`rebuild`/`drop`; логики памяти в CLI нет — только вызовы
  `/api/v2/memory/*` **работающего** инстанса, поэтому нужны запущенный инстанс и токен).
  Подключение: `--url` → `remote.backendUrl` → `http://127.0.0.1:<port>`; ключ — `--token` →
  `SYNTH_API_KEY` → `core.apiKey` → файл `{dataDir}/secrets/api-key` (файл читается, не создаётся;
  значение ключа нигде не печатается — инвариант 13). Флаги: `--scope project|instance`
  (область индекса; у `instance` + `--source files` `projectId` — **источник корпуса**, для `facts`
  не нужен; значение проверяется локально → `VALIDATION_ERROR`, код выхода 1), `--wait`
  (опрос состояния до `ready`/`failed`), `--timeout`, `--json`, `--yes` (для `drop`).
  Коды выхода: `0` — успех, `1` — отказ (HTTP-ошибка, сеть, нет токена, `drop` без `--yes`,
  таймаут ожидания).
- `server/routes/plugins.ts` — **Ф5б-2: HTTP-контур плагинов**. `createPluginsRoutes(auth, deps, opts)`:
  `GET /`, `GET /audit` (**журнал действий плагинов**: `{entries}` — хвост, `limit` (дефолт 50,
  максимум 500) и фильтр `plugin`; маршрут объявлен **до** `/:name`; guard — `readGuard`, чтение
  не создаёт записей), `GET /:name` (манифест + `PLUGIN_INTEGRITY.json` — best-effort, порча не даёт 500),
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
  **Сервисы фасада (ADR-107).** Помимо трёх регистраций фасад отдаёт доступ к ресурсам инстанса:
  `memory` (порты памяти через scoped-обёртку `scoped-memory.ts`; namespace `plugin:<имя>` навязывает
  хост, чужие записи выглядят как «не найдено»), `embed` (инъекция `PluginEmbedFn` из `deps.ts` →
  `GatewayProvider.embed`; лимиты 64 текста / 8 000 символов / 64 000 суммарно; код
  `plugin.embedding_not_configured`; конфиг `plugins.embeddingProvider`/`embeddingModel`) и
  `getSettings` (чтение `plugins[<имя>].settings` из `plugins.json`; ридер по умолчанию — `runtime.ts`
  по `layout.settingsPath`), `embedding` (фактическая модель хоста `provider/model` из
  `plugins.embeddingProvider`/`embeddingModel` — нужна плагину для фингерпринта индекса: смена
  модели при той же размерности помечает индекс `stale`) и `security` (предикаты «файл/каталог
  секрета» — `engine/security/secret-files.ts`; список имён живёт в ядре, потому что сканер
  расширений считает упоминание таких имён эксфильтрацией и блокирует бандл). Сервисы доступны
  **только `inline`**: wire-протокол v1 покрывает три точки.
  Новый доступ к ресурсам инстанса оформляется как **сервис фасада + ADR**, а не как ещё один метод
  «по месту».
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
  движка**: LLM — только через `GatewayProvider`; температура шага —
  `step.agent.temperature ?? provider.temperature` (клон через `withTemperature`);
  `ask` → гейт `tool_approval` →
  `resume` применяет одобрение к тому же вызову), `common.ts` (общая «проверка права +
  вызов тула»). **Вложения прогона (ADR-115 × ADR-101, `engine/pipelines/attachments.ts`)**:
  прогон носит только ссылки (байты — в blob, ADR-116), вход — `trigger.payload.attachments`,
  проверяется до старта теми же правилами, что приём события (`validatePipelineAttachments`:
  контур `attachments/`, объект существует, метаданные совпадают со sidecar, лимиты
  `maxFilesPerMessage`/`maxBytesPerFile`/`maxBytesPerSession`; без сервиса/порта — fail-closed);
  `collectStepAttachmentRefs` собирает ссылки шага из входа, значений маппинга (`ctx.input`, корни
  путей — `prev.output.*`/`prev.artifacts`/`trigger.payload.*`/`vars.*`) и артефактов
  предыдущего шага с `kind: 'blob'`, а `hydrateStepAttachments` гидрирует их **тем же**
  путём, что сессии (`hydrateMessageAttachments`: `stripMetadata`, лимит base64, фильтр
  модальностей, `derive`). Материализации отброшенного в workspace у шага **нет** — модель
  видит только причину; ссылки прогона регистрируются в `blob_refs`
  (`ownerKind: 'pipeline-run'`). Точки расширения: `StepExecutor` (по виду узла), `PipelineExitHandler`,
  зависимости `PipelineEngineDeps` (`projectStore`/`toolRegistry`/`mcpManager`/
  `instructionsResolver`/`agentRegistry`/`skillsCatalog`/`exits`/`metrics`) — глобальных
  синглтонов нет, сборка — в `server/app/deps.ts` (standalone) и `backend/app/deps.ts`
  (managed).
- `engine/pipelines/builtin.ts` — встроенные шаблоны памяти: `builtin:memory-consolidation` (сессия → факты, `agent`), `builtin:memory-consolidate-facts` (`memory_consolidate`), `builtin:memory-reindex` (`memory_index action=rebuild_all`, `wait:true`). Сид при старте идемпотентен; `POST /pipeline-templates/:tid/instantiate` с `ensure:true` возвращает существующий пайплайн проекта по `installedBy.templateId` (200) или создаёт (201).
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
  `EventIngress` (ingest/нормализация) — **вложения события** (ADR-115 × ADR-089):
  `attachments?: EventAttachmentRef[]` проверяются **до** роутинга/дедупа
  (`_validateAttachments`: явный `dedupKey` обязателен — ключ по умолчанию строится из
  `payload` и для бинарного содержимого нестабилен; количество ≤ `attachments.maxFilesPerMessage`
  (без сервиса — жёсткий 10), путь строго под `attachments/`, объект существует и метаданные
  (`sha256`/`mime`/`size`) совпадают со sidecar, размер ≤ `maxBytesPerFile`; нет сервиса
  вложений → fail-closed `attachments_unavailable`). В сообщение сессии вложения попадают
  медиа-частями (`eventToMessage` + `appendMediaPlaceholders`), ссылки пишутся в `blob_refs`
  (`ownerKind: 'message'`); отказ — `EventAttachmentError` (400 `VALIDATION_ERROR` на роуте).
  `RouteRuleProvider` (seam),
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
  **Цель `pipeline` (ADR-101)** — исключение из маршрутизации: `ScheduleTarget =
  {mode:'pipeline', projectId, pipelineId, version?, payload?}` → прогон запускает **раннер прогонов**
  напрямую, событие в `EventIngress`/Router **не публикуется**, `payload` статический, пайплайн
  должен быть опубликован; Job — `decision:'pipeline'` с `pipelineId`/`runId`
  (`SchedulerRuleProvider` для такой цели отдаёт `null`).
- `engine/question/*` — ADR-112 (этап 1 roadmap 0.13 — блок 1.3): «вопрос пользователю»
  (`ask_user`). `service.ts` (`QuestionService`: `ask`/`answer`/`cancel`/`list`/`listPending`/
  `cancelSession`; ожидание ответа — в памяти процесса, таймер `unref`), `types.ts`
  (вход/выход вопроса, коды ошибок `QuestionError`/`QuestionNotFoundError`/…), `prune.ts`
  (`startQuestionPruner` — retention
  терминальных записей, сразу + каждые 6 ч). Публикует `user_question.asked`/
  `user_question.answered`/`user_question.cancelled` в канале сессии; в `user_question.asked`
  payload несёт `created_at` и `expires_at` (ISO-8601; `expires_at` — только при заданном
  таймауте) — по нему UI рисует обратный отсчёт. Тул — `engine/tools/
  question.ts` (переводит ответы модели в записи вопросов). Порт — `QuestionRepository`
  (`storage/ports/question-repository.ts`; файловый — `{dataDir}/questions.json`, в-памяти —
  `storage/memory/questions.ts`, PG — миграция `021_background_runs`; контракт —
  `storage/contract/question-repository.contract.ts`). Срок ожидания ответа по умолчанию **не
  задан** (`questions.timeoutMs = 0` — без таймера, без `expiresAt`); срок может задать тул
  `question` (`timeout`, ≥ 5 мин — не рекомендуется: по истечении вопрос снимается с причиной
  `timeout`).
- `engine/background/*` — ADR-111 (этап 1 roadmap 0.13 — блок 1.2): единый реестр фоновой
  работы. `service.ts` (`BackgroundRunService`: `startSubagent`/`startProcess`/`finish`/`stop`/
  `stopBySession`/`recoverOnStart`/`prune`/`buildSubagentNotification`; `stopBySession` (обход дерева
  `parentId`, глубина ≤ 5, только `running`) — публичный API сервиса, но «Стоп» сессии его больше
  **не** вызывает (решение 2026-10-31: прерывается только активный ход); лимиты сессии — `background.*`
  (считаются только по **живым** `running`-прогонам: терминальные записи — история реестра, её
  чистит retention, и лимит она не занимает; `maxRunsPerSession` — общий потолок одновременно идущих
  прогонов обоих видов);
  старт публикует `child.started`/`process.started`, терминальный переход —
  `process.exited`/`child.completed|failed|cancelled` в канал
  сессии-владельца; `metadata` уведомления родителю несёт метки прогона —
  `started_at`/`finished_at`/`duration_ms`/`exit_code`/`signal`/`command`/`cwd`/
  `agent_role`/`description` — для карточки результата в UI; конверт `<process …>`/
  `<subagent …>` для модели не меняется), `types.ts` (входы запуска, лимиты, коды ошибок, `BackgroundLimitExceededError`), `prune.ts`
  (`startBackgroundRunPruner` — retention, чистятся только терминальные записи). Порт —
  `BackgroundRunRepository` (`storage/ports/background-run-repository.ts`; файловый —
  `{dataDir}/processes/registry.json` (`storage/file-background-run-store.ts`), в-памяти —
  `storage/memory/background-runs.ts`, PG — `packages/storage-postgres/src/ports/
  background-runs.ts`, миграция `021_background_runs`; контракт —
  `storage/contract/background-run-repository.contract.ts`).
  Мастер-выключатель `background.enabled` гейтит **оба** вида фоновой работы:
  `task` (`task.background_disabled`) и `execute_shell` (`process.background_disabled`).
- `engine/processes/*` — ADR-113 (ADR-111): фоновые шелл-процессы. `service.ts`
  (`ProcessService`: `spawn` через `ExecutionPort.spawnBackground`, поток stdout/stderr в лог,
  `stop`, `logs`; лимит записи лога — `background.logMaxBytes`; `stop` публикует
  `process.stopped` в канал владельца — один раз на прогон, терминальный статус
  приходит позже — `process.exited`), `types.ts`
  (`BackgroundUnsupportedError` и пр.), `prune.ts` (очистка логов). Логи — blob-хранилище
  (`BlobStore`), путь `processes/<id>.log`. **Фоновый запуск — в обеих реализациях**
  (inline и remote, ADR-077 шаг 7c): в `remote` процесс живёт на исполнителе, control
  plane наблюдает его опросом (журнал — 300 мс, состояние — 500 мс; стриминга на проводе
  нет), поэтому лог в control plane появляется с задержкой опроса и **дублируется** с
  журналом на исполнителе (до его `prune`). Исполнитель старой версии (протокол < 3, нет
  `features.background`) → `ExecutionError.code = 'EBACKGROUND'`
  (`EXECUTION_BACKGROUND_UNSUPPORTED_CODE`) → `background_unsupported`.
- `engine/worktree/*` — ADR-114 (per-session рабочий каталог): `WorktreeService`
  (`engine/worktree/service.ts` — git-операции **только** через порт `ExecutionPort` (ADR-077),
  корень `{workspacesRoot}/.worktrees/<projectId>`, создание/удаление/prune/sweep, детект secondary
  worktree, startup-скрипт проекта), `errors.ts` (типизированные ошибки с машинными кодами
  `WORKTREE_*` — HTTP-статус по коду), `events.ts` (`worktree.updated` + `fs.changed` в каналы
  сессий проекта, лимит 200), `sweep.ts` (`startWorktreeSweeper` — стартовый sweep осиротевших
  записей: **фоново**, старт не блокируется, ошибка — в лог; вызывается из `server/app/deps.ts`
  и `backend/app/deps.ts`); тулы `git_worktree_list|create|remove|prune`
  (`engine/tools/worktree.ts` — проект только из сессии, в plan-режиме мутации запрещены,
  `create` не привязывает сессию). Порт инвентаря — `storage/ports/worktree-repository.ts`
  (ADR-096); привязка сессии — `Session.worktree` (в форме хранения — snake_case, PostgreSQL —
  миграция `023_session_worktree`); резолв cwd — `engine/orchestrator.ts` (fail-closed при
  исчезнувшем каталоге). Спецификация — `docs/WORKTREES.md`.
- `engine/fs-change.ts` — `resolveFsChange`: классификация мутирующих тулов → событие `fs.changed` (scope `file`/`all`, `workspaceChanged`, `op: 'write'|'delete'|'mkdir'|'move'` для файловых тулов; `move` (`from`/`to`) выделяется из простой `mv`/`git mv` в `execute_shell`, вне workspace/непростая команда → `{scope:'all'}`); **мультифайловая правка `patch`** — пути из `metadata.files[]` (`resolvePatchChange`): все пути внутри workspace → `scope:'file'` + `op:'write'`, любой путь вне workspace или неизвестный состав → `{scope:'all'}` (дерево Files, открытые редакторы и Git-вкладка обновляются после правки); read-only → `null` (событие не публикуется).
- `git/*` — `git-service.ts` (clone/init/fetch/remove/log; публичный API не меняется,
  исполнение — через `ExecutionPort`; **клон атомарный**: git получает соседний временный
  каталог `<path>.tmp-<uuid>`, целевой путь появляется только после успеха (`rename`), а любая
  ошибка/таймаут убирает временный каталог — на диске не остаётся ничего; таймауты сетевых
  операций — `cloneTimeoutMs`/`fetchTimeoutMs` из секции `git` конфига, истечение →
  `git.clone_timeout`/`git.fetch_timeout`), `repo-occupancy.ts` (`inspectRepoPath` —
  классификация занятого целевого пути **по файловой системе**, git не запускается:
  `repo`/`stub`/`dir` + `entries`; нечитаемый каталог → `git.repo_path_unreadable`),
  `exec.ts` (argv git через порт: `requires: ['git']`,
  общее окружение `sanitizeGitEnv` + `GIT_TERMINAL_PROMPT=0` + прокси, `maxOutputBytes`;
  CA `-c http.sslCAInfo=<path>` — **только inline**, в remote-режиме доверие задаёт
  исполнитель, ADR-099/ADR-077) и
  `ssh-env.ts` (`GIT_SSH_COMMAND`, temp-ключ `0600`; passphrase — askpass-скрипт
  `0700` + `SSH_ASKPASS_REQUIRE=force`, `env_failed`).
- **SSH-доступ — секрет вызова, а не файл в control plane** (ADR-077, протокол 4).
  Приватный ключ per-agent раскрывается в control plane и уходит в порт **значением**:
  `ExecSecret` (`execution/ports/execution-port.ts`: `kind:'ssh-key'`, `privateKey`,
  `passphrase?`) в `ExecRequest.secrets`. Материализацию делает **точка исполнения**:
  `execution/secret-env.ts` (`materializeSecretEnv` — inline-режим) либо исполнитель
  (`packages/executor/src/secrets.ts` — remote-режим; путь к файлу control plane в его
  контейнере не существует, поэтому прописать его в `GIT_SSH_COMMAND` нельзя).
  Итог: **в control plane временных файлов с ключом не остаётся** — только значение в
  запросе; `git/ssh-env.ts` (`toSshSecret`) превращает раскрытый ключ в `ExecSecret`,
  `engine/tools/git-ssh.ts` отдаёт `secrets` (не `env`), `git/exec.ts` и `git/git-service.ts`
  передают `secrets` в порт. Значения **не логируются** и **не возвращаются** в ответе;
  фоновые процессы (`spawnBackground`) секреты не поддерживают — fail-closed с кодом
  `ESECRETS` (`EXECUTION_SECRETS_UNSUPPORTED_CODE`).
- `storage/` — **слой хранения (ADR-096):** доменные порты `storage/ports/*` (45 файлов-описаний, `DocumentRepository<T>` даёт три поля; `AnalyticsRollupRepository` — суточные роллапы аналитики, ADR-102;
  `ExternalCredentialRepository` — внешние доступы к коннекторам (ADR-105 Ф1; файловое/в-памяти
  хранилища — `ExternalCredentialStore`, контракт — `storage/contract/external-credential-repository.contract.ts`);
  `CredentialAuditRepository` — append-only журнал операций со слоем доступов (ADR-105 Ф4;
  **отдельный** порт, `SECURITY_AUDIT_SCOPES` в `shared` не расширяется; файловое —
  `storage/file-credential-audit-store.ts` (`{dataDir}/audit/credentials.jsonl`), в-памяти —
  `storage/memory/credential-audit.ts`, PG — миграция `014`; контракт —
  `storage/contract/credential-audit-repository.contract.ts`; журнал **не** публичный API);
  `AuthorityPolicyRepository`/`AuthorityDecisionJournal` — политика полномочий и журнал решений
  Authority-слоя (ADR-106 Ф1; PostgreSQL — `packages/storage-postgres/src/ports/authority.ts`,
  миграция `014` — контрактный suite гоняется на **живой** БД, гейт `SYNTH_TEST_POSTGRES_DSN`);
  контент `provides.authority` пакета активируется в `authorityPolicy` при одобрении пакета и
  снимается при снятии установки (см. `engine/authority/activation.ts`));
  `QuestionRepository` — персистентные записи вопросов пользователю (ADR-112; файловое —
  `{dataDir}/questions.json`, в-памяти — `storage/memory/questions.ts`, PG — миграция
  `021_background_runs`; контракт — `storage/contract/question-repository.contract.ts`);
  `BackgroundRunRepository` — единый реестр фоновых прогонов (ADR-111; файловое —
  `{dataDir}/processes/registry.json`, в-памяти — `storage/memory/background-runs.ts`, PG —
  миграция `021_background_runs`; контракт —
  `storage/contract/background-run-repository.contract.ts`);
  `WorktreeRepository` — инвентарь git-worktree'ов (ADR-114, per-session рабочий каталог;
  файловое — `{dataDir}/worktrees.json`, в-памяти — `storage/memory/worktrees.ts`, PG —
  generic-таблица `documents` (`kind='worktree'`), **без новой миграции**; контракт —
  `storage/contract/worktree-repository.contract.ts`; `save` — полная перезапись записи,
  `createdAt` иммутабельно, `updatedAt` ставит вызывающий, `list` — «свежие первыми»
  по `createdAt`, `delete` идемпотентно, `deleteByProject` — число удалённых);
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
  `storage/file-blob-store.ts` (`FileBlobStore`, порт `BlobStore` — `read`/`write`/`append`/
  `delete`/`exists`/`list`, плюс аддитивные `stat` и `readStream({start?, end?})` для раздачи
  вложений без чтения в память (ADR-115: `Range`/`206`/`416`, `HEAD`); `append` — дописывание
  в конец для журналов (логи фоновых процессов,
  ADR-113), атомарность не требуется), `storage/file-blob-ref-repository.ts` (порт
  `BlobRefRepository` — учёт ссылок на blob-объекты, ADR-115/ADR-116: тройка
  `(blobPath, ownerKind, ownerId)`, `ownerKind` ∈ `message`|`pipeline-run`|`skill`|`process`,
  `add` идемпотентен; по нему дедуп и GC сирот), `storage/defaults-store.ts`
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
  `attachments` + live-состояние (`createLiveAttachmentsSettings`, ADR-115: runtime-патч секции
  `attachments` — `enabled`/`modalities`/лимиты/`workspaceFallback`/`allowedMimePrefixes`/
  `modalityModels`/`gcDays`; резолвер `resolveAttachmentsSettings` — env `SYNTH_ATTACHMENTS_*` >
  runtime > config > defaults, `modalityModels` собирается по семействам; применяется **сразу**,
  сервис вложений и pruner читают значение на каждый вызов),
  `McpRegistryStore` (единый реестр MCP, ADR-071),
  `SkillStore`, `CommandStore`, `SkillBundleStore` (ADR-046), `SSHKeyStore`
  (`secrets/ssh-keys`, шифрование at-rest, ADR-076),
  `ExternalCredentialStore` (ADR-105 Ф1: внешние доступы к коннекторам —
  `secrets/oauth/credentials.json`, `0600`; access/refresh-токены зашифрованы
  мастер-ключом (`enc:v1:…`), наружу отдаются только метаданные с маской;
  `revoke` идемпотентен и необратим, `markError` — после `invalid_grant`; порт
  `ExternalCredentialRepository`, контракт —
  `storage/contract/external-credential-repository.contract.ts`; Ф4 — `rotateMasterKey`
  (перешифровка `secretEnc`/`refreshEnc`, preflight → отказ **до** записи, `dryRun`)),
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
  `enabled`/`setEnabled` (мягкое отключение `disabledAt`)/`getSecret`/`touchDelivery`;
  `rotateMasterKey` — перешифровка signing-секрета под ротацию мастер-ключа, preflight →
  отказ **до** записи, `dryRun`),
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
  `AsyncLock`, `clear` атомарно tmp→rename; **чтение** — `list(opts)`: записи «свежие первыми»,
  фильтры `plugin`/`action`/`outcome`, `limit` — последние N), `MemoryPluginAuditRepository`
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
- `sessions/auto-title.ts` — авто-заголовок сессии. **Триггер — начало хода, не конец:**
  имя генерируется **сразу после первого сообщения пользователя**, до ответа
  ассистента (оркестратор: `_maybeAutoTitle` после `runProcessSetup` — провайдер уже
  выбран роутером, — и на раннем пути микро-слоя `runProcessEarly`, где провайдер
  хода ещё не выбран и резолвится из сессии). Вызов **fire-and-forget** — ход не
  ждёт LLM; `session.updated` публикует оркестратор.
  **План (`shouldAutoTitle`)** — по числу диалоговых реплик пользователя (N;
  служебные реплики не считаются): N=1 и реплика — «chatter»
  (`isLowSignalMessage`: приветствие/смолток, без вложений и короче
  `minSignalChars`) → `null`: генерация **откладывается**, LLM не зовётся, заголовок
  остаётся `New session`; N=1 и есть сигнал задачи → `{mode:'message'}` (заголовок по
  первому сообщению); N=2..`maxAttempts` → `{mode:'conversation'}` (заголовок по
  диалогу: `Original request` + `Recent conversation`, бюджет 8000 символов, обрезка с
  хвоста); N > `maxAttempts` → `null` (только ручная регенерация). Счётчик **не
  персистится** — выводится из истории (`isUserDialogueMessage`), поэтому правило
  идемпотентно и переживает рестарт. Сессии с `parentId` (саб-агенты) не
  авто-именуются; `/`-команда первой репликой — тоже.
  **LLM-ответ** (снятие `<think>`, первая непустая строка, предел 100 символов);
  при ошибке/пустом/слишком длинном ответе — `warning('AUTO-TITLE', причина)` **без
  содержимого сообщений** и фоллбек: **первая реплика с сигналом задачи**, её первая
  непустая строка без markdown-разметки, схлопнутые пробелы, обрезка до 60 символов
  (для chatter-реплик фоллбек не строится — заголовок не меняется). Заголовок по
  умолчанию не перетирается (`manager.renameSessionIfDefault`), при `force` —
  перетирается (`renameSession`).
  **Ручная регенерация** — `orchestrator.regenerateTitle(sessionId)` (force: план
  всегда `{mode:'conversation'}`, заголовок перетирается, включая пользовательский):
  роут `PATCH /api/v2/sessions/:id` с телом `{"title": ""}` (в гибриде тело
  проксируется удалённому серверу), ответ — DTO сессии; собрать имя не удалось —
  заголовок прежний, ответ 200. Непустой `title` — обычное переименование. В UI —
  пункт контекстного меню сессии «Обновить название».
  **Конфиг `session.autoTitle`** (`@itphx/synth-shared/config`: `enabled`/
  `deferOnChatter`/`maxAttempts`/`minSignalChars`; env `SYNTH_SESSION_AUTO_TITLE_*`) —
  оркестратору через `OrchestratorOptions.autoTitle`.
  **Служебные user-сообщения (`sessions/user-messages.ts`).** «Вторая реплика пользователя» —
  только диалог: `isUserDialogueMessage` (`role: 'user'` **и** не служебное),
  `isServiceUserMessage` — `ephemeral` (локальный ответ `/`-команды), `metadata.synthetic`
  (state-сообщения), steer-инъекция (`metadata.steer`), уведомление фонового прогона
  (`metadata.type === 'background_run_result'`), шедулер (`metadata.scheduler` /
  `metadata.schedule_id` / `author === 'Scheduler'`). Предикат использует **авто-тайтл**
  (`auto-title.ts` — иначе steer-инъекция в первом ходе блокировала заголовок и сессия
  оставалась «New session»); новые служебные виды user-сообщений добавлять сюда, а не
  локальными проверками.
- `sessions/stats.ts` — `computeSessionStats` (ADR-070): usage сообщений + рекурсивный usage
  саб-агентов (tool `task`), агрегаты по агентам/пользователям — для `GET /api/v2/sessions/:id/stats`.
- `queue/processor.ts` — `QueueProcessor`/`QueueProcessorManager`; надёжный «Стоп» — `requestStop()` (in-memory запрос: будит backoff, абортит активный LLM-вызов) + `_shouldStop`/`_handleStopRequest` (проверка in-memory запроса и персистентного `status.cancelRequested` на границах цикла; **«Стоп» останавливает только активный ход — очередь (`pendingMessages`) сохраняется целиком**, решение владельца 2026-11-01: снимаются `blocked`/`cancelRequested`/`currentStream`/`retry`, публикуется `queue.state` (счётчики по фактической очереди) и `stream.cancelled` ровно один раз; автозапуска обработки нет — продолжение через `POST /queue/:sessionId/resume` или новую постановку сообщения). Публикация приёма: `message.accepted` (адресное, без текста) и `message.enqueued` (**адресное — только отправителю/владельцу сессии; владельца нет — не публикуется**, со снимком сообщения — снимок уже обфусцирован, `ord` нет; `enqueueUserMessage` → `delivery:'queue'`, `enqueueSteerMessage` → `delivery:'steer'`; при отказе постановки события нет). **Перенос из очереди в очередь инъекций (`fromPending`) — атомарный**: под одним локом сессии проверяется лимит, сообщение снимается из `pendingMessages` и его user-копия из истории (по `metadata.stream_id`, кроме активного стрима) — и только потом публикуется `message.enqueued` (иначе клиент увидел бы реплику в `pending_messages` и удалил её из ленты как «вернувшуюся в очередь»); отказ по лимиту → `reason:'limit'` (429, очередь не тронута), сообщения нет в очереди → `reason:'not_found'` (404, повторный steer того же id).
- `remote/*` — клиент, сессии, credentials, device-flow, transfer, aggregate, event-bridge.
- `providers/*` — `ProviderFactory`, `BaseProvider`, OpenAI/Anthropic/Ollama/Remote, `DecisionProvider` (ADR-084: типы `decision` (RouterAI, `POST {base}/decisions`) и `systemone` (Ollama, `POST {base}/v1/systemone`) — endpoint выбирается по типу провайдера). Prompt-cache (ADR-070, `CachePolicy = 'auto' | 'none'` в `base.ts`): `SystemPromptPayload` (`text`/`stablePrefix`/`cacheKey`/`cachePolicy`) — Anthropic отдаёт `system` массивом блоков с `cache_control` (≤4 breakpoint'а, два system), OpenAI/Remote — `prompt_cache_key` (= id сессии) + `stream_options.include_usage`; `usage.ts` — нормализация usage и `computeCacheHitRate` (`cacheReadTokens / inputTokens`, 0 при нуле). Нормализация по провайдерам: Anthropic — `input = input_tokens + cacheRead + cacheWrite`; OpenAI — `prompt_tokens_details.cached_tokens` → `cacheRead`; Remote — usage из ответа прокси в тот же контракт; Ollama — cache-полей нет (`cacheRead = cacheWrite = 0`).
  **Слой совместимости провайдеров и моделей (ADR-117, parity с opencode, 2026-10-30).**
  `ModelCompatibility` (`shared/types/provider.ts`) описывает различия протокола данными, а не
  хардкодом по типу провайдера: `reasoningField` (имя reasoning-поля в assistant-сообщениях openai-chat,
  дефолт `reasoning_content`), `requireReasoning` (поле обязательно у **каждого** assistant-сообщения,
  пустой строкой, если reasoning нет), `maxTokensField` (`max_tokens` — дефолт; `max_completion_tokens`
  только явным значением, иначе локальные серверы ломаются), `requireAssistantAfterTool`
  (assistant-«мост» после `tool`-результатов, Mistral-семейство), `streamUsage`
  (`stream_options.include_usage`, дефолт включён), `supportsToolChoice` (у нативного Ollama — `false`),
  `cacheFormat` (`anthropic`/`alibaba` — inline-маркеры `cache_control` в openai-теле: последний tool +
  system + хвост / только system + хвост, бюджет ≤4, `prompt_cache_key` при заданном значении не
  отправляется; без `cacheFormat` — прежний implicit prefix caching), `requireFinishReason` (дефолт
  `true` — стрим без `finish_reason` = incomplete-stream, ошибка невосстановимая: паттерн в
  `UNRECOVERABLE_PATTERNS`). `supportsEffortUpdates` (дефолт `false`, **без авто-эвристики** — только
  явное `true`: флаг меняет тело запроса, и угадывание отправило бы `output_config` шлюзам без
  поддержки) включает effort-режим Anthropic: `body.output_config = { effort }` и **никакого**
  `thinking` (ни `enabled`, ни `disabled`), thinking-блоки истории не реплеятся, `temperature` не
  форсируется. Тир считается на **каждый** LLM-вызов по цепочке `ChatOptions.effort` → `agent.effort` →
  `session.settings.effort` → `effortForReasoningLevel(reasoningLevel)`; `effortForReasoningLevel`
  маппит только `low|medium|high` (`none`/`default` → параметр не отправляется), а `xhigh`/`max`
  задаются явным `effort` — поля `AgentDefinition.effort`/`SessionSettings.effort`
  (`shared/types/{agent,session}.ts`; `null` при обновлении — сброс к «авто»; валидация в схемах
  сессии/агента). Значения считают `engine/orchestrator.ts` (`agentDef.effort ??
  session.settings.effort ?? …`) и цикл саб-агента (`engine/tools/task/run-cycle.ts`,
  `SubagentRunConfig.effort`; `task`/`task-resume` кладут `agent.effort ?? настройки ребёнка` и
  фиксируют тир в настройках дочерней сессии) — на каждый вызов, потому что провайдер кэшируется.
  LLM Proxy (backend) `reasoning_effort` принимает и собирает `compatibility` теми же слоями
  (провайдер → shorthand модели → модель); гибридный `RemoteProvider` шлёт `reasoning_effort` сам
  (stream и non-stream; при `undefined` поля нет — аддитивно для старых серверов, guard остаётся на
  удалённой стороне). `SessionManager.createSession` сохраняет `settings.reasoningLevel` **и**
  `settings.effort` при создании (раньше `reasoningLevel` терялся — effort не применялся до `PATCH`);
  `topP`/`topK` — поля агента, в `SessionSettings` их нет.
  **Остаток:** mid-turn смена усилия (`PATCH` во время хода) не подхватывается до конца хода —
  дешёвого getter'а настроек нет (`loadLight` в файловой реализации парсит всю сессию), нужен
  `SessionRepository.loadSettings`/кэш настроек с инвалидацией.
  Два уровня: `ProviderConfig.compatibility` — дефолты провайдера, `ModelConfig.compatibility` —
  перекрывает их по каждому полю; `ModelConfig.requiresReasoning` — **shorthand** для
  `compatibility.requireReasoning` (нормализация `compatibility.requireReasoning ?? requiresReasoning`).
  Порядок резолва — **модель → провайдер → эвристика → дефолт** (`resolveModelCompatibility`); явный
  `reasoningField` сам означает `requireReasoning: true`, если `requireReasoning` не переопределён.
  Эвристики (`detectCompatibilityHeuristics`, только для незаданных полей): `requireReasoning` — тип/имя
  провайдера `deepseek`, URL с `deepseek.com`, id модели с `deepseek`; `requireAssistantAfterTool` —
  `mistral`/`devstral`/`codestral`/`pixtral`/`mixtral`; `supportsToolChoice: false` — `type: 'ollama'`;
  нативные медиа (ADR-115 × ADR-117) — `nativeAudioFormats`/`supportsNativeVideo` по матрице «тип
  протокола × RouterAI-совместимый хост» (`isRouterAiUrl` в **shared** — единственный носитель
  host-знания и **только эвристика умолчания**: не-routerai прокси `itphx` нативное видео умеет —
  живой тест 2026-11-03; host-предикаты `providers/base.ts` удалены).
  Резолв каталога собирается в `server/app/deps.ts` и `backend/app/deps.ts` (им же пользуются шаги
  пайплайнов и aux-модели вложений); `ProviderPool` кладёт значение в `cacheKey`, `toCoreProviderConfig` —
  в конфиг провайдера (`engine/router/{utils,routing}.ts`); внутри провайдера —
  `resolveProviderCompatibility` (`providers/base.ts`, явное → shorthand → эвристика);
  `detectRequiresReasoning` оставлен как deprecated-fallback. `OpenAIProvider._formatMessages` берёт имя
  поля и требование из резолва, ставит assistant-«мост» после `tool`-сообщений (и в конце истории, если
  она закончилась `tool`), выбирает поле лимита вывода и `stream_options`. Без `requireReasoning`
  DeepSeek отвечал `400` «The `reasoning_content` in the thinking mode must be passed back to the API» —
  ломался синтетический assistant-префилл шага-лимита (`engine/llm/max-steps.ts`).
  API: `POST`/`PATCH /api/v2/providers`, `POST /api/v2/models` принимают `compatibility` как **полную
  замену** (`null`/`{}` — сброс, поле не передано — без изменений, неизвестное поле/тип → 400);
  `GET` отдаёт поле, только если оно задано (`server/routes/{providers,models}.ts`).
  **Anthropic: round-trip thinking — мульти-блочный (`91be3f89`).** При `reasoningLevel: 'high'`
  бюджет thinking считается от фактического `max_tokens` (`resolveThinkingBudget`: не больше половины
  и строго меньше лимита, минимум 1024; места нет — thinking выключен, а не `400`), `temperature`
  принудительно `1`, `tool_choice: 'required'` коэрсится в `'auto'`.
  За ход reasoning приходит **несколькими блоками** (по итерациям), а подпись валидна только для
  своего текста — поэтому блоки хранятся **по отдельности**: `Part` с `type: 'reasoning'` и
  `metadata?: { signature?, redacted? }`; в LLM-контракте — `LLMReasoningBlock { text, signature?,
  redactedData? }` (`LLMChunk`/`LLMResponse.reasoningBlocks`, `LLMMessage.reasoningBlocks`).
  Legacy-поля `reasoningSignature`/`reasoningRedacted` на сообщении сохранены как **fallback**
  (`reasoningBlocksOfMessage`), `appendReasoningBlock(..., meta?)` не теряет подпись при продолжении
  блока. Anthropic собирает блоки в стриме (`content_block_start`/`thinking_delta`/`signature_delta`,
  блок закрывается на старте следующего) и в non-stream; `_formatMessages` реплеит их по блокам в
  порядке `redacted_thinking → thinking → text → tool_use`, **у каждого блока своя подпись**; пустая
  подпись (`signature: ""`) допустима — так отвечает RouterAI для qwen. При выключенном thinking
  блоки в историю не уходят. Наружу через API не отдаются (`server/serialize.ts`) — служебные данные
  протокола.
  **`requireReasoning` запрещает `thinking:{type:'disabled'}`.** У модели с обязательным reasoning
  (например MiniMax) явный `disabled` — ответ `400` (`code 2013`): при `reasoningLevel: 'none'` адаптер
  у такой модели поле `thinking` **не отправляет вовсе** (`_resolveThinking` → `_requiresReasoning`,
  рядом `warn` в лог), а не изображает выключение. У остальных моделей поведение прежнее —
  `{type:'disabled'}` (ADR-117).
  **Шов «части ↔ блоки» — `engine/reasoning-blocks.ts`** (`toLlmReasoningBlocks`,
  `makeReasoningParts`, `reasoningBlocksFromParts`, `reasoningBlocksOfMessage`): оркестратор и цикл
  саб-агента собирают блоки по итерациям, персистят их в `parts` финального assistant-сообщения
  (`persistence.ts`), история восстанавливается в `prompt-info.ts`; `serializePart`/`deserializePart`
  (file-store и PostgreSQL) сохраняют `metadata` части. `messageToLLMMessage(msg, currentAgentRole?)`
  прокидывает блоки **только для «своего» агента** (алиасы ролей учитываются), чужой агент — без
  блоков; `task` при `context_mode: inherit|last_n` передаёт роль ребёнка. **`content` при наличии
  `parts` собирается без reasoning-частей** (иначе после перезагрузки `<reasoning>` подмешивался в
  текст ответа); legacy-сообщения без `parts` — прежнее поведение.
  **Ограничение:** фильтрация блоков идёт по **роли агента**, а не по фактической паре
  provider/model — при смене модели у того же агента старые подписи всё равно уйдут в историю
  (симметрично `engine/tools/task/resume-target.ts`).
  **Суммаризация** (`engine/context/optimizer.ts`) использует общий `toCoreProviderConfig` —
  `provider.compatibility` доезжает до провайдера суммаризации (раньше терялась: reasoning-поле и
  `maxTokensField` расходились с основным прогоном агента).
  **Ollama (`/api/chat`).** `think` включается для `low|medium|high` (`none` — `false`, `default` — поле
  не отправляется); `tool_choice` не отправляется при `supportsToolChoice: false` (`providers/ollama.ts`).
- `profiles.ts` — реестр серверных профилей гибрида.
- `prompts/` (system, roles, subagents, security), `definitions/`
  (`protected-paths.json`, `shell-policy.json`), `dictionaries/` — ассеты движка.
  `prompts/system/MAX_STEPS.{ru,en}.md` — требование «только текст» для
  финального шага-отчёта по лимиту шагов (саб-агент и основной агент;
  механика opencode; загрузчик — `ContextConfig.getMaxStepsPrompt`,
  override — `{dataDir}/user/system/MAX_STEPS.{lang}.md`).

## Правила добавления тула / роута

- Тул: реализовать `ToolDefinition` (Zod `parameters` + `capabilities:
  ToolCapability[]`) и добавить в `ALL_BUILTIN_TOOLS` (`engine/tools/index.ts`);
  доступность — по capability, а не по имени в оркестраторе.
- Права на тул — правилами permission-слоя (`engine/permission/*`), не `if`
  внутри `execute`.
- **Containment файлового тула — по периметру сессии.** `ToolContext.workingDir` —
  база для относительных путей; `ToolContext.allowedRoots` — дополнительные
  абсолютные корни (у сессии в git-worktree это `project.workspace`, ADR-114).
  Путь «свой», если он внутри **любого** корня: проверка —
  `isSymlinkEscapeInRoots(toolRoots(ctx), candidate)` (`engine/tools/path-utils.ts`,
  учитывает симлинки; побег = лексически внутри корня, реально — вне всех).
  `resolvePath(...)` всегда от `ctx.workingDir`. Внешний путь «своим» не считается:
  его гейтит permission-слой (`external_directory` → ask/deny), в самом туле
  проверок прав нет.
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
  `createProcessRoutes` (PROP-096/097) — HTTP-контур единого реестра фоновых
  прогонов (`GET /` — список с фильтрами `sessionId`/`projectId`/`kind`/`status`/
  `limit`, `GET /:id` — деталь, `GET /:id/logs` — отрезок лога фонового
  процесса, `POST /:id/stop` — остановка, `DELETE /:id` — удаление терминальной
  записи). Доступ — **на границе** (инвариант 16): guard `processGuard` резолвит
  запись реестра и её сессию-владельца **один раз**, кладёт запись в контекст
  (`guardedProcess`), обработчики проверок доступа не содержат; вид доступа —
  по HTTP-методу (`read`/`write`), `VIEWER` читает, но не мутирует (инвариант
  21). Список прогонов фильтруется по доступу к сессии-владельцу (сессии кэшируются
  на один запрос). Core-дефолт `isAllowed` — `createSessionAccessPredicate()`;
  backend передаёт правило проекта (`routes/processes.ts`).
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

## Вложения (ADR-115)

Мультимодальный ввод: изображение/аудио/видео/файл как часть сообщения. Байты — только
в blob-порте (том), в сообщении — ссылка; спека — [ADR-115](../../docs/arch_decisions/adr-115-multimodal-input.md),
blob-порты и `blob_refs` — ADR-116.

- **Модель контента.** `PartType` дополнен `image`/`audio`/`video`/`file`, данные части —
  `MediaPartData` (`blobPath`, `sha256`, `mime`, `size`, `name?`, `width?`/`height?`/
  `durationMs?`, `transcript?`). Медиа-часть обязана давать в `content` плейсхолдер
  (`[image: name.png]`) — иначе строковые производные (поиск, экспорт, PG-маппинг) теряют
  факт вложения.
- **Вложения из инструментов — служебные.** `_injectToolAttachments` создаёт user-сообщение
  `author: 'Tool'` с `metadata {source: 'tool-attachment', tool, call_id, agent_role}`; в UI это
  служебный блок «Агент · <имя> · вложение», а не пузырь пользователя. Для авто-заголовка,
  статистики автора и границ хода (`disabled-turns`) такое сообщение **не** реплика человека
  (`sessions/user-messages.ts`, `isServiceUserMessage`).
- **Сервис (`engine/attachments/service.ts`).** `AttachmentService` — единственная точка
  записи байтов: MIME по **сигнатуре** (не по заявленному), лимиты `attachments.*`, allowlist
  префиксов, запрет `image/svg+xml` (XSS), content-addressed путь `attachments/<sha2>/<sha256>`
  + sidecar с именем; `resolve`/`read` отдают только объекты из `attachments/`
  (`isAttachmentPath` — логи и артефакты через этот контур не читаются). `stat`/`readStream`
  в blob-порте дают раздачу потоком (`Range`/`ETag`/`HEAD`).
- **Загрузка потоком и chunked (`service.ts`, `uploads.ts`, `server/routes/attachments*.ts`).**
  `AttachmentService.ingestStream` пишет байты в `attachments/.uploads/<uuid>` через
  `BlobStore.writeStream`, считает sha256 инкрементально, копит первые `MIME_HEAD_BYTES` (4 КиБ)
  для `sniffMime`/`looksLikeSvg` и рвёт поток при превышении `maxBytesPerFile`; финал —
  `move` в content-addressed путь и общий `upload`-путь (дедуп, sidecar, миниатюра, метрики).
  `ingestPath` — тот же финал для готового объекта (chunked). `UploadSessionStore` (**stateless,
  multi-replica**: состояние — на томе рядом с temp-объектом, sidecar
  `attachments/.uploads/<uuid>.json` = `{version, sessionId?, name?, mime?, createdAt}`; **смещение —
  по фактическому размеру файла**, TTL `UPLOAD_SESSION_TTL_MS` = 1 ч, ленивая уборка) обслуживает
  протокол `POST …/uploads` → `PUT /:uploadId?offset=N` → `POST …/complete` → `DELETE`; часть
  ограничена `attachments.maxChunkBytes`, итог — `maxBytesPerFile` (`413`), смещение — `400`;
  `size` — целое ≥ 0 (`invalid` → `400`), квоты — `maxBytesPerSession` (с учётом активных загрузок
  сессии), `maxActiveUploadsPerSession`/`maxActiveUploads` (staging — только глобальный).
  В контуре сессии загрузка привязана к сессии (`sessionId` в sidecar) — чужая сессия её не видит
  (`404`). Роуты общие для сессии и staging (`registerUploadSessionRoutes`); raw-body —
  `openAttachmentRawUpload` (имя `?name=`/`x-file-name`, `declaredMime` из `Content-Type`, MIME всё
  равно по сигнатуре). Требуется **общий том `blobs`** для всех реплик control plane.
- **GC (`prune.ts`, `startAttachmentPruner`).** Три класса записи, все — в одном прогоне
  (сразу при старте и далее каждые 6 ч, `unref`, ошибки не роняют): **осиротевшие объекты**
  (нет `blob_refs` И старше `attachments.gcDays`; sidecar удаляется вместе с объектом) —
  живой объект старым быть может, поэтому по возрасту не удаляем; **кэши** `attachments/.thumbs/`
  и `attachments/.derived/` (включая `compress/`) — производные без `blob_refs`, регенерируемые:
  чистятся по `gcDays` (mtime) **без** проверки ссылок, `gcDays <= 0` — не чистятся;
  **временные объекты загрузок** `attachments/.uploads/` — temp незавершённой chunked-загрузки:
  свой TTL `UPLOAD_SESSION_TTL_MS` (1 ч), **независимо от `gcDays`** (иначе при `gcDays = 0`
  копились бы бесконечно: ленивая уборка сессий загрузки срабатывает только при активности
  протокола). Счётчик `synth_attachment_gc_removed_total` — суммарно по всем классам.
- **Миниатюры (`thumbnails.ts`, `?variant=thumb`).** Производный JPEG
  `attachments/.thumbs/<sha256>-<width>.jpg` (legacy без ширины — только при 512), ленивая
  генерация через `MediaRunner` (видео — кадр на 1 с или 10 % длительности), `THUMBNAIL_MAX_WIDTH`
  512/quality 4/кап 4 МиБ; `image`/`video` — кадр, `audio`/`file`/`pdf` — `none`. Метаданные
  `thumb {status,width,height}` — аддитивное поле sidecar (best-effort); при выключенном
  `attachments.thumbnail.enabled` существующие файлы отдаются, новые не создаются.
  **Длительность видео** (`video`): sidecar → вход вызывающего → проба `ffmpeg -i` без выхода
  (`parseFfmpegDurationMs` — `Duration: HH:MM:SS.xx` из stderr; ffmpeg завершается ошибкой — это
  норма). Кладётся в sidecar аддитивно (рядом с `thumb`, существующее значение не перезаписывается)
  → `AttachmentService.resolve` отдаёт её в сжатие (адаптивный битрейт) и в извлечение кадров.
  Ошибка/нет `Duration` → поле не пишется (ход не падает).
- **Сжатие (`compress.ts`, проводка в `hydrate.ts`).** Только на границе отправки (оригинал в blob
  не меняется): `resolveCompressTarget` по MIME и `attachments.compression`, кэш
  `attachments/.derived/compress/<sha256>_<profile>.<ext>`, `MAX_COMPRESSED_BYTES` 32 МиБ;
  форматы — PNG→PNG, прочее→JPEG, video→MP4 H.264/AAC (только при
  `compatibility.supportsNativeVideo`), audio→mp3/wav (`resolveNativeAudioFormat` по списку
  `compatibility.nativeAudioFormats`, `null` — не сжимать);
  **видео — адаптивный битрейт** (`resolveVideoBitrateKbps`): длительность (из sidecar,
  `HydrateOptions.compress` → `meta.durationMs`) → `floor(MAX_NATIVE_VIDEO_BYTES * 8 / 1000 /
  секунды) - audioBitrateKbps`, ограничен настройкой `compression.video.bitrateKbps` сверху и
  `MIN_VIDEO_BITRATE_KBPS` (300) снизу; без длительности — прежнее поведение (битрейт из настроек).
  `MAX_NATIVE_VIDEO_BYTES` = 14 МиБ (≈18.7 МиБ base64 — влезает в `MAX_ATTACHMENT_BASE64_BYTES`
  20 МиБ). Профиль кэша включает **вычисленный** битрейт — смена длительности не подменяет кэш;
  сжатая копия не меньше оригинала/ошибка/`no_ffmpeg` → `null` (отправляется оригинал).
- **Медиа-раннер (`engine/media/runner.ts`).** Единственный путь запуска `ffmpeg` (derive, кадры
  видео, транскод аудио, миниатюры, сжатие): inline — `spawn` в `tmpdir()`, remote — через
  `ExecutionPort.execute` с `requires: ['ffmpeg']` в `{workspacesRoot}/.synth-media/<uuid>`;
  `MediaRunResult` типизирован (`no_ffmpeg`/`dependency_missing`/`timeout`/`aborted`/`max_output`/
  `failed`), исключений не бросает, каталог удаляется в `finally`. Капы:
  `MEDIA_FFMPEG_TIMEOUT_MS` 60 c, stdout 32 МиБ / output 64 МиБ. После **жёсткого kill** `finally`
  не выполняется — оставшиеся каталоги `.synth-media/*` убирает `startMediaTempPruner`
  (`engine/media/pruner.ts`, TTL 1 ч, интервал 6 ч, каталог не создаётся).
- **Гидратация (`hydrate.ts`) — граница отправки.** Ссылки → `LLMAttachment[]` только из
  реплик **user** (медиа в assistant — исходящее, провайдеру не идёт и в лимит не попадает);
  порядок исходов: **native** (модальность модели известна и принимается, формат аудио
  поддержан провайдером) → **derive** (назначена aux-модель семейства — в диалог идёт текст) →
  **drop** (`reason: modality|limit|unavailable`). Для **аудио** при заданной
  `attachments.modalityModels.audio` derive идёт **до** native (явный выбор модели обработки
  важнее нативного пути — голосовые контейнеры слишком разнородны). `canDeliverNative` — по полям
  слоя совместимости: `compatibility.nativeAudioFormats` (список `wav`/`mp3`/`ogg`) и
  `compatibility.supportsNativeVideo`: провайдер может не уметь контейнер, хотя
  модальность в каталоге есть — тогда derive/drop вместо молчаливой потери. Дефолт — эвристика по
  типу протокола и RouterAI-совместимому хосту (ADR-117): OpenAI-протокол — wav/mp3 (`+ogg` у
  RouterAI), видео — только у RouterAI-совместимых хостов; Anthropic-протокол — только wav и только
  у RouterAI (официальный Anthropic аудио не принимает, Anthropic-совместимый RouterAI ogg/mp3 не
  слышит; видео — нет). Явные значения перекрывают эвристику (пустой список форматов — «ни одного»),
  поэтому не-routerai прокси с нативным видео (`itphx`, живой тест 2026-11-03) задаёт
  `supportsNativeVideo: true` явно.
  Модальности **неизвестны** — фильтра нет (вложение уходит как есть: тихая потеря запрещена).
  Модель с `video`, но без `audio`: провайдер доставляет по `video` **только кадры** (аудиодорожка
  не доходит — проверено на RouterAI: `minimax/minimax-m3.1-flash` звука не получает), поэтому
  дорожка извлекается `ffmpeg` (`-vn`, wav 16 кГц mono) и уходит aux-модели аудио
  (`attachments.modalityModels.audio`), а её транскрипт дописывается в `content` блоком
  `[video-audio: <name>]` рядом с видео (само видео — нативно). Нет aux/`ffmpeg` — видео нативно
  без транскрипта. Аудио-в-видео (MP4 с чёрным кадром) **не делается**: обход не работал и жёг
  токены на кадры.
  Суммарный base64 ограничен (`MAX_ATTACHMENT_BASE64_BYTES` 20 МиБ, отбрасываются самые старые);
  гидратация трёхфазная: A — метаданные и решения (модальность/derive/compress) без чтения байтов,
  B — base64-бюджет от новых к старым, C — чтение/кодирование только выбранных;
  здесь же `stripMetadata` (JPEG/PNG — EXIF/IPTC/XMP/PNG-текст): в blob лежит **оригинал**,
  очистка — только при отправке провайдеру (и в aux-вызове).
  Отброшенное видно модели блоком `[ATTACHMENTS NOT DELIVERED]`
  (`prompts/system/ATTACHMENTS_DROPPED.{ru,en}.md`, `{model}`/`{modalities}`) — сохранённая
  история не меняется.
- **Материализация (`materialize.ts`).** Отброшенное вложение кладётся в
  `<workspace>/attachments/<name>` (имя санитайзится, публикация атомарная без перезаписи,
  дедуп по содержимому, иначе суффикс `-2`, `-3`), модели сообщается путь; нет workspace/прав —
  `null` (ход не падает). Уборка каталога не автоматизирована.
- **Обработка модальностей (`derive.ts`).** `deriveModalityText`: `image`/`pdf` — как есть,
  `audio` — `wav`/`mp3` как есть либо транскод `ffmpeg` в wav 16 кГц mono, `video` — нативно при
  `compatibility.supportsNativeVideo` либо кадры (до 5) через `ffmpeg`; `deriveVideoAudioText` —
  транскрипт аудиодорожки
  видео для модели с `video` без `audio` (`-vn` + aux-модель аудио, отдельное семейство кэша
  `video-audio`); производные объекты и кэш — в `attachments/.derived/`
  (ключ `sha256(blobPath|provider/model|family)`); вызов — только через `GatewayProvider`;
  ошибка/пустой ответ → обычный отброс/прежнее поведение (исключений не бросает). `ffmpeg` —
  внешняя зависимость (`isFfmpegAvailable` через порт исполнения, ADR-078), нет — `no_ffmpeg`.
  Модель сессии не меняется; расход aux-вызова — отдельная запись аналитики по её осям.
- **HTTP.** Загрузка в сессию — `POST /sessions/:id/attachments` (multipart `file`; при
  не-multipart `Content-Type` — raw-body; крупное — chunked `…/attachments/uploads`), раздача —
  `GET /sessions/:id/attachments/:partId` (доступ решает prefix-guard; `?variant=thumb` —
  миниатюра, `404` если её нет); **staging без сессии** — `POST /api/v2/attachments` (те же режимы
  загрузки) и раздача по `GET /api/v2/attachments/:sha256` (шлюзы/пайплайны; объект без ссылок
  живёт `attachments.gcDays`); `attachments: string[]` в `POST /prompt` добавляет медиа-части.
  Лимиты — `attachments.*` (`maxChunkBytes` — только chunked; `maxActiveUploads*` — число активных
  сессий загрузки), нарушение → `413`/`415` (невалидный `size` — `400`).
- **События и прогоны.** Вложения внешнего события проверяются `EventIngress` (dedupKey
  обязателен); вложения прогона пайплайна — `engine/pipelines/attachments.ts` (вход, маппинг,
  `prev.artifacts`). Подробности — в «Карте модулей».
- **Метрики** — `synth_attachment_*` (загрузки/выдачи/GC; ADR-094: имена и лейблы — контракт).

## MCP

- Транспорты: stdio (`StdioClientTransport`) и Streamable HTTP
  (`StreamableHTTPClientTransport`) — `engine/mcp/client.ts`. ADR-090: `config.headers`
  пробрасываются в HTTP-транспорт (`requestInit: { headers }`) — auth/tenant-заголовки.
- Лимиты: connect 60 c; tool timeout 120 c (`config.timeout`, мс); результат
  усечён до 30 000 символов (`MAX_TOOL_RESULT`).
- **Вложения результата (ADR-115 × ADR-077, протокол исполнителя 5).** MCP отдаёт результат
  блоками: `text`, `image`, `audio`, `resource` (`{uri, mimeType, blob|text}`). Раньше брался
  только `text` — скриншоты Playwright и бинарные ресурсы выбрасывались молча. Теперь
  нетекстовые блоки идут в `McpToolResult.attachments` (base64 без `data:`-префикса), а
  `McpManager` пишет их в blob через `AttachmentService.upload` и возвращает
  `ToolResult.attachments` ссылками — дальше работает штатный шов оркестратора
  (`_injectToolAttachments`), блобы пишет только control plane. Капы здесь **транспортные**
  (25 МиБ/файл, 20 МиБ/вызов, `MCP_ATTACHMENT_MAX_*`); истинный лимит файла — конфиг
  `attachments.maxBytesPerFile`. Битый base64/превышение капа → блок пропускается, вызов не
  падает; `isError` → вложений нет. Инструмент, вернувший **только** вложения, получает
  текстовую заглушку-счётчик (`mcpAttachmentsOnlyText`, пока литеральная строка — ключ
  `tool.mcp_attachments_only` зарезервирован в комментарии). Текст результата по-прежнему
  проходит матрицу доверия/IPI, а байты — нет (как пользовательские вложения).
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
- Не писать байты вложений в blob мимо `AttachmentService`: он один делает MIME по сигнатуре, лимиты `attachments.*`, allowlist префиксов, запрет SVG и content-addressed путь с sidecar (ADR-115).
- Не обходить `blob_refs`: у каждого объекта-ссылки есть владелец (`message`/`pipeline-run`/`skill`/`process`); объект без ссылок уходит в GC через `attachments.gcDays` — «забытая» ссылка = потеря файла.
- Не ждать от guard/обфускации/сканера эффекта на бинарных вложениях: они работают только с текстом (`content`/`systemPrompt`/`tools`); метаданные (EXIF/IPTC/PNG-текст) срезает `stripMetadata` **на границе отправки** провайдеру, в blob лежит оригинал (ADR-115 §«Приватность»).
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
| Вложения сообщений (медиа-части, гидратация, лимиты) | ADR-115 |
| Blob-порты на томе, `blob_refs`, блоб-том | ADR-116 |
