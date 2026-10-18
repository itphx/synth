/**
 * ADR-094: HTTP-метрики Hono-middleware.
 *
 * Лейблы ограничены контрактом: `method`, шаблон маршрута (`routePath`) и
 * `status`. Сырые пути/query/`session_id` не используются — неизвестный
 * маршрут сводится к `other` (ADR-094 п. 5). Долгоживущие потоки
 * (`GET /api/v2/events`, `/ws/*`) не пишутся в гистограмму длительности
 * (искажают p95), но учитываются в `synth_http_streams_active`. Скрейп
 * самого `/metrics` не учитывается вовсе.
 */
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import type { MetricsRegistry } from './registry.js';

export interface HttpMetricsOptions {
  /** Пути, полностью исключённые из сбора (по умолчанию `['/metrics']`). */
  skipPaths?: readonly string[];
  /**
   * Долгоживущий поток (SSE/WS): не в гистограмме, но в `streams_active`.
   * По умолчанию — `GET /api/v2/events` и `/ws/*`.
   */
  isStreamPath?: (path: string) => boolean;
}

const DEFAULT_SKIP_PATHS: readonly string[] = ['/metrics'];

function defaultIsStreamPath(path: string): boolean {
  return path === '/api/v2/events' || path.startsWith('/ws/');
}

/**
 * Шаблон маршрута для метрики. `*`/`/*` (нематченный путь, catch-all
 * middleware) и пустая строка → `other`.
 */
export function normalizeRouteTemplate(template: string | undefined): string {
  if (!template || !template.startsWith('/')) return 'other';
  if (template === '/' || template === '/*' || template.endsWith('/*')) return 'other';
  return template;
}

/**
 * Обёртка тела стрима: `release()` вызывается при завершении, ошибке или
 * отмене чтения — так `synth_http_streams_active` отражает реальную жизнь
 * SSE-соединения, а не только момент возврата Response из хендлера.
 */
function trackStreamBody(
  body: ReadableStream<Uint8Array> | null,
  release: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) {
    release();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}

/**
 * Middleware: считает `synth_http_requests_total`, `synth_http_request_duration_seconds`,
 * держит `synth_http_in_flight`/`synth_http_streams_active`. Ошибки метрик не
 * ломают запрос (серии/лимит обрабатываются реестром, вся запись — в `finally`).
 */
export function createHttpMetricsMiddleware(
  registry: MetricsRegistry,
  opts: HttpMetricsOptions = {},
): MiddlewareHandler {
  const skipPaths = new Set(opts.skipPaths ?? DEFAULT_SKIP_PATHS);
  const isStreamPath = opts.isStreamPath ?? defaultIsStreamPath;

  const requests = registry.counter(
    'synth_http_requests_total',
    'Total number of HTTP requests.',
    ['method', 'route', 'status'],
  );
  const durations = registry.histogram(
    'synth_http_request_duration_seconds',
    'HTTP request duration in seconds.',
    ['method', 'route'],
  );
  const inFlight = registry.gauge(
    'synth_http_in_flight',
    'Number of HTTP requests currently being processed.',
  );
  const streamsActive = registry.gauge(
    'synth_http_streams_active',
    'Number of active long-lived streams (SSE/WebSocket).',
  );

  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    if (skipPaths.has(path)) {
      await next();
      return;
    }

    const method = c.req.method;
    const isStream = isStreamPath(path);
    const startedAt = performance.now();
    inFlight.inc();
    let releaseStream: (() => void) | null = null;
    if (isStream) {
      streamsActive.inc();
      let released = false;
      releaseStream = () => {
        if (released) return;
        released = true;
        streamsActive.dec();
      };
    }

    let failed = false;
    try {
      await next();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      inFlight.dec();
      const route = normalizeRouteTemplate(routePath(c));
      const status = failed ? 500 : c.res.status;
      requests.inc({ method, route, status: String(status) });
      if (!isStream) {
        durations.observe({ method, route }, (performance.now() - startedAt) / 1000);
      } else if (releaseStream) {
        const release = releaseStream;
        // Стрим живёт дольше хендлера: decrement — по завершении/отмене чтения тела.
        if (!failed && c.res?.body) {
          c.res = new Response(trackStreamBody(c.res.body, release), c.res);
        } else {
          release();
        }
      }
    }
  });
}
