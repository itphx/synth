# API v2 — справочник

> Канонический источник истины по HTTP/WS-контракту Synth, собранный **по коду**
> (ADR-017). Общие конвенции (стиль, порты, процесс, хранилище) — в корневом `AGENTS.md`.

## Базовые URL

| Сборка | Базовый URL | Аутентификация |
|---|---|---|
| `@itphx/synth-backend` (managed, API Hub) | `http://localhost:5000` → API `http://localhost:5000/api/v2` | OIDC cookie/JWT, API key, debug-ключи |
| `@itphx/synth-core` (standalone, `synth serve`) | `http://localhost:4300` → API `http://localhost:4300/api/v2` | один API-ключ (`--api-key`/`SYNTH_API_KEY`) |

Порты: backend — `SYNTH_PORT` (5000), core — `SYNTH_CORE_PORT` (4300). Auth-роуты
живут под `/auth/*` (без префикса `/api/v2`), health — под `/health` и `/api/v2/health`.

**Доступность по сборкам** в таблицах ниже: `backend` — только managed-хаб,
`core` — только standalone, `оба` — обе сборки. У core набор уже: нет
`context/users/audit/logs/gateway/llm/i18n/admin`, зато есть `auth/*`,
`hybrid/status`, а также `/git` и `/ssh-keys` (ADR-076; core-фабрики, в backend
монтируются с RBAC). В гибриде на backend проксируются `/git`, flat `/ssh-keys`
и nested `/agents/:agentId/ssh-keys` (остальные подпути `/agents` — локальны).

---

## 1. Аутентификация и RBAC

### Способы (backend, приоритет проверки)

1. **Service-key (ADR-052, этап I)** — `Authorization: Bearer synth_svc_…`
   (машинный доступ). Распознаётся по префиксу секрета; резолвится в
   синтетического пользователя `{ id: 'service:<keyId>', roles: key.roles }`
   плюс контекст `{ scopes, allowedProjects?, rateLimitPerMinute? }`. Ключ,
   отозванный (`revokedAt`) или истёкший (`expiresAt`), и неизвестный секрет →
   `401 UNAUTHORIZED`. Управление — §5.28.
2. **Cookie `user_session`** — серверная сессия в памяти процесса
   (`Map<sessionId, {user, expiresAt}>`, TTL `auth.sessionMaxAgeMinutes`).
   Устанавливается `POST /auth/spa-login` / OIDC callback. Cookie `httpOnly`,
   `sameSite=Lax`.
3. **Debug-ключи** — при `SYNTH_AUTH_DEBUG=true` (`config.auth.debugMode`):
   `Authorization: Bearer <apiKey>` из `config.auth.testUsers`. Пользователь
   получает роли и `isTestUser=true`.
4. **OIDC JWT** — при `config.oidc.enabled`: `Authorization: Bearer <jwt>`,
   верификация через lazy OIDC-клиент.
5. **API key** — при `!debugMode && !oidc.enabled && config.apiKey`:
   `Authorization: Bearer <SYNTH_API_KEY>` → пользователь `api` с ролью `ADMIN`.

Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

**Service-key: scopes и проектная проекция (ADR-052).** Роли ключа дают совместимость
с `requirePermission` (RBAC-эндпоинты), а `scopes` — точечный гейт поверх: если в
контексте есть service-key, роут требует хотя бы один из своих scope (иначе
`403 SCOPE_REQUIRED`). Для интерактивных кред (cookie/debug/OIDC/API-key/локальный
ключ) scope-гейт — no-op (запрос пропускается). Каталог scope: `events:ingest`,
`events:watch`, `bindings:read|write`, `keys:read|write`, `routes:read|write`,
`sessions:create|read|prompt`, `schedules:read|write`, `llm:chat`, `addons:install`,
`users:read` + wildcard-семейства
`events:*`, `bindings:*`, `keys:*`, `routes:*`, `sessions:*`, `schedules:*`
(глобального `*` нет). Отдельно: на части роутов (запись реестра MCP, запись
скиллов, чтение админского user-API) scope работает как альтернатива роли ADMIN
(«ADMIN **или** scope», см. §5.14/§5.16/§5.17). Проектная проекция `allowedProjects`: если у ключа задан
непустой список, доступны только входящие в него проекты — применяется в sessions,
events/bindings и schedules (иначе `403 PROJECT_FORBIDDEN`); пусто/отсутствует —
политика инстанса. Точки применения scope по роутам — в §5.5, §5.26, §5.27, §5.23.

Debug-пользователи (`SYNTH_AUTH_DEBUG=true`):

| Пользователь | Ключ | Роли |
|---|---|---|
| admin | `admin-key-123` | ADMIN |
| developer | `user-key-456` | USER |
| lead | `lead-key-789` | LEAD |
| auditor | `auditor-key-012` | AUDITOR |

### Middleware (`packages/backend/src/auth/middleware.ts`)

| Функция | Семантика |
|---|---|
| `getCurrentUser(c)` | Пытается определить пользователя по cookie/debug/JWT/API key; возвращает `User \| null` без ошибки. |
| `attachUser` | Глобальный middleware `app.use('*', ...)`: кладёт пользователя в `c.set('user', ...)`, если он есть, и всегда вызывает `next()`. |
| `requireAuth` | Нет пользователя → `401 {error:{code:'UNAUTHORIZED'}}`; иначе кладёт в контекст и `next()`. |
| `requireAdmin` | Нет роли `ADMIN` → `403 {error:{code:'FORBIDDEN'}}`. |
| `requirePermission(...roles)` | Нет ни одной из перечисленных ролей → `403 FORBIDDEN`. Используют `audit`, `logs` (`ADMIN`,`AUDITOR`), `sessions/:id/secrets` (`ADMIN`,`AUDITOR`), service-keys (`ADMIN`), events bindings/routes/keys (`ADMIN`,`LEAD`). |

Отдельно от `middleware.ts` — **scope-гейты service-key** (`packages/backend/src/auth/service-scope.ts`:
`scopeGuard`/`projectGuard`, делегируют core-`requireScope`/`checkProjectAccess` и отдают
локализованные `403 SCOPE_REQUIRED`/`PROJECT_FORBIDDEN`; вне service-key — no-op).

### Standalone-core (`packages/core/src/auth/local.ts`)

| Механизм | Описание |
|---|---|
| `Authorization: Bearer <apiKey>` | Совпал с `config.apiKey` → пользователь `local` (роль `ADMIN`). |
| `Authorization: Bearer synth_svc_…` | Service-key (ADR-052): синтетический пользователь ключа + `scopes`/`allowedProjects` в контексте; отозванный/истёкший/неизвестный → `401`. |
| Cookie `synth_session` | HMAC-подписанный API-ключ (v1) либо JSON `{v:2, kind:'local'\|'server', user}` (v2, гибридная личность). |
| `requireAuth` | Единственный guard; `403`/`ADMIN`-проверок в standalone нет (scope-гейты `requireScope`/`checkProjectAccess` работают только для service-key). |

В standalone `requireAuth` навешан глобально на `/api/*`, поэтому все `/api/v2/*`
эндпоинты (кроме health и `hybrid/status`) требуют ключ. Гибридный вход
(`/auth/login`, `/auth/device-*`) ставит cookie v2 с серверной личностью.

### Rate limiting (только backend)

In-memory `createRateLimiter(maxRequests, windowMs)`, ключ — `Authorization`/`x-forwarded-for`.
При превышении — `429 {error:{code:'RATE_LIMITED'}}`.

| Эндпоинт | Лимит |
|---|---|
| `POST /api/v2/llm/chat/completions` | 120 / 60 с |
| `POST /api/v2/sessions/:id/prompt` | 30 / 60 с |
| `POST /auth/spa-login` | 5 / 60 с |
| `POST /api/v2/providers/:name/test` | 5 / 60 с |
| `POST /api/v2/providers/fetch-icon` | 10 / 60 с |
| `POST /api/v2/models/fetch` | 3 / 120 с |

---

## 2. Формат ошибок

Основной формат (все роуты, `notFound`, middleware):

```json
{ "error": { "code": "NOT_FOUND", "message": "Сессия не найдена" } }
```

Исключение — файловые операции и git-роуты (единые core-фабрики, ADR-075/ADR-076):
они отдают формат `FsError` `{ "error": { "error": "<message>", "code": "<FsErrorCode>" } }`
(`packages/core/src/server/routes/fs.ts`, `packages/core/src/server/routes/git.ts`);
backend и standalone монтируют одну и ту же фабрику.

Реальные коды (из кода):

