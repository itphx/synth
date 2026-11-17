import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Timer, TimerFiring } from '@itphx/synth-shared';
import { MemoryTimerFiringRepository, MemoryTimerRepository } from '../../storage/memory/timers.js';
import { MetricsRegistry } from '../../metrics/registry.js';
import { createTimerMetrics } from '../../metrics/collectors/timers.js';
import { AlwaysLeader } from '../scheduler/leader.js';
import type { SchedulerLeader } from '../scheduler/leader.js';
import { TimerService } from './service.js';
import type { TimerEventPublisher } from './service.js';
import { TimerLimitExceededError, TimerValidationError } from './types.js';
import type { TimerIntent } from './types.js';

/** Запись доставленного срабатывания (для проверок). */
interface Delivered {
  timer: Timer;
  firing: TimerFiring;
  catchup: boolean;
}

/** Пойманное live-событие таймера (канал сессии). */
interface TimerEvent {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
}

/** Лидер, который не становится лидером (проверка «не-лидер не тикает»). */
const NOT_LEADER: SchedulerLeader = {
  acquire: async () => false,
  touch: async () => {},
  release: async () => {},
};

/** Собрать сервис поверх in-memory портов. */
function makeService(
  opts: {
    deliver?: (timer: Timer, firing: TimerFiring, meta: { catchup: boolean }) => Promise<void>;
    leader?: SchedulerLeader;
    metrics?: ReturnType<typeof createTimerMetrics>;
    onEvent?: TimerEventPublisher;
  } = {},
) {
  const timers = new MemoryTimerRepository();
  const firings = new MemoryTimerFiringRepository();
  const delivered: Delivered[] = [];
  const service = new TimerService({
    timers,
    firings,
    deliver:
      opts.deliver ??
      (async (timer, firing, meta) => {
        delivered.push({ timer, firing, catchup: meta.catchup });
      }),
    leader: opts.leader,
    metrics: opts.metrics,
    onEvent: opts.onEvent,
  });
  return { service, timers, firings, delivered };
}

/** Захват live-событий таймера (публикация в канал сессии). */
function captureEvents(): { events: TimerEvent[]; onEvent: TimerEventPublisher } {
  const events: TimerEvent[] = [];
  return {
    events,
    onEvent: (sessionId, type, data) => {
      events.push({ sessionId, type, data });
    },
  };
}

/** Интент одноразового таймера. */
function intent(overrides: Partial<TimerIntent> = {}): TimerIntent {
  return {
    kind: 'timer',
    comment: 'проверка таймера',
    projectId: 'prj_1',
    sessionId: 'ses_1',
    ownerId: 'user_1',
    repeat: { mode: 'once' },
    delaySec: 60,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TimerService: точность срабатывания (PROP-141)', () => {
  // Минимальная задержка пользовательского таймера — 10 с (PROP-141), поэтому
  // точность проверяется на записи, созданной напрямую в порту: задача движка
  // — сработать вовремя, а не гонять допустимые интервалы.
  it('таймер на 2 с срабатывает в пределах ±1 с', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, delivered } = makeService();
    await timers.create({
      kind: 'timer',
      comment: 'точность 2 с',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'once' },
      firesAt: '2026-11-17T10:00:02.000Z',
    });
    await service.start();

    await vi.advanceTimersByTimeAsync(2000);

    expect(delivered).toHaveLength(1);
    const firedAt = Date.parse(delivered[0]!.firing.firedAt);
    expect(Math.abs(firedAt - Date.parse('2026-11-17T10:00:02.000Z'))).toBeLessThanOrEqual(1000);
    await service.stop();
  });

  it('таймер на 1 с срабатывает в пределах ±1 с', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, delivered } = makeService();
    await timers.create({
      kind: 'timer',
      comment: 'точность 1 с',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'once' },
      firesAt: '2026-11-17T10:00:01.000Z',
    });
    await service.start();

    await vi.advanceTimersByTimeAsync(1000);

    expect(delivered).toHaveLength(1);
    const firedAt = Date.parse(delivered[0]!.firing.firedAt);
    expect(Math.abs(firedAt - Date.parse('2026-11-17T10:00:01.000Z'))).toBeLessThanOrEqual(1000);
    await service.stop();
  });
});

