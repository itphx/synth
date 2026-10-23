# API v2 — справочник

> 🌐 [English](./en/API_V2.md) · **Русский**

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
`automation:install`, `users:read` + wildcard-семейства
`events:*`, `bindings:*`, `keys:*`, `routes:*`, `sessions:*`, `schedules:*`
(глобального `*` нет; `automation` в wildcard-семейства **не** входит — wildcard
`automation:*` намеренно не вводится, иначе он молча покрывал бы будущие
`automation:*`-скоупы, не связанные с установкой пакета). Отдельно: на части роутов (запись реестра MCP, запись
скиллов, чтение админского user-API) scope работает как альтернатива роли ADMIN
(«ADMIN **или** scope», см. §5.14/§5.16/§5.17). Проектная проекция `allowedProjects`: если у ключа задан
непустой список, доступны только входящие в него проекты — применяется в sessions,
events/bindings и schedules (иначе `403 PROJECT_FORBIDDEN`); пусто/отсутствует —
политика инстанса. Точки применения scope по роутам — в §5.5, §5.26, §5.27, §5.23.

**Зонтичный scope `automation:install` (ADR-052).** Scope установщика пакетов
расширений: агенты и их ролевые промпты, пайплайны, а также порождаемые пакетом
правила маршрутизации и расписания. Там, где пакет пишет свои артефакты,
`automation:install` — **альтернатива** ресурсному scope: достаточно **любого**
из пары (`routes:write` **или** `automation:install` для правил маршрутизации,
`schedules:write` **или** `automation:install` для расписаний; для записи
агентов — только `automation:install`). `addons:install` при этом создание
агентов **не** открывает. На роутах записи агентов guard «роль ADMIN **или**
scope» (`requireAdminRoleOrScope`) учитывает **и** роль `ADMIN` среди ролей
ключа — зонтичный scope ничего не отбирает (в отличие от `requireAdminOrScope`,
где для service-key проверяются **только** scope'ы). Точные наборы —
`SERVICE_SCOPE_SETS` (`packages/shared/src/types/service-keys.ts`).

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
| `requireAdmin` | Нет пользователя → `401 UNAUTHORIZED`; пользователь есть, но нет роли `ADMIN` → `403 {error:{code:'FORBIDDEN'}}`. |
| `requirePermission(...roles)` | Нет пользователя → `401 UNAUTHORIZED`; пользователь есть, но ни одной из перечисленных ролей → `403 FORBIDDEN`. Используют `audit`, `logs` (`ADMIN`,`AUDITOR`), `sessions/:id/secrets` (`ADMIN`,`AUDITOR`), service-keys (`ADMIN`), webhooks (`ADMIN`), maintenance (`ADMIN`), events bindings/routes/keys (`ADMIN`,`LEAD`). |

> **Правило 401/403 (semantics):** отсутствие аутентификации → `401 UNAUTHORIZED`; аутентифицирован, но роли/прав не хватает → `403 FORBIDDEN`; service-key без нужного scope → `403 SCOPE_REQUIRED` (это про scope, не про аутентификацию).

Отдельно от `middleware.ts` — **scope-гейты service-key** (`packages/backend/src/auth/service-scope.ts`:
`scopeGuard`/`serviceProjectProjection`, делегируют core-`requireScope`/`checkServiceProjectProjection` и отдают
локализованные `403 SCOPE_REQUIRED`/`PROJECT_FORBIDDEN`; вне service-key — no-op; это проектная проекция
service-key, **не** RBAC).

### Standalone-core (`packages/core/src/auth/local.ts`)

| Механизм | Описание |
|---|---|
| `Authorization: Bearer <apiKey>` | Совпал с `config.apiKey` → пользователь `local` (роль `ADMIN`). |
| `Authorization: Bearer synth_svc_…` | Service-key (ADR-052): синтетический пользователь ключа + `scopes`/`allowedProjects` в контексте; отозванный/истёкший/неизвестный → `401`. |
| Cookie `synth_session` | HMAC-подписанный API-ключ (v1) либо JSON `{v:2, kind:'local'\|'server', user}` (v2, гибридная личность). |
| `requireAuth` | Единственный глобальный guard; ролевых `403`/`ADMIN`-проверок в standalone нет (scope-гейты `requireScope`/`checkServiceProjectProjection` работают только для service-key). Локальный **prefix-guard доступа к сессии** (`server/session-access-guard.ts`) навешен и здесь: в single-user все сессии — владельца `local`/без владельца (доступ есть), чужой владелец → `403`, нет сессии → `404`. |

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
| `UNAUTHORIZED` | Нет аутентификации (`requireAuth`, `requireAdmin`, `requirePermission`, `requireAdminOrScope`), auth-роуты, неверный/отозванный/истёкший service-key (ADR-052) |
| `FORBIDDEN` | Аутентифицирован, но роли/прав не хватает (`requireAdmin`/`requirePermission`/`requireAdminOrScope`), filesystem |
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
  при подключении шлёт `{type:'connected', client_id}`.
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
| GET | `/health` | — | `{status:'healthy', version, time, startedAt}` (`startedAt` — ISO-метка старта процесса, ADR-092) |
| GET | `/api/v2/health` | — | то же (+ блок `storage` в деградации) |
| GET | `/ready` | — | Readiness (ADR-094): `200` `{status:'ready', storage:'ok'\|'degraded', version, startedAt, time, checks?}`; `503` `{status:'not_ready', …}` только на старте/fail-closed. Деградация хранилища **не** снимает readiness (ADR-098) |
| GET | `/metrics` | нет / bearer-токен | Prometheus exposition 0.0.4 (ADR-094), **вне** `/api/v2`; `metrics.enabled=false` → `404 NOT_FOUND`, при заданном токене без `Authorization: Bearer …` → `401 UNAUTHORIZED`; `Content-Type: text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store` |

Каталог метрик, лейблы, скрейп, алерты и диагностика — [OBSERVABILITY.md](./OBSERVABILITY.md);
конфиг (`metrics.enabled`, токен) — [CONFIGURATION.md](./CONFIGURATION.md) §«Наблюдаемость».

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
| POST | `/api/v2/sessions` | оба | auth | Создать; `{name\|title, project_id, settings}` → 201 || GET | `/api/v2/sessions/:id` | оба | auth | Сессия (сериализованная) |
| GET | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Эффективный MCP-скоуп (ADR-071 §2.4): `{servers:[{name, level, enabled, reason?, connected?, origin, trust, chars?, estTokens?, estimated?}], enabled, disabled, mcpServers, mcpDisabledServers}`. `reason` ∈ `system_disabled\|project_disabled\|session_optout\|not_default`; проектный гейт `enabled` применяется и к системным серверам. Серверы/тулы несут `chars`/`estTokens` (ADR-071 §2.8) |
| PUT | `/api/v2/sessions/:id/mcp` | backend | owner/ADMIN | Переключить MCP (один тумблер): `{name, enabled}` → `mcpServers`/`mcpDisabledServers` (opt-out системных — через `enabled:false`), либо `{mcpServers?, mcpDisabledServers?}` |
| PATCH | `/api/v2/sessions/:id` | оба | auth | `{name, title, mode: plan\|act\|yolo, settings, project_id}` |
| DELETE | `/api/v2/sessions/:id` | оба | auth | Удалить → 204 |
| GET | `/api/v2/sessions/:id/secrets` | backend | ADMIN/AUDITOR | Карта обфускации Gateway `{sessionId, secrets}` |
| POST | `/api/v2/sessions/:id/fork` | оба | auth | Форк; `{message_id?, message_index?, title?}` → 201 |
| GET | `/api/v2/sessions/:id/children` | оба | auth | Дочерние сессии |
| GET | `/api/v2/sessions/:id/tree` | оба | auth | Дерево сессий |
| GET | `/api/v2/sessions/:id/export` | backend | auth | Экспорт Session (внутренний формат, camelCase — формат publish/fork не изменён). Маршрут зарегистрирован **после** prefix-guard'а (`app.use('/:id')`/`app.use('/:id/*')`), поэтому **доступ к сессии решает единый guard** — проверок доступа в обработчике нет (инвариант 16). Карта обфускации Gateway (ADR-036) — **отдельная привилегия**, которую решает route-level guard `createSessionExportGuard`: **полный экспорт** (`obfuscationMap` и `messages[].metadata.secrets` включены) — **владельцу сессии** (`ownerId ?? userId`), `ADMIN` и `AUDITOR` (тот же набор привилегий, что у `GET /:id/secrets`); прочие читатели сессии (участник проекта `VIEWER`/`EDITOR`, владелец проекта, не владеющий сессией, `LEAD`) — **200 с очищенным телом** (карты нет, весь остальной разговор переносится без изменений; очистка — на копии, сохранённая сессия не меняется); нет доступа на чтение сессии → 403 `FORBIDDEN`; сессии нет → 404 `NOT_FOUND`; rate limit 10/60 c → 429 `RATE_LIMITED` |
| POST | `/api/v2/sessions/import` | backend | auth | Импорт сессии из экспорта → 201 |
| GET | `/api/v2/sessions/:id/status` | оба | auth | `{blocked, pending_count, processor_running}` |
| POST | `/api/v2/sessions/:id/prompt` | оба | auth | Поставить сообщение в очередь, вернуть **SSE-стрим** |
| GET | `/api/v2/sessions/:id/prompt` | оба | auth | Состав системного промпта (ADR-070): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (тулы с `chars`/`estTokens` и флагом оценки, ADR-071 §2.8). `manifest.toolsPolicy`/`manifest.mcpPolicy` — применённые политики встроенных/MCP (ADR-071 §2.3); записи: `tools` (stable/context) → `mcp.servers`/`mcp.tools`/`mcp.status` (volatile, не в `staticPrefixChars`) |
| GET | `/api/v2/sessions/:id/stats` | оба | auth | Статистика usage (ADR-070): сообщения + рекурсивный usage саб-агентов (tool `task`), агрегаты по агентам/пользователям (`computeSessionStats`) |
| GET | `/api/v2/sessions/:id/messages` | оба | auth | `{messages, session_id}` |
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
> **Видимость `GET /api/v2/sessions` (ADR-089).** `ADMIN`/`LEAD` — **все** сессии; иначе — свои личные **плюс** сессии проектов, участником которых является пользователь (`owner` проекта или любой `members`, любая роль). Сессия **без владельца** видна (паритет с доступом по id). Личные сессии других пользователей не видны. `?project_id=` фильтрует поверх этой видимости.
> **Доступ по id — все `:id`-маршруты ресурса (ADR-089).** Единый prefix-guard `server/session-access-guard.ts` (вешается на `/:id` и `/:id/*` вместе с `requireAuth`; вид доступа `read`/`write` выводится из HTTP-метода), правило: `ADMIN`/`LEAD` — чтение **и** мутация чужой сессии разрешены (осознанное решение продукта; зафиксировано матрицей `routes/session-idor-matrix.test.ts`); владелец сессии / сессия без владельца — всё; участник проекта сессии: **чтение** (`GET`/`HEAD`) — любая роль, включая `VIEWER`, **мутация** — `OWNER`/`EDITOR` (`canEditProjectContent`); чужой пользователь → `403 FORBIDDEN`; несуществующая сессия → `404 NOT_FOUND`. Коды согласованы по всему ресурсу (для чужого на любом `:id`-маршруте — `403`); явные исключения: `GET /:id/mcp` — владелец|`ADMIN` (ADR-071 §2.4), `GET /:id/secrets` — `ADMIN`|`AUDITOR`, `GET /:id/export` — маршрут **под** guard'ом (доступ к сессии решает он), а карта обфускации — отдельная привилегия route-level guard'а: владелец|`ADMIN`|`AUDITOR` (остальным читателям — 200 с очищенным телом; ADR-091 §6). Хелпер списка — `server/session-visibility.ts` (`isSessionVisible`), скан — `FileStore.listForUserScope`.
> **Scope service-key (ADR-052):** `GET /` и `GET /:id` — `sessions:read`; `POST /` — `sessions:create`; `PATCH /:id`, `DELETE /:id`, `POST /:id/prompt` — `sessions:prompt`; `GET /:id/prompt|status|stats|messages` — `sessions:read`. При непустом `allowedProjects` проектная проекция проверяется по `project_id` сессии, иначе `403 PROJECT_FORBIDDEN`.
> **Контекст хранения инстанса.** Экспорт/импорт проекта (`GET /api/v2/projects/:id/export`, `POST /api/v2/projects/import`) идут через контекст хранения инстанса (`StorageContext`, ADR-096), а не через собственный файловый контекст — на `storage.backend=postgres` видны БД-проекты (спека — §5.8.1).
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

### 5.8.1 Портативный экспорт/импорт проекта — `/api/v2/projects` (оба, ADR-091 §6)

Перенос проекта между инстансами Synth: скачать самодостаточный архив
`<name>.synth-project.tar.gz` и импортировать его из UI/API. Единая фабрика
`createProjectPortableRoutes` для core и backend; работа — в ядре
(`packages/core/src/projects/portable.ts`). Архив содержит `manifest.json`
(sha256-записи), `project.json` и `sessions/<id>.json`; опционально `workspace/**`.
**По умолчанию секретов в архиве нет** (ключи, токены, credentials, `secrets/` не попадают), и
при упаковке session-payload'ов **вырезается карта обфускации LLM Gateway** (ADR-036):
`obfuscation_map` на уровне сессии и `metadata.secrets` — **рекурсивно, в любом месте payload'а**,
то есть по всем носителям сообщений сессии (`messages[]`, `pendingMessages[]`,
`checkpoints[].messages[]`) — архив проекта не вывозит секреты других
участников. Opt-in `?withSecrets=true` — **только** для `ADMIN`/`LEAD` (в core — локального
владельца); выдача фиксируется в аудите обслуживания (`export.created`, деталь
`withSecrets: true`), и такой архив — **сам секрет**. Импорт карту принимает, если она в архиве
есть, — архив, собранный с привилегированным opt-in, импортируется корректно.

Импорт — **materialization** (ADR-089, инвариант 15): создаётся **новый** `projectId`
и новые сессии (источник id → новый id в `idMap`), не через funnel `session.requested`.
`mergeInto` импортирует сессии в существующий проект. Ядро уведомляет хаб
(`onSessionCreated` → подписка владельца, ADR-089 инвариант 18). Операции фиксируются
в аудит-журнале обслуживания (`export.created`/`import.applied`, ADR-092).

**Контекст хранения инстанса.** Экспорт и импорт идут через `StorageContext` инстанса
(ADR-096), а не через собственный файловый контекст: на `storage.backend=postgres`
скачивание архива раньше отдавало 404 для всех БД-проектов, а импорт уходил в файловое
хранилище (split-brain).

| Метод | Путь | Сборка | RBAC (managed / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/projects/:id/export` | оба | auth / owner·участник·LEAD·ADMIN | Скачать портативный архив (стриминг): `Content-Type: application/gzip`, `Content-Disposition: attachment; filename="<slug>.synth-project.tar.gz"`, `Content-Length`; query `withWorkspace=true` (по умолчанию без `workspace/**`) и `withSecrets=true` (только `ADMIN`/`LEAD`, в core — локальный владелец; по умолчанию карта обфускации вырезана); нет проекта → 404 `NOT_FOUND`; нет права чтения → 403 `FORBIDDEN` |
| POST | `/api/v2/projects/import` | оба | auth / любая роль (в `mergeInto` — owner·EDITOR·LEAD·ADMIN) | Импортировать архив (multipart) → 201 `{projectId, sessionsImported, messagesImported, workspaceRestored, idMap}` |

**`POST /import`** — `multipart/form-data`: `file` (архив, обязательно), `name`
(имя нового проекта), `mergeInto` (id существующего проекта), `withWorkspace` (`'true'`
— распаковать `workspace/**`), `confirm` (`'true'`). **`confirm` не обязателен**: импорт в
новый/существующий проект не деструктивен (не удаляет данные), поэтому подтверждение не
запрашивается (`importProject` вызывается с `yes: true`), поле принимается для совместимости
с UI. Успех → 201 `ImportProjectResult`; имя нового проекта при коллизии получает суффикс
`(N)` (явное `name`, занятое → 409).

**Лимит загрузки.** Multipart `POST /import` ограничен `storage.maxUploadBytes`
(по умолчанию 100 МиБ, `DEFAULT_MAX_UPLOAD_BYTES`); DoS-защита проверяет заявленный
`content-length`, размер `File` и фактически прочитанные байты — превышение → 413
`PAYLOAD_TOO_LARGE`.

**Лимиты распакованного объёма.** Импорт ограничен не только размером загруженного файла, но и
**распакованным** объёмом архива (защита от archive-«бомб»): `DEFAULT_PROJECT_IMPORT_LIMITS` —
**100 000 записей**, **128 МиБ** на одну запись, **2 ГиБ** суммарно
(`packages/core/src/projects/portable.ts`). Проверка идёт **в момент чтения** архива: лимит одной
записи сверяется по заголовку tar **до** буферизации содержимого, суммарный — по сумме объявленных
размеров, число записей — по счётчику, поэтому превышение **обрывает разбор**, а не констатирует
факт после распаковки. Превышение → **400 `VALIDATION_ERROR`** с кодом `invalid-archive`
(существующий код, отдельный не вводился); лимиты переопределяются программно через
`ImportProjectOptions.limits`.

**Асимметрия экспорт/импорт.** Экспорт проекта лимитом распакованного объёма **не** ограничен —
архив пишется потоком на диск, распаковывать там нечего; ограничен **импорт**. Путь
**восстановления бэкапа инстанса** (`synth restore`, `POST /api/v2/maintenance/restore`) — другой
артефакт со своей политикой размеров и этими лимитами **не** ограничен.

**Коды ошибок.** 400 `VALIDATION_ERROR` (битый/повреждённый архив, несовпадение
sha256, небезопасный путь в архиве, небезопасный путь в `workspace/**` — симлинк на пути
или realpath-контейнмент, fail-closed, ошибка восстановления workspace, не-multipart тело или
отсутствие `file`, превышение лимитов распакованного объёма), 404 `NOT_FOUND` (нет проекта или цели `mergeInto`), 409 `CONFLICT`
(имя проекта занято), 413 `PAYLOAD_TOO_LARGE` (превышен лимит), 401/403 (нет кред/нет права
чтения или редактирования проекта). Источники — `packages/core/src/server/routes/project-portable.ts`,
`packages/core/src/projects/portable.ts`.

### 5.9 Providers — `/api/v2/providers`

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/providers` | оба | auth / auth | Список провайдеров |
| POST | `/api/v2/providers` | оба | ADMIN / auth | Создать/обновить |
| GET | `/api/v2/providers/:name` | оба | ADMIN / auth | Один (apiKey маскирован) |
| DELETE | `/api/v2/providers/:name` | оба | ADMIN / auth | Удалить |
| POST | `/api/v2/providers/:name/test` | оба | ADMIN / auth | Тест подключения |
| POST | `/api/v2/providers/fetch-icon` | backend | ADMIN | Favicon домена (сырой data-URL); UI сохраняет иконку уже сжатой (маленький PNG data-URL) |

> **Поле `num_ctx` / `numCtx` (размер контекста).** Размер контекста
> провайдера (`ProviderConfig.numCtx`, у Ollama — `num_ctx`) задаётся полем
> `num_ctx` (он же `numCtx`) в теле `POST /api/v2/providers` и
> `PATCH /api/v2/providers/:name` — принимается целое > 0, `null`/`''` — сброс
> (невалидное → `400 VALIDATION_ERROR`). `GET /api/v2/providers` отдаёт значение
> как `num_ctx` (snake_case), `GET /api/v2/providers/:name` — как хранимое
> `numCtx` (camelCase). Приоритет: явный `numCtx` провайдера >
> `ModelConfig.contextWindow`. Поле также синхронизируется из env
> `SYNTH_PROVIDER_<NAME>_NUM_CTX` (`syncProvidersFromEnv`) и задаётся CLI-флагом
> `--num-ctx` у `synth config provider add`. `num_ctx` отправляется в теле
> запроса к нативному `/api/chat` (провайдер `type: ollama` всегда нормализует
> URL туда, снимая суффикс `/v1`, — с предупреждением в лог; OpenAI-совместимый
> путь — отдельный провайдер `type: openai`/`generic`). Альтернатива —
> окно на стороне Ollama (`OLLAMA_CONTEXT_LENGTH`/Modelfile).

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
| POST | `/api/v2/agents` | оба | ADMIN или scope `automation:install` / auth | Создать/обновить |
| GET | `/api/v2/agents/:id` | backend | ADMIN | Агент + builtin/override |
| DELETE | `/api/v2/agents/:id` | оба | ADMIN или scope `automation:install` / auth | Удалить custom / сбросить built-in |
| PATCH | `/api/v2/agents/:id/enabled` | backend | ADMIN или scope `automation:install` | `{enabled}` |

> **Запись агентов — «роль ADMIN **или** scope `automation:install`» (ADR-052).**
> Зонтичный scope установщика пакетов расширений: агент вместе с ролевым
> промптом — часть пакета. Guard — `requireAdminRoleOrScope('automation:install')`:
> для service-key достаточно **любого** из двух (scope `automation:install`
> **или** роль `ADMIN` среди ролей ключа — прежние права ключа с ролью ADMIN
> не отбираются); для интерактивных кред требуется роль `ADMIN`
> (401 `UNAUTHORIZED` без аутентификации, 403 `FORBIDDEN` без роли, 403
> `SCOPE_REQUIRED` — у service-key без scope и без роли ADMIN). В core
> (standalone) интерактивный доступ — `auth`, service-key — тот же scope **или**
> роль ADMIN. Scope `addons:install` создание агентов **не** открывает.

> **Ролевой промпт агента (ADR-046/ADR-089).** `POST /api/v2/agents` принимает необязательное
> поле `role_prompt` (алиас `rolePrompt`) — **содержимое** ролевого промпта (не путь). Файл роли
> пишется в `{dataDir}/context/roles/<contextFile>` (`contextFile` агента, иначе `<ID_АГЕНТА_UPPER>.md`)
> и имеет приоритет над системным `prompts/roles/` (резолв — `getRolePrompt`). Запись атомарная
> (tmp → rename); уже существовавший файл с другим содержимым перезаписывается (явная установка) —
> факт отражается в ответе (`role: {file, written, replaced}`) и в логе `AGENTS`. Право — то же, что на
> создание агента (managed — ADMIN, standalone — auth). Контент роли в определение агента не
> сохраняется: агент ссылается на файл через `contextFile`.
> **Группы агента (ADR-046 §6.2).** Необязательное поле `groups` (массив строк) — привязка скиллов
> по `metadata.synth.groups`; приоритет `body → existing → builtin`, пустые/дубли/не-строки отбрасываются.
> Поле возвращается в `GET /agents/all` (`groups`) и в ответе `POST /agents`.

### 5.12 Файлы — `/api/v2/fs`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| GET | `/api/v2/fs` | оба | auth | Список каталога; `?project_id=&path=&maxDepth=&includeHidden=` |
| GET | `/api/v2/fs/read` | оба | auth | Содержимое; `?project_id=&path=` |
| POST | `/api/v2/fs/write` | оба | auth | `{projectId, path, content}` |
| POST | `/api/v2/fs/upload` | оба | auth | multipart: `project_id`, `path`, `file`; лимит размера (по умолчанию 100 МиБ, `DEFAULT_MAX_UPLOAD_BYTES`) → `413 PAYLOAD_TOO_LARGE` |
| GET | `/api/v2/fs/download` | оба | auth | Скачать; `?project_id=&path=` |
| DELETE | `/api/v2/fs` | оба | auth | Удалить файл/пустой каталог; `?project_id=&path=` |
| POST | `/api/v2/fs/mkdir` | оба | auth | `{projectId, path}` |
| POST | `/api/v2/fs/move` | оба | auth | `{projectId, sourcePath, targetPath, targetProjectId?}` |
| GET | `/api/v2/fs/workspace-root` | оба | auth (managed → `403 FORBIDDEN`) | Подкаталоги корня workspace (ADR-075); `?includeHidden=` → `{root, entries}` |
| GET | `/api/v2/fs/workspace-root/browse` | оба | auth (managed → `403 FORBIDDEN`) | Список внутри корня (ADR-075); `?path=&includeHidden=` → `{root, path, entries}` |
| POST | `/api/v2/fs/workspace-root/mkdir` | оба | auth (managed → `403 FORBIDDEN`) | Создать каталог в корне (ADR-075); `{path, confirmOutsideRoot?}` → 201 `{created, path}` |

> `workspace-root*` (ADR-075): абсолютный путь внутри `workspacesRoot` работает; вне root — по политике. Ручной выбор workspace — только standalone: в managed (`requireProjectId`) все три маршрута отдают `403 FORBIDDEN` для любой роли (каталог проекта авто-провижнится, перечень управляемых workspace не раскрывается).
> `POST /upload` — лимит размера файла (по умолчанию `DEFAULT_MAX_UPLOAD_BYTES` = 100 МиБ, переопределяется опцией `FsRoutesOptions.maxUploadBytes`); проверяется троично (заявленный `content-length`, `File.size`, фактический размер прочитанных байт) → `413 PAYLOAD_TOO_LARGE` (фактический размер — защита от лживого/отсутствующего `content-length`).
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
| POST | `/api/v2/git/scan` | read / auth | `{projectId}` → `{repos}` (git-детект по workspace, до 3 уровней) |
| POST | `/api/v2/git/repos/init` | write / auth | `{projectId, path, defaultBranch?, name?, sshKeyId?}` → 201 `RepoStatus`; регистрирует запись |
| POST | `/api/v2/git/repos/clone` | write / auth | `{projectId, url, path?, branch?, name?, sshKeyId?}` → 201 `RepoStatus`; SSH-URL без ключа → 400 `git.ssh_key_required`; занятый путь → 409 `git.repo_exists` |
| POST | `/api/v2/git/repos/register` | write / auth | `{projectId, path, name?, url?, type?, defaultBranch?, sshKeyId?}` → 200 `GitRepoConfig` (upsert по `id`/`path`) |
| POST | `/api/v2/git/repos/remove` | write / auth | `{projectId, id?\|path?, deleteLocal?}` → `{removed, deletedLocal}` (удаление локального каталога — `deleteLocal`) |
| POST | `/api/v2/git/repos/fetch` | write / auth | `{projectId, id?\|path?}` → `{path, lastFetch}`; SSH-URL без ключа → 400 `git.ssh_key_required` |
| GET | `/api/v2/git/log` | read / auth | `?project_id=&repo_path=&max_count=` → `{commits}` |
| GET | `/api/v2/git/commit` | read / auth | `?project_id=&repo_path=&hash=` → `{commit}` |

RBAC backend: write-эндпоинты (`init`/`clone`/`register`/`remove`/`fetch`) — owner/EDITOR/LEAD/ADMIN (`canEditProjectContent`), иначе 403; read (`scan`/`log`/`commit`) — право **чтения** проекта: owner/участник проекта/`LEAD`/`ADMIN` (`canReadProject`), иначе 403. Проверка — **граничный** guard (`projectGuard('read'|'write')` в core-фабрике `createGitRoutes`), т.е. **до** обработчика; правил доступа внутри обработчиков нет (инвариант 16). Core (standalone) — `requireAuth` (прав на проект в standalone нет).

> **Изменение поведения (managed).** Запрос к **несуществующему** `projectId` в `/api/v2/git/*` теперь даёт **403 вместо 404** — fail-closed, без раскрытия существования (как в FS-роутах). Раньше read-роуты (`scan`/`log`/`commit`) вообще не проверяли доступ и позволяли читать git-данные чужого проекта по его id.

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

> `config.auth` (PROP-107 Ф0) — ссылка на внешний доступ: `{kind:'credential', credentialId}`; коннектор авторизуется токеном из слоя доступов, сам токен в реестре/конфиге не лежит. Поле аддитивно — записи без `auth` валидны. Выдача/ротация доступов — Ф4 (`/api/v2/oauth/credentials`, ещё не реализовано).

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
| GET | `/api/v2/audit/security` | ADMIN/AUDITOR (core — auth) | Аудит изменений egress-политик, прокси и TLS (ADR-099): append-only `{dataDir}/audit/security.jsonl`; `?limit=` (дефолт 100, максимум 1000), `?scope=tools\|webhooks\|mcp\|proxy\|tls` → `{entries, count}` («свежие первыми»); записи `scope:"proxy"` — без пароля, URL redacted; `scope:"tls"` — пути/hosts/subject, без PEM/ключей |
| GET | `/api/v2/audit/egress` | ADMIN/AUDITOR (core — auth) | Журнал внешних запросов (ADR-099): append-only `{dataDir}/audit/egress.jsonl`; `?limit=` (дефолт 100, максимум 1000), `?scope=web_fetch\|web_search\|skills\|instructions\|webhooks\|providers\|mcp`, `?status=allowed\|blocked\|error` → `{entries, count}`; тела/заголовки не логируются; `via` (`proxy`\|`direct`\|`fallback`) — фактический маршрут |

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
| PUT | `/api/v2/settings/workspace` | ADMIN (managed) / auth (core) | `{workspace}` |
| DELETE | `/api/v2/settings/workspace` | ADMIN (managed) / auth (core) | Сброс runtime-override к дефолту; `{status:"restored", workspace, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/workspace-policy` | auth | Политика абсолютного workspace вне `workspacesRoot` (ADR-075): `{outsideRoot:"confirm"\|"deny", isOverridden, defaults, readOnly?}` (managed — `readOnly:true`, эффективно `deny`) |
| PUT | `/api/v2/settings/workspace-policy` | ADMIN (managed) / auth (core) | `{outsideRoot}` (live-применение, persist); невалидное значение → `400`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| DELETE | `/api/v2/settings/workspace-policy` | ADMIN (managed) / auth (core) | Сброс к config/env-дефолту; `{status:"restored", outsideRoot, isOverridden:false, defaults}`; managed → `403 WORKSPACE_POLICY_READ_ONLY` |
| GET | `/api/v2/settings/mcp` | auth | Доступность MCP по режимам: `{servers, isOverridden, defaults:{}}` |
| PUT | `/api/v2/settings/mcp` | ADMIN (managed) / auth (core) | `{servers}` |
| DELETE | `/api/v2/settings/mcp` | ADMIN (managed) / auth (core) | Сброс runtime-доступности MCP; `{status:"restored", servers:{}, isOverridden:false, defaults:{}}` |
| GET | `/api/v2/settings/default-agent` | auth | Агент по умолчанию (админка «Агенты»): `{defaultAgent, isOverridden, defaults}` (runtime из `settings.json`, иначе `DEFAULT_AGENT_ID` — `assistant` при первом развёртывании); используется при создании сессии без `settings.agentRole` и как `default_agent` в `/agents` |
| PUT | `/api/v2/settings/default-agent` | ADMIN (managed) / auth (core) | `{defaultAgent}` — id агента (`^[a-z0-9_-]+$`), persist; невалидный/пустой → 400 |
| DELETE | `/api/v2/settings/default-agent` | ADMIN (managed) / auth (core) | Сброс к дефолту; `{status:"restored", defaultAgent, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/default-model` | auth | Модель по умолчанию (админка «Модели») — **явная пара** `provider`+`model` уровня инстанса: `{defaultModel:{provider,model}\|null, isOverridden, defaults}` (runtime из `settings.json`, иначе `llm.defaultProvider`/`llm.defaultModel` из config.yaml — только если заданы оба поля; `null` — пара не задана); используется новыми сессиями и сессиями из внешних событий, а также для `isDefault`/`default_provider` в `/api/v2/models`/`/api/v2/providers` |
| PUT | `/api/v2/settings/default-model` | ADMIN (managed) / auth (core) | `{provider, model}` — persist + live-применение; пустые поля либо неизвестные провайдер/модель → `400 VALIDATION_ERROR`; `{defaultModel:{provider,model}}` |
| DELETE | `/api/v2/settings/default-model` | ADMIN (managed) / auth (core) | Сброс к config-fallback (`llm.defaultProvider`/`llm.defaultModel`); `{status:"restored", defaultModel, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/tools-policy` | auth | Политика включения **встроенных** инструментов (ADR-071 §2.3): `{toolsPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime из `settings.json`, иначе `tools.policy` из config.yaml; дефолт `auto`) |
| PUT | `/api/v2/settings/tools-policy` | ADMIN (managed) / auth (core) | `{toolsPolicy}` (live-применение, persist); неизвестное значение → 400 |
| DELETE | `/api/v2/settings/tools-policy` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", toolsPolicy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/mcp-policy` | auth | Политика включения **MCP**-инструментов (ADR-071 §2.3): `{mcpPolicy:"consistency"\|"available"\|"auto", isOverridden, defaults}` (runtime из `settings.json`, иначе `mcp.policy` из config.yaml; дефолт `auto`) |
| PUT | `/api/v2/settings/mcp-policy` | ADMIN (managed) / auth (core) | `{mcpPolicy}` (live-применение, persist); независима от `tools-policy`; неизвестное значение → 400 |
| DELETE | `/api/v2/settings/mcp-policy` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", mcpPolicy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/mcp-network-policy` | auth | Сетевая политика пользовательских HTTP/SSE MCP (ADR-071 §2.3.1; экземпляр общей egress-политики, ADR-099): `{policy:{mode:"deny"\|"allow",list:string[],exceptions:string[]}, isOverridden, defaults}` (дефолт — deny приватных диапазонов) |
| PUT | `/api/v2/settings/mcp-network-policy` | ADMIN (managed) / auth (core) | `{policy:{mode:"deny"\|"allow",list:string[],exceptions?:string[]}}` (live-применение, persist); невалидная запись → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/mcp-network-policy` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", policy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/egress/tools` | auth | Адресная egress-политика встроенных инструментов и внутренних потребителей (`web_fetch`/`web_search`, URL-скиллы/инструкции, иконки провайдеров; ADR-099): `{policy:{mode:"deny"\|"allow",list:string[],exceptions:string[]}, isOverridden, defaults}` |
| PUT | `/api/v2/settings/egress/tools` | ADMIN (managed) / auth (core) | `{policy}` (live-применение, persist); невалидная запись (hostname/`*.suffix`/CIDR) → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/egress/tools` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", policy, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/egress/webhooks` | auth | Адресная egress-политика исходящих webhooks (ADR-099): тот же формат + `mode:"off"` (dev: без проверок и без требования `https`) |
| PUT | `/api/v2/settings/egress/webhooks` | ADMIN (managed) / auth (core) | `{policy}` (live-применение, persist); невалидная запись → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/egress/webhooks` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", policy, isOverridden:false, defaults}` + live-применение дефолта |
| POST | `/api/v2/settings/egress/check` | ADMIN (managed) / auth (core) | Проверка URL **без выполнения запроса**: `{scope:"tools"\|"webhooks"\|"mcp", url}` → `{allowed, reason?, matchedRule?, addresses?, proxied, addressChecksActive, policy}` (разбор + DNS + сверка; для `webhooks` — требование `https`, кроме `mode:"off"`). При включённом прокси `proxied:true`, `addressChecksActive:false` — проверяются только схема и hostname-правила/`exceptions` (DNS/CIDR не выполняются) |
| GET | `/api/v2/settings/proxy` | auth | Настройки egress-прокси (ADR-099): плоские поля **saved** (`enabled, source:"env"\|"runtime"\|"config"\|"none", mode:"all"\|"selected", defaultProfile?, profiles:{"<name>":{label?,url?,httpProxy?,httpsProxy?,allProxy?,auth?:{type:"basic",username},tls?:{caFile?,certFile?,keyFile?,hasCaPem,rejectUnauthorized},legacy,source}}, rules:[{id,label?,hosts,action:"proxy"\|"direct",profile?}], url?, httpProxy?, httpsProxy?, allProxy?, noProxy, fromEnv, fallbackDirect, connectTimeoutMs, auth?, tls?`) + `{saved, running, defaults, isOverridden, password:{source:"env"\|"file"\|"none", set, removable}, restartRequired}` (top-level `restartRequired` — вычисленный: отпечаток saved ≠ running). URL — redacted (без userinfo/секретов); **`caPem` и PEM-содержимое, пароли и userinfo не возвращаются** (для `caPem` — только `hasCaPem`; у профиля — `password:{source,set,removable}`), пути `caFile`/`certFile`/`keyFile` отдаются |
| PUT | `/api/v2/settings/proxy` | ADMIN (managed) / auth (core) | Сохранить runtime-override `{proxy}` (валидация: `mode`/`profiles`/`rules` — имя профиля `^[a-z][a-z0-9_-]{0,31}$` и неизменяемо, `action:"direct"` без `profile`, `action:"proxy"` — существующий `profile`/`defaultProfile`, `mode:"selected"` — хотя бы одно правило, `mode:"all"` — default-профиль, host-паттерны; при `profiles` top-level URL/auth/tls запрещены; `auth.type` только `basic` — NTLM/Negotiate **вне scope** и делегируются egress-шлюзу (ADR-099 п. 25), пароль в userinfo URL запрещён, `caFile`↔`caPem`, `certFile`+`keyFile`); **live не применяет** (нужен рестарт); невалидно → 400 `VALIDATION_ERROR`; аудит `scope:"proxy"` (before/after без пароля) → `{saved, running, restartRequired:true}` |
| DELETE | `/api/v2/settings/proxy` | ADMIN (managed) / auth (core) | Сбросить runtime-override к `config.yaml`/env; аудит `scope:"proxy"` → `{status:"restored", saved, defaults, running, restartRequired}` |
| PUT | `/api/v2/settings/proxy/password` | ADMIN (managed) / auth (core) | Задать пароль Basic: `{password}` → файл `{dataDir}/secrets/proxy-password` (0600, каталог 0700, атомарно); значение не возвращается и не пишется в аудит; пустой пароль → 400; задан `SYNTH_PROXY_PASSWORD` → 409 `CONFLICT` → `{password:{source,set,removable}}` |
| DELETE | `/api/v2/settings/proxy/password` | ADMIN (managed) / auth (core) | Удалить файл пароля (идемпотентно, 0600); задан `SYNTH_PROXY_PASSWORD` → 409 `CONFLICT`; аудит `scope:"proxy"` (только статус, без значения) → `{password:{source,set,removable}}` |
| PUT | `/api/v2/settings/proxy/profiles/:name/password` | ADMIN (managed) / auth (core) | Пароль Basic **профиля**: `{password}` → `{dataDir}/secrets/proxy/<name>.password` (для `default` — legacy `secrets/proxy-password`; 0600, каталог 0700, атомарно). Нет профиля в saved-конфигурации → 404 `NOT_FOUND`; нет/пустой пароль → 400; env-пароль профиля (`SYNTH_PROXY_<NAME>_PASSWORD`) → 409 `CONFLICT`; значение не возвращается → `{password:{source,set,removable}}` |
| DELETE | `/api/v2/settings/proxy/profiles/:name/password` | ADMIN (managed) / auth (core) | Удалить файл пароля профиля (идемпотентно); нет профиля → 404; env-пароль → 409; аудит `scope:"proxy"` (только статус) → `{password:{source,set,removable}}` |
| PUT | `/api/v2/settings/proxy/profiles/:name/tls/ca` | ADMIN (managed) / auth (core) | CA-бандл **к прокси** для профиля: `{pem}` (1+ сертификатов) → `{dataDir}/secrets/proxy/<name>/ca.pem` (0600), в saved-конфиг пишется только `tls.caFile`; битый PEM → 400; нет профиля → 404; аудит `scope:"proxy"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/proxy/profiles/:name/tls/ca` | ADMIN (managed) / auth (core) | Удалить CA профиля (файл + `tls.caFile`/`caPem`); нет профиля → 404; аудит `scope:"proxy"` → `{status, restartRequired:true}` |
| PUT | `/api/v2/settings/proxy/profiles/:name/tls/client` | ADMIN (managed) / auth (core) | mTLS **к прокси** для профиля: `{certPem, keyPem}` (write-only, пара) → `secrets/proxy/<name>/{client.crt,client.key}` (0600), в конфиг — пути; неполная пара/битый PEM/ключ не от серта → 400; нет профиля → 404; аудит `scope:"proxy"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/proxy/profiles/:name/tls/client` | ADMIN (managed) / auth (core) | Удалить mTLS-клиент профиля (файлы + пути в конфиге); нет профиля → 404; аудит `scope:"proxy"` → `{status, restartRequired:true}` |
| POST | `/api/v2/settings/proxy/test` | ADMIN (managed) / auth (core) | Проверка **target URL** по saved-конфигурации: `{url}` (`http(s)`, без userinfo; иначе 400) → `{url, route:{action:"proxy"\|"direct", via, reason:"disabled"\|"no-proxy"\|"rule"\|"default"\|"no-match"\|"no-default", ruleId?, ruleLabel?, profile?, profileLabel?, proxyUrl?}, ok, httpStatus?, latencyMs, authChallenge, error?, usingSaved:true, restartRequired}`. `HEAD` без редиректов и тела; адресная политика `egress.tools` проверяется **до** запроса (отказ → `ok:false` + `route`, запрос не выполняется); TLS к цели — bootstrap `security.tls`. Не путать с `/proxy/check` (коннект к прокси) |
| POST | `/api/v2/settings/proxy/check` | ADMIN (managed) / auth (core) | Проверка **только коннекта к прокси** (не к цели): `{url?}` → `{reachable, latencyMs, authChallenge:"Basic"\|"NTLM"\|"Negotiate"\|"none", error?, usingSaved}`; `authChallenge: NTLM\|Negotiate` — **только диагностика**: Synth эти схемы не аутентифицирует (egress-шлюз, ADR-099 п. 25). Без `url` проверяется **saved**-конфигурация (`usingSaved:true`), иначе явный прокси; TCP/TLS/SOCKS-handshake, запрос к цели не выполняется; невалидный `url` (не строка) → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/settings/tls` | auth | Статус доверия TLS (ADR-099): плоские поля `status` + `{status, saved, running, defaults, restartRequired}`; `status` — `{ca:{source,count,subjects}, rejectUnauthorized, defaultClient?:{source,certSubject?,hasKey,readOnly}, mappings:[{id,hosts,label?,certSubject?,source,readOnly}], params:{ca?:{source,caFile?,hasPem}, client?:{source,certFile?,keyFile?,readOnly}}, running?:{applied,profileIds}, saved?:{bootstrap,profileIds}}`; **PEM/ключи не возвращаются**; `source` — `env`\|`runtime`\|`config`\|`none` |
| PUT | `/api/v2/settings/tls` | ADMIN (managed) / auth (core) | `{tls:{caFile?, caPem?, rejectUnauthorized?}}` — несекретные поля (CA-путь или PEM-бандл, взаимоисключающи; сертификаты/ключи — отдельными эндпоинтами); невалидно/неизвестное поле → 400 `VALIDATION_ERROR`; **live не применяет** → `{status, restartRequired:true}`; аудит `scope:"tls"` |
| PUT | `/api/v2/settings/tls/ca` | ADMIN (managed) / auth (core) | Загрузить/заменить CA-бандл: `{pem}` (1+ сертификатов) → файл `{dataDir}/secrets/tls/ca.pem` (0600); битый PEM → 400; CA задан env → 409 `CONFLICT` (read-only); аудит `scope:"tls"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/tls/ca` | ADMIN (managed) / auth (core) | Удалить runtime-CA (вернуться к config/env); CA задан env → 409 `CONFLICT`; аудит `scope:"tls"` → `{status, restartRequired:true}` |
| PUT | `/api/v2/settings/tls/client` | ADMIN (managed) / auth (core) | Задать **default** mTLS-клиент: `{certPem, keyPem}` (write-only, пара) → `secrets/tls/client.crt`/`client.key` (0600); неполная пара/битый PEM/ключ не от серта → 400; default задан env/config → 409 `CONFLICT` (read-only; override — только маппингом); аудит `scope:"tls"` → `{status, restartRequired:true}` |
| DELETE | `/api/v2/settings/tls/client` | ADMIN (managed) / auth (core) | Удалить default mTLS-клиент; default задан env/config → 409 `CONFLICT`; аудит `scope:"tls"` → `{status, restartRequired:true}` |
| POST | `/api/v2/settings/tls/mappings` | ADMIN (managed) / auth (core) | Добавить per-host профиль: `{hosts:string[] (host\|*.suffix\|*), certPem, keyPem, label?}` → `{mapping:{id,hosts,label?,certSubject?,source:"runtime",readOnly:false}, status, restartRequired:true}`; невалидные hosts/пара → 400 `VALIDATION_ERROR`; аудит `scope:"tls"` |
| PUT | `/api/v2/settings/tls/mappings/:id` | ADMIN (managed) / auth (core) | Обновить маппинг: `{hosts?, label? (null — сброс), certPem?, keyPem?}` (серт и ключ — оба либо ни одного); нет маппинга → 404 `NOT_FOUND`; невалидно → 400; аудит `scope:"tls"` → `{mapping, status, restartRequired:true}` |
| DELETE | `/api/v2/settings/tls/mappings/:id` | ADMIN (managed) / auth (core) | Удалить маппинг и его материалы; нет маппинга → 404 `NOT_FOUND`; аудит `scope:"tls"` → `{status, restartRequired:true}` |
| POST | `/api/v2/settings/tls/validate` | auth | Проверка **без записи**: `{caPem?, certPem?, keyPem?, hosts?}` → `{ok, caCount?, caSubjects?, certSubject?, keyMatches?, hostPatternsValid?, errors:string[]}` (парсинг CA/клиентской пары, сверка ключа с сертом, валидность host-паттернов); некорректный ввод — `ok:false` + `errors` (не 500) |
| GET | `/api/v2/settings/tools-disabled` | auth | Отключение встроенных инструментов (ADR-071 §2.6): `{toolsDisabled:{capabilities,tools}, isOverridden, defaults}` (runtime-значение из `settings.json`, иначе `tools.disabled` из config.yaml) |
| PUT | `/api/v2/settings/tools-disabled` | ADMIN (managed) / auth (core) | `{toolsDisabled:{capabilities:string[],tools:string[]}}` (live-применение, persist); неизвестная capability → 400, `runtime`-тулы неотключаемы. UI-раздел — ADMIN-категория |
| DELETE | `/api/v2/settings/tools-disabled` | ADMIN (managed) / auth (core) | Сброс к config-дефолту (по умолчанию пусто); `{status:"restored", toolsDisabled, isOverridden:false, defaults}` + live-применение дефолта |
| GET | `/api/v2/settings/llm-gateway` | auth | Эффективные настройки LLM Gateway: `{llmGateway:{enabled,inputMode,logPayloads,rateLimit}, isOverridden, defaults}` (runtime поверх config.yaml) |
| PUT | `/api/v2/settings/llm-gateway` | ADMIN (managed) / auth (core) | `{llmGateway}` (live-применение) |
| DELETE | `/api/v2/settings/llm-gateway` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", llmGateway, isOverridden:false, defaults}` + live-применение `{}` (шлюз из config.yaml) |
| GET | `/api/v2/settings/security` | auth | Эффективное `{protectedPaths, askTimeoutMs}` + `{isOverridden, defaults}` (runtime поверх config.yaml) |
| PUT | `/api/v2/settings/security` | ADMIN (managed) / auth (core) | `{security}` (live-применение) |
| DELETE | `/api/v2/settings/security` | ADMIN (managed) / auth (core) | Сброс к config-дефолту; `{status:"restored", security, isOverridden:false, defaults}` + live-применение `{}` |
| GET | `/api/v2/settings/protected-paths` | auth | `{policy, base, is_overridden}` |
| PUT | `/api/v2/settings/protected-paths` | ADMIN (managed) / auth (core) | `{policy}` или `{version, add, remove}` |
| DELETE | `/api/v2/settings/protected-paths` | ADMIN (managed) / auth (core) | Сброс к системной политике |
| GET | `/api/v2/settings/events` | auth | Runtime-настройки раздела «События» (ADR-089): `{events:{enabled, defaultMode, ephemeralTtl, journalRetentionDays, allowedSources, unknownAgentTemplate, keyRateLimitPerMinute, decisionRouting, autoBind, autoBindAgentTemplate}, defaults, isOverridden}` (runtime из `settings.json` поверх config.yaml `events`) |
| PUT | `/api/v2/settings/events` | ADMIN (managed) / auth (core) | Патч `{events:{…}}` (live-применение: Router/funnel/pruner переконфигурируются); невалидное значение → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/events` | ADMIN (managed) / auth (core) | Сброс runtime-настроек к config-дефолту; `{status:"restored", events, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/decision` | auth | Runtime-настройки decision-слоя (ADR-084): `{decision:{enabled, provider, model, confidenceThreshold, escalationProvider, escalationModel}, defaults, isOverridden}` (runtime из `settings.json` поверх config.yaml `decision`); `escalationProvider`/`escalationModel` — необязательный точный тир `primary → escalation` (пусто — без эскалации) |
| PUT | `/api/v2/settings/decision` | ADMIN (managed) / auth (core) | Патч `{decision:{…}}` (live-применение: микро-каскад/роутер/маршрутизация событий переконфигурируются); невалидное значение → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/decision` | ADMIN (managed) / auth (core) | Сброс runtime-настроек к config-дефолту; `{status:"restored", decision, isOverridden:false, defaults}` |
| GET | `/api/v2/settings/decision/metrics` | auth | Агрегатные in-memory метрики decision-слоя (ADR-084) → `{metrics, ts}`. Форма `metrics`: `{calls, handled, fallback, escalated, attempts:{primary, escalation}, rejected:{ok, low_confidence, invalid, no_answer, no_provider, error}, by_model:{"<provider>/<model>":{calls, handled, latency_ms_avg, latency_ms_max}}}`; сбрасываются при рестарте |
| DELETE | `/api/v2/settings/decision/metrics` | ADMIN (managed) / auth (core) | Сброс накопителей метрик decision-слоя → `{metrics}` (обнулённый снимок) |
| GET | `/api/v2/settings/metrics` | ADMIN (managed) / auth (core) | Настройки наблюдаемости (ADR-094): `{metrics:{enabled}, defaults:{enabled}, isOverridden, source:"env"\|"runtime"\|"config"\|"default", running, restartRequired, token:{configured,source:"env"\|"file"\|"none"}, endpoints:{metrics:"/metrics",ready:"/ready"}}`; приоритет `SYNTH_METRICS_ENABLED` > runtime > config > `false` |
| PUT | `/api/v2/settings/metrics` | ADMIN (managed) / auth (core) | `{metrics:{enabled:boolean}}` — runtime-override (`settings.json`/PG); **применяется после перезапуска** (`restartRequired`); не-boolean → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/settings/metrics` | ADMIN (managed) / auth (core) | Сброс runtime-значения к env/config/default (ответ как у `GET`) |
| GET | `/api/v2/settings/metrics/status` | ADMIN (managed) / auth (core) | Live-снимок: `{enabled, running, source, restartRequired, ready, storage:"ok"\|"degraded", storageBackend, version, uptimeSec, exposition:{series,bytes,droppedSeries}, token, endpoints}` |
| PUT | `/api/v2/settings/metrics/token` | ADMIN (managed) / auth (core) | Bearer-токен `/metrics` (write-only): `{token}` (после trim ≥16 символов) → `{dataDir}/secrets/metrics-token` (`0600`, атомарно), применяется **сразу**; короткий/пустой → 400 `VALIDATION_ERROR`; токен из env → 409 `CONFLICT`; значение не возвращается |
| DELETE | `/api/v2/settings/metrics/token` | ADMIN (managed) / auth (core) | Удалить файл токена (идемпотентно) → `{token:{configured,source}}`; токен из env → 409 `CONFLICT` |

> **Адресная egress-политика (ADR-099).** `egress.tools`/`egress.webhooks`/`mcp.networkPolicy` — единый
> формат `{mode, list, exceptions}`: `exceptions` проверяются первыми (hostname, `*.suffix`, IP/CIDR),
> `deny` — блок при любом запрещённом resolved-адресе, `allow` — только если разрешены все адреса;
> `off` — только webhooks. Политика применяется **live** (per-request, без рестарта) и **не смешивается**
> между скоупами (tools ≠ webhooks ≠ MCP); изменения пишутся в `audit/security.jsonl`, запросы — в
> `audit/egress.jsonl` (поле `via` — `proxy`/`direct`/`fallback`). При включённом прокси адресная
> проверка выполняется в proxied-режиме (`settings/egress/check` → `proxied`/`addressChecksActive`).
> Провайдеры LLM в журнал egress не входят (у них свой LLM audit/payload-лог).

> **Профили и правила прокси (ADR-099 п. 27).** `mode: all` — `defaultProfile` для всех хостов, кроме
> `noProxy`; `selected` — только `rules` (остальное напрямую). Правила проверяются в порядке объявления
> (**первое совпадение**), `noProxy` важнее правил; `action: direct` несовместим с `profile`; CIDR
> матчится только по IP-литералу цели. `profiles`/`rules` — runtime-значение заменяет config **целиком**
> (не поле-уровневое слияние); при заданных `profiles` top-level URL/auth/tls и env-URL запрещены.
> Пароли и TLS-материалы профилей — write-only (`PUT/DELETE .../profiles/:name/{password,tls/ca,tls/client}`),
> значения/PEM не возвращаются. `POST /settings/proxy/test` проверяет **цель** (в отличие от `/proxy/check` —
> коннект к прокси) и показывает сработавший маршрут; оба работают по **saved**-конфигурации.

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
| POST | `/api/v2/events/routes` | оба | LEAD/ADMIN | Upsert правила (`eventRouteRuleUpsertSchema`): `{id?, name?, priority?, enabled?, match, target}`; `match` — AND по заполненным `source`/`type`/`chatKey`/`threadKey`/`principalId`/`label`/`keywords` (пустой-невалидный не матчит); `target` — `bound`/`queue` (`sessionId`), `ephemeral` (`agentTemplate?`/`project?`/`ttl?`) или `bind` (ADR-089 auto-bind: `agentTemplate?`/`project?` — закрепить чат/тред за новой сессией); в `ephemeral`/`bind` допустимо необязательное поле `pipeline?: {id, step}` — **ссылка на шаг пайплайна: эта сессия — шаг `step` пайплайна `id`** (в `bound`/`queue` поле отвергается — 400 `VALIDATION_ERROR`). По `id` — обновление → 200, иначе создание → 201. Валидация: `bound`/`queue` с несуществующей сессией → 400, непустой `agentTemplate` без enabled-агента → 400 `VALIDATION_ERROR` |
| DELETE | `/api/v2/events/routes/:id` | оба | LEAD/ADMIN | Удалить правило → 204; нет записи → 404 `NOT_FOUND` |
| GET | `/api/v2/events/journal` | оба | auth | Последние записи журнала решений `{entries}`; `?limit=` (default 50, cap 500) |

`identity` — `{principalId?, chatKey?, threadKey?, roles?}`. `dedupKey`/`ts` опциональны:
`EventIngress` нормализует событие (id `evt_<uuid>`, дефолтный dedup-ключ по
source/type/ключу/payload). RBAC managed: приём — API-ключ привязки либо `requireAuth` +
rate limit (120/мин); мутации привязок/правил/ключей — `requirePermission('ADMIN','LEAD')`,
чтение ключей привязки — LEAD/ADMIN, остальное чтение — `requireAuth`; в core — единый `requireAuth`.
**Scope service-key (ADR-052):** `POST /` — `events:ingest`; `GET /` (SSE) и `GET /journal` —
`events:watch`; список/мутации привязок — `bindings:read`/`bindings:write`; ключи привязок —
`keys:read`/`keys:write`; правила — `routes:read`/`routes:write`. Запись правил
маршрутизации (`POST`/`DELETE /routes`) доступна service-key с `routes:write`
**или** `automation:install` (зонтичный scope установщика пакетов расширений —
достаточно **любого** из двух; в managed scope-гейт действует **сверх**
ролевого гейта — ключу дополнительно нужна роль `LEAD`/`ADMIN`). Если у ключа задан
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
**Ссылка на шаг пайплайна (`pipeline`).** В цели правила (`ephemeral`/`bind`) допустимо
необязательное поле `pipeline?: { id, step }` — «ссылка на шаг пайплайна: эта сессия —
шаг `step` пайплайна `id`». Ссылка **семантическая**, а не диагностическая: на ней
строится учёт экземпляров пайплайна и гейты (напр. правило по событию
`draft_approved` — гейт «после approve»). Она прокидывается в решение Router'а
(`decision.pipeline`) и в журнал решений. В целях `bound`/`queue` сессия
фиксирована, поэтому поле там **отвергается** (400 `VALIDATION_ERROR`), а не
игнорируется.
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
`schedules:write` (`POST`/`PUT`/`DELETE`/`POST /:id/run`); запись расписаний доступна
service-key с `schedules:write` **или** `automation:install` (зонтичный scope
установщика пакетов расширений — достаточно **любого** из двух: расписание,
порождаемое пакетом, пишется его установщиком; в managed scope-гейт действует
**сверх** ролевого гейта — ключу дополнительно нужна роль `ADMIN`); проектная проекция — по цели
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
| POST | `/api/v2/webhooks` | оба | ADMIN / auth | Создать (`webhookSubscriptionCreateSchema`): `{label, description?, url, events?, enabled?}` → 201 `WebhookSubscriptionCreated` = метаданные + `secret` (plaintext `whsec_<base64url>`, показывается **один раз**); невалидное тело/URL → 400 `VALIDATION_ERROR`; URL вне политики `egress.webhooks` → 400; дубль метки → 409 `CONFLICT`; мастер выключен → 503 `UNAVAILABLE` |
| GET | `/api/v2/webhooks/:id` | оба | ADMIN / auth | Метаданные подписки; нет подписки → 404 `NOT_FOUND` |
| PATCH | `/api/v2/webhooks/:id` | оба | ADMIN / auth | Обновить (`webhookSubscriptionUpdateSchema`): `{label?, description?, url?, events?, enabled?}`; `null` для `description` — сброс, `undefined` — не трогать; смена метки проверяется на уникальность → 200; нет подписки → 404; дубль → 409; URL вне политики `egress.webhooks` → 400 |
| DELETE | `/api/v2/webhooks/:id` | оба | ADMIN / auth | Удалить подписку → 204; нет записи → 404 |
| POST | `/api/v2/webhooks/:id/regenerate` | оба | ADMIN / auth | Ротация signing-секрета → 200 `WebhookSubscriptionCreated` (+ `secret` единожды); нет подписки → 404 |
| POST | `/api/v2/webhooks/:id/revoke` | оба | ADMIN / auth | Мягкое отключение (`enabled=false`, `disabledAt`; идемпотентно) → 200 метаданные; нет записи → 404 |
| POST | `/api/v2/webhooks/:id/test` | оба | ADMIN / auth | Тестовая доставка синтетического события `webhook.test` (в обход фильтра и дедупа) → 200 `WebhookDelivery`; нет подписки/движка → 404; мастер выключен → 503 |
| GET | `/api/v2/webhooks/:id/deliveries` | оба | ADMIN / auth | Журнал доставок подписки `{deliveries}` (`WebhookDelivery[]`); `?limit=` (default 50, cap 500); нет подписки → 404 |

**Поля подписки** (`WebhookSubscription`): `id` (`whk_<uuid>`), `label` (обязательна; уникальна
глобально по инстансу, регистронезависимо), `description?`, `url` (только http(s); по умолчанию —
`https` + адресная политика `egress.webhooks` (ADR-099): `deny` приватных/loopback-адресов по `list`,
разрешение — через `exceptions`; `mode:"off"` — только dev, снимает и требование `https`), `events: string[]` (паттерны: точный тип
`stream.done` либо префикс `session.*`; пусто — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), `enabled`,
`secretPrefix`, `createdBy`/`createdAt`, `lastDeliveryAt?`/`lastStatus?`, `disabledAt?`.
**Доставка:** POST `{id, type, createdAt, data}` с заголовками `X-Synth-Event`/`X-Synth-Delivery`/
`X-Synth-Signature`; HMAC-SHA256 (`t=<unix>,v1=<hex>`, окно timestamp 300 c); retry/backoff
(экспоненциальный с джиттером, `webhooks.maxAttempts`), таймаут запроса (`webhooks.timeoutMs`),
дедуп по (подписка + событие), журнал + retention (`webhooks.deliveryRetentionDays`). Неуспех —
запись `status:'failed'` в журнале. Доставка идёт через общий egress-слой: при включённом прокси запрос
уходит через него (`via` в журнале egress), при `noProxy` — напрямую с полной адресной проверкой. Конфиг — `docs/CONFIGURATION.md` (секция `webhooks`); устройство —
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

### 5.31 Обслуживание инстанса — `/api/v2/maintenance` (оба, ADR-091/ADR-092)

Admin-API обслуживания инстанса: health (`synth doctor`), версия схемы данных и миграции,
бэкапы и восстановление. Единая фабрика `createMaintenanceRoutes` для core и backend;
сервисный слой — `packages/core/src/maintenance/service.ts`. RBAC: managed (backend) —
только `ADMIN` на чтение и мутации; core (standalone) — единый `requireAuth`. Архивы
ищутся строго в `{dataDir}/backups/` (включая `backups/uploads/`); имя — только basename
`*.tar.gz`, абсолютные пути от клиента не принимаются. Архив с `withSecrets` — **сам
секрет**.

**Ключевая семантика — восстановление офлайн.** `POST /restore` **не выполняет**
восстановление: он лишь планирует его (запрос `{dataDir}/maintenance/restore-request.json`,
атомарно) и отвечает `{pending, appliesOnNextStart: true}`. Применение — при следующем
старте инстанса (`applyPendingRestore`, до миграций). Под живым процессом каталог данных
не вычищается. Деструктивные операции (применение миграций, планирование восстановления)
требуют `{confirm: true}`.

| Метод | Путь | Сборка | RBAC (managed / core) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/maintenance/status` | оба | ADMIN / auth | Сводный статус: `{version, dataDir, schema:{current, expected, applied, pending}, backups, pendingRestore, doctor:{ok, fail, warn}}` |
| GET | `/api/v2/maintenance/doctor` | оба | ADMIN / auth | Полный прогон `synth doctor`: `{ok, checks:[{id, title, status, detail?, hint?}], dataDir, version}` (`ok: false` при любом `fail`) |
| GET | `/api/v2/maintenance/migrations` | оба | ADMIN / auth | Состояние схемы данных: `{current, expected, applied, pending:[{id, toVersion, description}]}` |
| POST | `/api/v2/maintenance/migrations/apply` | оба | ADMIN / auth | Применить pending-миграции; тело `{confirm: true}` обязательно (иначе 400 `VALIDATION_ERROR`); перед записью обязательна страховочная копия (fail-closed), применение под локом → 200 `{applied, safetyCopyPath?}`; данные новее пакета → 409 `CONFLICT` (код `SCHEMA_TOO_NEW`) |
| GET | `/api/v2/maintenance/backups` | оба | ADMIN / auth | Список архивов `{backups}` (`MaintenanceBackupInfo[]`, свежие сверху) |
| POST | `/api/v2/maintenance/backups` | оба | ADMIN / auth | Снять архив: `{withSecrets?, withWorkspace?, live?}` (по умолчанию все `false`; `live` — нетранзакционный срез с работающего сервиса) → 200 `MaintenanceBackupInfo`; архив пишется в `{dataDir}/backups/` (исключён из самих архивов) |
| GET | `/api/v2/maintenance/backups/:name/download` | оба | ADMIN / auth | Скачать архив (стриминг): `Content-Type: application/gzip`, `Content-Disposition: attachment`, `Content-Length`; небезопасное имя → 400; нет файла → 404 |
| DELETE | `/api/v2/maintenance/backups/:name` | оба | ADMIN / auth | Удалить архив → 204; небезопасное имя → 400; нет файла → 404 |
| POST | `/api/v2/maintenance/restore/validate` | оба | ADMIN / auth | Проверить архив восстановления: JSON `{archive}` (имя из `backups/`) **или** multipart `file` (загрузка в `backups/uploads/`); → 200 `{ok, problem?, manifest?}` (+ `staged` для загрузки); превышение лимита загрузки → 413 `PAYLOAD_TOO_LARGE`; невалидное тело/имя → 400; нет архива → 404 |
| GET | `/api/v2/maintenance/restore` | оба | ADMIN / auth | Отложенный запрос на восстановление `{pending}` (`PendingRestoreRequest \| null`) |
| POST | `/api/v2/maintenance/restore` | оба | ADMIN / auth | Спланировать восстановление: `{archive, confirm: true, safetyCopy?}` (`confirm` обязателен; `safetyCopy` по умолчанию `true`) → 201 `{pending, appliesOnNextStart: true}`; архив не прошёл проверку → 400 `VALIDATION_ERROR`; нет архива → 404 |
| DELETE | `/api/v2/maintenance/restore` | оба | ADMIN / auth | Отменить отложенный запрос → 200 `{cancelled}` |
| GET | `/api/v2/maintenance/restart` | оба | ADMIN / auth | Статус graceful restart (ADR-092): `{supported, mode:"disabled"\|"process"\|"supervisor", reason?, startedAt, version}`; `supported:false` — рестарт недоступен (UI не показывает кнопку) |
| POST | `/api/v2/maintenance/restart` | оба | ADMIN / auth | Graceful restart инстанса: `{confirm: true}` (иначе 400 `VALIDATION_ERROR`) → **202** `{status:"restarting", restartId, mode, startedAt}`; процесс завершается с кодом **75** (супервизор поднимает заново); повторный вызов до выхода идемпотентен (тот же `restartId`, 202); режим `disabled` → 409 `RESTART_UNSUPPORTED`; аудит `restart.requested` (status `scheduled`, `details:{mode, restartId}`) |
| GET | `/api/v2/maintenance/audit` | оба | ADMIN / auth | Журнал обслуживания: `{entries: MaintenanceAuditEntry[]}` («свежие первыми»); query `limit` (целое 1..500, дефолт 50) и `op` (вид операции); невалидные `limit`/`op` → 400 `VALIDATION_ERROR`; порт не подключён → пустой список (не 500) |
| DELETE | `/api/v2/maintenance/audit` | оба | ADMIN / auth | Очистить журнал; тело `{confirm: true}` обязательно (иначе 400 `VALIDATION_ERROR`) → 200 `{cleared}`; порт не подключён → `{cleared: 0}` |

**Поля `MaintenanceBackupInfo`:** `name` (basename), `path`, `bytes`, `createdAt`,
`schemaVersion` (из манифеста), `instanceVersion`, `withSecrets`, `withWorkspace`, `entries`
(число записей манифеста), `encrypted?` (ADR-091: архив зашифрован), `metadataAvailable?`
(для `.enc`: sidecar-метаданные есть и валидны). **`PendingRestoreRequest`:** `archive` (абсолютный путь только
внутри `{dataDir}/backups/`), `requestedBy?`, `requestedAt`, `safetyCopy`.

**Зашифрованные архивы (ADR-091).** Архив, снятый CLI-командой `synth backup --encrypt`, — это
контейнер `<archive>.tar.gz.enc` (+ плейнтекст-sidecar `<archive>.tar.gz.enc.meta.json` со сводкой
без путей и хешей). Такие архивы видны в `GET /backups` (`encrypted: true`; при отсутствии или
повреждении sidecar — `metadataAvailable: false`, «метаданные недоступны»), их можно скачать и
удалить по API, но **восстановить через API нельзя**: `POST /restore` по `.enc` отвечает
400 `VALIDATION_ERROR` («расшифровка доступна только через CLI»), а `POST /restore/validate` —
`{ok:false, problem}`. Расшифровка — только в CLI (`synth restore <archive>.enc`, ключ оператора);
опцию `encrypt` `POST /backups` **не поддерживает** — сервер ключом не располагает.

**Аудит-журнал обслуживания (ADR-092).** `MaintenanceAuditEntry` — append-only запись
жизненного цикла: `id` (`ma_<uuid>`), `ts` (ISO-8601), `op` (`backup.created`/`backup.failed`/
`backup.deleted`/`restore.scheduled`/`restore.cancelled`/`restore.applied`/`restore.failed`/`migrate.applied`/
`migrate.failed`/`update.applied`/`rollback.applied`/`update.failed`/`restart.requested`/`uninstall.purge`/
`export.created`/`import.applied`), `status` (`ok`/`failed`/`scheduled`), `actor?` (инициатор:
`userId` при API/UI, `cli` при командной строке, `startup` при применении на старте), `version?`
(`SYNTH_VERSION`), `details?` (поля зависят от `op`), `error?` (при `status: failed`). Записи
пишутся best-effort из самих операций (`recordMaintenanceAudit`) и отдаются через доменный порт
`MaintenanceAuditRepository` (`{dataDir}/audit/maintenance.jsonl`, ADR-096). RBAC — как у всего
раздела: managed — `ADMIN`, standalone — `requireAuth`.

**Лимит загрузки.** Multipart `POST /restore/validate` ограничен `storage.maxUploadBytes`
(по умолчанию 100 МиБ, `DEFAULT_MAX_UPLOAD_BYTES`); DoS-защита проверяет заявленный
`content-length`, размер `File` и фактически прочитанные байты — превышение → 413
`PAYLOAD_TOO_LARGE`.

**Коды ошибок.** 400 `VALIDATION_ERROR` (невалидное тело/имя архива, отсутствие
`confirm: true`, архив не прошёл проверку), 404 `NOT_FOUND` (нет архива/записи), 413
`PAYLOAD_TOO_LARGE` (превышен лимит загрузки), 409 `CONFLICT` с кодом `SCHEMA_TOO_NEW`
(данные новее версии Synth при применении миграций) или `RESTART_UNSUPPORTED`
(`SYNTH_RESTART_MODE=disabled` — рестарт недоступен), 401/403 (нет кред/недостаточно прав).
Успешный `POST /restart` — **202** (запрос принят; процесс завершится через ~50 мс).

**Пример.**

```bash
# Сводный статус и полный synth doctor (ADMIN).
curl http://localhost:5000/api/v2/maintenance/status -H 'Authorization: Bearer <ADMIN_TOKEN>'
curl http://localhost:5000/api/v2/maintenance/doctor -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Создать архив (без секретов и workspaces) и скачать его.
curl -X POST http://localhost:5000/api/v2/maintenance/backups \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"withSecrets":false,"withWorkspace":false,"live":false}'
curl -OJ http://localhost:5000/api/v2/maintenance/backups/<name>.tar.gz/download \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Проверить архив и запланировать восстановление (применится при следующем старте).
curl -X POST http://localhost:5000/api/v2/maintenance/restore/validate \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"archive":"synth-backup-<instanceVersion>-<stamp>.tar.gz"}'
curl -X POST http://localhost:5000/api/v2/maintenance/restore \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"archive":"synth-backup-<instanceVersion>-<stamp>.tar.gz","confirm":true}'

# Применить миграции схемы (необратимо; перед записью — страховочная копия).
curl -X POST http://localhost:5000/api/v2/maintenance/migrations/apply \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' -d '{"confirm":true}'

# Отменить отложенное восстановление.
curl -X DELETE http://localhost:5000/api/v2/maintenance/restore \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Прочитать журнал обслуживания (последние 5 записей).
curl 'http://localhost:5000/api/v2/maintenance/audit?limit=5' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Перезапуск инстанса (graceful shutdown, exit 75 → супервизор поднимает процесс).
curl http://localhost:5000/api/v2/maintenance/restart -H 'Authorization: Bearer <ADMIN_TOKEN>'
curl -X POST http://localhost:5000/api/v2/maintenance/restart \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"confirm":true}'
```

**UI.** Раздел «Обслуживание» (Настройки → «Обслуживание», только `ADMIN`) построен на этих
же ручках (`packages/ui/src/components/settings/MaintenanceSettings.tsx`, API-домен
`packages/ui/src/lib/api/maintenance.ts`): статус/`synth doctor`, схема и миграции, бэкапы,
восстановление, **«Перезапуск»** (статус режима, подтверждение, оверлей и опрос `GET /health`
до нового `startedAt`, затем reload). Процедуры и правила безопасности —
[docs/MAINTENANCE.md](./MAINTENANCE.md).

### 5.32 Аналитика и отчётность — `/api/v2/analytics` (оба, ADR-102)

Отчёты по **пред-агрегированным суточным роллапам** (единица — сутки UTC): сервис
читает роллапы через доменный порт `AnalyticsRollupRepository` (ADR-096) и считает
дериваты **на чтении**. Единая фабрика `createAnalyticsRoutes` для core и backend;
RBAC/скоуп и i18n задаются через `opts` (`resolveElevated`/`resolveAuditor`/
`resolveUserId`/`messages`). Поверхность — **только чтение**, мутирующих ручек нет.
Семантика записи, источников и retention — [CONFIGURATION.md](./CONFIGURATION.md)
§«Аналитика и отчётность»; бэкфилл — [MAINTENANCE.md](./MAINTENANCE.md)
§«Аналитика: пересборка роллапов».

| Метод | Путь | Сборка | RBAC (managed / core) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/analytics/summary` | оба | ADMIN/LEAD/AUDITOR / auth | Сводка инстанса за период: `AnalyticsSummary` (`{from, to, usage, activity, decision, costByCurrency?}`). Сквозная — обычному пользователю **403** |
| GET | `/api/v2/analytics/usage` | оба | все (USER — свои строки) / auth | Токены, запросы, сообщения, длительность и стоимость по осям + дериваты; `AnalyticsReport` |
| GET | `/api/v2/analytics/activity` | оба | все (USER — свои строки) / auth | Сессии/сообщения/инструменты/ошибки/ходы; сырые меры (без дериватов) |
| GET | `/api/v2/analytics/decision` | оба | ADMIN/LEAD/AUDITOR / auth | Персистентные метрики decision-слоя (ADR-084); сквозной отчёт без оси `user` — обычному пользователю **403** |
| GET | `/api/v2/analytics/prompt` | оба | все (USER — свои строки) / auth | Производное чтение семейства `usage`: кэш, reasoning, output tps; дефолтная группировка — `model,agent` |
| GET | `/api/v2/analytics/export` | оба | как у отчёта-источника | Выгрузка отчёта `report=usage\|activity\|decision\|prompt` + `format=csv\|json`; `Content-Disposition: attachment` |

**Параметры запроса.** `from`/`to` — границы периода **включительно**, дата
`YYYY-MM-DD` (UTC); по умолчанию `to` — сегодня (UTC), `from` — `to` минус 29 дней
(окно 30 дней включительно). Обе даты валидируются как реальные даты UTC; `from > to`
→ 400. `groupBy` — оси через запятую (`day,user,project,model,agent,provider`);
неизвестная ось → 400, дубликаты сохраняют первое вхождение; пусто/не задано — одна
итоговая строка (`dimensions: {}`), кроме `prompt` (там дефолт `model,agent`).
Фильтры по равенству осей — `userId`, `projectId`, `model`, `agent` (пустые значения
игнорируются; фильтра по `provider` в query нет). `export` дополнительно принимает
`report` и `format` (оба обязательны; неизвестное значение → 400).

**Оси по семействам.** Валидация `groupBy` общая (все шесть осей), но набор реально
записанных осей зависит от семейства; ось, которой в бакете нет, не попадает в
`dimensions` строки (значение пустое):

| Семейство | Оси бакета | Меры |
|---|---|---|
| `usage` | `day`, `user`, `project`, `model`, `agent` (ось `provider` поддерживается записью, в текущей проводке не передаётся) | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `requests`, `messages`, `duration_ms` |
| `activity` | `day`, `user`, `project` | `sessions_created`, `sessions_archived`, `messages_user`, `messages_assistant`, `messages_tool`, `tool_calls`, `errors`, `aborts`, `turns` |
| `decision` | `day`, `provider`, `model` | `calls`, `handled`, `fallback`, `escalated`, `attempts`, `rejected` |
| `prompt` | `day`, `user`, `project`, `model`, `agent` (проекция `usage`) | те же, что у `usage` |

**Форма ответа.** `AnalyticsReport` — `{report, from, to, groupBy, rows}`; строка
`AnalyticsReportRow` — `{dimensions, measures, costByCurrency?}`. `dimensions` —
значения осей группировки (итоговая строка — `{}`); `measures` — суммы сырых счётчиков
snake_case **плюс дериваты** для `usage`/`prompt`; `costByCurrency` — разбивка
стоимости по валютам (`currency → сумма`), пустая — поле опускается. Порядок строк —
лексикографический по осям группировки. `AnalyticsSummary` агрегирует итоги по
периоду: `usage` (с дериватами), `activity`, `decision`, `costByCurrency?`.

**Дериваты (только `usage`/`prompt`, считаются на чтении, не персистятся).**

| Дериват | Формула | Нулевой знаменатель |
|---|---|---|
| `total_tokens` | `input_tokens + output_tokens` | — |
| `cache_hit_rate` | `cache_read_tokens / input_tokens` | `0` |
| `reasoning_ratio` | `reasoning_tokens / output_tokens` | `0` |
| `output_tps` | `output_tokens / (duration_ms / 1000)` | `0` |

**RBAC (managed).** `ADMIN`/`LEAD` — сквозной обзор без фильтра по себе; `AUDITOR` —
чтение всех отчётов, включая `summary`/`decision`; обычный пользователь — сервер
**принудительно** подставляет его `userId` в ось `user` для `usage`/`activity`/`prompt`
(query-параметр `userId` игнорируется), а `summary`, `decision` и экспорт `decision`
отдают **403 `FORBIDDEN`**. Экспорт приравнен к чтению: отдельного права нет; scope
`analytics:read` для service-key не вводился (ADR-052). В core (standalone) —
`requireAuth`, единственный ключ трактуется как ADMIN (сквозной обзор,
`resolveUserId = 'local'`).

**Запись и retention.** Роллапы пишутся best-effort на существующих швах (сохранение
ответа, жизненный цикл сессии/инструментов через hook-шину, decision-каскад) и **не
влияют на ход**; в деградированном режиме хранилища запись выключена. Данные
агрегированы: текста сообщений, содержимого промптов, ключей и PII в значениях нет.
Срок хранения — `analytics.retentionDays` (default `400`; `<= 0` — без ограничения),
чистка — на старте и каждые 6 часов; файловый backend — `{dataDir}/analytics/rollups.json`,
PostgreSQL — таблица `analytics_rollups` (миграция 003).

**Экспорт.** Имя файла — `analytics-<report>-<from>_<to>.<format>`; CSV —
`text/csv; charset=utf-8`, JSON — `application/json; charset=utf-8`, оба с
`Content-Disposition: attachment; filename="…"`. CSV — RFC 4180 (запятая, `\r\n`,
экранирование кавычками) с BOM UTF-8; колонки: оси группировки → сырые меры семейства
(стабильный список, для `prompt` — список `usage`; прочие встреченные меры — в конце по
алфавиту) → `cost_<валюта>` (по алфавиту) → дериваты (`usage`/`prompt`). При непустой
группировке и непустых данных добавляется итоговая строка `TOTAL`: суммы сырых
счётчиков и стоимостей, дериваты **пересчитываются** из просуммированных счётчиков.
JSON — `AnalyticsReport` как есть (`JSON.stringify(…, null, 2)`). Серверных PDF/XLSX нет
(печать — на клиенте).

**Коды ошибок.** 400 `VALIDATION_ERROR` — некорректная дата (`period`), `from > to`
(`range`), неизвестная ось `groupBy`, отсутствующий/неизвестный `report`/`format`;
401 `UNAUTHORIZED` — нет кред; 403 `FORBIDDEN` — `summary`/`decision` (и экспорт
`decision`) обычному пользователю.

**Пример.**

```bash
# Расход за 30 дней с группировкой по пользователю и модели.
curl 'http://localhost:5000/api/v2/analytics/usage?from=2026-09-19&to=2026-10-18&groupBy=user,model' \
  -H 'Authorization: Bearer <TOKEN>'

# Сводка инстанса (ADMIN/LEAD/AUDITOR) и метрики decision-слоя.
curl 'http://localhost:5000/api/v2/analytics/summary?from=2026-09-19&to=2026-10-18' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Выгрузка отчёта: CSV с BOM и итоговой строкой TOTAL.
curl -OJ 'http://localhost:5000/api/v2/analytics/export?report=usage&format=csv&groupBy=day' \
  -H 'Authorization: Bearer <TOKEN>'
```

**UI.** Модальное окно «Аналитика и отчёты» (ленивый `AnalyticsModal`, входы — меню
пользователя и кнопка в правой панели): вкладки «Расход и стоимость», «Активность»,
«Decision», «Кэш и эффективность», пресеты `7d`/`30d`/`90d`/`custom`, фильтры
user/project/model/agent, кнопки CSV/JSON и печать браузера. Подробности —
[packages/ui/AGENTS.md](../packages/ui/AGENTS.md) §«Аналитика и отчёты».

---

### 5.33 Пакеты расширений — `/api/v2/packs` (оба, ADR-100)

Реестр **установок пакетов расширения** (манифест `synth.pack`, ADR-086 §5) и установка
пакета **одной операцией**. Единая фабрика `createPacksRoutes` для core и backend;
RBAC/скоуп и i18n задаются через `opts` (`readGuard`/`writeGuard`/`approveGuard`/
`uninstallGuard`/`scopeGuard`/`messages`). Хранилище — порт `PackRepository`
(`{dataDir}/packs.json`).

Порядок установки (идемпотентный upsert по имени пакета): **скиллы** → **MCP-запись реестра**
(`origin: 'instance'`, `enabledByDefault: true`) → **агенты** (роль `{dataDir}/context/roles/<file>`
пишется **до** агента — fail-closed) → **определения пайплайнов** → **правила маршрутизации**,
порождённые из шагов с `waitsFor` (`match = waitsFor`,
`target = {mode: 'ephemeral', agentTemplate, pipeline: {id, step}}`).

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/packs` | оба | ADMIN / auth | Список установок `{packs}`: имя, версия, `kind`, `status` (`active\|pending_approval\|disabled`), `requiresApproval`, `provides` (id'ы агентов/скиллов/MCP/пайплайнов), `installedBy` |
| GET | `/api/v2/packs/:name` | оба | ADMIN / auth | Одна установка (включая сырой манифест и файлы пакета) |
| POST | `/api/v2/packs` | оба | ADMIN **или** scope `automation:install` | Установка: тело `{manifest, files}` (манифест + карта файлов пакета). Некорректный манифест → 400 `VALIDATION_ERROR` со списком `problems`; нехватка файлов → 400. → **201** `{installed: true, requiresApproval: false, name, version, provides}`; пакет с capability-грантами → **202** `{installed: false, requiresApproval: true, …}` (фактическая установка **не** выполняется) |
| POST | `/api/v2/packs/:name/approve` | оба | **только ADMIN** | Одобрение пакета в статусе `pending_approval` → 200 `{installed: true, …}`; нет записи → 404; статус не `pending_approval` → 409 `CONFLICT` |
| DELETE | `/api/v2/packs/:name` | оба | **только ADMIN** | Снятие установки вместе с поставленными артефактами (агент + роль, скилл, MCP-запись, определение пайплайна, порождённые правила) → 204; идемпотентно (нет пакета — тоже 204) |

**Одобрение.** Пакет требует подтверждения администратора, если он выдаёт агенту непустые
`capabilities`, объявляет пайплайны (порождаемые правила маршрутизации) или расписания. Ответ
**202** — не ошибка: фактическую установку выполняет `POST /api/v2/packs/:name/approve` (по
сохранённым в реестре манифесту и файлам — обойти проверку целостности манифеста нельзя).

**Скоупы (ADR-052).** Зонутный `automation:install` — установщик пакетов расширений: агенты и их
ролевые промпты, пайплайны, порождаемые пакетом правила маршрутизации и расписания (на
ресурсных гейтах заменяет `routes:write`/`schedules:write`; `addons:install` создание агентов
**не** открывает). Гейты: `requireScopeOrAdminRole` (core), `requireAdminRoleOrScope` (backend).
Одобрение и снятие — только роль ADMIN (они снимают чужие артефакты инстанса).

### 5.34 Пайплайны — `/api/v2/pipelines` (оба, ADR-100/ADR-051)

> ⚠️ **ADR-100, устаревает.** Новые эндпоинты пайплайнов (спецификации, версии, прогоны,
> журнал, шаблоны инстанса) — **§5.35**. Старые эндпоинты этого раздела **остаются
> рабочими** (UI уже переведён на новый контур — ADR-101 §5.35); удаления не планируется.

Пайплайн в этом разделе — **декларация + учёт прогона** (собственного движка шагов в этих эндпоинтах нет).
Целевая модель — «пайплайн как второй движок» ([ADR-101](./arch_decisions/adr-101-pipeline-engine.md),
**реализована**; формат — [docs/PIPELINES.md](./PIPELINES.md)): контракт и роуты этого раздела
расширены (спецификации, версии, журнал прогона, проектная привязка) — **§5.35**; контракт этого
legacy-раздела остаётся действующим.
Единая фабрика `createPipelinesRoutes`; хранилище — порт `PipelineRepository`
(`{dataDir}/pipelines/definitions.json` и `{dataDir}/pipelines/instances.json`).
**Определения этот роут не создаёт** — их ставит установщик пакета расширения
(`POST /api/v2/packs`); обойти проверку целостности манифеста `synth.pack` нельзя.

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/pipelines` | оба | ADMIN / auth | Определения пайплайнов инстанса `{pipelines}` (шаги, `onError`, `maxAttempts`, `ttl`, провенанс `installedBy`) |
| GET | `/api/v2/pipelines/instances` | оба | ADMIN / auth | Экземпляры прогонов `{instances}`; фильтры `pipelineId`, `status` (`pending\|running\|waiting\|done\|failed\|cancelled`), `limit` (дефолт 100, максимум 1000); неизвестный `status` → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/pipelines/instances/:instanceId` | оба | ADMIN / auth | Один экземпляр (состояния шагов, `currentStep`, `attempts`, `trigger`) |
| GET | `/api/v2/pipelines/:id` | оба | ADMIN / auth | Одно определение; нет → 404 `NOT_FOUND` |
| POST | `/api/v2/pipelines/:id/instances` | оба | ADMIN **или** scope `automation:install` | **Ручной** запуск экземпляра (проверка/отладка; основной запуск — по событию): тело `{trigger?, payload?}` → 201; нет определения → 404 |

**Семантика автомата.** Первый шаг с `waitsFor` — **триггер**: совпавшее событие создаёт
экземпляр; последующие шаги с `waitsFor` — **гейты**: событие означает «предыдущий шаг завершён
и подтверждён человеком» — автомат продвигается в существующем экземпляре. **Артефакт между
шагами = payload события** (например `{draftId}`) — он сохраняется в артефакте шага и в
`trigger.payload`; следующий шаг получает его оттуда. Учёт ведёт funnel (ADR-089): решение
Router'а несёт `pipeline: {id, step}`, трекер создаёт/продвигает экземпляр.

**UI.** Раздел «Аддоны» (Настройки → Администрирование, категория `addons`, роль ADMIN):
реестр пакетов (одобрение и снятие) и «Пайплайны» — определения и прогоны с фильтрами.

### 5.35 Пайплайны проекта, прогоны и шаблоны — `/api/v2/projects/:id/pipelines*`, `/api/v2/pipeline-runs*`, `/api/v2/pipeline-templates*` (оба, ADR-101 Э6)

Модель «пайплайн как второй движок» ([ADR-101](./arch_decisions/adr-101-pipeline-engine.md),
формат и устройство — [docs/PIPELINES.md](./PIPELINES.md)): **пайплайн проекта** (`scope:'project'`) со
спецификацией-черновиком и неизменяемыми опубликованными версиями, **прогон** (самодостаточная
запись со снимком спецификации + журнал выполнения) и **шаблон инстанса** (источник для
инстанцирования). Единая фабрика `createPipelineProjectRoutes` для core и backend; хранилище —
порты `ProjectPipelineRepository` и `PipelineRunRepository` (ADR-096), источник шаблонов —
legacy-реестр `PipelineRepository` (ADR-100) **плюс** записи `scope:'instance'` нового порта.

Пути **не пересекаются** с legacy-контуром §5.34 (`/api/v2/pipelines*`): там — «декларация + учёт»
(ADR-100), здесь — движок со спецификациями, версиями и журналом (ADR-101). Старые эндпоинты
остаются рабочими (legacy-контур, ADR-100), **UI уже переведён на новый контур** — новые эндпоинты
основной контур пайплайнов.

**Права (ADR-089 §5.5/§5.8, инвариант 21).**

| Действие | Право |
|---|---|
| Чтение пайплайнов и прогонов | право **чтения** проекта: владелец, участник проекта (любая роль, в т.ч. `VIEWER`), `LEAD`, `ADMIN` |
| Изменение (создание, правка, публикация, удаление, запуск, HITL) | право **изменения содержимого** проекта: `OWNER`, `EDITOR`, `LEAD`, `ADMIN`; `VIEWER` читает, но не мутирует |
| Шаблоны инстанса (список) и инстанцирование | **ADMIN** (managed); core — `requireAuth` (single-user). Инстанцирование дополнительно требует права изменения содержимого целевого проекта |
| service-key (ADR-052) | мутации — scope `automation:install` (или роль `ADMIN` у ключа) **и** проектная проекция `allowedProjects` (иначе `403 PROJECT_FORBIDDEN`); без scope — `403 SCOPE_REQUIRED`. Чтение scope-гейта не имеет — только права проекта |

Проверка доступа — **на границе** (guard), а не в обработчике (инвариант 16): guard резолвит
проект или прогон один раз и кладёт сущность в контекст; в обработчиках проверок доступа нет.
Нет проекта → `404`; нет прав → `403`; пайплайн чужого проекта под чужим id → `404` (в этом
проекте такого ресурса нет).

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/projects/:id/pipelines` | оба | право чтения проекта | Пайплайны проекта `{pipelines}`: id, имя, `scope`, `projectId`, `draftVersion`, `publishedVersion?`, `installedBy?`, черновик `draft` |
| POST | `/api/v2/projects/:id/pipelines` | оба | право изменения проекта (+ `automation:install` для service-key) | Создать пайплайн: тело `{name?, description?, spec}` — спецификация `PipelineSpec`; сервер проставляет `id`/`version`/`status`/`projectId` → **201** `{pipeline}`; невалидная спецификация → 400 `VALIDATION_ERROR` со списком `problems` |
| GET | `/api/v2/projects/:id/pipelines/:pid` | оба | право чтения проекта | `{pipeline, published, versions}` — черновик, опубликованная версия и список версий |
| PUT | `/api/v2/projects/:id/pipelines/:pid` | оба | право изменения проекта | Сохранить черновик: тело `{name?, description?, spec}` → 200 `{pipeline}`; версия при этом **не** меняется (публикация — отдельный шаг) |
| DELETE | `/api/v2/projects/:id/pipelines/:pid` | оба | право изменения проекта | Удалить пайплайн и его версии → **204**; прогоны **остаются** (прогон самодостаточен) |
| POST | `/api/v2/projects/:id/pipelines/:pid/publish` | оба | право изменения проекта | Опубликовать черновик: неизменяемая версия `publishedVersion`, черновик переезжает на следующую версию → 200 `{pipeline, published}`; повторная публикация без изменений идемпотентна (версии не плодит); черновика нет → 409 `CONFLICT` |
| GET | `/api/v2/projects/:id/pipelines/:pid/runs` | оба | право чтения проекта | Прогоны пайплайна `{runs}`; фильтры `status` (`pending`/`running`/`awaiting_human`/`done`/`failed`/`cancelled`), `limit` (дефолт 100, максимум 1000); неизвестный `status` → 400 `VALIDATION_ERROR` |
| POST | `/api/v2/projects/:id/pipelines/:pid/runs` | оба | право изменения проекта | Запуск прогона: тело `{trigger?, version?}` (по умолчанию — последняя опубликованная версия, триггер `manual`) → **201** `{run}`; прогон идёт **в фоне** — клиент следит по событиям `pipeline.run.*`; опубликованной версии нет → 409 `pipeline.not_published` |
| GET | `/api/v2/pipeline-runs/:runId` | оба | право чтения проекта прогона | Прогон и журнал `{run, events}` (события: `run.started`/`node.started`/`node.finished`/`edge.taken`/`gate.awaiting`/`run.finished`/`run.failed`); `limit` — последние N событий (дефолт 200, максимум 1000) |
| POST | `/api/v2/pipeline-runs/:runId/resume` | оба | право изменения проекта прогона | HITL-решение человека: тело `{approved, output?, comment?}` → 200 `{run}`; прогон не ждёт решения → 409 `pipeline.invalid_state` |
| POST | `/api/v2/pipeline-runs/:runId/cancel` | оба | право изменения проекта прогона | Отмена прогона → 200 `{run}` (статус `cancelled`); прогон уже завершён → 409 `CONFLICT` |
| GET | `/api/v2/pipeline-templates` | оба | **ADMIN** / auth | Шаблоны инстанса `{templates}`: `format` (`adr-100` — legacy-определение пакета, `adr-101` — запись `scope:'instance'`), `name`, `version`, `installedBy?`, `steps` (legacy) или `spec` |
| POST | `/api/v2/pipeline-templates/:tid/instantiate` | оба | **ADMIN** / auth + право изменения целевого проекта | Инстанцировать шаблон в проект: тело `{projectId, name?}` → **201** `{pipeline}` (черновик, `draftVersion: 1`, провенанс `installedBy` сохраняется); шаблон не конвертируется → 409 `PIPELINE_TEMPLATE_UNSUPPORTED` со списком `problems`; нет шаблона или проекта → 404 |

**Коды ошибок раздела:** `UNAUTHORIZED` (401), `FORBIDDEN` (403 — права проекта), `SCOPE_REQUIRED`
(403 — service-key без `automation:install`), `PROJECT_FORBIDDEN` (403 — service-key вне
`allowedProjects`), `NOT_FOUND` (404), `VALIDATION_ERROR` (400, со списком `problems`), `CONFLICT`
(409 — публиковать нечего / прогон завершён), `pipeline.not_published` (409),
`pipeline.invalid_state` (409), `PIPELINE_TEMPLATE_UNSUPPORTED` (409).

**Ошибка прогона.** `run.error` — текст ошибки; **машиночитаемый код** причины — в журнале прогона
(`run.failed.payload.code`: `pipeline.gate_rejected`, `pipeline.gate_timeout`,
`pipeline.step_failed`, `pipeline.step_timeout`, `pipeline.cancelled`, `pipeline.loop_limit`,
`permission.denied`).

**Конвертация legacy-определений (ADR-100 → шаблон ADR-101).** Определение пакета
(`provides.pipelines[]`, legacy-реестр `{dataDir}/pipelines/definitions.json`) — источник шаблонов;
миграции данных нет: конвертация выполняется **на лету при инстанцировании**
(`legacyDefinitionToPipelineSpec`):

- шаг `agent` → узел `agent`: `id`, `agent`, `title?`, `skill?`, `prompt?`, `timeoutSec?`
  переносятся как есть;
- шаг `loop` **не конвертируется** (Loop Engine вне объёма, PROP-057) — шаблон с такими шагами
  не инстанцируется: `409 PIPELINE_TEMPLATE_UNSUPPORTED` со списком проблем;
- шаг без поля `agent` — не конвертируется (узел `agent` требует агента) — та же 409;
- `waitsFor` **не переносится**: в ADR-101 триггер задаётся при запуске прогона, а HITL-гейт
  выражается узлом `human` — его добавляет владелец пайплайна в черновике;
- выход пайплайна при инстанцировании — `none` (выходы задаются вручную).

**Хранилище.** Черновики и версии — порт `ProjectPipelineRepository`
(`{dataDir}/pipelines/{pipelines,versions}.json`), прогоны и журнал — `PipelineRunRepository`
(`{dataDir}/pipelines/{runs.json,run-events.jsonl}`); при `storage.backend=postgres` — драйвер
`@itphx/synth-storage-postgres` (ADR-097).

**UI.** Экран пайплайнов/прогонов и визуальный редактор **реализованы** (ADR-101 §5.35): вкладка
«Пайплайны», страницы пайплайна и прогона, HITL-действия, редактор `@xyflow/react`.

---

### 5.36 Плагины — `/api/v2/plugins*` и `/api/v2/settings/plugins` (оба, PROP-090)

Слой плагинов (PROP-090, Extension API v1): установка бандла `synth.pack` (`kind: 'plugin'`),
модель доверия/скан/install-policy (PROP-068), активация через `PluginHost` и точки расширения
(`promptBlocks`, `llmFilters`, `tools`). Единая фабрика `createPluginsRoutes` для core и backend;
`plugins.lock.json` — источник истины (что установлено), `installed/<name>@<version>/` — бандл,
`quarantine/` — ожидающие подтверждения, журнал `{dataDir}/audit/plugins.jsonl`.

**Исполнение кода выключено по умолчанию** (`plugins.executionEnabled: false`): установка и снятие
работают, активация останавливается на шаге `import` (`plugin.execution_disabled`). Включение —
через `PUT /api/v2/settings/plugins` + **перезапуск инстанса**.

| Метод | Путь | Сборка | RBAC (backend / core) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/plugins` | оба | ADMIN / auth | `{plugins: PluginRuntimeEntry[]}` — установленные записи lock + `active`/`mode`; карантин в список не входит |
| GET | `/api/v2/plugins/:name` | оба | ADMIN / auth | `{plugin, manifest?, integrity?}`: манифест из установленного бандла и `PLUGIN_INTEGRITY.json` (best-effort — порча файла не даёт 500); нет в lock → 404 `plugin.not_found` |
| POST | `/api/v2/plugins/install` | оба | ADMIN или service-key `addons:install` / auth | **Установка из источника** (см. «Источники установки» ниже): `201` — установлено, `202` — нужно подтверждение (`plugin.approval_required`, бандл в карантине), `400` `VALIDATION_ERROR` (тело/pin/имя) или `plugin.source_unavailable` для локального источника, `400` `plugin.manifest_invalid`, `403` `plugin.trust_below_floor`/`plugin.runtime_install_denied`/`plugin.scan_disabled_with_execution`, `409` `plugin.scan_rejected`, `502` `plugin.source_unavailable` для сетевого источника (registry/URL не ответили). **Managed**: локальные источники (`dir`/`archive`) запрещены → `403 LOCAL_INSTALL_DISABLED`; сетевые (`npm`/`url`) разрешены |
| POST | `/api/v2/plugins/:name/approve` | оба | **ADMIN** / auth | Подтвердить карантин (`202`-установку): повторные гейты + сверка integrity → `200` установлено; `404` `plugin.not_found`, `409` `plugin.scan_rejected` |
| POST | `/api/v2/plugins/:name/enable` | оба | ADMIN или `addons:install` / auth | Активация (пайплайн PROP-090 §10) → `200 {activation}`; отказ по гейту (`plugin.execution_disabled`/`trust_below_floor`/`scan_rejected`/`approval_required`) → `409` с `reason`; нет в lock → `404` |
| POST | `/api/v2/plugins/:name/disable` | оба | ADMIN или `addons:install` / auth | Обратная прокрутка disposers → `200 {deactivation}`; не активен → `404 plugin.not_active` |
| DELETE | `/api/v2/plugins/:name` | оба | **ADMIN** / auth | Снятие: деактивация → `lock.delete` → удаление каталога версии; **идемпотентно** → `204` даже если записи не было |
| POST | `/api/v2/plugins/:name/rollback` | оба | ADMIN или `addons:install` / auth | Откат на ступень `previous`: `200 {outcome:'rolled_back', version, previousVersion, activated?}`; нет ступени/каталога → `409 plugin.rollback_unavailable`, нет записи → `404 plugin.not_found` |
| POST | `/api/v2/plugins/update` | оба | ADMIN или `addons:install` / auth | **Обновление из источника записи lock**: `200 {outcome:'unchanged'|'updated', ...}`; `400 VALIDATION_ERROR` (нет `name`/невалидный `sha256`) или `plugin.source_unavailable` для локального источника, `404 plugin.not_found`, `409 plugin.approval_required`/`scan_rejected`/`integrity_*`, `502 plugin.source_unavailable` для сетевого источника. Тело `{name, version?, sha256?, activate?}`; источник клиентом не выбирается |

**Источники установки (`POST /plugins/install`).** Тело:
`{source?: 'dir'|'archive'|'npm'|'url', path?, name?, version?, url?, sha256?, trustLevel?}`.

| Источник | Поля | Целостность | `source`/`identifier`/`ref` в lock |
|---|---|---|---|
| `dir` | `path` — каталог с `synth.pack` | — | `local` / абс. путь / — |
| `archive` | `path` — `.tgz`/`.tar.gz` | `ref` = `sha256:<hash архива>` | `local` / абс. путь / `sha256:<hash>` |
| `npm` | `name` (`name`/`@scope/name`), `version?` (по умолчанию `latest`) | **обязателен** `dist.integrity` (SRI `sha512`), `shasum` — дополнительно | `npm` / имя / точная версия |
| `url` | `url` (только `https:`) + **обязательный** `sha256` (64 hex) | сверка `sha256` | `url` / URL / `sha256:<hash>` |

Вид источника выводится из полей, если `source` не задан (`path` с `.tgz`/`.tar.gz` — архив, иначе
каталог; `name` — npm; `url` — URL) — старое тело `{path}` работает как раньше. Метка `source` в lock
выводится из резолвинга: клиент её не задаёт. Архив распаковывается в временный каталог (лимиты 500
файлов / 16 МиБ файл / 64 МиБ сумма; симлинки, hardlink, устройства, абсолютные пути, `..` и
windows-диски отклоняются), в `installed/`/`quarantine/` пишет только установщик. Ошибки резолвинга —
`plugin.source_unavailable`: `400` для локальных источников, `502` для сетевых.

**Обновление и откат (`POST /update`, `POST /:name/rollback`).** Источник обновления берётся **из
записи lock** (`source`/`identifier`/`ref`), а не из тела: `npm` — `name` из lock, `version` из тела
(по умолчанию `latest`); `local` — каталог или `.tgz`/`.tar.gz` из lock; `url` — адрес из lock +
**обязательный** новый `sha256` (pin). Совпал `content_hash` — `200 {outcome:'unchanged'}` (ничего не
пишется). Иначе — обычная установка с теми же гейтами (скан/trust-floor/install-policy), доверие
берётся из lock, каталог прежней версии сохраняется, в lock пишется `previous` (одна ступень
отката). Активация: был активен — новая версия активируется после деактивации старой; `activate:
false` — не активировать, не задано — сохранить состояние. `rollback` меняет текущую и предыдущую
версии местами (обратим), `installed_at` записи не меняется. Managed: запись lock с `source:
'local'` при обновлении отклоняется (`403 LOCAL_INSTALL_DISABLED`) — иначе обновление обходило бы
запрет локальной установки.

**Маппинг причин отказа → HTTP** (исчерпывающая таблица `PLUGIN_REASON_HTTP` в
`packages/core/src/server/routes/plugins.ts`): `400` — `manifest_invalid`, `contract_mismatch`,
`host_mismatch`, `module_invalid`, `provides_mismatch`, `source_unavailable` (локальный источник);
`403` — `trust_below_floor`, `disabled`,
`not_allowlisted`, `denylisted`, `runtime_install_denied`, `scan_disabled_with_execution`;
`404` — `not_found`, `not_active`; `409` — `scan_rejected`, `integrity_mismatch`,
`integrity_unverifiable`, `execution_disabled`, `rollback_unavailable`; `202` — `approval_required`; `500` —
`loader_unavailable`, `disposer_failed` (сбой хоста, не клиента); `502` — `source_unavailable` для
сетевого источника. При активации
`execution_disabled`/`trust_below_floor`/`scan_rejected`/`approval_required` → `409`, `not_found` →
`404`, прочие отказы → `200 {activation: {outcome: 'rejected', reason}}`.

**Настройки — `/api/v2/settings/plugins`.** Runtime-override поверх `config.yaml` (`settings.json` /
PG, порт настроек): `enabled`, `executionEnabled`, `runtimeInstall` (`allow|deny`), `trustFloor`,
`scan` (`enabled|disabled`), `allowlist`/`denylist`/`remoteAllowlist`, `exactHostExceptions`,
`promptBlockMaxChars` (бюджет символов блока, дефолт 4 000), `llmFilterTimeoutMs` (бюджет фильтра,
дефолт 1 000).

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| GET | `/api/v2/settings/plugins` | ADMIN / auth | `{plugins (runtime), defaults (config), isOverridden, restartRequired: true, running}` |
| PUT | `/api/v2/settings/plugins` | ADMIN / auth | Частичное обновление (`pluginsConfigSchema.partial().strict()`): неизвестный ключ/невалидное значение → `400 VALIDATION_ERROR`; ответ как у `GET` |
| DELETE | `/api/v2/settings/plugins` | ADMIN / auth | Сброс override к `config.yaml`/дефолтам; ответ как у `GET` |

**`restartRequired: true`** (инвариант 24): рантайм плагинов (хост, загрузчик, эффективный конфиг)
собирается при старте инстанса, поэтому смена **политики** применяется после перезапуска
(`POST /api/v2/maintenance/restart`). Исключение — **живые бюджеты**: `promptBlockMaxChars`
(со следующего хода) и `llmFilterTimeoutMs` (к последующим регистрациям фильтров) применяются сразу. Приоритет значений — `SYNTH_*` env > runtime (этот раздел) >
`config.yaml` > дефолты (ADR-023).

**RBAC.** Managed (backend): чтение и настройки — `ADMIN`; установка/активация/деактивация —
`ADMIN` **или** service-key со scope `addons:install`; подтверждение карантина и снятие — **только
`ADMIN`**. Core (standalone): единый `requireAuth` (владелец инстанса, ADR-079). Своя матрица —
`packages/backend/src/routes/plugins-rbac-matrix.test.ts` (негативная: `USER`/`LEAD`/`AUDITOR` →
403; позитивная: `ADMIN`, service-key со scope и без).

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
| Admin-API обслуживания инстанса (ADR-091/ADR-092) | `packages/core/src/server/routes/maintenance.ts`, `packages/core/src/maintenance/*` |
| Аналитика и отчёты (ADR-102) | `packages/core/src/server/routes/analytics.ts`, `packages/core/src/analytics/*`, `packages/shared/src/types/analytics.ts` |
| Пакеты расширений и пайплайны (ADR-100) | `packages/core/src/server/routes/packs.ts`, `packages/core/src/server/routes/pipelines.ts`, `packages/core/src/engine/events/pipeline-tracker.ts`, `packages/core/src/storage/ports/pack-repository.ts`, `packages/core/src/storage/ports/pipeline-repository.ts`, `packages/shared/src/types/pack.ts`, `packages/shared/src/types/pipeline.ts` |
| Пайплайны проекта, прогоны и шаблоны (ADR-101, Э6) | `packages/core/src/server/routes/pipeline-project-routes.ts`, `packages/core/src/engine/pipelines/*`, `packages/core/src/storage/ports/project-pipeline-repository.ts`, `packages/core/src/storage/ports/pipeline-run-repository.ts`, `packages/shared/src/types/pipeline-engine.ts` |
| Плагины (PROP-090) | `packages/core/src/server/routes/plugins.ts`, `packages/core/src/engine/plugins/*` (хост, загрузчик, установщик, рантайм), `packages/shared/src/types/{pack,plugin-audit,plugin-lock,plugin-scan,prompt-blocks,llm-filters,plugin-tools}.ts` |
| EventHub | `packages/backend/src/events/hub.ts` |
| Rate limiter | `packages/backend/src/middleware/rate-limiter.ts` |
| Core standalone app + SSE/WS | `packages/core/src/server/app.ts` |
| Core роуты | `packages/core/src/server/routes/*.ts` |
| Core auth | `packages/core/src/auth/local.ts` |
| Контракты (`BusEvent`) | `packages/shared/src/types/index.ts` |
