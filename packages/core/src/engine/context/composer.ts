/**
 * AD-070 §2.1/§3.1: `SystemPromptComposer` — единственная точка сборки
 * системного промпта. Собирает блоки из состояния **идемпотентно** (заново, не
 * аппендит), сортирует по тирам (`stable` → `context` → `volatile`) и склеивает.
 *
 * Срез 3: режим/план/todo вынесены из system prompt в chronological-сообщения
 * (`state-messages.ts`); в system остаётся константная политика режимов
 * (`mode.policy`, stable) и `PLAN_GUIDE`.
 */

import type {
  AgentDefinition,
  Message,
  Project,
  PromptManifest,
  PromptManifestEntry,
  Session,
  StickyNote,
} from '@itphx/synth-shared';
import type { ContextBuilder } from './builder.js';
import type { ContextConfig } from './config.js';
import { joinPromptBlocks, sortPromptBlocks, type PromptBlock } from './prompt-blocks.js';
import { agentKeyOf } from './prompt-state.js';
import type { DebugCollector } from '../../debug.js';

/** Эвристика оценки токенов (AD-070 §2.5, открытый вопрос 4 — chars/4). */
const EST_TOKENS_DIVISOR = 4;

/** Человекочитаемые подписи блоков манифеста (UI локализует по `key`). */
const PROMPT_BLOCK_LABELS: Record<string, string> = {
  role: 'Role prompt',
  override: 'System prompt override',
  additional: 'Additional context',
  gateway: 'Gateway instructions',
  'plan.guide': 'Plan guide',
  'mode.policy': 'Mode policy',
  classification: 'Classification instruction',
  profile: 'User profile',
  'project.info': 'Project info',
  'session.info': 'Session info',
  sticky: 'Sticky notes',
  participants: 'Participants notice',
  summary: 'Compressed dialog',
  interview: 'Interview prompt',
  tools: 'Tool descriptions',
  'mcp.tools': 'MCP tools',
};

export interface ComposerContext {
  session: Session;
  /** Определение агента из реестра (AD-070 §2.7). */
  agentDef?: AgentDefinition;
  /** Эффективная роль агента (message.agentRole || session.settings.agentRole). */
  agentRole?: string;
  /** Файл контекста агента (contextFile). */
  agentContextFile?: string;
  workingDir: string;
  language: string;
  /** Для блока `[CLASSIFICATION]` (config-gate routingEnabled, AD-034). */
  routingEnabled: boolean;
  /** Для GATEWAY-инструкции (AD-036). */
  gatewayEnabled: boolean;
  historyMessages?: Message[];
  userId?: string;
  showInterview?: boolean;
  stickyNotes?: StickyNote[];
  summaryContent?: string;
  /**
   * AD-070 §2.5 + AD-071 §2.1: описания **встроенных** инструментов, реально
   * уходящие в запрос (слой `tools`, stable). Учитываются только в манифесте
   * (`tools → system → messages`), в system-текст `compose()` не входят.
   */
  tools?: Array<Record<string, unknown>>;
  /**
   * AD-071 §2.1: описания MCP-инструментов активных серверов сессии (слой
   * `mcp.tools`, volatile). В system-текст не входят; входят в `totalChars`, но
   * не в `staticPrefixChars` (MCP не кэшируется).
   */
  mcpTools?: Array<Record<string, unknown>>;
  /**
   * AD-070 §2.5: per-message `DebugCollector`. Передаётся оркестратором на
   * каждый ход и имеет приоритет над `deps.debugCollector` (сборка промпта —
   * общая точка, а коллектор живёт в рамках одного сообщения).
   */
  debugCollector?: DebugCollector;
}

export interface ComposedPrompt {
  /** Полный текст (stable + context + volatile). */
  system: string;
  /** Закреплённые байты кэшируемого префикса — только stable-блоки. */
  stablePrefix: string;
  /** Все блоки (включая пустые — `content === ''` не отправляется). */
  blocks: PromptBlock[];
}

export interface SystemPromptComposerDeps {
  contextBuilder: ContextBuilder;
  contextConfig?: ContextConfig | null;
  projectStore?: { load(id: string): Promise<Project | null> } | null;
  debugCollector?: DebugCollector;
}

export class SystemPromptComposer {
  private readonly _contextBuilder: ContextBuilder;
  private readonly _contextConfig: ContextConfig | null;
  private readonly _projectStore: { load(id: string): Promise<Project | null> } | null;
  private readonly _debug: DebugCollector | undefined;

