# ADR-145: Фоновая работа — таймаут, вывод и контракт detach

> **Статус:** ✅ Реализовано — 2026-11-18.
> **Дата:** 2026-11-18
> **Связано:** [ADR-111](./adr-111-background-subagent-sessions.md) (§detach — перевод идущего прогона в фон),
> [ADR-113](./adr-113-background-processes.md) (фоновые процессы, реестр, логи),
> [ADR-143](./adr-143-tool-timeouts.md) (таймауты инструментов — секунды и предел по режиму),
> [ADR-135](./adr-135-execution-contour.md) (контур исполнения, исполнитель),
> [ADR-077](./legacy/adr-077-runtime-toolchain.md) (wire-протокол исполнителя),
> [ADR-070](./adr-070-system-prompt-composer.md) (блоки системного промпта),
> [ADR-023](./adr-023-configuration.md) (приоритет конфигурации).

## Контекст

Detach (ADR-111 §detach) переводил идущий блокирующий прогон в фон, но три вещи
делали его непригодным для долгих команд:

1. **Таймаут не переставлялся.** Процесс запускался с foreground-лимитом хода
   (1…600 с) и после перевода в фон продолжал жить под ним: `npm run dev` умирал
   через две минуты, уже будучи фоновым прогоном. Фоновый режим (сутки) к нему не
   применялся, потому что таймер был заведён при `spawnBackground`.
2. **Вывод до перевода был невидим.** Тул копил вывод в собственных буферах и
   отдавал его только в результате; у переведённого прогона журнал начинался с
   момента `adopt`, а пользователь до перевода не мог посмотреть, что команда
   печатает.
3. **Блокирующие прогоны не были видны.** Запись в реестре появлялась только
   после перевода, поэтому вкладка «Процессы» и API не показывали работу,
   которая идёт внутри хода; при steer пользователь был заблокирован до конца
   команды/саб-агента.

Отдельно: у фонового запуска и detach были **разные** тексты результата, а
правило поведения («не поллить, уведомление придёт само») нигде не было
сформулировано модели.

## Решение

1. **`retime` в контракте хэндла и протокол исполнителя 10.** У
   `ExecBackgroundProcess` появляется необязательный `retime?(timeoutMs)`: `0` —
   снять таймаут, `> 0` — новый срок с отсчётом **от вызова**, после завершения
   процесса — no-op. Отсутствие метода означает «переставлять нельзя» — это
   сигнал вызывающему отказаться от перевода, а не молча оставить прежний срок.
   Исполнитель получает `POST /exec/:id/timeout { timeoutMs }` (`0…86 400 000`;
   `404` — процесса нет/завершён, `400` — невалидное тело) и признак
   `features.backgroundRetime`; версия протокола повышается **9 → 10**, потому
   что это новый маршрут. Деградация: исполнитель протокола < 10 не выбирается
   для detach, перевод отклоняется (`DETACH_FAILED`).
2. **Порядок detach: снять таймаут, затем `adopt`.** `execute_shell` вызывает
   `retime(0)` **до** `ProcessService.adopt`; при отказе `adopt` (лимит фоновых
   прогонов) исходный срок восстанавливается, и прогон продолжается в
   foreground. Лимит фонового режима (сутки) при этом действует как обычно —
   `retime(0)` не делает процесс безлимитным навсегда.
3. **Живой лог с первой секунды.** `ProcessService.openLiveLog({sessionId,
   processId})` отдаёт писатель в `processes/live/<processId>.log` (капли по
   `background.logMaxBytes`): без записи в реестр, без событий, без лимитов.
   Foreground-вызов делает tee в этот лог с t=0; `adopt` принимает живой лог,
   `record.logPath` указывает на **тот же** файл (префикс не копируется);
   обычное завершение и «Стоп» вызывают `finish({keep:false})` — файл
   удаляется, detach — `finish({keep:true})`. Прунер получает **отдельное
   правило** для `processes/live/…`: сирота удаляется только если на неё не
   ссылается ни одна запись реестра **и** файл старше 1 ч — иначе сносило бы лог
   идущей команды. У detach-прогонов нет потоковых файлов: только общий лог.
