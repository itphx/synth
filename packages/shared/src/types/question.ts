/**
 * Контракт «вопрос пользователю» (`ask_user`, этап 1 roadmap 0.13 — блок 1.3).
 *
 * Модель: агент задаёт один или несколько вопросов с вариантами ответа и ждёт
 * решения пользователя. Вопрос — **персистентная запись** (порт
 * `QuestionRepository`, ADR-096): она переживает реконнект UI и рестарт сервиса,
 * поэтому ответ приходит по `id` вопроса, а не «по каналу».
 *
 * Здесь только контракты (типы + Zod-схемы HTTP-входа) — без бизнес-логики:
 * запуск вопроса, ожидание ответа и таймаут живут в core.
 */
import { z } from 'zod';

/**
 * Статус вопроса:
 * - `pending` — вопрос задан, ответ не получен;
 * - `answered` — пользователь ответил;
 * - `cancelled` — вопрос отменён (таймаут, прерывание хода, отмена пользователем).
 */
export type QuestionStatus = 'pending' | 'answered' | 'cancelled';

/** Терминальные статусы вопроса — записи, которые можно чистить (`prune`). */
export const QUESTION_TERMINAL_STATUSES: readonly QuestionStatus[] = ['answered', 'cancelled'];

/** Вариант ответа на вопрос (значение `value` уходит в `answers`). */
export interface QuestionOption {
  /** Машинное значение варианта (то, что возвращается в ответе). */
  value: string;
  /** Человекочитаемая подпись варианта. */
  label: string;
  /** Пояснение к варианту (необязательно). */
  description?: string;
}

/** Один вопрос с набором вариантов ответа. */
export interface QuestionItem {
  /** Текст вопроса (задаётся пользователю). */
  question: string;
  /** Короткий заголовок вопроса (для UI-карточки). */
  header: string;
  /** Варианты ответа. */
  options: QuestionOption[];
  /** Разрешён ли выбор нескольких вариантов. */
  multiple?: boolean;
}

/**
 * Персистентная запись вопроса (`qst_<uuid>`).
 *
 * `answers` — по индексу вопроса: `answers[i]` — список выбранных значений
 * вариантов для `questions[i]`. Проверка «непусто для обязательного вопроса»
 * и соответствие длины числу вопросов — на сервисе (в Zod-схеме входа их нет:
 * длина зависит от вопроса, известного только серверу).
 */
export interface QuestionRecord {
  /** `qst_<uuid>`, уникален в пределах инстанса. */
  id: string;
  /** Сессия, в которой задан вопрос. */
  sessionId: string;
  /** Ход сессии, в котором задан вопрос (необязательно). */
  turnId?: string;
  /** Вызов тула, породивший вопрос (необязательно). */
  toolCallId?: string;
  /** Агент, задавший вопрос (необязательно). */
  agentRole?: string;
  /** Список вопросов (пустой — не валидная запись). */
  questions: QuestionItem[];
  status: QuestionStatus;
  /** Ответы — по индексу вопроса. */
  answers?: string[][];
  createdAt: string;
  updatedAt: string;
  /** Срок ожидания ответа (ISO-8601); после него вопрос считается истёкшим. */
  expiresAt?: string;
  /** Момент получения ответа (ISO-8601). */
  answeredAt?: string;
  /** Момент отмены вопроса (ISO-8601). */
  cancelledAt?: string;
  /** Причина отмены (`timeout`/`aborted`/`interrupted`/`user`/…). */
  cancelReason?: string;
  /** Кто ответил (идентификатор пользователя инстанса). */
  answeredBy?: string;
}

// ── Zod-схемы (HTTP-вход и запись) ─────────────────────────────────────────────

/** Статус вопроса (канонический набор). */
export const questionStatusSchema = z.enum(['pending', 'answered', 'cancelled']);

/** Вариант ответа. */
export const questionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

/** Один вопрос с вариантами. */
export const questionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z.array(questionOptionSchema),
  multiple: z.boolean().optional(),
});

/**
 * Полная запись вопроса (ответы API). Поле `answers` — массив массивов
 * (`answers[i]` — выбранные значения вариантов для `questions[i]`).
 */
export const questionRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().optional(),
  toolCallId: z.string().optional(),
  agentRole: z.string().optional(),
  questions: z.array(questionItemSchema),
  status: questionStatusSchema,
  answers: z.array(z.array(z.string())).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  expiresAt: z.string().optional(),
  answeredAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  answeredBy: z.string().optional(),
});

/**
 * Тело ответа на вопрос (`POST` ответа пользователя).
 *
 * Длина `answers` равна числу заданных вопросов, каждая строка — список
 * выбранных значений вариантов. Соответствие длины и непустота обязательных
 * ответов проверяет **сервис** (он знает состав вопроса).
 */
export const questionAnswerSchema = z.object({
  answers: z.array(z.array(z.string())),
});

/** Тело отмены вопроса (`reason` — свободное пояснение). */
export const questionCancelSchema = z.object({
  reason: z.string().optional(),
});

/** Форма входа схемы ответа (ответы — по индексу вопроса). */
export type QuestionAnswerInput = z.input<typeof questionAnswerSchema>;
/** Форма входа схемы отмены. */
export type QuestionCancelInput = z.input<typeof questionCancelSchema>;
