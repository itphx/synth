import { describe, it, expect } from 'vitest';
import {
  isValidTimezone,
  nextDailyFire,
  nextEveryFire,
  nextFireForRepeat,
  resolveFirstFire,
} from './next-fire.js';
import { TimerValidationError } from './types.js';
import type { TimerIntent } from './types.js';

/** Интент одноразового таймера (вспомогательное). */
function timerIntent(overrides: Partial<TimerIntent> = {}): TimerIntent {
  return {
    kind: 'timer',
    comment: 'проверка',
    projectId: 'prj_1',
    sessionId: 'ses_1',
    ownerId: 'user_1',
    repeat: { mode: 'once' },
    delaySec: 60,
    ...overrides,
  };
}

describe('isValidTimezone (PROP-141)', () => {
  it('принимает IANA-пояса и UTC', () => {
    expect(isValidTimezone('Europe/Moscow')).toBe(true);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('отклоняет неизвестный пояс и пустое значение (не молчаливый UTC)', () => {
    expect(isValidTimezone('Mars/Phobos')).toBe(false);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('nextDailyFire (PROP-141)', () => {
  it('сегодня, если время суток ещё не наступило', () => {
    // 2026-11-17T00:00Z — 03:00 по Москве.
    const now = new Date('2026-11-17T00:00:00.000Z');
    const next = nextDailyFire('09:00', 'Europe/Moscow', now);
    expect(next.toISOString()).toBe('2026-11-17T06:00:00.000Z');
  });

  it('завтра, если время суток уже прошло', () => {
    // 13:00 по Москве.
    const now = new Date('2026-11-17T10:00:00.000Z');
    const next = nextDailyFire('09:00', 'Europe/Moscow', now);
    expect(next.toISOString()).toBe('2026-11-18T06:00:00.000Z');
  });

  it('строго после now: ровно в момент срабатывания — следующий день', () => {
    const now = new Date('2026-11-17T06:00:00.000Z');
    const next = nextDailyFire('09:00', 'Europe/Moscow', now);
    expect(next.toISOString()).toBe('2026-11-18T06:00:00.000Z');
  });

  it('DST: переход на летнее время (Europe/Berlin) — настенное время сохраняется', () => {
    // 2026-03-29: 02:00 CET → 03:00 CEST. Будильник на 03:30 → 01:30Z.
    const now = new Date('2026-03-28T12:00:00.000Z');
    const next = nextDailyFire('03:30', 'Europe/Berlin', now);
    expect(next.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('DST: несуществующее время суток сдвигается вперёд на разрыв', () => {
    // 02:30 в день перехода не существует → 03:30 CEST (01:30Z).
    const now = new Date('2026-03-29T00:00:00.000Z');
    const next = nextDailyFire('02:30', 'Europe/Berlin', now);
    expect(next.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('DST: неоднозначное время суток — первое вхождение', () => {
    // 2026-10-25: 03:00 CEST → 02:00 CET; 02:30 встречается дважды.
    const now = new Date('2026-10-25T00:00:00.000Z');
    const next = nextDailyFire('02:30', 'Europe/Berlin', now);
    expect(next.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('невалидное время суток — ошибка с кодом', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    expect(() => nextDailyFire('24:00', 'Europe/Moscow', now)).toThrow(TimerValidationError);
    expect(() => nextDailyFire('9:00', 'Europe/Moscow', now)).toThrow(TimerValidationError);
    try {
      nextDailyFire('24:00', 'Europe/Moscow', now);
    } catch (err) {
      expect((err as TimerValidationError).code).toBe('timer_invalid_time');
    }
  });

  it('невалидный часовой пояс — ошибка с кодом (не молчаливый UTC)', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    try {
      nextDailyFire('09:00', 'Mars/Phobos', now);
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(TimerValidationError);
      expect((err as TimerValidationError).code).toBe('timer_invalid_timezone');
    }
  });
});

describe('nextEveryFire (PROP-141)', () => {
  it('интервал отсчитывается от текущего момента', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    expect(nextEveryFire(60, now).toISOString()).toBe('2026-11-17T10:01:00.000Z');
    expect(nextEveryFire(10, now).toISOString()).toBe('2026-11-17T10:00:10.000Z');
  });
});

describe('nextFireForRepeat (PROP-141)', () => {
  it('daily/every — по правилу, once — без следующего срабатывания', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    expect(nextFireForRepeat({ mode: 'every', everySec: 30 }, now)?.toISOString()).toBe(
      '2026-11-17T10:00:30.000Z',
    );
    expect(
      nextFireForRepeat({ mode: 'daily', time: '23:30', timezone: 'Europe/Moscow' }, now)?.toISOString(),
    ).toBe('2026-11-17T20:30:00.000Z');
    expect(nextFireForRepeat({ mode: 'once' }, now)).toBeNull();
  });
});

describe('resolveFirstFire (PROP-141)', () => {
  it('одноразовый таймер — задержка от now', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    const next = resolveFirstFire(timerIntent({ delaySec: 120 }), now);
    expect(next.toISOString()).toBe('2026-11-17T10:02:00.000Z');
  });

  it('одноразовый будильник — абсолютное время', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    const next = resolveFirstFire(
      timerIntent({
        kind: 'alarm',
        repeat: { mode: 'once' },
        at: '2026-11-17T12:00:00.000Z',
      }),
      now,
    );
    expect(next.toISOString()).toBe('2026-11-17T12:00:00.000Z');
  });

  it('будильник без абсолютного времени — ошибка с кодом', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    try {
      resolveFirstFire(timerIntent({ kind: 'alarm', repeat: { mode: 'once' }, delaySec: undefined }), now);
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(TimerValidationError);
      expect((err as TimerValidationError).code).toBe('timer_invalid_target');
    }
  });

  it('daily/every — по правилу повтора', () => {
    const now = new Date('2026-11-17T10:00:00.000Z');
    expect(
      resolveFirstFire(
        timerIntent({ kind: 'alarm', repeat: { mode: 'every', everySec: 45 }, delaySec: undefined }),
        now,
      ).toISOString(),
    ).toBe('2026-11-17T10:00:45.000Z');
    expect(
      resolveFirstFire(
        timerIntent({
          kind: 'alarm',
          repeat: { mode: 'daily', time: '08:00', timezone: 'Europe/Moscow' },
          delaySec: undefined,
        }),
        now,
      ).toISOString(),
    ).toBe('2026-11-18T05:00:00.000Z');
  });
});
