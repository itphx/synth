// Barrel-фасад доменных модулей типов (ADR-095, шаг 2).
// Внешние импорты (`./types`/`../types/index.js`) остаются валидными: набор
// публичных имён не меняется, определения живут в доменных модулях.

// --- Доменные модули ---
// Common enums + сообщения/части (MessageRole, Message, Part, …)
export * from './message.js';
// Сессии, режимы, todo, настройки, статистика сессии
export * from './session.js';
// Промпт: состояние/манифест/история (ADR-070/071)
export * from './prompt.js';
// MCP: реестр серверов, сетевой доступ, уровни/эффективный набор (ADR-071)
export * from './mcp.js';
// Проекты, workspace-политика, иконки/цвета, план (ADR-039/075)
export * from './project.js';
// Git-репозитории и SSH-ключи (ADR-076)
export * from './git.js';
// Пользователи, auth и внешние идентичности (ADR-089)
export * from './user.js';
// Агенты (определения и режимы)
export * from './agent.js';
// Провайдеры, модели, контекст-файлы, валюты (ADR-034)
export * from './provider.js';
// LLM-чанки/ответы и дефолты Gateway (ADR-036)
export * from './llm.js';
// EventType/BusEvent — шина событий сессии (ADR-009/024)
export * from './bus-events.js';
// Файловая система (FS API v2)
export * from './fs.js';

// --- Реэкспорт существующих доменных модулей ---
// Tool types — re-exported from tools.ts
export * from './tools.js';
// Permission types (ADR-029) — re-exported from permission.ts
export * from './permission.js';
// Skill types (ADR-046) — re-exported from skills.ts
export * from './skills.js';
// Slash-команды и bundles (ADR-046 §7) — re-exported from commands.ts
export * from './commands.js';
// Внешние события (ADR-089) — re-exported from events.ts
export * from './events.js';
// Hooks агента и интеграций (ADR-030) — re-exported from hooks.ts
export * from './hooks.js';
// Планировщик расписаний (ADR-051 срез / ADR-089) — re-exported from schedules.ts
export * from './schedules.js';
// Decision-модели (ADR-084): контракт state+questions → answers — re-exported from decision.ts
export * from './decision.js';
// ADR-052 (этап I): service-key — scopes + проектная проекция — re-exported from service-keys.ts
export * from './service-keys.js';
// ADR-052 (этап II): исходящие webhooks — типы и матчер событий — re-exported from webhooks.ts
export * from './webhooks.js';
// ADR-092 (остаток): аудит-журнал обслуживания инстанса — re-exported from maintenance.ts
export * from './maintenance.js';
// Egress-политика, журнал внешних запросов и аудит security-политик
export * from './egress.js';
// Аналитика и отчётность инстанса: суточные роллапы (PROP-102)
export * from './analytics.js';
