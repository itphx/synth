# Разработка Synth

## Требования

- **Node.js** >= 22
- **pnpm** >= 11

## Быстрый старт

```bash
# Установка зависимостей
pnpm install

# Проверка типов
pnpm typecheck

# Запуск тестов
pnpm test

# Сборка всех пакетов
pnpm build

# Линтинг
pnpm lint
```

## dev.sh

Универсальный скрипт для разработки — `synth/scripts/dev.sh`:

```bash
./scripts/dev.sh            # backend (:5000) + UI (:5002)
./scripts/dev.sh backend    # только бэкенд
./scripts/dev.sh ui         # только UI
./scripts/dev.sh core       # synth-core standalone (:4300)
./scripts/dev.sh all        # backend + UI + core
```

Логи пишутся в `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log` (внутри `synth/`). При перезапуске очищаются. При Ctrl+C выводятся пути к логам.

### Переменные окружения dev.sh

- `SYNTH_AUTH_DEBUG=true` — режим отладки с тестовыми пользователями
- `SYNTH_DATA_DIR=/home/eof/dev/Synth/data` — каталог данных вне репозитория
- `SYNTH_LOG_DIR=$ROOT/tmp` — каталог логов (эндпоинт `/api/v2/logs`)
- `SYNTH_PORT=5000`, `SYNTH_CORE_PORT=4300`, `SYNTH_RUNNER_PORT=5200`, `VITE_PORT=5002`
- `SYNTH_HOST=0.0.0.0` — хост для всех сервисов

### Режим отладки auth

`dev.sh` автоматически включает `SYNTH_AUTH_DEBUG=true`.  
Форма входа показывает селектор пользователя с тестовыми ключами:

| Пользователь | Ключ | Роль |
|-------------|------|------|
| admin | `admin-key-123` | ADMIN |
| developer | `user-key-456` | USER |
| lead | `lead-key-789` | LEAD |
| auditor | `auditor-key-012` | AUDITOR |

Ключи переопределяются через: `SYNTH_TEST_ADMIN_KEY`, `SYNTH_TEST_USER_KEY`, `SYNTH_TEST_LEAD_KEY`, `SYNTH_TEST_AUDITOR_KEY`.

## standalone.sh

Запуск Synth «как у конечного пользователя» — `synth/scripts/standalone.sh`:
собирает npm-пакеты монорепо (`shared → core → ui → synth`), упаковывает их
(`pnpm pack`), устанавливает в изолированный prefix (`npm install` четырёх `.tgz`)
и запускает `synth serve` из установленного `node_modules/.bin/synth`
(`SYNTH_DATA_DIR=<data> … serve --no-auto-profile`). Нужен для ручной и
автоматической проверки standalone-UI (в т.ч. диалога выбора рабочего каталога,
AD-075), где managed показывает read-only, а standalone — политику `confirm`.

```bash
./scripts/standalone.sh                 # собрать, установить, запустить (foreground)
./scripts/standalone.sh --no-build      # быстрый перезапуск на собранных пакетах
./scripts/standalone.sh --check         # полный smoke и выход (CI/автотест)
./scripts/standalone.sh --clean --port 4310
```

Опции:

| Опция | Назначение |
|---|---|
| `--port <port>` | порт standalone-сервера (default: `SYNTH_CORE_PORT` или `4300`) |
| `--host <host>` | адрес прослушивания (default: `127.0.0.1`) |
| `--data-dir <path>` | каталог данных (default: `tmp/standalone/data`) |
| `--api-key <key>` | API-ключ local auth (default: авто-генерация; печатается в сводке) |
| `--prefix <path>` | каталог установки пакетов (default: `tmp/standalone/install`) |
| `--no-build` | не пересобирать пакеты (использовать уже собранные `dist`) |
| `--rebuild-packs` | принудительно пересобрать tarball'ы |
| `--check` | прогнать smoke-проверки и завершиться (код выхода 0/1) |
| `--keep-data` / `--clean` | не очищать / очистить `--data-dir` (default — `--keep-data`) |

Логи: `tmp/standalone-build.log` — сборка/упаковка/установка, `tmp/standalone.log` — вывод standalone-сервера.

`--check` выполняет smoke: `/health` → 200, `POST /projects` → 201 с созданием каталога workspace,
`GET /fs/workspace-root` → 200, `GET /settings/workspace-policy` → 200 с `outsideRoot=confirm` (standalone),
затем завершает сервер.

**Отличия.** `dev.sh` запускает backend+UI (и core) **из исходников** на фиксированных портах с
debug-auth; `standalone.sh` ставит **собранные npm-пакеты** в изолированный prefix и запускает
`synth serve` (один API-ключ, FileStore в `--data-dir`) — ближе к конечному развёртыванию.
`hybrid.sh` (`./scripts/hybrid.sh`) поднимает локальный core с подключением к удалённому backend
(гибридный режим) — см. [HYBRID.md](./HYBRID.md).

> Tarball'ы собираются через `pnpm pack` (не `npm pack`): только pnpm резолвит `workspace:*`
> в реальную версию, иначе `npm install` не может разрешить локальные пакеты.

## Ручной запуск

Основной путь — через тонкую CLI-обёртку `@itphx/synth` (UI резолвится из `@itphx/synth-ui` автоматически):

```bash
# Сборка + запуск standalone-сервера
pnpm --filter @itphx/synth build
node packages/synth/dist/cli.js serve --api-key "dev-key"

# CLI-чат через обёртку
node packages/synth/dist/cli.js chat "привет"
node packages/synth/dist/cli.js config provider list
```

Запуск отдельных компонентов:

```bash
# synth-backend
pnpm --filter @itphx/synth-backend dev

# synth-ui
pnpm --filter @itphx/synth-ui dev

# synth-core (standalone, CLI ядра)
pnpm --filter @itphx/synth-core build
node packages/core/dist/main.js serve --api-key "dev-key"
node packages/core/dist/main.js chat "привет"
node packages/core/dist/main.js config
```

## Структура проекта

```
synth/
├── packages/
│   ├── shared/   → @itphx/synth-shared    # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/     → @itphx/synth-core      # Движок, CLI, HTTP API v2, MCP, FileStore
│   ├── backend/  → @itphx/synth-backend   # Hono API Hub: OIDC, RBAC, Runner Registry
│   ├── ui/       → @itphx/synth-ui        # React 19 SPA + админка (Vite)
│   ├── runner/   → @itphx/synth-runner    # Gateway движков (opencode, cline); in-process из core
│   └── synth/    → @itphx/synth           # Тонкая CLI-обёртка (bin: synth), не бандлит core
├── scripts/
│   ├── dev.sh                  # Скрипт разработки
│   ├── build.sh                # Полная сборка
│   ├── publish.sh              # Публикация в npm
│   ├── version-bump.sh         # Bump версии
│   ├── changelog.sh            # Генерация CHANGELOG (для CI release)
│   └── micro-benchmark.mjs     # Бенчмарк микро-слоя (AD-035)
└── tmp/                        # Логи (не коммитить)
```

## Стандарты кода

- **Язык:** TypeScript (strict mode)
- **Линтер:** ESLint — `pnpm lint`
- **Форматтер:** Prettier (конфиг `.prettierrc`; отдельного скрипта `pnpm format` нет)
- **Сборка:** tsup / TypeScript — `pnpm build`
- **Тесты:** Vitest — `pnpm test`

Документация ведётся на русском языке.
