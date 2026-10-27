# ADR-113: Фоновые процессы — реестр, control plane и исполнитель

> **Статус:** ✅ Реализовано — 2026-10-26 (inline и remote, протокол исполнителя v3). Detach идущего шелла — контракт зафиксирован 2026-10-27 (см. «Detach идущего шелла»; реализация впереди).
> **Дата:** 2026-10-26
> **Связано:** [ADR-077](./adr-077-runtime-toolchain.md) (исполнитель; шаг 7c — фоновые процессы),
> [ADR-111](./adr-111-background-subagent-sessions.md) (единый реестр фоновых прогонов, фоновые саб-агенты),
> [ADR-096](./adr-096-storage-layer.md) (порты слоя хранения),
> [ADR-094](./adr-094-observability-metrics.md) (наблюдаемость: события и метрики),
> [ADR-024](./adr-024-eventhub-transport.md) (единый транспорт событий — новых каналов нет),
> [ADR-005](./adr-005-json-storage.md) (атомарная запись реестра),
> [PROP-097](./prop-097-background-processes-registry.md) (исходное предложение).

## Контекст

Тул `execute_shell` был **синхронным**: команда исполнялась через `execFile` с таймаутом 30 секунд,
и длительные процессы (dev-сервер, сборка, обучение) либо блокировали ход агента, либо обрывались по
таймауту. Реестра процессов не было: у control plane не было ни записи о запущенном процессе, ни
способа его остановить, ни журнала вывода; UI не показывал фоновую работу вовсе. Отдельной сложностью
был split-режим (ADR-077): процесс должен жить **там, где есть toolchain и рабочий каталог**, то
есть на исполнителе, — а реестр и UI остаются в control plane.

## Решение

1. **Единый реестр — доменный порт, второй вид записи, а не второе хранилище.** Порт
   `BackgroundRunRepository` (ADR-096), запись `BackgroundRunRecord` с `kind: 'process'`:
   `{ id, sessionId, projectId?, command, cwd, pid, processId?, status, logPath, exitCode?, signal?,
   startedAt, finishedAt?, updatedAt, summary?, metadata? }`. Реализации: файл
   `{dataDir}/processes/registry.json` (атомарная запись, ADR-005), в-памяти и PostgreSQL (миграция
   `021-background-runs`); контрактный suite обязателен, как для любого порта. Фоновые саб-агенты
   (ADR-111) живут в **том же** реестре видом `kind: 'subagent'`.
2. **Control plane — сервис `ProcessService` над портом исполнения.** Запуск идёт **только** через
   `ExecutionPort.spawnBackground` (ADR-077) — и в `inline`, и в `remote`; вывод процесса пишется в
   `BlobStore` (`processes/<id>.log`, дописывание), лимит — `background.logMaxBytes` (при превышении
   запись прекращается и в записи ставится `metadata.truncated`, **процесс не убивается**);
   `stop` — `SIGTERM`, через 5 с — `SIGKILL`; `logs(offset, limit)` — чтение отрезка журнала.
   События в канале сессии-владельца: `process.started`, `process.stopped` (запрос остановки, один
   раз на прогон) и `process.exited` (терминальный статус — приходит позже); по завершении
   публикуется `fs.changed { scope: 'all' }`, чтобы UI перечитал рабочее дерево. Логи и записи
   чистит pruner (`engine/processes/prune.ts`).
3. **Тул `execute_shell({background: true})` — управление возвращается сразу.** Ответ:
   `{ process_id, background_run_id, log_path, status: 'running' }`. Гейт `background.enabled`
   (выключатель — ошибка тула, ход не падает). **Permission-слой не обходится**: те же проверки, что
   и для обычного shell, — сканирование команды, защищённые пути, containment `cwd` (ADR-029);
   `background` меняет только способ ожидания, а не права.
4. **Завершение — уведомление родителя и автоход.** Терминальный переход кладёт в историю сессии
   сообщение роли USER (автор `Process`) с конвертом
   `<process processID="…" state="exited|failed|killed" command="…">` и хвостом лога (≤ 4000
   символов — этого хватает модели, чтобы понять итог), затем родительский ход ставится в очередь.
   Лимиты сессии: `background.maxProcessesPerSession` и `background.maxRunsPerSession`
   (`background_limit_exceeded` — ошибка тула, ход не падает).
