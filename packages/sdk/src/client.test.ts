import { describe, expect, it } from 'vitest';
import { createSynthClient, SynthClient } from './client.js';
import { SynthApiError } from './errors.js';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status: number, contentType: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

function mockFetch(response: Response | (() => Response), calls?: Call[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url: string }).url);
    calls?.push({ url, init: init ?? {} });
    const res = typeof response === 'function' ? response() : response;
    return res.clone();
  }) as typeof fetch;
}

function first(calls: Call[]): Call {
  const call = calls[0];
  if (!call) throw new Error('нет перехваченных вызовов fetch');
  return call;
}

function headers(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe('SynthClient — auth и базовый путь', () => {
  it('POST /events: путь, метод, заголовки и JSON-тело', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      serviceKey: 'synth_svc_abc',
      fetch: mockFetch(
        jsonResponse(
          { event: { id: 'evt_1' }, decision: { kind: 'drop' }, sessionId: 'ses_1' },
          201,
        ),
        calls,
      ),
    });

    const res = await client.events.ingest({ source: 'tg', type: 'message' });

    const call = first(calls);
    expect(call.url).toBe('http://localhost:5000/api/v2/events');
    expect(call.init.method).toBe('POST');
    expect(headers(call).Authorization).toBe('Bearer synth_svc_abc');
    expect(headers(call)['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({ source: 'tg', type: 'message' });
    expect(res.sessionId).toBe('ses_1');
  });

  it('приоритет кред: serviceKey → apiKey → token', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      token: 'tok',
      apiKey: 'api',
      serviceKey: 'svc',
      fetch: mockFetch(jsonResponse({}), calls),
    });
    await client.sessions.list();
    expect(headers(first(calls)).Authorization).toBe('Bearer svc');

    const calls2: Call[] = [];
    const client2 = createSynthClient({
      baseUrl: 'http://localhost:5000',
      token: 'tok',
      apiKey: 'api',
      fetch: mockFetch(jsonResponse({}), calls2),
    });
    await client2.sessions.list();
    expect(headers(first(calls2)).Authorization).toBe('Bearer api');
  });

  it('без кред Authorization не отправляется', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(jsonResponse({}), calls),
    });
    await client.sessions.list();
    expect(headers(first(calls)).Authorization).toBeUndefined();
  });

  it('базовый путь по умолчанию — /api/v2; завершающий слэш baseUrl нормализуется', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000/',
      fetch: mockFetch(jsonResponse({}), calls),
    });
    expect(client.apiPath).toBe('/api/v2');
    await client.sessions.list();
    expect(first(calls).url).toBe('http://localhost:5000/api/v2/sessions');
  });

  it('кастомный apiPath сохраняется, ведущий слэш добавляется', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      apiPath: 'public/v2',
      fetch: mockFetch(jsonResponse({}), calls),
    });
    expect(client.apiPath).toBe('/public/v2');
    await client.sessions.list();
    expect(first(calls).url).toBe('http://localhost:5000/public/v2/sessions');
  });

  it('конструктор бросает без baseUrl', () => {
    expect(() => new SynthClient({ baseUrl: '' })).toThrow(/baseUrl/);
  });
});

