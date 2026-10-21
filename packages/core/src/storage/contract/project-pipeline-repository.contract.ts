import { describe, expect, it } from 'vitest';
import type { PipelineSpec } from '@itphx/synth-shared';
import type {
  PipelineRecord,
  PipelineVersionRecord,
  ProjectPipelineRepository,
} from '../ports/index.js';

/**
 * Паспорт порта `ProjectPipelineRepository` (ADR-101, ADR-096).
 *
 * Проверяется общий для всех backend'ов контракт:
 * - пайплайн — upsert по `id` (`createdAt` не теряется, `updatedAt` монотонно
 *   не убывает), чтение, детерминированный список, фильтры `scope`/`projectId`
 *   (по «И»), удаление (`true`/`false`) с каскадом версий;
 * - версия — upsert по `(pipelineId, version)`, чтение, порядок по `version` asc;
 * - метаданные — ключ иконки нормализуется при чтении (как у `ProjectStore`).
 */
export function describeProjectPipelineRepository(
  name: string,
  make: () => Promise<{ repo: ProjectPipelineRepository; dispose?: () => Promise<void> }>,
): void {
  describe(name, () => {
    it('пустой репозиторий: список пуст, записи нет', async () => {
      const { repo } = await make();
      expect(await repo.listPipelines()).toEqual([]);
      expect(await repo.getPipeline('pipeline-1')).toBeNull();
      expect(await repo.listVersions('pipeline-1')).toEqual([]);
      expect(await repo.getVersion('pipeline-1', 1)).toBeNull();
    });

    it('пайплайн: upsert сохраняет createdAt и не откатывает updatedAt', async () => {
      const { repo } = await make();
      await repo.savePipeline(pipeline('pipeline-1'));
      const created = await repo.getPipeline('pipeline-1');
      expect(created?.name).toBe('PR Pipeline');
      expect(created?.scope).toBe('project');
      expect(created?.projectId).toBe('proj-1');
      expect(created?.draftVersion).toBe(1);
      expect(created?.publishedVersion).toBeUndefined();
      expect(created?.draft?.nodes).toHaveLength(1);
      expect(created?.createdAt).toBe('2026-01-01T00:00:00.000Z');

      // Перезапись: `createdAt` сохраняется, `updatedAt` не откатывается.
      await repo.savePipeline(
        pipeline('pipeline-1', {
          name: 'PR Pipeline (переименован)',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      const updated = await repo.getPipeline('pipeline-1');
      expect(updated?.name).toBe('PR Pipeline (переименован)');
      expect(updated?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(Date.parse(updated?.updatedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(created?.updatedAt ?? ''),
      );
      // Запись с **более старым** `updatedAt` не откатывает метку.
      await repo.savePipeline(
        pipeline('pipeline-1', { updatedAt: '2020-01-01T00:00:00.000Z' }),
      );
      const afterStale = await repo.getPipeline('pipeline-1');
      expect(Date.parse(afterStale?.updatedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(updated?.updatedAt ?? ''),
      );
      expect(afterStale?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('пайплайны: список детерминирован (по id), фильтры scope/projectId — по «И»', async () => {
      const { repo } = await make();
      await repo.savePipeline(pipeline('b-pipeline', { scope: 'instance', projectId: undefined }));
      await repo.savePipeline(pipeline('a-pipeline', { scope: 'instance', projectId: undefined }));
      await repo.savePipeline(pipeline('c-pipeline', { scope: 'project', projectId: 'proj-2' }));
      await repo.savePipeline(pipeline('d-pipeline', { scope: 'project', projectId: 'proj-1' }));

      expect((await repo.listPipelines()).map((p) => p.id)).toEqual([
        'a-pipeline',
        'b-pipeline',
        'c-pipeline',
        'd-pipeline',
      ]);
      // Повторный вызов — тот же порядок.
      expect((await repo.listPipelines()).map((p) => p.id)).toEqual([
        'a-pipeline',
        'b-pipeline',
        'c-pipeline',
        'd-pipeline',
      ]);

      expect((await repo.listPipelines({ scope: 'instance' })).map((p) => p.id)).toEqual([
        'a-pipeline',
        'b-pipeline',
      ]);
      expect((await repo.listPipelines({ scope: 'project' })).map((p) => p.id)).toEqual([
        'c-pipeline',
        'd-pipeline',
      ]);
      expect((await repo.listPipelines({ projectId: 'proj-1' })).map((p) => p.id)).toEqual([
        'd-pipeline',
      ]);
      // AND: область И проект.
      expect(
        (await repo.listPipelines({ scope: 'instance', projectId: 'proj-1' })).map((p) => p.id),
      ).toEqual([]);
      expect(
        (await repo.listPipelines({ scope: 'project', projectId: 'proj-1' })).map((p) => p.id),
      ).toEqual(['d-pipeline']);
    });

    it('пайплайн: удаление — true/false, версии удаляются каскадом', async () => {
      const { repo } = await make();
      await repo.savePipeline(pipeline('pipeline-1'));
      await repo.saveVersion(version('pipeline-1', 1));
      await repo.saveVersion(version('pipeline-1', 2));
      await repo.saveVersion(version('pipeline-2', 1));

      expect(await repo.deletePipeline('pipeline-1')).toBe(true);
      expect(await repo.getPipeline('pipeline-1')).toBeNull();
      expect(await repo.deletePipeline('pipeline-1')).toBe(false);
      // Версии удалённого пайплайна уходят вместе с ним; чужие — нет.
      expect(await repo.listVersions('pipeline-1')).toEqual([]);
      expect((await repo.listVersions('pipeline-2')).map((v) => v.version)).toEqual([1]);

      // Удаление несуществующего пайплайна — no-op: его версии (если есть) не
      // трогаются, результат — `false`, не ошибка.
      await repo.saveVersion(version('pipeline-3', 1));
      expect(await repo.deletePipeline('pipeline-3')).toBe(false);
      expect((await repo.listVersions('pipeline-3')).map((v) => v.version)).toEqual([1]);
    });

    it('версии: upsert по (pipelineId, version), порядок по version asc', async () => {
      const { repo } = await make();
      await repo.saveVersion(version('pipeline-1', 2));
      await repo.saveVersion(version('pipeline-1', 1));
      await repo.saveVersion(version('pipeline-1', 3));

      expect((await repo.listVersions('pipeline-1')).map((v) => v.version)).toEqual([1, 2, 3]);
      const first = await repo.getVersion('pipeline-1', 1);
      expect(first?.publishedAt).toBe('2026-02-01T00:00:00.000Z');
      expect(first?.publishedBy).toBe('user-1');
      expect(first?.spec.nodes).toHaveLength(1);

      // Upsert по (pipelineId, version): запись перезаписывается, соседние — нет.
      await repo.saveVersion(version('pipeline-1', 2, { publishedBy: 'user-2' }));
      expect((await repo.getVersion('pipeline-1', 2))?.publishedBy).toBe('user-2');
      expect((await repo.listVersions('pipeline-1')).map((v) => v.version)).toEqual([1, 2, 3]);
      // Чужая версия другого пайплайна не смешивается.
      expect(await repo.getVersion('pipeline-2', 1)).toBeNull();
    });

    it('пайплайн: ключ иконки нормализуется при чтении', async () => {
      const { repo } = await make();
      await repo.savePipeline(pipeline('pipeline-1', { icon: 'rocket' }));
      expect((await repo.getPipeline('pipeline-1'))?.icon).toBe('rocket');

      // Неканонический ключ → `undefined` (как у `ProjectStore.load`).
      await repo.savePipeline(pipeline('pipeline-2', { icon: 'не-иконка' }));
      expect((await repo.getPipeline('pipeline-2'))?.icon).toBeUndefined();
    });
  });
}

/** Спецификация пайплайна для контрактного прогона. */
function spec(id: string, version = 1): PipelineSpec {
  return {
    id,
    name: 'PR Pipeline',
    version,
    status: 'draft',
    mode: 'act',
    nodes: [{ id: 'implement', kind: 'agent', agent: 'implementer' }],
    exits: [{ kind: 'session', session: { agent: 'reporter' } }],
  };
}

/** Пайплайн для контрактного прогона. */
function pipeline(id: string, overrides: Partial<PipelineRecord> = {}): PipelineRecord {
  return {
    id,
    scope: 'project',
    projectId: 'proj-1',
    name: 'PR Pipeline',
    description: 'описание',
    draft: spec(id),
    draftVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Опубликованная версия для контрактного прогона. */
function version(
  pipelineId: string,
  v: number,
  overrides: Partial<PipelineVersionRecord> = {},
): PipelineVersionRecord {
  return {
    pipelineId,
    version: v,
    spec: spec(pipelineId, v),
    publishedAt: '2026-02-01T00:00:00.000Z',
    publishedBy: 'user-1',
    ...overrides,
  };
}
