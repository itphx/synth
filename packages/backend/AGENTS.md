# synth-backend

## Назначение

API Hub системы Synth. Связующее звено между synth-ui, synth-runner и synth-core.

**Что делает:**
- Аутентификация / авторизация (cookie-based + API key + OIDC Keycloak)
- Управление проектами и сессиями (CRUD, JSON-хранилище)
- Очередь сообщений (FIFO, per-session)
- SessionEventBus (WebSocket + SSE hub для real-time коллаборации)
- Runner Registry (подключение и управление раннерами)
- LLM Proxy (аудит и маршрутизация запросов движков на реальных провайдеров)
- Admin API (JSON, без HTML)

**Что НЕ делает:**
- Не выполняет LLM-вызовы напрямую (движок работает отдельно)
- Не рендерит HTML (админка в synth-ui)
- Не управляет процессами движков (это synth-runner)
- Не работает с файловой системой пользователя (это synth-runner)

## Технологический стек

| Компонент | Выбор |
|-----------|-------|
| Язык | TypeScript (strict mode) |
| Рантайм | Node.js 22+ |
| Фреймворк | Hono |
| Валидация | Zod |
| Тестирование | Vitest |
| Пакетный менеджер | pnpm |
| Хранилище | JSON-файлы (AD-005) |
| Типы | @itphx/synth-shared |

## Структура проекта

```
packages/backend/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts              # Hono app, точка входа
│   ├── config.ts            # Загрузка config.yaml
│   ├── app.ts               # Создание и настройка приложения
│   ├── middleware/
│   │   ├── auth.ts          # Аутентификация (cookie, API key, OIDC)
│   │   ├── cors.ts          # CORS
│   │   ├── logger.ts        # Логирование запросов
│   │   ├── error.ts         # Обработка ошибок
│   │   └── rbac.ts          # Проверка ролей (ADMIN, USER)
│   ├── routes/
│   │   ├── index.ts         # Регистрация всех маршрутов
│   │   ├── health.ts        # GET /health
│   │   ├── auth.ts          # /auth/*
│   │   ├── sessions.ts      # /api/v2/sessions/*
│   │   ├── messages.ts      # /api/v2/messages/*
│   │   ├── projects.ts      # /api/v2/projects/*
│   │   ├── providers.ts     # /api/v2/providers/*
│   │   ├── models.ts        # /api/v2/models/*
│   │   ├── agents.ts        # /api/v2/agents/*
│   │   ├── queue.ts         # /api/v2/queue/*
│   │   ├── fs.ts            # /api/v2/fs/*
│   │   ├── i18n.ts          # /api/v2/i18n/*
│   │   ├── context.ts       # /api/v2/context/*
│   │   ├── users.ts         # /api/v2/users/* (admin)
│   │   ├── profile.ts       # /api/v2/profile/*
│   │   ├── mcp.ts           # /api/v2/mcp/*
│   │   └── runner.ts        # /api/v2/runner/* (внутренний)
│   ├── ws/
│   │   ├── hub.ts           # WebSocket сервер (Hono upgrade)
│   │   ├── chat.ts          # WS /ws/chat — обработчик чата
│   │   └── runner.ts        # WS /ws/runner — обработчик раннера
│   ├── sessions/
│   │   ├── manager.ts       # SessionManager (CRUD, блокировки, TSM)
│   │   └── storage.ts       # SessionStorage (JSON файлы)
│   ├── projects/
│   │   ├── manager.ts       # ProjectManager (CRUD, участники)
│   │   └── storage.ts       # ProjectStorage (JSON файлы)
│   ├── queue/
│   │   ├── processor.ts     # QueueProcessor (фоновый обработчик)
│   │   ├── enqueue.ts       # enqueueUserMessage()
│   │   └── manager.ts       # QueueProcessorManager (singleton)
│   ├── events/
│   │   ├── bus.ts           # SessionEventBus (pub/sub)
│   │   └── types.ts         # Типы событий
│   ├── providers/
│   │   ├── base.ts          # BaseProvider (интерфейс)
│   │   ├── factory.ts       # ProviderFactory
│   │   ├── openai.ts        # OpenAI + Generic
│   │   ├── anthropic.ts     # Anthropic
│   │   └── ollama.ts        # Ollama
│   ├── proxy/
│   │   └── llm.ts           # LLM Proxy endpoint (для раннеров)
│   ├── runner/
│   │   ├── registry.ts      # RunnerRegistry
│   │   └── protocol.ts      # Runner Protocol (WS-сообщения)
│   ├── auth/
│   │   ├── oidc.ts          # OIDC Client (Keycloak)
│   │   └── storage.ts       # AuthStorage (сессии, state, профили)
│   ├── context/
│   │   ├── builder.ts       # ContextBuilder
│   │   ├── optimizer.ts     # ContextOptimizer
│   │   └── config.ts        # ContextConfig
│   ├── agents/
│   │   └── registry.ts      # AgentRegistry
│   ├── lib/
│   │   └── mcp-config-store.ts  # YamlMcpConfigStore (чтение/запись MCP-конфигурации в config.yaml)
│   ├── debug.ts             # DebugCollector (per-session)
│   └── logger.ts            # Структурированное логирование
├── data/                    # runtime данные (gitignore)
│   ├── config/
│   │   ├── config.yaml
│   │   ├── providers.yaml
│   │   └── models.yaml
│   ├── sessions/
│   ├── projects/
│   ├── context/
│   │   ├── user/
│   │   └── roles/
│   └── auth/
│       ├── sessions/
│       ├── states/
│       └── profiles/
└── prompts/                 # Системные промпты
    ├── system/
    ├── roles/
    └── tsm/
```