describe('TimerService: catch-up после рестарта (PROP-141)', () => {
  it('просроченный one-shot срабатывает ровно один раз (catchup)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, firings, delivered } = makeService();
    const created = await timers.create({
      kind: 'timer',
      comment: 'просроченный',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'once' },
      firesAt: '2026-11-17T09:55:00.000Z',
    });

    await service.start();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.catchup).toBe(true);

    // Повторные тики не дают второго срабатывания.
    await service.tick();
    await service.tick();
    expect(delivered).toHaveLength(1);

    const stored = await timers.get(created.id);
    expect(stored?.status).toBe('fired');
    expect(stored?.firedAt).toBeTruthy();

    const history = await firings.list(created.id, 20);
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('ok');
    expect(history[0]?.scheduledFor).toBe('2026-11-17T09:55:00.000Z');

    await service.stop();
  });

  it('просроченный повторяющийся таймер не догоняет серию: один пересчёт', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, delivered } = makeService();
    const created = await timers.create({
      kind: 'alarm',
      comment: 'каждые минуту',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'every', everySec: 60 },
      firesAt: '2026-11-17T09:00:00.000Z',
    });

    await service.start();
    // Серии догонов нет — срабатывания не было.
    expect(delivered).toHaveLength(0);

    const afterStart = await timers.get(created.id);
    expect(afterStart?.status).toBe('active');
    expect(afterStart?.firesAt).toBe('2026-11-17T10:01:00.000Z');

    // Ровно один следующий цикл.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delivered).toHaveLength(1);

    await service.stop();
  });

  it('долгий простой вживую: один цикл, без «залпа»', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, delivered } = makeService();
    const created = await timers.create({
      kind: 'alarm',
      comment: 'каждые минуту',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'every', everySec: 60 },
      firesAt: '2026-11-17T10:00:00.000Z',
    });
    await service.start();

    // Простой в 5 минут: тик приходит позже, но серия не «догоняется».
    await service.tick(new Date('2026-11-17T10:05:00.000Z'));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.catchup).toBe(true);

    const stored = await timers.get(created.id);
    expect(stored?.status).toBe('active');
    // Следующий цикл — от фактического момента, а не серия просроченных окон.
    expect(stored?.firesAt).toBe('2026-11-17T10:06:00.000Z');

    await service.tick(new Date('2026-11-17T10:05:30.000Z'));
    expect(delivered).toHaveLength(1);

    await service.stop();
  });
});

describe('TimerService: дедуп (PROP-141)', () => {
  it('повторное срабатывание на том же scheduledFor не доставляется', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, firings, delivered } = makeService();
    const created = await timers.create({
      kind: 'timer',
      comment: 'дедуп',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'once' },
      firesAt: '2026-11-17T10:00:05.000Z',
    });

    await service.start();
    await service.tick(new Date('2026-11-17T10:00:06.000Z'));
    expect(delivered).toHaveLength(1);

    // Запись «залипла» активной (обновление статуса не прошло) — повторный
    // тик на том же `scheduledFor` не должен доставить второе сообщение.
    await timers.setStatus(created.id, 'active', { firesAt: '2026-11-17T10:00:05.000Z' });
    await service.tick(new Date('2026-11-17T10:00:07.000Z'));

    expect(delivered).toHaveLength(1);
    expect(await firings.list(created.id, 20)).toHaveLength(1);

    await service.stop();
  });

  it('история срабатываний блокирует повторную доставку после рестарта', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, firings, delivered } = makeService();
    const created = await timers.create({
      kind: 'timer',
      comment: 'уже сработал',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      ownerId: 'user_1',
      repeat: { mode: 'once' },
      firesAt: '2026-11-17T09:59:00.000Z',
    });
    await firings.append({
      id: 'tmf_prev',
      timerId: created.id,
      firedAt: '2026-11-17T09:59:01.000Z',
      scheduledFor: '2026-11-17T09:59:00.000Z',
      lagMs: 1000,
      outcome: 'ok',
      sessionId: 'ses_1',
    });

    await service.start();
    expect(delivered).toHaveLength(0);

    await service.stop();
  });
});

