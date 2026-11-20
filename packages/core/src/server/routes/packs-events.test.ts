/**
 * Событие шины `packs.updated` на HTTP-путях реестра установок пакетов
 * (`createPacksRoutes`, ADR-086 §5).
 *
 * Баг: «пакет, поставленный/одобренный/снятый в другом клиенте, соседней
 * вкладке админки или установщиком по HTTP API, виден в разделе „Аддоны“ только
 * после перезагрузки страницы»: `components/settings/AddonsSettings.tsx` грузит
 * список один раз при монтировании и перечитывает его только после **своих**
 * действий (`loadPacks()` в обработчиках) — сервер о чужих мутациях молчал, а
 * снятый пакет продолжал висеть в списке.
 *
 * Контракт проверяется здесь целиком:
 * - `POST /` — `action: 'install'` в обеих ветках: пакет ставится сразу (201) и
 *   уходит «в карантин» (`status: 'pending_approval'`, 202) — во втором случае
 *   запись реестра **уже создана** и видна в списке, значит состав изменился;
 * - `POST /:name/approve` — `action: 'approve'`;
 * - `DELETE /:name` — `action: 'uninstall'`; идемпотентное снятие отсутствующего
 *   пакета (204, записи нет) молчит;
 * - **не** публикуется при ошибке: 400 (манифест/файлы), 403 (write-guard),
 *   404/409 (одобрять нечего/пакет не в карантине);
 * - payload — только `{action, packName?}`: **манифеста, карты файлов и сводки
 *   полномочий в событии нет**.
 *
 * Хук подменён тем же путём, что у точки сборки (`packsChangedPublisher` поверх
 * фейковой шины): тест про контракт фабрики, а не про EventBus (сам шов —
 * `src/events/packs-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@itphx/synth-shared';
import { createPacksRoutes } from './packs.js';
import { packsChangedPublisher } from '../../events/packs-events.js';
import { FilePackStore } from '../../storage/file-pack-store.js';
import { FilePipelineStore } from '../../storage/file-pipeline-store.js';
import { McpRegistryStore } from '../../storage/mcp-registry-store.js';
import { RouteRuleStore } from '../../storage/route-rule-store.js';
import { JsonStore } from '../../storage/json-store.js';
import { SkillService } from '../../engine/skills/service.js';
import { ContextConfig } from '../../engine/context/config.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `packsChangedPublisher(eventBus)`. */
function packsHook(published: PublishedEvent[]) {
  return packsChangedPublisher(makeBus(published));
}

const passAuth = async (_c: Context, next: Next) => { await next(); };
/** Scope-гейт service-key: в тесте не мешает (роль ADMIN не проверяем). */
const passScope = () => passAuth;
/** Мок auth: `requireAuth` — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: passAuth,
  };
}

/** Манифест без полномочий: ставится сразу, без карантина. */
const MANIFEST = {
  name: 'synth-media',
  version: '1.0.0',
  kind: 'pack',
  packType: 'automation',
  description: 'Медиа-пак: только скилл, секретное-описание',
  provides: {
    skills: [
      {
        name: 'media-draft',
        path: 'skills/media-draft',
        metadata: { synth: { tags: ['media'] } },
      },
    ],
    mcp: [],
    agents: [],
    pipelines: [],
  },
};

/** Манифест с пайплайном: установка требует одобрения (202, карантин). */
const MANIFEST_WITH_PIPELINE = {
  ...MANIFEST,
  provides: {
    ...MANIFEST.provides,
    pipelines: [{ id: 'publication', path: 'pipelines/publication.yaml' }],
  },
};

/** Файлы пакета (тело скилла — секретный-текст-скилла). */
const FILES: Record<string, string> = {
  'skills/media-draft/SKILL.md':
    '---\nname: media-draft\ndescription: Черновик медиа-поста\n---\n\nсекретный-текст-скилла\n',
  'pipelines/publication.yaml':
    'id: publication\nname: Публикация\nsteps:\n' +
    '  - id: draft\n    agent: publisher\n    waitsFor:\n' +
    '      source: synth-media\n      type: draft_approved\n',
};

