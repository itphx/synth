# Архитектура Synth

> 🌐 [English](./en/ARCHITECTURE.md) · **Русский**

> [!NOTE]
> Пользовательские сценарии развёртывания (локально, Docker, Kubernetes, гибрид) —
> в портале документации: https://docs.synth.itphx.ru/deploy/local/.

## Компоненты

Synth состоит из восьми пакетов в монорепозитории:

| Пакет | Назначение | Стек |
|-------|-----------|------|
| **@itphx/synth-shared** | Типы, интерфейсы, Zod-схемы, протоколы, конфигурация | TypeScript |
| **@itphx/synth-core** | Автономный движок: сессии, очередь, LLM-провайдеры, CLI, HTTP API v2 | TypeScript, Hono |
| **@itphx/synth-storage-postgres** | Опциональный драйвер слоя хранения поверх PostgreSQL (ADR-097): реализует доменные порты `StorageContext`, `peer-dep` core, `pg` — optional | TypeScript, `pg` |
| **@itphx/synth-executor** | Исполнитель агентских команд — отдельный процесс (ADR-077): сервер исполнителя + клиент удалённого порта, `peer-dep` core | TypeScript, Hono |
| **@itphx/synth-backend** | API Hub: OIDC, Runner Registry, LLM Proxy, RBAC, SessionEventBus | TypeScript, Hono |
| **@itphx/synth-ui** | React 19 SPA + админка (рендеринг по ролям) | TypeScript, React 19, Vite |
| **@itphx/synth-sdk** | Типизированный клиент публичного API (ADR-052): обёртка над public-OpenAPI (`events`/`sessions`/`schedules`/`llm`) | TypeScript, ESM |
| **@itphx/synth** | Публикуемая тонкая CLI-обёртка (`bin: synth`) над core/ui/shared (ADR-038). Не бандлит core, не копирует ассеты | TypeScript, commander |

Публичный HTTP-контракт описан **public-OpenAPI**-спекой (28 операций интеграционного ядра,
`packages/core/src/server/openapi/public-openapi.ts`, отдаётся `GET /api/v2/openapi.json`); SDK её
потребляет — единый клиентский слой поверх публичного API.

## Архитектурная схема

```mermaid
flowchart TB
    subgraph UI["Web-интерфейс"]
        synth_ui["@itphx/synth-ui — React SPA"]
    end

    subgraph Server["Серверная часть"]
        synth_backend["@itphx/synth-backend — Hono API Hub"]
        synth_core["@itphx/synth-core — автономный движок"]
    end

    subgraph CLI["Публикуемый CLI"]
        synth_cli["@itphx/synth — тонкая обёртка (bin: synth)"]
    end

    subgraph LLM["LLM-провайдеры"]
        ollama["Ollama (локально)"]
        openai["OpenAI API"]
        anthropic["Anthropic API"]
        providers["Любой OpenAI-совместимый"]
    end

    subgraph PublicClients["Публичные клиенты (ADR-052)"]
        synth_sdk["@itphx/synth-sdk — клиент публичного API"]
    end

    subgraph Storage["Слой хранения (ADR-096)"]
        storage_file["file / memory (in-tree, default)"]
        storage_pg["postgres — @itphx/synth-storage-postgres (опц.)"]
    end

    subgraph Execution["Исполнение команд (ADR-077)"]
        synth_executor["@itphx/synth-executor — исполнитель (опц.)"]
    end

    subgraph Integrations["Интеграции"]
        event_sources["Внешние источники событий"]
        webhook_targets["HTTP-подписчики (webhooks)"]
    end

    synth_ui -->|HTTP + WebSocket| synth_backend
    synth_ui -->|HTTP API v2| synth_core

    synth_cli -->|serve/chat/config| synth_core

    synth_core --> ollama
    synth_core --> openai
    synth_core --> anthropic
    synth_core --> providers

    event_sources -->|POST /api/v2/events| synth_core
    synth_core -->|webhooks: HTTP + HMAC-SHA256| webhook_targets

    synth_sdk -->|service-key / HTTP API v2| synth_core
    synth_sdk -->|HTTP API v2| synth_backend

    synth_core -->|StorageContext| storage_file
    synth_core -->|StorageContext| storage_pg
    synth_backend -->|StorageContext| storage_file
    synth_backend -->|StorageContext| storage_pg

    synth_core -->|ExecutionPort (HTTP)| synth_executor
```

## Сценарии развёртывания

### Облачный (командная работа)

