/**
 * HTTP-сервер provisioner'а (PROP-135, Ф4b-2a) на Hono.
 *
 * | Метод | Путь | Назначение | Ответ | Авторизация |
 * |---|---|---|---|---|
 * | `POST` | `/v1/pools` | обеспечить пул (идемпотентно) | `{url, token}` | bearer |
 * | `POST` | `/v1/pools/:key/touch` | продлить жизнь пула | `204` | bearer |
 * | `POST` | `/v1/pools/:key/drain` | слить пул | `202` | bearer |
 * | `DELETE` | `/v1/pools/:key` | удалить пул | `202` | bearer |
 * | `GET` | `/v1/pools` | список пулов (без токенов) | `{pools}` | bearer |
 * | `GET` | `/v1/capabilities` | провайдер, профили, лимиты | JSON | bearer |
 * | `GET` | `/health` | liveness | `{ok, provider}` | **без токена** |
 * | `GET` | `/metrics` | метрики (`synth_provisioner_*`) | exposition 0.0.4 | bearer |
 *
 * `:key` — канонический ключ пула в URL-кодировке (`%3A` вместо `:`); Hono
 * декодирует параметр пути сам, повторное декодирование не применяется.
 *
 * Коды ошибок — по причине (`ERROR_STATUS`): `400`/`401`/`404`/`429`/`500`,
 * тело — `{error:{reason,message}}`. `/metrics` отдаётся с `Cache-Control:
 * no-store` и тем же bearer-токеном (отдельный токен не заводим — как у
 * исполнителя).
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { isAuthorized } from './auth.js';
import type { ProvisionerMetrics } from './metrics.js';
import type { PoolService } from './pool-service.js';
import { PoolCapacityError } from './pool-service.js';
import type { PoolProviderErrorReason } from './provider.js';
import { PoolProvisionerError } from './provider.js';
import {
  PROVISIONER_PROTOCOL_VERSION,
  ensurePoolRequestSchema,
  errorResponse,
  formatIssues,
  type EnsurePoolResponse,
  type PoolsListResponse,
  type ProvisionerCapabilities,
  type ProvisionerErrorReason,
  type ProvisionerHealth,
  type ProvisionerLimits,
} from './protocol.js';

/** Параметры Hono-приложения provisioner'а. */
export interface ProvisionerAppOptions {
  /** Bearer-токен control plane. */
  token: string;
  /** Сервис пулов (реестр + провайдер). */
  service: PoolService;
  /** Метрики (`GET /metrics`). */
  metrics: ProvisionerMetrics;
  /** Имя провайдера для `/health` и `/v1/capabilities`. */
  providerName: string;
  /** Лимиты для `/v1/capabilities`. */
  limits: ProvisionerLimits;
}

/**
 * Ответ с ошибкой: тело `{error:{reason,message}}`, счётчик `errors_total`.
 */
function fail(
  c: Context,
  metrics: ProvisionerMetrics,
  reason: ProvisionerErrorReason,
  message: string,
): Response {
  metrics.error(reason);
  const { status, body } = errorResponse(reason, message);
  return c.json(body, status);
}

/** Текст ошибки провайдера → причина HTTP-слоя. */
function providerReason(reason: PoolProviderErrorReason): ProvisionerErrorReason {
  return reason === 'pool_not_found' ? 'pool_not_found' : 'internal_error';
}

/**
 * Собрать Hono-приложение provisioner'а (сокет не поднимается).
 */
