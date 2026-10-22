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
  EXECUTOR_MCP_SOURCE_RETRY_MS,
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

  it('idle больше не пробрасывается: сервер активируется, и если он не поднялся — down с причиной', async () => {
    // Контракт изменился осознанно: `idle` = «ещё не поднят» (ленивый старт
    // исполнителя), а не «недоступен» — источник активирует сервер вызовом
    // `/mcp/tools`. Если исполнитель и после этого не поднял сервер, тот
    // помечается `down` с причиной (иначе он «залипает» в `idle` до конца TTL
    // и выглядит как «ещё не поднят», хотя исполнитель его не отдаёт).
    const calls: string[] = [];
    const fetchImpl: ExecutorFetch = (url) => {
      calls.push(url);
      if (url.endsWith('/mcp/servers')) {
        return Promise.resolve(json([{ name: 'scm', status: 'idle', toolCount: 0 }]));
      }
      return Promise.resolve(json([]));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
    });
    const servers = await source.refresh();
    // Активация выполнена (`/mcp/tools`), состояние перечитано (`/mcp/servers`).
    expect(calls.filter((url) => url.endsWith('/mcp/tools'))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith('/mcp/servers'))).toHaveLength(2);
    expect(servers).toEqual([
      {
        name: 'scm',
        status: 'down',
        toolCount: 0,
        origin: 'executor',
        error: 'сервер не поднялся после активации (/mcp/tools)',
      },
    ]);
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

/**
 * Ленивый старт исполнителя (ADR-077, шаг B1/B2): `GET /mcp/servers` только
 * показывает состояние, а поднимает серверы `GET /mcp/tools`.
 *
 * `idle` = «ещё не поднят», а не «недоступен»: источник активирует сервер и
 * перечитывает состояние. Без этого первый ход агента после раскатки
 * исполнителя уходил без браузерных инструментов (тулы появлялись только к
 * следующему ходу, по TTL источника).
 */
