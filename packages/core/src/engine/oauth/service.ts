/**
 * ADR-105 (Ф2): сервис слоя доступов — выдача кода, refresh, отзыв.
 *
 * Единственный путь записи — **порт** `ExternalCredentialRepository`
 * (ADR-096): токены шифруются мастер-ключом внутри хранилища, наружу отдаются
 * метаданные с маской. Прямой записи в `{dataDir}` здесь нет (инвариант 2).
 *
 * **Refresh и гонка** (ADR-105 §3):
 * - параллельный refresh одного доступа → **ровно один** сетевой вызов
 *   (single-flight в процессе: параллельные вызовы ждут один результат);
 * - запись защищена **CAS по `refreshEnc`**: перед записью новых токенов
 *   текущее значение `refreshEnc` перечитывается; если его успел изменить
 *   другой писатель, запись не выполняется и используются уже записанные
 *   токены (Refresh-токен после использования обычно ротируется провайдером);
 * - `invalid_grant` (refresh-токен отозван/истёк) → доступ переводится в
 *   `status:'error'` через порт: требуется явная переавторизация, молчаливый
 *   отказ недопустим.
 *
 * **Отзыв** (ADR-105 §4): локальный отзыв выполняется всегда (запись
 * помечается отозванной необратимо), вызов провайдера (RFC 7009) —
 * best-effort.
 */
import type {
  ExternalCredential,
  ExternalCredentialMeta,
  ExternalCredentialOwner,
  UpdateExternalCredentialTokensInput,
} from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';
import type { ExternalCredentialRepository } from '../../storage/ports/external-credential-repository.js';
import type { CredentialAuditRepository } from '../../storage/ports/credential-audit-repository.js';
import { EXTERNAL_CREDENTIAL_ID_PREFIX } from '../../storage/external-credential-store.js';
import { credentialAuditErrorCode, recordCredentialAudit } from './audit.js';
import { OAuthError } from './types.js';
import type { OAuthClient } from './client.js';
import type { OAuthTokenSet } from './types.js';

/** Зависимости сервиса слоя доступов. */
export interface OAuthCredentialServiceDeps {
  /** Порт хранилища доступов — единственный путь чтения/записи токенов. */
  repo: ExternalCredentialRepository;
  /**
   * Клиент для провайдера. Описание провайдера — данные; `client_secret`
   * берётся вызывающим из env/файла (`client-secret.ts`).
   */
  clientFor: (provider: string) => OAuthClient;
  /**
   * ADR-105 (Ф4): журнал операций со слоем доступов (append-only). Не задан —
   * операции не журналируются (журнал — best-effort: сбой записи не ломает
   * саму операцию).
   */
  audit?: CredentialAuditRepository;
  /** Источник времени (тесты). */
  now?: () => number;
}

/** Вход выдачи доступа (обмен кода на токены + запись в порт). */
export interface ExchangeAndStoreInput {
  /** Ключ провайдера (совпадает с описанием). */
  provider: string;
  /** Код авторизации. */
  code: string;
  /** PKCE-верификатор (публичный клиент). */
  codeVerifier?: string;
  /** `redirect_uri`, использованный при выдаче кода. */
  redirectUri?: string;
  /** Владелец доступа (ADR-105 §2). */
  owner: ExternalCredentialOwner;
  /** Кто выдал доступ (id пользователя инстанса). */
  createdBy: string;
  /** Привязка к коннектору (id записи реестра MCP). */
  connectorId?: string;
  /** Привязка к проекту. */
  projectId?: string;
  /** Запрошенные scope'ы (по умолчанию — scope'ы провайдера). */
  scopes?: string[];
}

/** Результат отзыва доступа. */
export interface RevokeResult {
  /** Метаданные доступа после отзыва (без секрета). */
  meta: ExternalCredentialMeta;
  /** `true` — провайдер подтвердил отзыв (RFC 7009); иначе — best-effort. */
  providerRevoked: boolean;
}

/**
 * Вход сохранения уже полученных токенов (device flow, RFC 8628).
 *
 * Отличие от `exchangeAndStore`: код авторизации уже обменян на токены, сеть
 * повторно не дёргается — токены кладутся в порт как есть.
 */
export interface StoreTokensInput {
  provider: string;
  /** `client_id` (по умолчанию — из описания провайдера). */
  clientId?: string;
  accessToken: string;
  refreshToken?: string;
  /** Срок access-токена, секунды (если провайдер сообщил). */
  expiresIn?: number;
  /** Фактически выданные scope'ы (строка через пробел). */
  scope?: string;
  /** Запрошенные scope'ы (для записи). */
  scopes?: string[];
  owner: ExternalCredentialOwner;
  createdBy: string;
  connectorId?: string;
  projectId?: string;
}

/**
 * Сервис слоя внешних доступов (ADR-105 Ф2).
 *
 * Экземпляр долгоживущий: single-flight refresh держится в памяти сервиса
 * (по id доступа), поэтому параллельные вызовы refresh не превращаются в
 * параллельные обращения к провайдеру.
 */
