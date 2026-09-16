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
│   ├── shared/    @itphx/synth-shared   # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/      @itphx/synth-core     # Ядро: сессии, очередь, LLM, MCP, FileStore
│   │                              #   HTTP API v2 (Hono), CLI (synth chat/serve)
│   ├── backend/   @itphx/synth-backend  # Hono API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
│   ├── ui/        @itphx/synth-ui       # React 19 SPA + админка (Vite)
│   ├── runner/    @itphx/synth-runner   # Gateway: адаптеры opencode/cline, LLM Proxy
│   │                              #   Импортируется in-process из @itphx/synth-core
│   └── synth/     @itphx/synth    # Публикуемая CLI-обёртка (bin: synth). Тонкая —
│                                  #   зависит от core+ui+shared, не бандлит их, не копирует ассеты
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
└── .prettierrc
tmp/                               # Каталог для временных файлов. Всегда используй его, а не /tmp в корне ФС
```

Все 6 пакетов публикуются в npm (см. «Публикация npm»). `@itphx/synth` — тонкая
CLI-обёртка над `@itphx/synth-core`/`@itphx/synth-ui`/`@itphx/synth-shared`; она не бандлит core
внутрь `cli.js` (core/ui/shared — external) и не копирует ассеты (промпты/UI/docs)
в свой каталог — всё резолвится из npm-зависимостей (см. AD-038).

### Слои зависимостей

```
@itphx/synth-shared  ←  только контракты, никакой логики
       ↑
@itphx/synth-core    ←  импортирует shared, содержит всю общую логику
       ↑
┌──────┴──────┐
@itphx/synth-backend │ @itphx/synth-ui     ←  импортируют core
@itphx/synth-runner (in-process)     ←  опционально импортируется в core
       ↑
@itphx/synth   ←  тонкая CLI-обёртка: core + ui + shared (npm-потребители)
```

---

## Команды

Из корня `synth/`:

```bash
# Разработка
./scripts/dev.sh                    # backend (:5000) + UI (:5002)
./scripts/dev.sh backend | ui | core | all

