# @itphx/synth-executor

> Точечные правила пакета. Общие инварианты, команды и стиль — в корневом
> [AGENTS.md](../../AGENTS.md); порт исполнения и топология — ADR-077
> ([ADR-077](../../docs/arch_decisions/adr-077-runtime-toolchain.md)); образец
> упаковки — слой хранения (ADR-096/ADR-097).

## Роль и границы

In-tree **исполнитель** (worker) Synth: отдельный процесс, в котором
выполняются агентские команды. Пара — «тонкий control plane + отдельный
исполнитель» (ADR-077): control plane (core) готовит команду, исполнитель её
выполняет и возвращает результат.

- Транспорт — **HTTP/1.1 + JSON**, сервер на Hono (как весь Synth).
- Пакет даёт две вещи: **сервер исполнителя** (`createExecutorApp`/
  `startExecutorServer`) и **клиент удалённого порта**
  (`createRemoteExecutionPort`, отдельный экспорт
  `@itphx/synth-executor/client`).
- Исполнитель **не знает** ни про сессии, ни про хранилище Synth: его мир —
  корень workspace, токен доступа и набор бинарников (toolchain).
- Подключение пакета к core сделано (шаг 7b): динамический `import()` по
  `execution.mode` в core (`packages/core/src/execution/remote.ts`), fail-closed на старте
  (`packages/core/src/execution/startup.ts`), композиция в `server/app/deps.ts` и
  `packages/backend/src/app/deps.ts`.

## Упаковка и зависимости

- `@itphx/synth-shared` — обычная зависимость (типы/утилиты общего контракта).
- `@itphx/synth-core` — **`peerDependencies` + `devDependencies`**. Типы порта
  (`ExecutionPort`, `ExecRequest`, `ExecResult`, `ExecCommand`) — только
  `import type`; **точечный рантайм-импорт** — `InlineExecutionPort`
  (семантика исполнения в воркере обязана совпадать с control plane),
  `ExecutionError` (реконструкция ошибок на стороне клиента) и `egressFetch`
  (ADR-099: единый транспорт и доверие TLS/CA). Статической зависимости core
  от пакета нет — цикл core ↔ исполнитель намеренный (как core ↔ драйвер
  хранилища) и разрешён `ignoreWorkspaceCycles: true` в
  `pnpm-workspace.yaml`.
- `hono` — HTTP-фреймворк сервера (та же версия, что в core).
- Собственных HTTP-агентов/диспетчеров пакет **не создаёт** (инвариант 22):
  исходящие запросы клиента — только через `egressFetch` из core.

## Wire-протокол (версия 3)

| Метод | Путь | Назначение | Авторизация |
|---|---|---|---|
| `POST` | `/exec` | выполнить команду | bearer-токен |
| `POST` | `/exec/spawn` | запустить фоновый процесс | bearer-токен |
| `GET` | `/exec/:processId` | состояние фонового процесса | bearer-токен |
| `GET` | `/exec/:processId/logs` | отрезок журнала фонового процесса | bearer-токен |
| `POST` | `/exec/:processId/stop` | остановить фоновой процесс | bearer-токен |
| `GET` | `/capabilities` | версия протокола и состав toolchain'а (базовый словарь core + допсведения) | bearer-токен |
| `GET` | `/mcp/servers` | состояние MCP-серверов исполнителя (`idle`/`up`/`down` + причина) | bearer-токен |
| `GET` | `/mcp/tools` | инструменты поднятых MCP-серверов (ленивый старт) | bearer-токен |
| `POST` | `/mcp/call` | вызов инструмента MCP-сервера | bearer-токен |
| `GET` | `/health` | liveness исполнителя | без токена |

- Запрос: `{ command: ExecCommand, cwd?, env?, timeoutMs?, maxOutputBytes? }`.
  `command` — тот же union `shell`/`argv`, что у порта core: форма команды на
  проводе не переопределяется (паритет remote/inline).
- Успех — `200 { stdout, stderr, exitCode, truncated, durationMs }` (успешный
  вызов — всегда `exitCode: 0`; неуспешный код приходит **ошибкой**, как и в
  inline-режиме).
