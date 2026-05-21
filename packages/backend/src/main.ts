import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { nowISO } from '@synth/shared';
import { loadAuthConfig } from './auth/config.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { createAuthRoutes } from './routes/auth.js';

const app = new Hono();

app.use(logger());
app.use(cors({ origin: '*', credentials: true }));

// Health (без auth)
app.get('/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));
app.get('/api/v2/health', (c) => c.json({ status: 'healthy', version: '0.1.0', time: nowISO() }));

// Auth system
const config = loadAuthConfig();
const auth = createAuthMiddleware(config);

// Прикрепляем пользователя ко всем запросам
app.use('*', auth.attachUser);

// Auth routes (без auth middleware, сами проверяют)
app.route('/auth', createAuthRoutes(auth, config));

// API-заглушки для UI
app.get('/api/config/themes', (c) => c.json({ themes: [] }));
app.get('/api/v2/providers', (c) => c.json({ providers: [], default_provider: '' }));
app.get('/api/v2/models', (c) => c.json({ models: [], default_model: '' }));
app.get('/api/v2/agents', (c) => c.json({ agents: [], default_agent: null }));
app.get('/api/v2/i18n/current', (c) => c.json({ language: 'ru', locale: 'ru' }));
app.get('/api/v2/i18n/translations/ru', (c) => c.json({}));
app.get('/api/v2/i18n/translations/en', (c) => c.json({}));

// Protected routes
// TODO: sessions, projects, queue, fs — наполнить из @synth/core
app.get('/api/v2/sessions', auth.requireAuth, (c) => c.json([]));
app.get('/api/v2/projects', auth.requireAuth, (c) => c.json([]));

// Admin routes
app.get('/admin/sessions/blocked', auth.requireAdmin, (c) => c.json({ sessions: [], count: 0 }));

// 404
app.notFound((c) => {
  return c.json({ error: { code: 'NOT_FOUND', message: `Не найдено: ${c.req.method} ${c.req.path}` } }, 404);
});

const port = parseInt(process.env.PORT || '5000', 10);
console.log(`synth-backend starting on http://localhost:${port}`);
console.log(`  debug mode: ${config.debugMode}`);
if (config.debugMode) {
  console.log('  test users:');
  config.testUsers?.forEach((u) => {
    console.log(`    ${u.username} [${u.roles.join(', ')}] → key: ${u.apiKey.slice(0, 8)}...`);
  });
}

serve({ fetch: app.fetch, port });