describe('ExecutorMcpSource: активация сервера в статусе idle', () => {
  it('idle → источник активирует сервер через /mcp/tools и перечитывает состояние ⇒ up', async () => {
    const calls: string[] = [];
    let started = false;
    const fetchImpl: ExecutorFetch = (url) => {
      calls.push(url);
      if (url.endsWith('/mcp/servers')) {
        return Promise.resolve(
          json([
            started
              ? { name: 'playwright-mcp', status: 'up', toolCount: 25 }
              : { name: 'playwright-mcp', status: 'idle', toolCount: 0 },
          ]),
        );
      }
      // `/mcp/tools` — триггер ленивого старта: сервер поднимается.
      started = true;
      return Promise.resolve(
        json([
          {
            server: 'playwright-mcp',
            name: 'browser_navigate',
            description: 'Открыть URL',
            inputSchema: { type: 'object' },
          },
        ]),
      );
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
    });

    const servers = await source.refresh();

    // Активация выполнена, состояние перечитано.
    expect(calls.filter((url) => url.endsWith('/mcp/tools'))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith('/mcp/servers'))).toHaveLength(2);
    // Сервер поднят — в снимке `up`, а не «недоступен».
    expect(servers).toEqual([
      { name: 'playwright-mcp', status: 'up', toolCount: 25, origin: 'executor' },
    ]);
    expect(source.getServer('playwright-mcp')?.status).toBe('up');
  });

  it('idle у одного адреса и up у другого → в снимке up (лучшее состояние), активация не нужна', async () => {
    const calls: string[] = [];
    const fetchImpl: ExecutorFetch = (url) => {
      calls.push(url);
      if (url.startsWith('http://a:')) {
        return Promise.resolve(json([{ name: 'playwright-mcp', status: 'idle', toolCount: 0 }]));
      }
      return Promise.resolve(json([{ name: 'playwright-mcp', status: 'up', toolCount: 25 }]));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100', 'http://b:5100'],
      token: TOKEN,
      fetchImpl,
    });

    const servers = await source.refresh();

    expect(servers).toEqual([
      { name: 'playwright-mcp', status: 'up', toolCount: 25, origin: 'executor' },
    ]);
    // Состав уже `up` — лишних вызовов `/mcp/tools` не делаем.
    expect(calls.filter((url) => url.endsWith('/mcp/tools'))).toHaveLength(0);
  });

  it('ошибка активации → сервер down с причиной, остальные серверы не потеряны, снимок не пустой', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl: ExecutorFetch = (url) => {
      if (url.endsWith('/mcp/servers')) {
        return Promise.resolve(
          json([
            { name: 'playwright-mcp', status: 'idle', toolCount: 0 },
            { name: 'scm', status: 'up', toolCount: 3 },
          ]),
        );
      }
      // Активация не удалась (исполнитель ответил 500).
      return Promise.resolve(json({ error: { message: 'boom' } }, 500));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
    });

    const servers = await source.refresh();

    // Снимок не пустой: рабочий сервер на месте.
    expect(servers.map((server) => server.name)).toEqual(['playwright-mcp', 'scm']);
    expect(servers[1]).toMatchObject({ name: 'scm', status: 'up', toolCount: 3 });
    // Неактивированный сервер — `down` с причиной (не потерян молча).
    expect(servers[0]).toMatchObject({ name: 'playwright-mcp', status: 'down' });
    expect(servers[0]!.error).toContain('активация не удалась');
    expect(servers[0]!.error).toContain('500');
    warn.mockRestore();
  });

  it('после неудачной активации — повтор через retryMs (15 с), а не через TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let calls = 0;
    let healthy = false;
    const fetchImpl: ExecutorFetch = (url) => {
      if (url.endsWith('/mcp/servers')) {
        calls += 1;
        return Promise.resolve(
          json([
            healthy
              ? { name: 'playwright-mcp', status: 'up', toolCount: 25 }
              : { name: 'playwright-mcp', status: 'idle', toolCount: 0 },
          ]),
        );
      }
      // Пока сервер не починен — активация падает.
      return healthy ? Promise.resolve(json([])) : Promise.reject(new Error('ECONNRESET'));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
      ttlMs: EXECUTOR_MCP_SOURCE_TTL_MS,
      retryMs: EXECUTOR_MCP_SOURCE_RETRY_MS,
    });

    await source.refresh();
    expect(calls).toBe(1);

    // В пределах паузы повтора нет (даже TTL ещё не истёк).
    vi.advanceTimersByTime(EXECUTOR_MCP_SOURCE_RETRY_MS - 1);
    expect(source.isStale()).toBe(false);
    await source.ensureFresh();
    expect(calls).toBe(1);

    // Пауза истекла → повтор (не ждём TTL).
    healthy = true;
    vi.advanceTimersByTime(2);
    expect(source.isStale()).toBe(true);
    await source.ensureFresh();
    expect(calls).toBe(2);
    expect(source.getServer('playwright-mcp')?.status).toBe('up');
  });

  it('успешный пустой ответ → без активации, повтор по TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let toolCalls = 0;
    const fetchImpl: ExecutorFetch = (url) => {
      if (url.endsWith('/mcp/tools')) {
        toolCalls += 1;
        return Promise.resolve(json([]));
      }
      return Promise.resolve(json([]));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
      ttlMs: EXECUTOR_MCP_SOURCE_TTL_MS,
      retryMs: EXECUTOR_MCP_SOURCE_RETRY_MS,
    });

    await expect(source.refresh()).resolves.toEqual([]);
    // Активации нет: серверов нет — активировать нечего.
    expect(toolCalls).toBe(0);

    // Пустой ответ — валидный снимок: действует TTL, а не пауза.
    vi.advanceTimersByTime(EXECUTOR_MCP_SOURCE_RETRY_MS + 1);
    expect(source.isStale()).toBe(false);
    await source.ensureFresh();
    expect(toolCalls).toBe(0);
  });
});

