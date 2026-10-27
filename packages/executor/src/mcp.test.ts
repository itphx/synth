import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExecutorMcpError,
  ExecutorMcpHost,
  collectMcpContent,
  type McpServerSpec,
} from './mcp.js';

/** Тестовый MCP-сервер (реальный stdio-сервер на SDK — не мок). */
const FIXTURE = fileURLToPath(new URL('../test-fixtures/mcp-stdio-server.mjs', import.meta.url));

const hosts: ExecutorMcpHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop();
    await host?.close();
  }
});

/** Описание тестового сервера. */
function spec(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    name: 'test-mcp',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    ...overrides,
  };
}

/** Хост с короткими таймаутами (тесты не должны ждать минуты). */
function makeHost(
  servers: McpServerSpec[],
  opts: { connectTimeoutMs?: number; toolTimeoutMs?: number } = {},
): ExecutorMcpHost {
  const host = new ExecutorMcpHost(servers, {
    connectTimeoutMs: opts.connectTimeoutMs ?? 5_000,
    toolTimeoutMs: opts.toolTimeoutMs ?? 5_000,
  });
  hosts.push(host);
  return host;
}

describe('MCP-хостинг исполнителя: серверы и инструменты', () => {
  it('до обращения сервер в состоянии idle, инструментов нет', () => {
    const host = makeHost([spec()]);
    const servers = host.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'test-mcp', status: 'idle', toolCount: 0 });
  });

  it('список инструментов поднимает сервер и отдаёт инструменты всех серверов', async () => {
    const host = makeHost([
      spec(),
      spec({ name: 'second-mcp', args: [FIXTURE, '--mode=normal'] }),
    ]);
    const tools = await host.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.server === 'test-mcp' || tool.server === 'second-mcp')).toBe(true);
    const echo = tools.find((tool) => tool.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.server).toBe('test-mcp');
    expect(echo?.description.length).toBeGreaterThan(0);
    expect(echo?.inputSchema).toBeTypeOf('object');
    // Серверы подняты — статус up, число инструментов совпадает.
    for (const server of host.listServers()) {
      expect(server.status).toBe('up');
      expect(server.toolCount).toBeGreaterThan(0);
    }
  });

  it('вызов инструмента возвращает результат', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'echo', { text: 'привет' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('привет');
  });

  it('неизвестный сервер — ошибка unknown_server', async () => {
    const host = makeHost([spec()]);
    await expect(host.callTool('nope', 'echo', {})).rejects.toMatchObject({
      kind: 'unknown_server',
    });
  });

  it('неизвестный инструмент — ошибка unknown_tool', async () => {
    const host = makeHost([spec()]);
    await expect(host.callTool('test-mcp', 'nope', {})).rejects.toMatchObject({
      kind: 'unknown_tool',
    });
  });

  it('упавший сервер — статус down с причиной, вызов — server_unavailable', async () => {
    const host = makeHost([spec({ args: [FIXTURE, '--mode=crash'] })]);
    await expect(host.callTool('test-mcp', 'echo', {})).rejects.toMatchObject({
      kind: 'server_unavailable',
    });
    const [server] = host.listServers();
    expect(server?.status).toBe('down');
    expect(server?.error).toBeTruthy();
    expect(server?.toolCount).toBe(0);
  });

  it('сервер, не отвечающий на handshake — таймаут подключения', async () => {
    const host = makeHost([spec({ args: [FIXTURE, '--mode=hang'] })], {
      connectTimeoutMs: 400,
    });
    await expect(host.callTool('test-mcp', 'echo', {})).rejects.toMatchObject({
      kind: 'server_unavailable',
    });
    const [server] = host.listServers();
    expect(server?.status).toBe('down');
    expect(server?.error).toMatch(/Таймаут подключения/);
  });

  it('инструмент, который не успевает — таймаут вызова', async () => {
    const host = makeHost([spec()], { toolTimeoutMs: 300 });
    await expect(
      host.callTool('test-mcp', 'slow', { sleepMs: 5_000 }),
    ).rejects.toMatchObject({ kind: 'call_failed' });
  });

  it('ошибка инструмента — isError без исключения', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'boom', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('инструмент упал');
  });

  it('длинный результат усекается до 30 000 символов', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'huge', {});
    expect(result.content.length).toBeLessThan(31_000);
    expect(result.content).toContain('усечено');
  });

  it('сервер, упавший на лету, помечается down', async () => {
    const host = makeHost([spec()]);
    await host.callTool('test-mcp', 'suicide', {});
    // Даём процессу сервера завершиться.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [server] = host.listServers();
    expect(server?.status).toBe('down');
  });

  it('упавший сервер поднимается заново при следующем обращении', async () => {
    const host = makeHost([spec()]);
    await host.callTool('test-mcp', 'suicide', {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.listServers()[0]?.status).toBe('down');
    // Следующий вызов переподнимает сервер.
    const result = await host.callTool('test-mcp', 'echo', { text: 'снова' });
    expect(result.content).toBe('снова');
    expect(host.listServers()[0]?.status).toBe('up');
  });

  it('circuit breaker: после 5 ошибок сервер не опрашивается', async () => {
    const host = makeHost([spec({ args: [FIXTURE, '--mode=crash'] })]);
    for (let i = 0; i < 5; i += 1) {
      await expect(host.callTool('test-mcp', 'echo', {})).rejects.toMatchObject({
        kind: 'server_unavailable',
      });
    }
    // Шестая попытка — сервер уже не опрашивается (circuit breaker).
    await expect(host.callTool('test-mcp', 'echo', {})).rejects.toThrow(/заблокирован/);
  });
});