## API v2 — спецификация

Базовый URL: `http://localhost:5000/api/v2`

### Принципы дизайна

1. **Иерархия ресурсов** — подресурсы через вложенные пути: `/sessions/:id/messages`
2. **HTTP-методы по назначению** — GET/POST/PUT/PATCH/DELETE, без глаголов в URL
3. **Единое дерево API** — админка отличается правами, не путём
4. **Без GET-сайдэффектов** — SSE-подписка (`/events`) — исключение (стандарт)
5. **Пагинация курсором** — `?cursor=&limit=` для списков
6. **Версионирование** — префикс `/api/v2/` позволяет сосуществовать с легаси

### Формат ошибок

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Сессия не найдена",
    "details": {}
  }
}
```

Коды ошибок: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL_ERROR`

---

### 1. Health

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/api/v2/health` | Health check. Ответ: `{status: "healthy", version: "..."}` |

---

### 2. Аутентификация

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/auth/login` | Редирект на OIDC / форма логина |
| `POST` | `/auth/login` | Обработка формы (API ключ) |
| `GET` | `/auth/callback` | OIDC callback |
| `POST` | `/auth/logout` | Выход |
| `GET` | `/auth/me` | Текущий пользователь |
| `GET` | `/auth/status` | Статус аутентификации |
| `GET` | `/auth/session` | Проверка cookie-сессии |
| `POST` | `/auth/spa-login` | SPA-логин (JSON) |
| `GET` | `/auth/locales` | Доступные локали |

---

### 3. Сессии (`/api/v2/sessions`)

| Метод | Путь | Назначение | Тело |
|-------|------|------------|------|
| `GET` | `/sessions` | Список сессий | `?project_id=&search=&cursor=&limit=` |
| `POST` | `/sessions` | Создать | `SessionCreateRequest` |
| `GET` | `/sessions/:id` | Получить | — |
| `PATCH` | `/sessions/:id` | Обновить (название, настройки, engine) | `SessionUpdateRequest` |
| `DELETE` | `/sessions/:id` | Удалить | — |

**Подресурсы сессии:**

| Метод | Путь | Назначение |
|-------|------|------------|
| `POST` | `/sessions/:id/prompt` | Отправить сообщение (SSE-стрим) |
| `POST` | `/sessions/:id/abort` | Отменить текущий стрим |
| `POST` | `/sessions/:id/fork` | Форкнуть сессию (опционально `?messageID=`) |
| `POST` | `/sessions/:id/summarize` | Принудительная суммаризация |
| `POST` | `/sessions/:id/checkpoint` | Создать checkpoint |
| `POST` | `/sessions/:id/checkpoint/:ckid` | Восстановить из checkpoint |
| `GET` | `/sessions/:id/status` | Статус: `blocked`, `pending_count`, `processor_running` |
| `GET` | `/sessions/:id/events` | SSE-подписка на события сессии |
| `GET` | `/sessions/:id/messages` | Сообщения (пагинация: `?cursor=&limit=`) |

