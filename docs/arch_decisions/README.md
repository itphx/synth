# Архитектурные решения (AD)

Каталог содержит описания архитектурных решений проекта Synth в формате ADR.
В `AGENTS.md` остаётся только краткая таблица со ссылками.

## Актуальные AD (реализованы)

| AD | Решение | Статус | Файл |
|----|---------|--------|------|
| AD-005 | JSON-файлы как хранилище (атомарная запись tmp + rename) | ✅ | [ad-005-json-storage.md](./ad-005-json-storage.md) |
| AD-008 | WebSocket для real-time событий | ✅ | [ad-008-websocket-events.md](./ad-008-websocket-events.md) |
| AD-009 | SessionEventBus — шина событий сессии | ✅ | [ad-009-session-event-bus.md](./ad-009-session-event-bus.md) |
| AD-014 | Проект как контейнер (сессии, файлы, контекст) | ✅ | [ad-014-project-container.md](./ad-014-project-container.md) |
| AD-017 | Собственный API-контракт (API v2 на Hono) | ✅ | [ad-017-api-v2-hono.md](./ad-017-api-v2-hono.md) |
| AD-019 | React 19 SPA с нуля (без форка OpenChamber) | ✅ | [ad-019-react-spa.md](./ad-019-react-spa.md) |
| AD-022 | Единый TypeScript стек + Runner архитектура | ✅ | [ad-022-typescript-stack-runner.md](./ad-022-typescript-stack-runner.md) |
| AD-023 | Единая система конфигурации (@itphx/synth-shared/config) | ✅ | [ad-023-configuration.md](./ad-023-configuration.md) |
| AD-024 | Единый транспорт: EventHub + TransportClient | ✅ | [ad-024-eventhub-transport.md](./ad-024-eventhub-transport.md) |
| AD-025 | Plan/Act как глобальный permission toggle | ✅ | [ad-025-plan-act-toggle.md](./ad-025-plan-act-toggle.md) |
| AD-026 | Режимы контекста саб-агента: none / inherit / summary / last_n | ✅ | [ad-026-subagent-context-modes.md](./ad-026-subagent-context-modes.md) |
| AD-028 | Настраиваемая строгость цикла Plan → Build | ✅ | [ad-028-plan-build-strictness.md](./ad-028-plan-build-strictness.md) |
| AD-029 | Гранулярные permissions: allow/deny/ask + file patterns | ✅ | [ad-029-granular-permissions.md](./ad-029-granular-permissions.md) |
| AD-033 | Ветвление сессий и межсессионное слияние | ✅ | [ad-033-session-branching-merge.md](./ad-033-session-branching-merge.md) |
| AD-034 | Routing между моделями (content + confidence + cost) | ✅ | [ad-034-model-routing.md](./ad-034-model-routing.md) |
| AD-035 | Micro-model first: дешёвый слой перед LLM | ✅ | [ad-035-micro-model-first.md](./ad-035-micro-model-first.md) |
| AD-036 | LLM Gateway: слой безопасности (guard + обфускация + аудит) | ✅ | [ad-036-llm-gateway.md](./ad-036-llm-gateway.md) |
| AD-038 | Монорепо как набор публикуемых npm-пакетов | ✅ | [ad-038-npm-packages.md](./ad-038-npm-packages.md) |
| AD-039 | План — в проекте, todo — в сессии (замена TSM) | ✅ | [ad-039-plan-in-project.md](./ad-039-plan-in-project.md) |
| AD-040 | Сессии без проекта и перенос между проектами | ✅ | [ad-040-sessions-without-project.md](./ad-040-sessions-without-project.md) |
| AD-041 | Единая таксономия ошибок LLM + контракт локализации | ✅ | [ad-041-llm-error-taxonomy.md](./ad-041-llm-error-taxonomy.md) |
| AD-042 | Гибридный режим: локальный core + централизованный сервер | ✅ | [ad-042-hybrid-mode.md](./ad-042-hybrid-mode.md) |
| AD-043 | Единая идентичность гибрида: вход в UI без Keycloak | ✅ | [ad-043-unified-identity-login.md](./ad-043-unified-identity-login.md) |
| AD-044 | Адаптивный мобильный UI + PWA | ✅ | [ad-044-mobile-adaptive-ui-pwa.md](./ad-044-mobile-adaptive-ui-pwa.md) |
| AD-045 | Профили серверов и лёгкий runtime-вход в гибриде: единый dataDir, мета-реестр profiles.json, logout = забыть токен + revoke | ✅ | [ad-045-hybrid-server-profiles.md](./ad-045-hybrid-server-profiles.md) |
| AD-052 | Публичная API-платформа: service-key + scopes + проектная проекция `allowedProjects` + API/UI; webhooks (HMAC, retry/backoff, SSRF); public-OpenAPI (28 операций) + SDK `@itphx/synth-sdk`; перевод мессенджер-шлюза на scoped service-key; **tenants исключены** (изоляция = инстанс, группировка = проект) | ✅ | [ad-052-public-api-platform.md](./ad-052-public-api-platform.md) |
| AD-069 | Проектные инструкции (AGENTS.md) и `/init`: discovery, merged chain git root→cwd, lazy-догрузка, threat-scan, install-tree guard | ✅ | [ad-069-project-instructions-agents-md.md](./ad-069-project-instructions-agents-md.md) |
| AD-070 | SystemPromptComposer: консистентность промпта, prompt-cache, статистика и прозрачность | ✅ | [ad-070-system-prompt-composer.md](./ad-070-system-prompt-composer.md) |
| AD-071 | MCP-серверы: уровни system/project/session, единый реестр, разделение `tools`/`mcp.tools`, блоки `mcp.servers`/`mcp.status`, политики `tools.policy`/`mcp.policy`, admin-отключение встроенных инструментов | ✅ | [ad-071-mcp-servers-prompt.md](./ad-071-mcp-servers-prompt.md) |
| AD-072 | Settings UI Kit: единая панель настроек (один скролл, центрирование `max-w-3xl`, контракт черновика, контролы); все разделы и админ-категории мигрированы | ✅ | [ad-072-settings-ui-kit.md](./ad-072-settings-ui-kit.md) |
| AD-075 | Окружение проекта: рабочий каталог (автосоздание managed, выбор и политика путей для standalone; FS-паритет, RBAC) | ✅ | [ad-075-project-workspace-provisioning.md](./ad-075-project-workspace-provisioning.md) |
| AD-076 | Реестр git-репозиториев (несколько на проект) и SSH-ключи per-agent (шифрование at-rest, `repo_path`, паритет core↔backend) | ✅ | [ad-076-git-repo-registry-ssh.md](./ad-076-git-repo-registry-ssh.md) |
| AD-078 | Авто-отключение инструментов при отсутствии внешней зависимости (детект `git`/`rg`/`sh`, `unavailable(dependency)`, пояснение модели и UI) | ✅ | [ad-078-runtime-dependency-availability.md](./ad-078-runtime-dependency-availability.md) |
| AD-079 | Локальный home-каталог (`--home`/`SYNTH_HOME`): плоская раскладка config/data/profiles/credentials, приоритеты путей, независимые инстансы standalone и hybrid | ✅ | [ad-079-local-home-independent-instances.md](./ad-079-local-home-independent-instances.md) |
| AD-084 | Decision-модели (Clef/Clef-Flash): `DecisionProvider` (контракт `state + questions → answers`: `noul`/`choice`/`score`; транспорты RouterAI и Ollama; вызов через `GatewayProvider`) + decision-слой в «Быстрых ответах» (уровень микро-каскада AD-035, per-session `decisionFirst`), «Маршрутизации» (классификатор категории AD-034) и внешних событиях (AD-089, `events.decisionRouting`); эскалация `primary → escalation`, агрегатные метрики (`GET/DELETE /settings/decision/metrics`), мультимодальный контракт (`images`/`videos`; источник — AD-085); runtime-настройки `GET/PUT/DELETE /settings/decision` + UI-раздел «Decision-модели» | ✅ | [ad-084-decision-models-clef.md](./ad-084-decision-models-clef.md) |

