# AD-047: Память Synth (Gbrain + композиция)

> **Статус:** ⏳ Не реализовано (проект)
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D2, идея 2); Obsidian-vault `Memory-Architecture.md`,
> `Memory-Analysis.md`, `Roadmap.md` (Фаза 3); прототип `~/dev/aic/t11` (`app/embeddings/`).
> **Связано:** [AD-032](./ad-032-history-storage-postgresql.md), [AD-026](./ad-026-subagent-context-modes.md),
> [AD-062](./ad-062-context-optimization.md), [AD-005](./ad-005-json-storage.md),
> [AD-036](./ad-036-llm-gateway.md), [AD-070](./ad-070-system-prompt-composer.md),
> [AD-085](./ad-085-multimodal-input.md).

**Решение:** построить подсистему памяти Synth как **композицию четырёх open-source систем**, а не как
единственный «RAG-модуль»:

- **Gbrain** — storage backbone: PostgreSQL + PGLite/pgvector, MCP с 30+ тулами, self-wiring граф `[[entity]]`,
  schema packs, *Dream Cycle* (фоновая консолидация), gap analysis;
- **TokenJuice** (репо `tinyhumansai/openhuman`) — 7 компрессоров tool output + CCR-кэш (`⟦tj:hash⟧`);
- **SuperContext** — pre-fill scout и read-only «burst»-LLM, наполняющий контекст до основного вызова;
- **MemPalace-inspired** — 4-слойная выдача L0–L3, организация Wing/Room/Hall.

Пакеты — `@synth/memory/*`: `storage` / `retrieval` / `compression` / `scout` / `graph` / `obsidian-bridge` /
`manager`. **Obsidian Bridge** — двусторонняя синхронизация `.md` (при конфликте побеждает человек).

## Контекст

### Что уже есть в Synth

- Долговременное состояние проекта: `project.log` / `project.invariants` / `project.plan`; sticky notes;
  ссылки на сессии (`read_session_reference` — `packages/core/src/engine/tools/read-reference.ts`).
- Summary-кэш контекста в памяти процесса — `ContextOptimizer` (`packages/core/src/engine/context/optimizer.ts`).
- Embeddings — **только** для micro-слоя микро-маршрутизации (AD-035):
  `packages/core/src/engine/router/micro/models/embedding-model.ts`.
- `context_snapshot` (AD-032) **не реализован**; физическое хранилище истории — JSON (AD-005).

### Проблема

Текущая «память» — это набор точечных JSON-полей и summary в памяти процесса: она не переживает процесс,
не масштабируется на объём, не поддерживает гибридный поиск и не покрывает одновременно **память** и
**код/документацию проекта**. Прототип t11 умел локально строить RAG-индексы по проекту
(`~/dev/aic/t11/synth/app/embeddings/` — `indexer.py`, `search.py`, `_search_project_rag`), в Synth этого нет.
Память также нужна как «топливо» для Loop Engine (D12/AD-057), Council (D13/AD-058), оптимизации контекста
(D17/AD-062), обучения и метрик (D18/AD-063).

## Детали

### Storage backbone

- Целевое хранилище — PostgreSQL + pgvector; для «0-серверного» режима — PGLite. Окончательный выбор
  (PGLite vs внешний PostgreSQL) решается вместе с AD-032.
- **Gbrain портируется на TypeScript.** Первый шаг — попробовать подключить его как **внешний модуль через
  MCP** и оценить, как он ложится на архитектуру Synth; затем решать о полном порте.

### RAG

- RAG покрывает **и память, и код/документацию проекта** — не только память.
- Гибридный поиск: vector + keyword + RRF-слияние + rerank. Gbrain сам является RAG-реализацией
  (hybrid retrieval, слой L3 в 4-layer stack).
- Отдельно исследовать, совместим ли «каталог индексов» (ниже) с hybrid retrieval Gbrain — или нужны
  раздельные индексы для памяти и для кода/доков.

### Компрессия, scout и выдача

