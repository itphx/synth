# Synth — архитектурные соглашения

> Здесь только то, что нужно постоянно; подробности — в `docs/`, `docs/arch_decisions/`, `.opencode/skills/`; трогаешь подсистему — сначала таблица «Куда смотреть (триггеры)». Правила ведения решений и жизненный цикл документов — [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md); предложения и сроки — [docs/roadmap.md](./docs/roadmap.md).

## Язык

Все сообщения, коммиты и документация — **на русском**. Не коммитить без явной просьбы пользователя.

Русский — канонический язык документации. Для публичного GitHub-зеркала поддерживаются EN-версии: `README.en.md` в корне и спецификации в `docs/en/`. Терминология — [`docs/en/GLOSSARY.md`](./docs/en/GLOSSARY.md); при расхождении с англоязычными строками продукта (UI `packages/ui/src/lib/i18n/messages/en.ts`, движок `packages/core/src/engine/system-messages.ts`) приоритет у продукта.

Меняешь RU-документ, у которого есть EN-версия — обнови EN в том же коммите. Если перевод отстаёт осознанно — пометь расхождение в шапке EN-файла строкой вида `> ⚠️ RU-версия обновлена <дата>; перевод отстаёт`.

## Инварианты (не нарушать)

1. План — в `project.plan`, todo — в `session.todos`; состояние менять только инструментами `plan_*`/`todo_*`, не файлами (ADR-039).
2. Хранилище — только через порты слоя хранения (`StorageContext`, ADR-096); файловая реализация — `FileStore`/`JsonStore` (JSON + атомарная запись tmp→rename, ADR-005); писать в `$SYNTH_DATA_DIR` в обход порта нельзя. Исключение: фикс самого хранилища / миграция схемы.
3. Любой LLM-вызов — через `GatewayProvider` (guard, обфускация, rate limit, аудит); провайдера напрямую не дёргать (ADR-036).
4. Движки stateless: история и состояние — на бэкенде; движок получает историю + новое сообщение + контекст (ADR-022).
5. Permissions и режимы — только через permission-слой (`plan`/`act`/`yolo`, `allow`/`deny`/`ask`); не хардкодить проверки в тулах (ADR-025/ADR-028/ADR-029).
6. Транспорт UI — EventHub + TransportClient (`/ws/events`) с фоллбеком на SSE; новых каналов не плодить (ADR-008/ADR-009/ADR-024).
7. Гибрид: id удалённых сущностей — `remote:<uuid>`, маршрутизация по полю `origin`; id не смешивать (ADR-042).
8. Проект — контейнер (сессии, файлы, контекст); `projectId` опционален — сессия может жить без проекта (ADR-014/ADR-040).
9. Ошибки LLM — через `classifyLlmError`/`isLlmErrorRecoverable`; строки движка — через ключи `shared/i18n` (ADR-041).
10. Конфиг — приоритет CLI-флаги > `SYNTH_*` env > config.yaml > defaults; читать только через `@itphx/synth-shared/config` (ADR-023).
11. Состояние агента передаётся через Tool Use, а не JSON-блоком в ответе модели (ADR-039).
12. Коммит — только по явной просьбе пользователя. Новые зависимости/инструменты — только с разрешения.
13. Секреты (токены, ключи, пароли) — не коммитить и не писать открытым текстом в журнал задач и документацию (только плейсхолдеры); секреты живут в `secrets/` вне git-репозитория `synth/`.
14. AGENTS.md (корневой и пакетные) держать в актуальном состоянии: изменил поведение пакета/процесс/окружение — обнови соответствующий файл; правки инструкций согласовывать с пользователем; процедура — скилл `synth-agents-md`.
15. Создание сессии — только через единый funnel `RequestSessionService` → `EventRouter` (явный запрос — `direct`, внешнее событие — через Router); `SessionManager.createSession` — materialization-примитив (fork/import/материализация события), для прямых запросов его не вызывать (ADR-089).
16. Доступ к ресурсу с идентификатором проверяется **на границе**, а не в обработчике: сессия — единый prefix-guard `server/session-access-guard.ts` (вешается на `/:id` и `/:id/*` вместе с `requireAuth`, вид доступа `read`/`write` выводится из HTTP-метода). Дублирующих проверок внутри обработчиков нет — иначе правила расходятся (дважды: ложный 403 у `LEAD` на части `:id`-маршрутов). Матрица — `packages/backend/src/routes/session-idor-matrix.test.ts`.
17. На нетривиальный security-фикс — инвариант и матрица тестов: негативная **и** положительная (владелец/участник проекта/`ADMIN`/`LEAD`/`AUDITOR`/чужой), плюс тест-перепись по смонтированному приложению — падает при появлении `:id`-маршрута вне матрицы (`session-idor-matrix.test.ts`).
18. Уведомление хаба (WS/SSE) — инвариант: **путь, создающий сессию, публикует `session.created`** (в собственный канал — для импорта/переноса проекта/роутов, в канал родителя — для дочерней сессии саб-агента), а хабы подписывают владельца сами, без правки в каждом месте. Детект события — общий шов `packages/core/src/events/child-session.ts` (`extractChildSessionId`/`extractCreatedSession`): им пользуются и managed `EventHub`, и standalone `/ws/events` (`EventWebSocketSubscriptions` — авто-подписка по `session.created`/`child.*`, форвард первого кадра не подписанному заранее владельцу); `forkProjectToLocal` (`remote/transfer.ts`) публикует `session.created` сам. Точечные колбэки (`onSessionMaterialized`/`onSessionCreated`/`onSessionForked`) сохранены лишь как идемпотентные ускорители подписки до publish. Подписка строго по владельцу (нет владельца — fail-closed), событие доставляется после подписки (ADR-089).
19. Внешний отправитель в standalone нормализуется к локальному пользователю (`local`): владелец сессии — человек, а в single-user инстансе человек один; внешний id (`tg:<id>`) остаётся для routing/привязок/metadata (`createExternalIdentityResolver`, опция `localUserId`).
20. Перед релизом — обязательный внутренний аудит безопасности: гейт `security-gate` в `release.yaml` не пропустит сборку без содержательной записи аудита релизуемой версии (`docs/security/releases/<version>.json`: каждая проверка с `command`+`result`); прогон ведёт роль-аудитор по `docs/security/AUDIT-CHECKLIST.md` (политика — `docs/security/README.md`).
21. Роли участника проекта: `VIEWER` читает, `EDITOR`/`OWNER` мутирует (`canReadProject` vs `canEditProjectContent`); read-уровень доступа **не** расширяет права на изменение (применяется и к доступу по id сессии, и к FS/проектным роутам).

## Карта репозитория

Монорепозиторий `synth/` (pnpm workspaces), единый стек TypeScript. Подробности по пакету — в `packages/<pkg>/AGENTS.md` (есть у `core`, `backend`, `ui`, `shared`; короткий — у `sdk`; у тонкой `synth` — нет).

```text
synth/
├── packages/
│   ├── shared/    @itphx/synth-shared   # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/      @itphx/synth-core     # Ядро: сессии, очередь, LLM, MCP, FileStore, API v2 (Hono), CLI
│   ├── backend/   @itphx/synth-backend  # Hono API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
│   ├── ui/        @itphx/synth-ui       # React 19 SPA + админка (Vite)
│   ├── sdk/       @itphx/synth-sdk      # Типизированный клиент публичного API (ADR-052)
│   └── synth/     @itphx/synth          # Публикуемая CLI-обёртка (bin: synth)
├── pnpm-workspace.yaml   tsconfig.base.json   eslint.config.js   .prettierrc
docs/                  # Документация (см. «Документация»)
docs/arch_decisions/   # ADR/PROP (см. индекс)
.opencode/skills/      # Скиллы (synth-dev, synth-release, synth-hybrid, ...)
tmp/                   # Временные файлы. Использовать его, а не /tmp в корне ФС. Не коммитится
```

Все 6 пакетов публикуются в npm; `@itphx/synth` — тонкая CLI-обёртка над core/ui/shared: не бандлит core в `cli.js` (external) и не копирует ассеты — всё резолвится из npm-зависимостей (ADR-038). `@itphx/synth-sdk` — самостоятельный клиент публичного API (зависит только от shared).

**Слой хранения (ADR-096).** Домен работает через доменные порты (`packages/core/src/storage/ports/*`), а физический backend взаимозаменяем: `storage/memory/*` (in-memory, герметичные тесты), `FileStore`/`JsonStore` и прочие файловые реализации (default), БД — следующий шаг (PROP-032). Точка сборки — `packages/core/src/storage/storage-context.ts` (`createFileStorage`/`createMemoryStorage`/`createStorageContext`); выбор через `storage.backend` (`file`|`memory`; env `SYNTH_STORAGE_BACKEND`). Контракт любой реализации («паспорт порта») — suite `packages/core/src/storage/contract/*`. Конфиг-словари (провайдеры/модели/агенты) — порт `DocumentRepository<T>`.

### Слои зависимостей

```text
@itphx/synth-shared  ←  контракты + межупаковочная инфраструктура, без бизнес-логики
       ↑
@itphx/synth-core    ←  импортирует shared, содержит всю общую логику
       ↑
┌──────┴──────┐
@itphx/synth-backend │ @itphx/synth-ui     ←  импортируют core
       ↑
@itphx/synth-sdk   ←  клиент публичного API: shared (ADR-052)
@itphx/synth   ←  тонкая CLI-обёртка: core + ui + shared (npm-потребители)
```