5. **Remote: процесс живёт на исполнителе, протокол v3.** Исполнитель (`@itphx/synth-executor`)
   держит `BackgroundExecService` (реестр — в памяти процесса исполнителя, журналы — на диске
   исполнителя, раздельные `stdout`/`stderr`) и отдаёт четыре маршрута:
   `POST /exec/spawn`, `GET /exec/:id`, `GET /exec/:id/logs` (раздельные stdout/stderr, offsets) и
   `POST /exec/:id/stop` с телом `{ signal: 'SIGTERM' | 'SIGKILL' }` (иначе — `400`). Control plane
   **не стримит**: он **опросает** исполнителя — состояние каждые 500 мс, журнал каждые 300 мс;
   выбор адреса — тем же механизмом `requires`, что и у `execute`, плюс требование
   `features.background` (протокол ≥ 3). Исполнитель **старой версии** (протокол < 3, фоновых
   маршрутов не знает) → `EBACKGROUND` → `background_unsupported` — fail-closed.
6. **API и UI.** `/api/v2/processes` — `GET` (список), `GET /:id` (детали), `GET /:id/logs` (журнал),
   `POST /:id/stop` (остановка), `DELETE /:id` (удаление записи) — доступ проверяется
   **на границе** (guard `processGuard` резолвит запись и сессию-владельца один раз; вид доступа — по
   HTTP-методу: `read` читает, `write` мутирует). UI — вкладка «Процессы»: фоновые шелл-процессы
   и фоновые саб-агенты в одном списке, чтение журнала и остановка.

## Detach идущего шелла

Перевод уже идущего `execute_shell` в фон (ADR-111 «Перевод идущего прогона в фон (detach)»)
требует того, чего у порта исполнения сегодня нет: **хэндла процесса**.

1. **Чего не хватает.** `ExecutionPort.execute()` возвращает `{ stdout, stderr }` **после**
   завершения команды — отвязывать нечего: ни `pid`, ни потоков, ни промиса завершения, ни
   способа остановить. Поэтому detach шелла — **расширение контракта порта**, а не правка
   `ProcessService`.
