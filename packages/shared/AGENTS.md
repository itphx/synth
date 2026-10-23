# @itphx/synth-shared

> Точечные правила пакета. Слои, инварианты и команды — в корневом [AGENTS.md](../../AGENTS.md);
> конфиг — [ADR-023](../../docs/arch_decisions/adr-023-configuration.md), i18n — [ADR-041](../../docs/arch_decisions/adr-041-llm-error-taxonomy.md) (здесь не дублируются).

## Граница пакета

`@itphx/synth-shared` — контракты и межупаковочная инфраструктура для всех пакетов,
**без бизнес-логики движка** (сессии, LLM, MCP, permissions — в core).
- Содержит: типы, интерфейсы, Zod-схемы, протоколы, i18n-словарь, конфиг-лоадер и общие утилиты.
- Рантайм здесь только инфраструктурный: `atomicWrite`, `AsyncLock`, `generateId`,
  `pickLocalized` (`src/utils/index.ts`); `loadConfig`/`ensureDataDir` (`src/config/`).
  Бизнес-правила сюда не переезжают.
- Зависимости минимальны и осознанны: `zod`, `js-yaml`; `node:*` — только в
  `src/config/` (см. «Публичная поверхность»).

## Публичная поверхность

Публикуется 9 subpath-export'ами (`package.json`): `.`, `./version`, `./types`,
`./interfaces`, `./schemas`, `./protocols`, `./utils`, `./config`, `./i18n`.
- Новый публичный модуль = subpath-export в `package.json` + (для root-части)
  экспорт из `src/index.ts`; внутренние `src/...` наружу не торчат.
- **Browser-safety**: `./config` тянет `node:fs`/`node:path` — только Node-потребители.
  UI импортирует ровно `.`, `./i18n`, `./version`; брать `./config` в UI нельзя.

## Конфигурация

`src/config/`: `types.ts` (Zod-схема + `SynthConfig`), `defaults.ts`
(`defaultConfig`), `merge.ts` (`deepMerge`), `loader.ts` (`loadConfig`, приоритет
defaults ← yaml ← overrides), `resolve.ts` (env-резолверы, `ensureDataDir`).
- **Добавление поля = `types.ts` + `defaults.ts` + тест** (`defaults.test.ts`).
- Читать только через `@itphx/synth-shared/config` (корневой инвариант 10).
- ADR-046: секции `skills` (`paths`/`trustedProjectDirs`/`inlineShell`/`toolsets`) и
  `commands` (`paths`/`bundlesPath`/`conflict`/лимиты); типы команд/бандлов —
  `src/types/commands.ts`, Zod — `schemas` (`skillBundleSchema`, session/project/settings-skills).
- Скоп/уровни (ADR-046 / ADR-071 §2.4): `ProjectSkillSettings`/`ProjectMcpSettings`
  (`enabled` — hard-gate, `defaultOn` — сид новых сессий), `SessionSettings.skillsDefaultOn`/
  `mcpDefaultOn` (снапшот-дефолты), `McpRegistryEntry.enabled` (мастер hard-gate) +
  `enabledByDefault` (дефолт новых проектов); Zod — `skillsSystemSettingsSchema`
  (`disabled`/`disabledForNewProjects`/`policy`), `projectSkillUpdateSchema`/`sessionSkillUpdateSchema`.
- ADR-076: `security.secretKey` (мастер-ключ секретов at-rest; env `SYNTH_SECRET_KEY`,
  резолвер `resolveSecretKey`, пусто — файл `{dataDir}/secrets/master.key`); типы
  `GitRepoConfig` (реестр, `path` обязателен) и `SSHKey`/`SSHKeyMeta` (`agentIds: string[]`),
  `gitRepoConfigSchema`/`normalizeGitRepoConfig` (legacy `repos`) и `sshKeyCreate/UpdateSchema`;
  i18n-ключ `sshkey.env_failed` (сбой подготовки SSH-окружения/askpass).
- ADR-052/O1: `security.bootstrapServiceKeys` (installer service-key'и:
  `label`/`secret`/`scopes`/`roles?`/`description?`; Zod `bootstrapServiceKeySchema`/
  `bootstrapServiceKeysSchema`); объектный env-оверрайд `SYNTH_BOOTSTRAP_SERVICE_KEYS`
  (JSON) — `applyObjectEnvOverrides` (`src/config/env-overrides.ts`), приоритетнее
  config.yaml, невалидное значение → warn + игнор (fail-soft).
- ADR-079: `resolveHome(explicitHome?, env?)` (env `SYNTH_HOME`); home-параметр
  (`home?`) у резолверов путей (`resolveDataDir`, `resolveWorkspacesRoot`,
  `resolveDefaultWorkspace`, `findConfigPath`, `defaultConfigPath`, `ensureFirstRun`)
  и новые `resolveProfilesPath`/`resolveCredentialsPath`; `loader.home` — при home
  конфиг читается строго из `<home>/config.yaml` (без отката к XDG).
- ADR-089: секция `events` (`enabled`/`defaultMode`/`ephemeralTtl`/
  `journalRetentionDays`/`allowedSources`/`dedupStore`/`unknownAgentTemplate`/
  `keyRateLimitPerMinute`/`decisionRouting`/`autoBind`/`autoBindAgentTemplate`/`identityMap`). ADR-051/ADR-089: секция
  `scheduler` (`enabled`/`tickSec`/`catchUp`/`jobRetentionDays`/`leaderElection`/
  `crossProcessLocks`); file-based флаги (`dedupStore: file`, `leaderElection: file`,
  `crossProcessLocks`) — default OFF, поведение single-process не меняют.
- ADR-052 (этап II): секция `webhooks` (`enabled` (default `false`)/`maxAttempts`/
  `timeoutMs`/`allowPrivateTargets`/`deliveryRetentionDays`; `webhooksConfigSchema` +
  `WebhooksConfig`) — исходящие webhooks: параметры доставки, retry и SSRF-политики.
