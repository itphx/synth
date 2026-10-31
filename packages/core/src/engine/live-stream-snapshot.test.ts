import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  clearLiveStreamSnapshot,
  clearLiveStreamSnapshotByMessage,
  getLiveStreamSnapshot,
  liveStreamSnapshotCount,
  resetLiveStreamSnapshots,
  setLiveStreamSnapshot,
} from './live-stream-snapshot.js';
import { publishStepFinished } from './orchestrator/turn-events.js';

function snapshot(over: Partial<Parameters<typeof setLiveStreamSnapshot>[1]> = {}) {
  return {
    streamId: 'stream-1',
    turnId: 'turn-1',
    messageId: 'msg-1',
    stepIndex: 0,
    content: 'текст',
    parts: [],
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => resetLiveStreamSnapshots());
afterEach(() => vi.useRealTimers());

describe('live-stream-snapshot: снимок живого шага (ADR-118 §5)', () => {
  it('хранит снимок по сессии и отдаёт только для своего стрима', () => {
    setLiveStreamSnapshot('s1', snapshot());
    expect(getLiveStreamSnapshot('s1', 'stream-1')?.content).toBe('текст');
    expect(getLiveStreamSnapshot('s1', 'stream-2')).toBeNull();
    expect(getLiveStreamSnapshot('s1')).not.toBeNull();
    expect(getLiveStreamSnapshot('s2')).toBeNull();
  });

  it('новый шаг заменяет снимок и снимает индекс старого сообщения', () => {
    setLiveStreamSnapshot('s1', snapshot({ messageId: 'msg-1' }));
    setLiveStreamSnapshot('s1', snapshot({ messageId: 'msg-2', stepIndex: 1 }));
    expect(getLiveStreamSnapshot('s1')?.messageId).toBe('msg-2');
    clearLiveStreamSnapshotByMessage('msg-1');
    expect(getLiveStreamSnapshot('s1')?.messageId).toBe('msg-2');
    clearLiveStreamSnapshotByMessage('msg-2');
    expect(getLiveStreamSnapshot('s1')).toBeNull();
    expect(liveStreamSnapshotCount()).toBe(0);
  });

  it('clearLiveStreamSnapshot не снимает чужой шаг', () => {
    setLiveStreamSnapshot('s1', snapshot({ messageId: 'msg-1' }));
    clearLiveStreamSnapshot('s1', 'msg-other');
    expect(getLiveStreamSnapshot('s1')).not.toBeNull();
    clearLiveStreamSnapshot('s1', 'msg-1');
    expect(getLiveStreamSnapshot('s1')).toBeNull();
  });

  it('просроченный снимок не отдаётся (TTL)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
    setLiveStreamSnapshot('s1', snapshot());
    vi.setSystemTime(new Date('2026-10-31T10:40:00Z'));
    expect(getLiveStreamSnapshot('s1')).toBeNull();
    expect(liveStreamSnapshotCount()).toBe(0);
  });

  it('step.finished снимает снимок шага', () => {
    setLiveStreamSnapshot('s1', snapshot({ messageId: 'msg-1' }));
    publishStepFinished(() => {}, {
      turnId: 'turn-1',
      stepIndex: 0,
      messageId: 'msg-1',
      status: 'completed',
    } as never);
    expect(getLiveStreamSnapshot('s1')).toBeNull();
  });
});
