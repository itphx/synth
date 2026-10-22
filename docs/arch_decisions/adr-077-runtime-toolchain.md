# ADR-077: Инструментальное окружение исполнения — единый порт ExecutionPort и режим remote

> **Статус:** ⚠️ Частично — реализованы порт `ExecutionPort` с реализациями inline/remote, выбор режима через `execution.mode`, динамический `import()` пакета `@itphx/synth-executor/client`, fail-closed проверка на старте, чарт split-развёртывания (значения `execution.*`/`executor.*`, шаблоны `executor-*.yaml`, общий том workspace, `NetworkPolicy` пула), **шаг A** — доступность инструментов в remote-режиме определяется составом пула исполнителей (инвентарь `GET /capabilities`, `ExecRequest.requires`, `probe()` у порта, причина `dependency_missing`) и **шаг B1** — исполнитель **хостит MCP-серверы у себя** (stdio) и отдаёт их инструменты и вызовы по HTTP (`GET /mcp/servers`, `GET /mcp/tools`, `POST /mcp/call`; протокол версии 2); остаток — клиентская проводка в control plane (шаг B2), метрики `synth_executor_*` и runbook (шаг 7d) и перенос `simple-git` в исполнитель (шаг 8).
> **Дата:** 2026-10-21
> **Связано:** [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md) (образец портов и контрактного suite), [ADR-099](./adr-099-egress-tls-trust.md) (доверенная граница и исходящий транспорт), [ADR-092](./adr-092-instance-lifecycle-maintenance.md) (рестарт, exit 75), [ADR-094](./adr-094-observability-metrics.md) (метрики), [ADR-075](./adr-075-project-workspace-provisioning.md) (workspace), [ADR-076](./adr-076-git-repo-registry-ssh.md) (git-реестр и SSH), [ADR-078](./adr-078-runtime-dependency-availability.md) (детект зависимостей), [ADR-036](./adr-036-llm-gateway.md) (в исполнителе LLM-ключей нет), [ADR-038](./adr-038-npm-packages.md) (поставка пакета); детали и формат — [docs/EXECUTION.md](../EXECUTION.md) (Spec).

## Контекст

Агентские команды исполнялись прямо в процессе backend'а: `sh -c` (`execute_shell`), `rg` (`grep_files`), `git` (argv), `simple-git`, `spawn` MCP-stdio. Шва не было — у каждой точки исполнения своя реализация, поэтому «вынести toolchain в отдельный контейнер» означало бы переписывать точки исполнения по одной. Control plane и инструментальное окружение были сварены в один процесс: образ без toolchain'а не мог исполнять shell, а образ с toolchain'ом нёс в control plane лишние секреты и поверхность.

Нужен был шов уровня порта (как порты слоя хранения) и решение, где живёт исполнитель. Решение не могло быть runtime-настройкой: смена режима затрагивает process-глобальные решения (инвариант 24 корневого `AGENTS.md`).

## Решение

1. **Единый порт исполнения `ExecutionPort`** (`packages/core/src/execution/ports/execution-port.ts`) — одна
   точка исполнения агентских команд: `execute(req: ExecRequest): Promise<ExecResult>`. Запрос — дискриминированный
   union (`shell` — `sh -c <команда>`; `argv` — бинарник без shell), ошибка — типизированная
   `ExecutionError` (`reason`: `timeout`/`aborted`/`spawn_failed`/`nonzero_exit`/`max_output`), лимит буфера —
   `DEFAULT_MAX_OUTPUT_BYTES` (10 МБ).
2. **Две взаимозаменяемые реализации.** `InlineExecutionPort` — исполнение в процессе control plane (прежнее
   поведение). Удалённая — HTTP/1.1 + JSON к исполнителю: exec-API `/exec`, `/capabilities`, `/health`,
   протокол `EXECUTOR_PROTOCOL_VERSION = 2` (было 1 — с шагом B1 добавлены MCP-эндпоинты), bearer-токен
   `synth_exec_…` **из файла** (`execution.remote.tokenSecret` — путь, не значение; инвариант 13).
   Исполнитель поставляется отдельным in-tree пакетом
   `@itphx/synth-executor` (`packages/executor`), который core подключает **динамическим `import()`**
   (`@itphx/synth-executor/client`) — по образцу драйвера хранилища (ADR-097).
