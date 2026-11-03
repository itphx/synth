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

  it('sessions: prompt возвращает 202-контракт {messageId, mode, position}', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      apiKey: 'api',
      fetch: mockFetch(
        jsonResponse({ messageId: 'msg_1', mode: 'queue', position: 1 }, 202),
        calls,
      ),
    });
    const accepted = await client.sessions.prompt('ses_1', { content: 'hi' });

    expect(accepted).toEqual({ messageId: 'msg_1', mode: 'queue', position: 1 });
    expect(calls[0]?.url).toBe('http://localhost:5000/api/v2/sessions/ses_1/prompt');
    expect(calls[0]?.init.method).toBe('POST');
    expect(headers(calls[0] as Call)).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer api',
    });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ content: 'hi' });
  });

  it('meta: GET /meta без аутентификации', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      serviceKey: 'synth_svc_abc',
      fetch: mockFetch(
        jsonResponse({ messageModel: 2, eventSeq: true, replay: true, version: '0.12.5' }),
        calls,
      ),
    });

    const capabilities = await client.meta();

    expect(capabilities).toEqual({
      messageModel: 2,
      eventSeq: true,
      replay: true,
      version: '0.12.5',
    });
    expect(first(calls).url).toBe('http://localhost:5000/api/v2/meta');
    expect(first(calls).init.method).toBe('GET');
    // Публичный роут: креды не отправляются, даже если они заданы.
    expect(headers(first(calls)).Authorization).toBeUndefined();
  });

  it('sessions: messages — DTO сообщения содержит ord/turn_id/step_index/status', async () => {    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          session_id: 'ses_1',
          messages: [
            {
              index: 0,
              id: 'msg_1',
              seq: 1,
              ord: 1,
              turn_id: 'trn_1',
              step_index: null,
              status: 'completed',
              role: 'user',
              content: 'hi',
              timestamp: '2026-10-30T00:00:00.000Z',
            },
            {
              index: 1,
              id: 'msg_2',
              seq: 2,
              ord: null,
              turn_id: 'trn_1',
              step_index: 0,
              status: 'streaming',
              role: 'assistant',
              content: 'hello',
              usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
            },
          ],
        }),
        calls,
      ),
    });

    const res = await client.sessions.messages('ses_1');

    expect(first(calls).url).toBe('http://localhost:5000/api/v2/sessions/ses_1/messages');
    expect(res.session_id).toBe('ses_1');
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({
      ord: 1,
      turn_id: 'trn_1',
      step_index: null,
      status: 'completed',
    });
    expect(res.messages[1]).toMatchObject({
      ord: null,
      turn_id: 'trn_1',
      step_index: 0,
      status: 'streaming',
    });
    // Неизвестные/новые поля сервера не теряются и не ломают типизацию.
    expect(res.messages[1]?.usage).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });
  });

  it('sessions: list — страница сессий с пагинацией (limit/offset/project_id)', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          sessions: [{ id: 'ses_1', name: 'Первая' }],
          total: 42,
          offset: 10,
          limit: 25,
          next_offset: 35,
        }),
        calls,
      ),
    });

    const res = await client.sessions.list({ limit: 25, offset: 10, project_id: 'prj_1' });

    expect(first(calls).url).toBe(
      'http://localhost:5000/api/v2/sessions?limit=25&offset=10&project_id=prj_1',
    );
    expect(res.total).toBe(42);
    expect(res.offset).toBe(10);
    expect(res.limit).toBe(25);
    expect(res.next_offset).toBe(35);
    expect(res.sessions).toHaveLength(1);
  });

  it('sessions: list — последняя страница: next_offset=null', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({ sessions: [], total: 3, offset: 3, limit: 100, next_offset: null }),
        calls,
      ),
    });

    const res = await client.sessions.list({ offset: 3 });

    expect(first(calls).url).toBe('http://localhost:5000/api/v2/sessions?offset=3');
    expect(res.next_offset).toBeNull();
  });

  it('sessions: messages — пагинация (limit/before) и курсоры страницы', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          session_id: 'ses_1',
          messages: [{ index: 3, id: 'msg_4', content: 'старое' }],
          has_more: true,
          next_before: 4,
        }),
        calls,
      ),
    });

    const res = await client.sessions.messages('ses_1', { limit: 50, before: 12 });

    expect(first(calls).url).toBe(
      'http://localhost:5000/api/v2/sessions/ses_1/messages?limit=50&before=12',
    );
    expect(res.has_more).toBe(true);
    expect(res.next_before).toBe(4);
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

  it('projects: list — страница проектов с пагинацией (limit/offset)', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          projects: [{ id: 'prj_1', name: 'Первый', owner_id: 'u1' }],
          total: 12,
          offset: 10,
          limit: 25,
          next_offset: null,
        }),
        calls,
      ),
    });

    const res = await client.projects.list({ limit: 25, offset: 10 });

    expect(first(calls).url).toBe('http://localhost:5000/api/v2/projects?limit=25&offset=10');
    expect(res.total).toBe(12);
    expect(res.offset).toBe(10);
    expect(res.limit).toBe(25);
    expect(res.next_offset).toBeNull();
    expect(res.projects[0]?.id).toBe('prj_1');
  });

  it('projects: get — деталь по id', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(jsonResponse({ id: 'prj_1', name: 'Деталь', log: [], plan: null }), calls),
    });

    const res = await client.projects.get('prj 1');

    expect(first(calls).url).toBe('http://localhost:5000/api/v2/projects/prj%201');
    expect(res.id).toBe('prj_1');
  });

  it('pipelines: projectPipelines — страница пайплайнов проекта', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          pipelines: [{ id: 'pl_1', name: 'Релизы', hasDraft: true, draftVersion: 1 }],
          total: 1,
          offset: 0,
          limit: 100,
          next_offset: null,
        }),
        calls,
      ),
    });

    const res = await client.pipelines.projectPipelines('prj_1', { limit: 100, offset: 0 });

    expect(first(calls).url).toBe(
      'http://localhost:5000/api/v2/projects/prj_1/pipelines?limit=100&offset=0',
    );
    expect(res.pipelines[0]?.id).toBe('pl_1');
    expect(res.total).toBe(1);
    expect(res.next_offset).toBeNull();
  });

  it('pipelines: run — прогон и постраничный журнал (events_limit/events_before)', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          run: { id: 'prun_1', status: 'awaiting_human' },
          events: [{ runId: 'prun_1', ts: '2026-01-01T00:00:00.000Z', type: 'run.started' }],
          events_has_more: true,
          events_next_before: 7,
        }),
        calls,
      ),
    });

    const res = await client.pipelines.run('prun_1', {
      events_limit: 200,
      events_before: 12,
    });

    expect(first(calls).url).toBe(
      'http://localhost:5000/api/v2/pipeline-runs/prun_1?events_limit=200&events_before=12',
    );
    expect(res.run.id).toBe('prun_1');
    expect(res.events).toHaveLength(1);
    expect(res.events_has_more).toBe(true);
    expect(res.events_next_before).toBe(7);
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

  it('prompt бросает SynthApiError при ошибке приёма', async () => {
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

describe('SynthClient — models/fs/git', () => {
  it('models.list: GET /models с параметрами страницы и поиска', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          models: [{ id: 'openai/m1', name: 'm1', provider: 'openai', enabled: true, isDefault: false }],
          total: 1,
          offset: 10,
          limit: 50,
          next_offset: null,
        }),
        calls,
      ),
    });

    const page = await client.models.list({ search: 'm1', limit: 50, offset: 10, provider: 'openai' });

    const call = first(calls);
    expect(call.url).toContain('/api/v2/models?');
    expect(call.url).toContain('search=m1');
    expect(call.url).toContain('limit=50');
    expect(call.url).toContain('offset=10');
    expect(call.url).toContain('provider=openai');
    expect(call.init.method).toBe('GET');
    expect(page.total).toBe(1);
    expect(page.offset).toBe(10);
    expect(page.limit).toBe(50);
    expect(page.next_offset).toBeNull();
    expect(page.models[0]!.id).toBe('openai/m1');
  });

  it('models.list: 400 отдаёт код ошибки синхронно', async () => {
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'limit' } }, 400)),
    });
    const err = (await client.models.list({ limit: 1 }).catch((e: unknown) => e)) as SynthApiError;
    expect(err).toBeInstanceOf(SynthApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('fs.read: GET /fs/read с project_id и path', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({ path: 'a.txt', content: 'hello', size: 5, encoding: 'utf-8' }),
        calls,
      ),
    });

    const res = await client.fs.read({ project_id: 'p1', path: 'a.txt' });

    const call = first(calls);
    expect(call.url).toContain('/api/v2/fs/read?');
    expect(call.url).toContain('project_id=p1');
    expect(call.url).toContain('path=a.txt');
    expect(res.content).toBe('hello');
    expect(res.encoding).toBe('utf-8');
  });

  it('fs.read: 413 FILE_TOO_LARGE пробрасывается с details', async () => {
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(jsonResponse({
        error: { code: 'FILE_TOO_LARGE', message: 'large', details: { maxReadBytes: 1024 } },
      }, 413)),
    });
    const err = (await client.fs
      .read({ path: 'big.bin' })
      .catch((e: unknown) => e)) as SynthApiError;
    expect(err).toBeInstanceOf(SynthApiError);
    expect(err.status).toBe(413);
    expect(err.code).toBe('FILE_TOO_LARGE');
  });

  it('fs.list: GET /fs с maxDepth/includeHidden, truncated в ответе', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({ path: '/', entries: [{ name: 'a', path: 'a', isDirectory: false, size: 1, modifiedAt: 0 }], truncated: true }),
        calls,
      ),
    });

    const res = await client.fs.list({ path: '', maxDepth: 2, includeHidden: true });

    const call = first(calls);
    expect(call.url).toContain('/api/v2/fs?');
    expect(call.url).toContain('maxDepth=2');
    expect(call.url).toContain('includeHidden=true');
    expect(res.entries[0]!.name).toBe('a');
    expect(res.truncated).toBe(true);
  });

  it('git.commit: GET /git/commit с project_id/repo_path/hash', async () => {
    const calls: Call[] = [];
    const client = createSynthClient({
      baseUrl: 'http://localhost:5000',
      fetch: mockFetch(
        jsonResponse({
          commit: {
            hash: 'abc', shortHash: 'abc', subject: 's', message: 's', author: 'a',
            authorEmail: 'a@b', date: '', relativeDate: '', branch: 'main',
            files: [], diff: 'diff', diff_truncated: true,
          },
        }),
        calls,
      ),
    });

    const res = await client.git.commit({ project_id: 'p1', repo_path: 'lib', hash: 'abc' });

    const call = first(calls);
    expect(call.url).toContain('/api/v2/git/commit?');
    expect(call.url).toContain('project_id=p1');
    expect(call.url).toContain('repo_path=lib');
    expect(call.url).toContain('hash=abc');
    expect(res.commit.diff_truncated).toBe(true);
  });
});
