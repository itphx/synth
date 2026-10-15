import { describe, it, expect, vi } from 'vitest';
import type { RouteDecision, Session, SynthEvent } from '@itphx/synth-shared';
import { EventIngress } from './ingest.js';
import type { RequestSessionService } from './request-session.js';

function createMockService(result?: {
  decision?: RouteDecision;
  session?: Session | null;
}): RequestSessionService {
  const decision: RouteDecision = result?.decision ?? { kind: 'bound', sessionId: 's1' };
  const session = result?.session === undefined ? ({ id: 's1' } as Session) : result.session;
  return {
    handleEvent: vi.fn(async () => ({ decision, session })),
  } as unknown as RequestSessionService;
}

describe('EventIngress (ADR-089)', () => {
  it('normalize: id с префиксом evt_, identity/ts/dedupKey по умолчанию', () => {
    const ingress = new EventIngress({ requestSessionService: createMockService() });

    const event = ingress.normalize({ source: 'telegram', type: 'message', payload: { text: 'hi' } });

    expect(event.id.startsWith('evt_')).toBe(true);
    expect(event.id).toHaveLength('evt_'.length + 36);
    expect(event.source).toBe('telegram');
    expect(event.type).toBe('message');
    expect(event.payload).toEqual({ text: 'hi' });
    expect(event.identity).toEqual({});
    expect(typeof event.ts).toBe('string');
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  it('normalize: явные identity/ts/dedupKey не перезаписываются', () => {
    const ingress = new EventIngress({ requestSessionService: createMockService() });
    const ts = '2026-10-08T00:00:00.000Z';

    const event = ingress.normalize({
      source: 'webhook',
      type: 'callback',
      payload: { ok: true },
      identity: { chatKey: 'chat:webhook:1' },
      dedupKey: 'explicit-key',
      ts,
    });

    expect(event.identity).toEqual({ chatKey: 'chat:webhook:1' });
    expect(event.dedupKey).toBe('explicit-key');
    expect(event.ts).toBe(ts);
  });

  it('normalize: dedupKey по умолчанию стабилен для одинакового входа', () => {
    const ingress = new EventIngress({ requestSessionService: createMockService() });
    const input = {
      source: 'telegram',
      type: 'message',
      identity: { chatKey: 'chat:telegram:1' },
      payload: { text: 'hello' },
    };

    const a = ingress.normalize(input);
    const b = ingress.normalize(input);

    expect(a.dedupKey).toBe(b.dedupKey);
    expect(a.id).not.toBe(b.id);
  });

  it('ingest: нормализует и делегирует в handleEvent', async () => {
    const service = createMockService();
    const ingress = new EventIngress({ requestSessionService: service });

    const res = await ingress.ingest({ source: 'ci', type: 'ci_event', payload: { build: 42 } });

    expect(res.event.source).toBe('ci');
    expect(res.decision).toEqual({ kind: 'bound', sessionId: 's1' });
    expect(res.session).toEqual({ id: 's1' });
    expect(service.handleEvent).toHaveBeenCalledOnce();
    const passed = (service.handleEvent as unknown as { mock: { calls: SynthEvent[][] } }).mock.calls[0]![0]!;
    expect(passed.id).toBe(res.event.id);
    expect(passed.source).toBe('ci');
  });

  it('ingest: без сессии (drop) возвращает session null', async () => {
    const service = createMockService({ decision: { kind: 'drop', reason: 'no_route', audited: true }, session: null });
    const ingress = new EventIngress({ requestSessionService: service });

    const res = await ingress.ingest({ source: 'ui', type: 'message' });
    expect(res.session).toBeNull();
  });
});
