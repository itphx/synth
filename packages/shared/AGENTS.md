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
- **Env-оверрайды скалярных ключей секций** `events`/`scheduler`/`webhooks`/`decision` —
  реестр `ENV_OVERRIDES` (`src/config/env-overrides.ts`), применяется в `loadConfig`;
  имя `SYNTH_<SECTION>_<KEY>` (camelCase→SNAKE_CASE), невалидное значение → warn + игнор;
  приоритет `CLI > env > config.yaml > defaults` (ADR-023). Объектные/нескалярные ключи
  (`events.identityMap`, `events.dedupStore`, `mcp.servers`, …) остаются в config.yaml.
- PROP-032 (слой хранения, ADR-096/ADR-097): секция `storage` — `backend`
  (`file`|`memory`|`postgres`, резолвер `resolveStorageBackend` + env
  `SYNTH_STORAGE_BACKEND`, **fail-closed** на неизвестном явном значении), `postgres`
  (`dsn`/`host`/`port`/`database`/`user`/`schema`/`ssl`/`poolMax`, резолвер
  `resolvePostgresConfig` + env `SYNTH_POSTGRES_*`), задел деградации
  `degradedMode` (`fallback-file`|`halt`, `resolveDegradedMode`) / `fallbackDir`
  (`resolveStorageFallbackDir`). Пароль БД в схеме **не хранится** (инвариант 13) —
  `resolvePostgresPassword` (env `SYNTH_POSTGRES_PASSWORD` → файл
  `{dataDir}/secrets/postgres-password`).

## Схемы и типы

`src/types/index.ts` + `src/schemas/index.ts` — единые контракты сущностей; схемы `projectCreate/Update`, `sessionCreate/Update`.
- ADR-046: `src/skills/frontmatter.ts` — толерантный `parseFrontmatter`/`stringifyFrontmatter` формата `SKILL.md` (js-yaml; невалидный YAML → `issues`, не throw; неизвестные ключи сохраняются в `SkillMeta.extra`); типы скиллов — `src/types/skills.ts` (`SkillScope`/`SkillLevel`/`SkillInvocation`/`SkillMeta`/`SkillSummary`/`SkillDetail`/`SkillDiagnostic`, `requires_capabilities`/`requires_toolsets`).
- `EventType` включает `fs.changed` (мутирующий тул ядра изменил workspace) и `session.moved` (перенос сессии между проектами); потребители — `transportStore` UI (ADR-024).
- ADR-030/ADR-089: хуки — `HookName`/`HookMode`/`HookResult`/`HookContextMap` (`types/hooks.ts`); события — `SynthEvent`/`EventBinding`/`RouteDecision`/`SessionRequest`/`EventMode`/`EventDeliveryMode` и правила `EventRouteRule`/`EventRouteTarget`/`EventRouteMatch` (`types/events.ts`); Zod `synthEventSchema`, `eventBindingSchema`, `sessionRequestSchema`, `eventIngestSchema`, `eventBindingInputSchema`, `eventRouteRuleSchema`/`eventRouteRuleInputSchema`/`eventRouteRuleUpsertSchema`/`eventRouteTargetSchema`/`eventRouteMatchSchema`. Поля `Session.expiresAt`/`archivedAt` — ephemeral TTL/архив (ADR-089).
- ADR-089/ADR-052: API-ключи привязок — типы `EventBindingApiKey` (поля `label` (обязательная, уникальная глобально по инстансу)/`description?`/`rateLimitPerMinute?`/`createdBy`/`prefix`/`lastUsedAt?`, `expiresAt?`/`revokedAt?`) и `EventBindingApiKeyCreated` (+ `key` — plaintext единожды), `EventKeyCredential` (в core); Zod `eventBindingApiKeySchema`/`eventBindingApiKeyCreateSchema` (`{label, description?, expiresAt?, rateLimitPerMinute?}`)/`eventBindingApiKeyUpdateSchema` (`null` — сброс поля)/`eventBindingApiKeyCreatedSchema` и `eventKeyIngestSchema` (`eventIngestSchema.partial({ source: true })` — приём по ключу).
- ADR-052 (этап I): **service-key** — тип `ServiceApiKey` (`id` `svk_<uuid>`/`label`/`description?`/`roles: GlobalRole[]`/`scopes: string[]`/`allowedProjects?: string[]`/`rateLimitPerMinute?`/`expiresAt?`/`revokedAt?`/`createdBy`/`createdAt`/`lastUsedAt?`/`prefix`) и `ServiceApiKeyCreated` (+ `key` — plaintext единожды) (`types/service-keys.ts`, re-export из `types`); входные `CreateServiceApiKeyInput`/`UpdateServiceApiKeyPatch` (`null` — сброс поля). Реестры/матчер: `SERVICE_SCOPES` (точечные scope'ы), `SERVICE_SCOPE_FAMILIES` (wildcard-семейства, глобального `*` нет), `isKnownScope`/`hasServiceScope`. Zod — `serviceApiKeySchema`/`serviceApiKeyCreateSchema`/`serviceApiKeyUpdateSchema`/`serviceApiKeyCreatedSchema` (валидация scope/role).
- ADR-052 (этап II): **webhooks** — типы `WebhookSubscription` (`id` `whk_<uuid>`/`label` (уникальна)/`description?`/`url`/`events: string[]`/`enabled`/`secretPrefix`/`createdBy`/`createdAt`/`lastDeliveryAt?`/`lastStatus?`/`disabledAt?`) и `WebhookSubscriptionCreated` (+ `secret` — plaintext единожды), `WebhookDelivery` (`whd_<uuid>`/`subscriptionId`/`eventType`/`status`/`attempts`/`responseStatus?`/`error?`/`createdAt`/`completedAt?`), входные `CreateWebhookSubscriptionInput`/`UpdateWebhookSubscriptionPatch` (`types/webhooks.ts`, re-export из `types`); матчер `matchWebhookEvent(patterns, type)` (exact/`prefix.*`, пусто — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), валидатор `isWebhookEventPattern`, префикс `WEBHOOK_SECRET_PREFIX` (`whsec_`). Zod — `webhookSubscriptionSchema`/`webhookSubscriptionCreateSchema`/`webhookSubscriptionUpdateSchema`/`webhookSubscriptionCreatedSchema`/`webhookDeliverySchema`/`webhookEventPatternSchema`/`webhookUrlSchema`.
- ADR-084: типы decision-моделей — `DecisionQuestion`/`DecisionAnswer` (варианты `noul`/`choice`/`score`),
  `DecisionRequest`/`DecisionResponse`/`DecisionUsage` и медиа-контракт `DecisionMediaInput`
  (`images?`/`videos?`, задел PROP-085) (`types/decision.ts`); Zod
  `decisionQuestionSchema`/`decisionAnswerSchema`/`decisionRequestSchema`/`decisionResponseSchema`;
  per-session флаг `SessionSettings.decisionFirst` (ADR-035).
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
