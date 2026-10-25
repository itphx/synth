/**
 * ADR-101: тесты реестра активных прогонов (`run-control.ts`).
 *
 * Реестр — общий для HTTP-роута пайплайнов и встроенных тулов агента, поэтому
 * проверяем ровно те свойства, на которые опираются оба контура:
 *
 * - `startRun` возвращает **заголовок** прогона (прогон идёт в фоне);
 * - soft-lock: второй прогон того же пайплайна не стартует
 *   (`pipeline.already_running`);
 * - `cancelRun` сигналит отмену (`AbortController`) и чистит реестр;
 * - по завершении прогона запись реестра удаляется;
 * - прогон, вставший на паузу HITL (`awaiting_human`), блокировку **не**
 *   держит — ресурсов движка он не потребляет.
 */

import { describe, it, expect } from 'vitest';
import type { PipelineRunStatus, PipelineSpec } from '@itphx/synth-shared';
import { MemoryPipelineRunRepository } from '../../storage/memory/pipelines.js';
import type { PipelineRunRecord } from '../../storage/ports/index.js';
import type { PipelineEngine } from './engine.js';
import type { PipelineRunOptions } from './types.js';
import { PipelineRunControl } from './run-control.js';

/** Минимальная валидная спецификация — движок в тесте не исполняет шаги. */
const SPEC: PipelineSpec = {
  id: 'pl_test',
  name: 'Тестовый пайплайн',
  version: 1,
  status: 'published',
  mode: 'act',
  nodes: [{ id: 'n1', kind: 'tool', tool: 'read_file' }],
  exits: [{ kind: 'none' }],
};

/** Управляемый прогон фейкового движка. */
interface FakeRun {
  /** Запись прогона (заголовок). */
  record: PipelineRunRecord;
  /** Завершить прогон успешно. */
  finish: (status?: PipelineRunStatus) => void;
  /** Завершить прогон ошибкой. */
  fail: (error: unknown) => void;
  /** Сигнал отмены, переданный движку. */
  signal: AbortSignal | undefined;
}

