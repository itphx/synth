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
- PROP-102: секция `analytics` (`retentionDays`, default `400`; `<= 0` — хранение без
  ограничения; `analyticsConfigSchema` + `AnalyticsConfig`), скалярный env-оверрайд
  `SYNTH_ANALYTICS_RETENTION_DAYS` по общему правилу секций.
- ADR-094: секция `metrics` (`enabled`, default `false`; `metricsConfigSchema` + `MetricsConfig`) —
  мастер-выключатель `GET /metrics`; скалярный env-оверрайд `SYNTH_METRICS_ENABLED` (имя намеренно
  совпадает с Helm-чартом). Токен в схеме **не хранится** (инвариант 13): env `SYNTH_METRICS_TOKEN` /
  `{dataDir}/secrets/metrics-token` резолвит core (`metrics/token.ts`). Тесты — `defaults.test.ts`
  (default `false`), `env-overrides.test.ts` (имя и применение), `types.test.ts` (схема).
- **Env-оверрайды скалярных ключей секций** `events`/`scheduler`/`webhooks`/`decision`/`analytics`/`metrics` —
  реестр `ENV_OVERRIDES` (`src/config/env-overrides.ts`), применяется в `loadConfig`;
  имя `SYNTH_<SECTION>_<KEY>` (camelCase→SNAKE_CASE), невалидное значение → warn + игнор;
  приоритет `CLI > env > config.yaml > defaults` (ADR-023). Объектные/нескалярные ключи
  (`events.identityMap`, `events.dedupStore`, `mcp.servers`, …) остаются в config.yaml.
- PROP-032 (слой хранения, ADR-096/ADR-097): секция `storage` — `backend`
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
  PostgreSQL (ADR-099 × PROP-032): `normalizePostgresSslMode` (`disable`/`require`/`verify-full`,
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
- ADR-030/ADR-089: хуки — `HookName`/`HookMode`/`HookResult`/`HookContextMap` (`types/hooks.ts`); события — `SynthEvent`/`EventBinding`/`RouteDecision`/`SessionRequest`/`EventMode`/`EventDeliveryMode` и правила `EventRouteRule`/`EventRouteTarget`/`EventRouteMatch` (`types/events.ts`); Zod `synthEventSchema`, `eventBindingSchema`, `sessionRequestSchema`, `eventIngestSchema`, `eventBindingInputSchema`, `eventRouteRuleSchema`/`eventRouteRuleInputSchema`/`eventRouteRuleUpsertSchema`/`eventRouteTargetSchema`/`eventRouteMatchSchema`. Поля `Session.expiresAt`/`archivedAt` — ephemeral TTL/архив (ADR-089).
- ADR-089/ADR-052: API-ключи привязок — типы `EventBindingApiKey` (поля `label` (обязательная, уникальная глобально по инстансу)/`description?`/`rateLimitPerMinute?`/`createdBy`/`prefix`/`lastUsedAt?`, `expiresAt?`/`revokedAt?`) и `EventBindingApiKeyCreated` (+ `key` — plaintext единожды), `EventKeyCredential` (в core); Zod `eventBindingApiKeySchema`/`eventBindingApiKeyCreateSchema` (`{label, description?, expiresAt?, rateLimitPerMinute?}`)/`eventBindingApiKeyUpdateSchema` (`null` — сброс поля)/`eventBindingApiKeyCreatedSchema` и `eventKeyIngestSchema` (`eventIngestSchema.partial({ source: true })` — приём по ключу).
- ADR-052 (этап I): **service-key** — тип `ServiceApiKey` (`id` `svk_<uuid>`/`label`/`description?`/`roles: GlobalRole[]`/`scopes: string[]`/`allowedProjects?: string[]`/`rateLimitPerMinute?`/`expiresAt?`/`revokedAt?`/`createdBy`/`createdAt`/`lastUsedAt?`/`prefix`) и `ServiceApiKeyCreated` (+ `key` — plaintext единожды) (`types/service-keys.ts`, re-export из `types`); входные `CreateServiceApiKeyInput`/`UpdateServiceApiKeyPatch` (`null` — сброс поля). Реестры/матчер: `SERVICE_SCOPES` (точечные scope'ы, включая зонтичный `automation:install` — установщик пакетов расширений: агенты и их ролевые промпты, пайплайны, порождаемые пакетом правила маршрутизации и расписания), `SERVICE_SCOPE_FAMILIES` (wildcard-семейства, глобального `*` нет; `automation` в семейства **не** входит), `isKnownScope`/`hasServiceScope`, `SERVICE_SCOPE_SETS` (наборы «достаточно любого из»: `routesWrite`/`schedulesWrite`/`agentsWrite`) и матчер `hasAnyServiceScope`. Zod — `serviceApiKeySchema`/`serviceApiKeyCreateSchema`/`serviceApiKeyUpdateSchema`/`serviceApiKeyCreatedSchema` (валидация scope/role).
- ADR-052 (этап II): **webhooks** — типы `WebhookSubscription` (`id` `whk_<uuid>`/`label` (уникальна)/`description?`/`url`/`events: string[]`/`enabled`/`secretPrefix`/`createdBy`/`createdAt`/`lastDeliveryAt?`/`lastStatus?`/`disabledAt?`) и `WebhookSubscriptionCreated` (+ `secret` — plaintext единожды), `WebhookDelivery` (`whd_<uuid>`/`subscriptionId`/`eventType`/`status`/`attempts`/`responseStatus?`/`error?`/`createdAt`/`completedAt?`), входные `CreateWebhookSubscriptionInput`/`UpdateWebhookSubscriptionPatch` (`types/webhooks.ts`, re-export из `types`); матчер `matchWebhookEvent(patterns, type)` (exact/`prefix.*`, пусто — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), валидатор `isWebhookEventPattern`, префикс `WEBHOOK_SECRET_PREFIX` (`whsec_`). Zod — `webhookSubscriptionSchema`/`webhookSubscriptionCreateSchema`/`webhookSubscriptionUpdateSchema`/`webhookSubscriptionCreatedSchema`/`webhookDeliverySchema`/`webhookEventPatternSchema`/`webhookUrlSchema`.
- ADR-051/PROP-059: **пайплайны** — типы `PipelineStepKind` (`agent`/`loop`), `EventMatch` (сужение
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
- ADR-086 §5: **манифест пакета расширения** (`synth.pack`) — `PackKind`
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
- ADR-084: типы decision-моделей — `DecisionQuestion`/`DecisionAnswer` (варианты `noul`/`choice`/`score`),
  `DecisionRequest`/`DecisionResponse`/`DecisionUsage` и медиа-контракт `DecisionMediaInput`
  (`images?`/`videos?`, задел PROP-085) (`types/decision.ts`); Zod
  `decisionQuestionSchema`/`decisionAnswerSchema`/`decisionRequestSchema`/`decisionResponseSchema`;
  per-session флаг `SessionSettings.decisionFirst` (ADR-035).
- PROP-102: типы аналитики — `AnalyticsFamily`/`AnalyticsDimension`/`AnalyticsRollupBucket`/
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

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest), сборка — `tsc`.
- После правки публичной поверхности — `pnpm --filter @itphx/synth-shared build`,
  иначе typecheck зависимых пакетов не увидит типы (см. корневой «GitVerse CI»).