# Сборка, тесты, линтинг
pnpm install                # установка зависимостей
pnpm build                  # сборка всех пакетов
pnpm typecheck              # проверка типов
pnpm lint                   # ESLint
pnpm test                   # Vitest
pnpm clean                  # очистка dist/
```

Сборка core по-прежнему копирует `prompts/` и `definitions/*.json` в `dist/`; backend — аналогично для `definitions/`. Это **fallback для Docker** (где рядом с `package.json` нет `prompts/`, а есть только `dist/`): источник истины промптов — `packages/core/prompts`, который публикуется в npm через поле `files`. Дубликатов ассетов в репозитории больше нет (см. AD-038).

Логи: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`. Каталог `tmp/` не коммитится.

---

## Роутинг задач по агентам

При получении задачи определи её тип и вызови соответствующего сабагента:

| Тип задачи | Агент | Пример промпта |
|---|---|---|
| **Bug fix** | `@fixer` | «Почини баг: при логине с неверным паролем падает 500 вместо 401» |
| **Тестирование / QA** | `@tester` | «Проверь что модуль auth не сломан после изменений», «Прогони smoke-сценарии через Playwright» |
| **Исследование / консультация** | `@researcher` | «Как устроена авторизация?», «Найди все места где используется Redis» |

Эти агенты уже настроены и готовы к работе. Не дублируй их инструкции — просто
передавай задачу.

---

## Окружение разработки

### Скрипт запуска

Скрипты лежат в `synth/scripts/`. Запуск из `synth/` (`./scripts/dev.sh`)
или из корня проекта (`./synth/scripts/dev.sh`):

```bash
./scripts/dev.sh            # backend (:5000) + UI (:5002)
./scripts/dev.sh backend    # только backend
./scripts/dev.sh core       # synth-core standalone (:4300)
./scripts/dev.sh all        # backend + UI + core
```

Скрипт устанавливает ключевые переменные окружения:
- `SYNTH_AUTH_DEBUG=true` — debug-режим аутентификации с тестовыми пользователями
- `SYNTH_DATA_DIR=/home/eof/dev/Synth/data` — каталог данных вне репозитория
- `SYNTH_PORT`, `SYNTH_CORE_PORT`, `VITE_PORT` — порты компонентов

### Хранилище данных

Все runtime-данные (сессии, проекты, провайдеры, модели) — в `$SYNTH_DATA_DIR`.

Провайдеры: JSON-файлы в `$SYNTH_DATA_DIR/providers/`. Модели: файлы в `$SYNTH_DATA_DIR/models/`.

Основные провайдеры для разработки:

| Имя | Тип | Назначение |
|-----|-----|------------|
| `itphx` | openai | Рабочий провайдер (ai.itphx.ru), модель `local.qwen3:14b` |
| `ollama` | ollama | Локальный Ollama (owu.itphx.loc:11434) |

Для добавления нового провайдера достаточно создать JSON-файл в `providers/`, для модели — в `models/`.

### Тестирование через API

Базовый URL: `http://localhost:5000/api/v2`. Аутентификация:

```bash
AUTH="Authorization: Bearer admin-key-123"
```

Тестовые пользователи (debug mode):

| Пользователь | Ключ | Роли |
|-------------|------|------|
| admin | admin-key-123 | ADMIN |
| developer | user-key-456 | USER |
| lead | lead-key-789 | LEAD |
| auditor | auditor-key-012 | AUDITOR |

### Runtime-настройки (API)

| Метод/путь | Назначение |
|---|---|
| `PATCH /api/v2/sessions/:id` `{ mode }` | Переключение режима сессии: `plan` / `act` / `yolo` |
| `GET/PUT /api/v2/settings/workspace` | Рабочий каталог по умолчанию (runtime override, хранится в `settings.json`) |
| `GET/PUT /api/v2/settings/mcp` | Доступность MCP-инструментов по режимам (plan/act) |
| `POST /api/v2/mcp/probe` | Проверка MCP-сервера без регистрации инструментов |

### Автономный цикл разработки и тестирования

Каждая задача проходит 5 стадий. Переход между стадиями — **только после
удовлетворения критерия** и явной команды пользователя (или молчаливого согласия,
если пользователь не отвечает на уточняющий вопрос).

#### Стадия 1: Исследование (Investigate)

**Что делать:**
- Прочитать затронутые файлы, понять текущую реализацию
- Найти похожий код, понять паттерны
- Проверить прототип (`~/dev/aic/t11`) если задача связана с существующей фичей
- Задать уточняющие вопросы пользователю

**Что НЕ делать:**
- НЕ править код
- НЕ запускать сервер
- НЕ строить догадки — спрашивать

**Критерий перехода:** я могу сформулировать, какие именно файлы менять и почему.

#### Стадия 2: Планирование (Plan)

**Что делать:**
- Сформулировать список атомарных изменений (todo-лист)
- Оценить, не сломает ли изменение другие части
- Предложить план пользователю, получить подтверждение

**Что НЕ делать:**
- НЕ начинать кодить до подтверждения

**Критерий перехода:** пользователь явно подтвердил план (или сказал «приступай»).

#### Стадия 3: Реализация (Implement)

**Что делать:**
- Внести изменения строго по плану, минимальными правками
- Следовать код-стилю проекта (именование, структура, импорты — см. «Соглашения по коду»)
- Собрать: `pnpm build` (из `synth/`)
- Убедиться что нет ошибок компиляции

**Что НЕ делать:**
- НЕ менять код за пределами плана
- НЕ добавлять комментарии без явной просьбы
- НЕ коммитить (если не попросили)

**Критерий перехода:** `pnpm build` проходит без ошибок.

#### Стадия 4: Проверка (Verify)

**Что делать — в строгом порядке:**

1. `pnpm typecheck` — проверка типов
2. `pnpm lint` — линтинг
3. `pnpm test` — unit-тесты Vitest
4. Запустить `./scripts/dev.sh backend` для API-тестов
5. Проверить затронутые эндпоинты через curl
6. Запустить `./scripts/dev.sh` (backend + UI) и быстро проверить UI в браузере —
   открыть страницу, убедиться что интерфейс загружается и ключевые элементы
   отображаются корректно.

**Что НЕ делать:**
- НЕ устанавливать новые инструменты (playwright, браузеры, npm-пакеты)
- НЕ писать сложные bash-скрипты — достаточно curl и визуальной проверки
- НЕ прогонять AI-запросы через LLM без явной просьбы
- НЕ писать в JSON-файлы сессий/провайдеров/моделей вручную — для создания
  провайдера/модели использовать API, для сообщений — `POST /sessions/:id/prompt`

**Критерий перехода:** все тесты typecheck+lint+test проходят, ключевые эндпоинты
отвечают ожидаемым кодом и форматом.

#### Стадия 5: Документирование (Document)

**Что делать:**
- Обновить `AGENTS.md` если изменилось окружение или процессы
- Зафиксировать неочевидные решения в задаче (не в коде)

**Критерий перехода:** всё готово к следующей сессии.

#### Типичные ошибки (чего избегать)

1. **Переход к реализации без исследования** — приводит к переделкам
2. **Автоматизация ради автоматизации** — скрипты на 100 строк python/bash когда
   достаточно 3 строк curl и визуальной проверки в браузере
3. **Установка зависимостей для тестирования** — все инструменты уже настроены,
   если чего-то не хватает - скажи пользователю
4. **Запуск сервера без `dev.sh`** — порты и переменные уже настроены в скрипте,
   не изобретать свой способ
5. **Прямая запись в JSON-хранилище** — категорически запрещена. Единственные
   исключения: исправление багов в самом JSON-хранилище или миграция на новую
   схему. Во всех остальных случаях — только через API
6. **Игнорирование стадий** — нельзя одновременно исследовать, кодить и тестировать

#### Unit-тесты

Фреймворк: Vitest. Запуск:

```bash
# Все тесты
cd synth && pnpm test

# Отдельный файл
cd synth/packages/core && pnpm test -- --run src/engine/tools/task.test.ts
```

---

## Среды

| Среда | Что это | Как разворачивается |
|---|---|---|
| **dev** | локальная отладка | `./scripts/dev.sh` |
| **test** | внутренний тестовый, `https://synth.k3s.itphx.loc` | Fleet (`synth-deploy`), образы собираются локально и пушатся в `git.itphx.ru` |
| **preprod** | `https://synth-release.k3s.itphx.loc`, проверка процесса развёртывания | публикуемый Helm-чарт (GitVerse), релизные образы `gitverse.ru` |
| **prod** | у нас отсутствует — разворачивают клиенты/заказчики сами | публикуемый Helm-чарт (self-host) |

Правило: проверить текущие изменения — **dev** (`./scripts/dev.sh`); протестировать
перед релизом — **test** (Fleet); релиз — push master → сборка пакетов → раскатка
**preprod**.

---

## K3s-инстанс (managed-деплой, среда **test**)

**Среда test** (внутренний тестовый инстанс) развёрнута в K3s (Rancher Fleet) на `itphx.loc`.
Код приложения — в монорепо `synth/`, код деплоя test-среды — в отдельном git-репозитории
`synth-deploy/` (каталог рядом с `synth/`).

### Репозиторий деплоя

Fleet-деплой **test-среды** (namespace `synth`). preprod и prod разворачиваются из
публикуемого Helm-чарта (см. «Среды» и «Helm-чарт»), а не через Fleet.

- Helm-чарт + Fleet-конфиг: `Chart.yaml`, `values.yaml`, `fleet.yaml`, `templates/` (namespace `synth`)
- Fleet-репозиторий: `https://git.itphx.ru/itphx/synth-deploy.git`, ветка `main`
- Подробности: `synth-deploy/README.md`

### Адреса

| Сервис | Адрес |
|--------|-------|
| Synth UI (вход) | https://synth.k3s.itphx.loc |
| Keycloak issuer | https://keycloak.itphx.loc/realms/synth (клиент `synth`, confidential) |
| Backend в кластере | `synth-backend:5000` (namespace `synth`) |

Доступ к кластеру: `kubectl` (контекст `local`), поды/логи — `kubectl -n synth get pods`,
`kubectl -n synth logs deploy/synth-backend`.

### Учётные записи Keycloak

Тестовая УЗ (realm `synth`, роль `user`) и временная админская УЗ (realm `master`) — в файле
`secrets/keycloak-accounts.md` в корне проекта, вне git-репозитория `synth/`.

Временная админская УЗ используется для admin API Keycloak (`admin-cli`) — например, для диагностики
ролей и мапперов. Client secret клиента `synth` — в SealedSecret `synth-secrets` (namespace `synth`,
ключ `SYNTH_OIDC_CLIENT_SECRET`), команда для получения — в файле секретов.

---

## Гибридный режим

Гибридный режим — локальный core подключается к корпоративному серверу
(`synth serve --connect <url>`): в одном локальном UI объединяются локальные и
удалённые (backend) проекты/сессии, а LLM-запросы централизованы на сервере
(ключи, модели и аудит — только на нём). Реализовано в ветке `feat/hybrid-mode`;
лёгкий runtime-вход с общим каталогом данных, мета-реестр профилей серверов и
устойчивость (ConnectionWatcher) — в ветке `feat/hybrid-server-profiles` (2026-09-07);
детальные требования и статус — в [docs/HYBRID.md](docs/HYBRID.md);
архитектура — AD-042/AD-043/AD-045.

**UX (вход без Keycloak-ритуала):** `serve --connect` больше НЕ блокирует старт
device flow'ом — сервер поднимается «холодным», после listen тихо выполняется
авто-логин по сохранённым credentials (или по `--token`), а если credentials нет —
вход выполняется прямо в UI: форма логина с полями логин/пароль (ROPC
«за кулисами»), личность/роли/профиль приходят с сервера. Вход **всегда лёгкий
(runtime)**: без перезапуска процесса/перезагрузки страницы, локальные данные
лежат в едином dataDir и от сервера не зависят. Поле «Сервер» (адрес) в форме
показывается всегда в гибридном режиме (можно сменить сервер при протухшем
токене), предзаполняется последним использованным сервером и предлагает список
известных серверов из реестра профилей. Никакого «входа через браузер»
(device flow) в пользовательском пути нет — кнопка и модалка удалены из UI
(эндпоинты device-start/device-check в core остаются, но из UI не вызываются).

OIDC issuer/client_id локальный core узнаёт **с сервера** (`GET {server}/auth/oidc-meta`),
с fallback на флаги `--oidc-issuer`/`--oidc-client-id` для серверов без эндпоинта.
Эндпоинт публичный, отдаёт только issuer + public client_id (`synth-cli`), без секрета.

### Включение

Секция `remote` в config.yaml:

```yaml
remote:
  enabled: true
  backendUrl: "https://synth.k3s.itphx.loc"
  auth:
    type: device                  # device | api_key
    issuer: "https://keycloak.itphx.loc/realms/synth"
    clientId: "synth-cli"
  llm: "server"                   # server | local; server — централизация LLM
```

Или CLI-флагами без правки конфига (адрес можно не указывать — тогда его введёт
пользователь в форме входа UI):

```bash
# Адрес известен — UI предзаполнит поле «Сервер», спросит логин/пароль
synth serve --connect https://synth.k3s.itphx.loc \
  --oidc-issuer https://keycloak.itphx.loc/realms/synth \
  --oidc-client-id synth-cli

# Адрес не известен — UI покажет поле «Сервер» (пустое/последний адрес) + логин/пароль
synth serve --oidc-issuer https://keycloak.itphx.loc/realms/synth \
  --oidc-client-id synth-cli
```

Удобный запуск (сборка + CA + флаги): `./scripts/hybrid.sh [SERVER_URL]` —
без адреса стартует и даёт ввести адрес в UI, с адресом сразу подключается.

### Команды CLI

| Команда | Назначение |
|---|---|
| `synth serve --connect <url>` | Запуск локального core с подключением к серверу (опции `--oidc-issuer`, `--oidc-client-id`, `--token`). Локальные данные — в едином dataDir (не зависят от сервера). Без `--connect` подставляет последний использованный сервер (lastProfile из реестра) как адрес для тихого авто-входа; `--no-auto-profile` — нейтральный запуск (адрес вводится в форме входа UI) |
| `synth connect --backend <url>` | Сохранение credentials (ROPC по логину/паролю / `--token` API-ключ); credentials — в `~/.config/synth/credentials.json` (0600) |
| `synth disconnect --backend <url>` | Удалить сохранённые credentials |
| `synth project publish <id> --remote <url>` | Локальный проект → сервер (проект + сессии + файлы; `--no-files` / `--no-sessions`) |
| `synth project fork <id> --remote <url>` | Удалённый проект → локально (`--local-name`, `--no-files`, `--no-sessions`) |

### Поведение

- **Вход:** сервер стартует «холодным»; после listen тихий авто-логин
  (connectFromSaved / `--token`), иначе — форма логина в UI (адрес опционален:
  параметр/env → предзаполнен; иначе — пустое поле). OIDC-параметры — дискавери
  с сервера (`GET /auth/oidc-meta`), fallback на `--oidc-issuer`/`--oidc-client-id`.
  Вход всегда лёгкий (runtime): POST /auth/login подключает процесс на лету без
  перезапуска; после успеха best-effort обновляется мета-профиль в реестре.
- **Профили серверов:** profiles.json — мета-реестр для UX
  (`~/.config/synth/profiles.json`, 0600, атомарно: `{id, url, label, lastUsedAt, username}`):
  известные серверы (knownServers), последний использованный (lastServer),
  предзаполнение формы входа. Никаких профильных каталогов данных нет — локальные
  данные всех серверов лежат в ЕДИНОМ dataDir процесса; credentials — единый
  мульти-серверный файл `~/.config/synth/credentials.json`
  (`packages/core/src/profiles.ts` — только мета-реестр).
- **Смена сервера / выход:** «Выйти» в UI = runtime disconnect + удаление
  credentials активного сервера («забыть токен») + best-effort revoke refresh-токена
  на Keycloak + очистка cookie → форма входа. Мета-профиль при этом НЕ удаляется.
  Сменить сервер — «Выйти» и войти на другой адрес (поле «Сервер» редактируемое,
  варианты из knownServers); вход на новый сервер происходит на лету, без
  перезапуска процесса и перезагрузки страницы.
- **Устойчивость (ConnectionWatcher):** фоновый watcher
  (`packages/core/src/server/connection-watcher.ts`) каждые ~15 с проверяет
  доступность backend (`/health`) и валидность токена (`/auth/status`);
  `/hybrid/status.connected` отражает реальную доступность (раньше — лишь наличие
  сессии). Сервер упал → connected=false (offline-баннер); вернулся — авто-подключение
  по сохранённым credentials (не чаще 1/30 с); невалидный токен — пересоздание
  сессии (refresh).
- **Агрегация миров:** проекты/сессии локального core объединяются с удалёнными
  (backend); у каждой сущности поле `origin: 'local'|'remote'`, удалённые id —
  `remote:<uuid>` (исключают коллизии UUID). Запросы маршрутизируются по миру:
  локальные обрабатывает core, удалённые — проксируются на сервер.
- **Статус:** `GET /api/v2/hybrid/status` →
  `{ enabled, connected, backendUrl, serverConfigured, serverLoginAvailable, user, knownServers, lastServer }`
  (без auth; UI опрашивает ~30 с). `serverConfigured` — адрес сервера задан при
  старте (даже без подключения); `serverLoginAvailable` — доступен вход на сервер;
  `knownServers` — известные серверы из реестра профилей (варианты для формы
  входа), `lastServer` — последний использованный (предзаполнение поля «Сервер»).
- **События:** RemoteEventBridge транслирует SSE сервера в локальный EventBus,
  события удалённых сессий переписываются в `remote:<id>` и доходят до UI.
- **LLM:** локальные сессии в гибриде ходят за LLM через сервер
  (`POST /api/v2/llm/chat/completions`, RemoteProvider `synth-remote`); при
  `remote.llm: server` локальные провайдеры запрещены полностью.
- **Offline-деградация:** сервер недоступен — локальный мир работает, списки
  деградируют с warn, явные remote-операции возвращают 502 OFFLINE; в UI баннер
  «Сервер недоступен», remote-сущности приглушены, селектор «где создать» — только «Локально».

### Ключевые файлы

- `packages/core/src/profiles.ts` — мета-реестр профилей серверов (`~/.config/synth/profiles.json`): knownServers/lastServer для UX (без каталогов данных/credentials)
- `packages/core/src/server/connection-watcher.ts` — фоновый watcher живости подключения (health/auth, авто-переподключение)
- `packages/core/src/remote/` — RemoteConnection (runtime-подключение), клиент, credentials, агрегация, событийный мост, publish/fork
- `packages/core/src/server/routes/auth.ts` — `/auth/status|session|login` (ROPC, runtime), `/auth/logout` (disconnect + revoke), `/auth/device-start|device-check` (не вызываются из UI)
- `packages/backend/src/routes/auth.ts` — `/auth/oidc-meta` (публичные OIDC-параметры для дискавери)
- `packages/backend/src/routes/llm.ts` — LLM Proxy (`POST /api/v2/llm/chat/completions`)
- `packages/backend/src/routes/sessions.ts` — `GET /sessions/:id/export`, `POST /sessions/import`
- UI: `packages/ui/src/components/layout/HybridStatusIndicator.tsx`, `HybridOfflineBanner.tsx`, `packages/ui/src/components/auth/LoginForm.tsx`, бейджи origin, селектор «где создать»
- `scripts/hybrid.sh` — запуск локального core в гибриде (сборка + CA + флаги; однократный запуск serve)

---

## Архитектурные решения (ключевые)

| AD | Суть | Подробно |
|----|------|----------|
| AD-005 | JSON-файлы как хранилище (атомарная запись через tmp-файл + rename) | — |
| AD-008 | WebSocket для real-time событий | — |
| AD-009 | SessionEventBus — шина событий сессии | — |
| AD-014 | Проект как контейнер (сессии, файлы, контекст внутри проекта) | — |
| AD-017 | Собственный API-контракт (API v2 на Hono) | — |
| AD-018 | Выбор AI-движка на уровне сессии | — |
| AD-019 | React 19 SPA с нуля | — |
| AD-022 | Единый TypeScript стек + Runner архитектура | [ad-022](./docs/arch_decisions/ad-022-typescript-stack-runner.md) |
| AD-023 | Единая система конфигурации (@itphx/synth-shared/config) | [ad-023](./docs/arch_decisions/ad-023-configuration.md) |
| AD-024 | Единый транспорт: EventHub (backend) + TransportClient (UI) | [ad-024](./docs/arch_decisions/ad-024-eventhub-transport.md) |
| AD-025 | Plan/Act как глобальный permission toggle (не отдельные агенты) ✅ Реализовано | [ad-025](./docs/arch_decisions/ad-025-plan-act-toggle.md) |
| AD-026 | Режимы контекста саб-агента: inherit / summary / none | — |
| AD-027 | Двойная передача плана: диск + system prompt ⚠️ Переопределено AD-039 (план — в проекте) | — |
| AD-028 | Настраиваемая строгость цикла Plan→Build: auto / strict / off ✅ Реализовано | [ad-028](./docs/arch_decisions/ad-028-plan-build-strictness.md) |
| AD-029 | Гранулярные permissions: allow/deny/ask per tool + file patterns ✅ Реализовано | [ad-029](./docs/arch_decisions/ad-029-granular-permissions.md) |
| AD-030 | Hooks для событий агента (pre/post tool use, session, plan, spawn) | — |
| AD-031 | Verification синт (аналог VerificationAgent из Claude Code) | — |
| AD-032 | Хранение истории: PostgreSQL нормализованная схема (сессии, сообщения, части) | — |
| AD-033 | Ветвление сессий, наследование контекста и межсессионное слияние ✅ Реализовано | [ad-033](./docs/arch_decisions/ad-033-session-branching-merge.md) |
| AD-034 | Routing между моделями (content + confidence + cost) ✅ Реализовано | [ad-034](./docs/arch_decisions/ad-034-model-routing.md) |
| AD-035 | Micro-model first: дешёвый слой перед LLM (правила/embedding) ✅ Реализовано | [ad-035](./docs/arch_decisions/ad-035-micro-model-first.md) |
| AD-036 | LLM Gateway: независимый слой безопасности (guard + обфускация + rate limit + аудит) ✅ Реализовано | [ad-036](./docs/arch_decisions/ad-036-llm-gateway.md) |
| AD-037 | Security step перед коммитом: git pre-commit hook + маркер-хеш (гарантия проверки) | — |
| AD-038 | Монорепо как набор публикуемых npm-пакетов (6 пакетов, pnpm publish, тонкая CLI-обёртка) ✅ Реализовано | [ad-038](./docs/arch_decisions/ad-038-npm-packages.md) |
| AD-039 | План — в проекте, todo — в сессии, состояние через инструменты (замена TSM) ✅ Реализовано | [ad-039](./docs/arch_decisions/ad-039-plan-in-project.md) |
| AD-040 | Сессии без проекта: контекст, подсказка, перенос между проектами ✅ Реализовано | [ad-040](./docs/arch_decisions/ad-040-sessions-without-project.md) |
| AD-041 | Единая таксономия ошибок LLM (llm-error.ts) + контракт локализации строк движка (@itphx/synth-shared/i18n) ✅ Реализовано | [ad-041](./docs/arch_decisions/ad-041-llm-error-taxonomy.md) |
| AD-042 | Гибридный режим: локальный core + централизованный сервер (агрегация миров, LLM Proxy, RemoteEventBridge, publish/fork) ✅ Реализовано | [ad-042](./docs/arch_decisions/ad-042-hybrid-mode.md) |
| AD-043 | Единая идентичность гибрида: вход в UI без Keycloak (runtime-подключение, ROPC, дискавери oidc-meta, единая личность) ✅ Реализовано | [ad-043](./docs/arch_decisions/ad-043-unified-identity-login.md) |
| AD-044 | Адаптивный мобильный UI + PWA (три зоны, панели-дроверы, touch-first, ручной app-shell) ✅ Реализовано | [ad-044](./docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md) |
| AD-045 | Профили серверов и лёгкий runtime-вход в гибриде: единый dataDir, мета-реестр profiles.json, вход без рестарта (отмена switch-profile/exit 77/409), logout = забыть токен + best-effort revoke, ConnectionWatcher ✅ Реализовано | [ad-045](./docs/arch_decisions/ad-045-hybrid-server-profiles.md) |

> **Перенос AD:** реализованные AD переносятся в `docs/arch_decisions/` (в AGENTS.md остаётся краткая строка + ссылка). Нереализованные остаются в AGENTS.md до реализации.

Подробности deprecated решений — в `archive/AGENTS_OLD.md` (вне репозитория), исторические AD (AD-001..010, Python-стек) — в `docs/arch_decisions/legacy/`.

### AD-022: TypeScript стек + Runner ✅ Реализовано

**Кратко:** Единый TypeScript стек: @itphx/synth-{core,backend,runner,ui}; история на бэкенде, движок stateless.
**Подробно:** [docs/arch_decisions/ad-022-typescript-stack-runner.md](./docs/arch_decisions/ad-022-typescript-stack-runner.md)

### AD-023: Конфигурация ✅ Реализовано

**Кратко:** Приоритет: CLI-флаги > SYNTH_* env > config.yaml > defaults; каскадный поиск config.yaml (5 путей).
**Подробно:** [docs/arch_decisions/ad-023-configuration.md](./docs/arch_decisions/ad-023-configuration.md)

### AD-024: Транспорт (EventHub + TransportClient) ✅ Реализовано

**Кратко:** Единое WS-соединение /ws/events; EventHub подписывает клиентов на сессии; TransportClient с фоллбеком на SSE.
**Подробно:** [docs/arch_decisions/ad-024-eventhub-transport.md](./docs/arch_decisions/ad-024-eventhub-transport.md)

### AD-025: Plan/Act как глобальный permission toggle ✅ Реализовано

**Кратко:** Plan/Act/YOLO — глобальный permission toggle сессии (не отдельные агенты); mode_applicable для read-only агентов.
**Подробно:** [docs/arch_decisions/ad-025-plan-act-toggle.md](./docs/arch_decisions/ad-025-plan-act-toggle.md)

### AD-026: Режимы контекста саб-агента

**Решение:** три режима передачи контекста при запуске саб-агента.

**Контекст:** fork-модель Claude Code (агент наследует всю историю родительской сессии) удобна на коротких диалогах, но на длинных — саб-агент получает 50K+ токенов мусора. Изоляция OpenCode (агент — чистый лист, только prompt) дешевле, но легко упустить важный контекст. Synth даёт выбор.

| Режим | Поведение | Токены | Когда использовать |
|---|---|---|---|
| `inherit` | Саб-агент получает полную историю родительской сессии + свой prompt | Много (fork-модель) | Короткие диалоги (<10K токенов), продолжение разговора, тесная связь с родителем |
| `summary` | Контекст сжимается через отдельную LLM перед отправкой саб-агенту. В саммари попадают: ключевые решения, соглашения, результаты предыдущих шагов | Среднее (авто-саммари) | Длинные диалоги, нужно сохранить суть без мусора. **Дефолт для продакшена** |
| `none` | Саб-агент получает только prompt. Никакого контекста родителя | Минимальное | Самодостаточные задачи, параллельные workers, чистое выполнение по спецификации |

**Выбор режима:**

```bash
synth task "Исправь баг в auth.ts" --context summary
synth task "Проверь build"         --context none
synth task "Продолжи рефакторинг"   --context inherit
```

**Внутренняя механика:** `summary` реализуется через дополнительный вызов LLM (быстрой/дешёвой модели) для компрессии контекста перед spawn-ом саб-агента. Саммари кешируется до следующего значимого изменения родительской сессии.

### AD-027: Двойная передача плана

> ⚠️ **Переопределено AD-039:** план хранится в проекте (`project.plan`), файлы `.synth/plans/` не используются; в system prompt план попадает из `project.plan`.

**Решение:** после утверждения план записывается в файл `.synth/plans/{timestamp}-{slug}.md` **и** вставляется в system prompt исполнителя.

**Контекст:** Claude Code встраивает план в `tool_result` выхода из plan mode — модель видит план сразу, но он существует только в контексте сессии. OpenCode пишет план на диск, модель должна прочитать его отдельным tool call. Synth берёт оба подхода.

```
plan (план написан)
  │
  ├─1─→ .synth/plans/{ts}-{slug}.md    ← файл на диске
  │       • персистентность между сессиями
  │       • аудит: видно что и когда планировали
  │       • возобновление: можно продолжить через неделю
  │
  └─2─→ system prompt исполнителя       ← встроен в контекст
          • немедленная видимость без tool call
          • не тратит токены на чтение файла
```

**Формат плана:**

```markdown
# План: {краткое описание}
> Создан: 2026-07-22 14:30 (analyst)
> Утверждён: 2026-07-22 14:35

## Подход
...

## Критические файлы
- src/auth/validate.ts:42
- src/auth/types.ts:15

## Шаги
1. ...
2. ...

## Верификация
- Прогнать тесты auth/*.test.ts
- Проверить edge cases: ...
```

**Защита от потери:** при возобновлении сессии план восстанавливается из файла. Если файл не найден (CCR/remote сессия) — ищется в снапшотах и истории сообщений (аналог `copyPlanForResume` из Claude Code).

### AD-028: Настраиваемая строгость цикла Plan → Build ✅ Реализовано

**Кратко:** Три режима строгости: auto / strict / off; в strict план обязателен перед любым write.
**Подробно:** [docs/arch_decisions/ad-028-plan-build-strictness.md](./docs/arch_decisions/ad-028-plan-build-strictness.md)

### AD-029: Гранулярные permissions ✅ Реализовано

**Кратко:** allow/deny/ask per tool + glob-паттерны; наследование саб-агентами; MCP по режимам plan/act.
**Подробно:** [docs/arch_decisions/ad-029-granular-permissions.md](./docs/arch_decisions/ad-029-granular-permissions.md)

### AD-030: Hooks для событий агента

**Решение:** система хуков на ключевые события жизненного цикла агента. На основе Claude Code (20+ событий), адаптированная под архитектуру Synth.

**Контекст:** у Claude Code — богатейшая система: PreToolUse, PostToolUse, Notification, Stop, PreCompact и 15+ других. У OpenCode — только `plugin.trigger("experimental.chat.system.transform")`. Synth реализует модель Claude Code на своей Plugin SDK.

**События:**

| Событие | Момент | Контекст | Назначение |
|---|---|---|---|
| `pre_tool_use` | Перед вызовом тула | `{tool, input, agent}` | Валидация, аудит, блокировка опасных команд |
| `post_tool_use` | После выполнения тула | `{tool, input, output, duration}` | Логирование, метрики, алертинг |
| `session_start` | Создание сессии | `{session_id, project, agent}` | Инициализация контекста, загрузка memory |
| `session_end` | Завершение сессии | `{session_id, summary, usage}` | Очистка, сохранение контекста, нотификация |
| `plan_approved` | План утверждён | `{plan_path, plan_content}` | Запуск verification, CI хуки, оповещение команды |
| `plan_rejected` | План отклонён | `{plan_path, reason?}` | Нотификация, возврат в plan mode |
| `agent_spawned` | Запуск саб-агента | `{agent_id, agent_type, parent_id}` | Настройка окружения, мониторинг |
| `agent_completed` | Саб-агент завершён | `{agent_id, result, usage}` | Сбор результатов, цепочка dependent tasks |
| `agent_failed` | Ошибка саб-агента | `{agent_id, error, retries}` | Алертинг, автоматический ретрай |
| `permission_denied` | Отказ в доступе | `{tool, input, reason}` | Аудит безопасности, оповещение ИБ |

**Регистрация через Plugin SDK:**

```typescript
// plugin.ts
export default function myPlugin(synth: SynthPlugin) {
  synth.hooks.on('pre_tool_use', async (ctx) => {
    if (ctx.tool === 'bash' && ctx.input.includes('rm -rf')) {
      return { block: true, reason: 'Потенциально опасная команда' }
    }
  })

  synth.hooks.on('post_tool_use', async (ctx) => {
    await metrics.increment(`tool.${ctx.tool}`, { duration: ctx.duration })
  })

  synth.hooks.on('plan_approved', async (ctx) => {
    await slack.notify(`План утверждён: ${ctx.plan_path}`)
    await ci.triggerVerification(ctx.session_id)
  })
}
```

**Важно:** хуки не должны блокировать основной поток. Для тяжёлых операций (CI, нотификации) — асинхронный fire-and-forget с таймаутом.

### AD-031: Verification синт

**Решение:** встроенный синт `verifier`, запускаемый автоматически после завершения реализации. Аналог VerificationAgent из Claude Code, адаптированный под архитектуру Synth.

**Поведение:**
- Запускается через hook `plan_approved` или вручную пользователем
- **Read-only** — не модифицирует проект (edit → deny, можно писать только в `/tmp`)
- Проверяет: билд, тесты, линтеры, typecheck
- Применяет **адверсальные пробы**: граничные значения, конкурентные запросы, идемпотентность
- Выносит вердикт: `VERDICT: PASS` / `FAIL` / `PARTIAL`
- `PARTIAL` — только когда проверка физически невозможна (нет тестов, сервер не стартует)

**Стандартный промпт** (адаптирован из Claude Code):

```
Ты verification specialist. Твоя задача — НЕ подтвердить что всё работает,
а ПОПЫТАТЬСЯ СЛОМАТЬ.

1. Прочитай план реализации из project.plan — это критерий успеха
2. Запусти build, полный test suite, linter, typecheck
3. Примени стратегию проверки под тип изменений:
   - Frontend: подними dev server → проверь через браузер → curl API
   - Backend: curl/fetch endpoints → проверь response shapes → error handling
   - Bug fix: воспроизведи баг → проверь фикс → регрессия
4. Адверсальные пробы (выбери подходящие):
   - Конкурентность: параллельные запросы → дубликаты? потерянные записи?
   - Граничные значения: 0, -1, "", очень длинные строки, unicode
   - Идемпотентность: повтори мутирующий запрос → дубликат создался?
5. Каждый чек: Command run + Output observed + Expected vs Actual
6. Финальная строка: VERDICT: PASS | FAIL | PARTIAL

Ты не подтверждаешь что код работает. Ты доказываешь что он НЕ работает.
```

**Интеграция в цикл:**

```
plan_exit (план утверждён)
  │
  ├─→ hook: plan_approved
  │     └─→ spawn verifier (background)
  │
  ├─→ исполнитель начинает работу по плану
  │
  └─→ verifier завершается
        ├─ PASS → результат принят
        ├─ FAIL → уведомление + возврат исполнителю
        └─ PARTIAL → только то что смогли + список не покрытого
```

**Почему не просто тесты:** тесты для реализации пишет та же LLM. Verification синт — независимая вторая пара глаз со свежим контекстом.

### AD-032: Хранение истории сессий

**Решение:** нормализованная модель «сессия → сообщения → части» с parent-child связями.

**Контекст:** Claude Code хранит историю в плоских JSONL-файлах (`~/.claude/transcripts/{sessionId}.jsonl`), саб-агенты — в sidechain. Это просто, но не даёт parent-child связей и запросов между сессиями. OpenCode использует нормализованную модель с parent_id — лучшая основа для командной работы.

**Логическая модель:**

```
Сессия (id, parent_id, project_id, agent, title, ...)
  │
  ├── parent_id → Сессия (parent-child дерево)
  ├── plan_path → путь к plan-файлу
  ├── branch_point → точка развилки для дочерних веток
  │
  └─1:N──→ Сообщение (id, session_id, seq, role, content, origin, source_msg_id, ...)
              │
              ├── seq — порядковый номер, уникален внутри сессии
              ├── origin: local | inherited | merged | crosspost
              ├── source_msg_id → Сообщение (откуда пришло)
              │
              └─1:N──→ Часть (id, message_id, type, data)
                          ├── type: text | tool_use | tool_result | reasoning
                          └── data — содержимое блока
```

**Ключевые сущности:**

| Сущность | Назначение |
|---|---|
| **Сессия** | Контейнер диалога. Имеет `parent_id` — дерево сессий. Хранит `agent`, `plan_path`, `branch_point` |
| **Сообщение** | Одна реплика (user/assistant/tool/system). Имеет `seq` — порядок внутри сессии. Имеет `origin` — откуда пришло |
| **Часть (part)** | Блок контента внутри сообщения: text, tool_use, tool_result, reasoning. Одно сообщение → много частей |
| **context_snapshot** | Сжатый контекст для summary-режима саб-агентов. Создаётся через отдельный LLM-вызов |

**Origin tracking — отслеживание происхождения сообщения:**

| origin | Как попало в сессию | source_msg_id |
|---|---|---|
| `local` | Создано в этой сессии (дефолт) | NULL |
| `inherited` | Унаследовано от родительской сессии (ветвление) | ID оригинального сообщения |
| `merged` | Скопировано из другой сессии пользователем (smart paste) | ID оригинального сообщения |
| `crosspost` | Существует в нескольких сессиях одновременно | Синхронизировано |

**Способы хранения (физический уровень):**
- Целевое хранилище: **PostgreSQL** (нормализованная схема). Идём сразу в PostgreSQL — SQLite как промежуточный вариант не используется.
- Переход с JSON-файлов (AD-005) на PostgreSQL.

### AD-033: Ветвление сессий и межсессионное слияние ✅ Реализовано

**Кратко:** Три слоя: subagent result → ветвление (parent_id + branch_point) → merge (smart paste / reference / crosspost).
**Подробно:** [docs/arch_decisions/ad-033-session-branching-merge.md](./docs/arch_decisions/ad-033-session-branching-merge.md)

### Модель Runner

Раннер — мост между бэкендом и движками. Два режима: локальный (прямой доступ к ФС) и облачный (K8s pod, per-user).

Движки — stateless: история на бэкенде, на вход получают историю + новое сообщение + контекст.

### AD-034: Routing между моделями ✅ Реализовано

**Кратко:** Router: content-based, escalation by confidence, cost-aware; ProviderPool + Quality Check.
**Подробно:** [docs/arch_decisions/ad-034-model-routing.md](./docs/arch_decisions/ad-034-model-routing.md)

### AD-035: Micro-model first — дешёвый слой перед LLM ✅ Реализовано

**Кратко:** Двухуровневый каскад: микро-модель (rules/embedding/micro-LLM) → LLM fallback; порог confidence 0.8.
**Подробно:** [docs/arch_decisions/ad-035-micro-model-first.md](./docs/arch_decisions/ad-035-micro-model-first.md)

### AD-036: LLM Gateway — независимый слой безопасности ✅ Реализовано

**Кратко:** GatewayProvider оборачивает все LLM-вызовы; обфускация ⟦SYNTH_SECRET_N⟧ / block; rate limit; аудит JSONL.
**Подробно:** [docs/arch_decisions/ad-036-llm-gateway.md](./docs/arch_decisions/ad-036-llm-gateway.md)

### AD-037: Security step перед коммитом

**Решение:** гарантированная security-проверка между генерацией кода и коммитом. Три слоя: инструмент `git_commit` с security-сабагентом (основная проверка), git pre-commit hook с маркером-хешем (железная гарантия), автоустановка хука при открытии сессии. Управляется настройками, по умолчанию включено.

**Контекст:** LLM-агент недетерминирован — нельзя полагаться, что он вызовет security-сабагента перед коммитом или не закоммитит через shell в обход инструмента. Гарантию даёт не агент, а уровень git: pre-commit hook, который невозможно обойти, потому что он срабатывает при любом `git commit` — и через инструмент, и через shell.

**Принципы:**
- **По умолчанию включено.** Контроль безопасности репозиториев активен, пока не выключен в настройках
- **Настройка:** глобальный тумблер вкл/выкл (только ADMIN), аналогично шлюзу безопасности
- **Гарантия на уровне git**, а не на уровне агента

**Три слоя:**

```
agent
 ├─ git_commit (инструмент)
 │    ├─ вызывает security-сабагента
 │    ├─ Critical/High → возврат на генерацию с фидбеком
 │    ├─ Medium/Low → пропуск с warning в логе
 │    ├─ OK → пишет маркер .synth/security-checked.json
 │    │       { hash: sha256(staged files), verdict, timestamp }
 │    └─ коммит
 │
 ├─ shell: git commit ← даже если пойдёт сюда, git запустит hook!
 │
 ▼
git pre-commit hook (уровень git, обойти нельзя)
 ├─ считает sha256 staged-файлов
 ├─ сравнивает с маркером
 ├─ совпало  → коммит разрешён
 └─ не совпало → БЛОК + stderr:
       "SECURITY CHECK REQUIRED: run /security-check before commit"
       (агент видит это как ошибку git commit → обязан отреагировать)
```

**Маркер-хеш (самопротухающий флаг):**

| Поле | Назначение |
|---|---|
| `hash` | sha256(staged files) — что именно проверяли |
| `verdict` | PASS / WARN (Medium/Low) |
| `timestamp` | когда проверяли |

Инвалидация **автоматическая**: любое изменение файлов после проверки меняет хеш → hook считает проверку недействительной. Никто не снимает флаг вручную — он самопротухает фактом изменения кода.

**Автоустановка хука:**

```
Открытие сессии в проекте
  → раннер сканирует проект на git-репозитории (их может быть несколько)
  → для каждого: проверяет наличие .git/hooks/pre-commit
  → если нет — устанавливает guard
  → генерирует событие repo.guard_installed / repo.guard_ok для каждого репозитория
```

Установка не зависит от воли LLM — выполняется системой при старте сессии. Хук самодостаточен: живёт в `.git/hooks/`, работает при каждом коммите, не требует запущенного агента.

**Инструмент `repo_setup` (переустановка):**
- Для случаев, когда репозиторий появился после старта сессии (агент клонировал новый)
- Переустановка guard, если он был удалён
- Ручной контроль: `synth repo guard install`

**Закрытие обходов:**

| Обход | Что ловит |
|---|---|
| Агент не вызвал сабагента | Маркера нет → hook блокирует |
| Агент закоммитил через shell | Hook срабатывает — он на уровне git |
| Файлы изменены после проверки | Хеш не совпал → маркер протух → блок |
| Несколько репозиториев в проекте | Guard ставится в каждый при старте сессии |

**Без дублирования:** hook не вызывает LLM — он только считает sha256 (микросекунды) и сравнивает с маркером. Проверка одна (в инструменте `git_commit`), hook лишь удостоверяет артефакт.

**Статическая часть hook (опционально):**
- gitleaks / secret-scan / eslint-security — детерминированные проверки без LLM
- Выполняются мгновенно вместе с проверкой маркера

**Порядок реализации:**
1. Инструмент `git_commit` + security-сабагент (основная проверка)
2. Маркер `.synth/security-checked.json` + запись после проверки
3. Pre-commit hook: sha256 staged → сравнение → блок/разрешение
4. Автоустановка при старте сессии + события `repo.guard_*`
5. Инструмент `repo_setup` для переустановки
6. Настройка: глобальный тумблер (по умолчанию включено)
7. Тесты: 3 задачи с небезопасным кодом (токен, логирование, API-запрос)

**Что не делаем в демо:**
- Фильтры shell-команд (`bash: "git commit*": deny`) — расширение AD-029, отдельной задачей
- Статический анализ в hook (gitleaks) — опционально, по желанию
- Подпись маркера ключом (достаточно хеша)

### AD-038: Монорепо как набор публикуемых npm-пакетов ✅ Реализовано

**Кратко:** 6 пакетов публикуются независимо (shared→core→ui→backend→runner→synth); @itphx/synth — тонкая обёртка; pnpm publish.
**Подробно:** [docs/arch_decisions/ad-038-npm-packages.md](./docs/arch_decisions/ad-038-npm-packages.md)

### AD-039: План — в проекте, todo — в сессии, состояние через инструменты (замена TSM) ✅ Реализовано

**Кратко:** План в project.plan (kanban), todo в session.todos; инструменты plan_*/todo_*; отменяет AD-002, переопределяет AD-027.
**Подробно:** [docs/arch_decisions/ad-039-plan-in-project.md](./docs/arch_decisions/ad-039-plan-in-project.md)

