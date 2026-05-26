# Архитектурные решения Synth

## Язык общения и документации

**ВАЖНО:** Все сообщения, коммиты и документация ведутся на **русском языке**.

### Формат коммитов (на русском):

```bash
git commit -m "исправление: исправлена обработка пустых сессий"
git commit -m "новая функция: добавлен эндпоинт для списка провайдеров"
git commit -m "документация: обновлён AGENTS.md"
```

### Правило коммитов

**ВАЖНО:** Не коммитить изменения пока пользователь явно не попросит об этом!

---

## Прототип

**ВАЖНО:** Под прототипом в данном проекте подразумевается иной проект, исходники которого находятся здесь: *~/dev/aic/t11*.

В прототипе были отработаны ключевые технологии, которые планируется постепенно перенести в текущий проект. Если пользователь просит реализовать ту или иную функциональность в первую очередь необходимо исследовать как аналогичная функция была реализована в прототипе. Однако это не означает, что нужно реализовывать точь в точь. В данном проекте разрабатывается конечный продукт с более широким функционалом и возможностями.

В прототипе как и в данном проекте есть бэкенд и UI. Они доступны локально: http://localhost:5100 - бэкенд прототипа; http://localhost:5101 - UI прототипа.
Для аутентификации в прототипе используется ключ: 'your-secret-api-key'.

**ВАЖНО:** Запуском прототипа управляет пользователь.
**ВАЖНО:** **Текущий проект != прототип**. Ни в коем случае нельзя менять код прототипа.

---

## Компоненты системы

### Новая архитектура (AD-022)

С 2026-05-20 система переводится на единый стек **TypeScript**.
Все компоненты собраны в **монорепозиторий** `synth/` (pnpm workspaces):

```
synth/                            # монорепо (TypeScript, pnpm workspaces)
├── packages/
│   ├── shared/    @synth/shared  # Типы, интерфейсы, Zod-схемы, протоколы
│   ├── core/      @synth/core    # Общая реализация: сессии, очередь, LLM, TSM, хранилище
│   │                             #   HTTP API v2, CLI, локальная auth
│   ├── backend/   @synth/backend # Hono API Hub: OIDC, Runner Registry, LLM Proxy, RBAC
│   │                             #   Импортирует @synth/core, дополняет облачными функциями
│   ├── ui/        @synth/ui      # React 19 SPA + админка (рендеринг по ролям)
│   └── runner/    @synth/runner  # Адаптеры opencode/cline, Engine Manager, LLM Proxy
│                                 #   Импортируется in-process из @synth/core
synth-legacy/                 # Python/FastAPI бэкенд (заморожен, справочный)
```

### Границы компонентов

```
┌──────────────────┐
│  @synth/shared   │  ТОЛЬКО контракты: типы, интерфейсы, Zod-схемы, протоколы
└────────┬─────────┘
         │
    ┌────┴──────────────────────────────┐
    │  @synth/core                      │
    │  • SessionManager, QueueProcessor  │
    │  • ProjectManager, EventBus       │
    │  • LLM-провайдеры (OpenAI/Anthr/…)│
    │  • ContextBuilder, TSM, AgentReg  │
    │  • FileStore, инструменты, MCP    │
    │  • HTTP API v2 (Hono)             │
    │  • CLI (synth chat, synth serve)  │
    │  • локальная auth (один ключ)     │
    └────────┬──────────────────────────┘
             │
    ┌────────┴───────────┐
    │                    │
    ▼                    ▼
┌──────────────┐  ┌──────────────┐
│@synth/backend│  │ @synth/ui    │
│• OIDC/RBAC   │  │ React SPA    │
│• Runner Reg  │  │ + админка    │
│• LLM Proxy   │  └──────────────┘
│• admin routes│
└──────────────┘

@synth/runner — импортируется in-process из @synth/core
(Engine Manager, адаптеры opencode/cline, локальный LLM-прокси)
```
synth/                            # монорепо (TypeScript, pnpm workspaces)
├── packages/
│   ├── shared/    @synth/shared  # Типы, интерфейсы, Zod-схемы, протоколы
│   ├── backend/   @synth/backend # Hono API Hub: auth, сессии, проекты, runner registry,
│   │                             #   LLM Proxy (аудит), SessionEventBus, очередь
│   │                             #   БЕЗ встроенного LLM-движка, БЕЗ HTML-шаблонов
│   ├── ui/        @synth/ui      # React 19 SPA + админка (рендеринг по ролям)
│   ├── runner/    @synth/runner  # Gateway: оркестратор движков, LLM Proxy, фаловый API
│   └── engine/    @synth/engine  # Автономный движок: TSM, MCP, CLI.
│                                 #   Два режима: standalone + managed
synth-legacy/                 # Python/FastAPI бэкенд (заморожен, справочный)
```

### Монорепозиторий

Все TypeScript-компоненты находятся в репозитории `synth/` с единым инструментарием:

```bash
synth/
├── pnpm-workspace.yaml     # pnpm workspaces: packages/*
├── tsconfig.base.json      # общий TypeScript-конфиг
├── eslint.config.js        # единый линтер
├── .prettierrc             # форматтер
├── package.json            # корневые скрипты
└── packages/
    ├── shared/   → @synth/shared   # Типы, Zod-схемы, протоколы
    ├── backend/  → @synth/backend  # Hono API Hub
    ├── ui/       → @synth/ui       # React SPA + админка
    ├── runner/   → @synth/runner   # Gateway, оркестратор движков
    └── engine/   → @synth/engine   # Автономный движок + CLI
