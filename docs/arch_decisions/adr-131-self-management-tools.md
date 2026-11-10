# ADR-131: Self-management инструменты инстанса и MCP

> **Статус:** ⚠️ Частично
> **Дата:** 2026-11-10
> **Источник:** PROP-048 (срез 2026-11-10)
> **Связано:** [ADR-046](./adr-046-skills-and-slash-commands.md), [ADR-071](./adr-071-mcp-servers-prompt.md),
> [ADR-105](./adr-105-external-credentials.md), [ADR-106](./adr-106-authority-layer.md),
> [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [PROP-056](./prop-056-synth-mcp-server.md).

## Контекст

Две реальные сессии по MCP в standalone заняли 356 сообщений; около 60% времени ушло на
реверс-инжиниринг инстанса: какой порт слушает core, где ключ, как устроен реестр MCP, почему
сервер выключен (opt-in/уровни), что делать с `Session not found` после рестарта MCP-сервера.
Отдельная боль — `project_attach` требовал `projectId`, а списка проектов у агента не было:
пользователь называл имя, агент не мог его разрешить.

API, UI и единый реестр MCP уже существовали; не хватало **агентского self-help-слоя** — доступа
из чата к своему инстансу без curl, ручного разбора `dist` и без чтения секретов.

## Решение

1. **Capability `instance`** и группы read/write (`permission/groups.ts`, plan-блокировка write).
   Встроенный скилл `synth-instance` (команда `/instance`, триггер `auto`) — runbook «что за
   инстанс, какие MCP, как добавить/включить/переподключить, как найти проект/сессию».
2. **In-process инструменты:** `synth_info`, `synth_mcp_list`, `synth_mcp_test`,
   `synth_mcp_add`, `synth_mcp_update`, `synth_mcp_remove`, `synth_mcp_enable`,
   `synth_mcp_reconnect` (capability `instance`).
3. **Project/session discovery:** `list_projects`, `get_project`, `list_sessions`,
   `get_session_info`, `session_rename`; `project_attach` принимает `projectId` **или** `project`
   (id/точное имя), при неоднозначности возвращает кандидатов и не выбирает молча.
4. **Auto-reconnect MCP-сессии** в `McpClient`: типизированная transport-ошибка (`Session not
   found`/`not initialized`/404-session) → `disconnect → connect` → **один** повтор вызова;
   параллельные вызовы делят один reconnect-цикл. `synth_mcp_reconnect` остаётся ручным путём.
5. **CLI** `synth mcp list|add|test|remove|reconnect` — тонкий клиент локального API; ключ
   читается внутри процесса и не печатается.
6. **Redaction** `synth config show` по умолчанию; `--show-secrets` — только явно.
7. **Read-only hybrid awareness** для проектов/сессий: `getRemoteClient` в оркестраторе/`extra`;
   `list_projects`/`list_sessions` сливают локальный и удалённый миры (`origin`, `remote:` id,
   `remote_offline`/`remote_truncated`), `get_project` читает remote-проект, `project_attach`
   запрещает cross-instance (`project.cross_instance`/`project.hybrid_ambiguous`).

### Почему in-process, а не MCP-сервер

PROP-056 (MCP-сервер Synth наружу) — отдельное направление и другой продукт. Здесь нужен доступ
**агента к своему инстансу**: без сетевой аутентификации, без отдельного сервера и без передачи
секретов в контекст. Tool Use внутри хода использует уже существующие порты/сервисы
(`McpRegistryRepository`, `McpManager`, `ProjectStore`, `SessionManager`), поэтому не дублирует
логику HTTP-роутов и не создаёт новых каналов.

## Альтернативы

- **Shell/curl и ручной разбор `dist`** — отклонено: protected paths, секреты в командах/логах,
  хрупкость к пересборке и отсутствие типизированных ошибок.
- **Только UI** — отклонено: агент не может выполнить сценарий из чата, а пользователь вынужден
  переключаться в интерфейс и возвращаться с id/ключами.
- **Внешний MCP-сервер Synth** — отложено: это PROP-056, отдельный контур.

## Последствия

- Секреты не читаются и не возвращаются: у auth только флаги (`localKeyPresent`,
  `apiKeyConfigured`), URL редактируется, `headers`/`env` не выводятся.
- `origin:"instance"`/stdio-мутации — только `ADMIN`; user-записи — автор или elevated (ADMIN/LEAD).
  Project/session-изменения — владелец/редактор (и владелец сессии для session-level MCP).
- План блокирует write-тулы `instance`; MCP остаётся opt-in (новый сервер не включается в сессию).
- `config.yaml mcp.servers` остаётся только сидом; источник истины — реестр.
- Совместимость: сигнатуры `McpClient` (`isConnected`/`tools`/`instructions`) не меняются; после
  reconnect используется тот же объект клиента.
- Cross-world move не поддерживается (нужен transfer: export/import, publish/fork); remote MCP
  merge/management не реализован (отдельный слой PROP-125, не критично).

## Статус в коде

Реализовано:

- `engine/tools/instance.ts`, `engine/tools/instance-mcp.ts` — инстанс/MCP read/write;
- `engine/tools/project-query.ts`, `engine/tools/session-manage.ts`,
  `engine/tools/project-resolve.ts`, `engine/tools/project-manage.ts` — discovery, attach по имени и
  read-only hybrid merge (`origin`, `remote:` id, `remote_offline`/`remote_truncated`,
  `project.cross_instance`/`project.hybrid_ambiguous`);
- `engine/orchestrator.ts` + `server/app/deps.ts`/`server/app.ts` — `getRemoteClient` в
  `OrchestratorOptions`/`ToolContext.extra` (клиент гибрида);
- `engine/skills/builtin.ts` — скилл `synth-instance`;
- `engine/mcp/client.ts` — auto-reconnect истечения MCP-сессии;
- `cli/mcp-commands.ts` — `synth mcp *`;
- `shared/config/redact.ts` — redaction `config show`;
- `server/routes/mcp-registry.ts` — существующий HTTP-контур реестра (переиспользован).

Тесты: `engine/tools/instance.test.ts`, `instance-mcp.test.ts`, `project-query.test.ts`,
`session-manage.test.ts`, `project-manage.test.ts`, `engine/skills/builtin.test.ts`,
`engine/mcp/client.test.ts`, `cli/mcp-commands.test.ts`, `shared/config/redact.test.ts`,
`server/routes/mcp-registry.test.ts`.

## Остаток

- Credential-auth (`auth.kind:'credential'`) в инструментах **запрещён** — привязка доступа через UI/API.
- Read-only hybrid discovery проектов/сессий реализован; остаются **cross-world move** и
  **remote MCP merge/management** — не критичны, tracked in PROP-048.
- Protected-path ложные срабатывания на неразвёрнутых `$VAR`/`${VAR}` не исправлены.
- K8s/Helm deploy-тулы и read-only status-MCP (deploy/status) — вне среза.

## История

- 2026-11-10 — принят срез self-help из PROP-048: skill + instance/MCP/project/session tools,
  auto-reconnect, CLI `synth mcp`, redaction `config show`.
- 2026-11-10 — добавлен read-only hybrid awareness проектов/сессий (merge, `remote:` id,
  cross-instance attach guard).