### AD-040: Сессии без проекта и перенос между проектами ✅ Реализовано

**Кратко:** projectId опционален; контекстный блок сессии; project_create/project_attach; перенос с session.moved.
**Подробно:** [docs/arch_decisions/ad-040-sessions-without-project.md](./docs/arch_decisions/ad-040-sessions-without-project.md)

### Отказ от JSON-блока

Механизм JSON-блока (модель возвращает JSON со статусом в конце ответа) не перенесён из прототипа. Причины: хрупкий парсинг, трата токенов, загрязнение промпта. Замена: Tool Use / Function Calling — состояние, план и todo управляются инструментами (см. AD-039).

### AD-041: Единая таксономия ошибок LLM + контракт локализации строк движка ✅ Реализовано

**Кратко:** classifyLlmError + isLlmErrorRecoverable — единый источник; контракт ENGINE_MESSAGE_KEYS (201) в shared/i18n; автопроверка синхронизации.
**Подробно:** [docs/arch_decisions/ad-041-llm-error-taxonomy.md](./docs/arch_decisions/ad-041-llm-error-taxonomy.md)

### AD-042: Гибридный режим — локальный core + централизованный сервер ✅ Реализовано

**Кратко:** Локальный core + сервер K3s: агрегация миров remote:<id>, LLM Proxy, RemoteEventBridge, publish/fork (аутентификация/единая личность — AD-043).
**Подробно:** [docs/arch_decisions/ad-042-hybrid-mode.md](./docs/arch_decisions/ad-042-hybrid-mode.md)

