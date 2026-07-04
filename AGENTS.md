# Synth — архитектурные соглашения

## Язык

Все сообщения, коммиты и документация — **на русском**. Не коммитить без явной просьбы пользователя.

---

## Прототип

Прототип: `~/dev/aic/t11` (t11). Его код **не менять**.

Локально: бэкенд `:5100`, UI `:5101`. Для аутентификации — ключ `your-secret-api-key`.

При реализации новой функциональности сначала исследовать как это сделано в прототипе.
Текущий проект разрабатывается как конечный продукт — решения могут отличаться.

---

## Структура проекта

Монорепозиторий `synth/` (pnpm workspaces). Единый стек TypeScript.

```
synth/
├── packages/
│   ├── shared/    @synth/shared   # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/      @synth/core     # Ядро: сессии, очередь, LLM, TSM, MCP, FileStore
│   │                              #   HTTP API v2 (Hono), CLI (synth chat/serve)
│   ├── backend/   @synth/backend  # Hono API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
│   ├── ui/        @synth/ui       # React 19 SPA + админка (Vite)
│   └── runner/    @synth/runner   # Gateway: адаптеры opencode/cline, LLM Proxy
│                                  #   Импортируется in-process из @synth/core
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
└── .prettierrc
```

### Слои зависимостей

```
@synth/shared  ←  только контракты, никакой логики
       ↑
@synth/core    ←  импортирует shared, содержит всю общую логику
       ↑
┌──────┴──────┐
@synth/backend │ @synth/ui     ←  импортируют core
@synth/runner (in-process)     ←  опционально импортируется в core
```

---

## Команды

Из корня `synth/`:

```bash
# Разработка
./dev.sh                    # backend (:5000) + UI (:5002)
./dev.sh backend | ui | core | all

# Сборка, тесты, линтинг
pnpm install                # установка зависимостей
pnpm build                  # сборка всех пакетов
pnpm typecheck              # проверка типов
pnpm lint                   # ESLint
pnpm test                   # Vitest
pnpm clean                  # очистка dist/
```

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/`; backend — аналогично для `definitions/`.

Логи: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`. Каталог `tmp/` не коммитится.

---

## Архитектурные решения (ключевые)

| AD | Суть |
|----|------|
| AD-002 | Собственная TSM (Task State Machine), в @synth/core |
| AD-005 | JSON-файлы как хранилище (атомарная запись через tmp-файл + rename) |
| AD-008 | WebSocket для real-time событий |
| AD-009 | SessionEventBus — шина событий сессии |
| AD-014 | Проект как контейнер (сессии, файлы, контекст внутри проекта) |
| AD-017 | Собственный API-контракт (API v2 на Hono) |
| AD-018 | Выбор AI-движка на уровне сессии |
| AD-019 | React 19 SPA с нуля |
| AD-022 | Единый TypeScript стек + Runner архитектура |
| AD-023 | Единая система конфигурации (@synth/shared/config) |
| AD-024 | Единый транспорт: EventHub (backend) + TransportClient (UI) |

Подробности deprecated решений — в `archive/AGENTS_OLD.md`.

### AD-022: TypeScript стек + Runner

- **@synth/core** — автономное ядро: сессии, очередь, LLM-провайдеры, TSM, MCP, HTTP API v2, CLI
- **@synth/backend** — облачный API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
- **@synth/runner** — мост между бэкендом и движками (opencode, cline, synth-core)
- **@synth/ui** — React 19 SPA + админка

### AD-023: Конфигурация

Приоритет: `CLI-флаги > SYNTH_* env vars > config.yaml > defaults`.

Каскадный поиск `config.yaml`:
1. `--config` / `SYNTH_CONFIG`
2. `./synth.config.yaml`
3. `./config.yaml`
4. `~/.config/synth/config.yaml`
5. `/etc/synth/config.yaml`

Ключевые env vars: `SYNTH_DATA_DIR`, `SYNTH_PORT`, `SYNTH_CORE_PORT`, `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`.

### AD-024: Транспорт (EventHub + TransportClient)

Единое WS-соединение `WS /ws/events` для всех событий. EventHub на бэкенде автоматически подписывает клиентов на сессии пользователя. TransportClient на UI — единый клиент с авто-фоллбеком на SSE.

