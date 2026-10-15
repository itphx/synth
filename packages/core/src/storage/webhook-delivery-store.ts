import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { WebhookDelivery } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type { WebhookDeliveryRepository } from './ports/webhook-delivery-repository.js';

export interface WebhookDeliveryStoreConfig {
  dataDir: string;
}

/**
 * ADR-052 (этап II): append-only журнал доставок webhooks.
 *
 * JSONL `{dataDir}/webhooks/deliveries.jsonl` (одна строка = одна запись, как
 * `EventJournalStore`). Append защищён общим `AsyncLock`; `prune` — атомарная
 * перезапись (tmp→rename, ADR-005).
 */
export class WebhookDeliveryStore implements WebhookDeliveryRepository {
  private _lock = new AsyncLock();

  constructor(private _config: WebhookDeliveryStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'webhooks', 'deliveries.jsonl');
  }

  /** Дозапись одной записи журнала. */
  async record(delivery: WebhookDelivery): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(delivery)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  /**
   * Все записи журнала (старые → новые), опционально последние `limit`.
   * Нет файла — `[]`; повреждённые строки пропускаются.
   */
  async list(limit?: number): Promise<WebhookDelivery[]> {
    const entries = await this._readAll();
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(-Math.floor(limit));
  }

  /** Последние записи журнала конкретной подписки (`limit` — последние N). */
  async listBySubscription(subscriptionId: string, limit?: number): Promise<WebhookDelivery[]> {
    const entries = (await this._readAll()).filter((e) => e.subscriptionId === subscriptionId);
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(-Math.floor(limit));
  }

  /** Удаляет записи старше `retentionDays` (по `createdAt`); `0`/отрицательное — без ограничения. */
  async prune(retentionDays: number): Promise<number> {
    await this._lock.acquire();
    try {
      const entries = await this._readAll();
      if (entries.length === 0) return 0;
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const kept = entries.filter((e) => {
        const t = Date.parse(e.createdAt);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
      const removed = entries.length - kept.length;
      if (removed === 0) return 0;

      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      const data = kept.length > 0 ? `${kept.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _readAll(): Promise<WebhookDelivery[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const entries: WebhookDelivery[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as WebhookDelivery);
      } catch {
        // повреждённая строка пропускается
      }
    }
    return entries;
  }
}
