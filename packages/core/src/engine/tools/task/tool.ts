/**
 * Определение тула `task` — запуск саб-агента (ADR-026/029/034/070/089).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения; общий цикл —
 * в `run-cycle.ts`, создание дочерней сессии — в `fork.ts`, промпт — в `prompt.ts`.
 */
import { MessageRole, nowISO, generateId, generateStreamId, makeTextPart, ToolCapability, MAX_STEER_INJECTIONS_PER_TURN } from '@itphx/synth-shared';
import type { ToolDefinition, Message, Session, SessionSettings, ToolForLLM, ToolContext, ToolResult, ModelConfig, TodoItem, AgentDefinition } from '@itphx/synth-shared';
import { DEFAULT_SUBAGENT_DEPTH } from '@itphx/synth-shared/config';
import { normalizeAgentModes } from '../../agents/normalize.js';
import { resolveAgentRoleAlias } from '../../agents/migrations.js';
import type { CancellationToken, LLMMessage, BaseProvider } from '../../../providers/base.js';
import type { ModelRouter } from '../../router/router.js';
import { formatSkillsCatalogBlock } from '../../skills/catalog.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { argErrorResult } from '../arg-error.js';
import { isProfileAllowed } from '../../../execution/profile-binding.js';
import { BackgroundLimitExceededError } from '../../background/types.js';
import { publishMessageAdded, resolveSessionDepth } from './child-session.js';
import { prepareChildSession, type PreparedChildSession } from './fork.js';
import { ensureTodoStateMessage } from './child-todo-state.js';
import { toTodoItem } from '../todo.js';
import { buildSubagentUnavailableToolsSection, buildTodoFinalizeSection, messageToLLMMessage, resolveSubagentPrompt } from './prompt.js';
import { runSubagent, type SubagentRunConfig } from './run-cycle.js';
import { runDetachableSubagent } from './detachable.js';
import { appendContinuationMessage, appendResumeMarker, resumeInitialMessages } from './resume-target.js';
import { enqueueSteerMessage, requeueMessages } from '../../../queue/processor.js';
import { EventBus } from '../../../events/bus.js';
import { taskParametersSchema, type TaskParams } from './args.js';
import type { ContextMode, TaskExtra } from './types.js';

const DEFAULT_SUBAGENT_MAX_STEPS = 15;
const DEFAULT_LAST_N = 4;
/** Сколько доступных пар `provider/model` перечислять в отказе каталога. */
const MODEL_HINTS_LIMIT = 10;

