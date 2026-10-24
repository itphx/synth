/**
 * ADR-105 (Ф3): подстановка access-токена внешнего доступа в MCP-транспорт.
 *
 * Коннектор с `auth: { kind: 'credential', credentialId }` **не** несёт токен
 * в заголовках: access-токен берётся из порта доступов (`reveal()`) и
 * подставляется в **каждый** HTTP-запрос транспорта. Значение токена:
 *
 * - не попадает в конфиг/реестр MCP (там — только id доступа);
 * - не логируется и не попадает в тексты ошибок (ADR-105 §7);
 * - не переживает переподключение: после `401` транспорт обновляет токен
 *   (refresh через `OAuthCredentialService`, CAS внутри) и повторяет запрос.
 *
 * **Ровно один refresh на запрос.** Повтор после refresh не должен приводить
 * к цепочке refresh'ей: если и после обновления токена сервер отвечает `401`,
 * запрос возвращается как есть (ошибку разбирает вызывающий).
 */
import type { ExternalCredentialRepository } from '../../storage/ports/external-credential-repository.js';
import type { CredentialAuditRepository } from '../../storage/ports/credential-audit-repository.js';
import { credentialAuditErrorCode, recordCredentialAudit } from '../oauth/audit.js';
import { OAuthError } from '../oauth/types.js';

/** Коды ошибок слоя доступа применительно к MCP-коннектору. */
export type McpCredentialErrorCode =
  /** Доступ не найден (нет записи с таким id). */
  | 'not_found'
  /** Доступ отозван. */
  | 'revoked'
  /** Доступ в статусе `error` — нужна явная переавторизация. */
  | 'reauthorization_required'
  /** Обновить токен нечем: refresh-токена нет либо нет OAuth-клиента. */
  | 'no_refresh'
  /** Хранилище недоступно (деградация/ошибка чтения). */
  | 'unavailable';

/**
 * Ошибка доступа в MCP-коннекторе.
 *
 * Текст **не содержит** значения токена (ADR-105 §7): только код и
 * операторски-читаемое пояснение.
 */
export class McpCredentialError extends Error {
  constructor(
    readonly code: McpCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpCredentialError';
  }
}

/**
 * Источник access-токена для коннектора.
 *
 * Абстракция намеренно узкая: транспорт знает только «дай токен» и «обнови
 * токен» — ни порт, ни провайдер в него не заглядывают (тесты подставляют
 * мок-источник, сеть не нужна).
 */
export interface McpCredentialSource {
  /** Текущий access-токен (plaintext) для доступа. */
  getAccessToken(credentialId: string): Promise<string>;
  /**
   * Обновить токен (refresh) и вернуть **новый** access-токен.
   * Бросает `McpCredentialError` (`reauthorization_required` — провайдер
   * отозвал refresh-токен; доступ уже переведён в `status:'error'`).
   */
  refreshAccessToken(credentialId: string): Promise<string>;
}

/** Зависимости источника доступа поверх порта хранилища. */
export interface RepositoryCredentialSourceDeps {
  /** Порт доступов — единственный путь чтения токена. */
  repo: ExternalCredentialRepository;
  /**
   * Обновление токена (refresh). Выполняет `OAuthCredentialService.refresh`
   * (single-flight + CAS по `refreshEnc`); при `invalid_grant` доступ
   * переводится в `status:'error'` **через порт**.
   *
   * Не задан — обновить токен нечем (статический токен без refresh-токена).
   */
  refresh?: (credentialId: string) => Promise<void>;
  /**
   * ADR-105 (Ф4): журнал операций со слоем доступов (append-only). В журнал
   * пишется подстановка токена в транспорт (`use`) — **без значения токена**.
   * Не задан — подстановки не журналируются.
   */
  audit?: CredentialAuditRepository;
}

/**
 * Источник доступа поверх порта `ExternalCredentialRepository`.
 *
 * Чтение токена — только `reveal()` (единственный метод, отдающий plaintext);
 * наружу (API/UI) токен не попадает.
 */