### AD-043: Единая идентичность гибрида — вход в UI без Keycloak-ритуала ✅ Реализовано

**Кратко:** Runtime-подключение (RemoteConnection) + вход в UI по логину/паролю (ROPC «за кулисами»), дискавери IdP с сервера (`GET /auth/oidc-meta`), единая личность (cookie v2, роли/профиль/админка — с сервера), старт без device flow; public-клиент `synth-cli`.
**Подробно:** [docs/arch_decisions/ad-043-unified-identity-login.md](./docs/arch_decisions/ad-043-unified-identity-login.md)

### AD-045: Профили серверов и лёгкий runtime-вход в гибриде — единый dataDir ✅ Реализовано

**Кратко:** Вход всегда лёгкий (runtime, без рестарта/exit 77/409): один процесс подключается к любому серверу на лету; локальные данные — единый dataDir; profiles.json — мета-реестр (knownServers/lastServer); credentials — единый мульти-серверный файл; logout = disconnect + забыть токен + best-effort revoke refresh-токена на IdP (RFC 7009); ConnectionWatcher.
**Подробно:** [docs/arch_decisions/ad-045-hybrid-server-profiles.md](./docs/arch_decisions/ad-045-hybrid-server-profiles.md)

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

// 3. @itphx/synth-shared
import { type Session } from '@itphx/synth-shared';

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