3. **Выбор реализации — параметр запуска `execution.mode`** (`inline` — дефолт, `remote` — split). Топология —
   один параметр, а не runtime-настройка: смена — только рестартом процесса (ADR-092, инвариант 24).
4. **Fail-closed.** Запрошен `remote`, а пакет исполнителя недоступен / токен не читается / список адресов пуст —
   **старт прерывается**, а не тихий откат в `inline`: тихий откат означал бы, что оператор запросил изоляцию
   control plane от toolchain'а, а получил локальное исполнение.
5. **Доверенная граница backend → исполнитель** — по ADR-099: исходящие вызовы через общий транспорт
   (`egressFetch`), TLS/CA — из секции `security.tls`, containment `cwd` проверяет **исполнитель**, в исполнителе
   нет LLM-ключей, OIDC-секретов и чужих workspace.
6. **Шов внедрения** — `ctx.extra.executionPort` (`packages/core/src/execution/tool-port.ts`): порт кладёт
   оркестратор, тулы и не-туловые точки (резолвер проектных инструкций, детект зависимостей, inline-shell) берут
   **тот же** порт через композицию.
7. **Несколько реплик control plane — sticky-сессии как текущий компромисс.** Шина событий Synth —
   **in-process** (`packages/core/src/events/bus.ts`): событие, опубликованное в реплике A, не доходит
   до WS/SSE-клиента, подключённого к реплике B, поэтому при `backend.replicaCount > 1` чат и стримы
   ломаются. Дёшевое лечение — прибить клиента к реплике: `sessionAffinity: ClientIP` на Service
   control plane (`backend.service.sessionAffinity` в чарте). Это компромисс: sticky по IP делит под
   между пользователями за одним NAT и перебрасывает клиента при смене IP. Полноценное решение —
   **внешний транспорт событий** (общая шина между репликами вместо in-process) — отдельная задача;
   sticky-сессии её не заменяют, а лишь делают multireplica control plane безопасным на текущем этапе.
8. **Доступность инструмента в remote-режиме определяется составом пула (шаг A).** «Есть ли программа»
   — вопрос не про control plane, а про то окружение, где команда будет выполнена. Поэтому:
   - **Порт** получил необязательные `probe(bin, args?)` и `capabilitySummary(bin)`, а запрос —
     `requires?: string[]` — бинарные требования команды. Словарь базовых возможностей — общий для обеих
     сторон: `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`) в core; исполнитель отдаёт **тот же**
     словарь в `GET /capabilities`.
   - **Инвентарь пула** — карта «адрес → множество программ», собранная удалённым портом по
     `GET /capabilities` **всех** адресов (TTL `REMOTE_CAPABILITIES_TTL_MS = 120_000`, обновление
     **ленивое** — перед пробой/маршрутизацией, если снимок просрочен).
   - **Маршрутизация по требованиям:** команда с `requires` уходит в адрес, чей инвентарь покрывает все
     требуемые бинари. Адрес **без** нужного бинаря и адрес, **не ответивший** на `/capabilities`, в
     маршрутизации не участвуют (состав неизвестен — fail-closed); подходящего адреса нет —
     различимая ошибка `dependency_missing` (`EDEPENDENCY`) с текстом «в пуле: N из M».
   - **Слой доступности (ADR-078) спрашивает порт**, а не пробует локально: `probe()` отвечает по
     инвентарю пула. Порт без `probe` (inline) проверяется локальной пробой `bin --version` —
     `packages/core/src/execution/probe.ts`, **единственная** реализация пробы: `ENOENT` → программы нет,
     прочие ошибки → fail-open (неоднозначная ошибка не блокирует инструмент).
   - **Кэш детекции — по экземпляру порта** (`WeakMap`): локальная (inline) проба больше не отравляет
     remote-кэш — иначе control plane считал бы доступным бинарь, которого нет ни у одного исполнителя.
   - **Inline-режим не изменился**: те же локальная проба и дефолты, порт игнорирует `requires`.
