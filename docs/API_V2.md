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
| `STEER_LIMIT_EXCEEDED` | режимы отправки сообщения (ADR-104) |
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

### 3.1. Подтверждения разрешений (ADR-106 Ф3)

Запрос подтверждения (`permission.asked`) и ответ на него (`permission.replied`) — по WS `/ws/events`.
Ответ принимает **носитель покрывающего гранта** (владелец сессии, `EDITOR`/`OWNER` проекта,
`ADMIN`/`LEAD`, service-key с подходящей ролью), а **не** «тот, кто видит сессию»: `VIEWER` (право
чтения) подтвердить мутирующий тул не может.

**Событие `permission.asked`** (запрос подтверждения) — дополнительные поля:

| Поле | Тип | Назначение |
|---|---|---|
| `principal` | `{kind, id, roles}` | принципал хода, которому адресован запрос (ADR-106 Ф0) |
| `turn_id` | string | ход (`streamId`), которому принадлежит запрос |
| `digest` | string | отпечаток привязки «ход + действие + цель» (sha256) |

**Клиентское сообщение `permission_reply`**:

```json
{ "type": "permission_reply", "session_id": "<sid>", "approval_id": "<aid>",
  "action": "allow" | "deny", "once": true | false,
  "turn_id": "<turn>", "digest": "<digest>" }
```

- `action` — решение (`allow`/`deny`); старый формат `{approved: boolean}` поддерживается;
- `turn_id`/`digest` — необязательные: при расхождении с привязкой ответ отклоняется
  (`turn_mismatch`/`digest_mismatch`);
- клиенту доверять нельзя: принципал отвечающего берётся из **аутентификации** WS-соединения.

**Событие `permission.replied`** — при принятом ответе: `approved`, `action`, `principal`, `turn_id`,
`digest` (привязка — из серверного реестра). При **отказе** — `approved: false`, `action: 'deny'` и
поле `reason`:

| `reason` | Причина отказа |
|---|---|
| `no_grant` | ответ не носителя покрывающего гранта (в т.ч. `VIEWER` на мутации) |
| `already_consumed` | повторный ответ на тот же `approval_id` (подтверждение одноразово) |
| `turn_mismatch` | ответ с чужим `turn_id` (другой ход) |
| `digest_mismatch` | ответ с чужим `digest` (подмена привязки) |
| `unknown_approval` | неизвестный `approval_id` |

Параллельно клиенту уходит кадр ошибки:

```json
{ "type": "error", "session_id": "<sid>",
  "data": { "error": "<текст>", "code": "APPROVAL_DENIED" }, "timestamp": "<ISO>" }
```

Реестр подтверждений живёт только в **enforced-режиме** Authority-слоя (`authority.enabled` без
`authority.shadow`); в shadow/выключенном режиме ответ принимается по-старому (по видимости сессии) —
см. [ADR-106](./arch_decisions/adr-106-authority-layer.md).

### 3.2. Фоновые прогоны и вопросы пользователю

События фоновой работы и «вопрос пользователю» публикуются в **канале
сессии-владельца** (`EventBus.publish(sessionId, …)`, ADR-009) — новых
транспортных каналов не заводим (ADR-024).

| Событие | Когда | Поля `data` |
|---|---|---|
| `user_question.asked` | агент задал вопрос и ждёт ответа | `question_id`, `session_id`, `questions[]`, `created_at`, `expires_at?` (только при заданном сроке — по нему UI рисует обратный отсчёт), `turn_id?`, `tool_call_id?`, `agent_role?` |
| `user_question.answered` | пользователь ответил | `question_id`, `session_id`, `answers[][]` |
| `user_question.cancelled` | вопрос отменён (таймаут, «Стоп», ручная отмена) | `question_id`, `session_id`, `reason` |
| `process.started` | запущена фоновая шелл-команда (`kind:'process'`) | `process_id`, `session_id`, `command`, `cwd`, `pid?`, `background_run_id`, `log_path` |
| `process.exited` | фоновый процесс завершён | `process_id`, `session_id`, `state` (`completed`/`failed`/`cancelled`/`orphaned`), `exit_code?`, `signal?`, `background_run_id` |
| `process.stopped` | запрошена остановка фонового процесса (один раз на прогон) | `process_id`, `session_id`, `background_run_id`, `reason` |
| `child.completed` / `child.failed` / `child.cancelled` | фоновый саб-агент завершился (успех/ошибка/отмена; `kind:'subagent'`) | `child_session_id`, `parent_session_id`, `state`, `background_run_id`, `description` |
| `process.detached` | идущий блокирующий прогон переведён в фон (`POST /sessions/:id/background`, ADR-111 §detach); `process.started` при этом **не** публикуется — прогон уже шёл | `session_id`, `kind` (`subagent`/`process`), `id`, `child_session_id?`, `background_run_id?`, `title?` |

