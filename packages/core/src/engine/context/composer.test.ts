import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Session, SessionSettings, TodoItem } from '@itphx/synth-shared';
import { ContextConfig } from './config.js';
import { ContextBuilder } from './builder.js';
import { SystemPromptComposer, type ComposerContext } from './composer.js';
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

  it('AD-070 §2.8: режим/план/todo не попадают в system; mode.policy и plan.guide — ровно по одному разу', async () => {
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

  describe('manifest (AD-070 §2.5)', () => {
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
      // AD-071 §2.1: слои инструментов (`tools`/`mcp.tools`) — не system-блоки.
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
      // AD-071 §2.1: слои инструментов (`tools`/`mcp.tools`) — не system-блоки.
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

    it('AD-071 §2.1: mcp.tools — volatile, не в staticPrefix; порядок tools → mcp.tools', async () => {
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
});