### Роутинг задач по агентам

При получении задачи определи её тип и переключись на соответствующего агента
(через Tab или @mention):

| Тип задачи | Агент | Пример промпта |
|---|---|---|
| **Bug fix** | `@fixer` | «Почини баг: при логине с неверным паролем падает 500 вместо 401» |
| **Тестирование / QA** | `@tester` | «Проверь что модуль auth не сломан после изменений», «Прогони smoke-сценарии через Playwright» |
| **Исследование / консультация** | `@researcher` | «Как устроена авторизация?», «Найди все места где используется Redis» |

Эти агенты уже настроены и готовы к работе. Не дублируй их инструкции — просто
передавай задачу.

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

## Рабочий каталог и инструменты

### Рабочий каталог по умолчанию

Рабочий каталог для file/shell/git-тулов по умолчанию:

```
env SYNTH_DEFAULT_WORKSPACE > config storage.defaultWorkspace > {DATA}/workspaces/default
```

- Runtime override: `PUT /api/v2/settings/workspace` — хранится в `{dataDir}/settings.json` (атомарная запись, переживает рестарт)
- Резолвинг в `_resolveWorkingDir`: `project.workspace` → defaultWorkingDir
- Проектные/плановые тулы (`plan_enter`, `plan_exit`, `get_project_info`, `list_repos`) жёстко привязаны к `project.workspace`/сессии — не принимают path-параметры от агента

