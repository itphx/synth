# API v2 — справочник

> Канонический источник истины по HTTP/WS-контракту Synth, собранный **по коду**
> (AD-017). Общие конвенции (стиль, порты, процесс, хранилище) — в корневом `AGENTS.md`.

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
`hybrid/status`, а также `/git` и `/ssh-keys` (AD-076; core-фабрики, в backend
монтируются с RBAC). В гибриде на backend проксируются `/git`, flat `/ssh-keys`
и nested `/agents/:agentId/ssh-keys` (остальные подпути `/agents` — локальны).

---

## 1. Аутентификация и RBAC

### Способы (backend, приоритет проверки)

1. **Cookie `user_session`** — серверная сессия в памяти процесса
   (`Map<sessionId, {user, expiresAt}>`, TTL `auth.sessionMaxAgeMinutes`).
   Устанавливается `POST /auth/spa-login` / OIDC callback. Cookie `httpOnly`,
   `sameSite=Lax`.
2. **Debug-ключи** — при `SYNTH_AUTH_DEBUG=true` (`config.auth.debugMode`):
   `Authorization: Bearer <apiKey>` из `config.auth.testUsers`. Пользователь
   получает роли и `isTestUser=true`.
3. **OIDC JWT** — при `config.oidc.enabled`: `Authorization: Bearer <jwt>`,
   верификация через lazy OIDC-клиент.
4. **API key** — при `!debugMode && !oidc.enabled && config.apiKey`:
   `Authorization: Bearer <SYNTH_API_KEY>` → пользователь `api` с ролью `ADMIN`.

Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.

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
| `requirePermission(...roles)` | Нет ни одной из перечисленных ролей → `403 FORBIDDEN`. Используют `audit`, `logs` (`ADMIN`,`AUDITOR`), `sessions/:id/secrets` (`ADMIN`,`AUDITOR`). |

### Standalone-core (`packages/core/src/auth/local.ts`)

| Механизм | Описание |
|---|---|
| `Authorization: Bearer <apiKey>` | Совпал с `config.apiKey` → пользователь `local` (роль `ADMIN`). |
| Cookie `synth_session` | HMAC-подписанный API-ключ (v1) либо JSON `{v:2, kind:'local'\|'server', user}` (v2, гибридная личность). |
| `requireAuth` | Единственный guard; `403`/`ADMIN`-проверок в standalone нет. |

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

Исключение — файловые операции и git-роуты (единые core-фабрики, AD-075/AD-076):
они отдают формат `FsError` `{ "error": { "error": "<message>", "code": "<FsErrorCode>" } }`
(`packages/core/src/server/routes/fs.ts`, `packages/core/src/server/routes/git.ts`);
backend и standalone монтируют одну и ту же фабрику.

Реальные коды (из кода):