export class OAuthCredentialService {
  /** Текущие refresh-запросы по id доступа (single-flight). */
  private readonly _inflight = new Map<string, Promise<ExternalCredentialMeta>>();

  constructor(private readonly _deps: OAuthCredentialServiceDeps) {}

  /**
   * Обмен кода на токены и запись доступа (шифрование — внутри порта).
   *
   * Возвращаются **метаданные** доступа: значение токена наружу не отдаётся.
   *
   * ADR-105 (Ф4): операция журналируется в append-only журнал (`issue`);
   * id доступа генерируется заранее, чтобы запись ссылалась на доступ и при
   * неуспешной выдаче.
   */
  async exchangeAndStore(input: ExchangeAndStoreInput): Promise<ExternalCredentialMeta> {
    const client = this._deps.clientFor(input.provider);
    const credentialId = `${EXTERNAL_CREDENTIAL_ID_PREFIX}${generateId()}`;
    try {
      const tokens = await client.exchangeCode({
        code: input.code,
        ...(input.codeVerifier !== undefined ? { codeVerifier: input.codeVerifier } : {}),
        ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
      });
      const scopes = input.scopes ?? client.defaultScopes;
      const scopesGranted = tokens.scope ? tokens.scope.split(' ').filter(Boolean) : undefined;
      const expiresAt =
        tokens.expiresIn !== undefined ? this._expiresAt(tokens.expiresIn) : undefined;
      const meta = await this._deps.repo.create({
        id: credentialId,
        provider: input.provider,
        clientId: client.clientId,
        scopes,
        owner: input.owner,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(scopesGranted !== undefined ? { scopesGranted } : {}),
        createdBy: input.createdBy,
        ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      });
      await recordCredentialAudit(this._deps.audit, {
        op: 'issue',
        credentialId: meta.id,
        provider: input.provider,
        outcome: 'ok',
        ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
      });
      return meta;
    } catch (err) {
      await recordCredentialAudit(this._deps.audit, {
        op: 'issue',
        credentialId,
        provider: input.provider,
        outcome: 'error',
        errorCode: credentialAuditErrorCode(err),
      });
      throw err;
    }
  }

  /**
   * Сохранение уже полученных токенов (device flow, RFC 8628).
   *
   * Сеть не дёргается: токены кладутся в порт как есть (шифрование — внутри
   * порта). Наружу отдаются метаданные.
   *
   * ADR-105 (Ф4): журналируется как `issue` (выдан новый доступ).
   */
  async storeTokens(input: StoreTokensInput): Promise<ExternalCredentialMeta> {
    const clientId =
      input.clientId ?? this._deps.clientFor(input.provider).clientId;
    const scopes = input.scopes ?? this._deps.clientFor(input.provider).defaultScopes;
    const scopesGranted = input.scope
      ? input.scope.split(' ').filter(Boolean)
      : undefined;
    const expiresAt =
      input.expiresIn !== undefined ? this._expiresAt(input.expiresIn) : undefined;
    const credentialId = `${EXTERNAL_CREDENTIAL_ID_PREFIX}${generateId()}`;
    try {
      const meta = await this._deps.repo.create({
        id: credentialId,
        provider: input.provider,
        clientId,
        scopes,
        owner: input.owner,
        accessToken: input.accessToken,
        ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(scopesGranted !== undefined ? { scopesGranted } : {}),
        createdBy: input.createdBy,
        ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      });
      await recordCredentialAudit(this._deps.audit, {
        op: 'issue',
        credentialId: meta.id,
        provider: input.provider,
        outcome: 'ok',
        ...(input.connectorId !== undefined ? { connectorId: input.connectorId } : {}),
      });
      return meta;
    } catch (err) {
      await recordCredentialAudit(this._deps.audit, {
        op: 'issue',
        credentialId,
        provider: input.provider,
        outcome: 'error',
        errorCode: credentialAuditErrorCode(err),
      });
      throw err;
    }
  }

  /**
   * Обновление access-токена (RFC 6749 §6).
   *
   * Параллельные вызовы одного доступа дают **один** сетевой вызов: второй
   * ждёт результат первого (single-flight). `invalid_grant` → доступ
   * переводится в `status:'error'` и ошибка пробрасывается вызывающему.
   *
   * ADR-105 (Ф4): операция журналируется (`refresh`); при single-flight запись
   * одна — журналируется фактический сетевой вызов.
   */
  async refresh(id: string): Promise<ExternalCredentialMeta> {
    const pending = this._inflight.get(id);
    if (pending) return pending;
    const promise = this._refreshInner(id);
    this._inflight.set(id, promise);
    try {
      const meta = await promise;
      await recordCredentialAudit(this._deps.audit, {
        op: 'refresh',
        credentialId: id,
        provider: meta.provider,
        outcome: 'ok',
      });
      return meta;
    } catch (err) {
      await recordCredentialAudit(this._deps.audit, {
        op: 'refresh',
        credentialId: id,
        provider: await this._providerOf(id),
        outcome: 'error',
        errorCode: credentialAuditErrorCode(err),
      });
      throw err;
    } finally {
      this._inflight.delete(id);
    }
  }

