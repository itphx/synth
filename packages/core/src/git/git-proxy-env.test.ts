import { describe, it, expect, vi, afterEach } from 'vitest';
import * as undici from 'undici';

const { envMock, simpleGitMock } = vi.hoisted(() => {
  const env = vi.fn(function (this: unknown, ..._args: unknown[]) {
    return this;
  });
  const git = vi.fn((..._args: unknown[]) => ({
    env,
    checkIsRepo: async () => true,
  }));
  return { envMock: env, simpleGitMock: git };
});

vi.mock('simple-git', () => ({
  simpleGit: simpleGitMock,
}));

import { GitService, sanitizeGitEnv } from './git-service.js';
import { initTlsTrust, _resetTlsTrustForTests } from '../security/tls.js';

afterEach(() => {
  _resetTlsTrustForTests();
  undici.setGlobalDispatcher(new undici.Agent());
  envMock.mockClear();
  simpleGitMock.mockClear();
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

    await new GitService('/tmp').isRepo('/tmp');

    const env = envMock.mock.calls.at(-1)?.[0] as unknown as Record<string, string>;
    expect(env.http_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(env.https_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(env.all_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(env.no_proxy).toBe('localhost,.corp.example');

    // Пароль и сам прокси не попадают в argv/options (только env).
    const options = simpleGitMock.mock.calls.at(-1)?.[1] as unknown as
      | { config?: string[] }
      | undefined;
    expect(options?.config ?? []).not.toContainEqual(expect.stringContaining('http.proxy'));
    expect(JSON.stringify(simpleGitMock.mock.calls)).not.toContain('pass');
  });

  it('без прокси env не меняется (нет прокси-переменных)', async () => {
    await initTlsTrust({ proxy: { enabled: false } }, {});
    await new GitService('/tmp').isRepo('/tmp');
    const env = envMock.mock.calls.at(-1)?.[0] as unknown as Record<string, string>;
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
    await new GitService('/tmp').isRepo('/tmp');

    const env = envMock.mock.calls.at(-1)?.[0] as unknown as Record<string, string>;
    expect(env.all_proxy).toBe('socks5h://user:pass@proxy.corp:1080');
    expect(env.https_proxy).toBe('socks5h://user:pass@proxy.corp:1080');
    expect(env.no_proxy).toBe('internal.example');
    expect(JSON.stringify(simpleGitMock.mock.calls)).not.toContain('pass');
  });
});
