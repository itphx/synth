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
| AD-070 | SystemPromptComposer: консистентность промпта, prompt-cache, статистика и прозрачность | ✅ | [ad-070-system-prompt-composer.md](./ad-070-system-prompt-composer.md) |
| AD-071 | MCP-серверы: уровни system/project/session, единый реестр, разделение `tools`/`mcp.tools`, блоки `mcp.servers`/`mcp.status`, политики `tools.policy`/`mcp.policy`, admin-отключение встроенных инструментов | ✅ | [ad-071-mcp-servers-prompt.md](./ad-071-mcp-servers-prompt.md) |
| AD-072 | Settings UI Kit: единая панель настроек (один скролл, центрирование `max-w-3xl`, контракт черновика, контролы); все разделы и админ-категории мигрированы | ✅ | [ad-072-settings-ui-kit.md](./ad-072-settings-ui-kit.md) |
| AD-075 | Окружение проекта: рабочий каталог (автосоздание managed, выбор и политика путей для standalone; FS-паритет, RBAC) | ✅ | [ad-075-project-workspace-provisioning.md](./ad-075-project-workspace-provisioning.md) |
| AD-076 | Реестр git-репозиториев (несколько на проект) и SSH-ключи per-agent (шифрование at-rest, `repo_path`, паритет core↔backend) | ✅ | [ad-076-git-repo-registry-ssh.md](./ad-076-git-repo-registry-ssh.md) |
| AD-078 | Авто-отключение инструментов при отсутствии внешней зависимости (детект `git`/`rg`/`sh`, `unavailable(dependency)`, пояснение модели и UI) | ✅ | [ad-078-runtime-dependency-availability.md](./ad-078-runtime-dependency-availability.md) |

## Частично реализованные AD

| AD | Решение | Статус | Файл |
|----|---------|--------|------|
| AD-018 | Выбор AI-движка на уровне сессии (выбор движка персистится, механика — в работе) | ⚠️ | [ad-018-session-engine-selection.md](./ad-018-session-engine-selection.md) |

## Deprecated AD

| AD | Решение | Файл |
|----|---------|------|
| AD-027 | Двойная передача плана (⛔ переопределено AD-039) | [legacy/ad-027-double-plan-passing.md](./legacy/ad-027-double-plan-passing.md) |

## Нереализованные AD

Живут в этом каталоге. После реализации переходят в раздел «Актуальные AD».

| AD | Решение |
|----|---------|
| AD-030 | Hooks для событий агента: [ad-030-hooks-agent-events.md](./ad-030-hooks-agent-events.md) |
| AD-031 | [Verification синт](./ad-031-verification-agent.md) |
| AD-032 | [Миграция хранения истории на PostgreSQL](./ad-032-history-storage-postgresql.md) (логическая модель уже в JSON — AD-005/AD-033) |
| AD-037 | [Security step перед коммитом](./ad-037-commit-security-step.md) |
| AD-046 | [Скиллы и slash-команды](./ad-046-skills-and-slash-commands.md): формат SKILL.md, discovery, progressive disclosure, core-тул skill, bundles, capability-aware |
| AD-068 | [Реестр и каталог скиллов и агентов](./ad-068-skills-agents-registry.md): свой репозиторий, индекс, trust/guard, install-policy, agent-packs |
| AD-069 | [Проектные инструкции (AGENTS.md) и /init](./ad-069-project-instructions-agents-md.md): discovery, merged chain, lazy-догрузка, обрезка, threat-scan, install-tree guard |
| AD-073 | [Целостность клиента в гибриде](./ad-073-client-integrity-hybrid.md): клиент недоверенный, enforcement на сервере; сигналы (подписи, DPoP/mTLS) опционально |
| AD-074 | [Скрытие вместо удаления](./ad-074-soft-delete-retention.md): soft-delete проектов/сессий/сообщений, исключение из LLM-контекста, read-only режим ADMIN/AUDITOR, restore/purge — ADMIN |
| AD-077 | [Инструментальное окружение исполнения (toolchain и executor)](./ad-077-runtime-toolchain.md): thin backend + сервис-executor, общий volume для workspace, S3; реализуется после AD-032 (PostgreSQL) |
| AD-079 | [Локальный home-каталог (`--home`) и независимые локальные инстансы](./ad-079-local-home-independent-instances.md): `--home`/`SYNTH_HOME`, плоская раскладка (config/data/profiles/credentials), приоритеты путей, независимый запуск standalone и hybrid |
| AD-080 | [Управляемый гибрид: режимы-полюса, идентичность и установка локально](./ad-080-managed-hybrid-modes.md): режим — параметр запуска, без runtime-переключения, standalone=ADMIN / hybrid=роли сервера, «Установить локально» |
| AD-081 | [Политики гибрида и защита от утечек](./ad-081-hybrid-policy-leak-protection.md): серверные политики (forbidden/remote-only/full, publish/fork allow|deny|approval), явные эндпоинты переноса, discovery, аудит, панель «Гибрид» |
| AD-082 | [Flavor-образы с toolchain](./ad-082-full-images-deployment.md): `slim`/`core`/`dev`/`devops`/`browser`/`full` (alpine + debian) для local containerized и managed single-instance |