```

### Соответствие старого → нового

| Старый компонент | Статус | Новый компонент |
|------------------|--------|-----------------|
| `synth/` (Python бэкенд) | → `synth-legacy/` (заморожен, справочный) | `packages/backend/` + `packages/core/` |
| `synth-ui/` | Активен | `packages/ui/` (адаптируется под новый бэкенд) |
| `synth-legacy-ui/` | Заморожен | — |
| `synth-frontend/` | Заморожен (AD-016) | — |
| — | Новый | `packages/runner/` |
| — | Новый | `packages/core/` |
| — | Новый | `packages/shared/` |

### Модель «Runner»

Раннер — мост между бэкендом и движками:

```
synth-backend ◄── WebSocket (control) ──► synth-runner ◄── HTTP API ──► движок
                                           │
                                           ├── opencode (serve, :4100)
                                           ├── cline (headless, :4200)
                                           └── synth-core (serve, :4300)
```

**Два режима раннера:**
- **Локальный:** пользователь запускает на своей машине. Прямой доступ к ФС.
- **Облачный:** K8s под, создаётся бэкендом при необходимости. Per-user модель (не общий пул).

**LLM Proxy:** раннер поднимает локальный OpenAI-совместимый эндпоинт (`localhost:9090/v1`).
Движки думают что общаются с OpenAI. Раннер пробрасывает запросы на бэкенд.
Бэкенд аудирует и маршрутизирует на реального провайдера.
API-ключи провайдеров хранятся только на бэке.

### Статус движков

| Движок | Статус | Примечание |
|--------|--------|------------|
| opencode | Интеграция через раннер | `opencode serve`, свой HTTP API |
| cline | Интеграция через раннер | `cline --auto --json`, stdin/stdout |
| synth-core | В разработке | Dual-mode: standalone CLI + managed через раннер |

### Stateless модель движка

История сообщений — на бэкенде. Движок получает на вход:
- Историю сообщений
- Новое сообщение от пользователя
- Контекст (system prompt, проект, статус)
- На выход отдаёт ответ

Это обеспечивает:
- Коллаборацию (несколько пользователей в одной сессии)
- Переключение движка без потери контекста
- Перезапуск движка без потери истории

Очередь сообщений — на бэкенде. Раннер доставляет задачи движку по одной.

### Сценарии использования

#### Сценарий 1 — Облачный (командная работа)

```
synth-ui (браузеры сотрудников) ◄── HTTP + WebSocket ──► synth-backend (:5000)
                                                               │
  ┌─ K8s Pod (per-user) ─────────────────────────────┐        │
  │  synth-runner ◄── HTTP (LLM Proxy) ──────────────┘        │
  │  ├─ opencode :4100 (LLM → :9090 → backend → OpenAI)       │
  │  └─ cline    :4200 (LLM → :9090 → backend → Anthropic)    │
  └──────────────────────────────────────────────────────────┘
```
- Бэкенд: OIDC, сессии, EventBus, Runner Registry, LLM Proxy
- Раннеры: K8s поды, динамический запуск
- LLM: API-ключи только на бэке, аудит всех запросов
- Коллаборация: несколько пользователей в одной сессии через EventBus

#### Сценарий 2 — Локальный (один разработчик)

```
synth-ui (браузер, localhost:5002) ◄── HTTP API v2 ──► @synth/core (:4300)
                                                            │
                                                    synth serve --api-key <key>
                                                            │
                                                    Прямой доступ к ФС
                                                    Прямые LLM-вызовы (локальные ключи)
```
- Core содержит всё: сессии, очередь, провайдеры, TSM, HTTP API v2
- Один API-ключ → роль USER
- Файлы на локальной ФС без прокси
- Не требует бэкенда, Keycloak, K8s

#### Сценарий 3 — Локальный + внешние движки

```
synth-ui (браузер, localhost:5002) ◄── HTTP API v2 ──► @synth/core (:4300)
                                                            │
                                                    synth serve --api-key <key> --runner
                                                            │
                                              ┌─ @synth/runner (in-process) ─┐
                                              │  opencode :4100              │
                                              │  cline    :4200              │
                                              │  LLM Proxy :9090 → core      │
                                              └──────────────────────────────┘
```
- `--runner` активирует in-process импорт @synth/runner
- Внешние движки запускаются как подпроцессы
- Их LLM-запросы проксируются через core (не HTTP, прямой вызов провайдеров)

#### Сценарий 4 — Гибридный (корпоративный)

```
ПК сотрудника:
  synth-ui ◄── HTTP API v2 ──► @synth/core (:4300)
                                    │
                       synth serve --api-key <key> --backend https://synth.corp.com
                                    │
                    ┌── WebSocket ──┴── HTTP (LLM Proxy) ──┐
                    ▼                                       ▼
            synth-backend (:5000, корпоративный сервер)
            OIDC, RBAC, сессии, аудит, Runner Registry