/**
 * Гонка раскатки: backend поднимается раньше нового пода исполнителя и получает
 * 404. Полный TTL (120 с) на неудачу означал бы «нет MCP-инструментов» на две
 * минуты после того, как исполнитель уже отвечает, поэтому неудача даёт короткую
 * паузу, а успех (в т.ч. пустой снимок) — обычный TTL.
 */
describe('ExecutorMcpSource: восстановление после неудачного discovery', () => {
  const TTL = EXECUTOR_MCP_SOURCE_TTL_MS;
  const RETRY = EXECUTOR_MCP_SOURCE_RETRY_MS;

  function playwrightList() {
    return [{ name: 'playwright-mcp', status: 'up', toolCount: 25 }];
  }

  /** Сценарий «сначала неудача, потом исполнитель поднялся». */
  async function expectRetryAfterFailure(fail: () => Promise<Response>): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let calls = 0;
    let healthy = false;
    const fetchImpl: ExecutorFetch = () => {
      calls += 1;
      return healthy ? Promise.resolve(json(playwrightList())) : fail();
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
      ttlMs: TTL,
      retryMs: RETRY,
    });

    await expect(source.refresh()).resolves.toEqual([]);
    expect(calls).toBe(1);

    // Пауза, а не TTL: в пределах `retryMs` повторной попытки нет.
    vi.advanceTimersByTime(RETRY - 1);
    expect(source.isStale()).toBe(false);
    await source.ensureFresh();
    expect(calls).toBe(1);

    // Пауза истекла → повтор, и исполнитель уже отвечает.
    healthy = true;
    vi.advanceTimersByTime(2);
    expect(source.isStale()).toBe(true);
    await source.ensureFresh();
    expect(calls).toBe(2);
    expect(source.listServers().map((server) => server.name)).toEqual(['playwright-mcp']);
  }

  it('404 от исполнителя → повтор через retryMs, а не через TTL', async () => {
    await expectRetryAfterFailure(() => Promise.resolve(json({ error: { message: 'not found' } }, 404)));
  });

  it('сеть недоступна → повтор через retryMs, а не через TTL', async () => {
    await expectRetryAfterFailure(() => Promise.reject(new Error('ECONNREFUSED')));
  });

  it('успешный пустой ответ → повтор только по TTL (пустой снимок валиден)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let calls = 0;
    const fetchImpl: ExecutorFetch = () => {
      calls += 1;
      return Promise.resolve(json([]));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
      ttlMs: TTL,
      retryMs: RETRY,
    });

    await expect(source.refresh()).resolves.toEqual([]);
    expect(calls).toBe(1);

    // Ответ получен (пусть и пустой) — паузы нет, действует полный TTL.
    vi.advanceTimersByTime(RETRY + 1);
    expect(source.isStale()).toBe(false);
    await source.ensureFresh();
    expect(calls).toBe(1);

    vi.advanceTimersByTime(TTL - RETRY);
    expect(source.isStale()).toBe(true);
    await source.ensureFresh();
    expect(calls).toBe(2);
  });

  it('успех после неудачи сбрасывает паузу: дальше действует TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    let calls = 0;
    let healthy = false;
    const fetchImpl: ExecutorFetch = () => {
      calls += 1;
      if (!healthy) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(json(playwrightList()));
    };
    const source = new ExecutorMcpSource({
      urls: ['http://a:5100'],
      token: TOKEN,
      fetchImpl,
      ttlMs: TTL,
      retryMs: RETRY,
    });

    await source.refresh();
    healthy = true;
    vi.advanceTimersByTime(RETRY);
    await source.ensureFresh();
    expect(calls).toBe(2);

    // Пауза снята: следующий повтор — только по TTL от успешного снимка.
    vi.advanceTimersByTime(RETRY);
    expect(source.isStale()).toBe(false);
    await source.ensureFresh();
    expect(calls).toBe(2);

    vi.advanceTimersByTime(TTL - RETRY);
    expect(source.isStale()).toBe(true);
  });
});

describe('ExecutorMcpSource: подключение по execution-конфигу', () => {  function remoteConfig(urls: string[]) {
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
