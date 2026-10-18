/**
 * ADR-094: readiness-метрика `synth_ready`.
 *
 * 1 — приложение инициализировано, 0 — shutdown/не готово. Значение ставится
 * композицией (core/backend) и снимается в graceful shutdown.
 */
import type { MetricsRegistry } from '../registry.js';

/** Установить `synth_ready` (0/1). */
export function setSynthReady(registry: MetricsRegistry, value: 0 | 1): void {
  try {
    registry
      .gauge('synth_ready', 'Whether the application is initialized and ready to serve.')
      .set(value);
  } catch {
    // ignore
  }
}