```
synth-ui (браузеры сотрудников) ←→ synth-backend (:5000)
```

- Единый источник правды для сессий и истории
- Коллаборация: несколько пользователей в одной сессии
- Централизованный аудит всех LLM-запросов
- RBAC: роли ADMIN, USER, LEAD, AUDITOR
- API-ключи провайдеров хранятся только на бэкенде

### Локальный (один разработчик)

```
synth-ui (localhost) ←→ synth-core (:4300)
```

- Одна команда: `synth serve --api-key <key>`
- Прямой доступ к файловой системе
- Не требует бэкенда, Keycloak, Kubernetes

### Локальный + внешние движки (планируется)

Внешние движки (opencode/cline) через встроенный Runner-мост — **не реализовано**
(план: ADR-018, PROP-050). В ядре остаётся плумбинг: флаг `serve --runner` и секция
конфига `runner`, но адаптеров движков и маршрутизации нет; фактическое исполнение
идёт собственным движком `synth`.

### Гибридный (локально + корпоративный сервер)

Реализовано (требования и статус — [HYBRID.md](HYBRID.md)).

Сценарий: пользователь запускает `synth serve` на своей машине и подключает его
к корпоративному серверу (`synth serve --connect https://synth.k3s.itphx.loc`).
Локальный core становится **агрегатором двух миров**: локальные и удалённые
(backend) проекты/сессии доступны из одного локального UI. Удалённые сессии
исполняются сервером, локальные — локальным движком, но их LLM-запросы идут
через **LLM Proxy** на сервере (централизованные ключи, модели и аудит, ADR-036).

```mermaid
flowchart LR
    subgraph User["Машина пользователя"]
        UI["@itphx/synth-ui (localhost)"]
        Core["@itphx/synth-core (serve :4300)"]
        WorldLocal["Локальный мир: проекты/сессии/файлы"]
        RemoteClient["RemoteBackendClient (/api/v2/*)"]
        EventBridge["RemoteEventBridge (SSE)"]
        UI --> Core
        Core --> WorldLocal
        Core --> RemoteClient
        Core --> EventBridge
    end
    subgraph Server["Корпоративный сервер (K3s)"]
        Backend["@itphx/synth-backend (:5000)"]
        OIDC["OIDC / Keycloak (device flow)"]
        LLMProxy["LLM Proxy: POST /api/v2/llm/chat/completions"]
        Gateway["Gateway ADR-036 (аудит, обфускация, rate limit)"]
        Providers["Центральные провайдеры (ключи на сервере)"]
        RemoteSessions["Удалённые сессии (ChatOrchestrator)"]
        SSE["События: GET /api/v2/events (SSE)"]
    end
    RemoteClient -->|HTTPS /api/v2/*| Backend
    EventBridge -->|SSE| SSE
    Core -->|LLM-запросы локальных сессий| LLMProxy
    Backend --> OIDC
    LLMProxy --> Gateway
    Gateway --> Providers
    Backend --> RemoteSessions
```

Ключевые элементы:

- **Агрегация миров:** у каждой сущности поле `origin: 'local'|'remote'`,
  удалённые id — `remote:<uuid>` (исключают коллизии UUID между мирами); списки
  проектов/сессий объединяются, запросы маршрутизируются по миру.
- **RemoteBackendClient** (`packages/core/src/remote/client.ts`) — HTTP-клиент
  к `/api/v2/*` сервера: auth (OIDC device flow / API-ключ), таймауты, ретраи,
  ошибки «сервер недоступен».
- **RemoteEventBridge** (`packages/core/src/remote/event-bridge.ts`) — транслирует
  SSE сервера в локальный EventBus; события удалённых сессий переписываются в
  `remote:<id>` и доходят до UI.
- **LLM Proxy** (`packages/backend/src/routes/llm.ts`) — OpenAI-совместимый
  `POST /api/v2/llm/chat/completions`; прогоняет запросы через Gateway (ADR-036).
  При `remote.llm: server` локальные провайдеры запрещены полностью.
- **publish / fork** (`packages/core/src/remote/transfer.ts`) —
  `synth project publish <id> --remote` (локальный проект → сервер) и
  `synth project fork <id> --remote` (удалённый проект → локально); переносят
  проект + сессии + файлы (backend: `GET /sessions/:id/export`,
  `POST /sessions/import`).
- **Статус и offline:** `GET /api/v2/hybrid/status` →
  `{ enabled, connected, backendUrl, user }`; при недоступности сервера локальный
  мир работает, явные remote-операции возвращают 502 OFFLINE.