- Ошибка — тело `{ error: { reason, code, message, stdout, stderr, killed,
  signal, truncated, durationMs } }` — зеркало `ExecutionError` из core.
- Коды ответа — по классу ошибки: `400` — некорректный запрос или `cwd` вне
  workspace; `401` — нет/неверный токен; `404` — неизвестный MCP-сервер,
  инструмент или фоновый процесс; `429` — превышен лимит одновременных команд
  или живых фоновых процессов; `500` — прочие ошибки исполнения (включая
  ненулевой код выхода).
- `reason` на проводе: либо причина порта (`timeout` | `aborted` |
  `spawn_failed` | `nonzero_exit` | `max_output`), либо протокольная
  (`invalid_request` | `cwd_outside_workspace` | `unauthorized` | `not_found` |
  `too_many_requests` | `internal_error`). Клиент переносит причину порта как
  есть, протокольную — в `reason: 'spawn_failed'` с различающим `code`
  (`EWORKSPACE`/`EAUTH`/`ELIMIT`/`EINVAL`).
- `GET /capabilities` — **аддитивно** отдаёт `features: { background: true }`
  (признак фоновых процессов); старое поле `protocol` не меняет смысла.

**Версия протокола — контракт совместимости.** `EXECUTOR_PROTOCOL_VERSION = 3`
(в 2 не было `/exec/spawn` и фоновых маршрутов, в 1 — `/mcp/*`): control plane
и пул исполнителей обновляются **вместе** (то же правило, что для инвентаря
пула, шаг A). Старый исполнитель фоновых маршрутов не знает, новый control
plane получил бы `404`.

### Фоновые процессы (ADR-077, шаг 7c; PROP-097)

Фоновый процесс **переживает ход агента**; в split-топологии он живёт **на
исполнителе** (там, где есть toolchain и рабочий каталог). Клиентская
проводка в control plane — блок 9b (ADR-077).

- `POST /exec/spawn` — тело `{ command, cwd?, env?, timeoutMs?, requires? }` →
  `201 { processId, pid }`; `400` — невалидное тело или `cwd` вне workspace,
  `429` — превышен лимит живых фоновых процессов.
- `GET /exec/:processId` → `200 { processId, status, exitCode, signal, pid?,
  command, cwd, startedAt, finishedAt?, durationMs?, stdoutBytes, stderrBytes,
  truncated }`; `404` — процесс не найден.
- `GET /exec/:processId/logs` → `200 { processId, status, exitCode, signal,
  stdout: { content, offset, nextOffset }, stderr: { … }, totalBytes,
  truncated }`; query `stdoutOffset`/`stderrOffset`/`limit` (отрезок ≤ 256 КиБ,
  по умолчанию 64 КиБ); `404` — процесс не найден.
- `POST /exec/:processId/stop` → `200 { status: 'stopping' }` (сигнал по
  умолчанию `SIGTERM`, через 5 с — `SIGKILL`; идемпотентно); `404` — процесс
  не найден.
- Идентификатор процесса — `proc_<uuid>` (тот же формат, что у порта core).

**Сервис** — `BackgroundExecService` (`src/background.ts`): реестр **в памяти**
процесса исполнителя (у исполнителя нет доступа к каталогу данных инстанса),
журналы — на диске.

- Запуск — `child_process.spawn` (не `execFile`): процесс живёт после ответа
  HTTP; `cwd` проходит **тот же** containment, что у `ExecService`
  (`resolveContainedCwd`, логика не дублируется).
- Журналы — **раздельные** по потокам: `<logDir>/<processId>.out.log` и
  `.err.log` (каталог `0700`, файлы `0600`); лимит `maxLogBytes` — **на
  поток**: при его достижении запись прекращается, выставляется `truncated`,
  но **процесс не убивается**.
- Лимит `maxProcesses` — на число **живых** процессов; превышение →
  `too_many_requests` (429).
- `timeoutMs > 0` — `SIGTERM`, через 5 с — `SIGKILL` (те же пауза и сигналы,
  что у inline-порта в core); `stop()` идемпотентно.
- Терминальные статусы: `exited` (код 0), `failed` (код ≠ 0), `killed`
  (сигнал); неудача запуска — `failed` с отрицательным кодом libuv (`-2` =
  ENOENT), как и в портовом контракте.
