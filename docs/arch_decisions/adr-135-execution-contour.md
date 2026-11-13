# ADR-135: Единый контур исполнения — пулы, профили и provisioner

> **Статус:** ⚠️ Частично — реализовано: полный `remote` (все файловые/git/shell-тулы на исполнителе),
> порт `exec+fs+stream`, пулы `instance|project|session`, профили и binding, provisioner
> (`static`/`kubernetes`, `/v1/pools`), `sandbox_exec`, встроенные `browser_*`-тулы, `workspaceSubPath`.
> Остаток: per-project UI выбора browser-профиля, remote builder (внешняя инфраструктура),
> e2e на кластере (поды/RBAC/NetworkPolicy).
> **Дата:** 2026-11-13
> **Источник:** PROP-135 (файл удалён после принятия).
> **Заменяет:** [ADR-077](./legacy/adr-077-runtime-toolchain.md) по топологии исполнения и порту.
> **Связано:** [ADR-075](./adr-075-project-workspace-provisioning.md) (workspace), [ADR-114](./adr-114-git-worktrees.md)
> (worktrees), [ADR-094](./adr-094-observability-metrics.md) (метрики), [ADR-029](./adr-029-granular-permissions.md)
> (permissions), [ADR-090](./adr-090-extension-api.md) (плагины), [ADR-136](./adr-136-shell-trust.md),
> [ADR-137](./adr-137-executor-isolation.md), [ADR-138](./adr-138-plugin-execution-contour.md);
> спецификация — [docs/EXECUTION.md](../EXECUTION.md), конфиг — [docs/CONFIGURATION.md](../CONFIGURATION.md),
> API — [docs/API_V2.md](../API_V2.md) §5.41.

## Контекст

`execution.mode=remote` был половинчатым: на исполнитель уехали shell, git и MCP-stdio, а файловые
тулы агента читали и писали ФС **control plane**. В split-топологии рабочий каталог живёт на
исполнителе — тонкий control plane не должен ни читать ФС агента, ни исполнять его команды. Пулов и
профилей не было: один общий пул на процесс, без изоляции проектов и выбора среды; браузер отдавался
через глобальный MCP-discovery и «пропадал» при per-project пулах.

## Решение

1. **`remote` — полный.** При `execution.mode=remote` **все** файловые, поисковые, git- и shell-тулы
   исполняются только на исполнителе: `read_file`, `list_directory`, `write_file`, `edit_file`,
   `delete_file`, `create_directory`, `patch`, `attach_workspace_file`, `save_attachment`,
   `send_attachment`, `glob`, `grep_files`, `git_*`, `execute_shell`. В control plane остаются LLM
   (GatewayProvider, ADR-036), хранилище, блобы, HTTP FS-роуты, provisioning workspace, permission-слой,
   MCP HTTP и шлюзы.
2. **Контракт порта — `exec + fs + stream`.** `ExecutionPort` получает `fs` (`realpath`/`stat`/`readdir`/
   `readText`/`sniff`/`readBytes`/`writeFile` (атомарно tmp→rename)/`edit`/`mkdir`/`remove`/`rename`/
   `hash`) и бинарный `stream` (download/upload, base64 — только для малых файлов). Признак `features.fs`
   в `GET /capabilities`; `remote` без `features.fs` → **fail-closed** (`ExecutionFsUnavailableError`).
   Канонические пути (`realpath`/`stat`) приходят с исполнителя, решение периметра принимает control
   plane по ним; для `glob`/`grep_files` политика применяется к путям совпадений. Контрактные тесты
   общие для `inline` и `remote`; архитектурный линт — файловые тулы не импортируют `node:fs*`
   (исключение — `InlineExecutionPort`).
3. **Пулы — `instance | project | session`** (`execution.remote.pooling`), классы `exec | browser | sandbox`.
   Ключ канонический: `scope:id:class:profile` (`project`/`session` без id — ошибка). `project` — тёплый
   под на проект; `session` — эксклюзивный; `instance` — прежний общий порт. **Браузерный пул — всегда
   per-project** (`project:<id>:browser:<profile>`, cookies общие внутри проекта и не текут между
   проектами), при любом `pooling`.
4. **Профили и binding.** Профиль = образ, flavor, resources, сетевой класс, `runtimeClass`,
   монтирования, env; каталог задаёт **только ADMIN** (`execution.remote.profiles`,
   `provisioner.profiles`), профиль не добавляет секретов инстанса и привилегий. Эффективный профиль
   хода: `session.settings.executorProfile` → `agentDefinition.executorProfile` →
   `project.executor.profile` → `execution.remote.defaultProfile`; кандидат обязан входить в
   `project.executor.allowedProfiles` и `agentDefinition.allowedProfiles` (fail-closed, откат на
   `defaultProfile`). Binding иммутабелен на время сессии; `task({executor_profile})` проверяет каталог
   и потолки до создания ребёнка и наследует профиль.
