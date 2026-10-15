# Архитектурные решения (AD)

> Индекс каталога архитектурных решений. Правила ведения, жизненный цикл и классы документов —
> [docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md); предложения и сроки решений — [docs/roadmap.md](../roadmap.md).
> Номера AD стабильны: файлы не переносятся и не удаляются (ссылок на AD-id по репозиторию — тысячи).

Таблицы собираются автоматически — вручную не правь:
`node scripts/adr-check.mjs --write` (проверка — `node scripts/adr-check.mjs`).

## Реализовано

| AD | Тема | Статус | Файл |
|----|------|--------|------|
| AD-005 | JSON-файлы как хранилище (атомарная запись tmp + rename) | ✅ Реализовано | [ad-005-json-storage.md](./ad-005-json-storage.md) |
| AD-008 | WebSocket для real-time событий | ✅ Реализовано | [ad-008-websocket-events.md](./ad-008-websocket-events.md) |
| AD-009 | SessionEventBus — шина событий сессии | ✅ Реализовано | [ad-009-session-event-bus.md](./ad-009-session-event-bus.md) |
| AD-014 | Проект как контейнер (сессии, файлы, контекст) | ✅ Реализовано | [ad-014-project-container.md](./ad-014-project-container.md) |
| AD-017 | Собственный API-контракт (API v2 на Hono) | ✅ Реализовано | [ad-017-api-v2-hono.md](./ad-017-api-v2-hono.md) |
| AD-019 | React 19 SPA с нуля (без форка OpenChamber) | ✅ Реализовано | [ad-019-react-spa.md](./ad-019-react-spa.md) |
| AD-022 | Единый TypeScript стек + Runner архитектура | ✅ Реализовано | [ad-022-typescript-stack-runner.md](./ad-022-typescript-stack-runner.md) |
| AD-023 | Единая система конфигурации (@itphx/synth-shared/config) | ✅ Реализовано | [ad-023-configuration.md](./ad-023-configuration.md) |
| AD-024 | Единый транспорт: EventHub + TransportClient | ✅ Реализовано | [ad-024-eventhub-transport.md](./ad-024-eventhub-transport.md) |
| AD-025 | Plan/Act как глобальный permission toggle | ✅ Реализовано | [ad-025-plan-act-toggle.md](./ad-025-plan-act-toggle.md) |
| AD-026 | Режимы контекста саб-агента: none / inherit / summary / last_n | ✅ Реализовано | [ad-026-subagent-context-modes.md](./ad-026-subagent-context-modes.md) |
| AD-028 | Настраиваемая строгость цикла Plan → Build | ✅ Реализовано | [ad-028-plan-build-strictness.md](./ad-028-plan-build-strictness.md) |
| AD-029 | Гранулярные permissions: allow/deny/ask + file patterns | ✅ Реализовано | [ad-029-granular-permissions.md](./ad-029-granular-permissions.md) |
| AD-033 | Ветвление сессий и межсессионное слияние | ✅ Реализовано | [ad-033-session-branching-merge.md](./ad-033-session-branching-merge.md) |
| AD-034 | Routing между моделями (content + confidence + cost) | ✅ Реализовано | [ad-034-model-routing.md](./ad-034-model-routing.md) |
| AD-035 | Micro-model first: дешёвый слой перед LLM | ✅ Реализовано | [ad-035-micro-model-first.md](./ad-035-micro-model-first.md) |
| AD-036 | LLM Gateway: слой безопасности (guard + обфускация + аудит) | ✅ Реализовано | [ad-036-llm-gateway.md](./ad-036-llm-gateway.md) |
| AD-038 | Монорепо как набор публикуемых npm-пакетов | ✅ Реализовано | [ad-038-npm-packages.md](./ad-038-npm-packages.md) |
| AD-039 | План — в проекте, todo — в сессии (замена TSM) | ✅ Реализовано | [ad-039-plan-in-project.md](./ad-039-plan-in-project.md) |
| AD-040 | Сессии без проекта и перенос между проектами | ✅ Реализовано | [ad-040-sessions-without-project.md](./ad-040-sessions-without-project.md) |
| AD-041 | Единая таксономия ошибок LLM + контракт локализации | ✅ Реализовано | [ad-041-llm-error-taxonomy.md](./ad-041-llm-error-taxonomy.md) |
| AD-042 | Гибридный режим: локальный core + централизованный сервер | ✅ Реализовано | [ad-042-hybrid-mode.md](./ad-042-hybrid-mode.md) |
| AD-043 | Единая идентичность гибрида: вход в UI без Keycloak | ✅ Реализовано | [ad-043-unified-identity-login.md](./ad-043-unified-identity-login.md) |
| AD-044 | Адаптивный мобильный UI + PWA | ✅ Реализовано | [ad-044-mobile-adaptive-ui-pwa.md](./ad-044-mobile-adaptive-ui-pwa.md) |
| AD-045 | Профили серверов и лёгкий runtime-вход в гибриде: единый dataDir, мета-реестр profiles.json, logout = забыть токен + revoke | ✅ Реализовано | [ad-045-hybrid-server-profiles.md](./ad-045-hybrid-server-profiles.md) |
| AD-052 | Публичная API-платформа: service-key + scopes + проектная проекция `allowedProjects` + API/UI; webhooks (HMAC, retry/backoff, SSRF); public-OpenAPI (28 операций) + SDK `@itphx/synth-sdk`; перевод мессенджер-шлюза на scoped service-key; **tenants исключены** (изоляция = инстанс, группировка = проект) | ✅ Реализовано | [ad-052-public-api-platform.md](./ad-052-public-api-platform.md) |
| AD-069 | Проектные инструкции (AGENTS.md) и `/init`: discovery, merged chain git root→cwd, lazy-догрузка, threat-scan, install-tree guard | ✅ Реализовано | [ad-069-project-instructions-agents-md.md](./ad-069-project-instructions-agents-md.md) |
| AD-070 | SystemPromptComposer: консистентность промпта, prompt-cache, статистика и прозрачность | ✅ Реализовано | [ad-070-system-prompt-composer.md](./ad-070-system-prompt-composer.md) |
| AD-071 | MCP-серверы: уровни system/project/session, единый реестр, разделение `tools`/`mcp.tools`, блоки `mcp.servers`/`mcp.status`, политики `tools.policy`/`mcp.policy`, admin-отключение встроенных инструментов | ✅ Реализовано | [ad-071-mcp-servers-prompt.md](./ad-071-mcp-servers-prompt.md) |
| AD-072 | Settings UI Kit: единая панель настроек (один скролл, центрирование `max-w-3xl`, контракт черновика, контролы); все разделы и админ-категории мигрированы | ✅ Реализовано | [ad-072-settings-ui-kit.md](./ad-072-settings-ui-kit.md) |
| AD-075 | Окружение проекта: рабочий каталог (автосоздание managed, выбор и политика путей для standalone; FS-паритет, RBAC) | ✅ Реализовано | [ad-075-project-workspace-provisioning.md](./ad-075-project-workspace-provisioning.md) |
| AD-076 | Реестр git-репозиториев (несколько на проект) и SSH-ключи per-agent (шифрование at-rest, `repo_path`, паритет core↔backend) | ✅ Реализовано | [ad-076-git-repo-registry-ssh.md](./ad-076-git-repo-registry-ssh.md) |
| AD-078 | Авто-отключение инструментов при отсутствии внешней зависимости (детект `git`/`rg`/`sh`, `unavailable(dependency)`, пояснение модели и UI) | ✅ Реализовано | [ad-078-runtime-dependency-availability.md](./ad-078-runtime-dependency-availability.md) |
| AD-079 | Локальный home-каталог (`--home`/`SYNTH_HOME`): плоская раскладка config/data/profiles/credentials, приоритеты путей, независимые инстансы standalone и hybrid | ✅ Реализовано | [ad-079-local-home-independent-instances.md](./ad-079-local-home-independent-instances.md) |
| AD-084 | Decision-модели (Clef/Clef-Flash): `DecisionProvider` (контракт `state + questions → answers`: `noul`/`choice`/`score`; транспорты RouterAI и Ollama; вызов через `GatewayProvider`) + decision-слой в «Быстрых ответах» (уровень микро-каскада AD-035, per-session `decisionFirst`), «Маршрутизации» (классификатор категории AD-034) и внешних событиях (AD-089, `events.decisionRouting`); эскалация `primary → escalation`, агрегатные метрики (`GET/DELETE /settings/decision/metrics`), мультимодальный контракт (`images`/`videos`; источник — AD-085); runtime-настройки `GET/PUT/DELETE /settings/decision` + UI-раздел «Decision-модели» | ✅ Реализовано | [ad-084-decision-models-clef.md](./ad-084-decision-models-clef.md) |

