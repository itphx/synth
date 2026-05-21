# Synth

Мультипользовательская AI-агентская платформа для командной работы.

## Компоненты

| Компонент | Назначение | Стек |
|-----------|------------|------|
| **@synth/shared** | Общие типы, интерфейсы, Zod-схемы, протоколы | TypeScript |
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

## Запуск (dev)

```bash
# Установка зависимостей
pnpm install

# synth-backend (API)
pnpm --filter @synth/backend dev

# synth-ui (React SPA)
pnpm --filter @synth/ui dev

# synth-core (standalone)
pnpm --filter @synth/core build
node packages/core/dist/cli.js serve --api-key "dev-key"

# synth-core (CLI)
node packages/core/dist/cli.js chat "привет"

# synth-runner
pnpm --filter @synth/runner dev -- --backend http://localhost:5000
```

## Архитектура

Подробная документация:
- `AGENTS.md` — архитектурные решения, соглашения
- `rbac-design.md` — аутентификация, роли, разрешения
- `SPEC.md` — спецификация функциональности
- `packages/backend/AGENTS.md` — API v2 спецификация
- `packages/core/AGENTS.md` — ядро, CLI, standalone API

## Лицензия

MIT
