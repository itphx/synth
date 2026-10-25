/**
 * Единый шов детекта дочерней сессии (`events/child-session.ts`) — авто-подписка
 * транспортных хабов (managed `EventHub`, standalone `/ws/events`).
 *
 * Проверяется:
 *   • терминальные события фонового саб-агента (`child.completed`/
 *     `child.failed`/`child.cancelled`, этап 1 roadmap 0.13 — блок 4) дают
 *     id ребёнка для авто-подписки;
 *   • прежнее поведение остальных событий не изменилось;
 *   • `extractCreatedSession` — fail-closed: без владельца подписывать нечего.
 */
import { describe, it, expect } from 'vitest';
import { extractChildSessionId, extractCreatedSession } from './child-session.js';

describe('extractChildSessionId — терминальные события фонового саб-агента', () => {
  it('child.completed → id ребёнка', () => {
    expect(extractChildSessionId({
      type: 'child.completed',
      data: {
        child_session_id: 'child-1',
        parent_session_id: 'parent-1',
        state: 'completed',
        background_run_id: 'bgr_1',
      },
    })).toBe('child-1');
  });

  it('child.failed → id ребёнка', () => {
    expect(extractChildSessionId({
      type: 'child.failed',
      data: {
        child_session_id: 'child-2',
        parent_session_id: 'parent-1',
        state: 'failed',
        background_run_id: 'bgr_2',
      },
    })).toBe('child-2');
  });

  it('child.cancelled → id ребёнка', () => {
    expect(extractChildSessionId({
      type: 'child.cancelled',
      data: {
        child_session_id: 'child-3',
        parent_session_id: 'parent-1',
        state: 'cancelled',
        background_run_id: 'bgr_3',
      },
    })).toBe('child-3');
  });

  it('терминальное событие без child_session_id → undefined (fail-closed)', () => {
    expect(extractChildSessionId({ type: 'child.completed', data: {} })).toBeUndefined();
    expect(extractChildSessionId({ type: 'child.failed' })).toBeUndefined();
  });
});

describe('extractChildSessionId — прежнее поведение', () => {
  it('session.created → id из payload сессии', () => {
    expect(extractChildSessionId({ type: 'session.created', data: { id: 'child-1' } })).toBe('child-1');
  });

  it('child.session.updated → id из session или child_session_id', () => {
    expect(extractChildSessionId({
      type: 'child.session.updated',
      data: { session: { id: 'child-1' } },
    })).toBe('child-1');
    expect(extractChildSessionId({
      type: 'child.session.updated',
      data: { child_session_id: 'child-2' },
    })).toBe('child-2');
  });

  it('child.message.added и subagent.resume.* → child_session_id', () => {
    expect(extractChildSessionId({
      type: 'child.message.added',
      data: { child_session_id: 'child-1' },
    })).toBe('child-1');
    expect(extractChildSessionId({
      type: 'subagent.resume.started',
      data: { child_session_id: 'child-1' },
    })).toBe('child-1');
    expect(extractChildSessionId({
      type: 'subagent.resume.finished',
      data: { child_session_id: 'child-1' },
    })).toBe('child-1');
  });

  it('прочие события → undefined', () => {
    expect(extractChildSessionId({ type: 'message.added', data: { child_session_id: 'child-1' } })).toBeUndefined();
    expect(extractChildSessionId({ type: 'stream.done', data: {} })).toBeUndefined();
    expect(extractChildSessionId({ type: 'child.completed', data: { child_session_id: '' } })).toBeUndefined();
  });
});

describe('extractCreatedSession — новая сессия и её владелец', () => {
  it('session.created с owner_id → id и владелец', () => {
    expect(extractCreatedSession({
      type: 'session.created',
      data: { id: 'child-1', owner_id: 'user-1' },
    })).toEqual({ id: 'child-1', owner: 'user-1' });
  });

  it('session.fork.created с user_id (без owner_id) → владелец из user_id', () => {
    expect(extractCreatedSession({
      type: 'session.fork.created',
      data: { id: 'child-1', user_id: 'user-1' },
    })).toEqual({ id: 'child-1', owner: 'user-1' });
  });

  it('без владельца — undefined (fail-closed: подписывать некого)', () => {
    expect(extractCreatedSession({ type: 'session.created', data: { id: 'child-1' } })).toBeUndefined();
    expect(extractCreatedSession({ type: 'session.created', data: { owner_id: 'user-1' } })).toBeUndefined();
    expect(extractCreatedSession({ type: 'session.created' })).toBeUndefined();
  });

  it('не событие создания сессии → undefined', () => {
    expect(extractCreatedSession({
      type: 'child.completed',
      data: { id: 'child-1', owner_id: 'user-1' },
    })).toBeUndefined();
  });
});
