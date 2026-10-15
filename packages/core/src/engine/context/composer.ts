/**
 * ADR-070 §2.1/§3.1: `SystemPromptComposer` — единственная точка сборки
 * системного промпта. Собирает блоки из состояния **идемпотентно** (заново, не
 * аппендит), сортирует по тирам (`stable` → `context` → `volatile`) и склеивает.
 *
 * Срез 3: режим/план/todo вынесены из system prompt в chronological-сообщения
 * (`state-messages.ts`); в system остаётся константная политика режимов
 * (`mode.policy`, stable) и `PLAN_GUIDE`.
 */

import type {
  AgentDefinition,
  McpDisabledReason,
  McpServerLevel,
  Message,
  Project,
  PromptManifest,
  PromptManifestEntry,
  PromptManifestStatus,
  PromptTier,
  Session,
  StickyNote,
  ToolsPolicy,
} from '@itphx/synth-shared';
import type { ContextBuilder } from './builder.js';
import type { ContextConfig } from './config.js';
import { joinPromptBlocks, sortPromptBlocks, type PromptBlock } from './prompt-blocks.js';
import { formatSkillsCatalogBlock, type ComposerSkillsCatalog } from '../skills/catalog.js';
import { agentKeyOf } from './prompt-state.js';
import { RUNTIME_DEP_BINARY, type RuntimeDeps } from '../tools/runtime-deps.js';
import type { DebugCollector } from '../../debug.js';

/** Эвристика оценки токенов (ADR-070 §2.5, открытый вопрос 4 — chars/4). */
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
  instructions: 'Project instructions',
  scheduler: 'Scheduler notice',
  'scheduler.turn': 'Scheduler current turn',
  'session.info': 'Session info',
  sticky: 'Sticky notes',
  participants: 'Participants notice',
  summary: 'Compressed dialog',
  interview: 'Interview prompt',
  tools: 'Tool descriptions',
  'tools.guide': 'Tools guide',
  'mcp.tools': 'MCP tools',
  'mcp.servers': 'MCP servers',
  'mcp.status': 'MCP status',
  'skills.catalog': 'Skills catalog',
  'skills.catalog.session': 'Session skills',
};

/** ADR-071 §2.6: есть ли непустые административные отключения инструментов. */
export function hasAdminDisabled(
  disabled?: { capabilities: string[]; tools: string[] },
): boolean {
  return !!disabled && (disabled.capabilities.length > 0 || disabled.tools.length > 0);
}

/** ADR-070 §2.9.1: есть ли отсутствующие во внешнем окружении зависимости. */
export function hasMissingDeps(deps?: RuntimeDeps): boolean {
  return !!deps && (deps.git === false || deps.rg === false || deps.sh === false);
}

/** Список отсутствующих программ (`git`, `rg (ripgrep)`, `sh`) для текста промпта. */
function missingDepsList(deps?: RuntimeDeps): string[] {
  if (!deps) return [];
  const out: string[] = [];
  if (deps.git === false) out.push(RUNTIME_DEP_BINARY.git);
  if (deps.rg === false) out.push(RUNTIME_DEP_BINARY.rg);
  if (deps.sh === false) out.push(RUNTIME_DEP_BINARY.sh);
  return out;
}

/** ADR-071 §2.2: статус MCP-сервера в блоке `mcp.status`. */
export type ComposerMcpServerStatus = 'connected' | 'error' | 'disabled' | 'circuit-open';

/** ADR-071 §2.2: инструмент MCP-сервера в блоке `mcp.servers` (без схемы параметров). */
export interface ComposerMcpServerTool {
  name: string;
  description?: string;
}

/**
 * ADR-071 §2.2: данные MCP-сервера для промпта. Собираются вызывающей стороной
 * (оркестратором) из `McpManager` + активного набора сессии; Composer не знает
 * про MCP и работает только с этой моделью.
 */
export interface ComposerMcpServer {
  name: string;
  /** Описание из конфига (заполняется человеком). */
  description?: string;
  /** `instructions` из MCP initialize. */
  instructions?: string;
  tools: ComposerMcpServerTool[];
  status: ComposerMcpServerStatus;
  /** ADR-071 §2.4: уровень сервера (`system`/`project`/`session`). */
  level?: McpServerLevel;
  /**
   * ADR-071 §2.2: причина `disabled` — конфиг, opt-out сессии, проектный
   * default или отсутствие `enabledByDefault`. `'session'` оставлен для
   * обратной совместимости с прежним значением.
   */
  disabledReason?: McpDisabledReason | 'session';
}

