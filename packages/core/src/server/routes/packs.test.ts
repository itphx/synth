import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacksRoutes } from './packs.js';
import { FilePackStore } from '../../storage/file-pack-store.js';
import { FilePipelineStore } from '../../storage/file-pipeline-store.js';
import { McpRegistryStore } from '../../storage/mcp-registry-store.js';
import { RouteRuleStore } from '../../storage/route-rule-store.js';
import { JsonStore } from '../../storage/json-store.js';
import { SkillService } from '../../engine/skills/service.js';
import { ContextConfig } from '../../engine/context/config.js';
import type { AgentDefinition } from '@itphx/synth-shared';

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  };
}

/** Манifest пакета: скилл + MCP + агент с ролью + пайплайн. */
const MANIFEST = {
  name: 'synth-media',
  version: '1.0.0',
  kind: 'pack',
  packType: 'automation',
  description: 'Медиа-пак: скилл, MCP, агент и пайплайн',
  provides: {
    skills: [
      {
        name: 'media-draft',
        path: 'skills/media-draft',
        metadata: { synth: { tags: ['media'] } },
      },
    ],
    mcp: [
      {
        name: 'media-gateway',
        transport: 'http',
        port: 8080,
        path: '/mcp',
        description: 'Шлюз медиа-надстройки',
      },
    ],
    agents: [
      {
        id: 'publisher',
        displayName: 'Публикатор',
        description: 'Готовит и публикует посты',
        agentMode: 'subagent',
        rolePrompt: { path: 'agents/publisher/role.md' },
      },
    ],
    pipelines: [{ id: 'publication', path: 'pipelines/publication.yaml' }],
  },
};

/** Файлы пакета, на которые ссылается манифест. */
const FILES: Record<string, string> = {
  'skills/media-draft/SKILL.md':
    '---\nname: media-draft\ndescription: Черновик медиа-поста\n---\n\nТело скилла\n',
  'skills/media-draft/reference.md': 'Справочный материал скилла\n',
  'agents/publisher/role.md': 'Ты — публикатор Synth.\n',
  'pipelines/publication.yaml':
    'id: publication\nname: Публикация\nsteps:\n' +
    '  - id: draft\n    agent: publisher\n    waitsFor:\n' +
    '      source: synth-media\n      type: draft_approved\n',
};