## Ключевые решения (AD)

Полный индекс архитектурных решений (AD) со статусами — в корневом
[AGENTS.md](../AGENTS.md), раздел «Индекс архитектурных решений».

## Слой хранения (backend'ы)

Физическое хранение вынесено за **доменные порты** ([ADR-096](./arch_decisions/adr-096-storage-layer.md)):
домен работает с `StorageContext` (`packages/core/src/storage/ports/*`, 30 портов), а backend подменяем.
Точка сборки — `packages/core/src/storage/storage-context.ts` (`createFileStorage`/`createMemoryStorage` +
асинхронный каскад `createStorageContextAsync`/`buildStorageContext`); выбор — `storage.backend`
(`file`|`memory`|`postgres`, env `SYNTH_STORAGE_BACKEND`).

- **`file`** (default) — `FileStore`/`JsonStore`, JSON + атомарная запись tmp→rename ([ADR-005](./arch_decisions/adr-005-json-storage.md)); **`memory`** — in-memory (герметичные тесты, эталон семантики).
- **`postgres`** — второй selectable backend ([ADR-096](./arch_decisions/adr-096-storage-layer.md)): отдельный in-tree пакет-драйвер **`@itphx/synth-storage-postgres`** ([ADR-097](./arch_decisions/adr-097-storage-provider-class.md)), подключаемый core **динамическим `import()`**; `pg` — optional. Любой backend обязан пройти контрактный suite `packages/core/src/storage/contract/*` («паспорт порта»); прогон драйвера против живой БД гейтится env `SYNTH_TEST_POSTGRES_DSN`.
- **Деградированный режим** ([ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)): при недоступности БД сервис поднимается на файловом фоллбеке в строгом read-only (ADMIN-only, `/health` → `degraded`); авто-возврата нет — только рестарт. Ошибки конфигурации/зависимостей/«схема новее» — fail-closed.
- **За портами не всё:** «файловый периметр» остаётся file-специфичным/гибридным — секреты в `secrets/` (мастер-ключ, API-ключи), `meta.json`/`synth migrate`, `workspaces/`, содержимое скиллов и промптов, аудит-журналы (`audit/*.jsonl`), URL-кэши инструкций ([ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md)/[ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)).

## Структура монорепозитория

```
synth/
├── pnpm-workspace.yaml       # pnpm workspaces
├── tsconfig.base.json        # общий конфиг TypeScript
├── eslint.config.js          # линтер
├── .prettierrc               # форматтер
├── scripts/                  # dev.sh, build.sh, standalone.sh, hybrid.sh, publish*.sh, version-bump.sh, changelog.sh, …
└── packages/
    ├── shared/   → @itphx/synth-shared
    ├── core/     → @itphx/synth-core
    ├── storage-postgres/ → @itphx/synth-storage-postgres (опц. БД-драйвер, ADR-097)
    ├── backend/  → @itphx/synth-backend
    ├── ui/       → @itphx/synth-ui
    ├── sdk/      → @itphx/synth-sdk (клиент публичного API, ADR-052)
    └── synth/    → @itphx/synth (тонкая CLI-обёртка, bin: synth)
```

## Модель «Runner» (планируется)

Мост между бэкендом и внешними движками (opencode/cline) — **не реализован**
(план: ADR-018, PROP-050). Задуманный раннер поднимает LLM Proxy и маршрутизирует
запросы в выбранный движок; движки stateless (история — на бэкенде).

## Stateless модель движка

История сообщений — на бэкенде. Движок получает на вход:

- Историю сообщений
- Новое сообщение от пользователя
- Контекст (system prompt, проект, статус)

Это обеспечивает:

- Коллаборацию (несколько пользователей в одной сессии)
- Переключение движка без потери контекста
- Перезапуск движка без потери истории
- Очередь сообщений на бэкенде, доставка по одной

## Композиция системного промпта (SystemPromptComposer)

Системный промпт собирает `SystemPromptComposer` (`engine/context/composer.ts`, ADR-070) —
**единственная точка сборки** для основной сессии и саб-агентов. `ContextBuilder` поставляет «сырые»
блоки, оркестратор не конкатенирует строки; специализированные промпты (debug-эхо,
`SUMMARIZER.{lang}.md`) — исключение, остаются inline.

