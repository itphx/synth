/**
 * Сервис «вопрос пользователю» (`ask_user`, этап 1 roadmap 0.13 — блок 3).
 *
 * Агент задаёт вопрос и **ждёт ответа**: ход стоит, пока пользователь не
 * ответит, не отменит вопрос и не истечёт срок ожидания. Запись вопроса
 * **персистентна** (порт `QuestionRepository`, ADR-096) — она переживает
 * реконнект UI и рестарт сервиса, поэтому ответ приходит по `id` вопроса,
 * а не «по каналу».
 *
 * Ожидание ответа живёт в памяти процесса (`Map<id, waiter>`): переживание
 * рестарта невозможно, поэтому при старте все `pending`-вопросы снимаются с
 * причиной `interrupted` (`recoverOnStart`).
 *
 * События публикуются в **канал сессии** (`EventBus.publish(sessionId, …)`):
 * `user_question.asked` / `user_question.answered` / `user_question.cancelled`
 * (ADR-009/ADR-024 — новых транспортных каналов не заводим).
 */
import type { QuestionItem, QuestionRecord } from '@itphx/synth-shared';
import type { EventBus } from '../../events/bus.js';
import type { QuestionRepository } from '../../storage/ports/question-repository.js';
import {
  QuestionAlreadySettledError,
  QuestionInvalidAnswerError,
  QuestionNotFoundError,
  type QuestionAskInput,
  type QuestionListFilter,
  type QuestionOutcome,
} from './types.js';

