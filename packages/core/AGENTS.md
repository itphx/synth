# @synth/core

## Назначение

Ядро системы Synth. Содержит всю общую логику, используемую как synth-backend (облачный режим) так и автономно (standalone CLI).

Два режима работы:

| Режим | Команда | API | Auth | Файлы |
|-------|---------|-----|------|-------|
| **Standalone** | `synth serve`, `synth chat` | Свой HTTP API (совместимый с synth-backend API v2) | Один API-ключ | Прямой доступ к локальной ФС |
| **Managed** | `synth serve --backend ...` | Тот же HTTP API | Токен раннера | Workspace от раннера |

---

## Технологический стек

| Компонент | Выбор |
|-----------|-------|
| Язык | TypeScript (strict mode) |
| Рантайм | Node.js 22+ |
| Фреймворк | Hono (для HTTP API) |
| CLI | commander или yargs |
| Валидация | Zod |
| Тестирование | Vitest |
| Пакетный менеджер | pnpm |
| Типы | @synth/shared |

---

## Режимы работы

### Standalone

Движок запущен локально пользователем. Полная автономность.

```
synth chat "напиши тест"          # одноразовый запрос
synth serve --api-key <key>       # HTTP API сервер + опционально UI через браузер
```

- Сессии: FileStore (JSON в локальной директории)
- Очередь: InMemoryQueue
- LLM: прямые вызовы к провайдерам (API-ключи из локального конфига)
- Файлы: прямой доступ к локальной ФС
- Auth: один API-ключ → роль USER

### Managed

Движок запущен раннером, подключен к центральному бэкенду.

```
synth serve --backend http://synth-backend:5000 --token <runner-token>
```

- Сессии: RemoteStore (через backend API)
- Очередь: RemoteQueue (через backend API)
- LLM: через LLM Proxy на бэкенде (аудит)
- Файлы: workspace предоставляется раннером
- Auth: токен раннера

---

## Структура проекта

```
packages/core/
├── package.json
├── tsconfig.json
├── bin/
│   └── cli.ts                # Точка входа CLI
├── src/
│   ├── main.ts               # Инициализация приложения
│   ├── config.ts             # Загрузка конфига
│   ├── cli/
│   │   ├── index.ts          # Регистрация команд
│   │   ├── chat.ts           # synth chat
│   │   └── serve.ts          # synth serve
│   ├── server/
│   │   ├── app.ts            # Hono app (standalone HTTP API)
│   │   └── routes/
│   │       ├── index.ts
│   │       ├── health.ts
│   │       ├── sessions.ts
│   │       ├── messages.ts
│   │       ├── projects.ts
│   │       ├── providers.ts
│   │       ├── agents.ts
│   │       ├── queue.ts
│   │       ├── fs.ts
│   │       ├── i18n.ts
│   │       ├── context.ts
│   │       └── profile.ts
│   ├── auth/
│   │   └── local.ts          # Упрощённая auth (API-ключ)
│   ├── engine/
│   │   ├── orchestrator.ts   # ChatOrchestrator
│   │   ├── tsm.ts            # Task State Machine
│   │   ├── context/
│   │   │   ├── builder.ts    # ContextBuilder
│   │   │   └── optimizer.ts  # ContextOptimizer
│   │   ├── mcp/
│   │   │   ├── index.ts      # MCP-подсистема (реэкспорт)
│   │   │   ├── client.ts     # McpClient (подключение к MCP-серверам)
│   │   │   └── manager.ts    # McpManager (жизненный цикл, Circuit Breaker)
│   │   └── tools/
│   │       ├── index.ts      # Реестр инструментов
│   │       ├── fs.ts         # Файловые операции
│   │       ├── shell.ts      # Shell-команды
│   │       └── git.ts        # Git-операции
│   ├── providers/
│   │   ├── base.ts           # BaseProvider (интерфейс)
│   │   ├── factory.ts        # ProviderFactory
│   │   ├── openai.ts         # OpenAI + Generic
│   │   ├── anthropic.ts      # Anthropic
│   │   └── ollama.ts         # Ollama
│   ├── storage/
│   │   ├── file-store.ts     # FileStore (standalone)
│   │   └── remote-store.ts   # RemoteStore (managed)
│   ├── queue/
│   │   ├── memory-queue.ts   # InMemoryQueue (standalone)
│   │   └── remote-queue.ts   # RemoteQueue (managed)
│   ├── events/
│   │   └── bus.ts            # Локальный EventBus
│   ├── agents/
│   │   └── registry.ts       # AgentRegistry
│   └── debug.ts              # DebugCollector
└── data/                     # runtime (standalone)
    ├── sessions/
    ├── projects/
    └── config.yaml
```

