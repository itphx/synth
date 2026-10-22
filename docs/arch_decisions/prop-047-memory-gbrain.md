# PROP-047: Память Synth (Gbrain + композиция)

> **Статус:** 🧩 Предложение (vision)
> **Дата:** 2026-09-16
> **Обновлено:** 2026-10-22 — переписано под слой плагинов (PROP-090): память — тип плагина; больше не «в обход Extension API»
> **Источник:** перенесено из `AD-DRAFTS.md` (D2, идея 2); Obsidian-vault `Memory-Architecture.md`,
> `Memory-Analysis.md`, `Roadmap.md` (Фаза 3); прототип `~/dev/aic/t11` (`app/embeddings/`).
> **Связано:** [PROP-090](./prop-090-extension-api.md) (слой плагинов — канон для памяти),
> [ADR-086](./adr-086-extensibility-plugins-editions.md) (классы расширений),
> [ADR-100](./adr-100-extension-packs-pipelines.md) (поставка `synth.pack`),
> [ADR-103](./adr-103-gateway-core-channel-contract.md) (контракт внешнего канала),
> [ADR-087](./adr-087-gateways.md) (шлюзы), [PROP-068](./prop-068-skills-agents-registry.md) (модель доверия),
> [ADR-030](./adr-030-hooks-agent-events.md) (хуки), [ADR-070](./adr-070-system-prompt-composer.md) (тиры блоков),
> [ADR-036](./adr-036-llm-gateway.md) (Gateway), [ADR-096](./adr-096-storage-layer.md)/
> [ADR-097](./adr-097-storage-provider-class.md) (порты и контрактный suite),
> [ADR-097](./adr-097-storage-provider-class.md), [ADR-026](./adr-026-subagent-context-modes.md),
> [PROP-062](./prop-062-context-optimization.md), [ADR-005](./adr-005-json-storage.md),
> [PROP-085](./prop-085-multimodal-input.md), [ADR-101](./adr-101-pipeline-engine.md),
> [ADR-051](./adr-051-scheduler-pipelines.md), [PROP-097](./prop-097-background-processes-registry.md),
> [ADR-072](./adr-072-settings-ui-kit.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md).

**Решение (предлагаемое):** построить память Synth как **тип плагина поверх слоя плагинов**
([PROP-090](./prop-090-extension-api.md)), а не как подсистему ядра и **не** как самостоятельный узкий
контракт в обход Extension API:

- **Память — плагин** (`synth.pack`, `kind: "plugin"`). Плагин регистрирует реализацию контракта
  **`MemoryProvider`** (источник фактов: `recall`/`ingest`/`admin`) и/или **`PromptBlockProvider`**
  (доставка фактов в системный промпт через точку `promptBlocks`).
- **Классы расширений для памяти разведены:**
  - **Plugin** (`kind: "plugin"`, режим `inline` или `out-of-process`) — встроенная память (точечная:
    инварианты проекта, sticky notes, профиль), ванильный RAG, адаптеры к внешним хранилищам;
  - **Add-on** (внешний сервис) — **Gbrain**: свой процесс/контейнер, свой MCP и своя админка;
    Synth-side — тонкий плагин-адаптер, реализующий `MemoryProvider` поверх MCP/API v2;
  - **контент-пак** (`kind: "pack"`, `packType: "memory"` — тип уже есть в `PACK_TYPES`) — декларативная
    часть: схема фактов, шаблоны, скилл «как пользоваться памятью».
- **Три канала доставки фактов в контекст:** блок `promptBlocks` тира `context` (устойчивые факты), блок
  тира `volatile` (релевантное ходу), тул `memory_search` (агент копает сам). **Тир `stable` запрещён** —
  граница prompt-cache.
- **Индексы — именованные сущности** с поколением, фингерпринтом эмбеддинга и статусом готовности;
  ими управляет **портал памяти**.
- **Консолидация — фоновая работа движка пайплайнов** (ADR-101), запускаемая по расписанию (ADR-051)
  с лидер-элекшеном; внешний Gbrain консолидирует у себя.
- **Версионирование — шесть независимых осей** (схема данных, поколение индекса, фингерпринт эмбеддинга,
  версия факта, версия контракта провайдера, версия схемы-пака).

### Что изменилось против черновика от 2026-10-22

Черновик «память как провайдер» (рабочая копия в ветке `feature/memory-plugins`, не принят) предлагал:
«память — не Plugin, а отдельный узкий контракт `MemoryProvider` (по образцу ADR-103
`@itphx/synth-gateway-core`), потому что Extension API (PROP-090) в Icebox и требует trust/scan/CLI/UI;
когда PROP-090 вернётся в работу, `MemoryProvider` станет одним из объявлений `provides` плагина».

| Аспект | Черновик 2026-10-22 | После решения владельца 2026-10-22 |
|---|---|---|
| Аргумент «PROP-090 в Icebox» | основание для отдельного контракта | **снят** — PROP-090 возвращён в работу (`Решение до: 2026-11-14`), сначала строится слой плагинов |
| Класс расширения | отдельный узкий контракт в обход Extension API | **плагин** (`kind: "plugin"`); контракт `MemoryProvider` — доставляемый плагином |
| Точка расширения | «новая 13-я точка» в core | **существующие точки** PROP-090 §4: `promptBlocks`, `tools`, `hooks`, `routes`, `settings` |
| Доверие | свой (не определён) | модель доверия PROP-090 §9 (trust-floor `trusted`, скан бандла, `audit/plugins.jsonl`) |
| «Минимальные правки в core (без PROP-090)» | отдельный список правок ядра (реестр блоков, `resolveMemoryContext`, `isBlockChanged`, `ToolCapability.MEMORY`, канал записи) | правок ядра **на доставку фактов нет** — реестр `promptBlocks` это Ф3 PROP-090; `ToolCapability.MEMORY` — часть Ф0/Ф3, не отдельная правка |
| Где живёт ванильный RAG | открытый вопрос: `@itphx/synth-memory` или `packages/core/src/engine/memory/` | **внутри как реализация `MemoryProvider`**, поставляемая плагином; отдельный npm-пакет **не создаётся** — контракт в `@itphx/synth-shared` (§1.2) |
| Gbrain | Add-on/Gateway + адаптер в ядре | Add-on (внешний сервис) + **плагин-адаптер** (`MemoryProvider` поверх MCP) |
| Портал | core-фабрика `createMemoryRoutes` в ядре | API — роут **плагина** (точка `routes`), UI — встроенный экран (точка UI-slot отложена) |

## Контекст

### Что уже есть в Synth

- Долговременное состояние проекта: `project.plan` / `project.log` / `project.invariants`; sticky notes;
  `read_session_reference` — всё это **точечная** память, разложенная по трём разным местам
  (проект / сессия / профиль) и **не** подмешиваемая «по запросу».
- Summary-кэш контекста в памяти процесса — `ContextOptimizer`
  (`packages/core/src/engine/context/optimizer.ts`); суммаризация оборачивается в `GatewayProvider`
  (`_wrapWithGateway`, `:633-645`). Это **не** память: кэш не переживает процесс.