9. **MCP-серверы хостит исполнитель, а не control plane (шаг B1).** В split-топологии control plane
   тонкий (в образе `synth-backend` нет Chromium и tier-4 MCP-серверов), а браузерные инструменты
   агенту нужны. Значит и **хостить** их должен исполнитель — у него toolchain и Chromium:
   - **Конфигурация — env исполнителя** `SYNTH_EXECUTOR_MCP_SERVERS`: JSON-массив описаний
     `[{"name":"playwright-mcp","command":"playwright-mcp","args":["--no-sandbox"],"env":{}}]`.
     Разбор **строгий**: невалидный JSON или запись — **fail-closed при старте** (иначе оператор
     считал бы серверы поднятыми, а они не поднялись). `env` сервера может содержать токены —
     они не логируются, не отдаются в ответах, вычищаются из текстов ошибок; сама переменная
     убирается из `process.env` после разбора (иначе токены утекли бы в окружение агентских команд).
   - **MCP-клиент — тот же SDK и те же лимиты, что в core** (`@modelcontextprotocol/sdk`,
     `StdioClientTransport`): connect 60 c, вызов 120 c, усечение результата до 30 000 символов,
     circuit breaker (5 ошибок → 60 c). Свой MCP-клиент не пишется — иначе handshake и разбор
     результатов разойдутся с core.
   - **Жизненный цикл — ленивый:** сервер поднимается при первом обращении (`GET /mcp/tools` —
     все серверы, `POST /mcp/call` — нужный). Неудачный старт не ломает исполнитель: сервер
     получает статус `down` с причиной, следующее обращение его переподнимает; при остановке
     исполнителя MCP-серверы закрываются (дочерние процессы, включая Chromium, не остаются жить).
   - **Поверхность HTTP (протокол 2):** `GET /mcp/servers` → `[{name, status, toolCount, error?}]`,
     `GET /mcp/tools` → `[{server, name, description, inputSchema}]`, `POST /mcp/call`
     `{server, tool, arguments}` → `{content, isError}`; неизвестный сервер/инструмент → `404`,
     ошибка MCP → `500` с текстом ошибки. Всё — **под тем же bearer-токеном**, что и остальные
     эндпоинты исполнителя.
   - **Граница шага:** B1 — **серверная** часть. Клиентская проводка в control plane (транспорт
     MCP-исполнителя, регистрация тулов с префиксом `{serverName}_{toolName}`, e2e в кластере) —
     **шаг B2**.
   - **Фактическая проверка в контейнере** (образ `synth-executor`, flavor `full`, Playwright MCP
     0.0.83 + Chromium 1247 / Chrome for Testing 155.0.8059.12):
     аргументы `--headless --no-sandbox --executable-path /opt/synth/browser/chrome` — рабочие:
     `GET /mcp/servers` → `{"name":"playwright-mcp","status":"up","toolCount":25}`,
     `POST /mcp/call` `browser_navigate` на `data:text/html,…` → `isError:false`, `browser_evaluate` →
     отрендеренный DOM и `HeadlessChrome/155`. Без `--executable-path` сервер падает:
     `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome` — Chrome в образе нет,
     браузеры лежат в `PLAYWRIGHT_BROWSERS_PATH` (`/opt/ms-playwright`); флага `--browser chromium`
     **не существует** (`--browser` = `chrome|firefox|webkit|msedge`). Версионный путь
     (`/opt/ms-playwright/chromium-1247/chrome-linux64/chrome`, именно `chrome-linux64`) в конфигурации
     не хардкодится: tier 3 создаёт стабильный симлинк `/opt/synth/browser/chrome` резолвом по glob.
     `--no-sandbox` обязателен, т.к. контейнер по умолчанию под root (uid 0); `--headless` — дисплея нет.
     Ленивый старт подтверждён: сразу после старта `status:"idle", toolCount:0`, `GET /mcp/tools`
     поднимает сервер (25 инструментов) → `status:"up"`. Отсутствующий бинарник: исполнитель жив,
     `/mcp/tools` → `[]`, `/mcp/call` → `internal_error` с `spawn … ENOENT`, `/mcp/servers` →
     `down` + `error` (в первой проверке отдавал `idle` — дефект статуса исправлен: транспортное
     закрытие/ошибка до подъёма больше не игнорируется). `docker stop` → 351 мс, `Exited (0)`,
     дочерних `playwright-mcp`/Chromium не остаётся (`docker top`/`pgrep` после остановки).
10. **Пул исполнителей — привязка клиента на его Service** (`executor.service.sessionAffinity`): браузерные
    MCP-сессии живут внутри под'а, а control plane ходит в пул по одному адресу (ClusterIP) — балансировка per
    TCP-соединение ⇒ вызовы одной сессии попадали бы на разные поды; `ClientIP` — компромисс как sticky control plane (п. 7).
