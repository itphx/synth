# Hybrid mode (HYBRID)

> 🌐 **English** · [Russian](../HYBRID.md)

> [!NOTE]
> A user how-to on hybrid mode is available in the documentation portal:
> https://docs.synth.itphx.ru/deploy/hybrid/.

> Requirements and implementation status. Date: 2026-08-31.
> Status: implemented and merged into the main branch (T1–T10 ✅), integration tests (T11) — in progress.

> **Update (2026-09-07): lightweight runtime entry, shared data directory, resilience.**
> Implemented (merged into the main branch).
>
> - **Entry is always lightweight (runtime).** The "double login" (login → restart → another
>   login) is gone: POST /auth/login connects the process on the fly — without a restart
>   or a page reload. The active server is switched at runtime
>   (connectRemote/reconnect); no restart is needed.
> - **Shared data directory.** Local data (sessions/projects/providers/models/
>   workspace) lives in the SINGLE dataDir of the process and does NOT depend on the server. Per-profile
>   directories `{baseDataDir}/profiles/{id}` and credential migration into the profile are removed.
> - **Profiles = a meta-registry for UX.** `~/.config/synth/profiles.json` (0600,
>   atomic) stores only `{id, url, label, lastUsedAt, username}`: known
>   servers (knownServers), the last used one (lastServer), pre-filling of the login
>   form. Credentials — a single multi-server file
>   `~/.config/synth/credentials.json` (`Record<backendUrl, RemoteCredentials>`).
>   Module: `packages/core/src/profiles.ts`.
> - **Address at startup.** `serve --connect <url>` → the address from the flag; without `--connect`
>   the lastProfile from the registry is substituted (silent auto-login after listen);
>   `--no-auto-profile` — a neutral startup (the address is entered in the UI login form).
> - **ConnectionWatcher.** A background watcher
>   (`packages/core/src/server/connection-watcher.ts`) every ~15 s checks
>   backend availability (`/health`) and token validity (`/auth/status`);
>   `/hybrid/status.connected` now reflects the REAL availability (previously — merely
>   the presence of a session). When the server goes down, connected=false (UI offline
>   banner); when it comes back — auto-connect via saved credentials (no more than once
>   per 30 s); with an invalid token — session recreation (refresh). It starts after listen
>   and stops on graceful shutdown.
> - **Login form (UI).** The "Server URL" field in hybrid mode is shown ALWAYS
>   (the address is editable — with a stale token you can switch servers);
>   it is pre-filled with lastServer (then backendUrl); the options are a datalist from
>   knownServers. "Logout" = runtime disconnect + deletion of the active server's
>   credentials + best-effort revoke of the refresh token on Keycloak + cookie cleanup;
>   the meta-profile is NOT deleted.
> - **hybrid.sh.** The local API key is no longer printed in the summary (the
>   `--print-api-key` option); the restart loop on exit code 77 and `SYNTH_RESTARTABLE`
>   are removed — serve starts once.

> **Update (2026-09-04).** The final layer of "login without the Keycloak ritual":
>
> - **Runtime connection.** Hybrid mode switched to `RemoteConnection`: the server
>   (`serve --connect`) starts "cold" and does NOT block startup with a device flow.
>   After listen it silently performs auto-login using saved credentials
>   (`connectFromSaved`) or `--token`; if there are no credentials, the user
>   signs in directly in the UI.
> - **Single identity.** UI login — ROPC "behind the scenes" (login/password): the server
>   identity (username + roles + profile) comes from the server and becomes the local
>   core session. The "Server URL" field (address) is always shown in hybrid mode —
>   with a stale token you can change the address (see "Update (2026-09-07)").
> - **OIDC discovery.** The local core learns issuer/client_id from the server
>   (`GET {server}/auth/oidc-meta`) with a fallback to `--oidc-issuer`/`--oidc-client-id`.
>   The endpoint has been rolled out to the production K3s (`synth-backend`); discovery
>   works without the fallback.
> - **No device flow in the user path.** The "Sign in via browser" button and
>   the modal are removed from the UI; the endpoints `/auth/device-start`, `/auth/device-check` and
>   the CLI `synth connect` remain for backward compatibility/automation, but are not
>   called from the UI.

