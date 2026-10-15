/**
 * Тулы запуска и возобновления саб-агента: точка входа модуля.
 *
 * ADR-095 (шаг 5): `task.ts` — фасад с прежним публичным API; реализация
 * разнесена по `task/*`:
 *  - `types.ts`        — `TaskExtra`, режимы контекста (ADR-026), retry-конфиг;
 *  - `args.ts`         — Zod-схема и тип аргументов тула `task`;
 *  - `fork.ts`         — создание дочерней сессии (fork/контекст/permissions);
 *  - `child-session.ts`— сообщения/события и жизненный цикл дочерней сессии;
 *  - `prompt.ts`       — промпт роли, секция недоступных тулов, маппинг сообщений;
 *  - `run-cycle.ts`    — общий цикл саб-агента (`runSubagent`) для task и resume;
 *  - `tool.ts`         — определение тула `task`.
 *
 * Публичные экспорты и поведение сохранены (в т.ч. для `task-resume.ts`).
 */
export { taskTool } from './task/tool.js';
export {
  SUBAGENT_MAX_ATTEMPTS,
  SUBAGENT_RETRY_DELAYS_MS,
  runSubagent,
} from './task/run-cycle.js';
export type { SubagentRunConfig } from './task/run-cycle.js';
export {
  buildSubagentUnavailableToolsSection,
  messageToLLMMessage,
  resolveSubagentPrompt,
} from './task/prompt.js';
export { publishMessageAdded } from './task/child-session.js';
export type { SubagentRetryConfig, TaskExtra } from './task/types.js';