11. **Привязка клиента — на всех трёх Service цепочки** (control plane, пул исполнителей, UI). Запрос идёт
    как «клиент → Service UI → UI-под (nginx) → Service backend'а → backend-под», поэтому привязка control plane
    (п. 7) работает только в пределах одного UI-пода: без привязки Service UI клиент чередуется между UI-под'ами,
    а для Service backend'а это **разные clientIP** ⇒ цепочка рвётся, и один backend-под обслуживает несколько
    UI-подов. Значит у Service UI своя привязка (`ui.service.sessionAffinity`) — тот же компромисс (sticky по IP);
    реплик UI должно быть не меньше, чем реплик backend'а. Полноценное решение — внешний транспорт событий
    (PROP-104); привязка клиента его не заменяет.

## Альтернативы

- **Исполнение в процессе, без порта** — отклонено: перенос toolchain'а в отдельный контейнер без порта означал бы
  переписывание каждой точки исполнения; разные реализации разошлись бы по семантике.
- **Runtime-переключатель топологии** — отклонено: process-глобальные решения (TLS-диспетчер, пул PG, MCP, шедулер)
  на лету не переинициализируются (инвариант 24); режим — параметр запуска.
- **Тихий откат в inline при недоступности исполнителя** — отклонено: оператор, запросивший split, получил бы
  исполнение в control plane (с его toolchain'ом и секретами) — ровно то, чего split-топология исключает.
- **gRPC/другой транспорт для exec-API** — отклонено: HTTP/1.1 + JSON — тот же стек, что весь Synth, без новых
  зависимостей.
- **Отдельный процесс на сессию (Job) или CRD-оператор** — отклонено на первой версии: требует RBAC-эскалации
  control plane и собственного release-цикла; эволюция — статический пул + очередь в backend.

## Последствия

- **Плюсы:** у точки исполнения один контракт и один контрактный suite; split-топология (тонкий control plane +
  отдельные исполнители) стала возможной без переписывания домена; в исполнителе нет LLM-ключей и OIDC-секретов.
- **Минусы:** ещё один порт и ещё один optional-пакет в сборке; удалённый режим добавляет сетевой отказ и
  round-trip к каждой команде; `simple-git` и MCP-stdio пока остаются в control plane (фазы 2–3).
- **Следствия:** образы разводятся по режиму (`synth-backend` — control plane, `synth-executor` — worker);
  `execution.*` — секция конфигурации, применяемая при старте; наблюдаемость исполнителя — отдельный `/metrics`
  (ADR-094).
- **Операционные следствия шага A (доступность по составу пула):**
  - **(а) Состав пула известен только из `/capabilities`** ⇒ control plane и исполнитель обязаны быть
    **одной версии протокола**: инвентарь приходит от исполнителя, а не вычисляется на стороне control
    plane. При rolling update возможно окно, когда старый исполнитель ещё не знает `sh` (словарь
    базовых возможностей расширен) и не может обслужить `execute_shell` — команда уйдёт в другой адрес
    или вернёт `dependency_missing`. Обновление пула ⇒ обновление control plane (или наоборот).
  - **(б) Fail-open при недоступном инвентаре, fail-closed в маршрутизации.** Если **ни один** адрес не
    ответил на `/capabilities`, состав пула неизвестен ⇒ тул **не** блокируется (ADR-078: неоднозначная
    ошибка не должна отключать инструмент) — команда падает с `EUNREACHABLE`, ошибка видна модели. Если же
    адрес **ответил**, но нужной программы у него нет, — такой адрес из маршрутизации **исключается**
    (fail-closed): неизвестный/отсутствующий состав нельзя считать подходящим.
  - **(в) Ограничение «все реплики пула — один образ ⇒ один инвентарь».** Сейчас пул — это Deployment из
    однотипных реплик: инвентарь у них общий. Перечисление **отдельных** реплик (адрес → свой состав)
    потребовало бы стабильных адресов/имён — то есть StatefulSet. Это **открытый вопрос**, а не решённый
    факт: до решения пул описывается как «один образ — один инвентарь».
  - **(г) Снимок доступности вычисляется один раз на порт** (кэш детекции — `WeakMap` по экземпляру
    порта; фактически — при старте процесса, до первого запроса) и **не пересчитывается** при обновлении
    инвентаря по TTL: обновление инвентаря влияет на **маршрутизацию команд**, но не на «зелёный/красный»
    статус тула. Изменился состав пула — снимок пересчитается после рестарта control plane (инвариант 24:
    process-глобальные решения не переинициализируются на лету).
- **Операционные следствия шага B1 (MCP-хостинг исполнителя):**
  - **(а) Версия протокола — контракт совместимости.** Добавление эндпоинтов `/mcp/*` подняло версию
    протокола до **2**: старый исполнитель их не знает. Значит **control plane и пул исполнителей
    обязаны быть одной версии** — то же правило, что и для инвентаря пула (шаг A, следствие (а)):
    обновление пула ⇒ обновление control plane (или наоборот). Проверка версии на проводе — задача
    шага B2 (клиентская проводка).
  - **(б) Секреты MCP-серверов живут в исполнителе.** `env` сервера (токены SCM-хостингов) приходят
    в исполнитель из Secret и **не покидают** его: в ответах `/mcp/servers` значений нет, тексты
    ошибок вычищаются, переменная `SYNTH_EXECUTOR_MCP_SERVERS` убирается из `process.env` — иначе
    токены утекли бы в окружение агентских команд (тот же приём, что с bearer-токеном исполнителя).
  - **(в) Жизненный цикл MCP-сервера — ленивый и восстановимый.** Сервер не поднимается, пока к нему не
    обратились; упавший сервер помечается `down` с причиной и **переподнимается** при следующем
    обращении (circuit breaker защищает от частых переподключений). Это значит, что «сервер не
    отвечает» в статусе — не фатально: следующий запрос его поднимет.
  - **(г) Остановка исполнителя завершает и MCP-серверы.** Дочерние процессы MCP (и Chromium)
    закрываются вместе с исполнителем — зомби-процессов в поде не остаётся.
- **Измеренные ограничения при нескольких репликах control plane** (test, **2 реплики** backend, 2026-10-22 —
  то, что не видно из аудита и проявилось только на живом кластере):
  - **Auth-сессии пользователя backend'а — в памяти процесса** (`packages/backend/src/auth/middleware.ts:35`,
    `Map<string, {user, expiresAt}>`) ⇒ при `replicaCount > 1` вход **не переживает смену реплики**: один и
    тот же cookie `user_session` дал `404 «Сессия не найдена»` на реплике, где прошёл вход, и
    `401 «Требуется аутентификация»` на второй. Сейчас маскируется привязкой клиента (`ClientIP`
    на трёх Service — п. 7 и п. 11), то есть при интерактивной работе незаметно, но всплывает при любом
    сдвиге трафика (рестарт пода, смена IP, второй UI-под, прямой вызов API, сервис-меш). Закрывается
    [PROP-105](./prop-105-multi-replica-coordination.md) — auth-сессии в общий store.
  - **Проверено, что работает (не блокеры):** `scheduler.leaderElection: postgres` — на двух репликах
    ровно **один** тикер, вторая пишет `[scheduler] не удалось стать лидером — тикер не запущен`,
    срабатывание ровно **одно** на интервал (job `cron | ok | dedupKey cron:<id>:<минута>`);
    привязка `ClientIP` на трёх Service (backend, пул исполнителей, UI) работает по source IP;
    браузерные MCP-тулы при **двух** исполнителях работают (`browser_navigate` → `browser_evaluate`).
  - **Очередь: убийство реплики в середине хода оставляет сообщение залипшим.** После остановки пода,
    обрабатывавшего ход, состояние — `{blocked: true, pending_count: 1, processor_running: false}`:
    сообщение **не разбирается ни одной репликой**, авто-восстановления нет. Ручной
    `POST /api/v2/queue/:sessionId/resume` поднимает обработчик на выжившей реплике, и ход продолжается.
    Лечение — claim-семантика + TTL протухания (PROP-105, «Claim-семантика очереди»).
  - **Rate limit ingest'а считается на процесс:** `ingestPreGuard` — `createRateLimiter(120, 60_000)`
    (`packages/backend/src/app/mount-routes.ts:286`) — измерено **120×`401` + 10×`429` на каждой** из двух
    реплик ⇒ при 2 репликах эффективный лимит — **240/мин**, а не заданные 120. Общий счётчик — PROP-105;
    транспорт публикации — PROP-104.
  - **Файловые порты на общем RWX-томе синхронны, но не защищены от гонок:** `packs.json` и другие
    совпадают между репликами (sha256 совпадает), однако уникальность записи держит `AsyncLock`
    **в процессе** ⇒ две реплики могут перетереть друг друга. Переезд в SQL — PROP-106.

