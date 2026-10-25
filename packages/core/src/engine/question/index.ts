/**
 * Подсистема «вопрос пользователю» (`ask_user`, этап 1 roadmap 0.13 — блок 3).
 *
 * Сервис (`service.ts`) — единственное место, где живёт жизненный цикл
 * вопроса: постановка → ожидание ответа → ответ/отмена. Хранилище — порт
 * `QuestionRepository` (ADR-096), транспорт — шина событий сессии (ADR-009).
 */
export { QuestionService, validateAnswers } from './service.js';
export type { QuestionServiceOptions, QuestionLogger } from './service.js';
export { startQuestionPruner } from './prune.js';
export type { QuestionPrunerOptions } from './prune.js';
export {
  QUESTION_ERROR_CODES,
  QuestionError,
  QuestionNotFoundError,
  QuestionAlreadySettledError,
  QuestionInvalidAnswerError,
} from './types.js';
export type {
  QuestionAskInput,
  QuestionOutcome,
  QuestionListFilter,
  QuestionErrorCode,
  QuestionInvalidAnswerReason,
} from './types.js';
