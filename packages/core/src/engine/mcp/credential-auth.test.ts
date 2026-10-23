/**
 * ADR-105 (Ф3): подстановка access-токена в MCP-транспорт.
 *
 * Проверяется без внешней сети: мок-транспорт (`fetch`) и локальный
 * `node:http` MCP-сервер (loopback).
 *
 * Ключевые инварианты:
 * - токен берётся из слоя доступов и подставляется в **каждый** запрос;
 * - `401` → **ровно один** refresh → повтор запроса с новым токеном;
 * - `invalid_grant` → понятная ошибка «требуется переавторизация», доступ
 *   переводится в `status:'error'`;
 * - значение токена **не** попадает ни в текст ошибки, ни в лог.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from './client.js';
import {
  McpCredentialError,
  createCredentialFetch,
  createRepositoryCredentialSource,
} from './credential-auth.js';
import { MemoryExternalCredentialRepository } from '../../storage/memory/external-credentials.js';
import { OAuthCredentialService } from '../oauth/service.js';
import { OAuthError } from '../oauth/types.js';
import type { OAuthClient } from '../oauth/client.js';
import { closeTestServer } from '../../test-helpers/close-server.js';

const TOKEN_OLD = 'tok-old-1234567890';
const TOKEN_NEW = 'tok-new-abcdefghij';

describe('ADR-105 Ф3: токен доступа в MCP-транспорте', () => {
  describe('createCredentialFetch', () => {
    it('подставляет access-токен в заголовок Authorization', async () => {
      const seen: Array<string | undefined> = [];
      const source = {
        getAccessToken: async () => TOKEN_OLD,
        refreshAccessToken: async () => TOKEN_NEW,
      };
      const fetchImpl = createCredentialFetch({
        source,
        credentialId: 'extc_1',
        serverName: 'demo',
        baseFetch: async (_input, init) => {
          seen.push(new Headers(init?.headers).get('authorization') ?? undefined);
          return new Response('{}', { status: 200 });
        },
      });

      await fetchImpl('http://127.0.0.1/mcp', { method: 'POST' });

      expect(seen).toEqual([`Bearer ${TOKEN_OLD}`]);
    });

    it('401 → ровно один refresh → повтор запроса с новым токеном', async () => {
      const seen: Array<string | undefined> = [];
      let refreshCalls = 0;
      const source = {
        getAccessToken: async () => TOKEN_OLD,
        refreshAccessToken: async () => {
          refreshCalls += 1;
          return TOKEN_NEW;
        },
      };
      const fetchImpl = createCredentialFetch({
        source,
        credentialId: 'extc_1',
        serverName: 'demo',
        baseFetch: async (_input, init) => {
          const auth = new Headers(init?.headers).get('authorization') ?? undefined;
          seen.push(auth);
          if (auth === `Bearer ${TOKEN_OLD}`) {
            return new Response('unauthorized', { status: 401 });
          }
          return new Response('{}', { status: 200 });
        },
      });

      const response = await fetchImpl('http://127.0.0.1/mcp', { method: 'POST' });

      expect(response.status).toBe(200);
      expect(refreshCalls).toBe(1);
      expect(seen).toEqual([`Bearer ${TOKEN_OLD}`, `Bearer ${TOKEN_NEW}`]);
    });

    it('повторный 401 после refresh не запускает новый refresh', async () => {
      let refreshCalls = 0;
      const source = {
        getAccessToken: async () => TOKEN_OLD,
        refreshAccessToken: async () => {
          refreshCalls += 1;
          return TOKEN_NEW;
        },
      };
      const fetchImpl = createCredentialFetch({
        source,
        credentialId: 'extc_1',
        serverName: 'demo',
        baseFetch: async () => new Response('nope', { status: 401 }),
      });

      const response = await fetchImpl('http://127.0.0.1/mcp', { method: 'POST' });

      expect(response.status).toBe(401);
      expect(refreshCalls).toBe(1);
    });

    it('invalid_grant → ошибка «требуется переавторизация», без значения токена', async () => {
      const source = {
        getAccessToken: async () => TOKEN_OLD,
        refreshAccessToken: async () => {
          throw new McpCredentialError(
            'reauthorization_required',
            'Доступ «extc_1» требует переавторизации: refresh отклонён провайдером',
          );
        },
      };
      const fetchImpl = createCredentialFetch({
        source,
        credentialId: 'extc_1',
        serverName: 'demo',
        baseFetch: async () => new Response('nope', { status: 401 }),
      });

      const error = await fetchImpl('http://127.0.0.1/mcp', { method: 'POST' }).catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(McpCredentialError);
      expect((error as McpCredentialError).code).toBe('reauthorization_required');
      expect((error as Error).message).not.toContain(TOKEN_OLD);
      expect((error as Error).message).not.toContain(TOKEN_NEW);
    });
  });

  describe('createRepositoryCredentialSource', () => {
    it('отдаёт токен из порта доступов', async () => {
      const repo = new MemoryExternalCredentialRepository();
      const meta = await repo.create({
        provider: 'demo',
        clientId: 'cid',
        owner: { kind: 'instance', id: 'instance' },
        accessToken: TOKEN_OLD,
        createdBy: 'admin',
      });
      const source = createRepositoryCredentialSource({ repo });

      expect(await source.getAccessToken(meta.id)).toBe(TOKEN_OLD);
    });

    it('отозванный доступ → ошибка revoked', async () => {
      const repo = new MemoryExternalCredentialRepository();
      const meta = await repo.create({
        provider: 'demo',
        clientId: 'cid',
        owner: { kind: 'instance', id: 'instance' },
        accessToken: TOKEN_OLD,
        createdBy: 'admin',
      });
      await repo.revoke(meta.id);
      const source = createRepositoryCredentialSource({ repo });

      await expect(source.getAccessToken(meta.id)).rejects.toMatchObject({ code: 'revoked' });
    });

    it('invalid_grant при refresh → статус доступа error', async () => {
      const repo = new MemoryExternalCredentialRepository();
      const meta = await repo.create({
        provider: 'demo',
        clientId: 'cid',
        owner: { kind: 'instance', id: 'instance' },
        accessToken: TOKEN_OLD,
        refreshToken: 'refresh-token',
        createdBy: 'admin',
      });
      const fakeClient = {
        refresh: async () => {
          throw new OAuthError('invalid_grant', 'refresh отклонён');
        },
      } as unknown as OAuthClient;
      const service = new OAuthCredentialService({
        repo,
        clientFor: () => fakeClient,
      });
      const source = createRepositoryCredentialSource({
        repo,
        refresh: async (id) => {
          await service.refresh(id);
        },
      });

      const error = await source.refreshAccessToken(meta.id).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(McpCredentialError);
      expect((error as McpCredentialError).code).toBe('reauthorization_required');
      expect((error as Error).message).not.toContain(TOKEN_OLD);
      const after = await repo.get(meta.id);
      expect(after?.status).toBe('error');
    });
  });

  describe('McpClient + auth.kind=credential (локальный MCP-сервер)', () => {
    let httpServer: HttpServer;
    let url: string;
    const seenAuth: Array<string | undefined> = [];
    let acceptToken = TOKEN_NEW;

    beforeAll(async () => {
      const createMcp = (): McpProtocolServer => {
        const mcp = new McpProtocolServer({ name: 'test-http-mcp', version: '1.0.0' });
        mcp.registerCapabilities({ tools: {} });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'echo', description: 'Эхо', inputSchema: { type: 'object' } }],
        }));
        return mcp;
      };

      httpServer = createServer((req, res) => {
        const auth = req.headers.authorization;
        seenAuth.push(auth);
        if (auth !== `Bearer ${acceptToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
          return;
        }
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

    it('401 → refresh → повтор: клиент подключается, инструменты видны', async () => {
      seenAuth.length = 0;
      acceptToken = TOKEN_NEW;
      let refreshCalls = 0;
      const source = {
        getAccessToken: async () => {
          // Первый запрос — со «старым» токеном (сервер ответит 401).
          return refreshCalls === 0 ? TOKEN_OLD : TOKEN_NEW;
        },
        refreshAccessToken: async () => {
          refreshCalls += 1;
          return TOKEN_NEW;
        },
      };

      const client = new McpClient(
        'demo',
        { type: 'http', url, auth: { kind: 'credential', credentialId: 'extc_1' } },
        { credentialSource: source },
      );

      await client.connect();

      expect(client.isConnected).toBe(true);
      expect(client.tools.map((tool) => tool.name)).toEqual(['echo']);
      expect(refreshCalls).toBe(1);
      expect(seenAuth[0]).toBe(`Bearer ${TOKEN_OLD}`);
      expect(seenAuth).toContain(`Bearer ${TOKEN_NEW}`);

      await client.disconnect();
    });

    it('без источника токена коннектор с auth.kind=credential не подключается', async () => {
      const client = new McpClient('demo', {
        type: 'http',
        url,
        auth: { kind: 'credential', credentialId: 'extc_1' },
      });

      await expect(client.connect()).rejects.toThrow(/источник токена недоступен/);
      expect(client.isConnected).toBe(false);
    });

    it('значение токена не попадает в лог и в текст ошибки', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const source = {
          getAccessToken: async () => TOKEN_OLD,
          refreshAccessToken: async () => {
            throw new McpCredentialError('reauthorization_required', 'требуется переавторизация');
          },
        };
        const client = new McpClient(
          'demo',
          { type: 'http', url, auth: { kind: 'credential', credentialId: 'extc_1' } },
          { credentialSource: source },
        );
        await client.connect().catch(() => undefined);

        const logged = [logSpy, errorSpy, warnSpy]
          .flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')))
          .join('\n');
        expect(logged).not.toContain(TOKEN_OLD);
        expect(logged).not.toContain(TOKEN_NEW);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
