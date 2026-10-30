import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventBindingSchema } from '@itphx/synth-shared';
import { createStandaloneApp } from '../app.js';
import {
  createPublicOpenApiApp,
  getPublicOpenApiDocument,
  publicErrorSchema,
} from './public-openapi.js';

/** Базовый URL-путь, под которым отдаётся документ и живут операции. */
const API_BASE = '/api/v2';

/**
 * Ожидаемая публичная поверхность (интеграционное ядро, ADR-052 этап III, часть 1):
 * path → HTTP-методы. 29 операций: events 13, sessions 8, schedules 6, llm 1, system 1.
 */
const EXPECTED_PATHS: Record<string, string[]> = {
  // events
  '/events': ['post'],
  '/events/journal': ['get'],
  '/events/bindings': ['get', 'post'],
  '/events/bindings/{id}': ['delete'],
  '/events/bindings/{id}/keys': ['get', 'post'],
  '/events/bindings/{id}/keys/{keyId}': ['patch', 'delete'],
  '/events/bindings/{id}/keys/{keyId}/revoke': ['post'],
  '/events/routes': ['get', 'post'],
  '/events/routes/{id}': ['delete'],
  // sessions
  '/sessions': ['get', 'post'],
  '/sessions/{id}': ['get', 'patch', 'delete'],
  '/sessions/{id}/prompt': ['post'],
  '/sessions/{id}/messages': ['get'],
  '/sessions/{id}/status': ['get'],
  // schedules
  '/schedules': ['get', 'post'],
  '/schedules/{id}': ['put', 'delete'],
  '/schedules/{id}/run': ['post'],
  '/schedules/{id}/jobs': ['get'],
  // llm
  '/llm/chat/completions': ['post'],
  // system (ADR-118 §8)
  '/meta': ['get'],
};

/** Публичные операции, доступные **без** аутентификации (ADR-118 §8). */
const PUBLIC_OPERATIONS = new Set(['GET /meta']);

/** Именованные модели, которые обязаны попасть в `components.schemas`. */
const EXPECTED_SCHEMAS = [
  'publicErrorSchema',
  'SynthEvent',
  'EventBinding',
  'EventBindingInput',
  'EventBindingApiKey',
  'EventBindingApiKeyCreate',
  'EventBindingApiKeyUpdate',
  'EventBindingApiKeyCreated',
  'EventIngest',
  'EventRouteRule',
  'EventRouteRuleUpsert',
  'RouteDecision',
  'EventIngestResponse',
  'EventJournalEntry',
  'Session',
  'SessionCreate',
  'SessionPatch',
  'SessionMessage',
  'SessionMessagesResponse',
  'SessionStatusResponse',
  'SessionPrompt',
  'SessionPromptAccepted',
  'InstanceMeta',
  'Schedule',
  'ScheduleInput',
  'ScheduleJob',
  'ChatCompletionsRequest',
  'ChatCompletionsResponse',
];

/** Все HTTP-методы для каждого path (сортированные) — для сверки. */
function methodsOf(doc: ReturnType<typeof getPublicOpenApiDocument>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    out[path] = Object.keys(item as Record<string, unknown>).sort();
  }
  return out;
}