```
- Core на машине сотрудника = раннер + клиент одновременно
- Файлы локально (прямой доступ), сессии и история на бэке
- LLM-запросы через бэк для аудита
- Единый API v2 для UI во всех сценариях

---

## Архитектурные решения (AD)

### Статус AD

| AD | Название | Статус |
|----|----------|--------|
| AD-001 | FastAPI вместо Flask | ⛔ Deprecated (AD-022) |
| AD-002 | Собственная TSM | Активно, переносится в synth-core |
| AD-003 | Admin UI как HTML | ⛔ Deprecated (AD-022) |
| AD-004 | Два сервиса | Активно (расширено до 4 в AD-022) |
| AD-005 | JSON file storage | Активно, переносится в synth-backend |
| AD-006 | htmx для UI | ⛔ Deprecated (AD-019) |
| AD-007 | Раздельные git-репозитории | ⛔ Заменено монорепозиторием (ниже) |
| AD-008 | WebSocket для real-time | Активно, переносится |
| AD-009 | SessionEventBus | Активно, переносится |
| AD-010 | ChatOrchestrator | Упрощается в synth-backend |
| AD-011 | enqueue_user_message | Активно, переносится |
| AD-012 | processor_running runtime | Активно, переносится |
| AD-013 | Атомарный read-modify-write | Активно, переносится |
| AD-014 | Проект как контейнер | Активно, переносится |
| AD-015 | Многофункциональные панели UI | Активно |
| AD-016 | Форк OpenChamber | ⛔ Deprecated (AD-019) |
| AD-017 | Собственный API-контракт | Активно |
| AD-018 | Выбор AI-движка на уровне сессии | Активно |
| AD-019 | React SPA с нуля | Активно |
| AD-020 | Python для бэкенда | ⛔ Deprecated (AD-022) |
| AD-021 | OpenAPI-генерируемые типы | Активно (для synth-backend) |
| AD-022 | TypeScript стек + Runner архитектура | Новый (2026-05-20) |
| AD-023 | Единая система конфигурации | Новый (2026-05-22) |
| AD-024 | Единая архитектура транспорта (EventHub) | Новый (2026-05-26) |

---

### AD-022: Единый TypeScript стек + Runner архитектура

**Решение:** Все компоненты системы (backend, UI, runner, engine) переводятся на TypeScript.
Бэкенд разделяется на synth-backend (API hub) и synth-core (автономное ядро).
Вводится synth-runner как мост между бэкендом и движками.
Все TypeScript-компоненты собраны в **монорепозиторий** `synth/` с pnpm workspaces.

**Обоснование:**
1. Бэкенд больше не делает AI-работу (движок выделен отдельно). Роль бэкенда — веб-сервис: CRUD, WebSocket hub, LLM Proxy, аутентификация.
2. Единый язык на всех компонентах: общие типы через @synth/shared, единый инструментарий (ESLint, Prettier, Vitest).
3. Node.js — нативные async I/O, идеально для WebSocket и прокси.
4. AI-движок остаётся на TypeScript: MCP SDK, OpenAI SDK, Anthropic SDK имеют первоклассную TS-поддержку.

**Компоненты:**

| Компонент | Язык | Фреймворк | Порт |
|-----------|------|-----------|------|
| synth-backend | TypeScript | Hono | 5000 |
| synth-ui | TypeScript | React 19 + Vite | 5002 |
| synth-runner | TypeScript | Node.js (чистый HTTP + WS) | динамический |
| synth-core | TypeScript | Node.js (Hono для HTTP API) | динамический |
| @synth/shared | TypeScript | — | — |

**Ключевые изменения:**
- Админка переносится из Jinja2-шаблонов в synth-ui (React, рендеринг по ролям)
- ChatOrchestrator упрощается до диспетчера: найти раннер → отправить задачу → ретранслировать события
- LLM-провайдеры живут в synth-backend (LLM Proxy для аудита) и synth-core (standalone режим)
- EngineManager (из synth-legacy) заменяется synth-runner'ом

**Архитектурная схема:**

```
synth-ui (React SPA + админка)
    │
    ├── localhost (подключен к раннеру)
    │   └── synth-runner (Gateway)
    │       ├── WS → synth-backend (сессии, события)
    │       ├── HTTP → synth-backend (LLM Proxy)
    │       └── HTTP ← synth-core / opencode / cline
    │
    └── удалённый (подключен к бэкенду)
        └── synth-backend (Hono API)
            ├── WS ↔ synth-runner (control)
            ├── HTTP ← synth-runner (LLM Proxy)
            └── SessionEventBus
