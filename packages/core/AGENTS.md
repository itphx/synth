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
  `connect`, `project publish|fork`, `config`, `session`, `audit`, `update`).
  Публичный CLI `synth` — это пакет `@itphx/synth`, не core.

## Инварианты core

- Публичные точки входа: `createStandaloneApp()` (`server/app.ts`),
  `createToolRegistry()` (`engine/tools/index.ts`), `createAgentRegistry()`
  (`engine/agents/index.ts`), `FileStore`/`JsonStore`/`ProjectStore`/
  `FileProfileStore`/`RuntimeSettingsStore`/`SSHKeyStore`/`ServiceApiKeyStore` (`storage/*`), `ChatOrchestrator`
  (`engine/orchestrator.ts`), `SessionManager` (`sessions/manager.ts`),
  `QueueProcessorManager` (`queue/processor.ts`), `EventBus` (`events/bus.ts`).
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
- Permissions и режимы — только через `PermissionEvaluator`
  (`engine/permission/evaluator.ts`): `plan`/`act`/`yolo`,
  `allow`/`deny`/`ask`; не хардкодить проверки в тулах (ADR-025/028/029).
- Хранилище — только через `FileStore`/`JsonStore` (JSON + атомарная запись
  tmp→rename, ADR-005); писать в `$SYNTH_DATA_DIR` в обход API/FileStore нельзя.
- Конфиг — через `@itphx/synth-shared/config` (ADR-023); приоритет
  CLI-флаги > `SYNTH_*` env > config.yaml > defaults.
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
- Машинный доступ внешних сервисов — через **service-key** (ADR-052 этап I): `ServiceApiKeyStore`
  + синтетический пользователь + `scopes`/`allowedProjects`; enforcement — `requireScope`/
  `checkProjectAccess` (`server/service-scope.ts`), **не** через permission-слой тулов (тот
  роль-оси не имеет, ADR-029). Каталог scope включает зонтичный `addons:install` (установка
  аддонов: MCP-реестр/скиллы) и `users:read`. Провижининг installer-ключа — `security.bootstrapServiceKeys`
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

- `main.ts` — CLI/точка входа (`serve`, `chat`, `connect`, `project publish|fork`, `secrets rotate`, …).
- `server/app.ts` — `createStandaloneApp`: Hono, WS, статика UI, provisioning.
  ADR-052 (этап I): глобальный per-key rate limit service-key (`KeyRateLimiter`, fixed
  window 60 c, ключ — `keyId`) — после `requireAuth`, до роутов; `rateLimitPerMinute`
  ключа, 0/не задан — без лимита, превышение → 429 `RATE_LIMITED` (паритет с backend).
  При старте — `applyBootstrapServiceKeys` (ADR-052/O1: installer-ключи из `security.bootstrapServiceKeys`).
- `server/routes/*` — `health`, `hybrid`, `auth`, `sessions`, `messages`, `projects`,
  `project-transfer`, `providers`, `models`, `agents`, `fs`, `queue`, `updates`,
  `settings`, `dictionaries`, `mcp`, `skills`, `commands`, `skill-bundles`,
  `skill-scope`, `git`, `ssh-keys`, `events`, `identities`, `service-keys`, `webhooks`.
- `server/service-scope.ts` — ADR-052 (этап I): enforcement service-key — `requireScope(...)`
  (scope-гейт рядом с `requirePermission`; для интерактивных кред — no-op), `checkProjectAccess`/
  `isProjectAllowed` (проектная проекция `allowedProjects`), `getServiceCredential`
  (`serviceKey` из контекста), типы `ScopeGuardFactory`/`ProjectGuard`.
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
  и проектная проекция через `scopeGuard`/`projectGuard` (core-дефолты — `requireScope`/`checkProjectAccess`).
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
- `engine/orchestrator.ts` — `ChatOrchestrator` (цикл LLM + Tool Use); опциональная зависимость `isCancelRequested` (персистентный флаг сессии) останавливает многоитерационный Tool Use (верх `while (toolIteration < maxIterations)`), когда живой cancelToken недоступен.
- `engine/gateway/*` — `GatewayProvider`, guard'ы, обфускация, аудит, rate limit; `decide()` — не-chat
  decision-вызов (ADR-084: guard/обфускация `state`, тот же `_prepare`/аудит, что у chat-путей).