/**
 * ADR-069 §3.3/§11: результат резолва проектных инструкций для блока
 * `instructions` (тир `context`, order 15). Резолвит оркестратор (нужны
 * workspace/модель), Composer только вставляет блок.
 */
export interface ComposerInstructions {
  content: string;
  provenance?: string;
  /** Статус манифеста (`truncated`/`loaded`/…); не задан — из `content`. */
  status?: PromptManifestStatus;
}

export interface ComposerContext {
  session: Session;
  /** Определение агента из реестра (ADR-070 §2.7). */
  agentDef?: AgentDefinition;
  /** Эффективная роль агента (message.agentRole || session.settings.agentRole). */
  agentRole?: string;
  /** Файл контекста агента (contextFile). */
  agentContextFile?: string;
  workingDir: string;
  language: string;
  /** Для блока `[CLASSIFICATION]` (config-gate routingEnabled, ADR-034). */
  routingEnabled: boolean;
  /** Для GATEWAY-инструкции (ADR-036). */
  gatewayEnabled: boolean;
  historyMessages?: Message[];
  userId?: string;
  showInterview?: boolean;
  /**
   * Интервью уместно в этом ходе (первое сообщение сессии от пользователя).
   * Вычисляет оркестратор; прокидывается в `buildBaseBlocks`.
   */
  interviewEligible?: boolean;
  stickyNotes?: StickyNote[];
  summaryContent?: string;
  /**
   * ADR-071 §2.4: уже загруженный проект сессии (носитель project-скоупа MCP
   * и данных `session.info`). Если задан (в т.ч. `null`) — Composer не читает
   * хранилище повторно; иначе — fallback на `projectStore.load`.
   */
  project?: Project | null;
  /**
   * ADR-070 §2.5 + ADR-071 §2.1: описания **встроенных** инструментов, реально
   * уходящие в запрос (слой `tools`, stable). Учитываются только в манифесте
   * (`tools → system → messages`), в system-текст `compose()` не входят.
   */
  tools?: Array<Record<string, unknown>>;
  /**
   * ADR-071 §2.3: фактически применённая политика **встроенных** инструментов
   * (`auto` уже разрешён вызывающей стороной в `consistency`/`available`).
   * Влияет на тир слоя `tools` и текст инструкции `tools.guide`.
   */
  toolsPolicy?: Exclude<ToolsPolicy, 'auto'>;
  /**
   * ADR-071 §2.3: фактически применённая политика **MCP**-инструментов (`auto`
   * уже разрешён). Независима от `toolsPolicy`; влияет на текст инструкции
   * `tools.guide`, но не на тиры MCP-блоков (они всегда `volatile`).
   */
  mcpPolicy?: Exclude<ToolsPolicy, 'auto'>;
  /**
   * ADR-071 §2.1: описания MCP-инструментов активных серверов сессии (слой
   * `mcp.tools`, volatile). В system-текст не входят; входят в `totalChars`, но
   * не в `staticPrefixChars` (MCP не кэшируется).
   */
  mcpTools?: Array<Record<string, unknown>>;
  /**
   * ADR-071 §2.2: данные MCP-серверов (все настроенные, включая отключённые).
   * Формируют блоки `mcp.servers` (имя/description/instructions/тулы) и
   * `mcp.status` (статус подключения) — оба **всегда `volatile`** (§2.3: MCP не
   * кэшируется). Пустой/отсутствующий список — блоки не добавляются.
   */
  mcpServers?: ComposerMcpServer[];
  /**
   * ADR-046 §4.5/§5: каталог скиллов — `stable` (system/project, доступные) и
   * `session` (session enable/disable + маркеры `unavailable`). Тело скиллов в
   * промпт не попадает (progressive disclosure). При `systemPrompt`-override
   * каталог не добавляется (§5).
   */
  skillsCatalog?: ComposerSkillsCatalog;
  /**
   * ADR-069 §2.1/§3: проектные инструкции (merged chain `AGENTS.md`), тир
   * `context`, order 15 (после `profile`, до `project.info`). Не добавляются
   * при `session.settings.systemPrompt` override (как `skills.catalog`).
   */
  instructions?: ComposerInstructions;
  /**
   * ADR-051: в сессии активно расписание (`cron`-источник) — добавляет
   * статическое описание системного пользователя `Scheduler` (блок `scheduler`,
   * тир `context`). При `session.settings.systemPrompt` override не добавляется.
   */
  schedulerActive?: boolean;
  /**
   * ADR-051: текущий ход инициирован планировщиком (`metadata.scheduler === true`).
   * Добавляет volatile-блок `scheduler.turn` — пояснение модели, что человек в
   * этом ходе не участвует.
   */
  schedulerCurrentTurn?: boolean;
  /**
   * ADR-071 §2.6: instance-wide отключение инструментов администратором
   * (`tools.disabled`). Непустой список добавляет в `tools.guide` строку про
   * административные ограничения (даже в режиме `consistency`).
   */
  adminDisabled?: { capabilities: string[]; tools: string[] };
  /**
   * ADR-070 §2.9.1: доступность внешних программ окружения (git/rg/sh). Непустой
   * список отсутствующих добавляет в `tools.guide` строку про зависимость
   * окружения (даже в режиме `consistency`).
   */
  envDeps?: RuntimeDeps;
  /**
   * ADR-071 §2.6: chars-per-token для оценки `estTokens` (калибровка по usage).
   * Не задан — дефолт 4.
   */
  tokenRatio?: number;
  /**
   * ADR-070 §2.5: per-message `DebugCollector`. Передаётся оркестратором на
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
   * ADR-070 §2.5: манифест состава промпта. Использует тот же обход
   * источников, что и `compose()`, но **без побочных эффектов**: не вызывает
   * `captureSystemPromptParts` и не пишет состояние. Размеры блоков считаются
   * без разделителей `\n\n`, поэтому тест паритета сравнивает сумму `chars`
   * с длинами блоков (и учитывает разделители отдельно). Запись `tools`
   * (`source: 'tools'`) описывает слой инструментов и в system-блоки
   * `compose()` не входит.
   */
  async manifest(ctx: ComposerContext): Promise<PromptManifest> {
    const blocks = await this._collectBlocks(ctx);
    // ADR-071 §2.6: chars-per-token для оценки (калибровка per-model).
    const ratio = ctx.tokenRatio && ctx.tokenRatio > 0 ? ctx.tokenRatio : EST_TOKENS_DIVISOR;

    // ADR-070 §2.5: порядок записей = реальный порядок отправки system-блоков
    // (`sortPromptBlocks`: тир → order), тот же, что в `compose().system`.
    const entries: PromptManifestEntry[] = sortPromptBlocks(blocks).map((block) => ({
      key: block.key,
      label: PROMPT_BLOCK_LABELS[block.key] ?? block.key,
      tier: block.tier,
      order: block.order,
      chars: block.content.length,
      estTokens: Math.ceil(block.content.length / ratio),
      status: block.status ?? (block.content === '' ? 'empty' : 'loaded'),
      source: 'system',
      ...(block.provenance ? { provenance: block.provenance } : {}),
    }));

    // ADR-070 §2.5 + ADR-071 §2.1/§2.3: слои описаний инструментов — отдельные
    // записи (`tools → mcp.servers → mcp.tools → mcp.status → system → messages`).
    // В system-текст (`compose`) `tools`/`mcp.tools` не входят, но отражаются в
    // манифесте и учитываются в общих размерах.
    //  - `tools` (встроенные) — `stable` в `consistency`, `context` в `available`
    //    (состав зависит от режима/роли); в staticPrefix входит только в stable;
    //  - `mcp.tools` (MCP активных серверов) — `volatile`, в staticPrefix НЕ входит.
    // `tools` вставляется в конце своего тира (перед записями более поздних
    // тиров), `mcp.tools` — сразу после блока `mcp.servers` (или после `tools`,
    // если серверов нет), чтобы MCP-регион шёл после встроенных инструментов.
    // `role` остаётся первой записью.
    const toolsPolicy = ctx.toolsPolicy ?? 'consistency';
    const mcpPolicy = ctx.mcpPolicy ?? 'consistency';
    const toolsTier: PromptTier = toolsPolicy === 'available' ? 'context' : 'stable';
    const toolsChars = ctx.tools && ctx.tools.length > 0 ? JSON.stringify(ctx.tools).length : 0;
    const mcpToolsChars = ctx.mcpTools && ctx.mcpTools.length > 0 ? JSON.stringify(ctx.mcpTools).length : 0;
    const toolsEntry: PromptManifestEntry = {
      key: 'tools',
      label: PROMPT_BLOCK_LABELS.tools ?? 'Tool descriptions',
      tier: toolsTier,
      chars: toolsChars,
      estTokens: Math.ceil(toolsChars / ratio),
      status: toolsChars === 0 ? 'empty' : 'loaded',
      provenance: 'tools',
      source: 'tools',
    };
    const mcpToolsEntry: PromptManifestEntry = {
      key: 'mcp.tools',
      label: PROMPT_BLOCK_LABELS['mcp.tools'] ?? 'MCP tools',
      tier: 'volatile',
      chars: mcpToolsChars,
      estTokens: Math.ceil(mcpToolsChars / ratio),
      status: mcpToolsChars === 0 ? 'empty' : 'loaded',
      provenance: 'mcp.tools',
      source: 'mcp.tools',
    };
    // `entries` отсортированы `sortPromptBlocks` (tier → order). Вставляем `tools`
    // после всех записей своего и более ранних тиров (в конец своего тира),
    // `mcp.tools` — сразу после `mcp.servers` (MCP-регион: servers → tools →
    // status), либо сразу после `tools`, если серверов нет. `role` — первая.
    const tierRank: Record<PromptTier, number> = { stable: 0, context: 1, volatile: 2 };
    const toolsInsertIndex = entries.filter((entry) => tierRank[entry.tier] <= tierRank[toolsTier]).length;
    entries.splice(toolsInsertIndex, 0, toolsEntry);
    const mcpServersIndex = entries.findIndex((entry) => entry.key === 'mcp.servers');
    const mcpToolsInsertIndex = mcpServersIndex >= 0 ? mcpServersIndex + 1 : toolsInsertIndex + 1;
    entries.splice(mcpToolsInsertIndex, 0, mcpToolsEntry);

    const nonEmpty = blocks.filter((block) => block.content !== '');
    const totalChars =
      nonEmpty.reduce((sum, block) => sum + block.content.length, 0) + toolsChars + mcpToolsChars;
    // ADR-071 §2.1/§2.3: MCP-блоки (`mcp.servers`/`mcp.tools`/`mcp.status`) всегда
    // volatile и в кэшируемый stable-префикс не входят; `tools` в режиме
    // `available` (context) — тоже.
    const staticPrefixChars =
      nonEmpty
        .filter((block) => block.tier === 'stable')
        .reduce((sum, block) => sum + block.content.length, 0)
      + (toolsTier === 'stable' ? toolsChars : 0);

    const agentRole = ctx.agentRole ?? ctx.agentDef?.id ?? ctx.session.settings.agentRole;
    const generation = ctx.session.promptStates?.[agentKeyOf(agentRole)]?.generation;

    return {
      ...(generation != null ? { generation } : {}),
      totalChars,
      estTokens: Math.ceil(totalChars / ratio),
      staticPrefixChars,
      toolsPolicy,
      mcpPolicy,
      // ADR-071 §2.6: применённый chars-per-token — признак оценочности.
      ratio,
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
          interviewEligible: ctx.interviewEligible,
          stickyNotes: ctx.stickyNotes,
          summaryContent: ctx.summaryContent,
        });