Префикс `user_question.*` — намеренно **не** `question.*`: `question.asked` уже
занят смыслом «очередь зависла». Событие `process.stopped` публикуется ядром
при успешном запросе остановки прогона (`POST /api/v2/processes/:id/stop`,
`reason` — причина остановки); терминальный статус прогона приходит позже —
событием `process.exited` (у остановленного процесса `state: 'cancelled'`).

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
| GET | `/auth/oidc-meta` | backend | — | Публичные OIDC issuer/clientId (без секрета) + сигнал `plugins: {enabled, mode}` (серверная политика плагинов в гибриде, ADR-090 Ф7; **без списка имён** — полный allow-list отдаёт `GET /api/v2/settings/plugins`); старый сервер без поля → клиент трактует политику как неизвестную |
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
| PATCH | `/api/v2/sessions/:id` | оба | auth | `{name, title, mode: plan\|act\|yolo, settings, project_id}`; `worktreeId: string\|null` — привязка сессии к worktree (ADR-114, §5.40) |
| DELETE | `/api/v2/sessions/:id` | оба | auth | Удалить → 204 |
| GET | `/api/v2/sessions/:id/secrets` | backend | ADMIN/AUDITOR | Карта обфускации Gateway `{sessionId, secrets}` |
| POST | `/api/v2/sessions/:id/fork` | оба | auth | Форк; `{message_id?, message_index?, title?}` → 201 |
| GET | `/api/v2/sessions/:id/children` | оба | auth | Дочерние сессии |
| GET | `/api/v2/sessions/:id/tree` | оба | auth | Дерево сессий |
| GET | `/api/v2/sessions/:id/export` | backend | auth | Экспорт Session (внутренний формат, camelCase — формат publish/fork не изменён). Маршрут зарегистрирован **после** prefix-guard'а (`app.use('/:id')`/`app.use('/:id/*')`), поэтому **доступ к сессии решает единый guard** — проверок доступа в обработчике нет (инвариант 16). Карта обфускации Gateway (ADR-036) — **отдельная привилегия**, которую решает route-level guard `createSessionExportGuard`: **полный экспорт** (`obfuscationMap` и `messages[].metadata.secrets` включены) — **владельцу сессии** (`ownerId ?? userId`), `ADMIN` и `AUDITOR` (тот же набор привилегий, что у `GET /:id/secrets`); прочие читатели сессии (участник проекта `VIEWER`/`EDITOR`, владелец проекта, не владеющий сессией, `LEAD`) — **200 с очищенным телом** (карты нет, весь остальной разговор переносится без изменений; очистка — на копии, сохранённая сессия не меняется); нет доступа на чтение сессии → 403 `FORBIDDEN`; сессии нет → 404 `NOT_FOUND`; rate limit 10/60 c → 429 `RATE_LIMITED` |
| POST | `/api/v2/sessions/import` | backend | auth | Импорт сессии из экспорта → 201 |
| GET | `/api/v2/sessions/:id/status` | оба | auth | `{blocked, pending_count, processor_running}` |
| POST | `/api/v2/sessions/:id/prompt` | оба | auth | Поставить сообщение в очередь, вернуть **SSE-стрим**; поле `mode` (`queue`\|`steer`\|`interrupt`, по умолчанию `queue`) — вмешательство в ход (ADR-104, см. ниже); аддитивное `attachments: string[]` (`blobPath`) — вложения сообщения (§5.6.1) |
| GET | `/api/v2/sessions/:id/prompt` | оба | auth | Состав системного промпта (ADR-070): `manifest` + `history` + `promptState` + `lastPromptMeta` + `toolsDetail` (тулы с `chars`/`estTokens` и флагом оценки, ADR-071 §2.8). `manifest.toolsPolicy`/`manifest.mcpPolicy` — применённые политики встроенных/MCP (ADR-071 §2.3); записи: `tools` (stable/context) → `mcp.servers`/`mcp.tools`/`mcp.status` (volatile, не в `staticPrefixChars`). `history.excluded.disabled` включает сообщения, подавленные вместе с отключённым ходом |
| GET | `/api/v2/sessions/:id/memory` | оба | auth | Память сессии для вкладки «Память» (ADR-107): `provider.active`, `scope.projectId`, `lastContext` — блоки `facts`/`recall` из **последнего** хода (`chars`/`estTokens`/`status`, `null` — ходов не было), `facts.active` (активные факты в скоупе), `projectMemory` (`{enabled}` — эффективная политика проекта; `null` — сессия без проекта), `indexes` (всего/project/instance/ready/building/failed + `items`: id/name/scope/state/enabled/projectId; `stale` вычисляется плагином и здесь не отдаётся; у `instance` `enabled` всегда true), `readiness` (`ready`/`degraded`/`unavailable`). Текстов фактов/чанков нет; доступ — чтение сессии (prefix-guard), без дублирующих проверок |
| GET | `/api/v2/sessions/:id/stats` | оба | auth | Статистика usage (ADR-070): сообщения + рекурсивный usage саб-агентов (tool `task`), агрегаты по агентам/пользователям (`computeSessionStats`) |
| GET | `/api/v2/sessions/:id/questions` | оба | auth (чтение) | Вопросы пользователю сессии (этап 1 roadmap 0.13 — блок 3): `{questions: QuestionRecord[]}`; `?status=pending\|answered\|cancelled` (не задан — все статусы), `?limit=` (дефолт 50, максимум 200); записи «свежие первыми». Сервис вопросов не подключён — 503 `QUESTION_UNAVAILABLE` |
| POST | `/api/v2/sessions/:id/questions/:qid/answer` | оба | auth (**мутация**) | Ответ пользователя на вопрос: `{answers: string[][]}` (по индексу вопроса; значения — из `options[].value`) → 200 `{question}`. 400 `VALIDATION_ERROR` (тело/ответ невалидны), 404 `NOT_FOUND` (вопроса нет **или** он другой сессии), 409 `CONFLICT` (вопрос уже отвечен/отменён) |
| POST | `/api/v2/sessions/:id/questions/:qid/cancel` | оба | auth (**мутация**) | Отмена вопроса: `{reason?}` → 200 `{question}`; те же 404/409, что и в `answer` |
| GET | `/api/v2/sessions/:id/messages` | оба | auth | `{messages, session_id}` |
| POST | `/api/v2/sessions/:id/clear` | оба | auth | Очистить историю (кроме pinned) |
| POST | `/api/v2/sessions/:id/abort` | оба | auth | Надёжный «Стоп» (ADR-005): ставит персистентный флаг `status.cancel_requested`, при живом стриме — graceful-отмена, затем остановка процессора очереди; `{status:'aborted'}`; 404 если сессии нет (см. ниже) |
| POST | `/api/v2/sessions/:id/background` | оба | auth (**write**) | Перевести идущие блокирующие прогоны сессии в фон (detach, ADR-111): тело необязательно `{type?: 'subagent'\|'process'}` (нет тела/поля — все); → 200 `{detached: [{id, kind, title?}], sessionId, failed?: [{id, kind, code, message?}]}`; `failed` присутствует только при непустом массиве (код `BACKGROUND_LIMIT` — исчерпан лимит фоновых прогонов, `DETACH_FAILED` — прочий отказ; остальные прогоны при этом переводятся); пустой `detached` — нечего переводить (**не** ошибка, запрос идемпотентен); 400 `VALIDATION_ERROR` (неизвестный `type`), 400 `DETACH_UNSUPPORTED` (удалённая сессия гибрида — живого хэндла прогона нет), 403/404 — по правилам доступа к сессии (см. ниже) |
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
> **Scope service-key (ADR-052):** `GET /` и `GET /:id` — `sessions:read`; `POST /` — `sessions:create`; `PATCH /:id`, `DELETE /:id`, `POST /:id/prompt`, `POST /:id/background` — `sessions:prompt`; `GET /:id/prompt|status|stats|messages` — `sessions:read`. При непустом `allowedProjects` проектная проекция проверяется по `project_id` сессии, иначе `403 PROJECT_FORBIDDEN`.
> **Контекст хранения инстанса.** Экспорт/импорт проекта (`GET /api/v2/projects/:id/export`, `POST /api/v2/projects/import`) идут через контекст хранения инстанса (`StorageContext`, ADR-096), а не через собственный файловый контекст — на `storage.backend=postgres` видны БД-проекты (спека — §5.8.1).
> **Надёжный «Стоп» — `POST /api/v2/sessions/:id/abort` (ADR-005).** Роут ставит **персистентный** флаг `SessionStatus.cancelRequested` (+ `cancelRequestedAt`) под локом сессии — поэтому отмена срабатывает и когда `currentStream`/cancel-token ещё не установлены (сессия в очереди, в backoff, между итерациями Tool Use), где прежний `orchestrator.cancel` был no-op. При живом стриме дополнительно вызывается graceful `orchestrator.cancel` (публикует `stream.cancelled`, сохраняет частичный ответ); затем `QueueProcessorManager.requestStop` прерывает backoff/активный LLM-вызов и завершает цикл (`_handleStopRequest`: очистка `pendingMessages`, снятие `blocked`/флага, `stream.cancelled` ровно один раз — без дубля graceful-ветки). Если обработчика нет, флаг снимается, чтобы следующий запуск не отменился ложно. Ответ — `{status:'aborted'}`; без сессии — 404. В сериализованной сессии (`GET /api/v2/sessions/:id`) поле `status` содержит `cancel_requested` (bool) и `cancel_requested_at` (ISO|null). Гибридная ветка (удалённая сессия) делегирует `remoteClient.abortSession`.
> **Перевод идущего прогона в фон — `POST /api/v2/sessions/:id/background` (ADR-111 §detach).** Перевод **односторонний**: foreground-вызов `task` (саб-агент) или `execute_shell` продолжается уже как фоновый прогон — со своим `AbortController` и `streamId`, публикацией в родительский стрим отключённой, — а блокирующее ожидание тула просыпается и возвращает модели `tool_result` «переведено в фон»; ход модели продолжается с этого места. Отмена родителя (`POST /:id/abort`) переведённый прогон **не** останавливает: его останавливает только собственный «Стоп» — `POST /sessions/<child>/abort` (саб-агент) или `POST /processes/:id/stop` (шелл). Завершение — обычное уведомление родителя (сообщение в историю + автоход), ровно одно: терминальный переход идемпотентен, вставка — по `background_run_id`; доставка at-least-once (маркер «уведомление не доставлено» через порт хранения). Права — **write** на сессию (граничный guard, инвариант 16): `VIEWER` читает, но не переводит (инвариант 21). В канал сессии-владельца публикуется `process.detached` (§3.2). Ответ — `{detached: [{id, kind, title?}], sessionId}`; прогоны, которые перевести не удалось, идут в необязательном `failed: [{id, kind, code, message?}]` (`BACKGROUND_LIMIT` — исчерпан лимит фоновых прогонов сессии, `DETACH_FAILED` — прочий отказ; остальные прогоны при этом переводятся, пустой `failed` в ответ не включается). UI: «В фон» у running `task`-парта и running `execute_shell`, `ctrl+b` — все блокирующие прогоны активной сессии; дальше работа видна во вкладке «Процессы» (§5.39).
> **Режим отправки — `mode` в `POST /api/v2/sessions/:id/prompt` (ADR-104).** Необязательное поле `mode`: `queue` (по умолчанию) — сообщение ждёт окончания текущего хода (прежнее поведение); `steer` — **вмешательство в активный ход без прерывания генерации**: сообщение встаёт в очередь инъекций (`steerInbox`) и попадает в контекст на ближайшей границе шага (перед следующим LLM-вызовом), персистится как обычная `user`-реплика с `metadata.steer=true`; `interrupt` — **прерывание текущей генерации с продолжением хода**: стрим обрывается (событие `stream.interrupted`), частичный ответ сохраняется отдельной `assistant`-репликой со статусом `interrupted` (`metadata.interrupted`), ход **не** завершается и **не** отменяется («Стоп» — отдельный механизм, ADR-005) — сообщение вплетается на ближайшей границе шага, пары `toolUse`/`toolResult` не рвутся. Неизвестное значение `mode` трактуется как `queue`. Ответ при `steer` и активном ходе — `202 {status:'steered', stream_id, pending_count, mode_applied:true}`, при `interrupt` — `202 {status:'interrupted', stream_id, pending_count, mode_applied:true}` (отдельный SSE-стрим не открывается — идёт стрим текущего хода); активного хода нет — `steer`/`interrupt` работают как `queue` (обычная очередь + SSE). Лимит — **5 инъекций на ход**; превышение → `429 STEER_LIMIT_EXCEEDED` (публикуется событие `steer.dropped`). То же поле принимает WS-сообщение `send_message` (backend и standalone).
> **Порядок применения инъекций (ADR-104, этап 3).** Очередь инъекций — **не строгий FIFO**: применяются сначала инъекции класса `interrupt` (маркер `metadata.interrupt=true`), затем класса `steer`; **внутри класса** порядок FIFO (порядок постановки). Порядок детерминирован и не зависит от момента постановки. При переполнении лимита хода первыми отбрасываются инъекции низшего приоритета (`steer`), лишние публикуются как `steer.dropped`.
> **Инъекция — ввод в тот же ход, а не ответ пользователя (ADR-104, этап 3).** Инъекция **не отвечает** за пользователя на `permission.asked` и **не отменяет** ожидающее подтверждение прав: ход, стоящий на `ask`, применяет инъекцию на границе шага **после** ответа. Инъекция также **не расширяет права**: в режиме `plan` мутирующий тул остаётся запрещённым (правило `plan.deny` permission-слоя), даже если текст инъекции «разрешает» его.
> **Гибрид: единый контракт режима (ADR-104, этап 3).** `mode` доезжает до удалённой стороны: HTTP-промпт удалённой сессии (`remote:<id>`) пробрасывает тело как есть, WS-путь локального core передаёт `mode` в запрос удалённого backend'а (раньше режим терялся — удалённая сессия всегда работала как `queue`). Ответ/ack несёт **применённый** режим: локальная сторона применила режим сама — `mode_applied:true`; удалённая сторона применила — `202` c `mode_applied:true`; удалённая сторона **не** применила (нет активного хода на удалённой стороне или старая версия) — `202 {status:'queued', mode_applied:false}` (сообщение ушло обычной очередью). WS-ack `queued` содержит `mode` и `mode_applied` (backend и standalone).
> **Ограничения steering (ADR-104).** **UI-селектор режима есть**: при активном ходе композер показывает три режима — «в очередь» (`queue`), «вмешаться» (`steer`), «прервать» (`interrupt`); в ленте сообщения-инъекции помечаются маркером «вмешательство в ход» (`metadata.steer`), в режиме `interrupt` — маркером «прерывание хода» (`metadata.interrupt`), а прерванная генерация — бейджем «Прервано» (`metadata.status === 'interrupted'`). В гибриде локальный core не вмешивается в ход, который исполняет удалённый backend: режим применяет та сторона, которой принадлежит ход (удалённый backend), а клиент получает в ack, применился ли режим (`mode_applied`).
> **Steering дочерней сессии саб-агента (ADR-104 + ADR-111).** Режим работает и для дочерних сессий саб-агентов, включая фоновые: `POST /api/v2/sessions/<child>/prompt` с `mode:'steer'` кладёт сообщение в очередь инъекций **сессии-ребёнка**, а цикл ребёнка (`engine/tools/task/run-cycle.ts`) применяет его на границе шага — перед следующим LLM-вызовом, в том же ходу (пары `toolUse`/`toolResult` не рвутся). Инъекция персистится в истории ребёнка как обычная `user`-реплика с `metadata.steer=true` и публикуется в канал ребёнка (`message.added`, `message.injected`); превышение лимита — событие `steer.dropped` в канале ребёнка, ход не падает. `interrupt` для ребёнка **не обрывает генерацию** (на границе шага её уже нет) и применяется как обычное вмешательство. Действует общее правило раздела: сообщение попадает в очередь инъекций, только если у сессии ребёнка есть активный ход (фоновый прогон — всегда: сессия ребёнка помечена занятой; нет активного хода — `steer`/`interrupt` работают как `queue`). Очереди родителя и ребёнка изолированы: инъекция в очередь родителя не попадает в ход ребёнка и наоборот (проверка — `packages/core/src/queue/steering-subagent.test.ts`).
> **Вопросы и рестарт (ADR-112).** Ожидание ответа на вопрос живёт в памяти процесса: после рестарта незавершённые вопросы помечаются `cancelled` с причиной `interrupted`, ход не возобновляется (как и прочие паузы tool-loop). Сама запись вопроса рестарт переживает (журнал в `QuestionRepository`). По умолчанию вопрос ждёт ответа **без таймаута** (`questions.timeoutMs = 0`); срок ожидания задаёт тул `question` (`timeout`, ≥ 5 минут — не рекомендуется: ожидание обрывается).
> **Вложения ответа — `stream.done.attachments` (ADR-115, outbound).** Событие `stream.done` (SSE `POST /sessions/:id/prompt`, `GET /sessions/:id/events`) несёт аддитивное `attachments?: Array<{sha256, mime, size, name?}>` — медиа-части **финального** assistant-сообщения хода (`image`/`audio`/`video`/`file`) в порядке сообщения; без медиа-частей поля нет. Байты шлюз забирает по sha: `GET /api/v2/attachments/:sha256` (§5.6.1) — доступ к сессии ему не нужен. Форма поля, источник и коды раздачи — §5.6.1.

### 5.6 Messages — `/api/v2/messages`

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| POST | `/api/v2/messages/:sessionId/batch` | оба | auth | `{action: pin\|toggle\|delete, indices[], state?}` |
| PATCH | `/api/v2/messages/:sessionId/:index/toggle` | оба | auth | Переключить `disabled`. Отключение **user**-реплики выключает весь её ход: assistant/tool/error до следующей user-реплики не уходят в LLM (system-state и summary остаются); отключённый assistant с `toolCalls` подавляет свои tool-результаты |
| PATCH | `/api/v2/messages/:sessionId/:index/pin` | оба | auth | Переключить `pinned` |
| DELETE | `/api/v2/messages/:sessionId/:index` | оба | auth | Удалить сообщение |
| POST | `/api/v2/messages/:sessionId/:index/retry` | оба | auth | Отключить с index и вернуть текст `{content}` |
| GET | `/api/v2/messages/:sessionId/:index/debug` | оба | auth | Отладочные данные сообщения |

### 5.6.1 Вложения сообщений — `/api/v2/sessions/:id/attachments*` (оба, ADR-115)

Мультимодальный ввод ([ADR-115](./arch_decisions/adr-115-multimodal-input.md)): файл загружается
отдельным запросом, в сообщение попадает **ссылка** на объект blob-хранилища (`blobPath`), а байты
раздаются через API (не прямой ссылкой на файл). Байты лежат на томе (`{dataDir}/blobs`, content-addressed),
учёт ссылок — `blob_refs` ([ADR-116](./arch_decisions/adr-116-instance-state-and-blob-ports.md);
устройство — [ARCHITECTURE.md](./ARCHITECTURE.md) §«Слой хранения»). Лимиты — секция `attachments`
([CONFIGURATION.md](./CONFIGURATION.md) §«Вложения сообщений»).

| Метод | Путь | Сборка | RBAC | Назначение / req-resp |
|---|---|---|---|---|
| POST | `/api/v2/sessions/:id/attachments` | оба | auth + **запись** сессии (prefix-guard) | multipart, поле `file` — **один файл за запрос** (необязательное поле `name` — имя для метаданных) → **201** `{id, blobPath, sha256, mime, size, name?}` |
| GET / HEAD | `/api/v2/sessions/:id/attachments/:partId` | оба | auth + **чтение** сессии (prefix-guard) | Байты вложения: `200` (поток), `206` при `Range`, `304` при совпадении `ETag`, `416` при некорректном диапазоне; `HEAD` — те же заголовки без тела |

**Ответ загрузки.** `id` равен `blobPath` — путь объекта `attachments/<sha2>/<sha256>`; адресация
content-addressed, поэтому повторная загрузка тех же байтов возвращает тот же путь (дедуп).
`sha256`/`size` — по **оригинальным** байтам: в blob хранится оригинал (скачивание через API и
материализация в workspace отдают его), а метаданные (EXIF/IPTC/XMP у JPEG, `eXIf`/текстовые чанки
у PNG) срезаются **только на границе отправки провайдеру** (гидратация вложений и aux-вызов) —
см. [ADR-115](./arch_decisions/adr-115-multimodal-input.md) §«Лимиты и безопасность». Битая
структура изображения не «чистится наполовину» — уходит как есть.
`mime` определяется по
сигнатуре содержимого, а не по заявленному клиентом; `image/svg+xml` запрещён всегда (XSS), а
разрешённые типы задаёт `attachments.allowedMimePrefixes` (по умолчанию `image/`, `audio/`,
`video/`, `application/pdf`, `text/`). `name` санитайзится (basename, без управляющих символов, ≤ 200 символов)
и в `blobPath` не входит.

**Лимиты и коды.**

| Лимит | Где проверяется | По умолчанию | Нарушение |
|---|---|---|---|
| `attachments.enabled` | загрузка и staging | `true` | `415 attachments_disabled` — вложения выключены администратором: клиенту показывать, что отправка вложений недоступна (повтор запроса не поможет; код общий для загрузки в сессию и staging) |
| `attachments.maxBytesPerFile` | загрузка | 25 МиБ | `413 PAYLOAD_TOO_LARGE` (по `Content-Length` — до чтения тела, с запасом 64 КиБ на multipart-обвязку; затем по фактическому размеру) |
| `attachments.allowedMimePrefixes`, запрет SVG | загрузка | см. выше | `415 UNSUPPORTED_MEDIA_TYPE` |
| `attachments.maxFilesPerMessage` | `POST …/prompt` | 10 | `400 VALIDATION_ERROR` |
| контракт OpenAPI/SDK (`promptRequestSchema`) | публикуемая схема §5.30 | не более **50** путей в `attachments` | `400 VALIDATION_ERROR` при валидации схемой; HTTP-обработчик проверяет `maxFilesPerMessage` (см. выше) |
| `attachments.maxBytesPerSession` | `POST …/prompt` | 1 ГиБ | `413 PAYLOAD_TOO_LARGE` |
| `attachments.gcDays` | GC (фон) | 30 дней | — (объект без ссылок старше срока удаляется) |

Квота сессии считается по **сумме `size` медиа-частей в истории сессии**, а не по ссылкам, и
проверяется при постановке сообщения (загрузка файла квоту не проверяет — «лишний» объект станет
сиротой и уйдёт по `gcDays`). Прочие коды загрузки: `400 VALIDATION_ERROR` (нет поля `file`/битый
multipart), `401`, `403 FORBIDDEN` (чужая сессия, prefix-guard), `404 NOT_FOUND` (сессии нет),
`415 UNSUPPORTED_MEDIA_TYPE` (тип вне белого списка, SVG; сюда же попадает пустой файл — MIME по
содержимому не определяется), `415 attachments_disabled` (вложения выключены администратором —
`attachments.enabled=false`; клиенту код говорит, что дело в настройке инстанса, а не в файле).

**Раздача (`GET`/`HEAD`).** `:partId` — id **медиа-части сообщения** (`image`/`audio`/`video`/`file`),
а не `id` из ответа загрузки; путь объекта (`blobPath`) передаётся только в теле промпта. Доступ
решает единый prefix-guard на границе (инвариант 16): чтение — владелец, участник проекта (любая
роль, включая `VIEWER`), `ADMIN`/`LEAD`; чужой → `403`, нет сессии/части/объекта → `404` (без утечки
существования). Заголовки: `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`,
`ETag` (sha256 в кавычках), `Cache-Control: private, max-age=86400`,
`Content-Disposition: inline` (RFC 6266/5987, имя санитайзится). `If-None-Match` (в т.ч. `*` и список)
→ `304`. `Range`: один диапазон (`bytes=start-end`, `bytes=start-`, `bytes=-N`) → `206` с
`Content-Range`; множественные/нечисловые заголовки → объект целиком (`200`); числовой диапазон вне
объекта (или `end < start`) → `416` с `Content-Range: bytes */<size>`.

**Staging-загрузка (без сессии) — `POST /api/v2/attachments` (оба, ADR-115).** Для контуров, у
которых нет пользовательской сессии: шлюзы (Telegram/VK) принимают файл из внешнего канала,
пайплайны — из шага. Контракт запроса/ответа тот же, что у загрузки в сессию (`multipart/form-data`,
поле `file`; необязательное `name`) → **201** `{id, blobPath, sha256, mime, size, name?}`, ошибки —
те же (`400`, `413`, `415`, включая `415 attachments_disabled` при выключенных вложениях).
Полученный `blobPath` дальше передаётся в `POST /sessions/:id/prompt`
(`attachments: string[]`), в `POST /api/v2/events` (§5.26 — `attachments[]` со ссылками и
метаданными) или используется как артефакт прогона.

| Метод | Путь | Сборка | RBAC | Назначение |
|---|---|---|---|---|
| POST | `/api/v2/attachments` | оба | core — `requireAuth`; managed — `requireAuth` + service-key scope `events:ingest` | staging-загрузка файла вне сессии → **201** `{id, blobPath, sha256, mime, size, name?}` |
| GET / HEAD | `/api/v2/attachments/:sha256` | оба | core — `requireAuth`; managed — `requireAuth` + service-key scope `events:ingest` | байты вложения **по sha256** (outbound-контур шлюзов): `200` (поток) с `Content-Type`, `Content-Length`, `Cache-Control: private, no-store`; `HEAD` — те же заголовки без тела; `404 NOT_FOUND` — объекта нет либо sha не 64 hex (существование не раскрывается) |

**Outbound-вложения ответа — `stream.done.attachments` + раздача по sha (ADR-115).** Шлюзу
(Telegram/VK) не нужен доступ к сессии, чтобы отправить финальные вложения ответа наружу: событие
`stream.done` (SSE-стрим `POST /sessions/:id/prompt` и `GET /sessions/:id/events`, §5.5) несёт
**аддитивное** поле

```ts
attachments?: Array<{ sha256: string; mime: string; size: number; name?: string }>
```

Источник — медиа-части (`image`/`audio`/`video`/`file`) **финального** assistant-сообщения хода
(сообщение с этим `stream_id`; вложения пользователя и промежуточные tool-chain сообщения не
учитываются), порядок — как в сообщении. Части без валидной формы (`sha256` не 64 hex, пустой
`mime`, нечисловой `size`) игнорируются; медиа-частей нет — **поля нет вовсе** (прежний контракт
события не меняется). Байты забираются по sha: `GET /api/v2/attachments/:sha256` — адрес объекта
выводится из хеша (`attachments/<sha[0:2]>/<sha256>`, content-addressed), т.е. раздаётся только
контур вложений, а не произвольные blob-объекты. `Range` не поддерживается (шлюзу нужен весь
файл), `HEAD` — можно. Авторизация — та же, что у staging-загрузки (`requireAuth`; managed —
service-key scope `events:ingest`); объект должен существовать: без ссылок `blob_refs` он живёт до
`attachments.gcDays` (см. ниже), ссылка из сообщения продлевает его жизнь.

**GC staging-объектов.** Объект не привязан к сессии: ссылка `blob_refs` появляется только когда
`blobPath` попадёт в сообщение (или артефакт). Пока ссылок нет, действует общий критерий GC —
`countRefs(blobPath) === 0` **и** возраст > `attachments.gcDays`; отдельного TTL у staging нет
(pruner — сразу при старте и далее каждые 6 часов). Оригиналы сохраняются так же, как у загрузки в
сессию (очистка метаданных — на границе отправки провайдеру).

**Вложения в промпте.** Тело `POST /api/v2/sessions/:id/prompt` принимает аддитивное
`attachments?: string[]` — массив **`blobPath`**, полученных из загрузки (не `partId`); дубли
схлопываются. Порядок частей сообщения — текст, затем вложения; тип части выводится из MIME
(`image/*` → `image`, `audio/*` → `audio`, `video/*` → `video`, иначе `file`). В производном
строковом `content` каждая медиа-часть даёт плейсхолдер (`[image: name.png]`, без имени — `[image]`),
поэтому факт вложения не теряется в экспорте, поиске и маппинге истории. Неизвестный/битый путь →
`400 VALIDATION_ERROR` со списком таких путей (молча терять вложение нельзя); контур вложений не
подключён в сборке → `400`. Ссылки `blob_refs` пишутся при создании сообщения (`ownerKind: 'message'`);
форк и merge сообщений создают **свои** ссылки на те же объекты; при удалении сообщения/сессии
ссылки снимаются, и объект без ссылок старше `gcDays` удаляет фоновый pruner (вместе с
sidecar-метаданными). Метрики — `synth_attachment_*`
([OBSERVABILITY.md](./OBSERVABILITY.md) §«Вложения сообщений»).

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
| PUT | `/api/v2/projects/:id` | оба | auth / owner·EDITOR·LEAD·ADMIN | Обновить поля (name, description, current_task, invariants, icon, color, repos, plan, memory); смена `workspace` — owner/LEAD/ADMIN. `memory: {enabled?: boolean}` — политика памяти проекта (ADR-107): `false` убирает блоки памяти и тулы `plugin_synth_plugin_memory_*`, данные сохраняются; не задано — наследует политику инстанса (включено) |
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

> **Модальности входа модели (ADR-115, решение 2026-10-27).** В модели ответа `GET /api/v2/models`
> поле `modalities` (`AttachmentModality[]`: `text`/`image`/`pdf`/`audio`/`video`) **опционально**:
> заполняется `POST /api/v2/models/fetch` из каталога провайдера (`architecture.input_modalities`/
> `architecture.modality`) и переопределяется вручную через `POST /api/v2/models` (`null` — сброс).
> Поля **нет** = провайдер модальности не сообщил, значение неизвестно — ограничение не применяется
> (вложения не фильтруются, несовместимый тип отклоняет сам провайдер). Фоллбэка `['text']` и
> справочника модальностей в ядре нет.

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

> `config.auth` (ADR-105 Ф0/Ф3) — ссылка на внешний доступ: `{kind:'credential', credentialId}`; коннектор авторизуется токеном из слоя доступов, сам токен в реестре/конфиге не лежит. Поле аддитивно — записи без `auth` валидны. Токен подставляет транспорт (`Authorization: Bearer <token>` в каждом HTTP-запросе), при `401` он обновляется (refresh) и запрос повторяется — **ровно один refresh на запрос**. Выдача/ротация доступов — Ф4 (`/api/v2/oauth/credentials`, ещё не реализовано); до этого доступ заводится кодом (через порт), а коннектор ссылается на него по `credentialId`.
>
> **Запрет plaintext-секретов (ADR-105 Ф3).** Заголовки `authorization`/`proxy-authorization`/`x-api-key`/`cookie` в `config.headers` запрещены: запись реестра (`POST/PUT /api/v2/mcp/registry`, `POST/PUT /api/v2/mcp/servers`) и `POST /api/v2/mcp/probe` → **400** `MCP_SECRET_HEADER_FORBIDDEN`; существующие записи реестра мигрируются в `auth: { kind: 'credential', credentialId }`.
>
> **Право привязки (ADR-105 Ф3).** Привязка доступа к коннектору проверяется на границе: свой доступ (`owner.kind='user'`/`'local'`) — его владелец; инстансный (`owner.kind='instance'`) — `ADMIN`/`LEAD`; проектный (`projectId`) — участник проекта с правом **изменения** содержимого (`OWNER`/`EDITOR`, а также `LEAD`/`ADMIN`); нет доступа — **404** (`NOT_FOUND`), нет права — **403** (`FORBIDDEN`). Матрица — `packages/backend/src/routes/mcp-credential-bind.test.ts`.
>
> **Каталог OAuth-провайдеров.** Описания провайдеров (`authorizeUrl`/`tokenUrl`/`clientId`/`scopes?`/…) живут в конфиге `oauth.providers` (env-оверрайд `SYNTH_OAUTH_PROVIDERS`); `client_secret` — только env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` или файл `{dataDir}/secrets/oauth/<provider>.client_secret`. Из описания строится клиент для refresh токена доступа.

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
| GET | `/api/v2/settings/attachments` | ADMIN (managed) / auth (core) | Runtime-настройки вложений (ADR-115): `{attachments:{enabled, modalities:{image,pdf,audio,video}, maxBytesPerFile, maxFilesPerMessage, maxBytesPerSession, allowedMimePrefixes, workspaceFallback, modalityModels:{image?,pdf?,audio?,video?}, gcDays}, defaults, saved, isOverridden, source:"env"\|"runtime"\|"config"\|"default", envLocked:string[], restartRequired:false, running}`; `attachments` — эффективные значения (в `modalityModels` записи нет — обработка модальности не настроена), `defaults` — база без runtime/env, `saved` — сохранённый runtime-патч как есть (`{}` — runtime-значения нет); приоритет `SYNTH_ATTACHMENTS_*` > runtime > `config.yaml` `attachments` > defaults |
| PUT | `/api/v2/settings/attachments` | ADMIN (managed) / auth (core) | Патч `{attachments:{…}}` — runtime-override (`settings.json`/PG), **применяется сразу** (`restartRequired:false`: сервис вложений, промпт и GC читают резолвер на каждый вызов); `modalities` мёржится вложенно; неизвестные ключи игнорируются; невалидное значение → 400 `VALIDATION_ERROR`; поле из env с другим значением → 409 `CONFLICT`; ответ как у `GET`. **`modalityModels` (ADR-115):** объект «семейство → `{provider, model}`»; `null` (или `{}`) снимает настройку семейства, отсутствие ключа — база (config.yaml) сохраняется; мёржится **по семействам** (runtime дополняет config, перекрывает одну модальность, не трогая остальные). До записи проверяется каталог: провайдер существует, модель `<provider>/<model>` существует, модальности модели **известны** и содержат нужное семейство; иначе 400 с причиной (`modalityModels.<семейство>: …`: какая модель, какие модальности у неё заявлены; для неизвестных модальностей — просьба выполнить `POST /api/v2/models/fetch`). Частичных сохранений нет. Патч заменяет runtime-значение секции **целиком** (как остальные `/settings/*`): незаданные поля возвращаются к config/default — UI-форма при сохранении присылает `modalityModels` вместе с остальными полями, иначе runtime-назначения aux-моделей снимаются |
| DELETE | `/api/v2/settings/attachments` | ADMIN (managed) / auth (core) | Сброс runtime-значения к env/config/default (ответ как у `GET`); поле из env остаётся зафиксированным (`envLocked`) |

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
| POST | `/api/v2/events` | оба | auth/ключ + rate limit | Приём нормализованного внешнего события. Обычный путь: `Authorization: Bearer <пользовательский ключ>` → тело `{source, type, payload?, identity?, dedupKey?, ts?, attachments?}` (`eventIngestSchema`). Путь по API-ключу привязки: `Authorization: Bearer synth_evt_…` — **без пользовательских кред**, `source` опционален (`eventKeyIngestSchema`; source/чат/тред берутся из привязки; конфликт `source` → 400), событие форсированно маршрутизируется в привязку. Ответ в обоих случаях → `201 {event, decision, sessionId}` + **опциональное** `identityHint?: {code, expiresAt}` (ADR-089 claim-flow: одноразовый код подтверждения владения идентичностью; заполняется только когда отправитель не сопознан — `resolveExternalIdentity` → `null` — и задан `identity.principalId`); `sessionId` — id сессии или `null` при `drop`; при decision-маршрутизации (`events.decisionRouting`) `decision` несёт `confidence` и диагностические `signals`, напр. `agent:<id>`/`model:<p/m>`/`latency:<ms>ms`); неверный/отозванный/истёкший ключ → 401 `UNAUTHORIZED`; невалидное тело → 400 `VALIDATION_ERROR`, сбой материализации → 500 `INTERNAL_ERROR` (решение всё равно пишется в журнал). Вложения события (`attachments[]`) — см. ниже. Rate limit (managed — 120/мин) применяется к обоим путям до выбора способа аутентификации; per-key лимит (лимит ключа либо глобальный `events.keyRateLimitPerMinute`) → 429 `RATE_LIMITED`; мастер-выключатель `events.enabled: false` → 503 `UNAVAILABLE`. Использование ключа пишется в журнал (`keyId`/`principalId`) |
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
**Вложения события (`attachments[]`).** Аддитивное поле тела (`eventIngestSchema`, ADR-115 × ADR-089):
событие несёт **ссылки** на объекты blob-хранилища, байты через него не идут. Отправитель сначала
загружает файл (staging `POST /api/v2/attachments` или загрузка в сессию, §5.6.1) и передаёт
в событии путь объекта вместе с метаданными. Метаданные дублируются намеренно: получатель сверяет
их со sidecar объекта, поэтому подмена ссылки на чужой или изменённый объект отклоняется на приёме.

```json
{
  "source": "telegram",
  "type": "message",
  "dedupKey": "tg:chat:-1001234567890:msg:4711",
  "payload": { "text": "что на фото?" },
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

| Поле ссылки | Требование |
|---|---|
| `blobPath` | только контур вложений: `attachments/<sha2>/<sha256>`, ≤ 512 символов, без сегментов `..`; объект другого контура (`packs/`, `processes/`, логи, содержимое скиллов) сослать нельзя |
| `sha256` | ровно 64 hex-символа — адрес объекта (content-addressed) |
| `mime` | непустой MIME по содержимому (≤ 255), **совпадает** со sidecar объекта |
| `size` | целое положительное, байты; **совпадает** со sidecar |
| `name` | необязательное, 1–200 символов; в `blobPath` не входит (санитайз — как у загрузки) |

**Обязательный `dedupKey`.** Непустой `attachments[]` требует **явного** `dedupKey` (иначе
`400 VALIDATION_ERROR`; проверяют и схема запроса, и ingress). Причина: ключ идемпотентности
по умолчанию строится из `source`/`type`/`chatKey|threadKey`/`payload` (JSON) и для вложений
нестабилен — одно и то же сообщение, доставленное дважды с разным представлением вложений,
получило бы разные ключи и обработалось дважды; dedup-ключ не должен зависеть от содержимого
вложений. Пустой массив эквивалентен отсутствию поля (ключ не требуется).

**Проверка ссылок и лимиты.** Вложения проверяются **до** Router'а, дедупа и журнала: отклонённое
событие не «занимает» dedup-ключ и не попадает в журнал решений. Все отказы — `400 VALIDATION_ERROR`,
причина — в `error.message` с индексом элемента.

| Что проверяется | Источник лимита / правило | Нарушение |
|---|---|---|
| `dedupKey` при непустых вложениях | схема запроса + ingress | `400 VALIDATION_ERROR` |
| количество ссылок | `attachments.maxFilesPerMessage` (по умолчанию 10); схема запроса допускает не более 10 элементов — действует меньший предел | `400 VALIDATION_ERROR` |
| `blobPath` внутри `attachments/`, без `..` | контур вложений (ADR-115) | `400 VALIDATION_ERROR` |
| объект существует | `AttachmentService.resolve` | `400 VALIDATION_ERROR` |
| `sha256`/`mime`/`size` совпадают со sidecar | там же | `400 VALIDATION_ERROR` |
| размер файла | `attachments.maxBytesPerFile` | `400 VALIDATION_ERROR` |
| контур вложений подключён в сборке | fail-closed: без сервиса вложений событие с вложениями отклоняется — иначе можно было бы подставить ссылку на несуществующий или чужой объект | `400 VALIDATION_ERROR` |

**Доставка.** Сообщение собирает `eventToMessage`: первая часть — текст, далее по одной медиа-части
на ссылку в порядке `attachments[]`; тип части выводится из `mime` (`image/*` → `image`,
`audio/*` → `audio`, `video/*` → `video`, иначе `file`). Байты в сообщение не копируются — части
ссылаются на тот же объект blob-хранилища. В производном `content` каждая медиа-часть даёт
плейсхолдер (`[image: photo.png]`, без имени — `[image]`, для прочих типов — `[file: …]` и т. д.),
который дописывается с новой строки, если его ещё нет в тексте, — поэтому факт вложения не теряется
в экспорте, поиске и маппинге `messages.content`; в `metadata`
попадает `attachments_count` (для аудита и UI). Дубли в `attachments[]` не схлопываются — каждый
элемент становится отдельной частью (дедуп самих байтов делает blob-контур: адрес content-addressed).

**Ссылки `blob_refs` и GC.** После успешной постановки сообщения в очередь регистрируются ссылки
`blob_refs` (`ownerKind: 'message'`, `ownerId` — id сообщения). Шаг обязателен по смыслу: объект
без ссылок удаляет фоновый pruner по `attachments.gcDays` (30 дней по умолчанию), хотя сообщение
на него ссылается. Учёт — best-effort: ошибка записи ссылки не отменяет доставку (пишется в лог).
Staging-объект, который так и не попал в сообщение, живёт до `gcDays` и затем удаляется по общему
критерию GC (нет ссылок **и** возраст больше срока).

**Рекомендуемый порядок для шлюзов.** 1) `POST /api/v2/attachments` (§5.6.1) — получить из ответа
`blobPath`/`sha256`/`mime`/`size`; 2) `POST /api/v2/events` с `attachments[]` и явным `dedupKey`.
Обратный порядок (событие со ссылкой на ещё не загруженный объект) даёт `400 VALIDATION_ERROR`,
поэтому «загрузить → отправить событие» — единственный надёжный путь; один объект можно
переиспользовать в нескольких событиях.

**Чего вложения не меняют.** Права и идентичность: те же правила, что у события без вложений
(база — роли профиля отправителя, `identity.roles` только сужают, несопознанный отправитель прав
не получает) — вложения не дают событию дополнительных прав и не влияют на маршрутизацию.
Медиа не обезличивается и не очищается на приёме: байты лежат в blob как есть, срез метаданных
(EXIF/IPTC/XMP) выполняется только на границе отправки провайдеру (ADR-115). Тип файла не
«угадывается» по заявлению клиента: `mime` обязан совпадать со sidecar, а допустимые типы
ограничивает загрузка (`attachments.allowedMimePrefixes`, SVG запрещён).

Цепочка обработки и журнал — `docs/ARCHITECTURE.md` («Внешние события и хуки»), ADR-089.

> `POST /api/v2/sessions` теперь идёт через единый funnel `RequestSessionService`
> (`engine/events/request-session.ts`, ADR-089): эмит `session_requested` + создание
> сессии. Внешний контракт эндпоинта не изменился.

### 5.27 Schedules — `/api/v2/schedules` (оба, ADR-051 срез / ADR-089)

CRUD расписаний планировщика (единая фабрика `createSchedulerRoutes` для core и
backend). Срабатывание не создаёт сессию
само: сервис публикует нормализованное событие `source: 'cron'`,
`type: 'schedule_fired'` через `EventIngress`, а маршрутизацию выполняет
`SchedulerRuleProvider` (`RouteRuleProvider`). Исключение — цель `mode:'pipeline'`:
шедулер запускает прогон пайплайна **напрямую** (событие в Router не публикуется и
сессия не создаётся), см. ниже. RBAC managed (backend): чтение
(`GET`) — `requireAuth`; мутации (`POST`/`PUT`/`DELETE`) и принудительный запуск
(`POST /:id/run`) — только ADMIN (`writeGuard = requireAdmin`); `run` дополнительно
под rate limit 10/60 c (`runMiddleware`). В core (standalone) — единый `requireAuth`
на все методы. **Scope service-key (ADR-052):** `schedules:read` (чтение и `GET /:id/jobs`),
`schedules:write` (`POST`/`PUT`/`DELETE`/`POST /:id/run`); запись расписаний доступна
service-key с `schedules:write` **или** `automation:install` (зонтичный scope
установщика пакетов расширений — достаточно **любого** из двух: расписание,
порождаемое пакетом, пишется его установщиком; в managed scope-гейт действует
**сверх** ролевого гейта — ключу дополнительно нужна роль `ADMIN`); проектная проекция — по цели
расписания (`bound`/`queue` → проект сессии, `ephemeral` → `project`,
`pipeline` → `projectId`).

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
`decision`/`reason` (маршрутизация: `drop no_route`, `busy`, `missed`; для цели
`pipeline` — `decision:'pipeline'`, `reason:'pipeline_unavailable'` при отсутствии
раннера прогонов), `sessionId`, `pipelineId`/`runId`, `error`.

`target` — дискриминированный союз: `{mode:'bound', sessionId}` |
`{mode:'ephemeral', agentTemplate?, project?, ttl?}` | `{mode:'queue', sessionId}` |
`{mode:'pipeline', projectId, pipelineId, version?, payload?}`. Для `pipeline`:
`payload` — статический вход прогона (`trigger.payload.*`), `version` по умолчанию —
последняя опубликованная; прогон идёт в фоне, `runId` — в Job-истории.
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
| GET | `/api/v2/packs` | оба | ADMIN / auth | Список установок `{packs}`: имя, версия, `kind`, `status` (`active\|pending_approval\|disabled`), `requiresApproval`, `provides` (id'ы агентов/скиллов/MCP/пайплайнов), `installedBy`, `authority` (сводка контента полномочий — если пакет приносит `provides.authority`) |
| GET | `/api/v2/packs/:name` | оба | ADMIN / auth | Одна установка (включая сырой манифест и файлы пакета); `authority` — сводка контента полномочий |
| POST | `/api/v2/packs` | оба | ADMIN **или** scope `automation:install` | Установка: тело `{manifest, files}` (манифест + карта файлов пакета). Некорректный манифест → 400 `VALIDATION_ERROR` со списком `problems`; нехватка файлов → 400. → **201** `{installed: true, requiresApproval: false, name, version, provides}`; пакет с capability-грантами, пайплайнами, расписаниями или **контентом полномочий** (`provides.authority`) → **202** `{installed: false, requiresApproval: true, authority?, …}` (фактическая установка **не** выполняется) |
| POST | `/api/v2/packs/:name/approve` | оба | **только ADMIN** | Одобрение пакета в статусе `pending_approval` → 200 `{installed: true, authority?, authorityActivation?, …}`; нет записи → 404; статус не `pending_approval` → 409 `CONFLICT` |
| DELETE | `/api/v2/packs/:name` | оба | **только ADMIN** | Снятие установки вместе с поставленными артефактами (агент + роль, скилл, MCP-запись, определение пайплайна, порождённые правила) → 204; идемпотентно (нет пакета — тоже 204). Из политики полномочий инстанса убираются **роли и привязки агентов**, принесённые пакетом (идемпотентно) |

**Одобрение.** Пакет требует подтверждения администратора, если он выдаёт агенту непустые
`capabilities`, объявляет пайплайны (порождаемые правила маршрутизации), расписания или приносит
**контент полномочий** (`provides.authority` — роли/действия/цели/агенты; ADR-106 Ф5). Ответ
**202** — не ошибка: фактическую установку выполняет `POST /api/v2/packs/:name/approve` (по
сохранённым в реестре манифесту и файлам — обойти проверку целостности манифеста нельзя).

**Контент полномочий (ADR-106 Ф5).** Пакет с ролями идёт на одобрение **по существу**: администратор
видит, **что** пакет приносит. В ответах (`GET /packs`, `GET /packs/:name`, `POST /packs` (202),
`POST /packs/:name/approve`) — сводка `authority` (`PackAuthoritySummary`):

| Поле | Смысл |
|---|---|
| `roles[]` | id, `displayName`, `domain`, `grants` (число), `mutatingGrants` (число мутирующих) |
| `actions[]` | id, `mutating` (информационный признак) |
| `targets[]` | вид цели (`kind`), `resolver` |
| `agents[]` | id агента, `roles[]`, `ceiling[]` |
| `totals` | `roles`/`actions`/`targets`/`agents`/`grants`/`mutatingGrants` |

При одобрении контент **активируется** в политике полномочий инстанса (порт
`AuthorityPolicyRepository`): пересечение с потолком инстанса (не дарование), trust-floor
(мутирующие гранты — только при trust ≥ `trusted`; `community` — только чтение), роль, уже
объявленная в политике, не перезаписывается. Ответ `approve` несёт `authorityActivation` —
что активировано и что пропущено:

```json
{ "activated": { "actions": [], "roles": [], "targets": [], "agents": [] },
  "skipped": [ { "kind": "grant", "id": "write", "reason": "trust_floor", "detail": "…" } ] }
```

Причины пропуска: `trust_floor`, `instance_deny`, `instance_not_allowed`, `role_exists`,
`unknown_role`. Политика читается снимком при старте процесса — эффект активации виден после
рестарта. Устройство слоя — [docs/AUTHORITY.md](./AUTHORITY.md) §10.

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
| POST | `/api/v2/projects/:id/pipelines/:pid/runs` | оба | право изменения проекта | Запуск прогона: тело `{trigger?, version?, attachments?}` (по умолчанию — последняя опубликованная версия, триггер `manual`) → **201** `{run}`; прогон идёт **в фоне** — клиент следит по событиям `pipeline.run.*`; опубликованной версии нет → 409 `pipeline.not_published`; `attachments[]` не прошли проверку → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/pipeline-runs/:runId` | оба | право чтения проекта прогона | Прогон и журнал `{run, events}` (события: `run.started`/`node.started`/`node.finished`/`edge.taken`/`gate.awaiting`/`run.finished`/`run.failed`); `limit` — последние N событий (дефолт 200, максимум 1000) |
| GET | `/api/v2/pipeline-runs/:runId/artifacts/:name` | оба | право чтения проекта прогона | Байты артефакта-объекта прогона (`kind: 'blob'`): `Content-Type`, `Content-Disposition: attachment`, `Content-Length`, `ETag`, `Cache-Control: private, max-age=86400`; `If-None-Match` → `304`; нет артефакта или blob-контур не подключён → `404 NOT_FOUND` |
| POST | `/api/v2/pipeline-runs/:runId/resume` | оба | право изменения проекта прогона | HITL-решение человека: тело `{approved, output?, comment?}` → 200 `{run}`; прогон не ждёт решения → 409 `pipeline.invalid_state` |
| POST | `/api/v2/pipeline-runs/:runId/cancel` | оба | право изменения проекта прогона | Отмена прогона → 200 `{run}` (статус `cancelled`); прогон уже завершён → 409 `CONFLICT` |
| GET | `/api/v2/pipeline-templates` | оба | **ADMIN** / auth | Шаблоны инстанса `{templates}`: `format` (`adr-100` — legacy-определение пакета, `adr-101` — запись `scope:'instance'`), `name`, `version`, `installedBy?`, `steps` (legacy) или `spec` |
| POST | `/api/v2/pipeline-templates/:tid/instantiate` | оба | **ADMIN** / auth + право изменения целевого проекта | Инстанцировать шаблон в проект: тело `{projectId, name?, ensure?}` → **201** `{pipeline, created:true}` (черновик, `draftVersion: 1`, `installedBy.templateId` — id шаблона). `ensure:true` — идемпотентно: если в проекте уже есть пайплайн этого шаблона, **200** `{pipeline, created:false}`. Шаблон не конвертируется → 409 `PIPELINE_TEMPLATE_UNSUPPORTED`; нет шаблона/проекта → 404. Встроенные шаблоны памяти: `builtin:memory-consolidation` (сессия → факты), `builtin:memory-consolidate-facts` (дубли фактов), `builtin:memory-reindex` (все проектные индексы) |

**Артефакты прогона (ADR-101 §9 + ADR-116).** Выход `file` пишет файл в workspace проекта **и те же
байты** — в общий blob-порт по пути `artifacts/<runId>/<name>` (отдельного хранилища артефактов нет,
лимит 50 МиБ на файл; превышение — предупреждение в лог, файл остаётся только в workspace). Артефакт
описывается `PipelineArtifact` с `kind: 'blob'` и полями `path`/`name`/`mime`/`size`; список артефактов
прогона — **на верхнем уровне** payload'а `run.finished` (`run.finished.payload.artifacts[]`, источник
MIME/имени для выдачи) и в событии `pipeline.run.finished.artifacts[]` (аддитивное поле). Отдельного
индекса метаданных нет — источник истины журнал прогона. `ETag` выдачи — хеш **пути** (путь уникален в
пределах прогона и неизменяем). Автоматического retention артефактов **нет**: ни TTL, ни удаления прогонов
через API, байты живут в blob-хранилище до ручной чистки (известное ограничение, см.
[PIPELINES.md](./PIPELINES.md) §2.10.2).

**Вложения прогона (ADR-115 × ADR-101).** Тело запуска принимает `attachments[]` — ссылки на объекты
staging-загрузки (`POST /api/v2/attachments`), форма та же, что у вложения внешнего события
(ADR-089): `{blobPath, sha256, mime, size, name?}`, `blobPath` — только внутри `attachments/`
(структурный потолок массива — 50). Ссылки проверяются **до** старта прогона теми же правилами, что
и приём события: объект существует, `sha256`/`mime`/`size` совпадают со sidecar, лимиты
`attachments.maxFilesPerMessage` / `maxBytesPerFile` / `maxBytesPerSession`. Любое расхождение →
**400 `VALIDATION_ERROR`** (`problems`: «не найдено», «не совпадает с объектом», «превышает предел»);
без сервиса вложений или порта `blob_refs` прогоны с вложениями отклоняются (fail-closed). Принятые
ссылки ложатся под `trigger.payload.attachments` (доступны шагам без маппинга) и регистрируются в
`blob_refs` владельцем `pipeline-run` (иначе GC удалил бы объект, на который ссылается прогон).
Доставка в шаг — общий путь сессий (очистка метаданных, фильтр модальностей, `derive` для text-only
модели, лимит base64); устройство — [PIPELINES.md](./PIPELINES.md) §2.10.3.

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
`@itphx/synth-storage-postgres` (ADR-097). Артефакты прогонов (`kind: 'blob'`) — байты в общем
blob-порте (`{dataDir}/blobs/artifacts/<runId>/<name>`, учёт ссылок — `blob_refs`), метаданные — в
журнале прогона (ADR-116).

**UI.** Экран пайплайнов/прогонов и визуальный редактор **реализованы** (ADR-101 §5.35): вкладка
«Пайплайны», страницы пайплайна и прогона, HITL-действия, редактор `@xyflow/react`.

---

### 5.36 Плагины — `/api/v2/plugins*` и `/api/v2/settings/plugins` (оба, ADR-090)

Слой плагинов (ADR-090, Extension API v1): установка бандла `synth.pack` (`kind: 'plugin'`),
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
| GET | `/api/v2/plugins/audit` | оба | ADMIN / auth | `{entries: PluginAuditEntry[]}` — **журнал действий плагинов** (ADR-090), хвост: `limit` (по умолчанию 50, максимум 500) и необязательный фильтр по имени плагина (`plugin`). Записи «свежие первыми» (новые → старые); в записи — время (`ts`), плагин, действие (`action`), итог (`outcome`: `ok`/`rejected`), код причины (`reason`) и прочие поля записи. Чтение **не** создаёт записей в журнале |
| GET | `/api/v2/plugins/:name` | оба | ADMIN / auth | `{plugin, manifest?, integrity?}`: манифест из установленного бандла и `PLUGIN_INTEGRITY.json` (best-effort — порча файла не даёт 500); нет в lock → 404 `plugin.not_found` |
| POST | `/api/v2/plugins/install` | оба | ADMIN или service-key `addons:install` / auth | **Установка из источника** (см. «Источники установки» ниже): `201` — установлено, `202` — нужно подтверждение (`plugin.approval_required`, бандл в карантине), `400` `VALIDATION_ERROR` (тело/pin/имя) или `plugin.source_unavailable` для локального источника, `400` `plugin.manifest_invalid`, `403` `plugin.trust_below_floor`/`plugin.runtime_install_denied`/`plugin.scan_disabled_with_execution`, `409` `plugin.scan_rejected`, `502` `plugin.source_unavailable` для сетевого источника (registry/URL не ответили). **Managed**: локальные источники (`dir`/`archive`) запрещены → `403 LOCAL_INSTALL_DISABLED`; сетевые (`npm`/`url`) разрешены |
| POST | `/api/v2/plugins/:name/approve` | оба | **ADMIN** / auth | Подтвердить карантин (`202`-установку): проверка подтверждения (content-hash + срок 24 ч, ADR-090 п. 9) → повторные гейты + сверка integrity → `200` установлено; `404` `plugin.not_found`, `409` `plugin.scan_rejected`, `409` `plugin.approval_expired` (подтверждение истекло — 24 ч с момента выдачи), `409` `plugin.approval_stale` (бандл в карантине изменён после выдачи подтверждения) |
| POST | `/api/v2/plugins/:name/enable` | оба | ADMIN или `addons:install` / auth | Активация (пайплайн ADR-090) → `200 {activation}`; отказ по гейту (`plugin.execution_disabled`/`trust_below_floor`/`scan_rejected`/`approval_required`) → `409` с `reason`; нет в lock → `404`. При вердикте скана `caution` требуется **действующее подтверждение** (content-hash, срок 24 ч — ADR-090 п. 9): есть и хеш совпал → активация проходит, иначе `409 plugin.approval_required` |
| POST | `/api/v2/plugins/:name/disable` | оба | ADMIN или `addons:install` / auth | Обратная прокрутка disposers → `200 {deactivation}`; не активен → `404 plugin.not_active` |
| DELETE | `/api/v2/plugins/:name` | оба | **ADMIN** / auth | Снятие: деактивация → `lock.delete` → удаление каталога версии; **идемпотентно** → `204` даже если записи не было |
| POST | `/api/v2/plugins/:name/rollback` | оба | ADMIN или `addons:install` / auth | Откат на ступень `previous`: `200 {outcome:'rolled_back', version, previousVersion, activated?}`; нет ступени/каталога → `409 plugin.rollback_unavailable`, нет записи → `404 plugin.not_found` |
| POST | `/api/v2/plugins/token` | оба | **ADMIN** / auth | **Выдача server-scoped токена плагину** (ADR-090 Ф7, Уровень 2): тело `{pluginId, scopes?, expiresInSec?}` → `201 {token, pluginId, scopes, expiresAt}`; секрет отдаётся **единожды** (at-rest — sha256, формат `synth_svc_…`), scope `plugins:invoke` добавляется всегда. Ошибки: `400 VALIDATION_ERROR` (нет `pluginId`/неизвестный scope/неверный `expiresInSec`), `403 PLUGIN_NOT_ALLOWED` (плагин вне серверного allow-list при `plugins.hybrid.mode=allowlist`), `404 plugin.not_found` (плагин серверу неизвестен: не установлен и не разрешён allow-list'ом), `501 NOT_IMPLEMENTED` (реестр service-key не подключён) |
| POST | `/api/v2/plugins/update` | оба | ADMIN или `addons:install` / auth | **Обновление из источника записи lock**: `200 {outcome:'unchanged'|'updated', ...}`; `400 VALIDATION_ERROR` (нет `name`/невалидный `sha256`) или `plugin.source_unavailable` для локального источника, `404 plugin.not_found`, `409 plugin.approval_required`/`scan_rejected`/`integrity_*`, `502 plugin.source_unavailable` для сетевого источника. Тело `{name, version?, sha256?, activate?}`; источник клиентом не выбирается |

**Подтверждение установки (`POST /plugins/:name/approve`, ADR-090 п. 9).** Вердикт скана `caution` →
бандл уходит в `quarantine/<name>@<version>/` (ответ `202`, `plugin.approval_required`) и вместе с
ним выдаётся **подтверждение**: привязанное к **content-hash** бандла, с **кем** и **когда** выдано,
**срок — 24 ч** (`PLUGIN_APPROVAL_TTL_MS`). Состояние персистентно: `plugin-approvals.json` в корне
раскладки слоя плагинов (`<home>/plugin/` или `{dataDir}/plugin/`) — рядом с `plugins.lock.json`, но
**вне** каталога бандла (замена бандла в карантине не стирает подтверждение).

При `approve` подтверждение проверяется **первым**:

| Условие | Ответ |
|---|---|
| подтверждения нет (бандл поставлен в карантин вручную) | проверки не применяются — остальные гейты как прежде |
| срок 24 ч истёк | `409` `plugin.approval_expired` |
| content-hash бандла не совпал с подтверждённым (бандл заменён) | `409` `plugin.approval_stale` |
| иначе | повторные гейты → `200` установлено |

Подтверждать (то есть выполнять `approve`) в managed может **только `ADMIN`** (`approveGuard:
requirePermission('ADMIN')`); scope `addons:install` открывает установку/активацию, но не
подтверждение. В core (standalone) — единый `requireAuth`. Отдельного API отзыва нет: подтверждение
перестаёт действовать, когда перестаёт совпадать хеш (`plugin.approval_stale`) или истекает срок.

**Журнал действий плагинов (`GET /plugins/audit`).** Журнал **append-only**: его пишет порт
`PluginAuditRepository` (`{dataDir}/audit/plugins.jsonl` в файловом хранилище, таблица `plugin_audit`
в PostgreSQL). Записи описывают жизненный цикл расширения: `install`, `activate`, `deactivate`,
`rollback`, `uninstall`, `scan`, `filter`, `token`.

| Параметр | Тип | По умолчанию | Значение |
|---|---|---|---|
| `limit` | число | 50 | сколько **последних** записей отдать (максимум 500; не число или `<= 0` — дефолт) |
| `plugin` | строка | — | фильтр по имени плагина (пусто — все плагины) |

Ответ — `{entries: PluginAuditEntry[]}`: записи «свежие первыми» (новые → старые). Поля записи:
`id`, `ts` (ISO-8601), `actor`, `action`, `plugin`, `version`, `outcome` (`ok`/`rejected`),
`reason?` (машиночитаемый код отказа — `plugin.*`/`plugin_filter.*`), плюс, если заполнены,
`trustLevel`, `scanVerdict`, `scanFindings`, `scanPerformed`, `contentHash`, `mode`, `source`.

Права — как у чтения реестра плагинов: в managed — **ADMIN**, в core — `requireAuth`. Чтение
журнала — **не действие над плагином**: запись при чтении не создаётся. В UI тот же журнал виден
в разделе «Плагины» → «Журнал плагинов».

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

**Server-scoped токен плагина (Уровень 2, Ф7).** Ключ, выданный `POST /api/v2/plugins/token`,
привязан к `plugin_id` (внутренняя модель service-key; публичный контракт
`/api/v2/service-keys` не расширен). Сервер принимает такой ключ **только** если выполнены три
условия (правило **fail-closed**, проверка на границе — после резолва service-креда, поэтому действует
на **все** серверные API, а не только на плагинные роуты):

1. запрос несёт заголовок `X-Synth-Plugin-Id` **и** его значение совпадает с `plugin_id` ключа —
   иначе `403 PLUGIN_ID_MISMATCH`;
2. у ключа есть scope `plugins:invoke` — иначе `403 SCOPE_REQUIRED`;
3. `plugin_id` входит в серверный allow-list (`plugins.hybrid.allow`) при
   `plugins.hybrid.mode: 'allowlist'` — иначе `403 PLUGIN_NOT_ALLOWED`.

В режиме `off` сервер не ограничивает плагины (проверка allow-list не применяется), но привязка
заголовка и требование scope действуют всегда. Обычный service-key (без `plugin_id`) и
интерактивные креды проверкой не ограничены.

**Маппинг причин отказа → HTTP** (исчерпывающая таблица `PLUGIN_REASON_HTTP` в
`packages/core/src/server/routes/plugins.ts`): `400` — `manifest_invalid`, `contract_mismatch`,
`host_mismatch`, `module_invalid`, `provides_mismatch`, `source_unavailable` (локальный источник);
`403` — `trust_below_floor`, `disabled`,
`not_allowlisted`, `denylisted`, `runtime_install_denied`, `scan_disabled_with_execution`,
`managed_readonly`, `hybrid_not_allowed` (серверная политика гибрида запрещает плагину работать);
`404` — `not_found`, `not_active`; `409` — `scan_rejected`, `integrity_mismatch`,
`integrity_unverifiable`, `execution_disabled`, `rollback_unavailable`, `approval_expired`,
`approval_stale` (недействительное подтверждение установки — конфликт состояния, не запрет
политикой: права проверяет guard роута); `202` — `approval_required`; `500` —
`loader_unavailable`, `disposer_failed` (сбой хоста, не клиента); `502` — `source_unavailable` для
сетевого источника. При активации
`execution_disabled`/`trust_below_floor`/`scan_rejected`/`approval_required` → `409`, `not_found` →
`404`, прочие отказы → `200 {activation: {outcome: 'rejected', reason}}`.

**Настройки — `/api/v2/settings/plugins`.** Runtime-override поверх `config.yaml` (`settings.json` /
PG, порт настроек): `enabled`, `executionEnabled`, `runtimeInstall` (`allow|deny`), `trustFloor`,
`scan` (`enabled|disabled`), `allowlist`/`denylist`/`remoteAllowlist`, `exactHostExceptions`,
`promptBlockMaxChars` (бюджет символов блока, дефолт 4 000), `llmFilterTimeoutMs` (бюджет фильтра,
дефолт 1 000), `hybrid` (`mode: off|allowlist` + `allow: string[]` — серверная политика плагинов в
гибриде, Ф7).

| Метод | Путь | RBAC (backend / core) | Назначение |
|---|---|---|---|
| GET | `/api/v2/settings/plugins` | ADMIN / auth | `{plugins (runtime), defaults (config), isOverridden, restartRequired: true, running, hybrid: {mode, allow}}` — блок `hybrid` — серверная политика плагинов в гибриде (ADR-090 Ф7); список `allow` отдаётся **только** при `mode: 'allowlist'`, в режиме `off` — `{mode: 'off', allow: []}` |
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

### 5.37 Внешние доступы — `/api/v2/oauth` (оба, ADR-105 Ф4)

Слой доступа к внешним сервисам (OAuth-коннекторам): выдача, чтение метаданных, обновление
токена, отзыв и привязка к MCP-коннектору. Единая фабрика `createOAuthRoutes`
(`packages/core/src/server/routes/oauth.ts`) для core и backend; хранилище —
`{dataDir}/secrets/oauth/credentials.json` (токены зашифрованы at-rest мастер-ключом, ADR-105 §3).

**Секрет наружу не отдаётся никогда**: ответы содержат только `ExternalCredentialMeta`
(маска `secretMask`, флаг `hasRefreshToken`). Значение токена доступно лишь `reveal()` —
подстановке в транспорт (ADR-105 §1).

**Право — на границе** (инвариант 16): «кем распоряжается доступом» решает
`engine/oauth/credential-binding.ts`; свой доступ — его владелец; инстансный — `ADMIN`/`LEAD`;
проектный — участник проекта с правом **изменения содержимого** (`OWNER`/`EDITOR`, а также
`LEAD`/`ADMIN`); нет доступа — 404, нет права — 403.

| Метод | Путь | Сборка | Назначение / req-resp |
|---|---|---|---|
| GET | `/api/v2/oauth/credentials` | оба | Список метаданных `{credentials, count}`: свои доступы; `ADMIN`/`LEAD` — все; проектные — участникам проекта с правом чтения |
| POST | `/api/v2/oauth/credentials` | оба | Выдача доступа (`oauthCredentialCreateSchema`): `{provider, flow?, code?, state?, scopes?, redirectUri?, projectId?, connectorId?, ownerKind?}` → **201** `{flow:'started', authorizationUrl, state, expiresAt}` (PKCE) либо `{flow:'started', state, userCode, verificationUri, verificationUriComplete?, interval, expiresAt}` (device flow), либо **201** `{flow:'completed', credential}` (завершение: передан `code`+`state` или `state` device-flow); device flow в ожидании → **202** `{flow:'pending', interval, expiresAt}`; невалидное тело → 400 `VALIDATION_ERROR`; провайдер не зарегистрирован → 400 `OAUTH_PROVIDER_UNKNOWN`; провайдер без device flow → 400 `OAUTH_DEVICE_FLOW_UNSUPPORTED`; ошибка провайдера → 400 `OAUTH_PROVIDER_ERROR`; `ownerKind:'instance'` не от `ADMIN`/`LEAD` → 403 `FORBIDDEN` |
| GET | `/api/v2/oauth/credentials/:id` | оба | Метаданные доступа (`ExternalCredentialMeta`); нет доступа → 404 `NOT_FOUND`; нет права на чтение → 403 `FORBIDDEN` |
| POST | `/api/v2/oauth/credentials/:id/refresh` | оба | Форсированное обновление access-токена → 200 `{credential}`; нет доступа → 404; нет права → 403; refresh отклонён провайдером (`invalid_grant`) → 409 `CONFLICT` (доступ переходит в `status:'error'` — нужна переавторизация); нет refresh-токена → 409 `CONFLICT`; доступ отозван → 409 `CONFLICT` |
| DELETE | `/api/v2/oauth/credentials/:id` | оба | Отзыв доступа (локально + best-effort RFC 7009 у провайдера) → 200 `{credential, providerRevoked}` (повторный отзыв идемпотентен — `revokedAt` не меняется); нет доступа → 404; нет права → 403; ошибка провайдера → 400 `OAUTH_PROVIDER_ERROR` (локальный отзыв при этом состоялся) |
| POST | `/api/v2/oauth/credentials/:id/bind` | оба | Привязка к MCP-коннектору (`oauthCredentialBindSchema`: `{connectorId}`) → 200 `{credentialId, connectorId, bound:true}`; нет доступа → 404; нет права → 403; коннектора нет → 404; коннектор принадлежит другому → 403; конфликт привязки → 409 `CONFLICT`; привязка недоступна в сборке → 409 `SERVICE_UNAVAILABLE` |

**Поля метаданных** (`ExternalCredentialMeta`): `id`, `provider`, `connectorId?`, `clientId`,
`scopes`, `owner` (`{kind: 'user'|'instance'|'local', id}`), `projectId?`, `status`
(`active|expired|revoked|error`), `expiresAt?`, `revokedAt?`, `createdBy`, `createdAt`,
`lastUsedAt?`, `scopesGranted?`, `secretMask` (маска, необратимая сводка), `hasRefreshToken`.

**Журнал операций со слоем доступов** (append-only, `{dataDir}/audit/credentials.jsonl`) —
**не является публичным API**: эндпоинта чтения нет. Записи (`issue`/`refresh`/`revoke`/`bind`/
`use`) пишутся портом `CredentialAuditRepository` best-effort и не содержат ни значений токенов,
ни `code_verifier`/`client_secret`, ни id пользователей. Подробности — `docs/EXTERNAL_ACCESS.md` §10.2.

**Каталог провайдеров** — `oauth.providers` в `config.yaml` (env `SYNTH_OAUTH_PROVIDERS`);
`client_secret` — только env `SYNTH_OAUTH_<PROVIDER>_CLIENT_SECRET` или файл
`{dataDir}/secrets/oauth/<provider>.client_secret` (в конфиге его нет).

**Пример.**

```bash
# Старт выдачи (PKCE) → authorizationUrl + state.
curl -X POST http://localhost:5000/api/v2/oauth/credentials \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"provider":"google","scopes":["https://www.googleapis.com/auth/drive.readonly"]}'

# Завершение выдачи (код авторизации + state) и чтение метаданных.
curl -X POST http://localhost:5000/api/v2/oauth/credentials \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"provider":"google","code":"<code>","state":"<state>"}'
curl http://localhost:5000/api/v2/oauth/credentials/extc_<...> \
  -H 'Authorization: Bearer admin-key-123'
```

### 5.38 Память — `/api/v2/memory` (оба, ADR-107 / PROP-047 §2.1)

Портал памяти в ядре: **чтение** поверх доменных портов памяти
(`MemoryFactRepository`/`MemoryIndexRepository`, ADR-096) и **мутации индексов**
(М2). Единая фабрика `createMemoryRoutes`
(`packages/core/src/server/routes/memory.ts`) для standalone-core и
managed-backend; backend добавляет только RBAC через `opts.guard`. Устройство
подсистемы — [docs/MEMORY.md](./MEMORY.md).

**Namespace задаёт сервер.** Порт памяти обслуживает несколько независимых
поставщиков, поэтому портал читает только свой namespace —
`plugin:synth-plugin-memory` (правило хоста: `plugin:<имя плагина>`). Параметр
`namespace` в query **игнорируется**: клиент подменить его не может. Записи
чужого namespace выглядят как «не найдено» (404), а не как отказ по правам.

**Права.** Чтение — `requireAuth` (core, standalone) / **ADMIN** (managed,
админский портал). Мутации индексов — **тот же guard**, что и у чтения
(managed — ADMIN). Портов памяти в сборке нет — контур отвечает **503
`MEMORY_UNAVAILABLE`** (деградация, а не 500).

**Проектная авторизация (инвариант 16, ADR-089 §5.8).** `projectId` — обычный
параметр запроса, поэтому права на проект проверяются **на границе** (до
обращения к порту/тулу), а не внутри обработчика: `read` — право **чтения**
проекта (владелец/участник/`LEAD`/`ADMIN`), `write` — право **изменения
содержимого** (владелец/`EDITOR`/`LEAD`/`ADMIN`; `VIEWER` только читает —
инвариант 21). Отказ — **403 `FORBIDDEN`**; сбой самой проверки (исключение) —
тоже 403 (fail-closed: проверка не должна превращаться в разрешение). В
managed портал дополнительно закрыт ролевым guard'ом (ADMIN) — проектная
проверка работает **поверх** него. Проверка не задана (standalone: пользователь
инстанса один) — доступ разрешён. `GET /status` вне проверки: агрегат по
инстансу, `projectId` у него нет. **404 раньше 403**: «нет сущности» (факта,
индекса, проекта) отвечает 404, а права проверяются уже по проекту найденной
сущности.

| Роут | Вид доступа | id проекта |
|---|---|---|
| `GET /memory/facts?projectId=` | `read` | query (не передан — проверки нет) |
| `GET /memory/facts/:id` | `read` | проект **самого факта** (нет проекта — проверки нет) |
| `GET /memory/indexes?projectId=` | `read` | query (не передан — проверки нет) |
| `POST /memory/indexes` | `write` | тело (обязателен; `scope:'instance'` — проверки нет) |
| `POST /memory/indexes/:id/rebuild` | `write` | проект **индекса** (`scope:'instance'` — проверки нет) |
| `DELETE /memory/indexes/:id` | `write` | проект **индекса** (`scope:'instance'` — проверки нет) |
| `POST /memory/consolidate` | `write` | тело (не передан — операция по инстансу) |
| `GET /memory/graph?projectId=` | `read` | query (не передан — проверки нет) |

**Область видимости индексов (`scope`).** У индекса памяти есть область
видимости (`MemoryIndexRecord.scope`, ADR-096): `project` (по умолчанию — индекс
виден только своему проекту) или `instance` (**инстансный** индекс — виден
**всем** на инстансе: общий корпус, например индекс по фактам памяти).

| | `scope: 'project'` (по умолчанию) | `scope: 'instance'` |
|---|---|---|
| `projectId` в теле | обязателен — **владелец** индекса | для `source.kind:'files'` — **источник корпуса** (чей workspace сканировать); для `source.kind:'facts'` — **не используется** (в тул не передаётся и в запись не пишется) |
| права на проект | `write` — проверяются **на границе** | **не применяются**: операция инстансная (в managed портал и так под ADMIN) |
| workspace проекта | обязателен при `source.kind:'files'` | обязателен при `source.kind:'files'` (источник корпуса) |
| параметр `scope` тула | не передаётся (дефолт плагина — `project`) | `scope: 'instance'` |

Правила:

- **`scope` не задан → `'project'`** (прежнее поведение); неизвестное значение
  (в теле или в query) → 400 `VALIDATION_ERROR`;
- **список**: `GET /api/v2/memory/indexes?scope=` — фильтр области видимости
  (`project`|`instance`; `all`/пусто — без фильтра). Фильтр `projectId` работает
  как раньше: у инстансного индекса с source-проектом он тоже совпадёт
  (осознанно: `projectId` инстансного индекса — это **источник корпуса**, а не
  область видимости; область видимости фильтруется отдельным `scope`);
- **пересборка/удаление**: у инстансного индекса права проекта **не
  проверяются**, а проект резолвится только как источник корпуса
  (`source.kind:'files'` и заданный `projectId`) — 404 `PROJECT_NOT_FOUND` /
  400 `MEMORY_WORKSPACE_REQUIRED`, но **без** проверки прав; у проектного —
  всё как прежде;
- **инстансные индексы создаёт только портал** (в managed — ADMIN, guard
  роли): тул плагина принимает `scope:'instance'` только для служебного вызова
  портала (`sessionId: 'system:memory-portal:<uuid>'`), обычный агентский вызов
  инстансный индекс не создаёт.

**Секреты и egress.** Портал **не маскирует** содержимое: обфускации при
индексации нет (обоснование и меры — [docs/MEMORY.md](./MEMORY.md) §10.1).
Текст чанков уходит провайдеру эмбеддингов как есть, а найденные фрагменты —
в LLM; поэтому индексировать стоит только каталоги без чувствительного текста.
Из корпуса **всегда** исключаются каталоги и файлы секретов — политика ядра
`engine/security/secret-files.ts` (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`,
`.terraform`, `.gcloud`, `secrets`; `.env*`, `credentials*.json`,
`secret(s).json|yaml|yml`, `service-account*.json`, `id_rsa|ed25519|ecdsa|dsa*`,
`*.pem|key|p12|pfx|jks|keystore|ppk|kdbx`, `*.tfstate*`); отключить исключения
нельзя. Рекомендация — **локальные** эмбеддинги (`plugins.embeddingProvider=ollama`):
тогда корпус не покидает хост. Модели, размерность и латентность —
[docs/MEMORY.md](./MEMORY.md) §2.4; смена модели помечает индексы `stale`
(пересборка — `POST /memory/indexes/:id/rebuild`).

| Метод | Путь | Сборка | Назначение / req-resp |
|---|---|---|---|
| GET | `/api/v2/memory/status` | оба | Состояние портала: `{provider:{id,mode,active}, readiness, namespace, facts:{total,active}, indexes:{total,ready,stale,failed,building}}`. `provider.id` = namespace, `provider.mode` = `inline` (плагин памяти по дизайну `inline`) или `null`, `provider.active` — активен ли плагин `synth-plugin-memory` в процессе. `readiness`: `ready` (сервис доступен, нет проблемных индексов) / `degraded` (есть индексы `failed`/`stale`) / `unavailable` (порты памяти не сконфигурированы — ответ **200**, портал показывает «память недоступна»). Счётчики — через порты (`count` фактов, выборка индексов) |
| GET | `/api/v2/memory/facts` | оба | Страница фактов: `{items, total, limit, offset}`. Параметры: `query` (подстрока по `text`, регистронезависимо; ищется **в памяти** после выборки — полнотекстовый поиск М2), `kind`, `status` (`candidate`\|`active`\|`superseded`\|`retracted`\|`all`; по умолчанию `active`), `projectId`, `limit` (1..200, по умолчанию 50), `offset` (≥ 0, по умолчанию 0). `total` — число записей **под фильтрами** (не длина страницы). Мусор в параметрах → 400 `VALIDATION_ERROR` |
| GET | `/api/v2/memory/facts/:id` | оба | Факт по id (`MemoryFactRecord` как есть); нет факта (или он чужого namespace) → 404 `MEMORY_FACT_NOT_FOUND` |
| GET | `/api/v2/memory/indexes` | оба | Страница индексов: `{items, total}` — записи `MemoryIndexRecord` **без чанков** (чанки — отдельный порт). Параметры: `projectId`, `state` (`building`\|`ready`\|`stale`\|`failed`\|`all`; по умолчанию `all`), `scope` (`project`\|`instance`\|`all`; по умолчанию `all` — без фильтра). Мусор в `state`/`scope` → 400 `VALIDATION_ERROR` |
| PATCH | `/api/v2/memory/indexes/:id` | оба | Тело `{enabled:boolean}` → 200 `{index}`: включить/выключить **проектный** индекс (не участвует в recall/search, остаётся в списке). `scope:'instance'` — 409 `MEMORY_INDEX_NOT_TOGGLEABLE` (общий индекс не отключается); нет индекса/чужой namespace → 404; не boolean → 400 `VALIDATION_ERROR` |
| POST | `/api/v2/memory/indexes` | оба | Создание индекса: тело `{name?, source?:{kind:'files'\|'facts', filter?}, projectId?, scope?:'project'\|'instance', force?}` → **202** `{index, message}`. `scope` не задан → `'project'` (прежнее поведение); `'instance'` — **инстансный** индекс (виден всем на инстансе), права проекта не применяются, а `projectId` для `source.kind:'files'` — источник корпуса (для `'facts'` — не используется). `index` — запись `MemoryIndexRecord` из порта (по `metadata.indexId` тула), если записи ещё нет — `metadata` тула; `index.scope` приходит из порта. `message` — локализованное подтверждение. Границы: проект обязателен (индекс файлов строится в проекте; для `scope:'instance'` — только при `source.kind:'files'`) → 400 `MEMORY_PROJECT_REQUIRED`; нет проекта → 404 `PROJECT_NOT_FOUND`; у проекта нет workspace при `source.kind === 'files'` → 400 `MEMORY_WORKSPACE_REQUIRED`; неизвестный `scope` → 400 `VALIDATION_ERROR`; провайдер недоступен → 409 `MEMORY_PROVIDER_UNAVAILABLE`; провал тула → 422 `MEMORY_INDEX_FAILED` |
| POST | `/api/v2/memory/indexes/:id/rebuild` | оба | Пересборка индекса: тело `{force?}` → **202** `{index}`. Проект и источник индекса берутся **из порта** (клиент их не подменяет). У инстансного индекса (`scope:'instance'`) права проекта **не проверяются**, а проект резолвится только как источник корпуса (`source.kind:'files'`): нет проекта → 404 `PROJECT_NOT_FOUND`, нет workspace → 400 `MEMORY_WORKSPACE_REQUIRED`. Нет индекса (или он чужого namespace) → 404 `MEMORY_INDEX_NOT_FOUND`; провайдер недоступен → 409 `MEMORY_PROVIDER_UNAVAILABLE`; провал тула → 422 `MEMORY_INDEX_FAILED` |
| DELETE | `/api/v2/memory/indexes/:id` | оба | Удаление индекса → **204**. У инстансного индекса (`scope:'instance'`) права проекта **не проверяются**. Нет индекса → 404 `MEMORY_INDEX_NOT_FOUND`; провайдер недоступен → 409 `MEMORY_PROVIDER_UNAVAILABLE`; провал тула → 422 `MEMORY_INDEX_FAILED` |
| POST | `/api/v2/memory/consolidate` | оба | Консолидация фактов: тело `{projectId?, threshold?, dryRun?}` → **200** `{report, message}`. `report` = `{clusters, superseded, kept, items}` — число кластеров, число вытесненных фактов, число канонов и состав кластеров (`items`: `{keptId, supersededIds, similarity}` на кластер). `threshold` — порог косинуса сходства (0.5..0.99), вне диапазона → 400 `VALIDATION_ERROR`; `dryRun` — прогон без записи (решает плагин). `projectId` — проект, чьи факты консолидируются; без него — факты инстанса; нет такого проекта → 404 `PROJECT_NOT_FOUND`. Workspace проекта **не требуется** (консолидация идёт по фактам). Провайдер недоступен → 409 `MEMORY_PROVIDER_UNAVAILABLE`; провал тула → 422 `MEMORY_CONSOLIDATION_FAILED` (машинный код тула — в `error.details.code`) |
| GET | `/api/v2/memory/graph` | оба | Чтение графа памяти: query `entity?` (сущность-старт обхода; не задана или пустая — «весь граф»), `depth?` (1..3, по умолчанию 1), `limit?` (1..200, по умолчанию 100), `projectId?` (скоуп графа) → **200** `{nodes, edges, stats}`. `nodes` — `{id, kind:'entity'\|'fact', name?, factId?, text?, entity?}`, `edges` — `{from, to, relation?}`, `stats` — `{entities, facts, edges}`. Мусор в `depth`/`limit` → 400 `VALIDATION_ERROR`; нет такого проекта → 404 `PROJECT_NOT_FOUND`; провайдер недоступен → 409 `MEMORY_PROVIDER_UNAVAILABLE`; провал тула → 422 `MEMORY_GRAPH_FAILED` (машинный код тула — в `error.details.code`) |

**Мутации: портал → админ-тул плагина через реестр.** Логика индекса
принадлежит **плагину** (PROP-047 §3: ядро владеет данными, плагин — логикой),
поэтому портал **не пишет в порт индексов напрямую**: он проверяет границы
(проект, workspace, доступность провайдера, права) и вызывает **админ-тул
плагина памяти** `plugin_synth_plugin_memory_memory_index`
(`pluginToolFullName('synth-plugin-memory', 'memory_index')`, ADR-090) через
реестр тулов — `executeToolDef` (`engine/tools/tool-execution.ts`). Тул —
**единственный владелец логики индекса**: создание, пересборка и удаление
делает он, портал отвечает только за HTTP-контракт.

| Параметр тула | Значение |
|---|---|
| `action` | `create` \| `rebuild` \| `delete` |
| `indexId` | id индекса (`rebuild`/`delete`) |
| `name` | имя индекса (`create`, по умолчанию `project` — на стороне плагина) |
| `source` | `{kind:'files'\|'facts', filter?}` (`create`, по умолчанию `files`) |
| `projectId` | проект-владелец индекса (для `scope:'instance'` — источник корпуса; для `source.kind:'facts'` инстансного индекса — не передаётся) |
| `scope` | `instance` — инстансный индекс (`create`); для проектных индексов не передаётся (дефолт плагина — `project`). Плагин принимает его **только** для служебного вызова портала (`sessionId: 'system:memory-portal:<uuid>'`) |
| `force` | принудительная пересборка (`rebuild`) |

Контекст вызова (sessionId/messageId/workingDir) создаёт **вызывающая
сторона** (`mount-routes`): у портала нет сессии, это служебный вызов инстанса
(`system:memory-portal:<uuid>`). `workingDir` — **рабочий каталог проекта**
(`project.workspace`, ADR-075); для источника `facts` без workspace — каталог
данных инстанса. Провайдер недоступен, если инвокер не сконфигурирован или
плагин памяти не активен в процессе (`PluginHost.isActive`) — тогда мутации
отвечают 409, а чтение работает как раньше. Текст ошибки тула (`isError`)
возвращается в 422 `MEMORY_INDEX_FAILED`; внутренние пути (каталог данных,
рабочий каталог) в нём маскируются.

**Консолидация фактов.** Консолидация (PROP-047 §2.1) — тоже **логика
плагина**: портал не считает кластеры сам, а вызывает админ-тул плагина
памяти `plugin_synth_plugin_memory_memory_consolidate`
(`pluginToolFullName('synth-plugin-memory', 'memory_consolidate')`, ADR-090)
тем же способом, что и мутации индексов. Плагин группирует факты в
**кластеры по косинусу сходства** эмбеддингов, в каждом кластере выбирает
**канон** (факт-эталон) и помечает остальные факты как `superseded` —
заменённые каноном дубликаты; отчёт — число кластеров, число заменённых
фактов, число канонов и состав каждого кластера
(`items: [{keptId, supersededIds, similarity}]`). Порог сходства задаёт
клиент (`threshold`, 0.5..0.99; по умолчанию — на стороне плагина), `dryRun`
прогоняет консолидацию **без записи** (только отчёт). В отличие от сборки
индекса операция **синхронная**: ответ 200 с отчётом, а не 202. Проект
опционален (`projectId` — консолидируются факты конкретного проекта, иначе
инстанса); **workspace не нужен** — консолидация идёт по фактам, а рабочий
каталог вызова равен workspace проекта, если он есть, иначе каталогу данных
инстанса. Провал тула → 422 `MEMORY_CONSOLIDATION_FAILED`, его машинный код
(напр. `plugin.embedding_not_configured`) — в `error.details.code`.

**Чтение графа памяти.** Граф (PROP-047 §2.1, М5) — тоже **логика плагина**:
сущности и их со-встречаемости плагин извлекает из текста фактов сам (ядро IR
графа не строит). Поэтому портал вызывает админ-тул плагина памяти
`plugin_synth_plugin_memory_memory_graph`
(`pluginToolFullName('synth-plugin-memory', 'memory_graph')`, ADR-090) тем же
способом, что и мутации индексов и консолидация: guard — **тот же**, что у
чтения (managed — ADMIN); недоступный провайдер (инвокер не задан или плагин не
активен) → 409 `MEMORY_PROVIDER_UNAVAILABLE`; провал тула → 422
`MEMORY_GRAPH_FAILED` (его машинный код — в `error.details.code`, внутренние
пути в тексте маскируются).

Граф собирается из упоминаний сущностей в фактах памяти: `[[сущность]]` — сущность
(узел `kind:'entity'`), `[[сущность|связь]]` — сущность с типом связи (ребро
`relation`); факт, в котором встретились сущности, — узел `kind:'fact'`, а
со-встречаемость двух сущностей в одном факте — ребро между ними. Ответ:
узлы (`nodes`), со-встречаемости (`edges`) и счётчики (`stats`). Форма ответа
нормализуется порталом: недоверенные метаданные тула не ломают
`{nodes, edges, stats}` (узел без `id`/с неизвестным `kind` и ребро без
`from`/`to` отбрасываются), а счётчики считаются **по нормализованным** узлам и
рёбрам — ответ плагина не может разойтись с формой графа.

Параметры: `entity` — сущность-старт обхода (не задана или пустая — «весь
граф»; непустая строка длиной до 200 символов, длиннее → 400
`VALIDATION_ERROR`); `depth` — глубина обхода (1 — сама сущность, 2 — её связи,
3 — связи связей; 1..3, по умолчанию 1); `limit` — потолок узлов ответа (1..200,
по умолчанию 100). Скоуп — `projectId` (необязательный): проект должен
существовать (нет такого → 404 `PROJECT_NOT_FOUND`), рабочий каталог вызова =
workspace проекта, иначе каталог данных инстанса (граф читается и без
workspace). Скоуп проекта уходит в **контекст вызова** тула (`projectId`),
а не в его параметры: контракт тула — `entity`/`depth`/`limit`.

**Коды ошибок:** `VALIDATION_ERROR` (400), `MEMORY_PROJECT_REQUIRED` (400),
`MEMORY_WORKSPACE_REQUIRED` (400), `PROJECT_NOT_FOUND` (404),
`MEMORY_FACT_NOT_FOUND` (404), `MEMORY_INDEX_NOT_FOUND` (404),
`MEMORY_PROVIDER_UNAVAILABLE` (409), `MEMORY_INDEX_FAILED` (422),
`MEMORY_CONSOLIDATION_FAILED` (422), `MEMORY_GRAPH_FAILED` (422),
`MEMORY_UNAVAILABLE` (503).

**Пример.**

```bash
# Статус портала памяти.
curl http://localhost:5000/api/v2/memory/status -H 'Authorization: Bearer admin-key-123'

# Активные факты с поиском по подстроке.
curl 'http://localhost:5000/api/v2/memory/facts?status=all&query=fleet&limit=20' \
  -H 'Authorization: Bearer admin-key-123'

# Индексы, требующие пересборки.
curl 'http://localhost:5000/api/v2/memory/indexes?state=stale' \
  -H 'Authorization: Bearer admin-key-123'

# Создать индекс файлов проекта (202 → {index, message}).
curl -X POST http://localhost:5000/api/v2/memory/indexes \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"projectId":"prj_1","name":"docs","source":{"kind":"files","filter":"**/*.md"}}'

