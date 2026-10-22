/**
 * HTTP-сервер исполнителя (ADR-077, шаг 7a; MCP-хостинг — шаг B1).
 *
 * Транспорт — HTTP/1.1 + JSON (как весь Synth — на Hono). Роуты:
 *
 * | Метод | Путь | Назначение | Авторизация |
 * |---|---|---|---|
 * | `POST` | `/exec` | выполнить команду | bearer-токен |
 * | `GET` | `/capabilities` | версия протокола и состав toolchain'а | bearer-токен |
 * | `GET` | `/mcp/servers` | состояние MCP-серверов исполнителя | bearer-токен |
 * | `GET` | `/mcp/tools` | инструменты поднятых MCP-серверов | bearer-токен |
 * | `POST` | `/mcp/call` | вызов инструмента MCP-сервера | bearer-токен |
 * | `GET` | `/health` | liveness исполнителя | без токена |
 *
 * Коды ответов — по классу ошибки (`EXEC_ERROR_STATUS`): `400` — некорректный
 * запрос или `cwd` вне workspace, `401` — нет/неверный токен, `404` — неизвестный
 * MCP-сервер/инструмент, `429` — превышен лимит одновременных команд, `500` —
 * прочие ошибки исполнения.
 *
 * Разрыв соединения клиентом («Стоп») → сервер убивает дочерний процесс
 * (SIGTERM) и закрывает запрос: зомби-процессов не остаётся.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { Hono, type MiddlewareHandler } from 'hono';
import { isAuthorized } from './auth.js';
import { ExecService } from './exec-service.js';
import {
  EXECUTOR_PROTOCOL_VERSION,
  errorResponse,
  parseExecRequestBody,
  parseMcpCallRequestBody,
  type ExecutorCapabilities,
  type ExecutorHealth,
  type McpCallResultBody,
  type McpServerStatusBody,
  type McpToolInfoBody,
} from './protocol.js';
import { detectToolchain, type ToolchainInfo } from './toolchain.js';
import { ExecutorMcpError, ExecutorMcpHost, type McpServerSpec } from './mcp.js';

/** Контекст Hono: Node-запрос (для отслеживания разрыва соединения). */
type ExecutorEnv = {
  Bindings: { nodeReq?: IncomingMessage };
};

/** Параметры Hono-приложения исполнителя. */
export interface ExecutorAppOptions {
  /** Bearer-токен доступа к API исполнителя. */
  token: string;
  /** Корень workspace — граница containment'а для `cwd`. */
  workspaceRoot: string;
  /** Лимит одновременных команд (по умолчанию — 4). */
  maxConcurrency?: number;
  /** Потолок таймаута команды, мс (по умолчанию — 120 c). */
  maxTimeoutMs?: number;
  /** Потолок буфера вывода, байт (по умолчанию — 10 МБ). */
  maxOutputBytes?: number;
  /** Заранее определённый состав toolchain'а (определяется на старте). */
  toolchain?: ToolchainInfo;
  /** MCP-серверы, которые исполнитель хостит у себя (stdio). */
  mcpServers?: McpServerSpec[];
  /** Готовый хост MCP-серверов (иначе создаётся из `mcpServers`). */
  mcpHost?: ExecutorMcpHost;
  /** Момент старта процесса, мс (для `uptimeSec`). */
  startedAt?: number;
  /** Порт исполнения (инъекция для тестов). */
  executionPort?: ConstructorParameters<typeof ExecService>[0]['executionPort'];
}

/** Дефолты лимитов исполнителя (совпадают с `EXECUTOR_DEFAULTS`). */
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Связать отмену с разрывом соединения клиентом.
 *
 * Клиент разорвал запрос («Стоп») → сигнал → процесс команды убивается
 * (SIGTERM на стороне inline-порта).
 */
function linkDisconnect(nodeReq: IncomingMessage | undefined): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  if (!nodeReq) return { signal: undefined, dispose: () => {} };
  const controller = new AbortController();
  const socket = nodeReq.socket;
  const onClose = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  nodeReq.once('aborted', onClose);
  socket?.once('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      nodeReq.off('aborted', onClose);
      socket?.off('close', onClose);
    },
  };
}

