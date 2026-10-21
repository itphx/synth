/**
 * ADR-099 (фикс egress) + ADR-071: HTTP-MCP-сервер должен отдавать инструменты
 * клиенту Synth.
 *
 * Регресс: `egressFetch` передавал диспетчер из пакета `undici@7` в **глобальный**
 * `fetch` Node (встроенный undici другой версии). Контракт диспетчера у них
 * несовместим, и ответ приходил **без заголовков** — SDK-клиент видел
 * `content-type: null` и падал с «Unexpected content type: null», а агент — с
 * `status=error, tools=0`.
 *
 * Тест поднимает настоящий MCP-сервер (Streamable HTTP, JSON-ответы) и подключает
 * к нему `McpClient` при **включённом dispatcher'е доверия процесса** — как на
 * живом инстансе с настроенным прокси/TLS.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as undici from 'undici';
import { McpClient } from './client.js';
import { applyGlobalTlsTrust, _resetTlsTrustForTests } from '../../security/tls.js';
import { closeTestServer } from '../../test-helpers/close-server.js';

// Публичный сертификат фикстуры (самоподписанный, «TEST ONLY») — нужен, чтобы
// включить dispatcher доверия процесса (как на инстансе с настроенным TLS/прокси).
const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'security', '__fixtures__');
const CERT_PEM = readFileSync(join(FIX_DIR, 'tls-test-selfsigned.pem'), 'utf-8');

describe('McpClient: Streamable HTTP через egress-транспорт (ADR-099/ADR-071)', () => {
  let httpServer: HttpServer;
  let url: string;

  beforeAll(async () => {
    // Stateless-режим SDK: на каждый POST — свой transport (+ свой сервер),
    // иначе транспорт отвечает 400 «each request must use a fresh transport».
    // `enableJsonResponse` — сервер отдаёт `content-type: application/json`.
    const createMcp = (): McpProtocolServer => {
      const mcp = new McpProtocolServer({ name: 'test-http-mcp', version: '1.0.0' });
      mcp.registerCapabilities({ tools: {} });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'echo', description: 'Эхо', inputSchema: { type: 'object' } }],
      }));
      return mcp;
    };

    httpServer = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const mcp = createMcp();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          await mcp.connect(transport);
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = undefined;
          }
          await transport.handleRequest(req, res, parsed);
        })();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    if (!httpServer) return;
    await closeTestServer(httpServer);
  });

  beforeEach(async () => {
    _resetTlsTrustForTests();
    // Включаем dispatcher доверия процесса (как на инстансе с настроенным
    // TLS/прокси) — именно этот режим ломал заголовки ответа.
    await applyGlobalTlsTrust({ ca: CERT_PEM, rejectUnauthorized: true });
  });

  afterEach(() => {
    _resetTlsTrustForTests();
    // Вернуть глобальный undici-dispatcher в исходное состояние.
    undici.setGlobalDispatcher(new undici.Agent());
  });

  it('клиент читает tools/list HTTP-сервера (content-type не теряется)', async () => {
    const client = new McpClient('test-http', { type: 'http', url });

    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.tools.map((tool) => tool.name)).toEqual(['echo']);

    await client.disconnect();
  });
});