## Частично реализованные AD

| AD | Решение | Статус | Файл |
|----|---------|--------|------|
| AD-018 | Выбор AI-движка на уровне сессии (выбор движка персистится, механика — в работе) | ⚠️ | [ad-018-session-engine-selection.md](./ad-018-session-engine-selection.md) |
| AD-030 | Hooks для событий агента: hook-шина `HookBus` + эмиты жизненного цикла (`session_requested`, `external_event`); Plugin SDK и загрузка плагинов (AD-090) — нет | ⚠️ | [ad-030-hooks-agent-events.md](./ad-030-hooks-agent-events.md) |
| AD-046 | Скиллы и slash-команды: формат `SKILL.md`, discovery, progressive disclosure, core-тул `skill`, команды/bundles, scope-API, UI; Фаза 3 — trust-гейт проектных команд, inline shell, `skills.urls` read-only, внешние каталоги, builtin `skill-creator`; остаток — install/trust/подписи/`lock.json` и backend-админка каталога (AD-068) | ⚠️ | [ad-046-skills-and-slash-commands.md](./ad-046-skills-and-slash-commands.md) |
| AD-051 | Шедулер: `SchedulerService` (cron/interval) + источник `schedule_fired` через Router (AD-089), Job-история (`JobStore`), catch-up (`skip`/`once`), force-запуск, API/UI расписаний и истории; пайплайны (AD-059) и размещение в гибриде — нет; мульти-инстанс — семы file-based (default OFF) | ⚠️ | [ad-051-scheduler-pipelines.md](./ad-051-scheduler-pipelines.md) |
| AD-089 | Платформа внешних событий: ядро Event/Binding/Router, единый funnel `RequestSessionService`, ingress/API (bindings, keys, journal)/UI, источник AD-051 (cron), API-ключи привязок (label/лимит/revoke + per-key rate limit), retention журнала, runtime-настройки «События», auto-bind (`events.autoBind` — закрепление чата/треда за сессией по решению Router, решение `{kind:'bind'}`/цель `{mode:'bind'}`) — первый срез AD-052; AD-086 — нет | ⚠️ | [ad-089-external-events-automation.md](./ad-089-external-events-automation.md) |