- `requires` принимается, но **не проверяется** (проверка бинарных
  требований — на слое тула).
- `prune()` — удаляет терминальные записи старше часа вместе с журналами
  (вызывается при запуске и раз в 10 мин, `unref`-таймер); `dispose()` —
  останавливает живые процессы (`SIGTERM` → `SIGKILL`) и снимает таймер
  (вызывается при остановке исполнителя: зомби-процессов не остаётся).
- Клиентская проводка в control plane — **блок 9b (ADR-077)** — реализована:
  клиент удалённого порта (`src/client.ts`) умеет `spawnBackground` (опрос
  состояния и журнала процесса).

**Порядок маршрутов критичен:** `/exec/spawn` объявлен **до**
`/exec/:processId` (иначе «spawn» попал бы в параметр). Guard авторизации —
`app.use('/exec', …)` **и** `app.use('/exec/*', …)`: первый покрывает только
сам `/exec`, подпути (`/exec/spawn`, `/exec/:id/logs`) — второй.

### Фоновые процессы в клиенте удалённого порта (ADR-077, шаг 7c)

`RemoteExecutionPort.spawnBackground()` — **тот же контракт**, что у
`InlineExecutionPort.spawnBackground` (core): `processId`/`pid`, поток вывода
`output`, промис `exited`, `stop()`.

- **Выбор адреса — тем же механизмом, что у `execute`:** по `requires`
  (адрес без нужного бинаря и не ответивший адрес исключаются; нет
  подходящего → `dependency_missing`/`EDEPENDENCY`; пул целиком недоступен →
  `spawn_failed`/`EUNREACHABLE`). Дополнительно адрес должен уметь фоновые
  процессы (`features.background` / протокол v3): старый исполнитель в
  кандидаты не попадает, а отказ — `EBACKGROUND`
  (`EXECUTION_BACKGROUND_UNSUPPORTED_CODE` в core → `background_unsupported`).
- **Стриминга на проводе нет** — журнал приходит отрезками, поэтому клиент
  **опросает** исполнителя: журнал `GET /exec/:id/logs` каждые
  `REMOTE_BACKGROUND_LOG_POLL_MS` (300 мс, со смещениями `stdoutOffset`/
  `stderrOffset`), состояние `GET /exec/:id` каждые
  `REMOTE_BACKGROUND_STATUS_POLL_MS` (500 мс) до терминального статуса.
- **Порядок вывода:** за тик — сначала stdout, затем stderr; поток завершается,
  когда статус терминальный **и** оба смещения дочитаны до конца.
- **`exited`** резолвится `{ exitCode, signal, durationMs }`; сеть/404 →
  `exitCode: -1` и `signal: null` (хэндл не должен висеть).
- **`stop(signal='SIGTERM')`** — `POST /exec/:id/stop`, best-effort (без
  исключений, повторный вызов — no-op); опрос состояния при этом просыпается
  сразу.
- **Слот одновременных вызовов не занимается:** фоновой процесс переживает
  запрос — держать слот до его конца значило бы заблокировать пул.
- **Ограничения:** журнал **дублируется** — он лежит на исполнителе (до
  `prune()`, час) и одновременно пишется в control plane через `BlobStore`
  (реестр фоновых прогонов, ADR-111/PROP-097). Вывод в control plane
  попадает с задержкой опроса (300 мс), а не сразу. Пользовательский сигнал
  доезжает до исполнителя, но конкретный сигнал (`SIGKILL` вместо `SIGTERM`)
  серверная часть сейчас использует свой дефолт.

## Клиент удалённого порта

`createRemoteExecutionPort(opts): ExecutionPort` — реализация **того же**
интерфейса, что `InlineExecutionPort`; домен не различает физических
исполнителей.

- `opts`: `{ urls, token, timeoutMs?, concurrency?, failMode?, fetchImpl? }`.
- Адреса перебираются **по кругу**; при **ошибке соединения** — следующий
  адрес. Ответ исполнителя (в т.ч. ошибка исполнения) поводом для failover
  **не** является: команда уже выполнена, повтор изменит её семантику.
