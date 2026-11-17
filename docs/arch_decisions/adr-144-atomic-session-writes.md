# ADR-144: Запись сессии — только точечные мутации

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-17
> **Источник:** инцидент `mwgvzwfc-33-2h30b0lt` (потеря tool-сообщений); PR-этапы `decd0ca7`…`0871f834`.
> **Связано:** [ADR-096](./adr-096-storage-layer.md) (порты хранения), [ADR-097](./adr-097-storage-provider-class.md) (PostgreSQL-драйвер), [ADR-098](./adr-098-storage-degraded-recovery.md) (деградация), [ADR-116](./adr-116-instance-state-and-blob-ports.md) (порты состояния), [ADR-118](./adr-118-message-stream-v2.md) (§2 `ord`, §4 точечные записи), [ADR-104](./adr-104-mid-turn-steering.md) (steering), [ADR-141](./adr-141-timers-alarms.md) (доставка таймера), [ADR-005](./adr-005-json-storage.md) (атомарная запись файла).

## Контекст

Документ сессии — один JSON: метаданные, история (`messages`), очередь
(`pendingMessages`/`steerInbox`), заметки, планы шагов. Пока персистентность
шла связкой `withLock` → **load снимка** → правка в памяти → `saveSession`
(полная замена), а вторая половина цикла писала **точечно** (`appendMessage`/
`updateMessage`, ADR-118 §4), две записи пересекались: снимок, прочитанный до
чужой дозаписи, записывался **поверх** неё.

Инцидент: ход писал tool-результаты шага `appendMessage`, а параллельный путь
(доставка инъекции timer-steer, ADR-104 × ADR-141) делал `withLock`+`saveSession`
по снимку, взятому раньше. Tool-сообщения текущего шага исчезали из истории —
в UI и в следующем LLM-запросе (пары `tool_use`/`tool_result` рвались). Окно
«перечитать перед сохранением» не помогает: гонка принципиальная — между
чтением и записью всегда есть место для `appendMessage`.

## Решение

1. **Домен пишет сессию только точечными операциями порта `SessionRepository`**
   (`mutateMeta`/`mutateHistory`/`mutateMessage`/`appendMessage`/`updateMessage`).
   Чтение и запись идут **под одним локом**, мутатор применяется к свежему
   документу и синхронный (I/O внутри лока запрещён).
2. **Полная запись (`save`/`saveSession`/`updateSession`) — только
   create/import/replace:** материализация (`createSession`, `forkSession`),
   импорт архива/сессии, перенос проекта между инстансами и между backend'ами
   хранения (`synth storage migrate`).
3. **Семантика мутаций** (`storage/ports/session-repository.ts`):
   - `mutateMeta` — правит метаданные, историю не читает и не пишет;
   - `mutateHistory` — свежий документ целиком, `seq` нормализуется позиционно,
     `ord` ранее выданных сообщений не перенумеровывается;
   - `mutateMessage` — одно сообщение по `id`; `id`/`seq`/`createdAt`/`ord`
     иммутабельны, поздняя запись черновика поверх терминального не применяется;
   - `shouldWrite(value)` — «посчитал, но не пишу» (no-op не оживляет сессию);
   - `touchUpdatedAt: false` — запись есть, `updatedAt` сессии не двигается
     (служебные метки, state-сообщения, сид `todos`).
4. **Атомарность.** FileStore / in-memory — per-session `AsyncLock` **в пределах
   процесса**; PostgreSQL — транзакция + `pg_advisory_xact_lock` (advisory-лок
   берётся **до** чтения строки/child-таблиц). Форма хранения не меняется:
   точечные операции — это операции порта, а не новый формат.

## Альтернативы

- **Версионирование документа (оптимистичная блокировка на каждом save)** —
  отклонено: ретраи на каждом конфликте, правки всё равно переписывают историю,
  а конфликт — норма (дозапись сообщений идёт постоянно).
- **Оставить `withLock`+`saveSession`, но перечитывать снимок «прямо перед»
  записью** — отклонено: окно не исчезает, инцидент воспроизводится.
- **Отдельная таблица/файл на каждое поле** — отклонено: формат и порт
  переписываются ради того, что уже выражается мутациями.

## Последствия

- **Census-гвард:** `packages/core/src/sessions/session-write-census.test.ts`
  сканирует `packages/core/src` и `packages/backend/src` и падает на полной
  записи вне allowlist (`sessions/manager.ts`, `projects/portable.ts`,
  `remote/transfer.ts`, `backend/src/routes/sessions.ts`,
  `maintenance/storage-migrate.ts`). Новый «удобный save» не проскочит.
- **Производительность:** `mutateHistory` пишет историю целиком (как и прежний
  `save`, но со свежим снимком под локом); метаданные и одно сообщение —
  точечно, без чтения/записи истории.
- **Остатки.** (1) FileStore не защищён **межпроцессно** — несколько процессов
  на одном `dataDir` по-прежнему могут пересечься (координация есть только у
  PostgreSQL); (2) позиционные индексы (план сжатия/`keepFrom`, чекпоинты) не
  переживают вставку в начало истории: `seq` перенумеровывается, `ord` остаётся
  монотонным — план строится в том же снимке, где применяется.

## Статус в коде

Порт — `packages/core/src/storage/ports/session-repository.ts`; реализации —
`storage/file-store.ts`, `storage/memory/sessions.ts`,
`packages/storage-postgres/src/ports/sessions.ts`; домен —
`sessions/manager.ts` (`mutateMeta`/`mutateHistory`/`mutateMessage`); потребители:
`engine/orchestrator/*`, `queue/processor.ts`, `engine/tools/task/*` (в т.ч.
`fork.ts`), `engine/context/optimizer.ts`, `engine/plan`/`todo`, `sessions/move-service.ts`;
гвард — `sessions/session-write-census.test.ts`.

## История

- 2026-11-17 — принято: этапы 1–3b (`decd0ca7`…`0871f834`), census-тест, ADR.