## Частично

| AD | Тема | Статус | Файл |
|----|------|--------|------|
| AD-018 | Выбор AI-движка на уровне сессии (выбор движка персистится, механика — в работе) | ⚠️ Частично | [ad-018-session-engine-selection.md](./ad-018-session-engine-selection.md) |
| AD-030 | Hooks для событий агента: hook-шина `HookBus` + эмиты жизненного цикла (`session_requested`, `external_event`); Plugin SDK и загрузка плагинов (AD-090) — нет | ⚠️ Частично | [ad-030-hooks-agent-events.md](./ad-030-hooks-agent-events.md) |
| AD-046 | Скиллы и slash-команды: формат `SKILL.md`, discovery, progressive disclosure, core-тул `skill`, команды/bundles, scope-API, UI; Фаза 3 — trust-гейт проектных команд, inline shell, `skills.urls` read-only, внешние каталоги, builtin `skill-creator`; остаток — install/trust/подписи/`lock.json` и backend-админка каталога (AD-068) | ⚠️ Частично | [ad-046-skills-and-slash-commands.md](./ad-046-skills-and-slash-commands.md) |
| AD-051 | Шедулер: `SchedulerService` (cron/interval) + источник `schedule_fired` через Router (AD-089), Job-история (`JobStore`), catch-up (`skip`/`once`), force-запуск, API/UI расписаний и истории; пайплайны (AD-059) и размещение в гибриде — нет; мульти-инстанс — семы file-based (default OFF) | ⚠️ Частично | [ad-051-scheduler-pipelines.md](./ad-051-scheduler-pipelines.md) |
| AD-086 | Расширяемость Synth (зонтик «Классы расширений»): Plugin (AD-090), **Gateway** (AD-087), Add-on, контент-паки (AD-068), Editions, Contribution flow; единый манифест `synth.pack`; первый add-on/gateway — Telegram-шлюз — реализован и мультитенантен; Plugin SDK/editions/contribution — нет | ⚠️ Частично | [ad-086-extensibility-plugins-editions.md](./ad-086-extensibility-plugins-editions.md) |
| AD-087 | **Шлюзы (gateways)** — отдельный класс расширений (внешний сервис-транспорт внешний мир ↔ Synth, двусторонний обмен): контракт (приём через `POST /api/v2/events`, доставка наружу через SSE-watcher, MCP-часть, Binding, identity/claim-flow, allowlist, вложения, дедуп, прокси/egress, секреты at-rest); Telegram-шлюз (`addons/synth-gateway-telegram`) реализован и **мультитенантен** («несколько ботов → несколько сред», `tenants.json`); HA через leader election, webhook-транспорт, второй канал — нет | ⚠️ Частично | [ad-087-gateways.md](./ad-087-gateways.md) |
| AD-089 | Платформа внешних событий: ядро Event/Binding/Router, единый funnel `RequestSessionService`, ingress/API (bindings, keys, journal)/UI, источник AD-051 (cron), API-ключи привязок (label/лимит/revoke + per-key rate limit), retention журнала, runtime-настройки «События», auto-bind (`events.autoBind`); AD-052 ✅ (этапы I–IV: binding-key, service-key + scopes + `allowedProjects`, webhooks, public-OpenAPI + SDK, перевод шлюза); первый add-on — Telegram-шлюз — реализован; остаток — Plugin SDK (AD-090), пайплайны (AD-059), остаток AD-087 (HA/второй канал) | ⚠️ Частично | [ad-089-external-events-automation.md](./ad-089-external-events-automation.md) |

