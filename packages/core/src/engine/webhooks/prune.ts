import type { WebhookDeliveryRepository } from '../../storage/ports/webhook-delivery-repository.js';

export interface WebhookDeliveryPrunerOptions {
  /** Текущий срок хранения журнала в днях (<= 0 — prune пропускается). */
  getRetentionDays: () => number;
  /** Период проверки, мс; по умолчанию 6 часов. */
  intervalMs?: number;
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

/**
 * ADR-052 (этап II): периодическая retention-очистка журнала доставок webhooks.
 *
 * Сразу при старте выполняет `prune`, затем повторяет его каждые `intervalMs`
 * (по умолчанию 6 ч; таймер `unref`). Если `retentionDays <= 0` — prune
 * пропускается (безлимитное хранение). Возвращает stop-функцию.
 */
export function startWebhookDeliveryPruner(
  deliveries: WebhookDeliveryRepository,
  opts: WebhookDeliveryPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = async (): Promise<void> => {
    try {
      const days = opts.getRetentionDays();
      if (!Number.isFinite(days) || days <= 0) return;
      await deliveries.prune(days);
    } catch (err) {
      console.warn(
        `[WebhookDeliveryPruner] prune журнала доставок не удался: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