```

**Дата:** 2026-05-20

---

### AD-023: Единая система конфигурации

**Решение:** Все компоненты используют единый конфигурационный слой `@synth/shared/config`:
- Единый тип `SynthConfig` с секциями для каждого компонента (`server`, `storage`, `auth`, `llm`, `core`, `runner`, `ui`, `i18n`, `logging`, `tsm`, `context`)
- Каскадный resolution: `CLI-флаги > env vars (SYNTH_*) > config.yaml > defaults`
- Каскадный поиск `config.yaml`: `SYNTH_CONFIG / --config → ./synth.config.yaml → ./config.yaml → ~/.config/synth/config.yaml → /etc/synth/config.yaml`
- Каталог данных (`dataDir`) — вне репозитория, задаётся через `SYNTH_DATA_DIR` env var или `storage.dataDir` в конфиге, дефолт `/var/synth/data`
- Первый запуск: `ensureDataDir()` создаёт структуру подкаталогов (`sessions/`, `projects/`, `providers/`, `models/`, `agents/`, `context/`, `auth/`), `createDefaultConfig()` опционально пишет конфиг с дефолтами
- Все провайдеры и модели в дефолтах — **пустые строки**, настройка LLM — зона ответственности администратора

**Обоснование:**
1. Все компоненты должны иметь согласованный способ получения конфигурации независимо от сценария развёртывания (K8s, локальный dev, standalone, гибрид)
2. Каталог данных не должен находиться внутри репозитория — риск случайного коммита runtime-данных
3. Приоритет env vars выше config.yaml позволяет K8s ConfigMap + Secrets переопределять файловый конфиг
4. Каскадный поиск конфига покрывает все сценарии: K8s (`/etc/synth/config.yaml`), dev-машина (`./config.yaml`), пользовательская установка (`~/.config/synth/config.yaml`)

**Единый тип конфигурации:**

```yaml
# config.yaml
server:
  host: "0.0.0.0"
  port: 5000

storage:
  dataDir: "/var/synth/data"

auth:
  debugMode: false
  sessionMaxAgeMinutes: 1440
  oidc:
    enabled: false
    issuer: ""
    clientId: ""
    clientSecret: ""
    redirectUri: "http://localhost:5002/auth/callback"

llm:
  defaultProvider: ""
  defaultModel: ""
  maxRetries: 3
  timeout: 60

core:
  port: 4300
  apiKey: ""

runner:
  port: 5200
  backendUrl: "http://localhost:5000"
  enginePorts:
    opencode: 4100
    cline: 4200
    synth: 4300
  proxyPort: 9090

ui:
  port: 5002
  backendUrl: "http://localhost:5000"
  theme: "flexoki"
  themeMode: "system"
  locale: "ru"

i18n:
  defaultLanguage: "ru"
  supportedLanguages: ["ru", "en"]

logging:
  groups:
    ORCHESTRATOR: "INFO"
    CHAT_STREAM: "WARNING"
    TSM: "INFO"

tsm:
  maxIterations: 50
  validationTimeout: 30
  mode: "simple"

context:
  enabledFiles: ["SOUL.md", "COMPANY.md", "ABOUT.md"]
```

**Реализация в коде:**

| Слой | Файл | Назначение |
|------|------|-----------|
| Типы + схема | `shared/src/config/types.ts` | `SynthConfig` + Zod-схемы |
| Дефолты | `shared/src/config/defaults.ts` | `defaultConfig` — все значения |
| Загрузчик | `shared/src/config/loader.ts` | `loadConfig()` — каскадный поиск + мерж |
| Резолверы | `shared/src/config/resolve.ts` | `resolveDataDir()`, `resolvePort()`, `ensureDataDir()`, `createDefaultConfig()` |
| Мерж | `shared/src/config/merge.ts` | `deepMerge()` — глубокий мерж объектов |
| Бэкенд-адаптер | `backend/src/lib/app-config.ts` | `loadBackendConfig()` — env var оверрайды для auth |
| CLI core | `core/src/main.ts` | команды `serve`, `chat`, `config` с `--config` флагом |
| CLI runner | `runner/src/main.ts` | `--port`, `--backend`, `--config` флаги |

**Переменные окружения (префикс `SYNTH_`):**

| Переменная | Компонент | Назначение |
|-----------|-----------|------------|
| `SYNTH_CONFIG` | все | Путь к `config.yaml` |
| `SYNTH_DATA_DIR` | все | Корневой каталог данных |
| `SYNTH_PORT` | backend | Порт сервера (было `PORT`) |
| `SYNTH_CORE_PORT` | core | Порт standalone API |
| `SYNTH_RUNNER_PORT` | runner | Порт раннера |
| `SYNTH_BACKEND_URL` | runner, ui | URL бэкенда |
| `SYNTH_API_KEY` | backend, core | API-ключ |
| `SYNTH_AUTH_DEBUG` | backend | Режим отладки auth |
| `SYNTH_OIDC_*` | backend | OIDC-параметры |
| `SYNTH_SESSION_MAX_AGE` | backend | Время жизни сессии |
| `SYNTH_TEST_*_KEY` | backend | Тестовые ключи (debug mode) |

**Переменные UI (префикс `VITE_`):**

| Переменная | Назначение |
|-----------|------------|
| `VITE_BACKEND_URL` | URL бэкенда для прокси |
| `VITE_PORT` | Порт dev-сервера Vite |

**Сценарии конфигурирования:**

| Сценарий | Источники |
|----------|-----------|
| **K8s** | ConfigMap → `/etc/synth/config.yaml`, Secrets → env vars |
| **dev.sh** | `SYNTH_DATA_DIR=/home/eof/dev/Synth/data`, `SYNTH_AUTH_DEBUG=true`, порты из defaults |
| **synth serve** | CLI-флаги (`--port`, `--api-key`), `~/.config/synth/config.yaml`, defaults |
| **Гибрид** | `--backend https://synth.corp.com`, локальный конфиг для dataDir |

**Дата:** 2026-05-22

---

### AD-024: Единая архитектура транспорта (EventHub + TransportClient)