2. **Контракт хэндла.** `execute()` (либо отдельный метод порта) отдаёт хэндл живого
   процесса: `pid`, `processId?` (идентификатор на исполнителе), `stdout`/`stderr` (потоки
   или буфер с offset'ом), `exited` (промис `{ code, signal }`), `stop(signal)`.
   `inline`-реализация берёт его из `spawn` (не `execFile`); `remote`/исполнитель — из
   `POST /exec/spawn` (протокол ≥ 3) с опросом `GET /exec/:id` и `GET /exec/:id/logs` и
   остановкой `POST /exec/:id/stop` — те же маршруты, что у фонового запуска (п. 5).
3. **Что делает detach.** `ProcessService.startProcess` регистрирует запись `kind:'process'`
   **из готового хэндла** (`pid`/`processId` уже известны — второй процесс не запускается),
   поднимает `ProcessLogWriter` на `processes/<id>.log` (`BlobStore`, лимит
   `background.logMaxBytes`) и **дописывает** в журнал уже полученный вывод из накопленного
   буфера; `ctx.abortSignal` родительского хода от процесса **отвязывается** — отмена хода
   его больше не убивает. Остановка — только `POST /api/v2/processes/:id/stop`
   (`SIGTERM` → `SIGKILL`, п. 2).
4. **Событие.** Публикуется `process.detached` (`{ session_id, kind:'process', id,
   background_run_id?, title? }`, канал сессии-владельца); `process.started` не публикуется
   (прогон уже шёл), терминальные — обычные `process.stopped`/`process.exited`, уведомление
   родителю с хвостом лога — как при обычном фоновом запуске (п. 4 «Решение»).
5. **Ограничение split-режима.** Хэндл возможен, только если исполнитель его отдаёт:
   протокол < 3 (`background_unsupported`) или порт без контракта хэндла (старый клиент,
   чужой драйвер исполнения) → detach **честно** отклоняется — `DETACH_UNSUPPORTED`
   (`400` на HTTP, ошибка тула в агенте). «Тихого» fallback нет: отвязать шелл, не имея
   хэндла, значит потерять процесс.
6. **Восстановление после рестарта.** Маркер «в фоне, уведомление не доставлено» и пометка
   «отменён из-за перезапуска» для прогона, которого уже нет, — те же, что у фонового
   запуска (ADR-111 п. 3/п. 6): маркер живёт в порте хранения, авто-возврата в foreground нет.

## Последствия и границы

- **Реестр исполнителя — в памяти.** Он не переживает рестарт исполнителя: процессы там
  пропадают, а запись в control plane остаётся `running` → при рестарте control plane она
  переводится в `orphaned` («честно показывает незавершённость»).
- **Логи дублируются.** Журнал лежит на исполнителе (до `prune()`, ~час) и одновременно пишется в
  control plane через `BlobStore` — иначе UI в control plane не увидит вывод удалённого процесса.
- **Live-tail — polling, не WebSocket.** Новый транспортный канал не заводится (ADR-024): журнал
  читается отрезками по offset.
- **`stop` ограничен SIGTERM/SIGKILL.** Других сигналов нет: произвольный сигнал потребовал бы
  иного контракта с исполнителем и иной модели эскалации.

## Статус в коде

| Что | Где |
|---|---|
| Контракт записи | `shared/types/background.ts` (`BackgroundRunRecord`, `BackgroundRunKind = 'subagent' \| 'process'`) |
| Порт и реализации | `core/storage/ports/background-run-repository.ts`; `core/storage/file-background-run-store.ts` (`{dataDir}/processes/registry.json`), `core/storage/memory/background-runs.ts`, `packages/storage-postgres/src/ports/background-runs.ts` + миграция `021-background-runs.ts` |
| Сервис процессов | `core/engine/processes/{service,types,prune}.ts` (`ProcessService`: `spawn`/`stop`/`list`/`get`/`logs`, `SIGTERM` → `SIGKILL` через 5 с, `fs.changed {scope:'all'}`) |
| Реестр фоновых прогонов | `core/engine/background/{service,types,prune}.ts` (`BackgroundRunService` — общий реестр, ADR-111) |
| Тул `execute_shell` | `core/engine/tools/shell.ts` (аргумент `background`, ответ `{process_id, background_run_id, log_path, status}`) |
| Порт исполнения | `core/execution/ports/execution-port.ts` (`ExecutionPort.spawnBackground?`, `isExecutionError` — устойчивая структурная проверка типа), `core/execution/inline-execution-port.ts` (`spawnBackground` через `spawn`, не `execFile`) |
| Исполнитель | `packages/executor/src/background.ts` (`BackgroundExecService`), `packages/executor/src/server.ts` (маршруты `/exec/*`), `packages/executor/src/protocol.ts` (`EXECUTOR_PROTOCOL_VERSION = 3`, `BACKGROUND_STOP_SIGNALS`), `packages/executor/src/client.ts` (`RemoteExecutionPort.spawnBackground` — опрос состояния 500 мс и журнала 300 мс, `POST /exec/:id/stop` с `{signal}`) |
| HTTP-контур | `core/server/routes/processes.ts` (guard `processGuard` на границе; list/detail/logs/stop/delete) |
| UI | `ui/components/panels/ProcessesTab.tsx`, домен API `ui/lib/api/processes.ts` |
| Тесты | `core/engine/processes/service.test.ts`, `packages/executor/src/{background,server-background,client}.test.ts` |

## Открытые вопросы

- **PTY/attach** — интерактивный терминал поверх того же реестра (PROP-064, ADR-044).
- **Выживание процессов при рестарте исполнителя** — реестр исполнителя в памяти; переживание
  требует внешнего состояния (переподключение по pid или иной способ).
- **HA** — несколько исполнителей и распределение фоновых процессов между ними (ADR-087).

## Связи

- [ADR-005](./adr-005-json-storage.md), [ADR-024](./adr-024-eventhub-transport.md),
  [ADR-077](./adr-077-runtime-toolchain.md), [ADR-094](./adr-094-observability-metrics.md),
  [ADR-096](./adr-096-storage-layer.md), [ADR-111](./adr-111-background-subagent-sessions.md),
  [PROP-097](./prop-097-background-processes-registry.md).

## История

- 2026-10-26 — решение принято и реализовано: единый реестр фоновых прогонов с видом `process`,
  `ProcessService` в control plane (лог в `BlobStore`, `SIGTERM` → `SIGKILL`, `process.started|stopped|exited`,
  `fs.changed`), тул `execute_shell({background: true})` с немедленным возвратом управления,
  уведомление родителя с автоходом и хвостом лога, API `/api/v2/processes*` с граничным guard'ом,
  вкладка UI «Процессы»; **remote** — протокол исполнителя v3 (`POST /exec/spawn`, `GET /exec/:id`,
  `GET /exec/:id/logs`, `POST /exec/:id/stop` с `{signal}`), опрос состояния и журнала, старый
  исполнитель → `background_unsupported`.
- 2026-10-27 — зафиксирован контракт detach шелла (ADR-111 §detach): `ExecutionPort` обязан
  отдавать **хэндл процесса** (`pid`/`processId`/потоки/`exited`/`stop`), detach регистрирует
  запись из готового хэндла, поднимает `ProcessLogWriter`, отвязывает `ctx.abortSignal` и
  публикует `process.detached`; порт без хэндла → `DETACH_UNSUPPORTED` (без «тихого» fallback).
  Реализация — следующий шаг.
