/**
 * PROP-107 (Ф0/Ф1): доменный порт слоя хранения внешних доступов
 * (`ExternalCredentialRepository`).
 *
 * Доступ — сущность с временем жизни: токен выдаёт внешний провайдер, у него
 * есть срок, статус и отзыв (PROP-107 §1–§4). Порт хранит **только** метаданные
 * и зашифрованные токены:
 *
 * - `secretEnc`/`refreshEnc` — `enc:v1:…` (шифрование мастер-ключом, ADR-076):
 *   токен нужен в исходном виде (его подставляет транспорт), хеш здесь
 *   неприменим — прецедент `WebhookStore`;
 * - наружу (API/UI) отдаются **метаданные** (`ExternalCredentialMeta`) с маской
 *   секрета; plaintext-токен не покидает хранилище ни одним методом, кроме
 *   `reveal()` — он нужен только подстановке в транспорт (агент токен не видит);
 * - `revoke` идемпотентен, а отозванный доступ нельзя «оживить» обновлением
 *   токенов или ошибкой refresh.
 *
 * Деградация хранилища (ADR-098) — общий HTTP-механизм
 * (`server/storage-degraded.ts`: мутирующий метод → `503
 * STORAGE_DEGRADED_READONLY`), порт проверок не дублирует.
 */

import type {
  CreateExternalCredentialInput,
  ExternalCredential,
  ExternalCredentialFilter,
  ExternalCredentialMeta,
  UpdateExternalCredentialTokensInput,
} from '@itphx/synth-shared';

/** Коды ошибок хранилища доступов. */
export type ExternalCredentialErrorCode =
  /** id уже занят (уникальность id — инвариант порта). */
  | 'duplicate_id'
  /** Запись не найдена (операции, требующие записи). */
  | 'not_found'
  /** Не удалось расшифровать токен (смена мастер-ключа, повреждение данных). */
  | 'decrypt_failed'
  /** Мастер-ключ недоступен/некорректен — запись секрета невозможна. */
  | 'encryption_unavailable'
  /** Некорректный вход (пустой токен, пустой provider и т.п.). */
  | 'invalid';

/** Типизированная ошибка хранилища доступов (секрет в тексте ошибки не фигурирует). */
export class ExternalCredentialStoreError extends Error {
  constructor(
    readonly code: ExternalCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalCredentialStoreError';
  }
}

export interface ExternalCredentialRepository {
  /**
   * Метаданные доступов (без секретов). Фильтры — по владельцу, коннектору,
   * провайдеру, проекту и статусу; порядок — по времени создания.
   */
  list(filter?: ExternalCredentialFilter): Promise<ExternalCredentialMeta[]>;
  /** Метаданные одного доступа либо `null`. */
  get(id: string): Promise<ExternalCredentialMeta | null>;
  /**
   * Создаёт доступ: access/refresh-токены шифруются мастер-ключом, наружу
   * возвращаются метаданные. Дубль `id` → `ExternalCredentialStoreError`
   * (`duplicate_id`).
   */
  create(input: CreateExternalCredentialInput): Promise<ExternalCredentialMeta>;
  /**
   * Обновляет токены (refresh/ротация) и связанные метаданные. Отозванный
   * доступ при этом остаётся отозванным. Неизвестный id → `null`.
   */
  updateTokens(
    id: string,
    patch: UpdateExternalCredentialTokensInput,
  ): Promise<ExternalCredentialMeta | null>;
  /**
   * Переводит доступ в статус `error` (напр. refresh отклонён провайдером —
   * `invalid_grant`): требуется явная переавторизация, молчаливый отказ
   * недопустим (PROP-107 §3). Отозванный доступ остаётся отозванным.
   */
  markError(id: string): Promise<ExternalCredentialMeta | null>;
  /**
   * Помечает доступ отозванным (идемпотентно: повторный вызов не меняет
   * `revokedAt`). Неизвестный id → `null`.
   */
  revoke(id: string): Promise<ExternalCredentialMeta | null>;
  /** Best-effort отметка использования (`lastUsedAt`). */
  touch(id: string): Promise<void>;
  /**
   * Расшифрованные токены — **только** для подстановки в транспорт (агент и
   * модель токен не видят). Неизвестный id → `null`.
   */
  reveal(id: string): Promise<{ accessToken: string; refreshToken?: string } | null>;
  /**
   * Сырые записи, ВКЛЮЧАЯ зашифрованные токены — только для админских
   * операций хранилища (ротация мастер-ключа, Ф4), не для HTTP/обычных путей
   * чтения.
   */
  listRaw(): Promise<ExternalCredential[]>;
}
