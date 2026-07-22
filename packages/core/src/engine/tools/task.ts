import { z } from 'zod';
import { ToolCapability, MessageRole, nowISO, generateId, makeTextPart, TsmState } from '@synth/shared';
import type { ToolDefinition, ToolResult, Message } from '@synth/shared';
import type { AgentRegistry } from '../agents/registry.js';
import type { BaseProvider, LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ToolRegistry } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import { serializeSession } from '../../server/serialize.js';

interface TaskExtra {
  provider: BaseProvider;
  agentRegistry: AgentRegistry;
  toolRegistry?: ToolRegistry;
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  sessionSettings?: {
    temperature?: number;
    maxTokens?: number;
  };
  publish?: (type: string, data: Record<string, unknown>) => void;
  streamId?: string;
  sessionId?: string;
  callerAgentRole?: string;
}

const DEFAULT_SUBAGENT_MAX_STEPS = 15;

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
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { description: string; prompt: string; subagent_type: string; task_id?: string };
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
    const maxSteps = agentDef.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS;
    const effectiveMaxSteps = (maxSteps === 0)
      ? Number.POSITIVE_INFINITY
      : maxSteps;
    const publish = extra.publish;

    // Создать дочернюю сессию если есть sessionManager
    let childSessionId: string | undefined;
    if (extra.sessionManager && extra.sessionId) {
      try {
        const parentSession = await extra.sessionManager.getSession(extra.sessionId);
        if (parentSession) {
          const child = await extra.sessionManager.createSession({
            title: `Подзадача: ${params.description}`,
            projectId: parentSession.projectId,
            engine: parentSession.engine,
            parentId: extra.sessionId,
            sessionOrigin: 'subagent',
            settings: { ...parentSession.settings, agentRole: params.subagent_type },
          });
          child.userId = parentSession.userId;
          child.ownerId = parentSession.ownerId;
          await extra.sessionManager.updateSession(child);
          childSessionId = child.id;
          if (extra.eventBus) {
            extra.eventBus.publish(extra.sessionId, 'session.created', serializeSession(child));
          }
        }
      } catch {
        // не фатально — продолжаем без дочерней сессии
      }
    }

    const messages: LLMMessage[] = [
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

    const cancelToken: CancellationToken = { cancelled: false, cancel: () => { cancelToken.cancelled = true; } };

    try {
      let finalContent = '';
      let iteration = 0;
      const doomTracker = new Map<string, number>();
      let subagentReasoning = '';

      const allSubagentReasoning: Array<{ text: string; iteration: number }> = [];
      const allSubagentIntermediateTexts: Array<{ text: string; iteration: number }> = [];
      const allSubagentToolCalls: Array<{
        name: string; args: Record<string, unknown>; id?: string;
        result?: { content: string; isError?: boolean };
        started_at?: string; completed_at?: string; iteration: number;
      }> = [];

      while (iteration < effectiveMaxSteps) {
        if (cancelToken.cancelled) break;

        let accumulatedContent = '';
        let toolCalls: Record<string, unknown>[] | undefined = [];
        let reasoning = '';

        try {
          for await (const chunk of extra.provider.chatAsync(
            messages,
            systemPrompt || undefined,
            tools as Record<string, unknown>[] | undefined,
            undefined,
            cancelToken,
          )) {
            if (cancelToken.cancelled) break;
            if (chunk.isFinal) {
              accumulatedContent = chunk.content;
              reasoning = (chunk as unknown as Record<string, unknown>).reasoning as string || reasoning;
            } else {
              accumulatedContent += chunk.content;
            }
            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCalls = chunk.toolCalls;
            }
          }
        } catch (err) {
          return {
            content: `Ошибка выполнения сабагента "${params.subagent_type}": ${String(err)}`,
            isError: true,
            metadata: { subagent_type: params.subagent_type },
          };
        }

        if (cancelToken.cancelled) break;

        if (reasoning) {
          allSubagentReasoning.push({ text: reasoning, iteration });
        }

        if (!toolCalls || toolCalls.length === 0) {
          finalContent = accumulatedContent;
          if (reasoning) subagentReasoning = reasoning;
          break;
        }

        if (accumulatedContent) {
          allSubagentIntermediateTexts.push({ text: accumulatedContent, iteration });
        }

        iteration++;

        messages.push({
          id: '',
          role: 'assistant',
          content: accumulatedContent || '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          disabled: false,
          pinned: false,
          branchId: '',
          toolUse: toolCalls,
        });

        for (const tc of toolCalls) {
          const tcId = (tc.id as string) || `subcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const func = tc.function as { name: string; arguments: string | Record<string, unknown> } | undefined;
          if (!func?.name) continue;

          const toolName = func.name;
          let toolArgs: Record<string, unknown>;
          if (typeof func.arguments === 'string') {
            try { toolArgs = JSON.parse(func.arguments); } catch { toolArgs = {}; }
          } else {
            toolArgs = func.arguments || {};
          }

          const tcStartedAt = new Date().toISOString();

          const doomKey = `${toolName}:${JSON.stringify(toolArgs)}`;
          const doomCount = (doomTracker.get(doomKey) || 0) + 1;
          doomTracker.set(doomKey, doomCount);

          if (doomCount >= 3) {
            messages.push({
              id: '', role: 'tool',
              content: `Ошибка: инструмент "${toolName}" вызван ${doomCount} раз(а) с одинаковыми аргументами. Цикл прерван.`,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              disabled: false, pinned: false, branchId: '',
              toolCallId: tcId,
            });
            continue;
          }

          publish?.('tool_call.started', {
            stream_id: extra.streamId,
            session_id: extra.sessionId,
            call_id: tcId,
            name: toolName,
            arguments: toolArgs,
            iteration,
          });

          const toolDef = extra.toolRegistry?.get(toolName);
          let toolResult: ToolResult;

          if (toolDef) {
            const parsed2 = toolDef.parameters.safeParse(toolArgs);
            if (!parsed2.success) {
              toolResult = {
                content: `Ошибка аргументов инструмента "${toolName}": ${parsed2.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`,
                isError: true,
              };
            } else {
              try {
                toolResult = await toolDef.execute(parsed2.data, {
                  ...ctx,
                  abortSignal: ctx.abortSignal,
                  extra: extra as unknown as Record<string, unknown>,
                });
              } catch (execError) {
                toolResult = {
                  content: `Ошибка исполнения инструмента "${toolName}": ${String(execError)}`,
                  isError: true,
                };
              }
            }
          } else {
            toolResult = {
              content: `Инструмент "${toolName}" не найден`,
              isError: true,
            };
          }

          publish?.('tool_call.result', {
            stream_id: extra.streamId,
            session_id: extra.sessionId,
            call_id: tcId,
            name: toolName,
            result: toolResult,
            iteration,
          });

          allSubagentToolCalls.push({
            name: toolName,
            args: toolArgs,
            id: tcId,
            result: { content: toolResult.content, isError: toolResult.isError },
            started_at: tcStartedAt,
            completed_at: new Date().toISOString(),
            iteration,
          });

          messages.push({
            id: '', role: 'tool',
            content: toolResult.content,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            disabled: false, pinned: false, branchId: '',
            toolCallId: tcId,
          });
        }

        publish?.('tool_call.loop', {
          stream_id: extra.streamId,
          session_id: extra.sessionId,
          iteration,
          total_tool_calls: toolCalls.length,
        });
      }

      const output = finalContent || '(пустой ответ сабагента)';

      // Сохранить результат в дочернюю сессию
      if (childSessionId && extra.sessionManager) {
        try {
          const childSession = await extra.sessionManager.getSession(childSessionId);
          if (childSession) {
            const userMsg: Message = {
              id: generateId(),
              role: MessageRole.USER,
              seq: childSession.messages.length + 1,
              origin: 'local',
              parts: [makeTextPart(params.prompt)],
              content: params.prompt,
              createdAt: nowISO(),
              disabled: false,
              pinned: false,
              hidden: false,
              agentRole: extra.callerAgentRole,
              author: extra.callerAgentRole,
            };
            childSession.messages.push(userMsg);

            const assistantMsg: Message = {
              id: generateId(),
              role: MessageRole.ASSISTANT,
              seq: childSession.messages.length + 1,
              origin: 'local',
              parts: [makeTextPart(output)],
              content: output,
              createdAt: nowISO(),
              disabled: false,
              pinned: false,
              hidden: false,
              agentRole: params.subagent_type,
              reasoning: subagentReasoning || undefined,
              metadata: {
                steps: iteration,
                tool_calls: allSubagentToolCalls,
              },
            };
            childSession.messages.push(assistantMsg);

            childSession.status.state = TsmState.DONE;
            childSession.updatedAt = nowISO();
            await extra.sessionManager.updateSession(childSession);

            if (extra.eventBus) {
              extra.eventBus.publish(childSessionId, 'session.updated', { session_id: childSessionId });
            }
          }
        } catch {
          // не фатально
        }
      }

      return {
        content: `<task_result>\n<summary>${params.description}</summary>\n\n${output}\n</task_result>`,
        metadata: {
          subagent_type: params.subagent_type,
          description: params.description,
          steps: iteration,
          child_session_id: childSessionId,
          reasoning: subagentReasoning || undefined,
          reasoning_blocks: allSubagentReasoning.length > 0 ? allSubagentReasoning : undefined,
          intermediate_text_blocks: allSubagentIntermediateTexts.length > 0 ? allSubagentIntermediateTexts : undefined,
          tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
          final_content: finalContent || undefined,
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