export const taskTool: ToolDefinition = {
  name: 'task',
  description:
    'Launch a new agent to handle complex, multistep tasks autonomously. '
    + 'subagent_type is taken from the agent registry — any agent whose mode includes "subagent" (for example general, explore, fixer, tester, researcher, security-auditor, devops, admin; '
    + 'general has full tool access, explore is read-only code exploration). An unknown type returns the list of available types. '
    + 'Use for tasks that require multiple tool calls. '
    + 'Set skip_context_files=true to omit project instruction files (AGENTS.md) from the subagent prompt. '
    + 'IMPORTANT: You must NOT ask the user to use the task tool — use it yourself proactively.',
  parameters: taskParametersSchema,
  capabilities: [ToolCapability.TASK],
  async execute(args, ctx) {
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as TaskParams;
    const extra = ctx.extra as TaskExtra | undefined;

    if (!extra?.provider || !extra?.agentRegistry) {
      return {
        content: sm('task.deps_unavailable'),
        isError: true,
      };
    }

    // ─── Агент нового ребёнка ─────────────────────────────────────
    // Резолв агента относится только к **новой** задаче: при `task_id`
    // `subagent_type` необязателен (PROP-142 §2), а агента ребёнка проверяет
    // `continueChildSession` — по `child.settings.agentRole`.
    let agentDef: AgentDefinition | undefined;
    if (!params.task_id) {
      const subagentType = params.subagent_type;
      if (!subagentType) {
        // Схема (`superRefine`) уже отсекает этот случай — защита от «схема
        // ослабла» (в т.ч. при вызове мимо схемы).
        return argErrorResult(this.name, 'subagent_type: is required for a new task');
      }
      agentDef = extra.agentRegistry.get(subagentType);
      if (!agentDef) {
        return {
          content: sm('task.subagent_not_found', { type: subagentType, types: extra.agentRegistry.getSubagents().map((a) => a.id).join(', ') }),
          isError: true,
        };
      }

      if (!normalizeAgentModes(agentDef.agentMode).includes('subagent')) {
        return {
          content: sm('task.subagent_not_allowed', { type: subagentType, modes: String(agentDef.agentMode) }),
          isError: true,
        };
      }
    }

    // ─── Лимит глубины вложенности (`agents.subagentDepth`) ──────────
    // Глубина считается по цепочке `parentId` сессий: текущая сессия — 0,
    // её родитель — 1, дедушка — 2. При превышении лимита отказ **до**
    // создания дочерней сессии (иначе остался бы «пустой» ребёнок).
    // `0` — без ограничения; не задано — дефолт секции `agents` (1).
    //
    // Глубина берётся у сессии-родителя будущего ребёнка (`extra.sessionId` —
    // именно он записывается в `parentId` дочерней сессии, см. `fork.ts`).
    const depthLimit = extra.subagentDepth ?? DEFAULT_SUBAGENT_DEPTH;
    if (depthLimit > 0) {
      const currentDepth = await resolveSessionDepth(
        extra.sessionManager,
        extra.sessionId || ctx.sessionId,
      );
      if (currentDepth >= depthLimit) {
        const params = { limit: String(depthLimit) };
        return {
          content: sm('task.depth_limit', params),
          isError: true,
          metadata: { i18n: i18nMeta('task.depth_limit', params) },
        };
      }
    }

    // ─── Продолжение существующей дочерней сессии (`task_id`) ───────
    // Продолжение идёт **синхронно в текущем ходе** (родитель ждёт): новая
    // дочерняя сессия не создаётся, берётся история указанной (`PROP-096`
    // §«Продолжение ребёнка»).
    if (params.task_id) {
      return await continueChildSession({ params, extra, ctx });
    }

    // Дальше — только **новая** задача: `subagent_type`/`prompt` обязательны
    // (проверено `superRefine` в `args.ts`). Защита — от «схема ослабла».
    const subagentType = params.subagent_type;
    const promptText = params.prompt;
    if (!agentDef || !subagentType || promptText === undefined) {
      return argErrorResult(this.name, 'prompt and subagent_type are required for a new task');
    }

    // ─── Фон недоступен → отказ ДО создания дочерней сессии ────────
    // Проверка идёт до `prepareChildSession`: иначе при выключенном фоне
    // оставался бы «пустой» ребёнок (сессия + `session.created`) без прогона.
    if (params.background === true && (!extra.backgroundService || extra.backgroundEnabled === false)) {
      return {
        content: sm('task.background_disabled'),
        isError: true,
        metadata: { i18n: i18nMeta('task.background_disabled') },
      };
    }

    // ─── PROP-135 Ф6a: профиль исполнения дочерней сессии ─────────────
    // Явный `executor_profile`: проверяем существование в каталоге и потолки
    // проекта/агента ДО создания ребёнка (иначе осталась бы «пустая» сессия).
    // Не задан — ребёнок наследует настройки родителя (binding проверит их
    // на ходе ребёнка).
    const requestedExecutorProfile = params.executor_profile?.trim() ?? '';
    if (requestedExecutorProfile !== '') {
      const profileError = await validateChildExecutorProfile(requestedExecutorProfile, agentDef, extra);
      if (profileError) return profileError;
    }

    const contextMode: ContextMode = params.context_mode || 'none';
    const contextCount = params.context_count || DEFAULT_LAST_N;
    const systemPrompt = resolveSubagentPrompt(
      subagentType,
      extra.parentSessionSettings?.language,
      extra.contextConfig?.systemPromptsDir,
    );
    const tools: ToolForLLM[] | undefined = extra.agentRegistry.getToolsForAgent(agentDef.id, extra.mcpServers);
    const maxSteps = agentDef.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS;

    // ─── Выбор провайдера для саб-агента (ADR-034 Фаза 4) ────────────
    // Резолвится ДО создания дочерней сессии: настройки ребёнка должны
    // совпадать с фактической моделью прогона.
    // Температура саб-агента: `agent.temperature` → `session.settings.temperature`
    // родителя → дефолт модели (`undefined` — поле не отправляется). Одна и та
    // же величина уходит и провайдеру прогона, и в настройки дочерней сессии —
    // иначе ребёнок показывал бы одну температуру, а прогон шёл с другой.
    // Пара и sampling агента (`AgentDefinition.provider`/`model`/`topP`/`topK`)
    // идут тем же путём: пустая строка — «не задано», `0` у sampling — «не задано».
    const effectiveTemperature = agentDef.temperature ?? extra.parentSessionSettings?.temperature;
    const agentProvider = agentDef.provider?.trim() || undefined;
    const agentModel = agentDef.model?.trim() || undefined;
    const agentTopP = agentDef.topP && agentDef.topP > 0 ? agentDef.topP : undefined;
    const agentTopK = agentDef.topK && agentDef.topK > 0 ? agentDef.topK : undefined;
    const resolution = await resolveSubagentProvider({
      params,
      extra,
      parentSettings: extra.parentSessionSettings,
      temperature: effectiveTemperature,
      agentProvider,
      agentModel,
      topP: agentTopP,
      topK: agentTopK,
    });
    if (resolution.unavailable) {
      const { provider, model, available } = resolution.unavailable;
      // Каталог знает доступные пары — отказ объясняет, что запрошенной пары
      // нет (или модель отключена), и перечисляет альтернативы.
      if (available !== undefined) {
        const params = { provider, model, available };
        return {
          content: sm('task.model_not_in_catalog', params),
          isError: true,
          metadata: { available_models: available, i18n: i18nMeta('task.model_not_in_catalog', params) },
        };
      }
      const params = { provider, model };
      return {
        content: sm('task.model_unavailable', params),
        isError: true,
        metadata: { i18n: i18nMeta('task.model_unavailable', params) },
      };
    }

    // ─── Настройки роутинга для дочерней сессии (ADR-034 Фаза 4) ──
    const childRoutingOverrides: Partial<SessionSettings> = {};
    // Фактическая пара провайдер/модель прогона = настройки ребёнка
    // (иначе дочерняя сессия указывала бы на модель, которой не шёл прогон).
    if (resolution.providerName) childRoutingOverrides.provider = resolution.providerName;
    if (resolution.modelName) childRoutingOverrides.model = resolution.modelName;
    // Саб-агент идёт по модели, отличной от родительской — блок роутинга
    // в его промпте остаётся осмысленным (как и при явном выборе модели).
    const usesOwnModel = resolution.providerName !== resolution.parentProviderName
      || resolution.modelName !== resolution.parentModelName;
    if (agentDef?.reasoningLevel) childRoutingOverrides.reasoningLevel = agentDef.reasoningLevel;
    // ADR-117: явный тир усилия агента фиксируется в настройках ребёнка —
    // продолжение (`task({task_id})`/`task-resume`) берёт его оттуда.
    if (agentDef?.effort) childRoutingOverrides.effort = agentDef.effort;
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
    }

    // PROP-135 Ф6a: явный профиль исполнения ребёнка — в его `settings`
    // (`createSession` копирует настройки как есть; binding ребёнка увидит его
    // как профиль сессии).
    if (requestedExecutorProfile !== '') {
      childRoutingOverrides.executorProfile = requestedExecutorProfile;
    }

    // ─── Создание дочерней сессии с контекстом (ADR-026/029) ────────
    const childState: PreparedChildSession = { childMessages: [], parentNotesText: '' };
    await prepareChildSession(childState, {
      extra,
      description: params.description,
      subagentType,
      contextMode,
      contextCount,
      childRoutingOverrides,
      temperature: effectiveTemperature,
      // Фактическая пара прогона — чтобы ребёнок видел именно её.
      provider: resolution.providerName,
      model: resolution.modelName,
      // ADR-039: стартовый список задач ребёнка (`task.todos`). `undefined` —
      // список не трогаем (сид только при явном параметре).
      todos: params.todos,
    });
    const childSessionId = childState.childSessionId;
    let childMessages = childState.childMessages;
    const parentNotesText = childState.parentNotesText;

    // ADR-039/ADR-070: seeded `session.todos` должен быть виден модели как
    // durable state-сообщение `todos_updated` (как у основной сессии). Список
    // записан в fork `prepareChildSession` — здесь только state-сообщение и
    // обновление локальной копии истории для `inherit`/`last_n`.
    let childTodos: TodoItem[] = [];
    if (childSessionId && extra.sessionManager) {
      try {
        await ensureTodoStateMessage(extra.sessionManager, childSessionId);
        const refreshed = await extra.sessionManager.getSession(childSessionId);
        if (refreshed) {
          childMessages = refreshed.messages;
          childTodos = refreshed.todos ?? [];
        }
      } catch {
        // state-сообщение derived — его сбой не должен ломать прогон
      }
    }

    // ADR-026: стандартный системный блок `[SUBAGENT]` добавляется в начало
    // system prompt **только нового** дочернего прогона (продолжения
    // `task_id`/resume его не получают). В user-сообщении и истории его нет.
    // `params.prompt` передаётся как есть — он же уходит в routing/QA.
    const subagentLang = extra.parentSessionSettings?.language || 'ru';
    const subagentNotice = extra.contextConfig?.getSubagentNotice(subagentLang) ?? '';
    // ADR-135/PROP-135: блок `[СРЕДА ИСПОЛНЕНИЯ]` — тот же текст, что в
    // системном промпте основной сессии (его композер собирает сам; здесь
    // промпт саб-агента собирается напрямую). Файл отсутствует — блока нет.
    const environmentNotice = extra.environmentKind
      ? extra.contextConfig?.getEnvironment(extra.environmentKind, subagentLang) ?? ''
      : '';

    // ─── Сборка LLM-сообщений ────────────────────────────────────────
    let llmSystemPrompt = (() => {
      // ADR-039: инструкция «приведи список todo в актуальное состояние» —
      // только если у ребёнка есть тул `todo_write` и список непуст.
      // Сам список в промпт не дублируется (он в state-сообщении).
      const todoFinalize = buildTodoFinalizeSection({
        tools,
        todos: childTodos,
        contextConfig: extra.contextConfig,
        language: subagentLang,
      });
      let prompt = [subagentNotice, environmentNotice, todoFinalize, systemPrompt]
        .filter(Boolean)
        .join('\n\n');

      // Заметки родительской сессии — передаём во всех режимах с контекстом
      // (inherit, summary, last_n), но НЕ в none (чистый лист)
      if (contextMode !== 'none' && parentNotesText) {
        prompt += `\n\n[PARENT NOTES]\nНиже — важные заметки из основной сессии. Учитывай их при выполнении задачи.\n\n${parentNotesText}`;
      }

      if (contextMode === 'summary') {
        // Сжатие родительской истории — из состояния форка (ADR-026, обновление
        // 2026-10-29); fallback — SUMMARY-сообщение в истории ребёнка (старые сессии).
        const parentSummaryText = childState.parentSummaryText
          ?? childMessages.find(m => m.role === MessageRole.SUMMARY)?.content;
        if (parentSummaryText) {
          prompt += `\n\n[PARENT SUMMARY]\n${parentSummaryText}`;
        }
      }

      // ─── Информация о маршрутизации (ADR-034 Фаза 4) ──────────────
      // Загружается из контекстных файлов prompts/system/ROUTING.{lang}.md
      const parentSettings = extra.parentSessionSettings;
      const routingEnabled = extra.routerConfig?.enabled && (parentSettings?.routingEnabled !== false);
      const shouldShowRouting = routingEnabled || usesOwnModel;
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

    // ADR-126 §5/§6.2: каталог скиллов саб-агенту. Binding — родителя
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

    // ─── Провайдер прогона саб-агента (ADR-034 Фаза 4) ──────────────
    // Резолв выполнен выше (до создания дочерней сессии) — здесь только
    // фиксируем фактический провайдер и routing-решение для отчётности.
    const effectiveProvider = resolution.provider;
    const routingDecisionInfo = resolution.routingDecisionInfo;

    // ADR-070 §2.1/§1.5: system prompt передаётся ТОЛЬКО вторым аргументом
    // chatAsync (как в оркестраторе), в messages system-сообщения нет —
    // иначе у OpenAI/Remote получаются два system-сообщения подряд.
    const messages: LLMMessage[] = [];

    if ((contextMode === 'inherit' || contextMode === 'last_n') && childMessages.length > 0) {
      // Пара прогона ребёнка — фактический провайдер/модель саб-агента.
      const childPair = {
        provider: resolution.providerName,
        model: resolution.provider?.model || resolution.modelName,
      };
      for (const msg of childMessages) {
        if (msg.hidden || msg.disabled) continue;
        // Роль ребёнка: при `inherit`/`last_n` в историю попадают реплики
        // родителя (другой агент) — его thinking-блоки не прокидываются
        // (ADR-117, как в `resumeInitialMessages`); блоки сообщений, порождённых
        // другой парой provider+model, — тоже.
        messages.push(messageToLLMMessage(msg, agentDef.id, childPair));
      }
    }

    const userPromptMsg: LLMMessage = {
      id: '',
      role: 'user' as const,
      content: promptText,
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
          parts: [makeTextPart(promptText)],
          content: promptText,
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
    const runConfig: SubagentRunConfig = {
      subagentType,
      description: params.description,
      contextMode,
      maxSteps,
      llmSystemPrompt,
      initialMessages: messages,
      provider: effectiveProvider,
      // Температура прогона — для QA-эскалации (fallback-модель из пула).
      temperature: effectiveTemperature,
      // Sampling агента — для QA-эскалации (у fallback-модели остаётся sampling агента).
      topP: agentTopP,
      topK: agentTopK,
      // ADR-117: effort прогона — `agent.effort` → настройки родителя
      // (`reasoningLevel` — отдельным полем, ниже `effort` приоритетнее).
      effort: agentDef.effort ?? extra.parentSessionSettings?.effort,
      reasoningLevel: agentDef.reasoningLevel ?? extra.parentSessionSettings?.reasoningLevel,
      tools,
      childSessionId,
      parentSessionId: extra.sessionId!,
      routingDecisionInfo,
      extra,
      ctx,
      retry: extra.retry,
    };

    // ─── Фоновый запуск (PROP-096) ───────────────────────────────────
    // Родительский ход **не блокируется**: тул возвращает управление сразу,
    // а по завершении ребёнка приходит уведомление (сообщение в истории
    // родителя + автоход).
    if (params.background === true) {
      return await startBackgroundSubagent({ params, runConfig, extra, ctx });
    }

    // ─── Detach (ADR-111 §detach) ───────────────────────────────────
    // Прогон регистрируется в реестре активных прогонов сессии: `POST
    // /sessions/:id/background` может перевести его в фон, и тогда блокирующее
    // ожидание вернёт модели «переведено в фон». Без реестра/сервиса фоновых
    // прогонов — прежний блокирующий путь без изменений.
    return runDetachableSubagent({ params, runConfig, extra, ctx });
  },
};

/**
 * PROP-135 Ф6a: проверка явного `task.executor_profile` до создания ребёнка.
 *
 * Порядок проверок:
 * 1. профиль существует в каталоге инстанса (`execution.remote.profiles` +
 *    `defaultProfile`) — каталога нет (inline/instance-пул) → проверка
 *    пропускается;
 * 2. профиль разрешён агентом (`agentDefinition.allowedProfiles`);
 * 3. профиль разрешён проектом родительской сессии
 *    (`project.executor.allowedProfiles`); проект недоступен/нет
 *    `projectStore` → проверка проекта пропускается.
 *
 * ADR-135 (аддендум): список, **заданный** областью, — потолок: профиль
 * обязан в него входить; **пустой** список = «профилей нет» — делегирование с
 * профилем запрещено. Незаданный список — ограничения нет.
 * Нарушение → `tool.args_error` (дочерняя сессия не создаётся).
 */
async function validateChildExecutorProfile(
  profile: string,
  agentDef: AgentDefinition,
  extra: TaskExtra,
): Promise<ToolResult | null> {
  const catalog = extra.executionProfileCatalog;
  if (catalog && catalog.profiles.length > 0 && !catalog.profiles.includes(profile)) {
    return argErrorResult(
      'task',
      `executor_profile: profile "${profile}" does not exist (available: ${catalog.profiles.join(', ')})`,
    );
  }
  if (agentDef.allowedProfiles !== undefined && agentDef.allowedProfiles.length === 0) {
    return argErrorResult(
      'task',
      `executor_profile: agent "${agentDef.id}" has no allowed profiles (empty list) — delegation with a profile is not allowed`,
    );
  }
  if (!isProfileAllowed(profile, { agentAllowed: agentDef.allowedProfiles })) {
    return argErrorResult(
      'task',
      `executor_profile: profile "${profile}" is not allowed for agent "${agentDef.id}" (agent allowedProfiles)`,
    );
  }
  let projectAllowed: readonly string[] | undefined;
  if (extra.projectStore && extra.sessionManager && extra.sessionId) {
    try {
      const parent = await extra.sessionManager.getSession(extra.sessionId);
      if (parent?.projectId) {
        const project = await extra.projectStore.load(parent.projectId);
        projectAllowed = project?.executor?.allowedProfiles;
      }
    } catch {
      // Проект недоступен — проверка проекта пропускается (fail-open: отказ
      // по недоступному хранилищу заблокировал бы запуск саб-агента).
    }
  }
  if (projectAllowed !== undefined && projectAllowed.length === 0) {
    return argErrorResult(
      'task',
      'executor_profile: project has no allowed profiles (empty list) — delegation with a profile is not allowed',
    );
  }
  if (!isProfileAllowed(profile, { projectAllowed })) {
    return argErrorResult(
      'task',
      `executor_profile: profile "${profile}" is not allowed by the project (project.executor.allowedProfiles)`,
    );
  }
  return null;
}

/** Результат резолвинга провайдера/модели саб-агента. */
interface SubagentProviderResolution {
  /** Провайдер, которым реально пойдёт прогон саб-агента. */
  provider: BaseProvider;
  /** Пара provider/model фактического прогона. */
  providerName: string;
  modelName: string;
  /** Пара provider/model родительской сессии (с ней сравнивается фактическая). */
  parentProviderName: string;
  parentModelName: string;
  /** Routing-решение для отчётности (`<routed_by>`/metadata прогона). */
  routingDecisionInfo?: { providerName: string; modelName: string; strategy: string };
  /** Нужен не-родительский провайдер, но он недоступен — отказ тула. */
  unavailable?: {
    provider: string;
    model: string;
    /**
     * Пары из каталога моделей (до 10, `provider/model`) — заполняется, когда
     * запрошенную пару отверг каталог (`listModels`), а не пул провайдеров.
     * Наличие поля переключает текст отказа на `task.model_not_in_catalog`.
     */
    available?: string;
  };
}

/**
 * Клон провайдера с температурой и sampling агента.
 *
 * Провайдеры кэшируются и разделяются между прогонами — мутировать оригинал
 * нельзя. `withSampling` может отсутствовать у упрощённых/тестовых реализаций
 * `BaseProvider` — тогда sampling не применяется (температура — как раньше).
 */
function withAgentSampling(
  provider: BaseProvider,
  temperature: number | undefined,
  topP: number | undefined,
  topK: number | undefined,
): BaseProvider {
  const withTemperature = temperature !== undefined ? provider.withTemperature(temperature) : provider;
  return typeof withTemperature.withSampling === 'function'
    ? withTemperature.withSampling(topP, topK)
    : withTemperature;
}

/**
 * Провайдер из пула роутера с температурой и sampling агента.
 *
 * Без sampling вызываем прежней арностью (`getProvider(decision, temperature)`) —
 * наблюдаемый контракт пула для прогонов без `topP`/`topK` не меняется.
 */
function getPoolProvider(
  router: ModelRouter | undefined,
  decision: Parameters<ModelRouter['getProvider']>[0],
  temperature: number | undefined,
  topP: number | undefined,
  topK: number | undefined,
): BaseProvider | null {
  if (!router) return null;
  return topP !== undefined || topK !== undefined
    ? router.getProvider(decision, temperature, undefined, undefined, undefined, topP, topK)
    : router.getProvider(decision, temperature);
}

/**
 * Резолвинг провайдера/модели саб-агента (ADR-034 Фаза 4).
 *
 * Приоритет (сверху вниз):
 *  1. **явные** `params.model`/`params.provider` — пара, заданная вызывающим
 *     агентом (недостающее поле — из настроек родителя);
 *  2. **пара агента** — `AgentDefinition.provider`/`model` (недостающая
 *     половина — из родителя); пара, равная родительской, — базовый провайдер;
 *  3. `routerConfig.subagent.{model,provider}` — дефолт инстанса для
 *     саб-агентов (при `enabled !== false`), недостающее — из родителя;
 *  4. `params.routing_strategy === 'none'` — пара родителя, роутер не зовём;
 *  5. иначе — `modelRouter.route()` (прежнее поведение ADR-034).
 *
 * Пункты 1–3 роутер **не** зовут: провайдер резолвится напрямую через
 * `modelRouter.getProvider()` (с температурой и sampling агента). Если
 * запрошенная пара недоступна (провайдер не настроен/модель неизвестна) —
 * отказ тула `task.model_unavailable`, без тихого отката на родителя: иначе
 * прогон ушёл бы на другой модели, чем запросили.
 */
async function resolveSubagentProvider(opts: {
  params: TaskParams;
  extra: TaskExtra;
  parentSettings?: SessionSettings;
  /**
   * Температура прогона саб-агента (`agent.temperature` → `session.settings.temperature`).
   * `undefined` — дефолт модели.
   */
  temperature?: number;
  /** `AgentDefinition.provider` (trim; пусто — не задано). */
  agentProvider?: string;
  /** `AgentDefinition.model` (trim; пусто — не задано). */
  agentModel?: string;
  /** `agent.topP` (`> 0`; иначе не задано). */
  topP?: number;
  /** `agent.topK` (`> 0`; иначе не задано). */
  topK?: number;
}): Promise<SubagentProviderResolution> {
  const { params, extra, parentSettings, temperature, agentProvider, agentModel, topP, topK } = opts;

  // Пара родителя: настройки сессии → провайдер родителя (fallback).
  const parentProviderName = parentSettings?.provider || extra.provider?.name || '';
  const parentModelName = parentSettings?.model || extra.provider?.model || '';
  // Провайдер родителя кэширован в пуле и разделяется между прогонами, поэтому
  // температуру и sampling выставляем клоном (без `temperature`/sampling — берём
  // как есть: там могут быть значения конфига провайдера).
  const baseProvider = withAgentSampling(extra.provider, temperature, topP, topK);
  const base: SubagentProviderResolution = {
    provider: baseProvider,
    providerName: parentProviderName,
    modelName: parentModelName,
    parentProviderName,
    parentModelName,
  };

  const subagentCfg = extra.routerConfig?.subagent;
  const subagentCfgEnabled = subagentCfg !== undefined && subagentCfg.enabled !== false;
  let explicitModel = params.model?.trim() || '';
  let explicitProvider = params.provider?.trim() || '';
  // Составной id (`provider/model`) без явного `provider`: первый сегмент —
  // провайдер, остаток — имя модели (внутри него `/` допустим, например
  // `routerai/google/gemini-3.1-flash-lite`). Без разбора строка уходила бы
  // как имя модели в провайдер родителя/дефолт, и ошибку возвращал бы уже API
  // провайдера («supported API model names are…»).
  if (explicitModel.includes('/') && !explicitProvider) {
    const slash = explicitModel.indexOf('/');
    explicitProvider = explicitModel.slice(0, slash).trim();
    explicitModel = explicitModel.slice(slash + 1).trim();
  }
  const cfgModel = subagentCfgEnabled ? (subagentCfg?.model?.trim() || '') : '';
  const cfgProvider = subagentCfgEnabled ? (subagentCfg?.provider?.trim() || '') : '';

  /** Каталог моделей инстанса — если оркестратор передал загрузчик (fail-open). */
  const loadModelCatalog = async (): Promise<ModelConfig[] | null> => {
    if (!extra.listModels) return null;
    try {
      return await extra.listModels();
    } catch {
      // Каталог недоступен — валидация по нему не блокирует прогон.
      return null;
    }
  };

  /** Доступные пары каталога для текста отказа (до `MODEL_HINTS_LIMIT`). */
  const availablePairsText = (catalog: ModelConfig[]): string => {
    const pairs = catalog
      .filter((m) => m.enabled !== false)
      .map((m) => `${m.provider}/${m.name}`);
    const shown = pairs.slice(0, MODEL_HINTS_LIMIT);
    return pairs.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
  };

  /** Резолв заданной пары через пул провайдеров роутера (без `route()`). */
  const resolveRequestedPair = async (
    providerName: string,
    modelName: string,
    strategy: string,
  ): Promise<SubagentProviderResolution> => {
    // Валидация по каталогу — только для явно запрошенной пары (пара родителя
    // идёт прежним путём). Каталог строже пула провайдеров: модель может быть
    // заведена, но отключена (`enabled: false`).
    const isParentPair = providerName === parentProviderName && modelName === parentModelName;
    if (!isParentPair && providerName) {
      const catalog = await loadModelCatalog();
      if (catalog) {
        const entry = catalog.find((m) => m.provider === providerName && m.name === modelName);
        if (!entry || entry.enabled === false) {
          return {
            ...base,
            providerName,
            modelName,
            unavailable: {
              provider: providerName,
              model: modelName,
              available: availablePairsText(catalog),
            },
          };
        }
      }
    }

    const requested = {
      providerName,
      modelName,
      reason: 'explicit override',
      strategy: 'default',
    };
    const resolved = getPoolProvider(extra.modelRouter, requested, temperature, topP, topK);
    if (resolved) {
      return {
        ...base,
        provider: resolved,
        providerName,
        modelName,
        routingDecisionInfo: { providerName, modelName, strategy },
      };
    }
    // Провайдер недоступен. Если это ровно родительская пара — берём родителя
    // (запроса на другую модель не было), иначе — явный отказ.
    if (isParentPair) {
      return base;
    }
    return {
      ...base,
      providerName,
      modelName,
      unavailable: { provider: providerName, model: modelName },
    };
  };

  // 1. Явные параметры тула — приоритет выше всего.
  if (explicitModel || explicitProvider) {
    return await resolveRequestedPair(
      explicitProvider || parentProviderName,
      explicitModel || parentModelName,
      'explicit',
    );
  }

  // 2. Пара из определения агента (`AgentDefinition.provider`/`model`) — ниже
  //    явных параметров, но выше `router.subagent` и роутинга. Недостающая
  //    половина — из родителя; ровно родительская пара — базовый провайдер
  //    (температура/sampling агента уже выставлены клоном выше).
  if (agentProvider || agentModel) {
    const pairProvider = agentProvider || parentProviderName;
    const pairModel = agentModel || parentModelName;
    if (pairProvider === parentProviderName && pairModel === parentModelName) {
      return base;
    }
    return await resolveRequestedPair(pairProvider, pairModel, 'agent');
  }

  // 3. Дефолт инстанса для саб-агентов (router.subagent).
  if (cfgModel || cfgProvider) {
    return await resolveRequestedPair(
      cfgProvider || parentProviderName,
      cfgModel || parentModelName,
      'subagent-config',
    );
  }

  // 4. Роутинг выключен явно (`routing_strategy: 'none'`) — пара родителя,
  //    роутер не зовём.
  if (params.routing_strategy === 'none') {
    return base;
  }

  // 5. Роутинг ADR-034 — прежнее поведение: решение роутера, при совпадении
  //    с родителем — провайдер родителя.
  if (extra.modelRouter && parentSettings && parentSettings.routingEnabled !== false && extra.routerConfig) {
    try {
      const decision = await extra.modelRouter.route({
        sessionSettings: parentSettings,
        // Промпт новой задачи обязателен (схема); для пустого — пустая строка
        // (роутер классифицирует по содержимому, отсутствие текста — «ничего»).
        userMessage: params.prompt ?? '',
      });
      // Sampling агента сохраняется и на роутнутой модели (temp — прогона).
      const routedProvider = getPoolProvider(extra.modelRouter, decision, temperature, topP, topK);
      if (routedProvider && (decision.providerName !== parentProviderName || decision.modelName !== parentModelName)) {
        return {
          ...base,
          provider: routedProvider,
          providerName: decision.providerName,
          modelName: decision.modelName,
          routingDecisionInfo: {
            providerName: decision.providerName,
            modelName: decision.modelName,
            strategy: decision.strategy,
          },
        };
      }
    } catch {
      // fallback на провайдер родителя
    }
  }

  return base;
}

/**
 * Продолжение дочерней сессии саб-агента из тула `task` (`task_id`).
 *
 * Проверки: сессия существует, она — ребёнок **текущей** сессии, агент ребёнка
 * в реестре и в режиме `subagent`.
 *
 * Дальше — два пути (PROP-142 §1–§2):
 *  - ребёнок **занят** (идёт ход или фоновый прогон) — сообщение доставляется
 *    в него (`delivery: steer|queue`), тул возвращает `{status}` сразу;
 *  - ребёнок **свободен** — синхронное продолжение в текущем ходе родителя
 *    (общий цикл `runSubagent`), родитель ждёт результат.
 */
async function continueChildSession(opts: {
  params: TaskParams;
  extra: TaskExtra;
  ctx: ToolContext;
}): Promise<ToolResult> {
  const { params, extra, ctx } = opts;
  const sessionManager = extra.sessionManager;
  if (!sessionManager) {
    return { content: sm('task.deps_unavailable'), isError: true };
  }

  const childId = params.task_id!;
  const child = await sessionManager.getSession(childId);
  if (!child) {
    return {
      content: sm('task.resume_session_not_found', { id: childId }),
      isError: true,
      metadata: { i18n: i18nMeta('task.resume_session_not_found', { id: childId }) },
    };
  }
  // Чужой ребёнок продолжить нельзя (только свой).
  if (child.parentId !== ctx.sessionId) {
    return {
      content: sm('task.resume_foreign_child', { id: childId }),
      isError: true,
      metadata: { i18n: i18nMeta('task.resume_foreign_child', { id: childId }) },
    };
  }

  const agentRole = child.settings.agentRole || '';
  const agentDef = agentRole ? extra.agentRegistry.get(agentRole) : undefined;
  if (!agentDef || !normalizeAgentModes(agentDef.agentMode).includes('subagent')) {
    return {
      content: sm('task.resume_agent_not_found', { type: agentRole }),
      isError: true,
      metadata: { i18n: i18nMeta('task.resume_agent_not_found', { type: agentRole }) },
    };
  }

  // PROP-142 §2: агента ребёнка **не переключаем** (история, системный промпт
  // и права принадлежат одному агенту). `subagent_type` при `task_id`
  // необязателен; задан и не совпадает — отказ с объяснением (тихое
  // игнорирование недопустимо). Сравнение — с учётом алиасов прежних ролей.
  const requestedType = params.subagent_type?.trim();
  if (requestedType && normalizeAgentRole(requestedType) !== normalizeAgentRole(agentRole)) {
    const i18nParams = { current: agentRole, requested: requestedType };
    return {
      content: sm('task.agent_switch_unsupported', i18nParams),
      isError: true,
      metadata: { i18n: i18nMeta('task.agent_switch_unsupported', i18nParams) },
    };
  }

  // Занятость ребёнка: идёт ход (`currentStream`/blocked) **или** идёт его
  // фоновый прогон (реестр фоновых прогонов, ADR-111).
  const busy = Boolean(child.status.blocked || child.currentStream)
    || await isChildBusyInBackground(child.id, ctx.sessionId, extra);
  if (busy) {
    return await deliverToBusyChild({ params, extra, ctx, child });
  }

  // ─── Свободный ребёнок: пара прогона и новое указание ─────────────
  // PROP-142 §2: `model`/`provider` при `task_id` переключают пару ребёнка
  // (точечная правка `settings`); агента — нет.
  let explicitProvider = params.provider?.trim() ?? '';
  let explicitModelRaw = params.model?.trim() ?? '';
  // Составной id (`provider/model`) без явного `provider` — тот же разбор,
  // что у нового прогона (`resolveSubagentProvider`).
  if (explicitModelRaw.includes('/') && !explicitProvider) {
    const slash = explicitModelRaw.indexOf('/');
    explicitProvider = explicitModelRaw.slice(0, slash).trim();
    explicitModelRaw = explicitModelRaw.slice(slash + 1).trim();
  }
  if (explicitProvider && explicitModelRaw) {
    const pairError = await validateContinuationPair({
      extra,
      provider: explicitProvider,
      model: explicitModelRaw,
    });
    if (pairError) return pairError;
  }

  // Настройки ребёнка — точечная правка (ADR-144: полная запись снимка
  // затирает чужую дозапись). `touchUpdatedAt:false` — смена пары не
  // «оживляет» сессию ребёнка в списках.
  let currentChild = child;
  if (explicitProvider || explicitModelRaw) {
    try {
      await sessionManager.mutateMeta(child.id, (meta) => {
        let changed = false;
        if (explicitProvider && meta.settings.provider !== explicitProvider) {
          meta.settings.provider = explicitProvider;
          changed = true;
        }
        if (explicitModelRaw && meta.settings.model !== explicitModelRaw) {
          meta.settings.model = explicitModelRaw;
          changed = true;
        }
        return changed;
      }, { touchUpdatedAt: false, shouldWrite: (changed) => changed });
      const refreshed = await sessionManager.getSession(child.id);
      if (refreshed) currentChild = refreshed;
    } catch {
      // Правка настроек не удалась — продолжаем с прежней парой (резолвер
      // провайдера ниже возьмёт фактическую).
    }
  }

  const streamId = generateStreamId();
  // Продолжение с текстом — обычное user-сообщение (`metadata.continuation`);
  // без текста — прежний служебный маркер (`task.resume_marker`).
  const continuationText = params.prompt !== undefined && params.prompt.trim() !== ''
    ? params.prompt
    : undefined;
  let freshChild = continuationText !== undefined
    ? await appendContinuationMessage(sessionManager, extra.eventBus, {
      child: currentChild,
      parentSessionId: ctx.sessionId,
      streamId,
      text: continuationText,
    })
    : await appendResumeMarker(sessionManager, extra.eventBus, {
      child: currentChild,
      parentSessionId: ctx.sessionId,
      streamId,
    });

  // ADR-039: `task_id` + `todos` — полная замена списка задач ребёнка (как
  // `todo_write`); без `todos` список не трогается. State-сообщение
  // `todos_updated` синхронизируется после этого в любом случае.
  try {
    if (params.todos !== undefined) {
      const normalized = params.todos.map(toTodoItem);
      // Точечная правка списка (полная замена): `withLock`+`saveSession` писал
      // снимок целиком. `touchUpdatedAt:false` — паритет: старт продолжения
      // время сессии ребёнка не двигал.
      await sessionManager.mutateMeta(child.id, (meta) => {
        meta.todos = normalized;
      }, { touchUpdatedAt: false });
    }
    await ensureTodoStateMessage(sessionManager, child.id);
    const refreshed = await sessionManager.getSession(child.id);
    if (refreshed) freshChild = refreshed;
  } catch {
    // state-сообщение derived — его сбой не должен ломать продолжение
  }

  const childExtra: TaskExtra = {
    ...extra,
    // Настройки ребёнка — его собственные (permission/настройки/язык).
    parentSessionSettings: currentChild.settings,
    permissionConfig: currentChild.settings.permission ?? extra.permissionConfig,
    streamId,
  };

  // Температура продолжения: `agent.temperature` → настройки ребёнка (унаследованы
  // от родителя при создании). Провайдер родителя кэширован и разделяется —
  // берём клон, иначе ребёнок шёл бы с температурой родительского хода.
  // Пара продолжения: явные `provider`/`model` → пара агента → настройки
  // ребёнка (при создании туда зафиксирована фактическая пара прогона) →
  // провайдер родителя.
  const agentProvider = agentDef.provider?.trim() || undefined;
  const agentModel = agentDef.model?.trim() || undefined;
  const agentTopP = agentDef.topP && agentDef.topP > 0 ? agentDef.topP : undefined;
  const agentTopK = agentDef.topK && agentDef.topK > 0 ? agentDef.topK : undefined;

  const childTemperature = agentDef.temperature ?? currentChild.settings.temperature;
  const desiredProvider = explicitProvider || agentProvider || currentChild.settings.provider || extra.provider.name;
  const desiredModel = explicitModelRaw || agentModel || currentChild.settings.model || extra.provider.model;

  // Пара отличается от провайдера родителя — берём её из пула роутера
  // (с температурой и sampling агента); иначе — клон родительского.
  let childProvider: BaseProvider | null = null;
  if (extra.modelRouter && (desiredProvider !== extra.provider.name || desiredModel !== extra.provider.model)) {
    childProvider = getPoolProvider(
      extra.modelRouter,
      { providerName: desiredProvider, modelName: desiredModel, reason: 'agent pair', strategy: 'default' },
      childTemperature,
      agentTopP,
      agentTopK,
    );
  }
  // Явная пара, которой нет в пуле, — **отказ**, а не тихий откат на
  // родительского провайдера (иначе ребёнок пошёл бы на другой модели).
  if (!childProvider && (explicitProvider || explicitModelRaw)) {
    const i18nParams = { provider: desiredProvider, model: desiredModel };
    return {
      content: sm('task.model_unavailable', i18nParams),
      isError: true,
      metadata: { i18n: i18nMeta('task.model_unavailable', i18nParams) },
    };
  }
  childProvider ??= withAgentSampling(extra.provider, childTemperature, agentTopP, agentTopK);

  // ADR-039: тулы ребёнка собираются один раз — по ним же решается, нужна ли
  // инструкция финализации списка todo (есть ли `todo_write`).
  const childTools = extra.agentRegistry.getToolsForAgent(agentDef.id, extra.mcpServers);
  const todoFinalize = buildTodoFinalizeSection({
    tools: childTools,
    todos: freshChild.todos ?? [],
    contextConfig: extra.contextConfig,
    language: currentChild.settings.language || 'ru',
  });

  const runConfig: SubagentRunConfig = {
    subagentType: agentRole,
    description: params.description || currentChild.title || '',
    contextMode: 'none',
    maxSteps: agentDef.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS,
    llmSystemPrompt: [
      resolveSubagentPrompt(
        agentRole,
        currentChild.settings.language,
        extra.contextConfig?.systemPromptsDir,
      ),
      // ADR-135/PROP-135: среда исполнения — тот же блок, что у нового прогона.
      extra.environmentKind
        ? extra.contextConfig?.getEnvironment(
            extra.environmentKind,
            currentChild.settings.language || 'ru',
          ) ?? ''
        : '',
      todoFinalize,
    ].filter(Boolean).join('\n\n'),
    initialMessages: resumeInitialMessages(freshChild),
    provider: childProvider,
    // Температура продолжения — для QA-эскалации (fallback-модель из пула).
    temperature: childTemperature,
    // Sampling агента — для QA-эскалации (fallback-модель из пула).
    topP: agentTopP,
    topK: agentTopK,
    // ADR-117: effort продолжения — `agent.effort` → настройки ребёнка
    // (`reasoningLevel` — отдельным полем, `effort` приоритетнее).
    effort: agentDef.effort ?? currentChild.settings.effort,
    reasoningLevel: agentDef.reasoningLevel ?? currentChild.settings.reasoningLevel,
    tools: childTools,
    childSessionId: currentChild.id,
    parentSessionId: ctx.sessionId,
    extra: childExtra,
    ctx,
    retry: extra.retry,
  };

  // PROP-142 §1: `background: true` при `task_id` — «продолжить, но не ждать».
  // Свободный ребёнок уходит в фоновый прогон: запись в реестре, родительский
  // ход не блокируется, итог приходит уведомлением. Настройки ребёнка
  // (`permissionConfig`/`parentSessionSettings`) уже в `runConfig.extra`.
  if (params.background === true) {
    return await startBackgroundSubagent({
      params: {
        ...params,
        // Агент ребёнка (при продолжении он не переключается) и описание —
        // в запись реестра фоновых прогонов.
        subagent_type: agentRole,
        description: params.description || currentChild.title || '',
      },
      runConfig,
      extra,
      ctx,
    });
  }

  return runSubagent(runConfig);
}

/**
 * Роль агента в каноническом виде: прежние метки (`pm`, `qa`, …) приводятся к
 * своей роли (`LEGACY_AGENT_ROLE_ALIASES`) — как в оркестраторе
 * (`ChatOrchestrator._resolveEffectiveAgentRole`).
 */
function normalizeAgentRole(role: string): string {
  return resolveAgentRoleAlias(role) ?? role;
}

/**
 * Идёт ли по ребёнку **фоновый** прогон (реестр фоновых прогонов, ADR-111).
 *
 * Занятый ребёнок виден не только по `currentStream`: фоновый прогон держит
 * `currentStream` ребёнка, но после рестарта инстанса маркер мог не сохраниться
 * — реестр прогонов остаётся источником истины.
 */
async function isChildBusyInBackground(
  childId: string,
  parentSessionId: string,
  extra: TaskExtra,
): Promise<boolean> {
  const service = extra.backgroundService;
  if (!service) return false;
  try {
    const runs = await service.list({
      kind: 'subagent',
      status: 'running',
      sessionId: parentSessionId,
    });
    return runs.some((run) => run.childSessionId === childId);
  } catch {
    // Реестр недоступен — считаем ребёнка свободным (прежнее поведение).
    return false;
  }
}

/**
 * Доставка сообщения **занятому** ребёнку (PROP-142 §1).
 *
 * `delivery: 'steer'` (по умолчанию) — инъекция в идущий ход ребёнка
 * (`steerInbox`, применяется на границе шага; ADR-104). `delivery: 'queue'` —
 * сообщение в обычную очередь ребёнка (`pendingMessages`; доставляется после
 * текущего прогона).
 *
 * Тул **не блокирует** ход родителя: возвращает `{status, child_session_id,
 * pending_count}`. Итог работы ребёнка приходит обычным уведомлением.
 */
async function deliverToBusyChild(opts: {
  params: TaskParams;
  extra: TaskExtra;
  ctx: ToolContext;
  child: Session;
}): Promise<ToolResult> {
  const { params, extra, child } = opts;
  const sessionManager = extra.sessionManager;
  if (!sessionManager) {
    return { content: sm('task.deps_unavailable'), isError: true };
  }
  // Занятого ребёнка можно только **обновить** текстом: без указания
  // доставлять нечего.
  const text = params.prompt ?? '';
  if (text.trim() === '') {
    return {
      content: sm('task.continuation_prompt_required'),
      isError: true,
      metadata: { i18n: i18nMeta('task.continuation_prompt_required') },
    };
  }

  const delivery = params.delivery ?? 'steer';
  // Сообщение — как обычный ввод: роль USER, автор — вызывающий агент.
  const msg: Message = {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(text)],
    content: text,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: extra.callerAgentRole ?? 'user',
    metadata: { stream_id: generateStreamId() },
  };

  if (delivery === 'queue') {
    // Очередь ребёнка: сообщение ждёт текущего прогона (авто-продолжение —
    // отдельный этап, ADR-142 §3).
    const queued = await requeueMessages({
      sessionManager,
      eventBus: extra.eventBus,
      sessionId: child.id,
      messages: [msg],
    });
    if (queued.dropped > 0) {
      const i18nParams = { reason: 'queue_full' };
      return {
        content: sm('task.delivery_rejected', i18nParams),
        isError: true,
        metadata: {
          reason: 'queue_full',
          pending_count: queued.requeued,
          i18n: i18nMeta('task.delivery_rejected', i18nParams),
        },
      };
    }
    const fresh = await sessionManager.getSession(child.id);
    const pendingCount = fresh?.pendingMessages.length ?? queued.requeued;
    return {
      content: JSON.stringify({
        status: 'queued',
        child_session_id: child.id,
        pending_count: pendingCount,
      }),
      metadata: {
        status: 'queued',
        child_session_id: child.id,
        pending_count: pendingCount,
      },
    };
  }

  // `steer` (по умолчанию): инъекция в идущий ход ребёнка.
  // Шины может не быть (вне оркестратора) — доставка всё равно нужна,
  // события просто никому не уходят.
  const eventBus = extra.eventBus ?? new EventBus();
  const steered = await enqueueSteerMessage(
    sessionManager,
    eventBus,
    child.id,
    msg,
    MAX_STEER_INJECTIONS_PER_TURN,
  );
  if (!steered.accepted) {
    const i18nParams = { reason: 'steer_limit' };
    return {
      content: sm('task.delivery_rejected', i18nParams),
      isError: true,
      metadata: {
        reason: 'steer_limit',
        pending_count: steered.pending,
        i18n: i18nMeta('task.delivery_rejected', i18nParams),
      },
    };
  }
  return {
    content: JSON.stringify({
      status: 'steered',
      child_session_id: child.id,
      pending_count: steered.pending,
    }),
    metadata: {
      status: 'steered',
      child_session_id: child.id,
      pending_count: steered.pending,
    },
  };
}

/**
 * Проверка запрошенной пары `provider/model` при продолжении (PROP-142 §2).
 *
 * Порядок: каталог моделей инстанса (тот же загрузчик, что у нового прогона)
 * → пул провайдеров роутера. Каталога и роутера нет — проверку пропускаем
 * (резолвер провайдера прогона отработает штатно).
 */
async function validateContinuationPair(opts: {
  extra: TaskExtra;
  provider: string;
  model: string;
}): Promise<ToolResult | null> {
  const { extra, provider, model } = opts;
  if (extra.listModels) {
    let catalog: ModelConfig[] | null = null;
    try {
      catalog = await extra.listModels();
    } catch {
      catalog = null;
    }
    if (catalog) {
      const entry = catalog.find((m) => m.provider === provider && m.name === model);
      if (!entry || entry.enabled === false) {
        const available = catalog
          .filter((m) => m.enabled !== false)
          .map((m) => `${m.provider}/${m.name}`)
          .slice(0, MODEL_HINTS_LIMIT)
          .join(', ');
        const i18nParams = { provider, model, available };
        return {
          content: sm('task.model_not_in_catalog', i18nParams),
          isError: true,
          metadata: {
            available_models: available,
            i18n: i18nMeta('task.model_not_in_catalog', i18nParams),
          },
        };
      }
      return null;
    }
  }
  // Каталога нет — проверяем пулом провайдеров роутера. Пара родителя
  // доступна всегда (провайдер уже в руках).
  if (provider === extra.provider.name && model === extra.provider.model) return null;
  if (extra.modelRouter) {
    const resolved = getPoolProvider(
      extra.modelRouter,
      { providerName: provider, modelName: model, reason: 'explicit override', strategy: 'default' },
      undefined,
      undefined,
      undefined,
    );
    if (!resolved) {
      const i18nParams = { provider, model };
      return {
        content: sm('task.model_unavailable', i18nParams),
        isError: true,
        metadata: { i18n: i18nMeta('task.model_unavailable', i18nParams) },
      };
    }
  }
  return null;
}

/**
 * Фоновый запуск саб-агента (PROP-096): тул возвращает управление сразу.
 *
 * Порядок: регистрация в реестре фоновых прогонов (лимиты) → блокировка
 * дочерней сессии (`acquireLock` + `currentStream`) → cancel-токен в
 * оркестраторе → detached-прогон → немедленный возврат `tool_result`.
 *
 * Фоновый ребёнок **независим по сигналу** от родителя: свой `AbortController`
 * (сигнал родителя его не касается) и свой `streamId`. Отдельная отмена —
 * `POST /sessions/<child>/abort` либо `POST /processes/:id/stop`; «Стоп»
 * сессии-родителя останавливает и его (ADR-111 §detach п. 10, решение 2026-10-28).
 */
async function startBackgroundSubagent(opts: {
  params: TaskParams;
  runConfig: SubagentRunConfig;
  extra: TaskExtra;
  ctx: ToolContext;
}): Promise<ToolResult> {
  const { params, runConfig, extra, ctx } = opts;
  const service = extra.backgroundService;
  if (!service || extra.backgroundEnabled === false) {
    return {
      content: sm('task.background_disabled'),
      isError: true,
      metadata: { i18n: i18nMeta('task.background_disabled') },
    };
  }

  const parentSessionId = extra.sessionId;
  const childSessionId = runConfig.childSessionId;
  const sessionManager = extra.sessionManager;
  if (!parentSessionId || !childSessionId || !sessionManager) {
    // Без дочерней сессии фоновый прогон неотличим от обычного — отказ.
    return {
      content: sm('task.deps_unavailable'),
      isError: true,
      metadata: { i18n: i18nMeta('task.deps_unavailable') },
    };
  }

  // 1. Регистрация в реестре фоновых прогонов (лимиты — здесь).
  let record;
  try {
    record = await service.startSubagent({
      sessionId: parentSessionId,
      childSessionId,
      agentRole: params.subagent_type,
      description: params.description,
    });
  } catch (err) {
    if (err instanceof BackgroundLimitExceededError) {
      return {
        content: sm('task.background_limit', { limit: String(err.limit) }),
        isError: true,
        metadata: {
          background_run_limit: err.limitKind,
          i18n: i18nMeta('task.background_limit', { limit: String(err.limit) }),
        },
      };
    }
    throw err;
  }

  // 2. Собственный сигнал отмены и свой streamId фонового прогона.
  const backgroundAbort = new AbortController();
  const streamId = generateStreamId();
  const cancelToken: CancellationToken = {
    cancelled: false,
    cancel: () => {
      cancelToken.cancelled = true;
      backgroundAbort.abort();
    },
  };
  extra.registerCancelToken?.(streamId, cancelToken);
  // Хэндл отмены в реестре — остановка фонового прогона по его записи.
  service.registerAbort(record.id, () => backgroundAbort.abort());

  // 3. Блокировка дочерней сессии + маркер активности (`currentStream`) —
  //    по образцу `orchestrator.startSubagentResume`: так работает
  //    `POST /sessions/<child>/abort` и виден статус в UI.
  const processId = `background:${record.id}`;
  const acquired = await sessionManager.acquireLock(childSessionId, processId);
  if (!acquired) {
    extra.unregisterCancelToken?.(streamId);
    backgroundAbort.abort();
    await service.finish(record.id, { status: 'cancelled', summary: 'child session is busy' });
    return {
      content: sm('task.resume_child_busy', { id: childSessionId }),
      isError: true,
      metadata: { i18n: i18nMeta('task.resume_child_busy', { id: childSessionId }) },
    };
  }
  try {
    // Точечная метка активности: `withLock`+`saveSession` писал снимок целиком
    // и мог затереть параллельные точечные записи истории. `touchUpdatedAt:false`
    // — паритет: маркер служебный, время сессии ребёнка не двигается.
    await sessionManager.mutateMeta(childSessionId, (meta) => {
      meta.currentStream = {
        streamId,
        // ADR-118 §10: id хода в UI ребёнка (совпадает с `turn.started` цикла).
        turnId: childSessionId,
        message: params.description,
        agentRole: params.subagent_type,
        startedAt: nowISO(),
        cancelled: false,
        // Владелец маркера — процесс инстанса (recovery после рестарта).
        owner: sessionManager.instanceId,
      };
    }, { touchUpdatedAt: false });
  } catch {
    // Блокировка могла не записаться — прогон всё равно пойдёт, отмена
    // останется доступна через реестр (`stop`).
  }

  // 4. Detached-прогон: собственный контекст (сигнал отмены — свой), без
  //    публикации в родительский стрим (`publish` опционален в цикле).
  //    База — `extra` прогона: у новой задачи это `extra` вызывающего, у
  //    продолжения — настройки ребёнка (`permissionConfig`/`parentSessionSettings`).
  const detachedExtra: TaskExtra = {
    ...(runConfig.extra ?? extra),
    publish: undefined,
    streamId,
    // Сессия в extra остаётся **родительской** — по ней идут child.*-события.
    sessionId: parentSessionId,
    callId: extra.callId,
  };
  const detachedCtx: ToolContext = {
    ...ctx,
    messageId: streamId,
    abortSignal: backgroundAbort.signal,
  };

  void runSubagent({ ...runConfig, extra: detachedExtra, ctx: detachedCtx })
    .then(async (result) => {
      const stoppedByUser = result.metadata?.stopped_by === 'user';
      const status: 'completed' | 'failed' | 'cancelled' = result.isError
        ? 'failed'
        : stoppedByUser ? 'cancelled' : 'completed';
      const finalContent = typeof result.metadata?.final_content === 'string'
        ? (result.metadata.final_content as string)
        : '';
      const summary = status === 'completed'
        ? (finalContent || result.content)
        : status === 'cancelled'
          ? (typeof result.metadata?.partial_output === 'string' ? (result.metadata.partial_output as string) : '')
          : result.content;
      // ADR-039: итоговый список задач ребёнка — в запись реестра (метаданные
      // уходят в уведомление родителя и карточку прогона). Пустой — не передаём.
      const todos = Array.isArray(result.metadata?.todos)
        ? (result.metadata.todos as TodoItem[])
        : [];
      await service.finish(record.id, {
        status,
        summary,
        ...(todos.length > 0 ? { metadata: { todos } } : {}),
      });
    })
    .catch((err: unknown) => {
      void service.finish(record.id, { status: 'failed', summary: String(err) });
    })
    .finally(async () => {
      extra.unregisterCancelToken?.(streamId);
      try {
        // Снимаем только свой маркер (ADR-118 §10): прогон в этой сессии мог
        // уже начать новый ход с другим `streamId`. Условие — внутри мутатора
        // (решение по свежему документу), запись — только при реальном
        // изменении; `touchUpdatedAt:false` — маркер служебный.
        await sessionManager.mutateMeta(childSessionId, (meta) => {
          if (meta.currentStream && meta.currentStream.streamId !== streamId) return false;
          const changed = meta.currentStream !== undefined;
          meta.currentStream = undefined;
          return changed;
        }, { touchUpdatedAt: false, shouldWrite: (changed) => changed });
      } catch {
        // сессия могла быть удалена
      }
      try {
        await sessionManager.releaseLock(childSessionId, processId);
      } catch {
        // ignore
      }
    });

  // 5. Немедленный возврат: родитель продолжает работать, уведомление придёт.
  return {
    content: sm('task.background_started', { id: childSessionId }),
    metadata: {
      child_session_id: childSessionId,
      status: 'running',
      background_run_id: record.id,
      i18n: i18nMeta('task.background_started', { id: childSessionId }),
    },
  };
}
