# Synth configuration

> 🌐 **English** · [Russian](../CONFIGURATION.md)

> ⚠️ RU-версия обновлена 2026-11-18 (PROP-142/143); перевод отстаёт

> ⚠️ RU-версия обновлена 2026-11-17 (**секция «Таймауты встроенных тулов»** — единица входа
> `timeout` — **секунды**, потолок по режиму исполнения: foreground ≤ 600 с, background ≤ 86 400 с
> (сутки), «без лимита» (`0`) больше нет; `web_fetch` — отдельный потолок 600 с, `question` —
> 300…86 400 с; декларация скрипта `.synth/scripts/*.md` — `timeout` в секундах (1…86 400,
> по умолчанию сутки); внутри всё в миллисекундах (порты, executor-протокол, конфиг-дефолты),
> перевод — на границе; PROP-141 (Часть A) — **переведено**).

> ⚠️ RU-версия обновлена 2026-11-14 (**секция «Группы OIDC» (`auth.oidc.groups`,
> `SYNTH_OIDC_GROUPS_CLAIM`/`SYNTH_OIDC_GROUPS_ALLOW`, ADR-140)** — claim'а с группами и
> allowlist имён (env — csv, приоритет env > config), пустой allowlist → групп нет
> (fail-closed), сверка точная и регистрозависимая — **переведено**).

> ⚠️ RU-версия обновлена 2026-11-08 (**секция «Лимиты запросов» (`limits.*`)** — `sessionOpsPerMinute`
> (тяжёлые операции с сессиями: `import`/`import-batch`/`export`/`fork`/`merge`, запросов в минуту на
> креденту, `0` — без лимита, дефолт `10`), runtime-настройка `/api/v2/settings/limits`, env
> `SYNTH_LIMITS_SESSION_OPS_PER_MINUTE`, приоритет env > runtime > config, счётчики in-memory
> per-process, превышение → `429` + `Retry-After`, публикация — чанки по 20 сессий
> (`IMPORT_BATCH_CHUNK`) и таймаут переноса 120 с — **переведено**).