**Решение:** Транспортный слой между UI и бэкендом унифицируется. Вводится единый хаб событий на бэкенде (`EventHub`) и единый клиент на UI (`TransportClient`), заменяющие разрозненные per-session и per-user соединения.

**Обоснование:**
1. Per-session WS-соединения создавали ложные SSE-фоллбеки при обрыве, порождая EventSource с no-op обработчиком событий — события терялись, стриминг ломался.
2. Механизм ручных `subscribe`/`unsubscribe` через WS-сообщения был хрупок: сообщение могло не дойти до бэкенда, подписка не создавалась, события терялись.
3. Разделение на `/ws/user` (приём событий) и `/ws/chat?events=false` (отправка) усложняло код и требовало двух WS-соединений.
4. Оркестрация подписок на стороне бэкенда (автоматическая подписка при создании сессии) устраняет гонки и гарантирует доставку событий.

#### Компоненты транспорта

| Компонент | Расположение | Назначение |
|-----------|-------------|------------|
| **EventHub** | `packages/backend/src/events/hub.ts` | Реестр активных WS/SSE клиентов. Автоматически подписывает клиентов на все сессии пользователя при connect и на новые сессии при их создании. |
| **TransportClient** | `packages/ui/src/lib/api/transport.ts` | Единый клиент для WS и SSE. В WS-режиме — двусторонний обмен через тот же сокет. В SSE-режиме — приём событий через EventSource, отправка через HTTP POST. |
| **transportStore** | `packages/ui/src/stores/transportStore.ts` | Zustand-менеджер. Диспетчер событий (маршрутизация в chatStore), управление режимами, `sendMessage`/`cancel` с авто-выбором протокола. |

#### API эндпоинты транспорта

| Эндпоинт | Протокол | Назначение |
|----------|----------|------------|
| `WS /ws/events` | WebSocket | Глобальный event-хаб. Клиент подключается, бэкенд через EventHub подписывает на все сессии пользователя. Принимает `send_message {session_id, ...}` и `cancel {session_id}`. |
| `GET /api/v2/events` | SSE | Глобальный SSE-хаб (зеркало `/ws/events`). Подписка на все сессии пользователя при connect. Отправка сообщений — через HTTP POST `/prompt`. |
| `POST /api/v2/sessions/:id/prompt` | HTTP → SSE | Отправка сообщения в очередь. Возвращает SSE-стрим событий этой сессии. |

#### Удалённые эндпоинты

| Эндпоинт | Причина удаления |
|----------|-----------------|
| `WS /ws/user` | Заменён на `/ws/events`. Подписки теперь управляются EventHub автоматически, без ручных `subscribe`/`unsubscribe`. |
| `WS /ws/chat` | Per-session WS более не нужен. Отправка через глобальный `/ws/events` (с `session_id`) или HTTP POST. |
| `GET /api/v2/sessions/:id/events` | Per-session SSE заменён глобальным `/api/v2/events`. События всех сессий приходят через один поток. |

#### Архитектурная схема

```
┌─────────────────────────────────────────────────────────────────┐
│                        EventHub (backend)                       │
│  activeClients: Map<userId, Client[]>                           │
│                                                                 │
│  registerClient(client) → подписка на все сессии пользователя    │
│  unregisterClient(client) → отписка от всех сессий              │
│  subscribeToSession(userId, sid) → авто-подписка при создании    │
│  unsubscribeFromSession(userId, sid) → отписка при удалении      │
└──────────────────────┬──────────────────────┬───────────────────┘
                       │                      │
          ┌────────────▼──────┐    ┌──────────▼──────────┐
          │  /ws/events (WS)  │    │ /api/v2/events (SSE)│
          │  двусторонний      │    │  односторонний       │
          └───────────────────┘    └─────────────────────┘
                       │                      │
          ┌────────────▼──────┐    ┌──────────▼──────────┐
          │ TransportClient   │    │ TransportClient     │
          │ mode: 'ws'        │    │ mode: 'sse'        │
          │                   │    │                     │
          │ sendMessage(sid)  │    │ sendMessage(sid)    │
          │  → WS.send        │    │  → HTTP POST/prompt │
          │ cancel(sid)       │    │ cancel(sid)         │
          │  → WS.send        │    │  → HTTP POST/abort  │
          └───────────────────┘    └─────────────────────┘
```

#### Жизненный цикл подписок

```
1. Клиент открывает WS /ws/events (или SSE /api/v2/events)
2. EventHub.registerClient → listSessions(userId) → подписка на каждую сессию
3. События всех сессий пользователя доставляются клиенту
4. Клиент создаёт сессию: POST /sessions
5. Бэкенд: createSession → eventHub.subscribeToSession(userId, sessionId)
   → все активные клиенты пользователя получают подписку на новую сессию
6. Клиент удаляет сессию: DELETE /sessions/:id
7. Бэкенд: eventHub.unsubscribeFromSession(userId, sessionId)
   → подписка удаляется у всех клиентов пользователя
8. Клиент закрывает транспорт → EventHub.unregisterClient → отписка от всех сессий
```

#### Режимы транспорта на клиенте