- **Три тира, порядок отправки `stable` → `context` → `volatile`.** `stable` — побайтово константные на
  сессию блоки: role-prompt (+ политики «профиль пуст → интервью», «проекта нет → предложи создать»),
  `[ADDITIONAL CONTEXT]` (SOUL/COMPANY/ABOUT), `GATEWAY`, `PLAN_GUIDE`, политика режимов `mode.policy`.
  `context` — profile, `[PROJECT: info.md]`, проектные инструкции (ADR-069), каталог скиллов (ADR-046),
  `[ИНФОРМАЦИЯ О СЕССИИ]`. `volatile` — sticky, participants, summary, компактные state-маркеры,
  `[CLASSIFICATION]` (config-gate), interview-артефакт.
- **Правило «политика — в `stable`, состояние — в `volatile`».** В `stable` попадает только константное
  на всю сессию; всё условное/переходное (текст опросника, факт «профиль пуст») — `volatile`, **после**
  границы stable-префикса (граница — после `mode.policy`). Появление/исчезновение условной добавки не
  инвалидирует кэшируемый префикс.
- **Идемпотентность и byte-stability.** `compose()` собирает промпт из состояния **заново** (никаких
  `base + …`); при неизменном состоянии `stablePrefix` побайтово стабилен. В `stable` не попадает
  `Date.now()` с секундной точностью (дата — только date-only). Это by design устраняет баг дублей блоков
  после `plan_enter`/`plan_exit`.
- **Режим/план/todo — chronological system-сообщения истории, не system prompt.** `MODE_*`/`PLAN_MODE_*`/
  `[APPROVED PLAN]`/`[TODO]` уходят durable `role: system` сообщениями (`metadata.type` =
  `mode_change`/`plan_updated`/`todos_updated`/`agent_switch`; скрыты **только в UI**), для LLM —
  обёрткой `<system-state type="…">`. Обоснование — иерархия инвалидации `tools → system → messages`:
  событие хода не должно обнулять system-кэш. Смена режима/плана/todo system baseline не пересобирает.
- **CachePolicy — в провайдерах/Gateway, не в тулах** (ADR-036): Anthropic — `system` массивом блоков с
  `cache_control` (≤4 breakpoint'а, приоритет tools → system → messages; два system-breakpoint'а — конец
  stable-префикса и конец system; TTL по умолчанию `5m`, опция `1h` не включена); OpenAI —
  `prompt_cache_key` (стабильный id сессии; `agentKey` в ключ не входит — изоляция агентов через их
  `staticPrefix`/`promptStates`) + `stream_options.include_usage`. Маркеры ставятся **после**
  нормализации/санитайза; `none` отключает маркеры и ключ.
- **Usage/статистика.** Нормализованный `Usage` (`input`/`output`/`nonCached`/`cacheRead`/`cacheWrite`/
  `reasoning`/`total`, инвариант `nonCached + cacheRead + cacheWrite = input`); стоимость с cache
  read/write; **cache hit rate** — доля кэшированных входных токенов сессии (сессия/API/UI).
- **Состояние промпта — per-agent.** `session.promptStates[agentKey]` (`agentKey` = agentRole либо
  `__default__`): generation, `staticPrefixHash`, закреплённые байты `staticPrefix`, блочные хэши.
  Пишется **только при смене generation**; в каждом assistant-сообщении — компактный `promptMeta`
  (`agentRole`, generation, `expected: hit|miss`, фактические cachedTokens, `validated`). Смена режима и
  модели/провайдера generation **не** поднимают (смена модели даёт `expected: 'miss'` без пересборки
  stable-префикса); смена агента не переиспользует чужой префикс. `promptStates` саб-агентов не персистятся.
- **Прозрачность.** Манифест источников (`key`/`label`/`tier`/`chars`/`estTokens`/`status`/`provenance`/
  `source`) + запись `tools` (самый ранний кэшируемый слой, вставляется в конце тира `stable`) + слой
  истории (`PromptHistoryInfo`); `manifest()` и `compose()` используют один обход, есть тест паритета
  «манифест ↔ отправленные байты». API `GET /api/v2/sessions/:id/prompt` (manifest + history +
  promptState + promptMeta) и UI-секция «Состав промпта»; `DebugCollector` проброшен во все точки создания.
- **`ContextSource`-шов** (`{ key, load(ctx) }`) — задел под будущий реестр источников (сейчас источники
  внутри Composer).
- **Тулы постоянны во всех режимах** (plan/act/yolo): `_filterToolsByMode` удалён, ограничения — только
  permission-слой, расширенный осью доступности `ToolAccess` (`allow`/`ask`/`deny`/`unavailable(mode|role)`;
  причина `dependency` — ADR-078). Доступность **не** кодируется в `description` тула (он в tool-префиксе).

