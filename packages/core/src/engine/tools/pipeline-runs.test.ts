/**
 * ADR-101: тесты встроенных тулов прогонов пайплайна
 * (`engine/tools/pipeline-runs.ts`).
 *
 * Контекст — по образцу `pipeline-authoring.test.ts`: настоящий `SessionManager` +
 * `FileStore` (сессия и её атрибуция), `ProjectStore` (проект и его роли) и
 * порты пайплайнов/прогонов в памяти (`MemoryProjectPipelineRepository`/
 * `MemoryPipelineRunRepository`) — чтобы тест не зависел от ФС и проверял
 * тулы, а не хранилище.
 *
 * Движок — **фейковый**: объект с `run`/`resume`, который создаёт и обновляет
 * запись прогона в memory-порту и резолвит промис. Прогон «висит» до
 * `release()`/отмены — иначе нечего проверять (soft-lock и отмена идущего
 * прогона).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { generateId, ProjectRole } from '@itphx/synth-shared';
import type { PipelineSpec } from '@itphx/synth-shared';
import {
  pipelineRunTool,
  pipelineRunStatusTool,
  pipelineRunListTool,
  pipelineRunResumeTool,
  pipelineRunCancelTool,
} from './pipeline-runs.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import {
  MemoryProjectPipelineRepository,
  MemoryPipelineRunRepository,
} from '../../storage/memory/pipelines.js';
import type { PipelineRunRecord } from '../../storage/ports/index.js';
import { PipelineRunControl } from '../pipelines/run-control.js';
import { PipelineEngineError } from '../pipelines/types.js';
import type { PipelineEngine } from '../pipelines/engine.js';

/** Спецификация одного узла (ADR-101 §2.2). */
function makeSpec(pipelineId: string): PipelineSpec {
  return {
    id: pipelineId,
    name: 'Тестовый пайплайн',
    version: 1,
    status: 'published',
    mode: 'act',
    nodes: [{ id: 'n1', kind: 'agent', agent: 'developer' }],
    exits: [{ kind: 'none' }],
  };
}

/** Решение человека по гейту (контракт `PipelineEngine.resume`). */
interface FakeDecision {
  approved: boolean;
  output?: Record<string, unknown>;
  comment?: string;
}

/** Фейковый движок пайплайнов: пишет запись прогона в порт. */
interface FakeEngine {
  run(opts: {
    pipelineId: string;
    version?: number;
    projectId?: string;
    trigger: { kind: string };
    signal?: AbortSignal;
  }): Promise<PipelineRunRecord>;
  resume(runId: string, decision: FakeDecision): Promise<PipelineRunRecord>;
  /** Вызовы `resume` — проверка HITL-действия. */
  resumeCalls: Array<{ runId: string; decision: FakeDecision }>;
  /** Снять soft-lock: завершить текущий (висящий) прогон. */
  release(): void;
}

function createFakeEngine(runs: MemoryPipelineRunRepository): FakeEngine {
  const resumeCalls: FakeEngine['resumeCalls'] = [];
  let counter = 0;
  let release: (() => void) | null = null;

  const engine: FakeEngine = {
    resumeCalls,
    async run(opts) {
      const now = new Date().toISOString();
      const record: PipelineRunRecord = {
        id: `prun_${++counter}`,
        pipelineId: opts.pipelineId,
        version: opts.version ?? 1,
        spec: makeSpec(opts.pipelineId),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        status: 'running',
        currentNode: 'n1',
        trigger: { kind: opts.trigger.kind as 'manual' },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await runs.saveRun(record);
      await runs.appendEvent({
        runId: record.id,
        ts: now,
        type: 'run.started',
        payload: { pipelineId: opts.pipelineId },
      });

      // Прогон «идёт», пока его не завершат (`release`) или не отменят.
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          void (async () => {
            const ts = new Date().toISOString();
            await runs.saveRun({
              ...record,
              status: 'cancelled',
              finishedAt: ts,
              updatedAt: ts,
              error: 'pipeline.cancelled',
            });
            resolve();
          })();
        };
        if (opts.signal) {
          if (opts.signal.aborted) {
            onAbort();
            return;
          }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        release = () => {
          opts.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
      });
      return record;
    },
    async resume(runId, decision) {
      resumeCalls.push({ runId, decision });
      const stored = await runs.getRun(runId);
      if (!stored) {
        throw new PipelineEngineError('pipeline.run_not_found', 'run not found');
      }
      if (stored.status !== 'awaiting_human') {
        throw new PipelineEngineError('pipeline.invalid_state', 'invalid state');
      }
      const now = new Date().toISOString();
      const updated: PipelineRunRecord = {
        ...stored,
        status: 'done',
        finishedAt: now,
        updatedAt: now,
      };
      await runs.saveRun(updated);
      return updated;
    },
    release() {
      const fn = release;
      release = null;
      fn?.();
    },
  };
  return engine;
}

