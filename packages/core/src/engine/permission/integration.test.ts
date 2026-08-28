import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { PermissionEvaluator, extractPaths } from '../permission/evaluator.js';
import { createToolRegistry } from '../tools/index.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { PermissionConfig, PermissionRule } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

const HOME = homedir();

/** Провайдер, который сначала «зовёт» write_file, затем отвечает текстом. */
class MockWriteProvider extends BaseProvider {
  private _calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    let content = 'Готово';
    let toolCalls: Record<string, unknown>[] | undefined;
    if (this._calls === 0) {
      content = '';
      toolCalls = [{
        id: 'call_write',
        function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'smoke.txt', content: 'smoke-data' }) },
      }];
    }
    this._calls++;
    return { content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    let content = 'Готово';
    let toolCalls: Record<string, unknown>[] | undefined;
    if (this._calls === 0) {
      content = '';
      toolCalls = [{
        id: 'call_write',
        function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'smoke.txt', content: 'smoke-data' }) },
      }];
    }
    this._calls++;
    yield { content, isFinal: true, toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockperm';
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
    parts: [makeTextPart('напиши файл')],
    content: 'напиши файл',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

describe('ChatOrchestrator × permissions (AD-029) — smoke', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-perm-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    ProviderFactory.register('mockperm', MockWriteProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockperm');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runSession(
    permissionConfig: PermissionConfig,
    opts?: { onSession?: (sessionId: string) => void; mode?: 'plan' | 'act' | 'yolo' },
  ): Promise<{ denied: boolean; fileCreated: boolean }> {
    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'mockperm', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig,
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'Smoke',
      settings: {
        provider: 'mockperm',
        model: 'm',
        systemPrompt: 'test',
        agentRole: 'developer',
      },
    });
    if (opts?.mode) {
      session.mode = opts.mode;
      await sessionManager.updateSession(session);
    }
    opts?.onSession?.(session.id);
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
    });
    expect(result.error).toBeUndefined();

    const toolResults = chunks
      .filter((c) => c.event === 'tool_call.result')
      .map((c) => c.data.result as { content: string; isError?: boolean });
    const denied = toolResults.some((r) => r.isError === true && r.content.includes('Permission denied'));

    let fileCreated = false;
    try {
      await access(join(tmpDir, 'smoke.txt'));
      fileCreated = true;
    } catch {
      fileCreated = false;
    }
    return { denied, fileCreated };
  }

  it('deny на write_file — тул блокируется, файл не создаётся', async () => {
    const r = await runSession({ rules: { write_file: 'deny' }, askTimeoutMs: 1000 });
    expect(r.denied).toBe(true);
    expect(r.fileCreated).toBe(false);
  });

  it('allow — тул выполняется, файл создаётся', async () => {
    const r = await runSession({ rules: { write_file: 'allow' }, askTimeoutMs: 1000 });
    expect(r.denied).toBe(false);
    expect(r.fileCreated).toBe(true);
    await expect(readFile(join(tmpDir, 'smoke.txt'), 'utf-8')).resolves.toBe('smoke-data');
  });

  it('пустой конфиг — поведение как раньше, файл создаётся', async () => {
    const r = await runSession({ rules: {}, askTimeoutMs: 1000 });
    expect(r.denied).toBe(false);
    expect(r.fileCreated).toBe(true);
  });

  it('ask — подписчик подтверждает через EventBus, тул выполняется', async () => {
    let sessionId = '';
    const unsubs: Array<() => void> = [];
    const r = await runSession({ rules: { write_file: 'ask' }, askTimeoutMs: 2000 }, {
      onSession: (id) => {
        sessionId = id;
        // Внешний подписчик (имитация UI): слушает permission.asked и отвечает allow
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') {
            eventBus.publish(id, 'permission.replied', {
              approval_id: (e.data as Record<string, unknown>).approval_id as string,
              approved: true,
            });
          }
        }));
      },
    });
    expect(sessionId).not.toBe('');
    expect(r.denied).toBe(false);
    expect(r.fileCreated).toBe(true);
    for (const unsub of unsubs) unsub();
  });

  it('ask — подписчик отклоняет, тул блокируется', async () => {
    const unsubs: Array<() => void> = [];
    const r = await runSession({ rules: { write_file: 'ask' }, askTimeoutMs: 2000 }, {
      onSession: (id) => {
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') {
            eventBus.publish(id, 'permission.replied', {
              approval_id: (e.data as Record<string, unknown>).approval_id as string,
              approved: false,
            });
          }
        }));
      },
    });
    expect(r.denied).toBe(true);
    expect(r.fileCreated).toBe(false);
    for (const unsub of unsubs) unsub();
  });

  it('ask — нет подписчиков: мгновенный отказ (noSubscribers)', async () => {
    const r = await runSession({ rules: { write_file: 'ask' }, askTimeoutMs: 2000 });
    expect(r.denied).toBe(true);
    expect(r.fileCreated).toBe(false);
  });

  it('yolo — ask автоматически подтверждается, permission.asked не публикуется', async () => {
    let sessionId = '';
    const asked: Array<Record<string, unknown>> = [];
    const unsubs: Array<() => void> = [];
    const r = await runSession({ rules: { write_file: 'ask' }, askTimeoutMs: 2000 }, {
      mode: 'yolo',
      onSession: (id) => {
        sessionId = id;
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') asked.push(e.data as Record<string, unknown>);
        }));
      },
    });
    expect(sessionId).not.toBe('');
    // ask не возникает: тул выполняется автоматически, файл создаётся
    expect(asked.length).toBe(0);
    expect(r.denied).toBe(false);
    expect(r.fileCreated).toBe(true);
    for (const unsub of unsubs) unsub();
  });
});

