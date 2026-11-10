/**
 * Тесты CLI `synth service …` (ADR-134): генератор unit'а, экранирование,
 * валидация параметров, режимы `--print-unit`/`--dry-run` (ничего не пишут и не
 * зовут systemctl), защита чужого unit'а, `status --json` без установки и
 * аргументы `journalctl`.
 *
 * Внешние команды, `/health` и окружение инъектируются: реальный systemd не
 * вызывается, настоящий `~/.config` не трогается (используется временный
 * `XDG_CONFIG_HOME`).
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SERVICE_MANAGED_MARKER,
  buildLogsArgs,
  createServiceCommand,
  isManagedUnit,
  parseConnectUrl,
  parseServicePort,
  parseServiceUnit,
  renderServiceUnit,
  resolveServicePaths,
  type ExecFileImpl,
  type ServicePaths,
} from './service-commands.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

interface Harness {
  run: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
  execCalls: { file: string; args: string[] }[];
  spawned: { file: string; args: string[] }[];
  paths: ServicePaths;
  tmp: string;
}

/** Стенд: временный XDG, подменённые systemctl/loginctl/journalctl и `/health`. */
async function createHarness(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'synth-service-test-'));
  tempDirs.push(tmp);
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: join(tmp, 'config'),
    HOME: tmp,
    USER: 'tester',
    PATH: '/usr/bin:/bin',
  };
  const paths = resolveServicePaths(env, tmp);

  const execCalls: { file: string; args: string[] }[] = [];
  const spawned: { file: string; args: string[] }[] = [];

  const execFileImpl: ExecFileImpl = async (file, args) => {
    execCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };

  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        status: 'healthy',
        version: '0.0.0-test',
        startedAt: '2026-11-11T00:00:00.000Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const program = new Command().name('synth');
    program.exitOverride();
    program.addCommand(
      createServiceCommand({
        env,
        homeDir: tmp,
        nodePath: '/usr/bin/node',
        scriptPath: '/opt/synth/cli.js',
        execFileImpl,
        spawnImpl: async (file, spawnArgs) => {
          spawned.push({ file, args: spawnArgs });
          return 0;
        },
        whichImpl: async () => true,
        fetchImpl,
        sleepImpl: async () => {},
        healthIntervalMs: 0,
        healthTimeoutMs: 1_000,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      }),
    );
    await program.parseAsync(['node', 'synth', 'service', ...args]);
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = undefined;
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  return { run, execCalls, spawned, paths, tmp };
}

/** Параметры unit'а по умолчанию (для чистых тестов генератора). */
function unitInput(overrides: Record<string, unknown> = {}) {
  return {
    nodePath: '/usr/bin/node',
    scriptPath: '/opt/synth/cli.js',
    envFilePath: '/home/u/.config/synth/service.env',
    home: '/home/u',
    port: 4300,
    host: '127.0.0.1',
    ...overrides,
  };
}

describe('renderServiceUnit', () => {
  it('содержит обязательные директивы и маркер', () => {
    const unit = renderServiceUnit(unitInput());

    expect(unit).toContain(`# ${SERVICE_MANAGED_MARKER}`);
    expect(unit).toContain('Description=Synth — AI-платформа');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Environment=NODE_ENV=production');
    expect(unit).toContain('Environment=SYNTH_RESTART_MODE=process');
    expect(unit).toContain('EnvironmentFile=-/home/u/.config/synth/service.env');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartForceExitStatus=75');
    expect(unit).toContain('RestartSec=3');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('TimeoutStopSec=30');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/synth/cli.js" serve --home "/home/u" --port "4300" --host "127.0.0.1"',
    );
  });

  it('не содержит секретов', () => {
    const unit = renderServiceUnit(unitInput());
    expect(unit).not.toMatch(/SYNTH_API_KEY|api-key=|Bearer|synth_svc_/);
  });

  it('гибрид: --connect попадает в ExecStart, OIDC-флаги — нет', () => {
    const unit = renderServiceUnit(unitInput({ connect: 'https://synth.example' }));
    expect(unit).toContain('--connect "https://synth.example"');
    expect(unit).not.toContain('--oidc-issuer');
    expect(unit).not.toContain('--oidc-client-id');
  });

  it('--data-dir вместо --home', () => {
    const unit = renderServiceUnit(unitInput({ home: null, dataDir: '/srv/synth/data' }));
    expect(unit).toContain('serve --data-dir "/srv/synth/data" --port "4300"');
    expect(unit).not.toContain('--home');
  });

  it('parseServiceUnit разбирает обратно порт/host/home/connect/режим', () => {
    const unit = renderServiceUnit(
      unitInput({ home: '/home/u', connect: 'http://backend:5000', port: 4399, host: '0.0.0.0' }),
    );
    expect(parseServiceUnit(unit)).toMatchObject({
      managed: true,
      port: 4399,
      host: '0.0.0.0',
      home: '/home/u',
      dataDir: null,
      connect: 'http://backend:5000',
      restartMode: 'process',
    });
  });
});

describe('экранирование', () => {
  it('пробел и кавычка в пути home экранируются', () => {
    const unit = renderServiceUnit(unitInput({ home: '/home/te st/"q"' }));
    expect(unit).toContain('--home "/home/te st/\\"q\\""');
  });

  it('процент экранируется как спецификатор (%%), обратный слэш — как \\\\', () => {
    const unit = renderServiceUnit(unitInput({ home: '/home/100%/a\\b' }));
    expect(unit).toContain('--home "/home/100%%/a\\\\b"');
  });

  it('перевод строки запрещён', () => {
    expect(() => renderServiceUnit(unitInput({ home: '/tmp/a\nb' }))).toThrow(/перевод строки/);
    expect(() => renderServiceUnit(unitInput({ home: '/tmp/a\0b' }))).toThrow(/NUL/);
  });
});

