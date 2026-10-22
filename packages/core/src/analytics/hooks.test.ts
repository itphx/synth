/**
 * ADR-102: шов записи `activity` через hook-шину (ADR-030) на memory-сторадже.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '../storage/storage-context.js';
import { HookBus } from '../engine/hooks/hook-bus.js';
import { AnalyticsRecorder } from './recorder.js';
import { attachAnalyticsActivityHooks } from './hooks.js';
import type { StorageContext } from '../storage/storage-context.js';

const NOW = new Date('2026-10-18T10:00:00.000Z');

function makeFixture() {
  const storage: StorageContext = createMemoryStorage();
  const recorder = new AnalyticsRecorder({ repo: storage.analyticsRollups, now: () => NOW });
  const hooks = new HookBus();
  const detach = attachAnalyticsActivityHooks(hooks, {
    recorder,
    // Контекст хуков агентских событий несёт только id сессии — резолвим оси.
    resolveSessionAxes: async (sessionId) =>
      sessionId === 'child-1' ? { userId: 'u1', projectId: 'p1' } : null,
  });
  return { storage, recorder, hooks, detach };
}

describe('attachAnalyticsActivityHooks', () => {
  let detach: (() => void) | undefined;

  afterEach(() => {
    detach?.();
    detach = undefined;
  });

  it('session_start → sessions_created, архивный session_end → sessions_archived', async () => {
    const fx = makeFixture();
    detach = fx.detach;

    fx.hooks.emitAsync('session_start', {
      sessionId: 's1',
      userId: 'u1',
      projectId: 'p1',
    });
    fx.hooks.emitAsync('session_end', { sessionId: 's1', userId: 'u1', projectId: 'p1' });
    fx.hooks.emitAsync('session_end', {
      sessionId: 's1',
      userId: 'u1',
      projectId: 'p1',
      archived: true,
    });

    await vi.waitFor(async () => {
      const rows = await fx.storage.analyticsRollups.query({
        family: 'activity',
        groupBy: ['user', 'project'],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measures).toEqual({ sessions_created: 1, sessions_archived: 1 });
    });
  });

  it('post_tool_use → tool_calls, agent_spawned → turns, agent_failed → errors', async () => {
    const fx = makeFixture();
    detach = fx.detach;

    fx.hooks.emitAsync('post_tool_use', {
      tool: 'read_file',
      input: {},
      duration: 1,
      sessionId: 's1',
      userId: 'u1',
      projectId: 'p1',
    });
    // Агентские события: оси резолвятся по id дочерней сессии.
    fx.hooks.emitAsync('agent_spawned', { agentId: 'child-1', agentType: 'developer' });
    fx.hooks.emitAsync('agent_failed', { agentId: 'child-1', error: 'boom' });

    await vi.waitFor(async () => {
      const rows = await fx.storage.analyticsRollups.query({
        family: 'activity',
        groupBy: ['user', 'project'],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.measures).toEqual({ tool_calls: 1, turns: 1, errors: 1 });
    });
  });

  it('удаление сессии (session_end без archived) меру не пишет', async () => {
    const fx = makeFixture();
    detach = fx.detach;

    fx.hooks.emitAsync('session_end', { sessionId: 's1', userId: 'u1', projectId: 'p1' });

    // Даём микротаскам выполниться и убеждаемся, что бакетов нет.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fx.storage.analyticsRollups.query({ family: 'activity' })).toEqual([]);
  });

  it('detach снимает подписки (события больше не пишутся)', async () => {
    const fx = makeFixture();
    fx.detach();

    fx.hooks.emitAsync('session_start', { sessionId: 's1', userId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fx.storage.analyticsRollups.query({ family: 'activity' })).toEqual([]);
  });
});
