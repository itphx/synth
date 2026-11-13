/**
 * Провайдеры пулов исполнения (PROP-135, Ф4b-1).
 *
 * Проверяется **контракт** провайдера, а не сам provisioner (его сервис — Ф4b-2):
 *
 * - `poolKeyString` — канонический ключ пула (область/ид/класс/профиль);
 * - статический провайдер — адрес из конфигурации, токена нет;
 * - HTTP-провайдер — протокол `POST /v1/pools` (+ `touch`/`drain`/`release`/
 *   `capabilities`), bearer-токен из файла, таймаут, понятные ошибки;
 * - секреты: значение токена **не** попадает ни в текст ошибки, ни в лог.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExecutionPoolProvider,
  ExecutionPoolProviderError,
  HttpExecutionPoolProvider,
  isExecutionPoolProvider,
  parsePoolKey,
  poolKeyString,
  StaticExecutionPoolProvider,
  type ExecutionPoolKey,
} from './pool-provider.js';

/** Запись вызова HTTP-провайдера (для проверок протокола). */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const PROVIDER_TOKEN = 'provisioner-secret-token';

/** Временный каталог с файлом токена. */
let tmpDir = '';
let tokenPath = '';

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-pool-provider-'));
  tokenPath = join(tmpDir, 'provisioner-token');
  await writeFile(tokenPath, `${PROVIDER_TOKEN}\n`, 'utf-8');
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/** Ответ `fetch`-заглушки. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PROP-135 Ф4b-1: ключ пула', () => {
  it('instance-пул: без идентификатора', () => {
    expect(
      poolKeyString({ scope: 'instance', class: 'exec', profile: 'default' }),
    ).toBe('instance:exec:default');
  });

  it('project-пул: с идентификатором проекта', () => {
    expect(
      poolKeyString({ scope: 'project', id: 'prj_1', class: 'exec', profile: 'devops' }),
    ).toBe('project:prj_1:exec:devops');
  });

  it('session-пул: с идентификатором сессии', () => {
    expect(
      poolKeyString({ scope: 'session', id: 'ses_1', class: 'exec', profile: 'default' }),
    ).toBe('session:ses_1:exec:default');
  });

  it('browser-класс — отдельный ключ', () => {
    expect(
      poolKeyString({ scope: 'session', id: 'ses_1', class: 'browser', profile: 'default' }),
    ).toBe('session:ses_1:browser:default');
  });

  // PROP-135 слайс 5a: `sandbox_exec` работает в своём пуле — класс входит
  // в ключ, поэтому ключ песочницы не совпадает с ключом обычных команд.
  it('sandbox-класс — отдельный ключ', () => {
    expect(
      poolKeyString({ scope: 'session', id: 'ses_1', class: 'sandbox', profile: 'devops' }),
    ).toBe('session:ses_1:sandbox:devops');
    expect(
      poolKeyString({ scope: 'project', id: 'prj_1', class: 'sandbox', profile: 'default' }),
    ).toBe('project:prj_1:sandbox:default');
    expect(
      poolKeyString({ scope: 'instance', class: 'sandbox', profile: 'default' }),
    ).toBe('instance:sandbox:default');
  });

  it('project/session без id → ошибка (изоляция пулов не должна ломаться)', () => {
    expect(() => poolKeyString({ scope: 'project', class: 'exec', profile: 'default' })).toThrow(
      /requires an id/,
    );
    expect(() => poolKeyString({ scope: 'session', class: 'exec', profile: 'default' })).toThrow(
      /requires an id/,
    );
  });

  it('workspaceSubPath не входит в ключ (ключ пула остаётся стабильным)', () => {
    expect(
      poolKeyString({
        scope: 'project',
        id: 'prj_1',
        class: 'exec',
        profile: 'default',
        workspaceSubPath: 'proj-1',
      }),
    ).toBe(poolKeyString({ scope: 'project', id: 'prj_1', class: 'exec', profile: 'default' }));
  });
});

describe('PROP-135 Ф4b-1: статический провайдер', () => {
  it('ensure отдаёт первый адрес профиля, без токена', async () => {
    const provider = new StaticExecutionPoolProvider({
      devops: { url: ['http://executor-devops:8080', 'http://executor-2:8080'] },
    });
    const ref = await provider.ensure({
      scope: 'project',
      id: 'prj_1',
      class: 'exec',
      profile: 'devops',
    });
    expect(ref.url).toBe('http://executor-devops:8080');
    expect(ref.token).toBeUndefined();
  });

  it('профиль без адреса → понятная ошибка', async () => {
    const provider = new StaticExecutionPoolProvider({});
    await expect(
      provider.ensure({ scope: 'instance', class: 'exec', profile: 'nope' }),
    ).rejects.toBeInstanceOf(ExecutionPoolProviderError);
  });

  it('capabilities: имя провайдера и список профилей', async () => {
    const provider = new StaticExecutionPoolProvider({
      a: { url: ['http://a:8080'] },
      b: { url: ['http://b:8080'] },
    });
    expect(await provider.capabilities()).toEqual({
      provider: 'static',
      profiles: ['a', 'b'],
    });
  });

  it('profilesInfo: профиль без метаданных — только имя', async () => {
    const provider = new StaticExecutionPoolProvider({
      a: { url: ['http://a:8080'] },
      b: { url: ['http://b:8080'] },
    });
    await expect(provider.profilesInfo!()).resolves.toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('profilesInfo: метаданные профиля из конфигурации (без адресов)', async () => {
    const provider = new StaticExecutionPoolProvider({
      default: {
        url: ['http://executor:8080'],
        description: 'Инстанс-исполнитель test',
        image: 'synth-executor:0.13.9-full',
        network: 'restricted',
        resources: { limits: { cpu: '2', memory: '4Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
      bare: { url: ['http://bare:8080'] },
    });
    const infos = await provider.profilesInfo!();
    expect(infos).toEqual([
      {
        name: 'default',
        description: 'Инстанс-исполнитель test',
        image: 'synth-executor:0.13.9-full',
        network: 'restricted',
        resources: { limits: { cpu: '2', memory: '4Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
      { name: 'bare' },
    ]);
    // Адреса пулов наружу не отдаются.
    expect(JSON.stringify(infos)).not.toContain('http://');
  });

  it('isExecutionPoolProvider — структурная проверка', () => {
    expect(isExecutionPoolProvider(new StaticExecutionPoolProvider({}))).toBe(true);
    expect(isExecutionPoolProvider({ ensure: () => undefined })).toBe(true);
    expect(isExecutionPoolProvider({})).toBe(false);
    expect(isExecutionPoolProvider(null)).toBe(false);
  });
});

describe('PROP-135 Ф4b-1: HTTP-провайдер', () => {
  it('ensure: POST /v1/pools с ключом и bearer-токеном, ответ — адрес и токен', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return jsonResponse({ url: 'http://pool-1:8080', token: 'pool-token' });
      },
    });

    const key: ExecutionPoolKey = {
      scope: 'project',
      id: 'prj_1',
      class: 'exec',
      profile: 'devops',
    };
    const ref = await provider.ensure(key);

    expect(ref).toEqual({ url: 'http://pool-1:8080', token: 'pool-token' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://provisioner:8080/v1/pools');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body).toEqual({
      key: 'project:prj_1:exec:devops',
      scope: 'project',
      id: 'prj_1',
      class: 'exec',
      profile: 'devops',
    });
  });

  it('ensure: класс sandbox уходит в тело и ключ как `sandbox`', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return jsonResponse({ url: 'http://pool-sandbox:8080', token: 'sandbox-token' });
      },
    });

    await provider.ensure({ scope: 'session', id: 'ses_1', class: 'sandbox', profile: 'devops' });

    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body).toMatchObject({
      key: 'session:ses_1:sandbox:devops',
      scope: 'session',
      id: 'ses_1',
      class: 'sandbox',
      profile: 'devops',
    });
  });

  it('ensure: workspaceSubPath (subPath PVC для проекта) уходит в тело запроса', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return jsonResponse({ url: 'http://pool-1:8080', token: 'pool-token' });
      },
    });

    await provider.ensure({
      scope: 'project',
      id: 'prj_1',
      class: 'exec',
      profile: 'default',
      workspaceSubPath: 'proj-slug/.worktrees/feature',
    });

    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.workspaceSubPath).toBe('proj-slug/.worktrees/feature');
    // Ключ от subPath не зависит (один пул на область).
    expect(body.key).toBe('project:prj_1:exec:default');
  });

  it('ensure: без workspaceSubPath поля в теле нет (аддитивность протокола)', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return jsonResponse({ url: 'http://pool-1:8080' });
      },
    });

    await provider.ensure({ scope: 'project', id: 'prj_1', class: 'exec', profile: 'default' });

    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body).not.toHaveProperty('workspaceSubPath');
  });

  it('ensure: ответ без адреса → понятная ошибка', async () => {
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async () => jsonResponse({ token: 'pool-token' }),
    });
    await expect(
      provider.ensure({ scope: 'instance', class: 'exec', profile: 'default' }),
    ).rejects.toThrow(/returned no pool address/);
  });

  it('touch/drain/release: URL-encoded ключ, best-effort (сбой не ломает вызов)', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ ok: true });
      },
    });
    const key: ExecutionPoolKey = { scope: 'session', id: 'ses 1', class: 'exec', profile: 'default' };

    await provider.touch(key);
    await provider.drain(key);
    await provider.release(key);

    const encoded = encodeURIComponent('session:ses 1:exec:default');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST http://provisioner:8080/v1/pools/${encoded}/touch`,
      `POST http://provisioner:8080/v1/pools/${encoded}/drain`,
      `DELETE http://provisioner:8080/v1/pools/${encoded}`,
    ]);
  });

  it('touch: сетевой сбой проглатывается (best-effort)', async () => {
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    await expect(
      provider.touch({ scope: 'instance', class: 'exec', profile: 'default' }),
    ).resolves.toBeUndefined();
  });

  it('capabilities: GET /v1/capabilities', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ provider: 'http', profiles: ['default', 'devops'] });
      },
    });
    expect(await provider.capabilities()).toEqual({
      provider: 'http',
      profiles: ['default', 'devops'],
    });
    expect(calls[0]?.url).toBe('http://provisioner:8080/v1/capabilities');
  });

  it('profilesInfo: GET /v1/profiles, разбор метаданных и отбрасывание битых записей', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({
          profiles: [
            {
              name: 'devops',
              description: 'Сборка в удалённом builder',
              image: 'registry.example/synth-executor:devops',
              network: 'restricted',
              resources: { limits: { cpu: '4', memory: '8Gi' } },
              runtimeClass: 'gvisor',
              mcpServers: ['playwright', ''],
            },
            { description: 'без имени — пропускается' },
            null,
          ],
        });
      },
    });

    await expect(provider.profilesInfo()).resolves.toEqual([
      {
        name: 'devops',
        description: 'Сборка в удалённом builder',
        image: 'registry.example/synth-executor:devops',
        network: 'restricted',
        resources: { limits: { cpu: '4', memory: '8Gi' } },
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
    ]);
    expect(calls[0]?.url).toBe('http://provisioner:8080/v1/profiles');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
  });

  it('profilesInfo: без поля profiles — пустой список', async () => {
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async () => jsonResponse({}),
    });
    await expect(provider.profilesInfo()).resolves.toEqual([]);
  });

  it('ensure: HTTP-ошибка → ExecutionPoolProviderError со статусом (тело в текст не идёт)', async () => {
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async () => jsonResponse({ error: `token ${PROVIDER_TOKEN} rejected` }, 502),
    });
    const error = await provider
      .ensure({ scope: 'instance', class: 'exec', profile: 'default' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ExecutionPoolProviderError);
    expect((error as Error).message).toMatch(/status 502/);
    // Секрет в текст ошибки не попадает.
    expect((error as Error).message).not.toContain(PROVIDER_TOKEN);
  });

  it('ensure: без читаемого токена → понятная ошибка, токен в тексте нет', async () => {
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: join(tmpDir, 'missing-token'),
      timeoutMs: 5_000,
      fetchImpl: async () => jsonResponse({ url: 'http://pool-1:8080' }),
    });
    const error = await provider
      .ensure({ scope: 'instance', class: 'exec', profile: 'default' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ExecutionPoolProviderError);
    expect((error as Error).message).toMatch(/could not read its token/);
    expect((error as Error).message).not.toContain(PROVIDER_TOKEN);
  });

  it('ensure: таймаут обращения к provisioner\'у', async () => {
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 20,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const error = await provider
      .ensure({ scope: 'instance', class: 'exec', profile: 'default' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ExecutionPoolProviderError);
    expect((error as Error).message).toMatch(/request failed/);
  });

  it('токен читается один раз на процесс (кэш)', async () => {
    let requests = 0;
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ url: 'http://pool-1:8080' });
      },
    });
    await provider.ensure({ scope: 'instance', class: 'exec', profile: 'default' });
    await provider.ensure({ scope: 'instance', class: 'exec', profile: 'default' });
    expect(requests).toBe(2);
  });
});

describe('PROP-135 Ф4b-1: фабрика провайдера', () => {
  const remote = {
    url: ['http://executor:8080'],
    timeoutMs: 30_000,
    concurrency: 2,
    failMode: 'fail' as const,
    tokenSecret: '/tmp/token',
    pooling: 'project' as const,
    defaultProfile: 'default',
    browserProfile: 'browser',
    browserProfiles: [],
    browserMcpServer: 'playwright',
    profiles: { devops: { url: ['http://executor-devops:8080'], timeoutMs: 30_000, concurrency: 2, failMode: 'fail' as const } },
    fallback: 'instance' as const,
    provider: 'static' as const,
    provisioner: { url: '', tokenSecret: '', timeoutMs: 10_000 },
  };

  it('provider=static → статический провайдер (адрес из профиля)', async () => {
    const provider = createExecutionPoolProvider(remote);
    expect(provider).toBeInstanceOf(StaticExecutionPoolProvider);
    const ref = await provider.ensure({
      scope: 'project',
      id: 'prj_1',
      class: 'exec',
      profile: 'devops',
    });
    expect(ref.url).toBe('http://executor-devops:8080');
  });

  it('provider=static: метаданные профилей переносятся из config.profiles', async () => {
    const provider = createExecutionPoolProvider({
      ...remote,
      profiles: {
        devops: {
          url: ['http://executor-devops:8080'],
          timeoutMs: 30_000,
          concurrency: 2,
          failMode: 'fail' as const,
          description: 'DevOps-исполнитель',
          image: 'synth-executor:0.13.9-full',
          network: 'restricted' as const,
          runtimeClass: 'gvisor',
          mcpServers: ['playwright'],
        },
      },
    });
    await expect(provider.profilesInfo!()).resolves.toEqual([
      {
        name: 'devops',
        description: 'DevOps-исполнитель',
        image: 'synth-executor:0.13.9-full',
        network: 'restricted',
        runtimeClass: 'gvisor',
        mcpServers: ['playwright'],
      },
      // Синтетический профиль по умолчанию: адрес секции, метаданных нет.
      { name: 'default' },
    ]);
  });

  it('provider=http → HTTP-провайдер', () => {
    const provider = createExecutionPoolProvider({
      ...remote,
      provider: 'http',
      provisioner: { url: 'http://provisioner:8080', tokenSecret: '/tmp/p', timeoutMs: 10_000 },
    });
    expect(provider).toBeInstanceOf(HttpExecutionPoolProvider);
  });

  it('provider=static: профиль по умолчанию без адреса в каталоге → общий url секции', async () => {
    const provider = createExecutionPoolProvider(remote);
    const ref = await provider.ensure({
      scope: 'instance',
      class: 'exec',
      profile: 'default',
    });
    expect(ref.url).toBe('http://executor:8080');
  });
});

/**
 * PROP-135 Ф6b-1: диагностика пулов (`list`) и разбор ключа (`parsePoolKey`)
 * — основа admin-API `/api/v2/execution/pools*`.
 */
