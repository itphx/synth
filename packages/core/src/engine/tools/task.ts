import { z } from 'zod';
import { ToolCapability, MessageRole, nowISO, generateId, makeTextPart } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult, Message, Session, SessionSettings, RouterConfig, PermissionConfig, PlanMode, SessionMode, SecurityConfig, ToolForLLM, ToolContext } from '@itphx/synth-shared';
import type { AgentRegistry } from '../agents/registry.js';
import { normalizeAgentModes } from '../agents/normalize.js';
import type { BaseProvider, LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ToolRegistry } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import { EventBus } from '../../events/bus.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { ContextConfig } from '../context/config.js';
import type { ModelRouter } from '../router/router.js';
import { classifyLlmError, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS } from '../llm-error.js';
import { deriveSubagentPermission } from '../permission/derive.js';
import { PermissionEvaluator } from '../permission/evaluator.js';
import { PermissionApprovalManager } from '../permission/approval.js';
import { serializeSession, serializeMessage } from '../../server/serialize.js';
import type { ShellPolicy } from '../security/shell-guard.js';
import type { ProtectedPathsPolicy } from '../security/protected-paths.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

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
  /** ID собственного tool-вызова `task` — как parent_call_id для внутренних вызовов саб-агента. */
  callId?: string;
  callerAgentRole?: string;
  /** Permissions родительской сессии (AD-029) — наследуются саб-агентом с deny-дополнениями. */
  permissionConfig?: PermissionConfig;
  /** Секция безопасности (защита от Indirect Prompt Injection) из config.yaml. */
  securityConfig?: SecurityConfig;
  /** Язык сессии (для локализованных сообщений безопасности). */
  language?: string;
  /** Политика безопасности execute_shell (денлист путей/команд) родительской сессии. */
  shellPolicy?: ShellPolicy;
  /** Единая политика защищённых путей (СКВОЗНАЯ проверка файловых тулов) родительской сессии. */
  protectedPaths?: ProtectedPathsPolicy;
  /** Тумблер полного отключения защищённых путей (default true). */
  protectedPathsEnabled?: boolean;
  /** Override retry-параметров саб-агента (по умолчанию 3 попытки, backoff 5/15/30с). */
  retry?: SubagentRetryConfig;
}

type ContextMode = 'none' | 'inherit' | 'summary' | 'last_n';

const DEFAULT_SUBAGENT_MAX_STEPS = 15;
const DEFAULT_LAST_N = 4;

/** Retry саб-агента: максимум попыток LLM-вызова (единая политика — LLM_MAX_ATTEMPTS). */
export const SUBAGENT_MAX_ATTEMPTS = LLM_MAX_ATTEMPTS;
/** Backoff между попытками (единая политика — LLM_RETRY_DELAYS_MS). */
export const SUBAGENT_RETRY_DELAYS_MS = LLM_RETRY_DELAYS_MS;

/** Параметры retry-цикла LLM-вызова саб-агента. */
export interface SubagentRetryConfig {
  /** Максимум попыток (включая первую). */
  maxRetries: number;
  /** Задержки между попытками, мс (index = попытка - 1). */
  delaysMs: number[];
}

/**
 * Промпт саб-агента по языку сессии: prompts/subagents/{type}.{lang}.md →
 * {type}.md → agentDef.subagentPrompt (definitions JSON, легаси).
 * Каталог промптов — systemPromptsDir из ContextConfig (резолв prompts/ или dist/prompts).
 */
export function resolveSubagentPrompt(
  agentDef: { subagentPrompt?: string },
  subagentType: string,
  language: string | undefined,
  systemPromptsDir: string | undefined,
): string {
  if (systemPromptsDir) {
    const lang = language === 'en' ? 'en' : 'ru';
    const localizedPath = join(systemPromptsDir, 'subagents', `${subagentType}.${lang}.md`);
    if (existsSync(localizedPath)) {
      try { return readFileSync(localizedPath, 'utf-8'); } catch { /* fallback ниже */ }
    }
    const basePath = join(systemPromptsDir, 'subagents', `${subagentType}.md`);
    if (existsSync(basePath)) {
      try { return readFileSync(basePath, 'utf-8'); } catch { /* fallback ниже */ }
    }
  }
  return agentDef.subagentPrompt || '';
}