| Код | Где |
|---|---|
| `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_REQUEST` | валидация тел/параметров |
| `UNAUTHORIZED` | `requireAuth`, auth-роуты, неверный/отозванный/истёкший service-key (ADR-052) |
| `FORBIDDEN` | `requireAdmin`/`requirePermission`, filesystem |
| `SCOPE_REQUIRED` | service-key без нужного scope (ADR-052; только для service-key) |
| `PROJECT_FORBIDDEN` | service-key с `allowedProjects` без доступа к проекту (ADR-052) |
| `NOT_FOUND` | отсутствие сессии/проекта/провайдера/модели/агента/файла/лога |
| `CONFLICT` | дубли MCP-сервера, retry-состояние |
| `ALREADY_EXISTS`, `IS_DIRECTORY`, `DIR_NOT_EMPTY`, `PATH_TRAVERSAL`, `PERMISSION_DENIED` | ФС |
| `WORKSPACE_OUTSIDE_ROOT_DENIED`, `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`, `WORKSPACE_CREATE_FAILED`, `WORKSPACE_POLICY_READ_ONLY`, `WORKSPACE_ROOT_NOT_CONFIGURED`, `PROTECTED_PATH_DENIED`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_SET`, `NOT_A_DIRECTORY` | workspace/ФС (ADR-075) |
| `git.ssh_key_required`, `git.repo_path_invalid`, `git.repo_exists` | git-реестр (ADR-076, shared-форма) |
| `sshkey.not_found`, `sshkey.name_exists`, `sshkey.decrypt_failed`, `sshkey.encryption_unavailable`, `sshkey.env_failed` | SSH-ключи агентов (ADR-076) |
| `PROJECT_NOT_FOUND`, `NOT_AVAILABLE` | сессии/настройки |
| `RATE_LIMITED`, `QUEUE_FULL` | лимиты и очередь |
| `INVALID_ACTION`, `INVALID_INDICES` | batch-операции сообщений |
| `MODEL_NOT_FOUND`, `MODEL_DISABLED`, `MODEL_MISMATCH`, `PROVIDER_NOT_FOUND`, `PROVIDER_DISABLED`, `PROVIDER_ERROR`, `PROVIDER_CONFIG_ERROR`, `CONTEXT_LENGTH_EXCEEDED` | LLM Proxy |
| `MCP_CONNECT_ERROR` | probe MCP |
| `OFFLINE`, `AUTH_ERROR`, `REMOTE_UNAVAILABLE` | гибрид/remote |
| `UPDATE_CHECK_FAILED` | проверка обновлений |
| `INTERNAL_ERROR` | прочие 500 |

Специфичные коды resume саб-агента (`SubagentResumeError`): `NOT_FOUND`,
`NO_PARENT`, `LOCKED`, `PARENT_NOT_FOUND`, `AGENT_NOT_FOUND` (статусы 400/404/409).

---

## 3. Транспорт событий

Единый канал — **WS `/ws/events`** (EventHub/EventBus, ADR-008/ADR-009/ADR-024);
фоллбек — **SSE `GET /api/v2/events`**. Формат события — `BusEvent`:

```ts
interface BusEvent { type: EventType; sessionId: string; data: Record<string, unknown>; timestamp: string }
```

- Backend: WS-аутентификация по Bearer JWT/API key или cookie `user_session`;
  при подключении шлёт `{type:'connected', client_id, engine:'synth'}`.
  Поддерживает клиентские сообщения `ping`→`pong`, `send_message`, `cancel`,
  `permission_reply`, `permission_hold`. EventHub автоматически подписывает
  клиента на все сессии пользователя.
- Core standalone: тот же WS `/ws/events` и SSE `/api/v2/events`;
  дополнительно есть сессионный SSE `GET /api/v2/sessions/:id/events`.
- Оба отдают keepalive-комментарий `:keepalive` раз в 30 с.

> Транспорт событий — только WS `/ws/events` и SSE `GET /api/v2/events`.
> Новых каналов не заводить (ADR-008/009/024).

---

## 4. LLM Proxy

`POST /api/v2/llm/chat/completions` (backend, `requireAuth`) — единственная
точка проксирования LLM в managed-хабе (OpenAI-совместимый формат). Любой
LLM-вызов идёт через `GatewayProvider` (guard, обфускация, rate limit, аудит,
ADR-036); напрямую провайдера не дёргать.

Для service-key (ADR-052) требуется scope `llm:chat` (проектная проекция роут не
ограничивает — у прокси нет проектного измерения); проектных гейтов нет.

Тело (подмножество OpenAI): `model`, `messages[]`, `temperature`, `max_tokens`,
`top_p`, `stream`, `tools[]`, `session_id`, `provider`. Ответ — `chat.completion`
(или SSE-чанки `chat.completion.chunk` при `stream:true`, финал `data: [DONE]`).
Ошибки: `404 MODEL_NOT_FOUND`, `400 MODEL_DISABLED|MODEL_MISMATCH`, `502 PROVIDER_NOT_FOUND|PROVIDER_CONFIG_ERROR|PROVIDER_ERROR`, `429 RATE_LIMITED`, `400 CONTEXT_LENGTH_EXCEEDED`.

---

## 5. Эндпоинты по группам

RBAC-колонка: `—` — без auth, `auth` — любой аутентифицированный,
`ADMIN` — только роль ADMIN, `ADMIN/AUDITOR` — одна из ролей.
В core колонка `ADMIN` вырождается в `auth` (ролевых проверок нет).

### 5.1 Health — `оба`

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/health` | — | `{status:'healthy', version, time}` |
| GET | `/api/v2/health` | — | то же |

