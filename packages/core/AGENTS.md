# @itphx/synth-core

> Точечные правила пакета. Общие инварианты, команды, порты и стиль — в корневом
> `AGENTS.md`; HTTP-спека — в `docs/API_V2.md` (здесь не дублируется).

## Роль и границы

`@itphx/synth-core` — единственный источник движка и общей логики Synth: сессии,
очередь, контекст, LLM, MCP, permissions, безопасность, хранилище, HTTP API v2
(Hono), гибридный режим, CLI.

- **backend импортирует core; core не импортирует backend/ui/runner** — зависимости
  идут только «вниз»: `shared → core → backend/ui`.
- Режимы: **standalone** (`synth serve`/`synth chat`, свой HTTP API + локальный
  `FileStore`, один API-ключ); **managed** (core как библиотека внутри backend:
  OIDC/RBAC/runner — на стороне backend; `createStandaloneApp` поднимает
  `@itphx/synth`); **hybrid** (локальный core + удалённый backend).
- `src/main.ts` — точка входа CLI (внутренний инструмент: `serve`, `chat`,
  `connect`, `project publish|fork`, `config`, `session`, `audit`, `update`).
  Публичный CLI `synth` — это пакет `@itphx/synth`, не core.

## Инварианты core

- Публичные точки входа: `createStandaloneApp()` (`server/app.ts`),
  `createToolRegistry()` (`engine/tools/index.ts`), `createAgentRegistry()`
  (`engine/agents/index.ts`), `FileStore`/`JsonStore`/`ProjectStore`/
  `FileProfileStore`/`RuntimeSettingsStore`/`SSHKeyStore` (`storage/*`), `ChatOrchestrator`
  (`engine/orchestrator.ts`), `SessionManager` (`sessions/manager.ts`),
  `QueueProcessorManager` (`queue/processor.ts`), `EventBus` (`events/bus.ts`).
- Движок stateless: история и состояние — на бэкенде; движок получает историю +
  новое сообщение + контекст (AD-022).
- Любой LLM-вызов — через `GatewayProvider`
  (`engine/gateway/gateway-provider.ts`: guard, обфускация, rate limit, аудит);
  провайдера напрямую не дёргать (AD-036).
- Permissions и режимы — только через `PermissionEvaluator`
  (`engine/permission/evaluator.ts`): `plan`/`act`/`yolo`,
  `allow`/`deny`/`ask`; не хардкодить проверки в тулах (AD-025/028/029).
- Хранилище — только через `FileStore`/`JsonStore` (JSON + атомарная запись
  tmp→rename, AD-005); писать в `$SYNTH_DATA_DIR` в обход API/FileStore нельзя.
- Конфиг — через `@itphx/synth-shared/config` (AD-023); приоритет
  CLI-флаги > `SYNTH_*` env > config.yaml > defaults.
- Секреты at-rest (SSH-ключи, AD-076) — AES-256-GCM (`security/crypto.ts`);
  мастер-ключ — `SYNTH_SECRET_KEY` > `security.secretKey` > файл
  `{dataDir}/secrets/master.key` (`0600`, каталог `0700`, создаётся при первом
  запуске); секреты не отдаются наружу (`reveal()` — только для git). Ротация
  мастера — `synth secrets rotate` (`security/rotate.ts` + `SSHKeyStore.rotateMasterKey`,
  preflight + dry-run); ключи с passphrase — через askpass (`git/ssh-env.ts`),
  наружу — `sshkey.env_failed`.
- План — в `project.plan`, todo — в `session.todos`; состояние менять только
  тулами `plan_*`/`todo_*`, не JSON-блоком в ответе модели (AD-039).
- Ошибки LLM — через `classifyLlmError`/`isLlmErrorRecoverable`
  (`engine/llm-error.ts`); строки движка — по ключам `shared/i18n` (AD-041).
- События сессии — локальный `EventBus`; UI слушает через EventHub/TransportClient
  (`/ws/events`) с SSE-фоллбеком (AD-008/009/024).

## Гибрид (core-специфика)

- Флаги `serve`: `--connect <url>` (адрес backend), `--token <api-key>`,
  `--oidc-issuer`/`--oidc-client-id` (fallback дискавери) — `src/main.ts`.
- `RemoteBackendClient` (`remote/client.ts`) — HTTP-клиент к backend;
  `RemoteEventBridge` (`remote/event-bridge.ts`) — мост SSE `/api/v2/events` →
  локальный `EventBus`.
- Идентификация: id удалённых сущностей — `remote:<uuid>`, маршрутизация по полю
  `origin`; id не смешивать (`remote/aggregate.ts`).
- LLM локальных сессий в гибриде — через `RemoteProvider` →
  `POST /api/v2/llm/chat/completions` (`providers/remote.ts`); режим — `remote.llm`
  (`server` | `local` | `auto`).