    // Проект: используем уже загруженный вызывающей стороной (ADR-071 §2.4);
    // `projectStore` — fallback при отсутствии переданного значения.
    let project: Project | null;
    if (ctx.project !== undefined) {
      project = ctx.project;
    } else {
      project = null;
      if (session.projectId && this._projectStore) {
        try {
          project = await this._projectStore.load(session.projectId);
        } catch {
          project = null;
        }
      }
    }

    const extraBlocks: PromptBlock[] = [];

    // ADR-036: инструкция по обфусцированным секретам (stable).
    if (ctx.gatewayEnabled) {
      extraBlocks.push({
        key: 'gateway',
        tier: 'stable',
        order: 30,
        content: this._getGatewayInstructions(lang),
        provenance: 'prompts/system/GATEWAY',
      });
    }

    // ADR-039: постоянная инструкция по ведению плана/todo (stable).
    extraBlocks.push({
      key: 'plan.guide',
      tier: 'stable',
      order: 40,
      content: this._contextConfig?.getPlanGuide(lang) ?? '',
      provenance: 'prompts/system/PLAN_GUIDE',
    });

    // ADR-070 §3.1 (строка 5): политика режимов — константа сессии (stable).
    // Режим/план/todo передаются chronological-сообщениями (state-messages.ts),
    // а не блоками system, поэтому смена режима не инвалидирует stable-префикс.
    extraBlocks.push({
      key: 'mode.policy',
      tier: 'stable',
      order: 45,
      content: this._contextConfig?.getModePolicy(lang) ?? '',
      provenance: 'prompts/system/MODE_POLICY',
    });

