import { Hono } from 'hono';
import { nowISO, SYNTH_VERSION } from '@itphx/synth-shared';
import { storageHealthFields, type StorageDegradedInfo } from '../storage-degraded.js';
import { getProcessStartedAt } from '../restart.js';

/**
 * ADR-094: состояние readiness.
 * - `ready` — приложение инициализировано и обслуживает трафик;
 * - `storage` — `ok` | `degraded` (деградация **не** снимает readiness —
 *   read-only-инстанс остаётся доступным для диагностики, ADR-098);
 * - `checks` — необязательная детализация причин (для диагностики).
 */
export interface ReadinessState {
  ready: boolean;
  storage: 'ok' | 'degraded';
  checks?: Record<string, string>;
}

export interface HealthRoutesOptions {
  /**
   * PROP-032 (W5): текущее состояние деградации хранилища. Не задано/`null` —
   * `{status:'healthy'}` (прежний контракт). При деградации — `status:'degraded'`
   * + `storage:{…}` (аддитивно к `{status, version, time}`).
   */
  getStorageDegraded?: () => StorageDegradedInfo | null;
  /**
   * ADR-094: readiness (`GET /ready`). Не задано — готовность считается
   * наступившей (`ready:true`), `storage` выводится из `getStorageDegraded`.
   * 503 отдаётся **только** при `ready:false` (старт не завершён/fail-closed).
   */
  getReadiness?: () => ReadinessState;
}

export function createHealthRoutes(opts: HealthRoutesOptions = {}): Hono {
  const app = new Hono();

  const health = () => ({
    ...storageHealthFields(opts.getStorageDegraded?.() ?? null),
    version: SYNTH_VERSION,
    // Restart: ISO старта процесса — UI сравнивает до/после рестарта.
    startedAt: getProcessStartedAt(),
    time: nowISO(),
  });

  const readiness = (): { body: Record<string, unknown>; status: 200 | 503 } => {
    const state: ReadinessState = opts.getReadiness?.() ?? {
      ready: true,
      storage: opts.getStorageDegraded?.() ? 'degraded' : 'ok',
    };
    return {
      body: {
        status: state.ready ? 'ready' : 'not_ready',
        storage: state.storage,
        version: SYNTH_VERSION,
        startedAt: getProcessStartedAt(),
        time: nowISO(),
        ...(state.checks ? { checks: state.checks } : {}),
      },
      status: state.ready ? 200 : 503,
    };
  };

  app.get('/health', (c) => c.json(health()));
  app.get('/api/v2/health', (c) => c.json(health()));
  app.get('/ready', (c) => {
    const result = readiness();
    return c.json(result.body, result.status);
  });

  return app;
}
