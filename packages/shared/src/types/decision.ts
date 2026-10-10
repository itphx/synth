/**
 * AD-084: decision-модели (System One: Clef/Jev/Decision-1/…) как единый
 * примитив — `state` (текст/JSON) + типизированные вопросы → вероятности за
 * один forward-pass. Здесь только контракты без бизнес-логики: сами адаптеры и
 * вызовы живут в core (`providers/decision.ts`, `GatewayProvider.decide`).
 */
import { z } from 'zod';

/**
 * Тип вопроса:
 * - `noul` — бинарный вопрос (да/нет → вероятность);
 * - `choice` — выбор одного из вариантов (`probabilities` + `confidence`);
 * - `score` — позиция на шкале (`probabilities` + `confidence` + `legend`).
 */
export type DecisionQuestionType = 'noul' | 'choice' | 'score';

/** Границы числа вариантов для `choice`/`score` (System One-контракт). */
export const DECISION_CRITERIA_MIN = 2;
export const DECISION_CRITERIA_MAX = 26;

/**
 * AD-084: бинарный вопрос. `criteria` — подписи веток `true`/`false` (опц.),
 * `instructions` — пояснение для модели (опц.).
 */
export interface DecisionNoulQuestion {
  type: 'noul';
  instructions?: string;
  criteria?: { true?: string; false?: string };
}

/** AD-084: вопрос-выбор. `criteria` — карта «вариант → пояснение|null» (2..26). */
export interface DecisionChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

/** AD-084: вопрос-шкала. `criteria` — упорядоченный список позиций (2..26). */
export interface DecisionScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

/** AD-084: типизированный вопрос decision-модели. */
export type DecisionQuestion =
  | DecisionNoulQuestion
  | DecisionChoiceQuestion
  | DecisionScoreQuestion;

/** AD-084: ответ на `noul` — вероятность «да» (`0..1`). */
export interface DecisionNoulAnswer {
  type: 'noul';
  noul: number;
}

/** AD-084: ответ на `choice` — выбранный вариант + вероятности по всем. */
export interface DecisionChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** AD-084: ответ на `score` — позиция на шкале + вероятности по всем. */
export interface DecisionScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  /** Подписи позиций шкалы (если модель/провайдер их отдаёт). */
  legend?: Record<string, string>;
}

/** AD-084: типизированный ответ decision-модели. */
export type DecisionAnswer =
  | DecisionNoulAnswer
  | DecisionChoiceAnswer
  | DecisionScoreAnswer;

/**
 * AD-084: медиа-вложения decision-запроса (AD-085 задел). Источник изображений/
 * видео — мультимодальный ввод (пока не реализован), здесь только контракт-
 * plumbing: значения прокидываются в тело decision-запроса, если непусты.
 */
export interface DecisionMediaInput {
  images?: string[];
  videos?: string[];
}

/** AD-084: запрос `state + questions → answers`. */
export interface DecisionRequest extends DecisionMediaInput {
  model: string;
  /** Текст или JSON-совместимая структура (System One понимает оба). */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

/** AD-084: расход токенов decision-запроса (snake_case — как у провайдеров). */
export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
}

/** AD-084: ответ decision-модели. */
export interface DecisionResponse {
  id?: string;
  model?: string;
  answers: Record<string, DecisionAnswer>;
  usage?: DecisionUsage;
}

// --- Zod-схемы (валидация запроса/ответа) ---

const decisionNoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: z.string().optional(),
  criteria: z
    .object({ true: z.string().optional(), false: z.string().optional() })
    .optional(),
});

const decisionChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string().nullable()),
});

const decisionScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: z.string(),
  criteria: z.array(z.string()),
});

/**
 * AD-084: универсальная схема вопроса. Границы `choice`/`score` (2..26)
 * проверяются отдельно — иначе `discriminatedUnion` не принимает
 * `ZodEffects`-обёртки внутри вариантов.
 */
export const decisionQuestionSchema = z
  .discriminatedUnion('type', [
    decisionNoulQuestionSchema,
    decisionChoiceQuestionSchema,
    decisionScoreQuestionSchema,
  ])
  .superRefine((question, ctx) => {
    if (question.type === 'choice') {
      const count = Object.keys(question.criteria).length;
      if (count < DECISION_CRITERIA_MIN || count > DECISION_CRITERIA_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `choice.criteria: от ${DECISION_CRITERIA_MIN} до ${DECISION_CRITERIA_MAX} вариантов`,
        });
      }
    }
    if (question.type === 'score') {
      const count = question.criteria.length;
      if (count < DECISION_CRITERIA_MIN || count > DECISION_CRITERIA_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `score.criteria: от ${DECISION_CRITERIA_MIN} до ${DECISION_CRITERIA_MAX} позиций`,
        });
      }
    }
  });

export const decisionNoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number(),
});

export const decisionChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

export const decisionScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
  legend: z.record(z.string(), z.string()).optional(),
});

/** AD-084: схема ответа decision-модели. */
export const decisionAnswerSchema = z.discriminatedUnion('type', [
  decisionNoulAnswerSchema,
  decisionChoiceAnswerSchema,
  decisionScoreAnswerSchema,
]);

export const decisionRequestSchema = z.object({
  model: z.string(),
  state: z.unknown(),
  questions: z.record(z.string(), decisionQuestionSchema),
  /** AD-084/AD-085: медиа-вложения (изображения/видео) — опциональны. */
  images: z.array(z.string()).optional(),
  videos: z.array(z.string()).optional(),
});

export const decisionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  answers: z.record(z.string(), decisionAnswerSchema),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
});
