import { z } from 'zod';
import { ToolCapability, MessageRole, nowISO, generateId, makeTextPart } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult, Message, Session, SessionSettings, RouterConfig, PermissionConfig, PlanMode, SessionMode, SecurityConfig, ToolForLLM } from '@itphx/synth-shared';
import type { AgentRegistry } from '../agents/registry.js';
import { normalizeAgentModes } from '../agents/normalize.js';
import type { BaseProvider, LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ToolRegistry } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { ContextConfig } from '../context/config.js';
import type { ModelRouter } from '../router/router.js';
import { deriveSubagentPermission } from '../permission/derive.js';
import { PermissionEvaluator, isPlanRestricted, isPlanBlockedTool, getMcpToolAvailability } from '../permission/evaluator.js';
import { PermissionApprovalManager } from '../permission/approval.js';
import { serializeSession, serializeMessage } from '../../server/serialize.js';
import type { ShellPolicy } from '../security/shell-guard.js';
import type { ProtectedPathsPolicy } from '../security/protected-paths.js';

export interface TaskExtra {
  provider: BaseProvider;
  agentRegistry: AgentRegistry;
  toolRegistry?: ToolRegistry;
  sessionManager?: SessionManager;
  eventBus?: EventBus;
  contextOptimizer?: ContextOptimizer;
  sessionSettings?: {
    temperature?: number;
    maxTokens?: number;
  };
  parentSessionSettings?: SessionSettings;
  modelRouter?: ModelRouter;
  routerConfig?: RouterConfig;
  contextConfig?: ContextConfig;
  publish?: (type: string, data: Record<string, unknown>) => void;
  streamId?: string;
  sessionId?: string;
  callerAgentRole?: string;
  /** Permissions родительской сессии (AD-029) — наследуются саб-агентом с deny-дополнениями. */
  permissionConfig?: PermissionConfig;
  /** Секция безопасности (защита от Indirect Prompt Injection) из config.yaml. */
  securityConfig?: SecurityConfig;
  /** Политика безопасности execute_shell (денлист путей/команд) родительской сессии. */
  shellPolicy?: ShellPolicy;
  /** Единая политика защищённых путей (СКВОЗНАЯ проверка файловых тулов) родительской сессии. */
  protectedPaths?: ProtectedPathsPolicy;
  /** Тумблер полного отключения защищённых путей (default true). */
  protectedPathsEnabled?: boolean;
}

type ContextMode = 'none' | 'inherit' | 'summary' | 'last_n';

const DEFAULT_SUBAGENT_MAX_STEPS = 15;
const DEFAULT_LAST_N = 4;

function messageToLLMMessage(msg: Message): LLMMessage {
  const roleMap: Record<string, LLMMessage['role']> = {
    [MessageRole.USER]: 'user',
    [MessageRole.ASSISTANT]: 'assistant',
    [MessageRole.TOOL]: 'tool',
    [MessageRole.SYSTEM]: 'system',
    [MessageRole.SUMMARY]: 'user',
    [MessageRole.DEBUG]: 'user',
    [MessageRole.INFO]: 'user',
    [MessageRole.ERROR]: 'user',
  };

  return {
    id: msg.id,
    role: roleMap[msg.role] || 'user',
    content: msg.content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
    toolCallId: msg.toolCallId,
  };
}