Механика модулей/типов — `packages/core/AGENTS.md`; конфиг — `docs/CONFIGURATION.md` (`llm.cache`);
эндпоинт — `docs/API_V2.md` §5.5; UI — `packages/ui/AGENTS.md`.

## Скиллы и slash-команды

Механизм скиллов и `/`-команд (ADR-046). Скилл — папка с `SKILL.md` + supporting-файлами;
скиллы — **инструкции**, новых тулов не регистрируют, единственный core-тул — `skill`.

- **Discovery** (`engine/skills/*`): `{project.workspace}/.synth/skills` (project) >
  `{dataDir}/skills` (instance) > `config.skills.paths` > внешние read-only каталоги
  (`.opencode/skills|skill`, `.claude/skills`, `.agents/skills`, `~/.config/opencode/skills`) >
  `config.skills.urls` (read-only индекс в `{dataDir}/skills-cache`, `trusted:false`).
  Дедуп first-wins, проигравшие — `shadowed`; кэш инвалидируется лениво по mtime/size (`watcher.ts`).
- **Project-trust** (`trust.ts`): скиллы недоверенного проектного каталога (нет в
  `skills.trustedProjectDirs`) видны, но не грузятся — защита от подмены через `git pull`.
- **Каталог в промпт** (`catalog.ts` + Composer): только `name` + обрезанный `description`;
  стабильная часть (system/project) — тир `stable`, session-динамика/`unavailable` — `volatile`.
  Каталог добавляется и саб-агентам (`task`, binding родителя).
- **Тул `skill`** (`tools/skill.ts`): тело `SKILL.md` как `<skill_content>` + base dir +
  ≤10 supporting-файлов; обрезка `ToolOutputStore` (50 KB / 2000 строк); capability-aware —
  при нехватке capabilities делегирование через `task`.
- **Уровни включения** (`scope.ts`, модель ADR-071 §2.4): `system`/`project`/`session`; hard-gate
  (мастер `disabled`, `project.enabled`) — live; дефолты/снапшот (`skillsDefaultOn`) — snapshot;
  дефолт opt-in. Единый резолвер — `resolveSkillAvailability`.
- **Slash-команды** (`engine/commands/*`): резолвинг в core до LLM (UI/CLI/гибрид); встроенные
  (`/help`, `/skills`, `/commands`, `/summary`, `/init`), шаблонные `.md` (`$ARGUMENTS`/`@file`),
  скиллы-как-команды и bundles (`/bundle-name`); права `permission.rules.command`; inline shell
  (`` !`cmd` ``) — opt-in через `execute_shell`. События `skill.invoked`/`command.invoked`;
  builtin `skill-creator` — скилл-инструкция в коде.

Эндпоинты/RBAC — `docs/API_V2.md` §5.17–§5.17.2; конфиг — `docs/CONFIGURATION.md`
(секции `skills`/`commands`); формат `SKILL.md` — `packages/core/AGENTS.md`.

## Проектные инструкции (AGENTS.md)

Автозагрузка репозиторных инструкций (ADR-069) — отдельный тир между глобальной identity
и вложенными подкаталогами.

- **Тиры (не смешивать):** identity (`SOUL.md`/`COMPANY.md`/`ABOUT.md`) → проектные
  инструкции (только при `project.workspace`, ADR-014/ADR-040) → вложенные подкаталоги
  (lazy). Блок `[PROJECT INSTRUCTIONS]` — тир `context` (ADR-070).
- **Discovery** (`engine/context/instructions.ts`, `ProjectInstructionsResolver`): merged chain
  `git root → … → workspace` (глубже = позже = приоритетнее), на каталог ровно один кандидат
  (`AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` (opt-in) > `CONTEXT.md`
  (deprecated)); дедуп sha256; provenance-заголовок `--- from <путь> (<chars> chars[, truncated]) ---`
  (путь — относительно workspace). `config.instructions.sources` (`path`/`url`) встают `before`/`after`
  цепочки; URL — read-only fetch с TTL-кэшем `{dataDir}/instructions-cache` (без фонового таймера)
  и капом `maxBytes`.
- **Обрезка:** head/tail (`headRatio`/`tailRatio`) с маркером
  `[TRUNCATED: see <путь> — read_file(path, offset, limit)]`; кап динамический от окна модели
  (`clamp(windowRatio*window, minChars, maxCharsCeiling)`), общий на цепочку; `maxChars` — override.
