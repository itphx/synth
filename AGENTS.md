# Synth — архитектурные соглашения

> Здесь только то, что нужно постоянно; подробности — в `docs/`, `docs/arch_decisions/`, `.opencode/skills/`; трогаешь подсистему — сначала таблица «Куда смотреть (триггеры)». Правила ведения решений и жизненный цикл документов — [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md); предложения и сроки — [docs/roadmap.md](./docs/roadmap.md).

## Язык

Все сообщения, коммиты и документация — **на русском**. Не коммитить без явной просьбы пользователя.

Русский — канонический язык документации. Для публичного GitHub-зеркала поддерживаются EN-версии: `README.en.md` в корне и спецификации в `docs/en/`. Терминология — [`docs/en/GLOSSARY.md`](./docs/en/GLOSSARY.md); при расхождении с англоязычными строками продукта (UI `packages/ui/src/lib/i18n/messages/en.ts`, движок `packages/core/src/engine/system-messages.ts`) приоритет у продукта.

Меняешь RU-документ, у которого есть EN-версия — обнови EN в том же коммите. Если перевод отстаёт осознанно — пометь расхождение в шапке EN-файла строкой вида `> ⚠️ RU-версия обновлена <дата>; перевод отстаёт`.

## Инварианты (не нарушать)

1. План — в `project.plan`, todo — в `session.todos`; состояние менять только инструментами `plan_*`/`todo_*`, не файлами (ADR-039).
2. Хранилище — только через порты слоя хранения (`StorageContext`, ADR-096); файловая реализация — `FileStore`/`JsonStore` (JSON + атомарная запись tmp→rename, ADR-005); писать в `$SYNTH_DATA_DIR` в обход порта нельзя. Исключение: фикс самого хранилища / миграция схемы.
3. Любой LLM-вызов — через `GatewayProvider` (guard, обфускация, rate limit, аудит); провайдера напрямую не дёргать (ADR-036). Это включает **эмбеддинги**: только `GatewayProvider.embed` (не `provider.embed`) — в том числе для плагинов через сервис фасада `facade.embed` (ADR-107); микро-слой и память ходят только этим путём.
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
22. Источник доверия TLS/CA один — секция `security.tls` (ADR-099): подсистемы **не** создают собственных HTTP-агентов/диспетчеров и **не** полагаются на `NODE_EXTRA_CA_CERTS` как на конфигурацию (env остаётся лишь совместимостью для дочерних процессов); все исходящие вызовы — через общий транспорт (`egressFetch` / глобальный undici-dispatcher, ставится `initTlsTrust` при старте). TLS **применяется при старте**, но настраивается runtime: bootstrap `{dataDir}/security-tls.json` (0600, читается до PG — осознанное исключение из «всё через порты»), приоритет `SYNTH_TLS_*` > runtime(UI) > config; CA-бандл, default mTLS-клиент и per-host `mappings` (exact/`*.suffix`/`*`, первое совпадение; PG — тот же профиль), `proxy.tls` — отдельно; изменения — после рестарта (`restartRequired`), аудит `scope:'tls'`. TLS-параметры (`sslmode`/`sslrootcert`/`sslcert`/`sslkey`/…) в DSN PostgreSQL **запрещены** — политика доверия задаётся только `storage.postgres.sslmode` + `security.tls`.
23. Прокси — часть egress-слоя (ADR-099 п. 16–21, 27): секция `proxy` (HTTP/HTTPS/SOCKS5, Basic, TLS/mTLS к https-прокси, `noProxy`) с **именованными профилями и host-правилами** (`mode: all|selected`, `defaultProfile`, `profiles.<name>` со своим URL/auth/tls, `rules[]` — порядок = приоритет, первое совпадение; `noProxy` важнее правил; CIDR — только по IP-литералу; `action: direct` без `profile`) настраивается в `config.yaml`/env **и в разделе «Сеть» → «Прокси»** (runtime-override в `RuntimeSettings.proxy`, `settings.json`/PG); приоритет `SYNTH_PROXY_*` > runtime(UI) > config > стандартные env (`fromEnv`); `profiles`/`rules` runtime заменяет целиком. Применение — при старте (`restartRequired`). Пароли Basic — только env/файлы: `default` — `SYNTH_PROXY_PASSWORD`/`{dataDir}/secrets/proxy-password`, остальные — `SYNTH_PROXY_<NAME>_PASSWORD`/`{dataDir}/secrets/proxy/<name>.password` (409 для UI при env); TLS-материалы профиля — `secrets/proxy/<name>/{ca.pem,client.crt,client.key}`; аудит `scope:'proxy'`. Legacy (без `profiles`/`rules`) = синтетический профиль `default`. Доменная аутентификация прокси (NTLM/Negotiate/Kerberos) в приложении **не реализуется** — делегируется промежуточному egress-прокси/шлюзу (Squid `login=NEGOTIATE`, px), ADR-099 п. 25; SOCKS5 — best-effort без target CA/mTLS (п. 26); git/stdio-MCP per-host маршрут не умеют (один прокси через child-env; в `selected` прокси-env им не ставится); runtime-reload — остаток.
24. Перезапуск инстанса — только graceful shutdown с **exit code 75** и подъём супервизором (ADR-092 п. 7): `POST /api/v2/maintenance/restart {confirm:true}` → 202 (идемпотентно, аудит `restart.requested`), режим `SYNTH_RESTART_MODE=disabled|process|supervisor` (default `disabled`; CLI `synth serve --restart-mode` приоритетнее). Переинициализацию процесс-глобальных singleton'ов «на лету» (dispatcher/TLS, пул PG, MCP, шедулер) не делать — только рестарт процесса. `startedAt` в `/health`/`/api/v2/health` — аддитивное поле для UI; в multi-replica endpoint перезапускает только свой pod (весь Deployment — `kubectl rollout restart`).
25. Наблюдаемость — **контракт**, а не соглашение (ADR-094): имена `synth_*` и лейблы (`method`/`route`/`status`/`provider`/`model`/`kind`/`outcome`/`source`/`op`/`currency`/`backend`/`store`/`action`/`effect`) фиксированы; `route` — шаблон (неизвестный → `other`), `session_id`/`user_id`/сырые пути/query запрещены; SSE/WS вне гистограммы; новых зависимостей для рендера не добавлять (свой реестр). `GET /metrics` **вне** `/api/v2`, off by default (`metrics.enabled`/`SYNTH_METRICS_ENABLED`); runtime-значение задаётся в UI «Метрики» (`settings.json`/PG, приоритет `SYNTH_METRICS_ENABLED` > runtime > config > `false`) и применяется **после рестарта** (`restartRequired`), middleware/коллекторы создаются при старте. Опциональный токен — только env `SYNTH_METRICS_TOKEN` или файл `{dataDir}/secrets/metrics-token` (в `config.yaml` не хранится; UI пишет файл write-only, при env → 409). `/ready` ≠ liveness: деградация хранилища остаётся ready (503 — только старт/fail-closed); `synth_ready` — метрика того же состояния. Runbook — [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md).
26. Цикл обработки сообщений — **единая спецификация** ([docs/MESSAGE_FLOW.md](./docs/MESSAGE_FLOW.md): приём, очередь, ход/шаги, события, индикаторы); контракт событий — [docs/API_V2.md](./docs/API_V2.md) §3.3, решение — [ADR-118](./docs/arch_decisions/adr-118-message-stream-v2.md). Поведение цикла (события, шаги, статусы, индикаторы, очередь) меняется только вместе со спецификацией и тестами; точки входа: `packages/core/src/queue/processor.ts` (приём/очередь/ретраи), `packages/core/src/engine/orchestrator.ts` + `orchestrator/phases/process-finalize.ts` (ход/шаги/финал), `packages/core/src/engine/orchestrator/turn-events.ts` + `events/bus.ts` (события/догон), `packages/core/src/server/serialize.ts` (DTO), `packages/ui/src/stores/transportStore.ts` + `components/chat/{MessageList,ChatMessage}.tsx` (UI-состояние/индикаторы), `packages/ui/src/components/chat/QueuePanel.tsx` (очередь).
27. Синхронизация мутаций между клиентами — **инвариант**: мутация, видимая другому клиенту (сообщения, история, проект, план, workspace), публикует событие в канал сессии/сессий проекта (`message.deleted`/`message.updated`/`session.messages.cleared`/`project.updated`/`project.deleted`/`plan.updated`/`fs.changed`), а UI обязан его обработать — иначе лента «залипает» после действий другого клиента. События идут в существующей шине (ADR-024/ADR-118), без новых каналов.

