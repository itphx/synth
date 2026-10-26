import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as undici from 'undici';
import { GitService } from './git-service.js';
import type { ExecRequest, ExecutionPort } from '../execution/ports/index.js';
import { gitCaConfig, initTlsTrust, getTlsCaPath, _resetTlsTrustForTests } from '../security/tls.js';

/**
 * ADR-099: доверие CA для git передаётся **пер-вызовом** (`-c http.sslCAInfo=<path>`)
 * в argv через порт исполнения (`git/exec.ts`). Env-канал (`GIT_SSL_CAINFO`)
 * недоступен: `sanitizeGitEnv` вырезает `git*`-env.
 *
 * В remote-режиме CA control plane **не** передаётся: путь принадлежит
 * control plane, у исполнителя своя политика доверия (ADR-077/ADR-099).
 *
 * Тест фиксирует argv на фейковом порте — сеть не нужна.
 */

/** CA-фикстура (самоподписанный тестовый серт) — валидный PEM. */
const CERT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'security',
  '__fixtures__',
  'tls-test-selfsigned.pem',
);

/** Порт-шпион: фиксирует argv/окружение, отвечает заданным stdout. */
class CapturingPort implements ExecutionPort {
  readonly calls: ExecRequest[] = [];
  readonly isRemote: boolean;
  stdout = 'true\n';

  constructor(opts: { isRemote?: boolean } = {}) {
    this.isRemote = opts.isRemote === true;
  }

  async execute(req: ExecRequest): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  }> {
    this.calls.push(req);
    return { stdout: this.stdout, stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  }
}

/** Аргументы последнего git-вызова. */
function lastArgs(port: CapturingPort): string[] {
  const command = port.calls.at(-1)?.command;
  if (command?.kind !== 'argv') throw new Error('git-вызов не найден');
  return command.args ?? [];
}

describe('git-CA (ADR-099): argv порта исполнения', () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    _resetTlsTrustForTests();
    root = await mkdtemp(join(tmpdir(), 'synth-git-ca-'));
    ws = join(root, 'ws');
    await mkdir(ws, { recursive: true });
  });

  afterEach(async () => {
    _resetTlsTrustForTests();
    // Возвращаем «чистый» глобальный dispatcher (initTlsTrust ставит свой).
    undici.setGlobalDispatcher(new undici.Agent());
    await rm(root, { recursive: true, force: true });
  });

  it('без CA — argv без `-c`', async () => {
    // Продакшн-путь: initTlsTrust вызывается всегда (даже без security.tls).
    await initTlsTrust(undefined, {});
    expect(getTlsCaPath()).toBeUndefined();
    expect(gitCaConfig()).toEqual([]);

    const port = new CapturingPort();
    await new GitService(root, { execution: port }).isRepo(ws);

    expect(lastArgs(port)).toEqual(['rev-parse', '--is-inside-work-tree']);
  });

  it('caPem (PEM без файла) git-каналу недоступен — CA не подставляется', async () => {
    await initTlsTrust({ security: { tls: { caPem: readFileSync(CERT_PATH, 'utf-8') } } }, {});
    expect(getTlsCaPath()).toBeUndefined();
    expect(gitCaConfig()).toEqual([]);

    const port = new CapturingPort();
    await new GitService(root, { execution: port }).isRepo(ws);
    expect(lastArgs(port)).not.toContain('-c');
  });

  it('с security.tls.caFile — в argv попадает `-c http.sslCAInfo=<path>`', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});

    expect(getTlsCaPath()).toBe(CERT_PATH);
    expect(gitCaConfig()).toEqual([`http.sslCAInfo=${CERT_PATH}`]);

    const port = new CapturingPort();
    await new GitService(root, { execution: port }).isRepo(ws);

    expect(lastArgs(port)).toEqual([
      '-c',
      `http.sslCAInfo=${CERT_PATH}`,
      'rev-parse',
      '--is-inside-work-tree',
    ]);
  });

  it('clone получает CA пер-вызовом', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});
    const port = new CapturingPort();

    try {
      await new GitService(root, { execution: port }).cloneRepo(ws, 'repos/x', 'https://example.invalid/x.git');
    } catch {
      // git-вызов не выполняется — важен только argv.
    }

    const args = lastArgs(port);
    expect(args.slice(0, 2)).toEqual(['-c', `http.sslCAInfo=${CERT_PATH}`]);
    expect(args[2]).toBe('clone');
  });

  it('remote-порт: CA control plane в argv не передаётся', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});
    const port = new CapturingPort({ isRemote: true });
    await new GitService(root, { execution: port }).isRepo(ws);

    expect(lastArgs(port)).toEqual(['rev-parse', '--is-inside-work-tree']);
    expect(lastArgs(port)).not.toContain('-c');
  });
});