4. **Блокирующие прогоны — в API и в UI.** `ActiveRunRegistry` (`active-runs`)
   хранит хэндлы с `sessionId`/`processId`/`childSessionId`/`logPath`/`startedAt`/
   `stop?` и умеет `listForSessions`/`find`. `GET /api/v2/processes?include=blocking`
   добавляет массив `blocking` к `{runs}` (без `include` ответ прежний, иное
   значение → 400); `POST /api/v2/processes/blocking/:id/stop` и
   `GET /api/v2/processes/blocking/:id/logs` работают по живому прогону, доступ —
   на границе (`read`/`write` по сессии-владельцу). UI: секции «Блокирующие
   саб-агенты»/«Блокирующие процессы», live-лог-вкладка, кнопка «В фон» в шапке
   running-карточки `execute_shell`.
5. **Авто-detach при вмешательстве пользователя.** `POST /api/v2/sessions/:id/prompt`
   при активном ходе переводит блокирующие прогоны в фон
   (`autoDetachOnSteer`, `engine/background/auto-detach.ts`): `steer`/`interrupt` —
   **до** обработки (включая `interrupt` без текста); текст не требуется
   (`@user`-only тоже вмешательство). `mode=queue` прогоны **не** переводит —
   сообщение просто ждёт завершения хода (`QUEUE_FULL` и `@user`-only в `queue`
   — не трогают). Уважается живое
   значение `background.enabled`; ошибки не ломают приём сообщения (причина — в
   лог); событие `background.auto_detached {session_id, detached[], failed?}`
   публикуется только при непустом итоге — пустой снимок UI не будит.
   Причина перевода (`ActiveRunDetachReason`: `'user'` — ручной перевод, по
   умолчанию; `'message'` — авто-detach) передаётся сквозь
   `detachAll → handle.detach(reason)` и выбирает текст результата. Порядок для
   `interrupt`: detach → `steerInbox` → прерывание генерации.
6. **Один блок промпта вместо текстов в результатах.** Появляется
   `prompts/system/BACKGROUND.{ru,en}.md` (блок `[ФОНОВАЯ РАБОТА]`, tier
   `context`, order 26), включается только при включённой фоновой работе и
   непустом файле; override — `{dataDir}/user/system/BACKGROUND*.md` через порт
   `ContextFileRepository`. В результатах — шесть ключей по причине:
   `background.started.process` (`{id}`, `{log}`) и `background.started.subagent`
   (`{id}`) для агентского запуска (`background: true`),
   `background.detached.process` (`{id}`, `{log}`) и `background.detached.subagent`
   (`{id}`) для **ручного** перевода (кнопка «В фон», `ctrl+b`,
   `POST /sessions/:id/background`),
   `background.detached.process_message` (`{id}`, `{log}`) и
   `background.detached.subagent_message` (`{id}`) для авто-detach из-за нового
   сообщения пользователя — текст перевода объясняет причину, причины получают
   собственные ключи.
7. **Настройки `background` — runtime.** `GET/PUT/DELETE /api/v2/settings/background`
   (`enabled`, `maxSubagentsPerSession`, `maxProcessesPerSession`,
   `maxRunsPerSession`, `logMaxBytes`, `retentionDays`): приоритет по каждому полю
   env > runtime > config > default, `409 ENV_LOCKED` с `fields[]` (ни одно поле
   запроса не применяется), `400 VALIDATION_ERROR`, `restartRequired:false`,
   аудит `scope:'background'`. Живое применение: лимиты реестра, `logMaxBytes`,
   retention прунеров, `background.enabled` в контексте каждого вызова тула.
   Хранилище — существующий JSON-документ настроек (`settings.json`/PG), без
   миграции.

## Альтернативы

- **Необязательный `timeout` в фоновом запуске вместо `retime`.** Не решает
  задачу: foreground-таймер уже заведён, и его нужно именно снять; значение по
  умолчанию не отличает «пользователь задал» от «перевели в фон».
- **Поднять foreground-потолок до суток.** Размывает границу режимов
  (ADR-143) и не лечит блокировку хода: команда всё равно держит ход.
- **Копировать префикс вывода при `adopt`** (как было до живого лога). Даёт
  лог «с середины» и двойную память; живой файл проще и честнее.