- Runtime-подключение: `connectRemote*`/`disconnectRemote` на хэндле
  `createStandaloneApp`; профили серверов — `profiles.ts` (`getProfilesPath(home)` →
  `<home>/profiles.json`; без home — XDG `~/.config/synth/profiles.json`),
  credentials — `remote/credentials.ts` (`defaultCredentialsPath(home)`); в
  `createStandaloneApp` путь задаётся опцией `profilesPath` рядом с
  `remoteCredentialsPath` (AD-042/045/079).

## Карта модулей

- `main.ts` — CLI/точка входа (`serve`, `chat`, `connect`, `project publish|fork`, `secrets rotate`, …).
- `server/app.ts` — `createStandaloneApp`: Hono, WS, статика UI, provisioning.
- `server/routes/*` — `health`, `hybrid`, `auth`, `sessions`, `messages`, `projects`,
  `project-transfer`, `providers`, `models`, `agents`, `fs`, `queue`, `updates`,
  `settings`, `dictionaries`, `mcp`, `skills`, `commands`, `skill-bundles`,
  `skill-scope`, `git`, `ssh-keys`.
- `server/chat.ts`, `server/proxy.ts`, `server/serialize.ts`,
  `server/connection-watcher.ts` — одиночный чат, проксирование remote, сериализация,
  watcher подключения. Проксирование — `REMOTE_PROXY_PREFIXES` (простые префиксы) +
  `REMOTE_PROXY_PATTERNS` (regex: nested `/api/v2/agents/:id/ssh-keys`; прочие
  подпути `/agents` — локальны).
- `engine/orchestrator.ts` — `ChatOrchestrator` (цикл LLM + Tool Use).
- `engine/gateway/*` — `GatewayProvider`, guard'ы, обфускация, аудит, rate limit.
- `engine/router/*` — routing моделей и micro-model слой (AD-034/035).
- `engine/permission/*` — permissions; `engine/security/*` — injection/shell/protected paths; слой доступности (`engine/permission/availability.ts`) учитывает причину `dependency` — нет внешней программы тула (`engine/tools/runtime-deps.ts`, AD-078); `security/crypto.ts` — AES-256-GCM и мастер-ключ секретов, `security/rotate.ts` — ротация мастера (AD-076).
- `engine/context/*` — `ContextBuilder`, `ContextOptimizer`, `ContextConfig`, интервью.
- `engine/agents/*` — `AgentRegistry`, определения агентов, режимы, нормализация.
- `engine/mcp/*` — `McpClient`/`McpManager`, настройки MCP.
- `engine/skills/*` — discovery/реестр/каталог/загрузка/CRUD скиллов (AD-046 Фаза 1).
- `engine/commands/*` — slash-команды и bundles (AD-046 §7): `parser`/`template`/
  `discovery`/`registry`/`bundles`/`builtin`/`resolver`/`service`; резолвинг в core
  до LLM, событие `command.invoked`.
- `engine/tools/*` — `ToolRegistry` + встроенные тулы (fs, shell, git, search, web,
  plan, todo, project, task, skill); git-тулы принимают необязательный `repo_path`
  (containment внутри `project.workspace`), SSH-окружение — `engine/tools/git-ssh.ts`
  (AD-076; ошибки — `sshkey.env_failed`). Запись проектных данных (`project_log_write`/
  `project_invariants_write`/`plan_write`) гейтится `engine/tools/project-access.ts`
  (`canEditProject`, AD-075/D5). `engine/tools/runtime-deps.ts` — детект внешних
  бинарников (`git`/`rg`/`sh`, fail-open, кэш) и карта `TOOL_RUNTIME_DEP`; отсутствие
  программы даёт `unavailable(dependency)` (AD-078), тулы из реестра не удаляются.
- `engine/llm-error.ts`, `engine/system-messages.ts` — таксономия ошибок и i18n-ключи.
- `git/*` — `git-service.ts` (clone/init/fetch/remove/log, `simple-git`) и
  `ssh-env.ts` (`GIT_SSH_COMMAND`, temp-ключ `0600`; passphrase — askpass-скрипт
  `0700` + `SSH_ASKPASS_REQUIRE=force`, `env_failed`).
- `storage/*` — `FileStore`, `JsonStore`, `ProjectStore`, `FileProfileStore`,
  `RuntimeSettingsStore`, `McpRegistryStore` (единый реестр MCP, AD-071),
  `SkillStore`, `CommandStore`, `SkillBundleStore` (AD-046), `SSHKeyStore`
  (`secrets/ssh-keys`, шифрование at-rest, AD-076).
- `queue/processor.ts` — `QueueProcessor`/`QueueProcessorManager`.
- `remote/*` — клиент, сессии, credentials, device-flow, transfer, aggregate, event-bridge.
- `providers/*` — `ProviderFactory`, `BaseProvider`, OpenAI/Anthropic/Ollama/Remote.
- `profiles.ts` — реестр серверных профилей гибрида.
- `prompts/` (system, roles, subagents, security), `definitions/`
  (`protected-paths.json`, `shell-policy.json`), `dictionaries/` — ассеты движка.