## Deprecated AD

| AD | Решение | Файл |
|----|---------|------|
| AD-027 | Двойная передача плана (⛔ переопределено AD-039) | [legacy/ad-027-double-plan-passing.md](./legacy/ad-027-double-plan-passing.md) |
| AD-087 | Gateway для подключения к мессенджерам (⛔ поглощён AD-086, тема стала первым частным случаем внешних add-on сервисов) | [ad-087-messenger-gateway-merged.md](./ad-087-messenger-gateway-merged.md) |

## Нереализованные AD

Живут в этом каталоге. После реализации переходят в раздел «Актуальные AD».

| AD | Решение |
|----|---------|
| AD-031 | [Verification синт](./ad-031-verification-agent.md) |
| AD-032 | [Миграция хранения истории на PostgreSQL](./ad-032-history-storage-postgresql.md) (логическая модель уже в JSON — AD-005/AD-033) |
| AD-037 | [Security step перед коммитом](./ad-037-commit-security-step.md) |
| AD-047 | [Память Synth (Gbrain + композиция)](./ad-047-memory-gbrain.md): storage backbone, RAG по памяти и коду/докам, компрессия tool output, 4-layer retrieval, Obsidian bridge |
| AD-048 | [Self-help скиллы и admin-MCP](./ad-048-self-help-skills-admin-mcp.md): dogfooding, runbook-скиллы, read-only status-MCP, deploy-тулы, гейтинг ADMIN |
| AD-049 | [Git worktrees](./ad-049-git-worktrees.md): тулы `git_worktree_*`, per-session cwd, детект secondary worktree, UI |
| AD-050 | [Внешние движки (opencode/cline) — Runner](./ad-050-external-engines-runner.md): EngineManager, адаптеры, WS-канал backend↔runner, LLM Proxy :9090 |
| AD-053 | [CLI и TUI](./ad-053-cli-tui.md): паритет публикуемого и dev-CLI, CLI как клиент API v2, TUI |
| AD-054 | [Kanban-доска, backlog](./ad-054-kanban-backlog.md): интерактивная доска поверх `project.plan`, глобальный backlog, assignee/WIP |
| AD-055 | [Обмен между инстансами Synth](./ad-055-instance-exchange.md): идемпотентный upsert/дельта, peer-auth, обмен памятью, live-сессии |
| AD-056 | [MCP-сервер Synth и скиллы для внешних агентов](./ad-056-synth-mcp-server.md): MCP над API v2, auth, права, форматы конфигов клиентов |
| AD-057 | [Loop Engine и Loop Design Wizard](./ad-057-loop-engine.md): `/design-loop`, Verification Rubric, LoopRunner, termination guards |
| AD-058 | [Служебные агенты и консилиум (Council)](./ad-058-service-agents-council.md): panel/consensus/debate/verifier/judge, Council Gate; включает AD-031 |
| AD-059 | [Pipeline Automation](./ad-059-pipeline-automation.md): цепочки loops, артефакты между шагами, rollback, HITL, мониторинг |
| AD-060 | [Мультиконтурная архитектура (Contour Bridge)](./ad-060-multi-contour-bridge.md): шлюз между контурами, обезличивание, аудит |
| AD-061 | [Многослойная безопасность LLM](./ad-061-llm-security-layers.md): сканеры промптов/вывода, лимиты, HITL, аудит, неизменяемость аудита |
| AD-062 | [Умная оптимизация контекста](./ad-062-context-optimization.md): `archive_context`, авто-суммаризация, приоритизация, стратегии |
| AD-063 | [Обучение пользователя и метрики](./ad-063-user-learning-metrics.md): Pre-PR check, анализ сессий, дашборд без рейтингов |
| AD-064 | [Встроенные в UI браузер и терминал](./ad-064-ui-browser-terminal.md): PTY/WS-терминал, webview/iframe-браузер, синхронизация с агентом |
| AD-065 | [Просмотр документации, планов и ToDo в UI](./ad-065-ui-docs-plan-todo.md): docs-браузер, редактор плана/todo, связи, внешний vault |
| AD-066 | [Скиллы и гайдлайны оформления документации](./ad-066-doc-style-skills.md): doc-стандарты, шаблоны, авто-проверка (docs-lint) |
| AD-067 | [«Впитывание» организационных гайдлайнов → дефолты инстанса](./ad-067-org-guidelines-defaults.md): ingestion, scope, версионирование/аудит |
| AD-068 | [Реестр и каталог скиллов и агентов](./ad-068-skills-agents-registry.md): свой репозиторий, индекс, trust/guard, install-policy, agent-packs |
| AD-073 | [Целостность клиента в гибриде](./ad-073-client-integrity-hybrid.md): клиент недоверенный, enforcement на сервере; сигналы (подписи, DPoP/mTLS) опционально |
| AD-074 | [Скрытие вместо удаления](./ad-074-soft-delete-retention.md): soft-delete проектов/сессий/сообщений, исключение из LLM-контекста, read-only режим ADMIN/AUDITOR, restore/purge — ADMIN |
| AD-077 | [Инструментальное окружение исполнения (toolchain и executor)](./ad-077-runtime-toolchain.md): thin backend + сервис-executor, общий volume для workspace, S3; реализуется после AD-032 (PostgreSQL) |
| AD-080 | [Управляемый гибрид: режимы-полюса, идентичность и установка локально](./ad-080-managed-hybrid-modes.md): режим — параметр запуска, без runtime-переключения, standalone=ADMIN / hybrid=роли сервера, «Установить локально» |
| AD-081 | [Политики гибрида и защита от утечек](./ad-081-hybrid-policy-leak-protection.md): серверные политики (forbidden/remote-only/full, publish/fork allow|deny|approval), явные эндпоинты переноса, discovery, аудит, панель «Гибрид» |
| AD-082 | [Flavor-образы с toolchain](./ad-082-full-images-deployment.md): `slim`/`core`/`dev`/`devops`/`browser`/`full` (alpine + debian) для local containerized и managed single-instance |
| AD-083 | [Кастомизация инстанса и брендинг](./ad-083-instance-customization-branding.md): приветственное окно (+повторный вызов), конфиг брендинга (название/лого-подпись/ватермарка), серверная выдача; на потом — locked settings |
| AD-085 | [Мультимодальный ввод (звук, изображения, видео)](./ad-085-multimodal-input.md): типы `Part`, blob-хранилище вложений, предобработка (ASR/OCR/кадры), UI-композер |
| AD-086 | [Расширяемость Synth (зонтик): плагины, editions, вклад в mainline, внешние сервисы-надстройки](./ad-086-extensibility-plugins-editions.md): Extension API v1 вынесен в AD-090, editions, contribution flow, add-ons (первый случай — Telegram gateway: long-polling → события, топология «один бот — один инстанс»; HA через leader election и мультитенантность — спроектированы, не реализованы) |
| AD-088 | [Работа через HTTP-прокси (единый egress-слой)](./ad-088-http-proxy.md): прокси/`no_proxy`/CA, аутентификация Basic/NTLM/Negotiate (Kerberos) |
| AD-090 | [Extension API v1: манифест, загрузка, установка и активация плагинов](./ad-090-extension-api.md): Plugin ≠ Add-on ≠ Declarative, точки расширения, `@itphx/synth-plugin`, bundle-only, install/activate, trust/scan (AD-068), плагины в managed (ADMIN: deploy-time + runtime-опция) и hybrid (allow-list + server-scoped токены) |
