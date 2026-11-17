import { describe, it, expect, vi } from 'vitest';
import type { ContextOptimizer, EventBus, SessionManager } from '@itphx/synth-core';
import { createRecalcCanSummarize } from './recalc-can-summarize.js';

/**
 * Фейк порта `SessionRepository.mutateMeta` для тестов: мутатор работает с
 * **копией** метаданных, результат пишется в тестовое состояние (только при
 * `shouldWrite !== false`), `touchUpdatedAt:false` оставляет время прежним.
 */
interface FakeSession {
  id: string;
  summaryPending?: unknown;
  summarizationPending: boolean;
  canSummarize: boolean;
  /** «Свидетель» в истории — правка метаданных не должна его терять. */
  messages: Array<{ id: string; content: string }>;
  updatedAt: string;
  [key: string]: unknown;
}

function makeDeps(opts: {
  pending: boolean;
  can: boolean;
  trigger: { triggered: boolean; mode: 'summarization' | 'compaction' | null };
  canCompress?: boolean;
}) {
  const OLD_STAMP = '2020-01-01T00:00:00.000Z';
  const session: FakeSession = {
    id: 's1',
    summarizationPending: opts.pending,
    canSummarize: false,
    settings: {},
    messages: [{ id: 'm1', content: 'свидетель' }],
    updatedAt: OLD_STAMP,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
  // Записи фиксируем, чтобы проверить паритет: только `mutateMeta`, никаких
  // `withLock`/`saveSession` (полная запись снимка затирала бы историю).
  const mutateMeta = vi.fn(async (
    sessionId: string,
    mutator: (meta: FakeSession) => unknown,
    mutateOpts?: { touchUpdatedAt?: boolean; shouldWrite?: (value: unknown) => boolean },
  ) => {
    if (sessionId !== session.id) return { found: false as const };
    const meta = structuredClone(session);
    const value = mutator(meta);
    if (mutateOpts?.shouldWrite && !mutateOpts.shouldWrite(value)) {
      return { found: true as const, value, session };
    }
    if (mutateOpts?.touchUpdatedAt !== false) meta.updatedAt = new Date().toISOString();
    Object.assign(session, meta);
    return { found: true as const, value, session };
  });
  const saveSession = vi.fn(async () => {});
  const withLock = vi.fn(async (_id: string, fn: (s: unknown) => Promise<unknown>) => fn(session));
  const sessionManager = {
    getSession: async () => session,
    mutateMeta,
    withLock,
    saveSession,
  } as unknown as SessionManager;
  const eventBus = { publish: vi.fn() } as unknown as EventBus;
  const contextOptimizer = {
    canSummarize: vi.fn(() => opts.can),
    shouldCompress: vi.fn(() => ({ ...opts.trigger, reason: opts.trigger.triggered ? 'tokens' : 'none' })),
    ...(opts.canCompress !== undefined ? { canCompress: vi.fn(() => opts.canCompress!) } : {}),
  } as unknown as ContextOptimizer;
  return {
    sessionManager, eventBus, contextOptimizer, session, mutateMeta, saveSession, withLock, OLD_STAMP,
  };
}

describe('createRecalcCanSummarize — оба профиля сжатия', () => {
  it('compaction: pending сохраняется, пока сжатие ещё триггерится', async () => {
    const deps = makeDeps({ pending: true, can: true, trigger: { triggered: true, mode: 'compaction' } });
    const recalc = createRecalcCanSummarize(deps);
    await recalc('s1');
    expect((deps.session as { summarizationPending: boolean }).summarizationPending).toBe(true);
    expect(deps.contextOptimizer.shouldCompress).toHaveBeenCalled();
  });

  it('summarization: pending снимается, когда триггер больше не срабатывает', async () => {
    const deps = makeDeps({ pending: true, can: false, trigger: { triggered: false, mode: 'summarization' } });
    const recalc = createRecalcCanSummarize(deps);
    await recalc('s1');
    expect((deps.session as { summarizationPending: boolean }).summarizationPending).toBe(false);
  });

  it('M3: триггер есть, но сжимать нечего → pending снимается', async () => {
    const deps = makeDeps({
      pending: true,
      can: true,
      trigger: { triggered: true, mode: 'compaction' },
      canCompress: false,
    });
    const recalc = createRecalcCanSummarize(deps);
    await recalc('s1');
    expect((deps.session as { summarizationPending: boolean }).summarizationPending).toBe(false);
  });

  it('нет режима сжатия → pending снимается', async () => {
    const deps = makeDeps({ pending: true, can: false, trigger: { triggered: false, mode: null } });
    const recalc = createRecalcCanSummarize(deps);
    await recalc('s1');
    expect((deps.session as { summarizationPending: boolean }).summarizationPending).toBe(false);
  });

  it('пишет через mutateMeta: флаг записан, updatedAt НЕ двигается, свидетель цел', async () => {
    const deps = makeDeps({ pending: true, can: true, trigger: { triggered: true, mode: 'compaction' } });
    const recalc = createRecalcCanSummarize(deps);
    await recalc('s1');

    // Флаг записан (значение — по свежему снимку).
    expect(deps.session.canSummarize).toBe(true);
    // Паритет с прежним `saveSession`: пересчёт не «оживляет» сессию.
    expect(deps.session.updatedAt).toBe(deps.OLD_STAMP);
    // Свидетель в истории не тронут (правка метаданных её не читает/не пишет).
    expect(deps.session.messages).toEqual([{ id: 'm1', content: 'свидетель' }]);
    // Только порт метаданных; полной записи снимка нет.
    expect(deps.mutateMeta).toHaveBeenCalledTimes(1);
    expect(deps.saveSession).not.toHaveBeenCalled();
    expect(deps.withLock).not.toHaveBeenCalled();
    // `touchUpdatedAt:false` — контракт паритета задан явно.
    expect(deps.mutateMeta.mock.calls[0]?.[2]).toMatchObject({ touchUpdatedAt: false });

    // Событие `session.updated` прежнее (токены/стоимость + флаг).
    expect(deps.eventBus.publish).toHaveBeenCalledWith('s1', 'session.updated', expect.objectContaining({
      session_id: 's1',
      can_summarize: true,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    }));
  });
});
