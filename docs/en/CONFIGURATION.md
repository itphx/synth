# Synth configuration

> 🌐 **English** · [Russian](../CONFIGURATION.md)

> ⚠️ RU-версия обновлена 2026-10-26 (ADR-111/PROP-096/097: **секция `background.*`** «Фоновые прогоны» — `enabled`/`maxSubagentsPerSession`/`maxProcessesPerSession`/`maxRunsPerSession`/`logMaxBytes`/`retentionDays` и env-оверрайды `SYNTH_BACKGROUND_*` — **переведено**); RU-версия обновлена 2026-10-25 (**секция `questions.*`** «Вопросы пользователю» — `timeoutMs`/`retentionDays` и env-оверрайды `SYNTH_QUESTIONS_*`; секция `plugins` — модели эмбеддингов `plugins.embedding*`: проверенные модели, egress, `stale` при смене модели — переведено); перевод отстаёт (кроме секций `plugins.*` и `questions.*`): ADR-102, секция `analytics`.

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
| `SYNTH_API_KEY` | Key to log into the API (backend → role ADMIN; core standalone → role ADMIN). If not set, `synth serve` generates a stable local key in `{dataDir}/secrets/api-key` | — |
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
| `SYNTH_CONFIG` | Path to `config.yaml` (takes precedence over the cascading search) | cascading search |
| `SYNTH_HOME` | ADR-079: base home directory of a local instance (`--home`): config/data/profiles/credentials are resolved from it | — |
| `SYNTH_HOST` | Listening address of the HTTP servers (backend — `0.0.0.0`; `synth serve` — `127.0.0.1`) | `0.0.0.0` / `127.0.0.1` (serve) |
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
| `SYNTH_EXECUTION_MODE` | ADR-077: execution topology — `inline` (default) \| `remote` (remote executor, ADR-077 step 7b; fail-closed at startup) | `inline` |
| `SYNTH_EXECUTION_REMOTE_URL` | ADR-077: executor address list (comma-separated) | — |
| `SYNTH_EXECUTION_TOKEN` | ADR-077: path/reference to the executor token (NOT a value, invariant 13) | — |
| `SYNTH_EXECUTION_TIMEOUT_MS` | ADR-077: exec-call timeout, ms | `30000` |
| `SYNTH_EXECUTION_CONCURRENCY` | ADR-077: limit of concurrent exec calls | process CPU count |
| `SYNTH_EXECUTION_FAIL_MODE` | ADR-077: behaviour when the executor is unavailable (`fail`/`inline-fallback`) | `fail` |

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

### Env overrides of nested sections (ADR-023)