## Карта репозитория

Монорепозиторий `synth/` (pnpm workspaces), единый стек TypeScript. Подробности по пакету — в `packages/<pkg>/AGENTS.md` (есть у `core`, `backend`, `ui`, `shared`, `storage-postgres`, `executor`; короткий — у `sdk`; у тонкой `synth` — нет).

```text
synth/
├── packages/
│   ├── shared/    @itphx/synth-shared   # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/      @itphx/synth-core     # Ядро: сессии, очередь, LLM, MCP, FileStore, API v2 (Hono), CLI
│   ├── executor/  @itphx/synth-executor # Исполнитель агентских команд: сервер исполнителя + клиент удалённого порта (ADR-077)
│   ├── storage-postgres/ @itphx/synth-storage-postgres  # Опциональный БД-драйвер слоя хранения (ADR-097)
│   ├── backend/   @itphx/synth-backend  # Hono API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
│   ├── ui/        @itphx/synth-ui       # React 19 SPA + админка (Vite)
│   ├── sdk/       @itphx/synth-sdk      # Типизированный клиент публичного API (ADR-052)
│   └── synth/     @itphx/synth          # Публикуемая CLI-обёртка (bin: synth)
├── pnpm-workspace.yaml   tsconfig.base.json   eslint.config.js   .prettierrc
docs/                  # Документация (см. «Документация»)
docs/arch_decisions/   # ADR/PROP (индекс — README.md каталога)
.opencode/skills/      # Скиллы (synth-dev, synth-release, synth-hybrid, ...)
tmp/                   # Временные файлы. Использовать его, а не /tmp в корне ФС. Не коммитится
```

Все 8 пакетов публикуются в npm; `@itphx/synth` — тонкая CLI-обёртка над core/ui/shared: не бандлит core в `cli.js` (external) и не копирует ассеты — всё резолвится из npm-зависимостей (ADR-038). `@itphx/synth-sdk` — самостоятельный клиент публичного API (зависит только от shared). `@itphx/synth-storage-postgres` — опциональный драйвер слоя хранения (`peerDependencies: @itphx/synth-core`, `optionalDependencies: pg`), подключается core **динамическим `import()`** только при `storage.backend=postgres` — standalone/локальный home БД не тянут. `@itphx/synth-executor` — исполнитель агентских команд (ADR-077): `dependencies` — `@itphx/synth-shared`, `peerDependencies` — `@itphx/synth-core`; даёт сервер исполнителя и клиент удалённого порта (экспорт `./client`), подключается core **динамическим `import()`** по `execution.mode=remote` (fail-closed).

**Слой хранения (ADR-096).** Домен работает только через доменные порты (`packages/core/src/storage/ports/*`), backend взаимозаменяем: `storage/memory/*`, файловые реализации (default) и **PostgreSQL** (опциональный in-tree драйвер `@itphx/synth-storage-postgres`, ADR-097). Точка сборки — `storage/storage-context.ts` (`createFileStorage`/`createMemoryStorage` + асинхронные `createStorageContextAsync`/`buildStorageContext` для динамического `import()` драйвера); выбор — `storage.backend` (`file`|`memory`|`postgres`, **fail-closed** на неизвестном значении). Файловым **по конструкции** остаётся только `blobs`: байты вложений/артефактов/скиллов/логов — в `{dataDir}/blobs`, в БД только `blob_refs` (ADR-116). Параметры PG — `storage.postgres` + env `SYNTH_POSTGRES_*`, пароль только env/файл; недоступность БД — деградированный режим (ADR-098: `fallback-file` read-only / `halt`, без авто-возврата); контракт портов — `storage/contract/*` (живая БД — env `SYNTH_TEST_POSTGRES_DSN`). Детали — ADR-096/097/098/116, [packages/core/AGENTS.md](./packages/core/AGENTS.md).

**Наблюдаемость (ADR-094).** `packages/core/src/metrics/` — свой мини-реестр (counter/gauge/histogram, exposition 0.0.4, middleware с шаблоном route, process/collectors), роуты `/metrics` и `/health`/`/ready`. Каталог метрик, скрейп, алерты — [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md), правила — инвариант 25.

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
@itphx/synth-storage-postgres  ←  опциональный БД-драйвер слоя хранения: peer-dep core (ADR-097)
@itphx/synth-executor  ←  исполнитель агентских команд: shared + peer-dep core (ADR-077)
@itphx/synth   ←  тонкая CLI-обёртка: core + ui + shared (npm-потребители)
```

**Переиспользуемые роуты.** Общая логика HTTP-роутов живёт в core-фабриках (`createSettingsRoutes`, `createDictionaryRoutes`, `createProviderRoutes`, `createModelRoutes`, `createSessionRoutes`, `createProjectRoutes`, `createFsRoutes`, `createMessageRoutes`, `createQueueRoutes`, `createAgentRoutes`, `createMcpRoutes`, `createPipelineProjectRoutes`); backend монтирует их и добавляет только RBAC/rate-limit/специфику через `opts` (guard'ы, `messages` для i18n, хуки). Дублировать хендлеры в backend нельзя.

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
synth backup --out <dir>     # архив каталога данных (--with-secrets|--with-workspace|--live|--encrypt [--key-file]) — ADR-091
synth restore <archive>      # восстановление (--dry-run|--yes|--no-safety-copy|--key-file) — ADR-091
synth migrate                # миграции схемы данных (--dry-run|--yes) — ADR-092
synth update [--apply] [--to <version>]  # проверка/обновление/откат пакета (--dry-run|--yes|--json) — ADR-092
synth uninstall              # удаление инстанса (--purge|--purge-db|--dry-run|--yes; по умолчанию данные сохраняются) — ADR-092
synth storage migrate --to postgres|file  # перенос данных инстанса между backend'ами хранения, идемпотентно (--dry-run|--yes) — ADR-097
synth analytics rebuild [--from <date>] [--dry-run|--yes]  # идемпотентная пересборка суточных роллапов аналитики (ADR-102)
synth memory status|list|index|rebuild|drop  # портал памяти: индексы и факты (--scope, --wait, --json) — ADR-107
```