describe('SynthClient — namespaces', () => {
  it('sessions: get/patch/messages/status — пути и методы', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(() => jsonResponse({}), calls),
    });
    await client.sessions.get('ses 1');
    await client.sessions.patch('ses_1', { mode: 'plan' });
    await client.sessions.messages('ses_1');
    await client.sessions.status('ses_1');

    expect(calls[0]?.url).toBe('http://localhost:5000/api/v2/sessions/ses%201');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[1]?.url).toBe('http://localhost:5000/api/v2/sessions/ses_1');
    expect(calls[1]?.init.method).toBe('PATCH');
    expect(calls[2]?.url).toBe('http://localhost:5000/api/v2/sessions/ses_1/messages');
    expect(calls[3]?.url).toBe('http://localhost:5000/api/v2/sessions/ses_1/status');
  });

  it('sessions: prompt возвращает сырой Response (SSE)', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(textResponse('data: {}\n\n', 200, 'text/event-stream'), calls),
    });
    const res = await client.sessions.prompt('ses_1', { content: 'hi' });
    expect(res).toBeInstanceOf(Response);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('events: journal/bindings/routes — query и разворачивание оболочек', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        () =>
          jsonResponse({
            entries: [{ ts: 't', event: {} }],
            bindings: [{ id: 'evt_bnd_1' }],
            rules: [{ id: 'rule_1' }],
            keys: [{ id: 'eak_1' }],
          }),
        calls,
      ),
    });

    const entries = await client.events.journal({ limit: 10 });
    const bindings = await client.events.bindings.list();
    const rules = await client.events.routes.list();
    const keys = await client.events.bindings.keys.list('evt_bnd_1');

    expect(first(calls).url).toBe('http://localhost:5000/api/v2/events/journal?limit=10');
    expect(entries).toHaveLength(1);
    expect(bindings[0]?.id).toBe('evt_bnd_1');
    expect(rules[0]?.id).toBe('rule_1');
    expect(keys[0]?.id).toBe('eak_1');
  });

  it('events: bindings.keys.update — PATCH по составному пути', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(() => jsonResponse({ id: 'eak_1' }), calls),
    });
    await client.events.bindings.keys.update('evt_bnd_1', 'eak_1', { label: 'new' });
    expect(first(calls).url).toBe(
      'http://localhost:5000/api/v2/events/bindings/evt_bnd_1/keys/eak_1',
    );
    expect(first(calls).init.method).toBe('PATCH');
  });

  it('schedules: list обёртка разворачивается; jobs — query', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(() => jsonResponse({ schedules: [{ id: 'sch_1' }], jobs: [{ id: 'job_1' }] }), calls),
    });
    const schedules = await client.schedules.list();
    const jobs = await client.schedules.jobs('sch_1', { limit: 5 });
    expect(schedules[0]?.id).toBe('sch_1');
    expect(jobs[0]?.id).toBe('job_1');
    expect(calls[1]?.url).toBe('http://localhost:5000/api/v2/schedules/sch_1/jobs?limit=5');
  });

  it('llm: chatCompletions — POST /llm/chat/completions', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      serviceKey: 'svc',
      fetch: mockFetch(
        jsonResponse({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        calls,
      ),
    });
    const res = await client.llm.chatCompletions({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(first(calls).url).toBe('http://localhost:5000/api/v2/llm/chat/completions');
    expect(first(calls).init.method).toBe('POST');
    expect(res.object).toBe('chat.completion');
  });

  it('204 No Content → undefined', async () => {
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(new Response(null, { status: 204 })),
    });
    await expect(client.sessions.remove('ses_1')).resolves.toBeUndefined();
  });
});

describe('SynthClient — ошибки', () => {
  it('маппинг 401/403/409 в SynthApiError с кодом и статусом', async () => {
    const cases: Array<[number, string]> = [
      [401, 'UNAUTHORIZED'],
      [403, 'SCOPE_REQUIRED'],
      [409, 'CONFLICT'],
    ];
    for (const [status, code] of cases) {
      const client = createSynthClient({
        baseUrl: 'http://localhost:5000',
        fetch: mockFetch(jsonResponse({ error: { code, message: 'err' } }, status)),
      });
      const err = await client.sessions.get('ses_1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SynthApiError);
      const apiErr = err as SynthApiError;
      expect(apiErr.status).toBe(status);
      expect(apiErr.code).toBe(code);
      expect(apiErr.message).toBe('err');
      expect(apiErr.body).toEqual({ error: { code, message: 'err' } });
    }
  });

  it('ошибка без разбираемого тела → HTTP_ERROR и fallback-сообщение', async () => {
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(textResponse('boom', 500, 'text/plain')),
    });
    const err = (await client.sessions.list().catch((e: unknown) => e)) as SynthApiError;
    expect(err.code).toBe('HTTP_ERROR');
    expect(err.status).toBe(500);
    expect(err.message).toBe('HTTP 500');
    expect(err.body).toBe('boom');
  });

  it('сетевой сбой оборачивается в SynthApiError (NETWORK_ERROR, status 0)', async () => {
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const err = (await client.sessions.list().catch((e: unknown) => e)) as SynthApiError;
    expect(err).toBeInstanceOf(SynthApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toBe('fetch failed');
  });

  it('raw-режим (prompt) тоже бросает SynthApiError при ошибке', async () => {
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(jsonResponse({ error: { code: 'NOT_FOUND', message: 'нет' } }, 404)),
    });
    const err = (await client.sessions
      .prompt('ses_1', { content: 'x' })
      .catch((e: unknown) => e)) as SynthApiError;
    expect(err).toBeInstanceOf(SynthApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});