/** Фейковый движок: промис прогона под контролем теста. */
function createFakeEngine(runs: MemoryPipelineRunRepository): {
  engine: PipelineEngine;
  started: FakeRun[];
} {
  const started: FakeRun[] = [];
  const fake = {
    run(opts: PipelineRunOptions): Promise<PipelineRunRecord> {
      const now = new Date().toISOString();
      const record: PipelineRunRecord = {
        id: `prun_${started.length + 1}`,
        pipelineId: opts.pipelineId,
        version: opts.version ?? 1,
        spec: SPEC,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        status: 'running',
        trigger: opts.trigger,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      // Движок сохраняет заголовок прогона **до** первого шага (ADR-101 §8).
      void runs.saveRun(record);
      let resolveFn: (r: PipelineRunRecord) => void = () => undefined;
      let rejectFn: (e: unknown) => void = () => undefined;
      const promise = new Promise<PipelineRunRecord>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      // Отмена (`AbortController`) валит промис — как в настоящем движке.
      opts.signal?.addEventListener('abort', () => {
        rejectFn(new Error('прогон отменён'));
      });
      started.push({
        record,
        finish: (status: PipelineRunStatus = 'done') =>
          resolveFn({ ...record, status, finishedAt: new Date().toISOString() }),
        fail: (error: unknown) => rejectFn(error),
        signal: opts.signal,
      });
      return promise;
    },
  };
  return { engine: fake as unknown as PipelineEngine, started };
}

describe('PipelineRunControl (ADR-101)', () => {
  it('startRun возвращает заголовок прогона (прогон идёт в фоне)', async () => {
    const runs = new MemoryPipelineRunRepository();
    const { engine, started } = createFakeEngine(runs);
    const control = new PipelineRunControl();

    const result = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });

    expect(result.run.pipelineId).toBe('pl_1');
    expect(result.run.status).toBe('running');
    expect(started).toHaveLength(1);
    // Прогон ещё исполняется — реестр его держит.
    expect(control.isRunning(result.run.id)).toBe(true);
    expect(control.isPipelineRunning('pl_1')).toBe(true);

    // Завершение прогона чистит реестр.
    started[0]!.finish('done');
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRunning(result.run.id)).toBe(false);
    expect(control.isPipelineRunning('pl_1')).toBe(false);
    expect(control.activeRunIds()).toEqual([]);
  });

  it('второй startRun по тому же пайплайну — ошибка pipeline.already_running', async () => {
    const runs = new MemoryPipelineRunRepository();
    const { engine } = createFakeEngine(runs);
    const control = new PipelineRunControl();

    const first = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });

    await expect(
      control.startRun({ engine, runs, pipelineId: 'pl_1', trigger: { kind: 'manual' } }),
    ).rejects.toMatchObject({ code: 'pipeline.already_running' });

    // Другой пайплайн той же спецификации — не заблокирован.
    const other = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_2',
      trigger: { kind: 'manual' },
    });
    expect(other.run.id).not.toBe(first.run.id);
  });

  it('cancelRun сигналит отмену и чистит реестр', async () => {
    const runs = new MemoryPipelineRunRepository();
    const { engine, started } = createFakeEngine(runs);
    const control = new PipelineRunControl();

    const result = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });

    expect(started[0]!.signal?.aborted).toBe(false);
    expect(control.cancelRun(result.run.id)).toBe(true);
    // Сигнал отмены дошёл до движка.
    expect(started[0]!.signal?.aborted).toBe(true);

    // Реестр чистится после завершения прогона.
    await Promise.resolve();
    await Promise.resolve();
    expect(control.isRunning(result.run.id)).toBe(false);
    expect(control.isPipelineRunning('pl_1')).toBe(false);

    // Чужой (неизвестный) прогон отменить нельзя.
    expect(control.cancelRun('prun_missing')).toBe(false);
  });

  it('cancelAndWait возвращает финальную запись прогона', async () => {
    const runs = new MemoryPipelineRunRepository();
    const { engine } = createFakeEngine(runs);
    const control = new PipelineRunControl();

    const result = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });

    // Прогон ещё идёт — `cancelAndWait` ждёт его завершения (отмена валит
    // промис движка, поэтому финальной записи не будет → `null`).
    const final = await control.cancelAndWait(result.run.id);
    expect(final).toBeNull();
    expect(control.isRunning(result.run.id)).toBe(false);

    // Неизвестный прогон — `null`.
    expect(await control.cancelAndWait('prun_missing')).toBeNull();
  });

  it('прогон на паузе HITL (awaiting_human) блокировку не держит', async () => {
    const runs = new MemoryPipelineRunRepository();
    const { engine, started } = createFakeEngine(runs);
    const control = new PipelineRunControl();

    const first = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });

    // Движок встал на паузу HITL: промис прогона **резолвится** — прогон ждёт
    // человека и ресурсов движка не потребляет (ADR-101 §2.9).
    started[0]!.finish('awaiting_human');
    await Promise.resolve();
    await Promise.resolve();

    expect(control.isRunning(first.run.id)).toBe(false);
    expect(control.isPipelineRunning('pl_1')).toBe(false);

    // Второй прогон того же пайплайна — разрешён.
    const second = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });
    expect(second.run.id).not.toBe(first.run.id);
  });

  it('ошибка движка не оставляет прогон в реестре', async () => {
    const runs = new MemoryPipelineRunRepository();
    const { engine, started } = createFakeEngine(runs);
    const control = new PipelineRunControl();

    const result = await control.startRun({
      engine,
      runs,
      pipelineId: 'pl_1',
      trigger: { kind: 'manual' },
    });

    started[0]!.fail(new Error('шаг упал'));
    await Promise.resolve();
    await Promise.resolve();

    expect(control.isRunning(result.run.id)).toBe(false);
    expect(control.isPipelineRunning('pl_1')).toBe(false);
  });
});
