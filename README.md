# Synth

Мультипользовательская AI-агентская платформа для командной работы.

## Компоненты

| Компонент | Назначение | Стек |
|-----------|------------|------|
| **synth-backend** | API Hub: аутентификация, сессии, проекты, LLM Proxy, EventBus | TypeScript, Hono |
| **synth-ui** | Пользовательский интерфейс + админка | TypeScript, React 19 |
| **synth-runner** | Gateway для запуска движков (opencode, cline, synth-engine) | TypeScript, Node.js |
| **synth-engine** | Автономный AI-движок: TSM, MCP, инструменты, CLI | TypeScript, Node.js |
| **@synth/shared** | Общие типы, интерфейсы, Zod-схемы, протоколы | TypeScript |

## Варианты использования

### Облачный (командная работа через браузер)

```
synth-backend (сервер) ←→ synth-ui (браузеры пользователей)
     ↕
synth-runner (K8s поды) ←→ synth-engine / opencode / cline
```

- Единый источник правды для сессий и истории
- Коллаборация: несколько пользователей в одной сессии
- Централизованный аудит всех LLM-запросов
- RBAC: роли ADMIN, USER, LEAD, AUDITOR

### Локальный (один разработчик)

```
synth-engine (localhost) ←→ synth-ui (браузер)
```

- Одна команда: `synth serve --api-key <key>`
- Прямой доступ к файловой системе
- Не требует бэкенда, Keycloak, Kubernetes

### Корпоративный (локальный раннер + центральный хаб)

```
synth-backend (корпоративный сервер) ←→ synth-ui (браузер)
     ↕
synth-runner (ПК сотрудника) ←→ synth-engine / opencode / cline
```

- Движок работает на машине сотрудника — доступ к внутренним сервисам, VPN, файлам
- Сессии и аудит — централизованы на корпоративном бэкенде
- API-ключи провайдеров хранятся только на сервере

## Ключевые возможности

- **Оркестрация движков** — opencode, cline и собственный synth-engine в одном интерфейсе
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

# synth-engine (standalone)
pnpm --filter @synth/engine build
node packages/engine/dist/cli.js serve --api-key "dev-key"

# synth-engine (CLI)
node packages/engine/dist/cli.js chat "привет"

# synth-runner
pnpm --filter @synth/runner dev -- --backend http://localhost:5000
```

## Архитектура

Подробная документация:
- `AGENTS.md` — архитектурные решения, соглашения
- `rbac-design.md` — аутентификация, роли, разрешения
- `SPEC.md` — спецификация функциональности
- `packages/backend/AGENTS.md` — API v2 спецификация
- `packages/engine/AGENTS.md` — движок, CLI, standalone API

## Лицензия

MIT