- ADR-084: секция `decision` (`enabled`/`provider`/`model`/`confidenceThreshold`/
  `escalationProvider`/`escalationModel`; `decisionConfigSchema` + `DecisionConfig`);
  `provider` — имя провайдера decision-протокола (тип `decision`/`systemone`),
  `escalationProvider`/`escalationModel` — необязательный точный тир на эскалацию
  (пусто — эскалации нет), env-резолверы `SYNTH_DECISION_PROVIDER`/`SYNTH_DECISION_MODEL`;
  поле `events.decisionRouting` (decision-маршрутизация внешних событий, default `false`, ADR-084 × ADR-089).
- ADR-102: секция `analytics` (`retentionDays`, default `400`; `<= 0` — хранение без
  ограничения; `analyticsConfigSchema` + `AnalyticsConfig`), скалярный env-оверрайд
  `SYNTH_ANALYTICS_RETENTION_DAYS` по общему правилу секций.
- ADR-094: секция `metrics` (`enabled`, default `false`; `metricsConfigSchema` + `MetricsConfig`) —
  мастер-выключатель `GET /metrics`; скалярный env-оверрайд `SYNTH_METRICS_ENABLED` (имя намеренно
  совпадает с Helm-чартом). Токен в схеме **не хранится** (инвариант 13): env `SYNTH_METRICS_TOKEN` /
  `{dataDir}/secrets/metrics-token` резолвит core (`metrics/token.ts`). Тесты — `defaults.test.ts`
  (default `false`), `env-overrides.test.ts` (имя и применение), `types.test.ts` (схема).
- PROP-090 §10: секция `plugins` (`pluginsConfigSchema` + `PluginsConfig`) — политики слоя плагинов:
  `enabled` (default `true`), `runtimeInstall` (`allow|deny`, default `deny`), `trustFloor`
  (уровень доверия, default `trusted`), `scan` (`enabled|disabled`, default `enabled`),
  `allowlist`/`denylist`/`remoteAllowlist` (списки имён, default `[]`), `exactHostExceptions`
  (путь к файлу точных исключений семвер-гейта, default `''`), `promptBlockMaxChars`
  (бюджет символов на блок промпта от плагина, default `4000`), `llmFilterTimeoutMs`
  (бюджет времени на один вызов фильтра LLM-вызовов, мс; default — `DEFAULT_LLM_FILTER_TIMEOUT_MS`
  = `1000` из `types/llm-filters.ts`, PROP-090 §«Точка `llmFilters`», Ф3б), `executionEnabled`
  (**главный переключатель исполнения кода плагинов**, default `false` — без него загрузчик
  останавливается на шаге `import`, PROP-090 §10/Ф1); скалярные env-оверрайды
  `SYNTH_PLUGINS_*` (`enabled`/`runtimeInstall`/`trustFloor`/`scan`/`exactHostExceptions`/
  `promptBlockMaxChars`/`llmFilterTimeoutMs`/`executionEnabled`) — списки остаются в `config.yaml`. Runtime-override в core —
  `RuntimeSettings.plugins` + `mergePluginsConfig` (приоритет runtime > config > defaults).
- **Env-оверрайды скалярных ключей секций** `events`/`scheduler`/`webhooks`/`decision`/`analytics`/`metrics`/`plugins` —
  реестр `ENV_OVERRIDES` (`src/config/env-overrides.ts`), применяется в `loadConfig`;
  имя `SYNTH_<SECTION>_<KEY>` (camelCase→SNAKE_CASE), невалидное значение → warn + игнор;
  приоритет `CLI > env > config.yaml > defaults` (ADR-023). Объектные/нескалярные ключи
  (`events.identityMap`, `events.dedupStore`, `mcp.servers`, `plugins.allowlist`/`denylist`/`remoteAllowlist`, …)
  остаются в config.yaml.
- ADR-077: секция `execution` — **переключатель топологии исполнения** (`mode`:
  `inline`|`remote`; `remote.url`/`remote.timeoutMs`/`remote.concurrency`/`remote.failMode`/
  `remote.tokenSecret`); Zod `executionConfigSchema` + `ExecutionConfig`/`ExecutionMode`/
  `ExecutionFailMode` (`config/types.ts`), дефолты — `config/defaults.ts`, резолвер
  `resolveExecutionConfig`/`resolveExecutionMode` (`config/execution.ts`). Env (ровно эти):
  `SYNTH_EXECUTION_MODE`, `SYNTH_EXECUTION_REMOTE_URL` (список через запятую),
  `SYNTH_EXECUTION_TOKEN` (путь/ссылка на токен, НЕ значение — инвариант 13),
  `SYNTH_EXECUTION_TIMEOUT_MS`, `SYNTH_EXECUTION_CONCURRENCY`, `SYNTH_EXECUTION_FAIL_MODE`;
  CLI `--execution-mode` (core `main.ts`). Приоритет — CLI > env > config.yaml > дефолт
  (ADR-023); **fail-closed** на неизвестном `mode`/`failMode` (как `storage.backend`);
  `remote.concurrency` по умолчанию — число CPU процесса. Секция — **параметр запуска**
  (инвариант 24): смена режима — только рестартом.
- ADR-096/ADR-097 (слой хранения): секция `storage` — `backend`
  (`file`|`memory`|`postgres`, резолвер `resolveStorageBackend` + env
  `SYNTH_STORAGE_BACKEND`, **fail-closed** на неизвестном явном значении), `postgres`
  (`dsn`/`host`/`port`/`database`/`user`/`schema`/`sslmode`/`ssl`/`poolMax`, резолвер
  `resolvePostgresConfig` + env `SYNTH_POSTGRES_*`, `sslmode` — env
  `SYNTH_POSTGRES_SSLMODE`), задел деградации `degradedMode` (`fallback-file`|`halt`,
  `resolveDegradedMode`) / `fallbackDir` (`resolveStorageFallbackDir`). Пароль БД в схеме
  **не хранится** (инвариант 13) — `resolvePostgresPassword` (env `SYNTH_POSTGRES_PASSWORD`
  → файл `{dataDir}/secrets/postgres-password`).
