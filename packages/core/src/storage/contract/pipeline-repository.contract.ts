import { describe, expect, it } from 'vitest';
import type {
  PipelineDefinitionRecord,
  PipelineInstanceRecord,
  PipelineRepository,
} from '../ports/index.js';
import {
  PIPELINE_INSTANCE_DEFAULT_LIMIT,
  PIPELINE_INSTANCE_MAX_LIMIT,
  resolvePipelineInstanceLimit,
} from '../ports/pipeline-repository.js';

/** Определение пайплайна для контрактного прогона. */
function definition(
  id: string,
  overrides: Partial<PipelineDefinitionRecord> = {},
): PipelineDefinitionRecord {
  return {
    id,
    name: id,
    description: 'описание',
    version: '1.0.0',
    steps: [{ id: 'step-1', kind: 'agent', agent: 'assistant', prompt: 'сделай' }],
    onError: 'fail',
    maxAttempts: 3,
    ttl: '1h',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Экземпляр пайплайна для контрактного прогона. */
function instance(
  id: string,
  overrides: Partial<PipelineInstanceRecord> = {},
): PipelineInstanceRecord {
  return {
    id,
    pipelineId: 'pipeline-1',
    status: 'pending',
    steps: [{ id: 'step-1', status: 'pending' }],
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Паспорт порта `PipelineRepository` (ADR-051/PROP-059, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - определения — upsert по `id` (`createdAt` не теряется, `updatedAt` обновляется),
 *   чтение, детерминированный список, удаление (`true`/`false`);
 * - экземпляры — сохранение/чтение/обновление статуса, фильтры `pipelineId`/`status`
 *   (по «И»), выборка «свежие первыми» и потолок `limit`.
 */
export function describePipelineRepository(
  name: string,
  make: () => Promise<{ repo: PipelineRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('определение: upsert сохраняет createdAt и обновляет updatedAt', async () => {
      const { repo } = await make();
      expect(await repo.getDefinition('pipeline-1')).toBeNull();

      await repo.saveDefinition(definition('pipeline-1'));
      const created = await repo.getDefinition('pipeline-1');
      expect(created?.name).toBe('pipeline-1');
      expect(created?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(created?.steps).toHaveLength(1);
      expect(created?.onError).toBe('fail');
      expect(created?.installedBy).toBeUndefined();

      // Перезапись: `createdAt` сохраняется, `updatedAt` обновляется.
      await repo.saveDefinition(
        definition('pipeline-1', {
          name: 'переименован',
          version: '2.0.0',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.getDefinition('pipeline-1');
      expect(updated?.name).toBe('переименован');
      expect(updated?.version).toBe('2.0.0');
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    });

    it('определения: список детерминирован (по id), удаление — true/false', async () => {
      const { repo } = await make();
      expect(await repo.listDefinitions()).toEqual([]);

      await repo.saveDefinition(definition('b-pipeline'));
      await repo.saveDefinition(definition('a-pipeline'));
      await repo.saveDefinition(definition('c-pipeline'));

      expect((await repo.listDefinitions()).map((d) => d.id)).toEqual([
        'a-pipeline',
        'b-pipeline',
        'c-pipeline',
      ]);
      // Повторный вызов — тот же порядок.
      expect((await repo.listDefinitions()).map((d) => d.id)).toEqual([
        'a-pipeline',
        'b-pipeline',
        'c-pipeline',
      ]);

      expect(await repo.deleteDefinition('b-pipeline')).toBe(true);
      expect(await repo.getDefinition('b-pipeline')).toBeNull();
      expect(await repo.deleteDefinition('b-pipeline')).toBe(false);
      expect((await repo.listDefinitions()).map((d) => d.id)).toEqual(['a-pipeline', 'c-pipeline']);
    });

    it('экземпляр: сохранение, чтение и обновление статуса', async () => {
      const { repo } = await make();
      expect(await repo.getInstance('run-1')).toBeNull();
      expect(await repo.listInstances()).toEqual([]);

      await repo.saveInstance(instance('run-1'));
      const saved = await repo.getInstance('run-1');
      expect(saved?.pipelineId).toBe('pipeline-1');
      expect(saved?.status).toBe('pending');
      expect(saved?.steps).toHaveLength(1);

      await repo.saveInstance(
        instance('run-1', {
          status: 'done',
          steps: [{ id: 'step-1', status: 'done', finishedAt: '2026-01-01T01:00:00.000Z' }],
          currentStep: 'step-1',
          attempts: 1,
        }),
      );
      const updated = await repo.getInstance('run-1');
      expect(updated?.status).toBe('done');
      expect(updated?.steps[0]?.status).toBe('done');
      expect(updated?.attempts).toBe(1);
      // `createdAt` экземпляра иммутабельно.
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('экземпляры: фильтры pipelineId/status работают по «И»', async () => {
      const { repo } = await make();
      await repo.saveInstance(instance('run-1', { pipelineId: 'pipeline-1', status: 'pending' }));
      await repo.saveInstance(instance('run-2', { pipelineId: 'pipeline-1', status: 'done' }));
      await repo.saveInstance(instance('run-3', { pipelineId: 'pipeline-2', status: 'done' }));
      await repo.saveInstance(instance('run-4', { pipelineId: 'pipeline-2', status: 'failed' }));

      expect((await repo.listInstances()).map((i) => i.id).sort()).toEqual([
        'run-1',
        'run-2',
        'run-3',
        'run-4',
      ]);
      expect((await repo.listInstances({ pipelineId: 'pipeline-1' })).map((i) => i.id).sort()).toEqual([
        'run-1',
        'run-2',
      ]);
      expect((await repo.listInstances({ status: 'done' })).map((i) => i.id).sort()).toEqual([
        'run-2',
        'run-3',
      ]);
      // AND: пайплайн И статус.
      expect(
        (await repo.listInstances({ pipelineId: 'pipeline-1', status: 'done' })).map((i) => i.id),
      ).toEqual(['run-2']);
      expect(
        (await repo.listInstances({ pipelineId: 'pipeline-2', status: 'pending' })).map((i) => i.id),
      ).toEqual([]);
    });

    it('экземпляры: свежие первыми, limit и его потолок', async () => {
      const { repo } = await make();
      await repo.saveInstance(
        instance('run-old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      );
      await repo.saveInstance(
        instance('run-mid', { createdAt: '2026-02-01T00:00:00.000Z' }),
      );
      await repo.saveInstance(
        instance('run-new', { createdAt: '2026-03-01T00:00:00.000Z' }),
      );

      expect((await repo.listInstances()).map((i) => i.id)).toEqual(['run-new', 'run-mid', 'run-old']);
      expect((await repo.listInstances({ limit: 2 })).map((i) => i.id)).toEqual(['run-new', 'run-mid']);
      expect((await repo.listInstances({ limit: 1 })).map((i) => i.id)).toEqual(['run-new']);

      // Потолок выборки зафиксирован контрактом порта: дефолт 100, максимум 1000.
      expect(PIPELINE_INSTANCE_DEFAULT_LIMIT).toBe(100);
      expect(PIPELINE_INSTANCE_MAX_LIMIT).toBe(1000);
      expect(resolvePipelineInstanceLimit(undefined)).toBe(PIPELINE_INSTANCE_DEFAULT_LIMIT);
      expect(resolvePipelineInstanceLimit(0)).toBe(PIPELINE_INSTANCE_DEFAULT_LIMIT);
      expect(resolvePipelineInstanceLimit(5000)).toBe(PIPELINE_INSTANCE_MAX_LIMIT);
      // Значение выше потолка обрезается, а не отбрасывается.
      expect((await repo.listInstances({ limit: 5000 })).length).toBe(3);
    });
  });
}