## Правила добавления тула / роута

- Тул: реализовать `ToolDefinition` (Zod `parameters` + `capabilities:
  ToolCapability[]`) и добавить в `ALL_BUILTIN_TOOLS` (`engine/tools/index.ts`);
  доступность — по capability, а не по имени в оркестраторе.
- Права на тул — правилами permission-слоя (`engine/permission/*`), не `if`
  внутри `execute`.
- Строки `description` и результаты — через `t()`/`i18n()`
  (`engine/system-messages.ts`, ключи `shared/i18n`), не литералами (AD-041).
- Публичный роут: фабрика в `server/routes/*`, монтирование в `server/app.ts`
  (`app.route('/api/v2/...', ...)`); типы/схемы — из `@itphx/synth-shared`.
- Переиспользуемые фабрики — `createXxxRoutes(auth, deps, opts)` (общие для core и
  backend): `auth` — структурный `{ requireAuth: Middleware }`, совместим с backend
  `AuthKit` без каста (исключение — `createSettingsRoutes` принимает core-`AuthKit`);
  `opts` — guard'ы (`writeGuard`/`detailGuard`/`testGuard`/`canAccess`), `messages`
  (функции `(c) => string`: core — литералы, backend — `t()`), специфичные флаги и
  хуки. Гибридные ветки активны только при переданном optional-dep
  (`getRemoteClient`). Публичные типы — в `src/index.ts`. Существующие фабрики:
  `createSettingsRoutes`, `createDictionaryRoutes`, `createProviderRoutes`,
  `createModelRoutes`, `createSessionRoutes`, `createGitRoutes`,
  `createSshKeyRoutes`, `createAgentSshKeyRoutes`.

## MCP

- Транспорты: stdio (`StdioClientTransport`) и Streamable HTTP
  (`StreamableHTTPClientTransport`) — `engine/mcp/client.ts`.
- Лимиты: connect 60 c; tool timeout 120 c (`config.timeout`, мс); результат
  усечён до 30 000 символов (`MAX_TOOL_RESULT`).
- Circuit breaker: 5 ошибок → блокировка на 60 c (`engine/mcp/manager.ts`).
- Тулы регистрируются с префиксом `{serverName}_{toolName}` и capability
  `ToolCapability.MCP`; деобфускация аргументов — в `execute` через `ObfuscationMapStore`.
- HTTP: `POST /api/v2/mcp/probe` (`server/routes/mcp.ts`); доступность MCP по
  режимам — `GET/PUT /api/v2/settings/mcp`. Отдельного `/mcp/session/:id` в core нет.
- Единый реестр серверов — `McpRegistryStore` (AD-071): уровни system/project/session,
  скоуп — `engine/mcp/scope.ts`, сетевой доступ — `engine/mcp/network-policy.ts`
  (на старте применяется `mergeMcpNetworkPolicy(config, runtime)`).

## Тесты и запуск

- Тесты: `pnpm --filter @itphx/synth-core test` (Vitest); точечно —
  `pnpm --filter @itphx/synth-core test -- --run src/engine/tools/task.test.ts`.
- Сборка: `pnpm --filter @itphx/synth-core build`; запуск собранного —
  `node dist/main.js serve` (`package.json`, scripts `start`).
- Dev-сервер — `./scripts/dev.sh core` (порт core — в корневом `AGENTS.md`).
- Публичный `synth` — пакет `@itphx/synth`; не добавлять в core команды, которых
  нет в `src/main.ts`.

## Чего не делать

- Не импортировать `backend`/`ui`/`runner` из core (обратное направление).
- Не вызывать LLM мимо `GatewayProvider` (AD-036).
- Не писать в `$SYNTH_DATA_DIR` в обход `FileStore`/`JsonStore` (AD-005).
- Не хардкодить permission-проверки в тулах (AD-025/028/029).
- Не возвращать строки движка без i18n-ключа (AD-041).
- Не вводить TSM/JSON-блок состояния — только Tool Use (AD-039).
- Не дублировать спеку API (`docs/API_V2.md`) и общие правила корня.

## Куда смотреть

| Тема | Документ |
|------|----------|
| HTTP API v2 (спека) | `docs/API_V2.md` |
| Архитектура, слои | `docs/ARCHITECTURE.md` |
| Конфигурация | `docs/CONFIGURATION.md` |
| Гибридный режим | `docs/HYBRID.md` |
| Движки/runner, stateless | AD-022 |
| LLM Gateway | AD-036 |
| План/todo, Tool Use | AD-039 |
| Ошибки LLM / i18n | AD-041 |
| Гибрид | AD-042, AD-045 |
