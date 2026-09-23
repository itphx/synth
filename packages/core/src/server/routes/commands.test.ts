import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandRoutes } from './commands.js';
import { CommandService } from '../../engine/commands/service.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

let tmpDir: string;

function makeApp() {
  const skillSource = {
    listSummaries: async () => ({ skills: [], diagnostics: [] }),
    get: async () => undefined,
    load: async () => undefined,
  };
  const commandService = new CommandService({
    config: {
      dataDir: tmpDir,
      commandsPaths: [],
      bundlesPath: 'skill-bundles',
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: 1000,
      maxRenderedBytes: 100_000,
      toolsets: {},
      inlineShell: false,
    },
    skillRuntime: {} as never,
    skillSource,
  });
  const app = new Hono();
  app.route('/api/v2/commands', createCommandRoutes(createMockAuth(), { commandService }));
  return { app };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-cmd-routes-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('/api/v2/commands (AD-046 §9.1)', () => {
  it('GET / — builtin-команды', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/commands');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.commands.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['help', 'skills', 'commands', 'summary']),
    );
  });

  it('GET / — шаблонная команда из {dataDir}/commands', async () => {
    await mkdir(join(tmpDir, 'commands'), { recursive: true });
    await writeFile(
      join(tmpDir, 'commands', 'deploy.md'),
      ['---', 'name: deploy', 'description: Деплой', '---', 'steps'].join('\n'),
      'utf-8',
    );
    const { app } = makeApp();
    const body: any = await (await app.request('/api/v2/commands')).json();
    expect(body.commands.some((c: any) => c.name === 'deploy' && c.kind === 'template')).toBe(true);
  });

  it('GET /?diagnostics=1 — диагностика', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/commands?diagnostics=1');
    const body: any = await res.json();
    expect(Array.isArray(body.diagnostics)).toBe(true);
  });
});
