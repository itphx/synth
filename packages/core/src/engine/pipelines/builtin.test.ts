import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { pipelineSpecSchema, validatePipelineSpec } from '@itphx/synth-shared';
import type { PipelineSpec, Project } from '@itphx/synth-shared';

import {
  buildMemoryConsolidateFactsPipelineSpec,
  buildMemoryConsolidationPipelineSpec,
  buildMemoryReindexPipelineSpec,
  ensureBuiltinPipelines,
  MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
  MEMORY_CONSOLIDATION_PIPELINE_ID,
  MEMORY_CONSOLIDATION_PIPELINE_VERSION,
  MEMORY_REINDEX_PIPELINE_ID,
} from './builtin.js';
import { createPipelineProjectRoutes } from '../../server/routes/pipeline-project-routes.js';
import {
  MemoryProjectPipelineRepository,
  MemoryPipelineRunRepository,
} from '../../storage/memory/pipelines.js';
import { MemoryPipelineRepository } from '../../storage/memory/content.js';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import type { ProjectPipelineRepository } from '../../storage/ports/project-pipeline-repository.js';
import { PipelineEngine } from './index.js';

/**
 * ADR-101: встроенный шаблон пайплайна «Память: консолидация сессии»
 * (спецификация, сидирование, видимость в шаблонах инстанца, инстанцирование).
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
function project(id: string, ownerId: string): Project {
  return {
    id,
    name: id,
    ownerId,
    members: {},
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Публичное представление шаблона инстанца (`GET /pipeline-templates`). */
interface TemplateView {
  id: string;
  name: string;
  description?: string;
  format: 'adr-101' | 'adr-100';
  version?: number;
  installedBy?: { pack: string; version: string };
  spec?: PipelineSpec;
}

/** Пайплайн проекта в ответе инстанцирования. */
interface PipelineView {
  id: string;
  scope: 'instance' | 'project';
  projectId?: string;
  draftVersion: number;
  publishedVersion?: number;
  installedBy?: { pack: string; version: string };
  draft: PipelineSpec;
}