### Встроенные инструменты

| Группа | Тулы |
|---|---|
| Файлы (чтение) | `read_file`, `list_directory`, `glob` |
| Файлы (запись) | `write_file`, `edit_file`, `create_directory`, `delete_file` |
| Поиск | `grep_files`, `glob` |
| Shell | `execute_shell` |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_branch_list`, `git_show`, `git_blame`, `git_stash` |
| План/ToDo | `plan_enter`, `plan_exit`, `plan_read`, `plan_list`, `plan_write`, `todo_write`, `todo_list`, `todo_add`, `todo_update`, `todo_delete` |
| Проект | `get_project_info`, `list_repos`, `project_create`, `project_attach` |
| Лог/Инварианты | `project_log_write`, `project_log_read`, `project_invariants_read`, `project_invariants_write` |
| Веб | `web_fetch`, `web_search` (DuckDuckGo, при anti-bot — fallback на Bing) |
| Задачи | `task`, `classify_conversation`, `read_session_reference` |

Доступность по группам задаётся в `ToolCapability` (`@itphx/synth-shared`); MCP-инструменты регистрируются с префиксом `{serverName}_{toolName}` и подчиняются настройкам режимов (см. AD-029).

---

## UI: панель «Сессия»

Вкладка «Сессия» в правой панели показывает план (`planContent`) и ToDo (`todos`) текущей сессии. Обновляются по WS-событиям `plan.approved` / `todos.updated` (полный refresh сессии с сервера).

---

## UI: мобильный адаптив + PWA

Единый адаптивный интерфейс (не отдельное мобильное дерево). Три зоны по ширине окна:
**телефон ≤768px / планшет 769–1199px / десктоп ≥1200px** (десктоп не изменяется).
Детекция через `matchMedia` + классы на `<html>`: `device-phone/tablet/desktop`, `pointer-coarse`
(хуки `useDevice()`/`useMediaQuery`, модуль `lib/device.ts`); весь мобильный CSS гейтится этими классами.

- **Раскладка на телефоне/планшете:** чат на весь экран; левая и правая панели — оверлей-дроверы
  (`components/layout/MobileDrawer.tsx`), управление из мобильного хедера; `ResizeHandle` скрыт.
  Нижней навигации нет. Мобильное состояние панелей (`mobileLeftOpen/RightOpen`) не персистится
  в десктопные ширины.
- **Touch-first:** hover-действия доступны на таче (CSS под `html.pointer-coarse`), touch-таргеты ≥40px,
  нативные скроллбары на таче, нативный `drag&drop` в деревьях отключён на таче.
- **Подтверждения:** `window.confirm` → `ConfirmDialog`; для zustand-сторов — глобальный сервис
  (`lib/confirm.ts` + `stores/confirmStore.ts`, рендер в `App`).
- **Модалки/админка:** `SettingsModal`/`LogsModal` на телефоне — категории в горизонтальные скролл-табы,
  контент на всю ширину; табличные админ-панели (например `ModelsPanel`) — горизонтальный скролл.
- **Клавиатура:** `useKeyboardInset` (visualViewport → `--kb-inset` → `padding-bottom` композера);
  Enter на таче = перенос строки, на fine-pointer — отправка; IME учтён.
- **PWA (ручной app-shell, без vite-plugin-pwa):** `public/manifest.webmanifest` (standalone, theme `#09090b`),
  `public/sw.js` (runtime-кэш шела; `/api,/ws,/auth,/admin,/health` не кэшируются; навигация network-first →
  офлайн-заглушка), иконки 192/512/maskable/apple в `public/icons/`; меты в `index.html`
  (manifest, theme-color, apple-touch-icon, apple-mobile-web-app-*, viewport-fit=cover);
  `usePwaInstall` + `PwaInstallButton` (`beforeinstallprompt`); регистрация SW только в prod.
