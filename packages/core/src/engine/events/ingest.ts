import { randomUUID } from 'node:crypto';
import type {
  EventAttachmentRef,
  EventBinding,
  EventIdentity,
  RouteDecision,
  Session,
  SynthEvent,
} from '@itphx/synth-shared';
import { nowISO } from '@itphx/synth-shared';
import type { EventMetricsHooks } from '../../metrics/collectors/events.js';
import type { AttachmentService } from '../attachments/service.js';
import { isAttachmentPath } from '../attachments/service.js';
import type { RequestSessionService, IdentityClaimHint } from './request-session.js';

/**
 * ADR-115 × ADR-089: жёсткий предел вложений в одном событии. Используется,
 * когда сервис вложений не передан (нет доступа к `attachments.maxFilesPerMessage`).
 */
export const EVENT_ATTACHMENTS_MAX_FILES = 10;

/**
 * ADR-115 × ADR-089: причина отказа во вложениях события. На роуте
 * (`POST /api/v2/events`) отображается в `400 VALIDATION_ERROR`.
 */
export type EventAttachmentErrorReason =
  | 'dedup_key_required'
  | 'attachments_unavailable'
  | 'too_many'
  | 'invalid_path'
  | 'not_found'
  | 'metadata_mismatch'
  | 'too_large';

/**
 * ADR-115 × ADR-089: вложения события не прошли проверку. Отказ **до**
 * нормализации/дедупа: событие не попадает в Router и журнал.
 */
export class EventAttachmentError extends Error {
  constructor(
    readonly reason: EventAttachmentErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'EventAttachmentError';
  }
}

/**
 * ADR-089: вход приёма внешнего события. `id`/`dedupKey`/`ts` необязательны —
 * нормализуются `EventIngress.normalize`.
 */
export interface EventIngestInput {
  source: string;
  type: string;
  payload?: unknown;
  identity?: EventIdentity;
  dedupKey?: string;
  ts?: string;
  /**
   * ADR-115 × ADR-089: ссылки на вложения (staging-объекты `attachments/…`).
   * Непустой массив требует явного `dedupKey` и проверяется `EventIngress`.
   */
  attachments?: EventAttachmentRef[];
}

export interface EventIngressDeps {
  requestSessionService: RequestSessionService;
  /** ADR-094: метрики приёма (`synth_events_ingested_total{source,outcome}`). */
  metrics?: EventMetricsHooks;
  /**
   * ADR-115 × ADR-089: сервис вложений — проверка ссылок `attachments[]`
   * (объект существует, метаданные совпадают со sidecar) и источник лимитов
   * (`attachments.maxFilesPerMessage`/`maxBytesPerFile`).
   *
   * Не передан — события с вложениями отклоняются
   * (`EventAttachmentError: attachments_unavailable`): без проверки в событие
   * можно было бы подставить ссылку на несуществующий/чужой объект.
   */
  attachments?: AttachmentService;
}


/**
 * Стабильный ключ идемпотентности по умолчанию: `source:type:chatKey|threadKey:payload`.
 * Повтор одного и того же внешнего события (пересланный webhook) даёт тот же ключ.
 */
function defaultDedupKey(input: EventIngestInput, identity: EventIdentity): string {
  let payload = '';
  try {
    payload = JSON.stringify(input.payload) ?? '';
  } catch {
    payload = '';
  }
  const key = identity.threadKey ?? identity.chatKey ?? '';
  return `${input.source}:${input.type}:${key}:${payload}`;
}

/**
 * ADR-089: ingress-точка приёма внешних событий. Нормализует вход во внутренний
 * `SynthEvent` (id `evt_<uuid>`, defaults) и передаёт в единый funnel
 * `RequestSessionService.handleEvent` (Router → материализация → журнал).
 */
export class EventIngress {
  private _requestSessionService: RequestSessionService;
  private _metrics?: EventMetricsHooks;
  private _attachments?: AttachmentService;

  constructor(deps: EventIngressDeps) {
    this._requestSessionService = deps.requestSessionService;
    this._metrics = deps.metrics;
    this._attachments = deps.attachments;
  }

  /** Нормализация входа в `SynthEvent` (без побочных эффектов). */
  normalize(input: EventIngestInput): SynthEvent {
    const identity: EventIdentity = input.identity ?? {};
    return {
      id: `evt_${randomUUID()}`,
      source: input.source,
      type: input.type,
      payload: input.payload,
      identity,
      dedupKey: input.dedupKey ?? defaultDedupKey(input, identity),
      ts: input.ts ?? nowISO(),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    };
  }

