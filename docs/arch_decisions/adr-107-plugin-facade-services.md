# ADR-107: Сервисы фасада плагинов — память, эмбеддинги, свои настройки

> **Статус:** ✅ Реализовано
> **Дата:** 2026-10-24
> **Связано:** [ADR-090](./adr-090-extension-api.md) (слой плагинов — канон; здесь расширяется его периметр),
> [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) (порты, контрактный suite),
> [ADR-036](./adr-036-llm-gateway.md) (Gateway), [PROP-047](./prop-047-memory-gbrain.md) (память как плагин),
> [ADR-094](./adr-094-observability-metrics.md). Устройство — [docs/MEMORY.md](../MEMORY.md),
> авторская спека — [docs/PLUGINS.md](../PLUGINS.md) §4.5–4.7.

## Контекст

[ADR-090](./adr-090-extension-api.md) дал плагину три точки (`promptBlocks`, `llmFilters`, `tools`) и фасад
из четырёх методов — достаточно, чтобы **подмешать** контент в промпт, но не чтобы **быть памятью**
([PROP-047](./prop-047-memory-gbrain.md)): плагину негде хранить факты и индексы (инвариант 2 запрещает
писать в `$SYNTH_DATA_DIR` мимо порта), нечем считать эмбеддинги (провайдер недоступен, а прямой вызов —
нарушение инварианта 3) и неоткуда взять свои настройки (`plugins.json` их хранит, плагин — не читает).
Плюс inline-тул плагина получал `ToolContext.extra` с `sessionManager`/`projectStore`/`eventBus`, то есть
internals ядра, тогда как `out-of-process` по проводу — только `{sessionId, messageId, workingDir}`.

## Решение

1. **Сервисы фасада, а не новые точки расширения.** Доступ к ресурсам инстанса — вызов хоста, а не вклад;
   ADR-090 v1 остаётся закрытым с тремя точками.
2. **`memory` — порты памяти через scoped-обёртку.** В слой хранения добавлены доменные порты
   `MemoryFactRepository` (версии, provenance, `supersededBy`, статусы) и `MemoryIndexRepository`
   (поколения, фингерпринт, чанки с векторами); реализации — memory/file/PG (миграция `017-memory`,
   вектор — `jsonb`, без `pgvector`), контрактный suite на всех трёх. Фасаду отдаётся **не** порт, а
   обёртка: namespace `plugin:<имя>` навязывает хост, чужие записи выглядят как «не найдено» (не 403 —
   иначе перебором id можно выяснить чужое).
3. **`embed` — только через `GatewayProvider`.** Хост инъецирует функцию из точки сборки
   (`ProviderFactory.create` → `wrapProviderWithGateway` → `GatewayProvider.embed`): guard, обфускация,
   rate-limit, аудит, embedding-фаза `llmFilters`. Политика ядра — лимиты (64 текста / 8 000 символов /
   64 000 суммарно), перекрытие `provider`/`model` аргументом, валидация результата. Дефолты —
   `plugins.embeddingProvider`/`embeddingModel` (+ runtime-override).
4. **`getSettings` — только чтение своих настроек:** `plugins[<имя>].settings` из `plugins.json`, имя из
   активации, снимок на каждый вызов, замороженная копия, любая ошибка → `{}`. События изменения не
   вводим — writer'а per-plugin настроек нет.
5. **Сужение контекста тула.** Для `source: 'plugin'` в единственной точке вызова (`executeToolDef`)
   `ToolContext` сужается до `sessionId`/`messageId`/`workingDir`/`agentRole?`/`projectId?`/`abortSignal?` —
   без `extra`/`dataDir`, симметрично `out-of-process`. `projectId` — метаданные сессии (не internals
   ядра): без них плагинный тул не знает, чей это проект, и не может ограничить поиск его данными.
6. **Граница транспорта.** Сервисы доступны **только `inline`**: wire-протокол v1 покрывает три точки.
   `out-of-process`-плагину с собственным хранилищем порт не нужен (модель Gbrain).

## Статус в коде

| Что | Где |
|---|---|
| Порты фактов и индексов | `storage/ports/memory-fact-repository.ts`, `memory-index-repository.ts`; поля `StorageContext.memoryFacts/memoryIndexes` |
| Реализации | `storage/memory/{facts,indexes}.ts`, `storage/file-memory-{fact,index}-store.ts`, `packages/storage-postgres/src/ports/memory.ts` + миграция `017-memory.ts` |
| Контрактный suite | `storage/contract/memory.ts` (+ блоки в `memory.test.ts`/`file.test.ts`/`postgres.test.ts`) |
| Scoped-доступ | `engine/plugins/scoped-memory.ts`; обёртка на плагин — `engine/plugins/plugin-host.ts` |
| Эмбеддинги | `engine/plugins/embed.ts`; инъекция — `server/app/deps.ts`, `backend/app/deps.ts` |
| Настройки | `engine/plugins/settings.ts`; ридер по умолчанию — `engine/plugins/runtime.ts` |
| Сужение контекста тула | `engine/tools/tool-execution.ts` (`narrowToolContext`) |
| Конфиг | `shared/config/{types,defaults,env-overrides}.ts` (`plugins.embedding*`), `storage/runtime-settings.ts` (`mergePluginsConfig`) |

## Альтернативы

- **Отдать плагину сырые порты** — отвергнуто: плагин увидел бы и перезаписал чужую память.
- **Каталог данных плагина** (`<home>/plugin/data/<name>/`) — отвергнуто: исключение из инварианта 2, нет
  бэкапа, `storage migrate`, retention и PG. Осталось режимом для `out-of-process`-провайдера.
- **Четвёртая точка (`routes`/`hooks`/`settings`)** — отвергнуто: ADR-090 v1 закрыт с тремя точками;
  портал памяти живёт в ядре, пакетный ingest идёт пайплайном (ADR-101).
- **Эмбеддинги мимо Gateway** — отвергнуто: дыра инварианта 3 на пользовательском тексте.
- **Создание провайдера внутри `engine/plugins/*`** — отвергнуто: вторая точка создания провайдеров.

## Последствия

- Плагин может быть полноценной памятью, не получая internals ядра; изоляция проверяема (namespace
  навязан хостом, кросс-namespace ссылки отсекаются, чужое неотличимо от несуществующего).
- У слоя плагинов появился контракт доступа к ресурсам инстанса: дальнейшее расширение (например,
  `routes`) должно быть осознанным решением, а не «ещё одним методом фасада».
- `getSettings` — блокирующий `readFileSync` на каждый вызов: приемлемо для маленького `plugins.json`,
  но при росте файла это надо пересмотреть.
- `out-of-process` неравноправен с `inline` по сервисам — задокументировано; паритет потребует
  wire-протокола v2.

## История

- 2026-10-24 — решение принято и реализовано: порты памяти (+PG-миграция 017, контрактный suite), scoped
  `facade.memory`, `facade.embed` через Gateway, `facade.getSettings`, сужение `ToolContext` для
  плагинных тулов.
- 2026-10-24 — в сужение `ToolContext` добавлен `projectId` (проект сессии): плагинный тул памяти
  ограничивает поиск данными своего проекта.