**Prompt** — единый эндпоинт для отправки:

```typescript
// Запрос
POST /api/v2/sessions/:id/prompt
{
  messageID?: string          // клиент генерирует
  content: string
  stream?: boolean            // default: true
  model?: string
  provider?: string
  agent?: string
  system?: string             // переопределение system prompt
}

// Ответ: SSE stream (text/event-stream)
event: stream.start
data: {"stream_id": "..."}

event: stream.chunk
data: {"content": "...", "reasoning": "..."}

event: stream.done
data: {"content": "...", "model": "...", "usage": {...}, "message_index": 5}
```

---

### 4. Сообщения (`/api/v2/messages`)

| Метод | Путь | Назначение |
|-------|------|------------|
| `PATCH` | `/messages/:sessionId/:index` | Обновить сообщение (disabled, pinned) |
| `PATCH` | `/messages/:sessionId/:index/toggle` | Переключить disabled |
| `PATCH` | `/messages/:sessionId/:index/pin` | Переключить pinned |
| `DELETE` | `/messages/:sessionId/:index` | Удалить сообщение |
| `GET` | `/messages/:sessionId/:index/debug` | Debug-информация |

---

### 5. Очередь (`/api/v2/queue`)

| Метод | Путь | Назначение |
|-------|------|------------|
| `POST` | `/queue/:sessionId/clear` | Очистить очередь |
| `POST` | `/queue/:sessionId/return` | Вернуть очередь в input |
| `POST` | `/queue/:sessionId/resume` | Возобновить обработку |

---

### 6. Проекты (`/api/v2/projects`)

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/projects` | Список проектов пользователя |
| `POST` | `/projects` | Создать |
| `GET` | `/projects/:id` | Детали проекта |
| `PUT` | `/projects/:id` | Обновить поля |
| `DELETE` | `/projects/:id` | Удалить |
| `POST` | `/projects/:id/members` | Добавить участника |
| `DELETE` | `/projects/:id/members/:userId` | Удалить участника |
| `GET` | `/projects/:id/status-messages` | История статусных сообщений |
| `POST` | `/projects/:id/status-messages` | Добавить статусное сообщение |
| `GET` | `/projects/:id/stats` | Статистика токенов |

---

### 7. Провайдеры и модели (`/api/v2/providers`, `/api/v2/models`)

**Публичные (доступны всем авторизованным):**

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/providers` | Список провайдеров |
| `GET` | `/models?provider=` | Список моделей |

**Админские (требуют роль ADMIN):**

| Метод | Путь | Назначение |
|-------|------|------------|
| `POST` | `/providers` | Создать/обновить провайдера |
| `DELETE` | `/providers/:name` | Удалить провайдера |
| `POST` | `/providers/:name/test` | Тест подключения |
| `POST` | `/models` | Создать/обновить модель |
| `POST` | `/models/fetch` | Синхронизировать модели с провайдера |
| `DELETE` | `/models/:id` | Удалить модель |

---

### 8. Агенты (`/api/v2/agents`)

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/agents?session_id=` | Список агентов |

**Админские:**

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/agents/:id` | Детали агента |
| `POST` | `/agents` | Создать/обновить |
| `DELETE` | `/agents/:id` | Сбросить к default |
| `PATCH` | `/agents/:id/enabled` | Включить/выключить |

---

### 9. Файлы (`/api/v2/fs`)

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/fs?project_id=&path=` | Список файлов в директории |
| `GET` | `/fs/read?project_id=&path=` | Содержимое файла |

---

### 10. Контекст (`/api/v2/context`)

**Админские:**

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/context/files` | Список контекст-файлов |
| `GET` | `/context/files/:name?category=` | Содержимое файла |
| `POST` | `/context/files/:name` | Сохранить файл |
| `DELETE` | `/context/files/:name` | Удалить файл |
| `GET` | `/context/enabled` | Включённые файлы |
| `POST` | `/context/enabled` | Установить включённые |
| `POST` | `/context/enabled/:name` | Переключить enabled |
| `GET` | `/context/roles` | Файлы ролей |
| `GET` | `/context/summarization` | Настройки суммаризации |
| `POST` | `/context/summarization` | Обновить настройки |