## Статус в коде

- **Порт и контракт:** `packages/core/src/execution/ports/execution-port.ts` (`ExecutionPort`, `ExecRequest`,
  `ExecResult`, `ExecutionError`, `DEFAULT_MAX_OUTPUT_BYTES`), `ports/index.ts`; контрактный suite —
  `packages/core/src/execution/contract/execution.ts` (+ `contract/index.ts`), прогон против живого исполнителя —
  `contract/remote.test.ts`.
- **Реализации:** `packages/core/src/execution/inline-execution-port.ts` (в процессе) и удалённая —
  `packages/core/src/execution/remote.ts` (динамический `import()` `@itphx/synth-executor/client`, fail-closed,
  чтение токена из файла) + пакет `packages/executor/` (`protocol.ts` — `EXECUTOR_PROTOCOL_VERSION = 2`,
  `client.ts` — `RemoteExecutionPort`, `server.ts`, `mcp.ts` — хостинг MCP-серверов, `exec-service.ts`,
  `auth.ts`, `workspace.ts` — containment `cwd`, `toolchain.ts`, `config.ts`, `main.ts`).
- **Выбор режима и шов:** `packages/core/src/execution/factory.ts` (`createExecutionPortForConfig`),
  `packages/core/src/execution/startup.ts` (`checkExecutionMode`/`assertExecutionModeSupported` — fail-closed),
  `packages/core/src/execution/tool-port.ts` (`resolveExecutionPort(ctx)` → `ctx.extra.executionPort`).
