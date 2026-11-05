// Типы гибридного режима: источник сущности, учётные данные, ошибки remote-клиента.

/** Источник сущности в гибридном режиме. */
export type Origin = 'local' | 'remote';

/** Способ аутентификации локального core к удалённому backend. */
export type RemoteAuthType = 'device' | 'api_key';

/** Пользователь удалённого backend (подмножество /auth/status.user). */
export interface RemoteUser {
  id: string;
  username: string;
  roles: string[];
}

/**
 * Учётные данные для подключения к удалённому backend.
 * Хранятся в файле credentials как Record<backendUrl, RemoteCredentials>.
 */
export interface RemoteCredentials {
  backendUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  user?: RemoteUser;
  /**
   * OIDC issuer/clientId, с которыми получены токены (аддитивно, legacy-записи
   * без них читаются). Нужны, чтобы после рестарта refresh шёл по сохранённым
   * параметрам, даже если дискавери сервера недоступен.
   */
  issuer?: string;
  clientId?: string;
}

/** Код ошибки remote-клиента: OFFLINE (сеть/таймаут), UNAUTHORIZED (401), AUTH (device flow), HTTP_<status>. */
export type RemoteErrorCode = 'OFFLINE' | 'UNAUTHORIZED' | 'AUTH' | `HTTP_${number}`;

export class RemoteError extends Error {
  constructor(
    message: string,
    public readonly code: RemoteErrorCode,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}
