/**
 * ADR-101: тесты встроенных тулов шаблонов пайплайнов
 * (`engine/tools/pipeline-templates.ts`).
 *
 * Контекст — по образцу `pipeline-authoring.test.ts`: настоящий `SessionManager` +
 * `FileStore` (сессия и её атрибуция), `ProjectStore` (проект и его роли) и
 * порты пайплайнов в памяти (`MemoryProjectPipelineRepository`) + legacy-реестр
 * шаблонов (`MemoryPipelineRepository`, ADR-100).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId, ProjectRole } from '@itphx/synth-shared';
import type { PipelineSpec } from '@itphx/synth-shared';
import { pipelineTemplatesTool, pipelineInstantiateTool } from './pipeline-templates.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { MemoryProjectPipelineRepository } from '../../storage/memory/pipelines.js';
import { MemoryPipelineRepository } from '../../storage/memory/content.js';
import type { PipelineDefinitionRecord } from '../../storage/ports/pipeline-repository.js';

/** Спецификация шаблона инстанца нового формата (ADR-101 §2.2). */
function templateSpec(id: string, name: string): PipelineSpec {
  return {
    id,
    name,
    version: 1,
    status: 'draft',
    mode: 'act',
    nodes: [{ id: 'n1', kind: 'agent', agent: 'publisher' }],
    exits: [{ kind: 'none' }],
  };
}

/** Legacy-определение пакета (ADR-100) для тестов. */
function legacyDefinition(
  id: string,
  overrides: Partial<PipelineDefinitionRecord> = {},
): PipelineDefinitionRecord {
  return {
    id,
    name: id,
    version: '1.0.0',
    steps: [{ id: 'step-1', kind: 'agent', agent: 'publisher', prompt: 'сделай' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Встроенные тулы шаблонов пайплайнов (ADR-101, pipeline-templates.ts)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let pipelines: MemoryProjectPipelineRepository;
  let templates: MemoryPipelineRepository;
  let sessionId: string;
  let projectId: string;

  /** Привязать сессию к проекту с заданной атрибуцией. */
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

  /** Шаблон инстанца нового формата (`scope:'instance'`). */
  async function seedInstanceTemplate(id: string, name: string): Promise<void> {
    const now = new Date().toISOString();
    await pipelines.savePipeline({
      id,
      scope: 'instance',
      name,
      description: 'Описание шаблона',
      draft: templateSpec(id, name),
      draftVersion: 1,
      installedBy: { pack: 'builtin', version: '1' },
      createdAt: now,
      updatedAt: now,
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
        automation: { pipelines, templates },
        ...extra,
      },
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pipeline-templates-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    pipelines = new MemoryProjectPipelineRepository();
    templates = new MemoryPipelineRepository();

    const project = projectStore.create('Pipeline Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Templates' });
    sessionId = session.id;
    await bindSession('u1', 'u1');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pipeline_templates без проекта возвращает шаблоны обоих форматов', async () => {
    await seedInstanceTemplate('tpl_instance', 'Шаблон инстанца');
    await templates.saveDefinition(legacyDefinition('tpl_legacy'));

    // Сессия без проекта — шаблоны инстанца проект не требуют.
    await bindSession('u1', 'u1', null);

    const result = await pipelineTemplatesTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.count).toBe(2);
    expect(result.content).toContain('- tpl_instance «Шаблон инстанца» (adr-101)');
    expect(result.content).toContain('- tpl_legacy «tpl_legacy» (adr-100)');
  });

  it('pipeline_templates: без шаблонов → templates_empty', async () => {
    const result = await pipelineTemplatesTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.count).toBe(0);
    expect(result.content).toContain('No pipeline templates');
  });

  it('pipeline_instantiate создаёт черновик пайплайна проекта с installedBy.templateId', async () => {
    await seedInstanceTemplate('tpl_instance', 'Шаблон инстанца');

    const result = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_instance' },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.created).toBe(true);
    expect(result.metadata?.templateId).toBe('tpl_instance');

    const pipelineId = result.metadata?.pipelineId as string;
    const stored = await pipelines.getPipeline(pipelineId);
    expect(stored?.scope).toBe('project');
    expect(stored?.projectId).toBe(projectId);
    expect(stored?.draftVersion).toBe(1);
    expect(stored?.publishedVersion).toBeUndefined();
    expect(stored?.installedBy?.templateId).toBe('tpl_instance');
    expect(stored?.installedBy?.pack).toBe('builtin');
  });

  it('pipeline_instantiate с ensure:true не создаёт копию (created:false)', async () => {
    await seedInstanceTemplate('tpl_instance', 'Шаблон инстанца');

    const first = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_instance' },
      makeCtx(),
    );
    expect(first.metadata?.created).toBe(true);

    const second = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_instance', ensure: true },
      makeCtx(),
    );
    expect(second.isError).toBeUndefined();
    expect(second.metadata?.created).toBe(false);
    expect(second.metadata?.pipelineId).toBe(first.metadata?.pipelineId);

    // Копий не появилось.
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(1);
  });

  it('pipeline_instantiate: неизвестный шаблон → template_not_found', async () => {
    const result = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_missing' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(0);
  });

  it('pipeline_instantiate: legacy-шаблон с шагом loop → template_unsupported', async () => {
    await templates.saveDefinition(
      legacyDefinition('tpl_loop', {
        steps: [{ id: 'loop-1', kind: 'loop' }],
      }),
    );

    const result = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_loop' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('loop');
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(0);
  });

  it('VIEWER: pipeline_instantiate — forbidden', async () => {
    await seedInstanceTemplate('tpl_instance', 'Шаблон инстанца');

    const project = (await projectStore.load(projectId))!;
    project.members['u2'] = ProjectRole.VIEWER;
    await projectStore.save(project);
    await bindSession('u2', undefined);

    const result = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_instance' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('permission');
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(0);
  });

  it('без extra.automation → deps_unavailable (isError)', async () => {
    const ctx = makeCtx();
    delete (ctx.extra as Record<string, unknown>).automation;

    const result = await pipelineTemplatesTool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pipeline runtime is unavailable');
  });

  it('тулы уважают «Стоп»: сигнал отмены до запуска — операция не выполняется', async () => {
    await seedInstanceTemplate('tpl_instance', 'Шаблон инстанца');
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx();
    ctx.abortSignal = controller.signal;

    const result = await pipelineInstantiateTool.execute(
      { template_id: 'tpl_instance' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('stopped_by_user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(await pipelines.listPipelines({ scope: 'project', projectId })).toHaveLength(0);
  });
});
