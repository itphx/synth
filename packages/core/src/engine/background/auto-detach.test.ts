/**
 * Авто-перевод блокирующих прогонов в фон при steer — ADR-111 §detach.
 *
 * Проверяем решение, вынесенное из HTTP-роута: мастер-выключатель
 * (`background.enabled`), событие `background.auto_detached` только по факту
 * перевода и «ошибка detach не пробрасывается».
 */
import { describe, it, expect, vi } from 'vitest';
import { autoDetachOnSteer } from './auto-detach.js';
import type { AutoDetachOrchestrator } from './auto-detach.js';
import type { ActiveRunDetachResult } from './active-runs.js';

/** Оркестратор-заглушка с наблюдаемым `detachAll`. */
function makeOrchestrator(result?: ActiveRunDetachResult) {
  const detachAll = vi.fn(async (_sessionId: string): Promise<ActiveRunDetachResult> =>
    result ?? { detached: [], failed: [] });
  const orchestrator: AutoDetachOrchestrator = {
    activeRuns: { detachAll },
  };
  return { orchestrator, detachAll };
}

/** Шина-заглушка с наблюдаемым `publish`. */
function makeEventBus() {
  const publish = vi.fn();
  return { eventBus: { publish } as never, publish };
}

describe('autoDetachOnSteer — ADR-111 §detach', () => {
  it('detachAll не вызывается при background.enabled=false', async () => {
    const { orchestrator, detachAll } = makeOrchestrator();
    const { eventBus, publish } = makeEventBus();

    const result = await autoDetachOnSteer({ orchestrator, sessionId: 's1', enabled: false, eventBus });

    expect(detachAll).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result.detached).toEqual([]);
  });

  it('читает живой мастер-выключатель оркестратора, если enabled не передан', async () => {
    const { orchestrator, detachAll } = makeOrchestrator();
    orchestrator.isBackgroundEnabled = () => false;

    await autoDetachOnSteer({ orchestrator, sessionId: 's1' });

    expect(detachAll).not.toHaveBeenCalled();
  });

  it('переводит прогоны и публикует background.auto_detached в канал сессии', async () => {
    const { orchestrator, detachAll } = makeOrchestrator({
      detached: [
        { id: 'child-1', kind: 'subagent', title: 'Ревью' },
        { id: 'proc-1', kind: 'process' },
      ],
      failed: [],
    });
    const { eventBus, publish } = makeEventBus();

    const result = await autoDetachOnSteer({ orchestrator, sessionId: 's1', enabled: true, eventBus });

    expect(detachAll).toHaveBeenCalledWith('s1');
    expect(result.detached).toHaveLength(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('s1', 'background.auto_detached', {
      session_id: 's1',
      detached: [
        { id: 'child-1', kind: 'subagent', title: 'Ревью' },
        { id: 'proc-1', kind: 'process' },
      ],
    });
  });

  it('не публикует событие при пустом результате', async () => {
    const { orchestrator } = makeOrchestrator({ detached: [], failed: [] });
    const { eventBus, publish } = makeEventBus();

    await autoDetachOnSteer({ orchestrator, sessionId: 's1', enabled: true, eventBus });

    expect(publish).not.toHaveBeenCalled();
  });

  it('ошибка detachAll не пробрасывается (сообщение всё равно ставится)', async () => {
    const detachAll = vi.fn(async () => {
      throw new Error('boom');
    });
    const orchestrator: AutoDetachOrchestrator = { activeRuns: { detachAll } };
    const logger = { warn: vi.fn() };
    const { eventBus, publish } = makeEventBus();

    const result = await autoDetachOnSteer({
      orchestrator,
      sessionId: 's1',
      enabled: true,
      eventBus,
      logger,
    });

    expect(result).toEqual({ detached: [], failed: [] });
    expect(publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('частичный отказ логируется и попадает в failed события', async () => {
    const { orchestrator } = makeOrchestrator({
      detached: [{ id: 'proc-1', kind: 'process' }],
      failed: [{ id: 'child-1', kind: 'subagent', code: 'BACKGROUND_LIMIT' }],
    });
    const logger = { warn: vi.fn() };
    const { eventBus, publish } = makeEventBus();

    await autoDetachOnSteer({ orchestrator, sessionId: 's1', enabled: true, eventBus, logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('s1', 'background.auto_detached', {
      session_id: 's1',
      detached: [{ id: 'proc-1', kind: 'process' }],
      failed: [{ id: 'child-1', kind: 'subagent', code: 'BACKGROUND_LIMIT' }],
    });
  });
});