5. **Provisioner — отдельный процесс, не K8s-клиент в backend.** Провайдер-нейтральный контракт:
   `POST /v1/pools {key, scope, id?, class, profile, workspaceSubPath?} → {url, token?}`,
   `POST /v1/pools/{key}/touch|drain`, `DELETE /v1/pools/{key}`, `GET /v1/capabilities`,
   `GET /v1/profiles`, `GET /health`, `GET /metrics`. `touch` продлевает жизнь пула (best-effort,
   обновляет `lastUsedAt`), `drain`/`release` снимают под с grace. Провайдеры `static` (адреса из
   конфигурации) и `kubernetes` (Pod + Secret на ключ пула). `ensure` идемпотентен, reaper — **один
   писатель**, источник истины о пулах — labels (`synth.io/pool-*`), отдельной mutable-таблицы нет;
   после рестарта provisioner усыновляет поды по label. Backend **не ходит в K8s API**. Таймаут/жизненный
   цикл: `startTimeoutMs` 120 с, idle проекта 900 с, сессии 300 с, `maxLifetimeMs` 12 ч, `drainGraceMs`
   30 с, `maxPools` 50 → сверх лимита `429` (без тихого фоллбека).
6. **`sandbox_exec`** — разовый запуск 1…5 команд в пуле класса `sandbox` (`session:<id>:sandbox:<profile>`):
   другой образ/набор программ, тот же аудит исполнений и внешний чекер, что у `execute_shell`
   (ADR-136); shell-guard/protected-paths `execute_shell` не применяются (другая среда), containment
   `cwd` — лексический, реальный — на исполнителе; inline-фоллбек запрещён.
7. **Встроенные `browser_*` (вариант 3, без MCP-discovery).** `browser_navigate`, `browser_snapshot`,
   `browser_click`, `browser_type`, `browser_press`, `browser_wait`, `browser_screenshot`, `browser_close`
   — статические схемы в реестре ядра, capability `web`, вызов `ExecutionPort.browserCall` →
   `POST /mcp/call` в проектный пул класса `browser` (`execution.remote.browserProfile`, дефолт `browser`;
   `browserMcpServer`, дефолт `playwright`). MCP-сервер браузера остаётся подключённым, но его инструменты
   скрыты из discovery (`hiddenServers`), дублей `playwright_*` нет. Скриншот публикуется вложением
   сообщения (`ToolResult.attachments`).
8. **`workspaceSubPath`.** В под пула монтируется не весь RWX-том, а `subPath`: каталог проекта, для
   worktree — `.worktrees/<projectId>` (совместимо с ADR-114). В managed при
   `storage.workspaceOutsideRoot=deny` проект вне `workspacesRoot` в per-project режим не попадает
   (том монтируется целиком).
9. **Наблюдаемость и события.** `executor.provisioning {project, session, profile, phase}` →
   `executor.ready` в существующей шине (ADR-024/ADR-118), новых каналов нет; метрики
   `synth_executor_pool_*`/`synth_executor_provision_*` — по контракту ADR-094 (без `session_id`).

10. **Браузерный контур профилей (Ф6a, симметрия с exec).** Браузерные имена — **отдельный
    каталог**, а не подмножество exec-профилей: `execution.remote.browserProfiles` (env
    `SYNTH_EXECUTION_BROWSER_PROFILES`, csv); пусто — каталог равен `[browserProfile]`
    (обратная совместимость). Имена из `browserProfiles` **исключаются** из exec-каталога
    (`router.profiles()`, проверка `executor_profile`), а metadata-записи в
    `execution.remote.profiles` для них остаются (описание/сеть/`mcpServers` для `details`).
    `resolveProfileName` для `class: 'browser'` знает только браузерный каталог (+ текущий
    `browserProfile`); exec-имя браузерному пулу не адресуется.
    Эффективный браузерный профиль хода — та же цепочка, что у exec:
    `session.settings.browserProfile` → `agentDefinition.browserProfile` →
    `project.executor.browserProfile` → `execution.remote.browserProfile`; потолки —
    `project.executor.allowedBrowserProfiles` ∩ `agentDefinition.allowedBrowserProfiles`
    (непустой список обязателен для кандидата, пусто — без ограничения). Запрещённый/неизвестный
    кандидат не выбирается: откат на следующий/дефолт инстанса + предупреждение в лог (без
    секретов); дефолт инстанса потолками не проверяется. Binding считается на ход оркестратором
    (и саб-агентом — по его роли/проекту) и уходит в `ToolContext.extra.executionBrowserProfile`;
    `browser_*` передают его в `portFor({class:'browser', profile})`. Ключ пула не изменился
    (`project:<id>:browser:<profile>`). API валидирует имена по каталогу (агент/проект/сессия;
    400 `VALIDATION_ERROR`, текст «Профиль браузера не найден: …»); `GET /api/v2/execution/profiles`
    отдаёт аддитивные `browserProfiles`/`browserDefaultProfile`, `profiles` — без браузерных имён.