- **Конфигурация:** `execution.mode` / `execution.remote.*` — `packages/shared/src/config/types.ts`,
  `defaults.ts`, `execution.ts` (резолвер), env `SYNTH_EXECUTION_*`, CLI `--execution-mode`.
- **Потребители:** `packages/core/src/engine/tools/git.ts` (исполнение через порт), `engine/tools/shell.ts`,
  `engine/tools/search.ts`, `engine/commands/inline-shell.ts`, `engine/tools/runtime-deps.ts`.
- **Шаг A — доступность инструментов по составу пула исполнителей (ADR-077/ADR-078):**
  - **Порт:** `packages/core/src/execution/ports/execution-port.ts` — `ExecRequest.requires?: string[]`
    (бинарные требования команды), `ExecutionPort.probe?(bin, args?)` («доступен ли бинарь в моём
    окружении»), `ExecutionPort.capabilitySummary?(bin)` (сводка «в пуле: N из M»), тип
    `ExecutionCapabilitySummary` (`available`/`missing`/`total`/`unreachable`), канонический словарь
    `EXECUTION_BASE_CAPABILITIES = ['git','rg','sh']`, новая причина отказа `dependency_missing`;
    реэкспорт — `ports/index.ts`, `packages/core/src/index.ts`.
  - **Единственная проба:** `packages/core/src/execution/probe.ts` (`probeBinaryThroughPort`) — `bin --version`
    через порт: `ENOENT` → `false`, прочая ошибка → `true` (fail-open, ADR-078);
    `inline-execution-port.ts` реализует `probe()` поверх неё — поведение inline не изменилось.
  - **Слой доступности:** `packages/core/src/engine/tools/runtime-deps.ts` — детект через `port.probe`
    (remote) либо локальная проба (inline); кэш детекции **по экземпляру порта** (`WeakMap`) — локальная
    проба больше не отравляет remote-кэш; `runtimeRequires()`/`toolRuntimeRequires()` (источник — карта
    `TOOL_RUNTIME_DEP`, строки не дублируются), `RuntimeDeps.details` — деталь недоступности.
  - **Требования тулов:** `engine/tools/shell.ts` (`execute_shell → ['sh']`), `engine/tools/search.ts`
    (`grep_files → ['rg']`), `engine/tools/git.ts` (все git-тулы → `['git']`).
  - **Деталь до модели:** `engine/permission/availability.ts` (`ToolAvailability.detail`),
    `engine/permission/evaluator.ts` (деталь в тексте deny), `engine/orchestrator.ts` и
    `engine/pipelines/step-context.ts` (`UnavailableTool.detail`), `engine/context/state-messages.ts`
    (рендер строки недоступного тула).
  - **Инвентарь и маршрутизация (клиент исполнителя):** `packages/executor/src/client.ts` —
    `RemoteExecutionPort` собирает инвентарь пула по `GET /capabilities` **всех** адресов
    (`REMOTE_CAPABILITIES_TTL_MS = 120_000`, ленивое обновление), отвечает `probe()`/`capabilitySummary()`,
    маршрутизирует команду с `requires` в адрес с нужными бинарями; адрес без нужного бинаря и не
    ответивший адрес не участвуют; подходящего адреса нет → `dependency_missing`/`EDEPENDENCY` с текстом
    «в пуле: N из M».
  - **Словарь исполнителя:** `packages/executor/src/toolchain.ts` — базовый словарь берётся из core
    (`EXECUTION_BASE_CAPABILITIES`, точечный динамический `import()`), допсведения отделены
    (`EXTRA_TOOLCHAIN_BINARIES = ['python3']`), проба различает `ENOENT` («программы нет») и «есть, но не
    поддержал `--version`» (программа есть).
  - **Тесты:** контракт порта (`packages/core/src/execution/contract/execution.ts` — `probe`, `requires`),
    `packages/core/src/engine/tools/runtime-deps.test.ts` (remote-детект, деталь, отсутствие отравления
    кэша, inline без изменений), `packages/executor/src/client.test.ts` (инвентарь, маршрутизация,
    недоступный адрес, `EDEPENDENCY`, сводка пула), `packages/executor/src/toolchain.test.ts`,
    `packages/core/src/execution/port-wiring.test.ts` (требования тулов), `availability.test.ts`,
    `storage-degraded.test.ts` (рендер детали).
