/**
 * ADR-094: метрики гибридного режима.
 *
 * `synth_hybrid_connected` — 0/1 по состоянию `RemoteConnection`;
 * `synth_remote_request_duration_seconds{op}` — исходящие запросы к удалённому
 * backend. `op` — нормализованный сегмент пути (`sessions`/`projects`/`events`/
 * `llm`/`other`), без id/query — кардинальность ограничена.
 */
import type { MetricsRegistry } from '../registry.js';

/** Информация о запросе к удалённому backend. */
export interface RemoteRequestInfo {
  method: string;
  path: string;
  status?: number;
  durationMs: number;
  error?: string;
}

/** Хуки гибридных метрик. */
export interface HybridMetricsHooks {
  onRequest: (info: RemoteRequestInfo) => void;
  stop: () => void;
}

/** Нормализация пути в контрактный `op` (без id/query). */
export function normalizeRemoteOp(path: string): 'sessions' | 'projects' | 'events' | 'llm' | 'other' {
  const clean = path.split('?')[0] ?? '';
  const segments = clean.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === 'sessions' || segment === 'projects' || segment === 'events' || segment === 'llm') {
      return segment;
    }
  }
  return 'other';
}

/**
 * Подключить гибридные метрики. `isConnected` читается при скрейпе, чтобы
 * состояние всегда было актуальным (connect/disconnect/status).
 */
export function attachHybridMetrics(
  registry: MetricsRegistry,
  isConnected: () => boolean,
): HybridMetricsHooks {
  const connected = registry.gauge(
    'synth_hybrid_connected',
    'Whether the hybrid mode is connected to a remote backend.',
  );
  const requests = registry.histogram(
    'synth_remote_request_duration_seconds',
    'Remote backend request duration in seconds.',
    ['op'],
  );

  connected.set(isConnected() ? 1 : 0);
  const removeCollector = registry.addCollector(() => {
    connected.set(isConnected() ? 1 : 0);
  });

  return {
    onRequest(info: RemoteRequestInfo): void {
      try {
        if (!Number.isFinite(info.durationMs)) return;
        requests.observe({ op: normalizeRemoteOp(info.path) }, Math.max(0, info.durationMs) / 1000);
      } catch {
        // ignore
      }
    },
    stop(): void {
      removeCollector();
      connected.set(0);
    },
  };
}