describe('Встроенные тулы прогонов пайплайнов (ADR-101, pipeline-runs.ts)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let pipelines: MemoryProjectPipelineRepository;
  let runs: MemoryPipelineRunRepository;
  let runControl: PipelineRunControl;
  let engine: FakeEngine;
  let sessionId: string;
  let projectId: string;

  const PIPELINE_ID = 'pl_test';

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

  /** Опубликованный пайплайн проекта (версия 1 опубликована). */
  async function seedPublishedPipeline(): Promise<void> {
    const now = new Date().toISOString();
    await pipelines.savePipeline({
      id: PIPELINE_ID,
      scope: 'project',
      projectId,
      name: 'Тестовый пайплайн',
      draft: { ...makeSpec(PIPELINE_ID), version: 2, status: 'draft' },
      draftVersion: 2,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await pipelines.saveVersion({
      pipelineId: PIPELINE_ID,
      version: 1,
      spec: makeSpec(PIPELINE_ID),
      publishedAt: now,
    });
  }

  /** Пайплайн проекта без опубликованной версии. */
  async function seedDraftOnlyPipeline(): Promise<void> {
    const now = new Date().toISOString();
    await pipelines.savePipeline({
      id: PIPELINE_ID,
      scope: 'project',
      projectId,
      name: 'Тестовый пайплайн',
      draft: { ...makeSpec(PIPELINE_ID), version: 1, status: 'draft' },
      draftVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Прогон в заданном статусе (в порту прогонов). */
  async function seedRun(
    id: string,
    status: PipelineRunRecord['status'],
    ownerProjectId: string | undefined = projectId,
  ): Promise<void> {
    const now = new Date().toISOString();
    await runs.saveRun({
      id,
      pipelineId: PIPELINE_ID,
      version: 1,
      spec: makeSpec(PIPELINE_ID),
      ...(ownerProjectId ? { projectId: ownerProjectId } : {}),
      status,
      currentNode: 'n1',
      startedAt: now,
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
        automation: {
          pipelines,
          runs,
          runControl,
          engine: engine as unknown as PipelineEngine,
        },
        ...extra,
      },
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pipeline-runs-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    pipelines = new MemoryProjectPipelineRepository();
    runs = new MemoryPipelineRunRepository();
    runControl = new PipelineRunControl();
    engine = createFakeEngine(runs);

    const project = projectStore.create('Pipeline Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Runs' });
    sessionId = session.id;
    await bindSession('u1', 'u1');
  });

  afterEach(async () => {
    engine.release();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pipeline_run без опубликованной версии → not_published', async () => {
    await seedDraftOnlyPipeline();

    const result = await pipelineRunTool.execute({ pipeline_id: PIPELINE_ID }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no published version');
    expect(await runs.listRuns({})).toHaveLength(0);
  });

  it('pipeline_run запускает прогон: metadata.runId и статус из заголовка', async () => {
    await seedPublishedPipeline();

    const result = await pipelineRunTool.execute(
      { pipeline_id: PIPELINE_ID, input: { issue: '42' } },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.runId).toMatch(/^prun_/);
    expect(result.metadata?.pipelineId).toBe(PIPELINE_ID);
    expect(result.metadata?.status).toBe('running');
    expect(result.content).toContain(result.metadata?.runId as string);

    const stored = await runs.getRun(result.metadata?.runId as string);
    expect(stored?.status).toBe('running');
    expect(stored?.projectId).toBe(projectId);
  });

  it('pipeline_run: второй запуск того же пайплайна при активном → already_running', async () => {
    await seedPublishedPipeline();

    const first = await pipelineRunTool.execute({ pipeline_id: PIPELINE_ID }, makeCtx());
    expect(first.isError).toBeUndefined();

    const second = await pipelineRunTool.execute({ pipeline_id: PIPELINE_ID }, makeCtx());
    expect(second.isError).toBe(true);
    expect(second.content).toContain('already has a running execution');
    // Второй прогон не создан.
    expect(await runs.listRuns({})).toHaveLength(1);
  });

  it('pipeline_run_status отдаёт журнал прогона', async () => {
    await seedRun('prun_status', 'running');
    await runs.appendEvent({
      runId: 'prun_status',
      ts: '2026-01-01T00:00:00.000Z',
      type: 'node.started',
      payload: { node: 'n1' },
    });

    const result = await pipelineRunStatusTool.execute({ run_id: 'prun_status' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.runId).toBe('prun_status');
    expect(result.metadata?.status).toBe('running');
    expect(result.content).toContain('node.started');
    expect(result.content).toContain('n1');
  });

  it('pipeline_run_status: прогон чужого проекта → run_foreign', async () => {
    const foreign = projectStore.create('Чужой проект', 'other');
    await projectStore.save(foreign);
    await seedRun('prun_foreign', 'running', foreign.id);

    const result = await pipelineRunStatusTool.execute({ run_id: 'prun_foreign' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('another project');
  });

  it('pipeline_run_status: неизвестный прогон → run_not_found', async () => {
    const result = await pipelineRunStatusTool.execute({ run_id: 'prun_missing' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('pipeline_run_resume: прогон не ждёт решения → run_not_waiting', async () => {
    await seedRun('prun_running', 'running');

    const result = await pipelineRunResumeTool.execute(
      { run_id: 'prun_running', approved: true },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not waiting');
    expect(engine.resumeCalls).toHaveLength(0);
  });

  it('pipeline_run_resume: awaiting_human → решение применено (движок получил resume)', async () => {
    await seedRun('prun_wait', 'awaiting_human');

    const result = await pipelineRunResumeTool.execute(
      { run_id: 'prun_wait', approved: true, comment: 'ок' },
      makeCtx(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.runId).toBe('prun_wait');
    expect(engine.resumeCalls).toHaveLength(1);
    expect(engine.resumeCalls[0]?.runId).toBe('prun_wait');
    expect(engine.resumeCalls[0]?.decision.approved).toBe(true);
    expect(engine.resumeCalls[0]?.decision.comment).toBe('ок');
  });

  it('pipeline_run_cancel: активный прогон → run_cancelled', async () => {
    await seedPublishedPipeline();
    const started = await pipelineRunTool.execute({ pipeline_id: PIPELINE_ID }, makeCtx());
    const runId = started.metadata?.runId as string;

    const result = await pipelineRunCancelTool.execute({ run_id: runId }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(runId);
    expect(result.metadata?.runId).toBe(runId);
  });

  it('pipeline_run_cancel: терминальный прогон → run_not_waiting', async () => {
    await seedRun('prun_done', 'done');

    const result = await pipelineRunCancelTool.execute({ run_id: 'prun_done' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not waiting');
  });

  it('pipeline_run_list фильтрует по проекту и статусу; пусто → runs_empty', async () => {
    await seedPublishedPipeline();
    await seedRun('prun_a', 'running');
    await seedRun('prun_b', 'done');
    const foreign = projectStore.create('Чужой проект', 'other');
    await projectStore.save(foreign);
    await seedRun('prun_c', 'running', foreign.id);

    const all = await pipelineRunListTool.execute({}, makeCtx());
    expect(all.isError).toBeUndefined();
    expect(all.metadata?.count).toBe(2);
    expect(all.content).toContain('prun_a');
    expect(all.content).toContain('prun_b');
    expect(all.content).not.toContain('prun_c');

    const onlyRunning = await pipelineRunListTool.execute({ status: 'running' }, makeCtx());
    expect(onlyRunning.metadata?.count).toBe(1);
    expect(onlyRunning.content).toContain('prun_a');
    expect(onlyRunning.content).not.toContain('prun_b');

    const byPipeline = await pipelineRunListTool.execute(
      { pipeline_id: PIPELINE_ID },
      makeCtx(),
    );
    expect(byPipeline.metadata?.count).toBe(2);

    const empty = await pipelineRunListTool.execute({ status: 'failed' }, makeCtx());
    expect(empty.isError).toBeUndefined();
    expect(empty.metadata?.count).toBe(0);
    expect(empty.content).toContain('No pipeline runs');
  });

  it('pipeline_run_list: чужой пайплайн → not_found', async () => {
    const result = await pipelineRunListTool.execute(
      { pipeline_id: 'pl_foreign' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('VIEWER: запуск/резолюция/отмена — forbidden, чтение работает', async () => {
    await seedPublishedPipeline();
    await seedRun('prun_view', 'running');

    const project = (await projectStore.load(projectId))!;
    project.members['u2'] = ProjectRole.VIEWER;
    await projectStore.save(project);
    await bindSession('u2', undefined);

    const list = await pipelineRunListTool.execute({}, makeCtx());
    expect(list.isError).toBeUndefined();
    expect(list.metadata?.count).toBe(1);

    const status = await pipelineRunStatusTool.execute({ run_id: 'prun_view' }, makeCtx());
    expect(status.isError).toBeUndefined();

    const run = await pipelineRunTool.execute({ pipeline_id: PIPELINE_ID }, makeCtx());
    expect(run.isError).toBe(true);
    expect(run.content).toContain('permission');

    const resume = await pipelineRunResumeTool.execute(
      { run_id: 'prun_view', approved: true },
      makeCtx(),
    );
    expect(resume.isError).toBe(true);
    expect(resume.content).toContain('permission');

    const cancel = await pipelineRunCancelTool.execute({ run_id: 'prun_view' }, makeCtx());
    expect(cancel.isError).toBe(true);
    expect(cancel.content).toContain('permission');
  });

  it('сессия без проекта → no_project (isError)', async () => {
    await bindSession('u1', 'u1', null);

    const result = await pipelineRunListTool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No project');
  });

  it('тулы уважают «Стоп»: сигнал отмены до запуска — операция не выполняется', async () => {
    await seedPublishedPipeline();
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx();
    ctx.abortSignal = controller.signal;

    const result = await pipelineRunTool.execute({ pipeline_id: PIPELINE_ID }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('stopped_by_user');
    expect(result.metadata?.interrupted).toBe(true);

    // Прогон не запущен.
    expect(await runs.listRuns({})).toHaveLength(0);
  });
});
