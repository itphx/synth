/**
 * Схема и типы аргументов тула `task` (ADR-026: режимы контекста саб-агента).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения.
 *
 * PROP-142 §1–§2: `prompt`/`subagent_type` обязательны только для **новой**
 * задачи. При `task_id` (продолжение ребёнка / доставка сообщения идущему
 * сабагенту) они необязательны. Условие проверяет `superRefine` — ошибка
 * уходит штатным `argErrorResult` (issue на конкретное поле), а не падением
 * в `execute`.
 */
import { z } from 'zod';
import { todoAddItemSchema } from '../todo.js';

export const taskParametersSchema = z.object({
  description: z.string().describe('A short (3-5 words) description of the task'),
  prompt: z.string().optional().describe(
    'The task for the subagent to perform. Required for a new task; optional when continuing '
    + 'an existing subagent with task_id (then it is the new instruction for that subagent)',
  ),
  subagent_type: z.string().optional().describe(
    'Subagent type from the agent registry: any agent whose mode includes "subagent" '
    + '(for example general, explore, fixer, tester, researcher, security-auditor, devops, admin). '
    + 'An unknown type returns the list of available types. '
    + 'Required for a new task; with task_id it must match the agent of that child session '
    + '(the subagent type cannot be switched by continuing a session)',
  ),
  task_id: z.string().optional().describe('ID for resuming an existing subagent session'),
  delivery: z.enum(['steer', 'queue']).optional().describe(
    'How to deliver the message to a subagent that is already running in the background: '
    + 'steer (default) — inject at the next step boundary; queue — deliver after the current run and continue once',
  ),
  background: z.boolean().optional()
    .describe('Run the subagent in the background and return control immediately; you will be notified automatically — do not poll its status'),
  context_mode: z.enum(['none', 'inherit', 'summary', 'last_n']).optional()
    .describe(
      'Parent context passing mode (default: none — fresh context, only the prompt). '
      + 'Pass parent context only when the task really needs it: inherit — full parent history, '
      + 'last_n — last N messages, summary — one-off compression of the parent history '
      + '(it is NOT automatic summarization of the child session; the child session never '
      + 'inherits the parent auto-summarization). For self-contained tasks keep none',
    ),
  context_count: z.number().int().min(1).max(50).optional()
    .describe('Number of last messages to include (only for last_n mode, default: 4)'),
  model: z.string().optional()
    .describe('Override model for the subagent'),
  provider: z.string().optional()
    .describe('Override provider for the subagent'),
  executor_profile: z.string().optional()
    .describe(
      'Execution profile for the child session (execution.remote.profiles). '
      + 'Must exist in the instance catalog and be allowed by project.executor.allowedProfiles '
      + 'and the subagent\'s allowedProfiles (empty/absent lists mean no restriction). '
      + 'Omitted — the child inherits the parent session settings.',
    ),
  routing_strategy: z.enum(['auto', 'content', 'cost', 'none']).optional()
    .describe('Routing strategy for the subagent (default: inherit from parent)'),
  skip_context_files: z.boolean().optional()
    .describe('Do not include project instruction files (AGENTS.md) in the subagent prompt. Default: false'),
  todos: z.array(todoAddItemSchema).optional()
    .describe(
      'Starting todo list for the child session: its own operational task list (distinct from the project plan '
      + 'in project.plan). Item ids are kept as provided so you can reconcile them with your own list; '
      + 'status defaults to "pending", priority to "medium". '
      + 'For a new child session this seeds its list; together with task_id it REPLACES the existing list '
      + '(same semantics as todo_write). Omit to leave an existing child list untouched. '
      + 'The list is visible to the child as a durable todos state message.',
    ),
}).superRefine((value, ctx) => {
  // Без `task_id` — это новая задача: промпт и тип агента обязательны.
  // Ошибка — issue на конкретное поле (штатный `tool.args_error`).
  if (value.task_id) return;
  if (value.prompt === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['prompt'],
      message: 'prompt is required for a new task (omit it only when continuing an existing subagent with task_id)',
    });
  }
  if (value.subagent_type === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['subagent_type'],
      message: 'subagent_type is required for a new task (omit it only when continuing an existing subagent with task_id)',
    });
  }
});

export type TaskParams = z.infer<typeof taskParametersSchema>;
