/**
 * ADR-101: тесты встроенных тулов пайплайнов проекта — чтение и авторство
 * (`engine/tools/pipeline-authoring.ts`).
 *
 * Контекст — по образцу `project-manage.test.ts`: настоящий `SessionManager` +
 * `FileStore` (сессия и её атрибуция), `ProjectStore` (проект и его роли) и
 * порт пайплайнов в памяти (`MemoryProjectPipelineRepository`) — чтобы тест не
 * зависел от ФС и проверял тулы, а не хранилище.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId, ProjectRole } from '@itphx/synth-shared';
import {
  pipelineListTool,
  pipelineGetTool,
  pipelineSaveTool,
  pipelinePublishTool,
  pipelineDeleteTool,
} from './pipeline-authoring.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import {
  MemoryProjectPipelineRepository,
  MemoryPipelineRunRepository,
} from '../../storage/memory/pipelines.js';
import { PipelineRunControl } from '../pipelines/run-control.js';

/** Минимальная валидная спецификация одного шага (ADR-101 §2.2). */
function validSpec(name = 'Тестовый пайплайн') {
  return {
    name,
    mode: 'act' as const,
    nodes: [{ id: 'n1', kind: 'agent' as const, agent: 'developer' }],
    exits: [{ kind: 'none' as const }],
  };
}

/** Спецификация с ошибкой графа: узел `agent` без поля `agent`. */
function brokenSpec() {
  return {
    name: 'Битый пайплайн',
    mode: 'act' as const,
    nodes: [{ id: 'n1', kind: 'agent' as const }],
    exits: [{ kind: 'none' as const }],
  };
}

