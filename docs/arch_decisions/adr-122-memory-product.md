# ADR-122: Память как продукт — порты, плагин, индексы и recall

> **Статус:** ⚠️ Частично — плагин памяти, порты и миграции, портал, CLI, scope project/instance, консолидация, граф и вкладка «Память» — в коде; остаток — адаптер Gbrain, Obsidian bridge, авто-консолидация по расписанию и интерактивный граф/canvas.
> **Дата:** 2026-11-04
> **Источник:** PROP-047 (реализованное ядро; vision — docs/MEMORY.md; файл удалён после принятия).
> **Связано:** [ADR-090](./adr-090-extension-api.md) (слой плагинов), [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) (порты и backend'ы), [ADR-107](./adr-107-plugin-facade-services.md) (сервисы фасада — доступ, а не продукт), [ADR-101](./adr-101-pipeline-engine.md)/[ADR-051](./adr-051-scheduler-pipelines.md) (фоновая консолидация), [ADR-094](./adr-094-observability-metrics.md) (метрики).

## Контекст

Память нужна агенту, чтобы переносить устойчивые факты между ходами и сессиями: факты с
provenance, recall по вопросу хода, индексы по файлам/фактам и консолидация дублей. Слой плагинов
(ADR-090) и сервисы фасада (ADR-107) уже давали точку расширения, scoped-доступ к портам и
эмбеддинги через `GatewayProvider`, но **продукта** не было: ни провайдера фактов, ни портала, ни
CLI, ни UI. PROP-047 описывал это как vision с внешним Gbrain и Obsidian; реализовано ядро без
внешних адаптеров.

## Решение

1. **Память — плагин, а не подсистема ядра.** `packages/plugin-memory` (`synth.pack`, `kind: plugin`,
   `mode: inline`) реализует провайдер фактов/recall (`MemoryProviderLite`) и регистрирует блоки
   `context` (устойчивые факты) и `volatile` (recall по ходу), тулы `memory_search`/`memory_write`/
   `memory_forget`/`memory_index`/`memory_consolidate`/`memory_graph`. Тир `stable` запрещён —
   граница prompt-cache (ADR-070).
2. **Порты — в слое хранения.** `MemoryFactRepository` (версии, provenance, `supersededBy`, статусы) и
   `MemoryIndexRepository` (поколения, фингерпринт, чанки с векторами) с реализациями memory/file/PG;
   PostgreSQL — миграции `017-memory`…`020-project-memory`, вектор — `jsonb`, без `pgvector`.
   Сервисы фасада (`facade.memory`/`facade.embed`/`facade.getSettings`) остаются зоной ADR-107.
3. **Портал и CLI.** `/api/v2/memory/*` — чтение статуса/фактов/индексов, мутации индексов,
   консолидация и граф; namespace `plugin:synth-plugin-memory` подставляет сервер. `synth memory
   status|list|index|rebuild|drop` — тонкий клиент API v2.
4. **Область индекса — `project` или `instance`.** Проектный индекс виден только своему проекту;
   инстансный — общий, создаётся/пересобирается/удаляется только порталом (managed — `ADMIN`).
   Память проекта выключается тумблером, данные сохраняются.
5. **Консолидация и граф.** `consolidateFacts` (дубли фактов) и `memory_graph` (чистый движок без
   LLM) доступны как тулы; builtin-шаблоны `builtin:memory-consolidation`,
   `builtin:memory-consolidate-facts`, `builtin:memory-reindex` связывают память с движком пайплайнов
   и расписанием.
6. **Остаток vision.** Адаптер Gbrain (внешний add-on, `mode: remote`), Obsidian bridge,
   авто-консолидация по расписанию «из коробки» и интерактивный граф/canvas не реализованы —
   остаются в PROP-047.

## Альтернативы

- **Память как подсистема ядра.** Нарушает инвариант 2 (запись мимо портов) и инвариант 3
  (эмбеддинги мимо Gateway); плагин получает доступ только через фасад.
- **Только внешний Gbrain без встроенной памяти.** Требует отдельного сервиса и не работает в
  закрытом контуре; встроенный inline-плагин — база, Gbrain — адаптер поверх.
- **Отдельный узкий контракт в обход Extension API.** Отвергнут при принятии ADR-090: контракт
  `MemoryProvider` доставляется плагином, новых точек расширения нет.

## Последствия

- Факты и индексы живут в доменных портах, а не в JSON-файлах плагина; бэкап/перенос и PostgreSQL
  работают штатно.
- Плагин не может завести свои метрики/лейблы: серия `synth_memory_*` — правка core-реестра (ADR-094).
- Встроенная память даёт recall без внешних сервисов; Gbrain/Obsidian остаются опциональным
  расширением и не блокируют продукт.

## Статус в коде

| Что | Где |
|---|---|
| Плагин памяти | `packages/plugin-memory` (`synth.pack`, `src/provider.ts`, `src/blocks/*`, `src/tools/*`, `src/engine/*`) |
| Порты и реализации | `storage/ports/memory-{fact,index}-repository.ts`; `storage/memory/{facts,indexes}.ts`; `storage/file-memory-{fact,index}-store.ts`; `packages/storage-postgres/src/ports/memory.ts` + миграции `017`–`020` |
| Портал | `server/routes/memory.ts`, монтирование — `server/app/mount-routes.ts` |
| CLI | `cli/memory-commands.ts` (`synth memory …`) |
| Scope и память проекта | `MemoryIndexScope` (`project`/`instance`), `?scope=`, `PATCH /memory/indexes/:id`, `PUT /projects/:id {memory:{enabled}}` |
| Консолидация и граф | `plugin-memory/src/engine/{consolidate,graph}.ts`, тулы `memory_*`; `engine/pipelines/builtin.ts` |
| UI | `packages/ui/src/components/panels/MemoryTab.tsx` |

## История

- 2026-11-04 — реализованное ядро PROP-047 вынесено в ADR-122; vision-остаток остаётся в предложении.