- `engine/router/*` — routing моделей и micro-model слой (ADR-034/035); decision-слой — `DecisionContentClassifier` (`decision-content-classifier.ts`, ADR-084), `DecisionModel` в `micro/models/` (`kind='decision'`, per-session `decisionFirst`), единый каскад `decision-cascade.ts` (`decideChoiceCascade`: `primary → escalation` по необязательной паре `escalationProvider`/`escalationModel`, fail-safe) и агрегатные метрики `decision-metrics.ts` (синглтон `decisionMetrics`: `calls`/`handled`/`fallback`/`escalated`/`attempts`/`rejected`/`by_model`). Мультимодальный контракт (задел PROP-085): `MicroInput.images`/`videos`, `ClassifyRequest.images`/`videos`, `DecisionProvider.decide(opts.images/videos)` — добавляются в тело запроса только если непусты.
- `engine/permission/*` — permissions; `engine/security/*` — injection/shell/protected paths; слой доступности (`engine/permission/availability.ts`) учитывает причины `dependency` — нет внешней программы тула (`engine/tools/runtime-deps.ts`, ADR-078) — и `workspace` — не задан рабочий каталог проекта для file/shell/git-тулов (`isWorkspaceDependentTool`, ADR-075); `security/crypto.ts` — AES-256-GCM и мастер-ключ секретов, `security/rotate.ts` — ротация мастера (ADR-076).
- `engine/context/*` — `ContextBuilder`, `ContextOptimizer`, `ContextConfig`, интервью (статус — поле `ProfileData.interviewCompleted`; блок `[INTERVIEW]` — только первое сообщение сессии от пользователя при незаполненном профиле и доступном агенту `profile_update`, гейт `interviewEligible`).
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
- `engine/agents/*` — `AgentRegistry`, определения агентов, режимы, нормализация.
- `engine/mcp/*` — `McpClient`/`McpManager`, настройки MCP.
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
  plan, todo, project, task, skill, profile_update); git-тулы принимают необязательный `repo_path`
  (containment внутри `project.workspace`), SSH-окружение — `engine/tools/git-ssh.ts`
  (ADR-076; ошибки — `sshkey.env_failed`). Тулы `task`/`task-resume` собирают промпт
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
  бинарников (`git`/`rg`/`sh`, fail-open, кэш) и карта `TOOL_RUNTIME_DEP`; отсутствие
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
  session-`EventBus`; эмиты `pre_tool_use`/`post_tool_use`/`plan_approved`/
  `permission_denied`/`agent_spawned|completed|failed`/`session_start|end`.
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
  `ProjectRuleProvider` (правила `match` → `target` из `RouteRuleStore`),
  `DecisionRuleProvider` (`decision-rule-provider.ts`, ADR-084: decision-шаг после project-правил при
  `events.decisionRouting`, fail-safe → `null`; на успехе — лог `info('DECISION', …)` с агентом/уверенностью/
  порогом/моделью/latency, промахи — `warning` с latency; мета `confidence`/`signals` уезжает в решение),
  `target-decision.ts` (`decisionFromTarget` — единый маппинг цели, приклеивает `confidence`/`signals`),
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
  через `EventIngress`. Тикер стартует только у лидера (`scheduler.leaderElection`).
- `engine/fs-change.ts` — `resolveFsChange`: классификация мутирующих тулов → событие `fs.changed` (scope `file`/`all`, `workspaceChanged`, `op: 'write'|'delete'|'mkdir'|'move'` для файловых тулов; `move` (`from`/`to`) выделяется из простой `mv`/`git mv` в `execute_shell`, вне workspace/непростая команда → `{scope:'all'}`); read-only → `null` (событие не публикуется).
- `git/*` — `git-service.ts` (clone/init/fetch/remove/log, `simple-git`) и
  `ssh-env.ts` (`GIT_SSH_COMMAND`, temp-ключ `0600`; passphrase — askpass-скрипт
  `0700` + `SSH_ASKPASS_REQUIRE=force`, `env_failed`).
