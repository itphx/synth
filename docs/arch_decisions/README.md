# Архитектурные решения и предложения (ADR / PROP)

> Индекс каталога: **ADR** — принятые решения (`adr-*.md`), **PROP** — предложения (`prop-*.md`).
> Правила ведения, жизненный цикл и классы документов — [docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md);
> предложения и сроки решений — [docs/roadmap.md](../roadmap.md).
> Номера стабильны: файлы не переносятся и не удаляются (ссылок на id по репозиторию — тысячи).

Таблицы собираются автоматически — вручную не правь:
`node scripts/adr-check.mjs --write` (проверка — `node scripts/adr-check.mjs`).

## Решения

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| ADR-005 | JSON-файлы как хранилище (атомарная запись tmp + rename) | ✅ Реализовано | [adr-005-json-storage.md](./adr-005-json-storage.md) |
| ADR-008 | WebSocket для real-time событий | ✅ Реализовано | [adr-008-websocket-events.md](./adr-008-websocket-events.md) |
| ADR-009 | SessionEventBus — шина событий сессии | ✅ Реализовано | [adr-009-session-event-bus.md](./adr-009-session-event-bus.md) |
| ADR-014 | Проект как контейнер (сессии, файлы, контекст) | ✅ Реализовано | [adr-014-project-container.md](./adr-014-project-container.md) |
| ADR-017 | Собственный API-контракт (API v2 на Hono) | ✅ Реализовано | [adr-017-api-v2-hono.md](./adr-017-api-v2-hono.md) |
| ADR-019 | React 19 SPA с нуля (без форка OpenChamber) | ✅ Реализовано | [adr-019-react-spa.md](./adr-019-react-spa.md) |
| ADR-022 | Единый TypeScript стек + Runner архитектура | ✅ Реализовано | [adr-022-typescript-stack-runner.md](./adr-022-typescript-stack-runner.md) |
| ADR-023 | Единая система конфигурации (@itphx/synth-shared/config) | ✅ Реализовано | [adr-023-configuration.md](./adr-023-configuration.md) |
| ADR-024 | Единый транспорт: EventHub + TransportClient | ✅ Реализовано | [adr-024-eventhub-transport.md](./adr-024-eventhub-transport.md) |
| ADR-025 | Plan/Act как глобальный permission toggle | ✅ Реализовано | [adr-025-plan-act-toggle.md](./adr-025-plan-act-toggle.md) |
| ADR-026 | Режимы контекста саб-агента: none / inherit / summary / last_n | ✅ Реализовано | [adr-026-subagent-context-modes.md](./adr-026-subagent-context-modes.md) |
| ADR-028 | Настраиваемая строгость цикла Plan → Build | ✅ Реализовано | [adr-028-plan-build-strictness.md](./adr-028-plan-build-strictness.md) |
| ADR-029 | Гранулярные permissions: allow/deny/ask + file patterns | ✅ Реализовано | [adr-029-granular-permissions.md](./adr-029-granular-permissions.md) |
| ADR-033 | Ветвление сессий и межсессионное слияние | ✅ Реализовано | [adr-033-session-branching-merge.md](./adr-033-session-branching-merge.md) |
| ADR-034 | Routing между моделями (content + confidence + cost) | ✅ Реализовано | [adr-034-model-routing.md](./adr-034-model-routing.md) |
| ADR-035 | Micro-model first: дешёвый слой перед LLM | ✅ Реализовано | [adr-035-micro-model-first.md](./adr-035-micro-model-first.md) |
| ADR-036 | LLM Gateway: слой безопасности (guard + обфускация + аудит) | ✅ Реализовано | [adr-036-llm-gateway.md](./adr-036-llm-gateway.md) |
| ADR-038 | Монорепо как набор публикуемых npm-пакетов | ✅ Реализовано | [adr-038-npm-packages.md](./adr-038-npm-packages.md) |
| ADR-039 | План — в проекте, todo — в сессии (замена TSM) | ✅ Реализовано | [adr-039-plan-in-project.md](./adr-039-plan-in-project.md) |
| ADR-040 | Сессии без проекта и перенос между проектами | ✅ Реализовано | [adr-040-sessions-without-project.md](./adr-040-sessions-without-project.md) |
| ADR-041 | Единая таксономия ошибок LLM + контракт локализации | ✅ Реализовано | [adr-041-llm-error-taxonomy.md](./adr-041-llm-error-taxonomy.md) |
| ADR-042 | Гибридный режим: локальный core + централизованный сервер | ✅ Реализовано | [adr-042-hybrid-mode.md](./adr-042-hybrid-mode.md) |
| ADR-043 | Единая идентичность гибрида: вход в UI без Keycloak | ✅ Реализовано | [adr-043-unified-identity-login.md](./adr-043-unified-identity-login.md) |
| ADR-044 | Адаптивный мобильный UI + PWA | ✅ Реализовано | [adr-044-mobile-adaptive-ui-pwa.md](./adr-044-mobile-adaptive-ui-pwa.md) |
| ADR-045 | Профили серверов и лёгкий runtime-вход в гибриде: единый dataDir, мета-реестр profiles.json, logout = забыть токен + revoke | ✅ Реализовано | [adr-045-hybrid-server-profiles.md](./adr-045-hybrid-server-profiles.md) |
| ADR-052 | Публичная API-платформа: service-key + scopes + проектная проекция `allowedProjects` + API/UI; webhooks (HMAC, retry/backoff, SSRF); public-OpenAPI (28 операций) + SDK `@itphx/synth-sdk`; перевод мессенджер-шлюза на scoped service-key; **tenants исключены** (изоляция = инстанс, группировка = проект) | ✅ Реализовано | [adr-052-public-api-platform.md](./adr-052-public-api-platform.md) |
| ADR-069 | Проектные инструкции (AGENTS.md) и `/init`: discovery, merged chain git root→cwd, lazy-догрузка, threat-scan, install-tree guard | ✅ Реализовано | [adr-069-project-instructions-agents-md.md](./adr-069-project-instructions-agents-md.md) |
| ADR-070 | SystemPromptComposer: консистентность промпта, prompt-cache, статистика и прозрачность | ✅ Реализовано | [adr-070-system-prompt-composer.md](./adr-070-system-prompt-composer.md) |
| ADR-071 | MCP-серверы: уровни system/project/session, единый реестр, разделение `tools`/`mcp.tools`, блоки `mcp.servers`/`mcp.status`, политики `tools.policy`/`mcp.policy`, admin-отключение встроенных инструментов | ✅ Реализовано | [adr-071-mcp-servers-prompt.md](./adr-071-mcp-servers-prompt.md) |
| ADR-072 | Settings UI Kit: единая панель настроек (один скролл, центрирование `max-w-3xl`, контракт черновика, контролы); все разделы и админ-категории мигрированы | ✅ Реализовано | [adr-072-settings-ui-kit.md](./adr-072-settings-ui-kit.md) |
| ADR-075 | Окружение проекта: рабочий каталог (автосоздание managed, выбор и политика путей для standalone; FS-паритет, RBAC) | ✅ Реализовано | [adr-075-project-workspace-provisioning.md](./adr-075-project-workspace-provisioning.md) |
| ADR-076 | Реестр git-репозиториев (несколько на проект) и SSH-ключи per-agent (шифрование at-rest, `repo_path`, паритет core↔backend) | ✅ Реализовано | [adr-076-git-repo-registry-ssh.md](./adr-076-git-repo-registry-ssh.md) |
| ADR-078 | Авто-отключение инструментов при отсутствии внешней зависимости (детект `git`/`rg`/`sh`, `unavailable(dependency)`, пояснение модели и UI) | ✅ Реализовано | [adr-078-runtime-dependency-availability.md](./adr-078-runtime-dependency-availability.md) |
| ADR-079 | Локальный home-каталог (`--home`/`SYNTH_HOME`): плоская раскладка config/data/profiles/credentials, приоритеты путей, независимые инстансы standalone и hybrid | ✅ Реализовано | [adr-079-local-home-independent-instances.md](./adr-079-local-home-independent-instances.md) |
| ADR-084 | Decision-модели (Clef/Clef-Flash): `DecisionProvider` (контракт `state + questions → answers`: `noul`/`choice`/`score`; транспорты RouterAI и Ollama; вызов через `GatewayProvider`) + decision-слой в «Быстрых ответах» (уровень микро-каскада ADR-035, per-session `decisionFirst`), «Маршрутизации» (классификатор категории ADR-034) и внешних событиях (ADR-089, `events.decisionRouting`); эскалация `primary → escalation`, агрегатные метрики (`GET/DELETE /settings/decision/metrics`), мультимодальный контракт (`images`/`videos`; источник — PROP-085); runtime-настройки `GET/PUT/DELETE /settings/decision` + UI-раздел «Decision-модели» | ✅ Реализовано | [adr-084-decision-models-clef.md](./adr-084-decision-models-clef.md) |
| ADR-089 | Платформа внешних событий: ядро Event/Binding/Router, единый funnel `RequestSessionService`, ingress/API (bindings, keys, journal)/UI, источник ADR-051 (cron), API-ключи привязок (label/лимит/revoke + per-key rate limit), retention журнала, runtime-настройки «События», auto-bind (`events.autoBind`); ADR-052 ✅ (этапы I–IV: binding-key, service-key + scopes + `allowedProjects`, webhooks, public-OpenAPI + SDK, перевод шлюза); первый add-on — Telegram-шлюз — реализован; вне объёма — Plugin SDK (PROP-090, вернулся в работу 2026-10-22), пайплайны (ADR-101), HA/второй канал (ADR-087) | ✅ Реализовано | [adr-089-external-events-automation.md](./adr-089-external-events-automation.md) |
| ADR-095 | Декомпозиция god-объектов — «вынос по швам» | ✅ Реализовано | [adr-095-god-object-decomposition.md](./adr-095-god-object-decomposition.md) |
| ADR-096 | Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами | ✅ Реализовано | [adr-096-storage-layer.md](./adr-096-storage-layer.md) |
| ADR-101 | Pipeline Engine: пайплайн как второй движок рядом с оркестратором | ✅ Реализовано | [adr-101-pipeline-engine.md](./adr-101-pipeline-engine.md) |