# Инстансный индекс по фактам памяти — виден всем на инстансе (202).
curl -X POST http://localhost:5000/api/v2/memory/indexes \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"scope":"instance","name":"global-facts","source":{"kind":"facts"}}'

# Только инстансные индексы.
curl 'http://localhost:5000/api/v2/memory/indexes?scope=instance' \
  -H 'Authorization: Bearer admin-key-123'

# Пересобрать индекс (202) и удалить его (204).
curl -X POST http://localhost:5000/api/v2/memory/indexes/<indexId>/rebuild \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"force":true}'
curl -X DELETE http://localhost:5000/api/v2/memory/indexes/<indexId> \
  -H 'Authorization: Bearer admin-key-123'

# Консолидация фактов проекта в dry-run (200 → {report, message}).
curl -X POST http://localhost:5000/api/v2/memory/consolidate \
  -H 'Authorization: Bearer admin-key-123' -H 'Content-Type: application/json' \
  -d '{"projectId":"prj_1","threshold":0.85,"dryRun":true}'

# Граф памяти: сущность и её связи (200 → {nodes, edges, stats}).
curl 'http://localhost:5000/api/v2/memory/graph?entity=Fleet&depth=2&limit=50' \
  -H 'Authorization: Bearer admin-key-123'
```

### 5.39 Фоновые прогоны — `/api/v2/processes` (оба, ADR-111/PROP-097)

Единый реестр фоновой работы ([ADR-111](./arch_decisions/adr-111-background-subagent-sessions.md),
PROP-096/PROP-097): два вида прогонов — `subagent` (фоновая дочерняя сессия
саб-агента, `task({background: true})`) и `process` (фоновая шелл-команда,
`execute_shell({background: true})`). Запись реестра персистентна (порт
`BackgroundRunRepository`, ADR-096), поэтому состояние прогона переживает
реконнект UI и рестарт сервиса; «живые» хэндлы отмены живут в памяти процесса
(после рестарта записи `running` становятся `orphaned`).

Фабрика `createProcessRoutes` — общая для core и backend; managed передаёт
правило доступа по проекту (`packages/backend/src/routes/processes.ts`).

**Detached-прогоны.** Список и детали показывают и прогоны, переведённые в фон **посреди
хода** (`POST /api/v2/sessions/:id/background`, ADR-111 §detach): у них тот же вид
(`kind: 'subagent'`/`'process'`), тот же реестр и то же уведомление родителя о завершении.
Detached-процесс появляется в реестре **двумя** событиями канала сессии: `process.started`
(публикует реестр — по нему UI создаёт запись) и `process.detached` (семантика «прогон был
блокирующим и отвязан посреди хода»; `{session_id, kind:'process', id, process_id,
background_run_id, title?}`). Процесс при detach **не перезапускается**: в журнал
дописывается вывод, полученный до перевода (хвост — обычное уведомление родителя).
`POST /:id/stop` работает для них как для любого фонового прогона — это **единственный**
способ их остановить (отмена родительской сессии их не касается); `GET /:id/logs` доступен
для `kind: 'process'` с момента detach.

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/processes` | оба | auth | Список прогонов `{runs}`; фильтры `sessionId`/`projectId`/`kind` (`subagent`/`process`)/`status` (`running`/`completed`/`failed`/`cancelled`/`orphaned`)/`limit` (по умолчанию 50, максимум 200); неверный `kind`/`status` → 400 `VALIDATION_ERROR`. Выдаются только прогоны сессий, доступных пользователю (владелец/участник проекта; `ADMIN`/`LEAD` — все) |
| GET | `/api/v2/processes/:id` | оба | auth | Прогон `{run}` (запись реестра целиком); прогона нет → 404 `NOT_FOUND`, сессии-владельца нет → 404, нет прав → 403 `FORBIDDEN` |
| GET | `/api/v2/processes/:id/logs` | оба | auth | Отрезок лога фонового процесса `{content, offset, nextOffset, totalBytes, truncated}`; только `kind:'process'` (для `subagent` → 400 `VALIDATION_ERROR`), файла лога нет → 404 `NOT_FOUND`. `offset` — смещение в байтах от начала лога, `limit` — размер выдачи (по умолчанию и максимум — 256 КиБ) |
| POST | `/api/v2/processes/:id/stop` | оба | auth (**write**) | Остановить прогон → 200 `{status:'stopping'}` (остановка асинхронная: запрос остановки приходит событием `process.stopped`, итоговый статус — событием `process.exited`); прогон уже не `running` либо идёт в другом процессе (остановить отсюда нельзя) → 409 `CONFLICT` |
| DELETE | `/api/v2/processes/:id` | оба | auth (**write**) | Удалить запись реестра → **204**; прогон ещё `running` → 409 `CONFLICT` |