export function messageToLLMMessage(msg: Message): LLMMessage {
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
    toolUse: msg.toolCalls,
  };
}

export async function publishMessageAdded(
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
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
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
        content: sm('task.deps_unavailable'),
        isError: true,
      };
    }

    const agentDef = extra.agentRegistry.get(params.subagent_type);
    if (!agentDef) {
      return {
        content: sm('task.subagent_not_found', { type: params.subagent_type, types: extra.agentRegistry.getSubagents().map((a) => a.id).join(', ') }),
        isError: true,
      };
    }

    if (!normalizeAgentModes(agentDef.agentMode).includes('subagent')) {
      return {
        content: sm('task.subagent_not_allowed', { type: params.subagent_type, modes: String(agentDef.agentMode) }),
        isError: true,
      };
    }

    const contextMode: ContextMode = params.context_mode || 'none';
    const contextCount = params.context_count || DEFAULT_LAST_N;
    const systemPrompt = resolveSubagentPrompt(
      agentDef,
      params.subagent_type,
      extra.parentSessionSettings?.language,
      extra.contextConfig?.systemPromptsDir,
    );
    const tools: ToolForLLM[] | undefined = extra.agentRegistry.getToolsForAgent(agentDef.id);
    const maxSteps = agentDef.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS;

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
              title: sm('session.subtask_title', { description: params.description }),
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
              title: sm('session.subtask_title', { description: params.description }),
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
              title: sm('session.subtask_title', { description: params.description }),
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
              title: sm('session.subtask_title', { description: params.description }),
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

    // AD-070 §2.1/§1.5: system prompt передаётся ТОЛЬКО вторым аргументом
    // chatAsync (как в оркестраторе), в messages system-сообщения нет —
    // иначе у OpenAI/Remote получаются два system-сообщения подряд.
    const messages: LLMMessage[] = [];

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

    // ─── Запуск цикла саб-агента: общий код для task и resume (ниже) ──
    return runSubagent({
      subagentType: params.subagent_type,
      description: params.description,
      contextMode,
      maxSteps,
      llmSystemPrompt,
      initialMessages: messages,
      provider: effectiveProvider,
      tools,
      childSessionId,
      parentSessionId: extra.sessionId!,
      routingDecisionInfo,
      extra,
      ctx,
      retry: extra.retry,
    });
  },
};

/**
 * runSubagent — цикл выполнения саб-агента, общий для тула `task` и для
 * возобновления прерванной дочерней сессии (task-resume.ts).
 *
 * Включает: связку cancel-токена с родительским сигналом отмены, permissions
 * дочерней сессии (AD-029), режимную фильтрацию тулов, tool-loop со стримом
 * прогресса родителю, retry-цикл LLM-вызова (recoverable → backoff, аналог
 * QueueProcessor), обработку отмены (finishAborted), quality check/эскалацию
 * (AD-034) и формирование tool_result.
 */
