import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandService, isLocalCommandStatus } from './service.js';
import type { CommandRuntimeConfig } from './types.js';
import type { DiscoveredSkill, LoadedSkill, SkillRuntime } from '../skills/types.js';
import type { SkillMeta, SkillSummary, PermissionConfig } from '@itphx/synth-shared';

function meta(over: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: 'api-review', description: 'Ревью API', userInvocable: true,
    disableModelInvocation: false, invocation: 'both', ...over,
  };
}

function summary(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'api-review', description: 'Ревью API', scope: 'instance', level: 'system',
    dir: '/skills/api-review', invocation: 'both', userInvocable: true, modelInvocable: true,
    tags: [], agents: [], groups: [], requiresCapabilities: [], trusted: true, available: true,
    ...over,
  };
}

function discovered(m: SkillMeta = meta()): DiscoveredSkill {
  return {
    name: m.name, meta: m, body: 'BODY', dir: `/skills/${m.name}`, file: `/skills/${m.name}/SKILL.md`,
    source: { scope: 'instance', level: 'system', origin: 'instance', dir: '/skills', trusted: true },
    trusted: true, mtimeMs: 1,
  };
}

interface Sources {
  listSummaries?: () => Promise<{ skills: SkillSummary[]; diagnostics: unknown[] }>;
  get?: (name: string) => Promise<DiscoveredSkill | undefined>;
  load?: (name: string) => Promise<LoadedSkill | undefined>;
}

function makeService(opts: {
  sources?: Sources;
  config?: Partial<CommandRuntimeConfig>;
  bundles?: { name: string; description: string; skills: string[] }[];
  permissionConfig?: PermissionConfig;
} = {}) {
  const sources = opts.sources ?? {
    listSummaries: async () => ({ skills: [summary()], diagnostics: [] }),
    get: async (name) => (name === 'api-review' ? discovered() : undefined),
    load: async (name) => (name === 'api-review'
      ? { summary: summary(), meta: meta(), body: 'BODY', dir: '/skills/api-review', files: ['references/a.md'] } as LoadedSkill
      : undefined),
  };
  const skillRuntime = {} as unknown as SkillRuntime;
  const skillSource = {
    listSummaries: sources.listSummaries ?? (async () => ({ skills: [], diagnostics: [] })),
    get: sources.get ?? (async () => undefined),
    load: sources.load ?? (async () => undefined),
  };
  const bundleStore = {
    list: async () => opts.bundles ?? [],
    get: async () => undefined,
    set: async () => {},
    remove: async () => false,
    exists: async () => false,
  } as never;
  const config: CommandRuntimeConfig = {
    dataDir: '/data',
    commandsPaths: [],
    bundlesPath: 'skill-bundles',
    conflict: { mode: 'bundle-wins', namespacePrefix: false },
    maxArgumentsLength: 1000,
    maxRenderedBytes: 100_000,
    toolsets: opts.config?.toolsets ?? {},
    ...opts.config,
  };
  const service = new CommandService({ config, skillRuntime, skillSource, bundleStore });
  return { service, permissionConfig: opts.permissionConfig };
}

const CTX = { projectWorkspace: '/work' };

describe('CommandService — builtins (AD-046 §7.2)', () => {
  it('/help — локальный ответ', async () => {
    const { service } = makeService();
    const r = await service.resolve('/help', CTX);
    expect(r?.status).toBe('builtin');
    expect(r?.output).toContain('/help');
  });

  it('/commands — список с builtin и скиллами', async () => {
    const { service } = makeService();
    const r = await service.resolve('/commands', CTX);
    expect(r?.status).toBe('builtin');
    expect(r?.output).toContain('/api-review');
  });

  it('/skills — список скиллов', async () => {
    const { service } = makeService();
    const r = await service.resolve('/skills', CTX);
    expect(r?.output).toContain('/api-review');
  });

  it('/summary — триггер суммаризации', async () => {
    const { service } = makeService();
    expect((await service.resolve('/summary', CTX))?.status).toBe('summarization');
  });

  it('неизвестная команда', async () => {
    const { service } = makeService();
    const r = await service.resolve('/nope', CTX);
    expect(r?.status).toBe('unknown');
  });

  it('не-команда → undefined', async () => {
    const { service } = makeService();
    expect(await service.resolve('просто текст', CTX)).toBeUndefined();
  });
});