**Перенос проекта между инстансами** (ADR-091 §6, по умолчанию без секретов — карта обфускации Gateway вырезается, `--with-secrets` только ADMIN/LEAD; materialization с новыми id):

```bash
synth project export <projectId> [--out <file|dir>] [--with-workspace] [--with-secrets]  # портативный экспорт проекта (--with-secrets — только ADMIN/LEAD)
synth project import <archive> [--name <name>] [--merge-into <projectId>] \
  [--with-workspace] [--dry-run|--yes]                                        # импорт (без --dry-run и --yes — отказ)
```

Тот же перенос доступен по HTTP API (`GET /api/v2/projects/:id/export`, `POST /api/v2/projects/import`
— скачивание архива и импорт multipart; спека — [docs/API_V2.md](./docs/API_V2.md) §5.8.1).

Тот же контур доступен из UI (Настройки → «Обслуживание», только ADMIN) и по admin-API `/api/v2/maintenance/*` (managed — `ADMIN`, core — `requireAuth`); восстановление — **офлайн-операция** (применяется при следующем старте, `appliesOnNextStart`). Там же — **перезапуск инстанса** (`GET/POST /api/v2/maintenance/restart`): graceful shutdown с exit 75, режим `SYNTH_RESTART_MODE` (default `disabled`; `dev.sh` — `supervisor`, Helm — `process`), см. инвариант 24. Процедуры — [docs/MAINTENANCE.md](./docs/MAINTENANCE.md); спека — [docs/API_V2.md](./docs/API_V2.md) §5.31.

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