describe('public OpenAPI (ADR-052, этап III)', () => {
  let dataDir: string | undefined;
  let cleanup: (() => void) | undefined;

  afterEach(async () => {
    cleanup?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    cleanup = undefined;
  });

  it('getPublicOpenApiDocument() возвращает OpenAPI 3.1 с полным интеграционным ядром', () => {
    const doc = getPublicOpenApiDocument();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Synth Public API');
    expect(doc.info.version).toBeTruthy();
    expect(doc.servers).toEqual([{ url: API_BASE }]);

    // tags + top-level security (bearer service-key).
    expect((doc.tags ?? []).map((t) => t.name).sort()).toEqual([
      'events',
      'llm',
      'schedules',
      'sessions',
      'system',
    ]);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer' },
    });

    // Каждый ожидаемый path присутствует с полным набором методов.
    const methods = methodsOf(doc);
    for (const [path, expected] of Object.entries(EXPECTED_PATHS)) {
      expect(methods[path], `path ${path}`).toEqual([...expected].sort());
    }

    // Всего 29 операций в интеграционном ядре.
    const operationCount = Object.values(methods).reduce((n, ms) => n + ms.length, 0);
    expect(operationCount).toBe(29);

    // Именованные модели присутствуют (не только inline).
    const schemas = doc.components?.schemas ?? {};
    for (const name of EXPECTED_SCHEMAS) {
      expect(Object.keys(schemas), `schema ${name}`).toContain(name);
    }
  });

  it('каждая операция несёт summary, tags и security (bearer, кроме публичного /meta)', () => {
    const doc = getPublicOpenApiDocument();
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
        const key = `${method.toUpperCase()} ${path}`;
        expect(op.summary, key).toBeTruthy();
        expect(op.tags, key).toBeTruthy();
        // ADR-118 §8: `GET /meta` — без аутентификации (`security: []`).
        expect(op.security, key).toEqual(
          PUBLIC_OPERATIONS.has(key) ? [] : [{ bearerAuth: [] }],
        );
      }
    }
  });

  it('publicErrorSchema описывает { error: { code, message } } и включён в ответы операций', () => {
    const doc = getPublicOpenApiDocument();

    expect(publicErrorSchema.parse({ error: { code: 'C', message: 'M' } })).toEqual({
      error: { code: 'C', message: 'M' },
    });
    expect(publicErrorSchema.safeParse({ error: { code: 'C' } }).success).toBe(false);
    expect(publicErrorSchema.safeParse({ code: 'C', message: 'M' }).success).toBe(false);

    // POST /events несёт полный набор ошибочных ответов (400/401/403/404/409/429/500/503).
    const postEvents = doc.paths?.['/events']?.post as Record<string, unknown> | undefined;
    const responses = postEvents?.responses as Record<string, unknown>;
    for (const code of ['400', '401', '403', '404', '409', '429', '500', '503']) {
      expect(responses, `response ${code}`).toHaveProperty(code);
    }
  });

  it('POST /sessions/{id}/prompt — только 202 {messageId, mode, position}, без SSE (ADR-118 §3)', async () => {
    const doc = getPublicOpenApiDocument();
    const post = doc.paths?.['/sessions/{id}/prompt']?.post as Record<string, unknown> | undefined;
    const responses = post?.responses as Record<string, Record<string, unknown>>;

    expect(responses, 'ответ 202').toHaveProperty('202');
    expect(responses, 'ответ 200 (SSE) удалён').not.toHaveProperty('200');
    expect(JSON.stringify(responses)).not.toContain('text/event-stream');

    // Тело 202 — именованная модель с тремя полями.
    const schema = (responses['202']?.content as Record<string, { schema?: unknown }>)[
      'application/json'
    ]?.schema;
    expect(schema).toEqual({ $ref: '#/components/schemas/SessionPromptAccepted' });
    const model = (doc.components?.schemas ?? {})['SessionPromptAccepted'] as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(model.properties ?? {}).sort()).toEqual(['messageId', 'mode', 'position']);
    expect([...(model.required ?? [])].sort()).toEqual(['messageId', 'mode', 'position']);

    // Заглушка отвечает новым контрактом.
    const app = createPublicOpenApiApp();
    const res = await app.request('/sessions/ses_1/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['messageId', 'mode', 'position']);
    expect(typeof body.messageId).toBe('string');
    expect(['queue', 'steer', 'interrupt']).toContain(body.mode as string);
    expect(body.position === null || typeof body.position === 'number').toBe(true);
  });

  it('GET /meta описан публично (security: []) и отдаёт возможности инстанса (ADR-118 §8)', async () => {
    const doc = getPublicOpenApiDocument();
    const meta = doc.paths?.['/meta']?.get as Record<string, unknown> | undefined;
    expect(meta, 'операция /meta').toBeTruthy();
    expect(meta?.security).toEqual([]);
    expect(meta?.tags).toEqual(['system']);

    const model = (doc.components?.schemas ?? {})['InstanceMeta'] as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(model.properties ?? {}).sort()).toEqual([
      'eventSeq',
      'messageModel',
      'replay',
      'version',
    ]);
    expect([...(model.required ?? [])].sort()).toEqual([
      'eventSeq',
      'messageModel',
      'replay',
      'version',
    ]);

    const app = createPublicOpenApiApp();
    const res = await app.request('/meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messageModel: 2,
      eventSeq: true,
      replay: true,
      version: expect.any(String),
    });
  });

  it('DTO сообщения несёт ord/turn_id/step_index/status (ADR-118 §1/§2/§5)', () => {
    const doc = getPublicOpenApiDocument();
    const messages = doc.components?.schemas?.SessionMessagesResponse as {
      properties?: { messages?: { items?: unknown } };
    };
    expect(messages.properties?.messages?.items).toEqual({
      $ref: '#/components/schemas/SessionMessage',
    });

    const message = (doc.components?.schemas ?? {})['SessionMessage'] as {
      properties?: Record<string, { type?: unknown }>;
      required?: string[];
    };
    const props = message.properties ?? {};
    for (const field of ['ord', 'turn_id', 'step_index', 'status']) {
      expect(props, `поле ${field}`).toHaveProperty(field);
    }
    // Все четыре — nullable.
    for (const field of ['ord', 'turn_id', 'step_index', 'status']) {
      expect(JSON.stringify(props[field]), `${field} nullable`).toMatch(/"null"/);
    }
  });

  it('аннотирование схем не мутирует shared-схемы (безопасное именование)', () => {
    // `eventBindingSchema` импортируется из shared: аннотация в `.openapi('EventBinding')`
    // должна создавать новую инстанцию, не проставляя refId на исходном объекте.
    const before = (eventBindingSchema as { _def?: { openapi?: unknown } })._def?.openapi;
    getPublicOpenApiDocument();
    const after = (eventBindingSchema as { _def?: { openapi?: unknown } })._def?.openapi;
    expect(after).toBe(before);
  });

  it('документ сериализуется в JSON без ошибок (совместим с отдачей из HTTP)', () => {
    const doc = getPublicOpenApiDocument();
    const json = JSON.stringify(doc);
    expect(json.length).toBeGreaterThan(0);
    const parsed = JSON.parse(json) as typeof doc;
    expect(parsed.openapi).toBe('3.1.0');
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
    expect(created.status).toBe(201);

    const ingested = await app.request('/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'spike', type: 'message' }),
    });
    expect(ingested.status).toBe(201);

    const status = await app.request('/sessions/ses_1/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      blocked: false,
      pending_count: 0,
      processor_running: false,
    });

    const completions = await app.request('/llm/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'spike', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(completions.status).toBe(200);
  });

  it('GET /api/v2/openapi.json core-роута отвечает 200 валидным JSON (за requireAuth)', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-openapi-'));
    const handle = await createStandaloneApp({ port: 0, dataDir, apiKey: 'test-key' });
    cleanup = () => {
      handle.stopScheduler();
      handle.stopEphemeralSweeper();
      handle.stopEventJournalPruner();
    };

    // Без кред — 401 (документ за auth).
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
    expect(json.paths).toHaveProperty('/sessions/{id}');
    expect(json.paths).toHaveProperty('/schedules/{id}/run');
    expect(json.paths).toHaveProperty('/llm/chat/completions');
  });
});
