import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Session, SessionSettings, TodoItem } from '@itphx/synth-shared';
import { ContextConfig } from './config.js';
import { ContextBuilder } from './builder.js';
import { SystemPromptComposer, type ComposerContext, type ComposerMcpServer } from './composer.js';
import { sortPromptBlocks } from './prompt-blocks.js';
import { DebugCollector } from '../../debug.js';

interface SessionOverrides {
  projectId?: string;
  mode?: Session['mode'];
  planApproved?: boolean;
  todos?: TodoItem[];
  settings?: Partial<SessionSettings>;
}

/** Минимальная сессия: Composer читает только настройки/режим/projectId/todos. */
function makeSession(overrides: SessionOverrides = {}): Session {
  return {
    id: 's1',
    projectId: overrides.projectId,
    mode: overrides.mode,
    planApproved: overrides.planApproved,
    todos: overrides.todos,
    messages: [],
    settings: {
      language: 'ru',
      agentRole: 'assistant',
      showInterview: false,
      routingEnabled: false,
      ...overrides.settings,
    },
  } as unknown as Session;
}

/** Стаб ContextConfig: возвращает маркеры вместо чтения prompt-файлов. */
function makeContextConfig(): ContextConfig {
  return {
    getGatewayInstructions: () => '[GATEWAY]',
    getPlanGuide: () => '[PLAN GUIDE]',
    getModePolicy: () => '[MODE POLICY]',
    getClassificationInstructions: () => '[CLASSIFICATION]',
    getSchedulerNotice: () => '[SCHEDULER]',
    getSchedulerTurnNotice: () => '[SCHEDULER TURN]',
  } as unknown as ContextConfig;
}

