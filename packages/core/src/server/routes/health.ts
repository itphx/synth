import { Hono } from 'hono';
import { nowISO, SYNTH_VERSION } from '@itphx/synth-shared';
import { storageHealthFields, type StorageDegradedInfo } from '../storage-degraded.js';

export interface HealthRoutesOptions {
  /**
   * PROP-032 (W5): текущее состояние деградации хранилища. Не задано/`null` —
   * `{status:'healthy'}` (прежний контракт). При деградации — `status:'degraded'`
   * + `storage:{…}` (аддитивно к `{status, version, time}`).
   */
  getStorageDegraded?: () => StorageDegradedInfo | null;
}

export function createHealthRoutes(opts: HealthRoutesOptions = {}): Hono {
  const app = new Hono();

  const health = () => ({
    ...storageHealthFields(opts.getStorageDegraded?.() ?? null),
    version: SYNTH_VERSION,
    time: nowISO(),
  });

  app.get('/health', (c) => c.json(health()));
  app.get('/api/v2/health', (c) => c.json(health()));

  return app;
}
