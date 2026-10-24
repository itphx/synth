# Память Synth: плагин памяти — устройство и возможности

> **Назначение.** Этот файл — устройство подсистемы памяти: из чего состоит плагин памяти, какие
> возможности он даёт, на какие точки слоя плагинов опирается и чего слою не хватает. Решение
> (зачем память, какие альтернативы отвергнуты) — [PROP-047](./arch_decisions/prop-047-memory-gbrain.md);
> канон слоя плагинов — [ADR-090](./arch_decisions/adr-090-extension-api.md); руководство автора
> плагина — [PLUGINS.md](./PLUGINS.md).
> **Статус:** проектирование. Ядро: порты памяти (М0), сервисы фасада (М0.5), портал чтения
> (`createMemoryRoutes`) и метрики `synth_memory_*` — реализованы; логика памяти (чанкер, эмбеддинги,
> retrieval, консолидация) — в плагине, его нет.
> **Обновлено:** 2026-10-24.

## 1. Что это и где граница

**Память — плагин, а не подсистема ядра.** Ядро даёт три вещи: **точки доставки** (блоки промпта,
тулы, фильтры), **контракты** (типы в `@itphx/synth-shared`) и **порты хранения** (ADR-096).
Всё остальное — чанкер, эмбеддинги, индекс, гибридный поиск, консолидация, портал — в плагине.

| Что | Где | Почему так |
|---|---|---|
| Контракты `MemoryProvider`/`MemoryFact`/`MemoryIndex` | `@itphx/synth-shared` (М0) | нужны и ядру (реестр провайдеров, портал), и плагинам-поставщикам; оба уже зависят от `shared` |
| Регистрация в промпт/тулы | точки `promptBlocks` / `tools` (ADR-090, точка Ф3) | существующие реестры ядра, правок не требуют |
| Логика памяти (RAG, консолидация, адаптеры) | бандл плагина | не расширяет ядро; проходит trust/scan/install-policy |
| Факты и индексы | доменные порты ядра (М0) — **предпосылка A** (§2.1) | инвариант 2: писать в `$SYNTH_DATA_DIR` мимо порта нельзя; плюс бэкап, `storage migrate`, PG, retention — бесплатно |
| Портал (UI) | встроенный экран `@itphx/synth-ui` | точка UI-slot отложена (ADR-090 §7); экран работает с любым провайдером |

**Класс расширения — Plugin** (`kind: "plugin"`), два режима (ADR-090 §7):

| Режим | Что в нём | Почему |
|---|---|---|
| `inline` | регистрация блоков и тулов, лёгкие адаптеры, «клей» между провайдерами | горячий путь каждого хода; round-trip на блок промпта недопустим |
| `out-of-process` (`remote`) | тяжёлый RAG-движок (локальные эмбеддинги, чанкинг больших корпусов), сетевой адаптер Gbrain | падение/утечка памяти не роняет core; ограничения CPU/памяти — вне первой волны |

**Чего память не делает.** Не дублирует то, что ядро уже отдаёт в промпт: `project.invariants`
(блок `session.info`), sticky notes (блок `sticky`), профиль (блок `profile`). Эти блоки существуют
(`engine/context/builder.ts`, `engine/context/composer.ts`), и второй такой же блок от плагина был бы
дублем. Задача плагина — то, чего у ядра нет: **семантический recall по корпусу**, **факты с
provenance и коррекцией**, **внешняя память**.

## 2. Что даёт слой плагинов и что уже готово

**ADR-090** (✅) — три точки регистрации: `promptBlocks`, `llmFilters`, `tools`. Доступ к ресурсам
инстанса сделан **сервисами фасада** ([ADR-107](./arch_decisions/adr-107-plugin-facade-services.md), ✅):
`facade.memory`, `facade.embed`, `facade.getSettings`. Сервисы доступны **только `inline`** — wire-протокол
v1 покрывает три точки.

