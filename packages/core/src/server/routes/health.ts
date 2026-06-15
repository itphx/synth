import { Hono } from 'hono';
import { nowISO } from '@synth/shared';

export function createHealthRoutes(): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));
  app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));

  return app;
}