- **Threat-scan** (`engine/security/prompt-injection.ts`, ADR-036) до вставки: `block` — блок
  не грузится, `flag` — WARN-строка. Гейты — project-trust (ADR-046, общий с lazy) и
  install-tree guard (внутри дерева исходников Synth — `skipped-install-tree`).
- **Lazy-догрузка** (`engine/context/lazy-instructions.ts`): по аргументам file/shell-тулов
  (`LAZY_TRIGGER_TOOLS`) ищет ближайший instruction-файл вверх (≤`lazy.maxAncestors`), только
  внутри `workspace`, исключая `lazy.excludeDirs`; дедуп (`loaded` + sha256); контент идёт
  **в результат тула** (`[Subdirectory context discovered: <путь>]`), один раз на
  assistant-сообщение, а не в system prompt (prompt-cache). Состояние — per-session в оркестраторе.
- **Кэш/инвалидация:** подписи кандидатов (`engine/file-signature.ts`, `mtime:size`) → результатный
  кэш резолвера (`.clear()` — сброс) + per-turn мемоизация в оркестраторе; TTL-слот подписи для URL.
  Снимок для UI — `GET /api/v2/context/instructions` + событие `context.instructions_loaded`.

Конфиг — `docs/CONFIGURATION.md` (`instructions`); `/init` и скилл `synth-agents-md` — ADR-046.

## Внешние события и хуки

Ядро ADR-030 (min) + ADR-089: события агента и внешние события идут через общую
hook-шину, а создание сессий сведено в один funnel.

- **`HookBus`** (`engine/hooks/hook-bus.ts`) — шина хуков жизненного цикла агента
  (`session_requested`, `external_event`, …); async-хуки с таймаутом
  (`HOOK_ASYNC_TIMEOUT_MS`), результат может заблокировать событие (`blocked`/`reason`).
  Это фундамент; Plugin SDK и загрузка плагинов (ADR-090) **реализованы**.
- **Сущности** (`shared/types/events.ts`, Zod-схемы рядом). `SynthEvent` — нормализованное
  внешнее событие `{id: 'evt_<uuid>', source, type, payload, identity{principalId?, chatKey?,
  threadKey?, roles?}, dedupKey, ts}` (известные `source`: `telegram`/`synth-media`/`webhook`/
  `cron`/`ci`/`ui`; `identity.roles` — потолок прав отправителя, сужает роли профиля);
  `EventBinding` — `{source, chatKey?, threadKey?, sessionId?, mode: bound|ephemeral|queue,
  agentTemplate?, project?}`; `RouteDecision` — `bound|ephemeral|queue|drop|bind`
  (`drop` несёт `reason`+`audited`, `bind` — auto-bind); `EventBindingApiKey` — API-ключ
  привязки (см. ниже).
- **`EventRouter`** (`engine/events/event-router.ts`) — чистое решение по событию
  плюс запись в журнал. Порядок `decide`: `allowedSources` (не в списке → `drop`) →
  dedup по `dedupKey` (ленивый кэш из журнала) → явный `EventBinding` по
  `threadKey`/`chatKey` → зарегистрированные `RouteRuleProvider` (первый непустой) →
  фоллбек `drop no_route`. Все дропы «аудируемые» — событие не теряется молча.
- **`EventBinding`** (`bound | ephemeral | queue`) связывает внешний адрес
  (`source` + `chatKey`/`threadKey`) с сессией/шаблоном; хранится в
  `EventBindingStore`, решения — в `EventJournalStore` (журнал, ADR-005).
- **API-ключи привязок** (`EventApiKeyStore`, `{dataDir}/events/api-keys.json`, ADR-089/ADR-052) —
  первый срез публичного API: обязательная уникальная (глобально) метка `label` +
  `description`/`expiresAt`/`rateLimitPerMinute`, мягкий отзыв (`revoke`); секрет
  `synth_evt_<base64url>` хранится только как sha256-хеш,
  наружу отдаётся один раз; приём `POST /api/v2/events` по `Authorization: Bearer <binding-key>`
  аутентифицирует без пользовательских кред (source/чат из привязки), использование пишется
  в журнал (`keyId`); per-key rate limit — лимит ключа либо глобальный `events.keyRateLimitPerMinute`
  (`KeyRateLimiter`, 429); ключи — инстанс-локальные (не переносятся publish/fork).