- **Чарт split-развёртывания (шаг 7c):** `charts/synth/values.yaml` (`execution.*`, `executor.*`), шаблоны
  `charts/synth/templates/executor-deployment.yaml`, `executor-service.yaml`, `executor-pvc.yaml`
  (общий том workspace, RWX), `executor-networkpolicy.yaml` (ingress — только от pod'ов control plane,
  egress — по умолчанию только DNS), `executor-networkpolicy`/`executor.serviceaccount` — в шаблоне чарта;
  токен — из Secret (backend получает **файлом**, worker — **значением** в env), fail-closed проверки
  рендера (неизвестный `mode`/`failMode`, отсутствие адреса, `executor.enabled` без workspace,
  accessMode ≠ RWX); при `executor.enabled: false` рендер чарта побайтово не меняется.
- **Sticky-сессии control plane (подготовка к мультирепличности):** `charts/synth/values.yaml`
  (`backend.service.sessionAffinity` — `None` по умолчанию), шаблон
  `charts/synth/templates/backend-service.yaml` (поле рендерится только для значения, отличного от
  `None`, — дефолтный манифест Service не меняется побайтово); подробности и оговорки — README чарта
  («Sticky-сессии при нескольких репликах backend»).
- **Привязка клиента на Service UI** (`ui.service.sessionAffinity` — `None` по умолчанию), шаблон
  `charts/synth/templates/ui-service.yaml` (поле рендерится только для значения, отличного от `None`, —
  дефолтный манифест Service не меняется побайтово); оговорки про цепочку
  «клиент → UI-под → backend-под» — README чарта («Привязка клиента к UI-поду»).
