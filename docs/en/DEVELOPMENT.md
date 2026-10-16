# Synth development

> 🌐 **English** · [Russian](../DEVELOPMENT.md)

## Requirements

- **Node.js** >= 22
- **pnpm** >= 11

## Quick start

```bash
# Install dependencies
pnpm install

# Type checking
pnpm typecheck

# Run tests
pnpm test

# Build all packages
pnpm build

# Linting
pnpm lint
```

## dev.sh

The all-purpose development script — `synth/scripts/dev.sh`:

```bash
./scripts/dev.sh            # backend (:5000) + UI (:5002)
./scripts/dev.sh backend    # backend only
./scripts/dev.sh ui         # UI only
./scripts/dev.sh core       # synth-core standalone (:4300)
./scripts/dev.sh all        # backend + UI + core
```

Logs are written to `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log` (inside `synth/`). They are cleared on restart. On Ctrl+C the log paths are printed.

### dev.sh environment variables

- `SYNTH_AUTH_DEBUG=true` — debug mode with test users
- `SYNTH_DATA_DIR=${SYNTH_DATA_DIR:-<repo>/../data}` — data directory outside the repository; the default is the `data/` directory next to the monorepo, overridden by the environment variable
- `SYNTH_LOG_DIR=$ROOT/tmp` — log directory (the `/api/v2/logs` endpoint)
- `SYNTH_PORT=5000`, `SYNTH_CORE_PORT=4300`, `VITE_PORT=5002`
- `SYNTH_HOST=0.0.0.0` — host for all services

### Auth debug mode

`dev.sh` enables `SYNTH_AUTH_DEBUG=true` automatically.  
The login form shows a user selector with test keys:

| User | Key | Role |
|-------------|------|------|
| admin | `admin-key-123` | ADMIN |
| developer | `user-key-456` | USER |
| lead | `lead-key-789` | LEAD |
| auditor | `auditor-key-012` | AUDITOR |

The keys are overridden via: `SYNTH_TEST_ADMIN_KEY`, `SYNTH_TEST_USER_KEY`, `SYNTH_TEST_LEAD_KEY`, `SYNTH_TEST_AUDITOR_KEY`.

## Dev on PostgreSQL (`postgres` storage backend)

For debugging against a database, dev runs a PostgreSQL container and the dev config switches
the storage backend. The full data-migration runbook (backup → dry-run → apply → verify →
rollback) is in [MAINTENANCE.md](../MAINTENANCE.md) (Russian); parameters and
`storage.degradedMode` — [CONFIGURATION.md](./CONFIGURATION.md).

### Container

- Name — `synth-postgres-dev` (image `postgres:17-alpine`, `RestartPolicy=unless-stopped`,
  volume `synth-pg-dev-data`, published on `127.0.0.1:5432`).

```bash
docker ps --filter name=synth-postgres-dev                 # status (should be Up … (healthy))
docker start synth-postgres-dev                            # if stopped
docker logs --tail 50 synth-postgres-dev                   # database logs
docker inspect synth-postgres-dev \
  --format 'RestartPolicy={{.HostConfig.RestartPolicy.Name}} Volumes={{range .Mounts}}{{.Name}} {{end}}'
```

### Credentials and password

- **Container credentials** (role/database creation) — `secrets/postgres-dev.env`
  (`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`), outside git; the password is not
  quoted in the docs — take it from the file (`set -a; . secrets/postgres-dev.env; set +a`).
- **Runtime password for Synth** — the file `{dataDir}/secrets/postgres-password` (mode `600`),
  overridden by the env `SYNTH_POSTGRES_PASSWORD` (see `resolvePostgresPassword`). Never print or
  commit the value.

### Switching the config

`dev.sh` picks up `packages/backend/config.yaml` as `SYNTH_CONFIG` (if the file exists), so the
backend mode is enabled by a section in that file (**untracked/gitignored** — editing is allowed,
the password is not stored in the config):

```yaml
storage:
  backend: postgres
  postgres: { host: 127.0.0.1, port: 5432, database: synth, user: synth }
```

### Start and restart

Stop the whole service (the `dev.sh` process group) — otherwise parallel writes to files will
diverge from the database:

```bash
# Stop dev (the PGID of the running dev.sh; ports 5000/4300/5002 must be released).
kill -TERM -<pgid>          # pgid — the dev.sh process group
# Then start as usual.
./scripts/dev.sh            # backend (:5000) + UI (:5002)
```

### Back to the file backend

