/**
 * ADR-095 (шаг 6b-1): собственные тесты подготовки запроса `runProcessSetup`.
 *
 * Проверяются контракты DI-сборки, а не реализация зависимостей:
 *  - нет провайдера → ранний исход через общий `handleLlmFailure`
 *    (`provider_not_found`), дальнейшие шаги не выполняются;
 *  - порядок шагов: провайдер → MCP-скоуп → state-сообщения → промпт →
 *    инструменты → cancel-токен;
 *  - state-сообщения идемпотентны и видны в запросе этого же хода;
 *  - `promptStates` пишутся только при смене generation (init / generation-change /
 *    override), `systemPrompt`-override убирает stable-префикс;
 *  - инструменты: builtin + MCP активных серверов, `stableToolCount` = число
 *    встроенных; MCP-тулы лениво регистрируются до сборки промпта;
 *  - cancel-токен регистрируется и абортит `toolAbortController`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { LLMChunk, LLMResponse, Message, Project, ToolForLLM } from '@itphx/synth-shared';
import { stubContextFiles } from '../../../test-helpers/storage-stubs.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { EventBus } from '../../../events/bus.js';
import { DebugCollector } from '../../../debug.js';
import { BaseProvider } from '../../../providers/base.js';
import type { CancellationToken } from '../../../providers/base.js';
import type { ComposedPrompt, ComposerContext, SystemPromptComposer } from '../../context/composer.js';
import type { PromptBlock } from '../../context/prompt-blocks.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { McpManager } from '../../mcp/manager.js';
import type { McpScopeDecision } from '../../mcp/scope.js';
import { DEFAULT_CHARS_PER_TOKEN } from '../../context/token-ratio.js';
import { t as sm } from '../../system-messages.js';
import { runProcessSetup, type ProcessSetupArgs, type ProcessSetupDeps } from './process-setup.js';

class SetupProvider extends BaseProvider {
  async chat(): Promise<LLMResponse> {
    return { content: '', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: '', isFinal: true, model: this.model };
  }

  getProviderName(): string {
    return 'setup-provider';
  }
}

function tool(name: string): ToolForLLM {
  return { type: 'function', function: { name, description: name, parameters: {} } };
}

describe('runProcessSetup', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: Array<{ type: string; data: Record<string, unknown> }>;
  let unsubscribe: () => void;
  let debugCollector: DebugCollector;

  const composedBase: ComposedPrompt = {
    system: 'SYSTEM',
    stablePrefix: 'PREFIX',
    blocks: [{ key: 'role', tier: 'stable', order: 10, content: 'role-content' }] as PromptBlock[],
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-setup-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push({ type: e.type, data: e.data }));
    debugCollector = new DebugCollector(false);
  });

  afterEach(async () => {
    unsubscribe();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeSession(settings: Record<string, unknown> = {}): Promise<{ id: string; message: Message }> {
    const session = await sessionManager.createSession({
      title: 'Setup',
      settings: { provider: 'setup-provider', model: 'set-model', agentRole: 'developer', ...settings } as never,
    });
    const message: Message = {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('вопрос')],
      content: 'вопрос',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: 'user',
      agentRole: 'developer',
      metadata: { stream_id: 'stream1' },
    };
    await sessionManager.addMessage(session.id, message);
    return { id: session.id, message };
  }

  async function makeArgs(
    sessionId: string,
    message: Message,
    overrides: Partial<ProcessSetupArgs> = {},
  ): Promise<ProcessSetupArgs> {
    // Реальная сессия из хранилища: модуль мутирует её (state-сообщения,
    // promptStates) и сохраняет — подмена объекта исказила бы контракт.
    const session = (await sessionManager.getSession(sessionId))!;
    return {
      session,
      message,
      signal: new AbortController().signal,
      streamStartedAt: Date.now(),
      debugCollector,
      streamId: 'stream1',
      projectForState: null,
      workingDir: tmpDir,
      workspaceReady: true,
      agentDef: undefined,
      effectiveAgentRole: 'developer',
      effectiveReasoningLevel: undefined,
      sessionMode: 'act',
      planMode: 'auto',
      planApproved: false,
      author: 'user',
      attempt: undefined,
      ...overrides,
    };
  }

  function makeDeps(overrides: Partial<ProcessSetupDeps> = {}): ProcessSetupDeps {
    return {
      routeProvider: vi.fn(async () => ({
        provider: new SetupProvider({ url: '', apiKey: '', model: 'set-model', name: 'session', type: 'setup-provider' }),
        providerName: 'setup-provider',
        modelName: 'set-model',
      })) as never,
      handleLlmFailure: vi.fn(async () => ({ error: 'provider not found', errorType: 'provider_not_found', canRetry: false })) as never,
      contextConfig: stubContextFiles({
        getModePrompt: () => 'MODE_PROMPT',
        getPlanModePrompt: () => 'PLAN_PROMPT',
      }),
      permissionConfig: { rules: {}, askTimeoutMs: 1000 } as never,
      cachePolicy: 'auto',
      resolveMcpDecisions: vi.fn(() => [
        { name: 'srv-on', level: 'system', enabled: true, origin: 'instance' },
        { name: 'srv-off', level: 'system', enabled: false, origin: 'instance' },
      ] as McpScopeDecision[]) as never,
      buildToolSelection: vi.fn(() => ({
        toolsPolicy: 'consistency' as const,
        mcpPolicy: 'consistency' as const,
        select: () => ({ builtin: [tool('read_file')], mcp: [tool('srv-on_ping')] }),
      })) as never,
      collectUnavailableTools: vi.fn(() => []) as never,
      collectSkillsCatalog: vi.fn(async () => undefined) as never,
      resolveProjectInstructions: vi.fn(async () => undefined) as never,
      resolveSchedulerActive: vi.fn(async () => false) as never,
      buildComposerContext: vi.fn(() => ({}) as ComposerContext) as never,
      collectComposerMcpServers: vi.fn(() => undefined) as never,
      interviewEligible: vi.fn(() => false) as never,
      schedulerCurrentTurn: vi.fn(() => false) as never,
      composer: {
        compose: vi.fn(async () => composedBase),
      } as unknown as SystemPromptComposer,
      optimizer: null,
      mcpManager: {
        refreshExecutorServers: vi.fn(async () => {}),
        ensureToolsLoaded: vi.fn(async () => {}),
      } as unknown as McpManager,
      toolRegistry: {} as ToolRegistry,
      lazyInstructions: { seed: vi.fn() } as never,
      eventBus,
      sessionManager,
      loadTokenRatio: vi.fn(async () => undefined) as never,
      registerCancelToken: vi.fn() as never,
      ...overrides,
    };
  }

  it('нет провайдера → ранний исход provider_not_found через handleLlmFailure', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps({ routeProvider: vi.fn(async () => null) as never });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);

    expect(outcome.failed).toBe(true);
    if (outcome.failed) {
      expect(outcome.result).toEqual({ error: 'provider not found', errorType: 'provider_not_found', canRetry: false });
    }
    const [, calledStreamId, error, , ctx] = (deps.handleLlmFailure as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(calledStreamId).toBe('stream1');
    expect((error as Error).message).toBe(sm('router.provider_not_found', { provider: 'setup-provider' }));
    expect(ctx).toMatchObject({ errorType: 'provider_not_found', providerName: 'setup-provider' });

    // Дальнейшие шаги подготовки не выполнялись
    expect(deps.resolveMcpDecisions).not.toHaveBeenCalled();
    expect(deps.composer.compose).not.toHaveBeenCalled();
    expect(deps.registerCancelToken).not.toHaveBeenCalled();
  });

  it('провайдер из сообщения приоритетнее настройки сессии в тексте ошибки', async () => {
    const { id, message } = await makeSession();
    const messageWithProvider = { ...message, provider: 'msg-provider' } as unknown as Message;
    const deps = makeDeps({ routeProvider: vi.fn(async () => null) as never });

    await runProcessSetup(await makeArgs(id, messageWithProvider), deps);

    const error = (deps.handleLlmFailure as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect((error as Error).message).toContain('msg-provider');
  });

  it('успешный путь: state-сообщения видны в запросе этого же хода и идемпотентны', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps();

    const first = await runProcessSetup(await makeArgs(id, message), deps);
    expect(first.failed).toBe(false);
    if (first.failed) return;

    // state-сообщения (mode_change + agent_switch) доехали и в историю, и в LLM-запрос
    const llmContents = first.state.baseLlmMessages.map((m) => m.content).join('\n');
    expect(llmContents).toContain('<system-state type="mode_change">');
    expect(llmContents).toContain('MODE_PROMPT');
    expect(llmContents).toContain('<system-state type="agent_switch">');
    expect(first.state.baseLlmMessages[0]!.role).toBe('user');

    const stored = (await sessionManager.getSession(id))!;
    const stateMessages = stored.messages.filter((m) => m.role === MessageRole.SYSTEM);
    expect(stateMessages).toHaveLength(2);

    // Второй ход: состояние не изменилось — новых state-сообщений нет
    const second = await runProcessSetup(await makeArgs(id, message), deps);
    expect(second.failed).toBe(false);
    if (second.failed) return;
    expect((await sessionManager.getSession(id))!.messages.filter((m) => m.role === MessageRole.SYSTEM)).toHaveLength(2);
  });

  it('promptStates: init → generation=1, повтор без изменений не пересобирает состояние', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps();
    const saveSpy = vi.spyOn(sessionManager, 'saveSession');

    const first = await runProcessSetup(await makeArgs(id, message), deps);
    expect(first.failed).toBe(false);
    if (first.failed) return;

    let stored = (await sessionManager.getSession(id))!;
    expect(stored.promptStates!.developer).toMatchObject({ generation: 1, reason: 'init', staticPrefix: 'PREFIX' });
    expect(first.state.promptMeta).toMatchObject({ agentRole: 'developer', generation: 1, expected: 'miss' });
    expect(first.state.finalSystemPrompt).toMatchObject({
      text: 'SYSTEM',
      stablePrefix: 'PREFIX',
      cacheKey: id,
      cachePolicy: 'auto',
    });

    const savesAfterFirst = saveSpy.mock.calls.length;
    const second = await runProcessSetup(await makeArgs(id, message), deps);
    expect(second.failed).toBe(false);
    if (second.failed) return;

    stored = (await sessionManager.getSession(id))!;
    expect(stored.promptStates!.developer!.generation).toBe(1);
    expect(saveSpy.mock.calls.length).toBe(savesAfterFirst);
    expect(second.state.promptMeta).toMatchObject({ generation: 1, expected: 'hit' });
  });

  it('блоки памяти плагина → promptMeta.memory и onMemoryContext', async () => {
    const { id, message } = await makeSession();
    const onMemoryContext = vi.fn();
    const deps = makeDeps({ onMemoryContext } as Partial<ProcessSetupDeps>);
    deps.composer = {
      compose: vi.fn(async () => ({
        ...composedBase,
        blocks: [
          ...composedBase.blocks,
          {
            key: 'plugin.synth-plugin-memory.facts',
            tier: 'context',
            order: 100,
            content: 'FACTS',
            status: 'loaded',
            source: 'provider',
          },
          {
            key: 'plugin.synth-plugin-memory.recall',
            tier: 'volatile',
            order: 110,
            content: '',
            status: 'empty',
            source: 'provider',
          },
        ],
      })),
    } as unknown as SystemPromptComposer;

    const result = await runProcessSetup(await makeArgs(id, message), deps);
    expect(result.failed).toBe(false);
    if (result.failed) return;

    expect(result.state.promptMeta.memory).toEqual({
      facts: { chars: 5, estTokens: 2, status: 'loaded' },
      recall: { chars: 0, estTokens: 0, status: 'empty' },
    });
    expect(onMemoryContext).toHaveBeenCalledWith([
      { block: 'facts', status: 'loaded', chars: 5 },
      { block: 'recall', status: 'empty', chars: 0 },
    ]);
  });

  it('память проекта выключена → тулы плагина памяти скрыты, остальные остаются', async () => {
    const { id, message } = await makeSession();
    const select = () => ({
      builtin: [tool('read_file')],
      plugin: [tool('plugin_synth_plugin_memory_memory_search'), tool('plugin_other_echo')],
      mcp: [] as ToolForLLM[],
    });
    const deps = makeDeps({
      buildToolSelection: vi.fn(() => ({
        toolsPolicy: 'consistency' as const,
        mcpPolicy: 'consistency' as const,
        select,
      })) as never,
    });

    const disabled = await runProcessSetup(
      await makeArgs(id, message, { projectForState: { memory: { enabled: false } } as Project }),
      deps,
    );
    expect(disabled.failed).toBe(false);
    if (!disabled.failed) {
      const names = (disabled.state.tools ?? []).map((t) => t.function.name);
      expect(names).toEqual(['read_file', 'plugin_other_echo']);
    }

    const enabled = await runProcessSetup(
      await makeArgs(id, message, { projectForState: { memory: { enabled: true } } as Project }),
      deps,
    );
    expect(enabled.failed).toBe(false);
    if (!enabled.failed) {
      expect((enabled.state.tools ?? []).map((t) => t.function.name)).toContain(
        'plugin_synth_plugin_memory_memory_search',
      );
    }
  });

  it('смена stable-префикса → generation-change (generation=2)', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps();
    await runProcessSetup(await makeArgs(id, message), deps);

    const changed = makeDeps({
      composer: {
        compose: vi.fn(async () => ({ ...composedBase, stablePrefix: 'PREFIX-2' })),
      } as unknown as SystemPromptComposer,
    });
    const outcome = await runProcessSetup(await makeArgs(id, message), changed);
    expect(outcome.failed).toBe(false);

    const stored = (await sessionManager.getSession(id))!;
    expect(stored.promptStates!.developer).toMatchObject({ generation: 2, reason: 'generation-change', staticPrefix: 'PREFIX-2' });
  });

  it('systemPrompt-override: reason=override, stable-префикс не выставляется', async () => {
    const { id, message } = await makeSession({ systemPrompt: 'мой промпт' });
    const deps = makeDeps();

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;

    expect(outcome.state.finalSystemPrompt.stablePrefix).toBeUndefined();
    const stored = (await sessionManager.getSession(id))!;
    expect(stored.promptStates!.developer).toMatchObject({ reason: 'override', staticPrefix: '' });
  });

  it('ADR-090: «вопрос хода» (текст сообщения пользователя) уходит в контекст композера', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps();

    await runProcessSetup(await makeArgs(id, message), deps);

    expect(deps.buildComposerContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'вопрос', turnId: 'stream1' }),
    );
  });

  it('ADR-090: системные/state-сообщения в «вопрос хода» не попадают', async () => {
    const { id, message } = await makeSession();
    // Последнее сообщение пользователя — до state-сообщения: state-сообщение
    // не должно перебивать вопрос хода.
    await sessionManager.addMessage(id, {
      id: generateId(),
      role: MessageRole.SYSTEM,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('РЕЖИМ: act')],
      content: 'РЕЖИМ: act',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { type: 'mode_change', state: true },
    } as Message);
    const deps = makeDeps();

    await runProcessSetup(await makeArgs(id, message), deps);

    expect(deps.buildComposerContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'вопрос' }),
    );
  });

  it('ADR-090: смена содержимого плагинного блока инвалидирует promptStates', async () => {
    const { id, message } = await makeSession();
    const withPluginBlock = (content: string): ComposedPrompt => ({
      ...composedBase,
      blocks: [
        ...composedBase.blocks,
        { key: 'plugin.demo.memory', tier: 'context', order: 100, content, source: 'provider' },
      ] as PromptBlock[],
    });
    const deps = makeDeps({
      composer: {
        compose: vi.fn(async () => withPluginBlock('ПАМЯТЬ-1')),
      } as unknown as SystemPromptComposer,
    });

    await runProcessSetup(await makeArgs(id, message), deps);
    let stored = (await sessionManager.getSession(id))!;
    expect(stored.promptStates!.developer).toMatchObject({ generation: 1, reason: 'init' });
    // Блок провайдера помечен в состоянии — по нему ведётся отдельный трек.
    expect(stored.promptStates!.developer!.blocks).toContainEqual(
      expect.objectContaining({ key: 'plugin.demo.memory', provider: true }),
    );

    // Содержимое плагинного блока изменилось, stable-префикс — прежний.
    const changed = makeDeps({
      composer: {
        compose: vi.fn(async () => withPluginBlock('ПАМЯТЬ-2')),
      } as unknown as SystemPromptComposer,
    });
    const outcome = await runProcessSetup(await makeArgs(id, message), changed);
    expect(outcome.failed).toBe(false);

    stored = (await sessionManager.getSession(id))!;
    expect(stored.promptStates!.developer).toMatchObject({ generation: 2, reason: 'generation-change' });
  });

  it('инструменты: builtin + MCP активных серверов, stableToolCount = число встроенных', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps();

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;

    expect(outcome.state.activeMcpServers).toEqual(['srv-on']);
    expect(outcome.state.activeMcpSet.has('srv-off')).toBe(false);
    expect(outcome.state.tools!.map((t) => t.function.name)).toEqual(['read_file', 'srv-on_ping']);
    expect(outcome.state.finalSystemPrompt.stableToolCount).toBe(1);
    // MCP-тулы активных серверов грузятся до сборки промпта
    expect(deps.collectComposerMcpServers).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'srv-on' })]),
    );
    expect((deps.mcpManager as unknown as { ensureToolsLoaded: ReturnType<typeof vi.fn> }).ensureToolsLoaded)
      .toHaveBeenCalledWith(['srv-on'], deps.toolRegistry);
  });

  it('состав серверов исполнителя обновляется ДО расчёта скоупа: найденный сервер попадает в подключаемые', async () => {
    // ADR-077 (шаг B2): если состав исполнителя обновлялся уже внутри
    // `ensureToolsLoaded`, сервер находился в этом ходе, но не попадал в
    // список подключаемых — первый ход агента после раскатки исполнителя
    // уходил без браузерных инструментов (тулы появлялись в следующем ходе).
    const { id, message } = await makeSession();
    let executorKnown = false;
    const order: string[] = [];
    const deps = makeDeps({
      mcpManager: {
        refreshExecutorServers: vi.fn(async () => {
          order.push('refresh');
          executorKnown = true;
        }),
        ensureToolsLoaded: vi.fn(async () => {
          order.push('load');
        }),
      } as unknown as McpManager,
      resolveMcpDecisions: vi.fn(() => {
        order.push('scope');
        return (executorKnown
          ? [
              { name: 'srv-on', level: 'system', enabled: true, origin: 'instance' },
              { name: 'playwright-mcp', level: 'system', enabled: true, origin: 'instance' },
            ]
          : [{ name: 'srv-on', level: 'system', enabled: true, origin: 'instance' }]
        ) as McpScopeDecision[];
      }) as never,
    });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;

    // Порядок: обновление состава → расчёт скоупа → подключение тулов.
    expect(order).toEqual(['refresh', 'scope', 'load']);
    expect(outcome.state.activeMcpServers).toEqual(['srv-on', 'playwright-mcp']);
    expect((deps.mcpManager as unknown as { ensureToolsLoaded: ReturnType<typeof vi.fn> }).ensureToolsLoaded)
      .toHaveBeenCalledWith(['srv-on', 'playwright-mcp'], deps.toolRegistry);
  });

  it('без реестра инструментов tools не выставляются, MCP не грузится', async () => {
    const { id, message } = await makeSession();
    const deps = makeDeps({ toolRegistry: null });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;
    expect(outcome.state.tools).toBeUndefined();
    expect((deps.mcpManager as unknown as { ensureToolsLoaded: ReturnType<typeof vi.fn> }).ensureToolsLoaded).not.toHaveBeenCalled();
  });

  it('tokenRatio: загруженное значение уходит в Composer, иначе дефолт', async () => {
    const { id, message } = await makeSession();
    const loaded = makeDeps({ loadTokenRatio: vi.fn(async () => 3.2) as never });
    await runProcessSetup(await makeArgs(id, message), loaded);
    expect(loaded.loadTokenRatio).toHaveBeenCalledWith('set-model');
    expect(loaded.buildComposerContext).toHaveBeenCalledWith(expect.objectContaining({ tokenRatio: 3.2 }));

    const fallback = makeDeps();
    await runProcessSetup(await makeArgs(id, message), fallback);
    expect(fallback.buildComposerContext).toHaveBeenCalledWith(
      expect.objectContaining({ tokenRatio: DEFAULT_CHARS_PER_TOKEN }),
    );
  });

  it('cancel-токен: регистрируется, cancel() абортит toolAbortController; pre-aborted signal учитывается', async () => {
    const { id, message } = await makeSession();
    const registered: Array<{ streamId: string; token: CancellationToken }> = [];
    const deps = makeDeps({
      registerCancelToken: vi.fn((streamId: string, token: CancellationToken) => {
        registered.push({ streamId, token });
      }) as never,
    });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;

    expect(registered).toHaveLength(1);
    expect(registered[0]!.streamId).toBe('stream1');
    expect(outcome.state.cancelToken.cancelled).toBe(false);
    expect(outcome.state.toolAbortController.signal.aborted).toBe(false);

    outcome.state.cancelToken.cancel();
    expect(outcome.state.cancelToken.cancelled).toBe(true);
    expect(outcome.state.toolAbortController.signal.aborted).toBe(true);

    // Гонка с отменой из очереди: signal уже абортирован до входа
    const preAborted = new AbortController();
    preAborted.abort();
    const second = await runProcessSetup(
      await makeArgs(id, message, { signal: preAborted.signal }),
      makeDeps(),
    );
    expect(second.failed).toBe(false);
    if (second.failed) return;
    expect(second.state.cancelToken.cancelled).toBe(true);
  });

  it('проектные инструкции: событие context.instructions_loaded и seed lazy-реестра (только chain)', async () => {
    const { id, message } = await makeSession();
    const seed = vi.fn();
    const deps = makeDeps({
      lazyInstructions: { seed } as never,
      resolveProjectInstructions: vi.fn(async () => ({
        instructions: { files: [] } as never,
        content: 'INSTRUCTIONS',
        files: [
          { path: '/ws/AGENTS.md', chars: 10, truncated: false, scanned: true, blocked: false, kind: 'chain' },
          { path: '/ws/sub/AGENTS.md', chars: 5, truncated: false, scanned: true, blocked: false, kind: 'lazy' },
        ],
      })) as never,
    });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);

    const event = events.find((e) => e.type === 'context.instructions_loaded')!;
    expect(event.data).toMatchObject({ session_id: id, source: 'initial', agent: 'developer' });
    expect(event.data.files).toHaveLength(2);
    // lazy-реестр сидируется только merged-chain файлами
    expect(seed).toHaveBeenCalledWith(id, ['/ws/AGENTS.md']);
  });

  it('нет проектных инструкций → события и seed нет', async () => {
    const { id, message } = await makeSession();
    const seed = vi.fn();
    const deps = makeDeps({ lazyInstructions: { seed } as never });

    await runProcessSetup(await makeArgs(id, message), deps);

    expect(events.find((e) => e.type === 'context.instructions_loaded')).toBeUndefined();
    expect(seed).not.toHaveBeenCalled();
  });

  it('summary-сообщения уходят в system prompt, но не в messages', async () => {
    const { id, message } = await makeSession();
    const summaryMessage: Message = {
      id: generateId(),
      role: MessageRole.SUMMARY,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('СУММАРИ ИСТОРИИ')],
      content: 'СУММАРИ ИСТОРИИ',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
    await sessionManager.addMessage(id, summaryMessage);
    const deps = makeDeps();

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;

    expect(deps.buildComposerContext).toHaveBeenCalledWith(
      expect.objectContaining({ summaryContent: 'СУММАРИ ИСТОРИИ' }),
    );
    expect(outcome.state.baseLlmMessages.some((m) => m.content.includes('СУММАРИ ИСТОРИИ'))).toBe(false);
  });

  it('роутер вернул решение → оно уходит дальше в состоянии', async () => {
    const { id, message } = await makeSession();
    const decision = { providerName: 'setup-provider', modelName: 'set-model', reason: 'r', strategy: 'default' as const };
    const deps = makeDeps({
      routeProvider: vi.fn(async () => ({
        provider: new SetupProvider({ url: '', apiKey: '', model: 'set-model', type: 'setup-provider' }),
        providerName: 'setup-provider',
        modelName: 'set-model',
        decision,
      })) as never,
    });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;
    expect(outcome.state.routingDecision).toEqual(decision);
    expect(outcome.state.modelName).toBe('set-model');
    expect(outcome.state.providerName).toBe('setup-provider');
  });

  it('оптимизатор отдаёт урезанную историю — она и уходит в запрос', async () => {
    const { id, message } = await makeSession();
    const extra: Message = {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('скрытая оптимизатором')],
      content: 'скрытая оптимизатором',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      metadata: { stream_id: 'other' },
      author: 'user',
    };
    await sessionManager.addMessage(id, extra);
    const deps = makeDeps({
      optimizer: {
        getMessagesForLlm: (session: { messages: Message[] }) =>
          session.messages.filter((m) => m.content !== 'скрытая оптимизатором'),
      } as never,
    });

    const outcome = await runProcessSetup(await makeArgs(id, message), deps);
    expect(outcome.failed).toBe(false);
    if (outcome.failed) return;
    expect(outcome.state.baseLlmMessages.some((m) => m.content.includes('скрытая оптимизатором'))).toBe(false);
    expect(outcome.state.messagesForLlm.some((m) => m.content.includes('вопрос'))).toBe(true);
  });
});
