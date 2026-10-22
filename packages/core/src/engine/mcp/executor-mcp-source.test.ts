/**
 * ADR-077 (шаг B2): источник состава MCP-серверов пула исполнителей.
 *
 * Проверяет объединение по имени (`up`, если хотя бы один адрес отдал `up`),
 * проброс `down`/`idle`, TTL-обновление снимка, пустой/недоступный пул
 * (пустой список без исключения) и фабрику клиента.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutorMcpSource,
  createExecutorMcpSourceFromConfig,
  attachExecutorMcpSource,
  attachExecutorMcpFromDescriptor,
  EXECUTOR_MCP_SOURCE_TTL_MS,
  type ExecutorMcpManagerLike,
} from './executor-mcp-source.js';
import { ExecutorMcpClient, type ExecutorFetch } from './executor-mcp-client.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN = 'source-secret-token';

afterEach(() => {
  vi.useRealTimers();
});

describe('ExecutorMcpSource: снимок состава', () => {
  it('объединяет серверы по имени: up, если хотя бы один адрес отдал up', async () => {
    const fetchImpl: ExecutorFetch = (url) => {
      if (url.startsWith('http://a:')) {
        return Promise.resolve(
          json([
            { name: 'playwright-mcp', status: 'down', toolCount: 0, error: 'нет Chromium' },
            { name: 'scm', status: 'idle', toolCount: 0 },
          ]),
        );
      }
      return Promise.resolve(
        json([
          { name: 'playwright-mcp', status: 'up', toolCount: 25 },
          { name: 'scm', status: 'down', toolCount: 0, error: 'token invalid' },
        ]),
      );
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100', 'http://b:5100'],
      token: TOKEN,
      fetchImpl,
    });

    const servers = await source.refresh();

    expect(servers.map((server) => server.name)).toEqual(['playwright-mcp', 'scm']);
    expect(servers[0]).toMatchObject({ status: 'up', toolCount: 25, origin: 'executor' });
    expect(servers[0]!.error).toBeUndefined();
    // `scm`: up ни у кого нет, но есть down → down и причина.
    expect(servers[1]).toMatchObject({ status: 'down', origin: 'executor' });
    expect(servers[1]!.error).toContain('token invalid');
    expect(source.getServer('playwright-mcp')?.status).toBe('up');
    expect(source.getServer('unknown')).toBeUndefined();
  });

  it('idle пробрасывается, если сервер нигде не поднимался', async () => {
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl: () => Promise.resolve(json([{ name: 'scm', status: 'idle', toolCount: 0 }])),
    });
    const servers = await source.refresh();
    expect(servers).toEqual([{ name: 'scm', status: 'idle', toolCount: 0, origin: 'executor' }]);
  });

  it('пустой пул → пустой список без исключения', async () => {
    const source = new ExecutorMcpSource({ urls: [], token: TOKEN, fetchImpl: () => Promise.resolve(json([])) });
    await expect(source.refresh()).resolves.toEqual([]);
  });

  it('недоступный пул → пустой список без исключения', async () => {
    const fetchImpl: ExecutorFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const source = new ExecutorMcpSource({ urls: ['http://a:5100', 'http://b:5100'], token: TOKEN, fetchImpl });
    await expect(source.refresh()).resolves.toEqual([]);
    expect(source.listServers()).toEqual([]);
  });

  it('TTL: снимок переиспользуется до истечения и обновляется после', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let calls = 0;
    const fetchImpl: ExecutorFetch = () => {
      calls += 1;
      return Promise.resolve(json([{ name: 'playwright-mcp', status: 'up', toolCount: 1 }]));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
      ttlMs: EXECUTOR_MCP_SOURCE_TTL_MS,
    });

    await source.refresh();
    expect(calls).toBe(1);
    expect(source.isStale()).toBe(false);

    // В пределах TTL — без сетевого запроса.
    vi.advanceTimersByTime(EXECUTOR_MCP_SOURCE_TTL_MS - 1);
    await source.ensureFresh();
    expect(calls).toBe(1);

    // После TTL — обновление.
    vi.advanceTimersByTime(2);
    expect(source.isStale()).toBe(true);
    await source.ensureFresh();
    expect(calls).toBe(2);
  });

  it('createClient отдаёт ExecutorMcpClient нужного сервера', () => {
    const source = new ExecutorMcpSource({ urls: ['http://a:5100'], token: TOKEN, fetchImpl: () => Promise.resolve(json([])) });
    const client = source.createClient('playwright-mcp');
    expect(client).toBeInstanceOf(ExecutorMcpClient);
    expect(client.name).toBe('playwright-mcp');
  });

  it('close() сбрасывает снимок', async () => {
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl: () => Promise.resolve(json([{ name: 'scm', status: 'up', toolCount: 1 }])),
    });
    await source.refresh();
    expect(source.listServers()).toHaveLength(1);
    source.close();
    expect(source.closed).toBe(true);
    expect(source.listServers()).toEqual([]);
  });
});

describe('ExecutorMcpSource: подключение по execution-конфигу', () => {
  function remoteConfig(urls: string[]) {
    return {
      mode: 'remote' as const,
      remote: {
        url: urls,
        timeoutMs: 30_000,
        concurrency: 2,
        failMode: 'fail' as const,
        tokenSecret: '',
      },
    };
  }

  it('inline → источник не создаётся', async () => {
    const source = await createExecutorMcpSourceFromConfig({
      mode: 'inline',
      remote: { url: ['http://a:5100'], timeoutMs: 1, concurrency: 1, failMode: 'fail', tokenSecret: '' },
    });
    expect(source).toBeNull();
  });

  it('пустой список адресов при remote → источник не создаётся', async () => {
    const source = await createExecutorMcpSourceFromConfig(remoteConfig([]));
    expect(source).toBeNull();
  });

  it('inline: attachExecutorMcpSource не трогает менеджер', async () => {
    const manager: ExecutorMcpManagerLike = {
      setExecutorMcpSource: vi.fn(),
      refreshExecutorServers: vi.fn(),
    };
    const source = await attachExecutorMcpSource(manager, {
      mode: 'inline',
      remote: { url: ['http://a:5100'], timeoutMs: 1, concurrency: 1, failMode: 'fail', tokenSecret: '' },
    });
    expect(source).toBeNull();
    expect(manager.setExecutorMcpSource).not.toHaveBeenCalled();
    expect(manager.refreshExecutorServers).not.toHaveBeenCalled();
  });

  it('remote: источник создаётся по токену из файла и подключается к менеджеру', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-executor-mcp-'));
    const tokenPath = join(dir, 'token');
    await writeFile(tokenPath, `${TOKEN}\n`, 'utf-8');
    try {
      const manager: ExecutorMcpManagerLike = {
        setExecutorMcpSource: vi.fn(),
        refreshExecutorServers: vi.fn(async () => {}),
      };
      const source = await attachExecutorMcpSource(
        manager,
        {
          mode: 'remote',
          remote: {
            url: ['http://a:5100'],
            timeoutMs: 30_000,
            concurrency: 1,
            failMode: 'fail',
            tokenSecret: tokenPath,
          },
        },
        { fetchImpl: () => Promise.resolve(json([{ name: 'playwright-mcp', status: 'up', toolCount: 1 }])) },
      );

      expect(source).toBeInstanceOf(ExecutorMcpSource);
      expect(manager.setExecutorMcpSource).toHaveBeenCalledWith(source);
      expect(manager.refreshExecutorServers).toHaveBeenCalledTimes(1);
      // Токен не попал в публичную поверхность источника.
      expect(JSON.stringify(source?.urls)).not.toContain(TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ExecutorMcpSource: дескриптор порта исполнения (managed-backend)', () => {
  // Мок типизирован по поверхности менеджера: без явной сигнатуры `vi.fn()`
  // выводится как `Mock<Procedure | Constructable>` и не совпадает с
  // `(source: ExecutorMcpSource | null) => void` (обязательный член интерфейса).
  function fakeManager(alreadyAttached = false) {
    return {
      setExecutorMcpSource: vi.fn<(source: ExecutorMcpSource | null) => void>(),
      refreshExecutorServers: vi.fn<() => Promise<void>>(async () => {}),
      hasExecutorMcpSource: () => alreadyAttached,
    } satisfies ExecutorMcpManagerLike;
  }

  it('подключает источник по descriptor и запускает discovery', async () => {
    const manager = fakeManager();
    const source = attachExecutorMcpFromDescriptor(manager, {
      urls: ['http://a:5100'],
      token: TOKEN,
    });
    expect(source).toBeInstanceOf(ExecutorMcpSource);
    expect(manager.setExecutorMcpSource).toHaveBeenCalledWith(source);
    // Discovery — фоном (await не нужен, вызывается сразу).
    expect(manager.refreshExecutorServers).toHaveBeenCalledTimes(1);
    // Токен живёт только внутри пула (нужен для bearer-запроса) и не выходит
    // через публичную поверхность источника — адреса и снимок состава.
    // `JSON.stringify(source)` проверять нельзя: приватные поля JS-объекта
    // сериализуются, и токен «нашёлся» бы в самом пуле, а не в утечке.
    expect(source!.urls).toEqual(['http://a:5100']);
    expect(JSON.stringify({ urls: source!.urls, servers: source!.listServers() })).not.toContain(TOKEN);
  });

  it('нет дескриптора (inline) → ничего не подключается', () => {
    const manager = fakeManager();
    expect(attachExecutorMcpFromDescriptor(manager, undefined)).toBeNull();
    expect(manager.setExecutorMcpSource).not.toHaveBeenCalled();
  });

  it('пустой список адресов → ничего не подключается', () => {
    const manager = fakeManager();
    expect(attachExecutorMcpFromDescriptor(manager, { urls: ['  '], token: TOKEN })).toBeNull();
    expect(manager.setExecutorMcpSource).not.toHaveBeenCalled();
  });

  it('идемпотентно: источник уже подключён → повторный вызов no-op', () => {
    const manager = fakeManager(true);
    expect(attachExecutorMcpFromDescriptor(manager, { urls: ['http://a:5100'], token: TOKEN })).toBeNull();
    expect(manager.setExecutorMcpSource).not.toHaveBeenCalled();
  });
});