- **Service-key** (`ServiceApiKeyStore`, `{dataDir}/service-keys.json`, ADR-052 этап I) — независимый
  от binding-key scoped-ключ инстанса для внешних сервисов: секрет `synth_svc_<base64url>` (at-rest
  sha256), обязательная уникальная `label`, `roles`/`scopes`/`allowedProjects` (проектная проекция)/
  срок/лимит; аутентифицирует машину в синтетического пользователя, `scopes` ограничивают эндпоинты
  (`requireScope`, `packages/core/src/server/service-scope.ts`), проекция — sessions/events/schedules.
  Эндпоинты CRUD и scopes — `docs/API_V2.md` §5.28/§1.
- **`RequestSessionService`** (`engine/events/request-session.ts`) — единый funnel
  создания сессии: `request` (явное создание из UI/CLI/агента, эмит
  `session_requested`) и `handleEvent` (`external_event` → `decide` → материализация
  `deliver` → `record`). Через него идёт и `POST /api/v2/sessions`; внешний контракт
  эндпоинта не изменился.
- **`EventIngress`** (`engine/events/ingest.ts`) — точка приёма: нормализует вход в
  `SynthEvent` (id `evt_<uuid>`, дефолтный dedup-ключ) и передаёт в funnel.
- **Webhooks** (`WebhookStore` + `WebhookService`, ADR-052 этап II) — **исходящий** мост,
  обратный контур к входящим событиям: `WebhookService` подписывается на все события шины
  (`eventBus.subscribeAll`), фильтрует их паттернами подписки (`matchWebhookEvent`) и шлёт
  подписчикам HTTP-POST с HMAC-SHA256-подписью; retry/backoff с джиттером, дедуп по
  (подписка + событие), таймаут, журнал доставок (`{dataDir}/webhooks/deliveries.jsonl`) и
  адресная политика цели доставки — `egress.webhooks` (`engine/net/egress-guard.ts`:
  `checkEgressUrl`/`fetchWithEgressGuard`, редиректы с проверкой каждого хопа; ADR-099). Эндпоинты и
  формат подписи — `docs/API_V2.md` §5.29; конфиг — `docs/CONFIGURATION.md` (секции `webhooks`, `egress`).
- **Ephemeral-сессии** для внешних событий получают `expiresAt` из `ttl`
  (`config.events.ephemeralTtl`, default `24h`); очистка — `startEphemeralSweeper`.
  Режим `queue` доставляется как `defer` (сообщение в очередь без старта процессора).

Цепочка:

```text
внешнее событие → EventIngress (SynthEvent) → RequestSessionService
  → HookBus (external_event) → EventRouter.decide → материализация
  → сессия (bound/ephemeral/queue) → deliver → журнал/UI-событие
```

API-эндпоинты и RBAC — `docs/API_V2.md` §5.26; конфиг — `docs/CONFIGURATION.md`
(секция `events`). Источники/интеграции: шедулер ADR-051 (cron), API-ключи привязок, service-key
со scopes/проектной проекцией, webhooks, public-OpenAPI (28 операций, `GET /api/v2/openapi.json`)
и SDK `@itphx/synth-sdk` — **ADR-052 закрыт целиком (этапы I–IV: включая перевод Telegram-шлюза
на scoped service-key)**; первый add-on — Telegram-шлюз (`addons/synth-gateway-telegram`) —
реализован; **плагины реализованы** (Plugin SDK, ADR-090); пайплайны — остаток ADR-100 (движок реализован, ADR-101).

## Egress-слой (исходящие соединения)

Все исходящие HTTP(S)-вызовы Synth идут через единый слой (ADR-099), а не через «сырой» `fetch` в
подсистемах. Три ортогональные части:

1. **Доверие TLS/CA (настраивается runtime, применяется при старте).** Секция `security.tls`
   (`caFile`/`caPem`, default mTLS-клиент, `rejectUnauthorized`) и per-host `mappings` из
   **bootstrap-файла** `{dataDir}/security-tls.json` (редактируется в разделе «Сеть» → «Доверенные CA
   (TLS)», читается **до** PostgreSQL) → `initTlsTrust` → глобальный undici-dispatcher с профилями;
   `egressFetch` — `fetch` с явным dispatcher (`packages/core/src/security/tls.ts`). Приоритет
   `SYNTH_TLS_*` > runtime > config; PostgreSQL использует тот же профиль по host, TLS к прокси —
   отдельно (`proxy.tls`).
2. **Адресная политика (runtime, live per-request).** `egress.tools`/`egress.webhooks` и
   `mcp.networkPolicy` (`{mode, list, exceptions}`) резолвятся из стора на каждый запрос; проверка —
   `engine/net/egress-guard.ts` (`checkEgressUrl`/`fetchWithEgressGuard`, редиректы per-hop, fail-closed).
   Изменения — аудит `{dataDir}/audit/security.jsonl`, запросы — журнал `{dataDir}/audit/egress.jsonl`.