  constructor(deps: SystemPromptComposerDeps) {
    this._contextBuilder = deps.contextBuilder;
    this._contextConfig = deps.contextConfig ?? null;
    this._projectStore = deps.projectStore ?? null;
    this._debug = deps.debugCollector;
  }

  /**
   * Идемпотентно собирает промпт из состояния. Повторный вызов при том же
   * состоянии возвращает побайтово тот же результат; блоки не дописываются.
   */
  async compose(ctx: ComposerContext): Promise<ComposedPrompt> {
    const blocks = await this._collectBlocks(ctx);
    const system = joinPromptBlocks(sortPromptBlocks(blocks));
    const stablePrefix = joinPromptBlocks(
      sortPromptBlocks(blocks.filter((block) => block.tier === 'stable')),
    );

    const debug = ctx.debugCollector ?? this._debug;
    if (debug) {
      debug.captureSystemPromptParts({
        blocks: blocks.map((block) => ({
          key: block.key,
          tier: block.tier,
          chars: block.content.length,
        })),
        stablePrefixChars: stablePrefix.length,
        systemChars: system.length,
      });
    }

    return { system, stablePrefix, blocks };
  }

  /**
   * AD-070 §2.5: манифест состава промпта. Использует тот же обход
   * источников, что и `compose()`, но **без побочных эффектов**: не вызывает
   * `captureSystemPromptParts` и не пишет состояние. Размеры блоков считаются
   * без разделителей `\n\n`, поэтому тест паритета сравнивает сумму `chars`
   * с длинами блоков (и учитывает разделители отдельно). Запись `tools`
   * (`source: 'tools'`) описывает слой инструментов и в system-блоки
   * `compose()` не входит.
   */
  async manifest(ctx: ComposerContext): Promise<PromptManifest> {
    const blocks = await this._collectBlocks(ctx);

    // AD-070 §2.5: порядок записей = реальный порядок отправки system-блоков
    // (`sortPromptBlocks`: тир → order), тот же, что в `compose().system`.
    const entries: PromptManifestEntry[] = sortPromptBlocks(blocks).map((block) => ({
      key: block.key,
      label: PROMPT_BLOCK_LABELS[block.key] ?? block.key,
      tier: block.tier,
      order: block.order,
      chars: block.content.length,
      estTokens: Math.ceil(block.content.length / EST_TOKENS_DIVISOR),
      status: block.content === '' ? 'empty' : 'loaded',
      source: 'system',
      ...(block.provenance ? { provenance: block.provenance } : {}),
    }));

    // AD-070 §2.5 + AD-071 §2.1: слои описаний инструментов — отдельные записи
    // (`tools → mcp.tools → system → messages`). В system-текст (`compose`) не
    // входят, но отражаются в манифесте и учитываются в общих размерах.
    //  - `tools` (встроенные) — `stable`, входит в staticPrefix;
    //  - `mcp.tools` (MCP активных серверов) — `volatile`, в staticPrefix НЕ входит.
    // `tools` вставляется в конце тира `stable` (перед первой `context`-записью):
    // это самый ранний кэшируемый слой. `mcp.tools` — сразу после `tools`.
    // `role` при этом остаётся первой записью.
    const toolsChars = ctx.tools && ctx.tools.length > 0 ? JSON.stringify(ctx.tools).length : 0;
    const mcpToolsChars = ctx.mcpTools && ctx.mcpTools.length > 0 ? JSON.stringify(ctx.mcpTools).length : 0;
    const toolsEntry: PromptManifestEntry = {
      key: 'tools',
      label: PROMPT_BLOCK_LABELS.tools ?? 'Tool descriptions',
      tier: 'stable',
      chars: toolsChars,
      estTokens: Math.ceil(toolsChars / EST_TOKENS_DIVISOR),
      status: toolsChars === 0 ? 'empty' : 'loaded',
      provenance: 'tools',
      source: 'tools',
    };
    const mcpToolsEntry: PromptManifestEntry = {
      key: 'mcp.tools',
      label: PROMPT_BLOCK_LABELS['mcp.tools'] ?? 'MCP tools',
      tier: 'volatile',
      chars: mcpToolsChars,
      estTokens: Math.ceil(mcpToolsChars / EST_TOKENS_DIVISOR),
      status: mcpToolsChars === 0 ? 'empty' : 'loaded',
      provenance: 'mcp.tools',
      source: 'mcp.tools',
    };
    // `entries` отсортированы `sortPromptBlocks` (tier → order), поэтому все
    // stable-записи занимают префикс [0, stableCount); вставка по индексу
    // stableCount ставит `tools` сразу после последней stable-записи, `mcp.tools`
    // — следом. При отсутствии stable-записей — в начало (индекс 0).
    const stableCount = entries.filter((entry) => entry.tier === 'stable').length;
    entries.splice(stableCount, 0, toolsEntry);
    entries.splice(stableCount + 1, 0, mcpToolsEntry);

    const nonEmpty = blocks.filter((block) => block.content !== '');
    const totalChars =
      nonEmpty.reduce((sum, block) => sum + block.content.length, 0) + toolsChars + mcpToolsChars;
    // AD-071 §2.1: MCP-инструменты (volatile) не входят в кэшируемый stable-префикс.
    const staticPrefixChars =
      nonEmpty
        .filter((block) => block.tier === 'stable')
        .reduce((sum, block) => sum + block.content.length, 0) + toolsChars;

    const agentRole = ctx.agentRole ?? ctx.agentDef?.id ?? ctx.session.settings.agentRole;
    const generation = ctx.session.promptStates?.[agentKeyOf(agentRole)]?.generation;

    return {
      ...(generation != null ? { generation } : {}),
      totalChars,
      estTokens: Math.ceil(totalChars / EST_TOKENS_DIVISOR),
      staticPrefixChars,
      entries,
    };
  }