---

### 11. Пользователи и профиль (`/api/v2/users`, `/api/v2/profile`)

**Профиль (текущий пользователь):**

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/profile` | Профиль текущего пользователя |
| `PUT` | `/profile` | Обновить профиль |
| `PATCH` | `/profile/preferences` | Обновить предпочтения |
| `DELETE` | `/profile/preferences` | Сбросить предпочтения |

**Админские (управление пользователями):**

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/users` | Список пользователей |
| `GET` | `/users/:id` | Профиль пользователя |
| `POST` | `/users` | Создать пользователя |
| `PUT` | `/users/:id` | Обновить пользователя |
| `DELETE` | `/users/:id` | Удалить пользователя |
| `GET` | `/users/defaults` | Default preferences |
| `PUT` | `/users/defaults` | Обновить defaults |

---

### 12. i18n (`/api/v2/i18n`)

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/i18n/current` | Текущий язык |
| `GET` | `/i18n/translations/:lang` | Словарь для языка |
| `GET` | `/i18n/contexts` | Контекстные файлы |
| `GET` | `/i18n/contexts/:name?lang=` | Содержимое контекстного файла |
| `PUT` | `/i18n/language` | Установить язык |

---

### 13. Runner (внутренний API для раннеров)

| Метод | Путь | Назначение |
|-------|------|------------|
| `POST` | `/runner/proxy/v1/chat/completions` | LLM Proxy (OpenAI-совместимый) |

**WebSocket `/ws/runner`** — протокол управления раннером (AD-022).

---

### 14. Admin — блокировки и восстановление

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/admin/sessions/blocked` | Список заблокированных сессий |
| `GET` | `/admin/sessions/:id/pending` | Pending-сообщения |
| `POST` | `/admin/sessions/:id/unlock` | Принудительная разблокировка |
| `POST` | `/admin/sessions/cleanup` | Очистка stale locks |
| `GET` | `/admin/debug/config` | Конфигурация логирования |
| `POST` | `/admin/debug/config` | Обновить конфигурацию |

---

### 15. MCP-серверы (`/api/v2/mcp`)

Управление MCP-серверами (Model Context Protocol). Чтение доступно всем авторизованным, запись — ADMIN.

| Метод | Путь | Назначение | RBAC |
|-------|------|------------|------|
| `GET` | `/mcp/servers` | Список сконфигурированных серверов | все |
| `POST` | `/mcp/servers` | Добавить/обновить сервер | ADMIN |
| `GET` | `/mcp/servers/:name` | Конфигурация сервера | все |
| `PUT` | `/mcp/servers/:name` | Обновить сервер | ADMIN |
| `DELETE` | `/mcp/servers/:name` | Удалить сервер | ADMIN |
| `POST` | `/mcp/servers/:name/test` | Проверить подключение | ADMIN |
| `GET` | `/mcp/servers/:name/tools` | Список инструментов сервера | все |

**Управление MCP-серверами в сессии:**

| Метод | Путь | Назначение |
|-------|------|------------|
| `GET` | `/mcp/session/:sessionId` | Получить список активных серверов сессии |
| `PUT` | `/mcp/session/:sessionId` | Установить активные серверы для сессии |

**Формат конфигурации сервера:**

```typescript
interface McpServerConfig {
  type: 'stdio' | 'sse';           // тип подключения
  command?: string;                 // команда для stdio
  args?: string[];                  // аргументы для stdio
  env?: Record<string, string>;     // переменные окружения
  url?: string;                     // URL для SSE
  enabledByDefault?: boolean;       // включён по умолчанию для новых сессий
  timeout?: number;                 // таймаут вызова инструмента (сек)
  connectTimeout?: number;          // таймаут подключения (сек)
}
```

---

### WebSocket

| Путь | Назначение | Протокол |
|------|------------|----------|
| `/ws/chat` | Чат (отправка + стриминг) | `?token=&session_id=` |
| `/ws/runner` | Управление раннерами | Runner Protocol |