11. **Каталог профилей — runtime-настройка инстанса (аддендум).** Каталог профилей и дефолты
    (`defaultProfile`, `browserProfile`, `browserProfiles`, `pooling`, `fallback`) — **не только**
    `config.yaml`: это **backend-owned runtime-секция** `execution`
    (`RuntimeSettings.execution`, `settings.json`/PG), которой управляет **только ADMIN** через
    `GET/PUT/DELETE /api/v2/settings/execution` (ADR-023: приоритет **env/CLI > runtime > config.yaml**;
    env/CLI разрешаются внутри `resolveExecutionConfig`, runtime-override применяется поверх
    config-уровня, но **под env**).
    - **Runtime-каталог заменяет каталог config.yaml целиком** (`profiles` — как `profiles`/`rules`
      прокси, ADR-099): администратор может и добавить профиль, и удалить профиль из конфига (не задав
      его в runtime-каталоге). Пока runtime-секция не задана, действует каталог config.yaml.
    - **Валидация записи (400 `VALIDATION_ERROR`):** `defaultProfile` есть в эффективном каталоге;
      `browserProfiles` ⊆ каталога; `browserProfile` ∈ `browserProfiles` (если список задан) либо в
      каталоге; у каждого профиля каталога задан `image` или `url`; неизвестное поле секции — 400.
      Секция **не** содержит секретов: `env` — переменные окружения пула, не пароли (инвариант 13).
    - **Применение — при старте процесса** (`execution` — параметр запуска, инвариант 24): порты пулов и
      роутер создаются на старте, поэтому API честно отдаёт `restartRequired` (сравнение отпечатков
      «сохранено» vs «работает»). Каталог, заданный только в runtime, действует после рестарта;
      `/api/v2/execution/profiles` до рестарта отдаёт **работающий** (running) каталог.
    - **Граница:** общий адрес секции (`execution.remote.url`) и режим (`execution.mode`) остаются
      config/env-уровня — instance-пул берёт адрес оттуда; runtime-каталог описывает **профильные**
      пулы (`pooling: project|session`) и служит источником каталога для provisioner'а.

## Альтернативы
- **Оставить файловые операции в control plane** — отклонено: split теряет смысл, тонкий control plane
  читает ФС агента.
- **Браузер через MCP-discovery** — отклонено: discovery берётся с инстанс-пула, а браузерный пул
  per-project — тулы «пропадали» бы; статическая схема от discovery не зависит.
- **Backend сам создаёт поды (K8s API)** — отклонено: RBAC-эскалация control plane и собственный
  release-цикл; узкий provisioner с провайдер-нейтральным контрактом.
- **Runtime-переключение пулов/профилей** — отклонено: process-глобальные решения меняются рестартом
  (инвариант 24).

## Последствия

- **Плюсы:** единый контур для команд и файлов, изоляция проектов/сессий, выбор среды профилем,
  control plane без ФС агента; контрактные тесты `inline`/`remote` удерживают семантику.
- **Минусы:** ещё один сервис (provisioner) и протокол; версии control plane/исполнителя обязаны быть
  совместимы; квоты пулов — операционная настройка; `sandbox_exec` — отдельная среда без shell-guard.
- **Остаток:** remote builder — внешняя инфраструктура (чарт его не разворачивает); e2e на кластере
  (поды, RBAC, NetworkPolicy) не прогонялся. Per-project UI выбора browser-профиля **закрыт**
  (браузерный контур: агент/проект/сессия, см. п. 10).

## История

- 2026-11-13 — принято из PROP-135 (реализация Ф1–Ф6b); файл предложения удалён.
- 2026-11-13 — аддендум п. 10: браузерный контур профилей (каталог `browserProfiles`, приоритет
  session → agent → project → `browserProfile`, потолки, UI агента/проекта/сессии).
- 2026-11-13 — аддендум п. 11: каталог профилей и дефолты исполнения — **runtime-настройка**
  (`/api/v2/settings/execution`, ADMIN; runtime заменяет каталог config целиком; применение при
  старте, `restartRequired`).