| Код | Где |
|---|---|
| `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_REQUEST` | валидация тел/параметров |
| `UNAUTHORIZED` | `requireAuth`, auth-роуты |
| `FORBIDDEN` | `requireAdmin`/`requirePermission`, filesystem |
| `NOT_FOUND` | отсутствие сессии/проекта/провайдера/модели/агента/файла/лога |
| `CONFLICT` | дубли MCP-сервера, retry-состояние |
| `ALREADY_EXISTS`, `IS_DIRECTORY`, `DIR_NOT_EMPTY`, `PATH_TRAVERSAL`, `PERMISSION_DENIED` | ФС |
| `WORKSPACE_OUTSIDE_ROOT_DENIED`, `WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`, `WORKSPACE_CREATE_FAILED`, `WORKSPACE_POLICY_READ_ONLY`, `WORKSPACE_ROOT_NOT_CONFIGURED`, `PROTECTED_PATH_DENIED`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_SET`, `NOT_A_DIRECTORY` | workspace/ФС (AD-075) |
| `git.ssh_key_required`, `git.repo_path_invalid`, `git.repo_exists` | git-реестр (AD-076, shared-форма) |
| `sshkey.not_found`, `sshkey.name_exists`, `sshkey.decrypt_failed`, `sshkey.encryption_unavailable`, `sshkey.env_failed` | SSH-ключи агентов (AD-076) |
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

Единый канал — **WS `/ws/events`** (EventHub/EventBus, AD-008/AD-009/AD-024);
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
> Новых каналов не заводить (AD-008/009/024).

---

## 4. LLM Proxy

`POST /api/v2/llm/chat/completions` (backend, `requireAuth`) — единственная
точка проксирования LLM в managed-хабе (OpenAI-совместимый формат). Любой
LLM-вызов идёт через `GatewayProvider` (guard, обфускация, rate limit, аудит,
AD-036); напрямую провайдера не дёргать.

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

### 5.5 Sessions — `/api/v2/sessions`

| Метод | Путь | Сборка | RBAC | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/sessions` | оба | auth | Список сессий; `?project_id=` |
| POST | `/api/v2/sessions` | оба | auth | Создать; `{name|title, project_id, engine, settings}` → 201 |
| GET | `/api/v2/sessions/:id` | оба | auth | Сессия (сериализованная) |
| GET | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Эффективный MCP-скоуп (AD-071 §2.4): `{servers:[{name, level, enabled, reason?, connected?, origin, trust, chars?, estTokens?, estimated?}], enabled, disabled, mcpServers, mcpDisabledServers}`. `reason` ∈ `system_disabled\|project_disabled\|session_optout\|not_default`; проектный гейт `enabled` применяется и к системным серверам. Серверы/тулы несут `chars`/`estTokens` (AD-071 §2.8) |
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
| GET | `/api/v2/sessions/:id/prompt` | оба | auth | Состав системного промпта (AD-070 §2.5): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (тулы с `chars`/`estTokens` и флагом оценки, AD-071 §2.8). `manifest.toolsPolicy`/`manifest.mcpPolicy` — применённые политики встроенных/MCP (AD-071 §2.3); записи: `tools` (stable/context) → `mcp.servers`/`mcp.tools`/`mcp.status` (volatile, не в `staticPrefixChars`) |
| GET | `/api/v2/sessions/:id/messages` | оба | auth | `{messages, session_id, engine}` |
| POST | `/api/v2/sessions/:id/clear` | оба | auth | Очистить историю (кроме pinned) |
| POST | `/api/v2/sessions/:id/abort` | оба | auth | Отменить стрим `{status:'aborted'}` |
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

