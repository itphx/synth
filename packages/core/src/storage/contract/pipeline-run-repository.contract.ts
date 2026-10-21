import { describe, expect, it } from 'vitest';
import type { PipelineSpec } from '@itphx/synth-shared';
import type {
  PipelineRunEventRecord,
  PipelineRunRecord,
  PipelineRunRepository,
  ProjectPipelineRepository,
} from '../ports/index.js';
import {
  COLLECTION_LIMIT_DEFAULT,
  COLLECTION_LIMIT_MAX,
  resolveCollectionLimit,
} from '../ports/collection-limit.js';

/**
 * Паспорт порта `PipelineRunRepository` (ADR-101, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - прогон — upsert по `id` (`createdAt` не теряется, `updatedAt` монотонно не
 *   убывает), чтение, выборка «свежие первыми», фильтры по «И», потолок `limit`;
 * - журнал — **append-only**: порядок добавления, `limit` (последние N в
 *   хронологическом порядке), неизменность ранее записанных событий;
 * - самодостаточность прогона: снимок спецификации читается **после** удаления
 *   пайплайна (прогон не зависит от живого пайплайна).
 */
export function describePipelineRunRepository(
  name: string,
  make: () => Promise<{
    repo: PipelineRunRepository;
    pipelines: ProjectPipelineRepository;
    dispose?: () => Promise<void>;
  }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: списки пусты, записи нет', async () => {
      const { repo } = await make();
      expect(await repo.listRuns()).toEqual([]);
      expect(await repo.getRun('run-1')).toBeNull();
      expect(await repo.listEvents('run-1')).toEqual([]);
    });

    it('прогон: upsert сохраняет createdAt и не откатывает updatedAt', async () => {
      const { repo } = await make();
      await repo.saveRun(run('run-1'));
      const created = await repo.getRun('run-1');
      expect(created?.pipelineId).toBe('pipeline-1');
      expect(created?.version).toBe(1);
      expect(created?.status).toBe('pending');
      expect(created?.spec.nodes).toHaveLength(1);
      expect(created?.createdAt).toBe('2026-01-01T00:00:00.000Z');

      await repo.saveRun(
        run('run-1', {
          status: 'running',
          currentNode: 'implement',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.getRun('run-1');
      expect(updated?.status).toBe('running');
      expect(updated?.currentNode).toBe('implement');
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(Date.parse(updated?.updatedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(created?.updatedAt ?? ''),
      );

      // Запись с **более старым** `updatedAt` не откатывает метку.
      await repo.saveRun(run('run-1', { updatedAt: '2020-01-01T00:00:00.000Z' }));
      const afterStale = await repo.getRun('run-1');
      expect(Date.parse(afterStale?.updatedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(updated?.updatedAt ?? ''),
      );
      expect(afterStale?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('прогоны: свежие первыми, фильтры — по «И»', async () => {
      const { repo } = await make();
      await repo.saveRun(run('run-1', { pipelineId: 'pipeline-1', status: 'pending' }));
      await repo.saveRun(run('run-2', { pipelineId: 'pipeline-1', status: 'done' }));
      await repo.saveRun(run('run-3', { pipelineId: 'pipeline-2', status: 'done' }));
      await repo.saveRun(run('run-4', { pipelineId: 'pipeline-2', status: 'failed' }));

      expect((await repo.listRuns()).map((r) => r.id).sort()).toEqual([
        'run-1',
        'run-2',
        'run-3',
        'run-4',
      ]);
      expect((await repo.listRuns({ pipelineId: 'pipeline-1' })).map((r) => r.id).sort()).toEqual([
        'run-1',
        'run-2',
      ]);
      expect((await repo.listRuns({ projectId: 'proj-1' })).map((r) => r.id).sort()).toEqual([
        'run-1',
        'run-2',
        'run-3',
        'run-4',
      ]);
      expect((await repo.listRuns({ status: 'done' })).map((r) => r.id).sort()).toEqual([
        'run-2',
        'run-3',
      ]);
      // AND: пайплайн И статус.
      expect((await repo.listRuns({ pipelineId: 'pipeline-1', status: 'done' })).map((r) => r.id)).toEqual(
        ['run-2'],
      );
      expect(
        (await repo.listRuns({ pipelineId: 'pipeline-2', status: 'pending' })).map((r) => r.id),
      ).toEqual([]);
    });

    it('прогоны: порядок «свежие первыми» и потолок limit', async () => {
      const { repo } = await make();
      await repo.saveRun(run('run-old', { createdAt: '2026-01-01T00:00:00.000Z' }));
      await repo.saveRun(run('run-mid', { createdAt: '2026-02-01T00:00:00.000Z' }));
      await repo.saveRun(run('run-new', { createdAt: '2026-03-01T00:00:00.000Z' }));

      expect((await repo.listRuns()).map((r) => r.id)).toEqual(['run-new', 'run-mid', 'run-old']);
      expect((await repo.listRuns({ limit: 2 })).map((r) => r.id)).toEqual(['run-new', 'run-mid']);
      expect((await repo.listRuns({ limit: 1 })).map((r) => r.id)).toEqual(['run-new']);

      // Потолок выборки зафиксирован контрактом порта: дефолт 100, максимум 1000.
      expect(COLLECTION_LIMIT_DEFAULT).toBe(100);
      expect(COLLECTION_LIMIT_MAX).toBe(1000);
      expect(resolveCollectionLimit(undefined)).toBe(COLLECTION_LIMIT_DEFAULT);
      expect(resolveCollectionLimit(0)).toBe(COLLECTION_LIMIT_DEFAULT);
      expect(resolveCollectionLimit(5000)).toBe(COLLECTION_LIMIT_MAX);
      // Значение выше потолка обрезается, а не отбрасывается.
      expect((await repo.listRuns({ limit: 5000 })).length).toBe(3);
    });

    it('журнал: append-only, хронологический порядок и limit последних N', async () => {
      const { repo } = await make();
      await repo.saveRun(run('run-1'));
      expect(await repo.listEvents('run-1')).toEqual([]);

      await repo.appendEvent(event('run-1', '2026-01-01T00:00:00.000Z', 'run.started'));
      await repo.appendEvent(
        event('run-1', '2026-01-01T00:00:01.000Z', 'node.started', { node: 'implement' }),
      );
      await repo.appendEvent(event('run-1', '2026-01-01T00:00:02.000Z', 'node.finished'));
      await repo.appendEvent(event('run-2', '2026-01-01T00:00:03.000Z', 'run.started'));

      const events = await repo.listEvents('run-1');
      expect(events.map((e) => e.type)).toEqual(['run.started', 'node.started', 'node.finished']);
      expect(events[0]?.ts).toBe('2026-01-01T00:00:00.000Z');
      expect(events[1]?.payload).toEqual({ node: 'implement' });

      // `limit` — последние N в хронологическом порядке.
      expect((await repo.listEvents('run-1', { limit: 2 })).map((e) => e.type)).toEqual([
        'node.started',
        'node.finished',
      ]);
      expect((await repo.listEvents('run-1', { limit: 1 })).map((e) => e.type)).toEqual([
        'node.finished',
      ]);

      // Журнал неизменяем: ранее записанные события не меняются после дозаписи.
      const before = await repo.listEvents('run-1');
      await repo.appendEvent(event('run-1', '2026-01-01T00:00:04.000Z', 'run.finished'));
      const after = await repo.listEvents('run-1');
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.map((e) => e.type)).toEqual([
        'run.started',
        'node.started',
        'node.finished',
        'run.finished',
      ]);

      // Чужой прогон не смешивается; неизвестный — пустой список.
      expect((await repo.listEvents('run-2')).map((e) => e.type)).toEqual(['run.started']);
      expect(await repo.listEvents('run-unknown')).toEqual([]);
    });

    it('прогон самодостаточен: снимок spec читается после удаления пайплайна', async () => {
      const { repo, pipelines } = await make();
      await pipelines.savePipeline({
        id: 'pipeline-1',
        scope: 'project',
        projectId: 'proj-1',
        name: 'PR Pipeline',
        draftVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await repo.saveRun(run('run-1'));

      expect(await pipelines.deletePipeline('pipeline-1')).toBe(true);
      expect(await pipelines.getPipeline('pipeline-1')).toBeNull();

      // Прогон пережил удаление пайплайна: спецификация — снимок в самом прогоне.
      const stored = await repo.getRun('run-1');
      expect(stored?.spec.nodes).toHaveLength(1);
      expect(stored?.spec.id).toBe('pipeline-1');
    });
  });
}

/** Спецификация пайплайна для контрактного прогона. */
function spec(id: string, version = 1): PipelineSpec {
  return {
    id,
    name: 'PR Pipeline',
    version,
    status: 'published',
    mode: 'act',
    nodes: [{ id: 'implement', kind: 'agent', agent: 'implementer' }],
    exits: [{ kind: 'session', session: { agent: 'reporter' } }],
  };
}

/** Прогон для контрактного прогона. */
function run(id: string, overrides: Partial<PipelineRunRecord> = {}): PipelineRunRecord {
  return {
    id,
    pipelineId: 'pipeline-1',
    version: 1,
    spec: spec('pipeline-1'),
    projectId: 'proj-1',
    status: 'pending',
    trigger: { kind: 'manual', payload: { issue: 42 } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Событие прогона для контрактного прогона. */
function event(
  runId: string,
  ts: string,
  type: PipelineRunEventRecord['type'],
  payload?: Record<string, unknown>,
): PipelineRunEventRecord {
  return { runId, ts, type, ...(payload ? { payload } : {}) };
}