- `failMode`: `fail` (по умолчанию) — `ExecutionError` (`EUNREACHABLE`);
  `inline-fallback` — делегирование в `InlineExecutionPort` (явная настройка
  оператора, не дефолт: тихий возврат к исполнению в процессе означал бы, что
  удалённый режим на деле не работает). Оговорка: в fallback команда
  выполняется **в процессе control plane** — `cwd` трактуется как локальный
  путь, а containment исполнителя не действует.
- `concurrency` — лимит одновременных вызовов, остальные ждут в очереди.
- `req.signal` («Стоп») → разрыв запроса; на стороне исполнителя процесс
  команды убивается (SIGTERM). Клиент бросает `ExecutionError` с причиной
  `aborted` — как и в inline-режиме.
- Таймаут HTTP-запроса — `opts.timeoutMs` (по умолчанию 30 c); если команда
  просит больший таймаут, клиентский таймаут расширяется на запас
  (`REMOTE_TIMEOUT_GRACE_MS`), иначе клиент обрывал бы команду раньше сервера.

### Инвентарь пула и маршрутизация по возможностям (ADR-077 шаг A)

Состав пула известен только из `GET /capabilities` — клиент собирает
**карту «адрес → множество программ»** по всем адресам и решает по ней две
задачи.

- **Инвентарь:** `RemoteExecutionPort._ensureInventory()` — ленивое обновление
  по TTL `REMOTE_CAPABILITIES_TTL_MS = 120_000` (обновляется перед пробой/
  маршрутизацией, если снимок просрочен); запрос к адресу —
  `REMOTE_CAPABILITIES_TIMEOUT_MS = 5_000`. Не ответивший адрес помечается
  `reachable: false` — его состав **неизвестен**.
- **`probe(bin)`** (необязательный метод порта): программа доступна, если она
  есть хотя бы у одного **ответившего** адреса. Если не ответил **никто** —
  состав пула неизвестен ⇒ **fail-open** (тул не блокируется, ADR-078): команда
  падает с `EUNREACHABLE`, ошибка видна модели.
- **`capabilitySummary(bin)`** — сводка для объяснения модели: `available`,
  `missing` (сколько ответивших адресов без программы), `total`,
  `unreachable` (сколько не ответили) ⇒ деталь «в пуле: N из M».
- **Маршрутизация по `ExecRequest.requires`:** команда уходит в адрес, чей
  инвентарь покрывает **все** требуемые бинари. Адрес **без** нужного бинаря и
  адрес, **не ответивший** на `/capabilities`, в маршрутизации **не участвуют**
  (fail-closed: неизвестный состав нельзя считать подходящим). Подходящего
  адреса нет ⇒ `ExecutionError` с причиной `dependency_missing`, кодом
  `EDEPENDENCY` и текстом «в пуле: N из M». Команда без `requires` идёт по
  обычному round-robin (поведение прежнее).
- **Требования задаёт core:** `ExecRequest.requires` — строки из
  `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`); источник — карта
  `TOOL_RUNTIME_DEP` (`toolRuntimeRequires()`). Клиент своего словаря не
  заводит.

### MCP-хостинг (ADR-077, шаг B1)

Исполнитель **поднимает MCP-серверы у себя** (stdio, `@modelcontextprotocol/sdk`
+ `StdioClientTransport` — тот же клиент, что в core) и отдаёт их инструменты и
вызовы по HTTP. Зачем: в split-топологии control plane тонкий (в образе
`synth-backend` нет Chromium и tier-4 серверов), а браузерные/SCM-инструменты
живут в toolchain'е исполнителя.

- **Конфигурация — env** `SYNTH_EXECUTOR_MCP_SERVERS`: JSON-массив
  `[{"name","command","args","env"}]`. Разбор **строгий** (невалидный JSON или
  запись → ошибка старта, fail-closed). **Пустая строка — «серверов нет»**, а не
  ошибка: так отключается дефолт образа. `env` сервера может содержать токены —
  они не логируются и не отдаются в ответах (только `name`/`status`/`toolCount`/
  `error`), вычищаются из текстов ошибок (`redactSecrets` по значениям `env`), а
  сама переменная удаляется из `process.env` после разбора
  (`scrubExecutorMcpServers`).
