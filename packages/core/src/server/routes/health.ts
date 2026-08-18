import { Hono } from 'hono';
import { nowISO, SYNTH_VERSION } from '@itphx/shared';

export function createHealthRoutes(): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'healthy', version: SYNTH_VERSION, time: nowISO() }));
  app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: SYNTH_VERSION, time: nowISO() }));

  return app;
}