### 5.2 Hybrid — `core`

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/hybrid/status` | — | Состояние гибрида: `enabled`, `connected`, `backendUrl`, `user`, `knownServers`, `lastServer` |

### 5.3 Auth — `/auth/*`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| GET | `/auth/login` | backend | — | Редирект на OIDC authorize |
| POST | `/auth/login` | backend | — | ROPC-вход (OIDC), ставит cookie |
| GET | `/auth/callback` | backend | — | OIDC callback, cookie |
| GET | `/auth/status` | оба | — | `{authenticated, debug_mode, oidc_enabled, deployment, user}` |
| GET | `/auth/oidc-meta` | backend | — | Публичные OIDC issuer/clientId (без секрета) |
| GET | `/auth/session` | оба | — | Проверка cookie-сессии |
| GET | `/auth/me` | оба | — | Текущий пользователь |
| POST | `/auth/spa-login` | оба | — | JSON `{api_key}` → cookie-сессия |
| POST | `/auth/login` | core | — | ROPC-вход в гибриде `{server?, username, password}` |
| POST | `/auth/device-start` | core | — | OIDC device flow: `verification_uri`, `user_code` |
| POST | `/auth/device-check` | core | — | Статус device flow |
| POST | `/auth/logout` | оба | — | Сброс cookie (`204`); в core — revoke+disconnect |
| GET | `/auth/profile` | оба | auth | Профиль (в гибриде проксируется на backend) |
| PUT | `/auth/profile` | оба | auth | Обновить профиль |
| PATCH | `/auth/profile/preferences` | backend | auth | Слить preferences |
| DELETE | `/auth/profile/preferences` | backend | auth | Сбросить preferences |
| GET | `/auth/profile/avatar` | backend | auth | PNG-аватар (`404` если нет) |
| POST | `/auth/profile/avatar` | backend | auth | Загрузить/удалить аватар (binary) |
| GET | `/auth/locales` | backend | — | Список локалей (`ru`,`en`) |
| GET | `/auth/users` | backend | debug | Тестовые пользователи (только debug) |
| GET | `/auth/defaults` | backend | — | Умолчания оформления |
| PUT | `/auth/defaults` | backend | ADMIN | Сохранить умолчания |

### 5.4 Прочее

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| GET | `/api/config/themes` | оба | — | Заглушка `{themes:[]}` |
| GET | `/api/v2/i18n/current` | backend | — | Текущий язык по `Accept-Language` |
| GET | `/api/v2/i18n/translations/ru` | backend | — | Русский словарь |
| GET | `/api/v2/i18n/translations/en` | backend | — | Английский словарь |
| GET | `/api/v2/openapi.json` | оба | auth | Публичная OpenAPI 3.1-спека интеграционного ядра (ADR-052, этап III; `server/openapi/public-openapi.ts`): 28 операций (events/sessions/schedules/llm), именованные `components.schemas`, единый формат ошибок `publicErrorSchema` (`{error:{code,message}}`) |

### 5.5 Sessions — `/api/v2/sessions`

| Метод | Путь | Сборка | RBAC | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/sessions` | оба | auth (свои+проектные; LEAD/ADMIN — все) | Список сессий; `?project_id=` (см. правила видимости ниже) |
| POST | `/api/v2/sessions` | оба | auth | Создать; `{name|title, project_id, engine, settings}` → 201 || GET | `/api/v2/sessions/:id` | оба | auth | Сессия (сериализованная) |
| GET | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Эффективный MCP-скоуп (ADR-071 §2.4): `{servers:[{name, level, enabled, reason?, connected?, origin, trust, chars?, estTokens?, estimated?}], enabled, disabled, mcpServers, mcpDisabledServers}`. `reason` ∈ `system_disabled\|project_disabled\|session_optout\|not_default`; проектный гейт `enabled` применяется и к системным серверам. Серверы/тулы несут `chars`/`estTokens` (ADR-071 §2.8) |
| PUT | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Переключить MCP (один тумблер): `{name, enabled}` → `mcpServers`/`mcpDisabledServers` (opt-out системных — через `enabled:false`), либо `{mcpServers?, mcpDisabledServers?}` |
| PATCH | `/api/v2/sessions/:id` | оба | auth | `{name, title, engine, mode: plan\|act\|yolo, settings, project_id}` |
| DELETE | `/api/v2/sessions/:id` | оба | auth | Удалить → 204 |
| GET | `/api/v2/sessions/:id/secrets` | backend | ADMIN/AUDITOR | Карта обфускации Gateway `{sessionId, secrets}` |
| POST | `/api/v2/sessions/:id/fork` | оба | auth | Форк; `{message_id?, message_index?, title?}` → 201 |
| GET | `/api/v2/sessions/:id/children` | оба | auth | Дочерние сессии |
| GET | `/api/v2/sessions/:id/tree` | оба | auth | Дерево сессий |
| GET | `/api/v2/sessions/:id/export` | backend | auth | Полный экспорт Session (внутренний формат) |
| POST | `/api/v2/sessions/import` | backend | auth | Импорт сессии из экспорта → 201 |
| GET | `/api/v2/sessions/:id/status` | оба | auth | `{blocked, pending_count, processor_running}` |
| POST | `/api/v2/sessions/:id/prompt` | оба | auth | Поставить сообщение в очередь, вернуть **SSE-стрим** |
| GET | `/api/v2/sessions/:id/prompt` | оба | auth | Состав системного промпта (ADR-070): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (тулы с `chars`/`estTokens` и флагом оценки, ADR-071 §2.8). `manifest.toolsPolicy`/`manifest.mcpPolicy` — применённые политики встроенных/MCP (ADR-071 §2.3); записи: `tools` (stable/context) → `mcp.servers`/`mcp.tools`/`mcp.status` (volatile, не в `staticPrefixChars`) |
| GET | `/api/v2/sessions/:id/stats` | оба | auth | Статистика usage (ADR-070): сообщения + рекурсивный usage саб-агентов (tool `task`), агрегаты по агентам/пользователям (`computeSessionStats`) |
| GET | `/api/v2/sessions/:id/messages` | оба | auth | `{messages, session_id, engine}` |
| POST | `/api/v2/sessions/:id/clear` | оба | auth | Очистить историю (кроме pinned) |
| POST | `/api/v2/sessions/:id/abort` | оба | auth | Надёжный «Стоп» (ADR-005): ставит персистентный флаг `status.cancel_requested`, при живом стриме — graceful-отмена, затем остановка процессора очереди; `{status:'aborted'}`; 404 если сессии нет (см. ниже) |
| POST | `/api/v2/sessions/:id/resume-subagent` | оба | auth | Возобновить саб-агента → 202 |
| POST | `/api/v2/sessions/:id/summarize` | оба | auth | Запросить суммаризацию `{status:'enqueued', stream_id}` |
| GET | `/api/v2/sessions/:id/events` | core | auth | Сессионный SSE-стрим |
| POST | `/api/v2/sessions/:id/debug-system-message` | backend | auth | Отладочное системное сообщение |
| GET | `/api/v2/sessions/:id/optimization` | backend | auth | Настройки оптимизации контекста |
| PATCH | `/api/v2/sessions/:id/optimization` | backend | auth | Обновить настройки оптимизации |
| POST | `/api/v2/sessions/:id/optimization/check` | backend | auth | Проверить триггеры окна/суммаризации |
| POST | `/api/v2/sessions/:id/optimization/cancel-summarization` | backend | auth | Снять ожидание суммаризации |
| GET | `/api/v2/sessions/:id/references` | оба | auth | Ссылки `{references}` |
| POST | `/api/v2/sessions/:id/references` | оба | auth | Добавить ссылку → 201 |
| DELETE | `/api/v2/sessions/:id/references/:refSid` | оба | auth | Удалить ссылку → 204 |
| POST | `/api/v2/sessions/:id/messages/merge` | оба | auth | Слить сообщения из другой сессии → 201 |
| GET | `/api/v2/sessions/:id/notes` | backend | auth | Sticky notes `{notes}` |
| POST | `/api/v2/sessions/:id/notes` | backend | auth | Создать заметку → 201 |
| PATCH | `/api/v2/sessions/:id/notes/:noteId` | backend | auth | Обновить заметку |
| DELETE | `/api/v2/sessions/:id/notes/:noteId` | backend | auth | Удалить заметку |

> `SessionSettings` MCP/скиллов (ADR-071 §2.4 / ADR-046): `mcpServers`/`mcpDisabledServers`, `skills`/`skillsDisabled` — session-overrides (один тумблер); `mcpDefaultOn`/`skillsDefaultOn` — **снапшот** дефолтов (`project.defaultOn`/системного дефолта) на момент создания сессии, задаётся системой, не перезаписывается сменой дефолта проекта; `undefined` — legacy-режим (см. scope-endpoint'ы §5.17.2).
> **Видимость `GET /api/v2/sessions` (ADR-089).** `ADMIN`/`LEAD` — **все** сессии; иначе — свои личные **плюс** сессии проектов, участником которых является пользователь (`owner` проекта или любой `members`, любая роль). Сессия **без владельца** видна (паритет с доступом по id). Личные сессии других пользователей не видны. `?project_id=` фильтрует поверх этой видимости. Доступ **по id** (`GET /:id/status|prompt|stats`, `POST /:id/prompt`, `GET /:id/messages` и т.п.) — владелец сессии **или** участник проекта сессии, а также `ADMIN`/`LEAD`; иначе `403 FORBIDDEN`. Хелпер — `server/session-visibility.ts` (`isSessionVisible`), скан — `FileStore.listForUserScope`.
> **Scope service-key (ADR-052):** `GET /` и `GET /:id` — `sessions:read`; `POST /` — `sessions:create`; `PATCH /:id`, `DELETE /:id`, `POST /:id/prompt` — `sessions:prompt`; `GET /:id/prompt|status|stats|messages` — `sessions:read`. При непустом `allowedProjects` проектная проекция проверяется по `project_id` сессии, иначе `403 PROJECT_FORBIDDEN`.
> **Надёжный «Стоп» — `POST /api/v2/sessions/:id/abort` (ADR-005).** Роут ставит **персистентный** флаг `SessionStatus.cancelRequested` (+ `cancelRequestedAt`) под локом сессии — поэтому отмена срабатывает и когда `currentStream`/cancel-token ещё не установлены (сессия в очереди, в backoff, между итерациями Tool Use), где прежний `orchestrator.cancel` был no-op. При живом стриме дополнительно вызывается graceful `orchestrator.cancel` (публикует `stream.cancelled`, сохраняет частичный ответ); затем `QueueProcessorManager.requestStop` прерывает backoff/активный LLM-вызов и завершает цикл (`_handleStopRequest`: очистка `pendingMessages`, снятие `blocked`/флага, `stream.cancelled` ровно один раз — без дубля graceful-ветки). Если обработчика нет, флаг снимается, чтобы следующий запуск не отменился ложно. Ответ — `{status:'aborted'}`; без сессии — 404. В сериализованной сессии (`GET /api/v2/sessions/:id`) поле `status` содержит `cancel_requested` (bool) и `cancel_requested_at` (ISO|null). Гибридная ветка (удалённая сессия) делегирует `remoteClient.abortSession`.

### 5.6 Messages — `/api/v2/messages`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| POST | `/api/v2/messages/:sessionId/batch` | оба | auth | `{action: pin\|toggle\|delete, indices[], state?}` |
| PATCH | `/api/v2/messages/:sessionId/:index/toggle` | оба | auth | Переключить `disabled` |
| PATCH | `/api/v2/messages/:sessionId/:index/pin` | оба | auth | Переключить `pinned` |
| DELETE | `/api/v2/messages/:sessionId/:index` | оба | auth | Удалить сообщение |
| POST | `/api/v2/messages/:sessionId/:index/retry` | оба | auth | Отключить с index и вернуть текст `{content}` |
| GET | `/api/v2/messages/:sessionId/:index/debug` | оба | auth | Отладочные данные сообщения |

### 5.7 Queue — `/api/v2/queue`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| POST | `/api/v2/queue/:sessionId/clear` | оба | auth | Очистить очередь `{cleared:true}` |
| POST | `/api/v2/queue/:sessionId/return` | оба | auth | Вернуть тексты `{texts}`; `?index=N` |
| POST | `/api/v2/queue/:sessionId/resume` | оба | auth | Возобновить обработку `{resumed, pending_count}` |
| POST | `/api/v2/queue/:sessionId/retry-now` | оба | auth | Немедленный повтор при backoff |
| POST | `/api/v2/queue/:sessionId/cancel-retry` | оба | auth | Отменить повторные попытки |

### 5.8 Projects — `/api/v2/projects`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/projects` | оба | auth (owner/член; LEAD/ADMIN — все) | Список проектов: свои/участие, `ADMIN`/`LEAD` — все |
| POST | `/api/v2/projects` | оба | auth | Создать `{name, workspace?, repos?, plan?}` → 201 |
| GET | `/api/v2/projects/:id` | оба | auth / owner·член·LEAD·ADMIN | Проект (read; VIEWER читает, не редактирует) |
| PUT | `/api/v2/projects/:id` | оба | auth / owner·EDITOR·LEAD·ADMIN | Обновить поля (name, description, current_task, invariants, icon, color, repos, plan); смена `workspace` — owner/LEAD/ADMIN |
| DELETE | `/api/v2/projects/:id` | оба | auth / owner·LEAD·ADMIN | Удалить → 204 |
| GET | `/api/v2/projects/:id/stats` | backend | auth | Агрегаты токенов/сообщений |
| GET | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Проектный MCP-скоуп (ADR-071 §2.4): `{enabled, defaultOn, knownServers}`; `enabled[]` — hard-gate (недоступно и в старых сессиях, в т.ч. для системных серверов), `defaultOn[]` — сид новых сессий |
| PUT | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Задать `{enabled?, defaultOn?}` (ссылки на реестр по имени) |
| POST | `/api/v2/projects/:id/publish` | core | auth | Локальный проект → сервер (гибрид) |
| POST | `/api/v2/projects/:id/fork-local` | core | auth | Серверный проект → локальный мир (гибрид) |

> `workspace` (ADR-075): при `POST`/`PUT` каталог создаётся (`mkdir -p`). Managed: пустой `workspace` → авто-имя
> `slugify(name)` + суффикс под `workspacesRoot`; абсолютный внутри root нормализуется в относительный; вне root →
> `403 WORKSPACE_OUTSIDE_ROOT_DENIED`; смена `workspace` — владелец/LEAD/ADMIN, иначе `403 FORBIDDEN`.
> RBAC (backend, D5): `PUT` контент (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `repos`, `plan`) — owner/EDITOR/LEAD/ADMIN; `workspace` — owner/LEAD/ADMIN; `DELETE` — owner/LEAD/ADMIN; иначе `403 FORBIDDEN`.
> **Видимость `GET /api/v2/projects` и `GET /api/v2/projects/:id` (ADR-089).** В списке `ADMIN`/`LEAD` видят **все** проекты, остальные — только свои (`owner` или `members`). Чтение проекта по id — `owner`, **любой участник** (`members`, любая роль, включая `VIEWER`), а также `ADMIN`/`LEAD`; иначе `403 FORBIDDEN`. Это **read-уровень**: он **не расширяет** права на изменение — `manage` (`workspace`/`DELETE`/MCP-скоуп) и `edit` контента остаются owner/EDITOR/LEAD/ADMIN, `VIEWER` читает, но не редактирует (см. `canRead` vs `canManage`/`canEditContent`).
> Tool-level RBAC (core-тулы чата, ADR-075/D5): `project_log_write`/`project_invariants_write` пишут только при owner/EDITOR (иначе `project.write_forbidden`); `plan_write` пока без гейта (TODO) — `project.plan` защищён HTTP-RBAC.
> В core ролевых проверок нет (любой аутентифицированный). Core/standalone:
> абсолютный вне root — `deny` → `403`, `confirm` без `confirmOutsideRoot` → `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`.
> Ошибка создания каталога → `422 WORKSPACE_CREATE_FAILED`.

### 5.9 Providers — `/api/v2/providers`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/providers` | оба | auth / auth | Список провайдеров |
| POST | `/api/v2/providers` | оба | ADMIN / auth | Создать/обновить |
| GET | `/api/v2/providers/:name` | оба | ADMIN / auth | Один (apiKey маскирован) |
| DELETE | `/api/v2/providers/:name` | оба | ADMIN / auth | Удалить |
| POST | `/api/v2/providers/:name/test` | оба | ADMIN / auth | Тест подключения |
| POST | `/api/v2/providers/fetch-icon` | backend | ADMIN | Favicon домена (сырой data-URL); UI сохраняет иконку уже сжатой (маленький PNG data-URL) |

### 5.10 Models — `/api/v2/models`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/models` | оба | auth / auth | Модели, сгруппированные по провайдеру |
| POST | `/api/v2/models` | оба | ADMIN / auth | Создать/обновить |
| POST | `/api/v2/models/fetch` | оба | ADMIN / auth | Синхронизировать с провайдерами |
| DELETE | `/api/v2/models/:id` | оба | ADMIN / auth | Удалить |

### 5.11 Agents — `/api/v2/agents`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/agents/all` | оба | ADMIN / auth | Все агенты (админка) |
| GET | `/api/v2/agents` | оба | auth / auth | Только primary-агенты |
| POST | `/api/v2/agents` | оба | ADMIN / auth | Создать/обновить |
| GET | `/api/v2/agents/:id` | backend | ADMIN | Агент + builtin/override |
| DELETE | `/api/v2/agents/:id` | оба | ADMIN / auth | Удалить custom / сбросить built-in |
| PATCH | `/api/v2/agents/:id/enabled` | backend | ADMIN | `{enabled}` |

### 5.12 Файлы — `/api/v2/fs`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/fs` | оба | auth | Список каталога; `?project_id=&path=&maxDepth=&includeHidden=` |
| GET | `/api/v2/fs/read` | оба | auth | Содержимое; `?project_id=&path=` |
| POST | `/api/v2/fs/write` | оба | auth | `{projectId, path, content}` |
| POST | `/api/v2/fs/upload` | оба | auth | multipart: `project_id`, `path`, `file` |
| GET | `/api/v2/fs/download` | оба | auth | Скачать; `?project_id=&path=` |
| DELETE | `/api/v2/fs` | оба | auth | Удалить файл/пустой каталог; `?project_id=&path=` |
| POST | `/api/v2/fs/mkdir` | оба | auth | `{projectId, path}` |
| POST | `/api/v2/fs/move` | оба | auth | `{projectId, sourcePath, targetPath, targetProjectId?}` |
| GET | `/api/v2/fs/workspace-root` | оба | auth | Подкаталоги корня workspace (ADR-075); `?includeHidden=` → `{root, entries}` |
| GET | `/api/v2/fs/workspace-root/browse` | оба | auth | Список внутри корня (ADR-075); `?path=&includeHidden=` → `{root, path, entries}` |
| POST | `/api/v2/fs/workspace-root/mkdir` | оба | auth | Создать каталог в корне (ADR-075); `{path, confirmOutsideRoot?}` → 201 `{created, path}` |

> `workspace-root*` (ADR-075): абсолютный путь внутри `workspacesRoot` работает; вне root — по политике.
> `confirm`: browse разрешён, mkdir требует `confirmOutsideRoot: true`, иначе `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`.
> `deny`: `403 WORKSPACE_OUTSIDE_ROOT_DENIED` (в т.ч. traversal `..`); protected-paths → `403 PROTECTED_PATH_DENIED`.
> `mkdir` существующего пути → `409 ALREADY_EXISTS`; несуществующий каталог browse → `404 NOT_FOUND`, не каталог → `400 NOT_A_DIRECTORY`.
> `move` с необязательным `targetProjectId`/`target_project_id` — межпроектный перенос (файл/каталог), локально между workspace; с удалённым (`remote:`) проектом в любой стороне → `400`; существующая цель → `409 ALREADY_EXISTS`, отсутствующий источник → `404 NOT_FOUND`.
> Единая (core) реализация: `FsError`-форма; backend монтирует core-фабрику с `deny` (managed) и обязательным `project_id`;
> standalone — политика из `settings/workspace-policy`, без `project_id` — плоский root, проект без workspace — fallback на root.

### 5.13 Context — `/api/v2/context` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/context/files` | ADMIN | Список; `?category=user\|role\|system` |
| GET | `/api/v2/context/files/:name` | ADMIN | Содержимое; `?category=` |
| POST | `/api/v2/context/files/:name` | ADMIN | Сохранить `{content, category}` или `{action:'toggle'}` |
| DELETE | `/api/v2/context/files/:name` | ADMIN | Удалить; `?category=` |
| POST | `/api/v2/context/files/:name/restore_to_default` | ADMIN | Восстановить системный; `?category=` |
| GET | `/api/v2/context/enabled` | ADMIN | `{enabled:[]}` |
| POST | `/api/v2/context/enabled` | ADMIN | `{files:[]}` |

### 5.13.1 Проектные инструкции — `/api/v2/context/instructions` (core+backend, ADR-069)

Read-only прозрачность загруженных проектных инструкций (`AGENTS.md` и совместимые).

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/context/instructions?session_id=<id>` | owner/ADMIN | Снимок для workspace проекта сессии; сессия без проекта → пустой результат, `diagnostics[].code='no-project'` |
| GET | `/api/v2/context/instructions?project_id=<id>` | owner/LEAD/ADMIN | Снимок для проекта |

Ответ: `{ session_id?\|project_id?, enabled, cap: { chars, source: 'dynamic'\|'override', contextWindow }, files: [{ path, kind, label?, url?, chars, truncated, status, scan? }], diagnostics: [{ level, code, message, path?, kind? }] }` — структура из резолвера
ADR-069 Ф2a (`engine/context/instructions.ts`); `status` — `loaded`/`truncated`/`blocked`/`dedup`/`skipped`/`untrusted`/`skipped-install-tree`/`excluded`/`fetch-error`. Без `session_id`/`project_id` → 400; неизвестный id → 404; чужой доступ → 403. Запись в хранилище не выполняется.

### 5.14 Users — `/api/v2/users` (backend, ADMIN или scope `users:read`)

Чтение списка/деталей доступно роли `ADMIN` **или** service-key со scope
`users:read` (машинное чтение профилей/идентичностей аддонами); мутации —
только `ADMIN`. `GET /:id` возвращает `identities` профиля (ADR-089,
snake_case: `provider`, `external_id`, `username?`, `display_name?`,
`linked_at`, `linked_by?`); список (`GET /`) идентичности **не** включает
(не раздувать выдачу — детали идут в `/:id`).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/users` | Список профилей (без `identities`) |
| GET | `/api/v2/users/:id` | Профиль (+ `identities`) |
| POST | `/api/v2/users` | Создать (ADMIN) |
| PUT | `/api/v2/users/:id` | Обновить (ADMIN) |
| DELETE | `/api/v2/users/:id` | Удалить (ADMIN) |

### 5.14.1 Идентичности текущего пользователя — `/api/v2/me/identities` (оба, ADR-089)

Внешние идентичности (напр. Telegram), привязанные к профилю (`ProfileData.identities[]`).
RBAC: аутентифицированный пользователь — только **свои** (core — пользователь `local`,
backend — id из AuthKit). Прямая линковка (`POST /identities` без кода) отсутствует —
привязка идёт только через **claim-flow** (`POST /identities/claim`): подтверждение
владения id одноразовым кодом, выданным ядром при приёме внешнего события от
неизвестного отправителя.

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| GET | `/api/v2/me/identities` | auth / auth | `{identities: ExternalIdentity[]}` текущего пользователя (`provider`/`externalId`/`username?`/`displayName?`/`linkedAt`/`linkedBy?`) |
| DELETE | `/api/v2/me/identities/:provider/:externalId` | auth / auth | Отвязать идентичность (только свою); `{identities}` или 404 `NOT_FOUND` |
| POST | `/api/v2/me/identities/claim` | auth / auth | Подтвердить владение идентичностью по одноразовому коду `{code}` → 201 `{identity}` |

**`POST /api/v2/me/identities/claim`** (claim-flow). Тело — `{code: string}`
(человековводимый код `XXX-XXX`, регистр/дефисы/пробелы нормализуются ядром).
`provider`/`externalId` **берутся из серверной записи claim**, а не из тела запроса —
подставить чужой id нельзя. При успехе создаётся `ExternalIdentity` с `linkedAt` = now
и `linkedBy` = id подтвердившего пользователя; код **одноразовый** (повторное
использование → 404) и истекает по TTL (по умолчанию 10 минут). Код создаётся ядром
автоматически при приёме события от неизвестного отправителя и доставляется шлюзом
**только в приватный чат** (в группе/канале не показывается — иначе код увидят все
участники; см. ADR-089). Ошибки:

| Код | Статус | Когда |
|---|---|---|
| `VALIDATION_ERROR` | 400 | пустой/отсутствующий код (или не-JSON тело) |
| `NOT_FOUND` | 404 | код неизвестен, истёк или уже использован (одноразовость) |
| `CONFLICT` | 409 | пара `provider`+`externalId` уже привязана к **другому** профилю |

Приём события (`POST /api/v2/events`, §5.26) возвращает в ответе **опциональное** поле
`identityHint?: { code: string, expiresAt: string }` — заполняется только когда отправитель
не сопознан с пользователем инстанса (`resolveExternalIdentity` → `null`) и у события задан
`identity.principalId`. Контракт `{event, decision, sessionId}` не изменяется.


### 5.15 Git — `/api/v2/git` (оба, ADR-076)

Реестр `project.repos` (несколько репозиториев на проект) и git-операции.
`init`/`clone` **регистрируют** запись в проекте; `repo_path`/`path` — относительны
`project.workspace` (containment; абсолютный/`..` → `git.repo_path_invalid`).
Ошибки — в shared-форме `{ error: { error, code } }`.

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| POST | `/api/v2/git/scan` | auth | `{projectId}` → `{repos}` (git-детект по workspace, до 3 уровней) |
| POST | `/api/v2/git/repos/init` | write / auth | `{projectId, path, defaultBranch?, name?, sshKeyId?}` → 201 `RepoStatus`; регистрирует запись |
| POST | `/api/v2/git/repos/clone` | write / auth | `{projectId, url, path?, branch?, name?, sshKeyId?}` → 201 `RepoStatus`; SSH-URL без ключа → 400 `git.ssh_key_required`; занятый путь → 409 `git.repo_exists` |
| POST | `/api/v2/git/repos/register` | write / auth | `{projectId, path, name?, url?, type?, defaultBranch?, sshKeyId?}` → 200 `GitRepoConfig` (upsert по `id`/`path`) |
| POST | `/api/v2/git/repos/remove` | write / auth | `{projectId, id?\|path?, deleteLocal?}` → `{removed, deletedLocal}` (удаление локального каталога — `deleteLocal`) |
| POST | `/api/v2/git/repos/fetch` | write / auth | `{projectId, id?\|path?}` → `{path, lastFetch}`; SSH-URL без ключа → 400 `git.ssh_key_required` |
| GET | `/api/v2/git/log` | auth | `?project_id=&repo_path=&max_count=` → `{commits}` |
| GET | `/api/v2/git/commit` | auth | `?project_id=&repo_path=&hash=` → `{commit}` |

RBAC backend: write-эндпоинты (`init`/`clone`/`register`/`remove`/`fetch`) — owner/EDITOR/LEAD/ADMIN (`canEditProjectContent`), иначе 403; read (`scan`/`log`/`commit`) — любой аутентифицированный. Core (standalone) — `requireAuth`.

### 5.15.1 SSH-ключи агентов — `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` (оба, ADR-076)

Ответы — только `SSHKeyMeta` (`id`/`name`/`type`/`agentIds`/`createdAt`/`updatedAt`);
`privateKey`/`passphrase` шифруются at-rest (AES-256-GCM) и **никогда** не отдаются.

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| GET | `/api/v2/ssh-keys` | auth | Все ключи; `?agentId=` — ключи агента |
| POST | `/api/v2/ssh-keys` | ADMIN / auth | Создать: `{name, type?, privateKey, passphrase?, agentIds?}` → 201 |
| GET | `/api/v2/ssh-keys/:id` | auth | Ключ по id |
| PATCH | `/api/v2/ssh-keys/:id` | ADMIN / auth | Частичное обновление (в т.ч. смена `privateKey`) |
| DELETE | `/api/v2/ssh-keys/:id` | ADMIN / auth | Удалить ключ целиком → 204 |
| GET | `/api/v2/agents/:agentId/ssh-keys` | auth | Ключи, привязанные к агенту |
| POST | `/api/v2/agents/:agentId/ssh-keys` | ADMIN / auth | Создать с привязкой к агенту (объединяет `agentIds`) → 201 |
| DELETE | `/api/v2/agents/:agentId/ssh-keys/:keyId` | ADMIN / auth | **Отвязать** ключ от агента (ключ не удаляется) |

Коды: `sshkey.not_found` (404), `sshkey.name_exists` (409), `sshkey.decrypt_failed` / `sshkey.encryption_unavailable` (500), `sshkey.env_failed` (400, через `VALIDATION_ERROR`), `VALIDATION_ERROR` (400). Ключи с `passphrase` **поддерживаются**: при git-операции `createSshEnv` готовит askpass (`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`), сбой подготовки → `sshkey.env_failed`. В гибриде nested `/api/v2/agents/:agentId/ssh-keys[/:keyId]` проксируется core на backend (`REMOTE_PROXY_PATTERNS`), как flat `/ssh-keys` и `/git`; прочие подпути `/api/v2/agents` остаются локальными. Мастер-ключ — `SYNTH_SECRET_KEY`/`security.secretKey`/`{dataDir}/secrets/master.key`; ротация — CLI `synth secrets rotate` (не HTTP API).

### 5.16 MCP — `/api/v2/mcp`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/mcp/servers` | backend | auth | Настроенные серверы + `connected` |
| POST | `/api/v2/mcp/servers` | backend | ADMIN | `{name, config}` → 201 |
| GET | `/api/v2/mcp/servers/:name` | backend | auth | Конфиг сервера |
| PUT | `/api/v2/mcp/servers/:name` | backend | ADMIN или scope `addons:install` | Обновить конфиг |
| DELETE | `/api/v2/mcp/servers/:name` | backend | ADMIN или scope `addons:install` | Удалить |
| POST | `/api/v2/mcp/servers/:name/test` | backend | ADMIN или scope `addons:install` | Проверить подключение (+опц. `config`) |
| GET | `/api/v2/mcp/servers/:name/tools` | backend | auth | Инструменты сервера (probe при необходимости) |
| GET | `/api/v2/mcp/session/:sessionId` | backend | auth | Legacy: `{mcpServers, mcpDisabledServers, allServers}` (канонический — `/sessions/:id/mcp`) |
| PUT | `/api/v2/mcp/session/:sessionId` | backend | auth | Legacy: `{mcpServers?, mcpDisabledServers?}` (совместим с `/sessions/:id/mcp`) |
| POST | `/api/v2/mcp/probe` | оба | auth | `{name}` → `{name, tools}`, `MCP_CONNECT_ERROR` |
| GET | `/api/v2/mcp/registry` | backend | auth | Единый реестр MCP-серверов (ADR-071 §2.5): `{entries}`; запись несёт `enabled` (мастер hard-gate, дефолт `true`) и `enabledByDefault` (дефолт для НОВЫХ проектов) |
| POST | `/api/v2/mcp/registry` | backend | auth (stdio — только ADMIN; service-key — scope `addons:install`) | Добавить запись: `{name, config, enabled?, enabledByDefault?, origin?}` → 201; stdio — только ADMIN (scope не ослабляет); HTTP — любой; service-key без scope `addons:install` → 403 `SCOPE_REQUIRED`. **instance**-origin (`origin:'instance'` или installer-ключ со scope) доступен ADMIN **или** service-key со scope `addons:install`; интерактив без ADMIN создаёт `user`-запись даже с `origin:'instance'` |
| PUT | `/api/v2/mcp/registry/:id` | backend | автор/ADMIN или scope `addons:install` | Обновить запись (`enabled` — мастер-флаг реестра); installer-ключ со scope обновляет instance-записи (scope-ветка переживает ротацию ключа) |
| DELETE | `/api/v2/mcp/registry/:id` | backend | автор/ADMIN | Удалить запись |

> Резолвинг MCP per-item (ADR-071 §2.4): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; дефолт — opt-in (off). Мастер `enabled` (реестр) и проектный `enabled` — live hard-gate (в т.ч. старые сессии и системные серверы), `enabledByDefault`/`project.defaultOn` — snapshot (`mcpDefaultOn`). Причины: `system_disabled\|project_disabled\|session_optout\|not_default`. `McpServerConfig.enabled` — только сид записи реестра (`seedFromConfig`), в резолвинге не участвует. Отсутствие `project.mcp` — гейт не задан (legacy).

### 5.17 Skills — `/api/v2/skills` (оба, ADR-046 Фаза 1)

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/skills` | оба | auth | Реестр скиллов: `{skills, workspace?, diagnostics?}`; `?project_id=` — project-скоуп, `?diagnostics=1` — диагностика discovery/валидации |
| POST | `/api/v2/skills` | оба | backend ADMIN или scope `addons:install` / core auth | Создать instance-скилл: `{name, description, body?, files?}` → 201 (409 при дубле) |
| GET | `/api/v2/skills/:name` | оба | auth | Деталь: мета, тело (недоверенного — пустое), supporting-файлы |
| PATCH | `/api/v2/skills/:name` | оба | backend ADMIN или scope `addons:install` / core auth | Обновить instance-скилл: `{description?, body?, metadata?}` |
| DELETE | `/api/v2/skills/:name` | оба | backend ADMIN или scope `addons:install` / core auth | Удалить instance-скилл |
| GET | `/api/v2/skills/:name/files` | оба | auth | Список supporting-файлов `{files}` |
| GET | `/api/v2/skills/:name/files/*` | оба | auth | Чтение supporting-файла `{path, content}` |
| PUT | `/api/v2/skills/:name/files/*` | оба | backend ADMIN или scope `addons:install` / core auth | Запись supporting-файла `{content}` |
| DELETE | `/api/v2/skills/:name/files/*` | оба | backend ADMIN или scope `addons:install` / core auth | Удаление supporting-файла |
| POST | `/api/v2/skills/reload` | оба | backend ADMIN или scope `addons:install` / core auth | Принудительный ре-скан реестра (ленивая инвалидация по mtime) |

Источники discovery (приоритет, first-wins): `{project.workspace}/.synth/skills` (project, project-trust гейт), `{dataDir}/skills` (instance), `config.skills.paths`, внешние read-only каталоги (`.opencode/skills|skill`, `.claude/skills`, `.agents/skills`, `~/.config/opencode/skills`) и `config.skills.urls` (read-only индексация в `{dataDir}/skills-cache`, `trusted:false`). Проигравшие дубли — `shadowed`-диагностика; кэш инвалидируется лениво по mtime/size.

### 5.17.1 Команды и bundles — `/api/v2/commands`, `/api/v2/skill-bundles` (оба, ADR-046 Фаза 2)

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/commands` | оба | auth | Список команд (builtin + шаблонные `.md` + скиллы invocation user/both + bundles). `?project_id=` — project-скоуп, `?diagnostics=1` — `shadowed`/ошибки |
| GET | `/api/v2/skill-bundles` | оба | auth | `{bundles}` — YAML-группы скиллов |
| POST | `/api/v2/skill-bundles` | оба | backend ADMIN / core auth | Создать bundle `{name, description, skills[], instruction?}` → 201 (409 при дубле; 400 при ссылке на несуществующий скилл) |
| GET | `/api/v2/skill-bundles/:name` | оба | auth | Деталь bundle |
| PATCH | `/api/v2/skill-bundles/:name` | оба | backend ADMIN / core auth | Обновить bundle |
| DELETE | `/api/v2/skill-bundles/:name` | оба | backend ADMIN / core auth | Удалить bundle |

Резолвинг `/`-команд выполняется **в core** (единообразно для UI/CLI/гибрида, ADR-046): builtin-ответы (`/help`, `/skills`, `/commands`) не вызывают LLM, а события `command.invoked`/`skill.invoked` уходят в шину. Порядок имён зависит от `commands.conflict.mode`.

### 5.17.2 Scope скиллов — `/api/v2/sessions|projects|settings/skills` (оба, ADR-046)

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/sessions/:id/skills` | оба | owner/ADMIN | Эффективный скоуп сессии: `{skills:[{name, level, scope, trusted, available, unavailableReason?, enabled, disabled, disabledReason?}], enabled, disabled}`; `disabledReason` ∈ `system\|project\|session` |
| GET | `/api/v2/sessions/:id/skills/effective` | оба | owner/ADMIN | Алиас effective-списка |
| PUT | `/api/v2/sessions/:id/skills` | оба | owner | Один тумблер: `{name, enabled}` (точечный toggle) или `{skills?, skillsDisabled?}` |
| GET | `/api/v2/projects/:id/skills` | оба | owner/LEAD/ADMIN | Проектный скоуп: `{enabled, defaultOn, skills}`; `enabled[]` — hard-gate (в т.ч. старые сессии), `defaultOn[]` — сид новых сессий |
| PUT | `/api/v2/projects/:id/skills` | оба | backend ADMIN / core auth | Задать `{enabled?, defaultOn?}` |
| GET | `/api/v2/settings/skills` | оба | auth | Instance-wide: `{disabled:{categories,groups,skills}, disabledForNewProjects:{categories,groups,skills}, policy}`; `disabled` — мастер hard-gate, `disabledForNewProjects` — сид новых проектов |
| PUT | `/api/v2/settings/skills` | оба | backend ADMIN / core auth | Задать `{disabled?, disabledForNewProjects?, policy?}` (union групп/имён, семантика `tools.disabled`) |
| DELETE | `/api/v2/settings/skills` | оба | backend ADMIN / core auth | Сбросить instance-wide `disabled`/`disabledForNewProjects`/`policy` |

> Резолвинг скиллов per-item (ADR-046): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; дефолт — opt-in (off). Системное/проектное отключение — live hard-gate (в т.ч. старые сессии), дефолты — snapshot (`skillsDefaultOn`). Отсутствие `project.skills` — гейт не задан (legacy).

### 5.18 Audit — `/api/v2/audit` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/audit` | ADMIN/AUDITOR | Аудит Gateway; `?userId=&sessionId=&since=&until=&limit=` (≤500) |
| POST | `/api/v2/audit/revealed` | auth | `{sessionId, placeholder}` → `{ok:true}` |

### 5.19 Logs — `/api/v2/logs` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/logs/llm` | ADMIN/AUDITOR | Payload-лог LLM; `?sessionId=&limit=` (≤500) |
| GET | `/api/v2/logs/:name` | ADMIN/AUDITOR | Хвост `core\|ui\|backend`; `?tail=` (1..2000), `?search=` |

### 5.20 Gateway patterns — `/api/v2/gateway` (backend, ADMIN)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/gateway/patterns` | Паттерны секретов + признак override |
| PUT | `/api/v2/gateway/patterns` | Сохранить override |
| DELETE | `/api/v2/gateway/patterns` | Сброс к дефолту |

### 5.21 Settings — `/api/v2/settings` (оба)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/settings/workspace` | auth | Рабочий каталог по умолчанию: `{workspace, isOverridden, defaults}` (`defaults` — env/config) |
| PUT | `/api/v2/settings/workspace` | auth | `{workspace}` |
| DELETE | `/api/v2/settings/workspace` | auth | Сброс runtime-override к дефолту; `{status:"restored", workspace, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/workspace-policy` | auth | Политика абсолютного workspace вне `workspacesRoot` (ADR-075): `{outsideRoot:"confirm"\|"deny", isOverridden, defaults, readOnly?}` (managed — `readOnly:true`, эффективно `deny`) |
| PUT | `/api/v2/settings/workspace-policy` | auth | `{outsideRoot}` (live-применение, persist); невалидное значение → `400`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| DELETE | `/api/v2/settings/workspace-policy` | auth | Сброс к config/env-дефолту; `{status:"restored", outsideRoot, isOverridden:false, defaults}`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| GET | `/api/v2/settings/mcp` | auth | Доступность MCP по режимам: `{servers, isOverridden, defaults:{}}` |
| PUT | `/api/v2/settings/mcp` | auth | `{servers}` |
| DELETE | `/api/v2/settings/mcp` | auth | Сброс runtime-доступности MCP; `{status:"restored", servers:{}, isOverridden:false, defaults:{}}` |
| GET | `/api/v2/settings/default-agent` | auth | Агент по умолчанию (админка «Агенты»): `{defaultAgent, isOverridden, defaults}` (runtime из `settings.json`, иначе `DEFAULT_AGENT_ID` — `assistant` при первом развёртывании); используется при создании сессии без `settings.agentRole` и как `default_agent` в `/agents` |
| PUT | `/api/v2/settings/default-agent` | auth | `{defaultAgent}` — id агента (`^[a-z0-9_-]+$`), persist; невалидный/пустой → 400 |
| DELETE | `/api/v2/settings/default-agent` | auth | Сброс к дефолту; `{status:"restored", defaultAgent, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/tools-policy` | auth | Политика включения **встроенных** инструментов (ADR-071 §2.3): `{toolsPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime из `settings.json`, иначе `tools.policy` из config.yaml; дефолт `auto`) |
| PUT | `/api/v2/settings/tools-policy` | auth | `{toolsPolicy}` (live-применение, persist); неизвестное значение → 400 |
| DELETE | `/api/v2/settings/tools-policy` | auth | Сброс к config-дефолту; `{status:"restored", toolsPolicy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/mcp-policy` | auth | Политика включения **MCP**-инструментов (ADR-071 §2.3): `{mcpPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime из `settings.json`, иначе `mcp.policy` из config.yaml; дефолт `auto`) |
| PUT | `/api/v2/settings/mcp-policy` | auth | `{mcpPolicy}` (live-применение, persist); независима от `tools-policy`; неизвестное значение → 400 |
| DELETE | `/api/v2/settings/mcp-policy` | auth | Сброс к config-дефолту; `{status:"restored", mcpPolicy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/mcp-network-policy` | auth | Политика сетевого доступа пользовательских HTTP MCP (ADR-071 §2.3.1): `{policy, isOverridden, defaults}` (дефолт — deny приватных диапазонов) |
| PUT | `/api/v2/settings/mcp-network-policy` | auth | `{policy:{mode:"allow"\|"deny",list:string[]}}` (live-применение, persist) |
| DELETE | `/api/v2/settings/mcp-network-policy` | auth | Сброс к config-дефолту; `{status:"restored", policy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/tools-disabled` | auth | Отключение встроенных инструментов (ADR-071 §2.6): `{toolsDisabled:{capabilities,tools}, isOverridden, defaults}` (runtime-значение из `settings.json`, иначе `tools.disabled` из config.yaml) |
| PUT | `/api/v2/settings/tools-disabled` | auth | `{toolsDisabled:{capabilities:string[],tools:string[]}}` (live-применение, persist); неизвестная capability → 400, `runtime`-тулы неотключаемы. UI-раздел — ADMIN-категория |
| DELETE | `/api/v2/settings/tools-disabled` | auth | Сброс к config-дефолту (по умолчанию пусто); `{status:"restored", toolsDisabled, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/llm-gateway` | auth | Эффективные настройки LLM Gateway: `{llmGateway:{enabled,inputMode,logPayloads,rateLimit}, isOverridden, defaults}` (runtime поверх config.yaml) |
| PUT | `/api/v2/settings/llm-gateway` | auth | `{llmGateway}` (live-применение) |
| DELETE | `/api/v2/settings/llm-gateway` | auth | Сброс к config-дефолту; `{status:"restored", llmGateway, isOverridden:false, defaults}` + live-применение `{}` (шлюз из config.yaml) |
| GET | `/api/v2/settings/security` | auth | Эффективное `{protectedPaths, askTimeoutMs}` + `{isOverridden, defaults}` (runtime поверх config.yaml) |
| PUT | `/api/v2/settings/security` | auth | `{security}` (live-применение) |
| DELETE | `/api/v2/settings/security` | auth | Сброс к config-дефолту; `{status:"restored", security, isOverridden:false, defaults}` + live-применение `{}` |
| GET | `/api/v2/settings/protected-paths` | auth | `{policy, base, is_overridden}` |
| PUT | `/api/v2/settings/protected-paths` | auth | `{policy}` или `{version, add, remove}` |
| DELETE | `/api/v2/settings/protected-paths` | auth | Сброс к системной политике |
| GET | `/api/v2/settings/events` | auth | Runtime-настройки раздела «События» (ADR-089): `{events:{enabled, defaultMode, ephemeralTtl, journalRetentionDays, allowedSources, unknownAgentTemplate, keyRateLimitPerMinute, decisionRouting, autoBind, autoBindAgentTemplate}, defaults, isOverridden}` (runtime из `settings.json` поверх config.yaml `events`) |
| PUT | `/api/v2/settings/events` | ADMIN (managed) / auth (core) | Патч `{events:{…}}` (live-применение: Router/funnel/pruner переконфигурируются); невалидное значение → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/events` | ADMIN (managed) / auth (core) | Сброс runtime-настроек к config-дефолту; `{status:"restored", events, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/decision` | auth | Runtime-настройки decision-слоя (ADR-084): `{decision:{enabled, provider, model, confidenceThreshold, escalationProvider, escalationModel}, defaults, isOverridden}` (runtime из `settings.json` поверх config.yaml `decision`); `escalationProvider`/`escalationModel` — необязательный точный тир `primary → escalation` (пусто — без эскалации) |
| PUT | `/api/v2/settings/decision` | ADMIN (managed) / auth (core) | Патч `{decision:{…}}` (live-применение: микро-каскад/роутер/маршрутизация событий переконфигурируются); невалидное значение → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/decision` | ADMIN (managed) / auth (core) | Сброс runtime-настроек к config-дефолту; `{status:"restored", decision, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/decision/metrics` | auth | Агрегатные in-memory метрики decision-слоя (ADR-084) → `{metrics, ts}`. Форма `metrics`: `{calls, handled, fallback, escalated, attempts:{primary, escalation}, rejected:{ok, low_confidence, invalid, no_answer, no_provider, error}, by_model:{"<provider>/<model>":{calls, handled, latency_ms_avg, latency_ms_max}}}`; сбрасываются при рестарте |
| DELETE | `/api/v2/settings/decision/metrics` | ADMIN (managed) / auth (core) | Сброс накопителей метрик decision-слоя → `{metrics}` (обнулённый снимок) |

### 5.22 Dictionaries — `/api/v2/dictionaries` (оба)

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| GET | `/api/v2/dictionaries` | auth / auth | Список словарей |
| GET | `/api/v2/dictionaries/:category/:lang` | auth / auth | Словарь |
| PUT | `/api/v2/dictionaries/:category/:lang` | ADMIN / auth | Сохранить |
| DELETE | `/api/v2/dictionaries/:category/:lang` | ADMIN / auth | Удалить |

### 5.23 LLM — `/api/v2/llm` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| POST | `/api/v2/llm/chat/completions` | auth + rate limit | LLM Proxy (см. §4) |

### 5.24 Updates — `/api/v2/updates` (core)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/updates/check` | auth | Проверка новой версии |
| POST | `/api/v2/updates/apply` | auth | SSE-стрим `npm i -g @itphx/synth@latest` |

### 5.25 Admin/debug — `/api/v2/admin/debug` (backend, ADMIN)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/admin/debug/config` | Группы логирования + уровни |
| POST | `/api/v2/admin/debug/config` | `{groups}` → `{status:'saved'}`; merge — сохраняются только переданные группы, остальные overrides не сбрасываются |

### 5.26 Events — `оба`

Real-time — SSE `GET /api/v2/events` и WS `/ws/events` (см. §3). Приём внешних
событий, управление привязками и правилами маршрутизации (ADR-089; единая фабрика
`createEventRoutes` для core и backend):

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/events` | оба | auth | Глобальный SSE-поток `BusEvent` (фоллбек WS) |
| WS | `/ws/events` | оба | auth | Основной real-time-канал (см. §3) |
| POST | `/api/v2/events` | оба | auth/ключ + rate limit | Приём нормализованного внешнего события. Обычный путь: `Authorization: Bearer <пользовательский ключ>` → тело `{source, type, payload?, identity?, dedupKey?, ts?}` (`eventIngestSchema`). Путь по API-ключу привязки: `Authorization: Bearer synth_evt_…` — **без пользовательских кред**, `source` опционален (`eventKeyIngestSchema`; source/чат/тред берутся из привязки; конфликт `source` → 400), событие форсированно маршрутизируется в привязку. Ответ в обоих случаях → `201 {event, decision, sessionId}` + **опциональное** `identityHint?: {code, expiresAt}` (ADR-089 claim-flow: одноразовый код подтверждения владения идентичностью; заполняется только когда отправитель не сопознан — `resolveExternalIdentity` → `null` — и задан `identity.principalId`); `sessionId` — id сессии или `null` при `drop`; при decision-маршрутизации (`events.decisionRouting`) `decision` несёт `confidence` и диагностические `signals`, напр. `agent:<id>`/`model:<p/m>`/`latency:<ms>ms`); неверный/отозванный/истёкший ключ → 401 `UNAUTHORIZED`; невалидное тело → 400 `VALIDATION_ERROR`, сбой материализации → 500 `INTERNAL_ERROR` (решение всё равно пишется в журнал). Rate limit (managed — 120/мин) применяется к обоим путям до выбора способа аутентификации; per-key лимит (лимит ключа либо глобальный `events.keyRateLimitPerMinute`) → 429 `RATE_LIMITED`; мастер-выключатель `events.enabled: false` → 503 `UNAVAILABLE`. Использование ключа пишется в журнал (`keyId`/`principalId`) |
| GET | `/api/v2/events/bindings` | оба | auth | Список привязок `{bindings}` |
| POST | `/api/v2/events/bindings` | оба | LEAD/ADMIN | Upsert привязки по `source`+`chatKey`/`threadKey` (`eventBindingInputSchema`): `{source, chatKey?, threadKey?, sessionId?, mode: bound\|ephemeral\|queue, agentTemplate?, project?}`; совпавшая по ключу запись заменяется (id сохраняется) → 200, иначе 201 |
| DELETE | `/api/v2/events/bindings/:id` | оба | LEAD/ADMIN | Удалить привязку → 204 (каскадно удаляются её API-ключи); нет записи → 404 `NOT_FOUND` |
| GET | `/api/v2/events/bindings/:id/keys` | оба | LEAD/ADMIN | Список API-ключей привязки `{keys}` — только метаданные (`EventBindingApiKey[]`, без секрета и хеша; `label`, `description?`, `expiresAt?`, `rateLimitPerMinute?`, `revokedAt?`, `prefix`, `lastUsedAt`) |
| POST | `/api/v2/events/bindings/:id/keys` | оба | LEAD/ADMIN | Создать API-ключ (`eventBindingApiKeyCreateSchema`): `{label, description?, expiresAt?, rateLimitPerMinute?}` (`label` обязательна, уникальна глобально по инстансу регистронезависимо) → 201 `EventBindingApiKeyCreated` = метаданные + `key` (plaintext `synth_evt_<base64url>`, показывается **единственный раз**); нет привязки → 404 `NOT_FOUND`; дубль метки → 409 `CONFLICT`; невалидное тело → 400 `VALIDATION_ERROR` |
| PATCH | `/api/v2/events/bindings/:id/keys/:keyId` | оба | LEAD/ADMIN | Обновить метаданные ключа (`eventBindingApiKeyUpdateSchema`): `{label?, description?, expiresAt?, rateLimitPerMinute?}`; `null` — сброс поля, `undefined` — не трогать; смена метки проверяется на уникальность → 200 `EventBindingApiKey`; нет ключа → 404 `NOT_FOUND`; дубль метки → 409 `CONFLICT` |
| POST | `/api/v2/events/bindings/:id/keys/:keyId/revoke` | оба | LEAD/ADMIN | Мягкий отзыв ключа (проставляет `revokedAt`; идемпотентно) → 200 `EventBindingApiKey`; нет ключа → 404 `NOT_FOUND`. Отозванный ключ перестаёт резолвиться (`resolveBySecret` → `null`) |
| DELETE | `/api/v2/events/bindings/:id/keys/:keyId` | оба | LEAD/ADMIN | Удалить API-ключ → 204; нет записи → 404 `NOT_FOUND` |
| GET | `/api/v2/events/routes` | оба | auth | Список правил маршрутизации `{rules}` (`EventRouteRule[]`) |
| POST | `/api/v2/events/routes` | оба | LEAD/ADMIN | Upsert правила (`eventRouteRuleUpsertSchema`): `{id?, name?, priority?, enabled?, match, target}`; `match` — AND по заполненным `source`/`type`/`chatKey`/`threadKey`/`principalId`/`label`/`keywords` (пустой-невалидный не матчит); `target` — `bound`/`queue` (`sessionId`), `ephemeral` (`agentTemplate?`/`project?`/`ttl?`) или `bind` (ADR-089 auto-bind: `agentTemplate?`/`project?` — закрепить чат/тред за новой сессией). По `id` — обновление → 200, иначе создание → 201. Валидация: `bound`/`queue` с несуществующей сессией → 400, непустой `agentTemplate` без enabled-агента → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/events/routes/:id` | оба | LEAD/ADMIN | Удалить правило → 204; нет записи → 404 `NOT_FOUND` |
| GET | `/api/v2/events/journal` | оба | auth | Последние записи журнала решений `{entries}`; `?limit=` (default 50, cap 500) |

`identity` — `{principalId?, chatKey?, threadKey?, roles?}`. `dedupKey`/`ts` опциональны:
`EventIngress` нормализует событие (id `evt_<uuid>`, дефолтный dedup-ключ по
source/type/ключу/payload). RBAC managed: приём — API-ключ привязки либо `requireAuth` +
rate limit (120/мин); мутации привязок/правил/ключей — `requirePermission('ADMIN','LEAD')`,
чтение ключей привязки — LEAD/ADMIN, остальное чтение — `requireAuth`; в core — единый `requireAuth`.
**Scope service-key (ADR-052):** `POST /` — `events:ingest`; `GET /` (SSE) и `GET /journal` —
`events:watch`; список/мутации привязок — `bindings:read`/`bindings:write`; ключи привязок —
`keys:read`/`keys:write`; правила — `routes:read`/`routes:write`. Если у ключа задан
`allowedProjects`, проектная проекция применяется к правилам/привязкам с проектным измерением
(иначе `403 PROJECT_FORBIDDEN`). Привязки/ключи приёма по binding-key (`synth_evt_…`) — отдельная
модель (не service-key).
Per-key rate limit (`KeyRateLimiter`, окно 60 c) — лимит ключа `rateLimitPerMinute`, иначе
глобальный `events.keyRateLimitPerMinute` (0 — без лимита) → 429 `RATE_LIMITED`; мастер-выключатель
`events.enabled: false` → 503 `UNAVAILABLE`. Runtime-настройки — `GET/PUT/DELETE /api/v2/settings/events` (§5.21).
API-ключи привязок (`EventBindingApiKey`, `{dataDir}/events/api-keys.json`, ADR-089/ADR-052):
несколько ключей на привязку, секрет хранится только как sha256-хеш, наружу отдаётся один раз
при создании; обязательная уникальная (глобально по инстансу) `label`, `description?`,
`expiresAt?`/`revokedAt?` (срок/мягкий отзыв), `rateLimitPerMinute?` (лимит/мин, иначе глобальный
дефолт `events.keyRateLimitPerMinute`, `0` — без лимита). Ключи — инстанс-локальные секреты,
не переносятся publish/fork (ADR-042/PROP-081).
Правила маршрутизации (`EventRouteRule`, `{dataDir}/events/routes.json`) применяет `ProjectRuleProvider`
после явного `EventBinding` и cron-правила; фоллбек Router без маршрута задаёт `events.autoBind`
(при `true` и наличии `identity.chatKey|threadKey` — закрепить событие за новой сессией,
решение `{kind:'bind'}`, сигнал `auto-bind`), иначе `events.defaultMode`
(`bound` — `drop no_route`, `ephemeral` — временная сессия). При `events.decisionRouting` после
декларативных правил срабатывает `DecisionRuleProvider` (ADR-084): успешное решение несёт
`confidence` и `signals` (`decision-rules`, `agent:<id>`, `model:<p/m>`, `latency:<ms>ms`) — они
попадают в `decision` ответа и запись журнала `GET /api/v2/events/journal`.
Цепочка обработки и журнал — `docs/ARCHITECTURE.md` («Внешние события и хуки»), ADR-089.

> `POST /api/v2/sessions` теперь идёт через единый funnel `RequestSessionService`
> (`engine/events/request-session.ts`, ADR-089): эмит `session_requested` + создание
> сессии. Внешний контракт эндпоинта не изменился.

### 5.27 Schedules — `/api/v2/schedules` (оба, ADR-051 срез / ADR-089)

CRUD расписаний планировщика (единая фабрика `createSchedulerRoutes` для core и
backend). Срабатывание не создаёт сессию
само: сервис публикует нормализованное событие `source: 'cron'`,
`type: 'schedule_fired'` через `EventIngress`, а маршрутизацию выполняет
`SchedulerRuleProvider` (`RouteRuleProvider`). RBAC managed (backend): чтение
(`GET`) — `requireAuth`; мутации (`POST`/`PUT`/`DELETE`) и принудительный запуск
(`POST /:id/run`) — только ADMIN (`writeGuard = requireAdmin`); `run` дополнительно
под rate limit 10/60 c (`runMiddleware`). В core (standalone) — единый `requireAuth`
на все методы. **Scope service-key (ADR-052):** `schedules:read` (чтение и `GET /:id/jobs`),
`schedules:write` (`POST`/`PUT`/`DELETE`/`POST /:id/run`); проектная проекция — по цели
расписания (`bound`/`queue` → проект сессии, `ephemeral` → `project`).

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/schedules` | оба | requireAuth | Список расписаний `{schedules}` |
| POST | `/api/v2/schedules` | оба | ADMIN | Создание (`scheduleInputSchema`): `{name, enabled?, cron?, every?, target, prompt?, payload?, ownerId?}`; ровно одно из `cron`/`every`; невалидно → 400 `VALIDATION_ERROR`; → 201 `{schedule}` |
| PUT | `/api/v2/schedules/:id` | оба | ADMIN | Обновление (полное тело как POST) → 200 `{schedule}`; нет записи → 404 `NOT_FOUND` |
| DELETE | `/api/v2/schedules/:id` | оба | ADMIN | Удаление → 204; нет записи → 404 |
| POST | `/api/v2/schedules/:id/run` | оба | ADMIN | Принудительный запуск (force, ingest события с уникальным dedup-ключом; managed — rate limit 10/60 c) → 200 `{schedule}`; нет записи → 404 |
| GET | `/api/v2/schedules/:id/jobs` | оба | requireAuth | История срабатываний `{jobs}` (`ScheduleJob[]`, ADR-051); `?limit=` (дефолт 20, max 200); нет расписания → 404; без `JobStore` → `{jobs:[]}` |

`ScheduleJob` (`types/schedules.ts`): `trigger` (`cron`/`manual`/`catchup`),
`status` (`ok`/`error`/`skipped`), `startedAt`/`finishedAt`/`durationMs`, `target`,
`decision`/`reason` (маршрутизация: `drop no_route`, `busy`, `missed`),
`sessionId`, `error`.

`target` — дискриминированный союз: `{mode:'bound', sessionId}` |
`{mode:'ephemeral', agentTemplate?, project?, ttl?}` | `{mode:'queue', sessionId}`.
`cron` — 5 полей (UTC), `every` — `30s | 15m | 1h | 24h`. `nextRunAt` вычисляется
сервисом; `catchUp` (`skip`/`once`, дефолт `scheduler.catchUp`) управляет поведением
при пропущенном на старте срабатывании, Job-история — `GET /:id/jobs`.

### 5.28 Service keys — `/api/v2/service-keys` (оба, ADR-052 этап I)

Реестр **service-key** — независимых от binding-key (ADR-089) scoped-ключей инстанса
для внешних сервисов (мессенджер-шлюзы и т.п.). Единая фабрика `createServiceKeyRoutes`
для core и backend; store — `{dataDir}/service-keys.json` (ADR-005, атомарная запись).
Секрет `synth_svc_<base64url>` отдаётся **единственный раз** при создании; at-rest — только
sha256-хеш, в списке — `prefix`. RBAC: managed (backend) — только `ADMIN`; core (standalone) —
единый `requireAuth`.

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/service-keys` | оба | ADMIN / auth | Список `{keys}` — метаданные без секрета и хеша |
| GET | `/api/v2/service-keys/scopes` | оба | ADMIN / auth | Каталог для форм: `{scopes, families, roles}` — точечные scopes (`SERVICE_SCOPES`), wildcard-семейства (`SERVICE_SCOPE_FAMILIES`) и роли (`GlobalRole`); тот же guard, что у `GET /`. Клиенты строят опции из ответа (не компилируют каталог в бандл); тот же guard, порядок объявления — до `/:id` |
| POST | `/api/v2/service-keys` | оба | ADMIN / auth | Создать (`serviceApiKeyCreateSchema`): `{label, description?, roles?, scopes, allowedProjects?, rateLimitPerMinute?, expiresAt?}` → 201 `ServiceApiKeyCreated` = метаданные + `key` (plaintext `synth_svc_<base64url>`, показывается **один раз**); дубль метки → 409 `CONFLICT`; невалидное тело/скоуп/роль → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/service-keys/:id` | оба | ADMIN / auth | Метаданные ключа (`ServiceApiKey`); нет ключа → 404 `NOT_FOUND` |
| PATCH | `/api/v2/service-keys/:id` | оба | ADMIN / auth | Обновить (`serviceApiKeyUpdateSchema`): `{label?, description?, roles?, scopes?, allowedProjects?, rateLimitPerMinute?, expiresAt?}`; `null` — сброс поля, `undefined` — не трогать; смена метки проверяется на уникальность → 200; дубль → 409 `CONFLICT` |
| DELETE | `/api/v2/service-keys/:id` | оба | ADMIN / auth | Удалить ключ → 204; нет записи → 404 `NOT_FOUND` |
| POST | `/api/v2/service-keys/:id/revoke` | оба | ADMIN / auth | Мягкий отзыв (проставляет `revokedAt`, идемпотентно) → 200 метаданные; после — ключ не аутентифицирует; нет ключа → 404 `NOT_FOUND` |

**Поля ключа** (`ServiceApiKey`, `@itphx/synth-shared`): `id` (`svk_<uuid>`),
`label` (обязательна; уникальна глобально по инстансу, регистронезависимо),
`description?`, `roles: GlobalRole[]` (роли синтетического пользователя; пусто — дефолт `USER`),
`scopes: string[]` (каталог + wildcard-семейства, см. §1), `allowedProjects?: string[]`
(проектная проекция), `rateLimitPerMinute?` (лимит запросов/мин ключа; 0/не задано — без лимита;
в managed enforced глобальным middleware `KeyRateLimiter` → 429 `RATE_LIMITED`),
`expiresAt?`/`revokedAt?` (срок/мягкий отзыв), `createdBy`/`createdAt`/`lastUsedAt?`, `prefix`.
Ключи — **инстанс-локальные** секреты (не переносятся publish/fork, ADR-042/PROP-081).

**Аутентификация.** `Authorization: Bearer synth_svc_…` → синтетический пользователь
`{ id: 'service:<keyId>', roles: key.roles }`; контекст `{ scopes, allowedProjects?, rateLimitPerMinute? }`
кладётся в `serviceKey`. Неверный/неизвестный/отозванный/истёкший секрет → `401 UNAUTHORIZED`.
Роли ключа совместимы с `requirePermission`, `scopes` — точечный гейт поверх (`403 SCOPE_REQUIRED`);
при непустом `allowedProjects` проектная проекция проверяется в sessions/events-bindings/schedules
(`403 PROJECT_FORBIDDEN`). Управление ключами (CRUD) — только `ADMIN` в managed (целевой
пользовательский путь — раздел UI «Сервисные ключи»).

**Пример.**

```bash
# Создать ключ (ADMIN). Секрет придёт один раз в поле "key" (synth_svc_…).
curl -X POST http://localhost:5000/api/v2/service-keys \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"label":"telegram-gw","roles":["USER"],"scopes":["events:ingest","sessions:create"],"allowedProjects":["proj_1"]}'

# Использовать ключ как машинный доступ (scope events:ingest).
curl -X POST http://localhost:5000/api/v2/events \
  -H 'Authorization: Bearer synth_svc_<...>' -H 'Content-Type: application/json' \
  -d '{"source":"telegram","type":"message","payload":{"text":"ping"}}'
```

### 5.29 Webhooks — `/api/v2/webhooks` (оба, ADR-052 этап II)

Подписки на **исходящие** события (обратный контур к приёму событий ADR-089):
`WebhookService` подписывается на все события шины (`EventBus.subscribeAll`), фильтрует их
паттернами подписки и шлёт HTTP-POST на `url`. Единая фабрика `createWebhookRoutes` для core и
backend; store — `{dataDir}/webhooks/subscriptions.json`, журнал доставок —
`{dataDir}/webhooks/deliveries.jsonl` (ADR-005). Signing-секрет `whsec_<base64url>` **шифруется
at-rest** (AES-256-GCM мастер-ключом; HMAC требует исходный секрет) и отдаётся **единственный
раз** при создании/ротации; в списке — `secretPrefix`. Мастер-выключатель `webhooks.enabled`
(по умолчанию `false`) → мутации и `test` отвечают 503 `UNAVAILABLE` (чтение доступно). RBAC:
managed (backend) — только `ADMIN`, core (standalone) — единый `requireAuth`.

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/webhooks` | оба | ADMIN / auth | Список подписок `{subscriptions}` (метаданные без секрета) |
| POST | `/api/v2/webhooks` | оба | ADMIN / auth | Создать (`webhookSubscriptionCreateSchema`): `{label, description?, url, events?, enabled?}` → 201 `WebhookSubscriptionCreated` = метаданные + `secret` (plaintext `whsec_<base64url>`, показывается **один раз**); невалидное тело/URL → 400 `VALIDATION_ERROR`; URL вне SSRF-политики → 400; дубль метки → 409 `CONFLICT`; мастер выключен → 503 `UNAVAILABLE` |
| GET | `/api/v2/webhooks/:id` | оба | ADMIN / auth | Метаданные подписки; нет подписки → 404 `NOT_FOUND` |
| PATCH | `/api/v2/webhooks/:id` | оба | ADMIN / auth | Обновить (`webhookSubscriptionUpdateSchema`): `{label?, description?, url?, events?, enabled?}`; `null` для `description` — сброс, `undefined` — не трогать; смена метки проверяется на уникальность → 200; нет подписки → 404; дубль → 409; URL вне политики → 400 |
| DELETE | `/api/v2/webhooks/:id` | оба | ADMIN / auth | Удалить подписку → 204; нет записи → 404 |
| POST | `/api/v2/webhooks/:id/regenerate` | оба | ADMIN / auth | Ротация signing-секрета → 200 `WebhookSubscriptionCreated` (+ `secret` единожды); нет подписки → 404 |
| POST | `/api/v2/webhooks/:id/revoke` | оба | ADMIN / auth | Мягкое отключение (`enabled=false`, `disabledAt`; идемпотентно) → 200 метаданные; нет записи → 404 |
| POST | `/api/v2/webhooks/:id/test` | оба | ADMIN / auth | Тестовая доставка синтетического события `webhook.test` (в обход фильтра и дедупа) → 200 `WebhookDelivery`; нет подписки/движка → 404; мастер выключен → 503 |
| GET | `/api/v2/webhooks/:id/deliveries` | оба | ADMIN / auth | Журнал доставок подписки `{deliveries}` (`WebhookDelivery[]`); `?limit=` (default 50, cap 500); нет подписки → 404 |

**Поля подписки** (`WebhookSubscription`): `id` (`whk_<uuid>`), `label` (обязательна; уникальна
глобально по инстансу, регистронезависимо), `description?`, `url` (только http(s); по умолчанию —
`https` + запрет private/loopback через `evaluateWebhookTarget` поверх `engine/mcp/network-policy.ts`,
`webhooks.allowPrivateTargets` снимает оба ограничения), `events: string[]` (паттерны: точный тип
`stream.done` либо префикс `session.*`; пусто — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), `enabled`,
`secretPrefix`, `createdBy`/`createdAt`, `lastDeliveryAt?`/`lastStatus?`, `disabledAt?`.
**Доставка:** POST `{id, type, createdAt, data}` с заголовками `X-Synth-Event`/`X-Synth-Delivery`/
`X-Synth-Signature`; HMAC-SHA256 (`t=<unix>,v1=<hex>`, окно timestamp 300 c); retry/backoff
(экспоненциальный с джиттером, `webhooks.maxAttempts`), таймаут запроса (`webhooks.timeoutMs`),
дедуп по (подписка + событие), журнал + retention (`webhooks.deliveryRetentionDays`). Неуспех —
запись `status:'failed'` в журнале. Конфиг — `docs/CONFIGURATION.md` (секция `webhooks`); устройство —
`docs/ARCHITECTURE.md` («Внешние события и хуки»).

**Пример.**

```bash
# Создать подписку (ADMIN). Секрет придёт один раз в поле "secret" (whsec_…).
curl -X POST http://localhost:5000/api/v2/webhooks \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"label":"ci-listener","url":"https://ci.example.com/synth","events":["session.*","stream.done"]}'

# Провести тестовую доставку и посмотреть журнал.
curl -X POST http://localhost:5000/api/v2/webhooks/whk_<...>/test \
  -H 'Authorization: Bearer admin-key-123'
curl http://localhost:5000/api/v2/webhooks/whk_<...>/deliveries \
  -H 'Authorization: Bearer admin-key-123'
```

**Проверка подписи (получатель).** Тело берётся **сырым** (до парсинга JSON); из заголовка
`X-Synth-Signature` извлекаются `t` и `v1`, проверяется окно `|now - t| <= 300` и
`HMAC-SHA256(secret, "<t>.<rawBody>")` (constant-time). Пример на Node.js:

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

### 5.30 Публичный OpenAPI и SDK — `@itphx/synth-sdk` (ADR-052, этап III)

Публичный HTTP-контракт (интеграционное ядро: `events`/`sessions`/`schedules`/`llm`; 28 операций —
events 13, sessions 8, schedules 6, llm 1) описан декларативной **public-OpenAPI 3.1**-спекой и отдаётся ручкой `GET /api/v2/openapi.json`
(§5.4). Потреблять его удобнее через публикуемый пакет **`@itphx/synth-sdk`** — типизированный
клиент над этой спекой (тонкий пакет, зависимость только от `@itphx/synth-shared`; ESM,
браузер-совместимый).

```bash
npm install @itphx/synth-sdk
```

```ts
import { createSynthClient, SynthApiError } from '@itphx/synth-sdk';

const synth = createSynthClient({
  baseUrl: 'http://localhost:5000', // без /api/v2
  serviceKey: 'synth_svc_…',        // либо apiKey / token
});

try {
  // events / sessions / schedules / llm
  const { sessionId } = await synth.events.ingest({ source: 'tg', type: 'message' });
  const session = await synth.sessions.get(sessionId!);
  const jobs = await synth.schedules.jobs('<schedule-id>');
  const completion = await synth.llm.chatCompletions({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'привет' }],
  });
} catch (err) {
  if (err instanceof SynthApiError) console.error(err.status, err.code, err.message);
  throw err;
}
```

- **Auth:** заголовок `Authorization: Bearer <cred>` с приоритетом **serviceKey → apiKey → token**;
  базовый путь по умолчанию `/api/v2` (переопределяется `apiPath`).
- **Namespaces:** `events` (ingest/journal/bindings/keys/routes), `sessions` (CRUD + prompt/messages/status),
  `schedules` (CRUD + run/jobs), `llm` (`chatCompletions`).
- **Ошибки:** `SynthApiError` (`{status, code, message, body?}`); единый формат `{error:{code,message}}`,
  сетевые сбои → `status: 0` / `NETWORK_ERROR`. Инъекция `fetch` — для тестов/нестандартных рантаймов.

> Спека — источник контракта, SDK её не дублирует логикой; детали и статус — ADR-052.

---

## 6. Источники

| Компонент | Файл |
|---|---|
| Backend app + middleware + SSE/WS | `packages/backend/src/app.ts` |
| Backend роуты | `packages/backend/src/routes/*.ts` |
| Backend auth/RBAC | `packages/backend/src/auth/middleware.ts`, `auth/oidc.ts` |
| Service-key scopes (ADR-052) | `packages/core/src/server/service-scope.ts`, `packages/backend/src/auth/service-scope.ts` |
| Service-key store/роуты (ADR-052) | `packages/core/src/storage/service-api-key-store.ts`, `packages/core/src/server/routes/service-keys.ts` |
| Публичный OpenAPI (ADR-052, этап III) | `packages/core/src/server/openapi/public-openapi.ts` |
| SDK публичного API (ADR-052, этап III) | `packages/sdk/*` (`@itphx/synth-sdk`) |
| Webhooks store/журнал/роуты/движок (ADR-052) | `packages/core/src/storage/webhook-store.ts`, `packages/core/src/storage/webhook-delivery-store.ts`, `packages/core/src/server/routes/webhooks.ts`, `packages/core/src/engine/webhooks/*` |
| EventHub | `packages/backend/src/events/hub.ts` |
| Rate limiter | `packages/backend/src/middleware/rate-limiter.ts` |
| Core standalone app + SSE/WS | `packages/core/src/server/app.ts` |
| Core роуты | `packages/core/src/server/routes/*.ts` |
| Core auth | `packages/core/src/auth/local.ts` |
| Контракты (`BusEvent`) | `packages/shared/src/types/index.ts` |