describe('TimerService: лимиты и валидация (PROP-141)', () => {
  it('не более 50 активных таймеров на сессию', async () => {
    const { service } = makeService();
    for (let i = 0; i < 50; i += 1) {
      await service.createTimer(intent({ delaySec: 600 }));
    }
    await expect(service.createTimer(intent({ delaySec: 600 }))).rejects.toBeInstanceOf(
      TimerLimitExceededError,
    );
  });

  it('комментарий: 1…500 символов', async () => {
    const { service } = makeService();
    await expect(service.createTimer(intent({ comment: '' }))).rejects.toBeInstanceOf(
      TimerValidationError,
    );
    await expect(
      service.createTimer(intent({ comment: 'x'.repeat(501) })),
    ).rejects.toBeInstanceOf(TimerValidationError);
    await expect(service.createTimer(intent({ comment: 'x'.repeat(500) }))).resolves.toBeTruthy();
  });

  it('минимальный интервал — 10 с', async () => {
    const { service } = makeService();
    await expect(service.createTimer(intent({ delaySec: 9 }))).rejects.toBeInstanceOf(
      TimerValidationError,
    );
    await expect(
      service.createTimer(
        intent({ kind: 'alarm', repeat: { mode: 'every', everySec: 9 }, delaySec: undefined }),
      ),
    ).rejects.toBeInstanceOf(TimerValidationError);
  });

  it('горизонт one-shot — не более 30 суток', async () => {
    const { service } = makeService();
    await expect(
      service.createTimer(intent({ delaySec: 30 * 86_400 + 1 })),
    ).rejects.toBeInstanceOf(TimerValidationError);
    await expect(
      service.createTimer(
        intent({
          kind: 'alarm',
          repeat: { mode: 'once' },
          delaySec: undefined,
          at: new Date(Date.now() + 31 * 86_400_000).toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(TimerValidationError);
  });

  it('невалидный часовой пояс и невалидное HH:MM — отказ', async () => {
    const { service } = makeService();
    await expect(
      service.createTimer(
        intent({
          kind: 'alarm',
          repeat: { mode: 'daily', time: '09:00', timezone: 'Mars/Phobos' },
          delaySec: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(TimerValidationError);
    await expect(
      service.createTimer(
        intent({
          kind: 'alarm',
          repeat: { mode: 'daily', time: '25:00', timezone: 'Europe/Moscow' },
          delaySec: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(TimerValidationError);
  });

  it('sessionId/projectId/ownerId обязательны', async () => {
    const { service } = makeService();
    await expect(service.createTimer(intent({ sessionId: '' }))).rejects.toBeInstanceOf(
      TimerValidationError,
    );
    await expect(service.createTimer(intent({ projectId: '' }))).rejects.toBeInstanceOf(
      TimerValidationError,
    );
    await expect(service.createTimer(intent({ ownerId: '' }))).rejects.toBeInstanceOf(
      TimerValidationError,
    );
  });

  it('ошибки несут машинный код', async () => {
    const { service } = makeService();
    try {
      await service.createTimer(intent({ delaySec: 1 }));
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(TimerValidationError);
      expect((err as TimerValidationError).code).toBe('timer_invalid_interval');
    }
  });
});

describe('TimerService: каскад удаления сессии (PROP-141)', () => {
  it('записи сняты, история срабатываний осталась', async () => {
    const { service, timers, firings } = makeService();
    const created = await service.createTimer(intent());
    await firings.append({
      id: 'tmf_1',
      timerId: created.id,
      firedAt: '2026-11-17T09:00:00.000Z',
      scheduledFor: '2026-11-17T09:00:00.000Z',
      lagMs: 0,
      outcome: 'ok',
      sessionId: 'ses_1',
    });

    const removed = await service.onSessionDeleted('ses_1');
    expect(removed).toBe(1);
    expect(await timers.get(created.id)).toBeNull();
    expect(await firings.list(created.id, 20)).toHaveLength(1);
  });
});

describe('TimerService: лидерство (PROP-141)', () => {
  it('не-лидер не тикает', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, delivered } = makeService({ leader: NOT_LEADER });
    await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await service.tick();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(delivered).toHaveLength(0);
    await service.stop();
  });

  it('лидер (AlwaysLeader) тикает', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, delivered } = makeService({ leader: new AlwaysLeader() });
    await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(delivered).toHaveLength(1);
    await service.stop();
  });
});

describe('TimerService: ошибка доставки (PROP-141)', () => {
  it('one-shot: outcome error, lastError, статус fired (без зацикливания)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, firings } = makeService({
      deliver: async () => {
        throw new Error('доставка недоступна');
      },
    });
    const created = await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const stored = await timers.get(created.id);
    expect(stored?.status).toBe('fired');
    expect(stored?.lastError).toContain('доставка недоступна');

    const history = await firings.list(created.id, 20);
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('error');

    await service.stop();
  });

  it('повторяющийся: ошибка не останавливает цикл — следующее срабатывание переносится', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, timers, firings } = makeService({
      deliver: async () => {
        throw new Error('доставка недоступна');
      },
    });
    const created = await service.createTimer(
      intent({ kind: 'alarm', repeat: { mode: 'every', everySec: 60 }, delaySec: undefined }),
    );
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    const stored = await timers.get(created.id);
    expect(stored?.status).toBe('active');
    expect(stored?.lastError).toContain('доставка недоступна');
    // Сработавшее окно 10:01 → следующий цикл 10:02 (сетка не сдвигается).
    expect(stored?.firesAt).toBe('2026-11-17T10:02:00.000Z');

    const history = await firings.list(created.id, 20);
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('error');

    await service.stop();
  });
});

describe('TimerService: жизненный цикл (PROP-141)', () => {
  it('пауза снимает таймер из расписания, возобновление возвращает', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, delivered } = makeService();
    const created = await service.createTimer(
      intent({ kind: 'alarm', repeat: { mode: 'every', everySec: 60 }, delaySec: undefined }),
    );
    await service.start();

    const paused = await service.pauseTimer(created.id);
    expect(paused?.status).toBe('paused');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(delivered).toHaveLength(0);

    const resumed = await service.resumeTimer(created.id);
    expect(resumed?.status).toBe('active');
    // Ближайшее срабатывание пересчитано от текущего времени (10:02:00).
    expect(resumed?.firesAt).toBe('2026-11-17T10:03:00.000Z');

    await service.stop();
  });

  it('одноразовый таймер после паузы сохраняет плановую метку (срабатывает как догон)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, delivered } = makeService();
    const created = await service.createTimer(intent({ delaySec: 60 }));
    await service.start();

    await service.pauseTimer(created.id);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(delivered).toHaveLength(0);

    const resumed = await service.resumeTimer(created.id);
    expect(resumed?.status).toBe('active');
    expect(resumed?.firesAt).toBe('2026-11-17T10:01:00.000Z');

    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.catchup).toBe(true);

    await service.stop();
  });

  it('правка правила повтора пересчитывает ближайшее срабатывание', async () => {
    const { service } = makeService();
    const created = await service.createTimer(intent({ delaySec: 3600 }));

    const updated = await service.updateTimer(created.id, {
      repeat: { mode: 'every', everySec: 120 },
    });
    expect(updated?.repeat.mode).toBe('every');
    expect(Date.parse(updated?.firesAt ?? '')).toBeGreaterThan(0);
  });

  it('удаление снимает запись', async () => {
    const { service, timers } = makeService();
    const created = await service.createTimer(intent());
    expect(await service.removeTimer(created.id)).toBe(true);
    expect(await timers.get(created.id)).toBeNull();
    expect(await service.removeTimer(created.id)).toBe(false);
  });
});

