# Synth

Мультипользовательская AI-агентская платформа для командной работы.

## Компоненты

| Компонент | Назначение | Стек |
|-----------|------------|------|
| **@synth/shared** | Типы, интерфейсы, схемы, протоколы, конфигурация | TypeScript |
| **@synth/core** | Общая реализация: сессии, очередь, LLM, TSM, HTTP API v2, CLI | TypeScript, Hono |
| **@synth/backend** | API Hub: OIDC, Runner Registry, LLM Proxy, RBAC | TypeScript, Hono |
| **@synth/ui** | Пользовательский интерфейс + админка | TypeScript, React 19 |
| **@synth/runner** | Адаптеры для движков (opencode, cline), Engine Manager | TypeScript, Node.js |

## Варианты использования

### Облачный (командная работа через браузер)

```
synth-backend (сервер) ←→ synth-ui (браузеры пользователей)
     ↕
synth-runner (K8s поды) ←→ открытые движки (opencode / cline)
```

- Единый источник правды для сессий и истории
- Коллаборация: несколько пользователей в одной сессии
- Централизованный аудит всех LLM-запросов
- RBAC: роли ADMIN, USER, LEAD, AUDITOR

### Локальный (один разработчик)

```
synth-core (localhost) ←→ synth-ui (браузер)
```

- Одна команда: `synth serve --api-key <key>`
- Прямой доступ к файловой системе
- Не требует бэкенда, Keycloak, Kubernetes

### Локальный + внешние движки

```
synth-core + synth-runner (in-process) ←→ opencode / cline
```

- `synth serve --api-key <key> --runner`
- In-process импорт @synth/runner
- LLM-запросы opencode/cline проксируются через core

### Корпоративный (локальный core + центральный хаб)

```
synth-backend (корпоративный сервер) ←→ synth-ui (браузер)
     ↕
synth-core (ПК сотрудника, как раннер + клиент)
```

- Core на машине сотрудника — доступ к внутренним сервисам, VPN, файлам
- Сессии и аудит — централизованы на корпоративном бэкенде
- API-ключи провайдеров хранятся только на сервере

## Конфигурация

Единый конфигурационный слой `@synth/shared/config` (AD-023).

### Приоритет

```
CLI-флаги > env vars (SYNTH_*) > config.yaml > defaults
```

### config.yaml

Каскадный поиск: `--config` / `SYNTH_CONFIG` → `./synth.config.yaml` → `./config.yaml` → `~/.config/synth/config.yaml` → `/etc/synth/config.yaml`

```yaml
server:
  port: 5000
storage:
  dataDir: "/var/synth/data"     # каталог данных вне репозитория
llm:
  defaultProvider: ""             # пусто — админ настраивает сам
  defaultModel: ""
core:
  port: 4300
  apiKey: ""
runner:
  port: 5200
  backendUrl: "http://localhost:5000"
ui:
  port: 5002
  backendUrl: "http://localhost:5000"
```

### Переменные окружения

| Переменная | Назначение | По умолчанию |
|-----------|------------|--------------|
| `SYNTH_DATA_DIR` | Каталог данных | `/var/synth/data` |
| `SYNTH_CONFIG` | Путь к `config.yaml` | каскадный поиск |
| `SYNTH_PORT` | Порт бэкенда | `5000` |
| `SYNTH_CORE_PORT` | Порт core | `4300` |
| `SYNTH_RUNNER_PORT` | Порт раннера | `5200` |
| `SYNTH_AUTH_DEBUG` | Режим отладки auth | `false` |
| `SYNTH_API_KEY` | API-ключ | — |
| `SYNTH_BACKEND_URL` | URL бэкенда | `http://localhost:5000` |
| `VITE_BACKEND_URL` | URL бэкенда (UI proxy) | `http://localhost:5000` |
| `VITE_PORT` | Порт UI dev-сервера | `5002` |
| `VITE_ALLOWED_HOSTS` | Разрешённые хосты для Vite (`true` — все, `"host1,host2"` — список) | `true` |
| `SYNTH_CORS_ORIGIN` | CORS origin бэкенда (приоритет выше `allowedOrigins` в конфиге) | — |

### Первый запуск

`ensureDataDir()` создаёт структуру подкаталогов в `dataDir`.
`createDefaultConfig()` опционально пишет `config.yaml` с дефолтами.

## Ключевые возможности

- **Оркестрация движков** — opencode, cline и собственный synth-core в одном интерфейсе
- **Очередь сообщений** — FIFO до 5 сообщений, возобновление при сбоях
- **SessionEventBus** — real-time события для всех участников (WebSocket + SSE)
- **TSM** — Task State Machine с состояниями Planning → Execution → Validation → Done
- **Проекты** — контейнеры для группировки сессий, файлов, инвариантов
- **MCP-интеграция** — подключаемые инструменты через Model Context Protocol
- **Контекст** — системные промпты, роли агентов, оптимизация (sliding window, summarization)
- **i18n** — русский и английский интерфейс
- **Темы** — 60+ цветовых схем (светлые и тёмные)

## Запуск

```bash
# Установка зависимостей
pnpm install

# synth-backend (API, :5000)
pnpm --filter @synth/backend dev

# synth-ui (React SPA, :5002)
pnpm --filter @synth/ui dev

# synth-core (standalone server)
pnpm --filter @synth/core build
node packages/core/dist/main.js serve --api-key "dev-key"

# synth-core (CLI команды)
node packages/core/dist/main.js chat "привет"
node packages/core/dist/main.js config

# synth-runner
pnpm --filter @synth/runner build
node packages/runner/dist/main.js --backend http://localhost:5000
```

## Документация

- `AGENTS.md` — архитектурные решения, соглашения
- `rbac-design.md` — аутентификация, роли, разрешения
- `SPEC.md` — спецификация функциональности
- `packages/backend/AGENTS.md` — API v2 спецификация
- `packages/core/AGENTS.md` — ядро, CLI, standalone API

## Лицензия

MIT
