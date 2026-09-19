# AD-070: SystemPromptComposer — консистентность промпта, prompt-cache, статистика и прозрачность

> **Статус:** ✅ Реализовано
> **Дата:** 2026-09-18
> **Парные документы:**
> - [AD-022](./ad-022-typescript-stack-runner.md) «Единый TypeScript стек + Runner-архитектура» — движки stateless: промпт собирается на бэкенде и передаётся движку вместе с историей; Composer не вводит persistent-состояние в движке;
> - [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — единственный путь LLM-вызова (guard/обфускация/rate limit/аудит); CachePolicy и нормализация usage живут на границе Gateway/провайдеров, а не в тулах;
> - [AD-039](./ad-039-plan-in-project.md) «План — в проекте, todo — в сессии» — `PLAN_GUIDE` остаётся блоком system (тир `stable`), а `MODE_*`/`PLAN_MODE_*`/`[APPROVED PLAN]`/`[TODO]` передаются chronological system-сообщениями (§2.8); первопричина дублей при повторной сборке устраняется by design;
> - [AD-041](./ad-041-llm-error-taxonomy.md) «Таксономия ошибок LLM + i18n» — строки блоков промпта и диагностики идут через ключи `shared/i18n`;
> - [AD-046](./ad-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — каталог скиллов как источник промпта; требование «не ломать prompt-cache»;
> - [AD-069](./ad-069-project-instructions-agents-md.md) «Проектные инструкции (AGENTS.md) и `/init`» — проектные инструкции как ещё один источник; lazy-догрузка в tool result выбрана именно ради prompt-cache.

**Решение:** провести рефакторинг сборки системного промпта, выделив единый `SystemPromptComposer` и упорядочив блоки по тирам, чтобы промпт был **детерминированным, идемпотентным и кэшируемым**, а его состав — наблюдаемым:

1. **Выделить `SystemPromptComposer`** из `ChatOrchestrator` и `ContextBuilder` — единственную точку сборки системного промпта для основной сессии и саб-агентов. Специализированные промпты `_handleDebugSystemMessage` (debug-эхо) и `_handleSummarization` (`SUMMARIZER.{lang}.md`) — **исключение**: это не сессионный system prompt, они остаются inline (см. §4, Фаза 1).
2. **Три тира консистентности (модель hermes):** `stable` (кэшируемый статический префикс — константы сессии и политики) → `context` (проектный контекст) → `volatile` (состояние и переходные добавки). Порядок: статика → динамика. Принцип: **политики — в `stable`, состояние — в `volatile`** (см. §2.1).
3. **Идемпотентная пересборка:** Composer собирает промпт из состояния **заново**, а не дописывает блоки. Плюс режим (`MODE_*`/`PLAN_MODE_*`) и состояние плана/todo (`[APPROVED PLAN]`/`[TODO]`) **выносятся из system** в chronological system-сообщения истории — это by design чинит реальный баг дублирования после `plan_enter`/`plan_exit`.
4. **`CachePolicy` в слое провайдеров/Gateway** (не в тулах): политика `auto | none | object`; Anthropic — массив блоков `system` + `cache_control: {type:"ephemeral"}` с бюджетом ≤4 breakpoint'ов; OpenAI — `prompt_cache_key` из стабильного id сессии. Маркеры ставятся **после** нормализации/санитайза сообщений.
5. **Нормализованный `Usage`** и честная статистика: `stream_options.include_usage` для OpenAI, чтение `prompt_tokens_details.cached_tokens`, расчёт стоимости с cache read/write, событие сессии, cache hit rate.
6. **Состояние промпта — Вариант B, на каждого агента:** в сессии `promptStates: Record<agentKey, PromptState>` (generation, `staticPrefixHash`, закреплённые байты `staticPrefix`, `systemHash`, блочные хэши, reason, updatedAt) записывается **только при смене generation**; два уровня generation — общий `session.promptGeneration` (смена разделяемого контекста) и агентный `PromptState.generation` (смена role/contextFile); режим и смена модели/провайдера generation **не** поднимают; в каждом assistant-сообщении — компактный `promptMeta` (`agentRole`, generation, ожидание hit/miss, фактические cachedTokens, validated).
7. **Прозрачность и дебаг:** манифест источников (key/label/размер/оценка токенов/статус/provenance) + тест паритета «манифест ↔ отправленные байты» + API/UI-представление состава (аналог `/context`); проброс `DebugCollector` в Composer во всех точках создания.
8. **`ContextSource`-шов** (`{ key, load(ctx): { content, provenance } }`) — задел под будущий реестр источников (см. §2.6).
9. **Многоагентность:** `@`-упоминание агента и выбор агента в UI-селекторе — один и тот же путь; у каждого агента свой закреплённый префикс и свой кэш (см. §2.7).
10. **Режим/план/todo — chronological-сообщения:** `MODE_*`, `PLAN_MODE_*`, `[APPROVED PLAN]`, `[TODO]` не попадают в system prompt, а идут durable system-сообщениями в историю; `PLAN_GUIDE` остаётся в `stable` (см. §2.8).
11. **Тулы постоянны во всех режимах:** список тулов не фильтруется по режиму (plan/act/yolo); ограничения обеспечивает только permission-слой, расширенный осью доступности `ToolAccess` (`allow`/`ask`/`deny`/`unavailable`); доступность не кодируется в `description` (см. §2.9).
12. **Generation не зависит от режима/модели:** смена режима не поднимает generation и не меняет `staticPrefixHash`; смена модели/провайдера не пересобирает stable-префикс, а даёт `expected: 'miss'` из-за нового provider-namespace (см. §2.4).

---

## 1. Контекст и проблема

Системный промпт в Synth сегодня собирается **инкрементально и в нескольких местах**: `ContextBuilder.buildSystemPrompt` возвращает базовую часть, а `ChatOrchestrator` дописывает к ней блоки через конкатенацию строк. Управления prompt-cache нет, статистика usage неполная, состав промпта непрозрачен, а часть отладочных механизмов мертва.

### 1.1. Фактический порядок блоков

Сборка: `packages/core/src/engine/context/builder.ts:42–132` + `packages/core/src/engine/orchestrator.ts:798–836`.

| # | Блок | Источник | Тип |
|---|---|---|---|
| 1 | role-prompt агента | `builder.ts:57–85` (`getRolePrompt`) | условно-стабильный |
| 2 | participants notice | `builder.ts:69–76` | динамический |
| 3 | sticky notes | `builder.ts:78–80`, `249–263` | динамический |
| 4 | compressed dialog (summary) | `builder.ts:87–93` | динамический |
| 5 | `[ADDITIONAL CONTEXT]` (SOUL/COMPANY/ABOUT) | `builder.ts:95–97`, `152–184` | статический |
| 6 | profile prompt | `builder.ts:99–101`, `186–215` | статический (на сессию) |
| 7 | `[PROJECT: …]` (`info.md`) | `builder.ts:103–105`, `217–231` | статический (на проект) |
| 8 | interview prompt | `builder.ts:107–120` | статический |
| 9 | `[CLASSIFICATION]` | `orchestrator.ts:811–819` | статический (на сессию) |
| 10 | `GATEWAY` | `orchestrator.ts:821–828` | статический |
| 11 | `MODE_{PLAN,ACT,YOLO}` | `orchestrator.ts:830–833` → `_buildPlanSystemPrompt:448–498` | меняется редко |
| 12 | `PLAN_MODE_{…}` | там же | меняется редко |
| 13 | `[APPROVED PLAN]` | там же (из `project.plan`) | динамический |
| 14 | `[TODO]` | там же (из `session.todos`) | динамический |
| 15 | `PLAN_GUIDE` | там же | статический |
| 16 | `[ИНФОРМАЦИЯ О СЕССИИ]` | `orchestrator.ts:835–836` → `_buildSessionContextPrompt:562–625` | динамический |

Проблема очевидна: **динамические блоки (2, 3, 4) стоят в начале**, а статические (5–12, 15) — после них. Любое изменение sticky/summary/participants сдвигает весь дальнейший префикс и обнуляет кэш, даже если содержательно промпт не изменился.

### 1.2. Prompt-cache не управляется

| Провайдер | Факт | Следствие |
|---|---|---|
| Anthropic | `body.system = systemPrompt` — **строка** (`packages/core/src/providers/anthropic.ts:55,107`), нет `cache_control` | Anthropic не кэширует строковый system как набор блоков; кэш не работает |
| OpenAI | не читается `prompt_tokens_details.cached_tokens` (`packages/core/src/providers/openai.ts:229–238`); не отправляется `stream_options.include_usage` | cached-токены не учитываются, статистика занижена |
| Все | `grep cache_control\|prompt_cache_key\|stream_options\|include_usage` по `packages/*/src` не находит ни одного вхождения (кроме комментария в `backend/src/routes/llm.ts:369`) | управление кэшем отсутствует как класс |

### 1.3. Модель данных уже готова

| Сущность | Путь | Поля |
|---|---|---|
| `TokenUsage` | `packages/shared/src/types/index.ts:534–541` | `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?` |
| `Session` (агрегаты) | `packages/shared/src/types/index.ts:268–277` | `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `inputCost`, `outputCost`, `cacheReadCost`, `cacheWriteCost` |
| Anthropic usage | `anthropic.ts:264–265,401–402` | читает `cache_read_input_tokens` / `cache_creation_input_tokens` |
| FileStore | `packages/core/src/storage/file-store.ts:154,224,290–297,356–363` | сериализует/десериализует cache-поля и `usage` сообщения |
| Накопление стоимости | `orchestrator.ts:2511+` | учитывает `cacheReadTokens`/`cacheWriteTokens` и цены `cacheReadPrice`/`cacheWritePrice` |

То есть контракт и хранение есть — не хватает **извлечения** cache-полей у OpenAI/Remote и **управления** кэшем.

### 1.4. Идемпотентность нарушена (реальный баг)

После `plan_enter`/`plan_exit` оркестратор **повторно** вызывает `_buildPlanSystemPrompt` поверх уже собранного `finalSystemPrompt`:

```
orchestrator.ts:1397  finalSystemPrompt = await this._buildPlanSystemPrompt(finalSystemPrompt, …)
orchestrator.ts:1404  finalSystemPrompt = await this._buildPlanSystemPrompt(finalSystemPrompt, …)
```

`_buildPlanSystemPrompt` (`448–498`) **дописывает** `MODE_*`, `PLAN_MODE_*`, `[APPROVED PLAN]`, `[TODO]`, `PLAN_GUIDE` в конец `base`. Результат: в одном ходе эти блоки присутствуют дважды (старая и новая версии), промпт растёт, поведение модели непредсказуемо. Это первопричина, а не симптом: лечится идемпотентной пересборкой из состояния **и** выносом режима/плана/todo из system в chronological system-сообщения (см. §2.8) — тогда повторный вызов `_buildPlanSystemPrompt` нечего дописывать, и баг устраняется by design.

### 1.5. Множественные точки сборки и двойной system у саб-агента

| Точка | Путь |
|---|---|
| Основная сессия — builder | `orchestrator.ts:798–809` |
| CLASSIFICATION inline | `orchestrator.ts:811–819` |
| GATEWAY | `orchestrator.ts:821–828` |
| Plan-блоки | `orchestrator.ts:830–833` (`_buildPlanSystemPrompt`, 448–498) |
| Session-context | `orchestrator.ts:835–836` (`_buildSessionContextPrompt`, 562–625) |
| Повтор после plan_enter/exit | `orchestrator.ts:1397,1404` |
| Debug-сообщение | `orchestrator.ts:1861–1963` (свой inline) |
| Summarization | `orchestrator.ts:1965–2107` |
| Саб-агенты | `engine/tools/task.ts:221–226,374–430,847–849`, `task-resume.ts:206–211` |

У саб-агента `llmSystemPrompt` кладётся в `messages[0]` (`task.ts:461,619`) **и одновременно** передаётся как `systemPrompt` в `chatAsync` (`task.ts:847–849`). У OpenAI/Remote это даёт два system-сообщения подряд — избыточность и потенциальная неоднозначность для модели.

### 1.6. Прозрачность и debug мертвы

| Факт | Путь |
|---|---|
| `captureSystemPromptParts` не вызывается нигде | `packages/core/src/debug.ts:139` (только определение; вызовов в `src` нет) |
| `captureContextFiles` вызывается только из builder | `builder.ts:180` |
| `ContextBuilder` создаётся **без** `debugCollector` | `server/app.ts:634`, `server/chat.ts:67`, `backend/src/app.ts:241` |
| `ChatOrchestrator` — там же | `server/app.ts:696`, `server/chat.ts:118`, `backend/src/app.ts:403` |
| `debugEnabled` по умолчанию `true` | `sessions/manager.ts:70` |

Итог: отладка «что реально ушло в промпт» недоступна, а механизм, задуманный под неё, не подключён.

### 1.7. Проблемы, которые решаем

- **Prompt-cache не работает.** Anthropic получает строку без блоков; OpenAI не получает `prompt_cache_key`; cache-usage не читается.
- **Промпт нестабилен.** Динамика в начале префикса убивает длинный общий префикс между ходами.
- **Дубли блоков.** Повторная сборка после `plan_enter`/`plan_exit` дописывает блоки поверх уже собранных; вынос режима/плана/todo в chronological-сообщения (§2.8) устраняет саму возможность дублей.
- **Режим/план/todo в system.** `MODE_*`/`PLAN_MODE_*`/`[APPROVED PLAN]`/`[TODO]` лежат в system и меняются по ходу — сдвигают system-префикс и инвалидируют кэш.
- **Тулы фильтруются по режиму.** `_filterToolsByMode` (`orchestrator.ts:508–540`) меняет список инструментов при смене режима — модель не видит доступных после переключения инструментов и ищет обходные пути; список инвалидирует tool-префикс.
- **Разрозненная сборка.** Восемь точек конкатенации → расхождения между основной сессией, debug, summarization и саб-агентами.
- **Неполная статистика.** `cached_tokens` OpenAI игнорируется, `include_usage` не запрошен, hit rate не считается.
- **Непрозрачность.** Нельзя увидеть состав промпта, размер/токены по источникам, причину miss.
- **Двойной system.** Саб-агент отправляет system и в `messages[0]`, и в аргументе `chatAsync`.

---

## 2. Решение

### 2.1. Composer и тиры

Новый модуль `packages/core/src/engine/context/composer.ts` — класс `SystemPromptComposer`, владеющий порядком блоков и сборкой. `ContextBuilder` остаётся поставщиком «сырых» блоков (role, additional, profile, project, interview, sticky, summary), а `ChatOrchestrator` передаёт Composer состояние сессии/проекта и **не конкатенирует** строки сам.

```ts
export type PromptTier = 'stable' | 'context' | 'volatile';

export interface PromptBlock {
  key: string;                 // стабильный id блока: 'role', 'gateway', 'plan.guide', 'summary', …
  tier: PromptTier;
  content: string;             // уже собранный текст ('' — блок не отправляется)
  provenance?: string;         // человеку: путь/источник
}

export interface ComposerContext {
  session: Session;
  agentDef?: AgentDefinition;
  project?: Project | null;
  workingDir: string;
  language: string;
}

export class SystemPromptComposer {
  constructor(private readonly deps: {
    contextBuilder: ContextBuilder;
    contextConfig: ContextConfig;
    projectStore?: ProjectStore;
    debugCollector?: DebugCollector;   // per-message, пробрасывается
  }) {}

  /** Идемпотентно собирает промпт из состояния; ничего не «дописывает». */
  async compose(ctx: ComposerContext): Promise<ComposedPrompt>;

  /** Собирает манифест источников без побочных эффектов (для API/UI/тестов). */
  async manifest(ctx: ComposerContext): Promise<PromptManifest>;
}

export interface ComposedPrompt {
  system: string;                    // полный текст (stable + context + volatile)
  stablePrefix: string;              // закреплённые байты кэшируемого префикса
  blocks: PromptBlock[];
  state: PromptState;                // см. §2.4
}
```

Три тира:

```
stable    role-prompt (+ политики: «профиль пуст → проведи интервью»,
          «проекта нет → предложи создать проект»),
          [ADDITIONAL CONTEXT] (SOUL/COMPANY/ABOUT), GATEWAY, PLAN_GUIDE,
          mode.policy (политика режимов: что такое plan/act/yolo, что
          переключение делает только пользователь, реакция на mode-unavailable;
          отдельный блок — в role-prompt НЕ дублируется)
          → константы сессии и политики; меняется только при смене generation
            (компакция / смена оверрайда / role этого агента)

context   profile, [PROJECT: info.md], проектные инструкции (AD-069),
          каталог скиллов (AD-046), [ИНФОРМАЦИЯ О СЕССИИ]
          → привязано к проекту/workspace; стабильно внутри сессии

volatile  sticky notes, participants notice, summary, компактные state-маркеры
          (профиль пуст / проекта нет), [CLASSIFICATION] (config-gate
          `routingEnabled`), interview-артефакт (текст опросника)
          → состояние и переходные добавки; меняется на сообщение/переход; всегда в конце
```

**Принцип «политика — в `stable`, состояние — в `volatile`».** В `stable` попадает только то, что **константно на всю сессию**: неизменяемые константы (role, identity, additional context) и **политики** — правила поведения, которые не меняются от хода к ходу. Политика «если профиль не заполнен — проведи интервью» и «если проекта нет — предложи создать проект» — это инструкции, а не состояние, поэтому они живут в role-prompt (тир `stable`), а не отдельным блоком. Всё **условное и переходное** — текст опросника, факт «профиль пуст», компактные state-маркеры — идёт в `volatile`, **позже границы stable-префикса**. Это принципиально: появление/исчезновение условной добавки не должно инвалидировать кэшируемый префикс. Режим (`MODE_*`/`PLAN_MODE_*`) и состояние плана/todo (`[APPROVED PLAN]`/`[TODO]`) в system prompt **не попадают вообще** — они передаются durable chronological system-сообщениями в истории (см. §2.8), поэтому не участвуют ни в stable-, ни в system-префиксе. Политика режимов при этом — константа и живёт в `stable` **отдельным блоком `mode.policy`** (§2.9.1, §3.1) и **не дублируется в role-prompt**; в role остаются только политики «профиль пуст → интервью» и «проекта нет → предложи создать». `[CLASSIFICATION]` — напротив, **условный config-gate** от `routingEnabled` и потому отнесён к `volatile`, а не к `stable`. Правило проверяемое: блок попадает в `stable` только если он побайтово константен на всю сессию; иначе — `context` или `volatile`.

Ключевой принцип: **Composer идемпотентен** — `compose(ctx)` при одном и том же состоянии возвращает побайтово один и тот же результат, независимо от того, сколько раз он вызывался. Никаких `base + '\n\n' + part`.

### 2.2. CachePolicy

Политика кэша — **в слое провайдеров/Gateway**, а не в тулах и не в оркестраторе. Расширение существующего `packages/core/src/engine/gateway/gateway-provider.ts` и `packages/core/src/providers/{anthropic,openai,remote}.ts`.

```ts
export type CachePolicy = 'auto' | 'none' | {
  tools?: boolean;
  system?: boolean;
  messages?: 'latest-user-message' | 'latest-assistant' | { tail: number };
  ttl?: '5m' | '1h';
};

export interface CacheHints {
  systemBreakpoints: Array<'stable-prefix' | 'system-end'>;
  markLastTool: boolean;
  markMessage: 'latest-user-message' | 'latest-assistant' | { tail: number } | null;
}
```

**Anthropic.** `body.system` становится **массивом блоков**, а не строкой:

```jsonc
{
  "system": [
    { "type": "text", "text": "<stable prefix>", "cache_control": { "type": "ephemeral" } },
    { "type": "text", "text": "<context + volatile>" }
  ]
}
```

Бюджет — **максимум 4 breakpoint'а** на запрос, в порядке приоритета **tools → system → messages**:
1. последний tool-дефинишн (если есть tools);
2. конец stable-префикса в `system` — кэширует длинный неизменяемый префикс;
3. конец `system` целиком — чтобы volatile-хвост не инвалидировал stable-кэш (два system-breakpoint'а — это осознанное решение, см. §7);
4. последнее user-сообщение.

Если лимит превышен — молча дропать лишние с предупреждением в лог, а не отдавать 400.

**OpenAI.** Явных `cache_control` нет; используется implicit prefix caching. Отправляем `prompt_cache_key` — **стабильный id сессии** (не меняется от хода к ходу), чтобы провайдер переиспользовал префикс. Плюс `stream_options: { include_usage: true }` для получения usage в стриме.

**Порядок применения.** Маркеры ставятся **после** нормализации/санитайза сообщений (guard AD-036, обфускация, преобразование истории) — иначе санитайз перепишет разметку блоков и кэш поедет.

**`none`.** Полностью отключает и маркеры, и `prompt_cache_key` (для отладки/сравнений). Дефолт — `auto`.

### 2.3. Usage/статистика

Нормализованный контракт (расширение `TokenUsage`, обратно совместимое):

```ts
export interface Usage {
  input: number;        // всего prompt-токенов, включая cache read/write
  output: number;       // всего output-токенов, включая reasoning
  nonCached: number;    // «свежая» часть prompt
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}
// инвариант: nonCached + cacheRead + cacheWrite = input
```

Изменения по провайдерам:

| Провайдер | Что делаем |
|---|---|
| OpenAI | `stream_options.include_usage: true`; читаем `usage.prompt_tokens_details.cached_tokens` → `cacheRead`; `input = prompt_tokens`, `nonCached = input − cacheRead` |
| Anthropic | уже читает `cache_read_input_tokens` / `cache_creation_input_tokens`; `input = input_tokens + cacheRead + cacheWrite` (у Anthropic `input_tokens` — только некэшированная часть) |
| Remote (гибрид) | нормализуем usage из ответа backend-прокси в тот же контракт |
| Ollama | cache-полей нет → `cacheRead = cacheWrite = 0`, `nonCached = input` |

Далее:
- стоимость считается по `cacheReadCost`/`cacheWriteCost` (поля модели и сессии уже есть);
- публикуется событие сессии `session.updated` (уже несёт cache-поля, `orchestrator.ts:1710–1722`) + отдельное `usage.updated` при необходимости;
- считается **cache hit rate** = `cacheRead / (cacheRead + nonCached)` и отдаётся в статистику сессии/UI.

### 2.4. Состояние промпта: `promptStates` / `promptMeta`

**Вариант B** — состояние промпта живёт в сессии, но пишется **редко** (только при смене generation), через `FileStore` (AD-005). Состояние **per-agent**: `agentKey` = `agentRole`, либо `__default__` для сессии без выбранного агента.

```ts
export type AgentKey = string;       // agentRole или '__default__'

export interface PromptState {
  generation: number;              // инкремент на смену role/contextFile/модели этого агента
  staticPrefixHash: string;        // sha256(stablePrefix)
  staticPrefix: string;            // закреплённые байты кэшируемого префикса
  systemHash: string;              // sha256(полного system)
  blocks: Array<{ key: string; hash: string; chars: number }>;
  reason: 'init' | 'compaction' | 'generation-change' | 'override' | 'agent-change';
  updatedAt: string;
}

export interface PromptMeta {      // кладётся в assistant-сообщение
  agentRole: string;               // agentKey, к которому относится ход
  generation: number;              // агентный generation на момент хода
  expected: 'hit' | 'miss';        // предсказание по staticPrefixHash
  cachedTokens: number;            // фактический cacheRead из usage
  validated: boolean;              // expected подтверждён/опровергнут
}
```

**Два уровня generation:**

| Уровень | Где | Когда растёт | Что инвалидирует |
|---|---|---|---|
| `session.promptGeneration` | сессия (общий) | смена разделяемого контекста: проект, проектные инструкции, конфиг | кэш **всех** агентов |
| `PromptState.generation` | `promptStates[agentKey]` (на агента) | смена `role`/`contextFile` **этого** агента | кэш только этого агента |

**Чего generation не касается.** Смена режима (plan/act/yolo) и изменение плана/todo **не** поднимают ни один generation и **не** меняют `staticPrefixHash` — эти изменения уходят chronological system-сообщениями (§2.8). Смена модели/провайдера тоже **не** пересобирает stable-префикс и не bump'ает generation: сам префикс остаётся тем же, но provider-namespace новый, поэтому ход помечается `expected: 'miss'` — без инвалидации закреплённых байтов.

Цикл:
1. **Перед отправкой** Composer считает свежий `staticPrefixHash` для текущего `agentKey` и сравнивает с сохранённым в `promptStates[agentKey]`. Совпал → `expected: 'hit'`, иначе `'miss'`.
2. **После ответа** фактический `cacheRead` из нормализованного usage сверяется с ожиданием → `validated: true/false`. При расхождении в диагностику уходит причина (например, TTL истёк, сменилась модель/провайдер).
3. **Запись `promptStates[agentKey]`** — только когда меняется generation (компакция/оверрайд/агент). На обычном сообщении — read-only сравнение.

Полную историю промптов **не храним** (для этого есть payload-лог Gateway).

### 2.5. Прозрачность и дебаг

Composer отдаёт **манифест источников** (по образцу hermes `context_file_sources.py`) и **состав слоя истории**:

```ts
export interface PromptManifestEntry {
  key: string;
  label: string;
  tier: PromptTier;
  chars: number;
  estTokens: number;
  status: 'loaded' | 'truncated' | 'empty' | 'blocked' | 'suppressed';
  provenance?: string;
  source?: 'system' | 'tools';   // 'system' — блок system, 'tools' — слой инструментов
}
export interface PromptManifest {
  generation?: number;
  totalChars: number;
  estTokens: number;
  staticPrefixChars: number;
  entries: PromptManifestEntry[];
}

/** Слой истории (`messages`) — состав реально отправляемых сообщений. */
export interface PromptHistoryInfo {
  messages: { count: number; chars: number; estTokens: number };
  stateMessages: Array<{ type: string; count: number; chars: number; estTokens: number }>;
  excluded: { disabled: number; hidden: number; info: number };
  attachments: { count: number; chars: number };
  secretPlaceholders: number;
}
```

- **Манифест: system-блоки + отдельный слой `tools`.** `manifest()` возвращает записи system-блоков в **реальном порядке отправки** (`role` — первой, `source: 'system'`), затем отдельную запись `tools` (`tier: 'stable'`, `source: 'tools'`, `provenance: 'tools'`). `chars` = длина `JSON.stringify` **реально отправляемых** инструментов (тот же список, что уходит в запрос); запись `tools` учтена в `totalChars`/`estTokens`/`staticPrefixChars`, но в текст `compose()` не входит — это отдельный, самый ранний кэшируемый слой (`tools → system → messages`). В список запись вставляется **в конце тира `stable`** — после последней stable-записи (`mode.policy`) и перед первой `context`-записью (`profile`), т.к. инструменты принадлежат stable-слою и идут в реальном префиксе сразу за stable-блоками; `role` при этом остаётся первой записью.
- **Слой истории.** `GET /api/v2/sessions/:id/prompt` вместе с `manifest` отдаёт `history: PromptHistoryInfo` — состав слоя `messages`, посчитанный **тем же** `_sessionMessagesToLlm`, что и реальная отправка (статистика не расходится с запросом): суммарные отправляемые сообщения (`messages`: count/chars/estTokens), сгруппированные chronological state-сообщения (`stateMessages` по `type`: `mode_change`/`agent_switch`/`plan_updated`/`todos_updated`/…), исключённые (`excluded`: `disabled`/`hidden`/`info`), вложения (не-text части: `attachments` count/chars) и число плейсхолдеров секретов `⟦SYNTH_SECRET_N⟧` (`secretPlaceholders`, AD-036). **Request-параметры (model/temperature/maxTokens) в состав промпта не включаются — осознанно:** это параметры запроса, а не промпт.
- **Тест паритета:** `manifest(ctx)` и `compose(ctx)` используют один и тот же обход источников; тест проверяет, что сумма `chars`/`estTokens` манифеста соответствует реально отправленным байтам (в пределах известных приближений, как в hermes).
- **API:** `GET /api/v2/sessions/:id/prompt` (manifest + `history` + последний `promptMeta`).
- **UI:** секция «Состав промпта» (аналог `/context`): тир, размер, токены, статус, provenance, hit/miss по ходам; в неё входят строка «Описание инструментов» (`tools`) и секция «История» — раскрывающаяся таблица state-сообщений по типам, исключённые (`disabled`/`hidden`/`info`), вложения и число секретов.
- **Профиль.** `_getProfilePrompt` и блок интервью резолвят профиль единым `_resolveProfile(userId)` = `loadProfile(userId) ?? getProfileByUsername(userId)`: `session.userId` хранит username (`admin`), а профиль ключуется по id-UUID. `profilesStore` проброшен в standalone `ContextBuilder` (`server/app.ts`, `server/chat.ts`), поэтому профиль и интервью работают и в standalone-core, не только на managed-бэкенде.
- **DebugCollector** пробрасывается в `ContextBuilder`/`SystemPromptComposer` во **всех** точках создания (`server/app.ts:634`, `server/chat.ts:67`, `backend/src/app.ts:241`) — `captureSystemPromptParts` перестаёт быть мёртвым кодом.

### 2.6. `ContextSource`-шов

`SystemPromptComposer` принимает источники через единый интерфейс:

```ts
export interface ContextSource {
  key: string;
  tier: PromptTier;
  load(ctx: ComposerContext): Promise<{ content: string; provenance?: string }>;
}
```

Это **задел** под будущий реестр источников (роль, additional, profile, info.md, AGENTS.md-цепочка AD-069, каталог скиллов AD-046) — потенциально отдельный AD. Сейчас источники остаются внутри Composer; шов нужен, чтобы не переписывать архитектуру при появлении реестра.

Механика кэша намеренно лёгкая: **тиры** (`stable`/`context`/`volatile`), **закреплённый префикс** и **инвалидация по generation** — без persistent cache-слоя между ходами (промпт пересобирается на каждое сообщение, AD-005).

### 2.7. Многоагентность: кэш на каждого агента

`@`-упоминание агента и выбор агента в UI-селекторе (поле ввода) — **один и тот же путь**. Агенты отрабатывают **последовательно**, каждый со своим system prompt и **своим кэшем**; переключение агента не смешивает префиксы.

- **Ключ.** `session.promptStates: Record<agentKey, PromptState>`, где `agentKey = agentRole` (или `__default__` для сессии без агента). У каждого агента свой закреплённый `staticPrefix` и свои хэши.
- **Role-prompt — первый блок.** Общий префикс **не** выносим вперёд (решение пользователя): каждый агент кэширует свой префикс от начала. При сценарии A→B→A префикс A остаётся в кэше провайдера, а `promptStates[A]` позволяет предсказать/провалидировать hit для возврата к A.
- **Generation.** Общий `session.promptGeneration` растёт при смене разделяемого контекста (проект/инструкции/конфиг) и инвалидирует **всех**; агентный `PromptState.generation` растёт при смене role/contextFile **этого** агента. Режим и смена модели/провайдера generation не поднимают (см. §2.4, §2.8).
- **Статистика.** `promptMeta` на assistant-сообщении несёт `agentRole` + `generation` → cache hit rate считается по агентам.
- **Саб-агенты** (`task`/`task-resume`): короткоживущие, свой промпт; их `promptState` **не персистим** (эфемерно/не храним), чтобы не раздувать сессию. Саб-агент собирает промпт через тот же Composer, но не пишет `promptStates`.

### 2.8. Режим и состояние — chronological-сообщения

**Решение пользователя:** `MODE_*`, `PLAN_MODE_*`, `[APPROVED PLAN]`, `[TODO]` **не должны быть в system prompt вообще**. Они передаются как **durable chronological SYSTEM-сообщения** в истории (роль `system`; скрыты **только** в UI — для модели это обычные сообщения истории). `PLAN_GUIDE` остаётся в system (тир `stable`) как постоянная политика «как вести план/todo».

Правила:

- **Смена режима** (UI-тумблер plan/act/yolo либо инструменты `plan_enter`/`plan_exit`) добавляет в историю system-сообщение с текстом режима/перехода. System baseline при этом **НЕ пересобирается** — `staticPrefixHash` не меняется.
- **Изменение плана/todo** (утверждение плана, `plan_write`, `todo_*`) — тоже system-сообщение: состояние уезжает в **хронологический хвост** истории, а не в начало промпта.
- **Схема сообщения.** В хранилище — `role: system` и `metadata: { type, state: true }`; `metadata.type` — `mode_change` / `plan_updated` / `todos_updated` / `agent_switch`. Сообщение **скрыто только в UI** (не показывается пользователю), но это **обычное system-сообщение истории**: попадает в историю для LLM (через `_sessionMessagesToLlm`) и во вход суммаризатора наравне со всеми включёнными сообщениями. «Скрытых от модели/суммаризатора» сообщений нет — термин «скрытое» относится исключительно к отображению в UI.
- **Представление для LLM.** Anthropic не принимает `role: system` в `messages`, поэтому `_sessionMessagesToLlm` конвертирует state-сообщение в синтетическое `user`-сообщение с обёрткой `<system-state type="…">…</system-state>` (без префикса `[anonymous]`). Обёртка помечает блок как состояние движка, а не реплику пользователя.

**Типы chronological-сообщений:**

| `metadata.type` | Содержимое | Когда добавляется |
|---|---|---|
| `mode_change` | текущий режим (plan/act/yolo) + список недоступных сейчас тулов с причиной (`mode`/`role`, §2.9.1) | при старте сессии и при каждом переключении режима |
| `plan_updated` | актуальное состояние плана (`project.plan`) | при утверждении/изменении плана |
| `todos_updated` | актуальный список todo (`session.todos`) | при изменении todo |
| `agent_switch` | активный агент и, если применимо, недоступные ему по роли тулы | при переключении агента (`@`/UI-селектор) |

Текущий режим сообщается **и при старте сессии, и при каждом переключении** — не только когда значение меняется; то же для активного агента. Так модель в любой момент видит актуальный режим и актуальный список недоступного, не трогая system-префикс.

**Обоснование — иерархия инвалидации prompt-cache: `tools → system → messages`.** Чем раньше в префиксе изменение, тем больше кэша оно обнуляет. Смена режима/плана/todo — событие хода, и она не должна трогать `system`: иначе инвалидируется и stable-breakpoint, и system-end breakpoint. Перенос состояния в хвост истории сохраняет оба system-breakpoint'а и позволяет провайдеру переиспользовать длинный неизменяемый префикс.

**Следствие:** это **by design** устраняет текущий баг дублей блоков после `plan_enter`/`plan_exit` (`orchestrator.ts:1397,1404`) — повторно дописывать в system больше нечего, режим/план/todo живут в истории по одному разу на переход.

**Рост истории — не проблема (решение пользователя).** Каждое переключение режима/агента и изменение плана/todo добавляет durable system-сообщение, и эти сообщения остаются в истории как обычные system-сообщения. Supersede/схлопывание старых state-сообщений **не делаем**: в результате в истории уже новое актуальное состояние, к тому же модель сама его установила. Источник истины — состояние в хранилище (`project.plan`, `session.todos`), которое модель в любой момент читает инструментами `plan_read`/`todo_list`. Отдельная оптимизация суммаризатора под state-сообщения (исключение/сжатие) **отложена** — сейчас проблем не видно.

### 2.9. Тулы постоянны; ограничения — только permission

**Решение пользователя:** список тулов **НЕ фильтруется по режиму**. Это сознательное решение: модель должна видеть все возможные инструменты и понимать, что часть из них станет доступна после переключения режима пользователем; иначе модель ищет обходные пути.

- `_filterToolsByMode` (`orchestrator.ts:508–540`) **убирается**; список tool-дефинишенов идентичен во всех режимах (plan/act/yolo).
- Ограничения режима обеспечивает **только permission-слой** (AD-029), который различает три независимых эффекта:
  - **`unavailable(mode)`** — в plan-режиме `write_file`/`edit_file`/git-write получают именно его: definition виден модели и остаётся в запросе, но вызов отклоняется с подсказкой переключить режим (доступ открывается сменой plan → act/yolo). Это «недоступно в текущем режиме», а не запрет навсегда.
  - **`deny`** — только если **отдельная** security-политика (protected paths и т.п.) жёстко запрещает операцию: выхода нет, подсказок о переключении/делегировании не даём.
  - **`ask`** — если операция в принципе допустима, но требует подтверждения пользователя.
  - definition тула остаётся в запросе во всех трёх случаях.
- **Обоснование поведения:** модель видит полный набор инструментов и осознаёт необходимость переключения режима, а не изобретает обходные пути.
- **Cache-эффект:** тулы — самый ранний слой префикса (`tools → system → messages`), и их неизменность означает, что смена режима не инвалидирует tool-префикс.
- Это **изменение текущего поведения** (сейчас набор тулов зависит от режима).

#### 2.9.1. Доступность тулов: единая ось `ToolAccess`

Список tool-дефинишенов постоянен, но **доступность** конкретного тула — отдельная ось, **расширяющая permission-слой (AD-029)**: permission-слой получает новый эффект `unavailable`. Модель доступности описана здесь.

```ts
type ToolAccess =
  | { effect: 'allow' }
  | { effect: 'ask' }
  | { effect: 'deny'; reason?: 'policy' }
  | { effect: 'unavailable'; reason: 'mode' | 'role' };
```

- **`allow` / `ask`** — как в AD-029: тул доступен; вызов выполняется сразу или требует подтверждения.
- **`deny`** — жёсткий запрет (политика/безопасность). Выхода нет; подсказок о переключении/делегировании не даём.
- **`unavailable(mode)`** — тул откроется, если **пользователь переключит режим** (plan/act/yolo); модель может предложить переключение.
- **`unavailable(role)`** — тул недоступен текущему агенту, но доступен другому; модель может предложить **делегировать** задачу другому агенту через `@`.

**Как это доносится до модели без ущерба кэшу:**

1. **Политика — только в блоке `mode.policy`** (`stable`, §3.1), **не в role-prompt**: «часть тулов может быть недоступна; если причина — режим, предложи переключить; если причина — роль, предложи другого агента через `@`». Текст константен на всю сессию.
2. **Текущее состояние — в chronological-хвост** (§2.8): при старте сессии и при каждом переключении режима/агента system-сообщение (`mode_change`/`agent_switch`) перечисляет недоступные **сейчас** тулы и причину. Смена доступности не трогает ни `stable`, ни `context`.
3. **При вызове** — если тул всё же вызван, результат-отказ несёт причину и подсказку (i18n-ключи, AD-041), а не голый «forbidden».

**Запрет:** доступность **нельзя** кодировать в `description` тулов. Description входит в tool-префикс (`tools → system → messages`), поэтому изменение текста по режиму/роли вернёт инвалидацию tool-кэша. `description` одинаков во всех режимах и для всех агентов; доступность живёт только в permission-слое и chronological-сообщениях.

---

## 3. Целевой порядок блоков и инварианты

### 3.1. Целевой порядок

| # | Тир | Блок | Ключ |
|---|---|---|---|
| 1 | `stable` | role-prompt / roles description + политики (интервью при пустом профиле, предложение проекта); политики режимов здесь **нет** — она в строке 5 | `role` |
| 2 | `stable` | `[ADDITIONAL CONTEXT]` (SOUL/COMPANY/ABOUT) | `additional` |
| 3 | `stable` | `GATEWAY` | `gateway` |
| 4 | `stable` | `PLAN_GUIDE` | `plan.guide` |
| 5 | `stable` | политика режимов: что такое plan/act/yolo, переключение делает только пользователь, реакция на `unavailable(mode/role)` | `mode.policy` |
| 6 | `context` | profile | `profile` |
| 7 | `context` | `[PROJECT: …]` (`info.md`) | `project.info` |
| 8 | `context` | проектные инструкции (AD-069) | `instructions` |
| 9 | `context` | каталог скиллов (AD-046) | `skills.catalog` |
| 10 | `context` | `[ИНФОРМАЦИЯ О СЕССИИ]` | `session.info` |
| 11 | `volatile` | sticky notes | `sticky` |
| 12 | `volatile` | participants notice | `participants` |
| 13 | `volatile` | summary (compressed dialog) | `summary` |
| 14 | `volatile` | компактные state-маркеры (профиль пуст / проекта нет) | `state.markers` |
| 15 | `volatile` | `[CLASSIFICATION]` (config-gate `routingEnabled`) | `classification` |
| 16 | `volatile` | interview-артефакт (текст опросника) | `interview` |

Граница stable-префикса — после блока 5 (`mode.policy`): role + identity + `additional` + `gateway` + `plan.guide` + `mode.policy`. Политика режимов живёт **только** в блоке `mode.policy` (строка 5) и **не дублируется в role-prompt** (строка 1); в role остаются только «профиль пуст → интервью» и «проекта нет → предложи создать». Всё, что после, не участвует в кэшируемом префиксе. `[CLASSIFICATION]` — **условный config-gate** от `routingEnabled`, поэтому он в `volatile` (его появление/смена не инвалидирует stable-префикс). `MODE_*`/`PLAN_MODE_*` и состояние плана/todo (`[APPROVED PLAN]`/`[TODO]`) в system-таблице **отсутствуют** — это chronological system-сообщения в истории (см. §2.8), они не участвуют ни в stable-, ни в system-префиксе, поэтому `plan_enter`/`plan_exit` не инвалидируют stable-префикс.

**Chronological-сообщения (вне system):**

| Тип (`metadata.type`) | Содержимое | Когда добавляется |
|---|---|---|
| `mode_change` | текущий режим (plan/act/yolo) + список недоступных сейчас тулов с причиной | при старте сессии и при каждом переключении режима |
| `plan_updated` | актуальное состояние плана (`project.plan`) | при утверждении/изменении плана |
| `todos_updated` | актуальный список todo (`session.todos`) | при изменении todo |
| `agent_switch` | активный агент (+ недоступные ему по роли тулы, если применимо) | при переключении агента (`@`/UI-селектор) |

Chronological-сообщения — **обычные system-сообщения истории**: они попадают в историю для LLM и во вход суммаризатора наравне со всеми включёнными сообщениями; «скрыты» они **только в UI**, а не от модели. Рост их числа не ограничиваем (supersede/схлопывание не делаем): источник истины — состояние в хранилище, доступное инструментами `plan_read`/`todo_list` (§2.8).

### 3.2. Инварианты

| Инвариант | Формулировка |
|---|---|
| **Byte-stability** | При неизменном состоянии `compose()` возвращает побайтово одинаковый `stablePrefix` (включая разделители `\n\n`), пригодный для кэша |
| **Идемпотентность** | Повторный вызов не дописывает блоки; источник истины — состояние, а не предыдущая строка |
| **Маркеры после нормализации** | `cache_control`/`prompt_cache_key` навешиваются после guard/обфускации/нормализации сообщений |
| **Stateless (AD-022)** | Composer живёт на бэкенде; движок получает готовый промпт + историю, своего состояния промпта не держит |
| **Единый путь** | Основная сессия и саб-агенты идут через `SystemPromptComposer`; ручных конкатенаций не остаётся. Исключение — специализированные промпты `_handleDebugSystemMessage`/`_handleSummarization` (debug-эхо и `SUMMARIZER.{lang}.md`): они не являются сессионным system prompt и остаются inline (см. §4, Фаза 1) |
| **Детерминированный таймстемп** | В stable-тир не попадает `Date.now()` с точностью до секунды; если нужна дата — только date-only (hermes) |
| **Условные блоки не в stable** | Блок попадает в `stable` только если он константен на всю сессию; всё условное/переходное (интервью-артефакт, state-маркеры) — `volatile`, позже границы stable-префикса |
| **Режим/план/todo не в system** | `MODE_*`, `PLAN_MODE_*`, `[APPROVED PLAN]`, `[TODO]` не попадают в system prompt; передаются chronological system-сообщениями в истории (§2.8) |
| **Смена режима не меняет system baseline** | Переключение plan/act/yolo и изменение плана/todo не пересобирают system и не трогают `staticPrefixHash`; generation не растёт |
| **Список тулов не зависит от режима** | Во всех режимах (plan/act/yolo) набор tool-дефинишенов идентичен; ограничения обеспечивает только permission-слой (AD-029, §2.9) |
| **Доступность не в tool description** | Доступность тула не кодируется в `description` (он входит в tool-префикс): текст одинаков во всех режимах и для всех агентов; доступность — в permission-слое (`ToolAccess`, §2.9.1) и chronological-сообщениях |
| **Доступность не в stable/context** | Список недоступных сейчас тулов — не блок system, а chronological-сообщение (`mode_change`/`agent_switch`); политика режимов (`mode.policy`) — константа в `stable` |
| **Кэш на каждого агента** | `promptStates` — per `agentKey`; смена агента не переиспользует чужой префикс и не сбрасывает чужие хэши |
| **Прозрачность = реальность** | Манифест строится тем же обходом, что и промпт; тест паритета обязателен |

---

## 4. Фазы реализации и тесты

### Фаза 1 — Composer, тиры, идемпотентность

- Модуль `engine/context/composer.ts`: `SystemPromptComposer`, `PromptBlock`, `ComposedPrompt`, порядок тиров, детерминированные разделители.
- Классификация блоков: **политики — в `stable`, состояние/условное — в `volatile`** (см. §3.1). Политики «профиль пуст → интервью» и «проекта нет → предложи создать» живут в role-prompt; политика режимов — **только** в блоке `mode.policy` (в role-prompt не дублируется); текст опросника и state-маркеры — в `volatile`.
- Перенос логики `_buildPlanSystemPrompt` / `_buildSessionContextPrompt` / inline CLASSIFICATION / GATEWAY в блоки Composer; `PLAN_GUIDE` — в `stable`, `MODE_*`/`PLAN_MODE_*`/`[APPROVED PLAN]`/`[TODO]` — в chronological system-сообщения (§2.8).
- Режим/план/todo как durable system-сообщения истории (роль `system`, `metadata.type`, скрыты из UI, попадают в `_sessionMessagesToLlm`); system baseline при смене режима/плана/todo не пересобирается.
- Удаление `_filterToolsByMode` (`orchestrator.ts:508–540`): список тулов идентичен во всех режимах, ограничения — только permission-слой (§2.9).
- Идемпотентная пересборка после `plan_enter`/`plan_exit` (закрывает дубли `orchestrator.ts:1397,1404`; вместе с chronological-сообщениями — by design).
- `_handleDebugSystemMessage` и `_handleSummarization` — **исключение из «единого пути»**: это специализированные промпты, а не сессионный system prompt. Debug-поток отвечает фиксированным эхо-промптом («подтверди, что получил отладочное сообщение»), а суммаризатор использует `ContextConfig.getSummarizerPrompt` (файл `prompts/system/SUMMARIZER.{lang}.md`). Composer собирает только основной промпт сессии (роль/политики/контекст/состояние), поэтому оба потока остаются на своих inline-промптах и на Composer **не переводятся**; попытка собрать их через Composer подмешала бы в специализированный промпт сессионные блоки (role, PLAN_GUIDE, mode.policy), что исказило бы задачу.
- Единый путь для саб-агентов: один system — **только вторым аргументом `chatAsync`** (как в оркестраторе); в `messages` system-сообщения нет. `llmSystemPrompt` (role + parent notes/summary + routing) целиком уходит в этот аргумент один раз.
- `session.settings.systemPrompt` override — по-прежнему заменяет весь промпт.

### Фаза 2 — CachePolicy и promptState

- `CachePolicy` (`auto | none | object`) в Gateway/провайдерах.
- Anthropic: массив блоков `system` + `cache_control`, бюджет ≤4 (tools → system → messages), два system-breakpoint'а.
- OpenAI: `prompt_cache_key` из стабильного id сессии.
- `promptStates: Record<agentKey, PromptState>` в `Session` + `PromptMeta` в assistant-сообщение; запись только при смене generation; предсказание/валидация hit. Два уровня generation: общий `session.promptGeneration` (проект/инструкции/конфиг → все агенты) и агентный `PromptState.generation` (role/contextFile). Режим и смена модели/провайдера generation **не** поднимают: режим уходит chronological-сообщением, модель даёт `expected: 'miss'` без пересборки stable-префикса.
- Один путь для `@`-упоминания и UI-селектора агента: последовательный вызов агентов, у каждого свой закреплённый `staticPrefix` и `promptStates[agentKey]`.
- Саб-агенты: промпт через Composer, но `promptStates` **не персистятся**.
- Миграция существующих session-файлов (поля опциональны; при отсутствии — generation 0, promptStates пересоздаётся).

### Фаза 3 — Usage/статистика

- Нормализованный `Usage` (`nonCached`, `cacheRead`, `cacheWrite`, `reasoning`).
- `stream_options.include_usage` + чтение `prompt_tokens_details.cached_tokens` (OpenAI/Remote).
- Стоимость с cache read/write; событие сессии; cache hit rate.
- Вывод статистики в сессии/UI.

### Фаза 4 — Прозрачность/debug

- `manifest()` + `PromptManifest`.
- Тест паритета «манифест ↔ отправленные байты».
- `GET /api/v2/sessions/:id/prompt` + UI-секция «Состав промпта».
- Проброс `DebugCollector` во все три точки создания; оживление `captureSystemPromptParts`.

### Тесты (Vitest)

| Фаза | Область | Что проверяем |
|---|---|---|
| Ф1 | Идемпотентность | Двойной `compose()` с тем же состоянием → побайтово равный результат; нет дублей `MODE`/`[TODO]`/`PLAN_GUIDE` |
| Ф1 | Порядок тиров | `stable` → `context` → `volatile`; динамика строго после статики |
| Ф1 | Регресс `plan_enter`/`plan_exit` | После смены режима блоки ровно по одному разу |
| Ф1 | Byte-stability | Один и тот же `stablePrefix` при неизменном состоянии (sha256) |
| Ф1 | Точки сборки | Debug/summarization/саб-агент дают тот же базовый промпт, что основная сессия |
| Ф1 | Саб-агент | Ровно один system-блок в запросе |
| Ф1 | Override | `session.settings.systemPrompt` заменяет промпт целиком |
| Ф1 | Политика/состояние | Политики (интервью при пустом профиле, предложение проекта) — в `stable` role-prompt; interview-артефакт и state-маркеры — в `volatile`; `MODE_*`/`PLAN_MODE_*` — не в system, а chronological-сообщения |
| Ф1 | Нет условных блоков в stable | При пустом профиле/отсутствии проекта `stablePrefix` не меняется; появление/исчезновение условной добавки не инвалидирует префикс |
| Ф1 | Существующие моки | `buildSystemPrompt`-моки (orchestrator/plan/permission/gateway/security/backend/task-resume) обновлены под Composer, поведение сохранено |
| Ф1 | Тулы по режимам | Список тулов идентичен во всех режимах (plan/act/yolo) |
| Ф1 | Permission в plan | write-тул помечается permission-слоем (`unavailable(mode)`/`deny`), но присутствует в запросе |
| Ф1 | Режим → chronological | Смена режима добавляет system-сообщение, system prompt не меняется (`staticPrefixHash` тот же) |
| Ф1 | План/todo → chronological | Изменение плана/todo добавляет system-сообщение в историю, а не в system; сообщение попадает в `_sessionMessagesToLlm` |
| Ф1 | `unavailable(mode)` | Тул с `unavailable(mode)` присутствует в запросе, но помечен недоступным в текущем режиме; после переключения режима появляется/исчезает в списке недоступных, `description` не меняется |
| Ф1 | `unavailable(role)` | Тул с `unavailable(role)` недоступен текущему агенту и доступен другому; результат-отказ несёт причину и подсказку делегировать через `@` (i18n) |
| Ф1 | `deny` vs `unavailable` | `deny` не даёт подсказки о переключении/делегировании; `unavailable(mode)` — даёт предложение сменить режим |
| Ф1 | Политика режимов в `stable` | `mode.policy` — в `stable`, константен на сессию; смена plan/act/yolo не меняет `staticPrefixHash` |
| Ф1 | Chronological-список недоступных | `mode_change`-сообщение перечисляет недоступные сейчас тулы и причину; добавляется при старте сессии и при каждом переключении режима |
| Ф1 | `classification` в `volatile` | Блок `[CLASSIFICATION]` — в `volatile`; изменение `routingEnabled` не инвалидирует `stablePrefix` |
| Ф1 | Порядок `volatile` | Сверху `sticky`, снизу `interview` (sticky → participants → summary → state.markers → classification → interview) |
| Ф1 | Tool description не зависит от режима | `description` тулов побайтово одинаков во всех режимах и для всех агентов (tool-префикс стабилен) |
| Ф2 | CachePolicy auto/none | `none` не ставит маркеров и не шлёт `prompt_cache_key`; `auto` — ставит |
| Ф2 | Anthropic | `system` — массив блоков; ≤4 breakpoint'а; приоритет tools→system→messages; дроп с warning при переливе |
| Ф2 | OpenAI | `prompt_cache_key` стабилен между ходами; меняется при смене generation/сессии |
| Ф2 | Маркеры после нормализации | Санитайз/обфускация не ломают разметку блоков |
| Ф2 | promptStates/promptMeta | Запись только при смене generation; expected/validated по факту cachedTokens; `promptMeta` несёт `agentRole` |
| Ф2 | Per-agent promptStates | `promptStates[agentKey]` изолированы: A→B→A сохраняет хэши A; смена role агента A не трогает B |
| Ф2 | Два generation | `session.promptGeneration` инвалидирует кэш всех агентов; агентный generation — только своего |
| Ф2 | Режим/модель не bump'ают generation | Смена plan/act/yolo не меняет generation и `staticPrefixHash`; смена модели/провайдера → `expected: 'miss'` без пересборки stable-префикса |
| Ф2 | Многоагентность (@ и UI) | Последовательный вызов агентов через `@`-упоминание и переключение UI-селектора — один путь; у каждого свой system и свой кэш, чужой префикс не переиспользуется |
| Ф2 | Сабагенты | `task`/`task-resume` собирают промпт через Composer, но `promptStates` **не персистятся** |
| Ф2 | Миграция | Старый session-файл без `promptStates` загружается, generation=0 |
| Ф3 | Usage OpenAI | `include_usage`; `cached_tokens` → `cacheRead`; инвариант `nonCached+cacheRead+cacheWrite=input` |
| Ф3 | Usage Anthropic | `input = input_tokens + cacheRead + cacheWrite` |
| Ф3 | Usage Remote/Ollama | Нормализация; отсутствие cache-полей → 0 |
| Ф3 | Стоимость | cache read/write учитываются в `cacheReadCost`/`cacheWriteCost` |
| Ф3 | Hit rate | Формула и граничные случаи (0 токенов, полный miss) |
| Ф4 | Манифест | key/label/tier/размер/токены/status/provenance |
| Ф4 | Паритет | Сумма манифеста ↔ реально отправленные байты |
| Ф4 | DebugCollector | `captureSystemPromptParts` вызывается; три точки создания получают collector |
| Ф4 | API/UI | `GET /sessions/:id/prompt` отдаёт manifest+promptMeta |

---

## 5. Влияние на другие подсистемы

| Подсистема | Влияние |
|---|---|
| **Гибрид (AD-042)** | Промпт собирается локальным core для локальных сессий и сервером/backend для удалённых; `promptStates` и CachePolicy применяются на той стороне, что владеет LLM-вызовом. Для удалённых сессий usage/cache нормализуется в `RemoteProvider`. Граница — та же, что у AD-069 |
| **Backend managed** | `packages/backend/src/app.ts` создаёт свой `ContextBuilder`/`ChatOrchestrator` (241, 403) — переводится на общий Composer; RBAC/мультитенантность не меняются |
| **Многоагентность / агенты** | `@`-упоминание и UI-селектор агента идут через один путь; `promptStates` — per `agentKey`, у каждого агента свой префикс-кэш; смена разделяемого контекста инвалидирует всех. `unavailable(role)`-тулы перечисляются в `agent_switch`-сообщении; доступность тула не меняет его `description` |
| **Саб-агенты (AD-026)** | `task.ts`/`task-resume.ts` получают промпт через Composer; устраняется двойной system; `promptStates` саб-агентов не персистятся. Контекст-режимы (`none/inherit/summary/last_n`) не меняются |
| **План/todo (AD-039)** | Источник состояния остаётся тем же (`project.plan`, `session.todos`), но оно уходит **chronological system-сообщениями** в историю, а не в system prompt; `PLAN_GUIDE` остаётся в `stable` |
| **Permissions/режимы (AD-025/AD-028/AD-029)** | Список тулов больше не фильтруется по режиму (`_filterToolsByMode` убирается); ограничения plan/act/yolo обеспечивает permission-слой (`allow`/`ask`/`deny`), расширенный осью `ToolAccess` с эффектом `unavailable(mode/role)` (§2.9.1). Доступность не кодируется в `description` тулов. Смена режима — chronological-сообщение, не блок system; политика режимов — `mode.policy` в `stable` |
| **Gateway/безопасность (AD-036)** | CachePolicy ставится после guard/обфускации; payload-лог по-прежнему хранит отправленные байты — Composer не дублирует историю |
| **Скиллы/инструкции (AD-046/AD-069)** | Их блоки получают явный тир (`context`) и участвуют в манифесте; lazy-догрузка в tool result сохраняется |
| **UI** | Новая секция «Состав промпта» + hit/miss-индикатор (в т.ч. по агентам); API `GET /sessions/:id/prompt`; тумблер режима (plan/act/yolo) добавляет chronological system-сообщение, а не меняет system; недоступные тулы (`unavailable(mode/role)`) отображаются с причиной и подсказкой переключения/делегирования |
| **i18n (AD-041)** | Подписи статусов/причин в манифесте — через ключи `shared/i18n` |
| **Хранилище (AD-005)** | `promptStates` пишется через `FileStore`, только при смене generation; саб-агенты не персистятся |

---

## 6. Что НЕ делаем

- **Не храним полную историю промптов.** Только `promptStates` (закреплённый префикс + хэши) и `promptMeta` на сообщении; полные байты — в payload-логе Gateway.
- **Не персистим `promptState` саб-агентов.** Саб-агенты (`task`/`task-resume`) короткоживущие и эфемерные: промпт собирается через Composer, но `promptStates` для них не храним, чтобы не раздувать сессию.
- **Не управляем кэшем в тулах.** CachePolicy — только провайдеры/Gateway; тулы не знают о `cache_control`.
- **Не ломаем AD-022.** Движок остаётся stateless; Composer — на бэкенде.
- **Не рефакторим `ContextConfig` и содержимое промптов** «заодно» — только сборка/порядок/кэш.
- **Не храним секреты/полные промпты в `promptStates`.** Закрепляется статический префикс; чувствительное — как и раньше, в обфускации/аудите.
- **Не меняем семантику `session.settings.systemPrompt` override** — он по-прежнему заменяет промпт.
- **Не фильтруем тулы по режиму.** Список tool-дефинишенов идентичен в plan/act/yolo; ограничения — только permission-слой, расширенный `ToolAccess` (§2.9, §2.9.1).
- **Не кодируем доступность тулов в `description`.** Текст tool-дефинишена одинаков во всех режимах и для всех агентов; `unavailable(mode/role)` живёт в permission-слое и chronological-сообщениях, а не в описании (иначе ломается tool-префикс).
- **Не кладём режим/план/todo в system prompt.** `MODE_*`/`PLAN_MODE_*`/`[APPROVED PLAN]`/`[TODO]` — chronological system-сообщения истории (§2.8).
- **Не схлопываем и не supersede'им state-сообщения.** Они остаются в истории как обычные system-сообщения; источник истины — состояние в хранилище, доступное инструментами `plan_read`/`todo_list` (§2.8).
- **Не оптимизируем суммаризатор под state-сообщения** (специальное исключение/сжатие) — отложено, сейчас проблем не видно.

---

## 7. Открытые вопросы

### Закрыто реализацией

| # | Вопрос | Решение |
|---|---|---|
| 1 | TTL и второй system-breakpoint | TTL по умолчанию — `5m`; используются **оба** system-breakpoint'а (`stable-prefix` и `system-end`) в рамках бюджета ≤4 (tools → system → messages). Опция `1h` не включена |
| 5 | `agentKey` в `prompt_cache_key` (OpenAI) | `prompt_cache_key = sessionId` (стабильный id сессии); `agentKey` в ключ **не входит** — изоляция кэша агентов обеспечивается закреплёнными `staticPrefix`/`promptStates[agentKey]`, а не ключом провайдера |

### Реально открытые

2. **Предсказание hit для Anthropic с учётом breakpoint'ов.** Совпадение `staticPrefixHash` не гарантирует hit (влияют TTL, границы блоков, другие breakpoint'ы) — как формулировать `expected` и считать точность предсказания?
3. **Совместимость с `session.settings.systemPrompt` override.** Считать ли override стабильным префиксом (можно кэшировать) или всегда volatile (безопаснее, но теряем кэш)?
4. **Оценка токенов в манифесте.** Точный токенайзер (дорого/провайдер-зависимо) или эвристика (chars/4) с пометкой «приблизительно», как в hermes `estimate_tokens_rough`?
6. **Отражение смены модели/провайдера в статистике.** Решено: generation **не** растёт, stable-префикс не пересобирается, ход помечается `expected: 'miss'` из-за нового provider-namespace. Открыто: как отличать это в статистике от реальной смены контекста и как соотносится с routing (AD-034)?
7. **Представление `ToolAccess` для UI/манифеста.** Нужен ли в манифесте промпта отдельный статус `unavailable` (с причиной `mode`/`role`) или достаточно состояния permission-слоя? Как показывать в UI, что тул «недоступен сейчас, но откроется после переключения» vs «недоступен этому агенту — делегируй»?

---

## 8. Связи с AD

| AD | Связь |
|---|---|
| [**AD-022**](./ad-022-typescript-stack-runner.md) | Движки stateless; Composer собирает промпт на бэкенде, движок получает готовый текст + историю |
| [**AD-036**](./ad-036-llm-gateway.md) | Единственный путь LLM-вызова; CachePolicy и usage-нормализация — на границе Gateway/провайдеров; маркеры после guard/обфускации |
| [**AD-039**](./ad-039-plan-in-project.md) | `PLAN_GUIDE` — блок `stable`; `MODE_*`/`PLAN_MODE_*`/`[APPROVED PLAN]`/`[TODO]` — chronological system-сообщения (§2.8); дубли после `plan_enter`/`plan_exit` устраняются by design |
| [**AD-041**](./ad-041-llm-error-taxonomy.md) | Строки диагностики/статусов манифеста и результат-отказ `unavailable` (причина + подсказка) — через ключи `shared/i18n` |
| [**AD-046**](./ad-046-skills-and-slash-commands.md) | Каталог скиллов — источник тира `context`; требование не ломать prompt-cache |
| [**AD-069**](./ad-069-project-instructions-agents-md.md) | Проектные инструкции — источник тира `context`; lazy-догрузка в tool result сохраняет кэш |
| [AD-005](./ad-005-json-storage.md) | `promptStates` пишется через `FileStore` (JSON, атомарно); промпт пересобирается на сообщение |
| [AD-014](./ad-014-project-container.md) | `project.plan`, `project.workspace`, `project.invariants` — источники блоков |
| [AD-025](./ad-025-plan-act-toggle.md) / [AD-028](./ad-028-plan-build-strictness.md) | Режим (`sessionMode`/`planMode`/`planApproved`) передаётся chronological system-сообщением, а не блоком system; `PLAN_GUIDE` и `mode.policy` — `stable`; смена режима не поднимает generation |
| [AD-029](./ad-029-granular-permissions.md) | Список тулов не фильтруется по режиму (`_filterToolsByMode` убирается); ограничения plan/act/yolo обеспечивает permission-слой (`allow`/`ask`/`deny`), **расширяемый осью `ToolAccess` с эффектом `unavailable(mode/role)`** (§2.9.1); definition остаётся в запросе, доступность не кодируется в `description` |
| [AD-026](./ad-026-subagent-context-modes.md) | Промпт саб-агентов через Composer; устранение двойного system; `promptStates` саб-агентов не персистятся |
| [AD-034](./ad-034-model-routing.md) | Смена модели/провайдера внутри сессии не bump'ает generation: stable-префикс не пересобирается, ход помечается `expected: 'miss'` |
| [AD-042](./ad-042-hybrid-mode.md) | Локальный/удалённый мир: на какой стороне собирается промпт и применяется CachePolicy |
| [AD-045](./ad-045-hybrid-server-profiles.md) | Единый dataDir: `promptStates` — часть session-файла, не зависит от сервера |

---

## 9. Статус реализации

**Реализовано полностью (Фазы 1–4).** Ветка `feat/ad-070-system-prompt-composer`.

### Фаза 1 — Composer, тиры, идемпотентность

- `SystemPromptComposer` (`engine/context/composer.ts`) — единственная точка сборки системного промпта; тиры `stable`/`context`/`volatile` и порядок блоков вынесены в `engine/context/prompt-blocks.ts`; сборка идемпотентна (пересборка из состояния, без конкатенации `base + …`).
- Режим/план/todo вынесены из system в durable chronological state-сообщения (`engine/context/state-messages.ts`): `metadata.type` = `mode_change`/`plan_updated`/`todos_updated`/`agent_switch`, в LLM уходят обёрнутыми в `<system-state type="…">`, в UI скрыты.
- Политика режимов — отдельный `stable`-блок `mode.policy` (`prompts/system/MODE_POLICY.{lang}.md`), в role-prompt не дублируется.
- Тулы постоянны во всех режимах и ролях: `_filterToolsByMode` удалён; ограничения — permission-слой с осью доступности `ToolAccess` (`permission/availability.ts`, эффект `unavailable(mode|role)`); security-промпты `prompts/security/tool-unavailable-mode.{lang}.md` и `tool-unavailable-role.{lang}.md`.
- Единый system prompt у саб-агентов — только вторым аргументом `chatAsync` (двойной system устранён).

### Фаза 2 — CachePolicy и promptState

- `SystemPromptPayload` (`text`/`stablePrefix`/`cacheKey`/`cachePolicy`) в провайдерах (`providers/base.ts`).
- Anthropic: `system` — массив блоков с `cache_control` (≤4, приоритет tools → system → messages, два system-breakpoint'а).
- OpenAI/Remote: `prompt_cache_key`; политика `none` отключает и маркеры, и ключ.
- `promptStates`/`promptMeta` per-agent (`engine/context/prompt-state.ts`); запись только при смене generation; предсказание (`computeExpected`) и валидация (`validateExpected`) hit.

### Фаза 3 — Usage/статистика

- Нормализация usage (`providers/usage.ts`), `stream_options.include_usage` для OpenAI/Remote, чтение `prompt_tokens_details.cached_tokens`.
- Стоимость с cache read/write; `cacheHitRate` в сессии/API/UI.

### Фаза 4 — Прозрачность/debug

- `manifest()` + `PromptManifest` (key/label/tier/chars/estTokens/status/provenance/source).
- `GET /api/v2/sessions/:id/prompt`; UI-секция «Состав промпта» (`components/panels/StatsTab.tsx`).
- `captureSystemPromptParts` оживлён: Composer вызывает его через per-message `debugCollector` во всех точках создания.

### Доработки: прозрачность промпта и профиль пользователя (2026-09-19)

- **Манифест расширен слоем `tools`.** Запись `tools` (`tier: 'stable'`, `source: 'tools'`, `provenance: 'tools'`): `chars` = длина `JSON.stringify` реально отправляемых инструментов; учтена в `totalChars`/`estTokens`/`staticPrefixChars`. System-блоки идут в **реальном порядке отправки** (`role` — первой записью), `tools` вставлен **в конце тира `stable`** (перед первой `context`-записью), т.к. это самый ранний кэшируемый слой. В `compose()`-текст `tools` не входит.
- **Слой истории.** `GET /api/v2/sessions/:id/prompt` отдаёт `history: PromptHistoryInfo`: суммарные отправляемые сообщения (count/chars/estTokens), сгруппированные chronological state-сообщения (`mode_change`/`agent_switch`/`plan_updated`/`todos_updated`), исключённые (`disabled`/`hidden`/`info`), вложения (не-text части) и число плейсхолдеров секретов `⟦SYNTH_SECRET_N⟧`. Вычисляется зеркально `_sessionMessagesToLlm` (`orchestrator._buildPromptHistoryInfo`). Request-параметры (model/temperature/maxTokens) в состав промпта **не включаются — осознанно**.
- **Профиль пользователя.** `_getProfilePrompt`/интервью резолвят профиль через `_resolveProfile(userId)` = `loadProfile(userId) ?? getProfileByUsername(userId)` (`session.userId` хранит username, профиль ключуется по id-UUID); `profilesStore` проброшен в standalone `ContextBuilder` (`server/app.ts`, `server/chat.ts`).
- **UI.** В «Составе промпта» появились строка «Описание инструментов» (`tools`) и секция «История» (раскрывающаяся таблица state-сообщений по типам + исключённые/вложения/секреты). Статистика приведена к единому виду: иконка + имя, окрашенные в цвет сущности (агент — `resolveColor`, пользователь — `userColor`); заголовки колонок «Кэш»/«%»; у агентов убраны «Скорость»/«Длительность»; единый поповер статистики; центрирование иконок.

### Проверки

- `pnpm typecheck` — 6/6 пакетов; `pnpm lint` — 0 errors; тесты: shared 73, core 1407, ui 220, backend 248.
- E2E на провайдере routerai (`qwen/qwen3.7-flash`): 43 тула и в `act`, и в `plan`; `cacheReadTokens` 0 → 7469, `cacheHitRate` 0.499; `promptMeta.expected`/`validated` отрабатывают. Профиль в промпте (83 chars, notes «Зови меня Босс»), `tools` 19126 в `stable`, строки таблиц статистики корректны.
