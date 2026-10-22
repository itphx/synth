# PROP-062: Умная оптимизация контекста

> **Статус:** 🧩 Предложение — Умная оптимизация контекста: `archive_context`, авто-суммаризация, приоритизация, стратегии
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D17, «Умная оптимизация контекста», Roadmap Фаза 3);
> текущее состояние проверено по `packages/core/src/engine/context/optimizer.ts`.
> **Связано:** [ADR-070](./adr-070-system-prompt-composer.md), [ADR-097](./adr-097-storage-provider-class.md),
> [PROP-047](./prop-047-memory-gbrain.md), [ADR-026](./adr-026-subagent-context-modes.md),
> [ADR-036](./adr-036-llm-gateway.md), [ADR-035](./adr-035-micro-model-first.md).

**Решение:** дополнить существующий `ContextOptimizer` **умной оптимизацией контекста** — сделать
управление историей сообщений не только порогово-механическим (окно/порог токенов), но и
**семантическим**:

- **Тул `archive_context(range)`** — сама LLM помечает неактуальные сообщения/блоки для архивации
  (по диапазону/идентификаторам), вместо только «обрезать хвост».
- **Автоматическая суммаризация старых блоков** при приближении к лимиту токенов (сейчас
  суммаризация запускается по порогу, но не привязана к «важности»).
- **Приоритизация сообщений**: важные (решения, планы, ошибки, вызовы инструментов и их результаты)
  остаются; «болтовня» и промежуточные рассуждения сворачиваются первыми.
- **Стратегии `aggressive` / `moderate` / `off`** — единый профиль интенсивности вместо набора
  отдельных флагов.
- **Хранилище архива**: архивированное не теряется — уходит в память проекта
  ([PROP-047](./prop-047-memory-gbrain.md)) и/или в `context_snapshot`
  ([ADR-097](./adr-097-storage-provider-class.md)), при необходимости подтягивается назад
  (recall).

## Контекст

### Что уже есть

`ContextOptimizer` — `packages/core/src/engine/context/optimizer.ts`. Режим выбирается полем
`session.settings.contextOptimization` (`packages/shared/src/types/index.ts:546`) со значениями
`'none' | 'sliding_window' | 'summarization' | 'sticky_notes'`; `getMessagesForLlm()` (`:92`) —
точка входа, дальше `_getMessagesForSlidingWindow` / `_getMessagesForSummarization` /
`_getMessagesForStickyNotes`.

- **`sliding_window`** — порог по токенам или по числу пользовательских сообщений
  (`slidingWindowMode`, `slidingWindowTokenThreshold`, `slidingWindowMessageLimit`); старые
  сообщения помечаются `disabled` (`SlidingWindowResult` с `disabledCount`, причина `tokens`/`messages`).
- **`summarization`** — голова/хвост (`summarizationHeadMessages` / `summarizationTailMessages`),
  режим срабатывания (`summarizationTriggerMode`), отдельный провайдер/модель
  (`summarization.provider` / `summarization.model`, `SummarizationConfig`); результат — summary-сообщение,
  кэшируется в памяти процесса `_summaryCache`.
- **`sticky_notes`** — закреплённые заметки (см. также `builder.ts`, `composer.ts`,
  `prompt-blocks.ts`).
- Фильтрация по умолчанию исключает `disabled`/`hidden`/`ephemeral`-сообщения и роль `INFO`.
- Суммаризация идёт **через LLM Gateway** (`setGatewayHooks()` → `ContextOptimizerGatewayHooks`,
  [ADR-036](./adr-036-llm-gateway.md)): guard, обфускация, rate limit, аудит.
- Метрики отладки — `DebugCollector` (`packages/core/src/debug.ts`).

### Чего нет

- Тула `archive_context` — **нет** (grep по `packages/**` без `dist/`/`node_modules/` — 0 вхождений).
- Авто-суммаризации «по приближению к лимиту» с учётом приоритета — нет; порог задаётся вручную.
- Приоритизации сообщений (по тегам, наличию tool-calls, рекурсии) — нет.
- Профилей `aggressive`/`moderate`/`off` — нет.
- `context_snapshot` ([ADR-097](./adr-097-storage-provider-class.md)) — не реализован.

## Детали

### 1. Тул `archive_context`

`archive_context(range)` — управляется самой моделью через Tool Use ([ADR-039](./adr-039-plan-in-project.md),
инвариант №11): агент явно указывает, что уже неактуально (диапазон сообщений/блоков), и это
уходит в архив, а не удаляется. Тул не заменяет `plan_*`/`todo_*`; это операция над историей сессии.

