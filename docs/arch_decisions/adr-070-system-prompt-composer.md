# ADR-070: SystemPromptComposer — консистентность промпта, prompt-cache, статистика и прозрачность

> **Статус:** ✅ Реализовано (Фазы 1–4; as-built вынесено в spec — 2026-10-15).
> **Дата:** 2026-09-18.
> **Парные документы (as-built):** [ARCHITECTURE.md](../ARCHITECTURE.md) «Композиция системного промпта» · [API_V2.md](../API_V2.md) §5.5 · [CONFIGURATION.md](../CONFIGURATION.md) (`llm.cache`) · `packages/{core,ui}/AGENTS.md`.
> **Связано:** [ADR-022](./adr-022-typescript-stack-runner.md) (stateless-движок), [ADR-036](./adr-036-llm-gateway.md) (Gateway: guard/обфускация; CachePolicy/usage — на его границе), [ADR-039](./adr-039-plan-in-project.md), [ADR-041](./adr-041-llm-error-taxonomy.md) (i18n), [ADR-046](./adr-046-skills-and-slash-commands.md), [ADR-069](./adr-069-project-instructions-agents-md.md), [ADR-071](./adr-071-mcp-servers-prompt.md), [ADR-078](./adr-078-runtime-dependency-availability.md), [ADR-025](./adr-025-plan-act-toggle.md)/[ADR-028](./adr-028-plan-build-strictness.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-026](./adr-026-subagent-context-modes.md), [ADR-034](./adr-034-model-routing.md), [ADR-005](./adr-005-json-storage.md), [ADR-014](./adr-014-project-container.md), [ADR-042](./adr-042-hybrid-mode.md)/[ADR-045](./adr-045-hybrid-server-profiles.md).
> **Карта подразделов (прежняя нумерация §) → spec-дом:** §2.1 тиры/Composer, §2.4 `promptStates`, §2.7 многоагентность, §2.8 режим/план/todo, §3 порядок/инварианты → [ARCHITECTURE.md](../ARCHITECTURE.md) (механика модулей — `packages/core/AGENTS.md`); §2.2 CachePolicy → [CONFIGURATION.md](../CONFIGURATION.md); §2.3 usage/§2.5 прозрачность → [API_V2.md](../API_V2.md) §5.5; §2.5 UI → `packages/ui/AGENTS.md`; §2.6 `ContextSource`-шов, §2.9 тулы/`ToolAccess` → `packages/core/AGENTS.md`; §4 фазы/тесты → «Статус реализации»; §6 «что не делаем» → «Альтернативы»; §7 → «Открытые вопросы».

## Контекст

Промпт собирался **инкрементально в нескольких местах** (`ContextBuilder` + конкатенация в
`ChatOrchestrator`): динамика (sticky/summary/participants) стояла в начале префикса и любое изменение
обнуляло prompt-cache; кэшем не управляли (Anthropic — system строкой без `cache_control`, OpenAI — без
`prompt_cache_key`, `cached_tokens` не читался), статистика занижена, состав промпта непрозрачен, отладка
(`captureSystemPromptParts`) мертва, у саб-агента system уходил дважды. Повторная сборка после
`plan_enter`/`plan_exit` дописывала блоки поверх уже собранного — **баг дублей**.

## Решение

- **Единая точка сборки.** `SystemPromptComposer` (`engine/context/composer.ts`) собирает промпт основной
  сессии и саб-агентов (`ContextBuilder` — «сырые» блоки без конкатенации; debug-эхо/`SUMMARIZER` — inline).
- **Три тира (модель hermes):** `stable` (константы и политики) → `context` (проектный контекст) →
  `volatile` (состояние и переходные добавки). Принцип «политика — в `stable`, состояние — в `volatile`»:
  условная добавка (опросник, «профиль пуст») — после границы кэшируемого префикса, не инвалидирует его.
- **Идемпотентная пересборка:** `compose()` собирает промпт из состояния **заново** (никаких `base + part`);
  при неизменном состоянии `stablePrefix` побайтово стабилен; источник истины — состояние сессии.
- **Режим/план/todo — chronological system-сообщения истории, не system:** `MODE_*`/`PLAN_MODE_*`/
  `[APPROVED PLAN]`/`[TODO]` → durable `role: system` (`mode_change`/`plan_updated`/`todos_updated`/
  `agent_switch`, скрыты только в UI), `PLAN_GUIDE` — в `stable`; иерархия `tools → system → messages`;
  **by design** лечит баг дублей.