---

## Standalone API (совместимость с synth-backend API v2)

Движок в standalone-режиме реализует **подмножество** API v2 synth-backend.
Те же модели ответов из `@synth/shared`, те же пути, те же форматы ошибок.

### Поддерживаемые эндпоинты

| Группа | Эндпоинты | Примечание |
|--------|-----------|------------|
| health | `GET /api/v2/health` | Без auth |
| sessions | `GET/POST /api/v2/sessions`, `GET/PATCH/DELETE /api/v2/sessions/:id` | FileStore |
| prompt | `POST /api/v2/sessions/:id/prompt` | SSE-стрим, напрямую к LLM |
| abort | `POST /api/v2/sessions/:id/abort` | — |
| summarize | `POST /api/v2/sessions/:id/summarize` | — |
| events | `GET /api/v2/sessions/:id/events` | Локальный EventBus |
| status | `GET /api/v2/sessions/:id/status` | — |
| messages | `GET /api/v2/sessions/:id/messages`, `PATCH/DELETE /api/v2/messages/:sessionId/:index` | — |
| projects | `GET/POST /api/v2/projects`, `GET/PUT/DELETE /api/v2/projects/:id` | FileStore |
| queue | `POST /api/v2/queue/:sessionId/clear\|return\|resume` | InMemoryQueue |
| providers | `GET /api/v2/providers`, `GET /api/v2/models` | — |
| agents | `GET /api/v2/agents` | — |
| fs | `GET /api/v2/fs?path=`, `GET /api/v2/fs/read?path=` | Прямой доступ к ФС |
| i18n | `GET /api/v2/i18n/*` | — |
| profile | `GET /api/v2/profile` | Локальный профиль |

### Не поддерживаются в standalone

| Эндпоинт | Причина |
|----------|---------|
| `/auth/*` (OIDC) | Нет Keycloak |
| `/admin/*` | Нет админки |
| `/users/*` | Нет управления пользователями |
| `/context/*` | Контекст настраивается через конфиг |
| `/runner/*` | Нет раннера |
| `WS /ws/chat` | В standalone — SSE через /events (можно добавить) |
| `WS /ws/runner` | Нет раннера |

---

## Аутентификация (standalone)

Один API-ключ, роль USER.

```bash
# Из CLI
synth serve --api-key "my-local-key"

# Из переменной окружения
export LOCAL_API_KEY="my-local-key"
synth serve

# Из config.yaml
# data/config.yaml:
#   auth:
#     api_key: "my-local-key"
synth serve
```

Middleware:

```typescript
// src/auth/local.ts
export function localAuth(apiKey: string) {
  return createMiddleware(async (c, next) => {
    if (c.req.path === '/api/v2/health') {
      return await next();
    }
    const provided = extractBearerToken(c) ?? c.req.query('api_key');
    if (provided !== apiKey) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    c.set('user', {
      id: 'local',
      username: 'local',
      roles: ['USER'],
      isLocal: true,
    });
    await next();
  });
}
```

---

## CLI

### Команды

```bash
# Одноразовый чат (без сервера)
synth chat "напиши тест для функции sum"
synth chat --model gpt-4o --agent developer "рефакторинг кода"

# HTTP API сервер
synth serve                      # порт 4300 по умолчанию
synth serve --port 4300 --api-key "key"

# Подключение к центральному бэкенду
synth serve --backend http://synth-backend:5000 --token "runner-token"

# Информация
synth --version
synth --help
```

### Аргументы

| Флаг | Назначение | По умолчанию |
|------|------------|--------------|
| `--port` | Порт HTTP API | 4300 |
| `--api-key` | Ключ для standalone auth | из env `LOCAL_API_KEY` |
| `--backend` | URL бэкенда (managed mode) | — |
| `--token` | Токен раннера (managed mode) | — |
| `--model` | Модель по умолчанию | из конфига |
| `--provider` | Провайдер по умолчанию | из конфига |
| `--agent` | Агент по умолчанию | "developer" |
| `--config` | Путь к config.yaml | `./data/config.yaml` |

---

## Конфигурация (standalone)

