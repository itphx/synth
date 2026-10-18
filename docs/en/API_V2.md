# API v2 — reference

> 🌐 **English** · [Russian](../API_V2.md)

> ⚠️ RU-версия обновлена 2026-10-18 (PROP-102, §5.32 «Аналитика и отчётность»); перевод отстаёт.

> The canonical source of truth for the Synth HTTP/WS contract, assembled **from the code**
> (ADR-017). General conventions (style, ports, process, storage) — in the root `AGENTS.md`.

## Base URLs

| Build | Base URL | Authentication |
|---|---|---|
| `@itphx/synth-backend` (managed, API Hub) | `http://localhost:5000` → API `http://localhost:5000/api/v2` | OIDC cookie/JWT, API key, debug keys |
| `@itphx/synth-core` (standalone, `synth serve`) | `http://localhost:4300` → API `http://localhost:4300/api/v2` | a single API key (`--api-key`/`SYNTH_API_KEY`) |

Ports: backend — `SYNTH_PORT` (5000), core — `SYNTH_CORE_PORT` (4300). Auth routes
live under `/auth/*` (without the `/api/v2` prefix), health — under `/health` and `/api/v2/health`.

**Build availability** in the tables below: `backend` — managed hub only,
`core` — standalone only, `both` — both builds. Core has a narrower set: no
`context/users/audit/logs/gateway/llm/i18n/admin`, but it does have `auth/*`,
`hybrid/status`, as well as `/git` and `/ssh-keys` (ADR-076; core factories,
mounted in backend with RBAC). In hybrid mode, `/git`, flat `/ssh-keys`
and nested `/agents/:agentId/ssh-keys` are proxied to backend (the remaining `/agents` subpaths are local).

---

## 1. Authentication and RBAC

### Methods (backend, check priority)

1. **Service key (ADR-052, stage I)** — `Authorization: Bearer synth_svc_…`
   (machine access). Recognized by the secret prefix; resolved into a
   synthetic user `{ id: 'service:<keyId>', roles: key.roles }`
   plus the context `{ scopes, allowedProjects?, rateLimitPerMinute? }`. A key
   that is revoked (`revokedAt`) or expired (`expiresAt`), and an unknown secret →
   `401 UNAUTHORIZED`. Management — §5.28.
2. **`user_session` cookie** — server-side session in process memory
   (`Map<sessionId, {user, expiresAt}>`, TTL `auth.sessionMaxAgeMinutes`).
   Set by `POST /auth/spa-login` / the OIDC callback. The cookie is `httpOnly`,
   `sameSite=Lax`.
3. **Debug keys** — when `SYNTH_AUTH_DEBUG=true` (`config.auth.debugMode`):
   `Authorization: Bearer <apiKey>` from `config.auth.testUsers`. The user
   gets roles and `isTestUser=true`.
4. **OIDC JWT** — when `config.oidc.enabled`: `Authorization: Bearer <jwt>`,
   verified through a lazy OIDC client.
5. **API key** — when `!debugMode && !oidc.enabled && config.apiKey`:
   `Authorization: Bearer <SYNTH_API_KEY>` → user `api` with the `ADMIN` role.

Roles: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

**Service key: scopes and project projection (ADR-052).** The key roles make it compatible
with `requirePermission` (RBAC endpoints), while `scopes` are a fine-grained gate on top: if the
context carries a service key, the route requires at least one of its scopes (otherwise
`403 SCOPE_REQUIRED`). For interactive credentials (cookie/debug/OIDC/API key/local
key) the scope gate is a no-op (the request passes through). Scope catalog: `events:ingest`,
`events:watch`, `bindings:read|write`, `keys:read|write`, `routes:read|write`,
`sessions:create|read|prompt`, `schedules:read|write`, `llm:chat`, `addons:install`,
`users:read` + wildcard families
`events:*`, `bindings:*`, `keys:*`, `routes:*`, `sessions:*`, `schedules:*`
(there is no global `*`). Separately: on some routes (writing the MCP registry, writing
skills, reading the admin user API) a scope works as an alternative to the ADMIN role
(“ADMIN **or** scope”, see §5.14/§5.16/§5.17). Project projection `allowedProjects`: if the key has a
non-empty list, only the projects in it are accessible — it applies to sessions,
events/bindings and schedules (otherwise `403 PROJECT_FORBIDDEN`); empty/absent —
the instance policy. The per-route scope application points — in §5.5, §5.26, §5.27, §5.23.

Debug users (`SYNTH_AUTH_DEBUG=true`):

| User | Key | Roles |
|---|---|---|
| admin | `admin-key-123` | ADMIN |
| developer | `user-key-456` | USER |
| lead | `lead-key-789` | LEAD |
| auditor | `auditor-key-012` | AUDITOR |

### Middleware (`packages/backend/src/auth/middleware.ts`)

| Function | Semantics |
|---|---|
| `getCurrentUser(c)` | Tries to determine the user from cookie/debug/JWT/API key; returns `User \| null` without an error. |
| `attachUser` | Global middleware `app.use('*', ...)`: puts the user into `c.set('user', ...)` if it exists and always calls `next()`. |
| `requireAuth` | No user → `401 {error:{code:'UNAUTHORIZED'}}`; otherwise puts them into the context and calls `next()`. |
| `requireAdmin` | No user → `401 UNAUTHORIZED`; user present but no `ADMIN` role → `403 {error:{code:'FORBIDDEN'}}`. |
| `requirePermission(...roles)` | No user → `401 UNAUTHORIZED`; user present but holds none of the listed roles → `403 FORBIDDEN`. Used by `audit`, `logs` (`ADMIN`,`AUDITOR`), `sessions/:id/secrets` (`ADMIN`,`AUDITOR`), service-keys (`ADMIN`), webhooks (`ADMIN`), maintenance (`ADMIN`), events bindings/routes/keys (`ADMIN`,`LEAD`). |

> **401/403 rule (semantics):** no authentication → `401 UNAUTHORIZED`; authenticated but lacking the role/rights → `403 FORBIDDEN`; a service key missing the required scope → `403 SCOPE_REQUIRED` (this is about scope, not authentication).

Separate from `middleware.ts` — **service key scope gates** (`packages/backend/src/auth/service-scope.ts`:
`scopeGuard`/`serviceProjectProjection`, they delegate to the core `requireScope`/`checkServiceProjectProjection` and return
localized `403 SCOPE_REQUIRED`/`PROJECT_FORBIDDEN`; outside a service key — no-op; this is the service key's
project projection, **not** RBAC).

### Standalone core (`packages/core/src/auth/local.ts`)

| Mechanism | Description |
|---|---|
| `Authorization: Bearer <apiKey>` | Matches `config.apiKey` → user `local` (role `ADMIN`). |
| `Authorization: Bearer synth_svc_…` | Service key (ADR-052): the key's synthetic user + `scopes`/`allowedProjects` in the context; revoked/expired/unknown → `401`. |
| `synth_session` cookie | An HMAC-signed API key (v1) or JSON `{v:2, kind:'local'\|'server', user}` (v2, hybrid identity). |
| `requireAuth` | The only global guard; there are no role-based `403`/`ADMIN` checks in standalone (the `requireScope`/`checkServiceProjectProjection` scope gates work only for a service key). The local **session access prefix-guard** (`server/session-access-guard.ts`) is mounted here too: in single-user mode all sessions belong to `local`/have no owner (access granted), a foreign owner → `403`, a missing session → `404`. |

In standalone, `requireAuth` is attached globally to `/api/*`, so all `/api/v2/*`
endpoints (except health and `hybrid/status`) require a key. The hybrid login
(`/auth/login`, `/auth/device-*`) sets a v2 cookie with the server identity.

### Rate limiting (backend only)

In-memory `createRateLimiter(maxRequests, windowMs)`, the key — `Authorization`/`x-forwarded-for`.
On exceeding — `429 {error:{code:'RATE_LIMITED'}}`.

| Endpoint | Limit |
|---|---|
| `POST /api/v2/llm/chat/completions` | 120 / 60 s |
| `POST /api/v2/sessions/:id/prompt` | 30 / 60 s |
| `POST /auth/spa-login` | 5 / 60 s |
| `POST /api/v2/providers/:name/test` | 5 / 60 s |
| `POST /api/v2/providers/fetch-icon` | 10 / 60 s |
| `POST /api/v2/models/fetch` | 3 / 120 s |

---

## 2. Error format

The main format (all routes, `notFound`, middleware):

```json
{ "error": { "code": "NOT_FOUND", "message": "Session not found" } }
```

The exception — file operations and git routes (shared core factories, ADR-075/ADR-076):
they return the `FsError` format `{ "error": { "error": "<message>", "code": "<FsErrorCode>" } }`
(`packages/core/src/server/routes/fs.ts`, `packages/core/src/server/routes/git.ts`);
backend and standalone mount the same factory.

Actual codes (from the code):

| Code | Where |
|---|---|
| `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_REQUEST` | validation of bodies/parameters |
| `UNAUTHORIZED` | No authentication (`requireAuth`, `requireAdmin`, `requirePermission`, `requireAdminOrScope`), auth routes, an invalid/revoked/expired service key (ADR-052) |
| `FORBIDDEN` | Authenticated but lacking the role/rights (`requireAdmin`/`requirePermission`/`requireAdminOrScope`), filesystem |
| `SCOPE_REQUIRED` | service key without the required scope (ADR-052; service key only) |
| `PROJECT_FORBIDDEN` | service key with `allowedProjects` and no access to the project (ADR-052) |
| `NOT_FOUND` | a missing session/project/provider/model/agent/file/log |
| `CONFLICT` | MCP server duplicates, retry state |
| `ALREADY_EXISTS`, `IS_DIRECTORY`, `DIR_NOT_EMPTY`, `PATH_TRAVERSAL`, `PERMISSION_DENIED` | filesystem |
| `WORKSPACE_OUTSIDE_ROOT_DENIED`, `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`, `WORKSPACE_CREATE_FAILED`, `WORKSPACE_POLICY_READ_ONLY`, `WORKSPACE_ROOT_NOT_CONFIGURED`, `PROTECTED_PATH_DENIED`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_SET`, `NOT_A_DIRECTORY` | workspace/filesystem (ADR-075) |
| `git.ssh_key_required`, `git.repo_path_invalid`, `git.repo_exists` | git registry (ADR-076, shared form) |
| `sshkey.not_found`, `sshkey.name_exists`, `sshkey.decrypt_failed`, `sshkey.encryption_unavailable`, `sshkey.env_failed` | agent SSH keys (ADR-076) |
| `PROJECT_NOT_FOUND`, `NOT_AVAILABLE` | sessions/settings |
| `RATE_LIMITED`, `QUEUE_FULL` | rate limits and the queue |
| `INVALID_ACTION`, `INVALID_INDICES` | message batch operations |
| `MODEL_NOT_FOUND`, `MODEL_DISABLED`, `MODEL_MISMATCH`, `PROVIDER_NOT_FOUND`, `PROVIDER_DISABLED`, `PROVIDER_ERROR`, `PROVIDER_CONFIG_ERROR`, `CONTEXT_LENGTH_EXCEEDED` | LLM Proxy |
| `MCP_CONNECT_ERROR` | MCP probe |
| `OFFLINE`, `AUTH_ERROR`, `REMOTE_UNAVAILABLE` | hybrid/remote |
| `UPDATE_CHECK_FAILED` | update check |
| `INTERNAL_ERROR` | other 500s |

Codes specific to subagent resume (`SubagentResumeError`): `NOT_FOUND`,
`NO_PARENT`, `LOCKED`, `PARENT_NOT_FOUND`, `AGENT_NOT_FOUND` (statuses 400/404/409).

---

## 3. Event transport

The single channel — **WS `/ws/events`** (EventHub/EventBus, ADR-008/ADR-009/ADR-024);
the fallback — **SSE `GET /api/v2/events`**. The event format — `BusEvent`:

```ts
interface BusEvent { type: EventType; sessionId: string; data: Record<string, unknown>; timestamp: string }
```

- Backend: WS authentication via Bearer JWT/API key or the `user_session` cookie;
  on connect it sends `{type:'connected', client_id}`.
  It supports the client messages `ping`→`pong`, `send_message`, `cancel`,
  `permission_reply`, `permission_hold`. EventHub automatically subscribes
  the client to all of the user's sessions.
- Core standalone: the same WS `/ws/events` and SSE `/api/v2/events`;
  additionally there is a session SSE `GET /api/v2/sessions/:id/events`.
- Both send the keepalive comment `:keepalive` every 30 s.

> Event transport — only WS `/ws/events` and SSE `GET /api/v2/events`.
> Do not create new channels (ADR-008/009/024).

---

## 4. LLM Proxy

`POST /api/v2/llm/chat/completions` (backend, `requireAuth`) — the only
LLM proxying point in the managed hub (OpenAI-compatible format). Every
LLM call goes through `GatewayProvider` (guard, obfuscation, rate limit, audit,
ADR-036); do not call the provider directly.

For a service key (ADR-052) the `llm:chat` scope is required (the project projection does not
restrict this route — the proxy has no project dimension); there are no project gates.

Body (an OpenAI subset): `model`, `messages[]`, `temperature`, `max_tokens`,
`top_p`, `stream`, `tools[]`, `session_id`, `provider`. The response — `chat.completion`
(or SSE chunks `chat.completion.chunk` when `stream:true`, terminated by `data: [DONE]`).
Errors: `404 MODEL_NOT_FOUND`, `400 MODEL_DISABLED|MODEL_MISMATCH`, `502 PROVIDER_NOT_FOUND|PROVIDER_CONFIG_ERROR|PROVIDER_ERROR`, `429 RATE_LIMITED`, `400 CONTEXT_LENGTH_EXCEEDED`.

---

## 5. Endpoints by group

RBAC column: `—` — no auth, `auth` — any authenticated user,
`ADMIN` — the ADMIN role only, `ADMIN/AUDITOR` — either role.
In core the `ADMIN` column degenerates to `auth` (there are no role checks).

### 5.1 Health — `both`

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/health` | — | `{status:'healthy', version, time, startedAt}` (`startedAt` — the ISO process start timestamp, ADR-092) |
| GET | `/api/v2/health` | — | same (+ a `storage` block when degraded) |