- **CachePolicy — в провайдерах/Gateway, не в тулах** (ADR-036): Anthropic — `system` массивом блоков с
  `cache_control` (≤4 breakpoint'а); OpenAI — `prompt_cache_key` = стабильный id сессии +
  `stream_options.include_usage`; маркеры — после нормализации/санитайза; `none` отключает всё (дефолт
  `auto`, `llm.cache`).
- **Usage/статистика:** нормализованный `Usage` (`nonCached + cacheRead + cacheWrite = input`), стоимость с
  cache read/write, **cache hit rate** — доля кэшированных входных токенов (сессия/API/UI).
- **Состояние промпта — per-agent (Вариант B):** `session.promptStates[agentKey]` (`agentRole` или
  `__default__`) хранит generation, `staticPrefixHash`, байты `staticPrefix`, блочные хэши; пишется только
  при смене generation; в assistant-сообщении — `promptMeta` (`expected: hit|miss`, cachedTokens,
  `validated`). Смена режима и модели/провайдера generation **не** поднимают (модель → `expected: 'miss'`);
  `promptStates` саб-агентов не персистятся, полную историю не храним (payload-лог Gateway).
- **Прозрачность и дебаг:** манифест (key/label/размер/токены/статус/provenance) + слой `tools` + слой
  истории; манифест и промпт — один обход (тест паритета «манифест ↔ отправленные байты»); API
  `GET /api/v2/sessions/:id/prompt`, UI «Состав промпта», `DebugCollector` во всех точках создания;
  **`ContextSource`-шов** (`{ key, load(ctx) }`) — задел под реестр источников (пока внутри Composer).
- **Тулы постоянны во всех режимах:** ограничения — только permission-слой (ADR-029) с осью `ToolAccess`
  (`allow`/`ask`/`deny`/`unavailable(mode|role)`); доступность **не** в `description` тула.

## Альтернативы

- **Полная история промптов / персист `promptStates` саб-агентов** — нет: полные байты в payload-логе Gateway, саб-агенты эфемерны.
- **Общий префикс вперёд для всех агентов / кэш-управление в тулах** — нет: role — первый блок, у каждого агента свой префикс и кэш; CachePolicy — только провайдеры/Gateway.
- **Supersede state-сообщений / тулы по режиму / доступность в `description`** — нет: инвалидирует кэш; источник истины — состояние в хранилище, ограничения — permission-слой.

## Последствия

- (+) Промпт детерминирован и кэшируем; дубли и двойной system устранены; статистика честная, состав наблюдаем и проверяем паритетом.
- (−) `promptStates` усложняет session-файл (пишется редко); манифест добавляет обход источников; гибрид — CachePolicy/usage применяются на стороне LLM-вызова (удалённые — `RemoteProvider`). Вне объёма: object-политика CachePolicy (as-built `auto|none`).

## Статус реализации

✅ Реализовано полностью (Фазы 1–4). As-built — [ARCHITECTURE.md](../ARCHITECTURE.md) «Композиция системного промпта», `packages/core/AGENTS.md` (`engine/context/*`, `providers/*`, `engine/orchestrator.ts`, `sessions/stats.ts`), [API_V2.md](../API_V2.md) §5.5 (`/prompt`, `/stats`), [CONFIGURATION.md](../CONFIGURATION.md) (`llm.cache`), `packages/ui/AGENTS.md`. Тесты — `engine/context/{composer,prompt-state,state-messages}.test.ts`, `providers/{usage,anthropic,openai}.test.ts`, backend `sessions.test.ts` (`/prompt`, `/stats`), UI `StatsTab.test.tsx`.

## Открытые вопросы

Предсказание hit для Anthropic с учётом breakpoint'ов; считать ли `session.settings.systemPrompt` override стабильным префиксом; точный токенайзер vs эвристика `chars/4` в манифесте; отражение смены модели/провайдера (`expected: 'miss'`) в статистике vs routing ([ADR-034](./adr-034-model-routing.md)); представление `ToolAccess` (`unavailable`) в манифесте/UI.

## История

- 2026-10-15 — сжатие до одной страницы: as-built вынесено в spec ([ARCHITECTURE.md](../ARCHITECTURE.md), [API_V2.md](../API_V2.md) §5.5, [CONFIGURATION.md](../CONFIGURATION.md), `packages/{core,ui}/AGENTS.md`).
- 2026-09-19 — доработки прозрачности: слой `tools` и «История» в манифесте, резолв профиля username→UUID.
- 2026-09-18 — решение принято; реализованы Фазы 1–4 (Composer/тиры/идемпотентность, CachePolicy/`promptStates`, usage, манифест/debug).