/** Простой порт проектов поверх массива (изоляция теста от ФС). */function createProjectsStore(projects: Project[]): ProjectRepository {
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

describe('Встроенный шаблон пайплайна «Память: консолидация сессии» (ADR-101)', () => {
  describe('спецификация', () => {
    it('проходит схему pipelineSpecSchema', () => {
      const spec = buildMemoryConsolidationPipelineSpec();
      const parsed = pipelineSpecSchema.safeParse(spec);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.id).toBe(MEMORY_CONSOLIDATION_PIPELINE_ID);
      expect(parsed.data.version).toBe(MEMORY_CONSOLIDATION_PIPELINE_VERSION);
      expect(parsed.data.mode).toBe('act');
      expect(parsed.data.status).toBe('draft');
    });

    it('проходит validatePipelineSpec (валидатор графа)', () => {
      const spec = buildMemoryConsolidationPipelineSpec();
      const result = validatePipelineSpec(spec);
      expect(result.ok).toBe(true);
    });

    it('объявляет вход sessionId и один узел agent', () => {
      const spec = buildMemoryConsolidationPipelineSpec();
      expect(spec.io?.input?.required).toEqual(['sessionId']);
      expect(spec.vars?.sessionId).toBe('trigger.payload.sessionId');
      expect(spec.nodes).toHaveLength(1);
      const node = spec.nodes[0]!;
      expect(node.kind).toBe('agent');
      expect(node.agent).toBe('assistant');
      expect(node.input).toEqual(['trigger.payload.sessionId']);
      expect(node.timeoutSec).toBe(600);
      // Промпт шага — с указанием тулов чтения сессии и записи факта.
      expect(node.prompt).toContain('read_session_reference');
      expect(node.prompt).toContain('memory_write');
      expect(node.prompt).toContain('candidates');
      // Выход — без внешнего следа.
      expect(spec.exits).toEqual([{ kind: 'none' }]);
    });
  });

  describe('шаблон «Память: слияние дублей фактов»', () => {
    it('проходит схему и валидатор графа', () => {
      const spec = buildMemoryConsolidateFactsPipelineSpec();
      expect(pipelineSpecSchema.safeParse(spec).success).toBe(true);
      expect(validatePipelineSpec(spec)).toEqual({ ok: true });
      expect(spec.id).toBe(MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID);
      expect(spec.mode).toBe('act');
    });

    it('объявляет один узел tool с тулом плагина памяти и dryRun:false', () => {
      const spec = buildMemoryConsolidateFactsPipelineSpec();
      expect(spec.name).toBe('Память: слияние дублей фактов');
      expect(spec.nodes).toHaveLength(1);
      const node = spec.nodes[0]!;
      expect(node.kind).toBe('tool');
      expect(node.tool).toBe('plugin_synth_plugin_memory_memory_consolidate');
      expect(node.toolArgs).toEqual({ dryRun: false });
      expect(node.timeoutSec).toBe(600);
      expect(spec.exits).toEqual([{ kind: 'none' }]);
      // Обязательного входа у шаблона нет.
      expect(spec.io?.input).toEqual({ type: 'object', properties: {} });
      expect(spec.io?.input?.required).toBeUndefined();
    });
  });

  describe('шаблон «Память: переиндексация проекта»', () => {
    it('проходит схему и валидатор графа', () => {
      const spec = buildMemoryReindexPipelineSpec();
      expect(pipelineSpecSchema.safeParse(spec).success).toBe(true);
      expect(validatePipelineSpec(spec)).toEqual({ ok: true });
      expect(spec.id).toBe(MEMORY_REINDEX_PIPELINE_ID);
      expect(spec.mode).toBe('act');
    });

    it('объявляет один узел tool с memory_index и rebuild_all/wait', () => {
      const spec = buildMemoryReindexPipelineSpec();
      expect(spec.name).toBe('Память: переиндексация проекта');
      expect(spec.nodes).toHaveLength(1);
      const node = spec.nodes[0]!;
      expect(node.kind).toBe('tool');
      expect(node.tool).toBe('plugin_synth_plugin_memory_memory_index');
      expect(node.toolArgs).toEqual({ action: 'rebuild_all', wait: true });
      expect(node.timeoutSec).toBe(900);
      expect(spec.exits).toEqual([{ kind: 'none' }]);
      expect(spec.io?.input).toEqual({ type: 'object', properties: {} });
      expect(spec.io?.input?.required).toBeUndefined();
    });
  });

  describe('сидирование', () => {
    it('создаёт запись шаблона и опубликованную версию', async () => {
      const pipelines = new MemoryProjectPipelineRepository();
      const result = await ensureBuiltinPipelines({ pipelines }, () => '2026-01-01T00:00:00.000Z');

      expect(result.created).toEqual([
        MEMORY_CONSOLIDATION_PIPELINE_ID,
        MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
        MEMORY_REINDEX_PIPELINE_ID,
      ]);
      expect(result.skipped).toEqual([]);

      const record = await pipelines.getPipeline(MEMORY_CONSOLIDATION_PIPELINE_ID);
      expect(record).not.toBeNull();
      expect(record!.scope).toBe('instance');
      expect(record!.projectId).toBeUndefined();
      expect(record!.draftVersion).toBe(1);
      expect(record!.publishedVersion).toBe(1);
      expect(record!.installedBy).toEqual({ pack: 'builtin', version: '1' });
      expect(record!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(record!.draft?.id).toBe(MEMORY_CONSOLIDATION_PIPELINE_ID);

      const version = await pipelines.getVersion(MEMORY_CONSOLIDATION_PIPELINE_ID, 1);
      expect(version).not.toBeNull();
      expect(version!.spec.status).toBe('published');
      expect(version!.spec.version).toBe(1);
      expect(version!.publishedBy).toBe('system');
      expect(version!.publishedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('сидит все три шаблона памяти с версией 1 и провенансом builtin/1', async () => {
      const pipelines = new MemoryProjectPipelineRepository();
      await ensureBuiltinPipelines({ pipelines }, () => '2026-01-01T00:00:00.000Z');

      for (const id of [
        MEMORY_CONSOLIDATION_PIPELINE_ID,
        MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
        MEMORY_REINDEX_PIPELINE_ID,
      ]) {
        const record = await pipelines.getPipeline(id);
        expect(record, id).not.toBeNull();
        expect(record!.scope, id).toBe('instance');
        expect(record!.draftVersion, id).toBe(1);
        expect(record!.publishedVersion, id).toBe(1);
        expect(record!.installedBy, id).toEqual({ pack: 'builtin', version: '1' });
        const versions = await pipelines.listVersions(id);
        expect(versions, id).toHaveLength(1);
        expect(versions[0]!.spec.status, id).toBe('published');
      }
    });

    it('идемпотентен: повторный вызов не перезаписывает запись и версии', async () => {
      const pipelines = new MemoryProjectPipelineRepository();
      await ensureBuiltinPipelines({ pipelines }, () => '2026-01-01T00:00:00.000Z');
      const first = await pipelines.getPipeline(MEMORY_CONSOLIDATION_PIPELINE_ID);

      const second = await ensureBuiltinPipelines(
        { pipelines },
        () => '2026-02-02T00:00:00.000Z',
      );
      expect(second.created).toEqual([]);
      expect(second.skipped).toEqual([
        MEMORY_CONSOLIDATION_PIPELINE_ID,
        MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
        MEMORY_REINDEX_PIPELINE_ID,
      ]);

      const record = await pipelines.getPipeline(MEMORY_CONSOLIDATION_PIPELINE_ID);
      // `createdAt` иммутабельно, `updatedAt` не меняется (записи не было).
      expect(record!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(record!.updatedAt).toBe(first!.updatedAt);
      expect(record!.draftVersion).toBe(1);
      expect(record!.publishedVersion).toBe(1);
      expect(await pipelines.listVersions(MEMORY_CONSOLIDATION_PIPELINE_ID)).toHaveLength(1);
    });

    it('ошибка записи не пробрасывается — шаблон попадает в failed', async () => {
      const broken: ProjectPipelineRepository = {
        getPipeline: async () => null,
        listPipelines: async () => [],
        deletePipeline: async () => false,
        saveVersion: async () => undefined,
        getVersion: async () => null,
        listVersions: async () => [],
        savePipeline: async () => {
          throw new Error('storage unavailable');
        },
      };

      const warnings: string[] = [];
      const result = await ensureBuiltinPipelines(
        { pipelines: broken, logger: { warn: (message) => warnings.push(message) } },
        () => '2026-01-01T00:00:00.000Z',
      );

      expect(result.failed).toEqual([
        MEMORY_CONSOLIDATION_PIPELINE_ID,
        MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
        MEMORY_REINDEX_PIPELINE_ID,
      ]);
      expect(result.created).toEqual([]);
      expect(warnings.join(' ')).toContain('storage unavailable');
    });

    it('шаблон виден в listPipelines({scope:"instance"})', async () => {
      const pipelines = new MemoryProjectPipelineRepository();
      await ensureBuiltinPipelines({ pipelines }, () => '2026-01-01T00:00:00.000Z');

      const instance = await pipelines.listPipelines({ scope: 'instance' });
      expect(instance.map((p) => p.id)).toEqual([
        MEMORY_CONSOLIDATE_FACTS_PIPELINE_ID,
        MEMORY_CONSOLIDATION_PIPELINE_ID,
        MEMORY_REINDEX_PIPELINE_ID,
      ]);

      const projectScoped = await pipelines.listPipelines({ scope: 'project' });
      expect(projectScoped).toHaveLength(0);
    });
  });

  describe('HTTP-контур шаблонов инстанца', () => {
    /** Приложение с seeded-шаблоном (общий порт — как в боевом контуре). */
    async function createApp() {
      const pipelines = new MemoryProjectPipelineRepository();
      const runs = new MemoryPipelineRunRepository();
      const templates = new MemoryPipelineRepository();
      const projects = createProjectsStore([project('proj-1', 'owner')]);
      await ensureBuiltinPipelines({ pipelines }, () => '2026-01-01T00:00:00.000Z');

      const engine = new PipelineEngine({ pipelines, runs, executors: [], sleep: async () => undefined });
      const app = new Hono();
      app.route(
        '/api/v2',
        createPipelineProjectRoutes(
          createMockAuth(),
          { pipelines, runs, engine, projects, templates },
          { getCurrentUserId: () => 'owner' },
        ),
      );
      return { app, pipelines };
    }

    it('GET /pipeline-templates отдаёт встроенный шаблон с format "adr-101"', async () => {
      const { app } = await createApp();
      const res = await app.request('/api/v2/pipeline-templates');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { templates: TemplateView[] };
      const template = body.templates.find((t) => t.id === MEMORY_CONSOLIDATION_PIPELINE_ID);
      expect(template).toBeDefined();
      expect(template?.format).toBe('adr-101');
      expect(template?.installedBy).toEqual({ pack: 'builtin', version: '1' });
      expect(template?.spec?.nodes[0]).toMatchObject({ kind: 'agent', agent: 'assistant' });
    });

    it('POST /pipeline-templates/:tid/instantiate создаёт пайплайн проекта с копией спецификации', async () => {
      const { app, pipelines } = await createApp();
      const res = await app.request(
        `/api/v2/pipeline-templates/${MEMORY_CONSOLIDATION_PIPELINE_ID}/instantiate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'proj-1' }),
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { pipeline: PipelineView };
      expect(body.pipeline.scope).toBe('project');
      expect(body.pipeline.projectId).toBe('proj-1');
      expect(body.pipeline.draftVersion).toBe(1);
      expect(body.pipeline.publishedVersion).toBeUndefined();
      expect(body.pipeline.installedBy).toEqual({
        pack: 'builtin',
        version: '1',
        templateId: MEMORY_CONSOLIDATION_PIPELINE_ID,
      });
      // Копия спецификации: id сервера, проект и статус — черновика.
      expect(body.pipeline.draft.id).toBe(body.pipeline.id);
      expect(body.pipeline.draft.projectId).toBe('proj-1');
      expect(body.pipeline.draft.status).toBe('draft');
      expect(body.pipeline.draft.nodes[0]).toMatchObject({ kind: 'agent', agent: 'assistant' });
      expect(body.pipeline.draft.vars?.sessionId).toBe('trigger.payload.sessionId');

      // Инстансный шаблон не тронут — он остаётся шаблоном инстанса.
      const template = await pipelines.getPipeline(MEMORY_CONSOLIDATION_PIPELINE_ID);
      expect(template!.scope).toBe('instance');
    });
  });
});
