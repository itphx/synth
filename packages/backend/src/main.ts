// Точка входа synth-backend. Тонкая обёртка над фабрикой createBackendApp
// (см. app.ts): строит приложение, слушает порт, обрабатывает graceful shutdown.
// Всё построение Hono-app (конфиг → auth → stores → orchestrator → routes)
// живёт в app.ts — это позволяет поднимать backend in-process в интеграционных
// тестах без запуска процесса.

import { createBackendApp } from './app.js';

const host = process.env.SYNTH_HOST || '0.0.0.0';

const handle = await createBackendApp();
const { app, dataDir, port, config, auth, eventHub, queueManager, sessionManager, stopEphemeralSweeper } = handle;

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] Получен сигнал ${signal}, начинаю graceful shutdown...`);

  server.close((err) => {
    if (err) console.error('[Shutdown] Server close error:', err);
  });
  console.log('[Shutdown] HTTP сервер больше не принимает соединения');

  eventHub.shutdown();

  wss.close((err) => {
    if (err) console.error('[Shutdown] WSS close error:', err);
  });
  console.log('[Shutdown] WebSocket-сервер остановлен');

  queueManager.stopAll();
  console.log('[Shutdown] Очередь остановлена');

  // AD-089: остановить авто-архивацию ephemeral-сессий.
  stopEphemeralSweeper();

  const drainTimeout = 10_000;
  const activeSessions = await sessionManager.listActiveSessions();
  if (activeSessions.length > 0) {
    console.log(`[Shutdown] Ожидание завершения ${activeSessions.length} активных стримов...`);
    await Promise.race([
      waitForStreamsDrain(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          console.log(`[Shutdown] Таймаут ${drainTimeout}ms истёк, завершаю принудительно`);
          resolve();
        }, drainTimeout);
      }),
    ]);
  }

  console.log('[Shutdown] Завершено. Выход.');
  process.exit(0);
}

async function waitForStreamsDrain(): Promise<void> {
  while (true) {
    const active = await sessionManager.listActiveSessions();
    if (active.length === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Graceful shutdown — POST /admin/shutdown (только ADMIN).
// Регистрируется здесь, т.к. требует server/gracefulShutdown.
app.post('/admin/shutdown', auth.requireAdmin, async (c) => {
  void gracefulShutdown('API');
  return c.json({ status: 'shutting_down' });
});

// Admin routes
app.get('/admin/sessions/blocked', auth.requireAdmin, (c) => c.json({ sessions: [], count: 0 }));

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

console.log(`synth-backend starting on http://${host}:${port}`);
console.log(`  data dir: ${dataDir}`);
console.log(`  debug mode: ${config.auth.debugMode}`);
if (config.auth.debugMode) {
  console.log('  test users:');
  config.auth.testUsers?.forEach((u) => {
    console.log(`    ${u.username} [${u.roles.join(', ')}] → key: ${u.apiKey.slice(0, 8)}...`);
  });
}

const { server, wss } = await handle.listen(port, host);