| Потребность памяти | Статус | Чем закрыто |
|---|---|---|
| Recall по текущему ходу | ✅ | `promptBlocks` (`query` — часть контракта) |
| Устойчивые факты в промпте | ✅ | `promptBlocks`, тир `context` |
| Поиск / запись / отзыв по запросу агента | ✅ | `tools` (`memory_search` / `memory_write` / `memory_forget`) |
| **Персистентность фактов и индексов** | ✅ | порты `MemoryFactRepository`/`MemoryIndexRepository` (memory/file/PG, миграция `017-memory`, вектор — `jsonb`) + `facade.memory` со scoped-доступом по namespace |
| **Эмбеддинги** | ✅ | `facade.embed` → `GatewayProvider.embed` (guard, аудит, embedding-фаза `llmFilters`); лимиты 64/8 000/64 000; конфиг `plugins.embedding*` |
| **Настройки плагина** | ✅ | `facade.getSettings` — `plugins[<имя>].settings` из `plugins.json`, `{}` по умолчанию |
| Доступ к internals ядра из тулов | ✅ закрыто | `narrowToolContext`: плагинный тул получает только `sessionId`/`messageId`/`workingDir`/`agentRole?`/`abortSignal?` |
| Автоматический ingest | 🟡 пакетный | пайплайн (ADR-101): `read_session_reference` → шаг `agent` → `plugin_<ns>_memory_write`; реалтайм по `message_received` — нет |
| API портала | ✅ чтение | `createMemoryRoutes` в ядре: `/api/v2/memory/{status,facts,facts/:id,indexes}` (ADR-107); операции провайдера — через его админ-тул (конвенция вызова — открытый вопрос §13) |
| События `memory.*` в UI | ❌ | у плагина нет шины; публиковать должен ядро |
| Метрики `synth_memory_*` | ✅ | ADR-094: плагин не заводит метрик — серия регистрируется в ядре (`metrics/collectors/memory.ts`) |

### 2.1. Что осталось до первой волны памяти (М1)

1. **Портал в ядре** — `createMemoryRoutes` поверх портов (чтение фактов/индексов/задач) + операции
   провайдера через его админ-тул. Конвенция серверного вызова тула — открытый вопрос (§13).
   ✅ **чтение сделано**: `createMemoryRoutes` (`server/routes/memory.ts`) — `/api/v2/memory/{status,
   facts,facts/:id,indexes}`; namespace плагина подставляет сервер, чтение — `requireAuth` (core) /
   `ADMIN` (managed). ❌ Осталось: операции провайдера (правка/отзыв факта, пересборка индекса) и
   вызов админ-тула из core-роута.
2. **Метрики** — серия `synth_memory_*` в реестре ядра (ADR-094). ✅ **сделано**:
   `synth_memory_facts{status}` и `synth_memory_indexes{status}` (`metrics/collectors/memory.ts`),
   пересчёт на скрейпе; без порта серии не публикуются.
3. **События** — публикация `memory.*` в инстансный канал из ядра (прогресс консолидации для UI).
   ❌ не начато.
4. **Контракт `MemoryProvider`** (`recall`/`ingest`/`admin`, `readiness`) — нужен, если появится
   **реестр** провайдеров и портал над несколькими. Для одного плагина не обязателен: порт + фасад
   закрывают М1. ❌ не начато (в портале М1 readiness считает ядро по состоянию индексов).

### 2.2. Граница исполнения (важно для дизайна плагина)

`facade.memory`/`embed`/`getSettings` есть **только у `inline`**. `out-of-process`-плагин получает по
проводу `{sessionId, messageId, workingDir}` и три точки регистрации — поэтому тяжёлый движок либо
живёт в `inline`, либо (если это внешний сервис вроде Gbrain) держит своё хранилище у себя и в портах
памяти не нуждается.

Практический вывод: **ванильный RAG — `inline`** (ему нужны порты и `facade.embed`), **Gbrain —
`remote`** (своё хранилище, только три точки).

### 2.3. М2 — решения (ванильный RAG)

Зафиксировано до реализации, чтобы не расходились тул, блок и портал.