| Режим | Приём событий | Отправка сообщений | Отмена |
|-------|--------------|-------------------|--------|
| **auto** | WS `/ws/events` (первично) | WS send_message | WS cancel |
|  | → SSE `/api/v2/events` (фоллбек при обрыве WS) | HTTP POST `/prompt` | HTTP POST `/abort` |
| **ws** | WS `/ws/events` | WS send_message | WS cancel |
| **sse** | SSE `/api/v2/events` | HTTP POST `/prompt` | HTTP POST `/abort` |

Фоллбек auto→SSE срабатывает только при реальном обрыве WS (`reason !== 'manual'`), не при намеренном `disconnect()`.

#### Гарантия готовности транспорта (transportReady)

Для предотвращения отправки через WS до завершения регистрации в EventHub введён флаг `transportReady`:

```typescript
// transportStore.ts
let transportReady = false

onConnect: () => {
  transportReady = true   // ← EventHub.registerClient завершён, подписки активны
}

sendMessage: (...) => {
  if (transport && transportReady && transport.getTransport() === 'ws') {
    await transport.sendMessage(...)     // WS готов
  } else {
    await synthApi.enqueueMessage(...)   // WS не готов или SSE-режим → HTTP POST
  }
}
```

Это гарантирует, что первое сообщение (и все последующие до `onConnect`) идут через HTTP POST — подписка EventHub успевает создаться до публикации событий.

#### Удалённый код

| Файл | Причина |
|------|---------|
| `ui/src/lib/api/ws.ts` | Заменён на `transport.ts` (TransportClient) |
| `ui/src/stores/connectionStore.ts` | Заменён на `transportStore.ts` |
| `ui/src/components/layout/ConnectionIndicator.tsx` | Заменён на `GlobalTransportIndicator.tsx` |
| `ui/src/components/layout/GlobalEventProcessor.tsx` | Заменён на `BackendConnection.tsx` |
| Методы `subscribe`/`unsubscribe` в handler'е `/ws/user` | Заменены EventHub |
| `sendSubscribe`/`sendUnsubscribe` в ChatConnection | Не нужны (EventHub управляет подписками) |

**Дата:** 2026-05-26

---

### Отказ от механизма «JSON-блок / статусный блок»

**Решение:** Механизм JSON-блока (модель возвращает в конце ответа JSON со статусом задачи) **не переносится** из прототипа (`~/dev/aic/t11`) и legacy (`synth-legacy`) в новые компоненты TypeScript.

**Суть фичи в прототипе:**
- Модель получает в system prompt инструкцию вернуть `{"status": {"task_name": "...", "state": "...", "progress": "...", ...}}` в конце каждого ответа
- Бэкенд парсит JSON из текста ответа (стратегии: fenced code block, поиск по ключам-индикаторам), очищает ответ модели от JSON, извлекает поля, применяет их к `session.status`
- Результат: TSM state, project, task_name, progress, approved_plan, already_done, currently_doing, invariants, subtasks, schedule

**Причины отказа:**
1. **Хрупкий парсинг** — regex'ы и балансировка скобок, модель может вернуть невалидный JSON
2. **Token waste** — 200-500 токенов на JSON в каждом ответе + 500+ токенов инструкций в system prompt
3. **Загрязнение промпта** — модель получает множество инструкций про формат вместо фокусировки на задаче
4. **Перегруженный контракт** — 15+ полей в одном блоке, модель должна помнить про все
5. **Нет гарантии валидности** — валидация только post-hoc

**Альтернативы (будут реализованы позже):**
- **Tool Use / Function Calling** — нативный механизм с гарантированной валидностью JSON
- TSM state — управляется бэкендом, а не моделью
- Progress tracking — автоматический по tool calls и ответам модели

**Удалённый код:** `status-parser.ts`, prompt-файлы `SIMPLE.*.md`, `ORCHESTRATOR.*.md`, метод `getStatusPrompt()`, логика парсинга в `orchestrator.ts`, `captureStatus()` в `DebugCollector`, секция «JSON-блок (статус)» в DebugModal.

**Поля `TsmStatus` (`project`, `taskName`, `progress`, `approvedPlan`, `alreadyDone`, `currentlyDoing`, `currentTaskInfo`, `updatedProjectInfo`)** — сохранены в типах, будут заполняться через другие механизмы.

**Дата:** 2026-05-23

---

### AD-001–AD-021

Подробные описания сохранены в `AGENTS_OLD.md`. Здесь — только краткий статус.

| AD | Суть |
|----|------|
| AD-001 | FastAPI — deprecated, заменён на Hono (TS) |
| AD-002 | TSM — логика переносится в synth-core |
| AD-003 | Admin HTML — deprecated, админка в synth-ui |
| AD-004 | Два сервиса — расширено до 4 компонентов |
| AD-005 | JSON file storage — сохраняется в synth-backend |
| AD-007 | Раздельные репозитории — заменены монорепозиторием |
| AD-008 | WebSocket — протокол сохраняется, переносится на TS |
| AD-009 | SessionEventBus — сохраняется, переносится на TS |
| AD-010–013 | Оркестратор, очередь, блокировки — упрощаются, переносятся |
| AD-014 | Проекты — сохраняются, переносятся |
| AD-017 | API-контракт — сохраняется, дополняется Runner Protocol |
| AD-018 | Выбор движка — реализуется через synth-runner |
| AD-019 | React SPA — сохраняется, добавляется админка |
| AD-020 | Python backend — deprecated |
| AD-021 | OpenAPI типы — сохраняется для synth-backend |