  /**
   * Нормализация + маршрутизация/материализация через `RequestSessionService`.
   *
   * ADR-089: `opts.binding` (аутентификация по API-ключу привязки) прокидывается
   * в funnel — событие маршрутизируется в эту привязку.
   * ADR-089/ADR-052: `opts.audit` (id ключа/идентичность) прокидывается в журнал.
   * ADR-089: `opts.ownerId` (владелец создаваемой сессии) прокидывается в funnel.
   */
  async ingest(
    input: EventIngestInput,
    opts?: {
      binding?: EventBinding;
      audit?: { keyId?: string; principalId?: string };
      ownerId?: string;
    },
  ): Promise<{
    event: SynthEvent;
    decision: RouteDecision;
    session: Session | null;
    identityHint?: IdentityClaimHint;
  }> {
    const event = this.normalize(input);
    // ADR-115 × ADR-089: вложения проверяются **до** роутинга/дедупа —
    // отклонённое событие не попадает ни в Router, ни в журнал, ни в dedup-хранилище.
    try {
      await this._validateAttachments(input);
    } catch (err) {
      this._reportIngest(input.source, 'error');
      throw err;
    }
    let result: Awaited<ReturnType<RequestSessionService['handleEvent']>>;
    try {
      result = await this._requestSessionService.handleEvent(event, opts);
    } catch (err) {
      // ADR-094: неуспешный приём считается в метриках и пробрасывается дальше.
      this._reportIngest(input.source, 'error');
      throw err;
    }
    this._reportIngest(input.source, 'ok');
    const { decision, session, identityHint } = result;
    return { event, decision, session, ...(identityHint ? { identityHint } : {}) };
  }

  /** ADR-094: ошибки колбэка метрик не влияют на приём события. */
  private _reportIngest(source: string, outcome: 'ok' | 'error'): void {
    try {
      this._metrics?.onIngest({ source, outcome });
    } catch {
      // ignore
    }
  }

  /**
   * ADR-115 × ADR-089: проверка ссылок на вложения события.
   *
   * Проверяется **до** маршрутизации: неверная ссылка не должна доходить до
   * Router'а, журнала и dedup-хранилища (иначе событие «заняло» бы dedup-ключ,
   * хотя доставлено не было).
   *
   * Правила:
   * - `dedupKey` обязателен: ключ по умолчанию строится из `payload` и для
   *   бинарного содержимого нестабилен (`dedup_key_required`);
   * - количество ≤ `attachments.maxFilesPerMessage` (без сервиса — жёсткий
   *   `EVENT_ATTACHMENTS_MAX_FILES`); `too_many`;
   * - путь — только внутри `attachments/` (`invalid_path`, контур ADR-115);
   * - объект существует и его метаданные совпадают со sidecar (`not_found` /
   *   `metadata_mismatch`): иначе через событие можно подставить ссылку на
   *   чужой/изменённый объект;
   * - размер ≤ `attachments.maxBytesPerFile` (`too_large`).
   */
  private async _validateAttachments(input: EventIngestInput): Promise<void> {
    const attachments = input.attachments;
    if (!attachments || attachments.length === 0) return;

    if (!input.dedupKey) {
      throw new EventAttachmentError(
        'dedup_key_required',
        'Событие с вложениями требует явного dedupKey',
      );
    }

    const service = this._attachments;
    const config = service?.config;
    const maxFiles = config?.maxFilesPerMessage ?? EVENT_ATTACHMENTS_MAX_FILES;
    if (attachments.length > maxFiles) {
      throw new EventAttachmentError(
        'too_many',
        `Вложений в событии ${attachments.length} — предел ${maxFiles}`,
      );
    }

    if (!service) {
      // Fail-closed: без сервиса вложений нельзя убедиться, что объект есть и не
      // подменён. Событие без вложений проверку не проходит и работает как раньше.
      throw new EventAttachmentError(
        'attachments_unavailable',
        'Проверка вложений события недоступна',
      );
    }

    const maxBytes = config?.maxBytesPerFile;
    for (const [index, attachment] of attachments.entries()) {
      if (!isAttachmentPath(attachment.blobPath)) {
        throw new EventAttachmentError(
          'invalid_path',
          `attachments[${index}].blobPath вне attachments/: ${attachment.blobPath}`,
        );
      }
      const resolved = await service.resolve(attachment.blobPath);
      if (!resolved) {
        throw new EventAttachmentError(
          'not_found',
          `Вложение ${attachment.blobPath} не найдено в хранилище`,
        );
      }
      const declaredMime = attachment.mime.trim().toLowerCase();
      const declaredSha = attachment.sha256.trim().toLowerCase();
      if (resolved.sha256 !== declaredSha) {
        throw new EventAttachmentError(
          'metadata_mismatch',
          `attachments[${index}]: sha256 не совпадает с объектом ${attachment.blobPath}`,
        );
      }
      if (resolved.mime !== declaredMime) {
        throw new EventAttachmentError(
          'metadata_mismatch',
          `attachments[${index}]: mime «${attachment.mime}» не совпадает с объектом (${resolved.mime})`,
        );
      }
      if (resolved.size !== attachment.size) {
        throw new EventAttachmentError(
          'metadata_mismatch',
          `attachments[${index}]: size ${attachment.size} не совпадает с объектом (${resolved.size})`,
        );
      }
      if (typeof maxBytes === 'number' && attachment.size > maxBytes) {
        throw new EventAttachmentError(
          'too_large',
          `attachments[${index}]: размер ${attachment.size} Б превышает предел ${maxBytes} Б`,
        );
      }
    }
  }
}
