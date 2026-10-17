# Synth configuration

> 🌐 **English** · [Russian](../CONFIGURATION.md)

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
| `SYNTH_STORAGE_BACKEND` | ADR-096: physical storage backend: `file` (JSON files, ADR-005), `memory` (in-memory, data is **not** persisted) or `postgres` (PROP-032) | `file` |
| `SYNTH_POSTGRES_DSN` | PROP-032: PostgreSQL connection string (takes precedence over separate `host`/`port`/`database`/`user`) | — |
| `SYNTH_POSTGRES_HOST` | PROP-032: PostgreSQL host | — |
| `SYNTH_POSTGRES_PORT` | PROP-032: PostgreSQL port | — |
| `SYNTH_POSTGRES_DATABASE` | PROP-032: PostgreSQL database name | — |
| `SYNTH_POSTGRES_USER` | PROP-032: PostgreSQL user | — |
| `SYNTH_POSTGRES_SCHEMA` | PROP-032: DB schema (namespace of the driver's tables) | — |
| `SYNTH_POSTGRES_SSL` | PROP-032: legacy TLS-connection flag (`true`/`false`); used only when `SYNTH_POSTGRES_SSLMODE` is not set | — |
| `SYNTH_POSTGRES_SSLMODE` | PROP-032/ADR-099: TLS mode for the DB connection: `disable` / `require` / `verify-full` (`verify-ca` is an alias of `verify-full`); takes precedence over the legacy `ssl` | — |
| `SYNTH_POSTGRES_POOL_MAX` | PROP-032: maximum connection pool size | `10` |
| `SYNTH_POSTGRES_PASSWORD` | PROP-032: DB password — **only** via env or the file `{dataDir}/secrets/postgres-password` (never stored in `config.yaml`, invariant 13) | — |
| `SYNTH_DEGRADED_MODE` | PROP-032/ADR-098: behaviour when the DB is unreachable (`fallback-file`/`halt`) | `fallback-file` |
| `SYNTH_STORAGE_FALLBACK_DIR` | PROP-032/ADR-098: directory of the file fallback in degraded mode | `{dataDir}/fallback` |
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

Scalar keys of the `events`, `scheduler`, `webhooks`, `decision` sections can be set
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
| `SYNTH_PROXY_PASSWORD` | string (secret) | proxy Basic auth password (not stored in config) |
| `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | ADR-099: CA for the https proxy (mutually exclusive) | `proxy.tls` |
| `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | ADR-099: mTLS to the https proxy | `proxy.tls` |
| `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | boolean | `proxy.tls.rejectUnauthorized` |
| `SYNTH_DECISION_ENABLED` | boolean | `decision.enabled` |
| `SYNTH_DECISION_PROVIDER` | string | `decision.provider` |
| `SYNTH_DECISION_MODEL` | string | `decision.model` |
| `SYNTH_DECISION_CONFIDENCE_THRESHOLD` | number | `decision.confidenceThreshold` |
| `SYNTH_DECISION_ESCALATION_PROVIDER` | string | `decision.escalationProvider` |
| `SYNTH_DECISION_ESCALATION_MODEL` | string | `decision.escalationModel` |
| `SYNTH_BOOTSTRAP_SERVICE_KEYS` | JSON array | `security.bootstrapServiceKeys` (an object env override, ADR-052/O1; see below) |
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
                                  # | postgres (PROP-032: optional driver @itphx/synth-storage-postgres);
                                  # SYNTH_STORAGE_BACKEND
  postgres:                       # PROP-032: PostgreSQL parameters (used when backend: postgres)
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
  degradedMode: "fallback-file"   # PROP-032/ADR-098: on DB unavailability — fallback-file (file fallback,
                                  # strict read-only) | halt (stop startup); SYNTH_DEGRADED_MODE
  fallbackDir: ""                 # PROP-032/ADR-098: file fallback directory; empty — {dataDir}/fallback;
                                  # SYNTH_STORAGE_FALLBACK_DIR
  workspacesRoot: ""              # if empty — {dataDir}/workspaces; SYNTH_WORKSPACES_ROOT
  defaultWorkspace: ""            # if empty — {dataDir}/workspaces/default; SYNTH_DEFAULT_WORKSPACE
  workspaceOutsideRoot: ""        # ADR-075: policy for an absolute workspace outside workspacesRoot
                                  # confirm | deny; empty — the default per mode (standalone — confirm,
                                  # managed — deny); SYNTH_WORKSPACE_OUTSIDE_ROOT
  maxUploadBytes: 104857600       # file upload limit for /api/v2/fs/upload, bytes (>=1024, <=2 GiB);
                                  # unset — 100 MiB; SYNTH_MAX_UPLOAD_BYTES

auth:
  debugMode: false                # SYNTH_AUTH_DEBUG
  sessionMaxAgeMinutes: 1440
  # oidc: { enabled: false, issuer: "", clientId: "", clientSecret: "", redirectUri: "http://localhost:5002/auth/callback", cliClientId: "synth-cli" }

llm:
  defaultProvider: ""             # empty — the admin configures it themselves
  defaultModel: ""
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

- `storage.backend` — the physical storage backend: `file` (JSON files with atomic tmp→rename write, [ADR-005](../arch_decisions/adr-005-json-storage.md); default), `memory` (in-memory, data is **not** persisted to disk — for hermetic tests and emulation) or `postgres` (PostgreSQL; optional in-tree driver `@itphx/synth-storage-postgres`, [PROP-032](../arch_decisions/prop-032-history-storage-postgresql.md)). The domain works through domain ports, the backend is interchangeable ([ADR-096](../arch_decisions/adr-096-storage-layer.md)); any backend must pass the contract suite `packages/core/src/storage/contract/*`.
- **Priority** ([ADR-023](../arch_decisions/adr-023-configuration.md)): env `SYNTH_STORAGE_BACKEND` > `config.storage.backend` > `file`. An invalid value (not `file`/`memory`/`postgres`) — warn and fall back to config/default (fail-soft); an unknown **explicit** value in `resolveStorageBackend` itself — **fail-closed** (an error, not a silent fallback to files). Resolver — `resolveStorageBackend` (`@itphx/synth-shared/config`); the choice is applied at the assembly point `StorageContext` (`createStorageContextAsync`/`buildStorageContext`; the synchronous `createStorageContext` throws for `postgres`).
- `memory` prints the warning `storage.backend=memory: данные не сохраняются на диск` — a mode **not for production** (tests/emulation only).
- `postgres` requires the installed driver (`@itphx/synth-storage-postgres`, shipped with `@itphx/synth`; `pg` is an optional dependency of the driver) and a reachable DB. The driver applies/asserts **its own** DB schema (`synth_schema_migrations`, inline SQL migrations) — separate from `meta.json`/`synth migrate` (ADR-092); "DB schema is newer than the driver" — fail-closed.

### PostgreSQL (`storage.postgres`, PROP-032)

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

### TLS for the PostgreSQL connection (`storage.postgres.sslmode`, ADR-099 × PROP-032)

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
- **TLS is startup configuration** (not runtime): changes are applied at startup; to switch the mode — restart.

### Degraded mode on DB unavailability (`storage.degradedMode`, ADR-098)

If `postgres` is selected but the DB is unreachable at startup, the behaviour is set by `storage.degradedMode` (env `SYNTH_DEGRADED_MODE` > config > `fallback-file`; resolver `resolveDegradedMode`):

- `fallback-file` (default) — the service starts on a **file fallback** in `storage.fallbackDir` (env `SYNTH_STORAGE_FALLBACK_DIR` > config > `{dataDir}/fallback`; a **separate** directory from `dataDir`) in **strict read-only**: mutations → `503 STORAGE_DEGRADED_READONLY`, non-administrators — `503 STORAGE_DEGRADED`. `/health` returns `status: 'degraded'` + a `storage.{backend,fallbackDir,reason,since}` block; diagnostics — `GET /api/v2/storage/status`.
- `halt` — startup stops with a clear error (`STORAGE_UNAVAILABLE`).

**Fail-closed** (the fallback is **not** applied regardless of `degradedMode`): a configuration/credentials error (`STORAGE_POSTGRES_CONFIG_INVALID`), a missing dependency (`…DEPENDENCY_MISSING`, no `pg`), a driver package that cannot be loaded (`STORAGE_BACKEND_UNAVAILABLE`), a DB schema newer than the driver (`…SCHEMA_TOO_NEW`). Degradation covers a **DB failure** (network/class `08`/`57P0x`, a server auth error, `…SCHEMA_OUTDATED` — fixed by `synth migrate`, other runtime errors). There is **no** auto-return to the DB — only a restart after the connection is restored ([ADR-098](../arch_decisions/adr-098-storage-degraded-recovery.md)); procedures — [MAINTENANCE.md](../MAINTENANCE.md).

### TLS and mTLS trust for outbound connections (`security.tls`, ADR-099)

A single source of TLS/CA trust for **all** outbound connections of Synth (LLM providers, MCP HTTP,
`web_fetch`/`web_search`, webhooks, the hybrid backend, instructions/skills by URL, the update checker,
OIDC/JWKS, provider icons, git, PostgreSQL). The section is read by the resolvers `resolveTlsConfig`/`resolveTlsTrust`
(`packages/shared/src/config/tls.ts`); priority — the general one ([ADR-023](../arch_decisions/adr-023-configuration.md)):
env > `config.yaml` > defaults. Invariant — [ADR-099](../arch_decisions/adr-099-egress-tls-trust.md):
subsystems do not create their own agents/dispatchers.

| Field | Env | Purpose |
|---|---|---|
| `caFile` | `SYNTH_TLS_CA_FILE` | Path to a PEM file with the trusted CA (corporate CA); **mutually exclusive** with `caPem` |
| `caPem` | `SYNTH_TLS_CA_PEM` | PEM of the trusted CA (e.g. from a Secret); **mutually exclusive** with `caFile` |
| `certFile` | `SYNTH_TLS_CERT_FILE` | mTLS: path to the client certificate PEM file |
| `keyFile` | `SYNTH_TLS_KEY_FILE` | mTLS: path to the client private key PEM file |
| `rejectUnauthorized` | `SYNTH_TLS_REJECT_UNAUTHORIZED` | Verify the server certificate (`true`/`1`/`false`/`0`); default `true` |

- **An empty section — system trust** (Node's system CAs), behaviour is unchanged.
- **`rejectUnauthorized`:** `true` (default) — server-certificate verification; `false` — verification disabled (a deliberate MITM risk; debugging only). An invalid env value — `warn` + fall back to config/default.
- **mTLS:** `certFile` **and** `keyFile` must be set together; exactly one — a configuration error.
- **Fail-closed:** `caFile` and `caPem` together → an error; an explicitly set `caFile` that is missing/unreadable/not PEM → an error (no silent fallback to system trust); configured trust without the installed `undici` package (a direct dependency of core `undici@^7`) → a clear error, not an untrusted transport.
- **Application:** at process startup a global undici dispatcher is built (`setGlobalDispatcher`), so the ordinary `fetch` inherits the trust; points outside the shared transport (git) get the CA via `http.sslCAInfo=<caFile>` (`caPem` without a file is unavailable to the git channel).
- **`NODE_EXTRA_CA_CERTS` — compatibility only** (inherited by child processes: MCP stdio, git), **not** a configurable trust mechanism.
- **The TLS transport is startup configuration:** the section is **not** part of the runtime settings (`RuntimeSettings`); changes are applied at startup and require a restart. The same holds for the proxy (`proxy.*`, see below). The address policy, by contrast, is **runtime** (live per-request): see the next section.

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
    exceptions: []
```

### Proxy (`proxy.*`, ADR-099 D1+D2)

An outbound HTTP/HTTPS/SOCKS5 proxy — part of the single egress layer (see also `security.tls` — trust for the
**target** and for the https proxy, and `egress.*` — the address policy). The section is **top-level** and
**start-only**: changes are applied at process startup (like `security.tls`), with no runtime switching. The
route is chosen **per origin**: `httpsProxy`/`httpProxy` by the target scheme → `allProxy` → `url`; hosts in
`noProxy` go direct.

| Field | Env | Purpose | Default |
|---|---|---|---|
| `enabled` | `SYNTH_PROXY_ENABLED` | Explicit switch. Unset — the proxy is enabled by the presence of a URL (including the standard env vars when `fromEnv`); an explicit `false` suppresses the standard env | — (auto) |
| `url` | `SYNTH_PROXY_URL` | Common proxy `http://`/`https://`/`socks5://`/`socks5h://` (userinfo allowed but stripped from status/logs) | — |
| `httpProxy` / `httpsProxy` | `SYNTH_PROXY_HTTP_PROXY` / `SYNTH_PROXY_HTTPS_PROXY` | Proxy for targets by scheme (`http`/`https`); takes precedence over `allProxy`/`url` | — |
| `allProxy` | `SYNTH_PROXY_ALL_PROXY` | Proxy for all schemes (when no scheme-specific one) | — |
| `noProxy` | `SYNTH_PROXY_NO_PROXY` | Exceptions: `host`, `.suffix`, `*.suffix`, `host:port`, IP, CIDR (matched against the target IP literal — no DNS), `*` | `[]` |
| `fromEnv` | — | Honour the standard `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` | `true` |
| `fallbackDirect` | `SYNTH_PROXY_FALLBACK_DIRECT` | Explicit opt-in: go direct when the proxy is unavailable (warn + `via:'fallback'`). Auth errors (`407`) do **not** allow fallback | `false` |
| `connectTimeoutMs` | `SYNTH_PROXY_CONNECT_TIMEOUT_MS` | Proxy connection timeout, ms | `10000` |
| `auth.type` | — | `basic` — implemented; `ntlm`/`negotiate` → configuration error (remainder) | `basic` |
| `auth.username` | — | Basic username (alternative — userinfo in the URL) | — |
| `auth` password | `SYNTH_PROXY_PASSWORD` | Basic password: **only** the env var or the file `{dataDir}/secrets/proxy-password` (not stored in config.yaml, invariant 13) | — |
| `tls.caFile` / `tls.caPem` | `SYNTH_PROXY_TLS_CA_FILE` / `SYNTH_PROXY_TLS_CA_PEM` | CA for the **https proxy itself** (mutually exclusive) | system trust |
| `tls.certFile` / `tls.keyFile` | `SYNTH_PROXY_TLS_CERT_FILE` / `SYNTH_PROXY_TLS_KEY_FILE` | mTLS to the https proxy | — |
| `tls.rejectUnauthorized` | `SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED` | Verify the proxy certificate | `true` |

**Priority (ADR-023):** `SYNTH_PROXY_*` > `config.proxy` > the standard `HTTP_PROXY`/`HTTPS_PROXY`/
`ALL_PROXY`/`NO_PROXY` (only with `fromEnv`) > defaults. An explicit `proxy.enabled: false` suppresses the
standard env — the proxy is not enabled "from the environment" against the config. `noProxy`:
`SYNTH_PROXY_NO_PROXY` > a non-empty `proxy.noProxy` > `NO_PROXY`.

**Fail-closed.** A broken URL, an unknown scheme, `enabled=true` without a URL, Basic without a password,
`auth.type` ≠ `basic`, `proxy.tls` together with `socks5://` → a configuration error at startup
(`EGRESS_PROXY_CONFIG_INVALID`). An unavailable proxy → `EGRESS_PROXY_UNAVAILABLE` (no silent direct);
`407`/SOCKS refusal → `EGRESS_PROXY_AUTH_REQUIRED`/`EGRESS_PROXY_AUTH_FAILED`.

**Address policy behind a proxy** (ADR-099 item 18): for requests through the proxy only the scheme and the
hostname rules/`exceptions` are checked (no DNS/CIDR — the proxy resolves the address); for `noProxy` hosts
the check is full (DNS/CIDR per hop). The actual route is written to the egress journal (`via`:
`proxy`/`direct`/`fallback`); `POST /api/v2/settings/egress/check` returns `proxied`/`addressChecksActive`.

**API/UI.** `GET /api/v2/settings/proxy` — a read-only status (redacted URL, source `env`/`config`/`none`,
`noProxy`, `fallbackDirect`, `connectTimeoutMs`, `restartRequired: true`); `POST /api/v2/settings/proxy/check`
— checks the proxy connection only (TCP/TLS/SOCKS handshake, `authChallenge`, `latencyMs`; the target is not
requested). UI — the admin section "Proxy (egress)" in "Built-in tools".

**Limitations.** NTLM/Negotiate/Kerberos are not implemented (a custom CONNECT loop and a native dependency
are required; acceptance — with the customer's AD/KDC). `security.tls` for the **target** is not applied
through SOCKS5 (a `Socks5ProxyAgent` limitation — system trust only). An https proxy/SOCKS by IP literal
requires a DNS host (SNI by IP is forbidden in Node); `proxy/check` may still report `reachable`. SOCKS5/SOCKS5H
in undici are experimental and resolve the hostname at the proxy. The built-in global `fetch` is not
guaranteed (npm `setGlobalDispatcher` does not affect it on Node 26; on Node 22 — re-check in CI) — the paths
through `egressFetch` are covered. PostgreSQL is not proxied (not HTTP). git applies `no_proxy` via libcurl,
there is no per-remote setting; `stdio` MCP receives the proxy env without the password.

Example:

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

### At-rest secrets (`security.secretKey`, ADR-076)

- `security.secretKey` — the master key for encrypting the secrets in storage (agent SSH keys; AES-256-GCM). Env — `SYNTH_SECRET_KEY`.
- **Priority**: env `SYNTH_SECRET_KEY` > `config.security.secretKey` > the file `{dataDir}/secrets/master.key` (the `resolveSecretKey` resolver).
- **Key formats**: base64 (exactly 32 bytes) or 64 hex characters; otherwise — the error `encryption_unavailable` (no silent truncation).
- **Fallback file**: if the key is set neither via env nor via the config, core creates `{dataDir}/secrets/master.key` on the first start (`randomBytes(32)`, directory `0700`, file `0600`, atomic write). Secrets are encrypted at rest.
- **Rotation**: `synth secrets rotate` (`--data-dir`, `--config`, `--old-key`/`--old-key-file`, `--new-key`/`--new-key-file`, `--dry-run`, `--yes`) re-encrypts the existing SSH keys from the old key to the new one (preflight: an undecryptable field → abort, nothing is written), updates `master.key` and resets the cache; `--dry-run` shows a summary without writing. Without `--yes` (and without `--dry-run`) — refusal. If the effective key is set via env/`config.security.secretKey`, the file is overwritten but ignored at start — update the key in env/config. Before rotation a backup of `$SYNTH_DATA_DIR` and stopping the server are recommended.

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
PROP-032); a K8s `Lease` is a future step (ADR-051).

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