    // ADR-046 §5: каталог скиллов — только name + краткое description
    // (progressive disclosure). `stable` — system/project-скиллы (константа
    // сессии), `session` — session enable/disable и маркеры `unavailable`.
    // При `session.settings.systemPrompt` override каталог не добавляется.
    if (!override && ctx.skillsCatalog) {
      const skillsStable = formatSkillsCatalogBlock(ctx.skillsCatalog.stable, lang, 'stable');
      if (skillsStable) {
        extraBlocks.push({
          key: 'skills.catalog',
          tier: 'stable',
          order: 35,
          content: skillsStable,
          provenance: 'skills.catalog',
        });
      }
      const skillsSession = formatSkillsCatalogBlock(ctx.skillsCatalog.session, lang, 'session');
      if (skillsSession) {
        extraBlocks.push({
          key: 'skills.catalog.session',
          tier: 'volatile',
          order: 55,
          content: skillsSession,
          provenance: 'skills.catalog.session',
        });
      }
    }

    // ADR-069 §2.1/§3: проектные инструкции (merged chain AGENTS.md) — тир
    // `context`, order 15 (после `profile`(10), до `project.info`(20)).
    // При `session.settings.systemPrompt` override не добавляются (как каталог
    // скиллов): override заменяет систему целиком.
    if (!override && ctx.instructions?.content) {
      extraBlocks.push({
        key: 'instructions',
        tier: 'context',
        order: 15,
        content: ctx.instructions.content,
        provenance: ctx.instructions.provenance ?? 'instructions',
        ...(ctx.instructions.status ? { status: ctx.instructions.status } : {}),
      });
    }

