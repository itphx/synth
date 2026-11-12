# PROP-135: Единый контур исполнения: пулы, профили и жизненный цикл исполнителей

> **Статус:** 🧩 Предложение — при `execution.mode=remote` **все** ФС/git/shell-операции идут только на исполнителе; пулы `project`/`session`, профили, `sandbox_exec` и отдельный provisioner
> **Решение до:** 2026-11-30
> **Дата:** 2026-11-12
> **Обсуждено:** 2026-11-11…12 — решения владельца зафиксированы в тексте; ожидает утверждения и отмашки на реализацию.
> **Источник:** обсуждение 2026-11-11…12 (аудит места исполнения тулов, модели доверия shell, изоляции исполнителя).
> **Связано:** [ADR-077](./adr-077-runtime-toolchain.md), [ADR-075](./adr-075-project-workspace-provisioning.md), [ADR-114](./adr-114-git-worktrees.md), [ADR-094](./adr-094-observability-metrics.md), [ADR-090](./adr-090-extension-api.md), PROP-082 (принято как [ADR-077](./adr-077-runtime-toolchain.md), файл удалён), [PROP-105](./prop-105-multi-replica-coordination.md), [PROP-136](./prop-136-shell-trust-audit-command-policy.md), [PROP-137](./prop-137-executor-isolation-nonroot-network.md), [PROP-138](./prop-138-plugin-tool-execution-contour.md)

## Решение (предложение)

Принята рамка: **при развёрнутом исполнителе все операции с файлами, git и shell выполняются только на нём**. Control plane перестаёт быть местом исполнения агентских команд; он остаётся местом принятия решений и хранения состояния. Реализация не начата — это предложение.

### Режимы

`execution.mode = inline | remote` — как сейчас ([ADR-077](./adr-077-runtime-toolchain.md)). Разница в том, что `remote` становится **полным**: на исполнителе выполняются

- агентские файловые тулы: `read_file`, `list_directory`, `write_file`, `edit_file`, `delete_file`, `create_directory`, `patch`, `attach_workspace_file`, `save_attachment`, `send_attachment`;
- поиск: `glob`, `grep_files`;
- git: все `git_*`;
- shell: `execute_shell`.

В control plane остаются: LLM (через `GatewayProvider`, [ADR-036](./adr-036-llm-gateway.md)), хранилище (сессии, проекты, события), blob-хранилище ([ADR-116](./adr-116-instance-state-and-blob-ports.md)), HTTP FS-роуты, provisioning workspace ([ADR-075](./adr-075-project-workspace-provisioning.md)), permission-слой ([ADR-029](./adr-029-granular-permissions.md)), MCP HTTP и шлюзы.

### Контракт порта

`ExecutionPort` расширяется до **`exec + fs + stream`**:

- `fs`: `realpath`, `stat`, `readdir`, `readFile` (offset/limit), `writeFile` (atomic tmp→rename), `edit` (read-modify-write с hash/if-match), `mkdir`, `remove`, `patch`;
- `stream`: бинарные чтения вложений и медиа (multipart; base64 — только для малых файлов), blob-хранилище остаётся в control plane;
- в `GET /capabilities` — `features.fs`; `execution.mode=remote` без `features.fs` → файловые тулы **fail-closed** (никакого тихого fallback в control plane);
- контрактные тесты **общие** для `inline` и `remote`;
- **канонические пути** (`realpath`, `stat`) получаются с исполнителя; решение permission-слоя принимается в control plane по этим путям; для `grep_files`/`glob` политика применяется к путям совпадений;
- архитектурный тест/линт: файловые тулы не импортируют `node:fs*` (исключение — `InlineExecutionPort`).

### Пулы

`execution.remote.pooling`:

| Режим | Ключ пула | Смысл |
|---|---|---|
| `project` (по умолчанию) | `project:<id>:<class>:<profile>` | тёплый под живёт, пока жив проект; им пользуются сессии проекта |
| `instance` (совместимость) | текущий Service | поведение как сегодня |
| `session` | `session:<id>:<class>:<profile>` | эксклюзивный под на сессию |

Классы пулов: `exec` (ФС/git/shell), `browser` (Playwright/Chromium), plugin-runtime (см. [PROP-138](./prop-138-plugin-tool-execution-contour.md)). Браузерный пул — **всегда** per-session эксклюзивный, создаётся лениво при первом браузерном вызове, короткий TTL.

### Профили

Профиль = образ, flavor, resources, сетевой класс, `runtimeClass`, монтирования, env. Каталог профилей задаёт **только ADMIN** (`executor.profiles.<name>` в конфиге/чарте). Профиль **не может** добавлять секреты инстанса или привилегии.

### Binding сессии

Приоритет выбора профиля:

1. `task.executor_profile`;
2. `session.settings.executorProfile`;
3. `agentDefinition.executorProfile`;
4. `project.executor.profile`;
5. `execution.remote.defaultProfile`.

Валидация fail-closed: профиль существует ∧ входит в `project.executor.allowedProfiles` ∧ входит в `agentDefinition.allowedProfiles`. Binding **иммутабелен** на время сессии; смена среды — новый сабагент или `sandbox_exec`. Вызывающему агенту не нужно угадывать: дефолт берётся из определения целевого агента (например, `devops`).

### `sandbox_exec`

