/**
 * Тул `question` — вопрос пользователю посреди хода (этап 1 roadmap 0.13 —
 * блок 3, ADR-089/ADR-104 по границам хода).
 *
 * Агент задаёт один или несколько вопросов с вариантами ответа и **ждёт**
 * ответа: ход стоит, пока пользователь не ответит, не отменит вопрос и не
 * истечёт срок ожидания. По умолчанию срока **нет** (`questions.timeoutMs = 0`
 * — вопрос ждёт бесконечно); срок может задать сам тул (`timeout`, ≥ 5 минут —
 * не рекомендуется: ожидание обрывается).
 *
 * Механика — в сервисе `engine/question/service.ts` (владеет записью вопроса,
 * ожиданием и событиями `user_question.*`); тул только переводит исход
 * сервиса в `tool_result`.
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, QuestionItem } from '@itphx/synth-shared';
import type { QuestionService } from '../question/service.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Зависимости тула из `ToolContext.extra` (упаковка — оркестратор).
 *
 * `streamId` — идентификатор хода (`turnId` в событиях), `callId` — идентификатор
 * вызова тула: по ним вопрос привязан к ходу и вызову.
 */
export interface QuestionToolExtra {
  questionService?: QuestionService;
  streamId?: string;
  callId?: string;
}

const questionOptionSchema = z
  .object({
    value: z.string().min(1).describe('Machine value of the option (returned in the answer)'),
    label: z.string().min(1).describe('Short human-readable label of the option'),
    description: z
      .string()
      .optional()
      .describe('Optional explanation of what this option means'),
  })
  .strict();

const questionItemSchema = z
  .object({
    question: z.string().min(1).describe('The question to ask the user'),
    header: z.string().min(1).describe('Very short title of the question (a few words)'),
    options: z
      .array(questionOptionSchema)
      .min(1)
      .max(8)
      .describe('Answer options; put the recommended one first'),
    multiple: z
      .boolean()
      .optional()
      .describe('Allow the user to select more than one option'),
  })
  .strict();

const questionToolSchema = z
  .object({
    questions: z
      .array(questionItemSchema)
      .min(1)
      .max(5)
      .describe('Questions to ask the user (1-5)'),
    timeout: z
      .number()
      .int()
      .min(300_000)
      .max(86_400_000)
      // Описание — до `.optional()`: конвертер `zodToJsonSchema` разворачивает
      // обёртку `optional` и берёт описание внутреннего типа — иначе модель
      // не увидит ни единицы измерения, ни минимума.
      .describe(
        'Optional answer timeout in milliseconds — a top-level parameter of the tool call, not a field of a question. '
        + 'By default the question waits indefinitely (no timeout). Not recommended: it aborts waiting. '
        + 'Minimum 300000 (5 minutes).',
      )
      .optional(),
  })
  .strict();

export const questionTool: ToolDefinition = {
  name: 'question',
  description:
    'Ask the user one or more questions and wait for their answers. '
    + 'Use it when you need to clarify requirements, choose between options, or get a decision before continuing. '
    + 'Give each question a short header and concrete options; put the recommended option first and mark it with "(Recommended)". '
    + 'A free-text "Type your own answer" option is added automatically - do not add your own free-text option. '
    + 'Set multiple=true only if several options can be chosen at once. '
    + 'Set the top-level "timeout" (not inside a question object) only if the user explicitly wants the question to expire; it is not recommended.',
  parameters: questionToolSchema,
  capabilities: [ToolCapability.QUESTION],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts).
    if (isAborted(ctx)) return abortedResult(this.name);

    const extra = ctx.extra as QuestionToolExtra | undefined;
    const service = extra?.questionService;
    if (!service) {
      return {
        content: sm('question.deps_unavailable'),
        isError: true,
        metadata: { i18n: i18nMeta('question.deps_unavailable') },
      };
    }

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return {
        content: sm('tool.args_error', {
          tool: this.name,
          issues: parsed.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
        }),
        isError: true,
        metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) },
      };
    }

    const questions = parsed.data.questions as QuestionItem[];
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      return {
        content: sm('question.deps_unavailable'),
        isError: true,
        metadata: { i18n: i18nMeta('question.deps_unavailable') },
      };
    }

    const outcome = await service.ask({
      sessionId,
      ...(typeof extra?.streamId === 'string' ? { turnId: extra.streamId } : {}),
      ...(typeof extra?.callId === 'string' ? { toolCallId: extra.callId } : {}),
      ...(ctx.agentRole ? { agentRole: ctx.agentRole } : {}),
      questions,
      // Срок ожидания ответа: переопределение конфигурации `questions.timeoutMs`
      // для конкретного вопроса. Не задан — берётся конфиг (по умолчанию — без
      // таймаута, вопрос ждёт ответа бесконечно).
      ...(typeof parsed.data.timeout === 'number' ? { timeoutMs: parsed.data.timeout } : {}),
      // Сигнал отмены хода: по нему вопрос снимается с ожидания.
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });

    if (outcome.status === 'answered') {
      const summary = formatAnswers(questions, outcome.answers);
      return {
        content: sm('question.answered', { answers: summary }),
        metadata: {
          question_id: outcome.question.id,
          answers: outcome.answers,
          i18n: i18nMeta('question.answered', { answers: summary }),
        },
      };
    }

    // Отмена: ход прерван («Стоп»/аборт) — единый результат прерывания.
    if (outcome.reason === 'aborted') {
      return abortedResult(this.name);
    }

    return {
      content: sm('question.cancelled', { reason: outcome.reason }),
      isError: true,
      metadata: {
        question_id: outcome.question.id,
        reason: outcome.reason,
        i18n: i18nMeta('question.cancelled', { reason: outcome.reason }),
      },
    };
  },
};

/**
 * Сводка ответов для модели: `"<вопрос>"="<значение, значение>"`.
 *
 * Значения — машинные (`options[].value`), а не подписи: по ним модель
 * продолжает работу однозначно.
 */
export function formatAnswers(questions: QuestionItem[], answers: string[][]): string {
  return questions
    .map((question, index) => {
      const values = (answers[index] ?? []).join(', ');
      return `"${question.question}"="${values}"`;
    })
    .join('; ');
}