---

## Аутентификация

**Правило:** Все запросы к API (кроме `GET /health`) должны быть аутентифицированы.
Неаутентифицированный запрос → 401.

**RBAC:** Роли `ADMIN`, `USER`, `LEAD`, `AUDITOR`. Матрица разрешений и Middleware — в `rbac-design.md`.

### Режимы

| Режим | Компонент | Когда | Механизм |
|-------|-----------|-------|----------|
| **Debug** | synth-backend | Разработка, `auth.debug_mode: true` | API-ключи из `test_users` — каждому своя роль |
| **API Key** | synth-backend | Продакшен без OIDC | Один `auth.api_key` → все запросы как ADMIN |
| **OIDC** | synth-backend | Продакшен с Keycloak | JWT Bearer token + cookie `user_session` |
| **Local** | synth-core | `synth serve --api-key` | Один ключ → роль USER |

### Требования к коду

- Каждый роут обязан декларировать минимальную роль через middleware (`requireAuth`, `requirePermission`)
- В debug_mode должны быть доступны предопределённые тестовые пользователи с разными ролями для тестирования ограничений
- `dev.sh` автоматически устанавливает `SYNTH_AUTH_DEBUG=true` для локальной разработки
- Auth middleware — первый в цепочке после CORS/logging

---

## План миграции

### Фаза 1: @synth/shared (фундамент)
- Типы: Session, Message, Project, User, Agent, Provider, QueueItem, TSM
- Интерфейсы: SessionStore, MessageQueue, LLMProvider, EventBus, RunnerRegistry
- Zod-схемы валидации
- Протоколы: WS-сообщения, Engine HTTP API, Runner Protocol
- Утилиты: nanoid, форматирование дат

### Фаза 2: synth-core — общая реализация
- LLM Provider abstraction + factory
- SessionManager, QueueProcessor, ProjectManager
- SessionEventBus, ContextBuilder, ContextOptimizer
- TSM, AgentRegistry, инструменты, MCP интеграция
- FileStore (JSON files)
- HTTP API v2 (Hono routes)
- CLI: `synth chat`, `synth serve`
- Локальная auth (один API-ключ)

### Фаза 3: synth-backend — облачные функции
- OIDC-клиент (Keycloak), RBAC middleware
- Runner Registry (WebSocket сервер)
- LLM Proxy endpoint (`/api/runner/proxy/v1/chat/completions`)
- Admin routes (JSON, без HTML)
- Импортирует @synth/core, дополняет облачными функциями

### Фаза 4: synth-ui адаптация
- Подключение к новому бэкенду (API v2)
- Админка: портирование HTML-шаблонов в React-компоненты
- OIDC login flow
- OpenAPI-генерируемые типы

### Фаза 5: synth-runner
- Engine Manager (запуск opencode/cline как подпроцессов)
- Локальный LLM Proxy для движков (проброс на бэк/corе)
- WS-клиент к synth-backend (control channel)
- Адаптеры протоколов движков (OpenCode API, Cline stdin/stdout)
---

## Хранилище данных

**Решение:** JSON-файлы вне репозитория (AD-005 + AD-023). Путь задаётся через `SYNTH_DATA_DIR` env var или `storage.dataDir` в config.yaml. Дефолт: `/var/synth/data`.

В локальной разработке `dev.sh` устанавливает `SYNTH_DATA_DIR=/home/eof/dev/Synth/data`.

```
$SYNTH_DATA_DIR/
├── sessions/              # JSON-файлы сессий
├── projects/              # JSON-файлы проектов
├── providers/             # JSON-файлы провайдеров
├── models/                # JSON-файлы моделей
├── agents/                # JSON-файлы агентов
├── context/               # Файлы контекста (user, roles)
│   ├── user/
│   └── roles/
└── auth/
    ├── sessions/          # Серверные сессии
    ├── states/            # OIDC state-токены
    └── profiles/          # Профили пользователей
```

**Атомарная запись:** пишем во временный файл `.tmp.{uuid}`, затем `rename()`.

**Инициализация:** `ensureDataDir()` создаёт все подкаталоги при первом запуске.

---

## Распределение портов

| Сервис | Порт | Env var | Описание |
|--------|------|---------|----------|
| synth-backend | 5000 | `SYNTH_PORT` | Hono API (новый) |
| synth-ui | 5002 | `VITE_PORT` | React SPA (dev, Vite) |
| synth-runner | динамический | `SYNTH_RUNNER_PORT` | Gateway (1 процесс на пользователя) |
| synth-core | динамический | `SYNTH_CORE_PORT` | HTTP API движка |
| opencode | динамический | — | `opencode serve` |
| cline | динамический | — | `cline headless` |
| synth-legacy | 5000 (бывший) | — | Python/FastAPI (заморожен) |
| synth-legacy-ui | 5001 | — | Flask+htmx (заморожен) |
| synth-frontend | 5173 | — | Форк OC (заморожен) |

---

## Соглашения по коду

### Язык: TypeScript (strict mode)