- **Раздача:** `docker/nginx-ui.conf` (MIME `.webmanifest` + no-cache для `/sw.js`/`/manifest.webmanifest`)
  и `packages/core/src/server/app.ts` (MIME `.webmanifest` + no-cache для sw/manifest).
- **Фикс логина:** в гибридном режиме (standalone-core, эндпоинт `/hybrid/status`
  ответил и enabled=true) поле «Сервер» (адрес) показывается ВСЕГДА — при протухшем
  токене можно сменить адрес; предзаполняется lastServer/backendUrl, варианты из
  knownServers. На managed-бэкенде (нет `/hybrid/status` → hybridEnabled=false)
  поле скрыто;
  Enter в «Логин» → фокус на «Пароль».

Подробности и мотивация — [AD-044](./docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md).

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

### Скрипты (в `synth/scripts/`)

| Скрипт | Назначение |
|--------|------------|
| `build.sh` | Полная сборка: shared → core → ui → synth. Опции: `--clean`, `--check`, `--docker`, `--docker-tag=X` |
| `publish.sh` | Публикация в npm. Опции: `--dry-run`, `--no-build`, `--registry=both\|npmjs\|gitverse`, `--docker` |
| `version-bump.sh` | Bump версии: `./version-bump.sh patch\|minor\|major\|X.Y.Z`. Обновляет `version.ts` + все `package.json` |
| `dev.sh` | Dev-запуск: backend (:5000) + UI (:5002). Аргументы: `backend\|ui\|core\|all` |
| `changelog.sh` | Генерация CHANGELOG.md из коммитов между тегами (используется в CI release) |
| `micro-benchmark.mjs` | Бенчмарк микро-слоя AD-035 (25 запросов, таблица + сводка) |

