import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneApp } from '../app.js';
import {
  createPublicOpenApiApp,
  getPublicOpenApiDocument,
  publicErrorSchema,
} from './public-openapi.js';

/** Базовый URL-путь, под которым отдаётся документ и живут операции. */
const API_BASE = '/api/v2';

describe('public OpenAPI (AD-052, spike)', () => {
  let dataDir: string | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    cleanup?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    cleanup = undefined;
  });

  it('getPublicOpenApiDocument() возвращает OpenAPI 3.1 с 3 операциями и publicErrorSchema', () => {
    const doc = getPublicOpenApiDocument();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();
    expect(doc.servers).toEqual([{ url: API_BASE }]);

    // paths: POST /events, GET /events/bindings, POST /events/bindings — 3 операции.
    const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.keys(item as Record<string, unknown>),
    );
    expect(operations.sort()).toEqual(['get', 'post', 'post']);
    expect(doc.paths).toHaveProperty('/events');
    expect(doc.paths).toHaveProperty('/events/bindings');
    expect(doc.paths?.['/events']).toHaveProperty('post');
    expect(doc.paths?.['/events/bindings']).toHaveProperty('get');
    expect(doc.paths?.['/events/bindings']).toHaveProperty('post');

    // Единый формат ошибок зарегистрирован в components.schemas.
    const schemas = doc.components?.schemas ?? {};
    expect(Object.keys(schemas)).toContain('publicErrorSchema');

    // Единый формат: { error: { code, message } }.
    expect(publicErrorSchema.parse({ error: { code: 'C', message: 'M' } })).toEqual({
      error: { code: 'C', message: 'M' },
    });
    expect(publicErrorSchema.safeParse({ error: { code: 'C' } }).success).toBe(false);
    expect(publicErrorSchema.safeParse({ code: 'C', message: 'M' }).success).toBe(false);
  });

  it('createPublicOpenApiApp() типизированно отдаёт описанные операции (createRoute + shared Zod)', async () => {
    const app = createPublicOpenApiApp();

    const list = await app.request('/events/bindings');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ bindings: [] });

    const created = await app.request('/events/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'spike', mode: 'ephemeral' }),
    });
    expect(created.status).toBe(200);

    const ingested = await app.request('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'spike', type: 'message' }),
    });
    expect(ingested.status).toBe(201);
  });

  it('GET /api/v2/openapi.json core-роута отвечает 200 валидным JSON (за requireAuth)', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-openapi-'));
    const handle = await createStandaloneApp({ port: 0, dataDir, apiKey: 'test-key' });
    cleanup = () => {
      handle.stopScheduler();
      handle.stopEphemeralSweeper();
      handle.stopEventJournalPruner();
    };

    // Без кред — 401 (spike: документ пока за auth).
    const unauthenticated = await handle.app.request(`${API_BASE}/openapi.json`);
    expect(unauthenticated.status).toBe(401);

    const res = await handle.app.request(`${API_BASE}/openapi.json`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const json = (await res.json()) as ReturnType<typeof getPublicOpenApiDocument>;
    expect(json.openapi).toBe('3.1.0');
    expect(Object.keys(json.components?.schemas ?? {})).toContain('publicErrorSchema');
    expect(json.paths).toHaveProperty('/events');
  });
});