  /**
   * Общий обход источников для `compose()` и `manifest()`: базовые блоки из
   * ContextBuilder + блоки Composer (gateway/plan.guide/mode.policy/
   * classification/session.info). Возвращает блоки в порядке добавления
   * (сортировка по тирам — на вызывающей стороне).
   */
  private async _collectBlocks(ctx: ComposerContext): Promise<PromptBlock[]> {
    const session = ctx.session;
    const lang = ctx.language || session.settings.language || 'ru';
    const agentRole = ctx.agentRole ?? ctx.agentDef?.id ?? session.settings.agentRole;
    const agentContextFile = ctx.agentContextFile ?? ctx.agentDef?.contextFile;

    // 1. Базовые блоки (role/additional/profile/project/sticky/participants/
    //    summary/interview) — из ContextBuilder. `session.settings.systemPrompt`
    //    override заменяет базу целиком (сохранение семантики среза 1).
    const override = session.settings.systemPrompt?.trim();
    const baseBlocks: PromptBlock[] = override
      ? [{ key: 'override', tier: 'stable', order: 5, content: override, provenance: 'session.settings.systemPrompt' }]
      : await this._contextBuilder.buildBaseBlocks({
          agentRole,
          agentContextFile,
          historyMessages: ctx.historyMessages,
          userId: ctx.userId,
          projectName: session.projectId,
          language: lang,
          showInterview: ctx.showInterview,
          stickyNotes: ctx.stickyNotes,
          summaryContent: ctx.summaryContent,
        });

    // Проект загружается один раз для session.info.
    let project: Project | null = null;
    if (session.projectId && this._projectStore) {
      try {
        project = await this._projectStore.load(session.projectId);
      } catch {
        project = null;
      }
    }

    const extraBlocks: PromptBlock[] = [];

    // AD-036: инструкция по обфусцированным секретам (stable).
    if (ctx.gatewayEnabled) {
      extraBlocks.push({
        key: 'gateway',
        tier: 'stable',
        order: 30,
        content: this._getGatewayInstructions(lang),
        provenance: 'prompts/system/GATEWAY',
      });
    }

    // AD-039: постоянная инструкция по ведению плана/todo (stable).
    extraBlocks.push({
      key: 'plan.guide',
      tier: 'stable',
      order: 40,
      content: this._contextConfig?.getPlanGuide(lang) ?? '',
      provenance: 'prompts/system/PLAN_GUIDE',
    });

    // AD-070 §3.1 (строка 5): политика режимов — константа сессии (stable).
    // Режим/план/todo передаются chronological-сообщениями (state-messages.ts),
    // а не блоками system, поэтому смена режима не инвалидирует stable-префикс.
    extraBlocks.push({
      key: 'mode.policy',
      tier: 'stable',
      order: 45,
      content: this._contextConfig?.getModePolicy(lang) ?? '',
      provenance: 'prompts/system/MODE_POLICY',
    });

    // AD-034: инструкция classify_conversation — config-gate routingEnabled (volatile).
    if (ctx.routingEnabled) {
      extraBlocks.push({
        key: 'classification',
        tier: 'volatile',
        order: 80,
        content: this._classificationInstruction(lang),
        provenance: 'inline',
      });
    }

    // AD-040: информация о сессии — проект/рабочий каталог/ограничения (context).
    extraBlocks.push({
      key: 'session.info',
      tier: 'context',
      order: 30,
      content: this._buildSessionContext(session, ctx.workingDir, project, lang),
      provenance: session.projectId ? `projects/${session.projectId}` : 'session.info',
    });

    return [...baseBlocks, ...extraBlocks];
  }