- **Лимиты — как в core:** connect 60 c, вызов инструмента 120 c, усечение
  результата 30 000 символов, circuit breaker 5 ошибок → cooldown 60 c.
- **Жизненный цикл — ленивый:** сервер поднимается при первом обращении
  (`/mcp/tools` — все, `/mcp/call` — нужный); до этого `status: "idle"`.
  Статусы: `idle` (не поднимался) / `up` (работает) / `down` (не поднялся —
  причина в `error`; в т.ч. после неудачного спавна). Упавший сервер
  **переподнимается** следующим обращением (circuit breaker прикрывает частые
  попытки). `close()` исполнителя закрывает MCP-серверы — дочерние процессы
  (включая Chromium) не остаются.
- **Playwright MCP — фактические условия (проверено в контейнере):**
  - `playwright-mcp` по умолчанию ищет **Google Chrome**
    (`/opt/google/chrome/chrome`), которого в образе нет ⇒ обязателен
    `--executable-path`.
  - Флага `--browser chromium` **не существует** (`--browser` =
    `chrome|firefox|webkit|msedge`).
  - Рабочие аргументы: `--headless --no-sandbox --executable-path
    /opt/synth/browser/chrome`. `--no-sandbox` нужен, потому что контейнер по
    умолчанию под root (uid 0); `--headless` — дисплея нет.
  - `/opt/synth/browser/chrome` — **стабильный симлинк** на фактический
    `chromium-<ревизия>/chrome-linux64/chrome` (создаёт
    `docker/install-tier-3.sh` резолвом по glob; версия ревизии меняется вместе
    с пином Playwright, хардкодить нельзя). Там же `headless-shell` при наличии.
  - Дефолт `ENV SYNTH_EXECUTOR_MCP_SERVERS` задан **только** во flavor'ах с
    браузером (`browser`/`full`, `docker/Dockerfile.executor`); в
    `core`/`dev`/`devops` его нет.
  - Версия браузера в образе — Google Chrome for Testing 155.x (ревизия
    `chromium-1247`), путь `chrome-linux64` (не `chrome-linux`).
- **Зависимости пакета:** `@modelcontextprotocol/sdk` и `zod` — **те же версии,
  что в core** (`^1.32.1` / `^3.24.0`): иначе handshake и разбор результатов
  разойдутся. Своего MCP-клиента пакет не пишет.

### Состав toolchain'а исполнителя

- **Базовый словарь — из core:** `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`)
  подтягивается точечным динамическим `import()` (`@itphx/synth-core`) — это
  источник истины для обеих сторон; исполнитель обязан отдавать тот же
  словарь, иначе control plane сочтёт, например, `execute_shell` недоступным.
- **Дополнительные сведения отдельно:** `EXTRA_TOOLCHAIN_BINARIES = ['python3']`
  — сообщается «для сведения», на доступность встроенных тулов не влияет.
  Итоговый список — `resolveToolchainBinaries()`.
- **Проба различает отсутствие и «не поддержал `--version`»:** `ENOENT` ⇒
  программы нет (в отчёт не попадает); прочая ошибка (ненулевой код выхода,
  таймаут) ⇒ программа **есть** (в отчёт попадает как `present`).
- **Конфигурация:** состав определяется на старте; в тестах/особых сборках
  передаётся явно — `toolchain` в опциях сервера (`startExecutorServer({ toolchain })`),
  иначе определяется пробой. Состав отдаётся в `GET /capabilities`
  (`{ protocol, toolchain, os, arch, node }`).

## Исполнитель: правила и границы

- **Containment `cwd`** — `cwd` обязан лежать внутри корня workspace
  исполнителя; проверка **fail-closed** и **symlink-aware** (по образцу
  `resolveRepoCwd`/`isInsideReal` из `packages/core/src/engine/tools/git.ts`):
  абсолютный путь вне корня, выход через `..` и симлинк наружу → отказ
  (`400`, `cwd_outside_workspace`).
- **Лимиты исполнителя — final**: потолок таймаута (`SYNTH_EXECUTOR_MAX_TIMEOUT_MS`),
  потолок буфера вывода (`SYNTH_EXECUTOR_MAX_OUTPUT_BYTES`), лимит одновременных
  команд (`SYNTH_EXECUTOR_MAX_CONCURRENCY`). Запрос клиента может быть
  **меньше**, но не больше.