/** Минимальный логгер (console-совместимый). */
export interface QuestionLogger {
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface QuestionServiceOptions {
  /** Порт хранения вопросов (ADR-096) — единственный источник истины. */
  repository: QuestionRepository;
  /** Шина событий сессии (ADR-009) — публикация `user_question.*`. */
  eventBus: EventBus;
  /** Срок ожидания ответа по умолчанию, мс; `0` — без таймаута. */
  timeoutMs: number;
  /** Генератор id (тесты подменяют). */
  generateId?: () => string;
  /** Источник времени (тесты подменяют). */
  now?: () => string;
  /** Логгер (по умолчанию — console). */
  logger?: QuestionLogger;
}

/** Ожидание ответа на конкретный вопрос. */
interface QuestionWaiter {
  record: QuestionRecord;
  resolve: (outcome: QuestionOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Предел числа `pending`-вопросов, обрабатываемых при старте. */
const RECOVER_LIMIT = 1000;

/**
 * Предел длины свободного ответа (символов после `trim()`).
 *
 * Значение из `options[].value` ограничением не связано (оно задано
 * автором вопроса); ограничение относится к «своему ответу».
 */
export const MAX_FREE_ANSWER_LENGTH = 1000;

/**
 * Сервис вопросов пользователю.
 *
 * Инварианты:
 * 1. **Один переход состояния**: `pending → answered | cancelled`. Повторный
 *    ответ/отмена закрытого вопроса — `QuestionAlreadySettledError`;
 * 2. **Ответ валидируется по составу вопроса**: число ответов равно числу
 *    вопросов, на каждый вопрос — хотя бы одно значение, для одиночного
 *    вопроса — не больше одного; значение из `options[].value` валидно, но
 *    **свободный ответ (любая непустая строка) валиден тоже** — ограничение
 *    только длина и непустота;
 * 3. **Ожидание — в памяти**: ответ, пришедший после рестарта процесса,
 *    закрывает запись, но уже не разблокирует ход (вопрос снят при старте).
 */
export class QuestionService {
  private readonly _repository: QuestionRepository;
  private readonly _eventBus: EventBus;
  private readonly _timeoutMs: number;
  private readonly _generateId: () => string;
  private readonly _now: () => string;
  private readonly _logger: QuestionLogger;
  /** Ожидания ответов: `id` вопроса → ожидание. */
  private readonly _waiters = new Map<string, QuestionWaiter>();

  constructor(options: QuestionServiceOptions) {
    this._repository = options.repository;
    this._eventBus = options.eventBus;
    this._timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 0;
    this._generateId = options.generateId ?? defaultGenerateId;
    this._now = options.now ?? defaultNow;
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
  }

  /**
   * Задать вопрос и дождаться ответа.
   *
   * Порядок: запись (`pending`) → сохранение → регистрация ожидания →
   * публикация `user_question.asked` → ожидание. Ожидание регистрируется
   * **до** публикации: подписчик может ответить сразу же, и ответ не
   * потеряется.
   */
  async ask(input: QuestionAskInput): Promise<QuestionOutcome> {
    const questions = input.questions ?? [];
    if (questions.length === 0) {
      throw new QuestionInvalidAnswerError('no_questions');
    }

    const now = this._now();
    const id = `qst_${this._generateId()}`;
    const timeoutMs = input.timeoutMs ?? this._timeoutMs;
    const record: QuestionRecord = {
      id,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.agentRole ? { agentRole: input.agentRole } : {}),
      questions,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(timeoutMs > 0
        ? { expiresAt: new Date(Date.parse(now) + timeoutMs).toISOString() }
        : {}),
    };

    await this._repository.save(record);

    const outcome = new Promise<QuestionOutcome>((resolve) => {
      const waiter: QuestionWaiter = { record, resolve };
      this._waiters.set(id, waiter);
      // Таймаут: `unref` — процесс не держим.
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          void this._cancelInternal(id, 'timeout').catch((err: unknown) => {
            this._logger.warn?.(
              `[QuestionService] не удалось снять вопрос ${id} по таймауту: ${String(err)}`,
            );
          });
        }, timeoutMs);
        timer.unref?.();
        waiter.timer = timer;
      }
      // Отмена хода (AbortSignal) — вопрос снимается с ожидания.
      const signal = input.signal;
      if (signal) {
        const onAbort = (): void => {
          void this._cancelInternal(id, 'aborted').catch((err: unknown) => {
            this._logger.warn?.(
              `[QuestionService] не удалось снять вопрос ${id} при отмене хода: ${String(err)}`,
            );
          });
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    this._publishAsked(record);
    return outcome;
  }

  /**
   * Принять ответ пользователя.
   *
   * Валидирует ответ по составу вопроса; при нарушении — типизированная
   * ошибка `QuestionInvalidAnswerError` (HTTP-роут отдаёт 400).
   */
  async answer(
    questionId: string,
    answers: string[][],
    answeredBy?: string,
  ): Promise<QuestionRecord> {
    const record = await this._requirePending(questionId);
    validateAnswers(record.questions, answers);

    const now = this._now();
    const updated: QuestionRecord = {
      ...record,
      status: 'answered',
      answers,
      answeredAt: now,
      updatedAt: now,
      ...(answeredBy ? { answeredBy } : {}),
    };
    await this._repository.save(updated);
    this._publishAnswered(updated);
    this._settle(updated, { status: 'answered', question: updated, answers });
    return updated;
  }

  /**
   * Отменить вопрос (таймаут, ручная отмена, конец хода, рестарт).
   *
   * Закрытый вопрос отменить нельзя — `QuestionAlreadySettledError`.
   *
   * `cancelledBy` — инициатор отмены (для аудита вызывающего кода). В записи
   * вопроса отдельного поля нет (контракт `QuestionRecord` описывает только
   * `answeredBy`), поэтому инициатор наружу не отдаётся — причина отмены
   * (`cancelReason`) фиксируется всегда.
   */
  async cancel(
    questionId: string,
    reason = 'cancelled',
    cancelledBy?: string,
  ): Promise<QuestionRecord> {
    void cancelledBy;
    const record = await this._requirePending(questionId);
    const now = this._now();
    const updated: QuestionRecord = {
      ...record,
      status: 'cancelled',
      cancelledAt: now,
      cancelReason: reason,
      updatedAt: now,
    };
    await this._repository.save(updated);
    this._publishCancelled(updated, reason);
    this._settle(updated, { status: 'cancelled', question: updated, reason });
    return updated;
  }

  /** Список вопросов (прокси к порту) — для HTTP-роутов и UI. */
  async list(filter?: QuestionListFilter): Promise<QuestionRecord[]> {
    return this._repository.list(filter);
  }

  /**
   * Запись вопроса по id (прокси к порту) — HTTP-роут проверяет ею, что
   * вопрос принадлежит сессии (иначе — 404, а не 403: чужой вопрос не виден).
   */
  async get(questionId: string): Promise<QuestionRecord | null> {
    return this._repository.get(questionId);
  }

  /** Открытые вопросы сессии. */
  async listPending(sessionId: string): Promise<QuestionRecord[]> {
    return this._repository.list({ sessionId, status: 'pending' });
  }

  /**
   * Снять все открытые вопросы сессии (конец хода, «Стоп»).
   *
   * Возвращает снятые записи. Уже закрытые (ответили) пропускаются — гонка
   * ответа и отмены не должна ронять ход.
   */
  async cancelSession(sessionId: string, reason: string): Promise<QuestionRecord[]> {
    const pending = await this.listPending(sessionId);
    const cancelled: QuestionRecord[] = [];
    for (const record of pending) {
      try {
        cancelled.push(await this.cancel(record.id, reason));
      } catch (err) {
        if (err instanceof QuestionAlreadySettledError) continue;
        this._logger.warn?.(
          `[QuestionService] не удалось снять вопрос ${record.id}: ${String(err)}`,
        );
      }
    }
    return cancelled;
  }

  /**
   * Восстановление при старте: все `pending`-вопросы снимаются с причиной
   * `interrupted` — ожидание в памяти не пережило рестарт, поэтому оставить
   * вопрос «висящим» нельзя. Идемпотентно (повторный вызов ничего не делает).
   */
  async recoverOnStart(): Promise<number> {
    const pending = await this._repository.list({ status: 'pending', limit: RECOVER_LIMIT });
    let recovered = 0;
    for (const record of pending) {
      try {
        await this.cancel(record.id, 'interrupted');
        recovered += 1;
      } catch (err) {
        if (err instanceof QuestionAlreadySettledError) continue;
        this._logger.warn?.(
          `[QuestionService] не удалось снять вопрос ${record.id} при старте: ${String(err)}`,
        );
      }
    }
    return recovered;
  }

  /**
   * Освобождение ресурсов (graceful shutdown): таймеры снимаются, ожидания
   * разрешаются как отменённые.
   */
  dispose(): void {
    for (const waiter of [...this._waiters.values()]) {
      this._clearWaiter(waiter);
      waiter.resolve({ status: 'cancelled', question: waiter.record, reason: 'disposed' });
    }
    this._waiters.clear();
  }

  /** Запись вопроса по id; ошибка — если вопроса нет или он уже закрыт. */
  private async _requirePending(questionId: string): Promise<QuestionRecord> {
    const record = await this._repository.get(questionId);
    if (!record) throw new QuestionNotFoundError(questionId);
    if (record.status !== 'pending') throw new QuestionAlreadySettledError(questionId, record.status);
    return record;
  }

  /** Отмена без пробрасывания ошибки (таймаут/аборт — путь «fire and forget»). */
  private async _cancelInternal(questionId: string, reason: string): Promise<void> {
    try {
      await this.cancel(questionId, reason);
    } catch (err) {
      if (err instanceof QuestionAlreadySettledError) return;
      if (err instanceof QuestionNotFoundError) return;
      throw err;
    }
  }

  /** Разрешить ожидание ответа и снять таймер/слушатель отмены. */
  private _settle(record: QuestionRecord, outcome: QuestionOutcome): void {
    const waiter = this._waiters.get(record.id);
    if (!waiter) return;
    this._waiters.delete(record.id);
    this._clearWaiter(waiter);
    waiter.resolve(outcome);
  }

  /** Снять таймер таймаута и слушатель `abort`. */
  private _clearWaiter(waiter: QuestionWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private _publishAsked(record: QuestionRecord): void {
    this._eventBus.publish(record.sessionId, 'user_question.asked', {
      question_id: record.id,
      session_id: record.sessionId,
      questions: record.questions,
      ...(record.turnId ? { turn_id: record.turnId } : {}),
      ...(record.toolCallId ? { tool_call_id: record.toolCallId } : {}),
      ...(record.agentRole ? { agent_role: record.agentRole } : {}),
    });
  }

  private _publishAnswered(record: QuestionRecord): void {
    this._eventBus.publish(record.sessionId, 'user_question.answered', {
      question_id: record.id,
      session_id: record.sessionId,
      answers: record.answers ?? [],
    });
  }

  private _publishCancelled(record: QuestionRecord, reason: string): void {
    this._eventBus.publish(record.sessionId, 'user_question.cancelled', {
      question_id: record.id,
      session_id: record.sessionId,
      reason,
    });
  }
}

/**
 * Проверка ответа по составу вопроса.
 *
 * Правила (ADR-029-подобная строгость, но для данных, а не для прав):
 * - число ответов равно числу вопросов;
 * - на каждый вопрос — хотя бы одно значение;
 * - одиночный вопрос (`multiple: false`) — не больше одного значения;
 * - значение из `options[].value` — всегда валидно;
 * - **свободный ответ разрешён всегда** (аналог «Type your own answer» в
 *   opencode): любая непустая строка (после `trim()`) валидна; ограничение —
 *   длина (`MAX_FREE_ANSWER_LENGTH`) и непустота. Пустая/пробельная строка —
 *   `empty_answer`, не-строка — `invalid_answer`, длиннее предела —
 *   `answer_too_long`.
 */
export function validateAnswers(questions: QuestionItem[], answers: string[][]): void {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new QuestionInvalidAnswerError('answer_count_mismatch');
  }
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const values = answers[i];
    if (!Array.isArray(values) || values.length === 0) {
      throw new QuestionInvalidAnswerError('empty_answer', i);
    }
    // Одиночный вопрос — максимум одно значение (свой ответ заменяет вариант).
    if (question?.multiple !== true && values.length > 1) {
      throw new QuestionInvalidAnswerError('too_many_answers', i);
    }
    const allowed = new Set((question?.options ?? []).map((o) => o.value));
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new QuestionInvalidAnswerError('invalid_answer', i);
      }
      if (allowed.has(value)) continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        throw new QuestionInvalidAnswerError('empty_answer', i);
      }
      if (trimmed.length > MAX_FREE_ANSWER_LENGTH) {
        throw new QuestionInvalidAnswerError('answer_too_long', i);
      }
    }
  }
}

/** Генератор id по умолчанию: `qst_<uuid>`. */
function defaultGenerateId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/** Источник времени по умолчанию — ISO-8601. */
function defaultNow(): string {
  return new Date().toISOString();
}
