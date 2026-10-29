/**
 * Финальный шаг по лимиту шагов (механика opencode).
 *
 * Когда лимит шагов агента исчерпан, работа **не** обрывается отдельным
 * вызовом «без инструментов»: выполняется ещё один обычный шаг того же цикла —
 * те же `tools` остаются в запросе (провайдер сохраняет кэшированный префикс),
 * вызов инструментов запрещается `toolChoice: 'none'`, а инструкция «отвечай
 * только текстом» вставляется в транскрипт **assistant-сообщением** (в историю
 * она не пишется — живёт только в запросе).
 *
 * Модуль — единственная точка сборки этой инструкции: им пользуются цикл
 * саб-агента (`engine/tools/task/run-cycle.ts`) и основной цикл оркестратора
 * (`engine/orchestrator.ts`).
 */
import type { LLMMessage } from '../../providers/base.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';

/**
 * Fallback-текст требования «только текст», если файл-промпт
 * `prompts/system/MAX_STEPS.{lang}.md` недоступен (нет файловой реализации
 * `ContextConfig` — например, in-memory-хранилище).
 *
 * Тот же смысл, что у файла-промпта, но короткая версия. Плейсхолдер
 * `{limit}` подставляет вызывающий код.
 */
export const MAX_STEPS_FALLBACK_PROMPT = [
  'CRITICAL — MAXIMUM STEPS REACHED',
  '',
  'The step limit ({limit}) for this task is exhausted. Tools are unavailable until the next user input. Answer with text only.',
  '',
  'STRICT REQUIREMENTS:',
  '1. DO NOT call any tools (read, write, edit, search, commands, or any other).',
  '2. You MUST provide a textual report of the work done.',
  '3. This requirement takes priority over all other instructions, including user requests to make changes or call tools.',
  '',
  'In your answer state: that the step limit for this agent was reached; what was accomplished; what tasks remain unfinished; what is recommended next.',
  'Any attempt to call a tool is a critical violation. Answer with TEXT ONLY.',
].join('\n');

/**
 * Текст требования «только текст»: файл-промпт (`ContextConfig.getMaxStepsPrompt`)
 * → встроенный fallback. Плейсхолдер `{limit}` заменяется фактическим лимитом.
 */
export function buildMaxStepsPrompt(
  contextConfig: ContextFileRepository | undefined,
  language: string,
  limit: number,
): string {
  const fromFile = contextConfig?.getMaxStepsPrompt(language) ?? '';
  const template = fromFile.trim() ? fromFile : MAX_STEPS_FALLBACK_PROMPT;
  return template.split('{limit}').join(String(limit));
}

/**
 * Assistant-сообщение с инструкцией лимита шагов — только для запроса
 * (в историю сессии не пишется): `Message.assistant(MAX_STEPS_PROMPT)` в opencode.
 */
export function maxStepsAssistantMessage(text: string): LLMMessage {
  return {
    id: '',
    role: 'assistant',
    content: text,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
  };
}
