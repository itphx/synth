import { createHash } from 'node:crypto';
import type { EgressPolicy, WebhookDelivery, WebhookSubscription, WebhooksEgressPolicy } from '@itphx/synth-shared';
import { generateId, matchWebhookEvent, nowISO } from '@itphx/synth-shared';

/**
 * Источник события для доставки: структурный срез `BusEvent` с `type: string`
 * (тестовое событие `webhook.test` не входит в публичный union `EventType`).
 */
interface WebhookSourceEvent {
  type: string;
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: string;
}
import type { EventBus } from '../../events/bus.js';
import type { WebhookRepository } from '../../storage/ports/webhook-repository.js';
import type { WebhookDeliveryRepository } from '../../storage/ports/webhook-delivery-repository.js';
import type { HostResolver } from '../mcp/network-policy.js';
import type { FetchLike } from '../net/fetch.js';
import { buildSignatureHeader } from './signature.js';
import { evaluateWebhookTarget } from './network.js';
import { shouldProxyUrl } from '../../security/proxy-state.js';
import { EgressBlockedError, fetchWithEgressGuard, sanitizeEgressTarget } from '../net/egress-guard.js';
import { currentEgressLog } from '../net/egress-runtime.js';
import { egressFetch } from '../../security/tls.js';

/** Пользовательский агент HTTP-доставки. */
const USER_AGENT = 'Synth-Webhooks/1.0';

/** Максимум редиректов при доставке (каждый хоп проверяется SSRF-политикой). */
const MAX_REDIRECTS = 5;

/** Верхняя граница задержки экспоненциального backoff, мс. */
const MAX_BACKOFF_MS = 30_000;

/** Базовая задержка backoff, мс. */
const BASE_BACKOFF_MS = 1_000;

/** Доля джиттера (±) от базовой задержки. */
const BACKOFF_JITTER = 0.2;

/** Ёмкость in-memory набора дедупа доставок (FIFO-вытеснение). */
const DEDUP_LIMIT = 2_000;

export interface WebhookServiceConfig {
  enabled: boolean;
  /** Число HTTP-попыток на доставку (>= 1). */
  maxAttempts: number;
  /** Таймаут одного HTTP-запроса, мс. */
  timeoutMs: number;
  /**
   * Живой резолвер политики `egress.webhooks` (читается перед каждой
   * доставкой). Не задан — используется статическая `policy` (тесты/встраивание).
   */
  resolvePolicy?: () => Promise<WebhooksEgressPolicy>;
  /** Статическая политика (fallback для тестов). */
  policy?: WebhooksEgressPolicy;
}

export interface WebhookServiceDeps {
  store: WebhookRepository;
  deliveryStore: WebhookDeliveryRepository;
  eventBus: EventBus;
  config: WebhookServiceConfig;
  /** Инъекция fetch (тесты). */
  fetchImpl?: FetchLike;
  /** Инъекция паузы backoff (тесты). */
  sleep?: (ms: number) => Promise<void>;
  /** Источник случайности для джиттера (тесты). */
  random?: () => number;
  /** Источник текущего времени, мс (тесты). */
  now?: () => number;
  /** Инъекция DNS-резолвера SSRF-проверки (тесты). */
  resolveHost?: HostResolver;
  logger?: { warn: (message: string) => void };
}

/**
 * Экспоненциальный backoff с джиттером перед повторной попыткой.
 * `retryIndex` — номер **повтора** (1 — перед 2-й попыткой).
 */
export function computeBackoffMs(retryIndex: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, retryIndex - 1), MAX_BACKOFF_MS);
  const factor = 1 - BACKOFF_JITTER + random() * BACKOFF_JITTER * 2;
  return Math.round(base * factor);
}

/**
 * ADR-052 (этап II): движок исходящих webhooks над `EventBus.subscribeAll`.
 *
 * Подписка на все события шины (как глобальный SSE-хаб), фильтр по паттернам
 * подписки, HMAC-подпись, retry/backoff с таймаутом, дедуп по (подписка+событие)
 * и запись в журнал доставок. Мастер-выключатель — `config.enabled`.
 */
export class WebhookService {
  private _unsubscribe: (() => void) | null = null;
  private readonly _dedup = new Set<string>();
  private readonly _fetch: FetchLike;
  private readonly _sleep: (ms: number) => Promise<void>;
  private readonly _random: () => number;
  private readonly _nowMs: () => number;
  private readonly _logger: { warn: (message: string) => void };

