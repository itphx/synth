/**
 * ADR-101: тесты авторских операций над пайплайном проекта
 * (`authoring.ts`): создание черновика, правка без bump'а версии, публикация
 * (неизменяемая версия + следующий черновик), идемпотентность повторной
 * публикации без изменений, удаление и ошибка валидации спецификации.
 *
 * Порт — in-memory реализация слоя хранения (`MemoryProjectPipelineRepository`),
 * чтобы тест не зависел от ФС.
 */

import { describe, it, expect } from 'vitest';
import type { PipelineSpec } from '@itphx/synth-shared';
import { MemoryProjectPipelineRepository } from '../../storage/memory/pipelines.js';
import {
  PipelineAuthoringError,
  createPipelineDraft,
  deletePipeline,
  publishPipeline,
  updatePipelineDraft,
} from './authoring.js';

/** Корректная спецификация одного шага. */
function validSpec(name = 'Тестовый пайплайн'): PipelineSpec {
  return {
    id: 'pl_ignored',
    name,
    version: 1,
    status: 'draft',
    mode: 'act',
    nodes: [{ id: 'n1', kind: 'agent', agent: 'developer' }],
    exits: [{ kind: 'none' }],
  };
}

describe('Авторские операции над пайплайном (ADR-101, authoring.ts)', () => {
  it('createPipelineDraft: серверные поля проставляются сервером', async () => {
    const pipelines = new MemoryProjectPipelineRepository();

    const record = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });

    expect(record.id).toMatch(/^pl_/);
    expect(record.scope).toBe('project');
    expect(record.projectId).toBe('proj-1');
    expect(record.name).toBe('Тестовый пайплайн');
    expect(record.draftVersion).toBe(1);
    expect(record.publishedVersion).toBeUndefined();
    // Серверные поля спецификации — из сервера, не от вызывающего.
    expect(record.draft?.id).toBe(record.id);
    expect(record.draft?.version).toBe(1);
    expect(record.draft?.status).toBe('draft');
    expect(record.draft?.projectId).toBe('proj-1');

    const stored = await pipelines.getPipeline(record.id);
    expect(stored?.id).toBe(record.id);
  });

  it('createPipelineDraft: невалидная спецификация — ошибка invalid_spec со списком проблем', async () => {
    const pipelines = new MemoryProjectPipelineRepository();

    const broken = validSpec();
    // Узел `agent` без поля `agent` — смысловая ошибка графа.
    broken.nodes = [{ id: 'n1', kind: 'agent' }];

    await expect(
      createPipelineDraft({ pipelines, projectId: 'proj-1', spec: broken }),
    ).rejects.toBeInstanceOf(PipelineAuthoringError);

    const error = await createPipelineDraft({ pipelines, projectId: 'proj-1', spec: broken }).catch(
      (e: unknown) => e,
    );
    expect((error as PipelineAuthoringError).code).toBe('invalid_spec');
    expect((error as PipelineAuthoringError).problems.length).toBeGreaterThan(0);

    // Запись не создана.
    expect(await pipelines.listPipelines({ scope: 'project', projectId: 'proj-1' })).toHaveLength(0);
  });

  it('updatePipelineDraft: версия не bump’ается, спецификация обновляется', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const created = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });

    const next = validSpec('Переименованный пайплайн');
    next.nodes = [
      { id: 'n1', kind: 'agent', agent: 'developer' },
      { id: 'n2', kind: 'tool', tool: 'read_file' },
    ];

    const updated = await updatePipelineDraft({
      pipelines,
      record: created,
      spec: next,
    });

    expect(updated.draftVersion).toBe(created.draftVersion);
    expect(updated.publishedVersion).toBeUndefined();
    expect(updated.name).toBe('Переименованный пайплайн');
    expect(updated.draft?.nodes).toHaveLength(2);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const stored = await pipelines.getPipeline(created.id);
    expect(stored?.draft?.nodes).toHaveLength(2);
  });

  it('updatePipelineDraft: невалидная спецификация — ошибка invalid_spec', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const created = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });

    const broken = validSpec();
    // Переход `on[].then` ссылается на несуществующий узел.
    broken.nodes = [
      { id: 'n1', kind: 'agent', agent: 'developer', on: [{ when: { path: 'prev.status', op: 'eq', value: 'ok' }, then: 'missing' }] },
    ];

    await expect(
      updatePipelineDraft({ pipelines, record: created, spec: broken }),
    ).rejects.toBeInstanceOf(PipelineAuthoringError);

    // Запись не изменилась.
    const stored = await pipelines.getPipeline(created.id);
    expect(stored?.draft?.nodes).toHaveLength(1);
  });

  it('publishPipeline: публикует версию и заготавливает следующий черновик', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const created = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });

    const { pipeline, published } = await publishPipeline({
      pipelines,
      record: created,
      publishedBy: 'user-1',
    });

    expect(published.pipelineId).toBe(created.id);
    expect(published.version).toBe(1);
    expect(published.publishedBy).toBe('user-1');
    expect(published.spec.status).toBe('published');
    expect(published.spec.version).toBe(1);

    // Черновик переезжает на следующую версию.
    expect(pipeline.publishedVersion).toBe(1);
    expect(pipeline.draftVersion).toBe(2);
    expect(pipeline.draft?.version).toBe(2);
    expect(pipeline.draft?.status).toBe('draft');

    const versions = await pipelines.listVersions(created.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('publishPipeline: повторная публикация без изменений идемпотентна', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const created = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });

    const first = await publishPipeline({ pipelines, record: created });
    // Повторная публикация того же черновика — без изменений.
    const second = await publishPipeline({ pipelines, record: first.pipeline });

    expect(second.published.version).toBe(first.published.version);
    expect(second.published.publishedAt).toBe(first.published.publishedAt);
    // Версии не плодим.
    expect(await pipelines.listVersions(created.id)).toHaveLength(1);
    // Черновик не сдвинут.
    expect(second.pipeline.draftVersion).toBe(first.pipeline.draftVersion);
    expect(second.pipeline.publishedVersion).toBe(first.pipeline.publishedVersion);
  });

  it('publishPipeline: без черновика — ошибка nothing_to_publish', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const created = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });
    const withoutDraft = { ...created, draft: undefined };

    const error = await publishPipeline({ pipelines, record: withoutDraft }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PipelineAuthoringError);
    expect((error as PipelineAuthoringError).code).toBe('nothing_to_publish');
  });

  it('deletePipeline: удаляет пайплайн и его версии', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const created = await createPipelineDraft({
      pipelines,
      projectId: 'proj-1',
      spec: validSpec(),
    });
    await publishPipeline({ pipelines, record: created });

    expect(await deletePipeline({ pipelines, pipelineId: created.id })).toBe(true);
    expect(await pipelines.getPipeline(created.id)).toBeNull();
    expect(await pipelines.listVersions(created.id)).toHaveLength(0);
    // Повторное удаление — `false`.
    expect(await deletePipeline({ pipelines, pipelineId: created.id })).toBe(false);
  });
});