describe('валидация', () => {
  it('порт: 0 / 70000 / abc → ошибка, валидный — число', () => {
    expect(() => parseServicePort('0', 4300)).toThrow(/1…65535/);
    expect(() => parseServicePort('70000', 4300)).toThrow(/1…65535/);
    expect(() => parseServicePort('abc', 4300)).toThrow(/1…65535/);
    expect(parseServicePort('4399', 4300)).toBe(4399);
    expect(parseServicePort(undefined, 4300)).toBe(4300);
  });

  it('--connect: только http(s)', () => {
    expect(() => parseConnectUrl('ftp://example.com')).toThrow(/http\(s\)/);
    expect(() => parseConnectUrl('не-url')).toThrow(/http\(s\)/);
    expect(parseConnectUrl('https://synth.example')).toBe('https://synth.example');
  });

  it('CLI: невалидный порт → exit 1', async () => {
    const harness = await createHarness();
    const result = await harness.run(['install', '--print-unit', '--port', 'abc']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--port');
    expect(harness.execCalls).toEqual([]);
  });
});

describe('install: --print-unit и --dry-run', () => {
  it('--print-unit печатает unit и ничего не пишет', async () => {
    const harness = await createHarness();
    const home = join(harness.tmp, 'home');
    const result = await harness.run(['install', '--print-unit', '--port', '4399', '--home', home]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('ExecStart=');
    expect(result.out).toContain('--port "4399"');
    expect(harness.execCalls).toEqual([]);
    await expect(stat(harness.paths.unitPath)).rejects.toThrow();
    await expect(stat(harness.paths.envPath)).rejects.toThrow();
    await expect(stat(home)).rejects.toThrow();
  });

  it('--dry-run печатает план и unit, но не пишет и не зовёт systemctl', async () => {
    const harness = await createHarness();
    const result = await harness.run([
      'install',
      '--dry-run',
      '--port',
      '4399',
      '--data-dir',
      join(harness.tmp, 'data'),
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('[dry-run]');
    expect(result.out).toContain('systemctl --user daemon-reload');
    expect(result.out).toContain('ExecStart=');
    expect(harness.execCalls).toEqual([]);
    await expect(stat(harness.paths.unitPath)).rejects.toThrow();
    await expect(stat(harness.paths.envPath)).rejects.toThrow();
  });
});

describe('install: чужой unit', () => {
  it('без маркера — отказ, с --force — перезапись', async () => {
    const harness = await createHarness();
    await mkdir(harness.paths.unitDir, { recursive: true });
    await writeFile(harness.paths.unitPath, '[Unit]\nDescription=foreign\n', 'utf8');
    const home = join(harness.tmp, 'home');

    const refused = await harness.run([
      'install',
      '--home',
      home,
      '--no-start',
      '--no-linger',
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--force');
    expect(await readFile(harness.paths.unitPath, 'utf8')).toContain('foreign');

    const forced = await harness.run([
      'install',
      '--force',
      '--home',
      home,
      '--no-start',
      '--no-linger',
    ]);
    expect(forced.code).toBe(0);
    const content = await readFile(harness.paths.unitPath, 'utf8');
    expect(isManagedUnit(content)).toBe(true);
    expect(content).toContain('--home ');

    // env-файл создан с правами 0600 и не содержит секретов.
    const envMode = (await stat(harness.paths.envPath)).mode & 0o777;
    expect(envMode).toBe(0o600);
    expect(await readFile(harness.paths.envPath, 'utf8')).not.toMatch(/api-key=|Bearer|synth_svc_/);
  });
});

describe('status', () => {
  it('на отсутствующем unit: {installed:false}, exit 0, без systemctl', async () => {
    const harness = await createHarness();
    const result = await harness.run(['status', '--json']);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as Record<string, unknown>;
    expect(body).toMatchObject({
      installed: false,
      managed: false,
      unitPath: harness.paths.unitPath,
    });
    expect(harness.execCalls).toEqual([]);
  });
});

describe('uninstall', () => {
  it('чужой unit без маркера — отказ', async () => {
    const harness = await createHarness();
    await mkdir(harness.paths.unitDir, { recursive: true });
    const foreign = '[Unit]\nDescription=foreign\n';
    await writeFile(harness.paths.unitPath, foreign, 'utf8');

    const result = await harness.run(['uninstall']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('--force');
    expect(await readFile(harness.paths.unitPath, 'utf8')).toBe(foreign);
  });
});

describe('logs', () => {
  it('аргументы journalctl: --user -u synth -n 100', async () => {
    const harness = await createHarness();
    const result = await harness.run(['logs']);

    expect(result.code).toBe(0);
    expect(harness.spawned[0]).toEqual({
      file: 'journalctl',
      args: ['--user', '-u', 'synth', '-n', '100'],
    });
  });

  it('-f и -n добавляют --follow и своё число строк', async () => {
    const harness = await createHarness();
    await harness.run(['logs', '-f', '-n', '5']);
    expect(harness.spawned[0]).toEqual({
      file: 'journalctl',
      args: ['--user', '-u', 'synth', '-n', '5', '--follow'],
    });
  });

  it('buildLogsArgs — чистая функция', () => {
    expect(buildLogsArgs(42, false)).toEqual(['--user', '-u', 'synth', '-n', '42']);
    expect(buildLogsArgs(1, true)).toEqual(['--user', '-u', 'synth', '-n', '1', '--follow']);
  });
});
