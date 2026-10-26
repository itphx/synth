import { describe, it, expect, afterEach } from 'vitest';
import * as undici from 'undici';
import { GitService, sanitizeGitEnv } from './git-service.js';
import type { ExecRequest, ExecutionPort } from '../execution/ports/index.js';
import { initTlsTrust, _resetTlsTrustForTests } from '../security/tls.js';

/**
 * ADR-099 (D2b): прокси/креды/no_proxy передаются git **через окружение**
 * (`http_proxy`/`https_proxy`/`all_proxy`/`no_proxy`), а не argv/`-c`:
 * пароль Basic не должен попадать в список аргументов процесса.
 */

/** Порт-шпион: фиксирует запросы (argv + env). */
class CapturingPort implements ExecutionPort {
  readonly calls: ExecRequest[] = [];

  async execute(req: ExecRequest): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  }> {
    this.calls.push(req);
    return { stdout: 'true\n', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  }
}

/** Окружение последнего git-вызова. */
function lastEnv(port: CapturingPort): Record<string, string> {
  return port.calls.at(-1)?.env ?? {};
}

/** Аргументы последнего git-вызова. */
function lastArgs(port: CapturingPort): string[] {
  const command = port.calls.at(-1)?.command;
  return command?.kind === 'argv' ? command.args ?? [] : [];
}

afterEach(() => {
  _resetTlsTrustForTests();
  undici.setGlobalDispatcher(new undici.Agent());
});

describe('git proxy env (D2b)', () => {
  it('lowercase http_proxy/https_proxy/all_proxy/no_proxy с кредами — в env, не в argv', async () => {
    await initTlsTrust(
      {
        proxy: {
          url: 'http://user:pass@proxy.corp:3128',
          noProxy: ['localhost', '.corp.example'],
          fromEnv: false,
        },
      },
      {},
    );

    const port = new CapturingPort();
    await new GitService('/tmp', { execution: port }).isRepo('/tmp');

    const env = lastEnv(port);
    expect(env.http_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(env.https_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(env.all_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(env.no_proxy).toBe('localhost,.corp.example');

    // Пароль и сам прокси не попадают в argv (только env).
    expect(lastArgs(port).join(' ')).not.toContain('http.proxy');
    expect(lastArgs(port).join(' ')).not.toContain('pass');
  });

  it('без прокси env не меняется (нет прокси-переменных)', async () => {
    await initTlsTrust({ proxy: { enabled: false } }, {});
    const port = new CapturingPort();
    await new GitService('/tmp', { execution: port }).isRepo('/tmp');
    const env = lastEnv(port);
    expect(env).not.toHaveProperty('http_proxy');
    expect(env).not.toHaveProperty('https_proxy');
    expect(env).not.toHaveProperty('all_proxy');
    expect(env).not.toHaveProperty('no_proxy');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('sanitizeGitEnv сохраняет lowercase proxy-переменные', () => {
    const sanitized = sanitizeGitEnv({
      PATH: '/usr/bin',
      http_proxy: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      all_proxy: 'socks5://proxy:1080',
      no_proxy: 'localhost',
      GIT_PAGER: 'cat',
      EDITOR: 'vim',
    });
    expect(sanitized).toMatchObject({
      http_proxy: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      all_proxy: 'socks5://proxy:1080',
      no_proxy: 'localhost',
    });
    expect(sanitized).not.toHaveProperty('GIT_PAGER');
    expect(sanitized).not.toHaveProperty('EDITOR');
  });

  it('SOCKS5: env-URL с userinfo, пароль не в argv', async () => {
    await initTlsTrust(
      {
        proxy: {
          url: 'socks5h://user:pass@proxy.corp:1080',
          noProxy: ['internal.example'],
          fromEnv: false,
        },
      },
      {},
    );

    const port = new CapturingPort();
    await new GitService('/tmp', { execution: port }).isRepo('/tmp');

    const env = lastEnv(port);
    expect(env.all_proxy).toBe('socks5h://user:pass@proxy.corp:1080');
    expect(env.https_proxy).toBe('socks5h://user:pass@proxy.corp:1080');
    expect(env.no_proxy).toBe('internal.example');
    expect(lastArgs(port).join(' ')).not.toContain('pass');
  });
});