- **Адрес backend'а в образе UI — из окружения:** `docker/nginx-ui.conf.template` (шаблон nginx +
  `envsubst` с фильтром `NGINX_ENVSUBST_FILTER=SYNTH_BACKEND_URL` — переменные nginx не подменяются),
  `docker/Dockerfile.ui` (`ENV SYNTH_BACKEND_URL=http://synth-backend:5000`), чарт —
  `ui.extraEnv.SYNTH_BACKEND_URL` (дефолт — Service backend'а текущего релиза).
- **Шаг B1 — исполнитель хостит MCP-серверы:** `packages/executor/src/mcp.ts` (`ExecutorMcpHost`:
  stdio через `@modelcontextprotocol/sdk`, лимиты как в core, circuit breaker, `redactSecrets`,
  статусы `idle`/`up`/`down`, `close()`), `src/config.ts` (`SYNTH_EXECUTOR_MCP_SERVERS`, строгий
  разбор, `''` = серверов нет, `scrubExecutorMcpServers`), `src/server.ts` (`GET /mcp/servers`,
  `GET /mcp/tools`, `POST /mcp/call` под bearer), `src/protocol.ts` (протокол 2, причина `not_found`);
  тесты `src/mcp.test.ts`, `src/mcp-routes.test.ts`, фикстура `test-fixtures/mcp-stdio-server.mjs`.
  Образ: `docker/install-tier-3.sh` создаёт стабильный симлинк `/opt/synth/browser/chrome`
  (резолв по glob `chromium-*/chrome-linux64/chrome`, fail-closed если браузера нет),
  `docker/Dockerfile.executor` задаёт дефолт `SYNTH_EXECUTOR_MCP_SERVERS` только во flavor'ах
  с браузером (`browser`/`full`); чарт — `executor.mcp.servers`/`executor.mcp.enabled`.
- **Остаток:** метрики `synth_executor_*` и runbook переключения топологии (шаг 7d), клиентская
  проводка MCP в control plane (шаг B2), перенос `simple-git` в исполнитель (шаг 8),
  спека `docs/EXECUTION.md` — синхронизация описания инвентаря пула и словаря базовых возможностей.

## Связи

- [ADR-096](./adr-096-storage-layer.md) / [ADR-097](./adr-097-storage-provider-class.md) — образец доменного порта,
  контрактного suite и optional-пакета с динамическим `import()`.
- [ADR-099](./adr-099-egress-tls-trust.md) — единый egress-слой: доверие TLS/CA, исходящий транспорт, адресная политика.
- [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — рестарт инстанса (exit 75), параметр запуска, а не runtime.
- [ADR-094](./adr-094-observability-metrics.md) — контракт имён метрик (`synth_executor_*`) и liveness/readiness.
- [ADR-075](./adr-075-project-workspace-provisioning.md) — provisioning остаётся в backend'е; общий том workspace в split-режиме.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) — git-реестр и SSH-материал (фаза 2 — доставка в исполнителя).
- [ADR-078](./adr-078-runtime-dependency-availability.md) — детект внешних зависимостей: в split-режиме источник — исполнитель.
- [ADR-036](./adr-036-llm-gateway.md) — в исполнителе LLM-ключей нет; границы обфускации/аудита сохраняются.
- [ADR-038](./adr-038-npm-packages.md) — поставка пакета `@itphx/synth-executor` в npm.
- [docs/EXECUTION.md](../EXECUTION.md) — Spec: топологии, контракт порта, exec-API, развёртывание, миграция.

## История

- 2026-10-21 — переработано в split-топологию (control plane + отдельные контейнеры-исполнители), единый
  переключатель `execution.mode`, порт `ExecutionPort`, упаковка исполнителя — отдельный in-tree пакет
  `@itphx/synth-executor` по образцу слоя хранения, транспорт — HTTP/1.1 + JSON.
- 2026-10-21 — шаг 1: порт исполнения реализован (union shell/argv, типизированная `ExecutionError`,
  inline-реализация + контрактный suite); шаг 3: секция `execution` в конфиге, fail-closed на неизвестном
  `mode`; шаги 7a–7b: пакет исполнителя (exec-API `/exec`/`/capabilities`/`/health`, containment `cwd`) и
  подключение по `execution.mode=remote` (динамический `import()`, чтение токена из файла, стартовая
  проверка режима).
- 2026-10-22 — шаг 7c: чарт split-развёртывания (значения `execution.*`/`executor.*`, шаблоны
  `executor-*.yaml`, RWX-том workspace в backend и в пуле, `NetworkPolicy` пула, токен из Secret —
  backend файлом, worker значением, fail-closed проверки рендера); предложение повышено до ADR, детали
  вынесены в [docs/EXECUTION.md](../EXECUTION.md) (Spec); **шаг A**: доступность инструментов
  определяется составом пула исполнителей — `probe()`/`capabilitySummary()` у порта,
  `ExecRequest.requires`, инвентарь пула по `GET /capabilities` (TTL + ленивое обновление),
  маршрутизация команды по требуемым бинарям, причина `dependency_missing` + деталь «в пуле: N из M»,
  кэш детекции по экземпляру порта; зафиксированы операционные следствия (единая версия протокола
  control plane и исполнителя, fail-open при недоступном инвентаре и fail-closed в маршрутизации,
  «один образ — один инвентарь», снимок доступности при старте).