- ADR-099 (единый механизм доверия TLS/CA): секция `security.tls` (`caFile`/`caPem`/
  `certFile`/`keyFile`/`rejectUnauthorized`; взаимоисключение `caFile`↔`caPem`, fail-closed
  на битый/нечитаемый PEM) — типы `SecurityTlsConfig` (`config/types.ts`) и резолверы
  `resolveTlsConfig`/`resolveTlsTrust` + `isPemContent`, env-имена `TLS_ENV` (`SYNTH_TLS_CA_FILE`/
  `SYNTH_TLS_CA_PEM`/`SYNTH_TLS_CERT_FILE`/`SYNTH_TLS_KEY_FILE`/`SYNTH_TLS_REJECT_UNAUTHORIZED`)
  в `config/tls.ts`. Резолверы хранят только **чтение/валидацию** конфига — построение
  undici-dispatcher и применение к запросам живут в core (`security/tls.ts`). Там же — TLS-опции
  PostgreSQL (ADR-099 × ADR-097): `normalizePostgresSslMode` (`disable`/`require`/`verify-full`,
  алиас `verify-ca`→`verify-full`), `buildPostgresSslOptions` (sslmode + CA/mTLS из `security.tls`;
  **fail-closed** `verify-full` без CA) и `findDsnTlsParams`/`DSN_TLS_PARAMS` — **TLS-параметры в
  DSN запрещены** (`pg` накладывает DSN `Object.assign`-ом поверх конфига и молча перекрывает `ssl`).
- ADR-099 (TLS runtime): `config/tls-runtime.ts` — bootstrap `security-tls.json`
  (`readTlsRuntimeSettings`/`writeTlsRuntimeSettings`, `writeTlsSecretFile`, каталог `secrets/tls/`,
  0600/0700, атомарно); `config/tls.ts` — `TlsRuntimeSettings`/`TlsMappingSettings`,
  `resolveTlsProfiles` (приоритет env > runtime > config, read-only-источники, fail-closed на неполную
  пару/`caFile`+`caPem`), `selectTlsClientProfile`/`matchTlsHostPattern` (exact/`*.suffix`/`*`, первое
  совпадение, default fallback), `resolveTlsTrust`/`buildPostgresSslOptions` с `runtime`.

## Схемы и типы

`src/types/index.ts` + `src/schemas/index.ts` — единые контракты сущностей; схемы `projectCreate/Update`, `sessionCreate/Update`.
- ADR-046: `src/skills/frontmatter.ts` — толерантный `parseFrontmatter`/`stringifyFrontmatter` формата `SKILL.md` (js-yaml; невалидный YAML → `issues`, не throw; неизвестные ключи сохраняются в `SkillMeta.extra`); типы скиллов — `src/types/skills.ts` (`SkillScope`/`SkillLevel`/`SkillInvocation`/`SkillMeta`/`SkillSummary`/`SkillDetail`/`SkillDiagnostic`, `requires_capabilities`/`requires_toolsets`).
- `EventType` включает `fs.changed` (мутирующий тул ядра изменил workspace) и `session.moved` (перенос сессии между проектами); потребители — `transportStore` UI (ADR-024). ADR-101: типы событий движка пайплайнов — `pipeline.run.started`/`node_started`/`node_finished`/`awaiting_human`/`finished`/`failed` и `pipeline.completed` (выход `gateway`) в `types/bus-events.ts`; это **инстансные** события (прогон — не сессия) — публикуются в инстансный канал шины, новых транспортных каналов нет.
- ADR-101: **движок пайплайнов** — `src/types/pipeline-engine.ts` (re-export из `src/types/index.ts`): `PipelineMode` (`plan`/`act`/`yolo`, `PIPELINE_MODES`), `PipelineNodeKind` (`agent`/`script`/`tool`/`human`), `PipelineExitKind` (`session`/`file`/`gateway`/`none`), `PipelineConditionOp` (`eq`/`ne`/`in`/`exists`/`gt`/`lt`), `PipelineCondition`, `PipelineTransition`, `PipelineNode`, `PipelineExit`, `PipelineSpec` (`id`/`name`/`version`/`status`/`mode`/`projectId?`/`io?`/`vars?`/`nodes`/`exits`), `PipelineRunTrigger` (`kind` = `user|gateway|schedule|tool|webhook|manual`, `source?`/`type?`/`payload?`/`dedupKey?`), `StepResult`, `PipelineRunStatus`, `PipelineRun`, `PipelineRunEventType`/`PipelineRunEvent` и `validatePipelineSpec(spec)` — валидатор графа (проблемы **строками**, без throw). Zod — `pipelineModeSchema`/`pipelineNodeKindSchema`/`pipelineExitKindSchema`/`pipelineConditionOpSchema`/`jsonSchemaLikeSchema`/`pipelineConditionSchema`/`pipelineSpecEdgeSchema`/`pipelineSpecNodeSchema`/`pipelineExitSchema`/`pipelineSpecSchema`/`pipelineRunTriggerSchema`/`pipelineStepResultSchema`/`pipelineRunStatusSchema`/`pipelineRunSchema`/`pipelineRunEventTypeSchema`/`pipelineRunEventSchema`. Имя `PipelineTrigger` занято legacy-контрактом ADR-100 (`types/pipeline.ts`) — не путать.
- ADR-101: **i18n-ключи движка пайплайнов** — `src/i18n/index.ts`: `ENGINE_MESSAGE_KEYS` дополнены префиксом `pipeline.*` (`not_found`, `not_published`, `invalid_spec`, `loop_limit`, `cancelled`, `executor_missing`, `gate_rejected`, `gate_timeout`, `step_failed`, `step_timeout`, `run_not_found`, `invalid_state`, `tool_not_found`, `tool_failed`, `script_failed`, `script_no_command`, `permission_denied`, `agent_unavailable`, `provider_not_found`, `llm_failed`, `llm_unrecoverable`) с параметрами в `ENGINE_MESSAGE_PARAMS` (ADR-041: строки движка — только через ключи `shared/i18n`).
- ADR-030/ADR-089: хуки — `HookName`/`HookMode`/`HookResult`/`HookContextMap` (`types/hooks.ts`), плюс
  `MessageReceivedKind` (`user`/`scheduler`/`external`) и контексты `message_received`/`schedule_fired`
  без текста сообщения/задания (PROP-090 Ф0); события — `SynthEvent`/`EventBinding`/`RouteDecision`/`SessionRequest`/`EventMode`/`EventDeliveryMode` и правила `EventRouteRule`/`EventRouteTarget`/`EventRouteMatch` (`types/events.ts`); Zod `synthEventSchema`, `eventBindingSchema`, `sessionRequestSchema`, `eventIngestSchema`, `eventBindingInputSchema`, `eventRouteRuleSchema`/`eventRouteRuleInputSchema`/`eventRouteRuleUpsertSchema`/`eventRouteTargetSchema`/`eventRouteMatchSchema`. Поля `Session.expiresAt`/`archivedAt` — ephemeral TTL/архив (ADR-089).
