/**
 * ADR-105 (Ф4): незавершённые выдачи доступа — PKCE-верификатор и device-код.
 *
 * Хранение **in-memory** и осознанно кратковременное:
 * - `code_verifier` — секретная половина PKCE (RFC 7636 §4.1): на диске он лежал бы
 *   рядом с токенами, а в журнале/бэкапе его быть не должно;
 * - `device_code` (RFC 8628 §3.2) — тоже одноразовый секрет;
 * - `state` — CSRF-защита authorize-запроса (RFC 6749 §10.12).
 *
 * Запись живёт `ttlMs` (по умолчанию 10 минут) и удаляется при использовании
 * (`consume`) — обмен кода по `state` одноразовый.
 *
 * Хранилище — **не** порт слоя хранения: это эфемерное состояние процесса,
 * терять его при рестарте не страшно (пользователь начнёт выдачу заново).
 */
import { randomBytes } from 'node:crypto';
import type { ExternalCredentialOwner } from '@itphx/synth-shared';

/** Вид незавершённой выдачи. */
export type PendingAuthorizationKind = 'authorize' | 'device';

/** Незавершённая выдача доступа. */
export interface PendingAuthorization {
  /** Opaque-идентификатор (`state` в authorize-URL, handle в device-flow). */
  id: string;
  /** Вид выдачи. */
  kind: PendingAuthorizationKind;
  /** Ключ OAuth-провайдера. */
  provider: string;
  /** Владелец будущего доступа. */
  owner: ExternalCredentialOwner;
  /** Кто начал выдачу (id пользователя инстанса). */
  createdBy: string;
  /** Момент создания (мс, epoch). */
  createdAt: number;
  /** Момент истечения (мс, epoch). */
  expiresAt: number;
  /** PKCE-верификатор (для `authorize`). */
  codeVerifier?: string;
  /** `redirect_uri`, использованный при выдаче кода. */
  redirectUri?: string;
  /** Запрошенные scope'ы. */
  scopes?: string[];
  /** Привязка к проекту. */
  projectId?: string;
  /** Привязка к MCP-коннектору. */
  connectorId?: string;
  /** `device_code` (RFC 8628 §3.2) — для `device`. */
  deviceCode?: string;
  /** `user_code` (RFC 8628 §3.2) — для `device`. */
  userCode?: string;
  /** `verification_uri` (RFC 8628 §3.2). */
  verificationUri?: string;
  /** `verification_uri_complete` (RFC 8628 §3.2). */
  verificationUriComplete?: string;
  /** Интервал опроса token-endpoint (секунды, RFC 8628 §3.5). */
  interval?: number;
}

/** Вход создания незавершённой выдачи. */
export interface PendingAuthorizationInput {
  kind: PendingAuthorizationKind;
  provider: string;
  owner: ExternalCredentialOwner;
  createdBy: string;
  codeVerifier?: string;
  redirectUri?: string;
  scopes?: string[];
  projectId?: string;
  connectorId?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  interval?: number;
}

/** Опции хранилища незавершённых выдач. */
export interface PendingAuthorizationStoreOptions {
  /** Время жизни записи, мс (по умолчанию 10 минут). */
  ttlMs?: number;
  /** Предел числа записей (по умолчанию 1000) — защита от роста. */
  maxEntries?: number;
  /** Источник времени (тесты). */
  now?: () => number;
}

/** Время жизни незавершённой выдачи по умолчанию, мс. */
export const DEFAULT_PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/** Предел числа незавершённых выдач по умолчанию. */
export const DEFAULT_PENDING_AUTHORIZATION_MAX_ENTRIES = 1000;

/**
 * Хранилище незавершённых выдач доступа (in-memory, TTL).
 *
 * Потокобезопасность не нужна: состояние процесса, обращения — из HTTP-обработчика
 * (Node — однопоточный цикл событий, между `await` критическая секция не нужна).
 */
export class PendingAuthorizationStore {
  private readonly _items = new Map<string, PendingAuthorization>();
  private readonly _ttlMs: number;
  private readonly _maxEntries: number;
  private readonly _now: () => number;

  constructor(options: PendingAuthorizationStoreOptions = {}) {
    this._ttlMs = options.ttlMs ?? DEFAULT_PENDING_AUTHORIZATION_TTL_MS;
    this._maxEntries = options.maxEntries ?? DEFAULT_PENDING_AUTHORIZATION_MAX_ENTRIES;
    this._now = options.now ?? (() => Date.now());
  }

  /** Создать запись (id выдаётся автоматически). */
  create(input: PendingAuthorizationInput): PendingAuthorization {
    this._sweep();
    const now = this._now();
    const item: PendingAuthorization = {
      // Идентификатор выдачи = OAuth-`state` (RFC 6749 §10.12): криптостойкий
      // случайный, поэтому используется и как CSRF-значение, и как handle.
      id: randomBytes(24).toString('base64url'),
      kind: input.kind,
      provider: input.provider,
      owner: { ...input.owner },
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: now + this._ttlMs,
      ...(input.codeVerifier !== undefined ? { codeVerifier: input.codeVerifier } : {}),
      ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
      ...(input.scopes !== undefined ? { scopes: [...input.scopes] } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
      ...(input.deviceCode !== undefined ? { deviceCode: input.deviceCode } : {}),
      ...(input.userCode !== undefined ? { userCode: input.userCode } : {}),
      ...(input.verificationUri !== undefined ? { verificationUri: input.verificationUri } : {}),
      ...(input.verificationUriComplete !== undefined
        ? { verificationUriComplete: input.verificationUriComplete }
        : {}),
      ...(input.interval !== undefined ? { interval: input.interval } : {}),
    };
    this._items.set(item.id, item);
    this._evictOverflow();
    return item;
  }

  /** Запись по id (без удаления) либо `null`. */
  get(id: string): PendingAuthorization | null {
    const item = this._items.get(id);
    if (!item) return null;
    if (item.expiresAt <= this._now()) {
      this._items.delete(id);
      return null;
    }
    return item;
  }

  /** Забрать запись и удалить её (одноразовый обмен по `state`). */
  consume(id: string): PendingAuthorization | null {
    const item = this.get(id);
    if (item) this._items.delete(id);
    return item;
  }

  /** Удалить запись (явный отказ от выдачи). */
  remove(id: string): void {
    this._items.delete(id);
  }

  /** Число живых записей. */
  get size(): number {
    this._sweep();
    return this._items.size;
  }

  /** Удаление просроченных записей. */
  private _sweep(): void {
    const now = this._now();
    for (const [id, item] of this._items) {
      if (item.expiresAt <= now) this._items.delete(id);
    }
  }

  /** Вытеснение самых старых записей при превышении лимита. */
  private _evictOverflow(): void {
    while (this._items.size > this._maxEntries) {
      const oldest = this._items.keys().next();
      if (oldest.done) break;
      this._items.delete(oldest.value);
    }
  }
}