/**
 * Собрать Hono-приложение исполнителя.
 *
 * Приложение не поднимает сокет — этим занимается `startExecutorServer`
 * (в тестах — `app.request(...)`).
 */
export function createExecutorApp(opts: ExecutorAppOptions): Hono<ExecutorEnv> {
  const app = new Hono<ExecutorEnv>();
  const service = new ExecService({
    workspaceRoot: opts.workspaceRoot,
    maxConcurrency: opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    maxTimeoutMs: opts.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    ...(opts.executionPort ? { executionPort: opts.executionPort } : {}),
  });
  const startedAt = opts.startedAt ?? Date.now();
  const token = opts.token;

  // Хост MCP-серверов: серверы поднимаются лениво (первое обращение).
  const mcpHost = opts.mcpHost ?? new ExecutorMcpHost(opts.mcpServers ?? []);

  // Состав toolchain'а: задан на старте либо определяется при первом запросе
  // (результат кэшируется).
  let toolchainPromise: Promise<ToolchainInfo> | undefined = opts.toolchain
    ? undefined
    : undefined;
  const toolchain = (): Promise<ToolchainInfo> => {
    if (opts.toolchain !== undefined) return Promise.resolve(opts.toolchain);
    toolchainPromise ??= detectToolchain();
    return toolchainPromise;
  };

  /** Guard аутентификации: без корректного bearer-токена — 401. */
  const requireToken: MiddlewareHandler<ExecutorEnv> = async (c, next) => {
    if (!isAuthorized(c.req.header('authorization'), token)) {
      const { status, body } = errorResponse('unauthorized', 'нет или неверный bearer-токен');
      return c.json(body, status);
    }
    await next();
  };

  app.use('/exec', requireToken);
  app.use('/capabilities', requireToken);
  app.use('/mcp/servers', requireToken);
  app.use('/mcp/tools', requireToken);
  app.use('/mcp/call', requireToken);

  app.post('/exec', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      const { status, body } = errorResponse('invalid_request', 'тело запроса — невалидный JSON');
      return c.json(body, status);
    }

    const parsed = parseExecRequestBody(raw);
    if (!parsed.ok) {
      const { status, body } = errorResponse('invalid_request', parsed.message);
      return c.json(body, status);
    }

    // `c.env` отсутствует, если приложение вызвано без Node-контекста
    // (тесты через `app.request`) — тогда отслеживать разрыв нечего.
    const disconnect = linkDisconnect(c.env?.nodeReq);
    try {
      const outcome = await service.execute(parsed.value, disconnect.signal);
      if (outcome.ok) return c.json(outcome.result, 200);
      return c.json({ error: outcome.error }, outcome.status);
    } finally {
      disconnect.dispose();
    }
  });

  app.get('/capabilities', async (c) => {
    const body: ExecutorCapabilities = {
      protocol: EXECUTOR_PROTOCOL_VERSION,
      toolchain: await toolchain(),
      os: process.platform,
      arch: process.arch,
      node: process.version,
    };
    return c.json(body, 200);
  });

  // --- MCP-хостинг (ADR-077, шаг B1) ---------------------------------------

  app.get('/mcp/servers', (c) => {
    const body: McpServerStatusBody[] = mcpHost.listServers();
    return c.json(body, 200);
  });

  app.get('/mcp/tools', async (c) => {
    const body: McpToolInfoBody[] = await mcpHost.listTools();
    return c.json(body, 200);
  });

  app.post('/mcp/call', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      const { status, body } = errorResponse('invalid_request', 'тело запроса — невалидный JSON');
      return c.json(body, status);
    }

    const parsed = parseMcpCallRequestBody(raw);
    if (!parsed.ok) {
      const { status, body } = errorResponse('invalid_request', parsed.message);
      return c.json(body, status);
    }

    try {
      const result = await mcpHost.callTool(
        parsed.value.server,
        parsed.value.tool,
        parsed.value.arguments ?? {},
      );
      const body: McpCallResultBody = { content: result.content, isError: result.isError };
      return c.json(body, 200);
    } catch (err) {
      if (err instanceof ExecutorMcpError) {
        // Неизвестный сервер/инструмент — 404; недоступный сервер и сбой вызова — 500.
        const reason = err.kind === 'unknown_server' || err.kind === 'unknown_tool'
          ? 'not_found'
          : 'internal_error';
        const { status, body } = errorResponse(reason, err.message);
        return c.json(body, status);
      }
      const { status, body } = errorResponse(
        'internal_error',
        err instanceof Error ? err.message : String(err),
      );
      return c.json(body, status);
    }
  });

  app.get('/health', (c) => {
    const body: ExecutorHealth = {
      status: 'ok',
      protocol: EXECUTOR_PROTOCOL_VERSION,
      uptimeSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      concurrency: { limit: service.concurrencyLimit, active: service.activeCount },
    };
    return c.json(body, 200);
  });

  return app;
}