export function createRepositoryCredentialSource(
  deps: RepositoryCredentialSourceDeps,
): McpCredentialSource {
  return {
    async getAccessToken(credentialId: string): Promise<string> {
      // Провайдер известен сразу после чтения метаданных — нужен и для
      // успешной записи в журнал, и для записи об ошибке.
      let provider = '';
      try {
        const meta = await deps.repo.get(credentialId);
        if (!meta) {
          throw new McpCredentialError('not_found', `Доступ «${credentialId}» не найден`);
        }
        provider = meta.provider;
        if (meta.status === 'revoked') {
          throw new McpCredentialError('revoked', `Доступ «${credentialId}» отозван`);
        }
        if (meta.status === 'error') {
          throw new McpCredentialError(
            'reauthorization_required',
            `Доступ «${credentialId}» требует переавторизации`,
          );
        }
        const revealed = await deps.repo.reveal(credentialId);
        if (!revealed?.accessToken) {
          throw new McpCredentialError('not_found', `Доступ «${credentialId}» не найден`);
        }
        // ADR-105 (Ф4): подстановка токена в транспорт журналируется (`use`).
        // В записи — только id доступа, провайдер и коннектор; значения токена
        // в журнале нет.
        await recordCredentialAudit(deps.audit, {
          op: 'use',
          credentialId,
          provider: meta.provider,
          outcome: 'ok',
          ...(meta.connectorId !== undefined ? { connectorId: meta.connectorId } : {}),
        });
        return revealed.accessToken;
      } catch (err) {
        await recordCredentialAudit(deps.audit, {
          op: 'use',
          credentialId,
          provider,
          outcome: 'error',
          errorCode: credentialAuditErrorCode(err),
        });
        throw err;
      }
    },

    async refreshAccessToken(credentialId: string): Promise<string> {
      if (!deps.refresh) {
        throw new McpCredentialError(
          'no_refresh',
          `Обновить токен доступа «${credentialId}» нечем: refresh не настроен`,
        );
      }
      try {
        await deps.refresh(credentialId);
      } catch (err) {
        if (err instanceof OAuthError && err.code === 'invalid_grant') {
          // Провайдер отозвал/отверг refresh-токен: доступ уже переведён
          // в `status:'error'` сервисом — нужна явная переавторизация.
          throw new McpCredentialError(
            'reauthorization_required',
            `Доступ «${credentialId}» требует переавторизации: refresh отклонён провайдером`,
          );
        }
        if (err instanceof OAuthError && err.code === 'revoked') {
          throw new McpCredentialError('revoked', `Доступ «${credentialId}» отозван`);
        }
        if (err instanceof OAuthError && err.code === 'no_refresh_token') {
          throw new McpCredentialError(
            'no_refresh',
            `У доступа «${credentialId}» нет refresh-токена`,
          );
        }
        throw err;
      }
      const revealed = await deps.repo.reveal(credentialId);
      if (!revealed?.accessToken) {
        throw new McpCredentialError(
          'unavailable',
          `Доступ «${credentialId}» недоступен после обновления токена`,
        );
      }
      return revealed.accessToken;
    },
  };
}

/** Параметры транспорта с подстановкой токена доступа. */
export interface CredentialFetchOptions {
  /** Источник токена. */
  source: McpCredentialSource;
  /** id доступа (`auth.credentialId`). */
  credentialId: string;
  /** Имя MCP-сервера — только для текстов ошибок (без секретов). */
  serverName: string;
  /** Базовый транспорт (по умолчанию — `egressFetch`, ADR-099). */
  baseFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Колбэк «токен обновлён» (для лога/метрики; секрет не передаётся). */
  onRefresh?: (info: { credentialId: string; serverName: string }) => void;
}

/**
 * `fetch` для MCP-транспорта: подставляет `Authorization: Bearer <token>`
 * в каждый запрос и **один раз** обновляет токен при `401`.
 *
 * Токен не логируется и не попадает в тексты ошибок: в ошибку уходит только
 * id доступа и код (`McpCredentialError.code`).
 */
export function createCredentialFetch(options: CredentialFetchOptions): typeof fetch {
  const base = options.baseFetch;
  const send = async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    token: string,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    const nextInit: RequestInit = { ...(init ?? {}), headers };
    return base ? base(input, nextInit) : fetch(input, nextInit);
  };

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const token = await options.source.getAccessToken(options.credentialId);
    const response = await send(input, init, token);
    if (response.status !== 401) return response;

    // Ровно один refresh на запрос: обновили токен и повторили.
    let refreshed: string;
    try {
      refreshed = await options.source.refreshAccessToken(options.credentialId);
    } catch (err) {
      if (err instanceof McpCredentialError) {
        throw new McpCredentialError(
          err.code,
          `MCP-сервер «${options.serverName}»: ${err.message}`,
        );
      }
      throw err;
    }
    options.onRefresh?.({ credentialId: options.credentialId, serverName: options.serverName });
    return send(input, init, refreshed);
  }) as typeof fetch;
}