3. **Прокси (настраивается runtime, применяется при старте).** Секция `proxy` (HTTP/HTTPS/SOCKS5,
   Basic, TLS/mTLS к https-прокси, `noProxy`, **профили `profiles` и host-правила `rules`**) из
   `config.yaml`/env **или runtime-оверрайда из админ-UI**
   (`RuntimeSettings.proxy`, `settings.json`/PG; приоритет `SYNTH_PROXY_*` > runtime > config) →
   `EgressDispatcher` (`packages/core/src/security/proxy-dispatcher.ts`): маршрут per-origin по
   `resolveProxyRoute` — `noProxy` (важнее всего) → правила (первое совпадение) → `mode: all` ?
   `defaultProfile` : direct; fail-closed `EGRESS_PROXY_UNAVAILABLE`, `407` без direct-фоллбека.
   **TLS к цели и TLS к прокси независимы:** доверие к цели — `security.tls` (CA/`mappings`), к
   прокси — `proxy.profiles.<name>.tls`/`proxy.tls` (свой CA/mTLS у каждого профиля); клиентский
   серт к прокси не подменяет серт к цели. Применение — двумя шагами: ранний
   `initTlsTrust` (TLS/PG), затем `applyStartupProxyConfig` после сборки хранилища и **до** deps;
   `PUT /settings/proxy` только сохраняет (`restartRequired`), live-переключения нет. git получает прокси
   child-env (`http_proxy`/… через libcurl), `stdio`-MCP — env дочернего процесса (per-host маршрут они
   не поддерживают — один прокси; в `mode: selected` прокси-env им не ставится); PostgreSQL не
   проксируется. **Доменная аутентификация прокси (NTLM/Negotiate/Kerberos) в приложении не
   реализуется** — делегируется промежуточному egress-шлюзу (Squid `login=NEGOTIATE` / `px`), типовой
   K8s-схеме `Synth → HTTP CONNECT → шлюз → Kerberos/NTLM → корпоративный прокси` (ADR-099 п. 25);
   SOCKS5 — best-effort без target CA/mTLS, не целевой для K8s (п. 26).

При включённом прокси адресная политика работает в **proxied-режиме**: проверяются схема и
hostname-правила, DNS/CIDR не выполняются (адрес резолвит прокси); для хостов из `noProxy` — полная
проверка. Фактический маршрут пишется в журнал (`via`: `proxy`/`direct`/`fallback`). API — `docs/API_V2.md`
§5.21 (`settings/egress/*`, `settings/proxy*`), конфиг — `docs/CONFIGURATION.md` (`egress.*`, `proxy.*`,
`security.tls`); ограничения (NTLM/Kerberos, SOCKS + CA к цели, IP/SNI) — ADR-099.

## Жизненный цикл инстанса и перезапуск

Часть настроек применяется только при старте процесса — глобальный undici-dispatcher и доверие TLS/CA
(`security.tls`/`mappings`), прокси (`proxy`: профили/правила), пул PostgreSQL, MCP-клиенты; плюс
офлайн-операции (отложенное восстановление `applyPendingRestore`, авто-миграции схемы). Поэтому
«применить настройку» и «перезапустить» — разные операции: `restartRequired` показывает расхождение
saved/running, а применение — рестарт.

Перезапуск **не выполняется внутри процесса** (переинициализировать процесс-глобальные singleton'ы
безопасно нельзя). Контракт (ADR-092): `POST /api/v2/maintenance/restart {confirm:true}` (ADMIN) →
202, graceful shutdown → **exit code 75** (`EX_TEMPFAIL`), процесс поднимает внешний супервизор —
K8s Deployment (`restartPolicy: Always`), Docker (`restart: unless-stopped`), systemd
(`Restart=on-failure`), pm2, либо локальный `scripts/dev.sh` (режим `supervisor`). Режим —
`SYNTH_RESTART_MODE=disabled|process|supervisor` (default `disabled`; CLI `synth serve --restart-mode`
приоритетнее). `GET /health` и `/api/v2/health` отдают `startedAt` — UI ждёт его изменения после
рестарта. В multi-replica endpoint перезапускает только pod, обработавший запрос; для всего Deployment —
`kubectl rollout restart`. Запрос фиксируется в аудите обслуживания (`restart.requested`).
