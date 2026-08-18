import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { createToolRegistry } from '../tools/index.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import type { ContextBuilder } from '../context/builder.js';
import type { PermissionConfig } from '@itphx/shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/shared';
import type { Message } from '@itphx/shared';

/** Провайдер, который сначала «зовёт» write_file, затем отвечает текстом. */
class MockWriteProvider extends BaseProvider {
  private _calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/shared').LLMResponse> {
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
  ): AsyncGenerator<import('@itphx/shared').LLMChunk> {
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
        return { name, type: 'mockperm', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/shared').ProviderConfig;
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
  ): Promise<import('@itphx/shared').LLMResponse> {
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
  ): AsyncGenerator<import('@itphx/shared').LLMChunk> {
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
  ): Promise<import('@itphx/shared').LLMResponse> {
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
  ): AsyncGenerator<import('@itphx/shared').LLMChunk> {
    const next = this._next();
    MockDenyProvider.calls++;
    yield { content: next.content, isFinal: true, toolCalls: next.toolCalls, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockdeny';
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
    MockDenyProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockdouble');
    ProviderFactory['_providers'].delete('mockdeny');
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
        return { name, type: providerName, baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@itphx/shared').ProviderConfig;
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
        }));
      },
    });
    expect(result.error).toBeUndefined();
    expect(asked.length).toBe(1);
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.settings.permission?.rules.write_file).toBe('allow');
    await expect(readFile(join(tmpDir, 'double1.txt'), 'utf-8')).resolves.toBe('x');
    for (const unsub of unsubs) unsub();
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
    expect(done!.data.deny_reason).toContain('отклонено пользователем');

    // История сохранена: финальное сообщение ассистента с tool_results
    const session = (await sessionManager.getSession(sessionId))!;
    const assistant = [...session.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(assistant).toBeDefined();
    expect((assistant!.metadata as Record<string, unknown>).tool_results).toBeDefined();
    expect(assistant!.content).toContain('Обработка остановлена');
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