    // ADR-051: в сессии активно расписание (`cron`) — статическое описание
    // системного пользователя `Scheduler` (тир `context`, order 16, после
    // instructions). При `systemPrompt` override не добавляется (как
    // instructions/каталог скиллов). Пустой ассет — блок не добавляется.
    if (!override && ctx.schedulerActive) {
      const schedulerNotice = this._contextConfig?.getSchedulerNotice(lang) ?? '';
      if (schedulerNotice) {
        extraBlocks.push({
          key: 'scheduler',
          tier: 'context',
          order: 16,
          content: schedulerNotice,
          provenance: 'prompts/system/SCHEDULER',
        });
      }
    }

    // ADR-051: текущий ход инициирован планировщиком — volatile-пояснение, что
    // человек в этом ходе не участвует (в отличие от статического `scheduler`,
    // описывающего самого системного пользователя). При `systemPrompt` override
    // не добавляется (как прочие Composer-блоки).
    if (!override && ctx.schedulerCurrentTurn) {
      const turnNotice = this._contextConfig?.getSchedulerTurnNotice(lang) ?? '';
      if (turnNotice) {
        extraBlocks.push({
          key: 'scheduler.turn',
          tier: 'volatile',
          order: 40,
          content: turnNotice,
          provenance: 'prompts/system/SCHEDULER_TURN',
        });
      }
    }

