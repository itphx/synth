# PROP-097: Фоновые процессы — реестр и контроль через UI

> **Статус:** 🧩 Предложение — `execute_shell` в фоне + реестр процессов + UI-контроль
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-15
> **Парные документы:**
> - [PROP-096](./prop-096-background-subagent-sessions.md) «Фоновые сессии саб-агентов» — родственный механизм (общий реестр/UI);
> - [ADR-025](./adr-025-plan-act-toggle.md)/[ADR-029](./adr-029-granular-permissions.md) — permission-слой для `shell` (сканирование команд, пути);
> - [ADR-036](./adr-036-llm-gateway.md) — обфускация/аудит (что попадает в лог процесса);
> - [ADR-089](./adr-089-external-events-automation.md) — надёжный «Стоп», события и видимость;
> - [ADR-024](./adr-024-eventhub-transport.md) — live-tail логов в UI;
> - [PROP-064](./prop-064-ui-browser-terminal.md) «UI-терминал» — будущий PTY/attach поверх того же реестра;
> - [PROP-077](./prop-077-runtime-toolchain.md) «Executor» — где процессы исполняются в managed.

## Решение

Добавить тулу `execute_shell` режим **`background: true`** и **реестр процессов** с UI-контролем. Повторить модель OpenCode (`shell { background: true }`: возврат сразу, без таймаута, уведомление о завершении, полный вывод сохраняется в управляемом файле) и добавить реестр/наблюдаемость:

- **Запуск.** `execute_shell({ command, background: true })` → процесс стартует, тул возвращает `{ processId, status: 'running', logPath }` немедленно; таймаут — не задан или явный.
- **Реестр.** Каждый процесс — запись в реестре: `id`, `sessionId`/`projectId`, `command`, `cwd`, `pid`, `status` (`running|exited|failed|killed|orphaned`), `startedAt`/`finishedAt`, `exitCode`/`signal`, `logPath`, `tail`.
- **Уведомление.** По завершении — событие + уведомление в сессию (как в PROP-096).
- **UI.** Панель «Процессы»: список (статус, команда, cwd, время), live-лог (tail через EventHub), **stop** (SIGTERM→SIGKILL), открыть лог, очистка завершённых. Здесь же — фоновые саб-агенты (PROP-096) единым реестром.

MVP: `background` у `execute_shell` + реестр + API + панель «Процессы» (список/stop/лог). Долгоживущие процессы, устойчивые к рестарту сервиса, — второй этап.

## Контекст

Сейчас `execute_shell` (`packages/core/src/engine/tools/shell.ts`) **синхронный**: `execFileAsync('sh', ['-c', command], …)` с таймаутом 30 c; длительные процессы (dev-сервер, сборка, обучение) блокируют ход агента и обрываются по таймауту. Реестра процессов, PTY и UI-контроля нет. В OpenCode это решено флагом `background` у `shell` (возврат сразу, уведомление о завершении, полный вывод — в managed-файле), а владение сессиями/процессами — у фонового сервиса (клиент лишь подключается).

## Детали

### Модель и хранилище

- **Реестр** — `ProcessRegistry` (`{dataDir}/processes/registry.json`, атомарная запись ADR-005) + лог-файлы `{dataDir}/processes/<id>.log`.
- **Супервизор** — `ProcessService` в core/executor: `spawn` (не `execFile`) с потоковым захватом stdout/stderr в лог, трекинг `pid`, лимит размера лога (ротация/усечение), `stop`/`signal`, ожидание выхода, событие `process.exited`.
- **Владение** — процессы живут на бэкенде (core/executor), а не в UI: реконнект UI их не убивает; UI только подписывается.
- **Рестарт сервиса** — на старте записи `running` без живого pid → `orphaned` (или попытка attach по pid, если разрешено); это же — место для «фоновых процессов, переживающих рестарт» (этап 2).

### API

- `GET /api/v2/processes` — список (фильтр по сессии/проекту/статусу);
- `GET /api/v2/processes/:id` — детали;
- `GET /api/v2/processes/:id/logs` — tail/стрим (SSE/WS через EventHub);
- `POST /api/v2/processes/:id/stop` — сигнал (по умолчанию SIGTERM, с эскалацией);
- `DELETE /api/v2/processes/:id` — удалить запись/лог (только завершённые).
- RBAC: `requireAuth`; владелец сессии/ADMIN; scope `sessions:*` (managed).

### Безопасность

- **Permission-слой не обходится:** запуск идёт через правило `shell` (сканирование команд, защищённые пути, containment `cwd`, AD-029) — как сейчас; `background` меняет только способ ожидания.
- **Власть хоста.** Как и в OpenCode, shell имеет права пользователя хоста (ФС/процессы/сеть); в managed это усиливает значение ADR-077 (executor) и ADR-082 (flavor-образы).
- **Логи.** Логи процессов — сырой вывод; обфускация секретов (ADR-036) применяется к тому, что отдаётся модели/в UI-выводы; файл лога — `0600`, каталог `0700`; не логировать ключи по возможности.
- **Аудит:** `process.started|stopped|exited|killed` (ADR-036).

### Лимиты

- Макс. процессов на сессию/инстанс, макс. размер лога (ротация), TTL завершённых записей + авто-очистка (`prune`), макс. время жизни (опционально).
- Надёжный «Стоп» сессии (`POST /sessions/:id/abort`) также останавливает/помечает процессы этой сессии.

## Этапы

1. **MVP:** `background` у `execute_shell` + `ProcessService`/реестр + API (list/get/logs/stop) + UI-панель «Процессы». ~2–3 дня.
2. Устойчивость к рестарту (`orphaned`/attach), ротация логов, лимиты/TTL. ~1–2 дня.
3. PTY/attach и интерактивный терминал (поверх PROP-064); группировка с фоновыми детьми (PROP-096). ~2–3 дня.

## Открытые вопросы

1. Где исполнять процессы в **managed** — в thin backend или в executor (PROP-077)? В **гибриде** — локально или на сервере?
2. Политика рестарта: убивать «осиротевшие» процессы или пытаться переприсоединиться?
3. Нужен ли «живой» стрим всего stdout (WS), или достаточно tail + инкремента через EventHub?
4. Единый реестр для процессов и фоновых саб-агентов (рекомендуется) или два раздельных?

## Связи

- [PROP-096](./prop-096-background-subagent-sessions.md), [ADR-025](./adr-025-plan-act-toggle.md), [ADR-029](./adr-029-granular-permissions.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-089](./adr-089-external-events-automation.md), [ADR-024](./adr-024-eventhub-transport.md), [PROP-064](./prop-064-ui-browser-terminal.md), [PROP-077](./prop-077-runtime-toolchain.md), [PROP-082](./prop-082-full-images-deployment.md).
