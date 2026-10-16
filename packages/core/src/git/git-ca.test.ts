import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as undici from 'undici';

/**
 * ADR-099: доверие CA для git передаётся **пер-вызовом** через опции инстанса
 * `simple-git` (`config: ['http.sslCAInfo=<path>']`). Env-канал
 * (`GIT_SSL_CAINFO`) недоступен: `sanitizeGitEnv` вырезает `git*`-env, а
 * `allowEnvironment`-guard отклоняет задачу.
 *
 * Тест перехватывает создание инстанса `simple-git` (сеть не нужна) и проверяет
 * ровно те опции, с которыми `GitService` его создаёт.
 */
const spy = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('simple-git', () => ({
  simpleGit: (...args: unknown[]) => {
    spy.calls.push(args);
    const api: Record<string, unknown> = {};
    api.env = () => api;
    api.checkIsRepo = async () => true;
    return api;
  },
}));

const { GitService } = await import('./git-service.js');
const { gitCaConfig, initTlsTrust, getTlsCaPath, _resetTlsTrustForTests } = await import(
  '../security/tls.js'
);

/** CA-фикстура (самоподписанный тестовый серт) — валидный PEM. */
const CERT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'security',
  '__fixtures__',
  'tls-test-selfsigned.pem',
);

/** Опции последнего созданного инстанса (`simpleGit(baseDir, options)` либо `(options)`). */
function lastInstanceOptions(): Record<string, unknown> {
  const args = spy.calls.at(-1);
  expect(args, 'simple-git не создавался').toBeDefined();
  return args![args!.length - 1] as Record<string, unknown>;
}

describe('git-CA (ADR-099): опции инстанса simple-git', () => {
  beforeEach(() => {
    _resetTlsTrustForTests();
    spy.calls.length = 0;
  });

  afterEach(() => {
    _resetTlsTrustForTests();
    // Возвращаем «чистый» глобальный dispatcher (initTlsTrust ставит свой).
    undici.setGlobalDispatcher(new undici.Agent());
  });

  it('без CA — опции без config: только SSH/askpass-разрешения', async () => {
    // Продакшн-путь: initTlsTrust вызывается всегда (даже без security.tls).
    await initTlsTrust(undefined, {});
    expect(getTlsCaPath()).toBeUndefined();
    expect(gitCaConfig()).toEqual([]);

    await new GitService('/ws').isRepo('/ws/repo');

    const opts = lastInstanceOptions();
    expect(opts.config).toBeUndefined();
    // GIT_UNSAFE_OPTIONS не сломаны.
    expect(opts.unsafe).toEqual({ allowUnsafeSshCommand: true, allowUnsafeAskPass: true });
    expect(opts.allowEnvironment).toEqual([
      'GIT_TERMINAL_PROMPT',
      'GIT_SSH_COMMAND',
      'SSH_ASKPASS',
      'SSH_ASKPASS_REQUIRE',
    ]);
  });

  it('caPem (PEM без файла) git-каналу недоступен — CA не подставляется', async () => {
    await initTlsTrust({ security: { tls: { caPem: readFileSync(CERT_PATH, 'utf-8') } } }, {});
    expect(getTlsCaPath()).toBeUndefined();
    expect(gitCaConfig()).toEqual([]);

    await new GitService('/ws').isRepo('/ws/repo');
    expect(lastInstanceOptions().config).toBeUndefined();
  });

  it('с security.tls.caFile — в опции попадает http.sslCAInfo=<path>', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});

    expect(getTlsCaPath()).toBe(CERT_PATH);
    expect(gitCaConfig()).toEqual([`http.sslCAInfo=${CERT_PATH}`]);

    await new GitService('/ws').isRepo('/ws/repo');

    const opts = lastInstanceOptions();
    expect(opts.config).toEqual([`http.sslCAInfo=${CERT_PATH}`]);
    // Разрешения SSH/askpass сохранены вместе с config.
    expect(opts.unsafe).toEqual({ allowUnsafeSshCommand: true, allowUnsafeAskPass: true });
    expect(opts.allowEnvironment).toContain('GIT_SSH_COMMAND');
  });

  it('инстанс без baseDir (clone) тоже получает CA', async () => {
    await initTlsTrust({ security: { tls: { caFile: CERT_PATH } } }, {});
    const service = new GitService('/ws');
    // cloneRepo создаёт инстанс без baseDir (`createGit()`).
    spy.calls.length = 0;
    try {
      await service.cloneRepo('/ws', 'repos/x', 'https://example.invalid/x.git');
    } catch {
      // git-вызов мокнут — важны только опции инстанса.
    }
    const args = spy.calls.at(-1)!;
    expect(args.length).toBe(1); // только options (без baseDir)
    expect((args[0] as Record<string, unknown>).config).toEqual([`http.sslCAInfo=${CERT_PATH}`]);
  });
});
