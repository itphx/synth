/**
 * Определение тула `task` — запуск саб-агента (ADR-026/029/034/070/089).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения; общий цикл —
 * в `run-cycle.ts`, создание дочерней сессии — в `fork.ts`, промпт — в `prompt.ts`.
 */
import { MessageRole, nowISO, generateId, makeTextPart, ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, Message, SessionSettings, ToolForLLM } from '@itphx/synth-shared';
import { normalizeAgentModes } from '../../agents/normalize.js';
import type { LLMMessage } from '../../../providers/base.js';
import { formatSkillsCatalogBlock } from '../../skills/catalog.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { publishMessageAdded } from './child-session.js';
import { prepareChildSession, type PreparedChildSession } from './fork.js';
import { buildSubagentUnavailableToolsSection, messageToLLMMessage, resolveSubagentPrompt } from './prompt.js';
import { runSubagent } from './run-cycle.js';
import { taskParametersSchema, type TaskParams } from './args.js';
import type { ContextMode, TaskExtra } from './types.js';

const DEFAULT_SUBAGENT_MAX_STEPS = 15;
const DEFAULT_LAST_N = 4;

export const taskTool: ToolDefinition = {
  name: 'task',
  description:
    'Launch a new agent to handle complex, multistep tasks autonomously. '
    + 'Available subagent types: "general" (full tool access), "explore" (read-only code exploration). '
    + 'Use for tasks that require multiple tool calls. '
    + 'Set skip_context_files=true to omit project instruction files (AGENTS.md) from the subagent prompt. '
    + 'IMPORTANT: You must NOT ask the user to use the task tool — use it yourself proactively.',
  parameters: taskParametersSchema,
  capabilities: [ToolCapability.TASK],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const params = parsed.data as TaskParams;
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
    const tools: ToolForLLM[] | undefined = extra.agentRegistry.getToolsForAgent(agentDef.id, extra.mcpServers);
    const maxSteps = agentDef.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS;

    // ─── Настройки роутинга для дочерней сессии (ADR-034 Фаза 4) ──
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

    // ─── Создание дочерней сессии с контекстом (ADR-026/029) ────────
    const childState: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(childState, {
      extra,
      description: params.description,
      subagentType: params.subagent_type,
      contextMode,
      contextCount,
      childRoutingOverrides,
    });
    const childSessionId = childState.childSessionId;
    let childMessages = childState.childMessages;
    const parentNotesText = childState.parentNotesText;

    // ─── Сборка LLM-сообщений ────────────────────────────────────────
    let llmSystemPrompt = (() => {
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

      // ─── Информация о маршрутизации (ADR-034 Фаза 4) ──────────────
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

    // ADR-069 §7/§9.2: уже резолвленные проектные инструкции — в конец базового
    // промпта. Не добавляются при `skip_context_files=true` и при
    // `session.settings.systemPrompt` override дочерней сессии (как основная).
    const skipContextFiles = params.skip_context_files === true
      || Boolean(extra.parentSessionSettings?.systemPrompt?.trim());
    if (!skipContextFiles && extra.projectInstructions) {
      llmSystemPrompt += `\n\n${extra.projectInstructions}`;
    }

    // ADR-046 §5/§6.2: каталог скиллов саб-агенту. Binding — родителя
    // (fixed decision Фазы 1), capabilities — самого саб-агента (executor).
    if (extra.skillRuntime) {
      try {
        const parentAgent = extra.callerAgentRole
          ? extra.agentRegistry.get(extra.callerAgentRole)
          : undefined;
        const lang = extra.parentSessionSettings?.language || 'ru';
        const catalog = await extra.skillRuntime.buildCatalog({
          projectWorkspace: ctx.workingDir,
          agent: { id: extra.callerAgentRole, groups: parentAgent?.groups },
          capabilities: agentDef.capabilities,
          permissionConfig: extra.permissionConfig,
          sessionEnabled: extra.parentSessionSettings?.skills,
          sessionDisabled: extra.parentSessionSettings?.skillsDisabled,
          ...(extra.skillScope ?? {}),
        });
        const skillsBlock = [
          formatSkillsCatalogBlock(catalog.stable, lang, 'stable'),
          formatSkillsCatalogBlock(catalog.session, lang, 'session'),
        ].filter((b) => b.length > 0).join('\n\n');
        if (skillsBlock) llmSystemPrompt += `\n\n${skillsBlock}`;
      } catch {
        // каталог скиллов не должен ломать запуск саб-агента
      }
    }

    // ADR-070 §2.9.1: недоступные по внешней зависимости (git/rg/sh) тулы —
    // в системный промпт саб-агента, как state-сообщение у основного агента.
    const unavailableSection = buildSubagentUnavailableToolsSection(
      tools,
      extra.runtimeDeps,
      extra.parentSessionSettings?.language || 'ru',
      {
        workspaceReady: extra.workspaceReady,
        capabilitiesOf: (n) => extra.toolRegistry?.get(n)?.capabilities,
      },
    );
    if (unavailableSection) llmSystemPrompt += `\n\n${unavailableSection}`;

    // ─── Выбор провайдера для саб-агента через роутер (ADR-034 Фаза 4) ──
    let effectiveProvider = extra.provider;
    let routingDecisionInfo: { providerName: string; modelName: string; strategy: string } | undefined;
    const parentSettings = extra.parentSessionSettings;
    if (extra.modelRouter && (parentSettings?.routingEnabled !== false) && extra.routerConfig) {
      try {
        const decision = await extra.modelRouter.route({
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

    // ADR-070 §2.1/§1.5: system prompt передаётся ТОЛЬКО вторым аргументом
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