Remove the `storage` section from `packages/backend/config.yaml` → restart dev. The data in
`{dataDir}` (default `<repo>/../data`) is **not** deleted by the migration, so the file state
stays usable; if needed, migrate changes back from the database into a fresh directory
(`--to file --target-data-dir <empty dir>`, see [MAINTENANCE.md](../MAINTENANCE.md)).

### Where the backup and file data live

- File data — `../data` (dev): `sessions/`, `projects/`, `settings.json`, `secrets/`,
  `backups/`, etc.
- File-perimeter backup before migration — `../data/backups/synth-backup-<version>-<stamp>.tar.gz`
  (`synth backup --out <dataDir>/backups --data-dir <dataDir>`); do not delete the file data —
  it is the second rollback level.

### Known gotchas (dev)

- **Do not set `SYNTH_STORAGE_BACKEND` when calling `synth storage migrate`.** The source is
  resolved from config/env, the target is set by the `--to` flag; if they match, the command
  fails (“source and target are the same”). Provide the DB target parameters via `SYNTH_POSTGRES_*`,
  not via `config.storage.postgres`, until the migration is done.
- **`synth doctor` in `postgres` mode** may print port warm-up warnings
  (`port '…' warm-up failed: pool unavailable`) while the overall status is `ok: true` and
  `db-connection: ok` — it does not affect operation (expected behaviour).
- **Session counts may differ:** `GET /api/v2/sessions` excludes archived sessions by default
  (`archivedAt`/`expiresAt`), so in the sample run the API returned 296 while the DB had 297 rows.
  Compare against the DB counter (`select count(*) from sessions`), not only the API.
- **`storage.degradedMode` defaults to `fallback-file`** — if the DB is down, the service silently
  comes up on the file fallback (`{dataDir}/fallback`) and the data diverges. For DB mode consider
  `storage.degradedMode: halt` (see [MAINTENANCE.md](../MAINTENANCE.md)).

## standalone.sh

Running Synth "as an end user" — `synth/scripts/standalone.sh`:
builds the monorepo npm packages (`shared → core → ui → synth`), packs them
(`pnpm pack`), installs them into an isolated prefix (`npm install` of the four `.tgz`)
and runs `synth serve` from the installed `node_modules/.bin/synth`. By default
`serve` starts with an isolated local home (ADR-079):
`--home ~/.local/share/synth-standalone`, the parent `SYNTH_*` environment is cleared. All
local paths are resolved from home: dataDir `<home>/data`, config `<home>/config.yaml`,
profiles `<home>/profiles.json`, credentials `<home>/credentials.json` — therefore
standalone does **not** pick up `lastProfile` from the shared `~/.config/synth/profiles.json`.
host `127.0.0.1`, port 4400 (passed explicitly via `--port`), the API key is auto-generated and
stored in `<home>/data/secrets/api-key`. The flags `--port/--host/--home/--data-dir/--api-key`
remain **explicit overrides** (`--data-dir` takes precedence over `--home`).
`hybrid.sh` uses `4300` by default, so standalone (`4400`) and hybrid (`4300`)
can be started at the same time (different ports and home).
It is needed for manual and automated checking of the
standalone UI (including the working-directory picker, ADR-075), where managed
shows read-only, and standalone follows the `confirm` policy.

```bash
./scripts/standalone.sh                 # build, install, run (foreground)
./scripts/standalone.sh --no-build      # quick restart on the built packages
./scripts/standalone.sh --check         # full smoke test and exit (CI/autotest)
./scripts/standalone.sh --clean --data-dir tmp/standalone/data --port 4310
```

Options:

| Option | Purpose |
|---|---|
| `--port <port>` | explicit port override (default: `4400`; `hybrid.sh` — `4300`) |
| `--host <host>` | explicit listen address override (default: `127.0.0.1`) |
| `--home <path>` | ADR-079: local home directory (default: `~/.local/share/synth-standalone`); config/data/profiles/credentials are resolved from it |
| `--data-dir <path>` | explicit data directory override (takes precedence over `--home`) |
| `--api-key <key>` | explicit API key for local auth (by default auto-generated in `{dataDir}/secrets/api-key`; printed in the summary) |
| `--prefix <path>` | package installation directory (default: `tmp/standalone/install`) |
| `--no-build` | do not rebuild the packages (use the already built `dist`) |
| `--rebuild-packs` | force rebuild the tarballs |
| `--check` | run the smoke checks and exit (exit code 0/1) |
| `--keep-data` / `--clean` | do not clear / clear `--data-dir` (default — `--keep-data`); `--clean` is allowed **only** with an explicit `--data-dir` (otherwise `~/.local/share/synth` could be wiped) |

