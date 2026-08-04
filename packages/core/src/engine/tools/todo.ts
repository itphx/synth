import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition, TodoItem } from '@synth/shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';

export interface TodoToolExtra {
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionId?: string;
}

const todoItemSchema = z.object({
  content: z.string().describe('Todo item text'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).describe('Current status of the item'),
  priority: z.enum(['high', 'medium', 'low']).describe('Priority of the item'),
});

export const todoWriteTool: ToolDefinition = {
  name: 'todo_write',
  description:
    'Replace the session todo list with the given items. '
    + 'The list is stored in the session state (not a file) and can be read by the UI. '
    + 'Returns the resulting todo list as JSON.',
  parameters: z.object({
    todos: z.array(todoItemSchema).describe('Full list of todo items to store'),
  }),
  capabilities: [ToolCapability.RUNTIME],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return {
        content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`,
        isError: true,
      };
    }
    const params = parsed.data as { todos: TodoItem[] };
    const extra = ctx.extra as TodoToolExtra | undefined;

    if (!extra?.sessionManager || !extra.sessionId) {
      return {
        content: 'Ошибка: менеджер сессий недоступен для todo_write',
        isError: true,
      };
    }

    try {
      await extra.sessionManager.withLock(extra.sessionId, async (s) => {
        s.todos = params.todos;
        await extra.sessionManager!.saveSession(s);
      });
    } catch (err) {
      return {
        content: `Ошибка сохранения todo-списка: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // AD-XXX: публикуем событие для динамического обновления ToDo в UI.
    extra.eventBus?.publish(extra.sessionId, 'todos.updated', {
      session_id: extra.sessionId,
      todos: params.todos,
    });

    return {
      content: JSON.stringify(params.todos),
      metadata: { todos: params.todos },
    };
  },
};