| Вопрос | Решение |
|---|---|
| Источники корпуса | `files` — текстовые файлы `project.workspace` (относительные пути, glob-фильтр, лимит размера файла) и `facts` — активные факты проекта. Внешние источники — М3 (`remote`-провайдер) |
| Идентификатор индекса | `idx_<uuid>`; по умолчанию один индекс на (проект, источник), имя `project` |
| Чанкер | markdown-aware (заголовки + абзацы), `chunkChars` 1200 / `chunkOverlap` 200, `chunkerVersion: '1'` входит в фингерпринт |
| Эмбеддинги | **только** `facade.embed` (Gateway, инвариант 3), батч ≤ 32 текста; модель — из `plugins.embedding*`; нет модели → индекс не строится (`plugin.embedding_not_configured`), recall деградирует на keyword |
| Фингерпринт | `model` + `dimension` + `chunkerVersion` (+ `normalize`); расхождение с текущей конфигурацией → `state: 'stale'` (не «тихо похоже») |
| Поколения | сборка пишет `generation + 1` через `replaceChunks` (атомарно), затем `saveIndex({state:'ready', generation})`; предыдущее поколение удаляется после переключения |
| Гибридный поиск | keyword (BM25-lite по чанкам) + cosine по векторам → **RRF** (`k = 60`) → top-N; при отсутствии векторов — только keyword |
| Evidence | каждый результат: `indexId`, `generation`, путь (`metadata.path`), диапазон строк, score; модель видит источник, а не «магию» |
| Мутации портала | конвенция: HTTP-роут (guard ADMIN) → админ-тул плагина через реестр (`executeToolDef`, контекст `sessionId: 'system:memory-portal:<id>'`, `projectId`, `workingDir` = `project.workspace`); плагин не активен → `409 MEMORY_PROVIDER_UNAVAILABLE` |
| Сборка индекса | фоновая: ответ `202` + `indexId`, прогресс — по `state` (`building` → `ready`/`failed` + `error`); отдельного job-хранилища в М2 нет |
| Настройки плагина | `factsLimit`, `recallLimit`, `minScore`, `topK`, `maxChunks`, `chunkChars`, `chunkOverlap`, `maxFileBytes`, `exclude` (glob-список) — через `facade.getSettings` |
| Метрики | `synth_memory_index_chunks{status}` (gauge: чанки индексов по состоянию владельца), `synth_memory_index_builds_total{outcome}` (counter) |

## 3. Состав плагина

```text
synth-plugin-memory/                 # name: synth-plugin-memory → namespace synth_plugin_memory
├── synth.pack                       # манифест (kind: plugin, mode: inline|both)
├── package.json                     # peerDeps: @itphx/synth-shared, @itphx/synth-core (только типы)
├── dist/index.js                    # bundle-only (esbuild), @itphx/* — external
└── src/
    ├── index.ts                     # apply(facade)
    ├── blocks/                      # точки доставки в промпт
    │   ├── facts-block.ts           # context, order 100 — устойчивые факты
    │   └── recall-block.ts          # volatile, order 110 — retrieval по query хода
    ├── tools/                       # инструменты модели
    │   ├── search.ts                # memory_search
    │   ├── write.ts                 # memory_write (явное запоминание)
    │   ├── forget.ts                # memory_forget (коррекция/отзыв)
    │   └── index-admin.ts           # memory_index (создать/пересобрать/статус)
    ├── ingest/                      # сбор фактов (без hooks: точки нет)
    │   ├── pipeline.ts              # шаги пайплайна: read_session_reference → agent → write
    │   └── candidates.ts            # кандидаты → активные факты (консолидация)
    ├── providers/                   # реализации MemoryProvider
    │   ├── rag.ts                   # ванильный RAG (свой движок)
    │   └── gbrain.ts                # адаптер к внешнему Gbrain (MCP/HTTP)
    ├── engine/                      # движок ванильного RAG
    │   ├── chunker.ts               # нарезка + версия чанкера (в фингерпринт индекса)
    │   ├── embedder.ts              # вызовы через facade.embed (предпосылка B)
    │   ├── vector-store.ts          # хранение векторов, brute-force/ANN
    │   ├── keyword.ts               # keyword-arm (BM25-подобный)
    │   ├── fusion.ts                # RRF постранично
    │   ├── reranker.ts              # cross-encoder (опция, отдельная модель)
    │   └── evidence.ts              # evidence-контракт + create_safety
    ├── index/                       # жизненный цикл индекса
    │   ├── manager.ts               # create/build/rebuild, поколения, атомарный swap
    │   └── fingerprint.ts           # embeddingInputHash
    ├── consolidate/                 # консолидация (движок — пайплайн ADR-101)
    │   ├── dedup.ts
    │   ├── contradictions.ts
    │   ├── salience.ts
    │   └── summarize.ts
    ├── admin/                       # операции портала (роут — в ядре, не в плагине)
    │   ├── admin-tool.ts            # memory_admin: rebuild/status — вызывается core-роутом
    │   └── job-status.ts
    └── contracts/                   # Zod-схемы DTO, версии
```

**Три уровня, которые нельзя смешивать:**

| Уровень | Компоненты | Что делает |
|---|---|---|
| **Доставка** (лёгкий, `inline`) | `blocks/`, `tools/` | превращает ответ провайдера в блок промпта и в результат тула |
| **Провайдер** | `providers/rag.ts`, `providers/gbrain.ts` | `recall`/`ingest`/`admin` — источник фактов |
| **Движок** | `engine/`, `index/`, `consolidate/` | только у ванильного RAG; у внешних провайдеров его нет |