### Модель Runner

Раннер — мост между бэкендом и движками. Два режима: локальный (прямой доступ к ФС) и облачный (K8s pod, per-user).

Движки — stateless: история на бэкенде, на вход получают историю + новое сообщение + контекст.

### Отказ от JSON-блока

Механизм JSON-блока (модель возвращает JSON со статусом в конце ответа) не перенесён из прототипа. Причины: хрупкий парсинг, трата токенов, загрязнение промпта. Замена: Tool Use / Function Calling, TSM управляется бэкендом.

---

## Аутентификация

Все запросы к API (кроме `GET /health`) аутентифицированы. 401 для неаутентифицированных.

Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`. Middleware: `requireAuth`, `requirePermission`.

### Режимы

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | Тестовые ключи (admin-key-123, user-key-456, lead-key-789, auditor-key-012) |
| API Key | backend | Продакшен без OIDC | Один `SYNTH_API_KEY` → роль ADMIN |
| OIDC | backend | Продакшен с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve --api-key` | Один ключ → роль USER |

Auth middleware — первый в цепочке после CORS/logging.

---

## Соглашения по коду

### TypeScript (strict mode)

| Элемент | Стиль | Пример |
|---------|-------|--------|
| Файлы | `kebab-case.ts` | `session-manager.ts` |
| Классы/Интерфейсы/Типы | `PascalCase` | `SessionManager`, `interface SessionStore` |
| Функции | `camelCase` | `getSession()` |
| Константы | `UPPER_SNAKE_CASE` | `MAX_RETRIES = 3` |
| Приватные методы | `_camelCase` | `_internalMethod()` |
| API маршруты | `kebab-case` | `/api/v2/sessions` |

### Порядок импортов

```typescript
// 1. Node.js builtins
import { readFile } from 'node:fs/promises';

// 2. Внешние библиотеки
import { Hono } from 'hono';

// 3. @synth/shared
import { type Session } from '@synth/shared';

// 4. Локальные модули
import { SessionStorage } from '../storage/sessions.js';
```

### Коммиты

```bash
git commit -m "feat: добавлен эндпоинт для списка провайдеров"
git commit -m "fix: исправлена обработка пустых сессий"
git commit -m "refactor: упрощён ChatOrchestrator"
git commit -m "docs: обновлён AGENTS.md"
git commit -m "test: добавлены тесты для SessionStore"
```

---

## Порты

| Сервис | Порт | Env var |
|--------|------|---------|
| synth-backend | 5000 | `SYNTH_PORT` |
| synth-ui | 5002 | `VITE_PORT` |
| synth-core | 4300 | `SYNTH_CORE_PORT` |
| synth-runner | 5200 | `SYNTH_RUNNER_PORT` |
| LLM Proxy (runner) | 9090 | — |
| opencode (движок) | 4100 | — |
| cline (движок) | 4200 | — |

---

## Хранилище данных

JSON-файлы вне репозитория. Путь: `SYNTH_DATA_DIR` или `storage.dataDir` в config.yaml.
Дефолт: `/var/synth/data`. В разработке `dev.sh` задаёт свой путь.

Атомарная запись: временный файл `.tmp.{uuid}` → `rename()`.

```
$SYNTH_DATA_DIR/
├── sessions/       projects/       providers/
├── models/         agents/         context/
└── auth/           (sessions, states, profiles)
```

---

## Сборка и публикация

### Скрипты (в корне `/Agent/dev/Synth/`)

| Скрипт | Назначение |
|--------|------------|
| `build.sh` | Полная сборка: shared → core → ui → synth. Опции: `--clean`, `--check`, `--docker`, `--docker-tag=X` |
| `publish.sh` | Публикация в npm. Опции: `--dry-run`, `--no-build`, `--registry=both\|npmjs\|gitverse`, `--docker` |
| `version-bump.sh` | Bump версии: `./version-bump.sh patch\|minor\|major\|X.Y.Z`. Обновляет `version.ts` + все `package.json` |
| `dev.sh` | Dev-запуск: backend (:5000) + UI (:5002). Аргументы: `backend\|ui\|core\|all` |