**Граница доступа (инварианты 16/21).** Право на прогон — это право на его
**сессию-владельца**, и проверяется оно **на границе**, а не в обработчике:
guard резолвит запись реестра и её сессию-владельца **один раз** и кладёт
запись в контекст Hono (`guardedProcess`); в обработчиках проверок доступа
нет — иначе правила разошлись бы. Вид доступа выводится из HTTP-метода
(`read` — чтение, `write` — мутация): участник проекта с ролью просмотра
(`VIEWER`) читает прогон, но **не** может его остановить или удалить
(инвариант 21). Правила ролей managed: владелец сессии; `ADMIN` — сквозной
доступ; `LEAD` — сквозной доступ к содержимому проекта; участник проекта —
`read` любая роль, `write` — `OWNER`/`EDITOR`/`LEAD`/`ADMIN`. В standalone
(core) действует предикат единственного владельца инстанса. Список прогонов
фильтруется по тому же правилу: запись, чью сессию не видно, в выдаче не
появляется вовсе (сессии кэшируются на один запрос, не на процесс — права
меняются, кэш процесса раздавал бы устаревшие решения).

**Деградированный режим хранилища (ADR-098).** В деградированном режиме
сервисы фоновой работы не создаются — контур `/api/v2/processes` **не
монтируется**, поэтому все эндпоинты раздела отвечают `404` (контура нет).

