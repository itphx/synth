# Архитектурные решения (AD)

Каталог содержит описания архитектурных решений проекта Synth в формате ADR.
В `AGENTS.md` остаётся только краткая таблица со ссылками.

## Актуальные AD (реализованы)

| AD | Решение | Статус | Файл |
|----|---------|--------|------|
| AD-022 | Единый TypeScript стек + Runner архитектура | ✅ | [ad-022-typescript-stack-runner.md](./ad-022-typescript-stack-runner.md) |
| AD-023 | Единая система конфигурации (@itphx/synth-shared/config) | ✅ | [ad-023-configuration.md](./ad-023-configuration.md) |
| AD-024 | Единый транспорт: EventHub + TransportClient | ✅ | [ad-024-eventhub-transport.md](./ad-024-eventhub-transport.md) |
| AD-025 | Plan/Act как глобальный permission toggle | ✅ | [ad-025-plan-act-toggle.md](./ad-025-plan-act-toggle.md) |
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

## Нереализованные AD

Остаются в `AGENTS.md` до реализации. После реализации — переносятся в этот каталог.

| AD | Решение |
|----|---------|
| AD-026 | Режимы контекста саб-агента: inherit / summary / none |
| AD-027 | Двойная передача плана (⚠️ переопределено AD-039) |
| AD-030 | Hooks для событий агента |
| AD-031 | Verification синт |
| AD-032 | Хранение истории: PostgreSQL нормализованная схема |
| AD-037 | Security step перед коммитом |