> `SessionSettings` MCP/скиллов (AD-071 §2.4 / AD-046 §4.5): `mcpServers`/`mcpDisabledServers`, `skills`/`skillsDisabled` — session-overrides (один тумблер); `mcpDefaultOn`/`skillsDefaultOn` — **снапшот** дефолтов (`project.defaultOn`/системного дефолта) на момент создания сессии, задаётся системой, не перезаписывается сменой дефолта проекта; `undefined` — legacy-режим (см. scope-endpoint'ы §5.17.2).

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
| GET | `/api/v2/projects` | оба | auth | Список проектов пользователя |
| POST | `/api/v2/projects` | оба | auth | Создать `{name, workspace?, repos?, plan?}` → 201 |
| GET | `/api/v2/projects/:id` | оба | auth | Проект |
| PUT | `/api/v2/projects/:id` | оба | auth / owner·EDITOR·LEAD·ADMIN | Обновить поля (name, description, current_task, invariants, icon, color, repos, plan); смена `workspace` — owner/LEAD/ADMIN |
| DELETE | `/api/v2/projects/:id` | оба | auth / owner·LEAD·ADMIN | Удалить → 204 |
| GET | `/api/v2/projects/:id/stats` | backend | auth | Агрегаты токенов/сообщений |
| GET | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Проектный MCP-скоуп (AD-071 §2.4): `{enabled, defaultOn, knownServers}`; `enabled[]` — hard-gate (недоступно и в старых сессиях, в т.ч. для системных серверов), `defaultOn[]` — сид новых сессий |
| PUT | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Задать `{enabled?, defaultOn?}` (ссылки на реестр по имени) |
| POST | `/api/v2/projects/:id/publish` | core | auth | Локальный проект → сервер (гибрид) |
| POST | `/api/v2/projects/:id/fork-local` | core | auth | Серверный проект → локальный мир (гибрид) |

> `workspace` (AD-075): при `POST`/`PUT` каталог создаётся (`mkdir -p`). Managed: пустой `workspace` → авто-имя
> `slugify(name)` + суффикс под `workspacesRoot`; абсолютный внутри root нормализуется в относительный; вне root →
> `403 WORKSPACE_OUTSIDE_ROOT_DENIED`; смена `workspace` — владелец/LEAD/ADMIN, иначе `403 FORBIDDEN`.
> RBAC (backend, D5): `PUT` контент (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `repos`, `plan`) — owner/EDITOR/LEAD/ADMIN; `workspace` — owner/LEAD/ADMIN; `DELETE` — owner/LEAD/ADMIN; иначе `403 FORBIDDEN`.
> Tool-level RBAC (core-тулы чата, AD-075/D5): `project_log_write`/`project_invariants_write` пишут только при owner/EDITOR (иначе `project.write_forbidden`); `plan_write` пока без гейта (TODO) — `project.plan` защищён HTTP-RBAC.
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
| GET | `/api/v2/fs/workspace-root` | оба | auth | Подкаталоги корня workspace (AD-075); `?includeHidden=` → `{root, entries}` |
| GET | `/api/v2/fs/workspace-root/browse` | оба | auth | Список внутри корня (AD-075); `?path=&includeHidden=` → `{root, path, entries}` |
| POST | `/api/v2/fs/workspace-root/mkdir` | оба | auth | Создать каталог в корне (AD-075); `{path, confirmOutsideRoot?}` → 201 `{created, path}` |

> `workspace-root*` (AD-075): абсолютный путь внутри `workspacesRoot` работает; вне root — по политике.
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

### 5.13.1 Проектные инструкции — `/api/v2/context/instructions` (core+backend, AD-069 §9.3)

Read-only прозрачность загруженных проектных инструкций (`AGENTS.md` и совместимые).

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/context/instructions?session_id=<id>` | owner/ADMIN | Снимок для workspace проекта сессии; сессия без проекта → пустой результат, `diagnostics[].code='no-project'` |
| GET | `/api/v2/context/instructions?project_id=<id>` | owner/LEAD/ADMIN | Снимок для проекта |

Ответ: `{ session_id?\|project_id?, enabled, cap: { chars, source: 'dynamic'\|'override', contextWindow }, files: [{ path, kind, label?, url?, chars, truncated, status, scan? }], diagnostics: [{ level, code, message, path?, kind? }] }` — структура из резолвера
AD-069 Ф2a (`engine/context/instructions.ts`); `status` — `loaded`/`truncated`/`blocked`/`dedup`/`skipped`/`untrusted`/`skipped-install-tree`/`excluded`/`fetch-error`. Без `session_id`/`project_id` → 400; неизвестный id → 404; чужой доступ → 403. Запись в хранилище не выполняется.

### 5.14 Users — `/api/v2/users` (backend, ADMIN)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/users` | Список профилей |
| GET | `/api/v2/users/:id` | Профиль |
| POST | `/api/v2/users` | Создать |
| PUT | `/api/v2/users/:id` | Обновить |
| DELETE | `/api/v2/users/:id` | Удалить |

### 5.15 Git — `/api/v2/git` (оба, AD-076)

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

### 5.15.1 SSH-ключи агентов — `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` (оба, AD-076)

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
| PUT | `/api/v2/mcp/servers/:name` | backend | ADMIN | Обновить конфиг |
| DELETE | `/api/v2/mcp/servers/:name` | backend | ADMIN | Удалить |
| POST | `/api/v2/mcp/servers/:name/test` | backend | ADMIN | Проверить подключение (+опц. `config`) |
| GET | `/api/v2/mcp/servers/:name/tools` | backend | auth | Инструменты сервера (probe при необходимости) |
| GET | `/api/v2/mcp/session/:sessionId` | backend | auth | Legacy: `{mcpServers, mcpDisabledServers, allServers}` (канонический — `/sessions/:id/mcp`) |
| PUT | `/api/v2/mcp/session/:sessionId` | backend | auth | Legacy: `{mcpServers?, mcpDisabledServers?}` (совместим с `/sessions/:id/mcp`) |
| POST | `/api/v2/mcp/probe` | оба | auth | `{name}` → `{name, tools}`, `MCP_CONNECT_ERROR` |
| GET | `/api/v2/mcp/registry` | backend | auth | Единый реестр MCP-серверов (AD-071 §2.5): `{entries}`; запись несёт `enabled` (мастер hard-gate, дефолт `true`) и `enabledByDefault` (дефолт для НОВЫХ проектов) |
| POST | `/api/v2/mcp/registry` | backend | auth (stdio — ADMIN) | Добавить запись: `{name, config, enabled?, enabledByDefault?, origin?}` → 201; stdio — только ADMIN, HTTP — любой |
| PUT | `/api/v2/mcp/registry/:id` | backend | автор/ADMIN | Обновить запись (`enabled` — мастер-флаг реестра) |
| DELETE | `/api/v2/mcp/registry/:id` | backend | автор/ADMIN | Удалить запись |

> Резолвинг MCP per-item (AD-071 §2.4): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; дефолт — opt-in (off). Мастер `enabled` (реестр) и проектный `enabled` — live hard-gate (в т.ч. старые сессии и системные серверы), `enabledByDefault`/`project.defaultOn` — snapshot (`mcpDefaultOn`). Причины: `system_disabled\|project_disabled\|session_optout\|not_default`. `McpServerConfig.enabled` — только сид записи реестра (`seedFromConfig`), в резолвинге не участвует. Отсутствие `project.mcp` — гейт не задан (legacy).

### 5.17 Skills — `/api/v2/skills` (оба, AD-046 Фаза 1)

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/skills` | оба | auth | Реестр скиллов: `{skills, workspace?, diagnostics?}`; `?project_id=` — project-скоуп, `?diagnostics=1` — диагностика discovery/валидации |
| POST | `/api/v2/skills` | оба | backend ADMIN / core auth | Создать instance-скилл: `{name, description, body?, files?}` → 201 (409 при дубле) |
| GET | `/api/v2/skills/:name` | оба | auth | Деталь: мета, тело (недоверенного — пустое), supporting-файлы |
| PATCH | `/api/v2/skills/:name` | оба | backend ADMIN / core auth | Обновить instance-скилл: `{description?, body?, metadata?}` |
| DELETE | `/api/v2/skills/:name` | оба | backend ADMIN / core auth | Удалить instance-скилл |
| GET | `/api/v2/skills/:name/files` | оба | auth | Список supporting-файлов `{files}` |
| GET | `/api/v2/skills/:name/files/*` | оба | auth | Чтение supporting-файла `{path, content}` |
| PUT | `/api/v2/skills/:name/files/*` | оба | backend ADMIN / core auth | Запись supporting-файла `{content}` |
| DELETE | `/api/v2/skills/:name/files/*` | оба | backend ADMIN / core auth | Удаление supporting-файла |
| POST | `/api/v2/skills/reload` | оба | backend ADMIN / core auth | Принудительный ре-скан реестра (ленивая инвалидация по mtime) |

Источники discovery (Фаза 1): `{dataDir}/skills` (instance), `{project.workspace}/.synth/skills` (project, project-trust гейт), `config.skills.paths`. Внешние каталоги (`.opencode`, `.claude`, `.agents`) и `skills.urls` не подключаются.

### 5.17.1 Команды и bundles — `/api/v2/commands`, `/api/v2/skill-bundles` (оба, AD-046 Фаза 2)

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/commands` | оба | auth | Список команд (builtin + шаблонные `.md` + скиллы invocation user/both + bundles). `?project_id=` — project-скоуп, `?diagnostics=1` — `shadowed`/ошибки |
| GET | `/api/v2/skill-bundles` | оба | auth | `{bundles}` — YAML-группы скиллов |
| POST | `/api/v2/skill-bundles` | оба | backend ADMIN / core auth | Создать bundle `{name, description, skills[], instruction?}` → 201 (409 при дубле; 400 при ссылке на несуществующий скилл) |
| GET | `/api/v2/skill-bundles/:name` | оба | auth | Деталь bundle |
| PATCH | `/api/v2/skill-bundles/:name` | оба | backend ADMIN / core auth | Обновить bundle |
| DELETE | `/api/v2/skill-bundles/:name` | оба | backend ADMIN / core auth | Удалить bundle |

Резолвинг `/`-команд выполняется **в core** (единообразно для UI/CLI/гибрида, AD-046 §7.1): builtin-ответы (`/help`, `/skills`, `/commands`) не вызывают LLM, а события `command.invoked`/`skill.invoked` уходят в шину. Порядок имён зависит от `commands.conflict.mode`.

### 5.17.2 Scope скиллов — `/api/v2/sessions|projects|settings/skills` (оба, AD-046 §4.5)

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

> Резолвинг скиллов per-item (AD-046 §4.5): `enabled = systemOn && projectOn && !sessionOff && (snapshotOn || sessionOn)`; дефолт — opt-in (off). Системное/проектное отключение — live hard-gate (в т.ч. старые сессии), дефолты — snapshot (`skillsDefaultOn`). Отсутствие `project.skills` — гейт не задан (legacy).

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
| GET | `/api/v2/settings/workspace-policy` | auth | Политика абсолютного workspace вне `workspacesRoot` (AD-075): `{outsideRoot:"confirm"\|"deny", isOverridden, defaults, readOnly?}` (managed — `readOnly:true`, эффективно `deny`) |
| PUT | `/api/v2/settings/workspace-policy` | auth | `{outsideRoot}` (live-применение, persist); невалидное значение → `400`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| DELETE | `/api/v2/settings/workspace-policy` | auth | Сброс к config/env-дефолту; `{status:"restored", outsideRoot, isOverridden:false, defaults}`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| GET | `/api/v2/settings/mcp` | auth | Доступность MCP по режимам: `{servers, isOverridden, defaults:{}}` |
| PUT | `/api/v2/settings/mcp` | auth | `{servers}` |
| DELETE | `/api/v2/settings/mcp` | auth | Сброс runtime-доступности MCP; `{status:"restored", servers:{}, isOverridden:false, defaults:{}}` |
| GET | `/api/v2/settings/default-agent` | auth | Агент по умолчанию (админка «Агенты»): `{defaultAgent, isOverridden, defaults}` (runtime из `settings.json`, иначе `DEFAULT_AGENT_ID` — `assistant` при первом развёртывании); используется при создании сессии без `settings.agentRole` и как `default_agent` в `/agents` |
| PUT | `/api/v2/settings/default-agent` | auth | `{defaultAgent}` — id агента (`^[a-z0-9_-]+$`), persist; невалидный/пустой → 400 |
| DELETE | `/api/v2/settings/default-agent` | auth | Сброс к дефолту; `{status:"restored", defaultAgent, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/tools-policy` | auth | Политика включения **встроенных** инструментов (AD-071 §2.3): `{toolsPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime из `settings.json`, иначе `tools.policy` из config.yaml; дефолт `auto`) |
| PUT | `/api/v2/settings/tools-policy` | auth | `{toolsPolicy}` (live-применение, persist); неизвестное значение → 400 |
| DELETE | `/api/v2/settings/tools-policy` | auth | Сброс к config-дефолту; `{status:"restored", toolsPolicy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/mcp-policy` | auth | Политика включения **MCP**-инструментов (AD-071 §2.3): `{mcpPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime из `settings.json`, иначе `mcp.policy` из config.yaml; дефолт `auto`) |
| PUT | `/api/v2/settings/mcp-policy` | auth | `{mcpPolicy}` (live-применение, persist); независима от `tools-policy`; неизвестное значение → 400 |
| DELETE | `/api/v2/settings/mcp-policy` | auth | Сброс к config-дефолту; `{status:"restored", mcpPolicy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/mcp-network-policy` | auth | Политика сетевого доступа пользовательских HTTP MCP (AD-071 §2.3.1): `{policy, isOverridden, defaults}` (дефолт — deny приватных диапазонов) |
| PUT | `/api/v2/settings/mcp-network-policy` | auth | `{policy:{mode:"allow"\|"deny",list:string[]}}` (live-применение, persist) |
| DELETE | `/api/v2/settings/mcp-network-policy` | auth | Сброс к config-дефолту; `{status:"restored", policy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/tools-disabled` | auth | Отключение встроенных инструментов (AD-071 §2.6): `{toolsDisabled:{capabilities,tools}, isOverridden, defaults}` (runtime-значение из `settings.json`, иначе `tools.disabled` из config.yaml) |
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
событий, управление привязками и правилами маршрутизации (AD-089; единая фабрика
`createEventRoutes` для core и backend):

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/events` | оба | auth | Глобальный SSE-поток `BusEvent` (фоллбек WS) |
| WS | `/ws/events` | оба | auth | Основной real-time-канал (см. §3) |
| POST | `/api/v2/events` | оба | auth + rate limit | Приём нормализованного внешнего события; тело `{source, type, payload?, identity?, dedupKey?, ts?}` (`eventIngestSchema`) → `201 {event, decision, sessionId}` (`sessionId` — id сессии или `null` при `drop`); невалидное тело → 400 `VALIDATION_ERROR`, сбой материализации → 500 `INTERNAL_ERROR` (решение всё равно пишется в журнал) |
| GET | `/api/v2/events/bindings` | оба | auth | Список привязок `{bindings}` |
| POST | `/api/v2/events/bindings` | оба | ADMIN | Upsert привязки по `source`+`chatKey`/`threadKey` (`eventBindingInputSchema`): `{source, chatKey?, threadKey?, sessionId?, mode: bound\|ephemeral\|queue, agentTemplate?, project?}`; совпавшая по ключу запись заменяется (id сохраняется) → 200, иначе 201 |
| DELETE | `/api/v2/events/bindings/:id` | оба | ADMIN | Удалить привязку → 204; нет записи → 404 `NOT_FOUND` |
| GET | `/api/v2/events/routes` | оба | auth | Список правил маршрутизации `{rules}` (`EventRouteRule[]`) |
| POST | `/api/v2/events/routes` | оба | ADMIN | Upsert правила (`eventRouteRuleUpsertSchema`): `{id?, name?, priority?, enabled?, match, target}`; `match` — AND по заполненным `source`/`type`/`chatKey`/`threadKey`/`principalId`/`label`/`keywords` (пустой-невалидный не матчит); `target` — `bound`/`queue` (`sessionId`) или `ephemeral` (`agentTemplate?`/`project?`/`ttl?`). По `id` — обновление → 200, иначе создание → 201. Валидация: `bound`/`queue` с несуществующей сессией → 400, непустой `agentTemplate` без enabled-агента → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/events/routes/:id` | оба | ADMIN | Удалить правило → 204; нет записи → 404 `NOT_FOUND` |
| GET | `/api/v2/events/journal` | оба | auth | Последние записи журнала решений `{entries}`; `?limit=` (default 50, cap 500) |

`identity` — `{principalId?, chatKey?, threadKey?, roles?}`. `dedupKey`/`ts` опциональны:
`EventIngress` нормализует событие (id `evt_<uuid>`, дефолтный dedup-ключ по
source/type/ключу/payload). RBAC managed: приём — `requireAuth` + rate limit (120/мин),
мутации привязок/правил — `requireAdmin`, чтение — `requireAuth`; в core — единый `requireAuth`.
Правила маршрутизации (`EventRouteRule`, `{dataDir}/events/routes.json`) применяет `ProjectRuleProvider`
после явного `EventBinding` и cron-правила; фоллбек Router без маршрута задаёт `events.defaultMode`
(`bound` — `drop no_route`, `ephemeral` — временная сессия).
Цепочка обработки и журнал — `docs/ARCHITECTURE.md` («Внешние события и хуки»), AD-089.

> `POST /api/v2/sessions` теперь идёт через единый funnel `RequestSessionService`
> (`engine/events/request-session.ts`, AD-089): эмит `session_requested` + создание
> сессии. Внешний контракт эндпоинта не изменился.

### 5.27 Schedules — `/api/v2/schedules` (оба, AD-051 срез / AD-089)

CRUD расписаний планировщика (единая фабрика `createSchedulerRoutes` для core и
backend). Срабатывание не создаёт сессию
само: сервис публикует нормализованное событие `source: 'cron'`,
`type: 'schedule_fired'` через `EventIngress`, а маршрутизацию выполняет
`SchedulerRuleProvider` (`RouteRuleProvider`). RBAC managed (backend): чтение
(`GET`) — `requireAuth`; мутации (`POST`/`PUT`/`DELETE`) и принудительный запуск
(`POST /:id/run`) — только ADMIN (`writeGuard = requireAdmin`); `run` дополнительно
под rate limit 10/60 c (`runMiddleware`). В core (standalone) — единый `requireAuth`
на все методы.

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/schedules` | оба | requireAuth | Список расписаний `{schedules}` |
| POST | `/api/v2/schedules` | оба | ADMIN | Создание (`scheduleInputSchema`): `{name, enabled?, cron?, every?, target, prompt?, payload?, ownerId?}`; ровно одно из `cron`/`every`; невалидно → 400 `VALIDATION_ERROR`; → 201 `{schedule}` |
| PUT | `/api/v2/schedules/:id` | оба | ADMIN | Обновление (полное тело как POST) → 200 `{schedule}`; нет записи → 404 `NOT_FOUND` |
| DELETE | `/api/v2/schedules/:id` | оба | ADMIN | Удаление → 204; нет записи → 404 |
| POST | `/api/v2/schedules/:id/run` | оба | ADMIN | Принудительный запуск (force, ingest события с уникальным dedup-ключом; managed — rate limit 10/60 c) → 200 `{schedule}`; нет записи → 404 |
| GET | `/api/v2/schedules/:id/jobs` | оба | requireAuth | История срабатываний `{jobs}` (`ScheduleJob[]`, AD-051); `?limit=` (дефолт 20, max 200); нет расписания → 404; без `JobStore` → `{jobs:[]}` |

`ScheduleJob` (`types/schedules.ts`): `trigger` (`cron`/`manual`/`catchup`),
`status` (`ok`/`error`/`skipped`), `startedAt`/`finishedAt`/`durationMs`, `target`,
`decision`/`reason` (маршрутизация: `drop no_route`, `busy`, `missed`),
`sessionId`, `error`.

`target` — дискриминированный союз: `{mode:'bound', sessionId}` |
`{mode:'ephemeral', agentTemplate?, project?, ttl?}` | `{mode:'queue', sessionId}`.
`cron` — 5 полей (UTC), `every` — `30s | 15m | 1h | 24h`. `nextRunAt` вычисляется
сервисом; `catchUp` (`skip`/`once`, дефолт `scheduler.catchUp`) управляет поведением
при пропущенном на старте срабатывании, Job-история — `GET /:id/jobs`.

---

## 6. Источники

| Компонент | Файл |
|---|---|
| Backend app + middleware + SSE/WS | `packages/backend/src/app.ts` |
| Backend роуты | `packages/backend/src/routes/*.ts` |
| Backend auth/RBAC | `packages/backend/src/auth/middleware.ts`, `auth/oidc.ts` |
| EventHub | `packages/backend/src/events/hub.ts` |
| Rate limiter | `packages/backend/src/middleware/rate-limiter.ts` |
| Core standalone app + SSE/WS | `packages/core/src/server/app.ts` |
| Core роуты | `packages/core/src/server/routes/*.ts` |
| Core auth | `packages/core/src/auth/local.ts` |
| Контракты (`BusEvent`) | `packages/shared/src/types/index.ts` |