Правило: **блок не ходит в хранилище напрямую** — только через `MemoryProvider`. Иначе появятся две
реализации recall (в блоке и в туле), которые разойдутся.

## 4. Возможности: что плагин даёт

### 4.1 Агенту (в промпте и тулах)

| Возможность | Механизм | Что видит модель |
|---|---|---|
| **Факты проекта в контексте** | блок `context`, `order 100` | устойчивые утверждения с источником: «решение — X (источник: сессия Y, 2026-10-12)» |
| **Recall по текущему вопросу** | блок `volatile`, `order 110`, `ctx.query` | top-N фрагментов в бюджете `plugins.promptBlockMaxChars`, с пометкой `provenance` |
| **Поиск по памяти** | тул `memory_search { query, scope?, kinds?, limit? }` | результаты с `evidence` и `create_safety` |
| **Явное запоминание** | тул `memory_write { text, kind?, scope?, ttl? }` | `{ factId, version }` — идемпотентно по `id` |
| **Коррекция и отзыв** | тул `memory_forget { factId, mode: 'supersede'|'retract' }` | новая версия факта; старая помечена `supersededBy` |
| **Управление индексами** | тул `memory_index { action: 'status'|'build'|'rebuild', indexId }` | статус/поколение/готовность (админ-capability) |

**Формат блока.** Компактный, детерминированный (один и тот же вход → один и тот же текст — иначе
дрожит prompt-cache):

```text
[MEMORY: project facts]
- Деплой в test идёт через Fleet, не через kubectl. (src: session s-42, 2026-10-12)
- Провайдер `itphx` — основной для dev. (src: profile, 2026-10-01)

[MEMORY: recall for this turn]   (только volatile, только при ctx.query)
- ADR-101: пайплайн — второй движок; шаг не является сессией. (src: docs/arch_decisions/adr-101…, rev 3f1c)
- Гейт `security-gate` обязателен в release.yaml. (src: .gitverse/workflows/release.yaml)
```

Каждая строка — утверждение + источник. Если `readiness != 'ready'` — секция не выдаётся как
«пусто», а помечается: `[MEMORY: index stale, rebuild pending]`.

### 4.2 Пользователю и администратору (портал)

| Раздел | Что показывает | Что позволяет |
|---|---|---|
| **Провайдеры** | подключённые `MemoryProvider`, их capabilities, готовность, провайдер по умолчанию | включить/выключить провайдер, сменить дефолтный |
| **Индексы** | имя, источник, scope, `state`, `generation`, фингерпринт эмбеддинга, объём | создать, пересобрать, удалить, посмотреть «почему stale» |
| **Факты** | текст, `provenance`, `confidence`, версия, `supersededBy`, `validUntil` | править, подтверждать, отзывать, искать |
| **Консолидация** | отчёт прогона: кластеры дублей, заменённые/оставленные факты, минимальный косинус пары | запустить (с `dryRun` и порогом), посмотреть результат (прогоны пайплайна — М4-остаток) |
| **Граф** (М5) | сущности `[[сущность]]`, рёбра «факт→сущность» и со-встречаемость, статистика | выбор сущности и глубины (1–3), список связей и фактов (canvas — остаток) |
| **Лимиты** | бюджет токенов на recall, retention, квоты корпуса | изменить (ADMIN) |

Настройки — **админ-категория «Память»** (PROP-047 §4.1); пользовательский раздел — отдельная задача.
API портала — **в ядре** (`createMemoryRoutes`): читает факты/индексы через порт памяти (предпосылка A),
а операции провайдера выполняет админ-тулом плагина; встроенный экран UI вызывает его своим API-доменом.

**Чтение портала сделано** (ADR-107): `GET /api/v2/memory/{status,facts,facts/:id,indexes}` —
namespace плагина (`plugin:synth-plugin-memory`) подставляет сервер, чтение — `requireAuth` (core) /
`ADMIN` (managed). Спека — [docs/API_V2.md](./API_V2.md) §5.38. Операции провайдера (правка/отзыв
факта, пересборка индекса) и вызов админ-тула из core-роута — остаток.

### 4.3 Системе

