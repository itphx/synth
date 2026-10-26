import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import type { Session } from '@itphx/synth-shared';
import { MessageRole, makeTextPart, generateId } from '@itphx/synth-shared';

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
      messages: [],
      pendingMessages: [],
      status: {},
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
        routingEnabled: true,
        routingStrategy: 'auto',
        routingContent: { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
        routingEscalation: { enabled: true, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
        routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
        subagentRouting: { enabled: true },
        microFirst: false,
        microConfidenceThreshold: 0.8,
        embeddingEnabled: false,
      },
      checkpoints: [],
      stickyNotes: [],
      references: [],
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

  it('save → load сохраняет qa_pass/qa_reason (QC-бейдж, ADR-034)', async () => {
    const session = makeSession({
      id: 'with-qa',
      messages: [
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 1,
          origin: 'local' as const,
          parts: [makeTextPart('answer')],
          content: 'answer',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          qa_pass: false,
          qa_reason: 'Response is shorter than 10 characters',
        },
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 2,
          origin: 'local' as const,
          parts: [makeTextPart('escalated')],
          content: 'escalated',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          qa_pass: true,
          qa_reason: 'router.escalation',
        },
      ],
    });
    await store.save(session);

    // Поля уезжают на диск в snake_case JSON.
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'with-qa.json'), 'utf-8'));
    expect(raw.messages[0].qa_pass).toBe(false);
    expect(raw.messages[0].qa_reason).toBe('Response is shorter than 10 characters');
    expect(raw.messages[1].qa_pass).toBe(true);
    expect(raw.messages[1].qa_reason).toBe('router.escalation');

    const loaded = await store.load('with-qa');
    expect(loaded!.messages[0]!.qa_pass).toBe(false);
    expect(loaded!.messages[0]!.qa_reason).toBe('Response is shorter than 10 characters');
    expect(loaded!.messages[1]!.qa_pass).toBe(true);
    expect(loaded!.messages[1]!.qa_reason).toBe('router.escalation');
  });

  it('legacy-сообщение без qa_pass/qa_reason читается как раньше (undefined, без дефолтов)', async () => {
    const session = makeSession({
      id: 'legacy-qa',
      messages: [
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 1,
          origin: 'local' as const,
          parts: [makeTextPart('legacy answer')],
          content: 'legacy answer',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
        },
      ],
    });
    await store.save(session);

    // В файле ключей нет вовсе — это и есть legacy-формат.
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'legacy-qa.json'), 'utf-8'));
    expect('qa_pass' in raw.messages[0]).toBe(false);
    expect('qa_reason' in raw.messages[0]).toBe(false);

    const loaded = await store.load('legacy-qa');
    expect(loaded).not.toBeNull();
    expect(loaded!.messages[0]!.content).toBe('legacy answer');
    expect(loaded!.messages[0]!.qa_pass).toBeUndefined();
    expect(loaded!.messages[0]!.qa_reason).toBeUndefined();
  });

  it('ADR-114: save → load сохраняет привязку к worktree (переживает рестарт)', async () => {
    const session = makeSession({
      id: 'with-worktree',
      worktree: {
        worktreeId: 'wkt_1',
        projectId: 'proj-1',
        repoPath: 'repo',
        directory: '/workspaces/.worktrees/proj-1/feature-x',
        branch: 'feature/x',
      },
    });
    await store.save(session);

    // На диске — snake_case (как соседние составные поля записи сессии).
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'with-worktree.json'), 'utf-8'));
    expect(raw.worktree).toEqual({
      worktree_id: 'wkt_1',
      project_id: 'proj-1',
      repo_path: 'repo',
      directory: '/workspaces/.worktrees/proj-1/feature-x',
      branch: 'feature/x',
    });

    const loaded = await store.load('with-worktree');
    expect(loaded!.worktree).toEqual({
      worktreeId: 'wkt_1',
      projectId: 'proj-1',
      repoPath: 'repo',
      directory: '/workspaces/.worktrees/proj-1/feature-x',
      branch: 'feature/x',
    });
  });

  it('ADR-114: сессия без привязки читается как прежде (поле отсутствует)', async () => {
    await store.save(makeSession({ id: 'no-worktree' }));

    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'no-worktree.json'), 'utf-8'));
    expect('worktree' in raw).toBe(false);

    const loaded = await store.load('no-worktree');
    expect(loaded).not.toBeNull();
    expect(loaded!.worktree).toBeUndefined();
  });

  it('ADR-114: частичная привязка (без worktree_id/directory) игнорируется', async () => {
    await store.save(makeSession({ id: 'partial-worktree' }));

    // Ручная запись в JSON-файл: привязка без обязательных полей.
    const path = join(tmpDir, 'sessions', 'partial-worktree.json');
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    raw.worktree = { project_id: 'proj-1', branch: 'main' };
    await writeFile(path, JSON.stringify(raw), 'utf-8');

    const loaded = await store.load('partial-worktree');
    expect(loaded!.worktree).toBeUndefined();
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

  it('listForUser с ownerIds (ADR-089): legacy-UUID владельца трактуется как свой', async () => {
    await store.save(makeSession({ id: 'legacy', userId: 'profile-uuid', ownerId: 'profile-uuid' }));
    await store.save(makeSession({ id: 'foreign', userId: 'other-uuid', ownerId: 'other-uuid' }));

    // Без алиасов — legacy не наш.
    expect((await store.listForUser('local')).map((s) => s.id)).not.toContain('legacy');

    // С алиасом (UUID профиля `local`) — виден локальному `local`.
    const ids = (await store.listForUser('local', ['local', 'profile-uuid'])).map((s) => s.id);
    expect(ids).toContain('legacy');
    expect(ids).not.toContain('foreign');

    // listForUserScope с projectIds — алиасы тоже учитываются.
    const scoped = (await store.listForUserScope('local', ['p-x'], ['profile-uuid'])).map((s) => s.id);
    expect(scoped).toContain('legacy');
    expect(scoped).not.toContain('foreign');
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