### 5.2 Hybrid — `core`

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/hybrid/status` | — | Hybrid state: `enabled`, `connected`, `backendUrl`, `user`, `knownServers`, `lastServer` |

### 5.3 Auth — `/auth/*`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| GET | `/auth/login` | backend | — | Redirect to OIDC authorize |
| POST | `/auth/login` | backend | — | ROPC login (OIDC), sets a cookie |
| GET | `/auth/callback` | backend | — | OIDC callback, cookie |
| GET | `/auth/status` | both | — | `{authenticated, debug_mode, oidc_enabled, deployment, user}` |
| GET | `/auth/oidc-meta` | backend | — | Public OIDC issuer/clientId (without the secret) |
| GET | `/auth/session` | both | — | Cookie session check |
| GET | `/auth/me` | both | — | Current user |
| POST | `/auth/spa-login` | both | — | JSON `{api_key}` → cookie session |
| POST | `/auth/login` | core | — | ROPC login in hybrid mode `{server?, username, password}` |
| POST | `/auth/device-start` | core | — | OIDC device flow: `verification_uri`, `user_code` |
| POST | `/auth/device-check` | core | — | Device flow status |
| POST | `/auth/logout` | both | — | Cookie reset (`204`); in core — revoke+disconnect |
| GET | `/auth/profile` | both | auth | Profile (in hybrid mode it is proxied to backend) |
| PUT | `/auth/profile` | both | auth | Update the profile |
| PATCH | `/auth/profile/preferences` | backend | auth | Merge preferences |
| DELETE | `/auth/profile/preferences` | backend | auth | Reset preferences |
| GET | `/auth/profile/avatar` | backend | auth | PNG avatar (`404` if absent) |
| POST | `/auth/profile/avatar` | backend | auth | Upload/delete the avatar (binary) |
| GET | `/auth/locales` | backend | — | List of locales (`ru`,`en`) |
| GET | `/auth/users` | backend | debug | Test users (debug only) |
| GET | `/auth/defaults` | backend | — | UI appearance defaults |
| PUT | `/auth/defaults` | backend | ADMIN | Save the defaults |

### 5.4 Miscellaneous

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| GET | `/api/config/themes` | both | — | Stub `{themes:[]}` |
| GET | `/api/v2/i18n/current` | backend | — | Current language by `Accept-Language` |
| GET | `/api/v2/i18n/translations/ru` | backend | — | Russian dictionary |
| GET | `/api/v2/i18n/translations/en` | backend | — | English dictionary |
| GET | `/api/v2/openapi.json` | both | auth | The public OpenAPI 3.1 spec of the integration core (ADR-052, stage III; `server/openapi/public-openapi.ts`): 28 operations (events/sessions/schedules/llm), named `components.schemas`, a unified error format `publicErrorSchema` (`{error:{code,message}}`) |

### 5.5 Sessions — `/api/v2/sessions`

| Method | Path | Build | RBAC | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/sessions` | both | auth (own+project; LEAD/ADMIN — all) | Session list; `?project_id=` (see the visibility rules below) |
| POST | `/api/v2/sessions` | both | auth | Create; `{name|title, project_id, settings}` → 201 || GET | `/api/v2/sessions/:id` | both | auth | Session (serialized) |
| GET | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Effective MCP scope (ADR-071 §2.4): `{servers:[{name, level, enabled, reason?, connected?, origin, trust, chars?, estTokens?, estimated?}], enabled, disabled, mcpServers, mcpDisabledServers}`. `reason` ∈ `system_disabled\|project_disabled\|session_optout\|not_default`; the project `enabled` gate also applies to system servers. Servers/tools carry `chars`/`estTokens` (ADR-071 §2.8) |
| PUT | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Toggle MCP (a single switch): `{name, enabled}` → `mcpServers`/`mcpDisabledServers` (opt-out of system ones — via `enabled:false`), or `{mcpServers?, mcpDisabledServers?}` |
| PATCH | `/api/v2/sessions/:id` | both | auth | `{name, title, mode: plan\|act\|yolo, settings, project_id}` |
| DELETE | `/api/v2/sessions/:id` | both | auth | Delete → 204 |
| GET | `/api/v2/sessions/:id/secrets` | backend | ADMIN/AUDITOR | Gateway obfuscation map `{sessionId, secrets}` |
| POST | `/api/v2/sessions/:id/fork` | both | auth | Fork; `{message_id?, message_index?, title?}` → 201 |
| GET | `/api/v2/sessions/:id/children` | both | auth | Child sessions |
| GET | `/api/v2/sessions/:id/tree` | both | auth | Session tree |
| GET | `/api/v2/sessions/:id/export` | backend | auth | Full Session export (internal format) |
| POST | `/api/v2/sessions/import` | backend | auth | Import a session from an export → 201 |
| GET | `/api/v2/sessions/:id/status` | both | auth | `{blocked, pending_count, processor_running}` |
| POST | `/api/v2/sessions/:id/prompt` | both | auth | Enqueue a message, return an **SSE stream** |
| GET | `/api/v2/sessions/:id/prompt` | both | auth | System prompt composition (ADR-070): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (tools with `chars`/`estTokens` and the estimation flag, ADR-071 §2.8). `manifest.toolsPolicy`/`manifest.mcpPolicy` — the applied built-in/MCP policies (ADR-071 §2.3); entries: `tools` (stable/context) → `mcp.servers`/`mcp.tools`/`mcp.status` (volatile, not in `staticPrefixChars`) |
| GET | `/api/v2/sessions/:id/stats` | both | auth | Usage statistics (ADR-070): messages + recursive subagent usage (the `task` tool), aggregates per agent/user (`computeSessionStats`) |
| GET | `/api/v2/sessions/:id/messages` | both | auth | `{messages, session_id}` |
| POST | `/api/v2/sessions/:id/clear` | both | auth | Clear the history (except pinned) |
| POST | `/api/v2/sessions/:id/abort` | both | auth | Reliable Stop (ADR-005): sets the persistent `status.cancel_requested` flag; with a live stream — a graceful cancel, then stops the queue processor; `{status:'aborted'}`; 404 if there is no session (see below) |
| POST | `/api/v2/sessions/:id/resume-subagent` | both | auth | Resume a subagent → 202 |
| POST | `/api/v2/sessions/:id/summarize` | both | auth | Request summarization `{status:'enqueued', stream_id}` |
| GET | `/api/v2/sessions/:id/events` | core | auth | Session SSE stream |
| POST | `/api/v2/sessions/:id/debug-system-message` | backend | auth | Debug system message |
| GET | `/api/v2/sessions/:id/optimization` | backend | auth | Context optimization settings |
| PATCH | `/api/v2/sessions/:id/optimization` | backend | auth | Update the optimization settings |
| POST | `/api/v2/sessions/:id/optimization/check` | backend | auth | Check the window/summarization triggers |
| POST | `/api/v2/sessions/:id/optimization/cancel-summarization` | backend | auth | Cancel the summarization wait |
| GET | `/api/v2/sessions/:id/references` | both | auth | References `{references}` |
| POST | `/api/v2/sessions/:id/references` | both | auth | Add a reference → 201 |
| DELETE | `/api/v2/sessions/:id/references/:refSid` | both | auth | Delete a reference → 204 |
| POST | `/api/v2/sessions/:id/messages/merge` | both | auth | Merge messages from another session → 201 |
| GET | `/api/v2/sessions/:id/notes` | backend | auth | Sticky notes `{notes}` |
| POST | `/api/v2/sessions/:id/notes` | backend | auth | Create a note → 201 |
| PATCH | `/api/v2/sessions/:id/notes/:noteId` | backend | auth | Update a note |
| DELETE | `/api/v2/sessions/:id/notes/:noteId` | backend | auth | Delete a note |

> `SessionSettings` for MCP/skills (ADR-071 §2.4 / ADR-046): `mcpServers`/`mcpDisabledServers`, `skills`/`skillsDisabled` — session overrides (a single switch); `mcpDefaultOn`/`skillsDefaultOn` — a **snapshot** of the defaults (`project.defaultOn`/the system default) at session creation time, set by the system, not overwritten by a change of the project default; `undefined` — legacy mode (see the scope endpoints in §5.17.2).
> **Visibility of `GET /api/v2/sessions` (ADR-089).** `ADMIN`/`LEAD` — **all** sessions; otherwise — own personal ones **plus** sessions of projects the user is a member of (the project `owner` or any `members`, any role). A session **without an owner** is visible (parity with access by id). Personal sessions of other users are not visible. `?project_id=` filters on top of this visibility.
> **Access by id — all `:id` routes of the resource (ADR-089).** A single prefix-guard `server/session-access-guard.ts` (mounted on `/:id` and `/:id/*` together with `requireAuth`; the access kind `read`/`write` is derived from the HTTP method), rule: `ADMIN`/`LEAD` — reading **and** mutating someone else's session are allowed (a deliberate product decision; pinned by the matrix `routes/session-idor-matrix.test.ts`); the session owner / a session without an owner — everything; a member of the session's project: **read** (`GET`/`HEAD`) — any role, including `VIEWER`, **mutation** — `OWNER`/`EDITOR` (`canEditProjectContent`); a foreign user → `403 FORBIDDEN`; a missing session → `404 NOT_FOUND`. Codes are consistent across the whole resource (for a foreign user any `:id` route returns `403`); explicit exceptions: `GET /:id/mcp` — owner|`ADMIN` (ADR-071 §2.4), `GET /:id/secrets` — `ADMIN`|`AUDITOR`. List helper — `server/session-visibility.ts` (`isSessionVisible`), scan — `FileStore.listForUserScope`.
> **Service-key scope (ADR-052):** `GET /` and `GET /:id` — `sessions:read`; `POST /` — `sessions:create`; `PATCH /:id`, `DELETE /:id`, `POST /:id/prompt` — `sessions:prompt`; `GET /:id/prompt|status|stats|messages` — `sessions:read`. With a non-empty `allowedProjects`, the project projection is checked against the session's `project_id`, otherwise `403 PROJECT_FORBIDDEN`.
> **Reliable Stop — `POST /api/v2/sessions/:id/abort` (ADR-005).** The route sets a **persistent** `SessionStatus.cancelRequested` flag (+ `cancelRequestedAt`) under the session lock — that is why the cancellation also fires when `currentStream`/the cancel token is not yet set (a session in the queue, in backoff, between Tool Use iterations), where the previous `orchestrator.cancel` was a no-op. With a live stream, a graceful `orchestrator.cancel` is additionally invoked (publishes `stream.cancelled`, keeps the partial response); then `QueueProcessorManager.requestStop` interrupts backoff/the active LLM call and ends the loop (`_handleStopRequest`: clearing `pendingMessages`, releasing `blocked`/the flag, `stream.cancelled` exactly once — without duplicating the graceful branch). If there is no processor, the flag is cleared so that the next run is not falsely cancelled. The response is `{status:'aborted'}`; without a session — 404. In a serialized session (`GET /api/v2/sessions/:id`) the `status` field contains `cancel_requested` (bool) and `cancel_requested_at` (ISO|null). The hybrid branch (a remote session) delegates to `remoteClient.abortSession`.

### 5.6 Messages — `/api/v2/messages`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| POST | `/api/v2/messages/:sessionId/batch` | both | auth | `{action: pin\|toggle\|delete, indices[], state?}` |
| PATCH | `/api/v2/messages/:sessionId/:index/toggle` | both | auth | Toggle `disabled` |
| PATCH | `/api/v2/messages/:sessionId/:index/pin` | both | auth | Toggle `pinned` |
| DELETE | `/api/v2/messages/:sessionId/:index` | both | auth | Delete a message |
| POST | `/api/v2/messages/:sessionId/:index/retry` | both | auth | Disable from index and return the text `{content}` |
| GET | `/api/v2/messages/:sessionId/:index/debug` | both | auth | Debug data for a message |

### 5.7 Queue — `/api/v2/queue`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| POST | `/api/v2/queue/:sessionId/clear` | both | auth | Clear the queue `{cleared:true}` |
| POST | `/api/v2/queue/:sessionId/return` | both | auth | Return texts `{texts}`; `?index=N` |
| POST | `/api/v2/queue/:sessionId/resume` | both | auth | Resume processing `{resumed, pending_count}` |
| POST | `/api/v2/queue/:sessionId/retry-now` | both | auth | Immediate retry during backoff |
| POST | `/api/v2/queue/:sessionId/cancel-retry` | both | auth | Cancel the retry attempts |

### 5.8 Projects — `/api/v2/projects`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/projects` | both | auth (owner/member; LEAD/ADMIN — all) | Project list: own/participating, `ADMIN`/`LEAD` — all |
| POST | `/api/v2/projects` | both | auth | Create `{name, workspace?, repos?, plan?}` → 201 |
| GET | `/api/v2/projects/:id` | both | auth / owner·member·LEAD·ADMIN | Project (read; VIEWER reads, does not edit) |
| PUT | `/api/v2/projects/:id` | both | auth / owner·EDITOR·LEAD·ADMIN | Update fields (name, description, current_task, invariants, icon, color, repos, plan); changing `workspace` — owner/LEAD/ADMIN |
| DELETE | `/api/v2/projects/:id` | both | auth / owner·LEAD·ADMIN | Delete → 204 |
| GET | `/api/v2/projects/:id/stats` | backend | auth | Token/message aggregates |
| GET | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Project MCP scope (ADR-071 §2.4): `{enabled, defaultOn, knownServers}`; `enabled[]` — hard gate (unavailable even in old sessions, including for system servers), `defaultOn[]` — the seed for new sessions |
| PUT | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Set `{enabled?, defaultOn?}` (references to the registry by name) |
| POST | `/api/v2/projects/:id/publish` | core | auth | Local project → server (hybrid) |
| POST | `/api/v2/projects/:id/fork-local` | core | auth | Server project → the local world (hybrid) |

> `workspace` (ADR-075): on `POST`/`PUT` the directory is created (`mkdir -p`). Managed: an empty `workspace` → the auto name
> `slugify(name)` + a suffix under `workspacesRoot`; an absolute path inside root is normalized to a relative one; outside root →
> `403 WORKSPACE_OUTSIDE_ROOT_DENIED`; changing `workspace` — owner/LEAD/ADMIN, otherwise `403 FORBIDDEN`.
> RBAC (backend, D5): `PUT` content (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `repos`, `plan`) — owner/EDITOR/LEAD/ADMIN; `workspace` — owner/LEAD/ADMIN; `DELETE` — owner/LEAD/ADMIN; otherwise `403 FORBIDDEN`.
> **Visibility of `GET /api/v2/projects` and `GET /api/v2/projects/:id` (ADR-089).** In the list, `ADMIN`/`LEAD` see **all** projects, the rest — only their own (`owner` or `members`). Reading a project by id — `owner`, **any member** (`members`, any role, including `VIEWER`), as well as `ADMIN`/`LEAD`; otherwise `403 FORBIDDEN`. This is a **read level**: it does **not** extend the modification rights — `manage` (`workspace`/`DELETE`/MCP scope) and content `edit` remain owner/EDITOR/LEAD/ADMIN, `VIEWER` reads but does not edit (see `canRead` vs `canManage`/`canEditContent`).
> Tool-level RBAC (core chat tools, ADR-075/D5): `project_log_write`/`project_invariants_write` write only for owner/EDITOR (otherwise `project.write_forbidden`); `plan_write` is not gated yet (TODO) — `project.plan` is protected by HTTP RBAC.
> In core there are no role checks (any authenticated user). Core/standalone:
> an absolute path outside root — `deny` → `403`, `confirm` without `confirmOutsideRoot` → `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`.
> Directory creation error → `422 WORKSPACE_CREATE_FAILED`.

### 5.8.1 Portable project export/import — `/api/v2/projects` (both, ADR-091 §6)

Moving a project between Synth instances: download a self-contained
`<name>.synth-project.tar.gz` archive and import it from the UI/API. A single factory,
`createProjectPortableRoutes`, serves core and backend; the work lives in the core
(`packages/core/src/projects/portable.ts`). The archive contains `manifest.json`
(sha256 entries), `project.json`, and `sessions/<id>.json`; optionally `workspace/**`.
**The archive contains no secrets** (keys, tokens, credentials, `secrets/` are not included).

Import is **materialization** (ADR-089, invariant 15): a **new** `projectId` and new
sessions are created (source id → new id in `idMap`), not via the `session.requested`
funnel. `mergeInto` imports sessions into an existing project. The core notifies the hub
(`onSessionCreated` → owner subscription, ADR-089 invariant 18). Operations are recorded
in the maintenance audit journal (`export.created`/`import.applied`, ADR-092).

| Method | Path | Build | RBAC (managed / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/projects/:id/export` | both | auth / owner·member·LEAD·ADMIN | Download a portable archive (streaming): `Content-Type: application/gzip`, `Content-Disposition: attachment; filename="<slug>.synth-project.tar.gz"`, `Content-Length`; query `withWorkspace=true` (by default no `workspace/**`); no project → 404 `NOT_FOUND`; no read right → 403 `FORBIDDEN` |
| POST | `/api/v2/projects/import` | both | auth / any role (with `mergeInto` — owner·EDITOR·LEAD·ADMIN) | Import an archive (multipart) → 201 `{projectId, sessionsImported, messagesImported, workspaceRestored, idMap}` |

**`POST /import`** — `multipart/form-data`: `file` (the archive, required), `name`
(the new project name), `mergeInto` (an existing project id), `withWorkspace` (`'true'`
— unpack `workspace/**`), `confirm` (`'true'`). **`confirm` is not required**: importing
into a new/existing project is non-destructive (it deletes no data), so no confirmation is
requested (`importProject` is called with `yes: true`), and the field is accepted for UI
compatibility. Success → 201 `ImportProjectResult`; a colliding new project name gets a
`(N)` suffix (an explicit `name` that is taken → 409).

**Upload limit.** The multipart `POST /import` is limited by `storage.maxUploadBytes`
(100 MiB by default, `DEFAULT_MAX_UPLOAD_BYTES`); the DoS protection checks the declared
`content-length`, the `File` size, and the bytes actually read — exceeding it → 413
`PAYLOAD_TOO_LARGE`.

**Error codes.** 400 `VALIDATION_ERROR` (a broken/corrupted archive, a sha256 mismatch,
an unsafe path in the archive, a workspace restore error, a non-multipart body, or a missing
`file`), 404 `NOT_FOUND` (no project or no `mergeInto` target), 409 `CONFLICT` (the project
name is taken), 413 `PAYLOAD_TOO_LARGE` (the limit is exceeded), 401/403 (no credentials/no
project read or edit right). Sources — `packages/core/src/server/routes/project-portable.ts`,
`packages/core/src/projects/portable.ts`.

### 5.9 Providers — `/api/v2/providers`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/providers` | both | auth / auth | Provider list |
| POST | `/api/v2/providers` | both | ADMIN / auth | Create/update |
| GET | `/api/v2/providers/:name` | both | ADMIN / auth | One (apiKey masked) |
| DELETE | `/api/v2/providers/:name` | both | ADMIN / auth | Delete |
| POST | `/api/v2/providers/:name/test` | both | ADMIN / auth | Connection test |
| POST | `/api/v2/providers/fetch-icon` | backend | ADMIN | Domain favicon (a raw data URL); the UI stores the icon already compressed (a small PNG data URL) |

> **The `num_ctx` / `numCtx` field (context size).** The context size
> of a provider (`ProviderConfig.numCtx`, for Ollama — `num_ctx`) is set by the field
> `num_ctx` (also `numCtx`) in the body of `POST /api/v2/providers` and
> `PATCH /api/v2/providers/:name` — an integer > 0 is accepted, `null`/`''` — reset
> (invalid → `400 VALIDATION_ERROR`). `GET /api/v2/providers` returns the value
> as `num_ctx` (snake_case), `GET /api/v2/providers/:name` — as the stored
> `numCtx` (camelCase). Priority: an explicit provider `numCtx` >
> `ModelConfig.contextWindow`. The field is also synced from the env var
> `SYNTH_PROVIDER_<NAME>_NUM_CTX` (`syncProvidersFromEnv`) and set by the CLI flag
> `--num-ctx` of `synth config provider add`. `num_ctx` is sent in the body
> of the request to the native `/api/chat` (a provider with `type: ollama` always normalizes
> the URL to it, stripping the `/v1` suffix, — with a warning in the log; the OpenAI-compatible
> path is a separate provider `type: openai`/`generic`). An alternative —
> a window on the Ollama side (`OLLAMA_CONTEXT_LENGTH`/Modelfile).

### 5.10 Models — `/api/v2/models`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/models` | both | auth / auth | Models grouped by provider |
| POST | `/api/v2/models` | both | ADMIN / auth | Create/update |
| POST | `/api/v2/models/fetch` | both | ADMIN / auth | Sync with the providers |
| DELETE | `/api/v2/models/:id` | both | ADMIN / auth | Delete |

### 5.11 Agents — `/api/v2/agents`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/agents/all` | both | ADMIN / auth | All agents (admin panel) |
| GET | `/api/v2/agents` | both | auth / auth | Primary agents only |
| POST | `/api/v2/agents` | both | ADMIN / auth | Create/update |
| GET | `/api/v2/agents/:id` | backend | ADMIN | Agent + builtin/override |
| DELETE | `/api/v2/agents/:id` | both | ADMIN / auth | Delete custom / reset built-in |
| PATCH | `/api/v2/agents/:id/enabled` | backend | ADMIN | `{enabled}` |

### 5.12 Files — `/api/v2/fs`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/fs` | both | auth | Directory listing; `?project_id=&path=&maxDepth=&includeHidden=` |
| GET | `/api/v2/fs/read` | both | auth | Contents; `?project_id=&path=` |
| POST | `/api/v2/fs/write` | both | auth | `{projectId, path, content}` |
| POST | `/api/v2/fs/upload` | both | auth | multipart: `project_id`, `path`, `file`; size limit (default 100 MiB, `DEFAULT_MAX_UPLOAD_BYTES`) → `413 PAYLOAD_TOO_LARGE` |
| GET | `/api/v2/fs/download` | both | auth | Download; `?project_id=&path=` |
| DELETE | `/api/v2/fs` | both | auth | Delete a file/an empty directory; `?project_id=&path=` |
| POST | `/api/v2/fs/mkdir` | both | auth | `{projectId, path}` |
| POST | `/api/v2/fs/move` | both | auth | `{projectId, sourcePath, targetPath, targetProjectId?}` |
| GET | `/api/v2/fs/workspace-root` | both | auth (managed → `403 FORBIDDEN`) | Subdirectories of the workspace root (ADR-075); `?includeHidden=` → `{root, entries}` |
| GET | `/api/v2/fs/workspace-root/browse` | both | auth (managed → `403 FORBIDDEN`) | Listing inside the root (ADR-075); `?path=&includeHidden=` → `{root, path, entries}` |
| POST | `/api/v2/fs/workspace-root/mkdir` | both | auth (managed → `403 FORBIDDEN`) | Create a directory in the root (ADR-075); `{path, confirmOutsideRoot?}` → 201 `{created, path}` |

> `workspace-root*` (ADR-075): an absolute path inside `workspacesRoot` works; outside root — per policy. Manual workspace selection exists in standalone only: in managed (`requireProjectId`) all three routes return `403 FORBIDDEN` for any role (the project directory is auto-provisioned, and the list of managed workspaces is not exposed).
> `POST /upload` — a file size limit (default `DEFAULT_MAX_UPLOAD_BYTES` = 100 MiB, overridable via the `FsRoutesOptions.maxUploadBytes` option); checked threefold (the declared `content-length`, `File.size`, the actual number of bytes read) → `413 PAYLOAD_TOO_LARGE` (the actual size guards against a lying/missing `content-length`).
> `confirm`: browse is allowed, mkdir requires `confirmOutsideRoot: true`, otherwise `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`.
> `deny`: `403 WORKSPACE_OUTSIDE_ROOT_DENIED` (including `..` traversal); protected paths → `403 PROTECTED_PATH_DENIED`.
> `mkdir` of an existing path → `409 ALREADY_EXISTS`; browsing a non-existent directory → `404 NOT_FOUND`, not a directory → `400 NOT_A_DIRECTORY`.
> `move` with the optional `targetProjectId`/`target_project_id` — a cross-project move (file/directory), locally between workspaces; with a remote (`remote:`) project on either side → `400`; an existing target → `409 ALREADY_EXISTS`, a missing source → `404 NOT_FOUND`.
> A single (core) implementation: the `FsError` shape; backend mounts the core factory with `deny` (managed) and a mandatory `project_id`;
> standalone — the policy from `settings/workspace-policy`, without `project_id` — a flat root, a project without a workspace — fallback to root.

### 5.13 Context — `/api/v2/context` (backend)

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/context/files` | ADMIN | List; `?category=user\|role\|system` |
| GET | `/api/v2/context/files/:name` | ADMIN | Contents; `?category=` |
| POST | `/api/v2/context/files/:name` | ADMIN | Save `{content, category}` or `{action:'toggle'}` |
| DELETE | `/api/v2/context/files/:name` | ADMIN | Delete; `?category=` |
| POST | `/api/v2/context/files/:name/restore_to_default` | ADMIN | Restore the system one; `?category=` |
| GET | `/api/v2/context/enabled` | ADMIN | `{enabled:[]}` |
| POST | `/api/v2/context/enabled` | ADMIN | `{files:[]}` |

### 5.13.1 Project instructions — `/api/v2/context/instructions` (core+backend, ADR-069)

Read-only transparency into the loaded project instructions (`AGENTS.md` and compatible files).

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/context/instructions?session_id=<id>` | owner/ADMIN | Snapshot for the workspace of the session's project; a session without a project → an empty result, `diagnostics[].code='no-project'` |
| GET | `/api/v2/context/instructions?project_id=<id>` | owner/LEAD/ADMIN | Snapshot for the project |

Response: `{ session_id?\|project_id?, enabled, cap: { chars, source: 'dynamic'\|'override', contextWindow }, files: [{ path, kind, label?, url?, chars, truncated, status, scan? }], diagnostics: [{ level, code, message, path?, kind? }] }` — the shape from the
ADR-069 Phase 2a resolver (`engine/context/instructions.ts`); `status` — `loaded`/`truncated`/`blocked`/`dedup`/`skipped`/`untrusted`/`skipped-install-tree`/`excluded`/`fetch-error`. Without `session_id`/`project_id` → 400; an unknown id → 404; someone else's access → 403. Nothing is written to storage.

### 5.14 Users — `/api/v2/users` (backend, ADMIN or scope `users:read`)

Reading the list/details is available to the `ADMIN` role **or** a service-key with the
`users:read` scope (machine reading of profiles/identities by add-ons); mutations —
`ADMIN` only. `GET /:id` returns the profile `identities` (ADR-089,
snake_case: `provider`, `external_id`, `username?`, `display_name?`,
`linked_at`, `linked_by?`); the list (`GET /`) does **not** include identities
(to avoid bloating the response — the details go in `/:id`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v2/users` | Profile list (without `identities`) |
| GET | `/api/v2/users/:id` | Profile (+ `identities`) |
| POST | `/api/v2/users` | Create (ADMIN) |
| PUT | `/api/v2/users/:id` | Update (ADMIN) |
| DELETE | `/api/v2/users/:id` | Delete (ADMIN) |

### 5.14.1 Current user's identities — `/api/v2/me/identities` (both, ADR-089)

External identities (e.g. Telegram) linked to a profile (`ProfileData.identities[]`).
RBAC: an authenticated user — only **their own** (core — the `local` user,
backend — the id from AuthKit). There is no direct linking (`POST /identities` without a code) —
linking goes only through the **claim flow** (`POST /identities/claim`): proving
ownership of an id with a one-time code issued by the core when an external event from an
unknown sender is accepted.

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| GET | `/api/v2/me/identities` | auth / auth | `{identities: ExternalIdentity[]}` of the current user (`provider`/`externalId`/`username?`/`displayName?`/`linkedAt`/`linkedBy?`) |
| DELETE | `/api/v2/me/identities/:provider/:externalId` | auth / auth | Unlink an identity (only your own); `{identities}` or 404 `NOT_FOUND` |
| POST | `/api/v2/me/identities/claim` | auth / auth | Confirm ownership of an identity with a one-time code `{code}` → 201 `{identity}` |

**`POST /api/v2/me/identities/claim`** (claim flow). The body is `{code: string}`
(a human-entered code `XXX-XXX`, case/hyphens/spaces are normalized by the core).
`provider`/`externalId` are **taken from the server-side claim record**, not from the request
body — someone else's id cannot be substituted. On success an `ExternalIdentity` is created with `linkedAt` = now
and `linkedBy` = the id of the user who confirmed; the code is **one-time** (repeated
use → 404) and expires by TTL (10 minutes by default). The code is created by the core
automatically when an event from an unknown sender is accepted and is delivered by the gateway
**only to a private chat** (it is not shown in a group/channel — otherwise all
members would see the code; see ADR-089). Errors:

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | empty/missing code (or a non-JSON body) |
| `NOT_FOUND` | 404 | the code is unknown, expired or already used (one-time use) |
| `CONFLICT` | 409 | the `provider`+`externalId` pair is already linked to a **different** profile |

Event ingestion (`POST /api/v2/events`, §5.26) returns an **optional** field
`identityHint?: { code: string, expiresAt: string }` in the response — it is filled only when the sender
is not matched to an instance user (`resolveExternalIdentity` → `null`) and the event has
`identity.principalId` set. The `{event, decision, sessionId}` contract does not change.


### 5.15 Git — `/api/v2/git` (both, ADR-076)

The `project.repos` registry (several repositories per project) and git operations.
`init`/`clone` **register** an entry in the project; `repo_path`/`path` are relative to
`project.workspace` (containment; an absolute path/`..` → `git.repo_path_invalid`).
Errors — in the shared shape `{ error: { error, code } }`.

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| POST | `/api/v2/git/scan` | auth | `{projectId}` → `{repos}` (git detection over the workspace, up to 3 levels) |
| POST | `/api/v2/git/repos/init` | write / auth | `{projectId, path, defaultBranch?, name?, sshKeyId?}` → 201 `RepoStatus`; registers an entry |
| POST | `/api/v2/git/repos/clone` | write / auth | `{projectId, url, path?, branch?, name?, sshKeyId?}` → 201 `RepoStatus`; an SSH URL without a key → 400 `git.ssh_key_required`; a taken path → 409 `git.repo_exists` |
| POST | `/api/v2/git/repos/register` | write / auth | `{projectId, path, name?, url?, type?, defaultBranch?, sshKeyId?}` → 200 `GitRepoConfig` (upsert by `id`/`path`) |
| POST | `/api/v2/git/repos/remove` | write / auth | `{projectId, id?\|path?, deleteLocal?}` → `{removed, deletedLocal}` (deleting the local directory — `deleteLocal`) |
| POST | `/api/v2/git/repos/fetch` | write / auth | `{projectId, id?\|path?}` → `{path, lastFetch}`; an SSH URL without a key → 400 `git.ssh_key_required` |
| GET | `/api/v2/git/log` | auth | `?project_id=&repo_path=&max_count=` → `{commits}` |
| GET | `/api/v2/git/commit` | auth | `?project_id=&repo_path=&hash=` → `{commit}` |

Backend RBAC: write endpoints (`init`/`clone`/`register`/`remove`/`fetch`) — owner/EDITOR/LEAD/ADMIN (`canEditProjectContent`), otherwise 403; read (`scan`/`log`/`commit`) — any authenticated user. Core (standalone) — `requireAuth`.

### 5.15.1 Agent SSH keys — `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` (both, ADR-076)

Responses — only `SSHKeyMeta` (`id`/`name`/`type`/`agentIds`/`createdAt`/`updatedAt`);
`privateKey`/`passphrase` are encrypted at-rest (AES-256-GCM) and are **never** returned.

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| GET | `/api/v2/ssh-keys` | auth | All keys; `?agentId=` — an agent's keys |
| POST | `/api/v2/ssh-keys` | ADMIN / auth | Create: `{name, type?, privateKey, passphrase?, agentIds?}` → 201 |
| GET | `/api/v2/ssh-keys/:id` | auth | Key by id |
| PATCH | `/api/v2/ssh-keys/:id` | ADMIN / auth | Partial update (including changing `privateKey`) |
| DELETE | `/api/v2/ssh-keys/:id` | ADMIN / auth | Delete the key entirely → 204 |
| GET | `/api/v2/agents/:agentId/ssh-keys` | auth | Keys linked to the agent |
| POST | `/api/v2/agents/:agentId/ssh-keys` | ADMIN / auth | Create with a link to the agent (merges `agentIds`) → 201 |
| DELETE | `/api/v2/agents/:agentId/ssh-keys/:keyId` | ADMIN / auth | **Unlink** the key from the agent (the key is not deleted) |

Codes: `sshkey.not_found` (404), `sshkey.name_exists` (409), `sshkey.decrypt_failed` / `sshkey.encryption_unavailable` (500), `sshkey.env_failed` (400, via `VALIDATION_ERROR`), `VALIDATION_ERROR` (400). Keys with a `passphrase` **are supported**: during a git operation `createSshEnv` prepares askpass (`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`), a preparation failure → `sshkey.env_failed`. In hybrid mode the nested `/api/v2/agents/:agentId/ssh-keys[/:keyId]` is proxied by core to backend (`REMOTE_PROXY_PATTERNS`), like the flat `/ssh-keys` and `/git`; other subpaths of `/api/v2/agents` stay local. The master key — `SYNTH_SECRET_KEY`/`security.secretKey`/`{dataDir}/secrets/master.key`; rotation — the `synth secrets rotate` CLI (not the HTTP API).

### 5.16 MCP — `/api/v2/mcp`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/mcp/servers` | backend | auth | Configured servers + `connected` |
| POST | `/api/v2/mcp/servers` | backend | ADMIN | `{name, config}` → 201 |
| GET | `/api/v2/mcp/servers/:name` | backend | auth | Server config |
| PUT | `/api/v2/mcp/servers/:name` | backend | ADMIN or scope `addons:install` | Update the config |
| DELETE | `/api/v2/mcp/servers/:name` | backend | ADMIN or scope `addons:install` | Delete |
| POST | `/api/v2/mcp/servers/:name/test` | backend | ADMIN or scope `addons:install` | Test the connection (+optional `config`) |
| GET | `/api/v2/mcp/servers/:name/tools` | backend | auth | Server tools (probe if needed) |
| GET | `/api/v2/mcp/session/:sessionId` | backend | auth | Legacy: `{mcpServers, mcpDisabledServers, allServers}` (canonical — `/sessions/:id/mcp`) |
| PUT | `/api/v2/mcp/session/:sessionId` | backend | auth | Legacy: `{mcpServers?, mcpDisabledServers?}` (compatible with `/sessions/:id/mcp`) |
| POST | `/api/v2/mcp/probe` | both | auth | `{name}` → `{name, tools}`, `MCP_CONNECT_ERROR` |
| GET | `/api/v2/mcp/registry` | backend | auth | Unified MCP server registry (ADR-071 §2.5): `{entries}`; an entry carries `enabled` (master hard-gate, default `true`) and `enabledByDefault` (default for NEW projects) |
| POST | `/api/v2/mcp/registry` | backend | auth (stdio — ADMIN only; service-key — scope `addons:install`) | Add an entry: `{name, config, enabled?, enabledByDefault?, origin?}` → 201; stdio — ADMIN only (a scope does not relax this); HTTP — anyone; a service-key without the `addons:install` scope → 403 `SCOPE_REQUIRED`. The **instance** origin (`origin:'instance'` or an installer key with the scope) is available to ADMIN **or** a service-key with the `addons:install` scope; interactive use without ADMIN creates a `user` entry even with `origin:'instance'` |
| PUT | `/api/v2/mcp/registry/:id` | backend | author/ADMIN or scope `addons:install` | Update an entry (`enabled` — the registry master flag); an installer key with the scope updates instance entries (the scope branch survives key rotation) |
| DELETE | `/api/v2/mcp/registry/:id` | backend | author/ADMIN | Delete an entry |

> MCP per-item resolution (ADR-071 §2.4): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; the default is opt-in (off). The registry master `enabled` and the project `enabled` are a live hard-gate (including old sessions and system servers); `enabledByDefault`/`project.defaultOn` are a snapshot (`mcpDefaultOn`). Reasons: `system_disabled\|project_disabled\|session_optout\|not_default`. `McpServerConfig.enabled` is only the seed of a registry entry (`seedFromConfig`) and does not participate in resolution. A missing `project.mcp` means no gate is set (legacy).

### 5.17 Skills — `/api/v2/skills` (both, ADR-046 Phase 1)

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/skills` | both | auth | Skill registry: `{skills, workspace?, diagnostics?}`; `?project_id=` — project scope, `?diagnostics=1` — discovery/validation diagnostics |
| POST | `/api/v2/skills` | both | backend ADMIN or scope `addons:install` / core auth | Create an instance skill: `{name, description, body?, files?}` → 201 (409 on a duplicate) |
| GET | `/api/v2/skills/:name` | both | auth | Detail: meta, body (empty for untrusted), supporting files |
| PATCH | `/api/v2/skills/:name` | both | backend ADMIN or scope `addons:install` / core auth | Update an instance skill: `{description?, body?, metadata?}` |
| DELETE | `/api/v2/skills/:name` | both | backend ADMIN or scope `addons:install` / core auth | Delete an instance skill |
| GET | `/api/v2/skills/:name/files` | both | auth | List of supporting files `{files}` |
| GET | `/api/v2/skills/:name/files/*` | both | auth | Read a supporting file `{path, content}` |
| PUT | `/api/v2/skills/:name/files/*` | both | backend ADMIN or scope `addons:install` / core auth | Write a supporting file `{content}` |
| DELETE | `/api/v2/skills/:name/files/*` | both | backend ADMIN or scope `addons:install` / core auth | Delete a supporting file |
| POST | `/api/v2/skills/reload` | both | backend ADMIN or scope `addons:install` / core auth | Force a registry re-scan (lazy invalidation by mtime) |

Discovery sources (priority, first-wins): `{project.workspace}/.synth/skills` (project, project-trust gate), `{dataDir}/skills` (instance), `config.skills.paths`, external read-only directories (`.opencode/skills|skill`, `.claude/skills`, `.agents/skills`, `~/.config/opencode/skills`) and `config.skills.urls` (read-only indexing into `{dataDir}/skills-cache`, `trusted:false`). Losing duplicates — `shadowed` diagnostics; the cache is invalidated lazily by mtime/size.

### 5.17.1 Commands and bundles — `/api/v2/commands`, `/api/v2/skill-bundles` (both, ADR-046 Phase 2)

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/commands` | both | auth | List of commands (builtin + template `.md` + skills with invocation user/both + bundles). `?project_id=` — project scope, `?diagnostics=1` — `shadowed`/errors |
| GET | `/api/v2/skill-bundles` | both | auth | `{bundles}` — YAML groups of skills |
| POST | `/api/v2/skill-bundles` | both | backend ADMIN / core auth | Create a bundle `{name, description, skills[], instruction?}` → 201 (409 on a duplicate; 400 when referencing a non-existent skill) |
| GET | `/api/v2/skill-bundles/:name` | both | auth | Bundle detail |
| PATCH | `/api/v2/skill-bundles/:name` | both | backend ADMIN / core auth | Update the bundle |
| DELETE | `/api/v2/skill-bundles/:name` | both | backend ADMIN / core auth | Delete the bundle |

Resolution of `/`-commands is performed **in core** (uniformly for the UI/CLI/hybrid, ADR-046): builtin answers (`/help`, `/skills`, `/commands`) do not call the LLM, and the `command.invoked`/`skill.invoked` events go to the bus. The order of names depends on `commands.conflict.mode`.

### 5.17.2 Skill scope — `/api/v2/sessions|projects|settings/skills` (both, ADR-046)

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/sessions/:id/skills` | both | owner/ADMIN | Effective session scope: `{skills:[{name, level, scope, trusted, available, unavailableReason?, enabled, disabled, disabledReason?}], enabled, disabled}`; `disabledReason` ∈ `system\|project\|session` |
| GET | `/api/v2/sessions/:id/skills/effective` | both | owner/ADMIN | Alias of the effective list |
| PUT | `/api/v2/sessions/:id/skills` | both | owner | A single toggle: `{name, enabled}` (per-item toggle) or `{skills?, skillsDisabled?}` |
| GET | `/api/v2/projects/:id/skills` | both | owner/LEAD/ADMIN | Project scope: `{enabled, defaultOn, skills}`; `enabled[]` — hard-gate (including old sessions), `defaultOn[]` — the seed for new sessions |
| PUT | `/api/v2/projects/:id/skills` | both | backend ADMIN / core auth | Set `{enabled?, defaultOn?}` |
| GET | `/api/v2/settings/skills` | both | auth | Instance-wide: `{disabled:{categories,groups,skills}, disabledForNewProjects:{categories,groups,skills}, policy}`; `disabled` — the master hard-gate, `disabledForNewProjects` — the seed for new projects |
| PUT | `/api/v2/settings/skills` | both | backend ADMIN / core auth | Set `{disabled?, disabledForNewProjects?, policy?}` (union of groups/names, the semantics of `tools.disabled`) |
| DELETE | `/api/v2/settings/skills` | both | backend ADMIN / core auth | Reset the instance-wide `disabled`/`disabledForNewProjects`/`policy` |

> Skill per-item resolution (ADR-046): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; the default is opt-in (off). A system/project disable is a live hard-gate (including old sessions); defaults are a snapshot (`skillsDefaultOn`). A missing `project.skills` means no gate is set (legacy).

### 5.18 Audit — `/api/v2/audit` (backend)

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/audit` | ADMIN/AUDITOR | Gateway audit; `?userId=&sessionId=&since=&until=&limit=` (≤500) |
| POST | `/api/v2/audit/revealed` | auth | `{sessionId, placeholder}` → `{ok:true}` |
| GET | `/api/v2/audit/security` | ADMIN/AUDITOR (core — auth) | Audit of egress policy, proxy and TLS changes (ADR-099): append-only `{dataDir}/audit/security.jsonl`; `?limit=` (default 100, max 1000), `?scope=tools\|webhooks\|mcp\|proxy\|tls` → `{entries, count}` (newest first); `scope:"proxy"` records carry no password and redacted URLs; `scope:"tls"` — paths/hosts/subject, no PEM/keys |
| GET | `/api/v2/audit/egress` | ADMIN/AUDITOR (core — auth) | Outbound request journal (ADR-099): append-only `{dataDir}/audit/egress.jsonl`; `?limit=` (default 100, max 1000), `?scope=web_fetch\|web_search\|skills\|instructions\|webhooks\|providers\|mcp`, `?status=allowed\|blocked\|error` → `{entries, count}`; bodies and headers are not logged; `via` (`proxy`\|`direct`\|`fallback`) is the actual route |

### 5.19 Logs — `/api/v2/logs` (backend)

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/logs/llm` | ADMIN/AUDITOR | LLM payload log; `?sessionId=&limit=` (≤500) |
| GET | `/api/v2/logs/:name` | ADMIN/AUDITOR | Tail of `core\|ui\|backend`; `?tail=` (1..2000), `?search=` |

### 5.20 Gateway patterns — `/api/v2/gateway` (backend, ADMIN)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v2/gateway/patterns` | Secret patterns + an override flag |
| PUT | `/api/v2/gateway/patterns` | Save the override |
| DELETE | `/api/v2/gateway/patterns` | Reset to the default |

### 5.21 Settings — `/api/v2/settings` (both)

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/settings/workspace` | auth | Default working directory: `{workspace, isOverridden, defaults}` (`defaults` — env/config) |
| PUT | `/api/v2/settings/workspace` | ADMIN (managed) / auth (core) | `{workspace}` |
| DELETE | `/api/v2/settings/workspace` | ADMIN (managed) / auth (core) | Reset the runtime override to the default; `{status:"restored", workspace, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/workspace-policy` | auth | Policy for an absolute workspace outside `workspacesRoot` (ADR-075): `{outsideRoot:"confirm"\|"deny", isOverridden, defaults, readOnly?}` (managed — `readOnly:true`, effectively `deny`) |
| PUT | `/api/v2/settings/workspace-policy` | ADMIN (managed) / auth (core) | `{outsideRoot}` (live application, persisted); an invalid value → `400`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| DELETE | `/api/v2/settings/workspace-policy` | ADMIN (managed) / auth (core) | Reset to the config/env default; `{status:"restored", outsideRoot, isOverridden:false, defaults}`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| GET | `/api/v2/settings/mcp` | auth | MCP availability by mode: `{servers, isOverridden, defaults:{}}` |
| PUT | `/api/v2/settings/mcp` | ADMIN (managed) / auth (core) | `{servers}` |
| DELETE | `/api/v2/settings/mcp` | ADMIN (managed) / auth (core) | Reset the runtime MCP availability; `{status:"restored", servers:{}, isOverridden:false, defaults:{}}` |
| GET | `/api/v2/settings/default-agent` | auth | Default agent (the “Agents” admin panel): `{defaultAgent, isOverridden, defaults}` (runtime from `settings.json`, otherwise `DEFAULT_AGENT_ID` — `assistant` on first deployment); used when creating a session without `settings.agentRole` and as `default_agent` in `/agents` |
| PUT | `/api/v2/settings/default-agent` | ADMIN (managed) / auth (core) | `{defaultAgent}` — the agent id (`^[a-z0-9_-]+$`), persisted; invalid/empty → 400 |
| DELETE | `/api/v2/settings/default-agent` | ADMIN (managed) / auth (core) | Reset to the default; `{status:"restored", defaultAgent, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/default-model` | auth | Default model (the “Models” admin panel) — an instance-wide **explicit pair** `provider`+`model`: `{defaultModel:{provider,model}\|null, isOverridden, defaults}` (runtime from `settings.json`, otherwise `llm.defaultProvider`/`llm.defaultModel` from config.yaml — only when both are set; `null` — no pair configured); used by new sessions and event-created sessions, and for `isDefault`/`default_provider` in `/api/v2/models`/`/api/v2/providers` |
| PUT | `/api/v2/settings/default-model` | ADMIN (managed) / auth (core) | `{provider, model}` — persisted + applied live; empty fields or unknown provider/model → `400 VALIDATION_ERROR`; `{defaultModel:{provider,model}}` |
| DELETE | `/api/v2/settings/default-model` | ADMIN (managed) / auth (core) | Reset to the config fallback (`llm.defaultProvider`/`llm.defaultModel`); `{status:"restored", defaultModel, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/tools-policy` | auth | Policy for enabling **built-in** tools (ADR-071 §2.3): `{toolsPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime from `settings.json`, otherwise `tools.policy` from config.yaml; default `auto`) |
| PUT | `/api/v2/settings/tools-policy` | ADMIN (managed) / auth (core) | `{toolsPolicy}` (live application, persisted); an unknown value → 400 |
| DELETE | `/api/v2/settings/tools-policy` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", toolsPolicy, isOverridden:false, defaults}` + live application of the default |
| GET | `/api/v2/settings/mcp-policy` | auth | Policy for enabling **MCP** tools (ADR-071 §2.3): `{mcpPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime from `settings.json`, otherwise `mcp.policy` from config.yaml; default `auto`) |
| PUT | `/api/v2/settings/mcp-policy` | ADMIN (managed) / auth (core) | `{mcpPolicy}` (live application, persisted); independent of `tools-policy`; an unknown value → 400 |
| DELETE | `/api/v2/settings/mcp-policy` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", mcpPolicy, isOverridden:false, defaults}` + live application of the default |
| GET | `/api/v2/settings/mcp-network-policy` | auth | Network policy for user HTTP/SSE MCP servers (ADR-071 §2.3.1; an instance of the shared egress policy, ADR-099): `{policy:{mode:"deny"\|"allow",list:string[],exceptions:string[]}, isOverridden, defaults}` (default — deny private ranges) |
| PUT | `/api/v2/settings/mcp-network-policy` | ADMIN (managed) / auth (core) | `{policy:{mode:"deny"\|"allow",list:string[],exceptions?:string[]}}` (live application, persisted); an invalid rule → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/mcp-network-policy` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", policy, isOverridden:false, defaults}` + live application of the default |
| GET | `/api/v2/settings/egress/tools` | auth | Address egress policy for built-in tools and internal consumers (`web_fetch`/`web_search`, URL skills/instructions, provider icons; ADR-099): `{policy:{mode:"deny"\|"allow",list:string[],exceptions:string[]}, isOverridden, defaults}` |
| PUT | `/api/v2/settings/egress/tools` | ADMIN (managed) / auth (core) | `{policy}` (live application, persisted); an invalid rule (hostname/`*.suffix`/CIDR) → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/egress/tools` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", policy, isOverridden:false, defaults}` + live application of the default |
| GET | `/api/v2/settings/egress/webhooks` | auth | Address egress policy for outgoing webhooks (ADR-099): the same format plus `mode:"off"` (dev: no checks and no `https` requirement) |
| PUT | `/api/v2/settings/egress/webhooks` | ADMIN (managed) / auth (core) | `{policy}` (live application, persisted); an invalid rule → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/egress/webhooks` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", policy, isOverridden:false, defaults}` + live application of the default |
| POST | `/api/v2/settings/egress/check` | ADMIN (managed) / auth (core) | URL check **without performing the request**: `{scope:"tools"\|"webhooks"\|"mcp", url}` → `{allowed, reason?, matchedRule?, addresses?, proxied, addressChecksActive, policy}` (parse + DNS + matching; for `webhooks` an `https` requirement applies, except `mode:"off"`). With a proxy enabled `proxied:true`, `addressChecksActive:false` — only the scheme and hostname rules/`exceptions` are checked (no DNS/CIDR) |
| GET | `/api/v2/settings/proxy` | auth | Egress proxy settings (ADR-099): flat **saved** fields (`enabled, source:"env"\|"runtime"\|"config"\|"none", mode:"all"\|"selected", defaultProfile?, profiles:{"<name>":{label?,url?,httpProxy?,httpsProxy?,allProxy?,auth?:{type:"basic",username},tls?:{caFile?,certFile?,keyFile?,hasCaPem,rejectUnauthorized},legacy,source}}, rules:[{id,label?,hosts,action:"proxy"\|"direct",profile?}], url?, httpProxy?, httpsProxy?, allProxy?, noProxy, fromEnv, fallbackDirect, connectTimeoutMs, auth?, tls?`) + `{saved, running, defaults, isOverridden, password:{source:"env"\|"file"\|"none", set, removable}, restartRequired}` (top-level `restartRequired` is computed: saved fingerprint ≠ running). URLs are redacted (no userinfo/secrets); **`caPem` and PEM contents, passwords and userinfo are never returned** (for `caPem` only `hasCaPem`; per profile — `password:{source,set,removable}`), while the `caFile`/`certFile`/`keyFile` paths are returned |
| PUT | `/api/v2/settings/proxy` | ADMIN (managed) / auth (core) | Save the runtime override `{proxy}` (validation: `mode`/`profiles`/`rules` — the profile name is `^[a-z][a-z0-9_-]{0,31}$` and immutable, `action:"direct"` without `profile`, `action:"proxy"` — an existing `profile`/`defaultProfile`, `mode:"selected"` — at least one rule, `mode:"all"` — a default profile, host patterns; with `profiles` the top-level URL/auth/tls are forbidden; `auth.type` only `basic` — NTLM/Negotiate are **out of scope** and delegated to an egress gateway (ADR-099 item 25), a password in the userinfo URL is forbidden, `caFile`↔`caPem`, `certFile`+`keyFile`); **not applied live** (a restart is required); invalid → 400 `VALIDATION_ERROR`; audit `scope:"proxy"` (before/after without the password) → `{saved, running, restartRequired:true}` |
| DELETE | `/api/v2/settings/proxy` | ADMIN (managed) / auth (core) | Reset the runtime override to `config.yaml`/env; audit `scope:"proxy"` → `{status:"restored", saved, defaults, running, restartRequired}` |
| PUT | `/api/v2/settings/proxy/password` | ADMIN (managed) / auth (core) | Set the Basic password: `{password}` → the file `{dataDir}/secrets/proxy-password` (0600, directory 0700, atomic); the value is never returned and never written to the audit; an empty password → 400; `SYNTH_PROXY_PASSWORD` set → 409 `CONFLICT` → `{password:{source,set,removable}}` |
| DELETE | `/api/v2/settings/proxy/password` | ADMIN (managed) / auth (core) | Remove the password file (idempotent, 0600); `SYNTH_PROXY_PASSWORD` set → 409 `CONFLICT`; audit `scope:"proxy"` (status only, no value) → `{password:{source,set,removable}}` |
| PUT | `/api/v2/settings/proxy/profiles/:name/password` | ADMIN (managed) / auth (core) | **Profile** Basic password: `{password}` → `{dataDir}/secrets/proxy/<name>.password` (for `default` — the legacy `secrets/proxy-password`; 0600, directory 0700, atomic). No such profile in the saved config → 404 `NOT_FOUND`; missing/empty password → 400; a profile env password (`SYNTH_PROXY_<NAME>_PASSWORD`) → 409 `CONFLICT`; the value is never returned → `{password:{source,set,removable}}` |
| DELETE | `/api/v2/settings/proxy/profiles/:name/password` | ADMIN (managed) / auth (core) | Remove the profile password file (idempotent); no profile → 404; env password → 409; audit `scope:"proxy"` (status only) → `{password:{source,set,removable}}` |
| PUT | `/api/v2/settings/proxy/profiles/:name/tls/ca` | ADMIN (managed) / auth (core) | CA bundle **for the proxy** of a profile: `{pem}` (1+ certificates) → `{dataDir}/secrets/proxy/<name>/ca.pem` (0600), only `tls.caFile` is written to the saved config; broken PEM → 400; no profile → 404; audit `scope:"proxy"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/proxy/profiles/:name/tls/ca` | ADMIN (managed) / auth (core) | Remove the profile CA (file + `tls.caFile`/`caPem`); no profile → 404; audit `scope:"proxy"` → `{status, restartRequired:true}` |
| PUT | `/api/v2/settings/proxy/profiles/:name/tls/client` | ADMIN (managed) / auth (core) | mTLS **to the proxy** for a profile: `{certPem, keyPem}` (write-only pair) → `secrets/proxy/<name>/{client.crt,client.key}` (0600), paths in the config; an incomplete pair/broken PEM/a key that does not match the cert → 400; no profile → 404; audit `scope:"proxy"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/proxy/profiles/:name/tls/client` | ADMIN (managed) / auth (core) | Remove the profile mTLS client (files + config paths); no profile → 404; audit `scope:"proxy"` → `{status, restartRequired:true}` |
| POST | `/api/v2/settings/proxy/test` | ADMIN (managed) / auth (core) | **Target URL** check against the saved config: `{url}` (`http(s)`, no userinfo; otherwise 400) → `{url, route:{action:"proxy"\|"direct", via, reason:"disabled"\|"no-proxy"\|"rule"\|"default"\|"no-match"\|"no-default", ruleId?, ruleLabel?, profile?, profileLabel?, proxyUrl?}, ok, httpStatus?, latencyMs, authChallenge, error?, usingSaved:true, restartRequired}`. `HEAD` without redirects or a body; the `egress.tools` address policy is evaluated **before** the request (a denial → `ok:false` + `route`, no request); target TLS — the `security.tls` bootstrap. Not to be confused with `/proxy/check` (proxy connectivity) |
| POST | `/api/v2/settings/proxy/check` | ADMIN (managed) / auth (core) | **Proxy connection check only** (not the target): `{url?}` → `{reachable, latencyMs, authChallenge:"Basic"\|"NTLM"\|"Negotiate"\|"none", error?, usingSaved}`; `authChallenge: NTLM\|Negotiate` is **diagnostics only**: Synth does not authenticate these schemes (egress gateway, ADR-099 item 25). Without `url` the **saved** configuration is checked (`usingSaved:true`), otherwise the explicit proxy; TCP/TLS/SOCKS handshake, no request to the target; an invalid `url` (not a string) → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/settings/tls` | auth | TLS trust status (ADR-099): flat `status` fields + `{status, saved, running, defaults, restartRequired}`; `status` — `{ca:{source,count,subjects}, rejectUnauthorized, defaultClient?:{source,certSubject?,hasKey,readOnly}, mappings:[{id,hosts,label?,certSubject?,source,readOnly}], params:{ca?:{source,caFile?,hasPem}, client?:{source,certFile?,keyFile?,readOnly}}, running?:{applied,profileIds}, saved?:{bootstrap,profileIds}}`; **PEM/keys are never returned**; `source` — `env`\|`runtime`\|`config`\|`none` |
| PUT | `/api/v2/settings/tls` | ADMIN (managed) / auth (core) | `{tls:{caFile?, caPem?, rejectUnauthorized?}}` — non-secret fields (CA path or PEM bundle, mutually exclusive; certificates/keys via separate endpoints); invalid/unknown field → 400 `VALIDATION_ERROR`; **not applied live** → `{status, restartRequired:true}`; audit `scope:"tls"` |
| PUT | `/api/v2/settings/tls/ca` | ADMIN (managed) / auth (core) | Upload/replace the CA bundle: `{pem}` (1+ certificates) → the file `{dataDir}/secrets/tls/ca.pem` (0600); broken PEM → 400; CA set via env → 409 `CONFLICT` (read-only); audit `scope:"tls"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/tls/ca` | ADMIN (managed) / auth (core) | Remove the runtime CA (fall back to config/env); CA set via env → 409 `CONFLICT`; audit `scope:"tls"` → `{status, restartRequired:true}` |
| PUT | `/api/v2/settings/tls/client` | ADMIN (managed) / auth (core) | Set the **default** mTLS client: `{certPem, keyPem}` (write-only, a pair) → `secrets/tls/client.crt`/`client.key` (0600); incomplete pair/broken PEM/key mismatch → 400; default set via env/config → 409 `CONFLICT` (read-only; override only via a mapping); audit `scope:"tls"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/tls/client` | ADMIN (managed) / auth (core) | Remove the default mTLS client; default set via env/config → 409 `CONFLICT`; audit `scope:"tls"` → `{status, restartRequired:true}` |
| POST | `/api/v2/settings/tls/mappings` | ADMIN (managed) / auth (core) | Add a per-host profile: `{hosts:string[] (host\|*.suffix\|*), certPem, keyPem, label?}` → `{mapping:{id,hosts,label?,certSubject?,source:"runtime",readOnly:false}, status, restartRequired:true}`; invalid hosts/pair → 400 `VALIDATION_ERROR`; audit `scope:"tls"` |
| PUT | `/api/v2/settings/tls/mappings/:id` | ADMIN (managed) / auth (core) | Update a mapping: `{hosts?, label? (null — reset), certPem?, keyPem?}` (cert and key — both or neither); no mapping → 404 `NOT_FOUND`; invalid → 400; audit `scope:"tls"` → `{mapping, status, restartRequired:true}` |
| DELETE | `/api/v2/settings/tls/mappings/:id` | ADMIN (managed) / auth (core) | Delete a mapping and its materials; no mapping → 404 `NOT_FOUND`; audit `scope:"tls"` → `{status, restartRequired:true}` |
| POST | `/api/v2/settings/tls/validate` | auth | Validation **without writing**: `{caPem?, certPem?, keyPem?, hosts?}` → `{ok, caCount?, caSubjects?, certSubject?, keyMatches?, hostPatternsValid?, errors:string[]}` (CA/client-pair parsing, key-vs-cert match, host-pattern validity); bad input — `ok:false` + `errors` (not 500) |
| GET | `/api/v2/settings/tools-disabled` | auth | Disabling of built-in tools (ADR-071 §2.6): `{toolsDisabled:{capabilities,tools}, isOverridden, defaults}` (runtime value from `settings.json`, otherwise `tools.disabled` from config.yaml) |
| PUT | `/api/v2/settings/tools-disabled` | ADMIN (managed) / auth (core) | `{toolsDisabled:{capabilities:string[],tools:string[]}}` (live application, persisted); an unknown capability → 400, `runtime` tools cannot be disabled. The UI section is an ADMIN category |
| DELETE | `/api/v2/settings/tools-disabled` | ADMIN (managed) / auth (core) | Reset to the config default (empty by default); `{status:"restored", toolsDisabled, isOverridden:false, defaults}` + live application of the default |
| GET | `/api/v2/settings/llm-gateway` | auth | Effective LLM Gateway settings: `{llmGateway:{enabled,inputMode,logPayloads,rateLimit}, isOverridden, defaults}` (runtime on top of config.yaml) |
| PUT | `/api/v2/settings/llm-gateway` | ADMIN (managed) / auth (core) | `{llmGateway}` (live application) |
| DELETE | `/api/v2/settings/llm-gateway` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", llmGateway, isOverridden:false, defaults}` + live application of `{}` (the gateway from config.yaml) |
| GET | `/api/v2/settings/security` | auth | Effective `{protectedPaths, askTimeoutMs}` + `{isOverridden, defaults}` (runtime on top of config.yaml) |
| PUT | `/api/v2/settings/security` | ADMIN (managed) / auth (core) | `{security}` (live application) |
| DELETE | `/api/v2/settings/security` | ADMIN (managed) / auth (core) | Reset to the config default; `{status:"restored", security, isOverridden:false, defaults}` + live application of `{}` |
| GET | `/api/v2/settings/protected-paths` | auth | `{policy, base, is_overridden}` |
| PUT | `/api/v2/settings/protected-paths` | ADMIN (managed) / auth (core) | `{policy}` or `{version, add, remove}` |
| DELETE | `/api/v2/settings/protected-paths` | ADMIN (managed) / auth (core) | Reset to the system policy |
| GET | `/api/v2/settings/events` | auth | Runtime settings of the “Events” section (ADR-089): `{events:{enabled, defaultMode, ephemeralTtl, journalRetentionDays, allowedSources, unknownAgentTemplate, keyRateLimitPerMinute, decisionRouting, autoBind, autoBindAgentTemplate}, defaults, isOverridden}` (runtime from `settings.json` on top of the config.yaml `events`) |
| PUT | `/api/v2/settings/events` | ADMIN (managed) / auth (core) | Patch `{events:{…}}` (live application: the Router/funnel/pruner are reconfigured); an invalid value → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/events` | ADMIN (managed) / auth (core) | Reset the runtime settings to the config default; `{status:"restored", events, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/decision` | auth | Runtime settings of the decision layer (ADR-084): `{decision:{enabled, provider, model, confidenceThreshold, escalationProvider, escalationModel}, defaults, isOverridden}` (runtime from `settings.json` on top of the config.yaml `decision`); `escalationProvider`/`escalationModel` — an optional exact tier `primary → escalation` (empty — no escalation) |
| PUT | `/api/v2/settings/decision` | ADMIN (managed) / auth (core) | Patch `{decision:{…}}` (live application: the micro cascade/router/event routing are reconfigured); an invalid value → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/decision` | ADMIN (managed) / auth (core) | Reset the runtime settings to the config default; `{status:"restored", decision, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/decision/metrics` | auth | Aggregate in-memory metrics of the decision layer (ADR-084) → `{metrics, ts}`. The `metrics` shape: `{calls, handled, fallback, escalated, attempts:{primary, escalation}, rejected:{ok, low_confidence, invalid, no_answer, no_provider, error}, by_model:{"<provider>/<model>":{calls, handled, latency_ms_avg, latency_ms_max}}}`; reset on restart |
| DELETE | `/api/v2/settings/decision/metrics` | ADMIN (managed) / auth (core) | Reset the decision-layer metric counters → `{metrics}` (a zeroed snapshot) |

> **Address egress policy (ADR-099).** `egress.tools`/`egress.webhooks`/`mcp.networkPolicy` share one
> format `{mode, list, exceptions}`: `exceptions` are checked first (hostname, `*.suffix`, IP/CIDR),
> `deny` blocks when any resolved address is forbidden, `allow` permits only when all addresses are allowed;
> `off` — webhooks only. The policy is applied **live** (per-request, no restart) and is **not mixed**
> between scopes (tools ≠ webhooks ≠ MCP); changes go to `audit/security.jsonl`, requests to
> `audit/egress.jsonl` (`via` — `proxy`/`direct`/`fallback`). With a proxy enabled the address check runs in
> proxied mode (`settings/egress/check` → `proxied`/`addressChecksActive`).
> LLM providers are not part of the egress journal (they have their own LLM audit/payload log).

> **Proxy profiles and rules (ADR-099 item 27).** `mode: all` — `defaultProfile` for every host except
> `noProxy`; `selected` — only `rules` (everything else direct). Rules are evaluated in declaration order
> (**first match**), `noProxy` wins over rules; `action: direct` is incompatible with `profile`; CIDR
> matches the target IP literal only. `profiles`/`rules` — the runtime value replaces the config **entirely**
> (no field-level merge); with `profiles` present, top-level URL/auth/tls and env URLs are forbidden.
> Profile passwords and TLS material are write-only (`PUT/DELETE .../profiles/:name/{password,tls/ca,tls/client}`),
> values/PEMs are never returned. `POST /settings/proxy/test` checks the **target** (unlike `/proxy/check`,
> which checks proxy connectivity) and shows the matched route; both use the **saved** configuration.

### 5.22 Dictionaries — `/api/v2/dictionaries` (both)

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| GET | `/api/v2/dictionaries` | auth / auth | List of dictionaries |
| GET | `/api/v2/dictionaries/:category/:lang` | auth / auth | Dictionary |
| PUT | `/api/v2/dictionaries/:category/:lang` | ADMIN / auth | Save |
| DELETE | `/api/v2/dictionaries/:category/:lang` | ADMIN / auth | Delete |

### 5.23 LLM — `/api/v2/llm` (backend)

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| POST | `/api/v2/llm/chat/completions` | auth + rate limit | LLM Proxy (see §4) |

### 5.24 Updates — `/api/v2/updates` (core)

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/api/v2/updates/check` | auth | Check for a new version |
| POST | `/api/v2/updates/apply` | auth | SSE stream of `npm i -g @itphx/synth@latest` |

### 5.25 Admin/debug — `/api/v2/admin/debug` (backend, ADMIN)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v2/admin/debug/config` | Logging groups and levels |
| POST | `/api/v2/admin/debug/config` | `{groups}` → `{status:'saved'}`; merge — only the passed groups are saved, the other overrides are not reset |

### 5.26 Events — `both`

Real-time — SSE `GET /api/v2/events` and WS `/ws/events` (see §3). Accepting external
events, managing bindings and routing rules (ADR-089; the single factory
`createEventRoutes` for core and backend):

| Method | Path | Build | RBAC (managed) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/events` | both | auth | Global SSE stream of `BusEvent` (WS fallback) |
| WS | `/ws/events` | both | auth | Primary real-time channel (see §3) |
| POST | `/api/v2/events` | both | auth/key + rate limit | Accepting a normalized external event. Regular path: `Authorization: Bearer <user key>` → body `{source, type, payload?, identity?, dedupKey?, ts?}` (`eventIngestSchema`). The binding-key path: `Authorization: Bearer synth_evt_…` — **without user credentials**, `source` is optional (`eventKeyIngestSchema`; source/chat/thread are taken from the binding; a `source` conflict → 400), the event is forcibly routed into the binding. The response in both cases → `201 {event, decision, sessionId}` + **optional** `identityHint?: {code, expiresAt}` (ADR-089 claim flow: a one-time code confirming identity ownership; it is filled in only when the sender is not identified — `resolveExternalIdentity` → `null` — and `identity.principalId` is set); `sessionId` — the session id or `null` on `drop`; with decision routing (`events.decisionRouting`) `decision` carries `confidence` and diagnostic `signals`, e.g. `agent:<id>`/`model:<p/m>`/`latency:<ms>ms`); an invalid/revoked/expired key → 401 `UNAUTHORIZED`; an invalid body → 400 `VALIDATION_ERROR`, a materialization failure → 500 `INTERNAL_ERROR` (the decision is still written to the journal). The rate limit (managed — 120/min) applies to both paths before the authentication method is chosen; the per-key limit (the key's limit or the global `events.keyRateLimitPerMinute`) → 429 `RATE_LIMITED`; the master switch `events.enabled: false` → 503 `UNAVAILABLE`. Key usage is written to the journal (`keyId`/`principalId`) |
| GET | `/api/v2/events/bindings` | both | auth | List of bindings `{bindings}` |
| POST | `/api/v2/events/bindings` | both | LEAD/ADMIN | Upsert a binding by `source`+`chatKey`/`threadKey` (`eventBindingInputSchema`): `{source, chatKey?, threadKey?, sessionId?, mode: bound\|ephemeral\|queue, agentTemplate?, project?}`; a record matching by key is replaced (the id is preserved) → 200, otherwise 201 |
| DELETE | `/api/v2/events/bindings/:id` | both | LEAD/ADMIN | Delete a binding → 204 (its API keys are deleted cascadingly); no record → 404 `NOT_FOUND` |
| GET | `/api/v2/events/bindings/:id/keys` | both | LEAD/ADMIN | List of the binding's API keys `{keys}` — metadata only (`EventBindingApiKey[]`, without the secret and the hash; `label`, `description?`, `expiresAt?`, `rateLimitPerMinute?`, `revokedAt?`, `prefix`, `lastUsedAt`) |
| POST | `/api/v2/events/bindings/:id/keys` | both | LEAD/ADMIN | Create an API key (`eventBindingApiKeyCreateSchema`): `{label, description?, expiresAt?, rateLimitPerMinute?}` (`label` is required, globally unique per instance, case-insensitive) → 201 `EventBindingApiKeyCreated` = metadata + `key` (plaintext `synth_evt_<base64url>`, shown **only once**); no binding → 404 `NOT_FOUND`; duplicate label → 409 `CONFLICT`; invalid body → 400 `VALIDATION_ERROR` |
| PATCH | `/api/v2/events/bindings/:id/keys/:keyId` | both | LEAD/ADMIN | Update the key metadata (`eventBindingApiKeyUpdateSchema`): `{label?, description?, expiresAt?, rateLimitPerMinute?}`; `null` — reset the field, `undefined` — leave it untouched; a label change is checked for uniqueness → 200 `EventBindingApiKey`; no key → 404 `NOT_FOUND`; duplicate label → 409 `CONFLICT` |
| POST | `/api/v2/events/bindings/:id/keys/:keyId/revoke` | both | LEAD/ADMIN | Soft revocation of the key (sets `revokedAt`; idempotent) → 200 `EventBindingApiKey`; no key → 404 `NOT_FOUND`. A revoked key stops resolving (`resolveBySecret` → `null`) |
| DELETE | `/api/v2/events/bindings/:id/keys/:keyId` | both | LEAD/ADMIN | Delete an API key → 204; no record → 404 `NOT_FOUND` |
| GET | `/api/v2/events/routes` | both | auth | List of routing rules `{rules}` (`EventRouteRule[]`) |
| POST | `/api/v2/events/routes` | both | LEAD/ADMIN | Upsert a rule (`eventRouteRuleUpsertSchema`): `{id?, name?, priority?, enabled?, match, target}`; `match` — AND over the filled `source`/`type`/`chatKey`/`threadKey`/`principalId`/`label`/`keywords` (an empty-invalid one does not match); `target` — `bound`/`queue` (`sessionId`), `ephemeral` (`agentTemplate?`/`project?`/`ttl?`) or `bind` (ADR-089 auto-bind: `agentTemplate?`/`project?` — pin the chat/thread to a new session). By `id` — an update → 200, otherwise a creation → 201. Validation: `bound`/`queue` with a non-existent session → 400, a non-empty `agentTemplate` without an enabled agent → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/events/routes/:id` | both | LEAD/ADMIN | Delete a rule → 204; no record → 404 `NOT_FOUND` |
| GET | `/api/v2/events/journal` | both | auth | The latest journal entries of decisions `{entries}`; `?limit=` (default 50, cap 500) |

`identity` — `{principalId?, chatKey?, threadKey?, roles?}`. `dedupKey`/`ts` are optional:
`EventIngress` normalizes the event (id `evt_<uuid>`, the default dedup key by
source/type/key/payload). RBAC managed: ingestion — a binding key or `requireAuth` +
rate limit (120/min); mutations of bindings/rules/keys — `requirePermission('ADMIN','LEAD')`,
reading binding keys — LEAD/ADMIN, all other reads — `requireAuth`; in core — the single `requireAuth`.
**Service key scopes (ADR-052):** `POST /` — `events:ingest`; `GET /` (SSE) and `GET /journal` —
`events:watch`; the list/mutations of bindings — `bindings:read`/`bindings:write`; binding keys —
`keys:read`/`keys:write`; rules — `routes:read`/`routes:write`. If the key has
`allowedProjects` set, the project projection is applied to rules/bindings with a project dimension
(otherwise `403 PROJECT_FORBIDDEN`). Ingestion bindings/keys by binding key (`synth_evt_…`) — a separate
model (not a service key).
The per-key rate limit (`KeyRateLimiter`, a 60 s window) — the key's `rateLimitPerMinute`, otherwise
the global `events.keyRateLimitPerMinute` (0 — no limit) → 429 `RATE_LIMITED`; the master switch
`events.enabled: false` → 503 `UNAVAILABLE`. Runtime settings — `GET/PUT/DELETE /api/v2/settings/events` (§5.21).
Binding API keys (`EventBindingApiKey`, `{dataDir}/events/api-keys.json`, ADR-089/ADR-052):
several keys per binding, the secret is stored only as a sha256 hash and handed out once
at creation; a required globally unique (per instance) `label`, `description?`,
`expiresAt?`/`revokedAt?` (expiry/soft revocation), `rateLimitPerMinute?` (limit/min, otherwise the global
default `events.keyRateLimitPerMinute`, `0` — no limit). The keys are instance-local secrets,
not transferred by publish/fork (ADR-042/PROP-081).
Routing rules (`EventRouteRule`, `{dataDir}/events/routes.json`) are applied by `ProjectRuleProvider`
after an explicit `EventBinding` and cron rules; the Router fallback without a route is set by `events.autoBind`
(with `true` and an `identity.chatKey|threadKey` present — pin the event to a new session,
decision `{kind:'bind'}`, signal `auto-bind`), otherwise `events.defaultMode`
(`bound` — `drop no_route`, `ephemeral` — an ephemeral session). With `events.decisionRouting`, after
the declarative rules `DecisionRuleProvider` (ADR-084) kicks in: a successful decision carries
`confidence` and `signals` (`decision-rules`, `agent:<id>`, `model:<p/m>`, `latency:<ms>ms`) — they
end up in the response `decision` and the `GET /api/v2/events/journal` journal entry.
The processing chain and the journal — `docs/ARCHITECTURE.md` ("External events and hooks"), ADR-089.

> `POST /api/v2/sessions` now goes through the single funnel `RequestSessionService`
> (`engine/events/request-session.ts`, ADR-089): it emits `session_requested` + creates
> the session. The external contract of the endpoint has not changed.

### 5.27 Schedules — `/api/v2/schedules` (both, ADR-051 slice / ADR-089)

CRUD of scheduler schedules (the single factory `createSchedulerRoutes` for core and
backend). A firing does not create a session on its own:
the service publishes a normalized event `source: 'cron'`,
`type: 'schedule_fired'` through `EventIngress`, and routing is performed by
`SchedulerRuleProvider` (`RouteRuleProvider`). RBAC managed (backend): reads
(`GET`) — `requireAuth`; mutations (`POST`/`PUT`/`DELETE`) and a forced run
(`POST /:id/run`) — ADMIN only (`writeGuard = requireAdmin`); `run` is additionally
under a rate limit of 10/60 s (`runMiddleware`). In core (standalone) — the single `requireAuth`
for all methods. **Service key scopes (ADR-052):** `schedules:read` (reads and `GET /:id/jobs`),
`schedules:write` (`POST`/`PUT`/`DELETE`/`POST /:id/run`); the project projection — by the schedule
target (`bound`/`queue` → the session's project, `ephemeral` → `project`).

| Method | Path | Build | RBAC (managed) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/schedules` | both | requireAuth | List of schedules `{schedules}` |
| POST | `/api/v2/schedules` | both | ADMIN | Creation (`scheduleInputSchema`): `{name, enabled?, cron?, every?, target, prompt?, payload?, ownerId?}`; exactly one of `cron`/`every`; invalid → 400 `VALIDATION_ERROR`; → 201 `{schedule}` |
| PUT | `/api/v2/schedules/:id` | both | ADMIN | Update (the full body as in POST) → 200 `{schedule}`; no record → 404 `NOT_FOUND` |
| DELETE | `/api/v2/schedules/:id` | both | ADMIN | Deletion → 204; no record → 404 |
| POST | `/api/v2/schedules/:id/run` | both | ADMIN | Forced run (force, ingests an event with a unique dedup key; managed — rate limit 10/60 s) → 200 `{schedule}`; no record → 404 |
| GET | `/api/v2/schedules/:id/jobs` | both | requireAuth | Firing history `{jobs}` (`ScheduleJob[]`, ADR-051); `?limit=` (default 20, max 200); no schedule → 404; without a `JobStore` → `{jobs:[]}` |

`ScheduleJob` (`types/schedules.ts`): `trigger` (`cron`/`manual`/`catchup`),
`status` (`ok`/`error`/`skipped`), `startedAt`/`finishedAt`/`durationMs`, `target`,
`decision`/`reason` (routing: `drop no_route`, `busy`, `missed`),
`sessionId`, `error`.

`target` — a discriminated union: `{mode:'bound', sessionId}` |
`{mode:'ephemeral', agentTemplate?, project?, ttl?}` | `{mode:'queue', sessionId}`.
`cron` — 5 fields (UTC), `every` — `30s | 15m | 1h | 24h`. `nextRunAt` is computed
by the service; `catchUp` (`skip`/`once`, default `scheduler.catchUp`) controls the behaviour
on a firing missed at startup, the job history — `GET /:id/jobs`.

### 5.28 Service keys — `/api/v2/service-keys` (both, ADR-052 stage I)

The registry of **service keys** — scoped instance keys independent of binding keys
(ADR-089) for external services (messenger gateways, etc.). The single factory
`createServiceKeyRoutes` for core and backend; the store — `{dataDir}/service-keys.json`
(ADR-005, atomic write). The secret `synth_svc_<base64url>` is handed out **once**
at creation; at-rest — only the sha256 hash, in the list — `prefix`. RBAC: managed
(backend) — `ADMIN` only; core (standalone) — the single `requireAuth`.

| Method | Path | Build | RBAC (backend / core) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/service-keys` | both | ADMIN / auth | List `{keys}` — metadata without the secret and the hash |
| GET | `/api/v2/service-keys/scopes` | both | ADMIN / auth | Catalog for forms: `{scopes, families, roles}` — fine-grained scopes (`SERVICE_SCOPES`), wildcard families (`SERVICE_SCOPE_FAMILIES`) and roles (`GlobalRole`); the same guard as `GET /`. Clients build the options from the response (they do not compile the catalog into the bundle); the same guard, the declaration order — before `/:id` |
| POST | `/api/v2/service-keys` | both | ADMIN / auth | Create (`serviceApiKeyCreateSchema`): `{label, description?, roles?, scopes, allowedProjects?, rateLimitPerMinute?, expiresAt?}` → 201 `ServiceApiKeyCreated` = metadata + `key` (plaintext `synth_svc_<base64url>`, shown **once**); duplicate label → 409 `CONFLICT`; an invalid body/scope/role → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/service-keys/:id` | both | ADMIN / auth | Key metadata (`ServiceApiKey`); no key → 404 `NOT_FOUND` |
| PATCH | `/api/v2/service-keys/:id` | both | ADMIN / auth | Update (`serviceApiKeyUpdateSchema`): `{label?, description?, roles?, scopes?, allowedProjects?, rateLimitPerMinute?, expiresAt?}`; `null` — reset the field, `undefined` — leave it untouched; a label change is checked for uniqueness → 200; duplicate → 409 `CONFLICT` |
| DELETE | `/api/v2/service-keys/:id` | both | ADMIN / auth | Delete the key → 204; no record → 404 `NOT_FOUND` |
| POST | `/api/v2/service-keys/:id/revoke` | both | ADMIN / auth | Soft revocation (sets `revokedAt`, idempotent) → 200 metadata; afterwards the key does not authenticate; no key → 404 `NOT_FOUND` |

**Key fields** (`ServiceApiKey`, `@itphx/synth-shared`): `id` (`svk_<uuid>`),
`label` (required; globally unique per instance, case-insensitive),
`description?`, `roles: GlobalRole[]` (roles of the synthetic user; empty — the default `USER`),
`scopes: string[]` (the catalog + wildcard families, see §1), `allowedProjects?: string[]`
(project projection), `rateLimitPerMinute?` (the key's requests/min limit; 0/not set — no limit;
in managed it is enforced by the global `KeyRateLimiter` middleware → 429 `RATE_LIMITED`),
`expiresAt?`/`revokedAt?` (expiry/soft revocation), `createdBy`/`createdAt`/`lastUsedAt?`, `prefix`.
Keys are **instance-local** secrets (not transferred by publish/fork, ADR-042/PROP-081).

**Authentication.** `Authorization: Bearer synth_svc_…` → a synthetic user
`{ id: 'service:<keyId>', roles: key.roles }`; the context `{ scopes, allowedProjects?, rateLimitPerMinute? }`
is put into `serviceKey`. An invalid/unknown/revoked/expired secret → `401 UNAUTHORIZED`.
The key's roles are compatible with `requirePermission`, `scopes` — a fine-grained gate on top (`403 SCOPE_REQUIRED`);
with a non-empty `allowedProjects` the project projection is checked in sessions/events-bindings/schedules
(`403 PROJECT_FORBIDDEN`). Key management (CRUD) — `ADMIN` only in managed (the target
user path — the UI section "Service keys").

**Example.**

```bash
# Create a key (ADMIN). The secret will arrive once in the "key" field (synth_svc_…).
curl -X POST http://localhost:5000/api/v2/service-keys \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"label":"telegram-gw","roles":["USER"],"scopes":["events:ingest","sessions:create"],"allowedProjects":["proj_1"]}'

# Use the key as machine access (the events:ingest scope).
curl -X POST http://localhost:5000/api/v2/events \
  -H 'Authorization: Bearer synth_svc_<...>' -H 'Content-Type: application/json' \
  -d '{"source":"telegram","type":"message","payload":{"text":"ping"}}'
```

### 5.29 Webhooks — `/api/v2/webhooks` (both, ADR-052 stage II)

Subscriptions to **outbound** events (the reverse loop of event ingestion, ADR-089):
`WebhookService` subscribes to all bus events (`EventBus.subscribeAll`), filters them
by subscription patterns and sends HTTP POSTs to `url`. The single factory
`createWebhookRoutes` for core and backend; the store — `{dataDir}/webhooks/subscriptions.json`,
the delivery journal — `{dataDir}/webhooks/deliveries.jsonl` (ADR-005). The signing secret `whsec_<base64url>`
is **encrypted at-rest** (with the AES-256-GCM master key; HMAC requires the original secret) and handed out
**once** at creation/rotation; in the list — `secretPrefix`. The master switch `webhooks.enabled`
(default `false`) → mutations and `test` respond with 503 `UNAVAILABLE` (reads are available). RBAC:
managed (backend) — `ADMIN` only, core (standalone) — the single `requireAuth`.

| Method | Path | Build | RBAC (backend / core) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/webhooks` | both | ADMIN / auth | List of subscriptions `{subscriptions}` (metadata without the secret) |
| POST | `/api/v2/webhooks` | both | ADMIN / auth | Create (`webhookSubscriptionCreateSchema`): `{label, description?, url, events?, enabled?}` → 201 `WebhookSubscriptionCreated` = metadata + `secret` (plaintext `whsec_<base64url>`, shown **once**); an invalid body/URL → 400 `VALIDATION_ERROR`; a URL outside the `egress.webhooks` policy → 400; duplicate label → 409 `CONFLICT`; master off → 503 `UNAVAILABLE` |
| GET | `/api/v2/webhooks/:id` | both | ADMIN / auth | Subscription metadata; no subscription → 404 `NOT_FOUND` |
| PATCH | `/api/v2/webhooks/:id` | both | ADMIN / auth | Update (`webhookSubscriptionUpdateSchema`): `{label?, description?, url?, events?, enabled?}`; `null` for `description` — reset, `undefined` — leave untouched; a label change is checked for uniqueness → 200; no subscription → 404; duplicate → 409; a URL outside the `egress.webhooks` policy → 400 |
| DELETE | `/api/v2/webhooks/:id` | both | ADMIN / auth | Delete the subscription → 204; no record → 404 |
| POST | `/api/v2/webhooks/:id/regenerate` | both | ADMIN / auth | Rotation of the signing secret → 200 `WebhookSubscriptionCreated` (+ `secret` once); no subscription → 404 |
| POST | `/api/v2/webhooks/:id/revoke` | both | ADMIN / auth | Soft revocation (`enabled=false`, `disabledAt`; idempotent) → 200 metadata; no record → 404 |
| POST | `/api/v2/webhooks/:id/test` | both | ADMIN / auth | A test delivery of a synthetic event `webhook.test` (bypassing the filter and dedup) → 200 `WebhookDelivery`; no subscription/engine → 404; master off → 503 |
| GET | `/api/v2/webhooks/:id/deliveries` | both | ADMIN / auth | The subscription's delivery journal `{deliveries}` (`WebhookDelivery[]`); `?limit=` (default 50, cap 500); no subscription → 404 |

**Subscription fields** (`WebhookSubscription`): `id` (`whk_<uuid>`), `label` (required; globally
unique per instance, case-insensitive), `description?`, `url` (http(s) only; by default —
`https` plus the `egress.webhooks` address policy (ADR-099): `deny` of private/loopback addresses via `list`,
allowance via `exceptions`; `mode:"off"` — dev only, lifts the `https` requirement as well), `events: string[]` (patterns: an exact type
`stream.done` or a prefix `session.*`; empty — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), `enabled`,
`secretPrefix`, `createdBy`/`createdAt`, `lastDeliveryAt?`/`lastStatus?`, `disabledAt?`.
**Delivery:** POST `{id, type, createdAt, data}` with the headers `X-Synth-Event`/`X-Synth-Delivery`/
`X-Synth-Signature`; HMAC-SHA256 (`t=<unix>,v1=<hex>`, a timestamp window of 300 s); retry/backoff
(exponential with jitter, `webhooks.maxAttempts`), request timeout (`webhooks.timeoutMs`),
dedup by (subscription + event), journal + retention (`webhooks.deliveryRetentionDays`). A failure —
a `status:'failed'` record in the journal. Delivery goes through the shared egress layer: with a proxy enabled
the request uses it (`via` in the egress journal), while `noProxy` hosts go direct with the full address check. Configuration — `docs/CONFIGURATION.md` (the `webhooks` section); the design —
`docs/ARCHITECTURE.md` ("External events and hooks").

**Example.**

```bash
# Create a subscription (ADMIN). The secret will arrive once in the "secret" field (whsec_…).
curl -X POST http://localhost:5000/api/v2/webhooks \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"label":"ci-listener","url":"https://ci.example.com/synth","events":["session.*","stream.done"]}'

# Perform a test delivery and look at the journal.
curl -X POST http://localhost:5000/api/v2/webhooks/whk_<...>/test \
  -H 'Authorization: Bearer admin-key-123'
curl http://localhost:5000/api/v2/webhooks/whk_<...>/deliveries \
  -H 'Authorization: Bearer admin-key-123'
```

**Signature verification (the recipient).** The body is taken **raw** (before JSON parsing); from the header
`X-Synth-Signature` the `t` and `v1` are extracted, the window `|now - t| <= 300` is checked together with
`HMAC-SHA256(secret, "<t>.<rawBody>")` (constant-time). A Node.js example:

```js
const { createHmac, timingSafeEqual } = require('node:crypto');

function verify(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### 5.30 Public OpenAPI and SDK — `@itphx/synth-sdk` (ADR-052, stage III)

The public HTTP contract (the integration core: `events`/`sessions`/`schedules`/`llm`; 28 operations —
events 13, sessions 8, schedules 6, llm 1) is described by a declarative **public-OpenAPI 3.1** spec and served by `GET /api/v2/openapi.json`
(§5.4). Consuming it is more convenient through the published package **`@itphx/synth-sdk`** — a typed
client over that spec (a thin package, depending only on `@itphx/synth-shared`; ESM,
browser-compatible).

```bash
npm install @itphx/synth-sdk
```

```ts
import { createSynthClient, SynthApiError } from '@itphx/synth-sdk';

const synth = createSynthClient({
  baseUrl: 'http://localhost:5000', // without /api/v2
  serviceKey: 'synth_svc_…',        // or apiKey / token
});

try {
  // events / sessions / schedules / llm
  const { sessionId } = await synth.events.ingest({ source: 'tg', type: 'message' });
  const session = await synth.sessions.get(sessionId!);
  const jobs = await synth.schedules.jobs('<schedule-id>');
  const completion = await synth.llm.chatCompletions({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello' }],
  });
} catch (err) {
  if (err instanceof SynthApiError) console.error(err.status, err.code, err.message);
  throw err;
}
```

- **Auth:** the header `Authorization: Bearer <cred>` with the priority **serviceKey → apiKey → token**;
  the base path defaults to `/api/v2` (overridden by `apiPath`).
- **Namespaces:** `events` (ingest/journal/bindings/keys/routes), `sessions` (CRUD + prompt/messages/status),
  `schedules` (CRUD + run/jobs), `llm` (`chatCompletions`).
- **Errors:** `SynthApiError` (`{status, code, message, body?}`); a single format `{error:{code,message}}`,
  network failures → `status: 0` / `NETWORK_ERROR`. `fetch` injection — for tests/non-standard runtimes.

> The spec is the source of the contract; the SDK does not duplicate it in logic; details and status — ADR-052.

### 5.31 Instance maintenance — `/api/v2/maintenance` (both, ADR-091/ADR-092)

Admin API for instance maintenance: health (`synth doctor`), the data schema version and
migrations, backups and restore. The single factory `createMaintenanceRoutes` for core and
backend; the service layer — `packages/core/src/maintenance/service.ts`. RBAC: managed
(backend) — `ADMIN` only for reads and mutations; core (standalone) — the single `requireAuth`.
Archives are looked up strictly inside `{dataDir}/backups/` (including `backups/uploads/`);
the name is a basename `*.tar.gz` only, absolute paths from the client are not accepted. An
archive with `withSecrets` is **a secret itself**.

**Key semantics — restore is offline.** `POST /restore` does **not** perform a restore: it only
schedules it (the request `{dataDir}/maintenance/restore-request.json`, written atomically) and
responds `{pending, appliesOnNextStart: true}`. It is applied on the next instance start
(`applyPendingRestore`, before migrations). The data directory is not wiped under a live process.
Destructive operations (applying migrations, scheduling a restore) require `{confirm: true}`.

| Method | Path | Build | RBAC (managed / core) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/maintenance/status` | both | ADMIN / auth | Summary status: `{version, dataDir, schema:{current, expected, applied, pending}, backups, pendingRestore, doctor:{ok, fail, warn}}` |
| GET | `/api/v2/maintenance/doctor` | both | ADMIN / auth | A full `synth doctor` run: `{ok, checks:[{id, title, status, detail?, hint?}], dataDir, version}` (`ok: false` on any `fail`) |
| GET | `/api/v2/maintenance/migrations` | both | ADMIN / auth | Data schema state: `{current, expected, applied, pending:[{id, toVersion, description}]}` |
| POST | `/api/v2/maintenance/migrations/apply` | both | ADMIN / auth | Apply pending migrations; the body `{confirm: true}` is mandatory (otherwise 400 `VALIDATION_ERROR`); a safety copy is mandatory before writing (fail-closed), the application runs under a lock → 200 `{applied, safetyCopyPath?}`; data newer than the package → 409 `CONFLICT` (code `SCHEMA_TOO_NEW`) |
| GET | `/api/v2/maintenance/backups` | both | ADMIN / auth | List of archives `{backups}` (`MaintenanceBackupInfo[]`, newest first) |
| POST | `/api/v2/maintenance/backups` | both | ADMIN / auth | Take an archive: `{withSecrets?, withWorkspace?, live?}` (all default to `false`; `live` — a non-transactional snapshot of a running service) → 200 `MaintenanceBackupInfo`; the archive is written to `{dataDir}/backups/` (excluded from the archives themselves) |
| GET | `/api/v2/maintenance/backups/:name/download` | both | ADMIN / auth | Download an archive (streaming): `Content-Type: application/gzip`, `Content-Disposition: attachment`, `Content-Length`; an unsafe name → 400; no file → 404 |
| DELETE | `/api/v2/maintenance/backups/:name` | both | ADMIN / auth | Delete an archive → 204; an unsafe name → 400; no file → 404 |
| POST | `/api/v2/maintenance/restore/validate` | both | ADMIN / auth | Validate a restore archive: JSON `{archive}` (a name from `backups/`) **or** multipart `file` (uploaded into `backups/uploads/`); → 200 `{ok, problem?, manifest?}` (+ `staged` for uploads); exceeding the upload limit → 413 `PAYLOAD_TOO_LARGE`; an invalid body/name → 400; no archive → 404 |
| GET | `/api/v2/maintenance/restore` | both | ADMIN / auth | The pending restore request `{pending}` (`PendingRestoreRequest \| null`) |
| POST | `/api/v2/maintenance/restore` | both | ADMIN / auth | Schedule a restore: `{archive, confirm: true, safetyCopy?}` (`confirm` is mandatory; `safetyCopy` defaults to `true`) → 201 `{pending, appliesOnNextStart: true}`; an archive that fails validation → 400 `VALIDATION_ERROR`; no archive → 404 |
| DELETE | `/api/v2/maintenance/restore` | both | ADMIN / auth | Cancel the pending request → 200 `{cancelled}` |
| GET | `/api/v2/maintenance/restart` | both | ADMIN / auth | Graceful restart status (ADR-092): `{supported, mode:"disabled"\|"process"\|"supervisor", reason?, startedAt, version}`; `supported:false` — restart unavailable (the UI shows no button) |
| POST | `/api/v2/maintenance/restart` | both | ADMIN / auth | Graceful instance restart: `{confirm: true}` (otherwise 400 `VALIDATION_ERROR`) → **202** `{status:"restarting", restartId, mode, startedAt}`; the process exits with code **75** (a supervisor starts it again); a repeated call before the exit is idempotent (same `restartId`, 202); `disabled` mode → 409 `RESTART_UNSUPPORTED`; audit `restart.requested` (status `scheduled`, `details:{mode, restartId}`) |
| GET | `/api/v2/maintenance/audit` | both | ADMIN / auth | Maintenance journal: `{entries: MaintenanceAuditEntry[]}` (newest first); query `limit` (an integer 1..500, default 50) and `op` (operation kind); invalid `limit`/`op` → 400 `VALIDATION_ERROR`; the port is not wired → an empty list (not 500) |
| DELETE | `/api/v2/maintenance/audit` | both | ADMIN / auth | Clear the journal; the body `{confirm: true}` is mandatory (otherwise 400 `VALIDATION_ERROR`) → 200 `{cleared}`; the port is not wired → `{cleared: 0}` |

**`MaintenanceBackupInfo` fields:** `name` (basename), `path`, `bytes`, `createdAt`,
`schemaVersion` (from the manifest), `instanceVersion`, `withSecrets`, `withWorkspace`,
`entries` (the manifest record count), `encrypted?` (ADR-091: the archive is encrypted),
`metadataAvailable?` (for `.enc`: the sidecar metadata exists and is valid). **`PendingRestoreRequest`:** `archive` (an absolute path
only inside `{dataDir}/backups/`), `requestedBy?`, `requestedAt`, `safetyCopy`.

**Encrypted archives (ADR-091).** An archive taken with the CLI `synth backup --encrypt` is a
container `<archive>.tar.gz.enc` (+ a plaintext sidecar `<archive>.tar.gz.enc.meta.json` with a
summary and no paths/hashes). Such archives are listed by `GET /backups` (`encrypted: true`; if the
sidecar is missing or corrupted — `metadataAvailable: false`, "metadata unavailable"), and can be
downloaded and deleted via the API, but **cannot be restored via the API**: `POST /restore` on
`.enc` returns 400 `VALIDATION_ERROR` ("decryption is available only via the CLI"), and
`POST /restore/validate` returns `{ok:false, problem}`. Decryption is CLI-only
(`synth restore <archive>.enc`, an operator key); `POST /backups` does **not** support the
`encrypt` option — the server has no key.

**Maintenance audit journal (ADR-092).** A `MaintenanceAuditEntry` is an append-only lifecycle
record: `id` (`ma_<uuid>`), `ts` (ISO-8601), `op` (`backup.created`/`backup.failed`/
`backup.deleted`/`restore.scheduled`/`restore.cancelled`/`restore.applied`/`restore.failed`/`migrate.applied`/
`migrate.failed`/`update.applied`/`rollback.applied`/`update.failed`/`restart.requested`/`uninstall.purge`/
`export.created`/`import.applied`), `status` (`ok`/`failed`/`scheduled`), `actor?` (the initiator:
`userId` via API/UI, `cli` from the command line, `startup` when applied at start), `version?`
(`SYNTH_VERSION`), `details?` (fields depend on `op`), `error?` (when `status: failed`). Records are
written best-effort by the operations themselves (`recordMaintenanceAudit`) and served through the
domain port `MaintenanceAuditRepository` (`{dataDir}/audit/maintenance.jsonl`, ADR-096). RBAC is the
same as for the whole section: managed — `ADMIN`, standalone — `requireAuth`.

**Upload limit.** The multipart `POST /restore/validate` is capped by `storage.maxUploadBytes`
(default 100 MiB, `DEFAULT_MAX_UPLOAD_BYTES`); the DoS guard checks the declared `content-length`,
the `File` size and the bytes actually read — exceeding it → 413 `PAYLOAD_TOO_LARGE`.

**Error codes.** 400 `VALIDATION_ERROR` (an invalid body/archive name, a missing `confirm: true`,
an archive that fails validation), 404 `NOT_FOUND` (no archive/record), 413 `PAYLOAD_TOO_LARGE`
(the upload limit is exceeded), 409 `CONFLICT` with the code `SCHEMA_TOO_NEW` (data newer than the
Synth version when applying migrations) or `RESTART_UNSUPPORTED` (`SYNTH_RESTART_MODE=disabled` —
restart unavailable), 401/403 (no credentials/insufficient rights). A successful `POST /restart` is
**202** (the request is accepted; the process exits in ~50 ms).

**Example.**

```bash
# Summary status and a full synth doctor (ADMIN).
curl http://localhost:5000/api/v2/maintenance/status -H 'Authorization: Bearer <ADMIN_TOKEN>'
curl http://localhost:5000/api/v2/maintenance/doctor -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Take an archive (without secrets and workspaces) and download it.
curl -X POST http://localhost:5000/api/v2/maintenance/backups \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"withSecrets":false,"withWorkspace":false,"live":false}'
curl -OJ http://localhost:5000/api/v2/maintenance/backups/<name>.tar.gz/download \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Validate an archive and schedule a restore (applied on the next start).
curl -X POST http://localhost:5000/api/v2/maintenance/restore/validate \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"archive":"synth-backup-<instanceVersion>-<stamp>.tar.gz"}'
curl -X POST http://localhost:5000/api/v2/maintenance/restore \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"archive":"synth-backup-<instanceVersion>-<stamp>.tar.gz","confirm":true}'

# Apply schema migrations (irreversible; a safety copy is mandatory before writing).
curl -X POST http://localhost:5000/api/v2/maintenance/migrations/apply \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' -d '{"confirm":true}'

# Cancel the pending restore.
curl -X DELETE http://localhost:5000/api/v2/maintenance/restore \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Read the maintenance journal (last 5 entries).
curl 'http://localhost:5000/api/v2/maintenance/audit?limit=5' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Restart the instance (graceful shutdown, exit 75 → a supervisor starts the process again).
curl http://localhost:5000/api/v2/maintenance/restart -H 'Authorization: Bearer <ADMIN_TOKEN>'
curl -X POST http://localhost:5000/api/v2/maintenance/restart \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"confirm":true}'
```

**UI.** The "Maintenance" section (Settings → "Maintenance", `ADMIN` only) is built on these same
endpoints (`packages/ui/src/components/settings/MaintenanceSettings.tsx`, the API domain
`packages/ui/src/lib/api/maintenance.ts`): status/`synth doctor`, schema and migrations, backups,
restore, and **"Restart"** (mode status, confirmation, an overlay and polling `GET /health` until
`startedAt` changes, then a reload). Procedures and security rules —
[docs/MAINTENANCE.md](../MAINTENANCE.md) (in Russian).

---

## 6. Sources

| Component | File |
|---|---|
| Backend app + middleware + SSE/WS | `packages/backend/src/app.ts` |
| Backend routes | `packages/backend/src/routes/*.ts` |
| Backend auth/RBAC | `packages/backend/src/auth/middleware.ts`, `auth/oidc.ts` |
| Service key scopes (ADR-052) | `packages/core/src/server/service-scope.ts`, `packages/backend/src/auth/service-scope.ts` |
| Service key store/routes (ADR-052) | `packages/core/src/storage/service-api-key-store.ts`, `packages/core/src/server/routes/service-keys.ts` |
| Public OpenAPI (ADR-052, stage III) | `packages/core/src/server/openapi/public-openapi.ts` |
| Public API SDK (ADR-052, stage III) | `packages/sdk/*` (`@itphx/synth-sdk`) |
| Webhooks store/journal/routes/engine (ADR-052) | `packages/core/src/storage/webhook-store.ts`, `packages/core/src/storage/webhook-delivery-store.ts`, `packages/core/src/server/routes/webhooks.ts`, `packages/core/src/engine/webhooks/*` |
| Instance maintenance admin API (ADR-091/ADR-092) | `packages/core/src/server/routes/maintenance.ts`, `packages/core/src/maintenance/*` |
| EventHub | `packages/backend/src/events/hub.ts` |
| Rate limiter | `packages/backend/src/middleware/rate-limiter.ts` |
| Core standalone app + SSE/WS | `packages/core/src/server/app.ts` |
| Core routes | `packages/core/src/server/routes/*.ts` |
| Core auth | `packages/core/src/auth/local.ts` |
| Contracts (`BusEvent`) | `packages/shared/src/types/index.ts` |
