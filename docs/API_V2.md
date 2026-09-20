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
`context/users/git/audit/logs/gateway/llm/i18n/admin`, зато есть `auth/*` и
`hybrid/status`.

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
| `Authorization: Bearer <apiKey>` | Совпал с `config.apiKey` → пользователь `local` (роль `USER`). |
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

Исключение — файловые и git-операции **backend**: они отдают
формат `FsError` `{ "error": { "error": "<message>", "code": "<FsErrorCode>" } }`
(`packages/backend/src/routes/fs.ts:16`, `git.ts:37`). Core-fs использует стандартный формат.

Реальные коды (из кода):

| Код | Где |
|---|---|
| `VALIDATION_ERROR`, `BAD_REQUEST`, `INVALID_REQUEST` | валидация тел/параметров |
| `UNAUTHORIZED` | `requireAuth`, auth-роуты |
| `FORBIDDEN` | `requireAdmin`/`requirePermission`, filesystem |
| `NOT_FOUND` | отсутствие сессии/проекта/провайдера/модели/агента/файла/лога |
| `CONFLICT` | дубли MCP-сервера, retry-состояние |
| `ALREADY_EXISTS`, `IS_DIRECTORY`, `DIR_NOT_EMPTY`, `PATH_TRAVERSAL`, `PERMISSION_DENIED` | ФС |
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
| GET | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Эффективный MCP-скоуп (AD-071 §2.4): `{servers:[{name, level, enabled, reason?, connected?, origin, trust, chars?, estTokens?, estimated?}], enabled, disabled, mcpServers, mcpDisabledServers}`. Серверы/тулы несут `chars`/`estTokens` (AD-071 §2.8) |
| PUT | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Переключить MCP: `{name, enabled}` или `{mcpServers?, mcpDisabledServers?}` (opt-out системных — через `enabled:false`) |
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
| GET | `/api/v2/sessions/:id/prompt` | оба | auth | Состав системного промпта (AD-070 §2.5): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (тулы с `chars`/`estTokens` и флагом оценки, AD-071 §2.8) |
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
| PUT | `/api/v2/projects/:id` | оба | auth | Обновить поля (name, workspace, plan, invariants, …) |
| DELETE | `/api/v2/projects/:id` | оба | auth | Удалить → 204 |
| GET | `/api/v2/projects/:id/stats` | backend | auth | Агрегаты токенов/сообщений |
| GET | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Проектный MCP-скоуп (AD-071 §2.4): `{enabled, defaultOn, knownServers}` |
| PUT | `/api/v2/projects/:id/mcp` | backend | owner/LEAD/ADMIN | Задать `{enabled?, defaultOn?}` (ссылки на реестр по имени) |
| POST | `/api/v2/projects/:id/publish` | core | auth | Локальный проект → сервер (гибрид) |
| POST | `/api/v2/projects/:id/fork-local` | core | auth | Серверный проект → локальный мир (гибрид) |

### 5.9 Providers — `/api/v2/providers`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/providers` | оба | auth / auth | Список провайдеров |
| POST | `/api/v2/providers` | оба | ADMIN / auth | Создать/обновить |
| GET | `/api/v2/providers/:name` | оба | ADMIN / auth | Один (apiKey маскирован) |
| DELETE | `/api/v2/providers/:name` | оба | ADMIN / auth | Удалить |
| POST | `/api/v2/providers/:name/test` | оба | ADMIN / auth | Тест подключения |
| POST | `/api/v2/providers/fetch-icon` | backend | ADMIN | Favicon домена (data-URL) |

### 5.10 Models — `/api/v2/models`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/models` | оба | auth / auth | Модели, сгруппированные по провайдеру |
| POST | `/api/v2/models` | оба | ADMIN / auth | Создать/обновить |
| POST | `/api/v2/models/fetch` | backend | ADMIN | Синхронизировать с провайдерами |
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
| POST | `/api/v2/fs/move` | оба | auth | `{projectId, sourcePath, targetPath}` |
| GET | `/api/v2/fs/workspace-root` | backend | auth | Подкаталоги корня workspace; `?includeHidden=` |
| GET | `/api/v2/fs/workspace-root/browse` | backend | auth | Список внутри корня; `?path=&includeHidden=` |
| POST | `/api/v2/fs/workspace-root/mkdir` | backend | auth | Создать каталог в корне |

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

### 5.14 Users — `/api/v2/users` (backend, ADMIN)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/users` | Список профилей |
| GET | `/api/v2/users/:id` | Профиль |
| POST | `/api/v2/users` | Создать |
| PUT | `/api/v2/users/:id` | Обновить |
| DELETE | `/api/v2/users/:id` | Удалить |