| Возможность | Как |
|---|---|
| Инкрементальный ingest | хуки: `message_received` (кандидаты), `post_tool_use` (результаты), `session_end` (сводка) |
| Консолидация | пайплайн ADR-101, объявленный плагином (`provides.pipelines`), запуск по расписанию ADR-051 |
| Наблюдаемость | метрики `synth_memory_*` (регистрируются ядром, ADR-094), события `memory.*` в инстансном канале |
| Аудит | журнал плагинов `{dataDir}/audit/plugins.jsonl` + записи `memory.*` в аудите действий |
| Деградация | провал `recall` → пустой блок + `warning`; ход не падает (правило `promptBlocks`) |

## 5. Контракты и модель данных

### 5.1 `MemoryProvider` (в `@itphx/synth-shared`)

```ts
export type MemoryCapability = 'recall' | 'ingest' | 'index' | 'consolidate' | 'graph';
export type MemoryReadiness = 'ready' | 'degraded' | 'stale' | 'unavailable';

export interface MemoryProvider {
  readonly id: string;                      // 'plugin:memory:rag' | 'plugin:memory:gbrain'
  readonly contracts: 1;                    // semver-мажор контракта точки
  readonly capabilities: readonly MemoryCapability[];
  recall(req: RecallRequest): Promise<RecallResult>;
  ingest?(req: IngestRequest): Promise<IngestResult>;
  admin?(cmd: MemoryAdminCommand): Promise<MemoryAdminResult>;
}

export interface RecallRequest {
  readonly query: string;
  readonly scope: { projectId?: string; userId?: string; agentRole?: string };
  readonly budget: { maxTokens: number; maxItems: number };  // владелец бюджета — провайдер
  readonly kinds?: readonly MemoryFactKind[];
  readonly signal?: AbortSignal;
}

export interface RecallResult {
  readonly facts: readonly MemoryFact[];
  readonly citations: readonly MemoryCitation[];
  readonly readiness: MemoryReadiness;      // «не нашлось» ≠ «индекс не готов»
  readonly meta?: Record<string, unknown>;
}
```

`MemoryProvider` — **источник фактов**, `PromptBlockProvider` — **доставка**. Это разные контракты
(таблица в PROP-047 §1.3): провайдер укладывает выдачу в бюджет, блок передаёт бюджет в запрос и
обрезает остаток.

### 5.2 Модель данных

```ts
export interface MemoryFact {
  readonly id: string;
  readonly version: number;
  readonly text: string;
  readonly kind: 'decision' | 'constraint' | 'reference' | 'preference' | 'observation';
  readonly scope: { projectId?: string; userId?: string };
  readonly provenance: MemoryProvenance;    // { sourceKind, sourceId, uri?, revision?, capturedAt }
  readonly confidence: number;              // 0..1
  readonly createdAt: string;
  readonly validUntil?: string;
  readonly supersededBy?: string;           // id новой версии
  readonly status: 'active' | 'superseded' | 'retracted';
}

export interface MemoryIndex {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly scope: { projectId?: string };
  readonly source: { kind: 'project' | 'files' | 'sessions' | 'external'; filter?: string };
  readonly state: 'building' | 'ready' | 'stale' | 'failed';
  readonly generation: number;
  readonly fingerprint: EmbeddingFingerprint;  // model, dim, normalize, chunkerVersion, wrapTier
  readonly stats: { documents: number; chunks: number; updatedAt: string };
}
```

**Версионирование — шесть независимых осей** (полностью в PROP-047 §5.3): схема данных памяти,
поколение индекса, фингерпринт эмбеддинга, версия факта, версия контракта провайдера, версия
schema-пака. Здесь важно одно правило: **смена модели эмбеддинга делает индекс `stale`, а не молча
«похожим»** — вектор переиспользуется только при совпадении `embeddingInputHash`.

## 6. Манифест

```json
{
  "name": "synth-plugin-memory",
  "version": "0.1.0",
  "kind": "plugin",
  "description": "Память агентов: факты с provenance, гибридный recall, индексы, консолидация",
  "host": ">=0.12.0 <0.14.0",
  "contracts": { "extensionApi": "^1", "promptBlocks": "^1", "tools": "^1" },
  "mode": "inline",
  "provides": {
    "tools": ["memory_search", "memory_write", "memory_forget", "memory_index"],
    "promptBlocks": [
      { "key": "plugin.synth-plugin-memory.facts",  "tier": "context",  "order": 100, "title": "Факты памяти" },
      { "key": "plugin.synth-plugin-memory.recall", "tier": "volatile", "order": 110, "title": "Воспоминание по вопросу" }
    ]
  },
  "permissions": { "network": [], "secrets": [], "tools": [], "hooks": ["message_received", "post_tool_use", "session_end"] },
  "trust": { "level": "trusted", "source": "builtin" }
}
```

