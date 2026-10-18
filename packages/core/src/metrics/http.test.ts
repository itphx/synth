/**
 * ADR-094: HTTP-middleware метрик — шаблон маршрута (`routePath`), `other` для
 * нематченных путей, 500 при исключении, исключение `/metrics` из сбора,
 * SSE/WS — только в `streams_active` (без гистограммы).
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { MetricsRegistry, type MetricSnapshot } from './registry.js';
import { createHttpMetricsMiddleware, normalizeRouteTemplate } from './http.js';

function seriesOf(registry: MetricsRegistry, name: string): MetricSnapshot['series'] {
  return registry.snapshot().find((metric) => metric.name === name)?.series ?? [];
}

function labelsText(series: MetricSnapshot['series']): string[] {
  return series.map((s) => JSON.stringify(s.labels));
}

describe('createHttpMetricsMiddleware', () => {
  it('routePath: шаблон маршрута, 404 → other, 500 при исключении', async () => {
    const registry = new MetricsRegistry();
    const app = new Hono();
    app.use('*', createHttpMetricsMiddleware(registry));
    app.get('/api/v2/sessions/:id', (c) => c.text('ok'));
    app.get('/api/v2/boom', () => {
      throw new Error('boom');
    });

    expect((await app.request('/api/v2/sessions/s-1')).status).toBe(200);
    expect((await app.request('/api/v2/does-not-exist')).status).toBe(404);
    expect((await app.request('/api/v2/boom')).status).toBe(500);

    const requests = seriesOf(registry, 'synth_http_requests_total');
    expect(requests.some((s) => s.labels.route === '/api/v2/sessions/:id' && s.labels.status === '200')).toBe(true);
    expect(requests.some((s) => s.labels.route === 'other' && s.labels.status === '404')).toBe(true);
    expect(requests.some((s) => s.labels.route === '/api/v2/boom' && s.labels.status === '500')).toBe(true);

    const duration = seriesOf(registry, 'synth_http_request_duration_seconds');
    const routes = labelsText(duration);
    expect(routes.some((r) => r.includes('/api/v2/sessions/:id'))).toBe(true);
    expect(routes.some((r) => r.includes('"route":"other"'))).toBe(true);

    // in_flight возвращается в 0 после запросов.
    expect(seriesOf(registry, 'synth_http_in_flight')[0]?.value).toBe(0);
  });

  it('скрейп /metrics не учитывается вовсе', async () => {
    const registry = new MetricsRegistry();
    const app = new Hono();
    app.use('*', createHttpMetricsMiddleware(registry));
    app.get('/metrics', (c) => c.text('metrics'));

    expect((await app.request('/metrics')).status).toBe(200);
    expect(seriesOf(registry, 'synth_http_requests_total')).toHaveLength(0);
    expect(seriesOf(registry, 'synth_http_request_duration_seconds')).toHaveLength(0);
  });

  it('SSE /api/v2/events и /ws/*: в streams_active, но не в гистограмме', async () => {
    const registry = new MetricsRegistry();
    const app = new Hono();
    app.use('*', createHttpMetricsMiddleware(registry));
    let duringSse = '';
    app.get('/api/v2/events', (c) => {
      duringSse = registry.render().text;
      return c.text('sse');
    });
    app.get('/ws/events', (c) => c.text('ws'));

    const sse = await app.request('/api/v2/events');
    expect(await sse.text()).toBe('sse');
    const ws = await app.request('/ws/events');
    expect(await ws.text()).toBe('ws');

    // Во время стрима gauge видит активный поток.
    expect(duringSse).toContain('synth_http_streams_active 1');

    const requests = seriesOf(registry, 'synth_http_requests_total');
    expect(requests.some((s) => s.labels.route === '/api/v2/events')).toBe(true);
    expect(requests.some((s) => s.labels.route === '/ws/events')).toBe(true);

    const duration = seriesOf(registry, 'synth_http_request_duration_seconds');
    expect(duration.some((s) => s.labels.route === '/api/v2/events')).toBe(false);
    expect(duration.some((s) => s.labels.route === '/ws/events')).toBe(false);

    // После завершения запросов активных стримов нет.
    expect(seriesOf(registry, 'synth_http_streams_active')[0]?.value).toBe(0);
  });

  it('normalizeRouteTemplate: `*`, `/*`, catch-all и пустой шаблон → other', () => {
    expect(normalizeRouteTemplate('/api/v2/sessions/:id')).toBe('/api/v2/sessions/:id');
    expect(normalizeRouteTemplate('*')).toBe('other');
    expect(normalizeRouteTemplate('/*')).toBe('other');
    expect(normalizeRouteTemplate('/api/v2/*')).toBe('other');
    expect(normalizeRouteTemplate('')).toBe('other');
    expect(normalizeRouteTemplate(undefined)).toBe('other');
  });
});