## Goal

The user runs Synth **locally** (`synth serve`), and the local copy
**connects to a server** (the backend in K3s at `synth.k3s.itphx.loc`).
In hybrid mode **both local and remote projects/sessions** are available.
All requests to the LLM are **centralized** — they go through the server (keys, models,
audit — only on the server).

## Decisions made (2026-08-31)

| # | Question | Decision |
|---|--------|---------|
| 1 | Execution of remote sessions | **Model A**: remote sessions are executed by the server; the local core is a thin client (proxies the API and events) |
| 2 | LLM for local sessions | **LLM Proxy on the backend**: local sessions in hybrid mode also go to the LLM through the server |
| 3 | Authentication | **OIDC** (Keycloak): user login — login/password (ROPC "behind the scenes"); the device flow is kept as a technical fallback |
| 4 | Visibility of the worlds | The local world is **personal**; operations to provide for: **publish** a local project → server and **fork** a remote project → locally |
| 5 | UI entry point | **Local UI only** (a browser on localhost that aggregates both worlds) |

## Architecture (Model A)

```
User machine                                  Server (K3s)
┌──────────────────────────────┐   HTTPS      ┌───────────────────────────────────┐
│  Browser → localhost UI      │              │  synth-backend (:5000)            │
│  └─ @itphx/synth-ui (SPA)    │              │  ├─ OIDC (Keycloak) / device      │
│       │ WS/SSE               │              │  ├─ RBAC (ADMIN/USER/...)         │
│  synth-core (serve :4300)    │  ──────────► │  ├─ ChatOrchestrator (engine)     │
│  ├─ local world              │  /api/v2/*   │  │   └─ remote sessions           │
│  │   ├─ sessions/projects    │  (remote     │  ├─ LLM Proxy (/api/v2/llm)       │
│  │   ├─ local files          │   client)    │  │   └─ gateway (ADR-036)         │
│  │   └─ local ollama?        │              │  ├─ central providers             │
│  │                           │  ◄────────── │  │   (keys on the server)         │
│  ├─ RemoteBackendClient      │  SSE         │  ├─ events /api/v2/events         │
│  │   └─ /api/v2/* + /ws      │  /ws/events  │  └─ sessions/projects/files (PVC) │
│  └─ RemoteEventBridge        │              │                                   │
└──────────────────────────────┘              └───────────────────────────────────┘
```

Principles:

- **The local core is a single entry point** for the local UI: it aggregates
  the local and remote worlds and routes requests by the origin of the session/project.