- **Семантика исполнения** — команды выполняет `InlineExecutionPort` из core:
  тот же бинарь, тот же `sh -c`, те же поля ошибки. Свою реализацию `execFile`
  в пакете не пишем — иначе remote и inline разойдутся по текстам, которые
  видит модель.
- **Токен не утекает**: bearer-токен читается из env один раз при старте и
  **удаляется из `process.env`** (`scrubExecutorToken`) — иначе он попал бы в
  окружение дочерних процессов и в текст команды. В логах токен не пишется.
- Сравнение токена — **timing-safe** (`timingSafeEqual` по SHA-256).

## Env-конфигурация

| Переменная | Обязательна | По умолчанию | Назначение |
|---|---|---|---|
| `SYNTH_EXECUTOR_TOKEN` | **да** | — | bearer-токен доступа к API исполнителя |
| `SYNTH_EXECUTOR_WORKSPACE` | **да** | — | корень workspace (граница containment'а) |
| `SYNTH_EXECUTOR_HOST` | нет | `0.0.0.0` | адрес прослушивания |
| `SYNTH_EXECUTOR_PORT` | нет | `5100` | порт прослушивания |
| `SYNTH_EXECUTOR_MAX_CONCURRENCY` | нет | `4` | лимит одновременных команд |
| `SYNTH_EXECUTOR_MAX_TIMEOUT_MS` | нет | `120000` | потолок таймаута команды |
| `SYNTH_EXECUTOR_MAX_OUTPUT_BYTES` | нет | `10485760` | потолок буфера вывода |
| `SYNTH_EXECUTOR_MCP_SERVERS` | нет | `[]` | MCP-серверы, которые хостит исполнитель: JSON-массив `{name,command,args,env}`; fail-closed на невалидном, `''` = серверов нет (отключает дефолт образа; у flavor'ов с браузером дефолт — Playwright MCP) |
| `SYNTH_EXECUTOR_BACKGROUND_MAX` | нет | `8` | лимит живых фоновых процессов (ADR-077, шаг 7c) |
| `SYNTH_EXECUTOR_BACKGROUND_LOG_MAX_BYTES` | нет | `10485760` | лимит журнала фонового процесса на поток, байт |
| `SYNTH_EXECUTOR_BACKGROUND_LOG_DIR` | нет | `<tmp>/synth-exec-bg` | каталог журналов фоновых процессов |

Без токена или без корня workspace процесс **не стартует** (fail-closed);
невалидные числа — тоже ошибка (явная настройка оператора не должна молча
превращаться в дефолт).

Запуск: `node dist/main.js` (в образе — `/app/dist/main.js`). Graceful shutdown
по `SIGINT`/`SIGTERM`: сервер закрывается, **фоновые процессы останавливаются**
(`SIGTERM` → `SIGKILL`).

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest);
  `pnpm --filter @itphx/synth-executor test`.
  - `server.test.ts` — аутентификация (401/200), успех/ненулевой код/ENOENT/
    таймаут/лимит вывода, containment (абсолютный путь, `..`, симлинк наружу и
    внутрь), лимит параллельности (429), `capabilities`/`health`;
  - `background.test.ts` — сервис фоновых процессов: запуск (`proc_`-id, pid),
    раздельные логи stdout/stderr, статусы `exited`/`failed`/`killed`,
    `stop()` (идемпотентность), таймаут, лимит живых процессов, усечение
    журнала (`truncated`, процесс не убит), containment `cwd`, отрезки журнала
    (offset/limit), `prune()` (терминальные записи и файлы — удаляются, живые —
    нет);
  - `server-background.test.ts` — HTTP-контур фоновых процессов: `spawn`
    (201/`proc_`/pid), статус (`running`→`exited`/`failed`), логи (stdout и
    stderr раздельно, offset/limit, `truncated`), `stop` (200 `stopping` →
    `killed`, идемпотентность), 401 без токена, 404 неизвестного процесса,
    400 невалидного тела и `cwd` вне workspace, 429 лимита процессов,
    `capabilities` (`protocol: 3`, `features.background`), прежний `POST /exec`;
  - `client.test.ts` — round-robin, failover на следующий адрес, `failMode`
    (`fail`/`inline-fallback`), отмена по `AbortSignal`, очередь по
    `concurrency`, реконструкция ошибок сервера; **инвентарь пула и маршрутизация
    (ADR-077 шаг A)**: `probe` по составу пула, команда с `requires` уходит в
    адрес с нужной программой, отсутствие программы → `dependency_missing`/
    `EDEPENDENCY`, не ответивший адрес выпадает из маршрутизации, пул целиком
    недоступен → `EUNREACHABLE`, сводка пула (`missing`/`total`/`unreachable`);
    **фоновый запуск (ADR-077 шаг 7c)**: `proc_`-id и pid, вывод stdout/stderr
    потоком, `exited.exitCode === 0`, ненулевой код, `stop()` → killed с
    непустым `signal`, недоступный адрес → ошибка запуска, исчезновение
    исполнителя → `exited` резолвится (`exitCode: -1`), исполнитель протокола
    v2 → `EBACKGROUND`, маршрутизация фонового запуска по `requires`;
  - `toolchain.test.ts` — состав toolchain'а: базовый словарь core + допсведения,
    различение `ENOENT` и «есть, но не поддержал `--version`»;
  - `mcp.test.ts` — MCP-хостинг: ленивый старт (реальный stdio-сервер на SDK —
    фикстура `test-fixtures/mcp-stdio-server.mjs`), `idle`→`up`, `down` с
    причиной, переподнятие, circuit breaker, таймауты, усечение, `redactSecrets`,
    `close()` завершает дочерний процесс;
  - `mcp-routes.test.ts` — `/mcp/servers|tools|call` под bearer: 401, 404
    (`not_found`), 400, `down` после неудачного спавна (ENOENT), секреты не
    попадают в ответ;
  - `config.test.ts` — fail-closed разбор env (в т.ч. `SYNTH_EXECUTOR_MCP_SERVERS`:
    строгий JSON, `''` = пустой список).

  **Контрактного набора проверок в пакете нет** — источник истины один: контрактный
  suite порта живёт в core (`packages/core/src/execution/contract/execution.ts`), прогон
  против удалённого исполнителя — в core (`packages/core/src/execution/contract/remote.test.ts`),
  как прогон драйвера хранилища (`packages/core/src/storage/contract/postgres.test.ts`).
  Дублировать набор проверок здесь нельзя: иначе remote и inline разойдутся по набору
  проверок.
- Сборка: `pnpm --filter @itphx/synth-executor build` (`tsc -p tsconfig.build.json`).
  Порядок релизной сборки — `shared → core → executor → …` (скрипт
  `scripts/build.sh` правит релизный агент).

## Чего не делать

- Не писать свою реализацию `execFile` — семантика исполнения принадлежит
  core (`InlineExecutionPort`).
- Не создавать собственные HTTP-агенты/диспетчеры и не обходить `egressFetch`
  (ADR-099, инвариант 22).
- Не выводить токен в логи/ответы и не оставлять его в `process.env` после
  старта.
- Не ослаблять containment (`cwd` вне workspace → отказ) и не делать его
  fail-open.
- Не дублировать контрактный suite порта в пакете — он живёт в core
  (`packages/core/src/execution/contract/`).
- Не заводить свой словарь базовых возможностей: он живёт в core
  (`EXECUTION_BASE_CAPABILITIES`) и подтягивается динамическим `import()` —
  иначе control plane и исполнитель разойдутся по составу пула.
- Не отвечать на `probe` локальной пробой в обход инвентаря пула: клиент
  спрашивает `/capabilities`, а не «здесь есть программа» (ADR-077 шаг A).
- Не дублировать логику containment'а в фоновом сервисе: используется **тот
  же** `resolveContainedCwd`, что и у `ExecService`.
- Не проверять `requires` в фоновом запуске: проверка бинарных требований —
  на слое тула (как в портовом контракте `spawnBackground`).
- Не убивать процесс при достижении лимита журнала: только `truncated` и
  прекращение записи в поток.