  /**
   * AD-036: GATEWAY-инструкция. Приоритет — ContextConfig; если он не передан,
   * используется делегирующий метод ContextBuilder (сохранение поведения).
   */
  private _getGatewayInstructions(lang: string): string {
    const fromConfig = this._contextConfig?.getGatewayInstructions(lang);
    if (fromConfig) return fromConfig;
    const builder = this._contextBuilder as unknown as {
      getGatewayInstructions?: (language: string) => string;
    };
    return typeof builder.getGatewayInstructions === 'function'
      ? builder.getGatewayInstructions(lang)
      : '';
  }

  /** AD-034: inline-инструкция классификации (ru/en), перенесена из оркестратора. */
  private _classificationInstruction(lang: string): string {
    return lang === 'ru'
      ? '[CLASSIFICATION]\n\nКогда определишь характер задачи, вызови инструмент `classify_conversation` с категорией: coding (написание/изменение кода), research (анализ/исследование), или chat (общий разговор). Это поможет выбрать оптимальную модель для последующих запросов.'
      : '[CLASSIFICATION]\n\nWhen you determine the nature of the task, call the `classify_conversation` tool with the category: coding (writing/modifying code), research (analysis/investigation), or chat (general conversation). This helps select the optimal model for subsequent requests.';
  }

  /**
   * AD-040: блок «информация о сессии» — наличие/отсутствие проекта, рабочий
   * каталог и ограничения. Перенесён из `ChatOrchestrator._buildSessionContextPrompt`.
   */
  private _buildSessionContext(
    session: Session,
    workingDir: string,
    project: Project | null,
    lang: string,
  ): string {
    const lines: string[] = [];

    if (session.projectId) {
      if (project) {
        lines.push('[ИНФОРМАЦИЯ О СЕССИИ]');
        lines.push(`Проект: ${project.name}`);
        lines.push(`ID проекта: ${session.projectId}`);
        lines.push(`Рабочий каталог: ${project.workspace || workingDir}`);

        const invariants = project.invariants?.trim();
        if (invariants) {
          lines.push('');
          lines.push(lang === 'en' ? '[PROJECT INVARIANTS]' : '[ИНВАРИАНТЫ ПРОЕКТА]');
          lines.push(project.invariants);
        }
      } else {
        lines.push('[ИНФОРМАЦИЯ О СЕССИИ]');
        lines.push(`Проект: не найден (id: ${session.projectId})`);
        lines.push(`Рабочий каталог: ${workingDir}`);
      }
    } else if (lang === 'en') {
      lines.push('[SESSION INFO]');
      lines.push('Project: none');
      lines.push(`Working directory: ${workingDir}`);
      lines.push(
        'Limitations: a plan is unavailable (the plan is bound to a project). '
        + 'File and git tools operate within the working directory. Todo is available.',
      );
      lines.push(
        'If the task requires long-term work with files, git, or a plan — suggest that the user '
        + 'create a project and move the session into it.',
      );
    } else {
      lines.push('[ИНФОРМАЦИЯ О СЕССИИ]');
      lines.push('Проект: отсутствует');
      lines.push(`Рабочий каталог: ${workingDir}`);
      lines.push(
        'Ограничения: план недоступен (план привязан к проекту). '
        + 'Файловые и git-инструменты работают в рамках рабочего каталога. Todo доступен.',
      );
      lines.push(
        'Если задача требует длительной работы с файлами, git или планом — предложи пользователю '
        + 'создать проект и перенести сессию в него.',
      );
    }

    return lines.join('\n');
  }
}