## Частично

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| ADR-018 | Выбор AI-движка на уровне сессии (выбор движка персистится, механика — в работе) | ⚠️ Частично | [adr-018-session-engine-selection.md](./adr-018-session-engine-selection.md) |
| ADR-030 | Hooks для событий агента: hook-шина `HookBus` + эмиты жизненного цикла (`session_requested`, `external_event`); Plugin SDK и загрузка плагинов (PROP-090 — вернулся в работу 2026-10-22), 4 эмита (`plan_rejected`/`message_received`/`callback`/`schedule_fired`) и политика `builtin` (Ф0 PROP-090) — нет | ⚠️ Частично | [adr-030-hooks-agent-events.md](./adr-030-hooks-agent-events.md) |
| ADR-046 | Скиллы и slash-команды: формат `SKILL.md`, discovery, progressive disclosure, core-тул `skill`, команды/bundles, scope-API, UI; Фаза 3 — trust-гейт проектных команд, inline shell, `skills.urls` read-only, внешние каталоги, builtin `skill-creator`; остаток — install/trust/подписи/`lock.json` и backend-админка каталога (PROP-068) | ⚠️ Частично | [adr-046-skills-and-slash-commands.md](./adr-046-skills-and-slash-commands.md) |
| ADR-051 | Шедулер: `SchedulerService` (cron/interval) + источник `schedule_fired` через Router (ADR-089), Job-история (`JobStore`), catch-up (`skip`/`once`), force-запуск, API/UI расписаний и истории; пайплайны вынесены в ADR-100/ADR-101 (движок реализован), размещение в гибриде — нет; мульти-инстанс — семы file-based (default OFF) | ⚠️ Частично | [adr-051-scheduler-pipelines.md](./adr-051-scheduler-pipelines.md) |
| ADR-077 | Инструментальное окружение исполнения (toolchain и executor): thin backend + сервис-executor, общий volume для workspace, S3; реализуется после ADR-097 (PostgreSQL) | ⚠️ Частично | [adr-077-runtime-toolchain.md](./adr-077-runtime-toolchain.md) |
| ADR-086 | Расширяемость Synth (зонтик «Классы расширений»): Plugin (PROP-090), **Gateway** (ADR-087), Add-on, контент-паки (PROP-068), Editions, Contribution flow; единый манифест `synth.pack`; первый add-on/gateway — Telegram-шлюз — реализован и мультитенантен; Plugin SDK (PROP-090 — в работе, в коде нет; два режима исполнения: inline/out-of-process)/editions/contribution — нет | ⚠️ Частично | [adr-086-extensibility-plugins-editions.md](./adr-086-extensibility-plugins-editions.md) |
| ADR-087 | **Шлюзы (gateways)** — отдельный класс расширений (внешний сервис-транспорт внешний мир ↔ Synth, двусторонний обмен): контракт (приём через `POST /api/v2/events`, доставка наружу через SSE-watcher, MCP-часть, Binding, identity/claim-flow, allowlist, вложения, дедуп, прокси/egress, секреты at-rest); Telegram-шлюз (`addons/synth-gateway-telegram`) реализован и **мультитенантен** («несколько ботов → несколько сред», `tenants.json`); публикация в канал — агентом через MCP шлюза (ADR-089); HA через leader election, webhook-транспорт, второй канал — нет | ⚠️ Частично | [adr-087-gateways.md](./adr-087-gateways.md) |
| ADR-091 | Бэкап, восстановление и диагностика инстанса — свой контур `backup`/`restore`/`doctor` | ⚠️ Частично | [adr-091-backup-restore-transfer.md](./adr-091-backup-restore-transfer.md) |
| ADR-092 | Обслуживание инстанса — версия схемы данных, миграции и удаление | ⚠️ Частично | [adr-092-instance-lifecycle-maintenance.md](./adr-092-instance-lifecycle-maintenance.md) |
| ADR-094 | Наблюдаемость — Prometheus-метрики, liveness/readiness и эксплуатационные алерты | ⚠️ Частично | [adr-094-observability-metrics.md](./adr-094-observability-metrics.md) |
| ADR-097 | Класс расширения «хранилище» (storage) — контракт портов, драйверы из коробки | ⚠️ Частично | [adr-097-storage-provider-class.md](./adr-097-storage-provider-class.md) |
| ADR-098 | Деградированный режим и восстановление хранилища | ⚠️ Частично | [adr-098-storage-degraded-recovery.md](./adr-098-storage-degraded-recovery.md) |
| ADR-099 | Единый egress-слой: доверие TLS/CA (mTLS, bootstrap `security-tls.json`, per-host профили, UI), адресная политика (`egress.tools`/`egress.webhooks`, `mcp.networkPolicy`) и HTTP/HTTPS/SOCKS5-прокси (`proxy.*`, Basic, `no_proxy`, proxied-режим, runtime-настройка из админ-UI, аудит и журнал); доменная аутентификация прокси (NTLM/Negotiate/Kerberos) — вне scope, делегируется egress-шлюзу | ⚠️ Частично | [adr-099-egress-tls-trust.md](./adr-099-egress-tls-trust.md) |
| ADR-100 | Пакет расширения и пайплайн в ядре: единый контракт доставки (`synth.pack`) и учёт прогонов | ⚠️ Частично | [adr-100-extension-packs-pipelines.md](./adr-100-extension-packs-pipelines.md) |
| ADR-102 | Аналитика и отчётность инстанса | ⚠️ Частично | [adr-102-analytics-reports.md](./adr-102-analytics-reports.md) |
| ADR-103 | Ядро шлюзов (`@itphx/synth-gateway-core`) и контракт канала | ⚠️ Частично | [adr-103-gateway-core-channel-contract.md](./adr-103-gateway-core-channel-contract.md) |