Scalar keys of the `events`, `scheduler`, `webhooks`, `decision`, `questions`, `background`,
`authority` sections can be set
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
| `SYNTH_QUESTIONS_TIMEOUT_MS` | number | `questions.timeoutMs` (stage 1 of roadmap 0.13 — block 3) |
| `SYNTH_QUESTIONS_RETENTION_DAYS` | number | `questions.retentionDays` (stage 1 of roadmap 0.13 — block 3) |
| `SYNTH_BACKGROUND_ENABLED` | boolean | `background.enabled` (stage 1 of roadmap 0.13 — block 4) |
| `SYNTH_BACKGROUND_MAX_SUBAGENTS_PER_SESSION` | number | `background.maxSubagentsPerSession` (stage 1 of roadmap 0.13 — block 4) |
| `SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION` | number | `background.maxProcessesPerSession` (stage 1 of roadmap 0.13 — block 4) |
| `SYNTH_BACKGROUND_MAX_RUNS_PER_SESSION` | number | `background.maxRunsPerSession` (stage 1 of roadmap 0.13 — block 4) |
| `SYNTH_BACKGROUND_LOG_MAX_BYTES` | number | `background.logMaxBytes` (stage 1 of roadmap 0.13 — block 4) |
| `SYNTH_BACKGROUND_RETENTION_DAYS` | number | `background.retentionDays` (stage 1 of roadmap 0.13 — block 4) |
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
RestartSec=2
```

**Multi-replica:** the endpoint restarts only the process/pod that served the request; for the whole
Deployment use `kubectl rollout restart deployment/<release>-synth-backend` (or `helm rollback`). Active
streams and in-flight requests on the restarted process are interrupted; the request is written to the audit
journal as `restart.requested`. The UI waits for `startedAt` in `GET /health` to change (up to 90 s), then
reloads.

`GET /health` and `GET /api/v2/health` return an additive `startedAt` field (ISO) — the process start
timestamp.

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

auth:
  debugMode: false                # SYNTH_AUTH_DEBUG
  sessionMaxAgeMinutes: 1440
  # oidc: { enabled: false, issuer: "", clientId: "", clientSecret: "", redirectUri: "http://localhost:5002/auth/callback", cliClientId: "synth-cli" }

llm:
  defaultProvider: ""             # fallback: empty — the admin configures it themselves; the runtime provider + model pair
  defaultModel: ""                # is set in the «Models» UI (`/api/v2/settings/default-model`) and takes precedence over config
  maxRetries: 3
  timeout: 60
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
  enabled: false                  # disabled by default
  inputMode: "obfuscate"          # obfuscate | block
  logPayloads: false
  payloadLogPath: ""              # path of the full JSONL log; empty → {dataDir}/audit/llm-payloads.jsonl
  rateLimit: { userPerMinute: 60, providerPerMinute: 120 }
  audit: { enabled: true, logPath: "" }   # empty logPath → {dataDir}/audit/llm-gateway.jsonl

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
  askTimeoutMs: 30000

security:
  promptInjection:
    enabled: true
    wrapContent: true
    mode: "flag"                  # flag | sanitize | block
  protectedPaths:
    enabled: true
  tls:                            # ADR-099: TLS/CA trust for outbound connections (env SYNTH_TLS_*)
    caFile: ""                    # path to a PEM file with the trusted CA (corporate CA); mutually exclusive with caPem
    # caPem: ""                   # PEM of the trusted CA (e.g. from a Secret); mutually exclusive with caFile
    certFile: ""                  # mTLS: path to the client certificate PEM file
    keyFile: ""                   # mTLS: path to the client private key PEM file
    rejectUnauthorized: true      # verify the server certificate (default true)
  secretKey: ""                   # ADR-076: master key of the at-rest secrets (empty → file dataDir/secrets/master.key)
  bootstrapServiceKeys: []        # ADR-052/O1: installer service keys (label/secret/scopes/roles?) — see below; usually via the env SYNTH_BOOTSTRAP_SERVICE_KEYS

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
[ADR-077](../arch_decisions/adr-077-runtime-toolchain.md).

| Field | Type / values | Default | Env | Meaning |
|---|---|---|---|---|
| `execution.mode` | `inline` \| `remote` | `inline` | `SYNTH_EXECUTION_MODE` | Topology: `inline` — execution inside the backend process (all-in-one, the previous behaviour); `remote` — separate executors |
| `execution.remote.url` | list of addresses | `[]` | `SYNTH_EXECUTION_REMOTE_URL` (comma-separated) | Executor addresses (K8s Service `synth-executor`, `http://…`); empty with `remote` → fail-closed at startup |
| `execution.remote.timeoutMs` | number | `30000` | `SYNTH_EXECUTION_TIMEOUT_MS` | Exec-call timeout (30 s — as with the current tools; the longer shell limit is a tool property, not a config one) |
| `execution.remote.concurrency` | number | process CPU count | `SYNTH_EXECUTION_CONCURRENCY` | Limit of concurrent exec calls on the backend; exceeding it queues the call |
| `execution.remote.failMode` | `fail` \| `inline-fallback` | `fail` | `SYNTH_EXECUTION_FAIL_MODE` | Behaviour when the executor is unavailable: `fail` — fail-closed (the tool is unavailable with an explicit reason); `inline-fallback` — the backend runs the command itself (**only with an explicit setting**) |
| `execution.remote.tokenSecret` | path/reference | — | `SYNTH_EXECUTION_TOKEN` | **A path/reference to the token, NOT the value** (invariant 13). The token itself is `synth_exec_…` and lives in a Secret/file |

