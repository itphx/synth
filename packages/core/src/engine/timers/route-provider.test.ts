/**
 * PROP-141 (Часть B, «Доставка»): правило маршрутизации срабатываний
 * таймеров/будильников (`engine/timers/route-provider.ts`).
 *
 * Срабатывание — внутреннее событие инстанса (`source:'timer'`,
 * `type:'timer_fired'`); сессия-получатель известна заранее (таймер привязан
 * к сессии). Правило всегда возвращает `bound` с режимом доставки `steer` —
 * вклинивание в текущий ход (ADR-113/ADR-104).
 *
 * Чужой источник/тип, пустой или битый payload и отсутствие `sessionId` дают
 * `null`: Router уходит на свой фоллбек (осознанный `drop`), а не доставляет
 * сообщение не туда.
 */
import { describe, it, expect } from 'vitest';
import type { SynthEvent } from '@itphx/synth-shared';
import {
  TimerRuleProvider,
  TIMER_EVENT_SOURCE,
  TIMER_EVENT_TYPE,
} from './route-provider.js';

/** Событие срабатывания таймера. */
const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: TIMER_EVENT_SOURCE,
  type: TIMER_EVENT_TYPE,
  payload: { sessionId: 'ses_1' },
  identity: {},
  dedupKey: 'd',
  ts: '2026-11-17T10:00:00.000Z',
  ...overrides,
});

describe('TimerRuleProvider (PROP-141, Часть B)', () => {
  it('срабатывание таймера → bound+steer в сессию таймера', async () => {
    const provider = new TimerRuleProvider();

    expect(await provider.resolve({ event: event(), bindings: [] })).toEqual({
      kind: 'bound',
      sessionId: 'ses_1',
      delivery: 'steer',
      reason: 'timer',
    });
  });

  it('чужой source → null', async () => {
    const provider = new TimerRuleProvider();

    expect(
      await provider.resolve({ event: event({ source: 'cron' }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ source: 'telegram' }), bindings: [] }),
    ).toBeNull();
  });

  it('чужой type → null', async () => {
    const provider = new TimerRuleProvider();

    expect(
      await provider.resolve({ event: event({ type: 'schedule_fired' }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ type: 'message' }), bindings: [] }),
    ).toBeNull();
  });

  it('пустой payload → null', async () => {
    const provider = new TimerRuleProvider();

    expect(
      await provider.resolve({ event: event({ payload: {} }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ payload: null }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ payload: 'строка' }), bindings: [] }),
    ).toBeNull();
  });

  it('битый payload (sessionId не строка) → null', async () => {
    const provider = new TimerRuleProvider();

    expect(
      await provider.resolve({ event: event({ payload: { sessionId: 42 } }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ payload: { sessionId: null } }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ payload: { sessionId: {} } }), bindings: [] }),
    ).toBeNull();
  });

  it('пустой/пробельный sessionId → null', async () => {
    const provider = new TimerRuleProvider();

    expect(
      await provider.resolve({ event: event({ payload: { sessionId: '' } }), bindings: [] }),
    ).toBeNull();
    expect(
      await provider.resolve({ event: event({ payload: { sessionId: '   ' } }), bindings: [] }),
    ).toBeNull();
  });

  it('sessionId обрезается от пробелов', async () => {
    const provider = new TimerRuleProvider();

    expect(
      await provider.resolve({ event: event({ payload: { sessionId: ' ses_1 ' } }), bindings: [] }),
    ).toEqual({
      kind: 'bound',
      sessionId: 'ses_1',
      delivery: 'steer',
      reason: 'timer',
    });
  });
});