export interface SubagentRunConfig {
  /** Тип саб-агента (id в реестре агентов). */
  subagentType: string;
  description: string;
  contextMode: ContextMode;
  /** Лимит шагов агента (0/undefined — без ограничений). */
  maxSteps?: number;
  /**
   * Системный промпт саб-агента (role + parent notes/summary + routing).
   * AD-070 §1.5: единственный путь — второй аргумент `chatAsync`; в `messages`
   * system-сообщения нет.
   */
  llmSystemPrompt: string;
  /** Начальные LLM-сообщения БЕЗ system: история дочерней сессии + user-промпт. */
  initialMessages: LLMMessage[];
  /** Провайдер саб-агента (уже резолвнутый роутером/оркестратором). */
  provider: BaseProvider;
  tools?: ToolForLLM[];
  /** Дочерняя сессия (если есть) — в неё пишется история саб-агента. */
  childSessionId?: string;
  /** Сессия для child.*-событий (у task — родитель, у resume — родитель resumed-сессии). */
  parentSessionId: string;
  /** Начальное routing-решение (AD-034) — для QA/эскалации. */
  routingDecisionInfo?: { providerName: string; modelName: string; strategy: string };
  extra: TaskExtra;
  ctx: ToolContext;
  /** Override retry-параметров (иначе extra.retry или дефолт 3 попытки / 5-15-30с). */
  retry?: SubagentRetryConfig;
}

/** Пауза backoff порциями с проверкой отмены. Возвращает true, если отмена. */
async function sleepAbortable(ms: number, isAborted: () => boolean): Promise<boolean> {
  const SLICE_MS = 200;
  let waited = 0;
  while (waited < ms) {
    if (isAborted()) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(SLICE_MS, ms - waited)));
    waited += SLICE_MS;
  }
  return isAborted();
}

