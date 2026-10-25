# ADR-111: Фоновые прогоны — неблокирующие саб-агенты и реестр

> **Статус:** ✅ Реализовано — решение принято 2026-10-26; фоновые **саб-агенты** в коде, фоновые процессы — PROP-097 (остаток).
> **Дата:** 2026-10-26
> **Связано:** [ADR-026](./adr-026-subagent-context-modes.md) (режимы контекста саб-агента),
> [ADR-033](./adr-033-session-branching-merge.md) (дочерняя сессия как ветка),
> [ADR-077](./adr-077-runtime-toolchain.md) (исполнитель; шаг 7c — остаток),
> [ADR-089](./adr-089-external-events-automation.md) (события сессии, владелец, надёжный «Стоп»),
> [ADR-096](./adr-096-storage-layer.md) (порты слоя хранения),
> [ADR-104](./adr-104-mid-turn-steering.md) (границы хода; steering ребёнка — остаток),
> [ADR-107](./adr-107-plugin-facade-services.md) (образец: порт + сервис + точка сборки),
> [PROP-096](./prop-096-background-subagent-sessions.md) (исходное предложение),
> [PROP-097](./prop-097-background-processes-registry.md) (фоновые процессы — родственный механизм).

## Контекст

Тул `task` был **синхронным**: дочерняя сессия прогонялась внутри родительского хода, и родитель ждал.
Длинная задача саб-агента блокировала основную сессию целиком, а механизма «работа идёт в фоне» не
было вовсе: у фоновой работы не было ни записи состояния, ни реестра, ни способа показать её в UI.
Отдельной проблемой был лимит шагов саб-агента: цикл останавливался, и родитель получал пустой ответ
без объяснения, что именно успело сделать.

## Решение

1. **Единый реестр фоновых прогонов — доменный порт, а не файлы «мимо порта».** Порт
   `BackgroundRunRepository` (ADR-096), запись `BackgroundRunRecord`: `kind: 'subagent' | 'process'`,
   `status: running | completed | failed | cancelled | orphaned`, владелец-сессия, `childSessionId`,
   для процессов — `command`/`cwd`/`pid`/`logPath`, `startedAt`/`finishedAt`/`summary`. Реализации:
   файл `{dataDir}/processes/registry.json` (атомарная запись, ADR-005), в-памяти и PostgreSQL
   (миграция `021-background-runs`); контрактный suite обязателен, как для любого порта. Фоновые
   процессы (PROP-097) живут в **том же** реестре вторым видом — не вторым хранилищем.
2. **`task({background: true})` возвращает управление сразу.** Порядок: регистрация прогона в реестре
   (там же лимиты) → собственный `AbortController` и собственный `streamId` (сигнал отмены родителя
   фонового ребёнка не касается) → блокировка дочерней сессии (`acquireLock` + `currentStream`) →
   detached-прогон → немедленный `tool_result {childSessionId, status:'running', background_run_id}`.
   Блокировка и маркер активности — по образцу `orchestrator.startSubagentResume`, поэтому работает
   надёжный «Стоп»: `POST /sessions/<child>/abort`.
3. **Завершение — событие, запись в историю родителя и автоход.** Терминальный переход
   `running → completed | failed | cancelled` (идемпотентно: повторный `finish` — no-op) публикует в
   канал родителя `child.completed | child.failed | child.cancelled` и кладёт в историю сообщение роли
   USER (автор `Subagent`, `metadata.type = 'background_run_result'`) с компактным блоком
   `<subagent sessionID=… state=…><summary>…</summary></subagent>`; затем родительский ход ставится в
   очередь (автоход). INFO-уведомление (вне LLM-контекста) отклонено осознанно: результат фоновой
   работы обязан попасть в контекст родителя, иначе о нём никто не узнает.
4. **Продолжение ребёнка — один общий хелпер.** `task({task_id})` продолжает ту же дочернюю сессию из
   тула (синхронно, в текущем ходе родителя); HTTP-путь `POST /sessions/:id/resume-subagent`
   (возобновление прерванного ребёнка) использует ту же логику «загрузить → проверить → добавить
   маркер → собрать историю» (`engine/tools/task/resume-target.ts`) — две точки, одна реализация.
5. **Лимиты — свойство сессии, глубина вложенности — 1.** `background.maxSubagentsPerSession` (2),
   `background.maxProcessesPerSession` (5), `background.maxRunsPerSession` (10) считаются по
   родительской сессии; превышение → `background_limit_exceeded` (ошибка тула, ход не падает). Саб-агент
   не может породить фонового саб-агента: `task` у саб-агента — `deny` (как `question`/`plan_*`).
6. **Рестарт не возобновляет фоновые прогоны.** «Живые» хэндлы отмены живут в памяти процесса, поэтому
   при старте `recoverOnStart` переводит все `running`-записи в `orphaned` с пометкой «interrupted by
   restart»: запись остаётся в реестре (честно показывает незавершённость), но прогона уже нет.
   Retention: `background.retentionDays` (7) — чистятся только **терминальные** записи (`prune`).