`./scripts/dev.sh [backend|ui|core|all]` из `synth/` (или `./synth/scripts/dev.sh` из корня проекта). Скрипт ставит: `SYNTH_AUTH_DEBUG=true` (debug-аутентификация), `SYNTH_DATA_DIR` (по умолчанию `<repo>/../data`; переопределяется env), `SYNTH_PORT`/`SYNTH_CORE_PORT`/`VITE_PORT`, `SYNTH_RESTART_MODE=supervisor` (перезапуск из UI: процесс выходит с кодом 75, скрипт поднимает его заново), а также `SYNTH_CONFIG=packages/backend/config.yaml` (только если файл существует) — поэтому `mcp.servers` из backend-конфига подхватываются в dev; `loadConfig` учитывает `SYNTH_CONFIG` (ADR-023). Подробности — [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

**Локальные контейнерные сценарии** (`docker-compose.yml`): профиль **`all-in-one`** — `docker compose --profile all-in-one up -d` (backend с toolchain'ом + UI + Postgres; режим исполнения `inline`, команды идут в процесс control plane); профиль **`split`** — `docker compose --profile split up -d` (backend **slim** в режиме `remote` + `synth-executor` + UI + Postgres + общий том workspace `synth-workspace`). В split-режиме backend получает `SYNTH_EXECUTION_MODE=remote` и адрес исполнителя, а токен доверия — **из файла** `.executor-token`, смонтированного как `/etc/synth/executor/token` (значение в env/config не хранится — инвариант 13); то же значение исполнитель получает в env `SYNTH_EXECUTOR_TOKEN`.

### Наблюдаемость

`GET /metrics` выключен по умолчанию (`metrics.enabled` / `SYNTH_METRICS_ENABLED`), опциональный bearer — `SYNTH_METRICS_TOKEN` либо `{dataDir}/secrets/metrics-token`; `GET /ready` доступен всегда. Отдельные серии `synth_pipeline_*` и `synth_executor_*` (каталоги — в [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md)), конфиг — [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) §«Наблюдаемость».

### Данные

Runtime-данные — в `$SYNTH_DATA_DIR` (env `SYNTH_DATA_DIR` или `storage.dataDir`, дефолт `/var/synth/data`); провайдеры/модели — JSON-файлы (или API), запись атомарная `.tmp.{uuid}` → `rename()`.

```text
$SYNTH_DATA_DIR/ → sessions/ projects/ providers/ models/ agents/ context/ blobs/(attachments/, artifacts/, skills/, processes/) auth/(sessions,states,profiles) secrets/(master.key, api-key, ssh-keys/, oauth/)
```

Локальный home — `--home`/`SYNTH_HOME` (ADR-079; приоритет: явные флаги > `--home` > env > XDG), разные home — независимые инстансы. Ротация мастер-ключа — `synth secrets rotate` (preflight → перешифровка → `master.key`; без `--yes`/`--dry-run` — отказ) — [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) §«Секреты», [docs/MAINTENANCE.md](./docs/MAINTENANCE.md).

### Списки: пагинация и сводные DTO (ADR-118 §4)

**Списки отдаются постранично** — объект `{<items>, total, offset, limit, next_offset}` (общие `parseBoundedInt`/`paginate` в `packages/core/src/server/pagination.ts`); `limit` — целое (иначе `400 VALIDATION_ERROR`), выше потолка **обрезается**; `next_offset: null` — последняя страница. Исключение — `GET /api/v2/models`: границы **жёсткие** (`limit` 1…500, иначе `400`).

**Списки — сводки:** `SessionManager.listSessions` без истории (полная — только `listSessionsWithMessages` для экспорта/публикации), сводка проекта — без `log`/`plan`, пайплайна — без `draft`, `projects/:id/stats` — без `total_messages`. Гибрид сквозной пагинации не даёт: при удалённых записях `next_offset: null`, `total` = локальные + удалённые. Контракт, DTO и исключения — [docs/API_V2.md](./docs/API_V2.md) §5 (блок «Пагинация списков»); детали — [packages/core/AGENTS.md](./packages/core/AGENTS.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md).

### Капы чтения файлов и diff (решение владельца, 2026-11-03)

- `GET /api/v2/fs/read` — cap `storage.maxReadBytes` (5 МиБ): размер известен из `stat` **до** чтения; больше лимита **или** бинарь → `413 FILE_TOO_LARGE` + `details`.
- `GET /api/v2/fs/raw` — cap `storage.maxPreviewBytes` (100 МиБ); **inline только** `image`/`video`/`audio`/`pdf`, остальное — `attachment` (XSS), SVG — CSP; `Range`/`206`, `ETag`/`304`.
- `GET /api/v2/fs` — `maxDepth` ≤ 3, бюджет **10 000** записей → `truncated: true`; `GET /api/v2/git/commit` — diff ≤ **1 МиБ** → `diff_truncated: true`.

Конфиг и коды — [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) §«Хранилище и рабочий каталог», [docs/API_V2.md](./docs/API_V2.md) §5.12/§5.15.

### Память (ADR-107, ADR-122)

Память — плагин (продукт и портал — [ADR-122](./docs/arch_decisions/adr-122-memory-product.md)); ядро даёт порты (`MemoryFactRepository`/`MemoryIndexRepository`), портал `/api/v2/memory/*` и сервисы фасада (`facade.memory`/`embed`/`security`). Область индекса — `project`/`instance` (инстансный создаёт только портал/ADMIN и **не отключается** — 409); мутации индексов, консолидация и граф — админ-тулами плагина. Обфускации при индексации **нет** (рекомендуются локальные эмбеддинги), политика исключений — `engine/security/secret-files.ts` через `facade.security`. Устройство, UI, CLI и метрики — [docs/MEMORY.md](./docs/MEMORY.md).

### Аутентификация

Все API (кроме `GET /health`) требуют аутентификации, иначе 401. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`; middleware `requireAuth`, `requirePermission` (первый в цепочке после CORS/logging).

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | тестовые ключи (ниже) |
| API Key | backend | прод без OIDC | `SYNTH_API_KEY` → ADMIN |
| OIDC | backend | прод с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve` (`--api-key`/`SYNTH_API_KEY`/`core.apiKey`; иначе авто-ключ в `{dataDir}/secrets/api-key`; host `127.0.0.1`) | один ключ → ADMIN (в гибриде — роли с сервера) |
| Service-key | оба | машинный доступ (ADR-052) | `Authorization: Bearer synth_svc_…` → синтетический пользователь `{id:'service:<keyId>', roles}` + `scopes`/`allowedProjects`; revoked/expired/unknown → 401 |

**Service-key (ADR-052).** Scoped-ключ инстанса, независимый от binding-key (ADR-089): `roles` + `scopes` (точечный гейт `requireScope`, wildcard-семейства, глобального `*` нет) + `allowedProjects` (иначе 403 `PROJECT_FORBIDDEN`); CRUD — `/api/v2/service-keys`, store `{dataDir}/service-keys.json`, секрет `synth_svc_…` — at-rest sha256, plaintext один раз. Провижининг — `security.bootstrapServiceKeys` (`SYNTH_BOOTSTRAP_SERVICE_KEYS`), идемпотентно, секрет не логируется. Детали — [docs/API_V2.md](./docs/API_V2.md) §5.28, [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

### Тестовые пользователи (debug)

Базовый URL: `http://localhost:5000/api/v2`, заголовок `Authorization: Bearer <ключ>`.

| Пользователь | Ключ | Роли |
|-------------|------|------|
| admin | admin-key-123 | ADMIN |
| developer | user-key-456 | USER |
| lead | lead-key-789 | LEAD |
| auditor | auditor-key-012 | AUDITOR |

### Runtime-настройки (API)

Полный справочник эндпоинтов, RBAC и кодов — [docs/API_V2.md](./docs/API_V2.md) §5; конфиг и приоритеты — [docs/CONFIGURATION.md](./docs/CONFIGURATION.md). Здесь только то, что нельзя пропустить:

- **Списки** — всегда страницы-сводки (см. «Списки: пагинация и сводные DTO»); auth-режимы — таблица «Аутентификация»; service-key — §5.28.
- **Особые контракты:** `/metrics` и `/ready` — вне `/api/v2`, `/api/v2/meta` — без auth (ADR-094/ADR-118 §8).
- **Runtime-настройки** — через `GET/PUT/DELETE /api/v2/settings/*` (live, где возможно; иначе `restartRequired`), не правкой файлов.

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
| **Публикации о Synth** (релиз, новый AD, репост) | `@publisher` + скилл `media-hub` (оба **поставляются пакетом** `synth-media`, не встроены в ядро) | «Сделай пост о релизе vX.Y.Z по skill media-hub» |

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
- Резолвинг `_resolveWorkingDir`: `session.worktree.directory` (привязка к worktree, ADR-114) → `project.workspace` → defaultWorkingDir; каталог проектного workspace создаётся автоматически (`mkdir -p`).
- Каталог `project.workspace` (ADR-075): managed — авто-имя `slugify(name)`+суффикс под `workspacesRoot`, смена workspace — владелец/LEAD/ADMIN; standalone — нормализация/создание + ручной выбор через FS-диалог. Путь вне `workspacesRoot` — по политике `storage.workspaceOutsideRoot` / `/api/v2/settings/workspace-policy` (`confirm` в standalone, `deny` в managed — read-only).
- Доступ к workspace по HTTP (ADR-075, `createFsRoutes`): ручной выбор корня — только standalone; в managed (`requireProjectId`) `/api/v2/fs/workspace-root*` отдают **403 `FORBIDDEN`** всем ролям (каталог проекта авто-провижнится, перечень управляемых workspace не раскрывается). `POST /api/v2/fs/upload` — лимит размера (по умолчанию 100 МиБ, `DEFAULT_MAX_UPLOAD_BYTES`, переопределяется опцией `FsRoutesOptions.maxUploadBytes`), превышение → `413 PAYLOAD_TOO_LARGE`.
- Тулы `plan_enter`, `plan_exit`, `get_project_info`, `list_repos` жёстко привязаны к `project.workspace`/сессии — path-параметры не принимают.
- Тулы `project_update`/`project_workspace_set`/`project_repo_clone|init|add|fetch|remove` работают с проектом сессии (подставить id/path другого проекта агент не может); смена workspace идёт через общий provisioning (`engine/workspace-provision.ts`) с политикой `workspaceOutsideRoot` — той же, что у HTTP-роута.
- Гейт `workspace` (ADR-075): file/shell/git-тулы доступны только при заданном `project.workspace`; иначе остаются в промпте, но permission-слой отклоняет их с причиной `workspace` (`engine/permission/availability.ts`, `isWorkspaceDependentTool`), а модели уходит схлопнутая подсказка. Относительные пути — только внутри `project.workspace`. После `project_create`/`project_attach`/`project_workspace_set` оркестратор перечитывает готовность workspace в том же ходе и разблокирует тулы.
- **Периметр инструментов.** Файловые, поисковые, shell- и git-инструменты работают внутри **рабочего каталога сессии ИЛИ корня проекта** (`project.workspace`): у сессии, привязанной к git-worktree (ADR-114), рабочий каталог — каталог worktree, но основной checkout проекта «внешним» не считается (как в opencode: `FileAccess.resolve` — internal = `location.directory` ИЛИ project worktree). Технически это `ToolContext.allowedRoots` (`workingDir` — база для **относительных** путей и каталог исполнения; containment — по `workingDir` + `allowedRoots`, `toolRoots`/`isSymlinkEscapeInRoots` в `engine/tools/path-utils.ts`). Относительный путь — норма; абсолютный путь вне периметра даёт `permission ask` (`external_directory`) и, как правило, отклоняется; путь внутри `allowedRoots` внешним не считается. Правило сказано модели трижды — в промпте (`prompts/system/MODE_POLICY.{ru,en}.md`, блок `[ГРАНИЦЫ РАБОЧЕГО КАТАЛОГА]` / `[WORKSPACE BOUNDARY]`), в блоке `session.info` (фактический рабочий каталог сессии + корень проекта, если отличается, и те же границы) и в описаниях тулов (`fs-read.ts`/`fs-write.ts`/`search.ts`: «Path is resolved against the project working directory…»). Служебные каталоги инстанса (`$SYNTH_DATA_DIR`: данные, роли, определения агентов) — **не** файлы проекта: не читать их файловыми тулами, сведения о проекте/инстансе/моделях брать `get_project_info`, `list_models`, `skill`; нужен файл вне периметра — попросить пользователя.
- Git-тулы (ADR-076) принимают необязательный `repo_path` — относительный путь внутри `project.workspace` (containment; абсолютный/`..` → `git.repo_path_invalid`); `list_repos` отдаёт записи реестра `project.repos` (`destination`/`name`/`url`/`type`/`sshKeyId`/`lastFetch` + git-детект). SSH-ключи per-agent хранятся зашифрованными (`secrets/ssh-keys/`), мастер-ключ — `SYNTH_SECRET_KEY`/`security.secretKey`/`secrets/master.key`.
- `attachments/` в workspace (ADR-115): сюда материализуются **отброшенные** вложения (`modality`/`limit`/`unavailable`, `engine/attachments/materialize.ts`) и сюда же выгружает доставленное вложение тул `save_attachment`. Имя санитайзится, публикация атомарная и **без перезаписи**, одинаковое содержимое дедуплицируется, иначе суффикс `-2`, `-3`, …; модели сообщается путь **относительно** workspace (`attachments/<name>`). Каталог живёт как обычные файлы проекта — автоматической уборки нет (удаляется вместе с проектом). Оригиналы вложений лежат **не здесь**: в сообщении только ссылка `blobPath` (`{dataDir}/blobs/attachments/<sha2>/<sha256>`, `blob_refs` — ADR-116).

Каталог групп и тулов (параметры, ограничения, capability, plan-режим, `deny`) — [docs/TOOLS.md](./docs/TOOLS.md).

- **Файлы/поиск** — `read_file`, `list_directory`, `glob`, `grep_files`, `write_file`, `edit_file`, `create_directory`, `delete_file`, `patch`.
- **Вложения (ADR-115)** — `attach_workspace_file`, `save_attachment`, `send_attachment`.
- **Shell/git** — `execute_shell`, `git_status|diff|log|commit|push|pull|checkout|branch_list|show|blame|stash`.
- **SSH-ключи/worktrees (ADR-076/114)** — `ssh_keys_list`, `git_worktree_list|create|remove|prune`.
- **План/ToDo** — `plan_enter|exit|read|list|write`, `todo_write|list|add|update|delete`.
- **Пайплайны/расписания (ADR-101/051)** — `pipeline_*`, `schedule_*`.
- **Процессы/задачи/вопрос (ADR-111/112/113)** — `process_list|logs|stop|delete`, `task`, `classify_conversation`, `read_session_reference`, `question`.
- **Проект/лог/инварианты** — `get_project_info`, `list_repos`, `project_*`, `project_log_*`, `project_invariants_*`.
- **Веб/модели** — `web_fetch`, `web_search`, `list_models`.
- **Профиль/скиллы** — `profile_update`, `skill`.

Встроенные скиллы `synth-pipelines`/`synth-schedules`, доступность групп (`ToolCapability`), MCP-слои и правило «deny не останавливает ход» — [docs/TOOLS.md](./docs/TOOLS.md).

**Роли агентов: прежний набор и миграция.** Набор ролей заменён: `pm`/`developer`/`qa`/`analyst`/`auditor` → `leader`/`fixer`/`tester`/`researcher`/`security-auditor`; каноническая карта — `LEGACY_AGENT_ROLE_ALIASES` (`engine/agents/migrations.ts`). Два шва, оба обязательны: (1) **миграция stored-агентов** при старте (`migrateLegacyStoredAgents` в `server/app/deps.ts` и `backend/app/deps.ts` до `registerStoredAgents`) — запись прежнего id переносит только пользовательские настройки (`enabled`, `provider`, `model`, `temperature`, `topP`, `topK`, `reasoningLevel`, `groups`) в **встроенное** определение целевого агента (идентичность, права, промпт, лимиты — из поставки), существующую целевую запись не перетирает, устаревшую удаляет, идемпотентна; (2) **runtime-алиас** (`ChatOrchestrator._resolveEffectiveAgentRole`) — у старых сессий `settings.agentRole` остаётся исторической меткой (`pm`), но промпт/capabilities/лимиты берутся у `leader`; фоллбек на `assistant` — только для роли, которой нет ни в реестре, ни в алиасах. Полнота ролевых файлов (RU+EN у каждого `contextFile`) закреплена тестом `engine/agents/definitions.test.ts`.

**Онбординг-интервью.** Блок `[INTERVIEW]` (`prompts/system/INTERVIEW.{lang}.md`) включается только в **первое сообщение сессии от пользователя** и при **незаполненном** профиле: флаг `interviewEligible` вычисляет оркестратор (`_interviewEligible` — первое «разговорное» сообщение, не `Scheduler`/системное, **и** `profile_update` доступен текущему агенту — capability `user` и тул не отключён админом; иначе fail-closed), `ContextBuilder` дополнительно проверяет `ProfileData.interviewCompleted`; `session.settings.showInterview` — мастер-выключатель. Агент проводит интервью и сохраняет ответы тулом `profile_update`. Статус — отдельное поле `ProfileData.interviewCompleted` (legacy-метка `[ИНТЕРВЬЮ]` в `notes` бэкфиллится в `FileProfileStore` при чтении).

## Вложения и мультимодальность (ADR-115)

Модель контента расширена аддитивно: медиа-часть несёт ссылку (`MediaPartData`: `blobPath`/`sha256`/`mime`/`size`/`name?`), `content` — плейсхолдер, `LLMMessage.attachments` — рядом с `content`. Оригиналы — в `{dataDir}/blobs/attachments/<sha2>/<sha256>` (content-addressed, `blob_refs`, ADR-116), в сообщении только ссылка. Загрузка — multipart, raw-body и chunked (TTL 1 ч); гидратация native → aux-текст → отброс; сжатие и `stripMetadata` — только на границе отправки; вложения тулов (`ToolResult.attachments`) попадают в **текущий** ход. Детали (протокол загрузки, миниатюры, derive, staging, GC, метрики) — [ADR-115](./docs/arch_decisions/adr-115-multimodal-input.md), [ADR-116](./docs/arch_decisions/adr-116-instance-state-and-blob-ports.md), HTTP — [docs/API_V2.md](./docs/API_V2.md) §5.6.1.

## Внешние события и хуки

Хуки — `HookBus` (`engine/hooks/`, ADR-030): `on/off/emit/emitAsync`, priority, sync (pre, blockable/patch) и async (post, fire-and-forget, timeout 5s); эмиты `pre_tool_use`/`post_tool_use`/`plan_approved`/`permission_denied`/`agent_spawned|completed|failed`/`session_start|end`.

События — `EventRouter` (`engine/events/`, ADR-089): `allowedSources` → dedup → `EventBinding` → `RouteRuleProvider` → фоллбек (`autoBind`/`defaultMode`); `EventIngress` — ingest, `EventDelivery` — `run`/`defer`, `DecisionRuleProvider` — decision-шаг; хранилища `{dataDir}/events/*`. Создание сессии — только через funnel (инвариант 15). Владелец — человек (`principalId`), в standalone нормализуется к `local`; права — роли профиля, `identity.roles` только **сужают** (fail-closed); ключи binding-key ≠ service-key (at-rest sha256). Расписания — ADR-051, webhooks — ADR-052 §5.29, конфиг `events`/`webhooks`/`decision`/`scheduler` — [docs/CONFIGURATION.md](./docs/CONFIGURATION.md), эндпоинты и коды — [docs/API_V2.md](./docs/API_V2.md).

## UI-конвенции

Правила компонентов, чата, панелей, настроек и мобильного адаптива — [packages/ui/AGENTS.md](./packages/ui/AGENTS.md); панель настроек — ADR-072; PWA — [ADR-044](./docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md).

- Мутация, видимая другому клиенту, публикует событие, а UI обязан его обработать (инвариант 27); `fs.changed` обновляет дерево/редакторы/Git с debounce.
- Вопрос — док над композером; фоновые прогоны — вкладка «Процессы»; worktrees — «Проект» + селектор каталога; вложения из тулов — служебный `Notice`; админ-разделы «Метрики»/«Аддоны» (API — `observabilityApi`, `packsApi`, `pipelinesApi`).
- Иконки и цвета — реестры `PROJECT_ICON_KEYS`/`PROJECT_COLOR_KEYS` (`shared/types`): валидация на записи (400), нормализация при чтении; UI — `EntityIconPicker`; детали — [packages/shared/AGENTS.md](./packages/shared/AGENTS.md).
- Мобильный адаптив — три зоны (≤768 / 769–1199 / ≥1200 px), классы на `<html>`, оверлей-дроверы, touch-first, `ConfirmDialog`, `useBackClose`; PWA — ручной app-shell, авто-обновление.

## Среды и деплой

| Среда | Что это | Как разворачивается |
|---|---|---|
| **dev** | локальная отладка | `./scripts/dev.sh` |
| **test** | внутренний тестовый, `https://synth.k3s.itphx.loc` | Fleet (`synth-deploy`): бандлы `synth-test`, `synth-gateway-telegram`, `synth-media`, `synth-test-allinone` (all-in-one); `gateway-email` — в `paths` закомментирован (чарт не опубликован); образы и чарты — в Gitea |
| **preprod** | `https://synth-release.k3s.itphx.loc` | публикуемый Helm-чарт (GitVerse), релизные образы `gitverse.ru` |
| **prod** | у нас отсутствует — разворачивают клиенты | публикуемый Helm-чарт (self-host) |

Правило: текущие изменения — **dev**; проверка перед релизом — **test** (Fleet); релиз — push master → сборка пакетов → **preprod**.

**K3s (test).** Namespace `synth`, код деплоя — отдельный репозиторий `synth-deploy`; Keycloak issuer `https://keycloak.itphx.loc/realms/synth` (клиент `synth`); доступ — `kubectl -n synth get pods|logs deploy/synth-backend`; учётки — [docs/KEYCLOAK.md](./docs/KEYCLOAK.md), процедуры — скилл `synth-k3s-deploy`, `synth-deploy/AGENTS.md`.

**Исполнитель (split-режим, ADR-077).** `@itphx/synth-executor`; при `execution.mode=remote` backend — тонкий control plane, команды уходят по HTTP (fail-closed). В чарте — пул `executor.*`: общий **RWX**-том workspace, токен из Secret, опциональный `NetworkPolicy`; альтернатива — `executor.workspace.existingClaim`. Протокол исполнителя — **5** (вложения MCP-результата), совместимость по `protocol`; спецификация — [docs/EXECUTION.md](./docs/EXECUTION.md), значения — `charts/synth/README.md`.

**CI и релиз.** Джобы — self-hosted раннер `synth-ci`; порядок сборки, особенности GitVerse, секреты, реестры образов, `security-gate` и публикация — [docs/PUBLISHING.md](./docs/PUBLISHING.md) §«CI/CD (GitVerse)»; внутренний аудит — [docs/security/README.md](./docs/security/README.md), скилл `synth-security-audit`. Перед тегом — обязательная пара `docs/releases/<version>.md` + `.en.md` (гейт `release-notes`); без неё релиз не собирается.

**Бета-канал.** `./scripts/publish-beta.sh` публикует все 8 пакетов в npm-реестр Gitea (`X.Y.Z-beta.<ts>.<sha>`, dist-tag `beta`/`next`, `latest` не двигается; CI — workflow `Beta packages`), `./scripts/beta-prune.sh --keep N` — ретеншн бет (по умолчанию только план, удаление — `--yes`); беты не проходят релизные гейты — [docs/PUBLISHING.md](./docs/PUBLISHING.md) §«Бета-версии (Gitea)».

## Индекс решений и предложений (ADR / PROP)

Сводка собирается скриптом: `pnpm adr:write` (`node scripts/adr-check.mjs --write`), проверка — `pnpm adr:check`. Полные таблицы и темы — [docs/arch_decisions/README.md](./docs/arch_decisions/README.md); правила и статусы — [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md); сроки — [docs/roadmap.md](./docs/roadmap.md).

<!-- ad-index:start -->
Всего документов: 106 (Решения: 50, Частично: 23, Предложения: 24, Vision: 7, Icebox: 1, Legacy: 1).
Удалено: 17 (принятые и поглощённые предложения).
Полные таблицы и темы — [docs/arch_decisions/README.md](./docs/arch_decisions/README.md); правила и статусы — [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md).
<!-- ad-index:end -->

Правило: `docs/arch_decisions/` — единственный дом ADR/PROP; номера стабильны и не переиспользуются. ADR-файлы не переносятся и не удаляются; PROP удаляется после принятия/поглощения (связь — `Источник` в ADR и таблица в README).

## Куда смотреть (триггеры)

| Трогаешь | Читай |
|---|---|
| пользовательская документация / портал | https://docs.synth.itphx.ru/ |
| документация (портал и dev-доки) | скилл `synth-docs` |
| storage / JSON / FileStore / порты / деградация | [ADR-005](./docs/arch_decisions/adr-005-json-storage.md), [ADR-096](./docs/arch_decisions/adr-096-storage-layer.md), [ADR-097](./docs/arch_decisions/adr-097-storage-provider-class.md), [ADR-116](./docs/arch_decisions/adr-116-instance-state-and-blob-ports.md), [ADR-098](./docs/arch_decisions/adr-098-storage-degraded-recovery.md), скилл `synth-storage-recovery` |
| события / WS / SSE / хуки / роутинг сессий | [ADR-008](./docs/arch_decisions/adr-008-websocket-events.md), [ADR-009](./docs/arch_decisions/adr-009-session-event-bus.md), [ADR-024](./docs/arch_decisions/adr-024-eventhub-transport.md), [ADR-030](./docs/arch_decisions/adr-030-hooks-agent-events.md), [ADR-089](./docs/arch_decisions/adr-089-external-events-automation.md) |
| связь / переподключение / офлайн / PWA-возврат из фона | [ADR-123](./docs/arch_decisions/adr-123-connection-state-and-offline-ux.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| проект / сессии / ветвление / merge | [ADR-014](./docs/arch_decisions/adr-014-project-container.md), [ADR-033](./docs/arch_decisions/adr-033-session-branching-merge.md), [ADR-040](./docs/arch_decisions/adr-040-sessions-without-project.md) |
| API v2 / Hono / пагинация / сводные DTO | [ADR-017](./docs/arch_decisions/adr-017-api-v2-hono.md), [docs/API_V2.md](./docs/API_V2.md) §5 (в т.ч. «Пагинация списков»), [packages/core/AGENTS.md](./packages/core/AGENTS.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| капы чтения / предпросмотр / листинг FS / diff коммита | [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) §«Хранилище и рабочий каталог», [docs/API_V2.md](./docs/API_V2.md) §5.12/§5.15 |
| движки / engine | [ADR-018](./docs/arch_decisions/adr-018-session-engine-selection.md), [ADR-022](./docs/arch_decisions/adr-022-typescript-stack-runner.md), [PROP-050](./docs/arch_decisions/prop-050-external-engines-runner.md) (поле `Session.engine` удалено из контракта) |
| UI / React / PWA / иконки и цвета | [ADR-019](./docs/arch_decisions/adr-019-react-spa.md), [ADR-044](./docs/arch_decisions/adr-044-mobile-adaptive-ui-pwa.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md), [packages/shared/AGENTS.md](./packages/shared/AGENTS.md) |
| саб-агенты / фоновые прогоны / процессы / вопрос | [ADR-026](./docs/arch_decisions/adr-026-subagent-context-modes.md), [ADR-111](./docs/arch_decisions/adr-111-background-subagent-sessions.md) (§detach), [ADR-113](./docs/arch_decisions/adr-113-background-processes.md), [ADR-112](./docs/arch_decisions/adr-112-user-questions-mid-turn.md), [docs/API_V2.md](./docs/API_V2.md) §5.5 |
| permissions / plan-act / полномочия / locked settings | [ADR-025](./docs/arch_decisions/adr-025-plan-act-toggle.md), [ADR-028](./docs/arch_decisions/adr-028-plan-build-strictness.md), [ADR-029](./docs/arch_decisions/adr-029-granular-permissions.md), [ADR-106](./docs/arch_decisions/adr-106-authority-layer.md), [docs/AUTHORITY.md](./docs/AUTHORITY.md), [PROP-083](./docs/arch_decisions/prop-083-instance-customization-branding.md) |
| внешние доступы / OAuth-коннекторы | [ADR-105](./docs/arch_decisions/adr-105-external-credentials.md), [docs/EXTERNAL_ACCESS.md](./docs/EXTERNAL_ACCESS.md) |
| steering / поток хода / `messageModel` / догон / meta | [ADR-104](./docs/arch_decisions/adr-104-mid-turn-steering.md), [ADR-118](./docs/arch_decisions/adr-118-message-stream-v2.md), [docs/MESSAGE_FLOW.md](./docs/MESSAGE_FLOW.md), [docs/API_V2.md](./docs/API_V2.md) §3.3/§5.4 |
| сжатие контекста / суммаризация / компактизация / overflow | [ADR-119](./docs/arch_decisions/adr-119-context-compaction.md), [ADR-070](./docs/arch_decisions/adr-070-system-prompt-composer.md), [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) §«Дефолты оптимизации контекста для новых сессий» |
| конфиг / локальный home / пути | [ADR-023](./docs/arch_decisions/adr-023-configuration.md), [docs/CONFIGURATION.md](./docs/CONFIGURATION.md), [ADR-079](./docs/arch_decisions/adr-079-local-home-independent-instances.md), [ADR-045](./docs/arch_decisions/adr-045-hybrid-server-profiles.md) |
| routing / микро-слой / провайдеры / модели | [ADR-034](./docs/arch_decisions/adr-034-model-routing.md), [ADR-035](./docs/arch_decisions/adr-035-micro-model-first.md), [ADR-084](./docs/arch_decisions/adr-084-decision-models-clef.md), [ADR-117](./docs/arch_decisions/adr-117-provider-compatibility.md), [docs/ROUTING.md](./docs/ROUTING.md), [docs/PROVIDERS.md](./docs/PROVIDERS.md), [docs/LLM_PROVIDERS.md](./docs/LLM_PROVIDERS.md) |
| безопасность / gateway / целостность клиента / soft-delete | [ADR-036](./docs/arch_decisions/adr-036-llm-gateway.md), [PROP-073](./docs/arch_decisions/prop-073-client-integrity-hybrid.md), [PROP-074](./docs/arch_decisions/prop-074-soft-delete-retention.md) |
| workspace / worktrees / git-репозитории / SSH-ключи | [ADR-075](./docs/arch_decisions/adr-075-project-workspace-provisioning.md), [ADR-114](./docs/arch_decisions/adr-114-git-worktrees.md), [docs/WORKTREES.md](./docs/WORKTREES.md), [ADR-076](./docs/arch_decisions/adr-076-git-repo-registry-ssh.md) |
| инструменты / образы / тулчейн / executor | [ADR-077](./docs/arch_decisions/adr-077-runtime-toolchain.md), [ADR-078](./docs/arch_decisions/adr-078-runtime-dependency-availability.md), [docs/EXECUTION.md](./docs/EXECUTION.md), [docs/TOOLS.md](./docs/TOOLS.md) |
| план / todo | [ADR-039](./docs/arch_decisions/adr-039-plan-in-project.md) |
| ошибки LLM / i18n | [ADR-041](./docs/arch_decisions/adr-041-llm-error-taxonomy.md) |
| гибрид | [ADR-042](./docs/arch_decisions/adr-042-hybrid-mode.md), [ADR-043](./docs/arch_decisions/adr-043-unified-identity-login.md), [ADR-045](./docs/arch_decisions/adr-045-hybrid-server-profiles.md), [PROP-080](./docs/arch_decisions/prop-080-managed-hybrid-modes.md), [PROP-081](./docs/arch_decisions/prop-081-hybrid-policy-leak-protection.md), [docs/HYBRID.md](./docs/HYBRID.md), скилл `synth-hybrid` |
| OIDC / Keycloak / RBAC | [docs/KEYCLOAK.md](./docs/KEYCLOAK.md), [docs/API_V2.md](./docs/API_V2.md) §5.28 |
| npm / Docker / Helm / релиз / CI / аудит | [ADR-038](./docs/arch_decisions/adr-038-npm-packages.md), [docs/PUBLISHING.md](./docs/PUBLISHING.md), [docs/security/README.md](./docs/security/README.md), [docs/security/AUDIT-CHECKLIST.md](./docs/security/AUDIT-CHECKLIST.md), скиллы `synth-build-publish`, `synth-release`, `synth-security-audit` |
| бета-пакеты / быстрая сборка для local/hybrid | скилл `synth-beta-publish`, [docs/PUBLISHING.md](./docs/PUBLISHING.md) §«Бета-версии (Gitea)» |
| K3s / dev-окружение / MCP GitVerse / API-тесты | скиллы `synth-k3s-deploy`, `synth-dev`, `synth-gitverse-mcp`, `synth-api-testing`, `synth-deploy/AGENTS.md`, [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) |
| скиллы / команды / реестр скиллов и агентов | [ADR-046](./docs/arch_decisions/adr-046-skills-and-slash-commands.md), [PROP-068](./docs/arch_decisions/prop-068-skills-agents-registry.md) |
| инструкции AGENTS.md | [ADR-069](./docs/arch_decisions/adr-069-project-instructions-agents-md.md), скилл `synth-agents-md` |
| промпт / prompt-cache / MCP в промпте | [ADR-070](./docs/arch_decisions/adr-070-system-prompt-composer.md), [ADR-071](./docs/arch_decisions/adr-071-mcp-servers-prompt.md), [ADR-029](./docs/arch_decisions/adr-029-granular-permissions.md), [ADR-036](./docs/arch_decisions/adr-036-llm-gateway.md) |
| настройки / settings UI kit / кастомизация / брендинг | [ADR-072](./docs/arch_decisions/adr-072-settings-ui-kit.md), [PROP-083](./docs/arch_decisions/prop-083-instance-customization-branding.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| мессенджеры / шлюзы | [ADR-087](./docs/arch_decisions/adr-087-gateways.md), [ADR-103](./docs/arch_decisions/adr-103-gateway-core-channel-contract.md) |
| шедулер / пайплайны | [ADR-051](./docs/arch_decisions/adr-051-scheduler-pipelines.md), [ADR-100](./docs/arch_decisions/adr-100-extension-packs-pipelines.md), [ADR-101](./docs/arch_decisions/adr-101-pipeline-engine.md), [docs/PIPELINES.md](./docs/PIPELINES.md), [PROP-057](./docs/arch_decisions/prop-057-loop-engine.md) |
| плагины / add-on / editions / MCP-сервер Synth | [ADR-086](./docs/arch_decisions/adr-086-extensibility-plugins-editions.md), [ADR-090](./docs/arch_decisions/adr-090-extension-api.md), [docs/PLUGINS.md](./docs/PLUGINS.md), [PROP-068](./docs/arch_decisions/prop-068-skills-agents-registry.md), [PROP-056](./docs/arch_decisions/prop-056-synth-mcp-server.md), [PROP-048](./docs/arch_decisions/prop-048-self-help-skills-admin-mcp.md) |
| публикации о Synth / новый AD / версионирование документации | скилл `media-hub` + агент `publisher` (пакет `synth-media`), [PROP-093](./docs/arch_decisions/prop-093-docs-versioning.md), скилл `synth-docs` |
| прокси / egress / TLS / CA / адресная политика | [ADR-099](./docs/arch_decisions/adr-099-egress-tls-trust.md), [PROP-100](./docs/arch_decisions/prop-100-ssrf-dns-rebinding.md), [ADR-071](./docs/arch_decisions/adr-071-mcp-servers-prompt.md) §2.3.1, [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) |
| бэкап / восстановление / экспорт / импорт / миграции / перезапуск | [ADR-091](./docs/arch_decisions/adr-091-backup-restore-transfer.md), [ADR-092](./docs/arch_decisions/adr-092-instance-lifecycle-maintenance.md), [ADR-005](./docs/arch_decisions/adr-005-json-storage.md), [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) |
| аналитика / отчёты / роллапы стоимости | [ADR-102](./docs/arch_decisions/adr-102-analytics-reports.md), [docs/API_V2.md](./docs/API_V2.md) §5.32, [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) §«Аналитика и отчётность» |
| наблюдаемость / метрики / health / ready / SLO | [ADR-094](./docs/arch_decisions/adr-094-observability-metrics.md), [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md) |
| мультимодальный ввод / вложения / загрузка / миниатюры / сжатие | [ADR-115](./docs/arch_decisions/adr-115-multimodal-input.md), [ADR-116](./docs/arch_decisions/adr-116-instance-state-and-blob-ports.md), [docs/API_V2.md](./docs/API_V2.md) §5.6.1 |
| память / факты / индексы / recall | [docs/MEMORY.md](./docs/MEMORY.md), [ADR-107](./docs/arch_decisions/adr-107-plugin-facade-services.md), [ADR-122](./docs/arch_decisions/adr-122-memory-product.md) |
| CLI / TUI / Kanban / backlog | [PROP-053](./docs/arch_decisions/prop-053-cli-tui.md), [PROP-054](./docs/arch_decisions/prop-054-kanban-backlog.md), [PROP-065](./docs/arch_decisions/prop-065-ui-docs-plan-todo.md) |

## Документация

Разделение аудиторий: **пользовательская документация** — портал [docs.synth.itphx.ru](https://docs.synth.itphx.ru/) (RU по умолчанию, EN — `/en/`), в репозитории не дублируется; **для разработчиков** — `docs/` и `AGENTS.md`. Полный список — каталог `docs/` и [README.md](./README.md).

- [docs/API_V2.md](./docs/API_V2.md) — API v2: эндпоинты, RBAC, коды, пагинация, транспорт; [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) — конфигурация и runtime-настройки.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/ARCH_DECISIONS.md](./docs/ARCH_DECISIONS.md), [docs/roadmap.md](./docs/roadmap.md), [docs/arch_decisions/README.md](./docs/arch_decisions/README.md) — архитектура, правила ADR/PROP, индекс и сроки.
- [docs/MESSAGE_FLOW.md](./docs/MESSAGE_FLOW.md), [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md), [docs/MEMORY.md](./docs/MEMORY.md), [docs/PIPELINES.md](./docs/PIPELINES.md), [docs/WORKTREES.md](./docs/WORKTREES.md) — подсистемы.
- [docs/PUBLISHING.md](./docs/PUBLISHING.md), [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md), [docs/MAINTENANCE.md](./docs/MAINTENANCE.md), [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) — сборка/релиз, dev-окружение, эксплуатация.
- Скиллы и процедуры — `.opencode/skills/`; пакетные правила — `packages/<pkg>/AGENTS.md`; [docs/TOOLS.md](./docs/TOOLS.md) — каталог инструментов.