- `storage/*` — `FileStore`, `JsonStore`, `ProjectStore`, `FileProfileStore`
  (профиль владельца; поле `interviewCompleted` + legacy-backfill из `[ИНТЕРВЬЮ]`; ADR-089 —
  `identities: ExternalIdentity[]` в snake_case (`external_id`/`display_name`/`linked_at`/`linked_by`),
  legacy без поля → `[]`, методы `findProfileByExternalId`/`linkIdentity`/`unlinkIdentity`),
  `FileStore.listForUserScope(userId, projectIds)` — «свои + сессии моих проектов» (ADR-089;
  `listForUser` — только свои),
  `FileMutex` (`file-mutex.ts`, ADR-051/ADR-089: `mkdir`-лок + stale takeover для общего
  `dataDir`; `ScheduleStore.crossProcess` сериализует мутации), `RuntimeSettingsStore`
  (`events` + `mergeEventsConfig` — runtime-настройки раздела «События» (включая `identityMap` — **override**
  поверх основного источника — привязок в `ProfileData.identities[]`), ADR-089; `decision` +
  `mergeDecisionConfig` — runtime-настройки decision-слоя, ADR-084, включая `escalationProvider`/`escalationModel`),
  `McpRegistryStore` (единый реестр MCP, ADR-071),
  `SkillStore`, `CommandStore`, `SkillBundleStore` (ADR-046), `SSHKeyStore`
  (`secrets/ssh-keys`, шифрование at-rest, ADR-076),
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
  и `JobStore` (`scheduler/jobs.jsonl`, Job-история, ADR-051);
  `migrations.ts` — идемпотентная разовая миграция снапшотов
  `mcpDefaultOn`/`skillsDefaultOn` (маркер `session-scope-snapshots-v1`).
- `sessions/ephemeral.ts` — ephemeral TTL (ADR-089): `parseTtl`
  (`30s`/`15m`/`24h`/`7d`), `startEphemeralSweeper` (sweep 60 c, unref); поля
  `Session.expiresAt`/`archivedAt`, списки сессий по умолчанию без архива.
- `queue/processor.ts` — `QueueProcessor`/`QueueProcessorManager`; надёжный «Стоп» — `requestStop()` (in-memory запрос: будит backoff, абортит активный LLM-вызов) + `_shouldStop`/`_handleStopRequest` (проверка in-memory запроса и персистентного `status.cancelRequested` на границах цикла, очистка `pendingMessages`, снятие `blocked`/флага и `stream.cancelled` ровно один раз).
- `remote/*` — клиент, сессии, credentials, device-flow, transfer, aggregate, event-bridge.
- `providers/*` — `ProviderFactory`, `BaseProvider`, OpenAI/Anthropic/Ollama/Remote, `DecisionProvider` (ADR-084: типы `decision` (RouterAI, `POST {base}/decisions`) и `systemone` (Ollama, `POST {base}/v1/systemone`) — endpoint выбирается по типу провайдера).
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
- Переиспользуемые фабрики — `createXxxRoutes(auth, deps, opts)` (общие для core и
  backend): `auth` — структурный `{ requireAuth: Middleware }`, совместим с backend
  `AuthKit` без каста (исключение — `createSettingsRoutes` принимает core-`AuthKit`);
  `opts` — guard'ы (`writeGuard`/`detailGuard`/`testGuard`/`canAccess`), `messages`
  (функции `(c) => string`: core — литералы, backend — `t()`), специфичные флаги и
  хуки. Гибридные ветки активны только при переданном optional-dep
  (`getRemoteClient`). Публичные типы — в `src/index.ts`. Существующие фабрики:
  `createSettingsRoutes`, `createDictionaryRoutes`, `createProviderRoutes`,
  `createModelRoutes`, `createSessionRoutes`, `createGitRoutes`,
  `createSshKeyRoutes`, `createAgentSshKeyRoutes`, `createFsRoutes` (project-aware
  FS: плоский root / workspace проекта через `getProjectWorkspace`, ADR-075),
  `createServiceKeyRoutes` (ADR-052 этап I: CRUD service-key, `writeGuard`/`readGuard`/`messages`).
  `createSessionRoutes`/`createEventRoutes`/`createSchedulerRoutes` принимают опции
  `scopeGuard`/`projectGuard` (ADR-052; core-дефолты — `requireScope`/`checkProjectAccess`).
  `createSettingsRoutes` (ADR-089/ADR-084): `GET/PUT/DELETE /settings/events` — runtime-настройки
  раздела «События» (`fallbackEvents` из config, `onEventsChange` — live-применение,
  мутации под `eventsWriteGuard`; core — `requireAuth`, backend — ADMIN) и
  `GET/PUT/DELETE /settings/decision` — runtime-настройки decision-слоя (ADR-084: `fallbackDecision`,
  `onDecisionChange`, мутации под `decisionWriteGuard`), а также `GET /settings/decision/metrics`
  (снимок `decisionMetrics`, `requireAuth`) и `DELETE /settings/decision/metrics` (сброс,
  `decisionWriteGuard`).
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
  (`StreamableHTTPClientTransport`) — `engine/mcp/client.ts`. PROP-090: `config.headers`
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
- Не писать в `$SYNTH_DATA_DIR` в обход `FileStore`/`JsonStore` (ADR-005).
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
