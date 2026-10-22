/**
 * ADR-102: сборщик роллапов — UTC-сутки, слияние валют, инкремент по ключу и
 * best-effort при ошибке порта.
 */

import { describe, expect, it, vi } from 'vitest';
import { AnalyticsRecorder } from './recorder.js';
import { MemoryAnalyticsRollupRepository } from '../storage/memory/analytics-rollup.js';
import type { AnalyticsRollupRepository } from '../storage/ports/analytics-rollup-repository.js';

/** Рекордер над memory-портом с фиксированным «сейчас». */
function makeRecorder(now = new Date('2026-10-18T12:00:00.000Z')) {
  const repo = new MemoryAnalyticsRollupRepository();
  const recorder = new AnalyticsRecorder({ repo, now: () => now });
  return { repo, recorder };
}

describe('AnalyticsRecorder — usage', () => {
  it('пишет сутки UTC (YYYY-MM-DD) и меры snake_case по осям', async () => {
    const { repo, recorder } = makeRecorder(new Date('2026-10-18T23:59:00.000Z'));
    await recorder.recordUsage({
      userId: 'u1',
      projectId: 'p1',
      model: 'm',
      agent: 'assistant',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 30,
        cacheWriteTokens: 5,
        reasoningTokens: 4,
      },
      requests: 1,
      messages: 1,
      durationMs: 1500,
      costByCurrency: { USD: 0.5 },
    });

    const rows = await repo.query({ family: 'usage', groupBy: ['day'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dimensions).toEqual({ day: '2026-10-18' });
    expect(rows[0]!.measures).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 5,
      reasoning_tokens: 4,
      requests: 1,
      messages: 1,
      duration_ms: 1500,
    });
    expect(rows[0]!.costByCurrency).toEqual({ USD: 0.5 });
  });

  it('сливает валюты суммированием, а разные оси — в отдельные бакеты', async () => {
    const { repo, recorder } = makeRecorder();
    await recorder.recordUsage({
      userId: 'u1',
      model: 'm',
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      costByCurrency: { USD: 1 },
    });
    await recorder.recordUsage({
      userId: 'u1',
      model: 'm',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      costByCurrency: { USD: 0.25, EUR: 2 },
    });
    await recorder.recordUsage({
      userId: 'u2',
      model: 'm',
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      costByCurrency: { USD: 0.1 },
    });

    const rows = await repo.query({ family: 'usage', groupBy: ['user'] });
    expect(rows).toHaveLength(2);
    const u1 = rows.find((row) => row.dimensions.user === 'u1')!;
    expect(u1.measures.input_tokens).toBe(15);
    expect(u1.measures.output_tokens).toBe(3);
    expect(u1.costByCurrency).toEqual({ USD: 1.25, EUR: 2 });
  });

  it('идемпотентный upsert: повторная запись не плодит бакеты, а суммирует', async () => {
    const { repo, recorder } = makeRecorder();
    for (let i = 0; i < 3; i += 1) {
      await recorder.recordUsage({
        userId: 'u1',
        usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      });
    }
    const rows = await repo.query({ family: 'usage' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.measures.input_tokens).toBe(30);
  });

  it('нулевой usage без стоимости не создаёт бакет', async () => {
    const { repo, recorder } = makeRecorder();
    await recorder.recordUsage({
      userId: 'u1',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      requests: 0,
    });
    expect(await repo.query({ family: 'usage' })).toEqual([]);
  });
});

describe('AnalyticsRecorder — activity/decision', () => {
  it('activity инкрементирует меру по осям user/project', async () => {
    const { repo, recorder } = makeRecorder();
    await recorder.recordActivity('tool_calls', { userId: 'u1', projectId: 'p1' });
    await recorder.recordActivity('tool_calls', { userId: 'u1', projectId: 'p1', value: 2 });

    const rows = await repo.query({ family: 'activity', groupBy: ['user', 'project'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dimensions).toEqual({ user: 'u1', project: 'p1' });
    expect(rows[0]!.measures).toEqual({ tool_calls: 3 });
  });

  it('decision зеркалит счётчики decisionMetrics по осям provider/model', async () => {
    const { repo, recorder } = makeRecorder();
    await recorder.recordDecision({
      accepted: true,
      tier: 'escalation',
      attempts: [
        { tier: 'primary', providerName: 'p1', modelName: 'm1', status: 'low_confidence' },
        { tier: 'escalation', providerName: 'p2', modelName: 'm2', status: 'ok' },
      ],
    });

    const rows = await repo.query({ family: 'decision', groupBy: ['provider', 'model'] });
    const primary = rows.find((row) => row.dimensions.provider === 'p1')!;
    const escalation = rows.find((row) => row.dimensions.provider === 'p2')!;

    // Попытка primary: вызов каскада + отвергнутая попытка.
    expect(primary.measures).toEqual({ calls: 1, attempts: 1, rejected: 1 });
    // Принявшая попытка эскалации.
    expect(escalation.measures).toEqual({ attempts: 1, handled: 1, escalated: 1 });

    const total = (await repo.query({ family: 'decision' }))[0]!;
    expect(total.measures).toEqual({
      calls: 1,
      attempts: 2,
      rejected: 1,
      handled: 1,
      escalated: 1,
    });
  });

  it('decision-отказ: fallback на последней попытке', async () => {
    const { repo, recorder } = makeRecorder();
    await recorder.recordDecision({
      accepted: false,
      attempts: [{ tier: 'primary', providerName: 'p1', modelName: 'm1', status: 'error' }],
    });
    const [row] = await repo.query({ family: 'decision' });
    expect(row!.measures).toEqual({ calls: 1, attempts: 1, rejected: 1, fallback: 1 });
  });
});

describe('AnalyticsRecorder — best-effort', () => {
  it('ошибка порта не пробрасывается и логируется warn-ом', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing: AnalyticsRollupRepository = {
      increment: async () => {
        throw new Error('disk full');
      },
      set: async () => {},
      query: async () => [],
      prune: async () => 0,
      clear: async () => 0,
    };
    const recorder = new AnalyticsRecorder({ repo: failing });

    await expect(
      recorder.recordUsage({
        userId: 'u1',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined();
    await expect(recorder.recordActivity('aborts', { userId: 'u1' })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain('disk full');
    warn.mockRestore();
  });

  it('без порта рекордер выключен и ничего не пишет', async () => {
    const recorder = new AnalyticsRecorder();
    expect(recorder.enabled).toBe(false);
    await expect(
      recorder.recordUsage({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    ).resolves.toBeUndefined();
  });
});
