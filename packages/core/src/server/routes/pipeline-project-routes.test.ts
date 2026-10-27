import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { ProjectRole } from '@itphx/synth-shared';
import type { PipelineSpec, Project } from '@itphx/synth-shared';
import { createPipelineProjectRoutes } from './pipeline-project-routes.js';
import { MemoryProjectPipelineRepository, MemoryPipelineRunRepository } from '../../storage/memory/pipelines.js';
// Legacy-реестр шаблонов инстанца (ADR-100) — реализация в `memory/content.ts`
// (`storage/memory/pipelines.ts` — новые порты движка ADR-101).
import { MemoryPipelineRepository } from '../../storage/memory/content.js';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import type { PipelineDefinitionRecord } from '../../storage/ports/pipeline-repository.js';
import { PipelineEngine } from '../../engine/pipelines/index.js';
import { PipelineArtifactStore } from '../../engine/pipelines/artifacts.js';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { MemoryBlobRefRepository } from '../../storage/memory/blob-refs.js';
import { gateDecisionResult } from '../../engine/pipelines/index.js';
import type { StepExecutionContext, StepExecutor, StepOutcome } from '../../engine/pipelines/index.js';

/**
 * ADR-101 (Э6): тесты HTTP-контура пайплайнов проекта, прогонов, HITL и
 * шаблонов инстанса + матрица прав (инвариант 17).
 */

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