- **Публиковать `process.started` на блокирующий прогон.** Смешало бы реестр и
  «живые» хэндлы: до перевода записи в реестре нет, и создавать её ради UI
  значило бы заводить фоновую работу, которой ещё нет.
- **Авто-detach без гейта `background.enabled`.** Создавал бы ровно ту фоновую
  работу, которую инстанс запретил.

## Последствия и риски

- **Старый исполнитель — detach недоступен.** Протокол < 10 не умеет
  `/exec/:id/timeout`: перевод отклоняется (`DETACH_FAILED`), прогон остаётся
  блокирующим. Это осознанный fail-closed: «тихо» перевести процесс значило бы
  убить его по чужому foreground-лимиту. Control plane и пул обновляются вместе.
- **Логи foreground-команд теперь пишутся на диск** (до удаления) — цена
  видимости с первой секунды; объём ограничен `logMaxBytes`, срок — временем
  команды, сироты убирает прунер по 1 ч.
- **Авто-detach меняет UX:** steer больше не ждёт завершения команды/саб-агента,
  а работа продолжается в фоне. Пользователь видит тост и вкладку «Процессы»;
  кто ждал «дождаться и потом вмешаться», должен остановить прогон явно.
- **Живые хэндлы — в памяти процесса** (как и detach, ADR-111): multi-replica
  маршрутизация остаётся открытым вопросом (PROP-105).
- **Retention удаляет и записи, и логи** (включая живой лог detach-прогона);
  правило сирот живого лога — отдельное, иначе прунер сносил бы лог идущей
  команды.

## Статус в коде

| Что | Где |
|---|---|
| `retime` в контракте | `packages/core/src/execution/ports/execution-port.ts` (`ExecBackgroundProcess.retime?`), `inline-execution-port.ts` (inline — всегда), `packages/executor/src/client.ts` (хэндл с `retime` только при `features.backgroundRetime`) |
| Протокол 10 | `packages/executor/src/protocol.ts` (`EXECUTOR_PROTOCOL_VERSION = 10`, `features.backgroundRetime`), `server.ts` (`POST /exec/:processId/timeout`), `background.ts` (`retime`) |
| Порядок detach | `packages/core/src/engine/tools/shell-detachable.ts` (`retime(0)` → `adopt`, восстановление срока при отказе) |
| Живой лог | `packages/core/src/engine/processes/{service,types,prune}.ts` (`openLiveLog`, `readLogAtPath`, `LIVE_LOG_DIR`/`LIVE_LOG_ORPHAN_TTL_MS`) |
| Блокирующие прогоны | `packages/core/src/engine/background/active-runs.ts`, `packages/core/src/server/routes/processes.ts` (`include=blocking`, `/blocking/:id/{logs,stop}`) |
| Авто-detach | `packages/core/src/engine/background/auto-detach.ts`, `packages/core/src/server/routes/sessions.ts` |
| Промпт и тексты | `packages/core/prompts/system/BACKGROUND.{ru,en}.md`, `engine/context/{builder,config}.ts`, `engine/system-messages.ts` |
| Runtime-настройки | `packages/core/src/server/routes/settings-background.ts`, `storage/runtime-settings.ts` (`resolveBackgroundConfig`), `settings.json`/PG |
| Спецификации | [docs/API_V2.md](../API_V2.md) §3.2/§5.21/§5.39, [docs/CONFIGURATION.md](../CONFIGURATION.md) §«Фоновые прогоны», [docs/EXECUTION.md](../EXECUTION.md) §4.2/§4.2.4, [docs/TOOLS.md](../TOOLS.md) |

## История

- 2026-11-18 — решение реализовано: `retime` + протокол исполнителя 10, живой
  лог `processes/live`, блокирующие прогоны в API/UI, авто-detach при steer,
  блок `BACKGROUND` и единые тексты, runtime-настройки `background`.
- 2026-11-18 (уточнение) — авто-detach привязан к **вмешательству** (`steer`/
  `interrupt`, включая прерывание без текста): `queue` прогоны не переводит
  (сообщение ждёт хода). Причина перевода сквозная (`ActiveRunDetachReason`:
  `user`/`message`), тексты результатов разделены: шесть ключей
  (`background.started.*` для агентского запуска, `background.detached.*` для
  ручного перевода, `background.detached.*_message` для авто-detach из-за нового
  сообщения пользователя).
