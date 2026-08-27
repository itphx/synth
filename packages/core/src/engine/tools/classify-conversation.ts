/**
 * classify_conversation — инструмент для классификации разговора моделью (AD-034).
 * Модель вызывает его когда определила характер задачи.
 * Устанавливает routingCategory в метаданных сессии.
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolContext, ToolResult } from '@itphx/synth-shared';
import { isAborted, abortedResult } from './abort.js';

const classifyConversationSchema = z.object({
  category: z.enum(['coding', 'chat', 'research']).describe('Категория текущего разговора'),
});

export const classifyConversationTool: ToolDefinition = {
  name: 'classify_conversation',
  description:
    'Классифицирует текущий разговор по категории. Вызови когда определил(а) характер задачи: ' +
    'coding (написание/изменение кода), research (анализ/исследование/объяснение), chat (общий разговор/вопрос).',
  capabilities: [ToolCapability.RUNTIME],
  parameters: classifyConversationSchema,
  execute: async (
    params: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult('classify_conversation');
    const parsed = classifyConversationSchema.parse(params);
    return {
      content: JSON.stringify({
        routingCategory: parsed.category,
        message: `Разговор классифицирован как "${parsed.category}"`,
      }),
      metadata: { routingCategory: parsed.category },
    };
  },
};