function makeProjectStore(): { load(id: string): Promise<Project | null> } {
  return {
    load: async (id: string) => ({
      id,
      name: 'Proj',
      workspace: '/ws',
      invariants: '',
      plan: {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        columns: [{ id: 'backlog', name: 'Бэклог', order: 0 }],
        items: [
          {
            id: 'p1',
            title: 'Пункт плана',
            columnId: 'backlog',
            priority: 'high',
            order: 0,
            dependsOn: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    } as unknown as Project),
  };
}

function makeTodos(): TodoItem[] {
  return [
    {
      id: 't1',
      content: 'Сделать шаг',
      status: 'pending',
      priority: 'medium',
    },
  ];
}

describe('SystemPromptComposer', () => {
  let userDataDir: string;
  let builder: ContextBuilder;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'synth-composer-'));
    await mkdir(join(userDataDir, 'user'), { recursive: true });
    await mkdir(join(userDataDir, 'roles'), { recursive: true });
    await writeFile(join(userDataDir, 'roles', 'ASSISTANT.md'), 'ROLE-MARKER', 'utf-8');
    builder = new ContextBuilder(new ContextConfig({ userDataDir }));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  function makeComposer(opts: {
    contextConfig?: ContextConfig | null;
    projectStore?: { load(id: string): Promise<Project | null> } | null;
  } = {}): SystemPromptComposer {
    return new SystemPromptComposer({
      contextBuilder: builder,
      contextConfig: opts.contextConfig === undefined ? makeContextConfig() : opts.contextConfig,
      projectStore: opts.projectStore === undefined ? makeProjectStore() : opts.projectStore,
    });
  }

  function makeCtx(session: Session, extra: Partial<ComposerContext> = {}): ComposerContext {
    return {
      session,
      workingDir: '/ws',
      language: 'ru',
      routingEnabled: false,
      gatewayEnabled: true,
      ...extra,
    };
  }

  it('идемпотентность: двойной compose при одном состоянии → одинаковые байты', async () => {
    const composer = makeComposer();
    const session = makeSession({ projectId: 'p1', todos: makeTodos() });
    const ctx = makeCtx(session);

    const first = await composer.compose(ctx);
    const second = await composer.compose(ctx);

    expect(second.system).toBe(first.system);
    expect(second.stablePrefix).toBe(first.stablePrefix);
  });

  it('ADR-070 §2.8: режим/план/todo не попадают в system; mode.policy и plan.guide — ровно по одному разу', async () => {
    const composer = makeComposer();
    const session = makeSession({ projectId: 'p1', todos: makeTodos(), mode: 'plan' });

    const { system } = await composer.compose(makeCtx(session));

    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    expect(count(system, '[MODE POLICY]')).toBe(1);
    expect(count(system, '[PLAN GUIDE]')).toBe(1);
    // Состояние режима/плана/todo вынесено в chronological-сообщения.
    expect(system).not.toContain('[MODE:');
    expect(system).not.toContain('[PLAN MODE:');
    expect(system).not.toContain('[TODO]');
    expect(system).not.toContain('[APPROVED PLAN]');
  });

  it('порядок тиров: stable → context → volatile', async () => {
    const composer = makeComposer();
    const session = makeSession();

    const { system } = await composer.compose(makeCtx(session, { routingEnabled: true }));

    const iRole = system.indexOf('ROLE-MARKER');
    const iContext = system.indexOf('[ИНФОРМАЦИЯ О СЕССИИ]');
    const iVolatile = system.indexOf('[CLASSIFICATION]');

    expect(iRole).toBeGreaterThanOrEqual(0);
    expect(iContext).toBeGreaterThan(iRole);
    expect(iVolatile).toBeGreaterThan(iContext);
  });

  it('stablePrefix содержит только stable-блоки', async () => {
    const composer = makeComposer();
    const session = makeSession({ projectId: 'p1', todos: makeTodos(), mode: 'plan' });

    const { system, stablePrefix } = await composer.compose(makeCtx(session));

    expect(stablePrefix).toContain('ROLE-MARKER');
    expect(stablePrefix).toContain('[GATEWAY]');
    expect(stablePrefix).toContain('[PLAN GUIDE]');
    expect(stablePrefix).toContain('[MODE POLICY]');

    expect(stablePrefix).not.toContain('[ИНФОРМАЦИЯ О СЕССИИ]');
    expect(stablePrefix).not.toContain('[TODO]');
    expect(stablePrefix).not.toContain('[APPROVED PLAN]');

    // Полный system содержит и динамику.
    expect(system).toContain('[ИНФОРМАЦИЯ О СЕССИИ]');
  });

  it('безопасное поведение без contextConfig/projectStore', async () => {
    const composer = makeComposer({ contextConfig: null, projectStore: null });
    const session = makeSession({ projectId: 'p1', todos: makeTodos() });

    const result = await composer.compose(makeCtx(session));

    expect(result.system).toContain('ROLE-MARKER');
    // Нет projectStore → план проекта пуст, контекст сессии помечает проект как не найденный.
    expect(result.system).not.toContain('[APPROVED PLAN]');
    expect(result.system).toContain('Проект: не найден');
    // contextConfig нет → guide/policy не добавляются.
    expect(result.system).not.toContain('[MODE POLICY]');
    expect(result.system).not.toContain('[PLAN GUIDE]');
  });

  it('session.settings.systemPrompt override заменяет базу, но доп. блоки остаются', async () => {
    const composer = makeComposer();
    const session = makeSession({
      projectId: 'p1',
      mode: 'plan',
      settings: { systemPrompt: 'OVERRIDE-MARKER' },
    });

    const { system } = await composer.compose(makeCtx(session));

    expect(system).toContain('OVERRIDE-MARKER');
    expect(system).not.toContain('ROLE-MARKER');
    expect(system).toContain('[GATEWAY]');
    expect(system).toContain('[MODE POLICY]');
    expect(system).toContain('[ИНФОРМАЦИЯ О СЕССИИ]');
    expect(system).not.toContain('[MODE:');
  });

  it('routingEnabled добавляет [CLASSIFICATION] в volatile', async () => {
    const composer = makeComposer();
    const session = makeSession();

    const without = await composer.compose(makeCtx(session, { routingEnabled: false }));
    const withRouting = await composer.compose(makeCtx(session, { routingEnabled: true }));

    expect(without.system).not.toContain('[CLASSIFICATION]');
    expect(withRouting.system).toContain('[CLASSIFICATION]');
    expect(withRouting.stablePrefix).not.toContain('[CLASSIFICATION]');
  });

  describe('manifest (ADR-070 §2.5)', () => {
    it('отдаёт key/label/tier/размеры/status/provenance по каждому блоку', async () => {
      const composer = makeComposer();
      const session = makeSession({ projectId: 'p1' });

      const manifest = await composer.manifest(makeCtx(session));

      const role = manifest.entries.find((e) => e.key === 'role');
      expect(role).toBeDefined();
      expect(role!.tier).toBe('stable');
      expect(role!.label).toBe('Role prompt');
      expect(role!.status).toBe('loaded');
      expect(role!.chars).toBe('ROLE-MARKER'.length);
      expect(role!.estTokens).toBe(Math.ceil(role!.chars / 4));
      expect(role!.provenance).toContain('roles/');

      // Пустой блок присутствует в манифесте со статусом empty.
      const additional = manifest.entries.find((e) => e.key === 'additional');
      expect(additional).toBeDefined();
      expect(additional!.status).toBe('empty');
      expect(additional!.chars).toBe(0);

      // config-gate выключен → блока classification в манифесте нет вовсе.
      expect(manifest.entries.find((e) => e.key === 'classification')).toBeUndefined();
    });

    it('entries идут в реальном порядке (tier → order), role первый, tools в конце stable', async () => {
      const composer = makeComposer();
      const session = makeSession({ projectId: 'p1' });
      const tools = [
        { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } },
      ];
      const ctx = makeCtx(session, { routingEnabled: true, tools });

      const manifest = await composer.manifest(ctx);
      // ADR-071 §2.1: слои инструментов (`tools`/`mcp.tools`) — не system-блоки.
      const systemEntries = manifest.entries.filter((e) => e.source === 'system');

      // role — первый; tools — сразу после последнего stable-блока (mode.policy)
      // и перед первым context-блоком (profile). После tools идут context/volatile.
      expect(systemEntries[0]!.key).toBe('role');
      const iTools = manifest.entries.findIndex((e) => e.key === 'tools');
      const iMode = manifest.entries.findIndex((e) => e.key === 'mode.policy');
      const iProfile = manifest.entries.findIndex((e) => e.key === 'profile');
      expect(iMode).toBeGreaterThanOrEqual(0);
      expect(iProfile).toBeGreaterThan(iMode);
      expect(iTools).toBe(iMode + 1);
      expect(iTools).toBeLessThan(iProfile);
      expect(manifest.entries[manifest.entries.length - 1]!.key).not.toBe('tools');

      // Монотонность по (tier, order).
      const tierRank: Record<string, number> = { stable: 0, context: 1, volatile: 2 };
      for (let i = 1; i < systemEntries.length; i++) {
        const prev = systemEntries[i - 1]!;
        const cur = systemEntries[i]!;
        const prevRank = tierRank[prev.tier]!;
        const curRank = tierRank[cur.tier]!;
        expect(prevRank < curRank || (prevRank === curRank && prev.order! <= cur.order!)).toBe(true);
      }

      // classification (volatile, order 80) идёт перед interview (volatile, order 90).
      const iClass = systemEntries.findIndex((e) => e.key === 'classification');
      const iInterview = systemEntries.findIndex((e) => e.key === 'interview');
      expect(iClass).toBeGreaterThanOrEqual(0);
      expect(iInterview).toBeGreaterThan(iClass);

      // Порядок совпадает с реальным порядком system-блоков в compose().
      const composed = await composer.compose(ctx);
      expect(systemEntries.map((e) => e.key)).toEqual(
        sortPromptBlocks(composed.blocks).map((b) => b.key),
      );
    });

    it('паритет: сумма chars манифеста = длины блоков compose(); system учитывает разделители', async () => {
      const composer = makeComposer();
      const session = makeSession({ projectId: 'p1' });

      const composed = await composer.compose(makeCtx(session));
      const manifest = await composer.manifest(makeCtx(session));

      // Запись tools (`source: 'tools'`) — не system-блок: сравниваем
      // system-подмножество манифеста с блоками compose() в реальном порядке
      // отправки (sortPromptBlocks: тир → order).
      const sortedBlocks = sortPromptBlocks(composed.blocks);
      // ADR-071 §2.1: слои инструментов (`tools`/`mcp.tools`) — не system-блоки.
      const systemEntries = manifest.entries.filter((e) => e.source === 'system');
      expect(systemEntries.map((e) => e.key)).toEqual(sortedBlocks.map((b) => b.key));

      systemEntries.forEach((entry, i) => {
        const block = sortedBlocks[i]!;
        expect(entry.order).toBe(block.order);
        expect(entry.chars).toBe(block.content.length);
        expect(entry.estTokens).toBe(Math.ceil(block.content.length / 4));
      });

      const nonEmpty = composed.blocks.filter((b) => b.content !== '');
      const sumChars = nonEmpty.reduce((sum, b) => sum + b.content.length, 0);
      // tools в этом контексте нет → вклад в размеры нулевой.
      expect(manifest.totalChars).toBe(sumChars);
      expect(manifest.estTokens).toBe(Math.ceil(sumChars / 4));
      // joinPromptBlocks склеивает блоки разделителем '\n\n' (2 символа).
      expect(composed.system.length).toBe(sumChars + 2 * (nonEmpty.length - 1));

      const stableNonEmpty = composed.blocks.filter((b) => b.tier === 'stable' && b.content !== '');
      const stableChars = stableNonEmpty.reduce((sum, b) => sum + b.content.length, 0);
      expect(manifest.staticPrefixChars).toBe(stableChars);
      expect(composed.stablePrefix.length).toBe(stableChars + 2 * (stableNonEmpty.length - 1));
    });

    it('tools: запись stable с ненулевыми chars и учётом в total/staticPrefix; без tools — empty', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const tools = [
        { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } },
        { type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: {} } },
      ];
      const toolsChars = JSON.stringify(tools).length;

      const withTools = await composer.manifest(makeCtx(session, { tools }));
      const entry = withTools.entries.find((e) => e.key === 'tools');
      expect(entry).toBeDefined();
      expect(entry!.tier).toBe('stable');
      expect(entry!.source).toBe('tools');
      expect(entry!.status).toBe('loaded');
      expect(entry!.chars).toBe(toolsChars);
      expect(entry!.estTokens).toBe(Math.ceil(toolsChars / 4));

      // Порядок: первой идёт роль (как в реальном system prompt); tools — в
      // конце тира `stable` (перед первой context-записью), не в начале и не
      // после volatile.
      expect(withTools.entries[0]!.key).toBe('role');
      const iTools = withTools.entries.findIndex((e) => e.key === 'tools');
      const iMode = withTools.entries.findIndex((e) => e.key === 'mode.policy');
      const iProfile = withTools.entries.findIndex((e) => e.key === 'profile');
      expect(iTools).toBe(iMode + 1);
      expect(iTools).toBeLessThan(iProfile);
      expect(withTools.entries.findIndex((e) => e.key === 'role')).toBeLessThan(iTools);

      const systemChars = withTools.entries
        .filter((e) => e.source !== 'tools' && e.status !== 'empty')
        .reduce((sum, e) => sum + e.chars, 0);
      const stableSystemChars = withTools.entries
        .filter((e) => e.source !== 'tools' && e.status !== 'empty' && e.tier === 'stable')
        .reduce((sum, e) => sum + e.chars, 0);
      expect(withTools.totalChars).toBe(systemChars + toolsChars);
      expect(withTools.staticPrefixChars).toBe(stableSystemChars + toolsChars);

      // compose() не содержит tools-текста (инструменты — не часть system).
      const composed = await composer.compose(makeCtx(session, { tools }));
      expect(composed.blocks.some((b) => b.key === 'tools')).toBe(false);
      expect(composed.system).not.toContain('read_file');

      // Без tools запись присутствует, но пустая.
      const withoutTools = await composer.manifest(makeCtx(session));
      const emptyEntry = withoutTools.entries.find((e) => e.key === 'tools');
      expect(emptyEntry).toBeDefined();
      expect(emptyEntry!.status).toBe('empty');
      expect(emptyEntry!.chars).toBe(0);
      expect(withoutTools.totalChars).toBe(systemChars);
    });

    it('ADR-071 §2.1: mcp.tools — volatile, не в staticPrefix; порядок tools → mcp.tools', async () => {
      const composer = makeComposer();
      const session = makeSession({ projectId: 'p1' });
      const tools = [
        { type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } },
      ];
      const mcpTools = [
        { type: 'function', function: { name: 'srv_search', description: 'MCP', parameters: {} } },
        { type: 'function', function: { name: 'srv_fetch', description: 'MCP', parameters: {} } },
      ];
      const toolsChars = JSON.stringify(tools).length;
      const mcpChars = JSON.stringify(mcpTools).length;

      const manifest = await composer.manifest(makeCtx(session, { tools, mcpTools }));

      const toolsEntry = manifest.entries.find((e) => e.key === 'tools');
      expect(toolsEntry).toBeDefined();
      expect(toolsEntry!.tier).toBe('stable');
      expect(toolsEntry!.source).toBe('tools');

      const mcpEntry = manifest.entries.find((e) => e.key === 'mcp.tools');
      expect(mcpEntry).toBeDefined();
      expect(mcpEntry!.tier).toBe('volatile');
      expect(mcpEntry!.source).toBe('mcp.tools');
      expect(mcpEntry!.status).toBe('loaded');
      expect(mcpEntry!.chars).toBe(mcpChars);
      expect(mcpEntry!.estTokens).toBe(Math.ceil(mcpChars / 4));

      // Порядок: tools сразу после последнего stable-блока, mcp.tools — сразу за ним.
      const iTools = manifest.entries.findIndex((e) => e.key === 'tools');
      const iMcp = manifest.entries.findIndex((e) => e.key === 'mcp.tools');
      expect(iMcp).toBe(iTools + 1);

      // totalChars включает оба слоя; staticPrefixChars — только встроенные.
      const systemChars = manifest.entries
        .filter((e) => e.source === 'system' && e.status !== 'empty')
        .reduce((sum, e) => sum + e.chars, 0);
      const stableSystemChars = manifest.entries
        .filter((e) => e.source === 'system' && e.status !== 'empty' && e.tier === 'stable')
        .reduce((sum, e) => sum + e.chars, 0);
      expect(manifest.totalChars).toBe(systemChars + toolsChars + mcpChars);
      // MCP не входит в stable-префикс (staticPrefix учитывает только builtin).
      expect(manifest.staticPrefixChars).toBe(stableSystemChars + toolsChars);

      // Без MCP запись присутствует, но пустая и не влияет на staticPrefix.
      const withoutMcp = await composer.manifest(makeCtx(session, { tools }));
      const emptyMcp = withoutMcp.entries.find((e) => e.key === 'mcp.tools');
      expect(emptyMcp).toBeDefined();
      expect(emptyMcp!.status).toBe('empty');
      expect(emptyMcp!.chars).toBe(0);
      expect(withoutMcp.staticPrefixChars).toBe(stableSystemChars + toolsChars);
    });

    it('generation берётся из promptStates активного агента', async () => {
      const composer = makeComposer();
      const session = makeSession({ settings: { agentRole: 'assistant' } });
      session.promptStates = {
        assistant: {
          generation: 7,
          staticPrefixHash: 'x',
          staticPrefix: 'x',
          systemHash: 'y',
          blocks: [],
          reason: 'init',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      };

      const manifest = await composer.manifest(makeCtx(session));
      expect(manifest.generation).toBe(7);
    });

    it('manifest не вызывает captureSystemPromptParts (без побочных эффектов)', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const debug = new DebugCollector(true);

      await composer.manifest(makeCtx(session, { debugCollector: debug }));

      expect(debug.getDebugInfo()?.system_prompt_parts).toBeUndefined();
    });
  });

  describe('mcp.servers / mcp.status (ADR-071 §2.2)', () => {
    function makeMcpServers(): ComposerMcpServer[] {
      return [
        {
          name: 'active-srv',
          description: 'Активный сервер',
          instructions: 'Используй инструменты бережно',
          tools: [
            { name: 'search', description: 'Поиск' },
            { name: 'fetch' },
          ],
          status: 'connected',
        },
        {
          name: 'disabled-srv',
          description: 'Отключённый сервер',
          tools: [],
          status: 'disabled',
          disabledReason: 'session',
        },
      ];
    }

    it('mcp.servers и mcp.status всегда volatile (ADR-071 §2.3), не в stablePrefix', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const { system, stablePrefix } = await composer.compose(
        makeCtx(session, { mcpServers: makeMcpServers() }),
      );

      // Описания/instructions/тулы обоих серверов.
      expect(system).toContain('[MCP-СЕРВЕРЫ]');
      expect(system).toContain('## active-srv');
      expect(system).toContain('Описание: Активный сервер');
      expect(system).toContain('Инструкции: Используй инструменты бережно');
      expect(system).toContain('- search: Поиск');
      expect(system).toContain('- fetch');
      // Отключённый сервер показан (имя + описание).
      expect(system).toContain('## disabled-srv');
      expect(system).toContain('Описание: Отключённый сервер');

      // volatile-часть: статус с пометкой disabled и причиной.
      expect(system).toContain('[СТАТУС MCP]');
      expect(system).toContain('- active-srv: connected');
      expect(system).toContain('- disabled-srv: disabled (не включён в сессии)');

      // ADR-071 §2.3: ни один MCP-блок не входит в кэшируемый stablePrefix.
      expect(stablePrefix).not.toContain('[MCP-СЕРВЕРЫ]');
      expect(stablePrefix).not.toContain('[СТАТУС MCP]');
    });

    it('манифест: mcp.servers и mcp.status (volatile) с label/provenance; не в staticPrefix', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const manifest = await composer.manifest(makeCtx(session, { mcpServers: makeMcpServers() }));

      const servers = manifest.entries.find((e) => e.key === 'mcp.servers');
      expect(servers).toBeDefined();
      expect(servers!.tier).toBe('volatile');
      expect(servers!.source).toBe('system');
      expect(servers!.label).toBe('MCP servers');
      expect(servers!.provenance).toBe('mcp.servers');
      expect(servers!.chars).toBeGreaterThan(0);

      const status = manifest.entries.find((e) => e.key === 'mcp.status');
      expect(status).toBeDefined();
      expect(status!.tier).toBe('volatile');
      expect(status!.source).toBe('system');
      expect(status!.label).toBe('MCP status');
      expect(status!.chars).toBeGreaterThan(0);

      // Ни mcp.servers, ни mcp.status не входят в staticPrefix.
      const stableOnly = manifest.entries
        .filter((e) => e.tier === 'stable' && e.status !== 'empty')
        .reduce((sum, e) => sum + e.chars, 0);
      expect(manifest.staticPrefixChars).toBe(stableOnly);
      expect(manifest.staticPrefixChars).toBeLessThan(manifest.totalChars);
    });

    it('пустой набор серверов → блоков mcp.servers/mcp.status нет', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const composed = await composer.compose(makeCtx(session, { mcpServers: [] }));
      const manifest = await composer.manifest(makeCtx(session, { mcpServers: [] }));

      expect(composed.system).not.toContain('[MCP-СЕРВЕРЫ]');
      expect(composed.system).not.toContain('[СТАТУС MCP]');
      expect(manifest.entries.find((e) => e.key === 'mcp.servers')).toBeUndefined();
      expect(manifest.entries.find((e) => e.key === 'mcp.status')).toBeUndefined();
    });

    it('en: блоки формируются без description/instructions (имя + статус)', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const servers: ComposerMcpServer[] = [
        { name: 'bare-srv', tools: [{ name: 'ping' }], status: 'error' },
      ];

      const { system } = await composer.compose(
        makeCtx(session, { mcpServers: servers, language: 'en' }),
      );

      expect(system).toContain('[MCP SERVERS]');
      expect(system).toContain('## bare-srv');
      expect(system).toContain('- ping');
      expect(system).toContain('[MCP STATUS]');
      expect(system).toContain('- bare-srv: error');
      expect(system).not.toContain('Description:');
      expect(system).not.toContain('Instructions:');
    });

    it('ADR-071 §2.4: level-aware — уровень сервера и причина отключения', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const servers: ComposerMcpServer[] = [
        {
          name: 'sys-srv',
          description: 'Системный',
          tools: [],
          status: 'disabled',
          level: 'system',
          disabledReason: 'session_optout',
        },
        {
          name: 'proj-srv',
          description: 'Проектный',
          tools: [],
          status: 'disabled',
          level: 'project',
          disabledReason: 'project_disabled',
        },
        {
          name: 'community-srv',
          tools: [],
          status: 'disabled',
          level: 'session',
          disabledReason: 'not_default',
        },
      ];

      const { system } = await composer.compose(makeCtx(session, { mcpServers: servers }));

      // Уровень показан в stable-блоке описаний.
      expect(system).toContain('Уровень: system');
      expect(system).toContain('Уровень: project');
      expect(system).toContain('Уровень: session');

      // volatile-статус: причина + уровень для отключённых.
      expect(system).toContain('- sys-srv: disabled (отключён в сессии (opt-out), уровень=system)');
      expect(system).toContain('- proj-srv: disabled (не включён в проекте, уровень=project)');
      expect(system).toContain('- community-srv: disabled (не включён по умолчанию, уровень=session)');
    });
  });

  describe('tools.policy (ADR-071 §2.3)', () => {
    const tools = [
      { type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } },
      { type: 'function', function: { name: 'write_file', description: 'Write', parameters: {} } },
    ];

    it('consistency (дефолт): tools stable, staticPrefix включает tools, tools.guide нет', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const toolsChars = JSON.stringify(tools).length;

      const manifest = await composer.manifest(makeCtx(session, { tools, toolsPolicy: 'consistency' }));
      const entry = manifest.entries.find((e) => e.key === 'tools');
      expect(entry!.tier).toBe('stable');
      expect(manifest.toolsPolicy).toBe('consistency');
      expect(manifest.entries.find((e) => e.key === 'tools.guide')).toBeUndefined();
      expect(manifest.staticPrefixChars).toBeGreaterThanOrEqual(toolsChars);

      const composed = await composer.compose(makeCtx(session, { toolsPolicy: 'consistency' }));
      expect(composed.system).not.toContain('[ИНСТРУМЕНТЫ]');
    });

    it('available: tools context, не в staticPrefix, добавлен tools.guide', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const toolsChars = JSON.stringify(tools).length;

      const manifest = await composer.manifest(makeCtx(session, { tools, toolsPolicy: 'available' }));
      const entry = manifest.entries.find((e) => e.key === 'tools');
      expect(entry!.tier).toBe('context');
      expect(entry!.chars).toBe(toolsChars);
      expect(manifest.toolsPolicy).toBe('available');

      const guide = manifest.entries.find((e) => e.key === 'tools.guide');
      expect(guide).toBeDefined();
      expect(guide!.tier).toBe('context');
      expect(guide!.chars).toBeGreaterThan(0);

      // staticPrefix не включает изменчивый tools (context).
      const stableSystemChars = manifest.entries
        .filter((e) => e.source === 'system' && e.status !== 'empty' && e.tier === 'stable')
        .reduce((sum, e) => sum + e.chars, 0);
      expect(manifest.staticPrefixChars).toBe(stableSystemChars);
      expect(manifest.totalChars).toBeGreaterThan(manifest.staticPrefixChars);

      const composed = await composer.compose(makeCtx(session, { toolsPolicy: 'available' }));
      expect(composed.system).toContain('[ИНСТРУМЕНТЫ]');
      expect(composed.stablePrefix).not.toContain('[ИНСТРУМЕНТЫ]');
    });

    it('любая политика available: mcp.servers/mcp.status остаются volatile', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const servers: ComposerMcpServer[] = [
        { name: 'srv', tools: [{ name: 'ping' }], status: 'connected' },
      ];

      const manifest = await composer.manifest(
        makeCtx(session, { mcpServers: servers, toolsPolicy: 'available', mcpPolicy: 'available' }),
      );
      expect(manifest.entries.find((e) => e.key === 'mcp.servers')!.tier).toBe('volatile');
      expect(manifest.entries.find((e) => e.key === 'mcp.status')!.tier).toBe('volatile');
      // MCP-блоки не в staticPrefix.
      const stableOnly = manifest.entries
        .filter((e) => e.tier === 'stable' && e.status !== 'empty')
        .reduce((sum, e) => sum + e.chars, 0);
      expect(manifest.staticPrefixChars).toBe(stableOnly);
    });

    it('en: инструкция tools.guide на английском', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const composed = await composer.compose(
        makeCtx(session, { language: 'en', toolsPolicy: 'available' }),
      );
      expect(composed.system).toContain('[TOOLS]');
      expect(composed.system).toContain('Only the available built-in tools');
    });
  });

  describe('mcp.policy (ADR-071 §2.3)', () => {
    const tools = [
      { type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } },
    ];
    const servers: ComposerMcpServer[] = [
      { name: 'srv', tools: [{ name: 'ping' }], status: 'connected' },
    ];

    it('mcpPolicy=available добавляет tools.guide, даже если toolsPolicy=consistency', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const manifest = await composer.manifest(
        makeCtx(session, { mcpServers: servers, toolsPolicy: 'consistency', mcpPolicy: 'available' }),
      );
      expect(manifest.mcpPolicy).toBe('available');
      expect(manifest.entries.find((e) => e.key === 'tools.guide')).toBeDefined();
      // tools остаются stable (политика встроенных не меняется).
      expect(manifest.entries.find((e) => e.key === 'tools')!.tier).toBe('stable');
      // MCP-блоки всё равно volatile.
      expect(manifest.entries.find((e) => e.key === 'mcp.servers')!.tier).toBe('volatile');
    });

    it('mcpPolicy=consistency и toolsPolicy=consistency → tools.guide нет', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const manifest = await composer.manifest(
        makeCtx(session, { tools, mcpServers: servers, toolsPolicy: 'consistency', mcpPolicy: 'consistency' }),
      );
      expect(manifest.mcpPolicy).toBe('consistency');
      expect(manifest.entries.find((e) => e.key === 'tools.guide')).toBeUndefined();
    });

    it('порядок манифеста: tools → mcp.servers → mcp.tools → mcp.status', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const mcpTools = [
        { type: 'function', function: { name: 'srv_ping', description: 'MCP', parameters: {} } },
      ];

      const manifest = await composer.manifest(
        makeCtx(session, { tools, mcpTools, mcpServers: servers, toolsPolicy: 'available', mcpPolicy: 'available' }),
      );
      const iTools = manifest.entries.findIndex((e) => e.key === 'tools');
      const iServers = manifest.entries.findIndex((e) => e.key === 'mcp.servers');
      const iMcpTools = manifest.entries.findIndex((e) => e.key === 'mcp.tools');
      const iStatus = manifest.entries.findIndex((e) => e.key === 'mcp.status');

      expect(iTools).toBeGreaterThanOrEqual(0);
      expect(iTools).toBeLessThan(iServers);
      expect(iServers).toBeLessThan(iMcpTools);
      expect(iMcpTools).toBeLessThan(iStatus);
    });

    it('en: mcpPolicy=available → [TOOLS] упоминает MCP', async () => {
      const composer = makeComposer();
      const session = makeSession();
      const composed = await composer.compose(
        makeCtx(session, { language: 'en', toolsPolicy: 'consistency', mcpPolicy: 'available' }),
      );
      expect(composed.system).toContain('[TOOLS]');
      expect(composed.system).toContain('MCP tools');
    });
  });

  it('compose с debugCollector заполняет system_prompt_parts', async () => {
    const composer = makeComposer();
    const session = makeSession();
    const debug = new DebugCollector(true);

    await composer.compose(makeCtx(session, { debugCollector: debug }));

    const parts = debug.getDebugInfo()?.system_prompt_parts as Record<string, unknown> | undefined;
    expect(parts).toBeDefined();
    expect(Array.isArray(parts!.blocks)).toBe(true);
    expect(typeof parts!.systemChars).toBe('number');
  });

  describe('instructions (ADR-069)', () => {
    const instructions = {
      content: '[PROJECT INSTRUCTIONS]\n--- from ./AGENTS.md (10 chars) ---\nCORE-RULES\n[END PROJECT INSTRUCTIONS]',
      provenance: './AGENTS.md',
    };

    it('блок в тире context, order 15 — после profile, до project.info', async () => {
      const composer = makeComposer();
      const session = makeSession({ projectId: 'p1' });

      const { system, stablePrefix, blocks } = await composer.compose(
        makeCtx(session, { instructions }),
      );

      const block = blocks.find((b) => b.key === 'instructions');
      expect(block).toBeDefined();
      expect(block!.tier).toBe('context');
      expect(block!.order).toBe(15);
      expect(system).toContain('CORE-RULES');
      // Тир context не попадает в stable-префикс.
      expect(stablePrefix).not.toContain('CORE-RULES');

      const sorted = sortPromptBlocks(blocks);
      const iProfile = sorted.findIndex((b) => b.key === 'profile');
      const iInstr = sorted.findIndex((b) => b.key === 'instructions');
      const iProject = sorted.findIndex((b) => b.key === 'project.info');
      expect(iProfile).toBeGreaterThanOrEqual(0);
      expect(iInstr).toBeGreaterThan(iProfile);
      expect(iProject).toBeGreaterThan(iInstr);
    });

    it('manifest: label/status/provenance блока instructions', async () => {
      const composer = makeComposer();
      const session = makeSession({ projectId: 'p1' });

      const manifest = await composer.manifest(
        makeCtx(session, { instructions: { ...instructions, status: 'truncated' } }),
      );

      const entry = manifest.entries.find((e) => e.key === 'instructions');
      expect(entry).toBeDefined();
      expect(entry!.label).toBe('Project instructions');
      expect(entry!.tier).toBe('context');
      expect(entry!.status).toBe('truncated');
      expect(entry!.provenance).toBe('./AGENTS.md');
      expect(entry!.chars).toBeGreaterThan(0);

      // Без instructions блока нет.
      const without = await composer.manifest(makeCtx(session));
      expect(without.entries.find((e) => e.key === 'instructions')).toBeUndefined();
    });

    it('systemPrompt override: блок instructions не добавляется', async () => {
      const composer = makeComposer();
      const session = makeSession({ settings: { systemPrompt: 'OVERRIDE' } });

      const { system } = await composer.compose(makeCtx(session, { instructions }));

      expect(system).toContain('OVERRIDE');
      expect(system).not.toContain('CORE-RULES');
    });
  });

  describe('scheduler (ADR-051)', () => {
    it('schedulerActive:true → блок scheduler (context, order 16, provenance), статический', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const { system, stablePrefix, blocks } = await composer.compose(
        makeCtx(session, { schedulerActive: true }),
      );

      const block = blocks.find((b) => b.key === 'scheduler');
      expect(block).toBeDefined();
      expect(block!.tier).toBe('context');
      expect(block!.order).toBe(16);
      expect(block!.content).toBe('[SCHEDULER]');
      expect(block!.provenance).toBe('prompts/system/SCHEDULER');
      expect(system).toContain('[SCHEDULER]');
      // Тир context не входит в кэшируемый stable-префикс.
      expect(stablePrefix).not.toContain('[SCHEDULER]');
    });

    it('schedulerActive по умолчанию (false) → блока scheduler нет', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const { blocks } = await composer.compose(makeCtx(session));
      expect(blocks.find((b) => b.key === 'scheduler')).toBeUndefined();

      const manifest = await composer.manifest(makeCtx(session, { schedulerActive: true }));
      const entry = manifest.entries.find((e) => e.key === 'scheduler');
      expect(entry).toBeDefined();
      expect(entry!.label).toBe('Scheduler notice');
      expect(entry!.tier).toBe('context');
      expect(entry!.provenance).toBe('prompts/system/SCHEDULER');
      expect(entry!.status).toBe('loaded');
    });

    it('systemPrompt override → блок scheduler не добавляется', async () => {
      const composer = makeComposer();
      const session = makeSession({ settings: { systemPrompt: 'OVERRIDE' } });

      const { blocks } = await composer.compose(
        makeCtx(session, { schedulerActive: true }),
      );
      expect(blocks.find((b) => b.key === 'scheduler')).toBeUndefined();
    });

    it('пустой ассет → блок не добавляется даже при schedulerActive', async () => {
      const composer = makeComposer({
        contextConfig: {
          ...makeContextConfig(),
          getSchedulerNotice: () => '',
        } as unknown as ContextConfig,
      });
      const session = makeSession();

      const { blocks } = await composer.compose(
        makeCtx(session, { schedulerActive: true }),
      );
      expect(blocks.find((b) => b.key === 'scheduler')).toBeUndefined();
    });
  });

  describe('scheduler.turn (ADR-051)', () => {
    it('schedulerCurrentTurn:true → volatile-блок order 40, provenance, не в stablePrefix', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const { system, stablePrefix, blocks } = await composer.compose(
        makeCtx(session, { schedulerCurrentTurn: true }),
      );

      const block = blocks.find((b) => b.key === 'scheduler.turn');
      expect(block).toBeDefined();
      expect(block!.tier).toBe('volatile');
      expect(block!.order).toBe(40);
      expect(block!.content).toBe('[SCHEDULER TURN]');
      expect(block!.provenance).toBe('prompts/system/SCHEDULER_TURN');
      expect(system).toContain('[SCHEDULER TURN]');
      expect(stablePrefix).not.toContain('[SCHEDULER TURN]');
    });

    it('по умолчанию (false) → блока scheduler.turn нет', async () => {
      const composer = makeComposer();
      const session = makeSession();

      const { blocks } = await composer.compose(makeCtx(session));
      expect(blocks.find((b) => b.key === 'scheduler.turn')).toBeUndefined();
    });

    it('systemPrompt override → блок scheduler.turn не добавляется', async () => {
      const composer = makeComposer();
      const session = makeSession({ settings: { systemPrompt: 'OVERRIDE' } });

      const { blocks } = await composer.compose(
        makeCtx(session, { schedulerCurrentTurn: true }),
      );
      expect(blocks.find((b) => b.key === 'scheduler.turn')).toBeUndefined();
    });

    it('пустой ассет → блок не добавляется даже при schedulerCurrentTurn', async () => {
      const composer = makeComposer({
        contextConfig: {
          ...makeContextConfig(),
          getSchedulerTurnNotice: () => '',
        } as unknown as ContextConfig,
      });
      const session = makeSession();

      const { blocks } = await composer.compose(
        makeCtx(session, { schedulerCurrentTurn: true }),
      );
      expect(blocks.find((b) => b.key === 'scheduler.turn')).toBeUndefined();
    });
  });

  describe('interviewEligible (PROP-083/онбординг)', () => {
    it('пробрасывается в ContextBuilder.buildBaseBlocks', async () => {
      const captured: Array<Record<string, unknown>> = [];
      const stubBuilder = {
        buildBaseBlocks: async (params: Record<string, unknown>) => {
          captured.push(params);
          return [{ key: 'role', tier: 'stable', order: 10, content: 'ROLE' }];
        },
        getGatewayInstructions: () => '[GATEWAY]',
      } as unknown as ContextBuilder;
      const composer = new SystemPromptComposer({
        contextBuilder: stubBuilder,
        contextConfig: makeContextConfig(),
        projectStore: makeProjectStore(),
      });
      const session = makeSession();

      await composer.compose(makeCtx(session, { interviewEligible: true, userId: 'u1' }));

      expect(captured).toHaveLength(1);
      expect(captured[0]!.interviewEligible).toBe(true);
      expect(captured[0]!.userId).toBe('u1');
    });
  });
});
