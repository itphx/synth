/**
 * ADR-077 (шаг B2) — интеграционный тест на **живом** исполнителе.
 *
 * Проверяет всю цепочку, которую не видно на моках:
 *
 * `ExecutorMcpSource` (discovery состава) → `McpManager` (runtime-запись,
 * регистрация тулов `{server}_{tool}`, `source:'mcp'`) → `ToolRegistry` →
 * HTTP API исполнителя (`/mcp/tools`, `/mcp/call`) → Playwright MCP-сервер
 * (`playwright-mcp`) → настоящий Chromium.
 *
 * Гейт по env (как контрактный suite хранения с `SYNTH_TEST_POSTGRES_DSN`):
 * без `SYNTH_TEST_EXECUTOR_MCP_URL`/`SYNTH_TEST_EXECUTOR_MCP_TOKEN` весь файл
 * пропускается — обычный `pnpm test` контейнер не требует.
 *
 * Запуск (образ `synth-executor:b1-final` — дефолт
 * `SYNTH_EXECUTOR_MCP_SERVERS` указывает на `playwright-mcp`):
 *
 * ```bash
 * docker run -d --rm -p 127.0.0.1:5100:5100 \
 *   -e SYNTH_EXECUTOR_TOKEN="$TOKEN" \
 *   -e SYNTH_EXECUTOR_WORKSPACE=/workspace \
 *   synth-executor:b1-final
 * SYNTH_TEST_EXECUTOR_MCP_URL=http://127.0.0.1:5100 \
 * SYNTH_TEST_EXECUTOR_MCP_TOKEN="$TOKEN" \
 *   pnpm --filter @itphx/synth-core exec vitest run src/engine/mcp/executor-mcp.e2e.test.ts
 * ```
 *
 * Токен **не** печатается и в отчёт не попадает.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpManager } from './manager.js';
import { ExecutorMcpSource } from './executor-mcp-source.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '@itphx/synth-shared';

const URL_ENV = 'SYNTH_TEST_EXECUTOR_MCP_URL';
const TOKEN_ENV = 'SYNTH_TEST_EXECUTOR_MCP_TOKEN';

const executorUrl = process.env[URL_ENV]?.trim();
const executorToken = process.env[TOKEN_ENV]?.trim();
const live = executorUrl !== undefined && executorUrl.length > 0
  && executorToken !== undefined && executorToken.length > 0;

/** Живой контейнер отвечает медленнее мока: браузер стартует лениво. */
const LIVE_TIMEOUT_MS = 120_000;

/** Сервер, который поднимает образ исполнителя (дефолт `SYNTH_EXECUTOR_MCP_SERVERS`). */
const SERVER = 'playwright-mcp';

/** Контекст вызова тула: сессии и менеджер обфускации не нужны. */
function toolContext(): ToolContext {
  return { sessionId: 'e2e-executor-mcp', extra: {} } as unknown as ToolContext;
}

describe.skipIf(!live)(`ExecutorMcpSource + McpManager: живой исполнитель (${URL_ENV})`, () => {
  let source: ExecutorMcpSource;
  let manager: McpManager;
  let registry: ToolRegistry;

  beforeAll(async () => {
    // Реальные объекты: ни моков транспорта, ни подмены клиента.
    source = new ExecutorMcpSource({ urls: [executorUrl!], token: executorToken! });
    manager = new McpManager();
    manager.setExecutorMcpSource(source);

    await manager.refreshExecutorServers();
    registry = new ToolRegistry();
    await manager.ensureToolsLoaded([SERVER], registry);
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await manager?.disconnectAll();
    source?.close();
  });

  it('сервер playwright-mcp виден в снимке состава исполнителя', async () => {
    const servers = source.listServers();
    const server = servers.find((item) => item.name === SERVER);

    expect(server, `состав исполнителя: ${JSON.stringify(servers)}`).toBeDefined();
    expect(server!.origin).toBe('executor');
    expect(manager.isExecutorServer(SERVER)).toBe(true);
    expect(manager.getExecutorServerNames()).toContain(SERVER);

    const refreshed = (await source.refresh()).find((item) => item.name === SERVER);

    // Первый discovery шёл до ленивого старта браузера, поэтому в снимке
    // `idle`; явный refresh (минуя TTL 120 с) должен увидеть поднятый сервер.
    expect(refreshed, `состав после refresh: ${JSON.stringify(source.listServers())}`).toBeDefined();
    expect(refreshed!.status).toBe('up');
    expect(refreshed!.toolCount).toBeGreaterThan(0);
  });

  it('тулы зарегистрированы в ToolRegistry как playwright-mcp_* с source=mcp', () => {
    const tools = registry.list().filter((tool) => tool.mcpServer === SERVER);

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name.startsWith(`${SERVER}_`)).toBe(true);
      expect(tool.source).toBe('mcp');
    }
    expect(registry.get(`${SERVER}_browser_navigate`)?.source).toBe('mcp');
    expect(registry.get(`${SERVER}_browser_evaluate`)?.source).toBe('mcp');
  });

  it('browser_navigate открывает data:-страницу через исполнителя', async () => {
    const tool = registry.get(`${SERVER}_browser_navigate`);
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { url: 'data:text/html,<h1>e2e-ok</h1>' },
      toolContext(),
    );

    expect(result.isError, `ответ: ${result.content}`).toBe(false);
    // В ответе — URL открытой страницы (навигация действительно выполнена).
    expect(result.content).toContain('e2e-ok');
    expect(result.content).toContain('data:text/html');
  }, LIVE_TIMEOUT_MS);

  it('browser_evaluate видит e2e-ok на открытой странице', async () => {
    // Прямой путь менеджера (`manager.callTool`) — тот же `ExecutorMcpClient`.
    const result = await manager.callTool(`${SERVER}_browser_evaluate`, {
      function: "() => document.querySelector('h1')?.textContent ?? document.body.innerText",
    });

    expect(result.isError, `ответ: ${result.content}`).toBe(false);
    expect(result.content).toContain('e2e-ok');
  }, LIVE_TIMEOUT_MS);
});
