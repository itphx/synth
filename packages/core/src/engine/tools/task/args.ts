/**
 * Схема и типы аргументов тула `task` (ADR-026: режимы контекста саб-агента).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения.
 */
import { z } from 'zod';

export const taskParametersSchema = z.object({
  description: z.string().describe('A short (3-5 words) description of the task'),
  prompt: z.string().describe('The task for the subagent to perform'),
  subagent_type: z.string().describe('Type of subagent: "general" or "explore"'),
  task_id: z.string().optional().describe('ID for resuming an existing subagent session'),
  context_mode: z.enum(['none', 'inherit', 'summary', 'last_n']).optional()
    .describe('Context passing mode: none — only prompt, inherit — full parent history, summary — compressed via LLM, last_n — last N messages (default: none)'),
  context_count: z.number().int().min(1).max(50).optional()
    .describe('Number of last messages to include (only for last_n mode, default: 4)'),
  model: z.string().optional()
    .describe('Override model for the subagent'),
  provider: z.string().optional()
    .describe('Override provider for the subagent'),
  routing_strategy: z.enum(['auto', 'content', 'cost', 'none']).optional()
    .describe('Routing strategy for the subagent (default: inherit from parent)'),
  skip_context_files: z.boolean().optional()
    .describe('Do not include project instruction files (AGENTS.md) in the subagent prompt. Default: false'),
});

export type TaskParams = z.infer<typeof taskParametersSchema>;