### Версионирование

Единая константа `SYNTH_VERSION` в `packages/shared/src/version.ts`.
Текущая версия: из `packages/synth/package.json`.

При bump-е версии обновляются:
1. `packages/shared/src/version.ts` — константа `SYNTH_VERSION`
2. `packages/*/package.json` — поле `version` во всех 6 пакетах

Все hardcoded строки версии в коде заменены на импорт `SYNTH_VERSION` из `@itphx/synth-shared`.

### Публикация npm

Публикуются **все 6 пакетов** монорепозитория в строгом порядке зависимостей:

```
shared → core → ui → backend → runner → synth
```

Для публикации используется **`pnpm publish`** (а не `npm publish`), т.к. он
автоматически переписывает `workspace:*` в зависимостях на фактические версии
workspace-пакетов — опубликованные пакеты корректно резолвятся npm-потребителями.

Два реестра:
- `https://registry.npmjs.org` — токен `NPM_TOKEN`
- `https://gitverse.ru/api/packages/itphx/npm/` — токен `GV_TOKEN` (единый для всего GitVerse)

#### Токены npmjs (важно, изменения npm 2026)

С 2026 года npm ужесточил требования к публикации (см.
[changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)):

- **Старые классические токены без 2FA отозваны.** Для публикации нужен либо
  **Granular Access Token (GAT) с включённой 2FA** (права `publish` только на
  нужные пакеты `@itphx/*`, `@itphx/*`), либо классический токен при включённой
  на аккаунте 2FA.
- **Токены с `bypass 2FA` больше не публикуют напрямую** (с января 2027 — только
  staged publishing с ручным 2FA-подтверждением). Поэтому при создании токена
  НЕ выбирать «bypass 2FA» — использовать обычный GAT.
- **npm v12 (latest)**: `allowScripts`/`--allow-git`/`--allow-remote` выключены
  по умолчанию. Если при установке пакета нужны lifecycle-скрипты — использовать
  `npm approve-scripts`/`--allow-scripts`.
- Долгосрочно npm рекомендует **trusted publishing (OIDC)** или **staged
  publishing**; для GitVerse-CI пока используется GAT в секрете `NPM_TOKEN`.

Проверка токена: `npm whoami --registry https://registry.npmjs.org`.

### Docker

Образ собирается из npm-публикации: `npm install -g @itphx/synth@<version>`
(зависимости `@itphx/synth-core`/`@itphx/synth-ui`/`@itphx/synth-shared` ставятся как транзитивные
npm-зависимости, промпты и UI резолвятся из node_modules) — **не** из
workspace-сборки. Dockerfile: `docker/Dockerfile` (контекст — корень репозитория,
`.dockerignore` в корне). Образ: `gitverse.ru/itphx/synth:<version>` (latest).
Токен: `GV_TOKEN`.

### Helm-чарт

Чарт приложения — `charts/synth/` в монорепозитории. Версия чарта и `appVersion` равны
версии релиза: при bump в CI (`version-bump` в `release.yaml`) они обновляются вместе с
`version.ts` и `package.json`.

Реестр — **нативный Helm-реестр GitVerse** (не OCI):

```
https://gitverse.ru/api/packages/itphx/helm
```

Публикация (в CI — job `publish-helm` в `release.yaml`):

```bash
helm package charts/synth --version <version> --app-version <version> --destination dist/helm
curl --user "itphx:$GV_TOKEN" -X POST \
  --upload-file dist/helm/synth-<version>.tgz \
  https://gitverse.ru/api/packages/itphx/helm/api/charts
```

Установка:

```bash
helm repo add synth https://gitverse.ru/api/packages/itphx/helm
helm repo update
helm install synth synth/synth --version <version> -f my-values.yaml
```

Кастомные values хранятся в каталоге `secrets/` (вне git-репозитория `synth/`), пример — `charts/synth/values.example.yaml`.

---

## CI/CD (GitVerse)

### Workflow-файлы

| Файл | Назначение | Триггер |
|------|------------|---------|
| `.gitverse/workflows/ci.yaml` | CI: typecheck, lint, тесты, `helm lint` | `push`, `pull_request` |
| `.gitverse/workflows/release.yaml` | Релиз: bump, сборка, npm, Docker, Helm, Release | `workflow_dispatch`, `push tags v*` |

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
pnpm --filter @itphx/synth-shared build    # обязательно перед typecheck!
pnpm --filter @itphx/synth-core build      # нужно для backend и runner
pnpm typecheck                       # рекурсивно по всем пакетам
pnpm lint
pnpm test
```

Без сборки `shared` и `core` перед `typecheck` — `@itphx/synth-runner` и `@itphx/synth-backend` не найдут типы.

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
| `docs/HYBRID.md` | Гибридный режим: требования, архитектура, статус |
| `archive/AGENTS_OLD.md` | Архив: deprecated AD, Python/FastAPI стек |
| `SPEC.md` | Спецификация функциональности |
| `rbac-design.md` | Дизайн RBAC |