describe('createPacksRoutes — событие packsupdated на write-путях', () => {
  let tmpDir: string;
  let published: PublishedEvent[];
  let deps: {
    packs: FilePackStore;
    pipelines: FilePipelineStore;
    skills: SkillService;
    mcpRegistry: McpRegistryStore;
    agents: JsonStore<AgentDefinition>;
    roleFiles: ContextConfig;
    routes: RouteRuleStore;
  };

  const makeApp = (opts: { writeGuard?: MiddlewareHandler; uninstallGuard?: MiddlewareHandler } = {}) => {
    const app = new Hono();
    app.route(
      '/api/v2/packs',
      createPacksRoutes(createMockAuth(), deps, {
        scopeGuard: passScope,
        onPacksChanged: packsHook(published),
        ...(opts.writeGuard ? { writeGuard: opts.writeGuard } : {}),
        ...(opts.uninstallGuard ? { uninstallGuard: opts.uninstallGuard } : {}),
      }),
    );
    return app;
  };

  const install = (app: Hono, manifest: unknown = MANIFEST, files: Record<string, string> = FILES) =>
    app.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest, files }),
    });

  beforeEach(async () => {
    published = [];
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-packs-events-'));
    deps = {
      packs: new FilePackStore({ dataDir: tmpDir }),
      pipelines: new FilePipelineStore({ dataDir: tmpDir }),
      skills: new SkillService({ dataDir: tmpDir }),
      mcpRegistry: new McpRegistryStore({ dataDir: tmpDir }),
      agents: new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' }),
      roleFiles: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
      routes: new RouteRuleStore({ dataDir: tmpDir }),
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST / (установка сразу) публикует { action: install, packName }', async () => {
    const app = makeApp();

    const res = await install(app);

    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'packs.updated', data: { action: 'install', packName: 'synth-media' } },
    ]);
    // Манифеста, карты файлов и полномочий в событии нет.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('секретный-текст-скилла');
    expect(serialized).not.toContain('секретное-описание');
    expect(serialized).not.toContain('media-draft');
  });

  it('POST / при requiresApproval (202, карантин) тоже публикует install: запись реестра создана', async () => {
    const app = makeApp();

    const res = await install(app, MANIFEST_WITH_PIPELINE);

    expect(res.status).toBe(202);
    // Запись `pending_approval` уже в реестре и видна в списке админки —
    // состав реестра изменился, значит событие нужно (иначе пакет появится в
    // списке только после перезагрузки страницы).
    expect(published).toEqual([
      { channel: 'instance', type: 'packs.updated', data: { action: 'install', packName: 'synth-media' } },
    ]);
  });

  it('POST /:name/approve публикует { action: approve }', async () => {
    const app = makeApp();
    expect((await install(app, MANIFEST_WITH_PIPELINE)).status).toBe(202);
    published.length = 0;

    const res = await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'packs.updated', data: { action: 'approve', packName: 'synth-media' } },
    ]);
  });

  it('DELETE /:name публикует { action: uninstall }', async () => {
    const app = makeApp();
    await install(app);
    published.length = 0;

    const res = await app.request('/api/v2/packs/synth-media', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([
      { channel: 'instance', type: 'packs.updated', data: { action: 'uninstall', packName: 'synth-media' } },
    ]);
  });

  it('идемпотентное снятие отсутствующего пакета (204) молчит — записи не было', async () => {
    const app = makeApp();

    const res = await app.request('/api/v2/packs/absent', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(published).toEqual([]);
  });

  it('ошибки молчат: 400 (манифест/файлы), 404 и 409 (одобрение), 403 (guard)', async () => {
    const app = makeApp();

    // 400 — невалидный манифест (не-семвер) и отсутствующий файл скилла.
    expect((await install(app, { ...MANIFEST, version: 'не-семвер' })).status).toBe(400);
    expect((await install(app, MANIFEST, {})).status).toBe(400);
    expect(published).toEqual([]);

    // 404 — одобрять нечего; 409 — пакет не в карантине.
    expect((await app.request('/api/v2/packs/absent/approve', { method: 'POST' })).status).toBe(404);
    expect((await install(app)).status).toBe(201);
    published.length = 0;
    expect((await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' })).status).toBe(409);
    expect(published).toEqual([]);

    // 403 — write-guard (managed: не ADMIN и без scope `automation:install`).
    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const guarded = makeApp({ writeGuard: deny, uninstallGuard: deny });
    expect((await install(guarded)).status).toBe(403);
    expect((await guarded.request('/api/v2/packs/synth-media', { method: 'DELETE' })).status).toBe(403);
    expect(published).toEqual([]);

    // Контроль: после ошибок исправная запись событие всё же публикует.
    expect((await install(app)).status).toBe(201);
    expect(published.map((e) => e.data.action)).toEqual(['install']);
  });

  it('каждая успешная мутация — ровно одно событие в инстансном канале', async () => {
    const app = makeApp();

    await install(app, MANIFEST_WITH_PIPELINE);
    await app.request('/api/v2/packs/synth-media/approve', { method: 'POST' });
    await app.request('/api/v2/packs/synth-media', { method: 'DELETE' });

    expect(published.map((e) => e.data.action)).toEqual(['install', 'approve', 'uninstall']);
    expect(published.every((e) => e.channel === 'instance')).toBe(true);
    expect(published.every((e) => e.type === 'packs.updated')).toBe(true);
  });
});
