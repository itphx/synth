import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('Anthropic: reasoning + reasoningSignature + reasoningRedacted переживают save → load', async () => {
    const session = makeSession({
      id: 'with-thinking',
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
          model: 'claude-sonnet-4',
          provider: 'anthropic',
          reasoning: 'размышление',
          reasoningSignature: 'sig-roundtrip',
          reasoningRedacted: ['opaque-1', 'opaque-2'],
        },
        {
          // Пустая подпись — валидное значение (RouterAI/qwen), не «нет подписи».
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 2,
          origin: 'local' as const,
          parts: [makeTextPart('second')],
          content: 'second',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          reasoning: 'ещё',
          reasoningSignature: '',
        },
      ],
    });
    await store.save(session);

    // На диске — snake_case (как соседние поля сообщения).
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'with-thinking.json'), 'utf-8'));
    expect(raw.messages[0].reasoning).toBe('размышление');
    expect(raw.messages[0].reasoning_signature).toBe('sig-roundtrip');
    expect(raw.messages[0].reasoning_redacted).toEqual(['opaque-1', 'opaque-2']);
    expect(raw.messages[1].reasoning_signature).toBe('');

    const loaded = await store.load('with-thinking');
    expect(loaded!.messages[0]!.reasoning).toBe('размышление');
    expect(loaded!.messages[0]!.reasoningSignature).toBe('sig-roundtrip');
    expect(loaded!.messages[0]!.reasoningRedacted).toEqual(['opaque-1', 'opaque-2']);
    expect(loaded!.messages[1]!.reasoningSignature).toBe('');
    expect(loaded!.messages[1]!.reasoningRedacted).toBeUndefined();
  });

  it('Anthropic: legacy-сообщение без подписи читается как undefined, reasoning-часть восстанавливается', async () => {
    // parts нет — legacy-формат: части строятся из content/reasoning.
    const legacyMessage: Record<string, unknown> = {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 1,
      origin: 'local',
      // Пустой массив = «частей нет»: чтение строит их из content/reasoning.
      parts: [],
      content: 'legacy answer',
      reasoning: 'legacy thinking',
      createdAt: new Date().toISOString(),
      disabled: false,
      pinned: false,
      hidden: false,
    };

    const session = makeSession({
      id: 'legacy-thinking',
      messages: [legacyMessage as unknown as Session['messages'][number]],
    });
    await store.save(session);

    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'legacy-thinking.json'), 'utf-8'));
    expect('reasoning_signature' in raw.messages[0]).toBe(false);
    expect('reasoning_redacted' in raw.messages[0]).toBe(false);

    const loaded = await store.load('legacy-thinking');
    expect(loaded!.messages[0]!.reasoning).toBe('legacy thinking');
    expect(loaded!.messages[0]!.reasoningSignature).toBeUndefined();
    expect(loaded!.messages[0]!.reasoningRedacted).toBeUndefined();
    expect(loaded!.messages[0]!.parts).toEqual([
      expect.objectContaining({ type: 'text', data: 'legacy answer' }),
      expect.objectContaining({ type: 'reasoning', data: 'legacy thinking' }),
    ]);
  });

  it('Anthropic: мульти-блочная подпись (parts.metadata) переживает save → load', async () => {
    const session = makeSession({
      id: 'with-reasoning-parts',
      messages: [
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 1,
          origin: 'local' as const,
          parts: [
            makeTextPart('ответ'),
            { id: generateId(), type: 'reasoning' as const, data: 'блок A', metadata: { signature: 'sig-a' } },
            { id: generateId(), type: 'reasoning' as const, data: 'блок B', metadata: { signature: 'sig-b' } },
            // redacted_thinking — часть без текста, только opaque-данные.
            { id: generateId(), type: 'reasoning' as const, data: '', metadata: { redacted: 'opaque-1' } },
          ],
          content: 'ответ',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          model: 'claude-sonnet-4',
          provider: 'anthropic',
        },
      ],
    });
    await store.save(session);

    // Подпись уезжает на диск рядом с частью (не в legacy-поля сообщения).
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'with-reasoning-parts.json'), 'utf-8'));
    expect(raw.messages[0].parts[1].metadata).toEqual({ signature: 'sig-a' });
    expect(raw.messages[0].parts[2].metadata).toEqual({ signature: 'sig-b' });
    expect(raw.messages[0].parts[3].metadata).toEqual({ redacted: 'opaque-1' });
    expect(raw.messages[0].reasoning_signature).toBe(undefined);

    const loaded = await store.load('with-reasoning-parts');
    const parts = loaded!.messages[0]!.parts.filter((part) => part.type === 'reasoning');
    expect(parts.map((part) => part.data)).toEqual(['блок A', 'блок B', '']);
    // Подпись принадлежит своему блоку — порядок и значения сохранены.
    expect(parts.map((part) => part.metadata)).toEqual([
      { signature: 'sig-a' },
      { signature: 'sig-b' },
      { redacted: 'opaque-1' },
    ]);

    // `content` — только текст ответа: reasoning-части служебные и в строковую
    // производную не подмешиваются (раньше после перезагрузки появлялся
    // `<reasoning>…</reasoning>`).
    expect(loaded!.messages[0]!.content).toBe('ответ');
    expect(loaded!.messages[0]!.content).not.toContain('<reasoning>');
  });

  it('Anthropic: reasoning-часть без metadata (legacy) читается как undefined', async () => {
    const session = makeSession({
      id: 'legacy-reasoning-part',
      messages: [
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 1,
          origin: 'local' as const,
          parts: [
            makeTextPart('ответ'),
            { id: generateId(), type: 'reasoning' as const, data: 'старый блок' },
          ],
          content: 'ответ',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
        },
      ],
    });
    await store.save(session);

    // В файле ключа `metadata` нет вовсе — это и есть legacy-формат части.
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'legacy-reasoning-part.json'), 'utf-8'));
    expect('metadata' in raw.messages[0].parts[1]).toBe(false);

    const loaded = await store.load('legacy-reasoning-part');
    const reasoning = loaded!.messages[0]!.parts.find((part) => part.type === 'reasoning')!;
    expect(reasoning.data).toBe('старый блок');
    expect(reasoning.metadata).toBeUndefined();
    expect(loaded!.messages[0]!.content).toBe('ответ');
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

  it('ADR-118: ord/turnId/stepIndex/status переживают save → load', async () => {
    const session = makeSession({
      id: 'with-adr118',
      messages: [
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 1,
          origin: 'local' as const,
          parts: [makeTextPart('step 0')],
          content: 'step 0',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          ord: 7,
          turnId: 'turn-1',
          stepIndex: 0,
          status: 'completed',
        },
        {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 2,
          origin: 'local' as const,
          parts: [makeTextPart('step 1')],
          content: 'step 1',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
          ord: 8,
          turnId: 'turn-1',
          stepIndex: 1,
          status: 'streaming',
        },
      ],
    });
    await store.save(session);

    // На диске — snake_case (как соседние составные поля сообщения).
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'with-adr118.json'), 'utf-8'));
    expect(raw.messages[0].ord).toBe(7);
    expect(raw.messages[0].turn_id).toBe('turn-1');
    expect(raw.messages[0].step_index).toBe(0);
    expect(raw.messages[0].status).toBe('completed');
    expect(raw.messages[1].ord).toBe(8);
    expect(raw.messages[1].step_index).toBe(1);
    expect(raw.messages[1].status).toBe('streaming');

    const loaded = await store.load('with-adr118');
    expect(loaded!.messages[0]!.ord).toBe(7);
    expect(loaded!.messages[0]!.turnId).toBe('turn-1');
    expect(loaded!.messages[0]!.stepIndex).toBe(0);
    expect(loaded!.messages[0]!.status).toBe('completed');
    expect(loaded!.messages[1]!.ord).toBe(8);
    expect(loaded!.messages[1]!.turnId).toBe('turn-1');
    expect(loaded!.messages[1]!.stepIndex).toBe(1);
    expect(loaded!.messages[1]!.status).toBe('streaming');
  });

  it('ADR-118: legacy-сообщение без ord/turn_id/step_index/status читается как undefined', async () => {
    const session = makeSession({
      id: 'legacy-adr118',
      messages: [
        {
          id: generateId(),
          role: MessageRole.USER,
          seq: 1,
          origin: 'local' as const,
          parts: [makeTextPart('legacy')],
          content: 'legacy',
          createdAt: new Date().toISOString(),
          disabled: false,
          pinned: false,
          hidden: false,
        },
      ],
    });
    await store.save(session);

    // В файле ключей нет вовсе — это и есть legacy-формат.
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'legacy-adr118.json'), 'utf-8'));
    expect('ord' in raw.messages[0]).toBe(false);
    expect('turn_id' in raw.messages[0]).toBe(false);
    expect('step_index' in raw.messages[0]).toBe(false);
    expect('status' in raw.messages[0]).toBe(false);

    const loaded = await store.load('legacy-adr118');
    expect(loaded).not.toBeNull();
    expect(loaded!.messages[0]!.content).toBe('legacy');
    expect(loaded!.messages[0]!.ord).toBeUndefined();
    expect(loaded!.messages[0]!.turnId).toBeUndefined();
    expect(loaded!.messages[0]!.stepIndex).toBeUndefined();
    expect(loaded!.messages[0]!.status).toBeUndefined();
  });

  it('ADR-118: current_stream без хода пишется как turn_id: null, читается как turnId === undefined', async () => {
    await store.save(makeSession({
      id: 'stream-no-turn',
      currentStream: {
        streamId: 'stream-1',
        message: 'в работе',
        startedAt: new Date().toISOString(),
        cancelled: false,
      },
    }));

    // На диске — единое представление «хода нет» (`null`, а не отсутствие ключа).
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'stream-no-turn.json'), 'utf-8'));
    expect(raw.current_stream.turn_id).toBeNull();

    const loaded = await store.load('stream-no-turn');
    expect(loaded!.currentStream).toBeDefined();
    expect(loaded!.currentStream!.streamId).toBe('stream-1');
    expect(loaded!.currentStream!.turnId).toBeUndefined();
  });

  it('ADR-118: состояние ретрая (retry) переживает save → load', async () => {
    await store.save(makeSession({
      id: 'with-retry',
      retry: {
        streamId: 'stream-9',
        attempt: 2,
        maxRetries: 3,
        retryAt: '2026-01-01T00:00:05.000Z',
        error: 'timeout',
      },
    }));

    // На диске — snake_case (как соседние составные поля сессии).
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'with-retry.json'), 'utf-8'));
    expect(raw.retry).toEqual({
      stream_id: 'stream-9',
      attempt: 2,
      max_retries: 3,
      retry_at: '2026-01-01T00:00:05.000Z',
      error: 'timeout',
    });

    const loaded = await store.load('with-retry');
    expect(loaded!.retry).toEqual({
      streamId: 'stream-9',
      attempt: 2,
      maxRetries: 3,
      retryAt: '2026-01-01T00:00:05.000Z',
      error: 'timeout',
    });
  });

  it('сессия без ретрая: поля retry нет (legacy-формат читается как undefined)', async () => {
    await store.save(makeSession({ id: 'no-retry' }));
    const raw = JSON.parse(await readFile(join(tmpDir, 'sessions', 'no-retry.json'), 'utf-8'));
    expect('retry' in raw).toBe(false);
    const loaded = await store.load('no-retry');
    expect(loaded!.retry).toBeUndefined();
  });

  it('ADR-118: appendMessage выдаёт монотонный ord, updateMessage его сохраняет', async () => {
    await store.save(makeSession({ id: 'ord-flow' }));

    const first = await store.appendMessage('ord-flow', {
      id: '',
      seq: 0,
      role: MessageRole.USER,
      origin: 'local',
      parts: [makeTextPart('first')],
      content: 'first',
      createdAt: new Date().toISOString(),
      disabled: false,
      pinned: false,
      hidden: false,
    } as never);
    expect(first!.ord).toBe(1);

    const second = await store.appendMessage('ord-flow', {
      id: '',
      seq: 0,
      role: MessageRole.ASSISTANT,
      origin: 'local',
      parts: [makeTextPart('second')],
      content: 'second',
      createdAt: new Date().toISOString(),
      disabled: false,
      pinned: false,
      hidden: false,
    } as never);
    expect(second!.ord).toBe(2);

    // Обновление не перебивает выданный `ord`.
    const updated = await store.updateMessage('ord-flow', {
      ...second!,
      content: 'second (final)',
      ord: 999,
    });
    expect(updated!.ord).toBe(2);

    const loaded = await store.load('ord-flow');
    expect(loaded!.messages.map((m) => m.ord)).toEqual([1, 2]);
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

  it('listLight читает последовательно (без list) и сохраняет очередь', async () => {
    const pending = {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local' as const,
      parts: [makeTextPart('в очереди')],
      content: 'в очереди',
      createdAt: new Date().toISOString(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
    await store.save(makeSession({
      id: 'a',
      messages: [{ ...pending, id: generateId(), content: 'история', parts: [makeTextPart('история')] }],
      pendingMessages: [pending],
    }));
    await store.save(makeSession({ id: 'b' }));

    const listSpy = vi.spyOn(store, 'list');
    try {
      const light = await store.listLight();
      // Регресс OOM: `list` держит истории всех сессий через `Promise.all`.
      expect(listSpy).not.toHaveBeenCalled();
      expect(light).toHaveLength(2);
      const a = light.find((s) => s.id === 'a')!;
      expect(a.messages).toEqual([]);
      expect(a.pendingMessages.map((m) => m.content)).toEqual(['в очереди']);
    } finally {
      listSpy.mockRestore();
    }
  });

  it('listLight фильтрует по projectId/parentId и сортирует по updatedAt desc', async () => {
    // Корневые сессии — без `parentId`; `filter.parentId: null` их и выбирает.
    await store.save(makeSession({ id: 'root-old', projectId: 'p1', updatedAt: '2024-01-01T00:00:00.000Z' }));
    await store.save(makeSession({ id: 'root-new', projectId: 'p1', updatedAt: '2024-03-01T00:00:00.000Z' }));
    await store.save(makeSession({ id: 'child', projectId: 'p1', parentId: 'root-old', updatedAt: '2024-02-01T00:00:00.000Z' }));
    await store.save(makeSession({ id: 'other', projectId: 'p2', updatedAt: '2024-04-01T00:00:00.000Z' }));

    expect((await store.listLight({ projectId: 'p1' })).map((s) => s.id))
      .toEqual(['root-new', 'child', 'root-old']);
    expect((await store.listLight({ parentId: null })).map((s) => s.id))
      .toEqual(['other', 'root-new', 'root-old']);
    expect((await store.listLight({ parentId: 'root-old' })).map((s) => s.id))
      .toEqual(['child']);
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
