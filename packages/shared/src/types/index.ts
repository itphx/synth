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
// PROP-090 §«Точка promptBlocks»: контракт провайдера блока системного промпта
export * from './prompt-blocks.js';
// PROP-090 §«Точка llmFilters»: контракт фильтра LLM-вызовов
export * from './llm-filters.js';
// PROP-090 §«Точка tools»: namespace инструментов плагина (plugin_<ns>_<tool>)
export * from './plugin-tools.js';
// PROP-090 §«out-of-process»: wire-протокол плагина (версия, DTO, эндпоинты, коды)
export * from './plugin-protocol.js';
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
// PROP-098: режимы отправки сообщения во время хода (steering)
export * from './steering.js';
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
// PROP-107 (Ф0): внешний доступ к внешним сервисам (коннекторам) — типы, zod и
// маппер «метаданные без секрета».
export * from './external-credentials.js';
// ADR-092 (остаток): аудит-журнал обслуживания инстанса — re-exported from maintenance.ts
export * from './maintenance.js';
// Egress-политика, журнал внешних запросов и аудит security-политик
export * from './egress.js';
// Аналитика и отчётность инстанса: суточные роллапы (ADR-102)
export * from './analytics.js';
// ADR-086/PROP-090: единый манифест расширения `synth.pack` — типы и zod-схемы
export * from './pack.js';
// PROP-090 §8/§10: semver-матчер диапазонов версий (host/контракты расширения)
export * from './semver.js';
// PROP-090 §9: журнал аудита плагинов — отдельный тип и отдельный scope
// (не расширение `SECURITY_AUDIT_SCOPES` — семантика «событие расширения»).
export * from './plugin-audit.js';
// PROP-068 §4.2/§4.3 + PROP-090 §9: контракты сканера расширений (категории,
// severity→verdict, квоты), матрица install-policy и запись lock-файла.
export * from './plugin-scan.js';
// PROP-068 §4.4 / PROP-090 §5: запись lock-файла плагинов (`plugins.lock.json`).
export * from './plugin-lock.js';
// PROP-090 §5: runtime-override плагинов (`plugins.json`).
export * from './plugin-runtime.js';
// PROP-068 §3/§12: контракт индекса каталога расширений (format: 1) — типы, zod-схемы, tolerant-парсер
export * from './catalog.js';
// PROP-108 Ф0: модель Authority-слоя — полномочия пользователей и агентов
// как контент (Principal/Action/Target/Grant/Role/Ceiling/Turn/Approval).
export * from './authority.js';
// ADR-051/ADR-100: контракт пайплайна (определение, шаг, экземпляр)
export * from './pipeline.js';
// ADR-101: контракты пайплайна как второго движка (спецификация, узлы,
// переходы, триггер, результат узла, прогон, журнал) — re-exported from pipeline-engine.ts
export * from './pipeline-engine.js';