**Priority** ([ADR-023](../arch_decisions/adr-023-configuration.md)): CLI flag `--execution-mode inline|remote` >
env `SYNTH_EXECUTION_*` > `config.yaml` > default. Resolver — `resolveExecutionConfig`
(`@itphx/synth-shared/config`).

**Fail-closed** (as for `storage.backend`): an unknown **explicit** `mode` value (a typo such as `inlne`) or
`failMode` — a configuration error, not a silent fallback to the default:

```text
[config] невалидное значение SYNTH_EXECUTION_MODE="inlne": ожидается одно из 'inline', 'remote'
[config] невалидное значение --execution-mode="inlne": ожидается одно из 'inline', 'remote'
```

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
```

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

- **An empty configuration — system trust** (Node's system CAs), behaviour is unchanged.
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
- **`NODE_EXTRA_CA_CERTS` — compatibility only** (inherited by child processes: MCP stdio, git), **not** a
  configurable trust mechanism.
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

### Skills (`skills.*`, ADR-046)

The `skills` section manages skill discovery, trust of project directories,
inline shell in template commands and remote catalogs:

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
  are not loaded — they do not get into the model catalog, the `/` autocomplete or the core
  `skill` tool. Commands additionally cannot override a trusted skill/bundle.
- **`skills.urls`** are cached, indexed and visible in the registry, but marked
  **`trusted:false`** (they do not get into the model catalog). Installation/update,
  trust levels and signatures of remote catalogs — the task [PROP-068](../arch_decisions/prop-068-skills-agents-registry.md).
- **`skills.inlineShell`** is disabled by default; when enabled, execution happens
  only with `allow` from `PermissionEvaluator` (like `execute_shell`), with a timeout,
  an output limit and the audit event `command.inline_shell`; `deny`/`ask` —
  refusal without an interactive prompt.
- **Builtin skill `skill-creator`** (`instance`/`system`, `trusted`) — a built-in
  instruction on creating a project skill in `{project.workspace}/.synth/skills`;
  available as `/skill-creator` (requires `file_read`/`file_write`).

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
- **Project-trust:** instructions of an untrusted project (not in `skills.trustedProjectDirs`) are not loaded (status `untrusted`). A directory inside `storage.workspacesRoot` is trusted **automatically** (R3) — the gate is shared by the system chain and lazy loading; it does not affect project-trust of skills (ADR-046).
- **Install-tree guard:** inside the Synth source tree instructions are not loaded (status `skipped-install-tree`), except with `allowInstallTreeFallback: true`.
- **Cache/invalidation (R5, no new settings):** the resolver result is cached by the candidate signature (`mtime:size`, the helper `engine/file-signature.ts`, shared with skills ADR-046); a file change/addition/removal invalidates it, `ProjectInstructionsResolver.clear()` — a forced reset. In a real turn the result is additionally memoized by `turnId`.
- Disabling: `instructions.enabled=false`, `excludeProjects`, the CLI `--ignore-rules`/`--safe-mode` (or the env `SYNTH_IGNORE_RULES=1|true`; the flags take precedence over env, they work for `serve` and `chat`), as well as the `session.settings.systemPrompt` override.
- Transparency: `GET /api/v2/context/instructions?session_id=…` and the event `context.instructions_loaded`; the UI — the "Project instructions" section in the right panel (the "Session" tab).
- `/init` — a builtin command (status `prompt`) that generates/updates `AGENTS.md`; the skill `synth-agents-md` (`/agents-md`) — audits/updates the instructions.

### Slash commands (`commands.*`, ADR-046)

Resolving `/` commands is done in core. The `commands` section:

| Field | Purpose | Default |
|------|-----------|--------------|
| `commands.paths` | Extra directories of templated `.md` commands (after project/instance) | `[]` |
| `commands.bundlesPath` | Subdirectory of `{dataDir}` for YAML bundles | `skill-bundles` |
| `commands.conflict.mode` | Name-conflict mode: `bundle-wins` \| `conservative` \| `namespace` | `bundle-wins` |
| `commands.conflict.namespacePrefix` | In `namespace`: bundle skills as `<bundle>:<skill>` on a conflict with a builtin | `false` |
| `commands.maxArgumentsLength` | Limit of `$ARGUMENTS` | `10000` |
| `commands.maxRenderedBytes` | Limit of rendering a template/bundle aggregate | `200000` |

Sources of template commands (priority): `{project.workspace}/.synth/commands` > `{dataDir}/commands` > `commands.paths`. Built-in commands — `/help`, `/skills`, `/commands`, `/summary`, `/init` (ADR-069; `/compact`, `/review` are deferred). Skill commands — `/skill-creator`, `/agents-md` (builtin skills). `allowed-tools` in the frontmatter — advisory (not translated into permissions).

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

### User questions (`questions.*`, stage 1 of roadmap 0.13 — block 3)

The section sets the behaviour of the "ask the user" subsystem (the `question` tool): the
agent asks a question with answer options and the turn **waits** for the user's answer.
The answer comes by the question `id` (`POST /api/v2/sessions/:id/questions/:qid/answer`).

| Field | Purpose | Default |
|------|-----------|--------------|
| `questions.timeoutMs` | The wait for an answer, ms. `0` — **no timeout**: the question waits until it is answered or cancelled (the end of the turn, "Stop", a manual cancel). When the time expires, the question is cancelled with the reason `timeout`. Env — `SYNTH_QUESTIONS_TIMEOUT_MS` | `600000` (10 minutes) |
| `questions.retentionDays` | The retention of the terminal question records (`answered`/`cancelled`), days; `<= 0` — no limit. Env — `SYNTH_QUESTIONS_RETENTION_DAYS` | `14` |

```yaml
questions:
  timeoutMs: 600000
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