## Предложения

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| PROP-031 | Verification синт | 🧩 Предложение | [prop-031-verification-agent.md](./prop-031-verification-agent.md) |
| PROP-037 | Security step перед коммитом | 🧩 Предложение | [prop-037-commit-security-step.md](./prop-037-commit-security-step.md) |
| PROP-048 | Self-help скиллы и admin-MCP: dogfooding, runbook-скиллы, read-only status-MCP, deploy-тулы, гейтинг ADMIN | 🧩 Предложение | [prop-048-self-help-skills-admin-mcp.md](./prop-048-self-help-skills-admin-mcp.md) |
| PROP-049 | Git worktrees: тулы `git_worktree_*`, per-session cwd, детект secondary worktree, UI | 🧩 Предложение | [prop-049-git-worktrees.md](./prop-049-git-worktrees.md) |
| PROP-050 | Внешние движки (opencode/cline) — Runner: EngineManager, адаптеры, WS-канал backend↔runner, LLM Proxy :9090 | 🧩 Предложение | [prop-050-external-engines-runner.md](./prop-050-external-engines-runner.md) |
| PROP-053 | CLI и TUI: паритет публикуемого и dev-CLI, CLI как клиент API v2, TUI | 🧩 Предложение | [prop-053-cli-tui.md](./prop-053-cli-tui.md) |
| PROP-054 | Kanban-доска, backlog: интерактивная доска поверх `project.plan`, глобальный backlog, assignee/WIP | 🧩 Предложение | [prop-054-kanban-backlog.md](./prop-054-kanban-backlog.md) |
| PROP-056 | MCP-сервер Synth и скиллы для внешних агентов: MCP над API v2, auth, права, форматы конфигов клиентов | 🧩 Предложение | [prop-056-synth-mcp-server.md](./prop-056-synth-mcp-server.md) |
| PROP-062 | Умная оптимизация контекста: `archive_context`, авто-суммаризация, приоритизация, стратегии | 🧩 Предложение | [prop-062-context-optimization.md](./prop-062-context-optimization.md) |
| PROP-064 | Встроенные в UI браузер и терминал: PTY/WS-терминал, webview/iframe-браузер, синхронизация с агентом | 🧩 Предложение | [prop-064-ui-browser-terminal.md](./prop-064-ui-browser-terminal.md) |
| PROP-065 | Просмотр документации, планов и ToDo в UI: docs-браузер, редактор плана/todo, связи, внешний vault | 🧩 Предложение | [prop-065-ui-docs-plan-todo.md](./prop-065-ui-docs-plan-todo.md) |
| PROP-066 | Скиллы и гайдлайны оформления документации: doc-стандарты, шаблоны, авто-проверка (docs-lint) | 🧩 Предложение | [prop-066-doc-style-skills.md](./prop-066-doc-style-skills.md) |
| PROP-068 | Реестр и каталог скиллов и агентов: свой репозиторий, индекс, trust/guard, install-policy, agent-packs | 🧩 Предложение | [prop-068-skills-agents-registry.md](./prop-068-skills-agents-registry.md) |
| PROP-073 | Целостность клиента в гибриде: клиент недоверенный, enforcement на сервере; сигналы (подписи, DPoP/mTLS) опционально | 🧩 Предложение | [prop-073-client-integrity-hybrid.md](./prop-073-client-integrity-hybrid.md) |
| PROP-074 | Скрытие вместо удаления: soft-delete проектов/сессий/сообщений, исключение из LLM-контекста, read-only режим ADMIN/AUDITOR, restore/purge — ADMIN | 🧩 Предложение | [prop-074-soft-delete-retention.md](./prop-074-soft-delete-retention.md) |
| PROP-080 | Управляемый гибрид: режимы-полюса, идентичность и установка локально: режим — параметр запуска, без runtime-переключения, standalone=ADMIN / hybrid=роли сервера, «Установить локально» | 🧩 Предложение | [prop-080-managed-hybrid-modes.md](./prop-080-managed-hybrid-modes.md) |
| PROP-081 | Политики гибрида и защита от утечек: серверные политики (forbidden/remote-only/full, publish/fork allow | 🧩 Предложение | [prop-081-hybrid-policy-leak-protection.md](./prop-081-hybrid-policy-leak-protection.md) |
| PROP-082 | Flavor-образы с toolchain: `slim`/`core`/`dev`/`devops`/`browser`/`full` (alpine + debian) для local containerized и managed single-instance | 🧩 Предложение | [prop-082-full-images-deployment.md](./prop-082-full-images-deployment.md) |
| PROP-083 | Кастомизация инстанса и брендинг: приветственное окно (+повторный вызов), конфиг брендинга (название/лого-подпись/ватермарка), серверная выдача; на потом — locked settings | 🧩 Предложение | [prop-083-instance-customization-branding.md](./prop-083-instance-customization-branding.md) |
| PROP-085 | Мультимодальный ввод (звук, изображения, видео): типы `Part`, blob-хранилище вложений, предобработка (ASR/OCR/кадры), UI-композер | 🧩 Предложение | [prop-085-multimodal-input.md](./prop-085-multimodal-input.md) |
| PROP-090 | Extension API v1 — слой плагинов: манифест `synth.pack` (`kind: plugin`), `PluginHost`, фасад `@itphx/synth-plugin`, 14 точек расширения (включая новые `promptBlocks` и `llmFilters`), два режима исполнения (`inline` / `out-of-process`), модель доверия и trust/scan по PROP-068, install/activate (`plugins.lock.json`/`plugins.json`), API/CLI/UI; **решение до 2026-11-14** | 🧩 Предложение | [prop-090-extension-api.md](./prop-090-extension-api.md) |
| PROP-093 | Версионирование документации: версионные подкаталоги портала + селектор (вариант A под текущий nginx-деплой) или `mike` (вариант B при GitHub Pages), тегирование `synth-docs`, политика хранения | 🧩 Предложение | [prop-093-docs-versioning.md](./prop-093-docs-versioning.md) |
| PROP-096 | Фоновые сессии саб-агентов (не блокирующие основную) | 🧩 Предложение | [prop-096-background-subagent-sessions.md](./prop-096-background-subagent-sessions.md) |
| PROP-097 | Фоновые процессы — реестр и контроль через UI | 🧩 Предложение | [prop-097-background-processes-registry.md](./prop-097-background-processes-registry.md) |
| PROP-098 | Форсированная отправка сообщения во время хода (steering) | 🧩 Предложение | [prop-098-mid-turn-steering.md](./prop-098-mid-turn-steering.md) |
| PROP-099 | Оптимизация потребления памяти | 🧩 Предложение | [prop-099-memory-footprint-optimization.md](./prop-099-memory-footprint-optimization.md) |
| PROP-100 | SSRF и TOCTOU/DNS-rebinding — привязка проверенного адреса к соединению (дефекты 1–3 закрыты; остаток — пиннинг) | 🧩 Предложение | [prop-100-ssrf-dns-rebinding.md](./prop-100-ssrf-dns-rebinding.md) |
| PROP-101 | Локальные инсталляторы и платформенная дистрибуция (Windows / macOS / Linux) | 🧩 Предложение | [prop-101-local-installers-platforms.md](./prop-101-local-installers-platforms.md) |
| PROP-104 | Внешний транспорт событий: публикация между репликами control plane | 🧩 Предложение | [prop-104-external-event-transport.md](./prop-104-external-event-transport.md) |
| PROP-105 | Координация в нескольких репликах: сессии, очередь, общее состояние | 🧩 Предложение | [prop-105-multi-replica-coordination.md](./prop-105-multi-replica-coordination.md) |
| PROP-106 | Файловые порты инстанса в SQL: единое состояние при нескольких репликах | 🧩 Предложение | [prop-106-file-ports-to-sql.md](./prop-106-file-ports-to-sql.md) |
| PROP-107 | OAuth-хранилище и слой доступа к внешним сервисам (коннекторы): креды шифруются мастер-ключом, токен подставляет транспорт — агент его не видит | 🧩 Предложение | [prop-107-oauth-credential-layer.md](./prop-107-oauth-credential-layer.md) |
| PROP-108 | Authority-слой — полномочия пользователей и агентов как контент | 🧩 Предложение | [prop-108-authority-layer.md](./prop-108-authority-layer.md) |

## Vision

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| PROP-047 | Память Synth (Gbrain + композиция): storage backbone, RAG по памяти и коду/докам, компрессия tool output, 4-layer retrieval, Obsidian bridge | 🧩 Предложение (vision) | [prop-047-memory-gbrain.md](./prop-047-memory-gbrain.md) |
| PROP-055 | Обмен между инстансами Synth: идемпотентный upsert/дельта, peer-auth, обмен памятью, live-сессии | 🧩 Предложение (vision) | [prop-055-instance-exchange.md](./prop-055-instance-exchange.md) |
| PROP-057 | Loop Engine и Loop Design Wizard: `/design-loop`, Verification Rubric, LoopRunner, termination guards | 🧩 Предложение (vision) | [prop-057-loop-engine.md](./prop-057-loop-engine.md) |
| PROP-058 | Служебные агенты и консилиум (Council): panel/consensus/debate/verifier/judge, Council Gate; включает PROP-031 | 🧩 Предложение (vision) | [prop-058-service-agents-council.md](./prop-058-service-agents-council.md) |
| PROP-060 | Мультиконтурная архитектура (Contour Bridge): шлюз между контурами, обезличивание, аудит | 🧩 Предложение (vision) | [prop-060-multi-contour-bridge.md](./prop-060-multi-contour-bridge.md) |
| PROP-061 | Многослойная безопасность LLM: сканеры промптов/вывода, лимиты, HITL, аудит, неизменяемость аудита | 🧩 Предложение (vision) | [prop-061-llm-security-layers.md](./prop-061-llm-security-layers.md) |
| PROP-063 | Обучение пользователя и метрики: Pre-PR check, анализ сессий, дашборд без рейтингов | 🧩 Предложение (vision) | [prop-063-user-learning-metrics.md](./prop-063-user-learning-metrics.md) |
| PROP-067 | «Впитывание» организационных гайдлайнов → дефолты инстанса: ingestion, scope, версионирование/аудит | 🧩 Предложение (vision) | [prop-067-org-guidelines-defaults.md](./prop-067-org-guidelines-defaults.md) |

## Legacy

| ID | Тема | Статус | Файл |
|----|------|--------|------|
| ADR-027 | Двойная передача плана (диск + system prompt) | ⛔ Заменено | [legacy/adr-027-double-plan-passing.md](./legacy/adr-027-double-plan-passing.md) |

---

Всего документов: 97 (Решения: 39, Частично: 16, Предложения: 33, Vision: 8, Icebox: 0, Legacy: 1).