```yaml
# data/config.yaml
server:
  port: 4300

auth:
  api_key: "my-local-key"

llm:
  default_provider: "openai"
  default_model: "gpt-4o"
  temperature: 0.7
  max_tokens: 4096

providers:
  openai:
    api_key: "${OPENAI_API_KEY}"
    base_url: "https://api.openai.com/v1"
  anthropic:
    api_key: "${ANTHROPIC_API_KEY}"

workspace:
  root: "."                    # корень рабочей директории

tsm:
  mode: "simple"               # simple | orchestrator

agents:
  default_agent: "developer"
```

---

## Ядро движка

### ChatOrchestrator

Портируется из synth-legacy `core/chat/orchestrator.py`, упрощается (без pending_messages — очередь отдельно).

```typescript
// src/engine/orchestrator.ts
class ChatOrchestrator {
  constructor(
    provider: BaseProvider,
    contextBuilder: ContextBuilder,
    tsm: TSM,
    tools: ToolRegistry
  );

  async processSync(session: Session, message: Message): Promise<LLMResponse>;
  async *processStream(session: Session, message: Message, cancelToken: CancelToken): AsyncGenerator<LLMChunk>;
}
```

### TSM (Task State Machine)

Состояния: `PLANNING → EXECUTION → VALIDATION → DONE`

```typescript
// src/engine/tsm.ts
enum TsmState { PLANNING, EXECUTION, VALIDATION, DONE }

class TSM {
  transition(current: TsmState, next: TsmState): TsmState;
  getSystemPrompt(state: TsmState, context: TsmContext): string;
}
```

### Инструменты

Встроенные (доступны всегда):
- `read_file` — чтение файла
- `write_file` — запись файла
- `list_directory` — список файлов
- `execute_shell` — shell-команда
- `search_code` — поиск по коду (ripgrep)
- `git_diff` / `git_status` / `git_commit` — Git-операции

MCP-интеграция (подключаемые):
- **McpClient** (`src/engine/mcp/client.ts`) — обёртка вокруг `@modelcontextprotocol/sdk`
  - Поддержка stdio (`StdioClientTransport`) и Streamable HTTP (`StreamableHTTPClientTransport`)
  - Таймауты: подключение (60с), вызов инструмента (120с), усечение результата до 30k символов
- **McpManager** (`src/engine/mcp/manager.ts`) — управление жизненным циклом серверов
  - `connectServer()` / `disconnectServer()` / `disconnectAll()`
  - `probeServer()` — проверка подключения без регистрации инструментов
  - `registerTools()` / `deregisterTools()` / `ensureToolsLoaded()`
  - **Circuit Breaker** — 5 ошибок → блокировка на 60 сек
  - Инструменты регистрируются с префиксом `{serverName}_{toolName}` и capability `ToolCapability.MCP`
  - `callTool()` — вызов инструмента по полному имени (разбирает префикс)

```typescript
// src/engine/tools/index.ts
interface Tool {
  name: string;
  description: string;
  parameters: ZodSchema;
  execute(params: unknown, context: ToolContext): Promise<ToolResult>;
}

class ToolRegistry {
  register(tool: Tool): void;
  getTools(): Tool[];
  getOpenAITools(): OpenAITool[];
}
```

---

## Хранилище (standalone)

### FileStore

Реализует интерфейсы из `@synth/shared`:

```typescript
// @synth/shared/src/interfaces/storage.ts
interface SessionStore {
  get(id: string): Promise<Session>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<Session[]>;
  exists(id: string): Promise<boolean>;
}

interface ProjectStore {
  get(id: string): Promise<Project>;
  save(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: ProjectFilter): Promise<Project[]>;
}
```

Реализация FileStore — JSON-файлы в `data/sessions/` и `data/projects/`.
Атомарная запись: временный файл + `rename()`.

### InMemoryQueue

```typescript
interface MessageQueue {
  enqueue(sessionId: string, message: UserMessage): Promise<boolean>;
  dequeue(sessionId: string): Promise<UserMessage | null>;
  peek(sessionId: string): Promise<UserMessage | null>;
  clear(sessionId: string): Promise<number>;
  size(sessionId: string): Promise<number>;
}
```

---

## Запуск (dev)

```bash
cd synth/packages/core
pnpm install
pnpm run build

# Одноразовый чат
node dist/cli.js chat "привет"

# Сервер standalone
node dist/cli.js serve --api-key "dev-key"

# Сервер в браузере
# Открыть http://localhost:4300 (если подключен synth-ui)
```
