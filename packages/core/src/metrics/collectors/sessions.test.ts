/**
 * ADR-094: фоновые gauge сессий/очереди (`startSessionMetrics`).
 * Фейковый `SessionManager` — коллектору нужен только `listSessions`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@itphx/synth-shared';
import { MetricsRegistry } from '../registry.js';
import { startSessionMetrics } from './sessions.js';
import type { SessionManager } from '../../sessions/manager.js';

function fakeSession(opts: { archivedAt?: string; pending?: number }): Session {
  return {
    archivedAt: opts.archivedAt,
    pendingMessages: new Array(opts.pending ?? 0).fill({}),
  } as unknown as Session;
}

describe('startSessionMetrics', () => {
  it('считает неархивные сессии и сумму pendingMessages', async () => {
    const registry = new MetricsRegistry();
    const manager = {
      listSessions: async () => [
        fakeSession({ pending: 2 }),
        fakeSession({ pending: 1 }),
        fakeSession({ archivedAt: '2026-01-01T00:00:00.000Z', pending: 5 }),
      ],
    } as unknown as SessionManager;

    const stop = startSessionMetrics(registry, manager, { intervalMs: 60_000 });

    await vi.waitFor(() => {
      const rendered = registry.render().text;
      expect(rendered).toContain('synth_sessions_active 2');
      // pendingMessages суммируются по всем сессиям (архивные тоже в очереди).
      expect(rendered).toContain('synth_queue_pending 8');
    });

    stop();
    // Остановка обнуляет оба gauge.
    const rendered = registry.render().text;
    expect(rendered).toContain('synth_sessions_active 0');
    expect(rendered).toContain('synth_queue_pending 0');
  });

  it('ошибка списка не пробрасывается и не ломает gauge', async () => {
    const registry = new MetricsRegistry();
    const manager = {
      listSessions: async () => {
        throw new Error('boom');
      },
    } as unknown as SessionManager;

    const stop = startSessionMetrics(registry, manager, { intervalMs: 60_000 });
    // Даём микрозадаче отработать — ошибка проглочена (рендер не падает).
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.render().text).toContain('# TYPE synth_sessions_active gauge');
    stop();
  });
});
