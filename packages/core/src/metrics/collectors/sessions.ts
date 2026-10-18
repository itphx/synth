/**
 * ADR-094: фоновые gauge сессий/очереди.
 *
 * `synth_sessions_active` — число неархивных сессий; `synth_queue_pending` —
 * сумма `pendingMessages`. `listLight()` по контракту порта очищает
 * `pendingMessages`, поэтому для суммы нужен полный список: у файлового
 * backend стоимость та же (JSON читается целиком), у БД — цена осознанно
 * отложена до появления отдельного агрегатного запроса (см. отчёт).
 * Интервал — 15 c, таймер `unref`, ошибки не пробрасываются.
 */
import type { SessionManager } from '../../sessions/manager.js';
import type { MetricsRegistry } from '../registry.js';

/** Период обновления gauge сессий, мс. */
export const SESSIONS_METRICS_INTERVAL_MS = 15_000;

/**
 * Запустить фоновый сбор. Возвращает функцию остановки (таймер + gauge).
 */
export function startSessionMetrics(
  registry: MetricsRegistry,
  sessionManager: SessionManager,
  options: { intervalMs?: number } = {},
): () => void {
  const sessionsActive = registry.gauge(
    'synth_sessions_active',
    'Number of non-archived sessions.',
  );
  const queuePending = registry.gauge(
    'synth_queue_pending',
    'Total number of pending messages in session queues.',
  );

  let stopped = false;

  const collect = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sessions = await sessionManager.listSessions(undefined, { light: false });
      let pending = 0;
      let active = 0;
      for (const session of sessions) {
        if (!session.archivedAt) active += 1;
        pending += session.pendingMessages?.length ?? 0;
      }
      sessionsActive.set(active);
      queuePending.set(pending);
    } catch {
      // Ошибки фонового сбора не должны влиять на работу приложения.
    }
  };

  void collect();
  const timer = setInterval(() => {
    void collect();
  }, options.intervalMs ?? SESSIONS_METRICS_INTERVAL_MS);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    sessionsActive.set(0);
    queuePending.set(0);
  };
}
