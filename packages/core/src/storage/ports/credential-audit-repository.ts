/**
 * ADR-105 (Ф4): порт append-only журнала операций со слоем доступов.
 *
 * Журнал отвечает на вопрос «кто и когда распоряжался внешним доступом»:
 * выдача (`issue`), обновление токена (`refresh`), отзыв (`revoke`), привязка
 * к MCP-коннектору (`bind`) и подстановка токена в транспорт (`use`).
 *
 * **Отдельный порт**, а не расширение `SECURITY_AUDIT_SCOPES`
 * (`packages/shared/src/types/egress.ts`): security-аудит — про изменения
 * политик, журнал доступов — про операции с OAuth-кредой.
 *
 * **Секретов в записях нет** (ADR-105 §7, §10): ни значения токена, ни
 * `secretEnc`/`refreshEnc`, ни `code_verifier`/`client_secret`, ни сырых путей,
 * ни id сессий/пользователей. Запись несёт только id доступа, провайдера,
 * операцию, исход, код ошибки и (для `bind`/`use`) id MCP-коннектора.
 *
 * Файловая реализация — `FileCredentialAuditStore`
 * (`packages/core/src/storage/file-credential-audit-store.ts`, JSONL
 * `{dataDir}/audit/credentials.jsonl`), in-memory —
 * `MemoryCredentialAuditRepository` (`packages/core/src/storage/memory/credential-audit.ts`),
 * БД — драйвер `@itphx/synth-storage-postgres` (ADR-097).
 */
import type {
  ExternalCredentialAuditEntry,
  ExternalCredentialAuditOp,
  ExternalCredentialAuditOutcome,
} from '@itphx/synth-shared';

/** Опции выборки записей журнала операций со слоем доступов. */
export interface CredentialAuditListOptions {
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
  /** Фильтр по id доступа. */
  credentialId?: string;
  /** Фильтр по ключу OAuth-провайдера. */
  provider?: string;
  /** Фильтр по виду операции. */
  op?: ExternalCredentialAuditOp;
  /** Фильтр по исходу операции. */
  outcome?: ExternalCredentialAuditOutcome;
}

/**
 * Порт append-only журнала операций со слоем доступов.
 *
 * Записи неизменяемы, `id`/`ts` формирует вызывающий (`ca_<uuid>`).
 * `list` отдаёт записи «свежие первыми» (новые → старые).
 *
 * Запись — **best-effort**: ошибка журналирования не ломает саму операцию
 * (доступ выдан/отозван — это уже состояние хранилища).
 */
export interface CredentialAuditRepository {
  /** Дозапись одного события журнала. */
  append(entry: ExternalCredentialAuditEntry): Promise<void>;
  /**
   * Записи «свежие первыми» (новые → старые); фильтры `credentialId`/
   * `provider`/`op`/`outcome`, `limit` — последние N.
   * @future-backend — `WHERE credential_id = ? AND op = ? ORDER BY seq DESC LIMIT ?`.
   */
  list(opts?: CredentialAuditListOptions): Promise<ExternalCredentialAuditEntry[]>;
  /** Полная очистка журнала; число удалённых записей. */
  clear(): Promise<number>;
}