| Тип | Соглашение | Пример |
|-----|------------|--------|
| Файлы | `kebab-case.ts` | `session-manager.ts` |
| Классы | `PascalCase` | `SessionManager` |
| Интерфейсы | `PascalCase` | `interface SessionStore` |
| Типы | `PascalCase` | `type QueueMessage` |
| Функции | `camelCase` | `getSession()` |
| Константы | `UPPER_SNAKE_CASE` | `MAX_RETRIES = 3` |
| Приватные методы | `_camelCase` или `#camelCase` | `_internalMethod()` |
| API маршруты | `kebab-case` | `/api/chat`, `/api/sessions` |

### Порядок импортов

```typescript
// 1. Node.js builtins
import { readFile } from 'node:fs/promises';

// 2. Внешние библиотеки
import { Hono } from 'hono';
import { z } from 'zod';

// 3. @synth/shared
import { Session, type Message } from '@synth/shared';

// 4. Локальные модули
import { SessionStorage } from '../storage/sessions.js';
```

### Формат коммитов

```
<тип>: <описание на русском>

feat: добавлен эндпоинт для списка провайдеров
fix: исправлена обработка пустых сессий
refactor: упрощён ChatOrchestrator
docs: обновлён AGENTS.md
test: добавлены тесты для SessionStore
chore: обновлены зависимости
```

---

## Запуск (dev)

### Быстрый старт — dev.sh

```bash
./dev.sh            # backend (:5000) + UI (:5002)
./dev.sh backend    # только бэкенд
./dev.sh ui         # только UI
./dev.sh core       # synth-core standalone
./dev.sh all        # backend + UI + core
```

**Логи:** автоматически пишутся в `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`.  
При перезапуске очищаются. При Ctrl+C выводятся пути к логам.

**Переменные окружения в dev.sh:**
- `SYNTH_DATA_DIR=/home/eof/dev/Synth/data` — каталог данных вне репозитория
- `SYNTH_AUTH_DEBUG=true` — режим отладки с тестовыми пользователями
- `SYNTH_PORT`, `SYNTH_CORE_PORT`, `SYNTH_RUNNER_PORT` — порты компонентов
- `VITE_BACKEND_URL`, `VITE_PORT` — настройки UI dev-сервера

**Режим отладки:** `dev.sh` автоматически включает `SYNTH_AUTH_DEBUG=true`.  
Форма входа показывает селектор пользователя с тестовыми ключами.

**Тестовые ключи (debug mode):**

| Пользователь | Ключ | Роль |
|-------------|------|------|
| admin | `admin-key-123` | ADMIN |
| developer | `user-key-456` | USER |
| lead | `lead-key-789` | LEAD |
| auditor | `auditor-key-012` | AUDITOR |

Ключи можно переопределить через переменные окружения:
`SYNTH_TEST_ADMIN_KEY`, `SYNTH_TEST_USER_KEY`, `SYNTH_TEST_LEAD_KEY`, `SYNTH_TEST_AUDITOR_KEY`.

### Ручной запуск

```bash
cd synth && pnpm install

# synth-backend
pnpm --filter @synth/backend dev

# synth-ui
pnpm --filter @synth/ui dev

# synth-core (standalone)
pnpm --filter @synth/core build
node packages/core/dist/cli.js chat "привет"

# synth-core (managed, с подключением к бэку)
node packages/core/dist/cli.js serve --backend http://localhost:5000
```

### Временные файлы

**Каталог:** `tmp/` в корне проекта

Использовать для:
- Логов при отладке (`tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`)
- Временных файлов тестирования
- **Не коммитится в git**

---

## Документация

| Файл | Назначение |
|------|------------|
| **AGENTS.md** | Архитектурные решения, соглашения, план миграции |
| **AGENTS_OLD.md** | Архивный: предыдущие AD, Python/FastAPI стек |
| **SPEC.md** | Спецификация функциональности (SRS) |
| **rbac-design.md** | Дизайн RBAC через Keycloak |

### Документация компонентов

- `synth/packages/backend/AGENTS.md` — Hono API, конвенции, спецификация API v2
- `synth/packages/ui/AGENTS.md` — React UI требования (будет создан)
- `synth/packages/runner/AGENTS.md` — Runner архитектура (будет создан)
- `synth/packages/core/AGENTS.md` — Движок, CLI, локальный API (будет создан)
- `synth-legacy/AGENTS.md` — Python бэкенд (архивный)

---

## Приоритет конфигурации

1. CLI-аргументы (высший)
2. Переменные окружения (`SYNTH_*`, `VITE_*`)
3. `config.yaml` (каскадный поиск)
4. Значения по умолчанию (низший)

### Каскадный поиск config.yaml

1. `--config` CLI флаг ИЛИ `SYNTH_CONFIG` env var
2. `./synth.config.yaml` (CWD)
3. `./config.yaml` (CWD)
4. `~/.config/synth/config.yaml` (пользовательский)
5. `/etc/synth/config.yaml` (системный)

### Механизм резолвинга

```
CLI args > Env vars (SYNTH_*) > config.yaml > defaults
```

Каждый компонент использует `loadConfig()` из `@synth/shared/config` и переопределяет специфичные параметры через env vars (в адаптере конфига компонента, например `loadBackendConfig()`).

### Права доступа к файлам

- `config.yaml` — 600 (rw-------)
- `data/` — вне репозитория, в gitignore
- API ключи — никогда не коммитить
- Провайдеры и модели в дефолтах — пустые строки