  /**
   * Отзыв доступа: локальный (всегда, необратимо) + вызов провайдера
   * (RFC 7009, best-effort — провайдер может не поддерживать revoke).
   *
   * ADR-105 (Ф4): журналируется (`revoke`).
   */
  async revoke(id: string): Promise<RevokeResult> {
    const record = await this._rawRecord(id);
    if (!record) {
      await recordCredentialAudit(this._deps.audit, {
        op: 'revoke',
        credentialId: id,
        provider: '',
        outcome: 'error',
        errorCode: 'not_found',
      });
      throw new OAuthError('not_found', 'Доступ не найден');
    }
    let providerRevoked = false;
    try {
      const revealed = await this._deps.repo.reveal(id);
      const token = revealed?.refreshToken ?? revealed?.accessToken;
      if (token) {
        const client = this._deps.clientFor(record.provider);
        const result = await client.revoke({ token, clientId: record.clientId });
        providerRevoked = result.revoked;
      }
    } catch {
      // best-effort: локальный отзыв состоялся независимо от ответа провайдера.
      providerRevoked = false;
    }
    const meta = await this._deps.repo.revoke(id);
    if (!meta) throw new OAuthError('not_found', 'Доступ не найден');
    await recordCredentialAudit(this._deps.audit, {
      op: 'revoke',
      credentialId: id,
      provider: record.provider,
      outcome: 'ok',
    });
    return { meta, providerRevoked };
  }

  /** Внутренний refresh (вне single-flight). */
  private async _refreshInner(id: string): Promise<ExternalCredentialMeta> {
    const record = await this._rawRecord(id);
    if (!record) throw new OAuthError('not_found', 'Доступ не найден');
    if (record.status === 'revoked') {
      throw new OAuthError('revoked', 'Доступ отозван — требуется новая авторизация');
    }
    if (!record.refreshEnc) {
      throw new OAuthError('no_refresh_token', 'У доступа нет refresh-токена');
    }
    // Снимок `refreshEnc` — основа CAS: если значение изменилось, запись
    // выполнял кто-то другой.
    const snapshot = record.refreshEnc;

    const revealed = await this._deps.repo.reveal(id);
    const refreshToken = revealed?.refreshToken;
    if (!refreshToken) {
      throw new OAuthError('no_refresh_token', 'У доступа нет refresh-токена');
    }

    const client = this._deps.clientFor(record.provider);
    let tokens: OAuthTokenSet;
    try {
      tokens = await client.refresh({ refreshToken, clientId: record.clientId });
    } catch (err) {
      if (err instanceof OAuthError && err.code === 'invalid_grant') {
        // Refresh-токен отозван/истёк → требуется переавторизация (ADR-105 §3).
        await this._deps.repo.markError(id).catch(() => null);
      }
      throw err;
    }

    // CAS: перечитываем `refreshEnc` — успевшее измениться значение означает,
    // что refresh уже выполнил другой писатель; его результат и используем.
    const current = await this._rawRecord(id);
    if (!current) throw new OAuthError('not_found', 'Доступ не найден');
    if (current.refreshEnc !== snapshot) {
      const meta = await this._deps.repo.get(id);
      if (!meta) throw new OAuthError('not_found', 'Доступ не найден');
      return meta;
    }

    const patch: UpdateExternalCredentialTokensInput = {
      accessToken: tokens.accessToken,
      status: 'active',
    };
    if (tokens.refreshToken) patch.refreshToken = tokens.refreshToken;
    if (tokens.expiresIn !== undefined) patch.expiresAt = this._expiresAt(tokens.expiresIn);
    if (tokens.scope) patch.scopesGranted = tokens.scope.split(' ').filter(Boolean);
    const meta = await this._deps.repo.updateTokens(id, patch);
    if (!meta) throw new OAuthError('not_found', 'Доступ не найден');
    return meta;
  }

  /**
   * Сырая запись доступа (с `refreshEnc`) — нужна для CAS и статуса.
   *
   * Наружу (API/UI) отдаются метаданные; сырая форма — только внутреннему
   * слою доступа (здесь).
   */
  private async _rawRecord(id: string): Promise<ExternalCredential | null> {
    const all = await this._deps.repo.listRaw();
    return all.find((credential) => credential.id === id) ?? null;
  }

  /**
   * Провайдер доступа по id — для журнала операций (ADR-105 Ф4).
   *
   * Доступа нет (или метаданные недоступны) — пустая строка: провайдер
   * неизвестен, но попытка операции в журнале остаётся.
   */
  private async _providerOf(id: string): Promise<string> {
    try {
      const meta = await this._deps.repo.get(id);
      return meta?.provider ?? '';
    } catch {
      return '';
    }
  }

  /** ISO-8601 срок по `expires_in` (секунды). */
  private _expiresAt(expiresIn: number): string {
    const now = this._deps.now ? this._deps.now() : Date.now();
    return new Date(now + expiresIn * 1000).toISOString();
  }
}