---

## Модели данных

Импортируются из `@itphx/synth-shared`. Локально определяются только бэкенд-специфичные:

```typescript
// @itphx/synth-shared
export interface Session { ... }
export interface Message { ... }
export interface Project { ... }
export interface User { ... }
export interface AgentDefinition { ... }
export interface QueueItem { ... }
export interface TSMStatus { ... }
export interface SessionSettings { ... }

// synth-backend локальные
export interface StreamInfo {
  streamId: string;
  message: string;
  agentRole?: string;
  startedAt: string;
  cancelled: boolean;
  chunks: StreamChunk[];
}
```

---

## WebSocket протокол чата

### Клиент → Сервер

| Тип | Поля | Назначение |
|-----|------|------------|
| `send_message` | `content`, `stream_id`, `agent_role`, `provider`, `model` | Отправить сообщение |
| `cancel` | — | Отменить текущий стрим |
| `ping` | — | Heartbeat |

### Сервер → Клиент

| Тип | Поля | Назначение |
|-----|------|------------|
| `connected` | `session_id`, `client_id`, `engine` | Подтверждение |
| `stream.start` | `stream_id`, `agent_role` | Начало генерации |
| `stream.chunk` | `stream_id`, `content`, `reasoning`, `is_final` | Чанк ответа |
| `stream.done` | `stream_id`, `content`, `model`, `usage`, `message_index`, `pending_count` | Завершение |
| `stream.cancelled` | `stream_id`, `content` | Отмена |
| `stream.error` | `stream_id`, `error`, `error_type`, `retry_count`, `can_retry` | Ошибка |
| `message.added` | `message_index`, `role`, `content`, `author`, `agent_role`, `model` | Новое сообщение |
| `message.updated` | `message_index`, `changes` | Обновление |
| `queue.stalled` | `pending_count` | Очередь зависла |
| `message.queued` | `stream_id`, `pending_count`, `message`, `agent_role` | В очереди |
| `pong` | — | Heartbeat ответ |

---

## Аутентификация

Три метода, приоритет по порядку проверки:

1. **Cookie `user_session`** — серверная сессия (основной для SPA)
2. **OIDC Bearer token** — `Authorization: Bearer <jwt>` (если oidc.enabled)
3. **API Key** — `Authorization: Bearer <api-key>` (для CLI/автоматизации)

### Middleware

```typescript
// middleware/auth.ts
import type { Context, Next } from 'hono';

// Возвращает User или null (без ошибки)
async function getCurrentUser(c: Context): Promise<User | null>

// Возвращает User или 401
async function requireUser(c: Context, next: Next): Promise<void>

// Возвращает User с ролью ADMIN или 403
async function requireAdmin(c: Context, next: Next): Promise<void>

// Проверяет API-ключ
async function verifyApiKey(c: Context): Promise<string | null>
```

### Debug Mode

При `config.auth.debug_mode = true` и OIDC отключен:
- Пользователь может войти указав любой username
- Доступны все роли (ADMIN, USER)
- Используется только для разработки

---

## Хранилище

Все данные — JSON-файлы в `data/` (AD-005). Формат унаследован от synth-legacy.

**Атомарная запись:** писать во временный файл `.tmp.{uuid}`, затем `rename()`.

**Блокировки сессий:** per-session `Mutex` (асинхронный). Защищает весь read-modify-write цикл.

---

## Конфигурация

Приоритет:
1. Переменные окружения (префикс `SYNTH_`)
2. `data/config/config.yaml`
3. Значения по умолчанию

```yaml
# data/config/config.yaml
server:
  port: 5000
  host: "0.0.0.0"

auth:
  api_key: ""                    # API-ключ
  session_max_age_minutes: 1440  # 24 часа
  debug_mode: false
  oidc:
    enabled: false
    issuer: ""
    client_id: ""
    client_secret: ""

llm:
  default_provider: "openai"
  default_model: "gpt-4o"

storage:
  data_dir: "data"
```

---

## Запуск (dev)

```bash
cd synth-backend
pnpm install
pnpm run dev
```

Сервер на `http://localhost:5000`.