- **Remote sessions are executed by the server**: for them the local core is a thin
  client (create/read/prompt/events/files/git — via the server's `/api/v2/*`).
- **Local sessions are executed locally**, but their LLM requests go through
  the **LLM Proxy** on the server → centralized audit (ADR-036) and access to
  corporate models/keys without leaking them to the user's machine.
- **Entity identification**: the namespace `local:` / `remote:` (or the field
  `origin`) to rule out UUID collisions between the worlds.

## Key flows

### 1. Connection (ROPC; device flow — technical fallback)

```
synth serve --connect https://synth.k3s.itphx.loc
  → UI: sign in with login/password
  → local core calls POST /auth/login (ROPC "behind the scenes", Keycloak)
  → the server identity becomes the local core session
  → local core saves the tokens to ~/.config/synth/credentials.json (600)
```

- Credentials: access_token + refresh_token, auto-refresh.
- Commands: `synth connect`, `synth disconnect`, status in the UI.
- The endpoints `/auth/device-start`, `/auth/device-check` and the CLI `synth connect` are kept
  for backward compatibility/automation, but the device flow is not called from the UI.

> **Note (2026-09-07).** The user path is signing in to the UI with login/password
> (ROPC "behind the scenes"); the device flow is removed from the UI. Entry is always
> lightweight (runtime): the address is set by `--connect` or taken from the lastProfile in
> the registry at startup (silent auto-login after listen); or the process starts neutrally
> (`--no-auto-profile`), and the address is entered in the login form — the process connects
> to that server on the fly, without a restart. Local data is a single dataDir (it does not
> depend on the server); switching servers — via "Logout" → signing in to another address in
> the same form.

### 2. Aggregation of the worlds

- `GET /api/v2/projects` (local core) → local + remote projects
  (via RemoteBackendClient), with the `origin: local|remote` field.
- `GET /api/v2/sessions` → likewise. The `origin` filter.
- Operations on remote entities are proxied to the server; mutations require
  confirmation in the UI (deletion, project switching).

### 3. LLM centralization

- Remote sessions: the LLM is called by the server engine (already the case).
- Local sessions: the local core's `ProviderPool` gets a provider of type
  `remote`, which sends the request to `POST /api/v2/llm/chat/completions` on the server;
  the server runs it through the gateway (ADR-036: audit, obfuscation, rate limit) and
  the real provider.
- Policy: **in hybrid mode local providers are forbidden entirely** — all
  LLM requests go only through the server (centralized keys/models).

### 4. Events

- RemoteEventBridge: the local EventHub subscribes to the server's SSE `/api/v2/events`
  and translates remote session events into the local WS/SSE for the UI.
- Streaming of remote session answers is proxied from the server.

### 5. Publish (local project → server)

```
synth project publish <local-id> --remote
  → create/update the project on the server
  → (optionally) upload workspace files
  → transfer sessions? (decided separately)
```

### 6. Fork (remote project → local)

```
synth project fork <remote-id> --local
  → clone the project from the server into the local world
  → (optionally) clone the git repository, download the workspace
```

## Current state (what already exists)

- The backend in K3s = a full-fledged in-process engine (ChatOrchestrator, sessions,
  projects, files, git, SSE `/api/v2/events`), central providers, OIDC+RBAC.
- Backend API v2: sessions, projects, messages, queue, fs, git, providers,
  models, agents, mcp, audit, logs, settings. **No exec/shell endpoint.**
- Core standalone: the full engine + UI; local auth (API key).
- Shared zod contracts in `@itphx/synth-shared` (core and backend — one contract).
- UI: TransportClient (WS→SSE fallback), GlobalTransportIndicator.

## Scope of work (gaps → tasks)

### P1 — hybrid foundation
1. **Config** — the `remote` section in `synthConfigSchema`
   (`packages/shared/src/config/types.ts`):
   `{ enabled, backendUrl, auth: { type: 'device', ... }, llm: 'server'|'local'|'auto', worlds: { local, remote } }`.
2. **CLI** — `synth serve --connect <url>` (+ `synth connect|disconnect`) in
   the `@itphx/synth` wrapper; connection status.
3. **OIDC device flow** — a client in core (`remote/device-flow.ts`), credential
   storage, token refresh.
4. **RemoteBackendClient** — an HTTP client to the server's `/api/v2/*`
   (`packages/core/src/remote/client.ts`): auth, timeouts, retries, "server
   unavailable" errors, shared zod schemas.
5. **Aggregation** — merged lists of projects/sessions with `origin`,
   routing requests by world, collision namespace.
6. **UI** — "local/remote" badges, connection indicator,
   confirmation of remote mutations.

### P2 — LLM centralization
7. **LLM Proxy endpoint** on the backend (`/api/v2/llm/chat/completions`, OpenAI-compatible):
   accepts requests, runs them through the gateway (ADR-036), calls the provider.
8. **The `remote` provider** in the core's `ProviderPool`/`ProviderFactory` — the local
   engine uses the server as the LLM source.
9. **Provider policy** in hybrid mode — forbidding all local providers,
   LLM only through the server.

### P3 — events and entities
10. **RemoteEventBridge** — server SSE → local EventHub → UI; proxying of
    answer streaming.
11. **Publish / Fork** — operations to transfer projects between the worlds.
12. **Offline degradation** — server unavailability: remote sessions are inactive,
    local ones work, status in the UI.

### P4 — documentation and tests
13. **Documentation** — README, ARCHITECTURE.md, AGENTS.md; returning SPEC/plan
    to `synth/` with a hybrid section.
14. **Integration tests** — local core + a running backend: a remote
    session, a local session with the LLM through the server, events, offline.

## Implementation status (2026-08-31)

Hybrid mode is implemented and merged into the main branch.

| Part | Status | What was done |
|---|---|---|
| T1 — config + remote client + device flow | ✅ | `remoteConfigSchema`, `RemoteBackendClient`, `DeviceFlowClient`, credentials store (0600, atomic) |
| T2 — CLI | ✅ | `synth serve --connect`, `synth connect|disconnect`, `--oidc-issuer/--oidc-client-id/--token`, `RemoteSession.getToken()` (auto-refresh) |
| T3 — aggregation of the worlds | ✅ | `origin` in DTOs, `remote:<id>` namespace, list merging, routing by world, forwarding of prompt/fs/messages/queue |
| T4 — UI | ✅ | `OriginBadge`, `HybridStatusIndicator` (30 s polling), confirmation of remote mutations, "create where" selector, status endpoint `/api/v2/hybrid/status` |
| T5 — LLM Proxy | ✅ | `POST /api/v2/llm/chat/completions` (OpenAI-compatible, stream/non-stream), Gateway ADR-036, audit, rate limit |
| T6 — RemoteProvider | ✅ | `RemoteProvider` in core, injection of `synth-remote` in-memory, policy forbidding local providers (`remote.llm=server`), model merging |
| T7 — RemoteEventBridge | ✅ | `EventBus.subscribeAll`, SSE bridge backend → local EventBus → UI, reconnect with backoff, id rewriting to `remote:<id>` |
| T8 — publish/fork | ✅ | `synth project publish/fork`, backend session export/import, direct file synchronization (walk + fsWrite/fsUpload/fsDownload), e2e confirmed |
| T9 — offline degradation | ✅ | Lists degrade (local world + warn), explicit remote operations → 502 OFFLINE (remoteErrorToHttp), `getToken()` does not crash the stream on a refresh error, UI: "server unavailable" banner, "create where" selector → only "Local", remote entities dimmed (opacity + tooltip), indicator red |
| T10 — documentation | ✅ | README.md, ARCHITECTURE.md, AGENTS.md, CONFIGURATION.md — hybrid mode described as an implemented scenario |
| T11 — integration tests | ⏳ | Unit/route tests exist for every part; a dedicated "core+backend" integration scenario remains |

> **Update (2026-09-07).** Lightweight runtime entry with a shared data directory
> (`--no-auto-profile` — neutral startup), a meta-registry of server profiles for UX,
> ConnectionWatcher and a permanent "Server URL" field in the login form — implemented
> (2026-09-07, merged into the main branch). The table above describes the base layer
> and remains valid.

## Open questions → resolved (2026-08-31)

| # | Question | Decision |
|---|--------|---------|
| 1 | Which local providers are allowed in hybrid mode (local ollama — yes/no)? | **No local providers.** Only centralized ones (through the server) |
| 2 | Are sessions transferred on publish/fork (or only the project + files)? | **They are transferred** (project + files + sessions) |
| 3 | The mechanics of uploading/downloading workspace files on publish/fork | **Direct file synchronization** (not git) |
| 4 | Is an exec/shell API on the backend needed for remote sessions | **Not required** (Model A: the server executes in-process itself) |