describe('CommandService — скиллы и права', () => {
  it('/api-review резолвится в тело скилла', async () => {
    const { service } = makeService();
    const r = await service.resolve('/api-review extra', CTX);
    expect(r?.status).toBe('skill');
    expect(r?.prompt).toContain('BODY');
    expect(r?.prompt).toContain('extra');
    expect(r?.skills).toEqual(['api-review']);
  });

  it('deny скрывает команду и блокирует резолвинг', async () => {
    const { service } = makeService({ permissionConfig: { rules: { command: { help: 'deny' } }, askTimeoutMs: 30_000 } });
    const r = await service.resolve('/help', { ...CTX, permissionConfig: { rules: { command: { help: 'deny' } }, askTimeoutMs: 30_000 } });
    expect(r?.status).toBe('denied');
    const list = await service.list({ ...CTX, permissionConfig: { rules: { command: { help: 'deny' } }, askTimeoutMs: 30_000 } });
    expect(list.commands.some((c) => c.name === 'help')).toBe(false);
  });

  it('requiresToolsets экспандится через config.skills.toolsets', async () => {
    const m = meta({ requiresToolsets: ['git'] });
    const { service } = makeService({
      config: { toolsets: { git: ['git_read'] } },
      sources: {
        listSummaries: async () => ({ skills: [summary()], diagnostics: [] }),
        get: async () => discovered(m),
        load: async () => undefined,
      },
    });
    const list = await service.list({ ...CTX, capabilities: [] });
    expect(list.commands.find((c) => c.name === 'api-review')?.available).toBe(false);
    const r = await service.resolve('/api-review', { ...CTX, capabilities: [] });
    expect(r?.status).toBe('unavailable');
    expect(r?.message).toContain('git_read');
  });

  it('isLocalCommandStatus: summarization не локальный (CLI запускает суммаризацию)', () => {
    expect(isLocalCommandStatus('builtin')).toBe(true);
    expect(isLocalCommandStatus('unknown')).toBe(true);
    expect(isLocalCommandStatus('denied')).toBe(true);
    expect(isLocalCommandStatus('unavailable')).toBe(true);
    // template/skill/bundle — уходят в LLM; summarization — реальный запуск.
    expect(isLocalCommandStatus('template')).toBe(false);
    expect(isLocalCommandStatus('skill')).toBe(false);
    expect(isLocalCommandStatus('bundle')).toBe(false);
    expect(isLocalCommandStatus('summarization')).toBe(false);
  });

  it('bundle грузит N тел', async () => {
    const loaded = (name: string) => ({
      summary: summary({ name }), meta: meta({ name }), body: `BODY-${name}`, dir: `/skills/${name}`, files: [],
    } as LoadedSkill);
    const { service } = makeService({
      bundles: [{ name: 'dev', description: 'Dev', skills: ['api-review', 'testing'] }],
      sources: {
        listSummaries: async () => ({ skills: [], diagnostics: [] }),
        get: async () => undefined,
        load: async (name) => (name === 'api-review' || name === 'testing' ? loaded(name) : undefined),
      },
    });
    const r = await service.resolve('/dev', CTX);
    expect(r?.status).toBe('bundle');
    expect(r?.skills).toEqual(['api-review', 'testing']);
    expect(r?.prompt).toContain('BODY-api-review');
  });
});

async function writeTemplateCommand(dir: string, name: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.md`),
    ['---', `name: ${name}`, `description: ${name}`, '---', `body-${name}`].join('\n'),
    'utf-8',
  );
}

describe('CommandService — trust-гейт проектных шаблонов (AD-046 §4.4/§7.1)', () => {
  let dataDir: string;
  let ws: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-cmd-svc-data-'));
    ws = await mkdtemp(join(tmpdir(), 'synth-cmd-svc-ws-'));
    await writeTemplateCommand(join(ws, '.synth', 'commands'), 'deploy');
    await writeTemplateCommand(join(dataDir, 'commands'), 'instance-cmd');
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  });

  it('недоверенная проектная команда: untrusted-диагностика, не резолвится, не в list; instance не задет', async () => {
    const { service } = makeService({ config: { dataDir, trustedProjectDirs: [] } });
    const ctx = { projectWorkspace: ws };

    const list = await service.list(ctx);
    expect(list.commands.some((c) => c.name === 'deploy')).toBe(false);
    expect(list.commands.some((c) => c.name === 'instance-cmd')).toBe(true);
    expect(list.diagnostics.some((d) => d.code === 'untrusted' && d.command === 'deploy')).toBe(true);

    expect((await service.resolve('/deploy', ctx))?.status).toBe('unknown');
    // instance-команда по-прежнему резолвится.
    expect((await service.resolve('/instance-cmd', ctx))?.status).toBe('template');
  });

  it('после добавления workspace в trustedProjectDirs — проектная команда резолвится', async () => {
    const { service } = makeService({ config: { dataDir, trustedProjectDirs: [ws] } });
    const ctx = { projectWorkspace: ws };

    const r = await service.resolve('/deploy', ctx);
    expect(r?.status).toBe('template');
    expect(r?.prompt).toContain('body-deploy');

    const list = await service.list(ctx);
    expect(list.commands.some((c) => c.name === 'deploy')).toBe(true);
    expect(list.diagnostics.some((d) => d.code === 'untrusted')).toBe(false);
  });

  it('без проекта недоверенных источников нет — команды доступны', async () => {
    const { service } = makeService({ config: { dataDir, trustedProjectDirs: [] } });
    expect((await service.resolve('/instance-cmd', {}) )?.status).toBe('template');
  });
});