The script determines the effective dataDir/key/host/port from the server output (the
data-directory line, the API-key line and the `Open http://` line) — with explicit options they match the
ones passed.

Logs: `tmp/standalone-build.log` — build/pack/install, `tmp/standalone.log` — standalone server output.

`--check` runs the smoke test: `/health` → 200, `POST /projects` → 201 with workspace directory creation,
`GET /fs/workspace-root` → 200, `GET /settings/workspace-policy` → 200 with `outsideRoot=confirm` (standalone),
then shuts the server down.

**Differences.** `dev.sh` runs backend+UI (and core) **from source** on fixed ports with
debug-auth; `standalone.sh` installs the **built npm packages** into an isolated prefix and runs
`synth serve` (one API key, FileStore in dataDir) on the npm package defaults — closer to the final
deployment.
`hybrid.sh` (`./scripts/hybrid.sh`) brings up a local core connected to a remote backend
(hybrid mode) — see [HYBRID.md](./HYBRID.md). The `--home <path>` option (ADR-079) isolates
config/data/profiles/credentials; without it the current behaviour is kept (`~/.local/share/synth`).

> Tarballs are built via `pnpm pack` (not `npm pack`): only pnpm resolves `workspace:*`
> to a real version, otherwise `npm install` cannot resolve the local packages.

## Manual start

The main path is through the thin CLI wrapper `@itphx/synth` (the UI is resolved from `@itphx/synth-ui` automatically):

```bash
# Build + run the standalone server
pnpm --filter @itphx/synth build
node packages/synth/dist/cli.js serve --api-key "dev-key"

# CLI chat through the wrapper
node packages/synth/dist/cli.js chat "hello"
node packages/synth/dist/cli.js config provider list
```

Running individual components:

```bash
# synth-backend
pnpm --filter @itphx/synth-backend dev

# synth-ui
pnpm --filter @itphx/synth-ui dev

# synth-core (standalone, core CLI)
pnpm --filter @itphx/synth-core build
node packages/core/dist/main.js serve --api-key "dev-key"
node packages/core/dist/main.js chat "hello"
node packages/core/dist/main.js config
```

`synth serve` defaults: host `127.0.0.1` (honours `SYNTH_HOST`), port `core.port`
(4300, `SYNTH_CORE_PORT`), dataDir `~/.local/share/synth` (user mode), config
`~/.config/synth/config.yaml`. If `--api-key`/`SYNTH_API_KEY`/`core.apiKey` are not
set, a stable local key is generated (32 hex), stored in
`{dataDir}/secrets/api-key` (file `0600`, directory `0700`) and printed at startup
in full together with the path to the file.

## Project structure

```
synth/
├── packages/
│   ├── shared/   → @itphx/synth-shared    # Types, Zod schemas, protocols, configuration
│   ├── core/     → @itphx/synth-core      # Engine, CLI, HTTP API v2, MCP, FileStore
│   ├── backend/  → @itphx/synth-backend   # Hono API Hub: OIDC, RBAC, Runner Registry
│   ├── ui/       → @itphx/synth-ui        # React 19 SPA + admin panel (Vite)
│   ├── sdk/      → @itphx/synth-sdk       # Typed client for the public API (ADR-052)
│   └── synth/    → @itphx/synth           # Thin CLI wrapper (bin: synth), does not bundle core
├── scripts/
│   ├── dev.sh                  # Development script
│   ├── build.sh                # Full build
│   ├── standalone.sh           # Standalone from the built npm packages
│   ├── hybrid.sh               # Local core + remote backend (hybrid)
│   ├── publish.sh              # Publishing to npm
│   ├── publish-packages.sh     # Idempotent publishing of the 6 packages (release)
│   ├── version-bump.sh         # Version bump
│   ├── changelog.sh            # CHANGELOG generation (for CI release)
│   ├── wait-npm-version.sh     # Waiting for a version to appear in npm (release)
│   ├── docker-cleanup.mjs      # Cleaning up Docker tags before publishing
│   └── micro-benchmark.mjs     # Micro-layer benchmark (ADR-035)
└── tmp/                        # Logs (do not commit)
```

## Code standards

- **Language:** TypeScript (strict mode)
- **Linter:** ESLint — `pnpm lint`
- **Formatter:** Prettier (config `.prettierrc`; there is no separate `pnpm format` script)
- **Build:** tsup / TypeScript — `pnpm build`
- **Tests:** Vitest — `pnpm test`

Documentation is maintained in Russian.