describe('Встроенные тулы пайплайнов (ADR-101, pipeline-authoring.ts)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let pipelines: MemoryProjectPipelineRepository;
  let sessionId: string;
  let projectId: string;

  /**
   * Привязать сессию к проекту с заданной атрибуцией.
   *
   * `targetProjectId: null` — отвязать сессию от проекта (второй аргумент
   * `undefined` означал бы «дефолт», поэтому «нет проекта» — это `null`).
   */
  async function bindSession(
    userId?: string,
    ownerId?: string,
    targetProjectId: string | null = projectId,
  ): Promise<void> {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = targetProjectId ?? undefined;
      s.userId = userId;
      s.ownerId = ownerId;
      await sessionManager.saveSession(s);
    });
  }

  function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        sessionId,
        automation: {
          pipelines,
          runs: new MemoryPipelineRunRepository(),
          runControl: new PipelineRunControl(),
        },
        ...extra,
      },
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pipeline-tools-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    pipelines = new MemoryProjectPipelineRepository();

    const project = projectStore.create('Pipeline Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Pipelines' });
    sessionId = session.id;
    await bindSession('u1', 'u1');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pipeline_list на пустом проекте → list_empty, не ошибка', async () => {
    const result = await pipelineListTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('No pipelines in the project');
    expect(result.metadata?.count).toBe(0);
    expect(result.metadata?.projectId).toBe(projectId);
  });

  it('pipeline_list печатает пайплайны проекта (id, имя, версии)', async () => {
    const created = await pipelineSaveTool.execute({ name: 'Пайплайн', spec: validSpec() }, makeCtx());
    const pipelineId = created.metadata?.pipelineId as string;

    const list = await pipelineListTool.execute({}, makeCtx());
    expect(list.isError).toBeUndefined();
    expect(list.content).toContain(`- ${pipelineId} «Пайплайн» — draft v1, published v—`);
    expect(list.metadata?.count).toBe(1);
    expect(list.metadata?.projectId).toBe(projectId);
  });

  it('pipeline_save создаёт черновик; повторный save с pipeline_id обновляет без bump версии', async () => {
    const created = await pipelineSaveTool.execute({ name: 'Пайплайн', spec: validSpec() }, makeCtx());
    expect(created.isError).toBeUndefined();

    const pipelineId = created.metadata?.pipelineId as string;
    expect(pipelineId).toMatch(/^pl_/);
    expect(created.metadata?.version).toBe(1);

    const stored = await pipelines.getPipeline(pipelineId);
    expect(stored?.scope).toBe('project');
    expect(stored?.projectId).toBe(projectId);
    expect(stored?.draftVersion).toBe(1);
    expect(stored?.publishedVersion).toBeUndefined();

    // Повторная правка — тот же id, версия черновика **не** bump'ается.
    const updated = await pipelineSaveTool.execute(
      { pipeline_id: pipelineId, spec: validSpec('Переименованный') },
      makeCtx(),
    );
    expect(updated.isError).toBeUndefined();
    expect(updated.metadata?.pipelineId).toBe(pipelineId);
    expect(updated.metadata?.version).toBe(1);

    const after = await pipelines.getPipeline(pipelineId);
    expect(after?.draftVersion).toBe(1);
    expect(after?.name).toBe('Переименованный');
  });

  it('pipeline_save с невалидной спекой → isError с проблемой в тексте', async () => {
    const result = await pipelineSaveTool.execute({ spec: brokenSpec() }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid pipeline specification');
    expect(result.content).toContain('agent');
    // Запись не создана.
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(0);
  });

  it('pipeline_publish публикует версию и увеличивает draftVersion; повторная публикация не плодит версии', async () => {
    const created = await pipelineSaveTool.execute({ spec: validSpec() }, makeCtx());
    const pipelineId = created.metadata?.pipelineId as string;

    const published = await pipelinePublishTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(published.isError).toBeUndefined();
    expect(published.metadata?.version).toBe(1);
    expect(published.metadata?.pipelineId).toBe(pipelineId);

    const afterPublish = await pipelines.getPipeline(pipelineId);
    expect(afterPublish?.publishedVersion).toBe(1);
    expect(afterPublish?.draftVersion).toBe(2);

    // Повторная публикация без изменений — идемпотентна.
    const again = await pipelinePublishTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(again.isError).toBeUndefined();
    expect(again.metadata?.version).toBe(1);

    const versions = await pipelines.listVersions(pipelineId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
  });

  it('pipeline_delete удаляет пайплайн; повторный вызов → not_found', async () => {
    const created = await pipelineSaveTool.execute({ spec: validSpec() }, makeCtx());
    const pipelineId = created.metadata?.pipelineId as string;

    const deleted = await pipelineDeleteTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(deleted.isError).toBeUndefined();
    expect(deleted.content).toContain(pipelineId);
    expect(await pipelines.getPipeline(pipelineId)).toBeNull();

    const again = await pipelineDeleteTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(again.isError).toBe(true);
    expect(again.content).toContain('not found');
  });

  it('сессия без проекта → no_project (isError)', async () => {
    await bindSession('u1', 'u1', null);

    for (const execute of [
      () => pipelineListTool.execute({}, makeCtx()),
      () => pipelineGetTool.execute({ pipeline_id: 'pl_x' }, makeCtx()),
      () => pipelineSaveTool.execute({ spec: validSpec() }, makeCtx()),
      () => pipelinePublishTool.execute({ pipeline_id: 'pl_x' }, makeCtx()),
      () => pipelineDeleteTool.execute({ pipeline_id: 'pl_x' }, makeCtx()),
    ]) {
      const result = await execute();
      expect(result.isError).toBe(true);
      expect(result.content).toContain('No project');
    }
  });

  it('VIEWER: save/publish/delete — forbidden, list/get работают', async () => {
    // Владелец создаёт пайплайн — его читает и правит участник с ролью VIEWER.
    const created = await pipelineSaveTool.execute({ spec: validSpec() }, makeCtx());
    const pipelineId = created.metadata?.pipelineId as string;

    const project = (await projectStore.load(projectId))!;
    project.members['u2'] = ProjectRole.VIEWER;
    await projectStore.save(project);
    await bindSession('u2', undefined);

    const list = await pipelineListTool.execute({}, makeCtx());
    expect(list.isError).toBeUndefined();
    expect(list.content).toContain(pipelineId);

    const get = await pipelineGetTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(get.isError).toBeUndefined();
    expect(get.metadata?.pipelineId).toBe(pipelineId);

    const save = await pipelineSaveTool.execute(
      { pipeline_id: pipelineId, spec: validSpec('Взлом') },
      makeCtx(),
    );
    expect(save.isError).toBe(true);
    expect(save.content).toContain('permission');

    const publish = await pipelinePublishTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(publish.isError).toBe(true);
    expect(publish.content).toContain('permission');

    const remove = await pipelineDeleteTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(remove.isError).toBe(true);
    expect(remove.content).toContain('permission');

    // Пайплайн не тронут.
    const stored = await pipelines.getPipeline(pipelineId);
    expect(stored?.name).toBe('Тестовый пайплайн');
    expect(stored?.publishedVersion).toBeUndefined();
  });

  it('pipeline_get пайплайна другого проекта → not_found', async () => {
    const foreign = projectStore.create('Чужой проект', 'other');
    await projectStore.save(foreign);
    await pipelines.savePipeline({
      id: 'pl_foreign',
      scope: 'project',
      projectId: foreign.id,
      name: 'Чужой пайплайн',
      draftVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await pipelineGetTool.execute({ pipeline_id: 'pl_foreign' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');

    // Чужой пайплайн не виден и в списке проекта.
    const list = await pipelineListTool.execute({}, makeCtx());
    expect(list.content).not.toContain('pl_foreign');

    // И его нельзя изменить/удалить — существование чужого ресурса не раскрывается.
    const save = await pipelineSaveTool.execute(
      { pipeline_id: 'pl_foreign', spec: validSpec('Взлом') },
      makeCtx(),
    );
    expect(save.isError).toBe(true);
    expect(save.content).toContain('not found');

    const publish = await pipelinePublishTool.execute({ pipeline_id: 'pl_foreign' }, makeCtx());
    expect(publish.isError).toBe(true);
    expect(publish.content).toContain('not found');

    const remove = await pipelineDeleteTool.execute({ pipeline_id: 'pl_foreign' }, makeCtx());
    expect(remove.isError).toBe(true);
    expect(remove.content).toContain('not found');

    // Чужой пайплайн не тронут.
    expect((await pipelines.getPipeline('pl_foreign'))?.name).toBe('Чужой пайплайн');
  });

  it('pipeline_get: запрошенная опубликованная версия отдаётся, несуществующая — not_published', async () => {
    const created = await pipelineSaveTool.execute({ spec: validSpec() }, makeCtx());
    const pipelineId = created.metadata?.pipelineId as string;

    // До публикации опубликованной версии нет.
    const draftOnly = await pipelineGetTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(draftOnly.isError).toBeUndefined();
    expect(draftOnly.metadata?.version).toBeUndefined();

    await pipelinePublishTool.execute({ pipeline_id: pipelineId }, makeCtx());

    const published = await pipelineGetTool.execute({ pipeline_id: pipelineId }, makeCtx());
    expect(published.isError).toBeUndefined();
    expect(published.metadata?.version).toBe(1);
    expect(published.content).toContain('"published"');

    const missing = await pipelineGetTool.execute(
      { pipeline_id: pipelineId, version: 99 },
      makeCtx(),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('no published version');
  });

  it('pipeline_save/publish/delete с неизвестным pipeline_id → not_found', async () => {
    const save = await pipelineSaveTool.execute(
      { pipeline_id: 'pl_missing', spec: validSpec() },
      makeCtx(),
    );
    expect(save.isError).toBe(true);
    expect(save.content).toContain('not found');

    const publish = await pipelinePublishTool.execute({ pipeline_id: 'pl_missing' }, makeCtx());
    expect(publish.isError).toBe(true);
    expect(publish.content).toContain('not found');

    const remove = await pipelineDeleteTool.execute({ pipeline_id: 'pl_missing' }, makeCtx());
    expect(remove.isError).toBe(true);
    expect(remove.content).toContain('not found');
  });

  it('без extra.automation → deps_unavailable (isError)', async () => {
    const ctx = makeCtx();
    delete (ctx.extra as Record<string, unknown>).automation;

    const result = await pipelineListTool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pipeline runtime is unavailable');
    expect(result.content).toContain('pipeline_list');
  });

  it('рантайм без порта пайплайнов → deps_unavailable (isError)', async () => {
    const ctx = makeCtx({ automation: { runs: new MemoryPipelineRunRepository() } });

    const result = await pipelineListTool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pipeline runtime is unavailable');
  });

  it('тулы уважают «Стоп»: сигнал отмены до запуска — операция не выполняется', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx();
    ctx.abortSignal = controller.signal;

    const result = await pipelineSaveTool.execute({ spec: validSpec() }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('stopped_by_user');
    expect(result.metadata?.interrupted).toBe(true);

    // Пайплайн не создан.
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(0);
  });
});