export function createProvisionerApp(opts: ProvisionerAppOptions): Hono {
  const app = new Hono();

  // Fail-closed: всё, кроме liveness, требует bearer-token control plane.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') {
      await next();
      return;
    }
    if (!isAuthorized(c.req.header('authorization'), opts.token)) {
      return fail(c, opts.metrics, 'unauthorized', 'нет или неверный bearer-токен');
    }
    await next();
  });

  // Обеспечить пул (идемпотентно по ключу).
  app.post('/v1/pools', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, opts.metrics, 'invalid_request', 'тело запроса — невалидный JSON');
    }
    const parsed = ensurePoolRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(c, opts.metrics, 'invalid_request', formatIssues(parsed.error));
    }
    try {
      const pool: EnsurePoolResponse = await opts.service.ensure(parsed.data);
      return c.json(pool, 200);
    } catch (err) {
      if (err instanceof PoolCapacityError) {
        return fail(c, opts.metrics, 'capacity', err.message);
      }
      if (err instanceof PoolProvisionerError) {
        return fail(c, opts.metrics, providerReason(err.reason), err.message);
      }
      return fail(c, opts.metrics, 'internal_error', 'не удалось обеспечить пул');
    }
  });

  // Продлить жизнь пула.
  app.post('/v1/pools/:key/touch', (c) => {
    const key = c.req.param('key');
    if (!opts.service.touch(key)) {
      return fail(c, opts.metrics, 'not_found', `пул "${key}" не найден`);
    }
    return c.body(null, 204);
  });

  // Слить пул (удаление — по grace в reaper'е).
  app.post('/v1/pools/:key/drain', async (c) => {
    const key = c.req.param('key');
    const drained = await opts.service.drain(key);
    if (!drained) {
      return fail(c, opts.metrics, 'not_found', `пул "${key}" не найден`);
    }
    return c.body(null, 202);
  });

  // Удалить пул немедленно.
  app.delete('/v1/pools/:key', async (c) => {
    const key = c.req.param('key');
    try {
      const released = await opts.service.release(key);
      if (!released) {
        return fail(c, opts.metrics, 'not_found', `пул "${key}" не найден`);
      }
      return c.body(null, 202);
    } catch {
      return fail(c, opts.metrics, 'internal_error', 'не удалось удалить пул');
    }
  });

  // Диагностика: список пулов без токенов.
  app.get('/v1/pools', (c) => {
    const body: PoolsListResponse = { pools: opts.service.list() };
    return c.json(body, 200);
  });

  // Диагностика: провайдер, профили, лимиты.
  app.get('/v1/capabilities', async (c) => {
    let capabilities: { provider: string; profiles: string[] };
    try {
      capabilities = await opts.service.capabilities();
    } catch {
      capabilities = { provider: opts.providerName, profiles: [] };
    }
    const body: ProvisionerCapabilities = {
      provider: capabilities.provider || opts.providerName,
      profiles: capabilities.profiles,
      protocol: PROVISIONER_PROTOCOL_VERSION,
      limits: opts.limits,
    };
    return c.json(body, 200);
  });

  // Liveness — без токена (единственный публичный маршрут).
  app.get('/health', (c) => {
    const body: ProvisionerHealth = { ok: true, provider: opts.providerName };
    return c.json(body, 200);
  });

  // Метрики — exposition 0.0.4, только с токеном, без кэширования.
  app.get('/metrics', (c) => {
    const { text } = opts.metrics.render();
    return c.body(text, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });

  // Неизвестный маршрут — JSON-ошибка (а не текст Hono).
  app.notFound((c) => fail(c, opts.metrics, 'not_found', 'маршрут не найден'));

  // Непойманная ошибка — 500 в том же формате, без деталей наружу.
  app.onError((err, c) => {
    if (err instanceof PoolCapacityError) {
      return fail(c, opts.metrics, 'capacity', err.message);
    }
    return fail(c, opts.metrics, 'internal_error', 'внутренняя ошибка provisioner’а');
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
 * Node HTTP-сервер поверх Hono-приложения (тот же адаптер, что у исполнителя
 * и core: без раздачи статики).
 */
export function createProvisionerHttpServer(app: Hono): Server {
  return createServer(async (req, res) => {
    try {
      const response = await app.fetch(toWebRequest(req));
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

/** Параметры запуска сервера provisioner'а. */
export interface ProvisionerServerOptions extends ProvisionerAppOptions {
  /** Адрес прослушивания (по умолчанию `0.0.0.0`). */
  host?: string;
  /** Порт прослушивания (по умолчанию `5200`; `0` — случайный порт). */
  port?: number;
}

/** Запущенный сервер provisioner'а. */
export interface ProvisionerHandle {
  server: Server;
  host: string;
  port: number;
  /** Базовый URL (без завершающего слэша). */
  url: string;
  /** Остановить сервер. */
  close: () => Promise<void>;
}

/** Поднять HTTP-сервер provisioner'а. */
export async function startProvisionerServer(
  opts: ProvisionerServerOptions,
): Promise<ProvisionerHandle> {
  const host = opts.host ?? '0.0.0.0';
  const port = opts.port ?? 5200;
  const app = createProvisionerApp(opts);
  const server = createProvisionerHttpServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    server,
    host,
    port: boundPort,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
