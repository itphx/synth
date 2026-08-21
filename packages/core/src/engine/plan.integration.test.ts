import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { ContextConfig } from './context/config.js';
import { createToolRegistry } from './tools/index.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { SessionSettings, Session } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

interface ScriptStep {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content?: string;
}

/**
 * Провайдер, выполняющий заданный сценарий тулов. ProviderFactory.create()
 * создаёт новый инстанс, поэтому сценарий и промпты держим в статике.
 */
class ScriptedProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _step = 0;
  private static _systemPrompts: string[] = [];

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._step = 0;
    this._systemPrompts = [];
  }

  static prompts(): string[] {
    return this._systemPrompts;
  }

  private _currentStep(): ScriptStep {
    const script = ScriptedProvider._script;
    const idx = Math.min(ScriptedProvider._step, Math.max(0, script.length - 1));
    return script[idx] ?? {};
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    const step = this._currentStep();
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${ScriptedProvider._step}`,
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    return {
      content: step.content ?? '',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls,
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = this._currentStep();
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${ScriptedProvider._step}`,
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    ScriptedProvider._systemPrompts.push(systemPrompt ?? '');
    ScriptedProvider._step++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls,
    };
  }

  getProviderName(): string {
    return 'scripted';
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
  } as unknown as ContextBuilder;
}

function makeMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('выполни задачу')],
    content: 'выполни задачу',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