/** Провайдер, который дважды «зовёт» write_file, затем отвечает текстом. */
class MockDoubleWriteProvider extends BaseProvider {
  private _calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (this._calls < 2) {
      const n = this._calls;
      return {
        content: '',
        toolCalls: [{
          id: `call_w${n}`,
          function: { name: 'write_file', arguments: JSON.stringify({ file_path: `double${n}.txt`, content: 'x' }) },
        }],
      };
    }
    return { content: 'Готово' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    this._calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    this._calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdouble';
  }
}

/** Провайдер: первый вызов — write_file, второй — текст. Статический счётчик вызовов LLM. */
class MockDenyProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (MockDenyProvider.calls === 0) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_deny',
          function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'deny.txt', content: 'x' }) },
        }],
      };
    }
    return { content: 'Второй вызов — не должен случиться' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockDenyProvider.calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    MockDenyProvider.calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdeny';
  }
}

/** Провайдер: первый вызов — read_file ~/.ssh/config, второй — текст. */
class MockReadProvider extends BaseProvider {
  private _calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (this._calls === 0) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_read',
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: '~/.ssh/config' }) },
        }],
      };
    }
    return { content: 'Готово' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    this._calls++;
    return { content: next.content, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: next.toolCalls };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    this._calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockread';
  }
}