describe('TimerService: метрики (ADR-094 / PROP-141)', () => {
  it('активные таймеры и срабатывания попадают в реестр метрик', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const registry = new MetricsRegistry();
    const metrics = createTimerMetrics(registry);
    const { service } = makeService({ metrics });

    await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const text = registry.render().text;
    expect(text).toContain('synth_timer_active');
    expect(text).toContain('synth_timer_firings_total');
    expect(text).toContain('synth_timer_lag_seconds');
    expect(text).toContain('kind="timer"');
    expect(text).toContain('outcome="ok"');

    await service.stop();
  });
});

/**
 * PROP-141 (Часть B): live-события таймеров в канале сессии.
 *
 * Типы — `timer.created`/`timer.updated`/`timer.fired`/`timer.cancelled`.
 * Payload — **только метаданные**: комментарий таймера (пользовательский
 * текст) в live-событие не попадает.
 */
describe('TimerService: live-события (PROP-141, Часть B)', () => {
  it('createTimer публикует timer.created без комментария', async () => {
    const { events, onEvent } = captureEvents();
    const { service } = makeService({ onEvent });

    const created = await service.createTimer(intent({ delaySec: 600 }));

    const createdEvents = events.filter((e) => e.type === 'timer.created');
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]!.sessionId).toBe('ses_1');
    expect(createdEvents[0]!.data).toMatchObject({
      timer_id: created.id,
      kind: 'timer',
      project_id: 'prj_1',
      session_id: 'ses_1',
      status: 'active',
    });
    expect(typeof createdEvents[0]!.data.fires_at).toBe('string');
    // Пользовательский текст в live-событие не уходит.
    expect(createdEvents[0]!.data.comment).toBeUndefined();
    expect('comment' in createdEvents[0]!.data).toBe(false);
  });

  it('updateTimer публикует timer.updated', async () => {
    const { events, onEvent } = captureEvents();
    const { service } = makeService({ onEvent });
    const created = await service.createTimer(intent({ delaySec: 3600 }));

    await service.updateTimer(created.id, { repeat: { mode: 'every', everySec: 120 } });

    const updated = events.filter((e) => e.type === 'timer.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.sessionId).toBe('ses_1');
    expect(updated[0]!.data.timer_id).toBe(created.id);
    expect(updated[0]!.data.comment).toBeUndefined();
  });

  it('pauseTimer публикует timer.updated со статусом paused', async () => {
    const { events, onEvent } = captureEvents();
    const { service } = makeService({ onEvent });
    const created = await service.createTimer(intent({ delaySec: 600 }));

    await service.pauseTimer(created.id);

    const updated = events.filter((e) => e.type === 'timer.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.data).toMatchObject({
      timer_id: created.id,
      status: 'paused',
    });
    expect(updated[0]!.data.comment).toBeUndefined();
  });

  it('removeTimer публикует timer.cancelled со статусом cancelled', async () => {
    const { events, onEvent } = captureEvents();
    const { service } = makeService({ onEvent });
    const created = await service.createTimer(intent({ delaySec: 600 }));

    await service.removeTimer(created.id);

    const cancelled = events.filter((e) => e.type === 'timer.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.sessionId).toBe('ses_1');
    expect(cancelled[0]!.data).toMatchObject({
      timer_id: created.id,
      status: 'cancelled',
    });
    expect(cancelled[0]!.data.comment).toBeUndefined();
  });

  it('успешное срабатывание публикует timer.fired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { events, onEvent } = captureEvents();
    const { service, delivered } = makeService({ onEvent });
    const created = await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(delivered).toHaveLength(1);
    const fired = events.filter((e) => e.type === 'timer.fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.sessionId).toBe('ses_1');
    expect(fired[0]!.data.timer_id).toBe(created.id);
    expect(typeof fired[0]!.data.fired_at).toBe('string');
    expect(typeof fired[0]!.data.scheduled_for).toBe('string');
    expect(fired[0]!.data.comment).toBeUndefined();

    await service.stop();
  });

  it('ошибка доставки: timer.fired опубликован, outcome=error, lastError, one-shot → fired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { events, onEvent } = captureEvents();
    const { service, timers, firings } = makeService({
      onEvent,
      deliver: async () => {
        throw new Error('доставка недоступна');
      },
    });
    const created = await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    // Live-событие срабатывания публикуется и при ошибке доставки.
    const fired = events.filter((e) => e.type === 'timer.fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data.timer_id).toBe(created.id);
    expect(fired[0]!.data.comment).toBeUndefined();

    const history = await firings.list(created.id, 20);
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('error');

    const stored = await timers.get(created.id);
    expect(stored?.status).toBe('fired');
    expect(stored?.lastError).toContain('доставка недоступна');

    await service.stop();
  });

  it('ошибка доставки у повторяющегося: цикл переносится, запись остаётся активной', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { events, onEvent } = captureEvents();
    const { service, timers, firings } = makeService({
      onEvent,
      deliver: async () => {
        throw new Error('доставка недоступна');
      },
    });
    const created = await service.createTimer(
      intent({ kind: 'alarm', repeat: { mode: 'every', everySec: 60 }, delaySec: undefined }),
    );
    await service.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events.filter((e) => e.type === 'timer.fired')).toHaveLength(1);

    const history = await firings.list(created.id, 20);
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('error');

    const stored = await timers.get(created.id);
    expect(stored?.status).toBe('active');
    expect(stored?.lastError).toContain('доставка недоступна');
    // Сработавшее окно 10:01 → следующий цикл 10:02 (сетка не сдвигается).
    expect(stored?.firesAt).toBe('2026-11-17T10:02:00.000Z');

    await service.stop();
  });

  it('без onEvent движок работает как раньше (события не публикуются)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T10:00:00.000Z'));

    const { service, delivered } = makeService();
    await service.createTimer(intent({ delaySec: 10 }));
    await service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(delivered).toHaveLength(1);

    await service.stop();
  });
});