/** Node `IncomingMessage` → web `Request` (для `app.fetch`). */
export function toWebRequest(req: IncomingMessage): Request {
  const protocol = 'http';
  const host = req.headers.host || 'localhost';
  const url = `${protocol}://${host}${req.url || '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const method = req.method || 'GET';
  const noBody = ['GET', 'HEAD'].includes(method) || !req.headers['content-length'];
  return new Request(url, {
    method,
    headers,
    body: noBody ? undefined : (Readable.toWeb(req) as ReadableStream),
    duplex: 'half',
  } as RequestInit);
}

/**
 * Node HTTP-сервер поверх Hono-приложения (тот же адаптер, что в core:
 * `packages/core/src/server/app/http-server.ts` — без раздачи статики UI).
 */
export function createExecutorHttpServer(app: Hono<ExecutorEnv>): Server {
  return createServer(async (req, res) => {
    try {
      const response = await app.fetch(toWebRequest(req), { nodeReq: req });
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      if (response.body) {
        const reader = response.body.getReader();
        const pump = async (): Promise<void> => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        await pump();
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

/** Параметры запуска сервера исполнителя. */
export interface ExecutorServerOptions extends ExecutorAppOptions {
  /** Адрес прослушивания (по умолчанию — `0.0.0.0`). */
  host?: string;
  /** Порт прослушивания (по умолчанию — `5100`; `0` — случайный порт). */
  port?: number;
}

/** Запущенный сервер исполнителя. */
export interface ExecutorHandle {
  server: Server;
  host: string;
  port: number;
  /** Базовый URL исполнителя (без завершающего слэша). */
  url: string;
  /** Остановить сервер. */
  close: () => Promise<void>;
}

/**
 * Поднять сервер исполнителя.
 *
 * Состав toolchain'а определяется **на старте** (проба бинарников) и
 * кэшируется в приложении. MCP-серверы, наоборот, поднимаются **лениво**
 * (первое обращение к `/mcp/tools` или `/mcp/call`).
 *
 * При остановке сначала закрываются MCP-серверы (дочерние процессы
 * завершаются — зомби-процессов не остаётся), затем — HTTP-сервер.
 */
export async function startExecutorServer(opts: ExecutorServerOptions): Promise<ExecutorHandle> {
  const host = opts.host ?? '0.0.0.0';
  const toolchain = opts.toolchain ?? (await detectToolchain());
  const mcpHost = opts.mcpHost ?? new ExecutorMcpHost(opts.mcpServers ?? []);
  const app = createExecutorApp({ ...opts, toolchain, mcpHost });
  const server = createExecutorHttpServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(opts.port ?? 5100, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 5100);
  return {
    server,
    host,
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    close: async () => {
      // Сначала MCP-серверы: их дочерние процессы (в т.ч. Chromium) должны
      // завершиться вместе с исполнителем.
      await mcpHost.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