/** Проект для тестов. */
function project(id: string, ownerId: string, members: Record<string, ProjectRole> = {}): Project {
  return {
    id,
    name: id,
    ownerId,
    members,
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Простой порт проектов поверх массива (изоляция теста от ФС). */
function createProjectsStore(projects: Project[]): ProjectRepository {
  return {
    async load(id) {
      return projects.find((p) => p.id === id) ?? null;
    },
    async save(p) {
      const index = projects.findIndex((item) => item.id === p.id);
      if (index === -1) projects.push(p);
      else projects[index] = p;
    },
    async delete(id) {
      const index = projects.findIndex((item) => item.id === id);
      if (index !== -1) projects.splice(index, 1);
    },
    async list() {
      return [...projects];
    },
    create(name, ownerId) {
      const created = project(`proj_${projects.length + 1}`, ownerId);
      created.name = name;
      projects.push(created);
      return created;
    },
  };
}

/** Спецификация пайплайна из одного human-узла (HITL-пауза). */
function spec(overrides: Partial<PipelineSpec> = {}): PipelineSpec {
  return {
    id: 'ignored',
    name: 'PR Pipeline',
    version: 1,
    status: 'draft',
    mode: 'act',
    nodes: [{ id: 'approve', kind: 'human', title: 'Согласовать' }],
    exits: [{ kind: 'none' }],
    ...overrides,
  };
}

/**
 * Исполнитель human-узла: без решения оператора — пауза (гейт), после
 * `resume` — результат по решению оператора.
 *
 * Решение приводится к результату шага **тем же** помощником, что и в
 * боевом исполнителе (`engine/pipelines/gate.ts` → `gateDecisionResult`):
 * одобрение — `ok`, отклонение — `failed` с кодом `pipeline.gate_rejected`.
 */
const humanExecutor: StepExecutor = {
  kind: 'human',
  async execute(ctx: StepExecutionContext): Promise<StepOutcome> {
    if (ctx.gateDecision) {
      return gateDecisionResult(ctx.gateDecision, ctx.node, ctx.attempt);
    }
    return {
      kind: 'gate',
      gate: {
        kind: 'human',
        nodeId: ctx.node.id,
        question: ctx.node.prompt ?? 'Подтвердите шаг',
        title: ctx.node.title,
        ...(ctx.node.timeoutSec !== undefined ? { timeoutSec: ctx.node.timeoutSec } : {}),
      },
    };
  },
};

/** Тестовое окружение: порты + движок + приложение. */
function createHarness(options: {
  projects: Project[];
  /** Роль текущего пользователя (для правил проекта). */
  userId?: string;
  /** Права на проект: по умолчанию — владелец. */
  canRead?: (c: Context, p: Project, userId: string) => boolean;
  canEdit?: (c: Context, p: Project, userId: string) => boolean;
  /** Scope'ы service-key в контексте (для проверки scope-гейта). */
  serviceScopes?: string[];
  /** Legacy-определения пайплайнов (шаблоны инстанса, ADR-100). */
  templates?: PipelineDefinitionRecord[];
  /** ADR-116: хранилище артефактов прогонов (раздача байтов). */
  artifacts?: PipelineArtifactStore;
} = { projects: [] }) {
  const pipelines = new MemoryProjectPipelineRepository();
  const runs = new MemoryPipelineRunRepository();
  const templates = new MemoryPipelineRepository();
  for (const definition of options.templates ?? []) {
    void templates.saveDefinition(definition);
  }
  const engine = new PipelineEngine({
    pipelines,
    runs,
    executors: [humanExecutor],
    sleep: async () => undefined,
  });
  const projects = createProjectsStore(options.projects);
  const userId = options.userId ?? 'owner';

  const app = new Hono();
  app.use('*', async (c, next) => {
    if (options.serviceScopes) {
      c.set('serviceKey' as never, {
        keyId: 'svk_test',
        label: 'test',
        roles: [],
        scopes: options.serviceScopes,
      } as never);
    }
    await next();
  });
  app.route(
    '/api/v2',
    createPipelineProjectRoutes(
      createMockAuth(),
      {
        pipelines,
        runs,
        engine,
        projects,
        templates,
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
      },
      {
        getCurrentUserId: () => userId,
        canReadProject: options.canRead,
        canEditProject: options.canEdit,
      },
    ),
  );

  return { app, pipelines, runs, templates, engine };
}

/** Legacy-определение пайплайна (ADR-100) для тестов. */
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

describe('Pipeline project routes (ADR-101, Э6)', () => {
  let projects: Project[];

  beforeEach(() => {
    projects = [project('proj-1', 'owner'), project('proj-2', 'other')];
  });

  describe('CRUD пайплайна проекта', () => {
    it('POST /projects/:id/pipelines — создаёт пайплайн с черновиком', async () => {
      const { app, pipelines } = createHarness({ projects });

      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Релизы', description: 'авто', spec: spec() }),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.pipeline.id).toMatch(/^pl_/);
      expect(body.pipeline.scope).toBe('project');
      expect(body.pipeline.projectId).toBe('proj-1');
      expect(body.pipeline.name).toBe('Релизы');
      expect(body.pipeline.draftVersion).toBe(1);
      expect(body.pipeline.publishedVersion).toBeUndefined();
      // Сервер проставляет свои поля в черновике.
      expect(body.pipeline.draft.id).toBe(body.pipeline.id);
      expect(body.pipeline.draft.status).toBe('draft');
      expect(body.pipeline.draft.projectId).toBe('proj-1');

      // Запись сохранена в порту.
      const stored = await pipelines.getPipeline(body.pipeline.id);
      expect(stored?.name).toBe('Релизы');
    });

    it('POST /projects/:id/pipelines — 400 со списком проблем на невалидной спецификации', async () => {
      const { app } = createHarness({ projects });

      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec: {
            ...spec(),
            // Переход ведёт на несуществующий узел — семантическая ошибка графа.
            nodes: [
              { id: 'a', kind: 'agent', agent: 'x', on: [{ when: { path: 'prev.output.x', op: 'exists' }, then: 'missing' }] },
            ],
          },
        }),
      });

      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(body.error.problems)).toBe(true);
      expect(body.error.problems.join(' ')).toContain('missing');
    });

    it('POST /projects/:id/pipelines — пустой `spec.id` (серверное поле) не роняет тело в 400', async () => {
      const { app } = createHarness({ projects });

      // Клиент (диалог создания) может прислать `id: ''` — серверное поле
      // «не задано»: сервер всё равно проставляет своё значение.
      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Релизы',
          spec: { ...spec(), id: '', version: 1, status: 'draft', projectId: 'proj-1' },
        }),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.pipeline.id).toMatch(/^pl_/);
      expect(body.pipeline.draft.id).toBe(body.pipeline.id);
      expect(body.pipeline.draft.projectId).toBe('proj-1');
    });

    it('POST /projects/:id/pipelines — клиентский `spec.id` игнорируется (серверный)', async () => {
      const { app } = createHarness({ projects });

      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec({ id: 'abc' }) }),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.pipeline.id).toMatch(/^pl_/);
      expect(body.pipeline.id).not.toBe('abc');
      expect(body.pipeline.draft.id).toBe(body.pipeline.id);
    });

    it('POST /projects/:id/pipelines — 400 на структурно невалидной спецификации (nodes: [])', async () => {
      const { app } = createHarness({ projects });

      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: { ...spec(), id: '', nodes: [] } }),
      });

      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.problems.join(' ')).toContain('узел');
    });

    it('POST /projects/:id/pipelines — 400 на семантически невалидной спецификации (узел «agent» без «agent»)', async () => {
      const { app } = createHarness({ projects });

      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec: { ...spec(), id: '', nodes: [{ id: 'step-1', kind: 'agent' }] },
        }),
      });

      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.problems.join(' ')).toContain('agent');
    });

    it('POST /projects/:id/pipelines — 400 без спецификации', async () => {
      const { app } = createHarness({ projects });

      const res = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Релизы' }),
      });

      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.problems.length).toBeGreaterThan(0);
    });

    it('GET /projects/:id/pipelines — список пайплайнов проекта', async () => {
      const { app } = createHarness({ projects });

      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const createdBody: any = await created.json();

      const list = await app.request('/api/v2/projects/proj-1/pipelines');
      expect(list.status).toBe(200);
      const listBody: any = await list.json();
      expect(listBody.pipelines).toHaveLength(1);
      expect(listBody.pipelines[0].id).toBe(createdBody.pipeline.id);
      expect(listBody.pipelines[0].draftVersion).toBe(1);
      expect(listBody.pipelines[0].publishedVersion).toBeUndefined();

      // Пайплайны другого проекта не видны.
      const other = await app.request('/api/v2/projects/proj-2/pipelines');
      const otherBody: any = await other.json();
      expect(otherBody.pipelines).toHaveLength(0);
    });

    it('PUT /projects/:id/pipelines/:pid — сохраняет черновик без bump версии', async () => {
      const { app } = createHarness({ projects });
      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;

      const res = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Релизы v2',
          spec: spec({ nodes: [{ id: 'approve', kind: 'human', title: 'Согласовать v2' }] }),
        }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.pipeline.name).toBe('Релизы v2');
      expect(body.pipeline.draftVersion).toBe(1);
      expect(body.pipeline.draft.nodes[0].title).toBe('Согласовать v2');
    });

    it('PUT /projects/:id/pipelines/:pid — пустой `spec.id` (JSON-режим) не роняет запрос в 400', async () => {
      const { app } = createHarness({ projects });
      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;

      // Пользователь очистил `id` в JSON-режиме редактора: серверное поле
      // «не задано» — сервер подставляет своё значение.
      const res = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec: { ...spec(), id: '', version: 1, status: 'draft' },
        }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.pipeline.draft.id).toBe(pipeline.id);
      expect(body.pipeline.draft.projectId).toBe('proj-1');
    });

    it('POST /projects/:id/pipelines/:pid/publish — версия растёт, опубликованная неизменяема', async () => {
      const { app, pipelines } = createHarness({ projects });
      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;

      const first = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/publish`, {
        method: 'POST',
      });
      expect(first.status).toBe(200);
      const firstBody: any = await first.json();
      expect(firstBody.pipeline.publishedVersion).toBe(1);
      expect(firstBody.pipeline.draftVersion).toBe(2);
      expect(firstBody.published.version).toBe(1);
      expect(firstBody.published.spec.status).toBe('published');

      // Повторная публикация без изменений — идемпотентный ответ (версий не больше).
      const second = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/publish`, {
        method: 'POST',
      });
      expect(second.status).toBe(200);
      const secondBody: any = await second.json();
      expect(secondBody.pipeline.publishedVersion).toBe(1);
      expect(secondBody.pipeline.draftVersion).toBe(2);
      expect((await pipelines.listVersions(pipeline.id)).map((v) => v.version)).toEqual([1]);

      // Правка черновика → следующая публикация создаёт версию 2.
      await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec: spec({ nodes: [{ id: 'approve', kind: 'human', title: 'Согласовать v2' }] }),
        }),
      });
      const third = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/publish`, {
        method: 'POST',
      });
      expect(third.status).toBe(200);
      const thirdBody: any = await third.json();
      expect(thirdBody.pipeline.publishedVersion).toBe(2);
      expect(thirdBody.pipeline.draftVersion).toBe(3);
      expect((await pipelines.listVersions(pipeline.id)).map((v) => v.version)).toEqual([1, 2]);

      // Опубликованная версия 1 не менялась после правки черновика.
      const v1 = await pipelines.getVersion(pipeline.id, 1);
      expect(v1?.spec.nodes[0]?.title).toBe('Согласовать');
    });

    it('DELETE /projects/:id/pipelines/:pid — удаляет пайплайн, прогоны остаются', async () => {
      const { app, pipelines, runs } = createHarness({ projects });
      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;
      await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/publish`, { method: 'POST' });

      const runRes = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { kind: 'manual' } }),
      });
      expect(runRes.status).toBe(201);
      const { run } = (await runRes.json()) as any;

      const del = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}`, {
        method: 'DELETE',
      });
      expect(del.status).toBe(204);
      expect(await pipelines.getPipeline(pipeline.id)).toBeNull();
      expect(await pipelines.listVersions(pipeline.id)).toEqual([]);
      // Прогон самодостаточен — переживает удаление пайплайна.
      expect(await runs.getRun(run.id)).not.toBeNull();
    });

    it('404 для несуществующего проекта и чужого пайплайна', async () => {
      const { app } = createHarness({ projects });
      const missingProject = await app.request('/api/v2/projects/nope/pipelines');
      expect(missingProject.status).toBe(404);

      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;

      // Пайплайн другого проекта под чужим id — 404 (не 403: ресурс не в этом проекте).
      const foreign = await app.request(`/api/v2/projects/proj-2/pipelines/${pipeline.id}`);
      expect(foreign.status).toBe(404);
    });
  });

  describe('Прогоны и HITL', () => {
    /** Создать пайплайн с опубликованной версией. */
    async function createPublished(app: Hono): Promise<string> {
      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;
      await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/publish`, { method: 'POST' });
      return pipeline.id;
    }

    it('POST /runs — 409, если нет опубликованной версии', async () => {
      const { app } = createHarness({ projects });
      const created = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      const { pipeline } = (await created.json()) as any;

      const res = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body.error.code).toBe('pipeline.not_published');
    });

    it('POST /runs — запускает прогон; GET /pipeline-runs/:runId отдаёт журнал', async () => {
      const { app } = createHarness({ projects });
      const pipelineId = await createPublished(app);

      const res = await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { kind: 'user', source: 'ui', payload: { issue: 42 } } }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.run.pipelineId).toBe(pipelineId);
      expect(body.run.projectId).toBe('proj-1');
      expect(body.run.version).toBe(1);
      // human-узел — прогон встал на паузу до решения человека.
      expect(body.run.status).toBe('awaiting_human');
      expect(body.run.currentNode).toBe('approve');
      expect(body.run.trigger).toEqual({ kind: 'user', source: 'ui', payload: { issue: 42 } });

      const detail = await app.request(`/api/v2/pipeline-runs/${body.run.id}`);
      expect(detail.status).toBe(200);
      const detailBody: any = await detail.json();
      expect(detailBody.run.id).toBe(body.run.id);
      expect(detailBody.run.status).toBe('awaiting_human');
      const types = detailBody.events.map((e: any) => e.type);
      expect(types).toContain('run.started');
      expect(types).toContain('gate.awaiting');
    });

    it('POST /pipeline-runs/:runId/resume — одобрение продолжает прогон', async () => {
      const { app } = createHarness({ projects });
      const pipelineId = await createPublished(app);
      const started = await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { run } = (await started.json()) as any;

      const res = await app.request(`/api/v2/pipeline-runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true, output: { ok: 1 }, comment: 'согласовано' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.run.status).toBe('done');
      expect(body.run.finishedAt).toBeDefined();
    });

    it('POST /pipeline-runs/:runId/resume — отклонение валит шаг', async () => {
      const { app } = createHarness({ projects });
      const pipelineId = await createPublished(app);
      const started = await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { run } = (await started.json()) as any;

      const res = await app.request(`/api/v2/pipeline-runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: false, comment: 'не согласовано' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.run.status).toBe('failed');
      // `run.error` — текст ошибки; машиночитаемый код — в журнале прогона
      // (`run.failed.payload.code`), как и в движке (ADR-101 §2.9).
      expect(body.run.error).toContain('approve');
      const detail = await app.request(`/api/v2/pipeline-runs/${run.id}`);
      const detailBody: any = await detail.json();
      const failed = detailBody.events.find((e: any) => e.type === 'run.failed');
      expect(failed?.payload?.code).toBe('pipeline.gate_rejected');
    });

    it('POST /pipeline-runs/:runId/resume — 409, если прогон не ждёт решения', async () => {
      const { app } = createHarness({ projects });
      const pipelineId = await createPublished(app);
      const started = await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { run } = (await started.json()) as any;
      await app.request(`/api/v2/pipeline-runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });

      const again = await app.request(`/api/v2/pipeline-runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      expect(again.status).toBe(409);
      const body: any = await again.json();
      expect(body.error.code).toBe('pipeline.invalid_state');
    });

    it('POST /pipeline-runs/:runId/cancel — отменяет прогон на паузе', async () => {
      const { app, runs } = createHarness({ projects });
      const pipelineId = await createPublished(app);
      const started = await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { run } = (await started.json()) as any;

      const res = await app.request(`/api/v2/pipeline-runs/${run.id}/cancel`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.run.status).toBe('cancelled');
      expect(body.run.finishedAt).toBeDefined();

      const stored = await runs.getRun(run.id);
      expect(stored?.status).toBe('cancelled');
      // Событие отмены попало в журнал прогона.
      const events = await runs.listEvents(run.id);
      expect(events.some((e) => e.type === 'run.failed')).toBe(true);
    });

    it('POST /pipeline-runs/:runId/cancel — 404 для неизвестного прогона', async () => {
      const { app } = createHarness({ projects });
      const res = await app.request('/api/v2/pipeline-runs/nope/cancel', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('GET /projects/:id/pipelines/:pid/runs — список прогонов с фильтром статуса', async () => {
      const { app } = createHarness({ projects });
      const pipelineId = await createPublished(app);
      await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const list = await app.request(`/api/v2/projects/proj-1/pipelines/${pipelineId}/runs`);
      expect(list.status).toBe(200);
      const listBody: any = await list.json();
      expect(listBody.runs).toHaveLength(1);

      const filtered = await app.request(
        `/api/v2/projects/proj-1/pipelines/${pipelineId}/runs?status=awaiting_human`,
      );
      const filteredBody: any = await filtered.json();
      expect(filteredBody.runs).toHaveLength(1);

      const empty = await app.request(
        `/api/v2/projects/proj-1/pipelines/${pipelineId}/runs?status=done`,
      );
      const emptyBody: any = await empty.json();
      expect(emptyBody.runs).toHaveLength(0);

      // Неизвестный статус — 400 (fail-closed).
      const bad = await app.request(
        `/api/v2/projects/proj-1/pipelines/${pipelineId}/runs?status=nope`,
      );
      expect(bad.status).toBe(400);
    });
  });

  describe('Шаблоны инстанса и инстанцирование', () => {
    it('GET /pipeline-templates — список шаблонов инстанса (legacy-определения)', async () => {
      const { app } = createHarness({
        projects,
        templates: [
          legacyDefinition('publication', { installedBy: { pack: 'synth-media', version: '1.0.0' } }),
        ],
      });

      const res = await app.request('/api/v2/pipeline-templates');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.templates).toHaveLength(1);
      expect(body.templates[0].id).toBe('publication');
      expect(body.templates[0].format).toBe('adr-100');
      expect(body.templates[0].installedBy).toEqual({ pack: 'synth-media', version: '1.0.0' });
    });

    it('POST /pipeline-templates/:tid/instantiate — создаёт черновик в проекте', async () => {
      const { app } = createHarness({
        projects,
        templates: [
          legacyDefinition('publication', { installedBy: { pack: 'synth-media', version: '1.0.0' } }),
        ],
      });

      const res = await app.request('/api/v2/pipeline-templates/publication/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.pipeline.scope).toBe('project');
      expect(body.pipeline.projectId).toBe('proj-1');
      expect(body.pipeline.draftVersion).toBe(1);
      expect(body.pipeline.publishedVersion).toBeUndefined();
      expect(body.pipeline.installedBy).toEqual({
        pack: 'synth-media',
        version: '1.0.0',
        templateId: 'publication',
      });
      // Спецификация шаблона сконвертирована в спецификацию движка.
      expect(body.pipeline.draft.nodes[0]).toMatchObject({ id: 'step-1', kind: 'agent', agent: 'publisher' });
      expect(body.pipeline.draft.exits).toHaveLength(1);
    });

    it('POST /pipeline-templates/:tid/instantiate — 409 для неконвертируемого шаблона', async () => {
      const { app } = createHarness({
        projects,
        templates: [
          legacyDefinition('looping', {
            steps: [{ id: 'step-1', kind: 'loop' }],
          }),
        ],
      });

      const res = await app.request('/api/v2/pipeline-templates/looping/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1' }),
      });
      expect(res.status).toBe(409);
      const body: any = await res.json();
      expect(body.error.code).toBe('PIPELINE_TEMPLATE_UNSUPPORTED');
      expect(body.error.problems.join(' ')).toContain('loop');
    });

    it('POST /pipeline-templates/:tid/instantiate — 404 для неизвестного шаблона', async () => {
      const { app } = createHarness({ projects });
      const res = await app.request('/api/v2/pipeline-templates/nope/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1' }),
      });
      expect(res.status).toBe(404);
    });

    it('POST /pipeline-templates/:tid/instantiate — ensure:true идемпотентен', async () => {
      const { app, pipelines } = createHarness({
        projects,
        templates: [
          legacyDefinition('publication', { installedBy: { pack: 'synth-media', version: '1.0.0' } }),
        ],
      });

      const body = JSON.stringify({ projectId: 'proj-1', ensure: true });
      const first = await app.request('/api/v2/pipeline-templates/publication/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(first.status).toBe(201);
      const firstBody: any = await first.json();
      expect(firstBody.created).toBe(true);
      expect(firstBody.pipeline.installedBy).toEqual({
        pack: 'synth-media',
        version: '1.0.0',
        templateId: 'publication',
      });

      const second = await app.request('/api/v2/pipeline-templates/publication/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(second.status).toBe(200);
      const secondBody: any = await second.json();
      expect(secondBody.created).toBe(false);
      // Возвращается тот же пайплайн — копии не появилось.
      expect(secondBody.pipeline.id).toBe(firstBody.pipeline.id);
      expect(secondBody.pipeline.installedBy.templateId).toBe('publication');

      const stored = await pipelines.listPipelines({ scope: 'project', projectId: 'proj-1' });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe(firstBody.pipeline.id);
    });

    it('POST /pipeline-templates/:tid/instantiate — без ensure каждый вызов создаёт пайплайн', async () => {
      const { app, pipelines } = createHarness({
        projects,
        templates: [
          legacyDefinition('publication', { installedBy: { pack: 'synth-media', version: '1.0.0' } }),
        ],
      });

      const body = JSON.stringify({ projectId: 'proj-1' });
      const first = await app.request('/api/v2/pipeline-templates/publication/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const second = await app.request('/api/v2/pipeline-templates/publication/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstBody: any = await first.json();
      const secondBody: any = await second.json();
      expect(firstBody.created).toBe(true);
      expect(secondBody.created).toBe(true);
      expect(secondBody.pipeline.id).not.toBe(firstBody.pipeline.id);

      const stored = await pipelines.listPipelines({ scope: 'project', projectId: 'proj-1' });
      expect(stored).toHaveLength(2);
    });

    it('POST /pipeline-templates/:tid/instantiate — провенанс без пакета получает pack "instance"', async () => {
      const { app } = createHarness({
        projects,
        templates: [legacyDefinition('plain')],
      });

      const res = await app.request('/api/v2/pipeline-templates/plain/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.pipeline.installedBy).toEqual({
        pack: 'instance',
        version: '1',
        templateId: 'plain',
      });
    });

    it('GET /projects/:id/pipelines — templateId виден в списке проекта', async () => {
      const { app } = createHarness({
        projects,
        templates: [
          legacyDefinition('publication', { installedBy: { pack: 'synth-media', version: '1.0.0' } }),
        ],
      });

      const created = await app.request('/api/v2/pipeline-templates/publication/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1', ensure: true }),
      });
      const createdBody: any = await created.json();

      const list = await app.request('/api/v2/projects/proj-1/pipelines');
      expect(list.status).toBe(200);
      const listBody: any = await list.json();
      expect(listBody.pipelines).toHaveLength(1);
      expect(listBody.pipelines[0].id).toBe(createdBody.pipeline.id);
      expect(listBody.pipelines[0].installedBy).toEqual({
        pack: 'synth-media',
        version: '1.0.0',
        templateId: 'publication',
      });
    });
  });

  describe('Матрица прав (инвариант 17)', () => {
    /** Правила проекта по ролям участников (ADR-089 §5.5/§5.8). */
    function roleRules() {
      return {
        canRead: (_c: Context, p: Project, uid: string) =>
          p.ownerId === uid || uid in (p.members ?? {}),
        canEdit: (_c: Context, p: Project, uid: string) =>
          p.ownerId === uid || p.members?.[uid] === ProjectRole.OWNER || p.members?.[uid] === ProjectRole.EDITOR,
      };
    }

    it('VIEWER читает, но не мутирует', async () => {
      projects = [project('proj-1', 'owner', { viewer: ProjectRole.VIEWER })];
      const { app } = createHarness({
        projects,
        userId: 'viewer',
        ...roleRules(),
      });

      const list = await app.request('/api/v2/projects/proj-1/pipelines');
      expect(list.status).toBe(200);

      const create = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(create.status).toBe(403);
    });

    it('чужой проект — 403 и на чтение, и на запись', async () => {
      const { app } = createHarness({ projects, userId: 'stranger', ...roleRules() });

      const list = await app.request('/api/v2/projects/proj-1/pipelines');
      expect(list.status).toBe(403);

      const create = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(create.status).toBe(403);
    });

    it('участник-EDITOR мутирует пайплайны проекта', async () => {
      projects = [project('proj-1', 'owner', { editor: ProjectRole.EDITOR })];
      const { app } = createHarness({ projects, userId: 'editor', ...roleRules() });

      const create = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(create.status).toBe(201);
      const { pipeline } = (await create.json()) as any;

      const publish = await app.request(`/api/v2/projects/proj-1/pipelines/${pipeline.id}/publish`, {
        method: 'POST',
      });
      expect(publish.status).toBe(200);
    });

    it('владелец проекта мутирует; ADMIN/LEAD (elevated) видят и мутируют', async () => {
      const { app } = createHarness({ projects, userId: 'owner', ...roleRules() });
      const create = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(create.status).toBe(201);

      // Elevated (ADMIN/LEAD) — сквозной обзор: права на любой проект.
      const elevated = createHarness({
        projects,
        userId: 'admin',
        canRead: () => true,
        canEdit: () => true,
      });
      const elevatedList = await elevated.app.request('/api/v2/projects/proj-2/pipelines');
      expect(elevatedList.status).toBe(200);
      const elevatedCreate = await elevated.app.request('/api/v2/projects/proj-2/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(elevatedCreate.status).toBe(201);
    });

    it('service-key без scope `automation:install` — 403 SCOPE_REQUIRED', async () => {
      const { app } = createHarness({
        projects,
        serviceScopes: ['events:ingest'],
      });

      const create = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(create.status).toBe(403);
      const body: any = await create.json();
      expect(body.error.code).toBe('SCOPE_REQUIRED');
    });

    it('service-key со scope `automation:install` — мутации разрешены', async () => {
      const { app } = createHarness({
        projects,
        serviceScopes: ['automation:install'],
      });

      const create = await app.request('/api/v2/projects/proj-1/pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: spec() }),
      });
      expect(create.status).toBe(201);
    });
  });

  describe('Артефакты прогона (ADR-116)', () => {
    /** Артефактное хранилище поверх in-memory ссылок и временного каталога. */
    async function artifactsHarness() {
      const dir = await mkdtemp(join(tmpdir(), 'synth-pipeline-artifacts-routes-'));
      const blobs = new FileBlobStore({ root: join(dir, 'blobs') });
      const refs = new MemoryBlobRefRepository();
      return { artifacts: new PipelineArtifactStore({ blobs, blobRefs: refs }), blobs, refs };
    }

    /** Прогон проекта с журналом, где выход сообщил артефакт (ADR-116). */
    async function seedRun(
      runs: MemoryPipelineRunRepository,
      overrides: Partial<{ projectId: string; runId: string }> = {},
    ) {
      const runId = overrides.runId ?? 'prun_1';
      const projectId = overrides.projectId ?? 'proj-1';
      const now = new Date().toISOString();
      await runs.saveRun({
        id: runId,
        pipelineId: 'pl_1',
        version: 1,
        spec: spec({ status: 'published', projectId }),
        projectId,
        status: 'done',
        createdAt: now,
        updatedAt: now,
      });
      await runs.appendEvent({
        runId,
        ts: now,
        type: 'run.finished',
        payload: {
          status: 'done',
          exits: [{ kind: 'file', file: { path: 'out/report.md' } }],
          artifacts: [
            {
              kind: 'blob',
              path: `artifacts/${runId}/report.md`,
              name: 'report.md',
              mime: 'text/markdown; charset=utf-8',
              size: 5,
            },
          ],
        },
      });
      return runId;
    }

    it('GET /pipeline-runs/:runId/artifacts/:name — байты с Content-Type/ETag/Disposition', async () => {
      const { artifacts } = await artifactsHarness();
      const { app, runs } = createHarness({ projects, artifacts });
      const runId = await seedRun(runs);
      await artifacts.put(runId, { name: 'report.md', bytes: Buffer.from('отчёт') });

      const res = await app.request(`/api/v2/pipeline-runs/${runId}/artifacts/report.md`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/markdown');
      expect(res.headers.get('Content-Disposition')).toContain('attachment');
      expect(res.headers.get('Content-Disposition')).toContain('report.md');
      expect(res.headers.get('ETag')).toBeTruthy();
      expect(res.headers.get('Content-Length')).toBe(String(Buffer.byteLength('отчёт')));
      expect(await res.text()).toBe('отчёт');

      // Условный запрос: объект неизменяем.
      const cached = await app.request(`/api/v2/pipeline-runs/${runId}/artifacts/report.md`, {
        headers: { 'If-None-Match': res.headers.get('ETag') as string },
      });
      expect(cached.status).toBe(304);
    });

    it('нет артефакта — 404; нет хранилища артефактов — тоже 404', async () => {
      const { artifacts } = await artifactsHarness();
      const { app, runs } = createHarness({ projects, artifacts });
      const runId = await seedRun(runs);

      const missing = await app.request(`/api/v2/pipeline-runs/${runId}/artifacts/missing.md`);
      expect(missing.status).toBe(404);
      const body: any = await missing.json();
      expect(body.error.code).toBe('NOT_FOUND');

      // Прогон без артефактов (хранилище не подключено) — ничего не раздаём.
      const headless = createHarness({ projects });
      await seedRun(headless.runs, { runId: 'prun_2' });
      const noStore = await headless.app.request(
        '/api/v2/pipeline-runs/prun_2/artifacts/report.md',
      );
      expect(noStore.status).toBe(404);
    });

    it('нет права чтения проекта — 403 (права те же, что у чтения прогона)', async () => {
      const { artifacts } = await artifactsHarness();
      const { app, runs } = createHarness({
        projects,
        artifacts,
        canRead: (_c, project) => project.id === 'proj-1',
      });
      const runId = await seedRun(runs, { projectId: 'proj-2', runId: 'prun_3' });

      const res = await app.request(`/api/v2/pipeline-runs/${runId}/artifacts/report.md`);
      expect(res.status).toBe(403);
    });
  });
});