    // ADR-071 §2.2/§2.3: MCP-блоки всегда volatile — MCP не участвует в
    // prompt-cache (состав динамичен: серверы включаются/выключаются, статус
    // меняется), поэтому ни `mcp.servers`, ни `mcp.status` не должны попадать
    // в stable-префикс. Политики `tools.policy`/`mcp.policy` на тир не влияют.
    if (ctx.mcpServers && ctx.mcpServers.length > 0) {
      extraBlocks.push({
        key: 'mcp.servers',
        tier: 'volatile',
        order: 50,
        content: this._buildMcpServersBlock(ctx.mcpServers, lang),
        provenance: 'mcp.servers',
      });
      extraBlocks.push({
        key: 'mcp.status',
        tier: 'volatile',
        order: 70,
        content: this._buildMcpStatusBlock(ctx.mcpServers, lang),
        provenance: 'mcp.status',
      });
    }

    // ADR-071 §2.3/§2.6 + ADR-070 §2.9.1: блок добавляется, если **любая** из
    // политик сужает состав до доступных (`available` — встроенные и/или MCP),
    // и/или есть instance-wide отключения администратора (`tools.disabled`),
    // и/или в окружении отсутствуют программы (`git`/`rg`/`sh`) — тогда модель
    // предупреждена об ограничениях даже в `consistency`.
    const toolsRestricted = (ctx.toolsPolicy ?? 'consistency') === 'available';
    const mcpRestricted = (ctx.mcpPolicy ?? 'consistency') === 'available';
    if (
      toolsRestricted
      || mcpRestricted
      || hasAdminDisabled(ctx.adminDisabled)
      || hasMissingDeps(ctx.envDeps)
    ) {
      extraBlocks.push({
        key: 'tools.guide',
        tier: 'context',
        order: 25,
        content: this._buildToolsGuideBlock(
          lang,
          { builtin: toolsRestricted, mcp: mcpRestricted },
          ctx.adminDisabled,
          ctx.envDeps,
        ),
        provenance: 'inline',
      });
    }

    // ADR-034: инструкция classify_conversation — config-gate routingEnabled (volatile).
    // Текст — prompt-ассет prompts/system/CLASSIFICATION.{lang}.md (переопределяемый).
    if (ctx.routingEnabled) {
      extraBlocks.push({
        key: 'classification',
        tier: 'volatile',
        order: 80,
        content: this._contextConfig?.getClassificationInstructions(lang) ?? '',
        provenance: 'prompts/system/CLASSIFICATION',
      });
    }

    // ADR-040: информация о сессии — проект/рабочий каталог/ограничения (context).
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
   * ADR-036: GATEWAY-инструкция — делегирует ContextBuilder (тот читает
   * prompts/system/GATEWAY.{lang}.md через ContextConfig).
   */
  private _getGatewayInstructions(lang: string): string {
    return this._contextBuilder.getGatewayInstructions(lang);
  }