describe('ChatOrchestrator × Plan/Act (AD-025/AD-027) — smoke', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-plan-int-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    ProviderFactory.register('scripted', ScriptedProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('scripted');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runScript(
    script: ScriptStep[],
    settings: Partial<SessionSettings>,
  ): Promise<{ deniedRules: string[]; session: Session | null }> {
    ScriptedProvider.configure(script);

    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'scripted', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'Plan',
      settings: { provider: 'scripted', model: 'm', systemPrompt: 'test', agentRole: 'developer', ...settings },
    });
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
    });
    expect(result.error).toBeUndefined();

    const deniedRules = chunks
      .filter((c) => c.event === 'tool_call.result')
      .map((c) => c.data.result as { isError?: boolean; metadata?: Record<string, unknown> })
      .filter((r) => r.isError === true)
      .map((r) => (r.metadata?.permission as { matched_rule?: string } | undefined)?.matched_rule)
      .filter((r): r is string => Boolean(r));

    return { deniedRules, session: await sessionManager.getSession(session.id) };
  }

  async function exists(file: string): Promise<boolean> {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }

  const writeArgs = (file: string) => ({ file_path: file, content: 'data' });

  it('plan_enter в той же итерации блокирует последующие write_file', async () => {
    const { deniedRules, session } = await runScript(
      [
        { toolCalls: [{ name: 'plan_enter', args: {} }, { name: 'write_file', args: writeArgs('a.txt') }] },
        { content: 'готово' },
      ],
      { planMode: 'auto' },
    );
    expect(deniedRules).toContain('plan.deny');
    expect(session?.mode).toBe('plan');
    expect(await exists(join(tmpDir, 'a.txt'))).toBe(false);
  });

  it('запись в .synth/plans/ заблокирована в режиме plan (AD-039: .synth не пишется)', async () => {
    const { deniedRules } = await runScript(
      [
        {
          toolCalls: [
            { name: 'plan_enter', args: {} },
            { name: 'write_file', args: writeArgs('.synth/plans/2026-01-01-100000-plan.md') },
          ],
        },
        { content: 'готово' },
      ],
      { planMode: 'auto' },
    );
    expect(deniedRules).toContain('plan.deny');
    expect(await exists(join(tmpDir, '.synth/plans/2026-01-01-100000-plan.md'))).toBe(false);
  });

  it('plan_exit переводит в act, ставит planApproved и встраивает план проекта в system prompt', async () => {
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const project = projectStore.create('Proj', 'u1');
    project.plan = {
      version: 1,
      updatedAt: nowISO(),
      columns: [
        { id: 'backlog', name: 'Бэклог', order: 0 },
        { id: 'done', name: 'Готово', order: 3 },
      ],
      items: [
        {
          id: 'p1',
          title: 'Найти причину',
          columnId: 'backlog',
          priority: 'high',
          order: 0,
          dependsOn: [],
          createdAt: nowISO(),
          updatedAt: nowISO(),
        },
      ],
    };
    await projectStore.save(project);

    ScriptedProvider.configure([
      { toolCalls: [{ name: 'plan_exit', args: {} }] },
      { toolCalls: [{ name: 'write_file', args: writeArgs('b.txt') }] },
      { content: 'готово' },
    ]);

    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'scripted', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      projectStore,
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'Plan',
      settings: { provider: 'scripted', model: 'm', systemPrompt: 'test', agentRole: 'developer', planMode: 'auto' },
    });
    session.projectId = project.id;
    await sessionManager.updateSession(session);
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const final = await sessionManager.getSession(session.id);
    expect(final?.mode).toBe('act');
    expect(final?.planApproved).toBe(true);
    await expect(readFile(join(tmpDir, 'b.txt'), 'utf-8')).resolves.toBe('data');

    // system prompt содержит план проекта (AD-039)
    const prompts = ScriptedProvider.prompts();
    expect(prompts[0]).toContain('[APPROVED PLAN]');
    expect(prompts[0]).toContain('Найти причину');
  });

  it('strict: write заблокирован до утверждения плана, разрешён после', async () => {
    const { deniedRules, session } = await runScript(
      [
        { toolCalls: [{ name: 'write_file', args: writeArgs('c1.txt') }] },
        { toolCalls: [{ name: 'plan_enter', args: {} }] },
        { toolCalls: [{ name: 'write_file', args: writeArgs('c2.txt') }] },
        { toolCalls: [{ name: 'plan_exit', args: {} }] },
        { toolCalls: [{ name: 'write_file', args: writeArgs('c3.txt') }] },
        { content: 'готово' },
      ],
      { planMode: 'strict' },
    );

    expect(deniedRules.filter((r) => r === 'plan.deny').length).toBe(2);
    expect(await exists(join(tmpDir, 'c1.txt'))).toBe(false);
    expect(await exists(join(tmpDir, 'c2.txt'))).toBe(false);
    expect(await exists(join(tmpDir, 'c3.txt'))).toBe(true);
    expect(session?.mode).toBe('act');
    expect(session?.planApproved).toBe(true);
  });

  it('off: планирование отключено, write не блокируется', async () => {
    const { deniedRules, session } = await runScript(
      [
        { toolCalls: [{ name: 'plan_enter', args: {} }, { name: 'write_file', args: writeArgs('d.txt') }] },
        { content: 'готово' },
      ],
      { planMode: 'off' },
    );
    expect(deniedRules).not.toContain('plan.deny');
    await expect(readFile(join(tmpDir, 'd.txt'), 'utf-8')).resolves.toBe('data');
    expect(session?.mode).toBe('plan');
  });

  it('todo_write сохраняет список в сессию', async () => {
    const todos = [{ content: 'шаг 1', status: 'pending', priority: 'high' }];
    const { session } = await runScript(
      [
        { toolCalls: [{ name: 'todo_write', args: { todos } }] },
        { content: 'готово' },
      ],
      { planMode: 'auto' },
    );
    expect(session?.todos).toHaveLength(1);
    expect(session?.todos?.[0]?.content).toBe('шаг 1');
    expect(session?.todos?.[0]?.status).toBe('pending');
    expect(session?.todos?.[0]?.priority).toBe('high');
    expect(session?.todos?.[0]?.id).toBeTruthy();
  });

  it('рабочий каталог проекта (project.workspace) перекрывает defaultWorkingDir', async () => {
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const wsProject = join(tmpDir, 'proj-ws');
    const wsDefault = join(tmpDir, 'default-ws');
    await mkdir(wsProject, { recursive: true });
    await mkdir(wsDefault, { recursive: true });

    ScriptedProvider.configure([
      { toolCalls: [{ name: 'write_file', args: writeArgs('x.txt') }] },
      { content: 'готово' },
    ]);

    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'scripted', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      projectStore,
      defaultWorkingDir: wsDefault,
    });

    const project = projectStore.create('Proj', 'u1', { workspace: wsProject });
    await projectStore.save(project);

    const session = await sessionManager.createSession({
      title: 'WS',
      settings: { provider: 'scripted', model: 'm', systemPrompt: 'test', agentRole: 'developer', planMode: 'off' },
    });
    session.projectId = project.id;
    await sessionManager.updateSession(session);
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    await expect(readFile(join(wsProject, 'x.txt'), 'utf-8')).resolves.toBe('data');
    await expect(exists(join(wsDefault, 'x.txt'))).resolves.toBe(false);
  });

  it('при возобновлении сессии план проекта встраивается в system prompt', async () => {
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const project = projectStore.create('Proj', 'u1');
    project.plan = {
      version: 1,
      updatedAt: nowISO(),
      columns: [
        { id: 'backlog', name: 'Бэклог', order: 0 },
        { id: 'done', name: 'Готово', order: 3 },
      ],
      items: [
        {
          id: 'p1',
          title: 'план из проекта',
          columnId: 'backlog',
          priority: 'medium',
          order: 0,
          dependsOn: [],
          createdAt: nowISO(),
          updatedAt: nowISO(),
        },
      ],
    };
    await projectStore.save(project);

    const session = await sessionManager.createSession({
      title: 'Resume',
      settings: { provider: 'scripted', model: 'm', systemPrompt: 'test', agentRole: 'developer', planMode: 'strict' },
    });
    session.projectId = project.id;
    session.planApproved = true;
    await sessionManager.updateSession(session);

    ScriptedProvider.configure([{ content: 'готово' }]);
    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'scripted', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      projectStore,
      defaultWorkingDir: tmpDir,
    });

    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    // strict + план уже утверждён → write разрешён, план в первом же промпте
    expect(ScriptedProvider.prompts()[0]).toContain('[APPROVED PLAN]');
    expect(ScriptedProvider.prompts()[0]).toContain('план из проекта');
    expect(ScriptedProvider.prompts()[0]).toContain('План утверждён');
  });

  it('mode prompt из контекстных файлов (prompts/modes/plan.md) встраивается в system prompt', async () => {
    const contextConfig = new ContextConfig({ userDataDir: tmpDir });
    ScriptedProvider.configure([{ content: 'готово' }]);

    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      contextConfig,
      providerLoader: (name: string) => {
        return { name, type: 'scripted', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'ModePrompt',
      settings: { provider: 'scripted', model: 'm', systemPrompt: 'test', agentRole: 'developer', planMode: 'auto' },
    });
    session.mode = 'plan';
    await sessionManager.updateSession(session);
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const prompts = ScriptedProvider.prompts();
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0]).toContain('[MODE: PLAN]');
    expect(prompts[0]).toContain('Не вноси никаких изменений');
  });

  it('fallback: без contextConfig режим plan использует встроенный текст', async () => {
    ScriptedProvider.configure([{ content: 'готово' }]);

    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'scripted', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'ModeFallback',
      settings: { provider: 'scripted', model: 'm', systemPrompt: 'test', agentRole: 'developer', planMode: 'auto' },
    });
    session.mode = 'plan';
    await sessionManager.updateSession(session);
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    const prompts = ScriptedProvider.prompts();
    expect(prompts[0]).toContain('[MODE: PLAN]');
    expect(prompts[0]).toContain('Работай с планом проекта через plan_read/plan_write');
  });
});
