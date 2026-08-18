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

# Сборка пакетов
pnpm --filter @itphx/shared build
pnpm --filter @itphx/core build
pnpm --filter @itphx/ui build
```

## dev.sh

Универсальный скрипт для разработки:

```bash
./dev.sh            # backend (:5000) + UI (:5002)
./dev.sh backend    # только бэкенд
./dev.sh ui         # только UI
./dev.sh core       # synth-core standalone
./dev.sh all        # backend + UI + core
```

Логи пишутся в `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`. При перезапуске очищаются. При Ctrl+C выводятся пути к логам.

### Переменные окружения dev.sh

- `SYNTH_DATA_DIR` — каталог данных (по умолчанию вне репозитория)
- `SYNTH_AUTH_DEBUG=true` — режим отладки с тестовыми пользователями
- `SYNTH_PORT`, `SYNTH_CORE_PORT`, `SYNTH_RUNNER_PORT` — порты

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

## Ручной запуск

```bash
# synth-backend
pnpm --filter @itphx/backend dev

# synth-ui
pnpm --filter @itphx/ui dev

# synth-core (standalone)
pnpm --filter @itphx/core build
node packages/core/dist/main.js serve --api-key "dev-key"

# synth-core (CLI)
node packages/core/dist/main.js chat "привет"
node packages/core/dist/main.js config
```

## Структура проекта

```
synth/
├── packages/
│   ├── shared/   → @itphx/shared    # Типы, схемы, конфигурация
│   ├── core/     → @itphx/core      # Движок, CLI, HTTP API
│   ├── backend/  → @itphx/backend   # Hono API Hub
│   ├── ui/       → @itphx/ui        # React SPA
│   └── runner/   → @itphx/runner    # Gateway движков
├── dev.sh                          # Скрипт разработки
└── tmp/                            # Логи (не коммитить)
```

## Стандарты кода

- **Язык:** TypeScript (strict mode)
- **Линтер:** ESLint — `pnpm lint`
- **Форматтер:** Prettier — `pnpm format`
- **Сборка:** TypeScript Compiler (`tsc`)
- **Тесты:** Vitest — `pnpm test`

Документация ведётся на русском языке.