### Background runs (`background.*`, stage 1 of roadmap 0.13 — block 4)

The section sets the behaviour of the single registry of the background work: background
**subagents** (`task({background: true})`, PROP-096/ADR-111) and background **shell
processes** (`execute_shell({background: true})`, ADR-113) live in **one** registry —
there is no second storage. The limits are counted per the owner session (for a subagent —
the parent session).

| Field | Purpose | Default |
|------|-----------|--------------|
| `background.enabled` | The master switch of the background work. `false` — both `task({background: true})` and `execute_shell({background: true})` respond with an error (`task.background_disabled` / `process.background_disabled`; the turn does not fail), while the foreground work and the registry keep working. Env — `SYNTH_BACKGROUND_ENABLED` | `true` |
| `background.maxSubagentsPerSession` | The maximum of the background subagents running at the same time per the owner session; exceeding it → `background_limit_exceeded` (a tool error, the turn does not fail). Env — `SYNTH_BACKGROUND_MAX_SUBAGENTS_PER_SESSION` | `2` |
| `background.maxProcessesPerSession` | The maximum of the background shell processes running at the same time per the owner session; exceeding it → `background_limit_exceeded`. Env — `SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION` | `5` |
| `background.maxRunsPerSession` | The maximum of the registry records per the owner session (all the records are counted, they are cleaned by the retention). Env — `SYNTH_BACKGROUND_MAX_RUNS_PER_SESSION` | `10` |
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
  of the background processes — a blob store (`BlobStore`), the path `processes/<id>.log`.
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