  /**
   * ADR-071 §2.2: stable-блок `mcp.servers` — по каждому серверу имя, описание,
   * `instructions` и список тулов (имена + краткие описания; полные схемы
   * параметров остаются в `mcp.tools`). Сервер без описания/instructions всё
   * равно присутствует (имя + тулы). Пустых блоков не бывает: метод вызывается
   * только при непустом списке серверов.
   */
  private _buildMcpServersBlock(servers: ComposerMcpServer[], lang: string): string {
    const en = lang === 'en';
    const lines: string[] = [en ? '[MCP SERVERS]' : '[MCP-СЕРВЕРЫ]'];

    for (const server of servers) {
      lines.push('');
      lines.push(`## ${server.name}`);
      if (server.level) {
        lines.push(`${en ? 'Level' : 'Уровень'}: ${server.level}`);
      }
      if (server.description) {
        lines.push(`${en ? 'Description' : 'Описание'}: ${server.description}`);
      }
      if (server.instructions) {
        lines.push(`${en ? 'Instructions' : 'Инструкции'}: ${server.instructions}`);
      }
      if (server.tools.length > 0) {
        lines.push(en ? 'Tools:' : 'Инструменты:');
        for (const tool of server.tools) {
          lines.push(`- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * ADR-071 §2.2: volatile-блок `mcp.status` — статус подключения по каждому
   * серверу (`connected`/`error`/`disabled`/`circuit-open`). Для `disabled`
   * добавляется причина (opt-out сессии / не разрешён проектом / не включён
   * по умолчанию).
   */
  private _buildMcpStatusBlock(servers: ComposerMcpServer[], lang: string): string {
    const en = lang === 'en';
    const reasonText = (reason: ComposerMcpServer['disabledReason']): string => {
      if (reason === 'session') return en ? 'not enabled in session' : 'не включён в сессии';
      if (reason === 'session_optout') {
        return en ? 'disabled in session (opt-out)' : 'отключён в сессии (opt-out)';
      }
      if (reason === 'project_disabled') {
        return en ? 'not enabled in project' : 'не включён в проекте';
      }
      if (reason === 'not_default') {
        return en ? 'not enabled by default' : 'не включён по умолчанию';
      }
      return '';
    };

    const lines: string[] = [en ? '[MCP STATUS]' : '[СТАТУС MCP]'];
    for (const server of servers) {
      const parts: string[] = [];
      if (server.status === 'disabled') {
        const reason = reasonText(server.disabledReason);
        if (reason) parts.push(reason);
      }
      if (server.level) {
        parts.push(`${en ? 'level' : 'уровень'}=${server.level}`);
      }
      const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      lines.push(`- ${server.name}: ${server.status}${suffix}`);
    }

    return lines.join('\n');
  }

  /**
   * ADR-071 §2.3/§2.6: инструкция к слою инструментов. Для `available` —
   * «доступны только перечисленные» с указанием, каких инструментов касается
   * ограничение (встроенные / MCP); при административных отключениях —
   * дополнительная строка про ограничения администратора.
   */
  private _buildToolsGuideBlock(
    lang: string,
    restricted: { builtin: boolean; mcp: boolean },
    adminDisabled?: { capabilities: string[]; tools: string[] },
    envDeps?: RuntimeDeps,
  ): string {
    const lines: string[] = [];
    const anyRestricted = restricted.builtin || restricted.mcp;
    const missingDeps = missingDepsList(envDeps);
    if (lang === 'en') {
      if (anyRestricted) {
        const scope = restricted.builtin && restricted.mcp
          ? 'built-in and MCP tools'
          : restricted.builtin
            ? 'built-in tools'
            : 'MCP tools';
        lines.push(
          `[TOOLS]\n\nOnly the available ${scope} are included in this request. If a tool you need is missing, it is unavailable in the current mode or to the current agent: do not try to call it or work around the restriction — complete the available part of the work and suggest that the user switch the mode (plan/act/yolo) or delegate the task via \`@\`.`,
        );
      }
      if (hasAdminDisabled(adminDisabled)) {
        lines.push(
          'Some tools are disabled by the administrator and are not available to any agent; do not try to call them or work around this restriction.',
        );
      }
      if (missingDeps.length > 0) {
        lines.push(
          `Some tools are unavailable because the required program(s) are not installed in the environment: ${missingDeps.join(', ')}. Do not try to call them or work around this restriction; the tools will become available once the program(s) are installed.`,
        );
      }
    } else {
      if (anyRestricted) {
        const scope = restricted.builtin && restricted.mcp
          ? 'встроенные и MCP-инструменты'
          : restricted.builtin
            ? 'встроенные инструменты'
            : 'MCP-инструменты';
        lines.push(
          `[ИНСТРУМЕНТЫ]\n\nВ запросе переданы только доступные ${scope}, доступные в текущем режиме и текущему агенту. Если нужного инструмента нет — он недоступен в этом режиме или для этой роли: не пытайся вызвать его или обойти ограничение — выполни доступную часть работы и предложи пользователю переключить режим (plan/act/yolo) либо делегировать задачу через \`@\`.`,
        );
      }
      if (hasAdminDisabled(adminDisabled)) {
        lines.push(
          'Часть инструментов отключена администратором и недоступна ни одному агенту; не пытайся их вызвать или обойти это ограничение.',
        );
      }
      if (missingDeps.length > 0) {
        lines.push(
          `Часть инструментов недоступна: в окружении не установлены программы: ${missingDeps.join(', ')}. Не пытайся их вызвать или обойти это ограничение — они станут доступны после установки программ.`,
        );
      }
    }
    return lines.join('\n\n');
  }

  /**
   * ADR-040: блок «информация о сессии» — наличие/отсутствие проекта, рабочий
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