export async function runSubagent(config: SubagentRunConfig): Promise<ToolResult> {
  const {
    subagentType, description, contextMode, maxSteps,
    llmSystemPrompt, initialMessages,
    provider: effectiveProvider,
    tools: toolsInput,
    childSessionId, parentSessionId,
    extra, ctx,
  } = config;
  const tools = toolsInput;
  let routingDecisionInfo = config.routingDecisionInfo;
  const publish = extra.publish;

  const effectiveMaxSteps = (!maxSteps || maxSteps === 0)
    ? Number.POSITIVE_INFINITY
    : maxSteps;

  // ─── Retry-параметры (аналог QueueProcessor: 3 попытки, backoff 5/15/30с) ──
  const retryCfg = config.retry ?? extra.retry
    ?? { maxRetries: LLM_MAX_ATTEMPTS, delaysMs: LLM_RETRY_DELAYS_MS };
  const retryMaxAttempts = Math.max(1, retryCfg.maxRetries);
  const retryDelaysMs = retryCfg.delaysMs.length > 0 ? retryCfg.delaysMs : LLM_RETRY_DELAYS_MS;

  // ─── Permissions дочерней сессии (AD-029): родитель + deny-дополнения ──
  const derivedPermission = deriveSubagentPermission(extra.permissionConfig);

  // ─── LLM-сообщения: только начальные (история/промпт); system — аргумент chatAsync ──
  const messages: LLMMessage[] = [...initialMessages];

  const cancelToken: CancellationToken = { cancelled: false, cancel: () => { cancelToken.cancelled = true; } };

  // Связка локального cancel-токена саб-агента с родительским сигналом отмены:
  // «Стоп» в родительской сессии (POST /sessions/:id/abort → orchestrator.cancel
  // → внутренний toolAbortController.abort → ctx.abortSignal) должен немедленно
  // прерывать LLM-стрим саб-агента и его цикл, а не ждать завершения всех шагов.
  const isAborted = () => cancelToken.cancelled || ctx.abortSignal?.aborted === true;
  if (ctx.abortSignal?.aborted) {
    cancelToken.cancel();
  } else {
    ctx.abortSignal?.addEventListener('abort', () => cancelToken.cancel(), { once: true });
  }

  // ─── Permissions саб-агента (AD-029): проверка перед каждым tool_call ──
  // Дочерняя сессия наследует permissions родителя (deriveSubagentPermission).
  // ask-запросы публикуются в EventBus РОДИТЕЛЬСКОЙ сессии — подтверждение
  // видит пользователь основной сессии, approval_id связывает ответ.
  const childEvaluator = new PermissionEvaluator(derivedPermission);
  const childApprovalManager = new PermissionApprovalManager(extra.eventBus ?? new EventBus());
  // AD-070 §2.9.1: ролевые ограничения саб-агента — через unavailable(role),
  // а не скрытием тулов; capabilities нужны permission-слою.
  const subagentDef = extra.agentRegistry?.get(subagentType);
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

  // AD-070 §2.9: список тулов саб-агента постоянен (без режимной фильтрации).
  // Ограничения plan/act/yolo и роли обеспечивает permission-слой ниже —
  // `unavailable(mode|role)` с подсказкой, definition остаётся в запросе.

  // Финализация дочерней сессии: обновление updatedAt + события для UI.
  // Отдельного статусного поля «завершена/прервана» у сессии нет
  // (SessionStatus — только процессная блокировка blocked/blockedAt),
  // поэтому факт прерывания/ошибки фиксируется metadata-маркерами
  // в сообщениях истории дочерней сессии.
  const finalizeChildSession = async (): Promise<void> => {
    if (!childSessionId || !extra.sessionManager) return;
    try {
      const childSession = await extra.sessionManager.getSession(childSessionId);
      if (childSession) {
        childSession.updatedAt = nowISO();
        await extra.sessionManager.updateSession(childSession);

        if (extra.eventBus) {
          extra.eventBus.publish(childSessionId, 'session.updated', {
            session_id: childSessionId,
          });
          extra.eventBus.publish(parentSessionId, 'child.session.updated', {
            session: serializeSession(childSession),
          });
        }
      }
    } catch {
      // не фатально
    }
  };

  /** Добавить сообщение в дочернюю сессию + опубликовать события. */
  const addChildMessage = async (msg: Message): Promise<void> => {
    if (!childSessionId || !extra.sessionManager) return;
    try {
      const updated = await extra.sessionManager.addMessage(childSessionId, msg);
      if (updated && extra.eventBus) {
        const idx = updated.messages.length - 1;
        await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
      }
    } catch {
      // не фатально
    }
  };

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

    // Завершение по отмене (Стоп в родительской сессии): сохранить частичный
    // текст (если есть), поставить маркер прерывания в историю дочерней
    // сессии, финализировать её (без статуса completed) и вернуть родителю
    // tool_result с маркером остановки, частичным ответом и списком шагов.
    const finishAborted = async (
      partialContent: string,
      partialReasoning: string,
    ): Promise<ToolResult> => {
      // 1. Частичный стрим оборванной итерации — в историю дочерней сессии
      if (partialContent) {
        await addChildMessage({
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(partialContent)],
          content: partialContent,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          agentRole: subagentType,
          ...(partialReasoning ? { reasoning: partialReasoning } : {}),
          metadata: {
            stream_id: extra.streamId,
            partial: true,
            interrupted: true,
          },
        });
      }

      // 2. Маркер прерывания в историю дочерней сессии
      const stopMarkerText = sm('task.stopped_by_user');
      await addChildMessage({
        id: generateId(),
        role: MessageRole.INFO,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(stopMarkerText)],
        content: stopMarkerText,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        agentRole: subagentType,
        metadata: {
          stream_id: extra.streamId,
          stopped_by: 'user',
          interrupted: true,
          i18n: i18nMeta('task.stopped_by_user'),
        },
      });

      // 3. Финализация дочерней сессии
      await finalizeChildSession();

      // 4. tool_result родителю: маркер отмены + частичный текст + шаги + id сессии
      const stepsCompleted = allSubagentToolCalls.length > 0
        ? allSubagentToolCalls.map((t) => t.name).join(', ')
        : 'none';
      return {
        content: [
          '<task_result>',
          `<summary>${description}</summary>`,
          '<status>stopped_by_user</status>',
          ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
          ...(partialContent ? [`<partial_output>\n${partialContent}\n</partial_output>`] : []),
          `<steps_completed>${stepsCompleted}</steps_completed>`,
          sm('task.stopped_before_completion'),
          '</task_result>',
        ].join('\n'),
        metadata: {
          subagent_type: subagentType,
          description: description,
          context_mode: contextMode,
          steps: iteration,
          child_session_id: childSessionId,
          stopped_by: 'user',
          interrupted: true,
          tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
          partial_output: partialContent || undefined,
        },
      };
    };

    while (iteration < effectiveMaxSteps) {
      if (isAborted()) break;

      let accumulatedContent = '';
      let toolCalls: Record<string, unknown>[] | undefined = [];
      let reasoning = '';
      let lastPublishedReasoning = '';
      let lastPublishedContentLen = 0;

      // ─── LLM-вызов с retry (B1, аналог QueueProcessor) ──────────────
      // Recoverable-ошибки (network/timeout/rate_limit/server_error) ретраятся
      // до retryMaxAttempts попыток с backoff; unrecoverable (auth/
      // model_not_found/context_length) — сразу финальная ошибка. Backoff-пауза
      // спит порциями с проверкой отмены: «Стоп» прерывает ожидание мгновенно.
      // Событие subagent.retry и паузы НЕ пишут ничего в историю дочерней
      // сессии — мусорные сообщения не создаются (только финальный ERROR).
      let llmFailure: { error: unknown; errorType: string; attempts: number } | null = null;
      for (let attempt = 1; attempt <= retryMaxAttempts; attempt++) {
        if (isAborted()) break;
        try {
          for await (const chunk of effectiveProvider.chatAsync(
            messages,
            llmSystemPrompt || undefined,
            tools as Record<string, unknown>[] | undefined,
            undefined,
            cancelToken,
          )) {
            if (isAborted()) break;
            if (chunk.isFinal) {
              accumulatedContent = chunk.content;
              reasoning = (chunk as unknown as Record<string, unknown>).reasoning as string || reasoning;
            } else {
              accumulatedContent += chunk.content;
              const chunkReasoning = (chunk as unknown as Record<string, unknown>).reasoning as string | undefined;
              if (chunkReasoning) reasoning = chunkReasoning;
            }
            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCalls = chunk.toolCalls;
            }

            // Стримим размышления/промежуточный текст саб-агента РОДИТЕЛЮ,
            // чтобы в блоке `task` (по parent_call_id) они были видны во время работы.
            if (publish) {
              const liveReasoning = reasoning || '';
              const liveContent = accumulatedContent || '';
              if (liveReasoning !== lastPublishedReasoning || liveContent.length !== lastPublishedContentLen) {
                publish('subagent.progress', {
                  stream_id: extra.streamId,
                  session_id: extra.sessionId,
                  parent_call_id: extra.callId,
                  reasoning: liveReasoning,
                  content: liveContent,
                  iteration,
                });
                lastPublishedReasoning = liveReasoning;
                lastPublishedContentLen = liveContent.length;
              }
            }
          }
          llmFailure = null;
          break;
        } catch (err) {
          // Прерывание пользователем во время стрима (провайдер бросил
          // AbortError) — не ошибка, обработается через finishAborted ниже.
          if (isAborted()) break;
          const rawError = err instanceof Error ? err.message : String(err);
          const errorType = classifyLlmError(rawError);
          if (!isLlmErrorRecoverable(err, rawError) || attempt >= retryMaxAttempts) {
            // Unrecoverable или попытки исчерпаны — финальная ошибка
            llmFailure = { error: err, errorType, attempts: attempt };
            break;
          }
          const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
          publish?.('subagent.retry', {
            stream_id: extra.streamId,
            session_id: extra.sessionId,
            child_session_id: childSessionId,
            parent_call_id: extra.callId,
            attempt,
            max_retries: retryMaxAttempts,
            retry_in: delay,
            error_type: errorType,
            error: rawError,
          });
          if (await sleepAbortable(delay, isAborted)) break;
          // Сброс частичного контекста неудавшейся попытки
          accumulatedContent = '';
          reasoning = '';
          toolCalls = [];
          lastPublishedReasoning = '';
          lastPublishedContentLen = 0;
        }
      }

      if (llmFailure) {
        // Ошибка провайдера внутри саб-агента (после retry-цикла): фиксируем
        // в истории дочерней сессии, финализируем её и возвращаем родителю
        // tool_result с описанием ошибки, счётчиком попыток и child_session_id.
        const attempts = llmFailure.attempts;
        const errParams = { type: subagentType, error: String(llmFailure.error) };
        const errKey = attempts > 1
          ? 'task.subagent_exec_error_after_retries' as const
          : 'task.subagent_exec_error' as const;
        const errText = attempts > 1
          ? sm(errKey, { ...errParams, attempts: String(attempts) })
          : sm(errKey, errParams);
        await addChildMessage({
          id: generateId(),
          role: MessageRole.ERROR,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(errText)],
          content: errText,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          agentRole: subagentType,
          metadata: {
            stream_id: extra.streamId,
            error: true,
            attempts,
            max_retries: retryMaxAttempts,
            error_type: llmFailure.errorType,
            i18n: i18nMeta(errKey, attempts > 1 ? { ...errParams, attempts: String(attempts) } : errParams),
          },
        });
        await finalizeChildSession();
        return {
          content: [
            '<task_result>',
            `<summary>${description}</summary>`,
            '<status>error</status>',
            ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
            `<attempts>${attempts}</attempts>`,
            errText,
            '</task_result>',
          ].join('\n'),
          isError: true,
          metadata: {
            subagent_type: subagentType,
            description: description,
            context_mode: contextMode,
            steps: iteration,
            child_session_id: childSessionId,
            error: true,
            attempts,
            max_retries: retryMaxAttempts,
            error_type: llmFailure.errorType,
            tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
          },
        };
      }

      // Отмена (Стоп в родительской сессии): сохраняем частичный текст
      // ТЕКУЩЕЙ итерации, ставим маркер прерывания в историю дочерней
      // сессии, финализируем её (без статуса completed) и возвращаем
      // родителю tool_result с маркером остановки, частичным ответом и
      // списком выполненных шагов.
      if (isAborted()) {
        return await finishAborted(accumulatedContent, reasoning);
      }

      // Единая итерация для размышлений, промежуточного текста и вызовов
      // инструментов этого шага — иначе в UI (и в дочерней сессии) ломается
      // порядок: размышления идут на step N, а вызовы — на N+1.
      const stepIteration = iteration;
      if (reasoning) {
        allSubagentReasoning.push({ text: reasoning, iteration: stepIteration });
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
              agentRole: subagentType,
              // Все размышления сабагента (по итерациям), склеенные в поле
              // reasoning — UI дочерней сессии показывает их блоками
              // (ReasoningBlock разбивает по «\n\n---\n\n»). Без этого размышления
              // остаются только в скрытых tool_chain-сообщениях и теряются.
              reasoning: allSubagentReasoning.length > 0
                ? allSubagentReasoning.map((r) => r.text).join('\n\n---\n\n')
                : undefined,
              // Как в _persistToolChain родителя: финальное сообщение несёт
              // свёрнутую цепочку тулов, чтобы UI дочерней сессии отрисовал её
              // так же аккуратно, как финал родительской.
              metadata: {
                stream_id: extra.streamId,
                ...(allSubagentToolCalls.length > 0 ? { tool_results: allSubagentToolCalls } : {}),
                ...(allSubagentIntermediateTexts.length > 0 ? { intermediate_text_blocks: allSubagentIntermediateTexts } : {}),
              },
            };
            const updated = await extra.sessionManager.addMessage(childSessionId, assistantMsg);
            if (updated && extra.eventBus) {
              const idx = updated.messages.length - 1;
              await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
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
            agentRole: subagentType,
            reasoning: reasoning || undefined,
            // OpenAI-совместимая цепочка: assistant(toolCalls) → tool.
            // tool_chain=true — UI дочерней сессии скрывает промежуточные
            // сообщения (визуализация уже в финальном с tool_results).
            toolCalls,
            metadata: { stream_id: extra.streamId, tool_chain: true },
          };
          const updated = await extra.sessionManager.addMessage(childSessionId, assistantMsg);
          if (updated && extra.eventBus) {
            const idx = updated.messages.length - 1;
            await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
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
            content: sm('tool.doom_loop', { tool: toolName, count: String(doomCount) }),
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
                metadata: {
                  stream_id: extra.streamId,
                  tool_chain: true,
                  tool_name: toolName,
                  args: toolArgs,
                },
              };
              const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
              if (updated && extra.eventBus) {
                const idx = updated.messages.length - 1;
                await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
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
          iteration: stepIteration,
          // Вложенность внутренних вызовов саб-агента под блоком `task`
          // в родительском стриме (UI строит дерево по parent_call_id).
          parent_call_id: extra.callId,
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
          agentCapabilities: subagentDef?.capabilities,
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
            content: extra.contextConfig && permissionDecision.messageId
              ? (extra.contextConfig.getSecurityMessage(permissionDecision.messageId, 'en', permissionDecision.params)
                ?? `Permission denied: ${permissionDecision.reason}`)
              : `Permission denied: ${permissionDecision.reason}`,
            isError: true,
            metadata: {
              ...(permissionDecision.messageId
                ? { i18n: i18nMeta(`security.${permissionDecision.messageId.replaceAll('-', '_')}`, permissionDecision.params as Record<string, string> | undefined) }
                : { i18n: i18nMeta('tool.permission_denied_default') }),
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
          const approvalAskReason = extra.contextConfig && permissionDecision.messageId
            ? (extra.contextConfig.getSecurityMessage(permissionDecision.messageId, 'en', permissionDecision.params)
              ?? permissionDecision.reason)
            : permissionDecision.reason;
          const approval = await childApprovalManager.waitForDecision(
            extra.sessionId!,
            {
              approvalId: `approval_${tcId}`,
              callId: tcId,
              toolName,
              arguments: toolArgs,
              reason: approvalAskReason,
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
                  content: sm('tool.args_error', { tool: toolName, issues: parsed2.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }),
                  isError: true,
                  metadata: { i18n: i18nMeta('tool.args_error', { tool: toolName }) },
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
                    content: sm('tool.exec_error', { tool: toolName, error: String(execError) }),
                    isError: true,
                    metadata: { i18n: i18nMeta('tool.exec_error', { tool: toolName }) },
                  };
                }
              }
            } else {
              toolResult = {
                content: sm('tool.not_found', { tool: toolName }),
                isError: true,
                metadata: { i18n: i18nMeta('tool.not_found', { tool: toolName }) },
              };
            }
          } else {
            const why = approval.timeout
              ? sm('permission.ask_timeout')
              : approval.noSubscribers
                ? sm('permission.ask_no_subscribers')
                : sm('permission.ask_denied');
            const baseDeny = extra.contextConfig && permissionDecision.messageId
              ? (extra.contextConfig.getSecurityMessage(permissionDecision.messageId, 'en', permissionDecision.params)
                ?? `Permission denied: ${permissionDecision.reason}`)
              : `Permission denied: ${permissionDecision.reason}`;
            toolResult = {
              content: `${baseDeny} (${why})`,
              isError: true,
              metadata: {
                ...(permissionDecision.messageId
                  ? { i18n: i18nMeta(`security.${permissionDecision.messageId.replaceAll('-', '_')}`, permissionDecision.params as Record<string, string> | undefined) }
                  : {}),
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
                content: sm('tool.args_error', { tool: toolName, issues: parsed2.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }),
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
                  content: sm('tool.exec_error', { tool: toolName, error: String(execError) }),
                  isError: true,
                  metadata: { i18n: i18nMeta('tool.exec_error', { tool: toolName }) },
                };
              }
            }
          } else {
            toolResult = {
              content: sm('tool.not_found', { tool: toolName }),
              isError: true,
              metadata: { i18n: i18nMeta('tool.not_found', { tool: toolName }) },
            };
          }
        }

        publish?.('tool_call.result', {
          stream_id: extra.streamId,
          session_id: extra.sessionId,
          call_id: tcId,
          name: toolName,
          result: toolResult,
          iteration: stepIteration,
          parent_call_id: extra.callId,
        });

        allSubagentToolCalls.push({
          name: toolName,
          args: toolArgs,
          id: tcId,
          result: { content: toolResult.content, isError: toolResult.isError },
          started_at: tcStartedAt,
          completed_at: new Date().toISOString(),
          iteration: stepIteration,
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
              metadata: {
                stream_id: extra.streamId,
                tool_chain: true,
                tool_name: toolName,
                args: toolArgs,
              },
            };
            const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
            if (updated && extra.eventBus) {
              const idx = updated.messages.length - 1;
              await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
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
        iteration: stepIteration,
        total_tool_calls: toolCalls.length,
      });

      if (subagentDenied) break;
    }

    // Отмена до/после цикла (например сигнал уже абортирован на входе или
    // пришёл во время исполнения тулов саб-агента) — тот же протокол
    // прерывания, что и при отмене во время стрима.
    if (isAborted()) {
      return await finishAborted('', '');
    }

    if (subagentDenied && !finalContent) {
      finalContent = sm('task.stopped_by_deny');
    }

    const output = finalContent || sm('task.empty_response');

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
                // Перевызываем с fallback-моделью (только последний user-запрос);
                // system — вторым аргументом chat, в messages его нет (AD-070 §1.5).
                const fbMessages: LLMMessage[] = [];
                const userMsg = messages.find(m => m.role === 'user');
                if (userMsg) fbMessages.push(userMsg);
                const fbResponse = await fbEffectiveProvider.chat(
                  fbMessages,
                  llmSystemPrompt || undefined,
                  undefined,
                  false,
                );
                if (fbResponse.content) {
                  finalContent = fbResponse.content;
                  qualityOutput = fbResponse.content;
                  qaPass = true;
                  qaReason = sm('router.escalation', { provider: fallbackProvider, model: fallbackModel, reason: qaResult.reason });
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
    await finalizeChildSession();

    // ─── Формирование результата tool_result ──────────────────────
    const qualityBlock = qaPass !== undefined
      ? `<quality pass="${qaPass}" reason="${qaReason || ''}"/>\n`
      : '';
    const routedByBlock = routingDecisionInfo && routingDecisionInfo.strategy !== 'default'
      ? `<routed_by strategy="${routingDecisionInfo.strategy}" provider="${routingDecisionInfo.providerName}" model="${routingDecisionInfo.modelName}"/>\n`
      : '';
    const qaWarningText = qaPass === false
      ? `\n\n⚠️ Response failed the quality check: ${qaReason || 'unknown reason'}`
      : '';
    // ID дочерней сессии в content — родительская модель может прочитать
    // историю саб-агента тулом read_session_reference.
    const childSessionBlock = childSessionId
      ? `<child_session_id>${childSessionId}</child_session_id>\n`
      : '';

    return {
      content: `<task_result>\n<summary>${description}</summary>\n${qualityBlock}${routedByBlock}${childSessionBlock}\n${qualityOutput}${qaWarningText}\n</task_result>`,
      metadata: {
        subagent_type: subagentType,
        description: description,
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
      content: sm('task.subagent_exec_error', { type: subagentType, error: String(err) }),
      isError: true,
      metadata: { subagent_type: subagentType },
    };
  }
}
