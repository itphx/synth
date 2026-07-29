import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '@synth/shared';
import { ToolCapability } from '@synth/shared';
import type { SessionManager } from '../../sessions/manager.js';

const paramsSchema = z.object({
  session_id: z.string().describe('ID сессии, на которую есть ссылка'),
  message_range: z.array(z.number()).length(2).optional()
    .describe('Диапазон сообщений (seq from..to), если не указан — все сообщения'),
});

export const readSessionReferenceTool: ToolDefinition = {
  name: 'read_session_reference',
  description: 'Читает содержимое referenced-сессии (сессии, на которую есть ссылка). Используй когда видишь в контексте блок session_reference.',
  parameters: paramsSchema,
  capabilities: [ToolCapability.FILE_READ],
  async execute(params, ctx: ToolContext): Promise<ToolResult> {
    const sessionManager = ctx.extra?.sessionManager as SessionManager | undefined;
    if (!sessionManager) {
      return { content: 'SessionManager недоступен', isError: true };
    }

    const p = params as z.infer<typeof paramsSchema>;
    const session = await sessionManager.getSession(p.session_id);
    if (!session) {
      return { content: `Сессия ${p.session_id} не найдена`, isError: true };
    }

    let messages = session.messages.filter((m) => !m.hidden && !m.disabled);
    if (p.message_range && p.message_range.length === 2) {
      const fromSeq = p.message_range[0]!;
      const toSeq = p.message_range[1]!;
      messages = messages.filter((m) => m.seq >= fromSeq && m.seq <= toSeq);
    }

    if (messages.length === 0) {
      return { content: `В сессии ${p.session_id} нет сообщений в указанном диапазоне` };
    }

    const formatted = messages
      .map((m) => {
        const title = `[${m.role}${m.agentRole ? `:${m.agentRole}` : ''}] (seq ${m.seq}${m.author ? `, ${m.author}` : ''})`;
        return `${title}:\n${m.content}\n`;
      })
      .join('\n---\n');

    return { content: `# Сессия: ${session.title || session.id}\n\n${formatted}` };
  },
};