- Embeddings — **только** для micro-слоя микро-маршрутизации (ADR-035):
  `packages/core/src/engine/router/micro/models/embedding-model.ts`; duck-типированный `provider.embed()`
  через `ProviderPool` (проверка — `:155`, вызовы — `:200`, `:217`), fallback
  `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (`:14`); косинус вручную (`:249-261`).
  **Порта `EmbeddingProvider` нет**, и эмбеддинги идут **мимо** `GatewayProvider`: `embed` — прямой вызов
  `_inner.embed` (`packages/core/src/engine/gateway/gateway-provider.ts:269`), guard/аудит/обфускация
  не применяются.
- `context_snapshot` (ADR-096) **не реализован**; физическое хранилище истории — JSON (ADR-005).
- Слой хранения — **34 доменных порта** (`packages/core/src/storage/ports/`; в каталоге 36 файлов,
  включая `index.ts` и `collection-limit.ts`), контрактный suite
  (`packages/core/src/storage/contract/`), драйвер PostgreSQL с миграциями и advisory-локами.
  **Порта памяти нет.** Расширение `pgvector` в драйвере нет — только `pg_trgm`
  (`packages/storage-postgres/src/migrations/001-init.ts:18`).
- Точки расширения для «памяти» в ядре:
  - **промпт-блоки — шва есть, реестра нет**: `SystemPromptComposer._collectBlocks()`
    (`packages/core/src/engine/context/composer.ts:426-646`) собирает блоки **хардкодом**
    (`extraBlocks.push(...)`); модель блока — `engine/context/prompt-blocks.ts:12-23`,
    тиры `TIER_ORDER` (`:25-29`), `sortPromptBlocks` (`:35`), `joinPromptBlocks` (`:45`).
    Реестр провайдеров (`PromptBlockProvider`) проектируется в PROP-090 §5 (**Ф3**);
  - **async-retrieval перед сборкой промпта — шва есть**: `resolveProjectInstructions`
    (`packages/core/src/engine/orchestrator/phases/process-setup.ts:355-364`) — асинхронный резолвер
    внешнего контента с мемоизацией по ходу; рядом — `resolveSchedulerActive` (`:387`) и
    `collectSkillsCatalog` (`:345-352`);
  - **инвалидация prompt-state при смене блока — шва есть**: `isBlockChanged(prev, blocks, 'instructions')`
    (`process-setup.ts:440`), запись состояния — `:427-453`;
  - **тулы — шва есть**: `ToolRegistry.register` (`packages/core/src/engine/tools/registry.ts:7-12`);
    `ToolCapability` — 11 значений, **`MEMORY` нет** (`packages/shared/src/types/tools.ts:3-15`);
  - **write-path — шва есть (частично)**: шина хуков `HookBus` (`engine/hooks/hook-bus.ts`) эмитит
    `pre_tool_use` (`orchestrator.ts:2814`), `post_tool_use` (`:3296`), `permission_denied` (`:2961`),
    `plan_approved` (`:3252`), `session_start`/`session_end` (`sessions/manager.ts:222`, `:282`, `:333`),
    `agent_spawned`/`agent_completed`/`agent_failed` (`engine/tools/task/fork.ts:179`,
    `engine/tools/task/run-cycle.ts:1091`); но payload не содержит контента сессии, а
    `message_received` **объявлен** (`packages/shared/src/types/hooks.ts:15`) и **не эмитится** —
    остаток ADR-030, пункт **Ф0** PROP-090;
  - **доставка декларативной части — шва есть**: `synth.pack` (`packages/shared/src/types/pack.ts`),
    установка пакета — `packages/core/src/server/routes/packs.ts` (скиллы `:485` → MCP `:540` →
    агенты `:584` → пайплайны `:660`). `PACK_TYPES` **уже содержит** `'memory'`
    (`packages/shared/src/types/pack.ts:52`; список — `:42-56`), но `provides` описан через
    `packProvidesSchema` (`:227`) с `.passthrough()` — `provides.promptBlocks[]`/`provides.llmFilters[]`/
    `provides.tools[]` в схеме **нет** (явные Zod-схемы — **Ф0** PROP-090).
- Слой плагинов ([PROP-090](./prop-090-extension-api.md)) — **в работе**: статус `🧩 Предложение`,
  срок `2026-11-14`, фазы Ф0–Ф7; в коде пока **нет** `PluginHost`, `@itphx/synth-plugin`, `definePlugin`,
  `plugins.lock.json`, `/api/v2/plugins*`, CLI `synth plugin *`, точек `promptBlocks`/`llmFilters`
  и `RuntimeSettings.plugins`. Память — **потребитель** этого слоя, а не его обход.
- UI: роутера **нет** (экран = center-tabs в `useUIStore`); Settings UI Kit (ADR-072) — форма
  (`max-w-3xl`, один вертикальный скролл); прецедент «внечатного» рабочего экрана — center-tabs
  `pipeline` / `pipeline-run` (ADR-101).

### Проблема

Текущая «память» — набор точечных JSON-полей и summary в памяти процесса: она не переживает процесс
(кроме файлов), не масштабируется на объём, не поддерживает гибридный поиск и не покрывает
одновременно **память** и **код/документацию проекта**. Прототип t11 умел локально строить RAG-индексы
по проекту (`~/dev/aic/t11/synth/app/embeddings/` — `indexer.py`, `search.py`, `_search_project_rag`),
в Synth этого нет. Память также нужна как «топливо» для Loop Engine (PROP-057), Council (PROP-058),
оптимизации контекста (PROP-062), обучения и метрик (PROP-063).

Отдельный вопрос — **куда эта подсистема встраивается**. Он решён: ядро не получает ни реестра
промпт-блоков, ни порта памяти, ни порта эмбеддингов; **память приходит плагином** через
[PROP-090](./prop-090-extension-api.md). Отсюда следствия, которые этот документ и фиксирует:
(a) контракт `MemoryProvider` перестаёт быть «обходом» и становится контрактом, который **доставляет
плагин**; (b) отдельная точка расширения `memory` **не заводится** — плагин пользуется существующими
точками; (c) правки ядра для доставки фактов **не нужны** — реестр `promptBlocks` это Ф3.

### Внешние референсы: что именно берём

| Система | Лицензия | Что берём | Чего **не** берём |
|---|---|---|---|
| **Gbrain** (`github.com/garrytan/gbrain`, MIT, ~31k ★) | MIT — можно переносить код | контракт `BrainEngine` (140+ методов, CLI и MCP генерируются из одного источника); hybrid retrieval (vector HNSW + BM25 + RRF постранично + source-aware boost + cross-encoder rerank + relational arm по типизированным рёбрам); **evidence-контракт** (`alias_hit` / `exact_title_match` / `high_vector_match` / `keyword_exact` / `weak_semantic`) и `create_safety`; **фингерпринт эмбеддинга** (`embedding_input_hash`: колонка+модель+размерность+режим обёртки+текст) → пересборка сохраняет вектор только при совпадении; **`projection_readiness` / `degraded`** («не найдено» ≠ «индекс не готов»); schema-паки (15 типов, `detect → suggest → review`, `migration_from`); **dream cycle** (cron-консолидация: дедуп, починка цитат, salience, противоречия); self-wiring граф (`[[entity]]`, извлечение рёбер **без LLM**); факты с provenance, коррекцией и отзывом (`superseded_claim`); Minions-очередь с crash-safe two-phase persistence; MCP-сервер (stdio/HTTP + OAuth 2.1, scopes `read/write/admin/agent`) и свой `/admin` | свой рантайм, Bun-зависимость, свой `/admin` (дублировать не будем) |
| **TokenJuice** / OpenHuman (`tinyhumansai/openhuman`) | **GPL-3.0** | только идею: RLM-компрессия tool output (`⟦tj:hash⟧`-кэш) | **код не переносим** (GPL) — тот же ответ, что и по SuperContext в исходной редакции PROP-047 |
| **SuperContext** | GPL | только идею: pre-fill scout / read-only «burst»-LLM | код |
| **MemPalace** | — | идея 4-слойной выдачи L0–L3, структура Wing/Room/Hall | код |

## Детали

### 1. Класс расширения и контракт

#### 1.1 Почему плагин

Черновик 2026-10-22 строил память на «собственном узком контракте» по образцу ADR-103
(`@itphx/synth-gateway-core`) — с обоснованием «PROP-090 в Icebox». Обоснование **снято решением
владельца от 2026-10-22**: Extension API возвращён в работу, **сначала строится слой плагинов**, а к
конкретным реализациям памяти возвращаемся после. Поэтому:

- **Память — класс Plugin** ([PROP-090](./prop-090-extension-api.md) §3). Манифест — `synth.pack`,
  `kind: "plugin"`; доставка — `PluginHost` (resolve → integrity → semver-гейт → trust/scan → политика
  режима → import → facade → сбор disposers → аудит).
- **Контракт `MemoryProvider` остаётся**, но меняет роль: это **контракт точки расширения/провайдера**,
  который **доставляется плагином** (регистрация через фасад), а не контракт в обход Extension API.
- **Отдельная точка расширения `memory` не заводится.** Плагин памяти использует существующие точки
  PROP-090 §4: `promptBlocks` (доставка фактов), `tools` (`memory_search`), `hooks` (write-path),
  `routes` (API портала), `settings` (свои настройки), `schedules` (расписание консолидации);
  определение пайплайна-консолидации приходит не из точки расширения, а из `provides.pipelines`
  манифеста (ADR-100) и исполняется движком ADR-101. Это снимает вопрос PROP-090 о месте контракта
  `MemoryProvider` (закрыт решением владельца 2026-10-22: контракт — в `@itphx/synth-shared`, §1.2).
- **Доверие** — модель PROP-090 §9: уровни `builtin → verified → trusted → community → agent-created`,
  ячейка `kind: "plugin"` в install-policy, trust-floor `trusted` (ниже — не активируется), скан бандла
  и отдельный журнал `{dataDir}/audit/plugins.jsonl`. Память больше не «доверенная по определению».
- **Режим исполнения** — два транспорта, один контракт (PROP-090 §7): `inline` — встроенная память и
  быстрые адаптеры; `out-of-process` — тяжёлые реализации (локальные эмбеддинги ванильного RAG,
  сетевой Gbrain-адаптер): процесс не роняет core, но плагин получает только сериализуемые DTO.

#### 1.2 Контракт `MemoryProvider`

**Где живёт контракт.** Контракт `MemoryProvider` — **в `@itphx/synth-shared`** (рядом с остальными
контрактами типов): типы `MemoryProvider`/`MemoryFact`/`RecallRequest`/`RecallResult` и поле
`readiness`. **Отдельный npm-пакет `@itphx/synth-memory` не создаётся** — решение владельца
(2026-10-22): контракт нужен ядру (реестр плагинов, портал) и плагинам-поставщикам, а оба уже
зависят от `shared` (ADR-038); девятый пакет монорепо ради одного контракта был бы лишним.
**Реализации** провайдеров (встроенная память, ванильный RAG, адаптер Gbrain) **не** в `shared` и
**не** в `core` — они поставляются **плагинами** (см. §1.1 и §2).

Контракт — тип без логики (по правилу «`shared` = контракты, без бизнес-логики»). Скетч:

```ts
// Контракт точки расширения «источник фактов» — в `@itphx/synth-shared` (см. §1.2).
export interface MemoryProvider {
  readonly id: string;                    // 'builtin:sticky' | 'plugin:rag' | 'plugin:gbrain'
  readonly contracts: 1;                  // semver-мажор, как семвер-гейт PROP-090 §10
  readonly capabilities: MemoryCapability[]; // 'recall' | 'ingest' | 'index' | 'consolidate' | 'graph'
  recall(req: RecallRequest): Promise<RecallResult>;
  ingest?(req: IngestRequest): Promise<IngestResult>;
  admin?(cmd: MemoryAdminCommand): Promise<MemoryAdminResult>;
}

