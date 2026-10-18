/**
 * ADR-094: метрики исходящих webhooks.
 *
 * `synth_webhook_deliveries_total{outcome}` — `ok`/`error`/`blocked`,
 * `synth_webhook_retries_total` — повторы (попытки сверх первой),
 * `synth_webhook_delivery_duration_seconds` — длительность доставки.
 */
import type { MetricsRegistry } from '../registry.js';

/** Исход одной доставки. */
export type WebhookDeliveryOutcome = 'ok' | 'error' | 'blocked';

/** Информация о завершённой доставке. */
export interface WebhookDeliveryInfo {
  outcome: WebhookDeliveryOutcome;
  durationMs: number;
  attempts: number;
}

/** Колбэк метрик доставок (передаётся в `WebhookService`). */
export type WebhookDeliveryMetrics = (info: WebhookDeliveryInfo) => void;

/** Создать колбэк метрик доставок. */
export function createWebhookMetrics(registry: MetricsRegistry): WebhookDeliveryMetrics {
  const deliveries = registry.counter(
    'synth_webhook_deliveries_total',
    'Total number of webhook deliveries by outcome.',
    ['outcome'],
  );
  const retries = registry.counter(
    'synth_webhook_retries_total',
    'Total number of webhook delivery retries.',
  );
  const durations = registry.histogram(
    'synth_webhook_delivery_duration_seconds',
    'Webhook delivery duration in seconds.',
  );

  return (info: WebhookDeliveryInfo): void => {
    try {
      deliveries.inc({ outcome: info.outcome });
      if (info.attempts > 1) retries.inc(info.attempts - 1);
      if (Number.isFinite(info.durationMs)) {
        durations.observe(Math.max(0, info.durationMs) / 1000);
      }
    } catch {
      // ignore
    }
  };
}