**События.** Живые изменения приходят в **канале сессии-владельца**
(`process.started`/`process.stopped`/`process.exited`/`process.detached`/`child.*`,
ADR-009/ADR-024; новых транспортных каналов нет) — состав и поля событий — §3.2. Фоновый
саб-агент дополнительно публикует уведомление в историю родителя и ставит
родительский ход в очередь (автоход) — по
[ADR-111](./arch_decisions/adr-111-background-subagent-sessions.md).

**Хранилище.** Реестр — `{dataDir}/processes/registry.json` (ADR-005, атомарная
запись); PostgreSQL — таблица `background_runs` (миграция `021_background_runs`
драйвера `@itphx/synth-storage-postgres`, ADR-097). Логи фоновых процессов —
blob-хранилище (`BlobStore`), путь `processes/<id>.log`; предел записи лога —
`background.logMaxBytes` (потолок выдачи за один HTTP-запрос — 256 КиБ, это
разные величины).

**UI.** Вкладка «Процессы» правой панели
(`packages/ui/src/components/panels/ProcessesTab.tsx`): список прогонов (вид,
статус, команда/описание, время), лог фонового процесса, «Остановить» и
удаление записи. Обновление — live-события `process.*`/`child.*` плюс
периодическое перечитывание списка, пока вкладка активна.

