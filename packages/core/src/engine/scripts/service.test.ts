import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessService } from '../processes/service.js';
import { BackgroundUnsupportedError } from '../processes/types.js';
import { ScriptService } from './service.js';
import { ScriptError } from './types.js';

/**
 * ADR-126 §5: сервис скриптов — запуск.
 *
 * Проверяется:
 *   • argv-форма (без shell-конкатенации) и shell-форма (`SYNTH_ARGS`);
 *   • запрет аргументов при `args: false`;
 *   • containment `cwd` (симлинк наружу — отказ);
 *   • проброс `origin`/`title` в `ProcessService.spawn`;
 *   • маппинг `BackgroundUnsupportedError` в `script_background_disabled`.
 *
 * Изолированно: `ProcessService` — структурная заглушка (реальный процесс не
 * запускается), сеть не используется.
 */

let dataDir: string;
let workspace: string;
let outside: string;

interface SpawnCall {
  sessionId: string;
  command?: string;
  argv?: { file: string; args: string[] };
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  requires?: string[];
  title?: string;
  origin?: 'user' | 'agent';
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-scripts-svc-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-scripts-svc-ws-'));
  outside = await mkdtemp(join(tmpdir(), 'synth-scripts-svc-out-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function writeScript(name: string, frontmatter: string[]): Promise<void> {
  const dir = join(workspace, '.synth', 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), ['---', ...frontmatter, '---', 'тело'].join('\n'), 'utf-8');
}

function createService(spawnImpl?: (input: SpawnCall) => Promise<unknown>) {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn(async (input: SpawnCall) => {
    calls.push(input);
    if (spawnImpl) return spawnImpl(input);
    return { runId: 'bgr_1', processId: 'proc_1', logPath: 'processes/bgr_1.log' };
  });
  const processService = { spawn } as unknown as ProcessService;
  const service = new ScriptService({
    config: { dataDir, scriptsPaths: [], trustedProjectDirs: [workspace] },
    processService,
  });
  return { service, spawn, calls };
}

describe('ScriptService — запуск', () => {
  it('argv-форма: запуск файла с аргументами, без shell-конкатенации', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh', 'args: true']);
    const { service, spawn } = createService();

    const res = await service.run({
      name: 'dev',
      args: '--port 5000 "имя с пробелом"',
      sessionId: 's1',
      workingDir: workspace,
      projectWorkspace: workspace,
      origin: 'user',
    });

    expect(res).toEqual({
      run_id: 'bgr_1',
      process_id: 'proc_1',
      log_path: 'processes/bgr_1.log',
      status: 'running',
    });

    const call = spawn.mock.calls[0]![0] as SpawnCall;
    expect(call.argv).toEqual({ file: './scripts/dev.sh', args: ['--port', '5000', 'имя с пробелом'] });
    expect(call.command).toBeUndefined();
    // argv-форма: бинарное требование не задаётся (запускается сам файл).
    expect(call.requires).toEqual([]);
    // Аргументы ушли в argv — отдельные переменные не нужны.
    expect(call.env?.SYNTH_ARGS).toBeUndefined();
  });

  it('shell-форма: команда из декларации, аргументы — в окружении', async () => {
    await writeScript('dev', [
      'description: D',
      'run: ./scripts/dev.sh --watch',
      'shell: true',
      'args: true',
      'env:',
      '  MODE: dev',
    ]);
    const { service, spawn } = createService();

    await service.run({
      name: 'dev',
      args: 'one two',
      sessionId: 's1',
      workingDir: workspace,
      projectWorkspace: workspace,
      origin: 'agent',
    });

    const call = spawn.mock.calls[0]![0] as SpawnCall;
    expect(call.command).toBe('./scripts/dev.sh --watch');
    expect(call.argv).toBeUndefined();
    expect(call.env).toMatchObject({
      MODE: 'dev',
      SYNTH_ARGS: 'one two',
      SYNTH_ARG_1: 'one',
      SYNTH_ARG_2: 'two',
    });
    expect(call.requires).toEqual(['bash']);
  });

  it('args: false + аргументы — script_args_not_allowed', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh']);
    const { service, spawn } = createService();

    await expect(
      service.run({ name: 'dev', args: 'extra', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' }),
    ).rejects.toMatchObject({ code: 'script_args_not_allowed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('скрипт не объявлен — script_not_found', async () => {
    const { service } = createService();
    await expect(
      service.run({ name: 'нет-такого', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' }),
    ).rejects.toMatchObject({ code: 'script_not_found' });
  });

  it('недоверенный каталог проекта — script_untrusted', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh']);
    const calls: SpawnCall[] = [];
    const spawn = vi.fn(async (input: SpawnCall) => {
      calls.push(input);
      return { runId: 'bgr_1', processId: 'proc_1', logPath: 'processes/bgr_1.log' };
    });
    const service = new ScriptService({
      config: { dataDir, scriptsPaths: [], trustedProjectDirs: [] },
      processService: { spawn } as unknown as ProcessService,
    });

    await expect(
      service.run({ name: 'dev', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' }),
    ).rejects.toMatchObject({ code: 'script_untrusted' });
    expect(calls).toHaveLength(0);
  });

  it('cwd наружу через симлинк — script_cwd_outside', async () => {
    await mkdir(join(workspace, 'escape-parent'), { recursive: true });
    await symlink(outside, join(workspace, 'escape-parent', 'out'));
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh', 'cwd: escape-parent/out']);
    const { service, spawn } = createService();

    await expect(
      service.run({ name: 'dev', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' }),
    ).rejects.toMatchObject({ code: 'script_cwd_outside' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cwd внутри периметра — запуск проходит', async () => {
    await mkdir(join(workspace, 'sub'), { recursive: true });
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh', 'cwd: sub']);
    const { service, spawn } = createService();

    await service.run({ name: 'dev', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' });

    expect((spawn.mock.calls[0]![0] as SpawnCall).cwd).toBe(join(workspace, 'sub'));
  });

  it('origin и title доходят до ProcessService.spawn', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh']);
    const { service, spawn } = createService();

    await service.run({ name: 'dev', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' });

    const call = spawn.mock.calls[0]![0] as SpawnCall;
    expect(call.origin).toBe('user');
    expect(call.title).toBe('dev');
  });

  it('BackgroundUnsupportedError → script_background_disabled', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh']);
    const { service } = createService(() => {
      throw new BackgroundUnsupportedError();
    });

    await expect(
      service.run({ name: 'dev', sessionId: 's1', workingDir: workspace, projectWorkspace: workspace, origin: 'user' }),
    ).rejects.toMatchObject({ code: 'script_background_disabled' });
  });
});

describe('ScriptService — чтение реестра', () => {
  it('list отдаёт сводки и диагностику, пути — относительные', async () => {
    await writeScript('dev', ['description: Поднять dev', 'run: ./scripts/dev.sh', 'background: false']);
    const { service } = createService();

    const res = await service.list({ projectWorkspace: workspace });

    expect(res.scripts).toHaveLength(1);
    expect(res.scripts[0]).toMatchObject({
      name: 'dev',
      description: 'Поднять dev',
      origin: 'project',
      available: true,
      trusted: true,
      background: false,
    });
    for (const diagnostic of res.diagnostics) {
      if (diagnostic.path) expect(diagnostic.path.startsWith('/')).toBe(false);
    }
  });

  it('недоверенный скрипт виден, но недоступен', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh']);
    const service = new ScriptService({
      config: { dataDir, scriptsPaths: [], trustedProjectDirs: [] },
      processService: { spawn: vi.fn() } as unknown as ProcessService,
    });

    const res = await service.list({ projectWorkspace: workspace });

    expect(res.scripts).toHaveLength(1);
    expect(res.scripts[0]!.available).toBe(false);
    expect(res.scripts[0]!.unavailableReason).toBe('trusted');
    expect(res.diagnostics.some((d) => d.code === 'untrusted')).toBe(true);
  });

  it('get отдаёт детали с относительным путём файла', async () => {
    await writeScript('dev', ['description: D', 'run: ./scripts/dev.sh', 'args: true']);
    const { service } = createService();

    const detail = await service.get('dev', { projectWorkspace: workspace });

    expect(detail).toBeTruthy();
    expect(detail!.file).toBe(join('.synth', 'scripts', 'dev.md'));
    expect(detail!.run).toBe('./scripts/dev.sh');
    expect(detail!.args).toBe(true);
    expect(detail!.shell).toBe(false);
  });

  it('get неизвестного скрипта — null', async () => {
    const { service } = createService();
    expect(await service.get('нет-такого', { projectWorkspace: workspace })).toBeNull();
  });
});

describe('ScriptError', () => {
  it('носит машинный код', () => {
    const err = new ScriptError('script_not_found', 'нет скрипта');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('script_not_found');
    expect(err.name).toBe('ScriptError');
  });
});