### 5.15 Git — `/api/v2/git` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| POST | `/api/v2/git/scan` | auth | `{projectId}` → `{repos}` |
| POST | `/api/v2/git/repos/init` | auth | `{projectId, path, defaultBranch?}` → 201 |
| POST | `/api/v2/git/repos/clone` | auth | `{projectId, path?, url, branch?}` → 201 |
| GET | `/api/v2/git/log` | auth | `?project_id=&repo_path=&max_count=` |
| GET | `/api/v2/git/commit` | auth | `?project_id=&repo_path=&hash=` |

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
| GET | `/api/v2/mcp/registry` | backend | auth | Единый реестр MCP-серверов (AD-071 §2.5): `{entries}` |
| POST | `/api/v2/mcp/registry` | backend | auth (stdio — ADMIN) | Добавить запись: `{name, config, enabledByDefault?, origin?}` → 201; stdio — только ADMIN, HTTP — любой |
| PUT | `/api/v2/mcp/registry/:id` | backend | автор/ADMIN | Обновить запись |
| DELETE | `/api/v2/mcp/registry/:id` | backend | автор/ADMIN | Удалить запись |

### 5.17 Audit — `/api/v2/audit` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/audit` | ADMIN/AUDITOR | Аудит Gateway; `?userId=&sessionId=&since=&until=&limit=` (≤500) |
| POST | `/api/v2/audit/revealed` | auth | `{sessionId, placeholder}` → `{ok:true}` |

### 5.18 Logs — `/api/v2/logs` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/logs/llm` | ADMIN/AUDITOR | Payload-лог LLM; `?sessionId=&limit=` (≤500) |
| GET | `/api/v2/logs/:name` | ADMIN/AUDITOR | Хвост `core\|ui\|backend`; `?tail=` (1..2000), `?search=` |

### 5.19 Gateway patterns — `/api/v2/gateway` (backend, ADMIN)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/gateway/patterns` | Паттерны секретов + признак override |
| PUT | `/api/v2/gateway/patterns` | Сохранить override |
| DELETE | `/api/v2/gateway/patterns` | Сброс к дефолту |

### 5.20 Settings — `/api/v2/settings` (оба)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/settings/workspace` | auth | Рабочий каталог по умолчанию |
| PUT | `/api/v2/settings/workspace` | auth | `{workspace}` |
| GET | `/api/v2/settings/mcp` | auth | Доступность MCP по режимам |
| PUT | `/api/v2/settings/mcp` | auth | `{servers}` |
| GET | `/api/v2/settings/tools-disabled` | ADMIN | Отключение встроенных инструментов (AD-071 §2.9): `{disabled:{capabilities,tools}}` + эффективный набор/признак override |
| PUT | `/api/v2/settings/tools-disabled` | ADMIN | `{disabled:{capabilities:string[],tools:string[]}}` (live-применение, persist); `runtime`-тулы неотключаемы |
| GET | `/api/v2/settings/llm-gateway` | auth | Настройки LLM Gateway |
| PUT | `/api/v2/settings/llm-gateway` | auth | `{llmGateway}` (live-применение) |
| GET | `/api/v2/settings/security` | auth | `{security:{protectedPaths, askTimeoutMs}}` |
| PUT | `/api/v2/settings/security` | auth | `{security}` (live-применение) |
| GET | `/api/v2/settings/protected-paths` | auth | `{policy, base, is_overridden}` |
| PUT | `/api/v2/settings/protected-paths` | auth | `{policy}` или `{version, add, remove}` |
| DELETE | `/api/v2/settings/protected-paths` | auth | Сброс к системной политике |

### 5.21 Dictionaries — `/api/v2/dictionaries` (оба)

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| GET | `/api/v2/dictionaries` | auth / auth | Список словарей |
| GET | `/api/v2/dictionaries/:category/:lang` | auth / auth | Словарь |
| PUT | `/api/v2/dictionaries/:category/:lang` | ADMIN / auth | Сохранить |
| DELETE | `/api/v2/dictionaries/:category/:lang` | ADMIN / auth | Удалить |

### 5.22 LLM — `/api/v2/llm` (backend)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| POST | `/api/v2/llm/chat/completions` | auth + rate limit | LLM Proxy (см. §4) |

### 5.23 Updates — `/api/v2/updates` (core)

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/updates/check` | auth | Проверка новой версии |
| POST | `/api/v2/updates/apply` | auth | SSE-стрим `npm i -g @itphx/synth@latest` |

### 5.24 Admin/debug — `/api/v2/admin/debug` (backend, ADMIN)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v2/admin/debug/config` | Группы логирования + уровни |
| POST | `/api/v2/admin/debug/config` | `{groups}` → `{status:'saved'}` |

### 5.25 Events — `оба`

| Метод | Путь | RBAC | Назначение |
|---|---|---|---|
| GET | `/api/v2/events` | auth | Глобальный SSE-поток `BusEvent` (фоллбек WS) |
| WS | `/ws/events` | auth | Основной real-time-канал (см. §3) |

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