### Версионирование

Единая константа `SYNTH_VERSION` в `packages/shared/src/version.ts`.
Текущая версия: из `packages/synth/package.json`.

При bump-е версии обновляются:
1. `packages/shared/src/version.ts` — константа `SYNTH_VERSION`
2. `packages/*/package.json` — поле `version` во всех 6 пакетах

Все hardcoded строки версии в коде заменены на импорт `SYNTH_VERSION` из `@synth/shared`.

### Публикация npm

Публикуемый пакет: `@itphx/synth` (из `packages/synth/`).
Два реестра:
- `https://registry.npmjs.org` — токен `NPM_TOKEN`
- `https://npm.gitverse.ru` — токен `GV_TOKEN` (единый для всего GitVerse)

### Docker

Образ: `registry.gitverse.ru/itphx/synth:<version>` (latest).
Токен: `GV_TOKEN`.

---

## CI/CD (GitVerse)

### Workflow-файлы

| Файл | Назначение | Триггер |
|------|------------|---------|
| `.gitverse/workflows/ci.yaml` | CI: typecheck, lint, тесты | `push`, `pull_request` |
| `.gitverse/workflows/release.yaml` | Релиз: bump, сборка, npm, Docker, Release | `workflow_dispatch`, `push tags v*` |

### Секреты (настроены в репозитории)

| Secret | Назначение |
|--------|------------|
| `NPM_TOKEN` | Публикация в npmjs.org |
| `GV_TOKEN` | Единый токен GitVerse (API, Docker Registry, npm registry, git push от бота) |

**Важно:** префикс `GITVERSE_` запрещён в именах секретов GitVerse. Использовать `GV_`.

### Особенности GitVerse CI

1. **`actions/setup-node@v4`** — не использовать. Вместо этого: `npm install -g pnpm@latest`
2. **`${{ env.VAR }}`** — не работает, резолвится в Go-строку `%!t(string=...)`. Значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает. Выносить сложный bash в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub, в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`
5. Версия Node.js в раннере: 22 (предустановлена).

### Порядок сборки в CI

```
pnpm install --frozen-lockfile
pnpm --filter @synth/shared build    # обязательно перед typecheck!
pnpm --filter @synth/core build      # нужно для backend и runner
pnpm typecheck                       # рекурсивно по всем пакетам
pnpm lint
pnpm test
```

Без сборки `shared` и `core` перед `typecheck` — `@synth/runner` и `@synth/backend` не найдут типы.

### Запуск релиза

1. Dry-run: `workflow_dispatch` с `dry_run: true` — проверка без публикации
2. Реальная публикация: `workflow_dispatch` с `dry_run: false`
3. Или вручную: создать тег `vX.Y.Z` и запушить — workflow запустится автоматически

### Локальная проверка перед пушем

```bash
pnpm typecheck && pnpm lint && pnpm test
```

---

## GitVerse MCP

### Подключение к opencode

Конфигурация в `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "gitverse": {
    "type": "remote",
    "url": "https://mcp.gitverse.ru",
    "headers": {
      "Authorization": "Bearer <токен>"
    },
    "oauth": false,
    "enabled": true
  }
}
```

**Важно:** `"oauth": false` обязательно для GitVerse MCP (не поддерживает OAuth flow).
Изменения в `opencode.jsonc` требуют перезапуска opencode.

### Токен

Получить: `https://gitverse.ru/settings/tokens`
Права: для read-only достаточно «Чтение», для записи — «Запись».

### Доступные инструменты (37 шт.)

Группы: репозитории, файлы, коммиты, релизы, PR, CI/CD, пользователи, команды, звёзды.
Подробнее: `https://gitverse.ru/docs/ai/mcp/gitverse-mcp-tools`

---

## Документация

| Файл | Назначение |
|------|------------|
| `AGENTS.md` | Архитектурные соглашения (этот файл) |
| `plan.md` | План дальнейших работ |
| `archive/AGENTS_OLD.md` | Архив: deprecated AD, Python/FastAPI стек |
| `SPEC.md` | Спецификация функциональности |
| `rbac-design.md` | Дизайн RBAC |