- ADR-089/ADR-052: API-ключи привязок — типы `EventBindingApiKey` (поля `label` (обязательная, уникальная глобально по инстансу)/`description?`/`rateLimitPerMinute?`/`createdBy`/`prefix`/`lastUsedAt?`, `expiresAt?`/`revokedAt?`) и `EventBindingApiKeyCreated` (+ `key` — plaintext единожды), `EventKeyCredential` (в core); Zod `eventBindingApiKeySchema`/`eventBindingApiKeyCreateSchema` (`{label, description?, expiresAt?, rateLimitPerMinute?}`)/`eventBindingApiKeyUpdateSchema` (`null` — сброс поля)/`eventBindingApiKeyCreatedSchema` и `eventKeyIngestSchema` (`eventIngestSchema.partial({ source: true })` — приём по ключу).
- ADR-052 (этап I): **service-key** — тип `ServiceApiKey` (`id` `svk_<uuid>`/`label`/`description?`/`roles: GlobalRole[]`/`scopes: string[]`/`allowedProjects?: string[]`/`rateLimitPerMinute?`/`expiresAt?`/`revokedAt?`/`createdBy`/`createdAt`/`lastUsedAt?`/`prefix`) и `ServiceApiKeyCreated` (+ `key` — plaintext единожды) (`types/service-keys.ts`, re-export из `types`); входные `CreateServiceApiKeyInput`/`UpdateServiceApiKeyPatch` (`null` — сброс поля). Реестры/матчер: `SERVICE_SCOPES` (точечные scope'ы, включая зонтичный `automation:install` — установщик пакетов расширений: агенты и их ролевые промпты, пайплайны, порождаемые пакетом правила маршрутизации и расписания), `SERVICE_SCOPE_FAMILIES` (wildcard-семейства, глобального `*` нет; `automation` в семейства **не** входит), `isKnownScope`/`hasServiceScope`, `SERVICE_SCOPE_SETS` (наборы «достаточно любого из»: `routesWrite`/`schedulesWrite`/`agentsWrite`) и матчер `hasAnyServiceScope`. Zod — `serviceApiKeySchema`/`serviceApiKeyCreateSchema`/`serviceApiKeyUpdateSchema`/`serviceApiKeyCreatedSchema` (валидация scope/role).
- PROP-107 (Ф0): **внешние доступы** (OAuth-креды к коннекторам) — тип `ExternalCredential` (`id`/`provider`/`connectorId?`/`clientId`/`scopes`/`owner {kind: user|instance|local, id}`/`projectId?`/`secretEnc`/`refreshEnc?`/`status: active|expired|revoked|error`/`expiresAt?`/`revokedAt?`/`createdBy`/`createdAt`/`lastUsedAt?`/`scopesGranted?`) и **метаданные без секрета** `ExternalCredentialMeta` (те же поля + `secretMask` + `hasRefreshToken`), входные `CreateExternalCredentialInput`/`UpdateExternalCredentialTokensInput`, фильтр `ExternalCredentialFilter` (`types/external-credentials.ts`, re-export из `types`); маппер `toExternalCredentialMeta` и маска `maskExternalSecret` (необратимая сводка шифротекста — значение токена наружу не отдаётся). Zod — `externalCredentialSchema`/`externalCredentialMetaSchema`/`externalCredentialOwnerSchema`/`externalCredentialStatusSchema`/`createExternalCredentialInputSchema`/`updateExternalCredentialTokensSchema`. Ссылка коннектора на доступ — `mcpServerAuthSchema` (`{kind:'credential', credentialId}`) в `mcpServerConfigSchema` (`config/types.ts`) — аддитивно, старые записи без `auth` валидны.
- ADR-052 (этап II): **webhooks** — типы `WebhookSubscription` (`id` `whk_<uuid>`/`label` (уникальна)/`description?`/`url`/`events: string[]`/`enabled`/`secretPrefix`/`createdBy`/`createdAt`/`lastDeliveryAt?`/`lastStatus?`/`disabledAt?`) и `WebhookSubscriptionCreated` (+ `secret` — plaintext единожды), `WebhookDelivery` (`whd_<uuid>`/`subscriptionId`/`eventType`/`status`/`attempts`/`responseStatus?`/`error?`/`createdAt`/`completedAt?`), входные `CreateWebhookSubscriptionInput`/`UpdateWebhookSubscriptionPatch` (`types/webhooks.ts`, re-export из `types`); матчер `matchWebhookEvent(patterns, type)` (exact/`prefix.*`, пусто — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), валидатор `isWebhookEventPattern`, префикс `WEBHOOK_SECRET_PREFIX` (`whsec_`). Zod — `webhookSubscriptionSchema`/`webhookSubscriptionCreateSchema`/`webhookSubscriptionUpdateSchema`/`webhookSubscriptionCreatedSchema`/`webhookDeliverySchema`/`webhookEventPatternSchema`/`webhookUrlSchema`.
- ADR-051/ADR-100: **пайплайны** — типы `PipelineStepKind` (`agent`/`loop`), `EventMatch` (сужение
  `eventRouteMatchSchema` до `source`/`type` — триггер шага), `PipelineArtifact` (`kind`/`id?`/`from?`),
  `PipelineStep` (`id`/`kind`/`title?`/`agent?`/`skill?`/`prompt?`/`waitsFor?`/`artifact?`/`timeoutSec?`;
  первый шаг с `waitsFor` — триггер пайплайна, последующие — гейты/HITL), `PipelineErrorPolicy`
  (`fail`/`retry`/`rollback`), `PipelineDefinition` (декларация автомата), `PipelineInstanceStatus`,
  `PipelineStepStatus`, `PipelineStepState`, `PipelineTrigger` и `PipelineInstance` (прогон автомата:
  `pipelineId`/`status`/`trigger?`/`steps`/`currentStep?`/`attempts`) (`types/pipeline.ts`, re-export из
  `types`); Zod — `pipelineStepKindSchema`/`eventMatchSchema`/`pipelineArtifactSchema`/`pipelineStepSchema`/
  `pipelineErrorPolicySchema`/`pipelineDefinitionSchema`/`pipelineInstanceStatusSchema`/`pipelineStepStatusSchema`/
  `pipelineStepStateSchema`/`pipelineTriggerSchema`/`pipelineInstanceSchema`. Ссылка на шаг пайплайна в
  цели правила маршрутизации — `PipelineRef` (`types/events.ts`) + `pipelineRefSchema` (`schemas`).
- ADR-086 §5 / PROP-090 §8: **манифест пакета расширения** (`synth.pack`) — `PackKind`
  (`plugin`/`gateway`/`addon`/`pack`/`storage`), `PackType` (тип контент-пака: `skills`/`agents`/`mcp`/
  `themes`/`i18n`/`providers`/`prompts`/`automation`/`policies`/`memory`/`ui`), `PackMcpProvide`/
  `PackSkillProvide`/`PackAgentProvide`/`PackPipelineProvide` и сводный `PackProvides` (что расширение
  регистрирует: MCP-серверы, скиллы, агенты, пайплайны), `PackManifest`
  (`name`/`version`/`kind`/`host?`/`contracts?`/`description`/`provides`/`packType?`; `packType` обязателен
  для `kind: 'pack'` и запрещён у остальных), матчер `isPackHostRange` и нормализация
  `normalizePackProvides`/`validatePackManifest` (`types/pack.ts`, re-export из `types`); Zod —
  `packKindSchema`/`packTypeSchema`/`packNameSchema`/`packVersionSchema`/`packHostSchema`/
  `packMcpProvideSchema`/`packSkillProvideSchema`/`packAgentProvideSchema`/`packPipelineProvideSchema`/
  `packProvidesSchema`/`packManifestSchema`. Модули browser-safe (`zod` + локальные типы).
- PROP-090 §8/§9: **вклады плагина в манифесте** — `provides.tools[]` (`packToolsProvideSchema`:
  непустые имена, без дублей), `provides.promptBlocks[]` (`packPromptBlockProvideSchema`:
  `{key, tier, order, title?, provenance?}`, `.strict()`; тир **только** `context`/`volatile` —
  `stable` запрещён, граница prompt-cache ADR-070), `provides.llmFilters[]`
  (`packLlmFilterProvideSchema`: `{id, phase, failMode?, timeoutMs?}`, `.strict()`, фазы
  `pre_request`/`post_response`/`embedding`), плюс поля манифеста `mode` (`PACK_PLUGIN_MODES`:
  `inline`/`remote`/`both`, только `kind: 'plugin'`), `permissions` (`packPermissionsSchema`:
  `network`/`secrets`/`tools`/`hooks` — заявление, не разрешение) и `trust` (`packTrustSchema`:
  `{level?, source?}`, заявленный уровень — верхняя граница, выше записи каталога не поднимает).
  `validatePackManifest` — правила 12–14 (вклады плагина по явным схемам; `mode` только у плагина;
  `trust.level` плагина не выше `trusted`). Сверка «объявлено ↔ зарегистрировано» — `diffPackProvides`.
- PROP-090 §«Точка `promptBlocks`» (Ф3а): **контракт провайдера блока системного промпта** —
  `types/prompt-blocks.ts` (browser-safe: только типы и чистые функции; реэкспорт из `types`):
  `PromptBlockProvider` (`key`/`tier`/`order`/`title?`/`load(ctx)`), узкий DTO-контекст
  `PromptBlockContext` (`sessionId`/`agentRole`/`language`/`projectId?`/`mode`/`query?`/`turnId?`/
  `timestamp?` — история сессии наружу не отдаётся) и `PromptBlockContent` (`content`/`provenance?`/
  `status?`); тир провайдера ограничен `context`/`volatile` **на уровне типа**
  (`PROMPT_BLOCK_PROVIDER_TIERS`) — `stable` запрещён (граница prompt-cache, ADR-070 §2.1);
  единый источник истины для бюджета символов блока — `DEFAULT_PROMPT_BLOCK_MAX_CHARS = 4000`
  (совпадает с `plugins.promptBlockMaxChars` в конфиге) и префикс ключа плагинного блока
  `PLUGIN_PROMPT_BLOCK_KEY_PREFIX = 'plugin.'` + хелпер `isPluginPromptBlockKey`.
- PROP-090 §«Точка `llmFilters`» (Ф3б): **контракт фильтра LLM-вызовов** — `types/llm-filters.ts`
  (browser-safe: только типы и чистые функции; реэкспорт из `types`): `LlmCallFilter`
  (`id`/`phase`/`failMode?`/`timeoutMs?`/`inspect(input)`), узкий DTO `LlmFilterInput`
  (`phase`/`provider`/`model`/`sessionId?` + поля по фазе: `messages`/`systemPrompt`/`tools`,
  `content`/`usage`, `texts`), `LlmFilterMessage` (роль + текст + `toolCalls?` — **не** `LLMMessage`
  из core: служебные поля ядра (`branchId`/`pinned`/`usage`) наружу не отдаются) и `LlmFilterVerdict`
  (`allow`/`deny`/`redact` + `reason`/`code`/`redactedContent?`/`redactedTexts?`); перечни
  `LLM_FILTER_PHASES` (`pre_request`/`post_response`/`embedding`), `LLM_FILTER_FAIL_MODES`
  (`open`/`closed`), `LLM_FILTER_VERDICTS` + предикаты; `phaseCanBlock(phase)` — блокировать может
  только `pre_request`/`embedding` (`post_response` — наблюдение, ADR-036); единый источник истины
  бюджета времени — `DEFAULT_LLM_FILTER_TIMEOUT_MS = 1000` (совпадает с `plugins.llmFilterTimeoutMs`).
- PROP-090 §«Точка `tools`» (Ф3в): **namespace инструментов плагина** — `types/plugin-tools.ts`
  (browser-safe: только константы и чистые функции; реэкспорт из `types`):
  `PLUGIN_TOOL_NAME_PREFIX = 'plugin'`, `pluginToolNamespace(name)` (slug имени плагина),
  `pluginToolFullName(plugin, tool)` → `plugin_<ns>_<tool>`, `pluginToolLocalName(full, plugin)`
  (чужой префикс → `undefined`), `PLUGIN_TOOL_LOCAL_NAME_REGEX` и
  `isValidPluginToolLocalName` (локальное имя с префиксом `plugin_` запрещено — иначе сверка
  `provides` неоднозначна). В `types/tools.ts` — `ToolSource` расширен до
  `'builtin' | 'mcp' | 'plugin'`, в `ToolDefinition` — необязательный `pluginName?` (владелец
  плагинного тула); в манифесте (`provides.tools[]`) объявляется **локальное** имя, в реестре
  живёт полное (сверка `diffPackProvides` — по локальным).
- PROP-090 §«out-of-process» (Ф4б-1, точка `tools` — Ф4б-3): **wire-протокол плагина** —
  `types/plugin-protocol.ts`
  (browser-safe: только типы, константы и чистые функции; реэкспорт из `types`; отдельный
  пакет не создаётся): `PLUGIN_PROTOCOL_VERSION = 1`, `PLUGIN_PROTOCOL_PATHS`
  (`/invoke`/`/capabilities`/`/health`), `PLUGIN_PROTOCOL_POINTS`
  (`promptBlocks`/`llmFilters`/`tools`), DTO `PluginCapabilities`
  (`protocol`/`name`/`version`/`points`), `PluginInvokeRequest` (`protocol`/`point`/`id`/`input`),
  `PluginInvokeResponse` (`{ok:true,output}` | `{ok:false,error}`), `PluginProtocolError`; перечень
  `PLUGIN_PROTOCOL_ERROR_REASONS` (`invalid_request`/`unknown_point`/`unknown_id`/
  `unauthorized`/`timeout`/`internal_error`/`protocol_mismatch`) и `PLUGIN_PROTOCOL_ERROR_STATUS`
  (как в исполнителе: 400/401/404/500), предикаты `isPluginProtocolErrorReason`/
  `isPluginProtocolPoint`, проверка ответа `/capabilities` — `checkPluginCapabilities`
  (версия протокола + имя/версия плагина + валидация точек: тир `stable` запрещён, фазы
  фильтров из `LLM_FILTER_PHASES`, дубли ключей/id — отказ) и
  `PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS = 64 КиБ` (предел содержимого блока на проводе) +
  `isPluginPromptBlockStatus`.
- PROP-090 §«Точка `tools`» (Ф4б-3): **инструмент в протоколе** — `PluginCapabilitiesTool`
  (`name` — локальное, без namespace; `description`; `parameters?` — JSON-Schema для модели;
  **обязательные** `capabilities: ToolCapability[]` — иначе тул невидим permission-слою и
  admin-отключению) и `PluginCapabilities.points.tools?`. Валидация в `checkPluginCapabilities`:
  непустые `name`/`description`, `parameters` — объект, `capabilities` непусты и из рантайм-набора
  `ToolCapability` (`types/tools.ts`), дубли локальных имён → `invalid_request`. Вызов —
  `POST /invoke` `{point:'tools', id:'<локальное имя>', input:{parameters, context:{sessionId,
  messageId, workingDir}}}`, ответ `{content: string, isError?: boolean}` (как у MCP-инструментов).
  Namespace `plugin_<ns>_<tool>` составляет **хост** (`types/plugin-tools.ts`), по проводу идёт
  локальное имя — то же, что в `provides.tools[]`.
- PROP-090 §10: **семвер и доверие** — `types/semver.ts`: `SEMVER_RANGE_REGEX`, `isSemverRange`,
  `parseSemver`, `satisfiesSemverRange` (операторы `^`/`~`/`>=`/`<=`/`>`/`<`/`=`, wildcard `x`/`*`,
  конъюнкция пробелом; `||` не поддерживается — fail-closed); `PACK_HOST_RANGE_REGEX` ссылается на
  `SEMVER_RANGE_REGEX`, `contracts` манифеста валидируются тем же матчером; гейт
  `checkExtensionCompatibility` (порядок «контракт → host», вердикты `contract_mismatch`/`host_mismatch`,
  `exactHostExceptions`). `types/trust.ts`: `CATALOG_TRUST_LEVELS`/`catalogTrustLevelSchema`/
  `trustLevelRank` — единый перечень уровней (`builtin`/`verified`/`trusted`/`community`), общий для
  каталога (`types/catalog.ts` реэкспортирует) и манифеста (модуль выделен из-за цикла
  `catalog → pack`).
- PROP-068 §4.4 / PROP-090 §5 (долги Д2): **ступень отката в lock** — `types/plugin-lock.ts`:
  `PluginLockPrevious` (`version`/`content_hash`/`entry?`/`installed_at`) и
  `PluginLockEntry.previous?` — **одна** ступень (откат обратим, «на две версии назад» = два
  `rollback`); при обновлении прежняя запись переезжает в `previous`, при откате — swap.
- PROP-090 §«Managed deploy-time» (Ф5в): ключи секции `plugins` в конфиге — `deployDir` (каталог
  образных бандлов, дефолт `''`), `deployTrust` (доверие образных бандлов, дефолт **`trusted`** —
  образ доверен как образ; ниже `trustFloor` → `plugin.trust_below_floor`), `managedReadonly`
  (management-плагин нельзя снять через API/CLI, дефолт `true`); env-оверрайды
  `SYNTH_PLUGINS_DEPLOY_DIR`/`SYNTH_PLUGINS_DEPLOY_TRUST`/`SYNTH_PLUGINS_MANAGED_READONLY`.
  Новый код отказа `plugin.managed_readonly` (**28** кодов).
- PROP-090 §9: **журнал аудита плагинов** — `types/plugin-audit.ts` (re-export из `types`):
  `PluginAuditEntry` (`id` `pa_<uuid>`/`ts`/`actor`/`scope: 'plugin'`/`action`/`plugin`/`version`/
  `trustLevel?`/`scanVerdict?`/`scanFindings?`/`scanPerformed?`/`contentHash?`/`mode?`/`outcome`/
  `reason?`/`source?`) и перечни `PLUGIN_AUDIT_ACTIONS` (`install`/`activate`/`deactivate`/`uninstall`/
  `scan`/`filter` — `filter` добавлено Ф3б: события решений фильтров LLM-вызовов, `install`/`uninstall` —
  Ф5а: установка и снятие плагина `PluginInstaller`),
  `PLUGIN_AUDIT_OUTCOMES` (`ok`/`rejected`), `PLUGIN_SCAN_VERDICTS` (`safe`/`caution`/`dangerous`),
  `PLUGIN_AUDIT_REASONS` — **закрытый** список **28** кодов отказа (по одному на гейт пайплайна
  активации; Д1 добавил `plugin.source_unavailable` — источник установки недоступен или не прошёл
  проверку целостности: локальный путь/архив, npm без SRI или с несовпадением, URL без pin/с
  несовпадением sha256; Ф2 добавил `plugin.scan_rejected` и `plugin.approval_required`, Ф3а —
  `plugin.scan_disabled_with_execution` (fail-closed: `plugins.scan='disabled'` вместе с
  `plugins.executionEnabled=true`), Ф3б — `plugin.provides_mismatch` (расхождение объявленных
  `provides.promptBlocks[]`/`provides.llmFilters[]` с фактическими регистрациями) и три
  канонических кода фильтров `plugin_filter.denied`/`.deny_downgraded`/`.unavailable`, Ф4а —
  `plugin.module_invalid` (модуль загружен, но не выполнил контракт `PluginModule` — нет `apply`);
  неканонические коды хоста (`allowed`/`timeout`/`error`/`redact_unsupported`/`buffering_required`/
  `redact_invalid`) живут **только** в аудите gateway, в журнал плагинов не попадают; источник
  истины — `PluginHost`, `packages/core/src/engine/plugins/plugin-host.ts`). Журнал **отдельный**:
  `SECURITY_AUDIT_SCOPES` (семантика «изменение политики») не расширяется; секреты в журнал не
  пишутся (инвариант 13).
- PROP-068 §4.2–§4.4 / PROP-090 §5, §9: **контракты сканера и lock-файла плагинов** —
  `types/plugin-scan.ts` (browser-safe: только типы и чистые функции, без `zod` — модуль используется
  и в UI, и в ядре): `PLUGIN_SCAN_CATEGORIES` (6 базовых + `invisible_unicode`), `PLUGIN_SCAN_SEVERITIES`
  (`info`/`low`/`medium`/`high`/`critical`), `PluginScanFinding` (`category`/`severity`/`file`/`line`/
  `description`), границы `severity → verdict` (`PLUGIN_SCAN_SEVERITY_VERDICTS`, `severityToVerdict`,
  `verdictFromFindings` — вердикт = **максимум** severity), квоты (`PLUGIN_SCAN_QUOTAS` —
  50 файлов / 1024 КиБ суммарно / 256 КиБ на файл; `PluginScanQuotas`/`DEFAULT_PLUGIN_SCAN_QUOTAS`) и
  `PLUGIN_SCAN_QUOTA_SEVERITIES` (**какой severity даёт нарушение квоты**: `fileCount`/`totalSize` →
  `medium`, `singleFile` → `high`), матрица install-policy **одной функцией**
  `installPolicyDecision({trust, verdict, kind})` (`INSTALL_POLICY_ACTIONS`, `INSTALL_POLICY_TRUST_LEVELS`,
  `InstallPolicyKind` = `content`|`plugin`; ячейка `kind: 'plugin'`: `safe→allow`, `caution→ask`,
  `dangerous→block`), **версия правил сканера** `PLUGIN_SCAN_RULES_VERSION` (входит в **ключ кэша
  сканов**: при изменении правил старый вердикт из кэша не переиспользуется — идёт пересчёт; любое
  изменение правил сканера **поднимает версию**); `types/plugin-lock.ts` — `PluginLockEntry` (snake_case: `name`, `version`,
  `source`, `identifier?`, `trust_level`, `scan_verdict`, `content_hash`, `ref?`, `entry?`,
  `installed_at`, `updated_at`) и `PluginLockFile` (формат `plugins.lock.json`); `types/plugin-runtime.ts` —
  `PluginRuntimeOverride`/`PluginSettingsFile`/`PLUGIN_SETTINGS_FILE_VERSION` (формат `plugins.json`).
  **Канон значений** (границы `severity → verdict`, квоты, матрица install-policy) — PROP-068 §4.2–§4.3;
  при изменении — правка обоих документов.
- ADR-084: типы decision-моделей — `DecisionQuestion`/`DecisionAnswer` (варианты `noul`/`choice`/`score`),
  `DecisionRequest`/`DecisionResponse`/`DecisionUsage` и медиа-контракт `DecisionMediaInput`
  (`images?`/`videos?`, задел PROP-085) (`types/decision.ts`); Zod
  `decisionQuestionSchema`/`decisionAnswerSchema`/`decisionRequestSchema`/`decisionResponseSchema`;
  per-session флаг `SessionSettings.decisionFirst` (ADR-035).
- ADR-102: типы аналитики — `AnalyticsFamily`/`AnalyticsDimension`/`AnalyticsRollupBucket`/
  `AnalyticsRollupQuery`/`AnalyticsRollupRow`/`AnalyticsReport`/`AnalyticsReportRow`/
  `AnalyticsSummary`/`AnalyticsExportFormat` и реестры `ANALYTICS_FAMILIES`,
  `ANALYTICS_DIMENSIONS`, `ANALYTICS_MEASURES_BY_FAMILY`, `ANALYTICS_DERIVED_MEASURES`
  (`types/analytics.ts`); Zod — `analyticsFamilySchema`/`analyticsDimensionSchema`/
  `analyticsDaySchema`/`analyticsRollupBucketSchema`/`analyticsRollupQuerySchema`/
  `analyticsReportRowSchema`/`analyticsReportSchema`/`analyticsSummarySchema`/
  `analyticsExportFormatSchema`.
- ADR-089: внешняя идентичность профиля — тип `ExternalIdentity` (`provider` (префикс principalId,
  напр. `tg`) / `externalId` (числовой id источника строкой) / `username?`/`displayName?` —
  display-кэш, НЕ ключ / `linkedAt` ISO / `linkedBy?`); `ProfileData.identities?: ExternalIdentity[]`
  (опционально — legacy-профили без поля трактуются как `[]`). Хелперы там же:
  `buildPrincipalId(provider, externalId)` → `` `${provider}:${externalId}` `` и
  `parsePrincipalId(principalId)` → `{provider, externalId} | null` (деление по **первому** `:`;
  без `:`/пустые части → `null`). Интерфейс `ProfileStore` (`interfaces`) расширен
  `findProfileByExternalId(provider, externalId)`, `linkIdentity(userId, identity)` (идемпотентно;
  конфликт с другим профилем → `null`) и `unlinkIdentity(userId, provider, externalId)`.
- Канонические ключи иконок/цветов проекта и сессии: `PROJECT_ICON_KEYS` (37) / `PROJECT_COLOR_KEYS` (16, палитра темы `a1..a16`) + типы `ProjectIconKey`/`ProjectColorKey` (`types`) (включая дефолтные `folder`/`chat`/`cpu`); схемы `projectIconKeySchema`/`projectColorKeySchema` и хелперы `isProjectIconKey`/`isProjectColorKey` (strict) и `normalizeIconKey`/`normalizeColorKey` (только канонические ключи: невалидные значения, в т.ч. старые цветовые алиасы, → `undefined`) (`schemas`). `null`/`undefined` — сброс значения.

## i18n-контракт

`src/i18n/index.ts` — словарь-контракт без текста: `ENGINE_MESSAGE_KEYS`,
`ENGINE_MESSAGE_PARAMS` (плейсхолдеры), `extractParams`; синхронизируется с core
`engine/system-messages.ts` (en) и ui `lib/i18n/messages/ru.ts` (ru).
- ADR-078: ключи `tool.binary_missing` (`{tool}`/`{binary}`) и
  `permission.dep_unavailable` (`{binary}`) — тул недоступен, т.к. в окружении нет
  внешней программы (`git`/`rg`/`sh`).
- ADR-046: `skill.scope_disabled` (`{name}`/`{reason}`) — скилл недоступен по scope
  (причина `system`/`project`/`session`).
- ADR-030/ADR-089: `event.ingested`, `event.routed.*`, `event.binding.not_found`,
  `event.source_not_allowed`, `event.duplicate`, `hook.blocked`.
- ADR-077: `execution.remote_url_required`, `execution.remote_unavailable` (`{reason}`) —
  fail-closed на старте при `execution.mode=remote` (удалённый исполнитель — шаг 7b плана
  ADR-077: пакет исполнителя недоступен / токен не читается).

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest), сборка — `tsc`.
- После правки публичной поверхности — `pnpm --filter @itphx/synth-shared build`,
  иначе typecheck зависимых пакетов не увидит типы (см. корневой «GitVerse CI»).
