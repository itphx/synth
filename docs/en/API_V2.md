# API v2 — reference

> 🌐 **English** · [Russian](../API_V2.md)

> ⚠️ RU-версия обновлена 2026-11-08 (**§5.5** — `POST /sessions/import`: дедупликация по маркеру
> `import.source_session_id` (200 при обновлении, `updated:true`; 201 при создании), область дедупа;
> новый `POST /sessions/import-batch` (1..200 сессий, один хит лимита, `details` при ошибке элемента);
> **§5.8** — перенос сессий при publish уровнями зависимостей (чанки по 20 сессий —
> `IMPORT_BATCH_CHUNK`, один хит лимита на запрос) с таймаутом переноса 120 с
> (`TRANSFER_TIMEOUT_MS`) и фоллбеком на поштучный импорт с текущего чанка;
> **§5.8** — новый `GET /projects/:id/publish/progress` (прогресс публикации
> опросом: процент/фазы/счётчики, in-memory, TTL 10 мин, `remote:`-id → 400);
> **§5.21** — `GET/PUT/DELETE /api/v2/settings/limits`
> (`limits.sessionOpsPerMinute`) — **переведено**).

> ⚠️ RU-версия обновлена 2026-11-08 (**§1** — новый блок «Единый fail-closed гейт на границе `/api/v2/*`»:
> `app.use('/api/v2/*', requireAuth)` + allowlist публичных путей (`app/public-routes.ts`, строго
> метод+путь), порядок middleware (service-key/plugin-bound работают), перепись доступа
> `route-access-census.test.ts` — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-08 (**ADR-130** (бывший PROP-054) — **§5.8.2** (новая секция): план/журнал/
> инварианты проекта — эндпоинты, версия плана (409 `PLAN_VERSION_CONFLICT`), лимиты Markdown, RBAC,
> события; **§5.8** — в детали проекта поля `log` **больше нет** (журнал — постранично),
> примечание о переносе журнала в гибриде (fork — страницами, publish — не переносится);
> **§5.8.1** — журнал в портативном архиве (round-trip без потерь); **§5.5** — ToDo сессии
> (`/sessions/:id/todos*`); **§3.3** — payload'ы `plan.updated` (`{project_id, version}`),
> `project.updated` (`{project_id, kind:'log'|'invariants'}`), `todos.updated` (`{todos}`);
> **§5** — пагинация журнала в общем блоке; **§5.30** — namespaces SDK (план/журнал/инварианты/ToDo)
> — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-08 (**ADR-130** — **гибрид**: §5.8.2 (план/журнал/инварианты) и §5.5
> (ToDo) удалённой сущности **форвардятся** на удалённый backend (права/валидация — там; ответ
> удалённой стороны — как есть, `204` — пустое тело, `502 OFFLINE`/`401 UNAUTHORIZED` на ошибках
> транспорта, без клиента — `502 REMOTE_UNAVAILABLE`) — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-03 (**§5.12** — `GET /api/v2/fs/raw`: inline-allowlist
> (`INLINE_PREVIEW_KINDS`), MIME по расширению, SVG-CSP, `Range`/206, `ETag`/304, cap
> `storage.maxPreviewBytes` → `413 FILE_TOO_LARGE` — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-03 (**пагинация списков** — §5 (сводный блок «Пагинация списков — единый
> контракт»: массив → страница `{items, total, offset, limit, next_offset}` для `GET /sessions`,
> `GET /projects`, `GET /projects/:id/pipelines`, `GET /projects/:id/pipelines/:pid/runs`,
> `GET /pipelines/instances`, `GET /models`; `GET /sessions/:id/messages` → `{messages, session_id,
> has_more, next_before}`; **§5.5** — список сессий/деталь без истории, `messages` в DTO нет; **§5.8** —
> сводка проекта без `log`/`plan`, `total_messages` в `/projects/:id/stats` удалён; **§5.10** — каталог
> моделей плоский и постраничный, фильтры `search`/`enabled`/`modality`; **§5.12** — cap чтения файла
> `storage.maxReadBytes` → `413 FILE_TOO_LARGE` + `details`, `maxDepth` ≤ 3, бюджет 10 000 записей +
> `truncated`; **§5.15** — обрезка diff коммита > 1 МиБ → `diff_truncated`; **§5.34/§5.35** — пагинация
> пайплайнов/прогонов и постраничный журнал прогона (`events_limit`/`events_before`) — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-03 (**§5.9/§5.10** — `compatibility`: поля `supportsNativeVideo`/
> `nativeAudioFormats` — нативные видео/аудио (ADR-117 × ADR-115); семантика «авто / явный `false` /
> явный пустой список»; объект `compatibility` — полная замена — **переведено**).
> ⚠️ RU-версия обновлена 2026-11-02 (**§3.3** — события синхронизации мутаций
> `message.deleted`/`message.updated`/`session.messages.cleared`/`session.messages.merged`/
> `project.updated`/`project.deleted`/`plan.updated`/`fs.changed` — **переведено**; **§5.5** — `PATCH /api/v2/sessions/:id` с телом
> `{"title": ""}` — регенерация имени по диалогу (синхронно, ответ — DTO сессии;
> при неудаче заголовок прежний, ответ 200; в гибриде тело проксируется удалённому
> серверу) и блок «Авто-заголовок сессии (`session.autoTitle`)» — триггер в начале хода,
> отсрочка для приветствия/смолтка, `N=2..maxAttempts` по диалогу, фоллбек только из
> реплики с сигналом — **переведено**); RU-версия обновлена 2026-10-31 (ADR-118: поток сообщений v2 — контракт приёма `202`,
> события `message.accepted`/`queue.state`/`message.delivered`/`turn.*`/`step.*`/`part.*`,
> `GET /api/v2/meta`, удаление `stream.chunk|usage|done|interrupted`, `message.queued|injected`);
> перевод отстаёт — канонический текст: RU §3.3, §5.4, §5.5, §5.6. **Переведено 2026-10-31:**
> §5.5 — DTO сессии `current_stream.turn_id` (метка живого хода; восстановление хода после
> reload), §5.6 — «финал хода = последний шаг» (текст/reasoning только последнего шага,
> tool-результаты в сообщении своего шага, `metadata.intermediate_text_blocks` не пишется,
> `usage` сообщения — расход **своего** вызова провайдера (шага), сумма по сообщениям хода =
> расход хода; `step.finished.usage` — своего шага). **Старая история не мигрируется** (у старых
> ходов usage финала — сумма, шаги без usage).
> **Переведено 2026-10-31 (продолжение):** §3.3 — `queue.state.items` (элементы очереди
> `{id, status: 'queued'|'starting'}` без текста и автора) и правила публикации `queue.state`;
> §5.5 — DTO сессии `activity` (`idle`/`busy`/`retry`, приоритет, персистентность, миграция `030`).
> ⚠️ RU-версия обновлена 2026-11-02 (**§5.4** — аддитивное `attachments` в `GET /api/v2/meta`; **§5.6.1** — `413` несёт `error.details.maxBytesPerFile`); §5.4 переведён; §5.6.1 — в EN переведена **часть про chunked-загрузку** (лимиты `maxBytesPerSession` для активных загрузок, `maxActiveUploadsPerSession`/`maxActiveUploads`), полная секция — RU; **перевод отстаёт**.
> ⚠️ RU-версия обновлена 2026-10-30 (**§5.5** — `stream.done.step_limit_reached` / `metadata.step_limit_reached` и статус `limit` (`session.steps_limit`); **§5.5** — `message.queued` как подтверждение приёма (`message_id` = `stream_id`) и дельты `subagent.progress` (`content_delta`/`reasoning_delta`), уточнение «UI-переключателя режима больше нет» (ADR-104); **§5.6** — подпись thinking хранится по блокам (`Part.metadata`/`reasoningBlocks`, `91be3f89`), `content` без reasoning при наличии `parts`; **§5.10** — `compatibility` модели (ADR-117) и `requires_reasoning` как shorthand; **§5.9** — `compatibility` провайдера — **переведено**); RU-версия обновлена 2026-10-27 (§5.26 — «Вложения события» (`attachments[]`), ADR-115 × ADR-089) — **переведено**; RU-версия обновлена 2026-10-26 (ADR-112/ADR-111/PROP-096/097: **§5.5** — вопросы пользователю (`GET/POST /api/v2/sessions/:id/questions*`) и steering дочерней сессии саб-агента; **§3.2 «Фоновые прогоны и вопросы пользователю»** — перечень серверных событий `user_question.*`/`process.*`/`child.*`; **§5.39 «Фоновые прогоны»** — `/api/v2/processes*` (реестр фоновых прогонов: список/деталь/лог/stop/удаление; граничный guard, инварианты 16/21; деградированный режим хранилища — контур не монтируется, 404)) — **переведено**; RU-версия обновлена 2026-10-25 — **переведено**: §5.36 «Плагины» (ADR-090), §5.38 «Память» (ADR-107: портал + мутации индексов, М2; проектная авторизация портала — инвариант 16; **инстансные индексы** — `scope: 'project'|'instance'`; **секреты и egress** — обфускации при индексации нет, исключения секретов, локальные эмбеддинги), §5.5 `GET /sessions/:id/memory` для вкладки «Память»; **перевод отстаёт** (§5.6.1 — ADR-115, вложения сообщений, staging-загрузка и лимиты; §5.32 — ADR-102, аналитика и отчётность; §5.33 — ADR-100, пакеты расширений; §5.37 — ADR-105, внешние доступы — разделов в EN-файле нет).

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
   `Authorization: Bearer <SYNTH_API_KEY>` → user `api` with the roles from
   `auth.apiKeyRoles` (env `SYNTH_API_KEY_ROLES`, default `['USER']`; ADMIN only
   with an explicit setting). The key comparison is constant-time.

Roles: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

**Service key: scopes and project projection (ADR-052).** The key roles make it compatible
with `requirePermission` (RBAC endpoints), while `scopes` are a fine-grained gate on top: if the
context carries a service key, the route requires at least one of its scopes (otherwise
`403 SCOPE_REQUIRED`). For interactive credentials (cookie/debug/OIDC/API key/local
key) the scope gate is a no-op (the request passes through). Scope catalog: `events:ingest`,
`events:watch`, `bindings:read|write`, `keys:read|write`, `routes:read|write`,
`sessions:create|read|prompt`, `schedules:read|write`, `llm:chat`, `addons:install`,
`automation:install`, `users:read` + wildcard families
`events:*`, `bindings:*`, `keys:*`, `routes:*`, `sessions:*`, `schedules:*`
(there is no global `*`; `automation` is deliberately **not** a wildcard family — a
wildcard `automation:*` would silently cover future `automation:*` scopes unrelated
to package installation). Separately: on some routes (writing the MCP registry, writing
skills, reading the admin user API) a scope works as an alternative to the ADMIN role
(“ADMIN **or** scope”, see §5.14/§5.16/§5.17). Project projection `allowedProjects`: if the key has a
non-empty list, only the projects in it are accessible — it applies to sessions,
events/bindings and schedules (otherwise `403 PROJECT_FORBIDDEN`); empty/absent —
the instance policy. The per-route scope application points — in §5.5, §5.26, §5.27, §5.23.

**Umbrella scope `automation:install` (ADR-052).** The scope of the extension-package
installer: agents and their role prompts, pipelines, plus the routing rules and
schedules generated by the package. Where a package writes its artifacts,
`automation:install` is an **alternative** to the resource scope: **any one** of the
pair is enough (`routes:write` **or** `automation:install` for routing rules,
`schedules:write` **or** `automation:install` for schedules; for writing agents —
`automation:install` only). `addons:install` does **not** open agent creation. On
the agent-writing routes the “role ADMIN **or** scope” guard
(`requireAdminRoleOrScope`) also takes the `ADMIN` role among the key roles into
account — the umbrella scope takes nothing away (unlike `requireAdminOrScope`,
where **only** the scopes are checked for a service key). The exact sets are
`SERVICE_SCOPE_SETS` (`packages/shared/src/types/service-keys.ts`).

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

### Single fail-closed gate on the `/api/v2/*` boundary (F6)

Access to the whole API tree is checked **at the application boundary**: in
`packages/backend/src/app.ts`, after `attachUser` and the `/auth` routes (and
before the plugin-bound guard, the storage-degradation guard and route
mounting), `app.use('/api/v2/*', requireAuth)` is mounted. Public paths are
listed explicitly — `PUBLIC_API_V2_PATHS` / `isPublicApiV2Path`
(`packages/backend/src/app/public-routes.ts`), **strictly by method+path**
(prefix wildcards are forbidden). Today only `GET /api/v2/health`,
`GET /api/v2/meta` (ADR-118 §8) and `GET /api/v2/i18n/current`,
`GET /api/v2/i18n/translations/{ru,en}` are public; `OPTIONS` (CORS preflight)
is answered by the CORS middleware before the gate and is allowed explicitly.

Consequences:

- a new router mounted without a guard **does not become anonymous** — it
  requires authentication by default; to open a path, add it to the allowlist
  (and to the census);
- authentication checks are not duplicated inside handlers (invariant 16) —
  they keep only RBAC/access scope;
- an unknown path under `/api/v2/*` without credentials also returns `401`;
  `404 NOT_FOUND` is returned only after the gate is passed (`app.notFound`
  behaviour is unchanged);
- the middleware order (`attachUser` → per-key rate limit → gate →
  `requirePluginTokenBinding` → degradation guard → routes) keeps service keys
  and plugin-bound keys working (ADR-052/ADR-090 §7).

Census — `packages/backend/src/app/route-access-census.test.ts`: on a really
mounted `createBackendApp()` every `/api/v2/*` route without credentials →
`401 UNAUTHORIZED`; every `:param` route is matched **both ways** against the
explicit `DECLARED_PARAM_ROUTES` registry (access rule + place of
implementation); for each route a negative "foreign `USER` on a missing id"
probe (never `2xx`, never `500`; allowed codes are fixed in the registry entry).
A new or removed route fails the test with a diff.

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
| `CONFLICT` | MCP server duplicates, retry state, `steer` of the current-turn message (ADR-104) |
| `ALREADY_EXISTS`, `IS_DIRECTORY`, `DIR_NOT_EMPTY`, `PATH_TRAVERSAL`, `PERMISSION_DENIED` | filesystem |
| `WORKSPACE_OUTSIDE_ROOT_DENIED`, `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`, `WORKSPACE_CREATE_FAILED`, `WORKSPACE_POLICY_READ_ONLY`, `WORKSPACE_ROOT_NOT_CONFIGURED`, `PROTECTED_PATH_DENIED`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_SET`, `NOT_A_DIRECTORY` | workspace/filesystem (ADR-075) |
| `git.ssh_key_required`, `git.repo_path_invalid`, `git.repo_exists` | git registry (ADR-076, shared form) |
| `sshkey.not_found`, `sshkey.name_exists`, `sshkey.decrypt_failed`, `sshkey.encryption_unavailable`, `sshkey.env_failed` | agent SSH keys (ADR-076) |
| `PROJECT_NOT_FOUND`, `NOT_AVAILABLE` | sessions/settings |
| `RATE_LIMITED`, `QUEUE_FULL` | rate limits and the queue |
| `STEER_LIMIT_EXCEEDED` | message sending modes (ADR-104) |
| `NO_ACTIVE_TURN` | `POST /api/v2/queue/:sessionId/steer` with no running turn (ADR-104) |
| `INVALID_ACTION`, `INVALID_MESSAGE_IDS` | message batch operations (ADR-118 §7) |
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
  It supports the client messages `ping`→`pong`, `cancel`,
  `permission_reply`, `permission_hold`. EventHub automatically subscribes
  the client to all of the user's sessions.
- Core standalone: the same WS `/ws/events` and SSE `/api/v2/events`.
- Both send the keepalive comment `:keepalive` every 30 s.

> Event transport — only WS `/ws/events` and SSE `GET /api/v2/events`.
> Do not create new channels (ADR-008/009/024).

> ⚠️ **Outdated (ADR-118): the message stream is v2.** `stream.chunk`, `stream.usage`,
> `stream.done`, `stream.interrupted` and `message.queued`/`message.injected` are **removed**
> (no dual-emit). Instead: `part.delta`/`part.updated`, `step.finished` (usage, timings,
> `attachments`), `turn.started`/`turn.finished`, `message.accepted` (addressed), `queue.state`
> (counters only), `message.delivered`. The acceptance contract is
> `POST /api/v2/sessions/:id/prompt` → **`202 {messageId, mode, position}`** (no `text/event-stream`).
> Canonical text: RU §3.3 «Message stream v2»; instance capabilities — `GET /api/v2/meta` (§3.3 below).
> Old clauses below this note describe the pre-v2 protocol and are kept only as history.

### 3.1. Permission approvals (ADR-106 F3)

The approval request (`permission.asked`) and the reply to it (`permission.replied`) travel over
WS `/ws/events`. A reply is accepted only from the **holder of a covering grant** (session owner,
project `EDITOR`/`OWNER`, `ADMIN`/`LEAD`, service key with a matching role) — **not** from "whoever
can see the session": a `VIEWER` (read-only access) cannot approve a mutating tool.

**`permission.asked` event** (approval request) — additional fields:

| Field | Type | Purpose |
|---|---|---|
| `principal` | `{kind, id, roles}` | the turn principal the request is addressed to (ADR-106 F0) |
| `turn_id` | string | the turn (`streamId`) the request belongs to |
| `digest` | string | binding fingerprint "turn + action + target" (sha256) |

**Client message `permission_reply`**:

```json
{ "type": "permission_reply", "session_id": "<sid>", "approval_id": "<aid>",
  "action": "allow" | "deny", "once": true | false,
  "turn_id": "<turn>", "digest": "<digest>" }
```

- `action` — the decision (`allow`/`deny`); the legacy `{approved: boolean}` form is still supported;
- `turn_id`/`digest` — optional: a mismatch with the binding rejects the reply
  (`turn_mismatch`/`digest_mismatch`);
- the client is never trusted: the replying principal is taken from the **authenticated** WS connection.

**`permission.replied` event** — on an accepted reply: `approved`, `action`, `principal`, `turn_id`,
`digest` (the binding comes from the server-side registry). On a **rejection** — `approved: false`,
`action: 'deny'` and a `reason` field:

| `reason` | Rejection cause |
|---|---|
| `no_grant` | the replier does not hold a covering grant (incl. a `VIEWER` on a mutation) |
| `already_consumed` | a repeated reply to the same `approval_id` (an approval is one-shot) |
| `turn_mismatch` | a reply with a foreign `turn_id` (another turn) |
| `digest_mismatch` | a reply with a foreign `digest` (binding substitution) |
| `unknown_approval` | unknown `approval_id` |

At the same time the client receives an error frame:

```json
{ "type": "error", "session_id": "<sid>",
  "data": { "error": "<text>", "code": "APPROVAL_DENIED" }, "timestamp": "<ISO>" }
```

The approval registry only exists in the Authority layer's **enforced** mode (`authority.enabled`
without `authority.shadow`); in shadow/disabled mode the reply is accepted as before (by session
visibility) — see [ADR-106](../arch_decisions/adr-106-authority-layer.md) (in Russian).

### 3.2. Background runs and user questions

The events of the background work and of the "ask the user" flow are published in the
**owner session channel** (`EventBus.publish(sessionId, …)`, ADR-009) — no new transport
channels are introduced (ADR-024).

| Event | When | `data` fields |
|---|---|---|
| `user_question.asked` | the agent asked a question and waits for an answer | `question_id`, `session_id`, `questions[]`, `created_at`, `expires_at?` (only when a deadline is set — the UI renders the countdown from it), `turn_id?`, `tool_call_id?`, `agent_role?` |
| `user_question.answered` | the user answered | `question_id`, `session_id`, `answers[][]` |
| `user_question.cancelled` | the question was cancelled (timeout, "Stop", a manual cancel) | `question_id`, `session_id`, `reason` |
| `process.started` | a background shell command was started (`kind:'process'`) | `process_id`, `session_id`, `command`, `cwd`, `pid?`, `background_run_id`, `log_path` |
| `process.exited` | the background process finished | `process_id`, `session_id`, `state` (`completed`/`failed`/`cancelled`/`orphaned`), `exit_code?`, `signal?`, `background_run_id` |
| `process.stopped` | a stop of the background process was requested (once per run) | `process_id`, `session_id`, `background_run_id`, `reason` |
| `child.completed` / `child.failed` / `child.cancelled` | a background subagent finished (success/error/cancel; `kind:'subagent'`) | `child_session_id`, `parent_session_id`, `state`, `background_run_id`, `description` |

The `user_question.*` prefix is deliberately **not** `question.*`: `question.asked` is already
taken by the meaning "the queue is stuck". The `process.stopped` event is published by the core
on a successful stop request (`POST /api/v2/processes/:id/stop`, `reason` — the stop reason);
the terminal status of the run arrives later — with the `process.exited` event (for a stopped
process `state: 'cancelled'`).

### 3.3. Message stream v2 (ADR-118) — summary

A turn is a sequence of steps: `Turn` (`turnId`) → `Step` (one LLM call = one assistant message,
`messageId` + `stepIndex`) → `Part` (`partId`: `msg:text:<ordinal>` for text, `callId` for a tool
call). Ordering is a separate monotonic field `Message.ord`; the positional `seq` stays for
compatibility. The full description, payloads and edge cases are in the Russian canonical
[§3.3](../API_V2.md) (section «3.3. Поток хода v2») — use it as the source of truth.

| Event | Channel | Payload |
|---|---|---|
| `message.accepted` | **addressed** (`recipient` = sender `userId`) | `messageId`, `mode`, `position` — no text |
| `queue.state` | session channel | `pendingCount`, `steerCount` — **counters only**: no text, no author; `items?` — queue elements with their state (`{id, status: 'queued'\|'starting'}`), **no text and no author** (the element id is the message stream id, `metadata.stream_id`; for the message being processed it matches `current_stream.stream_id`) |
| `message.delivered` | session channel | `messageId`, `ord`, role, author — no content |
| `message.deleted` | session channel | `message_id` — message removed from history (`DELETE /messages/:sessionId/:messageId`, batch `action:'delete'`, queue return `POST /queue/:sessionId/return`); one event per actually removed message |
| `message.updated` | session channel | `message_id`, `pinned?`, `disabled?` — pin/toggle/batch/retry (retry disables messages from the retry point); patched by `id`, live parts are untouched |
| `session.messages.cleared` | session channel | `session_id` — `POST /sessions/:id/clear`: history cleared (pinned kept), queue reset (`queue.state {0,0}` follows); the client refetches the snapshot |
| `session.messages.merged` | session channel | `messages` (added messages; may be absent) — `POST /sessions/:id/messages/merge` |
| `plan.updated` | channel of **every session of the project** | `project_id`, `version` — the project plan changed (the `plan_write` tool or an HTTP plan operation); the client refetches the project **detail** |
| `todos.updated` | session channel | `todos` — the current task list of the session (`TodoItem[]`: `id`/`content`/`status`/`priority`/`planItemId?`), `session_id` — the session that owns the list; published after every ToDo mutation (a `todo_*` tool or an HTTP `/sessions/:id/todos*` operation); the client refetches the list (a subagent's list belongs to **its own** session) |
| `project.updated` / `project.deleted` | channel of every project session | `project_id` — `PUT`/`DELETE /projects/:id` (deletion is published before removal, while sessions are still enumerable); `project.updated` also carries `kind` (`log`\|`invariants`) — the project journal or the invariants changed |
| `turn.started` / `turn.finished` | session channel | `turnId`, terminal status |
| `step.started` / `step.finished` | session channel | `turnId`, `stepIndex`, `messageId`, `usage`, `timings`, `attachments` |
| `step.tools.started` / `step.tools.finished` | session channel | `turnId`, `stepIndex`, `messageId`, `callIds` (`string[]`) — additive: `step.finished` means “the LLM call is done”, these events mark the **tool execution** of that step (published once per step with tool calls, before execution and after `metadata.tool_results` is written) |
| `part.delta` / `part.updated` | session channel | upsert by `{messageId, partId}` |
| `stream.error` | session channel | `stream_id`, `error`, `error_type`, `retry_count`, `can_retry`, plus **additive** `message_id` (id of the user message whose turn failed) and `turn_id?` (turn id from `current_stream.turn_id`, captured before the stream is cleared) — lets the client attach the error banner to that message/turn |

**Context compression (ADR-119).** Compression events go to the session channel; no new channels.

| Event | `data` fields |
|---|---|
| `context.summarization_pending` | `reason` (`messages`\|`tokens`), `mode` (`summarization`\|`compaction`), `current_tokens?`, `threshold?`, `user_count?` — the trigger fired, compression waits for the next turn |
| `context.summarization_applied` | `reason` (`auto`\|`manual`\|`overflow`), `mode`, `covered_indices` (`number[]`), `keep_from` (id of the first live message \| `null`), `usage?`, `insufficient?` (`true` — compression was applied but the trigger threshold was **not** cleared: the context is still over the limit; the session goes into a 10-minute compression cooldown), `phase?` (`'mid_turn'` — compression applied at a step boundary inside the turn (ADR-128); the field is absent for end-of-turn / overflow / manual compression) — published on the normal path and on overflow; the client clears the pending state and refetches the history (last page) |
| `context.summarization_failed` | `reason` (`validation` — the model response did not match the template; `no_coverage` — there was nothing to compress; `overflow` — compression did not relieve the context overflow; `error` — any other error), `message` (localized error text), `mode` (`summarization`\|`compaction`), `phase?` (`'mid_turn'` — compression at a step boundary; `'overflow'` — on context overflow; the field is absent for end-of-turn / manual compression). A failed compression is **visible to the user**: the client clears the pending state and shows a warning with the `message` text (ADR-128) |
| `context.sliding_window_applied` | `reason`/`trigger_type`, `disabled_indices` (`number[]`) — `sliding_window` disabled older messages (no summary) |

Any mutation visible to another client publishes an event: `message.deleted`/`message.updated`
(messages), `session.messages.cleared`/`session.messages.merged` (history),
`project.updated`/`project.deleted` (project — to the channel of each of its sessions),
`plan.updated`, and `fs.changed` (workspace, including HTTP FS with `source: 'http'`). Clients must
handle them, otherwise the feed “sticks” after another client's action.

`queue.state` is published when messages are enqueued or removed and at turn boundaries — the text
and the author do not reach the session channel (this removes the former `message.queued` leak).
The element states (`items`: `queued`/`starting`) carry no text and no author either: an element
taken into work (`starting`) is the queue transition at the start of a turn.

Event journal and resume: every event gets a monotonic `eventSeq` that is global for the
instance (across all session channels); a client resumes
with `Last-Event-ID` / `?since=` (SSE frames carry `id: <eventSeq>`).

**`GET /api/v2/meta`** (no authentication, like `/health`) returns the instance capabilities:
`{messageModel, eventSeq, replay, version}`. Additive `attachments` (ADR-115):
`{enabled, modalities, maxBytesPerFile, maxFilesPerMessage, maxBytesPerSession}` — the **effective**
attachment settings (env > runtime > config > defaults, the same resolver as `AttachmentService`); the
client uses them for pre-checks and error texts, the server stays the source of truth. Additive
`features` (ADR-125, **backend only**): `{remoteMcp?: boolean}` — the marker of the support of
`/api/v2/mcp/remote/*` and the relay mode; an old backend has no field → the feature is silently off
(fail-closed). A client compares `messageModel` **before** connecting
and does not connect on mismatch (**fail-closed** — silent degradation is forbidden); the server
enforces the same gate (WS close `1008`, SSE `426`). Legacy `sessions/:id/prompt` returning
`text/event-stream` and the `send_message` WS frame no longer exist.

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

> **List pagination — a single contract (owner decision, 2026-11-03; a breaking change).**
> The lists that used to be returned as an **array** are now returned as a **page** — an object
> `{<items>, total, offset, limit, next_offset}`:
>
> | Endpoint | Before | After |
> |---|---|---|
> | `GET /api/v2/sessions` | an array of sessions | `{sessions, total, offset, limit, next_offset}` |
> | `GET /api/v2/sessions/:id/messages` | `{messages, session_id}` | `{messages, session_id, has_more, next_before}` |
> | `GET /api/v2/projects` | an array of projects | `{projects, total, offset, limit, next_offset}` |
> | `GET /api/v2/projects/:id/log` | the journal inside the project DTO (`project.log`) | `{entries, total, offset, limit, next_offset}` |
> | `GET /api/v2/projects/:id/pipelines` | `{pipelines}` | `{pipelines, total, offset, limit, next_offset}` |
> | `GET /api/v2/projects/:id/pipelines/:pid/runs` | `{runs}` | `{runs, offset, limit, next_offset}` |
> | `GET /api/v2/pipelines/instances` | `{instances}` | `{instances, offset, limit, next_offset}` |
> | `GET /api/v2/models` | `{groups:[…]}` | `{models, total, offset, limit, next_offset}` |
>
> Common rules: `limit` — an **integer** (a non-numeric/fractional/negative value → `400 VALIDATION_ERROR`;
> a value above the cap is **clamped** to the cap — a soft boundary), `offset` — the offset from the
> beginning of the selection (from 0), `next_offset` — the cursor of the next page (`offset + page.length`),
> `null` — the last page. An empty page (an offset past the end) also yields `next_offset: null` —
> otherwise the cursor would not move. The lists are **summaries**: the heavy fields (`messages` of a
> session, `log`/`plan` of a project, `draft` of a pipeline) are not returned in the list — they are in
> the detail. `total` is not returned where the port returns a limited selection (runs, instances) —
> there `next_offset` serves as the cursor.
> **Exception: `GET /api/v2/models` — a hard boundary.** The model catalog parses the parameters itself
> (not with the common helper) and **rejects** an out-of-range value: `limit` outside `1…500`
> (including `0`) or a non-integer → `400 VALIDATION_ERROR` (a value above 500 is **not clamped** but
> rejected); `offset` — non-integer/negative → `400`. The other lists use the soft boundary
> (clamping to the cap).
> **Hybrid: end-to-end pagination across the world boundary is impossible.** A remote list arrives
> **without** paged output (an old server returns the full array), so with remote records present
> `next_offset` — `null` (the page is the last one end-to-end), and `total` — the sum of the local
> counter and the remote records. For `GET /:id/messages` the `limit`/`before` parameters are passed
> through to the remote server; an old server ignores them and returns the **whole** history
> (a hybrid limitation).
> Backward compatibility is not supported — the client switches to the object form and paged reading.

### 5.1 Health — `both`

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/health` | — | `{status:'healthy', version, build, time, startedAt}` (`startedAt` — the ISO process start timestamp, ADR-092; `build` — the `SYNTH_BUILD_ID` build identifier, empty when unknown — the PWA uses it to refresh a stale shell) |
| GET | `/api/v2/health` | — | same (+ a `storage` block when degraded) |
| GET | `/ready` | — | Readiness (ADR-094): `200` `{status:'ready', storage:'ok'\|'degraded', version, startedAt, time, llmGateway?:'enabled'\|'disabled', warnings?:['llm-gateway-disabled'], checks?}`; `503` `{status:'not_ready', …}` only during start-up/fail-closed. Storage degradation does **not** drop readiness (ADR-098); a disabled LLM gateway is a warning (`llmGateway`/`warnings` in `/health` and `/ready`), the status does not change |
| GET | `/metrics` | none / bearer token | Prometheus exposition 0.0.4 (ADR-094), **outside** `/api/v2`; `metrics.enabled=false` → `404 NOT_FOUND`, with a token set and no `Authorization: Bearer …` → `401 UNAUTHORIZED`; `Content-Type: text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store` |

The metric catalogue, labels, scrape, alerts and troubleshooting — [OBSERVABILITY.md](../OBSERVABILITY.md) (RU);
configuration (`metrics.enabled`, token) — [CONFIGURATION.md](./CONFIGURATION.md) §"Observability".

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
| GET | `/auth/profile` | both | auth | Profile (in hybrid mode it is proxied to backend; in standalone — the local profile from the store, same DTO as backend) |
| PUT | `/auth/profile` | both | auth | Update the profile (proxied in hybrid mode; in standalone persists the local profile, response `{status, profile}`) |
| PATCH | `/auth/profile/preferences` | both | auth | Merge preferences (proxied to backend in hybrid mode) |
| DELETE | `/auth/profile/preferences` | both | auth | Reset preferences keeping `avatar` (proxied to backend in hybrid mode) |
| GET | `/auth/profile/avatar` | backend | auth | PNG avatar (`404` if absent) |
| POST | `/auth/profile/avatar` | backend | auth | Upload/delete the avatar (binary) |
| GET | `/auth/locales` | both | — | List of locales (`ru`,`en`) — public, used by the login screen |
| GET | `/auth/users` | backend | debug | Test users (debug only) |
| GET | `/auth/defaults` | both | — | UI appearance defaults (built-in + saved) — public, used by the login screen |
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
| GET | `/api/v2/sessions` | both | auth (own+project; LEAD/ADMIN — all) | **Page** of the session list: `{sessions, total, offset, limit, next_offset}`; `?limit=` (default 100, maximum 500), `?offset=` (default 0), `?project_id=` (see the visibility rules below). The session DTO is a **summary without history**: there is no `messages` key, no `prompt_states`; the queue (`pending_messages`/`pending_count`), the status, `current_stream`, the settings and the counters are kept. ⚠️ **Breaking change:** an array used to be returned; the full history is not returned by the list (see the note below) |
| POST | `/api/v2/sessions` | both | auth | Create; `{name|title, project_id, settings}` → 201 || GET | `/api/v2/sessions/:id` | both | auth | Session (serialized) — a **summary without history**: there is no `messages` key; the queue (`pending_messages`/`pending_count`), `current_stream`, the status, the settings and the counters are kept. The full history — `GET /api/v2/sessions/:id/messages` |
| GET | `/api/v2/sessions/:id/mcp` | both | auth (core — session access; managed — owner/ADMIN) | Effective MCP scope (ADR-071 §2.4): `{servers:[{name, level, enabled, reason?, connected?, origin, trust, chars?, estTokens?, estimated?}], enabled, disabled, mcpServers, mcpDisabledServers}`. `reason` ∈ `system_disabled\|project_disabled\|session_optout\|not_default`; the project `enabled` gate also applies to system servers. Servers/tools carry `chars`/`estTokens` (ADR-071 §2.8). Additive (ADR-125): `source` (`'local'\|'server'` — the source of the server) and `error` (the reason of the unavailability/degradation of a server-side MCP — without secrets; at `status:'error'` the server stays in the response, but its tools are not offered). Now lives in the core factory, so it works in standalone/hybrid (a `remote:` session is forwarded); managed registers its own, stricter version earlier — the owner\|ADMIN policy is preserved |
| PUT | `/api/v2/sessions/:id/mcp` | both | auth (core — session access; managed — owner/ADMIN) | Toggle MCP (a single switch): `{name, enabled}` → `mcpServers`/`mcpDisabledServers` (opt-out of system ones — via `enabled:false`), or `{mcpServers?, mcpDisabledServers?}`. An unknown server name → `400 VALIDATION_ERROR`; the response is the same payload, `session.updated` is published |
| PATCH | `/api/v2/sessions/:id` | both | auth | `{name, title, mode: plan\|act\|yolo, settings, project_id}`; **`title: ""` (an empty string) — title regeneration**: the server generates the title from the conversation synchronously and returns the session DTO (the name could not be built — the previous title is kept, the response is 200) |
| DELETE | `/api/v2/sessions/:id` | both | auth | Delete → 204 |
| GET | `/api/v2/sessions/:id/secrets` | both | auth (core — session owner; managed — ADMIN/AUDITOR) | Gateway obfuscation map `{sessionId, secrets}`. The core version serves standalone/hybrid (a `remote:` session is forwarded, the remote side checks the right); managed keeps the strict role-based `requirePermission('ADMIN','AUDITOR')` |
| POST | `/api/v2/sessions/:id/fork` | both | auth | Fork; `{message_id?, message_index?, title?}` → 201 |
| GET | `/api/v2/sessions/:id/children` | both | auth | Child sessions |
| GET | `/api/v2/sessions/:id/tree` | both | auth | Session tree |
| GET | `/api/v2/sessions/:id/export` | backend | auth | Session export (internal format, camelCase — the publish/fork format is unchanged). The route is registered **after** the prefix-guard (`app.use('/:id')`/`app.use('/:id/*')`), so **access to the session is decided by the single guard** — there are no access checks in the handler (invariant 16). The Gateway obfuscation map (ADR-036) is a **separate privilege**, decided by the route-level guard `createSessionExportGuard`: the **full export** (`obfuscationMap` and `messages[].metadata.secrets` included) goes to the **session owner** (`ownerId ?? userId`), `ADMIN` and `AUDITOR` (the same privilege set as `GET /:id/secrets`); other readers of the session (a project member `VIEWER`/`EDITOR`, a project owner who does not own the session, `LEAD`) get **200 with a cleaned body** (no map, the rest of the conversation is carried over unchanged; the stripping is done on a copy, the stored session is not modified); no read access → 403 `FORBIDDEN`; no session → 404 `NOT_FOUND`; the heavy-operation rate limit (`limits.sessionOpsPerMinute`, default 10/60 s) → 429 `RATE_LIMITED` with the `Retry-After` header |
| POST | `/api/v2/sessions/import` | backend | auth | Import a session from an export (the body is an export object + `import.project_id` — the target project, `import.source_session_id` (`sourceSessionId`) — the source marker, ≤ 200 characters). **Deduplication by the marker:** a repeated import with the same `source_session_id` into the same project **updates** the existing session and answers **200** with the additive `updated: true`; without a marker (or on the first import) — **201** and `updated: false`. On update the identity of the record is kept (`id`/`projectId`/`ownerId`/`createdAt`/`archivedAt`/`parentId` when the field is absent from the body), while the content and the metadata (title, settings, messages, plan fields, counters) are overwritten; the search scope is the sessions of the target project, and without a project — only the sessions of the current user. No LLM is started (materialization, ADR-089); the heavy-operation rate limit `limits.sessionOpsPerMinute` (default 10/60 s) → 429 `RATE_LIMITED` with `Retry-After` |
| POST | `/api/v2/sessions/import-batch` | backend | auth | Batch import: `{sessions: [...]}` — 1..200 items, each an export body + `import`; they are processed **sequentially** by the same code as `/import` (dedup and defaults do not diverge) → **200** `{sessions:[{source_session_id, id, updated}], imported, updated}`. An item error aborts the batch: `{error:{code, message}, details:{imported, updated, source_session_id}}` (the already written items stay; a retry is idempotent thanks to the marker dedup). An invalid body (not an array, an empty array, over 200) or a non-object item → 400 `VALIDATION_ERROR`. One request = **one** hit of `limits.sessionOpsPerMinute`; 429 `RATE_LIMITED` + `Retry-After` |
| GET | `/api/v2/sessions/:id/status` | both | auth | `{blocked, pending_count, processor_running}` |
| POST | `/api/v2/sessions/:id/prompt` | both | auth | Enqueue a message, return an **SSE stream**; the `mode` field (`queue`\|`steer`\|`interrupt`, `queue` by default) — steering into the running turn (ADR-104, see below) |
| GET | `/api/v2/sessions/:id/prompt` | both | auth | System prompt composition (ADR-070): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (tools with `chars`/`estTokens` and the estimation flag, ADR-071 §2.8). `manifest.toolsPolicy`/`manifest.mcpPolicy` — the applied built-in/MCP policies (ADR-071 §2.3); entries: `tools` (stable/context) → `mcp.servers`/`mcp.tools`/`mcp.status` (volatile, not in `staticPrefixChars`). `history.excluded.disabled` includes messages suppressed together with a disabled turn |
| GET | `/api/v2/sessions/:id/memory` | both | auth | Session memory for the “Memory” tab (ADR-107): `provider.active`, `scope.projectId`, `lastContext` — `facts`/`recall` blocks from the **last** turn (`chars`/`estTokens`/`status`, `null` when there were no turns), `facts.active` (active facts in scope), `projectMemory` (`{enabled}` — effective project policy; `null` for a session without a project), `indexes` (total/project/instance/ready/building/failed + `items`: id/name/scope/state/enabled/projectId; `stale` is computed by the plugin and is not returned here; for `instance` `enabled` is always true), `readiness` (`ready`/`degraded`/`unavailable`). No fact/chunk texts; access — session read (prefix guard), no duplicate checks |
| GET | `/api/v2/sessions/:id/stats` | both | auth | Usage statistics (ADR-070): messages + recursive subagent usage (the `task` tool), aggregates per agent/user (`computeSessionStats`). Sums the `usage` of **each message** (a message = a provider call, ADR-118): the sum over a turn's messages = the turn cost; aux calls (title/QA/fork/derive/micro) appear only in the session counters and the `usage` rollup (`requests=1`, no `messages`) |
| GET | `/api/v2/sessions/:id/questions` | both | auth (read) | The user questions of the session (stage 1 of roadmap 0.12.4 — block 3): `{questions: QuestionRecord[]}`; `?status=pending\|answered\|cancelled` (not set — all statuses), `?limit=` (default 50, maximum 200); the freshest records first. The question service is not wired — 503 `QUESTION_UNAVAILABLE` |
| POST | `/api/v2/sessions/:id/questions/:qid/answer` | both | auth (**mutation**) | The user's answer to the question: `{answers: string[][]}` (by the question index; the values — from `options[].value`) → 200 `{question}`. A free-text answer is always allowed: any non-empty string of ≤ 1000 characters is valid (a value outside `options[].value` is not an error). 400 `VALIDATION_ERROR` (an invalid body/answer), 404 `NOT_FOUND` (there is no question **or** it belongs to another session), 409 `CONFLICT` (the question is already answered/cancelled) |
| POST | `/api/v2/sessions/:id/questions/:qid/cancel` | both | auth (**mutation**) | Cancel the question: `{reason?}` → 200 `{question}`; the same 404/409 as in `answer` |
| GET | `/api/v2/sessions/:id/messages` | both | auth | **Page** of the history: `{messages, session_id, has_more, next_before}`; `?limit=` (default 200, maximum 500), `?before=` — an **opaque** exclusive cursor from `next_before` (the messages strictly older than the given value; it is a value of the server-chosen key, not necessarily `seq` — for legacy sessions with a non-unique/non-monotonic `seq` the cursor is built from `ord` or from the position in the history); without `before` — the last (newest) page. Inside a page the order is chronological; `index` in the DTO — the position in the **full** history (the pages are stitched together by it). `has_more` — there are older messages; `next_before` — the cursor of the next (older) page (`null` if there are no older ones). An invalid `before`/`limit` → `400 VALIDATION_ERROR`. The message DTO carries `ord` (the monotonic write order), `turn_id`, `step_index`, `status` (`streaming`\|`completed`\|`cancelled`\|`error`, ADR-118 §1/§5) |
| GET | `/api/v2/sessions/:id/messages/:messageId` | both | auth | A single history message by `id` — the same DTO as a list item (`serializeMessage`, `redactSecrets` by the same secret-reveal right, ADR-036). No session → `404 NOT_FOUND`, no message with that `id` → `404 MESSAGE_NOT_FOUND`. Access — the boundary prefix guard (invariant 16); no checks in the handler |
| POST | `/api/v2/sessions/:id/clear` | both | auth | Clear the history (except pinned) |
| POST | `/api/v2/sessions/:id/abort` | both | auth | Reliable Stop (ADR-005): sets the persistent `status.cancel_requested` flag; with a live stream — a graceful cancel, then stops the queue processor; **the queue is kept as a whole** (regular messages, background notifications and replies returned from `steerInbox` are not lost) — **there is no autostart**, resuming is `POST /api/v2/queue/:sessionId/resume` (or a new message submission); **lifts a pending permission wait** (the `permission.asked` resolves as `cancelled` — the tool does not hang until the ask timeout); **interrupts only the active turn** — background processes and background (detached/background) subagents keep running and are stopped separately (`POST /api/v2/processes/:id/stop`, `POST /api/v2/sessions/<child>/abort`, decision 2026-10-31); `{status:'aborted'}`; 404 if there is no session (see below) |
| POST | `/api/v2/sessions/:id/permissions/:approvalId` | both | auth (**write**) | Answer to a permission request (`permission.asked`) **over HTTP** — the path for an SSE/non-WS client (the `permission_reply` WS frame is unavailable there). Body: `{action: 'allow'\|'deny'\|'hold', once?: boolean, turn_id?: string, digest?: string}`. `allow`/`deny` — the same semantics as over WS: `permission.replied` is published, and with an approval registry attached only the holder of a covering grant is accepted (ADR-106 Ф3); `once` — “allow once” (do not add an allow rule to the session); `turn_id`/`digest` — binding to the turn (compared with the registry binding). `hold` — “stop the timer”: `permission.hold` is published (auto-deny by timeout is disabled), the registry is untouched. Responses: 200 `{status:'ok', action}`; 400 `VALIDATION_ERROR` (unknown `action` or empty `approvalId`); 403 `APPROVAL_DENIED` with `details.reason` (`unknown_approval`\|`already_consumed`\|`turn_mismatch`\|`digest_mismatch`\|`no_grant`) — the answer is rejected, the action is not performed (`already_consumed` means for the client “already answered”); 403/404 — by the general session access rules (see below). Access — the boundary prefix guard (`write` kind derived from the method); there are no checks in the handler (invariant 16) |
| POST | `/api/v2/sessions/:id/resume-subagent` | both | auth | Resume a subagent → 202 |
| POST | `/api/v2/sessions/:id/summarize` | both | auth | Request summarization `{status:'enqueued', stream_id}` |
| POST | `/api/v2/sessions/:id/debug-system-message` | backend | auth | Debug system message |
| GET | `/api/v2/sessions/:id/optimization` | both | auth | Context optimization settings (ADR-119): `{context_optimization, summarization_enabled, summarization_trigger_mode, summarize_after_n, summarize_token_threshold, summarization_keep_tokens, compaction_keep_tokens, compaction_token_threshold, summarization_head_messages, summarization_tail_messages, sliding_window_mode, sliding_window_message_limit, sliding_window_token_threshold}`. `context_optimization` ∈ `none`\|`sliding_window`\|`summarization`\|`compaction` (`sticky_notes` — a legacy value of saved sessions); `summarization_head_messages`/`summarization_tail_messages` are **deprecated** (the engine uses a token tail). The route lives in the core factory: in standalone/hybrid the settings are read locally (the `ContextOptimizer` engine runs on core); a `remote:` session is forwarded to its backend |
| PATCH | `/api/v2/sessions/:id/optimization` | both | auth | Partial patch of the same fields (only changed ones are sent); `context_optimization` switches the whole mode (the modes are mutually exclusive), `summarization_keep_tokens`/`compaction_keep_tokens` — the verbatim tail in tokens (`0` — no tail for summarization), `compaction_token_threshold` — the compaction threshold in % of the window (1..100). Response — the serialized session (summary, no history); `session.updated` is published after saving (invariant 27); a `remote:` session is forwarded |
| POST | `/api/v2/sessions/:id/optimization/check` | both | auth | Check the triggers: `{sliding_window, summarization, compression, summarization_pending}`. `compression` is **additive** (ADR-119): `{triggered, reason: 'none'\|'messages'\|'tokens', mode: 'summarization'\|'compaction'\|null, currentTokens?, threshold?, userCount?, limit?}` — the single trigger of the effective mode (compaction is token-only). With no optimizer attached — the `{triggered:false}` fallback; a `remote:` session is forwarded |
| POST | `/api/v2/sessions/:id/optimization/cancel-summarization` | both | auth | Cancel the summarization wait (`summarization_pending:false`); with an optimizer attached `can_summarize` is recomputed and `session.updated` is published; a `remote:` session is forwarded |
| GET | `/api/v2/sessions/:id/references` | both | auth | References `{references}` |
| POST | `/api/v2/sessions/:id/references` | both | auth | Add a reference → 201 |
| DELETE | `/api/v2/sessions/:id/references/:refSid` | both | auth | Delete a reference → 204 |
| POST | `/api/v2/sessions/:id/messages/merge` | both | auth | Merge messages from another session → 201 |
| GET | `/api/v2/sessions/:id/notes` | backend | auth | Sticky notes `{notes}` |
| POST | `/api/v2/sessions/:id/notes` | backend | auth | Create a note → 201 |
| PATCH | `/api/v2/sessions/:id/notes/:noteId` | backend | auth | Update a note |
| DELETE | `/api/v2/sessions/:id/notes/:noteId` | backend | auth | Delete a note |
| GET | `/api/v2/sessions/:id/todos` | both | auth (session read) | The session task list (ToDo): `{todos}` — `TodoItem` elements (`id`/`content`/`status`/`priority`/`planItemId?`) |
| POST | `/api/v2/sessions/:id/todos` | both | auth (**mutation**) | Create an item: `{content, status?, priority?, planItemId?}` → `{todos}`; `content` — Markdown, limit 4 KiB |
| PATCH | `/api/v2/sessions/:id/todos/:todoId` | both | auth (**mutation**) | Patch an item: `{content?, status?, priority?, planItemId? \| null}` → `{todos}` (`planItemId: null` — unlink from a plan item) |
| DELETE | `/api/v2/sessions/:id/todos/:todoId` | both | auth (**mutation**) | Delete an item → `{todos}` |
| PUT | `/api/v2/sessions/:id/todos/order` | both | auth (**mutation**) | New order: `{ids: string[]}` → `{todos}`; only existing ids are accepted (unknown ids are ignored, the items not named go to the end) |
| POST | `/api/v2/sessions/:id/todos/clear` | both | auth (**mutation**) | Clear by status: `{statuses?}` → `{todos}` (by default — `completed` + `cancelled`) |

> `SessionSettings` for MCP/skills (ADR-071 §2.4 / ADR-046): `mcpServers`/`mcpDisabledServers`, `skills`/`skillsDisabled` — session overrides (a single switch); `mcpDefaultOn`/`skillsDefaultOn` — a **snapshot** of the defaults (`project.defaultOn`/the system default) at session creation time, set by the system, not overwritten by a change of the project default; `undefined` — legacy mode (see the scope endpoints in §5.17.2).
> **The session list and the history — paged (owner decision, a breaking change).** `GET /api/v2/sessions` **always** returns a summary of the sessions **without the message history**: there is no `messages` key in the DTO at all (not an empty array), and no `prompt_states` in the list either. Previously the list for `ADMIN`/`LEAD` loaded all sessions **with their whole history** — on instances with hundreds of sessions that meant a heap peak and OOM on the entry path. Therefore: the list is a **page** `{sessions, total, offset, limit, next_offset}` (an array is no longer returned), and the full history of a session is available only paged in `GET /api/v2/sessions/:id/messages` (`limit` — default 200, maximum 500; `before` — an opaque exclusive cursor from `next_before`, not necessarily `seq`). The summary of `GET /api/v2/sessions/:id` and the single-item responses (`POST /`, `PATCH /:id`, `POST /:id/clear`, `POST /:id/fork`) are also without `messages`. The queue (`pending_messages`/`pending_count`), `current_stream`, the status, the settings and the token counters are kept in the summary. Backward compatibility is not supported — the client switches to the object form and to paged reading of the history.
> **List pagination.** `total` — the number of visible sessions (after the visibility filter and `project_id`); `next_offset` — the cursor of the next page (`offset + page.length`), `null` — the last page. A non-numeric/negative `limit`/`offset` → `400 VALIDATION_ERROR`; a `limit` above 500 is clamped to 500.
> **Hybrid: pagination across the world boundary is impossible.** A remote list arrives **without** paged output (an old server returns an array), so the end-to-end `next_offset` with remote sessions present — `null`, and `total` — the sum of the local page and the remote sessions. The `limit`/`before` parameters of `GET /:id/messages` are passed through to the remote server; an old server ignores them and returns the **whole** history (a hybrid limitation).
> **Visibility of `GET /api/v2/sessions` (ADR-089).** `ADMIN`/`LEAD` — **all** sessions; otherwise — own personal ones **plus** sessions of projects the user is a member of (the project `owner` or any `members`, any role). A session **without an owner** is visible (parity with access by id). Personal sessions of other users are not visible. `?project_id=` filters on top of this visibility.
> **Access by id — all `:id` routes of the resource (ADR-089).** A single prefix-guard `server/session-access-guard.ts` (mounted on `/:id` and `/:id/*` together with `requireAuth`; the access kind `read`/`write` is derived from the HTTP method), rule: `ADMIN`/`LEAD` — reading **and** mutating someone else's session are allowed (a deliberate product decision; pinned by the matrix `routes/session-idor-matrix.test.ts`); the session owner / a session without an owner — everything; a member of the session's project: **read** (`GET`/`HEAD`) — any role, including `VIEWER`, **mutation** — `OWNER`/`EDITOR` (`canEditProjectContent`); a foreign user → `403 FORBIDDEN`; a missing session → `404 NOT_FOUND`. Codes are consistent across the whole resource (for a foreign user any `:id` route returns `403`); explicit **managed backend** exceptions: `GET /:id/mcp` — owner|`ADMIN` (ADR-071 §2.4), `GET /:id/secrets` — `ADMIN`|`AUDITOR` (the core versions of these routes, used by standalone/hybrid, live under the common prefix guard, and the obfuscation map is released by the reveal right — the session owner), `GET /:id/export` — the route is **under** the guard (it decides access to the session), while the obfuscation map is a separate privilege of the route-level guard: owner|`ADMIN`|`AUDITOR` (other readers get 200 with a cleaned body; ADR-091 §6). List helper — `server/session-visibility.ts` (`isSessionVisible`), scan — `FileStore.listForUserScope`.
> **Service-key scope (ADR-052):** `GET /` and `GET /:id` — `sessions:read`; `POST /` — `sessions:create`; `PATCH /:id`, `DELETE /:id`, `POST /:id/prompt` — `sessions:prompt`; `GET /:id/prompt|status|stats|messages` — `sessions:read`. With a non-empty `allowedProjects`, the project projection is checked against the session's `project_id`, otherwise `403 PROJECT_FORBIDDEN`.
> **The instance storage context.** The project export/import (`GET /api/v2/projects/:id/export`, `POST /api/v2/projects/import`) go through the instance storage context (`StorageContext`, ADR-096), not through their own file context — on `storage.backend=postgres` the database projects are visible (the spec — §5.8.1).
> **Session auto-title (`session.autoTitle`).** The name of a new session is generated **right after the first user message** — at the start of the turn, before the assistant answer (the trigger is the request preparation, the provider has already been chosen by the router; the title LLM call is fire-and-forget — the turn does not wait for it, and its spend is recorded as an aux call `agent: 'title'`). The attempt rule (N — the number of dialogue replies of the user; service replies — steer injections, background-run notifications, scheduler messages — are not counted): N=1 and the reply is “chatter” (a greeting/small talk: “hello”, “how are you”, “ok”, etc.; no attachments and shorter than `minSignalChars`) → generation is **deferred**, the LLM is not called at all, the title stays `New session`; N=1 and there is a task signal → the title is built from the first message; N=2..`maxAttempts` and the title is still the default one → the title is built from the conversation (`Original request` + `Recent conversation`, a budget of 8000 characters, trimmed from the tail); N > `maxAttempts` → auto-naming stops trying (manual regeneration is available). The attempt counter is derived from the history — **the state is not persisted**, the rule is idempotent and survives a restart. The fallback on an LLM error/empty/too-long answer is a title from the **first reply with a task signal** (its first non-empty line, ≤ 60 characters, markdown stripped); for a greeting/small talk there is no fallback — the title does not change. A **user-set title is never overwritten** (auto-naming renames only the default one); child sessions (subagents) are not auto-named. The settings are the `session.autoTitle` section (`docs/CONFIGURATION.md`): `enabled`/`deferOnChatter`/`maxAttempts`/`minSignalChars`, env `SYNTH_SESSION_AUTO_TITLE_*`.
> **Manual title regeneration — `PATCH /api/v2/sessions/:id {"title": ""}`.** An empty string in `title` is not a rename but a request to rebuild the name **from the conversation**: the server generates the title synchronously (an LLM call) and overwrites the current one — a user-set title too; the response is the session DTO (as for an ordinary PATCH). The rebuild runs **outside the session lock** (an LLM call under the lock is forbidden), the other PATCH fields are applied as usual. If the name cannot be built (a provider error, an empty answer, no dialogue) — **the title does not change**, the response is `200` with the previous name, and no `session.renamed` event is published. On success `session.renamed` (if the name changed) and `session.updated` are published. A non-empty `title` is an ordinary rename (`session.renamed` + `session.updated`). In the UI it is the session context-menu item “Regenerate title”. In the hybrid mode the PATCH body is proxied to the remote server — it performs the regeneration.
> **Reliable Stop — `POST /api/v2/sessions/:id/abort` (ADR-005).** The route sets a **persistent** `SessionStatus.cancelRequested` flag (+ `cancelRequestedAt`) under the session lock — that is why the cancellation also fires when `currentStream`/the cancel token is not yet set (a session in the queue, in backoff, between Tool Use iterations), where the previous `orchestrator.cancel` was a no-op. With a live stream, a graceful `orchestrator.cancel` is additionally invoked (publishes `stream.cancelled`, keeps the partial response); then `QueueProcessorManager.requestStop` interrupts backoff/the active LLM call and ends the loop (`_handleStopRequest`: releasing `blocked`/the flag/`currentStream`, `stream.cancelled` exactly once — without duplicating the graceful branch; **the queue itself is kept as a whole** — owner decision 2026-11-01: "Stop" interrupts only the active turn). If there is no processor, the flag is cleared so that the next run is not falsely cancelled. **There is no autostart after a Stop**: the queue waits for an explicit resume — `POST /api/v2/queue/:sessionId/resume` (or a new message submission, which raises the processor and picks up the kept queue up). Additionally, "Stop" interrupts **only the active turn** (decision 2026-10-31, replacing 2026-10-28; opencode model): background processes and background (detached/background) subagents keep running and are stopped separately — `POST /api/v2/processes/:id/stop` (a run) or "Stop" of their own child session (`POST /api/v2/sessions/<child>/abort`); `BackgroundRunService.stopBySession` is no longer called from the route (the method stays public API of the service). A blocking subagent still stops by itself: the `task` tool abort signal → `run-cycle` sees `isAborted` → `finishAborted`. The response is `{status:'aborted'}`; without a session — 404. In a serialized session (`GET /api/v2/sessions/:id`) the `status` field contains `cancel_requested` (bool) and `cancel_requested_at` (ISO|null). The hybrid branch (a remote session) delegates to `remoteClient.abortSession`. **Stop also lifts a pending permission wait**: the turn's `AbortSignal` aborts `PermissionApprovalManager.waitForDecision` (`{approved:false, cancelled:true}`) — the tool returns immediately instead of hanging until the ask timeout; the turn then ends with the regular cancellation.
> **Answering a permission request over HTTP — `POST /api/v2/sessions/:id/permissions/:approvalId` (ADR-029/ADR-106 Ф3).** Previously `permission.asked` could only be answered by the `permission_reply` WS frame: an SSE client (after the WS→SSE auto-fallback) silently lost the answer and the tool hung until the ask timeout. The route accepts the same body (`action: allow|deny|hold`, `once`, `turn_id`, `digest`), goes through the same approval registry (`ApprovalRegistry.claim`) and publishes the same events as the WS path. The difference of `hold`: `permission.hold` is published (auto-deny by timeout is disabled) and the registry binding stays — the answer can be given later. No registry attached (Authority disabled/in shadow) — the answer is accepted based on session access (the previous behaviour). "Stop" (`POST /:id/abort`) lifts the permission wait: `waitForDecision` receives the turn `AbortSignal` and resolves as `cancelled` (`permission.replied` is not published; the tool result reason is `permission.ask_cancelled`).
> ⚠️ **Outdated (ADR-118): the acceptance contract and the turn events below are pre-v2** (kept as history; canonical text — RU §5.5). Currently: `POST /:id/prompt` always returns **`202 {messageId, mode, position}`**; the turn cut in the `interrupt` mode is reported by `step.finished` with status `cancelled`, not by `stream.interrupted`; the WS `send_message` frame and the `queued` ack no longer exist.
>
> **Disabled provider/model (current contract, RU §5.5 is canonical).** The effective pair (`body.provider`/`model` → session settings) is checked against the catalog **before attachments and before enqueueing**; a disabled provider → `400 PROVIDER_DISABLED` with `details: {provider}`, a disabled model → `400 MODEL_DISABLED` with `details: {provider, model}`; nothing is enqueued. No catalog record (`undefined`) does not block. In hybrid mode a remote **4xx** response is forwarded as is (status + JSON body, including `code` and `details`) — the client `RemoteBackendClient` is called with `allowHttpError: true`, so a 4xx is not turned into `RemoteError('HTTP_400')` (401 still throws `UNAUTHORIZED`); the soft `202 {messageId, mode:'queue', position:null}` degradation remains only for an old server (non-4xx, non-202).
>
> **Sending mode — `mode` in `POST /api/v2/sessions/:id/prompt` (ADR-104, semantics unchanged).** The optional `mode` field: `queue` (the default) — the message waits for the current turn to finish (the previous behaviour); `steer` — **intervening in the running turn without interrupting the generation**: the message goes to the injection queue (`steerInbox`) and enters the context at the nearest step boundary (before the next LLM call), persisted as a regular `user` reply with `metadata.steer=true`; `interrupt` — **aborting the current generation while the turn continues**: the stream is cut (previously the `stream.interrupted` event; since ADR-118 the step ends with `step.finished` status `cancelled`), the partial answer is saved as a separate `assistant` reply with the `interrupted` status (`metadata.interrupted`), the turn is **neither finished nor cancelled** ("Stop" is a separate mechanism, ADR-005) — the message is woven in at the nearest step boundary, and `toolUse`/`toolResult` pairs are not broken. An unknown `mode` value is treated as `queue`. The response for `steer` with a running turn is `202 {status:'steered', stream_id, pending_count, mode_applied:true}`, for `interrupt` — `202 {status:'interrupted', stream_id, pending_count, mode_applied:true}` (no separate SSE stream is opened — the stream of the current turn is already running); with no running turn `steer`/`interrupt` behave like `queue` (the regular queue + SSE). The limit is **5 injections per turn**; exceeding it → `429 STEER_LIMIT_EXCEEDED` (the `steer.dropped` event is published). The same field is accepted by the WS `send_message` message (backend and standalone).
> **Pending injections are dropped (ADR-104, decision 2026-10-28; clarification 2026-10-30).** The queue is drained only at a step boundary, so after "Stop" or at the end of a turn there is no boundary left. `POST /api/v2/sessions/:id/abort` clears the injection queue after stopping; at the end of a turn (the orchestrator epilogue, outside the loop) the rest of the queue is dropped with `reason:'turn_ended'`. Dropped messages are **not applied** in the current turn (there is no step boundary left) and are **not** persisted in history — but they are **not lost** either: the whole remainder (both the user input and the background run notifications) is returned to the regular queue `pendingMessages` — the `steer`/`interrupt` markers are removed and a `stream_id` is assigned. There is no turn autostart on the return: after a "Stop" the message waits for the user (`POST /api/v2/queue/:sessionId/resume`), on a regular turn end the queue continues on its own. `steer.dropped` is published only for those that could not be returned (the queue overflowed). The event `reason` is `limit` | `aborted` | `turn_ended`; the event also carries `dropped_count` and the `i18n` key (`steer.limit_exceeded` / `steer.dropped_aborted` / `steer.dropped_turn_ended`).
> **Injection order (ADR-104, stage 3).** The injection queue is **not strict FIFO**: the injections of the `interrupt` class (the `metadata.interrupt=true` marker) are applied first, then the `steer` class; **within a class** the order is FIFO (the order of enqueuing). The order is deterministic and does not depend on when the injection was enqueued. When the per-turn limit overflows, the lowest-priority injections (`steer`) are dropped first, and the surplus is published as `steer.dropped`.
> **An injection is an input into the same turn, not an answer from the user (ADR-104, stage 3).** An injection **does not answer** for the user on `permission.asked` and **does not cancel** a pending permission confirmation: a turn waiting on `ask` applies the injection at the step boundary **after** the answer. An injection also **does not widen the permissions**: in the `plan` mode a mutating tool stays denied (the permission layer rule `plan.deny`), even if the injection text "allows" it.
> **Hybrid: a single mode contract (ADR-104, stage 3).** The `mode` reaches the remote side: the HTTP prompt of a remote session (`remote:<id>`) forwards the body as is, and the local core's WS path passes `mode` in the request to the remote backend (previously the mode was lost — a remote session always ran as `queue`). The response/ack carries the **applied** mode: the local side applied the mode itself — `mode_applied:true`; the remote side applied it — `202` with `mode_applied:true`; the remote side did **not** apply it (no running turn on the remote side, or an older version) — `202 {status:'queued', mode_applied:false}` (the message went through the regular queue). The WS `queued` ack contains `mode` and `mode_applied` (backend and standalone).
> **Steering limitations (ADR-104).** **There is no mode switch in the UI** (since 2026-10-30): while a turn is running the composer always sends `queue`, and the `steer`/`interrupt` modes are available only through the API/gateways (including `POST /queue/:sessionId/steer` for a message already in the queue); in the feed, injected messages are marked with the "intervention in the turn" marker (`metadata.steer`), in the `interrupt` mode — with the "turn interrupted" marker (`metadata.interrupt`), and an aborted generation gets the "Interrupted" badge (`metadata.status === 'interrupted'`). In hybrid mode the local core does not intervene in the turn executed by the remote backend: the mode is applied by the side that owns the turn (the remote backend), and the client is told in the ack whether the mode was applied (`mode_applied`).
> **Steering a child subagent session (ADR-104 + ADR-111).** The mode also works for child subagent sessions, including background ones: `POST /api/v2/sessions/<child>/prompt` with `mode:'steer'` puts the message into the injection queue **of the child session**, and the child's cycle (`engine/tools/task/run-cycle.ts`) applies it at the step boundary — before the next LLM call, in the same turn (the `toolUse`/`toolResult` pairs are not broken). The injection is persisted in the child's history as a regular `user` reply with `metadata.steer=true` and published to the child's channel (`message.added`, `message.injected`); exceeding the limit — the `steer.dropped` event in the child's channel, the turn does not fail. `interrupt` for a child **does not cut the generation** (at the step boundary there is none left) and is applied as a regular intervention. The general rule of the section applies: a message enters the injection queue only if the child session has a running turn (a background run always does: the child session is marked busy; with no running turn `steer`/`interrupt` behave like `queue`). The parent and child queues are isolated: an injection into the parent's queue does not enter the child's turn and vice versa (the check — `packages/core/src/queue/steering-subagent.test.ts`).
> **Questions and a restart (ADR-112).** The wait for an answer to a question lives in the process memory: after a restart the unfinished questions are marked `cancelled` with the reason `interrupted`, the turn is not resumed (like the other tool-loop pauses). The question record itself survives the restart (the journal in the `QuestionRepository`). By default the question waits for an answer **without a timeout** (`questions.timeoutMs = 0`); the `question` tool may set a deadline (`timeout`, ≥ 5 minutes — not recommended: it aborts the wait).
> **Answer attachments — `step.finished.attachments` (ADR-115 outbound; ADR-118 replaced `stream.done`).** The `step.finished` event (the session channel / global SSE `GET /api/v2/events`) carries an additive `attachments?: Array<{sha256, mime, size, name?}>` — see §3.3 — the media parts of the **final** assistant message of the turn (`image`/`audio`/`video`/`file`) in message order; with no media parts the field is absent. A gateway downloads the bytes by sha: `GET /api/v2/attachments/:sha256` (§5.6.1, RU only for now) — no session access needed. Field shape, source and download status codes — §5.6.1.

> **Main-agent step limit — `step_limit_reached` (2026-10-30).** When a turn ends with an **executed** step limit (`AgentDefinition.maxSteps`, the opencode mechanics: an ordinary step, `tool_choice: 'none'`, the “text only” instruction delivered as a synthetic assistant prefill), `step.finished` carries the additive `step_limit_reached: true` (the field was on `stream.done` before ADR-118 — same name and meaning), and the final assistant message — `metadata.step_limit_reached: true` (parity with the `task` subagent). If the model gave no textual report, the text of the `session.steps_limit` key (`{limit}`, “the step limit is exhausted…”) is substituted and the answer `status` becomes `limit` (the unrelated `session.max_iterations` is no longer used in this branch of the main loop — it remains for pipeline steps). The fields are additive: without the step limit they are absent.

> ⚠️ **Outdated (ADR-118): delivery confirmation.** The `message.queued` event was **removed** (it leaked the text and the author into the session channel) together with the WS `queued` ack and the 30 s "unconfirmed send" timeout. Currently: acceptance is confirmed synchronously by `202 {messageId, mode, position}` from `POST /:id/prompt`, the sender additionally gets the **addressed** `message.accepted` (`messageId`, `mode`, `position`, no text), and the queue is described by `queue.state` (counters and element states only, no text or author). The historical description follows.
>
> **Delivery confirmation — `message.queued` (2026-10-30, removed by ADR-118).** The `message.queued` event (`stream_id`, `message_id`, `pending_count`, `message`, `agent_role`, `author`) confirmed that the message was **accepted by the server into the queue** (not merely rendered by the client). `message_id` equals the send `stream_id`: the client passes `stream_id` in the `send_message` WS frame and `message_id`/`streamId` in the HTTP body of `POST /sessions/:id/prompt`, and the server uses it as the pending message id — so the optimistic queue row and the server event collapse into one row (dedup by id). The WS send ack resolves on the `queued` frame **or** on this event; no confirmation within 30 s means the send is **unconfirmed** (`{confirmed:false}`, not an error): the message stays in the server queue and the client reconciles it via `GET /sessions/:id`; an `error` frame is a send failure.

> **Subagent progress — deltas (`subagent.progress`, 2026-10-30).** The event carries additive `content_delta`/`reasoning_delta` — the increment since the previous publication, **not** the accumulated text (the former `content`/`reasoning` fields are gone); empty deltas are not published, and the total delta volume per run is capped at 200,000 characters (beyond that progress is silent; the final report arrives as a regular message and is unaffected). An older core (a hybrid of a different version) may send the accumulated text in `content`/`reasoning` — the client subtracts the already known prefix, so the progress block is not duplicated; unknown fields are ignored.

> **Session DTO — `current_stream` (ADR-118 §10).** In a serialized session (`GET /api/v2/sessions/:id`, `GET /api/v2/sessions`) the live turn object is `current_stream`: `{stream_id, message, agent_role, cancelled, turn_id}`. The **`turn_id`** field (`turn_…` — the identifier of the active turn) is **additive**: `null` when there is no turn. The client needs it to **restore the turn after a page reload**: the turn id is taken from `current_stream.turn_id` (fallback — the `turn_id` of the last session message, then the legacy `current_stream.stream_id`); `stream_id` (`stream-…`) is **not** the turn id (with it the live messages got `turn_id = stream-…` while the history used `turn_…`, and the turn block split in two). The value is persisted together with the turn (file store — the `turn_id` field in `current_stream`; PostgreSQL — the same JSONB document), so a live turn is recognized by the same id even after a server restart.

> **Session DTO — `current_stream.live` (ADR-118 §5).** An additive field of the live turn — a snapshot of the **current (streaming) step** at response time: `{message_id, step_index, turn_id, content, reasoning, parts, updated_at}`; `null` when no step is streaming (finished/not started yet) or the snapshot belongs to another `stream_id`. It lives in core memory (not persisted) and is dropped on `step.finished`; `parts` are the same parts as in `part.delta`/`part.updated` (deterministic ids), so the client merges them without duplicates. It lets a client **open a session mid-turn and see everything up to the current moment** without waiting for the next delta (tab switch, page reload, a second client).

> **Session DTO — `activity` (idle | busy | retry).** An additive field of a serialized session (`GET /api/v2/sessions/:id`, `GET /api/v2/sessions`) — the **server-side activity status**: `{type: 'idle'}` | `{type: 'busy', turnId: string\|null, streamId: string\|null}` | `{type: 'retry', attempt: number, maxRetries: number, retryAt: string, error?: string, streamId: string}`. Priority: **retry > busy > idle**. `busy` — a turn is running (`current_stream`) or the session is locked (`status.blocked`); `retry` — the LLM call failed with a recoverable error and the processor is waiting for the backoff (`attempt`/`maxRetries` — the attempt number and the limit, `retryAt` — the ISO time of the next attempt, `error` — the text of the last error). The retry state is **persistent** (file store — the `retry` field; PostgreSQL — the `sessions.retry` jsonb column, migration `030`), so after a reload/restart the client sees “retrying” rather than “empty”; it is cleared on a new `stream.start`, on success, on a terminal error and on cancellation/queue reset.

> **The session task list (ToDo) — `/api/v2/sessions/:id/todos*` (ADR-130).** All operations are atomic under `SessionManager.withLock` (a per-session lock); the ToDo list has no version of its own (there are no conflicts). Access — the **single prefix guard** of the sessions: reading (`GET /:id/todos`) — read access, mutations — write access (the owner/a project member with the modification right/`LEAD`/`ADMIN`); there are no checks in the handler (invariant 16). After every mutation `todos.updated` is published to the session channel with the current list. The order of the list is the order of the array; `order` accepts only existing ids (unknown ids are ignored, the items not named are appended to the end — deleted items are not resurrected). The item text is Markdown, limit 4 KiB (`MARKDOWN_LIMITS.todoContent`); exceeding it — `400 VALIDATION_ERROR`. The logic lives in the domain service `engine/todo/service.ts` — the same one the `todo_*` tools use.
> **Hybrid (ADR-042/ADR-130).** For a remote session (`remote:<uuid>`) the operations are **forwarded** to the remote backend (the method, the path and the body are preserved; the id is sent without the `remote:` prefix). The session prefix guard skips the `remote:` ids — the access and the validation are decided by the remote side. The response is returned as is (the status + the body), the transport errors — `502 OFFLINE`/`401 UNAUTHORIZED`; the hybrid is not configured — `502 REMOTE_UNAVAILABLE`.

### 5.6 Messages — `/api/v2/messages`

> ⚠️ Outdated (ADR-118 §7): mutations are addressed by message id
> (`PATCH/DELETE/POST /:sessionId/:messageId/*`, `batch {messageIds[]}`); unknown message → `404 NOT_FOUND`,
> empty/invalid `messageIds` → `400 INVALID_MESSAGE_IDS`. The table below still shows `:index`/`indices[]`.

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| POST | `/api/v2/messages/:sessionId/batch` | both | auth | `{action: pin\|toggle\|delete, indices[], state?}` |
| PATCH | `/api/v2/messages/:sessionId/:index/toggle` | both | auth | Toggle `disabled`. Disabling a **user** message disables its whole turn: assistant/tool/error messages up to the next user message are not sent to the LLM (system-state and summary remain); a disabled assistant with `toolCalls` suppresses its tool results |
| PATCH | `/api/v2/messages/:sessionId/:index/pin` | both | auth | Toggle `pinned` |
| DELETE | `/api/v2/messages/:sessionId/:index` | both | auth | Delete a message |
| POST | `/api/v2/messages/:sessionId/:index/retry` | both | auth | Disable from index and return the text `{content}` |
| GET | `/api/v2/messages/:sessionId/:index/debug` | both | auth | Debug data for a message |

> **Thinking/reasoning service fields are never exposed (ADR-117).** `reasoningSignature` (the Anthropic
> thinking block signature) and `reasoningRedacted` (opaque `redacted_thinking` data) are **legacy**
> message fields; today the signature is stored **on each reasoning block separately** (`Part.metadata
> {signature?, redacted?}`, `reasoningBlocks` in the LLM contract, commit `91be3f89`). They are persisted
> (the file store and PostgreSQL, migration `028-message-reasoning-signature`; `serializePart`/
> `deserializePart` keep the part `metadata`) but **do not** appear in public responses
> (`GET /sessions/:id/messages`, the `message.added`/`session.updated` events, session export): they are
> provider-protocol data needed only to replay the history to the Anthropic API. The `reasoning` field
> (the reasoning text) is returned as before; the string `content` is built **without** reasoning blocks
> when `parts` are present (legacy messages without `parts` keep the previous behaviour).

> **The end of a turn = the last step (ADR-118 §1).** The content of the turn messages is structured as follows:
> - The **final** assistant message of the turn carries the text and the reasoning of the **last step only** — not a summary of the whole turn: the texts and the reasonings of the earlier steps live in the messages of **their** steps, and repeating them in the final message produced duplicates in the feed.
> - **Tool calls and their results** live in the message of **their** step: `metadata.tool_results` (in the DTO — the `tool_calls` field). The final message does not contain them — the tool cards are rendered in their own steps, not duplicated at the end of the turn.
> - `metadata.intermediate_text_blocks` (the texts of the intermediate iterations) is **no longer written** for the messages of a turn (those with `turn_id`/`step_index` set) — the field survives only in the old (legacy) messages created before ADR-118.
> - The **`usage` of each message is the cost of its own provider call (step)**; for a turn of N calls there are N assistant messages, each with its own usage (the final one carries the **last** call, not the sum). The **sum of the message usages of a turn = the turn cost**; `step.finished.usage` is the cost of **its** step (the sum of the step costs = the turn cost; the Prometheus metrics are unchanged). The session counters (`Session.inputTokens`/…) and the analytics `usage` rollup are one record per turn (`requests=1`/`messages=1`) over that sum (`turnUsage`); **the invariant: the sum of assistant-message usage + aux calls = the session counters** (aux — title, QA self-check, fork summary, attachment derive, rejected micro/decision calls: `requests=1`, **no** `messages`; a micro answer is a **message** record: `requests=1`, `messages=1`, `model=micro:<taskClass>`). `metadata.cost_*` of a message is the cost of its own usage; `metadata.step_duration_ms` is the duration of its own call (TPS), `metadata.duration_ms` is the turn duration (analytics/reports). Provider cost — `TokenUsage.cost` (additive, takes precedence over the catalog, `0` is reliable, breakdown is zeros; different currencies are not summed). The `analytics rebuild` groups usage per turn (`turn_id` → `metadata.stream_id` → id), an `interrupted` message is a separate record, `tool_chain` steps are included. The subagent cost (`metadata.subagents`) is counted separately. **Old history is not migrated:** in turns written before this semantics the final message's `usage` is the turn sum and the step messages have no `usage`.
> - The **step limit** (`AgentDefinition.maxSteps`) does not create a separate message: it is **one more ordinary step** of the cycle (the tools stay in the request, `tool_choice: 'none'`, the “text only” instruction arrives as a synthetic assistant prefill), so no extra second message appears in the turn history (see §5.5 “Main-agent step limit”).
> - **Turns already written** (created before this rule) are repaired by the one-off idempotent migration `migrations.message-stream-v2-step-parts` (`schemaVersion` 3, ADR-118 §“Migration and rollback”): the reasoning and `metadata.tool_results` of the old-style final message move into the messages of their own steps (`tool_results` merged by the call `id`), `intermediate_text_blocks` is removed, and `tool_chain` is dropped from the steps that have visible content/calls. The API access does not change; a repeated run is a no-op.

### 5.6.1 Message attachments — chunked upload (RU §5.6.1 is canonical)

Message attachments (ADR-115) live in the blob volume (`{dataDir}/blobs`, content-addressed
`attachments/<sha2>/<sha256>`); the message carries only the `blobPath` reference. The full section
(upload, download, limits, staging) is maintained in the RU version; below is the **chunked-upload**
part with the limits enforced by the current implementation.

Base paths: `/api/v2/sessions/:id/attachments/uploads` (session contour, RBAC — session **write** via
the prefix guard) and `/api/v2/attachments/uploads` (staging, no session binding).

| Method | Path | Purpose / req-resp |
|---|---|---|
| POST | `<base>` | Init: body `{name?, mime?, size?}` (all optional, empty body allowed). `size` must be a non-negative integer, otherwise `400 VALIDATION_ERROR`; `size` above `maxBytesPerFile` → `413`; the declared `size` pushing the session's active uploads above `maxBytesPerSession` → `413`; active upload count limits exceeded → `413`; **201** `{uploadId, maxChunkBytes}` |
| PUT | `<base>/:uploadId?offset=N` | Raw part: `offset` must equal the received volume, otherwise `400 VALIDATION_ERROR`; a part above `maxChunkBytes` (by `Content-Length` or actual size) → `413` with `details.maxChunkBytes`; total above `maxBytesPerFile` → `413` with `details.maxBytesPerFile`; the **actual growth** pushing the session's active uploads above `maxBytesPerSession` → `413` with `details.maxBytesPerSession`; **200** `{received, nextOffset}` |
| POST | `<base>/:uploadId/complete` | Publish the attachment (same result as a regular upload); the final size plus the other active uploads of the session is checked against `maxBytesPerSession` → `413`; **201** `{id, blobPath, sha256, mime, size, name?}`; a repeated complete → `404` |
| DELETE | `<base>/:uploadId` | Cancel; **204**, idempotent (unknown/already cancelled id → 204 as well) |

Limits (live resolver, read on every call):

| Limit | Scope | Default | Violation |
|---|---|---|---|
| `attachments.maxChunkBytes` | one `PUT` part | 8 MiB | `413 PAYLOAD_TOO_LARGE` (`details.maxChunkBytes`) |
| `attachments.maxBytesPerFile` | one file | 100 MiB | `413 PAYLOAD_TOO_LARGE` (`details.maxBytesPerFile`) |
| `attachments.maxBytesPerSession` | session's **active** chunked uploads (temporary objects under `attachments/.uploads/` plus the current file); on `init` the declared `size` counts, on `append`/`complete` the actual size | 1 GiB | `413 PAYLOAD_TOO_LARGE` (`details.maxBytesPerSession`) |
| `attachments.maxActiveUploadsPerSession` | number of concurrent chunked uploads of one session | 16 | `413 PAYLOAD_TOO_LARGE` (`details.maxActiveUploadsPerSession`) |
| `attachments.maxActiveUploads` | number of active chunked uploads of the instance, including staging (no `sessionId`) | 256 | `413 PAYLOAD_TOO_LARGE` (`details.maxActiveUploads`) |

A `413 PAYLOAD_TOO_LARGE` in the chunked contour always carries `error.details` with the **actual**
limit that fired: `maxChunkBytes` (one part), `maxBytesPerFile` (one file), `maxBytesPerSession` (the
session's active-upload quota) and `maxActiveUploadsPerSession`/`maxActiveUploads` (active-upload
count); several keys may be present at once (the instance-wide limits plus the one that fired).

Expired upload sessions (1 h TTL without activity) **never count**: `create` runs a cleanup first (a
full pass is throttled to at most once per minute), and the active-upload scan always skips sessions
whose TTL has elapsed — so stale uploads consume neither the quota nor the count limits even when the
lazy cleanup is skipped by the throttle. The session quota covers only active (unfinished) uploads of
that session; other sessions are unaffected. Staging has no session quota but counts towards the global
`maxActiveUploads`. **There is no byte quota for staging**: its upper bound is
`maxActiveUploads × maxBytesPerFile` (256 × 100 MiB ≈ 25 GiB at the defaults). Upload state is stored
on the volume (temp object plus sidecar `attachments/.uploads/<uuid>.json`), so any control-plane
replica can continue an upload — the `blobs` volume must be shared.

### 5.7 Queue — `/api/v2/queue`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| POST | `/api/v2/queue/:sessionId/clear` | both | auth | Clear the queue `{cleared:true}` |
| POST | `/api/v2/queue/:sessionId/return` | both | auth | Return texts `{texts}`; address by `?id=<id>` (priority) or `?index=N`; neither — the whole queue |
| POST | `/api/v2/queue/:sessionId/reorder` | both | auth | Reorder the regular queue (UI drag-and-drop): body `{ids: string[]}` — the desired order of message ids; the set must **exactly** match `pendingMessages` (the order is the desired one). → 200 `{status:'ok', order}`; an empty queue/one item is a no-op `ok`; not an array/empty/duplicate ids → `400 VALIDATION_ERROR`; the set does not match (the queue changed) → `409 QUEUE_CHANGED` (the client re-reads the state); no session → `404` (boundary guard, `NOT_FOUND`). `steerInbox` is untouched (ADR-104). `queue.state` is published |
| POST | `/api/v2/queue/:sessionId/steer` | both | auth | Send a queued message "into the break" of the running turn (ADR-104): body `{id?: string; index?: number}` (`id` has priority, `index` is compatibility; default `0`). The move is **atomic** (under a single session lock): the limit check → removal from `pendingMessages` (by `id`) and of its user copy from the history (by `metadata.stream_id`, the active stream is untouched) → putting it into the injection queue. Therefore by the time `message.enqueued` is published the message is in neither the queue nor the history (otherwise the client would count the reply as "returned to the queue" and remove it from the feed). `202 {steered:true, pending_count}` (`pending_count` is the `pendingMessages` length); no message at the `id`/index or no session → `404 NOT_FOUND` (including a repeated steer of the same `id`); the message is already running in the current turn → `409 CONFLICT`; no running turn → `409 NO_ACTIVE_TURN` (the message stays queued); injection limit exceeded → `429 STEER_LIMIT_EXCEEDED` (queue and history untouched, no acceptance events). Hybrid — via `queueSteer` (`remote:<id>`) |
| POST | `/api/v2/queue/:sessionId/resume` | both | auth | Resume processing `{resumed, pending_count}` |
| POST | `/api/v2/queue/:sessionId/retry-now` | both | auth | Immediate retry during backoff |
| POST | `/api/v2/queue/:sessionId/cancel-retry` | both | auth | Cancel the retry attempts |

> **`steer` from the queue (ADR-104).** Unlike `POST /sessions/:id/prompt` with `mode:'steer'` (creates a new message), `POST /queue/:sessionId/steer` **moves** an already queued message into the running turn. Addressing is by the server `id` (priority) or `index`; the move is **atomic** (under a single session lock): the injection limit check → removal from `pendingMessages` by `id` → deletion of the user copy from the history by `metadata.stream_id` (the active stream is untouched) → putting it into the injection queue. Thanks to this, by the time `message.enqueued` is published (the reply snapshot — rendered into the feed) the message is **already gone** from both `pendingMessages` and the history — otherwise the client would see the reply twice ("it returned to the queue") and remove it from the feed. On 429 (the injection limit) the queue and history stay untouched and there are no acceptance events (`message.accepted`/`message.enqueued`); a repeated steer of the same `id` → `404 NOT_FOUND` (the message is already in the injection queue). The message of the current turn cannot be steered (`409 CONFLICT`); the UI shows the button only while a turn is running, otherwise `409 NO_ACTIVE_TURN` (the message is not lost). Queue rows are addressed by the server `id`, not by index (the `message.queued` event that used to carry `message_id` was removed by ADR-118; acceptance is confirmed by the `202` response and the addressed `message.accepted`). A legacy `?index=abc` (non-integer/negative) → `400 VALIDATION_ERROR`, not "the whole queue". Access — the boundary prefix-guard (`createSessionAccessGuard`); no extra checks in the handler.

### 5.8 Projects — `/api/v2/projects`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/projects` | both | auth (owner/member; LEAD/ADMIN — all) | **Page** of the project list: `{projects, total, offset, limit, next_offset}`; `?limit=` (default 100, maximum 500), `?offset=` (default 0). The project DTO is a **summary**: the heavy fields `log` (the project log) and `plan` (ADR-039) are not in the list; the other detail fields are kept. ⚠️ **Breaking change:** an array used to be returned |
| POST | `/api/v2/projects` | both | auth | Create `{name, workspace?, repos?, plan?}` → 201 |
| GET | `/api/v2/projects/:id` | both | auth / owner·member·LEAD·ADMIN | Project (read; VIEWER reads, does not edit). ⚠️ **Breaking change (PROP-054):** the detail has **no** `log` field — the project journal moved to the paged endpoint `GET /api/v2/projects/:id/log`. The `plan` and `invariants` fields stay |
| PUT | `/api/v2/projects/:id` | both | auth / owner·EDITOR·LEAD·ADMIN | Update fields (name, description, current_task, invariants, icon, color, repos, plan, memory); changing `workspace` — owner/LEAD/ADMIN. `memory: {enabled?: boolean}` — project memory policy (ADR-107): `false` removes memory prompt blocks and `plugin_synth_plugin_memory_*` tools for the project while keeping the data; omitted — inherits the instance policy (enabled) |
| DELETE | `/api/v2/projects/:id` | both | auth / owner·LEAD·ADMIN | Delete → 204 |
| GET | `/api/v2/projects/:id/stats` | both | auth | The token aggregates over the sessions of the project (`total_sessions`, `total_input_tokens`, `total_output_tokens`, `total_tokens`, `total_cache_read_tokens`, `total_cache_write_tokens`, `total_reasoning_tokens`). ⚠️ The `total_messages` field was **removed**: the session list is always light (without history), so there would be nothing to count the messages from; the number of messages of a single session — in `GET /api/v2/sessions/:id/stats` |
| GET | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Project MCP scope (ADR-071 §2.4): `{enabled, defaultOn, knownServers, sources?}`; `enabled[]` — hard gate (unavailable even in old sessions, including for system servers), `defaultOn[]` — the seed for new sessions. `sources` (ADR-125) — the source of every known server: `Record<name, 'local'\|'server'>` (the "server" badge in the UI); the field is additive, without it the source is unknown |
| PUT | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Set `{enabled?, defaultOn?}` (references to the registry by name); the auto-seed marker `project.mcp.remoteSeeded` (ADR-125) is kept — a server-side default the user turned off does not come back |
| POST | `/api/v2/projects/:id/publish` | core | auth | Local project → server (hybrid) |
| GET | `/api/v2/projects/:id/publish/progress` | core | auth | Publish progress for UI polling: `{active, phase, percent, sessions, files, startedAt, updatedAt, error}` (see the block below) |
| POST | `/api/v2/projects/:id/fork-local` | core | auth | Server project → the local world (hybrid) |

> **Hybrid and the project journal (PROP-054).** The journal was moved out of the project detail, so the transfer between worlds goes through the paged endpoint:
> - **fork-local** (server → local): the journal is loaded **page by page** from `GET /api/v2/projects/:id/log` (`remote/client.ts#getProjectLog`); the number of pages is capped — when the cap is exceeded the journal is transferred partially (with a warning in the transfer log): losing the tail is better than failing the transfer;
> - **publish** (local → server): the journal is **not transferred** — `PUT`/`POST` of a project do not accept a `log` field (the detail DTO does not have one). Transferring the journal in this direction is not implemented; while it is needed — transfer the project as a portable archive (§5.8.1) or append the journal on the server with the point operations of §5.8.2.

> **Sessions on publish — dependency levels, in chunks (dedup by marker).** `syncProjectToRemote`
> (`remote/transfer.ts`) transfers sessions **level by level**: dependencies first, `parent_id` and
> `references` are rewritten to the already known remote ids. Each level is split into
> **chunks of 20** sessions (the `IMPORT_BATCH_CHUNK` constant), and each chunk is sent as one
> `POST /api/v2/sessions/import-batch` (§5.5) request instead of per-session ones. One HTTP
> request = **one** hit of `limits.sessionOpsPerMinute` (§5.21), so a very large project spends
> several hits (with the default 10/min — up to 200 sessions per minute); transfer requests use an
> increased timeout of **120 s** (`TRANSFER_TIMEOUT_MS` instead of the client's default 15 s) so
> that a long history or a large file is not cut off. The dedup marker is the local session id
> (`import.source_session_id`), so a repeated publish **updates** the already transferred sessions
> (`updated: true`) instead of creating duplicates; a `sourceSessionId` inherited from an earlier
> transfer is stripped from the body so that the chain A→B→C does not travel under a foreign id.
> An old server without `/import-batch` (404/405) — switch once to the per-session
> `POST /api/v2/sessions/import` **from the current chunk** for this and all subsequent levels
> (hybrid compatibility).

> **Publish progress — `GET /api/v2/projects/:id/publish/progress` (core, auth).**
> The UI polls it every 600 ms while `POST /:id/publish` is running (no new event channel is
> introduced — invariant 6). Snapshots live in `remote/transfer-progress.ts`
> (`TransferProgressRegistry`): **in-memory**, key `userId:projectId`, TTL **10 minutes**;
> the response carries counters only — no paths, file names or secrets.
>
> | Field | Value |
> |---|---|
> | `active` | `true` while the transfer is running |
> | `phase` | `idle` \| `project` \| `sessions` \| `files` \| `done` \| `error` |
> | `percent` | integer 0..100, monotonic (never decreases) |
> | `sessions` | `{done, total}` — sessions |
> | `files` | `{done, total, bytesDone, bytesTotal}` — files |
> | `startedAt` / `updatedAt` | an ISO string or `null` |
> | `error` | a short text for `phase:"error"`, otherwise `null` |
>
> **Percent.** Both phases non-empty — sessions 50 % (by count) + files 50 % (by bytes; no
> bytes — by count); one phase non-empty — its share is 100 %; both empty — 0 %, and the
> `done` finish sets 100 %. Success — `active:false, phase:"done", percent:100`; failure —
> `active:false, phase:"error"` + `error`. **Never published / unknown project / another
> user** — `{active:false, phase:"idle", percent:0}`, counters `0`, `startedAt`/`updatedAt:
> null`. A `remote:` id → `400 VALIDATION_ERROR`. Polling an old core (no endpoint, 404) —
> the UI shows no progress.

> **The project list — paged and summarized (owner decision, a breaking change).** `GET /api/v2/projects` returns a **page** `{projects, total, offset, limit, next_offset}` (an array is no longer returned — backward compatibility is not supported) and a **summary** of the project: the heavy fields `log` (the project log) and `plan` (ADR-039) are not returned by the list — in a list they would multiply the response size. The full DTO is in the detail `GET /api/v2/projects/:id` (there `plan` stays, while `log` is **moved out** to the paged endpoint `GET /api/v2/projects/:id/log` — PROP-054). The other detail fields (name, icon, color, members, workspace, repositories, the MCP scope, the memory policy, the status messages, `current_task`, `invariants`) are kept in the summary.
> **List pagination.** `total` — the number of visible projects; `next_offset` — the cursor of the next page (`offset + page.length`), `null` — the last page. A non-numeric/fractional/negative `limit`/`offset` → `400 VALIDATION_ERROR`; a `limit` above 500 is clamped to 500.
> **Hybrid: pagination across the world boundary is impossible.** A remote list arrives **without** paged output (an old server returns an array), so the end-to-end `next_offset` with remote projects present — `null`, and `total` — the sum of the local counter and the remote ones.
> `workspace` (ADR-075): on `POST`/`PUT` the directory is created (`mkdir -p`). Managed: an empty `workspace` → the auto name
> `slugify(name)` + a suffix under `workspacesRoot`; an absolute path inside root is normalized to a relative one; outside root →
> `403 WORKSPACE_OUTSIDE_ROOT_DENIED`; changing `workspace` — owner/LEAD/ADMIN, otherwise `403 FORBIDDEN`.
> RBAC (backend, D5): `PUT` content (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `repos`, `plan`) — owner/EDITOR/LEAD/ADMIN; `workspace` — owner/LEAD/ADMIN; `DELETE` — owner/LEAD/ADMIN; otherwise `403 FORBIDDEN`.
> **Visibility of `GET /api/v2/projects` and `GET /api/v2/projects/:id` (ADR-089).** In the list, `ADMIN`/`LEAD` see **all** projects, the rest — only their own (`owner` or `members`). Reading a project by id — `owner`, **any member** (`members`, any role, including `VIEWER`), as well as `ADMIN`/`LEAD`; otherwise `403 FORBIDDEN`. This is a **read level**: it does **not** extend the modification rights — `manage` (`workspace`/`DELETE`/MCP scope) and content `edit` remain owner/EDITOR/LEAD/ADMIN, `VIEWER` reads but does not edit (see `canRead` vs `canManage`/`canEditContent`).
> Tool-level RBAC (core chat tools, ADR-075/D5): `plan_write`/`project_log_write`/`project_log_update`/`project_log_delete`/`project_invariants_write` write only for owner/EDITOR (otherwise `project.write_forbidden`) — the same domain services as the HTTP routes.
> In core there are no role checks (any authenticated user). Core/standalone:
> an absolute path outside root — `deny` → `403`, `confirm` without `confirmOutsideRoot` → `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`.
> Directory creation error → `422 WORKSPACE_CREATE_FAILED`.

### 5.8.2 Project plan, journal and invariants (both, PROP-054)

Point operations over the working data of a project. The rights follow the **project rules**
(ADR-089 §5.5/§5.8): reading — the right to **read** the project (`canReadProject`:
owner/any member, including `VIEWER`, as well as `LEAD`/`ADMIN`); mutations — the right to
**modify the content** (`canEditProjectContent`: `OWNER`/`EDITOR`/`LEAD`/`ADMIN`).
`VIEWER` reads but does not mutate (invariant 21). The check is a **boundary** one
(invariant 16): there are no access checks in the handlers.

| Method | Path | RBAC | Purpose / req-resp |
|---|---|---|---|
| GET | `/api/v2/projects/:id/plan` | read | The whole plan: `{plan}` (`plan: null` — there is no plan) |
| POST | `/api/v2/projects/:id/plan/items` | write | Create an item: `{title, description?, columnId?, priority?, dependsOn?, tags?}` → `{plan}`. Without `columnId` — the `backlog` column, and if it is missing — the first one by `order` |
| PATCH | `/api/v2/projects/:id/plan/items/:itemId` | write | Patch the fields of an item: `{title?, description?, priority?, tags?, dependsOn?}` → `{plan}`. The plan version is **not required** (the patch is applied to the current item under the storage lock) |
| PATCH | `/api/v2/projects/:id/plan/items/:itemId/move` | write | Move: `{columnId, beforeItemId?, afterItemId?, version?}` → `{plan}`. After the move the order of the column is normalized to `0..n-1` |
| DELETE | `/api/v2/projects/:id/plan/items/:itemId` | write | Delete an item → `{plan}` |
| POST | `/api/v2/projects/:id/plan/columns` | write | Create a column: `{name, wipLimit?}` → `{plan}` |
| PATCH | `/api/v2/projects/:id/plan/columns/:columnId` | write | Patch a column: `{name?, wipLimit?}` → `{plan}` |
| DELETE | `/api/v2/projects/:id/plan/columns/:columnId` | write | Delete a column: `{moveItemsTo: string\|null, version}` → `{plan}`. `moveItemsTo` — where the items move (mandatory: the items are not deleted together with the column); `version` is mandatory |
| PUT | `/api/v2/projects/:id/plan/columns/order` | write | The new order of the columns: `{order: string[], version}` → `{plan}` (the full list of ids; the columns not named stay at the end) |
| GET | `/api/v2/projects/:id/log` | read | A page of the journal: `{entries, total, offset, limit, next_offset}`; `?limit=` (default 50, maximum 200), `?offset=` (default 0). **The newest entries first** |
| POST | `/api/v2/projects/:id/log` | write | A new entry: `{text}` → 201 `{entry}` |
| PATCH | `/api/v2/projects/:id/log/:entryId` | write | Patch the text of an entry: `{text}` → `{entry}` (additive `updated_at`/`updated_by`) |
| DELETE | `/api/v2/projects/:id/log/:entryId` | write | Delete an entry → `204` |
| GET | `/api/v2/projects/:id/invariants` | read | The invariants: `{invariants, updated_at}` |
| PUT | `/api/v2/projects/:id/invariants` | write | Replace the invariants: `{invariants}` → `{invariants, updated_at}` (last-write-wins) |

> **The plan version (optimistic locking).** `plan.version` grows on every plan mutation.
> The operations `move`, the column deletion and `columns/order` require the version
> (`version` in the body): on a mismatch — `409 PLAN_VERSION_CONFLICT`, the body carries the
> **current plan** (`plan`) and `error.details.{expected,actual}`; the client refetches the
> plan and repeats the edit. The single field patches of an item do not require a version.
>
> **Errors:** `400 VALIDATION_ERROR` (an invalid body, including a Markdown limit overrun),
> `403 PROJECT_FORBIDDEN` (no right to modify the content), `404 NOT_FOUND` (no project/item/
> column/entry), `409 PLAN_VERSION_CONFLICT`.
>
> **Markdown limits** (`MARKDOWN_LIMITS` in `@itphx/synth-shared`): the item description —
> 16 KiB, the text of a journal entry — 16 KiB, the invariants — 64 KiB. An overrun —
> `400 VALIDATION_ERROR`.
>
> **Events.** After a plan mutation — `plan.updated` in the channels of **every session of
> the project** (`{project_id, version}`); after a journal mutation — `project.updated`
> (`kind:'log'`), after an invariants mutation — `project.updated` (`kind:'invariants'`) —
> also to the channels of every session of the project.
>
> **Hybrid (ADR-042/ADR-130).** For a remote project (`remote:<uuid>`) the operations are
> **forwarded** to the remote backend: the method, the path, the body and the query
> (`limit`/`offset`) are preserved, the local id is stripped (the `remote:` prefix). The rights
> and the validation are decided by the **remote side** (with its own token and its own project
> rules) — therefore the forward happens **before** the local access check and the local body
> validation. The remote response is returned as is: the status and the body (including
> `409 PLAN_VERSION_CONFLICT` with the current plan), `204` — an empty body. Transport errors —
> `502 OFFLINE` (the server is unreachable) and `401 UNAUTHORIZED`; the hybrid is not configured
> (no client) — `502 REMOTE_UNAVAILABLE`.

### 5.8.1 Portable project export/import — `/api/v2/projects` (both, ADR-091 §6)

Moving a project between Synth instances: download a self-contained
`<name>.synth-project.tar.gz` archive and import it from the UI/API. A single factory,
`createProjectPortableRoutes`, serves core and backend; the work lives in the core
(`packages/core/src/projects/portable.ts`). The archive contains `manifest.json`
(sha256 entries), `project.json`, and `sessions/<id>.json`; optionally `workspace/**`.
**By default the archive contains no secrets** (keys, tokens, credentials, `secrets/` are not
included), and when the session payloads are packed the **Gateway obfuscation map** (ADR-036) is
stripped: `obfuscation_map` at the session level and `metadata.secrets` — **recursively, anywhere in the
payload**, i.e. for every carrier of session messages (`messages[]`, `pendingMessages[]`,
`checkpoints[].messages[]`) — a project archive does not carry away other
members’ secrets. The opt-in `?withSecrets=true` is allowed for **`ADMIN`/`LEAD` only** (in core —
the local owner); the issuance is recorded in the maintenance audit journal (`export.created`,
detail `withSecrets: true`), and such an archive is **a secret itself**. The import accepts a map
when one is present, so an archive produced with the privileged opt-in imports correctly.

Import is **materialization** (ADR-089, invariant 15): a **new** `projectId` and new
sessions are created (source id → new id in `idMap`), not via the `session.requested`
funnel. `mergeInto` imports sessions into an existing project. The core notifies the hub
(`onSessionCreated` → owner subscription, ADR-089 invariant 18). Operations are recorded
in the maintenance audit journal (`export.created`/`import.applied`, ADR-092).

**The instance storage context.** The export and the import go through the instance
`StorageContext` (ADR-096), not through their own file context: on `storage.backend=postgres`
downloading the archive used to return 404 for every database project, while the import went
into the file store (split-brain).

**The project journal in the archive (PROP-054).** The journal **is** in `project.json` of the
archive — that is `serializeProjectArchive` (summary + `plan` + `log`), not `serializeProject`
(the API detail, which no longer has the journal). The import restores the entries in the
domain form (camelCase: `createdAt`/`sessionId`/`author`/`updatedAt`/`updatedBy`), so the
export → import round trip **does not lose** the entries (the regression test —
`packages/core/src/projects/portable.test.ts`).

| Method | Path | Build | RBAC (managed / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/projects/:id/export` | both | auth / owner·member·LEAD·ADMIN | Download a portable archive (streaming): `Content-Type: application/gzip`, `Content-Disposition: attachment; filename="<slug>.synth-project.tar.gz"`, `Content-Length`; query `withWorkspace=true` (by default no `workspace/**`) and `withSecrets=true` (`ADMIN`/`LEAD` only, in core — the local owner; by default the obfuscation map is stripped); no project → 404 `NOT_FOUND`; no read right → 403 `FORBIDDEN` |
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

**Unpacked-volume limits.** The import is limited not only by the size of the uploaded file but also by the
**unpacked** volume of the archive (protection against archive bombs): `DEFAULT_PROJECT_IMPORT_LIMITS` —
**100 000 entries**, **128 MiB** per entry, **2 GiB** in total
(`packages/core/src/projects/portable.ts`). The check runs **while the archive is being read**: the
per-entry limit is compared against the tar header **before** the content is buffered, the total limit against
the sum of the declared sizes, the entry count against the counter — so exceeding them **aborts the parsing**
instead of stating a fact after the unpacking. Exceeding → **400 `VALIDATION_ERROR`** with the code
`invalid-archive` (the existing code, no new one was introduced); the limits can be overridden
programmatically through `ImportProjectOptions.limits`.

**Export/import asymmetry.** The project export is **not** limited by the unpacked-volume limit — the
archive is streamed to disk, there is nothing to unpack there; the **import** is limited. The
**instance backup restore** path (`synth restore`, `POST /api/v2/maintenance/restore`) is a different
artifact with its own size policy and is **not** limited by these limits.

**Error codes.** 400 `VALIDATION_ERROR` (a broken/corrupted archive, a sha256 mismatch,
an unsafe path in the archive, an unsafe path in `workspace/**` — a symlink on the path or a
realpath-containment violation, fail-closed, a workspace restore error, a non-multipart body, or a missing
`file`, exceeding the unpacked-volume limits), 404 `NOT_FOUND` (no project or no `mergeInto` target), 409 `CONFLICT` (the project
name is taken), 413 `PAYLOAD_TOO_LARGE` (the limit is exceeded), 401/403 (no credentials/no
project read or edit right). Sources — `packages/core/src/server/routes/project-portable.ts`,
`packages/core/src/projects/portable.ts`.

### 5.9 Providers — `/api/v2/providers`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/providers` | both | auth / auth | Provider list |
| POST | `/api/v2/providers` | both | ADMIN / auth | Create/update |
| GET | `/api/v2/providers/:name` | both | ADMIN / auth | One (apiKey masked) |
| PATCH | `/api/v2/providers/:name` | both | ADMIN / auth | Partial update (`num_ctx`, `compatibility`, …) |
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

> **Provider compatibility layer — `compatibility` (ADR-117, 2026-10-30; native media — 2026-11-03).**
> An optional `ModelCompatibility` object: `reasoningField` (the openai-chat reasoning field name, default
> `reasoning_content`), `requireReasoning`, `maxTokensField` (`max_tokens` \| `max_completion_tokens`),
> `requireAssistantAfterTool`, `streamUsage`, `supportsToolChoice`, `cacheFormat` (`anthropic` \| `alibaba` —
> `cache_control` inline markers, budget ≤4; when set, `prompt_cache_key` is not sent), `requireFinishReason`
> (default `true`), `supportsEffortUpdates` (default `false`), `supportsNativeVideo` (default `false`) and
> `nativeAudioFormats` (the list of containers of the native path: `wav` \| `mp3` \| `ogg`). Here these are
> the **provider defaults**
> for all its models; a model overrides fields pointwise (`ModelConfig.compatibility`, §5.10). Semantics —
> **replacement**: the object replaces the value entirely (a field missing from the object means “auto”,
> not “keep the previous value”), `null`/`{}` — reset, the field absent — unchanged; an unknown field or a
> wrong type → `400 VALIDATION_ERROR` (a typo is never silently lost). `GET /api/v2/providers` and
> `GET /:name` return `compatibility` **only when set**. Resolution priority — model → provider →
> heuristic → default; heuristics: DeepSeek (`requireReasoning`), the Mistral family
> (`requireAssistantAfterTool`), native Ollama (`supportsToolChoice: false`), and for native media — the
> matrix “protocol type × RouterAI-compatible host” (`nativeAudioFormats`/`supportsNativeVideo`).
> Semantics of the native-media fields: “auto” (the field is not set) = the server heuristic;
> `supportsNativeVideo: false` — “does not take it natively”; an **explicit empty list**
> `nativeAudioFormats` — “no native format at all” (audio through the aux model only). An empty list
> overrides the heuristic (`??` does not collapse `[]`).
> Details and examples —
> [CONFIGURATION.md](../CONFIGURATION.md) §“Model catalog”.

### 5.10 Models — `/api/v2/models`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/models` | both | auth / auth | **Page** of the model catalog: `{models, total, offset, limit, next_offset}`; `?limit=` (default 100, maximum 500), `?offset=` (default 0). Filters: `?provider=` (the exact provider id), `?enabled=true\|false` (only the enabled/disabled ones; the legacy alias `?enabled_only=true` = `enabled=true`), `?search=` (a case-insensitive substring over the id/name/provider), `?modality=` (the input modality: `text`/`image`/`pdf`/`audio`/`video`). The model DTO is a flat object: `id`, `name`, `provider` (**a string**, not a provider object), `description`, `enabled`, `isDefault`, `contextWindow`, `contextSource`, `maxOutputTokens`, `inputPrice`, `outputPrice`, `cacheReadPrice`, `cacheWritePrice`, `priceSource`, `currency`, `modalities?`, `requiresReasoning?`, `compatibility?`. ⚠️ **Breaking change:** the response used to be `{groups:[{provider:{name,type,icon,defaultModel,currency}, models:[…]}]}` — now it is a flat paged list (the client rebuilds the grouping by provider itself) |
| POST | `/api/v2/models` | both | ADMIN / auth | Create/update |
| POST | `/api/v2/models/fetch` | both | ADMIN / auth | Sync with the providers |
| DELETE | `/api/v2/models/:id` | both | ADMIN / auth | Delete |

> **The model catalog — paged and flat (owner decision, a breaking change).** `GET /api/v2/models` returns a **page** `{models, total, offset, limit, next_offset}` — **an array is no longer returned** (backward compatibility is not supported). Previously the response was an object `{groups:[{provider:{name,type,icon,defaultModel,currency}, models:[…]}]}`; now it is a flat list of models, each with `provider` — a **string** (the provider id), and the provider metadata block (`type`/`icon`/`defaultModel`/`currency`) is **not** in the response (the provider type/icon/currency — in `GET /api/v2/providers`). The filters and the sorting are applied **before** the pagination: `total` — the number of the selected models (after all the filters), the order — first by provider, then by name (`localeCompare`). The parameter boundaries are **hard** (unlike the soft boundary of the other lists): `limit` outside `1…500` (including `0`) or a non-integer, `offset` non-integer/negative → `400 VALIDATION_ERROR` — a value above 500 is **rejected**, not clamped.
> **The `modality` filter and unknown modalities.** A model matches the filter only if its `modalities` are **known** and contain the given modality; a model with **unknown** modalities (the field is absent) does **not** match the filter — accepting an attachment cannot be confirmed (the same logic as in the `list_models` tool). Modalities that are **not known** — the filter is not applied to that particular modality, the model is never silently excluded from the catalog.
> **The `enabled` filter — both directions.** `enabled=true` — only the enabled ones, `enabled=false` — only the disabled ones; `enabled_only=true` — the legacy alias of `enabled=true` (kept for old clients). The values `1`/`0` are accepted as `true`/`false`.
> **Hybrid: the catalog is shared, the pagination is local.** In hybrid mode the local and the remote catalogs are merged **before** the filters and the pagination (a model without a known provider does not get into the output), so `total`/`next_offset` are counted over the merged set — but the remote part arrives **without** paged output (an old server returns the whole list), so with remote models present `next_offset` may become `null` before the list is actually exhausted.

> **Model compatibility — `compatibility` and `requires_reasoning` (ADR-117, 2026-10-30; native media —
> 2026-11-03).** A model may
> override the provider compatibility layer (§5.9) with the `compatibility` field — the same object
> (`reasoningField`, `requireReasoning`, `maxTokensField`, `requireAssistantAfterTool`, `streamUsage`,
> `supportsToolChoice`, `cacheFormat`, `requireFinishReason`, `supportsEffortUpdates`,
> `supportsNativeVideo`, `nativeAudioFormats`), semantics are **replacement**: the object
> replaces the value entirely, `null`/`{}` — reset, the field absent — unchanged, an unknown field/type →
> `400 VALIDATION_ERROR`.
> The native-media fields are overridden pointwise: `supportsNativeVideo: true` enables the native
> `video_url` block (by default — only on RouterAI-compatible hosts), and `nativeAudioFormats` lists the
> accepted containers (`wav`/`mp3`/`ogg`); an **empty list** is a meaningful value — “none at all” (audio
> through the aux model only) — and it overrides the heuristic.
> `requires_reasoning` (the camelCase `requiresReasoning` too) is a **shorthand** for
> `compatibility.requireReasoning`: `true` — the reasoning field is mandatory on **every** assistant
> message (an empty string when there is no reasoning), `false` — force off, `null` — reset (clears both
> the shorthand and `compatibility.requireReasoning`). Normalization — `compatibility.requireReasoning ??
> requiresReasoning`. `GET /api/v2/models` returns `compatibility` and `requiresReasoning` **only when
> set**: an absent field means auto detection (the heuristic: provider type/name `deepseek`, a URL with
> `deepseek.com`, a model id with `deepseek`), not `false`. Needed for DeepSeek-compatible gateways with a
> non-default provider/model name and for proxies with a different reasoning field name (`reasoning`) or
> output limit. Field/priority reference — [CONFIGURATION.md](../CONFIGURATION.md) §“Model catalog”.

### 5.11 Agents — `/api/v2/agents`

| Method | Path | Build | RBAC (backend / core) | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/agents/all` | both | ADMIN / auth | All agents (admin panel) |
| GET | `/api/v2/agents` | both | auth / auth | Primary agents only |
| POST | `/api/v2/agents` | both | ADMIN or scope `automation:install` / auth | Create/update |
| GET | `/api/v2/agents/:id` | backend | ADMIN | Agent + builtin/override |
| DELETE | `/api/v2/agents/:id` | both | ADMIN or scope `automation:install` / auth | Delete custom / reset built-in |
| PATCH | `/api/v2/agents/:id/enabled` | backend | ADMIN or scope `automation:install` | `{enabled}` |

> **Writing agents — “role ADMIN **or** scope `automation:install`” (ADR-052).**
> The umbrella scope of the extension-package installer: an agent together with its
> role prompt is part of a package. The guard is
> `requireAdminRoleOrScope('automation:install')`: for a service key, **either** one
> is enough (the scope `automation:install` **or** the role `ADMIN` among the key
> roles — the previous rights of a key with the ADMIN role are not taken away); for
> interactive credentials the role `ADMIN` is required (401 `UNAUTHORIZED` without
> authentication, 403 `FORBIDDEN` without the role, 403 `SCOPE_REQUIRED` — for a
> service key with neither the scope nor the ADMIN role). In core (standalone)
> interactive access is `auth`, a service key — the same scope **or** the ADMIN
> role. The `addons:install` scope does **not** open agent creation.

> **Agent role prompt (ADR-046/ADR-089).** `POST /api/v2/agents` accepts an optional `role_prompt`
> (alias `rolePrompt`) field — the **content** of the role prompt (not a path). The role file is
> written to `{dataDir}/context/roles/<contextFile>` (the agent's `contextFile`, otherwise
> `<AGENT_ID_UPPER>.md`) and takes priority over the built-in `prompts/roles/` (resolution —
> `getRolePrompt`). The write is atomic (tmp → rename); an already existing file with different
> content is overwritten (explicit install/update) — the fact is reported in the response
> (`role: {file, written, replaced}`) and in the `AGENTS` log. The permission is the same as for
> agent creation (managed — ADMIN, standalone — auth). The role content is not stored in the agent
> definition: the agent refers to the file via `contextFile`.
> **Agent groups (ADR-046 §6.2).** Optional `groups` field (array of strings) — skill binding via
> `metadata.synth.groups`; priority `body → existing → builtin`, empty/duplicate/non-string items
> are dropped. The field is returned by `GET /agents/all` (`groups`) and in the `POST /agents`
> response.

### 5.12 Files — `/api/v2/fs`

| Method | Path | Build | RBAC | Purpose |
|---|---|---|---|---|
| GET | `/api/v2/fs` | both | auth | Directory listing: `{path, entries, truncated}`; `?project_id=&path=&maxDepth=&includeHidden=`. `maxDepth` — **not above 3** (`MAX_FS_LIST_DEPTH`; a larger value from the request is silently clamped to 3), with `maxDepth>0` the recursive walk is limited to **10 000 entries** (`MAX_FS_LIST_ENTRIES`): when the budget is exhausted the walk stops, and the response carries `truncated: true` (the response is **incomplete**). With `maxDepth=0` (the default) the listing is not recursive and the entry limit does not apply |
| GET | `/api/v2/fs/read` | both | auth | Contents: `{path, content, size, encoding}`; `?project_id=&path=`. **The read cap** — `storage.maxReadBytes` (5 MiB by default, env `SYNTH_MAX_READ_BYTES`): the size is known from `stat`, the content is not read into memory. A file **larger than the limit** or a **binary** one → `413` with the machine code `FILE_TOO_LARGE` and `details: {maxReadBytes, size, reason}` (`reason`: `size` — the size is too large, `binary` — not a text file) |
| GET | `/api/v2/fs/raw` | both | auth | File preview (media/PDF) as a byte stream; `?project_id=&path=`. **Inline** — only the `INLINE_PREVIEW_KINDS` families (`image`/`video`/`audio`/`pdf`): `Content-Type` by extension (`fileMime`) + `Content-Disposition: inline`; everything else (HTML, code, text, unknown) → `application/octet-stream` + `attachment` (not `inline`, otherwise HTML would execute in the application origin — XSS). SVG — `image/svg+xml` + `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Always `Accept-Ranges: bytes`, `ETag` (size + mtime), `Last-Modified`, `Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`. `Range: bytes=…` → `206` + `Content-Range`; `If-None-Match` → `304`; an unreachable range → `416`. **Cap** — `storage.maxPreviewBytes` (100 MiB by default, env `SYNTH_MAX_PREVIEW_BYTES`): a file larger than the limit → `413` `FILE_TOO_LARGE` + `details: {maxPreviewBytes, size, reason:'preview_size'}`. A remote (`remote:`) project is proxied to the remote world (the `Range` header is forwarded) |
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
> **Reading a file — the `storage.maxReadBytes` cap (owner decision).** `GET /fs/read` no longer returns a file of any size in full: the size is known from `stat` **before** the content is read, so a file larger than the limit (5 MiB by default) or a binary one → `413` `FILE_TOO_LARGE` with `details: {maxReadBytes, size, reason}`. The client reads `details` in a machine-readable way instead of parsing the message text. Previously a binary file was returned as `{content:'', encoding:'binary'}` — now that is the same `413` refusal (the reason — in `details.reason`). The limit is configured by `storage.maxReadBytes` / the env `SYNTH_MAX_READ_BYTES` (the priority env > config > default) — see [CONFIGURATION.md](../CONFIGURATION.md) §“Storage and working directory”.
> **File preview — `GET /fs/raw` (inline allow-list, `Range`, cap).** The difference from `/read` (text in JSON) and `/download` (attachment): the bytes are streamed (`createReadStream` + `Readable.toWeb`), the MIME type comes from the extension, seek is supported (`Range`/`206` for video/audio), as is a conditional request (`ETag`/`304`), and a separate limit `storage.maxPreviewBytes` applies. **Inline is allowed only for the `INLINE_PREVIEW_KINDS` families** (`image`/`video`/`audio`/`pdf`, exported by `@itphx/synth-shared`); HTML/CSS/JS/text/code and unknown extensions are served as `application/octet-stream` + `Content-Disposition: attachment` — a direct `inline` for `text/html` would execute scripts in the application origin (XSS). SVG is active content, so the document is isolated with a CSP header (`default-src 'none'; style-src 'unsafe-inline'; sandbox`). `Range` understands `bytes=start-end`, `bytes=start-` and `bytes=-suffix`; an unparsable/multiple range is ignored (the whole file is served), an unreachable one → `416` + `Content-Range: bytes */<size>`. `HEAD` — the same headers without a body. `404 NOT_FOUND` (no file), `400 IS_DIRECTORY` (the path is a directory) — as with the neighbouring FS routes.
> **Recursive listing — depth and entry budget.** `maxDepth` is limited to **3** (it was 10): a deep directory walk and the response size for it grow uncontrollably. With `maxDepth>0` the walk runs with a budget of **10 000 entries** — when it is exhausted the walk stops, and the response carries `truncated: true` (the list is **incomplete**; the client must take this into account and must not consider the list exhausted). With `maxDepth=0` (the default) the list is not recursive, the budget does not apply and `truncated` is always `false`.
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
`project.workspace` (symlink-aware containment: an absolute path/`..`/escape through a
symlink to the outside → `git.repo_path_invalid`).
Errors — in the shared shape `{ error: { error, code } }`.

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| POST | `/api/v2/git/scan` | read / auth | `{projectId}` → `{repos}` (git detection over the workspace, up to 3 levels) |
| POST | `/api/v2/git/repos/init` | write / auth | `{projectId, path, defaultBranch?, name?, sshKeyId?}` → 201 `RepoStatus`; registers an entry |
| POST | `/api/v2/git/repos/clone` | write / auth | `{projectId, url, path?, branch?, name?, sshKeyId?}` → 201 `RepoStatus`; an SSH URL without a key → 400 `git.ssh_key_required`; a taken path → 409 `git.repo_exists` (+`details.occupied`); a timeout → 504 `git.clone_timeout` |
| POST | `/api/v2/git/repos/register` | write / auth | `{projectId, path, name?, url?, type?, defaultBranch?, sshKeyId?}` → 200 `GitRepoConfig` (upsert by `id`/`path`) |
| POST | `/api/v2/git/repos/remove` | write / auth | `{projectId, id?\|path?, deleteLocal?}` → `{removed, deletedLocal}` (deleting the local directory — `deleteLocal`) |
| POST | `/api/v2/git/repos/fetch` | write / auth | `{projectId, id?\|path?}` → `{path, lastFetch}`; an SSH URL without a key → 400 `git.ssh_key_required`; a timeout → 504 `git.fetch_timeout` |
| GET | `/api/v2/git/log` | read / auth | `?project_id=&repo_path=&max_count=` → `{commits}` |
| GET | `/api/v2/git/commit` | read / auth | `?project_id=&repo_path=&hash=` → `{commit}`; the commit diff is truncated at the **1 MiB** limit (`MAX_COMMIT_DIFF_BYTES`) — the DTO gains `diff_truncated: true` (the field is absent when the diff was returned in full) |

Backend RBAC: write endpoints (`init`/`clone`/`register`/`remove`/`fetch`) — owner/EDITOR/LEAD/ADMIN (`canEditProjectContent`), otherwise 403; read (`scan`/`log`/`commit`) — the **read** right on the project: owner/project member/`LEAD`/`ADMIN` (`canReadProject`), otherwise 403. The check is a **boundary** guard (`projectGuard('read'|'write')` in the core factory `createGitRoutes`), i.e. **before** the handler; there are no access checks inside the handlers (invariant 16). Core (standalone) — `requireAuth` (standalone has no per-project rights).

**An occupied target path** (`clone`). The check is filesystem-based, without running git; the state
is returned machine-readably in `details.occupied`, while the message names the **action**:

| `details.occupied` | What is in the directory | Action in the message |
|---|---|---|
| `repo` | a full repository (`.git` with commits) | register the existing one (`POST /api/v2/git/repos/register`), no re-clone needed |
| `stub` | a `.git` **without** commits — a trace of an interrupted clone | delete the directory and retry the clone |
| `dir` | a non-empty directory without git (`details.entries` — the number of entries) | choose another path or clean the directory |

In all three cases the code is `git.repo_exists` (409); the message and `details.occupied` differ.
Clone atomicity: git gets a **temporary** directory `<path>.tmp-<uuid>` next to the target, and the
target appears only after the success (`rename`); after a failure/timeout nothing is left on disk.
An unreadable directory (no permissions) → **409 `git.repo_path_unreadable`**.

**Network operation timeouts.** Exceeding `git.cloneTimeoutMs`/`git.fetchTimeoutMs`
(the `git` section, see [CONFIGURATION.md](./CONFIGURATION.md)) — **504** `git.clone_timeout` /
`git.fetch_timeout` (not 500: this is not a server failure, the request can be retried). Other git
errors (no remote, a dropped connection, no permissions) are returned as-is (500 with the original text).

**Commit diff — truncation by size.** `GET /api/v2/git/commit` returns the commit diff **in full**
while it is not larger than **1 MiB** (`MAX_COMMIT_DIFF_BYTES`); larger — the diff is truncated at the
byte boundary (a broken trailing UTF-8 character is dropped), and the commit DTO gains
`diff_truncated: true`. The field is absent when the diff was returned in full. Megabytes of patch do
not go over the wire; the list of the changed files (`files`) is full at the same time.

> **Behaviour change (managed).** A request for a **non-existent** `projectId` in `/api/v2/git/*` now answers **403 instead of 404** — fail-closed, no existence disclosure (like the FS routes). Previously the read routes (`scan`/`log`/`commit`) did not check access at all and allowed reading another project’s git data by its id.

### 5.15.1 Agent SSH keys — `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` (both, ADR-076)

Responses — only `SSHKeyMeta` (`id`/`name`/`type`/`agentIds`/`usages`/`allowHosts`/
`allowPorts`/`createdAt`/`updatedAt`); `privateKey`/`passphrase` are encrypted at-rest
(AES-256-GCM) and are **never** returned.

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| GET | `/api/v2/ssh-keys` | auth | All keys; `?agentId=` — an agent's keys |
| POST | `/api/v2/ssh-keys` | ADMIN / auth | Create: `{name, type?, privateKey, passphrase?, agentIds?, usages?, allowHosts?, allowPorts?}` → 201 |
| GET | `/api/v2/ssh-keys/:id` | auth | Key by id |
| PATCH | `/api/v2/ssh-keys/:id` | ADMIN / auth | Partial update (including changing `privateKey` and the policy) |
| DELETE | `/api/v2/ssh-keys/:id` | ADMIN / auth | Delete the key entirely → 204 |
| GET | `/api/v2/agents/:agentId/ssh-keys` | auth | Keys linked to the agent |
| POST | `/api/v2/agents/:agentId/ssh-keys` | ADMIN / auth | Create with a link to the agent (merges `agentIds`) → 201 |
| DELETE | `/api/v2/agents/:agentId/ssh-keys/:keyId` | ADMIN / auth | **Unlink** the key from the agent (the key is not deleted) |

**Key policy (PROP-124).** Three fields define how a key is fit for use:

| Field | Type | Rules | Default |
|-------|------|-------|---------|
| `usages` | `('git'\|'ssh')[]` | **at least one** value; an unknown value → 400 | `['git']` — keys created before stage Ф1 have no such field; on read it is normalized to `['git']` (fail-closed) |
| `allowHosts` | `string[]` | ≤ **50** rules; a rule is an exact hostname, `*.suffix` (**subdomains only** — the suffix itself does not match), an IP literal or a CIDR (**only by IP literal**); the `*` pattern ("any host") is **forbidden** and allows nothing | `[]` — in the `tools` mode an empty list **allows no host at all**; in the `agent` mode the field is not applied |
| `allowPorts` | `number[]` | ≤ **10** ports; an integer **1..65535** | `[]` — only the standard ssh port (**22**) is allowed |

- `usages` — how the key is used: `git` (the key is injected into git operations,
  `GIT_SSH_COMMAND`) and `ssh` (the key is handed to the addressable tools in the `tools`
  mode or to the ephemeral `ssh-agent` in the `agent` mode).
- Host rules use the **shared matcher** of ADR-099 (`hostMatchesRule`): the semantics of
  `*.suffix`/CIDR/`*` are neither redefined nor duplicated.
- **Write errors — 400 `VALIDATION_ERROR`:** an empty `usages`; an unknown `usages` value;
  an invalid host pattern or an empty rule; a port outside 1..65535; exceeding the limits
  (50 hosts / 10 ports). Previously saved values are **not deleted** and take effect again
  when the instance mode is switched.
- **The policy applies only in the `tools` instance mode** (`ssh.mode`, §5.15.2): in the
  `agent` mode the host and port filtering is **not applied**.
- **A refusal by policy during a git operation** (`/api/v2/git/repos/clone|fetch` and the
  `project_repo_clone`/`project_repo_fetch` tools) gives **400 `git.ssh_key_required`** — the
  same code as "no key given": a key suitable for git operations is required. A key that
  does not exist gives `sshkey.not_found` (404).
- **Secrets are never returned:** `privateKey`/`passphrase` are not part of any response
  (`GET`/`POST`/`PATCH`) — only the key metadata goes out.

Codes: `sshkey.not_found` (404), `sshkey.name_exists` (409), `sshkey.decrypt_failed` / `sshkey.encryption_unavailable` (500), `sshkey.env_failed` (400, via `VALIDATION_ERROR`), `VALIDATION_ERROR` (400). Keys with a `passphrase` **are supported**: during a git operation `createSshEnv` prepares askpass (`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`), a preparation failure → `sshkey.env_failed`. In hybrid mode the nested `/api/v2/agents/:agentId/ssh-keys[/:keyId]` is proxied by core to backend (`REMOTE_PROXY_PATTERNS`), like the flat `/ssh-keys` and `/git`; other subpaths of `/api/v2/agents` stay local. The master key — `SYNTH_SECRET_KEY`/`security.secretKey`/`{dataDir}/secrets/master.key`; rotation — the `synth secrets rotate` CLI (not the HTTP API).

### 5.15.2 SSH access mode — `/api/v2/settings/ssh` (both, PROP-124)

Instance-wide runtime setting: how the SSH keys of the registry reach the consumer — `tools`
(addressable tools, mandatory host/port policy) or `agent` (an ephemeral `ssh-agent` for the
duration of the call). The source of truth is the code
(`packages/core/src/storage/runtime-settings.ts`, `resolveSshMode`/`createLiveSshMode`).

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| GET | `/api/v2/settings/ssh` | ADMIN (managed) / auth (core) | `{mode:"tools"\|"agent", saved:"tools"\|"agent"\|null, defaults:"tools"\|"agent", source:"env"\|"runtime"\|"config"\|"default", envLocked:boolean, restartRequired:false}` |
| PUT | `/api/v2/settings/ssh` | ADMIN (managed) / auth (core) | `{mode}` — runtime override (`settings.json`/PG), **applied immediately** (`restartRequired:false`); an invalid value → 400 `VALIDATION_ERROR`; the mode is locked by env and a different value is requested → 409 `CONFLICT`; audit `scope:"ssh"` |
| DELETE | `/api/v2/settings/ssh` | ADMIN (managed) / auth (core) | Reset the runtime value to env/config/default (the response is the same as for `GET`); audit `scope:"ssh"` |

- **Response fields:** `mode` — the effective mode; `saved` — the stored runtime value
  (`null` — not set); `defaults` — the base without the runtime value (what `DELETE` returns
  to); `source` — the source of the effective value; `envLocked` — the mode is pinned by an
  environment variable (the runtime does not override it); `restartRequired` — always `false`
  (switching the mode applies without a restart).
- **Priority — `env > runtime (UI) > config.yaml > default`** (`tools`).
- **Env locking — 409 `CONFLICT`:** when `SYNTH_SSH_MODE` is set, the runtime value from the
  UI does not override it. `DELETE` still resets the runtime to the base, but the effective
  value remains the env one (`mode` and `source` in the response show this).
- **An invalid env value is a configuration error at startup** (fail-closed, like
  `SYNTH_EXECUTION_MODE`): an instance with an invalid `SYNTH_SSH_MODE` does not come up.
  The branch is defensive — it answers 500 with the configuration text instead of silently
  falling back to the default.
- **Audit** (`scope:"ssh"`, actions `update`/`reset`) — best-effort: a failure to write the
  audit entry does not break the operation. Key material never reaches the audit (it holds
  the mode only).
- The mode is managed in the UI: the "Agents" section → "SSH keys" (mode switch; ADMIN).

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
| GET | `/api/v2/mcp/session/:sessionId` | backend | owner\|ADMIN | Legacy: `{mcpServers, mcpDisabledServers, allServers}` (canonical — `/sessions/:id/mcp`) |
| PUT | `/api/v2/mcp/session/:sessionId` | backend | owner\|ADMIN | Legacy: `{mcpServers?, mcpDisabledServers?}` (compatible with `/sessions/:id/mcp`) |
| POST | `/api/v2/mcp/probe` | both | auth | `{name}` → `{name, tools}`, `MCP_CONNECT_ERROR` |
| GET | `/api/v2/mcp/registry` | backend | auth | Unified MCP server registry (ADR-071 §2.5): `{entries}`; an entry carries `enabled` (master hard-gate, default `true`) and `enabledByDefault` (default for NEW projects) |
| POST | `/api/v2/mcp/registry` | backend | auth (stdio — ADMIN only; service-key — scope `addons:install`) | Add an entry: `{name, config, enabled?, enabledByDefault?, origin?, remoteMode?}` → 201; stdio — ADMIN only (a scope does not relax this); HTTP — anyone; a service-key without the `addons:install` scope → 403 `SCOPE_REQUIRED`. The **instance** origin (`origin:'instance'` or an installer key with the scope) is available to ADMIN **or** a service-key with the `addons:install` scope; interactive use without ADMIN creates a `user` entry even with `origin:'instance'`. `remoteMode` (`auto\|relay\|tools`, default `auto`) — the delivery mode of a server-side MCP into the local hybrid sessions (ADR-125) |
| PUT | `/api/v2/mcp/registry/:id` | backend | author/ADMIN or scope `addons:install` | Update an entry (`enabled` — the registry master flag); an installer key with the scope updates instance entries (the scope branch survives key rotation) |
| DELETE | `/api/v2/mcp/registry/:id` | backend | author/ADMIN | Delete an entry |
| GET | `/api/v2/mcp/remote/servers` | backend | auth (service-key — scope `mcp:invoke`) | The set of the server-side MCP servers (ADR-125): `[{name, type, origin, trust, enabled, enabledByDefault, remoteMode, status, toolCount, error?, instructions?}]` — **all** registry entries (`instance` + `user` of any author), without secrets and URLs |
| GET | `/api/v2/mcp/remote/tools?server=` | backend | auth (service-key — scope `mcp:invoke`) | The tool schemas of the server + `instructions`: `{server, instructions?, tools:[{server, name, description, inputSchema}]}`. 400 `VALIDATION_ERROR` (no `server`), 404 `MCP_REMOTE_SERVER_NOT_FOUND`, 502 `MCP_REMOTE_SERVER_DOWN` (the server did not come up), 503 `MCP_REMOTE_UNAVAILABLE` |
| POST | `/api/v2/mcp/remote/call` | backend | auth (service-key — scope `mcp:invoke`) | Call a tool: `{server, tool, arguments?, meta?}` → `{content, isError, attachments?}` (the shape of the executor protocol 5, ADR-077). 400 `VALIDATION_ERROR`, 404 `MCP_REMOTE_SERVER_NOT_FOUND`, 409 `MCP_SERVER_DISABLED` (off by the master flag), 502 `MCP_REMOTE_SERVER_DOWN`/`MCP_REMOTE_CALL_FAILED`, 503 `MCP_REMOTE_UNAVAILABLE` |
| POST | `/api/v2/mcp/relay/:name` | backend | auth (service-key — scope `mcp:invoke`) | The MCP relay of one server-side server (the `relay` mode, ADR-125): Streamable HTTP, **stateless** and in the JSON mode — no SSE streaming, no progress/elicitation/resources/prompts and no server-initiated notifications. 404 `MCP_RELAY_SERVER_NOT_FOUND`, 409 `MCP_SERVER_DISABLED`, 502 `MCP_REMOTE_SERVER_DOWN`, 503 `MCP_REMOTE_UNAVAILABLE` |
| GET, DELETE | `/api/v2/mcp/relay/:name` | backend | auth (service-key — scope `mcp:invoke`) | The relay has no sessions → `405 MCP_RELAY_SESSIONLESS` |

> **Server-side MCP in local hybrid sessions (ADR-125).** The local core does **not** reach the upstream MCP and does not see secrets: the network, TLS, the SSRF policy, and the credentials stay on the server (ADR-099/ADR-105). The scope of the server-side MCP is **as for remote sessions**: the system master `enabled` → the project gate `project.mcp.enabled` → the session snapshot `mcpDefaultOn`/`mcpDisabledServers` (there is no project bypass, unlike for the executor servers).
> **The delivery mode** — the `remoteMode` field of a registry entry (`auto|relay|tools`, default `auto`: `http`/`sse` → `relay`, `stdio` → `tools`); a mode change applies on the next connection. A failed relay — **always** degrades to `tools` with the reason in the status.
> **The project auto-seed.** The existing local projects receive the server-side `enabledByDefault` on the hybrid connection (idempotent, the `project.mcp.remoteSeeded` marker; the change publishes `project.updated`); new projects — the seed from `enabledByDefault`.
> **Offline.** The servers stay in `GET /api/v2/sessions/:id/mcp` with `status:'error'` and the reason in the `error` field (without secrets); the tools are not offered until the reconnect, and the reason is visible in the `mcp.status` prompt block too.
> **The feature marker** — `features.remoteMcp` in `GET /api/v2/meta` (§5.4): an old backend has no marker → the feature is silently off (fail-closed).

> MCP per-item resolution (ADR-071 §2.4): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; the default is opt-in (off). The registry master `enabled` and the project `enabled` are a live hard-gate (including old sessions and system servers); `enabledByDefault`/`project.defaultOn` are a snapshot (`mcpDefaultOn`). Reasons: `system_disabled\|project_disabled\|session_optout\|not_default`. `McpServerConfig.enabled` is only the seed of a registry entry (`seedFromConfig`) and does not participate in resolution. A missing `project.mcp` means no gate is set (legacy).
>
> `config.auth` (ADR-105 F0/F3) — a reference to an external access: `{kind:'credential', credentialId}`; the connector is authorized with a token from the access layer, the token itself never lives in the registry/config. The field is additive — entries without `auth` are valid. The transport injects the token (`Authorization: Bearer <token>` on every HTTP request); on `401` it refreshes the token and repeats the request — **exactly one refresh per request**. Issuing/rotating accesses is F4 (`/api/v2/oauth/credentials`, not implemented yet); until then an access is created in code (through the port) and connectors reference it by `credentialId`.
>
> **Plaintext secrets are forbidden (ADR-105 F3).** The headers `authorization`/`proxy-authorization`/`x-api-key`/`cookie` in `config.headers` are forbidden: registry writes (`POST/PUT /api/v2/mcp/registry`, `POST/PUT /api/v2/mcp/servers`) and `POST /api/v2/mcp/probe` → **400** `MCP_SECRET_HEADER_FORBIDDEN`; existing registry entries are migrated to `auth: { kind: 'credential', credentialId }`.
>
> **Binding rights (ADR-105 F3).** Binding an access to a connector is checked at the boundary: an own access (`owner.kind='user'`/`'local'`) — its owner; an instance access (`owner.kind='instance'`) — `ADMIN`/`LEAD`; a project access (`projectId`) — a project member with the right to **modify** content (`OWNER`/`EDITOR`, and also `LEAD`/`ADMIN`); no access — **404** (`NOT_FOUND`), no right — **403** (`FORBIDDEN`). The matrix — `packages/backend/src/routes/mcp-credential-bind.test.ts`.
>
> **OAuth provider catalog.** Provider descriptions (`authorizeUrl`/`tokenUrl`/`clientId`/`scopes?`/…) live in the config section `oauth.providers` (env override `SYNTH_OAUTH_PROVIDERS`); a `client_secret` is only an env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` or the file `{dataDir}/secrets/oauth/<provider>.client_secret`. The client used to refresh an access token is built from the description.

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
| GET | `/api/v2/settings/metrics` | ADMIN (managed) / auth (core) | Observability settings (ADR-094): `{metrics:{enabled}, defaults:{enabled}, isOverridden, source:"env"\|"runtime"\|"config"\|"default", running, restartRequired, token:{configured,source:"env"\|"file"\|"none"}, endpoints:{metrics:"/metrics",ready:"/ready"}}`; priority `SYNTH_METRICS_ENABLED` > runtime > config > `false` |
| PUT | `/api/v2/settings/metrics` | ADMIN (managed) / auth (core) | `{metrics:{enabled:boolean}}` — runtime override (`settings.json`/PG); **applied after a restart** (`restartRequired`); non-boolean → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/metrics` | ADMIN (managed) / auth (core) | Reset the runtime value to env/config/default (same response as `GET`) |
| GET | `/api/v2/settings/metrics/status` | ADMIN (managed) / auth (core) | Live snapshot: `{enabled, running, source, restartRequired, ready, storage:"ok"\|"degraded", storageBackend, version, uptimeSec, exposition:{series,bytes,droppedSeries}, token, endpoints}` |
| PUT | `/api/v2/settings/metrics/token` | ADMIN (managed) / auth (core) | Bearer token for `/metrics` (write-only): `{token}` (trimmed length ≥16) → `{dataDir}/secrets/metrics-token` (`0600`, atomic), applied **immediately**; short/empty → 400 `VALIDATION_ERROR`; token from env → 409 `CONFLICT`; the value is never returned |
| DELETE | `/api/v2/settings/metrics/token` | ADMIN (managed) / auth (core) | Delete the token file (idempotent) → `{token:{configured,source}}`; token from env → 409 `CONFLICT` |
| GET | `/api/v2/settings/limits` | ADMIN (managed) / auth (core) | Limit of heavy session operations (`limits.sessionOpsPerMinute`): `{sessionOpsPerMinute:number (0 — no limit), saved:number\|null, defaults:number, source:"env"\|"runtime"\|"config"\|"default", envLocked:boolean, restartRequired:false}`; priority `SYNTH_LIMITS_SESSION_OPS_PER_MINUTE` > runtime (`settings.json`/PG) > `config.yaml` `limits.sessionOpsPerMinute` > `10`. Limits `POST /sessions/import`, `POST /sessions/import-batch`, `GET /sessions/:id/export`, `POST /sessions/:id/fork`, `POST /sessions/:id/merge` (see §5.5) |
| PUT | `/api/v2/settings/limits` | ADMIN (managed) / auth (core) | `{sessionOpsPerMinute:number}` — an integer ≥ 0 (`0` — no limit; `-1`/fractional → 400 `VALIDATION_ERROR`), a runtime override, **applied immediately** (`restartRequired:false`: the limiters resolve the value on every request); the value comes from env and another one is requested → 409 `CONFLICT`; the response is the same as `GET`; audit `scope:"limits"` |
| DELETE | `/api/v2/settings/limits` | ADMIN (managed) / auth (core) | Reset the runtime value to env/config/default (same response as `GET`); audit `scope:"limits"` |

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
| POST | `/api/v2/events` | both | auth/key + rate limit | Accepting a normalized external event. Regular path: `Authorization: Bearer <user key>` → body `{source, type, payload?, identity?, dedupKey?, ts?, attachments?}` (`eventIngestSchema`). The binding-key path: `Authorization: Bearer synth_evt_…` — **without user credentials**, `source` is optional (`eventKeyIngestSchema`; source/chat/thread are taken from the binding; a `source` conflict → 400), the event is forcibly routed into the binding. The response in both cases → `201 {event, decision, sessionId}` + **optional** `identityHint?: {code, expiresAt}` (ADR-089 claim flow: a one-time code confirming identity ownership; it is filled in only when the sender is not identified — `resolveExternalIdentity` → `null` — and `identity.principalId` is set); `sessionId` — the session id or `null` on `drop`; with decision routing (`events.decisionRouting`) `decision` carries `confidence` and diagnostic `signals`, e.g. `agent:<id>`/`model:<p/m>`/`latency:<ms>ms`); an invalid/revoked/expired key → 401 `UNAUTHORIZED`; an invalid body → 400 `VALIDATION_ERROR`, a materialization failure → 500 `INTERNAL_ERROR` (the decision is still written to the journal). Event attachments (`attachments[]`) — see below. The rate limit (managed — 120/min) applies to both paths before the authentication method is chosen; the per-key limit (the key's limit or the global `events.keyRateLimitPerMinute`) → 429 `RATE_LIMITED`; the master switch `events.enabled: false` → 503 `UNAVAILABLE`. Key usage is written to the journal (`keyId`/`principalId`) |
| GET | `/api/v2/events/bindings` | both | auth | List of bindings `{bindings}` |
| POST | `/api/v2/events/bindings` | both | LEAD/ADMIN | Upsert a binding by `source`+`chatKey`/`threadKey` (`eventBindingInputSchema`): `{source, chatKey?, threadKey?, sessionId?, mode: bound\|ephemeral\|queue, agentTemplate?, project?}`; a record matching by key is replaced (the id is preserved) → 200, otherwise 201 |
| DELETE | `/api/v2/events/bindings/:id` | both | LEAD/ADMIN | Delete a binding → 204 (its API keys are deleted cascadingly); no record → 404 `NOT_FOUND` |
| GET | `/api/v2/events/bindings/:id/keys` | both | LEAD/ADMIN | List of the binding's API keys `{keys}` — metadata only (`EventBindingApiKey[]`, without the secret and the hash; `label`, `description?`, `expiresAt?`, `rateLimitPerMinute?`, `revokedAt?`, `prefix`, `lastUsedAt`) |
| POST | `/api/v2/events/bindings/:id/keys` | both | LEAD/ADMIN | Create an API key (`eventBindingApiKeyCreateSchema`): `{label, description?, expiresAt?, rateLimitPerMinute?}` (`label` is required, globally unique per instance, case-insensitive) → 201 `EventBindingApiKeyCreated` = metadata + `key` (plaintext `synth_evt_<base64url>`, shown **only once**); no binding → 404 `NOT_FOUND`; duplicate label → 409 `CONFLICT`; invalid body → 400 `VALIDATION_ERROR` |
| PATCH | `/api/v2/events/bindings/:id/keys/:keyId` | both | LEAD/ADMIN | Update the key metadata (`eventBindingApiKeyUpdateSchema`): `{label?, description?, expiresAt?, rateLimitPerMinute?}`; `null` — reset the field, `undefined` — leave it untouched; a label change is checked for uniqueness → 200 `EventBindingApiKey`; no key → 404 `NOT_FOUND`; duplicate label → 409 `CONFLICT` |
| POST | `/api/v2/events/bindings/:id/keys/:keyId/revoke` | both | LEAD/ADMIN | Soft revocation of the key (sets `revokedAt`; idempotent) → 200 `EventBindingApiKey`; no key → 404 `NOT_FOUND`. A revoked key stops resolving (`resolveBySecret` → `null`) |
| DELETE | `/api/v2/events/bindings/:id/keys/:keyId` | both | LEAD/ADMIN | Delete an API key → 204; no record → 404 `NOT_FOUND` |
| GET | `/api/v2/events/routes` | both | auth | List of routing rules `{rules}` (`EventRouteRule[]`) |
| POST | `/api/v2/events/routes` | both | LEAD/ADMIN | Upsert a rule (`eventRouteRuleUpsertSchema`): `{id?, name?, priority?, enabled?, match, target}`; `match` — AND over the filled `source`/`type`/`chatKey`/`threadKey`/`principalId`/`label`/`keywords` (an empty-invalid one does not match); `target` — `bound`/`queue` (`sessionId`), `ephemeral` (`agentTemplate?`/`project?`/`ttl?`) or `bind` (ADR-089 auto-bind: `agentTemplate?`/`project?` — pin the chat/thread to a new session); in `ephemeral`/`bind` the optional field `pipeline?: {id, step}` is allowed — a **reference to a pipeline step: this session is step `step` of pipeline `id`** (in `bound`/`queue` the field is rejected — 400 `VALIDATION_ERROR`). By `id` — an update → 200, otherwise a creation → 201. Validation: `bound`/`queue` with a non-existent session → 400, a non-empty `agentTemplate` without an enabled agent → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/events/routes/:id` | both | LEAD/ADMIN | Delete a rule → 204; no record → 404 `NOT_FOUND` |
| GET | `/api/v2/events/journal` | both | auth | The latest journal entries of decisions `{entries}`; `?limit=` (default 50, cap 500) |

`identity` — `{principalId?, chatKey?, threadKey?, roles?}`. `dedupKey`/`ts` are optional:
`EventIngress` normalizes the event (id `evt_<uuid>`, the default dedup key by
source/type/key/payload). RBAC managed: ingestion — a binding key or `requireAuth` +
rate limit (120/min); mutations of bindings/rules/keys — `requirePermission('ADMIN','LEAD')`,
reading binding keys — LEAD/ADMIN, all other reads — `requireAuth`; in core — the single `requireAuth`.
**Service key scopes (ADR-052):** `POST /` — `events:ingest`; `GET /` (SSE) and `GET /journal` —
`events:watch`; the list/mutations of bindings — `bindings:read`/`bindings:write`; binding keys —
`keys:read`/`keys:write`; rules — `routes:read`/`routes:write`. Writing routing rules
(`POST`/`DELETE /routes`) is available to a service key with `routes:write`
**or** `automation:install` (the umbrella scope of the extension-package installer —
**any one** of the two is enough; in managed the scope gate acts **on top of** the
role gate — the key additionally needs the `LEAD`/`ADMIN` role). If the key has
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
**Pipeline step reference (`pipeline`).** The rule target (`ephemeral`/`bind`) accepts the
optional field `pipeline?: { id, step }` — a "reference to a pipeline step: this session
is step `step` of pipeline `id`". The reference is **semantic**, not diagnostic: it
underpins the accounting of pipeline instances and the gates (e.g. a rule on the
`draft_approved` event — the gate "after approve"). It is passed through into the
Router's decision (`decision.pipeline`) and into the decision journal. In the
`bound`/`queue` targets the session is fixed, so the field is **rejected** there
(400 `VALIDATION_ERROR`) rather than ignored.
**Event attachments (`attachments[]`).** An additive body field (`eventIngestSchema`, ADR-115 × ADR-089):
the event carries **references** to blob-store objects; the bytes never travel through it. The sender
first uploads the file (staging `POST /api/v2/attachments` or an upload into a session — §5.6.1, RU only for now) and then
passes the object path together with its metadata. The metadata is duplicated deliberately: the receiver
compares it with the object's sidecar, so substituting a reference to a foreign or modified object is
rejected on ingestion.

```json
{
  "source": "telegram",
  "type": "message",
  "dedupKey": "tg:chat:-1001234567890:msg:4711",
  "payload": { "text": "what is on the photo?" },
  "identity": { "principalId": "tg:777", "chatKey": "chat:telegram:-1001234567890" },
  "attachments": [
    {
      "blobPath": "attachments/4f/4f0c9b1d2e3a5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4",
      "sha256": "4f0c9b1d2e3a5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4",
      "mime": "image/png",
      "size": 184320,
      "name": "photo.png"
    }
  ]
}
```

| Reference field | Requirement |
|---|---|
| `blobPath` | the attachment contour only: `attachments/<sha2>/<sha256>`, ≤ 512 characters, no `..` segments; an object of another contour (`packs/`, `processes/`, logs, skill content) cannot be referenced |
| `sha256` | exactly 64 hex characters — the object address (content-addressed) |
| `mime` | a non-empty MIME by content (≤ 255) that **matches** the object's sidecar |
| `size` | a positive integer, bytes; **matches** the sidecar |
| `name` | optional, 1–200 characters; not part of `blobPath` (sanitized as on upload) |

**Required `dedupKey`.** A non-empty `attachments[]` requires an **explicit** `dedupKey` (otherwise
`400 VALIDATION_ERROR`; both the request schema and the ingress check it). The reason: the default
idempotency key is built from `source`/`type`/`chatKey|threadKey`/`payload` (JSON) and is unstable for
attachments — the same message delivered twice with a different representation of its attachments would
get different keys and be processed twice; a dedup key must not depend on the attachments' content.
An empty array is equivalent to the field being absent (no key required).

**Checks and limits.** Attachments are validated **before** the Router, dedup and the journal: a rejected
event does not "claim" the dedup key and does not reach the decision journal. Every rejection is
`400 VALIDATION_ERROR`, with the reason in `error.message` including the element index.

| What is checked | Limit source / rule | Violation |
|---|---|---|
| `dedupKey` with non-empty attachments | request schema + ingress | `400 VALIDATION_ERROR` |
| number of references | `attachments.maxFilesPerMessage` (default 10); the request schema allows at most 10 elements — the smaller limit applies | `400 VALIDATION_ERROR` |
| `blobPath` inside `attachments/`, no `..` | the attachment contour (ADR-115) | `400 VALIDATION_ERROR` |
| the object exists | `AttachmentService.resolve` | `400 VALIDATION_ERROR` |
| `sha256`/`mime`/`size` match the sidecar | same | `400 VALIDATION_ERROR` |
| file size | `attachments.maxBytesPerFile` | `400 VALIDATION_ERROR` |
| the attachment contour is wired in the build | fail-closed: without an attachment service an event with attachments is rejected — otherwise a reference to a nonexistent or foreign object could be injected | `400 VALIDATION_ERROR` |

**Delivery.** The message is assembled by `eventToMessage`: the first part is the text, then one media
part per reference in `attachments[]` order; the part type is derived from `mime` (`image/*` → `image`,
`audio/*` → `audio`, `video/*` → `video`, otherwise `file`). The bytes are not copied into the message —
the parts reference the same blob-store object. In the derived `content` every media part contributes a
placeholder (`[image: photo.png]`, `[image]` without a name, `[file: …]` and so on for other types),
appended on a new line when it is not already present in the text — so the fact of an attachment is not
lost in exports, search and the `messages.content` mapping; `metadata`
gets `attachments_count` (for audit and the UI). Duplicates in `attachments[]` are not collapsed — each
element becomes a separate part (the bytes themselves are deduplicated by the blob contour: the address
is content-addressed).

**`blob_refs` and GC.** After the message is successfully queued, `blob_refs` are registered
(`ownerKind: 'message'`, `ownerId` — the message id). The step is essential: an object without references
is deleted by the background pruner according to `attachments.gcDays` (30 days by default) even though a
message references it. The bookkeeping is best-effort: a failed reference write does not cancel delivery
(it is logged). A staging object that never reaches a message lives until `gcDays` and is then removed by
the general GC criterion (no references **and** older than the period).

**Recommended order for gateways.** 1) `POST /api/v2/attachments` (§5.6.1, RU) — take
`blobPath`/`sha256`/`mime`/`size` from the response; 2) `POST /api/v2/events` with `attachments[]` and an
explicit `dedupKey`. The reverse order (an event referencing an object that is not uploaded yet) yields
`400 VALIDATION_ERROR`, so "upload → send the event" is the only reliable path; one object can be reused
across several events.

**What attachments do not change.** Permissions and identity: the same rules as for an event without
attachments (the base is the sender profile's roles, `identity.roles` only narrow them, an unidentified
sender gets no rights) — attachments grant no extra rights and do not affect routing. Media is neither
anonymized nor cleaned on ingestion: the bytes are stored as they are, and metadata stripping
(EXIF/IPTC/XMP) happens only at the provider-send boundary (ADR-115). The file type is not "guessed" from
the client's claim: `mime` must match the sidecar, while allowed types are constrained by the upload
(`attachments.allowedMimePrefixes`, SVG is forbidden).

The processing chain and the journal — `docs/ARCHITECTURE.md` ("External events and hooks"), ADR-089.

> `POST /api/v2/sessions` now goes through the single funnel `RequestSessionService`
> (`engine/events/request-session.ts`, ADR-089): it emits `session_requested` + creates
> the session. The external contract of the endpoint has not changed.

### 5.27 Schedules — `/api/v2/schedules` (both, ADR-051 slice / ADR-089)

CRUD of scheduler schedules (the single factory `createSchedulerRoutes` for core and
backend). A firing does not create a session on its own:
the service publishes a normalized event `source: 'cron'`,
`type: 'schedule_fired'` through `EventIngress`, and routing is performed by
`SchedulerRuleProvider` (`RouteRuleProvider`). The exception is `mode:'pipeline'`:
the scheduler starts a pipeline run **directly** (no event is published to the Router and
no session is created), see below. RBAC managed (backend): reads
(`GET`) — `requireAuth`; mutations (`POST`/`PUT`/`DELETE`) and a forced run
(`POST /:id/run`) — ADMIN only (`writeGuard = requireAdmin`); `run` is additionally
under a rate limit of 10/60 s (`runMiddleware`). In core (standalone) — the single `requireAuth`
for all methods. **Service key scopes (ADR-052):** `schedules:read` (reads and `GET /:id/jobs`),
`schedules:write` (`POST`/`PUT`/`DELETE`/`POST /:id/run`); writing schedules is available to a
service key with `schedules:write` **or** `automation:install` (the umbrella scope of the
extension-package installer — **any one** of the two is enough: a schedule generated by a
package is written by its installer; in managed the scope gate acts **on top of** the role
gate — the key additionally needs the `ADMIN` role); the project projection — by the schedule
target (`bound`/`queue` → the session's project, `ephemeral` → `project`,
`pipeline` → `projectId`).

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
`decision`/`reason` (routing: `drop no_route`, `busy`, `missed`; for the `pipeline`
target — `decision:'pipeline'`, `reason:'pipeline_unavailable'` when no run runner is
registered), `sessionId`, `pipelineId`/`runId`, `error`.

`target` — a discriminated union: `{mode:'bound', sessionId}` |
`{mode:'ephemeral', agentTemplate?, project?, ttl?}` | `{mode:'queue', sessionId}` |
`{mode:'pipeline', projectId, pipelineId, version?, payload?}`. For `pipeline`:
`payload` is a static run input (`trigger.payload.*`), `version` defaults to the latest
published one; the run goes in the background, `runId` is recorded in the job history.
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
`step.finished` (the former `stream.done`, ADR-118) or a prefix `session.*`; empty — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), `enabled`,
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
  -d '{"label":"ci-listener","url":"https://ci.example.com/synth","events":["session.*","step.finished"]}'

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
- **Namespaces:** `events` (ingest/journal/bindings/keys/routes), `sessions` (CRUD + prompt/messages/status
  + **ToDo**: `sessionTodos`/`createSessionTodo`/`updateSessionTodo`/`deleteSessionTodo`/`reorderSessionTodos`/`clearSessionTodos`),
  `schedules` (CRUD + run/jobs), `projects` (list/get + **plan**: `projectPlan`/`createPlanItem`/`updatePlanItem`/
  `movePlanItem`/`deletePlanItem`/`createPlanColumn`/`updatePlanColumn`/`deletePlanColumn`/`reorderPlanColumns`;
  **journal**: `projectLog`/`createProjectLogEntry`/`updateProjectLogEntry`/`deleteProjectLogEntry`;
  **invariants**: `projectInvariants`/`putProjectInvariants`), `pipelines`, `models`, `fs`, `git`, `llm`
  (`chatCompletions`).
- **PROP-054 in the SDK.** The project journal is **moved out of the detail**: `projects.get()` returns a DTO
  **without** the `log` field (the plan stays in the detail), the journal entries are read page by page —
  `projects.projectLog(id, {limit, offset})` → `ProjectLogPage` (`{entries, total, offset, limit, next_offset}`;
  `limit` default 50, maximum 200). The journal and the invariants are serialized in **snake_case**
  (`created_at`/`session_id`/`updated_at`/`updated_by`), while the plan arrives in the **domain form**
  (camelCase: `updatedAt`/`columnId`) — different forms, not a typo. A plan version conflict —
  `409 PLAN_VERSION_CONFLICT`; the current plan is in the error body (`SynthApiError.body.plan`), there is
  no separate DTO for the error.
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

### 5.34 Pipelines — `/api/v2/pipelines` (both, ADR-100/ADR-051)

> ⚠️ **ADR-100, getting outdated.** The new pipeline endpoints (the specifications, the versions, the
> runs, the run log, the instance templates) — **§5.35**. The old endpoints of this section **stay
> working** (the UI has already moved to the new contour — ADR-101 §5.35); their removal is not planned.

A pipeline in this section is a **declaration + the accounting of a run** (there is no own step engine
in these endpoints). The target model is "a pipeline as the second engine"
([ADR-101](../arch_decisions/adr-101-pipeline-engine.md) (in Russian), **implemented**; the format —
[docs/PIPELINES.md](../PIPELINES.md) (in Russian)): the contract and the routes of this section have
been extended (the specifications, the versions, the run log, the project binding) — **§5.35**; the
contract of this legacy section stays in force.
A single factory `createPipelinesRoutes`; the storage — the `PipelineRepository` port
(`{dataDir}/pipelines/definitions.json` and `{dataDir}/pipelines/instances.json`).
**This route does not create the definitions** — the extension-package installer does
(`POST /api/v2/packs`); the integrity check of the `synth.pack` manifest cannot be bypassed.

| Method | Path | Build | RBAC (managed) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/pipelines` | both | ADMIN / auth | The instance pipeline definitions `{pipelines}` (the steps, `onError`, `maxAttempts`, `ttl`, the provenance `installedBy`) |
| GET | `/api/v2/pipelines/instances` | both | ADMIN / auth | A page of the run instances `{instances, offset, limit, next_offset}`; the filters `pipelineId`, `status` (`pending`\|`running`\|`waiting`\|`done`\|`failed`\|`cancelled`), `limit` (default 100, maximum 1000), `offset` (default 0); an unknown `status` → 400 `VALIDATION_ERROR`. `total` is not returned: the port returns a limited selection (the cap is 1000) — `next_offset` serves as the cursor |
| GET | `/api/v2/pipelines/instances/:instanceId` | both | ADMIN / auth | One instance (the step states, `currentStep`, `attempts`, `trigger`) |
| GET | `/api/v2/pipelines/:id` | both | ADMIN / auth | One definition; none → 404 `NOT_FOUND` |
| POST | `/api/v2/pipelines/:id/instances` | both | ADMIN **or** the scope `automation:install` | A **manual** start of an instance (a check/debugging; the main start is by an event): the body `{trigger?, payload?}` → 201; no definition → 404 |

**The automaton semantics.** The first step with `waitsFor` is a **trigger**: a matching event creates
an instance; the subsequent steps with `waitsFor` are **gates**: the event means "the previous step is
completed and confirmed by a human" — the automaton advances in the existing instance. **The artifact
between the steps = the event payload** (for example `{draftId}`) — it is stored in the step artifact
and in `trigger.payload`; the next step takes it from there. The accounting is kept by the funnel
(ADR-089): the Router's decision carries `pipeline: {id, step}`, the tracker creates/advances the instance.

**UI.** The "Add-ons" section (Settings → "Administration", the `addons` category, the ADMIN role):
the package registry (the approval and the removal) and "Pipelines" — the definitions and the runs with
the filters.

### 5.35 Project pipelines, runs and templates — `/api/v2/projects/:id/pipelines*`, `/api/v2/pipeline-runs*`, `/api/v2/pipeline-templates*` (both, ADR-101 Phase 6)

The model "a pipeline as the second engine"
([ADR-101](../arch_decisions/adr-101-pipeline-engine.md) (in Russian), the format and the device —
[docs/PIPELINES.md](../PIPELINES.md) (in Russian)): a **project pipeline** (`scope:'project'`) with a
draft specification and immutable published versions, a **run** (a self-contained record with a
snapshot of the specification + the execution log) and an **instance template** (the source for the
instantiation). A single factory `createPipelineProjectRoutes` for core and backend; the storage —
the `ProjectPipelineRepository` and `PipelineRunRepository` ports (ADR-096), the source of the templates —
the legacy registry `PipelineRepository` (ADR-100) **plus** the `scope:'instance'` records of the new port.

The paths **do not overlap** with the legacy contour of §5.34 (`/api/v2/pipelines*`): there — a
"declaration + accounting" (ADR-100), here — the engine with the specifications, the versions and the log
(ADR-101). The old endpoints stay working (the legacy contour, ADR-100), **the UI has already moved to
the new contour** — the new endpoints are the main pipeline contour.

**The rights (ADR-089 §5.5/§5.8, invariant 21).**

| Action | Right |
|---|---|
| Reading the pipelines and the runs | the **read** right on the project: the owner, a member of the project (any role, including `VIEWER`), `LEAD`, `ADMIN` |
| Changing (creating, editing, publishing, deleting, starting, HITL) | the right to **change the content** of the project: `OWNER`, `EDITOR`, `LEAD`, `ADMIN`; `VIEWER` reads but does not mutate |
| The instance templates (the list) and the instantiation | **ADMIN** (managed); core — `requireAuth` (single-user). The instantiation additionally requires the right to change the content of the target project |
| A service key (ADR-052) | the mutations — the scope `automation:install` (or the `ADMIN` role of the key) **and** the project projection `allowedProjects` (otherwise `403 PROJECT_FORBIDDEN`); without the scope — `403 SCOPE_REQUIRED`. Reading has no scope gate — only the project rights |

The access check is **at the boundary** (a guard), not in the handler (invariant 16): the guard resolves
the project or the run once and puts the entity into the context; there are no access checks in the
handlers. No project → `404`; no rights → `403`; a pipeline of a foreign project under a foreign id →
`404` (there is no such resource in this project).

| Method | Path | Build | RBAC (managed) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/projects/:id/pipelines` | both | the project read right | A **page** of the project pipelines `{pipelines, total, offset, limit, next_offset}`: id, name, `scope`, `projectId`, `draftVersion`, `publishedVersion?`, `installedBy?`, `hasDraft`; `?limit=` (default 100, maximum 500), `?offset=` (default 0). ⚠️ **Breaking change:** the `draft` is **not** returned in the list (it is in the detail `/:pid`) |
| POST | `/api/v2/projects/:id/pipelines` | both | the project change right (+ `automation:install` for a service key) | Create a pipeline: the body `{name?, description?, spec}` — the `PipelineSpec` specification; the server sets `id`/`version`/`status`/`projectId` → **201** `{pipeline}`; an invalid specification → 400 `VALIDATION_ERROR` with the list of `problems` |
| GET | `/api/v2/projects/:id/pipelines/:pid` | both | the project read right | `{pipeline, published, versions}` — the draft, the published version and the list of the versions |
| PUT | `/api/v2/projects/:id/pipelines/:pid` | both | the project change right | Save the draft: the body `{name?, description?, spec}` → 200 `{pipeline}`; the version is **not** changed (the publication is a separate step) |
| DELETE | `/api/v2/projects/:id/pipelines/:pid` | both | the project change right | Delete the pipeline and its versions → **204**; the runs **stay** (a run is self-contained) |
| POST | `/api/v2/projects/:id/pipelines/:pid/publish` | both | the project change right | Publish the draft: the immutable version `publishedVersion`, the draft moves to the next version → 200 `{pipeline, published}`; a repeated publication without changes is idempotent (it does not multiply the versions); no draft → 409 `CONFLICT` |
| GET | `/api/v2/projects/:id/pipelines/:pid/runs` | both | the project read right | A page of the pipeline runs `{runs, offset, limit, next_offset}`; the filters `status` (`pending`/`running`/`awaiting_human`/`done`/`failed`/`cancelled`), `limit` (default 100, maximum 1000), `offset` (default 0); an unknown `status` → 400 `VALIDATION_ERROR`. `total` is not returned: the port returns a limited selection (the cap is 1000) — `next_offset` serves as the cursor |
| POST | `/api/v2/projects/:id/pipelines/:pid/runs` | both | the project change right | Start a run: the body `{trigger?, version?, attachments?}` (by default — the last published version, the trigger `manual`) → **201** `{run}`; the run goes **in the background** — the client watches the `pipeline.run.*` events; no published version → 409 `pipeline.not_published`; the `attachments[]` did not pass the check → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/pipeline-runs/:runId` | both | the read right of the run's project | The run and a **page of the log**: `{run, events, events_has_more, events_next_before}` (the events: `run.started`/`node.started`/`node.finished`/`edge.taken`/`gate.awaiting`/`run.finished`/`run.failed`); `events_limit` — the page size (default 200, maximum 500), `events_before` — an **exclusive cursor**: canonically — the ordinal number of the event in the run log (a number, numbered from zero, in the order of adding — the log is append-only, and the `ts` marks are not unique); for compatibility the time mark `ts` (ISO-8601) is accepted too — then the events strictly older by time are selected. Without the parameters — the last (newest) page. `events_has_more` — whether there are events older than the first event of the page; `events_next_before` — the cursor of the next (older) page (`null` if there is none). An invalid `events_limit`/`events_before` → 400 `VALIDATION_ERROR`. ⚠️ **Breaking change:** the `limit` parameter is replaced by `events_limit`, and the response gains `events_has_more`/`events_next_before` |
| GET | `/api/v2/pipeline-runs/:runId/artifacts/:name` | both | the read right of the run's project | The bytes of the run artifact object (`kind: 'blob'`): `Content-Type`, `Content-Disposition: attachment`, `Content-Length`, `ETag`, `Cache-Control: private, max-age=86400`; `If-None-Match` → `304`; no artifact or the blob contour is not wired → `404 NOT_FOUND` |
| POST | `/api/v2/pipeline-runs/:runId/resume` | both | the change right of the run's project | The human's HITL decision: the body `{approved, output?, comment?}` → 200 `{run}`; the run does not wait for a decision → 409 `pipeline.invalid_state` |
| POST | `/api/v2/pipeline-runs/:runId/cancel` | both | the change right of the run's project | Cancel the run → 200 `{run}` (the status `cancelled`); the run is already finished → 409 `CONFLICT` |
| GET | `/api/v2/pipeline-templates` | both | **ADMIN** / auth | The instance templates `{templates}`: `format` (`adr-100` — the legacy package definition, `adr-101` — a `scope:'instance'` record), `name`, `version`, `installedBy?`, `steps` (legacy) or `spec` |
| POST | `/api/v2/pipeline-templates/:tid/instantiate` | both | **ADMIN** / auth + the change right of the target project | Instantiate the template into a project: the body `{projectId, name?, ensure?}` → **201** `{pipeline, created:true}` (a draft, `draftVersion: 1`, `installedBy.templateId` — the id of the template). `ensure:true` — idempotent: if the project already has a pipeline of this template, **200** `{pipeline, created:false}`. The template is not convertible → 409 `PIPELINE_TEMPLATE_UNSUPPORTED`; no template/project → 404. The built-in memory templates: `builtin:memory-consolidation` (a session → the facts), `builtin:memory-consolidate-facts` (the duplicates of the facts), `builtin:memory-reindex` (all the project indexes) |

**The run artifacts (ADR-101 §9 + ADR-116).** The `file` output writes a file into the project
workspace **and the same bytes** — into the shared blob port under the path `artifacts/<runId>/<name>`
(there is no separate artifact storage, the limit is 50 MiB per file; exceeding it — a warning in the
log, the file stays only in the workspace). An artifact is described by a `PipelineArtifact` with
`kind: 'blob'` and the fields `path`/`name`/`mime`/`size`; the list of the run artifacts is **at the top
level** of the `run.finished` payload (`run.finished.payload.artifacts[]`, the source of the MIME/name for
the serving) and in the `pipeline.run.finished.artifacts[]` event (an additive field). There is no
separate metadata index — the run log is the source of truth. The `ETag` of the serving — the hash of
the **path** (the path is unique within a run and immutable). There is **no** automatic retention of the
artifacts: neither a TTL nor the deletion of the runs through the API, the bytes live in the blob storage
until a manual cleanup (a known limitation, see [PIPELINES.md](../PIPELINES.md) §2.10.2).

**The run attachments (ADR-115 × ADR-101).** The run body accepts `attachments[]` — references to the
staging-upload objects (`POST /api/v2/attachments`), the same shape as an external event attachment
(ADR-089): `{blobPath, sha256, mime, size, name?}`, `blobPath` — only inside `attachments/` (the
structural cap of the array — 50). The references are checked **before** the run start by the same rules
as the event ingestion: the object exists, `sha256`/`mime`/`size` match the sidecar, the limits
`attachments.maxFilesPerMessage` / `maxBytesPerFile` / `maxBytesPerSession`. Any mismatch →
**400 `VALIDATION_ERROR`** (`problems`: "not found", "does not match the object", "exceeds the limit");
without the attachment service or the `blob_refs` port the runs with attachments are rejected
(fail-closed). The accepted references are put under `trigger.payload.attachments` (available to the steps
without a mapping) and are registered in `blob_refs` with the owner `pipeline-run` (otherwise the GC would
delete the object the run refers to). The delivery into a step — the common session path (the metadata
cleanup, the modality filter, the `derive` for a text-only model, the base64 limit); the device —
[PIPELINES.md](../PIPELINES.md) §2.10.3.

**The error codes of the section:** `UNAUTHORIZED` (401), `FORBIDDEN` (403 — the project rights),
`SCOPE_REQUIRED` (403 — a service key without `automation:install`), `PROJECT_FORBIDDEN` (403 — a service
key outside `allowedProjects`), `NOT_FOUND` (404), `VALIDATION_ERROR` (400, with the list of `problems`),
`CONFLICT` (409 — nothing to publish / the run is finished), `pipeline.not_published` (409),
`pipeline.invalid_state` (409), `PIPELINE_TEMPLATE_UNSUPPORTED` (409).

**A run error.** `run.error` — the error text; the **machine-readable code** of the reason — in the run
log (`run.failed.payload.code`: `pipeline.gate_rejected`, `pipeline.gate_timeout`,
`pipeline.step_failed`, `pipeline.step_timeout`, `pipeline.cancelled`, `pipeline.loop_limit`,
`permission.denied`).

**The conversion of the legacy definitions (ADR-100 → an ADR-101 template).** A package definition
(`provides.pipelines[]`, the legacy registry `{dataDir}/pipelines/definitions.json`) — the source of the
templates; there is no data migration: the conversion is performed **on the fly at the instantiation**
(`legacyDefinitionToPipelineSpec`):

- the `agent` step → the `agent` node: `id`, `agent`, `title?`, `skill?`, `prompt?`, `timeoutSec?` are
  carried over as is;
- the `loop` step is **not converted** (the Loop Engine is out of scope, PROP-057) — a template with such
  steps is not instantiated: `409 PIPELINE_TEMPLATE_UNSUPPORTED` with the list of the problems;
- a step without the `agent` field is not converted (the `agent` node requires an agent) — the same 409;
- `waitsFor` is **not carried over**: in ADR-101 the trigger is set at the run start, and the HITL gate is
  expressed by the `human` node — the pipeline owner adds it in the draft;
- the pipeline exit at the instantiation — `none` (the exits are set by hand).

**The storage.** The drafts and the versions — the `ProjectPipelineRepository` port
(`{dataDir}/pipelines/{pipelines,versions}.json`), the runs and the log — the `PipelineRunRepository`
(`{dataDir}/pipelines/{runs.json,run-events.jsonl}`); with `storage.backend=postgres` — the
`@itphx/synth-storage-postgres` driver (ADR-097). The run artifacts (`kind: 'blob'`) — the bytes in the
shared blob port (`{dataDir}/blobs/artifacts/<runId>/<name>`, the reference accounting — `blob_refs`),
the metadata — in the run log (ADR-116).

**UI.** The pipelines/runs screen and the visual editor are **implemented** (ADR-101 §5.35): the
"Pipelines" tab, the pipeline and run pages, the HITL actions, the `@xyflow/react` editor.

---

### 5.36 Plugins — `/api/v2/plugins*` and `/api/v2/settings/plugins` (both, ADR-090)

The plugin layer (ADR-090, Extension API v1): installation of a `synth.pack` bundle
(`kind: 'plugin'`), the trust/scan/install-policy model (PROP-068), activation through
`PluginHost` and the extension points (`promptBlocks`, `llmFilters`, `tools`). A single factory
`createPluginsRoutes` for core and backend; `plugins.lock.json` is the source of truth (what is
installed), `installed/<name>@<version>/` is the bundle, `quarantine/` holds the ones awaiting
approval, the journal is `{dataDir}/audit/plugins.jsonl`.

**Code execution is disabled by default** (`plugins.executionEnabled: false`): installation and
removal work, activation stops at the `import` step (`plugin.execution_disabled`). Enabling it —
via `PUT /api/v2/settings/plugins` + an **instance restart**.

| Method | Path | Build | RBAC (backend / core) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/plugins` | both | ADMIN / auth | `{plugins: PluginRuntimeEntry[]}` — the installed lock records plus `active`/`mode`; the quarantine is not part of the list |
| GET | `/api/v2/plugins/audit` | both | ADMIN / auth | `{entries: PluginAuditEntry[]}` — the **journal of plugin actions** (ADR-090), the tail: `limit` (50 by default, 500 at most) and an optional filter by the plugin name (`plugin`). The entries are "freshest first" (newest → oldest); an entry carries the time (`ts`), the plugin, the action (`action`), the outcome (`outcome`: `ok`/`rejected`), the reason code (`reason`) and the remaining entry fields. Reading **does not** create journal entries |
| GET | `/api/v2/plugins/:name` | both | ADMIN / auth | `{plugin, manifest?, integrity?}`: the manifest from the installed bundle and `PLUGIN_INTEGRITY.json` (best-effort — a corrupted file does not produce a 500); not in the lock → 404 `plugin.not_found` |
| POST | `/api/v2/plugins/install` | both | ADMIN or service-key `addons:install` / auth | **Installation from a source** (see "Installation sources" below): `201` — installed, `202` — approval required (`plugin.approval_required`, the bundle is in quarantine), `400` `VALIDATION_ERROR` (body/pin/name) or `plugin.source_unavailable` for a local source, `400` `plugin.manifest_invalid`, `403` `plugin.trust_below_floor`/`plugin.runtime_install_denied`/`plugin.scan_disabled_with_execution`, `409` `plugin.scan_rejected`, `502` `plugin.source_unavailable` for a network source (the registry/URL did not answer). **Managed**: local sources (`dir`/`archive`) are forbidden → `403 LOCAL_INSTALL_DISABLED`; network sources (`npm`/`url`) are allowed |
| POST | `/api/v2/plugins/:name/approve` | both | **ADMIN** / auth | Approve the quarantine (the `202` installation): the approval is checked (the content hash + the 24-hour window, ADR-090 §9) → the gates are re-run + the integrity is re-checked → `200` installed; `404` `plugin.not_found`, `409` `plugin.scan_rejected`, `409` `plugin.approval_expired` (the approval has expired — 24 h from the moment of issuance), `409` `plugin.approval_stale` (the bundle in the quarantine changed after the approval was issued) |
| POST | `/api/v2/plugins/:name/enable` | both | ADMIN or `addons:install` / auth | Activation (the ADR-090 pipeline) → `200 {activation}`; a gate refusal (`plugin.execution_disabled`/`trust_below_floor`/`scan_rejected`/`approval_required`) → `409` with `reason`; not in the lock → `404`. With the scan verdict `caution` a **valid approval** is required (the content hash, the 24-hour window — ADR-090 §9): it exists and the hash matches → the activation goes through, otherwise `409 plugin.approval_required` |
| POST | `/api/v2/plugins/:name/disable` | both | ADMIN or `addons:install` / auth | The reverse rollback of the disposers → `200 {deactivation}`; not active → `404 plugin.not_active` |
| DELETE | `/api/v2/plugins/:name` | both | **ADMIN** / auth | Removal: deactivation → `lock.delete` → deletion of the version directory; **idempotent** → `204` even if there was no record |
| POST | `/api/v2/plugins/:name/rollback` | both | ADMIN or `addons:install` / auth | Rollback to the `previous` step: `200 {outcome:'rolled_back', version, previousVersion, activated?}`; no step/directory → `409 plugin.rollback_unavailable`, no record → `404 plugin.not_found` |
| POST | `/api/v2/plugins/token` | both | **ADMIN** / auth | **Issuing a server-scoped token to a plugin** (ADR-090 F7, Level 2): the body `{pluginId, scopes?, expiresInSec?}` → `201 {token, pluginId, scopes, expiresAt}`; the secret is returned **once** (at-rest — sha256, the format `synth_svc_…`), the scope `plugins:invoke` is always added. Errors: `400 VALIDATION_ERROR` (no `pluginId`/an unknown scope/an invalid `expiresInSec`), `403 PLUGIN_NOT_ALLOWED` (the plugin is outside the server allowlist when `plugins.hybrid.mode=allowlist`), `404 plugin.not_found` (the plugin is unknown to the server: neither installed nor allowed by the allowlist), `501 NOT_IMPLEMENTED` (the service-key registry is not wired) |
| POST | `/api/v2/plugins/update` | both | ADMIN or `addons:install` / auth | **Update from the source of the lock record**: `200 {outcome:'unchanged'|'updated', ...}`; `400 VALIDATION_ERROR` (no `name`/an invalid `sha256`) or `plugin.source_unavailable` for a local source, `404 plugin.not_found`, `409 plugin.approval_required`/`scan_rejected`/`integrity_*`, `502 plugin.source_unavailable` for a network source. The body `{name, version?, sha256?, activate?}`; the source is not chosen by the client |

**The installation approval (`POST /plugins/:name/approve`, ADR-090 §9).** The scan verdict `caution` →
the bundle goes to `quarantine/<name>@<version>/` (the answer `202`, `plugin.approval_required`) and
an **approval** is issued along with it: bound to the **content hash** of the bundle, with **who**
and **when** it was issued, **the window is 24 h** (`PLUGIN_APPROVAL_TTL_MS`). The state is
persistent: `plugin-approvals.json` in the root of the plugin layer layout (`<home>/plugin/` or
`{dataDir}/plugin/`) — next to `plugins.lock.json`, but **outside** the bundle directory (replacing
the bundle in the quarantine does not erase the approval).

On `approve` the approval is checked **first**:

| Condition | Answer |
|---|---|
| there is no approval (the bundle was put into the quarantine by hand) | the checks do not apply — the other gates work as before |
| the 24-hour window has expired | `409` `plugin.approval_expired` |
| the content hash of the bundle does not match the approved one (the bundle was replaced) | `409` `plugin.approval_stale` |
| otherwise | the gates are re-run → `200` installed |

In managed only **`ADMIN`** may approve (that is, perform `approve`) (`approveGuard:
requirePermission('ADMIN')`); the scope `addons:install` opens the installation/activation, but not
the approval. In core (standalone) — a single `requireAuth`. There is no separate revocation API: the
approval stops applying when the hash stops matching (`plugin.approval_stale`) or the window
expires.

**The plugin action journal (`GET /plugins/audit`).** The journal is **append-only**: it is written
by the `PluginAuditRepository` port (`{dataDir}/audit/plugins.jsonl` in the file storage, the
`plugin_audit` table in PostgreSQL). The entries describe the extension lifecycle: `install`,
`activate`, `deactivate`, `rollback`, `uninstall`, `scan`, `filter`, `token`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `limit` | number | 50 | how many **latest** entries to return (500 at most; a non-number or `<= 0` means the default) |
| `plugin` | string | — | filter by the plugin name (empty — all plugins) |

The answer is `{entries: PluginAuditEntry[]}`: the entries are "freshest first" (newest → oldest).
Entry fields: `id`, `ts` (ISO-8601), `actor`, `action`, `plugin`, `version`, `outcome`
(`ok`/`rejected`), `reason?` (the machine-readable refusal code — `plugin.*`/`plugin_filter.*`),
plus, when filled in, `trustLevel`, `scanVerdict`, `scanFindings`, `scanPerformed`, `contentHash`,
`mode`, `source`.

The rights are the same as for reading the plugin registry: **ADMIN** in managed, `requireAuth` in
core. Reading the journal is **not an action on a plugin**: no entry is created while reading. The UI
shows the same journal in "Plugins" → "Plugin journal".

**Installation sources (`POST /plugins/install`).** The body:
`{source?: 'dir'|'archive'|'npm'|'url', path?, name?, version?, url?, sha256?, trustLevel?}`.

| Source | Fields | Integrity | `source`/`identifier`/`ref` in the lock |
|---|---|---|---|
| `dir` | `path` — a directory with `synth.pack` | — | `local` / the absolute path / — |
| `archive` | `path` — a `.tgz`/`.tar.gz` | `ref` = `sha256:<archive hash>` | `local` / the absolute path / `sha256:<hash>` |
| `npm` | `name` (`name`/`@scope/name`), `version?` (default `latest`) | **`dist.integrity` is mandatory** (SRI `sha512`), `shasum` — additionally | `npm` / the name / the exact version |
| `url` | `url` (`https:` only) + a **mandatory** `sha256` (64 hex) | the `sha256` check | `url` / the URL / `sha256:<hash>` |

The source kind is derived from the fields when `source` is not set (`path` with `.tgz`/`.tar.gz` — an
archive, otherwise a directory; `name` — npm; `url` — a URL) — the old body `{path}` works as
before. The `source` label in the lock is derived from the resolution: the client does not set it.
An archive is unpacked into a temporary directory (limits: 500 files / 16 MiB per file / 64 MiB in
total; symlinks, hardlinks, devices, absolute paths, `..` and Windows drives are rejected); only the
installer writes into `installed/`/`quarantine/`. Resolution errors — `plugin.source_unavailable`:
`400` for local sources, `502` for network ones.

**Update and rollback (`POST /update`, `POST /:name/rollback`).** The update source is taken **from
the lock record** (`source`/`identifier`/`ref`), not from the body: `npm` — the `name` from the
lock, the `version` from the body (default `latest`); `local` — the directory or the
`.tgz`/`.tar.gz` from the lock; `url` — the address from the lock + a **mandatory new** `sha256`
(pin). If the `content_hash` matches — `200 {outcome:'unchanged'}` (nothing is written).
Otherwise — a regular installation with the same gates (scan/trust-floor/install-policy), the
trust is taken from the lock, the directory of the previous version is kept, `previous` is written
to the lock (one rollback step). Activation: if it was active — the new version is activated after
the old one is deactivated; `activate: false` — do not activate, not set — keep the state.
`rollback` swaps the current and the previous versions (reversible); the `installed_at` of the
record does not change. Managed: a lock record with `source: 'local'` is rejected on update
(`403 LOCAL_INSTALL_DISABLED`) — otherwise the update would bypass the local installation ban.

**The server-scoped plugin token (Level 2, F7).** A key issued by `POST /api/v2/plugins/token` is
bound to `plugin_id` (the internal service-key model; the public `/api/v2/service-keys` contract is
not extended). The server accepts such a key **only** if three conditions are met (the
**fail-closed** rule, checked at the boundary — after the service credential is resolved, so it
applies to **all** server APIs, not only to the plugin routes):

1. the request carries the `X-Synth-Plugin-Id` header **and** its value matches the `plugin_id` of
   the key — otherwise `403 PLUGIN_ID_MISMATCH`;
2. the key has the scope `plugins:invoke` — otherwise `403 SCOPE_REQUIRED`;
3. the `plugin_id` is in the server allowlist (`plugins.hybrid.allow`) when
   `plugins.hybrid.mode: 'allowlist'` — otherwise `403 PLUGIN_NOT_ALLOWED`.

In the `off` mode the server does not restrict plugins (the allowlist check is not applied), but
the header binding and the scope requirement always apply. A regular service key (without
`plugin_id`) and interactive credentials are not restricted by this check.

**The mapping of failure reasons → HTTP** (the exhaustive `PLUGIN_REASON_HTTP` table in
`packages/core/src/server/routes/plugins.ts`): `400` — `manifest_invalid`, `contract_mismatch`,
`host_mismatch`, `module_invalid`, `provides_mismatch`, `source_unavailable` (a local source);
`403` — `trust_below_floor`, `disabled`, `not_allowlisted`, `denylisted`,
`runtime_install_denied`, `scan_disabled_with_execution`, `managed_readonly`, `hybrid_not_allowed`
(the server-side hybrid policy forbids the plugin to run); `404` — `not_found`, `not_active`;
`409` — `scan_rejected`, `integrity_mismatch`, `integrity_unverifiable`, `execution_disabled`,
`rollback_unavailable`, `approval_expired`, `approval_stale` (an invalid installation approval — a
state conflict, not a policy prohibition: the rights are checked by the route guard); `202` —
`approval_required`; `500` — `loader_unavailable`,
`disposer_failed` (a host failure, not a client one); `502` — `source_unavailable` for a network
source. On activation `execution_disabled`/`trust_below_floor`/`scan_rejected`/`approval_required`
→ `409`, `not_found` → `404`, other refusals → `200 {activation: {outcome: 'rejected', reason}}`.

**Settings — `/api/v2/settings/plugins`.** A runtime override on top of `config.yaml`
(`settings.json` / PG, the settings port): `enabled`, `executionEnabled`, `runtimeInstall`
(`allow|deny`), `trustFloor`, `scan` (`enabled|disabled`), `allowlist`/`denylist`/`remoteAllowlist`,
`exactHostExceptions`, `promptBlockMaxChars` (the block character budget, default 4 000),
`llmFilterTimeoutMs` (the filter budget, default 1 000), `hybrid` (`mode: off|allowlist` +
`allow: string[]` — the server-side plugin policy in hybrid mode, F7).

| Method | Path | RBAC (backend / core) | Purpose |
|---|---|---|---|
| GET | `/api/v2/settings/plugins` | ADMIN / auth | `{plugins (runtime), defaults (config), isOverridden, restartRequired: true, running, hybrid: {mode, allow}}` — the `hybrid` block is the server-side plugin policy in hybrid mode (ADR-090 F7); the `allow` list is returned **only** when `mode: 'allowlist'`, in the `off` mode — `{mode: 'off', allow: []}` |
| PUT | `/api/v2/settings/plugins` | ADMIN / auth | Partial update (`pluginsConfigSchema.partial().strict()`): an unknown key/an invalid value → `400 VALIDATION_ERROR`; the response is the same as for `GET` |
| DELETE | `/api/v2/settings/plugins` | ADMIN / auth | Reset the override to `config.yaml`/the defaults; the response is the same as for `GET` |

**`restartRequired: true`** (invariant 24): the plugin runtime (the host, the loader, the
effective config) is assembled at the instance start, so a change of the **policy** is applied after
a restart (`POST /api/v2/maintenance/restart`). The exception — the **live budgets**:
`promptBlockMaxChars` (from the next turn) and `llmFilterTimeoutMs` (for the subsequent filter
registrations) are applied immediately. The value priority — `SYNTH_*` env > runtime (this
section) > `config.yaml` > the defaults (ADR-023).

**RBAC.** Managed (backend): reads and settings — `ADMIN`; installation/activation/deactivation —
`ADMIN` **or** a service key with the scope `addons:install`; the quarantine approval and the
removal — **only `ADMIN`**. Core (standalone): a single `requireAuth` (the instance owner,
ADR-079). Its own matrix — `packages/backend/src/routes/plugins-rbac-matrix.test.ts` (negative:
`USER`/`LEAD`/`AUDITOR` → 403; positive: `ADMIN`, a service key with and without the scope).

### 5.38 Memory — `/api/v2/memory` (both, ADR-107 / PROP-047 §2.1)

The memory portal in the core: **reads** over the domain memory ports
(`MemoryFactRepository`/`MemoryIndexRepository`, ADR-096) and **index mutations**
(M2). A single factory `createMemoryRoutes` (`packages/core/src/server/routes/memory.ts`)
for core and backend; the backend only adds RBAC through `opts.guard`. The
subsystem itself — see [docs/MEMORY.md](../MEMORY.md).

**The namespace is set by the server.** The memory port serves several independent
providers, so the portal reads only its own namespace — `plugin:synth-plugin-memory`
(the host rule: `plugin:<plugin name>`). The `namespace` query parameter is
**ignored**: a client cannot substitute it. Records of a foreign namespace look
"not found" (404) rather than a permission refusal.

**Rights.** Reads — `requireAuth` (core, standalone) / **ADMIN** (managed, an
admin portal). Index mutations — **the same guard** as the reads (managed —
ADMIN). No memory ports in the build → **503 `MEMORY_UNAVAILABLE`** (degradation,
not a 500).

**Project authorization (invariant 16, ADR-089 §5.8).** `projectId` is an ordinary
request parameter, so the rights on the project are checked **at the boundary**
(before the port/tool is called), not inside the handler: `read` — the right to
**read** the project (owner/member/`LEAD`/`ADMIN`), `write` — the right to
**change the content** (owner/`EDITOR`/`LEAD`/`ADMIN`; `VIEWER` only reads —
invariant 21). A refusal — **403 `FORBIDDEN`**; a failure of the check itself
(an exception) — also 403 (fail-closed: a broken check must not become a
permission). In managed the portal is additionally closed by the role guard
(ADMIN) — the project check works **on top of** it. The check is not set
(standalone: a single user on the instance) — access is allowed. `GET /status`
is outside the check: an instance-wide aggregate, it has no `projectId`.
**404 before 403**: "no such entity" (a fact, an index, a project) answers 404,
and the rights are checked afterwards — against the project of the entity that
was found.

| Route | Access kind | Project id |
|---|---|---|
| `GET /memory/facts?projectId=` | `read` | query (not passed — no check) |
| `GET /memory/facts/:id` | `read` | the project **of the fact itself** (no project — no check) |
| `GET /memory/indexes?projectId=` | `read` | query (not passed — no check) |
| `POST /memory/indexes` | `write` | body (required; `scope:'instance'` — no check) |
| `POST /memory/indexes/:id/rebuild` | `write` | the project **of the index** (`scope:'instance'` — no check) |
| `DELETE /memory/indexes/:id` | `write` | the project **of the index** (`scope:'instance'` — no check) |
| `POST /memory/consolidate` | `write` | body (not passed — an instance-wide operation) |
| `GET /memory/graph?projectId=` | `read` | query (not passed — no check) |

**The scope of the indexes (`scope`).** A memory index has a scope
(`MemoryIndexRecord.scope`, ADR-096): `project` (by default — the index is
visible only to its project) or `instance` (an **instance-wide** index — visible
to **everyone** on the instance: a shared corpus, e.g. an index over the memory
facts).

| | `scope: 'project'` (by default) | `scope: 'instance'` |
|---|---|---|
| `projectId` in the body | required — the **owner** of the index | for `source.kind:'files'` — the **corpus source** (whose workspace is scanned); for `source.kind:'facts'` — **not used** (it is not passed to the tool and not written into the record) |
| rights on the project | `write` — checked **at the boundary** | **not applied**: the operation is instance-wide (in managed the portal is under ADMIN anyway) |
| the project workspace | required for `source.kind:'files'` | required for `source.kind:'files'` (the corpus source) |
| the `scope` tool parameter | not passed (the plugin default is `project`) | `scope: 'instance'` |

Rules:

- **`scope` not set → `'project'`** (the previous behaviour); an unknown value
  (in the body or in the query) → 400 `VALIDATION_ERROR`;
- **the list**: `GET /api/v2/memory/indexes?scope=` — the scope filter
  (`project`|`instance`; `all`/empty — no filter). The `projectId` filter works
  as before: it also matches an instance index with a source project
  (intentionally: the `projectId` of an instance index is the **corpus source**,
  not the scope; the scope is filtered by the separate `scope` parameter);
- **rebuild/delete**: for an instance index the project rights are **not
  checked**, and the project is resolved only as the corpus source
  (`source.kind:'files'` and a set `projectId`) — 404 `PROJECT_NOT_FOUND` /
  400 `MEMORY_WORKSPACE_REQUIRED`, but **without** the rights check; for a
  project index — everything as before;
- **only the portal creates instance indexes** (in managed — ADMIN, the role
  guard): the plugin tool accepts `scope:'instance'` only for the portal's
  service call (`sessionId: 'system:memory-portal:<uuid>'`), an ordinary agent
  call does not create an instance index.

**The secrets and the egress.** The portal does **not** mask the content: there
is no obfuscation at indexing (the rationale and the measures —
[MEMORY.md](../MEMORY.md) §10.1, RU). The chunk text goes to the embeddings
provider as is, and the found fragments go to the LLM; so only the directories
without sensitive text are worth indexing. The secret directories and files are
**always** excluded from the corpus — the policy of the core
`engine/security/secret-files.ts` (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`,
`.terraform`, `.gcloud`, `secrets`; `.env*`, `credentials*.json`,
`secret(s).json|yaml|yml`, `service-account*.json`, `id_rsa|ed25519|ecdsa|dsa*`,
`*.pem|key|p12|pfx|jks|keystore|ppk|kdbx`, `*.tfstate*`); the exclusions cannot
be turned off. The recommendation is **local** embeddings
(`plugins.embeddingProvider=ollama`): the corpus does not leave the host. The
models, their dimension and latency — [MEMORY.md](../MEMORY.md) §2.4 (RU); a
model change marks the indexes `stale` (the rebuild —
`POST /memory/indexes/:id/rebuild`).

| Method | Path | Build | Purpose / req-resp |
|---|---|---|---|
| GET | `/api/v2/memory/status` | both | The portal state: `{provider:{id,mode,active}, readiness, namespace, facts:{total,active}, indexes:{total,ready,stale,failed,building}}`. `provider.id` = the namespace, `provider.mode` = `inline` (the memory plugin is `inline` by design) or `null`, `provider.active` — whether the `synth-plugin-memory` plugin is active in the process. `readiness`: `ready` (the service is available, no problematic indexes) / `degraded` (there are `failed`/`stale` indexes) / `unavailable` (the memory ports are not configured — the answer is **200**, the portal shows "memory unavailable"). The counters go through the ports (`count` of the facts, a selection of the indexes) |
| GET | `/api/v2/memory/facts` | both | A page of facts: `{items, total, limit, offset}`. Parameters: `query` (a substring of `text`, case-insensitive; searched **in memory** after the selection — full-text search is M2), `kind`, `status` (`candidate`\|`active`\|`superseded`\|`retracted`\|`all`; `active` by default), `projectId`, `limit` (1..200, 50 by default), `offset` (≥ 0, 0 by default). `total` is the number of records **under the filters** (not the page length). Garbage in the parameters → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/memory/facts/:id` | both | A fact by id (`MemoryFactRecord` as is); no fact (or a foreign namespace) → 404 `MEMORY_FACT_NOT_FOUND` |
| GET | `/api/v2/memory/indexes` | both | A page of indexes: `{items, total}` — `MemoryIndexRecord` records **without the chunks** (the chunks are a separate port). Parameters: `projectId`, `state` (`building`\|`ready`\|`stale`\|`failed`\|`all`; `all` by default), `scope` (`project`\|`instance`\|`all`; `all` by default — no filter). Garbage in `state`/`scope` → 400 `VALIDATION_ERROR` |
| PATCH | `/api/v2/memory/indexes/:id` | both | Body `{enabled:boolean}` → 200 `{index}`: enable/disable a **project** index (not used by recall/search, stays listed). `scope:'instance'` → 409 `MEMORY_INDEX_NOT_TOGGLEABLE` (shared index cannot be disabled); missing/foreign namespace → 404; non-boolean → 400 `VALIDATION_ERROR` |
| POST | `/api/v2/memory/indexes` | both | Create an index: the body `{name?, source?:{kind:'files'\|'facts', filter?}, projectId?, scope?:'project'\|'instance', force?}` → **202** `{index, message}`. `scope` not set → `'project'` (the previous behaviour); `'instance'` — an **instance-wide** index (visible to everyone on the instance), the project rights are not applied, and `projectId` for `source.kind:'files'` is the corpus source (for `'facts'` — not used). `index` — the `MemoryIndexRecord` from the port (by the tool's `metadata.indexId`); if there is no record yet — the tool's `metadata`; `index.scope` comes from the port. `message` — a localized confirmation. The boundaries: a project is required (a file index is built in a project; for `scope:'instance'` — only with `source.kind:'files'`) → 400 `MEMORY_PROJECT_REQUIRED`; no such project → 404 `PROJECT_NOT_FOUND`; the project has no workspace and `source.kind === 'files'` → 400 `MEMORY_WORKSPACE_REQUIRED`; an unknown `scope` → 400 `VALIDATION_ERROR`; the provider is unavailable → 409 `MEMORY_PROVIDER_UNAVAILABLE`; the tool fails → 422 `MEMORY_INDEX_FAILED` |
| POST | `/api/v2/memory/indexes/:id/rebuild` | both | Rebuild an index: the body `{force?}` → **202** `{index}`. The project and the source of the index are taken **from the port** (a client cannot substitute them). For an instance index (`scope:'instance'`) the project rights are **not checked**, and the project is resolved only as the corpus source (`source.kind:'files'`): no such project → 404 `PROJECT_NOT_FOUND`, no workspace → 400 `MEMORY_WORKSPACE_REQUIRED`. No index (or a foreign namespace) → 404 `MEMORY_INDEX_NOT_FOUND`; the provider is unavailable → 409 `MEMORY_PROVIDER_UNAVAILABLE`; the tool fails → 422 `MEMORY_INDEX_FAILED` |
| DELETE | `/api/v2/memory/indexes/:id` | both | Delete an index → **204**. For an instance index (`scope:'instance'`) the project rights are **not checked**. No index → 404 `MEMORY_INDEX_NOT_FOUND`; the provider is unavailable → 409 `MEMORY_PROVIDER_UNAVAILABLE`; the tool fails → 422 `MEMORY_INDEX_FAILED` |
| POST | `/api/v2/memory/consolidate` | both | Consolidate the facts: the body `{projectId?, threshold?, dryRun?}` → **200** `{report, message}`. `report` = `{clusters, superseded, kept, items}` — the number of clusters, the number of superseded facts, the number of canonical facts and the cluster contents (`items`: `{keptId, supersededIds, similarity}` per cluster). `threshold` — the cosine similarity threshold (0.5..0.99), out of range → 400 `VALIDATION_ERROR`; `dryRun` — a run without writes (the plugin decides). `projectId` — the project whose facts are consolidated; without it — the facts of the instance; no such project → 404 `PROJECT_NOT_FOUND`. The project **does not need** a workspace (the consolidation works on the facts). The provider is unavailable → 409 `MEMORY_PROVIDER_UNAVAILABLE`; the tool fails → 422 `MEMORY_CONSOLIDATION_FAILED` (the machine code of the tool is in `error.details.code`) |
| GET | `/api/v2/memory/graph` | both | Read the memory graph: the query `entity?` (the start entity of the walk; not set or empty — the whole graph), `depth?` (1..3, 1 by default), `limit?` (1..200, 100 by default), `projectId?` (the graph scope) → **200** `{nodes, edges, stats}`. `nodes` — `{id, kind:'entity'\|'fact', name?, factId?, text?, entity?}`, `edges` — `{from, to, relation?}`, `stats` — `{entities, facts, edges}`. Garbage in `depth`/`limit` → 400 `VALIDATION_ERROR`; no such project → 404 `PROJECT_NOT_FOUND`; the provider is unavailable → 409 `MEMORY_PROVIDER_UNAVAILABLE`; the tool fails → 422 `MEMORY_GRAPH_FAILED` (the machine code of the tool is in `error.details.code`) |

**Mutations: the portal → the plugin's admin tool through the registry.** The index
logic belongs to the **plugin** (PROP-047 §3: the core owns the data, the plugin
owns the logic), so the portal does **not** write to the index port directly: it
checks the boundaries (project, workspace, provider availability, rights) and
calls the memory plugin's **admin tool**
`plugin_synth_plugin_memory_memory_index`
(`pluginToolFullName('synth-plugin-memory', 'memory_index')`, ADR-090) through the
tool registry — `executeToolDef` (`engine/tools/tool-execution.ts`). The tool is the
**sole owner of the index logic**: it creates, rebuilds and deletes; the portal is
responsible for the HTTP contract only.

| Tool parameter | Value |
|---|---|
| `action` | `create` \| `rebuild` \| `delete` |
| `indexId` | the index id (`rebuild`/`delete`) |
| `name` | the index name (`create`, `project` by default — on the plugin side) |
| `source` | `{kind:'files'\|'facts', filter?}` (`create`, `files` by default) |
| `projectId` | the project that owns the index (for `scope:'instance'` — the corpus source; for an instance index with `source.kind:'facts'` — not passed) |
| `scope` | `instance` — an instance-wide index (`create`); for project indexes it is not passed (the plugin default is `project`). The plugin accepts it **only** for the portal's service call (`sessionId: 'system:memory-portal:<uuid>'`) |
| `force` | a forced rebuild (`rebuild`) |

The call context (sessionId/messageId/workingDir) is created by the **calling
side** (`mount-routes`): the portal has no session, it is an instance-level
service call (`system:memory-portal:<uuid>`). `workingDir` is the **project
workspace** (`project.workspace`, ADR-075); for the `facts` source without a
workspace — the instance data directory. The provider is unavailable when the
invoker is not configured or the memory plugin is not active in the process
(`PluginHost.isActive`) — then the mutations answer 409 while the reads work as
before. The text of a tool failure (`isError`) is returned in 422
`MEMORY_INDEX_FAILED`; the internal paths (the data directory, the working
directory) are masked in it.

**Fact consolidation.** The consolidation (PROP-047 §2.1) is also the **plugin's
logic**: the portal does not count the clusters itself, it calls the memory
plugin's admin tool `plugin_synth_plugin_memory_memory_consolidate`
(`pluginToolFullName('synth-plugin-memory', 'memory_consolidate')`, ADR-090) the
same way as the index mutations do. The plugin groups the facts into **clusters
by the cosine similarity** of the embeddings, picks a **canonical fact** in each
cluster (the reference one) and marks the rest as `superseded` — the duplicates
replaced by the canonical fact; the report is the number of clusters, the number
of replaced facts, the number of canonical facts and the contents of every
cluster (`items: [{keptId, supersededIds, similarity}]`). The client sets the
similarity threshold (`threshold`, 0.5..0.99; by default — on the plugin side),
`dryRun` runs the consolidation **without writes** (a report only). Unlike an
index build the operation is **synchronous**: the answer is 200 with the report,
not 202. The project is optional (`projectId` — the facts of a specific project
are consolidated, otherwise the instance's ones); a **workspace is not needed** —
the consolidation works on the facts, and the working directory of the call is
the project workspace if it exists, otherwise the instance data directory. A tool
failure → 422 `MEMORY_CONSOLIDATION_FAILED`, its machine code (e.g.
`plugin.embedding_not_configured`) — in `error.details.code`.

**Reading the memory graph.** The graph (PROP-047 §2.1, M5) is also the
**plugin's logic**: the plugin extracts the entities and their co-occurrences
from the text of the facts itself (the core does not build a graph IR). So the
portal calls the memory plugin's admin tool
`plugin_synth_plugin_memory_memory_graph`
(`pluginToolFullName('synth-plugin-memory', 'memory_graph')`, ADR-090) the same
way as the index mutations and the consolidation do: the guard is **the same**
as for the reads (managed — ADMIN); an unavailable provider (the invoker is not
configured or the plugin is not active) → 409 `MEMORY_PROVIDER_UNAVAILABLE`; a
tool failure → 422 `MEMORY_GRAPH_FAILED` (its machine code is in
`error.details.code`, the internal paths in the text are masked).

The graph is built from the entity mentions in the memory facts: `[[entity]]` —
an entity (a `kind:'entity'` node), `[[entity|relation]]` — an entity with a
relation type (the `relation` of an edge); the fact where the entities co-occur
is a `kind:'fact'` node, and the co-occurrence of two entities in one fact is
an edge between them. The answer: the nodes (`nodes`), the co-occurrences
(`edges`) and the counters (`stats`). The portal normalizes the shape of the
answer: the untrusted tool metadata does not break `{nodes, edges, stats}` (a
node without `id`/with an unknown `kind` and an edge without `from`/`to` are
dropped), and the counters are counted **from the normalized** nodes and edges —
the answer of the plugin cannot disagree with the shape of the graph.

Parameters: `entity` — the start entity of the walk (not set or empty — the
whole graph; a non-empty string of at most 200 characters, longer → 400
`VALIDATION_ERROR`); `depth` — the depth of the walk (1 — the entity itself, 2 —
its relations, 3 — the relations of the relations; 1..3, 1 by default); `limit` —
the node cap of the answer (1..200, 100 by default). The scope — `projectId`
(optional): the project must exist (no such one → 404 `PROJECT_NOT_FOUND`), the
working directory of the call is the project workspace, otherwise the instance
data directory (the graph is readable without a workspace). The project scope
goes into the **call context** of the tool (`projectId`), not into its
parameters: the tool contract is `entity`/`depth`/`limit`.

**Error codes:** `VALIDATION_ERROR` (400), `MEMORY_PROJECT_REQUIRED` (400),
`MEMORY_WORKSPACE_REQUIRED` (400), `PROJECT_NOT_FOUND` (404),
`MEMORY_FACT_NOT_FOUND` (404), `MEMORY_INDEX_NOT_FOUND` (404),
`MEMORY_PROVIDER_UNAVAILABLE` (409), `MEMORY_INDEX_FAILED` (422),
`MEMORY_CONSOLIDATION_FAILED` (422), `MEMORY_GRAPH_FAILED` (422),
`MEMORY_UNAVAILABLE` (503).

**Example.**

```bash
# The state of the memory portal.
curl http://localhost:5000/api/v2/memory/status -H 'Authorization: Bearer admin-key-123'

# The active facts with a substring search.
curl 'http://localhost:5000/api/v2/memory/facts?status=all&query=fleet&limit=20' \
  -H 'Authorization: Bearer admin-key-123'

# The indexes that need a rebuild.
curl 'http://localhost:5000/api/v2/memory/indexes?state=stale' \
  -H 'Authorization: Bearer admin-key-123'

# Create a file index for a project (202 → {index, message}).
curl -X POST http://localhost:5000/api/v2/memory/indexes \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"projectId":"prj_1","name":"docs","source":{"kind":"files","filter":"**/*.md"}}'

# An instance-wide index over the memory facts — visible to everyone on the
# instance (202).
curl -X POST http://localhost:5000/api/v2/memory/indexes \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"scope":"instance","name":"global-facts","source":{"kind":"facts"}}'

# Only the instance-wide indexes.
curl 'http://localhost:5000/api/v2/memory/indexes?scope=instance' \
  -H 'Authorization: Bearer admin-key-123'

# Rebuild the index (202) and delete it (204).
curl -X POST http://localhost:5000/api/v2/memory/indexes/<indexId>/rebuild \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"force":true}'
curl -X DELETE http://localhost:5000/api/v2/memory/indexes/<indexId> \
  -H 'Authorization: Bearer admin-key-123'

# Consolidate the facts of a project in a dry run (200 → {report, message}).
curl -X POST http://localhost:5000/api/v2/memory/consolidate \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"projectId":"prj_1","threshold":0.85,"dryRun":true}'

# The memory graph: an entity and its relations (200 → {nodes, edges, stats}).
curl 'http://localhost:5000/api/v2/memory/graph?entity=Fleet&depth=2&limit=50' \
  -H 'Authorization: Bearer admin-key-123'
```

### 5.39 Background runs — `/api/v2/processes` (both, ADR-111/PROP-097)

A single registry of the background work ([ADR-111](../arch_decisions/adr-111-background-subagent-sessions.md),
PROP-096/PROP-097): two kinds of runs — `subagent` (a background child session of a
subagent, `task({background: true})`) and `process` (a background shell command,
`execute_shell({background: true})`). The registry record is persistent (the
`BackgroundRunRepository` port, ADR-096), so the state of a run survives a UI reconnect
and a service restart; the "live" cancel handles live in the process memory (after a
restart the `running` records become `orphaned`).

The `createProcessRoutes` factory is shared by core and backend; managed passes the
project access rule (`packages/backend/src/routes/processes.ts`).

**Session limits (`background.*`).** Checked when a run is registered and counted only over
the **live** (`running`) records: `maxSubagentsPerSession`/`maxProcessesPerSession` — per
their own kind of work, `maxRunsPerSession` — the overall ceiling of the runs of both kinds
running at the same time. The terminal records are the registry history (the retention,
`background.retentionDays`, cleans them) and are **not** counted by the limit, so the
finished runs do not block new starts. Exceeding it → `background_limit_exceeded` (a tool
error, the turn does not fail; in detach — the `BACKGROUND_LIMIT` code in `failed[]`).

| Method | Path | Build | RBAC (managed) | Purpose / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/processes` | both | auth | The run list `{runs}`; filters `sessionId`/`projectId`/`kind` (`subagent`/`process`)/`status` (`running`/`completed`/`failed`/`cancelled`/`orphaned`)/`limit` (default 50, maximum 200); an invalid `kind`/`status` → 400 `VALIDATION_ERROR`. Only the runs of the sessions available to the user are returned (the owner/a project member; `ADMIN`/`LEAD` — all) |
| GET | `/api/v2/processes/:id` | both | auth | The run `{run}` (the whole registry record); no run → 404 `NOT_FOUND`, no owner session → 404, no rights → 403 `FORBIDDEN` |
| GET | `/api/v2/processes/:id/logs` | both | auth | A segment of the background process log `{content, offset, nextOffset, totalBytes, truncated}`; only `kind:'process'` (for `subagent` → 400 `VALIDATION_ERROR`), no log file → 404 `NOT_FOUND`. `offset` — the offset in bytes from the beginning of the log, `limit` — the size of the output (default and maximum — 256 KiB) |
| POST | `/api/v2/processes/:id/stop` | both | auth (**write**) | Stop the run → 200 `{status:'stopping'}` (the stop is asynchronous: the stop request arrives with the `process.stopped` event, the final status — with the `process.exited` event); the run is not `running` anymore or it runs in another process (it cannot be stopped from here) → 409 `CONFLICT` |
| DELETE | `/api/v2/processes/:id` | both | auth (**write**) | Delete the registry record → **204**; the run is still `running` → 409 `CONFLICT` |

**Access boundary (invariants 16/21).** The right to a run is the right to its **owner
session**, and it is checked **at the boundary**, not in the handler: the guard resolves
the registry record and its session owner **once** and puts the record into the Hono
context (`guardedProcess`); there are no access checks in the handlers — otherwise the
rules would diverge. The access kind is derived from the HTTP method (`read` — reading,
`write` — a mutation): a project member with the view role (`VIEWER`) reads the run, but
**cannot** stop or delete it (invariant 21). The managed role rules: the session owner;
`ADMIN` — cross-cutting access; `LEAD` — cross-cutting access to the project content; a
project member — `read` for any role, `write` — `OWNER`/`EDITOR`/`LEAD`/`ADMIN`. In
standalone (core) the predicate of the single instance owner applies. The run list is
filtered by the same rule: a record whose session is not visible does not appear in the
output at all (the sessions are cached per request, not per process — the rights change,
and a process cache would hand out stale decisions).

**Degraded storage mode (ADR-098).** In the degraded mode the background work services
are not created — the `/api/v2/processes` contour is **not mounted**, so all the endpoints
of the section respond `404` (there is no contour).

**Events.** The live changes arrive in the **owner session channel**
(`process.started`/`process.stopped`/`process.exited`/`child.*`, ADR-009/ADR-024; no new
transport channels) — the composition and the fields of the events — §3.2. A background
subagent additionally publishes a notification into the parent's history and enqueues the
parent's turn (an auto-turn) — see
[ADR-111](../arch_decisions/adr-111-background-subagent-sessions.md).

**Storage.** The registry — `{dataDir}/processes/registry.json` (ADR-005, an atomic write);
PostgreSQL — the `background_runs` table (the `021_background_runs` migration of the
`@itphx/synth-storage-postgres` driver, ADR-097). The logs of the background processes — a
blob store (`BlobStore`), the path `processes/<id>.log`; the log write limit —
`background.logMaxBytes` (the ceiling of the output per HTTP request — 256 KiB, these are
different values).

**UI.** The “Processes” tab of the right panel
(`packages/ui/src/components/panels/ProcessesTab.tsx`): the run list (kind, status,
command/description, time), the log of the background process, “Stop” and the deletion of
the record. The refresh — the live events `process.*`/`child.*` plus a periodic re-read of
the list while the tab is active.

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
| Plugins (ADR-090) | `packages/core/src/server/routes/plugins.ts`, `packages/core/src/engine/plugins/*` (the host, the loader, the installer, the runtime), `packages/shared/src/types/{pack,plugin-audit,plugin-lock,plugin-scan,prompt-blocks,llm-filters,plugin-tools}.ts` |
| Memory: the portal and the metrics (ADR-107, PROP-047) | `packages/core/src/server/routes/memory.ts`, `packages/core/src/metrics/collectors/memory.ts`, `packages/core/src/storage/ports/{memory-fact-repository,memory-index-repository}.ts`, `packages/core/src/engine/plugins/scoped-memory.ts` |
| External credentials (ADR-105) | `packages/core/src/server/routes/oauth.ts`, `packages/core/src/engine/oauth/*` (client, service, registry, audit), `packages/core/src/storage/external-credential-store.ts`, `packages/core/src/storage/ports/{external-credential-repository,credential-audit-repository}.ts`, `packages/shared/src/types/external-credentials.ts` |
| Background runs: the registry, the services, the HTTP contour (ADR-111, PROP-096/097) | `packages/core/src/server/routes/processes.ts`, `packages/core/src/engine/background/*`, `packages/core/src/engine/processes/*`, `packages/core/src/storage/ports/background-run-repository.ts`, `packages/backend/src/routes/processes.ts`, `packages/shared/src/types/background.ts` |
| EventHub | `packages/backend/src/events/hub.ts` |
| Rate limiter | `packages/backend/src/middleware/rate-limiter.ts` |
| Core standalone app + SSE/WS | `packages/core/src/server/app.ts` |
| Core routes | `packages/core/src/server/routes/*.ts` |
| Core auth | `packages/core/src/auth/local.ts` |
| Contracts (`BusEvent`) | `packages/shared/src/types/index.ts` |