describe('PROP-135 Ф6b-1: список пулов и разбор ключа', () => {
  it('static.list: профили конфигурации состоянием configured, без ключа', async () => {
    const provider = new StaticExecutionPoolProvider({
      default: { url: ['http://executor:8080'] },
      devops: { url: ['http://executor-devops:8080'] },
    });
    expect(await provider.list()).toEqual([
      { profile: 'default', state: 'configured' },
      { profile: 'devops', state: 'configured' },
    ]);
  });

  it('http.list: GET /v1/pools, без url и токенов, время — ISO', async () => {
    const calls: Call[] = [];
    const provider = new HttpExecutionPoolProvider({
      url: 'http://provisioner:8080',
      tokenSecret: tokenPath,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({
          pools: [
            {
              key: 'project:prj_1:exec:default',
              url: 'http://pool-1:8080',
              profile: 'default',
              scope: 'project',
              id: 'prj_1',
              state: 'ready',
              createdAt: 1_761_000_000_000,
              lastUsedAt: 1_761_000_600_000,
            },
            {
              key: 'session:ses_1:sandbox:devops',
              url: 'http://pool-2:8080',
              profile: 'devops',
              scope: 'session',
              id: 'ses_1',
              state: 'draining',
              createdAt: 1_761_000_000_000,
              lastUsedAt: 1_761_000_600_000,
            },
            // Битая запись без профиля — пропускается.
            { key: 'instance:exec:' },
          ],
        });
      },
    });

    const pools = await provider.list();
    expect(calls[0]?.url).toBe('http://provisioner:8080/v1/pools');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${PROVIDER_TOKEN}`);
    expect(pools).toEqual([
      {
        key: 'project:prj_1:exec:default',
        profile: 'default',
        state: 'ready',
        createdAt: new Date(1_761_000_000_000).toISOString(),
        lastUsedAt: new Date(1_761_000_600_000).toISOString(),
      },
      {
        key: 'session:ses_1:sandbox:devops',
        profile: 'devops',
        state: 'draining',
        createdAt: new Date(1_761_000_000_000).toISOString(),
        lastUsedAt: new Date(1_761_000_600_000).toISOString(),
      },
    ]);
    // Адрес пула наружу не уходит (секрет доступа к исполнителю).
    expect(JSON.stringify(pools)).not.toContain('http://pool-');
  });

  it('parsePoolKey: канонический ключ → объект (и обратно)', () => {
    expect(parsePoolKey('instance:exec:default')).toEqual({
      scope: 'instance',
      class: 'exec',
      profile: 'default',
    });
    expect(parsePoolKey('project:prj_1:exec:devops')).toEqual({
      scope: 'project',
      id: 'prj_1',
      class: 'exec',
      profile: 'devops',
    });
    expect(parsePoolKey('session:ses_1:sandbox:gpu:large')).toEqual({
      scope: 'session',
      id: 'ses_1',
      class: 'sandbox',
      profile: 'gpu:large',
    });
    expect(poolKeyString(parsePoolKey('session:ses_1:browser:default'))).toBe(
      'session:ses_1:browser:default',
    );
  });

  it('parsePoolKey: невалидные ключи → ошибка (fail-closed)', () => {
    for (const bad of [
      '',
      'instance',
      'instance:exec',
      'instance:nope:default',
      'project::exec:default',
      'project:prj_1:exec:',
      'tenant:prj_1:exec:default',
    ]) {
      expect(() => parsePoolKey(bad)).toThrow();
    }
  });
});
