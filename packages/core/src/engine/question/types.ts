/**
 * Типы подсистемы «вопрос пользователю» (`ask_user`, этап 1 roadmap 0.13 —
 * блок 3).
 *
 * Контракт записи вопроса — в `@itphx/synth-shared` (`types/question.ts`).
 * Здесь — только типы **сервисного слоя**: вход запроса, итог ожидания и
 * типизированные ошибки (ADR-041: строки движка — через ключи `shared/i18n`,
 * поэтому ошибки несут машинный код, а не текст для модели).
 */
import type { QuestionItem, QuestionRecord, QuestionStatus } from '@itphx/synth-shared';

/**
 * Вход постановки вопроса.
 *
 * `timeoutMs` — переопределение срока ожидания ответа для конкретного
 * вопроса; `0` — без таймаута (по умолчанию берётся из конфигурации
 * `questions.timeoutMs`). `signal` — сигнал отмены хода: по нему вопрос
 * снимается с ожидания (`cancelReason: 'aborted'`).
 */
export interface QuestionAskInput {
  /** Сессия, в которой задан вопрос. */
  sessionId: string;
  /** Ход сессии (необязательно) — для трассировки и привязки к ходу. */
  turnId?: string;
  /** Вызов тула, породивший вопрос (необязательно). */
  toolCallId?: string;
  /** Агент, задавший вопрос (необязательно). */
  agentRole?: string;
  /** Список вопросов (1..5 — ограничение схемы тула). */
  questions: QuestionItem[];
  /** Срок ожидания ответа, мс; `0` — без таймаута. */
  timeoutMs?: number;
  /** Сигнал отмены хода (аборт) — вопрос снимается с ожидания. */
  signal?: AbortSignal;
}

/**
 * Итог ожидания ответа.
 *
 * - `answered` — пользователь ответил, `answers` продублированы в записи;
 * - `cancelled` — вопрос снят (таймаут, отмена хода, ручная отмена, рестарт).
 */
export type QuestionOutcome =
  | { status: 'answered'; question: QuestionRecord; answers: string[][] }
  | { status: 'cancelled'; question: QuestionRecord; reason: string };

/** Фильтр выборки вопросов (проксируется в порт `QuestionRepository`). */
export interface QuestionListFilter {
  sessionId?: string;
  status?: QuestionStatus;
  limit?: number;
}

/** Машинные коды ошибок подсистемы вопросов. */
export const QUESTION_ERROR_CODES = [
  'question_not_found',
  'question_already_settled',
  'question_invalid_answer',
] as const;

/** Код ошибки подсистемы вопросов. */
export type QuestionErrorCode = (typeof QUESTION_ERROR_CODES)[number];

/** База ошибок подсистемы вопросов: машинный код + текст (для логов/UI). */
export class QuestionError extends Error {
  readonly code: QuestionErrorCode;

  constructor(code: QuestionErrorCode, message: string) {
    super(message);
    this.name = 'QuestionError';
    this.code = code;
  }
}

/** Вопроса с таким id нет (или он не принадлежит сессии — см. HTTP-роут). */
export class QuestionNotFoundError extends QuestionError {
  readonly questionId: string;

  constructor(questionId: string) {
    super('question_not_found', `Вопрос ${questionId} не найден`);
    this.name = 'QuestionNotFoundError';
    this.questionId = questionId;
  }
}

/** Вопрос уже закрыт (отвечен или отменён) — повторный ответ не принимается. */
export class QuestionAlreadySettledError extends QuestionError {
  readonly questionId: string;
  readonly status: QuestionStatus;

  constructor(questionId: string, status: QuestionStatus) {
    super('question_already_settled', `Вопрос ${questionId} уже закрыт (${status})`);
    this.name = 'QuestionAlreadySettledError';
    this.questionId = questionId;
    this.status = status;
  }
}

/**
 * Причины невалидного ответа.
 *
 * - `no_questions` — вопрос задан без единого пункта (защита сервиса);
 * - `answer_count_mismatch` — число ответов ≠ числу заданных вопросов;
 * - `empty_answer` — на вопрос не выбран ни один вариант / пустая строка;
 * - `too_many_answers` — одиночный вопрос (`multiple: false`) получил больше
 *   одного значения;
 * - `invalid_answer` — значение ответа не строка;
 * - `answer_too_long` — свободный ответ длиннее `MAX_FREE_ANSWER_LENGTH`.
 *
 * Значение, не входящее в `options[].value`, **не** является ошибкой: свободный
 * ответ разрешён всегда (аналог «Type your own answer» в opencode).
 */
export type QuestionInvalidAnswerReason =
  | 'no_questions'
  | 'answer_count_mismatch'
  | 'empty_answer'
  | 'too_many_answers'
  | 'invalid_answer'
  | 'answer_too_long';

/** Ответ не проходит валидацию (число ответов, пустой ответ, лишнее значение). */
export class QuestionInvalidAnswerError extends QuestionError {
  readonly reason: QuestionInvalidAnswerReason;
  /** Индекс вопроса (по порядку в `questions`), если ошибка привязана к нему. */
  readonly questionIndex?: number;

  constructor(reason: QuestionInvalidAnswerReason, questionIndex?: number) {
    super('question_invalid_answer', `Некорректный ответ на вопрос: ${reason}`);
    this.name = 'QuestionInvalidAnswerError';
    this.reason = reason;
    if (questionIndex !== undefined) this.questionIndex = questionIndex;
  }
}
