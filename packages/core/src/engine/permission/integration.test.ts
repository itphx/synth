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
import type { PermissionConfig } from '@synth/shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@synth/shared';
import type { Message } from '@synth/shared';

/** Провайдер, который сначала «зовёт» write_file, затем отвечает текстом. */
class MockWriteProvider extends BaseProvider {
  private _calls = 0;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@synth/shared').LLMResponse> {
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
  ): AsyncGenerator<import('@synth/shared').LLMChunk> {
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
    opts?: { onSession?: (sessionId: string) => void },
  ): Promise<{ denied: boolean; fileCreated: boolean }> {
    const toolRegistry = createToolRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => {
        return { name, type: 'mockperm', baseUrl: '', apiKey: '', defaultModel: 'm' } as unknown as import('@synth/shared').ProviderConfig;
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
});