describe('MCP-хостинг исполнителя: секреты', () => {
  it('значения env не попадают в текст ошибки инструмента', async () => {
    const host = makeHost([spec({ env: { TEST_SECRET: 'super-secret-value' } })]);
    const result = await host.callTool('test-mcp', 'boom', {});
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('super-secret-value');
  });

  it('значения env не попадают в статус сервера', async () => {
    const host = makeHost([spec({ env: { TEST_SECRET: 'super-secret-value' } })]);
    await host.listTools();
    const serialized = JSON.stringify(host.listServers());
    expect(serialized).not.toContain('super-secret-value');
  });
});

describe('MCP-хостинг исполнителя: жизненный цикл', () => {
  it('close() завершает дочерний процесс сервера (без утечки)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-mcp-pid-'));
    const pidFile = join(dir, 'pid');
    try {
      const host = makeHost([spec({ env: { MCP_TEST_PID_FILE: pidFile } })]);
      await host.listTools();
      const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
      expect(Number.isInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();

      await host.close();

      // Процесс должен исчезнуть (SIGTERM → завершение).
      let alive = true;
      for (let i = 0; i < 30 && alive; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('сервер без команды — понятная ошибка (не тишина)', async () => {
    const host = makeHost([spec({ command: 'synth-mcp-missing-binary-xyz' })]);
    await expect(host.callTool('test-mcp', 'echo', {})).rejects.toMatchObject({
      kind: 'server_unavailable',
    });
    const [server] = host.listServers();
    expect(server?.status).toBe('down');
    expect(server?.error).toBeTruthy();
  });
});

describe('MCP-хостинг исполнителя: pid-файл фикстуры', () => {
  it('фикстура пишет pid (проверка самого фикстуры)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-mcp-pid2-'));
    const pidFile = join(dir, 'pid');
    try {
      await writeFile(pidFile, '0', 'utf8');
      const host = makeHost([spec({ env: { MCP_TEST_PID_FILE: pidFile } })]);
      await host.listTools();
      const content = await readFile(pidFile, 'utf8');
      expect(content.trim().length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP-хостинг исполнителя: ошибки типизированы', () => {
  it('ExecutorMcpError несёт kind', () => {
    const err = new ExecutorMcpError('unknown_tool', 'нет такого');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('unknown_tool');
  });
});

// ─── ADR-115: вложения MCP-результата ──────────────────────────────────────
//
// Исполнитель не пишет блобы (у него нет каталога данных инстанса): он отдаёт
// нетекстовые блоки в base64 (`attachments`), а материализует их control plane
// (`McpManager` → `AttachmentService`). Проверяем извлечение блоков и капы.

/** Те же байты, что отдаёт фикстура (`FIXTURE_PNG_BASE64` в test-fixtures). */
const PNG_BASE64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('mcp-fixture-image'),
]).toString('base64');

describe('MCP-хостинг исполнителя: вложения (ADR-115)', () => {
  it('текст + image: текст в content, картинка во вложениях', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'shot', {});
    expect(result.isError).toBe(false);
    expect(result.content).toBe('снимок готов');
    expect(result.attachments).toEqual([{ mime: 'image/png', base64: PNG_BASE64 }]);
  });

  it('только image: content — заглушка «N вложений (текста нет)»', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'shot_only', {});
    expect(result.content).toBe('Инструмент вернул 1 вложений (текста нет)');
    expect(result.attachments).toHaveLength(1);
  });

  it('isError: вложения не собираются', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'failing_shot', {});
    expect(result.isError).toBe(true);
    expect(result.content).toBe('снимок не удался');
    expect(result.attachments).toBeUndefined();
  });

  it('resource с blob — вложение с именем из uri', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'blob_resource', {});
    expect(result.attachments).toEqual([
      { mime: 'image/png', base64: PNG_BASE64, name: 'photo.png' },
    ]);
  });

  it('resource с text — текст, а не вложение', async () => {
    const host = makeHost([spec()]);
    const result = await host.callTool('test-mcp', 'text_resource', {});
    expect(result.content).toBe('# readme');
    expect(result.attachments).toBeUndefined();
  });
});

describe('collectMcpContent: капы (ADR-115)', () => {
  const image = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });

  it('битый base64 — блок пропускается (SDK такое не пропускает, но граница своя)', () => {
    const parts = collectMcpContent([
      { type: 'image', data: 'не-base64-%%%', mimeType: 'image/png' },
      { type: 'text', text: 'текст остаётся' },
    ]);
    expect(parts.attachments).toHaveLength(0);
    expect(parts.texts).toEqual(['текст остаётся']);
  });

  it('превышение предела на файл — блок пропускается', () => {
    const parts = collectMcpContent([image(PNG_BASE64)], { maxBytesPerFile: 4 });
    expect(parts.attachments).toHaveLength(0);
  });

  it('суммарный предел — лишние блоки пропускаются', () => {
    const size = Buffer.from(PNG_BASE64, 'base64').length;
    const parts = collectMcpContent([image(PNG_BASE64), image(PNG_BASE64)], {
      maxTotalBytes: size + 1,
    });
    expect(parts.attachments).toHaveLength(1);
  });

  it('неизвестный тип блока игнорируется', () => {
    const parts = collectMcpContent([{ type: 'resource_link', uri: 'file:///x' }, image(PNG_BASE64)]);
    expect(parts.texts).toEqual([]);
    expect(parts.attachments).toHaveLength(1);
  });
});