describe('Packs API Routes (ADR-086 §5) — установка пакета расширения', () => {
  let tmpDir: string;
  let packStore: FilePackStore;
  let pipelineStore: FilePipelineStore;
  let mcpRegistry: McpRegistryStore;
  let routeRules: RouteRuleStore;
  let agentStore: JsonStore<AgentDefinition>;
  let skillService: SkillService;
  let contextConfig: ContextConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-packs-test-'));
    packStore = new FilePackStore({ dataDir: tmpDir });
    pipelineStore = new FilePipelineStore({ dataDir: tmpDir });
    mcpRegistry = new McpRegistryStore({ dataDir: tmpDir });
    routeRules = new RouteRuleStore({ dataDir: tmpDir });
    agentStore = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
    skillService = new SkillService({ dataDir: tmpDir });
    contextConfig = new ContextConfig({ userDataDir: join(tmpDir, 'context') });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const app = new Hono();
    app.route(
      '/api/v2/packs',
      createPacksRoutes(createMockAuth(), {
        packs: packStore,
        pipelines: pipelineStore,
        skills: skillService,
        mcpRegistry,
        agents: agentStore,
        roleFiles: contextConfig,
        routes: routeRules,
      }),
    );
    return app;
  }

  function installBody(manifest: unknown = MANIFEST, files: Record<string, string> = FILES) {
    return { manifest, files };
  }

  it('пакет с пайплайном требует одобрения; после approve — артефакты на месте, статус active', async () => {
    const app = createTestApp();

    const res = await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody()),
    });

    // Пайплайн порождает правила маршрутизации → требуется подтверждение.
    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.installed).toBe(false);
    expect(body.requiresApproval).toBe(true);
    expect(body.name).toBe('synth-media');
    expect(body.version).toBe('1.0.0');

    // В реестре — запись `pending_approval`, фактически ничего не установлено.
    const record = await packStore.get('synth-media');
    expect(record?.status).toBe('pending_approval');
    expect(record?.requiresApproval).toBe(true);
    expect(await skillService.instanceExists('media-draft')).toBe(false);
    expect(await mcpRegistry.getByName('media-gateway')).toBeNull();
    expect(await agentStore.load('publisher')).toBeNull();
    expect(await pipelineStore.getDefinition('publication')).toBeNull();
    expect(await routeRules.list()).toHaveLength(0);

    // Одобрение (ADMIN) — фактическая установка.
    const approve = await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });
    expect(approve.status).toBe(200);
    const approved: any = await approve.json();
    expect(approved.installed).toBe(true);
    expect(approved.requiresApproval).toBe(false);

    const active = await packStore.get('synth-media');
    expect(active?.status).toBe('active');
    expect(active?.provides.skills).toEqual(['media-draft']);
    expect(active?.provides.mcp).toEqual(['media-gateway']);
    expect(active?.provides.agents).toEqual(['publisher']);
    expect(active?.provides.pipelines).toEqual(['publication']);

    // Скилл создан (+ supporting-файл), `metadata.synth.*` на месте.
    expect(await skillService.instanceExists('media-draft')).toBe(true);
    const skillMd = await readFile(join(tmpDir, 'skills', 'media-draft', 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('description: Черновик медиа-поста');
    expect(skillMd).toContain('media');
    expect(
      await readFile(join(tmpDir, 'skills', 'media-draft', 'reference.md'), 'utf-8'),
    ).toContain('Справочный материал');

    // Роль агента записана в `{dataDir}/context/roles/<ID_UPPER>.md`.
    const role = await readFile(join(tmpDir, 'context', 'roles', 'PUBLISHER.md'), 'utf-8');
    expect(role).toContain('Ты — публикатор Synth.');

    // Агент сохранён (без capability-грантов).
    const agent = await agentStore.load('publisher');
    expect(agent?.displayName).toBe('Публикатор');
    expect(agent?.contextFile).toBe('PUBLISHER.md');
    expect(agent?.capabilities).toEqual([]);

    // MCP-запись — instance + enabledByDefault (иначе не попадёт в дефолты сессий).
    const mcp = await mcpRegistry.getByName('media-gateway');
    expect(mcp?.origin).toBe('instance');
    expect(mcp?.enabledByDefault).toBe(true);
    expect(mcp?.config.url).toBe('http://127.0.0.1:8080/mcp');
    expect(await mcpRegistry.toDefaultServers()).toContain('media-gateway');

    // Определение пайплайна сохранено с провенансом установки.
    const definition = await pipelineStore.getDefinition('publication');
    expect(definition?.name).toBe('Публикация');
    expect(definition?.installedBy).toEqual({ pack: 'synth-media', version: '1.0.0' });

    // Правило маршрутизации создано с `pipeline` в цели.
    const rules = await routeRules.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.match).toEqual({ source: 'synth-media', type: 'draft_approved' });
    expect(rules[0]?.target).toEqual({
      mode: 'ephemeral',
      agentTemplate: 'publisher',
      pipeline: { id: 'publication', step: 'draft' },
    });
    expect(rules[0]?.enabled).toBe(true);
  });

  it('пакет без capability-грантов ставится сразу (active)', async () => {
    const app = createTestApp();
    const manifest = {
      ...MANIFEST,
      provides: {
        skills: MANIFEST.provides.skills,
        mcp: MANIFEST.provides.mcp,
        agents: MANIFEST.provides.agents,
        pipelines: [],
      },
    };

    const res = await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody(manifest)),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.installed).toBe(true);
    expect(body.requiresApproval).toBe(false);
    expect((await packStore.get('synth-media'))?.status).toBe('active');
    expect(await skillService.instanceExists('media-draft')).toBe(true);
    expect((await mcpRegistry.getByName('media-gateway'))?.origin).toBe('instance');
    expect((await agentStore.load('publisher'))?.id).toBe('publisher');
  });

  it('идемпотентность: повторная установка не плодит дубликаты', async () => {
    const app = createTestApp();

    await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody()),
    });
    await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });

    // Вторая установка того же пакета — обновление, а не дублирование.
    const res = await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody()),
    });
    expect(res.status).toBe(202);
    await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });

    expect(await packStore.list()).toHaveLength(1);
    expect((await packStore.list()).filter((p) => p.name === 'synth-media')).toHaveLength(1);
    // Правило маршрутизации — то же самое (id стабильный), не второе.
    const rules = await routeRules.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe('pack-synth-media-publication-draft');
    // Скилл и MCP — по одному.
    expect(await skillService.instanceExists('media-draft')).toBe(true);
    expect((await mcpRegistry.list()).filter((e) => e.name === 'media-gateway')).toHaveLength(1);
  });

  it('агент с capabilities → requiresApproval, фактически ничего не установлено', async () => {
    const app = createTestApp();
    const manifest = {
      ...MANIFEST,
      provides: {
        ...MANIFEST.provides,
        agents: [
          {
            ...MANIFEST.provides.agents[0],
            capabilities: ['file_write'],
          },
        ],
      },
    };

    const res = await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody(manifest)),
    });

    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.requiresApproval).toBe(true);
    expect(body.installed).toBe(false);
    expect((await packStore.get('synth-media'))?.status).toBe('pending_approval');
    expect(await skillService.instanceExists('media-draft')).toBe(false);
    expect(await agentStore.load('publisher')).toBeNull();
    expect(await mcpRegistry.getByName('media-gateway')).toBeNull();
  });

  it('невалидный манифест → 400 с перечнем проблем', async () => {
    const app = createTestApp();

    const res = await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody({ ...MANIFEST, version: 'не-семвер' })),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.problems)).toBe(true);
    expect(body.error.problems.length).toBeGreaterThan(0);
    // Запись в реестре не появилась.
    expect(await packStore.list()).toHaveLength(0);
  });

  it('манифест со ссылкой на отсутствующий файл → 400 с понятным сообщением', async () => {
    const app = createTestApp();
    const files = { ...FILES };
    delete files['agents/publisher/role.md'];

    const res = await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody(MANIFEST, files)),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(body.error.problems)).toContain('agents/publisher/role.md');
    expect(await packStore.list()).toHaveLength(0);
  });

  it('снятие установки удаляет артефакты и запись реестра', async () => {
    const app = createTestApp();
    await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody()),
    });
    await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });

    const res = await app.request('/api/v2/packs/synth-media', { method: 'DELETE' });
    expect(res.status).toBe(204);

    expect(await packStore.get('synth-media')).toBeNull();
    expect(await skillService.instanceExists('media-draft')).toBe(false);
    expect(await mcpRegistry.getByName('media-gateway')).toBeNull();
    expect(await agentStore.load('publisher')).toBeNull();
    expect(await pipelineStore.getDefinition('publication')).toBeNull();
    expect(await routeRules.list()).toHaveLength(0);
  });

  it('снятие отсутствующего пакета — идемпотентно (204, без ошибки)', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/packs/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('GET /packs и GET /packs/:name — реестр установок', async () => {
    const app = createTestApp();
    await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody()),
    });

    const list = await app.request('/api/v2/packs');
    expect(list.status).toBe(200);
    const listBody: any = await list.json();
    expect(listBody.packs).toHaveLength(1);
    expect(listBody.packs[0].name).toBe('synth-media');
    expect(listBody.packs[0].status).toBe('pending_approval');
    expect(listBody.packs[0].requiresApproval).toBe(true);

    const one = await app.request('/api/v2/packs/synth-media');
    expect(one.status).toBe(200);
    const oneBody: any = await one.json();
    expect(oneBody.version).toBe('1.0.0');
    expect(oneBody.provides.agents).toEqual(['publisher']);

    const missing = await app.request('/api/v2/packs/nope');
    expect(missing.status).toBe(404);
  });

  it('одобрение не-pending пакета → 409; неизвестного → 404', async () => {
    const app = createTestApp();
    const missing = await app.request('/api/v2/packs/nope/approve', { method: 'POST' });
    expect(missing.status).toBe(404);

    // Пакет без capability-грантов ставится сразу → active, одобрение не нужно.
    const manifest = {
      ...MANIFEST,
      provides: { ...MANIFEST.provides, pipelines: [] },
    };
    await app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(installBody(manifest)),
    });
    const conflict = await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });
    expect(conflict.status).toBe(409);
  });

  // ADR-106 Ф5: `pending_approval` по существу — пакет с контентом полномочий
  // (`provides.authority`) идёт на одобрение ADMIN, и в ответе/деталях видна
  // **сводка** ролей/действий/целей (а не только факт «есть capabilities»).
  describe('ADR-106 Ф5: одобрение по существу (контент полномочий)', () => {
    /** Манифест с контентом полномочий (роль, действие, вид цели, агент). */
    const AUTHORITY_MANIFEST = {
      name: 'clinic-pack',
      version: '0.1.0',
      kind: 'pack',
      packType: 'policies',
      description: 'Пакет с ролями',
      provides: {
        skills: [],
        mcp: [],
        agents: [],
        pipelines: [],
        authority: {
          actions: [
            { id: 'read', mutating: false, requires: [] },
            { id: 'sign', mutating: true, requires: [] },
          ],
          targets: [{ kind: 'record', resolver: 'record-resolver' }],
          roles: [
            {
              id: 'clinician',
              displayName: 'Врач',
              domain: 'clinic',
              grants: [
                { action: 'sign', targetPattern: 'record:*', effect: 'allow' },
                { action: 'read', targetPattern: 'record:*', effect: 'allow' },
              ],
            },
          ],
          agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['sign'] }],
        },
      },
    };

    it('пакет с ролями → pending_approval; в ответе — сводка ролей/действий/целей', async () => {
      const app = createTestApp();

      const res = await app.request('/api/v2/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(installBody(AUTHORITY_MANIFEST)),
      });

      // Контент полномочий → пакет ждёт одобрения ADMIN (даже без capabilities).
      expect(res.status).toBe(202);
      const body: any = await res.json();
      expect(body.installed).toBe(false);
      expect(body.requiresApproval).toBe(true);

      // Сводка — «что именно» приносит пакет.
      expect(body.authority.roles).toHaveLength(1);
      expect(body.authority.roles[0].id).toBe('clinician');
      expect(body.authority.roles[0].domain).toBe('clinic');
      expect(body.authority.roles[0].grants).toBe(2);
      expect(body.authority.roles[0].mutatingGrants).toBe(1);
      expect(body.authority.actions).toEqual([
        { id: 'read', mutating: false },
        { id: 'sign', mutating: true },
      ]);
      expect(body.authority.targets).toEqual([{ kind: 'record', resolver: 'record-resolver' }]);
      expect(body.authority.agents).toEqual([
        { id: 'doctor', roles: ['clinician'], ceiling: ['sign'] },
      ]);
      expect(body.authority.totals).toMatchObject({
        roles: 1,
        actions: 2,
        targets: 1,
        agents: 1,
        grants: 2,
        mutatingGrants: 1,
      });

      // В реестре — `pending_approval`, фактически ничего не установлено.
      const record = await packStore.get('clinic-pack');
      expect(record?.status).toBe('pending_approval');
      expect(record?.requiresApproval).toBe(true);

      // Сводка видна и в списке, и в деталях пакета.
      const list = await app.request('/api/v2/packs');
      const listBody: any = await list.json();
      expect(listBody.packs[0].authority.roles[0].id).toBe('clinician');

      const one = await app.request('/api/v2/packs/clinic-pack');
      const oneBody: any = await one.json();
      expect(oneBody.authority.totals.roles).toBe(1);
    });

    it('пакет без контента полномочий — прежнее поведение (сводки в ответе нет)', async () => {
      const app = createTestApp();
      const manifest = {
        ...MANIFEST,
        provides: { ...MANIFEST.provides, pipelines: [] },
      };

      const res = await app.request('/api/v2/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(installBody(manifest)),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.installed).toBe(true);
      expect(body.authority).toBeUndefined();
    });

    it('пустой контент полномочий (`roles: []`) — одобрение не требуется', async () => {
      const app = createTestApp();
      const manifest = {
        ...MANIFEST,
        provides: {
          ...MANIFEST.provides,
          pipelines: [],
          authority: { roles: [], actions: [], targets: [], agents: [] },
        },
      };

      const res = await app.request('/api/v2/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(installBody(manifest)),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.authority).toBeUndefined();
    });
  });
});