describe('ChatOrchestrator × permissions — once:false и deny (AD-029)', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-perm2-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    ProviderFactory.register('mockdouble', MockDoubleWriteProvider);
    ProviderFactory.register('mockdeny', MockDenyProvider);
    ProviderFactory.register('mockread', MockReadProvider);
    MockDenyProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockdouble');
    ProviderFactory['_providers'].delete('mockdeny');
    ProviderFactory['_providers'].delete('mockread');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runRaw(
    providerName: string,
    permissionConfig: PermissionConfig,
    opts?: { onSession?: (sessionId: string) => void },
  ): Promise<{ result: import('../orchestrator.js').ProcessMessageResult; chunks: Array<{ event: string; data: Record<string, unknown> }>; sessionId: string }> {
    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: providerName, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig,
      defaultWorkingDir: tmpDir,
    });

    const session = await sessionManager.createSession({
      title: 'Smoke2',
      settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'developer' },
    });
    opts?.onSession?.(session.id);
    const msg = makeMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
    });
    return { result, chunks, sessionId: session.id };
  }

  it('ask + once:false — allow-правило добавляется в сессию, повторный вызов не спрашивает', async () => {
    let sessionId = '';
    const asked: Array<Record<string, unknown>> = [];
    const unsubs: Array<() => void> = [];
    const updates: Array<Record<string, unknown>> = [];
    const { result } = await runRaw('mockdouble', { rules: { write_file: 'ask' }, askTimeoutMs: 2000 }, {
      onSession: (id) => {
        sessionId = id;
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') {
            asked.push(e.data as Record<string, unknown>);
            eventBus.publish(id, 'permission.replied', {
              approval_id: (e.data as Record<string, unknown>).approval_id as string,
              session_id: id,
              action: 'allow',
              once: false,
            });
          }
          if (e.type === 'session.updated') {
            updates.push(e.data as Record<string, unknown>);
          }
        }));
      },
    });
    expect(result.error).toBeUndefined();
    expect(asked.length).toBe(1);
    const session = (await sessionManager.getSession(sessionId))!;
    // Грант одобряет КОНКРЕТНЫЙ путь, а не весь тул: правило-объект { путь: 'allow' }
    const absPath0 = extractPaths('write_file', { file_path: 'double0.txt' }, tmpDir)[0]!;
    const writeRule = session.settings.permission?.rules.write_file as Record<string, string> | undefined;
    expect(writeRule).toBeDefined();
    expect(writeRule).toEqual({ [absPath0]: 'allow' });
    // Тот же путь через PermissionEvaluator → allow; другой путь → не allow (ask по '*')
    const evalCfg: PermissionConfig = { rules: { write_file: writeRule as PermissionRule, '*': 'ask' }, askTimeoutMs: 1000 };
    expect(new PermissionEvaluator(evalCfg).check({ toolName: 'write_file', params: { file_path: 'double0.txt' }, workingDir: tmpDir }).action).toBe('allow');
    expect(new PermissionEvaluator(evalCfg).check({ toolName: 'write_file', params: { file_path: 'double1.txt' }, workingDir: tmpDir }).action).toBe('ask');
    // При гранте публикуется session.updated с обновлённым permission-конфигом
    const lastUpdate = updates.at(-1);
    expect(lastUpdate).toBeDefined();
    expect(lastUpdate!.session_id).toBe(sessionId);
    const updatedSettings = lastUpdate!.settings as { permission?: { rules?: Record<string, Record<string, string>> } } | undefined;
    expect(updatedSettings?.permission?.rules?.write_file).toEqual({ [absPath0]: 'allow' });
    await expect(readFile(join(tmpDir, 'double1.txt'), 'utf-8')).resolves.toBe('x');
    for (const unsub of unsubs) unsub();
  });

  it('once:false для read_file ~/.ssh/config — грант пишет канонический HOME-путь', async () => {
    let sessionId = '';
    const unsubs: Array<() => void> = [];
    const updates: Array<Record<string, unknown>> = [];
    const { result } = await runRaw('mockread', { rules: { read_file: 'ask' }, askTimeoutMs: 2000 }, {
      onSession: (id) => {
        sessionId = id;
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') {
            eventBus.publish(id, 'permission.replied', {
              approval_id: (e.data as Record<string, unknown>).approval_id as string,
              session_id: id,
              action: 'allow',
              once: false,
            });
          }
          if (e.type === 'session.updated') {
            updates.push(e.data as Record<string, unknown>);
          }
        }));
      },
    });
    expect(result.error).toBeUndefined();
    const session = (await sessionManager.getSession(sessionId))!;
    // Тильда раскрывается: пишется канонический <HOME>/.ssh/config, а не <workingDir>/~/.ssh/config
    const canonical = join(HOME, '.ssh/config');
    const readRule = session.settings.permission?.rules.read_file as Record<string, string> | undefined;
    expect(readRule).toBeDefined();
    expect(readRule).toEqual({ [canonical]: 'allow' });
    // Повторный вызов read_file (тильда И абсолютный путь) → allow
    const evalCfg: PermissionConfig = { rules: { read_file: readRule as PermissionRule, '*': 'ask' }, askTimeoutMs: 1000 };
    expect(new PermissionEvaluator(evalCfg).check({ toolName: 'read_file', params: { file_path: '~/.ssh/config' }, workingDir: tmpDir }).action).toBe('allow');
    expect(new PermissionEvaluator(evalCfg).check({ toolName: 'read_file', params: { file_path: canonical }, workingDir: tmpDir }).action).toBe('allow');
    const lastUpdate = updates.at(-1);
    expect(lastUpdate).toBeDefined();
    const updatedSettings = lastUpdate!.settings as { permission?: { rules?: Record<string, Record<string, string>> } } | undefined;
    expect(updatedSettings?.permission?.rules?.read_file).toEqual({ [canonical]: 'allow' });
    for (const unsub of unsubs) unsub();
  });

  it('ask в дочерней сессии (parentId) с once:false — грант появляется и в родителе', async () => {
    const parent = await sessionManager.createSession({ title: 'Parent' });
    const child = await sessionManager.createSession({
      title: 'Child',
      parentId: parent.id,
      settings: { provider: 'mockread', model: 'm', systemPrompt: 'test', agentRole: 'explore' },
    });

    const asked: Array<Record<string, unknown>> = [];
    const childUpdates: Array<Record<string, unknown>> = [];
    const parentUpdates: Array<Record<string, unknown>> = [];
    const unsubChild = eventBus.subscribe(child.id, (e) => {
      if (e.type === 'permission.asked') {
        asked.push(e.data as Record<string, unknown>);
        eventBus.publish(child.id, 'permission.replied', {
          approval_id: (e.data as Record<string, unknown>).approval_id as string,
          session_id: child.id,
          action: 'allow',
          once: false,
        });
      }
      if (e.type === 'session.updated') childUpdates.push(e.data as Record<string, unknown>);
    });
    const unsubParent = eventBus.subscribe(parent.id, (e) => {
      if (e.type === 'session.updated') parentUpdates.push(e.data as Record<string, unknown>);
    });

    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'mockread', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/synth-shared').ProviderConfig;
      },
      toolRegistry,
      permissionConfig: { rules: { read_file: 'ask' }, askTimeoutMs: 2000 },
      defaultWorkingDir: tmpDir,
    });

    const msg = makeMessage();
    await sessionManager.addMessage(child.id, msg);
    const freshChild = (await sessionManager.getSession(child.id))!;
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(freshChild, msg, new AbortController().signal, () => {});
    expect(result.error).toBeUndefined();

    expect(asked.length).toBe(1);
    const canonical = join(HOME, '.ssh/config');
    const childSession = (await sessionManager.getSession(child.id))!;
    const parentSession = (await sessionManager.getSession(parent.id))!;

    const childRule = childSession.settings.permission?.rules.read_file as Record<string, string> | undefined;
    expect(childRule).toEqual({ [canonical]: 'allow' });
    const parentRule = parentSession.settings.permission?.rules.read_file as Record<string, string> | undefined;
    expect(parentRule).toEqual({ [canonical]: 'allow' });

    // Повторный вызов read_file того же пути через PermissionEvaluator → allow
    const childEval: PermissionConfig = { rules: { read_file: childRule as PermissionRule, '*': 'ask' }, askTimeoutMs: 1000 };
    expect(new PermissionEvaluator(childEval).check({ toolName: 'read_file', params: { file_path: canonical }, workingDir: tmpDir }).action).toBe('allow');
    const parentEval: PermissionConfig = { rules: { read_file: parentRule as PermissionRule, '*': 'ask' }, askTimeoutMs: 1000 };
    expect(new PermissionEvaluator(parentEval).check({ toolName: 'read_file', params: { file_path: canonical }, workingDir: tmpDir }).action).toBe('allow');

    // session.updated опубликован и для дочерней, и для родительской сессии
    const lastChildUpdate = childUpdates.at(-1);
    expect(lastChildUpdate).toBeDefined();
    expect(lastChildUpdate!.session_id).toBe(child.id);
    const lastParentUpdate = parentUpdates.at(-1);
    expect(lastParentUpdate).toBeDefined();
    expect(lastParentUpdate!.session_id).toBe(parent.id);
    const parentUpdatedSettings = lastParentUpdate!.settings as { permission?: { rules?: Record<string, Record<string, string>> } } | undefined;
    expect(parentUpdatedSettings?.permission?.rules?.read_file).toEqual({ [canonical]: 'allow' });

    for (const unsub of [unsubChild, unsubParent]) unsub();
  });

  it('ask + once:true — allow только один раз, повторный вызов снова спрашивает', async () => {
    let sessionId = '';
    const asked: Array<Record<string, unknown>> = [];
    const unsubs: Array<() => void> = [];
    const { result } = await runRaw('mockdouble', { rules: { write_file: 'ask' }, askTimeoutMs: 2000 }, {
      onSession: (id) => {
        sessionId = id;
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') {
            asked.push(e.data as Record<string, unknown>);
            eventBus.publish(id, 'permission.replied', {
              approval_id: (e.data as Record<string, unknown>).approval_id as string,
              session_id: id,
              action: 'allow',
              once: true,
            });
          }
        }));
      },
    });
    expect(result.error).toBeUndefined();
    expect(asked.length).toBe(2);
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.settings.permission).toBeUndefined();
    for (const unsub of unsubs) unsub();
  });

  it('ask→deny от пользователя — обработка завершается, история tool_result сохраняется', async () => {
    let sessionId = '';
    const unsubs: Array<() => void> = [];
    const { result, chunks } = await runRaw('mockdeny', { rules: { write_file: 'ask' }, askTimeoutMs: 2000 }, {
      onSession: (id) => {
        sessionId = id;
        unsubs.push(eventBus.subscribe(id, (e) => {
          if (e.type === 'permission.asked') {
            eventBus.publish(id, 'permission.replied', {
              approval_id: (e.data as Record<string, unknown>).approval_id as string,
              session_id: id,
              action: 'deny',
              once: true,
            });
          }
        }));
      },
    });
    expect(result.error).toBeUndefined();

    // Цикл LLM не продолжается: провайдер вызван ровно один раз
    expect(MockDenyProvider.calls).toBe(1);

    // Файл не создан
    await expect(access(join(tmpDir, 'deny.txt'))).rejects.toThrow();

    // stream.done помечен как остановленный пользователем
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done).toBeDefined();
    expect(done!.data.stopped_by_deny).toBe(true);
    expect(done!.data.deny_reason).toContain('denied by the user');

    // История сохранена: финальное сообщение ассистента с tool_results
    const session = (await sessionManager.getSession(sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant).toBeDefined();
    expect((assistant!.metadata as Record<string, unknown>).tool_results).toBeDefined();
    expect(assistant!.content).toContain('Processing stopped');
    for (const unsub of unsubs) unsub();
  });

  it('ask→deny (timeout) — цикл продолжается, история не помечается stopped_by_deny', async () => {
    const unsubs: Array<() => void> = [];
    const { result, chunks } = await runRaw('mockdeny', { rules: { write_file: 'ask' }, askTimeoutMs: 50 }, {
      onSession: (id) => {
        // Подписчик есть (иначе noSubscribers), но не отвечает — таймаут
        unsubs.push(eventBus.subscribe(id, () => {}));
      },
    });
    expect(result.error).toBeUndefined();
    // Таймаут не останавливает обработку — провайдер вызван повторно
    expect(MockDenyProvider.calls).toBe(2);
    const done = chunks.find((c) => c.event === 'stream.done');
    expect(done!.data.stopped_by_deny).toBeUndefined();
    for (const unsub of unsubs) unsub();
  });
});