Внешний вариант (Gbrain) — **другой плагин** (`synth-plugin-memory-gbrain`, `mode: "remote"`) с
`permissions.network` на хост Gbrain; он не дублирует движок, а только адаптирует MCP/HTTP.

Правила, которые проверяет хост (уже реализованы): `tier` только `context`/`volatile`; сверка
`provides.*` ↔ фактические регистрации (`plugin.provides_mismatch`); `contracts.extensionApi` по
семвер-мажору; `host` — диапазон; `trust` не выше `trusted` у плагина.

## 7. Жизненный цикл и деградация

```text
install (scan → trust-floor → install-policy) → enable → activate
  resolve → integrity → semver → trust/scan → policy → import → facade → disposers → audit
                                                                       │
                          ┌────────────────────────────────────────────┘
                          ▼
   registerPromptBlock(facts) · registerPromptBlock(recall)
   registerTool(search|write|forget|index) · registerHook(...) · registerRoute(...)
                          │
                    деактивация → disposers в обратном порядке
```

| Ситуация | Поведение |
|---|---|
| `load()` блока бросил | `warning`, блок пуст, ход продолжается (правило `promptBlocks`) |
| Индекс `building` | блок recall помечен `stale`, recall отдаёт `readiness: 'degraded'` |
| Индекс `stale` (сменилась модель) | recall работает по старому поколению, но помечает факты; портал показывает «требуется пересборка» |
| Провайдер недоступен (Gbrain лёг) | `readiness: 'unavailable'`, блок пуст, тул возвращает ошибку с понятной причиной; сессия не падает |
| Бюджет символов превышен | хост обрезает (голова+хвост, `[TRUNCATED: …]`) и ставит `status: 'truncated'` |
| Сессия с `settings.systemPrompt` | блоки плагина не добавляются (override заменяет всё) |
| Саб-агент `task` | промпт собирается мимо Composer — память туда не попадёт (известное ограничение ADR-090) |
| Шаг пайплайна | Composer вызывается, но `query`/`turnId` не заполняются → блок recall пуст |

## 8. Портал

**Где.** Center-tab «Память» (`useUIStore` → `CenterTabType`, `TAB_ICONS`, `renderTabContent` — три
типизированные правки) + админ-категория «Память» в Настройках (`settings-catalog.ts`). Роутера в UI
нет — вводить его нельзя (`packages/ui/AGENTS.md`).

**Под-режимы:** Индексы (таблица + CRUD + пересборка), Факты (список + редактор + отзыв), Задачи
(прогоны консолидации, live), Граф (М5, `@xyflow/react`, свой IR и адаптер — не `PipelineSpec`).

**Live.** События `memory.index.*`, `memory.consolidation.*` публикуются в **инстансный** канал шины
(`EventBus.publishInstance`), UI обрабатывает префикс `memory.` в `transportStore` **до** проверки
`sid` — как `pipeline.*`. Второго транспорта нет (инвариант 6).

**Права** (паттерн «роут-фабрика + опции»): чтение — `requireAuth` (core) / `ADMIN` (managed);
мутации — `ADMIN` + `requireAdminRoleOrScope('automation:install')`; проектные данные — проекция
`allowedProjects` (ADR-052).

## 9. Фоновые процессы

**Консолидация — пайплайн (ADR-101), не новый job-движок.** Плагин объявляет определение в
`provides.pipelines`; установщик пакета его ставит, движок исполняет, шедулер (ADR-051) запускает
по расписанию через `schedule_fired` → правило → `PipelineRef`.

```text
SchedulerService → schedule_fired → RouteRule(PipelineRef) → PipelineEngine.run({kind:'schedule'})
   шаг 1 agent: «найди противоречия и дубли в пачке фактов»   (LLM только через GatewayProvider)
   шаг 2 tool : memory_write (supersede/merge)
   шаг 3 tool : memory_index rebuild (если изменился корпус)
```

Где исполняется: **standalone** — в процессе core; **managed** — один реплика, лидер-элекшен через
`StorageContext.locks` (`PgLeader`; для файлового бэкенда — `FileLeader`); **внешний провайдер** —
консолидация на его стороне (dream cycle Gbrain), Synth только запускает и наблюдает; **работы,
требующие shell** (переиндексация кода `rg`) — в исполнителе (ADR-077).

