/**
 * ADR-094/ADR-077: метрики исполнителя и его `/metrics`.
 *
 * Проверяется контракт:
 * - эндпоинт **выключен по умолчанию** → 404 (эндпоинта «нет»);
 * - без bearer-токена исполнителя → 401; с токеном → 200 в формате
 *   exposition 0.0.4 с `Cache-Control: no-store`;
 * - счётчики исполнения: `synth_executor_commands_total{outcome}`,
 *   `synth_executor_exec_duration_seconds`, `synth_executor_inflight`
 *   (возвращается в 0), `synth_executor_mcp_servers{status}`;
 * - лейблы — только `outcome`/`status` из закрытого списка ADR-094.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createExecutorApp, type ExecutorAppOptions } from './server.js';
import { createExecutorMetrics, type ExecutorMetrics } from './metrics.js';

const TOKEN = 'executor-metrics-token-test-1234567890';

let workspace: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'synth-executor-metrics-')));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Приложение исполнителя (метрики — по переданному экземпляру). */
function makeApp(opts: Partial<ExecutorAppOptions> = {}): Hono {
  return createExecutorApp({
    token: TOKEN,
    workspaceRoot: workspace,
    toolchain: {},
    ...opts,
  }) as unknown as Hono;
}

/** GET /metrics с токеном (или без него). */
function getMetrics(app: Hono, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return Promise.resolve(app.request('/metrics', { method: 'GET', headers }));
}

/** POST /exec с токеном. */
function postExec(app: Hono, command: string): Promise<Response> {
  return Promise.resolve(
    app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ command: { kind: 'shell', command } }),
    }),
  );
}

/** Значение метрики из текста exposition (по имени и лейблам). */
function metricValue(text: string, name: string, labels = ''): number | undefined {
  const prefix = labels.length > 0 ? `${name}{${labels}}` : name;
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

describe('исполнитель: /metrics выключен по умолчанию', () => {
  it('без метрик — 404', async () => {
    const app = makeApp();
    const res = await getMetrics(app);
    expect(res.status).toBe(404);
  });

  it('без метрик — 404 даже с корректным токеном', async () => {
    const app = makeApp();
    const res = await getMetrics(app, TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('исполнитель: /metrics с включёнными метриками', () => {
  it('без токена — 401', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });
    const res = await getMetrics(app, null);
    expect(res.status).toBe(401);
  });

  it('с неверным токеном — 401', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });
    const res = await getMetrics(app, 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('с токеном — 200, exposition 0.0.4 и no-store', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });
    const res = await getMetrics(app);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const text = await res.text();
    expect(text).toContain('synth_executor_inflight');
    expect(text).toContain('synth_executor_commands_total');
    expect(text).toContain('synth_executor_exec_duration_seconds');
    expect(text).toContain('synth_executor_mcp_servers');
  });

  it('токен не попадает в текст метрик', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });
    const text = await (await getMetrics(app)).text();
    expect(text).not.toContain(TOKEN);
  });
});

describe('исполнитель: счётчики исполнения', () => {
  it('успешная команда: commands_total{ok}, гистограмма и inflight=0', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });

    const res = await postExec(app, 'printf ok');
    expect(res.status).toBe(200);

    const text = await (await getMetrics(app)).text();
    expect(metricValue(text, 'synth_executor_commands_total', 'outcome="ok"')).toBe(1);
    expect(metricValue(text, 'synth_executor_exec_duration_seconds_count')).toBe(1);
    expect(metricValue(text, 'synth_executor_inflight')).toBe(0);
  });

  it('упавшая команда: commands_total{error}, inflight=0', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });

    const res = await postExec(app, 'exit 7');
    expect(res.status).toBe(500);

    const text = await (await getMetrics(app)).text();
    expect(metricValue(text, 'synth_executor_commands_total', 'outcome="error"')).toBe(1);
    expect(metricValue(text, 'synth_executor_exec_duration_seconds_count')).toBe(1);
    expect(metricValue(text, 'synth_executor_inflight')).toBe(0);
  });

  it('таймаут команды: commands_total{timeout}', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });

    const res = await Promise.resolve(
      app.request('/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ command: { kind: 'shell', command: 'sleep 5' }, timeoutMs: 200 }),
      }),
    );
    expect(res.status).toBe(500);

    const text = await (await getMetrics(app)).text();
    expect(metricValue(text, 'synth_executor_commands_total', 'outcome="timeout"')).toBe(1);
    expect(metricValue(text, 'synth_executor_inflight')).toBe(0);
  });

  it('несколько команд — счётчик накапливается', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });

    await postExec(app, 'printf 1');
    await postExec(app, 'printf 2');
    await postExec(app, 'exit 3');

    const text = await (await getMetrics(app)).text();
    expect(metricValue(text, 'synth_executor_commands_total', 'outcome="ok"')).toBe(2);
    expect(metricValue(text, 'synth_executor_commands_total', 'outcome="error"')).toBe(1);
  });
});

describe('исполнитель: состояние MCP-серверов', () => {
  it('без MCP-серверов — нули по всем состояниям', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({ metrics });

    const text = await (await getMetrics(app)).text();
    expect(metricValue(text, 'synth_executor_mcp_servers', 'status="idle"')).toBe(0);
    expect(metricValue(text, 'synth_executor_mcp_servers', 'status="up"')).toBe(0);
    expect(metricValue(text, 'synth_executor_mcp_servers', 'status="down"')).toBe(0);
  });

  it('состояние сервера попадает в gauge (idle до подъёма)', async () => {
    const metrics = createExecutorMetrics();
    const app = makeApp({
      metrics,
      mcpServers: [{ name: 'fake', command: 'true', args: [], env: {} }],
    });

    const text = await (await getMetrics(app)).text();
    expect(metricValue(text, 'synth_executor_mcp_servers', 'status="idle"')).toBe(1);
  });
});

describe('исполнитель: реестр метрик', () => {
  it('метрики создаются с контрактными именами и лейблами', () => {
    const metrics: ExecutorMetrics = createExecutorMetrics();
    const snapshot = metrics.registry.snapshot();
    const names = snapshot.map((m) => m.name);
    expect(names).toContain('synth_executor_commands_total');
    expect(names).toContain('synth_executor_inflight');
    expect(names).toContain('synth_executor_exec_duration_seconds');
    expect(names).toContain('synth_executor_mcp_servers');

    const commands = snapshot.find((m) => m.name === 'synth_executor_commands_total');
    expect(commands?.type).toBe('counter');
    expect(commands?.labelNames).toEqual(['outcome']);

    const mcp = snapshot.find((m) => m.name === 'synth_executor_mcp_servers');
    expect(mcp?.type).toBe('gauge');
    expect(mcp?.labelNames).toEqual(['status']);
  });
});
