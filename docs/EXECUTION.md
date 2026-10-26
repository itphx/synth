# Исполнение команд — порт, топологии и развёртывание (Spec)

> **Назначение:** «как устроено, точно и полно» — контракт порта исполнения, топологии развёртывания,
> exec-API, доверенная граница, матрица «что уезжает в исполнитель», развёртывание и миграция
> (класс **Spec** по [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1). Решение — в
> [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md) (единый порт `ExecutionPort` и режим `remote`);
> образы и flavor'ы — [PROP-082](./arch_decisions/prop-082-full-images-deployment.md);
> конфигурация — [docs/CONFIGURATION.md](./CONFIGURATION.md) §«Исполнение (топология)».
>
> **Статус документа:** порт `ExecutionPort`, обе реализации (inline/remote), секция `execution` в конфигурации,
> пакет исполнителя `@itphx/synth-executor`, подключение по `execution.mode=remote` и чарт
> split-развёртывания (значения `execution.*`/`executor.*`, шаблоны `executor-*.yaml`, общий том
> workspace, `NetworkPolicy` пула) — **реализованы**; **MCP-stdio — реализовано**: исполнитель хостит
> MCP-серверы у себя (**B1**: `SYNTH_EXECUTOR_MCP_SERVERS`, эндпоинты `/mcp/servers`, `/mcp/tools`,
> `/mcp/call` — появились в протоколе **2**), а control plane к ним подключён (**B2**: `ExecutorMcpSource` +
> `attachExecutorMcpSource`, тулы `{server}_{tool}`, e2e на живом исполнителе); **актуальная версия
> протокола — 4** (секреты вызова `secrets[]`, ADR-077 «Обновлено 2026-10-26», (б); фон — v3, ADR-113),
> совместимость — по полю `protocol` в `GET /capabilities`.
> Остаток — `inline-shell` (шаг 9) и runbook переключения топологии (шаг 12).
> Метрики `synth_executor_*` + `/metrics` исполнителя + диагностика
> «исполнитель недоступен» — **реализованы** (шаг 7d; каталог серий —
> [OBSERVABILITY.md](./OBSERVABILITY.md) §«Исполнитель (split-режим)», runbook —
> [MAINTENANCE.md](./MAINTENANCE.md) §«Метрики исполнителя и диагностика split-режима»).
> Перенос git-операций control plane на `ExecutionPort` вместо
> `simple-git` **выполнен** (ADR-077 «Обновлено 2026-10-26», (а)); доставка SSH-материала и CA —
> **тоже** (там же, (б) и (в)): SSH-ключ едет на время вызова полем `secrets[]` (протокол 4),
> CA — конфигурация исполнителя (`SYNTH_EXECUTOR_TLS_CA_FILE`).

---

## 1. Топологии развёртывания

### 1.1. Split и all-in-one — два режима одной конфигурации

Две топологии — **два режима одной конфигурации**, а не две разных системы. Разница — только в том,
**где физически живёт исполнитель**; код домена, порт исполнения и контракт — одни и те же.

| Режим | `execution.mode` | Где исполняется | Образы |
|---|---|---|---|
| **Inline (all-in-one)** | `inline` (дефолт) | в процессе backend'а | один образ: control plane + toolchain (+ рантайм исполнителя) |
| **Remote (split)** | `remote` | в отдельных контейнерах-исполнителях | `synth-backend` (control plane, без toolchain) + `synth-executor` (worker) |

Разделение по образу — не «выключатель», а следствие режима: в `inline` backend'у нужен toolchain
(образ с flavor'ом — [PROP-082](./arch_decisions/prop-082-full-images-deployment.md)), в `remote` — не нужен, зато
нужен отдельный образ worker'а.

### 1.2. Единый переключатель `execution.mode`

- Переключатель — **параметр запуска, не runtime**: секция `execution` в `config.yaml`, env
  `SYNTH_EXECUTION_MODE`, CLI-флаг `--execution-mode`.
- Смена — **только перезапуск процесса**. Обоснование — тот же класс, что у `storage.backend`
  (выбор физического backend'а хранилища, `packages/core/src/storage/storage-context.ts`) и у режимов-полюсов
  гибрида ([PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md)): process-глобальные singleton'ы
  (TLS-диспетчер, пул PG, MCP, шедулер) не переинициализируются на лету — только рестарт
  (инвариант 24 корневого `AGENTS.md`; graceful shutdown с exit code 75 —
  `packages/core/src/server/restart.ts`).
- Приоритет — как у всей конфигурации ([ADR-023](./arch_decisions/adr-023-configuration.md)): **CLI-флаг > env >
  `config.yaml` > дефолт**.
- Дефолт `inline` — обратная совместимость: нынешнее поведение (исполнение в процессе backend'а)
  сохраняется без изменений; новая секция в конфиге отсутствует у всех существующих установок.
- Значение `mode` — **fail-closed**: неизвестное явное значение (например, опечатка `inlne`) валит
  старт, а не молча выбирает дефолт (как `storage.backend` — «fail-closed на неизвестном явном
  значении»).

### 1.3. Что где исполняется

| Компонент | Inline (`inline`) | Remote (`remote`) |
|---|---|---|
| **Control plane** (сессии, история, контекст, permissions, RBAC/OIDC, LLM Gateway, API v2) | в процессе backend'а | в процессе backend'а (1+ реплики — при PostgreSQL) |
| **Хранилище** | файловое (`{dataDir}`) или PostgreSQL | PostgreSQL (предпосылка — см. «Миграция между топологиями») |
| **Workspace проекта** (`project.workspace`, [ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md)) | локальный каталог backend'а | общий том (backend ↔ исполнители), см. «Доступ к workspace» |
| **Toolchain** (`git`, `ripgrep`, `python3`, `openssh-client`) | в образе backend'а (flavor — PROP-082) | в образе worker'а (`synth-executor`) |
| **Исполнитель** (spawn/timeout/kill, лимиты вывода) | `InlineExecutionPort` — вызов `execFile` в процессе | удалённый порт — HTTP к `synth-executor` |
| **Исполняемые команды** (shell, grep, git) | в процессе backend'а | в контейнере worker'а |
| **FS-роуты** (чтение/запись файлов через HTTP) | backend | backend (не уезжают — см. матрицу) |
| **Provisioning workspace** | backend (`engine/workspace-provision.ts`) | backend (тот же модуль) |
| **Git-реестр** (`project.repos`, [ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md)) | backend | backend (реестр и SSH-материал — в backend'е; ключи едут в исполнителя на время вызова, ADR-077) |
| **LLM-вызовы** (через `GatewayProvider`, [ADR-036](./arch_decisions/adr-036-llm-gateway.md)) | backend | backend (в исполнителе LLM-ключей нет) |
| **Permission-слой** (`plan`/`act`/`yolo`, allow/deny/ask) | backend | backend (решение о допуске — до вызова порта) |
| **MCP stdio-серверы** | в процессе backend'а (spawn через `StdioClientTransport`) | **в исполнителе** (B1: `SYNTH_EXECUTOR_MCP_SERVERS` + `/mcp/*`, протокол 2; B2: клиентская проводка в control plane — `ExecutorMcpSource`) |
| **Наблюдаемость** | `/metrics` backend'а | `/metrics` backend'а (очередь/занятость пула/ожидание) **+** `/metrics` исполнителя (исполненные команды/длительность/inflight/MCP) — шаг 7d |

---

## 2. Режим исполнения в конфигурации

Секция `execution` — **реализована**: Zod-схема `executionConfigSchema` и типы `ExecutionConfig`/`ExecutionMode`/
`ExecutionFailMode` (`packages/shared/src/config/types.ts`), дефолты — `packages/shared/src/config/defaults.ts`,
резолверы `resolveExecutionConfig`/`resolveExecutionMode` (`packages/shared/src/config/execution.ts`). В `config.yaml`
секция **необязательна** (дефолт `inline` — прежнее поведение). Состав:

| Поле | Тип / значения | Дефолт | Смысл |
|---|---|---|---|
| `execution.mode` | `inline` \| `remote` | `inline` | Топология (см. §1.2). |
| `execution.remote.url` | список адресов исполнителей | `[]` | Куда ходить за исполнением (K8s Service `synth-executor`, `http://…`); пусто при `remote` → fail-closed на старте. |
| `execution.remote.timeoutMs` | число | 30 000 | Таймаут exec-вызова. По умолчанию — как у нынешних тулов: 30 с (`packages/core/src/engine/tools/shell.ts`, `packages/core/src/engine/tools/search.ts`, `packages/core/src/engine/tools/git.ts`); для shell разрешён больший таймаут (до 120 с) — отдельным значением в самом туле, не в конфиге. |
| `execution.remote.concurrency` | число | число CPU backend'а | Лимит одновременных exec-вызовов на backend; превышение → очередь с ожиданием (см. `synth_executor_wait_seconds`). |
| `execution.remote.failMode` | `fail` \| `inline-fallback` | `fail` | Поведение при недоступном исполнителе. **`fail` — fail-closed**: инструмент недоступен с явной причиной (`unavailable(dependency)`-подобный статус), fallback на локальное исполнение — только явной настройкой. |
| `execution.remote.tokenSecret` | путь/ссылка на токен | — | **Путь/ссылка, не значение** (инвариант 13): путь к файлу с токеном или `existingSecret`/`tokenKey` (как у `security.tls` в чарте). Сам токен — `synth_exec_…` (формат по образцу service-key, `packages/core/src/storage/service-api-key-store.ts`). |

Фактические дефолты (как в `packages/shared/src/config/defaults.ts`): `mode: inline`,
`remote.url: []`, `remote.timeoutMs: 30000`, `remote.concurrency` — число CPU процесса
(`availableParallelism()`), `remote.failMode: fail`, `remote.tokenSecret: ''` (пусто).

Env-имена (по одному на поле; **зафиксированы и реализованы**): `SYNTH_EXECUTION_MODE`,
`SYNTH_EXECUTION_REMOTE_URL` (список через запятую), `SYNTH_EXECUTION_TOKEN` (путь/ссылка на
токен, НЕ значение — инвариант 13), `SYNTH_EXECUTION_TIMEOUT_MS`, `SYNTH_EXECUTION_CONCURRENCY`,
`SYNTH_EXECUTION_FAIL_MODE`. Приоритет — CLI-флаг > env > `config.yaml` > дефолт
([ADR-023](./arch_decisions/adr-023-configuration.md)).

CLI-флаг: `--execution-mode inline|remote` (рядом с `--restart-mode`,
`packages/core/src/main.ts:106`; **реализован**); в managed этот флаг задаётся через env/ConfigMap чарта
(`charts/synth/templates/backend-deployment.yaml:149`), в standalone/local — через `config.yaml` или env.

`failMode: inline-fallback` — **явная** настройка, не дефолт: она означает, что при недоступности
исполнителя backend исполнит команду сам (в своём окружении, со своим toolchain). Это удобно для
миграции и для dev, но в managed-контуре это обход изоляции — включать только осознанно.

**Текущее состояние реализации (шаги 3 и 7b).** Режим `inline` — прежнее поведение,
ничего не меняется. Режим `remote` (удалённый исполнитель) реализован **шагом 7b**:
core подключает пакет `@itphx/synth-executor` **динамическим `import()`** и собирает
удалённый порт; пакет опционален (`optionalDependencies` core), поэтому режим
`remote` — **fail-closed на старте**: процесс не поднимается, а не «молча уходит в inline».
Проверка — `checkExecutionMode`/`assertExecutionModeSupported`
(`packages/core/src/execution/startup.ts`, **async** — проверяется доступность пакета и
читаемость токена); вызывается при старте core (`packages/core/src/main.ts`)
и backend (`packages/backend/src/app.ts`).

| Ситуация | Что видит оператор |
|---|---|
| неверный `mode`/`failMode` (CLI/env/config) | `[config] невалидное значение SYNTH_EXECUTION_MODE="inlne": ожидается одно из 'inline', 'remote'` — **ошибка конфигурации**, а не тихий выбор дефолта |
| `mode: remote`, `remote.url` пуст | «требуется хотя бы один адрес исполнителя» (`execution.remote.url` / `SYNTH_EXECUTION_REMOTE_URL`) |
| `mode: remote`, адреса заданы, но нет пакета исполнителя | «удалённый режим недоступен: пакет исполнителя не установлен» (`execution.remote_unavailable`) |
| `mode: remote`, пакет есть, но токен не читается | «удалённый режим недоступен: токен исполнителя не прочитан» (`execution.remote_unavailable`) |
| `mode: remote`, адреса/пакет/токен в порядке | старт разрешён — порт исполнения собирается по режиму (`packages/core/src/execution/factory.ts`) |

Тексты последних — через ключи `shared/i18n` (`execution.remote_url_required`/
`execution.remote_unavailable`, ADR-041). Токен — **путь** (`execution.remote.tokenSecret`),
а не значение (инвариант 13): значение читается из файла и не попадает ни в логи, ни в
текст ошибок.

---

## 3. Контракт порта исполнения

Исполнение — **порт**, по образцу портов слоя хранения ([ADR-096](./arch_decisions/adr-096-storage-layer.md)):
домен работает через интерфейс, физический backend — взаимозаменяем. Реализовано в
`packages/core/src/execution/` (`ports/execution-port.ts`).

```ts
// packages/core/src/execution/ports/execution-port.ts
/** Форма команды: shell-строка или argv-массив (без shell). */
type ExecCommand =
  | { kind: 'shell'; command: string; shell?: string }  // `<shell> -c <command>` (по умолчанию `sh`)
  | { kind: 'argv'; file: string; args?: string[] };     // `<file> <args…>` — без shell

interface ExecRequest {
  command: ExecCommand;
  cwd?: string;                     // рабочий каталог команды; не задан — каталог исполнителя
  env?: Record<string, string>;     // ДОПОЛНИТЕЛЬНОЕ окружение (мержится поверх базового)
  timeoutMs?: number;               // таймаут вызова
  signal?: AbortSignal;             // отмена («Стоп» сессии)
  maxOutputBytes?: number;          // лимит буфера вывода; по умолчанию DEFAULT_MAX_OUTPUT_BYTES (10 МБ)
  secrets?: ExecSecret[];           // секреты вызова (протокол 4): SSH-ключ — ЗНАЧЕНИЕ, не путь
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;      // у успешного вызова всегда 0
  truncated: boolean;     // вывод обрезан по лимиту порта
  durationMs: number;     // длительность исполнения
}

interface ExecutionPort {
  execute(req: ExecRequest): Promise<ExecResult>;
}
```

- **Команда — дискриминированный union, а не строка.** В домене две формы вызова, и
  различие принципиально: `shell` (`sh -c <команда>` — тул `execute_shell`, inline-shell
  `` !`cmd` ``) сохраняет shell-семантику (пайпы, редиректы, подстановки переменных), а
  `argv` (git, `rg`, проба `bin --version`) запускает бинарник **без shell** — значит,
  классическая инъекция невозможна и allowlist значений в git-тулах (ADR-076) остаётся
  осмысленным. Строкой это различие не выразить: либо инъекция, либо запрет shell-семантики.
- **Неуспешный код выхода — ошибка, а не поле результата.** `ExecResult.exitCode` у
  успешного вызова всегда `0`; ненулевой код приходит **ошибкой** `ExecutionError`
  (`reason: 'nonzero_exit'`, `code` = код выхода). Так дословно сохраняется текст
  «Command failed: …», который видит модель: тексты ошибок тулов — контракт, и переписывать
  их в тулах ради «красивого» кода выхода нельзя.
- **Ошибка типизирована.** `ExecutionError` несёт `reason` (`timeout`/`aborted`/
  `spawn_failed`/`nonzero_exit`/`max_output`), `code`, `stdout`, `stderr`, `killed`,
  `signal`, `truncated`, `durationMs` и **сохраняет исходное `name`** (`AbortError` — для
  отмены): благодаря этому распознавание отмены (`isAbortError`) и тексты ошибок не
  изменились. Разбор ошибки на конкретные тексты (`ENOENT` → `tool.binary_missing`) остался
  в тулах — порт не знает про i18n-ключи.
- **Проверка типа ошибки — структурная (`isExecutionError`), а не через `instanceof`.**
  Клиент удалённого порта создаёт ошибку через динамический `import('@itphx/synth-core')`
  (то есть из `dist`), а код в core импортирует класс из исходников — это **два разных
  объекта класса**, и `instanceof` не срабатывает. Поэтому порт экспортирует
  `isExecutionError(value): value is ExecutionError` — она опирается на стабильный признак
  типа (`name === 'ExecutionError'`) и форму ошибки (`reason`/`message`).
- **`stdin` не реализован.** Потребности в неинтерактивном вводе у домена нет: exec-API
  обслуживает только неинтерактивные команды (PTY/attach — вне объёма этой версии,
  [PROP-064](./arch_decisions/prop-064-ui-browser-terminal.md)). Поле не добавлено «на будущее» — при
  реальной потребности контракт изменится осознанно.
- **Два лимита вывода — это разные вещи.** `maxOutputBytes` — лимит **порта** (буфер
  процесса; по умолчанию 10 МБ — как прежний `maxBuffer`); превышение → ошибка с
  `reason: 'max_output'` и `truncated: true`. Обрезка **текста, который видит модель**, —
  на уровне тула и в контракт порта не входит: shell — 100 КБ (`MAX_OUTPUT_LENGTH`,
  `packages/core/src/engine/tools/shell.ts`), git — 20 КБ (`MAX_GIT_OUTPUT`,
  `packages/core/src/engine/tools/git.ts`), `rg` — 200 строк
  (`packages/core/src/engine/tools/search.ts`).
- **Секреты вызова — `secrets?: ExecSecret[]` (протокол 4).** Материал, нужный точке
  исполнения **на время одной команды** (сейчас — приватный SSH-ключ с необязательной
  passphrase, ADR-076). Передаётся **значением**, а не путём к файлу: путь control plane
  в контейнере исполнителя не существует. Материализацию делает **точка исполнения**:
  временный ключ `0600` в каталоге `0700` (+ askpass `0700` при passphrase), удаление —
  **всегда** (успех, ошибка команды, таймаут, отмена). Значения **не логируются** и **не
  возвращаются** в ответе (ни в успехе, ни в ошибке). Фоновые процессы
  (`spawnBackground`) секреты **не поддерживают** — fail-closed с кодом `ESECRETS`
  (`EXECUTION_SECRETS_UNSUPPORTED_CODE`) с обеих сторон.
- **Реализации:** `InlineExecutionPort` — исполнение в процессе поверх прежних
  `execFileAsync` (`packages/core/src/engine/tools/shell.ts`, `packages/core/src/engine/tools/search.ts`,
  `packages/core/src/engine/tools/git.ts`, `packages/core/src/engine/commands/inline-shell.ts`,
  `packages/core/src/engine/tools/runtime-deps.ts`); удалённая — HTTP к
  исполнителю (шаг 7b; пакет `@itphx/synth-executor`, клиент — экспорт `./client`).
- **Контрактный suite** — как у storage-драйвера ([ADR-097](./arch_decisions/adr-097-storage-provider-class.md)):
  один набор тестов на любую реализацию (`packages/core/src/execution/contract/execution.ts` —
  «паспорт» порта; образец — `packages/core/src/storage/contract/index.ts`). Проверяется:
  разделение stdout/stderr, обе формы команды, ненулевой код выхода (ошибка с кодом и
  частичным выводом), `cwd`, мердж `env` (окружение не заменяется целиком), таймаут, отмена
  (`AbortSignal`), превышение лимита вывода, отсутствующий бинарник (`ENOENT`), заполненный
  `durationMs`. Прогон против удалённого исполнителя — **в core**
  (`packages/core/src/execution/contract/remote.test.ts`, живой исполнитель в процессе теста),
  как прогон драйвера БД (`packages/core/src/storage/contract/postgres.test.ts`): набор
  проверок должен быть один, иначе remote и inline разойдутся. Для удалённой реализации
  каталог из `cwd` должен быть виден исполнителю (общий том workspace) — контракт это
  предполагает. **Намеренное различие реализаций** разделено на два блока: общий suite —
  `cwd` в границах реализации; `describeInlineOnlyExecutionChecks` — только inline (`cwd`
  вне рабочего каталога проекта исполняется, локального ограничения нет);
  `describeRemoteOnlyExecutionChecks` — только remote (`cwd` вне workspace исполнителя →
  отказ `EWORKSPACE`; containment — граница безопасности исполнителя).
- **Точка подключения — один шов:** `ctx.extra.executionPort`
  (`packages/core/src/execution/tool-port.ts`, `resolveExecutionPort(ctx)`) — существующий
  шов зависимостей тулов (`ToolContext.extra`); порт кладёт оркестратор, fallback —
  inline-исполнение в процессе (прежнее поведение). Не-туловые точки (резолвер проектных
  инструкций, детект зависимостей, inline-shell) берут **тот же** порт через композицию, а
  не через собственный inline-экземпляр — иначе в split-режиме они остались бы в control
  plane.

---

## 4. Executor: сервис и разделение ответственности

**Executor (worker) — тот же код, что и inline-рантайм исполнителя.** Исполнитель умеет работать и
отдельным сервисом (слушает exec-API), и локально внутри backend'а (inline). Это исключает расхождение
поведения между топологиями: один набор тестов, одна реализация команд.

Ответственность разделена строго:

| В backend'е (control plane) | В исполнителе (worker) |
|---|---|
| Сессии, история, контекст, LLM-вызовы, permissions, RBAC/OIDC | Выполнение команды, разбор env, лимиты вывода, таймаут |
| Provisioning workspace ([ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md)) | Чтение/запись файлов **в пределах переданного `cwd`** |
| Git-реестр `project.repos` и SSH-ключи ([ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md)) | Никаких LLM-ключей, OIDC-секретов и чужих workspace |
| Решение о допуске тула и о режиме (`plan`/`act`/`yolo`) | Изоляция, квоты, лимиты ресурсов |
| Очередь вызовов, ретраи, `failMode` | Никакого доступа к API v2 |

### 4.1. Упаковка: отдельный in-tree пакет `@itphx/synth-executor`

Исполнитель поставляется **отдельным npm-пакетом** `@itphx/synth-executor`
(`packages/executor`) — ровно по модели драйвера слоя хранения
([ADR-097](./arch_decisions/adr-097-storage-provider-class.md), [ADR-096](./arch_decisions/adr-096-storage-layer.md)):
«физический backend' порта» лежит в своём пакете, а core подключает его по
конфигурации, а не тянет в свою сборку.

- **Манифест пакета** — как у `@itphx/synth-storage-postgres`
  (`packages/storage-postgres/package.json`): `dependencies` —
  `@itphx/synth-shared` (`workspace:*`), `peerDependencies` — `@itphx/synth-core`
  (`workspace:*`), `devDependencies` — core, `@types/node`, `typescript`;
  `files: ["dist"]`.
- **Импорт типов портов из core — только `import type`.** Runtime-импорт core —
  точечный и только по образцу драйвера хранилища (`createFileStorage` в
  `packages/core/src/storage/storage-context.ts`): исполнитель переиспользует
  `InlineExecutionPort` (`packages/core/src/execution/inline-execution-port.ts`),
  чтобы **семантика исполнения не расходилась** с control plane — один рантайм
  команд в обеих топологиях (иначе «один код — два режима» из §4.5
  превратился бы в двух реализаций).
- **Цикл `core ↔ @itphx/synth-executor` — намеренный**, разрешённый
  `ignoreWorkspaceCycles: true` в `pnpm-workspace.yaml` (как у
  `@itphx/synth-storage-postgres`): core подключает пакет динамическим `import()`,
  пакет — `peer`/`dev`-зависимость на core.
- **Контрактный suite — в core** (`packages/core/src/execution/contract/`), прогон
  против исполнителя — тоже в core (как
  `packages/core/src/storage/contract/postgres.test.ts`): «паспорт» порта
  принадлежит порту, а не реализации.
- **Собственный release-цикл:** пакет публикуется в npm вместе с остальными
  ([ADR-038](./arch_decisions/adr-038-npm-packages.md)) — пакетов в монорепо становится **8**;
  порядок сборки — `shared → core → executor → …`.
- **Подключение из core** — динамическим `import()` по
  `execution.mode === 'remote'` (как драйвер БД по `storage.backend === 'postgres'`).
  При недоступности пакета — **fail-closed**: процесс не поднимается, без
  молчаливого отката в inline.

### 4.2. Транспорт и exec-API

Транспорт — **HTTP/1.1 + JSON**: тот же стек, что весь Synth (сервер — Hono,
клиент — исходящие вызовы через `egressFetch`,
[ADR-099](./arch_decisions/adr-099-egress-tls-trust.md)). Без gRPC и без новых зависимостей.

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/exec` | тело: `{ command: ExecCommand, cwd?, env?, timeoutMs?, maxOutputBytes?, secrets? }` → `200 { stdout, stderr, exitCode, truncated, durationMs }`; при неудаче — код ошибки с телом `{ error: { reason, code, message, stdout, stderr, killed, signal, truncated, durationMs } }` (зеркалит `ExecutionError`) |
| `POST` | `/exec/spawn` | тело: `{ command: ExecCommand, cwd?, env?, timeoutMs?, requires? }` → `201 { processId, pid }`; фоновый процесс (ADR-077, шаг 7c; ADR-113): `400` — невалидное тело или `cwd` вне workspace, `429` — превышен лимит живых фоновых процессов |
| `GET` | `/exec/:processId` | `200 { processId, status, exitCode, signal, pid?, command, cwd, startedAt, finishedAt?, durationMs?, stdoutBytes, stderrBytes, truncated }` — состояние фонового процесса; `404` — процесс не найден |
| `GET` | `/exec/:processId/logs` | `200 { processId, status, exitCode, signal, stdout: { content, offset, nextOffset }, stderr: { … }, totalBytes, truncated }`; query `stdoutOffset`/`stderrOffset`/`limit` (отрезок ≤ 256 КиБ, по умолчанию 64 КиБ); `404` — процесс не найден |
| `POST` | `/exec/:processId/stop` | `200 { status: 'stopping' }` — остановка фонового процесса; тело `{ signal }` — `SIGTERM`\|`SIGKILL` (пустое тело — `SIGTERM` по умолчанию, иной сигнал — `400`); через 5 с после `SIGTERM` — `SIGKILL`; идемпотентно; `404` — процесс не найден |
| `GET` | `/capabilities` | `{ protocol: 4, toolchain: {git?, rg?, sh?, python3?}, os, arch, node, features: { background, secrets } }` — рукопожатие версии протокола и состава toolchain'а |
| `GET` | `/mcp/servers` | `[{ name, status, toolCount, error? }]` — состояние MCP-серверов исполнителя (`idle`/`up`/`down`); значения `env` не отдаются |
| `GET` | `/mcp/tools` | `[{ server, name, description, inputSchema }]` — инструменты всех **поднятых** MCP-серверов |
| `POST` | `/mcp/call` | тело: `{ server, tool, arguments? }` → `200 { content, isError }`; неизвестный сервер/инструмент → `404`, ошибка MCP → `500` с текстом ошибки (без секретов) |
| `GET` | `/health` | живость исполнителя |

- Тело `/exec` — проекция `ExecRequest`
  (`packages/core/src/execution/ports/execution-port.ts`) **без** поля `signal`:
  отмена передаётся разрывом HTTP-запроса, а не полем запроса.
- Тело ошибки **зеркалит `ExecutionError`**:
  `reason` (`timeout`/`aborted`/`spawn_failed`/`nonzero_exit`/`max_output`), `code`,
  `message`, частичные `stdout`/`stderr`, `killed`, `signal`, `truncated`,
  `durationMs` — клиент восстанавливает типизированную ошибку, не разбирая текст
  (тексты ошибок тулов — контракт, их переписывать нельзя).
- **Отмена:** разрыв HTTP-запроса → `AbortSignal` на сервере → SIGTERM процессу.
  Семантика «Стоп» (ADR-005) сохраняется: клиентский `AbortSignal` доезжает до
  исполнителя тем же эффектом, что и в inline-режиме.
- **Версия протокола — 4** (было 1 → 2 → 3 → 4): добавлены MCP-эндпоинты (v2),
  фоновые процессы (v3) и **секреты вызова** (v4, ADR-077 «Обновлено 2026-10-26», (б)).
  Старый исполнитель их не знает ⇒ **control plane и
  исполнитель обязаны быть одной версии** (см. «Операционные следствия» в
  [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md)).
- **Фоновые процессы — только с протоколом версии 3.** Ручкопожатие
  (`GET /capabilities`) отдаёт `features: { background: true }`; control plane
  **требует** этот признак (и версию ≥ 3), чтобы запускать фоновые процессы:
  - адрес без `features.background` в кандидаты на фоновый запуск **не
    попадает** (как адрес без нужного бинаря);
  - если в пуле нет ни одного адреса с фоновыми процессами — отказ
    `EBACKGROUND` (`EXECUTION_BACKGROUND_UNSUPPORTED_CODE`), который control plane
    показывает как `background_unsupported` (`process.background_unsupported` —
    тот же текст, что и для порта без `spawnBackground`);
  - синхронные команды (`POST /exec`) от старого исполнителя работать
    продолжают — требование касается только фонового запуска.

### 4.2.1. MCP-хостинг исполнителя (шаги B1+B2)

В split-топологии control plane тонкий (в образе `synth-backend` нет Chromium и
tier-4 MCP-серверов), а браузерные инструменты нужны агенту. Поэтому **хостит**
MCP-серверы исполнитель — у него и toolchain, и Chromium.

- **Конфигурация — env** `SYNTH_EXECUTOR_MCP_SERVERS`: JSON-массив описаний
  `[{"name":"playwright-mcp","command":"playwright-mcp","args":["--headless","--no-sandbox","--executable-path","/opt/synth/browser/chrome"],"env":{}}]`.
  Разбор **строгий** (невалидный JSON/запись — ошибка старта, fail-closed);
  **пустая строка — «серверов нет»** (так отключается дефолт образа). `env`
  сервера может содержать токены — они не логируются, не отдаются в
  ответах и вычищаются из текстов ошибок. Сама переменная убирается из
  `process.env` после разбора (`scrubExecutorMcpServers`) — иначе токены утекли бы
  в окружение агентских команд.
- **MCP-клиент — тот же SDK и те же лимиты, что в core**
  (`@modelcontextprotocol/sdk`, `StdioClientTransport`): connect 60 c, вызов
  инструмента 120 c, усечение результата до 30 000 символов, circuit breaker
  (5 ошибок → 60 c). Свой MCP-клиент не пишется.
- **Жизненный цикл — ленивый:** сервер поднимается при первом обращении
  (`GET /mcp/tools` — все серверы, `POST /mcp/call` — нужный). Неудачный старт
  не ломает исполнитель: сервер получает статус `down` с причиной, а
  следующее обращение его переподнимает. При остановке исполнителя MCP-серверы
  закрываются — дочерние процессы (и Chromium) не остаются жить.
- **Граница шагов.** **B1** — серверная часть исполнителя (см. выше). **B2 — реализована**:
  control plane подключается к MCP-серверам исполнителя источником `ExecutorMcpSource`
  (`packages/core/src/engine/mcp/executor-mcp-source.ts`) и транспортом
  `executor-mcp-client.ts`; `attachExecutorMcpSource(...)` в `packages/core/src/server/app/deps.ts`
  добавляет их в `McpManager` при `execution.mode=remote`, тулы регистрируются с префиксом
  `{serverName}_{toolName}`. Проверка — юнит-тесты источника/транспорта и e2e
  `packages/core/src/engine/mcp/executor-mcp.e2e.test.ts` (гейт по env
  `SYNTH_TEST_EXECUTOR_MCP_URL`/`SYNTH_TEST_EXECUTOR_MCP_TOKEN`, как контрактный suite хранения).
- **Playwright MCP:** `playwright-mcp` по умолчанию ищет Google Chrome, которого в
  образе нет ⇒ `--executable-path /opt/synth/browser/chrome` (стабильный симлинк
  tier 3 на фактический `chromium-<ревизия>/chrome-linux64/chrome`), плюс
  `--headless` и `--no-sandbox` (контейнер по умолчанию под root). Дефолт задан
  **только** во flavor'ах с браузером (`browser`/`full`); проверено в контейнере:
  `/mcp/servers` → `up`, 25 инструментов, DOM рендерится. Детали — [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md) п. 9.

### 4.2.2. Секреты вызова и доверие git (протокол 4)

Секреты вызова — **аддитивное** поле `secrets[]` в `POST /exec`
(`{ kind: 'ssh-key', privateKey, passphrase? }`). Control plane передаёт
приватный SSH-ключ **значением**: путь к файлу в control plane в контейнере
исполнителя не существует, поэтому прописать его в `GIT_SSH_COMMAND` нельзя.

- **Материализация — на исполнителе** (`packages/executor/src/secrets.ts`): временный
  каталог `0700` (`mkdtemp`, префикс `synth-ssh-`), ключ `0600`, askpass `0700`
  (при passphrase — `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` +
  `NumberOfPasswordPrompts=1`). Реализация — **общая** с control plane
  (`createSshEnv`, `packages/core/src/git/ssh-env.ts`): дублировать её нельзя.
- **Удаление — всегда:** успех, ошибка команды, таймаут, отмена. Плюс **sweep**
  осиротевших каталогов `synth-ssh-*` при старте процесса
  (`sweepStaleSshDirs`, TTL час) — прерванный процесс мог не дойти до `finally`.
- **Пределы:** максимум 4 записи на вызов, `kind === 'ssh-key'`, `privateKey` —
  непустая строка до 16 КиБ, `passphrase` — строка до 4 КиБ; иначе —
  `400 invalid_request`. Молчаливый пропуск означал бы, что команда выполнится
  **без** ключа, а операция упадёт с невнятной ошибкой аутентификации.
- **Значения не логируются и не возвращаются** в ответе (ни в успехе, ни в
  ошибке); в `/capabilities` их нет.
- **Только синхронный `/exec`.** `POST /exec/spawn` (фоновые процессы) секреты
  **не поддерживает**: процесс переживает вызов, а материал доставляется «на время
  вызова». Отказ — fail-closed с обеих сторон: исполнитель отвечает
  `400 invalid_request`, control plane — ошибкой `ESECRETS`
  (`EXECUTION_SECRETS_UNSUPPORTED_CODE`).
- **Признак поддержки — `features.secrets: true`** в `GET /capabilities` (и версия
  протокола ≥ 4). Исполнитель протокола < 4 **без** этого признака в кандидаты
  на вызов с секретами **не попадает**; если в пуле нет ни одного такого адреса —
  отказ `ESECRETS`: выполнять команду без ключа нельзя.
- **Доверие git (CA) — конфигурация исполнителя**, а не секрет вызова: env
  `SYNTH_EXECUTOR_TLS_CA_FILE` (путь к файлу CA в окружении исполнителя;
  задан, но файл не читается — **ошибка старта**, fail-closed). Исполнитель
  добавляет в окружение вызова env-канал git ≥ 2.31:
  `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.sslCAInfo`,
  `GIT_CONFIG_VALUE_0=<путь>`. Порядок наложения окружения:
  `env` вызова → CA-тройка `GIT_CONFIG_*` → env секрета (перекрывает всё).

### 4.3. Пул адресов, отказ и параллелизм

- **Адреса — список** (`execution.remote.url`): клиент выбирает адрес **по кругу**;
  при ошибке соединения пробует следующий.
- **Все адреса недоступны** → поведение по `execution.remote.failMode`: `fail`
  (fail-closed, по умолчанию) либо `inline-fallback` (явная настройка; backend
  исполняет команду сам — см. §4.5).
- **Лимит одновременных вызовов** — `execution.remote.concurrency`: превышение →
  очередь с ожиданием; время ожидания измеряется метрикой
  `synth_executor_wait_seconds` (см. §9).

### 4.4. Способы размещения в Kubernetes

| Способ | Как выглядит | RBAC | Изоляция | Стоимость | HA | Оценка |
|---|---|---|---|---|---|---|
| **(а) Статический пул Deployment + очередь в backend** | `Deployment` `executor.replicaCount` реплик + `Service`; backend держит очередь и лимит `execution.remote.concurrency` | Не нужен (backend не управляет pod'ами) | На уровне pod'а (podSecurityContext, seccomp, resources) | Дёшево: фиксированный набор pod'ов, запуск при старте чарта | Да — несколько реплик за Service, отказ одного pod'а не влияет | **Рекомендуется для первой версии** — нет RBAC-эскалации у backend'а, нет CRD, масштабируется горизонтально, поведение предсказуемо |
| **(б) Job на сессию (TTL)** | На сессию/задачу — `Job` с `ttlSecondsAfterFinished`; backend создаёт через API | Нужен `Role` на `batch/jobs` (create/get/delete) у backend'а | Лучше (отдельный pod на задачу, чистится по TTL) | Дорого: pod + scheduling на каждую сессию; холодный старт на каждый запуск | Ограниченная: упавший Job не перезапустится (ttl) | Не рекомендуется сейчас: требует RBAC-эскалации у control plane, медленный cold start, сложная очистка |
| **(в) CRD-оператор** | Свой CRD `ExecutorPool` + оператор, решающий lifecycle | Нужен `Role` на CRD + оператор в кластере | Лучше всех (оператор может творить namespaces, квоты, поды) | Очень дорого: отдельный сервис в кластере, CRD, версионирование API | Да (оператор — HA-компонент) | Оставить на будущее: нужен отдельный релизный цикл и свой AD; перебор для первой версии |

**Рекомендация — (а).** Обоснование: у backend'а сейчас **нет** `Role`/`RoleBinding` (в чарте создаются
только ServiceAccount'ы — `charts/synth/templates/serviceaccount.yaml`), и выдавать control plane
право создавать pod'ы — заметное расширение поверхности. Статический пул не требует прав создания
pod'ов вовсе, не требует CRD и не добавляет в кластер новый контроллер. Способы (б) и (в) оставлены
как эволюция (вопросы — в §12).

### 4.5. Жизненный цикл

- **Spawn.** В split-режиме worker'ы **статические** и поднимаются вместе с чартом (вариант (а));
  «ленивый spawn на сессию» в нём не нужен — задержки холодного старта нет. В вариантах (б)/(в)
  spawn ленивый: pod создаётся на первый exec-вызов сессии.
- **Idle-timeout.** Worker без активных вызовов завершает работу по простою; в статическом пуле это
  не «убить pod», а снять нагрузку (`executor.replicaCount` — постоянный ресурс; idle-timeout
  применяется к вариантам с динамическими pod'ами). Внутри worker'а — лимит простоя контейнера.
- **Max-lifetime.** Максимальное время жизни экземпляра исполнителя (для динамических pod'ов — TTL).
- **Graceful kill.** По завершении сессии/очереди: сначала SIGTERM, затем SIGKILL по таймауту; активные
  exec-вызовы получают статус «прервано» (не «упало»).
- **Лимиты вывода.** Единые для обеих топологий: обрезка `MAX_OUTPUT_LENGTH = 100_000` и `maxBuffer 10 МБ`
  (`packages/core/src/engine/tools/shell.ts`); для git — `MAX_GIT_OUTPUT = 20_000`
  (`packages/core/src/engine/tools/git.ts`); для `rg` — 200 строк
  (`packages/core/src/engine/tools/search.ts`). В remote-режиме лимит применяется **на стороне
  исполнителя** (он владеет буфером) и дублируется на клиенте (защита от обхода лимита через прямой
  exec-API).
- **Рестарт backend'а (exit 75).** Живые exec-вызовы **не выживают**: backend уходит через graceful
  shutdown (`packages/core/src/server/restart.ts`), активные HTTP-вызовы к исполнителю обрываются,
  команды в worker'ах остаются выполняться до их таймаута — их результат никому не доставится.
  Следствие: restart в remote-режиме должен быть **менее частым**; либо — принудительное завершение
  вызовов на исполнителе по сигналу (отдельный endpoint отмены, см. §12).
- **Падение исполнителя.** Поведение определяется `execution.remote.failMode`: `fail` (дефолт) — вызов
  возвращает явную ошибку «исполнитель недоступен», инструмент помечается недоступным с причиной
  (по аналогии с `unavailable(dependency)`,
  `packages/core/src/engine/permission/availability.ts`); `inline-fallback` — backend выполняет
  команду сам.
- **Очистка orphan-процессов.** Процессы, оставшиеся после падения исполнителя, — в зоне K8s
  (kubelet дочищает контейнер после смерти pod'а) и в зоне worker'а (собственный reaper: при старте
  worker убивает процессы предыдущего экземпляра, если они пережили перезапуск; `execute_shell` уже
  убивает процесс по SIGTERM при «Стопе», `packages/core/src/engine/tools/shell.ts`).
- **Интерактивность.** PTY/attach-режим — вне объёма этой версии (референс — PROP-064
  «UI-терминал»); exec-API — только неинтерактивные команды.

---

## 5. Доверенная граница backend → исполнитель

Граница «control plane → исполнитель» — **граница доверия**, и она строится по образцу
[ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) и [ADR-052](./arch_decisions/adr-052-public-api-platform.md).

- **TLS.** Общий транспорт исходящих вызовов — `egressFetch` (`packages/core/src/security/tls.ts`),
  глобальный undici-диспетчер, `initTlsTrust` при старте (`packages/core/src/security/tls.ts`).
  Подсистема **не создаёт** собственных
  HTTP-агентов и не полагается на `NODE_EXTRA_CA_CERTS` как на конфигурацию (инвариант 22).
  Доверие к сертификату исполнителя — секция `security.tls` + per-host mapping для его адреса
  (ADR-099); CA-материалы — в Secret, в config.yaml попадают только пути
  (`charts/synth/values.yaml:332` — комментарий «в config.yaml попадают ТОЛЬКО пути внутри контейнера»).
- **Аутентификация.** Статический токен `synth_exec_…` — по образцу service-key
  (`packages/core/src/storage/service-api-key-store.ts`): хранится в Secret, в конфиг/ConfigMap
  не попадает (инвариант 13); передаётся как bearer-заголовок. Значение токена берётся
  **только из Secret/файла** (`execution.remote.tokenSecret` — путь/ссылка, а не значение);
  сравнение — **timing-safe**, без корректного токена — **401**. Опционально — **mTLS**
  (клиентский сертификат из того же `security.tls`).
- **Containment на стороне исполнителя.** Исполнитель **сам** проверяет `cwd`: переданный
  каталог обязан лежать внутри его workspace-корня (симлинк-aware — по образцу
  `resolveRepoCwd`/`isInsideReal` в git-тулах,
  `packages/core/src/engine/tools/git.ts`, `packages/core/src/engine/tools/path-utils.ts`);
  выход за пределы → ошибка. Это **доверительная граница**, а не косметика: без неё
  удалённый порт превращается в выполнение команд в произвольном каталоге.
- **Рукопожатие (`GET /capabilities`).** Клиент узнаёт версию протокола (`protocol: 4`) и
  состав toolchain'а (`git`/`rg`/`sh`/`python3`), ОС и архитектуру. Это источник правды для
  детекта внешних зависимостей в split-режиме (ADR-078): backend не должен считать
  `git`/`rg`/`sh` доступными там, где их нет. Версия протокола — **контракт совместимости**:
  исполнитель версии 1 не знает MCP-эндпоинтов, версии 2 — фоновых процессов, версии 3 —
  секретов вызова, поэтому control
  plane и пул исполнителей обязаны обновляться вместе (ADR-077, операционные следствия шага A).
  Поле `features` — **аддитивное**: `background: true` означает, что исполнитель умеет
  `/exec/spawn` (фоновые процессы, ADR-077 шаг 7c), `secrets: true` — что принимает
  `secrets[]` в `POST /exec` (протокол 4, см. §4.2.2).
- **Требование `features.secrets` (секреты вызова).** Control plane
  **требует** этот признак (и версию протокола ≥ 4), чтобы доставлять SSH-ключ:
  адрес без `features.secrets` в кандидаты на вызов с секретами **не попадает**
  (как адрес без нужного бинаря), а пул, в котором нет ни одного такого адреса, даёт
  отказ `ESECRETS` → команда **не выполняется** «без ключа». Синхронные команды без
  секретов от старого исполнителя работать продолжают — требование касается только
  вызовов с секретами.
- **Требование `features.background` (фоновые процессы).** Control plane
  **требует** этот признак (и версию протокола ≥ 3), чтобы запускать фоновые
  процессы: адрес без `features.background` в кандидаты на фоновый запуск **не
  попадает** (как адрес без нужного бинаря), а пул, в котором нет ни одного
  такого адреса, даёт отказ `EBACKGROUND` → `background_unsupported`
  (`process.background_unsupported` для модели). Синхронные команды от старого
  исполнителя работать продолжают — требование касается только фонового
  запуска.
- **Egress-политика.** Обращения backend'а к исполнителю проходят через политику встроенных
  инструментов (`egress.tools`, `packages/shared/src/config/types.ts`) — адрес исполнителя должен
  быть разрешён; `POST /api/v2/settings/egress/check` (ADR-099) — offline-проверка без запроса.
- **В исполнителе нет** LLM-ключей, OIDC-секретов, ключей API провайдеров и чужих workspace. В
  split-режиме образ worker'а собирается отдельно от образа backend'а — это и есть главный
  выигрыш топологии.
- **Политика `allowedProjects`/`scopes` к исполнителю не применяется** — исполнитель не является
  внешним сервисом с точки зрения публичного API; граница доверия здесь — сеть + токен + TLS.
- **Аудит.** Каждый exec-вызов логируется на backend'е (команда, `cwd`, длительность, исход) и на
  исполнителе; в журнал аудита (`{dataDir}/audit/`) попадает факт вызова, но **не** содержимое вывода
  (может содержать секреты).

---

## 6. Доступ к workspace

Workspace проекта (`project.workspace`, [ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md)) — то,
что делает split-топологию нетривиальной: backend и исполнитель должны видеть **одни и те же файлы**.

- **Кто владеет provisioning'ом** — backend, всегда: `resolveWorkspaceForLocalProject`
  (`packages/core/src/engine/workspace-provision.ts:47`), `validateManagedWorkspacePath`
  (`packages/core/src/engine/workspace-provision.ts:109`), `provisionManagedWorkspace`
  (`packages/core/src/engine/workspace-provision.ts:179`), единая точка `provisionWorkspace`
  (`packages/core/src/engine/workspace-provision.ts:232`). Исполнитель provisioning'ом не занимается.
- **Сейчас** workspace лежит на PVC backend'а (`charts/synth/templates/backend-deployment.yaml:176` —
  mount `data` → `/var/synth/data`); отдельного тома под workspace в чарте (до шага 7c) не было;
  `storage.workspacesRoot` по умолчанию пуст (`packages/shared/src/config/defaults.ts:25`), но
  `resolveWorkspacesRoot` даёт `{dataDir}/workspaces` (`packages/shared/src/config/resolve.ts:200`).
- **В split-режиме** нужен **общий том**: backend и все исполнители монтируют один и тот же каталог
  workspace. Требование — RWX-класс (NFS/CephFS и т.п.). **Шаг 7c закрыл это в чарте**: PVC данных
  backend'а по-прежнему RWO (`charts/synth/values.yaml:45`,
  `charts/synth/templates/backend-pvc.yaml:16`) и `replicaCount: 1` — «Хранилище JSON-файлы → НЕ
  масштабируется, всегда 1 реплика» (`charts/synth/values.yaml:11`), — но для workspace заведён
  отдельный том `executor.workspace.*` с `accessMode: ReadWriteMany` по умолчанию
  (`charts/synth/templates/executor-pvc.yaml:1`), который монтируется в backend и в пул по одному пути
  (`executor.workspace.mountPath`). Если в кластере нет RWX-класса — свой claim
  (`executor.workspace.existingClaim`).
- **Следствие для состояния**: файловая БД (JSON в `{dataDir}`) **не масштабируется** на несколько
  реплик backend'а — это отдельное ограничение, не связанное с исполнителем. Распределённое
  исполнение при 1 реплике backend'а — уже полезно (пул worker'ов на отдельных нодах), но требует
  общего тома под workspace.
- **Containment.** Границы путей не ослабляются: относительные пути — только внутри
  `project.workspace`; для git — `resolveRepoCwd` с проверкой симлинков
  (`packages/core/src/engine/tools/git.ts`); общий `cwd` исполнителя — корень workspace
  конкретного проекта, переданный в запросе, и ничего шире.
- **Альтернатива общему тому** — per-worker копия workspace (workspace-v2) или объектное хранилище:
  это шаг 11 «Порядка реализации» и открытый вопрос (см. §12).

---

## 7. Матрица: что уезжает в исполнитель (по фазам)

| Фаза | Что уезжает | Что остаётся в backend'е | Обоснование |
|---|---|---|---|
| **1** | `execute_shell` (`packages/core/src/engine/tools/shell.ts`), `grep_files`/`rg` (`packages/core/src/engine/tools/search.ts`), python через shell | FS-роуты, provisioning workspace, git-реестр, хранение, LLM-вызовы, permission-слой, MCP stdio | Минимальный шов, максимальный выигрыш: shell — самая «тяжёлая» и самая частая операция; git и MCP требуют доставки ключей/реестров, поэтому идут позже. **Реализовано** (шаг 7c) |
| **2** | git-тулы (`packages/core/src/engine/tools/git.ts`) + доставка SSH-материала | git-реестр `project.repos` (в backend'е), расшифровка и выдача ключей (в backend'е) | SSH-ключи per-agent шифрованы at-rest (`enc:v1:…`, AES-256-GCM) в `{dataDir}/secrets/ssh-keys/` (`packages/core/src/storage/ssh-key-store.ts`). **Решение (ADR-077, «Обновлено 2026-10-26»)**: git-операции control plane — argv через существующий `ExecutionPort` (`requires: ['git']`, без новых git-эндпоинтов); SSH-ключи — аддитивное поле `secrets[]` в `POST /exec` (протокол 4), материализация в tmp исполнителя (`mkdtemp`, 0700/0600), удаление в `finally` + sweep `synth-ssh-*` при старте. **Реализовано**: git-операции control plane — argv через `ExecutionPort` (`requires: ['git']`), SSH-ключ — секрет вызова (`secrets[]`), CA — конфигурация исполнителя (`SYNTH_EXECUTOR_TLS_CA_FILE` → `GIT_CONFIG_*`) |
| **3** | MCP stdio-серверы (`packages/core/src/engine/mcp/client.ts`) и inline-shell (`packages/core/src/engine/commands/inline-shell.ts`) | MCP-реестр и политики ([ADR-071](./arch_decisions/adr-071-mcp-servers-prompt.md)), конфигурация серверов | MCP stdio — это `spawn` с окружением; в исполнителе нужен свой реестр бинарей и своя доставка конфигурации. **MCP-stdio — реализовано** (B1+B2, протокол 3; эндпоинты `/mcp/*` — с протокола 2); `inline-shell` — остаток (шаг 9) |

**Что не уезжает ни в одной фазе:**

- **FS-роуты** (`createFsRoutes`) — HTTP-API работы с файлами проекта; это API, а не исполнение
  команды; backend остаётся точкой доступа.
- **Provisioning workspace** — владелец путей и политик — backend (ADR-075).
- **Git-реестр** (`project.repos`) — состояние проекта, а не исполнение.
- **Хранилище** — сессии/история/проекты ([ADR-096](./arch_decisions/adr-096-storage-layer.md)).
- **LLM-вызовы** — через `GatewayProvider` (инвариант 3; ADR-036): в исполнителе LLM-ключей нет.
- **Permission-слой** — `plan`/`act`/`yolo`, allow/deny/ask (ADR-025/ADR-028/ADR-029): решение о
  допуске принимается **до** вызова порта, в backend'е.
- **MCP stdio на фазе 1** — остаётся в backend'е (исполнитель без собственного MCP-реестра);
  с шага B1+B2 серверы хостит исполнитель, а control plane подключается к ним по HTTP.
- **CA-материалы git** — конфигурация исполнителя, а не пользовательский секрет: в remote-режиме
  исполнитель получает CA при старте (`SYNTH_EXECUTOR_TLS_CA_FILE`) и сам добавляет в окружение
  вызова env-канал git ≥ 2.31 (`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.sslCAInfo`,
  `GIT_CONFIG_VALUE_0=<путь>`); `gitCaConfig()` control plane в remote-режиме не применяется
  (ADR-099). **Реализовано**.
- **Детект зависимостей** (ADR-078) — на фазе 1 детект остаётся локальным
  (`packages/core/src/engine/tools/runtime-deps.ts`); в split-режиме детект должен спрашивать
  исполнителя (перенос — вместе с фазой 1, иначе backend будет считать `git`/`rg` доступными там,
  где их нет).

---

## 8. Изоляция, лимиты и квоты

| Механизм | Значение | Где применяется |
|---|---|---|
| CPU/memory limits | `executor.resources` (для worker'а) | pod worker'а (K8s) |
| Timeout вызова | `execution.remote.timeoutMs` (дефолт 30 с) + лимит тула | порт + исполнитель |
| Idle-timeout / max-lifetime | для динамических pod'ов (варианты (б)/(в)) | исполнитель / оператор |
| Лимит одновременных команд | `execution.remote.concurrency` (backend) + лимит на worker'а | backend + worker |
| Лимит вывода | 100 КБ (shell), 20 КБ (git), 200 строк (rg), `maxBuffer` 10 МБ | порт/исполнитель |
| `runAsNonRoot`, `allowPrivilegeEscalation: false` | как у backend'а (`charts/synth/values.yaml`) | pod worker'а |
| seccomp / capabilities | дефолтный seccomp-профиль K8s, `capabilities.drop: [ALL]` | pod worker'а |
| **Без `docker.sock`** | docker socket в worker'е не монтируется **никогда** | pod worker'а |
| NetworkPolicy | дефолтно — ограниченный egress (только нужные адреса) | pod worker'а |
| Отсутствие секретов | в worker'е нет LLM-ключей/OIDC/провайдерских ключей | образ + монтирование |

**NetworkPolicy**: в чарте их **нет** для backend'а/UI, но **есть** для пула исполнителей
(шаг 7c, `charts/synth/templates/executor-networkpolicy.yaml:1`): ingress — только от pod'ов
control plane (тот же namespace) на порт исполнителя, egress — по умолчанию только DNS
(доп. правила — `executor.networkPolicy.allowedEgress`). `Role`/`RoleBinding` и
`ResourceQuota`/`LimitRange` в чарте по-прежнему отсутствуют — это часть «Дельты» (шаг 10).

---

## 9. Наблюдаемость

Имена — по контракту [ADR-094](./arch_decisions/adr-094-observability-metrics.md) (префикс `synth_` фиксирован,
лейблы из закрытого списка; `session_id`/`user_id`/сырые пути запрещены).

| Метрика | Тип | Лейблы | Где | Смысл |
|---|---|---|---|---|
| `synth_executor_queue_depth` | gauge | — | backend (клиент, core) | Запросов в очереди на отправку исполнителю |
| `synth_executor_workers_busy` | gauge | — | backend (клиент, core) | Занятых слотов пула |
| `synth_executor_wait_seconds` | histogram | — | backend (клиент, core) | Время ожидания в очереди (до отправки) |
| `synth_executor_commands_total` | counter | `outcome` | backend — **доставленные** исполнителю вызовы; исполнитель — **исполненные** команды | Команды по исходу (`ok`/`error`/`timeout`/`cancelled`) |
| `synth_executor_exec_duration_seconds` | histogram | — | исполнитель (`/metrics` исполнителя) | Длительность исполнения команды |
| `synth_executor_inflight` | gauge | — | исполнитель (`/metrics` исполнителя) | Выполняющихся сейчас команд |
| `synth_executor_mcp_servers` | gauge | `status` (`idle`/`up`/`down`) | исполнитель (`/metrics` исполнителя) | MCP-серверы исполнителя по состоянию |

- **Статус — реализовано (шаг 7d).** Клиентские серии считает коллектор
  `createExecutorMetricsCollector` (`packages/core/src/metrics/collectors/executor.ts`),
  приёмник — узкий порт `ExecutionMetricsSink`
  (`packages/core/src/execution/ports/execution-port.ts`: `onQueued`/`onDequeued`/
  `onStarted`/`onFinished`), который клиент удалённого порта
  (`packages/executor/src/client.ts`) дёргает на каждом вызове. Создаётся sink в
  `server/app/deps.ts` (core) и `backend/app/deps.ts` — из общего реестра
  процесса, второй реестр не заводим.
- **Где что живёт.** Клиентские метрики (очередь, занятость, ожидание) — в
  **core**, на стороне удалённого порта: только там известны адреса пула и
  очередь вызовов. Серии исполнения (исход, длительность, inflight, MCP) — на
  **исполнителе**, в его собственном `/metrics`
  (`packages/executor/src/metrics.ts`).
- **Исполнитель отдаёт свой `/metrics`** — тем же реестром, что и backend
  (`packages/core/src/metrics/registry.ts`), тем же рендером 0.0.4
  (`packages/core/src/metrics/renderer.ts`); второго рендера в проекте нет.
  Включается `SYNTH_EXECUTOR_METRICS_ENABLED=true` (chart: `executor.metrics.enabled`),
  **выключен по умолчанию**: выключено → `404`, без bearer-токена исполнителя →
  `401`, с токеном → `200` (`no-store`). Отдельного токена не заводим — тот же,
  что у остальных эндпоинтов исполнителя.
- **Двойного счёта нет.** `synth_executor_commands_total` есть на обеих сторонах
  и считает **разное** (доставленные вызовы vs исполненные команды): одна
  команда даёт единицу в каждом счётчике. Суммировать серии двух job'ов
  Prometheus **нельзя** — различать по `job`
  (см. [OBSERVABILITY.md](./OBSERVABILITY.md) §«Исполнитель (split-режим)»).
- **Формат и правила** — как у остальных: `/metrics` вне `/api/v2`, 404 при выключенном, 401 при
  токене, `no-store` (`packages/core/src/server/routes/metrics.ts`).
  Существующие `synth_sessions_active`/`synth_queue_pending`
  (`packages/core/src/metrics/collectors/sessions.ts`) — про сессии и очередь **сообщений**,
  не про исполнение; дублировать их нельзя.
- **Скрейп** — два эндпоинта и **отдельный job** для пула; доступ из сети —
  `executor.networkPolicy.metricsIngress`; токен в `scrape_config` — файлом
  (`credentials_file`), значение не пишется. Пример — [charts/synth/README.md](../charts/synth/README.md)
  §«Метрики исполнителя».
- **Лимит серий** — 2000 на метрику, при переполнении `synth_metrics_series_dropped_total`
  (`packages/core/src/metrics/registry.ts`). Лейблов у метрик выше — ноль или один, риск
  кардинальности отсутствует.
- **Алерты** — группа `synth-executor` в `charts/synth/files/alerts/synth-rules.yaml`:
  `ExecutorPoolStalled` (пул недоступен: `workers_busy == 0` при растущем
  `queue_depth`), `ExecutorCommandErrorRate` (доля `outcome="error"`),
  `ExecutorQueueWaitHigh` (p95 `synth_executor_wait_seconds`).
- **Health/ready.** У backend'а `GET /health` и `GET /ready`
  (`packages/core/src/server/routes/health.ts`). В split-режиме **живость control plane и
  готовность пула разойдутся**: backend готов, когда готов сам (даже если пул пуст), а «исполнители
  недоступны» — отдельный сигнал (`synth_executor_workers_busy` + счётчик ошибок + алерт). Проба
  backend'а в чарте — `GET /health` для liveness и readiness
  (`charts/synth/values.yaml`) — её **не** меняем: деградация БД — штатный сценарий.

---

### Значения чарта (реализовано — шаг 7c)

Секция `execution` попадает в backend **только через env `SYNTH_EXECUTION_*`**
(`config.yaml` не трогается) — так токен остаётся путём к файлу, а не значением
(инвариант 13).

| Ключ | Смысл |
|---|---|
| `execution.mode` | `inline` (дефолт) \| `remote` → env `SYNTH_EXECUTION_MODE`; неизвестное значение → ошибка рендера (fail-closed) |
| `execution.remote.url` | Адреса исполнителей (список) → env `SYNTH_EXECUTION_REMOTE_URL` (через запятую); пусто + `executor.enabled: true` → адрес Service пула; пусто без пула → ошибка рендера |
| `execution.remote.timeoutMs` | Таймаут exec-вызова → env `SYNTH_EXECUTION_TIMEOUT_MS` |
| `execution.remote.concurrency` | Лимит одновременных вызовов → env `SYNTH_EXECUTION_CONCURRENCY`; `0` → env не выставляется (дефолт — число CPU) |
| `execution.remote.failMode` | `fail` \| `inline-fallback` → env `SYNTH_EXECUTION_FAIL_MODE` |
| `executor.enabled` | Включить split-топологию (рендерит Deployment/Service/ServiceAccount worker'а) |
| `executor.image.repository` / `.tag` / `.pullPolicy` | Образ worker'а (`synth-executor`) |
| `executor.imagePullSecrets` | Секреты приватного реестра (для `git.itphx.ru`) |
| `executor.replicaCount` | Размер пула |
| `executor.service.port` / `.targetPort` | Service пула (`5100`) — его адрес и есть `SYNTH_EXECUTION_REMOTE_URL` |
| `executor.resources` | limits/requests worker'а |
| `executor.limits.maxConcurrency` / `.maxTimeoutMs` / `.maxOutputBytes` | Лимиты worker'а → env `SYNTH_EXECUTOR_MAX_*` |
| `executor.podSecurityContext` / `executor.containerSecurityContext` | Изоляция (как у backend'а) + `capabilities.drop: [ALL]` |
| `executor.workspace.enabled` / `.existingClaim` / `.claimName` / `.size` / `.storageClass` / `.accessMode` | Общий том с workspace (PVC, RWX по умолчанию); свой claim — если в кластере нет RWX-класса |
| `executor.workspace.mountPath` | Точка монтирования общего тома — **одинаковая** в backend и в worker'е (по умолчанию `/var/synth/data/workspaces` — совпадает с дефолтом `storage.workspacesRoot` = `{dataDir}/workspaces`) |
| `executor.workspace.backendWorkspacesRoot` | `storage.workspacesRoot` backend'а (env `SYNTH_WORKSPACES_ROOT`) — задаётся, если `mountPath` отличается от `{dataDir}/workspaces` |
| `executor.networkPolicy.enabled` / `.allowedEgress` | NetworkPolicy worker'а: ingress — только от pod'ов control plane, egress — по умолчанию только DNS |
| `executor.networkPolicy.metricsIngress` | Доп. ingress-правила (формат `networking.k8s.io/v1`) — **в дополнение** к правилу от control plane (например, скрейп `/metrics` исполнителя Prometheus'ом из другого namespace). Непустое значение включает NetworkPolicy пула; egress-ограничения при этом — только при `networkPolicy.enabled: true` |
| `executor.metrics.enabled` | Метрики исполнителя (ADR-077 шаг 7d; ADR-094): env `SYNTH_EXECUTOR_METRICS_ENABLED=true` → свой `GET /metrics` (404 при выключенном, 401 без токена, 200 с токеном); выключено по умолчанию |
| `executor.token.existingSecret` / `.secretKey` | Secret с токеном `synth_exec_…` и ключ внутри него |
| `executor.mcp.enabled` / `.servers` | MCP-серверы, которые хостит исполнитель (ADR-077 шаг B1): `[{name, command, args, env}]` → env `SYNTH_EXECUTOR_MCP_SERVERS` (JSON). Пусто → env не выставляется (дефолт образа: у flavor'ов с браузером — Playwright MCP); `enabled: false` → env `""` = серверов нет |

Токен — **только** из Secret: backend получает его **файлом**
(`/etc/synth/executor/token`, `0400` → в env идёт путь, `SYNTH_EXECUTION_TOKEN`),
worker — **значением** в env (`SYNTH_EXECUTOR_TOKEN`, `secretKeyRef`). Secret и
ключ общие, поэтому токен совпадает на обеих сторонах; в ConfigMap/values —
никаких значений (инвариант 13). При `executor.enabled: false` рендер чарта
**побайтово не меняется**.

### 10.2. Образы

- `synth-backend` — control plane, **без** toolchain в split-режиме (сегодня образ и так его не
  содержит: `docker/Dockerfile.backend` — `FROM node:22-alpine`, `apk add` отсутствует).
- `synth-executor` — **новый** образ: toolchain + рантайм исполнителя. Содержимое toolchain'а —
  пересечение с flavor'ами PROP-082 (hard deps: `git`, `ripgrep`, `python3`, `openssh-client`,
  `ca-certificates`).
- **Один код — два режима:** образ исполнителя содержит тот же рантайм, что и inline-исполнитель в
  backend'е; различается только точка входа (слушает exec-API против вызова in-process).

### 10.3. CI

- Сборка и публикация образов — kaniko в джобе `build-docker`
  (`.gitverse/workflows/release.yaml`): отдельные шаги на `synth`, `synth-backend`, `synth-ui` и
  `synth-executor`; push в `gitverse.ru` + `ghcr.io`, `--push-retry=3`.
- **Что нужно изменить:** **registry-cache не включён** — при сборке образа с toolchain это критично
  (повторная установка пакетов на каждой сборке); **smoke-тестов образов нет** — для worker'а они
  обязательны (иначе сломанный toolchain едет в прод).
- **Квота реестра:** публикуются **только версионные теги** — на 0.9.0 вышло 607,4 МБ из лимита
  500 МБ (`.gitverse/workflows/release.yaml`). Четвёртый образ в тот же реестр — риск; worker'а
  имеет смысл публиковать в отдельный репозиторий (как flavor'ы в PROP-082) либо в Docker Hub.
- multi-arch: amd64 — kaniko, arm64 — buildx (`.gitverse/workflows/release.yaml`); Dockerfile'ы
  кросс-собираются без QEMU — в runtime-стадии нет ни одного `RUN`. Для
  worker'а с toolchain это ограничение сохраняется: **`apk add` в runtime-стадии сломает arm64-сборку
  без QEMU** — установку надо делать в builder-стадии (или принять QEMU).

---

## 11. Миграция между топологиями

### 11.1. all-in-one (`inline`) → split (`remote`)

1. **Подготовить хранилище.** Если состояние в JSON-файлах (`{dataDir}`) — перевести на PostgreSQL
   (`synth storage migrate --to postgres`, [ADR-097](./arch_decisions/adr-097-storage-provider-class.md)):
   файловое хранилище не масштабируется на несколько реплик backend'а
   (`charts/synth/values.yaml`).
2. **Подготовить общий том workspace** с RWX-классом: текущий PVC — RWO
   (`charts/synth/values.yaml`), RWX-варианта в чарте нет. Данные workspace **не мигрируют** —
   том подключается к прежнему каталогу (тот же `project.workspace`).
3. **Собрать и опубликовать образ `synth-executor`**; задеплоить пул (Deployment + Service) с
   ограниченным egress и без `docker.sock`.
4. **Выпустить токен** `synth_exec_…` в Secret; backend'у — адреса исполнителей.
5. **Переключить режим:** `execution.mode=remote` (config.yaml/env/CLI) → **рестарт** backend'а
   (переключатель — параметр запуска; рестарт — через graceful shutdown с exit 75,
   `packages/core/src/server/restart.ts`).
6. **Проверить:** exec-вызовы идут в исполнитель (по журналам и сериям
   `synth_executor_*` — шаг 7d), файлы в workspace те же, git-тулы работают (через `ExecutionPort`, шаг 5.2 плана этапа —
   ADR-077, SSH-материал `secrets[]`), MCP stdio (B1+B2) — тулы `{server}_{tool}` видны в сессии.

**Обратимо:** да — возврат `execution.mode=inline` + рестарт возвращает исполнение в процесс
backend'а. Данные не затронуты (workspace — тот же том, состояние — та же БД).

### 11.2. split (`remote`) → all-in-one (`inline`)

1. Остановить/смасштабировать в ноль пул worker'ов (или оставить — они просто простаивают).
2. `execution.mode=inline` → рестарт backend'а. Backend должен иметь toolchain в образе — то есть
   образ со **flavor'ом** (PROP-082), иначе `execute_shell`/`grep_files` в inline-режиме упрутся в
   детект зависимостей (ADR-078) и будут недоступны.

**Обратимо:** да. **Необратимо** на этом этапе — ничего: формат данных не меняется, миграции схемы не
нужны.

### 11.3. Что необратимо

На текущем этапе — **ничего**. Обратимость ломается только если дойти до workspace-v2/объектного
хранилища (шаг 11): перенос workspace в объектное хранилище — миграция данных с обратной
совместимостью (нужен dual-read/dual-write или явная миграция проекта).

---

## 12. Что уже есть и открытые вопросы

### 12.1. Что уже есть

| Факт | Где |
|---|---|
| Исполнение — в процессе backend/core, общего шва нет: `sh -c` (`execute_shell`), `rg` (`grep_files`), `git` (argv), `simple-git`, MCP stdio `spawn` | `packages/core/src/engine/tools/shell.ts:45`, `packages/core/src/engine/tools/search.ts:49`, `packages/core/src/engine/tools/git.ts:30`, `packages/core/src/git/git-service.ts:132`, `packages/core/src/engine/mcp/client.ts:169` |
| `execute_shell`: таймаут 30 с, `maxBuffer` 10 МБ, `env: { ...process.env, HOME: … \|\| '/root' }` (наследует весь process.env) | `packages/core/src/engine/tools/shell.ts:14`, `:51`, `:52` |
| Обрезка вывода: 100 КБ (shell), 20 КБ (git), 200 строк (rg) | `packages/core/src/engine/tools/shell.ts:13`, `packages/core/src/engine/tools/git.ts:16`, `packages/core/src/engine/tools/search.ts:57` |
| `git`: argv-массив без shell, `mergedEnv = { ...process.env, ...env }`, containment `resolveRepoCwd` (симлинки) | `packages/core/src/engine/tools/git.ts:29`, `:30`, `:52` |
| `simple-git`: env санитизируется (`sanitizeGitEnv` вырезает `git*` и blocklist `EDITOR`/`PAGER`/`SSH_ASKPASS`…), `GIT_TERMINAL_PROMPT=0` | `packages/core/src/git/git-service.ts:81`, `:107`, `:148` |
| MCP stdio: `StdioClientTransport`; SDK мержит `getDefaultEnvironment()` (whitelist HOME/PATH) | `packages/core/src/engine/mcp/client.ts:159`, `:169` |
| Детект бинарников `git`/`rg`/`sh`: `probeBinary` → `execFileAsync(bin, ['--version'], { timeout: 3000 })`; ENOENT → `false`, прочие ошибки → `true` (**fail-open**); кэш детекции — **по экземпляру порта** (`WeakMap`), не модульного уровня (после шага A: локальная проба inline не должна отравлять remote-кэш) | `packages/core/src/engine/tools/runtime-deps.ts:77`, `:79`, `:92` |
| Причины недоступности тула: `mode`/`role`/`dependency`/`workspace`/`storage`; порядок проверок storage→role→mode→dependency→workspace; `WORKSPACE_CAPABILITIES` | `packages/core/src/engine/permission/availability.ts:22`, `:28`, `:94`, `:147`, `:152` |
| При деградации хранилища доступны только `skill`/`web_fetch`/`web_search`, прочие — `unavailable(storage)` | `packages/core/src/engine/permission/availability.ts:54`, `:113` |
| Workspace: provisioning в backend'е — `resolveWorkspaceForLocalProject`, `validateManagedWorkspacePath`, `provisionManagedWorkspace` (атомарный `mkdir` без `recursive`), единая точка `provisionWorkspace` | `packages/core/src/engine/workspace-provision.ts:47`, `:109`, `:179`, `:207`, `:232` |
| `storage.workspacesRoot` и `defaultWorkspace` по умолчанию пустые | `packages/shared/src/config/defaults.ts:25`, `:26` |
| Образы: `node:22-alpine`, **ни одного `apk add`** → нет `git`/`rg`/`python`/`ssh`; в runtime-стадии standalone-образа нет ни одного `RUN`; `EXPOSE 4300`, `VOLUME ["/var/synth/data"]`; USER не задан (root) | `docker/Dockerfile:62`, `:91`, `:93`; `docker/Dockerfile.backend:48`; `docker/Dockerfile.ui:25`, `:56` |
| В образах backend'а/UI нет `EXPOSE`/`VOLUME`/`HEALTHCHECK`/`USER`; UI — nginx, root | `docker/Dockerfile.backend:48`, `:69`; `docker/Dockerfile.ui:25`, `:58` |
| Образ UI: адрес backend'а **из окружения** — nginx-конфиг стал шаблоном (`envsubst` официального образа) с фильтром `NGINX_ENVSUBST_FILTER=SYNTH_BACKEND_URL` (переменные nginx `$host`/`$remote_addr` не подменяются); дефолт образа `http://synth-backend:5000`, в чарте — Service backend'а текущего релиза (`ui.extraEnv.SYNTH_BACKEND_URL`) | `docker/Dockerfile.ui:40`, `:45`, `:54`; `docker/nginx-ui.conf.template:20`; `charts/synth/templates/ui-deployment.yaml:44`; `charts/synth/values.yaml:561` |
| CI: сборка образов kaniko (`gcr.io/kaniko-project/executor:v1.24.0`), три образа, push в `gitverse.ru` + `ghcr.io`, `--push-retry=3`; **registry-cache не включён**; **smoke-тестов нет** | `.gitverse/workflows/release.yaml:321`, `:378`, `:392`, `:407`, `:389` |
| Квота реестра: только версионные теги; на 0.9.0 вышло 607,4 МБ из 500 | `.gitverse/workflows/release.yaml:308` |
| Чарт: `backend.replicaCount: 1` («Хранилище JSON-файлы → НЕ масштабируется»), PVC `data` → `/var/synth/data`, `accessMode: ReadWriteOnce`; RWX-варианта для **workspace** не было до шага 7c | `charts/synth/values.yaml:16`, `:11`, `:45`; `charts/synth/templates/backend-pvc.yaml:16` |
| В чарте **нет** `Role`/`RoleBinding`, `ResourceQuota` — есть только ServiceAccount'ы; `NetworkPolicy` добавлен для пула исполнителей на шаге 7c | `charts/synth/templates/serviceaccount.yaml:1`; `charts/synth/templates/executor-networkpolicy.yaml:1` |
| Probes backend'а — оба `GET /health` (не `/ready`): деградация БД — штатный сценарий | `charts/synth/values.yaml:103`, `:107`, `:97` |
| `runAsUser: 1000`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`; UI — `fsGroup: 101` | `charts/synth/values.yaml:113`, `:115`, `:118`; `:503` |
| Секреты в чарте — только из Secret (`SYNTH_POSTGRES_PASSWORD`, `SYNTH_METRICS_TOKEN`, `SYNTH_BOOTSTRAP_SERVICE_KEYS`, `SYNTH_API_KEY`), в ConfigMap/values — никаких значений | `charts/synth/templates/backend-deployment.yaml:82`, `:100`, `:125`, `:137` |
| Наблюдаемость: реестр с лимитом 2000 серий, рендер 0.0.4, `/metrics` (404/401/`no-store`), `/health` + `/ready` | `packages/core/src/metrics/registry.ts:19`, `:27`; `packages/core/src/server/routes/metrics.ts:52`, `:56`, `:63`, `:82`; `packages/core/src/server/routes/health.ts:63`, `:65` |
| Метрики пула исполнителей: `synth_executor_queue_depth`/`_workers_busy`/`_wait_seconds`/`_commands_total` на стороне control plane (коллектор `createExecutorMetricsCollector`), `synth_executor_commands_total`/`_exec_duration_seconds`/`_inflight`/`_mcp_servers` — на исполнителе (его `/metrics`) | `packages/core/src/metrics/collectors/executor.ts:1`; `packages/core/src/execution/ports/execution-port.ts:259`; `packages/executor/src/metrics.ts:1`; `packages/executor/src/server.ts:483` |
| `synth_sessions_active` / `synth_queue_pending` — про сессии и очередь **сообщений**, не про исполнение | `packages/core/src/metrics/collectors/sessions.ts:26`, `:30` |
| Порт исполнения: `ExecutionPort` + `InlineExecutionPort` + контрактный suite (шаг 1) | `packages/core/src/execution/ports/execution-port.ts:1`, `packages/core/src/execution/inline-execution-port.ts:1`, `packages/core/src/execution/contract/execution.ts:1` |
| Секция `execution` в конфиге, env `SYNTH_EXECUTION_*`, CLI `--execution-mode`, fail-closed на старте (шаг 3) | `packages/shared/src/config/execution.ts:1`, `packages/shared/src/config/types.ts:178`, `packages/shared/src/config/defaults.ts:32`, `packages/core/src/execution/startup.ts:1`, `packages/core/src/main.ts:110` |
| `RemoteExecutionPort`, пакет `@itphx/synth-executor`, exec-API (`/exec`, `/capabilities`, `/health`), токен `synth_exec_…` (backend — файлом, worker — значением) и чарт split-развёртывания (`executor.*`) — **реализованы** (шаги 7a–7c); **MCP-stdio** — **реализовано**: исполнитель хостит серверы (`SYNTH_EXECUTOR_MCP_SERVERS`, `/mcp/servers`, `/mcp/tools`, `/mcp/call` — эндпоинты протокола 2), control plane подключён (`ExecutorMcpSource`; **актуальная версия протокола — 4**: секреты вызова `secrets[]`, ADR-077 «Обновлено 2026-10-26», (б)); осталось: образ worker'а и flavor'ы — [PROP-082](./arch_decisions/prop-082-full-images-deployment.md) (шаги 4–6); git через `ExecutionPort` вместо `simple-git` — **выполнено**; **метрики `synth_executor_*` + `/metrics` исполнителя + алерты + runbook — выполнено** (шаг 7d) | `packages/core/src/execution/remote.ts:1`, `packages/executor/src/protocol.ts:1`, `packages/executor/src/mcp.ts:1`, `packages/executor/src/secrets.ts:1`, `packages/core/src/engine/mcp/executor-mcp-source.ts:1`, `packages/core/src/metrics/collectors/executor.ts:1`, `packages/executor/src/metrics.ts:1`, `charts/synth/templates/executor-deployment.yaml:1` |
| Слой хранения — образец портов: 30 доменных портов, контрактный suite, `createFileStorage`/`createMemoryStorage`/`createPostgresStorage`/`createStorageContextAsync`/`buildStorageContext` | `packages/core/src/storage/ports/`, `packages/core/src/storage/contract/index.ts:1`, `packages/core/src/storage/storage-context.ts:467`, `:529`, `:599`, `:847`, `:917` |
| Ограничения >1 реплики: файловая БД не масштабируется; RWO PVC; `FileMutex` (эксклюзивный `mkdir` + stale-takeover) работает только на общем FS; `scheduler.leaderElection: none`, `crossProcessLocks: false` (в PG — `PgMutex`/`PgLeader`) | `charts/synth/values.yaml:11`, `:45`; `packages/core/src/storage/file-mutex.ts:33`, `:48`; `packages/core/src/storage/mutex.ts:7`; `packages/shared/src/config/defaults.ts:155` |
| Рестарт инстанса — graceful shutdown с exit code 75, режимы `disabled`/`process`/`supervisor` | `packages/core/src/server/restart.ts:20`, `:23`; `packages/core/src/main.ts:81` |
| Общий транспорт исходящих вызовов — `egressFetch` (ADR-099): единый источник доверия TLS/CA | `packages/core/src/security/tls.ts:302` |
| Формат service-key: `synth_svc_…` (префикс константой) — образец для токена исполнителя | `packages/core/src/storage/service-api-key-store.ts:19` |
| Локальные режимы: `dev.sh` — `SYNTH_RESTART_MODE=supervisor`, `SYNTH_DATA_DIR`, порты 5000/4300/5002, `SYNTH_CONFIG=packages/backend/config.yaml`; `standalone.sh` — порт 4400, host 127.0.0.1 | `scripts/dev.sh:30`, `:39`, `:46`, `:50`; `scripts/standalone.sh:74` |
| `docker-compose.yml` — только standalone-образ `synth` (+ профили `ollama`, `postgres`); backend и UI в compose не разведены | `docker-compose.yml:21`, `:91`, `:114` |
| S3/объектного хранилища нет | — |
| Корневого `config.yaml` в репозитории нет; есть `packages/backend/config.yaml` (`mcp.servers`, `llm.default*`, `storage.backend: postgres`, `storage.degradedMode: halt`) | `packages/backend/config.yaml` |

### 12.2. Дельта (что нужно сделать)

1. **Порт исполнения** в core: `ExecutionPort` / `ExecRequest` / `ExecResult`, реализации
   `InlineExecutionPort` и удалённой; контрактный suite на обе (по образцу
   `packages/core/src/storage/contract/index.ts`). — **сделано**
2. **Рефакторинг 5+ точек исполнения** на порт без изменения поведения: `shell.ts`, `search.ts`,
   `git.ts`, `inline-shell.ts`, `runtime-deps.ts`. — **сделано**
3. **Секция `execution` в конфиге** (`packages/shared/src/config/types.ts` + `defaults.ts` +
   `env-overrides.ts`): `mode`, `remote.url`, `remote.timeoutMs`, `remote.concurrency`,
   `remote.failMode`, `remote.tokenSecret`; env `SYNTH_EXECUTION_*`; CLI `--execution-mode`;
   fail-closed на неизвестном `mode`. — **сделано**
4. **Executor-сервис**: отдельный in-tree пакет `@itphx/synth-executor`
   (`packages/executor`, по образцу драйвера хранилища — ADR-097/ADR-096) с
   exec-API (HTTP/1.1 + JSON: `/exec`, `/capabilities`, `/health`), тем же рантаймом,
   что и inline; клиент удалённого порта — через `egressFetch` (ADR-099), bearer
   `synth_exec_…`, опционально mTLS; containment `cwd` — на стороне исполнителя. — **сделано**
5. **Токен исполнителя**: формат `synth_exec_…`, хранение — Secret/файл (инвариант 13), выдача —
   через существующий контур секретов; в UI — write-only (по образцу `SYNTH_METRICS_TOKEN`). —
   **сделано** (чтение из файла по `execution.remote.tokenSecret`)
6. **Образ `synth-executor`**: новый Dockerfile с toolchain'ом (пересечение с flavor'ами PROP-082);
   arm64-сборка без QEMU (установка пакетов — в builder-стадии). — **остаток**
7. **CI**: шаг сборки `synth-executor`, registry-cache, smoke-тест образа worker'а; решение по
   реестру (квота 500 МБ) — отдельный репозиторий или Docker Hub. — **остаток**
8. **Чарт**: значения `execution.*` и `executor.*`; шаблоны `executor-deployment.yaml`,
   `executor-service.yaml`, PVC общего workspace (RWX), `NetworkPolicy` для worker'а, токен из
   Secret; `executor.enabled` — переключатель split-развёртывания. — **реализовано (шаг 7c)**
9. **Наблюдаемость**: метрики `synth_executor_queue_depth`, `synth_executor_workers_busy`,
   `synth_executor_wait_seconds` и `synth_executor_commands_total{outcome}` (control plane) +
   `synth_executor_commands_total{outcome}`, `synth_executor_exec_duration_seconds`,
   `synth_executor_inflight`, `synth_executor_mcp_servers{status}` (исполнитель); `/metrics`
   исполнителя (`SYNTH_EXECUTOR_METRICS_ENABLED`, выключен по умолчанию); скрейп пула отдельным
   job'ом; алерты в `charts/synth/files/alerts/` (группа `synth-executor`). —
   **сделано** (шаг 7d; серии двух сторон **не суммируются** — см. §9)
10. **Детект зависимостей (ADR-078)** в split-режиме — спрашивать исполнителя, а не локальный
     `execFile` (иначе backend считает `git`/`rg` доступными там, где их нет). — **остаток**
11. **Миграции**: `synth storage migrate --to postgres` (уже есть) + процедура переключения
     топологии в `docs/MAINTENANCE.md`; миграции схемы БД для порта исполнения не требуются (состояние
     исполнителя эфемерно). — **остаток** (runbook)
12. **Документация**: `docs/CONFIGURATION.md` (секция `execution`), `docs/API_V2.md` (если exec-API
     станет публичным — не планируется), `docs/OBSERVABILITY.md` (новые метрики), `charts/synth/README.md`
     (примеры split-развёртывания), `docs/TROUBLESHOOTING.md` (исполнитель недоступен). — **частично**
13. **Перенос MCP stdio в исполнитель (шаг 9/B1+B2)**: исполнитель поднимает MCP-серверы у себя
     (`SYNTH_EXECUTOR_MCP_SERVERS`), отдаёт инструменты и вызовы по HTTP (`/mcp/servers`,
     `/mcp/tools`, `/mcp/call`; эндпоинты протокола 2), а control plane к ним подключён
     (`ExecutorMcpSource` + `attachExecutorMcpSource`, тулы `{serverName}_{toolName}`, e2e на живом
     исполнителе). — **сделано (B1+B2)**; остаток шага 9 — `inline-shell`
14. **Git через порт вместо `simple-git`**: git-операции control plane — argv через существующий
     `ExecutionPort` (`requires: ['git']`), публичный API `GitService` сохраняется, пакет
      `simple-git` удалён из core; SSH-ключи — аддитивное поле `secrets[]` в `POST /exec`
      (протокол 4): значение ключа → материализация в tmp исполнителя (`mkdtemp`, 0700/0600),
      удаление в `finally` + sweep `synth-ssh-*` при старте; CA — конфигурация исполнителя
      (`SYNTH_EXECUTOR_TLS_CA_FILE` → `GIT_CONFIG_*`), не поле протокола. — **сделано**
      (ADR-077, «Обновлено 2026-10-26», (а)/(б)/(в))

### 12.3. Порядок реализации

План **общий с [PROP-082](./arch_decisions/prop-082-full-images-deployment.md)** — нумерация шагов единая;
владелец шага указан в таблице.

| Шаг | Содержание | Владелец | Зависимость от PostgreSQL |
|---|---|---|---|
| **1** | Порт исполнения `ExecutionPort` + `InlineExecutionPort`: вынести 5+ точек исполнения за порт **без изменения поведения**; контрактный suite | общий | не нужна |
| **2** | Multistage Dockerfile + distro-aware скрипты тиров + flavor `core` → all-in-one образ `synth-backend:<v>-core` | PROP-082 | не нужна |
| **3** | Секция `execution` в конфиге (`mode`, `remote.*`), env `SYNTH_EXECUTION_*`, CLI `--execution-mode`, fail-closed на неизвестном `mode` | общий | не нужна |
| **4** | Flavor'ы `dev`/`devops` (alpine-ветка) | PROP-082 | не нужна |
| **5** | Flavor'ы `browser`/`full` (debian-ветка, Playwright) + образ worker'а `synth-executor:<v>-<flavor>` | PROP-082 | не нужна |
| **6** | CI: публикация (лёгкие образы — `gitverse.ru`/`ghcr.io`, тяжёлые — Docker Hub), registry-cache, smoke-тесты на каждый flavor, `scripts/docker-cleanup.mjs` под новые репозитории | PROP-082 | не нужна |
| **7a** | Executor-сервис: пакет `@itphx/synth-executor` (`packages/executor`, по образцу драйвера хранилища — ADR-097/ADR-096) с exec-API (HTTP/1.1 + JSON: `/exec`, `/capabilities`, `/health`, containment `cwd`, токен `synth_exec_…`) + клиент удалённого порта (`egressFetch`, ADR-099) + прогон контрактного suite порта против исполнителя (в core, `packages/core/src/execution/contract/`) | ADR-077 | не нужна |
| **7b** | Подключение по `execution.mode=remote`: динамический `import()` пакета (fail-closed), `execution.remote.failMode`/`concurrency`, пул адресов (выбор по кругу, проба следующего при ошибке соединения) | ADR-077 | не нужна (нужна для >1 реплики control plane) |
| **7c** | Helm: значения `executor.*` (Deployment/Service/пул), RWX-том общего workspace, токен — из Secret, `NetworkPolicy` для worker'а; **фаза 1** матрицы (`execute_shell`/`grep_files`/`python`) | ADR-077 | не нужна |
| **7d** | Метрики `synth_executor_*` + `/metrics` исполнителя + runbook (переключение топологии, диагностика «исполнитель недоступен») — **реализовано** (серии control plane и исполнителя, скрейп пула, алерты `synth-executor`, runbook в `docs/MAINTENANCE.md`) | ADR-077 | не нужна |
| **8** | **Фаза 2** матрицы: git-тулы + доставка SSH-материала в исполнителя. Решение — ADR-077 («Обновлено 2026-10-26»): git через `ExecutionPort` (`requires: ['git']`, без новых git-эндпоинтов), SSH — `secrets[]` в `POST /exec` (протокол 4). **Реализовано** (шаг 5.2 этапа 0.13.0) | ADR-077 | не нужна |
| **9** | **Фаза 3** матрицы: MCP stdio-серверы и inline-shell. **B1+B2 — сделано**: исполнитель хостит MCP-серверы (`SYNTH_EXECUTOR_MCP_SERVERS`, `/mcp/*`, эндпоинты протокола 2), control plane подключён (`ExecutorMcpSource`, тулы `{serverName}_{toolName}`, e2e); остаток — `inline-shell` | ADR-077 | не нужна |
| **10** | Изоляция и квоты (`NetworkPolicy`, `ResourceQuota`/`LimitRange`, лимиты worker'а, без `docker.sock`); детект зависимостей (ADR-078) на стороне исполнителя. Наблюдаемость (метрики `synth_executor_*`, `/metrics` исполнителя, алерты) — **сделано** (шаг 7d); остаток — квоты (`ResourceQuota`/`LimitRange`) | ADR-077 | не нужна |
| **11** | Workspace-v2: per-worker копия или S3-совместимое объектное хранилище (снимает «один RWX-том на всех») | ADR-077 | желательна |
| **12** | Миграции и документация: переключение топологии (runbook — `docs/MAINTENANCE.md`), секция `execution` в `docs/CONFIGURATION.md`, метрики в `docs/OBSERVABILITY.md`, примеры в `charts/synth/README.md`, диагностика в `docs/TROUBLESHOOTING.md`; compose-сценарии all-in-one/split | общий | не нужна |

Шаги 1–3 и 6 не требуют PostgreSQL и могут идти до перехода на БД; подшаг **7b** — первый,
где PG нужна для полного эффекта (несколько реплик control plane); шаги 1, 2, 3, 4, 5, 6, 7a, 7c,
7d, 10, 12 от PG не зависят. Шаги 8–12 идут после 7a–7d: 8 и 9 — фазы 2 и 3 матрицы, 10 —
изоляция/квоты и наблюдаемость, 11 — workspace-v2, 12 — миграции и документация.

Split-топология технически возможна и при одной реплике control plane (пул worker'ов масштабируется независимо); PostgreSQL обязателен для масштабирования самого control plane — больше одной реплики.

### 12.4. Открытые вопросы

**Сделано** (не открытые вопросы, а выполненная работа — детали в §12.2 «Дельта» и §4.2.2):

- **Доставка SSH-материала и CA в исполнитель** (фаза 2) — **реализовано**: приватные ключи
  проектов едут **на время вызова** полем `secrets[]` в `POST /exec` (протокол 4) и
  материализуются в tmp исполнителя (`mkdtemp` `synth-ssh-*`, каталог 0700/ключ 0600, удаление в
  `finally` + sweep `synth-ssh-*` при старте) — без общего Secret-тома и без мастер-ключа в
  исполнителе; CA — **конфигурация** исполнителя (`SYNTH_EXECUTOR_TLS_CA_FILE` →
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`), применяется при старте (ADR-099),
  а `gitCaConfig()` control plane в remote-режиме не применяется. Старый исполнитель (протокол
  < 4) → fail-closed `ESECRETS`: команда без ключа не выполняется.

**Закрыто решениями выше** (не открытые):

- Переключатель топологий — закрыт: `execution.mode`, параметр запуска, дефолт `inline`.
- Способ размещения в K8s — закрыт: статический пул Deployment + очередь в backend (вариант (а));
  (б) и (в) — эволюция.
- Матрица «что уезжает» по фазам — закрыта (1: shell/rg/python; 2: git+SSH; 3: MCP stdio/inline-shell);
  FS-роуты, provisioning, git-реестр, хранение, LLM-вызовы, permission-слой — не уезжают.
- Поведение при недоступности исполнителя — закрыто: `failMode: fail` (fail-closed) по умолчанию;
  `inline-fallback` — только явной настройкой.

**Реально открытые:**

- **Per-worker workspace против общего.** Общий том (RWX) — просто, но даёт всем исполнителям доступ
  ко всем workspace'ам проектов (ограничение — «исполнитель не видит чужих workspace» перестаёт
  работать на уровне тома; остаётся на уровне `cwd`). Per-worker копия — изоляция, но рассинхрон и
  стоимость. Связано с workspace-v2/объектным хранилищем (шаг 11).
- **HA пула.** Статический пул: что происходит при недоступности **всех** worker'ов (fail-closed →
  инструменты недоступны)? Нужен ли circuit breaker с автоматическим переходом в `inline-fallback`?
  Сейчас переход только явной настройкой — это осознанно (fail-closed), но требует runbook'а.
- **Образ worker'а: отдельный или общий с backend'ом.** Отдельный (`synth-executor`) даёт чистое
  разделение секретов и меньший образ control plane; общий (один образ, разные роли через env) —
  проще CI и не нужен четвёртый образ в реестре (квота 500 МБ). Нужно решение до шага 5 (образ
  worker'а `synth-executor:<v>-<flavor>`).
- **Взаимодействие с ADR-113** (реестр фоновых процессов). `execute_shell { background: true }` и
  пул исполнителей — один и тот же механизм исполнения; реестр процессов должен быть общим (иначе
  фоновая команда «уедет» в worker'а, а UI-реестр останется в backend'е).
- **Стоимость и квоты.** Кто платит за worker'ов (node pool, диск под workspace, квоты namespace)?
  Нужны ли `ResourceQuota`/`LimitRange` в namespace'е и кто их администрирует.
- **Отмена exec-вызовов при рестарте backend'а.** Сейчас вызовы обрываются; нужен ли endpoint отмены
  на исполнителе, чтобы команда не «работала вхолостую» после рестарта control plane.
- **Секьюрность multi-tenancy пула.** Если пул общий для нескольких проектов/пользователей — нужен
  ли per-tenant лимит и учёт в метриках (лейблы `tenant`/`project` в ADR-094 **запрещены** для
  session_id/user_id — как считать квоты без лейблов).

---

## Связи

- [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md) «Инструментальное окружение исполнения» — решение:
  порт `ExecutionPort`, режим `remote`, fail-closed.
- [ADR-096](./arch_decisions/adr-096-storage-layer.md) «Единый слой хранения» — образец доменного порта.
- [ADR-097](./arch_decisions/adr-097-storage-provider-class.md) «Класс расширения «хранилище»» — образец
  контрактного suite и optional-пакета с динамическим `import()`.
- [ADR-099](./arch_decisions/adr-099-egress-tls-trust.md) «Единый egress-слой» — доверие к исполнителю, транспорт.
- [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md) «Обслуживание инстанса» — рестарт (exit 75).
- [ADR-094](./arch_decisions/adr-094-observability-metrics.md) «Наблюдаемость» — контракт имён метрик.
- [ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md) «Окружение проекта» — provisioning остаётся в backend'е.
- [ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и доступ (SSH)» — фаза 2.
- [ADR-078](./arch_decisions/adr-078-runtime-dependency-availability.md) «Авто-отключение инструментов» — детект на стороне исполнителя.
- [ADR-071](./arch_decisions/adr-071-mcp-servers-prompt.md) «MCP» — MCP-реестр остаётся в control plane.
- [ADR-036](./arch_decisions/adr-036-llm-gateway.md) «LLM Gateway» — в исполнителе LLM-ключей нет.
- [ADR-038](./arch_decisions/adr-038-npm-packages.md) «Монорепо как набор npm-пакетов» — сборка/публикация.
- [ADR-023](./arch_decisions/adr-023-configuration.md) «Конфигурация» — приоритет CLI > env > config.yaml > defaults.
- [ADR-052](./arch_decisions/adr-052-public-api-platform.md) «Публичная API-платформа» — образец машинных ключей.
- [PROP-082](./arch_decisions/prop-082-full-images-deployment.md) «Full-образы и базовое развёртывание» — all-in-one топология и состав образов.
- [ADR-113](./arch_decisions/adr-113-background-processes.md) «Фоновые процессы» — общий реестр фоновых процессов.
- [PROP-049](./arch_decisions/prop-049-git-worktrees.md) «Git worktrees» — персональный cwd как будущая единица работы на исполнителе.
- [PROP-080](./arch_decisions/prop-080-managed-hybrid-modes.md) / [PROP-081](./arch_decisions/prop-081-hybrid-policy-leak-protection.md) — гибрид: где исполняется local vs managed.
- [PROP-064](./arch_decisions/prop-064-ui-browser-terminal.md) «UI-терминал» — PTY/attach вне объёма.
- [PROP-050](./arch_decisions/prop-050-external-engines-runner.md) «Внешние движки» — прецедент отдельного исполняющего сервиса.
- [docs/CONFIGURATION.md](./CONFIGURATION.md) — конфигурация (секция `execution`).
- [docs/OBSERVABILITY.md](./OBSERVABILITY.md) — каталог метрик (`synth_executor_*`).
- [docs/PUBLISHING.md](./PUBLISHING.md) — сборка Docker/Helm.
- [docs/MAINTENANCE.md](./MAINTENANCE.md) — runbook (процедура переключения топологии).

## История

- 2026-10-21 — переработано: split-топология (control plane + отдельные контейнеры-исполнители) как предмет
  ADR-077, единый переключатель `execution.mode`, порт `ExecutionPort`, all-in-one вынесен в PROP-082;
  упаковка исполнителя — отдельный in-tree пакет `@itphx/synth-executor` по образцу слоя хранения
  (ADR-097), транспорт — HTTP/1.1 + JSON (exec-API `/exec`/`/capabilities`/`/health`), containment `cwd` —
  на исполнителе; шаг 7 разбит на 7a–7d.
- 2026-10-21 — шаги 1, 3, 7a, 7b: порт исполнения (union shell/argv, типизированная `ExecutionError`,
  inline-реализация + контрактный suite), секция `execution` в конфиге (fail-closed), пакет исполнителя
  (exec-API, containment `cwd`, клиент удалённого порта `./client`), подключение по `execution.mode=remote`
  (динамический `import()`, чтение токена из файла, стартовая проверка режима).
- 2026-10-22 — шаг 7c: чарт split-развёртывания (значения `execution.*`/`executor.*`, шаблоны
  `executor-deployment.yaml`/`executor-service.yaml`/`executor-pvc.yaml`/`executor-networkpolicy.yaml`,
  общий том workspace (RWX) в backend и в пуле, токен из Secret — backend файлом, worker значением,
  fail-closed проверки рендера; при `executor.enabled: false` рендер не меняется); документ переведён в
  класс **Spec** — решение в ADR-077, детали здесь.
- 2026-10-26 — снято расхождение с кодом: MCP-stdio **реализовано целиком** (B1+B2, эндпоинты `/mcp/*`
  с протокола 2, актуальная версия протокола — 3), «остатка B2» больше нет; §9 помечает серию
  `synth_executor_*` и `/metrics` исполнителя как **план** (шаг 7d); SSH/CA приведены к решению
  ADR-077 («Обновлено 2026-10-26»): ключи — `secrets[]` на время вызова (протокол 4), CA — конфигурация
  исполнителя; git вынесен в отдельный шаг (5.2 плана этапа) — ADR-077 (а).
- 2026-10-26 — **фаза 2 закрыта**: протокол **4** (`secrets[]` в `POST /exec`, `features.secrets`),
  материализация секрета на исполнителе (`mkdtemp` 0700/ключ 0600, удаление в `finally` + sweep
  `synth-ssh-*` при старте), CA исполнителя (`SYNTH_EXECUTOR_TLS_CA_FILE` → `GIT_CONFIG_*`),
  fail-closed `ESECRETS` для старого исполнителя и для фоновых процессов; §4.2.2 — раздел
  «Секреты вызова и доверие git».
- 2026-10-26 — **шаг 7d закрыт**: §9 переведён из «план» в «реализовано» — метрики control plane
  (`synth_executor_queue_depth`/`_workers_busy`/`_wait_seconds`/`_commands_total`) и исполнителя
  (`_commands_total`/`_exec_duration_seconds`/`_inflight`/`_mcp_servers`), собственный `/metrics`
  исполнителя (`SYNTH_EXECUTOR_METRICS_ENABLED`, выключен по умолчанию), скрейп пула отдельным job'ом
  (`executor.networkPolicy.metricsIngress`), алерты `synth-executor`; значения чарта
  `executor.metrics.enabled` и `executor.networkPolicy.metricsIngress`. Серии двух сторон
  **не суммируются** (`commands_total` считает разное) — различать по `job`.
