/**
 * Параллельное исполнение батча вызовов инструментов (PROP-127, этап T1).
 *
 * Проверяем инварианты `runToolBatch`:
 * - конкурентность (все исполнители стартуют до завершения первого — барьером,
 *   без тайминговых допущений);
 * - порядок результатов = порядок вызовов модели (при обратном порядке завершения);
 * - изоляция ошибок (бросок и отказ промиса не роняют батч и остальные вызовы);
 * - пустой батч;
 * - отсутствие unhandled rejection.
 */

import { describe, it, expect } from 'vitest';
import { runToolBatch, toolBatchValues, toolBatchFailures } from './tool-batch.js';

/** Отложенный результат: ручной барьер для проверки конкурентности. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** Создаёт отложенный результат (барьер). */
function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Значение успешного исхода (для компактных проверок). */
function valueOf(outcome: { ok: boolean; value?: unknown }): unknown {
  return outcome.ok ? outcome.value : undefined;
}

describe('runToolBatch — параллельное исполнение батча', () => {
  it('все исполнители стартуют до завершения первого (барьер, без таймингов)', async () => {
    const gate = createDeferred();
    const started: string[] = [];

    const batch = runToolBatch(
      ['a', 'b', 'c'].map((id) => ({
        id,
        run: async (): Promise<string> => {
          started.push(id);
          // Барьер не разрешён — завершиться не может никто.
          await gate.promise;
          return id.toUpperCase();
        },
      })),
    );

    await Promise.resolve();

    // Все три стартовали, пока ни один не завершился.
    expect(started).toEqual(['a', 'b', 'c']);

    gate.resolve();
    const result = await batch;

    expect(result.outcomes.map(valueOf)).toEqual(['A', 'B', 'C']);
    expect(result.errorCount).toBe(0);
  });

  it('результаты в порядке вызовов модели, даже если завершились в обратном', async () => {
    const gates = [createDeferred(), createDeferred(), createDeferred()];
    const ids = ['first', 'second', 'third'];

    const batch = runToolBatch(
      ids.map((id, index) => ({
        id,
        run: async (): Promise<string> => {
          await gates[index]!.promise;
          return id;
        },
      })),
    );

    // Завершаем в обратном порядке.
    gates[2]!.resolve();
    gates[1]!.resolve();
    gates[0]!.resolve();

    const result = await batch;

    expect(result.outcomes.map(valueOf)).toEqual(['first', 'second', 'third']);
    expect(result.outcomes.map((outcome) => outcome.id)).toEqual(ids);
    // Порядок завершения — отдельный след: он обратный.
    expect(result.settleOrder).toEqual([2, 1, 0]);
  });

  it('ошибка одного вызова не мешает остальным и не роняет батч', async () => {
    const boom = new Error('boom');

    const result = await runToolBatch([
      { id: 'ok-1', run: async (): Promise<string> => 'one' },
      {
        id: 'bad',
        run: async (): Promise<string> => {
          throw boom;
        },
      },
      { id: 'ok-2', run: async (): Promise<string> => 'two' },
    ]);

    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes[0]).toEqual({ ok: true, id: 'ok-1', value: 'one' });
    expect(result.outcomes[1]).toEqual({ ok: false, id: 'bad', error: boom });
    expect(result.outcomes[2]).toEqual({ ok: true, id: 'ok-2', value: 'two' });
    expect(result.errorCount).toBe(1);
    expect(toolBatchValues(result.outcomes)).toEqual(['one', 'two']);
    expect(toolBatchFailures(result.outcomes)).toEqual([{ id: 'bad', error: boom }]);
  });

  it('отклонённый промис (не бросок) обрабатывается так же', async () => {
    const boom = new Error('rejected');

    const result = await runToolBatch([
      { id: 'rejects', run: (): Promise<string> => Promise.reject(boom) },
      { id: 'resolves', run: async (): Promise<string> => 'ok' },
    ]);

    expect(result.outcomes[0]).toEqual({ ok: false, id: 'rejects', error: boom });
    expect(result.outcomes[1]).toEqual({ ok: true, id: 'resolves', value: 'ok' });
    expect(result.errorCount).toBe(1);
  });

  it('синхронный бросок исполнителя изолируется так же', async () => {
    const boom = new Error('sync-throw');

    const result = await runToolBatch([
      {
        id: 'sync',
        run: (): Promise<string> => {
          throw boom;
        },
      },
      { id: 'after', run: async (): Promise<string> => 'ok' },
    ]);

    expect(result.outcomes[0]).toEqual({ ok: false, id: 'sync', error: boom });
    expect(result.outcomes[1]).toEqual({ ok: true, id: 'after', value: 'ok' });
  });

  it('пустой батч — пустые результаты', async () => {
    const result = await runToolBatch([]);

    expect(result.outcomes).toEqual([]);
    expect(result.settleOrder).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(toolBatchValues(result.outcomes)).toEqual([]);
    expect(toolBatchFailures(result.outcomes)).toEqual([]);
  });

  it('отказ исполнителя не превращается в unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await runToolBatch([{ id: 'x', run: (): Promise<string> => Promise.reject(new Error('nope')) }]);
      // Даём event loop сработать: необработанный отказ проявляется на тике.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('onSettled вызывается в порядке завершения; его падение не ломает батч', async () => {
    const gates = [createDeferred(), createDeferred()];
    const settled: string[] = [];

    const batch = runToolBatch(
      ['one', 'two'].map((id, index) => ({
        id,
        run: async (): Promise<string> => {
          await gates[index]!.promise;
          return id;
        },
      })),
      {
        onSettled: (outcome) => {
          settled.push(outcome.id);
          if (outcome.id === 'two') throw new Error('наблюдение упало');
        },
      },
    );

    gates[1]!.resolve();
    gates[0]!.resolve();

    const result = await batch;

    expect(settled).toEqual(['two', 'one']);
    expect(result.outcomes.map(valueOf)).toEqual(['one', 'two']);
  });
});