## Предложения

| AD | Тема | Статус | Файл |
|----|------|--------|------|
| AD-031 | Verification синт | 🧩 Предложение | [ad-031-verification-agent.md](./ad-031-verification-agent.md) |
| AD-032 | Миграция хранения истории на PostgreSQL (логическая модель уже в JSON — AD-005/AD-033) | 🧩 Предложение | [ad-032-history-storage-postgresql.md](./ad-032-history-storage-postgresql.md) |
| AD-037 | Security step перед коммитом | 🧩 Предложение | [ad-037-commit-security-step.md](./ad-037-commit-security-step.md) |
| AD-048 | Self-help скиллы и admin-MCP: dogfooding, runbook-скиллы, read-only status-MCP, deploy-тулы, гейтинг ADMIN | 🧩 Предложение | [ad-048-self-help-skills-admin-mcp.md](./ad-048-self-help-skills-admin-mcp.md) |
| AD-049 | Git worktrees: тулы `git_worktree_*`, per-session cwd, детект secondary worktree, UI | 🧩 Предложение | [ad-049-git-worktrees.md](./ad-049-git-worktrees.md) |
| AD-050 | Внешние движки (opencode/cline) — Runner: EngineManager, адаптеры, WS-канал backend↔runner, LLM Proxy :9090 | 🧩 Предложение | [ad-050-external-engines-runner.md](./ad-050-external-engines-runner.md) |
| AD-053 | CLI и TUI: паритет публикуемого и dev-CLI, CLI как клиент API v2, TUI | 🧩 Предложение | [ad-053-cli-tui.md](./ad-053-cli-tui.md) |
| AD-054 | Kanban-доска, backlog: интерактивная доска поверх `project.plan`, глобальный backlog, assignee/WIP | 🧩 Предложение | [ad-054-kanban-backlog.md](./ad-054-kanban-backlog.md) |
| AD-056 | MCP-сервер Synth и скиллы для внешних агентов: MCP над API v2, auth, права, форматы конфигов клиентов | 🧩 Предложение | [ad-056-synth-mcp-server.md](./ad-056-synth-mcp-server.md) |
| AD-062 | Умная оптимизация контекста: `archive_context`, авто-суммаризация, приоритизация, стратегии | 🧩 Предложение | [ad-062-context-optimization.md](./ad-062-context-optimization.md) |
| AD-064 | Встроенные в UI браузер и терминал: PTY/WS-терминал, webview/iframe-браузер, синхронизация с агентом | 🧩 Предложение | [ad-064-ui-browser-terminal.md](./ad-064-ui-browser-terminal.md) |
| AD-065 | Просмотр документации, планов и ToDo в UI: docs-браузер, редактор плана/todo, связи, внешний vault | 🧩 Предложение | [ad-065-ui-docs-plan-todo.md](./ad-065-ui-docs-plan-todo.md) |
| AD-066 | Скиллы и гайдлайны оформления документации: doc-стандарты, шаблоны, авто-проверка (docs-lint) | 🧩 Предложение | [ad-066-doc-style-skills.md](./ad-066-doc-style-skills.md) |
| AD-068 | Реестр и каталог скиллов и агентов: свой репозиторий, индекс, trust/guard, install-policy, agent-packs | 🧩 Предложение | [ad-068-skills-agents-registry.md](./ad-068-skills-agents-registry.md) |
| AD-073 | Целостность клиента в гибриде: клиент недоверенный, enforcement на сервере; сигналы (подписи, DPoP/mTLS) опционально | 🧩 Предложение | [ad-073-client-integrity-hybrid.md](./ad-073-client-integrity-hybrid.md) |
| AD-074 | Скрытие вместо удаления: soft-delete проектов/сессий/сообщений, исключение из LLM-контекста, read-only режим ADMIN/AUDITOR, restore/purge — ADMIN | 🧩 Предложение | [ad-074-soft-delete-retention.md](./ad-074-soft-delete-retention.md) |
| AD-077 | Инструментальное окружение исполнения (toolchain и executor): thin backend + сервис-executor, общий volume для workspace, S3; реализуется после AD-032 (PostgreSQL) | 🧩 Предложение | [ad-077-runtime-toolchain.md](./ad-077-runtime-toolchain.md) |
| AD-080 | Управляемый гибрид: режимы-полюса, идентичность и установка локально: режим — параметр запуска, без runtime-переключения, standalone=ADMIN / hybrid=роли сервера, «Установить локально» | 🧩 Предложение | [ad-080-managed-hybrid-modes.md](./ad-080-managed-hybrid-modes.md) |
| AD-081 | Политики гибрида и защита от утечек: серверные политики (forbidden/remote-only/full, publish/fork allow | 🧩 Предложение | [ad-081-hybrid-policy-leak-protection.md](./ad-081-hybrid-policy-leak-protection.md) |
| AD-082 | Flavor-образы с toolchain: `slim`/`core`/`dev`/`devops`/`browser`/`full` (alpine + debian) для local containerized и managed single-instance | 🧩 Предложение | [ad-082-full-images-deployment.md](./ad-082-full-images-deployment.md) |
| AD-083 | Кастомизация инстанса и брендинг: приветственное окно (+повторный вызов), конфиг брендинга (название/лого-подпись/ватермарка), серверная выдача; на потом — locked settings | 🧩 Предложение | [ad-083-instance-customization-branding.md](./ad-083-instance-customization-branding.md) |
| AD-085 | Мультимодальный ввод (звук, изображения, видео): типы `Part`, blob-хранилище вложений, предобработка (ASR/OCR/кадры), UI-композер | 🧩 Предложение | [ad-085-multimodal-input.md](./ad-085-multimodal-input.md) |
| AD-088 | Работа через HTTP-прокси (единый egress-слой): прокси/`no_proxy`/CA, аутентификация Basic/NTLM/Negotiate (Kerberos) | 🧩 Предложение | [ad-088-http-proxy.md](./ad-088-http-proxy.md) |
| AD-090 | Extension API v1: манифест, загрузка, установка и активация плагинов: 4 класса (Plugin / Gateway / Add-on / контент-пак), определение Plugin (код в процессе ядра), таксономия влияния (contribution / interception / observation), единый манифест `synth.pack` (`kind`/`contracts`/`provides`), точки расширения, `@itphx/synth-plugin`, bundle-only, install/activate, trust/scan (AD-068), плагины в managed (ADMIN: deploy-time + runtime-опция) и hybrid (allow-list + server-scoped токены) | 🧩 Предложение | [ad-090-extension-api.md](./ad-090-extension-api.md) |
| AD-091 | Бэкап, восстановление и перенос данных: `synth backup`/`restore` (архив каталога данных + манифест, `--with-secrets`, `--dry-run`/`--yes`, шифрование), портативный экспорт/импорт проекта (без секретов), admin API для managed; онлайн-консистентность — после AD-032 | 🧩 Предложение | [ad-091-backup-restore-transfer.md](./ad-091-backup-restore-transfer.md) |
| AD-092 | Обслуживание инстанса: обновление, миграции, откат и удаление: `meta.json`/`schemaVersion` + реестр миграций и `synth migrate`, `synth update --to <version>` и `helm rollback`, `synth uninstall [--purge]`, runbook эксплуатации | 🧩 Предложение | [ad-092-instance-lifecycle-maintenance.md](./ad-092-instance-lifecycle-maintenance.md) |
| AD-093 | Версионирование документации: версионные подкаталоги портала + селектор (вариант A под текущий nginx-деплой) или `mike` (вариант B при GitHub Pages), тегирование `synth-docs`, политика хранения | 🧩 Предложение | [ad-093-docs-versioning.md](./ad-093-docs-versioning.md) |
| AD-094 | Наблюдаемость и эксплуатационные метрики: `/metrics` (Prometheus), `/ready` + раздельные probes, структурные логи (`request_id`/`session_id`, редакция секретов), SLO/алерты, sizing | 🧩 Предложение | [ad-094-observability-metrics.md](./ad-094-observability-metrics.md) |
| AD-047 | Память Synth (Gbrain + композиция): storage backbone, RAG по памяти и коду/докам, компрессия tool output, 4-layer retrieval, Obsidian bridge | 🧩 Предложение (vision) | [ad-047-memory-gbrain.md](./ad-047-memory-gbrain.md) |
| AD-055 | Обмен между инстансами Synth: идемпотентный upsert/дельта, peer-auth, обмен памятью, live-сессии | 🧩 Предложение (vision) | [ad-055-instance-exchange.md](./ad-055-instance-exchange.md) |
| AD-057 | Loop Engine и Loop Design Wizard: `/design-loop`, Verification Rubric, LoopRunner, termination guards | 🧩 Предложение (vision) | [ad-057-loop-engine.md](./ad-057-loop-engine.md) |
| AD-058 | Служебные агенты и консилиум (Council): panel/consensus/debate/verifier/judge, Council Gate; включает AD-031 | 🧩 Предложение (vision) | [ad-058-service-agents-council.md](./ad-058-service-agents-council.md) |
| AD-059 | Pipeline Automation: цепочки loops, артефакты между шагами, rollback, HITL, мониторинг | 🧩 Предложение (vision) | [ad-059-pipeline-automation.md](./ad-059-pipeline-automation.md) |
| AD-060 | Мультиконтурная архитектура (Contour Bridge): шлюз между контурами, обезличивание, аудит | 🧩 Предложение (vision) | [ad-060-multi-contour-bridge.md](./ad-060-multi-contour-bridge.md) |
| AD-061 | Многослойная безопасность LLM: сканеры промптов/вывода, лимиты, HITL, аудит, неизменяемость аудита | 🧩 Предложение (vision) | [ad-061-llm-security-layers.md](./ad-061-llm-security-layers.md) |
| AD-063 | Обучение пользователя и метрики: Pre-PR check, анализ сессий, дашборд без рейтингов | 🧩 Предложение (vision) | [ad-063-user-learning-metrics.md](./ad-063-user-learning-metrics.md) |
| AD-067 | «Впитывание» организационных гайдлайнов → дефолты инстанса: ingestion, scope, версионирование/аудит | 🧩 Предложение (vision) | [ad-067-org-guidelines-defaults.md](./ad-067-org-guidelines-defaults.md) |

## Legacy

| AD | Тема | Статус | Файл |
|----|------|--------|------|
| AD-027 | Двойная передача плана (⛔ переопределено AD-039) | ⛔ Заменено | [legacy/ad-027-double-plan-passing.md](./legacy/ad-027-double-plan-passing.md) |

---

Всего AD: 80 (Реализовано: 35, Частично: 7, Предложения: 28, Vision: 9, Icebox: 0, Legacy: 1).
