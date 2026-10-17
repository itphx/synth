/**
 * Журнал внешних запросов (egress): best-effort запись, редактирование URL и
 * retention-прунер.
 *
 * Тела/заголовки не сохраняются; `url` — без query/userinfo (см.
 * `sanitizeEgressTarget`), ≤2048 символов. `egress.log.enabled=false` —
 * журнал выключен; прунер запускается как `startWebhookDeliveryPruner`
 * (раз в 6 ч; `retentionDays <= 0` — не чистить).
 */

import { generateId, nowISO } from '@itphx/synth-shared';
import type { EgressRequestLogEntry } from '@itphx/synth-shared';
import type { EgressLogEvent, EgressLogSink } from './egress-guard.js';
import type { EgressRequestLogRepository } from '../../storage/ports/egress-request-log-repository.js';

export interface EgressLogSinkOptions {
  /** Включён ли журнал (может быть ленивым геттером — live-настройка). */
  enabled: boolean | (() => boolean);
  /** Источник времени/ids (тесты). */
  now?: () => number;
  idFactory?: () => string;
  /** Логгер предупреждений. */
  warn?: (message: string) => void;
}

/** `true`, если журнал сейчас включён. */
export function isEgressLogEnabled(enabled: boolean | (() => boolean)): boolean {
  return typeof enabled === 'function' ? enabled() : enabled;
}

/**
 * Собирает приёмник журнала поверх порта `EgressRequestLogRepository`.
 * Ошибка записи не пробрасывается (только warn): журнал не ломает запрос.
 */
export function createEgressLogSink(
  repository: EgressRequestLogRepository,
  options: EgressLogSinkOptions,
): EgressLogSink {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? (() => `eg_${generateId()}`);
  const warn = options.warn ?? console.warn;

  return async (event: EgressLogEvent): Promise<void> => {
    if (!isEgressLogEnabled(options.enabled)) return;
    const entry: EgressRequestLogEntry = {
      id: idFactory(),
      ts: new Date(now()).toISOString(),
      scope: event.scope,
      host: event.host,
      url: event.url,
      ...(event.method ? { method: event.method } : {}),
      status: event.status,
      ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
      ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.matchedRule ? { matchedRule: event.matchedRule } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.projectId ? { projectId: event.projectId } : {}),
      ...(event.actor ? { actor: event.actor } : {}),
    };
    try {
      await repository.append(entry);
    } catch (err) {
      warn(`[egress] не удалось записать журнал: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** Период прогонов pruner'а по умолчанию — 6 часов. */
const DEFAULT_INTERVAL_MS = 6 * 3600_000;

export interface EgressLogPrunerOptions {
  /** Текущий срок хранения в днях (<= 0 — prune пропускается). */
  getRetentionDays: () => number;
  intervalMs?: number;
  warn?: (message: string) => void;
}

/**
 * Периодическая retention-очистка журнала внешних запросов: сразу при старте,
 * затем каждые `intervalMs` (по умолчанию 6 ч; таймер `unref`). Возвращает stop.
 */
export function startEgressLogPruner(
  repository: EgressRequestLogRepository,
  opts: EgressLogPrunerOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const warn = opts.warn ?? console.warn;

  const run = async (): Promise<void> => {
    try {
      const days = opts.getRetentionDays();
      if (!Number.isFinite(days) || days <= 0) return;
      await repository.prune(days);
    } catch (err) {
      warn(`[EgressLogPruner] prune журнала egress не удался: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

/** Снимок записи журнала для ответа API (стабильная форма). */
export function egressLogEntryToJson(entry: EgressRequestLogEntry): EgressRequestLogEntry {
  return { ...entry, ts: entry.ts || nowISO() };
}