> ⚠️ RU-версия обновлена 2026-11-08 (**`auth.apiKeyRoles` / `SYNTH_API_KEY_ROLES`** —
> роль пользователя единого API-ключа по умолчанию `USER`, ADMIN — только явной настройкой;
> bind-host backend — loopback вне контейнера, `0.0.0.0` в контейнере — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-05 (**секция «Дефолты оптимизации контекста»** — неизвестное
> окно модели (`0`) считается как 200 000 для авто-триггеров компактизации/суммаризации/
> скользящего окна (`DEFAULT_CONTEXT_WINDOW`, ADR-119) — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-03 (**`storage.maxPreviewBytes`** — лимит предпросмотра
> `/api/v2/fs/raw` (100 МиБ, env `SYNTH_MAX_PREVIEW_BYTES`, `resolveMaxPreviewBytes`) — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-03 (**секция «Каталог моделей»** — слой `compatibility`: поля
> `supportsNativeVideo`/`nativeAudioFormats` — нативные видео/аудио (ADR-117 × ADR-115) и их
> эвристика по типу протокола и RouterAI-совместимому хосту — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-02 (**секция «Вложения сообщений» (`attachments.*`)** — `compression` (сжатие на отправке), `thumbnail` (серверные миниатюры), `maxChunkBytes` (chunked-загрузка) — **переведено**); RU-версия обновлена 2026-11-02 (**секции «Вложения сообщений» (`attachments.*`) и «Лимиты загрузки и обратный прокси»** — `maxBytesPerFile` по умолчанию 100 МиБ, nginx/Apache/ingress: транспортный лимит вычисляется из прикладных (единый параметр деплоя) — **переведено**); RU-версия обновлена 2026-11-02 (**секция `session.autoTitle`** «Авто-заголовок сессии» — триггер в начале хода (сразу после первого сообщения пользователя), отсрочка для приветствия/смолтка, `N=2..maxAttempts` — заголовок по диалогу, фоллбек только из реплики с сигналом, ручная регенерация `PATCH /api/v2/sessions/:id {"title": ""}`, env `SYNTH_SESSION_AUTO_TITLE_*` — **переведено**); RU-версия обновлена 2026-11-02 (**секция `agents.*`** — `subagentMaxInputTokens` оценивает промпт по **калиброванному** chars-per-token модели (`token_ratios`), иначе 4 — **переведено**); RU-версия обновлена 2026-11-01 (**секция `agents.*`** «Агенты» — `subagentDepth` и env `SYNTH_AGENTS_SUBAGENT_DEPTH`; **секция `tools.outputMaxLines`/`tools.outputMaxBytes`** «Предел вывода инструментов» и env `SYNTH_TOOLS_OUTPUT_MAX_*` — **переведено**); RU-версия обновлена 2026-10-30 (**секция «Агенты»** — отчёт по лимиту шагов основного агента, `session.steps_limit`/`step_limit_reached`; **секция «Каталог моделей»** — слой `compatibility` (ADR-117; `requiresReasoning` — shorthand), поля/приоритет/эвристики, Anthropic thinking и Ollama — **переведено**); RU-версия обновлена 2026-10-29 (**секция `agents.*`** «Агенты» — `subagentMaxInputTokens` и env `SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS` — **переведено**); RU-версия обновлена 2026-10-26 (ADR-111/PROP-096/097: **секция `background.*`** «Фоновые прогоны» — `enabled`/`maxSubagentsPerSession`/`maxProcessesPerSession`/`maxRunsPerSession`/`logMaxBytes`/`retentionDays` и env-оверрайды `SYNTH_BACKGROUND_*` — **переведено**); RU-версия обновлена 2026-10-25 (**секция `questions.*`** «Вопросы пользователю» — `timeoutMs`/`retentionDays` и env-оверрайды `SYNTH_QUESTIONS_*`; секция `plugins` — модели эмбеддингов `plugins.embedding*`: проверенные модели, egress, `stale` при смене модели — переведено); перевод отстаёт (кроме секций `plugins.*` и `questions.*`): ADR-102, секция `analytics`.

> [!NOTE]
> The user-facing configuration guide lives in the documentation portal:
> https://docs.synth.itphx.ru/admin/configuration/.

## Priority

```
CLI flags > env vars (SYNTH_*) > config.yaml > defaults
```

- **CLI flags** are passed to `loadConfig({ overrides })` — the highest priority (for example `--port`, `--api-key`, `--data-dir` of `synth serve`).
- **Env vars**: scalar keys of nested sections are applied in `loadConfig` on top of `config.yaml` (the single registry `ENV_OVERRIDES`, see "Env overrides of nested sections"); dot-path variables (paths, ports, keys) are read by resolvers at the points of use (see the table below).
- **ADR-079 (home)**: `--home <dir>` (`SYNTH_HOME`) — the base directory of a local instance. Paths: config `<home>/config.yaml`, dataDir `<home>/data`, profiles `<home>/profiles.json`, credentials `<home>/credentials.json`. Path priority: explicit flags (`--data-dir`/`--config`/`--profiles`/`--credentials`) > `--home` > `SYNTH_HOME` > XDG defaults. Without home the behaviour is unchanged.
- **config.yaml** — the file found by the cascading search; merged with the defaults (`deepMerge`).
- **Defaults** — the `synthConfigSchema` schema in `packages/shared/src/config/types.ts`.

## Environment variables

| Variable | Purpose | Default |
|-----------|------------|--------------|
| `SYNTH_API_KEY` | Key to log into the API (backend → roles from `auth.apiKeyRoles`, default `USER`; core standalone → role ADMIN). If not set, `synth serve` generates a stable local key in `{dataDir}/secrets/api-key` | — |
| `SYNTH_API_KEY_ROLES` | Roles of the backend single API-key user (csv: `ADMIN,USER`); allowed `ADMIN`/`USER`/`LEAD`/`AUDITOR`; an unknown role is a configuration error at startup | `USER` |
| `SYNTH_DATA_DIR` | Data directory (sessions, projects, providers, models) | per mode: `~/.local/share/synth` (user), `./data` (dev), `/var/synth/data` (docker/server) |
| `SYNTH_STORAGE_BACKEND` | ADR-096: physical storage backend: `file` (JSON files, ADR-005), `memory` (in-memory, data is **not** persisted) or `postgres` (ADR-097) | `file` |
| `SYNTH_POSTGRES_DSN` | ADR-097: PostgreSQL connection string (takes precedence over separate `host`/`port`/`database`/`user`) | — |
| `SYNTH_POSTGRES_HOST` | ADR-097: PostgreSQL host | — |
| `SYNTH_POSTGRES_PORT` | ADR-097: PostgreSQL port | — |
| `SYNTH_POSTGRES_DATABASE` | ADR-097: PostgreSQL database name | — |
| `SYNTH_POSTGRES_USER` | ADR-097: PostgreSQL user | — |
| `SYNTH_POSTGRES_SCHEMA` | ADR-097: DB schema (namespace of the driver's tables) | — |
| `SYNTH_POSTGRES_SSL` | ADR-097: legacy TLS-connection flag (`true`/`false`); used only when `SYNTH_POSTGRES_SSLMODE` is not set | — |
| `SYNTH_POSTGRES_SSLMODE` | ADR-097/ADR-099: TLS mode for the DB connection: `disable` / `require` / `verify-full` (`verify-ca` is an alias of `verify-full`); takes precedence over the legacy `ssl` | — |
| `SYNTH_POSTGRES_POOL_MAX` | ADR-097: maximum connection pool size | `10` |
| `SYNTH_POSTGRES_PASSWORD` | ADR-097: DB password — **only** via env or the file `{dataDir}/secrets/postgres-password` (never stored in `config.yaml`, invariant 13) | — |
| `SYNTH_DEGRADED_MODE` | ADR-098: behaviour when the DB is unreachable (`fallback-file`/`halt`) | `fallback-file` |
| `SYNTH_STORAGE_FALLBACK_DIR` | ADR-098: directory of the file fallback in degraded mode | `{dataDir}/fallback` |
| `SYNTH_WORKSPACES_ROOT` | Root of the project workspace directories (`storage.workspacesRoot`) | `{dataDir}/workspaces` |
| `SYNTH_DEFAULT_WORKSPACE` | Default working directory (`storage.defaultWorkspace`) | `{dataDir}/workspaces/default` |
| `SYNTH_WORKSPACE_OUTSIDE_ROOT` | ADR-075: policy for an absolute workspace outside `workspacesRoot` (`confirm`/`deny`) | per mode (standalone — `confirm`, managed — `deny`) |
| `SYNTH_MAX_UPLOAD_BYTES` | Maximum file upload size for `/api/v2/fs/upload` (`storage.maxUploadBytes`), bytes | `104857600` (100 MiB) |
| `SYNTH_MAX_READ_BYTES` | Maximum file size served by `/api/v2/fs/read` (`storage.maxReadBytes`), bytes | `5242880` (5 MiB) |
| `SYNTH_MAX_PREVIEW_BYTES` | Maximum file size served by `/api/v2/fs/raw` — media preview (`storage.maxPreviewBytes`), bytes | `104857600` (100 MiB) |
| `SYNTH_CONFIG` | Path to `config.yaml` (takes precedence over the cascading search) | cascading search |
| `SYNTH_HOME` | ADR-079: base home directory of a local instance (`--home`): config/data/profiles/credentials are resolved from it | — |
| `SYNTH_HOST` | Listening address of the HTTP servers. Backend: outside a container — `127.0.0.1`, inside a container — `0.0.0.0`; `synth serve` — `127.0.0.1`. An explicit value always wins | `127.0.0.1` (backend outside a container) / `0.0.0.0` (container) / `127.0.0.1` (serve) |
| `SYNTH_PORT` | Backend port | `5000` |
| `SYNTH_CORE_PORT` | Core port (and `synth serve`) | `4300` |
| `SYNTH_RUNNER_PORT` | Runner port | `5200` |
| `SYNTH_AUTH_DEBUG` | Auth debug mode (test users) | `false` |
| `SYNTH_DEFAULT_LANGUAGE` | Backend interface language (`ru`/`en`; the `en` prefix is checked) | `ru` |
| `SYNTH_DEPLOY_MODE` | Deployment mode: `user`, `docker`, `server`, `dev` | auto-detect (docker markers → `docker`, root → `server`, `SYNTH_AUTH_DEBUG=true` → `dev`, otherwise `user`) |
| `SYNTH_LOG_DIR` | Directory with the service logs (the `/api/v2/logs` endpoint) | the existing log directory is looked up |
| `SYNTH_BACKEND_URL` | Backend URL (for the runner) | `http://localhost:5000` |
| `SYNTH_CORS_ORIGIN` | CORS origin (takes precedence over the config) | — |
| `SYNTH_DECISION_PROVIDER` | ADR-084: name of the decision-type provider (`decision`/`systemone`) | `decision.provider` |
| `SYNTH_DECISION_MODEL` | ADR-084: decision-layer model (e.g. `clef-flash`) | `decision.model` |
| `SYNTH_METRICS_ENABLED` | ADR-094: enable `GET /metrics` (Prometheus exposition 0.0.4); `false` → 404 | `metrics.enabled` (`false`) |
| `SYNTH_METRICS_TOKEN` | ADR-094: bearer token for `/metrics` (takes precedence over the file `{dataDir}/secrets/metrics-token`); the value is never logged | — |
| `SYNTH_TERMINAL_ENABLED` | ADR-132: master switch of the interactive-terminal contour (`false` — the whole `/api/v2/terminals*` contour answers `403 TERMINALS_DISABLED`, live terminals are closed, new ones are not created) | `terminal.enabled` (`true`) |
| `SYNTH_TERMINAL_AUTO_RESTORE` | ADR-132: restore the terminals from the snapshots after a core restart | `terminal.autoRestore` (`true`) |
| `SYNTH_TERMINAL_IDLE_MINUTES` | ADR-132: idle time before a terminal is closed, minutes (30..10080); also the snapshot TTL | `terminal.idleMinutes` (`2880`) |
| `SYNTH_TERMINAL_MAX_PER_PROJECT` | ADR-132: limit of live terminals per project (1..64) | `terminal.maxPerProject` (`8`) |
| `SYNTH_TERMINAL_MAX_PER_INSTANCE` | ADR-132: limit of live terminals per instance (1..256) | `terminal.maxPerInstance` (`32`) |
| `SYNTH_TERMINAL_SHELL` | ADR-132: shell program name or absolute path, without spaces | `terminal.shell` (not set — platform default) |
| `SYNTH_TERMINAL_AUDIT_INPUT` | ADR-132: whether `terminal.input` is written to the command-execution log | `terminal.auditInput` (`true`) |
| `SYNTH_EXECUTION_MODE` | ADR-077: execution topology — `inline` (default) \| `remote` (remote executor, ADR-077 step 7b; fail-closed at startup) | `inline` |
| `SYNTH_EXECUTION_REMOTE_URL` | ADR-077: executor address list (comma-separated) | — |
| `SYNTH_EXECUTION_TOKEN` | ADR-077: path/reference to the executor token (NOT a value, invariant 13) | — |
| `SYNTH_EXECUTION_TIMEOUT_MS` | ADR-077: exec-call timeout, ms | `30000` |
| `SYNTH_EXECUTION_CONCURRENCY` | ADR-077: limit of concurrent exec calls | process CPU count |
| `SYNTH_EXECUTION_FAIL_MODE` | ADR-077: behaviour when the executor is unavailable (`fail`/`inline-fallback`) | `fail` |
| `SYNTH_SSH_MODE` | PROP-124: instance-wide mode for SSH keys — `tools` (addressable tools, mandatory host policy) \| `agent` (ephemeral `ssh-agent` for the duration of the call). An invalid value is a **configuration error at startup** (fail-closed, like `SYNTH_EXECUTION_MODE`) | `ssh.mode` (`tools`) |

**UI (Vite):**

| Variable | Purpose | Default |
|-----------|------------|--------------|
| `VITE_BACKEND_URL` | Backend URL (Vite proxy) | `http://localhost:5000` |
| `VITE_PORT` | Vite dev-server port | `5002` |
| `VITE_ALLOWED_HOSTS` | Allowed hosts (`true` — all) | `true` |

**LLM providers (see [LLM_PROVIDERS.md](./LLM_PROVIDERS.md)):**

| Variable | Purpose |
|-----------|------------|
| `SYNTH_PROVIDER_<NAME>_URL` | Provider URL |
| `SYNTH_PROVIDER_<NAME>_API_KEY` | API key |
| `SYNTH_PROVIDER_<NAME>_MODEL` | Default model |
| `SYNTH_PROVIDER_<NAME>_TYPE` | Type: `openai`, `anthropic`, `ollama`, `decision`, `systemone` |

### API-key roles (`auth.apiKeyRoles`, `SYNTH_API_KEY_ROLES`)

The backend single API key (`auth.apiKey` / `SYNTH_API_KEY`) authenticates the
`api` user but **does not grant ADMIN by default**: roles come from an explicit
setting, the default is `['USER']`. ADMIN rights for such a key are an
operator's deliberate decision (otherwise a leaked key immediately gives full
control over the instance).

| Field / env | Purpose | Default |
|-----------|------------|--------------|
| `auth.apiKeyRoles` | Roles of the single API-key user (outside debug/OIDC): array of `ADMIN` \| `USER` \| `LEAD` \| `AUDITOR` | `['USER']` |
| `SYNTH_API_KEY_ROLES` | Same via env — csv (`ADMIN,USER`), case and spaces are ignored; takes precedence over `config.yaml` (ADR-023) | `USER` |

An unknown role (in env or `config.yaml`) is a **configuration error at load
time** (fail-closed, startup aborts with a clear message): silently keeping the
default or shrinking the set is not acceptable for access rights. Debug keys
(`SYNTH_AUTH_DEBUG`, test users), OIDC and service keys are **not** affected —
they carry their own roles.

```yaml
auth:
  apiKey: ""                       # SYNTH_API_KEY; pass via env/secret only
  apiKeyRoles: ["USER"]            # SYNTH_API_KEY_ROLES; ADMIN only explicitly
```

### OIDC groups (`auth.oidc.groups`, `SYNTH_OIDC_GROUPS_*`, ADR-140)

Groups are a **separate axis from roles**. Roles (`ADMIN`/`USER`/`LEAD`/`AUDITOR`) are the
global instance rights, they come from `realm_access.roles` and are filtered by the list
of known ones (`KNOWN_ROLES`, upper case). Groups are the source of grants **for a
project** (`group_members`): they come from the IdP claim and are **filtered by a name
allowlist**.

| Field / env | Purpose | Default |
|-----------|------------|--------------|
| `auth.oidc.groups.claim` | The claim name with the groups (top level) | `groups` |
| `auth.oidc.groups.allow` | The allowlist of group names: an array of strings | `[]` (no groups) |
| `SYNTH_OIDC_GROUPS_CLAIM` | The same via env — the claim name; takes precedence over `config.yaml` (ADR-023) | `groups` |
| `SYNTH_OIDC_GROUPS_ALLOW` | The same via env — csv (`synth-devs,synth-admins`): spaces are trimmed, empty items are dropped; takes precedence over `config.yaml` | `[]` (no groups) |

```yaml
auth:
  oidc:
    groups:
      claim: "groups"              # SYNTH_OIDC_GROUPS_CLAIM
      allow:                       # SYNTH_OIDC_GROUPS_ALLOW (csv)
        - "synth-devs"
        - "synth-admins"
```

**An empty allowlist — no groups (fail-closed).** "Accept everything" is impossible: a
claim from the IdP is not a trusted input, and the list of allowed names is set by the
operator. An explicitly set env (including an empty one) overrides `config.yaml` —
otherwise the operator could not "turn off" the groups.

Parsing rules: the claim is at the **top level** (nested paths are not parsed), the values
are strings only (trim, deduplication, the claim order is preserved); a missing claim or a
non-array → no groups; the fallback is `id_token` → `access_token`. The match against the
allowlist is **exact and case-sensitive** (`Synth-Devs` ≠ `synth-devs`).

Parsing and application — in [KEYCLOAK.md](./KEYCLOAK.md) §2.5 (the Keycloak setup) and
[API_V2.md](./API_V2.md) §5.14 (the group catalog).

### Env overrides of nested sections (ADR-023)

Scalar keys of the `events`, `scheduler`, `webhooks`, `decision`, `analytics`, `git`, `metrics`,
`questions`, `background`, `context`, `session`, `agents`, `tools`, `authority` sections can be set
with environment variables — handy for k8s (ConfigMap → pod env). The variable name is
built by the rule **`SYNTH_<SECTION>_<KEY>`**, where the camelCase key is converted to
SNAKE_CASE: `autoBind` → `SYNTH_EVENTS_AUTO_BIND`, `ephemeralTtl` →
`SYNTH_EVENTS_EPHEMERAL_TTL`, `keyRateLimitPerMinute` →
`SYNTH_EVENTS_KEY_RATE_LIMIT_PER_MINUTE`.

They are applied in a single place — `loadConfig` (`packages/shared/src/config/env-overrides.ts`),
on top of `defaults` + `config.yaml` and **below** CLI overrides: `CLI > env > config.yaml > defaults`.

- **boolean** — `true`/`1`/`false`/`0` (case-insensitive);
- **number** — `Number()` with a finiteness check;
- **string** — as is (for enum strings the schema validates the value);
- an empty variable → "not set" (the value from `config.yaml`/defaults);
- an unrecognized value → a warning in the log and ignored (no crash);
- unknown `SYNTH_*` are ignored silently.

| Variable | Type | Key |
|-----------|-----|------|
| `SYNTH_EVENTS_ENABLED` | boolean | `events.enabled` |
| `SYNTH_EVENTS_DEFAULT_MODE` | string (`bound`/`ephemeral`) | `events.defaultMode` |
| `SYNTH_EVENTS_EPHEMERAL_TTL` | string | `events.ephemeralTtl` |
| `SYNTH_EVENTS_JOURNAL_RETENTION_DAYS` | number | `events.journalRetentionDays` |
| `SYNTH_EVENTS_KEY_RATE_LIMIT_PER_MINUTE` | number | `events.keyRateLimitPerMinute` |
| `SYNTH_EVENTS_DECISION_ROUTING` | boolean | `events.decisionRouting` |
| `SYNTH_EVENTS_AUTO_BIND` | boolean | `events.autoBind` |
| `SYNTH_EVENTS_AUTO_BIND_AGENT_TEMPLATE` | string | `events.autoBindAgentTemplate` |
| `SYNTH_SCHEDULER_ENABLED` | boolean | `scheduler.enabled` |
| `SYNTH_SCHEDULER_TICK_SEC` | number | `scheduler.tickSec` |
| `SYNTH_SCHEDULER_CATCH_UP` | string (`skip`/`once`) | `scheduler.catchUp` |
| `SYNTH_SCHEDULER_JOB_RETENTION_DAYS` | number | `scheduler.jobRetentionDays` |
| `SYNTH_WEBHOOKS_ENABLED` | boolean | `webhooks.enabled` |
| `SYNTH_WEBHOOKS_MAX_ATTEMPTS` | number | `webhooks.maxAttempts` |
| `SYNTH_WEBHOOKS_TIMEOUT_MS` | number | `webhooks.timeoutMs` |
| `SYNTH_WEBHOOKS_DELIVERY_RETENTION_DAYS` | number | `webhooks.deliveryRetentionDays` |
| `SYNTH_EGRESS_TOOLS_MODE` | string (`deny`/`allow`) | `egress.tools.mode` |
| `SYNTH_EGRESS_WEBHOOKS_MODE` | string (`deny`/`allow`/`off`) | `egress.webhooks.mode` |
| `SYNTH_EGRESS_LOG_ENABLED` | boolean | `egress.log.enabled` |
| `SYNTH_EGRESS_LOG_RETENTION_DAYS` | number | `egress.log.retentionDays` |
| `SYNTH_PROXY_ENABLED` | boolean | `proxy.enabled` |
| `SYNTH_PROXY_URL` | string | `proxy.url` |
| `SYNTH_PROXY_HTTP_PROXY` | string | `proxy.httpProxy` |
| `SYNTH_PROXY_HTTPS_PROXY` | string | `proxy.httpsProxy` |
| `SYNTH_PROXY_ALL_PROXY` | string | `proxy.allProxy` |
| `SYNTH_PROXY_NO_PROXY` | string (comma-separated list) | `proxy.noProxy` |
| `SYNTH_PROXY_FALLBACK_DIRECT` | boolean | `proxy.fallbackDirect` |
| `SYNTH_PROXY_CONNECT_TIMEOUT_MS` | number | `proxy.connectTimeoutMs` |
| `SYNTH_PROXY_PASSWORD`, `SYNTH_PROXY_<NAME>_PASSWORD` | string (secret) | proxy Basic auth password: `default` and named profiles respectively (not stored in config) |
| `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | ADR-099: CA for the https proxy (mutually exclusive) | `proxy.tls` |
| `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | ADR-099: mTLS to the https proxy | `proxy.tls` |
| `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | boolean | `proxy.tls.rejectUnauthorized` |
| `SYNTH_DECISION_ENABLED` | boolean | `decision.enabled` |
| `SYNTH_DECISION_PROVIDER` | string | `decision.provider` |
| `SYNTH_DECISION_MODEL` | string | `decision.model` |
| `SYNTH_DECISION_CONFIDENCE_THRESHOLD` | number | `decision.confidenceThreshold` |
| `SYNTH_DECISION_ESCALATION_PROVIDER` | string | `decision.escalationProvider` |
| `SYNTH_DECISION_ESCALATION_MODEL` | string | `decision.escalationModel` |
| `SYNTH_GIT_CLONE_TIMEOUT_MS` | number | `git.cloneTimeoutMs` (ADR-076: the `git clone` limit, ms; `0` — no timeout) |
| `SYNTH_GIT_FETCH_TIMEOUT_MS` | number | `git.fetchTimeoutMs` (ADR-076: the `git fetch` limit, ms; `0` — no timeout) |
| `SYNTH_GIT_LOCAL_TIMEOUT_MS` | number | `git.localTimeoutMs` (ADR-076: the limit of the agent's local mutating git tools, ms; `0` — no timeout) |
| `SYNTH_GIT_NETWORK_TIMEOUT_MS` | number | `git.networkTimeoutMs` (ADR-076: the limit of the agent's network git tools, ms; `0` — no timeout) |
| `SYNTH_QUESTIONS_TIMEOUT_MS` | number | `questions.timeoutMs` (stage 1 of roadmap 0.12.4 — block 3) |
| `SYNTH_QUESTIONS_RETENTION_DAYS` | number | `questions.retentionDays` (stage 1 of roadmap 0.12.4 — block 3) |
| `SYNTH_BACKGROUND_ENABLED` | boolean | `background.enabled` (stage 1 of roadmap 0.12.4 — block 4) |
| `SYNTH_BACKGROUND_MAX_SUBAGENTS_PER_SESSION` | number | `background.maxSubagentsPerSession` (stage 1 of roadmap 0.12.4 — block 4) |
| `SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION` | number | `background.maxProcessesPerSession` (stage 1 of roadmap 0.12.4 — block 4) |
| `SYNTH_BACKGROUND_MAX_RUNS_PER_SESSION` | number | `background.maxRunsPerSession` (stage 1 of roadmap 0.12.4 — block 4) |
| `SYNTH_BACKGROUND_LOG_MAX_BYTES` | number | `background.logMaxBytes` (stage 1 of roadmap 0.12.4 — block 4) |
| `SYNTH_BACKGROUND_RETENTION_DAYS` | number | `background.retentionDays` (stage 1 of roadmap 0.12.4 — block 4) |
| `SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS` | number | `agents.subagentMaxInputTokens` (safeguard on the subagent prompt size; `0` — no limit) |
| `SYNTH_AGENTS_SUBAGENT_DEPTH` | number | `agents.subagentDepth` (subagent nesting depth limit; `0` — no limit) |
| `SYNTH_LIMITS_SESSION_OPS_PER_MINUTE` | number | `limits.sessionOpsPerMinute` (limit of heavy session operations — import/export/fork/merge — per minute per credential; `0` — no limit) |
| `SYNTH_LLM_MAX_TOKENS` | number | `llm.maxTokens` (default output limit; `0` — core default) |
| `SYNTH_CONTEXT_WINDOW_POLICY` | string (`off`/`warn`/`enforce`) | `context.windowPolicy` (context window limit policy; default `warn`) |
| `SYNTH_SESSION_AUTO_TITLE_ENABLED` | boolean | `session.autoTitle.enabled` (master switch of the session auto-naming) |
| `SYNTH_SESSION_AUTO_TITLE_DEFER_ON_CHATTER` | boolean | `session.autoTitle.deferOnChatter` (defer the name when the first reply is a greeting/small talk) |
| `SYNTH_SESSION_AUTO_TITLE_MAX_ATTEMPTS` | number | `session.autoTitle.maxAttempts` (maximum attempts by the number of dialogue replies; 1..5) |
| `SYNTH_SESSION_AUTO_TITLE_MIN_SIGNAL_CHARS` | number | `session.autoTitle.minSignalChars` (text length from which a reply counts as meaningful) |
| `SYNTH_TOOLS_OUTPUT_MAX_LINES` | number | `tools.outputMaxLines` (common tool output limit, lines; ≥ 1) |
| `SYNTH_TOOLS_OUTPUT_MAX_BYTES` | number | `tools.outputMaxBytes` (common tool output limit, bytes; ≥ 1) |
| `SYNTH_BOOTSTRAP_SERVICE_KEYS` | JSON array | `security.bootstrapServiceKeys` (an object env override, ADR-052/O1; see below) |
| `SYNTH_AUTHORITY_ENABLED` | boolean | `authority.enabled` (ADR-106; master switch of the authority layer) |
| `SYNTH_AUTHORITY_SHADOW` | boolean | `authority.shadow` (ADR-106; `true` — observation, `false` — enforcement) |
| `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` | string (secret) | `client_secret` of an OAuth provider: `google` → `SYNTH_OAUTH_GOOGLE_CLIENT_SECRET` (never stored in config; the alternative is a file `{dataDir}/secrets/oauth/<provider>.client_secret`, see below) |
| `SYNTH_OAUTH_PROVIDERS` | JSON object | `oauth.providers` — the OAuth provider catalog (object env override, ADR-105 stage 3; see below) |
| `SYNTH_TLS_CA_FILE` | ADR-099: path to a PEM file with the trusted CA (corporate CA); mutually exclusive with `SYNTH_TLS_CA_PEM` | — |
| `SYNTH_TLS_CA_PEM` | ADR-099: PEM of the trusted CA (e.g. from a Secret); mutually exclusive with `SYNTH_TLS_CA_FILE` | — |
| `SYNTH_TLS_CERT_FILE` | ADR-099: path to the PEM file of the client certificate (mTLS) | — |
| `SYNTH_TLS_KEY_FILE` | ADR-099: path to the PEM file of the client private key (mTLS) | — |
| `SYNTH_TLS_REJECT_UNAUTHORIZED` | ADR-099: verify the server certificate (`true`/`1`/`false`/`0`) | `true` |

> **Exception — `ssh.mode` (PROP-124).** The `SYNTH_SSH_MODE` variable is **not** part of
> the `ENV_OVERRIDES` registry (`packages/shared/src/config/env-overrides.ts`): the mode is
> read by a dedicated core resolver (`resolveSshMode`/`createLiveSshMode`,
> `packages/core/src/storage/runtime-settings.ts`) — like `SYNTH_EXECUTION_MODE`/
> `SYNTH_STORAGE_BACKEND`. The reason is **fail-closed**: an invalid value must abort the
> startup instead of producing "a warning in the log + ignore", as for ordinary env
> overrides.
> Diagnostic consequence: the `synth config show` dump shows the value from `config.yaml`
> (the `ssh` section), while the **effective** value follows the priority
> `env > runtime (UI) > config.yaml > default`; read it from
> `GET /api/v2/settings/ssh` (the `source` field).

### Maintenance env variables (ADR-091)

The backup archive encryption key is an **external operator key** (not the instance master key).
It is resolved for `synth backup --encrypt` and `synth restore <archive>.tar.gz.enc`; priority:
the `--key-file` flag > `SYNTH_BACKUP_KEY_FILE` > `SYNTH_BACKUP_KEY` (32 bytes in base64 or 64 hex
characters). The key is never logged or written to the audit journal; keep it separate from the
archive.

| Variable | Purpose |
|-----------|------------|
| `SYNTH_BACKUP_KEY` | Backup archive encryption key (32 bytes base64 / 64 hex), ADR-091 |
| `SYNTH_BACKUP_KEY_FILE` | Path to a file with the archive encryption key (takes precedence over `SYNTH_BACKUP_KEY`), ADR-091 |
| `SYNTH_RESTART_MODE` | ADR-092: graceful restart from the UI — `disabled` (default) \| `process` (exit code 75, the supervisor starts it again) \| `supervisor` (local `scripts/dev.sh`). CLI `synth serve --restart-mode` takes precedence over env; an unknown value → `disabled` + warning |

Example:

```bash
SYNTH_WEBHOOKS_ENABLED=true \
SYNTH_EVENTS_AUTO_BIND=true \
SYNTH_EVENTS_EPHEMERAL_TTL=15m \
SYNTH_SCHEDULER_TICK_SEC=30 \
synth serve
```

Object and array keys (`events.allowedSources`, `events.identityMap`,
`events.dedupStore`, `scheduler.leaderElection`, `mcp.servers`, …) have no
env overrides — they are set in `config.yaml` (or through the runtime API where one exists).

### Instance restart (ADR-092)

`POST /api/v2/maintenance/restart {confirm:true}` (ADMIN) does not restart the process "from within": it
performs a **graceful shutdown with exit code 75** (`EX_TEMPFAIL`), and a supervisor must start the process
again. The mode comes from `SYNTH_RESTART_MODE` (CLI `synth serve --restart-mode` takes precedence over env):

| Mode | What it does | Use case |
|---|---|---|
| `disabled` (default) | `GET /restart` → `supported:false`, `POST` → 409 `RESTART_UNSUPPORTED` | a bare `synth serve` without a supervisor (systemd `Restart=on-failure` — separately) |
| `process` | exits with code 75; an external supervisor restarts it | K8s (Deployment `restartPolicy: Always`), Docker (`restart: unless-stopped`), systemd (`Restart=on-failure`), pm2 |
| `supervisor` | same, but the local `scripts/dev.sh` restarts the process | dev environment |

Deployment defaults: the Helm chart — `backend.restartMode: process` (+ env `SYNTH_RESTART_MODE`), Docker
Compose — `restart: unless-stopped` + `SYNTH_RESTART_MODE=process`, `scripts/dev.sh` — `supervisor`, a bare
`synth serve` — `disabled`. systemd unit example:

```ini
[Service]
ExecStart=/usr/bin/synth serve --restart-mode process
Restart=on-failure        # code 75 means "temporarily unavailable", the unit comes back
RestartSec=3
```

**Multi-replica:** the endpoint restarts only the process/pod that served the request; for the whole
Deployment use `kubectl rollout restart deployment/<release>-synth-backend` (or `helm rollback`). Active
streams and in-flight requests on the restarted process are interrupted; the request is written to the audit
journal as `restart.requested`. The UI waits for `startedAt` in `GET /health` to change (up to 90 s), then
reloads.

`GET /health` and `GET /api/v2/health` return an additive `startedAt` field (ISO) — the process start
timestamp.

### Updates (ADR-133)

Update channels and background version checks for `@itphx/synth`. The channel is **derived from the
installed version** (`-beta.` in the version ⇒ `beta`, otherwise `stable`); there is no marker file.
`updates.channel` is an optional override. Sources are per channel: `stable` reads the `latest`
dist-tag from npmjs, `beta` reads the `beta` dist-tag from the Gitea npm registry. **The beta registry
is read without a token** — a token (`GITEA_NPM_TOKEN`) is needed only for publishing, not for update
checks or installation from the public registry.

| Key | Type / values | Default | Purpose |
|-----|---------------|---------|---------|
| `updates.check` | boolean | `false` | Background auto-check (**off by default** — an offline instance must not send registry requests) |
| `updates.channel` | `auto` \| `stable` \| `beta` | `auto` | Channel: `auto` — from the installed version (`-beta.` ⇒ beta) |
| `updates.intervalHours` | integer ≥ 1 | `24` | TTL of a successful check (cache `{dataDir}/update-check.json`, per channel); an error entry lives **1 h** |
| `updates.stableRegistry` | URL | `https://registry.npmjs.org` | Stable-channel registry (`latest` dist-tag) |
| `updates.betaRegistry` | URL | `https://git.itphx.ru/api/packages/itphx/npm/` | Beta-channel registry (`beta` dist-tag; read without a token) |

```yaml
updates:
  # Auto-check is off by default; an explicit check always runs.
  check: false
  # auto — channel from the installed version (-beta. ⇒ beta), or stable/beta.
  channel: auto
  # TTL of a successful check, hours; errors are cached for 1 h.
  intervalHours: 24
  stableRegistry: https://registry.npmjs.org
  betaRegistry: https://git.itphx.ru/api/packages/itphx/npm/
```

Environment variables (priority **env > runtime(UI) > config.yaml > default**):

| Variable | Key |
|----------|-----|
| `SYNTH_UPDATES_CHECK` | `updates.check` (`true`/`false`; when set in env, a UI write → 409 `CONFLICT`, `envLocked: true`) |
| `SYNTH_UPDATES_CHANNEL` | `updates.channel` |
| `SYNTH_UPDATES_INTERVAL_HOURS` | `updates.intervalHours` |
| `SYNTH_UPDATES_STABLE_REGISTRY` | `updates.stableRegistry` |
| `SYNTH_UPDATES_BETA_REGISTRY` | `updates.betaRegistry` |

Runtime auto-check toggle (`check`) — UI section "Updates" / `GET|PUT|DELETE /api/v2/settings/updates`;
applies **immediately** (the scheduler re-reads the value on every tick), `restartRequired: false`.
Enabling after start also works when the check was initially off: the scheduler keeps timers as long as
the runtime settings port is provided, and a disabled tick sends no requests. Channel and registries
come from `config.yaml`/env (runtime changes only `check`).

**An explicit check always ignores the cache:** `synth update --check`, `GET /api/v2/updates/check?force=1`,
the "Check" button in the UI. A network error in explicit mode → `502 UPDATE_CHECK_FAILED`; in the
background — a silent cached error entry for 1 h.

**Installation requirement (self-update):** **user-level npm prefix only** — `npm prefix -g` must be
inside `$HOME`. A system/root installation is never touched: the CLI preview fails before running npm,
and `POST /api/v2/updates/apply` answers `409 UPDATE_UNSUPPORTED` with a reason. In Docker/Helm/managed
self-update is forbidden for the same reason (updates ship as an image/release), regardless of prefix.

## config.yaml

Cascading search (from the highest priority to the lowest):

1. `--config` CLI flag or `SYNTH_CONFIG` env var
2. `<home>/config.yaml`, if `--home`/`SYNTH_HOME` is set (ADR-079; if the file is missing, the defaults are used, with no fallback to XDG)
3. `./synth.config.yaml` (CWD)
4. `./config.yaml` (CWD)
5. `~/.config/synth/config.yaml` (user)
6. `/etc/synth/config.yaml` (system)

The found file is merged with the defaults (`deepMerge`), then env overrides (ADR-023) and CLI overrides are applied. Implementation: `loadConfig` in `packages/shared/src/config/loader.ts`, `findConfigPath` in `resolve.ts`.

### Example (real schema)

The source of truth — the zod schemas in `packages/shared/src/config/types.ts`. Key sections with defaults are below:

```yaml
server:
  host: "0.0.0.0"
  port: 5000
  corsOrigin: "http://localhost:5002"
  allowedOrigins: []

storage:
  dataDir: "/var/synth/data"      # data directory outside the repository
  backend: "file"                 # ADR-096: physical storage backend — file (JSON files with atomic write,
                                  # default) | memory (in-memory, data is NOT persisted — hermetic tests/emulation)
                                  # | postgres (ADR-097: optional driver @itphx/synth-storage-postgres);
                                  # SYNTH_STORAGE_BACKEND
  postgres:                       # ADR-097: PostgreSQL parameters (used when backend: postgres)
    # dsn: "postgres://synth@db:5432/synth"   # connection string; takes precedence over host/port/database/user
    host: ""                      # SYNTH_POSTGRES_HOST
    port: 5432                    # SYNTH_POSTGRES_PORT
    database: ""                  # SYNTH_POSTGRES_DATABASE
    user: ""                      # SYNTH_POSTGRES_USER
    schema: ""                    # SYNTH_POSTGRES_SCHEMA — namespace of the driver's tables
    ssl: false                    # SYNTH_POSTGRES_SSL — legacy: require TLS (only when sslmode is not set)
    sslmode: ""                   # ADR-099: disable | require | verify-full (verify-ca is an alias);
                                  # CA/mTLS come from security.tls; SYNTH_POSTGRES_SSLMODE; TLS params in dsn are forbidden
    poolMax: 10                   # SYNTH_POSTGRES_POOL_MAX — maximum pool size
    # The PASSWORD is NOT stored here (invariant 13): env SYNTH_POSTGRES_PASSWORD or the file
    # {dataDir}/secrets/postgres-password.
  degradedMode: "fallback-file"   # ADR-098: on DB unavailability — fallback-file (file fallback,
                                  # strict read-only) | halt (stop startup); SYNTH_DEGRADED_MODE
  fallbackDir: ""                 # ADR-098: file fallback directory; empty — {dataDir}/fallback;
                                  # SYNTH_STORAGE_FALLBACK_DIR
  workspacesRoot: ""              # if empty — {dataDir}/workspaces; SYNTH_WORKSPACES_ROOT
  defaultWorkspace: ""            # if empty — {dataDir}/workspaces/default; SYNTH_DEFAULT_WORKSPACE
  workspaceOutsideRoot: ""        # ADR-075: policy for an absolute workspace outside workspacesRoot
                                  # confirm | deny; empty — the default per mode (standalone — confirm,
                                  # managed — deny); SYNTH_WORKSPACE_OUTSIDE_ROOT
  maxUploadBytes: 104857600       # file upload limit for /api/v2/fs/upload, bytes (>=1024, <=2 GiB);
                                  # unset — 100 MiB; SYNTH_MAX_UPLOAD_BYTES
  maxReadBytes: 5242880           # file read limit for /api/v2/fs/read, bytes (>=1024, <=512 MiB);
                                  # unset — 5 MiB; SYNTH_MAX_READ_BYTES
  maxPreviewBytes: 104857600      # file preview limit for /api/v2/fs/raw (media), bytes
                                  # (>=1024, <=512 MiB); unset — 100 MiB;
                                  # SYNTH_MAX_PREVIEW_BYTES

execution:                         # ADR-077: execution topology (startup parameter, invariant 24)
  mode: "inline"                  # inline (default) | remote; SYNTH_EXECUTION_MODE;
                                  # the --execution-mode CLI flag wins over env; an unknown value is fail-closed
  remote:
    url: []                       # executor address list; SYNTH_EXECUTION_REMOTE_URL (comma-separated);
                                  # empty with mode=remote — fail-closed at startup
    timeoutMs: 30000              # exec-call timeout; SYNTH_EXECUTION_TIMEOUT_MS
    concurrency: 8                # limit of concurrent exec calls; SYNTH_EXECUTION_CONCURRENCY
                                  # (default — process CPU count)
    failMode: "fail"              # fail (fail-closed) | inline-fallback (only with an explicit setting);
                                  # SYNTH_EXECUTION_FAIL_MODE
    tokenSecret: ""               # path/reference to the executor token (NOT a value — invariant 13);
                                  # SYNTH_EXECUTION_TOKEN
    provider: "static"            # static (pools from the configuration) | http (pool provisioner);
                                  # SYNTH_EXECUTION_PROVIDER
    provisioner:                  # pool provisioner parameters (needed with provider: http)
      url: ""                     # provisioner address; empty with provider: http — fail-closed at startup;
                                  # SYNTH_EXECUTION_PROVISIONER_URL
      tokenSecret: ""             # path/reference to the provisioner token (NOT a value — invariant 13);
                                  # SYNTH_EXECUTION_PROVISIONER_TOKEN
      timeoutMs: 10000            # provisioner request timeout; SYNTH_EXECUTION_PROVISIONER_TIMEOUT_MS

ssh:                             # PROP-124: instance-wide mode for SSH keys
  mode: "tools"                  # tools (default, fail-closed) | agent (ephemeral ssh-agent);
                                  # SYNTH_SSH_MODE; an invalid env value is a startup error

auth:
  debugMode: false                # SYNTH_AUTH_DEBUG
  apiKeyRoles: ["USER"]           # SYNTH_API_KEY_ROLES: roles of the single API key (default USER, not ADMIN)
  sessionMaxAgeMinutes: 1440
  # oidc: { enabled: false, issuer: "", clientId: "", clientSecret: "", redirectUri: "http://localhost:5002/auth/callback", cliClientId: "synth-cli" }
  # oidc.groups: { claim: "groups", allow: [] }   # ADR-140: groups (claim + allowlist); an empty allowlist — no groups

llm:
  defaultProvider: ""             # fallback: empty — the admin configures it themselves; the runtime provider + model pair
  defaultModel: ""                # is set in the «Models» UI (`/api/v2/settings/default-model`) and takes precedence over config
  maxRetries: 3
  timeout: 60
  maxTokens: 8192                 # SYNTH_LLM_MAX_TOKENS: default output limit for new sessions and models
                                  # without `maxOutputTokens` (0 — core default); the model catalog is a cap, and
                                  # reasoning models (deepseek, minimax) get a floor of 8192
  cache: "auto"                   # ADR-070: prompt-cache policy — auto (markers/key) | none (disable);
                                  # applied in the providers (Anthropic cache_control, OpenAI prompt_cache_key)

core:
  port: 4300
  apiKey: ""                      # empty → synth serve generates a key in {dataDir}/secrets/api-key (0600)

runner:
  port: 5200
  backendUrl: "http://localhost:5000"
  enginePorts: { opencode: 4100, cline: 4200, synth: 4300 }
  proxyPort: 9090

ui:
  port: 5002
  backendUrl: "http://localhost:5000"
  theme: "synthesis"
  themeMode: "system"
  locale: "ru"

i18n:
  defaultLanguage: "ru"
  supportedLanguages: ["ru", "en"]

session:
  planMode: "auto"                # Plan→Build cycle strictness: auto | strict | off
  autoTitle:                      # session auto-naming (see "Session auto-title (session.autoTitle)")
    enabled: true                 # master switch; SYNTH_SESSION_AUTO_TITLE_ENABLED
    deferOnChatter: true          # defer the name when the first reply is a greeting/small talk;
                                  # SYNTH_SESSION_AUTO_TITLE_DEFER_ON_CHATTER
    maxAttempts: 2                # maximum attempts (by the number of dialogue replies), 1..5;
                                  # SYNTH_SESSION_AUTO_TITLE_MAX_ATTEMPTS
    minSignalChars: 30            # text length from which a reply counts as meaningful;
                                  # SYNTH_SESSION_AUTO_TITLE_MIN_SIGNAL_CHARS

mcp:
  policy: "auto"                  # ADR-071 §2.3: policy for enabling MCP tools
                                  # consistency | available | auto (default auto)
                                  # independent of tools.policy; per-session override: session.settings.mcpPolicy
  # servers — see packages/shared/src/config/types.ts
  # networkPolicy — the MCP address policy {mode, list, exceptions} (the same format as egress.*),
  # see "Address policy for outbound requests (`egress.*`, ADR-099)"

oauth:
  providers: {}                    # ADR-105 stage 3: the instance OAuth provider catalog —
                                  # "name → description" (data only, no secrets);
                                  # see "OAuth provider catalog (`oauth.providers`, ADR-105 stage 3)"

tools:
  policy: "auto"                  # ADR-071 §2.3: policy for enabling BUILT-IN tools
                                  # consistency | available | auto (default auto)
                                  # consistency — all definitions + unavailable(mode|role) hints;
                                  # available — only the available tools (context savings);
                                  # auto — per provider: local (ollama) → available, cloud → consistency.
                                  # Per-session override: session.settings.toolsPolicy.
  disabled:                       # ADR-071 §2.9: instance-wide disabling of built-in tools (ADMIN)
    capabilities: []              # ToolCapability groups (git, web, file_read, file_write, shell, mcp, ...)
    tools: []                     # individual tools by name (execute_shell, git_push, ...)
                                  # runtime (plan/todo/project/reference/classify) cannot be disabled
  outputMaxLines: 2000            # common tool output limit, lines (≥ 1)
  outputMaxBytes: 51200           # common tool output limit, bytes (≥ 1)

router:
  enabled: true
  strategy: "auto"                # content | cost | content+cost | auto
  content:
    coding:   { provider: "", model: "" }
    chat:     { provider: "", model: "" }
    research: { provider: "", model: "" }
  escalation:
    enabled: true
    fallbackProvider: ""
    fallbackModel: ""
    maxRetries: 1
    checks: ["min_length", "constraint"]
    minLength: 10
  cost:
    enabled: false
    cheapProvider: ""
    cheapModel: ""
    expensiveProvider: ""
    expensiveModel: ""
    maxCheapTokens: 500
  subagent:                       # subagent routing: empty provider/model — inherit the primary pair
    enabled: true
    provider: ""
    model: ""

microFirst:
  enabled: false
  confidenceThreshold: 0.8
  rulesEnabled: true
  embeddingEnabled: false
  embedProvider: "ollama"
  embedModel: "local.nomic-embed-text:latest"
  microLlmProvider: ""            # provider of the micro-LLM layer (empty — the primary one)
  microLlmModel: ""               # model of the micro-LLM layer (empty — the primary one)
  microLlmEnabled: false

llmGateway:
  enabled: true                   # profile default: backend/managed and hybrid — true, standalone — false
  inputMode: "obfuscate"          # obfuscate | block
  logPayloads: false
  payloadLogPath: ""              # path of the full JSONL log; empty → {dataDir}/audit/llm-payloads.jsonl
  rateLimit: { userPerMinute: 60, providerPerMinute: 120 }
  audit: { enabled: true, logPath: "" }   # empty logPath → {dataDir}/audit/llm-gateway.jsonl

> The default of `llmGateway.enabled` depends on the profile: **backend/managed and hybrid —
> `true`** (secret obfuscation, per-request audit, and rate limit work out of the box),
> **standalone — `false`**. For hybrid (local core + central server, ADR-045) the profile is
> applied in a second config-loading pass: the mode is known only after the first load
> (`remote.enabled` in `config.yaml` or the OIDC fallback `--oidc-issuer`/`--oidc-client-id`).
> Override — `SYNTH_LLM_GATEWAY_ENABLED` / `config.yaml`; the runtime toggle in the UI
> ("Security → Security gateway", `settings.json`) is **higher** than `config.yaml`. When the
> gateway is off, `/health` and `/ready` add `llmGateway: "disabled"` and
> `warnings: ["llm-gateway-disabled"]` — a warning; the readiness HTTP code does not change.

decision:                         # ADR-084: decision models (System One: Clef/Jev/…)
  enabled: false                  # master switch of the decision layer
  provider: ""                    # name of the decision-type provider (decision | systemone)
  model: ""                       # model (e.g. clef-flash)
  confidenceThreshold: 0.6        # confidence threshold (below — fail-safe fallback)
  escalationProvider: ""          # Phase 6: provider of the escalation tier (empty — no escalation)
  escalationModel: ""             # Phase 6: model of the escalation tier (empty — no escalation)
  # The escalation tier is the second provider/model pair: the single `primary → escalation`
  # cascade (decision-cascade.ts) goes further on low confidence/an error of the primary model.
  # The transport is set by the provider type (decision → POST {base}/decisions,
  # systemone → POST {base}/v1/systemone); the timeout is the provider property (timeout).

> The `decision` section is overridden in runtime via `GET/PUT/DELETE /api/v2/settings/decision`
> (live, without a restart): the values are stored in `{dataDir}/settings.json` and applied to all
> three consumers — the micro cascade (`DecisionModel`), the router (`DecisionContentClassifier`) and
> external-event routing (`DecisionRuleProvider`, ADR-089); aggregate metrics of the decision layer
> are available via `GET/DELETE /api/v2/settings/decision/metrics`. Mutations in managed — ADMIN.

permission:
  rules: {}                       # granular permissions: allow/deny/ask per tool
  askTimeoutMs: 300000            # `ask` confirmation wait, ms (300000 = 5 minutes; 0 — no timeout); auto-reject after it

security:
  promptInjection:
    enabled: true
    wrapContent: true
    mode: "flag"                  # flag | sanitize | block
  protectedPaths:
    enabled: true                 # one protected-paths layer for file tools AND execute_shell
                                  # (definitions/protected-paths.json; there is no separate shell-policy.json)
  tls:                            # ADR-099: TLS/CA trust for outbound connections (env SYNTH_TLS_*)
    caFile: ""                    # path to a PEM file with the trusted CA (corporate CA); mutually exclusive with caPem
    # caPem: ""                   # PEM of the trusted CA (e.g. from a Secret); mutually exclusive with caFile
    certFile: ""                  # mTLS: path to the client certificate PEM file
    keyFile: ""                   # mTLS: path to the client private key PEM file
    rejectUnauthorized: true      # verify the server certificate (default true)
  secretKey: ""                   # ADR-076: master key of the at-rest secrets (empty → file dataDir/secrets/master.key)
  bootstrapServiceKeys: []        # ADR-052/O1: installer service keys (label/secret/scopes/roles?) — see below; usually via the env SYNTH_BOOTSTRAP_SERVICE_KEYS
  commandAudit:                   # ADR-136: append-only audit of execute_shell/sandbox_exec executions
    enabled: false                # master switch; managed profile — true (env SYNTH_COMMAND_AUDIT_ENABLED)
    retentionDays: 30             # journal retention, days (DELETE ?older_than_days)
    path: ""                      # empty → {dataDir}/audit/commands.jsonl
  commandPolicy:                  # ADR-136b: mirrored external command checker (optional; disabled — previous behaviour)
    enabled: false                # env SYNTH_COMMAND_POLICY_ENABLED; enabled without url — startup error
    provider: "http"              # http | opa                (env SYNTH_COMMAND_POLICY_PROVIDER)
    url: ""                       # checker address           (env SYNTH_COMMAND_POLICY_URL)
    tokenSecret: ""               # PATH to the bearer token file, not the value (env SYNTH_COMMAND_POLICY_TOKEN)
    failMode: "open"              # closed | open; managed profile — closed (env SYNTH_COMMAND_POLICY_FAIL_MODE)
    timeoutMs: 2000               # request timeout, ms        (env SYNTH_COMMAND_POLICY_TIMEOUT_MS)
    opaPath: "/v1/data/synth/exec/decision"  # provider: opa (env SYNTH_COMMAND_POLICY_OPA_PATH)

remote:                           # hybrid mode: local core + remote backend
  enabled: false
  backendUrl: "https://synth.k3s.itphx.loc"
  auth:
    type: device                  # device | api_key
    apiKey: ""
    issuer: "https://keycloak.itphx.loc/realms/synth"
    clientId: "synth"
  llm: "server"                   # server | local (server by default — centralization)
  worlds: { local: true, remote: true }
  credentialsPath: ""             # empty → ~/.config/synth/credentials.json
  timeoutMs: 15000
```

The full list of fields (including `logging`, `tsm`, `context`, `summarization`, `mcp`, `auth.oidc`) — in `packages/shared/src/config/types.ts`.

### Storage and working directory (`storage.*`, ADR-075)

- `storage.dataDir` — the data root (`SYNTH_DATA_DIR`; with `--home`/`SYNTH_HOME` — `<home>/data`, ADR-079).
- `storage.workspacesRoot` — the root of the project workspace directories; if not set — `{dataDir}/workspaces` (`SYNTH_WORKSPACES_ROOT`). Managed projects create a workspace inside it (auto name `slugify(name)` + suffix `-2/-3…`); an absolute path inside the root is normalized to a relative one.
- `storage.defaultWorkspace` — the working directory of sessions without a project; if not set — `{dataDir}/workspaces/default` (`SYNTH_DEFAULT_WORKSPACE`). Runtime override — `PUT /api/v2/settings/workspace`.
- `storage.workspaceOutsideRoot` — policy for an absolute `project.workspace` outside `workspacesRoot` (`confirm` — confirmation with the `confirmOutsideRoot` flag, `deny` — forbidden). Empty (`''`) — not set, effectively `confirm` in standalone; the managed backend hard-uses `deny`. Env `SYNTH_WORKSPACE_OUTSIDE_ROOT`, runtime — `GET/PUT/DELETE /api/v2/settings/workspace-policy` (managed — read-only).
- `storage.maxUploadBytes` — the maximum file upload size for `POST /api/v2/fs/upload`, in bytes. If not set — `104857600` (100 MiB). Validation (config.yaml): an integer within `1024`…`2147483648` (2 GiB), otherwise a configuration error (`Невалидная конфигурация`); an out-of-range/non-numeric env value — warn + fall back to config (fail-soft). Env `SYNTH_MAX_UPLOAD_BYTES`, resolver `resolveMaxUploadBytes` (priority env > config > default). The limit is checked before reading the body (via `content-length` and `File.size`) and again against the actual size; exceeding it → `413 PAYLOAD_TOO_LARGE`. The body is still buffered into memory in full (no streaming limit implemented).
- `storage.maxReadBytes` — the maximum file size served by `GET /api/v2/fs/read`, in bytes. If not set — `5242880` (5 MiB). Validation (config.yaml): an integer within `1024`…`536870912` (512 MiB), otherwise a configuration error (`Невалидная конфигурация`); an out-of-range/non-numeric env value — warn + fall back to config (fail-soft). Env `SYNTH_MAX_READ_BYTES`, resolver `resolveMaxReadBytes` (priority env > config > default; ADR-023). The file size is known from `stat` **before** the content is read, so the content is never buffered: a file larger than the limit **or** a binary one → `413` with the machine-readable code `FILE_TOO_LARGE` and `details: {maxReadBytes, size, reason}` (`reason`: `size`|`binary`). Applies to both builds (standalone/core and backend) — the limit is passed into `createFsRoutes` (`FsRoutesOptions.maxReadBytes`) when the app is assembled.
- `storage.maxPreviewBytes` — the maximum file size served by `GET /api/v2/fs/raw` (media/PDF preview), in bytes. If not set — `104857600` (100 MiB). Validation (config.yaml): an integer within `1024`…`536870912` (512 MiB), otherwise a configuration error (`Невалидная конфигурация`); an out-of-range/non-numeric env value — warn + fall back to config (fail-soft). Env `SYNTH_MAX_PREVIEW_BYTES`, resolver `resolveMaxPreviewBytes` (priority env > config > default; ADR-023). Checked via `stat` **before** any bytes are read: a file larger than the limit → `413` `FILE_TOO_LARGE` + `details: {maxPreviewBytes, size, reason: 'preview_size'}`. The limit is separate from `maxReadBytes` because video/audio files are noticeably larger than text; it is passed into `createFsRoutes` (`FsRoutesOptions.maxPreviewBytes`) in both builds.

### Storage backend (`storage.backend`, ADR-096)

- `storage.backend` — the physical storage backend: `file` (JSON files with atomic tmp→rename write, [ADR-005](../arch_decisions/adr-005-json-storage.md); default), `memory` (in-memory, data is **not** persisted to disk — for hermetic tests and emulation) or `postgres` (PostgreSQL; optional in-tree driver `@itphx/synth-storage-postgres`, [ADR-097](../arch_decisions/adr-097-storage-provider-class.md)). The domain works through domain ports, the backend is interchangeable ([ADR-096](../arch_decisions/adr-096-storage-layer.md)); any backend must pass the contract suite `packages/core/src/storage/contract/*`.
- **Priority** ([ADR-023](../arch_decisions/adr-023-configuration.md)): env `SYNTH_STORAGE_BACKEND` > `config.storage.backend` > `file`. An invalid value (not `file`/`memory`/`postgres`) — warn and fall back to config/default (fail-soft); an unknown **explicit** value in `resolveStorageBackend` itself — **fail-closed** (an error, not a silent fallback to files). Resolver — `resolveStorageBackend` (`@itphx/synth-shared/config`); the choice is applied at the assembly point `StorageContext` (`createStorageContextAsync`/`buildStorageContext`; the synchronous `createStorageContext` throws for `postgres`).
- `memory` prints the warning `storage.backend=memory: данные не сохраняются на диск` — a mode **not for production** (tests/emulation only).
- `postgres` requires the installed driver (`@itphx/synth-storage-postgres`, shipped with `@itphx/synth`; `pg` is an optional dependency of the driver) and a reachable DB. The driver applies/asserts **its own** DB schema (`synth_schema_migrations`, inline SQL migrations) — separate from `meta.json`/`synth migrate` (ADR-092); "DB schema is newer than the driver" — fail-closed.

### PostgreSQL (`storage.postgres`, ADR-097)

The section is used when `storage.backend: postgres`. Source of truth — `postgresStorageConfigSchema` (`packages/shared/src/config/types.ts`); resolver — `resolvePostgresConfig` (env `SYNTH_POSTGRES_*` > `config.storage.postgres`; [ADR-023](../arch_decisions/adr-023-configuration.md)).

| Field | Env | Purpose |
|------|-----|------------|
| `dsn` | `SYNTH_POSTGRES_DSN` | Connection string `postgres://…`; takes precedence over `host`/`port`/`database`/`user` |
| `host` | `SYNTH_POSTGRES_HOST` | DB server host |
| `port` | `SYNTH_POSTGRES_PORT` | Port (1–65535) |
| `database` | `SYNTH_POSTGRES_DATABASE` | Database name |
| `user` | `SYNTH_POSTGRES_USER` | User |
| `schema` | `SYNTH_POSTGRES_SCHEMA` | DB schema (namespace of the driver's tables; default — the first in `search_path`) |
| `sslmode` | `SYNTH_POSTGRES_SSLMODE` | TLS mode: `disable` / `require` / `verify-full` (`verify-ca` is an alias of `verify-full`); takes precedence over the legacy `ssl` ([ADR-099](../arch_decisions/adr-099-egress-tls-trust.md)) |
| `ssl` | `SYNTH_POSTGRES_SSL` | Legacy TLS flag (`true`/`false`); applied only when `sslmode` is not set |
| `poolMax` | `SYNTH_POSTGRES_POOL_MAX` | Maximum connection pool size (default `10`) |

- The **password** is **not stored** in the section (invariant 13). Source — env `SYNTH_POSTGRES_PASSWORD` > the file `{dataDir}/secrets/postgres-password` (resolver `resolvePostgresPassword`); a k8s Secret → env is recommended.
- Invalid numeric/boolean env values — a resolver error with a clear message (no silent passthrough).
- Driver contract and DB schema — `packages/storage-postgres/AGENTS.md`; acceptance criterion — the suite `packages/core/src/storage/contract/*` (run against a live DB via env `SYNTH_TEST_POSTGRES_DSN`).

### TLS for the PostgreSQL connection (`storage.postgres.sslmode`, ADR-099 × ADR-097)

The source of truth for the TLS policy is `storage.postgres.sslmode`; the CA and client certificates (mTLS) come from the **shared** `security.tls` section (see below). The mode resolver is `normalizePostgresSslMode`, the `pg` `ssl` options are assembled by `buildPostgresSslOptions` (`packages/shared/src/config/tls.ts`).

| `sslmode` | What we do |
|---|---|
| not set | Previous behaviour: the legacy `ssl` field (`true`/`false`) or the `pg` default — a connection **without TLS** (dev/compatibility) |
| `disable` | TLS explicitly off (`ssl: false`); CA/mTLS are ignored |
| `require` | Encryption **without** server-certificate verification (`rejectUnauthorized: false`); mTLS (`cert`/`key` from `security.tls`) is added if configured |
| `verify-full` | Server-certificate verification against the CA from `security.tls` (`rejectUnauthorized: true` + `ca`); mTLS — if configured; for a non-IP host without a DSN, `servername` (SNI) is set |
| `verify-ca` | An **alias** of `verify-full` (normalized with a warning: `pg-connection-string` treats it as `verify-full`, host-name verification enabled) |

- **Fail-closed:** `verify-full` without a configured CA (`security.tls.caFile`/`caPem`) → a configuration error (no silent `rejectUnauthorized: false` — otherwise server-certificate verification is impossible). mTLS requires **both** files — `certFile` and `keyFile`.
- **TLS parameters in the DSN are forbidden.** The `storage.postgres.dsn` connection string must not carry `sslmode`/`sslrootcert`/`sslcert`/`sslkey`/`ssl`/`sslnegotiation`/`uselibpqcompat`: the `pg` driver lays the parsed DSN **over** the explicit config (`Object.assign({}, config, parse(connectionString))`) and silently overrides the `ssl` object — up to disabling TLS. Detection → a configuration error: `TLS-параметры в DSN запрещены (обнаружено: …). … задайте их только в storage.postgres.sslmode + security.tls` (`assertNoDsnTlsParams`, `packages/storage-postgres/src/pool.ts`). Both the URL form (`?sslmode=…`) and the libpq-like form (`sslmode=…`) are checked.
- **TLS is applied at startup** (no live switch): changes — including those saved from the UI into `security-tls.json` — take effect after a restart.

### Degraded mode on DB unavailability (`storage.degradedMode`, ADR-098)

If `postgres` is selected but the DB is unreachable at startup, the behaviour is set by `storage.degradedMode` (env `SYNTH_DEGRADED_MODE` > config > `fallback-file`; resolver `resolveDegradedMode`):

- `fallback-file` (default) — the service starts on a **file fallback** in `storage.fallbackDir` (env `SYNTH_STORAGE_FALLBACK_DIR` > config > `{dataDir}/fallback`; a **separate** directory from `dataDir`) in **strict read-only**: mutations → `503 STORAGE_DEGRADED_READONLY`, non-administrators — `503 STORAGE_DEGRADED`. `/health` returns `status: 'degraded'` + a `storage.{backend,fallbackDir,reason,since}` block; diagnostics — `GET /api/v2/storage/status`.
- `halt` — startup stops with a clear error (`STORAGE_UNAVAILABLE`).

**Fail-closed** (the fallback is **not** applied regardless of `degradedMode`): a configuration/credentials error (`STORAGE_POSTGRES_CONFIG_INVALID`), a missing dependency (`…DEPENDENCY_MISSING`, no `pg`), a driver package that cannot be loaded (`STORAGE_BACKEND_UNAVAILABLE`), a DB schema newer than the driver (`…SCHEMA_TOO_NEW`). Degradation covers a **DB failure** (network/class `08`/`57P0x`, a server auth error, `…SCHEMA_OUTDATED` — fixed by `synth migrate`, other runtime errors). There is **no** auto-return to the DB — only a restart after the connection is restored ([ADR-098](../arch_decisions/adr-098-storage-degraded-recovery.md)); procedures — [MAINTENANCE.md](../MAINTENANCE.md).

### Execution topology (`execution.*`, ADR-077)

The `execution` section is the **execution topology switch**: where the commands of agent tools
(`execute_shell`, `grep_files`, git tools) are executed. It is a **startup parameter**, not a runtime
setting: switching the mode requires a process restart (invariant 24). The specification —
[ADR-077](../arch_decisions/legacy/adr-077-runtime-toolchain.md).

| Field | Type / values | Default | Env | Meaning |
|---|---|---|---|---|
| `execution.mode` | `inline` \| `remote` | `inline` | `SYNTH_EXECUTION_MODE` | Topology: `inline` — execution inside the backend process (all-in-one, the previous behaviour); `remote` — separate executors |
| `execution.remote.url` | list of addresses | `[]` | `SYNTH_EXECUTION_REMOTE_URL` (comma-separated) | Executor addresses (K8s Service `synth-executor`, `http://…`); empty with `remote` → fail-closed at startup |
| `execution.remote.timeoutMs` | number | `30000` | `SYNTH_EXECUTION_TIMEOUT_MS` | Exec-call timeout (30 s — as with the current tools; the longer shell limit is a tool property, not a config one) |
| `execution.remote.concurrency` | number | process CPU count | `SYNTH_EXECUTION_CONCURRENCY` | Limit of concurrent exec calls on the backend; exceeding it queues the call |
| `execution.remote.failMode` | `fail` \| `inline-fallback` | `fail` | `SYNTH_EXECUTION_FAIL_MODE` | Behaviour when the executor is unavailable: `fail` — fail-closed (the tool is unavailable with an explicit reason); `inline-fallback` — the backend runs the command itself (**only with an explicit setting**) |
| `execution.remote.tokenSecret` | path/reference | — | `SYNTH_EXECUTION_TOKEN` | **A path/reference to the token, NOT the value** (invariant 13). The token itself is `synth_exec_…` and lives in a Secret/file |
| `execution.remote.pooling` | `instance` \| `project` \| `session` | `instance` | `SYNTH_EXECUTION_POOLING` | Pool mode (ADR-135 F4a): `instance` — **one shared** port per process (the previous behaviour, profiles are ignored); `project`/`session` — a port per profile of the session |
| `execution.remote.defaultProfile` | string | `default` | `SYNTH_EXECUTION_DEFAULT_PROFILE` | Name of the default profile (the profile catalogue is set by ADMIN) |
| `execution.remote.browserProfile` | string | `browser` | `SYNTH_EXECUTION_BROWSER_PROFILE` | Profile of the **browser** pool (`class: 'browser'`): the browser has its own image/profile, so it does **not** inherit `defaultProfile`. Used when the call target has no explicit profile |
| `execution.remote.browserProfiles` | string[] | `[]` | `SYNTH_EXECUTION_BROWSER_PROFILES` (csv) | Explicit catalog of **browser** profiles (separate contour, ADR-135 §10): empty means `[browserProfile]`. Names are excluded from the exec catalog (`profiles`), while metadata in `execution.remote.profiles` is kept for `details` |
| `execution.remote.browserMcpServer` | string | `playwright-mcp` | `SYNTH_EXECUTION_BROWSER_MCP_SERVER` | Name of the browser MCP server in the executor pod: the built-in `browser_*` tools address their calls to it (`POST /mcp/call`), without MCP discovery |
| `execution.remote.browserTimeoutMs` | number | `120000` | `SYNTH_EXECUTION_BROWSER_TIMEOUT_MS` | Timeout of **one** browser MCP tool call (2 min). The `browser_navigate`/`browser_wait`/`browser_screenshot` tools override it with the `timeout` parameter (**in seconds**, 1…600). The ceiling is 600 000 ms: a value above it is a **configuration error** (fail-closed). The setting is common for the section — profiles do not override it |
| `execution.remote.profiles` | map of profiles | `{}` | — (`config.yaml` only) | Profile catalogue: `name → { url, timeoutMs, concurrency, failMode, description?, image?, network?, resources?, runtimeClass?, mcpServers? }`. A profile is **on top of** the common parameters: an empty `url` inherits `execution.remote.url`, unset `timeoutMs`/`concurrency`/`failMode` inherit the section values. Metadata (`description` ≤ 500, `image`, `network` `none\|restricted\|full`, `resources.requests/limits.{cpu,memory}`, `runtimeClass`, `mcpServers` — **names only**) is returned in `GET /api/v2/execution/profiles` → `details` and does **not** affect routing or port creation |
| `execution.remote.fallback` | `instance` \| `fail` | `instance` | `SYNTH_EXECUTION_FALLBACK` | Behaviour for an unusable profile (no address in the profile nor in the common `url`): `instance` — fall back to the instance port; `fail` — fail-closed (the startup is aborted) |
| `execution.remote.provider` | `static` \| `http` | `static` | `SYNTH_EXECUTION_PROVIDER` | Pool provider (ADR-135 F4b-1): `static` — pools from the configuration (profile addresses, the port is built at startup — the F4a behaviour); `http` — pools are requested from the provisioner (the pool address and token come from the response, the port is built lazily) |
| `execution.remote.provisioner.url` | string (address) | `''` | `SYNTH_EXECUTION_PROVISIONER_URL` | Address of the pool provisioner (`http://…`); **empty with `provider: http` → fail-closed at startup** ("where to ask" is not set) |
| `execution.remote.provisioner.tokenSecret` | path/reference | `''` | `SYNTH_EXECUTION_PROVISIONER_TOKEN` | **A path/reference to the provisioner token, NOT the value** (invariant 13). The value is read from the file at request time and never reaches logs/error texts |
| `execution.remote.provisioner.timeoutMs` | number | `10000` | `SYNTH_EXECUTION_PROVISIONER_TIMEOUT_MS` | Timeout of a provisioner request (10 s) — separate from the exec-call timeout |

**Priority** ([ADR-023](../arch_decisions/adr-023-configuration.md)): CLI flag `--execution-mode inline|remote` >
env `SYNTH_EXECUTION_*` > `config.yaml` > default. Resolver — `resolveExecutionConfig`
(`@itphx/synth-shared/config`).

**Fail-closed** (as for `storage.backend`): an unknown **explicit** `mode` value (a typo such as `inlne`),
`failMode`, `pooling`, `fallback` or `provider` — a configuration error, not a silent fallback to the default:

```text
[config] невалидное значение SYNTH_EXECUTION_MODE="inlne": ожидается одно из 'inline', 'remote'
[config] невалидное значение --execution-mode="inlne": ожидается одно из 'inline', 'remote'
[config] невалидное значение SYNTH_EXECUTION_POOLING="projekt": ожидается одно из 'instance', 'project', 'session'
[config] невалидное значение SYNTH_EXECUTION_FALLBACK="silent": ожидается одно из 'instance', 'fail'
[config] невалидное значение SYNTH_EXECUTION_PROVIDER="htpp": ожидается одно из 'static', 'http'
[config] execution.remote.provider="http" требует адрес provisioner'а (execution.remote.provisioner.url / SYNTH_EXECUTION_PROVISIONER_URL)
```

**Pools and profiles (ADR-135, F4a).** The pool and the profile decide **which port** a session
gets:

- `pooling: instance` — a single port per process (the shared executor pool); profiles are
  ignored, the behaviour is the previous one;
- `pooling: project` / `session` — **a port per profile**: the addresses/timeout/limit/`failMode`
  of the profile on top of the common section parameters; the ports are created **at startup**
  (the `execution` section is a startup parameter, invariant 24), so the port choice is synchronous;
- the profile of a session is `session.settings.executorProfile` (unset — the default profile); an
  unknown profile name falls back to the default profile;
- a profile without an address (and an empty common `remote.url`) → `fallback: instance` (the
  instance port) or `fallback: fail` (**fail-closed at startup**).

Profiles are set **only** in `config.yaml` — there is no env override for the profile catalogue.

**Profile metadata (static).** The `description`, `image`, `network`, `resources`,
`runtimeClass`, `mcpServers` fields are **descriptive**: they appear in the `details` of
`GET /api/v2/execution/profiles` (and in the "Execution" UI section), but they do not select
the port, address or network class of a pool. The network class of a static pool is set by the
deployment (`executor.networkClass` in the chart), and of a dynamic pool by the provisioner
profile. Empty values are treated as unset and are omitted from `details`. With
`provider: http` metadata comes from the provisioner (`GET /v1/profiles`); with
`provider: static` — from this catalogue.

**Profile binding (ADR-135 F6a).** The effective profile is an inherited scope setting, priority:

```
session.settings.executorProfile → agentDefinition.executorProfile → project.executor.profile → execution.remote.defaultProfile
```

- the first non-empty **allowed** candidate becomes the port profile (`portFor`); it is resolved
  **once per turn**;
- `project.executor.allowedProfiles` and `agentDefinition.allowedProfiles` are a **ceiling**: a
  non-empty list is mandatory for the profile, an empty/absent list means no restriction
  (compatibility: old projects/agents have no such field);
- a profile denied by a ceiling or unknown to the catalogue is **never selected** (fail-closed):
  fall back to `defaultProfile` (or the next allowed candidate) with a warning in the log (no secrets);
- `project.executor.profile` sets the profile of the project sessions; `project.executor.allowedProfiles`
  also constrains the session/agent choice;
- `task({executor_profile})` — the child session profile: checked against the catalogue and the
  project/agent ceilings before the child is created (a violation → `tool.args_error`);
- API: `PUT /api/v2/projects/:id { executor: { profile, allowedProfiles } }` — project management
  right (owner/LEAD/ADMIN, like `workspace`; EDITOR cannot); `null`/`''`/`[]` reset the value, an
  empty `allowedProfiles` means no restriction; an unknown profile with an available catalogue →
  `400 VALIDATION_ERROR`;
- `PATCH /api/v2/sessions/:id { settings: { executorProfile } }` — existence is checked when the
  catalogue is available (otherwise `400 VALIDATION_ERROR`), an empty string resets the profile;
- `POST /api/v2/agents` (admin → “Agents” → “Execution profile”) — the `executor_profile` and
  `allowed_profiles` fields (`executorProfile`/`allowedProfiles` are accepted too): `undefined`
  (field omitted) keeps the stored value, `null`/`''` reset the profile (inherit the
  project/instance), `[]`/`null` lift the list restriction. When the catalogue is available the
  profile must exist in it and the list must be its subset (otherwise `400 VALIDATION_ERROR`);
  without a catalogue (`inline`/instance pool) the check is skipped. The agents list DTO returns
  `executor_profile`/`allowed_profiles` (`null` — not set).

**Pool provider (ADR-135, F4b-1).** `execution.remote.provider` decides **where** the pool address
comes from:

- `static` (default) — pools **from the configuration**: the pool address is the first address of
  the profile, the port is built at startup (the F4a behaviour). There is no pool isolation: the
  pool key is ignored, so `pooling: project` with `provider: static` gives the same profile port
  as `instance`;
- `http` — pools are requested from the **provisioner** (`POST {provisioner.url}/v1/pools`): the
  pool address and token come from the **response**, so the port is built **lazily** — on the
  first call (`ensure`), not at startup. The pool key is `instance|project|session` ×
  `exec|browser` × profile (`project:<id>:exec:<profile>`); it tells the provisioner **which** pool
  is requested, and one key means one port (the proxy cache in the router).

With `provider: http`:

- the static `execution.remote.url` and `execution.remote.tokenSecret` are **not needed** — the
  pool address and token are issued by the provisioner (the pool token comes in the
  `POST /v1/pools` response);
- `execution.remote.provisioner.url` is **mandatory** — without it the startup is aborted
  (fail-closed);
- `execution.remote.provisioner.tokenSecret` — a path/reference to the provisioner token (NOT the
  value); the value is read from the file at request time and **never** reaches logs or error
  texts;
- if the target has no scope identifier (a session without a project under `pooling: project`) →
  `fallback: instance` (the instance port) or `fallback: fail` (**fail-closed**).

The **provisioner service itself** (pods/charts/pool manager) is the next ADR-135 slice (F4b-2);
this slice implements only the `/v1/pools` protocol client.

**Current implementation state (steps 3 and 7b of the ADR-077 plan).** The `inline` mode — the
previous behaviour, nothing changes. The `remote` mode is implemented in **step 7b**: core loads the
executor package `@itphx/synth-executor` through a dynamic `import()` and builds the remote port.
The package is optional (`optionalDependencies` of core), so the `remote` mode is **fail-closed at
startup** (the process does not start rather than "silently falling back to inline"):

| Situation | What the operator sees |
|---|---|
| `mode: remote`, empty `remote.url` list | `Remote execution mode (execution.mode=remote) requires at least one executor address (execution.remote.url / SYNTH_EXECUTION_REMOTE_URL).` |
| `mode: remote`, addresses are set, but the executor package is not installed | `Remote execution mode (execution.mode=remote) is unavailable: executor package '@itphx/synth-executor/client' is not installed` |
| `mode: remote`, the package is there, but the token cannot be read | `Remote execution mode (execution.mode=remote) is unavailable: executor token could not be read (execution.remote.tokenSecret / SYNTH_EXECUTION_TOKEN)` |

`config.yaml` example:

```yaml
execution:
  mode: "inline"                   # inline (default) | remote (ADR-077)
  remote:
    url: []                        # executor address list (comma-separated — env SYNTH_EXECUTION_REMOTE_URL)
    timeoutMs: 30000               # SYNTH_EXECUTION_TIMEOUT_MS
    concurrency: 8                 # SYNTH_EXECUTION_CONCURRENCY (default — process CPU count)
    failMode: "fail"               # fail (fail-closed) | inline-fallback; SYNTH_EXECUTION_FAIL_MODE
    tokenSecret: ""                # path/reference to the executor token (NOT a value!); SYNTH_EXECUTION_TOKEN
    pooling: "instance"            # instance (shared port) | project | session; SYNTH_EXECUTION_POOLING
    defaultProfile: "default"      # default profile name; SYNTH_EXECUTION_DEFAULT_PROFILE
    browserProfile: "browser"      # profile of the `browser` pool (own browser image; does not
                                   # inherit defaultProfile); SYNTH_EXECUTION_BROWSER_PROFILE
    browserProfiles: []            # explicit catalog of BROWSER profiles (empty → [browserProfile]);
                                   # names are excluded from the exec catalog; SYNTH_EXECUTION_BROWSER_PROFILES
    browserMcpServer: "playwright-mcp"  # browser MCP server name in the pod (built-in browser_* tools;
                                        # matches the executor image default);
                                        # SYNTH_EXECUTION_BROWSER_MCP_SERVER
    browserTimeoutMs: 120000          # timeout of one browser MCP tool call, ms; overridden by the
                                        # `timeout` tool parameter; ceiling 600000 (a higher value is
                                        # a configuration error);
                                        # SYNTH_EXECUTION_BROWSER_TIMEOUT_MS
    fallback: "instance"           # instance (fall back to the instance port) | fail (fail-closed); SYNTH_EXECUTION_FALLBACK
    provider: "static"             # static (pools from the configuration) | http (provisioner); SYNTH_EXECUTION_PROVIDER
    provisioner:                   # pool provisioner parameters (needed with provider: http)
      url: ""                      # provisioner address; empty with provider: http → fail-closed;
                                   # SYNTH_EXECUTION_PROVISIONER_URL
      tokenSecret: ""              # path/reference to the provisioner token (NOT a value!);
                                   # SYNTH_EXECUTION_PROVISIONER_TOKEN
      timeoutMs: 10000             # provisioner request timeout; SYNTH_EXECUTION_PROVISIONER_TIMEOUT_MS
    profiles:                      # profile catalogue (config.yaml only)
      devops:
        url: ["http://synth-executor-devops:8080"]   # empty → inherits remote.url
        timeoutMs: 60000            # unset → inherits remote.timeoutMs
        concurrency: 4              # unset → inherits remote.concurrency
        failMode: "fail"            # unset → inherits remote.failMode
        # --- metadata (details/UI only, does not affect routing) ---
        description: "DevOps executor: full toolchain"
        image: "synth-executor:0.13.9-full"
        network: "restricted"       # none | restricted | full
        resources:
          requests: { cpu: "500m", memory: "1Gi" }
          limits: { cpu: "2", memory: "4Gi" }
        runtimeClass: "gvisor"
        mcpServers: ["playwright-mcp"]  # names only (no commands/env); must match execution.remote.browserMcpServer
```

An example of dynamic pools (the provisioner issues the pool address and token; static executor
addresses are not needed):

```yaml
execution:
  mode: "remote"
  remote:
    provider: "http"               # pools are requested from the provisioner
    pooling: "project"             # a pool per project (project:<id>:exec:<profile>)
    fallback: "instance"           # without projectId → the instance port
    provisioner:
      url: "http://synth-provisioner:8080"
      tokenSecret: "/etc/synth/secrets/provisioner-token"   # path/reference, NOT a value
      timeoutMs: 10000
    profiles:
      default:
        timeoutMs: 60000            # profile parameters — on top of the common ones
```

### Execution profile catalogue — runtime setting (`/api/v2/settings/execution`, ADR-135 §11)

The profile catalogue and the execution defaults are **not** `config.yaml` only: they are a
**backend-owned runtime section** `execution` (`{dataDir}/settings.json` or the PG `settings`
table), managed by **ADMIN only** through `GET/PUT/DELETE /api/v2/settings/execution`.

| Runtime field | Type / values | Meaning |
|---|---|---|
| `defaultProfile` | string | Default profile (must exist in the effective catalogue) |
| `browserProfile` | string | Browser pool profile (class `browser`/`both`) |
| `pooling` | `instance` \| `project` \| `session` | Pool mode (ADR-135 F4a) |
| `fallback` | `instance` \| `fail` | Router behaviour when a profile is unusable |
| `profiles` | map of profiles | **Overrides/new profiles only**: `name → { description?, class?, image?, url?, network?, resources?, runtimeClass?, annotations?, labels?, nodeSelector?, tolerations?, affinity?, readOnlyRootFilesystem?, env?, mcpServers? }` |
| `disabledProfiles` | string[] | Names of **config profiles** to disable (they cannot be deleted) |

**Effective value priority** ([ADR-023](../arch_decisions/adr-023-configuration.md)):
**env/CLI > runtime > `config.yaml`**.

**The runtime catalogue is a merge, not a replacement.** Effective catalogue =
`config.profiles + runtime.profiles (full override) − disabledProfiles`. Config/Helm profiles are
**not deleted** — only disabled; runtime profiles are deleted by removing them from `profiles`.
`browserProfiles` in the runtime section is legacy; catalogues derive from `class`: executor —
`exec|both`, browser — `browser|both` (+ `browserProfile`).

**MCP servers** are objects `{name, command?, args?, env?}` (legacy strings normalise to `{name}`);
a browser profile is prefilled with Playwright. They are passed into `profileSpec` and the pod env.

**Profile scheduling fields**: `annotations`/`labels` (service `synth.io/*` keys take precedence),
`nodeSelector`, `tolerations`, `affinity` (≤ 8 KiB JSON), `runtimeClass` (Kubernetes RuntimeClass,
must exist in the cluster). `resources.requests/limits` accept arbitrary quantity keys, e.g.
`nvidia.com/gpu: "1"`.

**Write validation** (`400 VALIDATION_ERROR`): only runtime overrides are validated
(`image` or `url`); `disabledProfiles` may contain config-base names only, not defaults;
`defaultProfile`/`browserProfile` exist in the effective catalogue (`browserProfile` — class
`browser|both`); an unknown field → 400. The section holds **no secrets**: `env` are pool
environment variables, not passwords (invariant 13).

**Applied at process start.** `execution` is a startup parameter (invariant 24): the API reports
`restartRequired` (fingerprint "saved" vs "running"); `/api/v2/execution/profiles` returns the
**running** catalogue until a restart. `profileOrigins` (`config|runtime`) is additive in responses.

**Image warm-up** — `POST /api/v2/execution/images/warm` (ADMIN): the provisioner creates a
DaemonSet for the selected images, waits for readiness and deletes it; `provider: kubernetes` only,
`static` → `501`.

Example runtime section (`PUT /api/v2/settings/execution` body):

```json
{
  "execution": {
    "defaultProfile": "devops",
    "pooling": "project",
    "disabledProfiles": ["legacy"],
    "profiles": {
      "devops": {
        "description": "DevOps executor: full toolchain",
        "class": "exec",
        "image": "synth-executor:0.13.9-full",
        "network": "restricted",
        "resources": { "requests": { "cpu": "500m", "memory": "1Gi" },
                       "limits": { "nvidia.com/gpu": "1" } },
        "runtimeClass": "gvisor",
        "nodeSelector": { "nvidia.com/gpu.present": "true" },
        "annotations": { "example.com/pool": "gpu" },
        "mcpServers": [{ "name": "playwright-mcp", "command": "playwright-mcp" }]
      }
    }
  }
}
```

### Pool network classes (`executor.networkClass` / `executor.networkClasses.*` values, ADR-137b-2)

Executor pool isolation is **by profile class**, not by addresses: every pool
carries the `synth.io/network=<none|restricted|full>` label, and the chart
renders a NetworkPolicy per class. The classes are the same for the **static**
pool (the executor Deployment) and for the **dynamic** provisioner pools.

These are **Helm chart values** (not `config.yaml` and not env): NetworkPolicy
objects live in the cluster and are not switched at runtime (invariant 24).

| Key | Default | Meaning |
|---|---|---|
| `executor.networkClass` | `restricted` | Class of the **static** pool — the `synth.io/network` label of the executor pod. An unknown value is a **render error** (fail-closed) |
| `executor.networkClasses.enabled` | `false` | `true` — render the class policies (`none`/`restricted`/`full`); the legacy `executor.networkPolicy` is **not** rendered then |
| `executor.networkClasses.restrictedEgress` | `[]` | Egress allowlist for the `restricted` class (`networking.k8s.io/v1` rules); empty → `restricted` allows DNS only |

| Class | Ingress | Egress |
|---|---|---|
| `none` | from the backend and provisioner pods on the executor port | **denied entirely** — DNS included |
| `restricted` | the same | DNS (kube-system, 53/udp+tcp) + `networkClasses.restrictedEgress` |
| `full` | the same | unrestricted (`policyTypes: [Ingress]`) |

**Who sets the label.** The static pool — the chart (`executor.networkClass`).
The dynamic pools — the **provisioner**: the class comes from the profile
(`provisioner.profiles[].network`; if the profile does not set it — `full`).

**Limitations.**

- The policies live in the **chart namespace**. The provisioner's dynamic pool
  pods are created in the same namespace (`SYNTH_PROVISIONER_KUBERNETES_NAMESPACE`
  = `.Release.Namespace`), so they are covered; a provisioner with another
  namespace is **not** covered by them.
- The cluster CNI must **support NetworkPolicy** — otherwise the objects exist
  but the restrictions do not apply.
- The policy selector is the **class label only**: in one namespace every pool
  of that class is covered (including pools of another Synth release in the
  same namespace).
- With `networkClasses.enabled: true` the legacy `executor.networkPolicy` is
  **not** rendered (the rules of several NetworkPolicies are unioned — its
  egress rules would weaken `none`/`restricted`), and neither is
  `executor.networkPolicy.metricsIngress` (scraping the executor `/metrics`
  from another namespace needs a separate policy).
- `none` — no egress at all: DNS does not resolve (including in-cluster names),
  so git/npm do not work inside the pool.
- The rule "the `full` class is only available when the profile is explicitly
  allowed in `project.executor.allowedProfiles`" (ADR-137) is **not enforced by
  this policy**: the chart does not know which profile a session will pick (the
  profile ceiling is a core-level concern, `execution.remote.profiles`), while
  the pool network class is set by the operator via the provisioner profile.

Details and examples — chart README, §«Pool network classes».

### Image builds: remote builder (`DOCKER_HOST`/`BUILDKIT_HOST`, ADR-137 F5)

Building images (`docker build`) from a session happens **only on a remote builder**: the
`devops`/`full` images ship the docker CLI, but there is no daemon and no `docker.sock`,
and `--privileged` plus a hostPath daemon are forbidden. This is **not** `config.yaml`:
the setting lives in the pool env — `DOCKER_HOST`/`BUILDKIT_HOST` (the build),
`DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH` (TLS, a **path** only; certificates are a
Secret/file, invariant 13).

| Where | How to set the env |
|---|---|
| Dynamic pool (`provider: kubernetes`) | `provisioner.profiles.<name>.env` (chart values) → the pool pod container env |
| Static pool (the `executor` Deployment) | `executor.extraEnv` **does not exist** in the chart; the deployment owner sets the env (patch/own manifest) |

Network: `restricted` needs an egress rule to the builder
(`executor.networkClasses.restrictedEgress`), `none` makes builds impossible; with an
unreachable builder the command fails in the shell with a docker CLI error. A profile
example, the certificate Secret and the warnings — [EXECUTION.md](../EXECUTION.md) §10.2.1
and the chart README, §«Remote builder для сборок». The builder itself is external
infrastructure; the chart does not deploy it.

### Pool provisioner (`SYNTH_PROVISIONER_*`, `provisioner.*` values)

A separate `@itphx/synth-provisioner` process (ADR-135 F4b-2b): it issues the
pool address and token to the control plane (`POST /v1/pools`). Enabled in the
chart with `provisioner.enabled: true` **together with**
`execution.mode: remote` (the backend pool provider is
`execution.remote.provider: http`, see `execution.remote.provisioner.*` above).
The provisioner configuration is **env only** (it has no instance data
directory); chart values are translated into env. The token value is never
stored in values or `config.yaml` (invariant 13).

**Provisioner process env:**

| Variable | Default | Meaning |
|---|---|---|
| `SYNTH_PROVISIONER_TOKEN` | — (**required**) | Control-plane bearer token; without it the process does not start (fail-closed) |
| `SYNTH_PROVISIONER_HOST` | `0.0.0.0` | Listen address |
| `SYNTH_PROVISIONER_PORT` | `5200` | Port |
| `SYNTH_PROVISIONER_PROVIDER` | `static` | Pool provider: `static` \| `kubernetes` (anything else is a startup error) |
| `SYNTH_PROVISIONER_PROFILES` | `{}` | JSON profile catalogue: `{"<profile>":{"image","url","network","resources","runtimeClass","readOnlyRootFilesystem","env"}}`; `static` requires `url`, `kubernetes` requires `image` |
| `SYNTH_PROVISIONER_STATIC_POOLS` | `{}` | JSON exact pools: `{"<poolKey>":"http://…"}` (`static` only) |
| `SYNTH_PROVISIONER_IDLE_TIMEOUT_MS` | `900000` | Idle timeout of a project/instance pool |
| `SYNTH_PROVISIONER_SESSION_IDLE_TIMEOUT_MS` | `300000` | Idle timeout of a session pool |
| `SYNTH_PROVISIONER_MAX_LIFETIME_MS` | `43200000` | Maximum pool lifetime |
| `SYNTH_PROVISIONER_DRAIN_GRACE_MS` | `30000` | Pause between drain and release |
| `SYNTH_PROVISIONER_MAX_POOLS` | `50` | Live-pool limit (`429` above it) |
| `SYNTH_PROVISIONER_REAPER_INTERVAL_MS` | `30000` | Reaper period |

**Kubernetes provider** (active with `provider: kubernetes`):

| Variable | Default | Meaning |
|---|---|---|
| `SYNTH_PROVISIONER_KUBERNETES_NAMESPACE` | ServiceAccount namespace, else `synth` | Namespace of pools/secrets (the chart uses the release namespace) |
| `SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_PVC` | — (**required**) | PVC with project working directories (RWX) |
| `SYNTH_PROVISIONER_KUBERNETES_WORKSPACE_MOUNT` | `/var/synth/data/workspaces` | PVC mount path (must match `executor.workspace.mountPath` and `storage.workspacesRoot`) |
| `SYNTH_PROVISIONER_KUBERNETES_SERVICE_ACCOUNT` | — | ServiceAccount of **pool pods** (no API permissions) |
| `SYNTH_PROVISIONER_KUBERNETES_IMAGE_PULL_SECRETS` | — | csv of pool-pod imagePullSecrets |
| `SYNTH_PROVISIONER_KUBERNETES_API_SERVER` | `https://kubernetes.default.svc` | Kubernetes API address |
| `SYNTH_PROVISIONER_KUBERNETES_TOKEN_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Provisioner token to the API (ServiceAccount volume) |
| `SYNTH_PROVISIONER_KUBERNETES_CA_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | API server CA |
| `SYNTH_PROVISIONER_KUBERNETES_START_TIMEOUT_MS` | `120000` | Waiting for a pool pod to become Running/Ready |
| `SYNTH_PROVISIONER_KUBERNETES_POLL_INTERVAL_MS` | `1000` | Pod polling period |
| `SYNTH_PROVISIONER_KUBERNETES_EXECUTOR_PORT` | `5100` | Executor port inside a pool pod |
| `SYNTH_PROVISIONER_KUBERNETES_TERMINATION_GRACE_SECONDS` | `30` | Pod deletion grace period |
| `SYNTH_PROVISIONER_KUBERNETES_FS_GROUP` | `1000` | `fsGroup` of pool pods; `none`/`null` — do not set it in the pod spec (NFS: otherwise the kubelet recursively changes ownership of the volume when a pod starts) |

**Chart values** (`provisioner.*`; details — chart README, §«Pool provisioner»):

| Key | Default | Env / meaning |
|---|---|---|
| `provisioner.enabled` | `false` | Deployment + Service + RBAC; the backend receives `SYNTH_EXECUTION_PROVIDER=http` |
| `provisioner.provider` | `static` | `SYNTH_PROVISIONER_PROVIDER` |
| `provisioner.image.repository` / `.tag` / `.pullPolicy` | `git.itphx.ru/itphx/synth-provisioner` / `""` / `IfNotPresent` | Image (empty tag → `.Chart.AppVersion`) |
| `provisioner.replicaCount` | `1` | Replicas (no distributed locking) |
| `provisioner.service.port` / `.targetPort` | `5200` / `5200` | Service; address → `SYNTH_EXECUTION_PROVISIONER_URL` |
| `provisioner.token.existingSecret` / `.secretKey` | `""` / `SYNTH_PROVISIONER_TOKEN` | Token Secret (empty → `secrets.existingSecret`); provisioner gets the value, the backend a file path |
| `provisioner.profiles` | `{}` | `SYNTH_PROVISIONER_PROFILES` (JSON) |
| `provisioner.staticPools` | `{}` | `SYNTH_PROVISIONER_STATIC_POOLS` (JSON) |
| `provisioner.kubernetes.workspacePvc` | `""` | `…_WORKSPACE_PVC` (required with `provider: kubernetes`) |
| `provisioner.kubernetes.workspaceMount` | `/var/synth/data/workspaces` | `…_WORKSPACE_MOUNT` |
| `provisioner.kubernetes.serviceAccount` | `""` | `…_SERVICE_ACCOUNT` (pool pods SA) |
| `provisioner.kubernetes.imagePullSecrets` | `[]` | `…_IMAGE_PULL_SECRETS` (csv) |
| `provisioner.kubernetes.apiServer` | `https://kubernetes.default.svc` | `…_API_SERVER` |
| `provisioner.kubernetes.startTimeoutMs` / `.pollIntervalMs` | `120000` / `1000` | `…_START_TIMEOUT_MS` / `…_POLL_INTERVAL_MS` |
| `provisioner.kubernetes.executorPort` / `.terminationGraceSeconds` | `5100` / `30` | `…_EXECUTOR_PORT` / `…_TERMINATION_GRACE_SECONDS` |
| `provisioner.kubernetes.fsGroup` | `1000` | `…_FS_GROUP`; `null` → `none` (not set: NFS) |
| `provisioner.idleTimeoutMs` / `.sessionIdleTimeoutMs` / `.maxLifetimeMs` | `900000` / `300000` / `43200000` | `SYNTH_PROVISIONER_*_TIMEOUT_MS` |
| `provisioner.drainGraceMs` / `.maxPools` / `.reaperIntervalMs` | `30000` / `50` / `30000` | `SYNTH_PROVISIONER_*` |
| `provisioner.timeoutMs` | `10000` | Backend timeout → `SYNTH_EXECUTION_PROVISIONER_TIMEOUT_MS` |
| `provisioner.serviceAccount.create` / `.name` | `true` / `""` | Provisioner ServiceAccount (Role — pods/secrets in the namespace) |
| `provisioner.networkPolicy.enabled` / `.apiServerCidrs` | `false` / `[]` | NetworkPolicy: ingress from the backend only; egress DNS + API (CIDRs required for `kubernetes`) |

Provisioner fail-closed errors: a missing token, malformed JSON, an unknown
`provider`, a profile without `url` (`static`) or `image` (`kubernetes`), a
missing PVC, non-numeric values, invalid Kubernetes object names — the process
**does not start** (explicit operator configuration never degrades into a
default). Chart render errors: an unknown `provisioner.provider`, an empty
`workspacePvc` with `kubernetes`, a NetworkPolicy with `kubernetes` but without
`apiServerCidrs`.

### TLS and mTLS trust for outbound connections (`security.tls`, ADR-099)

A single source of TLS/CA trust for **all** outbound connections of Synth (LLM providers, MCP HTTP,
`web_fetch`/`web_search`, webhooks, the hybrid backend, instructions/skills by URL, the update checker,
OIDC/JWKS, provider icons, git, PostgreSQL). The section is read by
`resolveTlsProfiles`/`resolveTlsTrust` (`packages/shared/src/config/tls.ts`). It can be configured in
`config.yaml`/env and **from the admin UI** (section "Network" → "Trusted CA (TLS)"); it is applied **at
process startup** (the `EgressDispatcher` is start-only), so saving from the UI takes effect after a restart
(`restartRequired`). Invariant — [ADR-099](../arch_decisions/adr-099-egress-tls-trust.md): subsystems do not
create their own agents/dispatchers/CA pools.

**Priority (field-level):** env `SYNTH_TLS_*` > runtime (bootstrap/UI) > `config.yaml` > defaults
([ADR-023](../arch_decisions/adr-023-configuration.md)). Parameters set in config/env are shown in the UI
**read-only** with their source; they cannot be overridden from the UI (per-host mappings are the exception).

| Field | Env | Purpose |
|---|---|---|
| `caFile` | `SYNTH_TLS_CA_FILE` | Path to a trusted CA PEM file (one certificate or a **CA bundle** of several); **mutually exclusive** with `caPem` |
| `caPem` | `SYNTH_TLS_CA_PEM` | PEM of the trusted CA (e.g. from a Secret); **mutually exclusive** with `caFile` |
| `certFile` | `SYNTH_TLS_CERT_FILE` | mTLS: path to the client certificate PEM (default profile) |
| `keyFile` | `SYNTH_TLS_KEY_FILE` | mTLS: path to the client private key PEM (default profile) |
| `rejectUnauthorized` | `SYNTH_TLS_REJECT_UNAUTHORIZED` | Verify the server certificate (`true`/`1`/`false`/`0`); default `true` |

- **An empty configuration — process trust:** Node's bundled roots + the **OS system store**
  (Linux/macOS/Windows via `tls.getCACertificates`, Node ≥ 22.19) + `NODE_EXTRA_CA_CERTS`. The base set
  is applied as the Node default (`tls.setDefaultCACertificates`), so raw `globalThis.fetch` and default
  transports see it too.
- **`caFile`/`caPem` extend the system trust, they do not replace it:** the user CA is concatenated with
  the base set (deduplicated), so public sites keep verifying.
- **Node requirement for the system store:** the `tls.getCACertificates` API (Node ≥ 22.19). On older
  Node the base set is bundled roots + `NODE_EXTRA_CA_CERTS` + the first readable Linux system bundle
  (`SSL_CERT_FILE`, `/etc/ssl/certs/ca-certificates.crt`, …); on macOS/Windows without this API, set the
  CA explicitly via `security.tls`.
- **PostgreSQL `verify-full` remains fail-closed** without an explicit CA from `security.tls` — the
  system store does not substitute for it (documented decision).
- **CA bundle:** one CA set for the whole egress; a PEM may contain several certificates. There is **no
  per-host CA** — only client certificates (mTLS) differ per host.
- **`rejectUnauthorized`:** `true` (default) — server-certificate verification; `false` — verification
  disabled (a deliberate MITM risk; debugging only). An invalid env value — `warn` + fallback.
- **mTLS profiles:** one **default** client (`certFile`+`keyFile`, set together only) and `mappings[]` —
  per-host cert+key pairs. Patterns: exact host, `*.suffix` (subdomains), `*` (all hosts);
  case-insensitive; the **first match** in mapping order wins, otherwise the default; if neither exists, no
  client certificate is presented. `mappings[]` is runtime-only (UI), not in `config.yaml`.
- **PostgreSQL** uses the **same** profile resolver by host — a default certificate without a mapping is
  presented to the DB as well. There is no separate "DB certificate" setting.
- **TLS to the proxy** (`proxy.tls`) is a **separate** section (CA/mTLS to the https proxy), not mixed with
  target trust; the UI shows it read-only.
- **Fail-closed:** `caFile` and `caPem` together (including across sources) → an error; an explicitly set
  `caFile` that is missing/unreadable/not PEM → an error; an incomplete client pair → an error; configured
  trust without `undici` → a clear error, not an untrusted transport.
- **Application:** at startup a global undici dispatcher is built (`setGlobalDispatcher`), so the ordinary
  `fetch` inherits the trust; points outside the shared transport (git) get the CA via
  `http.sslCAInfo=<caFile>` (`caPem` without a file is unavailable to git).
- **`NODE_EXTRA_CA_CERTS` — part of the base set** (Node ≥ 22.19: the `extra` kind; on older Node the
  file is read directly) and compatibility for child processes (MCP stdio, git); it does **not** replace
  `security.tls` and is not Synth configuration.
- **Applied at startup:** `security.tls` is **not** part of `RuntimeSettings`/PG — the dispatcher is
  process-global. The runtime override lives in the **bootstrap file** `{dataDir}/security-tls.json` (see
  below), because it is read **before** connecting to PostgreSQL.

#### Configuring from the UI (section "Network")

- **"Proxy"** — the egress proxy (see `proxy.*`): editable form, write-only password, saved/running status,
  restart banner.
- **"Trusted CA (TLS)"** — the CA bundle (paste PEM or a file, several certificates, a validate button),
  `rejectUnauthorized`, the **default** client cert+key (upload, write-only), a **per-host mapping** table
  (`hosts`, `label`, cert+key; order = priority), read-only config/env parameters with their source, and
  read-only TLS to the proxy.
- **Where it is stored:** `{dataDir}/security-tls.json` (0600, directory 0700, atomic tmp→rename); PEM
  materials — `{dataDir}/secrets/tls/` (`ca.pem`, `client.crt`/`client.key`, `<id>.crt`/`<id>.key`, 0600).
  The JSON holds only paths and the public `caPem`; keys/secrets are never returned. This is a **deliberate
  exception** to "everything goes through storage ports": the file is read before the DB.
- **Application:** at the next startup (`restartRequired`); API — `GET/PUT /api/v2/settings/tls`,
  `PUT/DELETE /settings/tls/ca`, `PUT/DELETE /settings/tls/client`,
  `POST/PUT/DELETE /settings/tls/mappings[/:id]`, `POST /settings/tls/validate` (mutations — ADMIN in
  managed). Changes are written to `{dataDir}/audit/security.jsonl` with `scope:'tls'` (paths, hosts,
  subject — no PEM/keys). API responses never contain PEM/keys.

Example `config.yaml`:

```yaml
security:
  tls:
    caFile: "/etc/synth/tls/corp-ca.pem"   # or caPem (mutually exclusive); a CA bundle is allowed
    # certFile: "/etc/synth/tls/client.pem"  # default mTLS client (together with keyFile)
    # keyFile:  "/etc/synth/tls/client.key"
    rejectUnauthorized: true
```

Example runtime override (`{dataDir}/security-tls.json`, managed by the UI; paths under `secrets/tls/`):

```json
{
  "caFile": "/var/synth/data/secrets/tls/ca.pem",
  "rejectUnauthorized": true,
  "defaultClient": {
    "certFile": "/var/synth/data/secrets/tls/client.crt",
    "keyFile": "/var/synth/data/secrets/tls/client.key"
  },
  "mappings": [
    { "id": "m_1", "hosts": ["*.corp.example"], "label": "corp",
      "certFile": "/var/synth/data/secrets/tls/m_1.crt",
      "keyFile": "/var/synth/data/secrets/tls/m_1.key" },
    { "id": "m_2", "hosts": ["*"], "label": "fallback",
      "certFile": "/var/synth/data/secrets/tls/m_2.crt",
      "keyFile": "/var/synth/data/secrets/tls/m_2.key" }
  ]
}
```

**Limitations.** No per-host CA (one CA bundle for the whole egress) and no multiple default certificates.
A default certificate without a mapping is presented to all targets, including PostgreSQL. Through SOCKS5
no client certificate is passed to the target (`Socks5ProxyAgent` does not accept `requestTls`). There is no
runtime reload without a restart. The bootstrap file is an exception to "everything goes through storage
ports" (read before PG).

### Address policy for outbound requests (`egress.*`, ADR-099)

A configurable "where may we go" policy for outbound requests. It is part of the single egress layer
([ADR-099](../arch_decisions/adr-099-egress-tls-trust.md) items 8–15); TLS/CA trust is a separate section
`security.tls` (above). Three **independent** policy instances:

| Scope | Key | Covers | Modes |
|---|---|---|---|
| Tools | `egress.tools` | `web_fetch`/`web_search`, internal `net/fetch` consumers (URL skills, URL instruction sources), provider icons | `deny`/`allow` |
| Webhooks | `egress.webhooks` | outgoing webhooks (event delivery) | `deny`/`allow`/`off` |
| MCP | `mcp.networkPolicy` | user HTTP/SSE MCP servers (`origin:'user'`) | `deny`/`allow` |

All three share one format: `{mode, list: string[], exceptions: string[]}`.

| Field | Env | Purpose | Default |
|---|---|---|---|
| `egress.tools.mode` | `SYNTH_EGRESS_TOOLS_MODE` | `deny` — block when any resolved address is in `list`; `allow` — permit only when **all** addresses are in `list` | `deny` |
| `egress.tools.list` | — (config.yaml only) | Rules: exact hostname, `*.suffix`, IP/CIDR | `DEFAULT_MCP_PRIVATE_CIDRS` |
| `egress.tools.exceptions` | — | Allow rules (checked **first**) | `[]` |
| `egress.webhooks.mode` | `SYNTH_EGRESS_WEBHOOKS_MODE` | Same, plus `off` — dev: no checks and **no `https` requirement** | `deny` |
| `egress.webhooks.list` / `.exceptions` | — | As in `egress.tools` | `DEFAULT_MCP_PRIVATE_CIDRS` / `[]` |
| `egress.log.enabled` | `SYNTH_EGRESS_LOG_ENABLED` | Outbound request journal `{dataDir}/audit/egress.jsonl` | `true` |
| `egress.log.retentionDays` | `SYNTH_EGRESS_LOG_RETENTION_DAYS` | Journal retention, days; `0` — never prune; prune at start and every 6 h | `7` |

**Semantics.**

- Rule grammar (the same for `list` and `exceptions`): **exact hostname** | **`*.suffix`**
  (subdomains only — the suffix itself does not match) | **CIDR** (`10.0.0.0/8`) |
  **a single IP literal** (`10.0.0.5` → /32, `::1` → /128). The `*` pattern ("any host") is
  **not allowed**: the validator rejects it, and a `*` rule in `exceptions` allows no host at all
  (fail-closed) — otherwise a single exception would lift the whole SSRF protection.
- Check order: **exception (hostname, no DNS) → resolve all A/AAAA → exception (address) → local
  name (`localhost`/`*.localhost`/`*.local`/`*.internal`) → `list`**. Local names are blocked
  **before** `list`, so an MCP add-on in a cluster (K3s: `*.svc.cluster.local`) must be allowed by a
  hostname exception (`*.svc.cluster.local`), not by a CIDR.
- A single IP in `list`/`exceptions` **works** and is equivalent to a CIDR with a full mask;
  IPv4-mapped addresses (`::ffff:10.0.0.5`) are normalized the same way as the checked address.
- `exceptions` are allow rules and are checked **first**: exact hostname, `*.suffix`, IP/CIDR. A hostname
  rule allows immediately; an address rule — by resolution.
- `deny` — block when **at least one** resolved address is in `list`; `allow` — permit only when **all**
  resolved addresses are in `list` or an exception matched.
- Literal `localhost`/`*.localhost`/`*.local`/`*.internal` and private addresses are blocked by the
  **policy itself** (local-name check + the default `list`), not by a separate hard-coded list of a
  subsystem; `exceptions` may allow them.
- `off` — **only** `egress.webhooks` (dev): no checks, the `https` requirement is lifted. For `tools`/MCP
  `off` is rejected (400).
- An invalid rule (garbage, regex-like, broken CIDR) → 400 `VALIDATION_ERROR`.
- **Fail-closed:** no value → config.yaml → built-in default (`deny` private ranges); "no policy" never
  means "everything is allowed".
- Env — scalars only (`mode`, `log.*`); `list`/`exceptions` — `config.yaml` only.

**Live and storage.** The policy is resolved from the store on **every** outbound operation (runtime
override in `{dataDir}/settings.json` → `config.yaml` → built-in default), with no background polling and no
cache; one snapshot per call. Changes apply without a restart. Management — `GET/PUT/DELETE
/api/v2/settings/egress/tools`, `.../egress/webhooks`, `GET/PUT/DELETE /api/v2/settings/mcp-network-policy`
and a check without performing the request — `POST /api/v2/settings/egress/check` (mutations in managed —
ADMIN, core — `requireAuth`); changes are written to the audit `{dataDir}/audit/security.jsonl`
(`GET /api/v2/audit/security`), requests to the journal `{dataDir}/audit/egress.jsonl`
(`GET /api/v2/audit/egress`; no bodies/headers, `url` without query/userinfo).

**MCP separately.** `mcp.networkPolicy` remains a **separate key** (not `egress.mcp`) but uses the same
format and validator; only user HTTP/SSE servers (`origin:'user'`) are checked — when writing to the
registry and when connecting; `origin:'instance'` and `stdio` servers are not checked, and there is no
per-project policy. The resolved address is not pinned (TOCTOU/DNS-rebinding —
[PROP-100](../arch_decisions/prop-100-ssrf-dns-rebinding.md)).
Example: an HTTP MCP add-on in K3s (`synth-gateway-telegram.synth.svc.cluster.local`) — the name ends with
`.local`, so it is blocked by the local-name check; allow it with the hostname exception
`exceptions: ["*.svc.cluster.local"]` (not a CIDR — a hostname exception matches before resolution).

**Out of scope.** LLM providers are not written to the egress journal (they have their own LLM
audit/payload log, ADR-036). With an HTTP/HTTPS/SOCKS5 proxy enabled
([`proxy.*`](#proxy-proxy-adr-099-d1d2) below) the proxy resolves addresses: Synth's address check runs in
proxied mode (scheme and hostname rules only, no DNS/CIDR), responsibility lies with the proxy/allowlist
(ADR-099 items 15/18); the exception is `proxy.noProxy` hosts (direct, full check). The policy
is **not a security boundary** when a shell, `stdio` MCP or external engines are available.

Example:

```yaml
egress:
  tools:                          # web_fetch/web_search, URL skills and instructions, provider icons
    mode: "deny"                  # deny | allow (SYNTH_EGRESS_TOOLS_MODE)
    list: ["10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "::1/128"]   # hostname | *.suffix | CIDR
    exceptions: []                # allow rules, checked first
  webhooks:                       # outgoing webhooks (ADR-052 stage II)
    mode: "deny"                  # deny | allow | off (off — dev, no https requirement)
    list: ["10.0.0.0/8", "127.0.0.0/8"]
    exceptions: ["hooks.internal.example"]   # e.g. allow a specific corporate host
  log:                            # outbound request journal
    enabled: true                 # SYNTH_EGRESS_LOG_ENABLED
    retentionDays: 7              # 0 — never prune (SYNTH_EGRESS_LOG_RETENTION_DAYS)

mcp:
  networkPolicy:                  # a separate key, the same format
    mode: "deny"
    list: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.169.254/32"]
    exceptions: []                # e.g. ["*.svc.cluster.local"] — allow an MCP add-on in a cluster
```

### Proxy (`proxy.*`, ADR-099 D1+D2; profiles and rules — item 27)

An outbound HTTP/HTTPS/SOCKS5 proxy — part of the single egress layer (see also `security.tls` — trust for the
**target** and for the https proxy, and `egress.*` — the address policy). The section is **top-level** and can
be configured in `config.yaml`/env and **from the admin UI** (section "Network" → "Proxy"; runtime
override, see "Configuring from the UI" in the `security.tls` section).
It is applied **at process startup** (the `EgressDispatcher` is start-only, like TLS): saving from the UI does
not switch the route live — a restart is required. The route is chosen **per origin**: `noProxy` (always
wins) → rules (`proxy.rules`, order = priority, **first match**) → `mode: all` ? `defaultProfile` : direct
(`selected`). Inside a profile: `httpsProxy`/`httpProxy` by the target scheme → `allProxy` → `url`.

| Field | Env | Purpose | Default |
|---|---|---|---|
| `enabled` | `SYNTH_PROXY_ENABLED` | Explicit switch. Unset — the proxy is enabled by the presence of a URL (including the standard env vars when `fromEnv`); an explicit `false` suppresses the standard env | — (auto) |
| `mode` | — | `all` — `defaultProfile` for everything except `noProxy` (rules override); `selected` — **only** rules, everything else direct | `all` |
| `defaultProfile` | — | Profile name for `mode: all` and rules without `profile`; required for `mode: all` (otherwise `default`, if present) | `default` (if present) |
| `profiles.<name>` | — | Named profile: `label`, `url` and/or `httpProxy`/`httpsProxy`/`allProxy`, `auth` (Basic), `tls` (to the proxy). Name — `^[a-z][a-z0-9_-]{0,31}$`, **immutable** | — |
| `rules[]` | — | Rules: `{id?, label?, hosts[], action: proxy\|direct, profile?}`; `action: direct` forbids `profile`; without `profile` — `defaultProfile` | `[]` |
| `url` | `SYNTH_PROXY_URL` | Common proxy `http://`/`https://`/`socks5://`/`socks5h://` (userinfo in config.yaml/env is allowed; when saving from the UI a password in the URL is **forbidden**). **Legacy**: without `profiles` — a synthetic `default` profile | — |
| `httpProxy` / `httpsProxy` | `SYNTH_PROXY_HTTP_PROXY` / `SYNTH_PROXY_HTTPS_PROXY` | Proxy for targets by scheme (`http`/`https`); takes precedence over `allProxy`/`url`. **Legacy** fields (forbidden with `profiles`) | — |
| `allProxy` | `SYNTH_PROXY_ALL_PROXY` | Proxy for all schemes (when no scheme-specific one). **Legacy** | — |
| `noProxy` | `SYNTH_PROXY_NO_PROXY` | Exceptions (win over rules): `host`, `.suffix` (apex + subdomains), `*.suffix` (subdomains only), `host:port`, IP, CIDR (matched against the target IP literal — no DNS), `*` | `[]` |
| `fromEnv` | — | Honour the standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` | `true` |
| `fallbackDirect` | `SYNTH_PROXY_FALLBACK_DIRECT` | Explicit opt-in: go direct when the proxy is unavailable (warn + `via:'fallback'`). Auth errors (`407`) do **not** allow fallback | `false` |
| `connectTimeoutMs` | `SYNTH_PROXY_CONNECT_TIMEOUT_MS` | Proxy connection timeout, ms | `10000` |
| `auth.type` | — | Only `basic`; `ntlm`/`negotiate` → error/400 (**domain authentication — egress gateway**, ADR-099 item 25) | `basic` |
| `auth.username` | — | Basic username (alternative — userinfo in the URL) | — |
| `auth` password | `SYNTH_PROXY_PASSWORD` (profile `default`), `SYNTH_PROXY_<NAME>_PASSWORD` (others) | Basic password: **only** the env var or a file (`{dataDir}/secrets/proxy-password`, `{dataDir}/secrets/proxy/<name>.password`); not stored in config.yaml/`settings.json` (invariant 13); the env var takes precedence over the file and blocks UI management (409) | — |
| `tls.caFile` / `tls.caPem` | `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | CA for the **https proxy itself** (mutually exclusive), per profile | system trust |
| `tls.certFile` / `tls.keyFile` | `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | mTLS to the https proxy (set together) | — |
| `tls.rejectUnauthorized` | `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | Verify the proxy certificate | `true` |

**Priority (ADR-023):** defaults ← `config.yaml proxy` ← **runtime override (UI)** ← explicit
`SYNTH_PROXY_*`; the standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` apply only with `fromEnv`
and when runtime/config did not set an explicit `enabled: false`. The merge is field-level (the UI edits
the config layer but **does not override the explicit deployment env**), **except** `profiles`/`rules`:
the runtime value replaces them **entirely** (no partial list merge). `noProxy`:
`SYNTH_PROXY_NO_PROXY` > runtime > a non-empty `proxy.noProxy` > `NO_PROXY`.

**Route resolution order:** `enabled:false` → direct; `noProxy` → direct (`no-proxy`); rules in declaration
order, **first match** (`rule`; `action: direct` → direct, `proxy` → profile `rule.profile ?? defaultProfile`);
`mode: selected` → direct (`no-match`); `mode: all` → `defaultProfile` (`default`). The same resolver is used
by the transport (`egressFetch`) and by diagnostics (`POST /settings/proxy/test`), so "the check says one
thing while the traffic does another" cannot happen.

**Patterns in `hosts`/`noProxy`:** `exact`; `.suffix` — apex **and** subdomains; `*.suffix` — subdomains
only (apex does **not** match); `host:port`; IP literal; CIDR (target IP literal only, no DNS for
rules/exceptions); `*`.

**Profile secrets (invariant 13).** The `default` password — `SYNTH_PROXY_PASSWORD` >
`{dataDir}/secrets/proxy-password` (legacy); others — `SYNTH_PROXY_<NAME>_PASSWORD` (name upper-cased,
`-` → `_`) > `{dataDir}/secrets/proxy/<name>.password`. Files `0600`, directories `0700`, atomic
tmp→rename; values are **write-only** (never returned, logged or written to the audit journal). TLS
material uploaded from the UI — `{dataDir}/secrets/proxy/<name>/{ca.pem,client.crt,client.key}` (only paths
land in the config).

**Legacy compatibility.** Without `profiles`/`rules` the behaviour is unchanged: top-level `url`/`httpProxy`/
`httpsProxy`/`allProxy`/`auth`/`tls` = a synthetic `default` profile. With `profiles` present, top-level
URL/auth/tls are **forbidden** (fail-closed); env `SYNTH_PROXY_URL`/`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` are
not applied in profile mode (a configuration error/400). On save the UI converts the legacy form into `profiles.default`, preserving the
scheme-specific fields.

**Fail-closed.** A broken URL, an unknown scheme, `enabled=true` without a URL, Basic without a password,
`auth.type` ≠ `basic`, `proxy.tls` together with `socks5://`, `caFile`+`caPem`, `certFile` without
`keyFile`, an unknown `defaultProfile`/rule `profile`, `action: direct` with `profile`, `mode: selected`
without rules, `mode: all` without a default profile (in `profiles`/`rules` mode), an invalid profile name → a configuration error
(`EGRESS_PROXY_CONFIG_INVALID`) at startup and 400 `VALIDATION_ERROR` when saving from the UI. An unavailable
proxy → `EGRESS_PROXY_UNAVAILABLE` (no silent direct); `407`/SOCKS refusal
→ `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED`.

**Address policy behind a proxy** (ADR-099 item 18): for requests through the proxy only the scheme and the
hostname rules/`exceptions` are checked (no DNS/CIDR — the proxy resolves the address); for `noProxy` hosts
the check is full (DNS/CIDR per hop). The actual route is written to the egress journal (`via`:
`proxy`/`direct`/`fallback`); `POST /api/v2/settings/egress/check` returns `proxied`/`addressChecksActive`.

#### Configuring from the UI (section "Network" → "Proxy")

- **What is editable:** `enabled`, `mode` (`all`/`selected`), `defaultProfile`, **profiles** (`label`,
  URL fields, `auth.username`, `tls.*` paths; the profile name is immutable), **rules** (order = priority,
  first match; `action`/`profile`/`hosts`), `noProxy`, `fromEnv`, `fallbackDirect`, `connectTimeoutMs`. A
  single `proxy` section is stored in `RuntimeSettings.proxy` (`{dataDir}/settings.json`; with
  `storage.backend=postgres` — the `settings` table, moved by `synth storage migrate`).
- **Profile secrets (write-only):** password — `PUT/DELETE /settings/proxy/profiles/:name/password`
  (`{dataDir}/secrets/proxy/<name>.password`; for `default` — legacy `secrets/proxy-password`), CA/mTLS —
  `PUT/DELETE /settings/proxy/profiles/:name/tls/{ca,client}`
  (`secrets/proxy/<name>/{ca.pem,client.crt,client.key}`, `0600`). With a profile env password
  (`SYNTH_PROXY_<NAME>_PASSWORD`) a mutation → `409 CONFLICT`; PEMs/keys and passwords are **never returned**.
- **Application:** at the **next startup** (`restartRequired`), not live. `GET /settings/proxy` returns
  `saved` (config ← runtime ← env), `running` (the current dispatcher), `defaults`, `isOverridden`,
  `restartRequired`; `profiles`/`rules` in the status are redacted (URL without userinfo, `username`, TLS
  paths, `hasCaPem`, `password:{source,set,removable}`); the flat response fields equal `saved` (backward compatibility). The UI shows a
  "changes take effect after a restart" banner linking to "Maintenance → Restart".
- **Checks:** `POST /settings/proxy/check` — connectivity **to the proxy** (without `url` — against the
  saved config, `usingSaved:true`); `POST /settings/proxy/test {url}` — a **target** check: `HEAD` without
  redirects or a body, the address policy is evaluated **before** the request, the response contains
  `route` (`action`/`via`/`reason`/`ruleId`/`ruleLabel`/`profile`/`profileLabel`/`proxyUrl`), `ok`,
  `httpStatus`, `latencyMs`, `authChallenge`, `usingSaved`, `restartRequired`.
- **Audit:** changes (save/reset/password/profile TLS) are written to `{dataDir}/audit/security.jsonl`
  with `scope:'proxy'` (before/after without the password, URLs redacted).

**RBAC:** read — `requireAuth`; save/reset, profile secrets and checks — `settingsWriteGuard` (managed —
`ADMIN`, core — `requireAuth`).

**Limitations.** Domain proxy authentication (NTLM/Negotiate/Kerberos) is **not implemented in the
application** — it is delegated to an intermediate egress proxy/gateway (ADR-099 item 25, see the next
subsection); `auth.type` ≠ `basic` → 400. `security.tls` for the **target** is not applied through SOCKS5
(a `Socks5ProxyAgent` limitation — system trust only); SOCKS5/SOCKS5H is **best-effort**, experimental,
resolves the hostname at the proxy, has no target CA/mTLS and is **not the target scheme for K8s** (use HTTP
CONNECT there). An https proxy/SOCKS by IP literal requires a DNS host (SNI by IP is forbidden in Node);
`proxy/check` may still report `reachable`. The built-in global `fetch` is not guaranteed (npm
`setGlobalDispatcher` does not affect it on Node 26; on Node 22 — re-check in CI) — the paths through
`egressFetch` are covered. There is no runtime reload without a restart. PostgreSQL is not proxied (not
HTTP). git applies `no_proxy` via libcurl, there is no per-remote setting; **per-host routing is not
supported in git/stdio MCP** (one proxy via child env; in `mode: selected` the proxy env is not set for
them, so rules are not silently bypassed); `stdio` MCP receives the proxy env without the password.

#### Corporate proxy with Kerberos/NTLM (egress gateway)

If the corporate proxy requires domain authentication, an intermediate **egress proxy/gateway** is placed
between Synth and it — for K8s this is the target scheme:

```text
[Synth] → HTTP CONNECT (Basic/mTLS/no auth) → [Squid | px] → Kerberos/NTLM → [corporate proxy] → Internet
```

- **Synth** points `proxy.url` at the internal gateway (e.g. `http://egress-gw.synth.svc:3128`), sets
  `noProxy` for `.svc`/the cluster, and optionally Basic/mTLS **to the gateway** (`proxy.auth` +
  `proxy.tls`). `auth.type: basic` applies only to the Synth↔gateway leg.
- **Squid (Kerberos):** upstream via `cache_peer`, authentication via `login=NEGOTIATE` with a keytab:
  ```squid
  cache_peer corp-proxy.corp.local parent 3128 0 no-query default \
             login=NEGOTIATE:svc-synth@CORP.REALM connection-auth=on
  never_direct allow all
  ```
  The keytab is a read-only Secret with `KRB5_KTNAME`; `krb5.conf` is a ConfigMap; the KDC must be reachable
  via NetworkPolicy (TCP/UDP 88, 464), NTP is mandatory. The gateway is a **separate Deployment/namespace**
  (better than a sidecar): the keytab never lands in the application pod; HA/rotation/audit live on the
  gateway.
- **`px` (px-proxy):** when **NTLM**/PAC or a standalone deployment (Docker/VM) is needed; Kerberos via
  `kinit`/ccache or `px` configuration (`PX_PASSWORD` for NTLM).
- **Why not in the application:** `undici.ProxyAgent` does not perform a 407 challenge → a custom CONNECT loop
  is required; a native dependency (libkrb5/`kerberos`), keytab/KDC/time/cross-realm, PAC/WPAD; acceptance
  only with the customer's AD/KDC; a larger blast radius (keytab in the pod) and multi-arch/image support.
  Estimate 4–8 weeks + maintenance (NTLM separately +1–2 weeks). Details —
  [ADR-099](../arch_decisions/adr-099-egress-tls-trust.md) item 25.
- **SOCKS5** — best-effort and not for K8s; if target mTLS is needed, use HTTP CONNECT (ADR-099 item 26).

Example (single proxy — legacy form, equivalent to `profiles.default`):

```yaml
proxy:
  enabled: true
  # url: "http://proxy.corp.example:3128"        # common; or the scheme-specific ones below
  httpProxy: "http://proxy.corp.example:3128"
  httpsProxy: "https://proxy.corp.example:8443"  # https proxy: TLS — in proxy.tls
  # allProxy: "socks5://proxy.corp.example:1080" # SOCKS5 (without proxy.tls)
  noProxy: ["localhost", ".corp.example", "git.corp.example:22", "10.0.0.0/8"]
  fromEnv: false
  fallbackDirect: false
  connectTimeoutMs: 10000
  auth:
    type: "basic"
    username: "synth"              # password — SYNTH_PROXY_PASSWORD or {dataDir}/secrets/proxy-password
  tls:                             # TLS/mTLS to the https proxy (not to the target)
    caFile: "/etc/synth/tls/proxy-ca.pem"
    # certFile: "/etc/synth/tls/proxy-client.pem"
    # keyFile: "/etc/synth/tls/proxy-client.key"
    rejectUnauthorized: true
```

Example (profiles and rules — several proxies for different destinations):

```yaml
proxy:
  enabled: true
  mode: all                        # all | selected
  defaultProfile: default
  profiles:
    default:                       # corporate proxy for everything except noProxy
      label: Corporate
      url: "http://proxy.corp.example:3128"
      auth: { type: basic, username: synth }
      tls: { caFile: "/etc/synth/tls/proxy-ca.pem", rejectUnauthorized: true }
    llm:                           # dedicated LLM egress with mTLS
      label: LLM egress
      url: "https://llm-proxy.svc:8443"
      auth: { type: basic, username: synth-llm }
      tls:
        caFile: "/etc/synth/tls/llm-ca.pem"
        certFile: "/etc/synth/tls/llm-client.crt"
        keyFile: "/etc/synth/tls/llm-client.key"
  rules:                           # order = priority, first match
    - id: r_openai
      label: OpenAI
      hosts: ["api.openai.com", "*.openai.com"]
      action: proxy
      profile: llm
    - hosts: ["*.corp.example", "10.0.0.0/8"]   # CIDR — target IP literal only
      action: direct
  noProxy: ["localhost", ".svc"]   # wins over any rule
```

Profile passwords live only in env/files (not shown above): `SYNTH_PROXY_PASSWORD` /
`{dataDir}/secrets/proxy-password` for `default`, `SYNTH_PROXY_LLM_PASSWORD` /
`{dataDir}/secrets/proxy/llm.password` for `llm`.

### At-rest secrets (`security.secretKey`, ADR-076)

- `security.secretKey` — the master key for encrypting the secrets in storage (agent SSH keys; AES-256-GCM). Env — `SYNTH_SECRET_KEY`.
- **Priority**: env `SYNTH_SECRET_KEY` > `config.security.secretKey` > the file `{dataDir}/secrets/master.key` (the `resolveSecretKey` resolver).
- **Key formats**: base64 (exactly 32 bytes) or 64 hex characters; otherwise — the error `encryption_unavailable` (no silent truncation).
- **Fallback file**: if the key is set neither via env nor via the config, core creates `{dataDir}/secrets/master.key` on the first start (`randomBytes(32)`, directory `0700`, file `0600`, atomic write). Secrets are encrypted at rest.
- **Rotation**: `synth secrets rotate` (`--data-dir`, `--config`, `--old-key`/`--old-key-file`, `--new-key`/`--new-key-file`, `--dry-run`, `--yes`) re-encrypts the existing SSH keys from the old key to the new one (preflight: an undecryptable field → abort, nothing is written), updates `master.key` and resets the cache; `--dry-run` shows a summary without writing. Without `--yes` (and without `--dry-run`) — refusal. If the effective key is set via env/`config.security.secretKey`, the file is overwritten but ignored at start — update the key in env/config. Before rotation a backup of `$SYNTH_DATA_DIR` and stopping the server are recommended.

### External access secrets (OAuth, ADR-105)

External access secrets (OAuth connectors) are **never stored in `config.yaml`** (invariant 13) — only env variables or files in the `secrets/` directory.

| What | Where | Permissions |
|------|-------|-------------|
| `client_secret` of an OAuth provider | env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` (e.g. `provider=google` → `SYNTH_OAUTH_GOOGLE_CLIENT_SECRET`) **or** the file `{dataDir}/secrets/oauth/<provider>.client_secret` | file `0600`, the `secrets/` directory — `0700` |
| access/refresh tokens of the credentials | `{dataDir}/secrets/oauth/credentials.json` (file backend; PostgreSQL — the `external_credentials` table) | file `0600`, atomic write tmp→rename (ADR-005) |

- **`client_secret` priority**: env → file → "no secret". An empty env value or file is treated as "no secret" — an empty `client_secret` is never sent to the provider.
- In `config.yaml` an OAuth provider holds **data only**: `authorizeUrl`/`tokenUrl`/`revokeUrl`/`clientId`/`scopes`/`clientAuth`/`redirectUri`. The core reads the secret itself and never exposes it (API/UI, logs, error texts).
- Tokens are **encrypted** at rest with the master key (`enc:v1:…`, ADR-076) — plaintext never appears on disk; only metadata with a mask is exposed.
- **Backup**: the `secrets/` directory is excluded from the `synth backup` archive without `--with-secrets` — the credential tokens are excluded with it. The project export/import (ADR-091) does not carry credentials over: they are instance-local.
- The subsystem description — [EXTERNAL_ACCESS.md](../EXTERNAL_ACCESS.md) (RU); the decision — [ADR-105](../arch_decisions/adr-105-external-credentials.md).

### OAuth provider catalog (`oauth.providers`, ADR-105 stage 3)

The catalog describes the **data** of the external OAuth providers of the instance: endpoints, `client_id`, scopes.
The core builds the OAuth client (code exchange, refresh, revoke) for the credential records from that description.
An empty catalog is a normal state: credentials created by code work, but there is nothing to **refresh** a token
with without a provider description (refresh returns a clear "provider is not registered" error).

```yaml
oauth:
  providers:
    github:
      authorizeUrl: "https://github.com/login/oauth/authorize"
      tokenUrl: "https://github.com/login/oauth/access_token"
      revokeUrl: "https://api.github.com/applications/token"
      clientId: "synth-client"
      scopes: ["repo", "read:user"]
      clientAuth: "none"           # none (PKCE, public client) | client_secret_post | client_secret_basic
    google:
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth"
      tokenUrl: "https://oauth2.googleapis.com/token"
      clientId: "synth-client"
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
      clientAuth: "client_secret_post"
```

| Field | Required | Purpose |
|------|----------|---------|
| `authorizeUrl` | yes | authorization endpoint (RFC 6749 §3.1) |
| `tokenUrl` | yes | token endpoint (code exchange and refresh, RFC 6749 §3.2/§6) |
| `revokeUrl` | no | token revocation endpoint (RFC 7009) |
| `deviceAuthorizationUrl` | no | device authorization endpoint (RFC 8628 §3.1) |
| `clientId` | yes | public `client_id` of the application (not a secret) |
| `scopes` | no | default scopes (default `[]`) |
| `clientAuth` | no | client authentication method: `none` (PKCE, default) / `client_secret_post` / `client_secret_basic` |
| `redirectUri` | no | default `redirect_uri` |

- **Env override**: `SYNTH_OAUTH_PROVIDERS` — a JSON object "name → description" (the same format). A provider from env **replaces** the same-named one from `config.yaml`; the other entries are kept. Invalid JSON, or a set that fails validation, → a warning in the log and **ignore**: a broken catalog must not break the instance start (the credentials simply are not refreshed).
- **The catalog holds no `client_secret`** (invariant 13) — only env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` or the file `{dataDir}/secrets/oauth/<provider>.client_secret`; see the section "External access secrets (OAuth, ADR-105)" above.
- The catalog key matches the `provider` field of the credential record; the subsystem description — [EXTERNAL_ACCESS.md](../EXTERNAL_ACCESS.md) (RU).

### Installer service key (`security.bootstrapServiceKeys`, ADR-052/O1)

The section defines **installer service keys** that are provisioned idempotently at
start (core standalone and backend) — for machine installation of add-ons (MCP servers,
skills) and consent-based reading of users without manually creating a key via the API.

Element format:

| Field | Required | Purpose |
|------|-------------|------------|
| `label` | yes | Unique label of the key (`create`/`ensure` idempotency by it, case-insensitive) |
| `secret` | yes | Plaintext secret (`synth_svc_…`; if the prefix is missing — it is appended). Only the sha256 hash is stored at rest |
| `scopes` | yes | List of known scopes (e.g. `addons:install`, `users:read`) |
| `roles` | no | Roles of the synthetic user (if not set — `USER`) |
| `description` | no | Key description |

Behaviour: if a key with such a `label` does not exist — it is created with the given secret; if
it exists — `scopes`/`roles` are synchronized (**the secret is not changed**). The status
(`created`/`updated`/`unchanged`) is written to the log. A configuration error of one key
**does not crash the start** (best-effort, the log is without secrets).

**Priority**: env `SYNTH_BOOTSTRAP_SERVICE_KEYS` (a JSON array, usually from a
k8s Secret) > `config.security.bootstrapServiceKeys` in `config.yaml`. It is recommended to
keep the secret in env/Secret rather than in the configuration file.

In the Helm chart `charts/synth` the installer key is provisioned by the `installerKey` option
(creates a Secret and passes `SYNTH_BOOTSTRAP_SERVICE_KEYS`; `existingSecret` —
take a ready Secret); details — `charts/synth/README.md`.

Example (an installer key for installing add-ons):

```yaml
security:
  bootstrapServiceKeys:
    - label: addon-installer
      secret: "synth_svc_…"          # better to pass via env, not in git
      scopes: [addons:install]
      roles: [USER]
      description: "Installing add-ons (MCP/skills)"
```

```bash
# k8s: the value from a Secret → pod env (takes precedence over config.yaml)
SYNTH_BOOTSTRAP_SERVICE_KEYS='[{"label":"addon-installer","secret":"synth_svc_…","scopes":["addons:install"]}]'
```

### Shell execution audit (`security.commandAudit`, ADR-136)

Append-only journal of **actual executions** of `execute_shell`/`sandbox_exec`:
one JSONL line per record in `{dataDir}/audit/commands.jsonl` (or `path`).
Every run produces two records (`phase: "started"` before the launch,
`phase: "finished"` after) linked by one `id`; stdout/stderr bodies are **not**
written — only `bytesOut`, `truncated`, `outputSha256` and `exitCode`.

- **`enabled`** — master switch. Profile default: **managed/backend — `true`**
  (`loadBackendConfig` → `baseDefaults`), **standalone — `false`**.
- **`retentionDays`** (default 30) — retention; cleanup —
  `DELETE /api/v2/audit/commands?older_than_days=N` (ADMIN). `<= 0` — no limit.
- **`path`** — journal path; empty → `{dataDir}/audit/commands.jsonl`.
- Env: `SYNTH_COMMAND_AUDIT_ENABLED` (bool), `SYNTH_COMMAND_AUDIT_RETENTION_DAYS`
  (integer). Priority env > `config.yaml` > profile default; an invalid env value
  is ignored (the journal is observability, not an access rule).

**A write failure blocks execution** when the journal is enabled: the `started`
record is written **before** the command runs, so on a write error (missing
directory, permissions, disk) the command is **not executed** and the model gets
an `isError` result with the reason. A `finished` write failure is only a warning
in the log (the command already ran; the result is not broken). A disabled
journal changes nothing.

The stored command is **de-identified**: session obfuscation-map values (ADR-036)
are replaced with placeholders, then value patterns are redacted (`Bearer …`,
`--password=…`/`--token=…`/`--api-key=…`, URLs with userinfo → `***`), and only
then truncated to 4 KiB (`command`); `commandHash` is the sha256 of the **full**
de-identified string. For `sandbox_exec` the command is `commands.join(" && ")`.

Read — `GET /api/v2/audit/commands` (managed — ADMIN/AUDITOR, standalone —
`requireAuth`); metrics — `synth_command_audit_*` (see `docs/OBSERVABILITY.md`).
Command policy checker is enforced **on the executor** before spawn (ADR-136b-1): `SYNTH_EXECUTOR_COMMAND_POLICY_*`, `http-json`/`opa` contracts, fail modes and cache — [docs/EXECUTION.md](../EXECUTION.md) §9.2. Control-plane mirror and verdict audit — `security.commandPolicy` (below).

### Mirrored command checker (`security.commandPolicy`, ADR-136b)

**Optional**: `enabled: false` (default) — previous behaviour, no provider is
created, the command policy is never consulted.

Mirrored check **in the control plane**: at the `execute_shell`/`sandbox_exec`
execution point the command is sent to the external checker **before** the audit
`started` record and before the launch. `deny` is an early refusal/UX: the model
gets an `isError` result `Command denied by policy: <reason>`, the command is not
executed, and the execution journal gets **one** record (`phase: "finished"`,
`decision: "deny"`, `decidedBy: "policy"`, `durationMs: 0`, `provider`). `allow`
continues the execution; both journal records carry `decidedBy: "policy"` and
`provider` (`kind`/`ruleId`/`latencyMs`/`action`).

**The security boundary is the executor** (ADR-136b-1): there the check runs
before `spawn`. The control-plane mirror does not replace it and guarantees
nothing in `inline` mode; it provides an early refusal and an audit trail.

| Key | Default | Env | Meaning |
|---|---|---|---|
| `enabled` | `false` | `SYNTH_COMMAND_POLICY_ENABLED` | master switch (no provider is created when `false`) |
| `provider` | `http` | `SYNTH_COMMAND_POLICY_PROVIDER` | `http` (`POST {url}/v1/check`) or `opa` (`POST {url}{opaPath}`) |
| `url` | `""` | `SYNTH_COMMAND_POLICY_URL` | checker address; **required** when `enabled: true` |
| `tokenSecret` | `""` | `SYNTH_COMMAND_POLICY_TOKEN` | **path** to the bearer token file (not the value, invariant 13) |
| `failMode` | `open` | `SYNTH_COMMAND_POLICY_FAIL_MODE` | checker unavailable: `closed` → `deny`, `open` → `allow` + warning |
| `timeoutMs` | `2000` | `SYNTH_COMMAND_POLICY_TIMEOUT_MS` | request timeout, ms (integer ≥ 1) |
| `opaPath` | `/v1/data/synth/exec/decision` | `SYNTH_COMMAND_POLICY_OPA_PATH` | OPA decision path (`provider: opa`) |

**Profile defaults.** `failMode`: standalone — `open` (schema), **managed/
backend — `closed`** (`loadBackendConfig` → `baseDefaults`; an explicit
`config.yaml`/env overrides it). Priority is the common one (ADR-023): env >
`config.yaml` > profile default > schema.

**`enabled: true` without `url` is a startup error** (fail-closed: otherwise the
instance would silently run without the policy). Invalid env values (`provider`,
`failMode`, `timeoutMs`, `enabled`) also fail configuration loading instead of
being warn+ignored: this is a security setting.

**Not switchable at runtime.** The provider is built at process startup; a change
of `security.commandPolicy` (as with the rest of the UI "Security" section) is
applied **after an instance restart** — there is no live re-initialization
(invariant 24).

Checker responses: `http` — `{action, reason?, rule_id?, ttl_ms?}`; `opa` —
`{result: {allow, reason?, rule_id?}}`. Non-2xx, timeout, invalid response and an
unreadable token file all mean "checker unavailable" (per `failMode`), and
unavailability is never cached. Verdict cache: key `sha256(command + cwd +
background)`, TTL — the response `ttl_ms` or 60 s; `deny` is cached like `allow`.
Metrics — `synth_command_policy_*` (see `docs/OBSERVABILITY.md`).

**Kubernetes deployment.** The executor-side check is enabled by chart values
(the env table is in [EXECUTION.md](../EXECUTION.md) §9.2): the executor pool uses
`executor.commandPolicy.*` (env `SYNTH_EXECUTOR_COMMAND_POLICY_*`, token mounted from a Secret
as a file), and provisioner dynamic pools use `provisioner.executorCommandPolicy.*`
(only with `provider: kubernetes`). `enabled` without `url` fails chart rendering;
the token is never stored in values (Secret only).

### Tool policies (`tools.policy` / `mcp.policy`)

Two **independent** admin policies (ADR-071 §2.3; the UI section is the ADMIN category):
`tools.policy` manages only **built-in** tools, `mcp.policy` —
only **MCP** tools. Both: `consistency` | `available` | `auto`
(default `auto`). Per-session override — `session.settings.toolsPolicy` and
`session.settings.mcpPolicy` respectively. Runtime editing:
`GET/PUT /api/v2/settings/tools-policy` and `GET/PUT /api/v2/settings/mcp-policy`
(live application, persisted in `settings.json`). MCP prompt blocks
(`mcp.servers`/`mcp.tools`/`mcp.status`) are always `volatile` and are not part of the
cacheable `staticPrefixChars`.

### Disabling built-in tools (`tools.disabled`)

Instance-wide setting (ADR-071 §2.6; the UI section is the ADMIN category `mcpAdmin`):
hard-excludes built-in tools from the request **independently** of
`tools.policy` — both by groups (`capabilities`, `ToolCapability` values:
`file_read`, `file_write`, `shell`, `search`, `web`, `git_read`, `git_write`,
`task`, `mcp`) and by individual tools (`tools`). The effective
set = the tools available to the agent/mode − (union of the disabled groups and names).

`runtime` tools (plan/todo management, project, reference, classify)
cannot be disabled — otherwise the ADR-039 invariant breaks. Disabled tools are not sent in the
request and are not shown in the prompt-composition table (in the admin UI they can be
enabled/disabled). Runtime editing: `GET/PUT /api/v2/settings/tools-disabled`
with the body `{toolsDisabled:{capabilities,tools}}` (live application, persisted in
`settings.json`).

### Tool output limit (`tools.outputMaxLines` / `tools.outputMaxBytes`)

The common size limit for the result of **any** tool: it is applied in the single call point
(`executeToolDef`), so built-in, MCP and plugin tools are all limited. The stricter of the two
limits wins.

| Field | Purpose | Default |
|-------|---------|---------|
| `tools.outputMaxLines` | Limit on the number of lines in a tool result (≥ 1) | `2000` |
| `tools.outputMaxBytes` | Limit on the size of a tool result in UTF-8 bytes (≥ 1) | `51200` |

- Env — `SYNTH_TOOLS_OUTPUT_MAX_LINES` / `SYNTH_TOOLS_OUTPUT_MAX_BYTES`.
- A tool that **truncated the output by its own limit** (`read_file`/`list_directory`
  pagination, the number of `grep_files` matches) is still cut by the common limit:
  `metadata.truncated` means "the tool truncated the result by its own limit", not
  "the tool already fits the byte budget". A tool cannot switch the output limit off
  (incident 2026-11-08: `grep_files` with a single 236 KB line marked the result as
  truncated and pushed 243 KB into the model context).
- The only result that is not cut again is one that **really** fits the common
  budget. The marker `metadata.outputBounded` ("the tool already fitted the output
  into the common budget") **does not switch the limit off**: its truthfulness is
  not verified, so the decision is made by the actual size of the output. Output
  within the budget is returned as is (with the tool's own marker and counters,
  no second marker); output beyond the budget is cut, and the metadata carries the
  **actual** `truncated: true` and `outputBounded: {shownLines, totalLines}` (the
  tool's forged counters are overwritten). Audit 0.13.8, exception
  `tool-output-cap-bypass-via-metadata`: a tool forged the marker and pushed
  600,001 bytes into the model context.
- The tool's own truncation marker (`metadata.truncationNote`) is not lost when the
  common limit cuts the tail of the output: it is returned to the end of the truncated
  result — next to the common `tool.output_bounded` marker.
- Error results (`isError`) are not cut either — the error text carries diagnostics,
  not output.
- When the output is cut, an explanation `tool.output_bounded` is appended: how many lines are
  shown out of how many and how to narrow the request; the metadata carries `truncated: true`
  and `outputBounded: {shownLines, totalLines}`.
- **The full text is not stored**: the cut part of the output does not survive anywhere (unlike
  tool artifacts) — the model has to repeat the request with a narrower condition if it needs
  the rest.
- This does **not** replace the per-tool limits (`read_file` — 2000 lines/50 KB,
  a line ≤ 2000 characters; `grep_files` — a matching line ≤ 2000 characters;
  `execute_shell` — its own output cap): the common limit sits above them and fires last.

```yaml
tools:
  outputMaxLines: 2000
  outputMaxBytes: 51200
```

### Skills (`skills.*`, ADR-126)

The `skills` section manages skill discovery, trust of project directories,
inline shell in template commands and remote catalogs. A skill is invoked
**only** as `$name` (ADR-126 §3): `/` commands and skills no longer compete for
names, and `metadata.synth.command` does not create a `/` command.

| Field | Purpose | Default |
|------|-----------|--------------|
| `skills.paths` | Extra user skill directories (after project/instance) | `[]` |
| `skills.trustedProjectDirs` | Trusted project directories (binary project-trust) | `[]` |
| `skills.inlineShell` | Allow `` !`cmd` `` in template commands (an RCE vector, trusted sources only) | `false` |
| `skills.urls` | Remote catalogs (an opencode-compatible `index.json`) — **read-only indexation** in `{dataDir}/skills-cache` | `[]` |
| `skills.toolsets` | Named tool groups → capabilities (see below) | `{}` |

Order of sources (priority, first-wins): `{project.workspace}/.synth/skills` >
`{dataDir}/skills` > `skills.paths` > external read-only catalogs
(`.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`,
`~/.config/opencode/skills`) > `skills.urls`.

- **Project-trust:** an untrusted project directory (not in `trustedProjectDirs`)
  is visible in the registry/diagnostics (`untrusted`), but its skills and template commands
  are not loaded — they do not get into the model catalog, the `$` invocation or the core
  `skill` tool.
- **`skills.urls`** are cached, indexed and visible in the registry, but marked
  **`trusted:false`** (they do not get into the model catalog). Installation/update,
  trust levels and signatures of remote catalogs — the task [PROP-068](../arch_decisions/prop-068-skills-agents-registry.md).
- **`skills.inlineShell`** is disabled by default; when enabled, execution happens
  only with `allow` from `PermissionEvaluator` (like `execute_shell`), with a timeout,
  an output limit and the audit event `command.inline_shell`; `deny`/`ask` —
  refusal without an interactive prompt.
- **Builtin skill `skill-creator`** (`instance`/`system`, `trusted`) — a built-in
  instruction on creating a project skill in `{project.workspace}/.synth/skills`;
  available as `$skill-creator` (requires `file_read`/`file_write`); `/skill-creator` is not supported (ADR-126 §7).

### Project instructions (`instructions.*`, ADR-069)

Auto-loading of repository `AGENTS.md` into the system prompt (the `[PROJECT INSTRUCTIONS]` block, tier `context`):

| Field | Purpose | Default |
|------|-----------|--------------|
| `instructions.enabled` | Global auto-loading toggle | `true` |
| `instructions.claudeCompat` | Read `CLAUDE.md` if there is no `AGENTS.md` | `true` |
| `instructions.contextCompat` | Read the deprecated `CONTEXT.md` | `false` |
| `instructions.windowRatio` / `minChars` / `maxCharsCeiling` | Dynamic cap from the model window (`clamp(ratio*window, min, ceiling)`) | `0.06` / `20000` / `500000` |
| `instructions.maxChars` | Explicit cap override (disables the dynamics) | — |
| `instructions.headRatio` / `tailRatio` | head/tail shares when truncating | `0.7` / `0.2` |
| `instructions.lazy.{enabled,maxAncestors,maxChars,excludeDirs}` | Lazy loading of nested instructions into a tool result | `true` / `5` / `8000` / `[node_modules,.git,…]` |
| `instructions.fetch.{timeoutMs,cacheTtlSec,maxBytes}` | Fetch policy of URL sources | `5000` / `3600` / `262144` |
| `instructions.sources` | Extra sources `{ kind: path\|url, value, position: before\|after, label?, ttlSec? }` | `[]` |
| `instructions.excludeProjects` | Projects where auto-loading is disabled | `[]` |
| `instructions.allowInstallTreeFallback` | Load instructions inside the Synth source tree | `false` |

- Discovery: the chain `git root → … → workspace` (deeper = higher priority), per directory `AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` > `CONTEXT.md`; sha256 deduplication.
- **`sources`:** `position: before|after` — before/after the merged chain; `kind: path` — `value` relative/glob/`~/`/absolute; `kind: url` — read-only fetch with a TTL cache in `{dataDir}/instructions-cache` (`ttlSec` overrides `fetch.cacheTtlSec`), cap `fetch.maxBytes`.
- Each block goes through a **threat scan** (ADR-036): `block` — not loaded, `flag` — with a WARN line.
- **Project-trust:** instructions of an untrusted project (not in `skills.trustedProjectDirs`) are not loaded (status `untrusted`). A directory inside `storage.workspacesRoot` is trusted **automatically** (R3) — the gate is shared by the system chain and lazy loading; it does not affect project-trust of skills (ADR-126).
- **Install-tree guard:** inside the Synth source tree instructions are not loaded (status `skipped-install-tree`), except with `allowInstallTreeFallback: true`.
- **Cache/invalidation (R5, no new settings):** the resolver result is cached by the candidate signature (`mtime:size`, the helper `engine/file-signature.ts`, shared with skills ADR-126); a file change/addition/removal invalidates it, `ProjectInstructionsResolver.clear()` — a forced reset. In a real turn the result is additionally memoized by `turnId`.
- Disabling: `instructions.enabled=false`, `excludeProjects`, the CLI `--ignore-rules`/`--safe-mode` (or the env `SYNTH_IGNORE_RULES=1|true`; the flags take precedence over env, they work for `serve` and `chat`), as well as the `session.settings.systemPrompt` override.
- Transparency: `GET /api/v2/context/instructions?session_id=…` and the event `context.instructions_loaded`; the UI — the "Project instructions" section in the right panel (the "Session" tab).
- `/init` — a builtin command (status `prompt`) that generates/updates `AGENTS.md`; the skill `synth-agents-md` (`$synth-agents-md`) audits/updates the instructions.

### Slash commands (`commands.*`, ADR-126)

Resolving `/` commands is done in core. The `commands` section:

| Field | Purpose | Default |
|------|-----------|--------------|
| `commands.paths` | Extra directories of templated `.md` commands (after project/instance) | `[]` |
| `commands.bundlesPath` | Subdirectory of `{dataDir}` for YAML bundles | `skill-bundles` |
| `commands.conflict.mode` | Name-conflict mode: `bundle-wins` \| `conservative` \| `namespace` | `bundle-wins` |
| `commands.conflict.namespacePrefix` | Deprecated: there are no skills in the `/` catalog (ADR-126 §7), so `<bundle>:<skill>` is not created | `false` |
| `commands.maxArgumentsLength` | Limit of `$ARGUMENTS` | `10000` |
| `commands.maxRenderedBytes` | Limit of rendering a template/bundle aggregate | `200000` |

Sources of template commands (priority): `{project.workspace}/.synth/commands` > `{dataDir}/commands` > `commands.paths`. Built-in commands — `/help`, `/skills`, `/commands`, `/summary`, `/compact`, `/init` (ADR-069), `/review` (ADR-126 §1). `/summary` and `/compact` trigger manual context compression (ADR-119; profile `summarization`/`compaction`); session settings are unchanged. `/init` and `/review` are prompt commands (status `prompt`): `/init` generates/updates `AGENTS.md`, `/review` reviews **code changes** in a git repository (no argument — uncommitted changes, argument — commit/branch/PR; when there is no git repository or no diff, the model states that reviewing the changes is not available instead of inventing changes). Skills are **not** part of the `/` catalog: invoke them as `$name` (`$skill-creator`, `$synth-agents-md`, …), list them with `/skills`; `GET /commands` and the `/` autocomplete contain no skills. `commands.conflict.namespacePrefix` no longer creates `<bundle>:<skill>`; conflict modes describe builtin/template/bundle only. `allowed-tools` in the frontmatter is advisory (not translated into permissions).

Snippets (`#name`, ADR-126 §4) are markdown content files: `instance` — `{dataDir}/snippets`, `project` — `{project.workspace}/.synth/snippets`, `user` — `{dataDir}/snippets/users/<userId>`; precedence `user > project > instance`, canonical name beats an alias. Expansion happens on prompt ingress before the queue; limits 15 expansions / 64 KB; code blocks are untouched; snippets of an untrusted project are visible but not expanded. Name — `[a-z][a-z0-9_-]{0,79}`.

### Project scripts (`scripts.*`, ADR-126 §5)

The `scripts` section is the registry of the declared project scripts (the `!` run, ADR-126 §5).
A script is a **declaration** (markdown + frontmatter), not an executable file: the interpreter
and the arguments are the data of the declaration; the executable file stays an ordinary
repository file.

| Field | Purpose | Default |
|------|-----------|--------------|
| `scripts.paths` | Extra directories of `.md` declarations (after project/instance) | `[]` |

Sources of declarations (precedence, first-wins): `{project.workspace}/.synth/scripts` >
`{dataDir}/scripts` > `scripts.paths`. The project declarations live in
`{project.workspace}/.synth/scripts/<name>.md` and obey **the same trust gate** as the skills
and the commands (ADR-126 §9): an untrusted project directory is visible in the registry
(`available: false`) but is not run.

The format of a declaration is markdown + a tolerant YAML frontmatter (the same parser as for
skills; unknown keys do not break the discovery):

```md
---
description: Start the backend (:5000) and the UI (:5002)
run: ./scripts/dev.sh
args: false
cwd: .
timeout: 86400
requires: [bash]
env: {}
shell: false
ready: ""
---
Local debugging without building the packages. Stop it — "Processes" → dev.
```

| Key | Purpose | Default |
|------|-----------|--------------|
| `description` | Description of the action (1..1024) — for the human and the agent | — (required) |
| `run` | The run command: a file path (argv form) or a string (with `shell: true`) | — (required) |
| `args` | Whether the script accepts arguments (`!name a b`) | `false` |
| `cwd` | The working directory — a **relative** path inside the session perimeter | the working directory of the session |
| `timeout` | The run timeout, **in seconds** (1..86 400). A script always runs in the background — the background ceiling applies | `86400` (one day) |
| `requires` | The binary requirements of the run (the shell form defaults to `bash`) | — |
| `env` | Extra environment variables of the run (names — `^[A-Za-z_][A-Za-z0-9_]*$`) | — |
| `shell` | `run` is executed by a shell (otherwise — the file is run directly) | `false` |
| `ready` | The readiness marker — **kept, the detection is out of scope** | — |

The script name is `^[a-z0-9]+(-[a-z0-9]+)*$`: it is taken from `name` in the frontmatter,
otherwise from the file name without `.md`. The advisory hint about the arguments is
`argument-hint` (in the DTO — `argumentHint`). The arguments are parsed by the script lexer
(without shell substitutions).

**Every run is always a background one** — this is a mode of the subsystem, not a
declaration option: a run creates a background process (ADR-113) and the composer is not
blocked until it completes. The `started`/`finished` pair is written to the command audit
journal (ADR-136) with a single `execution_id`. The readiness detection (`ready`) is out of
scope.

### Tool groups for skills (`skills.toolsets`)

`skills.toolsets` — a dictionary `name → ToolCapability[]`. It expands a skill's `metadata.synth.requires_toolsets`: the availability check runs over `requires_capabilities ∪ expand(requires_toolsets)`. Example:

```yaml
skills:
  toolsets:
    git: [git_read, git_write]
    web: [web]
```

### External events (`events.*`, ADR-089)

Accepting external events and routing through `EventRouter` (ADR-089). Section fields:

| Field | Purpose | Default |
|------|-----------|--------------|
| `events.enabled` | Master switch for accepting external events; `false` → `POST /api/v2/events` responds 503 `UNAVAILABLE` (the CRUD of bindings/routes/journal remains) | `true` |
| `events.defaultMode` | Router fallback if neither an `EventBinding` nor a rule selected a route: `bound` — a deliberate `drop no_route` with audit; `ephemeral` — create a temporary session (default agent) with the TTL `events.ephemeralTtl` | `bound` |
| `events.ephemeralTtl` | TTL of ephemeral sessions (format `24h`, `30m`, …) | `'24h'` |
| `events.journalRetentionDays` | Event journal retention, days (0 — no limit); cleanup — the pruner at start and every 6 h (`EventJournalStore.prune`) | `30` |
| `events.allowedSources` | Allowlist of sources (empty — all are allowed) | `[]` |
| `events.dedupStore` | Event dedup source: `memory` — in-process `Set` (single-process), `file` — cross-process atomic claim on a shared `dataDir` (`{dataDir}/events/dedup/<sha256(key)>`) | `memory` |
| `events.unknownAgentTemplate` | Behaviour if the event's/rule's `agentTemplate` does not resolve to an enabled agent: `drop` — do not create a session, record `agent_not_found` in the journal (fail-safe); `default-agent` — do not set `agentRole` (the session will take the default agent) | `drop` |
| `events.keyRateLimitPerMinute` | Global default requests/min rate limit per binding API key (0 — no limit); a specific key overrides it with `rateLimitPerMinute`; exceeding → 429 `RATE_LIMITED` | `0` |
| `events.decisionRouting` | ADR-084 × ADR-089: smart classification of external events by a decision model. `false` — declarative rules only; `true` — when the rules miss, the decision model picks an agent template (ephemeral session). Requires a configured `decision.*`; fail-safe: an error/low confidence/no agents → fallback to `defaultMode` | `false` |
| `events.autoBind` | ADR-089: Router fallback — if the event has `identity.chatKey` or `identity.threadKey`, bind it to a new session (`EventBinding mode='bound'`) instead of `defaultMode`. Affects **only** the fallback (an explicit binding/rules/decision routing take precedence). Protection from junk sessions: the flag is off by default + `allowedSources` + per-key rate limit | `false` |
| `events.autoBindAgentTemplate` | ADR-089: agent template of auto-bind sessions (agent id; empty — the default agent). An unknown template is handled by the `events.unknownAgentTemplate` policy | `''` |
| `events.identityMap` | ADR-089: an **override** map of an external sender's identity to the owner of a Synth session. The main source of the owner — bindings in the **profile** (`ProfileData.identities[]`, key `provider:externalId`; populated by the claim flow — confirming id ownership with a one-time code, the API `POST /api/v2/me/identities/claim`). The map sets a **manual** override and takes precedence over the profile. The key — `identity.principalId` (`tg:<id>`; **preferred** for the owner — a human, not a chat) or `identity.chatKey` (`chat:telegram:<id>`; a fallback — DM/chat level), the value — the instance user id. It is applied when materializing `ephemeral`/`bind` sessions; it has a higher priority than the per-event owner (the authenticated user / the binding key creator). This is how a person's Telegram sessions get into their `listSessions({ userId })` and the UI list. The override branch carries **no** roles — permissions are computed from the profile (see below) | `{}` |

Routing rules `source/type/…` → session are set via the API (`/api/v2/events/routes`, §5.26)
and stored in `{dataDir}/events/routes.json` (`RouteRuleStore`, `ProjectRuleProvider`).
With `events.decisionRouting: true`, after a miss of the declarative rules the
decision model kicks in (`DecisionRuleProvider`, ADR-084): it picks an agent template from the
enabled agents and creates an ephemeral session; on an error/low confidence the Router goes
to the `events.defaultMode` fallback (fail-safe).

**Sender identities (claim flow, ADR-089).** Requires no config entries:
when receiving an event from an unknown sender, the core automatically issues a one-time
confirmation code (TTL 10 min, stored in `{dataDir}/events/identity-claims.json`) and
returns it in the `POST /api/v2/events` response (the `identityHint` field). The user enters the code
in the UI profile (`POST /api/v2/me/identities/claim`), after which the identity is linked to
their profile. The code is delivered to the sender by the **gateway**, and only in a private chat (in a group it is
not shown); activation on the gateway side — `GATEWAY_UNKNOWN_ACTION=hint` (the default `register`
does not show codes). Manual owner override — `events.identityMap` (takes precedence over the profile).

**External sender permissions (ADR-089, stage 5).** Requires no config entries — they are computed
when the event is received:

- **The permission base is the Synth profile roles** of the sender (`ProfileData.roles`; resolving an external
  sender → profile, see `events.identityMap` above).
- **`identity.roles` — a ceiling**: the role from the external source's allowlist (e.g.
  `GATEWAY_ALLOWLIST=chatId:ROLE` of the Telegram gateway) **narrows** the profile permissions (intersection),
  but does **not raise** them. A role is a constraint, not a grant.
- **An unidentified sender** (no profile/identity) → **no Synth permissions** (fail-closed):
  transport participation (session/chat) works, privileged operations are unavailable.
- The effective roles are computed by `resolveEffectiveRoles` (`core`, `engine/events/identity-roles.ts`)
  and `deliver` puts them into the turn `metadata` (`effective_roles`/`identity_linked`).
- **Enforcement (remaining):** the permission layer (`PermissionEvaluator`, ADR-029) has no role axis —
  global roles are checked at the HTTP level (`requirePermission`). The permissions of the gateway machine
  account (`SYNTH_API_KEY`/service-account) are no longer "handed out" to external senders: one identified
  with the role `USER` acts with user permissions, narrowing works. Full role-aware
  enforcement is a separate slice (an alternative — the ADR-052 service key with scoped tokens).

Example:

```yaml
events:
  enabled: true
  defaultMode: bound
  ephemeralTtl: "24h"
  journalRetentionDays: 30
  allowedSources: []
  dedupStore: memory
  unknownAgentTemplate: drop
  keyRateLimitPerMinute: 0
  decisionRouting: false
  autoBind: false
  autoBindAgentTemplate: ""
  identityMap:
    "chat:telegram:123456": "user-uuid-or-login"
    "tg:123456": "user-uuid-or-login"
```

Some fields (`enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`, `allowedSources`,
`unknownAgentTemplate`, `keyRateLimitPerMinute`, `decisionRouting`, `autoBind`, `autoBindAgentTemplate`,
`identityMap`)
are overridden in runtime via
`GET/PUT/DELETE /api/v2/settings/events` (live, without a restart); `dedupStore` — a deployment setting.

API (`POST /api/v2/events`, bindings, binding keys, journal) — `docs/API_V2.md` §5.26; the bus/router
design — `docs/ARCHITECTURE.md` ("External events and hooks").

### Outgoing webhooks (`webhooks.*`, ADR-052 stage II)

Event subscriptions and HTTP delivery to subscribers (`WebhookService` over `EventBus.subscribeAll`).
The section is a deployment setting; the master switch `enabled` and delivery policies.

| Field | Purpose | Default |
|------|-----------|--------------|
| `webhooks.enabled` | Delivery master switch (opt-in); `false` — the engine does not deliver, and mutations of `/api/v2/webhooks` and the test respond 503 `UNAVAILABLE` (reading is available) | `false` |
| `webhooks.maxAttempts` | Number of HTTP attempts per delivery (1..10); between attempts — exponential backoff with jitter | `5` |
| `webhooks.timeoutMs` | Timeout of a single HTTP request, ms | `10000` |
| `egress.webhooks` | Delivery target policy (ADR-099): `mode` `deny`/`allow`/`off`, `list`, `exceptions`; `off` — dev (lifts the `https` requirement as well). Replaces the removed `webhooks.allowPrivateTargets` | `deny` of private ranges |
| `webhooks.deliveryRetentionDays` | Delivery journal retention (`{dataDir}/webhooks/deliveries.jsonl`), days; `0` — no limit; prune at start and every 6 h | `30` |

Example:

```yaml
webhooks:
  enabled: false
  maxAttempts: 5
  timeoutMs: 10000
  deliveryRetentionDays: 30
# The delivery target policy lives in the egress.webhooks section (mode deny | allow | off), see above.
```

The API and the signature format (`/api/v2/webhooks`, subscriptions/secret rotation/journal/test) — `docs/API_V2.md` §5.29;
the engine design and the address policy — `docs/ARCHITECTURE.md` ("External events and hooks")
and [ADR-052](../arch_decisions/adr-052-public-api-platform.md).

### Scheduler (`scheduler.*`, ADR-051 slice / ADR-089)

The cron/interval scheduler publishes `source: 'cron'` events through
`EventIngress`; routing into sessions is done by `EventRouter`
(the `SchedulerRuleProvider` rule). Management — the API `/api/v2/schedules`
(`docs/API_V2.md` §5.27).

| Field | Purpose | Default |
|------|-----------|--------------|
| `scheduler.enabled` | Service master switch: `false` — the ticker does not start (schedule CRUD and `run` remain) | `true` |
| `scheduler.tickSec` | Tick period, seconds (1..3600) | `60` |
| `scheduler.catchUp` | Behaviour on a firing missed at start: `skip` — job `skipped` with a recomputed `nextRunAt`, `once` — one catch-up (`trigger:'catchup'`); a schedule can override it with the `catchUp` field | `skip` |
| `scheduler.jobRetentionDays` | Job history retention (`{dataDir}/scheduler/jobs.jsonl`), days; `prune` at service start | `30` |
| `scheduler.leaderElection` | Election of the ticker-owner leader: `none` — each process considers itself the leader (single-process), `file` — a file lock `{dataDir}/scheduler/leader.lock` (stale `3×tick`), `postgres` — a session-level DB advisory lock (requires `storage.backend=postgres`; otherwise a warning and `AlwaysLeader`); the ticker starts only on the leader | `none` |
| `scheduler.crossProcessLocks` | Cross-process serialization of `ScheduleStore` mutations (a file mutex `{dataDir}/scheduler/schedules.lock` over the in-process `AsyncLock`); protection from losing `nextRunAt` with several replicas. With `storage.backend=postgres` it is irrelevant: `schedules` writes are atomic SQL mutations and no file lock is created | `false` |

File-based flags (`events.dedupStore: file`, `scheduler.leaderElection: file`,
`scheduler.crossProcessLocks: true`) are designed for a **shared `dataDir` on one host/FS** and
are disabled by default (single-process behaviour is unchanged). For replicas without a shared FS,
use `storage.backend=postgres` and `scheduler.leaderElection: postgres` (a DB advisory lock,
ADR-097); a K8s `Lease` is a future step (ADR-051).

Example:

```yaml
scheduler:
  enabled: true
  tickSec: 60
  catchUp: skip
  jobRetentionDays: 30
  leaderElection: none
  crossProcessLocks: false
```

### Plugins (`plugins.*`, ADR-090)

The section sets the policy of the plugin layer (Extension API v1): trust, scan, installation and
the budgets of the extension points. A runtime override of these keys —
`GET/PUT/DELETE /api/v2/settings/plugins` ([API_V2.md](./API_V2.md) §5.36); **the changes are
applied after a restart** (invariant 24) — the plugin runtime (the host, the loader, the effective
config) is assembled at the start.

> The default values are checked against the code automatically (`packages/shared` — the `plugins.*`
> defaults test): a discrepancy with `packages/shared/src/config/defaults.ts` breaks the build.

| Field | Purpose | Default |
|------|-----------|--------------|
| `plugins.enabled` | Master switch of the plugin layer | `true` |
| `plugins.executionEnabled` | **Execution of plugin code.** `false` — activation stops at the `import` step (`plugin.execution_disabled`); installation/removal and the scan work | `false` |
| `plugins.runtimeInstall` | Installation at runtime (`allow`/`deny`); `deny` — deploy-time only | `deny` |
| `plugins.trustFloor` | The minimum trust for **installation and activation** (`builtin`/`verified`/`trusted`/`community`); below the floor the installer **refuses the installation** (`plugin.trust_below_floor`) | `trusted` |
| `plugins.scan` | The static scan of the content (`enabled`/`disabled`). `disabled` together with `executionEnabled: true` — **fail-closed** (`plugin.scan_disabled_with_execution`) | `enabled` |
| `plugins.allowlist`/`plugins.denylist` | The names of the extensions that are allowed/forbidden to run (empty — the policy is not applied) | `[]` |
| `plugins.remoteAllowlist` | The allowlist for the hybrid contour (F7) | `[]` |
| `plugins.exactHostExceptions` | The path to the file with the exact exceptions of the semver gate (`host`, one version per line) | `''` |
| `plugins.promptBlockMaxChars` | The character budget **per block** of the system prompt from a plugin (exceeding it — truncation with a marker, `status: 'truncated'`) | `4000` |
| `plugins.llmFilterTimeoutMs` | The time budget for a single call of a plugin LLM filter; after it expires — the `failMode` of the filter | `1000` |
| `plugins.deployDir` | The directory of the bundles delivered **by the image/deployment** (each subdirectory is a bundle with `synth.pack` + `dist/`). It is installed at the instance start (manifest → scan → trust-floor → install-policy), then activated from the lock. Empty — there are no deploy plugins | `/opt/synth/plugins` |
| `plugins.deployTrust` | The trust level of the deploy bundles (`builtin`/`verified`/`trusted`/`community`). Below `trustFloor` — a regular refusal `plugin.trust_below_floor`; the content scan is always performed | `trusted` |
| `plugins.managedReadonly` | A management plugin (`deployDir`, lock `source: 'deploy'`) **cannot** be removed or reinstalled through the API/CLI — `403 plugin.managed_readonly`. It changes only with a new image/redeployment. It applies regardless of the instance mode | `true` |
| `plugins.embeddingProvider` | The provider of embeddings for the facade service `facade.embed` (ADR-090, WP-F). Empty — embeddings are not configured: `facade.embed` throws `plugin.embedding_not_configured` (the plugin decides whether to degrade). The plugin may override the provider/model in the call | `''` |
| `plugins.embeddingModel` | The embedding model for `facade.embed`. Empty — the default model of the provider is used | `''` |
| `plugins.hybrid.mode` | The mode of the **server-side plugin policy in hybrid mode** (F7): `off` — the server **does not restrict** plugins; `allowlist` — only the plugins from `plugins.hybrid.allow` are allowed (an empty list — nobody is allowed) | `off` |
| `plugins.hybrid.allow` | The names of the plugins the server allows to run (relevant only when `mode: 'allowlist'`) | `[]` |

```yaml
plugins:
  executionEnabled: false   # enable after the plugins are installed and checked
  runtimeInstall: deny
  trustFloor: trusted
  promptBlockMaxChars: 4000
  llmFilterTimeoutMs: 1000
  # Managed deploy-time (F5c — the deploy-time variant of phase F5): bundles from the image/PVC.
  deployDir: /opt/synth/plugins
  deployTrust: trusted
  managedReadonly: true
  # F7: the server-side plugin policy in hybrid mode.
  hybrid:
    mode: off        # off (default) | allowlist
    allow: []        # the names of the allowed plugins (only with allowlist)
```

- **Live keys.** `promptBlockMaxChars` and `llmFilterTimeoutMs` are applied **without a restart**
  (the first — from the next turn, the second — to the subsequent filter registrations); the other
  keys of the section (`executionEnabled`, `trustFloor`, `scan`, `runtimeInstall`, allow/deny) take
  effect **after an instance restart** (invariant 24).
- **Where the plugins live**: `<home>/plugin/` (ADR-079) or `{dataDir}/plugin/` —
  `installed/<name>@<version>/`, `quarantine/` (awaiting approval), `plugins.lock.json` (the
  provenance is the source of truth for update/uninstall). The journal —
  `{dataDir}/audit/plugins.jsonl`.
- **Bundle-only**: a plugin is a self-contained ESM bundle (`dist/index.js`); npm dependencies are
  not resolved, `@itphx/*` — external (peer).
- **The order of the gates** (installation and activation): manifest → fail-closed (`scan=disabled` +
  `executionEnabled`) → trust-floor → scan → `runtimeInstall` → install-policy
  (`safe→allow`, `caution→ask` = quarantine, `dangerous→block`).
- **Deploy plugins (image/PVC, F5c).** `deployDir` is read at the start: each subdirectory is a
  bundle; a broken manifest is skipped with a warning (the start does not fail), a match of the
  version and the `content_hash` with the lock — "skipped" (it is not reinstalled). The scan and the
  install-policy are **the same** as for a manual installation (the image is a trusted source of
  code, but not a reason to skip the content check). `managedReadonly: true` forbids removing/updating
  such a plugin through the API/CLI: it changes with a new image or a redeployment of the
  directory. The env equivalents — `SYNTH_PLUGINS_DEPLOY_DIR`, `SYNTH_PLUGINS_DEPLOY_TRUST`,
  `SYNTH_PLUGINS_MANAGED_READONLY`.
- **The hybrid policy (F7).** `plugins.hybrid.mode`/`plugins.hybrid.allow` — the server-side plugin
  policy: the local core in hybrid mode is checked against it **before the activation** of a plugin
  (the `allowlist` mode and the plugin is not in the list → `403 plugin.hybrid_not_allowed`), and the
  server rejects the server-scoped token of a plugin whose `plugin_id` is outside the list
  (`403 PLUGIN_NOT_ALLOWED`). With `mode: 'off'` the **server does not restrict** plugins: the
  allowlist check is not applied, but the `X-Synth-Plugin-Id` header binding and the scope
  `plugins:invoke` always apply. The client fetches the full allowlist with an authenticated
  request `GET /api/v2/settings/plugins` (the `hybrid` block); the public signal of the mode is in
  `GET /auth/oidc-meta` (`plugins: {enabled, mode}`, without the list of names). The env equivalent
  of the mode — `SYNTH_PLUGINS_HYBRID_MODE`; the list of names stays in `config.yaml`.
- **The embedding models** (`plugins.embeddingProvider`/`plugins.embeddingModel`) — the memory
  plugin (indexes and recall) and the micro layer of the router use them. The verified Ollama
  models:

  | Model | Dimension | Latency | Size | Recommendation |
  |---|---|---|---|---|
  | `nomic-embed-text:latest` | 768 | ~0.1–2 s | 274 MB | **Default** — fast and compact |
  | `nomic-embed-text-v2-moe:latest` | 768 | ~6 s (cold) | 958 MB | Quality at the **same** dimension |
  | `qwen3-embedding:latest` | **4096** | 17–21 s | 4.7 GB | Only deliberately: the vector size grows ×~5.3, the host load grows too |

  ```yaml
  plugins:
    embeddingProvider: ollama
    embeddingModel: nomic-embed-text:latest
  ```

  The env equivalents — `SYNTH_PLUGINS_EMBEDDING_PROVIDER` / `SYNTH_PLUGINS_EMBEDDING_MODEL`
  (env is above the config, ADR-023). An empty provider — the embeddings are not configured
  (`plugin.embedding_not_configured`): the index is not built, the recall degrades to the keyword
  search.

  **Egress.** The chunk text goes to the embeddings provider **without obfuscation** (there is none
  at indexing, see [MEMORY.md](../MEMORY.md) §10.1 — RU). The local Ollama does not send the corpus
  outside; an external provider receives it entirely, and the found fragments then go to the LLM.
  Index only the directories that hold no sensitive text, and keep the secrets out of the working
  directory.

  A model change **marks the built indexes as `stale`** (the fingerprint holds the actual
  `provider/model`): they have to be rebuilt (`synth memory rebuild <indexId>`).

### User questions (`questions.*`, stage 1 of roadmap 0.12.4 — block 3)

The section sets the behaviour of the "ask the user" subsystem (the `question` tool): the
agent asks a question with answer options and the turn **waits** for the user's answer.
The answer comes by the question `id` (`POST /api/v2/sessions/:id/questions/:qid/answer`).

| Field | Purpose | Default |
|------|-----------|--------------|
| `questions.timeoutMs` | The wait for an answer, ms. `0` — **no timeout** (the default): the question waits until it is answered or cancelled (the end of the turn, "Stop", a manual cancel). The `question` tool may set a deadline for a specific question (`timeout`, ≥ 5 minutes — not recommended: it aborts the wait). When the time expires, the question is cancelled with the reason `timeout`. Env — `SYNTH_QUESTIONS_TIMEOUT_MS` | `0` (no timeout) |
| `questions.retentionDays` | The retention of the terminal question records (`answered`/`cancelled`), days; `<= 0` — no limit. Env — `SYNTH_QUESTIONS_RETENTION_DAYS` | `14` |

```yaml
questions:
  timeoutMs: 0
  retentionDays: 14
```

- **Storage** — the `QuestionRepository` domain port (ADR-096): the file backend —
  `{dataDir}/questions.json` (ADR-005, an atomic write), PostgreSQL — the `questions`
  table (the 021 migration of the driver).
- **The wait for an answer — in the process memory.** Therefore at start all the open
  questions are cancelled with the reason `interrupted` (the wait did not survive the
  restart) — otherwise the question would "hang" forever.
- **Timers** — `unref` (they do not hold the process); the retention cleanup starts
  immediately at start and then every 6 hours, the errors are logged and do not crash the
  process.
- **Events** — `user_question.asked` / `user_question.answered` /
  `user_question.cancelled` in the session channel (ADR-009/ADR-024, no new channels).

### Background runs (`background.*`, stage 1 of roadmap 0.12.4 — block 4)

The section sets the behaviour of the single registry of the background work: background
**subagents** (`task({background: true})`, PROP-096/ADR-111) and background **shell
processes** (`execute_shell({background: true})`, ADR-113) live in **one** registry —
there is no second storage. The limits are counted per the owner session (for a subagent —
the parent session) and only over the **live** runs (`running`): the finished records are
the registry history, the retention cleans them, and they do not occupy the limit.

| Field | Purpose | Default |
|------|-----------|--------------|
| `background.enabled` | The master switch of the background work. `false` — both `task({background: true})` and `execute_shell({background: true})` respond with an error (`task.background_disabled` / `process.background_disabled`; the turn does not fail), while the foreground work and the registry keep working. Env — `SYNTH_BACKGROUND_ENABLED` | `true` |
| `background.maxSubagentsPerSession` | The maximum of the background subagents running at the same time per the owner session; exceeding it → `background_limit_exceeded` (a tool error, the turn does not fail). Env — `SYNTH_BACKGROUND_MAX_SUBAGENTS_PER_SESSION` | `2` |
| `background.maxProcessesPerSession` | The maximum of the background shell processes running at the same time per the owner session; exceeding it → `background_limit_exceeded`. Env — `SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION` | `5` |
| `background.maxRunsPerSession` | The maximum of the background runs of any kind (subagents + processes) running **at the same time** per the owner session; the terminal records are not counted by the limit — they are the registry history and are cleaned by the retention. Env — `SYNTH_BACKGROUND_MAX_RUNS_PER_SESSION` | `10` |
| `background.logMaxBytes` | The limit of the size of a background process log, bytes; `0` — no limit. Do not confuse it with the ceiling of the log output per HTTP request (256 KiB) — these are different values. Env — `SYNTH_BACKGROUND_LOG_MAX_BYTES` | `10485760` (10 MiB) |
| `background.retentionDays` | The retention of the terminal registry records (`completed`/`failed`/`cancelled`/`orphaned`), days; `<= 0` — no limit. Env — `SYNTH_BACKGROUND_RETENTION_DAYS` | `7` |

```yaml
background:
  enabled: true
  maxSubagentsPerSession: 2
  maxProcessesPerSession: 5
  maxRunsPerSession: 10
  logMaxBytes: 10485760
  retentionDays: 7
```

- **Registry storage** — the `BackgroundRunRepository` domain port (ADR-096): the file
  backend — `{dataDir}/processes/registry.json` (ADR-005, an atomic write), PostgreSQL —
  the `background_runs` table (the `021_background_runs` migration of the driver). The logs
  of the background processes — a blob store (`BlobStore`), the path `processes/<id>.log`
  (the combined log) and the per-stream files `processes/<id>.stdout.log` /
  `processes/<id>.stderr.log`; the `logMaxBytes` limit is **its own for each file**.
- **A restart does not resume the background runs.** The "live" cancel handles live in the
  process memory, therefore at start all the `running` records are turned into `orphaned`
  with the note "interrupted by restart": the record stays in the registry (it honestly
  shows the incompleteness), but the run itself is gone.
- **Timers** — `unref` (they do not hold the process); the retention cleanup starts
  immediately at start and then every 6 hours, the errors are logged and do not crash the
  process. Only the **terminal** records are cleaned.
- **The nesting depth — 1**: a subagent cannot spawn a background subagent.
- **Background processes in the `remote` mode** — the background spawn is delegated to the
  executor's **protocol v3** (`POST /exec/spawn`, the handshake flag `features.background`);
  an executor that does not support the background mode (an old pool, protocol < 3) →
  `background_unsupported` (`process.background_unsupported`). For background subagents the
  restriction does not apply.
- **Events** — `process.started` / `process.stopped` / `process.exited` /
  `child.completed` / `child.failed` / `child.cancelled` in the owner session channel
  (ADR-009/ADR-024, no new channels). `process.stopped` — a stop request (once per run);
  the terminal status arrives later — with `process.exited`.

### Agents (`agents.*`)

Safeguards for agent runs. `subagentMaxInputTokens` limits the **prompt size** of a subagent
(not the model window): before every LLM call of the subagent loop the prompt is estimated
(`messages` + `systemPrompt` + tool definitions, `estimatePromptChars` → `estimateTokens`),
and when the estimate exceeds the limit the provider is **not called** — the run finishes
correctly with a deterministic report (no LLM): the token estimate, the number of completed
steps and the unfinished tasks (from the child session todo list or from the task
description). The estimate uses the **calibrated chars-per-token of the run's model**
(`token_ratios`, the same loader as the main orchestrator); without calibration/a loader
error the default `4` is used (fail-open). The report is persisted as a regular assistant message of the child session
with the `completed` status, its metadata carries `context_budget_exceeded`/
`context_budget_tokens`/`steps`, and the event `subagent.context_budget` is published to the
parent. It is a safeguard against a growing history (cost, model degradation, provider
limits), not a "keep working" hint. **The default is `0` (no limit)** (parity with opencode:
there is no separate subagent token budget — an agent has `steps`,
`experimental.subagent_depth` and auto-compaction `compaction.auto/keep/buffer`). With `0`
and no context compaction a long subagent run may hit the model window or a provider error —
for tool-heavy agents set a limit (UI “Subagent limits” / `/api/v2/settings/agents-limits`
or `config.yaml`), or keep `0` deliberately.

| Field | Purpose | Default |
|-------|---------|---------|
| `agents.subagentMaxInputTokens` | Safeguard on the subagent prompt size, input tokens (estimate); `0` — no limit (default). When exceeded, the run finishes with a report instead of a provider error. Configurable in the UI (Settings → “Subagent limits”) / `GET/PUT/DELETE /api/v2/settings/agents-limits`; priority env > runtime > config. Env — `SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS` | `0` |
| `agents.subagentDepth` | Subagent nesting depth limit; `0` — no limit. The depth is counted along the `parentId` chain of the sessions (the current one is 0, its parent is 1, …): with a limit of 1 a subagent may spawn a subagent, but not a subagent inside a subagent. When the limit is reached, the `task` tool refuses **before** the child session is created (`task.depth_limit`). Env — `SYNTH_AGENTS_SUBAGENT_DEPTH` | `1` |

- **The step limit has priority.** The final report step of `maxSteps` (the opencode mechanics)
  is not treated as a budget overrun; otherwise the step-limit report would never be produced.
- **The step-limit report (the opencode mechanics).** The agent step limit is set in the **agent
  definition** (`AgentDefinition.maxSteps`, the “Agents” admin panel), not in `agents.*`. When the limit
  is exhausted one more ordinary step runs: the tools stay in the request, the call is forbidden with
  `tool_choice: 'none'`, and the “text only” instruction is inserted as an assistant prefill. With no
  textual report the **main** agent gets the `session.steps_limit` text (`{limit}`: “the step limit is
  exhausted…”), the answer status is `limit`, and `step_limit_reached: true` is set on the final message
  and in `stream.done`; the **subagent** gets `task.steps_limit_empty`/`task.steps_limit` (`[steps_limit]`).
  Earlier this branch of the main loop substituted the unrelated `session.max_iterations` (it now remains
  only for pipeline steps).
- **The estimate is unavailable** (no data/empty prompt) — do not block (fail-open).
- The estimate uses the **calibrated** chars-per-token of the run's model (`token_ratios`; the
  same loader as the main orchestrator); the heuristic `4` applies only when calibration is
  missing/loading fails (fail-open). It is a safeguard, not an exact token count of the model.
- **The depth limit (`subagentDepth`) is structure, not budget.** It is counted along the
  `parentId` chain of the sessions, not by token spend: when the limit is reached the `task`
  tool refuses with `task.depth_limit` **before** the child session is created (no extra
  session and no extra history). `0` — the nesting is not limited.

```yaml
agents:
  subagentMaxInputTokens: 0   # 0 — no limit (default)
  subagentDepth: 1
```

### Request limits (`limits.*`)

The limit of **heavy session operations** — requests that carry a whole history and are
therefore expensive in data and CPU: `POST /api/v2/sessions/import`,
`POST /api/v2/sessions/import-batch`, `GET /api/v2/sessions/:id/export`,
`POST /api/v2/sessions/:id/fork`, `POST /api/v2/sessions/:id/merge`. It protects the
instance from an accidental or deliberate flood of transfers (a publish script, a fork
loop, repeated imports); it is not an interactive chat limit: ordinary session work
(`prompt`, reading the history, edits) is not limited by it.

The count is **per credential** — the limiter key is `Authorization` (for requests
without the header — `x-forwarded-for`), with a 60-second window. The value is shared by
all the operations, but **the counters are separate per family**: import (including the
batch `import-batch`) — one counter, export — its own, fork — its own, `merge` — its own;
an exhausted export limit does not block a fork. `0` disables the limit (no counter is
kept).

| Field | Purpose | Default |
|-------|---------|---------|
| `limits.sessionOpsPerMinute` | Limit of heavy session operations (`import`/`import-batch`/`export`/`fork`/`merge`), requests per minute per credential; `0` — no limit. Configurable in the UI (Settings → “Security” → “Request limits”) / `GET/PUT/DELETE /api/v2/settings/limits`; priority env > runtime > config. Env — `SYNTH_LIMITS_SESSION_OPS_PER_MINUTE` | `10` |

```yaml
limits:
  sessionOpsPerMinute: 10   # 0 — no limit
```

- **Applied without a restart.** The limiters resolve the value on every request, so
  `PUT /api/v2/settings/limits` (or `DELETE` — reset to env/config/default) takes effect
  on the very next request, `restartRequired: false`. The source of the effective value
  (`env`/`runtime`/`config`/`default`) and the env lock (`envLocked`) are returned in the
  same response.
- **Priority:** env `SYNTH_LIMITS_SESSION_OPS_PER_MINUTE` > runtime (`settings.json`/PG,
  UI/API) > `config.yaml` `limits.sessionOpsPerMinute` > `10`. With an env value the
  runtime is locked: `PUT` of another value → `409 CONFLICT`, the UI field is read-only.
  An invalid env value (not an integer ≥ 0) — a log warning and ignored (fail-soft), the
  next source by priority applies.
- **`0` — no limit.** `0` (in env/runtime/config) disables the restriction completely;
  negative and fractional values are not accepted: the config schema is an integer ≥ 0,
  `PUT` answers `400 VALIDATION_ERROR`.
- **A batch import is one hit.** `POST /api/v2/sessions/import-batch` (up to 200 sessions
  per request) consumes one unit of the limit, not one per session. A project publish is
  split into such requests of **20 sessions** (`IMPORT_BATCH_CHUNK`), so the hit count =
  the number of requests (≈ 1 hit per 20 sessions), not 1 per project. Transfer requests use
  an increased timeout (**120 s**) — the limit does not affect them.
- **Counters are in-memory, per-process.** In a multi-replica instance the limit applies
  **per replica**, not to the whole instance: the total throughput grows with the number
  of replicas, and a process restart resets the windows. A hard shared limit requires an
  external rate limiter (proxy/gateway) — the application does not have one.
- **Exceeding → `429` with `Retry-After`.** The response is
  `{error:{code:'RATE_LIMITED', message}}` plus the `Retry-After` header — whole seconds
  until the end of the current window (minimum 1). For a client (a publish script) it is
  enough to wait the indicated time and retry.
- **Where it is applied.** The limiter is wired in the managed backend
  (`packages/backend/src/routes/sessions.ts`) — the same place as the backend-only
  `import`/`import-batch`/`export`. In standalone-core the setting is read and stored, but
  there are no counters: the import/export routes do not exist in the core build, and
  `fork`/`merge` are not limited there (the limiter is passed in as backend middleware).

### Session auto-title (`session.autoTitle`)

The name of a new session is generated automatically — **right after the first user message**
(the start of the turn, before the assistant answer), not after the answer. The title LLM
call is **fire-and-forget**: the turn does not wait for it, and its spend is recorded as an
aux call (`agent: 'title'`).

Auto-naming fires while the session title is still the default one (`New session`) — a
**user-set title is never overwritten**; after `maxAttempts` dialogue replies auto-naming
stops trying (the title can be updated manually). Child sessions (subagents) are not
auto-named.

The attempt rule (N — the number of dialogue replies of the user; service replies — steer
injections, background-run notifications, scheduler messages — are not counted):

| N | Condition | What happens |
|---|-----------|--------------|
| 1 | the reply is “chatter” (a greeting/small talk: “hello”, “how are you”, “ok”, etc.; no attachments and shorter than `minSignalChars`) | generation is **deferred** — the LLM is not called at all, the title stays `New session` |
| 1 | there is a task signal | the title is built from the first message |
| 2..`maxAttempts` | the title is still the default one | the title is built from the conversation: `Original request` + `Recent conversation` (a budget of 8000 characters, trimmed from the tail) |
| > `maxAttempts` | — | auto-naming stops trying; manual regeneration is available |

The attempt counter is **not persisted** — it is derived from the session history, so the
rule behaves identically before and after a restart (idempotent).

The fallback on an LLM error/empty/too-long answer is a title from the **first reply with
a task signal** (its first non-empty line, ≤ 60 characters, markdown stripped). For a
greeting/small talk there is no fallback — the title does not change.

**Manual regeneration.** `PATCH /api/v2/sessions/:id` with the body `{"title": ""}` — the
server generates the title from the conversation synchronously and returns the session DTO
(as an ordinary PATCH); a user-set title is overwritten too. If the name cannot be built,
the title does not change and the response is `200` with the previous name. A non-empty
`title` is an ordinary rename. In the UI it is the session context-menu item “Regenerate
title”. In the hybrid mode the PATCH body is proxied to the remote server (it performs the
regeneration).

| Field | Purpose | Default |
|-------|---------|---------|
| `session.autoTitle.enabled` | Master switch of auto-naming (`false` — sessions stay “New session” until renamed manually) | `true` |
| `session.autoTitle.deferOnChatter` | Defer the name when the first reply is a greeting/small talk (do not call the LLM in vain) | `true` |
| `session.autoTitle.maxAttempts` | Maximum attempts by the number of dialogue replies (1..5) | `2` |
| `session.autoTitle.minSignalChars` | Text length from which a reply counts as meaningful (a “task signal”); shorter — only a greeting/small talk | `30` |

Priority env > `config.yaml` > defaults (ADR-023): `SYNTH_SESSION_AUTO_TITLE_ENABLED`,
`SYNTH_SESSION_AUTO_TITLE_DEFER_ON_CHATTER`, `SYNTH_SESSION_AUTO_TITLE_MAX_ATTEMPTS`,
`SYNTH_SESSION_AUTO_TITLE_MIN_SIGNAL_CHARS`.

```yaml
session:
  autoTitle:
    enabled: true
    deferOnChatter: true
    maxAttempts: 2
    minSignalChars: 30
```

### Model context window (`context.*`)

`context.windowPolicy` controls what happens when the prompt estimate does not fit the model context
window:

- `off` — no checks at all: neither warnings nor blocking (the UI hides the banners);
- `warn` (default) — the server does **not** block; the UI draws the fill warnings;
- `enforce` — the LLM call is **not sent** when the prompt estimate exceeds `window − reserve`, and the
  turn finishes with the `router.context_length_exceeded` error (`error_type: 'context_length'`, status
  `error`, metadata `context_window_exceeded`/`context_window_tokens`).

The window comes from the model catalog (`ModelConfig.contextWindow`; when unset — from the built-in
table of known models). The output reserve is the effective `max_tokens` limit
(`resolveMaxOutputTokens`: session value → `ModelConfig.maxOutputTokens` → `llm.maxTokens` → 8192).
The prompt estimate is `estimatePromptChars` + the calibrated chars-per-token. **An unknown window
(`0`) never blocks**: an estimate without a window is meaningless, and silently blocking every turn
would be a regression — this is a safeguard, not budgeting.

The policy is resolved **live**, before every LLM call, so a change applies without a restart.
Priority: env `SYNTH_CONTEXT_WINDOW_POLICY` > runtime (`GET/PUT/DELETE
/api/v2/settings/context-window`, `settings.json`/PG) > `config.yaml` > the `warn` default; when the
policy comes from env, an attempt to set a different value gets 409 `CONFLICT`.

```yaml
context:
  windowPolicy: warn
```

#### Context optimization defaults for new sessions (`context.defaults`)

`context.defaults` holds instance-wide context-optimization values that a **new** session receives
when it has no explicit settings. Existing sessions are never changed; explicit request `settings`
always win. The values are resolved when a session is created, so a runtime change takes effect
**immediately**, without a restart.

| Field | Default | Meaning |
|---|---|---|
| `contextOptimization` | `compaction` | `none` \| `sliding_window` \| `summarization` \| `compaction` — the compression mode; the modes are **mutually exclusive** |
| `summarizationEnabled` | `true` | legacy flag: only enables the legacy fallback `none` + `true` = summarization |
| `summarizationTriggerMode` | `messages` | `messages` (N replies) \| `tokens` (% of the window) |
| `summarizeAfterN` | `10` | user replies since the last summary before summarization starts (≥1) |
| `summarizeTokenThreshold` | `50` | summarization threshold, % of the model window (1..100) |
| `summarizationKeepTokens` | `5000` | verbatim tail for summarization, tokens (`0` — no tail) |
| `compactionTokenThreshold` | `85` | compaction threshold, % of the model window (1..100) |
| `compactionKeepTokens` | `15000` | verbatim tail for compaction, tokens |
| `summarizationHeadMessages` | `2` | **deprecated**: kept in the schema, not used by the engine |
| `summarizationTailMessages` | `3` | **deprecated**: kept in the schema, not used by the engine |
| `slidingWindowMode` | `messages` | `messages` \| `tokens` |
| `slidingWindowMessageLimit` | `10` | messages in the sliding window (≥1) |
| `slidingWindowTokenThreshold` | `80` | sliding-window threshold, % of the model window (1..100) |

**Modes.** `none` — the history is sent as is; on overflow `context.windowPolicy` applies;
`sliding_window` — older messages are disabled by a message/token limit (no summary);
`summarization` — conversation outcomes (what was discussed, what was decided, open questions,
next steps); `compaction` — working state for the code/project (exact paths, commands, errors,
decisions, next move). Switching modes is a single `contextOptimization` field; separate flags do
not enable it (the only exception is the legacy fallback below).
Specification — [ADR-119](../arch_decisions/adr-119-context-compaction.md).

**Triggers.** Summarization fires by the number of user replies since the last summary
(`messages`, `summarizeAfterN`) or by window fill (`tokens`, `summarizeTokenThreshold`).
Compaction is token-only: threshold = `window − max((100 − pct)% of the window, 16000)`, i.e. the
reserve is at least 16k tokens; with a too-small window (reserve ≥ window) the auto trigger is
disabled — compression stays available manually and on overflow. **An unknown model window (`0`)
is treated as 200 000** (`DEFAULT_CONTEXT_WINDOW`): the auto triggers (compaction, summarization by
`tokens`, sliding window by `tokens`) work from that estimate — the same value the UI context
indicator shows; an explicitly configured model window always takes precedence.
The trigger does not compress immediately: it sets a pending state (`summarization_pending`), and
the queue processor performs the compression as a separate service turn before the next message.

**Tail.** `summarizationKeepTokens`/`compactionKeepTokens` define how many recent tokens stay
verbatim; the covered part is compressed into a summary. For summarization `0` means "no tail".
The summary goes into the `summary` system block; covered messages get `disabled`, pinned messages
are never disabled.

Session notes (`context.stickyNotes`) are not an optimization strategy: they work independently of
the selected strategy (they are always added to the system prompt). `sticky_notes` is only a legacy
value of saved sessions and is no longer offered in defaults/UI. Legacy sessions with
`contextOptimization: none` and `summarizationEnabled: true` keep behaving as summarization;
`summarizationHeadMessages`/`summarizationTailMessages` are kept only for schema and saved-settings
compatibility.

Priority: runtime (`GET/PUT/DELETE /api/v2/settings/context-defaults`, `settings.json`/PG; PUT is a
partial patch merged over config) > `config.yaml` `context.defaults` > schema defaults. There are no
env overrides for these values. In managed mode the admin section is restricted to `ADMIN`.

```yaml
context:
  windowPolicy: warn
  defaults:
    contextOptimization: compaction
    summarizationEnabled: true
    summarizationTriggerMode: messages
    summarizeAfterN: 12
    summarizeTokenThreshold: 60
    summarizationKeepTokens: 5000
    compactionTokenThreshold: 85
    compactionKeepTokens: 15000
    # deprecated, not used by the engine:
    summarizationHeadMessages: 2
    summarizationTailMessages: 4
    slidingWindowMode: messages
    slidingWindowMessageLimit: 10
    slidingWindowTokenThreshold: 80
```

#### Session note limits (`context.stickyNotes`)

`context.stickyNotes` sets **instance constraints** for session notes
(`/api/v2/sessions/:id/notes`) — not session defaults: they apply to **all** sessions when a note is
created or updated.

| Field | Default | Meaning |
|---|---|---|
| `maxCount` | `50` | maximum notes per session (1..1000); when reached, creation → 409 `LIMIT_EXCEEDED` |
| `maxChars` | `2000` | maximum characters per note (1..100000); longer → 400 `VALIDATION_ERROR` |

The limits are a safeguard against notes becoming an unbounded context channel: notes are injected
into the system prompt. **Existing notes are never deleted or truncated** when a limit is lowered — it
applies only to new writes (and to editing the text). The resolver is read on every note operation, so a
runtime change takes effect **immediately**, without a restart.

Priority: runtime (`GET/PUT/DELETE /api/v2/settings/sticky-notes`, `settings.json`/PG; PUT is a partial
patch merged over config) > `config.yaml` `context.stickyNotes` > schema defaults. There are no env
overrides for these values. In managed mode the admin section is restricted to `ADMIN`.

```yaml
context:
  stickyNotes:
    maxCount: 50
    maxChars: 2000
```

### Model catalog (`{dataDir}/models/`, `ModelConfig`)

The instance models are catalog records (the file `{dataDir}/models/<id>.json`, or the DB when
`storage.backend=postgres`) typed as `ModelConfig` from `@itphx/synth-shared`. They are edited through
the API: `POST /api/v2/models` (create/update; unknown fields are ignored) and `POST /api/v2/models/fetch`
(sync with the provider catalog). Catalog fields (prices, `contextWindow`, `modalities`,
`compatibility`) are **model properties** — there are no separate `config.yaml` keys for them.

Protocol and compatibility behaviour in detail (heuristics, resolution order, OpenAI-chat / Anthropic /
Ollama specifics, step limit) — [PROVIDERS.md](./PROVIDERS.md).

**Provider/model compatibility (`compatibility`, ADR-117, parity with opencode).** Protocol differences
of compatible gateways and proxies (field names, output limit, `tool_choice`) are described by data
rather than hardcoded per provider type. The same object exists on two levels:
`ProviderConfig.compatibility` (defaults for all models of the provider) and `ModelConfig.compatibility`
(overrides provider fields pointwise).

| Field | Purpose | Default |
|---|---|---|
| `reasoningField` | Name of the reasoning field in openai-chat assistant messages. An explicit value itself turns on `requireReasoning` unless that is overridden | `reasoning_content` |
| `requireReasoning` | The reasoning field is mandatory on **every** assistant message — an empty string when there is no reasoning (DeepSeek thinking models) | Auto (heuristic) |
| `maxTokensField` | Output limit field: `max_tokens` \| `max_completion_tokens` | `max_tokens` (`max_completion_tokens` — explicit only) |
| `requireAssistantAfterTool` | An assistant turn is required after `tool` results (Mistral family) | `false` (heuristic) |
| `streamUsage` | Send `stream_options: {include_usage: true}` in the stream | `true` |
| `supportsToolChoice` | The provider understands `tool_choice` | `true` (native Ollama — `false`) |
| `cacheFormat` | Prompt-cache inline marker format (`cache_control: {type:'ephemeral'}`): `anthropic` — last tool + system + last message boundary; `alibaba` — system + last message boundary (no tools). Budget — ≤4 breakpoints; when set, `prompt_cache_key` is **not** sent | Unset (`prompt_cache_key` only) |
| `requireFinishReason` | Require `finish_reason` in the stream: a provider that closes the stream without it returned an incomplete answer (incomplete-stream, not retried) | `true` |
| `supportsEffortUpdates` | Anthropic 5.x effort mode: send `output_config.effort` (tier from the agent/session `effort` or from `reasoningLevel`: `low\|medium\|high`) and **not** send `thinking` — thinking blocks in history are not replayed, `temperature` is not forced. Without the flag — the previous mode, an explicit effort is ignored | `false` (explicit `true` only) |
| `supportsNativeVideo` | The transport accepts a **video file** natively (the `video_url` block), without splitting it into frames via an aux model | `false` (heuristic: a RouterAI-compatible host) |
| `nativeAudioFormats` | Audio containers of the native path (the `input_audio`/`audio` blocks): `wav` \| `mp3` \| `ogg`. An explicit **empty list** — "no format at all" (aux model only) — and it overrides the heuristic | Heuristic by type/host: `wav`, `mp3` (`+ogg` on a RouterAI-compatible host; `wav` for `anthropic`; an empty list for the other types) |

- **Priority:** the explicit **model** value → the explicit **provider** value → the **heuristic** →
  the built-in default (`resolveModelCompatibility`). Heuristics (`detectCompatibilityHeuristics`) apply
  only to unset fields: `requireReasoning` — provider type/name `deepseek`, a URL containing
  `deepseek.com`, a model id containing `deepseek`, provider name `minimax` or a `minimax` URL;
  `requireAssistantAfterTool` — `mistral`/`devstral`/
  `codestral`/`pixtral`/`mixtral`; `supportsToolChoice: false` — `type: 'ollama'`; native media —
  `nativeAudioFormats`/`supportsNativeVideo` by the matrix “protocol type × RouterAI-compatible host”
  (`isRouterAiUrl` in shared — the only carrier of host knowledge and **a default heuristic only**:
  the non-RouterAI proxy `itphx` does take native video — live test 2026-11-03, ADR-117).
  `maxTokensField`,
  `streamUsage`, `cacheFormat`, `requireFinishReason` and `supportsEffortUpdates` are not heuristically
  detected: local OpenAI-compatible servers often do not know `max_completion_tokens`, and cache inline
  markers, the `finish_reason` requirement and effort mode are enabled explicitly only (existing catalog
  entries keep their behavior). For `supportsEffortUpdates` the absence of auto-heuristics is
  deliberate: the flag changes the request body (`output_config` instead of `thinking`), so guessing by
  model name would send an unknown field to gateways without support.
- **Where it is set:** `POST`/`PATCH /api/v2/providers` — the `compatibility` field (provider defaults);
  `POST /api/v2/models` — `compatibility` (override for a specific model). `GET` returns the field
  **only when set**.
- **API semantics — replacement:** the `compatibility` object is a **full replacement** (the UI sends
  the whole draft, so a field missing from the object means “auto”, not “keep the previous value”),
  `null`/`{}` — reset, the field absent — unchanged. An unknown field or a wrong type →
  `400 VALIDATION_ERROR` (a typo is never silently lost).
- **Shorthand.** `ModelConfig.requiresReasoning` (the `requires_reasoning` field, also `requiresReasoning`
  in `POST /api/v2/models`) is a shorthand for `compatibility.requireReasoning`: `true`/`false` — an
  explicit value, `null` — reset (clears both the shorthand and `compatibility.requireReasoning`).
  Normalization — `compatibility.requireReasoning ?? requiresReasoning`. The field is kept for catalog
  records created before `compatibility` existed.
- **Who uses it:** the OpenAI-compatible path (`providers/openai.ts`) — the reasoning field name, an
  empty string under `requireReasoning`, the output limit field, the assistant bridge after `tool`,
  `stream_options`, the `video_url`/`input_audio` blocks (per `supportsNativeVideo`/
  `nativeAudioFormats`); Ollama — `think` and skipping `tool_choice`; Anthropic — the `audio` block (per
  `nativeAudioFormats`) and see below. The value is part
  of the provider cache key (`ProviderPool`), so changing `compatibility` recreates the provider instance.

```json
// PATCH /api/v2/providers/deepseek-gw — provider defaults
{ "compatibility": { "reasoningField": "reasoning", "requireReasoning": true } }

// POST /api/v2/models — override for a single model (the object is fully replaced)
{ "id": "qwen3.7-flash", "provider": "routerai",
  "compatibility": { "maxTokensField": "max_completion_tokens", "streamUsage": false } }

// reset to auto/defaults
{ "compatibility": null }
```

**Anthropic: thinking blocks and budget.** With `reasoningLevel: high` the thinking budget is derived
from the **actual** request `max_tokens` (`resolveThinkingBudget`): no more than half the limit and
strictly less than it, at least 1024 tokens; if there is no room (`max_tokens` ≤ the minimum) thinking is
not enabled and the request goes as a regular one (instead of `400` “max_tokens must be greater than
thinking.budget_tokens”). With thinking enabled `temperature` is forced to `1`, and
`tool_choice: required` is coerced to `auto` (Anthropic forbids a forced call). The thinking block
signature (`signature`) and the opaque `redacted_thinking` data are stored **on each reasoning block
separately** (`Part.metadata`; `reasoningBlocks` in the LLM contract) and replayed into the history
block by block in the order `redacted_thinking → thinking → text → tool_use`; an empty signature
(`signature: ""`) is valid. Blocks are passed to the history only for the “own” agent (switching the
model for the same agent does not drop the old signatures — the filter is by agent role, not by the
provider/model pair). When `parts` are present the string `content` of the message is built **without**
the reasoning blocks (legacy messages without `parts` keep the previous behaviour). With thinking
disabled the blocks are not replayed. These service fields are never exposed through the API.

**Anthropic: effort mode (`compatibility.supportsEffortUpdates`).** With an explicit `true` the provider
sends `output_config.effort` and does **not** send `thinking` at all (neither `enabled` nor `disabled`),
so the budget is not computed, `temperature` is not forced, and thinking blocks from history are not
replayed. The tier is resolved by priority: `ChatOptions.effort` → the agent `effort` (the «Agents» admin
section) → the session `effort` → `effortForReasoningLevel(reasoningLevel)`; like `reasoningLevel`, the
`effort` fields live in agent/session settings (`low|medium|high|xhigh|max`, `null` resets to "auto"),
and `xhigh`/`max` are not derived from `reasoningLevel` — only an explicit `effort` sets them. Without
the flag the behaviour is unchanged — see [PROVIDERS.md](./PROVIDERS.md) §6.1.

**Ollama (`/api/chat`).** `think` is enabled for `low|medium|high` (`none` — `false`, `default` — the
field is not sent); `tool_choice` is not sent (`compatibility.supportsToolChoice: false` by default for
`type: 'ollama'`) — the native server does not know this field.

### Git operations (`git.*`, ADR-076)

The limits of the network git operations (`git clone`/`git fetch` of the project repositories —
the `/api/v2/git/*` HTTP routes and the `project_repo_clone`/`project_repo_fetch` tools). A
timeout alone does not make the operation atomic — `GitService` does: the clone goes into a
**sibling** temporary directory `<path>.tmp-<uuid>` and appears at the target path only after
the success (`rename`), so after a timeout/error neither the target directory nor the temporary
one is left on disk.

| Field | Purpose | Default |
|------|-----------|--------------|
| `git.cloneTimeoutMs` | The limit of `git clone`, ms; `0` — no timeout. Exceeding it → `git.clone_timeout` (HTTP **504**). Env — `SYNTH_GIT_CLONE_TIMEOUT_MS` | `300000` (5 minutes) |
| `git.fetchTimeoutMs` | The limit of `git fetch`, ms; `0` — no timeout. Exceeding it → `git.fetch_timeout` (HTTP **504**). Env — `SYNTH_GIT_FETCH_TIMEOUT_MS` | `300000` (5 minutes) |
| `git.localTimeoutMs` | The limit of the agent's **local mutating** git tools (`git_commit`/`git_checkout`/`git_stash`), ms; `0` — no timeout. Env — `SYNTH_GIT_LOCAL_TIMEOUT_MS` | `120000` (2 minutes) |
| `git.networkTimeoutMs` | The limit of the agent's **network** git tools (`git_push`/`git_pull`), ms; `0` — no timeout. Env — `SYNTH_GIT_NETWORK_TIMEOUT_MS` | `300000` (5 minutes) |

- Other failures (no remote, no permissions, a dropped connection) are **not** replaced by a
  timeout — the original git error is returned.
- An occupied target path is classified by the file system state (`repo` — a full repository,
  `stub` — a `.git` without commits left by an interrupted clone, `dir` — a non-empty directory
  without git): over HTTP — 409 `git.repo_exists` + `details.occupied` (`details.entries` for
  `dir`), in a tool — an actionable message (register / delete / choose another path).

```yaml
git:
  cloneTimeoutMs: 300000   # SYNTH_GIT_CLONE_TIMEOUT_MS
  fetchTimeoutMs: 300000   # SYNTH_GIT_FETCH_TIMEOUT_MS
  localTimeoutMs: 120000   # SYNTH_GIT_LOCAL_TIMEOUT_MS — commit/checkout/stash
  networkTimeoutMs: 300000 # SYNTH_GIT_NETWORK_TIMEOUT_MS — push/pull
```

### SSH access mode (`ssh.*`, PROP-124)

The instance chooses **how** the SSH keys of the registry reach the consumer. The choice is
made by the instance administrator; both modes rely on the same key registry and the same
secret-revealing seam (`engine/ssh/access.ts`).

| | `tools` | `agent` |
|---|---|---|
| How the key reaches the consumer | argv of the addressable tools (`-i` for the duration of the call) | an ephemeral `ssh-agent` for the duration of the call (`SSH_AUTH_SOCK`) |
| Host/port policy on the key | **mandatory**, checked before the launch | **not applied** (the limit lives on the host side, `authorized_keys`) |
| `execute_shell` | does not see the key | the key is visible to all child processes of the call |
| Ansible and existing projects | do not work (no ssh access from the shell) | work as is |

| Field | Purpose | Default |
|-------|---------|---------|
| `ssh.mode` | Instance-wide mode for SSH keys: `tools` \| `agent`. Env — `SYNTH_SSH_MODE` | `tools` |

```yaml
ssh:
  mode: tools   # SYNTH_SSH_MODE — tools | agent
```

- The default `tools` is **fail-closed**: without an explicit choice the key does not reach
  the command environment.
- **Value priority — `env > runtime (UI) > config.yaml > default`.** The runtime value lives
  in `{dataDir}/settings.json` (or PG) and is changed from the UI without a restart:
  `GET/PUT/DELETE /api/v2/settings/ssh` (see [API_V2.md](./API_V2.md) §5.15.2).
- **An invalid env value is a configuration error at startup** (fail-closed, like
  `SYNTH_EXECUTION_MODE`/`SYNTH_STORAGE_BACKEND`): an instance with `SYNTH_SSH_MODE=aggent`
  does not come up. There is no second place that reads the variable — one resolver only.
- **Env locking blocks the UI:** when `SYNTH_SSH_MODE` is set, the runtime value from the UI
  does not override it — an attempt to change the mode gives `409 CONFLICT`.
- **The key policy** (`usages`, `allowHosts`, `allowPorts`) is stored **on the key**, not in
  the instance config, and is edited through the key registry API (see [API_V2.md](./API_V2.md)
  §5.15.1). In the `agent` mode the host/port fields are **not applied** and are not shown in
  the key form — they are replaced by an explanation about `authorized_keys`.
- **Limitations of the `agent` mode (stated plainly).** There is no address filtering: while
  the call is alive, the process may connect to any host the key trusts (the real boundary is
  `authorized_keys`: `from=`, `restrict`, `permitopen=`, `command=`). Agent forwarding
  (`ssh -A`) is possible. The key material is deleted from disk after `ssh-add` and remains
  only in the agent's memory.

### Timeouts of the built-in tools

The time limits of the agent's tools. **The input unit is seconds**: the `timeout`
parameter of any tool is an integer number of seconds. The operation class sets the default,
a per-call `timeout` overrides it.

The ceiling is set by the **execution mode**, not by the tool: **foreground ≤ 600 s**
(10 minutes), **background ≤ 86 400 s** (one day). `0` ("no limit") is no longer accepted.

| Tool | Operation class | Default limit |
|------|-----------------|---------------|
| `git_status`, `git_diff`, `git_log`, `git_show`, `git_blame`, `git_branch_list` | Reading the repository | 30 s (fixed) |
| `git_commit`, `git_checkout`, `git_stash` | Local changes | `git.localTimeoutMs` (120 s) |
| `git_push`, `git_pull` | Network operations | `git.networkTimeoutMs` (300 s) |
| `execute_shell` | Blocking shell command | 120 s; in the background — 86 400 s |
| `terminal_run` | Run in a terminal | 30 s (foreground); in the background — 86 400 s |
| `ssh_exec` | Command on a remote host | 120 s (foreground); in the background — 86 400 s |
| `ssh_copy` | Copying over sftp | 120 s |
| `ssh_tunnel` | Port forwarding (always background) | 86 400 s |
| `sandbox_exec` | Command in the sandbox | 120 s |
| `browser_navigate`, `browser_wait`, `browser_screenshot` | Browser tool call | the instance timeout `execution.remote.browserTimeoutMs` (120 s) |
| `web_fetch` | URL fetch | 30 s (ceiling — 600 s) |
| `question` | Waiting for a human | no timeout (`timeout` — 300…86 400 s) |
| `grep_files`, `glob` | Searching the files | 30 s (fixed) |

- The per-call `timeout` is available in **all** git tools: an integer `1…600` **seconds**.
  `execute_shell`/`terminal_run`/`ssh_exec` have the same range in foreground and
  `1…86 400` in the background (`background: true`).
- `execute_shell`/`terminal_run`/`ssh_exec` in the background always have a timeout: the
  default is one day; a background process has no "no limit" mode anymore.
- The limits of `execute_shell` and of the search tools are **properties of the tool**, not
  configuration keys: change them per call with the `timeout` parameter.
- Exceeding a limit is **not** a "Command failed": the model gets the limit value and a hint
  (raise `timeout`, raise the limit in the config, or move the work to the background).
- **Internally everything is in milliseconds:** the execution ports (`ExecRequest.timeoutMs`),
  the executor protocol and the **configuration defaults** (`git.*TimeoutMs`,
  `execution.remote.browserTimeoutMs`, `questions.timeoutMs`) are in ms. The conversion
  happens **at the boundary** (`timeoutMs = timeout * 1000`); tool messages and metadata
  show the value **in seconds** (`metadata.timeout`).
- Units and ceilings — PROP-141 (Part A).

### Message attachments (`attachments.*`, ADR-115)

Limits and policy for message attachments (multimodal input — [ADR-115](../arch_decisions/adr-115-multimodal-input.md),
API contract — [API_V2.md](./API_V2.md) §5.6.1). Bytes live on the volume in `{dataDir}/blobs`
(content-addressed); the database only keeps `blob_refs`.

| Field | Purpose | Default |
|------|-----------|--------------|
| `attachments.maxBytesPerFile` | Limit of a single file, bytes; exceeding it → `413 PAYLOAD_TOO_LARGE`. Env — `SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE` | `104857600` (100 MiB) |
| `attachments.maxFilesPerMessage` | Number of attachments in one message; exceeding it → `400 VALIDATION_ERROR`. Env — `SYNTH_ATTACHMENTS_MAX_FILES_PER_MESSAGE` | `10` |
| `attachments.maxBytesPerSession` | Total volume of the session's attachments; exceeding it on prompt → `413 PAYLOAD_TOO_LARGE`. Env — `SYNTH_ATTACHMENTS_MAX_BYTES_PER_SESSION` | `1073741824` (1 GiB) |
| `attachments.compression` | **Compression only at send time** (upstream provider); the blob keeps the original bytes and API downloads/`save_attachment` return the original. Master switch `enabled` + per-family settings: `image` (`maxSidePx` 64..8192, `quality` 1..100, `minBytes` — threshold below which the file is not compressed unless the frame dimensions exceed the cap), `video` (`maxHeightPx` 144..4320, `bitrateKbps` 100..50000, `audioBitrateKbps` 16..512, `minBytes`), `audio` (`bitrateKbps` 8..512, `channels` 1..2, `sampleRateHz` 8000..48000, `minBytes`). PDF is not compressed. No env — `config.yaml`/runtime | `enabled: true`; image `2048`/`85`/1 MiB; video `720`/`2000`/`96`/8 MiB; audio `64`/`1`/`16000`/4 MiB |
| `attachments.thumbnail` | Server-side **thumbnails** for the UI: a derived small JPEG next to the original in the blob (`attachments/.thumbs/`); original bytes are untouched. `enabled` — generation, `maxWidthPx` 64..1024 — width cap (height proportional). No env — `config.yaml`/runtime | `{ enabled: true, maxWidthPx: 512 }` |
| `attachments.maxChunkBytes` | Size of one **chunked upload** part, bytes (minimum `1024`): parts are appended as a stream, so the whole file is never buffered in memory. Env — `SYNTH_ATTACHMENTS_MAX_CHUNK_BYTES` | `8388608` (8 MiB) |
| `attachments.maxActiveUploadsPerSession` | Maximum number of **concurrent chunked uploads of one session** (unfinished upload sessions under `attachments/.uploads/`): prevents unfinished uploads from filling the disk. Exceeding it on `init` → `413 PAYLOAD_TOO_LARGE` (`error.details.maxActiveUploadsPerSession`). Env — `SYNTH_ATTACHMENTS_MAX_ACTIVE_UPLOADS_PER_SESSION` | `16` |
| `attachments.maxActiveUploads` | Global maximum of **active chunked uploads of the instance** — every upload session on the `blobs` volume counts, including the staging contour without a session binding. Exceeding it on `init` → `413 PAYLOAD_TOO_LARGE` (`error.details.maxActiveUploads`). Env — `SYNTH_ATTACHMENTS_MAX_ACTIVE_UPLOADS` | `256` |

`attachments.maxBytesPerSession` **also applies to active chunked uploads**: the total of the session's
temporary objects under `attachments/.uploads/` plus the current file must stay within the limit (on
`init` the declared `size` counts, on `append`/`complete` the actual size). Expired sessions (1 h TTL)
**never count**: the cleanup is throttled (a full pass at most once per minute), but the active-upload
scan skips expired sessions, so they consume neither the quota nor the count limits.

**The staging contour (no session binding) is limited by `maxActiveUploads` and `maxBytesPerFile`;
there is no byte quota for staging.** The upper bound of unfinished staging uploads is
`maxActiveUploads × maxBytesPerFile` (256 × 100 MiB ≈ 25 GiB at the defaults): every upload is capped by
`maxBytesPerFile` and their number by the instance-wide limit. No separate staging quota is introduced —
lower `maxActiveUploads` or `maxBytesPerFile` if needed.

- **Compression happens on send, the original is preserved.** The compressed copy is cached under
  `attachments/.derived/compress` and used only for the LLM call (and the aux call): the blob, API
  downloads and `save_attachment` keep the original. If re-encoding fails or the result is not
  smaller, the original is sent. PDF is not compressed, video is compressed only on the native
  delivery path, audio only into a container the transport accepts (mp3/wav). Thumbnails are derived
  files too (`attachments/.thumbs/`) and do not change the original. The thumbnail/compression cache
  is **not** cleaned automatically (the attachment pruner skips it).
- **Priority of the sources.** `SYNTH_ATTACHMENTS_*` (env) > runtime (UI, `settings.json`/PG) >
  `config.yaml` `attachments` > schema defaults. Fields set via env are locked (`envLocked`):
  a different value from the UI → `409 CONFLICT`.
- **Runtime settings.** Settings → "Multimodal input" (API — `GET/PUT/DELETE /api/v2/settings/attachments`,
  [API_V2.md](./API_V2.md) §5.21) changes `enabled`/`modalities`/limits/`workspaceFallback`/`modalityModels`/`gcDays`
  plus `compression`/`thumbnail`/`maxChunkBytes` **without a restart** (deep partial merge for
  `compression`/`thumbnail`; among these fields `maxChunkBytes`, `maxActiveUploadsPerSession` and
  `maxActiveUploads` have env overrides). The full field table is in the RU version of this document.

#### Upload limits and the reverse proxy

An upload passes through several limits, and the **smallest** one wins. To avoid tuning every hop by
hand, the **transport limit is computed** from the application limits:
`max(attachments.maxBytesPerFile, storage.maxUploadBytes, 100 MiB) + 1 MiB` (headroom for the
multipart envelope: headers, boundary).

| Level | What | Where it is set | Default |
|---|---|---|---|
| Application (attachments) | `attachments.maxBytesPerFile` — size of one file | `config.yaml`, env `SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE`, runtime `/api/v2/settings/attachments` (UI "Attachments"; `restartRequired: false`) | 100 MiB (`104857600`) |
| Application (`/fs/upload`) | `storage.maxUploadBytes` — file size for `POST /api/v2/fs/upload` | `config.yaml`, env `SYNTH_MAX_UPLOAD_BYTES` | 100 MiB (`104857600`) |
| nginx in the UI pod (image `synth-ui`) | `client_max_body_size` | computed by the image entrypoint script from `SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE`/`SYNTH_MAX_UPLOAD_BYTES`; override — env `SYNTH_NGINX_CLIENT_MAX_BODY_SIZE` (Helm `ui.clientMaxBodySize`) | computed (`101m` at 100 MiB) |
| nginx-ingress (k8s) | annotation `nginx.ingress.kubernetes.io/proxy-body-size` | the Helm chart sets the same computed value; override — `ui.clientMaxBodySize` / `ingress.annotations` | computed (`101m`) |
| Traefik | no body limit | — | — |
| External Apache2 | `LimitRequestBody` (+ mod_security) | Apache config | `0` (no limit) |

**One deployment parameter.** In Helm that is `attachments.maxBytesPerFile`: the value goes to the
backend (ConfigMap → env `SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE`), to the UI pod env as the already
**computed** `SYNTH_NGINX_CLIENT_MAX_BODY_SIZE` (the chart does the math) and to the ingress
annotation — both transport levels are kept in sync from one value. Locally/standalone/`docker
compose` — env `SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE` (or `config.yaml`); there the UI container
receives that variable and computes the transport limit with an entrypoint script at startup, so no
separate nginx setting is needed.

**The transport limit is a ceiling, the application limit is stricter.** A file above
`attachments.maxBytesPerFile` is rejected by the backend (JSON `413`); the transport limit only stops
the request before it reaches the application (HTML `413` from the proxy). The 100 MiB floor and the
`storage.maxUploadBytes` input guarantee that lowering the attachment limit does not break file uploads
in the file tree: `/fs/upload` has its own limit.

The nginx default (`client_max_body_size 1m`) cuts the upload before the application does — that is
why the transport limit is computed both in the image and in the chart. If the application limit is
raised via `config.yaml`/UI, the transport limit is recomputed on the next UI pod start (nginx reads
the value at startup). An explicit `SYNTH_NGINX_CLIENT_MAX_BODY_SIZE`/`ui.clientMaxBodySize` is a full
override, not an addition: add the +1 MiB headroom yourself when setting it manually.

The UI receives the effective server-side limit from `GET /api/v2/meta` (field
`attachments.maxBytesPerFile`) — handy for verifying that the deployment took effect and for not
mixing up the levels.

**Apache2 as an external ingress.** Apache's `LimitRequestBody` default is `0` (no limit), but if it
is set — raise it for 100 MiB. `SecRequestBodyLimit`/`SecRequestBodyNoFilesLimit` apply only with
`mod_security` enabled (its default `SecRequestBodyLimit` = 12.5 MB cuts uploads). Timeouts keep
100 MB over a mobile network from being dropped; WebSocket is needed for `/ws/events`.

```apache
<VirtualHost *:443>
    # External Apache2 as a reverse proxy to Synth UI
    # Apache default is 0 (no limit), but if set — raise it for 100 MiB:
    LimitRequestBody 104857600
    # mod_security (if enabled): the default SecRequestBodyLimit = 12.5 MB cuts uploads
    # SecRequestBodyLimit 104857600
    # SecRequestBodyNoFilesLimit 1048576
    # SecRequestBodyLimitAction Reject
    # Slow mobile uploads:
    RequestReadTimeout header=20-40,MinRate=500 body=20-120,MinRate=500
    ProxyTimeout 300
    ProxyPass        "/" "http://synth-ui:8080/"
    ProxyPassReverse "/" "http://synth-ui:8080/"
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/(.*)$ ws://synth-ui:8080/$1 [P,L]
</VirtualHost>
```

- `LimitRequestBody` limits the request body; it can be set per location (`<Location "/api/v2/">`).
- `SecRequestBodyLimit` / `SecRequestBodyNoFilesLimit` — **only** with `mod_security`;
  `NoFilesLimit` limits non-file parts, `Limit` limits the whole body.
- `ProxyTimeout` / `RequestReadTimeout` — so a slow 100 MB upload is not cut by the proxy.
- The WebSocket rule is mandatory: the event stream goes through `/ws/events` (without it the UI
  loses live events).

### Observability (`metrics.*`, ADR-094)

Prometheus metrics export and the liveness/readiness split. The full metric catalogue, scrape,
alerts and troubleshooting — [OBSERVABILITY.md](../OBSERVABILITY.md) (RU); rationale —
[ADR-094](../arch_decisions/adr-094-observability-metrics.md).

| Field | Purpose | Default |
|------|-----------|--------------|
| `metrics.enabled` | Enables `GET /metrics` (same port, outside `/api/v2`) and the collection of HTTP/process/domain metrics. `false` — no endpoint (404), nothing is collected. Env — `SYNTH_METRICS_ENABLED` | `false` |

**Runtime override.** `metrics.enabled` can be toggled in the UI: Settings → Administration →
**“Metrics”** (runtime in `settings.json`/PG, API — `GET/PUT/DELETE /api/v2/settings/metrics`).
Priority: `SYNTH_METRICS_ENABLED` > runtime (UI) > `config.yaml` > default `false`; with an env value
the toggle is locked (source `env`). Middleware and collectors are created at process start, so the
change is applied **after a restart**: the API/UI expose `restartRequired = effective !== running`.
The token is applied immediately (read on every request).

The bearer token is **never stored** in `config.yaml` (invariant 13): env `SYNTH_METRICS_TOKEN`
(takes precedence) or the file `{dataDir}/secrets/metrics-token` (created manually or from the UI,
write-only; `0600`). With a token set, `/metrics` responds 401 without `Authorization: Bearer …`;
comparison is constant-time and the value is never logged. If the token comes from env, UI
write/delete operations return 409 `CONFLICT`.

```yaml
metrics:
  enabled: true
```

- `GET /health`/`/api/v2/health` — liveness; `GET /ready` — readiness (`200`; `503` only during
  start-up/fail-closed). Storage degradation does **not** drop readiness (ADR-098) — it is visible as
  `synth_storage_degraded` and the `StorageDegraded` alert.
- `/metrics` is not published through the UI nginx; in Helm — `metrics.enabled`, `prometheus.io/*`
  annotations or `ServiceMonitor`, dashboards `grafana.dashboards`, rules `alerts`
  ([charts/synth/README.md](../../charts/synth/README.md) §"Наблюдаемость"). Dev stand —
  `docker-compose.observability.yml` ([deploy/observability/README.md](../../deploy/observability/README.md)).

### Terminals (`terminal.*`, ADR-132)

Interactive terminals (PTY sessions, [ADR-132](../arch_decisions/adr-132-ui-terminal.md)):
list, create, output stream, input, resize, restart. A terminal belongs to a project; binding it to a
session is optional. The terminal registry lives **in process memory**, but its content survives a
core restart: the service writes a **snapshot** of the terminal into the blob store
(`terminals/<id>/meta.json` — the registry record + the `runningAtSave` flag,
`terminals/<id>/output.txt` — the tail of the ring
buffer, ≤ 512 KiB; ADR-096/ADR-116).

| Field | Env | Default | Bounds | Purpose |
|------|-----|---------|--------|-----------|
| `terminal.enabled` | `SYNTH_TERMINAL_ENABLED` | `true` | — | Master switch of the terminal contour. `false` — the whole `/api/v2/terminals*` contour answers `403 TERMINALS_DISABLED`, live terminals are closed, new ones are not created |
| `terminal.autoRestore` | `SYNTH_TERMINAL_AUTO_RESTORE` | `true` | — | Whether the terminals are restored from the snapshots after a core restart. `true` — only the terminals that were **active at the moment of the shutdown** are restored (the snapshot with `runningAtSave: true`): for them **a new process is started** (a new PTY with the same `cwd`/`shell`/`cols`/`rows`), and the saved output stays in the buffer as the history; the terminals that finished before the shutdown are not restored (their snapshot is deleted), the old snapshots without the `runningAtSave` flag — neither; if the process cannot be started (the execution point is unavailable, the directory is gone), the terminal stays `exited` with the saved output — it can be restarted manually. `false` — the snapshots are not raised, the reaper deletes them |
| `terminal.idleMinutes` | `SYNTH_TERMINAL_IDLE_MINUTES` | `2880` (2 days) | integer `30…10080` | Terminal idle time (minutes) before the idle-reaper closes it; it is also the snapshot TTL — an older snapshot is not restored and is removed by the reaper |
| `terminal.maxPerProject` | `SYNTH_TERMINAL_MAX_PER_PROJECT` | `8` | integer `1…64` | Limit of **live** terminals per project; exceeding it on open — `TERMINAL_LIMIT` (409) |
| `terminal.maxPerInstance` | `SYNTH_TERMINAL_MAX_PER_INSTANCE` | `32` | integer `1…256` | Limit of **live** terminals per instance; exceeding it on open — `TERMINAL_LIMIT` (409) |
| `terminal.shell` | `SYNTH_TERMINAL_SHELL` | not set — platform default (`$SHELL` → `/bin/bash`) | `^[A-Za-z0-9._/+-]{1,200}$` (a program name or an absolute path, no spaces) | Terminal shell; it is spawned as a single argv element, arguments/spaces are not allowed |
| `terminal.auditInput` | `SYNTH_TERMINAL_AUDIT_INPUT` | `true` | — | Whether `terminal.input` (the frames with `Enter` — executed commands) is written to the command-execution log (ADR-136, metadata only). `false` — the input is not logged; the `synth_terminal_bytes_total{op="input"}` metric is always counted |

**Runtime override.** All fields of the section can be edited in the admin UI (runtime in
`settings.json`/PG, API — `GET/PUT/DELETE /api/v2/settings/terminal`; `PUT` is a partial update).
The priority is **per field**: `SYNTH_TERMINAL_*` > runtime (UI) > `config.yaml` > default; an env
value locks **its own** field (source `env`, the UI answers `409 CONFLICT`), and locking one field
does not block the change of the others. An invalid value (out of bounds, wrong type, empty string)
in env/runtime/config is **ignored** — the next layer by priority applies; the UI input is validated
by the route (`400 VALIDATION_ERROR`). `shell: null` (or an empty string) explicitly resets the shell
to the platform default.

**Applied immediately** (`restartRequired: false`): toggling the switch closes live terminals
(events `terminal.exited` + `terminal.deleted` with reason `disabled`) and forbids creating new ones;
the limits, the idle time and the shell are read by the service on every operation — an instance
restart is not required.

```yaml
terminal:
  enabled: false
  autoRestore: false
  idleMinutes: 720        # close after 12 hours of idle time
  maxPerProject: 4
  maxPerInstance: 16
  shell: /bin/zsh
  auditInput: false       # do not write terminal.input to the log
```

```bash
# disable the terminal contour of the instance
SYNTH_TERMINAL_ENABLED=false
# do not restore the terminals from the snapshots after a core restart
SYNTH_TERMINAL_AUTO_RESTORE=false
# 12 hours idle, limits 4/16, shell /bin/zsh, input not logged
SYNTH_TERMINAL_IDLE_MINUTES=720
SYNTH_TERMINAL_MAX_PER_PROJECT=4
SYNTH_TERMINAL_MAX_PER_INSTANCE=16
SYNTH_TERMINAL_SHELL=/bin/zsh
SYNTH_TERMINAL_AUDIT_INPUT=false
```

- The section is `terminalConfigSchema` (`packages/shared/src/config/types.ts`); all fields are
  optional: “not set” differs from “explicitly set to the default value” — that is how the API
  distinguishes the `config` and `default` sources, while the bounds/defaults live in the core
  resolver (`DEFAULT_TERMINAL_*`, `TERMINAL_*_RANGE`, `TERMINAL_SHELL_PATTERN`).
- The priority rule is `resolveTerminalEnabled` / `resolveTerminalAutoRestore` /
  `resolveTerminalSettings` (`packages/core/src/engine/terminal/config.ts`): it is read both by the
  process start-up (service composition in `deps.ts`) and by the `/api/v2/settings/terminal` route.
  The env names follow the common section rule (`SYNTH_<SECTION>_<KEY>`, camelCase → SNAKE_CASE; the
  `ENV_OVERRIDES` registry).
- The terminal service is **one per process** (`engine/terminal/service.ts`), composed in
  `server/app/deps.ts` (managed — `backend/app/deps.ts`); it is stopped on graceful shutdown
  (`stopTerminalService` → `dispose()`).
- The snapshots live in the `BlobStore` port (ADR-096/ADR-116): `terminals/<id>/meta.json` +
  `terminals/<id>/output.txt`. They are written on process exit, on terminal close, on `dispose()` and
  every 60 s (when the output changed). An explicit terminal deletion
  (`DELETE /api/v2/terminals/:id`) removes the snapshot too. `meta.json` carries the
  `runningAtSave` flag — the terminal was **alive** at the moment of the snapshot; only
  such terminals are restored after a core restart (the process is started again), the
  ones that finished before the shutdown — not.
- The terminal port is chosen by **the same** router as the tool ports
  (`executionRouter.portFor`: the profile comes from the binding `session → agent → project → default`,
  the pool scope is `projectId`/`sessionId`, and `workspaceSubPath` is derived from the working
  directory; ADR-135) — a terminal lives on the same execution point as the session turn.
- **Pool heartbeat.** While a terminal is alive, the control plane pings the pool every 5 minutes
  (`ExecutionPort.touch` → `POST /v1/pools/{key}/touch`): the pool lives by **its own** idle timeout,
  and without the heartbeat the provisioner would remove it together with the live PTY. Therefore
  `provisioner.idleTimeoutMs` (`SYNTH_PROVISIONER_IDLE_TIMEOUT_MS`) must be **greater than 5 minutes**
  (15 minutes by default, 10 minutes on test). The heartbeat does not extend the terminal idle time:
  `terminal.idleMinutes` is counted by the input/output activity.
- Metrics — `synth_terminal_sessions{status}` / `synth_terminal_bytes_total{op}`
  ([OBSERVABILITY.md](../OBSERVABILITY.md) (RU)); terminal actions are audited as
  `terminal.open`/`terminal.input`/`terminal.close` in the command-execution log (ADR-136, metadata
  only). **`terminal.input` is written only for the frames with `Enter`** (an executed command); the
  other input frames are counted by the `synth_terminal_bytes_total{op="input"}` metric only.

### Authority (`authority.*`, ADR-106)

The authority layer is a single axis of permissions for users and agents (in addition to the instance roles, the project member roles, the agent capability and the permission-config rules). The subsystem description — [AUTHORITY.md](../AUTHORITY.md) (RU); the decision — [ADR-106](../arch_decisions/adr-106-authority-layer.md).

| Field | Purpose | Default |
|------|-----------|--------------|
| `authority.enabled` | Master switch of the layer: `false` — no decisions and no records (the permission behaviour is unchanged). Env — `SYNTH_AUTHORITY_ENABLED` | `false` |
| `authority.shadow` | Observation mode: `true` — the decision is computed and written to the journal but **not applied**; `false` — the decision is applied (enforced). Env — `SYNTH_AUTHORITY_SHADOW` | `true` |

Three modes:

| Mode | What happens |
|-------|----------------|
| **disabled** (`enabled: false`) | The layer computes no decisions and writes nothing; permissions are determined by the permission layer alone (ADR-025/ADR-029) |
| **observation / shadow** (`enabled: true`, `shadow: true`) | The authority decision is computed and written to the journal (`{dataDir}/audit/authority.jsonl`), but **not applied** — permissions do not change. This is the migration mode: a mismatch between the shadow decision and the current one is a migration defect |
| **enforcement** (`enabled: true`, `shadow: false`) | The decision is applied in the permission layer: a layer `deny` → `deny`, a layer `ask` → `ask` (a ceiling requirement that `yolo` does not lift); a layer `allow` grants nothing beyond the permission-layer decision; a tool without a mapping → `deny('unknown')`. A layer failure does not break the turn — the permission-layer decision stays in force |

```yaml
authority:
  enabled: false
  shadow: true
```

```bash
# enable the layer in the observation mode (decisions are computed, permissions do not change)
SYNTH_AUTHORITY_ENABLED=true SYNTH_AUTHORITY_SHADOW=true
```

- The section — `authorityConfigSchema` (`packages/shared/src/config/types.ts`), the defaults — `config/defaults.ts`; the env overrides follow the common `SYNTH_<SECTION>_<KEY>` rule (the `ENV_OVERRIDES` registry).
- The section has no runtime (UI) settings yet: the “Authority” UI section is a remainder of ADR-106 (Ф5).
- The enforcement is hooked into the **permission layer** (`PermissionEvaluator`), not into the tools and not into the handlers; the decision journal and the `synth_authority_decisions_total{action,effect,source}` metric — in [OBSERVABILITY.md](../OBSERVABILITY.md) (RU).

### Hybrid mode (remote)

The `remote` section enables hybrid mode: the local `synth serve` connects
to a remote backend (for example, a corporate K3s) and merges local and
remote projects/sessions in one UI, while LLM requests are centralized on the server.
Details — [HYBRID.md](../HYBRID.md).

| Field | Purpose | Default |
|------|-----------|--------------|
| `enabled` | Enable hybrid mode | `false` |
| `backendUrl` | Base URL of the remote backend | `""` |
| `auth.type` | Authentication method: `device` (OIDC device flow) or `api_key` | `device` |
| `auth.apiKey` | API key for `auth.type: api_key` | `""` |
| `auth.issuer` | OIDC issuer (Keycloak realm) for the device flow | `""` |
| `auth.clientId` | OIDC `client_id` (public client) for the device flow | `""` |
| `llm` | Where the LLM requests of local sessions go: `server` (centralization) or `local` | `server` |
| `worlds` | Which worlds are available: `{ local, remote }` | `{ local: true, remote: true }` |
| `credentialsPath` | Path to the credentials file; empty → `~/.config/synth/credentials.json` (0600) | `""` |
| `timeoutMs` | Timeout of requests to the remote backend | `15000` |

**Environment variables:** there are no separate `SYNTH_REMOTE_*` variables — the section is set
in `config.yaml` or with CLI flags (`synth serve --connect <url> --oidc-issuer ...
--oidc-client-id ... --token ...`, `synth connect|disconnect --backend <url>`,
`synth project publish|fork <id> --remote <url>`).

## First start

- `ensureDataDir()` creates the subdirectory structure in `dataDir` (sessions, projects, providers, models, agents, context, auth, workspaces)
- `ensureConfigFile()` optionally writes `config.yaml` with the defaults (depending on the mode: `~/.config/synth/config.yaml`, `./config.yaml` or `/etc/synth/config.yaml`)
- The deployment mode is determined by `resolveDeployMode()` (`SYNTH_DEPLOY_MODE` → docker markers → root → dev)

## File permissions

- `config.yaml` — `600` (rw-------)
- `data/` — outside the repository, in `.gitignore`
- API keys — never commit