async function publishMessageAdded(
  eventBus: EventBus,
  parentSessionId: string,
  childSessionId: string,
  msg: Message,
  index: number,
  childSession?: Session,
): Promise<void> {
  const serialized = serializeMessage(msg, index);
  const payload = {
    session_id: childSessionId,
    message: serialized,
    index,
  };
  eventBus.publish(childSessionId, 'message.added', payload);
  eventBus.publish(parentSessionId, 'child.message.added', {
    ...payload,
    child_session_id: childSessionId,
  });
  if (childSession) {
    eventBus.publish(parentSessionId, 'child.session.updated', {
      session: serializeSession(childSession),
    });
  }
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
  }),
  capabilities: [ToolCapability.TASK],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as {
      description: string;
      prompt: string;
      subagent_type: string;
      task_id?: string;
      context_mode?: ContextMode;
      context_count?: number;
      model?: string;
      provider?: string;
      routing_strategy?: 'auto' | 'content' | 'cost' | 'none';
    };
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

    if (!normalizeAgentModes(agentDef.agentMode).includes('subagent')) {
      return {
        content: `Агент "${params.subagent_type}" не может использоваться как сабагент (классы: ${agentDef.agentMode})`,
        isError: true,
      };
    }

    const contextMode: ContextMode = params.context_mode || 'none';
    const contextCount = params.context_count || DEFAULT_LAST_N;
    const systemPrompt = agentDef.subagentPrompt || '';
    let tools: ToolForLLM[] | undefined = extra.agentRegistry.getToolsForAgent(agentDef.id);
    const maxSteps = agentDef.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS;
    const effectiveMaxSteps = (maxSteps === 0)
      ? Number.POSITIVE_INFINITY
      : maxSteps;
    const publish = extra.publish;

    // ─── Настройки роутинга для дочерней сессии (AD-034 Фаза 4) ──
    const childRoutingOverrides: Partial<SessionSettings> = {};
    if (params.model) childRoutingOverrides.model = params.model;
    if (params.provider) childRoutingOverrides.provider = params.provider;
    if (agentDef?.reasoningLevel) childRoutingOverrides.reasoningLevel = agentDef.reasoningLevel;
    if (params.routing_strategy) {
      if (params.routing_strategy === 'none') {
        childRoutingOverrides.routingEnabled = false;
      } else {
        childRoutingOverrides.routingStrategy = params.routing_strategy;
      }
    }
    // Если subagentRouting включён в routerConfig, наследуем routing от родителя
    const subagentRoutingCfg = extra.routerConfig?.subagent;
    if (subagentRoutingCfg?.enabled && params.routing_strategy !== 'none') {
      childRoutingOverrides.routingEnabled = true;
      // Если есть дефолтная модель саб-агента в конфиге и не переопределена
      if (!params.model && subagentRoutingCfg.model) {
        childRoutingOverrides.model = subagentRoutingCfg.model;
      }
      if (!params.provider && subagentRoutingCfg.provider) {
        childRoutingOverrides.provider = subagentRoutingCfg.provider;
      }
    }

    let childSessionId: string | undefined;
    let childMessages: Message[] = [];
    let parentNotesText = '';

    // ─── Permissions дочерней сессии (AD-029): наследуем родителя + deny-дополнения ──
    const derivedPermission = deriveSubagentPermission(extra.permissionConfig);

    // ─── Создание дочерней сессии с контекстом ───────────────────────
    if (extra.sessionManager && extra.sessionId) {
      try {
        const parentSession = await extra.sessionManager.getSession(extra.sessionId);
        if (parentSession) {
          // Извлекаем активные заметки родителя для передачи саб-агенту
          const activeNotes = parentSession.stickyNotes.filter((n) => !n.disabled);
          if (activeNotes.length > 0) {
            parentNotesText = activeNotes.map((n) => n.content).join('\n\n---\n\n');
          }
          const effectiveMode = contextMode === 'summary' && !extra.contextOptimizer ? 'none' : contextMode;

          if (effectiveMode === 'inherit') {
            const fork = await extra.sessionManager.forkSession(extra.sessionId, {
              title: `Подзадача: ${params.description}`,
            });
            fork.sessionOrigin = 'subagent';
            fork.userId = parentSession.userId;
            fork.ownerId = parentSession.ownerId;
            fork.mode = parentSession.mode;
            fork.settings = { ...fork.settings, agentRole: params.subagent_type, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides };
            await extra.sessionManager.updateSession(fork);
            childSessionId = fork.id;
            childMessages = fork.messages;
          } else if (effectiveMode === 'last_n') {
            const startIdx = Math.max(0, parentSession.messages.length - contextCount);
            const fork = await extra.sessionManager.forkSession(extra.sessionId, {
              messageIndex: startIdx,
              title: `Подзадача: ${params.description}`,
            });
            fork.sessionOrigin = 'subagent';
            fork.userId = parentSession.userId;
            fork.ownerId = parentSession.ownerId;
            fork.mode = parentSession.mode;
            fork.settings = { ...fork.settings, agentRole: params.subagent_type, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides };
            await extra.sessionManager.updateSession(fork);
            childSessionId = fork.id;
            childMessages = fork.messages;
          } else if (effectiveMode === 'summary') {
            const fork = await extra.sessionManager.forkSession(extra.sessionId, {
              title: `Подзадача: ${params.description}`,
            });
            fork.sessionOrigin = 'subagent';
            fork.userId = parentSession.userId;
            fork.ownerId = parentSession.ownerId;
            fork.mode = parentSession.mode;
            fork.settings = { ...fork.settings, agentRole: params.subagent_type, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides };
            await extra.sessionManager.updateSession(fork);
            childSessionId = fork.id;
            childMessages = fork.messages;

            try {
              const summaryMsg = await extra.contextOptimizer!.summarize(fork);
              if (summaryMsg.content) {
                await extra.sessionManager.addMessage(childSessionId, {
                  ...summaryMsg,
                  id: generateId(),
                  origin: 'local',
                  hidden: false,
                });
              }
            } catch {
              // fallback: без саммари, только prompt с полной историей
            }

            // Всегда отключаем унаследованные сообщения — в summary-режиме
            // они заменены суммаризацией (или мы fallback-нули без неё)
            {
              const child = await extra.sessionManager.getSession(childSessionId);
              if (child) {
                let changed = false;
                for (const msg of child.messages) {
                  if (msg.role !== MessageRole.SUMMARY && !msg.disabled) {
                    msg.disabled = true;
                    changed = true;
                  }
                }
                if (changed) {
                  await extra.sessionManager.updateSession(child);
                }
                childMessages = child.messages;
              }
            }
          } else {
            // none mode (default)
            const child = await extra.sessionManager.createSession({
              title: `Подзадача: ${params.description}`,
              projectId: parentSession.projectId,
              engine: parentSession.engine,
              parentId: extra.sessionId,
              sessionOrigin: 'subagent',
              settings: { ...parentSession.settings, agentRole: params.subagent_type, permission: derivedPermission, planMode: 'auto', ...childRoutingOverrides },
            });
            child.userId = parentSession.userId;
            child.ownerId = parentSession.ownerId;
            child.mode = parentSession.mode;
            await extra.sessionManager.updateSession(child);
            childSessionId = child.id;
          }

          if (extra.eventBus && childSessionId) {
            const child = await extra.sessionManager.getSession(childSessionId);
            if (child) {
              extra.eventBus.publish(extra.sessionId, 'session.created', serializeSession(child));
            }
          }
        }
      } catch {
        // не фатально — продолжаем без дочерней сессии
      }
    }

    // ─── Сборка LLM-сообщений ────────────────────────────────────────
    const llmSystemPrompt = (() => {
      let prompt = systemPrompt;

      // Заметки родительской сессии — передаём во всех режимах с контекстом
      // (inherit, summary, last_n), но НЕ в none (чистый лист)
      if (contextMode !== 'none' && parentNotesText) {
        prompt += `\n\n[PARENT NOTES]\nНиже — важные заметки из основной сессии. Учитывай их при выполнении задачи.\n\n${parentNotesText}`;
      }

      if (contextMode === 'summary' && childMessages.length > 0) {
        const summaryMsg = childMessages.find(m => m.role === MessageRole.SUMMARY);
        if (summaryMsg?.content) {
          prompt += `\n\n[PARENT SUMMARY]\n${summaryMsg.content}`;
        }
      }

      // ─── Информация о маршрутизации (AD-034 Фаза 4) ──────────────
      // Загружается из контекстных файлов prompts/system/ROUTING.{lang}.md
      const parentSettings = extra.parentSessionSettings;
      const routingEnabled = extra.routerConfig?.enabled && (parentSettings?.routingEnabled !== false);
      const shouldShowRouting = routingEnabled || childRoutingOverrides.model || childRoutingOverrides.provider;
      if (shouldShowRouting && extra.routerConfig) {
        const lang = parentSettings?.language || 'ru';
        const template = extra.contextConfig?.getRoutingInstructions(lang) || '';

        // Строим список доступных моделей
        const contentCfg = extra.routerConfig.content;
        const effectiveContent = parentSettings?.routingContent;
        const routingLines: string[] = [];
        const addLine = (cat: string, cfg: { provider?: string; model?: string } | undefined, globalCfg: { provider: string; model: string }) => {
          if (cfg?.provider && cfg?.model) {
            routingLines.push(`- ${cat} (сессия): **${cfg.provider}/${cfg.model}**`);
          } else if (globalCfg.provider && globalCfg.model) {
            routingLines.push(`- ${cat} (глобально): **${globalCfg.provider}/${globalCfg.model}**`);
          }
        };
        addLine('coding', effectiveContent?.coding, contentCfg.coding);
        addLine('chat', effectiveContent?.chat, contentCfg.chat);
        addLine('research', effectiveContent?.research, contentCfg.research);
        const modelsText = routingLines.length > 0
          ? 'Доступные провайдеры и модели:\n' + routingLines.join('\n')
          : '';

        const routingBlock = template
          ? template.replace('{routing_models}', modelsText ? modelsText + '\n' : '')
          : ('\n\n[ROUTING]\n\n' +
             'Для запуска дочерних агентов ты можешь указать модель:\n' +
             '- Используй параметр `model` для выбора модели под задачу\n' +
             (modelsText ? modelsText + '\n' : '') +
             '- Если модель не указана, будет использована стратегия родительской сессии\n');

        prompt += routingBlock;
      }

      return prompt;
    })();

    // ─── Выбор провайдера для саб-агента через роутер (AD-034 Фаза 4) ──
    let effectiveProvider = extra.provider;
    let routingDecisionInfo: { providerName: string; modelName: string; strategy: string } | undefined;
    const parentSettings = extra.parentSessionSettings;
    if (extra.modelRouter && (parentSettings?.routingEnabled !== false) && extra.routerConfig) {
      try {
        const decision = extra.modelRouter.route({
          sessionSettings: parentSettings!,
          userMessage: params.prompt,
          systemPrompt: llmSystemPrompt,
        });
        const routedProvider = extra.modelRouter.getProvider(decision);
        if (routedProvider && (decision.providerName !== parentSettings?.provider || decision.modelName !== parentSettings?.model)) {
          effectiveProvider = routedProvider;
          routingDecisionInfo = {
            providerName: decision.providerName,
            modelName: decision.modelName,
            strategy: decision.strategy,
          };
        }
      } catch {
        // fallback на провайдер родителя
      }
    }

    const messages: LLMMessage[] = [
      {
        id: '',
        role: 'system' as const,
        content: llmSystemPrompt,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      },
    ];

    if ((contextMode === 'inherit' || contextMode === 'last_n') && childMessages.length > 0) {
      for (const msg of childMessages) {
        if (msg.hidden || msg.disabled) continue;
        messages.push(messageToLLMMessage(msg));
      }
    }

    const userPromptMsg: LLMMessage = {
      id: '',
      role: 'user' as const,
      content: params.prompt,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      disabled: false,
      pinned: false,
      branchId: '',
    };
    messages.push(userPromptMsg);

    // Сохранить промпт в дочернюю сессию
    if (childSessionId && extra.sessionManager) {
      try {
        const userMsg: Message = {
          id: generateId(),
          role: MessageRole.USER,
          seq: childMessages.length + 1,
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
        const updated = await extra.sessionManager.addMessage(childSessionId, userMsg);
        if (updated) {
          childMessages = updated.messages;
          if (extra.eventBus) {
            const idx = updated.messages.length - 1;
            await publishMessageAdded(extra.eventBus, extra.sessionId!, childSessionId, updated.messages[idx]!, idx, updated);
          }
        }
      } catch {
        // не фатально
      }
    }

    const cancelToken: CancellationToken = { cancelled: false, cancel: () => { cancelToken.cancelled = true; } };

    // ─── Permissions саб-агента (AD-029): проверка перед каждым tool_call ──
    // Дочерняя сессия наследует permissions родителя (deriveSubagentPermission).
    // ask-запросы публикуются в EventBus РОДИТЕЛЬСКОЙ сессии — подтверждение
    // видит пользователь основной сессии, approval_id связывает ответ.
    const childEvaluator = new PermissionEvaluator(derivedPermission);
    const childApprovalManager = new PermissionApprovalManager(extra.eventBus ?? new EventBus());
    let childSessionMode: SessionMode = 'act';
    let childPlanApproved = false;
    let childPlanMode: PlanMode = 'auto';
    let childMcpToolSettings: Record<string, import('@itphx/synth-shared').McpServerToolSettings> | undefined;
    if (childSessionId && extra.sessionManager) {
      try {
        const child = await extra.sessionManager.getSession(childSessionId);
        if (child) {
          childSessionMode = child.mode ?? 'act';
          childPlanApproved = Boolean(child.planApproved);
          childPlanMode = child.settings.planMode ?? 'auto';
          childMcpToolSettings = child.settings.mcpToolSettings;
        }
      } catch {
        // не фатально — остаёмся в act/auto
      }
    }

    // B5: режимная фильтрация списка тулов саб-агента (аналог
    // orchestrator._filterToolsByMode). В plan-режиме (или strict без
    // утверждённого плана) скрываем write/edit-тулы и git-запись — модель не
    // видит инструменты, которые всё равно будут отклонены evaluator'ом.
    if (isPlanRestricted(childSessionMode, childPlanMode, childPlanApproved) && tools) {
      const filtered: ToolForLLM[] = [];
      for (const tool of tools) {
        const toolName = tool.function.name;
        const toolDef = extra.toolRegistry?.get(toolName);
        const capabilities = toolDef?.capabilities;
        if (isPlanBlockedTool(toolName, capabilities)) continue;
        // MCP-инструменты: в plan-режиме недоступный по настройкам тул убираем.
        if (capabilities?.includes(ToolCapability.MCP) && childMcpToolSettings) {
          const availability = getMcpToolAvailability(childMcpToolSettings, toolName);
          if (availability && !availability.plan) continue;
        }
        filtered.push(tool);
      }
      tools = filtered;
    }

    try {
      let finalContent = '';
      let iteration = 0;
      const doomTracker = new Map<string, number>();
      let subagentReasoning = '';
      let subagentDenied = false;

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
          for await (const chunk of effectiveProvider.chatAsync(
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

          // Сохранить финальный ответ ассистента в дочернюю сессию
          if (childSessionId && extra.sessionManager) {
            try {
              const assistantMsg: Message = {
                id: generateId(),
                role: MessageRole.ASSISTANT,
                seq: 0,
                origin: 'local',
                parts: [makeTextPart(accumulatedContent)],
                content: accumulatedContent,
                createdAt: nowISO(),
                disabled: false,
                pinned: false,
                hidden: false,
                agentRole: params.subagent_type,
                reasoning: reasoning || undefined,
              };
              const updated = await extra.sessionManager.addMessage(childSessionId, assistantMsg);
              if (updated && extra.eventBus) {
                const idx = updated.messages.length - 1;
                await publishMessageAdded(extra.eventBus, extra.sessionId!, childSessionId, updated.messages[idx]!, idx, updated);
              }
            } catch {
              // не фатально
            }
          }
          break;
        }

        if (accumulatedContent) {
          allSubagentIntermediateTexts.push({ text: accumulatedContent, iteration });
        }

        iteration++;

        // Сохранить ответ ассистента с tool calls в дочернюю сессию
        if (childSessionId && extra.sessionManager) {
          try {
            const assistantMsg: Message = {
              id: generateId(),
              role: MessageRole.ASSISTANT,
              seq: 0,
              origin: 'local',
              parts: [makeTextPart(accumulatedContent || '')],
              content: accumulatedContent || '',
              createdAt: nowISO(),
              disabled: false,
              pinned: false,
              hidden: false,
              agentRole: params.subagent_type,
              reasoning: reasoning || undefined,
            };
            const updated = await extra.sessionManager.addMessage(childSessionId, assistantMsg);
            if (updated && extra.eventBus) {
              const idx = updated.messages.length - 1;
              await publishMessageAdded(extra.eventBus, extra.sessionId!, childSessionId, updated.messages[idx]!, idx, updated);
            }
          } catch {
            // не фатально
          }
        }

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
            const doomMsg: LLMMessage = {
              id: '', role: 'tool',
              content: `Ошибка: инструмент "${toolName}" вызван ${doomCount} раз(а) с одинаковыми аргументами. Цикл прерван.`,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              disabled: false, pinned: false, branchId: '',
              toolCallId: tcId,
            };
            messages.push(doomMsg);

            if (childSessionId && extra.sessionManager) {
              try {
                const toolResultMsg: Message = {
                  id: generateId(),
                  role: MessageRole.TOOL,
                  seq: 0,
                  origin: 'local',
                  parts: [makeTextPart(doomMsg.content)],
                  content: doomMsg.content,
                  createdAt: nowISO(),
                  disabled: false,
                  pinned: false,
                  hidden: false,
                  toolCallId: tcId,
                };
                const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
                if (updated && extra.eventBus) {
                  const idx = updated.messages.length - 1;
                  await publishMessageAdded(extra.eventBus, extra.sessionId!, childSessionId, updated.messages[idx]!, idx, updated);
                }
              } catch {
                // не фатально
              }
            }
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
          let subagentUserDenied = false;

          // AD-029: permission-check саб-агента — permissions дочерней сессии
          // (родитель + deny-дополнения) применяются к каждому tool_call.
          const permissionDecision = childEvaluator.check({
            toolName,
            params: toolArgs,
            workingDir: ctx.workingDir,
            capabilities: toolDef?.capabilities,
            sessionMode: childSessionMode,
            planMode: childPlanMode,
            planApproved: childPlanApproved,
            mcpToolSettings: childMcpToolSettings,
            shellPolicy: extra.shellPolicy ?? undefined,
            protectedPaths: extra.protectedPaths ?? undefined,
            protectedPathsEnabled: extra.protectedPathsEnabled,
          });

          if (permissionDecision.action === 'deny') {
            toolResult = {
              content: `Permission denied: ${permissionDecision.reason}`,
              isError: true,
              metadata: {
                permission: {
                  action: 'deny',
                  reason: permissionDecision.reason,
                  matched_rule: permissionDecision.matchedRule,
                },
              },
            };
          } else if (permissionDecision.action === 'ask') {
            // ask публикуется в родительскую сессию (extra.sessionId) —
            // пользователь основной сессии видит запрос и отвечает.
            const approval = await childApprovalManager.waitForDecision(
              extra.sessionId!,
              {
                approvalId: `approval_${tcId}`,
                callId: tcId,
                toolName,
                arguments: toolArgs,
                reason: permissionDecision.reason,
              },
              derivedPermission.askTimeoutMs,
            );
            if (approval.approved) {
              if (approval.once === false) {
                // «Разрешить в сессии» — allow-правило в permissions дочерней сессии
                derivedPermission.rules[toolName] = 'allow';
                if (childSessionId && extra.sessionManager) {
                  try {
                    const child = await extra.sessionManager.getSession(childSessionId);
                    if (child) {
                      child.settings.permission = { ...derivedPermission };
                      await extra.sessionManager.updateSession(child);
                    }
                  } catch {
                    // не фатально
                  }
                }
              }
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
            } else {
              const why = approval.timeout
                ? 'истекло время ожидания подтверждения'
                : approval.noSubscribers
                  ? 'нет подключённого пользователя для подтверждения'
                  : 'отклонено пользователем';
              toolResult = {
                content: `Permission denied: ${permissionDecision.reason} (${why})`,
                isError: true,
                metadata: {
                  permission: {
                    action: 'deny',
                    reason: permissionDecision.reason,
                    matched_rule: permissionDecision.matchedRule,
                  },
                },
              };
              subagentUserDenied = !approval.timeout && !approval.noSubscribers;
            }
          } else {
            // allow — обычное выполнение
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

          const toolResultLLMMsg: LLMMessage = {
            id: '', role: 'tool',
            content: toolResult.content,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            disabled: false, pinned: false, branchId: '',
            toolCallId: tcId,
          };
          messages.push(toolResultLLMMsg);

          // Сохранить tool_result в дочернюю сессию
          if (childSessionId && extra.sessionManager) {
            try {
              const toolResultMsg: Message = {
                id: generateId(),
                role: MessageRole.TOOL,
                seq: 0,
                origin: 'local',
                parts: [makeTextPart(toolResult.content)],
                content: toolResult.content,
                createdAt: nowISO(),
                disabled: false,
                pinned: false,
                hidden: false,
                toolCallId: tcId,
              };
              const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
              if (updated && extra.eventBus) {
                const idx = updated.messages.length - 1;
                await publishMessageAdded(extra.eventBus, extra.sessionId!, childSessionId, updated.messages[idx]!, idx, updated);
              }
            } catch {
              // не фатально
            }
          }

          // AD-029: пользователь отклонил ask саб-агента — прекращаем выполнение.
          if (subagentUserDenied) {
            subagentDenied = true;
            break;
          }
        }

        publish?.('tool_call.loop', {
          stream_id: extra.streamId,
          session_id: extra.sessionId,
          iteration,
          total_tool_calls: toolCalls.length,
        });

        if (subagentDenied) break;
      }

      if (subagentDenied && !finalContent) {
        finalContent = 'Обработка остановлена: пользователь отклонил запрос на выполнение инструмента';
      }

      const output = finalContent || '(пустой ответ сабагента)';

      // ─── Quality check результата саб-агента (AD-034 Фаза 4) ─────
      let qaPass: boolean | undefined;
      let qaReason: string | undefined;
      let qualityOutput = output;
      const escalationCfg = extra.routerConfig?.escalation;
      const sessionEscalation = extra.parentSessionSettings?.routingEscalation;
      const escalationEnabled = sessionEscalation?.enabled ?? escalationCfg?.enabled ?? false;

      if (extra.modelRouter && escalationEnabled && finalContent && routingDecisionInfo) {
        try {
          const qaResult = await extra.modelRouter.checkQuality(finalContent, {
            providerName: routingDecisionInfo.providerName,
            modelName: routingDecisionInfo.modelName,
            reason: routingDecisionInfo.strategy,
            strategy: routingDecisionInfo.strategy,
          }, extra.parentSessionSettings);
          qaPass = qaResult.pass;
          qaReason = qaResult.reason;

          // Пометить QA-информацию в дочерней сессии
          if (childSessionId && extra.sessionManager) {
            try {
              const childSession = await extra.sessionManager.getSession(childSessionId);
              if (childSession) {
                const lastAssistantMsg = [...childSession.messages].reverse()
                  .find(m => m.role === MessageRole.ASSISTANT);
                if (lastAssistantMsg) {
                  lastAssistantMsg.qa_pass = qaResult.pass;
                  lastAssistantMsg.qa_reason = qaResult.reason;
                  await extra.sessionManager.updateSession(childSession);
                }
              }
            } catch {
              // не фатально
            }
          }

          // Эскалация на fallback-модель при FAIL
          if (!qaResult.pass) {
            const fallbackProvider = sessionEscalation?.fallbackProvider || escalationCfg?.fallbackProvider;
            const fallbackModel = sessionEscalation?.fallbackModel || escalationCfg?.fallbackModel;
            if (fallbackProvider && fallbackModel && extra.modelRouter) {
              const fbDecision = {
                providerName: fallbackProvider,
                modelName: fallbackModel,
                reason: 'escalation_fallback',
                strategy: 'default',
              };
              const fbEffectiveProvider = extra.modelRouter.getProvider(fbDecision);
              if (fbEffectiveProvider) {
                try {
                  // Перевызываем с fallback-моделью (только последний user-запрос)
                  const fbMessages: LLMMessage[] = [messages[0]!];
                  // Добавляем только user-сообщение без tool-результатов
                  const userMsg = messages.find(m => m.role === 'user');
                  if (userMsg) fbMessages.push(userMsg);
                  const fbResponse = await fbEffectiveProvider.chat(
                    fbMessages,
                    systemPrompt || undefined,
                    undefined,
                    false,
                  );
                  if (fbResponse.content) {
                    finalContent = fbResponse.content;
                    qualityOutput = fbResponse.content;
                    qaPass = true;
                    qaReason = `Эскалация на ${fallbackProvider}/${fallbackModel}: ${qaResult.reason}`;
                    routingDecisionInfo = {
                      providerName: fallbackProvider,
                      modelName: fallbackModel,
                      strategy: 'escalation_fallback',
                    };
                  }
                } catch {
                  // fallback не удался, оставляем оригинальный ответ
                }
              }
            }
          }
        } catch {
          // QA не удался, не блокируем
        }
      }

      // Финализировать дочернюю сессию
      if (childSessionId && extra.sessionManager) {
        try {
          const childSession = await extra.sessionManager.getSession(childSessionId);
          if (childSession) {
            childSession.updatedAt = nowISO();
            await extra.sessionManager.updateSession(childSession);

            if (extra.eventBus) {
              extra.eventBus.publish(childSessionId, 'session.updated', {
                session_id: childSessionId,
              });
              extra.eventBus.publish(extra.sessionId!, 'child.session.updated', {
                session: serializeSession(childSession),
              });
            }
          }
        } catch {
          // не фатально
        }
      }

      // ─── Формирование результата tool_result ──────────────────────
      const qualityBlock = qaPass !== undefined
        ? `<quality pass="${qaPass}" reason="${qaReason || ''}"/>\n`
        : '';
      const routedByBlock = routingDecisionInfo && routingDecisionInfo.strategy !== 'default'
        ? `<routed_by strategy="${routingDecisionInfo.strategy}" provider="${routingDecisionInfo.providerName}" model="${routingDecisionInfo.modelName}"/>\n`
        : '';
      const qaWarningText = qaPass === false
        ? `\n\n⚠️ Ответ не прошёл контроль качества: ${qaReason || 'неизвестная причина'}`
        : '';

      return {
        content: `<task_result>\n<summary>${params.description}</summary>\n${qualityBlock}${routedByBlock}\n${qualityOutput}${qaWarningText}\n</task_result>`,
        metadata: {
          subagent_type: params.subagent_type,
          description: params.description,
          context_mode: contextMode,
          steps: iteration,
          child_session_id: childSessionId,
          reasoning: subagentReasoning || undefined,
          reasoning_blocks: allSubagentReasoning.length > 0 ? allSubagentReasoning : undefined,
          intermediate_text_blocks: allSubagentIntermediateTexts.length > 0 ? allSubagentIntermediateTexts : undefined,
          tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
          final_content: finalContent || undefined,
          qa_pass: qaPass,
          qa_reason: qaReason || undefined,
          routing_strategy: routingDecisionInfo?.strategy,
          routing_provider: routingDecisionInfo?.providerName,
          routing_model: routingDecisionInfo?.modelName,
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