export interface RecallRequest {
  readonly query: string;
  readonly scope: { projectId?: string; userId?: string; agentRole?: string };
  readonly budget: { maxTokens: number; maxItems: number };
  readonly signal?: AbortSignal;
}

export interface RecallResult {
  readonly facts: MemoryFact[];           // { id, text, score, provenance, confidence, evidence, createdAt }
  readonly citations: MemoryCitation[];   // { sourceUri, sourceTitle, revision }
  readonly readiness: 'ready' | 'degraded' | 'stale' | 'unavailable';
  readonly meta?: Record<string, unknown>;
}
```

Отличия от черновика: `id` указывает на **плагин** (`plugin:<name>`), а не на «встроенный класс»;
`contracts` — semver-мажор, проверяется тем же гейтом, что `contracts` манифеста (PROP-090 §10, шаг 3);
`readiness` — обязательное поле: «не нашлось» и «индекс не готов» — разные вещи.

#### 1.3 `MemoryProvider` и `promptBlocks`: кто что делает (без дублирования)

`MemoryProvider` — **источник фактов**; `PromptBlockProvider` (контракт — PROP-090 §5) — **доставка в
промпт**. Разные роли — разные обязанности:

| Аспект | `MemoryProvider` | `PromptBlockProvider` |
|---|---|---|
| Роль | источник фактов | доставка в системный промпт |
| Обязателен для плагина | нет | нет |
| Нужен для | тула `memory_search`, write-path, портала, консолидации | присутствия памяти в промпте |
| Что делает | `recall`/`ingest`/`admin` | `load(ctx)` → `{ content, provenance?, status? }` |
| Знание о запросе | получает `query` в `RecallRequest` | получает `query` в `PromptBlockContext` (PROP-090 §5, правка 2026-10-22) |
| Готовность | `readiness: 'ready'\|'degraded'\|'stale'\|'unavailable'` | `status: 'empty'\|'loaded'\|'truncated'` |
| Токен-бюджет | **владелец**: укладывает выдачу в `budget.maxTokens` | **потребитель**: запрашивает recall с бюджетом, обрезает остаток |

Правила (чтобы не было двух реализаций одного и того же):

1. **Один источник.** Плагин не пишет факты в промпт в обход `MemoryProvider` и не дублирует recall
   «напрямую из хранилища»: доставка всегда идёт через `MemoryProvider` → `PromptBlockProvider`.
2. **Обязательность.** Минимальная связка «источник + доставка» = оба контракта. Плагин, который
   умеет только отдавать свёрстанный блок (например, читает готовый markdown-файл), может
   зарегистрировать **только** `PromptBlockProvider` — это легально, но тогда у него нет recall для
   тула и нет ingest для write-path.
3. **Бюджет — один, не два.** Значение задаётся в runtime-настройке «бюджет токенов на recall»
   (админ-категория «Память», §4) и **не дублируется** в настройках плагина. `MemoryProvider`
   обязан уложиться в `budget.maxTokens`; `PromptBlockProvider` передаёт бюджет в запрос и при
   обрезании ставит `status: 'truncated'`.
4. **Запрос (query) для тира `volatile`.** «Релевантное текущему ходу» требует текста последнего
   сообщения пользователя. Вариант (а) — расширить `PromptBlockContext` полем `query?` — **уже сделан**
   в PROP-090 §5 (2026-10-22): `query` — часть контракта, хост заполняет его текстом последнего
   сообщения пользователя. Варианты (б) (плагин читает сессию через API `sessions:read` — лишний
   трафик и своя точка доверия) и (в) (плагин помнит последний запрос у себя — не работает в
   `out-of-process` без явного состояния) — **отклонены**.
5. **Деградация.** Провал `recall` → блок пуст (`status: 'empty'`), ход не падает (правило деградации
   PROP-090 §5), в лог — `warning`. При `readiness: 'stale'|'unavailable'` блок помечается
   `provenance: 'plugin:<name>:stale'`, чтобы агент отличал «не нашлось» от «индекс не готов»
   (урок `projection_readiness` из Gbrain).

#### 1.4 Три канала доставки фактов в контекст

| Канал | Тир | Когда | Ломает prompt-cache? |
|---|---|---|---|
| **Блок «память»** (`promptBlocks`) | `context` | устойчивые факты (инварианты проекта, профиль владельца, принятые решения) | нет — тир `context` вне `stablePrefix` (`composer.ts:297-299`) |
| **Блок «вспоминание»** (`promptBlocks`) | `volatile` | релевантное текущему ходу (retrieval по последнему сообщению) | нет — но пересобирается каждый ход |
| **Тул `memory_search`** | — | агент сам решает, когда копать глубже | нет |

Тир `stable` для памяти **запрещён** (PROP-090 §5): он входит в кэшируемый префикс, и каждый
retrieval инвалидировал бы prompt-cache. Плагинные блоки рекомендуется ставить в `order ≥ 100`,
чтобы не спорить со встроенными (встроенные занимают 5–90 — PROP-090 §5).

#### 1.5 Write-path (запись в память)

- Хуки `post_tool_use` / `session_end` объявлены и эмитятся шиной `HookBus`, но payload не содержит
  контента сессии.
- `message_received` **объявлен** (`packages/shared/src/types/hooks.ts:15`), но **не эмитится** —
  остаток ADR-030, пункт **Ф0** PROP-090. Плагин подписывается на хуки через точку `hooks`
  (PROP-090 §4) — **правок в core для подписки не требуется**.
- Пока `message_received` нет, промежуточный вариант — state-сообщение типа `memory_recall`.
  **Честно:** `StateMessageType` — закрытый union (`packages/core/src/engine/context/state-messages.ts:20`:
  `mode_change | plan_updated | todos_updated | agent_switch`), поэтому такое сообщение требует
  **правки core** (расширение union + рендер) — то есть это уже не «без правок в core».
  Правильнее: дождаться Ф0 (`message_received`) либо писать через `ingest` плагина по событию
  `post_tool_use`.
- Форма записи факта — версия факта (§6): сырой факт не перезаписывается, а заменяется
  (`superseded_claim`), запись идемпотентна по `fact.id`.

#### 1.6 Что делать с точечной памятью

Существующие `project.log` / `project.invariants` / `sticky notes` / профиль — **не дублировать**:
оформить их как реализацию `MemoryProvider` (`builtin:sticky`) на существующих портах
(`ProjectStore`, `SessionRepository`, `ProfileStore`) и с теми же read-операциями. Это даёт единый
путь «спросить память» и убирает разнобой «три места, три API».

### 2. Ванильный RAG (реализация `MemoryProvider`, поставляемая плагином)

#### 2.1 Состав

| Компонент | Решение |
|---|---|
| Чанкер | собственный, **в составе плагина**; версия чанкера — часть фингерпринта индекса |
| Эмбеддинги | нужен порт `EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }` — **в коде нет**; реализация — поверх `ProviderPool` (`provider.embed`, как в `embedding-model.ts:155/200/217`) + transformers-fallback; **мульти-провайдерная** (нужна явная спека модели: id, размерность, нормализация) |
| Хранилище | факты и индексы — через доменный порт (ADR-096) + контрактный suite; backend'ы — `file` (JSON, атомарная запись) и `postgres`. **Открытый вопрос:** нужен ли отдельный порт `MemoryRepository` или хватит generic-`DocumentRepository<T>` (см. открытые вопросы) |
| Поиск | гибрид: keyword-arm + vector-arm + слияние RRF постранично (урок Gbrain) |
| Индекс | именованная сущность `MemoryIndex` — каталог индексов (t11-style, локальный → серверный) |

**Где это живёт в коде.** Ванильный RAG — **не** `packages/core/src/engine/memory/` и **не** отдельный
npm-пакет по умолчанию: это **реализация `MemoryProvider` внутри плагина** (`inline` или
`out-of-process`), поставляемая в виде бандла. Ядро получает только контракт и (возможно) порт
хранения; вся логика — чанкер, эмбеддинги, индекс, гибридный поиск, консолидация — в плагине и
проходит trust/scan (PROP-090 §9).

#### 2.2 Эмбеддинги и Gateway — и связь с `llmFilters`

**Решение владельца (2026-10-22): эмбеддинги идут через gateway-фильтры** — третья фаза
`llmFilters` (`embedding`, [PROP-090](./prop-090-extension-api.md) §6). Вариант «мимо Gateway, но с
аудитом» **не выбран**: обход gateway — дыра в инварианте 3 («любой LLM-вызов — через
`GatewayProvider`»), и для памяти это заметно — индексируется и запрашивается пользовательский текст.

Инвариант 3 сегодня **не покрывает** эмбеддинги: `EmbeddingModel` ходит в провайдера напрямую
(duck-типизированный `ProviderPool`), а `GatewayProvider.embed` (`gateway-provider.ts:269`) — прямой
вызов `_inner.embed` **без** guard'а, rate-limit, обфускации и аудита. Что это значит для памяти:

| Что | Как решается |
|---|---|
| Seam | новая ветка `GatewayProvider._prepareEmbedding` — вызывается из `embed()` **до** `_inner.embed` (PROP-090 §6, Ф3) |
| Что видит фильтр | тексты к эмбеддингу (`texts`), `provider`, `model`, `sessionId?` |
| Вердикты | `allow` — как есть; `deny` — эмбеддинг не уходит провайдеру; `redact` — тексты заменяются на `redactedTexts` (маскирование PII в корпусе) |
| Право вето | как в остальных фазах: только trust ≥ `trusted` (`deny`/`redact` от плагина ниже порога понижается хостом до `allow`) |
| Инвариант 3 | эмбеддинги **не обходят** gateway-контур: `embed` идёт через те же rate-limit/аудит, а микро-слой (`router/micro/models/embedding-model.ts:200,218`) перестаёт звать `provider.embed` напрямую — только `GatewayProvider.embed` |

Практический смысл для памяти: DLP/антивирус по корпусу («не индексировать этот файл/фрагмент»)
становится возможен — фильтр видит текст **до** эмбеддинга, а не после.

#### 2.3 Поиск: почему гибрид

По замерам Gbrain на BrainBench (145 relationship-вопросов): специализированный адаптер
P@5 0.3421 / R@5 0.9791; эталонный hybrid 0.1917 / 0.6874; keyword-only 0.1710 / 0.6244;
vector-only 0.1076 / 0.4069. **Один вектор — заметно хуже гибрида.** Отсюда:

- **keyword-arm** обязателен (имена, идентификаторы кода, точные фразы);
- **vector-arm** — семантика;
- **RRF** — слияние голосов (постранично: у страницы могут быть разные лучшие чанки);
- **rerank** (cross-encoder) — опционально, отдельная модель и цена;
- **evidence-контракт** — каждый результат помечается, чем он поддержан
  (`alias_hit` / `exact_title_match` / `high_vector_match` / `keyword_exact` / `weak_semantic`),
  чтобы агент не принимал keyword-совпадение за семантическое подтверждение.

### 3. Gbrain (класс Add-on)

**Два пути интеграции:**

| Путь | Что даёт | Стоимость | Риски |
|---|---|---|---|
| **А. Внешний сервис + плагин-адаптер** (рекомендуется первым) | вся зрелость Gbrain: hybrid retrieval, граф, schema-паки, dream cycle, provenance, свой MCP + `/admin` | плагин-адаптер `MemoryProvider` поверх MCP (`McpManager.callTool` уже есть, `engine/mcp/manager.ts:464`) + Add-on с MCP-регистрацией через `provides.mcp` | Gbrain — отдельный сервис и отдельная БД; синхронизация с порталом Synth; «не найдено» при неготовом индексе |
| **Б. Порт контракта `BrainEngine` на TS** | полный контроль, in-process, без сети | большой объём (140+ методов, SQL-специфика PGLite/PG, pgvector) | дублирование проекта, который живёт; риск отставания |

**Рекомендация:** идти путём **А**, держать путь **Б** открытым (контракт `MemoryProvider` это позволяет).
Gbrain — **Add-on**, не Plugin: он внешний сервис со своим MCP и админкой. Если от Gbrain потребуется
**двусторонний** канал (события из Gbrain в Synth), это уже класс **Gateway**
([ADR-087](./adr-087-gateways.md), [ADR-103](./adr-103-gateway-core-channel-contract.md)) — решение
принимается по факту, а не заранее.

**Ванильный RAG при этом не отменяется** — он нужен там, где внешнего сервиса нет (standalone без
GBrain, приватные данные, оффлайн), и как контрольный эталон: один и тот же корпус — два
провайдера — сравнение качества.

**Проброс контента Gbrain в промпт.** `gbrain think` даёт синтезированный ответ с цитатами и
gap-анализом («мозг не знает X») — это готовый «полезный факт» для блока `volatile`. Но: содержимое
памяти — **недоверенный ввод** (плюс `memory-boundaries` у Gbrain: embedding/rerank/extraction/
synthesis-провайдеры получают текст). Поэтому факты из памяти проходят **санитайзер защищённого тела**
(как `get_page` у Gbrain) и попадают в промпт с пометкой источника (`provenance`).

### 4. Портал управления памятью

**Размещение — гибрид (б + а):**

- **(б) center-tab верхнего уровня «Память»** — операционная часть. В UI **нет роутера**: экран
  определяется center-tabs в `useUIStore`; добавление вкладки = ровно 3 типизированные правки:
  `CenterTabType` (`packages/ui/src/stores/useUIStore.ts:31`), иконка в `TAB_ICONS`
  (`packages/ui/src/components/layout/CenterTabs.tsx:28`), `case` в `renderTabContent`
  (`packages/ui/src/components/layout/CenterPanel.tsx:44-60`). Прецедент — `pipeline` / `pipeline-run`.
  Под-режимы: **Индексы** (список/CRUD/статус/готовность/поколение), **Факты** (просмотр/правка/
  коррекция/отзыв/источник), **Задачи** (фоновые консолидации, live-прогресс), **Граф** (self-wiring
  граф на `@xyflow/react` — библиотека уже в бандле, IR и адаптер свои).
- **(а) админ-категория «Память»** в Настройках — **отдельная группа с разделами** (раскладка — §4.1):
  мастер-включение, дефолты индекса, провайдеры по умолчанию, retention, лимиты, бюджет токенов на
  recall. По образцу `metrics` / `addons` (`packages/ui/src/lib/settings-catalog.ts`).
- **Не микрофронтенд/отдельный пакет** — прямо противоречит архитектуре: один транспорт
  (инвариант 6), один словарь i18n с тестом паритета, один app-shell/SW (ADR-044), `@itphx/synth-ui`
  — «не библиотека» (`packages/ui/AGENTS.md`).

**Кто что делает: API — плагин, UI — встроенный.** Точка **UI-slot** в PROP-090 §4 **отложена**
(в SPA нет стабильной точки монтирования сторонних React-компонентов), поэтому произвольный UI
плагина невозможен. Значит:

- **API** (`/api/v2/memory/*`) — роут **плагина** через точку `routes` (PROP-090 §4, п. 4): фабрика
  `createMemoryRoutes(auth, deps, opts)` по образцу `createXxxRoutes` ([ADR-017](./adr-017-api-v2-hono.md)),
  контракт — `docs/API_V2.md`;
- **UI** — встроенный экран в `@itphx/synth-ui`, работающий с любым плагином, реализовавшим
  `MemoryProvider` с capability `admin`.

Набор эндпоинтов (предлагаемый): `GET /api/v2/memory/providers`, `GET|POST /api/v2/memory/indexes`,
`PATCH|DELETE /api/v2/memory/indexes/:id`, `POST /api/v2/memory/indexes/:id/rebuild`,
`GET|PATCH /api/v2/memory/facts[/:id]`, `GET /api/v2/memory/jobs`,
`POST /api/v2/memory/jobs/:id/cancel`, `GET|PUT|DELETE /api/v2/settings/memory`.

**Live-обновления** — **без нового транспорта**: события `memory.*` публикуются в **инстансный**
канал шины (`EventBus.publishInstance`, `packages/core/src/events/bus.ts:71`), UI обрабатывает их
префиксной веткой в `transportStore.createDispatcher` — **до** проверки `sid`, ровно как
`pipeline.*` (`packages/ui/src/stores/transportStore.ts:105-108`).

**Права (паттерн «роут-фабрика в core + опции в backend»):**

| Операция | core | managed (backend) |
|---|---|---|
| список индексов/фактов/задач | `requireAuth` | `requirePermission('ADMIN')` |
| мутации (создать индекс, правка факта, запуск консолидации) | `requireAuth` | `requirePermission('ADMIN')` + `requireAdminRoleOrScope('automation:install')` (тот же зонтичный scope, что у пакетов и пайплайнов) |
| project-scoped | — | проекция `allowedProjects` (ADR-052) |

**Gbrain и портал.** У Gbrain **свой** `/admin` (управление клиентами, OAuth, разрешениями). Дублировать
его в Synth нельзя и не нужно: портал Synth показывает **сводку и управление своим контуром**
(индексы Synth, провайдеры, фоновые задачи, факты), а «глубокое» управление внешним Gbrain —
явная ссылка на его админку (URL из конфига), без iframe.

#### 4.1. Раскладка настроек памяти

**Решение владельца (2026-10-22): память — отдельная группа и разделы в админской части настроек;
в пользовательской части — отдельный раздел с базовыми настройками (обсуждается отдельно).**

*Админ-часть* (Настройки → Администрирование → категория «Память», `roles:['ADMIN']`, по образцу
`metrics`/`addons`, [ADR-072](./adr-072-settings-ui-kit.md)) — **группы/разделы**:

| Раздел | Что внутри |
|---|---|
| **Провайдеры** | подключённые `MemoryProvider` (плагины), их capability (`recall`/`ingest`/`index`/`consolidate`/`graph`), статус готовности, провайдер по умолчанию |
| **Индексы** | список индексов, поколение, фингерпринт эмбеддинга, статус (`building`/`ready`/`stale`/`failed`), пересборка |
| **Факты** | просмотр/правка/коррекция/отзыв, `provenance`, версия факта |
| **Консолидация** | расписания и фоновые прогоны пайплайнов-консолидаций, live-прогресс, отмена |
| **Лимиты и бюджеты** | мастер-включение памяти, retention, лимит токенов на recall, лимиты индексации, квоты корпуса |

*Пользовательская часть* — **отдельный раздел** (не админ-категория) с базовыми настройками.
**Какие именно — предмет отдельного обсуждения** (на 2026-10-22 не решено). Кандидаты:

| Кандидат | Зачем |
|---|---|
| Провайдер памяти по умолчанию | свой провайдер вместо инстансного |
| Лимит токенов на recall | сколько контекста агент тратит на память |
| Вкл/выкл память для своих сессий | пользователь решает, помнить ли его диалоги |
| Объём истории | сколько прошлого удерживать в памяти |

**Пользовательский раздел не входит в первую волну** (М0–М1) и **не входит в объём текущего
решения**: обсуждается отдельно (состав, дефолты, RBAC, хранение — user-level runtime или профиль).
До отдельного решения в админ-категории остаются только те настройки, которые нужны админу.

### 5. Фоновые процессы консолидации

#### 5.1 Где крутятся

| Среда | Где исполняется консолидация |
|---|---|
| **standalone** | в процессе core: очередь + тикер + graceful shutdown (ADR-092: graceful, exit 75 при перезапуске) |
| **managed, multi-replica** | один реплика исполняет, остальные ждут — **лидер-элекшен через `StorageContext.locks`** (`PgLeader`, `packages/storage-postgres/src/locks.ts:172`); для файлового бэкенда — файловый лок по образцу `FileLeader` (`engine/scheduler/leader.ts:40`) |
| **провайдер = внешний (Gbrain)** | **на стороне Gbrain** (его dream cycle); Synth только **запрашивает** запуск и **наблюдает** статус — исполнять нечего |
| **jobs, требующие shell/инструментов** (переиндексация кода `rg`, выгрузка) | **исполнитель** (ADR-077), а не control plane — в managed работа уходит в executor |

#### 5.2 Движок работы

**Пайплайн (ADR-101) — не изобретать новый job-движок.** Уже есть: свой Tool-Use-цикл, `GatewayProvider`
для LLM, permission-слой, HITL-гейты с таймаутом, append-only журнал, метрики `synth_pipeline_*`,
отмена, версия спецификации + **снимок спецификации в прогоне** (повторяемость бесплатно).
`PipelineEngine.run()` (`packages/core/src/engine/pipelines/engine.ts:215`) — обычный метод.
Виды шага: `agent` / `tool` / `script` / `human` (`packages/shared/src/types/pipeline-engine.ts:37`).

**Схема запуска:**

```
SchedulerService (ADR-051: cron + leader + catch-up)
  └─ публикует {source:'cron', type:'schedule_fired'}
       └─ EventRouter / RouteRule (ADR-089) → цель: пайплайн (PipelineRef в цели маршрута,
          packages/shared/src/types/events.ts:112)
            └─ PipelineEngine.run({trigger:{kind:'schedule'}})
                 └─ шаги: agent (LLM-консолидация) → tool (memory_write/memory_index)
```

`PipelineRunTrigger.kind` уже включает `'schedule'` (`types/pipeline-engine.ts:282`) — семантика
родная.

**Кто поставляет определение пайплайна.** Плагин памяти объявляет консолидацию в манифесте
(`provides.pipelines`) — установщик пакета ставит её (`server/routes/packs.ts:660`), движок исполняет
(ADR-101), шедулер запускает (ADR-051; точка `schedules`, PROP-090 §4). Это связка
«`provides.pipelines` + движок пайплайнов» без новой подсистемы.

**Консолидация — это пайплайн, а не шедулер.** Шедулер умеет «когда», но не «что» (ADR-051: он только
публикует событие). **PROP-097 (реестр фоновых процессов) для этого не нужен** — он про `execute_shell`
в фоне; для консолидации нужен job с журналом и отменой, а это уже пайплайн.

**Идемпотентность и повтор.** Прогон дедуплицируется по `dedupKey` (как у шедулера:
`cron:<id>:<минута>`), leader-элекшен не даёт двум репликам начать одно и то же, а версия
спецификации + её снимок в прогоне делают повтор воспроизводимым.

#### 5.3 Версионирование — шесть независимых осей

> Главная ошибка в таких подсистемах — одна «версия» на всё. Разводим явно:

| Ось | Что версионируется | Где | Механика |
|---|---|---|---|
| **1. Схема данных памяти** | формат записей памяти/фактов/индексов | `memory.schemaVersion` | свои миграции по образцу ADR-092: файл — `meta.json` + реестр `MIGRATIONS`, PG — `synth_schema_migrations`; fail-closed при «схема новее драйвера» |
| **2. Поколение индекса** | сборка индекса | `index.generation`, `index.state` | поколения `building → ready → stale → failed`; сборка идёт в **новое** поколение, переключение указателя — атомарное (как `publishedVersion` у пайплайнов); **читатель никогда не видит полу-собранный индекс** |
| **3. Фингерпринт эмбеддинга** | пригодность вектора | `embeddingInputHash` | по образцу Gbrain: хэш от (колонка, модель, размерность, режим обёртки, текст) — вектор переиспользуется **только** при совпадении; иначе индекс помечается `stale` и требует пересборки |
| **4. Версия факта** | отдельное утверждение | `fact.version`, `supersededBy`, `validUntil`, `provenance`, `confidence` | **коррекция и отзыв — первоклассные операции**; сырой факт не перезаписывается, а заменяется (`superseded_claim`); как в Gbrain (`forget-then-remember` 92% → 100% с facts-arm) |
| **5. Версия контракта провайдера** | совместимость | `provider.contracts` + семвер-гейт `contracts`/`host` | тот же приём, что в PROP-090 §10 (шаг 3): несовместимая версия → плагин **не активируется**, память деградирует (пусто, без падения) |
| **6. Версия схемы-пака памяти** | типы страниц/схема фактов | `packVersion` + `migration_from` | если используются schema-паки (типы страниц как у Gbrain) — свой апгрейд с миграцией, а не смена на лету |

Плюс **версия самой консолидации** — это версия пайплайна (`pipelineId@version` + снимок
спецификации в прогоне): журнал, повтор и «что именно тогда изменилось» — бесплатно.

**Readiness вместо «нет результата».** Если индекс не готов (`building`) или устарел (`stale`),
recall возвращает `readiness: 'degraded' | 'stale'`, а **не** пустой список — иначе агент примет
«не найдено» за истину (ровно проблема `projection_readiness` в Gbrain).

### 6. Наблюдаемость

Своя серия `synth_memory_*` — **в контракте ADR-094**: счётчики recall'ов и попаданий кэша,
гистограммы задержки recall и индексации, gauge числа индексов/фактов/готовности. Никаких
`session_id`/`user_id`/сырых путей в лейблах (инвариант 25). Плагин **не может** завести свои
лейблы метрик (PROP-090 §12) — значит, регистрация серии `synth_memory_*` — правка core-реестра
(ADR-094), а не плагина. События — `memory.*` в инстансном канале (см. §4).

## Статус реализации в коде

**Не реализовано.** Проверено точечным grep по `packages/**` (без `dist/`, `node_modules/`):

- подсистемы памяти нет: grep по `gbrain`, `pgvector`, `MemoryProvider`, `MemoryIndex`, `MemoryFact`,
  `PromptBlockProvider` — совпадений в продуктовом коде нет;
- реестра prompt-блоков нет — `_collectBlocks` (`composer.ts:426-646`) хардкодит блоки; сама точка
  `promptBlocks` проектируется в PROP-090 §5 (**Ф3**);
- порта памяти нет: в `packages/core/src/storage/ports/` — **34 доменных порта**; порта эмбеддингов нет;
- `pgvector` в драйвере нет — только `pg_trgm` (`packages/storage-postgres/src/migrations/001-init.ts:18`);
- `ToolCapability.MEMORY` нет (`packages/shared/src/types/tools.ts:3-15`), `TOOL_CAPABILITY_META` без него;
- **слоя плагинов в коде нет**: нет `PluginHost`, `@itphx/synth-plugin`, `definePlugin`,
  `plugins.lock.json`, `plugins.json`, `/api/v2/plugins*`, CLI `synth plugin *`, `RuntimeSettings.plugins`,
  точек `promptBlocks`/`llmFilters`; фазы Ф0–Ф7 PROP-090 **не начаты**;
- `PACK_TYPES` **содержит** `'memory'` (`packages/shared/src/types/pack.ts:52`; список — `:42-56`), но
  установщик пакета (`server/routes/packs.ts`) умеет только скиллы/MCP/агенты/пайплайны, а
  `provides.promptBlocks[]`/`provides.llmFilters[]`/`provides.tools[]` в схеме **нет**
  (`provides` — `packProvidesSchema` (`:227`) с `.passthrough()`; явные Zod-схемы — **Ф0** PROP-090);
- `message_received` — объявлен (`packages/shared/src/types/hooks.ts:15`), **не эмитится** (остаток
  ADR-030, **Ф0** PROP-090); `StateMessageType` — закрытый union
  (`packages/core/src/engine/context/state-messages.ts:20`);
- эмбеддинги идут мимо `GatewayProvider`: `GatewayProvider.embed`
  (`packages/core/src/engine/gateway/gateway-provider.ts:269`) — прямой вызов `_inner.embed`;guard/аудит/
  обфускация не применяются; `EmbeddingModel`
  (`packages/core/src/engine/router/micro/models/embedding-model.ts`) зовёт `provider.embed` напрямую
  через duck-типизированный `ProviderPool` (`:155`, вызовы `:200`, `:217`). Фильтры `llmFilters` к
  эмбеддингам **не применяются** — третья фаза `embedding` вводится в **Ф3** PROP-090 (§2.2): до
  этого эмбеддинги не видны фильтру;
- `ContextOptimizer` (`packages/core/src/engine/context/optimizer.ts`) — summary-кэш в памяти процесса,
  суммаризация через `GatewayProvider` (`_wrapWithGateway`, `:633-645`); это **не** память;
- `ContextSource` в `shared/src/types/provider.ts:64` — **не** шов промпт-блоков (это метаданные
  модели: `'api'|'reference'|'manual'|'unknown'`).

**Существующая точечная память** (не дублировать, обернуть в `MemoryProvider`):
`project.plan` / `project.log` / `project.invariants` (`ProjectStore`), sticky notes
(`SessionRepository`), профиль (`ProfileStore` → блок `profile`), `ContextOptimizer`
(сжатие истории, **не** память).

## Фазы

**Порядок.** Память начинается **после Ф3** PROP-090 (реестр `promptBlocks`) — иначе памяти не на чём
строить; М1 дополнительно требует **Ф5** (install/activate). М0 (контракты) может идти **параллельно**
с Ф0–Ф2: сами типы от слоя плагинов не зависят.

| Фаза | Содержание | Зависимость от PROP-090 | Критерий приёмки |
|---|---|---|---|
| **М0 — контракт `MemoryProvider`** | типы `MemoryProvider`/`MemoryIndex`/`MemoryFact`/`RecallRequest`/`RecallResult` + `readiness` — **в `@itphx/synth-shared`** (отдельный npm-пакет не создаётся, §1.2); манифест памяти (`kind:"plugin"`, `provides.promptBlocks`); Zod-схемы `provides.promptBlocks[]` **и `provides.tools[]`** (последней нет в PROP-090 §8 — без неё правило «регистрации обязаны совпадать с `provides`» ломается на туле `memory_search`) | типы — независимы; схемы `provides` — вместе с **Ф0** | типы собраны; `validatePackManifest` принимает манифест памяти (и отклоняет `tier: 'stable'`); тест контракта `MemoryProvider` (recall/ingest/admin, readiness) |
| **М1 — первый плагин памяти** | плагин `builtin:sticky` (точечная память: `project.invariants`/sticky/profile); `PromptBlockProvider` (тир `context`); обвязка `MemoryProvider`; тул `memory_search` + `ToolCapability.MEMORY`; API роутов плагина (точка `routes`) + настройки (точка `settings`); портал-каркас (center-tab «Память» → «Индексы»/«Факты») + админ-категория «Память» (группы/разделы — §4.1; **пользовательский раздел — не в первой волне**) | после **Ф3** (реестр `promptBlocks`) и **Ф5** (install/activate) | факты из `project.invariants`/sticky/profile попадают в блок `context`; `stablePrefix` не меняется (prompt-cache цел); тул доступен агенту по capability; ошибка провайдера не роняет ход (warn → пустой блок); негативная RBAC-матрица |
| **М2 — ванильный RAG** | чанкер + `EmbeddingProvider` + индекс (file-бэкенд) + гибридный поиск (keyword + vector + RRF) + evidence-контракт + readiness/stale; rebuild с фингерпринтом; API индекса/фактов; портал «Индексы» (создание/пересборка/статус) | после М1 | один корпус — один индекс; `rebuild` после смены модели эмбеддинга → индекс `stale` → пересборка; пустой результат при неготовом индексе ≠ «не найдено» (`readiness`) |
| **М3 — Gbrain-адаптер** | Add-on Gbrain + MCP-регистрация через `provides.mcp`; плагин-адаптер `MemoryProvider` (вызовы `search`/`recall`/`think`); сквозной сценарий «задать вопрос → факты в промпте»; сравнение качества RAG-провайдера и Gbrain на одном корпусе | после М1 (+ Add-on/MCP) | recall Gbrain даёт факты с цитатами и `evidence`; при недоступном Gbrain — деградация без падения сессии; замеры на общем корпусе |
| **М4 — фоновые процессы** | воркер + лидер-элекшен (`StorageContext.locks`); пайплайн-консолидация, объявленный плагином (`provides.pipelines`); маршрут расписания → пайплайн; журнал и метрики `synth_pipeline_*` + `synth_memory_*`; портал «Задачи» с live-прогрессом; отмена | после М1 (+ ADR-101/ADR-051) | два экземпляра в managed → консолидация выполняется **одна**; прогон воспроизводим (снимок спецификации); журнал читается через API; live-события доходят до портала |
| **М5 — граф памяти** | IR графа + чистый адаптер ↔ `@xyflow/react`; извлечение связей `[[entity]]` **без LLM**; портал «Граф»; типизированные рёбра | после М2 | round-trip IR↔граф без потерь (тест); извлечение рёбер не тратит LLM-токены |

## Открытые вопросы

> Закрыто решениями владельца продукта 2026-10-22: **эмбеддинги — через gateway-фильтры**
> (третья фаза `llmFilters`, PROP-090 §6); **контракт `MemoryProvider` — в `@itphx/synth-shared`**
> (отдельный npm-пакет `@itphx/synth-memory` не создаётся, реализации — плагинами).

1. **Срок решения PROP-047: vision → actionable?** Память по-прежнему не в коде, и её объём
   (М0–М5) заметно больше, чем у одного документа. **Рекомендация:** перевести в actionable с
   `Решение до: 2026-11-14` — тем же днём, что и PROP-090, чтобы решения принимались одним пакетом;
   альтернатива — оставить vision до Ф3, и тогда «Решение до» не нужен вовсе.
2. **Векторы в PostgreSQL** — `pgvector` (нужна новая миграция + право `CREATE EXTENSION` в БД: в
   K3s/managed это отдельная операция) или `jsonb`/`real[]` + перебор (без новых прав, медленнее на
   больших корпусах)? **Рекомендация:** по умолчанию keyword-arm на имеющемся `pg_trgm` + векторы в
   `jsonb`, `pgvector` — опциональный флаг.
3. **Как плагин сохраняет факты** — новый доменный порт `MemoryRepository` в core (ADR-096 + контрактный
   suite + реализация в PG-драйвере по ADR-097) или переиспользование generic-`DocumentRepository<T>`
   (`load`/`save`/`delete`/`list` по ключу) без новых портов? **Рекомендация:** `MemoryRepository` —
   инвариант 2 запрещает запись в `$SYNTH_DATA_DIR` мимо порта, а факты нужны с запросами, которых
   generic-порт не даёт. Оговорка: порт — это правка **слоя хранения**, а не «память в ядре»: логика
   (чанкер, эмбеддинги, поиск, консолидация) остаётся в плагине.
4. **«Company brain» и границы видимости** — как память ложится на профили Synth (ADR-045/ADR-079) и
   какие границы видимости (своё / общее / приватное; per-user vs per-project)? **Рекомендация:** первая
   волна — строго per-project + per-owner, «общий мозг» — отдельная задача (свой scope на уровне
   instance и правила доступа в портале).
5. **Запись памяти (write-path)** — ждать `message_received` (Ф0 PROP-090) или расширять
   `StateMessageType` (правка core, `state-messages.ts:20`)? **Рекомендация:** Ф0 — не плодить
   параллельный механизм записи.
6. **Obsidian Bridge** (двусторонняя синхронизация `.md`) — в объём М2–М5 (как отдельный
   `MemoryProvider`-адаптер + контент-пак) или отдельная задача? **Рекомендация:** отдельная задача —
   Bridge ложится на контракт `MemoryProvider` без изменений ядра.
7. **Сжатие tool output** (TokenJuice/RLM, GPL ⇒ только идея) — часть памяти или отдельная задача?
   **Рекомендация:** [PROP-062](./prop-062-context-optimization.md) — это про оптимизацию контекста,
   а не про память; связь (архив контекста → память) остаётся потребительской.
8. **Состав пользовательского раздела настроек памяти** (§4.1) — какие именно базовые настройки
   входят (кандидаты перечислены: провайдер по умолчанию, лимит токенов на recall, вкл/выкл памяти
   для своих сессий, объём истории), их дефолты, RBAC и где хранятся (user-level runtime или профиль).
   **Обсуждается отдельно; в первую волну (М0–М1) не входит.**
9. **Пакет памяти и контент-пак `packType: 'memory'`** — кто отвечает за установку декларативной части
   (схема фактов, шаблоны, скилл «как пользоваться памятью») и как она соотносится с плагином-поставщиком
   `MemoryProvider`: один пакет (контент + код) или два (контент-пак + плагин)?

## Связи

- [PROP-090](./prop-090-extension-api.md) — слой плагинов: **канон** для памяти (манифест `synth.pack`
  `kind: "plugin"`, точки `promptBlocks`/`tools`/`hooks`/`routes`/`settings`, два режима исполнения,
  модель доверия, фазы Ф0–Ф7); контракт `MemoryProvider` — в `@itphx/synth-shared`, реализации — плагинами.
- [ADR-086](./adr-086-extensibility-plugins-editions.md), [ADR-100](./adr-100-extension-packs-pipelines.md),
  [PROP-068](./prop-068-skills-agents-registry.md) — классы расширений, `synth.pack`, `packType:'memory'`,
  модель доверия.
- [ADR-087](./adr-087-gateways.md), [ADR-103](./adr-103-gateway-core-channel-contract.md) — внешние
  сервисы и контракт канала (Gbrain как Add-on; Gateway — если понадобится двусторонний обмен).
- [ADR-030](./adr-030-hooks-agent-events.md) — hook-шина (write-path; остаток — Ф0 PROP-090).
- [ADR-096](./adr-096-storage-layer.md), [ADR-097](./adr-097-storage-provider-class.md) — доменные порты
  и контрактный suite (место фактов и индексов).
- [ADR-070](./adr-070-system-prompt-composer.md) — тиры `stable`/`context`/`volatile`, граница
  prompt-cache; память обязана быть вне `stable`.
- [ADR-036](./adr-036-llm-gateway.md) — Gateway: LLM-вызовы консолидации — только через Gateway;
  эмбеддинги идут через **gateway-фильтры** (embedding-фаза `llmFilters`, PROP-090 §6) — инвариант 3.
- [ADR-097](./adr-097-storage-provider-class.md) — физический storage backbone; `pgvector` живёт в
  этом же контуре.
- [ADR-026](./adr-026-subagent-context-modes.md) — режимы контекста саб-агента, питаются памятью.
- [PROP-062](./prop-062-context-optimization.md) — потребитель памяти (архив контекста → память);
  сжатие tool output — его зона.
- [ADR-101](./adr-101-pipeline-engine.md), [ADR-051](./adr-051-scheduler-pipelines.md) — движок фоновой
  работы и расписание.
- [PROP-097](./prop-097-background-processes-registry.md) — реестр фоновых процессов (для `shell`,
  не для консолидации).
- [ADR-072](./adr-072-settings-ui-kit.md) — админ-категория «Память».
- [ADR-024](./adr-024-eventhub-transport.md), [ADR-094](./adr-094-observability-metrics.md) — транспорт
  и метрики.
- [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — версия схемы данных и graceful restart.
- [ADR-025](./adr-025-plan-act-toggle.md), [ADR-029](./adr-029-granular-permissions.md) — тул
  `memory_search` подчиняется permission-слою; доступность — по capability.
- [ADR-052](./adr-052-public-api-platform.md) — проекция `allowedProjects` для портала памяти.
- [ADR-099](./adr-099-egress-tls-trust.md) — исходящие вызовы внешней памяти идут через общий
  egress-слой.
- [PROP-085](./prop-085-multimodal-input.md) — RAG по изображениям (D27).
- Потребители памяти: [PROP-057](./prop-057-loop-engine.md) (Loop Engine),
  [PROP-058](./prop-058-service-agents-council.md) (Council),
  [PROP-063](./prop-063-user-learning-metrics.md) (обучение и метрики),
  [PROP-065](./prop-065-ui-docs-plan-todo.md) (просмотр доков и планов),
  [PROP-067](./prop-067-org-guidelines-defaults.md) (организационные гайдлайны как память).
- Внешние референсы: Gbrain (`github.com/garrytan/gbrain`, MIT), `tinyhumansai/openhuman` (GPL-3.0 —
  только идеи), SuperContext (GPL — только идеи), MemPalace; прототип `~/dev/aic/t11/synth/app/embeddings/`.

## История

- 2026-10-22 — предложена архитектура «память как провайдер» (`MemoryProvider` в обход Extension API,
  пока PROP-090 в Icebox) — черновик, не принят.
- 2026-10-22 — переписано под слой плагинов (PROP-090 возвращён в работу): память — **плагин**,
  `MemoryProvider` — контракт, доставляемый плагином; «обход Extension API» снят; отдельная точка
  `memory` не заводится.
- 2026-10-22 — решения владельца: контракт `MemoryProvider` — **в `@itphx/synth-shared`** (отдельный npm-пакет не создаётся, реализации — плагинами); **эмбеддинги — через gateway-фильтры** (третья фаза `llmFilters`, PROP-090 §6); настройки памяти — админ-категория «Память» с группами/разделами + отдельный **пользовательский** раздел (состав обсуждается отдельно, в первую волну не входит).