Идемпотентность: `dedupKey` прогона + лидер-элекшен + снимок спецификации в прогоне (ADR-101) ⇒
повтор не создаёт дублей фактов (`ingest` идемпотентен по `fact.id`).

## 10. Безопасность и доверие

| Риск | Мера |
|---|---|
| Плагин читает чужие данные | контракт получает **узкий DTO** (`sessionId`/`projectId`/`query`), истории и портов нет; данные — только через storage-грант в своём namespace |
| Плагин подсовывает в промпт инструкции (prompt injection) | содержимое памяти — недоверенный ввод: санитайзер защищённого тела, `provenance` у каждой строки, лимит бюджета |
| Плагин ходит в сеть куда угодно | `permissions.network` + egress-политика (ADR-099) + SSRF-защита (PROP-100) |
| Плагин подменяет встроенный тул | namespace `plugin_<ns>_<tool>` (занятие имени невозможно) |
| Плагин повышает себе trust | уровень резолвит источник/реестр, не манифест; trust-floor `trusted` |
| Эмбеддинги светят текст наружу | через `GatewayProvider.embed` → embedding-фаза `llmFilters` (`deny`/`redact`) |
| Секреты в бандле | секреты — только через API инстанса; скан бандла + `{dataDir}/audit/plugins.jsonl` |

## 11. Тесты

1. **Контрактный suite расширений** (уже есть в ADR-090: `describePluginContract`, 8 фикстур ×2
   транспорта) — расширить фикстурой «память»: блок + тул + ingest.
2. **Свои тесты плагина**: блок детерминирован (один вход → один текст); бюджет соблюдён; `recall`
   укладывается в `maxTokens`; `stale`-индекс не выдаёт себя за «не найдено».
3. **Интеграционный**: активация плагина → `GET /api/v2/sessions/:id/prompt` содержит запись
   `{ key: 'plugin.synth-plugin-memory.recall', provenance: 'plugin:synth-plugin-memory', status }`.
4. **Деградация**: `load()` бросает → ход не падает; Gbrain недоступен → сессия работает.
5. **Изоляция**: попытка занять имя встроенного тула → отказ; `tier: 'stable'` → отказ активации.
6. **RBAC**: негативная матрица портала (не-ADMIN → 403) и положительная (ADMIN → 200).

## 12. Фазы

| Фаза | Что | Статус |
|---|---|---|
| **М0 — порты** | `MemoryFactRepository`/`MemoryIndexRepository` + контрактный suite (memory/file/PG, миграция `017-memory`) | ✅ **готово** |
| **М0.5 — предпосылки** | `facade.memory` (scoped), `facade.embed` (через Gateway), `facade.getSettings`, сужение `ToolContext` для плагинных тулов ([ADR-107](./arch_decisions/adr-107-plugin-facade-services.md)) | ✅ **готово** |
| **М1 — первый плагин** | плагин-каркас: 2 блока (`context`/`volatile`) + `memory_search`/`memory_write`/`memory_forget`; портал в ядре (`createMemoryRoutes`) + админ-категория; метрики `synth_memory_*` | 🟡 **частично**: портал (чтение) и метрики сделаны в ядре (`/api/v2/memory/*`, `synth_memory_*`); плагин-каркас и админ-категория UI — отдельная работа |
| **М2 — ванильный RAG** | чанкер, эмбеддинги через `facade.embed`, индекс с поколениями и фингерпринтом, гибридный поиск (keyword + vector + RRF), evidence; портал «Индексы» (чтение + мутации), `memory_index` | ✅ **готово** |
| **М3 — Gbrain** | внешний Add-on + `mode: remote` плагин (своё хранилище, без портов); сравнение качества с RAG на общем корпусе | ⬅️ следующая (внешний сервис, вне этого репозитория) |
| **М4 — консолидация** | дедуп фактов по эмбеддингам (`memory_consolidate`, порог + `dryRun`, портал и UI) — **готово**; ingest сессий и суммаризация формулировок — пайплайн `read_session_reference` → `agent` → `memory_write`, шедулер, лидер-элекшен, портал «Задачи» — остаток | ⚠️ Частично |
| **М5 — граф** | извлечение `[[сущность]]`/`[[сущность|связь]]` без LLM, со-встречаемость, `memory_graph` (depth/limit), `GET /memory/graph`, список связей в UI — **готово**; интерактивный canvas (React Flow + новая зависимость) — остаток | ⚠️ Частично |

