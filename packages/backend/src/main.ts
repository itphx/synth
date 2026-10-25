// Точка входа synth-backend. Тонкая обёртка над фабрикой createBackendApp
// (см. app.ts): строит приложение, слушает порт, обрабатывает graceful shutdown.
// Всё построение Hono-app (конфиг → auth → stores → orchestrator → routes)
// живёт в app.ts — это позволяет поднимать backend in-process в интеграционных
// тестах без запуска процесса.

import { createBackendApp } from './app.js';
import {
  configureRestart,
  resolveRestartMode,
  RESTART_EXIT_CODE,
  setSynthReady,
} from '@itphx/synth-core';

const host = process.env.SYNTH_HOST || '0.0.0.0';

// ADR-077: fail-closed на старте (неверный `execution.mode` или `remote` —
// удалённый исполнитель ещё не реализован, шаг 7 плана) — с понятным текстом.
let handle: Awaited<ReturnType<typeof createBackendApp>>;
try {
  handle = await createBackendApp();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { app, dataDir, port, config, auth, eventHub, queueManager, sessionManager, stopEphemeralSweeper, stopEventJournalPruner, stopAnalyticsRollupPruner, stopScheduler, stopWebhookService, stopWebhookDeliveryPruner, stopMetrics, stopQuestionPruner } = handle;

// ADR-090 (Ф5б-1): старт-активация установленных плагинов.
// `plugins.lock.json` — источник истины; `plugins.executionEnabled=false`
// (дефолт) → no-op. Ошибка плагина/рантайма **не роняет старт** (только
// предупреждение); тексты плагинов в лог не попадают (инвариант 13).
//
// Ф5в: **сначала** установка deploy-плагинов (образ/PVC, `plugins.deployDir`),
// затем активация — иначе поставленный образом плагин не попал бы в
// `plugins.lock.json` и не активировался при первом старте.
try {
  const deploy = await handle.pluginRuntime.installDeployPlugins({ actor: 'startup' });
  if (deploy.installed.length > 0 || deploy.failed.length > 0) {
    console.log(
      `[plugins] deploy: установлено ${deploy.installed.length}, ` +
        `пропущено ${deploy.skipped.length}, ошибок ${deploy.failed.length}`,
    );
  }
} catch (err) {
  console.warn(
    `[plugins] установка deploy-плагинов не выполнена: ${err instanceof Error ? err.message : String(err)}`,
  );
}
try {
  const results = await handle.pluginRuntime.activateInstalled({ actor: 'startup' });
  if (results.length > 0) {
    const activated = results.filter((item) => item.outcome === 'activated').length;
    console.log(`[plugins] активировано: ${activated}, отклонено: ${results.length - activated}`);
  }
} catch (err) {
  console.warn(
    `[plugins] старт-активация не выполнена: ${err instanceof Error ? err.message : String(err)}`,
  );
}

let shuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] Получен сигнал ${signal}, начинаю graceful shutdown...`);

  // ADR-094: снять readiness до остановки сервера/коллекторов — скрейп в момент
  // shutdown видит `synth_ready 0`.
  setSynthReady(handle.metrics, 0);

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

  // ADR-089: остановить авто-архивацию ephemeral-сессий.
  stopEphemeralSweeper();

  // ADR-089: остановить retention-очистку журнала событий.
  stopEventJournalPruner();

  // ADR-102: остановить retention-очистку роллапов аналитики.
  stopAnalyticsRollupPruner();

  // Этап 1 roadmap 0.13 (блок 3): остановить retention-очистку вопросов и
  // освободить ожидания ответа.
  stopQuestionPruner();

  // ADR-094: остановить процессные метрики и фоновые доменные коллекторы
  // (таймеры сессий/хранилища, подписка шины, decision/journal).
  stopMetrics();

  // ADR-051 (срез): остановить планировщик расписаний.
  stopScheduler();

  // ADR-052 (этап II): остановить движок исходящих webhooks и retention-очистку.
  stopWebhookService();
  stopWebhookDeliveryPruner();

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
  process.exit(exitCode);
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

// Restart из UI: режим — `SYNTH_RESTART_MODE` (default `disabled`; managed-деплой
// задаёт `process` — K8s/Docker перезапускают контейнер), рестарт — graceful
// shutdown с кодом 75. `/admin/shutdown` остаётся обычным выходом с кодом 0.
configureRestart({
  mode: resolveRestartMode(process.env),
  request: () => gracefulShutdown('API', RESTART_EXIT_CODE),
});

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
