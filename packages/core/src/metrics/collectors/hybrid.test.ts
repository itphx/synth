/**
 * ADR-094: гибридные метрики (`attachHybridMetrics`).
 * `synth_hybrid_connected` читается при скрейпе; длительность запросов —
 * в гистограмме по нормализованному `op`.
 */
import { describe, it, expect } from 'vitest';
import { MetricsRegistry } from '../registry.js';
import { attachHybridMetrics, normalizeRemoteOp } from './hybrid.js';

describe('attachHybridMetrics', () => {
  it('connected читается при скрейпе, запросы попадают в histogram{op}', () => {
    const registry = new MetricsRegistry();
    let connected = false;
    const hooks = attachHybridMetrics(registry, () => connected);

    expect(registry.render().text).toContain('synth_hybrid_connected 0');

    connected = true;
    expect(registry.render().text).toContain('synth_hybrid_connected 1');

    hooks.onRequest({ method: 'GET', path: '/api/v2/sessions/abc/messages', durationMs: 250 });
    hooks.onRequest({ method: 'GET', path: '/api/v2/projects?limit=5', durationMs: 10 });
    hooks.onRequest({ method: 'POST', path: '/api/v2/other', durationMs: 5 });

    const rendered = registry.render().text;
    expect(rendered).toContain('synth_remote_request_duration_seconds_count{op="sessions"} 1');
    expect(rendered).toContain('synth_remote_request_duration_seconds_count{op="projects"} 1');
    expect(rendered).toContain('synth_remote_request_duration_seconds_count{op="other"} 1');
    // 250 мс → 0.25 с.
    expect(rendered).toContain('synth_remote_request_duration_seconds_sum{op="sessions"} 0.25');

    hooks.stop();
    expect(registry.render().text).toContain('synth_hybrid_connected 0');
  });

  it('normalizeRemoteOp: id/query не влияют на op, неизвестное — other', () => {
    expect(normalizeRemoteOp('/api/v2/sessions/remote:1')).toBe('sessions');
    expect(normalizeRemoteOp('/api/v2/projects/abc/export?x=1')).toBe('projects');
    expect(normalizeRemoteOp('/api/v2/events/bindings')).toBe('events');
    expect(normalizeRemoteOp('/api/v2/llm/chat/completions')).toBe('llm');
    expect(normalizeRemoteOp('/health')).toBe('other');
    expect(normalizeRemoteOp('')).toBe('other');
  });
});