## 13. Открытые вопросы

> Закрыто: storage-грант (порт + scoped-сервис), эмбеддинги (сервис фасада через Gateway),
> настройки плагина (`getSettings`), `ctx.extra` для плагинных тулов (сужен) — [ADR-107](./arch_decisions/adr-107-plugin-facade-services.md).

1. **Вызов админ-тула плагина из core-роута портала** — зафиксировать конвенцию: контекст вызова,
   permission-проверка, кто «автор» (пользователь или система), что попадает в аудит.
2. **Векторы в PostgreSQL**: остаёмся на `jsonb` + keyword-arm на `pg_trgm` или добавляем `pgvector`
   (нужна миграция + право `CREATE EXTENSION`)? Рекомендация: `jsonb` по умолчанию, `pgvector` — флаг.
3. **Ingest: пакетный (пайплайн) или реалтайм** (для реалтайма понадобится четвёртая точка)?
   Рекомендация: первая волна — пакетный; реалтайм — если понадобится «помнит сразу».
4. **`memory_write` и инвариант 11** (состояние — через Tool Use): кандидаты пишутся пайплайном, в
   активные факты переходят через консолидацию или явный `memory_write`. Утвердить.
5. **Retention и приватность**: что удаляется по `session_end`, как работает «забудь меня» по scope.
6. **Пользовательский раздел настроек** (PROP-047 §4.1) — состав и хранение (user-runtime или профиль).
7. **Один плагин или два** (inline-движок + remote для Gbrain)? Рекомендация: **RAG — `inline`**
   (нужны порты и `facade.embed`), **Gbrain — `remote`** (своё хранилище).
8. **Метрики**: какие счётчики/гистограммы `synth_memory_*` заводим в первой волне.
9. **Срок**: PROP-047 остаётся vision; переводить ли в actionable с датой 2026-11-14.

## История

- 2026-10-23 — документ создан: состав плагина, предпосылки слоя, возможности, модель данных,
  жизненный цикл, портал, консолидация, безопасность, тесты, фазы.
- 2026-10-24 — синхронизация с ADR-090 (✅, Ф0–Ф7): Extension API v1 — **три точки**, `hooks`/`routes`/`settings`
  не экспонируются; пересмотрены предпосылки — осталось **три** (storage-грант, `facade.embed`,
  `facade.getSettings`), две оказались мнимыми (ingest закрывается пайплайном; портал — в ядре);
  добавлена находка §2.2 (inline-тул получает `ctx.extra` с internals ядра).
- 2026-10-24 — М5: граф сущностей без LLM — разбор `[[сущность]]`/`[[сущность|связь]]`, со-встречаемость,
  BFS-окрестность (depth 1–3), тул `memory_graph`, `GET /memory/graph`, список связей в UI.
- 2026-10-24 — М4a: консолидация без LLM — кластеризация активных фактов по косинусу, канон по детерминированному
  приоритету, `supersede` дублей, `dryRun`; тул `memory_consolidate`, портал и UI. Остаток М4 — ingest сессий
  через пайплайн (нужна модель) и прогоны по расписанию.
- 2026-10-24 — М2: индекс файлов/фактов с поколениями и фингерпринтом, гибридный поиск (keyword + vector + RRF),
  `memory_index`, мутации портала (`POST /memory/indexes`, `:id/rebuild`, `DELETE`) и операции в UI.
- 2026-10-24 — предпосылки закрыты ([ADR-107](./arch_decisions/adr-107-plugin-facade-services.md)):
  §2 переписан по факту (порты памяти, `facade.memory`/`embed`/`getSettings`, сужение `ToolContext`),
  §2.1 — что осталось до М1, §2.2 — граница транспорта (RAG — `inline`, Gbrain — `remote`),
  фазы М0/М0.5 отмечены готовыми, открытые вопросы сокращены до 9.
- 2026-10-24 — **портал памяти в ядре (М1, чтение)**: `createMemoryRoutes` (`server/routes/memory.ts`) —
  `/api/v2/memory/{status,facts,facts/:id,indexes}` (namespace подставляет сервер, поиск по подстроке
  в памяти, счётчики через порты); метрики `synth_memory_facts`/`synth_memory_indexes` (ADR-094).
  §2.1 и §12 обновлены по факту; спека — `docs/API_V2.md` §5.38, каталог метрик — `docs/OBSERVABILITY.md`.