Требует:
- представления `range` (по индексам/message id/временным меткам);
- семантики «архивировать» vs `disabled` (есть сейчас) vs `hidden`/`ephemeral`;
- возврата в контекст (recall) — через память/снапшот.

### 2. Авто-суммаризация по лимиту

Сейчас суммаризация срабатывает по заданному порогу. Нужно: перед формированием запроса к LLM
оценивать близость к окну (уже есть `getContextWindow()` и подсчёт токенов) и автоматически
сворачивать **самые малозначимые** блоки раньше значимых.

### 3. Приоритизация сообщений

Оценка «важности» сообщения (эвристики, не обязательно LLM):
- наличие `tool_use`/`tool_result` — выше (структурная цепочка ломается при вырезании);
- планы/решения, `plan.approved`-связанные сообщения — выше;
- ошибки и их разрешение — выше;
- приветствия, small talk, промежуточные рассуждения — ниже.

Приоритизация должна согласовываться с `ContextBuilder`/`SystemPromptComposer`
([ADR-070](./adr-070-system-prompt-composer.md)), чтобы не ломать prompt-cache.

### 4. Профили стратегий

`aggressive` / `moderate` / `off` — пресеты, объединяющие пороги, долю сворачивания и политику
архивации. Хранить в конфиге ([ADR-023](./adr-023-configuration.md), секция `context`) и/или в
`session.settings` (runtime override), читать через `@itphx/synth-shared/config`.

### 5. Хранилище архива

Архив — не «мусорка»: это вход в память проекта ([PROP-047](./prop-047-memory-gbrain.md)) и/или
`context_snapshot` ([ADR-097](./adr-097-storage-provider-class.md)) с возможностью recall.
Формально это отдельный вопрос: где хранить, как индексировать, как подтягивать обратно.

## Статус реализации в коде

**Не реализовано, кода нет.** Проверено по репозиторию (`packages/**`, без `dist/`/`node_modules/`):

- `archive_context` / `archiveContext` — 0 вхождений.
- `ContextOptimizer` содержит только `sliding_window` / `summarization` / `sticky_notes`
  (`optimizer.ts:96–101`), поля конфигурации — `slidingWindow*`, `summarization*`,
  `contextOptimization` (`packages/shared/src/types/index.ts:546`).
- `context_snapshot` (ADR-096) и storage backbone памяти (PROP-047) отсутствуют.
- Метрики — только `DebugCollector` (общий debug), специализированных метрик оптимизации контекста нет.

## Открытые вопросы

- Хранить архив в проекте или в памяти ([PROP-047](./prop-047-memory-gbrain.md))?
- Как измерять «важность» сообщения — теги, наличие tool-calls, рекурсия, эвристики или LLM?
- Совмещать с `sticky_notes` или заменять их?
- Как `archive_context` взаимодействует с уже существующими `disabled`/`hidden`/`ephemeral`?
- Как приоритизация и авто-суммаризация влияют на prompt-cache ([ADR-070](./adr-070-system-prompt-composer.md))?
- Само `archive_context` — встроенный тул или часть контекстного слоя без отдельного ToolCapability?

## Связи

- [ADR-070](./adr-070-system-prompt-composer.md) «SystemPromptComposer» — тиры `stable/context/volatile`,
  prompt-cache; оптимизация контекста должна не ломать кэш.
- [ADR-097](./adr-097-storage-provider-class.md) «Хранение истории на PostgreSQL» — `context_snapshot`
  как место хранения/recall архива.
- [PROP-047](./prop-047-memory-gbrain.md) «Память Synth (Gbrain + композиция)» — память как долгосрочный
  архив и источник recall.
- [ADR-026](./adr-026-subagent-context-modes.md) «Режимы контекста саб-агента» — `summary`/`last_n` как
  родственные механизмы усечения.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — суммаризация только через `GatewayProvider`.
- [ADR-035](./adr-035-micro-model-first.md) «Micro-model first» — потенциально дешёвая классификация
  «важности» без большого LLM.
- [ADR-039](./adr-039-plan-in-project.md) «План/todo через Tool Use» — `archive_context` как ещё одна
  Tool-Use-операция.
- [ADR-023](./adr-023-configuration.md) «Конфигурация» — секция `context` и профили стратегий.
- [packages/core/AGENTS.md](../../packages/core/AGENTS.md) — слой `engine/context/*`.