Отдельный тул: `{profile, commands[], cwd?, timeout_ms}`. Провижинит или берёт тёплый под профиля, монтирует тот же project subPath, выполняет команды, живёт до TTL (5–10 мин), затем удаляется. Квоты: `maxSandboxesPerSession` (1–2), `maxSandboxLifetimeMs`, без фоновых процессов (или фон с TTL). Проходит **тот же** аудит и внешний чекер, что `execute_shell` ([PROP-136](./prop-136-shell-trust-audit-command-policy.md)), запись аудита — `scope: 'sandbox'`.

### Provisioner

Отдельный Deployment с узким RBAC (`pods`/`secrets` в своём namespace) и провайдер-нейтральным HTTP-контрактом:

```
POST /v1/pools            {key, profile, projectId, mounts}
POST /v1/pools/:id/touch
POST /v1/pools/:id/drain
DELETE /v1/pools/:id
GET  /v1/pools?key=
GET  /v1/capabilities
```

Провайдеры: `static` (docker-compose/standalone) и `kubernetes`. `ensure(key)` идемпотентен. **Backend не ходит в K8s API.** Источник истины о существовании пулов — provisioner + labels (`synth.io/pool-key`, `synth.io/profile`, `synth.io/managed-by`); отдельной mutable-таблицы пулов в БД нет.

### Монтирование (per-project)

Каталог проекта + `.worktrees/<projectId>` — два subPath одного RWX-тома, те же абсолютные пути (совместимо с [ADR-114](./adr-114-git-worktrees.md)). В managed при `storage.workspaceOutsideRoot=deny` проект вне `workspacesRoot` в per-project режим не попадает.

### Жизненный цикл (дефолты)

| Параметр | Значение |
|---|---|
| `startTimeoutMs` | 120 000 |
| `idleTimeoutMs` (проект) | 900 000 |
| `sessionIdleTimeoutMs` | 300 000 |
| `maxLifetimeMs` | 12 ч |
| `drainGraceMs` | 30 000 |
| `maxPools` / `maxPods` | 50 / 100 → `429 EXECUTOR_CAPACITY` без тихого фоллбека |
| `minWarm` | 0 |

Reaper живёт в provisioner (**один писатель**); `lastExecAt` берётся у исполнителя (`/capabilities` или `/usage`), а не из памяти бэкенда.

### Метрики

`synth_executor_pool_state{profile,scope}`, `synth_executor_provision_total{profile,outcome}`, `synth_executor_provision_seconds{profile}`, `synth_executor_dispatch_wait_seconds{profile,cold}`, `synth_executor_idle_terminations_total{profile}`, `synth_executor_capacity_rejections_total`, `synth_executor_pool_errors_total{reason}` — в контракте [ADR-094](./adr-094-observability-metrics.md) (лейблы из конечных множеств, без `session_id`).

### HA

Ключ пула выводится из сессии/проекта; `ensure` идемпотентен; токен резолвится любой репликой; reaper — один писатель; индекс фоновых процессов (`processId → poolKey/url`) хранится в общем хранилище; всё остальное stateless. Совместимо с [PROP-105](./prop-105-multi-replica-coordination.md).

### UI и события

`executor.provisioning {project, session, profile, phase}` → индикатор в чате, затем `executor.ready`; таймаут — понятная ошибка `execution.pool_unavailable` с retry. События идут в существующей шине ([ADR-024](./adr-024-eventhub-transport.md)/[ADR-118](./adr-118-message-stream-v2.md)), новых каналов нет.

## Границы

Не входит: сборка образов и состав toolchain ([ADR-077](./adr-077-runtime-toolchain.md), PROP-082 — принято), изоляция ([PROP-137](./prop-137-executor-isolation-nonroot-network.md)), доверие shell и аудит ([PROP-136](./prop-136-shell-trust-audit-command-policy.md)), контур плагинов ([PROP-138](./prop-138-plugin-tool-execution-contour.md)), код (реализация — после утверждения).

## Этапы

- **Ф1** — `realpath`/`stat`/`readdir` через порт, `read_file`/`list_directory` на исполнителе, `features.fs`, lint-инвариант «файловые тулы без `node:fs`».
- **Ф2** — `write`/`edit`/`delete`/`mkdir`/`patch`.
- **Ф3** — вложения и `stream`.
- **Ф4** — provisioner, профили, project-пулы, монтирование.
- **Ф5** — `sandbox_exec` и браузерный класс.
- **Ф6** — binding агентов/сабагентов и индекс фоновых процессов.

Критерий каждого этапа: typecheck/lint/tests, контрактные тесты `inline` и `remote`, e2e в split.

## Влияние на документы

После реализации: [ADR-077](./adr-077-runtime-toolchain.md) → `⛔ Заменено` и `legacy/` (сейчас — только аддендум-указатель); `docs/EXECUTION.md` — переписать; `docs/CONFIGURATION.md` — новые секции; `docs/API_V2.md` — admin API пулов; `docs/OBSERVABILITY.md` — метрики; `charts/synth/README.md` — values; `packages/core/AGENTS.md` и корневой `AGENTS.md` — инварианты.

## История

- 2026-11-12 — документ создан: зафиксированы решения владельца по месту исполнения тулов, пулам, профилям и provisioner (обсуждение 2026-11-11…12).
