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

## Wire-протокол (версия 1)

| Метод | Путь | Назначение | Авторизация |
|---|---|---|---|
| `POST` | `/exec` | выполнить команду | bearer-токен |
| `GET` | `/capabilities` | версия протокола и состав toolchain'а (базовый словарь core + допсведения) | bearer-токен |
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
  workspace; `401` — нет/неверный токен; `429` — превышен лимит одновременных
  команд; `500` — прочие ошибки исполнения (включая ненулевой код выхода).
- `reason` на проводе: либо причина порта (`timeout` | `aborted` |
  `spawn_failed` | `nonzero_exit` | `max_output`), либо протокольная
  (`invalid_request` | `cwd_outside_workspace` | `unauthorized` |
  `too_many_requests` | `internal_error`). Клиент переносит причину порта как
  есть, протокольную — в `reason: 'spawn_failed'` с различающим `code`
  (`EWORKSPACE`/`EAUTH`/`ELIMIT`/`EINVAL`).

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

Без токена или без корня workspace процесс **не стартует** (fail-closed);
невалидные числа — тоже ошибка (явная настройка оператора не должна молча
превращаться в дефолт).

Запуск: `node dist/main.js` (в образе — `/app/dist/main.js`). Graceful shutdown
по `SIGINT`/`SIGTERM`.

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest);
  `pnpm --filter @itphx/synth-executor test`.
  - `server.test.ts` — аутентификация (401/200), успех/ненулевой код/ENOENT/
    таймаут/лимит вывода, containment (абсолютный путь, `..`, симлинк наружу и
    внутрь), лимит параллельности (429), `capabilities`/`health`;
  - `client.test.ts` — round-robin, failover на следующий адрес, `failMode`
    (`fail`/`inline-fallback`), отмена по `AbortSignal`, очередь по
    `concurrency`, реконструкция ошибок сервера; **инвентарь пула и маршрутизация
    (ADR-077 шаг A)**: `probe` по составу пула, команда с `requires` уходит в
    адрес с нужной программой, отсутствие программы → `dependency_missing`/
    `EDEPENDENCY`, не ответивший адрес выпадает из маршрутизации, пул целиком
    недоступен → `EUNREACHABLE`, сводка пула (`missing`/`total`/`unreachable`);
  - `toolchain.test.ts` — состав toolchain'а: базовый словарь core + допсведения,
    различение `ENOENT` и «есть, но не поддержал `--version`»;
  - `config.test.ts` — fail-closed разбор env.

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