7. **Лимит шагов саб-агента — принудительный финальный шаг-отчёт.** Исчерпан лимит шагов → ровно один
   дополнительный LLM-вызов «только текст» (инструменты не передаются) с требованием из
   `prompts/system/MAX_STEPS.{ru,en}.md` (`ContextConfig.getMaxStepsPrompt`, override —
   `{dataDir}/user/system/MAX_STEPS.{lang}.md`); ответ модели становится `final_content`, в метаданных —
   `step_limit_reached`; страховка `[steps_limit]` (механика opencode), если модель проигнорировала
   требование и не дала текста.

## Последствия и границы

- Родитель больше не ждёт саб-агента: его ход продолжается, результат приходит отдельным сообщением и
  автоходом. Стоимость — «эффект свободной руки»: родитель может уйти в другую работу, пока ребёнок
  ещё думает, поэтому вставка в очередь обязана быть идемпотентной.
- Фоновый ребёнок **независим**: свой `AbortController` и `streamId`; отмена родителя его не трогает,
  отмена ребёнка — `POST /sessions/<child>/abort`.
- **Фоновые процессы в `remote`-режиме недоступны** (`background_unsupported`): порт исполнения не
  умеет фоновый запуск — это остаток ADR-077 (шаг 7c). Для фоновых саб-агентов ограничение не
  действует: они идут через LLM-путь, а не через порт команд.
- **Steering фонового ребёнка — остаток ADR-104**: `steerInbox` адресован конкретной сессии, а цикл
  фонового ребёнка идёт мимо оркестратора, поэтому инъекция в фоновую сессию её не разблокирует.
- Рестарт не возобновляет фоновые прогоны (п. 6) — после рестарта родитель узнаёт об этом из записи
  реестра, а не из работающего ребёнка.

## Статус в коде

| Что | Где |
|---|---|
| Контракт записи | `shared/types/background.ts` (`BackgroundRunRecord`/`BackgroundRunFilter`/`BACKGROUND_RUN_TERMINAL_STATUSES`) |
| Порт и реализации | `storage/ports/background-run-repository.ts`; `storage/file-background-run-store.ts` (`{dataDir}/processes/registry.json`), `storage/memory/background-runs.ts`, `packages/storage-postgres/src/ports/background-runs.ts` + миграция `021-background-runs.ts` |
| Сервис реестра | `engine/background/service.ts` (`BackgroundRunService`: `startSubagent`/`startProcess`/`finish`/`stop`/`recoverOnStart`/`prune`, `buildSubagentNotification`), `engine/background/types.ts`, `engine/background/prune.ts` |
| Тул `task` | `engine/tools/task/tool.ts` (`startBackgroundSubagent` — порядок п. 2), `engine/tools/task/args.ts` (аргумент `background`), `engine/tools/task/resume-target.ts` (п. 4), `engine/tools/task/run-cycle.ts` (лимит шагов, п. 7), `engine/tools/task-resume.ts` |
| Промпт лимита шагов | `prompts/system/MAX_STEPS.{ru,en}.md`; загрузчик — `ContextConfig.getMaxStepsPrompt` |
| События и история | `child.completed/failed/cancelled` в канал родителя; уведомление — `buildSubagentNotification` (`metadata.type = 'background_run_result'`) |
| Точки сборки | `server/app/deps.ts`, `backend/app/deps.ts` (`backgroundService`, `onNotifyParent` — запись в историю + постановка в очередь, `backgroundEnabled`) |
| Конфиг | `shared/config/{types,defaults}.ts` — секция `background` (`enabled`, `maxSubagentsPerSession`, `maxProcessesPerSession`, `maxRunsPerSession`, `logMaxBytes`, `retentionDays`) |
| Тесты | `engine/background/service.test.ts`, `engine/tools/task/tool.test.ts`, `events/child-session.test.ts` |

## Открытые вопросы

- Приоритеты и пул воркеров при N фоновых детях: сейчас фоновые прогоны идут плоско, ограничение —
  лимит сессии; очередь и приоритеты не введены.
- Гибрид (ADR-042): ребёнок локально, родитель на сервере — где живёт реестр и как доставляется
  уведомление, не решено.

## Связи

- [ADR-026](./adr-026-subagent-context-modes.md), [ADR-033](./adr-033-session-branching-merge.md),
  [ADR-077](./adr-077-runtime-toolchain.md), [ADR-089](./adr-089-external-events-automation.md),
  [ADR-096](./adr-096-storage-layer.md), [ADR-104](./adr-104-mid-turn-steering.md),
  [ADR-107](./adr-107-plugin-facade-services.md),
  [PROP-096](./prop-096-background-subagent-sessions.md),
  [PROP-097](./prop-097-background-processes-registry.md).

## История

- 2026-10-26 — решение принято и реализовано: фоновые саб-агенты (`task({background: true})`), единый
  реестр фоновых прогонов (порт `BackgroundRunRepository`), уведомление родителя с автоходом,
  продолжение ребёнка из тула, лимиты сессии и глубина 1, `orphaned` при рестарте, принудительный
  финальный шаг-отчёт по лимиту шагов. Остаток — фоновые процессы в `remote`-режиме (PROP-097,
  ADR-077 шаг 7c) и steering фонового ребёнка (ADR-104).
