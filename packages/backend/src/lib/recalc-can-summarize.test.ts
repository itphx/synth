import { describe, it, expect, vi } from 'vitest';
import type { ContextOptimizer, EventBus, SessionManager } from '@itphx/synth-core';
import { createRecalcCanSummarize } from './recalc-can-summarize.js';

function makeDeps(opts: {
  pending: boolean;
  can: boolean;
  trigger: { triggered: boolean; mode: 'summarization' | 'compaction' | null };
  canCompress?: boolean;
}) {
  const session = {
    id: 's1',
    summarizationPending: opts.pending,
    canSummarize: false,
    settings: {},
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
  } as never;
  const saveSession = vi.fn(async () => {});
  const sessionManager = {
    getSession: async () => session,
    withLock: async (_id: string, fn: (s: unknown) => Promise<unknown>) => fn(session),
    saveSession,
  } as unknown as SessionManager;
  const eventBus = { publish: vi.fn() } as unknown as EventBus;
  const contextOptimizer = {
    canSummarize: vi.fn(() => opts.can),
    shouldCompress: vi.fn(() => ({ ...opts.trigger, reason: opts.trigger.triggered ? 'tokens' : 'none' })),
    ...(opts.canCompress !== undefined ? { canCompress: vi.fn(() => opts.canCompress!) } : {}),
  } as unknown as ContextOptimizer;
  return { sessionManager, eventBus, contextOptimizer, session, saveSession };
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
});