- **TokenJuice**-компрессоры сокращают tool output до попадания в контекст; CCR-кэш (`⟦tj:hash⟧`) позволяет
  ссылаться на сжатое без потери доступа к оригиналу.
- **SuperContext**-scout пре-наполняет контекст релевантными фрагментами до основного LLM-вызова.
- **4-layer retrieval** L0–L3 (от точного совпадения к семантике) + структура Wing/Room/Hall.
- **MemoryManager** — оркестратор, скрывающий выбор слоя/источника от оркестратора чата.

### Каталог индексов

- Повторить фичу t11: **локально строить индексы и отправлять на сервер**. Нужен **каталог индексов**,
  подключаемых к конкретным проектам (локальный → серверный).

### Schema packs и обслуживание

- Schema packs под предметные области Synth; Dream Cycle и gap analysis — фоновая консолидация и поиск
  «пробелов» в знаниях.

## Статус реализации в коде

**Не реализовано.**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- Нет подсистемы памяти: grep по `gbrain`, `pgvector`, `indexer`, `RAG`/`rag` — совпадений в продуктовом
  коде нет (единственное вхождение `RAG` — комментарий в `packages/core/src/engine/commands/builtin.ts`).
- `@synth/memory/*`, `MemoryManager`, Obsidian Bridge, TokenJuice, SuperContext, каталог индексов —
  отсутствуют.
- Существует только точечная «память»: `project.log` / `project.invariants` / `project.plan`, sticky notes,
  `read_session_reference` (`packages/core/src/engine/tools/read-reference.ts`), summary-кэш
  `ContextOptimizer` (`packages/core/src/engine/context/optimizer.ts`).
- Embeddings есть только для micro-слоя: `packages/core/src/engine/router/micro/models/embedding-model.ts`.
- `context_snapshot` (AD-032) не реализован; физическое хранилище — JSON/FileStore (AD-005).

> Отдельные пути из черновика (`packages/core/src/engine/context/optimizer.ts`) подтверждены; каталог
> `packages/core/src/engine/context/` с тех пор расширился (`builder.ts`, `composer.ts`, `instructions.ts`,
> `lazy-instructions.ts` и т. д.) — при реализации учитывать актуальную структуру.

## Открытые вопросы

- Как каталог индексов (t11-style: локальные → сервер) бьётся с Gbrain и не конфликтует ли с его hybrid
  retrieval?
- PGLite (0 сервер) vs внешний PostgreSQL? — решается вместе с AD-032.
- SuperContext под GPL — брать код или только идею?
- Мульти-инстанс изоляция (company brain) — как ложится на профили Synth (AD-045/AD-079)?
- Как совместить RAG по коду/докам с Gbrain L3 — один индекс или раздельные?

## Связи

- [AD-032](./ad-032-history-storage-postgresql.md) «Миграция хранения истории на PostgreSQL» — физический
  storage backbone для памяти.
- [AD-026](./ad-026-subagent-context-modes.md) «Режимы контекста саб-агента» — summary-режимы, питающиеся памятью.
- [AD-062](./ad-062-context-optimization.md) «Умная оптимизация контекста» — потребитель памяти (D17).
- [AD-005](./ad-005-json-storage.md) «JSON-хранилище» — текущий слой хранения до AD-032.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — все LLM-вызовы памяти (scout/rerank) идут через GatewayProvider.
- [AD-070](./ad-070-system-prompt-composer.md) «SystemPromptComposer» — встраивание памяти в промпт и статистика.
- [AD-085](./ad-085-multimodal-input.md) «Мультимодальный ввод» — RAG по документам/изображениям (D27).
- Потребители памяти: D12/AD-057 (Loop Engine), D13/AD-058 (Council), D18/AD-063 (обучение и метрики).
- Внешние референсы: Gbrain, `tinyhumansai/openhuman` (TokenJuice), SuperContext, MemPalace; прототип
  `~/dev/aic/t11/synth/app/embeddings/`.
