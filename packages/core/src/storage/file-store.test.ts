import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import type { Session } from '@synth/shared';
import { MessageRole, makeTextPart, generateId } from '@synth/shared';

describe('FileStore', () => {
  let store: FileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-test-'));
    store = new FileStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: 'test-1',
      title: 'Test Session',
      sessionOrigin: 'user',
      userId: 'user-1',
      projectId: 'proj-1',
      engine: 'synth' as Session['engine'],
      messages: [],
      pendingMessages: [],
      status: {
        state: 'planning' as Session['status']['state'],
        iteration: 0,
        validationAttempts: 0,
        taskName: '',
      },
      settings: {
        temperature: 0.7,
        maxTokens: 4096,
        debugEnabled: true,
        streamEnabled: true,
        contextOptimization: 'none' as const,
        slidingWindowMode: 'messages' as const,
        slidingWindowMessageLimit: 10,
        slidingWindowTokenThreshold: 80,
        summarizationEnabled: false,
        summarizationTriggerMode: 'messages' as const,
        summarizeAfterN: 10,
        summarizeTokenThreshold: 50,
        summarizationHeadMessages: 2,
        summarizationTailMessages: 3,
        showInterview: true,
        websocketEnabled: true,
      },
      checkpoints: [],
      stickyNotes: [],
      summarizationPending: false,
      canSummarize: false,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      ...overrides,
    };
  }

  it('save → load roundtrip сохраняет данные', async () => {
    const session = makeSession({ id: 'roundtrip-1', title: 'Hello' });
    await store.save(session);

    const loaded = await store.load('roundtrip-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('roundtrip-1');
    expect(loaded!.title).toBe('Hello');
  });

  it('save → load сохраняет/восстанавливает сообщения', async () => {
    const session = makeSession({
      id: 'with-messages',
      messages: [
        {
          id: generateId(),
          role: MessageRole.USER,
          seq: 1,
          origin: 'local' as const,
          parts: [makeTextPart('hello')],
          content: 'hello',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
        },
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 2,
          origin: 'local' as const,
          parts: [makeTextPart('hi there')],
          content: 'hi there',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          model: 'gpt-4o',
          provider: 'openai',
        },
      ],
    });
    await store.save(session);
    const loaded = await store.load('with-messages');
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0]!.content).toBe('hello');
    expect(loaded!.messages[1]!.model).toBe('gpt-4o');
  });

  it('load несуществующей сессии возвращает null', async () => {
    const result = await store.load('no-such-id');
    expect(result).toBeNull();
  });

  it('list возвращает все сохранённые сессии', async () => {
    await store.save(makeSession({ id: 'a', title: 'A' }));
    await store.save(makeSession({ id: 'b', title: 'B' }));

    const sessions = await store.list();
    expect(sessions).toHaveLength(2);
  });

  it('list фильтрует по projectId', async () => {
    await store.save(makeSession({ id: 'a', projectId: 'p1' }));
    await store.save(makeSession({ id: 'b', projectId: 'p2' }));

    const filtered = await store.list({ projectId: 'p1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe('a');
  });

  it('exists проверяет наличие файла сессии', async () => {
    expect(await store.exists('x')).toBe(false);
    await store.save(makeSession({ id: 'x' }));
    expect(await store.exists('x')).toBe(true);
  });

  it('listForUser фильтрует по userId и ownerId', async () => {
    await store.save(makeSession({ id: 'a', userId: 'u1' }));
    await store.save(makeSession({ id: 'b', userId: 'u2', ownerId: 'u1' }));
    await store.save(makeSession({ id: 'c', userId: 'u2' }));

    const userSessions = await store.listForUser('u1');
    const ids = userSessions.map((s) => s.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
  });

  it('delete удаляет файл сессии и НЕ оставляет lock', async () => {
    await store.save(makeSession({ id: 'to-delete' }));
    expect(await store.exists('to-delete')).toBe(true);

    await store.delete('to-delete');
    expect(await store.exists('to-delete')).toBe(false);

    // Lock не должен препятствовать созданию новой сессии с тем же ID
    await store.save(makeSession({ id: 'to-delete', title: 'New' }));
    const loaded = await store.load('to-delete');
    expect(loaded!.title).toBe('New');
  });
});
