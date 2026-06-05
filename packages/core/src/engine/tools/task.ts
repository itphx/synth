import { z } from 'zod';
import { ToolCapability } from '@synth/shared';
import type { ToolDefinition } from '@synth/shared';
import type { AgentRegistry } from '../agents/registry.js';
import type { BaseProvider } from '../../providers/base.js';

interface TaskExtra {
  provider: BaseProvider;
  agentRegistry: AgentRegistry;
  sessionSettings?: {
    temperature?: number;
    maxTokens?: number;
  };
}

export const taskTool: ToolDefinition = {
  name: 'task',
  description:
    'Launch a new agent to handle complex, multistep tasks autonomously. '
    + 'Available subagent types: "general" (full tool access), "explore" (read-only code exploration). '
    + 'Use for tasks that require multiple tool calls. '
    + 'IMPORTANT: You must NOT ask the user to use the task tool — use it yourself proactively.',
  parameters: z.object({
    description: z.string().describe('A short (3-5 words) description of the task'),
    prompt: z.string().describe('The task for the subagent to perform'),
    subagent_type: z.string().describe('Type of subagent: "general" or "explore"'),
    task_id: z.string().optional().describe('ID for resuming an existing subagent session'),
  }),
  capabilities: [ToolCapability.TASK],
  async execute(args, ctx) {
    const params = args as { description: string; prompt: string; subagent_type: string; task_id?: string };
    const extra = ctx.extra as TaskExtra | undefined;

    if (!extra?.provider || !extra?.agentRegistry) {
      return {
        content: 'Ошибка: провайдер или реестр агентов недоступны для запуска сабагента',
        isError: true,
      };
    }

    const agentDef = extra.agentRegistry.get(params.subagent_type);
    if (!agentDef) {
      return {
        content: `Сабагент "${params.subagent_type}" не найден. Доступные типы: ${extra.agentRegistry.getSubagents().map((a) => a.id).join(', ')}`,
        isError: true,
      };
    }

    if (agentDef.agentMode !== 'subagent' && agentDef.agentMode !== 'all') {
      return {
        content: `Агент "${params.subagent_type}" не может использоваться как сабагент (agentMode: ${agentDef.agentMode ?? 'primary'})`,
        isError: true,
      };
    }

    const systemPrompt = agentDef.subagentPrompt || '';
    const tools = extra.agentRegistry.getToolsForAgent(agentDef.id);
    const maxSteps = agentDef.maxSteps ?? 10;

    const messages = [
      {
        id: '',
        role: 'system' as const,
        content: systemPrompt,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      },
      {
        id: '',
        role: 'user' as const,
        content: params.prompt,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      },
    ];

    try {
      const response = await extra.provider.chat(
        messages,
        systemPrompt || undefined,
        tools as Record<string, unknown>[] | undefined,
        false,
      );

      const output = response.content || '(пустой ответ сабагента)';

      return {
        content: `<task_result>\n<summary>${params.description}</summary>\n\n${output}\n</task_result>`,
        metadata: {
          subagent_type: params.subagent_type,
          description: params.description,
          steps: 1,
          model: response.model,
          usage: response.usage,
        },
      };
    } catch (err: unknown) {
      return {
        content: `Ошибка выполнения сабагента "${params.subagent_type}": ${String(err)}`,
        isError: true,
        metadata: { subagent_type: params.subagent_type },
      };
    }
  },
};
