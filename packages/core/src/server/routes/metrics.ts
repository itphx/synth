/**
 * ADR-094: `GET /metrics` — экспорт в текстовом формате Prometheus (exposition 0.0.4).
 *
 * - `enabled=false` → 404 (эндпоинта «нет», но не 401 — UI/скрейп не должен
 *   принимать выключенные метрики за проблему авторизации);
 * - задан `token` → обязательный `Authorization: Bearer <token>`, сравнение
 *   `timingSafeEqual` (сначала длины), иначе 401 `UNAUTHORIZED`;
 * - перед финальным рендером выставляются служебные
 *   `synth_metrics_scrape_duration_seconds` и `synth_metrics_series`
 *   (двойной рендер допустим: метрики реестра не меняются от чтения).
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { MetricsRegistry } from '../../metrics/registry.js';

export interface MetricsRoutesOptions {
  registry: MetricsRegistry;
  /** ADR-094: мастер-выключатель (`metrics.enabled`); `false` → 404. */
  enabled: boolean;
  /** Ожидаемый bearer-токен; не задан — эндпоинт открыт. */
  token?: string;
}

/** Сравнение токена без утечки времени: длины, затем `timingSafeEqual`. */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = match[1]!.trim();
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMetricsRoutes(opts: MetricsRoutesOptions): Hono {
  const app = new Hono();
  const scrapeDuration = opts.registry.gauge(
    'synth_metrics_scrape_duration_seconds',
    'Duration of the last /metrics render in seconds.',
  );
  const seriesCount = opts.registry.gauge(
    'synth_metrics_series',
    'Number of metric series in the registry.',
  );

  app.get('/metrics', (c) => {
    if (!opts.enabled) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: 'Экспорт метрик отключён' } },
        404,
      );
    }
    if (opts.token && !tokenMatches(c.req.header('Authorization'), opts.token)) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Неверный или отсутствующий токен /metrics' } },
        401,
        { 'WWW-Authenticate': 'Bearer' },
      );
    }

    const startedAt = performance.now();
    const first = opts.registry.render();
    // Первый скрейп: служебных серий ещё нет — добавляем их к счётчику,
    // чтобы финальный рендер показал фактическое число серий вместе с ними.
    const scrapeSeries = (scrapeDuration.seriesCount === 0 ? 1 : 0) + (seriesCount.seriesCount === 0 ? 1 : 0);
    seriesCount.set(first.series + scrapeSeries);
    scrapeDuration.set((performance.now() - startedAt) / 1000);
    // Второй рендер уже включает служебные метрики скрейпа.
    const final = opts.registry.render();

    return c.body(final.text, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });

  return app;
}
