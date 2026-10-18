import { randomUUID } from 'node:crypto';
import type {
  EventBinding,
  EventIdentity,
  RouteDecision,
  Session,
  SynthEvent,
} from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';
import type { EventMetricsHooks } from '../../metrics/collectors/events.js';
import type { RequestSessionService, IdentityClaimHint } from './request-session.js';

/**
 * ADR-089: вход приёма внешнего события. `id`/`dedupKey`/`ts` необязательны —
 * нормализуются `EventIngress.normalize`.
 */
export interface EventIngestInput {
  source: string;
  type: string;
  payload?: unknown;
  identity?: EventIdentity;
  dedupKey?: string;
  ts?: string;
}

export interface EventIngressDeps {
  requestSessionService: RequestSessionService;
  /** ADR-094: метрики приёма (`synth_events_ingested_total{source,outcome}`). */
  metrics?: EventMetricsHooks;
}

/**
 * Стабильный ключ идемпотентности по умолчанию: `source:type:chatKey|threadKey:payload`.
 * Повтор одного и того же внешнего события (пересланный webhook) даёт тот же ключ.
 */
function defaultDedupKey(input: EventIngestInput, identity: EventIdentity): string {
  let payload = '';
  try {
    payload = JSON.stringify(input.payload) ?? '';
  } catch {
    payload = '';
  }
  const key = identity.threadKey ?? identity.chatKey ?? '';
  return `${input.source}:${input.type}:${key}:${payload}`;
}

/**
 * ADR-089: ingress-точка приёма внешних событий. Нормализует вход во внутренний
 * `SynthEvent` (id `evt_<uuid>`, defaults) и передаёт в единый funnel
 * `RequestSessionService.handleEvent` (Router → материализация → журнал).
 */
export class EventIngress {
  private _requestSessionService: RequestSessionService;
  private _metrics?: EventMetricsHooks;

  constructor(deps: EventIngressDeps) {
    this._requestSessionService = deps.requestSessionService;
    this._metrics = deps.metrics;
  }

  /** Нормализация входа в `SynthEvent` (без побочных эффектов). */
  normalize(input: EventIngestInput): SynthEvent {
    const identity: EventIdentity = input.identity ?? {};
    return {
      id: `evt_${randomUUID()}`,
      source: input.source,
      type: input.type,
      payload: input.payload,
      identity,
      dedupKey: input.dedupKey ?? defaultDedupKey(input, identity),
      ts: input.ts ?? nowISO(),
    };
  }

  /**
   * Нормализация + маршрутизация/материализация через `RequestSessionService`.
   *
   * ADR-089: `opts.binding` (аутентификация по API-ключу привязки) прокидывается
   * в funnel — событие маршрутизируется в эту привязку.
   * ADR-089/ADR-052: `opts.audit` (id ключа/идентичность) прокидывается в журнал.
   * ADR-089: `opts.ownerId` (владелец создаваемой сессии) прокидывается в funnel.
   */
  async ingest(
    input: EventIngestInput,
    opts?: {
      binding?: EventBinding;
      audit?: { keyId?: string; principalId?: string };
      ownerId?: string;
    },
  ): Promise<{
    event: SynthEvent;
    decision: RouteDecision;
    session: Session | null;
    identityHint?: IdentityClaimHint;
  }> {
    const event = this.normalize(input);
    let result: Awaited<ReturnType<RequestSessionService['handleEvent']>>;
    try {
      result = await this._requestSessionService.handleEvent(event, opts);
    } catch (err) {
      // ADR-094: неуспешный приём считается в метриках и пробрасывается дальше.
      this._reportIngest(input.source, 'error');
      throw err;
    }
    this._reportIngest(input.source, 'ok');
    const { decision, session, identityHint } = result;
    return { event, decision, session, ...(identityHint ? { identityHint } : {}) };
  }

  /** ADR-094: ошибки колбэка метрик не влияют на приём события. */
  private _reportIngest(source: string, outcome: 'ok' | 'error'): void {
    try {
      this._metrics?.onIngest({ source, outcome });
    } catch {
      // ignore
    }
  }
}