### 5.40 Worktrees — `/api/v2/projects/:id/worktrees*` (оба, ADR-114)

Вторичные рабочие копии репозитория ([ADR-114](./arch_decisions/adr-114-git-worktrees.md)):
сессия может работать в своём каталоге (`git worktree`), не пересекаясь с
другими сессиями того же проекта. Полный контракт подсистемы —
[docs/WORKTREES.md](./WORKTREES.md); ниже — HTTP-часть.

Фабрика `createProjectRoutes` (core) монтирует контур, когда передан сервис
worktree'ов (`opts.worktrees`); backend добавляет только правила доступа по
проекту. Инвентарь — доменный порт `WorktreeRepository` (ADR-096): файл
`{dataDir}/worktrees.json`, in-memory и PostgreSQL (generic-таблица
`documents`, `kind='worktree'`, без новой миграции).

| Метод | Путь | Сборка | RBAC (managed) | Назначение / req-resp |
|---|---|---|---|---|
| GET | `/api/v2/projects/:id/worktrees` | оба | право **чтения** проекта | Инвентарь проекта → `200 { worktrees: WorktreeSummary[] }`. Записи — **camelCase**: `id`, `projectId`, `repoPath?`, `directory`, `branch`, `name`, `strategy`, `createdAt`, `updatedAt`, `createdBy?` + вычисляемые `attachedSessionId?` (привязанная живая сессия), `dirty?` (есть незакоммиченные изменения), `exists?` (каталог на месте). Проекта нет → 404 `NOT_FOUND`; нет права чтения → 403 `FORBIDDEN` |
| POST | `/api/v2/projects/:id/worktrees` | оба | право **изменения содержимого** проекта | Создать worktree → `201 { worktree: WorktreeRecord, setup? }`. Тело: `{ branch?, name?, repoPath?, from? }` (все поля необязательные; `name` — slug `^[a-z0-9][a-z0-9._-]{0,63}$`, `branch` — без пробелов/`..`/`~`/`^`/`:`/`?`/`*`/`[`/`\`, `repoPath` — относительный путь без `..`, `from` — база ветки). `setup` присутствует, только если у проекта задан `worktreeSetupScript` (`{ok, exitCode?, error?}`). Ошибки: 400 `VALIDATION_ERROR` (тело), 400 `WORKTREE_NOT_A_REPO` (путь не git-репозиторий или у проекта нет рабочего каталога), 409 `WORKTREE_GIT_FAILED` (команда git/не найдена база ветки), 409 `WORKTREE_PATH_EXISTS` (не нашлось свободного имени каталога) |
| DELETE | `/api/v2/projects/:id/worktrees/:wid` | оба | право **изменения содержимого** проекта | Удалить worktree → **204** (тело пустое). `?force=true` (а также `?force=1`/`?force` без значения) — снять и **незакоммиченные изменения**. Ошибки: 404 `WORKTREE_NOT_FOUND` (записи нет или она чужого проекта — существование не выдаётся), 409 `WORKTREE_DIRTY` (есть незакоммиченные изменения, нужен `force`; в теле — `error.forceRequired: true`), 409 `WORKTREE_BUSY` (к записи привязана живая сессия — даже с `force`: привязку снимает `PATCH` сессии), 409 `WORKTREE_GIT_FAILED` |
| POST | `/api/v2/projects/:id/worktrees/prune` | оба | право **изменения содержимого** проекта | Вычистить осиротевшие записи → `200 { recordsRemoved: number, gitPruned: boolean }`. Тело **опционально**: пустое/отсутствующее — успех; непустое — строгая схема (лишнее поле → 400 `VALIDATION_ERROR`). Удаляются **только записи без каталога** + выполняется `git worktree prune` (`gitPruned: false` — репозиторий недоступен, записи всё равно вычищены); каталоги без записей не трогаются |
| PATCH | `/api/v2/sessions/:id` | оба | доступ к сессии по prefix-guard'у (§5.5) | Привязка сессии к worktree: поле `worktreeId: string \| null` (`null` — снять привязку). В ответе — обновлённая сессия, поле `worktree` — **snake_case**-снимок привязки `{ worktree_id, project_id, repo_path, directory, branch }` либо `null`. Ошибки: 400 `VALIDATION_ERROR` (`worktreeId` — не строка и не `null`; у сессии нет проекта; привязка недоступна в этом инстансе), 404 `WORKTREE_NOT_FOUND` (записи нет в проекте сессии), 409 `WORKTREE_DIRECTORY_MISSING` (каталога привязываемого worktree нет на диске), 404 `NOT_FOUND` (сессии нет/нет доступа — решает prefix-guard) |

**Права (инвариант 21).** Чтение инвентаря — право **чтения** проекта
(`canReadProject`: владелец, любой участник, `LEAD`, `ADMIN`); мутации
(`POST`/`DELETE`/`prune`) — право **изменения содержимого** (`canEditProjectContent`:
`OWNER`, `EDITOR`, `LEAD`, `ADMIN`); `VIEWER` читает, но получает **403
`FORBIDDEN`** на мутации. `ADMIN`/`LEAD` — сквозной доступ. В standalone
(core) ролевых проверок нет (любой аутентифицированный). Проверка доступа —
**на границе** (инвариант 16), в обработчиках её нет. Матрица доступа
(владелец/`EDITOR`/`VIEWER`/`ADMIN`/`LEAD`/посторонний) — тест
`packages/backend/src/routes/worktree-access-matrix.test.ts`: проверяет
production-модуль и снимает перечень маршрутов со **смонтированного** приложения
(появился `:id`-маршрут — тест красный).

**Событие.** Изменение инвентаря публикуется событием `worktree.updated` в
**каналы сессий проекта** (инвентарь — ресурс проекта, а не одной сессии):
payload — **snake_case** `{ project_id, worktree_id?, action }`, где `action` ∈
`created | removed | pruned | attached | detached`. Создание и удаление worktree
меняют файлы на диске — дополнительно публикуется `fs.changed { scope: 'all' }`
(ADR-024/ADR-089). Новых транспортных каналов нет.

**Прочее.** Осиротевшие записи (каталог исчез) чистятся **при старте процесса**
(sweep, ADR-114 §7.4) и `prune` проекта; UI-поведение —
[docs/WORKTREES.md](./WORKTREES.md) §9.

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
| Плагины (ADR-090) | `packages/core/src/server/routes/plugins.ts`, `packages/core/src/engine/plugins/*` (хост, загрузчик, установщик, рантайм), `packages/shared/src/types/{pack,plugin-audit,plugin-lock,plugin-scan,prompt-blocks,llm-filters,plugin-tools}.ts` |
| Внешние доступы (ADR-105) | `packages/core/src/server/routes/oauth.ts`, `packages/core/src/engine/oauth/*` (клиент, сервис, реестр, аудит), `packages/core/src/storage/external-credential-store.ts`, `packages/core/src/storage/ports/{external-credential-repository,credential-audit-repository}.ts`, `packages/shared/src/types/external-credentials.ts` |
| Память: портал и метрики (ADR-107, PROP-047) | `packages/core/src/server/routes/memory.ts`, `packages/core/src/metrics/collectors/memory.ts`, `packages/core/src/storage/ports/{memory-fact-repository,memory-index-repository}.ts`, `packages/core/src/engine/plugins/scoped-memory.ts` |
| Фоновые прогоны: реестр, сервисы, HTTP-контур (ADR-111, PROP-096/097) | `packages/core/src/server/routes/processes.ts`, `packages/core/src/engine/background/*`, `packages/core/src/engine/processes/*`, `packages/core/src/storage/ports/background-run-repository.ts`, `packages/backend/src/routes/processes.ts`, `packages/shared/src/types/background.ts` |
| Worktrees: сервис, порт инвентаря, HTTP-контур, событие (ADR-114) | `packages/core/src/engine/worktree/*`, `packages/core/src/storage/ports/worktree-repository.ts`, `packages/core/src/storage/file-worktree-store.ts`, `packages/core/src/server/routes/projects.ts`, `packages/core/src/server/routes/sessions.ts`, `packages/core/src/engine/tools/worktree.ts`, `packages/shared/src/types/worktree.ts` |
| EventHub | `packages/backend/src/events/hub.ts` |
| Rate limiter | `packages/backend/src/middleware/rate-limiter.ts` |
| Core standalone app + SSE/WS | `packages/core/src/server/app.ts` |
| Core роуты | `packages/core/src/server/routes/*.ts` |
| Core auth | `packages/core/src/auth/local.ts` |
| Контракты (`BusEvent`) | `packages/shared/src/types/index.ts` |