  constructor(private readonly _deps: WebhookServiceDeps) {
    // ADR-099: транспорт доставки по умолчанию — `egressFetch` (единое доверие TLS/CA).
    this._fetch = _deps.fetchImpl ?? egressFetch;
    this._sleep = _deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._random = _deps.random ?? Math.random;
    this._nowMs = _deps.now ?? Date.now;
    this._logger = _deps.logger ?? console;
  }

  get enabled(): boolean {
    return this._deps.config.enabled;
  }

  /** Подписка на шину событий (идемпотентно). */
  start(): void {
    if (this._unsubscribe) return;
    this._unsubscribe = this._deps.eventBus.subscribeAll((event) => {
      if (!this._deps.config.enabled) return;
      void this._dispatch(event).catch((err) => {
        this._logger.warn(
          `[WebhookService] сбой диспетчеризации: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  /** Отписка от шины. */
  stop(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /**
   * Тестовая доставка (`POST /:id/test`) — синтетическое событие `webhook.test`
   * в обход фильтра событий и дедупа. `null`, если подписки нет.
   */
  async deliverTest(subscriptionId: string): Promise<WebhookDelivery | null> {
    const sub = await this._deps.store.get(subscriptionId);
    if (!sub) return null;
    const event: WebhookSourceEvent = {
      type: 'webhook.test',
      sessionId: '',
      data: { test: true, subscription_id: sub.id },
      timestamp: nowISO(),
    };
    return this._deliver(sub, event, { skipDedup: true });
  }

  /** Доставка события во все подходящие подписки. */
  private async _dispatch(event: WebhookSourceEvent): Promise<void> {
    let subscriptions: WebhookSubscription[];
    try {
      subscriptions = await this._deps.store.list();
    } catch (err) {
      this._logger.warn(
        `[WebhookService] не удалось прочитать подписки: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const sub of subscriptions) {
      if (!sub.enabled) continue;
      if (!matchWebhookEvent(sub.events, event.type)) continue;
      await this._deliver(sub, event, { skipDedup: false });
    }
  }

  /** Одна доставка: подпись, retry/backoff, журнал, отметка подписки. */
  private async _deliver(
    sub: WebhookSubscription,
    event: WebhookSourceEvent,
    options: { skipDedup: boolean },
  ): Promise<WebhookDelivery> {
    const deliveryId = `whd_${generateId()}`;
    const createdAt = new Date(this._nowMs()).toISOString();
    const body = JSON.stringify({ id: deliveryId, type: event.type, createdAt, data: event.data });

    const fingerprint = fingerprintOf(sub.id, event);
    if (!options.skipDedup) {
      if (this._dedup.has(fingerprint)) {
        // Повторный триггер того же события в ту же подписку — не шлём.
        return {
          id: deliveryId,
          subscriptionId: sub.id,
          eventType: event.type,
          status: 'ok',
          attempts: 0,
          createdAt,
          completedAt: new Date(this._nowMs()).toISOString(),
        };
      }
      this._remember(fingerprint);
    }

    let secret: string | null;
    try {
      secret = await this._deps.store.getSecret(sub.id);
    } catch (err) {
      return this._finish(sub, {
        id: deliveryId,
        subscriptionId: sub.id,
        eventType: event.type,
        status: 'failed',
        attempts: 0,
        error: `Секрет недоступен: ${err instanceof Error ? err.message : String(err)}`,
        createdAt,
      });
    }
    if (!secret) {
      return this._finish(sub, {
        id: deliveryId,
        subscriptionId: sub.id,
        eventType: event.type,
        status: 'failed',
        attempts: 0,
        error: 'Signing-секрет не найден',
        createdAt,
      });
    }

    // Defense-in-depth: SSRF-проверка перед каждой доставкой (URL мог измениться).
    // Политика резолвится заново (live) — без стартового снимка.
    const policy = this._deps.config.resolvePolicy
      ? await this._deps.config.resolvePolicy()
      : this._deps.config.policy;
    if (!policy) {
      return this._finish(sub, {
        id: deliveryId,
        subscriptionId: sub.id,
        eventType: event.type,
        status: 'failed',
        attempts: 0,
        error: 'egress-политика webhooks не задана (fail-closed)',
        createdAt,
      });
    }
    const target = await evaluateWebhookTarget(sub.url, {
      policy,
      resolveHost: this._deps.resolveHost,
      // ADR-099 (D1): при прокси адрес назначения известен только прокси.
      proxied: shouldProxyUrl(sub.url),
    });
    if (!target.allowed) {
      // Заблокированная цель (до HTTP-запроса) — фиксируем в журнале egress.
      const reason = target.reason ?? 'Цель доставки запрещена политикой';
      await this._recordBlocked(sub.url, reason, target.matchedRule);
      return this._finish(sub, {
        id: deliveryId,
        subscriptionId: sub.id,
        eventType: event.type,
        status: 'failed',
        attempts: 0,
        error: reason,
        createdAt,
      });
    }

    const maxAttempts = Math.max(1, this._deps.config.maxAttempts);
    let attempts = 0;
    let responseStatus: number | undefined;
    let error: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const timestamp = Math.floor(this._nowMs() / 1000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._deps.config.timeoutMs);
      try {
        const response = await fetchWithEgressGuard(
          sub.url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
              'X-Synth-Event': event.type,
              'X-Synth-Delivery': deliveryId,
              'X-Synth-Signature': buildSignatureHeader(secret, timestamp, body),
            },
            body,
            signal: controller.signal,
          },
          {
            // `off` (dev) — проверок нет; иначе deny/allow + exceptions.
            ...(policy.mode === 'off'
              ? { skipPolicy: true }
              : { policy: policy as EgressPolicy, requireHttps: true }),
            resolveHost: this._deps.resolveHost,
            maxHops: MAX_REDIRECTS,
            // Проверка каждого хопа редиректа: приватный адрес — отказ без запроса.
            fetchImpl: this._fetch,
            // Журнал egress: allowed/blocked/error, durationMs/httpStatus.
            scope: 'webhooks',
            log: currentEgressLog(),
          },
        );
        responseStatus = response.status;
        if (response.ok) {
          error = undefined;
          break;
        }
        error = `HTTP ${response.status}`;
      } catch (err) {
        responseStatus = undefined;
        error = err instanceof Error ? err.message : String(err);
        // Запрещённый хоп/цель — отказ, ретраи не помогут.
        if (err instanceof EgressBlockedError) break;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxAttempts) {
        await this._sleep(computeBackoffMs(attempt, this._random));
      }
    }

    return this._finish(sub, {
      id: deliveryId,
      subscriptionId: sub.id,
      eventType: event.type,
      status: error ? 'failed' : 'ok',
      attempts,
      ...(responseStatus !== undefined ? { responseStatus } : {}),
      ...(error ? { error } : {}),
      createdAt,
    });
  }

  /** Best-effort запись заблокированной цели в журнал egress (до HTTP-запроса). */
  private async _recordBlocked(url: string, reason: string, matchedRule?: string): Promise<void> {
    const log = currentEgressLog();
    if (!log) return;
    const target = sanitizeEgressTarget(url);
    try {
      await log({
        scope: 'webhooks',
        host: target.host,
        url: target.url,
        method: 'POST',
        status: 'blocked',
        reason,
        ...(matchedRule ? { matchedRule } : {}),
      });
    } catch (err) {
      this._logger.warn(
        `[WebhookService] egress log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Запись в журнал + отметка подписки. */
  private async _finish(
    sub: WebhookSubscription,
    delivery: WebhookDelivery,
  ): Promise<WebhookDelivery> {
    const completed: WebhookDelivery = { ...delivery, completedAt: new Date(this._nowMs()).toISOString() };
    try {
      await this._deps.deliveryStore.record(completed);
    } catch (err) {
      this._logger.warn(
        `[WebhookService] не удалось записать доставку: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this._deps.store.touchDelivery(sub.id, completed.status === 'ok' ? 'ok' : 'failed');
    } catch (err) {
      this._logger.warn(
        `[WebhookService] не удалось обновить подписку: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return completed;
  }

  private _remember(fingerprint: string): void {
    this._dedup.add(fingerprint);
    if (this._dedup.size > DEDUP_LIMIT) {
      const first = this._dedup.values().next().value;
      if (first !== undefined) this._dedup.delete(first);
    }
  }
}

/** Устойчивый отпечаток события для дедупа (без timestamp — ре-триггер того же события). */
function fingerprintOf(subscriptionId: string, event: WebhookSourceEvent): string {
  const canonical = JSON.stringify([subscriptionId, event.type, event.sessionId, event.data]);
  return createHash('sha256').update(canonical).digest('hex');
}
