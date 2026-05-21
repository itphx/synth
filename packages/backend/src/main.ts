import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

app.use(logger());
app.use(cors({ origin: '*', credentials: true }));

app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: '0.1.0' }));

const port = parseInt(process.env.PORT || '5000', 10);
console.log(`synth-backend starting on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