**Переиспользуемые роуты.** Общая логика HTTP-роутов живёт в core-фабриках (`createSettingsRoutes`, `createDictionaryRoutes`, `createProviderRoutes`, `createModelRoutes`, `createSessionRoutes`, `createProjectRoutes`, `createFsRoutes`, `createMessageRoutes`, `createQueueRoutes`, `createAgentRoutes`, `createMcpRoutes`); backend монтирует их и добавляет только RBAC/rate-limit/специфику через `opts` (guard'ы, `messages` для i18n, хуки). Дублировать хендлеры в backend нельзя.

## Команды

Из корня `synth/`:

```bash
./scripts/dev.sh                    # backend (:5000) + UI (:5002)
./scripts/dev.sh backend | ui | core | all
./scripts/standalone.sh             # standalone из собранных npm-пакетов (см. DEVELOPMENT.md)

pnpm install                # установка зависимостей
pnpm build                  # сборка всех пакетов
pnpm typecheck              # проверка типов
pnpm lint                   # ESLint
pnpm test                   # Vitest
pnpm clean                  # очистка dist/
```

**Обслуживание инстанса** (runbook — [docs/MAINTENANCE.md](./docs/MAINTENANCE.md)):

```bash
synth doctor                 # health инстанса (--json) — ADR-091
synth backup --out <dir>     # архив каталога данных (--with-secrets|--with-workspace|--live) — ADR-091
synth restore <archive>      # восстановление (--dry-run|--yes|--no-safety-copy) — ADR-091
synth migrate                # миграции схемы данных (--dry-run|--yes) — ADR-092
synth uninstall              # удаление инстанса (--purge|--dry-run|--yes; по умолчанию данные сохраняются) — ADR-092
```

Тот же контур доступен из UI (Настройки → «Обслуживание», только ADMIN) и по admin-API `/api/v2/maintenance/*` (managed — `ADMIN`, core — `requireAuth`); восстановление — **офлайн-операция** (применяется при следующем старте, `appliesOnNextStart`). Процедуры — [docs/MAINTENANCE.md](./docs/MAINTENANCE.md); спека — [docs/API_V2.md](./docs/API_V2.md) §5.31.

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/` — это **fallback для Docker**; источник истины промптов — `packages/core/prompts` (публикуется в npm через `files`), дубликатов ассетов нет (ADR-038). Логи dev-запуска: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`.

## Порты

| Сервис | Порт | Env var |
|--------|------|---------|
| synth-backend | 5000 | `SYNTH_PORT` |
| synth-ui | 5002 | `VITE_PORT` |
| synth-core | 4300 | `SYNTH_CORE_PORT` |
| opencode (движок) | 4100 | — |
| cline (движок) | 4200 | — |

## Окружение

### Запуск

`./scripts/dev.sh [backend|ui|core|all]` из `synth/` (или `./synth/scripts/dev.sh` из корня проекта). Скрипт ставит: `SYNTH_AUTH_DEBUG=true` (debug-аутентификация), `SYNTH_DATA_DIR` (по умолчанию `<repo>/../data`; переопределяется env), `SYNTH_PORT`/`SYNTH_CORE_PORT`/`VITE_PORT`, а также `SYNTH_CONFIG=packages/backend/config.yaml` (только если файл существует) — поэтому `mcp.servers` из backend-конфига подхватываются в dev; `loadConfig` учитывает `SYNTH_CONFIG` (ADR-023). Подробности — [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

### Данные

Runtime-данные (сессии, проекты, провайдеры, модели) — в `$SYNTH_DATA_DIR` (env `SYNTH_DATA_DIR` или `storage.dataDir` в config.yaml; дефолт `/var/synth/data`). Провайдеры — JSON в `$SYNTH_DATA_DIR/providers/`, модели — в `$SYNTH_DATA_DIR/models/`; добавить провайдера/модель = создать JSON-файл (или через API). Атомарная запись: `.tmp.{uuid}` → `rename()`. Основные dev-провайдеры (`itphx`, `ollama`) — в [docs/LLM_PROVIDERS.md](./docs/LLM_PROVIDERS.md).

```text
$SYNTH_DATA_DIR/ → sessions/ projects/ providers/ models/ agents/ context/ auth/(sessions,states,profiles) secrets/(master.key, api-key, ssh-keys/)
```

**Локальный home** (`--home <dir>` / env `SYNTH_HOME`, ADR-079) — базовый каталог локального инстанса с плоской раскладкой `<home>/{config.yaml, data/, profiles.json, credentials.json}`. Приоритет путей: явные флаги (`--data-dir`/`--config`/`--profiles`/`--credentials`) > `--home` > `SYNTH_HOME` > XDG-дефолты (`~/.config/synth`, `~/.local/share/synth`). Без home поведение прежнее; разные home → независимые инстансы (standalone и hybrid одновременно) и герметичный тестовый запуск.

**Ротация мастер-ключа** секретов at-rest (SSH-ключи агентов, ADR-076): `synth secrets rotate` (`--data-dir`, `--config`, `--old-key`/`--old-key-file`, `--new-key`/`--new-key-file`, `--dry-run`, `--yes`). Без `--yes` (и без `--dry-run`) — отказ; при ключе из env/`config.security.secretKey` его нужно обновить и там (файл игнорируется при старте).

### Аутентификация

Все API (кроме `GET /health`) требуют аутентификации, иначе 401. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`; middleware `requireAuth`, `requirePermission` (первый в цепочке после CORS/logging).

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | тестовые ключи (ниже) |
| API Key | backend | прод без OIDC | `SYNTH_API_KEY` → ADMIN |
| OIDC | backend | прод с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve` (`--api-key`/`SYNTH_API_KEY`/`core.apiKey`; иначе авто-ключ в `{dataDir}/secrets/api-key`; host `127.0.0.1`) | один ключ → ADMIN (в гибриде — роли с сервера) |
| Service-key | оба | машинный доступ (ADR-052) | `Authorization: Bearer synth_svc_…` → синтетический пользователь `{id:'service:<keyId>', roles}` + `scopes`/`allowedProjects`; revoked/expired/unknown → 401 |

**Service-key (ADR-052, этап I).** Scoped-ключ инстанса для внешних сервисов; независим от binding-key (ADR-089). Роли ключа совместимы с `requirePermission`, `scopes` — точечный гейт (`requireScope`, только для service-key): `events:ingest|watch`, `bindings:read|write`, `keys:read|write`, `routes:read|write`, `sessions:create|read|prompt`, `schedules:read|write`, `llm:chat`, `addons:install` (зонтичный: установка/обновление MCP-реестра и скиллов), `users:read` (чтение пользователей/идентичностей машинной кредой) + wildcard-семейства (`events:*`, …; глобального `*` нет). На части роутов (запись реестра MCP/скиллов, чтение админского user-API) scope работает как альтернатива роли ADMIN — guard `requireAdminOrScope` (backend). `allowedProjects` — проектная проекция (sessions/events-bindings/schedules; иначе 403 `PROJECT_FORBIDDEN`). CRUD — `/api/v2/service-keys` (managed — ADMIN, core — `requireAuth`), store `{dataDir}/service-keys.json`, секрет `synth_svc_<base64url>` (at-rest sha256, plaintext один раз). Провижининг installer-ключа без ручного API — `security.bootstrapServiceKeys` (или env `SYNTH_BOOTSTRAP_SERVICE_KEYS` с JSON, приоритетнее config.yaml): идемпотентно (`created`/`updated`/`unchanged`) при старте core/backend, секрет не логируется; в Helm-чарте — опция `installerKey` (Secret + env). Детали — `docs/API_V2.md` §5.28, `docs/CONFIGURATION.md`, `charts/synth/README.md`.

### Тестовые пользователи (debug)

Базовый URL: `http://localhost:5000/api/v2`, заголовок `Authorization: Bearer <ключ>`.

| Пользователь | Ключ | Роли |
|-------------|------|------|
| admin | admin-key-123 | ADMIN |
| developer | user-key-456 | USER |
| lead | lead-key-789 | LEAD |
| auditor | auditor-key-012 | AUDITOR |

### Runtime-настройки (API)

| Метод/путь | Назначение |
|---|---|
| `PATCH /api/v2/sessions/:id` `{ mode }` | Режим сессии: `plan` / `act` / `yolo` |
| `POST /api/v2/sessions/:id/abort` | Надёжный «Стоп» (ADR-005): персистентный флаг `SessionStatus.cancelRequested` (+`cancelRequestedAt`) под локом; при живом `currentStream` — graceful `orchestrator.cancel` (`stream.cancelled` + частичный ответ), затем остановка процессора очереди (сброс `pendingMessages`/`blocked`/флага, `stream.cancelled` ровно один раз); процессора нет — флаг снимается. Ответ `{status:'aborted'}`; без сессии — 404 |
| `GET/PUT /api/v2/settings/workspace` | Рабочий каталог по умолчанию (runtime override, `settings.json`) |
| `GET/PUT/DELETE /api/v2/settings/workspace-policy` | Политика абсолютного workspace вне `workspacesRoot` (`confirm`/`deny`; managed — read-only `deny`) |
| `GET/PUT /api/v2/settings/mcp` | Доступность MCP-инструментов по режимам (plan/act) |
| `GET/PUT/DELETE /api/v2/settings/skills` | Instance-wide скиллы: мастер-отключение (`disabled`) и дефолт новых проектов (`disabledForNewProjects`), `policy` |
| `GET/PUT /api/v2/settings/tools-policy` | Политика встроенных инструментов (`consistency`/`available`/`auto`) |
| `GET/PUT /api/v2/settings/mcp-policy` | Политика MCP-инструментов (`consistency`/`available`/`auto`) |
| `GET/PUT /api/v2/settings/tools-disabled` | Instance-wide отключение встроенных инструментов (группы/тулы; `runtime` неотключаем) |
| `GET/PUT /api/v2/settings/default-agent` | Агент по умолчанию для новых сессий (fallback `assistant`; UI — раздел «Агенты») |
| `GET/PUT/DELETE /api/v2/settings/events` | Runtime-настройки раздела «События» (ADR-089): `enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`, `allowedSources`, `unknownAgentTemplate`, `keyRateLimitPerMinute`, `decisionRouting`, `autoBind`, `autoBindAgentTemplate`, `identityMap` (**override** поверх привязок профиля `ProfileData.identities[]`) (live; мутации — ADMIN в managed, core — `requireAuth`) |
| `GET/DELETE/POST /api/v2/me/identities` | Идентичности текущего пользователя (ADR-089): список внешних привязок профиля и отвязка (`DELETE .../:provider/:externalId`); только свои; привязка — claim-flow: `POST /identities/claim` `{code}` (одноразовый код из ingest'а, `identityHint`), 400/401/404/409 |
| `GET/PUT/DELETE /api/v2/settings/decision` | Runtime-настройки decision-слоя (ADR-084): `enabled`, `provider`, `model`, `confidenceThreshold`, `escalationProvider`/`escalationModel` (live; мутации — ADMIN в managed, core — `requireAuth`) |
| `GET/DELETE /api/v2/settings/decision/metrics` | Агрегатные метрики decision-слоя (ADR-084): `GET` — снимок `{metrics, ts}` (`requireAuth`), `DELETE` — сброс (`decisionWriteGuard`) |
| `GET/PUT /api/v2/mcp/registry` | Реестр MCP-серверов (`enabled` — мастер-флаг, `enabledByDefault` — дефолт новых проектов; stdio — только ADMIN; запись — ADMIN или service-key со scope `addons:install`, installer-ключ создаёт instance-записи) |
| `GET/PUT /api/v2/projects/:id/{mcp,skills}` и `GET/PUT /api/v2/sessions/:id/{mcp,skills}` | Уровни/скоуп MCP и скиллов (`enabled` — hard-gate, `defaultOn` — дефолт новых сессий; в сессии — снапшот) |
| `POST /api/v2/mcp/probe` | Проверка MCP-сервера без регистрации инструментов |
| `GET/POST /api/v2/service-keys`, `GET/PATCH/DELETE /api/v2/service-keys/:id`, `POST /api/v2/service-keys/:id/revoke` | Service-key (ADR-052, этап I): scoped-ключи инстанса — обязательная уникальная `label`, `roles`/`scopes`/`allowedProjects`/срок/лимит; секрет `synth_svc_…` отдаётся один раз (at-rest — sha256), аутентификация `Authorization: Bearer synth_svc_…`; RBAC managed — ADMIN, core — `requireAuth` |
| `POST /api/v2/events` | Приём внешнего события (ingest: `requireAuth` либо API-ключ привязки `Authorization: Bearer synth_evt_…` без пользовательских кред; rate limit; per-key лимит → 429; `events.enabled: false` → 503). Ответ `201 {event, decision, sessionId}` + опциональное `identityHint {code, expiresAt}` — одноразовый код подтверждения идентичности неизвестного отправителя (ADR-089 claim-flow) |
| `GET/POST /api/v2/webhooks`, `GET/PATCH/DELETE /api/v2/webhooks/:id`, `POST /api/v2/webhooks/:id/regenerate\|revoke\|test`, `GET /api/v2/webhooks/:id/deliveries` | Исходящие webhooks (ADR-052, этап II): подписки на события с обязательной уникальной `label`, `url` (https; SSRF-политика), `events` (паттерны exact/`prefix.*`), `enabled`; signing-секрет `whsec_…` отдаётся один раз (at-rest — шифрование мастер-ключом), `regenerate` — ротация, `revoke` — мягкое отключение, `test` — тестовая доставка, `deliveries` — журнал; `webhooks.enabled: false` → 503 на мутации/тест; RBAC managed — ADMIN, core — `requireAuth` |
| `GET/POST/DELETE /api/v2/events/bindings` | Биндинги событий источник→сессия (чтение — `requireAuth`, мутации — LEAD/ADMIN) |
| `GET/POST /api/v2/events/bindings/:id/keys`, `PATCH .../keys/:keyId`, `POST .../keys/:keyId/revoke`, `DELETE .../keys/:keyId` | API-ключи привязки (чтение/мутации — LEAD/ADMIN; `label` уникальна глобально, `description`/`expiresAt`/`rateLimitPerMinute`, мягкий отзыв; секрет отдаётся один раз, at-rest — sha256-хеш) |
| `GET/POST /api/v2/events/routes`, `DELETE /api/v2/events/routes/:id` | Правила маршрутизации событий (`match` → `target`; чтение — `requireAuth`, мутации — LEAD/ADMIN) |
| `GET /api/v2/events/journal` | Журнал решений Router (последние записи, `limit`; использование ключа — с `keyId`) |
| `GET/POST/DELETE /api/v2/schedules`, `PUT /api/v2/schedules/:id`, `POST /api/v2/schedules/:id/run`, `GET /api/v2/schedules/:id/jobs` | Расписания-источник `cron` (ADR-051): CRUD (обновление — `PUT`) + force-запуск + Job-история (чтение — `requireAuth`, мутации/`run` — ADMIN; `run` под rate limit) |

## Процесс разработки

### Стадии

Переход — только после критерия и явной команды пользователя (или молчаливого согласия).

1. **Investigate** — прочитать затронутые файлы, найти паттерны, задать вопросы. Не править код, не запускать сервер. *Критерий:* сформулированы файлы под правку и почему.
2. **Plan** — атомарный todo-список, оценка влияния на другие части, подтверждение пользователя. *Критерий:* пользователь подтвердил план (или сказал «приступай»).
3. **Implement** — строго по плану, минимальными правками, в код-стиле проекта. *Критерий:* `pnpm build` из `synth/` без ошибок.
4. **Verify** — по порядку: `pnpm typecheck` → `pnpm lint` → `pnpm test`; затем `./scripts/dev.sh backend` + curl затронутых эндпоинтов; затем `./scripts/dev.sh` (backend+UI) и визуальная проверка UI в браузере. Не ставить новые инструменты, не писать сложные bash-скрипты, не гонять LLM без просьбы, не писать в JSON-хранилище вручную (провайдер/модель — через API, сообщение — `POST /sessions/:id/prompt`). *Критерий:* typecheck+lint+test зелёные, эндпоинты отвечают ожидаемым кодом/форматом.
5. **Document** — обновить затронутые `AGENTS.md` (корневой и пакетные), если изменилось окружение/процессы/поведение пакета; неочевидные решения зафиксировать в задаче; правки инструкций согласовать с пользователем (скилл `synth-agents-md`). *Критерий:* готово к следующей сессии.

### Роутинг задач по агентам

| Тип задачи | Агент | Пример промпта |
|---|---|---|
| **Bug fix** | `@fixer` | «Почини баг: при логине с неверным паролем падает 500 вместо 401» |
| **Тестирование / QA** | `@tester` | «Проверь что модуль auth не сломан после изменений», «Прогони smoke-сценарии через Playwright» |
| **Исследование / консультация** | `@researcher` | «Как устроена авторизация?», «Найди все места где используется Redis» |

Агенты уже настроены — не дублируй их инструкции, просто передавай задачу.

### Типичные ошибки

1. Кодить без исследования — приводит к переделкам.
2. Автоматизация ради автоматизации — скрипт на 100 строк вместо 3 строк curl и визуальной проверки.
3. Ставить зависимости для тестирования — всё настроено; чего не хватает — сказать пользователю.
4. Запускать сервер вне `dev.sh` — порты и env уже настроены, свой способ не изобретать.
5. Писать в JSON-хранилище вручную — только через API (исключения: баг самого хранилища, миграция схемы).
6. Смешивать стадии — нельзя одновременно исследовать, кодить и тестировать.

### Тех. долг

Известные архитектурные долги — не блокируют работу, закрываются отдельными задачами. Запись ведётся здесь; при закрытии пункт удаляется; детали задач и закрытые пункты — `.opencode/tasks/log.md`.

Актуальных задокументированных долгов нет.

### Unit-тесты

Vitest:

```bash
cd synth && pnpm test
cd synth/packages/core && pnpm test -- --run src/engine/tools/task.test.ts
```

## Соглашения по коду

### Именование (TypeScript, strict)

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

## Рабочий каталог и инструменты

Рабочий каталог для file/shell/git-тулов по умолчанию:

```text
env SYNTH_DEFAULT_WORKSPACE > config storage.defaultWorkspace > {DATA}/workspaces/default
```

- Runtime override: `PUT /api/v2/settings/workspace` → `{dataDir}/settings.json` (атомарно, переживает рестарт).
- Резолвинг `_resolveWorkingDir`: `project.workspace` → defaultWorkingDir; каталог проектного workspace создаётся автоматически (`mkdir -p`).
- Каталог `project.workspace` (ADR-075): managed — авто-имя `slugify(name)`+суффикс под `workspacesRoot`, смена workspace — владелец/LEAD/ADMIN; standalone — нормализация/создание + ручной выбор через FS-диалог. Путь вне `workspacesRoot` — по политике `storage.workspaceOutsideRoot` / `/api/v2/settings/workspace-policy` (`confirm` в standalone, `deny` в managed — read-only).
- Доступ к workspace по HTTP (ADR-075, `createFsRoutes`): ручной выбор корня — только standalone; в managed (`requireProjectId`) `/api/v2/fs/workspace-root*` отдают **403 `FORBIDDEN`** всем ролям (каталог проекта авто-провижнится, перечень управляемых workspace не раскрывается). `POST /api/v2/fs/upload` — лимит размера (по умолчанию 100 МиБ, `DEFAULT_MAX_UPLOAD_BYTES`, переопределяется опцией `FsRoutesOptions.maxUploadBytes`), превышение → `413 PAYLOAD_TOO_LARGE`.
- Тулы `plan_enter`, `plan_exit`, `get_project_info`, `list_repos` жёстко привязаны к `project.workspace`/сессии — path-параметры не принимают.
- Тулы `project_update`/`project_workspace_set`/`project_repo_clone|init|add|fetch|remove` работают с проектом сессии (подставить id/path другого проекта агент не может); смена workspace идёт через общий provisioning (`engine/workspace-provision.ts`) с политикой `workspaceOutsideRoot` — той же, что у HTTP-роута.
- Гейт `workspace` (ADR-075): file/shell/git-тулы доступны только при заданном `project.workspace`; иначе остаются в промпте, но permission-слой отклоняет их с причиной `workspace` (`engine/permission/availability.ts`, `isWorkspaceDependentTool`), а модели уходит схлопнутая подсказка. Относительные пути — только внутри `project.workspace`. После `project_create`/`project_attach`/`project_workspace_set` оркестратор перечитывает готовность workspace в том же ходе и разблокирует тулы.
- Git-тулы (ADR-076) принимают необязательный `repo_path` — относительный путь внутри `project.workspace` (containment; абсолютный/`..` → `git.repo_path_invalid`); `list_repos` отдаёт записи реестра `project.repos` (`destination`/`name`/`url`/`type`/`sshKeyId`/`lastFetch` + git-детект). SSH-ключи per-agent хранятся зашифрованными (`secrets/ssh-keys/`), мастер-ключ — `SYNTH_SECRET_KEY`/`security.secretKey`/`secrets/master.key`.

| Группа | Тулы |
|---|---|
| Файлы (чтение) | `read_file`, `list_directory`, `glob` |
| Файлы (запись) | `write_file`, `edit_file`, `create_directory`, `delete_file` |
| Поиск | `grep_files`, `glob` |
| Shell | `execute_shell` |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_branch_list`, `git_show`, `git_blame`, `git_stash` |
| План/ToDo | `plan_enter`, `plan_exit`, `plan_read`, `plan_list`, `plan_write`, `todo_write`, `todo_list`, `todo_add`, `todo_update`, `todo_delete` |
| Проект | `get_project_info`, `list_repos`, `project_create`, `project_attach`, `project_update`, `project_workspace_set`, `project_repo_clone`, `project_repo_init`, `project_repo_add`, `project_repo_fetch`, `project_repo_remove` |
| Лог/Инварианты | `project_log_write`, `project_log_read`, `project_invariants_read`, `project_invariants_write` |
| Веб | `web_fetch`, `web_search` (DuckDuckGo, при anti-bot — fallback на Bing) |
| Задачи | `task`, `classify_conversation`, `read_session_reference` |
| Профиль | `profile_update` (capability `user` — выдан только Агенту `assistant`; онбординг владельца сессии: `display_name`/`email`/`phone`/`notes`, завершение интервью — `ProfileData.interviewCompleted`) |
| Скиллы | `skill` (ADR-046: загрузка тела `SKILL.md` по имени + supporting-файлы; глобально отключается через `tools.disabled`) |

Доступность групп — в `ToolCapability` (`@itphx/synth-shared`); группа `user` (тул `profile_update`, только Агент `assistant`) отключаемая — админ может снять её через `tools.disabled`; MCP-тулы регистрируются как `{serverName}_{toolName}`, подчиняются режимам (ADR-029) и выбираются **per-session** — в промпт идут только тулы активных серверов сессии. Слои разделены: `tools` — встроенные, `mcp.tools`/`mcp.servers`/`mcp.status` — MCP (всегда `volatile`) (ADR-071).

**Онбординг-интервью.** Блок `[INTERVIEW]` (`prompts/system/INTERVIEW.{lang}.md`) включается только в **первое сообщение сессии от пользователя** и при **незаполненном** профиле: флаг `interviewEligible` вычисляет оркестратор (`_interviewEligible` — первое «разговорное» сообщение, не `Scheduler`/системное, **и** `profile_update` доступен текущему агенту — capability `user` и тул не отключён админом; иначе fail-closed), `ContextBuilder` дополнительно проверяет `ProfileData.interviewCompleted`; `session.settings.showInterview` — мастер-выключатель. Агент проводит интервью и сохраняет ответы тулом `profile_update`. Статус — отдельное поле `ProfileData.interviewCompleted` (legacy-метка `[ИНТЕРВЬЮ]` в `notes` бэкфиллится в `FileProfileStore` при чтении).

## Внешние события и хуки

Реализация — `engine/hooks/` (ADR-030) и `engine/events/` (ADR-089); обоснования, альтернативы и открытые вопросы — в самих AD (не дублируются).

- **Хуки (ADR-030).** `HookBus` (`engine/hooks/hook-bus.ts`) — ядровый in-process примитив, отдельный от session-`EventBus`: `on/off/emit/emitAsync`, priority, `sync` (pre, blockable/patch) и `async` (post, fire-and-forget + timeout 5s). Эмиты: `pre_tool_use`, `post_tool_use`, `plan_approved`, `permission_denied`, `agent_spawned/completed/failed`, `session_start`/`session_end` (в т.ч. при архивации).
- **Внешние события (ADR-089).** `EventRouter`: порядок `allowedSources` → dedup → `EventBinding` → `RouteRuleProvider` → фоллбек (при `events.autoBind` и `identity.chatKey|threadKey` — `{kind:'bind'}`; иначе по `events.defaultMode`: `bound` → `drop no_route`, `ephemeral` → временная сессия). `EventIngress` — ingest/нормализация, `EventDelivery` — `run`/`defer`, `DecisionRuleProvider` (ADR-084) — decision-шаг при `events.decisionRouting` (fail-safe). Хранилища: `{dataDir}/events/{bindings.json, journal.jsonl, routes.json, api-keys.json}`.
- **Единый funnel (инвариант 15).** Создание сессии — только через `RequestSessionService` (explicit → `direct` + hook `session_requested`; внешнее → hook `external_event` → Router); `forkSession`/backend `/import`/`remote/transfer.ts` — materialization, не request. `agentTemplate` резолвится через `AgentRegistry` (политика `unknownAgentTemplate` `drop`/`default-agent`); событийная сессия без явного шаблона получает агент по умолчанию инстанса (`deps.resolveDefaultAgent`).
- **Ключи (ADR-089/ADR-052).** Несколько API-ключей привязки на `EventBinding`: обязательная глобально уникальная `label`, `description?`/`expiresAt?`/`revokedAt?`/`rateLimitPerMinute?`; секрет `synth_evt_<base64url>` — at-rest sha256, plaintext один раз; per-key лимит (`KeyRateLimiter`, окно 60 c) → 429 `RATE_LIMITED`. **binding-key** (жёстко привязан к source/чату привязки) ≠ **service-key** (ADR-052: `scopes` + `allowedProjects`). Ключи инстанс-локальные (не переносятся publish/fork). RBAC managed: мутации bindings/routes и чтение keys — LEAD/ADMIN.
- **Runtime-настройки «События» (ADR-089).** `GET/PUT/DELETE /api/v2/settings/events` (`RuntimeSettings.events` + `mergeEventsConfig`): `enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`, `allowedSources`, `unknownAgentTemplate`, `keyRateLimitPerMinute`, `decisionRouting`, `autoBind`, `autoBindAgentTemplate`, `identityMap` (override поверх `ProfileData.identities[]`). Live через `EventRouter.updateConfig`/`RequestSessionService.updateConfig`; `enabled: false` → ingest 503. Retention журнала — `startEventJournalPruner` (prune на старте и каждые 6 ч).
- **Владелец и attribution (ADR-089).** Владелец — человек (`principalId`), а не чат: `deps.resolveExternalIdentity` (override `events.identityMap` → профиль `identities[]` → чат-fallback) → per-event владелец → `resolveOwnerId` (standalone — `local`); в standalone сопознанный отправитель нормализуется к `local` (`createExternalIdentityResolver` с `localUserId`) — иначе владельцем становился профильный UUID и сессия выпадала из `listSessions({ userId })`/WS-подписки. Funnel уведомляет хаб (`deps.onSessionMaterialized` → `EventHub.subscribeToSession`) **до** доставки события (ускоритель; основу держит авто-подписка хабов по `session.created` — инвариант 18); при доставке в существующую сессию `_maybeReassignOwner` меняет только пустого/машинного владельца (`service:<keyId>`), «чужой человеческий» не трогает. В `metadata` — `principal_id`/`chat_key`/`thread_key`, `author` из `payload.from`; cron — `Scheduler`.
- **Права внешних отправителей (ADR-089).** База — роли **профиля** Synth отправителя; `identity.roles` (allowlist шлюза, напр. `GATEWAY_ALLOWLIST=chatId:ROLE`) только **сужают** (пересечение), не повышают; несопознанный отправитель прав Synth не имеет (fail-closed). Считает `resolveEffectiveRoles` (`engine/events/identity-roles.ts`); `metadata.effective_roles`/`identity_linked` — для аудита/attribution. Роль-оси в permission-слое нет и не планируется (ADR-029).
- **Видимость сессий и проектов (ADR-089).** Личные сессии — владельцу; сессии проекта — владельцу проекта и любому участнику; без владельца — видны; `ADMIN`/`LEAD` — сквозной обзор. Проекты: `canRead` — owner/член/LEAD/ADMIN, но `manage`/`edit` **не** расширяются (VIEWER читает, не редактирует). Хелпер — `core/server/session-visibility.ts`; правила — `docs/API_V2.md` §5.5/§5.8.
- **Ephemeral TTL.** `Session.expiresAt`/`archivedAt`; `sessions/ephemeral.ts` (`parseTtl` `30s|15m|24h|7d`, sweep 60 c); `listSessions`/`listActiveSessions` по умолчанию исключают архив.
- **Источник cron (ADR-051).** `engine/scheduler/`: `SchedulerService` (тикер `unref`, `dedupKey = cron:<id>:<минута>`, `runNow`), `SchedulerRuleProvider` (→ `bound`/`queue`/`ephemeral` по `Schedule.target`), `ScheduleStore` (`{dataDir}/schedules.json`), Job-история (`{dataDir}/scheduler/jobs.jsonl`, retention `scheduler.jobRetentionDays`). Публикует `{source:'cron', type:'schedule_fired'}` через `EventIngress` (сессии сам не создаёт). Сообщение: `author='Scheduler'`, `metadata.scheduler/schedule_name`; системные блоки `scheduler`/`scheduler.turn` (`prompts/system/SCHEDULER*.md`). Мульти-инстанс (leader election, dedup-claim, межпроцессная сериализация) — семы/file-based, default OFF.
- **Webhooks (ADR-052, этап II).** `engine/webhooks/`: `WebhookService` (фильтр `matchWebhookEvent`, HMAC-SHA256, retry/backoff с джиттером, дедуп, журнал), `network.ts` (`evaluateWebhookTarget` — https + запрет private/loopback), `prune.ts`. Store `{dataDir}/webhooks/subscriptions.json` (signing-секрет `whsec_…` — AES-256-GCM at-rest), журнал `deliveries.jsonl`. Формат подписи — `docs/API_V2.md` §5.29.
- **Конфиг.** Секции `events` (+ `dedupStore`), `webhooks` (`enabled` default `false`, `maxAttempts`, `timeoutMs`, `allowPrivateTargets`, `deliveryRetentionDays`), `decision` (ADR-084: `enabled`, `provider`, `model` — `decision`/`systemone`, `confidenceThreshold`, `escalationProvider`/`escalationModel`; env `SYNTH_DECISION_PROVIDER`/`SYNTH_DECISION_MODEL`), `scheduler` (`enabled`, `tickSec`, `catchUp`, `jobRetentionDays`, `leaderElection`, `crossProcessLocks`). i18n: `event.*`, `hook.blocked`. Флаги мульти-инстанс — default **OFF**.
- **API и UI.** Полный список эндпоинтов (events/bindings/keys/routes/journal/webhooks/schedules/settings) — в таблице «Runtime-настройки (API)» выше; RBAC и коды — `docs/API_V2.md`. UI: пользовательский раздел «События» (просмотр всем ролям, создание — LEAD/ADMIN), админ-секция «Параметры событий», вкладка «Шедулер»; журнал дублируется в «Логи и аудит».

## UI-конвенции

Подробности, точки расширения и правила компонентов — [packages/ui/AGENTS.md](./packages/ui/AGENTS.md); панель настроек и контролы — ADR-072.

- Панель «Сессия» в правой панели показывает план (`planContent`) и ToDo (`todos`); обновляется по WS-событиям `plan.approved`/`todos.updated` (полный refresh с сервера).
- Мутирующие тулы ядра публикуют `fs.changed` (`engine/fs-change.ts`): дерево Files, открытые редакторы и Git-вкладка обновляются с debounce; события несут `op` (`write`/`delete`/`mkdir`/`move` с `from`/`to`), дерево перечитывает только родительские каталоги, редактор уходит в `file.deletedOnDisk`. Read-only тулы событий не шлют.
- Перенос/переименование (`filesStore.moveEntry`, DnD и диалог) перемапливает поддерево (`treesByProject`/`expandedDirs`/`fileRevisions`/`deletedFiles`/`draftContents`) и открытые вкладки (`useUIStore.remapFileTabs`), сохраняя несохранённые черновики; `op:'move'` из shell ремапится синхронно до debounce. Межпроектный перенос — серверный `/fs/move` с `targetProjectId` (не read/write/delete-хаком).
- Перенос сессии между проектами (`session.moved`, в т.ч. `project_create`/`project_attach` агентом) обновляет `project_id` в сторе, список проектов и дерево Files.
- Вкладки Files/Git левой панели контекст-ориентированы: блок «Текущий проект» (хук `useActiveProject`) + сворачиваемые «Другие проекты (N)»; тумблер `ProjectScopeToggle` (persist `onlyActiveProject`).

### Иконки и цвета проектов и сессий

Ключи — реестры `PROJECT_ICON_KEYS` (37) и `PROJECT_COLOR_KEYS` (16, палитра темы `a1..a16`) в `shared/types` (дефолтные `folder`/`chat`/`cpu`): на записи значения валидируются (иначе 400 `VALIDATION_ERROR`), при чтении невалидные сбрасываются (`normalizeIconKey`/`normalizeColorKey`). В UI — пикер `EntityIconPicker` и вывод `<Icon>`; у закрытых сессий иконка серая, у открытых — цвет сессии. Подробности — [packages/ui/AGENTS.md](./packages/ui/AGENTS.md), [packages/shared/AGENTS.md](./packages/shared/AGENTS.md).

### Мобильный адаптив + PWA

Три зоны: **телефон ≤768px / планшет 769–1199px / десктоп ≥1200px** (десктоп не меняется). Детекция `matchMedia` + классы на `<html>`: `device-phone/tablet/desktop`, `pointer-coarse` (хуки `useDevice()`/`useMediaQuery`, `lib/device.ts`); мобильный CSS гейтится этими классами. На телефоне/планшете чат на весь экран, панели — оверлей-дроверы (`components/layout/MobileDrawer.tsx`), touch-first (таргеты ≥40px, DnD в деревьях выключен), `window.confirm` → `ConfirmDialog` (`lib/confirm.ts` + `confirmStore`), клавиатура — `useKeyboardInset` (Enter на таче — перенос строки, на fine-pointer — отправка). PWA — ручной app-shell без vite-plugin-pwa (`public/manifest.webmanifest`, `public/sw.js`; SW только в prod), обновление — баннер `PwaUpdatePrompt`. Фикс логина: в гибриде поле «Сервер» показывается всегда (lastServer/backendUrl, варианты knownServers), на managed-бэкенде скрыто. Детали — [ADR-044](./docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md) и [packages/ui/AGENTS.md](./packages/ui/AGENTS.md).

## Среды и деплой

| Среда | Что это | Как разворачивается |
|---|---|---|
| **dev** | локальная отладка | `./scripts/dev.sh` |
| **test** | внутренний тестовый, `https://synth.k3s.itphx.loc` | Fleet (`synth-deploy`): образы собираются локально и пушатся в `git.itphx.ru`, чарты публикуются в Helm-реестр Gitea (`synth-deploy/scripts/build-and-publish.sh`); Fleet разворачивает бандлы `synth-test` и `synth-gateway-telegram` |
| **preprod** | `https://synth-release.k3s.itphx.loc`, проверка развёртывания | публикуемый Helm-чарт (GitVerse), релизные образы `gitverse.ru` |
| **prod** | у нас отсутствует — разворачивают клиенты сами | публикуемый Helm-чарт (self-host) |

Правило: текущие изменения — **dev**; проверка перед релизом — **test** (Fleet); релиз — push master → сборка пакетов → **preprod**.

### K3s (test)

Test-инстанс — K3s (Rancher Fleet), namespace `synth`; код деплоя — отдельный репозиторий `synth-deploy/` (`https://git.itphx.ru/itphx/synth-deploy.git`, ветка `main`, подробности — `synth-deploy/README.md` и `synth-deploy/AGENTS.md`). Адреса: UI `https://synth.k3s.itphx.loc`, Keycloak issuer `https://keycloak.itphx.loc/realms/synth` (клиент `synth`, confidential), backend в кластере `synth-backend:5000`. Доступ: `kubectl` (контекст `local`), `kubectl -n synth get pods`, `kubectl -n synth logs deploy/synth-backend`. Учётные данные Keycloak — [docs/KEYCLOAK.md](./docs/KEYCLOAK.md); секреты (в т.ч. client secret `SYNTH_OIDC_CLIENT_SECRET` в SealedSecret `synth-secrets`) — в `secrets/` вне git-репозитория `synth/`. Скилл — `synth-k3s-deploy`.

Деплой собран из двух бандлов `synth-deploy/{test,gateway-telegram}` (бандлы/релизы `synth-test` и `synth-gateway-telegram`); чарты в репозитории не хранятся — они публикуются в приватный Helm-реестр Gitea (`synth-deploy/scripts/build-and-publish.sh`) и тянутся Fleet по `helm.repo/chart/version` (предпосылки: Secret `helm-gitea` в `fleet-local` и поля GitRepo `paths`/`helmSecretName`/`helmRepoURLRegex`). Данные PVC переживают снятие бандла/релиза только при `persistence.keepOnUninstall: true` (ручной `kubectl annotate` живого PVC не помогает — Helm смотрит манифест релиза).

### GitVerse CI — особенности

1. **`actions/setup-node@v4`** — не использовать; вместо него `npm install -g pnpm@latest`.
2. **`${{ env.VAR }}`** — не работает, резолвится в Go-строку `%!t(string=...)`; значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает; сложный bash выносить в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub; в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`.
5. Версия Node.js в раннере — 22 (предустановлена).
6. **Префикс `GITVERSE_` запрещён** в именах секретов; использовать `GV_`.

Порядок сборки в CI: `pnpm install --frozen-lockfile` → `pnpm --filter @itphx/synth-shared build` (обязательно перед typecheck) → `pnpm --filter @itphx/synth-core build` (нужно для backend) → `pnpm typecheck` → `pnpm lint` → `pnpm test`. Без сборки shared/core typecheck не найдёт типы.

**Сборка и публикация — только по тегу релиза** (`release.yaml`), обычный push — тесты кода, доковые пуши — отдельный лёгкий workflow. Ручной запуск релиза сохранён: `workflow_dispatch` в `release.yaml`.

**GitHub — зеркало и релизы, без Actions.** В репозитории нет ни одного GitHub workflow: всё собирает CI GitVerse, а GitHub получает уже готовое (джоба `publish-github` в `release.yaml` — push `main`+теги, GitHub Release, ассеты best-effort). Базовые образы (`synth`, `synth-backend`, `synth-ui`) публикуются в `gitverse.ru` и `ghcr.io` (только версионный тег); лимит размера артефактов ~500 МБ касается будущих дополнительных/full-образов (flavor-образы PROP-082), они пойдут только в Docker Hub. Локальный backfill — `scripts/release-github.sh`; подробности — [docs/PUBLISHING.md](./docs/PUBLISHING.md) §«Релиз в GitHub-зеркале».

| Workflow | Триггер | Что делает |
|---|---|---|
| `.gitverse/workflows/release.yaml` | push тега `v*` + `workflow_dispatch` | **сборка и публикация**: bump → CI-проверки → **`security-gate` (обязательный внутренний аудит: запись релизуемой версии + негативная матрица авторизации + secret-scan дерева/истории + ратчет зависимостей; в `build.needs`)** → build → CHANGELOG → npmjs/GitVerse npm → Docker (kaniko → `gitverse.ru` + `ghcr.io` для базовых `synth`/`synth-backend`/`synth-ui`) → Helm-чарт → GitVerse Release → GitHub-зеркало (`main`+теги, GitHub Release) |
| `.gitverse/workflows/ci.yaml` | push в `main`/`master`/`feature/**`/`fix/**`/`refactor/**`/`chore/**`/`docs/**` и PR; `paths-ignore`: `docs/**`, `**/*.md`, `README.md`, `LICENSE`, `.gitignore`, `.gitverse/**`, `.github/**` | тесты кода: typecheck + lint, тесты `shared`/`core`/`backend`/`ui`/`sdk`, `helm lint` + template, `secret-scan` (дерево + история, **блокирующая**), `pnpm audit --audit-level=high` (report-only) + ратчет уязвимостей дельтой к baseline (report-only) |
| `.gitverse/workflows/ci-docs.yaml` | push в `main`/`master`/`feature/**` и PR, `paths`: `docs/**`, `**/*.md`, `AGENTS.md`, `packages/*/AGENTS.md`, `scripts/{adr-check,docs-link-check}.mjs`, `scripts/security-gate.mjs`, `docs/security/**` | лёгкая проверка доков: `node scripts/adr-check.mjs` (индекс/статусы ADR/PROP) + `node scripts/docs-link-check.mjs` (относительные ссылки) + `node scripts/security-gate.mjs --lint-records` (записи аудита) — зависимостей нет, pnpm не ставится |

**Внутренний аудит безопасности — обязательный гейт релиза.** Джоба `security-gate` в `release.yaml` идёт до сборки артефактов и блокирует её без записи аудита для релизуемой версии (`docs/security/releases/<version>.json`; fail-closed при неопределяемой версии, waiver-статусов нет). Она же прогоняет secret-scan дерева и всей истории (`scripts/secret-scan.mjs`) и ратчет уязвимостей зависимостей (`docs/security/policy.json`); `pnpm audit` в обычном CI остаётся report-only (этапы ужесточения — `docs/security/README.md`). Локально: `pnpm security:scan` (дерево + история), `pnpm security:gate` (гейт), `pnpm security:records` (проверка записей).

Секреты: `NPM_TOKEN` (npmjs.org), `GV_TOKEN` (единый GitVerse: API, Docker/npm registry, git push), `GH_TOKEN` (GitHub-зеркало и релизы: classic PAT со scope `repo`+`write:packages`; опционально `GHCR_USER` — логин для ghcr.io). Локальная проверка перед пушем: `pnpm typecheck && pnpm lint && pnpm test`; для правок доков — `node scripts/adr-check.mjs && node scripts/docs-link-check.mjs`. Публикация (npm в 6 пакетов, Docker/Helm, релиз, токены npm 2026, `scripts/build.sh`/`publish.sh`/`version-bump.sh`) — [docs/PUBLISHING.md](./docs/PUBLISHING.md) и скиллы `synth-build-publish`, `synth-release`.

## Индекс решений и предложений (ADR / PROP)

Таблица собирается скриптом: `pnpm adr:write` (`node scripts/adr-check.mjs --write`), проверка — `pnpm adr:check`. Статусы — канонические токены, правила ведения — [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md), предложения и сроки — [docs/roadmap.md](./docs/roadmap.md).

<!-- ad-index:start -->
| ID | Суть | Статус | Файл |
|----|------|--------|------|
| ADR-005 | JSON-файлы как хранилище (атомарная запись tmp + rename) | ✅ Реализовано | [adr-005](./docs/arch_decisions/adr-005-json-storage.md) |
| ADR-008 | WebSocket для real-time событий | ✅ Реализовано | [adr-008](./docs/arch_decisions/adr-008-websocket-events.md) |
| ADR-009 | SessionEventBus — шина событий сессии | ✅ Реализовано | [adr-009](./docs/arch_decisions/adr-009-session-event-bus.md) |
| ADR-014 | Проект как контейнер (сессии, файлы, контекст) | ✅ Реализовано | [adr-014](./docs/arch_decisions/adr-014-project-container.md) |
| ADR-017 | Собственный API-контракт (API v2 на Hono) | ✅ Реализовано | [adr-017](./docs/arch_decisions/adr-017-api-v2-hono.md) |
| ADR-018 | Выбор AI-движка на уровне сессии (поле `Session.engine`); адаптеры движков (Runner) — PROP-050 | ⚠️ Частично | [adr-018](./docs/arch_decisions/adr-018-session-engine-selection.md) |
| ADR-019 | React 19 SPA с нуля | ✅ Реализовано | [adr-019](./docs/arch_decisions/adr-019-react-spa.md) |
| ADR-022 | Единый TypeScript стек; Runner-архитектура (мост к движкам) — план (ADR-018/PROP-050), движки stateless | ✅ Реализовано | [adr-022](./docs/arch_decisions/adr-022-typescript-stack-runner.md) |
| ADR-023 | Единая система конфигурации (`@itphx/synth-shared/config`) | ✅ Реализовано | [adr-023](./docs/arch_decisions/adr-023-configuration.md) |
| ADR-024 | Единый транспорт: EventHub (backend) + TransportClient (UI) | ✅ Реализовано | [adr-024](./docs/arch_decisions/adr-024-eventhub-transport.md) |
| ADR-025 | Plan/Act как глобальный permission toggle (не отдельные агенты) | ✅ Реализовано | [adr-025](./docs/arch_decisions/adr-025-plan-act-toggle.md) |
| ADR-026 | Режимы контекста саб-агента: none / inherit / summary / last_n | ✅ Реализовано | [adr-026](./docs/arch_decisions/adr-026-subagent-context-modes.md) |
| ADR-028 | Строгость цикла Plan→Build: auto / strict / off | ✅ Реализовано | [adr-028](./docs/arch_decisions/adr-028-plan-build-strictness.md) |
| ADR-029 | Гранулярные permissions: allow/deny/ask per tool + file patterns | ✅ Реализовано | [adr-029](./docs/arch_decisions/adr-029-granular-permissions.md) |
| ADR-030 | Hooks для событий агента: hook-шина `HookBus` + эмиты жизненного цикла (pre/post tool use, session, plan, spawn); фундамент внешних событий (ADR-089) и интеграций (ADR-051/052/086/087); Plugin SDK — PROP-090 | ⚠️ Частично | [adr-030](./docs/arch_decisions/adr-030-hooks-agent-events.md) |
| PROP-031 | Verification синт (аналог VerificationAgent из Claude Code) | 🧩 Предложение | [prop-031](./docs/arch_decisions/prop-031-verification-agent.md) |
| PROP-032 | Второй вариант хранения — БД (PostgreSQL) за единым слоем (порты/контрактный suite — ADR-096) | 🧩 Предложение | [prop-032](./docs/arch_decisions/prop-032-history-storage-postgresql.md) |
| ADR-033 | Ветвление сессий, наследование контекста и межсессионное слияние | ✅ Реализовано | [adr-033](./docs/arch_decisions/adr-033-session-branching-merge.md) |
| ADR-034 | Routing между моделями (content + confidence + cost) | ✅ Реализовано | [adr-034](./docs/arch_decisions/adr-034-model-routing.md) |
| ADR-035 | Micro-model first: дешёвый слой перед LLM (правила/embedding) | ✅ Реализовано | [adr-035](./docs/arch_decisions/adr-035-micro-model-first.md) |
| ADR-036 | LLM Gateway: независимый слой безопасности (guard + обфускация + rate limit + аудит) | ✅ Реализовано | [adr-036](./docs/arch_decisions/adr-036-llm-gateway.md) |
| PROP-037 | Security step перед коммитом: git pre-commit hook + маркер-хеш | 🧩 Предложение | [prop-037](./docs/arch_decisions/prop-037-commit-security-step.md) |
| ADR-038 | Монорепо как набор публикуемых npm-пакетов (6 пакетов, pnpm publish, тонкая CLI-обёртка) | ✅ Реализовано | [adr-038](./docs/arch_decisions/adr-038-npm-packages.md) |
| ADR-039 | План — в проекте, todo — в сессии; состояние — через инструменты (Tool Use, без JSON-блока), замена TSM | ✅ Реализовано | [adr-039](./docs/arch_decisions/adr-039-plan-in-project.md) |
| ADR-040 | Сессии без проекта: контекст, подсказка, перенос между проектами | ✅ Реализовано | [adr-040](./docs/arch_decisions/adr-040-sessions-without-project.md) |
| ADR-041 | Таксономия ошибок LLM + контракт локализации строк движка (`shared/i18n`) | ✅ Реализовано | [adr-041](./docs/arch_decisions/adr-041-llm-error-taxonomy.md) |
| ADR-042 | Гибридный режим: локальный core + сервер (агрегация миров, LLM Proxy, RemoteEventBridge, publish/fork) | ✅ Реализовано | [adr-042](./docs/arch_decisions/adr-042-hybrid-mode.md) |
| ADR-043 | Единая идентичность гибрида: вход в UI без Keycloak (runtime, ROPC, дискавери oidc-meta) | ✅ Реализовано | [adr-043](./docs/arch_decisions/adr-043-unified-identity-login.md) |
| ADR-044 | Адаптивный мобильный UI + PWA (три зоны, дроверы, touch-first, ручной app-shell) | ✅ Реализовано | [adr-044](./docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md) |
| ADR-045 | Профили серверов и лёгкий runtime-вход в гибриде (единый dataDir, profiles.json, logout = забыть токен + revoke, ConnectionWatcher) | ✅ Реализовано | [adr-045](./docs/arch_decisions/adr-045-hybrid-server-profiles.md) |
| ADR-046 | Скиллы и slash-команды: формат SKILL.md, discovery, progressive disclosure, core-тул skill, команды/bundles, scope-API, UI (настройки/панели/статистика/`/`-автокомплит); остаток — install/trust/подписи и backend-админка каталога (PROP-068) | ⚠️ Частично | [adr-046](./docs/arch_decisions/adr-046-skills-and-slash-commands.md) |
| PROP-047 | Память Synth (Gbrain + композиция): storage backbone, RAG по памяти и коду/докам, компрессия tool output, 4-layer retrieval, Obsidian bridge | 🧩 Предложение (vision) | [prop-047](./docs/arch_decisions/prop-047-memory-gbrain.md) |
| PROP-048 | Self-help скиллы и admin-MCP: dogfooding-развёртывание, runbook-скиллы, read-only status-MCP, deploy-тулы, гейтинг ADMIN | 🧩 Предложение | [prop-048](./docs/arch_decisions/prop-048-self-help-skills-admin-mcp.md) |
| PROP-049 | Git worktrees: тулы `git_worktree_*`, per-session cwd на базе worktree, детект secondary worktree, UI | 🧩 Предложение | [prop-049](./docs/arch_decisions/prop-049-git-worktrees.md) |
| PROP-050 | Внешние движки (opencode/cline) — Runner: EngineManager, адаптеры, WS-канал backend↔runner, LLM Proxy :9090, маршрутизация по `Session.engine` | 🧩 Предложение | [prop-050](./docs/arch_decisions/prop-050-external-engines-runner.md) |
| ADR-051 | Шедулер и пайплайны (облегчённый n8n): `SchedulerService`, cron/interval-источник `schedule_fired` через Router (ADR-089), API/UI расписаний; Job-история, catch-up, force-run — да; семы/file-based мульти-инстанс — default OFF; пайплайны (PROP-059) и гибрид-размещение — нет | ⚠️ Частично | [adr-051](./docs/arch_decisions/adr-051-scheduler-pipelines.md) |
| ADR-052 | Публичная API-платформа: per-service **service-key** со **scopes** + **проектной проекцией** (`allowedProjects`), public-**OpenAPI**, **SDK**, **webhooks**; **tenants исключены** (self-host: изоляция = инстанс, группировка = проект, ADR-014); этапы I–IV закрыты 2026-10-13 | ✅ Реализовано | [adr-052](./docs/arch_decisions/adr-052-public-api-platform.md) |
| PROP-053 | CLI и TUI: паритет публикуемого и dev-CLI, CLI как клиент API v2, TUI | 🧩 Предложение | [prop-053](./docs/arch_decisions/prop-053-cli-tui.md) |
| PROP-054 | Kanban-доска, backlog, управление проектами: интерактивная доска поверх `project.plan`, глобальный backlog, assignee/WIP-лимиты | 🧩 Предложение | [prop-054](./docs/arch_decisions/prop-054-kanban-backlog.md) |
| PROP-055 | Обмен между инстансами Synth: идемпотентный upsert/дельта-синхронизация, peer-auth, обмен памятью, live-сессии | 🧩 Предложение (vision) | [prop-055](./docs/arch_decisions/prop-055-instance-exchange.md) |
| PROP-056 | MCP-сервер Synth и скиллы для внешних агентов: MCP над API v2, auth, права, форматы конфигов клиентов | 🧩 Предложение | [prop-056](./docs/arch_decisions/prop-056-synth-mcp-server.md) |
| PROP-057 | Loop Engine и Loop Design Wizard: `/design-loop`, Verification Rubric, LoopRunner, 40 шаблонов, termination guards | 🧩 Предложение (vision) | [prop-057](./docs/arch_decisions/prop-057-loop-engine.md) |
| PROP-058 | Служебные агенты и консилиум (Council): panel/consensus/debate/verifier/judge, Council Gate; включает PROP-031 | 🧩 Предложение (vision) | [prop-058](./docs/arch_decisions/prop-058-service-agents-council.md) |
| PROP-059 | Pipeline Automation: цепочки loops, передача артефактов между шагами, rollback/exit-стратегия, HITL, мониторинг-дашборд | 🧩 Предложение (vision) | [prop-059](./docs/arch_decisions/prop-059-pipeline-automation.md) |
| PROP-060 | Мультиконтурная архитектура (Contour Bridge): шлюз между контурами, транспорт Kafka/RabbitMQ, обезличивание, аудит | 🧩 Предложение (vision) | [prop-060](./docs/arch_decisions/prop-060-multi-contour-bridge.md) |
| PROP-061 | Многослойная безопасность LLM: сканеры промптов/вывода, лимиты (токены/итерации/время), HITL, аудит сессий, неизменяемость аудита | 🧩 Предложение (vision) | [prop-061](./docs/arch_decisions/prop-061-llm-security-layers.md) |
| PROP-062 | Умная оптимизация контекста: тул `archive_context`, авто-суммаризация по лимиту, приоритизация, стратегии aggressive/moderate/off | 🧩 Предложение | [prop-062](./docs/arch_decisions/prop-062-context-optimization.md) |
| PROP-063 | Обучение пользователя и метрики: Pre-PR Understanding Check, анализ сессий, рекомендации, дашборд метрик без рейтингов | 🧩 Предложение (vision) | [prop-063](./docs/arch_decisions/prop-063-user-learning-metrics.md) |
| PROP-064 | Встроенные в UI браузер и терминал: PTY/WS-терминал, webview/iframe-браузер, синхронизация с агентом | 🧩 Предложение | [prop-064](./docs/arch_decisions/prop-064-ui-browser-terminal.md) |
| PROP-065 | Просмотр документации, планов и ToDo в UI: docs-браузер, редактор плана/todo, связи, внешний vault (Obsidian Bridge) | 🧩 Предложение | [prop-065](./docs/arch_decisions/prop-065-ui-docs-plan-todo.md) |
| PROP-066 | Скиллы и гайдлайны оформления документации: doc-стандарты, шаблоны, авто-проверка соответствия (docs-lint) | 🧩 Предложение | [prop-066](./docs/arch_decisions/prop-066-doc-style-skills.md) |
| PROP-067 | «Впитывание» организационных гайдлайнов → дефолты инстанса: ingestion, scope (instance/org/team/project), версионирование/аудит | 🧩 Предложение (vision) | [prop-067](./docs/arch_decisions/prop-067-org-guidelines-defaults.md) |
| PROP-068 | Реестр и каталог скиллов и агентов: индекс, trust/guard, install-policy, agent-packs | 🧩 Предложение | [prop-068](./docs/arch_decisions/prop-068-skills-agents-registry.md) |
| ADR-069 | Проектные инструкции (AGENTS.md) и /init: discovery, merged chain git root→cwd, lazy-догрузка, threat-scan, install-tree guard (Ф1–Ф3, остатки R1–R5 закрыты) | ✅ Реализовано | [adr-069](./docs/arch_decisions/adr-069-project-instructions-agents-md.md) |
| ADR-070 | SystemPromptComposer: тиры stable/context/volatile, идемпотентная пересборка, CachePolicy, статистика usage, per-agent promptStates, манифест промпта | ✅ Реализовано | [adr-070](./docs/arch_decisions/adr-070-system-prompt-composer.md) |
| ADR-071 | MCP: уровни system/project/session, единый реестр, разделение слоёв tools/mcp.tools, блоки mcp.servers/mcp.status, политики tools.policy (встроенные) и mcp.policy (MCP), admin-отключение встроенных инструментов | ✅ Реализовано | [adr-071](./docs/arch_decisions/adr-071-mcp-servers-prompt.md) |
| ADR-072 | Settings UI Kit: стандартная панель настроек (один вертикальный скролл, фиксированная шапка, центрирование max-w-3xl, контракт черновика, контролы); все разделы и админ-категории мигрированы | ✅ Реализовано | [adr-072](./docs/arch_decisions/adr-072-settings-ui-kit.md) |
| PROP-073 | Целостность клиента в гибридном режиме: клиент недоверенный, enforcement на сервере; сигналы целостности (подписи, DPoP/mTLS) — опционально | 🧩 Предложение | [prop-073](./docs/arch_decisions/prop-073-client-integrity-hybrid.md) |
| PROP-074 | Скрытие вместо удаления (soft-delete): проекты/сессии/сообщения скрываются, исключаются из LLM-контекста, read-only режим для ADMIN/AUDITOR, restore/purge — ADMIN | 🧩 Предложение | [prop-074](./docs/arch_decisions/prop-074-soft-delete-retention.md) |
| ADR-075 | Окружение проекта: рабочий каталог (автосоздание managed / выбор для standalone; политика `workspaceOutsideRoot`; FS-паритет core↔backend); тулы `project_workspace_set`/`project_update`, общий `engine/workspace-provision.ts` | ✅ Реализовано | [adr-075](./docs/arch_decisions/adr-075-project-workspace-provisioning.md) |
| ADR-076 | Реестр git-репозиториев (несколько на проект) и SSH-ключи per-agent (шифрование at-rest, `repo_path`, паритет core↔backend); тулы `project_repo_clone\ | ✅ Реализовано | [adr-076](./docs/arch_decisions/adr-076-git-repo-registry-ssh.md) |
| PROP-077 | Инструментальное окружение исполнения: managed — thin backend + сервис-executor (общий volume для workspace; S3 — целевое хранилище); реализуется после PROP-032 (PostgreSQL) | 🧩 Предложение | [prop-077](./docs/arch_decisions/prop-077-runtime-toolchain.md) |
| ADR-078 | Авто-отключение инструментов при отсутствии внешней зависимости (детект git/rg/sh, `unavailable(dependency)`, пояснение модели) | ✅ Реализовано | [adr-078](./docs/arch_decisions/adr-078-runtime-dependency-availability.md) |
| ADR-079 | Локальный home-каталог (`--home`/`SYNTH_HOME`): плоская раскладка config/data/profiles/credentials, приоритеты путей, независимые инстансы standalone и hybrid | ✅ Реализовано | [adr-079](./docs/arch_decisions/adr-079-local-home-independent-instances.md) |
| PROP-080 | Управляемый гибрид: режимы-полюса (режим — параметр запуска, без runtime-переключения), standalone=ADMIN / hybrid=роли сервера, «Установить локально» | 🧩 Предложение | [prop-080](./docs/arch_decisions/prop-080-managed-hybrid-modes.md) |
| PROP-081 | Политики гибрида и защита от утечек: серверные политики (forbidden/remote-only/full; publish/fork allow\ | 🧩 Предложение | [prop-081](./docs/arch_decisions/prop-081-hybrid-policy-leak-protection.md) |
| PROP-082 | Flavor-образы с toolchain (`slim`/`core`/`dev`/`devops`/`browser`/`full`; alpine + debian) для local containerized и managed single-instance (промежуточный шаг до PROP-077) | 🧩 Предложение | [prop-082](./docs/arch_decisions/prop-082-full-images-deployment.md) |
| PROP-083 | Кастомизация инстанса и брендинг: приветственное окно (+повторный вызов), конфиг брендинга (название/лого-подпись/ватермарка), серверная выдача; на потом — locked settings (блокировка настроек даже для ADMIN инстанса) | 🧩 Предложение | [prop-083](./docs/arch_decisions/prop-083-instance-customization-branding.md) |
| ADR-084 | Decision-модели (Clef/Clef-Flash) в маршрутизации и быстрых ответах: класс decision-моделей (Jev/SystemOne-совместимый API), Clef-Flash в micro/быстрых ответах, `primary → escalation` (вторая пара provider/model), через GatewayProvider; агрегатные метрики decision-слоя; мультимодальный контракт (`images`/`videos`, источник — PROP-085); политики local/remote — зависимость PROP-080/081; реализовано: адаптер/конфиг `decision`, Clef-Flash в micro (`decisionFirst`), классификатор маршрутизации, decision-роутинг событий, эскалация, метрики, runtime-API, UI | ✅ Реализовано | [adr-084](./docs/arch_decisions/adr-084-decision-models-clef.md) |
| PROP-085 | Мультимодальный ввод (звук, изображения, видео): типы `Part`, blob-хранилище вложений, маппинг в форматы провайдеров, предобработка (ASR/OCR/кадры), UI-композер | 🧩 Предложение | [prop-085](./docs/arch_decisions/prop-085-multimodal-input.md) |
| ADR-086 | Расширяемость Synth (зонтик «Классы расширений»): Plugin ([PROP-090](./docs/arch_decisions/prop-090-extension-api.md)), **Gateway** ([ADR-087](./docs/arch_decisions/adr-087-gateways.md)), Add-on, контент-паки ([PROP-068](./docs/arch_decisions/prop-068-skills-agents-registry.md)), Editions, Contribution flow; единый манифест `synth.pack`; первый **Gateway** (Telegram-шлюз) реализован и мультитенантен; эталон Add-on — `synth-media`; Plugin SDK/editions/contribution — нет | ⚠️ Частично | [adr-086](./docs/arch_decisions/adr-086-extensibility-plugins-editions.md) |
| ADR-087 | Шлюзы (gateways) — **отдельный класс расширений**: внешний сервис-транспорт внешний мир ↔ Synth (двусторонний обмен); контракт (приём `POST /api/v2/events`, доставка наружу SSE-watcher, MCP-часть, Binding, identity/claim-flow, allowlist, вложения, дедуп, прокси/egress, секреты at-rest); Telegram-шлюз `addons/synth-gateway-telegram` **реализован** и **мультитенантен** (`tenants.json`, «несколько ботов → несколько сред»); HA через leader election, webhook-транспорт, второй канал — нет | ⚠️ Частично | [adr-087](./docs/arch_decisions/adr-087-gateways.md) |
| PROP-088 | Работа через HTTP-прокси: единый egress-слой, `no_proxy`/исключения, доверенные CA, аутентификация Basic/NTLM/Negotiate (Kerberos) | 🧩 Предложение | [prop-088](./docs/arch_decisions/prop-088-http-proxy.md) |
| ADR-089 | Synth как платформа внешних событий и автоматизации: сущности Event/Binding/Router, приём внешних событий на hook-шине, `session.requested` — тоже событие. Реализовано: ядро Event/Binding/Router, единый funnel, API/UI, ключи привязок, идентичности профиля + claim-flow, auto-bind, права внешних отправителей (fail-closed), надёжный Stop; остаток — PROP-090/PROP-059/ADR-087 | ⚠️ Частично | [adr-089](./docs/arch_decisions/adr-089-external-events-automation.md) |
| PROP-090 | Extension API v1: 4 класса (Plugin / Gateway / Add-on / контент-пак), определение Plugin (код в процессе ядра), таксономия влияния (contribution / interception / observation), единый манифест `synth.pack` (`kind`/`contracts`/`provides`), фасад `@itphx/synth-plugin` + disposer-модель, bundle-only дистрибуция, install/activate (`plugins.lock.json`/`plugins.json`), trust/scan по PROP-068, плагины в managed (ADMIN, deploy-time + runtime-опция) и hybrid (allow-list + server-scoped токены) | 🧩 Предложение | [prop-090](./docs/arch_decisions/prop-090-extension-api.md) |
| ADR-091 | Бэкап, восстановление и диагностика инстанса — свой контур `backup`/`restore`/`doctor` | ⚠️ Частично | [adr-091](./docs/arch_decisions/adr-091-backup-restore-transfer.md) |
| ADR-092 | Обслуживание инстанса — версия схемы данных, миграции и удаление | ⚠️ Частично | [adr-092](./docs/arch_decisions/adr-092-instance-lifecycle-maintenance.md) |
| PROP-093 | Версионирование документации портала: версионные подкаталоги + селектор (вариант A под текущий nginx-деплой) или `mike` (вариант B при GitHub Pages), тегирование `synth-docs`, политика хранения | 🧩 Предложение | [prop-093](./docs/arch_decisions/prop-093-docs-versioning.md) |
| PROP-094 | Наблюдаемость и эксплуатационные метрики: `/metrics` (Prometheus), `/ready` + раздельные probes, структурные логи (`request_id`/`session_id`, редакция секретов), SLO/алерты, sizing | 🧩 Предложение | [prop-094](./docs/arch_decisions/prop-094-observability-metrics.md) |
| ADR-095 | Декомпозиция god-объектов — «вынос по швам» | ✅ Реализовано | [adr-095](./docs/arch_decisions/adr-095-god-object-decomposition.md) |
| ADR-096 | Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами | ✅ Реализовано | [adr-096](./docs/arch_decisions/adr-096-storage-layer.md) |
| PROP-096 | Фоновые сессии саб-агентов (не блокирующие основную) | 🧩 Предложение | [prop-096](./docs/arch_decisions/prop-096-background-subagent-sessions.md) |
| PROP-097 | Фоновые процессы — реестр и контроль через UI | 🧩 Предложение | [prop-097](./docs/arch_decisions/prop-097-background-processes-registry.md) |
| PROP-098 | Форсированная отправка сообщения во время хода (steering) | 🧩 Предложение | [prop-098](./docs/arch_decisions/prop-098-mid-turn-steering.md) |
| PROP-099 | Оптимизация потребления памяти | 🧩 Предложение | [prop-099](./docs/arch_decisions/prop-099-memory-footprint-optimization.md) |
| PROP-100 | SSRF и TOCTOU/DNS-rebinding — привязка проверенного адреса к соединению | 🧩 Предложение | [prop-100](./docs/arch_decisions/prop-100-ssrf-dns-rebinding.md) |
<!-- ad-index:end -->

Правило: `docs/arch_decisions/` — единственный дом ADR/PROP; номера и файлы стабильны (ссылок на id по репозиторию — тысячи), файлы не переносятся и не удаляются.

## Куда смотреть (триггеры)

| Трогаешь | Читай |
|---|---|
| пользовательская документация / портал | https://docs.synth.itphx.ru/ |
| документация (портал и dev-доки) | скилл `synth-docs` |
| storage / JSON / FileStore | [ADR-005](./docs/arch_decisions/adr-005-json-storage.md) |
| хранилище / backend / порты | [ADR-096](./docs/arch_decisions/adr-096-storage-layer.md), [PROP-032](./docs/arch_decisions/prop-032-history-storage-postgresql.md) |
| события / WS / SSE | [ADR-008](./docs/arch_decisions/adr-008-websocket-events.md), [ADR-009](./docs/arch_decisions/adr-009-session-event-bus.md), [ADR-024](./docs/arch_decisions/adr-024-eventhub-transport.md) |
| проект / сессии / ветвление / merge | [ADR-014](./docs/arch_decisions/adr-014-project-container.md), [ADR-033](./docs/arch_decisions/adr-033-session-branching-merge.md), [ADR-040](./docs/arch_decisions/adr-040-sessions-without-project.md) |
| API v2 / Hono | [ADR-017](./docs/arch_decisions/adr-017-api-v2-hono.md), [docs/API_V2.md](./docs/API_V2.md) |
| движки / engine | [ADR-018](./docs/arch_decisions/adr-018-session-engine-selection.md), [ADR-022](./docs/arch_decisions/adr-022-typescript-stack-runner.md). ⚠️ Поле `Session.engine` **удалено** из контракта (публичный OpenAPI/SDK, ответы `GET /sessions*`, `:id/messages`, тела POST/PATCH) — намеренное ломающее изменение; выбор и адаптеры движков — [PROP-050](./docs/arch_decisions/prop-050-external-engines-runner.md) |
| UI / React / PWA | [ADR-019](./docs/arch_decisions/adr-019-react-spa.md), [ADR-044](./docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| саб-агенты / контекст | [ADR-026](./docs/arch_decisions/adr-026-subagent-context-modes.md), [ADR-033](./docs/arch_decisions/adr-033-session-branching-merge.md) |
| permissions / plan-act | [ADR-025](./docs/arch_decisions/adr-025-plan-act-toggle.md), [ADR-028](./docs/arch_decisions/adr-028-plan-build-strictness.md), [ADR-029](./docs/arch_decisions/adr-029-granular-permissions.md) |
| конфиг | [ADR-023](./docs/arch_decisions/adr-023-configuration.md), [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) |
| routing / микро-слой | [ADR-034](./docs/arch_decisions/adr-034-model-routing.md), [ADR-035](./docs/arch_decisions/adr-035-micro-model-first.md), [ADR-084](./docs/arch_decisions/adr-084-decision-models-clef.md), [docs/ROUTING.md](./docs/ROUTING.md) |
| безопасность / gateway | [ADR-036](./docs/arch_decisions/adr-036-llm-gateway.md) |
| безопасность клиента / целостность / аттестация гибрида | [PROP-073](./docs/arch_decisions/prop-073-client-integrity-hybrid.md) |
| soft-delete / скрытие / retention / аудит-режим | [PROP-074](./docs/arch_decisions/prop-074-soft-delete-retention.md) |
| workspace / рабочий каталог / окружение проекта | [ADR-075](./docs/arch_decisions/adr-075-project-workspace-provisioning.md) |
| git-репозитории / SSH-ключи | [ADR-076](./docs/arch_decisions/adr-076-git-repo-registry-ssh.md) |
| инструменты / образы / тулчейн / executor | [PROP-077](./docs/arch_decisions/prop-077-runtime-toolchain.md), [ADR-078](./docs/arch_decisions/adr-078-runtime-dependency-availability.md), [PROP-082](./docs/arch_decisions/prop-082-full-images-deployment.md) |
| план / todo | [ADR-039](./docs/arch_decisions/adr-039-plan-in-project.md) |
| ошибки LLM / i18n | [ADR-041](./docs/arch_decisions/adr-041-llm-error-taxonomy.md) |
| гибрид | [ADR-042](./docs/arch_decisions/adr-042-hybrid-mode.md), [ADR-043](./docs/arch_decisions/adr-043-unified-identity-login.md), [ADR-045](./docs/arch_decisions/adr-045-hybrid-server-profiles.md), [PROP-080](./docs/arch_decisions/prop-080-managed-hybrid-modes.md), [PROP-081](./docs/arch_decisions/prop-081-hybrid-policy-leak-protection.md), [docs/HYBRID.md](./docs/HYBRID.md), скилл `synth-hybrid` |
| локальный home / пути / независимые инстансы | [ADR-079](./docs/arch_decisions/adr-079-local-home-independent-instances.md), [ADR-023](./docs/arch_decisions/adr-023-configuration.md), [ADR-045](./docs/arch_decisions/adr-045-hybrid-server-profiles.md) |
| OIDC / Keycloak / RBAC | [docs/KEYCLOAK.md](./docs/KEYCLOAK.md) |
| npm / Docker / Helm / релиз | [ADR-038](./docs/arch_decisions/adr-038-npm-packages.md), [docs/PUBLISHING.md](./docs/PUBLISHING.md), скиллы `synth-build-publish`, `synth-release` |
| CI GitVerse | `.gitverse/workflows/*`, скилл `synth-release` |
| внутренний аудит / секреты / ратчет зависимостей | [docs/security/README.md](./docs/security/README.md), [docs/security/AUDIT-CHECKLIST.md](./docs/security/AUDIT-CHECKLIST.md), скилл `synth-security-audit` |
| K3s / test | скилл `synth-k3s-deploy`, `synth-deploy/AGENTS.md` |
| dev-окружение | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md), скилл `synth-dev` |
| MCP GitVerse | скилл `synth-gitverse-mcp` |
| API-тесты | скилл `synth-api-testing` |
| скиллы / команды | [ADR-046](./docs/arch_decisions/adr-046-skills-and-slash-commands.md) |
| реестр скиллов / агентов | [PROP-068](./docs/arch_decisions/prop-068-skills-agents-registry.md) |
| инструкции AGENTS.md | [ADR-069](./docs/arch_decisions/adr-069-project-instructions-agents-md.md), скилл `synth-agents-md` |
| промпт / prompt-cache / статистика токенов / debug промпта | [ADR-070](./docs/arch_decisions/adr-070-system-prompt-composer.md), [ADR-036](./docs/arch_decisions/adr-036-llm-gateway.md), [ADR-041](./docs/arch_decisions/adr-041-llm-error-taxonomy.md) |
| MCP / MCP-серверы / инструменты в промпте | [ADR-071](./docs/arch_decisions/adr-071-mcp-servers-prompt.md), [ADR-029](./docs/arch_decisions/adr-029-granular-permissions.md), [PROP-068](./docs/arch_decisions/prop-068-skills-agents-registry.md) |
| настройки / settings UI kit | [ADR-072](./docs/arch_decisions/adr-072-settings-ui-kit.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| кастомизация / брендинг / онбординг | [PROP-083](./docs/arch_decisions/prop-083-instance-customization-branding.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| блокировка настроек (locked settings) | [PROP-083](./docs/arch_decisions/prop-083-instance-customization-branding.md), [PROP-073](./docs/arch_decisions/prop-073-client-integrity-hybrid.md), [PROP-080](./docs/arch_decisions/prop-080-managed-hybrid-modes.md), [PROP-081](./docs/arch_decisions/prop-081-hybrid-policy-leak-protection.md) |
| внешние события / хуки / роутинг / сессии | [ADR-089](./docs/arch_decisions/adr-089-external-events-automation.md), [ADR-030](./docs/arch_decisions/adr-030-hooks-agent-events.md), [ADR-033](./docs/arch_decisions/adr-033-session-branching-merge.md) |
| мессенджеры / шлюзы | [ADR-087](./docs/arch_decisions/adr-087-gateways.md) (класс Gateway: контракт, Telegram-шлюз, топология «один бот — один инстанс», HA через leader election, мультитенантность, singleton-гарантия) |
| шедулер / пайплайны | [ADR-051](./docs/arch_decisions/adr-051-scheduler-pipelines.md), [PROP-059](./docs/arch_decisions/prop-059-pipeline-automation.md), [PROP-057](./docs/arch_decisions/prop-057-loop-engine.md) |
| публичный API / webhooks / scoped service-key | [ADR-052](./docs/arch_decisions/adr-052-public-api-platform.md) (service-key + scopes + `allowedProjects`, только public-OpenAPI через `@hono/zod-openapi`, `@itphx/synth-sdk`, webhooks; tenants исключены), [ADR-089](./docs/arch_decisions/adr-089-external-events-automation.md) |
| MCP-сервер Synth | [PROP-056](./docs/arch_decisions/prop-056-synth-mcp-server.md), [PROP-048](./docs/arch_decisions/prop-048-self-help-skills-admin-mcp.md) |
| внешние add-on сервисы / шлюзы / плагины / editions | [ADR-086](./docs/arch_decisions/adr-086-extensibility-plugins-editions.md), [ADR-087](./docs/arch_decisions/adr-087-gateways.md), [PROP-090](./docs/arch_decisions/prop-090-extension-api.md), [PROP-068](./docs/arch_decisions/prop-068-skills-agents-registry.md), [ADR-030](./docs/arch_decisions/adr-030-hooks-agent-events.md) |
| прокси / egress | [PROP-088](./docs/arch_decisions/prop-088-http-proxy.md) |
| бэкап / восстановление / экспорт / импорт данных | [ADR-091](./docs/arch_decisions/adr-091-backup-restore-transfer.md), [ADR-005](./docs/arch_decisions/adr-005-json-storage.md), [PROP-055](./docs/arch_decisions/prop-055-instance-exchange.md) |
| обслуживание инстанса / бэкап / миграции | [ADR-091](./docs/arch_decisions/adr-091-backup-restore-transfer.md), [ADR-092](./docs/arch_decisions/adr-092-instance-lifecycle-maintenance.md), [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) |
| обновление / миграции схемы / откат / удаление инстанса | [ADR-092](./docs/arch_decisions/adr-092-instance-lifecycle-maintenance.md), [ADR-038](./docs/arch_decisions/adr-038-npm-packages.md), [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) |
| версионирование документации | [PROP-093](./docs/arch_decisions/prop-093-docs-versioning.md), скилл `synth-docs` |
| наблюдаемость / метрики / health / ready / SLO | [PROP-094](./docs/arch_decisions/prop-094-observability-metrics.md), [ADR-036](./docs/arch_decisions/adr-036-llm-gateway.md) |
| мультимодальный ввод | [PROP-085](./docs/arch_decisions/prop-085-multimodal-input.md) |
| память | [PROP-047](./docs/arch_decisions/prop-047-memory-gbrain.md), [PROP-062](./docs/arch_decisions/prop-062-context-optimization.md) |
| CLI / TUI | [PROP-053](./docs/arch_decisions/prop-053-cli-tui.md) |
| Kanban / backlog | [PROP-054](./docs/arch_decisions/prop-054-kanban-backlog.md), [PROP-065](./docs/arch_decisions/prop-065-ui-docs-plan-todo.md) |
| иконки/цвета проекта и сессии | [packages/ui/AGENTS.md](./packages/ui/AGENTS.md), [packages/shared/AGENTS.md](./packages/shared/AGENTS.md) |

## Документация

Разделение аудиторий: **пользовательская документация** — канонический источник на портале
[docs.synth.itphx.ru](https://docs.synth.itphx.ru/) (RU по умолчанию, EN — `/en/`; быстрый старт,
провайдеры, гибрид, администрирование, CLI/FAQ), в репозитории не дублируется; **документация для
разработчиков** — в `docs/` репозитория и в `AGENTS.md` (этот файл, архитектурные соглашения, ADR и PROP).

| Файл | Назначение |
|------|------------|
| `AGENTS.md` | Архитектурные соглашения (этот файл) |
| [docs/API_V2.md](./docs/API_V2.md) | Справочник API v2 (эндпоинты, RBAC, ошибки, транспорт) |
| [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md) | Правила ведения ADR/PROP: классы документов, «когда что писать», канонические статусы, история |
| [docs/roadmap.md](./docs/roadmap.md) | Индекс предложений (actionable/vision) и сроки решений |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Обзор архитектуры |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) | Конфигурация |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Dev-окружение, скрипты |
| [docs/HYBRID.md](./docs/HYBRID.md) | Гибридный режим: требования, архитектура, статус |
| [docs/KEYCLOAK.md](./docs/KEYCLOAK.md) | Учётки/настройки Keycloak |
| [docs/LLM_PROVIDERS.md](./docs/LLM_PROVIDERS.md) | Провайдеры LLM для разработки |
| [docs/PUBLISHING.md](./docs/PUBLISHING.md) | Сборка, публикация npm, Docker, Helm, релиз |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Быстрый старт |
| [docs/ROUTING.md](./docs/ROUTING.md) | Routing и микро-слой |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Диагностика проблем |
| [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) | Runbook эксплуатации: настройка, диагностика, бэкап/восстановление, миграции, удаление, обновление/откат |
| [docs/arch_decisions/README.md](./docs/arch_decisions/README.md) | Каталог ADR/PROP |
